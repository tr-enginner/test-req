# Correlated Variable Identification Enhancement Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enhance the correlated variable identification module with 3 Joern extraction improvements (function-call-args sink, generalized update dimension, implicit boolean DAC), adapt Tool A classification and scoring, fix the `getAPElements` dead branch, and add LLM evaluation placeholder.

**Architecture:** Changes span two layers: (1) Joern Scala script `multivarCorrelatedVarsIdentify.scala` — add D3 function-call-args extraction, rewrite D4 update to scan all global writes in basic blocks, extend D5 DAC for implicit boolean tests, fix `getAPElements` dead branch; (2) Tool A TypeScript `multivar-correlated-vars.ts` — remove TUP→DFC downgrade, restructure TUP scoring with lower base + structural sub-type evidence, add `dependency_depth` and `naming_similarity` dimensions to DFC/DAC scoring, add LLM evaluation placeholder. All changes are backward-compatible (Tool A fallback to heuristic when Joern `Source` tag is absent).

**Tech Stack:** Scala (Joern script), TypeScript (Bun runtime), Zod schemas

---

## Summary of Changes

### Joern Script (`joern/multivarCorrelatedVarsIdentify.scala`)
| # | Change | Lines | Risk |
|---|--------|-------|------|
| J1 | Fix `getAPElements` dead branch for `indirectFieldAccess` | 75-94 | Low |
| J2 | Add D3: function-call-args sink dimension | After L1032 | Medium |
| J3 | Rewrite D4: generalized basic-block global-write update | 1035-1084 | High |
| J4 | Extend D5: implicit boolean test in `collectVariablesComparedWithConstant` | 912-931 | Low |

### Tool A (`src/tools/multivar-correlated-vars.ts`)
| # | Change | Lines | Risk |
|---|--------|-------|------|
| T1 | Remove TUP→DFC downgrade in `parseJoernAccessLists` C2 constraint | 244-251 | Low |
| T2 | Restructure `classifySvcType` for generalized update groups | 316-333 | Medium |
| T3 | Restructure `computeTransactionalScore` (base 0.40, new sub-types) | 384-421 | Medium |
| T4 | Add `dependency_depth` + `naming_similarity` to `computeDataflowScore` | 343-381 | Low |
| T5 | Add `naming_similarity` to `computeDacScore`, adjust weights | 579-614 | Low |
| T6 | Remove `cross_function` dead code from `computeDataflowScore` | 374-378 | Low |
| T7 | Add LLM evaluation placeholder interface | New code | Low |

### Documentation
| # | Change | File |
|---|--------|------|
| D1 | Update scoring tables in SKILL.md | `skills/multivar-atomicity/SKILL.md` |

---

## Task 1: Fix `getAPElements` Dead Branch (J1)

**Files:**
- Modify: `joern/multivarCorrelatedVarsIdentify.scala:75-94`

**What:** The second `case name if name == Operators.indirectFieldAccess` at line 85 is unreachable because the first case at line 75 already matches `fieldAccess || indirectFieldAccess`. Split into separate cases: `fieldAccess` (simple field) and `indirectFieldAccess` (pointer dereference + field).

**Step 1: Edit the match cases**

Replace lines 75-94 with:

```scala
case name if name == Operators.fieldAccess => {
  // a.f — direct field access
  val prefixExpr = call.argument(1)
  val suffix = call.argument(2).asInstanceOf[FieldIdentifier]
  val prefixAP = getAPElements(prefixExpr)
  val fieldName = suffix.code

  val finalApElements = Elements.normalized(prefixAP.elements :+ ConstantAccess(fieldName))
  finalApElements
}
case name if name == Operators.indirectFieldAccess => {
  // a->f  =>  a*.f — indirect field access (pointer dereference + field)
  val prefixExpr = call.argument(1)
  val suffix = call.argument(2).asInstanceOf[FieldIdentifier]
  val prefixAP = getAPElements(prefixExpr)
  val fieldName = suffix.code

  val finalApElements = Elements.normalized(prefixAP.elements :+ IndirectionAccess :+ ConstantAccess(fieldName))
  finalApElements
}
```

**Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS (Scala is not typechecked by Bun, but ensure no TS import regressions)

**Step 3: Commit**

```bash
git add joern/multivarCorrelatedVarsIdentify.scala
git commit -m "fix(joern): split fieldAccess/indirectFieldAccess into separate match cases

The indirectFieldAccess case was unreachable because the first case
matched both fieldAccess and indirectFieldAccess. Now a->f correctly
adds IndirectionAccess to the access path."
```

---

## Task 2: Add D3 Function-Call-Args Sink Dimension (J2)

**Files:**
- Modify: `joern/multivarCorrelatedVarsIdentify.scala` — in `getVariableCorrelation`, after the arithmetic sink section (after line 1032)

**What:** Add a third sink sub-dimension: when a non-operator, non-inline function call receives ≥2 different global variables as arguments from different parameter positions, these variables are data-flow correlated (they flow into the same computation context). Tag as `Source = "sink"`.

**Step 1: Add the function-call-args extraction block**

After line 1032 (after the closing `})` of the arithmetic section), insert:

