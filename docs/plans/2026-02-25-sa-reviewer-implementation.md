# SA-Reviewer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 新增 SA-Reviewer subagent，对 StaticAnalyzer 的原始违规输出进行三类分类审查（功能缺陷/规范违规/误报），替代原有的二元 FP 消除设计。

**Architecture:** StaticAnalyzer 改为输出 `sa-raw-findings.json`（原始违规），不再直接写 `defects.json`。SA-Reviewer 在 Phase 3 Step 5 与 Inspector Summary 并行运行，加载 `static-analysis-review` skill，对每条违规三类判定后，功能缺陷写 `defects.json`，误报写 `false-positives.json`，规范类仅入报告。

**Tech Stack:** TypeScript (strict), Bun runtime, Zod schema validation, OpenCode SDK AgentConfig

**设计文档:** `docs/plans/2026-02-25-sa-reviewer-design.md`

---

## Task 1: 新建 `SARawFinding` Zod Schema

**Files:**
- Create: `src/schema/sa-raw-findings.ts`
- Modify: `src/schema/index.ts`

**Step 1: 创建 schema 文件**

```typescript
// src/schema/sa-raw-findings.ts
import { z } from "zod"

/** 单条 SpecChecker 原始违规记录 */
export const SARawFinding = z.object({
  id: z.string(),                          // e.g. "RAW-001"
  rule_id: z.string(),                     // e.g. "CID181"
  rule_name: z.string(),                   // 规则名称
  severity: z.enum(["critical", "major", "minor", "suggestion"]),
  conformance: z.string().optional(),      // e.g. "mandatory" / "recommended"
  fixability: z.enum(["auto_fixable", "needs_review", "unfixable"]).optional(),
  file: z.string(),                        // 源文件路径
  line: z.number(),                        // 违规行号
  code_snippet: z.string().optional(),     // 违规代码片段
  patch: z.string().optional(),            // repair patch (仅 repair_enabled 时有值)
})
export type SARawFinding = z.infer<typeof SARawFinding>

/** SA 原始输出报告 */
export const SARawFindingsReport = z.object({
  project_name: z.string(),
  analysis_date: z.string(),              // ISO 8601
  tool: z.literal("specchecker"),
  source_dir: z.string(),
  summary: z.object({
    total: z.number(),
    by_severity: z.record(z.string(), z.number()),
    by_fixability: z.record(z.string(), z.number()),
  }),
  violations: z.array(SARawFinding),
})
export type SARawFindingsReport = z.infer<typeof SARawFindingsReport>
```

**Step 2: 在 `src/schema/index.ts` 添加导出**

在文件末尾添加：
```typescript
// SA Raw Findings
export { SARawFinding, SARawFindingsReport } from "./sa-raw-findings"
```

**Step 3: 类型检查验证**

```bash
bun run typecheck
```

期望输出：无错误。

**Step 4: Commit**

```bash
git add src/schema/sa-raw-findings.ts src/schema/index.ts
git commit -m "feat(schema): add SARawFinding and SARawFindingsReport Zod schemas"
```

---

## Task 2: 修改 StaticAnalyzer — 输出目标改为 `sa-raw-findings.json`

**Files:**
- Modify: `src/agents/static-analyzer.ts`

StaticAnalyzer 原先将违规写入 `defects.json`，现在改为写 `sa-raw-findings.json`，缺陷分类和 defects.json 写入逻辑移交 SA-Reviewer 处理。

**Step 1: 更新 STATIC_ANALYZER_SYSTEM_PROMPT 中的 Step 5 & Step 6 & Step 7**

找到 prompt 中的 `### Step 5: Classify & Record Findings` 至 `### Step 7: Generate Report` 部分，用以下内容替换：

```
### Step 5: Write Raw Findings
Write all violations (after optional repair steps) to `.matrix/data/sa-raw-findings.json`.

The output must include:
- `project_name`: extracted from config or directory name
- `analysis_date`: current ISO 8601 date string
- `tool`: "specchecker"
- `source_dir`: the analyzed source directory path
- `summary.total`: total violation count
- `summary.by_severity`: count per severity level
- `summary.by_fixability`: count per fixability class
- `violations`: array of every violation with fields:
  - `id`: "RAW-001", "RAW-002", ... (sequential)
  - `rule_id`: CID format (e.g. "CID181")
  - `rule_name`: human-readable rule name
  - `severity`: "critical" | "major" | "minor" | "suggestion"
  - `conformance`: "mandatory" | "recommended" (from SpecChecker output)
  - `fixability`: "auto_fixable" | "needs_review" | "unfixable"
  - `file`: source file path
  - `line`: violation line number
  - `code_snippet`: the violating code fragment
  - `patch`: repair patch string if repair was generated, otherwise null

DO NOT write to `.matrix/data/defects.json`. Defect classification is performed
by the SA-Reviewer agent in the next step.

### Step 6: Generate Raw Analysis Report
Write markdown report to `.matrix/reports/static-analysis.md` with:
- Analysis summary (total violations, by severity, by fixability)
- Violation table (rule_id | severity | file:line | code_snippet)
- Note: "Defect classification and false-positive analysis performed by SA-Reviewer"
- If repair was enabled: auto-repair results section
```

**Step 2: 更新 `output_format` 部分**

找到 `<output_format>` 块，修改描述：

```
Primary output: `.matrix/data/sa-raw-findings.json` — raw SpecChecker violations (SARawFindingsReport schema).
Secondary output: `.matrix/reports/static-analysis.md` — violation summary report.

NOTE: Do NOT write to defects.json. SA-Reviewer handles defect classification.

When responding to the orchestrator, provide:
- Total violations found and breakdown (by severity, by fixability)
- Number of repairs generated and verified (if repair enabled)
- Any tool errors or files that could not be analyzed
```

**Step 3: 更新 description 字段**

在 `createStaticAnalyzerAgent` 函数中，将 description 改为：

```typescript
description:
  "Runs SpecChecker aerospace C coding standard analysis (航天器C语言编程规范), classifies " +
  "violations by fixability (auto_fixable/needs_review/unfixable), optionally generates " +
  "automated repairs, and writes raw findings to .matrix/data/sa-raw-findings.json. " +
  "Defect classification is handled by SA-Reviewer. (StaticAnalyzer - Matrix)",
```

**Step 4: 类型检查**

```bash
bun run typecheck
```

期望：无错误。

