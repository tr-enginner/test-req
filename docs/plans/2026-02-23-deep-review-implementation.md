# Per-Requirement Deep Review Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Split Inspector's single-pass code review into N independent per-requirement focused reviews + 1 holistic summary pass, eliminating attention dilution that causes missed defects.

**Architecture:** Inspector gains two modes (`focused` for single-requirement deep review, `summary` for holistic verification). Conductor dispatches N parallel focused reviews then 1 summary review. New `ReviewRecord` schema captures per-requirement structured evidence as JSON.

**Tech Stack:** TypeScript (Bun), Zod schemas, OpenCode plugin SDK, Markdown skills

**Design doc:** `docs/plans/2026-02-23-deep-review-per-requirement-design.md`

---

### Task 1: Add ReviewRecord Schema

**Files:**
- Create: `src/schema/review-record.ts`

**Step 1: Create the schema file**

```typescript
import { z } from "zod"
import { Defect } from "./defect"

/** Single atomic sub-item verification record */
export const SubItemRecord = z.object({
  id: z.string(),
  assertion: z.string(),
  code_locations: z.array(z.string()),
  req_specifies: z.string(),
  code_does: z.string(),
  dimensions: z.record(z.string(), z.string()), // D1..D10 → "MATCH" | "MISMATCH: reason"
  verdict: z.enum(["MATCH", "MISMATCH"]),
  defect_ids: z.array(z.string()).default([]),
})
export type SubItemRecord = z.infer<typeof SubItemRecord>

/** Per-requirement structured review record */
export const ReviewRecord = z.object({
  requirement_id: z.string(),
  requirement_title: z.string(),
  target_architecture: z.string().default("generic"),
  sub_items: z.array(SubItemRecord),
  d9_completeness: z.enum(["COMPLETE", "PARTIAL", "NO_IMPL"]),
  d9_detail: z.string().optional(),
  overall_verdict: z.enum(["CONSISTENT", "INCONSISTENT"]),
  defects: z.array(Defect).default([]),
})
export type ReviewRecord = z.infer<typeof ReviewRecord>
```

**Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS (no errors related to review-record.ts)

**Step 3: Commit**

```
feat(schema): add ReviewRecord schema for per-requirement review evidence
```

---

### Task 2: Add Review Records Constants and Directory

**Files:**
- Modify: `src/shared/constants.ts:49-76` (add REVIEW_RECORDS_DIR and ARTIFACT_PATHS entry)
- Modify: `src/shared/data-store.ts:126-143` (add review-records to ensureMatrixDirs)

**Step 1: Add REVIEW_RECORDS_DIR to constants.ts**

After line 57 (`export const PREPROCESSED_DIR = ...`), add:

```typescript
export const REVIEW_RECORDS_DIR = `${DATA_DIR}/review-records`
```

In the `ARTIFACT_PATHS` object (after line 75 `COMPILATION_ENV`), add:

```typescript
REVIEW_RECORDS: `${DATA_DIR}/review-records`,
```

**Step 2: Add review-records to ensureMatrixDirs in data-store.ts**

In the `dirs` array inside `ensureMatrixDirs` (line 127-136), add `".matrix/data/review-records"` after `".matrix/data/reviews"`:

```typescript
const dirs = [
    ".matrix/data/reviews",
    ".matrix/data/review-records",  // <-- ADD THIS LINE
    ".matrix/reports",
    // ... rest unchanged
]
```

**Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

**Step 4: Commit**

```
feat(constants): add review-records artifact path and directory
```

---

### Task 3: Rewrite Inspector Agent with Dual-Mode Prompt

**Files:**
- Modify: `src/agents/inspector.ts` (complete rewrite of INSPECTOR_SYSTEM_PROMPT)

This is the largest change. The system prompt becomes mode-aware: it detects `review_mode=focused` or `review_mode=summary` from the task delegation prompt, and follows the appropriate workflow.

**Step 1: Rewrite the Inspector system prompt**

Replace the entire `INSPECTOR_SYSTEM_PROMPT` string (lines 32-123) with the new dual-mode prompt. The prompt structure:

```
<role>
  Same role description, updated to mention dual modes.
</role>

<mode_detection>
  Detect mode from delegation prompt:
  - "review_mode=focused" + "target_requirement_id=XXX" → focused mode
  - "review_mode=summary" → summary mode
  - Neither → legacy mode (backward compat, same as current single-pass)
</mode_detection>

<focused_mode>
  Step 1: Load skill + context (same as before)
  Step 2: Extract the SINGLE target requirement
  Step 3: Read ALL implementing code
  Step 4: Decompose into atomic sub-items
  Step 5: For each sub-item: D1-D10 verification
  Step 6: Write ReviewRecord JSON to .matrix/data/review-records/<req_id>.json

  Output rules:
  - JSON only, no markdown narrative
  - Only include checked dimensions (omit N/A)
  - MATCH dimensions: just "MATCH" (no elaboration)
  - MISMATCH dimensions: "MISMATCH: <concise explanation>"
  - Defects embedded in the ReviewRecord JSON
  - Defect IDs use prefix DEF-CR-F<NNN> (temporary, reassigned by summary)
</focused_mode>

<summary_mode>
  Step 1: Load skill + context
  Step 2: Read ALL .matrix/data/review-records/*.json
  Step 3: Completeness verification
    - Count records vs requirements with linked_functions
    - Verify MISMATCH→Defect mapping
    - Flag gaps
  Step 4: Runtime safety defect analysis (cross-function)
    - Buffer overflow, integer overflow, division by zero
    - Interrupt/concurrency
    - Resource/state machine
  Step 5: Cross-requirement consistency
    - Same variable in multiple requirements
    - ISR/main shared state
  Step 6: Merge and output
    - Collect all defects, reassign sequential IDs DEF-CR-001..
    - Write .matrix/data/defects.json (append, preserve other sources)
    - Generate .matrix/reports/code-review.md
</summary_mode>

<legacy_mode>
  (Current single-pass behavior, unchanged, for backward compatibility)
</legacy_mode>

<output_schema>
  Focused mode: ReviewRecord JSON at .matrix/data/review-records/<req_id>.json
  Summary mode: DefectDatabase at .matrix/data/defects.json + report at .matrix/reports/code-review.md
  Legacy mode: Same as current (defects.json only)
</output_schema>

<quality_rules>
  Same rules as current, plus:
  - FOCUSED MODE DEPTH: In focused mode, you have ONE requirement. There is no "next requirement" to rush to.
    Decompose ALL sub-items. Check ALL applicable dimensions. This is your ONLY job.
  - SUMMARY MODE COMPLETENESS: In summary mode, if a review record is missing for any requirement,
    flag it explicitly. Do not silently skip.
</quality_rules>
```

Keep the `createInspectorAgent` function, metadata, tools, and permissions unchanged.

**Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

**Step 3: Commit**

```
feat(inspector): dual-mode prompt — focused per-requirement + summary holistic review
```

---

### Task 4: Update Code-Review Skill with Mode Annotations and Completeness Section

**Files:**
- Modify: `skills/code-review/SKILL.md`

**Step 1: Add mode annotations and new Section 3**

Changes to the skill:

1. After the YAML frontmatter, add a **Mode Applicability** section:

```markdown
## Mode Applicability

This skill is used by the Inspector agent in three modes:

- **Focused mode** (`review_mode=focused`): Use Section 2 (Requirement-Code Consistency) and Section 4 (Defect Recording). Skip Section 1 (Runtime Safety) — it runs in summary mode.
- **Summary mode** (`review_mode=summary`): Use Section 1 (Runtime Safety), Section 3 (Completeness Verification), and Section 4 (Defect Recording). Section 2 results are already available as ReviewRecord JSON files.
- **Legacy mode** (no mode specified): Use all sections as before.
```

2. Add mode tags to existing sections:

   - Section 1 header: `### 1. Runtime Safety Defect Analysis [summary mode, legacy mode]`
   - Section 2 header: `### 2. Requirement-Code Consistency (ALL Requirements) [focused mode, legacy mode]`

3. Update the **Structured Verification Evidence** subsection in Section 2: change the record format from markdown to JSON schema reference:

```markdown
#### Output Format (Focused Mode)

In focused mode, output a single ReviewRecord JSON file to `.matrix/data/review-records/<req_id>.json`:

- `dimensions` map: only include dimensions you actually checked. Use key format `"D1"`, `"D2"`, ..., `"D10"`.
  - `"MATCH"` — no elaboration needed
  - `"MISMATCH: <concise explanation>"` — explain the discrepancy
  - Omit dimensions that are N/A (do not include them in the map)
- `defects` array: embed Defect objects directly. Use temporary IDs `DEF-CR-F001`, `DEF-CR-F002`, etc.
- All other record rules (sub-item decomposition, per-sub-item code location, "Req specifies"/"Code does" formalization, N/A rules, Comment Independence Principle) remain unchanged.

In legacy mode, continue using the markdown verification record format.
```

4. Add **Section 3: Completeness Verification** (NEW) before Section 4 (Defect Recording):

```markdown
### 3. Completeness Verification [summary mode]

After reading all ReviewRecord files from `.matrix/data/review-records/`, perform these checks:

#### 3.1 Record Count Check
- Count requirements with non-empty `linked_functions` in software-analysis.json → expected N
- Count ReviewRecord files in `.matrix/data/review-records/` → actual M
- If M < N: list missing requirement IDs, flag as completeness gap

#### 3.2 Sub-item Coverage Check
For each ReviewRecord:
- Re-read the requirement description + resolved_references
- Verify that the sub_items in the record cover ALL atomic verifiable assertions in the requirement
- If a requirement mentions N conditions/thresholds/states but the record only has M < N sub-items, flag as under-decomposition

#### 3.3 MISMATCH→Defect Mapping Check
For each ReviewRecord:
- Count sub_items with verdict="MISMATCH"
- Count defects in the record's defects array
- If any MISMATCH sub-item has no corresponding defect_id, flag as mapping gap

#### 3.4 Cross-Requirement Consistency Check
- Identify variables/functions referenced by multiple requirements
- Verify that review verdicts for shared code are consistent
- Check: if requirement A says variable X should be initialized to 0, and requirement B says variable X should be initialized to 1 — flag as cross-requirement conflict
```

