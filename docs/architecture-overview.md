# Matrix Embedded Agent 架构全览

## 九阶段工作流

```
Phase 0: 任务分类
    │  Conductor 分类任务，确定目标阶段
    ▼
Phase 1: 软件分析
    │  Analyst 解析编译环境、代码和需求文档
    ▼
Phase 1b: 代码 Wiki 生成
    │  WikiBuilder 构建语义级代码知识库
    ▼
Phase 2: 测试需求设计 ← 质量门(Reviewer)
    │  ReqArchitect 设计测试需求 + 可追溯性
    ▼
    ┌──────────────┬──────────────┬──────────────┐  (并行)
    ▼              ▼              ▼              ▼
Phase 3:       Phase 4:       Phase 5:       Phase 6:
代码审查&静态  单元测试        测试环境        确认测试设计
← 质量门       UnitTester     ← 质量门       ← 质量门
(CR-Reviewer)                 (Reviewer)     (Reviewer)
    │              │              │              │
    │              │              └──────┬───────┘
    │              │                     ▼
    │              │              Phase 7: 测试执行
    │              │                TestExecutor
    │              │                     │
    └──────────────┴─────────────────────┘
                        ▼
                 Phase 8: 测试总结
                   Summarizer 生成报告
```

**依赖关系**: `0→1→1b→2→{3,4,5,6 并行}→7(需5+6)→8(需3+4+7)`

---

## 19 个智能体

### 编排类

| 智能体 | 阶段 | 职责 |
|--------|------|------|
| `conductor` | 0 | 主路由，任务分类，确定目标阶段 |
| `planner` | pre-0 | 交互式测试范围澄清 |

### 分析类

| 智能体 | 阶段 | 职责 |
|--------|------|------|
| `analyst` | 1 | 编译环境搭建 + 代码/需求解析 |
| `phase2-orchestrator` | 2 | 测试需求设计 |
| `astgrep` | — | AST 级结构化代码搜索 |
| `wiki-builder` | 1b | 代码理解知识库生成 |

### 测试类

| 智能体 | 阶段 | 职责 |
|--------|------|------|
| `inspector` | 3 | 代码审查（全需求，并行聚焦审查） |
| `static-analyzer` | 3 | 原始静态分析违规检测 → `sa-raw-findings.json` |
| `unit-tester` | 4 | 单元测试设计与覆盖率迭代 |
| `test-designer` | 6 | 确认测试用例设计 |
| `test-executor` | 7 | 测试执行 |
| `env-architect` | 5 | 测试环境搭建 |

### 质量类

| 智能体 | 阶段 | 职责 |
|--------|------|------|
| `reviewer` | 2/5/6 | 质量门审查 |
| `cr-reviewer` | 3 | 代码审查质量门 |
| `sa-reviewer` | 3 | 静态分析结果三级分类（缺陷/误报/仅标准） |
| `isr-reviewer` | 3 | 中断数据访问冲突审计 (C1-C5 模式) |
| `multivar-atomicity-checker` | 3 | 多变量原子性违规检测 (Joern CPG + Z3) |
| `oracle` | — | 连续失败后的升级处理 |
| `summarizer` | 8 | 最终测试报告生成 |

---

## Phase 3 内部流程

Phase 3 是最复杂的阶段，包含多个子步骤：

```
┌─────────────────────────────────────────────────────────┐
│  Step 1 (并行启动)                                       │
│  ┌───────────┐ ┌───────────────┐ ┌────────────┐ ┌─────────────────┐ │
│  │ Inspector  │ │StaticAnalyzer │ │ISR-Reviewer│ │MultivarAtomicityChecker │ │
│  │ 代码审查   │ │ 静态分析      │ │ 中断审计   │ │ 原子性检测      │ │
│  └─────┬─────┘ └──────┬────────┘ └─────┬──────┘ └────────┬────────┘ │
│        │               │               │                 │          │
│  Step 2 (Step 1 全部完成后，并行)                          │
│  ┌─────┴─────┐ ┌──────┴────────┐                         │
│  │ Inspector  │ │  SA-Reviewer  │                         │
│  │  Summary   │ │ 三级分类      │                         │
│  └─────┬─────┘ └──────┬────────┘                         │
│        │               │                                  │
│  Step 3 (质量门)                                          │
│  ┌─────┴───────────────┴──┐                               │
│  │     CR-Reviewer        │                               │
│  │  代码审查质量门         │                               │
│  └────────────────────────┘                               │
└─────────────────────────────────────────────────────────┘
```

### 原子性检测管线 (MultivarAtomicityChecker 内部)