```scala
  // D3: Function call arguments — global variables passed to the same function call
  // are correlated (they flow into the same computation context)
  graph.call
    .filterNot(c => c.name.startsWith("<operator>") || c.name.startsWith("<operators>"))
    .filterNot(_.isInline)
    .foreach(call => {
      val var2PathList = mutable.ListBuffer.empty[List[(String, VariableTrace)]]

      call.argument.foreach(arg => {
        arg match {
          case argNode: CfgNode => {
            val path = mutable.ListBuffer[CfgNode]()
            path.addOne(argNode)
            val var2Path = collectVariable(argNode, allGlobalVars, ddgMap, path)
            if (var2Path.nonEmpty) {
              var2PathList.addOne(var2Path)
            }
          }
          case _ => {}
        }
      })

      // Need variables from at least 2 different arguments
      if (var2PathList.size >= 2) {
        val combineList = combine(var2PathList)
        if (combineList.nonEmpty && !varPairsMap.contains(call)) {
          varPairsMap.addOne(call, combineList)
          nodeSourceMap(call) = "sink"

          statistics.saa += 1
          statistics.svc += 1
          statistics.sink += 1

          statistics.pairs += combineList.size
          statistics.svc_pairs += combineList.size
          statistics.sink_pairs += combineList.size
        }
      }
    })
```

**Key design decisions:**
- Filter out operator calls (`<operator>.xxx`) — these are already covered by D1/D2
- Filter out inline calls (macros) — inline calls are constants, not function invocations
- `!varPairsMap.contains(call)` — if this call node was already captured by D1 (condition) or D2 (arithmetic), skip to avoid duplication
- Tag as `"sink"` — semantically this is data-flow convergence into a function, same class as condition/arithmetic convergence

**Step 2: Verify on real1_bench**

This step is manual verification during testing. The new dimension should produce additional AccessLists with `Source = "sink"` where function calls receive multiple global variables.

**Step 3: Commit**

```bash
git add joern/multivarCorrelatedVarsIdentify.scala
git commit -m "feat(joern): add D3 function-call-args sink dimension

Global variables passed as different arguments to the same function call
are now identified as correlated (data-flow convergence). Tagged as
Source='sink'. Skips operator calls, inline macros, and nodes already
captured by condition/arithmetic dimensions."
```

---

## Task 3: Rewrite D4 Generalized Basic-Block Global-Write Update (J3)

**Files:**
- Modify: `joern/multivarCorrelatedVarsIdentify.scala:1034-1084`

**What:** Replace the current update logic (which only detects same-AP-root consecutive field assignments like `gVar.field1=x; gVar.field2=y;`) with a generalized scanner that finds **all global variable write operations within a basic block** and groups those within a 10-line sliding window. This captures `g_chg_state = ...; g_fault_word |= ...;` patterns that the old logic missed.

**Step 1: Replace the entire update section (lines 1034-1084)**

Replace the old code block:
```scala
  //
  cpg.method.filter(isUserMethod).foreach(method => {
    ...
  })
```

With the new generalized logic:

```scala
  // D4: Basic-block consecutive global writes — global variables written
  // within the same basic block and within MAX_WRITE_GAP lines form a
  // transactional update group. The old logic only caught same-AP-root
  // field assignments; this generalized version catches all adjacent
  // global writes including independent variables.
  val MAX_WRITE_GAP = 10

  cpg.method.filter(isUserMethod).foreach(method => {
    val bbs = getBasicBlocks(method)
    bbs.foreach(bb => {
      // Collect all global variable write nodes in this basic block, sorted by line
      val globalWrites = mutable.ListBuffer[(String, CfgNode, Int)]() // (varCode, node, line)
      bb.foreach(n => {
        n match {
          case call: Call => {
            val name = call.name
            if (name.startsWith("<operator>.assignment") || name.startsWith("<operators>.assignment") ||
                name.equals("<operator>.postDecrement") || name.equals("<operator>.postIncrement")) {
              val left = call.argument(1)
              val apElems = getAPElements(left)
              if (!apElems.isEmpty) {
                val apRootStr = apElems.elements(0).toString
                if (allGlobalVars.contains(apRootStr) || Try(Integer.decode(apRootStr)).isSuccess) {
                  val line = n.lineNumber.getOrElse(0)
                  globalWrites.addOne((left.code, n, line))
                }
              }
            }
          }
          case _ => {}
        }
      })

      // Sliding window: group writes within MAX_WRITE_GAP lines
      if (globalWrites.size >= 2) {
        val sorted = globalWrites.sortBy(_._3)
        var windowStart = 0
        for (windowEnd <- 1 until sorted.size) {
          // Shrink window start until gap is within threshold
          while (windowStart < windowEnd &&
                 sorted(windowEnd)._3 - sorted(windowStart)._3 > MAX_WRITE_GAP) {
            windowStart += 1
          }

          if (windowEnd > windowStart) {
            // Emit pairs within the window: each new write pairs with the previous write
            val prevCode = sorted(windowEnd - 1)._1
            val prevNode = sorted(windowEnd - 1)._2
            val curCode = sorted(windowEnd)._1
            val curNode = sorted(windowEnd)._2

            // Only pair if different variable names
            if (prevCode != curCode) {
              val oneCombine = Map(
                prevCode -> VariableTrace(prevNode, List(prevNode)),
                curCode -> VariableTrace(curNode, List(curNode))
              )
              if (oneCombine.size > 1) {
                val anchorNode = prevNode
                val combines = varPairsMap.getOrElse(anchorNode, List.empty)
                varPairsMap(anchorNode) = combines :+ oneCombine
                nodeSourceMap(anchorNode) = "update"

                statistics.saa += 1
                statistics.svc += 1
                statistics.update += 1

                statistics.pairs += 1
                statistics.svc_pairs += 1
                statistics.update_pairs += 1
              }
            }
          }
        }
      }
    })
  })
```

