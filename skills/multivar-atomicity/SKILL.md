---
name: multivar-atomicity
description: "多变量原子性违反检测方法论：DFC/TUP/DAC锚点识别、五种违反模式匹配、Z3可行性验证"
metadata:
  agent: "multivar-atomicity-checker"
  category: "quality"
---

# 多变量原子性违反检测方法论

本技能定义了多变量关联原子性违反检测的完整方法论，指导 Atomicity-Checker 智能体系统化检测嵌入式软件中**多变量关联原子性违反**——当多个语义关联的共享变量在非原子操作序列中被中断抢占，导致变量间状态不一致。

核心原则：

1. **关联性先行**：先识别哪些变量是语义关联的（DFC/TUP/DAC），再检测违反
2. **工具驱动**：使用 Joern CPG + Z3 SMT 求解器进行精确分析，而非纯启发式
3. **LLM 辅助评估**：对所有候选组统一进行 LLM 语义评估，尤其是 DAC 类型组必须依赖 LLM 过滤误报
4. **来源维度标注**：Joern 脚本在数据流分析阶段标注每个 AccessList 的来源维度（`sink`/`update`/`dac`），Tool A 以此作为锚点类型的**首要依据**，降低纯启发式推断的歧义；当来源标签不存在时（旧版本 Joern 输出），自动回退到读写模式启发式推断

---

## 1. 三种锚点类型

### DFC（数据流汇聚型, Data Flow Convergence）

多个共享变量参与同一计算表达式（算术运算、比较判断、函数调用参数），这些共享变量共同组成同一个值或条件表达式的布尔值，具有隐式数据流依赖关系。

**约束**：必须在**同一函数**内识别。跨函数的数据流汇聚大概率不存在原子性需求。

```c
// 两个共享变量在同一比较表达式中汇聚
if (sensor_value > threshold) {  // sensor_value 和 threshold 数据流汇聚
    trigger_alarm();
}
// 两个共享变量在同一赋值表达式中汇聚
time = timeS * 60 + timeMs;  // timeS 和 timeMs 数据流汇聚
```

### TUP（事务更新型, Transaction Update）

同一结构体的多个成员、数组的多个元素或连续相邻的地址被连续写入，构成逻辑上的事务操作。

**约束**：必须在**同一控制块**中。跨控制块的连续写入不构成事务。

```c
// 结构体成员的连续更新
Time.S = new_seconds;    // 事务的一部分
Time.MS = new_millis;    // 事务的另一部分
// ISR 在此间抢占可能读到 (new_seconds, old_millis) 的不一致状态
```

### DAC（决策-行为型）

控制条件读取变量 A 做决策，支配区域访问变量 B 执行行为；A 和 B 语义关联。本身保证了条件和控制块内的约束。

```c
if (data_ready) {           // 决策：读 flag
    process(rx_buffer);      // 行为：使用 data
}
// ISR 可能在判断后、使用前修改 data_ready 和 rx_buffer
```

---

## 2. 五种违反模式

> 模式名格式：`<锚点>_<低1><高1><高2><低2>` — 依次反映 4 次访问序列中各次访问的类型（R=Read, W=Write）。

### DFC_RWWR: Read-Write 交错（DFC 锚点）

```
时序: Low-R(A), ISR-W(A), ISR-W(B), Low-R(B)

低优先级: Read(A) ──────────────────── Read(B)
高优先级:           Write(A), Write(B)
```

低优先级上下文先读 A 后读 B，高优先级上下文在中间同时写入 A 和 B，导致读到新 A + 旧 B。

### TUP_WRRW: Write-Read 交错（TUP 锚点）

```
时序: Low-W(A), ISR-R(A), ISR-R(B), Low-W(B)

低优先级: Write(A) ──────────────────── Write(B)
高优先级:            Read(A), Read(B)
```

低优先级上下文先写 A 后写 B，高优先级上下文在中间同时读取 A 和 B，导致读到新 A + 旧 B。

### TUP_WWWW: Write-Write 交错（TUP 锚点）

```
时序: Low-W(A), ISR-W(A), ISR-W(B), Low-W(B)

低优先级: Write(A) ──────────────────── Write(B)
高优先级:            Write(A), Write(B)
```

两个上下文都在更新 A、B，高优先级在低优先级两次写入之间执行，导致最终状态不一致。

### DAC_RWWW: 决策-行为违反（行为=写）

```
时序: Low-R(decision), ISR-W, ISR-W, Low-W(action)

低优先级: Read(A) ──────────────────── Write(B)
高优先级:           Write(A), Write(B)
```

低优先级读取决策变量 A，然后基于此执行行为写入 B；高优先级在中间修改了 A 和 B，使决策失效。

### DAC_RWWR: 决策-行为违反（行为=读）

