# Matrix Embedded Agent — 智能体执行流程与依赖关系

## 1. 智能体总览

系统包含 22 个智能体，按角色分为 5 类：

| 智能体 | 模式 | 类别 | 开销 | 阶段 |
|--------|------|------|------|------|
| **conductor** | primary | 编排 | EXPENSIVE | 0 (全局调度) |
| **planner** | subagent | 工具 | CHEAP | pre-0 |
| **analyst** | subagent | 分析 | EXPENSIVE | 1 |
| **filldata-enricher** | subagent | 分析 | CHEAP | 1 (语义充实) |
| **wiki-scheduler** | subagent | 分析 | EXPENSIVE | 1b |
| **wiki-executor** | subagent | 分析 | EXPENSIVE | 1b |
| **phase2-orchestrator** | subagent | 分析 | EXPENSIVE | 2 |
| **inspector** | subagent | 质量 | EXPENSIVE | 3 |
| **static-analyzer** | subagent | 质量 | CHEAP | 3 |
| **isr-reviewer** | subagent | 质量 | EXPENSIVE | 3 |
| **multivar-atomicity-checker** | subagent | 质量 | EXPENSIVE | 3 (原子性违规检测) |
| **sa-reviewer** | subagent | 质量 | EXPENSIVE | 3 (静态分析三分类) |
| **cr-reviewer** | subagent | 质量 | EXPENSIVE | 3 (质量门) |
| **reviewer** | subagent | 质量 | EXPENSIVE | 2/5/6 (质量门) |
| **unit-tester** | subagent | 测试 | EXPENSIVE | 4 |
| **env-architect** | subagent | 测试 | EXPENSIVE | 5 |
| **test-designer** | subagent | 测试 | EXPENSIVE | 6 |
| **test-executor** | subagent | 测试 | EXPENSIVE | 7 |
| **summarizer** | subagent | 工具 | CHEAP | 8 |
| **oracle** | subagent | 质量 | EXPENSIVE | 任意 (升级) |
| **astgrep** | subagent | 分析 | CHEAP | 独立 |

**Phase 2 调度**：Conductor 路由到 phase2-orchestrator；该协调器使用工作流返回的任务契约委派章节建模 workers。filldata-enricher 保留用于独立章节入口。

---

## 2. 九阶段工作流全景图