```
Step 1: Joern CPG 创建
    joern-parse 生成代码属性图 (.bin)
        │
Step 2: 关联变量识别 (Tool A: multivar-correlated-vars)
    Joern Scala 脚本 → 3 种锚点 (DFC/TUP/DAC)
    AQ + OE + LLM 三层评分模型过滤
    输出: anchor.json → correlatedVars.json → correlatedVars_llm.json
        │
Step 3: 违规模式匹配 (Tool B: multivar-violation-detect)
    5 种 4 字访问序模式:
    • DFC_RWWR  • TUP_WRRW  • TUP_WWWW  • DAC_RWWW  • DAC_RWWR
    跨 Task↔ISR 和 ISR↔ISR 边界匹配
    输出: multivar-violations.json
        │
Step 4: 可行性验证 (Tool C: multivar-feasibility-verify)
    Joern CFG 路径可达性 + Z3 SMT 求解
    输出: CONFIRMED / INFEASIBLE / UNKNOWN
    输出: multivar-confirmed.json
```

---

## 16 个技能 (Skills)

技能以 `SKILL.md` 文件形式存放在 `skills/<name>/SKILL.md`，由智能体按需加载。

| 技能 | 阶段 | 用途 |
|------|------|------|
| `test-planning` | pre-0 | 访谈式测试范围规划 |
| `software-analysis` | 1 | 代码与需求分析方法论 |
| `code-wiki` | 1b | 代码知识库生成方法论 |
| `test-requirements` | 2 | 测试需求设计 + 可追溯性 |
| `code-review` | 3 | 手动代码审查（对照编码标准） |
| `static-analysis` | 3 | 自动化 MISRA/静态缺陷检测（含 compile_log 诊断级联去重和决策树） |
| `static-analysis-review` | 3 | 静态分析发现三级分类（139 条不可判定规则分类，Phase 3.5 触发条件分析） |
| `interrupt-review` | 3 | 中断数据访问冲突审计 |
| `multivar-atomicity` | 3 | 多变量原子性违规检测 (DFC/TUP/DAC 锚点, 5 种模式, Z3 验证) |
| `unit-testing` | 4 | 单元测试设计、驱动/桩、覆盖率迭代 |
| `functional-case-gen` | 4 | 功能测试用例生成方法论 |
| `test-environment` | 5 | 仿真环境设计 |
| `test-design` | 6 | 确认测试用例设计 |
| `test-execution` | 7 | 逐步测试执行 |
| `test-summary` | 8 | 最终报告 + 通过/失败结论 |
| `ast-grep-rules` | — | ast-grep YAML 规则编写参考（原子/关系/组合规则，C/C++ 技巧） |

---

## 12 个斜杠命令

| 命令 | 绑定智能体 | 用途 |
|------|-----------|------|
| `/matrix-start` | conductor | 启动完整 9 阶段流程 |
| `/matrix-plan` | planner | 交互式测试规划访谈 |
| `/matrix-analyze` | analyst | 代码与需求分析 (Phase 1) |
| `/matrix-review` | reviewer | 当前阶段质量门审查 |
| `/matrix-test` | unit-tester | 单元测试 + 覆盖率迭代 (Phase 4) |
| `/matrix-status` | conductor | 显示当前阶段进度 |
| `/matrix-report` | summarizer | 生成最终测试报告 (Phase 8) |
| `/matrix-metrics` | conductor | 显示各智能体 token 用量、成本与耗时 |
| `/matrix-astgrep` | astgrep | AST 结构化代码搜索 |
| `/matrix-static` | static-analyzer | 运行 SpecChecker 静态分析 (Phase 3) |
| `/matrix-isr-review` | isr-reviewer | 中断数据访问冲突审计 (C1-C5) |
| `/matrix-multivar-atomicity` | multivar-atomicity-checker | 原子性违规检测 (DFC/TUP/DAC) |

---

## 39 个工具

### 解析工具

| 工具 | 用途 |
|------|------|
| `req-parser` | 需求文档解析 |
| `code-parser` | C/C++ 源码解析 |
| `compdb-generator` | 构建系统检测 + `compile_commands.json` 生成 (CMake/Make/Keil/IAR/Eclipse/推断) |
| `header-stub-generator` | 缺失厂商/BSP/RTOS 头文件桩生成 |
| `code-preprocessor` | 方言翻译：编译器特有构造→标准 C/C++ (GCC/ARMCC/IAR/Keil/GHS/TI/WindRiver) |

### 静态分析工具

| 工具 | 用途 |
|------|------|
| `misra-checker` | SpecChecker 封装，航空 C 编码标准分析 (5 级自动发现) |
| `astgrep-runner` | AST 级结构化代码搜索 (Pattern 模式 + YAML Rule 模式) |

### 测试工具

| 工具 | 用途 |
|------|------|
| `unit-runner` | 单元测试运行 |
| `test-executor` | 测试执行 |
| `coverage-report` | 覆盖率报告 |
| `test-env-ctrl` | 环境搭建/拆除 |

### 报告构建工具

