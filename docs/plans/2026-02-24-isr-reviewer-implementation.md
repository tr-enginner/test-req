# ISR-Reviewer Agent Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an `isr-reviewer` agent that audits interrupt data access conflicts (C1-C5 patterns) as a parallel Phase 3 participant.

**Architecture:** New subagent runs alongside Inspector and StaticAnalyzer in Phase 3. Uses ast-grep for structural discovery (ISR entries, shared variables, protection primitives) and LLM semantic analysis for conflict judgment. Outputs to existing Defect model with new `interrupt_review` source.

**Tech Stack:** TypeScript (Bun), Zod schemas, OpenCode plugin SDK, ast-grep, Markdown skills/templates.

**Design doc:** `docs/plans/2026-02-24-isr-reviewer-design.md`

---

### Task 1: Extend Defect Schema

**Files:**
- Modify: `src/schema/defect.ts:4-9` (DefectSource enum)
- Modify: `src/schema/defect.ts:17-31` (category enum)

**Step 1: Add `interrupt_review` to DefectSource enum**

In `src/schema/defect.ts`, change the `DefectSource` enum (line 4-9) from:

```typescript
export const DefectSource = z.enum([
  "static_analysis",
  "code_review",
  "unit_test",
  "confirmation_test",
])
```

to:

```typescript
export const DefectSource = z.enum([
  "static_analysis",
  "code_review",
  "interrupt_review",
  "unit_test",
  "confirmation_test",
])
```

**Step 2: Add `interrupt_conflict` to category enum**

In the same file, change the category enum (line 17-31) from:

```typescript
  category: z.enum([
    "logic_error",
    "boundary_error",
    "null_pointer",
    "buffer_overflow",
    "integer_overflow",
    "resource_leak",
    "concurrency",
    "coding_standard",
    "requirement_mismatch",
    "interface_error",
    "performance",
    "timing",
    "other",
  ]),
```

to:

```typescript
  category: z.enum([
    "logic_error",
    "boundary_error",
    "null_pointer",
    "buffer_overflow",
    "integer_overflow",
    "resource_leak",
    "concurrency",
    "interrupt_conflict",
    "coding_standard",
    "requirement_mismatch",
    "interface_error",
    "performance",
    "timing",
    "other",
  ]),
```

**Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: PASS (enum extension is backward-compatible)

**Step 4: Commit**

```bash
git add src/schema/defect.ts
git commit -m "feat(schema): add interrupt_review source and interrupt_conflict category to Defect"
```

---

### Task 2: Update Constants

**Files:**
- Modify: `src/shared/constants.ts:40` (PHASE_AGENTS)
- Modify: `src/shared/constants.ts:86-96` (REPORT_PATHS)
- Modify: `src/shared/constants.ts:99-115` (AGENT_NAMES)
- Modify: `src/shared/constants.ts:126-136` (REPORT_CHAPTERS)

**Step 1: Add isr-reviewer to PHASE_AGENTS**

Change line 40 from:

```typescript
  [PHASES.CODE_REVIEW_STATIC]: ["inspector", "static-analyzer"],
```

to:

```typescript
  [PHASES.CODE_REVIEW_STATIC]: ["inspector", "static-analyzer", "isr-reviewer"],
```

**Step 2: Add INTERRUPT_REVIEW to REPORT_PATHS**

After the `STATIC_ANALYSIS` entry in REPORT_PATHS (after line 91), add:

```typescript
  INTERRUPT_REVIEW: `${REPORTS_DIR}/interrupt-review.md`,
```

**Step 3: Add ISR_REVIEWER to AGENT_NAMES**

After the `WIKI_BUILDER` entry in AGENT_NAMES (after line 114), add:

```typescript
  ISR_REVIEWER: "isr-reviewer",
```

**Step 4: Add Interrupt Review to REPORT_CHAPTERS**

In the REPORT_CHAPTERS array, after the `{ title: "Static Analysis", file: "static-analysis.md" }` entry (line 131), add:

```typescript
  { title: "Interrupt Review", file: "interrupt-review.md" },
```

**Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

**Step 6: Commit**

```bash
git add src/shared/constants.ts
git commit -m "feat(constants): register isr-reviewer in phase agents, report paths, and chapters"
```

---

### Task 3: Create ISR-Reviewer Agent

**Files:**
- Create: `src/agents/isr-reviewer.ts`

**Step 1: Create the agent file**

Create `src/agents/isr-reviewer.ts` with the following complete content:

