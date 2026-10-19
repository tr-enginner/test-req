# SA-Reviewer — 静态分析结果审查 Agent 设计

**Date**: 2026-02-25
**Status**: Approved
**Supersedes**: `2026-02-25-static-fp-elimination-design.md`（FP 二元分类方案，被本设计的三类分类方案取代）

---

## 概述

在 Phase 3 StaticAnalyzer 完成后、CR-Reviewer 质量门之前，插入独立的 **SA-Reviewer** agent，对静态分析原始违规进行三类分类审查：

| 分类 | 含义 | 输出目标 |
|------|------|---------|
| **功能缺陷** | 导致运行时错误/UB/安全隐患（规范类违规也可能属此类） | `defects.json` |
| **规范违规（无功能影响）** | 仅影响可维护性，不影响运行结果 | 仅写报告 |
| **误报** | 工具错误告警（重点：不可判定规则场景） | `false-positives.json` |

---

## 问题背景

StaticAnalyzer 当前直接将 SpecChecker 违规写入 `defects.json`，存在两个问题：

1. **无三类区分**：所有违规被视为缺陷，规范类违规和功能缺陷混在一起，影响优先级判断和后续修复决策。
2. **无误报消除**：不可判定规则（如 goto、magic number、循环复杂度）产生的误报直接进入缺陷数据库，增加人工审查负担。

本设计通过引入独立的 SA-Reviewer agent 和配套 skill 文件，系统性解决上述两个问题。

---

## 架构设计

### Phase 3 更新后工作流

```
Step 1: Conductor 读取需求列表（不变）
Step 2: 并行分发 Inspector focused reviews（N 个并行，不变）
Step 3: 并行分发 StaticAnalyzer（不变，但输出目标变更）
Step 4: 等待所有 focused reviews + StaticAnalyzer 完成（不变）
Step 5: 并行运行（新增并行分支）
        ├── Inspector Summary（现有，不变）
        └── SA-Reviewer（新增）
Step 6: CR-Reviewer 质量门（现有，仅审查代码审查产物，不变）
```

### 数据流

```
StaticAnalyzer
  └─ SpecChecker tool → sa-raw-findings.json（原始违规，不写 defects.json）

SA-Reviewer（读 sa-raw-findings.json + 源码上下文）
  ├─ 功能缺陷 → 合并写入 defects.json（source: "static_analysis"）
  ├─ 误报     → false-positives.json
  └─ 规范违规 → static-analysis-review.md（报告章节，不写数据文件）
```

---

## `sa-raw-findings.json` 数据模型

```json
{
  "project_name": "string",
  "analysis_date": "ISO 8601",
  "tool": "specchecker",
  "source_dir": "/path/to/src",
  "summary": {
    "total": 42,
    "by_severity": { "critical": 2, "major": 15, "minor": 25 },
    "by_fixability": { "auto_fixable": 10, "needs_review": 20, "unfixable": 12 }
  },
  "violations": [
    {
      "id": "RAW-001",
      "rule_id": "CID181",
      "rule_name": "禁止使用goto语句",
      "severity": "major",
      "conformance": "mandatory",
      "fixability": "auto_fixable",
      "file": "src/main.c",
      "line": 47,
      "code_snippet": "goto error_handler;",
      "patch": null
    }
  ]
}
```

---

## SA-Reviewer Agent 设计

**文件**：`src/agents/sa-reviewer.ts`
**模式**：subagent
**颜色**：`#1ABC9C`
**工具**：`read`, `write`, `glob`, `grep`, `skill`
**温度**：0.1

### Prompt 工作流骨架

