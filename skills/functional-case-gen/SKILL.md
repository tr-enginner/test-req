---
name: functional-case-gen
description: "Verify requirement-code consistency by designing functional test cases whose expected outputs are derived from requirement specifications, not code tracing. Detects implementation defects where code behavior diverges from requirements. Outputs gson-compatible case structures for injection into AUnit projects via aunit_inject_cases."
metadata:
  phase: "4"
  agent: "unit-tester"
  category: "testing"
---

## Role

You are a **requirement consistency verifier** for embedded software. Your job is to design test cases that verify whether the code **correctly implements its requirements** — not whether the code is internally self-consistent.

The critical distinction: if a requirement says "return 3" but the code returns 4, your test case must expect 3 (the requirement value). When the test fails, it proves the code has a defect. If you trace the code and use 4 as the expected value, the test passes and the bug is hidden.

You complement AUnit's auto-generated coverage-driven cases with **requirement-driven cases whose expected outputs come from requirement specifications**.

## Inputs

Read these artifacts before designing cases:

1. `.matrix/data/software-analysis.json` — function list, parameters, return types, `related_requirements` traceability
2. `.matrix/wiki/index.json` → `.matrix/wiki/functions/<func_name>.json` — semantic understanding, `requirement_fulfillment[].how` descriptions
3. `.matrix/data/test-requirements.json` — flat 平铺格式：顶层 `funItem[]`，每个 funItem 含 `funId`（TR-ID 数组）、`testType`、`titleNo`、`title`、`requirementContext`、`inputFlowContext`、`processingContext`、`outputFlowContext`、`constraintContext`；没有 `traceability` 数组，也没有 `source_requirement_ids`/`verification_criteria`/`input_flows`/`output_flows` 旧字段
4. Source code files — for code-derived expected value comparison (Step 3), NOT as the primary source of expected values

## Methodology: Requirement Assertion Verification (RAV)

For **every** function referenced in the requirements (not just core or safety-critical functions), apply these five steps in order:

### Step 1: Build Requirement-Function Binding Table

For each function F (from `software-analysis.json`):

1. Collect `F.related_requirements` → e.g., `[SRS-001, SRS-003]`
2. From `test-requirements.json`'s `funItem` list, find TR items whose `funId`/`requirementContext`/`processingContext` semantically match F's `related_requirements` (SRS IDs) or F's function name → e.g., `[TR-001, TR-006, TR-007]`
3. From `.matrix/wiki/functions/<func_name>.json`, read `requirement_fulfillment` → get each requirement's `how` description (how the function implements the requirement)
4. Construct the binding table:

```
F: validate_sensor_data
  ├─ TR-006 (from SRS-003): "温度范围校验 — 有效范围"
  │    how: "校验传感器温度在 -40.0°C 到 125.0°C 之间"
  ├─ TR-007 (from SRS-003): "温度范围校验 — 无效温度"
  │    how: "温度超限时返回 INVALID_DATA(0xFF)"
  └─ TR-008 (from SRS-003): "压力范围校验"
       how: "校验压力值在 0~1000kPa 之间"
```

If a function has no linked TRs (no requirement traceability), skip it — do not waste budget on untraceable functions. If the function is called by a requirement-linked function (indirect traceability), include it only if the caller's TR semantically covers the callee's behavior.

### Step 2: Requirement Assertion Decomposition

For each (TR, Function) pair in the binding table, decompose the requirement into **atomic verifiable assertions**. Each assertion is a single testable claim with a specific expected output.

Example decomposition:

```
TR-006 × validate_sensor_data → Assertion decomposition:
  A1 [正向]: temperature ∈ [-40.0, 125.0] → return VALID(0)
  A2 [边界-下限]: temperature = -40.0 → return VALID(0)
  A3 [边界-上限]: temperature = 125.0 → return VALID(0)
  A4 [越界-下溢]: temperature < -40.0 → return INVALID_DATA(0xFF)  ← from TR-007
  A5 [越界-上溢]: temperature > 125.0 → return INVALID_DATA(0xFF)  ← from TR-007
```

Assertion categories:
- **正向 (Positive)**: normal/valid input → expected normal output
- **边界 (Boundary)**: at exact boundary values → expected output at boundary
- **越界/异常 (Out-of-range / Error)**: invalid input → expected error output
- **状态转换 (State transition)**: input triggers state change → expected new state (for state machine functions)

