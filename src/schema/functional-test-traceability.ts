import { z } from "zod"

export const FunctionalTestTraceabilityRow = z.object({
  source_ref: z.string().min(1),
  document_name: z.literal("需求规格说明"),
  section_number: z.string().regex(/^\d+(?:\.\d+)*$/),
  section_title: z.string().min(1),
  test_requirement_ids: z.array(z.string().min(1)),
}).strict()

export const FunctionalTestTraceability = z.object({
  version: z.literal("3.0"),
  source_artifacts_path: z.string().min(1),
  rows: z.array(FunctionalTestTraceabilityRow),
  chapter_source_refs: z.array(z.object({ chapter: z.enum(["1", "2"]), source_refs: z.array(z.string().min(1)) }).strict()),
  summary: z.object({ row_count: z.number().int().nonnegative(), requirement_count: z.number().int().nonnegative() }).strict(),
}).strict()

export const FunctionalTestTraceabilityGap = z.object({ requirement_id: z.string().optional(), source_ref: z.string().optional(), title: z.string().optional(), message: z.string().min(1) }).strict()
export const FunctionalTestTraceabilityGaps = z.object({ version: z.literal("3.0"), gaps: z.array(FunctionalTestTraceabilityGap), summary: z.object({ total: z.number().int().nonnegative() }).strict() }).strict()
export type FunctionalTestTraceabilityRow = z.infer<typeof FunctionalTestTraceabilityRow>
export type FunctionalTestTraceability = z.infer<typeof FunctionalTestTraceability>
export type FunctionalTestTraceabilityGap = z.infer<typeof FunctionalTestTraceabilityGap>
export type FunctionalTestTraceabilityGaps = z.infer<typeof FunctionalTestTraceabilityGaps>
