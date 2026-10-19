# Atomicity-Checker Token 优化 & 文件精简 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 精简 multivar-atomicity-checker 的输出文件体系（13→8 个），将 LLM 手写 JSON 改为工具代码处理，预计减少 ~35-80% output token 消耗。

**Architecture:** 两大改动方向：(1) 在 `multivar_correlated_vars` 工具中新增 `merge_llm_evaluation` action，接收 LLM 紧凑评估结果，由工具执行 confidence 重算、过滤、文件回写；(2) 重命名所有输出文件使语义更清晰，移除 3 个冗余中间文件。

**Tech Stack:** TypeScript (Bun runtime), OpenCode Plugin SDK

**约束:**
- 不改变原有检测功能和逻辑
- 不增加项目复杂性和耦合性
- 评分模型 (AQ+OE+LLM)、λ 值、阈值完全不变
- 工具的 `identify` action 原有逻辑完全不动

---

## 文件命名变更总览

### 新文件体系（8 个）

```
.matrix/data/
  ├── {project}.bin          # CPG 二进制（不变）
  ├── anchor.json            # 锚点识别（不变）
  ├── correlated-accesses.json  ← 原 multivar-correlated-groups.json
  ├── candidates.json           ← 原 multivar-candidates.json
  ├── violations.json           ← 原 multivar-violations.json
  └── confirmed.json            ← 原 multivar-confirmed.json

.matrix/reports/
  ├── correlated-pairs.md       ← 原 correlated-groups.md
  ├── candidates.md             ← 原 multivar-candidates.md
  ├── violations.md             ← 原 multivar-violations.md
  └── final_report.md           ← 原 multivar-violation.md
```

### 移除的文件（3 个）

| 文件 | 原用途 | 移除原因 |
|------|--------|----------|
| `correlatedVars.json` | 关联变量对格式（工具硬编码写入） | 无下游消费者，与 `multivar-correlated-accesses.json` 数据重复 |
| `correlated-groups-refined.json` | LLM 评估后的精炼版 | 合并回 `multivar-correlated-accesses.json`（原地覆盖），无需单独文件 |
| `correlatedVars_llm.json` | LLM 评估结果 | 从未实际产出（agent prompt 要求写但无法可靠生成），评估数据已嵌入 `multivar-correlated-accesses.json` 的 `llm_*` 字段 |

---

## File Structure

| 文件 | 操作 | 职责变更 |
|------|------|----------|
| `src/tools/multivar-correlated-vars.ts` | Modify | (1) 新增 `merge_llm_evaluation` action (2) 移除 `correlatedVars.json` 写入 (3) 输出文件名改为 `multivar-correlated-accesses.json` / `multivar-correlated-pairs.md` |
| `src/agents/multivar-atomicity-checker.ts` | Modify | (1) Step 3.5d 改为调用工具 (2) 所有文件路径重命名 (3) Step 0 清理列表更新 (4) artifact_paths 更新 |
| `src/tools/multivar-violation-detect.ts` | Modify | describe 文本中的推荐路径更新（2 处） |
| `src/tools/multivar-feasibility-verify.ts` | Modify | describe 文本中的推荐路径更新（4 处） |
| `skills/multivar-atomicity/SKILL.md` | Modify | 输出产物表更新 |

无需新增文件。无需修改 `create-tools.ts` 或其他注册逻辑。

---

## Task 1: 修改 `multivar-correlated-vars.ts` — 移除冗余文件写入 + 新增 merge action

**Files:**
- Modify: `src/tools/multivar-correlated-vars.ts`

### 1.1 添加 `readFileSync` import

- [ ] **Step 1: 在 import 中添加 `readFileSync`**

```typescript
// Line 2: 旧
import { existsSync, writeFileSync, unlinkSync, mkdirSync } from "fs"
// Line 2: 新
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "fs"
```

### 1.2 移除 `correlatedVars.json` 写入

- [ ] **Step 2: 删除 line 1201-1225 的 `correlatedVars.json` 写入代码**

找到以下代码块并删除（约 25 行）：