**Step 5: Commit**

```bash
git add src/agents/static-analyzer.ts
git commit -m "feat(agents): static-analyzer outputs sa-raw-findings.json instead of defects.json"
```

---

## Task 3: 更新 `skills/static-analysis/SKILL.md`

**Files:**
- Modify: `skills/static-analysis/SKILL.md`

**Step 1: 更新 Analysis Workflow 的第 4 步和 Output 节**

将 `### 4. Finding Classification` 部分的 `### 6. Defect Recording` 和 `## Output` 节更新为：

```markdown
### 4. Finding Classification
Assign each violation a preliminary severity classification:
- **must-fix**: Critical safety issue or mandatory rule (conformance L001) violation
- **suggestion**: Advisory/recommended rule violation
- **waiver**: Justified violation with documented rationale

This classification is included in the raw findings output. Final defect determination
(functional defect / standards-only / false positive) is performed by SA-Reviewer.

### 5. Deviation Management (unchanged)
For rule violations that cannot be fixed:
- Generate deviation request with: rule ID (CID format), location, justification, risk assessment
- Cross-reference with any pre-approved waiver lists
- Flag violations without approved waivers for human review

## Output

- Write raw findings to `.matrix/data/sa-raw-findings.json` (SARawFindingsReport schema)
- Generate report at `.matrix/reports/static-analysis.md` with violation summary and deviation request list
- **Do NOT write to `.matrix/data/defects.json`** — SA-Reviewer handles defect classification

## Note

This agent runs **in parallel** with code-review (Phase 3).
SA-Reviewer runs after this agent completes, in parallel with Inspector Summary.
```

**Step 2: Commit**

```bash
git add skills/static-analysis/SKILL.md
git commit -m "docs(skills): update static-analysis skill to reflect sa-raw-findings.json output"
```

---

## Task 4: 创建 `skills/static-analysis-review/SKILL.md`

**Files:**
- Create: `skills/static-analysis-review/SKILL.md`

这是最大的单个任务。Skill 文件包含三类分类方法论和完整的 155 条不可判定规则列表（来自对 SpecChecker `所有内置规则.xml` 的系统分析）。

**Step 1: 创建目录和文件**

```bash
mkdir -p skills/static-analysis-review
```

**Step 2: 写入 Skill 文件**

文件内容分为以下章节（按顺序写入）：