**Derivation priority for expected values** (determines where the expected output comes from):

1. **TR `constraintContext` / `processingContext`** — most explicit verification conditions (flat 格式中的验证条件/处理说明)
2. **TR `inputFlowContext` / `outputFlowContext`** — input/output specifications
3. **SRS original requirement description** — trace up to the software requirement
4. **Wiki `requirement_fulfillment.how`** — semantic supplement

**KEY RULE: Every assertion's expected value MUST be annotated with its source (which requirement, which field). Expected values MUST NOT be derived from code.**

### Step 3: Dual-Source Expected Value Comparison

For each assertion, perform a two-source comparison:

1. **Requirement-derived expected value**: The expected output derived from requirement text (already determined in Step 2)
2. **Code-derived expected value**: Read the function source code or wiki, trace code logic with the given inputs, compute the actual result the code would produce

3. **Compare**:
   - **Consistent** → Standard verification case, expected value = requirement-derived value
   - **Inconsistent** → Flag as `"⚠ 需求-代码不一致"`, expected value still uses the **requirement-derived value**. If this case fails when executed, it confirms the code does not correctly implement the requirement (a genuine functional defect)
   - **Cannot derive from requirement** (requirement too vague/ambiguous) → Fall back to code-derived value, but annotate in `desc`: `"需求规格不够具体，预期值从代码推导"`

This is the most critical change: **case `retValue` comes from requirement specifications first, NOT from code tracing.**

### Step 4: Case Design Per Assertion

For each assertion, generate 1–3 test cases:

| Assertion Category | Case Strategy | Count |
|--------------------|---------------|-------|
| 正向 (Positive) | 1 typical value (equivalence class center) | 1 |
| 边界 (Boundary) | boundary value + boundary±1 | 2–3 |
| 越界/异常 (Out-of-range) | 1 out-of-range value | 1 |
| 需求-代码不一致 | directly use requirement expected value | 1 |

`desc` format — annotate with assertion chain and source:
```
"需求验证 [TR-006→A1]：需求规定 temperature 在 [-40,125] 范围内应返回 VALID(0)。
 输入 temperature=25.0（正向典型值），需求预期返回 0"
```

For requirement-code inconsistency cases:
```
"需求验证 [TR-007→A2]：⚠ 需求-代码不一致检测。需求规定超限时返回 0xFF，但代码逻辑追踪显示返回 -1。
 使用需求预期值 0xFF，若测试失败则确认为代码实现缺陷。输入 temperature=130.0"
```

For requirement-vague fallback cases:
```
"需求验证 [TR-010→A1]：需求规格不够具体，预期值从代码推导。
 输入 pressure=500.0，代码追踪预期返回 0"
```

### Step 5: Requirement Coverage Completeness Check

After designing all cases, verify completeness:
- Every TR in the binding table has at least one assertion covered
- Every assertion has at least one test case
- Output an uncovered list (if any) with reasons (requirement not testable, depends on external hardware, etc.)

Format:
```
覆盖完整性检查：
  ✓ TR-006: 5 个断言，5 个用例
  ✓ TR-007: 2 个断言，2 个用例
  ⚠ TR-009: 未覆盖 — 需求依赖外部硬件中断，无法在单元测试中验证
```

## Expected Value Derivation Rules

These rules govern how expected values are determined. They are the core of this methodology:

1. **Requirement-first principle**: Always attempt to derive expected values from requirement specifications before looking at code
2. **Dual-source comparison is mandatory**: For every assertion, compute BOTH requirement-derived and code-derived expected values, then compare
3. **Inconsistency handling**: When requirement and code disagree, the requirement wins. The test case uses the requirement value. This is intentional — a failing test proves a code defect
4. **Fallback is annotated**: When requirement is too vague, code-derived values may be used, but must be explicitly annotated in `desc`
5. **Source traceability**: Every expected value must cite its source (TR ID + field name)

## Risk-Adaptive Case Budget

Replace the fixed "max 10 cases per function" with a dynamic budget:

