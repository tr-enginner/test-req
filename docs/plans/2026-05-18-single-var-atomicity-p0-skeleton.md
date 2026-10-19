# P0：singlevar-atomicity-checker 流水线骨架

**日期**：2026-05-18
**阶段**：P0 — 流水线骨架建立
**目标**：基础设施就位，可以开始针对 EmbedSVABench L1 案例做实现填充

---

## 已交付物

### 1. 契约规范

`docs/conflict-detector-contracts.md` — 3 个共享契约：

- **契约 1**：CPG 文件路径与生命周期（hash 校验、复用、归档）
- **契约 2**：违反记录统一 schema（source、id 前缀、扩展字段、严重度映射）
- **契约 3**：LLM 三级判定标准（STRONG/WEAK/NONE，融合公式，场景 λ 表）

### 2. TypeScript 数据 schema

`src/schema/singlevar-atomicity.ts` — 围绕 intAtom 论文 + 工程改进的完整 schema：

- `SinglevarPattern` (RWR/RWW/WRW/WWR/WWW)
- `ConsecutiveLocalPair` (intAtom 论文 e_p, e_c)
- `InterruptSummary` + `InterruptSummaryEntry` (intAtom Stage 3 摘要)
- `AliasNormalization` (论文未覆盖的别名规范化层)
- `LoopContext` (修复论文循环条件简化盲区)
- `CrossFunctionRelaxation` (修复论文同函数硬裁剪)
- `SinglevarViolationCandidate` (Stage 1 输出)
- `SinglevarViolation` (Stage 3 最终输出)
- `SinglevarAnalysisResult` (完整分析结果)

已注册到 `src/schema/index.ts`。

### 3. EmbedSVABench 负例扩展规划

- `D:\benchmark\EmbedSVABench\docs\negative-cases-expansion-plan.md`：
  - 第一批 9 个 paired negatives 设计（NEG_010 ~ NEG_018）
  - 第二批 36 个难懂负例（PMX/INI/PIP/PCO 各 9 个）
  - annotations.json v1.1 schema 扩展
- `D:\benchmark\EmbedSVABench\docs\tricky-negative-code-templates.md`：
  - 4 类难懂负例的完整代码模板（每类 ~250 行可编译骨架）
  - 派生其他案例的变化点矩阵

### 4. P0 流水线骨架

#### Agent
`src/agents/singlevar-atomicity-checker.ts` — 完整的 system prompt：

- 6 步工作流：Step 0 归档 → Step 1 加载上下文 → Step 2 复用/构建 CPG → Step 3 Stage 1 → Step 4 Stage 2 → Step 5 Stage 3 → Step 6 写 defects + 报告
- LLM HARD-GATE 防止跳过 Stage 2
- 跨函数松弛策略文档化
- Z3 UNKNOWN 兜底 LLM scenario

已注册到 `src/agents/builtin-agents.ts`。

#### Skill
`skills/singlevar-atomicity/SKILL.md` — 方法论参考：

- 11 章节涵盖原则、5 种模式、3 阶段流水线、置信度评分、别名规范化、跨函数松弛、循环处理、误报规避、与 multivar-atomicity-checker 的边界

#### Tools (P0 skeletons)
- `src/tools/singlevar-cpg-get.ts` — **完整可用**：实现契约 §1 的 CPG 共享与 hash 校验
- `src/tools/singlevar-pattern-detect.ts` — 骨架：参数处理、Joern 调用脚手架、输出路径处理
- `src/tools/singlevar-feasibility-verify.ts` — 骨架：Stage 3 调用脚手架

所有工具已注册到 `src/create-tools.ts`。

#### Joern 脚本骨架
- `joern/singlevarAtomicityIdentify.scala` — Stage 1 完整结构：参数加载、case classes 镜像 TS schema、output writers 完整、subroutines 留待 Phase 1 填充
- `joern/singlevarFeasibilityVerify.scala` — Stage 3 完整结构：同上

#### 复用上游工具
- 扩展 `resolveJoernScriptPath(scriptName?, matrixRoot?)` 支持任意脚本名（向后兼容）

---

## 验证

