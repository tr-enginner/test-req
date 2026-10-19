import { z } from "zod"

/** Single test requirement item extracted from outline Section 6.2 */
export const OutlineTrItem = z.object({
  funId: z.string().describe("测试项标识 (header row cell[3])"),
  name: z.string().optional().describe("测试项名称 (header row cell[1])"),
  handling: z.string().describe("测试项描述"),
  reqDesc: z.string().optional().describe("需求描述"),
  sufficiency: z.string().optional().describe("充分性要求"),
  testMethod: z.string().optional().describe("测试方法"),
  passCriteria: z.string().optional().describe("通过准则"),
  priority: z.string().optional().describe("优先级 (header row cell[5])"),
  tracing: z.string().optional().describe("追踪关系"),
  path: z.string().optional().describe('章节路径 e.g. "/6/2/1/"'),
})
export type OutlineTrItem = z.infer<typeof OutlineTrItem>

/** Test requirements grouped by test category (section heading) */
export const OutlineSection = z.object({
  title: z.string().describe('章节标题如 "功能测试"'),
  funItem: z.array(OutlineTrItem).describe("该类别下的所有 TR"),
})
export type OutlineSection = z.infer<typeof OutlineSection>

/** Complete extraction result from an outline document */
export const OutlineParsingResult = z.object({
  docType: z.enum(["software", "fpga"]),
  softwareId: z.string().optional(),
  codeVersion: z.string().optional(),
  chapterTrList: z.array(OutlineSection).describe("兼容 testcase_generator_run 的 CNAS 格式"),
  totalTrCount: z.number(),
})
export type OutlineParsingResult = z.infer<typeof OutlineParsingResult>
