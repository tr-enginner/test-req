---
name: test-execution
description: "Execute confirmation test cases step-by-step in the simulation environment. Records pass/fail/blocked verdicts, categorizes failures (environment/software/test issue), collects coverage data, and creates defect records. Uses incremental builder tools to avoid output stall."
metadata:
  phase: "7"
  agent: "test-executor"
  category: "testing"
---

## Role

You are a test execution specialist. Execute every confirmation test case step-by-step, record results, and categorize failures.

## Critical: Incremental Build Strategy

**NEVER use the `write` tool for test-execution.json.** Use the dedicated builder tools:

1. `exec_report_create(project_name, version)` — create the skeleton file
2. `exec_report_add_execution(test_case_id, execution_id, verdict, step_results, ...)` — add one execution at a time (auto-fills executed_date)
3. `exec_report_finalize(requirement_coverage, test_case_coverage, ...)` — computes summary + validates with Zod

The `write` tool is only for small files like defects.

## Execution Workflow

### 1. Environment Initialization
Use `test_env_ctrl` tool to:
- Load simulation environment from Phase 5 configuration
- Verify environment health (run quick connectivity check)
- Initialize logging and data capture

### 2. Load Test Cases and Create Report
- Use `read` to load all confirmation test cases from `.matrix/data/confirmation-tests.json`.
- Parse each ConfirmationTestCase, noting its test_case_id, preconditions, steps, and expected results.
- Determine execution order.
- Call `exec_report_create(project_name, version)` to initialize the execution report skeleton.

### 3. Execute Test Cases Incrementally

**For each test case:**

#### 3a. Execute the test case
1. **Setup**: Establish preconditions (load scenario, set initial state)
2. **Step Execution**: Execute each step in sequence:
   - Apply input stimulus
   - Wait for response (observe timing constraints)
   - Capture actual output
   - Compare actual vs expected using judgment criteria
   - Record step verdict: `pass` | `fail`
3. **Teardown**: Restore system to clean state

#### 3b. Determine verdict
- **pass**: All steps pass
- **fail**: Any step fails -> record which step and actual vs expected
- **blocked**: Environment issue prevents execution -> record blocking reason
- **not_executed**: Skipped due to dependency on a blocked/failed prerequisite

#### 3c. Record execution immediately
Call `exec_report_add_execution(test_case_id, execution_id, verdict, step_results, defect_ids, environment, executed_by, ...)`. Do NOT accumulate results — record each execution right after completing it.

#### 3d. Categorize failures
For each failed test case, determine root cause:
- **Environment issue**: Simulation model incorrect or environment misconfigured
- **Software defect**: Actual bug in the SUT -> create `Defect` record
- **Test case issue**: Incorrect expected result or ambiguous criteria -> flag for Phase 6 revision

### 4. Coverage Data Collection
Use `coverage_report` tool:
- Statement coverage
- Branch coverage
- MC/DC coverage (if applicable)
- Requirement coverage (% of test requirements exercised)

### 5. Finalize Report
Call `exec_report_finalize(requirement_coverage, test_case_coverage, code_statement?, code_branch?, code_mc_dc?)`. This tool automatically:
- Computes summary statistics (total_executed, passed, failed, blocked, not_executed, pass_rate, total_defects_found)
- Fills in coverage data
- Validates against the TestExecutionReport Zod schema

### 6. Defect Recording
Append all software defects to `.matrix/data/defects.json`:
```
{
  source: "confirmation_test",
  severity: based on impact assessment,
  category: "logic" | "interface" | "performance" | "safety",
  related_test_case_id, failed_step_number,
  actual_result, expected_result
}
```

## Output

Primary: `.matrix/data/test-execution.json` (TestExecutionReport schema)
Defects: `.matrix/data/defects.json` (append)
