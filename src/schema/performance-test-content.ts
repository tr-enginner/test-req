import { z } from "zod"
import { SourceBackedRawRequirementFields, SourceBackedRequirementFields } from "./phase2-source-ref"

export const PerformanceRelatedDescription = z.enum([
  "时间间隔",
  "处理时间",
  "处理精度",
  "响应时间",
  "隐含需求：时间间隔",
  "隐含需求：处理时间",
  "隐含需求：处理精度",
  "隐含需求：响应时间",
])

const PerformanceTestRowContent = {
  performance_requirement_description: z.string().min(1),
  related_description: z.string().min(1),
} as const

export const PerformanceTestRawRow = z.object({ ...SourceBackedRawRequirementFields, ...PerformanceTestRowContent }).strict()
export const PerformanceTestTableRow = z.object({ ...SourceBackedRequirementFields, ...PerformanceTestRowContent }).strict()

export const PerformanceTestRaw = z.object({
  rows: z.array(PerformanceTestRawRow),
  open_questions: z.array(z.string()).default([]),
}).strict()

export const PerformanceTestGap = z.object({
  question: z.string().min(1),
})

export const PerformanceTestContent = z.object({
  version: z.literal("2.0"),
  chapter_title_no: z.literal("4.2"),
  chapter_title: z.literal("性能测试"),
  section_title_no: z.literal("4.2.1"),
  section_title: z.literal("性能需求项[TR-XN]"),
  source_artifacts_path: z.string(),
  rows: z.array(PerformanceTestTableRow),
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

export const PerformanceTestGaps = z.object({
  version: z.literal("1.0"),
  gaps: z.array(PerformanceTestGap),
  summary: z.object({ total: z.number().int().nonnegative() }),
}).strict()

export type PerformanceTestTableRow = z.infer<typeof PerformanceTestTableRow>
export type PerformanceTestRaw = z.infer<typeof PerformanceTestRaw>
export type PerformanceTestContent = z.infer<typeof PerformanceTestContent>
export type PerformanceTestGaps = z.infer<typeof PerformanceTestGaps>