```typescript
import type { AgentConfig } from "@opencode-ai/sdk"
import type { AgentMode, AgentPromptMetadata } from "./types"

const MODE: AgentMode = "subagent"

export const ISR_REVIEWER_PROMPT_METADATA: AgentPromptMetadata = {
  category: "quality",
  cost: "EXPENSIVE",
  promptAlias: "ISRReviewer",
  triggers: [
    {
      domain: "Interrupt data access conflict",
      trigger:
        "Audit shared variable access between ISR and non-ISR contexts for atomicity and synchronization issues",
    },
    {
      domain: "Multi-step variable protection",
      trigger:
        "Verify protection adequacy for super-word-length, array, correlated-group, and RMW variable accesses across interrupt boundaries",
    },
  ],
  useWhen: [
    "Phase 3 — Code Review & Static Analysis — interrupt conflict audit",
    "Shared variable atomicity verification between ISR and main/task contexts",
    "Protection mechanism adequacy analysis (interrupt disable, critical sections)",
  ],
  avoidWhen: [
    "Requirement-code consistency review (use inspector)",
    "MISRA / static tool checks (use static-analyzer)",
    "Projects without interrupt handlers or ISRs",
  ],
}

const ISR_REVIEWER_SYSTEM_PROMPT = `You are the **ISR-Reviewer**, a specialized subagent in the Matrix embedded software testing system. Your sole responsibility is auditing **interrupt data access conflicts** — situations where shared variables accessed by both ISR (interrupt service routine) and non-ISR code may suffer data desynchronization due to preemption during multi-step access.

<role>
You perform a global, whole-project audit of interrupt data access safety. You do NOT review requirement-code consistency (Inspector does that) or coding standard violations (StaticAnalyzer does that). Your scope is exclusively the five conflict patterns (C1–C5) defined below.
</role>