```typescript
      // Write correlatedVars.json (Step 2 output)
      try {
        const dataDir = join(output_path, "..")
        const cvPath = join(dataDir, "correlatedVars.json")
        ...
        writeFileSync(cvPath, JSON.stringify(cvData, null, 2), "utf-8")
      } catch { /* best-effort */ }
```

这段代码写入的 `correlatedVars.json` 无下游消费者，其数据与主输出 `multivar-correlated-accesses.json` 重复。

- [ ] **Step 3: 验证编译**

Run: `cd D:/Matrix/matrix-embedded-agent && npx tsc --noEmit src/tools/multivar-correlated-vars.ts 2>&1 | head -20`

如果项目不用 tsc，改用: `bun build src/tools/multivar-correlated-vars.ts --no-bundle 2>&1 | head -20`

Expected: 无编译错误

- [ ] **Step 4: Commit**

```bash
git add src/tools/multivar-correlated-vars.ts
git commit -m "refactor(atomicity): remove unused correlatedVars.json output

The correlatedVars.json file had no downstream consumer — its data
duplicated what correlated-accesses.json already provides. Removing
this eliminates ~2-5KB of unnecessary file I/O per run."
```

### 1.3 新增 `mergeLlmEvaluation` 函数

- [ ] **Step 5: 在 `generateCorrelatedGroupsMd` 函数后、`export const multivarCorrelatedVars` 前插入 merge 函数**

位置：约 line 1004（`generateCorrelatedGroupsMd` 结束）之后。

