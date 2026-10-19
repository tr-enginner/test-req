import { z } from "zod"
import {
  DataFlowGraph,
  FunctionInfo,
  GapEntry,
  InterfaceDefinition,
  OrphanEntry,
  RuntimeEnvironment,
  SoftwareModule,
  SoftwareRequirement,
  TraceabilityEntry,
} from "./sut"

export const SOFTWARE_ANALYSIS_STAGE_IDS = [
  "01-project",
  "02-requirements",
  "03-code",
  "04-compilation",
  "05-traceability",
  "06-finalize",
] as const

export type SoftwareAnalysisStageId = (typeof SOFTWARE_ANALYSIS_STAGE_IDS)[number]

const MetadataFields = {
  project_name: z.string().optional(),
  version: z.string().optional(),
  csci_name: z.string().optional(),
  system_name: z.string().optional(),
  software_level: z.string().optional(),
  developer_org: z.string().optional(),
}

export const SoftwareAnalysisStage01Payload = z.object({
  ...MetadataFields,
  source_code_dirs: z.array(z.string()).default([]),
  requirement_document_paths: z.array(z.string()).default([]),
  include_dirs: z.array(z.string()).default([]),
  excluded_dirs: z.array(z.string()).default([]),
  build_files: z.array(z.string()).default([]),
})
export type SoftwareAnalysisStage01Payload = z.infer<typeof SoftwareAnalysisStage01Payload>

export const SoftwareAnalysisStage02Payload = z.object({
  requirements: z.array(SoftwareRequirement),
  interfaces: z.array(InterfaceDefinition).default([]),
})
export type SoftwareAnalysisStage02Payload = z.infer<typeof SoftwareAnalysisStage02Payload>

export const SoftwareAnalysisStage03FunctionChunkRef = z.object({
  chunk_index: z.number().int().nonnegative(),
  file_path: z.string(),
  function_count: z.number().int().nonnegative(),
  first_function_id: z.string().optional(),
  last_function_id: z.string().optional(),
})
export type SoftwareAnalysisStage03FunctionChunkRef = z.infer<typeof SoftwareAnalysisStage03FunctionChunkRef>

export const SoftwareAnalysisStage03FunctionIndexEntry = z.object({
  id: z.string(),
  name: z.string(),
  file_path: z.string(),
  line_range: z.object({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
  }),
  return_type: z.string().optional(),
  parameters: z.array(
    z.object({
      name: z.string(),
      type: z.string(),
      description: z.string().optional(),
    }),
  ).optional(),
  calls: z.array(z.string()).default([]),
  called_by: z.array(z.string()).default([]),
  safety_critical: z.boolean().default(false),
  chunk_index: z.number().int().nonnegative().optional(),
  chunk_file_path: z.string().optional(),
})
export type SoftwareAnalysisStage03FunctionIndexEntry = z.infer<typeof SoftwareAnalysisStage03FunctionIndexEntry>

export const SoftwareAnalysisStage03FunctionChunk = z.object({
  artifact_type: z.literal("software-analysis-stage-03-function-chunk"),
  schema_version: z.literal(1),
  stage_id: z.literal("03-code"),
  chunk_index: z.number().int().nonnegative(),
  created_date: z.string(),
  functions: z.array(FunctionInfo),
})
export type SoftwareAnalysisStage03FunctionChunk = z.infer<typeof SoftwareAnalysisStage03FunctionChunk>

export const SoftwareAnalysisStage03Payload = z.object({
  functions: z.array(FunctionInfo).default([]),
  function_index: z.array(SoftwareAnalysisStage03FunctionIndexEntry).default([]),
  function_chunks: z.array(SoftwareAnalysisStage03FunctionChunkRef).default([]),
  modules: z.array(SoftwareModule),
  data_flow_graph: DataFlowGraph,
  total_loc: z.number().int().nonnegative().default(0),
})
export type SoftwareAnalysisStage03Payload = z.infer<typeof SoftwareAnalysisStage03Payload>

export const SoftwareAnalysisStage04Payload = z.object({
  compile_commands_path: z.string(),
  compilation_env_path: z.string(),
  stubs_dir: z.string().optional(),
  preprocessed_dir: z.string().optional(),
  compile_commands_count: z.number().int().nonnegative().optional(),
  files_indexed: z.number().int().nonnegative().optional(),
  missing_headers_count: z.number().int().nonnegative().optional(),
  stub_count: z.number().int().nonnegative().optional(),
})
export type SoftwareAnalysisStage04Payload = z.infer<typeof SoftwareAnalysisStage04Payload>

export const SOFTWARE_ANALYSIS_STAGE_05_CHUNK_KINDS = [
  "traceability_matrix",
  "gap_analysis",
  "orphan_analysis",
] as const
export type SoftwareAnalysisStage05ChunkKind = (typeof SOFTWARE_ANALYSIS_STAGE_05_CHUNK_KINDS)[number]

export const SoftwareAnalysisStage05ChunkRef = z.object({
  chunk_kind: z.enum(SOFTWARE_ANALYSIS_STAGE_05_CHUNK_KINDS),
  chunk_index: z.number().int().nonnegative(),
  file_path: z.string(),
  entry_count: z.number().int().nonnegative(),
})
export type SoftwareAnalysisStage05ChunkRef = z.infer<typeof SoftwareAnalysisStage05ChunkRef>

