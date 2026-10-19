# 编译诊断机制 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在静态分析流程中加入编译诊断环节——工具读取 compile.log 返回给智能体，智能体按技能文件中的决策树分析根因并采取措施（换配置重试/上报/记录缺陷）。

**Architecture:** specchecker 工具在 `executeCheck()` 中读取 `{projectPath}/log/compile.log` 并作为 `compile_log` 字段返回。智能体 prompt 新增 Step 1.5 编译诊断。技能文件 `skills/static-analysis/SKILL.md` 新增编译诊断章节固化决策树和级联去重原则。

**Tech Stack:** TypeScript, Markdown (SKILL.md)

---

### Task 1: 工具侧——executeCheck() 读取 compile.log 并加入返回值

**Files:**
- Modify: `src/tools/misra-checker.ts:733-840`

**Step 1: 在 analyze 步骤之后、report 步骤之前，读取 compile.log**

在 `src/tools/misra-checker.ts` 的 `executeCheck()` 函数中，analyze 步骤完成后（第 733 行之后），report 步骤之前（第 735 行之前），插入读取 compile.log 的代码：

```typescript
  // ── Read compile.log for compilation diagnostics ────────────────────────
  let compileLog = ""
  const compileLogPath = join(projectPath, "log", "compile.log")
  try {
    if (existsSync(compileLogPath)) {
      compileLog = readFileSync(compileLogPath, "utf-8")
    }
  } catch {
    // Ignore read errors — compile.log is optional diagnostics
  }
```

**Step 2: 在返回值中添加 compile_log 字段**

在第 815 行的 `return JSON.stringify({...})` 对象中，在 `errors` 字段之后添加：

```typescript
    compile_log: compileLog || null,
```

**Step 3: 运行 typecheck 验证**

Run: `npx tsc --noEmit`
Expected: exit 0, no errors

**Step 4: Commit**

```
feat(specchecker): read compile.log and include in check mode output
```

---

### Task 2: 技能文件——新增编译诊断章节

**Files:**
- Modify: `skills/static-analysis/SKILL.md`

**Step 1: 在 "Analysis Workflow" 的 "1. Run SpecChecker Analysis" 之后，插入新章节**

在 SKILL.md 中 `### 1. Run SpecChecker Analysis` 小节结束后（第 23 行之后）、`### 2. Generate Repairs` 之前，插入以下内容：

```markdown
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
```

**Step 2: Update the "Output" section**

In the "## Output" section (around line 53-57), add a bullet point after the existing items:

```markdown
- If compilation diagnostics found issues: report compilation error summary and actions taken (config retries, escalations, defects recorded)
```

**Step 3: Commit**

```
feat(static-analysis-skill): add compilation diagnostics section with cascade dedup and decision tree
```

---

### Task 3: 智能体 prompt——新增 Step 1.5 编译诊断

**Files:**
- Modify: `src/agents/static-analyzer.ts:51-73`

**Step 1: 在 Step 1 之后、Step 2 之前，插入 Step 1.5**

在 `static-analyzer.ts` 的 system prompt 中，Step 1 结尾（第 72 行 `The tool handles everything...` 之后）和 Step 2 开头（第 74 行 `### Step 2:` 之前），插入：

```
### Step 1.5: Compilation Diagnostics
After Step 1, check the \`compile_log\` field in the tool output. If it is empty or null, skip to Step 2.

If it contains errors, load the \`static-analysis\` skill and follow the **Compilation Diagnostics** section:
1. **Cascade dedup**: Identify root cause errors, ignore cascading errors (missing headers → undefined types, missing syntax tokens → parse errors, etc.)
2. **Priority 1 — Configuration mismatch?** If many root-cause errors suggest wrong compiler preset: read \`.matrix/data/software-analysis.json\` for compiler_dialect/target_cpu context, select a better preset, re-run \`specchecker(mode="check")\` with corrected \`compiler\` param. Max 3 retries. If software-analysis.json is missing, report to orchestrator requesting Analyst.
3. **Priority 2 — Missing dependencies?** If errors are project-specific missing headers (not platform headers): report to orchestrator requesting Analyst to supplement stubs/includes.
4. **Priority 3 — Source code defects?** Record clear source code errors as defects in \`.matrix/data/defects.json\` (source: "static_analysis", severity: "critical" for blocking errors). Then continue with normal workflow.
```

**Step 2: Update the constraints section**

In the `<constraints>` section (line 124-131), modify the constraint about defects.json. Change:

```
- NEVER read or write \`.matrix/data/defects.json\`. All output goes to \`.matrix/data/sa-raw-findings.json\`. Defect classification is SA-Reviewer's responsibility.
```

to:

```
- NEVER write coding standard violations to \`.matrix/data/defects.json\` — SA-Reviewer handles that. The ONLY exception: compilation errors identified in Step 1.5 as source code defects (Priority 3) may be written to defects.json.
```

**Step 3: 运行 typecheck 验证**

Run: `npx tsc --noEmit`
Expected: exit 0, no errors

**Step 4: Commit**

```
feat(static-analyzer): add Step 1.5 compilation diagnostics to agent prompt
```