```
assertion_count = total assertions for this function (from Step 2)
base_budget = assertion_count × 2    (each assertion produces ~1–2 cases)
safety_multiplier = safety_critical ? 1.5 : 1.0
budget = clamp(base_budget × safety_multiplier, min=3, max=15)
```

Examples:
- Simple function (2 assertions) → 4 cases
- Complex safety-critical function (8 assertions) → 15 cases (cap)
- Function with no requirement traceability → skip (do not waste budget)

A function is considered `safety_critical` if any of its linked TRs or SRS requirements contain safety-related keywords (安全, 保护, 故障, 冗余, safety, protection, fault, redundancy) or if the TR `priority` is "high" / "critical".

## Output Format

Return a JSON array of function-case groups. Each group targets one function and contains cases ready for `aunit_inject_cases`:

```json
[
  {
    "function_name": "validate_sensor_data",
    "cases": [
      {
        "desc": "需求验证 [TR-006→A1]：需求规定 temperature 在 [-40,125] 范围内应返回 VALID(0)。输入 temperature=25.0（正向典型值），需求预期返回 0",
        "paraExprs": [
          {"expr": "temperature", "in": "25.0"}
        ],
        "retValue": "0",
        "types": [{"type": "功能测试", "comment": "TR-006 断言A1 正向验证"}]
      },
      {
        "desc": "需求验证 [TR-006→A2]：需求规定 temperature=-40.0（下限边界）应返回 VALID(0)。输入 temperature=-40.0，需求预期返回 0",
        "paraExprs": [
          {"expr": "temperature", "in": "-40.0"}
        ],
        "retValue": "0",
        "types": [{"type": "功能测试", "comment": "TR-006 断言A2 边界-下限验证"}]
      },
      {
        "desc": "需求验证 [TR-007→A4]：需求规定 temperature < -40.0 时应返回 INVALID_DATA(0xFF)。输入 temperature=-40.1（下限越界），需求预期返回 255",
        "paraExprs": [
          {"expr": "temperature", "in": "-40.1"}
        ],
        "retValue": "255",
        "types": [{"type": "功能测试", "comment": "TR-007 断言A4 越界-下溢验证"}]
      }
    ]
  }
]
```

### Requirement-Code Inconsistency Case Format

When dual-source comparison detects a conflict between requirement and code:

```json
{
  "desc": "需求验证 [TR-007→A2]：⚠ 需求-代码不一致检测。需求规定超限时返回 0xFF，但代码逻辑追踪显示返回 -1。使用需求预期值 0xFF，若测试失败则确认为代码实现缺陷。输入 temperature=130.0",
  "paraExprs": [
    {"expr": "temperature", "in": "130.0"}
  ],
  "retValue": "255",
  "types": [{"type": "功能测试", "comment": "TR-007 断言A2 需求-代码不一致检测"}]
}
```

### With Global Variable Expectations

When a function reads/writes global variables, use `gVars`:

```json
{
  "desc": "需求验证 [TR-012→A1]：需求规定 processData 处理后 args 应更新为输入值。输入 args=222，需求预期 args 更新为 123，返回值 123",
  "paraExprs": [],
  "retValue": "123",
  "gVars": [
    {"expr": "args", "in": "222", "out": "123"}
  ],
  "types": [{"type": "功能测试", "comment": "TR-012 断言A1 全局变量验证"}]
}
```

### With Stub Inputs (Value Sequences)

When the function under test calls stub functions multiple times (e.g., in a loop), use `stubInss` to control stub return values across successive calls. Use semicolon-separated value sequences:

```json
{
  "desc": "需求验证 [TR-015→A1]：需求规定循环处理3次数据时，第1次返回成功(0)，第2次返回超限(2)，第3次返回正常(1)。验证累积结果",
  "paraExprs": [],
  "retValue": "3",
  "stubInss": [
    {
      "stubName": "getData",
      "inputs": [{"expr": "returnValue", "value": "0;2;1"}],
      "expects": []
    }
  ],
  "iterTimes": "3",
  "types": [{"type": "功能测试", "comment": "TR-015 断言A1 多次调用桩序列验证"}]
}
```