**Key design decisions:**
- **Sliding window (10 lines)**: avoids O(n²) pairing while capturing multi-variable write sequences
- **Pairwise emission**: each consecutive pair of different-variable writes within the window becomes one AccessList. This lets Tool A evaluate each pair independently
- **No AP root restriction**: `allGlobalVars.contains(apRootStr)` checks any global variable write, not just struct fields with `apElems.length > 1`
- **Still preserves struct detection**: `left.code` for struct fields will be `gVar.field`, so Tool A's `extractStructBase` can still identify shared struct bases

**Step 2: Commit**

```bash
git add joern/multivarCorrelatedVarsIdentify.scala
git commit -m "feat(joern): rewrite D4 update dimension for generalized basic-block global writes

Replace same-AP-root field assignment detection with a sliding-window
scanner that finds all global variable write operations within 10 lines
in the same basic block. This captures independent variable pairs like
g_chg_state + g_fault_word that the old logic missed."
```

---

## Task 4: Extend D5 DAC for Implicit Boolean Tests (J4)

**Files:**
- Modify: `joern/multivarCorrelatedVarsIdentify.scala:912-931` — in `collectVariablesComparedWithConstant`

**What:** When `isComparisonWithConstant` returns `None` and the expression is not `&&`/`||`, check if the condition is a single global variable identifier (`if (flag)`) or its negation (`if (!flag)`). If so, treat it as an implicit `flag != 0` comparison and extract that variable as the DECISION variable.

**Step 1: Add implicit boolean handling in the `None` branch**

In the `case None` block of `collectVariablesComparedWithConstant` (line 912), after the `&&`/`||` handling (line 928), add a new else-if branch:

Replace lines 912-932:

```scala
    case None => {
      control match {
        case call: Call => {
          val callName = call.name
          // Handle && and || by recursing into sub-expressions
          if (callName == Operators.logicalAnd || callName == Operators.logicalOr) {
            call.argument.foreach(arg => {
              arg match {
                case argExpr: Expression => {
                  result.addAll(collectVariablesComparedWithConstant(argExpr, allGlobalVars, ddgMap, cpg))
                }
                case _ => {}
              }
            })
          } else if (callName == Operators.logicalNot) {
            // !flag — extract the negated operand as implicit boolean test
            call.argument.headOption match {
              case Some(inner: Identifier) if allGlobalVars.contains(inner.name) => {
                val path = mutable.ListBuffer[CfgNode]()
                path.addOne(control.asInstanceOf[CfgNode])
                path.addOne(call)
                path.addOne(inner)
                result.addOne(inner.name, VariableTrace(inner, path.toList))
              }
              case _ => {}
            }
          }
        }
        // Bare identifier: if (flag) — implicit flag != 0
        case id: Identifier if allGlobalVars.contains(id.name) => {
          val path = mutable.ListBuffer[CfgNode]()
          path.addOne(control.asInstanceOf[CfgNode])
          path.addOne(id)
          result.addOne(id.name, VariableTrace(id, path.toList))
        }
        case _ => {}
      }
    }
```

**Key design decisions:**
- Only accepts **single identifiers** (`flag`) or **negated identifiers** (`!flag`) — not compound expressions
- Guards with `allGlobalVars.contains(id.name)` — only global variables are considered
- No cartesian explosion risk: one implicit boolean test produces exactly one variable entry

**Step 2: Commit**

```bash
git add joern/multivarCorrelatedVarsIdentify.scala
git commit -m "feat(joern): extend DAC to support implicit boolean tests

if (flag) and if (!flag) are now recognized as DAC decision conditions,
equivalent to flag != 0. Only single global variable identifiers or
their negation are accepted to avoid cartesian explosion."
```

---

## Task 5: Remove TUP→DFC Downgrade in Tool A (T1)

**Files:**
- Modify: `src/tools/multivar-correlated-vars.ts:244-251`

**What:** When a Source=update group has cross-function accesses (C2 check fails), the current code downgrades it to DFC. This is semantically wrong — transactional writes that span functions are not data-flow convergence; they should be discarded. Change to skip/discard the group.

**Step 1: Replace the C2 downgrade block**

Replace lines 244-251:

```typescript
    // C2: TUP same-function check (applies regardless of source)
    if (anchorType === "TUP") {
      const fns = new Set(accesses.map((a) => a.location.function).filter(Boolean))
      if (fns.size > 1) {
        // Cross-function: not a valid transactional group, treat as DFC
        anchorType = "DFC" as any
      }
    }
```

With:

