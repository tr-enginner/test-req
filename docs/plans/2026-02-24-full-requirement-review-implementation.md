# Full-Requirement Code Review + CR-Reviewer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Inspector review ALL requirements (not just those with linked_functions) and add a new cr-reviewer agent as a Phase 3 quality gate.

**Architecture:** Three changes: (1) Inspector focused mode gets a Code Discovery step for requirements without linked_functions, (2) new cr-reviewer agent validates Inspector output quality, (3) Conductor Phase 3 dispatches all requirements and adds cr-reviewer gate.

**Tech Stack:** TypeScript, Zod schemas, OpenCode plugin SDK

---

### Task 1: Create cr-reviewer Agent

**Files:**
- Create: `src/agents/cr-reviewer.ts`

**Step 1: Create the cr-reviewer agent file**

Write `src/agents/cr-reviewer.ts` following the exact pattern of `src/agents/isr-reviewer.ts`:

```typescript
import type { AgentConfig } from "@opencode-ai/sdk"
import type { AgentMode, AgentPromptMetadata } from "./types"

const MODE: AgentMode = "subagent"

export const CR_REVIEWER_PROMPT_METADATA: AgentPromptMetadata = {
  category: "quality",
  cost: "EXPENSIVE",
  triggers: [
    {
      domain: "Code review quality verification",
      trigger: "Phase 3 code review complete — verify Inspector output quality before advancing to Phase 4",
    },
    {
      domain: "Review record completeness",
      trigger: "Verify all requirements have review records and defect mappings are complete",
    },
  ],
  useWhen: [
    "Phase 3: Code Review & Static Analysis — after Inspector summary completes",
    "Code review output quality gate — verify review-records, defects, and report",
    "Requirement coverage verification for code review artifacts",
  ],
  avoidWhen: [
    "Inspector has not completed summary mode yet",
    "Test requirement / environment / test case review (use reviewer instead)",
    "Code review itself (use inspector instead)",
  ],
}

const CR_REVIEWER_SYSTEM_PROMPT = `You are the CR-Reviewer, an independent quality gate agent that verifies the completeness and quality of code review outputs produced by the Inspector agent.

<role>
Your job is to review the Inspector's code review artifacts — per-requirement ReviewRecords, the merged DefectDatabase, and the code-review report — and issue a PASS or REVISE verdict. You are NOT performing code review yourself. You are auditing whether the Inspector's code review was thorough, complete, and properly documented.

You are strict but fair: you block only on genuine quality gaps, not stylistic preferences about how the Inspector chose to describe things.
</role>

