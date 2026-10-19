import { z } from "zod"
import { Phase2SourceRefs } from "./phase2-source-ref"

export const Chapter1ReferenceSchema = z.object({
  document_id: z.string(),
  document_title: z.string(),
  source_kind: z.string(),
  evidence: z.string(),
}).strict()

const Chapter1ScopeFields = {
  source_refs: Phase2SourceRefs,
  document_id: z.string(),
  document_version: z.literal("1.00"),
  software_name_and_id: z.string(),
  model_name: z.string(),
  client_address: z.string(),
  system_name: z.string(),
  csci_names: z.array(z.string()),
  code_version: z.string(),
  programming_languages: z.array(z.enum(["c", "x86_assembly", "mcs51_assembly"])),
  references: z.array(Chapter1ReferenceSchema),
  warnings: z.array(z.string()),
}

export const Chapter1ScopeRawSchema = z.object(Chapter1ScopeFields).strict()
export const Chapter1ScopeSchema = z.object({
  version: z.literal("2.0"),
  source_artifacts_path: z.string().min(1),
  ...Chapter1ScopeFields,
}).strict()

export type Chapter1Scope = z.infer<typeof Chapter1ScopeSchema>
export type Chapter1Reference = z.infer<typeof Chapter1ReferenceSchema>
