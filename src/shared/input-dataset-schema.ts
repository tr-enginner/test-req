import { z } from "zod"

export const InputDatasetLevel = z.enum(["normal", "boundary", "abnormal"])
export type InputDatasetLevel = z.infer<typeof InputDatasetLevel>

export const InputDatasetRecord = z.object({
  dataset_id: z.string(),
  level: InputDatasetLevel,
  fields: z.record(z.string(), z.string()),
  semantics: z.record(z.string(), z.string()).default({}),
  notes: z.array(z.string()).default([]),
})
export type InputDatasetRecord = z.infer<typeof InputDatasetRecord>

export const InputDatasetFile = z.object({
  protocol_name: z.string(),
  format: z.string().default("generic"),
  input_flow: z.string().default(""),
  source_protocol_file: z.string(),
  datasets: z.array(InputDatasetRecord).nonempty(),
})
export type InputDatasetFile = z.infer<typeof InputDatasetFile>

export interface InputDatasetIndexEntry {
  protocol_name: string
  file_path: string
  default_dataset_id: string
  input_flow?: string
}
