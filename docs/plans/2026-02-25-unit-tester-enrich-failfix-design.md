# Unit-Tester: Enrich Cases, Failure Analysis, Detailed Descriptions

## Problem

Three gaps in the current AUnit-driven unit-tester workflow:

1. **Failed cases not analyzed properly**: After execution, failed cases are only analyzed at the very end (Step 10). They should be analyzed immediately, classified as code defects or test issues, and test issues should be fixed and re-executed.
2. **AUnit autogen cases lack expected values and descriptions**: Z3-solver auto-generated cases have empty `retValue` and generic `caseName` but no meaningful `desc` or expected outputs. Only manually injected functional cases have these.
3. **Test case descriptions too brief**: Descriptions should include test purpose, test method, input conditions, and expected behavior.

## Design

### 1. New Tool: `aunit_enrich_cases`

**File**: `src/tools/aunit/aunit-enrich-cases.ts`

Updates existing cases in a gson file with expected values and descriptions. Does NOT create new cases (that's `aunit_inject_cases`).

**Parameters**:
- `project_name: string` — AUnit project name
- `project_dir: string` — Project root directory
- `function_name: string` — Target function name
- `enrichments: Array<{caseId, retValue?, gVars?, desc?}>` — Updates to apply

**Behavior**:
1. Find gson file by `function_name` (same pattern as inject tool)
2. Read gson with GBK decoding
3. For each enrichment, find case by `caseId` and update non-empty fields:
   - `retValue` if provided and non-empty
   - `gVars` if provided (merge: update existing by expr, add new)
   - `desc` if provided and non-empty
4. Write back gson with GBK encoding
5. Return count of enriched cases

**Calling sequence**: After `aunit_autogen`, before `aunit_run_case`.

### 2. Failure Analysis Loop (Step 6b in prompt)

After `aunit_run_case`, the agent:

1. Reads gson files to find cases with `result.status !== "OK"`
2. For each failed case:
   - Compares `result.obValues` (actual) vs `retValue`/`gVars[].out` (expected)
   - **Code defect**: actual output is clearly wrong (crash, unexpected error, logic violation) → record defect in `.matrix/data/defects.json`
   - **Test issue**: expected value was wrong (agent miscalculated) → fix via `aunit_enrich_cases` with corrected `retValue`/`gVars`
3. If any cases were corrected, re-run `aunit_run_case` and re-analyze
4. Maximum 3 correction cycles

This is purely prompt-driven — no new tool needed for the analysis logic itself.

### 3. Detailed Description Format

All test case descriptions (both autogen-enriched and functional-gen) follow:

**Format**: `[测试目的] [测试方法] [输入条件] → [预期行为]`

**Examples**:
- `"功能验证：验证当电压低于阈值时触发欠压保护。采用边界值分析法，输入 voltage=11.9V（阈值12V-0.1），预期返回保护状态码 PROT_UNDERVOLT(3)"`
- `"覆盖率补充：覆盖 processData 函数第23行 else 分支。输入 mode=0, data=NULL，预期返回错误码 -1"`

### 4. Workflow Changes

```
Step 1-3: unchanged
Step 4a: aunit_autogen (unchanged)
Step 4a+: NEW — aunit_enrich_cases (agent computes retValue/desc for autogen cases)
Step 4b: functional-case-gen (unchanged, already has retValue/desc)
Step 5: aunit_inject_cases (unchanged)
Step 6: aunit_run_case (unchanged)
Step 6b: NEW — Failure analysis loop (classify → fix or record defect → re-run)
Step 7-10: largely unchanged, Step 10 simplified (defects already recorded in 6b)
```

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/tools/aunit/aunit-enrich-cases.ts` | CREATE | Enrich existing gson cases with retValue/gVars/desc |
| `src/tools/aunit/index.ts` | MODIFY | Export new tool |
| `src/create-tools.ts` | MODIFY | Register new tool |
| `src/agents/unit-tester.ts` | MODIFY | Add Step 4a+, Step 6b, update desc format guidance |
| `skills/functional-case-gen/SKILL.md` | MODIFY | Update desc format with detailed template |
