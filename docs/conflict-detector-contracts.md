# 中断数据访问冲突检测系列 Agent 共享契约

本文件定义所有中断数据访问冲突检测 agent（含 multivar-atomicity-checker、未来的 singlevar-atomicity-checker、hw-mmio-conflict-checker、order-violation-checker）之间的**最小共享契约**。

契约的目的不是建立框架，而是**约束接口与产出格式**，保证：
- 多个 agent 可以共享同一份 CPG，避免重复构建；
- 多类冲突的违反记录能在最终报告中聚合呈现；
- LLM 语义判定的置信度数字跨 agent 可比。

> **原则**：契约只规定"必须"，不规定"如何"。具体算法、Joern 查询、Z3 编码各 agent 自由实现。

---

## 契约 1：CPG 共享与生命周期

### 1.1 文件路径

```
.matrix/data/cpg/<project>.bin              ← Joern CPG 二进制
.matrix/data/cpg/<project>.meta.json        ← 元数据
```

旧路径 `.matrix/data/<project>.bin` 视为兼容路径，新代码必须用 `cpg/<project>.bin`。

### 1.2 元数据 schema (`<project>.meta.json`)

```jsonc
{
  "project_name": "string",
  "source_hash": "string",         // SHA-256 of concatenated sorted source file contents
  "source_files_count": 42,
  "created_at": "ISO-8601 timestamp",
  "created_by": "agent_name",
  "joern_version": "string",
  "cpg_size_bytes": 12345678
}
```

### 1.3 复用规则

任何调用 `cpg_create` 的 agent 必须：
1. 计算当前源码目录的 `source_hash`（按文件路径排序，逐个 SHA-256，再总 hash）；
2. 若 `.bin` 存在且 `.meta.json.source_hash` 匹配，**直接复用，不重建**；
3. 不匹配时归档旧 `.bin` 到 `.matrix/archive/cpg/<timestamp>/`，再重建；
4. 不允许多 agent 并发写同一 CPG —— 通过 `flock` 风格的 lock 文件 `.matrix/data/cpg/<project>.lock` 保护。

### 1.4 工具职责

`cpg_create` 工具内部实现以上 4 步逻辑。**Agent 不需要也不应该自行实现 hash 检查**。

---

## 契约 2：违反记录的统一 schema

所有冲突检测 agent 写入 `.matrix/data/defects.json` 时**必须**遵循统一 schema。已有的 `Defect` schema（src/schema/defect.ts）保持不变，本契约只规定**冲突检测类**defect 在通用字段之上的额外约定。

### 2.1 `source` 字段取值

| 取值 | 用途 |
|------|------|
| `atomicity_violation` | 多变量原子性违反（multivar-atomicity-checker）— 已存在 |
| `single_var_atomicity` | 单变量原子性违反（singlevar-atomicity-checker）— 新增 |
| `hw_mmio_conflict` | 硬件原子性违反 + 多字长数据竞争 — 新增 |
| `order_violation` | 顺序违反 — 新增 |

旧值 `interrupt_review` 在 isr-reviewer 废弃后不再写入新数据，但读取兼容。

### 2.2 `id` 前缀

| 前缀 | source |
|------|--------|
| `DEF-MVA-NNN` | atomicity_violation |
| `DEF-SVA-NNN` | single_var_atomicity |
| `DEF-HWA-NNN` | hw_mmio_conflict |
| `DEF-ORV-NNN` | order_violation |

NNN 由各 agent 在自己 source 范围内自增（不要求全局唯一）。

### 2.3 必填扩展字段

所有冲突检测类 defect 在 `Defect` schema 基础上**必须**在 description 之外的结构化位置提供以下信息。当前实现把扩展字段塞在 `description`（自由文本）里，新规定改为放在新增的 `evidence`（自由 key-value）字段中，schema 保持向后兼容。

```jsonc
{
  // ... Defect 标准字段（id/source/severity/category/location/title/description/...）
  
  "evidence": {
    "subtype": "RWR" | "RWW" | "WRW" | "WWR" | "WWW" | "DFC_RWWR" | ...,
    "shared_variables": ["var1", "var2"],
    "accesses": [
      {
        "access_type": "READ" | "WRITE",
        "context": "main" | "ISR_name",
        "function": "string",
        "file": "string",
        "line": 123,
        "code_snippet": "string"
      }
      // ... 3 个或 4 个访问点
    ],
    "feasibility": "CONFIRMED" | "UNKNOWN" | "INFEASIBLE" | "UNCHECKED",
    "confidence": 0.75,                          // [0, 1]
    "evidence_breakdown": {                      // 评分分项，供报告展示
      "structural_match": 0.45,
      "semantic_llm": 0.30,
      "path_feasibility": 0.00                   // 通过 = 0, 失败为负，未做 = 缺失
    },
    "llm_status": "EVALUATED" | "SKIPPED_PASS" | "SKIPPED_FILTERED" | "UNAVAILABLE",
    "llm_judgment": "STRONG" | "WEAK" | "NONE" | null,
    "llm_reason": "string | null",
    "fix_suggestion": {
      "strategy": "disable_global_interrupt" | "disable_specific_interrupt" | "copy_under_protection" | "atomic_intrinsic" | "redesign",
      "rationale": "string"
    }
  }
}
```

