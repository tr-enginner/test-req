# Design: Per-Requirement Deep Review + Holistic Verification

**Date**: 2026-02-23
**Status**: Implemented
**Problem**: Inspector's single-pass full review dilutes attention across N requirements, causing missed defects (e.g., `||` vs `&&` in SRS-3.2.5.1)
**Solution**: Split Phase 3 code review into N independent focused reviews + 1 holistic summary pass

---

## Architecture

```
Phase 3 (revised):

  Conductor reads software-analysis.json
       │
       ├─ For each requirement with linked_functions:
       │    dispatch Inspector(focused, req_id=REQ-xxx)  ← parallel, background
       │
       ├─ dispatch StaticAnalyzer()                      ← parallel, unchanged
       │
       │  ... wait for all focused reviews to complete ...
       │
       └─ dispatch Inspector(summary)                    ← reads all focused results
            ├─ Completeness verification
            ├─ Runtime safety defect analysis (cross-function)
            ├─ Cross-requirement consistency checks
            └─ Merge → defects.json + code-review.md
```

## Inspector Modes

### Mode 1: Focused Review (`focused`)

**Trigger**: Conductor passes `review_mode=focused` and `target_requirement_id=<id>` in the task prompt.

**Scope**: ONE requirement, maximum depth.

**Workflow**:
1. Load skill (`code-review`), read `software-analysis.json`, read `compilation-env.json`
2. Extract the single target requirement + its `resolved_references` and `related_requirements`
3. Read ALL implementing code via `read` (not just signatures)
4. Decompose into atomic sub-items
5. For each sub-item: formalize "Req specifies" / "Code does", check D1-D10
6. Write result to `.matrix/data/review-records/<req_id>.json`

**Output format** (simplified — reduces output tokens):

```json
{
  "requirement_id": "SRS-3.2.5.1",
  "requirement_title": "蓄电池组安时计控制功能",
  "target_architecture": "80C32 / c51",
  "sub_items": [
    {
      "id": "SI-1",
      "assertion": "满充检测条件：条件1 且 条件2 且 持续≥30s",
      "code_locations": ["power.c:1620-1640"],
      "req_specifies": "(currentPhalanx-currentLoad)>=threshold+0.5 AND chargeCurrent<=threshold, 持续≥30s",
      "code_does": "uses || (OR) instead of && (AND) at line 1620",
      "dimensions": {
        "D1": "MISMATCH: requirement uses 且(AND), code uses ||(OR)",
        "D2": "MATCH",
        "D3": "MATCH",
        "D5": "MATCH: count>=15 at 2s cycle = 30s",
        "D6": "N/A"
      },
      "verdict": "MISMATCH",
      "defect_ids": ["DEF-CR-F001"]
    }
  ],
  "d9_completeness": "PARTIAL: 满充检测逻辑运算符错误",
  "overall_verdict": "INCONSISTENT",
  "defects": [
    {
      "id": "DEF-CR-F001",
      "source": "code_review",
      "severity": "critical",
      "category": "logic_error",
      "location": { "file_path": "power.c", "line_start": 1620, "function_name": "PowerControl" },
      "title": "满充检测条件逻辑运算符错误：|| 应为 &&",
      "description": "需求要求条件1 AND 条件2同时满足才判定满充，代码使用||导致任一条件满足即判定满充",
      "related_requirement_ids": ["SRS-3.2.5.1"],
      "status": "open",
      "detected_by": "inspector",
      "detected_date": "2026-02-23"
    }
  ]
}
```

**Key simplifications vs current report**:
- No verbose markdown narrative — structured JSON only
- Dimensions use short keys (`"D1"`, `"D2"`, ...) with value = `"N/A"` | `"MATCH"` | `"MISMATCH: <reason>"`
- Only MISMATCH dimensions need explanation text
- MATCH dimensions: just `"MATCH"` (no elaboration)
- N/A dimensions: omitted entirely from the map (only include checked dimensions)
- Defects embedded in the same JSON (no separate file per requirement)

### Mode 2: Summary Review (`summary`)

**Trigger**: Conductor passes `review_mode=summary` after all focused reviews complete.

**Scope**: Cross-cutting analysis that cannot be done per-requirement.

**Workflow**:
1. Load skill, read `software-analysis.json`
2. Read ALL `.matrix/data/review-records/*.json`
3. **Completeness verification**:
   - Count: review records produced vs requirements with linked_functions
   - For each record: verify sub_items cover all atomic assertions in the requirement
   - For each MISMATCH: verify a corresponding defect exists
   - Flag any gaps