**Step 2: Commit**

```
feat(skill): add mode annotations and completeness verification section to code-review skill
```

---

### Task 5: Rewrite Conductor Phase 3 Dispatch Logic

**Files:**
- Modify: `src/agents/conductor.ts:79-88` (Phase 3 section in CONDUCTOR_SYSTEM_PROMPT)

**Step 1: Replace Phase 3 section**

Replace the Phase 3 block (lines 79-88 in the conductor prompt) with:

```
## Phase 3: Code Review & Static Analysis
Phase 3 uses a per-requirement deep review architecture to ensure every requirement receives full attention.

### Step 1: Read requirement list
Use \`read\` to load \`.matrix/data/software-analysis.json\`. Identify ALL requirements that have non-empty \`linked_functions\` arrays. Let N = count of such requirements. List them.

### Step 2: Dispatch per-requirement focused reviews
For EACH requirement with linked_functions, dispatch an independent Inspector review:

\`\`\`
task(subagent_type="inspector", prompt="review_mode=focused target_requirement_id=<REQ_ID>
Perform focused deep review of requirement <REQ_ID> (<REQ_TITLE>).
Read .matrix/data/software-analysis.json for requirement context.
Read .matrix/data/compilation-env.json for compilation environment.
Output ReviewRecord JSON to .matrix/data/review-records/<REQ_ID>.json.", run_in_background=true)
\`\`\`

Dispatch ALL N reviews with run_in_background=true so they run in parallel.

### Step 3: Dispatch static analysis (parallel, unchanged)
\`\`\`
task(subagent_type="static-analyzer", prompt="Run static analysis on the source code. Use tools specified in .matrix/config/matrix.jsonc. Output report to .matrix/reports/static-analysis.md. Merge any new defects into .matrix/data/defects.json.", run_in_background=true)
\`\`\`

### Step 4: Wait for completion
Wait for ALL per-requirement focused reviews and static analysis to complete. Verify that .matrix/data/review-records/ contains N JSON files.

### Step 5: Dispatch summary review
After all focused reviews complete, dispatch a holistic summary review:

\`\`\`
task(subagent_type="inspector", prompt="review_mode=summary
Perform holistic code review summary. Read ALL .matrix/data/review-records/*.json files.
Verify completeness (record count, sub-item coverage, MISMATCH→Defect mapping).
Perform runtime safety defect analysis (cross-function buffer overflow, concurrency, etc.).
Check cross-requirement consistency.
Merge all defects with sequential IDs (DEF-CR-001, ...).
Output final defects to .matrix/data/defects.json and report to .matrix/reports/code-review.md.")
\`\`\`

- Gate: Summary review must complete. Both \`.matrix/data/defects.json\` and \`.matrix/reports/code-review.md\` must exist.
```

Also update the delegation_rules section (line 207) to reflect the new Phase 3 pattern:

Change:
```
4. For Phase 3, launch inspector and static-analyzer in PARALLEL (both use run_in_background=true).
```
To:
```
4. For Phase 3, dispatch N per-requirement Inspector focused reviews + static-analyzer in PARALLEL (all use run_in_background=true). After all complete, dispatch one Inspector summary review.
```

**Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

**Step 3: Commit**

```
feat(conductor): Phase 3 per-requirement dispatch with parallel focused reviews + summary
```

---

### Task 6: Build and Verify

**Files:**
- All modified files

**Step 1: Run full typecheck**

Run: `bun run typecheck`
Expected: PASS with no errors

**Step 2: Run build**

Run: `bun run build`
Expected: Build completes, `dist/index.js` produced

**Step 3: Verify ReviewRecord schema is importable**

Run: `bun -e "import { ReviewRecord } from './src/schema/review-record.ts'; console.log(ReviewRecord.shape)"`
Expected: Prints Zod shape object without errors

**Step 4: Commit (if any fixes needed)**

```
chore: fix build issues from deep review restructuring
```

---

### Task 7: Update Design Doc Status

**Files:**
- Modify: `docs/plans/2026-02-23-deep-review-per-requirement-design.md:3`

**Step 1: Change status from Draft to Implemented**

Change line 3 from:
```
**Status**: Draft
```
To:
```
**Status**: Implemented
```

**Step 2: Commit all changes**

```
docs: mark deep review design as implemented
```