```
  ┌─────────────────────────────────────────────────────────┐
  │                     PRE-PHASE                           │
  │   /matrix-plan → Planner (交互式测试范围澄清)            │
  │   输出: .matrix/plans/test-plan.md, matrix.jsonc        │
  └────────────────────────┬────────────────────────────────┘
                           │
                           ▼
  ┌─────────────────────────────────────────────────────────┐
  │  PHASE 0: 任务分类 (Conductor 直接处理)                  │
  │  分类结果: new_project / regression / focused / review_fix│
  │  输出: .matrix/state/progress.json                      │
  └────────────────────────┬────────────────────────────────┘
                           │
                           ▼
  ┌─────────────────────────────────────────────────────────┐
  │  PHASE 1: 软件分析 (Analyst)                            │
  │  输出: software-analysis.json, compile_commands.json,   │
  │        compilation-env.json, software-analysis.md,      │
  └────────────────────────┬────────────────────────────────┘
                           │
                           ▼
  ┌─────────────────────────────────────────────────────────┐
  │  PHASE 1b: 代码知识库生成 (WikiScheduler + WikiExecutor)   │
  │  输入: software-analysis.json, compilation-env.json      │
  │  输出: .matrix/wiki/ (三层JSON), reports/code-wiki/       │
  └────────────────────────┬────────────────────────────────┘
                           │
                           ▼
  ┌─────────────────────────────────────────────────────────┐
  │  PHASE 2: 测试需求设计 (Phase2Orchestrator)                   │
  │  输入: software-analysis.json, wiki (可选)              │
  │  输出: 章节 JSON/DOCX、追踪表和完整 Phase 2 DOCX     │
  │  ┌─────────────────────────┐                            │
  │  │ 🔒 质量门: Reviewer     │ ← PASS/REVISE (最多3轮)    │
  │  │ 输出: reviews/req-review.json                        │
  │  └─────────────────────────┘                            │
  └────────────────────────┬────────────────────────────────┘
                           │
                           ▼
  ┌────────────────────────────────────────────────────────────────────┐
  │  PHASE 3: 代码审查 & 静态分析 (最复杂阶段，见第4节详解)            │
  │                                                                    │
  │  ┌─────────────────────────────────────────────────────────┐       │
  │  │  并行执行层 1                                           │       │
  │  │  ┌─────────────────┐  ┌────────────────┐               │       │
  │  │  │ Inspector       │  │ StaticAnalyzer │               │       │
  │  │  │ (N个聚焦实例,   │  │ (1个实例)      │               │       │
  │  │  │  每需求1个)     │  └────────────────┘               │       │
  │  │  └─────────────────┘  ┌────────────────────┐           │       │
  │  │                       │ ISR-Reviewer       │           │       │
  │  │                       │ (1个实例)          │           │       │
  │  │                       └────────────────────┘           │       │
  │  │                       ┌────────────────────┐           │       │
  │  │                       │ Atomicity-Checker  │           │       │
  │  │                       │ (1个实例)          │           │       │
  │  │                       └────────────────────┘           │       │
  │  └──────────────────────────┬──────────────────────────────┘       │
  │                             │ 全部完成后                           │
  │                             ▼                                      │
  │  ┌─────────────────────────────────────────────────────────┐       │
  │  │  并行执行层 2                                           │       │
  │  │  Inspector runtime-safety ×M (每源文件1个实例)          │       │
  │  └──────────────────────────┬──────────────────────────────┘       │
  │                             │ 全部完成后                           │
  │                             ▼                                      │
  │  ┌─────────────────────────────────────────────────────────┐       │
  │  │  并行执行层 3                                           │       │
  │  │  ┌──────────────────────┐  ┌────────────────┐          │       │
  │  │  │ Inspector 汇总模式   │  │ SA-Reviewer    │          │       │
  │  │  │ (1个实例)            │  │ (1个实例,      │          │       │
  │  │  │ 读取 review-records  │  │  三分类)       │          │       │
  │  │  │ + safety-records     │  └────────────────┘          │       │
  │  │  └──────────────────────┘                              │       │
  │  └──────────────────────────┬──────────────────────────────┘       │
  │                             │                                      │
  │                             ▼                                      │
  │  ┌─────────────────────────────────────────────────────┐           │
  │  │ 🔒 质量门: CR-Reviewer (非通用Reviewer!)             │           │
  │  │ 5个审查维度, PASS/REVISE, 最多3轮                    │           │
  │  │ 输出: reviews/cr-review.json                        │           │
  │  └─────────────────────────────────────────────────────┘           │
  └────────────────────────┬───────────────────────────────────────────┘
                           │
                           ▼
  ┌─────────────────────────────────────────────────────────┐
  │  PHASE 4: 单元测试 (UnitTester)                         │
  │  输入: software-analysis.json, test-requirements.json   │
  │  输出: unit-tests.json, defects.json, unit-test.md      │
  │  无质量门                                               │
  └────────────────────────┬────────────────────────────────┘
                           │
                           ▼
  ┌─────────────────────────────────────────────────────────┐
  │  PHASE 5: 测试环境搭建 (EnvArchitect)                   │
  │  输入: software-analysis.json, test-requirements.json   │
  │  输出: .matrix/test-env/ 目录                           │
  │  ┌─────────────────────────┐                            │
  │  │ 🔒 质量门: Reviewer     │ ← PASS/REVISE (最多3轮)    │
  │  │ 输出: reviews/env-review.json                        │
  │  └─────────────────────────┘                            │
  └────────────────────────┬────────────────────────────────┘
                           │
                           ▼
  ┌─────────────────────────────────────────────────────────┐
  │  PHASE 6: 确认测试用例设计 (TestDesigner)               │
  │  输入: test-requirements.json                           │
  │  输出: source-confirmation-tests.json,                  │
  │        confirmation-tests.json (translated)             │
  │  评审 PASS 后发布: test-cases.md,                       │
  │        confirmation-tests.docx                          │
  │  发布后执行: phase6_execution_loop →                    │
  │        test-execution.json, phase6-execution-loop.json  │
  │  ┌─────────────────────────┐                            │
  │  │ 🔒 质量门: Reviewer     │ ← PASS/REVISE (最多3轮)    │
  │  │ 输出: reviews/case-review.json                       │
  │  └─────────────────────────┘                            │
  └────────────────────────┬────────────────────────────────┘
                           │
                           ▼
  ┌─────────────────────────────────────────────────────────┐
  │  PHASE 7: 测试执行 (TestExecutor, 兼容/手动入口)        │
  │  输入: confirmation-tests.json, .matrix/test-env/       │
  │  输出: test-execution.json, defects.json, test-exec.md  │
  │  无质量门                                               │
  └────────────────────────┬────────────────────────────────┘
                           │
                           ▼
  ┌─────────────────────────────────────────────────────────┐
  │  PHASE 8: 测试总结 (Summarizer)                         │
  │  输入: 所有阶段产出的 .matrix/data/ 制品                 │
  │  输出: test-summary.json, test-summary.md,              │
  │        .matrix/book/ (mdbook HTML站点)                  │
  └─────────────────────────────────────────────────────────┘
```