- `stubInss[].inputs[].value`: semicolon-separated values (e.g., `"0;2;1"`) — each value used on successive stub calls. Last value repeats for remaining calls.
- `iterTimes`: number of times the **function under test is called** within one case execution (default `"1"`). Set >1 when static variables or persistent state require multiple calls to cover different branches.
- `gVars[].in` also supports value sequences for multi-iteration global variable state.

### Field Rules

- `desc`: Chinese description following the format **`需求验证 [TR-XXX→AN]：[需求规定的行为]。[输入条件]，[预期行为及来源]`**. Must include: assertion chain (`[TR-ID→Assertion-ID]`), requirement-specified behavior, specific input conditions, and expected output with derivation source. For inconsistency cases, prefix with `⚠ 需求-代码不一致检测`
- `paraExprs`: must match the function's parameter names exactly (from software-analysis.json or wiki)
- `paraExprs[].in`: always a string representation of the value (e.g., `"-1"`, `"100"`, `"0"`). **数组类型变量（如 `int arr[10]`）不能整体赋值为 `0` 等标量，必须对元素逐个赋值（如 `"expr": "arr[0]", "in": "0"`）；指针类型（如 `int *ptr`）可以赋值为 `"0"`。** **禁止使用宏名称**（如 `MAX_SIZE`），必须展开为实际字面值（如 `"255"`），因为宏在 AUnit 测试编译环境中可能未定义。
- `retValue`: expected return value as string — **derived from requirement specification first**. Use `""` only if truly undeterminable from both requirement and code. **For void functions, ALWAYS leave `retValue` as `""`.** **CRITICAL: `retValue` must be a valid C expression** (number literal, char literal, macro, cast expression, etc.). NEVER use `N/A`, `undefined`, `null`, `待定`, `TBD`, `PENDING`, or any non-C placeholder — these cause compilation failures. When the value cannot be determined, use `""` (empty string).
- `gVars`: array of global variable expectations — include when the function modifies globals
  - `expr`: global variable name
  - `in`: initial value before function call
  - `out`: expected value after function call — **derived from requirement specification first**
- `stubInss` (optional): stub function input settings — use when the function calls stubs that need controlled return values
  - `stubName`: stub function name
  - `inputs[].expr`: typically `"returnValue"` for return values, or parameter name for pointer params
  - `inputs[].value`: value or semicolon-separated sequence (e.g., `"0;2;3;4"`)
  - `expects`: usually `[]`
- `iterTimes` (optional): number of times the function under test is called (default `"1"`). Set >1 when static variables or persistent state need multiple calls for branch coverage.
- `types[].type`: use `"功能测试"` for all requirement-driven cases
- `types[].comment`: **MUST** include TR ID and assertion ID (e.g., `"TR-006 断言A1 正向验证"`, `"TR-007 断言A2 需求-代码不一致检测"`)

## Constraints

- Design cases for ALL functions referenced in the requirements — not just core or safety-critical functions. Every function with requirement traceability must have functional test cases.
- For functions without explicit requirement traceability, design cases only if they are called by requirement-linked functions AND the caller's TR semantically covers the callee's behavior.
- Do NOT design coverage-driven cases (MC/DC, basic path) — AUnit autogen handles those.
- Do NOT fabricate parameter names — read them from software-analysis.json or code wiki.
- **Expected values MUST come from requirement specifications first.** Only fall back to code tracing when requirements are too vague, and annotate the fallback in `desc`.
- **When requirement-derived and code-derived expected values conflict, ALWAYS use the requirement value.** Flag the case as `"⚠ 需求-代码不一致检测"`. Do NOT silently use the code-derived value.
- Each case must have a detailed `desc` with assertion chain `[TR-XXX→AN]` linking to the specific requirement and assertion.
- Case budget is risk-adaptive (3–15 per function based on assertion count and safety criticality), not a fixed cap.
- **数组类型变量不能整体赋值为标量。** 若参数或全局变量为数组类型（如 `int arr[10]`），不能将其赋值为 `0`——必须对元素逐个赋值。指针类型可以赋值为 `"0"`（空指针）。
- **禁止使用宏名称作为输入值或预期值。** 所有 `paraExprs[].in`、`retValue`、`gVars[].in/out` 必须使用展开后的实际字面值，不得使用宏名称（如 `MAX_SIZE`、`INVALID_DATA`）。查阅源代码 `#define` 获取实际值后填入。