### 2.4 严重度映射规则

| feasibility | severity |
|------------|----------|
| CONFIRMED  | critical |
| UNKNOWN    | major    |
| UNCHECKED  | major    |
| INFEASIBLE | info     |

INFEASIBLE 不计入 `summary.open_critical`，但保留在 `defects[]` 用于追溯。

### 2.5 写入工具

所有 agent 必须使用 `append_defects` 工具写入，禁止用 `write` 直接覆盖 `defects.json`。`append_defects` 按 `source` 字段隔离，保证并行 agent 不互相覆盖。

---

## 契约 3：LLM 三级判定标准

所有需要 LLM 语义判定的场景（识别原子意图、判断变量关联、Z3 UNKNOWN 兜底、保护原语充分性评估）**必须**使用统一的三级判定接口。

### 3.1 判定值

| 判定 | L 值 | 语义 |
|------|------|------|
| `STRONG` | 1.0 | 高确信存在该语义关系/违反 |
| `WEAK`   | 0.5 | 不确定 |
| `NONE`   | 0.0 | 高确信不存在 |

**禁止**输出连续浮点数（如 0.7、0.85），原因：LLM 不同次输出的小数差异不稳定，融合公式中会放大噪声。

### 3.2 融合公式

```
confidence_final = S + L × λ(scenario)
```

`S` 是工具层结构性置信度，`λ` 是场景缩放因子：

| 场景 | λ | 备注 |
|------|---|------|
| 多变量 DFC 关联判定 | 0.15 | multivar-atomicity-checker 现行 |
| 多变量 TUP 关联判定 | 0.15 | multivar-atomicity-checker 现行 |
| 多变量 DAC 关联判定 | 0.40 | multivar-atomicity-checker 现行 |
| 单变量原子意图判定 | 0.30 | 新增（intAtom Stage 2 替代） |
| 顺序违反 happens-before 判定 | 0.30 | 预留 |
| Z3 UNKNOWN 兜底判定 | 0.20 | 预留 |
| 保护原语充分性判定 | 0.25 | 预留 |

新增场景前必须在本表登记 λ，避免不同 agent 各自挑数字。

### 3.3 LLM 调用规范

```typescript
interface LlmJudgmentRequest {
  scenario: "atomic_intent" | "var_correlation_dfc" | "var_correlation_tup" 
          | "var_correlation_dac" | "happens_before" | "z3_unknown_fallback" 
          | "protection_adequacy"
  context_code: string         // 待判定的源码片段
  context_window_lines: number // 一般取 30
  prompt_template_id: string   // 同 scenario 下可能有多版本提示词
  candidates: Array<{
    id: string
    description: string        // 一句话描述待判定对象
  }>
}

interface LlmJudgmentResponse {
  judgments: Array<{
    id: string
    judgment: "STRONG" | "WEAK" | "NONE"
    reason: string             // 一句话理由，<= 60 字
  }>
}
```

### 3.4 降级与可观测性

每个 defect 的 `evidence.llm_status` 字段记录调用状态：

| llm_status | 语义 |
|-----------|------|
| `EVALUATED` | LLM 实际判定 |
| `SKIPPED_PASS` | 结构分 S 足够高，跳过 LLM 直接通过 |
| `SKIPPED_FILTERED` | 结构分 S 太低，跳过 LLM 直接丢弃 |
| `UNAVAILABLE` | LLM 不可用，按 NONE 处理（最保守） |

LLM 不可用时，**任何 agent 都必须能产出 UNKNOWN 结果而非崩溃**。

---

## 契约外的内容

以下事项**不在本契约约束范围内**，各 agent 自由实现：
- Joern 查询脚本的内部结构
- 模式匹配的具体算法
- Z3 编码方式与求解策略
- 跨函数松弛规则（每个 agent 按自己冲突类型决定）
- 报告章节结构（除聚合报告之外）

---

## 变更管理

- 本契约的修改需要在 `docs/plans/` 下新建 plan 文件说明动机；
- 修改若破坏已有 agent 输出格式，必须同步升级 `append_defects` 工具的 schema 校验；
- 新增 `source` 取值或 LLM 场景仅追加，不改既有取值含义。

## 历史与现状

- multivar-atomicity-checker 当前实现已基本符合本契约 §2 与 §3；
- §1 CPG 共享需要在 `cpg_create` 工具中新增 hash 检查逻辑（约 30 行）；
- 新增 agent 必须从一开始遵循本契约，无遗留兼容包袱。