```typescript
// ── LLM Evaluation Merge ──

interface LlmEvaluation {
  group_id: string
  llm_judgment: "STRONG" | "WEAK" | "NONE"
  llm_reason: string
}

interface MergeInput {
  correlated_groups_path: string
  evaluations: LlmEvaluation[]
  skipped_pass_ids: string[]
  skipped_filtered_ids: string[]
  project_name: string
  llm_model: string
  final_threshold: number
}

const LAMBDA: Record<string, number> = { DFC: 0.15, TUP: 0.15, DAC: 0.40 }

function judgmentToL(judgment: "STRONG" | "WEAK" | "NONE"): number {
  return judgment === "STRONG" ? 1.0 : judgment === "WEAK" ? 0.5 : 0.0
}

function mergeLlmEvaluation(input: MergeInput): string {
  // 1. Read raw groups
  if (!existsSync(input.correlated_groups_path)) {
    return JSON.stringify({ status: "error", error: `File not found: ${input.correlated_groups_path}` })
  }
  let rawData: any
  try {
    rawData = JSON.parse(readFileSync(input.correlated_groups_path, "utf-8"))
  } catch (err: any) {
    return JSON.stringify({ status: "error", error: `Failed to parse JSON: ${err.message}` })
  }

  const groups: any[] = rawData.groups || []
  const dacAnchors: any[] = rawData.dac_anchors || []

  // 2. Build evaluation lookup
  const evalMap = new Map<string, LlmEvaluation>()
  for (const e of input.evaluations) {
    evalMap.set(e.group_id, e)
  }
  const passSet = new Set(input.skipped_pass_ids)
  const filteredSet = new Set(input.skipped_filtered_ids)

  // 3. Apply evaluations to each group
  const stats = {
    evaluated: 0, skipped_pass: 0, skipped_filtered: 0, unavailable: 0,
    by_judgment: { STRONG: 0, WEAK: 0, NONE: 0 },
  }

  for (const g of groups) {
    const id = g.id as string
    g.confidence_tool_layer = g.confidence  // preserve original

    if (passSet.has(id)) {
      g.llm_status = "SKIPPED_PASS"
      g.evidence.llm_score = 0
      stats.skipped_pass++
    } else if (filteredSet.has(id)) {
      g.llm_status = "SKIPPED_FILTERED"
      g.evidence.llm_score = 0
      stats.skipped_filtered++
    } else if (evalMap.has(id)) {
      const ev = evalMap.get(id)!
      const L = judgmentToL(ev.llm_judgment)
      g.llm_status = "EVALUATED"
      g.llm_judgment = ev.llm_judgment
      g.llm_reason = ev.llm_reason
      g.evidence.llm_score = L
      stats.evaluated++
      stats.by_judgment[ev.llm_judgment]++
    } else {
      g.llm_status = "UNAVAILABLE"
      g.evidence.llm_score = 0
      stats.unavailable++
    }

    // 4. Recalculate confidence: S + L × λ(type)
    const lambda = LAMBDA[g.anchor_type as string] ?? 0.15
    const llmScore = g.evidence.llm_score ?? 0
    let structuralSum = 0
    for (const [key, val] of Object.entries(g.evidence)) {
      if (key !== "llm_score" && key !== "llm_contribution" && typeof val === "number") {
        structuralSum += val
      }
    }
    g.confidence = structuralSum + llmScore * lambda
  }

  // 5. Apply final filter
  const passed = groups.filter((g: any) => g.confidence >= input.final_threshold)
  const passedIds = new Set(passed.map((g: any) => g.id))

  // 6. Clean dac_anchors: remove filtered group_ids, remove empty anchors
  const cleanedAnchors = dacAnchors
    .map((a: any) => ({
      ...a,
      group_ids: (a.group_ids || []).filter((id: string) => passedIds.has(id)),
    }))
    .filter((a: any) => a.group_ids.length > 0)

  // 7. Build refined result — overwrite the same file (no separate refined file)
  const refinedResult = {
    ...rawData,
    groups: passed,
    dac_anchors: cleanedAnchors,
    summary: {
      ...rawData.summary,
      after_refinement: passed.length,
      by_type: {
        dfc: passed.filter((g: any) => g.anchor_type === "DFC").length,
        tup: passed.filter((g: any) => g.anchor_type === "TUP").length,
        dac: passed.filter((g: any) => g.anchor_type === "DAC").length,
      },
    },
  }

  // 8. Write back to the same file (in-place update)
  try {
    writeFileSync(input.correlated_groups_path, JSON.stringify(refinedResult, null, 2), "utf-8")
  } catch (err: any) {
    return JSON.stringify({ status: "error", error: `Failed to write: ${err.message}` })
  }

  // 9. Return compact summary
  return JSON.stringify({
    status: "ok",
    summary: {
      total_groups: groups.length,
      evaluated: stats.evaluated,
      skipped_pass: stats.skipped_pass,
      skipped_filtered: stats.skipped_filtered,
      by_judgment: stats.by_judgment,
      after_filter: passed.length,
    },
  })
}
```

**与旧版计划的关键差异**：
- 不再写 `correlated-groups-refined.json` — 直接原地覆盖 `multivar-correlated-accesses.json`
- 不再写 `correlatedVars_llm.json` — LLM 评估数据已嵌入各 group 的 `llm_*` 字段
- 不需要 `compat_output_path`、`llm_output_path` 参数
- 函数接口更简洁

### 1.4 新增工具参数和 action 路由

- [ ] **Step 6: 修改工具 description**

```typescript
// 旧 description (line 1009-1014):
  description:
    "Identify correlated variable groups from a Joern CPG. " +
    "Runs the Joern Scala script for dataflow analysis, then classifies groups " +
    "into DFC (Data Flow Convergence), TUP (Transaction Update), or DAC anchor types with tiered " +
    "evidence scoring. Enforces same-function constraints for DFC/TUP groups. " +
    "Requires joern in system PATH and a pre-built CPG file.",

// 新 description:
  description:
    "Identify correlated variable groups from a Joern CPG, or merge LLM evaluation results. " +
    "Action 'identify' (default): Joern dataflow analysis → DFC/TUP/DAC classification with tiered evidence scoring. " +
    "Action 'merge_llm_evaluation': merge LLM judgments into existing groups, recalculate confidence, apply 0.55 filter, write back in-place.",
```

- [ ] **Step 7: 在 `args` 中新增 merge 相关参数**

在现有 `md_output_path` 参数之后添加：