```typescript
    // C2: TUP same-function check — transactional writes must be in the same function.
    // Cross-function writes are not a valid transactional group and are discarded
    // (not downgraded to DFC, as TUP and DFC represent different semantics).
    if (anchorType === "TUP") {
      const fns = new Set(accesses.map((a) => a.location.function).filter(Boolean))
      if (fns.size > 1) {
        continue // discard: cross-function TUP is invalid
      }
    }
```

**Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add src/tools/multivar-correlated-vars.ts
git commit -m "fix(tool-a): discard cross-function TUP groups instead of downgrading to DFC

TUP (transactional update) and DFC (data flow convergence) represent
different correlation semantics. A transactional write group that spans
multiple functions is not a valid transaction and should be discarded,
not reclassified as data-flow convergence."
```

---

## Task 6: Restructure `classifySvcType` for Generalized Update Groups (T2)

**Files:**
- Modify: `src/tools/multivar-correlated-vars.ts:316-333`

**What:** With the new generalized update dimension, Source=update groups may now contain writes to unrelated global variables (not just same-struct fields). The `classifySvcType` function must still classify these as TUP (since they come from the update dimension), but the sub-type evidence will be evaluated in the scoring function. The classification remains:
- Source=update with all-writes → TUP
- Source=update with reads mixed in → discard (shouldn't happen from Joern update dimension)
- Source=sink → DFC (unchanged)

**Step 1: Update `classifySvcType`**

Replace lines 316-333:

```typescript
function classifySvcType(
  group: CVGroup,
): "DFC" | "TUP" {
  const writes = group.accesses.filter((a) => a.access_type === "WRITE")
  const reads = group.accesses.filter((a) => a.access_type === "READ")

  if (writes.length >= 2 && reads.length === 0) {
    const bases = new Set<string>()
    for (const a of writes) {
      const b = extractStructBase(a.variable_name)
      if (b) bases.add(b)
    }
    if (bases.size === 1) return "TUP"
    if (isArrayElementGroup(writes)) return "TUP"
    if (hasAdjacentAddressPattern(group.variables)) return "TUP"
  }
  return "DFC"
}
```

With:

```typescript
function classifySvcType(
  group: CVGroup,
): "DFC" | "TUP" {
  const writes = group.accesses.filter((a) => a.access_type === "WRITE")
  const reads = group.accesses.filter((a) => a.access_type === "READ")

  // Source=update groups: all-writes → TUP regardless of structural evidence.
  // Structural evidence (struct/array/address) is evaluated in computeTransactionalScore.
  if (writes.length >= 2 && reads.length === 0) {
    return "TUP"
  }

  return "DFC"
}
```

**Why simplify:** The old code checked struct/array/address patterns to decide TUP vs DFC. With the new design, ALL all-write groups are classified as TUP, and the **scoring function** (not the classifier) determines confidence via sub-type evidence. Groups without structural evidence will score below the 0.5 threshold and be naturally filtered.

**Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add src/tools/multivar-correlated-vars.ts
git commit -m "refactor(tool-a): simplify classifySvcType — all all-write groups are TUP

Move structural sub-type detection (struct/array/address) from the
classifier into the scoring function. The classifier now only checks
the read/write pattern: all-writes = TUP, otherwise = DFC."
```

---

## Task 7: Restructure TUP Scoring with New Evidence Model (T3)

**Files:**
- Modify: `src/tools/multivar-correlated-vars.ts:384-421`

**What:** Restructure `computeTransactionalScore` with base 0.40, structural sub-type evidence as primary differentiator, and a new `same_domain` dimension for naming-prefix matching.

**Step 1: Add `extractCommonPrefix` helper**

Add before `computeTransactionalScore`:

```typescript
/** Extract common naming prefix from variable names (e.g., "g_chg_state" + "g_chg_mode" → "g_chg_") */
function extractCommonPrefix(variables: string[]): string | undefined {
  if (variables.length < 2) return undefined
  // Strip struct field access to get base names
  const baseNames = variables.map((v) => {
    const dotIdx = v.indexOf(".")
    const arrowIdx = v.indexOf("->")
    const bracketIdx = v.indexOf("[")
    const sepIdx = [dotIdx, arrowIdx, bracketIdx].filter((i) => i >= 0)
    return sepIdx.length > 0 ? v.slice(0, Math.min(...sepIdx)) : v
  })
  if (baseNames.length < 2) return undefined
  // Find longest common prefix among base names
  let prefix = baseNames[0]
  for (let i = 1; i < baseNames.length; i++) {
    while (!baseNames[i].startsWith(prefix) && prefix.length > 0) {
      prefix = prefix.slice(0, -1)
    }
    if (prefix.length === 0) return undefined
  }
  // Must end at a word boundary (_, or end of string) and be meaningful (>= 3 chars, not just "g_")
  const trimmed = prefix.replace(/_$/, "")
  if (trimmed.length < 3) return undefined
  return prefix
}
```

**Step 2: Replace `computeTransactionalScore`**

Replace lines 384-421:

```typescript
function computeTransactionalScore(group: CVGroup): { score: number; breakdown: EvidenceBreakdown } {
  const breakdown: EvidenceBreakdown = { base: 0.40 }

  const vars = group.variables || group.accesses.map((a) => a.variable_name)
  const uniqueVars = [...new Set(vars)]

  // Sub-type evidence (mutually exclusive, take the highest one)
  if (group.struct_base) {
    breakdown.struct_members = 0.18
  } else if (isArrayElementGroup(group.accesses)) {
    breakdown.array_elements = 0.18
  } else if (hasAdjacentAddressPattern(uniqueVars)) {
    breakdown.adjacent_address = 0.12
  } else {
    // Check for same-domain naming prefix (e.g., g_chg_state + g_chg_mode → g_chg_)
    const commonPrefix = extractCommonPrefix(uniqueVars)
    if (commonPrefix) {
      breakdown.same_domain = 0.08
    }
  }

  // Line proximity: continuous exponential decay based on average gap
  const lines = group.accesses.map((a) => a.location.line).filter((l) => l > 0).sort((a, b) => a - b)
  if (lines.length >= 2) {
    const gaps = lines.slice(1).map((l, i) => l - lines[i])
    const avgGap = gaps.reduce((s, g) => s + g, 0) / gaps.length
    breakdown.line_proximity = round3(0.05 * Math.exp(-avgGap / 5))
  }

  // Variable count factor
  const uniqueVarCount = new Set(group.variables).size
  if (uniqueVarCount > 2) {
    breakdown.variable_count = round3(Math.min(0.02, 0.02 * Math.log2(uniqueVarCount) / Math.log2(6)))
  }

  // Write concentration: all writes → stronger transactional evidence
  const writeRatio = group.accesses.filter((a) => a.access_type === "WRITE").length / group.accesses.length
  if (writeRatio > 0.8) {
    breakdown.write_concentration = round3(0.02 * writeRatio)
  }

  const score = Math.min(Object.values(breakdown).reduce((sum, v) => sum + v, 0), 0.75)
  return { score: round3(score), breakdown }
}
```

**Threshold analysis:**
- struct_members: 0.40 + 0.18 = 0.58 → PASS 0.5 ✓
- array_elements: 0.40 + 0.18 = 0.58 → PASS 0.5 ✓
- adjacent_address: 0.40 + 0.12 = 0.52 → PASS 0.5 ✓
- same_domain: 0.40 + 0.08 = 0.48 + supplements(max 0.09) = 0.48~0.57 → borderline
- no evidence: 0.40 + supplements(max 0.09) = 0.40~0.49 → FAIL 0.5 ✗ (filtered)

**Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

**Step 4: Commit**

```bash
git add src/tools/multivar-correlated-vars.ts
git commit -m "refactor(tool-a): restructure TUP scoring with base=0.40 and sub-type evidence

TUP base lowered from 0.50 to 0.40 because the generalized update
dimension now captures unrelated adjacent writes. Sub-type evidence
(struct_members=0.18, array_elements=0.18, adjacent_address=0.12,
same_domain=0.08) serves as primary differentiator. Groups without
structural evidence score below 0.5 and are naturally filtered."
```

---

## Task 8: Enhance DFC Scoring — `dependency_depth` + `naming_similarity` (T4, T6)

**Files:**
- Modify: `src/tools/multivar-correlated-vars.ts:343-381`

**What:** Add `dependency_depth` dimension (shorter data-flow chains = stronger correlation), add `naming_similarity` dimension, and remove the dead `cross_function` dimension.

**Step 1: Replace `computeDataflowScore`**

Replace lines 343-381:

```typescript
function computeDataflowScore(group: CVGroup): { score: number; breakdown: EvidenceBreakdown } {
  const breakdown: EvidenceBreakdown = { base: 0.6 }

  // Code distance: continuous exponential decay (max 0.05 at span=0, ~0 at span=50)
  const lines = group.accesses.map((a) => a.location.line).filter((l) => l > 0)
  if (lines.length >= 2) {
    const span = Math.max(...lines) - Math.min(...lines)
    breakdown.code_distance = round3(0.05 * Math.exp(-span / 15))
  }

  // Dependency depth: fewer data-flow hops = more direct correlation
  // Uses trace length from Joern output (stored in accesses[].expression as proxy)
  // Shorter traces indicate direct use of globals in the expression (1 hop)
  // rather than through intermediate local variables (2+ hops)
  // For now, infer from expression complexity: simple identifier = 1 hop, compound = 2+
  const avgDepth = estimateDependencyDepth(group.accesses)
  if (avgDepth <= 1) {
    breakdown.dependency_depth = 0.04
  } else if (avgDepth <= 2) {
    breakdown.dependency_depth = 0.02
  } else if (avgDepth <= 3) {
    breakdown.dependency_depth = 0.01
  }

  // Dependency evidence: shared struct base or adjacent address
  if (group.struct_base) {
    breakdown.struct_base = 0.04
  } else {
    const vars = group.variables || group.accesses.map((a) => a.variable_name)
    const uniqueVars = [...new Set(vars)]
    if (hasAdjacentAddressPattern(uniqueVars)) {
      breakdown.adjacent_address = 0.04
    }
  }

  // Naming similarity: shared prefix in variable names
  const commonPrefix = extractCommonPrefix(group.variables)
  if (commonPrefix) {
    breakdown.naming_similarity = 0.02
  }

  // Variable count factor (diminishing returns)
  const uniqueVarCount = new Set(group.variables).size
  if (uniqueVarCount > 2) {
    breakdown.variable_count = round3(Math.min(0.02, 0.02 * Math.log2(uniqueVarCount) / Math.log2(6)))
  }

  // Access density: more access sites → stronger evidence
  const accessCount = group.accesses.length
  if (accessCount > 2) {
    breakdown.access_density = round3(Math.min(0.03, 0.01 * Math.log2(accessCount)))
  }

  // (Removed: cross_function — dead code after C1 same-function constraint)

  const score = Math.min(Object.values(breakdown).reduce((sum, v) => sum + v, 0), 0.75)
  return { score: round3(score), breakdown }
}
```