<input_artifacts>
- \`.matrix/data/review-records/*.json\` — per-requirement ReviewRecord files from Inspector focused mode
- \`.matrix/data/defects.json\` — merged defect database (contains defects from all sources)
- \`.matrix/reports/code-review.md\` — summary report from Inspector summary mode
- \`.matrix/data/software-analysis.json\` — source requirements and traceability (for cross-checking)
</input_artifacts>

<review_process>
### Step 1: Load Context
- Use \`read\` to load \`.matrix/data/software-analysis.json\`. Extract the full requirements list.
- Use \`glob\` to find all \`.matrix/data/review-records/*.json\` files.
- Use \`read\` to load \`.matrix/data/defects.json\`.
- Use \`read\` to load \`.matrix/reports/code-review.md\`.

### Step 2: Dimension 1 — Requirement Coverage Completeness
- Count total requirements in \`software-analysis.json\`.
- Count review-record files in \`.matrix/data/review-records/\`.
- If any requirement has no corresponding review-record file, record a blocking issue listing the missing requirement IDs.
- Formula: coverage = review_record_count / total_requirements * 100%.
- Blocking if coverage < 100%.

### Step 3: Dimension 2 — Sub-Item Coverage
- For each ReviewRecord, use \`read\` to load it.
- Cross-reference the requirement's \`description\` and \`acceptance_criteria\` from software-analysis.json.
- Check whether the sub_items reasonably decompose the requirement into individually verifiable assertions.
- Flag any ReviewRecord where obvious verifiable clauses in the requirement text have no corresponding sub-item.
- Spot-check at least 5 ReviewRecords (or all if fewer than 5). Blocking if a requirement with 4+ verifiable clauses has only 1-2 sub-items.

### Step 4: Dimension 3 — MISMATCH→Defect Mapping
- For each ReviewRecord, check every sub-item with \`verdict: "MISMATCH"\`.
- Verify that \`defect_ids\` is non-empty for each MISMATCH sub-item.
- Verify that each referenced defect ID exists in \`defects.json\` with \`source: "code_review"\`.
- Blocking if any MISMATCH sub-item has empty defect_ids or references a non-existent defect.

### Step 5: Dimension 4 — Defect Description Quality
- For each defect with \`source: "code_review"\` in defects.json:
  - Check that \`description\` contains BOTH what is wrong AND what correct behavior should be.
  - Check that \`location.file_path\` is non-empty and \`location.line_start\` is a positive number.
  - Check that \`title\` is specific (not generic like "code issue" or "problem found").
- Major issue if >20% of defects have vague descriptions or missing locations.

### Step 6: Dimension 5 — Dimension Coverage Reasonableness
- Spot-check at least 5 ReviewRecords:
  - D9 (Completeness) must appear in every record's sub_items dimensions. Flag if missing.
  - For requirements that reference hardware (check requirement description for keywords: register, peripheral, interrupt, GPIO, SPI, UART, timer, ADC, DMA, volatile, SFR), D10 must appear. Flag if missing.
- Major issue if mandatory dimensions are systematically absent.

### Step 7: Determine Verdict
- **PASS**: Zero blocking issues. Major/minor issues may exist but do not prevent proceeding.
- **REVISE**: One or more blocking issues exist.

### Step 8: Output ReviewRecord
Assemble a ReviewRecord JSON and use the \`write\` tool to output to \`.matrix/data/reviews/cr-review.json\`:

\`\`\`json
{
  "id": "REV-CR-001",
  "phase": "code_review",
  "target_artifact": ".matrix/data/review-records/",
  "verdict": "PASS or REVISE",
  "issues": [
    {
      "severity": "blocking | major | minor",
      "description": "...",
      "location": "optional — specific file or record",
      "suggestion": "concrete fix action"
    }
  ],
  "reviewer": "cr-reviewer",
  "review_date": "ISO date"
}
\`\`\`
</review_process>

<quality_rules>
- MAXIMUM 5 ISSUES per review. Prioritize by impact, report only the top 5.
- Be QUANTITATIVE: "3 of 25 requirements have no review record" not "some requirements lack reviews".
- Be SPECIFIC: "ReviewRecord for REQ-007 has 1 sub-item but the requirement has 4 distinct verifiable clauses" not "some records have too few sub-items".
- Be ACTIONABLE: every issue must include a concrete suggestion for how to fix it.
- INDEPENDENT PERSPECTIVE: You are NOT the Inspector. Do not re-do the code review. Only verify that the Inspector's work is complete and well-documented.
- Do NOT flag stylistic choices in defect descriptions as long as they convey what is wrong and what should be correct.
- Output ONLY valid JSON to the review file. No markdown in the JSON file.
</quality_rules>

<artifact_paths>
- Review output: .matrix/data/reviews/cr-review.json
</artifact_paths>`

export function createCrReviewerAgent(model?: string): AgentConfig {
  return {
    description:
      "Code review quality gate — independently verifies Inspector output: requirement coverage completeness, sub-item decomposition, MISMATCH-to-defect mapping, defect description quality, and dimension coverage. Outputs PASS/REVISE verdict. (CR-Reviewer - Matrix)",
    mode: MODE,
    ...(model ? { model } : {}),
    temperature: 0.1,
    prompt: CR_REVIEWER_SYSTEM_PROMPT,
    tools: {
      read: true,
      glob: true,
      grep: true,
    },
    color: "#8E44AD",
    permission: {
      edit: "allow",
      bash: "deny",
    } as AgentConfig["permission"],
  }
}
createCrReviewerAgent.mode = MODE
```

**Step 2: Verify the file compiles**

Run: `bun run typecheck`
Expected: PASS (no type errors)

**Step 3: Commit**

```bash
git add src/agents/cr-reviewer.ts
git commit -m "feat: add cr-reviewer agent for Phase 3 code review quality gate"
```

---

### Task 2: Register cr-reviewer in builtin-agents

**Files:**
- Modify: `src/agents/builtin-agents.ts:1-78`

**Step 1: Add import and registration**

Add import at line 19 (after isr-reviewer import):
```typescript
import { createCrReviewerAgent, CR_REVIEWER_PROMPT_METADATA as CR_REVIEWER_META } from "./cr-reviewer"
```

Add `"cr-reviewer"` to `BuiltinAgentName` union type (after `"isr-reviewer"`):
```typescript
  | "cr-reviewer"
