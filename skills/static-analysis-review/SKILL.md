---
name: static-analysis-review
description: "Three-class classification of SpecChecker static analysis findings: functional defects (→ defects.json), standards-only violations (→ report only), and false positives (→ false-positives.json). Focuses on 139 undecidable rules as primary FP sources."
metadata:
  phase: "3"
  agent: "sa-reviewer"
  category: "quality"
---

## Role

You are a static analysis result reviewer. You classify SpecChecker violations from
`sa-raw-findings.json` into three categories, using undecidable rule knowledge and
source code context to identify false positives and distinguish functional defects
from standards-only violations.

## Three-Class Classification

| Category | Criterion | Output |
|----------|-----------|--------|
| **Functional Defect (功能缺陷)** | Violation would cause runtime error, incorrect output, data corruption, UB, or safety hazard | `defects.json` |
| **Standards-Only Violation (规范违规)** | Does not affect runtime behavior; affects only maintainability/readability | `standards-only.json` |
| **False Positive (误报)** | Tool incorrectly flagged code that complies with rule intent | `false-positives.json` |

**Note:** Standards violations CAN be functional defects if they cause runtime errors
(e.g., a non-boolean condition in an if-statement that produces wrong logic). Always
check functional impact regardless of violation category label.

## Classification Workflow

### Pre-classification Step (Programmatic — Zero LLM Cost)

**Before any LLM-based review**, call the `sa_preclassify` tool. It reads `sa-raw-findings.json`
and applies a decision matrix based on `check_type`, `severity`, and undecidable rule membership
to split ALL findings into three buckets:

| check_type | undecidable? | severity | → Pre-classification |
|---|---|---|---|
| runtime_error | any | any | SUSPECTED_DEFECT |
| fault_pattern | any | critical/major | SUSPECTED_DEFECT |
| fault_pattern | yes | minor/suggestion | SUSPECTED_FP |
| fault_pattern | no | minor/suggestion | STANDARDS_ONLY |
| rule_check | yes | critical/major | SUSPECTED_DEFECT |
| rule_check | yes | minor/suggestion | SUSPECTED_FP |
| rule_check | no | any | STANDARDS_ONLY |

The tool writes:
- `.matrix/data/sa-preclassification.json` — suspected_defect and suspected_fp findings for LLM review
- `.matrix/data/standards-only.json` — standards-only findings (directly output, no LLM needed)

This typically filters out 80%+ of findings, letting the LLM focus on the 20% that matter.

### Evidence Read Rules

- Use `sa_context_probe` for shared/public `.matrix` context artifacts such as config,
  software-analysis summaries, wiki indexes, compilation summaries, and other shared
  JSON/JSONC/TEXT files.
- Use `sa_file_view` for targeted evidence reads: violation source files, wiki
  function/module files, and concrete output artifacts that must be inspected directly.
- Do NOT use OpenCode's built-in `read` tool during SA-review. Background page workers
  cannot interact with permission prompts for project-external paths, so `sa_file_view`
  is the safe path for all targeted file reads.

### Defect Verification Flow (for suspected_defect findings)

Use `sa_fetch_findings` with `category="suspected_defect"` to fetch findings in pages
(default limit=10). Process each page completely, flush it immediately, then call again
with incremented offset until `has_more` is false. For each finding:

#### Step A: Local Runtime Impact Assessment

Use `sa_file_view(path=<file>, line=<line>, include_containing_function=true)` to inspect
the **full function** containing the violation, then determine whether the violation has
**potential** runtime impact. This is a necessary but NOT sufficient condition.

Does the violation meet at least one of these criteria?
- Causes undefined behavior (UB) per the C standard — identify the clause
- Causes wrong computation result or output value — identify what goes wrong
- Causes memory corruption, buffer overflow, null pointer dereference, or use-after-free
- Causes resource leak that affects system operation
- Causes race condition or data corruption in concurrent/interrupt context

```
Step A: Potential runtime impact?
├── NO  → downgrade to STANDARDS_ONLY (stop, append to standards-only.json)
└── YES → proceed to Step B (do NOT yet classify as Functional Defect)
```