```markdown
---
name: static-analysis-review
description: "Three-class classification of SpecChecker static analysis findings: functional defects (→ defects.json), standards-only violations (→ report only), and false positives (→ false-positives.json). Focuses on 141 undecidable rules as primary FP sources."
metadata:
  phase: "3"
  agent: "sa-reviewer"
  category: "quality"
---

## Role

You are a static analysis result reviewer. You classify SpecChecker violations from
`sa-raw-findings.json` into three categories, using undecidable rule knowledge and
source code context to identify false positives and distinguish functional defects
from standards-only violations.

## Three-Class Classification

| Category | Criterion | Output |
|----------|-----------|--------|
| **Functional Defect (功能缺陷)** | Violation would cause runtime error, incorrect output, data corruption, UB, or safety hazard | `defects.json` |
| **Standards-Only Violation (规范违规)** | Does not affect runtime behavior; affects only maintainability/readability | Report only |
| **False Positive (误报)** | Tool incorrectly flagged code that complies with rule intent | `false-positives.json` |

**Note:** Standards violations CAN be functional defects if they cause runtime errors
(e.g., a non-boolean condition in an if-statement that produces wrong logic). Always
check functional impact regardless of violation category label.

## Classification Workflow

### Phase 1: Check Undecidable Rule List
For each violation, check if its `rule_id` appears in the Undecidable Rule List below.

- **Not in list** (decidable rule): Tool determination is reliable. Classify as
  functional defect or standards-only based on the rule's semantic content.
  FP is very unlikely — do NOT speculatively mark as FP.

- **In list**: Proceed to Phase 2.

### Phase 2: Source Code Context Analysis
Read the violation's source file at `file:line` with ±15 lines context.

For **A2 (上下文意图依赖型)** and all other undecidable categories: Analyze context
carefully. Check the specific "context elements to examine" for that rule's subcategory.

For **A3 (偏向真实违规型)** rules: Default to functional defect or standards violation.
Only mark as FP with explicit documented evidence. These rules have very low FP rates
in safety-critical embedded software.

### Phase 3: Functional Impact Judgment

```
Is the violation on an executable path?
├── No (dead code, #if 0, unreachable branch) → FP candidate, confirm then mark FP
└── Yes → What is the runtime effect of this violation?
        ├── Causes wrong output / UB / crash / safety hazard → Functional Defect
        ├── No runtime difference → Standards-Only Violation
        └── Cannot determine → Conservative: retain as Functional Defect
```

## Conservative Principle

- When in doubt between Functional Defect and Standards-Only → retain as Functional Defect
- A3 rules: treat as Functional Defect by default; FP requires explicit documented proof
- mandatory conformance (L001) violations: do NOT mark as FP without clear exclusion evidence
- It is better to over-report a real defect than to suppress a genuine problem

---

## Undecidable Rule List (141 Rules)

Rules in this list are where SpecChecker commonly produces false positives because
accurate determination requires data flow, control flow, cross-translation-unit, or
semantic analysis that the tool cannot reliably perform.

Rules NOT in this list (decidable rules) should be treated as reliable tool findings.

---

### Category 1: 数据流分析型 (28 rules)
*Tool cannot reliably track variable initialization state, pointer origins, or memory
lifecycle across function boundaries.*

| CID | Rule Name | FP Typical Scenario |
|-----|-----------|---------------------|
| CID215 | 变量使用前必须赋值 | OUT参数方式赋值的变量被误报为未初始化 |
| CID4109 | 变量禁止未赋值就使用 | OUT参数方式赋值的变量被认为未初始化 |
| CID3142 | 禁止使用未初始化的自动变量 | 所有路径上都初始化但工具路径分析不完整导致误报 |
| CID3143 | 禁止使用未初始化的自动变量 | 所有路径上都初始化但工具路径分析不完整导致误报 |
| CID3144 | 不要读取未初始化的内存 | 所有路径上都初始化但工具路径分析不完整导致误报 |
| CID3145 | 禁止使用未初始化的自动变量 | 所有路径上都初始化但工具路径分析不完整导致误报 |
| CID184 | 禁止使用已被释放了的内存空间 | 指针释放后立即置NULL但工具未追踪到置NULL操作 |
| CID4170 | 禁止使用或释放未分配空间或已被释放的指针 | 指针在释放后立即置NULL但工具未追踪到置NULL操作 |
| CID4120 | 不要访问已释放的内存 | 指针释放后置NULL但后续分支基于NULL判断访问被误报 |
| CID4239 | 不要访问已经释放的内存 | 指针置NULL后的访问被工具误认为释放后访问 |
| CID092 | 禁止使用或释放未分配空间或已被释放的指针 | 通过封装函数释放的指针被工具认为仍未释放 |
| CID243 | 禁止引用空指针 | 已在if语句检查过非NULL但工具控制流未追踪到 |
| CID4220 | 不要对空指针进行解引用 | 条件分支保证指针非NULL后的解引用被工具误报 |
| CID4064 | 动态分配的指针变量第一次使用前必须进行是否为NULL的判别 | 在if语句中检查NULL后才使用的动态分配指针 |
| CID185 | 数组使用必须保证不会出现越界 | 下标经过范围检查后的合法数组访问被保守报告 |
| CID292 | memset()和memcpy()函数使用时缓冲区溢出 | 已按size限制的memset/memcpy调用被保守误报 |
| CID210 | memset()和memcpy()函数使用时缓冲区溢出 | 已按size限制的memset/memcpy调用被保守误报 |
| CID4108 | 缓存区写入操作禁止越界 | 已经过边界检查的写操作仍被保守报告 |
| CID4107 | 缓存区读取操作禁止越界 | 已知在边界内的读操作被保守报告 |
| CID1006 | 禁止string.h中的字符串操作函数的参数数组越界 | 有边界保护的字符串操作被保守报告 |
| CID4124 | 使用字符串赋值/拷贝/追加等函数时禁止目标字符串存储空间越界 | 已经过大小限制的字符串赋值函数被报告 |
| CID4164 | 动态申请的内存空间用完后及时释放 | 在函数返回前统一释放的合法模式被误认为未释放 |
| CID1010 | 必须显示释放标准库函数动态分配的资源 | 在错误处理路径中统一释放资源的goto-cleanup模式 |
| CID4248 | 只应释放动态分配的内存 | 自定义内存池（内部用malloc）分配的内存被认为非动态分配 |
| CID1020 | 禁止释放不是标准库申请的内存 | 自定义内存池分配的内存被认为不能用标准free |
| CID4122 | 被free的指针必须指向最初malloc/calloc分配的地址 | 通过中间指针释放但指向同一块内存起始地址的情况 |
| CID4062 | 指针变量被释放后必须置为NULL | 函数末尾释放的指针没有置NULL（函数返回后无影响） |
| CID4058 | 动态分配的指针变量定义时如未被分配空间必须初始化为NULL | 动态分配指针在声明后立即进行分配时被要求初始为NULL |

---

### Category 2: 值域/运行时分析型 (33 rules)
*Tool cannot determine actual value ranges at runtime.*

| CID | Rule Name | FP Typical Scenario |
|-----|-----------|---------------------|
| CID086 | 整数溢出 | 有意的模运算（利用整数溢出回绕的算法）被误报 |
| CID1109 | 无符号整型做乘100/1000/10000等运算可能会发生运算溢出 | 已知操作结果在范围内但工具保守报告 |
| CID1101 | if条件中的加法运算可能导致运算溢出 | 已知操作结果在范围内但工具保守报告 |
| CID744 | &&/\|\|操作的区间判断为恒真或恒假 | 依赖平台ABI保证的值域在工具无平台知识时被误报 |
| CID1059 | 在判断变量值范围之前给变量赋了范围内的值导致判断恒为真 | 防御性赋值后检查是有意的保守编程风格 |
| CID1060 | 在判断变量值范围之前给变量赋了范围外的值导致判断恒为假 | 防御性赋值后检查是有意的保守编程风格 |
| CID1073 | if(x==c)语句恒为假 | 依赖输入范围保证的比较在工具无输入信息时被误报 |
| CID1063 | 逻辑或操作导致if条件恒为真 | 互斥条件的或运算实际不恒真但工具无法证明 |
| CID897 | 高位清零后计数加1再与0比较导致逻辑判断恒为假 | 多步运算中间结果比较被误认为最终恒假 |
| CID1100 | 变量与255比较又在分支内清零取值范围可能有误 | uint8_t类型的合法边界检查逻辑 |
| CID218 | 避免对无符号数进行大于等于零或小于零的比较 | 通过typedef定义的类型实际是unsigned但名称不明显 |
| CID866 | 将无符号数与负数进行比较时应该进行正确性验证 | 有意的类型转换后比较在语义上正确但触发规则 |
| CID4079 | 除法运算中禁止被零除 | 已在if语句检查过非零但工具未追踪到该检查 |
| CID4251 | 确保除法和余数运算不会导致被零除错误 | 已在if语句检查过非零但工具未追踪到该检查 |
| CID087 | 禁止signed和unsigned之间隐式转换 | 已知非负的有符号整数赋给无符号整数的合法转换 |
| CID1105 | 位长小的有符号整型被强转为大的无符号整型可能导致负数变为无符号大数 | 已知位长小的有符号数非负时的合法转换被报告 |
| CID031 | 将double类型数转为float类型 | 明知精度足够的double到float赋值被标记 |
| CID1098 | 位运算导致符号位发生变化 | 有意操作符号位的位域处理代码 |
| CID4249 | 将整数值转换为浮点类型时保持精度 | 已知在目标类型范围内的转换被保守报告 |
| CID4256 | 确保整数转换不会导致数据丢失或解释错误 | 已知在目标类型范围内的转换被保守报告 |
| CID883 | 将负的double类型赋值给无符号整型可能赋值异常 | 已知double值为正数但类型声明为double时触发规则 |
| CID989 | 在判断两数差值范围时用两数互相相减必然出现大数减小数 | 上方已保证a>=b再做a-b的有效差值运算 |
| CID297 | 谨慎对两个无符号整型进行减法运算 | 上方已保证a>=b再做a-b的有效差值运算 |
| CID755 | 地址范围判断缺陷 | 通过分段检查上下界的合法地址范围验证 |
| CID1125 | 地址判断错误 | 平台特定地址判断方式被工具误认为错误 |
| CID985 | 用于拼接的或运算操作数的位之间不应相互覆盖 | 有意对相同位域多次操作的合法位域合并 |
| CID991 | 或运算的位互相覆盖 | 有意对相同位域多次操作的合法位域合并 |
| CID1057 | 变量的差值运算错误 | 有意的差值运算结果用于特定计算 |
| CID986 | 浮点数判0缺陷 | 与0.0比较的合法浮点检查（如判断是否为精确0） |
| CID4250 | 确保可变长度数组的大小参数在有效范围内 | 运行时已验证有效范围的VLA大小参数 |
| CID997 | 变量&操作溢出 | 位掩码操作的合法&运算被认为可能溢出 |
| CID998 | 左移运算后将小的无符号数据类型强转为大的有符号数据类型可能导致负数变为正数 | 有意操作有符号位时的合法位运算 |
| CID1096 | 指针被强制转换为较短类型 | 指针转换为uintptr_t等安全的整数表示 |

---

### Category 3: 主观判断型 (26 rules)

#### A2 — 上下文意图依赖型 (19 rules)
**判断指导**: 必须读违规行前后至少 15 行代码，理解设计模式和数据语义后逐条判断。不可批量豁免。

| CID | Rule Name | Context Elements to Examine |
|-----|-----------|----------------------------|
| CID6676 | 谨慎使用无法控制的循环条件 | 循环条件变量来源（硬件状态寄存器 vs 外部输入）；是否在ISR中（ISR中几乎必然违规）；是否有看门狗最终保护 |
| CID4132 | 谨慎使用abort/exit函数 | 调用是否在不可恢复的致命错误路径；系统是否有软重启机制 `NVIC_SystemReset` 作为等价替代 |
| CID006 | 谨慎对指针进行代数运算 | 是否基于已知固定大小的数组；偏移量是否有边界检查或由常量保证安全；是否在DMA描述符/内存映射IO场景 |
| CID103 | 谨慎使用指针的逻辑比较 | 比较的两个指针是否指向同一对象/数组（合法）还是不相关对象（UB）；是否仅做NULL检查（完全合法） |
| CID279 | 谨慎使用八进制数 | 八进制字面量是否在文件权限/ASCII码等明确语义场景；还是普通整数中的意外八进制（真实bug风险） |
| CID004 | 谨慎使用++/--操作符 | 是否在复合表达式的同一求值序列中出现多次（如 `a[i++]=b[i++]`，真实UB）；还是独立语句或for步进（完全合法） |
| CID252 | 尽量避免用+=或-=操作符 | 是否用于累加器/计数器增量（`buf_len += chunk_size`，语义明确合理）；还是在复杂表达式中使求值顺序模糊 |
| CID186 | 尽量避免使用三元运算符 | 是否简单清晰（`x=(a>b)?a:b`，等价min/max，完全合法）；还是多层嵌套（真实可读性问题） |
| CID175 | 尽量避免使用continue | 是否用于跳过不满足条件的循环迭代（滤波逻辑惯用法）；循环体是否短小（短循环体中的continue通常无害） |
| CID240 | 尽量避免使用逗号操作符 | 逗号是否在for循环初始化/步进中（`for(i=0,j=0;...;i++,j++)`，公认合理）；还是在普通表达式语句中 |
| CID212 | 谨慎使用不同类型变量的混合运算 | 是否涉及有符号/无符号混合（嵌入式中常见真实bug风险）；是否有显式类型转换表明开发者已知类型差异 |
| CID226 | 谨慎将double型数转换成float型数 | 精度损失是否被有意接受（嵌入式FPU通常只有单精度）；字面量是否带 `f` 后缀（`1.0f` 是有意的float） |
| CID054 | 避免使用不必要的类型转换 | 类型转换是否是消除编译器隐式转换警告的显式注解（有意为之）；还是掩盖实际类型不匹配（绕过类型检查） |
| CID270 | 尽量避免逻辑判别的表达式不是逻辑表达式 | `if(ptr)` 和 `if(!ptr)` 是NULL检查的C惯用法（合理）；整型条件 `if(some_int)` 需检查变量名是否表达了布尔意图 |
| CID234 | 避免无用的多余变量 | 变量是否为调试辅助（`#ifdef DEBUG`）；是否为提高可读性的命名中间量；需确认是否真正"无用"还是被工具漏检 |
| CID228 | 避免函数参数在函数调用中未被使用 | 参数是否为回调接口强制签名（如RTOS任务 `void task(void *pvParam)` 中pvParam未用但签名固定）；是否为多态接口占位参数 |
| CID4139 | 谨慎做整型量除以整型变量的除法 | 除数是否可能为零（需检查是否有除零保护）；结果是否为有意的整数截断（地址对齐计算 `addr/PAGE_SIZE`） |
| CID107 | 谨慎使用联合的声明 | 是否在函数局部作用域声明union（规避类型系统，嵌入式安全标准保守）；还是在全局/结构体中的合法union成员 |
| CID279 | 谨慎使用八进制数 | 见上（已列） |

#### A3 — 偏向真实违规型 (7 rules)
**判断指导**: 即使措辞含"谨慎/避免"，在嵌入式安全关键场景下默认为真实违规。豁免需走偏差申请。

| CID | Rule Name | Why FP Rate Is Low in Safety-Critical Embedded |
|-----|-----------|------------------------------------------------|
| CID190 | 避免使用不加以分析的注释（注释掉的代码） | GJB 5000A明确禁止将代码注释掉，被注释代码是维护风险；合法注释（说明性文字）不触发此规则 |
| CID287 | 尽量不对实数类型做是否相等的比较 | 浮点相等比较在嵌入式FPU场景几乎必然产生意外结果；DO-178C/IEC 61508将其列为危险构造；合法替代是epsilon比较 |
| CID013 | 应避免声明了函数/变量/常量但未使用 | 未使用的局部变量通常是清理不彻底的遗留代码；接口兼容性保留应改用 `(void)param` 注解 |
| CID034 | 避免声明了类型但未使用 | 未使用的类型定义通常表明头文件依赖链混乱；公共头文件中的类型可走B1（跨文件视图局限）豁免路径 |
| CID194 | 有符号类型的位长度必须不小于两位 | 1位有符号位域只能存 `-1` 和 `0`，几乎所有开发者期望存 `0` 和 `1`，是真实语义陷阱 |
| CID013 | （同上） | — |

---

### Category 4: 意图理解型 (22 rules)
*Tool cannot understand business logic intent or design purpose.*

| CID | Rule Name | FP Typical Scenario |
|-----|-----------|---------------------|
| CID949 | 函数定义中不应该存在没有使用的参数 | 接口兼容性保留参数、回调函数未使用的参数（签名固定） |
| CID1147 | 标志变量仅置有效或仅置无效 | 一次性标志（初始化完成标志）只需置位的合法设计 |
| CID843 | 标识变量状态清理不及时可能导致中断设置的最新标识状态被覆盖 | 合理的延迟清理状态标志被误认为设计缺陷 |
| CID761 | 全局变量仅累加未清零 | 单调递增计数器被误报为只累加未清零 |
| CID893 | 全局变量仅累加未清零可能导致结果跳变 | 单调递增计数器被误报为只累加未清零 |
| CID758 | 全局变量只有写操作 | 通过硬件寄存器或DMA访问的只写全局变量 |
| CID757 | 全局变量只有读操作 | 通过硬件寄存器或DMA访问的只读全局变量 |
| CID845 | if/else分支前对变量的赋值被if-else块中的赋值操作覆盖 | 先设置默认值再按条件覆盖的合法防御性编程模式 |
| CID846 | if/else分支中对变量的赋值被if/else块后的赋值操作覆盖 | 先设置默认值再按条件覆盖的合法防御性编程模式 |
| CID108 | 避免当switch语句的表达式是枚举类型时缺少case分支 | 有意不处理某些枚举值（仅处理关心的状态）时被误报 |
| CID1049 | 确认多个if与一个else的结构是否设计有误 | 有意的if-if-else结构（只有最后一个if有else） |
| CID848 | 在多重判断中变量的取值范围设计不连续 | 故意跳过某些枚举值的状态机设计 |
| CID888 | 谨慎在循环中赋值的变量在循环外使用可能是逻辑设计缺陷 | 有意使用循环结束后index值（如查找位置）的合法模式 |
| CID895 | 函数只有一个固定返回值 | 有意返回固定状态码的状态判断函数 |
| CID753 | 函数有多个返回语句但返回值固定为1/true或0/false | 有意返回固定状态码的状态判断函数 |
| CID1067 | 累加变量在当前分支中未进行清零可能导致分支重复执行 | 跨分支累积值的有意设计 |
| CID1054 | 全局计数变量设计不当变量进行清零时会影响当前运算 | 受保护的计数器清零操作被误认为影响并发计算 |
| CID1055 | 接收了函数的返回值后没有处理 | 有意忽略printf等函数的返回值 |
| CID956 | 函数的返回值必须被使用 | 有意忽略printf等函数的返回值 |
| CID4245 | 应该侦测和处理标准库产生的错误 | 在已知不会失败的条件下调用库函数被要求检查错误 |
| CID3218 | 如果一个函数产生错误信息则应测试该错误信息 | 已知函数在当前上下文不会产生错误时被要求检查 |
| CID760 | 全局变量赋值和条件判断设计不匹配（变量未赋过值） | 通过回调或函数指针赋值的全局变量被认为未赋过值 |

---

### Category 5: 控制流分析型 (9 rules)
*Tool cannot reliably determine code reachability or enumerate all paths.*

| CID | Rule Name | FP Typical Scenario |
|-----|-----------|---------------------|
| CID024 | 禁止不可达语句 | 平台相关宏条件展开后实际可达的代码被误判为不可达 |
| CID267 | 禁止不可达分支 | 依赖运行时输入的条件分支被保守认定为不可达 |
| CID1021 | 工程中不应该含有不可达代码 | 防御性代码（错误处理逃生门）被工具认为不可达 |
| CID4171 | 工程中不应该含有不可达代码 | 防御性代码（错误处理逃生门）被工具认为不可达 |
| CID1022 | 禁止出现死代码 | 条件编译的非活动分支被误判为死代码 |
| CID145 | 避免由于设计原因导致某些代码不能执行 | 防御性断言代码（不期望到达但存在安全网）被认为不可执行 |
| CID857 | 非条件控制的break/continue/return/goto语句出现在循环内 | if语句内的break/return被工具误识别为无条件跳转 |
| CID144 | 非void类型的函数必须有返回语句 | 通过assert(false)等方式确保不到达的路径仍被要求return |
| CID001 | 有返回值的函数中return必须带有返回值 | 通过longjmp等特殊控制流跳过的return路径 |

---

### Category 6: 语义分析型 (17 rules)
*Tool cannot determine side effects, volatile necessity, or concurrency semantics.*

| CID | Rule Name | FP Typical Scenario |
|-----|-----------|---------------------|
| CID3075 | 逻辑表达式&&或\|\|的右操作数不应含有副作用 | 右操作数调用纯函数（无副作用）但工具保守判定为违规 |
| CID3016 | 不要依赖于副作用的计算顺序 | 实际代码逻辑不依赖顺序但表达式形式触发规则 |
| CID1040 | 一个表达式的值在标准所允许的任意计算顺序下都应该是相同的 | 实际不依赖顺序的表达式因形式触发规则 |
| CID726 | 避免在存在++或--的表达式中使用其它有副作用的语句 | 包含函数调用的表达式被保守认定为有副作用 |
| CID3074 | 禁止在sizeof操作中使用有副作用的语句 | 调用纯函数的sizeof表达式被保守认定为有副作用 |
| CID4202 | 不要依赖sizeof/_Alignof/_Generic操作符的副作用 | sizeof参数包含函数调用但实际无副作用时被报告 |
| CID727 | 避免使用赋值表达式作为其他运算的数值 | while((c=getchar())!=EOF)这类惯用法被误报 |
| CID876 | 在邻近操作中针对同一变量的非顺序修改可导致未定义的行为 | 在不同语句中修改同一变量但不违反序列点规则时被误报 |
| CID4209 | 在信号处理函数中不应使用共享对象 | 使用信号安全的原子操作访问共享对象时被误报 |
| CID4200 | 在中断信号处理函数中不应该调用signal() | 在正确保护下重设信号处理函数的合法用法 |
| CID4208 | 在信号处理函数中只能调用同步安全的函数 | 自定义的信号安全函数被认为不安全 |
| CID4204 | 不要从计算异常信号处理函数中返回 | 某些平台上从SIGFPE返回是有意义的 |
| CID4112 | 程序外部可改写的变量必须使用volatile类型说明 | 非volatile的全局变量在单线程环境中被误要求加volatile |
| CID173 | 对于无法缓存的数据建议使用volatile关键字 | 非volatile的全局变量在单线程环境中被误要求加volatile |
| CID4206 | 不要通过非易失性引用访问易失性对象 | 受保护代码段内的多次volatile访问 |
| CID4113 | 禁止在表达式中出现多个同一volatile类型变量的运算 | 受保护代码段内的多次volatile访问 |
| CID6672 | 禁止在复杂表达式中使用volatile类型的变量 | 受保护代码段内的多次volatile访问 |

---

### Category 7: 跨翻译单元型 (7 rules)

#### B2 — 跨函数调用链型 (5 rules)
**判断指导**: 工具无法追踪跨函数边界的配对关系或指针生命周期。需手动追踪完整调用链，判断配对是否存在。

| CID | Rule Name | FP Scenario |
|-----|-----------|-------------|
| CID1144 | lock和unlock函数不匹配 | 获锁在函数A，解锁在函数B（A调用B或在同一控制流路径上），工具在A的路径内找不到对应unlock |
| CID069 | 禁止返回指向局部变量的指针 | 函数返回指向 `static` 局部变量的指针（static变量生命周期是整个程序运行期，返回其地址合法） |
| CID3164 | 禁止将局部变量地址做为函数返回值返回 | 同CID069 |
| CID1019 | 不应将自动存储的变量地址赋值给另一个在其消失后还存在的对象 | 局部变量地址赋给外层指针但在局部变量所在函数返回之前即使用完毕（合法的短期指针传递） |
| CID3159 | 应检查从外部资源接收值的有效性 | 调用方G在调用函数F之前已对参数做充分验证，F内部省略重复验证，工具无法追踪G中的验证逻辑 |

#### B3 — 运行时环境依赖型 (2 rules)
**判断指导**: 先确认项目运行时模型（查阅 `.matrix/config/matrix.jsonc` 和软件分析结果）。
单线程裸机环境下这两条规则几乎必然产生 FP。

| CID | Rule Name | FP Scenario |
|-----|-----------|-------------|
| CID4255 | 格式化字符串不能包含用户输入 | 嵌入式系统"用户输入"往往是受控的串口命令/遥控指令，经协议解析后已强类型约束，工具无法识别中间验证步骤 |
| CID4222 | 在访问文件时避免TOCTOU资源竞争情况 | TOCTOU前提是存在并发；裸机单任务环境或关中断/互斥保护下的文件访问不存在TOCTOU风险 |

---

## Output Format

### `defects.json` entry (functional defects only)
```json
{
  "id": "SA-0001",
  "source": "static_analysis",
  "severity": "major",
  "category": "coding_standard",
  "location": { "file_path": "src/main.c", "line_start": 47 },
  "title": "CID181: goto导致控制流跳过资源释放",
  "description": "违规行 goto error2 跳过了 mutex_unlock(&lock) 调用，导致互斥锁未释放。在当前业务逻辑中mutex在error2路径上不应跳过。",
  "rule_id": "CID181",
  "related_requirement_ids": [],
  "status": "open",
  "detected_by": "sa-reviewer",
  "detected_date": "2026-02-25"
}
```

### `false-positives.json`
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
      "undecidable_category": "A1",
      "file": "src/driver/uart.c",
      "line": 47,
      "reason": "goto用于多资源初始化失败后的统一cleanup跳转，是嵌入式驱动层的公认惯用法"
    }
  ],
  "standards_only": [
    {
      "raw_finding_id": "RAW-012",
      "rule_id": "CID293",
      "file": "src/algo/filter.c",
      "line": 0,
      "reason": "注释率低于阈值但代码命名清晰，不影响功能"
    }
  ]
}
```

### `reports/static-analysis-review.md` sections
1. **分类汇总表**: 总违规数 / 功能缺陷 / 规范违规 / 误报
2. **功能缺陷列表**: 写入defects.json的条目（rule_id | 文件:行 | 标题 | 严重级别）
3. **误报列表**: rule_id | 文件:行 | 误报类别 | 判定理由
4. **规范违规列表**: rule_id | 文件:行 | 描述（仅记录，不跟踪）
```

