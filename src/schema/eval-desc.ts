import { z } from "zod"

/** Range mapping: maps a template placeholder to a section range in the reference document */
export const RangeMapping = z.object({
  placeholder: z.string().describe("模板中的占位符 e.g. {{chapter_1}}"),
  startTitle: z.string().describe("起始标题"),
  endTitle: z.string().optional().describe("终止标题 (optional for last section)"),
  includeStartTitle: z.boolean().default(false),
  includeEndTitle: z.boolean().default(false),
  dynamicContent: z
    .object({
      enabled: z.boolean(),
      type: z.string().describe("function_test | logical_test | ..."),
      contentLibraryFile: z.string().optional(),
    })
    .optional(),
})
export type RangeMapping = z.infer<typeof RangeMapping>

/** Configuration for eval description document generation */
export const EvalDescConfig = z.object({
  docType: z.enum(["software", "fpga"]),
  templatePath: z.string(),
  referencePath: z.string(),
  contentLibraryPath: z.string().optional(),
  outputPath: z.string().optional(),
  rangeMappings: z.array(RangeMapping),
})
export type EvalDescConfig = z.infer<typeof EvalDescConfig>