```
时序: Low-R(decision), ISR-W, ISR-W, Low-R(action)

低优先级: Read(A) ──────────────────── Read(B)
高优先级:           Write(A), Write(B)
```

低优先级读取决策变量 A，然后在控制块内使用（读取）行为变量 B；高优先级在中间修改了 A 和 B，使决策失效。典型场景：`if(flag){ use(buf); }` — flag 是决策，buf 是行为，行为侧为 READ。

> **说明**：上述"低优先级/高优先级"不仅指主任务与 ISR 之间，也包括低优先级 ISR 与高优先级 ISR 之间的交错。ISR↔ISR 交错检测需要在 `matrix.jsonc` 中显式配置 `interrupt_priorities`；无优先级配置时默认不检测 ISR 互相抢占（大多数嵌入式平台同级 ISR 不可嵌套）。

> **锚点→模式映射**：DFC (R-R) → DFC_RWWR；TUP (W-W) → TUP_WRRW + TUP_WWWW；DAC (R→action) → DAC_RWWW（action=W）+ DAC_RWWR（action=R）。

> **连续性约束**：高优先级（ISR）侧匹配的两次访问必须是**连续**的——即在对关联变量组所有变量的访问中，两次匹配的访问之间不存在对同组其他变量的访问。这避免了跨越不相关访问的冗余误报。

---

## 3. 证据评分体系

采用 **AQ + OE** 分层评分模型：锚点匹配质量 (AQ) + 正交关联证据 (OE) + 统一 LLM 评估，所有锚点类型统一满分 1.00。

### 3.1 评分公式

```
confidence = AQ(type, subtype) + Σ OE_i + llm_score × type_scale
```

各维度得分分项记录在 `evidence` 字段中（`Record<string, number>`），便于追溯得分来源。

**AQ（锚点匹配质量）** — 量化同一类型内的信号强度：

| 锚点类型 | AQ 范围 | 降级值（Phase 1） | 说明 |
| ---- | ---- | ---- | ---- |
| DFC | [0.35, 0.50] | **0.45** | Phase 2 按 sink 类型细分（算术/比较/调用/间接） |
| TUP | [0.33, 0.38] | 按 gap 计算 | gap ≤ 1 → 0.38，gap > 1 → 0.33 |
| DAC | [0.15, 0.22] | **0.20** | Phase 2 按控制结构细分（if/switch/嵌套） |

**OE（正交关联证据）** — 所有锚点类型共享，消除跨类型分数不可比性：

| 维度 | 加分 | 条件 |
| ---- | ---- | ---- |
| struct_cohesion | +0.12 | 同一结构体字段或同一数组基 |
| multi_site | +0.10 | 同一变量集合在 ≥2 个独立代码位置出现 |
| naming_affinity | +0.08 | H/L 后缀配对、共享有意义前缀、或 flag+data 命名模式 |

OE 最大值 = 0.30

**LLM 贡献** — 离散三级判定 (STRONG=1.0, WEAK=0.5, NONE=0.0) 按类型缩放：

| 锚点类型 | 工具上限 | λ 缩放 | 工具+LLM 上限 |
| ---- | ---- | ---- | ---- |
| DFC | ~0.75 | L × 0.15 | 0.90 |
| TUP | ~0.68 | L × 0.15 | 0.83 |
| DAC | ~0.50 | L × 0.40 | 0.90 |

### 3.2 工具层过滤

**差异化阈值**（与 AQ 降级值对齐）：

- DFC：工具层置信度 >= 0.40 保留（AQ=0.45 默认通过）
- TUP：工具层置信度 >= 0.35 保留（AQ=0.33-0.38，无 OE 的松散写操作可能被淘汰）
- DAC：工具层置信度 >= 0.20 保留（低门槛，让所有 DAC 组通过到 Agent 进行 LLM 评估）

### 3.3 LLM 语义评估（Agent Step 3.5）

采用**离散三级判定**（不使用连续 0-1 分数）：

| 判定 | L 值 | 含义 |
| ---- | ---- | ---- |
| **STRONG** | 1.0 | 变量间存在明确的一致性契约，必须原子更新 |
| **WEAK** | 0.5 | 变量间可能存在关联，但关系不确定 |
| **NONE** | 0.0 | 无语义关联，结构共现是巧合 |

**融合公式**：`confidence_final = S + L × λ(type)`，其中 λ_DFC=0.15, λ_TUP=0.15, λ_DAC=0.40。

**触发规则**（基于结构分数 S）：

| 锚点 | 直接通过（不调 LLM） | 灰区（调 LLM） | 直接丢弃 |
| ---- | ---- | ---- | ---- |
| DFC | S ≥ 0.55 | 0.40 ≤ S < 0.55 | S < 0.40 |
| TUP | S ≥ 0.55 | 0.35 ≤ S < 0.55 | S < 0.35 |
| DAC | 无（始终评估） | S ≥ 0.20 | S < 0.20 |

