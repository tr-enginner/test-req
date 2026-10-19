import { z } from "zod"
import { SourceBackedRawRequirementFields, SourceBackedRequirementFields } from "./phase2-source-ref"

export const MarginRelatedDescription = z.enum([
  "存储量的余量",
  "功能处理时间的余量",
  "输入/输出及通道的吞吐能力余量",
])

const MarginTestRowContent = {
  margin_requirement_description: z.string().min(1),
  related_description: z.string().min(1),
} as const
export const MarginTestRawRow = z.object({ ...SourceBackedRawRequirementFields, ...MarginTestRowContent }).strict()
export const MarginTestTableRow = z.object({ ...SourceBackedRequirementFields, ...MarginTestRowContent }).strict()

export const MarginTestRaw = z.object({
  rows: z.array(MarginTestRawRow),
  open_questions: z.array(z.string()).default([]),
}).strict()

export const MarginTestContent = z.object({
  version: z.literal("2.0"), chapter_title_no: z.literal("4.5"), chapter_title: z.literal("余量测试"),
  section_title_no: z.literal("4.5.1"), section_title: z.literal("余量需求项[TR-YL]"), source_artifacts_path: z.string(),
  rows: z.array(MarginTestTableRow),
  test_requirements: z.object({ sufficiency: z.literal("C1、C2"), termination: z.literal("Z1、Z2"), priority: z.literal("低优先级") }),
  summary: z.object({ total: z.number().int().nonnegative(), gap_count: z.number().int().nonnegative() }),
}).strict()

export const MarginTestGaps = z.object({
  version: z.literal("1.0"), gaps: z.array(z.object({ question: z.string().min(1) })),
  summary: z.object({ total: z.number().int().nonnegative() }),
}).strict()

export type MarginTestTableRow = z.infer<typeof MarginTestTableRow>
export type MarginTestContent = z.infer<typeof MarginTestContent>