```typescript
    // ── merge_llm_evaluation action params ──
    action: tool.schema
      .string()
      .optional()
      .describe(
        "Action: 'identify' (default) runs Joern analysis; " +
        "'merge_llm_evaluation' merges LLM judgments into existing groups.",
      ),
    evaluations: tool.schema
      .string()
      .optional()
      .describe(
        "JSON array of LLM evaluations: [{group_id, llm_judgment: STRONG|WEAK|NONE, llm_reason}]. " +
        "Only for merge_llm_evaluation.",
      ),
    skipped_pass_ids: tool.schema
      .string()
      .optional()
      .describe(
        "JSON array of group IDs that direct-pass (S >= 0.55). Only for merge_llm_evaluation.",
      ),
    skipped_filtered_ids: tool.schema
      .string()
      .optional()
      .describe(
        "JSON array of group IDs direct-discarded (below gray zone). Only for merge_llm_evaluation.",
      ),
    correlated_groups_path: tool.schema
      .string()
      .optional()
      .describe(
        "Path to correlated-accesses.json for in-place merge. Only for merge_llm_evaluation.",
      ),
    project_name_for_merge: tool.schema
      .string()
      .optional()
      .describe("Project name for merge metadata. Only for merge_llm_evaluation."),
    llm_model: tool.schema
      .string()
      .optional()
      .describe("LLM model identifier. Only for merge_llm_evaluation."),
    final_threshold: tool.schema
      .number()
      .optional()
      .describe("Confidence threshold for final filter (default 0.55). Only for merge_llm_evaluation."),
```

- [ ] **Step 8: 修改 `execute` 函数签名和路由**

```typescript
// 旧 (line ~1053):
  async execute({ cpg_path, project_name, task_entries, isr_entries, output_path, md_output_path }) {
    // Validate CPG exists
    ...

// 新: 改为 params: any 并在最开头加入 action 路由
  async execute(params: any) {
    // Route by action
    if (params.action === "merge_llm_evaluation") {
      let evaluations: LlmEvaluation[]
      let skipPass: string[]
      let skipFiltered: string[]
      try {
        evaluations = JSON.parse(params.evaluations || "[]")
        skipPass = JSON.parse(params.skipped_pass_ids || "[]")
        skipFiltered = JSON.parse(params.skipped_filtered_ids || "[]")
      } catch (err: any) {
        return JSON.stringify({ status: "error", error: `Invalid JSON: ${err.message}` })
      }
      return mergeLlmEvaluation({
        correlated_groups_path: params.correlated_groups_path,
        evaluations,
        skipped_pass_ids: skipPass,
        skipped_filtered_ids: skipFiltered,
        project_name: params.project_name_for_merge || params.project_name,
        llm_model: params.llm_model || "unknown",
        final_threshold: params.final_threshold ?? 0.55,
      })
    }

    // ── Original identify action (unchanged) ──
    const { cpg_path, project_name, task_entries, isr_entries, output_path, md_output_path } = params

    // Validate CPG exists
    ...
```

- [ ] **Step 9: 验证编译**

Run: `cd D:/Matrix/matrix-embedded-agent && bun build src/tools/multivar-correlated-vars.ts --no-bundle 2>&1 | head -20`

Expected: 无编译错误

- [ ] **Step 10: Commit**

```bash
git add src/tools/multivar-correlated-vars.ts
git commit -m "feat(atomicity): add merge_llm_evaluation action, remove correlatedVars.json

Adds merge_llm_evaluation action to multivar_correlated_vars tool:
- Merges LLM judgments (STRONG/WEAK/NONE) into correlated groups
- Recalculates confidence (S + L × λ), applies 0.55 filter
- Writes back in-place to correlated-accesses.json (no separate files)

Also removes correlatedVars.json output (no downstream consumer).
Expected savings: ~9K-24K output tokens per run."
```

---

## Task 2: 修改 Agent Prompt — 文件路径重命名 + Step 3.5d 改为工具调用

**Files:**
- Modify: `src/agents/multivar-atomicity-checker.ts`