**Step 3: Commit**

```bash
git add skills/static-analysis-review/SKILL.md
git commit -m "feat(skills): add static-analysis-review skill with 141 undecidable rules taxonomy"
```

---

## Task 5: 创建 SA-Reviewer Agent

**Files:**
- Create: `src/agents/sa-reviewer.ts`

参考 `src/agents/isr-reviewer.ts` 的结构（同为 Phase 3 subagent，使用 skill 工具）。

**Step 1: 创建 agent 文件**

```typescript
// src/agents/sa-reviewer.ts
import type { AgentConfig } from "@opencode-ai/sdk"
import type { AgentMode, AgentPromptMetadata } from "./types"

const MODE: AgentMode = "subagent"

export const SA_REVIEWER_PROMPT_METADATA: AgentPromptMetadata = {
  category: "quality",
  cost: "EXPENSIVE",
  promptAlias: "SAReviewer",
  triggers: [
    {
      domain: "Static analysis result classification",
      trigger:
        "SA-raw-findings.json exists — classify SpecChecker violations into functional defects, standards-only violations, and false positives",
    },
    {
      domain: "False positive identification",
      trigger:
        "Undecidable rule violations requiring source context analysis to determine true/false positive status",
    },
  ],
  useWhen: [
    "Phase 3 — after StaticAnalyzer completes — classify sa-raw-findings.json",
    "Three-class classification: functional defects → defects.json, FP → false-positives.json, standards-only → report",
    "Identifying false positives in undecidable SpecChecker rules (A1/A2/B1/B2/B3 categories)",
  ],
  avoidWhen: [
    "StaticAnalyzer has not completed (sa-raw-findings.json does not exist)",
    "Performing static analysis itself (use static-analyzer)",
    "Code review quality gate (use cr-reviewer)",
  ],
}

const SA_REVIEWER_SYSTEM_PROMPT = `You are the **SA-Reviewer**, a specialized subagent in the Matrix embedded software testing system. Your sole responsibility is classifying SpecChecker static analysis findings from \`sa-raw-findings.json\` into three categories: functional defects, standards-only violations, and false positives.

<role>
You do NOT run static analysis tools. You receive raw SpecChecker violations and apply expert judgment — guided by the \`static-analysis-review\` skill — to determine:
1. Which violations represent genuine functional defects (→ defects.json)
2. Which are standards-only violations with no functional impact (→ report only)
3. Which are false positives from tool limitations (→ false-positives.json)
</role>

<workflow>
### Step 1: Load Skill and Context
1. Load the \`static-analysis-review\` skill: \`skill static-analysis-review\`
   This provides the complete classification methodology, undecidable rule list (141 rules
   in 7 categories A2/A3/B2/B3 plus data-flow/value-range/intent/control-flow/semantic types),
   functional impact decision tree, and conservative principle.
2. Read \`.matrix/data/sa-raw-findings.json\` — the raw SpecChecker violations list.
3. Optionally read \`.matrix/data/software-analysis.json\` for project context (module structure,
   requirements). Use it to understand the business domain when judging functional impact.
4. Read \`.matrix/config/matrix.jsonc\` — check for RTOS usage, target_cpu (for B3 rules),
   and project context.

### Step 2: Classify Each Violation
For each violation in \`sa-raw-findings.json\`:

1. **Phase 1: Undecidable Rule Check**
   - Is the rule_id in the undecidable rule list from the skill?
   - If NOT in list: classify as functional defect or standards-only based on rule semantics
     (do not search for FP — decidable rules have very low FP rates)
   - If IN list: proceed to Phase 2

2. **Phase 2: Source Code Context Analysis**
   - Use \`read\` to load the violation's \`file\` at the reported \`line\` with ±15 lines context
   - For A1 rules: check if code matches a known embedded pattern → if yes, mark FP
   - For A2/B1/B2/B3 rules: analyze context per the skill's "Context Elements to Examine"
   - For A3 rules: default to functional defect; require explicit evidence to mark FP

3. **Phase 3: Functional Impact Judgment**
   Apply the decision tree from the skill:
   - On executable path + causes runtime error/UB/crash → Functional Defect
   - On executable path + no runtime difference → Standards-Only Violation
   - Dead code path → FP candidate (confirm via source read)
   - Cannot determine → conservative: Functional Defect

### Step 3: Read Existing Defects
Read \`.matrix/data/defects.json\` if it exists. Preserve all existing defects from other
sources (code_review, interrupt_review, unit_test, confirmation_test). Only add new
defects with source "static_analysis".

### Step 4: Write Outputs

#### 4.1 Write defects.json
Append functional defects to the existing DefectDatabase:
- \`id\`: format "SA-XXXX" (sequential, starting after any existing SA-* IDs)
- \`source\`: "static_analysis"
- \`severity\`: from raw finding severity
- \`category\`: appropriate defect category (e.g., "coding_standard", "logic_error", etc.)
- \`location\`: { file_path, line_start }
- \`title\`: concise one-line: "CID<N>: <what is wrong>"
- \`description\`: explain BOTH what is wrong AND what correct behavior should be
- \`rule_id\`: CID format
- \`status\`: "open"
- \`detected_by\`: "sa-reviewer"
- \`detected_date\`: current ISO date

Recalculate summary (total, by_source, by_severity, by_category, by_status, open_critical).
Write updated database to \`.matrix/data/defects.json\`.

#### 4.2 Write false-positives.json
Write \`.matrix/data/false-positives.json\` with all FP records:
- \`project_name\`, \`generated_date\`, \`tool\`: "specchecker"
- \`summary\`: total_violations_checked, false_positives_found, confirmed_violations, standards_only_violations
- \`false_positives\` array: raw_finding_id, rule_id, undecidable_category, file, line, reason
- \`standards_only\` array: raw_finding_id, rule_id, file, line, reason

#### 4.3 Write static-analysis-review.md
Write \`.matrix/reports/static-analysis-review.md\` with:
- **分类汇总**: table showing total / functional defects / standards-only / false positives
- **功能缺陷列表**: every defect written to defects.json (SA-* IDs, rule_id, file:line, title)
- **误报列表**: every FP with rule_id, undecidable category, file:line, judgment reason
- **规范违规列表**: standards-only violations (rule_id, file:line, description)
</workflow>

<constraints>
- NEVER fabricate violations. Every defect must originate from sa-raw-findings.json.
- ALWAYS read source code before classifying undecidable rule violations (Phase 2 is mandatory for in-list rules).
- NEVER mark A3 rules as FP without explicit documented evidence in source code.
- ALWAYS preserve existing defects from other sources when updating defects.json.
- CONSERVATIVE PRINCIPLE: when in doubt between functional defect and standards-only, keep as functional defect.
- mandatory conformance (L001) violations: do NOT mark as FP without clear exclusion evidence.
</constraints>

<artifact_paths>
- Input: .matrix/data/sa-raw-findings.json
- Output defects: .matrix/data/defects.json (append static_analysis entries)
- Output FP: .matrix/data/false-positives.json
- Output report: .matrix/reports/static-analysis-review.md
</artifact_paths>`

