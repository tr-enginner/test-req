import { z } from "zod"
import { Phase2SourceRefs } from "./phase2-source-ref"

export const Chapter2DynamicTableSchema = z.object({
  title: z.string(),
  columns: z.array(z.string().trim().min(1, "column name must not be empty")).min(1),
  rows: z.array(z.array(z.string())),
}).strict().superRefine((table, ctx) => {
  table.rows.forEach((row, index) => {
    if (row.length !== table.columns.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["rows", index], message: "row length must equal columns length" })
  })
})

export const Chapter2InterruptSchema = z.object({
  interrupt_name: z.string(),
  priority: z.string(),
  frequency_or_random: z.string(),
  trigger_mode: z.string(),
  execution_function: z.string(),
}).strict()

const Chapter2SystemOverviewFields = {
  source_refs: Phase2SourceRefs,
  system_relationship: z.string(),
  processor_type: z.string(),
  processor_frequency: z.string(),
  memory_io_summary: z.string(),
  memory_io_tables: z.array(Chapter2DynamicTableSchema),
  interrupts: z.array(Chapter2InterruptSchema),
  software_name_and_id: z.string(),
  software_level: z.enum(["A", "B", "C"]),
  programming_language: z.string(),
  developer_unit_name: z.string(),
  subsystem_and_software_functions: z.array(z.string()),
  development_platform: z.string(),
  compilation_environment: z.string(),
  warnings: z.array(z.string()),
}

export const Chapter2SystemOverviewRawSchema = z.object({
  ...Chapter2SystemOverviewFields,
  memory_io_tables: z.array(z.object({ title: z.string(), columns: z.array(z.string()), rows: z.array(z.array(z.string())) }).strict()),
}).strict()
export const Chapter2SystemOverviewSchema = z.object({
  version: z.literal("2.0"),
  source_artifacts_path: z.string().min(1),
  ...Chapter2SystemOverviewFields,
}).strict()

export type Chapter2SystemOverview = z.infer<typeof Chapter2SystemOverviewSchema>
export type Chapter2DynamicTable = z.infer<typeof Chapter2DynamicTableSchema>