export const SoftwareAnalysisStage05TraceabilityChunk = z.object({
  artifact_type: z.literal("software-analysis-stage-05-chunk"),
  schema_version: z.literal(1),
  stage_id: z.literal("05-traceability"),
  chunk_kind: z.literal("traceability_matrix"),
  chunk_index: z.number().int().nonnegative(),
  created_date: z.string(),
  entries: z.array(TraceabilityEntry),
})
export type SoftwareAnalysisStage05TraceabilityChunk = z.infer<typeof SoftwareAnalysisStage05TraceabilityChunk>

export const SoftwareAnalysisStage05GapChunk = z.object({
  artifact_type: z.literal("software-analysis-stage-05-chunk"),
  schema_version: z.literal(1),
  stage_id: z.literal("05-traceability"),
  chunk_kind: z.literal("gap_analysis"),
  chunk_index: z.number().int().nonnegative(),
  created_date: z.string(),
  entries: z.array(GapEntry),
})
export type SoftwareAnalysisStage05GapChunk = z.infer<typeof SoftwareAnalysisStage05GapChunk>

export const SoftwareAnalysisStage05OrphanChunk = z.object({
  artifact_type: z.literal("software-analysis-stage-05-chunk"),
  schema_version: z.literal(1),
  stage_id: z.literal("05-traceability"),
  chunk_kind: z.literal("orphan_analysis"),
  chunk_index: z.number().int().nonnegative(),
  created_date: z.string(),
  entries: z.array(OrphanEntry),
})
export type SoftwareAnalysisStage05OrphanChunk = z.infer<typeof SoftwareAnalysisStage05OrphanChunk>

export const SoftwareAnalysisStage05ChunkArtifact = z.discriminatedUnion("chunk_kind", [
  SoftwareAnalysisStage05TraceabilityChunk,
  SoftwareAnalysisStage05GapChunk,
  SoftwareAnalysisStage05OrphanChunk,
])
export type SoftwareAnalysisStage05ChunkArtifact = z.infer<typeof SoftwareAnalysisStage05ChunkArtifact>

export const SoftwareAnalysisStage05Payload = z.object({
  traceability_matrix: z.array(TraceabilityEntry).default([]),
  traceability_chunks: z.array(SoftwareAnalysisStage05ChunkRef).default([]),
  gap_analysis: z.array(GapEntry).default([]),
  gap_chunks: z.array(SoftwareAnalysisStage05ChunkRef).default([]),
  orphan_analysis: z.array(OrphanEntry).default([]),
  orphan_chunks: z.array(SoftwareAnalysisStage05ChunkRef).default([]),
  runtime_environment: RuntimeEnvironment.optional(),
  main_functions_summary: z.string().optional(),
})
export type SoftwareAnalysisStage05Payload = z.infer<typeof SoftwareAnalysisStage05Payload>

export const SoftwareAnalysisStage06Payload = z.object({
  ...MetadataFields,
  validation_summary: z.record(z.string(), z.unknown()).optional(),
})
export type SoftwareAnalysisStage06Payload = z.infer<typeof SoftwareAnalysisStage06Payload>

const SoftwareAnalysisStageEnvelopeBase = z.object({
  artifact_type: z.literal("software-analysis-stage"),
  schema_version: z.literal(1),
  stage_id: z.enum(SOFTWARE_ANALYSIS_STAGE_IDS),
  created_date: z.string(),
})

export const SoftwareAnalysisStageArtifact = z.discriminatedUnion("stage_id", [
  SoftwareAnalysisStageEnvelopeBase.extend({
    stage_id: z.literal("01-project"),
    payload: SoftwareAnalysisStage01Payload,
  }),
  SoftwareAnalysisStageEnvelopeBase.extend({
    stage_id: z.literal("02-requirements"),
    payload: SoftwareAnalysisStage02Payload,
  }),
  SoftwareAnalysisStageEnvelopeBase.extend({
    stage_id: z.literal("03-code"),
    payload: SoftwareAnalysisStage03Payload,
  }),
  SoftwareAnalysisStageEnvelopeBase.extend({
    stage_id: z.literal("04-compilation"),
    payload: SoftwareAnalysisStage04Payload,
  }),
  SoftwareAnalysisStageEnvelopeBase.extend({
    stage_id: z.literal("05-traceability"),
    payload: SoftwareAnalysisStage05Payload,
  }),
  SoftwareAnalysisStageEnvelopeBase.extend({
    stage_id: z.literal("06-finalize"),
    payload: SoftwareAnalysisStage06Payload,
  }),
])
export type SoftwareAnalysisStageArtifact = z.infer<typeof SoftwareAnalysisStageArtifact>

export const SoftwareAnalysisStageManifestEntry = z.object({
  stage_id: z.enum(SOFTWARE_ANALYSIS_STAGE_IDS),
  file_path: z.string(),
  exists: z.boolean(),
  updated_date: z.string().optional(),
  summary: z.record(z.string(), z.unknown()).optional(),
})
export type SoftwareAnalysisStageManifestEntry = z.infer<typeof SoftwareAnalysisStageManifestEntry>

export const SoftwareAnalysisStageManifest = z.object({
  artifact_type: z.literal("software-analysis-stage-manifest"),
  schema_version: z.literal(1),
  created_date: z.string(),
  updated_date: z.string(),
  finalized_output_path: z.string().optional(),
  stages: z.record(z.enum(SOFTWARE_ANALYSIS_STAGE_IDS), SoftwareAnalysisStageManifestEntry),
})
export type SoftwareAnalysisStageManifest = z.infer<typeof SoftwareAnalysisStageManifest>