```

Add to `agentFactories` object (after `"isr-reviewer"` entry):
```typescript
  "cr-reviewer": createCrReviewerAgent as AgentFactory,
```

Add to `agentMetadata` object (after `"isr-reviewer"` entry):
```typescript
  "cr-reviewer": CR_REVIEWER_META,
```

**Step 2: Verify the file compiles**

Run: `bun run typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add src/agents/builtin-agents.ts
git commit -m "feat: register cr-reviewer agent in builtin-agents"
```

---

### Task 3: Add Code Discovery to Inspector Focused Mode

**Files:**
- Modify: `src/agents/inspector.ts:62-147` (focused_mode section)

**Step 1: Insert Step 2.5 between Step 2 and Step 3**

In the `<focused_mode>` section, after Step 2 (Extract Target Requirement, ending around line 76) and before Step 3 (Read Implementing Code, starting around line 78), insert:

```
### Step 2.5: Code Discovery (only when has_linked_functions=false)
If the delegation prompt contains \`has_linked_functions=false\`, the traceability matrix did NOT link any functions to this requirement. You must actively search for implementing code:

1. Extract search keywords from the requirement's \`description\`, \`acceptance_criteria\`, and \`resolved_references[].resolved_content\`:
   - Function or algorithm names (e.g., "MPPT", "PID", "CRC", "checksum")
   - Variable or register names (e.g., "bus_voltage", "UART1", "ADC_DR")
   - Action-noun phrases (e.g., "temperature acquisition", "voltage protection", "state machine")
   - Domain-specific terms that would appear in code identifiers

2. Use \`grep\` to search all C/C++ source files for each keyword. For Chinese requirement terms, also search for plausible English translations and abbreviations that a developer might use as identifiers.

3. For each grep hit, use \`read\` to examine the surrounding code context (±30 lines). Determine whether the code genuinely implements or relates to this requirement.

4. Two outcomes:
   - **Implementing code found**: Record discovered functions and file:line-range in a working list. Proceed to Step 3 using these discovered code locations instead of linked_functions.
   - **No implementing code found after exhaustive search**: Skip Steps 3-5. Set \`d9_completeness: "NO_IMPL"\`, \`d9_detail\` describing the search keywords used and files scanned. Record a defect:
     \`\`\`
     {
       "id": "DEF-CR-F001",
       "source": "code_review",
       "severity": "major",
       "category": "requirement_mismatch",
       "location": { "file_path": "N/A", "line_start": 0 },
       "title": "Requirement has no implementing code",
       "description": "Requirement <REQ_ID> (<title>) has no implementing code found in the codebase. Traceability matrix had no linked functions, and active code search using keywords [<keywords>] across all source files found no related implementation. This may indicate: (1) the requirement is implemented under unexpected identifiers, (2) the implementation is missing, or (3) the requirement is a non-functional constraint that does not map directly to code.",
       "related_requirement_ids": ["<REQ_ID>"],
       "status": "open",
       "detected_by": "inspector",
       "detected_date": "<ISO date>"
     }
     \`\`\`

If \`has_linked_functions=false\` is NOT present in the prompt, skip this step entirely (the requirement has linked functions and proceeds normally to Step 3).
```

**Step 2: Update Step 3 to handle discovered code**

Modify Step 3's first sentence from:
```
- For each function in the requirement's \`linked_functions\`, use \`read\` to examine the full source code
```
to:
```
- For each function in the requirement's \`linked_functions\` (or discovered code locations from Step 2.5), use \`read\` to examine the full source code
```

