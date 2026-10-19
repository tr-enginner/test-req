import { z } from "zod"
import { SourceBackedRawRequirementFields, SourceBackedRequirementFields } from "./phase2-source-ref"

export const StrengthRelatedDescription = z.enum([
  "长时间连续不间断综合功能测试",
  "提供数据能力的饱和性试验指标",
])

const StrengthTestRowContent = {
  strength_requirement_description: z.string().min(1),
  related_description: z.string().min(1),
} as const
export const StrengthTestRawRow = z.object({ ...SourceBackedRawRequirementFields, ...StrengthTestRowContent }).strict()
export const StrengthTestTableRow = z.object({ ...SourceBackedRequirementFields, ...StrengthTestRowContent }).strict()

export const StrengthTestRaw = z.object({
  rows: z.array(StrengthTestRawRow),
  open_questions: z.array(z.string()).default([]),
}).strict()

export const StrengthTestGap = z.object({
  question: z.string().min(1),
})

export const StrengthTestContent = z.object({
  version: z.literal("2.0"),
  chapter_title_no: z.literal("4.9"),
  chapter_title: z.literal("强度测试"),
  section_title_no: z.literal("4.9.1"),
  section_title: z.literal("强度需求项[TR-QD]"),
  source_artifacts_path: z.string(),
  rows: z.array(StrengthTestTableRow),
  test_requirements: z.object({
    sufficiency: z.literal("C1、C2"),
    termination: z.literal("Z1、Z2"),
    priority: z.literal("低优先级"),
  }),
  summary: z.object({
    total: z.number().int().nonnegative(),
    gap_count: z.number().int().nonnegative(),
  }),
}).strict()

export const StrengthTestGaps = z.object({
  version: z.literal("1.0"),
  gaps: z.array(StrengthTestGap),
  summary: z.object({ total: z.number().int().nonnegative() }),
}).strict()

export type StrengthTestTableRow = z.infer<typeof StrengthTestTableRow>
export type StrengthTestRaw = z.infer<typeof StrengthTestRaw>
export type StrengthTestContent = z.infer<typeof StrengthTestContent>
export type StrengthTestGaps = z.infer<typeof StrengthTestGaps>
