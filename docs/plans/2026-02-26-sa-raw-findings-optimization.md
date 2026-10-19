# SA Raw Findings 生成优化 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 消除 specchecker 工具输出与 sa-raw-findings.json 之间的数据重复——工具在 check 模式完成后直接写入 sa-raw-findings.json，智能体只做增量补充（patch 字段）。

**Architecture:** specchecker 工具的 `executeCheck()` 在解析报告后，自动将 violations 映射为 `SARawFindingsReport` schema 并写入 `.matrix/data/sa-raw-findings.json`（含 RAW-NNN 编号）。返回值中新增 `sa_raw_findings_path` 字段。static-analyzer 智能体的 Step 5 从"从头构造"改为"增量补充 patch"。

**Tech Stack:** TypeScript, Zod schema, Bun

---

### Task 1: 工具侧——executeCheck() 中自动写入 sa-raw-findings.json

**Files:**
- Modify: `src/tools/misra-checker.ts:756-793`

**Step 1: 在 parseSpecCheckerReport 之后、return 之前，添加写入逻辑**

在 `src/tools/misra-checker.ts` 的 `executeCheck()` 函数中，`parseSpecCheckerReport()` 调用（第 756 行）之后、构建 summary 和 return（第 760-793 行）之间，插入以下代码：

```typescript
  // ── Write sa-raw-findings.json ──────────────────────────────────────────
  if (matrixRoot) {
    const dataDir = join(matrixRoot, ".matrix", "data")
    mkdirSync(dataDir, { recursive: true })

    const saViolations = violations.map((v, i) => ({
      id: `RAW-${String(i + 1).padStart(3, "0")}`,
      rule_id: v.rule_id,
      rule_name: v.rule_name,
      severity: v.severity,
      conformance: v.conformance,
      fixability: v.fixability,
      file: v.file,
      line: v.line,
      code_snippet: v.code_snippet,
    }))

    const saReport = {
      project_name: projectName,
      analysis_date: new Date().toISOString(),
      tool: "specchecker" as const,
      source_dir: sourceDir,
      summary: {
        total: violations.length,
        by_severity: bySeverity,
        by_fixability: byFixability,
      },
      violations: saViolations,
    }

    const saPath = join(dataDir, "sa-raw-findings.json")
    writeFileSync(saPath, JSON.stringify(saReport, null, 2), "utf-8")
  }
```

**Step 2: 在返回值中添加 sa_raw_findings_path**

在第 770 行的 `return JSON.stringify({...})` 对象中，添加一个字段：

```typescript
    sa_raw_findings_path: matrixRoot
      ? join(matrixRoot, ".matrix", "data", "sa-raw-findings.json")
      : null,
```

**Step 3: 运行 typecheck 验证**

Run: `bun run typecheck`
Expected: PASS, no type errors

**Step 4: Commit**

```
feat(specchecker): auto-generate sa-raw-findings.json in check mode
```

---

### Task 2: 智能体侧——更新 static-analyzer prompt 的 Step 5

**Files:**
- Modify: `src/agents/static-analyzer.ts:95-117`

**Step 1: 替换 Step 5 指令**

将 `static-analyzer.ts` 第 95-117 行的 Step 5 内容：

```
### Step 5: Write Raw Findings
Write all violations (after optional repair steps) to `.matrix/data/sa-raw-findings.json`.

The output must include:
- `project_name`: extracted from config or directory name
- `analysis_date`: current ISO 8601 date string
- `tool`: "specchecker"
- `source_dir`: the analyzed source directory path
- `summary.total`: total violation count
- `summary.by_severity`: count per severity level
- `summary.by_fixability`: count per fixability class
- `violations`: array of every violation with fields:
  - `id`: "RAW-001", "RAW-002", ... (sequential)
  - `rule_id`: CID format (e.g. "CID181")
  - `rule_name`: human-readable rule name
  - `severity`: "critical" | "major" | "minor" | "suggestion"
  - `conformance`: "mandatory" | "recommended" (from SpecChecker output)
  - `fixability`: "auto_fixable" | "needs_review" | "unfixable"
  - `file`: source file path
  - `line`: violation line number
  - `code_snippet`: the violating code fragment
  - `patch`: repair patch string if repair was generated, otherwise null

DO NOT write to `.matrix/data/defects.json`. Defect classification is performed
by the SA-Reviewer agent in the next step.
```

替换为：

```
### Step 5: Update Raw Findings with Repair Patches (only if repairs were generated)
The specchecker tool has already written `.matrix/data/sa-raw-findings.json` during the check step (see `sa_raw_findings_path` in check output). This file contains all violations with RAW-NNN IDs.

- If you performed repairs in Steps 3-4: read `.matrix/data/sa-raw-findings.json`, match each repaired violation by `rule_id` + `file` + `line` to the corresponding RAW-NNN entry, add the `patch` field with the verified repair patch string, then write the file back.
- If no repairs were generated: skip this step — the file is already complete.

DO NOT write to `.matrix/data/defects.json`. Defect classification is performed
by the SA-Reviewer agent in the next step.
```

**Step 2: 运行 typecheck 验证**

Run: `bun run typecheck`
Expected: PASS, no type errors

**Step 3: Commit**

```
refactor(static-analyzer): use tool-generated sa-raw-findings.json, only patch incrementally
```

---

### Task 3: 更新工具描述，说明 check 模式会自动生成 sa-raw-findings.json

**Files:**
- Modify: `src/tools/misra-checker.ts:369-377` (tool description)

**Step 1: 在 check 模式描述中补充说明**

将 description 中 check 模式部分：

```
"- 'check': Full project analysis via SpecChecker 3-step pipeline (create→analyze→report). " +
```

替换为：

```
"- 'check': Full project analysis via SpecChecker 3-step pipeline (create→analyze→report). " +
"Automatically writes .matrix/data/sa-raw-findings.json (SARawFindingsReport schema) with RAW-NNN IDs. " +
```

**Step 2: 运行 typecheck 验证**

Run: `bun run typecheck`
Expected: PASS

**Step 3: Commit**

```
docs(specchecker): document auto-generated sa-raw-findings.json in tool description
```
