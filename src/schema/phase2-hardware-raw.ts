import { z } from "zod"
import { Phase2SourceRefs } from "./phase2-source-ref"

const table = z.union([z.string(), z.object({ table_id: z.string().optional() }).strict()])
const tables = z.array(table).optional()
const flow = z.string().optional()
export const HardwareCandidatesRaw = z.object({
  model_version: z.literal(1), source_artifacts_path: z.string().min(1),
  candidates: z.array(z.object({
    candidate_id: z.string().optional(), interface_name: z.string().min(1),
    interface_kind: z.enum(["can", "fpga", "ad", "serial", "spi", "spacewire", "watchdog", "gpio", "discrete", "ethernet", "mil1553b", "i2c", "other"]),
    keywords: z.array(z.string()).min(1), source_refs: Phase2SourceRefs,
    evidence_summary: z.string().min(1),
  }).strict()),
}).strict()

const topic = z.object({
  title: z.string(), source_refs: Phase2SourceRefs,
  input_flow: flow, output_flow: flow, input_tables: tables, output_tables: tables,
}).strict()

export const HardwareInterfaceRaw = z.object({
  interface: z.object({
    candidate_id: z.string().optional(), interface_id: z.string().optional(),
    interface_name: z.string().optional(), interface_kind: z.string().optional(),
    title: z.string(), overview: z.string(), source_refs: Phase2SourceRefs,
    overview_tables: z.array(table), topics: z.array(topic).optional(),
    input_flow: flow, output_flow: flow, input_tables: tables, output_tables: tables,
  }).strict().nullable(),
}).strict()