### 2.1 Step 0 清理列表更新

- [ ] **Step 1: 更新 Step 0 的文件清理列表**

替换 line 63-91 中的文件列表。

旧文件列表（12 个）→ 新文件列表（8 个）：

```
   - \`.matrix/data/multivar-anchors.json\`
   - \`.matrix/data/multivar-correlated-accesses.json\`
   - \`.matrix/data/multivar-candidates.json\`
   - \`.matrix/data/multivar-violations.json\`
   - \`.matrix/data/confirmed.json\`
   - \`.matrix/reports/multivar-correlated-pairs.md\`
   - \`.matrix/reports/multivar-candidates.md\`
   - \`.matrix/reports/multivar-violations.md\`
   - \`.matrix/reports/multivar-final-report.md\`
```

**具体修改**：Step 0 中有 3 处文件列表（检查列表、删除列表各出现一次，加上 step 1 的 archive 列表），全部替换为上述 9 个文件（`multivar-anchors.json` + 4 data + 4 reports）。

移除的条目：`correlatedVars.json`、`correlatedVars_llm.json`、`multivar-correlated-groups.json`、`correlated-groups-refined.json`、`multivar-violations.json`、`multivar-candidates.json`、`multivar-confirmed.json`、`correlated-groups.md`、`multivar-candidates.md`、`multivar-violations.md`、`multivar-violation.md`

### 2.2 Step 3 文件路径更新

- [ ] **Step 2: 更新 Step 3 的 output_path 和 md_output_path**

```
// 旧 (line 123):
   - \`output_path\`: \`".matrix/data/multivar-correlated-groups.json"\`
   - \`md_output_path\`: \`".matrix/reports/correlated-groups.md"\`
// 新:
   - \`output_path\`: \`".matrix/data/multivar-correlated-accesses.json"\`
   - \`md_output_path\`: \`".matrix/reports/multivar-correlated-pairs.md"\`
```

### 2.3 Step 3.5 文件路径更新

- [ ] **Step 3: 更新 Step 3.5 中对 multivar-correlated-groups.json 的引用**

```
// 旧 (line 159):
1. Read \`.matrix/data/multivar-correlated-groups.json\` (this is the raw tool-layer output).
// 新:
1. Read \`.matrix/data/multivar-correlated-accesses.json\` (this is the raw tool-layer output).
```

### 2.4 Step 3.5b/c 添加紧凑输出格式指令

- [ ] **Step 4: 在 Step 3.5b 末尾 (line 204 之后) 添加输出格式约束**

在 `d. Set \`evidence.llm_score = L\`...` 这行之后插入：

```
   e. **Output format** — collect results as a compact list for §3.5d:
   \`[{"group_id": "cg_0012", "llm_judgment": "STRONG", "llm_reason": "sensor pair must be read atomically"}, ...]\`
   Do NOT use the \`write\` tool to write JSON files. The tool in §3.5d handles all file I/O.
```

- [ ] **Step 5: 在 Step 3.5c 末尾 (line 234 之后) 添加输出格式约束**

在 `- Pair (data_ready, debug_counter)...` 之后插入：

```
   g. **Output format** — same compact list format as §3.5b. Do NOT write JSON files manually.
```

### 2.5 Step 3.5d 替换为工具调用

- [ ] **Step 6: 替换 Step 3.5d 全部内容 (line 236-291)**

将从 `#### 3.5d: Finalize — Recalculate confidence and apply final filter` 到 `\`llm_status\` values: ...UNAVAILABLE...` 的全部内容（约 56 行）替换为：

