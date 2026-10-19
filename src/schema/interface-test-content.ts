import { z } from "zod"
import { Phase2SourceRefs } from "./phase2-source-ref"

export const InterfaceDirection = z.enum(["send", "receive", "bidirectional"])

export const InterfaceTestIdentifierDiscovery = z.object({
  interfaces: z.array(z.object({
    interface_id: z.string().min(1),
    interface_name: z.string().min(1),
    section_titles: z.array(z.string()).min(1),
    order: z.number().int().nonnegative(),
  }).strict()),
  open_questions: z.array(z.string()).default([]),
}).strict()

export const InterfaceTestBatchTarget = z.object({
  batch_id: z.string(),
  order: z.number().int().nonnegative(),
  interface_name: z.string(),
  interface_id: z.string(),
  topic: z.string(),
  directions: z.array(InterfaceDirection).min(1),
  hardware_keywords: z.array(z.string()),
  functional_keywords: z.array(z.string()),
})

export const InterfaceTestPlan = z.object({
  version: z.literal("2.2"),
  source_artifacts_path: z.string(),
  hardware_interface_report_text_path: z.string(),
  functional_test_content_path: z.string(),
  batches: z.array(InterfaceTestBatchTarget),
  reused_batch_ids: z.array(z.string()).default([]),
})

/** One raw/final row matching the six columns of table 4.3-1. */
export const InterfaceTestTableRow = z.object({
  interface_requirement_description: z.string().min(1),
  test_requirement_id: z.string().min(1),
  source_refs: Phase2SourceRefs,
  related_description: z.string().min(1),
  interface_name: z.string().min(1),
  interface_id: z.string().min(1),
}).strict()

export const InterfaceTestBatchRaw = z.object({
  batch_id: z.string().default(""),
  interface_name: z.string().default(""),
  interface_id: z.string().default(""),
  rows: z.array(InterfaceTestTableRow.extend({
    test_requirement_id: z.string().default(""),
    interface_name: z.string().default(""),
    interface_id: z.string().default(""),
  })),
  open_questions: z.array(z.string()).default([]),
}).strict()

export const InterfaceTestGap = z.object({
  batch_id: z.string(),
  topic: z.string(),
  interface_name: z.string(),
  questions: z.array(z.string()).min(1),
})

export const InterfaceTestContent = z.object({
  version: z.literal("2.0"),
  chapter_title_no: z.literal("4.3"),
  chapter_title: z.literal("接口测试"),
  section_title_no: z.literal("4.3.1"),
  section_title: z.literal("接口需求项[TR-JK]"),
  source_paths: z.object({
    source_artifacts_path: z.string(),
    hardware_interface_report_text_path: z.string(),
    functional_test_content_path: z.string(),
  }),
  source_hashes: z.object({
    hardware_interface_hash: z.string(),
    plan_hash: z.string(),
  }),
  rows: z.array(InterfaceTestTableRow),
  test_requirements: z.object({
    sufficiency: z.literal("C1、C2"),
    termination: z.literal("Z1、Z2"),
    priority: z.literal("高优先级"),
  }),
  summary: z.object({
    total: z.number().int().nonnegative(),
    gap_count: z.number().int().nonnegative(),
    reused_batch_count: z.number().int().nonnegative(),
  }),
})

export const InterfaceTestGaps = z.object({
  version: z.literal("1.0"),
  gaps: z.array(InterfaceTestGap),
  summary: z.object({ total: z.number().int().nonnegative() }),
})

export type InterfaceTestBatchTarget = z.infer<typeof InterfaceTestBatchTarget>
export type InterfaceTestPlan = z.infer<typeof InterfaceTestPlan>
export type InterfaceTestBatchRaw = z.infer<typeof InterfaceTestBatchRaw>
export type InterfaceTestTableRow = z.infer<typeof InterfaceTestTableRow>
export type InterfaceTestContent = z.infer<typeof InterfaceTestContent>
export type InterfaceTestGaps = z.infer<typeof InterfaceTestGaps>