### 阶段执行依赖关系图

下图以 DAG（有向无环图）形式展示九个阶段之间的依赖关系。阶段 0→1→1b→2 为串行前置链；
阶段 2 完成后，3（代码审查 & 静态分析）、4（单元测试）、6（用例设计 + DTP 执行闭环）进入主流程并行分支；
阶段 5（环境搭建）仅在目标阶段显式需要时启动；阶段 7 保留为兼容/手动执行入口；阶段 8（测试总结）等待 3、4、6 全部完成后汇聚执行。

```
                      ┌──────────────────┐
                      │   0 任务分类      │
                      └────────┬─────────┘
                               │
                      ┌────────▼─────────┐
                      │   1 软件分析      │
                      └────────┬─────────┘
                               │
                      ┌────────▼─────────┐
                      │  1b 代码知识库    │
                      └────────┬─────────┘
                               │
                      ┌────────▼─────────┐
                      │  2 测试需求设计   │
                      └──┬──┬─────┬──┬───┘
                         │  │     │  │
       ┌─────────────────┘  │     │  └─────────────────┐
       │      ┌─────────────┘     └─────────────┐      │
       ▼      ▼                                 ▼      ▼
  ┌──────────┐ ┌──────────┐           ┌──────────┐ ┌──────────┐
  │ 3 代码   │ │ 4 单元   │           │ 5 环境   │ │ 6 用例   │
  │ 审查 &   │ │   测试   │           │ 搭建*    │ │ +执行门禁 │
  │ 静态分析 │ │          │           │          │ │          │
  └────┬─────┘ └────┬─────┘           └──────────┘ └────┬─────┘
       │            │                                   │
       └────────────┼───────────────────────────────────┘
                    │
            ┌───────▼────────┐
            │   8 测试总结    │
            └────────────────┘
```

---

## 3. 智能体调度关系图

Conductor 是唯一的调度中心，所有子智能体由它派发：

