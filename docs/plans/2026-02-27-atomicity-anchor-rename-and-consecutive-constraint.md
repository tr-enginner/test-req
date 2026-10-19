# Atomicity Anchor Rename + ISR Consecutive Access Constraint Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rename anchor types (SVC_DATAFLOW→DFC, SVC_TRANSACTIONAL→TUP), reassign violation pattern ownership (SVC_WR from DFC to TUP), and add ISR consecutive access constraint to reduce false positives in the atomicity violation detection pipeline.

**Architecture:** Three coordinated changes: (1) Rename anchor type enum values across all source, schema, skill, agent prompt, template, and test files; (2) Reassign violation pattern dispatch so DFC→SVC_RW only, TUP→SVC_WR+SVC_WW; (3) Add consecutive access filtering for ISR-side accesses in pattern matching. All changes maintain backward data compatibility by updating both code and any existing JSON data references.

**Tech Stack:** TypeScript (Bun runtime), Zod schemas, Markdown (SKILL.md, templates)

---

## Summary of Changes

### Change 1: Anchor Type Rename
- `SVC_DATAFLOW` → `DFC` (Data Flow Convergence)
- `SVC_TRANSACTIONAL` → `TUP` (Transaction Update)
- `DAC` stays unchanged
- Affects: schema, tools, agents, skills, templates, tests, CLAUDE.md

### Change 2: Pattern Ownership Reassignment
- DFC (R-R anchor) → only matches **SVC_RW** pattern
- TUP (W-W anchor) → matches **SVC_WR** + **SVC_WW** patterns
- DAC (R-W anchor) → only matches **DAC_RW** pattern (unchanged)

### Change 3: ISR Consecutive Access Constraint
- When matching ISR-side access pairs, only accept **consecutive** accesses to the correlated variables
- "Consecutive" = sorted by line number, no intervening access to any variable in the correlated group between the two matched accesses
- Applies to all 4 pattern matchers (matchSvcRW, matchSvcWR, matchSvcWW, matchDacRW)

---

### Task 1: Update Zod Schema — Rename AnchorType Enum

**Files:**
- Modify: `src/schema/atomicity.ts:8`

**Step 1: Edit AnchorType enum**

Change:
```typescript
export const AnchorType = z.enum(["SVC_DATAFLOW", "SVC_TRANSACTIONAL", "DAC"])
```
To:
```typescript
export const AnchorType = z.enum(["DFC", "TUP", "DAC"])
```

**Step 2: Run typecheck to verify**

Run: `bun run typecheck`
Expected: Type errors in files that still reference old names (will fix in subsequent tasks)

---

### Task 2: Update Correlated Vars Tool — Rename anchor types

**Files:**
- Modify: `src/tools/multivar-correlated-vars.ts`

**Step 1: Update CVGroup interface** (line 32)

Change `anchor_type` union from `"SVC_DATAFLOW" | "SVC_TRANSACTIONAL" | "DAC"` to `"DFC" | "TUP" | "DAC"`.

**Step 2: Update inferAnchorType return type and values**

In `inferAnchorType()` (line ~114-152):
- Change return type from `"SVC_DATAFLOW" | "SVC_TRANSACTIONAL" | "DAC"` to `"DFC" | "TUP" | "DAC"`
- Replace all `return "SVC_TRANSACTIONAL"` with `return "TUP"`
- Replace all `return "SVC_DATAFLOW"` with `return "DFC"`

**Step 3: Update classifySvcType**

In `classifySvcType()` (line ~302-319):
- Change return type to `"DFC" | "TUP"`
- Replace `"SVC_TRANSACTIONAL"` → `"TUP"`, `"SVC_DATAFLOW"` → `"DFC"`

**Step 4: Update assignVariableRoles**

In `assignVariableRoles()` (line ~154-174):
- Replace `anchorType === "SVC_TRANSACTIONAL"` with `anchorType === "TUP"`

**Step 5: Update all remaining string references**

Replace all occurrences in this file:
- `"SVC_DATAFLOW"` → `"DFC"` (including filter conditions, comparisons, anchor_type assignments)
- `"SVC_TRANSACTIONAL"` → `"TUP"`
- In `analyzeSvcGroups()`, `refineEvidence()`, `generateCorrelatedGroupsMd()`, and the tool description

**Step 6: Update MD report anchor type labels**

In `generateCorrelatedGroupsMd()` (line ~679):
- Change the iteration array from `["SVC_DATAFLOW", "SVC_TRANSACTIONAL", "DAC"]` to `["DFC", "TUP", "DAC"]`

**Step 7: Update summary by_type keys**

In the result summary object (line ~921-927):
- Change `svc_dataflow` → `dfc`, `svc_transactional` → `tup`

---

### Task 3: Update Violation Detect Tool — Rename + Pattern Reassignment + Consecutive Constraint

**Files:**
- Modify: `src/tools/multivar-violation-detect.ts`

**Step 1: Update CVGroup interface** (line ~32)

Change `anchor_type` union from `"SVC_DATAFLOW" | "SVC_TRANSACTIONAL" | "DAC"` to `"DFC" | "TUP" | "DAC"`.

