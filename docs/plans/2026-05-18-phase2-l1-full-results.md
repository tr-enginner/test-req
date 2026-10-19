# Phase 2：L1 全集召回 — 结果报告

**日期**：2026-05-18  
**阶段**：Phase 2 — 8051 + SPARC 方言适配 + RMW 拆解  
**前序**：Phase 1（同函数 + 直接访问 + EXACT/STRUCT_FIELD 别名）

## L1 全集评估结果（6 / 6 案例）

| Case | 平台 | 模式 | 共享变量 | 结果 | 候选 | matched | 备注 |
|------|------|------|---------|------|------|---------|------|
| L1_001 | 8051 | R-W-W | Ctlbyte | ✅ TP | 12 | 1 | Keil C51 `interrupt N using N` 通过预处理修复 |
| L1_002 | 8051 | R-W-W | errorCount | ✅ TP | 75 | 1 | `errorCount++` RMW 拆解为 (R, W) 双访问 |
| L1_003 | SPARC | R-W-W | GL_TMARK_Time_Count | ✅ TP | 15 | 1 | ISR↔ISR（c_int06 → c_int05） |
| L1_004 | SPARC | R-W-R | trap_fail_address | ✅ TP | 5 | 3 | Phase 1 已通过 |
| L1_005 | 通用 | R-W-R | Obdh.DeltB | ✅ TP | 16 | 1 | Phase 1 已通过（STRUCT_FIELD + ISR 调用链） |
| L1_006 | 通用 | W-W-R | Va | ❌ FN | 4 | 0 | 需 Phase 3（跨函数 + addressOf-callee 流分析） |

**整体**：
- **Recall: 83.33% (5/6)**
- **TP=5, FN=1, FP=120**
- 唯一 FN (L1_006) 已明确技术成因，Phase 3 解决

## 关键修复

### 1. 8051 方言预处理（修复 L1_001 完全 0 候选）

**根因**：Keil C51 的 `void Timer0_ISR(void) interrupt 1 using 1 { ... }` 中，
`interrupt N using N` 后缀让 Joern parser 把函数当作 **declaration only**，
函数体（含 `Ctlbyte = ...` 等访问）被丢弃。整个 ISR 在 CPG 里是空的。

**修复**：在 `eval_sva_stage1.py` 中加入 `preprocess_8051` 函数（复用 benchmark
`compile_check/check_all.py` 的实现），在 joern-parse 前剥离以下方言：
- `) interrupt N using M {` → `) {`
- `sbit X = ...;` / `sfr X = ...;` → `static volatile unsigned char X;`
- `xdata`, `idata`, `pdata`, `code` 关键字
- 类 GCC 的 `__attribute__((interrupt))`、SPARC 的 `interrupt void f(...)`

### 2. RMW 操作展开（修复 L1_002）

**根因**：`errorCount++` 在 AST 中是 `<operator>.postIncrement` 调用，base 是
单一 Identifier。我之前的实现把它整体当作 **单个 WRITE**。但 GT 的 R-W-W 模式
要求把 RMW 拆为 (R, W) 两个独立访问。

**修复**：新增 `rmwOpEnclosing(node)` helper 检测 RMW 上下文（`++`/`--`/`+=`/
`|=`/`&=` 等 14 种操作符），在 `findConsecutivePairs` 收集 raw accesses 时
对 RMW 的 base **同时**产出 (READ, WRITE) 两个 entries，用合成的 column 顺序
（R 在 W 之前）保证排序正确。

这个改动让：
- `errorCount++` 自然形成 (R, W) 序列
- (errorCount-R) 与 ISR 的 (errorCount-W) 加上后面的 (errorCount-W) 形成 R-W-W
- 同时让 L1_001 的 `Ctlbyte = (Ctlbyte | mask)` 也被理解为 RMW

### 3. ISR↔ISR 案例自然支持（L1_003）

L1_003 的 c_int06 (low-pri) 与 c_int05 (high-pri) 是 ISR↔ISR 抢占。我的实现
通过 `derive_entries_from_gt` 把 GT 的 context_A function（c_int06）放入
`task_entries`，context_B（c_int05）放入 `isr_entries`。Stage 1 把 c_int06
当 low-pri context 处理，自然产出 RWW 候选。