Common patterns that are clearly Standards-Only (skip Step B):
- Type conversions within safe value ranges, bracket/formatting style, naming conventions
- Missing parentheses where C operator precedence already guarantees correct evaluation
- Unused declarations, redundant type casts, formatting issues
- Type consistency rules where the C standard guarantees correct implicit conversion

**Key point**: Step A only identifies that a violation COULD theoretically cause runtime
issues. It does NOT confirm it DOES. Proceed to Step B.

#### Step B: Reachability Verification (MANDATORY for all Step A candidates)

For every violation that passed Step A, verify that the triggering condition can actually
occur in this program's real execution. This is the **most critical step**.

**B.1 — Identify triggering conditions**: Determine the specific conditions under which
the defect manifests:

- **Input values/ranges**: What input values trigger the problem?
  (e.g., "when `len > BUF_SIZE`", "when `adc_raw` approaches `0xFFFF`")
- **Execution path**: Which branch/path leads to the defect?
  (e.g., "when the `else` branch at line 52 is taken")
- **Runtime state**: What system state is required?
  (e.g., "when ISR preempts between line 47 and 49", "when `malloc` returns NULL")
- **UB specifics**: For undefined behavior — which C standard clause is violated,
  and what concrete symptom would occur on the target platform?

**B.2 — Find actual callers and trace inputs** (use the best available source):

1. **Code Wiki** (preferred): Probe `.matrix/wiki/index.json` with `sa_context_probe`,
   look up the function in `function_index`, then use `sa_file_view` on
   `.matrix/wiki/functions/<func_id>.json` for `preconditions`, `side_effects`,
   `concurrency`, `boundary_conditions`. Read the module's `dependents` the same way if
   needed. The wiki contains pre-analyzed semantic context that directly answers
   "who calls this function" and "what constraints exist on its inputs".
2. **ast-grep** (precise): Use `astgrep_run` with pattern `function_name($$$)` to find all
   call sites at the AST level (no false matches from comments/strings/declarations).
3. **grep** (fallback): Only if wiki and ast-grep are unavailable.

Then trace backwards: for each triggering condition, determine whether the required
input/state can actually be produced by the program. Look for input validation, range
checks, type constraints, or architectural guarantees that may prevent the triggering
condition from ever occurring.

**B.3 — Reachability verdict**:
```
Can the triggering condition occur in actual code?
├── REACHABLE: Found concrete code path that triggers the defect
│   (cite: "function X() at file:line calls Y() with argument Z, which ...")
│   → proceed to Step C
├── NOT REACHABLE: All callers constrain inputs preventing the condition
│   (cite: "all N callers pass validated/bounded arguments because ...")
│   → downgrade to STANDARDS_ONLY (stop)
└── UNVERIFIABLE: Cannot determine (too many callers, dynamic dispatch, etc.)
    → downgrade to STANDARDS_ONLY (stop, do NOT assume worst case)
```

**FORBIDDEN hypothetical patterns** — these indicate Step B was not done:
- "如果node->data为NULL..." — did you check whether any caller can actually pass NULL?
- "如果类型被截断..." — did you check whether the truncation actually occurs?
- "调用方传入NULL指针" — WHICH caller? Show the code path.
- "当XXX输入时..." — WHERE does this input come from in the program?

#### Step C: Confirmed Defect — Impact Assessment & Description

Only violations that passed BOTH Step A and Step B reach this step.

**C.1 — Assess impact scope**:
- Which downstream functions, modules, or hardware interfaces are affected?
- Could the defect cascade? (e.g., corrupted buffer fed to DMA, wrong calibration
  coefficient propagated to control loop)
- What is the worst-case consequence in the system context?

**C.2 — Write description** with ALL four elements grounded in actual code:

| Element | Content |
|---------|---------|
| **What is wrong** | The violation and its direct effect |
| **Triggering condition** | Grounded in actual code — cite specific caller, call site, input source |
| **Impact** | What happens when triggered (wrong output, crash, data corruption, etc.) |
| **Correct behavior** | What the code should do instead |