**Step 2: Add consecutive access pair extraction helper**

Add a new function after `getAccessesForVar()` (~line 100):

```typescript
/**
 * Extract consecutive access pairs for the correlated variable group from a
 * given context. "Consecutive" means the two accesses (to varA and varB) are
 * adjacent in source-line order among ALL accesses to the group's variables,
 * with no intervening access to any group variable between them.
 *
 * Returns array of [accessToVarA, accessToVarB] pairs.
 */
function getConsecutiveAccessPairs(
  seq: AccessSequence,
  groupVars: string[],
  varA: string,
  varB: string,
  accessTypeA: "READ" | "WRITE",
  accessTypeB: "READ" | "WRITE",
): [VarAccess, VarAccess][] {
  // Collect ALL accesses to any group variable in this context, sorted by line
  const groupVarSet = new Set(groupVars)
  const allGroupAccesses = seq.accesses
    .filter((a) => groupVarSet.has(a.variable_name))
    .sort((a, b) => a.location.line - b.location.line || a.location.column - b.location.column)

  const pairs: [VarAccess, VarAccess][] = []
  for (let i = 0; i < allGroupAccesses.length - 1; i++) {
    const first = allGroupAccesses[i]
    const second = allGroupAccesses[i + 1]

    // Check both orderings: (varA, varB) and (varB, varA)
    if (
      first.variable_name === varA &&
      first.access_type === accessTypeA &&
      second.variable_name === varB &&
      second.access_type === accessTypeB
    ) {
      pairs.push([first, second])
    }
    if (
      first.variable_name === varB &&
      first.access_type === accessTypeB &&
      second.variable_name === varA &&
      second.access_type === accessTypeA
    ) {
      pairs.push([second, first]) // normalize: varA first
    }
  }
  return pairs
}
```

**Step 3: Refactor matchSvcRW to use consecutive ISR pairs**

Replace the ISR-side matching logic in `matchSvcRW()`. Instead of the cartesian product of all writesAHigh × writesBHigh, use `getConsecutiveAccessPairs(highSeq, group.variables, varA, varB, "WRITE", "WRITE")` to only match consecutive write pairs.

```typescript
function matchSvcRW(
  group: CVGroup,
  lowSeq: AccessSequence,
  highSeq: AccessSequence,
  priority: number,
): ViolationData[] {
  const violations: ViolationData[] = []
  const vars = group.variables
  if (vars.length < 2) return violations

  for (let i = 0; i < vars.length; i++) {
    for (let j = i + 1; j < vars.length; j++) {
      const orderings: [string, string][] = [[vars[i], vars[j]], [vars[j], vars[i]]]
      for (const [varA, varB] of orderings) {
        const readsA = getAccessesForVar(lowSeq, varA).filter((a) => a.access_type === "READ")
        const readsB = getAccessesForVar(lowSeq, varB).filter((a) => a.access_type === "READ")

        if (readsA.length === 0 || readsB.length === 0) continue

        // ISR side: only consecutive write pairs
        const highWritePairs = getConsecutiveAccessPairs(highSeq, vars, varA, varB, "WRITE", "WRITE")
        if (highWritePairs.length === 0) continue

        for (const ra of readsA) {
          for (const rb of readsB) {
            if (ra.location.line <= rb.location.line) {
              for (const [wha, whb] of highWritePairs) {
                violations.push(
                  createViolation(
                    "SVC_RW", group, [varA, varB],
                    [ra, rb], lowSeq.context_name, lowSeq.context_type,
                    highSeq.context_name, [wha, whb],
                    ra, rb, priority,
                  ),
                )
              }
            }
          }
        }
      }
    }
  }
  return violations
}
```

**Step 4: Refactor matchSvcWR similarly**

Same approach — use `getConsecutiveAccessPairs(highSeq, vars, varA, varB, "READ", "READ")` for the ISR-side read pairs.

**Step 5: Refactor matchSvcWW similarly**

Use `getConsecutiveAccessPairs(highSeq, vars, varA, varB, "WRITE", "WRITE")` for ISR-side write pairs.

**Step 6: Refactor matchDacRW similarly**

Use `getConsecutiveAccessPairs(highSeq, vars, varA, varB, "WRITE", "WRITE")` for ISR-side write pairs.

**Step 7: Update pattern dispatch switch** (line ~828-843)

Change:
```typescript
case "SVC_DATAFLOW":
  allViolations.push(...matchSvcRW(group, lowSeq, highSeq, priority))
  allViolations.push(...matchSvcWR(group, lowSeq, highSeq, priority))
  break
case "SVC_TRANSACTIONAL":
  allViolations.push(...matchSvcWW(group, lowSeq, highSeq, priority))
  break
```

To:
```typescript
case "DFC":
  // DFC (R-R anchor) → only SVC_RW
  allViolations.push(...matchSvcRW(group, lowSeq, highSeq, priority))
  break
case "TUP":
  // TUP (W-W anchor) → SVC_WR + SVC_WW
  allViolations.push(...matchSvcWR(group, lowSeq, highSeq, priority))
  allViolations.push(...matchSvcWW(group, lowSeq, highSeq, priority))
  break
```