```
Step 1: 加载 skill（skill static-analysis-review）
Step 2: 读取 .matrix/data/sa-raw-findings.json（原始违规列表）
Step 3: 读取 .matrix/data/software-analysis.json（项目结构、需求上下文，可选）
Step 4: 对每条违规按 skill 方法论进行三类判定
        Phase 1: 检查规则是否在不可判定规则列表中
        Phase 2: 若在列表中，读取源码上下文（±15行），进行 FP 模式匹配
        Phase 3: 对确认违规，判断是否导致功能影响
Step 5: 读取现有 .matrix/data/defects.json（避免覆盖其他来源缺陷）
Step 6: 写出结果
        - 功能缺陷 → 合并写入 defects.json（保留其他来源，追加 static_analysis 缺陷）
        - 误报     → .matrix/data/false-positives.json
        - 全部分类 → .matrix/reports/static-analysis-review.md
```

### Triggers（用于 Conductor 路由）

- Phase 3 — StaticAnalyzer 完成后，与 Inspector Summary 并行
- 对 SpecChecker 原始输出进行三类分类审查

---

## Skill 文件设计

**路径**：`skills/static-analysis-review/SKILL.md`

### 结构

```
## Role
## 三类分类判定标准
## 不可判定规则列表（141 条，分 7 大类）
  - 数据流分析型（28条）
  - 值域/运行时型（33条）
  - 主观判断型（26条）
    - A2 上下文意图依赖型（19条）
    - A3 偏向真实违规型（7条）
  - 意图理解型（22条）
  - 控制流分析型（9条）
  - 语义分析型（17条）
  - 跨翻译单元型（7条）
    - B2 跨函数调用链型（5条）
    - B3 运行时环境依赖型（2条）
## 功能影响判断决策树
## 保守原则
## 输出数据格式
```

### 核心方法论

#### 三类分类判定标准

| 分类 | 判定标准 | 典型场景 |
|------|---------|---------|
| **功能缺陷** | 违规会导致：运行时错误、错误计算结果、数据损坏、未定义行为(UB)、安全隐患 | 中断上下文goto、除零风险、整型溢出在安全计算中、未初始化变量被读取 |
| **规范违规（无功能影响）** | 不影响运行结果，仅影响可维护性/可读性；且不是误报 | 命名不规范、注释格式、行长超限、花括号风格 |
| **误报** | 工具错误告警，代码实际符合规范意图 | 见不可判定规则列表 |

#### 不可判定规则体系（141 条）

去掉度量型（函数行数、圈复杂度、注释率等可精确计量的度量规则）和命名推荐型（这类规则工具可精确判定）后，141 条不可判定规则按可判定性从低到高排列，FP 优先级从高到低。

**主观判断型子分类（关键细化）**：

**A2 — 上下文意图依赖型（19条，必须读代码上下文后逐条判断）**

代表规则：CID6676（无法控制的循环条件）、CID006（指针代数运算）、CID004（++/--）、CID212（混合运算）、CID226（double转float）、CID054（类型转换）、CID270（非布尔条件）、CID228（函数参数未使用）等。

审查策略：读违规行前后至少 15 行，理解变量语义和设计模式后逐条判断；不可批量豁免。

**A3 — 偏向真实违规型（7条，优先保留为缺陷，豁免需偏差申请）**

代表规则：CID190（注释掉的代码）、CID287（浮点相等比较）、CID194（1位有符号位域）、CID013（未使用的局部变量/函数）等。在嵌入式安全关键场景下这类违规几乎都是真实问题。

**跨翻译单元型子分类（关键细化）**：

**B2 — 跨函数调用链型（5条，手动追踪完整调用链）**

CID1144（lock/unlock不匹配）、CID069/CID3164（返回局部变量指针）、CID1019（局部变量地址赋给长生命周期对象）、CID3159（外部资源值未验证）。工具无法追踪跨函数边界的配对关系或指针生命周期。

**B3 — 运行时环境依赖型（2条，先确认运行时模型）**

CID4255（格式化字符串含用户输入）、CID4222（TOCTOU资源竞争）。规则适用性取决于是否存在并发/多线程/信号处理，单线程裸机环境下这两条规则几乎必然产生FP。

#### 功能影响判断决策树