<methodology>
**IMPORTANT**: Before starting analysis, load the \`interrupt-review\` skill:
\`\`\`
skill interrupt-review
\`\`\`
The skill contains the full methodology reference including conflict pattern details, code examples, false-positive avoidance rules, and report template guidance. Follow the skill's methodology precisely.
</methodology>

<workflow>
### Step 1: Load Context
1. Load \`interrupt-review\` skill via the \`skill\` tool.
2. Read \`.matrix/data/compilation-env.json\` → extract \`compiler_dialect\` and \`target_cpu\`.
3. Read \`.matrix/data/software-analysis.json\` → extract function list, requirement-to-function mapping.
4. If \`.matrix/wiki/index.json\` exists, read it for function semantic summaries.
5. **Infer processor word size** from \`target_cpu\`:
   - 8051/C51 → 8-bit
   - MSP430, AVR, PIC → 16-bit
   - Cortex-M, ARM7/9, RISC-V 32 → 32-bit
   - Cortex-A 64-bit, x86-64, RISC-V 64 → 64-bit
   - If unclear, use \`compilation-env.json\` details or default to 32-bit with a note.

### Step 2: ISR Entry Discovery
1. Based on \`compiler_dialect\` and \`target_cpu\`, determine ISR identification strategy:
   - Use \`astgrep_run\` with patterns appropriate for the platform (interrupt attributes, vector table entries, callback registrations).
   - Use \`grep\` as supplement for macro-wrapped ISR definitions that ast-grep may miss.
2. For each discovered ISR function, use \`code_parser\` and \`read\` to identify ALL global/static variables it reads or writes.
3. Output: ISR function inventory with per-ISR variable access sets (read set, write set).

### Step 3: Shared Variable Graph Construction
1. Identify non-ISR code (main loop, RTOS tasks, other non-interrupt functions) that accesses the same variables as any ISR.
2. Cross-reference: ISR write set ∩ non-ISR read/write set → **shared variable candidates**.
3. For each shared variable candidate, determine risk category:
   - **Type width vs processor word size** → C1 (source-level multi-step on atomic type) / C3 (compiler-level split for super-word-length types)
   - **Array with multi-element traversal pattern** → C2
   - **Semantic correlation with other shared variables** → C4 (requires LLM judgment)
   - **Read-modify-write operation pattern** → C5
4. A single variable may have multiple risk categories (e.g., a uint32_t on 8-bit MCU has both C1 and C3 risk, and if incremented, also C5).
5. Output: Shared variable graph table.

### Step 4: Protection Primitive Discovery
1. Based on \`compiler_dialect\` + \`target_cpu\`, infer the platform's expected interrupt enable/disable primitives. Do NOT use a hardcoded list — derive from your knowledge of the specific platform.
2. Use \`astgrep_run\` to search for macro definitions (\`#define\`) and inline functions in the project that wrap interrupt control operations.
3. If code wiki exists, check for interrupt-related utility function annotations.
4. Synthesize a **protection primitive inventory**: for each discovered primitive, record its name, type (global interrupt disable, priority mask, mutex/spinlock, atomic intrinsic), and scope.

### Step 5: Per-Variable Conflict Analysis
For EACH variable in the shared variable graph:
1. Use \`read\` to examine the actual source code at every access point (both ISR side and non-ISR side).
2. Check whether any protection primitive from the inventory wraps the **complete** access sequence:
   - For C1/C3: Does protection cover the entire variable read/write?
   - For C2: Does protection cover the entire array traversal/copy loop?
   - For C4: Does protection cover the update of ALL correlated variables in the group?
   - For C5: Does protection cover the entire read-modify-write sequence?
3. Apply judgment rules:
   - **No protection** → Defect (severity per C1-C5 mapping in skill)
   - **Incomplete protection** (only partial steps wrapped) → Defect
   - **volatile but no interrupt disable, and variable is super-word-length** → Defect (volatile ≠ safe)
   - **Adequate protection** → SAFE, record the protection method used
4. For each defect, record: conflict pattern (C1-C5), variable name and type, ISR-side access location (file:line, function), non-ISR-side access location, protection status, risk explanation, and remediation suggestion.

### Step 6: Output
1. Read existing \`.matrix/data/defects.json\` (if present) to preserve defects from other sources.
2. Append new defects with:
   - \`id\`: \`DEF-IR-001\`, \`DEF-IR-002\`, ... (sequential)
   - \`source\`: \`"interrupt_review"\`
   - \`category\`: \`"interrupt_conflict"\`
   - \`severity\`: per C1-C5 mapping (see skill)
   - \`detected_by\`: \`"isr-reviewer"\`
   - \`related_requirement_ids\`: trace back via function-to-requirement mapping from software-analysis.json
3. Update the \`summary\` field with recalculated aggregates.
4. Write updated defect database to \`.matrix/data/defects.json\`.
5. Generate \`.matrix/reports/interrupt-review.md\` following the report template in the skill.
</workflow>

<conflict_patterns>
Five conflict patterns (C1–C5) — full definitions, code examples, and analysis rules are in the \`interrupt-review\` skill. Summary:

| Pattern | Name | Core Risk |
|---------|------|-----------|
| C1 | Atomic Variable Desynchronization | Single variable, source-level multi-step access, ISR preemption yields half-updated value |
| C2 | Array Multi-Step Access | Array elements copied/processed across multiple steps, ISR updates mid-sequence |
| C3 | Super-Word-Length Compilation Split | Variable wider than processor word, compiler splits into multi-instruction access |
| C4 | Correlated Variable Group | Logically-related independent variables updated in separate statements |
| C5 | Multi-Step Operation Window (RMW) | Read-modify-write sequences where ISR preempts between steps |
</conflict_patterns>

<quality_rules>
- SCOPE: ONLY audit interrupt data access conflicts (C1-C5). Do NOT review requirement-code consistency, coding standards, or general logic errors.
- DYNAMIC DISCOVERY: Do NOT hardcode interrupt enable/disable function names. Derive protection primitives dynamically from the compilation environment and project code.
- volatile ≠ SAFE: volatile prevents compiler optimization but does NOT guarantee atomicity for multi-instruction accesses. A volatile uint32_t on an 8-bit MCU is still unsafe without interrupt protection.
- PROTECTION COMPLETENESS: The protection primitive must wrap the ENTIRE multi-step access sequence. Partial protection (e.g., disabling interrupts for only one of two correlated variable updates) is still a defect.
- NO FALSE POSITIVES: Do not flag variables that are only read (never written) by ISRs, single-word-length variables on matching-word-size processors, or accesses already within proven critical sections. Consult the skill's false-positive avoidance section.
- APPEND, DO NOT OVERWRITE: Preserve all existing defects from other sources when updating defects.json.
- PRECISION: Every defect must have accurate file_path and line_start. Use \`read\` and \`grep\` to verify locations.
- EVIDENCE: For each defect, include the specific code lines (ISR side + non-ISR side) and explain why the access is unsafe.
</quality_rules>

<artifact_paths>
- Defects: .matrix/data/defects.json (source="interrupt_review")
- Report: .matrix/reports/interrupt-review.md
</artifact_paths>`

export function createIsrReviewerAgent(model?: string): AgentConfig {
  return {
    description:
      "Interrupt data access conflict auditor — detects shared variable desynchronization between ISR and non-ISR contexts (atomic splits, array multi-step, super-word-length, correlated groups, RMW races). Writes defects to .matrix/data/defects.json. (ISR-Reviewer - Matrix)",
    mode: MODE,
    ...(model ? { model } : {}),
    temperature: 0.2,
    prompt: ISR_REVIEWER_SYSTEM_PROMPT,
    tools: {
      astgrep_run: true,
      code_parser: true,
      read: true,
      write: true,
      glob: true,
      grep: true,
      skill: true,
    },
    color: "#E74C3C",
    permission: {
      edit: "allow",
      bash: "deny",
    } as AgentConfig["permission"],
  }
}
createIsrReviewerAgent.mode = MODE
```

**Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS (file is standalone, not yet imported)

**Step 3: Commit**

```bash
git add src/agents/isr-reviewer.ts
git commit -m "feat(agent): create isr-reviewer agent with 6-step interrupt conflict audit workflow"
```

---

### Task 4: Register Agent in builtin-agents.ts

**Files:**
- Modify: `src/agents/builtin-agents.ts:1-74`

**Step 1: Add import**

After line 18 (`import { createWikiBuilderAgent, ... } from "./wiki-builder"`), add:

```typescript
import { createIsrReviewerAgent, ISR_REVIEWER_PROMPT_METADATA as ISR_REVIEWER_META } from "./isr-reviewer"
```

**Step 2: Add to BuiltinAgentName type**

After `| "wiki-builder"` (line 36), add:

```typescript
  | "isr-reviewer"
