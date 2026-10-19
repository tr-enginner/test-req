# 多变量原子性违反检测——架构概览

> 文档版本：2026-03-12 | 适用范围：multivar-atomicity-checker 智能体及其 4 个工具的全链路概览

---

## 1. 涉及文件清单

### 核心源代码

| 文件 | 角色 | 说明 |
|------|------|------|
| `src/agents/multivar-atomicity-checker.ts` | Agent 定义 | 6 步骤工作流系统提示词，含 Step 3.5 HARD-GATE |
| `src/tools/multivar-cpg-create.ts` | CPG 构建工具 | 封装 joern-parse，生成 Code Property Graph |
| `src/tools/multivar-correlated-vars.ts` | Tool A: 关联变量识别 | Joern 数据流 → 锚点分类 → AQ+OE 评分 → 工具层过滤 |
| `src/tools/multivar-violation-detect.ts` | Tool B: 违反模式检测 | 5 种模式匹配 + CPG 全局访问查询 + 连续性约束 |
| `src/tools/multivar-feasibility-verify.ts` | Tool C: 可行性验证 | 初始化排除 + Joern CFG 路径 + Z3 SMT 求解 |
| `joern/multivarCorrelatedVarsIdentify.scala` | Joern Scala 脚本 | CPG 数据流分析，识别 DFC/TUP/DAC 锚点 |

### 知识与方法论

| 文件 | 说明 |
|------|------|
| `skills/multivar-atomicity/SKILL.md` | 方法论 Skill（锚点类型、模式定义、评分参数、报告指引） |
| `docs/multivar-atomicity-checker-overview.md` | 本文件：架构概览 |
| `docs/multivar-atomicity-checker-deep-dive.md` | 深度技术文档（逐函数级别分析） |

### 数据模式

| 文件 | 说明 |
|------|------|
| `src/schema/atomicity.ts` | Zod 模式：CorrelatedVariableGroup, AtomicityViolation, PathAnalysis |

---

## 2. Pipeline 总览

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     Agent: multivar-atomicity-checker                            │
│                     (temperature=0.2, mode=subagent)                    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Step 0: 归档+清理旧产物                                                │
│       │                                                                 │
│  Step 1: 加载上下文（compilation-env, software-analysis, wiki）          │
│       │  自动发现 ISR：grep interrupt 模式 → 补全 isr_entries            │
│       │                                                                 │
│  Step 2: 构建 CPG ──────────────────────────────────────────────────┐   │
│       │  multivar_cpg_create (joern-parse, 5分钟超时)              │   │
│       │  → .matrix/data/<project>.bin                               │   │
│       │                                                             │   │
│  Step 3: 关联变量识别 ─────────────────────────────────────────────┐│   │
│       │  Tool A: multivar_correlated_vars (Joern脚本, 10分钟超时) ││   │
│       │  Joern数据流分析 → 锚点分类(DFC/TUP/DAC) → AQ+OE评分      ││   │
│       │  → 工具层过滤(DFC≥0.40, TUP≥0.35, DAC≥0.20)               ││   │
│       │  → multivar-correlated-groups.json + anchor.json + correlatedVars.json│   │
│       │                                                             │   │
│  Step 3.5: LLM 语义评估 ────────────────────────────────────────┐  │   │
│       │  HARD-GATE（不可跳过，Agent 直接执行）                    │  │   │
│       │  离散三级判定: STRONG(1.0) / WEAK(0.5) / NONE(0.0)       │  │   │
│       │  触发规则: DFC/TUP灰区 + DAC全量                         │  │   │
│       │  融合: confidence = S + L × λ(type)                      │  │   │
│       │  最终过滤: confidence ≥ 0.55                             │  │   │
│       │  → correlated-groups-refined.json + correlatedVars_llm.json  │   │
│       │                                                             │   │
│  Step 4: 违反模式检测 ─────────────────────────────────────────────┘│   │
│       │  Tool B: multivar_violation_detect                         │   │
│       │  5种模式匹配(DFC_RWWR, TUP_WRRW, TUP_WWWW, DAC_RWWW,     │   │
│       │   DAC_RWWR) + CPG全局访问查询 + 连续性约束 + 去重          │   │
│       │  → multivar-candidates.json                                │   │
│       │                                                             │   │
│  Step 5: 可行性验证 ──────────────────────────────────────────────┘│   │
│       │  Step 5.1: Agent分析main()调用链 → 确定init_functions       │   │
│       │  Tool C: multivar_feasibility_verify                       │   │
│       │  Phase 0: 初始化阶段排除                                    │   │
│       │  Phase 1: Joern CFG路径可达性分析                           │   │
│       │  Phase 2: Z3 SMT约束求解 (30秒超时)                        │   │
│       │  → multivar-violations.json + multivar-confirmed.json     │   │
│       │                                                             │   │
│  Step 6: 生成报告 ────────────────────────────────────────────────┘    │
│       │  5章节结构(环境/统计/关联变量/候选分布/违反详情)              │
│       │  → .matrix/reports/multivar-violation.md                     │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 3. 三种锚点类型

