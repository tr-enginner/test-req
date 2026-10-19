# 多变量原子性违反检测——深度技术文档

> 文档版本：2026-03-12 | 适用范围：multivar-atomicity-checker 智能体全链路逐函数级别分析

---

## 目录

1. [概述与设计哲学](#1-概述与设计哲学)
2. [系统架构总览](#2-系统架构总览)
3. [三种锚点类型](#3-三种锚点类型)
4. [五种违反模式](#4-五种违反模式)
5. [Agent 六步骤工作流](#5-agent-六步骤工作流)
6. [CPG 构建工具](#6-cpg-构建工具)
7. [Tool A：关联变量识别](#7-tool-a关联变量识别)
   - [7.1 Joern Scala 脚本：数据流分析](#71-joern-scala-脚本数据流分析)
   - [7.2 TypeScript 层：访问列表解析](#72-typescript-层访问列表解析)
   - [7.3 锚点类型确定逻辑](#73-锚点类型确定逻辑)
   - [7.4 证据评分体系](#74-证据评分体系)
   - [7.5 工具层过滤与 DAC 角色分配](#75-工具层过滤与-dac-角色分配)
   - [7.6 结构化输出](#76-结构化输出)
8. [Step 3.5：LLM 语义评估](#8-step-35llm-语义评估)
9. [Tool B：违反模式检测](#9-tool-b违反模式检测)
   - [9.1 CPG 访问点查询](#91-cpg-访问点查询)
   - [9.2 抢占关系建模](#92-抢占关系建模)
   - [9.3 五种模式的匹配逻辑](#93-五种模式的匹配逻辑)
   - [9.4 连续性约束与去重](#94-连续性约束与去重)
   - [9.5 Cross-Block 修复](#95-cross-block-修复)
10. [Tool C：可行性验证](#10-tool-c可行性验证)
    - [10.1 三子路径分解](#101-三子路径分解)
    - [10.2 Phase 0：初始化阶段排除](#102-phase-0初始化阶段排除)
    - [10.3 Phase 1：Joern CFG 路径分析](#103-phase-1joern-cfg-路径分析)
    - [10.4 中断使能流敏感分析](#104-中断使能流敏感分析)
    - [10.5 Phase 2：Z3 SMT 约束求解](#105-phase-2z3-smt-约束求解)
    - [10.6 结果判定与严重度映射](#106-结果判定与严重度映射)
11. [数据流与产物文件](#11-数据流与产物文件)
12. [评分参数总表](#12-评分参数总表)
13. [关键设计决策与误报防控](#13-关键设计决策与误报防控)

---

## 1. 概述与设计哲学

多变量原子性违反检测系统检测嵌入式软件中**语义关联的共享变量**在非原子操作序列中被中断抢占导致的状态不一致问题。

核心设计原则：

| 原则 | 说明 |
|------|------|
| **关联性先行** | 先识别哪些变量语义关联（DFC/TUP/DAC），再检测违反模式 |
| **工具驱动** | Joern CPG 数据流分析 + Z3 SMT 数学证明，非纯启发式 |
| **分层过滤** | 工具层结构评分 → Agent LLM 语义评估 → 最终置信度过滤，三道防线控制误报 |
| **按需 LLM** | 触发规则控制 LLM 调用：高分直通、灰区评估、低分丢弃，节约 ~94% 调用量 |
| **递进验证** | Phase 0（init-phase）→ Phase 1（CFG 路径）→ Phase 2（Z3 SMT），每阶段仅处理上一阶段残余 |

**外部依赖**：

| 工具 | 用途 | 配置 |
|------|------|------|
| **Joern** | CPG 构建 + 数据流分析 + CFG 路径查询 | `matrix.jsonc` → `joern_home` 或 `JOERN_HOME` 环境变量 |
| **Z3 SMT** | 约束求解（可行性验证） | `matrix.jsonc` → `z3_home` 或 `Z3_HOME` 环境变量 |
| **LLM（Claude）** | 语义评估 | Agent 自身 LLM 上下文（Step 3.5） |

---

## 2. 系统架构总览

```
                       multivar-atomicity-checker Agent
                     (temperature=0.2, subagent mode)
                              │
          ┌───────────────────┼───────────────────────┐
          │                   │                       │
    ┌─────▼─────┐     ┌──────▼──────┐        ┌──────▼──────┐
    │  Step 1-2  │     │   Step 3    │        │  Step 4-5   │
    │ 上下文+CPG │     │ 关联变量识别│        │ 模式+验证   │
    └─────┬─────┘     └──────┬──────┘        └──────┬──────┘
          │                  │                       │
    ┌─────▼─────┐     ┌──────▼──────┐        ┌──────▼──────┐
    │ CPG 构建   │     │   Tool A    │        │ Tool B + C  │
    │joern-parse │     │Joern+评分   │        │模式匹配+Z3  │
    └───────────┘     └──────┬──────┘        └─────────────┘
                             │
                      ┌──────▼──────┐
                      │  Step 3.5   │
                      │  Agent LLM  │
                      │ STRONG/WEAK │
                      │ /NONE 判定  │
                      └─────────────┘
```

**数据流**：

```
源码 → joern-parse → CPG (.bin)
                       │
                       ▼
              Joern Scala 脚本
              (数据流分析 + 锚点标注)
                       │
                       ▼
              Tool A TypeScript
              (解析 + 评分 + 过滤)
                       │
                       ▼
            multivar-correlated-groups.json
                       │
                       ▼
              Agent Step 3.5
              (LLM 离散判定 + 融合)
                       │
                       ▼
            multivar-correlated-groups.json (覆写)
                       │
                       ▼
              Tool B (5种模式匹配)
                       │
                       ▼
           multivar-candidates.json
                       │
                       ▼
              Tool C (Phase 0/1/2)
                       │
                       ▼
           multivar-violations.json
```

---

## 3. 三种锚点类型

### DFC（数据流汇聚型, Data Flow Convergence）

多个共享变量参与同一计算表达式（算术、比较、函数调用参数）。

**约束**：必须在**同一函数**内。跨函数数据流汇聚大概率不存在原子性需求。Tool A 自动将跨函数 DFC 组分裂为子组并独立重新分类。

**Joern 标签**：`sink`（AccessList 的 Source 字段）

```c
// 两变量在比较表达式中汇聚
if (sensor_value > threshold) { trigger_alarm(); }
// 两变量在赋值表达式中汇聚
time = timeS * 60 + timeMs;
```

### TUP（事务更新型, Transaction Update）

同一结构体的多个成员、数组元素或相邻地址被连续写入，构成逻辑事务。

**约束**：必须在**同一控制块**内。跨控制块直接丢弃（无事务语义）。

**Joern 标签**：`update`

```c
Time.S = new_seconds;    // 事务的一部分
Time.MS = new_millis;    // 事务的另一部分
// ISR 在此间抢占 → 读到 (new_seconds, old_millis)
```

### DAC（决策-行为型, Decision-Action Consistency）

控制条件读取变量 A 做决策，支配区域访问变量 B 执行行为。

**Joern 标签**：`dac`

```c
if (data_ready) {           // 决策：读 flag
    process(rx_buffer);      // 行为：使用 data
}
// ISR 可能在判断后、使用前修改 data_ready 和 rx_buffer
```

**锚点类型确定优先级**：Joern Source 标签 > TypeScript 读写模式启发式推断。当 Joern 无标签时回退到启发式。

---

## 4. 五种违反模式

命名格式：`<锚点>_<低1><高1><高2><低2>`，R=Read, W=Write，按时序排列。

### DFC_RWWR

```
低优先级: Read(A) ──────────────────── Read(B)
高优先级:           Write(A), Write(B)
```
低优先级先读 A 后读 B，ISR 在中间写入 A 和 B → 读到 新A + 旧B。

### TUP_WRRW

```
低优先级: Write(A) ──────────────────── Write(B)
高优先级:            Read(A), Read(B)
```
低优先级先写 A 后写 B，ISR 在中间读取 → 读到 新A + 旧B。

### TUP_WWWW

```
低优先级: Write(A) ──────────────────── Write(B)
高优先级:            Write(A), Write(B)
```
两个上下文都在更新 A、B → 最终状态不一致。

### DAC_RWWW

```
低优先级: Read(decision) ──────────────── Write(action)
高优先级:                  Write(dec), Write(act)
```
决策失效：基于旧决策执行写入行为。

### DAC_RWWR

```
低优先级: Read(decision) ──────────────── Read(action)
高优先级:                  Write(dec), Write(act)
```
决策失效：基于旧决策执行读取行为。典型场景：`if(flag){ use(buf); }`

### 约束

- **连续性约束**：ISR 侧两次访问必须连续——中间无同组其他变量的访问
- **ISR↔ISR 交错**：仅当提供 `interrupt_priorities` 且优先级不同时检测；默认同级不可嵌套（ARM Cortex-M NVIC 模型）
- **锚点→模式映射**：DFC→DFC_RWWR；TUP→TUP_WRRW + TUP_WWWW；DAC→DAC_RWWW + DAC_RWWR

---

## 5. Agent 六步骤工作流

**文件**：`src/agents/multivar-atomicity-checker.ts`（mode=subagent, temperature=0.2, cost=EXPENSIVE）

### Step 0：归档与清理

归档旧产物到 `.matrix/archive/atomicity/{timestamp}/`，删除以下文件：
- `multivar-anchors.json`, `correlatedVars.json`, `correlatedVars_llm.json`
- `multivar-correlated-groups.json`, `correlated-groups-refined.json`
- `multivar-candidates.json`, `multivar-violations.json`, `multivar-confirmed.json`
- 对应的 `.matrix/reports/*.md` 文件

**CPG 二进制不删除**（源码未变时可复用）。

### Step 1：加载上下文

1. 读取 `compilation-env.json`（compiler_dialect, target_cpu, source_dirs）
2. 读取 `software-analysis.json`（函数列表、ISR/Task 入口）
3. 读取 `wiki/index.json`（如果存在，获取函数语义摘要）
4. **ISR 完整性验证**：grep 源码中的 ISR 声明模式，补全 `isr_entries`

### Step 2：构建 CPG

调用 `multivar_cpg_create`，封装 `joern-parse`，5 分钟超时，输出 `.matrix/data/<project>.bin`。

### Step 3：关联变量识别

调用 `multivar_correlated_vars`（Tool A），详见 [§7](#7-tool-a关联变量识别)。

### Step 3.5：LLM 语义评估

**HARD-GATE**，详见 [§8](#8-step-35llm-语义评估)。

### Step 4：违反模式检测

调用 `multivar_violation_detect`（Tool B），详见 [§9](#9-tool-b违反模式检测)。

**Pre-Flight 检查**：调用前验证所有 DAC 组都有 `llm_score`。缺失则停止并要求完成 Step 3.5。

### Step 5：可行性验证

- **Step 5.1**：Agent 分析 `main()` 调用链，确定 init-phase 函数
- **Step 5.2**：调用 `multivar_feasibility_verify`（Tool C），详见 [§10](#10-tool-c可行性验证)

### Step 6：生成报告

输出 `.matrix/reports/multivar-violation.md`，5 章节结构：

1. **分析环境**：CPU、字长、编译器、ISR 数量、共享变量数、保护原语
2. **结果统计**：关联组统计（按锚点类型）+ 违反统计（按模式 + 验证结果）
3. **关联变量分析详情**：按置信度降序，最多 100 个，含证据分解
4. **原子性违反候选分布详情**：按模式汇总数量和验证结果
5. **原子性违反结果详情**：按严重度排序，最多 30 个（排除 INFEASIBLE），含 4 次访问序列表、代码片段、保护建议

---

## 6. CPG 构建工具

**文件**：`src/tools/multivar-cpg-create.ts`（115 行）

封装 `joern-parse` 二进制，将 C/C++ 源码解析为 Joern Code Property Graph。

| 参数 | 说明 |
|------|------|
| `source_dir` | 源码目录 |
| `project_name` | 项目名（用于输出文件名） |
| `output_path` | CPG 输出路径（默认 `.matrix/data/<project>.bin`） |

- 超时：5 分钟（300,000ms）
- 缓冲区：50 MB
- Windows 使用 `.bat` 包装脚本

---

## 7. Tool A：关联变量识别

**文件**：`src/tools/multivar-correlated-vars.ts`（1,311 行）

### 7.1 Joern Scala 脚本：数据流分析

**文件**：`joern/multivarCorrelatedVarsIdentify.scala`

脚本在 CPG 上执行以下分析：

1. **全局变量识别**：扫描 CPG 全局 namespace 中的变量声明
2. **共享变量筛选**：过滤出被多个入口函数（Task + ISR）可达的变量
3. **AccessList 生成**：对每个共享变量在每个可达函数中生成访问列表
4. **Source 标注**：标记每个 AccessList 的来源维度（`sink`/`update`/`dac`）
5. **统计输出**：`global_var`, `shared_var`, `saa`, `dfc_tup`, `sink`, `update`, `dac`, `pairs` 等

**已知修复**（2026-03-05）：
- callerCache 预计算（Fix-1）
- BFS maxIterations 500→2000 + `hit_search_limit` 字段（Fix-2）
- preIncrement/preDecrement WRITE 识别（Fix-3）
- BFS 父指针存储 O(n)（Fix-4）
- combine 截断 MAX_COMBINE=500（Fix-8）
- removeDuplicate O(n)（Fix-9）
- isConstant 预计算（Fix-10）

### 7.2 TypeScript 层：访问列表解析

函数 `parseJoernAccessLists()`（~100 行）将 Joern JSON 输出解析为 `CVGroup[]`：

1. 解析每个 AccessList 的变量名、访问类型、位置信息
2. 读取 Source 标签确定初始锚点类型
3. 规范化变量名（去除数组索引、指针前缀等）
4. 构建 CVGroup 结构

### 7.3 锚点类型确定逻辑

**优先级**：Joern Source 标签 > TypeScript 启发式推断

| Joern Source | → 锚点类型 |
|-------------|-----------|
| `sink` | DFC |
| `update` | TUP |
| `dac` | DAC |
| 无标签 | 回退到 `inferAnchorType()` |

`inferAnchorType()` 逻辑：
- 全部 READ + READ → DFC（同函数内数据流汇聚）
- 全部 WRITE + 同结构体/数组基 → TUP（事务写入）
- 存在 READ/WRITE 分离 → DAC（决策-行为）
- 默认 → DFC

**DFC 跨函数处理**：跨函数的 DFC 组自动分裂为子组（ID 如 `cg_XXXX_0`, `cg_XXXX_1`），每个子组独立重新分类。

**TUP 跨函数处理**：直接丢弃（跨函数事务更新无原子性语义）。

### 7.4 证据评分体系

评分在 `refineEvidence()` 中按锚点类型调用对应函数：

#### DFC 评分（`computeDataflowScore`）

| 维度 | 得分 | 说明 |
|------|------|------|
| `aq` | 0.45 | 锚点匹配质量（降级模式，Phase 2 按 sink 子类型细分 0.35–0.50） |
| `struct_cohesion` | 0 或 0.12 | 同一结构体字段或同一数组基 |
| `multi_site` | 0 或 0.10 | 同一变量集合在 ≥2 个独立代码位置出现 |
| `naming_affinity` | 0 或 0.08 | H/L 后缀配对、共前缀、或配对命名模式 |
| `llm_contribution` | 0~0.15 | Agent Step 3.5 离散判定 L × 0.15（STRONG→0.15, WEAK→0.075） |
| **工具层上限** | **~0.75** | **加上 LLM 满分 0.90** |

#### TUP 评分（`computeTransactionalScore`）

| 维度 | 得分 | 说明 |
|------|------|------|
| `aq` | 0.33 或 0.38 | gap ≤ 1 → 0.38（严格相邻），gap > 1 → 0.33（窗口内） |
| `struct_cohesion` | 0 或 0.12 | 同一结构体字段或同一数组基 |
| `multi_site` | 0 或 0.10 | 同一变量集合在 ≥2 个独立代码位置出现 |
| `naming_affinity` | 0 或 0.08 | H/L 后缀配对、共前缀、或配对命名模式 |
| `llm_contribution` | 0~0.15 | Agent Step 3.5 离散判定 L × 0.15（STRONG→0.15, WEAK→0.075） |
| **工具层上限** | **~0.68** | **加上 LLM 满分 0.83** |

> TUP 无正交证据时 0.33–0.38 < 0.55，必须有 OE 或 LLM STRONG 才能通过最终过滤。

#### DAC 评分（`computeDacScore`）

| 维度 | 得分 | 说明 |
|------|------|------|
| `aq` | 0.20 | 降级模式（Phase 2 按控制结构细分：if 0.22、switch 0.18、嵌套 0.15） |
| `struct_cohesion` | 0 或 0.12 | 同一结构体字段或同一数组基 |
| `multi_site` | 0 或 0.10 | 同一变量集合在 ≥2 个独立代码位置出现 |
| `naming_affinity` | 0~0.08 | H/L 后缀、共前缀、或 flag+data 命名模式（双边=0.08，单边=0.05） |
| `llm_contribution` | 0~0.40 | Agent Step 3.5 离散判定 L × 0.40（STRONG→0.40, WEAK→0.20）（**主要权重**） |
| **工具层上限** | **~0.50** | **加上 LLM 满分 0.90** |

**Flag/Data 命名模式**：

```typescript
FLAG_PATTERN = /(flag|status|state|ready|valid|done|busy|enable|disable|active|pending|lock|mode|phase)/i
DATA_PATTERN = /(data|buf|buffer|val|value|result|output|payload|msg|message|packet|frame|sample|reading)/i
```

#### 共同前缀提取（`extractCommonPrefix`）

从变量名提取共同前缀（如 `g_chg_state` + `g_chg_mode` → `g_chg_`）。规则：
- 去除 `g_` 等全局前缀后匹配
- 前缀长度 ≥ 3 字符
- 前缀须以分隔符（`_`, `.`）结尾
- 排除单字母 + 下划线的无意义前缀

#### 多点共现计算（`computeMultiSiteCounts`）

按排序后的变量集合键分组，计算每组在多少个独立代码位置出现：
- 不同函数 = 不同位置
- 同函数但行间距 >20 = 不同位置
- count ≥ 2 → +0.10 `multi_site` 加分

### 7.5 工具层过滤与 DAC 角色分配

**工具层差异化过滤**（`refineEvidence` 函数）：

| 锚点 | 阈值 | 说明 |
|------|------|------|
| DFC | ≥ 0.40 | AQ=0.45 默认通过 |
| TUP | ≥ 0.35 | AQ=0.33–0.38，无 OE 的松散写操作可能淘汰 |
| DAC | ≥ 0.20 | 低门槛，让所有 DAC 组进入 LLM 评估 |

**DAC 角色分配**（`assignDacRoles` 函数，~120 行）：

确定每个访问的 DECISION（条件变量）vs ACTION（行为变量）角色：

1. **首选**：读写集合区分（只读变量=DECISION，含写变量=ACTION）
2. **全读回退**（Joern 将 body 访问报告为 READ 时）：
   - 尝试 anchor_location 行号区分（条件行=DECISION，body 行=ACTION）
   - 回退到最小行号启发式（最早的访问=DECISION）
   - 回退到 FLAG/DATA 命名模式

### 7.6 结构化输出

Tool A 在写入 `multivar-correlated-groups.json` 的同时，生成以下结构化输出：

- **`multivar-anchors.json`**（Step 1 输出）：锚点识别结果
  - 每个锚点包含：id, anchor_type, function, file, variables, 类型特定字段
  - 统计：total, by_type (DFC/TUP/DAC), shared_vars_count

- **`correlatedVars.json`**（Step 2 输出）：关联变量对 + 状态
  - 每对包含：id, anchor_id, anchor_type, variables, confidence, evidence, status
  - status 取值：`PASS`（≥0.55）、`GRAY`（灰区）、`FILTERED`（低于灰区下限）

- **`dac_anchors`**（嵌入 multivar-correlated-groups.json）：DAC 锚点批量评估辅助结构
  - 将共享同一条件表达式位置的 DAC 组归并
  - 每个锚点包含：anchor_id, condition_location, decision_vars, action_vars, group_ids

---

## 8. Step 3.5：LLM 语义评估

### 为什么必须执行

- 工具层评分仅基于结构启发式（变量名、代码距离），无法判断语义相关性
- DAC 组工具层基础分仅 0.20，纯结构最高 ~0.50，几乎全依赖 LLM 判定
- 跳过此步会将大量低质量候选传递给 Z3，浪费计算并产生大量误报

### 离散三级判定

| 判定 | L 值 | 含义 | 典型场景 |
|------|------|------|---------|
| **STRONG** | 1.0 | 明确的一致性契约，必须原子更新 | flag→data 生产者-消费者契约 |
| **WEAK** | 0.5 | 可能相关但不确定 | 同一 if 块中更新，但是否需要同步不清楚 |
| **NONE** | 0.0 | 无语义关联，巧合的结构共现 | 两个无关计数器恰好相邻递增 |

### 触发规则

| 锚点 | 直接通过（不调 LLM） | 灰区（调 LLM） | 直接丢弃 |
|------|---------------------|---------------|---------|
| DFC | S ≥ 0.55 | 0.40 ≤ S < 0.55 | S < 0.40 |
| TUP | S ≥ 0.55 | 0.35 ≤ S < 0.55 | S < 0.35 |
| DAC | 无（始终评估） | S ≥ 0.20 | S < 0.20 |

- **直接通过**：设 `llm_status = "SKIPPED_PASS"`，保留 `llm_score = 0`
- **直接丢弃**：设 `llm_status = "SKIPPED_FILTERED"`，移除
- **灰区/DAC**：进入 LLM 评估

### DFC/TUP 灰区评估

1. 按文件批量读源码（每文件读一次，覆盖所有相关行）
2. 每批 5–10 组，判定 STRONG/WEAK/NONE
3. 写入 `evidence.llm_score`，记录 `llm_judgment` 和 `llm_reason`

### DAC 锚点批量评估

1. 从 `dac_anchors` 找同一条件表达式的所有变量对
2. 每个锚点读码一次（~30 行上下文）
3. **逐对独立判定**：同一 if 条件的 flag 可能只守护特定变量
   ```
   示例：if (data_ready) { ... }
   - (data_ready, rx_buffer)  → STRONG, L=1.0 (flag 直接守护 buffer)
   - (data_ready, debug_counter) → NONE, L=0.0 (计数器与 flag 无关)
   ```

### 融合公式和最终过滤

```
confidence_final = S + L × λ(type)

λ:
  DFC → 0.15
  TUP → 0.15
  DAC → 0.40

最终过滤阈值：confidence ≥ 0.55
```

**DAC 通过所需最低判定**：

| DAC 工具层得分 | 对应情形 | STRONG (L=1.0) | WEAK (L=0.5) |
|---------------|---------|---------------|-------------|
| 0.20（仅 AQ） | 无任何正交证据 | 0.60 ✓ | 0.40 ✗ |
| 0.28（+naming） | 配对命名模式 | 0.68 ✓ | 0.48 ✗ |
| 0.32（+struct） | 共享结构体 | 0.72 ✓ | 0.52 ✗ |
| 0.40（+struct+naming） | 多维正交 | 0.80 ✓ | 0.60 ✓ |
| 0.50（+所有 OE） | 最强结构信号 | 0.90 ✓ | 0.70 ✓ |

### 大体量策略

- **DFC/TUP**：始终全量评估灰区（S ≥ 0.55 已直通，灰区通常 <30 个）
- **DAC 锚点**：
  - ≤ 80 个：全量评估
  - 81–200 个：评估前 80 个（按最高 confidence 降序）
  - 201–500 个：评估前 60 个，若通过率 ≥ 10 组则追加 20 个
  - > 500 个：评估前 40 个，按通过率 >25% 逐批追加（每批 20，最多 3 批）
  - 未评估锚点的 `llm_score` 设为 0.0，由 0.55 阈值自动淘汰

### 输出

- **`correlated-groups-refined.json`**：含 `confidence_tool_layer` 和 `confidence`（最终值）
- **`correlatedVars_llm.json`**：每对追加 `llm_status`, `llm_judgment`, `llm_reason`, `confidence_structural`, `confidence_final`
- **覆写 `multivar-correlated-groups.json`**：供 Tool B/C 读取（向后兼容）

---

## 9. Tool B：违反模式检测

**文件**：`src/tools/multivar-violation-detect.ts`（1,263 行）

### 9.1 CPG 访问点查询

函数 `queryAccessesFromCpg()` 通过 Joern 脚本查询所有关联变量在 CPG 中的全局访问点：

1. 收集所有通过过滤的关联组的变量名集合
2. 生成 Joern 包装脚本，调用 `queryVariableAccesses(varNames, entryFunctions)`
3. 执行 Joern，解析 JSON 格式的访问列表
4. **智能变量名匹配**：常数索引（`arr[0]`）和变量索引（`arr[i]`）→ 提取基名匹配

### 9.2 抢占关系建模

函数 `canPreempt(contextA, contextB, priorities)`：

| 场景 | 判定 | 说明 |
|------|------|------|
| ISR vs 主任务 | 始终可抢占 | ISR 优先级高于所有非中断代码 |
| 高优先级 ISR vs 低优先级 ISR | 可抢占 | 需要显式 `interrupt_priorities` |
| 同优先级 ISR vs 同优先级 ISR | **不可**抢占 | ARM Cortex-M NVIC 默认行为 |

**关键默认**：无 `interrupt_priorities` 时，所有 ISR↔ISR 抢占禁用，避免 N×(N-1) 虚假候选。

### 9.3 五种模式的匹配逻辑

每种模式有独立的匹配函数：

1. **`matchDfcRW`**（DFC_RWWR）：低优先级 R(A)+R(B) vs ISR 连续 W(A)+W(B)
2. **`matchTupWR`**（TUP_WRRW）：低优先级 W(A)+W(B) vs ISR 连续 R(A)+R(B)
3. **`matchTupWW`**（TUP_WWWW）：低优先级 W(A)+W(B) vs ISR 连续 W(A)+W(B)
4. **`matchDacRWWW`**（DAC_RWWW）：低优先级 R(dec)+W(act) vs ISR 连续 W(dec)+W(act)
5. **`matchDacRWWR`**（DAC_RWWR）：低优先级 R(dec)+R(act) vs ISR 连续 W(dec)+W(act)

**模式分发**：
```
DFC  → DFC_RWWR
TUP  → TUP_WRRW + TUP_WWWW
DAC  → DAC_RWWW + DAC_RWWR
```

### 9.4 连续性约束与去重

**连续性约束**（`getConsecutiveAccessPairs`）：

ISR 侧的两次访问（如 W(A), W(B)）必须在源码行序中连续——它们之间不存在同组其他变量的访问。这避免了将 ISR 代码不同位置的分散访问拼凑为虚假模式。

- 同行访问：接受两种排序（无法确定先后）
- 不相邻：跳过

**去重**：违反键 = pattern + 4 个访问位置的行号。仅行号完全相同的候选视为重复。

### 9.5 Cross-Block 修复

**问题**：CPG 全局查询返回变量在**所有**代码位置的访问。当同一变量对出现在多个位置（如 L281 和 L303），全局查询混合了不同位置的访问，产生虚假模式。

**修复策略**：
- **低优先级侧**：使用组自身的 `accesses`（来自 Tool A，已定位到具体代码位置）
- **ISR 侧**：使用 CPG 全局查询结果（ISR 中的访问不在 Tool A 的组内）
- 效果：低优先级访问锚定到组的源位置，ISR 访问从全局 CPG 获取，避免跨位置混淆

**共享辅助函数处理**：如果 `entry_function` 不在 Task/ISR 列表中（如辅助函数），则将其访问复制到**所有**上下文（保守近似，避免遗漏）。

### 9.6 Pre-Flight 检查（Step 3.5 强制执行）

Tool B 在执行模式匹配前检查所有 DAC 组是否有 `evidence.llm_score`。缺失则返回错误，强制 Agent 先完成 Step 3.5。

此检查在 confidence 过滤**之前**执行——否则低置信度 DAC 组会被提前移除，掩盖 llm_score 缺失。

---

## 10. Tool C：可行性验证

**文件**：`src/tools/multivar-feasibility-verify.ts`（1,673 行）

### 10.1 三子路径分解

每个 4 次访问的违反候选分解为 3 条子路径：

| 子路径 | 起点 | 终点 | 验证内容 |
|--------|------|------|---------|
| **SP1** | 低优先级入口 | 第一次低优先级访问 (A1) | 入口函数到第一个访问点的可达性 |
| **SP2** | 高优先级入口 | 高优先级访问 1 → 访问 2 | ISR 内两次访问的可达性 |
| **SP3** | A1 | 第二次低优先级访问 (A2) | 抢占窗口路径可达性 |

### 10.2 Phase 0：初始化阶段排除

在 Joern/Z3 验证之前，对每个候选进行零开销初始化阶段检查：

- 如果候选的**所有**低优先级侧访问均位于 `init_functions` 中 → **INFEASIBLE**
- `init_functions` 由 Agent 在 Step 5.1 通过分析 `main()` 调用序列确定
- 若 `main()` 中找不到明确的中断使能调用，不传 `init_functions`（保守默认）

**实际效果**：real2_bench 从 32 CONFIRMED → 2 CONFIRMED（30 个 CPUInitial 误报被排除）。

### 10.3 Phase 1：Joern CFG 路径分析

对每条子路径使用 Joern CPG 的 CFG 进行 BFS 可达性搜索：

1. 起点到终点不存在 CFG 路径 → **INFEASIBLE**（无需调用 Z3）
2. 沿路径收集**分支条件**（if/while 判断条件）
3. 沿路径检测**中断使能/禁用 API 调用**

### 10.4 中断使能流敏感分析

对 SP3（抢占窗口），进行流敏感的中断状态跟踪：

1. 从 A1 出发，默认中断使能（enabled=true）
2. 沿 CFG 路径扫描中断 API 调用，更新状态
3. 到达 A2 时中断仍被禁用（存在未配对的 disable）→ **INFEASIBLE**

支持的中断 API：
- ARM：`__disable_irq` / `__enable_irq`
- 8051：`EA=0` / `EA=1`
- FreeRTOS：`taskENTER_CRITICAL` / `taskEXIT_CRITICAL`
- 自定义：通过 `critical_section_apis` 和 `interrupt_apis` 参数扩展

### 10.5 Phase 2：Z3 SMT 约束求解

对通过 Phase 0+1 的候选，编码以下约束：

1. **子路径可达约束**：3 条子路径均 CFG 可达
2. **路径条件约束**：沿路径收集的分支条件编码为布尔/整数约束
   - C 运算符 → SMT：`==` → `=`, `!=` → `distinct`, `>/</>=/<=` 直接映射
   - 复合条件拆分：`&&` 和 `||` 在深度 0 处拆分
3. **路径赋值约束**：变量赋值 → SMT 等式约束
   - **循环冲突过滤**：同行的循环初始化赋值与循环退出条件矛盾时跳过赋值
4. **围闭条件约束**：AST 祖先中的 if/while 条件
5. **短路约束**：`&&` 链中的子条件
6. **调用者侧约束**：跨过程调用链的条件传播
7. **中断使能约束**：流敏感分析结果
8. **时序约束**：抽象序数 + ISR 抢占间隙
9. **ISR 访问类型约束**：防御性断言（Tool B 已保证类型正确）

**逻辑**：`QF_LIA`（无量词线性整数算术）
**超时**：30 秒

### 10.6 结果判定与严重度映射

| Z3 结果 | 判定 | 严重度 | 说明 |
|---------|------|--------|------|
| **SAT** | CONFIRMED | critical | 经数学证明的真实违反 |
| **UNSAT** | INFEASIBLE | info | 数学证明不可行（仅记录不报告） |
| **UNKNOWN/超时** | UNKNOWN | major | 无法排除的潜在违反 |
| — | UNCHECKED | major | 未经 Z3 验证的候选（Z3 不可用时） |

**退化模式**：
- Joern 不可用 → 跳过 Phase 1，仅用 Z3 时序约束（Legacy 模式）
- Z3 不可用 → 所有违反标记为 UNKNOWN

---

## 11. 数据流与产物文件

### 文件依赖关系

```
<project>.bin (CPG)
    │
    ├──→ Tool A ──→ multivar-correlated-groups.json (工具层输出)
    │                   │
    │                   ├──→ anchor.json (Step 1 结构化)
    │                   ├──→ correlatedVars.json (Step 2 结构化)
    │                   │
    │                   ▼
    │              Agent Step 3.5 ──→ correlated-groups-refined.json
    │                   │              correlatedVars_llm.json (Step 3 结构化)
    │                   │
    │                   ▼
    │              multivar-correlated-groups.json (覆写为过滤结果)
    │                   │
    ├──→ Tool B ──→ multivar-candidates.json
    │                   │
    └──→ Tool C ──→ multivar-violations.json
                       multivar-confirmed.json

Agent Step 6 ──→ multivar-violation.md (综合报告)
```

### 各工具自动生成的 Markdown 报告

| 文件 | 产生者 | 内容 |
|------|--------|------|
| `correlated-groups.md` | Tool A | 关联变量组统计 + 详情（LLM 过滤前快照） |
| `multivar-candidates.md` | Tool B | 候选分布 + 模式统计 |
| `multivar-violations.md` | Tool C | 验证结果 + Top 30 详情 |

---

## 12. 评分参数总表

```
┌──────────────────────────────────────────────────────────────┐
│                    评分模型完整参数表                          │
│             confidence = AQ + Σ OE + L × λ                   │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─── AQ（锚点匹配质量）───────────────────────────────┐    │
│  │  DFC: 0.45 (Phase 1 统一)                            │    │
│  │  TUP: 0.38 (gap≤1) / 0.33 (gap>1)                   │    │
│  │  DAC: 0.20 (Phase 1 统一)                            │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌─── OE（正交关联证据，所有类型共享）─────────────────┐    │
│  │  struct_cohesion: +0.12                               │    │
│  │  multi_site:      +0.10                               │    │
│  │  naming_affinity:  +0.08 (DAC单边=0.05)              │    │
│  │  OE 上限 = 0.30                                       │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌─── LLM 融合 ───────────────────────────────────────┐    │
│  │  判定: STRONG=1.0, WEAK=0.5, NONE=0.0               │    │
│  │  λ_DFC = 0.15    (灰区 [0.40, 0.55) 触发)          │    │
│  │  λ_TUP = 0.15    (灰区 [0.35, 0.55) 触发)          │    │
│  │  λ_DAC = 0.40    (S ≥ 0.20 全部触发)               │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌─── 过滤阈值 ──────────────────────────────────────┐     │
│  │  工具层: DFC≥0.40, TUP≥0.35, DAC≥0.20              │     │
│  │  最终:   ≥0.55                                      │     │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌─── 评分范围汇总 ──────────────────────────────────┐     │
│  │  DFC 纯结构: [0.45, 0.75]  典型通过: ≥0.55         │     │
│  │  TUP 纯结构: [0.33, 0.68]  典型通过需 OE 或 LLM    │     │
│  │  DAC 纯结构: [0.20, 0.50]  全需 LLM STRONG         │     │
│  │                                                      │     │
│  │  DFC + LLM:  [0.45, 0.90]                           │     │
│  │  TUP + LLM:  [0.33, 0.83]                           │     │
│  │  DAC + LLM:  [0.20, 0.90]                           │     │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌─── 超时设置 ──────────────────────────────────────┐     │
│  │  CPG 构建:    5 分钟 (300,000ms)                    │     │
│  │  Joern 分析:  10 分钟 (600,000ms)                   │     │
│  │  Z3 求解:     30 秒 (30,000ms)                      │     │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## 13. 关键设计决策与误报防控

### 设计决策 1：锚点类型来源优先级

Joern 脚本输出的 Source 标签（`sink`/`update`/`dac`）为首要依据，TypeScript 启发式仅作为旧版本兼容回退。

### 设计决策 2：DFC 跨函数分裂 vs TUP 跨函数丢弃

- **DFC**：跨函数分裂为子组，独立重新分类（可能变成 DAC 或 TUP）
- **TUP**：跨函数直接丢弃（跨函数事务更新无原子性语义）

### 设计决策 3：DAC 低门槛过滤

DAC 工具层阈值仅 0.20（等于基础分），确保所有 DAC 候选进入 LLM 评估。DAC 的主要置信度来源是 LLM 语义判断，而非结构启发式。

### 设计决策 4：离散三级判定 vs 连续分数

采用 STRONG/WEAK/NONE 而非连续 0-1 分数，因为：
- LLM 在 0.3-0.7 区间的连续打分缺乏可靠校准
- 离散化简化了阈值逻辑（STRONG 能否通过 0.55 取决于 S + λ，可精确预判）
- 三级足以区分"明确关联"、"不确定"和"无关"

### 设计决策 5：按需触发规则

DFC/TUP S≥0.55 直通不调 LLM，避免对已有充分结构证据的组浪费 LLM 调用。DAC 始终评估，因为 DAC 纯结构分 <0.55。此设计节约 ~94% 的 LLM 调用量。

### 设计决策 6：ISR 侧连续性约束

ISR 的两次访问必须连续（无同组其他变量访问介入），避免将分散在 ISR 代码不同位置的访问拼凑为虚假模式。

### 设计决策 7：三阶段递进排除

Phase 0（init-phase 字符串匹配，零开销）→ Phase 1（Joern CFG 路径，快速排除）→ Phase 2（Z3 SMT 精确求解）。每层只处理上一层未排除的候选。

### 设计决策 8：初始化阶段的保守处理

init-phase 检测由 Agent 在 Step 5.1 通过源码分析确定，而非 Tool C 自动推断。原因：
- 中断使能方式因架构而异（寄存器操作 vs API 调用 vs 宏包装），自动检测不可靠
- Agent 能读取源码上下文判断初始化序列边界
- 若无法确定使能点，不传 `init_functions`（保守默认），避免漏报

### 误报防控总结

| 层级 | 机制 | 效果 |
|------|------|------|
| 工具层 | 差异化过滤（DFC≥0.40, TUP≥0.35, DAC≥0.20） | 过滤无结构支撑的松散变量组 |
| LLM 层 | 离散三级判定（STRONG/WEAK/NONE）+ 触发规则 | 过滤偶然共现、无语义关联的变量组 |
| 最终过滤 | confidence ≥ 0.55 | 统一最低质量门槛 |
| 模式层 | ISR 侧连续性约束 | 避免拼凑虚假模式 |
| 可行性层 | Phase 0 初始化阶段排除 | 排除中断使能前的初始化函数中的候选 |
| 可行性层 | Phase 1 Joern CFG 路径分析 | 快速排除不可达候选 |
| 可行性层 | 中断使能流敏感分析 | 排除临界区保护的候选 |
| 可行性层 | Phase 2 Z3 SMT 精确求解 | 数学证明级排除 |
| 报告层 | INFEASIBLE 不进入 Section 5 | 已排除的候选仅记录不报告 |