**DFC / TUP — 灰区批量评估**：

- 仅灰区组需要 LLM 评估（S ≥ 0.55 直接通过，S 低于灰区下限直接丢弃）
- 按文件批量读取源码上下文，每批 5-10 组
- 判断变量是否需要原子更新，输出 STRONG/WEAK/NONE

**DAC — 锚点批量评估**：

- Tool A 输出 `dac_anchors` 数组，将共享同一条件表达式位置的 DAC 组归并
- **读码一次**：按 `condition_location` 读取条件表达式和控制块周围的源码（~30 行）
- **逐对评分**：对锚点下的每个 (decision_var, action_var) 对独立判定 STRONG/WEAK/NONE
- 示例：`if (data_ready)` 锚点下，(data_ready, rx_buffer)=STRONG（flag 直接守护缓冲区），(data_ready, debug_counter)=NONE（计数器与 flag 无关）

**通用规则**：

- **MANDATORY**: Step 3.5 LLM 评估是**强制性步骤**，不可跳过、推迟或省略
- LLM 判定结果映射：STRONG→`llm_score=1.0`，WEAK→`llm_score=0.5`，NONE→`llm_score=0.0`
- 评分函数根据锚点类型自动缩放：DFC L×0.15, TUP L×0.15, DAC L×0.40
- 每组额外记录 `llm_status`（SKIPPED_PASS/SKIPPED_FILTERED/EVALUATED/UNAVAILABLE）、`llm_judgment`、`llm_reason`
- **最终过滤阈值**：置信度 >= 0.55

**大体量策略**（动态截断）：

- DFC/TUP：始终全量评估灰区组（S ≥ 0.55 已直通，灰区通常 < 30 个）
- DAC 锚点：按锚点内最高 `confidence` 降序排列，动态确定评估预算：
  - ≤ 80 个锚点：全量评估
  - 81–200 个：评估前 80 个
  - 201–500 个：评估前 60 个，若通过率 ≥ 10 组则追加 20 个
  - > 500 个：评估前 40 个，按通过率 > 25% 逐批追加（每批 20，最多 3 批）
- 未评估锚点的 `llm_score` 设为 0.0，由 0.55 阈值自动淘汰

最终置信度 = AQ + Σ OE + L × λ(type)

---

## 4. 可行性验证（路径分析 + Z3）

采用两阶段验证：Joern CPG 路径分析（快速排除）+ Z3 SMT 求解（精确验证）。

### 4.1 子路径分解

将每个 4 次访问的违反候选分解为 3 条子路径：


| 子路径        | 起点     | 终点              | 验证内容             |
| ---------- | ------ | --------------- | ---------------- |
| Sub-path 1 | 低优先级入口 | 第一次低优先级访问 (A1)  | 入口函数能否到达第一个访问点   |
| Sub-path 2 | 高优先级入口 | 高优先级访问 1 → 访问 2 | 高优先级上下文内两次访问是否可达 |
| Sub-path 3 | A1     | 第二次低优先级访问 (A2)  | 抢占窗口路径可达性        |


### 4.2 CFG 可达性分析（Phase 1 — Joern）

对每条子路径，使用 Joern CPG 的 CFG 进行 BFS 可达性搜索：

- 如果起点到终点不存在 CFG 路径 → **INFEASIBLE**（无需调用 Z3）
- 沿路径收集**分支条件**（if/while 的判断条件表达式）
- 沿路径检测**中断使能/禁用 API 调用**（如 `__disable_irq`, `__enable_irq`, `EA=0/1`）

### 4.3 中断使能流敏感分析

对 Sub-path 3（抢占窗口），进行流敏感的中断状态跟踪：

- 从 A1 出发，默认中断使能 (enabled=true)
- 沿 CFG 路径扫描中断 API 调用，更新状态
- 如果到达 A2 时中断仍被禁用（存在未配对的 disable）→ **INFEASIBLE**
- 支持的中断 API：`__disable_irq/__enable_irq`（ARM）、`EA=0/1`（8051）、`taskENTER_CRITICAL/taskEXIT_CRITICAL`（FreeRTOS）等

### 4.3b 初始化阶段排除

在 Phase 1 之前，对每个候选进行初始化阶段检查：

- 如果候选的**所有**低优先级侧访问均位于初始化函数中（在 `main()` 中第一个中断使能调用之前执行的函数），则标记为 **INFEASIBLE**（原因：init-phase，中断未使能，无 ISR 抢占可能）
- 初始化函数列表由 Agent 在 Step 5.1 通过分析 main() 调用序列确定，传入 `init_functions` 参数
- 典型初始化函数：`SystemInit`, `GPIO_Init`, `CPUInitial`, `HardwareSetup` 等
- 如果 main() 中找不到明确的中断使能调用，不传 `init_functions`（保守默认：假设中断可能已使能）