4. **Runtime safety defect analysis** (Section 1 of skill):
   - Cross-function data flow: buffer overflow, integer overflow, division by zero
   - Interrupt/concurrency: non-atomic access, missing volatile, reentrancy
   - Resource/state machine: register access order, undefined states
   - These require whole-program analysis, not per-requirement scope
5. **Cross-requirement consistency**:
   - Same variable/function referenced by multiple requirements — are behaviors consistent?
   - Shared state between ISR and main loop — all access points protected?
6. **Merge and output**:
   - Collect all defects from review-records + new defects from steps 3-5
   - Assign final sequential IDs (DEF-CR-001, DEF-CR-002, ...)
   - Write `.matrix/data/defects.json` (append to existing, preserve other sources)
   - Generate `.matrix/reports/code-review.md` (summary table + per-requirement results)

## Changes Required

### 1. New Schema: `src/schema/review-record.ts`

```typescript
import { z } from "zod"
import { Defect } from "./defect"

const DimensionVerdict = z.string() // "N/A" | "MATCH" | "MISMATCH: <reason>"

const SubItemRecord = z.object({
  id: z.string(),
  assertion: z.string(),
  code_locations: z.array(z.string()),
  req_specifies: z.string(),
  code_does: z.string(),
  dimensions: z.record(z.string(), DimensionVerdict), // D1..D10, only checked dims
  verdict: z.enum(["MATCH", "MISMATCH"]),
  defect_ids: z.array(z.string()).default([]),
})

export const ReviewRecord = z.object({
  requirement_id: z.string(),
  requirement_title: z.string(),
  target_architecture: z.string().default("generic"),
  sub_items: z.array(SubItemRecord),
  d9_completeness: z.enum(["COMPLETE", "PARTIAL", "NO_IMPL"]),
  d9_detail: z.string().optional(), // explanation when PARTIAL or NO_IMPL
  overall_verdict: z.enum(["CONSISTENT", "INCONSISTENT"]),
  defects: z.array(Defect).default([]),
})
export type ReviewRecord = z.infer<typeof ReviewRecord>
```

### 2. New Artifact Paths: `src/shared/constants.ts`

```typescript
// Add to DATA_DIR section:
export const REVIEW_RECORDS_DIR = `${DATA_DIR}/review-records`

// Add to ARTIFACT_PATHS:
REVIEW_RECORDS: `${DATA_DIR}/review-records`,
```

### 3. Ensure Directory: `src/shared/data-store.ts`

Add `".matrix/data/review-records"` to `ensureMatrixDirs`.

### 4. Inspector Agent: `src/agents/inspector.ts`

Replace single prompt with mode-aware prompt construction:

```typescript
export function createInspectorAgent(model?: string): AgentConfig {
  return {
    // ... same metadata ...
    prompt: INSPECTOR_SYSTEM_PROMPT, // Updated prompt with mode detection
    // ... same tools, permissions ...
  }
}
```

The updated system prompt detects mode from the task delegation prompt:
- If prompt contains `review_mode=focused` and `target_requirement_id=XXX`: execute focused workflow
- If prompt contains `review_mode=summary`: execute summary workflow
- Fallback (no mode specified): legacy behavior (full single-pass review, for backward compatibility)

#### Focused Mode Prompt Additions

Key rules for focused mode:
- Output ONLY the ReviewRecord JSON to `.matrix/data/review-records/<req_id>.json`
- No markdown report generation (summary mode handles that)
- Maximum depth: decompose ALL sub-items, check ALL applicable dimensions
- Defect IDs use temporary prefix `DEF-CR-F<NNN>` (summary mode reassigns final IDs)
- Keep output concise: MATCH dimensions get no explanation, only MISMATCH dimensions get detailed text

#### Summary Mode Prompt Additions

Key rules for summary mode:
- Read ALL `.matrix/data/review-records/*.json` first
- Perform completeness verification before runtime safety analysis
- Generate `.matrix/reports/code-review.md` with:
  - Summary table (requirement_id | title | verdict | defect_count)
  - Completeness statistics
  - Runtime safety findings
  - Full defect list
- Reassign all defect IDs to sequential DEF-CR-001, DEF-CR-002, ...
- Merge into `.matrix/data/defects.json`

