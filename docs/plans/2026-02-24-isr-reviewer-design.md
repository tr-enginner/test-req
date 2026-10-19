# ISR-Reviewer Agent Design

**Date**: 2026-02-24
**Status**: Approved

## Overview

新增 `isr-reviewer` 智能体，专项审查中断数据访问冲突。作为 Phase 3 的独立并行智能体，与 Inspector 和 StaticAnalyzer 同时调度。

## Agent Metadata

| Field | Value |
|-------|-------|
| Name | `isr-reviewer` |
| Category | `quality` |
| Mode | `subagent` |
| Cost | `EXPENSIVE` |
| Skill | `interrupt-review` |
| Triggers | 中断/ISR数据访问冲突审查；共享变量原子性与同步性分析；多步骤变量访问保护验证 |

## Phase 3 Dispatch (Updated)

```
Step 1: Read software-analysis.json → identify requirements and linked functions
Step 2: Dispatch N parallel Inspector focused reviews (run_in_background=true)
Step 3: Dispatch StaticAnalyzer (run_in_background=true)
Step 4: Dispatch ISR-Reviewer (run_in_background=true)  ← NEW
Step 5: Wait for Step 2 + 3 + 4 to complete
Step 6: Dispatch Inspector summary review (sequential, merges all defect sources)
```

## Five Conflict Patterns (C1-C5)

### C1: Atomic Variable Desynchronization

- **Definition**: A single variable's access compiles to multiple instructions (wider than processor word), ISR preemption mid-access yields a half-updated value.
- **Detection**: Variable type width vs processor word size (inferred from `target_cpu`). Check for interrupt disable protection wrapping the access.
- **Example**: `uint32_t` on 8/16-bit MCU read/written without interrupt protection.

### C2: Array Multi-Step Access

- **Definition**: An array's elements are read/written across multiple source-level steps (e.g., loop iteration, element-by-element copy). ISR preemption between steps causes inter-element inconsistency.
- **Detection**: Identify loop-based or sequential multi-element array operations on shared arrays. Check if the entire sequence is protected.
- **Example**: Main loop copies sensor buffer element-by-element while ISR updates same buffer.

### C3: Super-Word-Length Variable Compilation Split

- **Definition**: Variable width exceeds processor word length; compiler splits access into multiple load/store instructions. ISR preemption between instructions causes intra-variable inconsistency.
- **Detection**: Type width analysis against processor word size. Distinct from C1 in that C3 focuses on compiler-level splitting invisible at source level.
- **Example**: `float`/`double` on 8-bit MCU; `uint64_t` on 32-bit MCU.

### C4: Correlated Variable Group Desynchronization

- **Definition**: Multiple logically-related but independent variables updated in separate source statements. ISR preemption between updates breaks semantic consistency.
- **Detection**: LLM semantic analysis to identify variable groups with logical correlation. Check if group update is atomically protected.
- **Example**: `temperature` and `temperature_valid` flag; `position_x` and `position_y` updated separately.

### C5: Multi-Step Operation Window (RMW)

- **Definition**: Read-modify-write or compare-and-swap sequences where ISR preemption between steps causes lost update or stale comparison.
- **Detection**: Identify RMW patterns (`counter++`, `flags |= MASK`, `if(x) x=...`). Check for critical section protection.
- **Example**: `counter++` compiles to load-add-store; ISR increments same counter between load and store.

## Protection Mechanism Discovery

**Dynamic, not hardcoded.** The agent discovers protection primitives based on the actual project:

1. **From compilation environment**: Read `compilation-env.json` → `compiler_dialect` + `target_cpu` → LLM infers platform-specific interrupt primitives based on its knowledge of that platform.
2. **From project code**: Use ast-grep to search macro definitions and inline functions → discover project-custom critical section wrappers (no preset names).
3. **From Code Wiki**: If Phase 1b wiki exists, read interrupt-related utility function annotations.
4. **LLM synthesis**: Build a "protection primitive inventory" for the current project, then use it for all subsequent protection adequacy analysis.

### Key Judgment Rules

1. **volatile ≠ safe**: `volatile` prevents compiler optimization but does NOT guarantee multi-instruction atomicity. C1/C3 variables with volatile but no interrupt protection are still unsafe if wider than word size.
2. **Word size inference**: Derive from `target_cpu` config or compilation environment (8/16/32/64-bit).
3. **Protection completeness**: Interrupt disable must wrap the ENTIRE multi-step sequence, not just partial steps.
4. **Correlated variable identification**: C4 requires LLM semantic understanding; ast-grep alone cannot determine logical correlation.

## Six-Step Workflow

### Step 1: Load Context

- Load `interrupt-review` skill via `skill` tool
- Read `compilation-env.json` → `compiler_dialect`, `target_cpu`
- Read `software-analysis.json` → function list, requirement mapping
- Read code wiki (if exists) → function semantic summaries
- Infer processor word size (8/16/32/64 bit)

### Step 2: ISR Entry Discovery

