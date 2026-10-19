import { z } from "zod"

/**
 * Shared report metadata — included in every report schema.
 * Source of truth: SoftwareAnalysisReport (Phase 1, Analyst).
 * Downstream reports copy these values to remain self-contained.
 */
export const ReportMeta = z.object({
  /** Project name — extracted by Analyst from documents/code */
  project_name: z.string(),
  /** Code baseline version under test */
  version: z.string(),
  /** ISO date string when this artifact was created */
  created_date: z.string(),
})
export type ReportMeta = z.infer<typeof ReportMeta>
