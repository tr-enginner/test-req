import { z } from "zod"
import { SourceBackedRawRequirementFields, SourceBackedRequirementFields } from "./phase2-source-ref"

export const ReliabilitySafetyRelatedDescription = z.enum([
  "提高安全性的容错方案",
  "异常条件下系统的处理和保护能力",
  "异常条件下软件的处理和保护能力",
  // Legacy compatibility only. New model output must choose system or software.
  "异常条件下系统软件的处理和保护能力",
  "输入故障模式的测试",
])

const ReliabilitySafetyTestRowContent = {
  reliability_safety_requirement_description: z.string().min(1),
  related_description: z.string().min(1),
} as const
export const ReliabilitySafetyTestRawRow = z.object({ ...SourceBackedRawRequirementFields, ...ReliabilitySafetyTestRowContent }).strict()
export const ReliabilitySafetyTestTableRow = z.object({ ...SourceBackedRequirementFields, ...ReliabilitySafetyTestRowContent }).strict()

export const ReliabilitySafetyTestRaw = z.object({
  rows: z.array(ReliabilitySafetyTestRawRow),
  open_questions: z.array(z.string()).default([]),
}).strict()

export const ReliabilitySafetyTestContent = z.object({
  version: z.literal("2.0"), chapter_title_no: z.literal("4.4"), chapter_title: z.literal("可靠性安全性测试"),
  section_title_no: z.literal("4.4.1"), section_title: z.literal("可靠性安全性需求项[TR-AQ]"), source_artifacts_path: z.string(),
  rows: z.array(ReliabilitySafetyTestTableRow),
  test_requirements: z.object({ sufficiency: z.literal("C1、C2"), termination: z.literal("Z1、Z2"), priority: z.literal("低优先级") }),
  summary: z.object({ total: z.number().int().nonnegative(), gap_count: z.number().int().nonnegative() }),
}).strict()

export const ReliabilitySafetyTestGaps = z.object({
  version: z.literal("1.0"), gaps: z.array(z.object({ question: z.string().min(1) })),
  summary: z.object({ total: z.number().int().nonnegative() }),
}).strict()

export type ReliabilitySafetyTestTableRow = z.infer<typeof ReliabilitySafetyTestTableRow>
export type ReliabilitySafetyTestContent = z.infer<typeof ReliabilitySafetyTestContent>
