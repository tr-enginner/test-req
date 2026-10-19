import { z } from "zod"
import { ReportMeta } from "./report-meta"

/** Test summary — main output of Summarizer */
export const TestSummary = ReportMeta.merge(z.object({
  /** Override created_date to optional for backward compatibility */
  created_date: z.string().optional(),
  conclusion: z.enum(["pass", "conditional_pass", "fail"]),
  conclusion_rationale: z.string(),
  metrics: z.object({
    total_requirements: z.number(),
    covered_requirements: z.number(),
    requirement_coverage_pct: z.number(),
    total_test_cases: z.number(),
    executed_test_cases: z.number(),
    passed_test_cases: z.number(),
    pass_rate: z.number(),
    total_defects: z.number(),
    open_defects: z.number(),
    critical_defects: z.number(),
    code_coverage: z.object({
      statement: z.number().optional(),
      branch: z.number().optional(),
      mc_dc: z.number().optional(),
      condition: z.number().optional(),
      path: z.number().optional(),
    }),
  }),
  risk_items: z
    .array(
      z.object({
        description: z.string(),
        severity: z.enum(["high", "medium", "low"]),
        mitigation: z.string().optional(),
      }),
    )
    .default([]),
  recommendations: z.array(z.string()).default([]),
}))
export type TestSummary = z.infer<typeof TestSummary>