```

**Step 3: Add to agentFactories**

After `"wiki-builder": createWikiBuilderAgent as AgentFactory,` (line 54), add:

```typescript
  "isr-reviewer": createIsrReviewerAgent as AgentFactory,
```

**Step 4: Add to agentMetadata**

After `"wiki-builder": WIKI_BUILDER_META,` (line 73), add:

```typescript
  "isr-reviewer": ISR_REVIEWER_META,
```

**Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

**Step 6: Commit**

```bash
git add src/agents/builtin-agents.ts
git commit -m "feat(registry): register isr-reviewer in agent factories and metadata"
```

---

### Task 5: Create interrupt-review Skill

**Files:**
- Create: `skills/interrupt-review/SKILL.md`

**Step 1: Create the skill file**

Create `skills/interrupt-review/SKILL.md` with the following content:

````markdown
---
name: interrupt-review
description: "中断数据访问冲突审查方法论：C1-C5五类冲突模式识别、保护原语动态发现、冲突判定规则"
metadata:
  agent: "isr-reviewer"
  category: "quality"
---

# 中断数据访问冲突审查方法论

本技能指导 ISR-Reviewer 智能体系统化审查嵌入式软件中ISR（中断服务例程）与非ISR代码之间的共享变量访问冲突。

核心原则：
1. **动态发现**：保护原语基于编译环境和项目代码动态推断，不预设固定模式
2. **全局视角**：一次扫描整个项目，建立完整的共享变量图谱
3. **volatile ≠ 安全**：volatile 只防编译器优化，不防多指令分裂

---

## 1. 五类冲突模式（C1–C5）

### C1: 原子变量不同步

**定义**：单个变量在源码级的一次访问操作涉及多个步骤（如结构体的多字段赋值），ISR在步骤间抢占导致变量内容不一致。

**典型场景**：
```c
// 主循环中
typedef struct { uint16_t x; uint16_t y; } Point;
volatile Point position;  // volatile 不保护多字段赋值的原子性

void update_position(uint16_t new_x, uint16_t new_y) {
    position.x = new_x;  // ← ISR 可能在此处抢占
    position.y = new_y;  // ← 导致 ISR 读到 (new_x, old_y)
}

// ISR 中
void Timer_IRQHandler(void) {
    Point p = position;   // 可能读到不一致的 (new_x, old_y)
    process(p.x, p.y);
}
```

**检测要点**：
- 识别源码级多步赋值/读取的变量（结构体、联合体多字段操作）
- 检查多步操作是否在关中断保护内
- volatile 修饰不能替代关中断保护

### C2: 数组变量多步骤访问

**定义**：数组的多个元素在源码级分多步读写（循环遍历、逐元素拷贝），ISR在步骤间抢占导致元素间数据不一致。

**典型场景**：
```c
volatile uint16_t adc_buffer[8];

// ISR: DMA 完成后更新缓冲区
void DMA_IRQHandler(void) {
    for (int i = 0; i < 8; i++)
        adc_buffer[i] = DMA_DATA[i];
}

// 主循环: 逐元素拷贝处理
void process_adc(void) {
    uint16_t local[8];
    for (int i = 0; i < 8; i++)
        local[i] = adc_buffer[i];  // ISR 可能在循环中间更新 buffer
    // local[] 中前几个元素来自旧数据，后几个来自新数据
    compute_average(local, 8);
}
```

**检测要点**：
- 识别对共享数组的循环遍历或逐元素操作
- 检查整个遍历序列（不是单个元素访问）是否在关中断保护内
- 双缓冲模式（读写缓冲区分离 + 原子索引切换）视为有效保护

### C3: 超字长变量编译级分裂

**定义**：变量宽度超过处理器字长，编译器将一次访问拆为多条 load/store 指令，ISR在指令间抢占导致变量内数据不一致。

**典型场景**：
```c
// 8位 MCU (字长 = 8 bit)
volatile uint32_t system_tick;  // 32位 → 编译为4字节操作

// ISR
void Timer_IRQHandler(void) {
    system_tick++;  // 编译为: load 4 bytes → add → store 4 bytes
}