### 4.4 Z3 SMT 约束求解（Phase 2）

对通过 Phase 1 筛选的违反候选，编码以下约束：

1. **子路径可达约束**：3 条子路径均 CFG 可达（已由 Phase 1 确认）
2. **路径条件约束**：沿路径收集的分支条件编码为布尔变量
3. **中断使能约束**：流敏感分析确认抢占窗口内中断使能
4. **时序约束**：低优先级访问按源码序，高优先级抢占在两次低优先级访问之间

> **注意**：ISR 侧的访问类型约束（如"ISR 必须写入"）**不在 SMT 中编码**。Tool B 的模式匹配已保证 ISR 侧访问类型与模式一致（DFC_RWWR/TUP_WWWW/DAC_RWWW/DAC_RWWR → ISR 写; TUP_WRRW → ISR 读），无需在 SMT 层重复约束。Tool C 仅保留一条防御性断言：如果上游数据异常（ISR 无写入但模式非 TUP_WRRW），直接判定 INFEASIBLE。

### 4.5 结果映射

- **SAT → CONFIRMED**：严重度 = critical
- **UNSAT → INFEASIBLE**：严重度 = info（仅记录不报告）
- **UNKNOWN → UNKNOWN**：严重度 = major

### 4.6 退化模式

- Joern 不可用时 → 跳过 Phase 1，仅用 Z3 时序约束（Legacy 模式）
- Z3 不可用时 → 所有违反标记为 UNKNOWN

---

## 5. 严重度映射


| Z3 结果      | 严重度      | 说明               |
| ---------- | -------- | ---------------- |
| CONFIRMED  | critical | 经 Z3 验证的真实违反     |
| UNKNOWN    | major    | 无法排除的潜在违反        |
| UNCHECKED  | major    | 未经 Z3 验证的候选      |
| INFEASIBLE | info     | Z3 证明不可达（仅记录不报告） |


---

## 6. 误报避免规则

- 工具层差异化过滤阈值：DFC < 0.40 自动丢弃，TUP < 0.35 自动丢弃，DAC < 0.20 自动丢弃
- 最终过滤阈值：置信度 < 0.55 自动丢弃
- 所有候选组在 Step 3.5 进行统一 LLM 评估（单一步骤，单一 `llm_score` 字段）
- DAC 组依赖 LLM 评估提供主要置信度（L × 0.40 占比最大，STRONG 可贡献 0.40）
- INFEASIBLE 违反仅在报告中记录（供参考），不计入汇总统计

---

## 7. 报告内容指引

报告按以下 5 个章节输出：

1. **分析环境**：CPU、字长、编译器、ISR 数量、共享变量数、关联变量组数、保护原语
2. **结果统计**：
  - 关联变量组统计（按锚点类型：DFC / TUP / DAC 的数量和平均置信度）
  - 原子性违反统计（按模式分布，含 CONFIRMED / INFEASIBLE / UNKNOWN 验证结果分布）
3. **关联变量分析详情**：按置信度降序排列，最多列出前 100 个。每组包含：ID、锚点类型、变量组、置信度、**证据分解**（各评分维度明细，含 llm_score）、描述
4. **原子性违反候选分布详情**：按模式汇总候选数量和验证结果分布
5. **原子性违反结果详情**：按严重度排序，最多列出前 30 个。仅包含 CONFIRMED、UNKNOWN、UNCHECKED（INFEASIBLE 不列出）。每个违反包含：ID、模式、描述、4 次访问交错序列表、代码片段、可行性、保护建议

### 输出产物

每个工具同时输出 JSON 原始数据和 Markdown 直观展示：


| 文件                                      | 描述                 |
| ----------------------------------------- | ------------------ |
| `.matrix/data/multivar-anchors.json`                | 锚点识别结果（Step 1 输出） |
| `.matrix/data/multivar-correlated-accesses.json`   | 关联访问组数据（含证据、置信度、LLM 评估结果） |
| `.matrix/reports/multivar-correlated-pairs.md`     | 关联变量对可视化报告         |
| `.matrix/data/multivar-candidates.json`            | 4 次访问交错候选原始数据      |
| `.matrix/reports/multivar-candidates.md`           | 访问序候选可视化报告         |
| `.matrix/data/multivar-violations.json`            | 含可行性验证的完整结果原始数据    |
| `.matrix/reports/multivar-violations.md`           | 最终缺陷检测结果可视化报告      |
| `.matrix/reports/multivar-final-report.md`         | 综合分析报告（由 Agent 生成） |


