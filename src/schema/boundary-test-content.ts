import { z } from "zod"
import { SourceBackedRawRequirementFields, SourceBackedRequirementFields } from "./phase2-source-ref"

const RELATED_SUFFIXES = [
  "数据输入域边界测试",
  "数据输入域端点测试",
  "数据输出域边界测试",
  "数据输出域端点测试",
] as const

export const BoundaryRelatedDescription = z.string().min(1).refine(
  (value) => RELATED_SUFFIXES.some((suffix) => value.length > suffix.length && value.endsWith(suffix))
    || value === "状态转换的边界点测试"
    || value === "状态转换的端点测试",
  "相关说明必须采用对象名称加受控后缀，或采用固定的状态转换分类",
)

const BoundaryTestRowContent = {
  boundary_requirement_description: z.string().min(1),
  related_description: z.string().min(1),
} as const
export const BoundaryTestRawRow = z.object({ ...SourceBackedRawRequirementFields, ...BoundaryTestRowContent }).strict()
export const BoundaryTestTableRow = z.object({ ...SourceBackedRequirementFields, ...BoundaryTestRowContent }).strict()

export const BoundaryTestRaw = z.object({
  rows: z.array(BoundaryTestRawRow),
  open_questions: z.array(z.string()).default([]),
}).strict()

export const BoundaryTestContent = z.object({
  version: z.literal("2.0"),
  chapter_title_no: z.literal("4.6"),
  chapter_title: z.literal("边界测试"),
  section_title_no: z.literal("4.6.1"),
  section_title: z.literal("边界需求项[TR-BJ]"),
  source_artifacts_path: z.string(),
  rows: z.array(BoundaryTestTableRow),
  test_requirements: z.object({
    sufficiency: z.literal("C1、C2、C3、C4、C5"),
    termination: z.literal("Z1、Z2"),
    priority: z.literal("高优先级"),
  }),
  summary: z.object({
    total: z.number().int().nonnegative(),
    gap_count: z.number().int().nonnegative(),
  }),
}).strict()

export const BoundaryTestGaps = z.object({
  version: z.literal("1.0"),
  gaps: z.array(z.object({ question: z.string().min(1) })),
  summary: z.object({ total: z.number().int().nonnegative() }),
}).strict()

export type BoundaryTestTableRow = z.infer<typeof BoundaryTestTableRow>
export type BoundaryTestContent = z.infer<typeof BoundaryTestContent>