```
CONDUCTOR ─────┬──→ PLANNER          (pre-0, 交互式测试规划)
               │                      权限: task=deny, 不可调度其他智能体
               │                      产出: test-plan.md, matrix.jsonc
               │
               ├──→ ANALYST           (Phase 1, 软件分析)
               │     │                产出: software-analysis.json, compile_commands.json,
               │     │                       compilation-env.json
               │
               ├──→ WIKI-SCHEDULER      (Phase 1b, 在 Analyst 完成后)
               │                      依赖: software-analysis.json, compilation-env.json
               │                      产出: .matrix/plans/wiki-generation-plan.json
               │
               │──→ WIKI-EXECUTOR     (由 WikiScheduler 按顺序调度)
               │                      输入: 源代码 + 下层 wiki 上下文
               │                      产出: .matrix/wiki/ (三层JSON), reports/code-wiki/
               │
               ├──→ PHASE2-ORCHESTRATOR (Phase 2, 章节需求文档生成)
               │     │                消费: wiki (可选)
               │     │                产出: 章节 JSON/DOCX、phase2-test-requirements.docx
               │     │
               │     └──→ REVIEWER    (Phase 2 质量门)
               │                      产出: reviews/req-review.json
               │
               ├──→ INSPECTOR ×N      (Phase 3, 聚焦模式, 并行)
               │     │                加载技能: code-review
               │     │                消费: wiki (可选)
               │     │                产出: review-records/<req_id>.json
               │     │
               ├──→ STATIC-ANALYZER   (Phase 3, 与 Inspector 并行)
               │     │                加载技能: static-analysis
               │     │                产出: sa-raw-findings.json, static-analysis.md
               │     │
               ├──→ ISR-REVIEWER      (Phase 3, 与 Inspector 并行)
               │     │                加载技能: interrupt-review
               │     │                产出: defects.json (append), interrupt-review.md
               │     │
               ├──→ ATOMICITY-CHECKER (Phase 3, 与 Inspector 并行)
               │     │                加载技能: multivar-atomicity
               │     │                产出: multivar-correlated-groups.json, multivar-candidates.json,
               │     │                       multivar-violations.json, multivar-confirmed.json,
               │     │                       multivar-violation.md
               │     │
               │     └── 等待以上全部完成 ──→
               │
               ├──→ INSPECTOR ×M      (Phase 3, runtime-safety 模式, 并行)
               │     │                每源文件一个实例
               │     │                产出: safety-records/<FILENAME>.json
               │     │
               │     └── 等待以上全部完成 ──→
               │
               ├──→ INSPECTOR ×1      (Phase 3, 汇总模式)
               │     │                读取: review-records/*.json, safety-records/*.json
               │     │                产出: defects.json (append), code-review.md
               │     │
               ├──→ SA-REVIEWER       (Phase 3, 与 Inspector 汇总并行)
               │     │                加载技能: static-analysis-review
               │     │                读取: sa-raw-findings.json
               │     │                产出: defects.json (append), false-positives.json,
               │     │                       standards-only.json, static-analysis-review.md
               │     │
               │     └── 等待以上全部完成 ──→
               │
               │           └──→ CR-REVIEWER (Phase 3 质量门)
               │                          产出: reviews/cr-review.json
               │
               ├──→ UNIT-TESTER       (Phase 4, 单元测试)
               │                      加载技能: functional-case-gen
               │                      消费: wiki (可选)
               │                      产出: unit-tests.json, defects.json, unit-test.md
               │
               ├──→ ENV-ARCHITECT     (Phase 5, 测试环境)
               │     │                消费: wiki (可选)
               │     │                产出: .matrix/test-env/
               │     │
               │     └──→ REVIEWER    (Phase 5 质量门)
               │                      产出: reviews/env-review.json
               │
               ├──→ TEST-DESIGNER     (Phase 6, 确认测试设计)
               │     │                消费: wiki (可选)
               │     │                产出: source-confirmation-tests.json,
               │     │                       confirmation-tests.json (translated)
               │     │
               │     └──→ REVIEWER    (Phase 6 质量门)
               │                      产出: reviews/case-review.json
               │
               ├──→ SUMMARIZER        (Phase 8, 测试总结)
               │                      产出: test-summary.json, test-summary.md, book/
               │
               └──→ ORACLE            (任意阶段, 3次失败后升级)
                                      权限: write=deny, edit=deny, bash=deny, task=deny
                                      纯只读咨询, 不产出文件
```

**独立智能体：**
- **ASTGREP**：通过 `/matrix-astgrep` 独立调用，或被 ISR-Reviewer 通过 `astgrep_run` 工具间接使用，不参与九阶段流程。

---

## 4. Phase 3 内部执行流程详解

Phase 3 是最复杂的阶段，包含 9 步、N+M+4 个并行智能体调用：