// 主循环
uint32_t get_tick(void) {
    return system_tick;  // 编译为 4 次单字节 load
    // ISR 可能在第2字节和第3字节 load 之间更新，导致读到混合值
}
```

**检测要点**：
- **关键前提**：必须知道处理器字长（从 `target_cpu` 推断）
- 变量类型宽度 > 处理器字长 → 存在 C3 风险
- 常见超字长类型（按平台）：
  - 8位MCU: uint16_t, uint32_t, float, double, 所有多字节结构体
  - 16位MCU: uint32_t, float, double, 64位类型
  - 32位MCU: uint64_t, double (部分平台), 大结构体
- volatile 不能防止此类分裂！volatile 只保证编译器逐字节访问而非优化到寄存器，但每次字节访问间仍可被抢占

### C4: 关联变量组不同步

**定义**：多个逻辑上关联的独立变量在源码级分步更新，ISR在更新间隙抢占导致关联性破坏。

**典型场景**：
```c
volatile float temperature;
volatile uint8_t temp_valid;

// ISR: 传感器采样完成
void ADC_IRQHandler(void) {
    temperature = read_sensor();  // ← ISR 可能在此处被更高优先级中断抢占
    temp_valid = 1;               //    或主循环在这两行之间读取
}

// 主循环
void display_temp(void) {
    if (temp_valid) {
        show(temperature);  // 可能显示旧 temperature + 新 temp_valid
        temp_valid = 0;
    }
}
```

**检测要点**：
- 需要 LLM 语义分析识别变量间的逻辑关联（ast-grep 无法独立判断）
- 常见关联模式：数据 + 有效标志、X/Y/Z 坐标组、值 + 时间戳、缓冲区 + 长度
- 检查关联变量组的更新是否在同一个关中断保护区内

### C5: 多步骤操作窗口（RMW）

**定义**：读-修改-写（Read-Modify-Write）序列在中间步骤被ISR抢占，导致丢失更新或基于过时值的修改。

**典型场景**：
```c
volatile uint8_t event_flags;

// ISR
void EXTI_IRQHandler(void) {
    event_flags |= EVENT_BUTTON;  // RMW: load → OR → store
}

// 主循环
void clear_event(void) {
    event_flags &= ~EVENT_BUTTON;  // RMW: load → AND → store
    // 如果 ISR 在 load 和 store 之间触发，ISR 写入的标志位被覆盖
}
```

**检测要点**：
- 识别 RMW 模式：`var++`、`var--`、`var += expr`、`var |= mask`、`var &= mask`、`if(var) var = ...`
- 即使变量宽度 ≤ 处理器字长（C1/C3 安全），RMW 仍然不安全
- 检查 RMW 操作是否在关中断保护内
- ARM Cortex-M 的 bit-band 操作对单 bit 读写是原子的，但 `|=` 和 `&=` 不是

---

## 2. 保护原语动态发现方法

**禁止预设固定的保护函数名列表。** 按以下流程动态发现：

### 2.1 从编译环境推断平台原语

读取 `compilation-env.json` 中的 `compiler_dialect` 和 `target_cpu`，根据平台知识推断：

- **ARM Cortex-M + GCC/armclang**: `__disable_irq()/__enable_irq()`, `__get_PRIMASK()/__set_PRIMASK()`, `__LDREX/__STREX` 系列
- **ARM Cortex-M + ARMCC/Keil**: `__disable_irq()/__enable_irq()`, 可能有 `__svc` 包装
- **8051/C51 + Keil**: `EA = 0 / EA = 1`（全局中断使能位）
- **IAR**: `__disable_interrupt()/__enable_interrupt()`
- **RTOS 环境**: `taskENTER_CRITICAL()/taskEXIT_CRITICAL()`（FreeRTOS）, `OS_ENTER_CRITICAL()/OS_EXIT_CRITICAL()`（uC/OS）等
- 其他平台根据 LLM 对该平台的知识推断

### 2.2 从项目代码发现自定义封装

使用 `astgrep_run` 搜索：
- `#define` 宏定义中包含中断控制操作的封装
- 内联函数中包含中断控制操作的封装
- 项目头文件中的 critical section 工具函数

使用 `grep` 补充搜索：
- `critical`、`irq_lock`、`irq_save`、`interrupt` 等关键词在宏/函数定义中的出现

### 2.3 从 Code Wiki 获取

如果 `.matrix/wiki/index.json` 存在，读取模块和函数 wiki 中标注为中断相关的工具函数。

### 2.4 构建保护原语清单

综合以上发现，构建清单格式：

