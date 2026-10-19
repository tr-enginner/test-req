# Atomicity Pipeline Refinement Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refine the multi-variable atomicity violation detection pipeline with 3 targeted improvements: (1) Joern source dimension tagging to eliminate ambiguous anchor type inference, (2) removal of redundant ISR write constraint in Tool C's SMT encoding, (3) end-to-end validation on real1_bench.

**Architecture:** Three changes across the Joern Scala script, Tool A TypeScript, and Tool C TypeScript. The Joern script adds a `"Source"` field to each AccessList entry. Tool A uses this field as the primary anchor type signal. Tool C removes the redundant `isr_changes_*` Bool variables and replaces them with a defensive assertion. All changes are backward-compatible (Tool A falls back to heuristic inference if `"Source"` is absent).

**Tech Stack:** Scala (Joern script), TypeScript (Bun runtime), SMT-LIB2 (Z3 solver)

---

### Task 1: Add source dimension tag to Joern Scala output

**Files:**
- Modify: `joern/multivarCorrelatedVarsIdentify.scala`

**What:** The `getVariableCorrelation` function extracts variable pairs from 3 dimensions (sink/arithmetic, update/consecutive-write, dac/control-structure) but this provenance is lost in `buildVariableCorrelationJson`. Add a `"Source"` metadata field to each AccessList.

**Step 1:** In `getVariableCorrelation`, change the return type from `Map[CfgNode, List[Map[String, VariableTrace]]]` to include a source tag. We use a wrapper case class:

```scala
case class TaggedCombine(
  source: String,  // "sink" | "update" | "dac"
  var2PathMap: Map[String, VariableTrace]
)
```

Change `varPairsMap` type to `mutable.Map[CfgNode, List[TaggedCombine]]`.

In the 3 extraction sections:
- Section 1 (condList + arithmetic): wrap each combine with `TaggedCombine("sink", combine)`
- Section 2 (basic block updates): wrap with `TaggedCombine("update", oneCombine)`
- Section 3 (DAC control structure): wrap with `TaggedCombine("dac", combine)`

**Step 2:** Update `removeDuplicate` to work with the new type.

**Step 3:** Update `buildVariableCorrelationJson` to emit the `"Source"` field per AccessList group. Add the tag from the first TaggedCombine in each group.

**Step 4:** Verify backward compatibility: the `queryVariableAccesses` and `analyzePathFeasibility` functions do NOT use `getVariableCorrelation` output, so they are unaffected.

---

### Task 2: Use Joern source dimension in Tool A anchor type inference

**Files:**
- Modify: `src/tools/multivar-correlated-vars.ts`

**What:** When parsing Joern output, use the new `"Source"` field as primary anchor type signal. Fall back to heuristic `inferAnchorType` when absent.

**Step 1:** In `parseJoernAccessLists`, after parsing each AccessList:

```typescript
// Check for Joern source dimension tag (new field)
const firstEntry = al[0]
const joernSource: string | undefined = firstEntry?.Source

let anchorType: "DFC" | "TUP" | "DAC"
if (joernSource === "dac") {
  anchorType = "DAC"
} else if (joernSource === "update") {
  anchorType = "TUP"
} else if (joernSource === "sink") {
  anchorType = "DFC"
} else {
  // Fallback: heuristic inference (backward compatible)
  anchorType = inferAnchorType(accesses)
}
```

**Step 2:** The existing C1/C2 constraint checks (TUP same-function → degrade to DFC, DFC cross-function → split) remain unchanged and still apply AFTER the source-based classification.

**Step 3:** Add `joern_source` to the evidence breakdown for traceability:

```typescript
if (joernSource) {
  evidence.joern_source_tag = 1  // marker: source tag was available
}
```

---

### Task 3: Remove redundant ISR write constraint from Tool C

**Files:**
- Modify: `src/tools/multivar-feasibility-verify.ts`

**What:** Replace the redundant `isr_changes_*` Bool variable block (lines 920-947) with a lightweight defensive assertion. Tool B already guarantees ISR-side access types match the pattern.

**Step 1:** Replace the ISR access constraint block in `encodeViolationAsSmt`:

```typescript
// ── ISR access constraint (defensive) ──
// Tool B guarantees ISR-side access types match the pattern:
//   SVC_RW/SVC_WW/DAC_RW → ISR side is WRITE+WRITE
//   SVC_WR → ISR side is READ+READ (no write constraint needed)
// This defensive check asserts false only if Tool B produced inconsistent data.
lines.push("; ── ISR access constraint (defensive) ──")
const isSvcWR = violation.pattern === "SVC_WR"
if (isSvcWR) {
  lines.push("; SVC_WR pattern: ISR reads inconsistent state — no write constraint needed")
} else {
  const isrWrites = violation.interrupt_accesses.filter(
    (ia) => ia.access.access_type === "WRITE",
  )
  if (isrWrites.length === 0) {
    // Should never happen: Tool B guarantees WRITE pairs for non-WR patterns
    lines.push("; DEFENSIVE: No ISR writes found — Tool B data inconsistency")
    lines.push("(assert false)")
  } else {
    lines.push(`; ISR has ${isrWrites.length} write accesses (guaranteed by pattern matching)`)
  }
}
```

This removes:
- All `(declare-const isr_changes_N Bool)` declarations
- The `(assert (or isr_changes_0 isr_changes_1))` assertion
- These had zero constraint power (free Bool OR is always satisfiable)

---

### Task 4: Update tests and validate on real1_bench

**Files:**
- Modify: `tests/test-atomicity-e2e.ts`

**What:** Add test assertions for the new source dimension tag and the simplified ISR constraint. Run the full pipeline on real1_bench to verify no regression.

**Step 1:** Add Test Group F: Source dimension tag validation

```typescript
// Test F: Verify multivar-correlated-groups.json contains source tags after re-run
// (only when data was generated with updated Joern script)
```

**Step 2:** Add Test Group G: ISR constraint simplification validation

```typescript
// Test G: Verify feasibility-verify output does not contain isr_changes_* variables
// Read the multivar-violations.json and check path_constraint fields
```

**Step 3:** Run the full test suite:

```bash
bun run tests/test-atomicity-e2e.ts
```

**Step 4:** Verify no regression by comparing violation counts and feasibility results against baseline.

---

### Task 5: Update schema, skill, and agent documentation

**Files:**
- Modify: `skills/multivar-atomicity/SKILL.md` — add note about source dimension tagging
- Modify: `src/agents/multivar-atomicity-checker.ts` — update workflow description if needed

**What:** Keep documentation consistent with the code changes. Minimal updates to reflect that anchor type now uses Joern source tag as primary signal.

---

## Execution Order

```
Task 1 (Joern script) → Task 2 (Tool A) → Task 3 (Tool C) → Task 4 (Tests) → Task 5 (Docs)
```

Tasks 2 and 3 are independent of each other but both depend on Task 1 being conceptually understood. Task 4 validates everything. Task 5 is documentation cleanup.

## Risk Assessment

- **Task 1** (Joern script): Medium risk — changes the core data pipeline output format. Backward compatible via optional `"Source"` field.
- **Task 2** (Tool A): Low risk — additive change with fallback path.
- **Task 3** (Tool C): Low risk — removing dead code that provably has no constraint power.
- **Task 4** (Tests): Validation step, no risk.