```
Step 1: Conductor 读取 software-analysis.json 需求列表
        将需求分为 has_linked (有关联函数) 和 no_linked (无关联函数) 两组

Step 2: 并行调度 (run_in_background=true)
        ┌─────────────────────────────────────────────────────────┐
        │                                                         │
        │  Inspector 聚焦模式 ×N (每个需求一个实例)                │
        │  ├── has_linked 需求: 标准聚焦审查                       │
        │  └── no_linked 需求: 触发代码发现步骤2.5                 │
        │      (grep搜索相关代码, 找不到则记NO_IMPL缺陷)            │
        │                                                         │
        │  StaticAnalyzer ×1 (与Inspector并行)                     │
        │  ├── 运行 SpecChecker 合规性分析                         │
        │  ├── 产出: sa-raw-findings.json, static-analysis.md      │
        │  └── 不直接写 defects.json (由 SA-Reviewer 分类)          │
        │                                                         │
        │  ISR-Reviewer ×1 (与Inspector并行)                       │
        │  ├── 审计中断数据访问冲突 (C1-C5模式)                     │
        │  └── 产出: defects.json (append), interrupt-review.md    │
        │                                                         │
        │  Atomicity-Checker ×1 (与Inspector并行)                  │
        │  ├── Joern CPG 构建                                      │
        │  ├── 关联变量组识别 (SVC/DAC)                             │
        │  ├── 5模式违规检测 (SVC_RW, SVC_WR, SVC_WW, DAC_RW)      │
        │  ├── Z3 可行性验证                                       │
        │  └── 产出: multivar-correlated-groups.json, multivar-candidates.json, │
        │           multivar-violations.json, multivar-confirmed.json, │
        │           multivar-violation.md                          │
        │                                                         │
        └───────────────────────┬─────────────────────────────────┘
                                │
Step 3: 等待 Step 2 全部完成
        验证 .matrix/data/review-records/ 包含 N 个 JSON 文件
                                │
                                ▼
Step 4: 并行调度 per-file runtime-safety 分析
        ┌─────────────────────────────────────────────────────────┐
        │                                                         │
        │  Inspector runtime-safety ×M (每源文件一个实例)          │
        │  ├── 针对每个 .c/.cpp 源文件                              │
        │  └── 产出: safety-records/<FILENAME>.json                │
        │                                                         │
        └───────────────────────┬─────────────────────────────────┘
                                │
Step 5: 等待 Step 4 全部完成
        验证 .matrix/data/safety-records/ 包含 M 个 JSON 文件
                                │
                                ▼
Step 6: 并行调度 (run_in_background=true)
        ┌─────────────────────────────────────────────────────────┐
        │                                                         │
        │  Inspector 汇总模式 ×1                                   │
        │  ├── 读取所有 review-records/*.json + safety-records/*.json│
        │  ├── 完整性检查 + 跨需求一致性分析                        │
        │  ├── 合并缺陷, 分配顺序ID (DEF-CR-001, ...)              │
        │  ├── 通过 append_defects 写入 defects.json                │
        │  └── 生成 code-review.md 报告                            │
        │                                                         │
        │  SA-Reviewer ×1 (与Inspector汇总并行)                    │
        │  ├── 读取 sa-raw-findings.json                           │
        │  ├── 三分类: 功能缺陷 / 误报 / 仅标准违规                 │
        │  ├── 功能缺陷 → append_defects 写入 defects.json          │
        │  │   (source: static_analysis)                           │
        │  ├── 误报 → false-positives.json                         │
        │  ├── 仅标准违规 → standards-only.json                     │
        │  └── 生成 static-analysis-review.md                      │
        │                                                         │
        └───────────────────────┬─────────────────────────────────┘
                                │
Step 7: 等待 Step 6 完成
                                │
                                ▼
Step 8: CR-Reviewer 质量门 (顺序执行)
        ┌─────────────────────────────────────────────────────────┐
        │  5个审查维度:                                            │
        │  ① 需求覆盖完整性 (BLOCKING: <100%)                      │
        │  ② 子项覆盖 (BLOCKING: 4+子句只有1-2子项)                │
        │  ③ MISMATCH→缺陷映射 (BLOCKING: 未映射)                  │
        │  ④ 缺陷描述质量 (MAJOR: >20%模糊)                        │
        │  ⑤ 维度覆盖 (D9必需, D10硬件相关时必需)                   │
        │                                                         │
        │  输出: reviews/cr-review.json                            │
        └───────────────────────┬─────────────────────────────────┘
                                │
Step 9: 处理 CR-Reviewer 判定
        ├── PASS → 标记 Phase 3 完成
        ├── REVISE → 重新调度针对性修复, 再审 (最多3轮)
        └── 3次 REVISE → Oracle 升级
```