```
违规是否在可执行路径上？
├── 否（死代码、#if 0、不可达分支） → 候选误报，进一步确认
└── 是 → 违规在运行时会产生什么效果？
        ├── 产生错误值/UB/crash/安全隐患 → 功能缺陷 → defects.json
        ├── 不产生运行时差异 → 规范违规（无功能影响） → 仅报告
        └── 无法确定 → 保守保留为功能缺陷 → defects.json
```

#### 保守原则

- 疑似功能缺陷时，宁可误判为缺陷，不可错误消除真实问题
- A3 类规则（偏向真实违规型）：即使措辞含"尽量/谨慎"，在安全关键嵌入式场景下默认为真实违规
- mandatory 强制级别（conformance = L001）违规：无明确排除证据时不得判为误报

---

## 输出文件

### `defects.json`（更新）

SA-Reviewer 追加的缺陷格式与现有 DefectDatabase schema 一致：
- `source`: `"static_analysis"`
- `id`: 格式 `SA-XXXX`（顺序编号）
- `detected_by`: `"sa-reviewer"`
- `status`: `"open"`（confirmed functional defect）

### `false-positives.json`（新建）

```json
{
  "project_name": "string",
  "generated_date": "ISO 8601",
  "summary": {
    "total_violations_checked": 42,
    "false_positives_found": 8,
    "confirmed_violations": 30,
    "standards_only_violations": 4
  },
  "false_positives": [
    {
      "raw_finding_id": "RAW-005",
      "rule_id": "CID730",
      "rule_name": "避免使用goto语句",
      "file": "src/driver/uart.c",
      "line": 47,
      "undecidable_category": "A1",
      "reason": "goto用于多资源初始化失败后的统一cleanup跳转，是嵌入式驱动层的公认惯用法"
    }
  ],
  "standards_only": [
    {
      "raw_finding_id": "RAW-012",
      "rule_id": "CID293",
      "rule_name": "注释率不能低于20%",
      "file": "src/algo/filter.c",
      "line": 0,
      "reason": "注释率16%，低于阈值但代码命名清晰；不影响功能"
    }
  ]
}
```

### `reports/static-analysis-review.md`（新建）

包含三个章节：
1. **分类汇总**：总违规数 → 功能缺陷/规范违规/误报各多少条
2. **功能缺陷列表**（写入defects.json的条目）
3. **误报列表**（含误报判定理由）
4. **规范违规列表**（仅记录，不跟踪）

---

## 变更文件清单

### 新建（3 个）

| 文件 | 内容 |
|------|------|
| `src/agents/sa-reviewer.ts` | SA-Reviewer agent 定义 |
| `skills/static-analysis-review/SKILL.md` | 三类分类方法论 + 155条不可判定规则 |
| `src/schema/sa-raw-findings.ts` | SARawFinding、SARawFindingsReport Zod schema |

### 修改（5 个）

| 文件 | 变更内容 |
|------|---------|
| `src/agents/static-analyzer.ts` | 输出从 defects.json → sa-raw-findings.json；移除分类写缺陷逻辑 |
| `src/agents/builtin-agents.ts` | 注册 sa-reviewer agent |
| `src/agents/conductor.ts` | Phase 3 Step 5 新增 SA-Reviewer 并行分发 |
| `skills/static-analysis/SKILL.md` | 输出目标更新为 sa-raw-findings.json |
| `src/schema/index.ts` | 导出 SARawFinding、SARawFindingsReport |

### 废弃（标记 superseded，不删除）

| 文件 | 原因 |
|------|------|
| `docs/plans/2026-02-25-static-fp-elimination-design.md` | 二元 FP 分类方案已被三类分类方案取代 |
| `docs/plans/2026-02-25-static-fp-elimination-implementation.md` | 同上 |

---

## 不需要变更

- **Defect schema**（`src/schema/defect.ts`）：`false_positive` status 已存在，`coding_standard` category 已存在，无需扩展
- **CR-Reviewer**：仅审查 Inspector 代码审查产物，不涉及 SA-Reviewer 输出
- **Hook system**：现有 hooks 透明兼容新步骤
- **其他 Phase**：仅 Phase 3 受影响