**Step 3: Add `has_linked_functions` to mode_detection section**

In the `<mode_detection>` section (lines 43-49), update item 1 to mention the optional marker:
```
1. If the prompt contains \`review_mode=focused\` AND \`target_requirement_id=<ID>\` → **focused mode**. Extract the requirement ID. Also check for optional \`has_linked_functions=false\` marker — if present, you must execute Step 2.5 (Code Discovery) before Step 3.
```

**Step 4: Verify the file compiles**

Run: `bun run typecheck`
Expected: PASS

**Step 5: Commit**

```bash
git add src/agents/inspector.ts
git commit -m "feat: add Code Discovery step to Inspector focused mode for unlinked requirements"
```

---

### Task 4: Update Conductor Phase 3 — All-Requirement Dispatch

**Files:**
- Modify: `src/agents/conductor.ts:92-123` (Phase 3 section)

**Step 1: Rewrite Phase 3 Steps 1-5 and add Steps 6-8**

Replace the entire Phase 3 section (from `## Phase 3:` through Step 5) with:

```
## Phase 3: Code Review & Static Analysis
Phase 3 uses a per-requirement deep review architecture. EVERY requirement gets an independent focused review at maximum depth, regardless of whether the traceability matrix links it to functions. After all focused reviews complete, a holistic summary review runs, followed by an independent quality gate review.
- Input: Source code, software-analysis.json, compilation-env.json, coding standard from config
- Output: \`.matrix/data/review-records/*.json\` (per-requirement), \`.matrix/reports/code-review.md\`, \`.matrix/reports/static-analysis.md\`, \`.matrix/data/defects.json\`
- Gate: CR-Reviewer must approve. Both \`.matrix/data/defects.json\` and \`.matrix/reports/code-review.md\` must exist.

### Step 1: Read requirement list
Use \`read\` to load \`.matrix/data/software-analysis.json\`. List ALL requirements. Let N = total requirement count.

Also load the \`traceability_matrix\` from the report. Build a set of requirement IDs that have non-empty \`function_ids\`. Split requirements into two groups:
- **has_linked**: requirements whose ID appears in traceability_matrix with non-empty function_ids
- **no_linked**: requirements whose ID does NOT appear in traceability_matrix, or appears with empty function_ids

Report: "Phase 3: Dispatching N focused reviews (X with linked functions, Y without)."

### Step 2: Dispatch per-requirement focused reviews
For EACH requirement, dispatch an independent Inspector review:

For requirements in the **has_linked** group (standard prompt, unchanged):
\`\`\`
task(subagent_type="inspector", prompt="review_mode=focused target_requirement_id=<REQ_ID> Perform focused deep review of requirement <REQ_ID> (<REQ_TITLE>). Read .matrix/data/software-analysis.json for requirement context. Read .matrix/data/compilation-env.json for compilation environment. Output ReviewRecord JSON to .matrix/data/review-records/<REQ_ID>.json.", run_in_background=true)
\`\`\`

For requirements in the **no_linked** group (with has_linked_functions=false marker):
\`\`\`
task(subagent_type="inspector", prompt="review_mode=focused target_requirement_id=<REQ_ID> has_linked_functions=false Perform focused deep review of requirement <REQ_ID> (<REQ_TITLE>). This requirement has no linked functions in the traceability matrix — you must execute Code Discovery (Step 2.5) to search for implementing code before reviewing. Read .matrix/data/software-analysis.json for requirement context. Read .matrix/data/compilation-env.json for compilation environment. Output ReviewRecord JSON to .matrix/data/review-records/<REQ_ID>.json.", run_in_background=true)
\`\`\`

Dispatch ALL N reviews with run_in_background=true so they run in parallel.

### Step 3: Dispatch static analysis (parallel, unchanged)
\`\`\`
task(subagent_type="static-analyzer", prompt="Run static analysis on the source code. Use tools specified in .matrix/config/matrix.jsonc. Output report to .matrix/reports/static-analysis.md. Merge any new defects into .matrix/data/defects.json.", run_in_background=true)
\`\`\`

### Step 4: Wait for completion
Wait for ALL per-requirement focused reviews and static analysis to complete. Verify that \`.matrix/data/review-records/\` contains N JSON files (one per requirement).

### Step 5: Dispatch summary review
After all focused reviews complete, dispatch a holistic summary review:

\`\`\`
task(subagent_type="inspector", prompt="review_mode=summary Perform holistic code review summary. Read ALL .matrix/data/review-records/*.json files. Verify completeness (record count, sub-item coverage, MISMATCH-to-Defect mapping). Perform runtime safety defect analysis (cross-function buffer overflow, concurrency, etc.). Check cross-requirement consistency. Merge all defects with sequential IDs (DEF-CR-001, ...). Output final defects to .matrix/data/defects.json and report to .matrix/reports/code-review.md.")
\`\`\`

### Step 6: Dispatch CR-Reviewer quality gate
After Inspector summary completes, dispatch the independent quality gate review:

\`\`\`
task(subagent_type="cr-reviewer", prompt="Review the code review artifacts for quality and completeness. Verify: (1) all requirements have review records, (2) sub-item decomposition covers requirement clauses, (3) MISMATCH verdicts map to defects, (4) defect descriptions are complete, (5) review dimensions are adequate. Read .matrix/data/software-analysis.json for the full requirement list. Output review to .matrix/data/reviews/cr-review.json.")
\`\`\`

### Step 7: Handle CR-Reviewer verdict
Read \`.matrix/data/reviews/cr-review.json\`.

If verdict is **PASS**: Advance to Phase 4.

If verdict is **REVISE**:
1. Extract the blocking issues from the review.
2. Determine which requirements need re-review based on the issues:
   - Missing review records → re-dispatch focused reviews for those requirements
   - Sub-item coverage gaps → re-dispatch focused reviews for those requirements
   - MISMATCH→Defect mapping gaps → re-dispatch summary review with fix instructions
   - Defect description quality → re-dispatch summary review with fix instructions
3. After corrections, re-dispatch cr-reviewer.
4. Maximum 3 review cycles. After 3 failures:
\`\`\`
task(subagent_type="oracle", prompt="Escalation: Phase 3 code review has failed CR-Reviewer quality gate 3 times. Review feedback: [summary of issues]. Please analyze the root cause and recommend a resolution strategy.")
\`\`\`
```

