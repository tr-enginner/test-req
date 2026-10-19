import { z } from "zod"
import { ReportMeta } from "./report-meta"

/** Single step execution record */
export const StepResult = z.object({
  step_number: z.number(),
  actual_result: z.string(),
  verdict: z.enum(["pass", "fail", "blocked", "not_executed"]),
  evidence: z.string().optional(),
  notes: z.string().optional(),
})
export type StepResult = z.infer<typeof StepResult>

/** Single test case execution result */
export const TestCaseExecution = z.object({
  test_case_id: z.string(),
  execution_id: z.string(),
  verdict: z.enum(["pass", "fail", "blocked", "not_executed"]),
  step_results: z.array(StepResult),
  defect_ids: z.array(z.string()).default([]),
  environment: z.object({
    platform: z.string().optional(),
    software_version: z.string().optional(),
    tools: z.array(z.string()).default([]),
  }),
  executed_by: z.string(),
  executed_date: z.string(),
  duration_min: z.number().optional(),
  notes: z.string().optional(),
})
export type TestCaseExecution = z.infer<typeof TestCaseExecution>

/** Test execution report — main output of TestExecutor */
export const TestExecutionReport = ReportMeta.merge(z.object({
  executions: z.array(TestCaseExecution),
  coverage: z.object({
    requirement_coverage: z.number(),
    test_case_coverage: z.number(),
    code_statement: z.number().optional(),
    code_branch: z.number().optional(),
    code_mc_dc: z.number().optional(),
    code_condition: z.number().optional(),
    code_path: z.number().optional(),
  }),
  summary: z.object({
    total_executed: z.number(),
    passed: z.number(),
    failed: z.number(),
    blocked: z.number(),
    not_executed: z.number(),
    pass_rate: z.number(),
    total_defects_found: z.number(),
  }),
}))
export type TestExecutionReport = z.infer<typeof TestExecutionReport>