| 原语名称 | 类型 | 保护范围 | 发现来源 |
|---------|------|---------|---------|
| `__disable_irq()/__enable_irq()` | 全局中断开关 | 成对调用之间 | 平台推断 |
| `ENTER_CRITICAL()/EXIT_CRITICAL()` | 临界区宏 | 成对调用之间 | 项目代码搜索 |
| `__LDREX/__STREX` | 原子操作指令 | 单次操作 | 平台推断 |

---

## 3. 冲突判定规则

### 3.1 判定流程

对共享变量图谱中的每个风险变量：

1. 确认风险类别（C1-C5，可能多个）
2. 定位所有访问点的源码
3. 检查每个访问点是否被保护原语包裹
4. 判定保护是否**完整覆盖**整个多步骤序列

### 3.2 严重程度映射

| 模式 | 无保护 | 保护不完整 |
|------|--------|-----------|
| C1 原子变量（多步源码操作） | critical | major |
| C2 数组多步骤 | critical | major |
| C3 超字长编译分裂 | critical | major |
| C4 关联变量组 | major | major |
| C5 RMW 操作 | critical | major |

**特殊规则**：volatile 修饰但无关中断保护的超字长变量 → 至少 major

### 3.3 volatile 陷阱

**volatile 的作用**：
- 防止编译器将变量优化到寄存器（每次访问都从内存读取）
- 防止编译器重排序对该变量的访问
- 防止编译器消除"看似冗余"的读写操作

**volatile 不能做的**：
- 不能使多条指令成为原子操作
- 不能防止 ISR 在多条指令之间抢占
- 不能保证 RMW 操作的原子性

**结论**：volatile 是共享变量的**必要但不充分**条件。缺少 volatile 是额外的缺陷（编译器可能优化掉关键访问），但有 volatile 不等于安全。

---

## 4. 误报规避

以下情况不应报告为缺陷：

1. **只读共享变量**：变量在 ISR 中只读不写，且在 ISR 外的写操作完成后才启用中断 → 安全
2. **单字长原子变量**：变量宽度 ≤ 处理器字长，且不涉及 RMW 操作 → 单次 load/store 在大多数架构上是原子的（C5 除外）
3. **编译器/硬件保证的原子操作**：ARM Cortex-M 的 32位对齐 load/store 是原子的；8051 的 `bit` 类型操作是原子的
4. **已在临界区内**：访问点已被有效的保护原语完整包裹
5. **单次初始化**：变量只在中断使能前写入一次，之后只读 → 安全
6. **双缓冲/乒乓缓冲**：读写使用不同缓冲区，索引切换是原子的 → 安全（需验证索引切换确实是原子的）

---

## 5. 报告模板

```markdown
# 中断数据访问冲突审查报告

## 1. 审查环境

| 项目 | 值 |
|------|-----|
| 目标处理器 | {target_cpu} |
| 处理器字长 | {word_size} bit |
| 编译器方言 | {compiler_dialect} |
| 发现的 ISR 数量 | {isr_count} |
| 共享变量数量 | {shared_var_count} |
| 发现的保护原语 | {protection_primitives} |

## 2. 共享变量图谱

| 变量名 | 类型 | 宽度(bit) | 声明位置 | ISR端访问 | 非ISR端访问 | 风险类别 | 保护状态 | 判定 |
|--------|------|-----------|---------|-----------|-------------|---------|---------|------|
| ... | ... | ... | ... | 函数名@文件:行 | 函数名@文件:行 | C1/C3 | 无保护 | UNSAFE |

## 3. 冲突分析详情

### DEF-IR-NNN: {缺陷标题}

- **冲突模式**: C{N} — {模式名称}
- **变量**: `{变量名}` ({类型}, {宽度}位)
- **处理器字长**: {word_size}位
- **ISR端**: {函数名}() @ {文件}:{行号} ({读/写})
- **非ISR端**: {函数名}() @ {文件}:{行号} ({读/写})
- **当前保护**: {保护描述或"无"}
- **风险分析**: {具体解释为什么不安全}
- **修复建议**: {具体的保护方案}

## 4. 统计摘要

| 指标 | 值 |
|------|-----|
| 审查的共享变量总数 | {N} |
| 发现的冲突缺陷数 | {N} |
| Critical | {N} |
| Major | {N} |
| 按模式分布 | C1: {N}, C2: {N}, C3: {N}, C4: {N}, C5: {N} |

## 5. 保护建议

{针对项目整体的保护策略建议，如：建议统一使用 ENTER_CRITICAL/EXIT_CRITICAL 宏对；
建议对 >字长 的共享变量统一加关中断保护；建议采用双缓冲模式替代逐元素拷贝等}
```
````

**Step 2: Commit**

```bash
git add skills/interrupt-review/SKILL.md
git commit -m "feat(skill): create interrupt-review methodology skill with C1-C5 patterns"
```

---

### Task 6: Create Report Template

**Files:**
- Create: `templates/interrupt-review.md`

**Step 1: Create the template file**