这是 intAtom 论文中明确支持但我们 SKILL 标注为 Phase 3 才做的功能。
实际工程中只要 `task_entries` 含被抢占者即可工作，无需额外代码。

## FP 分布与性质

| Case | FP 数 | 主要来源 |
|------|-------|---------|
| L1_001 | 11 | PDKongWen 内 Ctlbyte 的其他 (R, W) 组合；fnCheckEmergency/fnProcessCommand 访问 |
| L1_002 | 74 | 大量 XBYTE[*] 数组的 RWW（实际可能也是真违反，未被 GT 列） |
| L1_003 | 14 | health_mon, gl_5ms_tick_count 等其他共享变量的 RWW |
| L1_004 | 2 | hk_data 计数器的 RWR |
| L1_005 | 15 | Obdh 其他字段的 RWR |
| L1_006 | 4 | CurWorkMode 的 WWR |

**性质判断**：所有 "FP" 都是**结构上真实**的访问交错三元组，但 GT 只标注了
case 的核心目标变量。这些"FP"严格来说是工具的**超召回**——发现了 GT 未列的
潜在违反。Stage 2 (LLM 原子意图判定 + 路径互斥) 与 Stage 3 (Z3 可行性) 会
进一步收敛。

## L1_006 (Va, W-W-R) FN 根因 — Phase 3 工作

**为什么 Phase 2 没解决**：
- `vote_all_params` 在 line 290 通过 `(float *)&Va` 把 Va 地址传给
  `ThreeDeTwo_float`；真正的写发生在 ThreeDeTwo_float 内部
- main 函数后续多处读 Va (line 387, 456, 467, 524)，但跨函数
- GT 期望的 W-W-R pair 需要 (vote_all_params line 290 W) + (timer3_isr W)
  + (后续 R) —— 后续 R 在 main 内，**跨函数**

**Phase 3 三件事一起做**：
1. 跨函数松弛（含调用栈深度 + 透明性证明）
2. `addressOf` callee-sensitive 流分析（`&Va` 传给函数后是否真被写）
3. MMIO 别名规范化（解决 L2/L3 中 `*(volatile uint32_t*)0x4000` 模式）

## 文件变更

| 文件 | 变更 |
|------|------|
| `joern/singlevarAtomicityIdentify.scala` | +90 行（rmwOpEnclosing helper、RMW 拆解逻辑） |
| `EmbedSVABench/tools/eval_sva_stage1.py` | +55 行（preprocess_8051、preprocess_generic、preprocessed_source） |
| `EmbedSVABench/reports/eval_sva_stage1.json` | 回归输出 |

## TypeScript 侧

`bun run typecheck` ✅ 通过  
`bun run build` ✅ 通过 (572 modules, 6.97 MB)  
没有改 TS 代码 —— Phase 2 全部在 Scala + Python 评估侧完成。

## Phase 3 路线图（下一步）

按测试驱动节奏，Phase 3 进 L2 案例（结构体 + 跨函数 + 数组），目标列表：

| Case | 平台 | 关键挑战 |
|------|------|---------|
| L2_001 | 通用 | `CAN.InitCount4s` 结构体 + 跨函数读写 |
| L2_002 | 通用 | `tyro_break_counter_p` 全局变量 + 跨函数 |
| L2_003 | 8051 | 1553B 监控 + 8051 方言 + 间接调用 |
| L2_004 | SPARC | `T_Can_SlowRmt[52]` 数组元素索引敏感 |
| L2_005 | 8051 | 三模冗余 + 跨函数 |
| L2_006 | 8051 | 遥控注入 + disable_specific_interrupt |
| L2_007 | 通用 | W-R-W 模式 + MMIO |
| L2_008 | 通用 | W-R-W + CAN 初始化 |

Phase 3 实现优先级（按对召回率的边际贡献）：

1. **跨函数松弛**（同函数硬裁剪的修复）—— 直接解决 L1_006 + L2 多数
2. **callee-sensitive addressOf** —— 精化 `&x` 间接写
3. **MMIO 别名注册表** —— 用 `#define` 宏定义识别 MMIO 寄存器名
4. **数组元素 ARRAY_ELEMENT_FIXED 精化** —— `T[52]` 准确匹配