**Step 2: Update delegation_rules item 4**

In `<delegation_rules>` section (line ~241), update rule 4 from:
```
4. For Phase 3, dispatch N per-requirement Inspector focused reviews + static-analyzer in PARALLEL (all use run_in_background=true). After all complete, dispatch one Inspector summary review.
```
to:
```
4. For Phase 3, dispatch ALL requirements as per-requirement Inspector focused reviews + static-analyzer in PARALLEL (all use run_in_background=true). Requirements without linked_functions get has_linked_functions=false marker. After all complete, dispatch one Inspector summary review, then dispatch cr-reviewer quality gate. Handle REVISE verdict with up to 3 retry cycles.
```

**Step 3: Update review_protocol section**

In `<review_protocol>` section (line ~185), update the first line from:
```
Phases 2, 5, and 6 require review approval before the workflow can advance.
```
to:
```
Phases 2, 3, 5, and 6 require review approval before the workflow can advance.
Phase 3 uses the cr-reviewer agent (not reviewer) for its quality gate.
```

**Step 4: Verify the file compiles**

Run: `bun run typecheck`
Expected: PASS

**Step 5: Commit**

```bash
git add src/agents/conductor.ts
git commit -m "feat: Phase 3 all-requirement dispatch + cr-reviewer quality gate"
```

---

### Task 5: Final Typecheck and Build

**Files:**
- None (verification only)

**Step 1: Run typecheck**

Run: `bun run typecheck`
Expected: PASS with zero errors

**Step 2: Run build**

Run: `bun run build`
Expected: Build succeeds, dist/index.js produced

**Step 3: Run tests (if any)**

Run: `bun test`
Expected: All tests pass

**Step 4: Final commit if any fixes were needed**

Only if Steps 1-3 required fixes:
```bash
git add -A
git commit -m "fix: resolve build/test issues from full-requirement-review changes"
```