- `bun run typecheck` ✅ 通过
- `bun run build` ✅ 通过（572 modules, 6.97 MB, 184ms）

---

## Phase 1 工作清单（下一步）

按测试驱动开发的 P0→P1 转换：

### 选 3 个 EmbedSVABench L1 通用案例作为 P0 验证集
- **L1_004** (SPARC, R-W-R, trap_fail_address, copy_under_protection)
- **L1_005** (通用, R-W-R, Obdh.DeltB 结构体成员, copy_under_protection)
- **L1_006** (通用, W-W-R, Va, disable_global_interrupt)

### Phase 1 实现优先级（每完成一步可演示）

1. **填充 `discoverSharedVariables`**：在 L1_004 上跑通基本共享变量识别
2. **填充 `buildAliasNormalization`**：让 L1_005 的 `Obdh.DeltB` 能被识别为 STRUCT_FIELD
3. **填充 `findConsecutivePairs`**：让 3 个 case 的连续访问对被找到
4. **填充 `enumerateRemoteAccesses`**：枚举 ISR 中的访问
5. **填充 `matchPatterns`**：让 3 个 case 都进入 candidates 列表
6. **预期成果**：Stage 1 在 3 个 L1 通用案例上 100% 检出

### Phase 1 不做的事

- 跨函数松弛 → Phase 3
- Stage 2 路径互斥 → Phase 4
- Stage 3 完整路径分析 → Phase 4
- LLM 调用 → Phase 4

---

## 决策记录

| 决策 | 选择 | 理由 |
|------|-----|------|
| 新 agent vs 增强 isr-reviewer | 新建 | 用户决策。isr-reviewer 将废弃 |
| 跨函数松弛深度 | 5 层 + 调用链上无 ISR enable/disable/yield | 覆盖 L3 案例所需，且不会引发 SMT 路径爆炸 |
| CPG 是否共享 | 共享，通过 hash 校验 | 单变量 + 多变量 agent 共用，避免重复构建 5-15 分钟 |
| LLM 输出格式 | 离散三级 STRONG/WEAK/NONE | 复用 multivar-atomicity-checker Step 3.5 经验，避免连续分数幻觉 |
| 工具调用 Joern 方式 | Scala 脚本 + 参数 JSON 文件 | 与现有 multivar-atomicity-checker 一致；脚本独立可维护 |
| TS 工具 vs 直接 Scala | 双层：TS 处理参数与文件 IO，Scala 处理 CPG 查询 | 与现有工具风格一致 |
| 负例扩展是否阻塞主线 | 不阻塞，并行进行 | 第一批 9 个机械派生 1-2 天可完成；难懂负例可在 Phase 4 之前完成 |

---

## 文件清单

新建文件（按目录）：

```
matrix-embedded-agent-master/
├── docs/
│   ├── conflict-detector-contracts.md       (NEW)
│   └── plans/
│       └── 2026-05-18-singlevar-atomicity-p0-skeleton.md  (THIS FILE)
├── src/
│   ├── agents/
│   │   └── singlevar-atomicity-checker.ts  (NEW)
│   ├── schema/
│   │   └── singlevar-atomicity.ts          (NEW)
│   └── tools/
│       ├── singlevar-cpg-get.ts             (NEW, complete)
│       ├── singlevar-pattern-detect.ts      (NEW, skeleton)
│       └── singlevar-feasibility-verify.ts  (NEW, skeleton)
├── skills/
│   └── singlevar-atomicity/
│       └── SKILL.md                         (NEW)
└── joern/
    ├── singlevarAtomicityIdentify.scala     (NEW, skeleton)
    └── singlevarFeasibilityVerify.scala     (NEW, skeleton)

EmbedSVABench/
└── docs/
    ├── negative-cases-expansion-plan.md     (NEW)
    └── tricky-negative-code-templates.md    (NEW)
```

修改文件：

```
src/agents/builtin-agents.ts             (注册新 agent)
src/schema/index.ts                      (导出新 schema)
src/create-tools.ts                      (注册新工具)
src/tools/joern-resolve-cli.ts       (扩展 resolveJoernScriptPath 签名)
```
