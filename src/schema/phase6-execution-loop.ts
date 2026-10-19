import { z } from "zod"

export const Phase6CoverageTarget = z.enum(["statement", "branch", "mc_dc", "condition", "path"])
export type Phase6CoverageTarget = z.infer<typeof Phase6CoverageTarget>

export const Phase6ExecutionFailedCase = z.object({
  case_id: z.string(),
  status: z.literal("FAIL"),
  message: z.string(),
  error_message: z.unknown().optional(),
})
export type Phase6ExecutionFailedCase = z.infer<typeof Phase6ExecutionFailedCase>

export const Phase6ExecutionLoopRound = z.object({
  round_index: z.number().int().min(0),
  kind: z.enum(["initial", "optimization"]),
  started_at: z.string(),
  completed_at: z.string(),
  dtp_success: z.boolean(),
  reports_dir: z.string().optional(),
  summary_file: z.string().optional(),
  result_source: z.enum(["test_summary_json", "output_xml"]).optional(),
  output_xml: z.string().optional(),
  total: z.number().int().min(0),
  passed: z.number().int().min(0),
  failed: z.number().int().min(0),
  skipped: z.number().int().min(0),
  pass_rate: z.number().min(0).max(100),
  pass_rate_threshold: z.number().min(0).max(100),
  pass_rate_met: z.boolean(),
  coverage_target: Phase6CoverageTarget,
  coverage_value: z.number().min(0).max(100).nullable(),
  coverage_threshold: z.number().min(0).max(100),
  coverage_met: z.boolean(),
  coverage_file: z.string().optional(),
  coverage_missing: z.boolean(),
  test_execution_file: z.string().optional(),
  test_execution_report: z.string().optional(),
  failed_cases: z.array(Phase6ExecutionFailedCase).default([]),
  optimization_applied: z.boolean(),
  optimization_case_ids: z.array(z.string()).optional(),
  todo_file: z.string().optional(),
  todo_case_count: z.number().int().min(0).optional(),
  robot_regenerated: z.boolean().optional(),
  dtp_generation_outputs: z.array(z.object({}).passthrough()).optional(),
  errors: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
})
export type Phase6ExecutionLoopRound = z.infer<typeof Phase6ExecutionLoopRound>

export const Phase6ExecutionLoopArtifact = z.object({
  schema_version: z.literal("1.0.0"),
  created_at: z.string(),
  updated_at: z.string(),
  source_suite_file: z.string(),
  translated_suite_file: z.string(),
  todo_file: z.string(),
  dtp_root: z.string(),
  pass_rate_threshold: z.number().min(0).max(100),
  coverage_target: Phase6CoverageTarget,
  coverage_threshold: z.number().min(0).max(100),
  max_optimization_rounds: z.number().int().min(0),
  gate_status: z.enum(["passed", "failed", "error"]),
  rounds: z.array(Phase6ExecutionLoopRound),
  final: z.object({
    pass_rate: z.number().min(0).max(100).nullable(),
    pass_rate_met: z.boolean(),
    coverage_value: z.number().min(0).max(100).nullable(),
    coverage_met: z.boolean(),
    attempts: z.number().int().min(0),
    optimization_rounds_used: z.number().int().min(0),
    message: z.string(),
  }),
})
export type Phase6ExecutionLoopArtifact = z.infer<typeof Phase6ExecutionLoopArtifact>
