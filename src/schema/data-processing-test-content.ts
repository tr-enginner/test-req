import { z } from "zod"
import { SourceBackedRawRequirementFields, SourceBackedRequirementFields } from "./phase2-source-ref"

export const DataProcessingRelatedDescription = z.enum([
  "数据采集",
  "数据转换",
  "数据剔除",
  "数据融合",
  "数据解释",
])

const DataProcessingTestRowContent = {
  data_processing_requirement_description: z.string().min(1),
  related_description: z.string().min(1),
} as const
export const DataProcessingTestRawRow = z.object({ ...SourceBackedRawRequirementFields, ...DataProcessingTestRowContent }).strict()
export const DataProcessingTestTableRow = z.object({ ...SourceBackedRequirementFields, ...DataProcessingTestRowContent }).strict()

export const DataProcessingTestRaw = z.object({
  rows: z.array(DataProcessingTestRawRow),
  open_questions: z.array(z.string()).default([]),
}).strict()

export const DataProcessingTestGap = z.object({
  question: z.string().min(1),
})

export const DataProcessingTestContent = z.object({
  version: z.literal("2.0"),
  chapter_title_no: z.literal("4.7"),
  chapter_title: z.literal("数据处理测试"),
  section_title_no: z.literal("4.7.1"),
  section_title: z.literal("数据处理需求项[TR-SC]"),
  source_artifacts_path: z.string(),
  rows: z.array(DataProcessingTestTableRow),
  test_requirements: z.object({
    sufficiency: z.literal("C1、C2"),
    termination: z.literal("Z1、Z2"),
    priority: z.literal("高优先级"),
  }),
  summary: z.object({
    total: z.number().int().nonnegative(),
    gap_count: z.number().int().nonnegative(),
  }),
}).strict()

export const DataProcessingTestGaps = z.object({
  version: z.literal("1.0"),
  gaps: z.array(DataProcessingTestGap),
  summary: z.object({ total: z.number().int().nonnegative() }),
}).strict()

export type DataProcessingTestTableRow = z.infer<typeof DataProcessingTestTableRow>
export type DataProcessingTestRaw = z.infer<typeof DataProcessingTestRaw>
export type DataProcessingTestContent = z.infer<typeof DataProcessingTestContent>
export type DataProcessingTestGaps = z.infer<typeof DataProcessingTestGaps>