**并发写入安全**：Inspector汇总、SA-Reviewer、ISR-Reviewer 三者都写 `defects.json`，通过 `append_defects` 工具实现并发安全（按 `replace_source` 参数隔离不同来源的缺陷）。

**SA-Reviewer 三分类说明**：SA-Reviewer 基于 139 条不可判定规则分类法，将 SpecChecker 原始发现分为三类：
1. **功能缺陷** (`defects.json`)：违反规则且影响程序语义正确性的发现
2. **误报** (`false-positives.json`)：经分析确认为工具误判的发现
3. **仅标准违规** (`standards-only.json`)：违反编码规范但不影响功能的发现

**Atomicity-Checker 说明**：基于 Joern 代码属性图 (CPG) 构建程序模型，识别状态向量分量 (SVC) 和数据访问关联 (DAC) 变量组，通过 5 模式匹配检测潜在原子性违规，最终使用 Z3 SMT 求解器验证可行性。

---

## 5. 质量门机制

### 5.1 通用质量门 (Reviewer, 用于 Phase 2/5/6)

```
阶段智能体产出制品
       │
       ▼
  Conductor 调度 Reviewer
       │
       ├── PASS → 标记阶段完成, 进入下一阶段
       │
       └── REVISE → 反馈发回阶段智能体修订
                     │
                     └── 修订完成后重新调度 Reviewer
                         │
                         ├── PASS → 完成
                         └── REVISE → 第2轮...
                                      │
                                      └── 第3轮 REVISE → Oracle 升级
```

### 5.2 代码审查质量门 (CR-Reviewer, 仅 Phase 3)

与通用质量门类似，但审查内容完全不同：CR-Reviewer 不审查代码，而是审查 Inspector 的审查质量本身（元审查）。

### 5.3 质量门触发保障

质量门由两个层级保障：
1. **Conductor 提示词**：在阶段逻辑中显式调度 Reviewer/CR-Reviewer
2. **review-enforcer 钩子**：运行时检测，如果可审查阶段完成但未经过审查，注入 `[REVIEW REQUIRED]` 消息强制 Conductor 执行审查

---

## 6. Oracle 升级机制

### 触发条件 (满足任一)

| 条件 | 来源 |
|------|------|
| 质量门连续 3 次 REVISE | Conductor 提示词逻辑 |
| 子智能体连续 3 次失败 | Conductor 提示词逻辑 |
| 自动失败检测达 3 次 | failure-escalation 钩子 |

### Oracle 特性

- **纯只读**：`write=deny`, `edit=deny`, `bash=deny`, `task=deny`
- **深度思考**：启用 `thinking` 模式，32000 token 预算
- 读取所有制品 → 诊断根因 → 输出咨询建议
- Conductor 接收建议后决定重试策略；若仍失败则工作流停止

---

## 7. 钩子系统对执行流的影响

10 个钩子在运行时拦截事件，影响智能体行为：

| 钩子 | 类型 | 作用 |
|------|------|------|
| **phase-gate** | tool.execute.after | 阻止智能体写入超前阶段的制品 |
| **review-enforcer** | chat.message | 强制可审查阶段执行质量门 |
| **failure-escalation** | chat.message | 检测失败关键词, 累计3次触发Oracle |
| **progress-tracker** | event + tool.after | 根据制品创建自动推进阶段状态 |
| **context-preloader** | chat.message | 按当前阶段注入上游数据摘要 |
| **evidence-tracker** | tool.execute.after | 记录制品产出的阶段来源 |
| **traceability-injector** | system.transform | 向智能体系统提示注入需求追溯矩阵 |
| **artifact-validator** | tool.execute.after | 验证 JSON 制品符合 Zod schema |
| **schema-validator** | tool.execute.after | 补充 schema 验证 |
| **metrics-tracker** | event | 记录各智能体 token 用量、成本和耗时 |

---

## 8. 数据流依赖矩阵

每个阶段读取（消费）和写入（产出）的核心制品：