```
#### 3.5d: Finalize — Call tool to merge evaluations

After completing all LLM evaluations (§3.5b and §3.5c), call \`multivar_correlated_vars\` with action \`merge_llm_evaluation\`:

4. Collect all evaluation results from §3.5b and §3.5c into a single JSON array:
   \`[{"group_id": "cg_0001", "llm_judgment": "STRONG", "llm_reason": "flag guards buffer"}, ...]\`
5. Collect Direct Pass group IDs (from §3.5a) into \`skipped_pass_ids\`.
6. Collect Direct Discard group IDs (from §3.5a) into \`skipped_filtered_ids\`.
7. Call \`multivar_correlated_vars\` with:
   - \`action\`: \`"merge_llm_evaluation"\`
   - \`correlated_groups_path\`: \`".matrix/data/multivar-correlated-accesses.json"\`
   - \`evaluations\`: the JSON array from step 4
   - \`skipped_pass_ids\`: from step 5
   - \`skipped_filtered_ids\`: from step 6
   - \`project_name_for_merge\`: project name from compilation environment
   - \`llm_model\`: your model identifier
   - \`final_threshold\`: 0.55
8. The tool handles: confidence recalculation (S + L × λ), 0.55 final filter, DAC anchor cleanup, and in-place update of \`correlated-accesses.json\`.
9. **Do NOT use the \`write\` tool to manually write any correlated groups JSON file.** The tool does all file I/O.
10. Review the tool's summary and log progress.
```

### 2.6 Step 3.5d 之后的 backward-compatibility 引用清理

- [ ] **Step 7: 更新 Step 3.5d 后面引用 multivar-correlated-groups.json 的地方**

旧 Step 3.5d 第 7 点提到 "write to `.matrix/data/multivar-correlated-groups.json` (overwriting the raw file)"，这在新版中已由 merge action 自动处理（in-place 覆盖），无需额外提及。确认 §3.5e 中无需改动（大容量策略不涉及文件名）。

### 2.7 Step 4 文件路径更新

- [ ] **Step 8: 更新 Step 4 中的所有文件路径**

```
// 旧 (line 311):
verify the following in \`.matrix/data/multivar-correlated-groups.json\`:
// 新:
verify the following in \`.matrix/data/multivar-correlated-accesses.json\`:

// 旧 (line 322):
   - \`correlated_groups_path\`: \`".matrix/data/multivar-correlated-groups.json"\`
// 新:
   - \`correlated_groups_path\`: \`".matrix/data/multivar-correlated-accesses.json"\`

// 旧 (line 328):
   - \`output_path\`: \`".matrix/data/multivar-candidates.json"\`
   - \`md_output_path\`: \`".matrix/reports/multivar-candidates.md"\`
// 新:
   - \`output_path\`: \`".matrix/data/multivar-candidates.json"\`
   - \`md_output_path\`: \`".matrix/reports/multivar-candidates.md"\`
```

### 2.8 Step 5 文件路径更新

- [ ] **Step 9: 更新 Step 5 中的所有文件路径**

```
// 旧 (line 350):
   - \`violations_path\`: \`".matrix/data/multivar-candidates.json"\`
// 新:
   - \`violations_path\`: \`".matrix/data/multivar-candidates.json"\`

// 旧 (line 353-355):
   - \`output_path\`: \`".matrix/data/multivar-violations.json"\`
   - \`confirmed_output_path\`: \`".matrix/data/multivar-confirmed.json"\`
   - \`md_output_path\`: \`".matrix/reports/multivar-violations.md"\`
// 新:
   - \`output_path\`: \`".matrix/data/multivar-violations.json"\`
   - \`confirmed_output_path\`: \`".matrix/data/confirmed.json"\`
   - \`md_output_path\`: \`".matrix/reports/multivar-violations.md"\`
```

### 2.9 Step 6 文件路径更新

- [ ] **Step 10: 更新 Step 6 中的文件路径**

```
// 旧 (line 363):
Generate \`.matrix/reports/multivar-violation.md\`
// 新:
Generate \`.matrix/reports/multivar-final-report.md\`

// 旧 (line 368):
aggregate from the \`groups\` array in \`.matrix/data/multivar-correlated-groups.json\`
// 新:
aggregate from the \`groups\` array in \`.matrix/data/multivar-correlated-accesses.json\`

// 旧 (line 369):
from \`.matrix/data/multivar-violations.json\`
// 新:
from \`.matrix/data/multivar-violations.json\`

// 旧 (line 371):
\`.matrix/reports/correlated-groups.md\`
// 新:
\`.matrix/reports/multivar-correlated-pairs.md\`

// 旧 (line 371):
the final \`multivar-correlated-groups.json\`
// 新:
the final \`correlated-accesses.json\`
```