### 5. Code-Review Skill: `skills/code-review/SKILL.md`

Split into sections clearly labeled for each mode:

- **Section 1: Runtime Safety** (used by summary mode only)
- **Section 2: Requirement-Code Consistency** (used by focused mode)
  - Verification dimensions D1-D10 (unchanged)
  - Record format updated to match ReviewRecord JSON schema
  - Common pitfalls table (unchanged)
- **Section 3: Completeness Verification** (NEW, used by summary mode)
  - Record count check
  - Sub-item coverage check
  - MISMATCH→Defect mapping check
  - Cross-requirement consistency check
- **Section 4: Defect Recording** (unchanged, used by both modes)

### 6. Conductor Agent: `src/agents/conductor.ts`

Phase 3 section rewritten:

```
## Phase 3: Code Review & Static Analysis

### Step 1: Read requirement list
Read .matrix/data/software-analysis.json. Extract all requirements that have linked
implementing functions (linked_functions is non-empty). Let N = count of such requirements.

### Step 2: Dispatch per-requirement focused reviews
For each requirement REQ-i (i = 1..N):
  task(subagent_type="inspector",
       prompt="review_mode=focused target_requirement_id=<REQ-i.id>
               Perform focused deep review of requirement <REQ-i.id> (<REQ-i.title>).
               Read .matrix/data/software-analysis.json for requirement context.
               Read .matrix/data/compilation-env.json for compilation environment.
               Output ReviewRecord JSON to .matrix/data/review-records/<REQ-i.id>.json.",
       run_in_background=true)

### Step 3: Dispatch static analysis (unchanged, parallel)
  task(subagent_type="static-analyzer", prompt="...", run_in_background=true)

### Step 4: Wait for all focused reviews + static analysis to complete

### Step 5: Dispatch summary review
  task(subagent_type="inspector",
       prompt="review_mode=summary
               Perform holistic review: read all .matrix/data/review-records/*.json,
               verify completeness, perform runtime safety analysis (cross-function),
               check cross-requirement consistency, merge defects, generate report.
               Output to .matrix/data/defects.json and .matrix/reports/code-review.md.")
```

### 7. Progress Tracker Hook: `src/hooks/progress-tracker.ts`

Update Phase 3 completion detection:
- Current: detects `code-review.md` creation → Phase 3 complete
- New: detect `code-review.md` creation (which only happens after summary mode) → Phase 3 complete
- No change needed if the current trigger is already tied to the report file

## Token Cost Analysis

Assumptions: 21 requirements, average 2000 input tokens per requirement context, 500 output tokens per focused review.

| Component | Input tokens | Output tokens | Total |
|-----------|-------------|---------------|-------|
| N focused reviews (21×) | 21 × ~8K (skill+context+code) = 168K | 21 × ~500 = 10.5K | 178.5K |
| 1 summary review | ~20K (skill+all records+code) | ~5K (report+new defects) | 25K |
| **Total Phase 3** | **~188K** | **~15.5K** | **~203.5K** |
| Current single-pass | ~15K | ~15K | ~30K |

**Cost increase**: ~6-7x input tokens, ~1x output tokens. Output token savings from simplified JSON format partially offset the multiplication.

**Key optimization**: Focused mode output is JSON-only (no verbose markdown narrative), keeping output tokens per requirement to ~500 instead of the current ~700 per requirement in the single-pass report.

## Migration & Backward Compatibility

- If no `review_mode` is specified in the Inspector task prompt, fall back to current single-pass behavior
- Conductor only uses the new dispatch pattern when `software-analysis.json` exists and contains requirements with linked_functions
- Old `.matrix/data/defects.json` format is unchanged — no migration needed
- New `.matrix/data/review-records/` directory is created on demand

## Files Changed

| File | Change | Size |
|------|--------|------|
| `src/schema/review-record.ts` | **NEW** | ~40 lines |
| `src/shared/constants.ts` | Add REVIEW_RECORDS_DIR + artifact path | ~3 lines |
| `src/shared/data-store.ts` | Add review-records to ensureMatrixDirs | ~1 line |
| `src/agents/inspector.ts` | Rewrite prompt for mode-aware workflow | ~200 lines |
| `skills/code-review/SKILL.md` | Add Section 3 (completeness verification), annotate mode applicability | ~50 lines |
| `src/agents/conductor.ts` | Rewrite Phase 3 dispatch logic | ~40 lines |