| 类型 | 全称 | 核心语义 | Joern 标签 | 约束 |
|------|------|----------|-----------|------|
| **DFC** | Data Flow Convergence | 多变量汇聚于同一计算表达式 | `sink` | 同一函数内 |
| **TUP** | Transaction Update | 多变量在同一控制块连续写入 | `update` | 同一控制块内 |
| **DAC** | Decision-Action Consistency | 条件读取决策变量，控制块访问行为变量 | `dac` | 条件→控制块 |

```c
// DFC 示例：两变量在比较表达式中汇聚
if (sensor_value > threshold) { trigger_alarm(); }

// TUP 示例：结构体成员的连续事务更新
Time.S = new_seconds;
Time.MS = new_millis;  // ISR 在此间抢占 → 读到不一致状态

// DAC 示例：条件变量守护行为变量
if (data_ready) { process(rx_buffer); }
// ISR 在判断后修改 data_ready 和 rx_buffer → 决策失效
```

---

## 4. 五种违反模式

> 命名格式：`<锚点>_<低1><高1><高2><低2>`，R=Read, W=Write，按时序排列

| 模式 | 低优先级 | 高优先级(ISR) | 效果 |
|------|----------|--------------|------|
| **DFC_RWWR** | R(A) ··· R(B) | W(A), W(B) | 读到 新A + 旧B |
| **TUP_WRRW** | W(A) ··· W(B) | R(A), R(B) | ISR读到 新A + 旧B |
| **TUP_WWWW** | W(A) ··· W(B) | W(A), W(B) | 最终状态不一致 |
| **DAC_RWWW** | R(dec) ··· W(act) | W(dec), W(act) | 决策失效，行为基于旧决策 |
| **DAC_RWWR** | R(dec) ··· R(act) | W(dec), W(act) | 决策失效，读取基于旧决策 |

- **连续性约束**：ISR 侧两次访问必须连续（中间无同组其他变量访问）
- **ISR↔ISR**：需显式配置 `interrupt_priorities`，否则默认同级 ISR 不可嵌套

---

## 5. AQ + OE + LLM 评分模型

### 公式

```
confidence = AQ(type, subtype) + Σ OE_i + L × λ(type)
```

### AQ（锚点匹配质量）

| 类型 | AQ 值 | 说明 |
|------|-------|------|
| DFC | 0.45 | Phase 1 降级统一值（Phase 2 按 sink 子类型细分 0.35–0.50） |
| TUP | 0.38 或 0.33 | 写操作行间距 gap ≤ 1 → 0.38，gap > 1 → 0.33 |
| DAC | 0.20 | Phase 1 降级统一值（Phase 2 按控制结构细分 0.15–0.22） |

### OE（正交关联证据）— 所有类型共享

| 维度 | 加分 | 条件 |
|------|------|------|
| `struct_cohesion` | +0.12 | 同一结构体字段或同一数组基 |
| `multi_site` | +0.10 | 同一变量集合在 ≥2 个独立代码位置出现（不同函数或行间距 >20） |
| `naming_affinity` | +0.08 | H/L 后缀配对、共享有意义前缀、或 flag+data 命名模式 |

OE 最大值 = 0.30

### LLM 融合（离散三级判定）

| 判定 | L 值 | 含义 |
|------|------|------|
| **STRONG** | 1.0 | 变量间存在明确的一致性契约，必须原子更新 |
| **WEAK** | 0.5 | 变量间可能存在关联，但关系不确定 |
| **NONE** | 0.0 | 无语义关联，结构共现是巧合 |

| 类型 | λ | 工具上限 | LLM 上限 | 总上限 |
|------|---|---------|---------|--------|
| DFC | 0.15 | ~0.75 | 0.15 | 0.90 |
| TUP | 0.15 | ~0.68 | 0.15 | 0.83 |
| DAC | 0.40 | ~0.50 | 0.40 | 0.90 |

### 触发规则

| 锚点 | 直接通过（不调 LLM） | 灰区（调 LLM） | 直接丢弃 |
|------|---------------------|---------------|---------|
| DFC | S ≥ 0.55 | 0.40 ≤ S < 0.55 | S < 0.40 |
| TUP | S ≥ 0.55 | 0.35 ≤ S < 0.55 | S < 0.35 |
| DAC | 无（始终评估） | S ≥ 0.20 | S < 0.20 |

### 过滤阈值

- **工具层过滤**：DFC ≥ 0.40，TUP ≥ 0.35，DAC ≥ 0.20
- **最终过滤**：confidence ≥ 0.55

---

## 6. Agent 六步骤工作流

