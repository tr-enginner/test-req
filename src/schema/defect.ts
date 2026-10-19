import { z } from "zod"

/** Defect source */
export const DefectSource = z.enum([
  "static_analysis",
  "code_review",
  "interrupt_review",
  "atomicity_violation",
  "unit_test",
  "confirmation_test",
])
export type DefectSource = z.infer<typeof DefectSource>

/** Single defect */
export const Defect = z.object({
  id: z.string(),
  source: DefectSource,
  severity: z.enum(["critical", "major", "minor", "suggestion"]),
  category: z.enum([
    "logic_error",
    "boundary_error",
    "null_pointer",
    "buffer_overflow",
    "integer_overflow",
    "resource_leak",
    "concurrency",
    "interrupt_conflict",
    "atomicity_violation",
    "coding_standard",
    "requirement_mismatch",
    "interface_error",
    "performance",
    "timing",
    // RS-15: dangling pointer / use-after-free
    "dangling_pointer",
    // RS-17: floating point traps (NaN, Inf, precision)
    "float_error",
    // RS-20: uninitialized variable / partial struct init
    "uninitialized_variable",
    // RS-23: double free (same pointer freed twice)
    "double_free",
    // RS-25: misaligned memory access (pointer cast violates alignment)
    "alignment_error",
    "other",
  ]),
  location: z.object({
    file_path: z.string(),
    line_start: z.number(),
    line_end: z.number().optional(),
    function_name: z.string().optional(),
    function_id: z.string().optional(),
  }),
  title: z.string(),
  description: z.string(),
  rule_id: z.string().optional(),
  raw_finding_id: z.string().optional(),
  related_requirement_ids: z.array(z.string()).default([]),
  status: z
    .enum(["open", "confirmed", "fixed", "waived", "false_positive"])
    .default("open"),
  waiver_reason: z.string().optional(),
  detected_by: z.string(),
  detected_date: z.string(),
})
export type Defect = z.infer<typeof Defect>

/** Defect database — aggregation of all phase defects */
export const DefectDatabase = z.object({
  project_name: z.string(),
  defects: z.array(Defect),
  summary: z.object({
    total: z.number(),
    by_source: z.record(z.string(), z.number()),
    by_severity: z.record(z.string(), z.number()),
    by_category: z.record(z.string(), z.number()),
    by_status: z.record(z.string(), z.number()),
    open_critical: z.number(),
  }),
})
export type DefectDatabase = z.infer<typeof DefectDatabase>