- ast-grep: search interrupt vector attributes/keywords (dynamic based on compilation environment)
- ast-grep: search callback registration patterns
- Output: ISR function list + variable access sets per ISR

### Step 3: Shared Variable Graph Construction

- Cross-reference: ISR write set ∩ non-ISR read/write set → shared variable candidates
- For each candidate, analyze:
  - Type and width vs processor word size → C1/C3 risk
  - Array with multi-element traversal → C2 risk
  - Semantic correlation with other variables → C4 risk
  - RMW operation patterns → C5 risk
- Output: Shared variable graph (variable → type → risk category → ISR side → non-ISR side)

### Step 4: Protection Primitive Discovery

- Based on `compiler_dialect` + `target_cpu`, LLM infers platform primitives
- ast-grep: search project macro definitions/inline functions → discover custom wrappers
- Read code wiki for interrupt-related utility functions
- Output: Protection primitive inventory (name → type → protection scope)

### Step 5: Per-Variable Conflict Analysis

For each risk variable in the shared variable graph:
- Read source code at access points (ISR side + non-ISR side)
- Check if protection primitives wrap the complete access sequence
- Apply C1-C5 rules:
  - No protection → Defect
  - Incomplete protection (only partial steps wrapped) → Defect
  - volatile but no interrupt disable and super-word-length → Defect
  - Adequate protection → SAFE, record protection method
- Output: Conflict verdict list

### Step 6: Output

- Write defects to `.matrix/data/defects.json` (source=`interrupt_review`, category=`interrupt_conflict`)
- Generate `.matrix/reports/interrupt-review.md`

## Tools Used

| Tool | Purpose |
|------|---------|
| `skill` | Load interrupt-review skill methodology |
| `astgrep_run` | ISR entry discovery, shared variable access point location, protection primitive search |
| `code_parser` | Function signatures and variable type analysis |
| `read/glob/grep` | Read source code, config files, wiki data |
| `write` | Write defects.json and report |

## Defect Model Integration

### Schema Extensions

```typescript
// Defect.source enum: add "interrupt_review"
// Defect.category enum: add "interrupt_conflict"
```

### ID Convention

```
DEF-IR-001, DEF-IR-002, ...
```

### Severity Mapping

| Pattern | No Protection | Incomplete Protection |
|---------|--------------|----------------------|
| C1 Atomic (super-word) | critical | major |
| C2 Array multi-step | critical | major |
| C3 Compilation split | critical | major |
| C4 Correlated group | major | major |
| C5 RMW operation | critical | major |

volatile-only on super-word-length variable: at least major.

### Inspector Summary Integration

Inspector summary mode already merges defects from all sources. ISR-Reviewer writes its defects before Inspector summary runs. No additional merge logic needed.

## Report Format

```markdown
# 中断数据访问冲突审查报告

## 1. 审查环境
- 目标处理器 / 处理器字长 / 编译器 / 发现的保护原语

## 2. 共享变量图谱
| 变量 | 类型 | 宽度 | ISR端 | 非ISR端 | 风险类别 | 保护状态 |

## 3. 冲突分析详情
### DEF-IR-NNN: {title}
- 冲突模式 / 变量 / 处理器字长 / ISR端 / 非ISR端 / 保护 / 风险 / 建议

## 4. 统计摘要
## 5. 保护建议
```

## Skill: `interrupt-review`

Path: `skills/interrupt-review/SKILL.md`

Contents:
1. Conflict pattern reference (C1-C5 with code examples, false positive avoidance)
2. Protection primitive dynamic discovery methodology
3. Analysis judgment rules (protection completeness criteria, volatile trap, severity mapping)
4. Report template and filling guidance
5. Common false positive scenarios (read-only variables, single-word-length atomic operations, compiler-guaranteed atomics)

## Files to Create/Modify

| File | Action | Content |
|------|--------|---------|
| `src/agents/isr-reviewer.ts` | **Create** | Agent factory + system prompt |
| `src/agents/builtin-agents.ts` | **Modify** | Register isr-reviewer |
| `src/agents/conductor.ts` | **Modify** | Phase 3 dispatch: add ISR-Reviewer parallel dispatch |
| `src/schema/defect.ts` | **Modify** | Add `interrupt_review` to source enum; add `interrupt_conflict` to category enum |
| `src/shared/constants.ts` | **Modify** | PHASE_AGENTS[3] add `isr-reviewer`; add artifact path constants |
| `skills/interrupt-review/SKILL.md` | **Create** | Interrupt conflict review methodology skill |
| `src/create-skills.ts` | **Optional** | Add `/matrix-isr-review` slash command |
| `templates/interrupt-review.md` | **Create** | Report template |
| `CLAUDE.md` | **Modify** | Update agent count (15→16), add to tables |

## No Changes Needed

- **Hook system**: Existing hooks (phase-gate, evidence-tracker, progress-tracker) already handle new agents
- **Tool system**: Reuses existing astgrep_run, code_parser, read/write/glob/grep — no new tools
- **Data store**: defects.json and report paths follow existing patterns
- **Inspector summary**: Already has "merge all source defects" logic, naturally compatible