### 2.10 artifact_paths 更新

- [ ] **Step 11: 替换 `<artifact_paths>` 部分 (line 391-408)**

旧内容（7 个 JSON + 3 个 MD + 1 个综合报告）→ 新内容：

```
<artifact_paths>
**JSON 原始数据**:
- Anchors: .matrix/data/multivar-anchors.json
- Correlated accesses (tool output → LLM-merged): .matrix/data/multivar-correlated-accesses.json
- Violation candidates (4-access interleaving): .matrix/data/multivar-candidates.json
- Full results with feasibility: .matrix/data/multivar-violations.json
- Confirmed-only (minimal): .matrix/data/confirmed.json

**Markdown 可视化报告** (由工具自动生成):
- Correlated pairs: .matrix/reports/multivar-correlated-pairs.md
- Candidates: .matrix/reports/multivar-candidates.md
- Verified violations: .matrix/reports/multivar-violations.md

**综合分析报告** (由 Agent 在 Step 6 生成):
- Final report: .matrix/reports/multivar-final-report.md
</artifact_paths>
```

### 2.11 Agent description 中的输出路径

- [ ] **Step 12: 更新 createMultivarAtomicityCheckerAgent 的 description (line 413)**

```
// 旧:
"Outputs violations to .matrix/data/multivar-violations.json and report to .matrix/reports/multivar-violation.md."
// 新:
"Outputs violations to .matrix/data/multivar-violations.json and report to .matrix/reports/multivar-final-report.md."
```

- [ ] **Step 13: 验证编译**

Run: `cd D:/Matrix/matrix-embedded-agent && bun build src/agents/multivar-atomicity-checker.ts --no-bundle 2>&1 | head -20`

Expected: 无编译错误

- [ ] **Step 14: Commit**

```bash
git add src/agents/multivar-atomicity-checker.ts
git commit -m "refactor(atomicity): rename output files and replace Step 3.5d with tool call

File renames for clarity:
- multivar-correlated-groups.json → correlated-accesses.json
- multivar-candidates.json → candidates.json
- multivar-violations.json → violations.json
- multivar-confirmed.json → confirmed.json
- multivar-violation.md → final_report.md

Removed 3 files: correlatedVars.json, correlated-groups-refined.json,
correlatedVars_llm.json (no downstream consumers).

Step 3.5d now calls merge_llm_evaluation tool instead of LLM hand-writing
JSON files. Expected savings: ~9K-24K output tokens per run."
```

---

## Task 3: 更新工具 describe 文本中的推荐路径

**Files:**
- Modify: `src/tools/multivar-violation-detect.ts:799-808`
- Modify: `src/tools/multivar-feasibility-verify.ts:1216-1279`

### 3.1 multivar-violation-detect.ts

- [ ] **Step 1: 更新 2 处推荐路径**

```typescript
// Line 801: 旧
"Recommended: use '.matrix/data/multivar-candidates.json'.",
// Line 801: 新
"Recommended: use '.matrix/data/multivar-candidates.json'.",

// Line 808: 旧
"Recommended: '.matrix/reports/multivar-candidates.md'.",
// Line 808: 新
"Recommended: '.matrix/reports/multivar-candidates.md'.",
```

### 3.2 multivar-feasibility-verify.ts

- [ ] **Step 2: 更新 4 处推荐路径**

```typescript
// Line 1216-1217: 旧
"Path to the multivar-candidates.json file produced by multivar_violation_detect " +
"(e.g., '.matrix/data/multivar-candidates.json'). " +
// 新
"Path to the candidates.json file produced by multivar_violation_detect " +
"(e.g., '.matrix/data/multivar-candidates.json'). " +

// Line 1263: 旧
"(e.g., '.matrix/data/multivar-violations.json'). " +
// 新
"(e.g., '.matrix/data/multivar-violations.json'). " +

// Line 1271: 旧
"(e.g., '.matrix/data/multivar-confirmed.json'). " +
// 新
"(e.g., '.matrix/data/confirmed.json'). " +

// Line 1279: 旧
"Recommended: '.matrix/reports/multivar-violations.md'.",
// 新
"Recommended: '.matrix/reports/multivar-violations.md'.",
```

