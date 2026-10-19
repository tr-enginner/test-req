import { z } from "zod"
import { Defect } from "./defect"
import { ReportMeta } from "./report-meta"

export const ReviewedFunction = z.object({
  function_name: z.string(),
  function_id: z.string().optional(),
  file_path: z.string().optional(),
  line_range: z.object({
    start: z.number(),
    end: z.number(),
  }),
  batch_id: z.string().optional(),
})
export type ReviewedFunction = z.infer<typeof ReviewedFunction>

export const BehaviorSafetyBatchRecord = ReportMeta.merge(
  z.object({
    schema_name: z.literal("BehaviorSafetyBatchRecord"),
    batch_id: z.string(),
    strategy: z.enum(["code_slice", "per_file_fallback"]).optional(),
    source_file: z.string(),
    context_id: z.string().optional(),
    context_path: z.string().optional(),
    functions_in_batch: z.array(ReviewedFunction),
    defects: z.array(Defect).default([]),
    summary: z.object({
      functions_in_batch: z.number(),
      defects_in_batch: z.number(),
      status: z.enum(["completed", "incomplete"]).default("completed"),
    }),
  }),
)
export type BehaviorSafetyBatchRecord = z.infer<typeof BehaviorSafetyBatchRecord>

export const BehaviorSafetyRecord = ReportMeta.merge(
  z.object({
    schema_name: z.literal("BehaviorSafetyRecord"),
    source_file: z.string(),
    functions_reviewed: z.array(ReviewedFunction),
    defects: z.array(Defect).default([]),
    summary: z.object({
      total_functions: z.number(),
      reviewed_functions: z.number(),
      total_defects: z.number(),
      batch_count: z.number(),
      execution_strategy: z.enum(["code_slice", "per_file_fallback"]).optional(),
      analysis_unit: z.enum(["slice", "file", "function"]).optional(),
      total_units: z.number().optional(),
      reviewed_units: z.number().optional(),
      coverage_status: z.enum(["full", "partial", "none"]),
      invalid_batch_count: z.number().optional(),
      invalid_batches: z.array(z.string()).optional(),
    }),
  }),
)
export type BehaviorSafetyRecord = z.infer<typeof BehaviorSafetyRecord>