**Step 2: Add `estimateDependencyDepth` helper**

Add before `computeDataflowScore`:

```typescript
/**
 * Estimate average dependency depth from access expressions.
 * A simple global variable identifier (e.g., "g_flag") = depth 1 (direct use).
 * A struct field access (e.g., "g_data.field") = depth 1 (direct use).
 * An assignment expression (e.g., "tmp = g_flag") = depth 2 (one intermediate).
 * For Tool A, we estimate depth from the expression string complexity.
 * Future: Joern could emit explicit trace lengths in the AccessList.
 */
function estimateDependencyDepth(accesses: VarAccess[]): number {
  let totalDepth = 0
  let count = 0
  for (const a of accesses) {
    const expr = a.expression || ""
    // Simple identifier or struct field: depth 1
    if (/^[a-zA-Z_]\w*(\.\w+|->\\w+|\[\w+\])*$/.test(expr)) {
      totalDepth += 1
    }
    // Assignment expression (contains = but not == != <= >=): depth 2
    else if (/(?<![!<>=])=(?!=)/.test(expr)) {
      totalDepth += 2
    }
    // Complex expression: depth 3
    else {
      totalDepth += 3
    }
    count++
  }
  return count > 0 ? totalDepth / count : 3
}
```

**Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

**Step 4: Commit**

```bash
git add src/tools/multivar-correlated-vars.ts
git commit -m "feat(tool-a): add dependency_depth + naming_similarity to DFC scoring, remove dead cross_function

dependency_depth rewards direct global variable usage (1 hop = +0.04)
over deeply chained intermediate variables. naming_similarity detects
shared naming prefixes (e.g., sensor_x + sensor_y → sensor_). Removed
cross_function which was dead code due to C1 same-function constraint."
```

---

## Task 9: Enhance DAC Scoring — `naming_similarity` + Adjust Weights (T5)

**Files:**
- Modify: `src/tools/multivar-correlated-vars.ts:579-614`

**What:** Add `naming_similarity` dimension and increase structural evidence weights so that DAC groups with very strong structural evidence can reach 0.50 without LLM, providing a degraded-mode capability.

**Step 1: Replace `computeDacScore`**

Replace lines 579-614:

```typescript
function computeDacScore(group: CVGroup): { score: number; breakdown: EvidenceBreakdown } {
  const breakdown: EvidenceBreakdown = { base: 0.3 }

  // Structural bonus: disjoint read/write variable sets
  const readVars = new Set(
    group.accesses.filter((a) => a.access_type === "READ").map((a) => a.variable_name),
  )
  const writeVars = new Set(
    group.accesses.filter((a) => a.access_type === "WRITE").map((a) => a.variable_name),
  )
  let disjoint = true
  for (const v of readVars) {
    if (writeVars.has(v)) { disjoint = false; break }
  }
  if (readVars.size > 0 && writeVars.size > 0 && disjoint) breakdown.disjoint_rw = 0.06

  // Shared struct base
  if (group.struct_base) breakdown.struct_base = 0.06

  // Naming similarity: decision and action variables share naming prefix
  const decisionVarNames = group.accesses
    .filter((a) => a.role === "DECISION")
    .map((a) => a.variable_name)
  const actionVarNames = group.accesses
    .filter((a) => a.role === "ACTION")
    .map((a) => a.variable_name)
  const allVarNames = [...new Set([...decisionVarNames, ...actionVarNames])]
  const commonPrefix = extractCommonPrefix(allVarNames)
  if (commonPrefix) {
    breakdown.naming_similarity = 0.04
  }

  // Naming pattern: decision variable matches flag pattern, action matches data pattern
  if (decisionVarNames.some((v) => FLAG_PATTERN.test(v)) && actionVarNames.some((v) => DATA_PATTERN.test(v))) {
    breakdown.naming_pattern = 0.04
  }

  // LLM semantic relevance placeholder — value set externally by agent Step 3.5
  // or by future LLM API integration. Scale from 0-1 to 0-0.4.
  const llmScore = group.evidence?.llm_semantic_relevance ?? 0
  if (llmScore > 0) {
    breakdown.llm_semantic = round3(llmScore * 0.4)
  }

  const score = Math.min(Object.values(breakdown).reduce((sum, v) => sum + v, 0), 0.75)
  return { score: round3(score), breakdown }
}
```

**Threshold analysis (no LLM):**
- Best case: 0.30 + 0.06 + 0.06 + 0.04 + 0.04 = **0.50** → just passes 0.5 ✓
- Typical: 0.30 + 0.06 + 0~0.04 = 0.36~0.40 → filtered ✗ (needs LLM)

**Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add src/tools/multivar-correlated-vars.ts
git commit -m "feat(tool-a): enhance DAC scoring with naming_similarity and adjusted weights

Added naming_similarity (+0.04) for shared prefixes between decision
and action variables. Increased disjoint_rw and struct_base to 0.06,
naming_pattern to 0.04. Best-case no-LLM score = 0.50 (just passes),
providing degraded-mode capability without LLM."
```

---

## Task 10: Add LLM Evaluation Placeholder (T7)

**Files:**
- Modify: `src/tools/multivar-correlated-vars.ts` — add after `computeDacScore`, before `identifyDacCandidates`

**What:** Add a well-documented placeholder interface and no-op implementation for future LLM-based semantic evaluation. The interface is designed so that replacing the no-op with a real LLM API call requires changing only the function body.

**Step 1: Add the placeholder code**

Add after `computeDacScore` (after the closing `}`):

```typescript
// ── LLM semantic evaluation placeholder ──
//
// The LLM evaluation is designed to run in two phases:
//   Phase 1 (DAC-specific, Agent Step 3.5): Evaluate semantic relevance of
//     decision-action relationships. Sets evidence.llm_semantic_relevance (0-1).
//   Phase 2 (Unified, Agent Step 3.7): Evaluate all groups that passed the
//     0.5 threshold. Adds evidence.llm_boost (0-0.3) as confidence bonus.
//
// Current implementation: These phases are performed by the multivar-atomicity-checker
// agent, which reads tool output, evaluates semantics via its own LLM context,
// and writes back the evidence fields to the JSON file before calling
// refineEvidence again.
//
// Future: When a direct LLM API interface is available, evaluation can be
// integrated into the tool itself via the following interface.

interface LlmEvaluationRequest {
  /** The correlated variable group to evaluate */
  group: CVGroup
  /** Source code context around the access locations (for semantic analysis) */
  source_context: string
  /** Evaluation mode */
  mode: "dac_semantic" | "unified_boost"
}

interface LlmEvaluationResult {
  /** Semantic relevance score (0-1), used for DAC llm_semantic dimension */
  llm_semantic_relevance: number
  /** Confidence boost (0-0.3), used for unified LLM evaluation */
  llm_boost: number
  /** Brief reasoning for the score */
  reasoning: string
}

/**
 * Placeholder: Evaluate semantic relevance of a correlated variable group.
 * Returns zero scores (no-op) — replace body with real LLM API call when available.
 *
 * @example Future implementation sketch:
 * ```typescript
 * async function evaluateGroupSemantics(req: LlmEvaluationRequest): Promise<LlmEvaluationResult> {
 *   const prompt = buildEvaluationPrompt(req.group, req.source_context, req.mode)
 *   const response = await llmApi.complete(prompt)
 *   return parseEvaluationResponse(response)
 * }
 * ```
 */
function evaluateGroupSemantics(_req: LlmEvaluationRequest): LlmEvaluationResult {
  // No-op: LLM evaluation is currently performed by the multivar-atomicity-checker agent
  return { llm_semantic_relevance: 0, llm_boost: 0, reasoning: "" }
}

// Export for future use / testing
export { evaluateGroupSemantics, type LlmEvaluationRequest, type LlmEvaluationResult }
```

**Step 2: Commit**

```bash
git add src/tools/multivar-correlated-vars.ts
git commit -m "feat(tool-a): add LLM evaluation placeholder interface

Add LlmEvaluationRequest/Result interfaces and a no-op
evaluateGroupSemantics function. Designed for drop-in replacement
when a direct LLM API becomes available. Currently, LLM evaluation
is performed by the multivar-atomicity-checker agent externally."
```

---

## Task 11: Update SKILL.md Scoring Documentation (D1)

**Files:**
- Modify: `skills/multivar-atomicity/SKILL.md:106-157`

**What:** Update the scoring tables to reflect the new base scores, new dimensions (`dependency_depth`, `naming_similarity`, `same_domain`), removed dimensions (`cross_function`), and adjusted weights.

**Step 1: Replace section 3.1 scoring table**

Replace lines 114-141 with:

```markdown
| 锚点类型 | 基础分 | 证据加成 | 上限 |
|----------|--------|---------|------|
| DFC | 0.60 | code_distance (0~0.05) + dependency_depth (0~0.04) + struct_base/adjacent_address (0~0.04) + naming_similarity (0~0.02) + variable_count (0~0.02) + access_density (0~0.03) | 0.75 |
| TUP | 0.40 | struct_members/array_elements/adjacent_address/same_domain (0.08~0.18, 互斥取最高) + line_proximity (0~0.05) + variable_count (0~0.02) + write_concentration (0~0.02) | 0.75 |
| DAC | 0.30 | disjoint_rw (0~0.06) + struct_base (0~0.06) + naming_similarity (0~0.04) + naming_pattern (0~0.04) + LLM 语义分析 Step 3.5 (0~0.4) | 0.75 |