- [ ] **Step 3: Commit**

```bash
git add src/tools/multivar-violation-detect.ts src/tools/multivar-feasibility-verify.ts
git commit -m "refactor(atomicity): update recommended file paths in tool descriptions

Align tool describe text with renamed output files:
- multivar-candidates.json → candidates.json
- multivar-violations.json → violations.json
- multivar-confirmed.json → confirmed.json"
```

---

## Task 4: 更新 SKILL.md 输出产物表

**Files:**
- Modify: `skills/multivar-atomicity/SKILL.md:339-351`

- [ ] **Step 1: 替换输出产物表**

将 line 339-351 的表格替换为：

```markdown
| 文件                                      | 描述                 |
| ----------------------------------------- | ------------------ |
| `.matrix/data/multivar-anchors.json`                | 锚点识别结果（Step 1 输出） |
| `.matrix/data/multivar-correlated-accesses.json`   | 关联访问组数据（含证据、置信度、LLM 评估结果） |
| `.matrix/reports/multivar-correlated-pairs.md`     | 关联变量对可视化报告         |
| `.matrix/data/multivar-candidates.json`            | 4 次访问交错候选原始数据      |
| `.matrix/reports/multivar-candidates.md`           | 访问序候选可视化报告         |
| `.matrix/data/multivar-violations.json`            | 含可行性验证的完整结果原始数据    |
| `.matrix/data/confirmed.json`             | 仅确认违反，精简信息         |
| `.matrix/reports/multivar-violations.md`           | 最终缺陷检测结果可视化报告      |
| `.matrix/reports/multivar-final-report.md`         | 综合分析报告（由 Agent 生成） |
```

- [ ] **Step 2: Commit**

```bash
git add skills/multivar-atomicity/SKILL.md
git commit -m "docs(atomicity): update SKILL.md output artifact table

Reflect renamed files and removal of 3 redundant intermediate files
(correlatedVars.json, correlated-groups-refined.json, correlatedVars_llm.json)."
```

---

## 不动的部分（检查清单）

以下代码/逻辑确认不修改：

- [ ] `multivarCorrelatedVars` 的 `identify` action：`execute` 中 `// Validate CPG exists` 以下的原始逻辑完全不动
- [ ] `refineEvidence()` 函数：不动
- [ ] `computeDataflowScore()` / `computeTransactionalScore()` / `computeDacScore()`：不动
- [ ] `buildAnchors()` / `buildCorrelatedVarsPairs()`：不动
- [ ] `multivar-violation-detect.ts`：仅 describe 文本路径更新，execute 逻辑不动
- [ ] `multivar-feasibility-verify.ts`：仅 describe 文本路径更新，execute 逻辑不动
- [ ] `multivar-cpg-create.ts`：不动
- [ ] `create-tools.ts`：不动（工具名和注册不变）
- [ ] Agent prompt Step 0-3 核心逻辑、3.5a-c 评估逻辑、3.5e 大容量策略、Step 4-6 核心逻辑：不动
- [ ] 评分模型 (AQ+OE+LLM)、λ 值 (DFC=0.15, TUP=0.15, DAC=0.40)、阈值 (0.55)：不动

---

## 预期效果

| 指标 | 优化前 | 优化后 |
|------|--------|--------|
| 输出文件数 | 13 | 8+1 (anchor) |
| Step 3.5d output tokens | ~9K-24K | ~200-500（工具调用参数） |
| output token 占比 | 38-81% | <10%（预估） |
| 文件命名 | atomicity-前缀冗长 | 简洁直观 |
| correlatedVars_llm.json | 从未实际产出 | 移除（数据嵌入 correlated-accesses.json） |
