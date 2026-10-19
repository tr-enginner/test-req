# Static Analysis Auto-Repair Disabled by Default — Design

**Date**: 2026-02-25
**Status**: Implemented

## Overview

将 StaticAnalyzer 的自动修复功能（`repair_all` / `verify` 步骤）改为**默认关闭**，并通过配置项 `static_repair_enabled` 允许用户按需开启。默认模式下，智能体只执行"检查 → 分类 → 写缺陷 → 生成报告"四步，不尝试生成或验证任何代码 patch。

## Problem Statement

### 现有行为

StaticAnalyzer 的 7 步工作流中，Step 3（批量修复）和 Step 4（验证修复）在每次运行时都会执行：

```
Step 1: Run specchecker check
Step 2: Gather context (optional)
Step 3: repair_all — batch repair ALL auto_fixable violations  ← 默认开启
Step 4: verify    — validate each repair                       ← 默认开启
Step 5: Classify & record findings
Step 6: Write defects.json + repair-plan.json
Step 7: Generate report
```

### 问题

1. **代价高**：`repair_all` 对所有 `auto_fixable` 违规调用 SpecChecker 一次，`verify` 对每个修复再调用一次。在大型项目中，这可能产生数十次工具调用，大幅增加 token 消耗和耗时。
2. **侵入性强**：自动生成 patch 并写入 `repair-plan.json` 是写操作，许多场景下用户只需要分析结果，不需要修复建议。
3. **Conductor 语义混乱**：Conductor 的 Phase 3 调度 prompt 包含了 `mode='repair_all'` 和 `mode='verify'` 指令，与"静态分析"的职责边界不符——修复是开发活动，分析才是测试活动。

## Design Decision

**默认模式**：仅分析（analysis-only）。
**可选模式**：分析 + 修复（`static_repair_enabled: true`）。

使用与 `output_language` 相同的"配置注入指令"模式——在 agent 创建时将行为指令附加到 system prompt 末尾，无需改变 agent 工厂函数的核心 prompt。

### 为什么不改 agent prompt 本身

Agent prompt 描述的是 StaticAnalyzer 的完整能力。修复能力是真实存在的，只是默认不激活。通过注入 `<repair_directive>` 块来条件性地禁用步骤，与 `<language_directive>` 的模式完全一致，保持了 agent 的可扩展性。

### 为什么选择默认关闭而非默认开启

- 大多数测试场景（特别是 Phase 3 初次分析）关注的是"有哪些问题"，而不是"如何自动修复"
- 修复生成是高代价操作，应该显式选择而非意外触发
- 未来可将修复功能独立为单独的工作流步骤或斜杠命令

## Configuration

### 新增配置项

```typescript
// src/config/schema.ts
static_repair_enabled: z.boolean().default(false)
```

**使用方式**：在 `.matrix/config/matrix.jsonc` 中设置：

```jsonc
{
  "static_repair_enabled": true  // 开启自动修复
}
```

## Behavior Specification

### 默认模式（`static_repair_enabled: false`）

| 步骤 | 状态 |
|------|------|
| Step 1: specchecker check | **执行** |
| Step 2: Gather context | **执行**（可选）|
| Step 3: repair_all | **跳过** |
| Step 4: verify | **跳过** |
| Step 5: Classify findings | **执行**（仅 must-fix / suggestion / waiver）|
| Step 6: Write defects.json | **执行** |
| Step 6: Write repair-plan.json | **跳过** |
| Step 7: Report | **执行**（省略 Auto-repair results 节）|

### 启用修复模式（`static_repair_enabled: true`）

所有 7 步均按原设计执行，包括 `repair-plan.json` 生成和报告中的修复结果章节。

## Directive Injection

`buildRepairDisabledDirective()` 在 `builtin-agents.ts` 中生成以下指令块，附加到 StaticAnalyzer system prompt 末尾：

```
<repair_directive>
Auto-repair is DISABLED for this session. Follow the modified workflow below:
- SKIP Step 3 (Batch Repair — do NOT invoke specchecker with mode "repair_all").
- SKIP Step 4 (Verify Repairs — do NOT invoke specchecker with mode "verify").
- In Step 5, use only three dispositions: "must-fix", "suggestion", or "waiver". Do NOT use "auto-fixed".
- In Step 6, write defects.json as usual but do NOT create repair-plan.json.
- In Step 7, omit the "Auto-repair results" section from the markdown report; instead note that repair was not performed in this run.
</repair_directive>
```

## Conductor Phase 3 Impact

Conductor 的 Phase 3 Step 3 调度 prompt 同步简化，移除 `repair_all` / `verify` 指令，并新增配置提示注释：

**修改前**：
```
task(subagent_type="static-analyzer", prompt="...After analysis, use mode='repair_all' with
violations_json=JSON.stringify(violations) to batch-repair ALL auto_fixable violations.
Then use mode='verify' to validate critical repairs. ...Write repair plan to
.matrix/data/repair-plan.json.", run_in_background=true)
```

**修改后**：
```
task(subagent_type="static-analyzer", prompt="Run SpecChecker static analysis on the source
code. Use the specchecker tool with mode='check' and project_dir='<path>'. Classify all
violations (must-fix / suggestion / waiver). Output report to .matrix/reports/static-analysis.md.
Merge any new defects into .matrix/data/defects.json.", run_in_background=true)

> Note: Auto-repair disabled by default. Enable with static_repair_enabled: true in
> .matrix/config/matrix.jsonc.
```

## Skill Update

`skills/static-analysis/SKILL.md` 在 Role 节新增说明：

> **Default mode: analysis only.** Auto-repair is disabled unless `static_repair_enabled: true`
> is set in `.matrix/config/matrix.jsonc`. When your prompt includes a `<repair_directive>` block,
> follow it exactly — it overrides the steps below.

步骤 2（Generate Repairs）和步骤 3（Verify Repairs）标注"only when repair is enabled"。Finding Classification 节分两种情况描述可用的 disposition。Output 节标注 `repair-plan.json` 仅在修复启用时写入。

## Files to Create/Modify

| File | Action | Content |
|------|--------|---------|
| `src/config/schema.ts` | **Modify** | Add `static_repair_enabled: z.boolean().default(false)` |
| `src/agents/builtin-agents.ts` | **Modify** | Add `buildRepairDisabledDirective()`, add `staticRepairEnabled` param to `createBuiltinAgents()`, inject directive to static-analyzer |
| `src/create-agents.ts` | **Modify** | Pass `pluginConfig.static_repair_enabled` to `createBuiltinAgents()` |
| `src/agents/conductor.ts` | **Modify** | Simplify Phase 3 Step 3 dispatch prompt, add config note |
| `skills/static-analysis/SKILL.md` | **Modify** | Document default analysis-only mode, annotate repair steps as conditional |

## No Changes Needed

- **Agent tools**: `specchecker` tool still registered — repair mode invokes it with different `mode` values when enabled
- **Defect schema**: No new source or category needed; static analysis defects continue to use `source="static_analysis"`
- **Hook system**: Existing hooks handle the simplified flow transparently
- **Other agents**: No downstream agent depends on `repair-plan.json` existing