export function createSaReviewerAgent(model?: string): AgentConfig {
  return {
    description:
      "Static analysis result classifier — reads sa-raw-findings.json, applies " +
      "static-analysis-review skill to classify 141 undecidable SpecChecker rules, " +
      "writes functional defects to defects.json and false positives to " +
      "false-positives.json. (SA-Reviewer - Matrix)",
    mode: MODE,
    ...(model ? { model } : {}),
    temperature: 0.1,
    prompt: SA_REVIEWER_SYSTEM_PROMPT,
    tools: {
      read: true,
      write: true,
      glob: true,
      grep: true,
      skill: true,
    },
    color: "#1ABC9C",
    permission: {
      edit: "allow",
      bash: "deny",
    } as AgentConfig["permission"],
  }
}
createSaReviewerAgent.mode = MODE
```

**Step 2: 类型检查**

```bash
bun run typecheck
```

期望：无错误。

**Step 3: Commit**

```bash
git add src/agents/sa-reviewer.ts
git commit -m "feat(agents): add SA-Reviewer agent for three-class static analysis classification"
```

---

## Task 6: 注册 SA-Reviewer 到 `builtin-agents.ts`

**Files:**
- Modify: `src/agents/builtin-agents.ts`

**Step 1: 添加 import**

在现有 import 列表末尾添加（在 `createCrReviewerAgent` import 之后）：

```typescript
import { createSaReviewerAgent, SA_REVIEWER_PROMPT_METADATA as SA_REVIEWER_META } from "./sa-reviewer"
```

**Step 2: 添加到 `BuiltinAgentName` 类型**

```typescript
export type BuiltinAgentName =
  | "conductor"
  | "planner"
  // ... existing entries ...
  | "cr-reviewer"
  | "sa-reviewer"   // 新增