**DFC 证据**：
- code_distance：连续指数衰减 `0.05 × exp(-span/15)`，距离越近得分越高
- dependency_depth：数据依赖链层数越少越好，1层=+0.04, 2层=+0.02, 3层=+0.01
- struct_base：共享同一结构体/数组基 → +0.04
- adjacent_address：相邻地址命名模式（H/L后缀） → +0.04
- naming_similarity：变量名共享有意义前缀 → +0.02
- variable_count：变量数 > 2 时，对数递减加分 → 0~0.02
- access_density：访问点数 > 2 时，对数加分 → 0~0.03

**TUP 证据**（子类型互斥取最高）：
- struct_members：同一结构体不同成员 → +0.18（缓存/遥测/参数包等事务数据）
- array_elements：同一数组不同元素 → +0.18（缓冲区/表项/向量等批量数据）
- adjacent_address：相邻地址独立变量（高/低字节命名模式） → +0.12（寄存器对）
- same_domain：共同命名前缀或类型相似 → +0.08（同功能域变量）
- line_proximity：连续指数衰减 `0.05 × exp(-avgGap/5)`，行间距越小得分越高
- variable_count：变量数 > 2 时加分 → 0~0.02
- write_concentration：写操作比例 > 80% 时加分 → 0~0.02

**DAC 证据**：
- disjoint_rw：读写变量集合完全不相交 → +0.06
- struct_base：共享结构体基 → +0.06
- naming_similarity：决策/行为变量共享命名前缀 → +0.04
- naming_pattern：决策变量匹配 flag 模式且行为变量匹配 data 模式 → +0.04
- llm_semantic：Agent Step 3.5 LLM 语义相关性评估 (0~1) × 0.4 → 0~0.4
```

**Step 2: Update section 3.2 threshold analysis**

Replace lines 142-148 with:

```markdown
### 3.2 工具层过滤

**统一阈值**：工具层置信度 >= 0.5 保留，< 0.5 丢弃。

> 注意：DFC 基础分 0.60 ≥ 0.5，默认保留。
> TUP 基础分 0.40，需要子类型结构证据（struct_members/array_elements/adjacent_address/same_domain）才能过 0.5。无结构证据的相邻写操作（最高 0.49）被自然淘汰。
> DAC 基础分 0.30，纯工具模式下需要所有结构证据命中（最好 0.50）；正常模式依赖 Step 3.5 LLM 语义评估 ≥ 0.5 才能通过。
```

**Step 3: Commit**

```bash
git add skills/multivar-atomicity/SKILL.md
git commit -m "docs(skill): update scoring tables for new evidence model

Reflect new DFC dimensions (dependency_depth, naming_similarity),
removed cross_function dead code, TUP base change from 0.50 to 0.40
with sub-type evidence as primary differentiator, DAC weight
adjustments for degraded-mode capability."
```

---

## Task 12: Build, Typecheck, and Validate

**Files:**
- No new files; validation of all previous changes

**Step 1: Run typecheck**

Run: `bun run typecheck`
Expected: PASS with 0 errors

**Step 2: Run build**

Run: `bun run build`
Expected: PASS, `dist/index.js` generated

**Step 3: Run existing tests**

Run: `bun run tests/test-atomicity-pipeline.ts`
Expected: All 17 tests pass (schema validation, pattern enum checks)

**Step 4: Run E2E tests (if real1_bench available)**

Run: `bun run tests/test-atomicity-e2e.ts`
Expected: Tests pass. Note: some violation counts may change due to expanded update dimension — this is expected.

**Step 5: Final commit**

```bash
git add -A
git commit -m "chore: verify typecheck, build, and test pass after correlated-vars enhancement"
```

---

## Execution Order

```
Task 1  (J1: fix dead branch)        — independent
Task 2  (J2: D3 call-args sink)      — independent
Task 3  (J3: D4 generalized update)  — independent
Task 4  (J4: D5 implicit boolean)    — independent
    ↓ (Tasks 1-4 are all Joern changes, can be done in any order)
Task 5  (T1: remove TUP→DFC)         — depends on understanding T2
Task 6  (T2: simplify classifySvcType) — depends on Task 3 conceptually
Task 7  (T3: TUP scoring)            — depends on Task 6
Task 8  (T4+T6: DFC scoring)         — independent of Tasks 5-7
Task 9  (T5: DAC scoring)            — independent of Tasks 5-8
Task 10 (T7: LLM placeholder)        — independent
Task 11 (D1: SKILL.md)               — depends on Tasks 7-9 (scoring finalized)
Task 12 (validation)                  — depends on all above
```

Recommended batch order:
1. **Batch A** (Joern script): Tasks 1 → 2 → 3 → 4 → commit all
2. **Batch B** (Tool A scoring): Tasks 5 → 6 → 7 → 8 → 9 → 10 → commit all
3. **Batch C** (Docs + validation): Tasks 11 → 12

## Risk Assessment

| Task | Risk | Mitigation |
|------|------|-----------|
| Task 3 (D4 rewrite) | **High** — changes core Joern extraction, may produce different group count | Run on real1_bench before/after, compare group counts |
| Task 7 (TUP scoring) | **Medium** — base change from 0.50→0.40 may filter groups that previously passed | Verify that struct/array groups still pass 0.5 threshold |
| Task 4 (implicit boolean) | **Low** — additive, only extends DAC input | No existing groups affected |
| Task 1, 2, 5, 6, 8-12 | **Low** | Standard refactoring/additive changes |
