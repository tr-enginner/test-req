---
name: singlevar-atomicity
description: "单变量原子性违反检测方法论：4 种访问交错模式（RWR/RWW/WRW/WWR/WWW）匹配、原子意图推断、路径可行性验证"
metadata:
  agent: "singlevar-atomicity-checker"
  category: "quality"
---

# 单变量原子性违反检测方法论

本技能定义 singlevar-atomicity-checker 的检测方法论，针对**单个共享变量**的连续访问被中断打断导致状态不一致的情况。

> **本方法基于 intAtom (ISSTA '22) 论文 + 工程改进**：保留分阶段路径剪枝架构，针对论文 6 大缺陷（同函数硬裁剪、循环简化、无别名分析、Z3 退化策略缺失、中断 timing 过宽、代表性抢占点选择无形式证明）做对应修复。

## 0. 核心原则

1. **分阶段渐进**：轻量分析筛候选 → 路径互斥/LLM 过滤无意图 → 并发可行性最终剪枝
2. **结构启发 + 语义判定**：Joern 数据流找候选，LLM 三级判定补语义
3. **soundness 优先**：宁可输出 UNKNOWN 也不强判 CONFIRMED；不可用工具失败时整链路降级
4. **与多变量检测正交**：本方法只看单变量；多变量关联由 multivar-atomicity-checker 处理

---

## 1. 五种访问交错模式

> **模式编码**：`<低优先级 1>-<高优先级>-<低优先级 2>`，R=Read W=Write
>
> 三次访问的目标变量**必须是同一个共享变量**（含 alias 规范化）

| 模式 | 时序 | 典型后果 | benchmark 案例数 |
|------|------|---------|----------------|
| **RWR** | Low-R(X), ISR-W(X), Low-R(X) | 两次读到不一致的值 | 5 |
| **RWW** | Low-R(X), ISR-W(X), Low-W(X) | 丢失更新（lost update） | 10 |
| **WRW** | Low-W(X), ISR-R(X), Low-W(X) | ISR 读到中间状态 | 2 |
| **WWR** | Low-W(X), ISR-W(X), Low-R(X) | 主任务读到 ISR 覆盖后的值 | 1 |
| **WWW** | Low-W(X), ISR-W(X), Low-W(X) | 三次写之间状态不一致 | 0 (benchmark 待补) |

> 单变量 WWW 通常被多变量分析归入 TUP_WWWW，但当三次写都针对**同一变量**时，本工具也匹配该模式。

---

## 2. 三阶段流水线

### Stage 1 — 候选挖掘（轻量级数据流）

**目标**：在每个 task/ISR 中找出所有"对同一变量的连续 local accesses"（intAtom 称之为 consecutive access pair），与 ISR 中对同一变量的访问做笛卡尔积，匹配出 5 类模式的候选。

**步骤**：

1. **共享变量集合**：通过 Joern 查询全局变量、static 变量、被 ≥2 个 entry function 访问的变量；
2. **连续访问对识别**（每个 entry function 内）：找 (e1, e2) 使得：
   - e1, e2 都访问同一 canonical 变量（见 §4 别名规范化）
   - 从 e1 后到 e2 之前的 CFG 路径上，**不存在**对同一 canonical 变量的其他访问
3. **远程访问枚举**：对每个 ISR，列出对同一 canonical 变量的所有访问点 e_r
4. **模式匹配**：对每个 (e1, e_r, e2) 三元组按 access_type 匹配 5 种模式
5. **结构性置信度初始评分**：见 §3

**重要**：本阶段**不做**路径可行性、不调 LLM、不做 Z3，目的是宽召回（不漏检）。

### Stage 2 — 原子意图过滤（路径条件 + LLM 双路）

**目标**：剔除"程序员根本没有原子假设"的伪候选——intAtom Stage 2 的核心思想，但用双路冗余防止 FP。

**判定流程**：

```
for each candidate (e1, e_r, e2):
    intent_by_path  = check_path_mutex(e1, e2)       # 路径互斥推断
    intent_by_llm   = llm_judge_atomic_intent(e1, e2) # LLM 三级判定
    
    if intent_by_path == false AND intent_by_llm == NONE:
        drop_candidate(reason="no_atomic_intent")
    elif intent_by_path == false AND intent_by_llm == WEAK:
        downgrade_confidence(factor=0.7)
    # 其他情况保留候选
```

**路径互斥检测**：

- 收集 e1 与 e2 的 enclosing path conditions
- 用 Z3 检查 PC(e1) ∧ PC(e2) 是否可满足
- 不可满足 → 路径互斥 → 无原子意图

**LLM 原子意图判定**（contract §3 scenario=`atomic_intent`，λ=0.30）：

```
Prompt：阅读 e1 与 e2 之间的代码片段。
e1 在 line X 访问变量 V，e2 在 line Y 也访问 V。
判断：程序员是否期望 e1 和 e2 看到 V 的同一状态（即原子）？
- STRONG: 明确的原子意图（如复制后使用、读后基于该值做决策）
- WEAK: 可能有意图但不确定
- NONE: 两次访问语义独立，程序员无原子假设
```

### Stage 3 — 并发可行性剪枝（Joern + Z3）

**目标**：对通过 Stage 2 的候选，验证 ISR 抢占在 e1-e2 间的实际可行性。

**子路径分解**（与 multi-var multivar-atomicity-checker 共享接口）：

| 子路径 | 起点 | 终点 | 检查 |
|--------|------|------|------|
| SP1 | low-priority entry | e1 | low-pri 入口能否到达 e1 |
| SP2 | ISR entry | e_r | ISR 入口能否到达 e_r |
| SP3 | e1 | e2 | 抢占窗口内 ISR 可执行的路径 |

**优化技术**（来自 intAtom Stage 3）：

1. **中断符号摘要**：对每个 ISR 构建一次，多个候选复用
2. **代表性抢占点选择**：对 SP3 上的每个可能抢占点，按 intAtom 论文 §3.3.2 规则筛选代表性点（节省 Z3 调用）
3. **初始化阶段排除**：复用 multi-var 工具的 `init_functions` 机制

**判定结果**：

- SAT → CONFIRMED, severity = critical
- UNSAT → INFEASIBLE, severity = info（仅记录）
- UNKNOWN → UNKNOWN, severity = major（LLM 兜底）
- timeout → UNKNOWN，可调 LLM scenario=`z3_unknown_fallback` 做二次判定

---

## 3. 置信度评分

```
confidence = AQ + Σ OE + llm_score × λ(scenario) × cross_function_multiplier
```

### 3.1 AQ（结构匹配质量）

| 模式 | AQ |
|------|----|
| RWR | 0.50 |
| RWW | 0.55（丢失更新最有害） |
| WRW | 0.45 |
| WWR | 0.45 |
| WWW | 0.40 |

### 3.2 OE（正交证据）

| 维度 | 加分 | 触发条件 |
|------|------|---------|
| volatile_marked | +0.10 | 变量有 volatile 修饰 |
| multi_isr | +0.08 | 多个 ISR 都访问该变量 |
| no_protection | +0.15 | 候选三访问点附近无关中断/critical section 调用 |
| rmw_op | +0.08 | local2 是 RMW 操作（`++`, `+=`, `|=` 等） |

OE 上限 0.30。

### 3.3 LLM 贡献

`λ = 0.30`（contract §3 已登记）

- 工具上限 ≈ 0.85 (AQ 0.55 + OE 0.30)
- LLM STRONG (L=1.0) 加 0.30 → 1.00 上限

### 3.4 跨函数松弛衰减

跨函数候选（local1 与 local2 不在同一函数）的置信度乘以衰减因子：

| 调用链深度 | 衰减因子 |
|----------|---------|
| 1 (同函数) | 1.00 |
| 2 | 0.90 |
| 3 | 0.80 |
| 4 | 0.70 |
| ≥5 | 0.60，且**调用链不能含中断 enable/disable/yield 调用**，否则直接丢弃 |

### 3.5 过滤阈值

- 工具层（Stage 1 后）：confidence ≥ 0.40 保留
- 最终阈值（Stage 3 后）：confidence ≥ 0.55 报告

---

## 4. 别名规范化（intAtom 论文未覆盖，本工具新增）

intAtom 论文未讨论 alias，但本 benchmark 中 8/18 案例涉及结构体成员或数组元素（L1_005 `Obdh.DeltB`、L2_001 `CAN.InitCount4s`、L2_004 `T_Can_SlowRmt[52]` 等）。**必须**在 Stage 1 之前做规范化，否则会漏检。

### 4.1 规范化规则

| 原始表达式 | canonical_name | rule |
|----------|---------------|------|
| `x` | `x` | EXACT |
| `s.field` | `s.field` | STRUCT_FIELD |
| `arr[5]` | `arr[5]` | ARRAY_ELEMENT_FIXED |
| `arr[i]` | `arr[*]`（保守过近似） | ARRAY_ELEMENT_SYMBOLIC |
| `*p`（已知 p 指向 x） | `x` | POINTER_DEREF |
| `*(volatile uint32_t*)0x40000000` | `MMIO_<region>_<offset>` | MMIO_REGISTER |

### 4.2 数组索引对齐策略

- `arr[5]` 与 `arr[5]` → 同 canonical（精确）
- `arr[5]` 与 `arr[7]` → 不同 canonical（精确）
- `arr[i]` 与 `arr[5]` → 同 canonical，**但置信度衰减 30%**（保守过近似）
- `arr[i]` 与 `arr[j]` → 同 canonical，**置信度衰减 50%**

### 4.3 MMIO 地址识别

- 从 `#define` 宏中提取 `((volatile uint32_t*)0x40010000)` 类模式
- 与项目链接脚本（.ld 文件）或外设头文件交叉验证
- 识别失败时回退到 EXACT 规则，标 `confidence_note: "alias_uncertain"`

---

## 5. 跨函数松弛（论文同函数硬裁剪的修复）

intAtom 论文将 local1 与 local2 限制在同一函数内，会漏检 L3 案例（多层调用链）。本工具采用**调用链分析松弛**：

### 5.1 允许跨函数的条件

local1 与 local2 跨函数时，记录调用链 `[f1, f2, ..., fn]`，**全部**满足才保留：

1. 调用链深度 ≤ 5 层（若 ≥ 5 层要求 6.2 全部满足）
2. 调用链上**无**中断 enable/disable 调用（`__enable_irq`, `EA=1`, `taskENTER_CRITICAL` 等）
3. 调用链上**无**让出 CPU 调用（`taskYIELD`, `vTaskDelay`, `sleep` 等）
4. 调用链上**无**对相同 canonical 变量的 spin-wait 循环

不满足上述任一条件 → 该候选丢弃，但记录到 `dropped_candidates.json` 供后续 LLM 抽样复审。

### 5.2 严格模式

对深度 ≥ 5 的调用链，额外要求：

- LLM 在 scenario=`atomic_intent` 判定为 STRONG
- 调用链上每一跳都不引入新的共享变量访问（"透明传递"）

---

## 6. 中断使能流敏感分析

复用 multi-var multivar-atomicity-checker 的实现：

- 沿 CFG 路径维护"中断使能状态"（enabled / disabled）
- 识别平台特定使能/禁用 API（按 compiler_dialect 推断 + 项目代码扫描）
- 在抢占窗口（SP3）内若中断被禁用 → INFEASIBLE
- 平台支持：ARM (`__disable_irq/__enable_irq`)、8051 (`EA=0/EA=1`)、SPARC (`sparc_enable_interrupt`)、RTEMS (`rtems_interrupt_disable/enable`)、FreeRTOS (`taskENTER_CRITICAL/taskEXIT_CRITICAL`) 等

---

## 7. 循环处理（论文 6 个 FP 来源的修复）

intAtom 直接忽略循环变量路径条件 → 在含循环的代码中假阳性。

### 7.1 改进策略

1. **常量边界循环**：`for(i=0;i<N;i++)` N 是常量/宏 → 符号区间 `i ∈ [0, N-1]` 编码到 Z3
2. **变量边界循环**：N 是变量 → 调 LLM 推断（scenario=`atomic_intent` 的 prompt 中附带循环上下文）
3. **未知边界**：保守过近似，置信度衰减 20%，标 `loop_uncertain: true`

### 7.2 处理 RMW 在循环中的特殊情况

如 `for(i=0;i<N;i++) { counter += a[i]; }` 中的 `counter += a[i]` 单步 RMW 实际是 (R, W) 而非两次独立访问。**Stage 1 必须将整个 RMW 当作单一操作**，不分裂为 R 和 W。

---

## 8. 修复建议输出

按 benchmark fix_strategy 取值：

| strategy | 适用场景 |
|----------|---------|
| `disable_global_interrupt` | 全局关中断保护，最强但影响实时性 |
| `disable_specific_interrupt` | 仅关导致冲突的 ISR，更细粒度 |
| `copy_under_protection` | 关中断拷贝到局部副本，主体计算无锁 |
| `atomic_intrinsic` | 平台支持时（如 ARM `__LDREX/__STREX`）使用原子操作 |
| `redesign` | 上述均不适合时建议重构 |

LLM 根据访问模式与代码上下文给出策略与一句话理由。

---

## 9. 输出产物

| 文件 | 描述 |
|------|------|
| `.matrix/data/singlevar-pairs.json` | Stage 1: 所有连续访问对 |
| `.matrix/data/singlevar-candidates.json` | Stage 1: 模式匹配后的候选 |
| `.matrix/data/singlevar-interrupt-summaries.json` | Stage 3: ISR 符号摘要 |
| `.matrix/data/singlevar-violations.json` | Stage 3: 完整违反结果 |
| `.matrix/data/singlevar-dropped-candidates.json` | 跨函数松弛丢弃的候选（供 LLM 抽样复审） |
| `.matrix/reports/singlevar-atomicity.md` | 综合报告 |

所有 defect 通过 `append_defects` 工具（source=`single_var_atomicity`，前缀 `DEF-SVA-NNN`）写入 `.matrix/data/defects.json`。

---

## 10. 误报规避

1. **只读共享变量**：local1 与 local2 都是 READ 且 ISR 也只 READ → 不构成违反（仅 RWR 模式可能误判，看 ISR 是否真有 WRITE）
2. **单次初始化 + 读**：变量在中断使能前赋值一次后只读 → INFEASIBLE
3. **CAS / atomic 内建函数包裹**：`__atomic_*` 系列、`stdatomic.h` → 视为已保护
4. **MMIO write-clear 寄存器**：写 1 清 0 的硬件语义不构成软件原子性违反
5. **路径互斥**（§Stage 2）
6. **初始化阶段**（§6）

---

## 11. 与 multivar-atomicity-checker 的区别

| 维度 | multivar-atomicity-checker（多变量） | singlevar-atomicity-checker（本工具） |
|------|--------------------------|--------------------------------------|
| 变量数 | ≥2 个关联变量 | 1 个变量 |
| 访问数 | 4 次（low-W/R, ISR-W/R 各 2） | 3 次（low + ISR + low） |
| 锚点 | DFC / TUP / DAC | 无锚点概念（intAtom 论文范式） |
| 模式数 | 5（DFC_RWWR/TUP_*/DAC_*） | 5（RWR/RWW/WRW/WWR/WWW） |
| LLM 用途 | 关联性判定（DFC/TUP/DAC）+ 严重度 | 原子意图判定 + Z3 兜底 |
| 工具链 | Joern + Z3 | Joern + Z3（共享基座） |

两个 agent **正交**，由用户根据需要分别调用，或在 conductor 中并行调度。