```

**Step 3: 添加到 `agentFactories`**

```typescript
export const agentFactories: Record<BuiltinAgentName, AgentFactory> = {
  // ... existing entries ...
  "cr-reviewer": createCrReviewerAgent as AgentFactory,
  "sa-reviewer": createSaReviewerAgent as AgentFactory,   // 新增
}
```

**Step 4: 添加到 `agentMetadata`**

```typescript
export const agentMetadata: Record<BuiltinAgentName, AgentPromptMetadata> = {
  // ... existing entries ...
  "cr-reviewer": CR_REVIEWER_META,
  "sa-reviewer": SA_REVIEWER_META,   // 新增
}
```

**Step 5: 类型检查**

```bash
bun run typecheck
```

期望：无错误。

**Step 6: Commit**

```bash
git add src/agents/builtin-agents.ts
git commit -m "feat(agents): register sa-reviewer in builtin-agents registry"
```

---

## Task 7: 更新 Conductor — Phase 3 新增 SA-Reviewer 并行分发

**Files:**
- Modify: `src/agents/conductor.ts`

**Step 1: 在 Phase 3 Step 5 之后插入 SA-Reviewer 并行分发**

找到 `### Step 5: Dispatch summary review` 部分。当前内容：

```
### Step 5: Dispatch summary review
After all focused reviews complete, dispatch a holistic summary review:

```
task(subagent_type="inspector", prompt="review_mode=summary ...")
```
```