| 步骤 | 执行者 | 输入 | 输出 | 说明 |
|------|--------|------|------|------|
| **Step 0** | Agent | 旧产物 | 归档到 `.matrix/archive/atomicity/` | 清理旧结果，CPG 不删除 |
| **Step 1** | Agent | compilation-env, software-analysis | ISR/Task 列表 | 自动发现遗漏的 ISR |
| **Step 2** | CPG 工具 | 源码目录 | `<project>.bin` | joern-parse，5分钟超时 |
| **Step 3** | Tool A | CPG + 入口函数 | multivar-correlated-groups.json | Joern 数据流 + 评分过滤 |
| **Step 3.5** | Agent | multivar-correlated-groups.json + 源码 | correlated-groups-refined.json | **HARD-GATE**，离散 LLM 判定 |
| **Step 4** | Tool B | 过滤后的关联组 + CPG | multivar-candidates.json | 5 种模式匹配 + 去重 |
| **Step 5** | Tool C | 候选 + CPG | multivar-violations.json | 三阶段可行性验证 |
| **Step 6** | Agent | 全部产物 | multivar-violation.md | 5 章节综合报告 |

### Step 3.5 HARD-GATE

Step 3.5 是强制步骤，不可在任何情况下跳过。Agent 直接读取源码，对灰区组（DFC/TUP）和全量 DAC 组进行离散三级判定：

- **DFC/TUP 灰区**：批量读码，每批 5–10 组，判定 STRONG/WEAK/NONE
- **DAC 全量**：按 `dac_anchors` 分批，每个锚点读码一次，逐对独立判定
- **大体量策略**：DAC 锚点 >80 个时动态截断（优先评估高置信度锚点）

### Step 5 三阶段验证

| 阶段 | 方法 | 排除条件 | 开销 |
|------|------|---------|------|
| Phase 0 | 初始化阶段检查 | 所有主任务访问在 init 函数中 | 零开销 |
| Phase 1 | Joern CFG 路径分析 | 子路径不可达 / 中断已禁用 | 快速 |
| Phase 2 | Z3 SMT 约束求解 | UNSAT（数学证明不可行） | 30秒/候选 |

---

## 7. 产物文件

### JSON 数据

| 文件 | 产生者 | 说明 |
|------|--------|------|
| `.matrix/data/<project>.bin` | CPG 工具 | Joern Code Property Graph 二进制 |
| `.matrix/data/multivar-anchors.json` | Tool A | 锚点识别结果（Step 1 输出） |
| `.matrix/data/correlatedVars.json` | Tool A | 关联变量对 + PASS/GRAY/FILTERED 状态（Step 2 输出） |
| `.matrix/data/correlatedVars_llm.json` | Agent Step 3.5 | 关联变量对 + LLM 评估结果（Step 3 输出） |
| `.matrix/data/multivar-correlated-groups.json` | Tool A → Agent | 关联变量组（工具输出，Step 3.5 后覆写为过滤结果） |
| `.matrix/data/correlated-groups-refined.json` | Agent Step 3.5 | LLM 评估后的完整追溯数据 |
| `.matrix/data/multivar-candidates.json` | Tool B | 4 次访问交错候选 |
| `.matrix/data/multivar-violations.json` | Tool C | 含可行性验证的完整结果 |
| `.matrix/data/multivar-confirmed.json` | Tool C | 仅 CONFIRMED 违反，精简信息 |

### Markdown 报告

| 文件 | 产生者 | 说明 |
|------|--------|------|
| `.matrix/reports/correlated-groups.md` | Tool A | 关联变量组可视化（LLM 过滤前快照） |
| `.matrix/reports/multivar-candidates.md` | Tool B | 候选分布可视化 |
| `.matrix/reports/multivar-violations.md` | Tool C | 验证结果可视化 |
| `.matrix/reports/multivar-violation.md` | Agent Step 6 | 5 章节综合分析报告 |

---

## 8. 关键设计特点

1. **AQ + OE + LLM 三层评分**：AQ 量化锚点质量（类型内信号强度），OE 提供正交关联证据（跨类型统一），LLM 补充语义判断。采用离散三级判定（STRONG/WEAK/NONE）+ 按需触发规则，仅对灰区（DFC/TUP）或全量（DAC）调用 LLM，节约 ~94% 的 LLM 调用量。

2. **DAC 以 LLM 为主判定通道**：DAC 纯结构分最高仅 ~0.50，无法通过 0.55 最终过滤。λ_DAC=0.40 保证 STRONG 判定可将最弱 DAC（S=0.20）推至 0.60。工具层故意低门槛（0.20），让所有 DAC 候选进入 LLM 评估。

3. **差异化阈值**：工具层过滤（DFC≥0.40, TUP≥0.35, DAC≥0.20）与灰区触发规则对齐，避免无效 LLM 调用。

4. **三阶段递进排除**：Phase 0（init-phase 零开销）→ Phase 1（CFG 路径快速排除）→ Phase 2（Z3 精确求解）。每阶段仅处理上一阶段未排除的候选。

5. **ISR 侧连续性约束**：高优先级上下文的两次访问必须连续（无同组其他变量访问介入），避免拼凑虚假模式。

6. **Cross-Block 修复**：Tool B 使用组自身访问作为定位锚点，CPG 全局查询仅用于获取"其他上下文"的访问，防止同一变量在不同代码位置的访问被混淆。