| 工具 | 用途 |
|------|------|
| `doc-generator` | 基于模板的 Markdown 报告生成 |
| `ct-suite-builder` | 增量式确认测试套件构建 (3 工具: create/add_case/finalize) |
| `ut-report-builder` | 增量式单元测试报告构建 (4 工具: create/add_case/add_result/finalize) |
| `exec-report-builder` | 增量式测试执行报告构建 (3 工具: create/add_execution/finalize) |
| `mdbook-generator` | Markdown 报告→可浏览 HTML 站点 (bundled mdbook) |
| `issue-report-generator` | 生成 DOCX 问题报告单 (模板占位符替换，无 LLM 调用) |
| `append-defects` | 原子并发安全追加 `defects.json` |

### 原子性检测工具

| 工具 | 用途 |
|------|------|
| `multivar-cpg-create` | Joern 代码属性图创建 (`joern-parse`) |
| `multivar-correlated-vars` | 关联变量组识别 (DFC/TUP/DAC)，评分过滤 |
| `multivar-violation-detect` | 5 种违规模式匹配 (Task↔ISR, ISR↔ISR) |
| `multivar-feasibility-verify` | Joern CFG + Z3 SMT 可行性验证 |

### AUnit 工具 (9 个)

| 工具 | 用途 |
|------|------|
| `aunit_create_project` | 创建 AUnit 项目 |
| `aunit_build` | 构建 |
| `aunit_autogen` | 自动生成测试 |
| `aunit_run_case` | 运行测试用例 |
| `aunit_report` | 生成报告 |
| `aunit_inject_cases` | 注入测试用例 |
| `aunit_enrich_cases` | 增强测试用例 |
| `aunit_sync_report` | 同步报告 |
| `aunit_list_platforms` | 列出平台 |

---

## 9 个 Hook

Hook 拦截 OpenCode 事件，分三个层级：

### Chat Hook (聊天级)

| Hook | 用途 |
|------|------|
| `review-enforcer` | 强制质量门审查 |
| `context-preloader` | 加载上下文 |
| `failure-escalation` | 连续 3 次失败后触发 Oracle 升级 |

### Tool Hook (工具级)

| Hook | 用途 |
|------|------|
| `phase-gate` | 强制阶段依赖（active_phases 成员检查 + 依赖完成检查） |
| `evidence-tracker` | 制品溯源 |
| `artifact-validator` | Schema 验证 |
| `progress-tracker` | 更新阶段状态 |

### System Hook (系统级)

| Hook | 用途 |
|------|------|
| `traceability-injector` | 需求链注入 |
| `schema-validator` | 数据 Schema 验证 |

---

## 关键机制

### 阶段状态管理

- **DAG 模型**: `progress.json` 跟踪 `target_phases`（用户选择的目标）和 `active_phases`（传递依赖闭包）
- `resolveActivePhases(targets)` 计算所需的全部阶段集合
- `getReadyPhases()` 返回依赖已全部完成的就绪阶段
- 已移除旧版 `current_phase` 线性游标

### 质量门

- Phase 2 / 3 / 5 / 6 设有审查门
- Phase 3 使用 `cr-reviewer`（非通用 `reviewer`）
- REVISE 仅阻塞当前阶段，不影响并行阶段

### 数据流

```
.matrix/
├── config/matrix.jsonc        # 插件配置
├── data/                      # JSON 数据存储 (Zod 校验)
│   ├── software-analysis.json
│   ├── test-requirements.json
│   ├── defects.json
│   ├── sa-raw-findings.json
│   ├── false-positives.json
│   ├── standards-only.json
│   ├── anchor.json
│   ├── correlatedVars.json
│   ├── correlatedVars_llm.json
│   ├── multivar-correlated-groups.json
│   ├── multivar-violations.json
│   └── multivar-confirmed.json
├── state/progress.json        # 阶段状态
├── cpg/                       # Joern 代码属性图 (.bin)
├── wiki/                      # 代码知识库 (三层: index→module→function)
├── reports/                   # 生成的 Markdown 报告
│   └── code-wiki/             # DeepWiki 风格文档
├── plans/                     # 执行计划
├── stubs/                     # 生成的桩头文件
├── preprocessed/              # 方言翻译后的源文件
└── book/                      # mdbook HTML 站点
```

### 合规标准

- GJB 5000A — 军用软件质量管理
- GJB 2725 — 军用软件测试
- GJB 141 — 军用软件编码标准
- DO-178C — 机载软件适航认证
- IEC 61508 — 功能安全

---

## 技术栈

| 项目 | 技术 |
|------|------|
| 运行时 | Bun (非 Node.js) |
| 语言 | TypeScript (strict, ESNext, ESM) |
| 框架 | OpenCode Plugin SDK |
| Schema 校验 | Zod |
| 配置格式 | JSONC |
| 外部工具 | Joern (CPG), Z3 (SMT), SpecChecker (MISRA), mdbook, ast-grep |