修改为（将 SA-Reviewer 与 Inspector Summary 并行分发）：

```
### Step 5: Dispatch summary review and SA-Reviewer (parallel)
After all focused reviews AND StaticAnalyzer complete, dispatch both in parallel:

**Inspector Summary** (holistic code review summary):
```
task(subagent_type="inspector", prompt="review_mode=summary Perform holistic code review summary. Read ALL .matrix/data/review-records/*.json files. Verify completeness (record count, sub-item coverage, MISMATCH-to-Defect mapping). Perform runtime safety defect analysis (cross-function buffer overflow, concurrency, etc.). Check cross-requirement consistency. Merge all defects with sequential IDs (DEF-CR-001, ...). Output final defects to .matrix/data/defects.json and report to .matrix/reports/code-review.md.", run_in_background=true)
```

**SA-Reviewer** (static analysis three-class classification, parallel with Inspector Summary):
```
task(subagent_type="sa-reviewer", prompt="Classify SpecChecker violations from .matrix/data/sa-raw-findings.json into three categories. Load the static-analysis-review skill. Read source files for context on undecidable rule violations. Write functional defects to .matrix/data/defects.json (source: static_analysis), false positives to .matrix/data/false-positives.json, and full classification report to .matrix/reports/static-analysis-review.md.", run_in_background=true)
```

Wait for BOTH Inspector Summary AND SA-Reviewer to complete before proceeding to Step 6.
Verify that both `.matrix/reports/code-review.md` and `.matrix/reports/static-analysis-review.md` exist.
```

