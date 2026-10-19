import { z } from "zod"

/**
 * Cover information extracted from reference DOCX documents.
 * 18 metadata fields from the document cover page, review sheets, and tool tables.
 */
export const CoverInfo = z.object({
  // Basic fields (cover page)
  config_id: z.string().nullable(),
  file_name: z.string().nullable(),
  cover_date: z.string().nullable(),

  // Signature fields
  preparation: z.string().nullable(),
  proofread: z.string().nullable(),
  review: z.string().nullable(),
  std_review: z.string().nullable(),
  countersign: z.string().nullable(),
  approval: z.string().nullable(),

  // Extended fields (review sheets & tool tables)
  req_version: z.string().nullable(),
  design_version: z.string().nullable(),
  guide_version: z.string().nullable(),
  static_test_tool: z.string().nullable(),
  simulation_test_tool: z.string().nullable(),
  static_timing_analysis_tool: z.string().nullable(),
  resource_remain: z.string().nullable(),
  clock_remain: z.string().nullable(),
  develop_environment: z.string().nullable(),
})

export type CoverInfo = z.infer<typeof CoverInfo>