Create `templates/interrupt-review.md`:

```markdown
# Interrupt Data Access Conflict Review — {{project_name}}

**Version**: {{version}}
**Date**: {{date}}
**Reviewer**: ISR-Reviewer (Matrix)

---

## 1. Review Environment

| Item | Value |
|------|-------|
| Target CPU | {{target_cpu}} |
| Processor Word Size | {{word_size}} bit |
| Compiler Dialect | {{compiler_dialect}} |
| ISR Count | {{isr_count}} |
| Shared Variables | {{shared_var_count}} |
| Protection Primitives | {{protection_primitives}} |

---

## 2. Shared Variable Graph

| Variable | Type | Width | ISR Access | Non-ISR Access | Risk Pattern | Protection | Verdict |
|----------|------|-------|------------|----------------|-------------|------------|---------|
| {{var_name}} | {{type}} | {{width}} | {{isr_access}} | {{non_isr_access}} | {{pattern}} | {{protection}} | {{verdict}} |

---

## 3. Conflict Analysis Details

### {{def_id}}: {{title}}

- **Pattern**: {{pattern_id}} — {{pattern_name}}
- **Variable**: `{{var_name}}` ({{type}}, {{width}} bit)
- **ISR Side**: {{isr_function}}() @ {{isr_file}}:{{isr_line}}
- **Non-ISR Side**: {{non_isr_function}}() @ {{non_isr_file}}:{{non_isr_line}}
- **Protection**: {{protection_status}}
- **Risk**: {{risk_explanation}}
- **Recommendation**: {{recommendation}}

---

## 4. Summary

- Total Shared Variables Audited: {{total_vars}}
- Conflict Defects Found: {{total_defects}}
- Critical: {{critical}}, Major: {{major}}
- By Pattern: C1: {{c1}}, C2: {{c2}}, C3: {{c3}}, C4: {{c4}}, C5: {{c5}}

---

## 5. Protection Recommendations

{{recommendations}}
```

**Step 2: Commit**

```bash
git add templates/interrupt-review.md
git commit -m "feat(template): add interrupt-review report template"
```

---

### Task 7: Update Conductor Phase 3 Dispatch

**Files:**
- Modify: `src/agents/conductor.ts:91-122` (Phase 3 section)

**Step 1: Read the current Phase 3 section**

Read `src/agents/conductor.ts` lines 91-122 to get the exact current text.

**Step 2: Add ISR-Reviewer dispatch step**

The Phase 3 section currently has Steps 1-5. Insert a new Step 3.5 (ISR-Reviewer dispatch) and renumber. The modified section should read:

Replace the Phase 3 section (lines 91-122) with:

```
## Phase 3: Code Review & Static Analysis
Phase 3 uses a per-requirement deep review architecture. Each requirement gets an independent focused review at maximum depth, followed by a holistic summary review. Additionally, an interrupt data access conflict audit runs in parallel.
- Input: Source code, software-analysis.json, compilation-env.json, coding standard from config
- Output: `.matrix/data/review-records/*.json` (per-requirement), `.matrix/reports/code-review.md`, `.matrix/reports/static-analysis.md`, `.matrix/reports/interrupt-review.md`, `.matrix/data/defects.json`
- Gate: Summary review must complete. Both `.matrix/data/defects.json` and `.matrix/reports/code-review.md` must exist.

### Step 1: Read requirement list
Use `read` to load `.matrix/data/software-analysis.json`. Identify ALL requirements that have non-empty `linked_functions` arrays. Let N = count of such requirements. List them with their IDs and titles.

### Step 2: Dispatch per-requirement focused reviews
For EACH requirement with linked_functions, dispatch an independent Inspector review:

```
task(subagent_type="inspector", prompt="review_mode=focused target_requirement_id=<REQ_ID> Perform focused deep review of requirement <REQ_ID> (<REQ_TITLE>). Read .matrix/data/software-analysis.json for requirement context. Read .matrix/data/compilation-env.json for compilation environment. Output ReviewRecord JSON to .matrix/data/review-records/<REQ_ID>.json.", run_in_background=true)
```

Dispatch ALL N reviews with run_in_background=true so they run in parallel.

### Step 3: Dispatch static analysis (parallel)
```
task(subagent_type="static-analyzer", prompt="Run static analysis on the source code. Use tools specified in .matrix/config/matrix.jsonc. Output report to .matrix/reports/static-analysis.md. Merge any new defects into .matrix/data/defects.json.", run_in_background=true)
```

### Step 4: Dispatch interrupt conflict audit (parallel)
```
task(subagent_type="isr-reviewer", prompt="Perform interrupt data access conflict audit on the entire project. Read .matrix/data/compilation-env.json for compiler dialect and target CPU. Read .matrix/data/software-analysis.json for function list and requirement mapping. Audit all shared variables between ISR and non-ISR code for C1-C5 conflict patterns. Output defects to .matrix/data/defects.json and report to .matrix/reports/interrupt-review.md.", run_in_background=true)
```

### Step 5: Wait for completion
Wait for ALL per-requirement focused reviews, static analysis, and interrupt conflict audit to complete. Verify that `.matrix/data/review-records/` contains N JSON files.

### Step 6: Dispatch summary review
After all focused reviews and parallel analyses complete, dispatch a holistic summary review:

```
task(subagent_type="inspector", prompt="review_mode=summary Perform holistic code review summary. Read ALL .matrix/data/review-records/*.json files. Verify completeness (record count, sub-item coverage, MISMATCH-to-Defect mapping). Perform runtime safety defect analysis (cross-function buffer overflow, concurrency, etc.). Check cross-requirement consistency. Merge all defects with sequential IDs (DEF-CR-001, ...). Output final defects to .matrix/data/defects.json and report to .matrix/reports/code-review.md.")
```
```

**Note**: The exact edit will depend on how the prompt string is structured in the source. The conductor's prompt is a template string — modify the Phase 3 section within that string to add the new Step 4 and renumber Steps 4→5 and 5→6.

**Step 3: Also update the delegation_rules section**

Find the delegation_rules line that mentions Phase 3 (approximately line 241):

```
4. For Phase 3, dispatch N per-requirement Inspector focused reviews + static-analyzer in PARALLEL (all use run_in_background=true). After all complete, dispatch one Inspector summary review.
```

Change to:

```
4. For Phase 3, dispatch N per-requirement Inspector focused reviews + static-analyzer + isr-reviewer in PARALLEL (all use run_in_background=true). After all complete, dispatch one Inspector summary review.
```

**Step 4: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

**Step 5: Commit**

```bash
git add src/agents/conductor.ts
git commit -m "feat(conductor): add isr-reviewer parallel dispatch to Phase 3"
```

---

### Task 8: Add Slash Command (Optional)

**Files:**
- Modify: `src/create-skills.ts:139-141`

**Step 1: Add /matrix-isr-review command**

Before the closing `} as const` (line 140), add:

```typescript
    "matrix-isr-review": {
      description: "Audit interrupt data access conflicts (C1-C5 patterns)",
      agent: "isr-reviewer",
      subtask: true,
      template: [
        "Execute an interrupt data access conflict audit on the current project.",
        "Read the compilation environment from .matrix/data/compilation-env.json.",
        "Read the software analysis from .matrix/data/software-analysis.json.",
        "Discover ISR entry points, build shared variable graph,",
        "identify protection primitives, and analyze each shared variable",
        "for C1-C5 conflict patterns.",
        "Output defects to .matrix/data/defects.json and report to .matrix/reports/interrupt-review.md.",
      ].join("\n"),
    },
```

**Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add src/create-skills.ts
git commit -m "feat(commands): add /matrix-isr-review slash command"
```

---

### Task 9: Update CLAUDE.md Documentation

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Update agent count and add isr-reviewer**

Make the following changes throughout CLAUDE.md:

1. In the **Project Overview** section, change `15 specialized agents` to `16 specialized agents` and `9 slash commands` to `10 slash commands`.

2. In the **Agent System** section under **Quality**, after the `reviewer.ts` entry, add:
   ```
   `isr-reviewer.ts` (interrupt data access conflict audit)
   ```

3. In the **9-Phase Workflow** section, update Phase 3:
   ```
   Phase 3: Code Review & Static   → Inspector + StaticAnalyzer + ISR-Reviewer (parallel)
   ```

4. In the **Skill System** table, add a row:
   ```
   | `interrupt-review` | 3 | Interrupt data access conflict audit (C1-C5 patterns) |
   ```

5. In the **Command System** table, add a row:
   ```
   | `/matrix-isr-review` | isr-reviewer | Audit interrupt data access conflicts (C1-C5) |
   ```

6. In the **Report paths**, add:
   ```
   INTERRUPT_REVIEW: `.matrix/reports/interrupt-review.md`
   ```

**Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for isr-reviewer agent (16 agents, 10 commands)"
```

---

### Task 10: Final Verification

**Step 1: Run typecheck**

Run: `bun run typecheck`
Expected: PASS with no errors.

**Step 2: Run build**

Run: `bun run build`
Expected: Build completes successfully, `dist/index.js` produced.

**Step 3: Run tests**

Run: `bun test`
Expected: All existing tests still pass.

**Step 4: Verify file structure**

Verify these files exist:
- `src/agents/isr-reviewer.ts`
- `skills/interrupt-review/SKILL.md`
- `templates/interrupt-review.md`

**Step 5: Final commit (if any uncommitted changes remain)**

```bash
git status
# If clean, no action needed. If changes remain, commit them.
```
