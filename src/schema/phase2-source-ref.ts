import { z } from "zod"

export const Phase2SourceRefs = z.preprocess(value => value == null ? [] : value, z.array(z.string()))
export const SourceBackedRequirementFields = {
  requirement_id: z.string().min(1),
  source_refs: Phase2SourceRefs,
} as const

export const SourceBackedRawRequirementFields = {
  // Models are still instructed not to emit this field.  It is optional so the
  // deterministic Phase 2 editor can persist an already assigned public TR id
  // and keep reviews stable after insertions/deletions.
  requirement_id: z.string().optional(),
  source_refs: Phase2SourceRefs,
} as const
