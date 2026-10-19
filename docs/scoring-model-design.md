# 多变量原子性违反检测——评分模型设计文档

> 文档版本：2026-03-11
> 适用范围：Tool A（关联变量识别）的置信度评分 + Agent Step 3.5（LLM 语义评估）的融合策略
> 关联文件：`src/tools/multivar-correlated-vars.ts`、`src/agents/multivar-atomicity-checker.ts`、`skills/multivar-atomicity/SKILL.md`

---

## 目录

1. [设计动机与核心问题](#1-设计动机与核心问题)
2. [评分模型总体架构](#2-评分模型总体架构)
3. [锚点匹配质量 AQ](#3-锚点匹配质量-aq)
  - [3.1 DFC 锚点匹配质量](#31-dfc-锚点匹配质量)
  - [3.2 TUP 锚点匹配质量](#32-tup-锚点匹配质量)
  - [3.3 DAC 锚点匹配质量](#33-dac-锚点匹配质量)
4. [正交关联证据 OE](#4-正交关联证据-oe)
  - [4.1 struct_cohesion：结构体内聚](#41-struct_cohesion结构体内聚)
  - [4.2 multi_site：多点共现](#42-multi_site多点共现)
  - [4.3 naming_affinity：命名亲和](#43-naming_affinity命名亲和)
5. [纯结构评分推演](#5-纯结构评分推演)
  - [5.1 DFC 推演](#51-dfc-推演)
  - [5.2 TUP 推演](#52-tup-推演)
  - [5.3 DAC 推演](#53-dac-推演)
6. [LLM 语义增强层](#6-llm-语义增强层)
  - [6.1 设计原则：按需调用](#61-设计原则按需调用)
  - [6.2 LLM 触发规则](#62-llm-触发规则)
  - [6.3 LLM 输出格式](#63-llm-输出格式)
  - [6.4 融合公式与 λ 参数](#64-融合公式与-λ-参数)
  - [6.5 融合后评分推演](#65-融合后评分推演)
  - [6.6 LLM Prompt 设计](#66-llm-prompt-设计)
7. [无 LLM 降级模式](#7-无-llm-降级模式)
8. [调用量估算](#8-调用量估算)
9. [与旧模型的对比](#9-与旧模型的对比)
10. [参数总表](#10-参数总表)
11. [代码变更规格](#11-代码变更规格)
  - [11.1 Phase 1 变更清单（当前可实现）](#111-phase-1-变更清单)
    - [11.2 Phase 2 变更清单（需 Joern 增强）](#112-phase-2-变更清单需-joern-增强)

---

## 1. 设计动机与核心问题

### 1.1 评分模型要回答的根本问题

> 在已知两个变量满足某种锚点结构条件的前提下，它们**真正需要原子更新的可能性有多大**？

这个可能性取决于三个层次的证据：


| 层次                         | 负责阶段            | 问题               |
| -------------------------- | --------------- | ---------------- |
| **关联性**（Correlation）       | Tool A 评分 + LLM | 这两个变量是否语义相关？     |
| **可中断性**（Interruptibility） | Tool B 模式匹配     | 是否存在可被中断打断的访问序列？ |
| **可达性**（Feasibility）       | Tool D Z3 验证    | 该中断路径是否在运行时真正可达？ |


**本文档仅涉及第一层：关联性评分。** Tool B 和 Tool D 的逻辑独立于评分模型。

### 1.2 旧模型的缺陷

旧模型存在**定义-评分循环论证**：


| 锚点  | 旧设计                                                             | 问题                                                     |
| --- | --------------------------------------------------------------- | ------------------------------------------------------ |
| DFC | 基分 0.55（"因为是 DFC"）+ `dependency_depth`（数据依赖深度）                  | DFC 的定义就是数据流汇聚，`dependency_depth` 是对汇聚关系的再次度量，同一证据计分两次 |
| TUP | 基分 0.35（"因为是 TUP"）+ `struct_members`/`array_elements`（结构体/数组成员） | "同 BB 写"是 TUP 的入场门槛，而"结构体成员"是独立的关联信号，二者混在同一评分函数中语义不清   |
| DAC | 基分 0.20（"因为是 DAC"）+ `disjoint_rw`（读写不相交）                        | `disjoint_rw` 几乎是 DAC 的定义特征（条件读、体写），给分区分度极低            |


此外，三类锚点的评分维度各不相同，导致跨类型分数不可比——DFC 的 0.60 和 DAC 的 0.35 无法直接比较。

### 1.3 新模型的设计原则

1. **锚点识别是二值门控，不是评分维度**：通过 Joern 分析被标记为 DFC/TUP/DAC 是入场资格，不应再作为分数来源
2. **锚点匹配质量（AQ）量化"同一类型内的好坏"**：同样是 DFC，`z = a + b` 和 `foo(a, ..., b)` 信号强度完全不同
3. **正交证据（OE）所有类型共享**：消除跨类型维度不同导致的分数不可比性
4. **AQ + OE 清晰分离**：每一分都有明确的、不重叠的信息来源

---

## 2. 评分模型总体架构

```
confidence = AQ(type, subtype) + Σ OE_i [ + L × λ(type) ]
               │                    │         │
               │                    │         └─ LLM 语义增强（可选）
               │                    └─ 正交关联证据（所有类型共享）
               └─ 锚点匹配质量（类型内子分类）
```

### 关键参数


| 参数     | 值                                                  | 说明                                                   |
| ------ | -------------------------------------------------- | ---------------------------------------------------- |
| 统一通过阈值 | **0.55**                                           | 所有类型使用同一阈值                                           |
| AQ 范围  | DFC [0.35, 0.50]，TUP [0.33, 0.38]，DAC [0.15, 0.22] | 反映锚点定义本身的关联信号强度（DFC 5 级含间接汇聚深度区分，TUP 仅 2 级） |
| OE 最大值 | +0.30                                              | 三个正交维度之和                                             |
| L 范围   | {0, 0.5, 1.0}                                      | 三级离散判定，非连续分数                                         |
| λ 范围   | DFC 0.15，TUP 0.15，DAC 0.40                         | LLM 贡献权重                                             |


---

## 3. 锚点匹配质量 AQ

AQ 回答的是：**"这个锚点匹配的质量如何？"**

同一锚点类型内，不同的匹配方式提供的关联信号强度有显著差异。AQ 对每个锚点类型定义 3-4 个子等级，分值递减，反映信号强度的衰减。

### 3.1 DFC 锚点匹配质量

**DFC 定义**：变量 A、B 的值流入同一计算节点（sink）。

sink 的类型决定了"两个变量真正需要同时正确"的可能性：


| 等级       | AQ 分值    | sink 类型   | 典型代码                                       | 分析                                                                              |
| -------- | -------- | --------- | ------------------------------------------ | ------------------------------------------------------------------------------- |
| **AQ-1** | **0.50** | 算术/位运算表达式 | `z = a + b` `x = a & mask`                 | 数学运算**在语义上要求两个操作数同时正确**才有意义。如果 `a` 被中断更新但 `b` 还是旧值，`z` 的结果必然错误。这是最强的关联信号。       |
| **AQ-2** | **0.45** | 比较/逻辑表达式  | `if (a > b)` `result = (a == b)`           | 比较操作**需要二者处于同一时间快照**。若 `a` 被中断改变，比较结果不再反映真实关系。强信号，略弱于算术（比较结果可能只影响分支，不一定导致数据损坏）。 |
| **AQ-3** | **0.40** | 同一函数调用的参数 | `send(addr, data)` `memcpy(dst, src, len)` | 函数 API 期望参数配合使用。但也存在"恰巧是同一函数的不同参数但语义无关"的情况（如 `printf(fmt, val)`），因此信号中等。        |
| **AQ-4** | **0.45** | 间接汇聚（赋值链≤2层） | `x=a; y=b;` `z=f(x,y)`                     | 浅层间接汇聚（赋值链 ≤ 2），信号强度与比较 sink 相当。                                              |
| **AQ-5** | **0.35** | 深层间接汇聚（赋值链>2层） | `x=a;` `y=f(x);` `z=g(y,b)`              | 赋值链深度 > 2，偶然共现的可能性增加。弱信号。                                                     |


**数据来源与实现**：

由 Joern 的 sink 节点 AST 类型直接提供：

- `<operator>.addition`, `<operator>.subtraction`, `<operator>.multiplication`, `<operator>.and`, etc. → AQ-1
- `<operator>.greaterThan`, `<operator>.equals`, `<operator>.logicalAnd`, etc. → AQ-2
- `CALL` 节点（非 operator） → AQ-3
- 间接赋值链，赋值链深度 ≤ 2 → AQ-4，深度 > 2 → AQ-5

> **Joern 侧增强**：在 `nodeSourceMap` 中将 `"sink"` 扩展为 `"sink:arithmetic"` / `"sink:comparison"` / `"sink:call"` / `"sink:indirect:N"`（N 为赋值链深度），零成本获取精确信息。
>
> **当前降级策略**：在 Joern 增强前，所有 DFC 使用统一的 AQ = 0.45，作为保守估计。

**为什么 AQ-1 不给更高分？** 即使是算术 sink，也存在"两个变量碰巧在同一表达式但不需要原子"的情况。例如 `total = item_count + error_count`——二者数值独立更新不会导致安全问题，只是 total 暂时不精确。0.50 的定位是"强烈倾向但非确定"，需要至少一个正交证据（如 struct_cohesion）才能过线。

### 3.2 TUP 锚点匹配质量

**TUP 定义**：变量 A、B 在同一基本块中被写入，且行距 ≤ `MAX_WRITE_GAP`（当前 = 5 行）。

**Joern 层的硬约束**：Joern Scala 脚本（D4 阶段）在识别 TUP 时已施加了 `lineJ - lineI <= MAX_WRITE_GAP` 的条件。这意味着**所有到达 TypeScript 层的 TUP 候选都已经是"紧密写入"**——不存在"同 BB 但间隔远"或"大 BB 分散写"的 TUP 候选，因为 Joern 根本不会输出它们。

因此，TUP 的 AQ 子分级**不能基于行距远近**（所有候选的 gap 都在 0-5 行之间，区分度极低）。真正的质量差异来源于**写操作的独立性和纯粹性**：


| 等级       | AQ 分值    | 写入模式              | 典型代码                                    | 分析                                          |
| -------- | -------- | ----------------- | --------------------------------------- | ------------------------------------------- |
| **AQ-1** | **0.38** | 严格相邻写（gap ≤ 1）    | `a = val1;` `b = val2;`                 | 两个写操作紧挨着（相邻行或同行），程序员刻意将它们放在一起，**最强的事务性暗示**。 |
| **AQ-2** | **0.33** | 窗口内写（1 < gap ≤ 5） | `a = val1;` `/* 2-4 行间隔 */` `b = val2;` | 仍在 5 行窗口内，但有间隔。间隔中可能存在不相关的代码，增加了"偶然共现"的可能性。 |


**数据来源**：Joern 输出的写操作行号 + TypeScript 层计算的 gap。

- 计算两个写操作之间的行距 `gap = |line_b - line_a|`
- `gap ≤ 1` → AQ-1
- `1 < gap ≤ 5` → AQ-2
- `gap > 5` → **不会出现**（Joern 已过滤）

**为什么只有两级？** 因为 Joern 的 `MAX_WRITE_GAP = 5` 约束已经保证了所有 TUP 候选都是"紧密写入"。在 0-5 行的狭窄范围内，区分"非常紧密"和"比较紧密"已经是合理的最大粒度。进一步细分（如 gap=2 vs gap=3）没有可靠的工程意义。

**为什么最高只有 0.38？** 即使是严格相邻的写入，也太常见了。考虑：

```c
error_count = 0;     // 重置错误计数
led_state = LED_ON;  // 点亮 LED
```

相邻，同 BB，gap=1，但完全无关。TUP 的结构证据天然比 DFC 弱——写入的时空邻近 ≠ 语义耦合。TUP 必须依赖正交证据（结构体内聚、命名亲和）才能获得足够的置信度。

### 3.3 DAC 锚点匹配质量

**DAC 定义**：变量 A 在条件表达式中被读取，变量 B 在该条件控制的代码体中被访问。

条件-操作的结构耦合紧密度：


| 等级       | AQ 分值    | 控制关系        | 典型代码                                         | 分析                                                           |
| -------- | -------- | ----------- | -------------------------------------------- | ------------------------------------------------------------ |
| **AQ-1** | **0.22** | 直接 if-body  | `if(flag) {` `data = process();` `}`         | 最清晰的"决策→行动"关系。条件变量直接且唯一地控制操作的执行。                             |
| **AQ-2** | **0.18** | switch-case | `switch(state) {` `case X: val = 1;` `}`     | 状态机模式，在嵌入式中常见。但 switch 的多 case 结构使得"state 和 val 是否真正相关"更难判断。 |
| **AQ-3** | **0.15** | 嵌套条件        | `if(x) {` `if(flag) {` `data = val;` `}` `}` | flag 不是唯一的控制条件，关联信号被外层条件稀释。且变量 data 可能与外层 x 相关，与内层 flag 无关。  |


**数据来源与实现状态**：

理想情况下由 Joern 的 `ControlStructure` 节点属性提供：

- `controlStructureType == "IF"` 且无外层 ControlStructure 嵌套 → AQ-1
- `controlStructureType == "SWITCH"` → AQ-2
- 条件节点的祖先包含另一个 `ControlStructure(IF/SWITCH)` → AQ-3

> **Joern 侧增强**：在输出中将 `"dac"` 扩展为 `"dac:if"` / `"dac:switch"` / `"dac:nested"`，并附加 `nesting_depth` 字段。
>
> **当前降级策略**：在 Joern 增强前，所有 DAC 使用统一的 AQ = 0.20（AQ-1 和 AQ-2 的中间值），作为保守估计。

**为什么最高只有 0.22？这是整个评分模型的关键设计点。**

```c
if (sensor_ready) {
    process(data);
}
```

从结构上看，`sensor_ready` 控制 `data` 的使用。但有两种完全不同的语义解读：

- **解读 A**：`sensor_ready` 标志着 `data` 已经被正确填充，二者构成一致性契约——如果中断在 `sensor_ready` 检查后修改了 `data`，process() 使用的就是"脏数据"。→ **真正的原子性违反**
- **解读 B**：`sensor_ready` 只是一个通用门控（如电源就绪标志），`data` 在别处独立更新，二者无语义耦合。→ **误报**

**结构分析无法区分这两种情况。** 这就是 DAC 的 AQ 最高只给 0.22 的根本原因——不是评分调不好，而是 condition→body 关系的语义解读存在**固有歧义**，必须由 LLM（或人类）介入。

---

## 4. 正交关联证据 OE

正交证据**完全独立于锚点定义**，衡量的是变量之间"是否属于同一逻辑概念的组成部分"。所有锚点类型共享同一组维度。

### 4.1 struct_cohesion：结构体内聚


| 属性       | 值                                                        |
| -------- | -------------------------------------------------------- |
| **分值**   | +0.12                                                    |
| **条件**   | 两个变量是同一结构体的不同字段（包含数组元素如 `arr[0]`/`arr[1]`）               |
| **数据来源** | Joern 类型系统，或变量名前缀匹配（`BTime.MS` 和 `BTime.S` 共享 `BTime` 基） |


**为什么给 +0.12（所有正交维度中最高）？**

程序员将变量放入同一结构体，是**设计意图的直接表达**。结构体的语义就是"这些数据属于同一逻辑单元"。例如：

```c
typedef struct {
    uint16_t MS;  // 毫秒
    uint16_t S;   // 秒
} TimeStruct;

TimeStruct BTime;  // 电池时间
```

`BTime.MS` 和 `BTime.S` 共同构成一个时间值——如果中断在写 `MS` 之后、写 `S` 之前打断，时间值就不一致。结构体内聚是除 LLM 外最强的关联信号。

**同时覆盖数组元素**：`snd_sig[2]` 和 `snd_sig[3]` 共享数组基 `snd_sig`，视为结构体内聚。

### 4.2 multi_site：多点共现


| 属性       | 值                                            |
| -------- | -------------------------------------------- |
| **分值**   | +0.10                                        |
| **条件**   | 同一变量对在 ≥2 个**不同代码位置**（不同函数或不同行区间）以相同模式出现     |
| **数据来源** | Joern AccessList 计数——同一变量组产生多个 AccessList 条目 |


**为什么给 +0.10？**

一次共现可能是巧合。但如果 `sensor_x` 和 `sensor_y` 在 `ReadSensor()`、`ProcessData()`、`SendTelemetry()` 三个函数中都被同时访问，这几乎不可能是巧合——它们在系统设计中就是一对。

**判定方式**：在 Tool A 的 TypeScript 层，统计每个变量集合（variable set）产生了多少个独立的 AccessList。若 ≥2，触发 multi_site 加分。

### 4.3 naming_affinity：命名亲和


| 属性       | 值              |
| -------- | -------------- |
| **分值**   | +0.08          |
| **条件**   | 变量名符合配对命名模式    |
| **数据来源** | 字符串分析，无需 Joern |


**配对命名模式**：


| 模式             | 示例                                                  | 说明                 |
| -------------- | --------------------------------------------------- | ------------------ |
| 共享前缀 + 配对后缀    | `regH`/`regL`, `dataHi`/`dataLo`, `adcMSB`/`adcLSB` | 高/低字节、大/小端         |
| 共享前缀 + 方向后缀    | `sensor_x`/`sensor_y`, `pos_lat`/`pos_lon`          | 多维数据               |
| 共享有意义前缀        | `g_chg_state`/`g_chg_mode` → 共享 `g_chg`_            | 同领域变量              |
| Flag + Data 配对 | `data_ready` + `rx_buffer`                          | 门控标志 + 数据体（仅限 DAC） |


**为什么给 +0.08？**

命名约定反映程序员的设计意图，但信号强度弱于结构体内聚。原因：

- 命名规范因项目/团队而异，不够稳定
- 可能存在误匹配（如 `channel` 和 `change` 共享前缀 `cha` 但无关）
- 需要配合前缀长度阈值（≥3 字符）和词边界检查来减少误匹配

**实现**：复用现有函数：
- `hasAdjacentAddressPattern(vars)`：检测 H/L、Hi/Lo、MSB/LSB 等高低字节配对后缀
- `extractCommonPrefix(vars)`：提取变量名的共同有意义前缀（≥3 字符，词边界切分）

两者任一匹配即触发 `naming_affinity` 加分。

**正交证据最大值 = 0.12 + 0.10 + 0.08 = 0.30**

### 正交证据实现状态


| 维度                | 当前实现状态 | 备注                                                                              |
| ----------------- | ------ | ------------------------------------------------------------------------------- |
| `struct_cohesion` | ✅ 已实现  | 旧模型中已有 `struct_base`/`struct_members`/`array_elements`，需统一为单一维度                 |
| `multi_site`      | ❌ 未实现  | 需要在 TypeScript 层统计同一变量集合产生的独立 AccessList 数量                                     |
| `naming_affinity` | ✅ 部分实现 | 旧模型已有 `adjacent_address`（H/L 后缀）和 `naming_pattern`/`naming_similarity`，需合并为统一维度 |


---

## 5. 纯结构评分推演

以下推演展示各种典型场景下的纯结构评分（不含 LLM），验证评分模型的区分度和合理性。

### 5.1 DFC 推演


| #   | 场景描述                            | AQ   | struct | multi | naming | **S**    | 判定   |
| --- | ------------------------------- | ---- | ------ | ----- | ------ | -------- | ---- |
| D1  | `z = a + b`，a/b 同 struct        | 0.50 | 0.12   | —     | —      | **0.62** | ✓ 通过 |
| D2  | `z = a + b`，a/b 多点共现            | 0.50 | —      | 0.10  | —      | **0.60** | ✓ 通过 |
| D3  | `z = a + b`，a/b 无任何正交证据         | 0.50 | —      | —     | —      | **0.50** | ✗ 灰区 |
| D4  | `if (a > b)`，a/b 同 struct       | 0.45 | 0.12   | —     | —      | **0.57** | ✓ 通过 |
| D5  | `send(addr, data)`，配对命名 + 多点    | 0.40 | —      | 0.10  | 0.08   | **0.58** | ✓ 通过 |
| D6  | `send(addr, data)`，仅同 struct    | 0.40 | 0.12   | —     | —      | **0.52** | ✗ 灰区 |
| D7  | `send(fmt, val)`，无正交证据          | 0.40 | —      | —     | —      | **0.40** | ✗ 丢弃 |
| D8  | 浅层间接汇聚(≤2层)，同 struct            | 0.45 | 0.12   | —     | —      | **0.57** | ✓ 通过 |
| D9  | 浅层间接汇聚(≤2层)，无正交证据              | 0.45 | —      | —     | —      | **0.45** | ✗ 灰区 |
| D10 | 深层间接汇聚(>2层)，无正交证据              | 0.35 | —      | —     | —      | **0.35** | ✗ 丢弃 |
| D11 | 深层间接汇聚(>2层)，同 struct + 命名      | 0.35 | 0.12   | —     | 0.08   | **0.55** | ✓ 通过 |


**观察**：

- AQ-1（算术 sink）只需 1 个正交维度即可通过
- AQ-3（函数参数）需要 2 个正交维度
- AQ-4（浅层间接，≤2层）+ struct 即可通过，与比较 sink 同级
- AQ-5（深层间接，>2层）需要 2-3 个正交维度
- "无任何正交证据的算术 DFC"（D3）= 0.50，不通过——仅靠 `total = item_count + error_count` 不应自动判定

### 5.2 TUP 推演

> 注：由于 Joern 的 `MAX_WRITE_GAP = 5` 约束，所有 TUP 候选的 AQ 仅有两级（0.38 或 0.33），不存在 gap > 5 的情况。


| #   | 场景描述                        | AQ   | struct | multi | naming | **S**    | 判定    |
| --- | --------------------------- | ---- | ------ | ----- | ------ | -------- | ----- |
| T1  | 严格相邻写，同 struct，多点共现         | 0.38 | 0.12   | 0.10  | —      | **0.60** | ✓ 通过  |
| T2  | 严格相邻写，同 struct              | 0.38 | 0.12   | —     | —      | **0.50** | ✗ 灰区  |
| T3  | 严格相邻写，配对命名（H/L 后缀）          | 0.38 | —      | —     | 0.08   | **0.46** | ✗ 灰区  |
| T4  | 窗口内写（gap 2-5），同 struct + 多点 | 0.33 | 0.12   | 0.10  | —      | **0.55** | ✓ 通过  |
| T5  | 窗口内写（gap 2-5），同 struct      | 0.33 | 0.12   | —     | —      | **0.45** | ✗ 灰区  |
| T6  | 窗口内写（gap 2-5），无正交证据         | 0.33 | —      | —     | —      | **0.33** | ✗ 丢弃  |
| T7  | 严格相邻写，无正交证据                 | 0.38 | —      | —     | —      | **0.38** | ✗ 灰区  |
| T8  | 严格相邻写，全部正交证据                | 0.38 | 0.12   | 0.10  | 0.08   | **0.68** | ✓ 强通过 |


**观察**：

- TUP 纯结构通过最少需要 AQ-1 + struct + multi（T1），或 AQ-2 + struct + multi（T4）
- "严格相邻写 + 同 struct"（T2）= 0.50，不通过——反映了"相邻写入太常见"的事实
- "严格相邻写 + 无正交证据"（T7）= 0.38，落入灰区——仅靠"紧挨着写"不足以判定关联
- 大量 TUP 组落入灰区 [0.35, 0.55)，是 LLM 的主要增值区域之一

### 5.3 DAC 推演


| #   | 场景描述                 | AQ   | struct | multi | naming | **S**    | 判定           |
| --- | -------------------- | ---- | ------ | ----- | ------ | -------- | ------------ |
| A1  | 直接 if，全部正交证据         | 0.22 | 0.12   | 0.10  | 0.08   | **0.52** | → 调 LLM      |
| A2  | 直接 if，同 struct + 命名  | 0.22 | 0.12   | —     | 0.08   | **0.42** | → 调 LLM      |
| A3  | 直接 if，仅同 struct      | 0.22 | 0.12   | —     | —      | **0.34** | → 调 LLM      |
| A4  | 直接 if，仅命名亲和          | 0.22 | —      | —     | 0.08   | **0.30** | → 调 LLM      |
| A5  | 直接 if，无正交证据          | 0.22 | —      | —     | —      | **0.22** | → 调 LLM      |
| A6  | switch-case，同 struct | 0.18 | 0.12   | —     | —      | **0.30** | → 调 LLM      |
| A7  | 嵌套条件，无正交证据           | 0.15 | —      | —     | —      | **0.15** | ✗ 丢弃（不调 LLM） |
| A8  | 嵌套条件，仅同 struct       | 0.15 | 0.12   | —     | —      | **0.27** | → 调 LLM      |


**观察**：

- DAC 无法纯靠结构通过 0.55——即使全部 3 个正交维度全中（A1）也只有 0.52，必须依赖 LLM
- 大量 DAC 组落入 LLM 评估区间 [0.20, 0.55)
- 嵌套条件 + 无正交证据（A7）= 0.15 < 0.20，直接丢弃——这类组连基本的结构线索都没有，不值得消耗 LLM 资源
- **DAC 的评分模型诚实地反映了方法论的能力边界**：结构分析对 DAC 关联性的判定力有限，LLM 是必要补充

---

## 6. LLM 语义增强层

### 6.1 设计原则：按需调用

LLM 不是对所有候选组做"第二意见"，而是**仅在结构证据不足时介入**：


| 优先级    | LLM 的角色            | 对应场景                                          |
| ------ | ------------------ | --------------------------------------------- |
| **P1** | 确定结构无法确定的关联（DAC）   | DAC 的 condition→body 语义歧义，只有 LLM 能判断是否存在一致性契约 |
| **P2** | 过滤结构灰区的误报（DFC/TUP） | 灰区组结构证据不够强，LLM 可以做二次确认                        |
| **P3** | 提供注意力排名权重          | LLM 判定的置信度自然形成排名，无需额外调用                       |


### 6.2 LLM 触发规则

```
              候选组（S 已计算）
                     │
        ┌────────────┼────────────┐
        │            │            │
      DFC          TUP          DAC
        │            │            │
   S ≥ 0.55?    S ≥ 0.55?    S ≥ 0.20?
        │            │            │
   ┌────┴────┐  ┌────┴────┐  ┌───┴───┐
  Yes      No  Yes      No  Yes    No
   │        │   │        │   │      │
 直接     S≥0.40? 直接  S≥0.35?  调   直接
 通过       │   通过     │   LLM  丢弃
          ┌─┴─┐       ┌─┴─┐   │
         Yes  No    Yes   No   │
          │    │     │     │   │
        调LLM 丢弃 调LLM  丢弃  │
          │          │         │
          └────┬─────┘─────────┘
               │
        conf = S + L × λ
               │
         conf ≥ 0.55 ?
         ┌─────┴─────┐
        Yes          No
         │            │
       通过         丢弃
```

**精确触发条件**：


| 锚点      | 直接通过（不调 LLM）         | 调 LLM（灰区）       | 直接丢弃（不调 LLM） |
| ------- | -------------------- | --------------- | ------------ |
| **DFC** | S ≥ 0.55             | 0.40 ≤ S < 0.55 | S < 0.40     |
| **TUP** | S ≥ 0.55             | 0.35 ≤ S < 0.55 | S < 0.35     |
| **DAC** | 无（即使 S=0.55 也调 LLM）* | S ≥ 0.20        | S < 0.20     |


> *DAC 的特殊处理：即使 DAC 的 S 达到 0.55（需要全部正交维度），仍然建议调 LLM。原因是 DAC 的结构维度都是弱信号——命名相似不代表有一致性契约。但在实践中，DAC S ≥ 0.55 极罕见，此规则几乎不触发额外调用。

### 6.3 LLM 输出格式

**不让 LLM 输出连续分数。** LLM 对"0.7 还是 0.8"的区分没有稳定性。采用**三级分类判定**：

```typescript
interface LLMVerdict {
  judgment: "STRONG" | "WEAK" | "NONE"
  reason: string  // 一句话理由，供用户审查
}
```


| 判定         | L 值 | 含义                   | 典型场景                                                |
| ---------- | --- | -------------------- | --------------------------------------------------- |
| **STRONG** | 1.0 | 变量间存在明确的一致性契约，必须原子更新 | `data_ready` 守护 `rx_buffer`，flag→data 是经典的生产者-消费者契约 |
| **WEAK**   | 0.5 | 变量间可能存在关联，但关系不确定     | 两个状态变量在同一 if 块中更新，但它们是否真的需要同步不清楚                    |
| **NONE**   | 0.0 | 变量间无语义关联，属于巧合的结构共现   | 两个无关计数器恰好在同一 if 块中递增                                |


**为什么三级而非二级？**

二级判定（related / unrelated）丢失了"不确定"信息。三级的 WEAK 表示"LLM 也无法确定"，最终反映为中等置信度——在报告中标记为"需人工复核"。

### 6.4 融合公式与 λ 参数

```
conf_final = S + L × λ(type)
```


| 锚点      | λ    | 设计理由                                                                                                         |
| ------- | ---- | ------------------------------------------------------------------------------------------------------------ |
| **DFC** | 0.15 | DFC 灰区 [0.40, 0.55) 很窄。L=STRONG 时 +0.15 刚好能把灰区底部（S=0.40）推到 0.55。LLM 做的是"确认"，不需要大权重。                          |
| **TUP** | 0.15 | 与 DFC 同理。TUP 灰区 [0.35, 0.55) 更宽，但 LLM 的角色同样是"二次确认"，不是主判定。                                                    |
| **DAC** | 0.40 | DAC 的 LLM 是**主判定通道**。λ=0.40 保证：即使 S 只有 0.22（直接 if，无正交证据），LLM STRONG 仍能推过 0.55。这精确对应了 P1 优先级——LLM 发现结构看不到的关联。 |


**λ 校准的核心约束**：


| 约束                         | 公式                               | 解                               |
| -------------------------- | -------------------------------- | ------------------------------- |
| DFC/TUP 灰区底部 + STRONG 必须过线 | S_min_gray + 1.0 × λ ≥ 0.55      | DFC: 0.40 + λ ≥ 0.55 → λ ≥ 0.15 |
| DAC 最弱合理组 + STRONG 必须过线    | 0.22 + 1.0 × λ ≥ 0.55            | λ ≥ 0.33，取 0.40 留余量             |
| DAC 最弱组 + WEAK 不应过线        | 0.22 + 0.5 × λ < 0.55            | λ < 0.66，满足                     |
| TUP 灰区中段 + WEAK 不应过线       | 0.45 + 0.5 × 0.15 = 0.525 < 0.55 | ✓                               |


### 6.5 融合后评分推演

#### DFC 灰区 + LLM


| 场景                   | S    | L 判定   | L 值 | conf  | 结果     |
| -------------------- | ---- | ------ | --- | ----- | ------ |
| 函数参数 sink + 同 struct | 0.52 | STRONG | 1.0 | 0.67  | ✓ 通过   |
| 函数参数 sink + 同 struct | 0.52 | WEAK   | 0.5 | 0.595 | ✓ 通过   |
| 函数参数 sink + 同 struct | 0.52 | NONE   | 0.0 | 0.52  | ✗ 丢弃   |
| 函数参数 sink，无正交        | 0.40 | STRONG | 1.0 | 0.55  | ✓ 刚好通过 |
| 函数参数 sink，无正交        | 0.40 | WEAK   | 0.5 | 0.475 | ✗ 丢弃   |


#### TUP 灰区 + LLM


| 场景            | S    | L 判定   | L 值 | conf  | 结果              |
| ------------- | ---- | ------ | --- | ----- | --------------- |
| 相邻写 + struct  | 0.50 | STRONG | 1.0 | 0.65  | ✓ 通过            |
| 相邻写 + struct  | 0.50 | WEAK   | 0.5 | 0.575 | ✓ 通过            |
| 相邻写 + naming  | 0.46 | STRONG | 1.0 | 0.61  | ✓ 通过            |
| 相邻写 + naming  | 0.46 | WEAK   | 0.5 | 0.535 | ✗ 丢弃            |
| 窗口内写 + struct  | 0.45 | STRONG | 1.0 | 0.60  | ✓ 通过            |
| 窗口内写，无正交      | 0.33 | —      | —   | —     | ✗ 低于灰区下限，不调 LLM |


#### DAC + LLM（核心价值区）


| 场景                      | S    | L 判定   | L 值 | conf     | 结果                         |
| ----------------------- | ---- | ------ | --- | -------- | -------------------------- |
| 直接 if + struct + naming | 0.42 | STRONG | 1.0 | **0.82** | ✓ 强通过，高排名                  |
| 直接 if + struct + naming | 0.42 | WEAK   | 0.5 | **0.62** | ✓ 通过，中排名                   |
| 直接 if + struct + naming | 0.42 | NONE   | 0.0 | 0.42     | ✗ 丢弃                       |
| 直接 if + struct          | 0.34 | STRONG | 1.0 | **0.74** | ✓ 通过                       |
| 直接 if + struct          | 0.34 | WEAK   | 0.5 | **0.54** | ✗ 不通过（差 0.01）              |
| 直接 if，无正交               | 0.22 | STRONG | 1.0 | **0.62** | ✓ **LLM 的核心价值：发现结构看不到的关联** |
| 直接 if，无正交               | 0.22 | WEAK   | 0.5 | 0.42     | ✗ LLM 也不确定，丢弃              |
| 直接 if，无正交               | 0.22 | NONE   | 0.0 | 0.22     | ✗ 明确无关联                    |
| switch-case + struct    | 0.30 | STRONG | 1.0 | **0.70** | ✓ 通过                       |
| 嵌套 + struct             | 0.27 | STRONG | 1.0 | **0.67** | ✓ 通过                       |
| 嵌套，无正交                  | 0.15 | —      | —   | —        | ✗ 低于 0.20，不调 LLM           |


**关键行为验证**：

1. **P1（发现结构无法确定的关联）**：DAC S=0.22 + STRONG → 0.62 通过 ✓
2. **P2（过滤误报）**：DAC S=0.22 + NONE → 0.22 丢弃 ✓；DFC S=0.52 + NONE → 0.52 丢弃 ✓
3. **P3（排名权重）**：DAC STRONG→0.82 vs WEAK→0.62 的区分度支撑用户注意力排名 ✓

### 6.6 LLM Prompt 设计

#### DFC/TUP 批量评估 Prompt

```markdown
你是嵌入式系统并发安全分析专家。以下变量组从 C/C++ 代码中提取，
每组中的变量在代码中存在结构性关联（数据流汇聚或同块写入）。

请判断每组变量是否**需要原子更新**——即如果中断在访问一个变量后、
访问另一个变量前打断，是否会导致系统状态不一致。

对每组回答：
- STRONG: 变量间存在明确的语义耦合，必须原子更新
- WEAK: 可能存在关联但不确定
- NONE: 无语义关联，结构共现是巧合

## 组 1 (DFC — 数据流汇聚)
- 变量: `pos_x`, `pos_y`
- 汇聚点: `distance = sqrt(pos_x*pos_x + pos_y*pos_y)` (line 142)
- 函数: CalculateDistance()
- 上下文代码:
  ```c
  // lines 140-145
  float distance = sqrt(pos_x*pos_x + pos_y*pos_y);
  if (distance > THRESHOLD) alarm();
```

## 组 2 (TUP — 事务性写入)

...

请按以下 JSON 格式回答：
[
  {"group": 1, "judgment": "STRONG", "reason": "pos_x 和 pos_y 共同决定 distance，部分更新导致距离计算错误"},
  {"group": 2, ...}
]

```

#### DAC 批量评估 Prompt

```markdown
你是嵌入式系统并发安全分析专家。以下变量组从 C/C++ 代码中提取，
每组包含一个"条件变量"（在 if/switch 条件中被读取）和一个或多个
"操作变量"（在条件控制的代码体中被访问）。

请判断每组中的变量是否构成**一致性契约**：
即条件变量的值约束了操作变量的合法状态——如果中断在条件检查后、
操作执行前修改了条件变量（或操作变量），会导致不一致的行为。

对每组回答：
- STRONG: 明确存在一致性契约（如：标志位控制数据更新）
- WEAK: 可能存在关联但不确定
- NONE: 无语义关联（如：恰好在同一条件块中但逻辑独立）

## 组 1
- 条件变量: `comm_ready` (READ in if-condition, line 142)
- 操作变量: `tx_buf[0]`, `tx_buf[1]` (WRITE in if-body, lines 145-146)
- 函数: SendPacket()
- 上下文代码:
  ```c
  // lines 140-150
  if (comm_ready) {
      tx_buf[0] = header;
      tx_buf[1] = payload;
      send_packet(tx_buf, 2);
  }
```

## 组 2

...

请按以下 JSON 格式回答：
[
  {"group": 1, "judgment": "STRONG", "reason": "comm_ready 控制发送缓冲区填充，中断修改 comm_ready 可能导致部分发送"},
  {"group": 2, ...}
]

```

**批量策略**：每次调用打包 5-10 组，按源文件/函数聚合。

---

## 7. 无 LLM 降级模式

当 LLM 不可用时（如离线环境、成本限制），系统仍可独立运行：

| 锚点 | 降级策略 | 阈值调整 | 影响 |
|------|---------|---------|------|
| **DFC** | 无变化 | 保持 0.55 | 绝大多数 DFC 靠结构通过，灰区（约 15%）丢失 |
| **TUP** | 灰区组直接使用 S_score | 降至 **0.48** | 部分灰区组通过，略增误报（灰区组本身不多） |
| **DAC** | 所有 S ≥ 0.20 的组直接通过 | 降至 **0.45** | 大量 DAC 通过但标记为"未经语义验证"，FP 显著增加但保证不漏检 |

**降级输出标记**：

```json
{
  "id": "cg_042",
  "anchor_type": "DAC",
  "confidence": 0.34,
  "llm_status": "UNAVAILABLE",
  "llm_note": "LLM unavailable; confidence based on structural evidence only; manual review recommended"
}
```

用户在报告中看到 `llm_status: UNAVAILABLE` 时，知道此组未经语义验证，需优先人工审查。

---

## 8. 调用量估算

以 real2_bench 为基准（工具层过滤后约 120 个候选组，含 DFC ~30、TUP ~40、DAC ~50）：


| 分类           | 候选数      | 直通     | 灰区 LLM | 丢弃     | LLM 调用次数   |
| ------------ | -------- | ------ | ------ | ------ | ---------- |
| DFC S ≥ 0.55 | ~25      | 25     | —      | —      | 0          |
| DFC 灰区       | ~3       | —      | 3      | —      | ≤1（批量）     |
| DFC S < 0.40 | ~2       | —      | —      | 2      | 0          |
| TUP S ≥ 0.55 | ~15      | 15     | —      | —      | 0          |
| TUP 灰区       | ~18      | —      | 18     | —      | 2-3（批量）    |
| TUP S < 0.35 | ~7       | —      | —      | 7      | 0          |
| DAC S ≥ 0.20 | ~40      | —      | 40     | —      | 4-5（批量）    |
| DAC S < 0.20 | ~10      | —      | —      | 10     | 0          |
| **合计**       | **~120** | **40** | **61** | **19** | **~7-9 次** |


**与全量调用对比**：


| 方案               | LLM 调用次数   | 成本                |
| ---------------- | ---------- | ----------------- |
| 全量（每组一次）         | ~120 次     | 基线                |
| 全量 + 批量          | ~15-20 次   | ↓ 85%             |
| **按需 + 批量（本方案）** | **~7-9 次** | **↓ 94%**         |
| 无 LLM            | 0 次        | ↓ 100%（DAC 召回率下降） |


---

## 9. 与旧模型的对比

### 9.1 结构变化


| 方面          | 旧模型                                                            | 新模型                           |
| ----------- | -------------------------------------------------------------- | ----------------------------- |
| **基分语义**    | "你是 DFC 所以给 0.55"                                              | "你的 sink 是算术表达式所以给 0.50"      |
| **维度独立性**   | DFC 有 `dependency_depth`（与定义重叠） TUP 有 `struct_members`（混入基分语义） | 4 个正交维度，不依赖锚点定义               |
| **跨类型一致性**  | 每类各有不同维度集，分数不可比                                                | 正交维度所有类型共享，分数可比               |
| **区分度**     | DFC S_min=0.55（全部直通）                                           | DFC S 范围 [0.35, 0.80]，有效区分强/弱 |
| **DAC 诚实度** | base=0.20 假装结构够用                                               | base 最高 0.22，明确承认结构不足         |
| **LLM 策略**  | 全量调用（或模拟）                                                      | 按需分级，调用量降 94%                 |


### 9.2 参数映射


| 旧模型参数                                     | 新模型对应                                        | 变化                       |
| ----------------------------------------- | -------------------------------------------- | ------------------------ |
| DFC base=0.55                             | AQ-1=0.50, AQ-2=0.45, AQ-3=0.40, AQ-4=0.45, AQ-5=0.35 | 按 sink 类型+间接深度细分     |
| DFC dependency_depth (+0~0.05)            | **删除**                                       | 与 DFC 定义重叠               |
| DFC code_distance (+0~0.07)               | **删除**                                       | 区分度低，被 AQ 子分类替代          |
| DFC struct_base (+0.04)                   | OE struct_cohesion (+0.12)                   | 升级为跨类型维度，权重提升            |
| DFC adjacent_address (+0.04)              | OE naming_affinity (+0.08)                   | 合并入命名亲和                  |
| DFC naming_pattern (+0.02)                | OE naming_affinity (+0.08)                   | 合并，权重提升                  |
| TUP base=0.35                             | AQ-1=0.38, AQ-2=0.33（仅 2 级，受 Joern gap≤5 约束） | 按写入紧密度细分                 |
| TUP struct_members/array_elements (+0.25) | OE struct_cohesion (+0.12)                   | 语义分离（不再混入锚点质量）           |
| TUP adjacent_address (+0.12)              | OE naming_affinity (+0.08)                   | 统一权重                     |
| TUP same_domain (+0.05)                   | OE naming_affinity (+0.08)                   | 合并                       |
| TUP line_proximity (+0~0.05)              | AQ 子分类                                       | 融入锚点质量分级                 |
| DAC base=0.20                             | AQ-1=0.22, AQ-2=0.18, AQ-3=0.15              | 按控制结构细分                  |
| DAC struct_base (+0.08)                   | OE struct_cohesion (+0.12)                   | 统一                       |
| DAC naming_pattern (+0~0.06)              | OE naming_affinity (+0.08)                   | 统一                       |
| DAC naming_similarity (+0.04)             | OE naming_affinity (+0.08)                   | 合并                       |
| DAC disjoint_rw (+0.03)                   | **删除**                                       | 与 DAC 定义重叠（几乎所有 DAC 都满足） |
| DFC λ=0.29, TUP λ=0.35, DAC λ=0.59        | DFC λ=0.15, TUP λ=0.15, DAC λ=0.40           | 按需调用后权重调整                |


---

## 10. 参数总表

```
┌──────────────────────────────────────────────────────────┐
│               评分模型完整参数表                            │
│          confidence = AQ + Σ OE [ + L × λ ]              │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  ┌─── AQ (锚点匹配质量) ───────────────────────────────┐  │
│  │                                                     │  │
│  │  DFC-1  算术/位运算 sink       0.50                    │  │
│  │  DFC-2  比较/逻辑 sink         0.45                    │  │
│  │  DFC-3  函数参数 sink          0.40                    │  │
│  │  DFC-4  浅层间接汇聚(≤2层)     0.45                    │  │
│  │  DFC-5  深层间接汇聚(>2层)     0.35                    │  │
│  │  (当前降级: 统一 AQ=0.45, 待 Joern 输出 sink 子类型)  │  │
│  │                                                     │  │
│  │  TUP-1  严格相邻写(gap≤1)     0.38                    │  │
│  │  TUP-2  窗口内写(1<gap≤5)    0.33                    │  │
│  │  (Joern MAX_WRITE_GAP=5 约束: 不存在 gap>5 的 TUP)   │  │
│  │                                                     │  │
│  │  DAC-1  直接if-body          0.22                    │  │
│  │  DAC-2  switch-case          0.18                    │  │
│  │  DAC-3  嵌套条件             0.15                    │  │
│  │  (当前降级: 统一 AQ=0.20, 待 Joern 输出控制结构类型)  │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                          │
│  ┌─── OE (正交证据，所有类型共享) ────────────────────┐   │
│  │                                                     │  │
│  │  struct_cohesion   同一结构体/数组字段   +0.12       │  │
│  │  multi_site        ≥2处代码位置共现     +0.10       │  │
│  │  naming_affinity   配对命名模式         +0.08       │  │
│  │                                         ─────       │  │
│  │                                   max = +0.30       │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                          │
│  ┌─── LLM 融合 ──────────────────────────────────────┐   │
│  │                                                     │  │
│  │  统一通过阈值: 0.55                                  │  │
│  │  融合公式: conf = S + L × λ                          │  │
│  │                                                     │  │
│  │  L 取值: STRONG=1.0, WEAK=0.5, NONE=0.0             │  │
│  │                                                     │  │
│  │  λ_DFC = 0.15    (灰区 [0.40, 0.55) 触发)           │  │
│  │  λ_TUP = 0.15    (灰区 [0.35, 0.55) 触发)           │  │
│  │  λ_DAC = 0.40    (S ≥ 0.20 全部触发)                │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                          │
│  ┌─── 降级阈值（无 LLM 时） ─────────────────────────┐   │
│  │                                                     │  │
│  │  DFC: 0.55（不变）                                   │  │
│  │  TUP: 0.48（降低）                                   │  │
│  │  DAC: 0.45（降低，标记 llm_status=UNAVAILABLE）      │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                          │
│  ┌─── 评分范围汇总 ──────────────────────────────────┐   │
│  │                                                     │  │
│  │  DFC 纯结构: [0.35, 0.80]  典型通过: ≥0.55          │  │
│  │  TUP 纯结构: [0.33, 0.68]  典型通过需灰区LLM确认    │  │
│  │  DAC 纯结构: [0.15, 0.52]  全需 LLM                 │  │
│  │                                                     │  │
│  │  DFC + LLM:  [0.35, 0.95]                           │  │
│  │  TUP + LLM:  [0.33, 0.83]                           │  │
│  │  DAC + LLM:  [0.15, 0.92]                           │  │
│  └─────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

---

## 11. 代码变更规格

本节为实现者（或 LLM 代码生成）提供精确的变更清单。变更分为两期：

- **Phase 1（当前可实现）**：基于当前 Joern 输出能力，使用降级 AQ + 已有/可计算的 OE
- **Phase 2（需 Joern 增强）**：扩展 Joern 输出后，启用完整 AQ 子分级

### 11.1 Phase 1 变更清单

#### 变更 1：重写 `computeDataflowScore()` — 文件 `src/tools/multivar-correlated-vars.ts`

**删除的维度**：`dependency_depth`、`code_distance`（与 DFC 定义重叠或区分度低）

**保留/修改的维度**：

- `base` → 改为 `aq`，降级值 **0.45**（统一，待 Phase 2 按 sink 类型细分）
- `struct_base` + `adjacent_address` → 统一为 `struct_cohesion`，分值 **+0.12**（同一结构体字段或同一数组元素共享基名）
- `naming_pattern` → 改名为 `naming_affinity`，分值 **+0.08**（合并旧的 `adjacent_address` H/L 模式和共前缀模式）
- 新增 `multi_site`，分值 **+0.10**（见变更 4）

**LLM 维度**：

- `llm_score` 乘数从 `0.29` 改为 λ = **0.15**
- `llm_score` 输入从连续 0-1 改为离散 {0, 0.5, 1.0}（对应 NONE/WEAK/STRONG）

**伪代码**：

```typescript
function computeDataflowScore(group: CVGroup): { score: number; breakdown: EvidenceBreakdown } {
  const breakdown: EvidenceBreakdown = {}

  // AQ: 降级模式，统一 0.45（Phase 2 按 sink 类型给 0.35-0.50）
  breakdown.aq = 0.45

  // OE: struct_cohesion (+0.12)
  if (group.struct_base || isArrayElementGroup(group.accesses)) {
    breakdown.struct_cohesion = 0.12
  }

  // OE: multi_site (+0.10) — 见变更 4
  if ((group.multi_site_count ?? 0) >= 2) {
    breakdown.multi_site = 0.10
  }

  // OE: naming_affinity (+0.08) — 合并 H/L 后缀 + 共前缀
  if (hasAdjacentAddressPattern(uniqueVars) || extractCommonPrefix(uniqueVars)) {
    breakdown.naming_affinity = 0.08
  }

  // LLM (λ=0.15)
  const llmScore = group.evidence?.llm_score ?? 0  // {0, 0.5, 1.0}
  if (llmScore > 0) {
    breakdown.llm_contribution = round3(llmScore * 0.15)
  }

  const score = Object.values(breakdown).reduce((sum, v) => sum + v, 0)
  return { score: round3(score), breakdown }
}
```

#### 变更 2：重写 `computeTransactionalScore()` — 文件 `src/tools/multivar-correlated-vars.ts`

**删除的维度**：`base`（旧的统一基分）、`line_proximity`（融入 AQ）、互斥 sub-type 逻辑（`struct_members`/`array_elements`/`adjacent_address`/`same_domain` 全部删除）

**新维度**：

- `aq`：根据写操作行距计算
  - `gap = |line_b - line_a|`，gap ≤ 1 → **0.38**，else → **0.33**
  - gap 从 `group.accesses` 的行号计算（取写操作的最小和最大行号之差）
- `struct_cohesion`：**+0.12**（同 DFC）
- `multi_site`：**+0.10**
- `naming_affinity`：**+0.08**（同 DFC）
- `llm_contribution`：llmScore × λ = **0.15**

**伪代码**：

```typescript
function computeTransactionalScore(group: CVGroup): { score: number; breakdown: EvidenceBreakdown } {
  const breakdown: EvidenceBreakdown = {}

  // AQ: 基于写操作行距
  const writeLines = group.accesses
    .filter(a => a.access_type === "WRITE")
    .map(a => a.location.line)
    .filter(l => l > 0)
    .sort((a, b) => a - b)
  const gap = writeLines.length >= 2
    ? writeLines[writeLines.length - 1] - writeLines[0]
    : 0
  breakdown.aq = gap <= 1 ? 0.38 : 0.33

  // OE: struct_cohesion (+0.12)
  if (group.struct_base || isArrayElementGroup(group.accesses)) {
    breakdown.struct_cohesion = 0.12
  }

  // OE: multi_site (+0.10)
  if ((group.multi_site_count ?? 0) >= 2) {
    breakdown.multi_site = 0.10
  }

  // OE: naming_affinity (+0.08)
  const uniqueVars = [...new Set(group.variables)]
  if (hasAdjacentAddressPattern(uniqueVars) || extractCommonPrefix(uniqueVars)) {
    breakdown.naming_affinity = 0.08
  }

  // LLM (λ=0.15)
  const llmScore = group.evidence?.llm_score ?? 0
  if (llmScore > 0) {
    breakdown.llm_contribution = round3(llmScore * 0.15)
  }

  const score = Object.values(breakdown).reduce((sum, v) => sum + v, 0)
  return { score: round3(score), breakdown }
}
```

#### 变更 3：重写 `computeDacScore()` — 文件 `src/tools/multivar-correlated-vars.ts`

**删除的维度**：`base`（旧统一基分）、`disjoint_rw`（与 DAC 定义重叠）、`naming_pattern` 和 `naming_similarity`（合并入 `naming_affinity`）

**新维度**：

- `aq`：降级值 **0.20**（Phase 2 按控制结构类型给 0.15-0.22）
- `struct_cohesion`：**+0.12**
- `multi_site`：**+0.10**
- `naming_affinity`：**+0.08**（保留 FLAG_PATTERN/DATA_PATTERN 匹配逻辑，纳入 naming_affinity 统一维度）
- `llm_contribution`：llmScore × λ = **0.40**

#### 变更 4：新增 `multi_site` 计算 — 文件 `src/tools/multivar-correlated-vars.ts`

在 `parseJoernAccessLists()` 处理完所有 AccessList 后、调用 `refineEvidence()` 前：

1. 对所有组按**变量集合**（排序后的变量名集合）分组
2. 统计每个变量集合出现在多少个**不同的函数或不同的行区间**（行区间差 > 20 行视为不同位置）
3. 将计数写入 `group.multi_site_count`

**需要扩展 `CVGroup` 类型**，新增可选字段：

```typescript
multi_site_count?: number  // 同一变量集合在不同代码位置的出现次数
```

#### 变更 5：更新工具层过滤阈值 — 文件 `src/tools/multivar-correlated-vars.ts`

`refineEvidence()` 中的过滤逻辑从：

```typescript
const threshold = group.anchor_type === "DAC" ? 0.20 : 0.50
```

改为：

```typescript
const threshold = group.anchor_type === "DAC" ? 0.20
                : group.anchor_type === "TUP" ? 0.35
                : 0.40  // DFC
```

这对应 LLM 触发规则中的"直接丢弃"下限。低于此分数的组既不调 LLM 也不通过。

#### 变更 6：更新 Agent Step 3.5 — 文件 `src/agents/multivar-atomicity-checker.ts`

当前 Step 3.5 指导 agent 为每组输出连续 `llm_score`（0-1）。改为：

1. **输出格式**：每组输出 `judgment: "STRONG" | "WEAK" | "NONE"` + `reason: string`
2. **写回逻辑**：STRONG → `llm_score = 1.0`，WEAK → `llm_score = 0.5`，NONE → `llm_score = 0.0`
3. **触发条件**：
  - DFC：仅当 S ∈ [0.40, 0.55) 时评估（其余直通或丢弃）
  - TUP：仅当 S ∈ [0.35, 0.55) 时评估
  - DAC：S ≥ 0.20 全部评估
4. **批量策略**：按源文件/函数聚合，每批 5-10 组
5. **LLM 不可用时**：跳过评估，标记 `llm_status = "UNAVAILABLE"`

#### 变更 7：更新 SKILL.md — 文件 `skills/multivar-atomicity/SKILL.md`

更新评分参数表和 Step 3.5 说明，与新模型一致。重点修改：

- §3.3 证据评分体系表格
- §3.4 Step 3.5 LLM 评估流程
- §4.1 最终过滤阈值

#### 变更 8：更新 `EvidenceBreakdown` 类型

旧的 breakdown 键（`base`, `dependency_depth`, `code_distance`, `struct_base`, `struct_members`, `array_elements`, `adjacent_address`, `same_domain`, `naming_pattern`, `naming_similarity`, `disjoint_rw`, `line_proximity`）全部替换为新键：

```typescript
type EvidenceBreakdown = Record<string, number>
// 新的标准键：
// aq                — 锚点匹配质量
// struct_cohesion   — 结构体内聚
// multi_site        — 多点共现
// naming_affinity   — 命名亲和
// llm_contribution  — LLM 融合贡献
```

#### 变更 9：更新 pipeline 测试脚本

`scripts/run-atomicity-real1.ts` 和 `scripts/run-atomicity-real2.ts` 中的 "Simulated Step 3.5" 逻辑需要适配新的 λ 值和离散 LLM 分数：

- `llm_score = 0.5`（模拟 WEAK 判定）
- `typeScale` 从 `{DFC: 0.29, TUP: 0.35, DAC: 0.59}` 改为 `{DFC: 0.15, TUP: 0.15, DAC: 0.40}`
- 但注意：模拟脚本中的 confidence 不再需要手动计算，因为 `refineEvidence()` 重新调用评分函数时会自动使用新公式

#### 变更 10：更新 deep-dive 文档

`docs/multivar-atomicity-checker-deep-dive.md` §7.4（证据评分体系）和 §8（Step 3.5）需要与新模型同步更新。§13（评分参数表）应引用本文档或直接替换。

### 11.2 Phase 2 变更清单（需 Joern 增强）


| 变更                     | 文件                                       | 内容                                                                                                                                               |
| ---------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Joern sink 子类型输出       | `joern/multivarCorrelatedVarsIdentify.scala` | `nodeSourceMap` 的值从 `"sink"` 扩展为 `"sink:arithmetic"` / `"sink:comparison"` / `"sink:call"` / `"sink:indirect:N"`（N 为赋值链深度）                        |
| Joern 控制结构类型输出         | `joern/multivarCorrelatedVarsIdentify.scala` | `nodeSourceMap` 的值从 `"dac"` 扩展为 `"dac:if"` / `"dac:switch"` / `"dac:nested"`                                                                     |
| TypeScript 解析 sink 子类型 | `src/tools/multivar-correlated-vars.ts` | `parseJoernAccessLists()` 解析 `"sink:xxx"` 格式，映射到 AQ 等级                                                                                           |
| TypeScript 解析 DAC 子类型  | `src/tools/multivar-correlated-vars.ts` | 同上，解析 `"dac:xxx"` 格式                                                                                                                             |
| DFC AQ 完整分级            | `src/tools/multivar-correlated-vars.ts` | `computeDataflowScore()` 中 `aq` 从固定 0.45 改为按 sink 子类型：arithmetic→0.50, comparison→0.45, call→0.40, indirect≤2→0.45, indirect>2→0.35 |
| DAC AQ 完整分级            | `src/tools/multivar-correlated-vars.ts` | `computeDacScore()` 中 `aq` 从固定 0.20 改为按控制结构：if→0.22, switch→0.18, nested→0.15                                                                    |


