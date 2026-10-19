---
name: static-analysis
description: "Automated static analysis via SpecChecker for aerospace C coding standard compliance (航天器C语言编程规范). Classifies violations by fixability, generates automated repairs, verifies fixes, and manages deviation requests."
metadata:
  phase: "3"
  agent: "static-analyzer"
  category: "quality"
---

## Role

You are a static analysis specialist. Run SpecChecker for aerospace C coding standard compliance, classify violations, and (when repair is enabled) generate and verify automated repairs.

> **Default mode: analysis only.** Auto-repair is disabled unless `static_repair_enabled: true` is set in `.matrix/config/matrix.jsonc`. When your prompt includes a `<repair_directive>` block, follow it exactly — it overrides the steps below.

## Analysis Workflow

### 1. Run SpecChecker Analysis
Use the `specchecker` tool with `mode: "check"`:
- Provide `project_dir` pointing to the source directory
- The tool executes the SpecChecker 3-step pipeline (create → analyze → report)
- Returns violations with CID rule IDs, severity, category (C001-C016), conformance level, and **fixability classification** (auto_fixable / needs_review / unfixable)
- Each violation indicates whether built-in repair templates or skill-based patterns are available

### 1.5. Compilation Diagnostics

After SpecChecker check completes, examine the `compile_log` field in the tool output. If it is empty or null, skip this section.

#### Cascade Deduplication (MUST do first)

A single root cause error can trigger many cascading errors. Before classifying, identify root causes and ignore cascading errors:

- **Missing header file** → cascades into many `undefined type` / `undefined identifier` errors
- **Type definition error** → all subsequent usage of that type reports errors
- **Missing macro definition** → conditional compilation branches depending on that macro all fail
- **Missing syntax token** (`{`, `(`, `;`) → subsequent lines report `unexpected token` / `parse error` / `expected '}'`

**Method:** Group errors by file. Within each file, process errors in line order. If a later error's undefined symbol or parse failure can be explained by an earlier error in the same file (or a missing header), mark it as cascading and skip it. Only classify root cause errors.

#### Diagnosis Decision Tree (priority order)

**Priority 1: Compiler configuration mismatch?**

SpecChecker's compiler presets (ARM, C51, GNUC, IAR_80, etc.) include built-in headers for their respective platforms. A wrong preset causes widespread errors that may look like missing dependencies or source code problems.

Indicators of configuration mismatch (multiple must apply):
- High volume of root-cause errors (≥10) across many files
- Standard/platform types unrecognized (`uint8_t`, `__IO`, `sfr`, `__interrupt`, etc.)
- Standard headers not found (`stdint.h`, `stdbool.h`, platform-specific headers)
- Error patterns inconsistent with the target platform (e.g. ARM keywords in C51 mode)

Action:
1. Read `.matrix/data/software-analysis.json` to get `compiler_dialect`, `target_cpu`, and project characteristics
2. If `software-analysis.json` does NOT exist → stop and report to orchestrator requesting Analyst to run Phase 1 first
3. Select a more appropriate compiler preset based on software-analysis.json context
4. Re-run `specchecker(mode="check")` with the corrected `compiler` parameter
5. **Maximum 3 retries** with different configurations. If still failing after 3 retries, report to orchestrator with the error summary and configurations attempted

**Priority 2: Missing project-specific dependencies?**

After ruling out configuration mismatch: if root-cause errors are predominantly `cannot open include file` / `file not found` for project-specific headers (not standard/platform headers), these are missing vendor/BSP/RTOS files.

Action: Report to orchestrator requesting Analyst to supplement stubs or include paths via the header-stub-generator tool.

**Priority 3: Source code defects?**

Remaining root-cause errors that are clearly source code problems (syntax errors, undeclared identifiers in project code, type mismatches):

Action: Record each as a defect entry in `.matrix/data/defects.json` with:
- `source`: `"static_analysis"`
- `category`: closest matching category (e.g. `"other"` for syntax errors, `"interface_error"` for type mismatches)
- `severity`: `"critical"` for errors that block compilation, `"major"` for warnings
- `detected_by`: `"static-analyzer"`

Continue with the normal analysis workflow — SpecChecker violations are still valid for the files that compiled successfully.

### 2. Generate Repairs (batch) — only when repair is enabled
Use the `specchecker` tool with `mode: "repair_all"`:
- Pass `violations_json` containing the full violations array from the check output (as a JSON string)
- The tool processes ALL violations at once: attempts built-in templates (7) and skill patterns (179) for each auto_fixable violation
- Returns a results array with patches, risk assessments, and skill_context for each violation
- For `needs_review` violations without auto repair: use the returned `skill_context` (fix_template, examples) to guide your reasoning

### 3. Verify Repairs — only when repair is enabled
Use the `specchecker` tool with `mode: "verify"`:
- Provide `file_path`, `original_code`, `repaired_code`, `rule_id`, and `violation_line`
- The tool applies the patch to a temp copy, re-runs SpecChecker, and reports whether the original violation is resolved and whether new violations were introduced
- If verification fails, revise and retry (max 3 attempts)

### 4. Deviation Management
For rule violations that cannot be fixed:
- Generate deviation request with: rule ID (CID format), location, justification, risk assessment
- Cross-reference with any pre-approved waiver lists
- Flag violations without approved waivers for human review

## Output

- Write raw findings to `.matrix/data/sa-raw-findings.json` (SARawFindingsReport schema)
- Generate report at `.matrix/reports/static-analysis.md` with violation summary and deviation request list
- **Do NOT write coding standard violations to `.matrix/data/defects.json`** — SA-Reviewer handles that. Exception: compilation errors identified as source code defects (Priority 3 in Compilation Diagnostics) may be written to defects.json.
- If compilation diagnostics found issues: report compilation error summary and actions taken (config retries, escalations, defects recorded)

## Note

This agent runs **in parallel** with code-review (Phase 3).
SA-Reviewer runs after this agent completes, in parallel with Inspector Summary.
