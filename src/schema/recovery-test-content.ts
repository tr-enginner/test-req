import { z } from "zod"
import { SourceBackedRawRequirementFields, SourceBackedRequirementFields } from "./phase2-source-ref"

export const RecoveryRelatedDescription = z.enum([
  "故障发生时保护系统状态",
  "切换备用硬件",
  "探测错误功能",
])

const RecoveryTestRowContent = {
  recovery_requirement_description: z.string().min(1),
  related_description: z.string().min(1),
} as const
export const RecoveryTestRawRow = z.object({ ...SourceBackedRawRequirementFields, ...RecoveryTestRowContent }).strict()
export const RecoveryTestTableRow = z.object({ ...SourceBackedRequirementFields, ...RecoveryTestRowContent }).strict()

export const RecoveryTestRaw = z.object({
  rows: z.array(RecoveryTestRawRow),
  open_questions: z.array(z.string()).default([]),
}).strict()

export const RecoveryTestGap = z.object({
  question: z.string().min(1),
})

export const RecoveryTestContent = z.object({
  version: z.literal("2.0"),
  chapter_title_no: z.literal("4.8"),
  chapter_title: z.literal("恢复性测试"),
  section_title_no: z.literal("4.8.1"),
  section_title: z.literal("恢复性需求项[TR-HF]"),
  source_artifacts_path: z.string(),
  rows: z.array(RecoveryTestTableRow),
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

export const RecoveryTestGaps = z.object({
  version: z.literal("1.0"),
  gaps: z.array(RecoveryTestGap),
  summary: z.object({ total: z.number().int().nonnegative() }),
}).strict()

export type RecoveryTestTableRow = z.infer<typeof RecoveryTestTableRow>
export type RecoveryTestRaw = z.infer<typeof RecoveryTestRaw>
export type RecoveryTestContent = z.infer<typeof RecoveryTestContent>
export type RecoveryTestGaps = z.infer<typeof RecoveryTestGaps>