---

### Task 4: Update Agent Prompt — Rename + Pattern Reassignment

**Files:**
- Modify: `src/agents/multivar-atomicity-checker.ts`

**Step 1: Replace all SVC_DATAFLOW/SVC_TRANSACTIONAL references**

In the system prompt and metadata:
- `SVC_DATAFLOW` → `DFC`
- `SVC_TRANSACTIONAL` → `TUP`
- `SVC-Dataflow` → `DFC`
- `SVC-Transactional` → `TUP`
- Update the pattern dispatch documentation in the prompt to reflect:
  - DFC → SVC_RW only
  - TUP → SVC_WR + SVC_WW

**Step 2: Update useWhen/avoidWhen metadata**

Replace `SVC-Dataflow, SVC-Transactional` with `DFC, TUP` in the `useWhen` array.

---

### Task 5: Update SKILL.md — Rename + Pattern Ownership

**Files:**
- Modify: `skills/multivar-atomicity/SKILL.md`

**Step 1: Rename anchor types in section headers and content**

- `SVC-Dataflow（数据流汇聚型）` → `DFC（数据流汇聚型, Data Flow Convergence）`
- `SVC-Transactional（事务更新型）` → `TUP（事务更新型, Transaction Update）`
- All table entries: `SVC_DATAFLOW` → `DFC`, `SVC_TRANSACTIONAL` → `TUP`

**Step 2: Update pattern-to-anchor mapping description**

In the violation patterns section, clarify:
- SVC_RW: produced from DFC anchor (R-R pair in low-priority)
- SVC_WR: produced from TUP anchor (W-W pair in low-priority, R-R in high-priority)
- SVC_WW: produced from TUP anchor (W-W in both sides)
- DAC_RW: produced from DAC anchor (unchanged)

**Step 3: Add consecutive access constraint description**

Add note in section 2 that ISR-side matched accesses must be consecutive (no intervening access to the correlated variable group between the two matched accesses).

---

### Task 6: Update Template — Rename

**Files:**
- Modify: `templates/multivar-violation.md`

**Step 1: Replace anchor type names**

- `SVC_DATAFLOW` → `DFC`
- `SVC_TRANSACTIONAL` → `TUP`

---

### Task 7: Update CLAUDE.md — Rename

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Replace all SVC_DATAFLOW/SVC_TRANSACTIONAL references**

Global replace in CLAUDE.md.

---

### Task 8: Update Tests — Rename

**Files:**
- Modify: `tests/test-atomicity-pipeline.ts`
- Modify: `tests/test-atomicity-e2e.ts`
- Modify: `tests/test-real2-bench.ts`
- Modify: `tests/generate-atomicity-reports.ts`
- Modify: `tests/test-generate-report.ts`
- Modify: `tests/test-btime-debug.ts`

**Step 1: Replace all SVC_DATAFLOW/SVC_TRANSACTIONAL string references in each test file**

- `"SVC_DATAFLOW"` → `"DFC"`
- `"SVC_TRANSACTIONAL"` → `"TUP"`
- `svc_dataflow` → `dfc`
- `svc_transactional` → `tup`
- `SVC-Dataflow` → `DFC`
- `SVC-Transactional` → `TUP`

---

### Task 9: Typecheck + Build

**Step 1: Run typecheck**

Run: `bun run typecheck`
Expected: PASS with no errors

**Step 2: Run build**

Run: `bun run build`
Expected: PASS

---

### Task 10: Run Existing Tests

**Step 1: Run pipeline tests**

Run: `bun run tests/test-atomicity-pipeline.ts`
Expected: All tests pass (schema validation, pattern enum checks)

---

### Task 11: Run E2E Test with D:\real1_bench

**Step 1: Run e2e tests**

Run: `bun run tests/test-atomicity-e2e.ts`
Expected: All tests pass (CPG query, pattern matching, MD generation). Candidate count may decrease due to consecutive access constraint.

**Step 2: Verify output files**

Check:
- `D:\real1_bench\.matrix\data\multivar-correlated-groups.json` has `DFC`/`TUP` anchor types
- `D:\real1_bench\.matrix\data\multivar-candidates.json` has no `DAC_WW` and correct pattern distribution
- MD reports use new anchor type names

---

### Task 12: Commit

```bash
git add -A
git commit -m "refactor: rename SVC_DATAFLOW→DFC, SVC_TRANSACTIONAL→TUP; reassign SVC_WR to TUP; add ISR consecutive access constraint

- Rename anchor types: SVC_DATAFLOW→DFC (Data Flow Convergence), SVC_TRANSACTIONAL→TUP (Transaction Update)
- DFC anchor now only produces SVC_RW pattern (was SVC_RW+SVC_WR)
- TUP anchor now produces SVC_WR+SVC_WW patterns (was SVC_WW only)
- Add consecutive access constraint for ISR-side pattern matching to reduce false positives
- Update schema, tools, agent prompt, skill, template, tests, and CLAUDE.md

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```