| 阶段 | 智能体 | 读取 | 写入 |
|------|--------|------|------|
| 0 | Conductor | — | progress.json |
| 1 | Analyst | 源代码, 需求文档 | software-analysis.json, compile_commands.json, compilation-env.json |
| 2 | → phase2-orchestrator | 项目需求文档 | 各章节 JSON/DOCX、覆盖追踪表、完整 Phase 2 DOCX |
| 1b | WikiScheduler + WikiExecutor | software-analysis.json, compilation-env.json, 源代码 | .matrix/plans/wiki-generation-plan.json, wiki/ (JSON), reports/code-wiki/ (MD) |
| 2 | Phase2Orchestrator | 项目需求文档 | 章节 JSON/DOCX、追踪表、完整 Phase 2 DOCX |
| 2-gate | Reviewer | 章节 JSON、来源证据、追踪表、完整 Phase 2 DOCX | reviews/req-review.json |
| 3 | Inspector ×N | software-analysis.json, compilation-env.json, wiki/, 源代码 | review-records/*.json |
| 3 | StaticAnalyzer | 源代码, compile_commands.json, compilation-env.json | sa-raw-findings.json, static-analysis.md |
| 3 | ISR-Reviewer | compilation-env.json, software-analysis.json, 源代码 | defects.json (append), interrupt-review.md |
| 3 | Atomicity-Checker | compilation-env.json, software-analysis.json, 源代码 | multivar-correlated-groups.json, multivar-candidates.json, multivar-violations.json, multivar-confirmed.json, multivar-violation.md |
| 3 | Inspector ×M (runtime-safety) | 源代码, compilation-env.json | safety-records/*.json |
| 3 | Inspector 汇总 | review-records/*.json, safety-records/*.json | defects.json (append), code-review.md |
| 3 | SA-Reviewer | sa-raw-findings.json | defects.json (append), false-positives.json, standards-only.json, static-analysis-review.md |
| 3-gate | CR-Reviewer | review-records/*.json, defects.json, code-review.md | reviews/cr-review.json |
| 4 | UnitTester | software-analysis.json, test-requirements.json, wiki/ | unit-tests.json, defects.json, unit-test.md |
| 5 | EnvArchitect | software-analysis.json, test-requirements.json, wiki/ | .matrix/test-env/ |
| 5-gate | Reviewer | test-env/ | reviews/env-review.json |
| 6 | TestDesigner + phase6_execution_loop | test-requirements.json, confirmation-tests.json, DTPProject | source-confirmation-tests.json, confirmation-tests.json, test-execution.json, phase6-execution-loop.json |
| 6-gate | Reviewer | source-confirmation-tests.json | reviews/case-review.json |
| 7 | TestExecutor (legacy/manual) | confirmation-tests.json, .matrix/test-env/, wiki/ | test-execution.json, defects.json, test-exec.md |
| 8 | Summarizer | 所有 .matrix/data/ 制品 | test-summary.json, test-summary.md, book/ |

---

## 9. Wiki 消费模式

Phase 1b 生成的代码知识库被 6 个下游智能体消费：

```
           WikiScheduler + WikiExecutor (Phase 1b)
                         │
            .matrix/wiki/index.json
                         │
         ┌───────┬───────┼───────┬───────┬───────┐
         │       │       │       │       │       │
         ▼       ▼       ▼       ▼       ▼       ▼
   Phase2Orchestrator Inspector UnitTester EnvArchitect TestDesigner phase6_execution_loop
    (Phase 2)  (Phase 3)  (Phase 4)  (Phase 5*)  (Phase 6)   (Phase 6 gate)
```

每个消费者检查 `.matrix/wiki/index.json` 是否存在，优先使用 wiki 数据而非直接读源码。

---

## 10. 技能加载模式

10 个智能体通过 `skill` 工具按需加载技能文件：

| 智能体 | 技能 | 用途 |
|--------|------|------|
| Inspector | `code-review` | D1-D10审查维度方法论 |
| StaticAnalyzer | `static-analysis` | 编译日志诊断与静态分析方法论 |
| ISR-Reviewer | `interrupt-review` | C1-C5中断冲突模式 |
| Atomicity-Checker | `multivar-atomicity` | 5模式原子性违规检测方法论 |
| SA-Reviewer | `static-analysis-review` | 三分类判定方法论 (139条不可判定规则) |
| UnitTester | `functional-case-gen` | 功能测试用例生成方法论 |
| WikiScheduler | `code-wiki` | 知识库生成方法论 |
| WikiExecutor | `code-wiki` | 知识库生成方法论 |
| Astgrep | `ast-grep-rules` | YAML规则语法参考 |

技能是工具结果（按需加载），不是系统消息。智能体需要同时满足：`skill: true` 在工具权限中 + 提示词中包含加载指令。

---

## 11. 阶段状态机

```
                                    ┌──────────┐
                                    │ skipped  │ (regression/focused模式可跳过)
                                    └──────────┘
                                         ▲
                                         │
┌─────────┐     ┌─────────────┐     ┌────┴──────┐     ┌───────────┐
│ pending │────→│ in_progress │────→│ completed │────→│ 下一阶段   │
└─────────┘     └──────┬──────┘     └───────────┘     └───────────┘
                       │                 ▲
                       │                 │ PASS
                       ▼                 │
                ┌──────────────┐   ┌─────┴──────────┐
                │review_pending│──→│review_in_progress│
                └──────────────┘   └──────┬──────────┘
                       ▲                  │ REVISE
                       │                  ▼
                       │          ┌───────────────┐
                       └──────────│revision_needed│
                                  └───────┬───────┘
                                          │ 3次失败
                                          ▼
                                  ┌───────────────┐
                                  │    failed     │ → Oracle升级
                                  └───────────────┘
```

---

## 12. 斜杠命令入口

| 命令 | 目标智能体 | 模式 | 说明 |
|------|-----------|------|------|
| `/matrix-start` | conductor | 顶层 | 启动完整九阶段流程 |
| `/matrix-plan` | planner | 顶层 | 交互式测试规划访谈 |
| `/matrix-analyze` | analyst | 子任务 | Phase 1 软件分析 |
| `/matrix-wiki` | wiki-scheduler | 子任务 | Phase 1b 代码知识库与 DeepWiki 文档生成 |
| `/matrix-review` | reviewer | 子任务 | 当前阶段质量门审查 |
| `/matrix-test` | unit-tester | 子任务 | Phase 4 单元测试 |
| `/matrix-dynamic-design` | conductor | 顶层 | Phase 6 Step 1–5：用例生成、审查与正式发布 |
| `/matrix-dynamic-test` | conductor | 顶层 | Phase 6 Step 1–7：在设计发布后继续 Robot/DTP 生成与执行门禁 |
| `/matrix-status` | conductor | 子任务 | 显示当前阶段进度 |
| `/matrix-report` | summarizer | 子任务 | Phase 8 生成测试总结 |
| `/matrix-metrics` | conductor | 子任务 | 显示各智能体 token 用量和成本 |
| `/matrix-astgrep` | astgrep | 顶层 | AST级结构化代码搜索 |
| `/matrix-static` | static-analyzer | 顶层 | SpecChecker 静态分析 |
| `/matrix-isr-review` | isr-reviewer | 顶层 | 中断数据访问冲突审计 |
| `/matrix-multivar-atomicity` | multivar-atomicity-checker | 子任务 | 原子性违规检测 |

**顶层**命令作为独立交互运行；**子任务**命令在当前会话内作为子任务运行。

---

## 13. 关键架构特性总结

1. **单点编排**：Conductor 是唯一拥有 `task` 权限的智能体，所有跨智能体协作由它中转调度。
3. **双层保障**：阶段顺序、质量门、失败升级均在提示词逻辑（Conductor）和运行时钩子两个层级保障。
4. **Phase 3 最复杂**：包含 N+M+4 个并行智能体（N 聚焦审查 + M runtime-safety + StaticAnalyzer + ISR-Reviewer + Atomicity-Checker + SA-Reviewer）+ 1 个汇总 + 1 个质量门，并发写入通过 `append_defects` 工具保证安全。
5. **Oracle 终端咨询**：纯只读、不可写、不可调度，仅提供根因分析和建议。
6. **Wiki 扇出模式**：Phase 1b 产出被 6 个下游阶段消费，减少重复源码阅读。
7. **技能懒加载**：8 个智能体按需加载方法论技能，分离操作逻辑与方法论知识。


Phase 2 章节工作流不发布下游 flat `test-requirements.json`。单元测试与 Phase 6 仍使用该输入契约；运行前必须验证其存在且有效，缺失时报告输入缺口，不将章节 DOCX 当作替代。