**Step 2: 更新 Phase 3 的 Output 说明（Step 3 之前的说明行）**

找到 Phase 3 的 Output 行：

```
- Output: `.matrix/data/review-records/*.json` (per-requirement), `.matrix/reports/code-review.md`, `.matrix/reports/static-analysis.md`, `.matrix/data/defects.json`
```

改为：

```
- Output: `.matrix/data/review-records/*.json` (per-requirement), `.matrix/reports/code-review.md`, `.matrix/reports/static-analysis.md`, `.matrix/reports/static-analysis-review.md`, `.matrix/data/sa-raw-findings.json`, `.matrix/data/defects.json`, `.matrix/data/false-positives.json`
- Gate: CR-Reviewer must approve. `.matrix/data/defects.json`, `.matrix/reports/code-review.md`, and `.matrix/reports/static-analysis-review.md` must all exist.
```

**Step 3: 类型检查**

```bash
bun run typecheck
```

期望：无错误。

**Step 4: Build 验证**

```bash
bun run build
```

期望：构建成功，无错误。

**Step 5: Commit**

```bash
git add src/agents/conductor.ts
git commit -m "feat(conductor): dispatch SA-Reviewer parallel with Inspector Summary in Phase 3"
```

---

## Task 8: 最终验证

**Step 1: 完整类型检查**

```bash
bun run typecheck
```

期望：零 TypeScript 错误。

**Step 2: 完整构建**

```bash
bun run build
```

期望：`dist/index.js` 生成成功，无警告。

**Step 3: 验证 skill 可发现**

确认 skill 文件路径正确（OpenCode 通过 `config.skills.paths` 配置的目录自动发现）：

```bash
ls skills/static-analysis-review/SKILL.md
```

期望：文件存在。

**Step 4: 验证 agent 注册**

```bash
grep -r "sa-reviewer" src/
```

期望：在 `builtin-agents.ts`、`conductor.ts`、`sa-reviewer.ts` 中均有引用。

**Step 5: 验证 schema 导出**

```bash
grep -r "SARawFinding" src/schema/
```

期望：在 `sa-raw-findings.ts` 和 `index.ts` 中均有定义/导出。

**Step 6: 最终 commit**

```bash
git add .
git commit -m "chore: verify SA-Reviewer implementation complete — typecheck and build pass"
```

---

## 实现完成检查清单

- [ ] `src/schema/sa-raw-findings.ts` — SARawFinding、SARawFindingsReport schema
- [ ] `src/schema/index.ts` — 导出新 schema
- [ ] `src/agents/static-analyzer.ts` — 输出 sa-raw-findings.json，不写 defects.json
- [ ] `skills/static-analysis/SKILL.md` — 更新输出说明
- [ ] `skills/static-analysis-review/SKILL.md` — 155条规则完整 skill 文件
- [ ] `src/agents/sa-reviewer.ts` — SA-Reviewer agent 定义
- [ ] `src/agents/builtin-agents.ts` — 注册 sa-reviewer
- [ ] `src/agents/conductor.ts` — Phase 3 Step 5 并行分发
- [ ] `bun run typecheck` 通过
- [ ] `bun run build` 通过
