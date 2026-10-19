# Full-Requirement Code Review + CR-Reviewer Design

**Date**: 2026-02-24
**Status**: Approved
**Scope**: Inspector full-requirement review + new cr-reviewer agent + Conductor Phase 3 flow update

## Problem

1. Inspector Phase 3 focused reviews only cover requirements with `linked_functions` (from Analyst's traceability matrix). If the Analyst fails to link a requirement to its implementing code, that requirement is silently skipped — no code review at all.
2. Phase 3 (code review) has no quality gate. Unlike Phases 2/5/6 which have Reviewer gates, Inspector's output goes unchecked.

## Solution — Approach A

### Change 1: Inspector Full-Requirement Review

**Conductor Phase 3 dispatch**: Change from "only requirements with linked_functions" to "ALL requirements".

**Inspector focused mode — new Step 2.5: Code Discovery** (inserted between Step 2 and Step 3):

Triggered only when `has_linked_functions=false` is present in the delegation prompt.

1. Extract search keywords from the requirement's `description`, `acceptance_criteria`, and `resolved_references`:
   - Function/algorithm names (e.g., "MPPT", "PID", "CRC")
   - Variable/register names (e.g., "bus_voltage", "UART1")
   - Action verb + noun patterns (e.g., "temperature acquisition", "voltage protection")
2. Use `grep` to search all source files for these keywords
3. Use `read` to examine the surrounding code context, determine if truly related
4. Two outcomes:
   - **Code found**: Record in ReviewRecord's `code_locations`, proceed to normal Step 3-5 review
   - **No code found**: Set `d9_completeness: "NO_IMPL"`, record a `requirement_mismatch` defect with title describing the gap and the search process

**Conductor dispatch prompt variants**:
- Requirements with linked_functions: existing prompt (unchanged), no extra marker
- Requirements without linked_functions: add `has_linked_functions=false` to the prompt

### Change 2: New cr-reviewer Agent

**File**: `src/agents/cr-reviewer.ts`
**Name**: `cr-reviewer`
**Category**: quality
**Cost**: EXPENSIVE
**Mode**: subagent

**Trigger point**: After Inspector summary mode completes in Phase 3.

**Input artifacts**:
- `.matrix/data/review-records/*.json` — per-requirement ReviewRecords
- `.matrix/data/defects.json` — merged defect database
- `.matrix/reports/code-review.md` — summary report
- `.matrix/data/software-analysis.json` — source requirements (for cross-checking)

**Output**: `.matrix/data/reviews/cr-review.json` — ReviewRecord with PASS/REVISE verdict

**5 review dimensions**:

| # | Dimension | Check | Blocking criteria |
|---|-----------|-------|-------------------|
| 1 | Requirement coverage completeness | Count review-records files vs total requirements in software-analysis.json | Any requirement without a review record → blocking |
| 2 | Sub-item coverage | For each ReviewRecord, verify sub_items reasonably cover all verifiable assertions in the requirement text | Requirement with obvious missing sub-items → blocking |
| 3 | MISMATCH→Defect mapping | Every sub-item with verdict=MISMATCH must have non-empty defect_ids referencing existing defects in defects.json | Missing mapping → blocking |
| 4 | Defect description quality | Each defect's description must contain both "what is wrong" and "what correct behavior should be". location must have accurate file_path and line_start | Defect with missing/vague description or inaccurate location → major |
| 5 | Dimension coverage reasonableness | Spot-check: D9 (completeness) must appear in every record. D10 must appear when requirement references hardware. No critical dimension gaps | Missing mandatory dimension → major |

**Verdict**:
- PASS: Zero blocking issues
- REVISE: One or more blocking issues

**Tool permissions**: `read`, `glob`, `grep` (read-only, same as Reviewer)

### Change 3: Conductor Phase 3 Flow Update

**Before** (current):
```
Step 1: Read requirements (filter: has linked_functions)
Step 2: Dispatch N focused Inspector reviews (parallel, background)
Step 3: Dispatch static-analyzer (parallel, background)
Step 4: Wait for all completions, verify N review-records
Step 5: Dispatch summary Inspector
```

**After**:
```
Step 1: Read ALL requirements from software-analysis.json
        Split into: has_linked=true group, has_linked=false group
        N = total requirement count
Step 2: Dispatch ALL N focused Inspector reviews (parallel, background)
        - has_linked=true: standard prompt (unchanged)
        - has_linked=false: prompt includes has_linked_functions=false
Step 3: Dispatch static-analyzer (parallel, background, unchanged)
Step 4: Wait for all completions, verify review-records count = N
Step 5: Dispatch summary Inspector (unchanged)
Step 6: [NEW] Dispatch cr-reviewer
Step 7: [NEW] If REVISE:
        - Send issue feedback to Inspector for correction
        - Re-dispatch cr-reviewer
        - Max 3 cycles; after 3 failures → escalate to Oracle
Step 8: [NEW] Gate passes → advance to Phase 4
```

## File Change List

| File | Change type | Description |
|------|-------------|-------------|
| `src/agents/conductor.ts` | Modify | Phase 3: all-requirement dispatch + cr-reviewer gate + REVISE loop |
| `src/agents/inspector.ts` | Modify | Focused mode: add Step 2.5 Code Discovery + handle `has_linked_functions=false` |
| `src/agents/cr-reviewer.ts` | **New** | Code review quality reviewer agent |
| `src/agents/builtin-agents.ts` | Modify | Register cr-reviewer agent |

## Schema Impact

- `src/schema/review.ts`: No change needed — `phase` field is `z.string()`, accepts `"code_review"`
- `src/schema/review-record.ts`: No change needed — existing schema supports NO_IMPL verdict

## Unchanged Files

- `skills/code-review/SKILL.md` — methodology layer, no change
- `src/agents/reviewer.ts` — remains Phase 2/5/6 only
- `src/schema/sut.ts` — SoftwareRequirement schema unchanged
- `src/schema/defect.ts` — Defect schema unchanged
