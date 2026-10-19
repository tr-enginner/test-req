import { z } from "zod"
import { ReportMeta } from "./report-meta"

/** Single test parameter */
export const TestParam = z.object({
  name: z.string(),
  type: z.string(),
  value: z.string(),
  description: z.string().optional(),
})
export type TestParam = z.infer<typeof TestParam>

/** Unit test case */
export const UnitTestCase = z.object({
  id: z.string(),
  target_function_id: z.string(),
  target_function_name: z.string(),
  related_requirement_ids: z.array(z.string()),
  title: z.string(),
  description: z.string(),
  design_method: z.enum([
    "equivalence_partition",
    "boundary_value",
    "basic_path",
    "condition_combination",
    "error_guessing",
    "state_transition",
  ]),
  preconditions: z.array(z.string()),
  inputs: z.array(TestParam),
  expected_outputs: z.array(TestParam),
  stubs: z
    .array(
      z.object({
        function_name: z.string(),
        return_value: z.string(),
        description: z.string().optional(),
      }),
    )
    .default([]),
  postconditions: z.array(z.string()).default([]),
  coverage_contribution: z.enum(["statement", "branch", "mc_dc"]).optional(),
  case_source: z.enum(["autogen", "functional", "coverage_supplement"]).default("autogen"),
})
export type UnitTestCase = z.infer<typeof UnitTestCase>

/** Failure analysis for a failed test case */
export const FailureAnalysis = z.object({
  classification: z.enum([
    "code_defect",
    "test_case_error",
    "requirement_gap",
    "unresolved",
  ]),
  root_cause: z.string(),
  defect_id: z.string().optional(),
  requirement_mismatch: z.boolean().default(false),
  corrected: z.boolean().default(false),
})
export type FailureAnalysis = z.infer<typeof FailureAnalysis>

/** Unit test execution result */
export const UnitTestResult = z.object({
  test_case_id: z.string(),
  verdict: z.enum(["pass", "fail", "error", "skip"]),
  actual_outputs: z.array(TestParam).optional(),
  error_message: z.string().optional(),
  execution_time_ms: z.number().optional(),
  executed_date: z.string(),
  failure_analysis: FailureAnalysis.optional(),
})
export type UnitTestResult = z.infer<typeof UnitTestResult>

/** Unit test report — main output of UnitTester */
export const UnitTestReport = ReportMeta.merge(z.object({
  test_cases: z.array(UnitTestCase),
  results: z.array(UnitTestResult),
  coverage: z.object({
    statement: z.number().optional(),
    branch: z.number().optional(),
    mc_dc: z.number().optional(),
    uncovered_functions: z.array(z.string()).default([]),
  }),
  summary: z.object({
    total_cases: z.number(),
    passed: z.number(),
    failed: z.number(),
    error: z.number(),
    skip: z.number(),
    pass_rate: z.number(),
    by_source: z.object({
      autogen: z.object({ total: z.number(), passed: z.number(), failed: z.number() }),
      functional: z.object({ total: z.number(), passed: z.number(), failed: z.number() }),
      coverage_supplement: z.object({ total: z.number(), passed: z.number(), failed: z.number() }),
    }).optional(),
    failure_analysis_summary: z.object({
      code_defects: z.number(),
      test_case_errors: z.number(),
      requirement_gaps: z.number(),
      unresolved: z.number(),
      requirement_mismatches: z.number(),
    }).optional(),
  }),
  per_function_summary: z.array(z.object({
    function_name: z.string(),
    total_cases: z.number(),
    passed: z.number(),
    failed: z.number(),
    by_source: z.object({
      autogen: z.number(),
      functional: z.number(),
      coverage_supplement: z.number(),
    }),
    coverage: z.object({
      statement: z.number().optional(),
      branch: z.number().optional(),
      mc_dc: z.number().optional(),
    }),
  })).optional(),
}))
export type UnitTestReport = z.infer<typeof UnitTestReport>