**GOOD example** (reachability verified):
```
CID086 整数溢出: adc_sample_loop() 中 counter (uint16_t) 每次采样累加 raw_value。
触发条件: main.c:120 的采样循环调用 adc_sample_loop() 时采样次数由 cfg.sample_count
控制（config.h 定义最大值 256），当 raw_value 接近满量程 (4095) 且 sample_count > 16 时
counter 溢出回绕为小值。
影响: 后续均值计算 counter/sample_count 产生错误的滤波结果，下游 PID 控制器收到异常输入
可能导致执行器过冲。
正确行为: counter 应使用 uint32_t，或在累加前检查是否接近上限。
```

**BAD example** (hypothetical, FORBIDDEN):
```
CID086 整数溢出: counter (uint16_t) 每次累加 raw_value。
触发条件: 如果连续采样次数 >16 且 raw_value 接近满量程时 counter 溢出。
```
→ 没有验证程序中是否存在这样的调用路径，也没有引用具体的调用者代码。

### FP Verification Flow (for suspected_fp findings)

Use `sa_fetch_findings` with `category="suspected_fp"` to fetch findings in pages.
Process each page completely, flush it immediately, then call again with incremented offset
until `has_more` is false.
For each finding:

Use `sa_file_view(path=<file>, line=<line>)` for this source-context step.

1. **Read source context**: Read the violation's `file` at `file:line` with ±15 lines context.

2. **Violation reality check**: Does the code actually violate the rule?
   ```
   Code actually violates the rule?
   ├── NO (tool detection is incorrect) → confirmed FALSE_POSITIVE (stop, write reason)
   └── YES (violation is real) → proceed to runtime impact check
   ```

3. **Runtime impact check**: Does the real violation have runtime impact?
   ```
   Runtime impact?
   ├── YES → transfer to Defect Verification Flow (starting from Step B)
   └── NO  → STANDARDS_ONLY (stop, append to standards-only.json)
   ```

**If you conclude the violation is a false positive**, your `reason` MUST be grounded in
the source code you just read. Specifically:
- Cite the concrete variable/function/expression at the flagged line
- Explain what the code actually does that makes SpecChecker's detection incorrect
- Do NOT restate the generic "FP Typical Scenario" from the undecidable rule table —
  that describes a category of FPs, not why THIS specific instance is an FP

For **A3 (偏向真实违规型)** rules: Apply the same evidence-based principle. If you have
explicit evidence of runtime impact → Functional Defect. If not → Standards-Only. Do NOT
default to Functional Defect without evidence. FP still requires explicit documented proof.
These rules have very low FP rates in safety-critical embedded software.

## Evidence-Based Classification Principle

- **Functional Defect** = Step A (runtime impact evidence) + Step B (verified reachability)
  + Step C (grounded description). ALL three steps are required. Passing Step A alone is
  necessary but NOT sufficient — a violation with theoretical runtime impact but unverified
  reachability is Standards-Only, not a functional defect.
- **False Positive**: Requires explicit source-level evidence — cite the specific variable,
  function, line number, and code construct that proves the tool's detection is incorrect.
- **Standards-Only Violation** (default): When you cannot provide clear evidence for either
  Functional Defect or False Positive, the violation is a standards-only coding issue.
  This is NOT a failure — it means the violation exists but its runtime impact is unproven.
  This includes cases where a violation COULD theoretically cause a defect but you cannot
  confirm the triggering condition is reachable in the actual program.

This principle applies equally to decidable and undecidable rules.

- mandatory conformance (L001) violations: do NOT mark as FP without clear exclusion evidence


---

## Undecidable Rules — Per-Finding Metadata

The 139 undecidable rules (where SpecChecker commonly produces false positives due to
limitations in data flow, control flow, cross-TU, or semantic analysis) are **not**
listed in this skill. Instead, `sa_fetch_findings` injects per-finding metadata for
each undecidable rule violation:

- **`rule_name`**: The rule's Chinese name (e.g., "整数溢出")
- **`fp_guidance`**: FP typical scenario or context elements to examine
- **`undecidable_category`**: Classification code (A1–A6, B2, B3)

Use the per-finding `fp_guidance` as a **classification guide** to recognize FP patterns.
It is NOT a reason template — your `reason` field must describe what the actual source
code does at the flagged location, citing concrete variable names, function names, and
line numbers.

Rules NOT in the undecidable set are decidable — SpecChecker's detection is definitive
and must NOT be classified as false positives.

---

## Output Format

### `defects.json` entry (functional defects only)
```json
{
  "id": "SA-0001",
  "source": "static_analysis",
  "severity": "major",
  "category": "coding_standard",
  "location": { "file_path": "src/main.c", "line_start": 47 },
  "title": "CID181: goto导致控制流跳过资源释放",
  "description": "违规行 goto error2 跳过了 mutex_unlock(&lock) 调用，导致互斥锁未释放。在当前业务逻辑中mutex在error2路径上不应跳过。",
  "rule_id": "CID181",
  "raw_finding_id": "RAW-003",
  "related_requirement_ids": [],
  "status": "open",
  "detected_by": "sa-reviewer",
  "detected_date": "2026-02-25"
}
```

### `false-positives.json`
```json
{
  "project_name": "string",
  "generated_date": "ISO 8601",
  "summary": {
    "total_violations_checked": 42,
    "false_positives_found": 8
  },
  "false_positives": [
    {
      "raw_finding_id": "RAW-005",
      "rule_id": "CID730",
      "undecidable_category": "A1",
      "file": "src/driver/uart.c",
      "line": 47,
      "reason": "goto用于多资源初始化失败后的统一cleanup跳转，是嵌入式驱动层的公认惯用法"
    }
  ]
}
```

### `standards-only.json`
```json
{
  "project_name": "string",
  "generated_date": "ISO 8601",
  "summary": {
    "total_violations_checked": 42,
    "standards_only_found": 4
  },
  "standards_only": [
    {
      "raw_finding_id": "RAW-012",
      "rule_id": "CID293",
      "file": "src/algo/filter.c",
      "line": 0,
      "reason": "注释率低于阈值但代码命名清晰，不影响功能"
    }
  ]
}
```

### `reports/static-analysis-review.md` sections
1. **分类汇总表**: 总违规数 / 功能缺陷 / 规范违规 / 误报
2. **功能缺陷列表**: 写入defects.json的条目（SA-ID | raw_finding_id | rule_id | 文件:行 | 标题 | 严重级别）
3. **误报列表**: rule_id | 文件:行 | 误报类别 | 判定理由
4. **规范违规列表**: rule_id | 文件:行 | 描述

---

## Page Worker Mode

When the SA-Reviewer operates in `classify_mode=page` mode (dispatched by the orchestrator
as a page-worker subagent):

- **Self-continuing**: After completing your assigned page, call
  `sa_wave_guard(action="lease_pages", wave_id=..., count=1)` to get the next pending page.
  If a page is returned, `claim_page` it and continue processing. Repeat until no pending
  pages remain or you have processed **max_pages_per_worker** pages (default 3).
- **max_pages_per_worker limit**: To prevent context window bloat, each worker processes at
  most 3 pages before exiting. The orchestrator's snapshot polling will spawn replacement
  workers if pending pages remain.
- **Skill/context reuse**: Load the `static-analysis-review` skill and call `sa_context_probe`
  only on your **first** page. Subsequent pages reuse the already-loaded context.
- Pre-classification is already complete — do **NOT** call `sa_preclassify`
- Prior SA defects have been cleared by the orchestrator — do **NOT** use `replace_source`
  on `append_defects`
- All classification methodology (worksheet, verification flows, evidence rules) applies
  **unchanged** — every finding must still go through the full Defect or FP Verification Flow
- Flush results immediately after processing each page (`append_defects` for defects,
  `sa_append_review_results` for false positives and standards-only)
- Do **NOT** generate reports — the orchestrator handles report generation after
  all page-workers complete
