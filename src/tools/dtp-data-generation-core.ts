import type { ToolContext } from "@opencode-ai/plugin"
import type { OpencodeClient } from "@opencode-ai/sdk/client"
import { createHash } from "crypto"
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, type Dirent } from "fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "path"
import {
  sanitizeDtpExecutablePlaceholders,
  sanitizeDtpExecutableValue,
} from "../shared/phase6-placeholder-sanitizer"
import {
  applyDtpBlockFrameChecksums,
  buildDtpDataQualityReport,
  buildDtpProtocolRetryContext,
  buildDtpProtocolWriterPreview,
  writeDtpDataQualityReport,
  writeDtpProtocolDataFiles,
  writeDtpProtocolRetryContext,
  writeDtpProtocolWriterPreview,
} from "./dtp-protocol-artifacts"
import {
  buildDtpProtocolContextPackages as buildDtpProtocolContextPackagesImpl,
  buildDtpProtocolDefinitionsDocument as buildDtpProtocolDefinitionsDocumentImpl,
  getDtpPrimaryProtocolFrame,
  getDtpProtocolFrames,
  inferDtpSectionCanInterfaceIdentity,
  loadDtpProtocolDefinitions,
  mergeDtpProtocolDefinitionPatch,
  migrateDtpProtocolDefinitionsDocument,
  normalizeDtpProtocolDefinition,
  validateDtpProtocolDefinitions,
  writeDtpProtocolDefinitions as writeDtpProtocolDefinitionsImpl,
} from "./dtp-protocol-definitions"
import {
  allowDtpBusCommandDictionaryDefault,
  classifyDtpBusInterface,
  createDtpModelFallbackProfileRegistry,
  detectDtpBusType,
  documentedDtpBusFieldPlans,
  dtpBusProtocolEntityConflicts,
  dtpBusSelectorValuesEquivalent,
  encodeDtpBusTransport,
  inspectDtpBusTransport,
  resolveDtpBusFieldOption,
  resolveDtpBusFlowConstraint,
  selectDtpModelFallbackPolicy,
  validateDtpBusCasePlan,
  validateDtpBusGeneratedLines,
} from "./dtp-bus-adapters/registry"
import type {
  DtpModelFallbackClassification,
  DtpModelFallbackProfileRegistry,
  DtpModelFallbackProfileSelection,
  DtpModelFallbackProtocolFamily,
} from "./dtp-bus-adapters/types"
import { prepareSectionRelationModelInputs } from "./dtp-model-evidence"

export {
  applyDtpBlockFrameChecksums,
  buildDtpDataQualityReport,
  buildDtpProtocolRetryContext,
  buildDtpProtocolWriterPreview,
  writeDtpDataQualityReport,
  writeDtpProtocolDataFiles,
  writeDtpProtocolRetryContext,
  writeDtpProtocolWriterPreview,
} from "./dtp-protocol-artifacts"

const PROJECT_KNOWLEDGE_EXTRACTOR_VERSION = "2026-09-15-reference-ownership-v7"
const DOCUMENT_EXTRACTION_CACHE_SCHEMA_VERSION = "1.0.0"
const DOCUMENT_REFERENCE_GRAPH_SCHEMA_VERSION = "2.0.0"
const KNOWLEDGE_PACKAGE_MANIFEST_SCHEMA_VERSION = "2.0.0"
export const DTP_PROTOCOL_SCHEMA_VERSION = "4.0.0" as const
const FULL_MODEL_TABLE_MAX_ROWS = 30
const FULL_MODEL_TABLE_MAX_CELLS = 300
const FULL_MODEL_TABLE_MAX_CHARS = 10_000
const LARGE_MODEL_TABLE_MATCH_LIMIT = 12
const DEFAULT_DTP_MODEL_SECTION_TIMEOUT_MS = 100_000
const DEFAULT_DTP_PROTOCOL_UNDERSTANDING_TIMEOUT_MS = 100_000
const DEFAULT_DTP_CASE_STEP_RETRY_TIMEOUT_MS = 100_000
const DEFAULT_DTP_MODEL_SECTION_CONCURRENCY = 3
const DTP_PROTOCOL_RETRY_MAX_ATTEMPTS = 3
const DTP_PERFORMANCE_REPORT_SCHEMA_VERSION = "1.0.0"
const DTP_MODEL_CACHE_SCHEMA_VERSION = "1.0.0"
const DTP_PERFORMANCE_ESTIMATED_TOKEN_CHARS = 2
const DTP_PERFORMANCE_LARGE_PAYLOAD_TOKEN_THRESHOLD = 60_000
const DTP_MODEL_CACHE_PROMPT_VERSION = "2026-09-16-table-evidence-v6"
const DTP_CASE_STEP_MODEL_PROMPT_VERSION = "2026-09-08-protocol-identity-v17"
const DTP_PROTOCOL_COMPILER_VERSION = "2026-09-17-protocol-family-v36"
const DTP_CASE_STEP_PROJECT_EVIDENCE_MAX_CHARS = 4_000
const DTP_CASE_STEP_RETRY_MAX_ATTEMPTS = 1
const HARDWARE_TEST_ENVIRONMENT = "硬平台测试环境"

export type FlowDirection = "input" | "output" | "unknown"

export type DtpKnowledgeMode = "source" | "offline"

export type DtpDataGenerationOptions = {
  knowledgeMode?: DtpKnowledgeMode
}

export type PortableKnowledgeMetadata = {
  package_version: "1.0.0"
  source_project_root: string
  extractor_version: string
  content_hash: string
  created_at: string
}

export type DefaultPaths = {
  workspaceRoot: string
  matrixDataDir: string
  dtpArtifactsDir: string
  todoFile: string
  confirmationFile: string
  generatedDataFile: string
  generatedDiagnosticsIndexFile: string
  generatedCasesDir: string
  generatedDiagnosticsDir: string
  generatedArgumentRetryContextFile: string
  generatedDataFilesIndexFile: string
  projectKnowledgeIndexFile: string
  tableEvidenceIndexFile: string
  documentReferenceGraphFile: string
  protocolEvidenceTraceFile: string
  documentCacheDir: string
  knowledgePackageManifestFile: string
  commandDictionaryIndexFile: string
  dtpProtocolDefinitionsFile: string
  dtpProtocolWriterPreviewFile: string
  dtpDataQualityReportFile: string
  dtpProtocolRetryContextFile: string
  dtpPerformanceReportFile: string
  dtpCasePerformanceReportFile: string
  dtpModelCacheFile: string
  dtpModelCacheEntriesDir: string
  generatedDataFilesIndexCasesDir: string
  dtpRoot: string
  runtimeDir: string
  inputDataRoot: string
  keywordDir: string | null
}

export type TodoCaseId = string

export type ConfirmationCaseIndex = Map<string, ConfirmationCase>

export type SkippedConfirmationCase = {
  caseId: string
  translateStatus?: string
  reason: string
}

export type ConfirmationCaseLoadResult = {
  cases: ConfirmationCaseIndex
  skippedCases: Map<string, SkippedConfirmationCase>
}

export type ConfirmationCase = {
  caseId: string
  caseName?: string
  testPurpose?: string
  testEnvironment?: string
  translateStatus: "success"
  steps: ConfirmationStep[]
  raw?: unknown
}

export type ConfirmationStep = {
  stepIndex: number
  keywordName: string
  stepDescription?: string
  expectedResult?: string
  timeValue?: string | number
  raw?: unknown
}

export type KeywordCatalog = Map<string, KeywordDefinition>

export type KeywordDefinition = {
  keywordName: string
  txtPath: string
  jsonPath: string
  documentation?: string
  arguments: KeywordArgumentDef[]
  rawJson?: unknown
  rawText?: string
}

export type KeywordArgumentDef = {
  name: string
  comments?: string
  required?: boolean
}

export type GeneratedTestData = {
  schema_version: "1.0.0"
  project_name?: string
  source_files: {
    todo_file: string
    confirmation_tests_file: string
    keyword_dir: string
    generated_data_files_index?: string
    argument_retry_context?: string
    generated_test_data_file?: string
    diagnostics_index?: string
    case_checkpoint_dir?: string
    case_diagnostics_dir?: string
    performance_report?: string
    project_root: string
  }
  cases: GeneratedCase[]
  warnings: string[]
}

export type GeneratedRuntimeDataFile = Pick<
  GeneratedDataFile,
  | "argument_name"
  | "content_generation_required"
  | "requested_file_name"
  | "file_path"
  | "flow_direction"
  | "variant_type"
>

export type GeneratedRuntimeStep = {
  step_index: number
  keyword_name: string
  step_description?: string
  resolved_arguments: Array<Pick<ResolvedArgument, "name" | "value" | "semantic">>
  generated_data_files: GeneratedRuntimeDataFile[]
  warnings: string[]
}

export type GeneratedRuntimeCase = {
  case_id: string
  translate_status: "success"
  case_name?: string
  test_purpose?: string
  test_environment?: string
  generated_steps: GeneratedRuntimeStep[]
  warnings: string[]
}

export type GeneratedRuntimeTestData = {
  schema_version: "1.1.0"
  project_name?: string
  source_files: GeneratedTestData["source_files"]
  diagnostics: {
    index_file: string
    case_checkpoint_dir: string
    case_diagnostics_dir: string
  }
  cases: GeneratedRuntimeCase[]
  warnings: string[]
}

export type GeneratedTestDataDiagnosticsIndex = {
  schema_version: "1.0.0"
  source_data_file: string
  project_root: string
  summary: {
    case_count: number
    step_count: number
    passed_steps: number
    warning_steps: number
    failed_steps: number
  }
  cases: Array<{
    case_id: string
    diagnostic_file: string
    checkpoint_file: string
    step_count: number
    passed_steps: number
    warning_steps: number
    failed_steps: number
  }>
  warnings: string[]
  updated_at: string
}

export type GeneratedCase = {
  case_id: string
  translate_status: "success"
  case_name?: string
  test_purpose?: string
  test_environment?: string
  generated_steps: GeneratedStep[]
  warnings: string[]
}

export type GeneratedStep = {
  step_index: number
  keyword_name: string
  step_description?: string
  expected_result?: string
  keyword_arguments?: KeywordArgumentDef[]
  resolved_arguments: ResolvedArgument[]
  generated_data_files: GeneratedDataFile[]
  data_generation_plan?: CaseStepDataGenerationPlan
  data_quality?: StepDataQualityResult
  argument_quality?: ArgumentQualityResult
  warnings: string[]
  trace_notes: TraceNote[]
}

export type ArgumentQualityIssue = {
  severity: "error" | "warning"
  type:
    | "argument_count_mismatch"
    | "missing_argument"
    | "invalid_time"
    | "invalid_file_path"
    | "missing_file_artifact"
    | "unresolved_file_argument"
    | "low_confidence"
  argument_name?: string
  message: string
}

export type ArgumentQualityResult = {
  status: "pass" | "warning" | "failed"
  expected_argument_count: number
  actual_argument_count: number
  issues: ArgumentQualityIssue[]
}

export type ArgumentRetryContext = {
  schema_version: "1.0.0"
  status: "not_needed" | "ready"
  source_data_file: string
  generated_data_files_index_file: string
  cases: Array<{
    case_id: string
    case_name?: string
    test_purpose?: string
    steps: Array<{
      step_index: number
      keyword_name: string
      step_description?: string
      argument_quality: ArgumentQualityResult
      keyword_arguments: KeywordArgumentDef[]
      resolved_arguments: ResolvedArgument[]
      generated_data_files: GeneratedDataFile[]
      data_generation_plan?: CaseStepDataGenerationPlan
      data_quality?: StepDataQualityResult
      candidate_data_files: Array<{
        requested_file_name: string
        file_path: string
        protocol_name?: string
        confidence: number
        state: GeneratedDataFileIndexEntry["state"]
      }>
    }>
  }>
  warnings: string[]
  updated_at: string
}

export type ResolvedArgument = {
  name: string
  value: string | number | boolean
  semantic?: string
  source: string
  required?: boolean
  confidence?: number
  notes?: string[]
}

export type GeneratedDataFile = {
  argument_name: string
  content_generation_required: boolean
  requested_file_name: string
  file_path: string
  generation_basis: string[]
  checksum_rule?: string
  field_value_plan?: PacketFieldValuePlan[]
  flow_direction?: FlowDirection
  source_section?: string
  source_flow_heading?: string
  source_file_state?: "name-only-input" | "existing-validated-file" | "generated-from-documents" | "case-fallback"
  variant_type?: CaseStepDataGenerationPlan["variant_type"]
  base_file_path?: string
  format_notes?: string[]
}

export type GeneratedDataFileIndex = {
  schema_version: "1.0.0"
  project_root: string
  dtp_root: string
  runtime_dir: string
  input_data_root: string
  source_documents: string[]
  entries: GeneratedDataFileIndexEntry[]
  warnings: string[]
  updated_at: string
}

export type GeneratedDataFileIndexEntry = {
  id: string
  protocol_name?: string
  requested_file_name: string
  file_path: string
  absolute_file_path?: string
  source: "pre-generated" | "dynamic-generated" | "existing-file"
  source_documents: string[]
  generation_basis: string[]
  checksum_rule?: string
  field_value_plan?: PacketFieldValuePlan[]
  flow_direction?: FlowDirection
  source_section?: string
  source_flow_heading?: string
  confidence: number
  state: "candidate" | "generated" | "validated"
  warnings: string[]
}

export type ProjectKnowledgeIndex = {
  schema_version: "1.0.0"
  extractor_version: string
  project_root: string
  portable_metadata?: PortableKnowledgeMetadata
  source_documents: ProjectKnowledgeDocument[]
  topics: ProjectKnowledgeTopic[]
  snippets: ProjectKnowledgeSnippet[]
  tables: ProjectKnowledgeTable[]
  section_protocol_models: SectionProtocolModel[]
  packet_model_candidates: PacketModelCandidate[]
  references: ProjectKnowledgeReference[]
  warnings: string[]
  updated_at: string
}

export type DtpTableEvidenceIndexEntry = {
  table_id: string
  source_document_id: string
  section_model_ids: string[]
  section_paths: string[][]
  caption?: string
  headers: string[]
  row_count: number
  bus_scope: string[]
  flow_directions: FlowDirection[]
  semantic_roles: string[]
  aliases: string[]
  referenced_by: string[]
  references: string[]
}

export type DtpTableEvidenceIndex = {
  schema_version: "1.0.0"
  knowledge_content_hash: string
  tables: DtpTableEvidenceIndexEntry[]
  updated_at: string
}

export type SectionProtocolModel = {
  id: string
  source_document_id: string
  section_id?: string
  section_title: string
  section_path?: string[]
  chapter_role?: "interface_requirement" | "other"
  content_role?: "frame_definition" | "requirement_summary"
  section_snippet_ids: string[]
  input_flow_snippet_ids: string[]
  output_flow_snippet_ids: string[]
  table_ids: string[]
  primary_table_ids: string[]
  support_table_ids: string[]
  reference_backed?: boolean
  referenced_primary_table_ids?: string[]
  protocol_relations: SectionProtocolRelation[]
  protocols: SectionProtocol[]
  checksum_rule?: string
  confidence: number
  warnings: string[]
}

export type SectionProtocolRelation = {
  frame_table_id: string
  dictionary_table_id?: string
  generation_mode: "frame_file" | "one_file_per_dictionary_row"
  preferred_name?: string
  flow_direction?: FlowDirection
  source_section?: string
  source_flow_heading?: string
  file_name_field?: string
  data_code_field?: string
  field_value_plan?: PacketFieldValuePlan[]
  should_generate_frame_table_file: boolean
  checksum_rule?: string
  confidence: number
  reasoning: string[]
}

export type SectionProtocol = {
  name: string
  frame_table_id: string
  data_dictionary_table_ids: string[]
  generated_candidate_id?: string
  generation_mode?: SectionProtocolRelation["generation_mode"]
  flow_direction?: FlowDirection
  source_section?: string
  source_flow_heading?: string
  should_generate_frame_table_file?: boolean
  checksum_rule?: string
  basis: string[]
  confidence: number
}

export type PacketModelCandidate = {
  id: string
  name: string
  source_snippet_ids: string[]
  fields: PacketField[]
  field_value_plan?: PacketFieldValuePlan[]
  packet_lines?: string[][]
  byte_values: string[]
  checksum_rule?: string
  flow_direction?: FlowDirection
  source_section?: string
  source_flow_heading?: string
  confidence: number
  warnings: string[]
}

export type ProjectDataFilesGenerationResult = {
  schema_version: "1.0.0"
  project_root: string
  knowledge_mode: DtpKnowledgeMode
  source_document_scan_performed: boolean
  dtp_root: string
  runtime_dir: string
  input_data_root: string
  knowledge_index_file: string
  protocol_definitions_file: string
  protocol_writer_preview_file: string
  data_quality_report_file: string
  protocol_retry_context_file: string
  performance_report_file: string
  data_files_index_file: string
  generated_files: GeneratedDataFileIndexEntry[]
  skipped_candidates: number
  warnings: string[]
}

export type DtpProtocolWriterOptions = {
  maxVariantCombinations?: number
  unknownFlowPolicy?: "warn_and_skip" | "warn_and_put_input"
  allowFallbackForUnresolvedFields?: boolean
  fallbackReason?: string
  directoryLayout?: "flow" | "flat"
  dryRun?: boolean
}

export type DtpProtocolDataWriterResult = {
  schema_version: "1.0.0"
  protocol_definitions_file?: string
  generated_files: GeneratedDataFileIndexEntry[]
  skipped_protocols: Array<{
    protocol_id: string
    reason: string
  }>
  warnings: string[]
}

export type DtpProtocolWriterPreviewDocument = {
  schema_version: "1.0.0"
  protocol_definitions_file: string
  legacy_generated_count: number
  protocol_writer_generated_count: number
  matched_file_paths: string[]
  legacy_only_file_paths: string[]
  protocol_writer_only_file_paths: string[]
  skipped_protocols: DtpProtocolDataWriterResult["skipped_protocols"]
  warnings: string[]
  updated_at: string
}

export type DtpDataQualityIssue = {
  severity: "error" | "warning" | "info"
  type:
    | "preview_mismatch"
    | "skipped_protocol"
    | "unknown_flow"
    | "invalid_file_path"
    | "invalid_byte_content"
    | "checksum_mismatch"
    | "length_mismatch"
    | "missing_generated_file"
    | "protocol_warning"
  file_path?: string
  protocol_id?: string
  reason: string
  recommended_fix?: string
}

export type DtpDataQualityReport = {
  schema_version: "1.0.0"
  status: "pass" | "warning" | "fail"
  protocol_definitions_file: string
  protocol_writer_preview_file: string
  generated_data_files_index_file: string
  checked_file_count: number
  issue_counts: {
    error: number
    warning: number
    info: number
  }
  issues: DtpDataQualityIssue[]
  warnings: string[]
  updated_at: string
}

export type DtpProtocolRetryContext = {
  schema_version: "1.0.0"
  status: "not_needed" | "ready"
  protocol_definitions_file: string
  quality_report_file: string
  protocol_writer_preview_file: string
  affected_protocols: Array<{
    protocol_id: string
    protocol?: DtpProtocolDefinition
    issues: DtpDataQualityIssue[]
  }>
  affected_files: Array<{
    file_path: string
    issues: DtpDataQualityIssue[]
  }>
  preview_differences: {
    legacy_only_file_paths: string[]
    protocol_writer_only_file_paths: string[]
  }
  guidance: string[]
  warnings: string[]
  updated_at: string
}

export type SectionProtocolRelationTableInput = {
  id: string
  caption?: string
  ordinal: number
  is_frame_format: boolean
  headers: string[]
  rows: string[][]
  table_html?: string
  cells?: ProjectKnowledgeTableCell[]
  aliases: string[]
  topic: ProjectKnowledgeTopic["topic"]
  payload_mode?: "complete" | "header_and_matched_rows"
  original_row_count?: number
  selected_row_indexes?: number[]
}

export type DtpModelInputMetrics = {
  raw_context_chars: number
  raw_context_tokens: number
  final_prompt_chars: number
  final_prompt_tokens: number
  candidate_table_count: number
  selected_table_count: number
  selected_row_count: number
  token_budget: number
  retrieval_duration_ms: number
  omitted_table_ids: string[]
  applied_timeout_ms?: number
}

export type SectionProtocolRelationModelInput = {
  section_model_id: string
  source_document_id: string
  section_id?: string
  section_title: string
  section_text: string
  input_flow_text: string
  output_flow_text: string
  tables: SectionProtocolRelationTableInput[]
  primary_table_ids: string[]
  support_table_ids: string[]
  reference_backed?: boolean
  referenced_primary_table_ids?: string[]
  heuristic_relations: SectionProtocolRelation[]
  model_input_metrics?: DtpModelInputMetrics
  model_timeout_ms?: number
}

export type DtpProtocolFlowBlock = {
  direction: FlowDirection
  heading_text: string
  snippet_ids: string[]
  text: string
  table_ids: string[]
}

export type DtpProtocolBusProfile = {
  source_document_id: string
  bus_type: "CAN"
  interface_level?: "primary" | "secondary" | "unknown"
  interface_id?: string
  interface_name?: string
  controller: "SJA1000" | "SJA1000T"
  controller_family: "SJA1000"
  mode: "BasicCAN" | "PeliCAN"
  evidence: string[]
  confidence: number
}

export type DtpProtocolContextPackage = {
  section_model_id: string
  source_document_id: string
  section_id?: string
  section_title: string
  section_path?: string[]
  interface_context_text?: string
  section_text: string
  referenced_context_text?: string
  reference_evidence?: DtpProtocolReferenceEvidence[]
  flow_blocks: {
    input: DtpProtocolFlowBlock
    output: DtpProtocolFlowBlock
  }
  tables: SectionProtocolRelationTableInput[]
  primary_table_ids: string[]
  support_table_ids: string[]
  reference_backed?: boolean
  referenced_primary_table_ids?: string[]
  heuristic_relations: SectionProtocolRelation[]
  bus_profiles: DtpProtocolBusProfile[]
  model_input_metrics?: DtpModelInputMetrics
  model_timeout_ms?: number
}

export type DtpProtocolChecksumDefinition = {
  type: "sum_low8" | "sum_low16" | "sum_low32" | "iso" | "crc" | "none" | "unknown"
  start?: string
  end?: string
  expression?: string
}

export type BusCommandDictionaryEntry = {
  id: string
  command_code: string
  command_name: string
  bus_type?: DtpProtocolBusContext["bus_type"]
  interface_level?: "primary" | "secondary"
  payload_length_bytes?: number
  field_overrides: PacketFieldValuePlan[]
  source_document_id: string
  source_table_id: string
  source_table_caption?: string
  warnings: string[]
}

export type CommandDictionaryIndex = {
  schema_version: "1.0.0"
  source_documents: string[]
  entries: BusCommandDictionaryEntry[]
  warnings: string[]
  updated_at: string
}

export type DtpProtocolBlockChecksumDefinition = {
  name: string
  algorithm: "sum_low8" | "sum_low16" | "sum_low32" | "iso_8473" | "iso_unknown" | "unknown"
  source: "frame_range" | "payload_image"
  source_start?: number
  source_end?: number
  output_offset: number
  output_length: number
  byte_order: "big" | "little" | "unknown"
  source_text?: string
}

export type DtpProtocolBlockDefinition = {
  kind: "spacewire_program_upload" | "spacewire_fixed_block"
  total_bytes: number
  payload_offset?: number
  payload_capacity?: number
  payload_file?: string
  payload_file_patterns?: string[]
  start_address?: string
  address_offset?: number
  address_length?: number
  length_offset?: number
  length_length?: number
  scalar_byte_order: "big" | "little" | "unknown"
  block_type_offset?: number
  start_block_type?: string
  middle_block_type?: string
  check_block_type?: string
  checksums: DtpProtocolBlockChecksumDefinition[]
  source_table_ids: string[]
}

export type DtpProtocolFieldRole =
  | "arbitration"
  | "control"
  | "address"
  | "type"
  | "title"
  | "length"
  | "sequence"
  | "data"
  | "checksum"
  | "fixed"
  | "unknown"

export type DtpProtocolFieldLayout = {
  name: string
  role: DtpProtocolFieldRole
  byte_offset: number
  byte_length: number
  bit_offset?: number
  bit_length?: number
  default_value?: string
  value_rule?: DtpProtocolValueRule
  options?: DtpProtocolFieldOption[]
  source_table_id?: string
  source_text?: string
}

export type DtpProtocolFrameDefinition = {
  frame_id: string
  sequence: number
  source_table_id: string
  byte_layout: string[]
  field_layout: DtpProtocolFieldLayout[]
  /** Physical bytes written for this business frame, excluding transport envelopes. */
  wire_length?: number
  checksum?: DtpProtocolChecksumDefinition
  /** Runtime packet boundary used when one generated file contains multiple ordered packets. */
  packet_group_id?: string
}

export type DtpProtocolLegacyFrameDefinition = {
  source_table_id: string
  byte_layout: string[]
  byte_layouts?: string[][]
  field_layout?: DtpProtocolFieldLayout[]
  checksum?: DtpProtocolChecksumDefinition
}

export type CaseStepDataMutation = {
  field: string
  frame_index?: number
  byte_index?: number
  operation: "replace" | "replace_with_invalid_value" | "increment" | "xor"
  value?: string
}

export type CaseStepSequenceOperation = {
  operation: "drop_frame" | "repeat_frame" | "swap_frames" | "append_frame"
  frame_index?: number
  other_frame_index?: number
  repeat_count?: number
  bytes?: string[]
}

export type CaseStepModelTriggerReason =
  | "protocol_ambiguity"
  | "protocol_unresolved"
  | "target_field_unresolved"
  | "required_argument_unresolved"
  | "business_value_unresolved"

export type CaseStepDataGenerationPlan = {
  protocol_id?: string
  protocol_name?: string
  command?: {
    code: string
    name: string
    source_table_id: string
    source_table_caption?: string
    selection_source?: "step_desc" | "document_order_default"
  }
  payload_length_bytes?: number
  related_message_length_bytes?: number
  flow_direction: FlowDirection
  bus?: string
  operation?: "memory_write" | "bus_send" | "bus_receive"
  target_address?: string
  protocol_entity?: string
  artifact_scope?: "single_block" | "full_package"
  selected_block?: "start-block" | "middle-block" | "check-block"
  base_file_name?: string
  base_file_path?: string
  base_bytes?: string[][]
  variant_type:
    | "correct"
    | "title_error"
    | "checksum_error"
    | "arbitration_error"
    | "control_error"
    | "length_error"
    | "field_error"
    | "unknown"
  mutations: CaseStepDataMutation[]
  sequence_operations: CaseStepSequenceOperation[]
  checksum_policy: "preserve" | "recalculate_correctly" | "make_incorrect" | "none"
  argument_values: Record<string, string | number | boolean>
  evidence_ids: string[]
  confidence: number
  warnings: string[]
  source: "model" | "heuristic-fallback" | "model-retry"
  selection_source?: "step_desc" | "data_file_hint" | "case_anchor" | "protocol_relation" | "selector_relation" | "document_order_default" | "model" | "unresolved"
  interface_level?: "primary" | "secondary" | "unknown"
  interface_id?: string
  interface_selection_source?: "explicit_level" | "interface_id" | "legacy_can_channel_alias" | "protocol_unique_scope" | "unresolved"
  matched_interface_alias?: string
  deterministic_generation?: boolean
  model_used?: boolean
  model_trigger_reasons?: CaseStepModelTriggerReason[]
  model_skipped_reasons?: string[]
  fallback_used?: boolean
  rejected_protocols?: Array<{
    protocol_id: string
    reason: string
  }>
  model_fallback?: {
    profile_id: string
    profile_version: string
    profile_source: DtpModelFallbackProfileSelection["source"]
    profile_hash: string
    registry_hash: string
    classification: DtpModelFallbackClassification
    candidate_protocol_ids: string[]
    included_evidence_ids: string[]
    missing_evidence: string[]
    prompt_chars: number
    estimated_input_tokens: number
    cache_hit?: boolean
  }
}

export type StepDataQualityIssue = {
  severity: "error" | "warning"
  type:
    | "missing_base_data"
    | "invalid_hex_content"
    | "mutation_not_applied"
    | "checksum_expected_correct"
    | "checksum_expected_incorrect"
    | "flow_mismatch"
    | "protocol_mismatch"
    | "protocol_length_mismatch"
    | "case_step_protocol_conflict"
    | "interface_scope_conflict"
    | "protocol_name_interface_conflict"
    | "protocol_candidate_out_of_scope"
    | "protocol_length_ambiguous"
    | "protocol_default_selected"
    | "command_default_selected"
    | "publication_preserved"
    | "protocol_ambiguous"
    | "protocol_unresolved"
    | "case_data_fallback"
    | "flat_case_file_path"
    | "frame_count_mismatch"
    | "frame_layout_mismatch"
    | "frame_information_missing"
    | "frame_information_mismatch"
    | "frame_envelope_missing"
    | "frame_envelope_mismatch"
    | "dlc_mismatch"
    | "dlc_out_of_range"
    | "spi_length_mismatch"
    | "unresolved_field_zero_fallback"
    | "command_field_unresolved"
    | "command_field_value_ambiguous"
    | "suspicious_duplicate_content"
    | "semantic_fault_without_mutation"
    | "unexpected_field_mutation"
  message: string
}

export type StepDataQualityResult = {
  status: "pass" | "warning" | "failed"
  issues: StepDataQualityIssue[]
}

export type CaseStepDataPlanningInput = {
  case_id: string
  case_name?: string
  keyword: {
    name: string
    documentation?: string
    arguments: KeywordArgumentDef[]
  }
  step: {
    step_index: number
    step_desc?: string
    time?: string | number
  }
  project_value_evidence: Array<{
    id: string
    kind: "snippet" | "table"
    text: string
    score: number
  }>
  candidate_data_files: Array<{
    protocol_name?: string
    requested_file_name: string
    file_path: string
    flow_direction?: FlowDirection
    checksum_rule?: string
    confidence: number
  }>
  model_fallback?: {
    profile: DtpModelFallbackProfileSelection
    candidate_protocols: DtpModelFallbackProtocolCandidate[]
    evidence: DtpModelFallbackEvidence[]
    missing_evidence: string[]
    prompt_chars: number
    estimated_input_tokens: number
  }
}

export type DtpModelFallbackProtocolCandidate = {
  protocol_id: string
  base_file_name: string
  aliases: string[]
  source_section?: string
  flow_direction: FlowDirection
  bus_context?: DtpProtocolBusContext
  frame_count: number
  omitted_frame_count?: number
  field_layout: Array<{
    frame_id: string
    fields: Array<{
      name: string
      role: DtpProtocolFieldRole
      byte_offset: number
      byte_length: number
      default_value?: string
      value_rule?: DtpProtocolValueRule
      source_table_id?: string
      source_text?: string
    }>
    checksum?: DtpProtocolChecksumDefinition
    omitted_field_count?: number
  }>
  source_table_ids: string[]
  selector_relation_ids: string[]
  confidence: number
  warnings: string[]
}

export type DtpModelFallbackEvidence = {
  id: string
  kind: "source-table" | "selector-relation" | "command-dictionary"
  source_id: string
  text: string
}

export type DtpModelFallbackEvidenceIndex = {
  tables_by_id: Map<string, ProjectKnowledgeTable>
  related_table_ids_by_table_id: Map<string, string[]>
  selector_relations_by_protocol_id: Map<string, DtpProtocolSelectorRelation[]>
  command_entries_by_protocol_text: Array<{
    normalized_text: string
    entry: BusCommandDictionaryEntry
  }>
}

export type CaseStepDataPlanRetryInput = {
  planning_input: CaseStepDataPlanningInput
  current_plan: CaseStepDataGenerationPlan
  argument_quality: ArgumentQualityResult
  data_quality: StepDataQualityResult
  attempt: number
}

export type DtpProtocolBusContext = {
  bus_type: "CAN" | "SPI" | "SpaceWire" | "RS422" | "UART" | "1553B" | "unknown"
  interface_level?: "primary" | "secondary" | "unknown"
  interface_id?: string
  interface_name?: string
  profile_scope?: "interface" | "section" | "document"
  controller?: "SJA1000" | "SJA1000T" | "unknown" | string
  controller_family?: "SJA1000" | "unknown" | string
  mode?: "BasicCAN" | "PeliCAN" | "unknown" | string
  frame_format?: "standard" | "extended" | "unknown"
  frame_buffer_layout?: "business-payload" | "sja1000-basiccan" | "sja1000-pelican" | "unknown"
  frame_info_byte?: string
  frame_information?: {
    apply_to_case_data: boolean
    strategy: "derive_from_ff_rtr_dlc"
  }
  evidence?: string[]
  confidence?: number
  warnings?: string[]
}

export type DtpProtocolValueRule = {
  operation: "fixed" | "variable" | "add_low8" | "bit_or" | "bit_and" | "shift_left" | "concat"
  value?: string
  base?: string
  variable?: string
  operand?: string
  shift?: number
  mask?: string
}

export type DtpProtocolFieldOption = {
  value: string
  label: string
  source?: string
}

export type DtpProtocolVariableDefinition = {
  name: string
  display_name?: string
  type: "uint8" | "bytes" | "unknown"
  default_value?: string
  options?: DtpProtocolFieldOption[]
  source_table_id?: string
  source_text?: string
}

export type DtpProtocolSelectorMapping = {
  selector_value: string
  target_protocol_id: string
  target_frame_count?: number
  evidence: string[]
}

export type DtpProtocolSelectorRelation = {
  relation_id: string
  section_model_id: string
  selector_name: string
  selector_aliases: string[]
  selector_type: "uint8" | "integer" | "string"
  protocol_family?: "telemetry" | "poll" | "response" | "command" | "unknown"
  bus_type?: DtpProtocolBusContext["bus_type"]
  interface_level?: "primary" | "secondary" | "unknown"
  interface_id?: string
  mappings: DtpProtocolSelectorMapping[]
  evidence: string[]
  source: "table" | "model"
  confidence: number
  warnings: string[]
}

export type DtpProtocolFamilyVariant = {
  variant_key: string
  protocol_ids: string[]
  canonical_protocol_id: string
  frame_count?: number
  layout_fingerprint: string
  layout_table_ids: string[]
  evidence: string[]
}

export type DtpProtocolFamilySelectorMapping = {
  selector_value: string
  variant_keys: string[]
  target_frame_count?: number
  evidence: string[]
  warnings: string[]
}

export type DtpProtocolFamilySelector = {
  selector_id: string
  relation_ids: string[]
  selector_name: string
  selector_aliases: string[]
  selector_type: DtpProtocolSelectorRelation["selector_type"]
  mappings: DtpProtocolFamilySelectorMapping[]
  evidence: string[]
  confidence: number
  warnings: string[]
}

export type DtpProtocolFamilyComposition =
  | {
      type: "ordered_packets"
      group_id: string
      members: Array<{
        protocol_id: string
        role: string
        order: number
        cardinality: "1"
      }>
    }
  | {
      type: "ordered_blocks"
      protocol_id: string
      members: Array<{
        role: "start" | "middle" | "check"
        order: number
        cardinality: "1" | "0..n"
        discriminator?: string
      }>
    }

export type DtpProtocolFamily = {
  family_id: string
  bus_type: DtpProtocolBusContext["bus_type"]
  interface_level: "primary" | "secondary" | "unknown"
  interface_id?: string
  flow_direction: FlowDirection
  semantic_role: DtpProtocolSemanticRole
  variants: DtpProtocolFamilyVariant[]
  selectors: DtpProtocolFamilySelector[]
  composition?: DtpProtocolFamilyComposition
  evidence: string[]
  warnings: string[]
}

export type DtpProtocolFrameEnvelope = {
  type: "fixed_prefix"
  bytes: string[]
  applies_per_frame: boolean
  position?: "before_frame"
  raw_value?: string
  byte_order?: "document_order"
  business_frame_length?: number
  wire_frame_length?: number
  directions?: Array<"send" | "receive">
  confidence?: number
  source_text?: string
}

export type DtpProtocolInterfaceEnvelope = {
  envelope_id: string
  bus_type: DtpProtocolBusContext["bus_type"]
  interface_level: "primary" | "secondary" | "unknown"
  interface_id?: string
  frame_envelope: DtpProtocolFrameEnvelope
  source_document_ids: string[]
  source_protocol_ids: string[]
  evidence: string[]
  confidence: number
  warnings: string[]
}

export type DtpProtocolFieldDefinition = {
  name: string
  type: "fixed" | "enum" | "bitfield" | "unknown"
  value?: string
  options?: DtpProtocolFieldOption[]
  source?: string
  source_table_id?: string
  source_text?: string
  confidence?: number
  warnings?: string[]
}

export type DtpProtocolVariantDefinition = {
  name: string
  fields: DtpProtocolFieldDefinition[]
  evidence: string[]
  warnings: string[]
  confidence: number
}

export type DtpProtocolGroup = {
  group_id: string
  name: string
  aliases?: string[]
  protocol_ids: string[]
  ordered: true
  flow_direction: FlowDirection
  source_section_model_id?: string
  evidence: string[]
  warnings: string[]
}

export type DtpProtocolComposition = {
  group_id: string
  children: Array<{
    protocol_id: string
    frame_start: number
    frame_count: number
  }>
}

export type DtpProtocolSemanticRole =
  | "time_broadcast"
  | "poll"
  | "telemetry"
  | "response"
  | "command"
  | "data_block"
  | "auxiliary"
  | "unknown"

export type DtpProtocolSemanticIdentity = {
  canonical_name: string
  normalized_name: string
  role: DtpProtocolSemanticRole
  entity?: string
  /** Logical size of this protocol message when the source explicitly defines it. */
  message_length_bytes?: number
  /** Size of the related message, for example the command named by a response protocol. */
  related_message_length_bytes?: number
}

export type DtpProtocolTransport = {
  bus_type: DtpProtocolBusContext["bus_type"]
  interface_level: "primary" | "secondary" | "unknown"
  interface_id?: string
  frame_count: number
  wire_lengths: number[]
}

export type DtpProtocolProvenance = {
  source_document_id: string
  source_table_ids: string[]
  source_sections: string[]
  evidence: string[]
  priority: "primary" | "referenced" | "supporting" | "unknown"
}

export type DtpProtocolRelationType =
  | "responds_to"
  | "variant_of"
  | "composed_of"
  | "encapsulates"
  | "selected_by"
  | "follows"

export type DtpProtocolRelation = {
  relation_id: string
  type: DtpProtocolRelationType
  source_id: string
  source_kind: "protocol" | "protocol_group"
  target_ids: string[]
  target_kind: "protocol" | "protocol_group" | "selector_relation"
  evidence: string[]
  confidence: number
  warnings: string[]
}

export type DtpProtocolDefinition = {
  protocol_id: string
  source_section?: string
  flow_direction: FlowDirection
  base_file_name: string
  aliases?: string[]
  generation_mode: "single_file" | "expand_variants" | "one_file_per_dictionary_row" | "skip"
  frames?: DtpProtocolFrameDefinition[]
  /** Read-only compatibility for protocol definition files generated before schema V2. */
  frame?: DtpProtocolLegacyFrameDefinition
  bus_context?: DtpProtocolBusContext
  variables?: DtpProtocolVariableDefinition[]
  frame_envelope?: DtpProtocolFrameEnvelope
  block_layout?: DtpProtocolBlockDefinition
  fields: DtpProtocolFieldDefinition[]
  variants?: DtpProtocolVariantDefinition[]
  evidence: string[]
  warnings: string[]
  confidence: number
  understanding_source: "model" | "heuristic-fallback"
  semantic_identity?: DtpProtocolSemanticIdentity
  transport?: DtpProtocolTransport
  provenance?: DtpProtocolProvenance[]
  /** Present only on a runtime composition built from protocol_groups. */
  composition?: DtpProtocolComposition
}

export type DtpNonGeneratedTable = {
  table_id: string
  reason: string
}

export type DtpProtocolDefinitionsDocument = {
  schema_version: typeof DTP_PROTOCOL_SCHEMA_VERSION
  project_root: string
  knowledge_index_file: string
  source_fingerprint?: {
    knowledge_index_hash: string
    portable_knowledge_hash?: string
    compiler_version: string
  }
  source: "model" | "heuristic-fallback" | "mixed"
  sections: Array<{
    section_model_id: string
    section_id?: string
    section_title: string
    protocol_ids: string[]
    warnings: string[]
  }>
  protocols: DtpProtocolDefinition[]
  protocol_groups?: DtpProtocolGroup[]
  protocol_families?: DtpProtocolFamily[]
  interface_envelopes?: DtpProtocolInterfaceEnvelope[]
  selector_relations?: DtpProtocolSelectorRelation[]
  relations?: DtpProtocolRelation[]
  non_generated_tables: DtpNonGeneratedTable[]
  warnings: string[]
  updated_at: string
}

export type DtpProtocolDefinitionValidationIssue = {
  severity: "error" | "warning"
  protocol_id?: string
  frame_id?: string
  message: string
}

export type DtpProtocolDefinitionValidationResult = {
  valid: boolean
  issues: DtpProtocolDefinitionValidationIssue[]
}

export type DtpPerformanceStageName =
  | "prepare_project_knowledge_index"
  | "model_relation_analysis"
  | "model_protocol_understanding"
  | "write_protocol_files"
  | "quality_check"
  | "protocol_retry"
  | "case_step_planning"
  | "case_generation"
  | "case_step_generation"
  | "case_generation_summary"

export type DtpPerformanceModelStageName =
  | "model_relation_analysis"
  | "model_protocol_understanding"
  | "protocol_retry"
  | "case_step_planning"
  | "case_step_retry"

export type DtpPerformanceStatus = "success" | "timeout" | "error" | "skipped" | "fallback"

export type DtpPerformancePayloadMetrics = {
  system_prompt_chars: number
  prompt_chars: number
  payload_chars: number
  estimated_tokens: number
  section_text_chars: number
  input_flow_chars: number
  output_flow_chars: number
  table_count: number
  table_payload_chars: number
  table_html_chars: number
  cells_chars: number
  rows_chars: number
  heuristic_relations_chars: number
  raw_context_chars?: number
  raw_context_tokens?: number
  final_prompt_chars?: number
  final_prompt_tokens?: number
  candidate_table_count?: number
  selected_table_count?: number
  selected_row_count?: number
  token_budget?: number
  retrieval_duration_ms?: number
  applied_timeout_ms?: number
  omitted_table_ids?: string[]
}

export type DtpPerformanceStageRecord = {
  name: DtpPerformanceStageName
  started_at: string
  ended_at: string
  duration_ms: number
  status: DtpPerformanceStatus
  details?: Record<string, unknown>
  error?: string
}

export type DtpPerformanceSectionCall = {
  stage: DtpPerformanceModelStageName
  case_id?: string
  step_index?: number
  section_model_id?: string
  section_id?: string
  section_title?: string
  duration_ms: number
  status: DtpPerformanceStatus
  payload: DtpPerformancePayloadMetrics
  fallback_used: boolean
  warnings: string[]
  model_profile_id?: string
  model_profile_version?: string
  candidate_protocol_count?: number
  included_evidence_count?: number
  started_at: string
  ended_at: string
}

export type DtpPerformanceOptimizationHint = {
  severity: "info" | "warning"
  type:
    | "large_payload"
    | "model_timeout"
    | "fallback_used"
    | "double_phase_timeout"
    | "redundant_table_payload"
  message: string
  section_model_id?: string
  section_title?: string
}

export type DtpDataGenerationPerformanceReport = {
  schema_version: "1.0.0"
  workspace_root: string
  matrix_data_dir: string
  started_at: string
  ended_at: string
  duration_ms: number
  summary: {
    source_document_count: number
    section_count: number
    model_call_count: number
    timeout_count: number
    fallback_section_count: number
    generated_file_count: number
    max_payload_chars: number
    max_estimated_tokens: number
  }
  stages: DtpPerformanceStageRecord[]
  section_calls: DtpPerformanceSectionCall[]
  optimization_hints: DtpPerformanceOptimizationHint[]
  warnings: string[]
}

export type DtpDataGenerationPerformanceCollector = {
  measureStage<T>(
    name: DtpPerformanceStageName,
    details: Record<string, unknown> | undefined,
    action: () => Promise<T> | T,
  ): Promise<T>
  measureModelCall<T>(
    stage: DtpPerformanceModelStageName,
    input: unknown,
    action: () => Promise<T> | T,
  ): Promise<T>
  recordFallback(stage: DtpPerformanceModelStageName, input: unknown, warnings: string[]): void
  finalize(summary: {
    sourceDocumentCount?: number
    sectionCount?: number
    generatedFileCount?: number
    warnings?: string[]
  }): DtpDataGenerationPerformanceReport
  write(outputFile: string): void
}

export type DtpDataModelHooks = {
  analyzeSectionProtocolRelations?: (
    input: SectionProtocolRelationModelInput,
  ) => Promise<unknown[] | null>
  understandSectionProtocols?: (
    input: DtpProtocolContextPackage,
  ) => Promise<unknown | null>
  reviseProtocolDefinitions?: (
    input: DtpProtocolRetryContext,
  ) => Promise<unknown | null>
  planCaseStepData?: (
    input: CaseStepDataPlanningInput,
  ) => Promise<unknown | null>
  reviseCaseStepDataPlan?: (
    input: CaseStepDataPlanRetryInput,
  ) => Promise<unknown | null>
  performance?: DtpDataGenerationPerformanceCollector
  flushCache?: () => void
  cacheStats?: () => DtpModelCacheStats
}

export type DtpModelCacheStats = {
  hits: number
  misses: number
  writes: number
  in_flight_reuses: number
  timeouts: number
  timeout_memo_reuses: number
}

type ResolvedLLMConfig = {
  providerID: string
  modelID: string
}

export type PacketField = {
  field_name: string
  byte_offset?: number
  byte_length?: number
  default_value?: string
  value_rule?: string
  source_table_id?: string
}

export type PacketFieldValuePlan = {
  field_name: string
  value: string
  value_source:
    | "frame-table"
    | "support-table"
    | "dictionary-row"
    | "enum-option"
    | "bitfield-enum"
    | "model"
    | "fallback-zero"
  source_table_id?: string
  source_text?: string
  confidence: number
  reasoning: string[]
}

export type ProjectKnowledgeDocument = {
  id: string
  path: string
  file_name: string
  role: "primary-third-party-test-requirement" | "explicit-supporting-document" | "referenced-document"
  type: "docx" | "doc" | "pdf" | "unknown"
  size_bytes?: number
  modified_time?: string
  content_hash?: string
  parse_state: "metadata-only" | "parsed" | "failed"
  warnings: string[]
}

export type ProjectKnowledgeTopic = {
  topic:
    | "hardware_interface"
    | "data_protocol"
    | "data_convention"
    | "packet_structure"
    | "format_validation"
    | "background_knowledge"
    | "requirement_input_flow"
    | "output_flow"
    | "control_flow"
  source_document_ids: string[]
  extraction_state: "pending-parser" | "parsed" | "missing"
  facts: string[]
  warnings: string[]
}

export type ProjectKnowledgeSnippet = {
  id: string
  source_document_id: string
  topic: ProjectKnowledgeTopic["topic"]
  text: string
  confidence: number
}

export type ProjectKnowledgeTableCell = {
  row: number
  col: number
  text: string
  rowspan?: number
  colspan?: number
  is_header?: boolean
}

export type ProjectKnowledgeTable = {
  id: string
  source_document_id: string
  caption?: string
  aliases: string[]
  topic: ProjectKnowledgeTopic["topic"]
  rows: string[][]
  table_html?: string
  cells?: ProjectKnowledgeTableCell[]
  confidence: number
  warnings: string[]
}

export type ProjectKnowledgeReference = {
  reference_id?: string
  source_document_id: string
  source_snippet_id?: string
  source_table_id?: string
  reference_text: string
  reference_type:
    | "internal"
    | "requirement-specification"
    | "unsupported-external"
    | "internal-appendix"
    | "external-document"
  target_kind?: "document" | "section" | "table" | "appendix"
  target_document_hint?: string
  target_hint?: string
  target_path?: Array<{
    kind: "section" | "table" | "appendix"
    value: string
  }>
  resolved_document_id?: string
  resolved_table_id?: string
  resolved_table_ids?: string[]
  resolved_snippet_id?: string
  resolved_section_model_id?: string
  semantic_roles?: ProjectKnowledgeReferenceRole[]
  confidence?: number
  depth?: number
  state:
    | "pending-parser"
    | "resolved"
    | "fallback_resolved"
    | "ambiguous"
    | "unresolved"
    | "unsupported"
    | "not_followed_by_policy"
    | "missing"
  warnings?: string[]
}

export type ProjectKnowledgeReferenceRole =
  | "frame_layout"
  | "field_dictionary"
  | "payload_definition"
  | "selector"
  | "checksum_definition"
  | "related_transport"
  | "broad_context_only"
  | "unknown"

export type DtpProtocolReferenceEvidence = {
  reference_id: string
  reference_text: string
  source_id: string
  target_ids: string[]
  semantic_roles: ProjectKnowledgeReferenceRole[]
  depth: number
  state: "resolved" | "fallback_resolved"
  confidence: number
  warnings: string[]
}

export type DocumentReferenceGraphNode = {
  id: string
  type: "document" | "section" | "table" | "appendix"
  source_document_id: string
  title: string
}

export type DocumentReferenceGraphEdge = {
  source: string
  target?: string
  target_hint?: string
  relation: "contains" | "references"
  depth: number
  state: ProjectKnowledgeReference["state"] | "resolved"
  evidence: string
  semantic_roles?: ProjectKnowledgeReferenceRole[]
  confidence?: number
  warnings: string[]
}

export type DocumentReferenceGraph = {
  schema_version: "2.0.0"
  project_root: string
  nodes: DocumentReferenceGraphNode[]
  edges: DocumentReferenceGraphEdge[]
  warnings: string[]
  updated_at: string
}

export type ProtocolEvidenceTraceDocument = {
  schema_version: "1.0.0"
  project_root: string
  protocol_definitions_file: string
  protocols: Array<{
    protocol_id: string
    protocol_name: string
    source_document_ids: string[]
    source_sections: string[]
    source_table_ids: string[]
    references: DtpProtocolReferenceEvidence[]
    evidence: string[]
    warnings: string[]
  }>
  warnings: string[]
  updated_at: string
}

export type TraceNote = {
  field: string
  source: string
  detail?: string
}

export type DocsContext = {
  backgroundDocs: string[]
  hardwareDocs: string[]
  protocolDocs: string[]
  conventionDocs: string[]
  packetStructureDocs: string[]
  formatRuleDocs: string[]
  requirementDocs: string[]
}

export type DataFileIntent = {
  keywordName: string
  argument: KeywordArgumentDef
  requestedFileName?: string
  stepDescription?: string
  testPurpose?: string
  timeValue?: string | number
  knowledgeIndex?: ProjectKnowledgeIndex
}

export type BuildGeneratedStepInput = {
  step: ConfirmationStep
  caseContext: ConfirmationCase
  keywordDef: KeywordDefinition
  inputDataRoot: string
  workspaceRoot: string
  knowledgeIndex: ProjectKnowledgeIndex
  commandDictionaryIndex?: CommandDictionaryIndex
  dataFileIndex: GeneratedDataFileIndex
  docsContext: DocsContext
  protocolDefinitions?: DtpProtocolDefinitionsDocument
  protocolAnchorId?: string
  dataGenerationPlan?: CaseStepDataGenerationPlan
  modelFallbackProfiles?: DtpModelFallbackProfileRegistry
  modelFallbackEvidenceIndex?: DtpModelFallbackEvidenceIndex
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const trimmed = value.trim()
    if (!trimmed) return undefined
    const parsed = Number(trimmed)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function getFirstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = asString(record[key])
    if (value) return value
  }
  return undefined
}

function sanitizeOptionalExecutableText(value: string | undefined): string | undefined {
  return value ? sanitizeDtpExecutablePlaceholders(value) : value
}

function getNestedArray(record: Record<string, unknown>, keys: string[]): unknown[] {
  for (const key of keys) {
    const value = record[key]
    if (Array.isArray(value)) return value
  }
  return []
}

function extractModelFromMessageInfo(info: any): ResolvedLLMConfig | null {
  if (!info || typeof info !== "object") return null

  if (typeof info.providerID === "string" && typeof info.modelID === "string") {
    return {
      providerID: info.providerID,
      modelID: info.modelID,
    }
  }

  if (info.model && typeof info.model === "object") {
    const providerID = typeof info.model.providerID === "string" ? info.model.providerID : ""
    const modelID = typeof info.model.modelID === "string" ? info.model.modelID : ""
    if (providerID && modelID) {
      return {
        providerID,
        modelID,
      }
    }
  }

  return null
}

async function resolveRuntimeModel(client: OpencodeClient, context: ToolContext): Promise<ResolvedLLMConfig> {
  const currentMessage = await client.session.message({
    path: {
      id: context.sessionID,
      messageID: context.messageID,
    },
    query: {
      directory: context.directory,
    },
  })

  const fromCurrentMessage = extractModelFromMessageInfo(currentMessage.data?.info)
  if (fromCurrentMessage) return fromCurrentMessage

  const cfg = await client.config.get({
    query: { directory: context.directory },
  })
  if (cfg.error || !cfg.data) {
    throw new Error("Failed to resolve current OpenCode model")
  }

  const modelRef = cfg.data.model ?? ""
  const providerConfigs = cfg.data.provider ?? {}

  let providerID = ""
  let modelID = ""

  if (modelRef.includes("/")) {
    const parts = modelRef.split("/")
    providerID = parts[0] ?? ""
    modelID = parts.slice(1).join("/")
  } else if (modelRef) {
    modelID = modelRef
  }

  if (!providerID && Object.keys(providerConfigs).length === 1) {
    providerID = Object.keys(providerConfigs)[0] ?? ""
  }

  const providerConfig = providerID ? providerConfigs[providerID] : undefined
  if (!providerConfig || typeof providerConfig !== "object") {
    throw new Error("OpenCode provider config is missing")
  }

  const providerConfigObj = providerConfig as {
    models?: Record<string, unknown>
  }

  if (!modelID) {
    const providerModels = providerConfigObj.models ?? {}
    if (Object.keys(providerModels).length === 1) {
      modelID = Object.keys(providerModels)[0] ?? ""
    }
  }

  if (!providerID || !modelID) {
    throw new Error("OpenCode model/provider config is incomplete")
  }

  return {
    providerID,
    modelID,
  }
}

function tryParseJsonObject<T>(input: string): T | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  const candidates = [trimmed]
  const firstBrace = trimmed.indexOf("{")
  const lastBrace = trimmed.lastIndexOf("}")
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1))
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T
    } catch {
      continue
    }
  }

  return null
}

const TEXT_FILE_ENCODINGS = ["utf-8", "gb18030", "gbk", "gb2312"] as const

function decodeTextFile(filePath: string): string {
  const bytes = readFileSync(filePath) as Uint8Array

  for (const encoding of TEXT_FILE_ENCODINGS) {
    try {
      const text = new TextDecoder(encoding as "utf-8", { fatal: true }).decode(bytes)
      return text.replace(/^\uFEFF/, "")
    } catch {
      // Try the next compatible encoding.
    }
  }

  return new TextDecoder("utf-8").decode(bytes).replace(/^\uFEFF/, "")
}

function readJsonFile(filePath: string): unknown {
  return JSON.parse(decodeTextFile(filePath)) as unknown
}

async function callDtpDataModelJson<T>(
  client: OpencodeClient,
  context: ToolContext,
  systemPrompt: string,
  prompt: string,
  timeoutMs = getDtpModelSectionTimeoutMs(),
  modelInputMetrics?: DtpModelInputMetrics,
): Promise<T | null> {
  if (modelInputMetrics) {
    modelInputMetrics.final_prompt_chars = systemPrompt.length + prompt.length
    modelInputMetrics.final_prompt_tokens = estimateTokenCount(modelInputMetrics.final_prompt_chars)
    modelInputMetrics.applied_timeout_ms = timeoutMs
  }
  const config = await resolveRuntimeModel(client, context)
  const child = await client.session.create({
    query: { directory: context.directory },
    body: {
      title: "dtp-data-generation-core",
    },
  })
  if (child.error || !child.data) {
    throw new Error("Failed to create OpenCode execution session for dtp data generation core")
  }

  const sessionID = child.data.id

  try {
    const promptRequest = client.session.prompt({
      path: { id: sessionID },
      query: { directory: context.directory },
      body: {
        model: {
          providerID: config.providerID,
          modelID: config.modelID,
        },
        system: systemPrompt,
        tools: {},
        parts: [{ type: "text", text: prompt }],
      },
    })
    const requestTimeoutMs = Math.max(1_000, timeoutMs - 250)
    let timeout: ReturnType<typeof setTimeout> | undefined
    const timeoutRequest = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        void client.session.abort({
          path: { id: sessionID },
          query: { directory: context.directory },
        }).catch(() => undefined)
        reject(new Error(`DTP model request timed out after ${requestTimeoutMs}ms and the isolated session was aborted`))
      }, requestTimeoutMs)
    })
    const response = await Promise.race([promptRequest, timeoutRequest]).finally(() => {
      if (timeout) clearTimeout(timeout)
    })

    if (response.error || !response.data) {
      throw new Error("OpenCode session prompt failed for DTP data model analysis")
    }
    if (response.data.info.error) {
      const err = response.data.info.error
      if (err.name === "APIError") {
        throw new Error(`LLM API ${err.data.statusCode ?? "error"}: ${err.data.responseBody ?? err.data.message}`)
      }
      throw new Error(typeof err.data?.message === "string" ? err.data.message : err.name)
    }

    const text = response.data.parts
      .flatMap((part) => (part.type === "text" && typeof (part as any).text === "string" ? [(part as any).text as string] : []))
      .join("\n")
      .trim()

    return tryParseJsonObject<T>(text)
  } finally {
    await client.session
      .delete({
        path: { id: sessionID },
        query: { directory: context.directory },
      })
      .catch(() => undefined)
  }
}

function normalizeCaseId(caseId: string): string {
  return caseId.trim()
}

function ensureDirectory(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true })
  }
}

function cleanProjectGeneratedDataFiles(inputDataRoot: string, dataFileIndex: GeneratedDataFileIndex): void {
  const resolvedInputRoot = resolve(inputDataRoot)
  for (const entry of dataFileIndex.entries) {
    if (entry.source !== "pre-generated") continue
    const target = resolve(
      entry.absolute_file_path ??
      runtimeInputDataPathToAbsolute(inputDataRoot, entry.file_path),
    )
    if (target.startsWith(`${resolvedInputRoot}${sep}`)) rmSync(target, { force: true })
  }

  for (const flowDirName of ["\u8f93\u5165\u6d41", "\u8f93\u51fa\u6d41"]) {
    const flowDir = resolve(inputDataRoot, flowDirName)
    if (!flowDir.startsWith(`${resolvedInputRoot}${sep}`) || !existsSync(flowDir)) continue
    for (const entry of readdirSync(flowDir, { withFileTypes: true })) {
      if (entry.isFile()) rmSync(resolve(flowDir, entry.name), { force: true })
    }
    if (readdirSync(flowDir).length === 0) rmSync(flowDir, { force: true })
  }
}

function toRobotPath(inputPath: string): string {
  return inputPath
    .split(/[\\/]+/)
    .filter(Boolean)
    .join("\\\\")
}

function toRuntimeInputDataPath(relativePath: string): string {
  return toRobotPath(join("\u8f93\u5165\u6570\u636e", relativePath))
}

function flowDirectoryName(flowDirection: FlowDirection | undefined): string {
  return flowDirection === "output" ? "\u8f93\u51fa\u6d41" : "\u8f93\u5165\u6d41"
}

function flowHeadingName(flowDirection: FlowDirection | undefined): string | undefined {
  if (flowDirection === "input") return "\u8f93\u5165\u6d41"
  if (flowDirection === "output") return "\u8f93\u51fa\u6d41"
  return undefined
}

function normalizeLookupText(value: string | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/\.(txt|dat|bin|csv|xml|docx|doc|pdf)$/i, "")
    .replace(/[\s\\/_\-\u3002\uff0c\uff1b\uff1a\uff08\uff09()[\]{}"'`=＝+]+/g, "")
}

function stripGeneratedNameMarker(value: string): string {
  return value.replace(/(?:[\s,，;；:：=＝+\-－_]+)?D\d(?:D\d)*(?:\s*[:：=＝\-].*)?$/i, "")
}

function sanitizeReadableFileBaseName(value: string | undefined): string {
  return stripGeneratedNameMarker(
    (value ?? "")
      .replace(/\.(txt|dat|bin|csv|xml)$/i, "")
      .replace(/[\\/:*?"<>|]/g, ""),
  )
    .replace(/[，,；;：:＝=+]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

function fileNameOf(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath
}

function getDocumentType(filePath: string): ProjectKnowledgeDocument["type"] {
  const lower = filePath.toLowerCase()
  if (lower.endsWith(".docx")) return "docx"
  if (lower.endsWith(".doc")) return "doc"
  if (lower.endsWith(".pdf")) return "pdf"
  return "unknown"
}

function getFileMetadata(filePath: string): Pick<ProjectKnowledgeDocument, "size_bytes" | "modified_time"> {
  try {
    const stat = statSync(filePath)
    return {
      size_bytes: stat.size,
      modified_time: stat.mtime.toISOString(),
    }
  } catch {
    return {}
  }
}

function getFileContentHash(filePath: string): string | undefined {
  try {
    return `sha256:${createHash("sha256").update(readFileSync(filePath)).digest("hex")}`
  } catch {
    return undefined
  }
}

function findKeywordDir(rootDir: string): string | null {
  const keywordDirName = "\u7ec4\u5408\u5173\u952e\u5b57"
  if (!existsSync(rootDir)) return null
  const direct = join(rootDir, keywordDirName)
  if (existsSync(direct) && statSync(direct).isDirectory()) {
    return direct
  }

  const queue = [rootDir]
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) continue

    let entries: Dirent[]
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const fullPath = join(current, entry.name)
      if (entry.name === keywordDirName) return fullPath
      queue.push(fullPath)
    }
  }

  return null
}

function shouldSkipDiscoveryDir(dirName: string): boolean {
  return [
    ".git",
    ".svn",
    ".hg",
    "node_modules",
    "dist",
    "build",
    "out",
    "coverage",
    ".next",
  ].includes(dirName)
}

function isSupportedProjectDocument(fileName: string): boolean {
  return /\.docx$/i.test(fileName)
}

function shouldSkipDocumentDiscoveryDir(parentDir: string, dirName: string): boolean {
  if (shouldSkipDiscoveryDir(dirName)) return true
  return dirName.toLowerCase() === "data" && /[\\\/]\.matrix$/i.test(parentDir)
}

function isRequirementSpecificationName(value: string): boolean {
  return /(?:软件|系统)?需求规格说明书?/u.test(value)
}

function dedupeDocumentPathsByContent(filePaths: string[]): string[] {
  const preferredPaths = uniqueStrings(filePaths)
    .filter((filePath) => existsSync(filePath))
    .sort((left, right) => {
      const leftGenerated = /[\\/]\.matrix[\\/]/i.test(left) ? 1 : 0
      const rightGenerated = /[\\/]\.matrix[\\/]/i.test(right) ? 1 : 0
      return leftGenerated - rightGenerated || left.length - right.length || left.localeCompare(right)
    })
  const seenFingerprints = new Set<string>()
  const deduped: string[] = []

  for (const filePath of preferredPaths) {
    try {
      const content = readFileSync(filePath)
      const fingerprint = `${content.byteLength}:${createHash("sha256").update(content).digest("hex")}`
      if (seenFingerprints.has(fingerprint)) continue
      seenFingerprints.add(fingerprint)
      deduped.push(filePath)
    } catch {
      deduped.push(filePath)
    }
  }

  return deduped
}

function discoverThirdPartyRequirementDocs(projectRoot: string): string[] {
  const marker = "\u7b2c\u4e09\u65b9\u6d4b\u8bd5\u9700\u6c42"
  const docs: string[] = []
  const queue: Array<{ dir: string; depth: number }> = [{ dir: projectRoot, depth: 0 }]

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) continue
    if (current.depth > 6) continue

    let entries: Dirent[]
    try {
      entries = readdirSync(current.dir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      const fullPath = join(current.dir, entry.name)
      if (entry.isDirectory()) {
        if (shouldSkipDocumentDiscoveryDir(current.dir, entry.name)) continue
        queue.push({ dir: fullPath, depth: current.depth + 1 })
        continue
      }

      if (!entry.isFile()) continue
      if (!entry.name.includes(marker)) continue
      if (!isSupportedProjectDocument(entry.name)) continue
      docs.push(fullPath)
    }
  }

  return dedupeDocumentPathsByContent(docs)
}

function createKnowledgeDocument(
  filePath: string,
  role: ProjectKnowledgeDocument["role"],
  index: number,
): ProjectKnowledgeDocument {
  const metadata = getFileMetadata(filePath)
  return {
    id: `doc-${index + 1}`,
    path: filePath,
    file_name: fileNameOf(filePath),
    role,
    type: getDocumentType(filePath),
    ...metadata,
    content_hash: getFileContentHash(filePath),
    parse_state: "metadata-only",
    warnings: [],
  }
}

function defaultKnowledgeTopics(documentIds: string[]): ProjectKnowledgeTopic[] {
  const topics: ProjectKnowledgeTopic["topic"][] = [
    "hardware_interface",
    "data_protocol",
    "data_convention",
    "packet_structure",
    "format_validation",
    "background_knowledge",
    "requirement_input_flow",
    "output_flow",
    "control_flow",
  ]

  return topics.map((topic) => ({
    topic,
    source_document_ids: documentIds,
    extraction_state: documentIds.length ? "pending-parser" : "missing",
    facts: [],
    warnings: documentIds.length
      ? ["Pending document parser implementation."]
      : ["No source document is available for this topic."],
  }))
}

function createPlaceholderReferences(documents: ProjectKnowledgeDocument[]): ProjectKnowledgeReference[] {
  void documents
  return []
}

function requirementSpecificationMatchScore(filePath: string, targetHint: string, sourceFileName: string): number {
  const fileKey = normalizeLookupText(fileNameOf(filePath))
  const hint = normalizeLookupText(targetHint)
  if (!fileKey || !hint) return 0
  let score = fileKey === hint ? 100 : fileKey.includes(hint) || hint.includes(fileKey) ? 70 : 20
  const sourceTokens = sourceFileName.match(/[A-Za-z0-9]{3,}/g) ?? []
  if (sourceTokens.some((token) => fileKey.includes(token.toLowerCase()))) score += 20
  if (/软件需求规格说明/u.test(fileNameOf(filePath))) score += /软件需求规格说明/u.test(targetHint) ? 10 : 0
  if (/系统需求规格说明/u.test(fileNameOf(filePath))) score += /系统需求规格说明/u.test(targetHint) ? 10 : 0
  return score
}

function findReferencedDocuments(
  projectRoot: string,
  targetHint: string,
  sourceFileName: string,
): Array<{ path: string; score: number }> {
  if (!isRequirementSpecificationName(targetHint)) return []

  const queue: Array<{ dir: string; depth: number }> = [{ dir: projectRoot, depth: 0 }]
  const candidates: string[] = []
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) continue
    if (current.depth > 6) continue

    let entries: Dirent[]
    try {
      entries = readdirSync(current.dir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      const fullPath = join(current.dir, entry.name)
      if (entry.isDirectory()) {
        if (shouldSkipDocumentDiscoveryDir(current.dir, entry.name)) continue
        queue.push({ dir: fullPath, depth: current.depth + 1 })
        continue
      }

      if (!entry.isFile()) continue
      if (!isSupportedProjectDocument(entry.name)) continue
      if (!isRequirementSpecificationName(entry.name)) continue
      if (/\u7b2c\u4e09\u65b9\u6d4b\u8bd5\u9700\u6c42/u.test(entry.name)) continue
      candidates.push(fullPath)
    }
  }

  return dedupeDocumentPathsByContent(candidates)
    .map((path) => ({ path, score: requirementSpecificationMatchScore(path, targetHint, sourceFileName) }))
    .sort((left, right) => right.score - left.score || left.path.length - right.path.length || left.path.localeCompare(right.path))
}

function appendReferencedDocuments(index: ProjectKnowledgeIndex): ProjectKnowledgeDocument[] {
  const existingPaths = new Set(index.source_documents.map((document) => document.path))
  const addedDocuments: ProjectKnowledgeDocument[] = []

  for (const reference of index.references) {
    const sourceDocument = index.source_documents.find((document) => document.id === reference.source_document_id)
    const isRequirementReference = reference.reference_type === "requirement-specification" ||
      (reference.reference_type === "external-document" && isRequirementSpecificationName(reference.target_hint ?? ""))
    if (!isRequirementReference) continue
    if (!sourceDocument || sourceDocument.role !== "primary-third-party-test-requirement") {
      reference.state = "not_followed_by_policy"
      reference.warnings = uniqueStrings([
        ...(reference.warnings ?? []),
        "References inside a requirement specification are not followed.",
      ])
      continue
    }
    const targetDocumentHint = reference.target_document_hint ?? reference.target_hint
    if (!targetDocumentHint) continue

    const matches = findReferencedDocuments(index.project_root, targetDocumentHint, sourceDocument.file_name)
    if (!matches.length) {
      reference.state = "unresolved"
      reference.warnings = uniqueStrings([
        ...(reference.warnings ?? []),
        `Requirement specification was not found for ${targetDocumentHint}.`,
      ])
      continue
    }
    const topScore = matches[0].score
    const topMatches = matches.filter((match) => match.score === topScore)
    if (topMatches.length > 1) {
      reference.state = "ambiguous"
      reference.warnings = uniqueStrings([
        ...(reference.warnings ?? []),
        `Multiple requirement specifications matched ${targetDocumentHint}: ${topMatches.map((match) => fileNameOf(match.path)).join(", ")}.`,
      ])
      continue
    }
    const matchedPath = topMatches[0].path

    const existingDocument = [...index.source_documents, ...addedDocuments]
      .find((document) => document.path === matchedPath)
    if (existingDocument) {
      reference.resolved_document_id = existingDocument.id
      reference.state = "resolved"
      continue
    }

    if (existingPaths.has(matchedPath)) continue

    const document = createKnowledgeDocument(
      matchedPath,
      "referenced-document",
      index.source_documents.length + addedDocuments.length,
    )
    reference.resolved_document_id = document.id
    reference.state = "resolved"
    addedDocuments.push(document)
    existingPaths.add(matchedPath)
  }

  if (addedDocuments.length > 0) {
    index.source_documents.push(...addedDocuments)
  }

  return addedDocuments
}

function hasNewResolvableRequirementSpecification(index: ProjectKnowledgeIndex): boolean {
  return index.references.some((reference) => {
    if (reference.reference_type !== "requirement-specification") return false
    if (reference.resolved_document_id) return false
    const sourceDocument = index.source_documents.find((document) => document.id === reference.source_document_id)
    if (!sourceDocument || sourceDocument.role !== "primary-third-party-test-requirement") return false
    const targetDocumentHint = reference.target_document_hint ?? reference.target_hint
    if (!targetDocumentHint) return false
    const matches = findReferencedDocuments(index.project_root, targetDocumentHint, sourceDocument.file_name)
    if (!matches.length) return false
    return matches.filter((match) => match.score === matches[0].score).length === 1
  })
}

function topicForText(text: string): ProjectKnowledgeTopic["topic"] {
  if (/\u786c\u4ef6|\u63a5\u53e3|\u603b\u7ebf|CAN|RS422|1553B/i.test(text)) return "hardware_interface"
  if (/\u6570\u636e\u534f\u8bae|\u534f\u8bae|\u6307\u4ee4|\u62a5\u6587|\u9065\u6d4b|\u9065\u63a7/i.test(text)) return "data_protocol"
  if (/\u7ea6\u5b9a|\u5b57\u8282\u5e8f|\u7f16\u7801|\u586b\u5145/i.test(text)) return "data_convention"
  if (/\u5305\u7ed3\u6784|\u5e27\u683c\u5f0f|TITLE|W0|SUM/i.test(text)) return "packet_structure"
  if (/\u6821\u9a8c|\u683c\u5f0f\u6821\u9a8c|SUM|checksum/i.test(text)) return "format_validation"
  if (/\u8f93\u5165\u6d41|\u8f93\u5165/i.test(text)) return "requirement_input_flow"
  if (/\u8f93\u51fa\u6d41|\u8f93\u51fa/i.test(text)) return "output_flow"
  if (/\u63a7\u5236\u6d41|\u72b6\u6001\u8f6c\u6362|\u6d41\u7a0b/i.test(text)) return "control_flow"
  return "background_knowledge"
}

type CachedDocumentExtraction = {
  schema_version: "1.0.0"
  extractor_version: string
  source_content_hash: string
  text: string
  html: string
  warnings: string[]
}

function documentExtractionCacheFile(cacheDir: string, contentHash: string): string {
  const cacheKey = createHash("sha256")
    .update(`${DOCUMENT_EXTRACTION_CACHE_SCHEMA_VERSION}\u0000${PROJECT_KNOWLEDGE_EXTRACTOR_VERSION}\u0000${contentHash}`)
    .digest("hex")
  return join(cacheDir, `${cacheKey}.json`)
}

function loadCachedDocumentExtraction(cacheFile: string, contentHash: string): CachedDocumentExtraction | null {
  if (!existsSync(cacheFile)) return null
  try {
    const parsed = JSON.parse(readFileSync(cacheFile, "utf-8")) as Partial<CachedDocumentExtraction>
    if (
      parsed.schema_version !== DOCUMENT_EXTRACTION_CACHE_SCHEMA_VERSION ||
      parsed.extractor_version !== PROJECT_KNOWLEDGE_EXTRACTOR_VERSION ||
      parsed.source_content_hash !== contentHash ||
      typeof parsed.text !== "string" ||
      typeof parsed.html !== "string"
    ) return null
    return {
      schema_version: DOCUMENT_EXTRACTION_CACHE_SCHEMA_VERSION,
      extractor_version: PROJECT_KNOWLEDGE_EXTRACTOR_VERSION,
      source_content_hash: contentHash,
      text: parsed.text,
      html: parsed.html,
      warnings: Array.isArray(parsed.warnings)
        ? parsed.warnings.filter((warning): warning is string => typeof warning === "string")
        : [],
    }
  } catch {
    return null
  }
}

async function extractDocxContent(
  filePath: string,
  cacheDir?: string,
): Promise<{ text: string; html: string; warnings: string[] }> {
  const contentHash = getFileContentHash(filePath)
  const cacheFile = cacheDir && contentHash ? documentExtractionCacheFile(cacheDir, contentHash) : undefined
  const cached = cacheFile && contentHash ? loadCachedDocumentExtraction(cacheFile, contentHash) : null
  if (cached) return { text: cached.text, html: cached.html, warnings: cached.warnings }

  try {
    const mammoth = await import("mammoth")
    const [textResult, htmlResult] = await Promise.all([
      mammoth.extractRawText({ path: filePath }),
      mammoth.convertToHtml({ path: filePath }),
    ])
    const extracted = {
      text: textResult.value,
      html: htmlResult.value,
      warnings: [
        ...textResult.messages.map((message) => message.message).filter(Boolean),
        ...htmlResult.messages.map((message) => message.message).filter(Boolean),
      ],
    }
    if (cacheFile && contentHash) {
      mkdirSync(dirname(cacheFile), { recursive: true })
      const cacheEntry: CachedDocumentExtraction = {
        schema_version: DOCUMENT_EXTRACTION_CACHE_SCHEMA_VERSION,
        extractor_version: PROJECT_KNOWLEDGE_EXTRACTOR_VERSION,
        source_content_hash: contentHash,
        ...extracted,
      }
      writeFileSync(cacheFile, `${JSON.stringify(cacheEntry)}\n`, "utf-8")
    }
    return extracted
  } catch (error) {
    return {
      text: "",
      html: "",
      warnings: [`Failed to extract docx text: ${error instanceof Error ? error.message : String(error)}`],
    }
  }
}

function decodeHtmlText(input: string): string {
  return input
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function lastParagraphBefore(html: string, offset: number): string | undefined {
  const before = html.slice(0, offset)
  const paragraphs = Array.from(before.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi))
  const last = paragraphs.at(-1)?.[1]
  return last ? decodeHtmlText(last) : undefined
}

function extractTableAliases(caption: string | undefined, firstRowText: string): string[] {
  const text = [caption, firstRowText].filter(Boolean).join(" ")
  const aliases = new Set<string>()

  for (const match of text.matchAll(/(?:\u9644\u8868|\u8868)\s*([A-Za-z]?\s*[-－]?\s*\d+(?:\.\d+)*(?:\s*[-－]\s*\d+)?)/g)) {
    const identifier = match[1].replace(/\s+/g, "").replace(/－/g, "-")
    aliases.add(`\u9644\u8868${identifier}`)
    aliases.add(`\u8868${identifier}`)
  }

  if (caption) aliases.add(caption)
  if (firstRowText) aliases.add(firstRowText)

  return Array.from(aliases).filter(Boolean)
}

function parseHtmlSpan(attributes: string, name: "rowspan" | "colspan"): number | undefined {
  const match = attributes.match(new RegExp(`${name}\\s*=\\s*["']?(\\d+)["']?`, "i"))
  const value = match?.[1] ? Number.parseInt(match[1], 10) : undefined
  return value && value > 1 ? value : undefined
}

function extractTableCellsFromHtml(tableHtml: string): ProjectKnowledgeTableCell[] {
  const cells: ProjectKnowledgeTableCell[] = []
  const occupied = new Set<string>()
  const rowMatches = Array.from(tableHtml.matchAll(/<tr\b[\s\S]*?<\/tr>/gi))

  rowMatches.forEach((rowMatch, rowIndex) => {
    let colIndex = 0
    const cellMatches = Array.from(rowMatch[0].matchAll(/<(t[dh])\b([^>]*)>([\s\S]*?)<\/t[dh]>/gi))

    for (const cellMatch of cellMatches) {
      while (occupied.has(`${rowIndex}:${colIndex}`)) colIndex += 1

      const tagName = cellMatch[1].toLowerCase()
      const attributes = cellMatch[2] ?? ""
      const text = decodeHtmlText(cellMatch[3] ?? "")
      const rowspan = parseHtmlSpan(attributes, "rowspan")
      const colspan = parseHtmlSpan(attributes, "colspan")
      const rowSpanValue = rowspan ?? 1
      const colSpanValue = colspan ?? 1

      cells.push({
        row: rowIndex,
        col: colIndex,
        text,
        ...(rowspan ? { rowspan } : {}),
        ...(colspan ? { colspan } : {}),
        is_header: tagName === "th",
      })

      for (let r = rowIndex; r < rowIndex + rowSpanValue; r += 1) {
        for (let c = colIndex; c < colIndex + colSpanValue; c += 1) {
          occupied.add(`${r}:${c}`)
        }
      }

      colIndex += colSpanValue
    }
  })

  return cells
}

function materializeRowsFromCells(cells: ProjectKnowledgeTableCell[]): string[][] {
  if (!cells.length) return []

  const maxRow = Math.max(...cells.map((cell) => cell.row + (cell.rowspan ?? 1) - 1))
  const maxCol = Math.max(...cells.map((cell) => cell.col + (cell.colspan ?? 1) - 1))
  const rows = Array.from({ length: maxRow + 1 }, () => Array.from({ length: maxCol + 1 }, () => ""))

  for (const cell of cells) {
    rows[cell.row][cell.col] = cell.text
    const rowspan = cell.rowspan ?? 1
    const colspan = cell.colspan ?? 1
    for (let r = cell.row; r < cell.row + rowspan; r += 1) {
      for (let c = cell.col; c < cell.col + colspan; c += 1) {
        if (r === cell.row && c === cell.col) continue
        rows[r] ??= Array.from({ length: maxCol + 1 }, () => "")
        rows[r][c] ??= ""
      }
    }
  }

  return rows.filter((row) => row.some((cell) => cell.trim()))
}

function extractDocxTablesFromHtml(
  documentId: string,
  html: string,
): ProjectKnowledgeTable[] {
  const tables: ProjectKnowledgeTable[] = []
  const tablePattern = /<table[\s\S]*?<\/table>/gi

  for (const match of html.matchAll(tablePattern)) {
    const tableHtml = match[0]
    const cells = extractTableCellsFromHtml(tableHtml)
    const rows = materializeRowsFromCells(cells)

    if (rows.length === 0) continue

    const captionCandidate = lastParagraphBefore(html, match.index ?? 0)
    const firstRowText = rows[0]?.join(" ") ?? ""
    const caption = captionCandidate && /表|附表|格式|定义|协议|指令|数据包/.test(captionCandidate)
      ? captionCandidate
      : firstRowText
    const topic = topicForText([caption, rows.flat().join(" ")].join(" "))

    tables.push({
      id: `${documentId}-table-${tables.length + 1}`,
      source_document_id: documentId,
      caption,
      aliases: extractTableAliases(caption, firstRowText),
      topic,
      rows,
      table_html: tableHtml,
      cells,
      confidence: caption ? 0.65 : 0.5,
      warnings: caption
        ? []
        : ["Table caption was not found; first row is used as the semantic clue."],
    })
  }

  return tables
}

function splitKnowledgeText(text: string): string[] {
  return text
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 4)
}

const REFERENCE_LOCATOR_ATOM_PATTERN_SOURCE = [
  "(?:\u9644\u5f55\\s*(?:[A-Za-z]|\\d+|[\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341]+))",
  "(?:\u9644\u8868\\s*[A-Za-z]?\\s*[-－]?\\s*\\d+(?:\\.\\d+)*(?:\\s*[-－]\\s*\\d+)?)",
  "(?:\u8868\\s*[A-Za-z]?\\s*[-－]?\\s*\\d+(?:\\.\\d+)*(?:\\s*[-－]\\s*\\d+)?)",
  "(?:\u7b2c?\\s*\\d+(?:\\.\\d+)*\\s*\u8282)",
].join("|")

const REFERENCE_LOCATOR_PATTERN_SOURCE =
  `(?:${REFERENCE_LOCATOR_ATOM_PATTERN_SOURCE})(?:\\s*(?:中(?:的)?|内|的)?\\s*(?:${REFERENCE_LOCATOR_ATOM_PATTERN_SOURCE}))*`

function referenceTargetPath(value: string | undefined): NonNullable<ProjectKnowledgeReference["target_path"]> {
  if (!value) return []
  const locatorPattern = new RegExp(REFERENCE_LOCATOR_ATOM_PATTERN_SOURCE, "g")
  const path: NonNullable<ProjectKnowledgeReference["target_path"]> = []
  for (const match of value.matchAll(locatorPattern)) {
    const locator = match[0].replace(/\s+/g, "").replace(/－/g, "-")
    if (/^附录/u.test(locator)) {
      path.push({ kind: "appendix", value: locator.replace(/^附录/u, "").toUpperCase() })
      continue
    }
    if (/^(?:附表|表)/u.test(locator)) {
      path.push({ kind: "table", value: locator.replace(/^(?:附表|表)/u, "") })
      continue
    }
    const section = locator.match(/^第?(\d+(?:\.\d+)*)节$/u)
    if (section) path.push({ kind: "section", value: section[1] })
  }
  return path
}

function referenceTargetPathHint(
  target: NonNullable<ProjectKnowledgeReference["target_path"]>[number] | undefined,
): string | undefined {
  if (!target) return undefined
  if (target.kind === "appendix") return `附录${target.value}`
  if (target.kind === "table") return `表${target.value}`
  return `第${target.value}节`
}

function referenceTargetKind(targetHint: string | undefined): ProjectKnowledgeReference["target_kind"] {
  if (!targetHint) return "document"
  if (/^\u9644\u5f55/u.test(targetHint)) return "appendix"
  if (/^(?:\u9644\u8868|\u8868)/u.test(targetHint)) return "table"
  if (/\u8282$/u.test(targetHint)) return "section"
  return "document"
}

function referenceId(
  documentId: string,
  sourceSnippetId: string | undefined,
  sourceTableId: string | undefined,
  referenceText: string,
  matchIndex: number,
): string {
  const digest = createHash("sha256")
    .update([documentId, sourceSnippetId ?? "", sourceTableId ?? "", referenceText, matchIndex].join("\u0000"))
    .digest("hex")
    .slice(0, 16)
  return `reference-${digest}`
}

export function extractReferencesFromText(
  document: ProjectKnowledgeDocument,
  text: string,
  sourceSnippetId?: string,
  sourceTableId?: string,
): ProjectKnowledgeReference[] {
  const references: ProjectKnowledgeReference[] = []
  const occupiedRanges: Array<{ start: number; end: number }> = []
  const requirementPattern = new RegExp(
    `(?:\\u300a([^\\u300a\\u300b]*(?:\u9700\u6c42\u89c4\u683c\u8bf4\u660e\u4e66?)[^\\u300a\\u300b]*)\\u300b|((?:\u8f6f\u4ef6|\u7cfb\u7edf)?\u9700\u6c42\u89c4\u683c\u8bf4\u660e\u4e66?))(?:\\s*(?:\u4e2d\u7684|\u4e2d))?\\s*(${REFERENCE_LOCATOR_PATTERN_SOURCE})?`,
    "g",
  )

  for (const match of text.matchAll(requirementPattern)) {
    const start = match.index ?? 0
    occupiedRanges.push({ start, end: start + match[0].length })
    const targetDocumentHint = (match[1] ?? match[2] ?? "").trim()
    const targetPath = referenceTargetPath(match[3])
    const targetHint = referenceTargetPathHint(targetPath.at(-1))
    references.push({
      reference_id: referenceId(document.id, sourceSnippetId, sourceTableId, match[0], start),
      source_document_id: document.id,
      source_snippet_id: sourceSnippetId,
      source_table_id: sourceTableId,
      reference_text: match[0],
      reference_type: "requirement-specification",
      target_document_hint: targetDocumentHint,
      target_hint: targetHint,
      target_kind: referenceTargetKind(targetHint),
      target_path: targetPath.length ? targetPath : undefined,
      depth: 1,
      state: document.role === "primary-third-party-test-requirement"
        ? "pending-parser"
        : "not_followed_by_policy",
      warnings: document.role === "primary-third-party-test-requirement"
        ? []
        : ["References inside a requirement specification are not followed."],
    })
  }

  const documentPattern = /\u300a([^\u300a\u300b]+)\u300b/g
  for (const match of text.matchAll(documentPattern)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    if (occupiedRanges.some((range) => start < range.end && end > range.start)) continue
    references.push({
      reference_id: referenceId(document.id, sourceSnippetId, sourceTableId, match[0], start),
      source_document_id: document.id,
      source_snippet_id: sourceSnippetId,
      source_table_id: sourceTableId,
      reference_text: match[0],
      reference_type: "unsupported-external",
      target_kind: "document",
      target_hint: match[1],
      depth: 1,
      state: "unsupported",
      warnings: ["Only requirement-specification external references are supported."],
    })
  }

  const internalPattern = new RegExp(`(?:\u8be6\u89c1|\u53c2\u89c1|\u89c1|\u6309)?\\s*(${REFERENCE_LOCATOR_PATTERN_SOURCE})`, "g")
  for (const match of text.matchAll(internalPattern)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    if (occupiedRanges.some((range) => start < range.end && end > range.start)) continue
    const targetPath = referenceTargetPath(match[1])
    const targetHint = referenceTargetPathHint(targetPath.at(-1)) ?? match[1].replace(/\s+/g, "").replace(/－/g, "-")
    references.push({
      reference_id: referenceId(document.id, sourceSnippetId, sourceTableId, match[0], start),
      source_document_id: document.id,
      source_snippet_id: sourceSnippetId,
      source_table_id: sourceTableId,
      reference_text: match[0],
      reference_type: "internal",
      target_kind: referenceTargetKind(targetHint),
      target_hint: targetHint,
      target_path: targetPath.length ? targetPath : undefined,
      depth: document.role === "primary-third-party-test-requirement" ? 0 : 2,
      state: document.role === "primary-third-party-test-requirement"
        ? "pending-parser"
        : "not_followed_by_policy",
      warnings: document.role === "primary-third-party-test-requirement"
        ? []
        : ["References inside a requirement specification are not followed."],
    })
  }

  return references
}

async function extractDocumentIntoKnowledgeIndex(
  index: ProjectKnowledgeIndex,
  document: ProjectKnowledgeDocument,
  snippets: ProjectKnowledgeSnippet[],
  tables: ProjectKnowledgeTable[],
  references: ProjectKnowledgeReference[],
  cacheDir?: string,
): Promise<void> {
  if (document.type !== "docx") {
    document.warnings.push("Only docx text extraction is currently implemented.")
    return
  }

  const extracted = await extractDocxContent(document.path, cacheDir)
  document.warnings.push(...extracted.warnings)

  if (!extracted.text.trim()) {
    document.parse_state = "failed"
    return
  }

  document.parse_state = "parsed"
  const lines = splitKnowledgeText(extracted.text)
  for (const [lineIndex, line] of lines.entries()) {
    const topic = topicForText(line)
    const snippetId = `${document.id}-snippet-${lineIndex + 1}`
    snippets.push({
      id: snippetId,
      source_document_id: document.id,
      topic,
      text: line,
      confidence: document.role === "referenced-document" ? 0.5 : 0.55,
    })
    references.push(...extractReferencesFromText(document, line, snippetId))
  }
  const documentTables = extractDocxTablesFromHtml(document.id, extracted.html)
  tables.push(...documentTables)
  for (const table of documentTables) {
    const tableText = [table.caption ?? "", ...table.rows.flat()].filter(Boolean).join("\n")
    const ownLocatorKeys = new Set(uniqueStrings([table.caption ?? "", ...table.aliases]).map(normalizeLookupText))
    references.push(...extractReferencesFromText(document, tableText, undefined, table.id).filter((reference) => {
      if (!reference.target_hint) return true
      return !ownLocatorKeys.has(normalizeLookupText(reference.target_hint))
    }))
  }
}

function updateKnowledgeTopicsFromSnippets(index: ProjectKnowledgeIndex, snippets: ProjectKnowledgeSnippet[]): void {
  const snippetsByTopic = new Map<ProjectKnowledgeTopic["topic"], ProjectKnowledgeSnippet[]>()
  for (const snippet of snippets) {
    const existing = snippetsByTopic.get(snippet.topic) ?? []
    existing.push(snippet)
    snippetsByTopic.set(snippet.topic, existing)
  }

  index.topics = index.topics.map((topic) => {
    const topicSnippets = snippetsByTopic.get(topic.topic) ?? []
    return {
      ...topic,
      source_document_ids: uniqueStrings([
        ...topic.source_document_ids,
        ...topicSnippets.map((snippet) => snippet.source_document_id),
      ]),
      extraction_state: topicSnippets.length ? "parsed" : topic.extraction_state,
      facts: topicSnippets.slice(0, 50).map((snippet) => snippet.text),
      warnings: topicSnippets.length ? [] : topic.warnings,
    }
  })
}

function extractHexBytes(text: string): string[] {
  const matches = text.match(/\b(?:0x)?[0-9a-fA-F]{2}\b/g) ?? []
  return matches
    .map((value) => value.replace(/^0x/i, "").toUpperCase())
    .filter((value) => /^[0-9A-F]{2}$/.test(value))
    .slice(0, 256)
}

function inferPacketCandidateName(snippet: ProjectKnowledgeSnippet): string {
  const protocolMatch = snippet.text.match(/([\w\u4e00-\u9fff-]{2,40})(?:\u534f\u8bae|\u6307\u4ee4|\u62a5\u6587|\u6570\u636e\u5305)/)
  if (protocolMatch?.[1]) return protocolMatch[1]

  const sendMatch = snippet.text.match(/\u53d1\u9001([\w\u4e00-\u9fff-]{2,40})/)
  if (sendMatch?.[1]) return sendMatch[1]

  return `packet-model-${snippet.id}`
}

function computeByteSum(bytes: string[]): string {
  const sum = bytes.reduce((acc, byte) => acc + Number.parseInt(byte, 16), 0) & 0xff
  return sum.toString(16).toUpperCase().padStart(2, "0")
}

const DEFAULT_CHECKSUM_RULE = "SUM = low8(byte-sum(TITLE + W0 + W1 + ... + W(n-1)))"

function normalizeHexByte(value: string | undefined): string | undefined {
  if (!value) return undefined
  const match = value.trim().match(/^(?:0x)?([0-9a-fA-F]{1,2})H?$/)
  return match?.[1]?.toUpperCase().padStart(2, "0")
}

function extractExplicitSupportByte(row: string[]): string | undefined {
  for (const cell of row) {
    const trimmed = cell.trim()
    const exact = trimmed.match(/^(?:0x([0-9A-Fa-f]{1,2})|([0-9A-Fa-f]{1,2})H)$/)
    const value = exact?.[1] ?? exact?.[2]
    if (value) return value.toUpperCase().padStart(2, "0")
  }

  const rowText = row.filter(Boolean).join(" ")
  const normalWholeByte = rowText.match(/(?:^|[；;，,\s])(?:0x)?([0-9A-Fa-f]{1,2})H?\s*[：:]\s*正常/)
  if (normalWholeByte?.[1]) return normalWholeByte[1].toUpperCase().padStart(2, "0")

  const optionByte = rowText.match(/(?:^|[^A-Za-z0-9])([0-9A-Fa-f]{1,2})H\s*[：:]/)
  if (optionByte?.[1]) return optionByte[1].toUpperCase().padStart(2, "0")

  return undefined
}

function shouldDefaultSupportRowToZero(row: string[]): boolean {
  const rowText = normalizeLookupText(row.filter(Boolean).join(" "))
  return /十六进制原码|采集值原码|数据定义|参数|门限|状态|标志|模式|选择|设置|物理值|原码值|备用|预留|公式|转换|N\s*=|Bit\d+/i.test(rowText)
}

function headerIndex(headers: string[], patterns: RegExp[]): number {
  return headers.findIndex((header) => patterns.some((pattern) => pattern.test(header)))
}

function parseByteNumber(value: string | undefined): number | undefined {
  if (!value) return undefined
  const numberMatch = value.match(/\d+/)
  if (!numberMatch) return undefined
  const parsed = Number(numberMatch[0])
  return Number.isFinite(parsed) ? parsed : undefined
}

function extractDefaultValue(value: string | undefined): string | undefined {
  if (!value) return undefined
  const hexMatch = value.match(/\b(?:0x)?[0-9a-fA-F]{1,2}H?\b/i)
  const normalized = normalizeHexByte(hexMatch?.[0])
  if (normalized) return normalized
  const trimmed = value.trim()
  return trimmed || undefined
}

type FrameCell =
  | { kind: "byte"; value: string; checksumRole: "title" | "length" | "data" | "none" }
  | { kind: "sum" }

function parseFrameCell(cell: string, dataValues: Map<string, string>): FrameCell | null {
  const normalized = cell.replace(/\s+/g, "")
  if (!normalized) return null
  if (/^SUM$/i.test(normalized)) return { kind: "sum" }

  const dataName = normalized.match(/^(W\d+)$/i)?.[1]?.toUpperCase()
  if (dataName) {
    return {
      kind: "byte",
      value: dataValues.get(dataName) ?? "00",
      checksumRole: "data",
    }
  }

  const titleMatch = normalized.match(/^(?:TITLE|Title|T)([0-9A-Fa-f]{1,2})H$/)
  if (titleMatch?.[1]) {
    return {
      kind: "byte",
      value: titleMatch[1].toUpperCase().padStart(2, "0"),
      checksumRole: "title",
    }
  }

  const lengthMatch = normalized.match(/^(?:LENGTH|Length|L)([0-9A-Fa-f]{1,2})H$/)
  if (lengthMatch?.[1]) {
    return {
      kind: "byte",
      value: lengthMatch[1].toUpperCase().padStart(2, "0"),
      checksumRole: "length",
    }
  }

  const hexWithSuffix = normalized.match(/^([0-9A-Fa-f]{1,2})H$/)
  if (hexWithSuffix?.[1]) {
    return {
      kind: "byte",
      value: hexWithSuffix[1].toUpperCase().padStart(2, "0"),
      checksumRole: "none",
    }
  }

  const plainByte = normalized.match(/^(?:0x)?([0-9A-Fa-f]{1,2})$/)
  if (plainByte?.[1]) {
    return {
      kind: "byte",
      value: plainByte[1].toUpperCase().padStart(2, "0"),
      checksumRole: "none",
    }
  }

  return null
}

function extractDataValuesFromTable(table: ProjectKnowledgeTable): Map<string, string> {
  const values = new Map<string, string>()
  for (const row of table.rows) {
    const dataName = row.find((cell) => /^W\d+$/i.test(cell.trim()))?.trim().toUpperCase()
    if (!dataName) continue

    const explicitByte = extractExplicitSupportByte(row)
    if (explicitByte) {
      values.set(dataName, explicitByte)
      continue
    }

    if (shouldDefaultSupportRowToZero(row)) {
      values.set(dataName, "00")
    }
  }
  return values
}

function extractFrameDataFieldNames(table: ProjectKnowledgeTable): string[] {
  const names: string[] = []
  for (const row of table.rows) {
    for (const cell of row) {
      const normalized = cell.replace(/\s+/g, "")
      const name = normalized.match(/^W(\d+)$/i)?.[1]
      if (name) names.push(`W${name}`)
    }
  }
  return uniqueStrings(names.map((name) => name.toUpperCase())).sort((a, b) => {
    const left = Number(a.slice(1))
    const right = Number(b.slice(1))
    return left - right
  })
}

function findFieldSourceText(fieldName: string, table: ProjectKnowledgeTable): string | undefined {
  const key = fieldName.toUpperCase()
  const matched = table.rows.find((row) => row.some((cell) => cell.trim().toUpperCase() === key))
  return matched?.filter(Boolean).join(" | ")
}

function findRelatedSupportTables(table: ProjectKnowledgeTable, tables: ProjectKnowledgeTable[]): ProjectKnowledgeTable[] {
  const tableIndex = tables.findIndex((candidate) => candidate.id === table.id)
  if (tableIndex < 0) return []

  const currentCaption = normalizeLookupText(table.caption ?? "")
  const related: ProjectKnowledgeTable[] = []
  for (const candidate of tables.slice(tableIndex + 1, tableIndex + 3)) {
    if (isFrameFormatTable(candidate)) continue

    const candidateCaption = normalizeLookupText(candidate.caption ?? "")
    const looksRelated =
      Boolean(currentCaption && candidateCaption && (currentCaption.includes(candidateCaption) || candidateCaption.includes(currentCaption))) ||
      isSupportDefinitionTable(candidate)
    if (looksRelated) related.push(candidate)
  }
  return related
}

function fieldValuePlanToDataValues(plan: PacketFieldValuePlan[] | undefined): Map<string, string> {
  const values = new Map<string, string>()
  for (const item of plan ?? []) {
    const value = normalizeHexByte(item.value)
    if (value) values.set(item.field_name.toUpperCase(), value)
  }
  return values
}

function mergeFieldValuePlans(
  base: PacketFieldValuePlan[],
  overrides: PacketFieldValuePlan[],
): PacketFieldValuePlan[] {
  const merged = new Map<string, PacketFieldValuePlan>()
  for (const item of base) merged.set(item.field_name.toUpperCase(), item)
  for (const item of overrides) merged.set(item.field_name.toUpperCase(), item)
  return Array.from(merged.values()).sort((a, b) => {
    const left = Number(a.field_name.replace(/^W/i, ""))
    const right = Number(b.field_name.replace(/^W/i, ""))
    return left - right
  })
}

function buildFieldValuePlan(
  frameTable: ProjectKnowledgeTable,
  supportTables: ProjectKnowledgeTable[],
  overrides: PacketFieldValuePlan[] = [],
): PacketFieldValuePlan[] {
  const supportValues = new Map<string, { value: string; table: ProjectKnowledgeTable; sourceText?: string }>()
  for (const supportTable of supportTables) {
    const tableValues = extractDataValuesFromTable(supportTable)
    for (const [fieldName, value] of tableValues) {
      if (supportValues.has(fieldName)) continue
      supportValues.set(fieldName, {
        value,
        table: supportTable,
        sourceText: findFieldSourceText(fieldName, supportTable),
      })
    }
  }

  const basePlan = extractFrameDataFieldNames(frameTable).map((fieldName): PacketFieldValuePlan => {
    const supportValue = supportValues.get(fieldName)
    if (supportValue) {
      return {
        field_name: fieldName,
        value: supportValue.value,
        value_source: "support-table",
        source_table_id: supportValue.table.id,
        source_text: supportValue.sourceText,
        confidence: 0.72,
        reasoning: [`${fieldName} was filled from a related support/definition table.`],
      }
    }

    return {
      field_name: fieldName,
      value: "00",
      value_source: "fallback-zero",
      source_table_id: frameTable.id,
      source_text: findFieldSourceText(fieldName, frameTable),
      confidence: 0.2,
      reasoning: [`${fieldName} has no concrete value in the current field plan; 00 is used as a loose-mode fallback.`],
    }
  })

  return mergeFieldValuePlans(basePlan, overrides)
}

function fieldValuePlanToPacketFields(plan: PacketFieldValuePlan[]): PacketField[] {
  return plan.map((item) => ({
    field_name: item.field_name,
    byte_offset: Number(item.field_name.replace(/^W/i, "")),
    byte_length: 1,
    default_value: item.value,
    value_rule: item.reasoning.join(" "),
    source_table_id: item.source_table_id,
  }))
}

function isFrameFormatTable(table: ProjectKnowledgeTable): boolean {
  const tableText = [table.caption, ...table.rows.map((row) => row.join(" "))].filter(Boolean).join(" ")
  const isCanFrame = /\u5e27\u5e8f|\u4ef2\u88c1\u573a|\u63a7\u5236\u573a|DLC|RTR/i.test(tableText)
  const isSpiFrame = /\bADDRESS\b/i.test(tableText) &&
    /\bLENGTH\b/i.test(tableText) &&
    /\bDATA\s*\d+/i.test(tableText) &&
    /\bSUM\b/i.test(tableText)
  const isSpaceWireBlock = /(?:Space\s*wire|\u4e0a\u6ce8\u6570\u636e\u5757)/i.test(tableText) &&
    /W\s*0\s*[~～\-]\s*W\s*1/i.test(tableText) &&
    /W\s*716\b/i.test(tableText) &&
    /W\s*719\b/i.test(tableText)
  return isCanFrame || isSpiFrame || isSpaceWireBlock
}

function isSupportDefinitionTable(table: ProjectKnowledgeTable): boolean {
  const tableText = normalizeLookupText(
    [table.caption, ...table.rows.slice(0, 3).map((row) => row.join(" "))].filter(Boolean).join(" "),
  )
  return /参数处理方法汇总表|处理方法汇总表|参数定义|定义表|数据定义说明|参数名称|数据编号/.test(tableText)
}

function snippetOrdinal(snippet: ProjectKnowledgeSnippet): number {
  return Number(snippet.id.match(/snippet-(\d+)$/)?.[1] ?? 0)
}

function tableOrdinal(table: ProjectKnowledgeTable): number {
  return Number(table.id.match(/table-(\d+)$/)?.[1] ?? 0)
}

function chineseChapterNumber(value: string): number | undefined {
  const digits: Record<string, number> = {
    一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  }
  if (value in digits) return digits[value]
  if (/^十[一二三四五六七八九]$/.test(value)) return 10 + (digits[value[1]] ?? 0)
  if (/^[一二三四五六七八九]十$/.test(value)) return (digits[value[0]] ?? 0) * 10
  if (/^[一二三四五六七八九]十[一二三四五六七八九]$/.test(value)) {
    return (digits[value[0]] ?? 0) * 10 + (digits[value[2]] ?? 0)
  }
  return undefined
}

function sectionHeadingOf(snippet: ProjectKnowledgeSnippet): { sectionId: string; title: string } | null {
  const text = snippet.text.trim()
  const appendixMatch = text.match(/^\u9644\u5f55\s*([A-Za-z]|\d+|[\u4e00-\u4e5d\u5341]+)(?:[.\u3001\uff1a:]|\s)*(.*)$/u)
  if (appendixMatch) {
    const identifier = appendixMatch[1].trim().toUpperCase()
    return {
      sectionId: `appendix-${identifier}`,
      title: [`\u9644\u5f55${identifier}`, appendixMatch[2]?.trim()].filter(Boolean).join(" "),
    }
  }
  const match = text.match(/^(\d+(?:\.\d+)*)(?:[.、])?\s+(.+)$/)
  if (match) {
    return {
      sectionId: match[1],
      title: match[2].trim(),
    }
  }
  const chineseMatch = text.match(/^第\s*([一二三四五六七八九十]+)\s*章(?:节)?\s*[：:]?\s*(.+)$/)
  const chapterNumber = chineseMatch ? chineseChapterNumber(chineseMatch[1]) : undefined
  if (!chineseMatch || chapterNumber === undefined) return null
  return {
    sectionId: String(chapterNumber),
    title: chineseMatch[2].trim(),
  }
}

function tableSectionHeadingOf(table: ProjectKnowledgeTable): { sectionId: string; title: string } | null {
  const caption = table.caption?.trim()
  if (!caption) return null

  const match = caption.match(/^(?:\u8868|\u9644\u8868|\u8868\u683c)?\s*(\d+(?:\.\d+)+)(?:\s*[-\uff0d]\s*\d+)?\s*(.*)$/)
  if (!match) return null

  const title = match[2]
    .replace(/^[\s,，:：;；\-－]+/, "")
    .trim()
  return {
    sectionId: match[1],
    title,
  }
}

function findTableCaptionSnippetOrdinal(table: ProjectKnowledgeTable, snippets: ProjectKnowledgeSnippet[]): number {
  const captionKey = normalizeLookupText(table.caption ?? "")
  if (!captionKey) return Number.MAX_SAFE_INTEGER

  const matched = snippets.find((snippet) => {
    if (snippet.source_document_id !== table.source_document_id) return false
    const snippetKey = normalizeLookupText(snippet.text)
    const looksLikeTableCaption = /^\s*(?:表|附表)\s*[A-Za-z0-9]/.test(snippet.text)
    return snippetKey && (snippetKey.includes(captionKey) || (looksLikeTableCaption && captionKey.includes(snippetKey)))
  })

  return matched ? snippetOrdinal(matched) : Number.MAX_SAFE_INTEGER
}

function buildProtocolsFromRelations(
  orderedTables: ProjectKnowledgeTable[],
  primaryTables: ProjectKnowledgeTable[],
  protocolRelations: SectionProtocolRelation[],
  candidates: PacketModelCandidate[],
): SectionProtocol[] {
  return primaryTables.map((frameTable, index) => {
    const nextFrame = primaryTables[index + 1]
    const start = orderedTables.findIndex((table) => table.id === frameTable.id)
    const end = nextFrame ? orderedTables.findIndex((table) => table.id === nextFrame.id) : orderedTables.length
    const relation = protocolRelations.find((item) => item.frame_table_id === frameTable.id)
    const dataDictionaryTableIds = relation?.dictionary_table_id
      ? [relation.dictionary_table_id]
      : orderedTables
          .slice(start + 1, end)
          .filter((table) => !isFrameFormatTable(table))
          .map((table) => table.id)
    const candidate = [...candidates].reverse().find((item) => item.source_snippet_ids.includes(frameTable.id))
    return {
      name: relation?.preferred_name ?? frameTable.caption ?? frameTable.id,
      frame_table_id: frameTable.id,
      data_dictionary_table_ids: dataDictionaryTableIds,
      generated_candidate_id: candidate?.id,
      generation_mode: relation?.generation_mode,
      flow_direction: relation?.flow_direction,
      source_section: relation?.source_section,
      source_flow_heading: relation?.source_flow_heading,
      should_generate_frame_table_file: relation?.should_generate_frame_table_file,
      checksum_rule: relation?.checksum_rule ?? candidate?.checksum_rule ?? DEFAULT_CHECKSUM_RULE,
      basis: [frameTable.id, ...dataDictionaryTableIds],
      confidence: Math.max(relation?.confidence ?? 0, dataDictionaryTableIds.length ? 0.9 : 0.85),
    }
  })
}

function resolvedFrameLayoutTablesForSnippets(
  snippetIds: string[],
  references: ProjectKnowledgeReference[],
  tablesById: Map<string, ProjectKnowledgeTable>,
): ProjectKnowledgeTable[] {
  const activeSnippetIds = new Set(snippetIds)
  const resolvedTableIds = uniqueStrings(references.flatMap((reference) => {
    if (
      !reference.source_snippet_id ||
      !activeSnippetIds.has(reference.source_snippet_id) ||
      (reference.state !== "resolved" && reference.state !== "fallback_resolved") ||
      !reference.semantic_roles?.includes("frame_layout")
    ) return []
    return reference.resolved_table_ids ?? (reference.resolved_table_id ? [reference.resolved_table_id] : [])
  }))
  return resolvedTableIds
    .map((tableId) => tablesById.get(tableId))
    .filter((table): table is ProjectKnowledgeTable => Boolean(table && isFrameFormatTable(table)))
}

function buildSectionProtocolModels(
  snippets: ProjectKnowledgeSnippet[],
  tables: ProjectKnowledgeTable[],
  candidates: PacketModelCandidate[],
  references: ProjectKnowledgeReference[] = [],
): SectionProtocolModel[] {
  const snippetsByDocument = new Map<string, ProjectKnowledgeSnippet[]>()
  for (const snippet of snippets) {
    const documentSnippets = snippetsByDocument.get(snippet.source_document_id) ?? []
    documentSnippets.push(snippet)
    snippetsByDocument.set(snippet.source_document_id, documentSnippets)
  }

  const tablesByDocument = new Map<string, ProjectKnowledgeTable[]>()
  for (const table of tables) {
    const documentTables = tablesByDocument.get(table.source_document_id) ?? []
    documentTables.push(table)
    tablesByDocument.set(table.source_document_id, documentTables)
  }

  const models: SectionProtocolModel[] = []
  const allTablesById = new Map(tables.map((table) => [table.id, table]))
  const documentIds = uniqueStrings([
    ...snippetsByDocument.keys(),
    ...tablesByDocument.keys(),
  ])
  for (const documentId of documentIds) {
    const documentTables = tablesByDocument.get(documentId) ?? []
    const documentSnippets = (snippetsByDocument.get(documentId) ?? []).sort((a, b) => snippetOrdinal(a) - snippetOrdinal(b))
    const headings = documentSnippets
      .map((snippet) => {
        const heading = sectionHeadingOf(snippet)
        return heading ? { ...heading, snippet } : null
      })
      .filter((heading): heading is { sectionId: string; title: string; snippet: ProjectKnowledgeSnippet } => Boolean(heading))

    const groupedTables = new Map<string, {
      heading?: { sectionId: string; title: string; snippet: ProjectKnowledgeSnippet }
      syntheticSection?: { sectionId: string; title: string }
      tables: ProjectKnowledgeTable[]
    }>()
    for (const table of [...documentTables].sort((a, b) => tableOrdinal(a) - tableOrdinal(b))) {
      const tableSnippetOrdinal = findTableCaptionSnippetOrdinal(table, documentSnippets)
      const nearestHeading = [...headings]
        .filter((candidate) => snippetOrdinal(candidate.snippet) <= tableSnippetOrdinal)
        .at(-1)
      const syntheticSection = tableSectionHeadingOf(table) ?? undefined
      const heading = nearestHeading && (
        !syntheticSection || nearestHeading.sectionId === syntheticSection.sectionId
      )
        ? nearestHeading
        : undefined
      const groupKey = heading?.sectionId ?? syntheticSection?.sectionId ?? `${documentId}-unsectioned`
      const group = groupedTables.get(groupKey) ?? { heading, syntheticSection, tables: [] }
      group.tables.push(table)
      groupedTables.set(groupKey, group)
    }

    const groupEntries = Array.from(groupedTables.entries()).sort(([, left], [, right]) => {
      const leftFirstTable = left.tables.sort((a, b) => tableOrdinal(a) - tableOrdinal(b))[0]
      const rightFirstTable = right.tables.sort((a, b) => tableOrdinal(a) - tableOrdinal(b))[0]
      return findTableCaptionSnippetOrdinal(leftFirstTable, documentSnippets) - findTableCaptionSnippetOrdinal(rightFirstTable, documentSnippets)
    })

    const pushModel = (
      groupKey: string,
      group: {
        heading?: { sectionId: string; title: string; snippet: ProjectKnowledgeSnippet }
        syntheticSection?: { sectionId: string; title: string }
        tables: ProjectKnowledgeTable[]
      },
      modelTables: ProjectKnowledgeTable[],
      modelSnippets: ProjectKnowledgeSnippet[],
      inputFlowSnippetIds: string[],
      outputFlowSnippetIds: string[],
      titleSuffix?: string,
      referencedPrimaryTableIds: string[] = [],
    ): void => {
      const orderedTables = [...new Map(modelTables.map((table) => [table.id, table])).values()]
        .sort((a, b) => tableOrdinal(a) - tableOrdinal(b))
      const primaryTables = orderedTables.filter(isFrameFormatTable)
      if (primaryTables.length === 0) return

      const supportTables = orderedTables.filter((table) => !isFrameFormatTable(table))
      const referenceBackedIds = new Set(referencedPrimaryTableIds)
      const referenceDirection = inputFlowSnippetIds.length ? "input" as const
        : outputFlowSnippetIds.length ? "output" as const
          : "unknown" as const
      const referencePreferredName = referenceDirection === "input" || referenceDirection === "output"
        ? extractRobustFlowPreferredName(modelSnippets, referenceDirection)
        : undefined
      const firstModelOrdinal = Math.min(...modelSnippets.map(snippetOrdinal))
      const nearbyInterfaceHeading = referenceBackedIds.size
        ? [...documentSnippets]
            .filter((snippet) => (
              snippetOrdinal(snippet) <= firstModelOrdinal &&
              /(?:总线)?接口(?:及)?相关数据流|总线接口/.test(snippet.text) &&
              !/^IF-/i.test(snippet.text.trim())
            ))
            .map((snippet) => sectionHeadingOf(snippet)?.title ?? snippet.text.trim())
            .at(-1)
        : undefined
      const referenceSectionId = group.heading?.sectionId ?? group.syntheticSection?.sectionId
      const referenceSourceSection = nearbyInterfaceHeading
        ? [referenceSectionId, nearbyInterfaceHeading].filter(Boolean).join(" ")
        : group.heading
        ? `${group.heading.sectionId} ${group.heading.title}`.trim()
        : group.syntheticSection
          ? `${group.syntheticSection.sectionId} ${group.syntheticSection.title}`.trim()
          : sourceSectionTitle(modelSnippets)
      const protocolRelations = analyzeSectionProtocolRelations(modelSnippets, orderedTables, primaryTables)
        .map((relation) => referenceBackedIds.has(relation.frame_table_id)
          ? {
              ...relation,
              preferred_name: referencePreferredName ?? relation.preferred_name,
              flow_direction: referenceDirection,
              source_section: referenceSourceSection ?? relation.source_section,
              source_flow_heading: flowHeadingName(referenceDirection),
              confidence: Math.max(relation.confidence, 0.9),
              reasoning: uniqueStrings([
                ...relation.reasoning,
                "The frame layout is supplied by an explicit resolved document reference; protocol ownership remains with the referring flow.",
              ]),
            }
          : relation)
      const protocols = buildProtocolsFromRelations(orderedTables, primaryTables, protocolRelations, candidates)
      const sectionId = group.heading?.sectionId ?? group.syntheticSection?.sectionId
      const baseTitle = nearbyInterfaceHeading
        ? [sectionId, nearbyInterfaceHeading].filter(Boolean).join(" ")
        : group.heading
        ? `${group.heading.sectionId} ${group.heading.title}`
        : group.syntheticSection
          ? `${group.syntheticSection.sectionId} ${group.syntheticSection.title}`.trim()
          : groupKey
      const sectionPath = sectionId
        ? headings
            .filter((heading) => sectionId === heading.sectionId || sectionId.startsWith(`${heading.sectionId}.`))
            .sort((left, right) => left.sectionId.split(".").length - right.sectionId.split(".").length)
            .map((heading) => `${heading.sectionId} ${heading.title}`.trim())
        : [baseTitle]
      const chapterRole = sectionPath.some((item) => /数据及接口需求/.test(item))
        ? "interface_requirement" as const
        : "other" as const
      const contentRole = /(?:接口)?需求项?(?:总结|汇总)|需求汇总表/.test(baseTitle)
        ? "requirement_summary" as const
        : "frame_definition" as const

      models.push({
        id: `section-protocol-${models.length + 1}`,
        source_document_id: documentId,
        section_id: sectionId,
        section_title: [baseTitle, titleSuffix].filter(Boolean).join(" "),
        section_path: sectionPath,
        chapter_role: chapterRole,
        content_role: contentRole,
        section_snippet_ids: modelSnippets.map((snippet) => snippet.id),
        input_flow_snippet_ids: inputFlowSnippetIds,
        output_flow_snippet_ids: outputFlowSnippetIds,
        table_ids: orderedTables.map((table) => table.id),
        primary_table_ids: primaryTables.map((table) => table.id),
        support_table_ids: supportTables.map((table) => table.id),
        reference_backed: referenceBackedIds.size > 0 || undefined,
        referenced_primary_table_ids: referenceBackedIds.size ? [...referenceBackedIds] : undefined,
        protocol_relations: protocolRelations,
        protocols,
        checksum_rule: DEFAULT_CHECKSUM_RULE,
        confidence: protocols.length ? 0.85 : 0.5,
        warnings: [],
      })
    }

    for (const [groupIndex, [groupKey, group]] of groupEntries.entries()) {
      const orderedTables = group.tables.sort((a, b) => tableOrdinal(a) - tableOrdinal(b))
      const firstTableOrdinal = findTableCaptionSnippetOrdinal(orderedTables[0], documentSnippets)
      const nextGroup = groupEntries[groupIndex + 1]?.[1]
      const nextGroupStart = nextGroup
        ? findTableCaptionSnippetOrdinal(nextGroup.tables.sort((a, b) => tableOrdinal(a) - tableOrdinal(b))[0], documentSnippets)
        : Number.MAX_SAFE_INTEGER
      const previousFlowMarkerOrdinal = [...documentSnippets]
        .filter((snippet) => snippetOrdinal(snippet) < firstTableOrdinal && flowDirectionOfSnippet(snippet))
        .map(snippetOrdinal)
        .at(-1)
      const sectionStart = group.heading
        ? snippetOrdinal(group.heading.snippet)
        : previousFlowMarkerOrdinal && firstTableOrdinal - previousFlowMarkerOrdinal <= 8
          ? previousFlowMarkerOrdinal
          : firstTableOrdinal
      const sectionEnd = group.heading
        ? (headings
            .map((heading) => snippetOrdinal(heading.snippet))
            .filter((ordinal) => ordinal > sectionStart)
            .sort((a, b) => a - b)[0] ?? Number.MAX_SAFE_INTEGER)
        : nextGroupStart
      const sectionSnippets = documentSnippets.filter((snippet) => {
        const ordinal = snippetOrdinal(snippet)
        return ordinal >= sectionStart && ordinal < sectionEnd
      })
      const flowWindows = buildSectionFlowWindows(sectionSnippets)

      if (flowWindows.length > 1) {
        for (const window of flowWindows) {
          const windowTables = orderedTables.filter((table) => tableBelongsToFlow(table, window.snippetIds, sectionSnippets))
          const localWindowTableIds = new Set(windowTables.map((table) => table.id))
          const referencedFrameTables = resolvedFrameLayoutTablesForSnippets(
            window.snippetIds,
            references,
            allTablesById,
          ).filter((table) => !localWindowTableIds.has(table.id))
          pushModel(
            groupKey,
            group,
            [...windowTables, ...referencedFrameTables],
            sectionSnippets.filter((snippet) => window.snippetIds.includes(snippet.id)),
            window.direction === "input" ? window.snippetIds : [],
            window.direction === "output" ? window.snippetIds : [],
            window.headingText,
            referencedFrameTables.map((table) => table.id),
          )
        }
        continue
      }

      const localSectionTableIds = new Set(orderedTables.map((table) => table.id))
      const referencedFrameTables = resolvedFrameLayoutTablesForSnippets(
        sectionSnippets.map((snippet) => snippet.id),
        references,
        allTablesById,
      ).filter((table) => !localSectionTableIds.has(table.id))
      pushModel(
        groupKey,
        group,
        [...orderedTables, ...referencedFrameTables],
        sectionSnippets,
        findRobustSectionFlowSnippetIds(sectionSnippets, "input"),
        findRobustSectionFlowSnippetIds(sectionSnippets, "output"),
        undefined,
        referencedFrameTables.map((table) => table.id),
      )
    }

    // A referring flow may contain no local table at all (for example,
    // "input flow: secondary-node upload, see table 3.x"). Such a flow never
    // enters groupedTables, so materialize it directly from the resolved edge.
    const frameReferences = references.filter((reference) => (
      reference.source_document_id === documentId &&
      Boolean(reference.source_snippet_id) &&
      (reference.state === "resolved" || reference.state === "fallback_resolved") &&
      reference.semantic_roles?.includes("frame_layout")
    ))
    for (const reference of frameReferences) {
      const sourceSnippet = documentSnippets.find((snippet) => snippet.id === reference.source_snippet_id)
      if (!sourceSnippet) continue
      const referencedTables = uniqueStrings(
        reference.resolved_table_ids ?? (reference.resolved_table_id ? [reference.resolved_table_id] : []),
      )
        .map((tableId) => allTablesById.get(tableId))
        .filter((table): table is ProjectKnowledgeTable => Boolean(table && isFrameFormatTable(table)))
      if (!referencedTables.length) continue
      const resolvedByLocalModel = models.some((model) => (
        model.source_document_id === documentId &&
        model.section_snippet_ids.includes(sourceSnippet.id) &&
        referencedTables.every((table) => model.primary_table_ids.includes(table.id))
      ))
      if (resolvedByLocalModel) continue
      const alreadyMaterialized = models.some((model) => (
        model.source_document_id === documentId &&
        model.reference_backed &&
        model.section_snippet_ids.includes(sourceSnippet.id) &&
        referencedTables.every((table) => model.referenced_primary_table_ids?.includes(table.id))
      ))
      if (alreadyMaterialized) continue

      const sourceOrdinal = snippetOrdinal(sourceSnippet)
      const nearestHeading = [...headings]
        .filter((candidate) => snippetOrdinal(candidate.snippet) <= sourceOrdinal)
        .at(-1)
      const heading = nearestHeading
        ? headings.find((candidate) => (
            candidate.sectionId === nearestHeading.sectionId &&
            snippetOrdinal(candidate.snippet) <= sourceOrdinal &&
            /(?:接口|相关数据流)/.test(candidate.title)
          )) ?? nearestHeading
        : undefined
      const sectionEnd = headings
        .map((candidate) => snippetOrdinal(candidate.snippet))
        .filter((ordinal) => ordinal > sourceOrdinal)
        .sort((left, right) => left - right)[0] ?? Number.MAX_SAFE_INTEGER
      const sectionStart = heading ? snippetOrdinal(heading.snippet) : sourceOrdinal
      const sectionSnippets = documentSnippets.filter((snippet) => {
        const ordinal = snippetOrdinal(snippet)
        return ordinal >= sectionStart && ordinal < sectionEnd
      })
      const sourceWindow = buildSectionFlowWindows(sectionSnippets)
        .find((window) => window.snippetIds.includes(sourceSnippet.id))
      const modelSnippets = sourceWindow
        ? sectionSnippets.filter((snippet) => sourceWindow.snippetIds.includes(snippet.id))
        : sectionSnippets
      const direction = sourceWindow?.direction ?? flowDirectionOfSnippet(sourceSnippet) ?? "input"
      pushModel(
        `reference:${reference.reference_id ?? sourceSnippet.id}`,
        {
          heading,
          syntheticSection: heading ? undefined : { sectionId: sourceSnippet.id, title: sourceSnippet.text },
          tables: [],
        },
        referencedTables,
        modelSnippets,
        direction === "input" ? modelSnippets.map((snippet) => snippet.id) : [],
        direction === "output" ? modelSnippets.map((snippet) => snippet.id) : [],
        sourceWindow?.headingText ?? sourceSnippet.text,
        referencedTables.map((table) => table.id),
      )
    }
  }

  return models
}

function inferRelatedDataValues(table: ProjectKnowledgeTable, tables: ProjectKnowledgeTable[]): Map<string, string> {
  const values = isFrameFormatTable(table) ? new Map<string, string>() : extractDataValuesFromTable(table)
  if (values.size) return values

  for (const candidate of findRelatedSupportTables(table, tables)) {
    for (const [name, value] of extractDataValuesFromTable(candidate)) {
      if (!values.has(name)) values.set(name, value)
    }
  }

  return values
}

function buildFrameLinesWithDataValues(table: ProjectKnowledgeTable, dataValues: Map<string, string>): string[][] {
  if (!isFrameFormatTable(table)) return []

  const frameLines: string[][] = []
  const checksumBytes: string[] = []
  let checksumActive = false

  for (const row of table.rows) {
    if (!/^\s*\d+[.。]\s*$/.test(row[0] ?? "")) continue

    const bytes: string[] = []
    let includeGenericData = false

    for (const cell of row.slice(1)) {
      const parsed = parseFrameCell(cell, dataValues)
      if (!parsed) continue

      if (parsed.kind === "sum") {
        bytes.push(computeByteSum(checksumBytes))
        checksumBytes.length = 0
        checksumActive = false
        includeGenericData = false
        continue
      }

      bytes.push(parsed.value)

      if (parsed.checksumRole === "title") {
        checksumBytes.length = 0
        checksumActive = true
        includeGenericData = true
        checksumBytes.push(parsed.value)
      } else if (parsed.checksumRole === "data") {
        if (checksumActive) checksumBytes.push(parsed.value)
      } else if (parsed.checksumRole === "length") {
        includeGenericData = false
      } else {
        if (checksumActive && includeGenericData) checksumBytes.push(parsed.value)
      }
    }

    if (bytes.length >= 2) frameLines.push(bytes)
  }

  return frameLines
}

function extractFrameLinesFromTable(table: ProjectKnowledgeTable, tables: ProjectKnowledgeTable[]): string[][] {
  return buildFrameLinesWithDataValues(table, inferRelatedDataValues(table, tables))
}

function findSectionFlowSnippetIds(sectionSnippets: ProjectKnowledgeSnippet[], marker: "input" | "output"): string[] {
  const markerPattern = marker === "input" ? /^输入流[:：]/ : /^输出流[:：]/
  const markerIndex = sectionSnippets.findIndex((snippet) => markerPattern.test(snippet.text.trim()))
  if (markerIndex < 0) return []

  const stopPattern = marker === "input" ? /^输出流[:：]/ : /^输入流[:：]/
  const stopIndex = sectionSnippets
    .slice(markerIndex + 1)
    .findIndex((snippet) => stopPattern.test(snippet.text.trim()) || sectionHeadingOf(snippet))
  const end = stopIndex < 0 ? sectionSnippets.length : markerIndex + 1 + stopIndex
  return sectionSnippets.slice(markerIndex, end).map((snippet) => snippet.id)
}

function extractFlowPreferredName(sectionSnippets: ProjectKnowledgeSnippet[], marker: "input" | "output"): string | undefined {
  const markerPrefix = marker === "input" ? "输入流" : "输出流"
  const flowSnippet = sectionSnippets.find((snippet) => snippet.text.trim().startsWith(markerPrefix))
  const match = flowSnippet?.text.match(/^[^:：]+[:：]\s*([^，,。.；;]+)/)
  return sanitizeReadableFileBaseName(match?.[1])
}

function tableBelongsToFlow(table: ProjectKnowledgeTable, flowSnippetIds: string[], snippets: ProjectKnowledgeSnippet[]): boolean {
  if (!flowSnippetIds.length) return false

  const flowOrdinals = flowSnippetIds
    .map((id) => snippets.find((snippet) => snippet.id === id))
    .filter((snippet): snippet is ProjectKnowledgeSnippet => Boolean(snippet))
    .map(snippetOrdinal)
  if (!flowOrdinals.length) return false

  const tableOrdinalValue = findTableCaptionSnippetOrdinal(table, snippets)
  return tableOrdinalValue >= Math.min(...flowOrdinals) && tableOrdinalValue <= Math.max(...flowOrdinals)
}

function robustFlowMarkerPattern(marker: "input" | "output"): RegExp {
  return marker === "input"
    ? /^(?:\u8f93\u5165\u6d41|\u8f93\u5165|杈撳叆娴乕?)(?:\s*\d+)?\s*[:\uff1a]/
    : /^(?:\u8f93\u51fa\u6d41|\u8f93\u51fa|杈撳嚭娴乕?)(?:\s*\d+)?\s*[:\uff1a]/
}

type SectionFlowWindow = {
  direction: "input" | "output"
  snippetIds: string[]
  headingText: string
}

function flowDirectionOfSnippet(snippet: ProjectKnowledgeSnippet): "input" | "output" | null {
  const text = snippet.text.trim()
  if (robustFlowMarkerPattern("input").test(text)) return "input"
  if (robustFlowMarkerPattern("output").test(text)) return "output"
  return null
}

function buildSectionFlowWindows(sectionSnippets: ProjectKnowledgeSnippet[]): SectionFlowWindow[] {
  const markers = sectionSnippets
    .map((snippet, index) => {
      const direction = flowDirectionOfSnippet(snippet)
      return direction ? { direction, snippet, index } : null
    })
    .filter((item): item is { direction: "input" | "output"; snippet: ProjectKnowledgeSnippet; index: number } => Boolean(item))

  return markers.map((marker, index) => {
    const nextMarker = markers[index + 1]
    const endIndex = nextMarker ? nextMarker.index : sectionSnippets.length
    return {
      direction: marker.direction,
      snippetIds: sectionSnippets.slice(marker.index, endIndex).map((snippet) => snippet.id),
      headingText: marker.snippet.text,
    }
  })
}

function findRobustSectionFlowSnippetIds(sectionSnippets: ProjectKnowledgeSnippet[], marker: "input" | "output"): string[] {
  const markerPattern = robustFlowMarkerPattern(marker)
  const markerIndex = sectionSnippets.findIndex((snippet) => markerPattern.test(snippet.text.trim()))
  if (markerIndex < 0) return findSectionFlowSnippetIds(sectionSnippets, marker)

  const stopPattern = robustFlowMarkerPattern(marker === "input" ? "output" : "input")
  const stopIndex = sectionSnippets
    .slice(markerIndex + 1)
    .findIndex((snippet) => stopPattern.test(snippet.text.trim()) || sectionHeadingOf(snippet))
  const end = stopIndex < 0 ? sectionSnippets.length : markerIndex + 1 + stopIndex
  return sectionSnippets.slice(markerIndex, end).map((snippet) => snippet.id)
}

function extractRobustFlowPreferredName(sectionSnippets: ProjectKnowledgeSnippet[], marker: "input" | "output"): string | undefined {
  const flowSnippet = sectionSnippets.find((snippet) => robustFlowMarkerPattern(marker).test(snippet.text.trim()))
  const match = flowSnippet?.text.trim().match(/^[^:\uff1a]+[:\uff1a]\s*([^,\uff0c\u3002;\uff1b]+)/)
  return sanitizeReadableFileBaseName(match?.[1]) || extractFlowPreferredName(sectionSnippets, marker)
}

function flowDirectionForTable(
  table: ProjectKnowledgeTable,
  sectionSnippets: ProjectKnowledgeSnippet[],
  inputFlowSnippetIds: string[],
  outputFlowSnippetIds: string[],
): FlowDirection {
  if (tableBelongsToFlow(table, inputFlowSnippetIds, sectionSnippets)) return "input"
  if (tableBelongsToFlow(table, outputFlowSnippetIds, sectionSnippets)) return "output"
  return "unknown"
}

function sourceSectionTitle(sectionSnippets: ProjectKnowledgeSnippet[]): string | undefined {
  const heading = sectionSnippets
    .map(sectionHeadingOf)
    .find((item): item is { sectionId: string; title: string } => Boolean(item))
  return heading ? `${heading.sectionId} ${heading.title}` : undefined
}

function pickFramePreferredName(
  table: ProjectKnowledgeTable,
  sectionSnippets: ProjectKnowledgeSnippet[],
  inputFlowSnippetIds: string[],
  outputFlowSnippetIds: string[],
): string | undefined {
  if (tableBelongsToFlow(table, inputFlowSnippetIds, sectionSnippets)) {
    return extractRobustFlowPreferredName(sectionSnippets, "input")
  }
  if (tableBelongsToFlow(table, outputFlowSnippetIds, sectionSnippets)) {
    return extractRobustFlowPreferredName(sectionSnippets, "output")
  }
  return undefined
}

function getTableHeader(table: ProjectKnowledgeTable): string[] {
  return table.rows[0] ?? []
}

function alignDictionaryRowToHeader(row: string[], header: string[]): string[] {
  const firstHeader = normalizeLookupText(header[0])
  if (
    row.length === header.length - 1 &&
    /^(?:\u5e8f\u53f7|no|index)$/i.test(firstHeader)
  ) {
    return ["", ...row]
  }
  return row
}

function bestDictionaryHeaderIndex(headers: string[], scoreHeader: (header: string) => number): number {
  let bestIndex = -1
  let bestScore = 0
  headers.forEach((header, index) => {
    const score = scoreHeader(header)
    if (score > bestScore) {
      bestIndex = index
      bestScore = score
    }
  })
  return bestIndex
}

function findDictionaryColumns(table: ProjectKnowledgeTable): {
  nameIndex: number
  typeIndex: number
  codeIndex: number
  nameHeader?: string
  codeHeader?: string
} | null {
  const headers = getTableHeader(table).map((header) => normalizeLookupText(header))
  let nameIndex = bestDictionaryHeaderIndex(headers, (header) => {
    let score = 0
    if (/指令名称|参数名称|名称|项目|command.*name|name/i.test(header)) score += 4
    if (/指令码字|指令码|码字|编码|code|数据/.test(header)) score -= 5
    return score
  })
  const typeIndex = headerIndex(headers, [/指令类型/, /类型/, /command.*type/i, /type/i])
  let codeIndex = bestDictionaryHeaderIndex(headers, (header) => {
    let score = 0
    if (/指令码字|指令码|码字|编码|W0.*W1.*W2.*W3|code/i.test(header)) score += 5
    if (/数据/.test(header)) score += 2
    if (/指令名称|参数名称|名称|项目|name/i.test(header)) score -= 4
    return score
  })

  if (nameIndex < 0) nameIndex = headerIndex(headers, [/指令名称/, /名称/, /项目/, /参数名称/, /command.*name/i, /name/i])
  if (codeIndex < 0) codeIndex = headerIndex(headers, [/指令码字/, /指令码/, /码字/, /编码/, /W0.*W1.*W2.*W3/i, /code/i])
  if (nameIndex === codeIndex) {
    codeIndex = headers.findIndex((header, index) => index !== nameIndex && /指令码字|指令码|码字|编码|W0.*W1.*W2.*W3|code/i.test(header))
  }
  if (nameIndex < 0 || codeIndex < 0) return null
  return {
    nameIndex,
    typeIndex,
    codeIndex,
    nameHeader: table.rows[0]?.[nameIndex],
    codeHeader: table.rows[0]?.[codeIndex],
  }
}

function isDictionaryRowGenerationTable(table: ProjectKnowledgeTable): boolean {
  const columns = findDictionaryColumns(table)
  if (!columns) return false

  const header = getTableHeader(table)
  return table.rows.slice(1).some((row) => {
    const alignedRow = alignDictionaryRowToHeader(row, header)
    const name = alignedRow[columns.nameIndex]?.trim()
    const code = alignedRow[columns.codeIndex]
    return Boolean(name && code && extractCommandCodeBytes(code).length >= 4)
  })
}

function tableBelongsToInputFlow(table: ProjectKnowledgeTable, inputFlowSnippetIds: string[], snippets: ProjectKnowledgeSnippet[]): boolean {
  return !inputFlowSnippetIds.length || tableBelongsToFlow(table, inputFlowSnippetIds, snippets)
}

function extractCommandCodeBytes(value: string): string[] {
  const compact = value.replace(/\s+/g, "")
  const fullCode = compact.match(/(?:0x)?([0-9a-fA-F]{8})H?/i)?.[1]
  if (fullCode) return fullCode.toUpperCase().match(/[0-9A-F]{2}/g) ?? []

  return extractHexBytes(value).slice(0, 4)
}

type DictionaryRowData = {
  commandName: string
  commandType: string | undefined
  commandBytes: string[]
}

function commandDictionaryFieldIndex(header: string): number | undefined {
  const match = header.match(/(?:^|[^A-Z0-9])W\s*(\d+)(?:$|[^0-9])/i)
  if (!match?.[1]) return undefined
  const index = Number.parseInt(match[1], 10)
  return Number.isFinite(index) && index >= 0 && index <= 255 ? index : undefined
}

function isCommandDictionaryPlaceholder(value: string | undefined): boolean {
  const normalized = value?.replace(/[—–－]/g, "-").replace(/\s+/g, "").trim() ?? ""
  return !normalized || /^(?:-+|无|不适用|N\/?A)$/i.test(normalized)
}

function commandDictionaryBitfieldDefaultByte(value: string): string | undefined {
  const markers = Array.from(value.matchAll(/D\s*([0-7])\s*[:：]/ig))
  if (!markers.length) return undefined
  const choices = markers.flatMap((marker, index) => {
    const bitText = marker[1]
    if (!bitText || marker.index === undefined) return []
    const descriptionStart = marker.index + marker[0].length
    const descriptionEnd = markers[index + 1]?.index ?? value.length
    const description = value.slice(descriptionStart, descriptionEnd)
    if (/(?:预留|保留|未使用|unused|reserved)/i.test(description)) return []
    return [{ bit: Number.parseInt(bitText, 10), description }]
  })
  if (!choices.length) return undefined
  const documentedDefault = choices.find((choice) => /默认/.test(choice.description))
  const selected = documentedDefault ?? choices.sort((left, right) => left.bit - right.bit)[0]
  return (1 << selected.bit).toString(16).toUpperCase().padStart(2, "0")
}

function commandDictionaryReservedBitByte(value: string | undefined): string | undefined {
  if (!value) return undefined
  const markers = Array.from(value.matchAll(/D\s*([0-7])\s*[:：]/ig))
  for (const [index, marker] of markers.entries()) {
    const bitText = marker[1]
    if (!bitText || marker.index === undefined) continue
    const descriptionStart = marker.index + marker[0].length
    const descriptionEnd = markers[index + 1]?.index ?? value.length
    if (!/(?:预留|保留|未使用|unused|reserved)/i.test(value.slice(descriptionStart, descriptionEnd))) continue
    return (1 << Number.parseInt(bitText, 10)).toString(16).toUpperCase().padStart(2, "0")
  }
  return undefined
}

function commandDictionaryDefaultByte(value: string | undefined): string | undefined {
  const text = value?.replace(/[—–－]/g, "-").trim() ?? ""
  if (isCommandDictionaryPlaceholder(text)) return undefined
  const exact = normalizeHexByte(text)
  if (exact) return exact
  const bitfieldDefault = commandDictionaryBitfieldDefaultByte(value ?? "")
  if (bitfieldDefault) return bitfieldDefault
  const optionPattern = /(?:^|[^0-9A-F])(?:0x)?([0-9A-F]{1,2})(H)?\s*(?:[:：]|(?:-|~|～|至))/ig
  for (const option of text.matchAll(optionPattern)) {
    const token = option[1]
    if (!token) continue
    // D7/D6/... without an H suffix names a bit; it is not a byte value.
    if (!option[2] && /^D[0-7]$/i.test(token)) continue
    return token.toUpperCase().padStart(2, "0")
  }
  const leadingRange = text.match(/(?:^|[^0-9A-F])([0-9A-F]{2,4})H?\s*(?:-|~|～|至)/i)?.[1]
  if (leadingRange) return leadingRange.slice(0, 2).toUpperCase().padStart(2, "0")
  const embedded = text.match(/(?:^|[^0-9A-F])([0-9A-F]{1,2})H\b/i)?.[1]
  return embedded?.toUpperCase().padStart(2, "0")
}

function commandDictionaryTableColumns(table: ProjectKnowledgeTable): {
  commandCodeIndex: number
  commandNameIndex: number
  fieldColumns: Array<{ index: number; fieldIndex: number }>
} | null {
  const header = getTableHeader(table)
  if (!header.length) return null
  const normalized = header.map((cell) => normalizeLookupText(cell))
  const commandCodeIndex = normalized.findIndex((cell) => /(?:指令|命令)(?:代号|编号|标识)|command(?:code|id)/i.test(cell))
  const commandNameIndex = normalized.findIndex((cell) => /(?:指令|命令)(?:名称|名)|commandname/i.test(cell))
  const fieldColumns = header.flatMap((cell, index) => {
    const fieldIndex = commandDictionaryFieldIndex(cell)
    return fieldIndex === undefined ? [] : [{ index, fieldIndex }]
  })
  return commandCodeIndex >= 0 && commandNameIndex >= 0 && fieldColumns.length
    ? { commandCodeIndex, commandNameIndex, fieldColumns }
    : null
}

function commandDictionaryBusScope(table: ProjectKnowledgeTable): Pick<BusCommandDictionaryEntry, "bus_type" | "interface_level"> {
  const text = [table.caption, ...getTableHeader(table)].filter(Boolean).join(" ")
  if (/一级\s*CAN/i.test(text)) return { bus_type: "CAN", interface_level: "primary" }
  if (/二级\s*CAN/i.test(text)) return { bus_type: "CAN", interface_level: "secondary" }
  if (/\bCAN\b/i.test(text)) return { bus_type: "CAN" }
  if (/\bSPI\b/i.test(text)) return { bus_type: "SPI" }
  if (/Space\s*Wire/i.test(text)) return { bus_type: "SpaceWire" }
  return {}
}

export function buildCommandDictionaryIndex(knowledgeIndex: ProjectKnowledgeIndex): CommandDictionaryIndex {
  const entries: BusCommandDictionaryEntry[] = []
  const warnings: string[] = []
  for (const table of knowledgeIndex.tables) {
    const columns = commandDictionaryTableColumns(table)
    const header = getTableHeader(table)
    if (!columns || !header.length) continue
    const scope = commandDictionaryBusScope(table)
    for (const row of table.rows.slice(1)) {
      const aligned = alignDictionaryRowToHeader(row, header)
      const commandCode = aligned[columns.commandCodeIndex]?.trim().toUpperCase()
      const commandName = aligned[columns.commandNameIndex]?.trim()
      if (!commandCode || !commandName || !/^[A-Z]{2,}\d+[A-Z0-9-]*$/i.test(commandCode)) continue
      const rowWarnings: string[] = []
      const fieldOverrides = columns.fieldColumns.flatMap(({ index, fieldIndex }) => {
        const rawValue = aligned[index]
        const value = commandDictionaryDefaultByte(rawValue)
        if (!value) {
          const normalizedRawValue = rawValue?.trim() ?? ""
          if (!isCommandDictionaryPlaceholder(normalizedRawValue)) {
            rowWarnings.push(`Command field W${fieldIndex} has documented non-literal values and requires semantic selection: ${normalizedRawValue}`)
          }
          return []
        }
        if (rawValue && !normalizeHexByte(rawValue.trim())) {
          rowWarnings.push(`W${fieldIndex} used the first documented legal value ${value} as its default.`)
        }
        return [{
          field_name: `W${fieldIndex}`,
          value,
          value_source: "dictionary-row" as const,
          source_table_id: table.id,
          source_text: rawValue,
          confidence: 0.95,
          reasoning: [`W${fieldIndex} is resolved from command ${commandCode} (${commandName}).`],
        }]
      })
      if (!fieldOverrides.length) continue
      const maxFieldIndex = Math.max(...fieldOverrides.map((item) => Number.parseInt(item.field_name.slice(1), 10)))
      const payloadLengthBytes = maxFieldIndex >= 9 ? maxFieldIndex + 1 : undefined
      const scopedWarnings = payloadLengthBytes
        ? rowWarnings.filter((warning) => {
            const fieldIndex = Number.parseInt(warning.match(/^Command field W(\d+)/i)?.[1] ?? "", 10)
            return !Number.isFinite(fieldIndex) || fieldIndex < payloadLengthBytes
          })
        : rowWarnings
      entries.push({
        id: `${table.id}:${commandCode}`,
        command_code: commandCode,
        command_name: commandName,
        ...scope,
        ...(payloadLengthBytes ? { payload_length_bytes: payloadLengthBytes } : {}),
        field_overrides: fieldOverrides,
        source_document_id: table.source_document_id,
        source_table_id: table.id,
        source_table_caption: table.caption,
        warnings: uniqueStrings(scopedWarnings),
      })
    }
  }
  const deduplicated = new Map<string, BusCommandDictionaryEntry>()
  for (const entry of entries) {
    const key = `${entry.command_code}:${entry.bus_type ?? "unknown"}:${entry.interface_level ?? "unknown"}`
    if (!deduplicated.has(key)) deduplicated.set(key, entry)
    else warnings.push(`Duplicate command dictionary entry ignored: ${entry.command_code} from ${entry.source_table_id}.`)
  }
  return {
    schema_version: "1.0.0",
    source_documents: knowledgeIndex.source_documents.map((document) => document.path),
    entries: [...deduplicated.values()],
    warnings: uniqueStrings(warnings),
    updated_at: new Date().toISOString(),
  }
}

export function writeCommandDictionaryIndex(outputFile: string, index: CommandDictionaryIndex): void {
  ensureDirectory(dirname(outputFile))
  writeFileSync(outputFile, `${JSON.stringify(index, null, 2)}\n`, "utf-8")
}

function extractDictionaryRows(table: ProjectKnowledgeTable): DictionaryRowData[] {
  const [headerRow, ...dataRows] = table.rows
  if (!headerRow) return []

  const columns = findDictionaryColumns(table)
  if (!columns) return []

  return dataRows
    .map((row) => {
      const alignedRow = alignDictionaryRowToHeader(row, headerRow)
      const commandName = alignedRow[columns.nameIndex]?.trim()
      const codeCell = alignedRow[columns.codeIndex]
      if (!commandName || !codeCell) return null

      const commandBytes = extractCommandCodeBytes(codeCell)
      if (commandBytes.length < 4) return null

      return {
        commandName,
        commandType: columns.typeIndex >= 0 ? alignedRow[columns.typeIndex]?.trim() : undefined,
        commandBytes: commandBytes.slice(0, 4),
      }
    })
    .filter((item): item is DictionaryRowData => Boolean(item))
}

function analyzeSectionProtocolRelations(
  sectionSnippets: ProjectKnowledgeSnippet[],
  tables: ProjectKnowledgeTable[],
  primaryTables: ProjectKnowledgeTable[],
): SectionProtocolRelation[] {
  const inputFlowSnippetIds = findRobustSectionFlowSnippetIds(sectionSnippets, "input")
  const outputFlowSnippetIds = findRobustSectionFlowSnippetIds(sectionSnippets, "output")
  const relations: SectionProtocolRelation[] = []
  const sectionTitle = sourceSectionTitle(sectionSnippets)

  for (const frameTable of primaryTables) {
    const flowDirection = flowDirectionForTable(frameTable, sectionSnippets, inputFlowSnippetIds, outputFlowSnippetIds)
    const start = tables.findIndex((table) => table.id === frameTable.id)
    const nextFrame = primaryTables.find((candidate) => tableOrdinal(candidate) > tableOrdinal(frameTable))
    const end = nextFrame ? tables.findIndex((table) => table.id === nextFrame.id) : tables.length
    const relatedTables = tables.slice(start + 1, end).filter((table) => !isFrameFormatTable(table))
    const dictionaryTable = relatedTables.find((table) =>
      (flowDirection === "input" || tableBelongsToInputFlow(table, inputFlowSnippetIds, sectionSnippets)) &&
      isDictionaryRowGenerationTable(table),
    )

    if (dictionaryTable) {
      const columns = findDictionaryColumns(dictionaryTable)
      relations.push({
        frame_table_id: frameTable.id,
        dictionary_table_id: dictionaryTable.id,
        generation_mode: "one_file_per_dictionary_row",
        preferred_name: pickFramePreferredName(frameTable, sectionSnippets, inputFlowSnippetIds, outputFlowSnippetIds),
        flow_direction: flowDirection,
        source_section: sectionTitle,
        source_flow_heading: flowHeadingName(flowDirection),
        file_name_field: columns?.nameHeader,
        data_code_field: columns?.codeHeader,
        should_generate_frame_table_file: false,
        checksum_rule: DEFAULT_CHECKSUM_RULE,
        confidence: inputFlowSnippetIds.length ? 0.88 : 0.78,
        reasoning: [
          "A frame-format table is followed by a dictionary table with a name column and W/code column.",
          "The dictionary rows contain 4-byte code words, so each row represents one concrete data file.",
          inputFlowSnippetIds.length
            ? "The relation was found inside the section input-flow segment."
            : "No explicit input-flow marker was found; relation falls back to table ordering.",
        ],
      })
      continue
    }

    relations.push({
      frame_table_id: frameTable.id,
      generation_mode: "frame_file",
      preferred_name: pickFramePreferredName(frameTable, sectionSnippets, inputFlowSnippetIds, outputFlowSnippetIds),
      flow_direction: flowDirection,
      source_section: sectionTitle,
      source_flow_heading: flowHeadingName(flowDirection),
      should_generate_frame_table_file: true,
      checksum_rule: DEFAULT_CHECKSUM_RULE,
      confidence: 0.72,
      reasoning: [
        "No row dictionary table with file-name and code-word columns was found before the next frame table.",
        "The frame-format table is generated as a standalone data file.",
      ],
    })
  }

  return relations
}

function buildSectionProtocolRelationModelInput(
  index: ProjectKnowledgeIndex,
  model: SectionProtocolModel,
): SectionProtocolRelationModelInput {
  const snippetsById = new Map(index.snippets.map((snippet) => [snippet.id, snippet]))
  const tablesById = new Map(index.tables.map((table) => [table.id, table]))
  const sectionSnippets = model.section_snippet_ids
    .map((id) => snippetsById.get(id))
    .filter((snippet): snippet is ProjectKnowledgeSnippet => Boolean(snippet))
    .sort((a, b) => snippetOrdinal(a) - snippetOrdinal(b))
  const inputFlowSnippets = model.input_flow_snippet_ids
    .map((id) => snippetsById.get(id))
    .filter((snippet): snippet is ProjectKnowledgeSnippet => Boolean(snippet))
    .sort((a, b) => snippetOrdinal(a) - snippetOrdinal(b))
  const outputFlowSnippets = model.output_flow_snippet_ids
    .map((id) => snippetsById.get(id))
    .filter((snippet): snippet is ProjectKnowledgeSnippet => Boolean(snippet))
    .sort((a, b) => snippetOrdinal(a) - snippetOrdinal(b))
  const tables = model.table_ids
    .map((id) => tablesById.get(id))
    .filter((table): table is ProjectKnowledgeTable => Boolean(table))
    .sort((a, b) => tableOrdinal(a) - tableOrdinal(b))

  return {
    section_model_id: model.id,
    source_document_id: model.source_document_id,
    section_id: model.section_id,
    section_title: model.section_title,
    section_text: sectionSnippets.map((snippet) => snippet.text).join("\n\n"),
    input_flow_text: inputFlowSnippets.map((snippet) => snippet.text).join("\n\n"),
    output_flow_text: outputFlowSnippets.map((snippet) => snippet.text).join("\n\n"),
    tables: tables.map((table) => ({
      id: table.id,
      caption: table.caption,
      ordinal: tableOrdinal(table),
      is_frame_format: isFrameFormatTable(table),
      headers: table.rows[0] ?? [],
      rows: table.rows,
      table_html: table.table_html,
      cells: table.cells,
      aliases: table.aliases,
      topic: table.topic,
    })),
    primary_table_ids: model.primary_table_ids,
    support_table_ids: model.support_table_ids,
    reference_backed: model.reference_backed,
    referenced_primary_table_ids: model.referenced_primary_table_ids,
    heuristic_relations: model.protocol_relations,
  }
}

function buildDtpProtocolContextPackage(index: ProjectKnowledgeIndex, model: SectionProtocolModel): DtpProtocolContextPackage {
  const snippetsById = new Map(index.snippets.map((snippet) => [snippet.id, snippet]))
  const tablesById = new Map(index.tables.map((table) => [table.id, table]))
  const sectionSnippets = model.section_snippet_ids
    .map((id) => snippetsById.get(id))
    .filter((snippet): snippet is ProjectKnowledgeSnippet => Boolean(snippet))
    .sort((a, b) => snippetOrdinal(a) - snippetOrdinal(b))
  const inputFlowSnippets = model.input_flow_snippet_ids
    .map((id) => snippetsById.get(id))
    .filter((snippet): snippet is ProjectKnowledgeSnippet => Boolean(snippet))
    .sort((a, b) => snippetOrdinal(a) - snippetOrdinal(b))
  const outputFlowSnippets = model.output_flow_snippet_ids
    .map((id) => snippetsById.get(id))
    .filter((snippet): snippet is ProjectKnowledgeSnippet => Boolean(snippet))
    .sort((a, b) => snippetOrdinal(a) - snippetOrdinal(b))
  const tables = model.table_ids
    .map((id) => tablesById.get(id))
    .filter((table): table is ProjectKnowledgeTable => Boolean(table))
    .sort((a, b) => tableOrdinal(a) - tableOrdinal(b))
  const tableInputs = tables.map((table) => ({
    id: table.id,
    caption: table.caption,
    ordinal: tableOrdinal(table),
    is_frame_format: isFrameFormatTable(table),
    headers: table.rows[0] ?? [],
    rows: table.rows,
    table_html: table.table_html,
    cells: table.cells,
    aliases: table.aliases,
    topic: table.topic,
  }))
  const flowBlock = (direction: "input" | "output", flowSnippets: ProjectKnowledgeSnippet[]): DtpProtocolFlowBlock => {
    const snippetIds = flowSnippets.map((snippet) => snippet.id)
    return {
      direction,
      heading_text: flowSnippets[0]?.text ?? "",
      snippet_ids: snippetIds,
      text: flowSnippets.map((snippet) => snippet.text).join("\n\n"),
      table_ids: tables
        .filter((table) => tableBelongsToFlow(table, snippetIds, sectionSnippets))
        .map((table) => table.id),
    }
  }

  return {
    section_model_id: model.id,
    source_document_id: model.source_document_id,
    section_id: model.section_id,
    section_title: model.section_title,
    section_text: sectionSnippets.map((snippet) => snippet.text).join("\n\n"),
    flow_blocks: {
      input: flowBlock("input", inputFlowSnippets),
      output: flowBlock("output", outputFlowSnippets),
    },
    tables: tableInputs,
    primary_table_ids: model.primary_table_ids,
    support_table_ids: model.support_table_ids,
    heuristic_relations: model.protocol_relations,
    bus_profiles: [],
  }
}

export function buildDtpProtocolContextPackages(index: ProjectKnowledgeIndex): DtpProtocolContextPackage[] {
  return buildDtpProtocolContextPackagesImpl(index)
}

function normalizeFrameLayoutCell(cell: string): string | null {
  const normalized = cell.replace(/\s+/g, "")
  if (!normalized) return null
  if (/^SUM$/i.test(normalized)) return "SUM"
  const dataName = normalized.match(/^(W\d+)$/i)?.[1]
  if (dataName) return dataName.toUpperCase()
  const titleMatch = normalized.match(/^(?:TITLE|Title|T)([0-9A-Fa-f]{1,2})H$/)
  if (titleMatch?.[1]) return titleMatch[1].toUpperCase().padStart(2, "0")
  const lengthMatch = normalized.match(/^(?:LENGTH|Length|L)([0-9A-Fa-f]{1,2})H$/)
  if (lengthMatch?.[1]) return lengthMatch[1].toUpperCase().padStart(2, "0")
  const hexWithSuffix = normalized.match(/^([0-9A-Fa-f]{1,2})H$/)
  if (hexWithSuffix?.[1]) return hexWithSuffix[1].toUpperCase().padStart(2, "0")
  const plainByte = normalized.match(/^(?:0x)?([0-9A-Fa-f]{1,2})$/)
  if (plainByte?.[1]) return plainByte[1].toUpperCase().padStart(2, "0")
  return null
}

function frameByteLayoutFromTableInput(table: SectionProtocolRelationTableInput | undefined): string[] {
  if (!table) return []
  const dataRow = table.rows.find((row) => /^\s*\d+[.、]?\s*$/.test(row[0] ?? "")) ?? table.rows[1]
  if (!dataRow) return []
  return dataRow
    .slice(1)
    .map(normalizeFrameLayoutCell)
    .filter((item): item is string => Boolean(item))
}

function protocolGenerationModeFromRelation(relation: SectionProtocolRelation): DtpProtocolDefinition["generation_mode"] {
  return relation.generation_mode === "one_file_per_dictionary_row" ? "one_file_per_dictionary_row" : "single_file"
}

function fieldsFromValuePlan(plan: PacketFieldValuePlan[] | undefined): DtpProtocolFieldDefinition[] {
  return (plan ?? []).map((item) => ({
    name: item.field_name,
    type: "fixed",
    value: normalizeHexByte(item.value) ?? item.value,
    source: item.value_source,
    source_table_id: item.source_table_id,
    source_text: item.source_text,
    confidence: item.confidence,
    warnings: [],
  }))
}

function buildHeuristicProtocolDefinitionsForContext(context: DtpProtocolContextPackage): {
  protocols: DtpProtocolDefinition[]
  nonGeneratedTables: DtpNonGeneratedTable[]
  warnings: string[]
} {
  const tablesById = new Map(context.tables.map((table) => [table.id, table]))
  const protocols: DtpProtocolDefinition[] = []
  const nonGeneratedTables: DtpNonGeneratedTable[] = []
  const generatedTableIds = new Set<string>()
  const supportOnlyTableIds = new Set<string>()

  for (const relation of context.heuristic_relations) {
    const frameTable = tablesById.get(relation.frame_table_id)
    if (!frameTable) continue
    const baseName = cleanGeneratedDataFileBaseName(relation.preferred_name ?? frameTable.caption ?? frameTable.id)
    const protocolId = `${context.section_model_id}-${protocols.length + 1}`
    const supportIds = context.support_table_ids.filter((tableId) => tableId !== relation.dictionary_table_id)

    generatedTableIds.add(relation.frame_table_id)
    if (relation.dictionary_table_id) generatedTableIds.add(relation.dictionary_table_id)
    for (const tableId of supportIds) {
      supportOnlyTableIds.add(tableId)
      nonGeneratedTables.push({
        table_id: tableId,
        reason: "Support table used to explain fields for a generated protocol; it is not a standalone data file.",
      })
    }

    protocols.push({
      protocol_id: protocolId,
      source_section: relation.source_section ?? context.section_title,
      flow_direction: relation.flow_direction ?? "unknown",
      base_file_name: baseName,
      generation_mode: protocolGenerationModeFromRelation(relation),
      frame: {
        source_table_id: relation.frame_table_id,
        byte_layout: frameByteLayoutFromTableInput(frameTable),
        checksum: {
          type: /SUM|\u6821\u9a8c|checksum/i.test(relation.checksum_rule ?? "") ? "sum_low8" : "unknown",
          expression: relation.checksum_rule ?? DEFAULT_CHECKSUM_RULE,
        },
      },
      fields: fieldsFromValuePlan(relation.field_value_plan),
      evidence: uniqueStrings([
        frameTable.caption ?? frameTable.id,
        relation.dictionary_table_id ? (tablesById.get(relation.dictionary_table_id)?.caption ?? relation.dictionary_table_id) : "",
        ...supportIds.map((tableId) => tablesById.get(tableId)?.caption ?? tableId),
      ]),
      warnings: relation.flow_direction && relation.flow_direction !== "unknown"
        ? []
        : ["Flow direction is unknown; deterministic writer should skip or warn before writing."],
      confidence: relation.confidence,
      understanding_source: "heuristic-fallback",
    })
  }

  for (const table of context.tables) {
    if (generatedTableIds.has(table.id)) continue
    if (supportOnlyTableIds.has(table.id)) continue
    if (!context.primary_table_ids.includes(table.id) && !context.support_table_ids.includes(table.id)) continue
    nonGeneratedTables.push({
      table_id: table.id,
      reason: "No protocol relation selected this table as a standalone generated protocol.",
    })
  }

  return { protocols, nonGeneratedTables, warnings: [] }
}

function normalizeProtocolChecksum(raw: unknown): DtpProtocolChecksumDefinition | undefined {
  if (!isRecord(raw)) return undefined
  const rawType = asString(raw.type)
  const type: DtpProtocolChecksumDefinition["type"] =
    rawType === "sum_low8" || rawType === "sum_low16" || rawType === "sum_low32" || rawType === "iso" ||
    rawType === "crc" || rawType === "none" || rawType === "unknown"
      ? rawType
      : "unknown"
  return {
    type,
    start: asString(raw.start),
    end: asString(raw.end),
    expression: asString(raw.expression),
  }
}

function sanitizeProtocolFieldOption(raw: unknown): DtpProtocolFieldOption | null {
  if (!isRecord(raw)) return null
  const value = normalizeHexByte(asString(raw.value))
  const label = asString(raw.label)
  if (!value || !label) return null
  return {
    value,
    label: sanitizeReadableFileBaseName(label) || label,
    source: asString(raw.source),
  }
}

function sanitizeProtocolField(raw: unknown, tableIds: Set<string>): DtpProtocolFieldDefinition | null {
  if (!isRecord(raw)) return null
  const name = asString(raw.name)?.toUpperCase()
  if (!name || !/^W\d+$/.test(name)) return null
  const rawType = asString(raw.type)
  const type: DtpProtocolFieldDefinition["type"] =
    rawType === "fixed" || rawType === "enum" || rawType === "bitfield" || rawType === "unknown"
      ? rawType
      : "unknown"
  const sourceTableId = asString(raw.source_table_id)
  const options = getNestedArray(raw, ["options"])
    .map(sanitizeProtocolFieldOption)
    .filter((item): item is DtpProtocolFieldOption => Boolean(item))
  return {
    name,
    type,
    value: normalizeHexByte(asString(raw.value)),
    options: options.length ? options : undefined,
    source: asString(raw.source),
    source_table_id: sourceTableId && tableIds.has(sourceTableId) ? sourceTableId : undefined,
    source_text: asString(raw.source_text),
    confidence: Math.max(0, Math.min(1, asNumber(raw.confidence) ?? 0.5)),
    warnings: getNestedArray(raw, ["warnings"])
      .map((item) => asString(item))
      .filter((item): item is string => Boolean(item)),
  }
}

function sanitizeModelProtocolDefinitions(
  context: DtpProtocolContextPackage,
  rawUnderstanding: unknown,
): {
  protocols: DtpProtocolDefinition[]
  nonGeneratedTables: DtpNonGeneratedTable[]
  warnings: string[]
} {
  if (!isRecord(rawUnderstanding)) return { protocols: [], nonGeneratedTables: [], warnings: [] }

  const tableIds = new Set(context.tables.map((table) => table.id))
  const protocols: DtpProtocolDefinition[] = []
  for (const rawProtocol of getNestedArray(rawUnderstanding, ["protocols"])) {
    if (!isRecord(rawProtocol)) continue
    const frame: Record<string, unknown> = isRecord(rawProtocol.frame) ? rawProtocol.frame : {}
    const frameTableId = asString(frame.source_table_id)
    if (!frameTableId || !tableIds.has(frameTableId)) continue

    const rawFlowDirection = asString(rawProtocol.flow_direction)
    const flowDirection: FlowDirection =
      rawFlowDirection === "input" || rawFlowDirection === "output" || rawFlowDirection === "unknown"
        ? rawFlowDirection
        : "unknown"
    const rawGenerationMode = asString(rawProtocol.generation_mode)
    const generationMode: DtpProtocolDefinition["generation_mode"] =
      rawGenerationMode === "single_file" ||
      rawGenerationMode === "expand_variants" ||
      rawGenerationMode === "one_file_per_dictionary_row" ||
      rawGenerationMode === "skip"
        ? rawGenerationMode
        : "single_file"
    const baseFileName = cleanGeneratedDataFileBaseName(asString(rawProtocol.base_file_name) ?? frameTableId)
    const byteLayout = getNestedArray(frame, ["byte_layout"])
      .map((item) => asString(item))
      .filter((item): item is string => Boolean(item))
    const fields = getNestedArray(rawProtocol, ["fields"])
      .map((item) => sanitizeProtocolField(item, tableIds))
      .filter((item): item is DtpProtocolFieldDefinition => Boolean(item))

    protocols.push({
      protocol_id: asString(rawProtocol.protocol_id) ?? `${context.section_model_id}-${protocols.length + 1}`,
      source_section: asString(rawProtocol.source_section) ?? context.section_title,
      flow_direction: flowDirection,
      base_file_name: baseFileName,
      generation_mode: generationMode,
      frame: {
        source_table_id: frameTableId,
        byte_layout: byteLayout.length ? byteLayout : frameByteLayoutFromTableInput(context.tables.find((table) => table.id === frameTableId)),
        checksum: normalizeProtocolChecksum(frame.checksum),
      },
      fields,
      evidence: uniqueStrings(
        getNestedArray(rawProtocol, ["evidence"])
          .map((item) => asString(item))
          .filter((item): item is string => Boolean(item)),
      ),
      warnings: getNestedArray(rawProtocol, ["warnings"])
        .map((item) => asString(item))
        .filter((item): item is string => Boolean(item)),
      confidence: Math.max(0, Math.min(1, asNumber(rawProtocol.confidence) ?? 0.75)),
      understanding_source: "model",
    })
  }

  const nonGeneratedTables = getNestedArray(rawUnderstanding, ["non_generated_tables"])
    .map((raw): DtpNonGeneratedTable | null => {
      if (!isRecord(raw)) return null
      const tableId = asString(raw.table_id)
      if (!tableId || !tableIds.has(tableId)) return null
      return {
        table_id: tableId,
        reason: asString(raw.reason) ?? "Model marked this table as non-generated.",
      }
    })
    .filter((item): item is DtpNonGeneratedTable => Boolean(item))
  const warnings = getNestedArray(rawUnderstanding, ["warnings"])
    .map((item) => asString(item))
    .filter((item): item is string => Boolean(item))

  return { protocols, nonGeneratedTables, warnings }
}

function sanitizeModelProtocolRelations(
  model: SectionProtocolModel,
  rawRelations: unknown,
): SectionProtocolRelation[] {
  const primaryIds = new Set(model.primary_table_ids)
  const tableIds = new Set(model.table_ids)
  const rawItems = Array.isArray(rawRelations) ? rawRelations : []
  const relations: SectionProtocolRelation[] = []

  for (const raw of rawItems) {
    if (!isRecord(raw)) continue

    const frameTableId = asString(raw.frame_table_id)
    if (!frameTableId || !primaryIds.has(frameTableId)) continue

    const generationMode = asString(raw.generation_mode)
    if (generationMode !== "frame_file" && generationMode !== "one_file_per_dictionary_row") continue

    const dictionaryTableId = asString(raw.dictionary_table_id)
    if (generationMode === "one_file_per_dictionary_row" && (!dictionaryTableId || !tableIds.has(dictionaryTableId))) {
      continue
    }
    if (dictionaryTableId && !tableIds.has(dictionaryTableId)) continue

    const shouldGenerateRaw = raw.should_generate_frame_table_file
    const rawFlowDirection = asString(raw.flow_direction)
    const flowDirection: FlowDirection =
      rawFlowDirection === "input" || rawFlowDirection === "output" || rawFlowDirection === "unknown"
        ? rawFlowDirection
        : "unknown"
    const reasoning = getNestedArray(raw, ["reasoning"])
      .map((item) => asString(item))
      .filter((item): item is string => Boolean(item))
    const confidence = Math.max(0, Math.min(1, asNumber(raw.confidence) ?? 0.78))

    relations.push({
      frame_table_id: frameTableId,
      dictionary_table_id: dictionaryTableId,
      generation_mode: generationMode,
      preferred_name: asString(raw.preferred_name),
      flow_direction: flowDirection,
      source_section: asString(raw.source_section),
      source_flow_heading: asString(raw.source_flow_heading) ?? flowHeadingName(flowDirection),
      file_name_field: asString(raw.file_name_field),
      data_code_field: asString(raw.data_code_field),
      field_value_plan: sanitizeModelFieldValuePlan(raw.field_value_plan, tableIds),
      should_generate_frame_table_file:
        typeof shouldGenerateRaw === "boolean" ? shouldGenerateRaw : generationMode === "frame_file",
      checksum_rule: asString(raw.checksum_rule) ?? DEFAULT_CHECKSUM_RULE,
      confidence,
      reasoning: reasoning.length
        ? reasoning.map((item) => (item.startsWith("model:") ? item : `model: ${item}`))
        : ["model: The section protocol relation was inferred from the full section context."],
    })
  }

  return relations
}

function sanitizeModelFieldValuePlan(rawPlan: unknown, tableIds: Set<string>): PacketFieldValuePlan[] | undefined {
  const rawItems = Array.isArray(rawPlan) ? rawPlan : []
  const plan: PacketFieldValuePlan[] = []

  for (const raw of rawItems) {
    if (!isRecord(raw)) continue

    const fieldName = asString(raw.field_name)?.toUpperCase()
    if (!fieldName || !/^W\d+$/.test(fieldName)) continue

    const value = normalizeHexByte(asString(raw.value))
    if (!value) continue

    const sourceTableId = asString(raw.source_table_id)
    if (sourceTableId && !tableIds.has(sourceTableId)) continue

    const reasoning = getNestedArray(raw, ["reasoning"])
      .map((item) => asString(item))
      .filter((item): item is string => Boolean(item))

    plan.push({
      field_name: fieldName,
      value,
      value_source: "model",
      source_table_id: sourceTableId,
      source_text: asString(raw.source_text),
      confidence: Math.max(0, Math.min(1, asNumber(raw.confidence) ?? 0.7)),
      reasoning: reasoning.length
        ? reasoning.map((item) => (item.startsWith("model:") ? item : `model: ${item}`))
        : [`model: ${fieldName} value was inferred from the section context.`],
    })
  }

  return plan.length ? plan : undefined
}

function rebuildSectionModelsWithExistingRelations(index: ProjectKnowledgeIndex): void {
  const tablesById = new Map(index.tables.map((table) => [table.id, table]))

  index.section_protocol_models = index.section_protocol_models.map((model) => {
    const orderedTables = model.table_ids
      .map((id) => tablesById.get(id))
      .filter((table): table is ProjectKnowledgeTable => Boolean(table))
      .sort((a, b) => tableOrdinal(a) - tableOrdinal(b))
    const primaryTables = model.primary_table_ids
      .map((id) => tablesById.get(id))
      .filter((table): table is ProjectKnowledgeTable => Boolean(table))
      .sort((a, b) => tableOrdinal(a) - tableOrdinal(b))

    return {
      ...model,
      protocols: buildProtocolsFromRelations(
        orderedTables,
        primaryTables,
        model.protocol_relations,
        index.packet_model_candidates,
      ),
    }
  })
}

function mergeModelRelationsWithHeuristic(
  heuristicRelations: SectionProtocolRelation[],
  modelRelations: SectionProtocolRelation[],
  protectedReferenceTableIds: string[] = [],
): SectionProtocolRelation[] {
  const protectedTables = new Set(protectedReferenceTableIds)
  const modelFrameTableIds = new Set(modelRelations.map((relation) => relation.frame_table_id))
  const mergedByFrame = new Map<string, SectionProtocolRelation>()
  for (const relation of heuristicRelations) {
    // A successful model decision is authoritative for broad reference-backed
    // candidates. Keep direct local tables, but do not union every table from a
    // referenced appendix back into the selected protocol set.
    if (protectedTables.has(relation.frame_table_id) && !modelFrameTableIds.has(relation.frame_table_id)) continue
    mergedByFrame.set(relation.frame_table_id, relation)
  }
  for (const relation of modelRelations) {
    const heuristic = mergedByFrame.get(relation.frame_table_id)
    const referenceOwned = protectedTables.has(relation.frame_table_id)
    mergedByFrame.set(relation.frame_table_id, {
      ...heuristic,
      ...relation,
      flow_direction: referenceOwned
        ? heuristic?.flow_direction
        : relation.flow_direction && relation.flow_direction !== "unknown"
        ? relation.flow_direction
        : heuristic?.flow_direction,
      source_section: referenceOwned ? heuristic?.source_section : relation.source_section ?? heuristic?.source_section,
      source_flow_heading: referenceOwned ? heuristic?.source_flow_heading : relation.source_flow_heading ?? heuristic?.source_flow_heading,
      preferred_name: referenceOwned ? heuristic?.preferred_name : relation.preferred_name ?? heuristic?.preferred_name,
    })
  }
  return Array.from(mergedByFrame.values())
}

function hasCompleteDeterministicReferenceRelations(
  index: ProjectKnowledgeIndex,
  model: SectionProtocolModel,
): boolean {
  const referencedTableIds = new Set(model.referenced_primary_table_ids ?? [])
  if (
    !model.reference_backed ||
    referencedTableIds.size === 0 ||
    model.primary_table_ids.length === 0 ||
    !model.primary_table_ids.every((tableId) => referencedTableIds.has(tableId))
  ) return false

  const sourceSnippetIds = new Set(model.section_snippet_ids)
  const exactReferencedTableIds = new Set(index.references.flatMap((reference) => {
    if (
      !reference.source_snippet_id ||
      !sourceSnippetIds.has(reference.source_snippet_id) ||
      reference.state !== "resolved" ||
      (reference.confidence ?? 0) < 0.95 ||
      !reference.semantic_roles?.includes("frame_layout")
    ) return []
    return reference.resolved_table_ids ?? (reference.resolved_table_id ? [reference.resolved_table_id] : [])
  }))
  if (![...referencedTableIds].every((tableId) => exactReferencedTableIds.has(tableId))) return false

  return [...referencedTableIds].every((tableId) => model.protocol_relations.some((relation) => (
    relation.frame_table_id === tableId &&
    Boolean(relation.preferred_name?.trim()) &&
    relation.flow_direction !== undefined &&
    relation.flow_direction !== "unknown" &&
    relation.confidence >= 0.85
  )))
}

async function applyDtpDataModelUnderstanding(
  index: ProjectKnowledgeIndex,
  modelHooks?: DtpDataModelHooks | null,
): Promise<ProjectKnowledgeIndex> {
  const analyze = modelHooks?.analyzeSectionProtocolRelations
  if (!analyze || index.section_protocol_models.length === 0) return index

  const warnings: string[] = []
  const updatedResults = await mapWithConcurrency(
    index.section_protocol_models,
    getDtpModelSectionConcurrency(),
    async (model): Promise<{ model: SectionProtocolModel; warnings: string[] }> => {
      const localWarnings: string[] = []
      if (hasCompleteDeterministicReferenceRelations(index, model)) {
        return { model, warnings: localWarnings }
      }
      const modelRelations: unknown[] = []
      const rawModelInput = buildSectionProtocolRelationModelInput(index, model)
      const modelInputs = prepareSectionRelationModelInputs(rawModelInput)
      const analyzedPrimaryTableIds = new Set(modelInputs.flatMap((input) => input.primary_table_ids))
      for (const modelInput of modelInputs) {
        try {
          const timeoutMs = modelInput.model_timeout_ms ?? getDtpModelSectionTimeoutMs()
          const runAnalyze = () =>
            withTimeout(
              analyze(modelInput),
              timeoutMs,
              `Model protocol analysis timed out after ${timeoutMs}ms`,
            )
          const result = modelHooks?.performance
            ? await modelHooks.performance.measureModelCall("model_relation_analysis", modelInput, runAnalyze)
            : await runAnalyze()
          if (result?.length) modelRelations.push(...result)
        } catch (error) {
          localWarnings.push(
            `Model protocol analysis failed for ${model.section_title}: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }

      const validated = sanitizeModelProtocolRelations(model, modelRelations)
      if (validated.length) {
        return {
          model: {
            ...model,
            protocol_relations: mergeModelRelationsWithHeuristic(
              model.protocol_relations,
              validated,
              (model.referenced_primary_table_ids ?? []).filter((tableId) => analyzedPrimaryTableIds.has(tableId)),
            ),
            warnings: model.warnings,
          },
          warnings: localWarnings,
        }
      }

      modelHooks?.performance?.recordFallback("model_relation_analysis", modelInputs[0] ?? rawModelInput, [
        "Model protocol analysis returned no valid relation; heuristic relation was kept.",
      ])
      return {
        model: {
          ...model,
          warnings: uniqueStrings([
            ...model.warnings,
            "Model protocol analysis returned no valid relation; heuristic relation was kept.",
          ]),
        },
        warnings: localWarnings,
      }
    },
  )

  index.section_protocol_models = updatedResults.map((item) => item.model)
  warnings.push(...updatedResults.flatMap((item) => item.warnings))
  const snippetCandidates = buildPacketModelCandidates(index.snippets)
  const tableCandidates = buildPacketModelCandidatesFromTables(index.tables, snippetCandidates.length)
  const relationCandidates = buildDictionaryRowProtocolCandidatesFromRelations(
    index.tables,
    index.section_protocol_models.flatMap((model) => model.protocol_relations),
    snippetCandidates.length + tableCandidates.length,
  )
  index.packet_model_candidates = [
    ...snippetCandidates,
    ...tableCandidates,
    ...relationCandidates,
  ]
  rebuildSectionModelsWithExistingRelations(index)
  index.warnings = uniqueStrings([...index.warnings, ...warnings])
  index.updated_at = new Date().toISOString()
  return index
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function readPositiveIntegerEnv(name: string, defaultValue: number, options?: { min?: number; max?: number }): number {
  const raw = process.env[name]
  const parsed = raw ? Number(raw) : NaN
  if (!Number.isFinite(parsed)) return defaultValue
  const rounded = Math.floor(parsed)
  const min = options?.min ?? 1
  const max = options?.max ?? Number.MAX_SAFE_INTEGER
  return Math.min(max, Math.max(min, rounded))
}

function getDtpModelSectionTimeoutMs(): number {
  return readPositiveIntegerEnv("DTP_MODEL_SECTION_TIMEOUT_MS", DEFAULT_DTP_MODEL_SECTION_TIMEOUT_MS, {
    min: 10_000,
    max: 10 * 60_000,
  })
}

function getDtpProtocolUnderstandingTimeoutMs(): number {
  return readPositiveIntegerEnv(
    "DTP_PROTOCOL_UNDERSTANDING_TIMEOUT_MS",
    DEFAULT_DTP_PROTOCOL_UNDERSTANDING_TIMEOUT_MS,
    { min: 10_000, max: 10 * 60_000 },
  )
}

function getDtpCaseStepRetryTimeoutMs(): number {
  return readPositiveIntegerEnv(
    "DTP_CASE_STEP_RETRY_TIMEOUT_MS",
    DEFAULT_DTP_CASE_STEP_RETRY_TIMEOUT_MS,
    { min: 10_000, max: 10 * 60_000 },
  )
}

function getDtpModelSectionConcurrency(): number {
  return readPositiveIntegerEnv("DTP_MODEL_SECTION_CONCURRENCY", DEFAULT_DTP_MODEL_SECTION_CONCURRENCY, {
    min: 1,
    max: 6,
  })
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIndex = 0
  const workerCount = Math.min(Math.max(1, concurrency), items.length)

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex
        nextIndex += 1
        results[currentIndex] = await worker(items[currentIndex], currentIndex)
      }
    }),
  )

  return results
}

type DtpModelCacheEntry = {
  stage: DtpPerformanceModelStageName
  input_hash: string
  prompt_version: string
  created_at: string
  result: unknown
}

type DtpModelCacheDocument = {
  schema_version: "1.0.0"
  prompt_version: string
  entries: Record<string, DtpModelCacheEntry>
  updated_at: string
}

function createModelCacheKey(stage: DtpPerformanceModelStageName, input: unknown): string {
  const inputHash = createHash("sha256")
    .update(JSON.stringify(stableModelCacheInput(input)))
    .digest("hex")
  return `${modelCachePromptVersion(stage)}:${stage}:${inputHash}`
}

function stableModelCacheInput(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(stableModelCacheInput)
  if (!isRecord(input)) return input

  return Object.fromEntries(
    Object.entries(input)
      .filter(([key]) => ![
        "model_input_metrics",
        "model_timeout_ms",
        "__dtp_cache_hit",
      ].includes(key))
      .map(([key, value]) => [key, stableModelCacheInput(value)]),
  )
}

function withModelCacheHitMetadata<T>(result: T, cacheHit: boolean): T {
  return isRecord(result) ? { ...result, __dtp_cache_hit: cacheHit } as T : result
}

function normalizeCaseStepDescriptionForCache(value: string | undefined): string {
  return semanticCaseStepDescription(value)
    .replace(/第?\s*\d+(?:\.\d+)?\s*(?:秒|s)\s*[,，]?/gi, "")
    .replace(/\s+/g, " ")
    .trim()
}

function caseStepPlanningCacheInput(input: CaseStepDataPlanningInput): unknown {
  const modelFallback = input.model_fallback
    ? {
        ...input.model_fallback,
        profile: {
          ...input.model_fallback.profile,
          // The global registry changes when an unrelated adapter is added. The
          // selected policy hash is sufficient to invalidate the affected bus.
          registry_hash: undefined,
        },
      }
    : undefined
  return {
    keyword: input.keyword,
    step_desc: normalizeCaseStepDescriptionForCache(input.step.step_desc),
    project_value_evidence: input.project_value_evidence,
    candidate_data_files: input.candidate_data_files.map((candidate) => ({
      protocol_name: candidate.protocol_name,
      requested_file_name: candidate.requested_file_name,
      flow_direction: candidate.flow_direction,
      checksum_rule: candidate.checksum_rule,
    })),
    model_fallback: modelFallback,
  }
}

function compactCaseStepPlanForRetry(plan: CaseStepDataGenerationPlan): unknown {
  return {
    protocol_id: plan.protocol_id,
    protocol_name: plan.protocol_name,
    payload_length_bytes: plan.payload_length_bytes,
    related_message_length_bytes: plan.related_message_length_bytes,
    flow_direction: plan.flow_direction,
    bus: plan.bus,
    operation: plan.operation,
    target_address: plan.target_address,
    protocol_entity: plan.protocol_entity,
    artifact_scope: plan.artifact_scope,
    selected_block: plan.selected_block,
    base_file_name: plan.base_file_name,
    base_file_path: plan.base_file_path,
    base_bytes: plan.base_bytes,
    variant_type: plan.variant_type,
    mutations: plan.mutations,
    sequence_operations: plan.sequence_operations,
    checksum_policy: plan.checksum_policy,
    argument_values: plan.argument_values,
    command: plan.command,
    interface_level: plan.interface_level,
    interface_id: plan.interface_id,
    confidence: plan.confidence,
  }
}

function compactCaseStepRetryInput(input: CaseStepDataPlanRetryInput): unknown {
  const compactIssues = <T extends { severity: string; type: string; message: string }>(issues: T[]) => issues.map((issue) => ({
    severity: issue.severity,
    type: issue.type,
    ...( "argument_name" in issue && typeof issue.argument_name === "string"
      ? { argument_name: issue.argument_name }
      : {}),
    message: issue.message.slice(0, 600),
  }))
  return {
    planning_input: caseStepPlanningCacheInput(input.planning_input),
    current_plan: compactCaseStepPlanForRetry(input.current_plan),
    argument_quality: {
      status: input.argument_quality.status,
      expected_argument_count: input.argument_quality.expected_argument_count,
      actual_argument_count: input.argument_quality.actual_argument_count,
      issues: compactIssues(input.argument_quality.issues),
    },
    data_quality: {
      status: input.data_quality.status,
      issues: compactIssues(input.data_quality.issues),
    },
  }
}

function modelCachePromptVersion(stage: DtpPerformanceModelStageName): string {
  return stage === "case_step_planning" || stage === "case_step_retry"
    ? DTP_CASE_STEP_MODEL_PROMPT_VERSION
    : DTP_MODEL_CACHE_PROMPT_VERSION
}

function createEmptyModelCache(): DtpModelCacheDocument {
  return {
    schema_version: DTP_MODEL_CACHE_SCHEMA_VERSION,
    prompt_version: DTP_MODEL_CACHE_PROMPT_VERSION,
    entries: {},
    updated_at: new Date().toISOString(),
  }
}

function parseDtpModelCacheEntry(value: unknown): DtpModelCacheEntry | undefined {
  if (!isRecord(value)) return undefined
  const stage = asString(value.stage) as DtpPerformanceModelStageName | undefined
  const inputHash = asString(value.input_hash)
  if (!stage || !inputHash || !("result" in value)) return undefined
  return {
    stage,
    input_hash: inputHash,
    prompt_version: asString(value.prompt_version) ?? modelCachePromptVersion(stage),
    created_at: asString(value.created_at) ?? new Date().toISOString(),
    result: value.result,
  }
}

function loadDtpModelCache(cacheFile: string, entriesDir?: string): DtpModelCacheDocument {
  const cache = createEmptyModelCache()
  if (existsSync(cacheFile)) {
    try {
      const parsed = readJsonFile(cacheFile)
      if (isRecord(parsed) && asString(parsed.prompt_version) === DTP_MODEL_CACHE_PROMPT_VERSION) {
        const entriesRecord = isRecord(parsed.entries) ? parsed.entries : {}
        for (const [key, value] of Object.entries(entriesRecord)) {
          const entry = parseDtpModelCacheEntry(value)
          if (entry) cache.entries[key] = entry
        }
        cache.updated_at = asString(parsed.updated_at) ?? cache.updated_at
      }
    } catch {
      // Individual entry checkpoints can still recover an interrupted cache snapshot.
    }
  }

  if (entriesDir && existsSync(entriesDir)) {
    for (const fileName of readdirSync(entriesDir)) {
      if (!fileName.endsWith(".json")) continue
      try {
        const parsed = readJsonFile(join(entriesDir, fileName))
        if (!isRecord(parsed)) continue
        const key = asString(parsed.cache_key)
        const entry = parseDtpModelCacheEntry(parsed.entry)
        if (!key || !entry || entry.prompt_version !== modelCachePromptVersion(entry.stage)) continue
        cache.entries[key] = entry
      } catch {
        continue
      }
    }
  }
  return cache
}

function writeDtpModelCache(cacheFile: string, cache: DtpModelCacheDocument): void {
  ensureDirectory(dirname(cacheFile))
  const temporaryFile = `${cacheFile}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(
      temporaryFile,
      `${JSON.stringify({ ...cache, updated_at: new Date().toISOString() })}\n`,
      "utf-8",
    )
    const parsed = readJsonFile(temporaryFile)
    if (!isRecord(parsed) || parsed.schema_version !== DTP_MODEL_CACHE_SCHEMA_VERSION || !isRecord(parsed.entries)) {
      throw new Error("dtp-data-model-cache.json failed structural validation")
    }
    renameSync(temporaryFile, cacheFile)
  } finally {
    rmSync(temporaryFile, { force: true })
  }
}

function writeDtpModelCacheEntry(entriesDir: string, key: string, entry: DtpModelCacheEntry): void {
  ensureDirectory(entriesDir)
  const fileName = `${createHash("sha256").update(key).digest("hex")}.json`
  writeJsonAtomically(join(entriesDir, fileName), {
    schema_version: DTP_MODEL_CACHE_SCHEMA_VERSION,
    cache_key: key,
    entry,
  })
}

function createCachedDtpDataModelHooks(paths: DefaultPaths, hooks?: DtpDataModelHooks | null): DtpDataModelHooks | null {
  if (!hooks) return null
  const cache = loadDtpModelCache(paths.dtpModelCacheFile, paths.dtpModelCacheEntriesDir)
  const inFlight = new Map<string, Promise<unknown | null>>()
  const timedOutThisRun = new Map<string, string>()
  const stats: DtpModelCacheStats = {
    hits: 0,
    misses: 0,
    writes: 0,
    in_flight_reuses: 0,
    timeouts: 0,
    timeout_memo_reuses: 0,
  }
  let dirty = false

  const getCachedOrRun = async <T>(
    stage: DtpPerformanceModelStageName,
    input: unknown,
    run: () => Promise<T | null>,
  ): Promise<T | null> => {
    const cacheInput = stage === "case_step_planning"
      ? caseStepPlanningCacheInput(input as CaseStepDataPlanningInput)
      : stage === "case_step_retry"
        ? compactCaseStepRetryInput(input as CaseStepDataPlanRetryInput)
        : input
    const key = createModelCacheKey(stage, cacheInput)
    const cached = cache.entries[key]
    if (cached) {
      stats.hits += 1
      return withModelCacheHitMetadata(cached.result as T, true)
    }

    const previousTimeout = timedOutThisRun.get(key)
    if (previousTimeout) {
      stats.timeout_memo_reuses += 1
      throw new Error(`Run-local timeout memo reused for identical ${stage} input: ${previousTimeout}`)
    }

    const pending = inFlight.get(key)
    if (pending) {
      stats.in_flight_reuses += 1
      return await pending as T | null
    }
    stats.misses += 1

    const execution = (async (): Promise<T | null> => {
      try {
        const result = await run()
        if (result !== null && result !== undefined) {
          const inputHash = key.split(":").pop() ?? ""
          const entry: DtpModelCacheEntry = {
            stage,
            input_hash: inputHash,
            prompt_version: modelCachePromptVersion(stage),
            created_at: new Date().toISOString(),
            result,
          }
          cache.entries[key] = entry
          writeDtpModelCacheEntry(paths.dtpModelCacheEntriesDir, key, entry)
          dirty = true
          stats.writes += 1
        }
        return result === null || result === undefined ? result : withModelCacheHitMetadata(result, false)
      } catch (error) {
        if (isTimeoutError(error)) {
          const message = errorMessage(error)
          timedOutThisRun.set(key, message)
          stats.timeouts += 1
        }
        throw error
      }
    })()
    inFlight.set(key, execution as Promise<unknown | null>)
    try {
      return await execution
    } finally {
      inFlight.delete(key)
    }
  }

  return {
    ...hooks,
    analyzeSectionProtocolRelations: hooks.analyzeSectionProtocolRelations
      ? (input) => getCachedOrRun("model_relation_analysis", input, () => hooks.analyzeSectionProtocolRelations!(input))
      : undefined,
    understandSectionProtocols: hooks.understandSectionProtocols
      ? (input) => getCachedOrRun("model_protocol_understanding", input, () => hooks.understandSectionProtocols!(input))
      : undefined,
    reviseProtocolDefinitions: hooks.reviseProtocolDefinitions
      ? (input) => getCachedOrRun("protocol_retry", input, () => hooks.reviseProtocolDefinitions!(input))
      : undefined,
    planCaseStepData: hooks.planCaseStepData
      ? (input) => getCachedOrRun("case_step_planning", input, () => hooks.planCaseStepData!(input))
      : undefined,
    reviseCaseStepDataPlan: hooks.reviseCaseStepDataPlan
      ? (input) => getCachedOrRun("case_step_retry", input, () => hooks.reviseCaseStepDataPlan!(input))
      : undefined,
    performance: hooks.performance,
    flushCache: () => {
      if (!dirty) return
      writeDtpModelCache(paths.dtpModelCacheFile, cache)
      dirty = false
    },
    cacheStats: () => ({ ...stats }),
  }
}

function safeJsonLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    return 0
  }
}

function textLength(value: unknown): number {
  return typeof value === "string" ? value.length : 0
}

function estimateTokenCount(charCount: number): number {
  return Math.ceil(charCount / DTP_PERFORMANCE_ESTIMATED_TOKEN_CHARS)
}

function isTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /timed out|timeout/i.test(message)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function getRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function getPerformanceInputTables(input: unknown): unknown[] {
  const record = getRecord(input)
  return Array.isArray(record.tables) ? record.tables : []
}

function buildTablePayloadMetrics(tables: unknown[]): Pick<
  DtpPerformancePayloadMetrics,
  "table_count" | "table_payload_chars" | "table_html_chars" | "cells_chars" | "rows_chars"
> {
  let tableHtmlChars = 0
  let cellsChars = 0
  let rowsChars = 0
  for (const table of tables) {
    const record = getRecord(table)
    tableHtmlChars += textLength(record.table_html)
    cellsChars += safeJsonLength(record.cells)
    rowsChars += safeJsonLength(record.rows)
  }
  return {
    table_count: tables.length,
    table_payload_chars: safeJsonLength(tables),
    table_html_chars: tableHtmlChars,
    cells_chars: cellsChars,
    rows_chars: rowsChars,
  }
}

function getPerformanceInputIdentity(input: unknown): {
  case_id?: string
  step_index?: number
  section_model_id?: string
  section_id?: string
  section_title?: string
} {
  const record = getRecord(input)
  const step = getRecord(record.step)
  const planningInput = getRecord(record.planning_input)
  const retryStep = getRecord(planningInput.step)
  return {
    case_id: typeof record.case_id === "string"
      ? record.case_id
      : typeof planningInput.case_id === "string"
        ? planningInput.case_id
        : undefined,
    step_index: typeof step.step_index === "number"
      ? step.step_index
      : typeof retryStep.step_index === "number"
        ? retryStep.step_index
        : undefined,
    section_model_id: typeof record.section_model_id === "string" ? record.section_model_id : undefined,
    section_id: typeof record.section_id === "string" ? record.section_id : undefined,
    section_title: typeof record.section_title === "string" ? record.section_title : undefined,
  }
}

function getPerformanceModelFallback(input: unknown): Pick<
  DtpPerformanceSectionCall,
  "model_profile_id" | "model_profile_version" | "candidate_protocol_count" | "included_evidence_count"
> {
  const record = getRecord(input)
  const planningInput = getRecord(record.planning_input)
  const fallback = getRecord(record.model_fallback ?? planningInput.model_fallback)
  const profile = getRecord(fallback.profile)
  return {
    model_profile_id: typeof profile.profile_id === "string" ? profile.profile_id : undefined,
    model_profile_version: typeof profile.profile_version === "string" ? profile.profile_version : undefined,
    candidate_protocol_count: Array.isArray(fallback.candidate_protocols) ? fallback.candidate_protocols.length : undefined,
    included_evidence_count: Array.isArray(fallback.evidence) ? fallback.evidence.length : undefined,
  }
}

function buildPerformancePayloadMetrics(
  stage: DtpPerformanceModelStageName,
  input: unknown,
): DtpPerformancePayloadMetrics {
  const record = getRecord(input)
  const tables = getPerformanceInputTables(input)
  const tableMetrics = buildTablePayloadMetrics(tables)
  let sectionTextChars = textLength(record.section_text)
  let inputFlowChars = textLength(record.input_flow_text)
  let outputFlowChars = textLength(record.output_flow_text)
  let heuristicRelationsChars = safeJsonLength(record.heuristic_relations)
  let promptChars = 0

  if (stage === "model_protocol_understanding") {
    const flowBlocks = getRecord(record.flow_blocks)
    const inputFlow = getRecord(flowBlocks.input)
    const outputFlow = getRecord(flowBlocks.output)
    inputFlowChars = textLength(inputFlow.text)
    outputFlowChars = textLength(outputFlow.text)
    promptChars =
      textLength(record.section_title) +
      textLength(record.section_id) +
      sectionTextChars +
      safeJsonLength(record.flow_blocks) +
      tableMetrics.table_payload_chars +
      safeJsonLength(record.primary_table_ids) +
      safeJsonLength(record.support_table_ids) +
      heuristicRelationsChars
  } else if (stage === "model_relation_analysis") {
    promptChars =
      textLength(record.section_title) +
      textLength(record.section_id) +
      inputFlowChars +
      outputFlowChars +
      sectionTextChars +
      tableMetrics.table_payload_chars +
      safeJsonLength(record.primary_table_ids) +
      safeJsonLength(record.support_table_ids) +
      heuristicRelationsChars
  } else {
    promptChars = safeJsonLength(input)
    heuristicRelationsChars = 0
  }

  const systemPromptChars =
    stage === "protocol_retry"
      ? 520
      : stage === "model_protocol_understanding"
        ? 430
        : 520
  const payloadChars = systemPromptChars + promptChars
  const modelInputMetrics = getRecord(record.model_input_metrics)
  const finalPromptChars = typeof modelInputMetrics.final_prompt_chars === "number"
    ? modelInputMetrics.final_prompt_chars
    : payloadChars
  const finalPromptTokens = typeof modelInputMetrics.final_prompt_tokens === "number"
    ? modelInputMetrics.final_prompt_tokens
    : estimateTokenCount(finalPromptChars)
  return {
    system_prompt_chars: systemPromptChars,
    prompt_chars: promptChars,
    payload_chars: finalPromptChars,
    estimated_tokens: finalPromptTokens,
    section_text_chars: sectionTextChars,
    input_flow_chars: inputFlowChars,
    output_flow_chars: outputFlowChars,
    table_count: tableMetrics.table_count,
    table_payload_chars: tableMetrics.table_payload_chars,
    table_html_chars: tableMetrics.table_html_chars,
    cells_chars: tableMetrics.cells_chars,
    rows_chars: tableMetrics.rows_chars,
    heuristic_relations_chars: heuristicRelationsChars,
    raw_context_chars: typeof modelInputMetrics.raw_context_chars === "number"
      ? modelInputMetrics.raw_context_chars
      : undefined,
    raw_context_tokens: typeof modelInputMetrics.raw_context_tokens === "number"
      ? modelInputMetrics.raw_context_tokens
      : undefined,
    final_prompt_chars: finalPromptChars,
    final_prompt_tokens: finalPromptTokens,
    candidate_table_count: typeof modelInputMetrics.candidate_table_count === "number"
      ? modelInputMetrics.candidate_table_count
      : tables.length,
    selected_table_count: typeof modelInputMetrics.selected_table_count === "number"
      ? modelInputMetrics.selected_table_count
      : tables.length,
    selected_row_count: typeof modelInputMetrics.selected_row_count === "number"
      ? modelInputMetrics.selected_row_count
      : undefined,
    token_budget: typeof modelInputMetrics.token_budget === "number"
      ? modelInputMetrics.token_budget
      : undefined,
    retrieval_duration_ms: typeof modelInputMetrics.retrieval_duration_ms === "number"
      ? modelInputMetrics.retrieval_duration_ms
      : undefined,
    applied_timeout_ms: typeof modelInputMetrics.applied_timeout_ms === "number"
      ? modelInputMetrics.applied_timeout_ms
      : typeof record.model_timeout_ms === "number"
        ? record.model_timeout_ms
        : undefined,
    omitted_table_ids: Array.isArray(modelInputMetrics.omitted_table_ids)
      ? modelInputMetrics.omitted_table_ids.filter((item): item is string => typeof item === "string")
      : undefined,
  }
}

function samePerformanceInputIdentity(call: DtpPerformanceSectionCall, input: unknown): boolean {
  const identity = getPerformanceInputIdentity(input)
  if (identity.section_model_id) return call.section_model_id === identity.section_model_id
  if (identity.section_id) return call.section_id === identity.section_id
  if (identity.section_title) return call.section_title === identity.section_title
  return true
}

function buildPerformanceOptimizationHints(
  calls: DtpPerformanceSectionCall[],
): DtpPerformanceOptimizationHint[] {
  const hints: DtpPerformanceOptimizationHint[] = []
  const timeoutsBySection = new Map<string, Set<DtpPerformanceModelStageName>>()

  for (const call of calls) {
    if (call.payload.estimated_tokens > DTP_PERFORMANCE_LARGE_PAYLOAD_TOKEN_THRESHOLD) {
      hints.push({
        severity: "warning",
        type: "large_payload",
        section_model_id: call.section_model_id,
        section_title: call.section_title,
        message: `${call.stage} payload is about ${call.payload.estimated_tokens} tokens; consider section-level trimming or caching.`,
      })
    }
    if (call.status === "timeout") {
      hints.push({
        severity: "warning",
        type: "model_timeout",
        section_model_id: call.section_model_id,
        section_title: call.section_title,
        message: `${call.stage} timed out after ${call.duration_ms}ms.`,
      })
      if (call.section_model_id) {
        const stages = timeoutsBySection.get(call.section_model_id) ?? new Set<DtpPerformanceModelStageName>()
        stages.add(call.stage)
        timeoutsBySection.set(call.section_model_id, stages)
      }
    }
    if (call.fallback_used || call.status === "fallback") {
      hints.push({
        severity: "info",
        type: "fallback_used",
        section_model_id: call.section_model_id,
        section_title: call.section_title,
        message: `${call.stage} used deterministic fallback for this section.`,
      })
    }
    if (
      call.payload.rows_chars > 0 &&
      call.payload.table_html_chars + call.payload.cells_chars > call.payload.rows_chars * 5
    ) {
      hints.push({
        severity: "info",
        type: "redundant_table_payload",
        section_model_id: call.section_model_id,
        section_title: call.section_title,
        message: "table_html + cells payload is much larger than rows; this section is a good candidate for future payload compaction.",
      })
    }
  }

  for (const [sectionModelId, stages] of timeoutsBySection.entries()) {
    if (stages.has("model_relation_analysis") && stages.has("model_protocol_understanding")) {
      const call = calls.find((item) => item.section_model_id === sectionModelId)
      hints.push({
        severity: "warning",
        type: "double_phase_timeout",
        section_model_id: sectionModelId,
        section_title: call?.section_title,
        message: "Both relation analysis and protocol understanding timed out for this section; prioritize caching or section splitting here.",
      })
    }
  }

  return hints
}

export function createDtpDataGenerationPerformanceCollector(paths: DefaultPaths): DtpDataGenerationPerformanceCollector {
  const startedAt = new Date()
  const report: DtpDataGenerationPerformanceReport = {
    schema_version: DTP_PERFORMANCE_REPORT_SCHEMA_VERSION,
    workspace_root: paths.workspaceRoot,
    matrix_data_dir: paths.matrixDataDir,
    started_at: startedAt.toISOString(),
    ended_at: startedAt.toISOString(),
    duration_ms: 0,
    summary: {
      source_document_count: 0,
      section_count: 0,
      model_call_count: 0,
      timeout_count: 0,
      fallback_section_count: 0,
      generated_file_count: 0,
      max_payload_chars: 0,
      max_estimated_tokens: 0,
    },
    stages: [],
    section_calls: [],
    optimization_hints: [],
    warnings: [],
  }

  const collector: DtpDataGenerationPerformanceCollector = {
    async measureStage<T>(
      name: DtpPerformanceStageName,
      details: Record<string, unknown> | undefined,
      action: () => Promise<T> | T,
    ): Promise<T> {
      const started = new Date()
      const startedMs = Date.now()
      try {
        const result = await action()
        report.stages.push({
          name,
          started_at: started.toISOString(),
          ended_at: new Date().toISOString(),
          duration_ms: Date.now() - startedMs,
          status: "success",
          details,
        })
        return result
      } catch (error) {
        report.stages.push({
          name,
          started_at: started.toISOString(),
          ended_at: new Date().toISOString(),
          duration_ms: Date.now() - startedMs,
          status: isTimeoutError(error) ? "timeout" : "error",
          details,
          error: errorMessage(error),
        })
        throw error
      }
    },

    async measureModelCall<T>(
      stage: DtpPerformanceModelStageName,
      input: unknown,
      action: () => Promise<T> | T,
    ): Promise<T> {
      const started = new Date()
      const startedMs = Date.now()
      const identity = getPerformanceInputIdentity(input)
      try {
        const result = await action()
        const payload = buildPerformancePayloadMetrics(stage, input)
        report.section_calls.push({
          stage,
          ...identity,
          ...getPerformanceModelFallback(input),
          duration_ms: Date.now() - startedMs,
          status: "success",
          payload,
          fallback_used: false,
          warnings: [],
          started_at: started.toISOString(),
          ended_at: new Date().toISOString(),
        })
        return result
      } catch (error) {
        const payload = buildPerformancePayloadMetrics(stage, input)
        report.section_calls.push({
          stage,
          ...identity,
          ...getPerformanceModelFallback(input),
          duration_ms: Date.now() - startedMs,
          status: isTimeoutError(error) ? "timeout" : "error",
          payload,
          fallback_used: false,
          warnings: [errorMessage(error)],
          started_at: started.toISOString(),
          ended_at: new Date().toISOString(),
        })
        throw error
      }
    },

    recordFallback(stage: DtpPerformanceModelStageName, input: unknown, warnings: string[]): void {
      const existing = [...report.section_calls]
        .reverse()
        .find((call) => call.stage === stage && samePerformanceInputIdentity(call, input))
      if (existing) {
        existing.fallback_used = true
        existing.warnings = uniqueStrings([...existing.warnings, ...warnings])
        return
      }

      const now = new Date().toISOString()
      report.section_calls.push({
        stage,
        ...getPerformanceInputIdentity(input),
        ...getPerformanceModelFallback(input),
        duration_ms: 0,
        status: "fallback",
        payload: buildPerformancePayloadMetrics(stage, input),
        fallback_used: true,
        warnings: uniqueStrings(warnings),
        started_at: now,
        ended_at: now,
      })
    },

    finalize(summary): DtpDataGenerationPerformanceReport {
      const endedAt = new Date()
      report.ended_at = endedAt.toISOString()
      report.duration_ms = endedAt.getTime() - startedAt.getTime()
      report.summary = {
        source_document_count: summary.sourceDocumentCount ?? report.summary.source_document_count,
        section_count: summary.sectionCount ?? report.summary.section_count,
        model_call_count: report.section_calls.filter((call) => call.status !== "fallback").length,
        timeout_count: report.section_calls.filter((call) => call.status === "timeout").length,
        fallback_section_count: new Set(
          report.section_calls
            .filter((call) => call.fallback_used || call.status === "fallback")
            .map((call) => call.section_model_id ?? call.section_title ?? call.stage),
        ).size,
        generated_file_count: summary.generatedFileCount ?? report.summary.generated_file_count,
        max_payload_chars: Math.max(0, ...report.section_calls.map((call) => call.payload.payload_chars)),
        max_estimated_tokens: Math.max(0, ...report.section_calls.map((call) => call.payload.estimated_tokens)),
      }
      report.warnings = uniqueStrings(summary.warnings ?? report.warnings)
      report.optimization_hints = buildPerformanceOptimizationHints(report.section_calls)
      return report
    },

    write(outputFile: string): void {
      ensureDirectory(dirname(outputFile))
      writeFileSync(outputFile, `${JSON.stringify(report, null, 2)}\n`, "utf-8")
    },
  }

  return collector
}

function stripDuplicatedTableHtml(text: string): string {
  return text
    .replace(/<table\b[\s\S]*?<\/table>/gi, "\n[table supplied in the Tables field]\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function modelTableQueryTokens(queryText: string): string[] {
  const normalized = queryText
    .replace(/<[^>]+>/g, " ")
    .replace(/[\r\n\t]+/g, " ")
  const explicitTokens = Array.from(normalized.matchAll(
    /(?:TCY|TR|ID)[-_]?\d+[A-Za-z0-9_-]*|(?:表|附表)\s*[A-Za-z]?\d+(?:\.\d+)*(?:-\d+)?|W\d+|TITLE|SUM|CRC|ISO|SpaceWire|SPI|CAN[A-B]?|RS422|1553B/gi,
  )).map((match) => normalizeLookupText(match[0]))
  const phrases = normalized
    .split(/[，。；：、,.;:()（）\[\]【】<>《》\s]+/)
    .map((value) => normalizeLookupText(value))
    .filter((value) => value.length >= 3 && value.length <= 40)
  return uniqueStrings([...explicitTokens, ...phrases]).filter(Boolean)
}

function selectLargeModelTableRows(
  table: SectionProtocolRelationTableInput,
  queryText: string,
): number[] {
  const tokens = modelTableQueryTokens(queryText)
  const headerRows = new Set<number>([0])
  for (const cell of table.cells ?? []) {
    if (cell.is_header) headerRows.add(cell.row)
  }

  const scoredRows = table.rows.map((row, rowIndex) => {
    const rowText = normalizeLookupText(row.join(" "))
    const score = tokens.reduce((total, token) => total + (rowText.includes(token) ? Math.max(1, token.length) : 0), 0)
    return { rowIndex, score }
  })
  const selected = new Set<number>(headerRows)
  const matches = scoredRows
    .filter(({ rowIndex, score }) => !headerRows.has(rowIndex) && score > 0)
    .sort((left, right) => right.score - left.score || left.rowIndex - right.rowIndex)
    .slice(0, LARGE_MODEL_TABLE_MATCH_LIMIT)
  for (const match of matches) selected.add(match.rowIndex)

  if (!matches.length) {
    for (const { rowIndex } of scoredRows.filter(({ rowIndex }) => !headerRows.has(rowIndex)).slice(0, 3)) {
      selected.add(rowIndex)
    }
  }

  // A selected row may inherit a merged label from an earlier row. Keep that anchor row as evidence.
  for (const cell of table.cells ?? []) {
    const rowEnd = cell.row + (cell.rowspan ?? 1) - 1
    if (rowEnd > cell.row && Array.from(selected).some((row) => row >= cell.row && row <= rowEnd)) {
      selected.add(cell.row)
    }
  }
  return Array.from(selected).filter((row) => row >= 0 && row < table.rows.length).sort((a, b) => a - b)
}

function selectTableHtmlRows(tableHtml: string, rowIndexes: number[]): string {
  const openingTag = tableHtml.match(/<table\b[^>]*>/i)?.[0] ?? "<table>"
  const rows = Array.from(tableHtml.matchAll(/<tr\b[\s\S]*?<\/tr>/gi)).map((match) => match[0])
  const selectedRows = rowIndexes.map((index) => rows[index]).filter((row): row is string => Boolean(row))
  return `${openingTag}${selectedRows.join("")}</table>`
}

function compactProtocolTablesForModel(
  tables: SectionProtocolRelationTableInput[],
  queryText = "",
): unknown[] {
  return tables.map((table) => {
    if (table.payload_mode) {
      const preparedTable = {
        id: table.id,
        caption: table.caption,
        ordinal: table.ordinal,
        is_frame_format: table.is_frame_format,
        aliases: table.aliases,
        topic: table.topic,
        payload_mode: table.payload_mode,
        original_row_count: table.original_row_count ?? table.rows.length,
        selected_row_indexes: table.selected_row_indexes ?? table.rows.map((_, index) => index),
      }
      return table.table_html
        ? { ...preparedTable, table_html: table.table_html }
        : { ...preparedTable, headers: table.headers, rows: table.rows }
    }
    const tableChars = table.table_html?.length ?? JSON.stringify(table.rows).length
    const cellCount = table.cells?.length ?? table.rows.reduce((total, row) => total + row.length, 0)
    const keepComplete = table.is_frame_format || (
      table.rows.length <= FULL_MODEL_TABLE_MAX_ROWS &&
      cellCount <= FULL_MODEL_TABLE_MAX_CELLS &&
      tableChars <= FULL_MODEL_TABLE_MAX_CHARS
    )
    const selectedRowIndexes = keepComplete
      ? table.rows.map((_, index) => index)
      : selectLargeModelTableRows(table, queryText)
    const modelTable = {
      id: table.id,
      caption: table.caption,
      ordinal: table.ordinal,
      is_frame_format: table.is_frame_format,
      aliases: table.aliases,
      topic: table.topic,
      payload_mode: keepComplete ? "complete" : "header_and_matched_rows",
      original_row_count: table.rows.length,
      selected_row_indexes: selectedRowIndexes,
    }
    if (table.table_html) {
      return {
        ...modelTable,
        table_html: keepComplete ? table.table_html : selectTableHtmlRows(table.table_html, selectedRowIndexes),
      }
    }
    return {
      ...modelTable,
      headers: table.headers,
      rows: selectedRowIndexes.map((index) => table.rows[index]).filter(Boolean),
    }
  })
}

async function analyzeSectionProtocolRelationsByModel(
  client: OpencodeClient,
  context: ToolContext,
  input: SectionProtocolRelationModelInput,
): Promise<unknown[] | null> {
  const modelTables = compactProtocolTablesForModel(
    input.tables,
    [input.section_title, input.input_flow_text, input.output_flow_text, input.section_text].join("\n"),
  )
  const response = await callDtpDataModelJson<{ relations?: unknown[] }>(
    client,
    context,
    [
      "You analyze DTP hardware-interface protocol sections for test data file generation.",
      "Use the full section context, input-flow/output-flow text, and the supplied structure-preserving table evidence.",
      "Decide which tables are frame-format tables, which tables are supporting explanations, and which tables are row dictionaries that expand into one data file per row.",
      "Do not generate byte content. Do not invent table ids. Return exactly one JSON object and no markdown.",
    ].join("\n"),
    [
      `Section title: ${input.section_title}`,
      `Section id: ${input.section_id ?? ""}`,
      `Input flow text:\n${stripDuplicatedTableHtml(input.input_flow_text) || "(empty)"}`,
      `Output flow text:\n${stripDuplicatedTableHtml(input.output_flow_text) || "(empty)"}`,
      `Full section text:\n${stripDuplicatedTableHtml(input.section_text) || "(empty)"}`,
      `Tables:\n${JSON.stringify(modelTables)}`,
      `Frame-format table ids detected by rules: ${JSON.stringify(input.primary_table_ids)}`,
      `Support table ids detected by rules: ${JSON.stringify(input.support_table_ids)}`,
      `Heuristic relations for fallback: ${JSON.stringify(input.heuristic_relations)}`,
      "Return JSON in this exact shape:",
      JSON.stringify({
        relations: [
          {
            frame_table_id: "table-id-from-input",
            dictionary_table_id: "optional-table-id-from-input",
            generation_mode: "frame_file or one_file_per_dictionary_row",
            preferred_name: "optional flow-derived file name; dictionary row names override this",
            flow_direction: "input or output or unknown",
            source_section: "optional section title from input",
            source_flow_heading: "optional 输入流 or 输出流",
            file_name_field: "optional dictionary file-name column header",
            data_code_field: "optional dictionary code-word column header",
            field_value_plan: [
              {
                field_name: "W0",
                value: "00",
                source_table_id: "optional-table-id-from-input",
                source_text: "optional evidence text",
                confidence: 0.0,
                reasoning: ["why this field gets this byte value"],
              },
            ],
            should_generate_frame_table_file: true,
            checksum_rule: DEFAULT_CHECKSUM_RULE,
            confidence: 0.0,
            reasoning: ["short reason in Chinese or English"],
          },
        ],
      }),
      "Guidance:",
      "- Prefer table_html when present; it preserves empty cells and merged-cell structure. Rows/cells are supplied only as a fallback when table_html is unavailable.",
      "- Small tables and frame-format tables are complete. Large support/dictionary tables contain headers plus query-matched rows; selected_row_indexes map them back to the source table.",
      "- A table that defines TITLE/W0/SUM or byte layout is usually a frame_table_id.",
      "- A later table that explains W0-Wn processing or parameter meaning is support only; do not generate it as a standalone file.",
      "- A later table with command names plus W0/W1/W2/W3 or code words is a dictionary_table_id; use one_file_per_dictionary_row.",
      "- Prefer input-flow/output-flow names for frame_file outputs, but command/dictionary row names take priority for expanded files.",
      "- Set flow_direction from the section context: input-flow files go to 输入流, output-flow files go to 输出流.",
      "- If support tables or section text define concrete W0/W1/... byte values, include them in field_value_plan with evidence.",
      "- Do not fill uncertain fields creatively; omit them from field_value_plan so code can use 00 fallback.",
      "- SUM/checksum is computed by code later; keep checksum_rule only as a rule label.",
    ].join("\n\n"),
    input.model_timeout_ms ?? getDtpModelSectionTimeoutMs(),
    input.model_input_metrics,
  )

  return response?.relations ?? null
}

async function understandSectionProtocolsByModel(
  client: OpencodeClient,
  context: ToolContext,
  input: DtpProtocolContextPackage,
): Promise<unknown | null> {
  const modelTables = compactProtocolTablesForModel(
    input.tables,
    [
      input.section_title,
      input.interface_context_text,
      input.flow_blocks.input.text,
      input.flow_blocks.output.text,
      input.section_text,
      input.referenced_context_text ?? "",
      JSON.stringify(input.reference_evidence ?? []),
    ].join("\n"),
  )
  const inputFlowBlock = {
    ...input.flow_blocks.input,
    text: stripDuplicatedTableHtml(input.flow_blocks.input.text),
  }
  const outputFlowBlock = {
    ...input.flow_blocks.output,
    text: stripDuplicatedTableHtml(input.flow_blocks.output.text),
  }
  return callDtpDataModelJson<unknown>(
    client,
    context,
    [
      "You understand DTP protocol definitions for deterministic test-data file generation.",
      "The input is one section-level protocol context package. Related frame tables, support tables, dictionary tables, input-flow text, and output-flow text are provided together.",
      "Keep bus-specific packet semantics separate. In particular, SPI ADDRESS/LENGTH/DATA/SUM is not a CAN arbitration/control/TITLE/W layout.",
      "Treat SpaceWire memory-mapped register addresses, reset values, and target IDs as transport metadata, not packet bytes. Preserve large W-range upload-block tables as fixed block layouts.",
      "Return standardized protocol definitions only. Do not generate .txt file content. Do not invent table ids. Return exactly one JSON object and no markdown.",
    ].join("\n"),
    [
      `Section title: ${input.section_title}`,
      `Section id: ${input.section_id ?? ""}`,
      `Section path: ${JSON.stringify(input.section_path ?? [])}`,
      `Interface-scope context:\n${input.interface_context_text || "(empty)"}`,
      `Input flow block:\n${JSON.stringify(inputFlowBlock)}`,
      `Output flow block:\n${JSON.stringify(outputFlowBlock)}`,
      `Full section text:\n${stripDuplicatedTableHtml(input.section_text) || "(empty)"}`,
      `Explicitly referenced context:\n${stripDuplicatedTableHtml(input.referenced_context_text ?? "") || "(empty)"}`,
      `Resolved reference evidence:\n${JSON.stringify(input.reference_evidence ?? [])}`,
      `Tables:\n${JSON.stringify(modelTables)}`,
      `Document-level bus profiles:\n${JSON.stringify(input.bus_profiles)}`,
      `Primary frame table ids detected by code: ${JSON.stringify(input.primary_table_ids)}`,
      `Support table ids detected by code: ${JSON.stringify(input.support_table_ids)}`,
      `Heuristic relations for reference only: ${JSON.stringify(input.heuristic_relations)}`,
      "Return JSON in this exact shape:",
      JSON.stringify({
        status: "complete or need_more_evidence",
        requests: [
          {
            table_id: "existing table id from the supplied context",
            row_keys: ["exact command name or row identifier"],
            fields: ["W0", "SUM"],
          },
        ],
        protocols: [
          {
            protocol_id: "stable-id",
            source_section: "section title",
            flow_direction: "input or output or unknown",
            base_file_name: "file name without .txt",
            generation_mode: "single_file or expand_variants or one_file_per_dictionary_row or skip",
            frames: [
              {
                frame_id: "frame-1",
                sequence: 1,
                source_table_id: "frame table id from input",
                byte_layout: ["86", "04", "23", "06", "W0", "W1", "SUM"],
                field_layout: [
                  { name: "ARBITRATION", role: "arbitration", byte_offset: 0, byte_length: 1, default_value: "86" },
                  { name: "CONTROL", role: "control", byte_offset: 1, byte_length: 1, default_value: "04" },
                  { name: "TITLE", role: "title", byte_offset: 2, byte_length: 1, default_value: "23" },
                  { name: "W0", role: "data", byte_offset: 4, byte_length: 1, default_value: "00" },
                  { name: "SUM", role: "checksum", byte_offset: 6, byte_length: 1 },
                ],
                checksum: {
                  type: "sum_low8 or crc or none or unknown",
                  start: "TITLE",
                  end: "BEFORE_SUM",
                  expression: "optional checksum rule text",
                },
              },
            ],
            bus_context: {
              bus_type: "CAN or SPI or SpaceWire or RS422 or UART or 1553B or unknown",
              interface_level: "primary or secondary or unknown",
              interface_id: "optional interface requirement id such as IF-CAN0-001",
              interface_name: "optional local interface heading",
              profile_scope: "interface or section or document",
              controller: "SJA1000 or SJA1000T or unknown",
              controller_family: "SJA1000 or unknown",
              mode: "BasicCAN or PeliCAN or unknown",
              frame_format: "standard or extended or unknown",
              frame_buffer_layout: "business-payload or sja1000-basiccan or sja1000-pelican or unknown",
              frame_info_byte: "optional explicit PeliCAN frame-information byte if the document provides it",
              frame_information: {
                apply_to_case_data: true,
                strategy: "derive_from_ff_rtr_dlc",
              },
              evidence: ["short evidence text"],
              confidence: 0.0,
              warnings: [],
            },
            variables: [
              {
                name: "station_address",
                display_name: "站地址",
                type: "uint8 or bytes or unknown",
                default_value: "optional default byte",
                options: [{ value: "0C", label: "station name", source: "evidence text" }],
                source_table_id: "optional station-address table id",
                source_text: "optional evidence text",
              },
            ],
            frame_envelope: {
              type: "fixed_prefix",
              bytes: ["bytes parsed from the explicitly documented prefix, for example 0010H -> 00,10"],
              applies_per_frame: true,
              position: "before_frame",
              raw_value: "the exact hexadecimal literal from evidence",
              byte_order: "document_order",
              business_frame_length: 10,
              wire_frame_length: 12,
              directions: ["send", "receive"],
              confidence: 0.0,
              source_text: "exact interface-envelope evidence",
            },
            fields: [
              {
                name: "W0",
                type: "fixed or enum or bitfield or unknown",
                value: "00",
                options: [
                  {
                    value: "01",
                    label: "business meaning",
                    source: "evidence text",
                  },
                ],
                source_table_id: "optional source table id from input",
                source_text: "optional evidence text",
                confidence: 0.0,
                warnings: [],
              },
            ],
            evidence: ["table captions or short evidence"],
            warnings: [],
            confidence: 0.0,
          },
        ],
        selector_relations: [
          {
            relation_id: "stable relation id",
            selector_name: "站地址",
            selector_aliases: ["节点地址", "终端地址"],
            selector_type: "uint8 or integer or string",
            protocol_family: "telemetry or poll or response or command or unknown",
            mappings: [
              {
                selector_value: "01H",
                target_protocol_id: "optional protocol id returned above",
                target_frame_count: 4,
                evidence: ["table id or short source text"],
              },
            ],
            evidence: ["table ids or short source text"],
            confidence: 0.0,
            warnings: [],
          },
        ],
        non_generated_tables: [
          {
            table_id: "table id from input",
            reason: "why this table is support-only or reused",
          },
        ],
        warnings: [],
      }),
      "Guidance:",
      "- If a required support row is not present, return status=need_more_evidence and request only existing table ids plus exact row keys or fields. Do not guess the missing values.",
      "- Return status=complete with an empty requests array when the supplied evidence is sufficient.",
      "- Prefer table_html when present; it preserves empty cells and merged-cell structure. Rows/cells are supplied only as a fallback when table_html is unavailable.",
      "- Small tables and frame-format tables are complete. Large support/dictionary tables contain headers plus query-matched rows; selected_row_indexes map them back to the source table.",
      "- Resolved reference evidence records exact source/target ids and advisory semantic roles. Use it to combine frame_layout, field_dictionary, payload_definition, selector, checksum_definition, and related_transport evidence; do not treat every referenced table as a standalone protocol.",
      "- Explicit reference edges have priority over merely adjacent or name-similar protocols. If referenced evidence conflicts with the local protocol family or bus/interface scope, keep the relationship unresolved and warn instead of silently copying bytes.",
      "- Treat the section as a whole. Associated tables must be understood together.",
      "- A frame table can be reused by several support/data-block tables. Do not mark reused frame tables as standalone generated files unless the section clearly says so.",
      "- Tables that explain W0-Wn fields are support tables; they usually should not generate independent files.",
      "- Dictionary tables with command names/codes usually expand to one file per row, named by command name.",
      "- File flow must come from input-flow/output-flow context. Use unknown if evidence is insufficient.",
      "- Determine CAN interface scope from the local section path, interface requirement id, heading, and interface-scope context. Keep primary and secondary CAN definitions separate even when protocol names are identical.",
      "- Treat standalone CANA/CANB as a case-step compatibility alias, not as document evidence for changing an extracted protocol's interface scope.",
      "- If the section describes CAN controller details, identify bus_context. Distinguish business-payload files from CAN-controller frame-buffer layouts.",
      "- Document-level bus profiles may be inherited only from the same compatible interface scope. Never apply a primary-CAN SJA1000/PeliCAN profile to a secondary-CAN protocol.",
      "- If document-level bus profiles conflict and the local section cannot select one, keep controller/mode unknown and warn instead of guessing.",
      "- Only mark frame_buffer_layout as sja1000-pelican/basiccan when the evidence is about SJA1000 send/receive frame buffer layout. If the table is a business packet with TITLE/W0/SUM, use business-payload even when CAN is mentioned.",
      "- For SJA1000 PeliCAN frame-buffer layouts, include frame_info_byte only when it is explicitly documented or directly derivable from the documented frame-info/control byte. Do not invent it.",
      "- Normalize SJA1000T to controller_family SJA1000. For CAN protocols using SJA1000/SJA1000T in PeliCAN mode, set frame_information.apply_to_case_data=true and strategy=derive_from_ff_rtr_dlc.",
      "- When a compact CAN control byte contains ID2-ID0, RTR and DLC, describe RTR and DLC as bit fields in field_layout. Use bit_offset 4/bit_length 1 for RTR and bit_offset 0/bit_length 4 for DLC when that layout is explicit.",
      "- When a multi-frame protocol table identifies a frame sequence/index byte, name it FRAME_SEQUENCE with role=sequence and preserve its byte offset and per-frame default value.",
      "- Preserve expressions such as 80H+站地址 and 20H+站地址 as dynamic field semantics. Do not replace them with guessed fixed bytes. The table-derived physical byte offset remains authoritative.",
      "- When a station-address dictionary exists in the same interface context, return it as variables[].options. Code will resolve the selected station and evaluate the dynamic byte deterministically.",
      "- When a selector such as station address, node type, channel, mode, or device identity determines which protocol layout applies, return selector_relations. Map each selector value to an explicit protocol_id when possible and also include target_frame_count when the evidence states it.",
      "- Do not invent selector relationships from general bus knowledge. Use only relationships stated by a table or by section prose. Conflicting or incomplete mappings must remain unresolved and carry warnings.",
      "- Return frame_envelope only for an explicitly documented per-frame transport prefix in section prose, notes, remarks, or referenced interface evidence. Extract the hexadecimal value dynamically; never assume 0008H or any project-specific value.",
      "- Preserve the prefix in document byte order (for example 0010H becomes bytes 00,10). Include the exact raw_value, source_text, business-frame length, wire-frame length, direction, and confidence when stated.",
      "- A fixed FPGA/interface prefix is separate from the business frame and must not be confused with SJA1000 PeliCAN Frame Information. The prefix does not participate in business-frame field offsets or checksums unless the document explicitly says otherwise.",
      "- For an SPI table with ADDRESS/LENGTH/DATA0...DATAn/SUM, preserve that order, set bus_type=SPI, use address/length/data/checksum roles, and set checksum start=ADDRESS and end=BEFORE_SUM.",
      "- SPI ADDRESS is one byte composed of station-address high bits and message-type low bits when the section explicitly defines that bit layout. Do not output SPI register addresses as packet bytes.",
      "- SPI LENGTH denotes the number of DATA bytes unless the document explicitly defines another meaning; it participates in the SPI SUM range.",
      "- For SpaceWire FPGA memory-mapped transfers, register addresses, reset acknowledgements, and destination IDs are control metadata unless the document explicitly places them in a packet table.",
      "- Preserve W0~Wn byte ranges in SpaceWire upload-block tables. A 720-byte start/middle/check block family is one protocol, not three unrelated files.",
      "- Keep start, middle, and check block types distinct. Program payload chunking, address advancement, length fields, and deterministic checksums are performed by code from block_layout.",
      "- If a secondary-node SpaceWire upload references a CAN table, record the relationship as unresolved unless the document explicitly defines the SpaceWire block mapping. Never copy CAN transport bytes into SpaceWire by assumption.",
      "- If field values are uncertain, mark the field unknown instead of inventing bytes.",
      "- Use frames[] for both single-frame and multi-frame protocols. One frame means one array item; never return byte_layouts.",
      "- field_layout must identify semantic roles and byte offsets when the source provides them. Do not guess a TITLE position from a fixed byte without evidence.",
      "- SUM/CRC will be recomputed by code later. Describe the checksum rule, but do not rely on a computed checksum byte.",
    ].join("\n\n"),
    input.model_timeout_ms ?? getDtpProtocolUnderstandingTimeoutMs(),
    input.model_input_metrics,
  )
}

async function reviseProtocolDefinitionsByModel(
  client: OpencodeClient,
  context: ToolContext,
  input: DtpProtocolRetryContext,
): Promise<unknown | null> {
  return callDtpDataModelJson<unknown>(
    client,
    context,
    [
      "You revise DTP protocol definitions after deterministic data-file quality checks.",
      "The input is dtp-protocol-retry-context.json. It contains quality issues, affected protocol definitions, affected files, and repair guidance.",
      "Return corrected protocol definition fragments only for affected protocols. Do not generate .txt file content. Do not invent protocol ids or table ids. Return exactly one JSON object and no markdown.",
    ].join("\n"),
    [
      `Retry context:\n${JSON.stringify(input)}`,
      "Return JSON in this exact shape:",
      JSON.stringify({
        protocols: [
          {
            protocol_id: "existing-protocol-id-from-retry-context",
            source_section: "optional corrected section title",
            flow_direction: "input or output or unknown",
            base_file_name: "corrected file name without .txt",
            generation_mode: "single_file or expand_variants or one_file_per_dictionary_row or skip",
            frames: [
              {
                frame_id: "frame-1",
                sequence: 1,
                source_table_id: "existing frame table id",
                byte_layout: ["86", "04", "W0", "SUM"],
                field_layout: [
                  { name: "W0", role: "data", byte_offset: 2, byte_length: 1, default_value: "00" },
                  { name: "SUM", role: "checksum", byte_offset: 3, byte_length: 1 },
                ],
                checksum: {
                  type: "sum_low8 or crc or none or unknown",
                  start: "TITLE",
                  end: "BEFORE_SUM",
                  expression: "optional checksum rule text",
                },
              },
            ],
            bus_context: {
              bus_type: "CAN or SPI or SpaceWire or RS422 or UART or 1553B or unknown",
              controller: "SJA1000 or SJA1000T or unknown",
              controller_family: "SJA1000 or unknown",
              mode: "BasicCAN or PeliCAN or unknown",
              frame_format: "standard or extended or unknown",
              frame_buffer_layout: "business-payload or sja1000-basiccan or sja1000-pelican or unknown",
              frame_info_byte: "optional explicit PeliCAN frame-information byte",
              frame_information: {
                apply_to_case_data: true,
                strategy: "derive_from_ff_rtr_dlc",
              },
              evidence: ["short evidence text"],
              confidence: 0.0,
              warnings: [],
            },
            fields: [
              {
                name: "W0",
                type: "fixed or enum or bitfield or unknown",
                value: "00",
                options: [
                  {
                    value: "01",
                    label: "business meaning",
                    source: "evidence text from retry context",
                  },
                ],
                source_table_id: "optional existing source table id",
                source_text: "optional evidence text",
                confidence: 0.0,
                warnings: [],
              },
            ],
            variants: [
              {
                name: "optional variant file suffix",
                fields: [
                  {
                    name: "W0",
                    type: "fixed",
                    value: "01",
                    source_text: "evidence text",
                  },
                ],
                evidence: ["why this variant should exist"],
                warnings: [],
                confidence: 0.0,
              },
            ],
            evidence: ["quality issue and source evidence used"],
            warnings: [],
            confidence: 0.0,
          },
        ],
        warnings: [],
      }),
      "Guidance:",
      "- Only revise affected protocols listed in retry_context.affected_protocols.",
      "- Prefer fixing flow_direction, frames[].byte_layout, frames[].field_layout, missing W0-Wn fields, variant expansion, or file names.",
      "- Preserve or correct bus_context when CAN/SJA1000/BasicCAN/PeliCAN evidence affects byte layout.",
      "- Do not apply SJA1000/PeliCAN extra frame-info byte to business-payload protocols with TITLE/W0/SUM.",
      "- If evidence is insufficient for a field, leave it unknown or omit it; final code may use 00 fallback with warning after retries are exhausted.",
      "- SUM/CRC is computed by code. Do not include a manually calculated checksum byte as a field value unless it is a literal byte in the frame layout.",
    ].join("\n\n"),
  )
}

function projectEvidenceQueryTerms(value: string): string[] {
  const explicit = value.match(/TITLE|SUM|CRC|DLC|RTR|CAN[A-Z]?|W\d+|仲裁场|控制场|校验和|数据块|指令|遥测|遥控/gi) ?? []
  const phrases = value.match(/[\u4e00-\u9fff]{2,12}/g) ?? []
  return uniqueStrings([...explicit, ...phrases]).filter((item) => item.length >= 2)
}

function scoreProjectEvidence(text: string, query: string, terms: string[]): number {
  const normalizedText = normalizeProtocolMatchText(text)
  const normalizedQuery = normalizeProtocolMatchText(query)
  let score = longestCommonSubstringLength(normalizedText, normalizedQuery)
  const headingCore = text.split("\n", 1)[0]
    .replace(/^#{2,6}\s*/, "")
    .replace(/^\d+(?:\.\d+)*\s*/, "")
    .replace(/相关数据流.*$/, "")
    .trim()
  const normalizedHeadingCore = normalizeProtocolMatchText(headingCore)
  if (normalizedHeadingCore.length >= 4 && normalizedQuery.includes(normalizedHeadingCore)) {
    score += 1_000 + normalizedHeadingCore.length
  }
  for (const term of terms) {
    if (text.toLowerCase().includes(term.toLowerCase())) score += Math.min(12, term.length * 2)
  }
  if (/TITLE|SUM|CRC|仲裁场|控制场|数据格式|帧格式/i.test(text)) score += 3
  return score
}


function selectProjectFieldValueEvidence(
  knowledgeIndex: ProjectKnowledgeIndex,
  query: string,
): CaseStepDataPlanningInput["project_value_evidence"] {
  const terms = projectEvidenceQueryTerms(query)
  const candidates: CaseStepDataPlanningInput["project_value_evidence"] = [
    ...knowledgeIndex.snippets.map((snippet) => ({
      id: snippet.id,
      kind: "snippet" as const,
      text: snippet.text,
      score: scoreProjectEvidence(snippet.text, query, terms),
    })),
    ...knowledgeIndex.tables.map((table) => {
      const text = [table.caption, table.table_html ?? table.rows.map((row) => row.join(" | ")).join("\n")]
        .filter(Boolean)
        .join("\n")
      return {
        id: table.id,
        kind: "table" as const,
        text,
        score: scoreProjectEvidence(text, query, terms),
      }
    }),
  ]
    .filter((item) => item.text.trim() && item.score >= 6)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))

  const selected: CaseStepDataPlanningInput["project_value_evidence"] = []
  let selectedChars = 0
  const maxChars = DTP_CASE_STEP_PROJECT_EVIDENCE_MAX_CHARS
  for (const candidate of candidates) {
    if (selected.length >= 4) break
    const remaining = maxChars - selectedChars
    if (remaining <= 0) break
    const text = candidate.text.length > remaining ? candidate.text.slice(0, remaining) : candidate.text
    selected.push({ ...candidate, text })
    selectedChars += text.length
  }
  return selected
}

async function planCaseStepDataByModel(
  client: OpencodeClient,
  context: ToolContext,
  input: CaseStepDataPlanningInput,
): Promise<unknown | null> {
  return callDtpDataModelJson<unknown>(
    client,
    context,
    [
      "你负责为一个 DTP 测试用例步骤制定结构化的数据文件生成与关键字实参解析计划。",
      "仅将 step_desc 作为该步骤协议意图和故障意图的权威描述。",
      "必须遵循 model_fallback.profile 中的总线及接口约束；只要提供了 model_fallback.candidate_protocols，就应优先从候选协议中选择。",
      "model_fallback.evidence、关键字元数据和其他局部证据只能用于补充确定性规范数据尚未解析出的信息。",
      "上游参数中只有时间值可信，其他参数都需要推导。只返回一个 JSON 对象，不要输出 Markdown 或解释性文字。",
    ].join("\n"),
    [
      `规划输入：\n${JSON.stringify(input)}`,
      "必须严格按以下 JSON 结构返回；字段名和枚举值不得翻译：",
      JSON.stringify({
        protocol_id: "可选；能够确定时填写候选中的规范协议 ID",
        protocol_name: "协议语义名称或数据文件名称",
        payload_length_bytes: 15,
        related_message_length_bytes: "可选；仅表示应答等关系协议所关联消息的业务长度",
        flow_direction: "input | output | unknown",
        bus: "可选；CANA | CANB | SPI | SpaceWire | other",
        operation: "可选；memory_write | bus_send | bus_receive",
        target_address: "可选；不带0x和H后缀的大写十六进制目标地址",
        protocol_entity: "可选；从step_desc识别的业务协议实体",
        artifact_scope: "可选；single_block | full_package",
        selected_block: "可选；start-block | middle-block | check-block",
        base_file_name: "可选；候选中已有的基础 .txt 文件名",
        base_file_path: "可选；候选中面向 Robot 的基础文件路径",
        base_bytes: [["86", "04", "00", "10", "01", "11"]],
        variant_type: "correct | title_error | checksum_error | arbitration_error | control_error | length_error | field_error | unknown",
        mutations: [{ field: "TITLE", frame_index: 1, byte_index: 2, operation: "replace_with_invalid_value", value: "01" }],
        sequence_operations: [{ operation: "drop_frame", frame_index: 2 }],
        checksum_policy: "preserve | recalculate_correctly | make_incorrect | none",
        argument_values: { "${para1}": "推导出的业务值", "${para3}": "1" },
        evidence_ids: ["table:source-table-id", "relation:selector-relation-id"],
        confidence: 0.0,
        warnings: [],
      }),
      "规则：",
      "- confirmation-tests 中的数据文件名只是一条提示，该文件当时可能尚未实际存在。",
      "- 将 model_fallback.profile.instructions 视为总线和接口专用约束。候选中存在匹配协议时，必须返回该候选的 protocol_id。",
      "- 当前版本禁止编译新的临时协议。如果所有候选均与步骤冲突或证据不足，应返回 unknown 并添加 warning。",
      "- 必须保留候选协议 field_layout 中的字节偏移。模型可以选择字段和字段值，但不得替换规范协议的物理布局。",
      "- 识别规范协议。project_value_evidence 只能用于解析 W0-Wn 或其他可变字段值，不得借此重新定义规范帧布局。",
      "- 如果 step_desc 明确给出 10 字节、15 字节等业务协议长度，必须保留其语义。payload_length_bytes 表示当前协议消息长度，不是单帧 CAN DLC。",
      "- 对“15字节遥控指令应答”这类表述，15字节描述被应答的遥控指令，应写入 related_message_length_bytes，不得当作应答帧自身长度；应答帧物理长度以候选协议 wire_length 为准。",
      "- 如果 step_desc 没有明确给出 N 字节协议长度，则省略 payload_length_bytes；不得根据 CAN DLC、帧字节数或 W 字段数量推导它。",
      "- 规范证据能够确定 protocol_id 时必须返回它。不得把 10 字节遥控指令和 15 字节遥控指令等同名但不同的协议合并成通用名称。",
      "- 已解析出的 W0-Wn 或其他可变数据字段值，必须通过 operation=replace 的 mutation 返回，并填写明确的两位十六进制值。",
      "- 保留 step_desc 中每一个明确字段赋值，将其表示为 replace mutation，包括 TITLE=00H、W1=01H 等正常赋值。",
      "- step_desc 已排除括号中的原始十六进制帧示例。应根据语义描述判断意图，不得根据诊断帧示例反向构造 mutation。",
      "- base_bytes 仅作为辅助证据。确定性代码会从规范协议重建完整帧，不允许 base_bytes 替换规范帧。",
      "- frame_index 从 1 开始。帧序列故障必须使用 drop_frame、repeat_frame、swap_frames 或 append_frame，不要重建整组报文行。",
      "- TITLE 错误且 SUM 正确表示先修改 TITLE，再重新计算 SUM；SUM 错误表示其他字段保持正确，并故意制造错误 SUM。",
      "- 步骤只写错误而没有指定错误字段时，不得任意猜测错误目标；只有相关证据能唯一确定时才补充变异，否则保留 unknown 并说明缺少的信息。SPI 发送动作不等同于文档输入流，必须区分指令与应答。",
      "- 候选协议必须对应步骤的业务实体。不能因帧结构相似而用上行数据块或辅助数据包代替星务时间广播；没有合适候选时不要返回不相关的 protocol_id，应返回 unknown 并说明证据不足，不得编造新的协议。",
      "- 对包含 SUM 的动态协议，正常报文和所有非 SUM 故障都使用 recalculate_correctly。只有目标故障本身是 SUM 错误时才使用 make_incorrect，不得保留占位校验和。",
      "- 不要自行输出 SJA1000/PeliCAN Frame Information 字节。规范总线元数据要求时，确定性代码会在字段变异和校验处理完成后添加。",
      "- 对 SpaceWire 程序上注数据块，必须选择规范 SpaceWire 块协议；步骤明确起始块、中间块或校验块时，返回 single_block 和对应 selected_block。",
      "- 非块协议不得返回 artifact_scope 或 selected_block；即使返回，确定性校验也会忽略。",
      "- target_address 是测试工具的写入目标地址，不得用它覆盖协议块内部的 START_ADDRESS。",
      "- 模型只能补全结构化意图和选择已提供候选；最终块字节与 ISO/SUM/CRC 仍由确定性 Writer 生成。",
      "- 如果根据现有证据无法解析某个 W0-Wn 变量值，应保持未解析；确定性代码会使用 00 并记录 warning。",
      "- 证据不足时使用 unknown 并添加 warning，不得编造字节。",
    ].join("\n\n"),
  )
}

async function reviseCaseStepDataPlanByModel(
  client: OpencodeClient,
  context: ToolContext,
  input: CaseStepDataPlanRetryInput,
): Promise<unknown | null> {
  return callDtpDataModelJson<unknown>(
    client,
    context,
    [
      "你负责在确定性参数检查和数据质量检查失败后，局部修正一个 DTP 用例步骤的数据生成计划。",
      "只修改解决已提供问题所必需的字段。返回一个完整的修正计划 JSON，不要输出 Markdown 或解释性文字。",
      "对于包含 SUM 的协议，正常报文和非 SUM 故障必须使用 recalculate_correctly；只有目标故障本身是 SUM 错误时才使用 make_incorrect。",
    ].join("\n"),
    `重试输入：\n${JSON.stringify(compactCaseStepRetryInput(input))}\n\n返回与 current_plan 完全相同的 JSON 字段结构，字段名和枚举值不得翻译。`,
    getDtpCaseStepRetryTimeoutMs(),
  )
}

export function createDtpDataModelHooks(client?: OpencodeClient | null, context?: ToolContext): DtpDataModelHooks | null {
  if (!client || !context) return null

  return {
    analyzeSectionProtocolRelations: (input) => analyzeSectionProtocolRelationsByModel(client, context, input),
    understandSectionProtocols: (input) => understandSectionProtocolsByModel(client, context, input),
    reviseProtocolDefinitions: (input) => reviseProtocolDefinitionsByModel(client, context, input),
    planCaseStepData: (input) => planCaseStepDataByModel(client, context, input),
    reviseCaseStepDataPlan: (input) => reviseCaseStepDataPlanByModel(client, context, input),
  }
}

function supportTablesForRelation(tables: ProjectKnowledgeTable[], relation: SectionProtocolRelation): ProjectKnowledgeTable[] {
  const frameIndex = tables.findIndex((table) => table.id === relation.frame_table_id)
  if (frameIndex < 0) return []
  const nextFrameIndex = tables.findIndex((table, index) => index > frameIndex && isFrameFormatTable(table))
  const end = nextFrameIndex >= 0 ? nextFrameIndex : tables.length
  const supportTables = tables
    .slice(frameIndex + 1, end)
    .filter(
      (table) =>
        !isFrameFormatTable(table) &&
        (relation.generation_mode === "frame_file" || table.id !== relation.dictionary_table_id),
    )

  if (relation.generation_mode !== "frame_file") return supportTables

  const preferredSupportIds = uniqueStrings([
    relation.dictionary_table_id,
    ...(relation.field_value_plan ?? []).map((item) => item.source_table_id),
  ].filter((id): id is string => Boolean(id)))
  if (!preferredSupportIds.length) return supportTables

  const preferredSupports = supportTables.filter((table) => preferredSupportIds.includes(table.id))
  return [...preferredSupports, ...supportTables.filter((table) => !preferredSupportIds.includes(table.id))]
}

function supportTableDefinesFrameDataBlock(table: ProjectKnowledgeTable): boolean {
  const fields = extractDataValuesFromTable(table)
  return fields.has("W0") && fields.has("W1") && fields.size >= 3
}

function cleanGeneratedDataFileBaseName(value: string | undefined): string {
  const cleaned = sanitizeReadableFileBaseName(value)
    .replace(/^(?:\u9644\u8868|\u8868\u683c|\u8868)\s*[A-Za-z]?\s*[-\uff0d]?\s*\d+(?:\.\d+)*(?:\s*[-\uff0d]\s*\d+)?\s*/i, "")
    .replace(/(?:[,，;；\s]+D\d(?:D\d)*\s*(?:=|[-:：]).*)$/i, "")
    .replace(/[;；,，]\s*(?:D\d)+\s*[-:\uff1a].*$/i, "")
    .replace(/(?:D\d)+\s*(?:=|[-:\uff1a]).*$/i, "")
    .replace(/^[,，;；:：\-\uff0d\s]+|[,，;；:：\-\uff0d]+$/g, "")
    .replace(/\s+/g, "")
  return cleaned || normalizeLookupText(value) || "unnamed"
}

type FieldVariantChoice = {
  suffix: string
  overrides: PacketFieldValuePlan[]
  warnings: string[]
}

type FieldVariantGroup = {
  fieldName: string
  choices: FieldVariantChoice[]
}

type BitFieldSegment = {
  bits: number[]
  sourceText: string
  options: Array<{ binary: string; label: string }>
}

function sanitizeVariantLabel(value: string | undefined): string {
  return sanitizeReadableFileBaseName(value)
    .replace(/(?:D\d)+\s*[:\uff1a].*$/i, "")
    .replace(/[;；,，]?\s*(?:D\d)+\s*[-:\uff1a].*$/i, "")
    .replace(/^[,，;；。]+|[,，;；。]+$/g, "")
    .replace(/^[\s:\uff1a\-－]+/, "")
    .replace(/\s+/g, "")
}

function supportTableFieldRows(table: ProjectKnowledgeTable): Array<{ fieldName: string; rowText: string }> {
  return table.rows
    .map((row) => {
      const fieldName = row.find((cell) => /^W\d+$/i.test(cell.trim()))?.trim().toUpperCase()
      if (!fieldName) return null
      return {
        fieldName,
        rowText: row.filter(Boolean).join("\n"),
      }
    })
    .filter((item): item is { fieldName: string; rowText: string } => Boolean(item))
}

function isBitFieldDescription(text: string): boolean {
  return /(?:D\d(?:\s*D\d)+|D\d\s*[:\uff1a]|bit\s*\d|\u4f4d\s*\d)/i.test(text)
}

function isBusinessExpandableDescription(text: string): boolean {
  return /\u9009\u62e9|\u6a21\u5f0f|\u65b9\u5f0f|\u56de\u8def|\u901a\u9053|\u52a0\u70ed|\u63a7\u6e29|\u63a7\u5236|\u6e29\u5ea6|\u5de5\u4f5c|\u7c7b\u578b/.test(text)
}

function enumOptionsFromFieldText(text: string): Array<{ value: string; label: string }> {
  if (isBitFieldDescription(text)) return []

  const options: Array<{ value: string; label: string }> = []
  const optionPattern = /(?:^|[\s\r\n,\uff0c;\uff1b])((?:0x)?[0-9A-Fa-f]{1,2}H?|[01])\s*[-:\uff1a]\s*([^,\uff0c;\uff1b\u3002\r\n]+)/g
  for (const match of text.matchAll(optionPattern)) {
    const value = normalizeHexByte(match[1])
    const label = sanitizeVariantLabel(match[2])
    if (!value || !label) continue
    options.push({ value, label })
  }

  const unique = new Map<string, { value: string; label: string }>()
  for (const option of options) unique.set(`${option.value}:${option.label}`, option)
  return Array.from(unique.values())
}

function enumVariantGroup(table: ProjectKnowledgeTable, fieldName: string, rowText: string): FieldVariantGroup | null {
  if (!isBusinessExpandableDescription(rowText)) return null

  const options = enumOptionsFromFieldText(rowText)
  if (options.length < 2) return null

  return {
    fieldName,
    choices: options.slice(0, 8).map((option) => ({
      suffix: option.label,
      warnings: [],
      overrides: [
        {
          field_name: fieldName,
          value: option.value,
          value_source: "enum-option",
          source_table_id: table.id,
          source_text: rowText,
          confidence: 0.86,
          reasoning: [`${fieldName} is expanded from enum option "${option.label}".`],
        },
      ],
    })),
  }
}

function bitFieldSegmentsFromText(text: string): BitFieldSegment[] {
  const segments: BitFieldSegment[] = []
  const segmentPattern = /((?:D\s*\d\s*)+)\s*(?:[:\uff1a]|\s+(?=[01]{1,8}\s*[-:\uff1a]))\s*([\s\S]*?)(?=(?:D\s*\d\s*)+\s*(?:[:\uff1a]|\s+(?=[01]{1,8}\s*[-:\uff1a]))|$)/gi
  for (const match of text.matchAll(segmentPattern)) {
    const segmentText = match[2] ?? ""

    const bits = Array.from(match[1].matchAll(/D\s*(\d)/gi)).map((item) => Number(item[1]))
    if (!bits.length) continue

    const options: BitFieldSegment["options"] = []
    const optionPattern = /([01]{1,8})\s*[-:\uff1a]\s*([\s\S]*?)(?=(?:[,，;；]\s*)?[01]{1,8}\s*[-:\uff1a]|(?:D\s*\d\s*)+\s*[:\uff1a]|$)/g
    for (const optionMatch of segmentText.matchAll(optionPattern)) {
      const binary = optionMatch[1]
      const label = sanitizeVariantLabel(optionMatch[2])
      if (binary.length > bits.length || !label) continue
      options.push({ binary: binary.padStart(bits.length, "0"), label })
    }

    if (options.length) {
      segments.push({
        bits,
        sourceText: `${match[1].replace(/\s+/g, "")}: ${segmentText.trim()}`,
        options,
      })
    }
  }

  return segments
}

function bitFieldSegmentHasBits(segment: BitFieldSegment, expectedBits: number[]): boolean {
  const bits = new Set(segment.bits)
  return expectedBits.every((bit) => bits.has(bit)) && segment.bits.length === expectedBits.length
}

function optionMatching(segment: BitFieldSegment | undefined, pattern: RegExp): { binary: string; label: string } | undefined {
  return segment?.options.find((option) => pattern.test(option.label))
}

function defaultBitFieldOption(segment: BitFieldSegment): { binary: string; label: string } {
  return (
    optionMatching(segment, /\u9ed8\u8ba4|\u6062\u590d|\u95ed\u73af|\u505c\u6b62/) ??
    segment.options.find((option) => /^0+$/.test(option.binary)) ??
    { binary: "0".repeat(segment.bits.length), label: "\u9ed8\u8ba40" }
  )
}

function bitFieldByteValue(
  segments: BitFieldSegment[],
  selectedOptions: Map<BitFieldSegment, { binary: string; label: string }>,
): string {
  let value = 0
  for (const segment of segments) {
    const selected = selectedOptions.get(segment) ?? defaultBitFieldOption(segment)
    for (let index = 0; index < segment.bits.length; index += 1) {
      const bitValue = selected.binary[index] === "1" ? 1 : 0
      value |= bitValue << segment.bits[index]
    }
  }
  return value.toString(16).toUpperCase().padStart(2, "0")
}

function bitFieldChoice(
  table: ProjectKnowledgeTable,
  fieldName: string,
  rowText: string,
  segments: BitFieldSegment[],
  suffix: string,
  selectedOptions: Map<BitFieldSegment, { binary: string; label: string }>,
): FieldVariantChoice {
  const sourceText = Array.from(selectedOptions.entries())
    .map(([segment, option]) => `${segment.sourceText} => ${option.binary}-${option.label}`)
    .join("; ")

  return {
    suffix,
    warnings: [],
    overrides: [
      {
        field_name: fieldName,
        value: bitFieldByteValue(segments, selectedOptions),
        value_source: "bitfield-enum",
        source_table_id: table.id,
        source_text: sourceText || rowText,
        confidence: 0.84,
        reasoning: [`${fieldName} is assembled from bit-field options in ${table.caption ?? table.id}.`],
      },
    ],
  }
}

function bitFieldVariantGroup(table: ProjectKnowledgeTable, fieldName: string, rowText: string): FieldVariantGroup | null {
  if (!isBusinessExpandableDescription(rowText)) return null

  const segments = bitFieldSegmentsFromText(rowText)
  if (!segments.length) return null

  const modeSegment = segments.find((segment) => segment.options.some((option) => /\u95ed\u73af|\u5f00\u73af/.test(option.label)))
  const heatSegment = segments.find((segment) => segment.options.some((option) => /\u5f00\u542f\u52a0\u70ed|\u505c\u6b62\u52a0\u70ed/.test(option.label)))
  const resistorRuleSegment = segments.find((segment) => bitFieldSegmentHasBits(segment, [4]))
  const temperatureSegment = segments.find((segment) => bitFieldSegmentHasBits(segment, [3, 2, 1, 0]))
  const choices: FieldVariantChoice[] = []

  if (modeSegment) {
    const closed = optionMatching(modeSegment, /\u95ed\u73af/)
    const open = optionMatching(modeSegment, /\u5f00\u73af/)

    if (closed) {
      choices.push(bitFieldChoice(
        table,
        fieldName,
        rowText,
        segments,
        "\u95ed\u73af\u9ed8\u8ba4\u63a7\u6e29",
        new Map([[modeSegment, closed]]),
      ))
    }

    if (open && heatSegment) {
      for (const heatOption of heatSegment.options.filter((option) => /\u5f00\u542f\u52a0\u70ed|\u505c\u6b62\u52a0\u70ed/.test(option.label))) {
        choices.push(bitFieldChoice(
          table,
          fieldName,
          rowText,
          segments,
          heatOption.label.includes("\u5f00\u73af\u65f6") ? heatOption.label : `\u5f00\u73af${heatOption.label}`,
          new Map([
            [modeSegment, open],
            [heatSegment, heatOption],
          ]),
        ))
      }
    } else if (open) {
      choices.push(bitFieldChoice(table, fieldName, rowText, segments, "\u5f00\u73af", new Map([[modeSegment, open]])))
    }
  }

  if (temperatureSegment) {
    const closed = optionMatching(modeSegment, /\u95ed\u73af/)
    const explicitResistorRule = optionMatching(resistorRuleSegment, /\u6309\u7167|\u9009\u53d6\u63a7\u6e29\u7535\u963b/)
    for (const temperatureOption of temperatureSegment.options.filter((option) => /\u6e29\u5ea6\d+/.test(option.label)).slice(0, 7)) {
      choices.push(bitFieldChoice(
        table,
        fieldName,
        rowText,
        segments,
        temperatureOption.label,
        new Map([
          ...(closed && modeSegment ? [[modeSegment, closed] as const] : []),
          ...(explicitResistorRule && resistorRuleSegment ? [[resistorRuleSegment, explicitResistorRule] as const] : []),
          [temperatureSegment, temperatureOption],
        ]),
      ))
    }
  }

  if (!choices.length) {
    const firstBusinessSegment = segments.find((segment) => segment.options.length > 1) ?? segments[0]
    for (const option of firstBusinessSegment.options.slice(0, 4)) {
      choices.push(bitFieldChoice(
        table,
        fieldName,
        rowText,
        segments,
        option.label,
        new Map([[firstBusinessSegment, option]]),
      ))
    }
  }

  return choices.length ? { fieldName, choices: choices.slice(0, 16) } : null
}

function supportTableFieldVariantGroups(table: ProjectKnowledgeTable): FieldVariantGroup[] {
  return supportTableFieldRows(table)
    .map(({ fieldName, rowText }) =>
      isBitFieldDescription(rowText)
        ? bitFieldVariantGroup(table, fieldName, rowText)
        : enumVariantGroup(table, fieldName, rowText),
    )
    .filter((item): item is FieldVariantGroup => Boolean(item))
    .sort((left, right) => Number(left.fieldName.slice(1)) - Number(right.fieldName.slice(1)))
}

function supportTableVariantChoices(table: ProjectKnowledgeTable): FieldVariantChoice[] {
  const groups = supportTableFieldVariantGroups(table)
  if (!groups.length) return [{ suffix: "", overrides: [], warnings: [] }]

  let combinations: FieldVariantChoice[] = [{ suffix: "", overrides: [], warnings: [] }]
  for (const group of groups.slice(0, 3)) {
    const next: FieldVariantChoice[] = []
    for (const combination of combinations) {
      for (const choice of group.choices) {
        next.push({
          suffix: [combination.suffix, choice.suffix].filter(Boolean).join("-"),
          overrides: [...combination.overrides, ...choice.overrides],
          warnings: [...combination.warnings, ...choice.warnings],
        })
      }
    }
    combinations = next.slice(0, 32)
  }

  return combinations
}

function modelPlanForSupportTable(
  modelPlan: PacketFieldValuePlan[],
  supportTable: ProjectKnowledgeTable,
): PacketFieldValuePlan[] {
  return modelPlan.filter((item) => !item.source_table_id || item.source_table_id === supportTable.id)
}

function dictionaryRowFieldOverrides(command: DictionaryRowData, dictionaryTable: ProjectKnowledgeTable): PacketFieldValuePlan[] {
  return command.commandBytes.map((byte, byteIndex) => ({
    field_name: `W${byteIndex}`,
    value: byte,
    value_source: "dictionary-row",
    source_table_id: dictionaryTable.id,
    source_text: command.commandType,
    confidence: 0.95,
    reasoning: [`W${byteIndex} is filled from dictionary row "${command.commandName}".`],
  }))
}

function buildDictionaryRowProtocolCandidatesFromRelations(
  tables: ProjectKnowledgeTable[],
  relations: SectionProtocolRelation[],
  offset: number,
): PacketModelCandidate[] {
  const candidates: PacketModelCandidate[] = []

  for (const relation of relations) {
    const frameTable = tables.find((table) => table.id === relation.frame_table_id)
    if (!frameTable) continue

    const supportTables = supportTablesForRelation(tables, relation)
    const modelPlan = relation.field_value_plan ?? []

    if (relation.generation_mode === "frame_file") {
      const dataBlockSupportTables = supportTables.filter(supportTableDefinesFrameDataBlock)
      const frameFileVariants = dataBlockSupportTables.length >= 1 ? dataBlockSupportTables : [undefined]

      for (const variantSupportTable of frameFileVariants) {
        const variantSupportTables = variantSupportTable ? [variantSupportTable] : supportTables
        const variantModelPlan = variantSupportTable ? modelPlanForSupportTable(modelPlan, variantSupportTable) : modelPlan
        const supportVariants = variantSupportTable ? supportTableVariantChoices(variantSupportTable) : [{ suffix: "", overrides: [], warnings: [] }]

        for (const supportVariant of supportVariants) {
          const fieldValuePlan = buildFieldValuePlan(
            frameTable,
            variantSupportTables,
            mergeFieldValuePlans(variantModelPlan, supportVariant.overrides),
          )
          const frameLines = buildFrameLinesWithDataValues(frameTable, fieldValuePlanToDataValues(fieldValuePlan))
          if (!frameLines.length) continue

          const baseName = variantSupportTable
            ? cleanGeneratedDataFileBaseName(variantSupportTable.caption ?? variantSupportTable.id)
            : cleanGeneratedDataFileBaseName(relation.preferred_name ?? frameTable.caption ?? frameTable.id)
          const candidateWarnings = [
            ...supportVariant.warnings,
            ...(fieldValuePlan.some((item) => item.value_source === "fallback-zero")
              ? ["Some W fields use 00 fallback because no concrete field value plan was available."]
              : []),
            ...(relation.flow_direction && relation.flow_direction !== "unknown"
              ? []
              : ["Flow direction could not be determined from source section; defaulted to 输入流."]
            ),
          ]

          candidates.push({
            id: `packet-${offset + candidates.length + 1}`,
            name: supportVariant.suffix ? `${baseName}-${supportVariant.suffix}` : baseName,
            source_snippet_ids: [frameTable.id, ...variantSupportTables.map((table) => table.id)],
            fields: fieldValuePlanToPacketFields(fieldValuePlan),
            field_value_plan: fieldValuePlan,
            packet_lines: frameLines,
            byte_values: frameLines[0],
            checksum_rule: relation.checksum_rule ?? DEFAULT_CHECKSUM_RULE,
            flow_direction: relation.flow_direction,
            source_section: relation.source_section,
            source_flow_heading: relation.source_flow_heading,
            confidence: Math.max(0.82, relation.confidence),
            warnings: uniqueStrings(candidateWarnings),
          })
        }
      }
      continue
    }

    if (!relation.dictionary_table_id) continue
    const dictionaryTable = tables.find((table) => table.id === relation.dictionary_table_id)
    if (!dictionaryTable) continue

    for (const command of extractDictionaryRows(dictionaryTable)) {
      const fieldValuePlan = buildFieldValuePlan(
        frameTable,
        supportTables,
        mergeFieldValuePlans(modelPlan, dictionaryRowFieldOverrides(command, dictionaryTable)),
      )

      const frameLines = buildFrameLinesWithDataValues(frameTable, fieldValuePlanToDataValues(fieldValuePlan))
      if (!frameLines.length) continue

      candidates.push({
        id: `packet-${offset + candidates.length + 1}`,
        name: command.commandName,
        source_snippet_ids: [frameTable.id, dictionaryTable.id, ...supportTables.map((table) => table.id)],
        fields: fieldValuePlanToPacketFields(fieldValuePlan),
        field_value_plan: fieldValuePlan,
        packet_lines: frameLines,
        byte_values: frameLines[0],
        checksum_rule: relation.checksum_rule ?? DEFAULT_CHECKSUM_RULE,
        flow_direction: relation.flow_direction,
        source_section: relation.source_section,
        source_flow_heading: relation.source_flow_heading,
        confidence: Math.max(0.9, relation.confidence),
        warnings: uniqueStrings([
          ...(fieldValuePlan.some((item) => item.value_source === "fallback-zero")
            ? ["Some W fields use 00 fallback because no concrete field value plan was available."]
            : []),
          ...(relation.flow_direction && relation.flow_direction !== "unknown"
            ? []
            : ["Flow direction could not be determined from source section; defaulted to 输入流."]
          ),
        ]),
      })
    }
  }

  return candidates
}

function extractPacketFieldsFromTable(table: ProjectKnowledgeTable): PacketField[] {
  const [headerRow, ...dataRows] = table.rows
  if (!headerRow || dataRows.length === 0) return []

  const headers = headerRow.map((header) => normalizeLookupText(header))
  const fieldNameIndex = headerIndex(headers, [/\u5b57\u6bb5/, /\u540d\u79f0/, /field/, /name/])
  const offsetIndex = headerIndex(headers, [/\u504f\u79fb/, /\u5b57\u8282\u5e8f\u53f7/, /\u5b57\u8282/, /offset/, /index/])
  const lengthIndex = headerIndex(headers, [/\u957f\u5ea6/, /\u5b57\u8282\u6570/, /length/, /size/])
  const defaultIndex = headerIndex(headers, [/\u9ed8\u8ba4/, /\u56fa\u5b9a/, /\u503c/, /default/, /value/])
  const ruleIndex = headerIndex(headers, [/\u8bf4\u660e/, /\u89c4\u5219/, /\u8303\u56f4/, /\u542b\u4e49/, /rule/, /desc/])

  return dataRows
    .map((row): PacketField | null => {
      const fieldName = fieldNameIndex >= 0 ? row[fieldNameIndex] : row[0]
      if (!fieldName) return null
      return {
        field_name: fieldName,
        byte_offset: offsetIndex >= 0 ? parseByteNumber(row[offsetIndex]) : undefined,
        byte_length: lengthIndex >= 0 ? parseByteNumber(row[lengthIndex]) : undefined,
        default_value: defaultIndex >= 0 ? extractDefaultValue(row[defaultIndex]) : undefined,
        value_rule: ruleIndex >= 0 ? row[ruleIndex] : undefined,
        source_table_id: table.id,
      }
    })
    .filter((field): field is PacketField => Boolean(field))
}

function buildBytesFromFields(fields: PacketField[]): string[] {
  if (fields.length === 0) return []

  const explicitOffsets = fields
    .map((field) => field.byte_offset)
    .filter((offset): offset is number => typeof offset === "number")
  const maxOffset = explicitOffsets.length ? Math.max(...explicitOffsets) : fields.length - 1
  const bytes = Array(Math.max(maxOffset + 1, fields.length)).fill("00") as string[]

  let cursor = 0
  for (const field of fields) {
    const offset = field.byte_offset ?? cursor
    const length = field.byte_length ?? 1
    const value = field.default_value && /^[0-9A-F]{2}$/i.test(field.default_value)
      ? field.default_value.toUpperCase()
      : "00"

    for (let i = 0; i < length; i++) {
      bytes[offset + i] = value
    }
    cursor = offset + length
  }

  return bytes
}

function buildPacketModelCandidates(snippets: ProjectKnowledgeSnippet[]): PacketModelCandidate[] {
  const candidates: PacketModelCandidate[] = []
  const relevantTopics = new Set<ProjectKnowledgeTopic["topic"]>([
    "data_protocol",
    "packet_structure",
    "format_validation",
  ])

  for (const snippet of snippets) {
    if (!relevantTopics.has(snippet.topic)) continue
    const byteValues = extractHexBytes(snippet.text)
    const hasPacketTerms = /TITLE|W0|SUM|\u5305|\u5e27|\u6821\u9a8c|\u62a5\u6587|\u6307\u4ee4/i.test(snippet.text)
    if (!hasPacketTerms && byteValues.length < 2) continue

    candidates.push({
      id: `packet-${candidates.length + 1}`,
      name: inferPacketCandidateName(snippet),
      source_snippet_ids: [snippet.id],
      fields: [],
      byte_values: byteValues.length ? byteValues : ["AA", "55", "00", "00"],
      checksum_rule: /SUM|\u6821\u9a8c|checksum/i.test(snippet.text)
        ? DEFAULT_CHECKSUM_RULE
        : undefined,
      confidence: byteValues.length >= 4 ? 0.65 : 0.45,
      warnings: byteValues.length
        ? []
        : ["No explicit hex bytes were found; packet model uses a minimal fallback byte layout."],
    })
  }

  return candidates
}

function buildPacketModelCandidatesFromTables(
  tables: ProjectKnowledgeTable[],
  offset: number,
): PacketModelCandidate[] {
  const candidates: PacketModelCandidate[] = []

  for (const table of tables) {
    if (!isFrameFormatTable(table)) continue

    const tableText = [table.caption, ...table.rows.map((row) => row.join(" "))].filter(Boolean).join(" ")
    const hasPacketTerms = /TITLE|W0|SUM|\u5305|\u5e27|\u6821\u9a8c|\u62a5\u6587|\u6307\u4ee4|\u5b57\u8282|\u5b57\u6bb5/i.test(tableText)
    if (!hasPacketTerms) continue

    const supportTables = findRelatedSupportTables(table, tables)
    const fieldValuePlan = buildFieldValuePlan(table, supportTables)
    const frameLines = buildFrameLinesWithDataValues(table, fieldValuePlanToDataValues(fieldValuePlan))
    const byteValues = extractHexBytes(tableText)
    const fields = extractPacketFieldsFromTable(table)
    const fieldBytes = buildBytesFromFields(fields)
    candidates.push({
      id: `packet-${offset + candidates.length + 1}`,
      name: table.caption || `packet-model-${table.id}`,
      source_snippet_ids: [table.id, ...supportTables.map((supportTable) => supportTable.id)],
      fields: fields.length ? fields : fieldValuePlanToPacketFields(fieldValuePlan),
      field_value_plan: fieldValuePlan,
      packet_lines: frameLines.length ? frameLines : undefined,
      byte_values: frameLines.length
        ? frameLines[0]
        : fieldBytes.length
          ? fieldBytes
          : byteValues.length
            ? byteValues
            : ["AA", "55", "00", "00"],
      checksum_rule: /SUM|\u6821\u9a8c|checksum/i.test(tableText)
        ? DEFAULT_CHECKSUM_RULE
        : undefined,
      confidence: frameLines.length ? 0.9 : fields.length >= 2 ? 0.8 : byteValues.length >= 4 ? 0.75 : 0.55,
      warnings: uniqueStrings([
        ...(frameLines.length || fields.length || byteValues.length
          ? []
          : ["No fields or explicit hex bytes were found in the table; packet model uses a minimal fallback byte layout."]),
        ...(fieldValuePlan.some((item) => item.value_source === "fallback-zero")
          ? ["Some W fields use 00 fallback because no concrete field value plan was available."]
          : []),
      ]),
    })
  }

  return candidates
}

function sectionTargetId(targetHint: string): string | undefined {
  const appendix = targetHint.match(/^\u9644\u5f55\s*([A-Za-z]|\d+|[\u4e00-\u4e5d\u5341]+)/u)
  if (appendix?.[1]) return `appendix-${appendix[1].toUpperCase()}`
  const section = targetHint.match(/(?:\u7b2c)?\s*(\d+(?:\.\d+)*)\s*\u8282?/u)
  return section?.[1]
}

function tablesWithinSection(
  index: ProjectKnowledgeIndex,
  sourceDocumentId: string,
  headingSnippet: ProjectKnowledgeSnippet,
): string[] {
  const documentSnippets = index.snippets
    .filter((snippet) => snippet.source_document_id === sourceDocumentId)
    .sort((left, right) => snippetOrdinal(left) - snippetOrdinal(right))
  const start = snippetOrdinal(headingSnippet)
  const nextHeading = documentSnippets.find(
    (snippet) => snippetOrdinal(snippet) > start && Boolean(sectionHeadingOf(snippet)),
  )
  const end = nextHeading ? snippetOrdinal(nextHeading) : Number.MAX_SAFE_INTEGER
  return index.tables
    .filter((table) => table.source_document_id === sourceDocumentId)
    .filter((table) => {
      const ordinal = findTableCaptionSnippetOrdinal(table, documentSnippets)
      return ordinal >= start && ordinal < end
    })
    .map((table) => table.id)
}

function tableMatchesReferenceLocator(table: ProjectKnowledgeTable, tableValue: string): boolean {
  const targetKey = normalizeLookupText(`表${tableValue}`)
  if (!targetKey) return false
  return uniqueStrings([table.caption ?? "", ...table.aliases]).some((alias) => {
    const aliasKey = normalizeLookupText(alias)
    if (aliasKey === targetKey) return true
    if (!aliasKey.startsWith(targetKey)) return false
    // "表5" may match "表5 电机遥测", but must not match "表50".
    return !/^[\d.\-]/.test(aliasKey.slice(targetKey.length))
  })
}

function tablesInReferencePathScope(
  index: ProjectKnowledgeIndex,
  reference: ProjectKnowledgeReference,
  targetDocumentId: string,
): ProjectKnowledgeTable[] {
  let candidates = index.tables.filter((table) => table.source_document_id === targetDocumentId)
  const targetPath = reference.target_path ?? []
  const documentSnippets = index.snippets
    .filter((snippet) => snippet.source_document_id === targetDocumentId)
    .sort((left, right) => snippetOrdinal(left) - snippetOrdinal(right))
  let scopeStart = Number.MIN_SAFE_INTEGER
  let scopeEnd = Number.MAX_SAFE_INTEGER
  const appendix = targetPath.find((item) => item.kind === "appendix")
  if (appendix) {
    const appendixSectionId = `appendix-${appendix.value.toUpperCase()}`
    const appendixHeading = documentSnippets.find(
      (snippet) => sectionHeadingOf(snippet)?.sectionId.toUpperCase() === appendixSectionId.toUpperCase(),
    )
    if (appendixHeading) {
      const start = snippetOrdinal(appendixHeading)
      const end = documentSnippets.find((snippet) => {
        if (snippetOrdinal(snippet) <= start) return false
        return sectionHeadingOf(snippet)?.sectionId.startsWith("appendix-")
      })
      const endOrdinal = end ? snippetOrdinal(end) : Number.MAX_SAFE_INTEGER
      scopeStart = start
      scopeEnd = endOrdinal
      candidates = candidates.filter((table) => {
        const ordinal = findTableCaptionSnippetOrdinal(table, documentSnippets)
        return ordinal >= start && ordinal < endOrdinal
      })
      reference.resolved_snippet_id = appendixHeading.id
    }
  }

  const section = targetPath.findLast((item) => item.kind === "section")
  if (section) {
    const sectionHeading = documentSnippets.find((snippet) => {
      const ordinal = snippetOrdinal(snippet)
      if (ordinal < scopeStart || ordinal >= scopeEnd) return false
      const heading = sectionHeadingOf(snippet)
      return heading?.sectionId === section.value || heading?.sectionId.endsWith(`.${section.value}`)
    })
    if (sectionHeading) {
      const start = snippetOrdinal(sectionHeading)
      const currentDepth = sectionHeadingOf(sectionHeading)?.sectionId.split(".").length ?? 1
      const end = documentSnippets.find((snippet) => {
        if (snippetOrdinal(snippet) <= start) return false
        if (snippetOrdinal(snippet) >= scopeEnd) return true
        const heading = sectionHeadingOf(snippet)
        return Boolean(heading && heading.sectionId.split(".").length <= currentDepth)
      })
      const endOrdinal = end ? Math.min(snippetOrdinal(end), scopeEnd) : scopeEnd
      scopeStart = start
      scopeEnd = endOrdinal
      candidates = candidates.filter((table) => {
        const ordinal = findTableCaptionSnippetOrdinal(table, documentSnippets)
        return ordinal >= start && ordinal < endOrdinal
      })
      reference.resolved_snippet_id = sectionHeading.id
    }
  }
  return candidates
}

function resolveReferenceTargetInDocument(
  index: ProjectKnowledgeIndex,
  reference: ProjectKnowledgeReference,
  targetDocumentId: string,
): "resolved" | "ambiguous" | "unresolved" {
  const targetHint = reference.target_hint?.trim()
  if (!targetHint || reference.target_kind === "document") return "resolved"

  if (reference.target_kind === "table") {
    const tableTarget = reference.target_path?.findLast((item) => item.kind === "table")
    const matches = tableTarget
      ? tablesInReferencePathScope(index, reference, targetDocumentId)
        .filter((table) => tableMatchesReferenceLocator(table, tableTarget.value))
      : index.tables.filter((table) => {
          if (table.source_document_id !== targetDocumentId) return false
          return uniqueStrings([table.caption ?? "", ...table.aliases])
            .some((alias) => normalizeLookupText(alias) === normalizeLookupText(targetHint))
        })
    if (matches.length > 1) return "ambiguous"
    if (!matches.length) return "unresolved"
    reference.resolved_table_id = matches[0].id
    reference.resolved_table_ids = [matches[0].id]
    return "resolved"
  }

  const expectedSectionId = sectionTargetId(targetHint)
  if (!expectedSectionId) return "unresolved"
  const headingMatches = index.snippets.filter((snippet) => {
    if (snippet.source_document_id !== targetDocumentId) return false
    return sectionHeadingOf(snippet)?.sectionId.toLowerCase() === expectedSectionId.toLowerCase()
  })
  if (headingMatches.length > 1) return "ambiguous"
  if (!headingMatches.length) return "unresolved"

  const heading = headingMatches[0]
  reference.resolved_snippet_id = heading.id
  const sectionModel = index.section_protocol_models.find(
    (model) => model.source_document_id === targetDocumentId &&
      model.section_id?.toLowerCase() === expectedSectionId.toLowerCase(),
  )
  if (sectionModel) reference.resolved_section_model_id = sectionModel.id
  let resolvedTableIds = sectionModel?.table_ids.length
    ? sectionModel.table_ids
    : tablesWithinSection(index, targetDocumentId, heading)
  if (!resolvedTableIds.length && reference.target_kind === "appendix") {
    const appendixKey = normalizeLookupText(targetHint)
    resolvedTableIds = index.tables
      .filter((table) => table.source_document_id === targetDocumentId)
      .filter((table) => uniqueStrings([table.caption ?? "", ...table.aliases])
        .some((alias) => normalizeLookupText(alias).includes(appendixKey)))
      .map((table) => table.id)
  }
  reference.resolved_table_ids = resolvedTableIds
  reference.resolved_table_id = reference.resolved_table_ids[0]
  return "resolved"
}

function inferReferenceSemanticRoles(
  index: ProjectKnowledgeIndex,
  reference: ProjectKnowledgeReference,
): ProjectKnowledgeReferenceRole[] {
  const targetTables = index.tables.filter((table) =>
    (reference.resolved_table_ids ?? (reference.resolved_table_id ? [reference.resolved_table_id] : []))
      .includes(table.id),
  )
  const targetModel = reference.resolved_section_model_id
    ? index.section_protocol_models.find((model) => model.id === reference.resolved_section_model_id)
    : undefined
  const sourceSnippet = reference.source_snippet_id
    ? index.snippets.find((snippet) => snippet.id === reference.source_snippet_id)
    : undefined
  const sourceTable = reference.source_table_id
    ? index.tables.find((table) => table.id === reference.source_table_id)
    : undefined
  const evidence = [
    reference.reference_text,
    sourceSnippet?.text ?? "",
    sourceTable?.caption ?? "",
    targetModel?.section_title ?? "",
    ...targetTables.flatMap((table) => [table.caption ?? "", ...table.aliases, ...table.rows.slice(0, 8).flat()]),
  ].join("\n")
  const sourceEvidence = [
    reference.reference_text,
    sourceSnippet?.text ?? "",
    sourceTable?.caption ?? "",
  ].join("\n")
  const roles = new Set<ProjectKnowledgeReferenceRole>()
  const payloadOnlyReference = /(?:DATA|W)\s*\d+(?:\s*[~～\-]\s*(?:DATA|W)?\s*\d+)?[^\n。；;]{0,32}(?:见|详见|参见)/i.test(sourceEvidence) ||
    /(?:字段|参数|有效数据)[^\n。；;]{0,24}(?:见|详见|参见)/i.test(sourceEvidence)
  const explicitFrameReference = /(?:格式|帧结构|报文结构|数据包结构)[^\n。；;]{0,24}(?:见|详见|参见)|(?:见|详见|参见)[^\n。；;]{0,24}(?:格式|结构)/i.test(sourceEvidence)
  const mostSpecificTarget = reference.target_path?.at(-1)?.kind ?? reference.target_kind

  if (
    explicitFrameReference ||
    (!payloadOnlyReference && targetTables.some(isFrameFormatTable)) ||
    /(?:帧|报文|数据包|指令).{0,20}(?:格式|结构)|(?:格式|结构).{0,20}(?:帧|报文|数据包|指令)/i.test(evidence) ||
    /(?:TITLE|T\b)[\s\S]{0,160}(?:W\s*0|DATA\s*0)[\s\S]{0,320}(?:SUM|CRC|ISO|校验)/i.test(evidence)
  ) {
    if (!payloadOnlyReference || explicitFrameReference) roles.add("frame_layout")
  }
  if (payloadOnlyReference) roles.add("payload_definition")
  if (/(?:指令|命令|状态|功能).{0,16}(?:码|代码|定义|字典)|(?:码字|枚举|取值).{0,16}(?:定义|说明|表)/i.test(evidence)) {
    roles.add("field_dictionary")
  }
  if (/(?:W\s*\d+|DATA\s*\d*|有效数据|数据域|数据场|载荷|参数).{0,24}(?:定义|说明|处理|含义|格式)/i.test(evidence)) {
    roles.add("payload_definition")
  }
  if (/(?:站地址|节点地址|终端地址|设备地址|模式|通道|类型).{0,24}(?:选择|对应|映射|决定|定义)|(?:选择|对应|映射).{0,24}(?:协议|帧数|格式)/i.test(evidence)) {
    roles.add("selector")
  }
  if (/(?:SUM|CRC|ISO|校验和|校验字|校验码).{0,32}(?:计算|算法|范围|定义|说明)|(?:计算|累加|低字节).{0,32}(?:SUM|CRC|ISO|校验)/i.test(evidence)) {
    roles.add("checksum_definition")
  }
  if (/(?:分帧|组帧|传输|发送顺序|帧序号|起始块|中间块|校验块|总线封装)/i.test(evidence)) {
    roles.add("related_transport")
  }
  if (mostSpecificTarget !== "table" && !explicitFrameReference && !payloadOnlyReference) {
    roles.add("broad_context_only")
  }
  return roles.size ? Array.from(roles) : ["unknown"]
}

function annotateReferenceSemantics(index: ProjectKnowledgeIndex): void {
  for (const reference of index.references) {
    if (reference.state !== "resolved" && reference.state !== "fallback_resolved") continue
    reference.semantic_roles = inferReferenceSemanticRoles(index, reference)
    reference.confidence = reference.state === "resolved" ? 1 : 0.75
  }
}

export function resolveKnowledgeReferences(index: ProjectKnowledgeIndex): void {
  const documentsById = new Map(index.source_documents.map((document) => [document.id, document]))

  for (const reference of index.references) {
    const sourceDocument = documentsById.get(reference.source_document_id)
    if (!sourceDocument) continue
    if (reference.state === "unsupported" || reference.state === "not_followed_by_policy" || reference.state === "ambiguous") continue

    const isInternal = reference.reference_type === "internal" || reference.reference_type === "internal-appendix"
    if (isInternal) {
      if (sourceDocument.role !== "primary-third-party-test-requirement") {
        reference.state = "not_followed_by_policy"
        reference.warnings = uniqueStrings([
          ...(reference.warnings ?? []),
          "References inside a requirement specification are not followed.",
        ])
        continue
      }
      const resolution = resolveReferenceTargetInDocument(index, reference, sourceDocument.id)
      reference.state = resolution
      if (resolution !== "resolved") {
        reference.warnings = uniqueStrings([
          ...(reference.warnings ?? []),
          `Internal reference target could not be resolved exactly: ${reference.target_hint ?? reference.reference_text}.`,
        ])
      }
      continue
    }

    if (reference.reference_type !== "requirement-specification" && reference.reference_type !== "external-document") continue
    if (sourceDocument.role !== "primary-third-party-test-requirement") {
      reference.state = "not_followed_by_policy"
      continue
    }

    if (reference.resolved_document_id) {
      const resolution = resolveReferenceTargetInDocument(index, reference, reference.resolved_document_id)
      reference.state = resolution
      if (resolution !== "resolved") {
        reference.warnings = uniqueStrings([
          ...(reference.warnings ?? []),
          `Requirement-specification target could not be resolved exactly: ${reference.target_hint ?? "document"}.`,
        ])
      }
      continue
    }

    if (reference.target_hint) {
      const fallbackResolution = resolveReferenceTargetInDocument(index, reference, sourceDocument.id)
      if (fallbackResolution === "resolved") {
        reference.resolved_document_id = sourceDocument.id
        reference.state = "fallback_resolved"
        reference.warnings = uniqueStrings([
          ...(reference.warnings ?? []),
          "Requirement specification was unavailable; the same target in the third-party test requirement was used.",
        ])
        continue
      }
    }
    reference.state = "unresolved"
  }

  annotateReferenceSemantics(index)
}

export function buildDocumentReferenceGraph(index: ProjectKnowledgeIndex): DocumentReferenceGraph {
  const nodes: DocumentReferenceGraphNode[] = []
  const edges: DocumentReferenceGraphEdge[] = []
  const nodeIds = new Set<string>()
  const addNode = (node: DocumentReferenceGraphNode): void => {
    if (nodeIds.has(node.id)) return
    nodeIds.add(node.id)
    nodes.push(node)
  }

  for (const document of index.source_documents) {
    addNode({ id: document.id, type: "document", source_document_id: document.id, title: document.file_name })
  }
  for (const model of index.section_protocol_models) {
    const type = model.section_id?.startsWith("appendix-") ? "appendix" : "section"
    addNode({ id: model.id, type, source_document_id: model.source_document_id, title: model.section_title })
    edges.push({
      source: model.source_document_id,
      target: model.id,
      relation: "contains",
      depth: 0,
      state: "resolved",
      evidence: model.section_title,
      warnings: [],
    })
  }
  for (const table of index.tables) {
    addNode({
      id: table.id,
      type: "table",
      source_document_id: table.source_document_id,
      title: table.caption ?? table.id,
    })
    const containingModels = index.section_protocol_models.filter(
      (model) => model.source_document_id === table.source_document_id && model.table_ids.includes(table.id),
    )
    const parents = containingModels.length
      ? containingModels.map((model) => model.id)
      : [table.source_document_id]
    for (const parent of parents) {
      edges.push({
        source: parent,
        target: table.id,
        relation: "contains",
        depth: 0,
        state: "resolved",
        evidence: table.caption ?? table.id,
        warnings: [],
      })
    }
  }
  const addReferenceSnippetNode = (snippetId: string | undefined): void => {
    if (!snippetId || nodeIds.has(snippetId)) return
    const snippet = index.snippets.find((candidate) => candidate.id === snippetId)
    if (!snippet) return
    const heading = sectionHeadingOf(snippet)
    addNode({
      id: snippet.id,
      type: heading?.sectionId.startsWith("appendix-") ? "appendix" : "section",
      source_document_id: snippet.source_document_id,
      title: heading?.title ?? snippet.text,
    })
    edges.push({
      source: snippet.source_document_id,
      target: snippet.id,
      relation: "contains",
      depth: 0,
      state: "resolved",
      evidence: heading?.title ?? snippet.text,
      warnings: [],
    })
  }
  for (const reference of index.references) {
    addReferenceSnippetNode(reference.source_snippet_id)
    addReferenceSnippetNode(reference.resolved_snippet_id)
  }
  for (const reference of index.references) {
    const target = reference.resolved_section_model_id ?? reference.resolved_snippet_id ??
      reference.resolved_table_id ?? reference.resolved_document_id
    edges.push({
      source: reference.source_snippet_id ?? reference.source_table_id ?? reference.source_document_id,
      target,
      target_hint: reference.target_hint ?? reference.target_document_hint,
      relation: "references",
      depth: reference.depth ?? 0,
      state: reference.state,
      evidence: reference.reference_text,
      semantic_roles: reference.semantic_roles,
      confidence: reference.confidence,
      warnings: reference.warnings ?? [],
    })
  }

  return {
    schema_version: DOCUMENT_REFERENCE_GRAPH_SCHEMA_VERSION,
    project_root: index.project_root,
    nodes,
    edges,
    warnings: uniqueStrings(index.references.flatMap((reference) => reference.warnings ?? [])),
    updated_at: new Date().toISOString(),
  }
}

export function writeDocumentReferenceGraph(outputFile: string, graph: DocumentReferenceGraph): void {
  ensureDirectory(dirname(outputFile))
  writeFileSync(outputFile, `${JSON.stringify(graph, null, 2)}\n`, "utf-8")
}

export function buildProtocolEvidenceTrace(
  paths: DefaultPaths,
  index: ProjectKnowledgeIndex,
  definitions: DtpProtocolDefinitionsDocument,
): ProtocolEvidenceTraceDocument {
  const resolvedReferences = index.references.filter(
    (reference) => reference.state === "resolved" || reference.state === "fallback_resolved",
  )
  const protocols = definitions.protocols.map((protocol) => {
    const sourceTableIds = uniqueStrings([
      ...getDtpProtocolFrames(protocol).map((frame) => frame.source_table_id),
      ...(protocol.block_layout?.source_table_ids ?? []),
      ...(protocol.provenance ?? []).flatMap((item) => item.source_table_ids),
    ])
    const sourceSections = uniqueStrings([
      protocol.source_section ?? "",
      ...(protocol.provenance ?? []).flatMap((item) => item.source_sections),
    ])
    const sourceDocumentIds = uniqueStrings(
      (protocol.provenance ?? []).map((item) => item.source_document_id),
    )
    const references = resolvedReferences
      .filter((reference) => {
        const targetIds = resolvedReferenceTargetIdsForTrace(reference)
        if (targetIds.some((targetId) => sourceTableIds.includes(targetId))) return true
        if (reference.resolved_section_model_id) {
          const model = index.section_protocol_models.find(
            (candidate) => candidate.id === reference.resolved_section_model_id,
          )
          return Boolean(model && sourceSections.includes(model.section_title))
        }
        return false
      })
      .map(referenceEvidenceFromKnowledgeReference)
    return {
      protocol_id: protocol.protocol_id,
      protocol_name: protocol.base_file_name,
      source_document_ids: sourceDocumentIds,
      source_sections: sourceSections,
      source_table_ids: sourceTableIds,
      references,
      evidence: uniqueStrings(protocol.evidence ?? []),
      warnings: uniqueStrings([
        ...protocol.warnings,
        ...references.flatMap((reference) => reference.warnings),
      ]),
    }
  })
  return {
    schema_version: "1.0.0",
    project_root: paths.workspaceRoot,
    protocol_definitions_file: paths.dtpProtocolDefinitionsFile,
    protocols,
    warnings: uniqueStrings(protocols.flatMap((protocol) => protocol.warnings)),
    updated_at: new Date().toISOString(),
  }
}

function resolvedReferenceTargetIdsForTrace(reference: ProjectKnowledgeReference): string[] {
  return uniqueStrings([
    ...(reference.resolved_table_ids ?? []),
    reference.resolved_table_id ?? "",
    reference.resolved_section_model_id ?? "",
    reference.resolved_snippet_id ?? "",
    reference.resolved_document_id ?? "",
  ])
}

function referenceEvidenceFromKnowledgeReference(
  reference: ProjectKnowledgeReference,
): DtpProtocolReferenceEvidence {
  return {
    reference_id: reference.reference_id ?? `${reference.source_document_id}:${reference.reference_text}`,
    reference_text: reference.reference_text,
    source_id: reference.source_snippet_id ?? reference.source_table_id ?? reference.source_document_id,
    target_ids: resolvedReferenceTargetIdsForTrace(reference),
    semantic_roles: reference.semantic_roles?.length ? reference.semantic_roles : ["unknown"],
    depth: reference.depth ?? 0,
    state: reference.state as "resolved" | "fallback_resolved",
    confidence: reference.confidence ?? (reference.state === "resolved" ? 1 : 0.75),
    warnings: reference.warnings ?? [],
  }
}

export function writeProtocolEvidenceTrace(outputFile: string, trace: ProtocolEvidenceTraceDocument): void {
  ensureDirectory(dirname(outputFile))
  writeFileSync(outputFile, `${JSON.stringify(trace, null, 2)}\n`, "utf-8")
}

function tableEvidenceBusScope(table: ProjectKnowledgeTable, models: SectionProtocolModel[]): string[] {
  const text = [
    table.caption,
    ...table.aliases,
    ...models.flatMap((model) => [model.section_title, ...(model.section_path ?? [])]),
  ].filter(Boolean).join(" ")
  const scopes: string[] = []
  if (/Space\s*Wire/i.test(text)) scopes.push("SpaceWire")
  if (/\bSPI\b/i.test(text)) scopes.push("SPI")
  if (/(?:二级|次级)\s*CAN/i.test(text)) scopes.push("secondary-can")
  else if (/(?:一级|主)\s*CAN|CAN[AB]?/i.test(text)) scopes.push("primary-can")
  if (/RS\s*[-_]?\s*422/i.test(text)) scopes.push("RS422")
  if (/1553B/i.test(text)) scopes.push("1553B")
  return uniqueStrings(scopes)
}

export function buildDtpTableEvidenceIndex(index: ProjectKnowledgeIndex): DtpTableEvidenceIndex {
  const tables = index.tables.map((table): DtpTableEvidenceIndexEntry => {
    const models = index.section_protocol_models.filter((model) => model.table_ids.includes(table.id))
    const relations = models.flatMap((model) => model.protocol_relations)
    const targetReferences = index.references.filter((reference) => resolvedReferenceTargetIdsForTrace(reference).includes(table.id))
    const sourceReferences = index.references.filter((reference) => reference.source_table_id === table.id)
    const semanticRoles = uniqueStrings([
      ...models.flatMap((model) => model.primary_table_ids.includes(table.id) ? ["frame_layout"] : []),
      ...models.flatMap((model) => model.support_table_ids.includes(table.id) ? ["support"] : []),
      ...relations.flatMap((relation) => relation.dictionary_table_id === table.id ? ["command_dictionary"] : []),
      ...targetReferences.flatMap((reference) => reference.semantic_roles ?? []),
      ...([table.caption, ...(table.rows[0] ?? []), ...table.aliases].join(" ").match(/SUM|CRC|ISO|校验/i)
        ? ["checksum_definition"]
        : []),
    ])
    const flowDirections = uniqueStrings(relations.flatMap((relation) => (
      relation.frame_table_id === table.id && relation.flow_direction ? [relation.flow_direction] : []
    ))).filter((value): value is FlowDirection => value === "input" || value === "output" || value === "unknown")
    return {
      table_id: table.id,
      source_document_id: table.source_document_id,
      section_model_ids: models.map((model) => model.id),
      section_paths: models.map((model) => model.section_path ?? [model.section_title]),
      caption: table.caption,
      headers: table.rows[0] ?? [],
      row_count: table.rows.length,
      bus_scope: tableEvidenceBusScope(table, models),
      flow_directions: flowDirections,
      semantic_roles: semanticRoles,
      aliases: table.aliases,
      referenced_by: uniqueStrings(targetReferences.map((reference) => (
        reference.source_snippet_id ?? reference.source_table_id ?? reference.source_document_id
      ))),
      references: uniqueStrings(sourceReferences.flatMap(resolvedReferenceTargetIdsForTrace)),
    }
  })
  const knowledgeContentHash = index.portable_metadata?.content_hash ?? createHash("sha256")
    .update(JSON.stringify(index.source_documents.map((document) => [document.id, document.path, document.modified_time])))
    .digest("hex")
  return {
    schema_version: "1.0.0",
    knowledge_content_hash: knowledgeContentHash,
    tables,
    updated_at: new Date().toISOString(),
  }
}

export function writeDtpTableEvidenceIndex(outputFile: string, index: DtpTableEvidenceIndex): void {
  ensureDirectory(dirname(outputFile))
  writeFileSync(outputFile, `${JSON.stringify(index, null, 2)}\n`, "utf-8")
}

export function writeKnowledgePackageManifest(paths: DefaultPaths): void {
  const artifactFiles = [
    paths.projectKnowledgeIndexFile,
    paths.tableEvidenceIndexFile,
    paths.documentReferenceGraphFile,
    paths.protocolEvidenceTraceFile,
    paths.dtpProtocolDefinitionsFile,
    paths.commandDictionaryIndexFile,
    paths.dtpModelCacheFile,
  ].filter((filePath) => existsSync(filePath))
  const artifacts = artifactFiles.map((filePath) => {
    const content = readFileSync(filePath)
    return {
      path: relative(paths.dtpArtifactsDir, filePath).replace(/\\/g, "/"),
      size_bytes: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
      mutable: filePath === paths.dtpModelCacheFile,
    }
  })
  const manifest = {
    schema_version: KNOWLEDGE_PACKAGE_MANIFEST_SCHEMA_VERSION,
    extractor_version: PROJECT_KNOWLEDGE_EXTRACTOR_VERSION,
    protocol_schema_version: DTP_PROTOCOL_SCHEMA_VERSION,
    protocol_compiler_version: DTP_PROTOCOL_COMPILER_VERSION,
    artifacts,
    created_at: new Date().toISOString(),
  }
  ensureDirectory(dirname(paths.knowledgePackageManifestFile))
  writeFileSync(paths.knowledgePackageManifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8")
}

function inspectTrustedKnowledgePackageManifest(paths: DefaultPaths): string[] {
  if (!existsSync(paths.knowledgePackageManifestFile)) {
    return ["Offline trusted reuse continued without the optional knowledge-package-manifest.json."]
  }
  let manifest: unknown
  try {
    manifest = JSON.parse(readFileSync(paths.knowledgePackageManifestFile, "utf-8"))
  } catch {
    return ["Offline trusted reuse ignored a malformed knowledge-package-manifest.json."]
  }
  if (!isRecord(manifest)) {
    return ["Offline trusted reuse ignored an unreadable knowledge-package-manifest.json structure."]
  }
  const warnings = [
    "Offline trusted reuse does not enforce manifest SHA-256 checks or source-document freshness.",
  ]
  if (manifest.schema_version !== KNOWLEDGE_PACKAGE_MANIFEST_SCHEMA_VERSION) {
    warnings.push(`Offline knowledge package manifest schema ${String(manifest.schema_version ?? "missing")} differs from ${KNOWLEDGE_PACKAGE_MANIFEST_SCHEMA_VERSION}; trusted reuse continued.`)
  }
  if (
    manifest.protocol_schema_version !== DTP_PROTOCOL_SCHEMA_VERSION ||
    manifest.protocol_compiler_version !== DTP_PROTOCOL_COMPILER_VERSION
  ) {
    warnings.push("Offline package protocol metadata differs from the current runtime; readable protocol definitions will be normalized in memory.")
  }
  return warnings
}

function persistProjectKnowledgeArtifacts(paths: DefaultPaths, index: ProjectKnowledgeIndex): void {
  writeProjectKnowledgeIndex(paths.projectKnowledgeIndexFile, index)
  writeDtpTableEvidenceIndex(paths.tableEvidenceIndexFile, buildDtpTableEvidenceIndex(index))
  writeDocumentReferenceGraph(paths.documentReferenceGraphFile, buildDocumentReferenceGraph(index))
  writeKnowledgePackageManifest(paths)
}

function findPacketModelCandidate(intent: DataFileIntent): PacketModelCandidate | null {
  const index = intent.knowledgeIndex
  if (!index) return null

  const requestedName = normalizeProtocolMatchText(intent.requestedFileName)
  const semanticText = normalizeProtocolMatchText(intent.stepDescription)

  let best: { candidate: PacketModelCandidate; score: number } | null = null
  for (const candidate of index.packet_model_candidates) {
    const syntheticBytes = candidate.byte_values.map((value) => value.toUpperCase()).join(" ") === "AA 55 00 00"
    const syntheticFallback = !candidate.packet_lines?.length &&
      !candidate.fields.length &&
      (syntheticBytes || candidate.warnings.some((warning) => /minimal fallback byte layout/i.test(warning)))
    if (syntheticFallback) continue
    const hasCompletePacketLines = Boolean(
      candidate.packet_lines?.length && candidate.packet_lines.every((line) => line.length >= 4),
    )
    if (!hasCompletePacketLines) continue
    const nameKey = normalizeProtocolMatchText(candidate.name)
    if (!nameKey) continue

    const requestedDirect = Boolean(
      requestedName && (nameKey.includes(requestedName) || requestedName.includes(nameKey)),
    )
    const semanticDirect = Boolean(
      semanticText && (semanticText.includes(nameKey) || nameKey.includes(semanticText)),
    )
    const requestedOverlap = requestedName
      ? longestCommonSubstringLength(requestedName, nameKey)
      : 0
    const semanticOverlap = semanticText
      ? longestCommonSubstringLength(semanticText, nameKey)
      : 0
    const isSummaryCandidate = /(?:总结表|汇总表|需求项|测试项|一览表)/.test(candidate.name)
    if (isSummaryCandidate && !requestedDirect && !semanticDirect) continue

    const relevant = requestedDirect || semanticDirect || requestedOverlap >= 4 || semanticOverlap >= 6
    if (!relevant) continue

    const relationScore = (requestedDirect ? 400 : 0) +
      (semanticDirect ? 300 : 0) +
      (requestedOverlap * 10) +
      semanticOverlap
    const score = relationScore + candidate.confidence
    if (!best || score > best.score) best = { candidate, score }
  }

  return best?.candidate ?? null
}

function buildPacketContentFromModel(intent: DataFileIntent, candidate: PacketModelCandidate): string {
  if (candidate.packet_lines?.length) {
    return candidate.packet_lines.map((line) => line.join(" ")).join("\n")
  }

  const fieldBytes = buildBytesFromFields(candidate.fields)
  const payload = fieldBytes.length ? fieldBytes : candidate.byte_values.slice()
  if (payload.length === 0) return "00"
  const checksum = computeByteSum(payload)
  return [...payload, checksum].join(" ")
}

function refreshPacketModelCandidates(index: ProjectKnowledgeIndex): ProjectKnowledgeIndex {
  const snippetCandidates = buildPacketModelCandidates(index.snippets)
  const tableCandidates = buildPacketModelCandidatesFromTables(index.tables, snippetCandidates.length)
  const preliminaryModels = buildSectionProtocolModels(index.snippets, index.tables, [
    ...snippetCandidates,
    ...tableCandidates,
  ], index.references)
  const relationCandidates = buildDictionaryRowProtocolCandidatesFromRelations(
    index.tables,
    preliminaryModels.flatMap((model) => model.protocol_relations),
    snippetCandidates.length + tableCandidates.length,
  )
  index.packet_model_candidates = [
    ...snippetCandidates,
    ...tableCandidates,
    ...relationCandidates,
  ]
  index.section_protocol_models = buildSectionProtocolModels(
    index.snippets,
    index.tables,
    index.packet_model_candidates,
    index.references,
  )
  return index
}

async function enrichKnowledgeIndexWithDocumentText(
  index: ProjectKnowledgeIndex,
  paths: DefaultPaths,
): Promise<ProjectKnowledgeIndex> {
  const snippets: ProjectKnowledgeSnippet[] = []
  const tables: ProjectKnowledgeTable[] = []
  const references: ProjectKnowledgeReference[] = []

  for (const document of index.source_documents) {
    await extractDocumentIntoKnowledgeIndex(index, document, snippets, tables, references, paths.documentCacheDir)
  }

  index.snippets = snippets
  index.tables = tables
  index.references = references.length ? references : index.references

  const referencedDocuments = appendReferencedDocuments(index)
  for (const document of referencedDocuments) {
    await extractDocumentIntoKnowledgeIndex(index, document, snippets, tables, index.references, paths.documentCacheDir)
  }

  updateKnowledgeTopicsFromSnippets(index, snippets)
  index.snippets = snippets
  index.tables = tables
  refreshPacketModelCandidates(index)
  resolveKnowledgeReferences(index)
  // References need the first structural model pass to resolve their targets.
  // Rebuild once so flows whose frame table is supplied only by a reference are retained.
  refreshPacketModelCandidates(index)
  resolveKnowledgeReferences(index)

  return index
}

function extractTimeOnly(stepRecord: Record<string, unknown>): string | number | undefined {
  const directCandidates = ["time", "Time", "${time}", "\u6267\u884c\u65f6\u95f4", "\u65f6\u95f4"]
  for (const key of directCandidates) {
    const value = stepRecord[key]
    if (typeof value === "number" || typeof value === "string") {
      return sanitizeDtpExecutableValue(value) as string | number
    }
  }

  const parameterContainers = [
    "parameter",
    "parameters",
    "args",
    "arguments",
    "\u53c2\u6570",
    "step_params",
  ]

  for (const containerKey of parameterContainers) {
    const container = stepRecord[containerKey]
    if (!Array.isArray(container)) continue
    for (const item of container) {
      if (!isRecord(item)) continue
      const name = getFirstString(item, ["name", "Name", "\u53c2\u6570\u540d"])
      if (name !== "${time}" && name !== "time" && name !== "\u6267\u884c\u65f6\u95f4") continue
      const value = item.value ?? item.Value ?? item["\u53c2\u6570\u503c"]
      if (typeof value === "number" || typeof value === "string") {
        return sanitizeDtpExecutableValue(value) as string | number
      }
    }
  }

  return undefined
}

function findParameterValue(
  stepRecord: Record<string, unknown>,
  parameterNames: string[],
): string | number | undefined {
  const parameterContainers = [
    "parameter",
    "parameters",
    "args",
    "arguments",
    "\u53c2\u6570",
    "step_params",
  ]

  for (const containerKey of parameterContainers) {
    const container = stepRecord[containerKey]
    if (!Array.isArray(container)) continue
    for (const item of container) {
      if (!isRecord(item)) continue
      const name = getFirstString(item, ["name", "Name", "\u53c2\u6570\u540d"])
      if (!name || !parameterNames.includes(name)) continue
      const value = item.value ?? item.Value ?? item["\u53c2\u6570\u503c"]
      if (typeof value === "number" || typeof value === "string") {
        return sanitizeDtpExecutableValue(value) as string | number
      }
    }
  }

  return undefined
}

function inferArgumentSemantic(argument: KeywordArgumentDef): string | undefined {
  const name = argument.name
  const comments = argument.comments ?? ""
  const combined = `${name} ${comments}`

  if (/\$\{time\}|执行时间|time/i.test(combined)) return "time"
  if (/文件|file/i.test(combined)) return "file_path"
  if (/循环|周期|cycle/i.test(combined)) return "cycle_time"
  if (/id|ID|类型/.test(combined)) return "data_id"
  return undefined
}

function inferArgumentSemanticSafe(argument: KeywordArgumentDef): string | undefined {
  const combined = `${argument.name} ${argument.comments ?? ""}`

  if (/\$\{time\}|\u6267\u884c\u65f6\u95f4|execute\s*time/i.test(combined)) return "time"
  if (/\u6570\u636e\u6587\u4ef6|\u6587\u4ef6|file/i.test(combined)) return "file_path"
  if (/\u6570\u636e\u534f\u8bae\u540d\u79f0|\u534f\u8bae\u540d\u79f0|\u62a5\u6587\u540d\u79f0|protocol/i.test(combined)) {
    return "protocol_name"
  }
  if (/\u5185\u5b58\u5730\u5740|\u76ee\u6807\u5730\u5740|\u5199\u5165\u5730\u5740|\u5b58\u50a8\u5730\u5740|memory\s*address|target\s*address|write\s*address/i.test(combined)) {
    return "target_address"
  }
  if (/\u5faa\u73af|\u5468\u671f|cycle/i.test(combined)) return "cycle_time"
  if (/\u65f6\u95f4|time/i.test(combined)) return "time"
  if (/id|ID|\u7c7b\u578b/.test(combined)) return "data_id"

  return inferArgumentSemantic(argument)
}

function keywordConsumesExternalTextData(keywordDef: KeywordDefinition): boolean {
  const combined = `${keywordDef.keywordName} ${keywordDef.documentation ?? ""}`
  return /txt|\u6570\u636e\u6587\u4ef6|\u6587\u4ef6\u8def\u5f84/i.test(combined)
}

function argumentDescribesNamedDataPayload(argument: KeywordArgumentDef): boolean {
  const combined = `${argument.name} ${argument.comments ?? ""}`
  return /\u6570\u636e\u5305\u540d\u79f0|\u62a5\u6587\u540d\u79f0|\u5e27\u6570\u636e\u540d\u79f0|\u6570\u636e\u540d\u79f0|\u8f7d\u8377\u540d\u79f0/i.test(combined)
}

function isOnlyUnclassifiedPayloadArgument(
  keywordDef: KeywordDefinition,
  argument: KeywordArgumentDef,
  dataGenerationPlan?: CaseStepDataGenerationPlan,
): boolean {
  if (!dataGenerationPlan?.protocol_id || !dataGenerationPlan.deterministic_generation) return false
  const candidates = keywordDef.arguments.filter((candidate) => !inferArgumentSemanticSafe(candidate))
  return candidates.length === 1 && candidates[0]?.name === argument.name
}

function inferKeywordArgumentSemantic(
  keywordDef: KeywordDefinition,
  argument: KeywordArgumentDef,
  dataGenerationPlan?: CaseStepDataGenerationPlan,
): string | undefined {
  const combined = `${argument.name} ${argument.comments ?? ""}`
  if (
    dataGenerationPlan?.operation === "memory_write" &&
    /\u8d77\u59cb\u5730\u5740|\u5199\u5165\u5730\u5740|\u5185\u5b58\u5730\u5740|target\s*address|write\s*address/i.test(combined)
  ) return "target_address"
  const explicitSemantic = inferArgumentSemanticSafe(argument)
  if (explicitSemantic) return explicitSemantic
  if (!keywordConsumesExternalTextData(keywordDef)) return undefined
  if (argumentDescribesNamedDataPayload(argument)) return "file_path"
  if (isOnlyUnclassifiedPayloadArgument(keywordDef, argument, dataGenerationPlan)) return "file_path"
  return undefined
}

function argumentSupportsInlineData(argument: KeywordArgumentDef): boolean {
  const combined = `${argument.name} ${argument.comments ?? ""}`
  return /\u6570\u636e\s*(?:\u6216|\/|\\)\s*\u6587\u4ef6|data\s*(?:or|\/)\s*file/i.test(combined)
}

function extractInlineMemoryWriteData(value: string | undefined): string | undefined {
  const text = semanticCaseStepDescription(value)
  const match = text.match(
    /(?:\u6570\u636e|\u5185\u5bb9)\s*(?:\u4e3a|=|\uff1d|\uff1a|:)\s*[\u201c\u201d"'\u2018\u2019]?\s*((?:0x)?[0-9A-F]{1,32}H?)\s*[\u201c\u201d"'\u2018\u2019]?/i,
  )
  const literal = match?.[1]
  if (!literal) return undefined
  if (/^0x/i.test(literal)) return `0x${literal.slice(2).toUpperCase()}`
  return literal.toUpperCase()
}

function argumentLooksLikeFile(
  keywordDef: KeywordDefinition,
  argument: KeywordArgumentDef,
  dataGenerationPlan?: CaseStepDataGenerationPlan,
): boolean {
  return inferKeywordArgumentSemantic(keywordDef, argument, dataGenerationPlan) === "file_path"
}

function extractRequestedFileNameSafe(step: ConfirmationStep): string | undefined {
  const rawRecord = isRecord(step.raw) ? step.raw : {}
  const directHint = findParameterValue(rawRecord, [
    "${para2}",
    "para2",
    "protocol",
    "file",
    "\u6570\u636e\u6587\u4ef6",
    "\u6570\u636e\u534f\u8bae\u540d\u79f0",
  ])

  if (typeof directHint === "string" && directHint.trim()) {
    const trimmed = directHint.trim()
    return trimmed.toLowerCase().endsWith(".txt") ? trimmed : `${trimmed}.txt`
  }

  const text = step.stepDescription ?? ""
  const fileMatch = text.match(/([\w\u4e00-\u9fff.-]+\.txt)\b/i)
  if (fileMatch?.[1]) return fileMatch[1]

  const sendMatch = text.match(/\u53d1\u9001([\w\u4e00-\u9fff-]+)/)
  if (sendMatch?.[1]) return `${sendMatch[1].replace(/[，,。.；;]/g, "")}.txt`

  return extractRequestedFileName(step)
}

function extractRequestedFileName(step: ConfirmationStep): string | undefined {
  const text = step.stepDescription ?? ""
  const match = text.match(/([\w\-.一-龥]+\.txt)\b/i)
  return match?.[1]
}

function inferArgumentValueFromDocsAndContext(
  argument: KeywordArgumentDef,
  step: ConfirmationStep,
  _caseContext: ConfirmationCase,
  docsContext: DocsContext,
): { value: string | number | boolean; semantic?: string; source: string; detail: string } | null {
  const semantic = inferArgumentSemanticSafe(argument)

  if (semantic === "cycle_time") {
    return {
      value: "1",
      semantic,
      source: "step-description-inference",
      detail: "Defaulted cycle control to 1 based on the step wording and keyword comment.",
    }
  }

  if (semantic === "data_id") {
    return {
      value: "1",
      semantic,
      source: "document-inference",
      detail: "Placeholder skeleton mapping from protocol and requirement documents.",
    }
  }

  const availableSources = [
    step.stepDescription,
    ...docsContext.protocolDocs,
  ].filter(Boolean)

  if (availableSources.length === 0) {
    return null
  }

  return {
    value: "TODO",
    semantic,
    source: "document-inference",
    detail: "Skeleton placeholder: replace with business-specific inference logic.",
  }
}

function runtimeInputDataPathToAbsolute(inputDataRoot: string, filePath: string): string {
  const parts = filePath
    .split(/[\\/]+/)
    .filter(Boolean)
  if (parts[0] === "\u8f93\u5165\u6570\u636e") parts.shift()
  return join(inputDataRoot, ...parts)
}

function isValidTimeArgumentValue(value: string | number | boolean): boolean {
  if (typeof value === "number") return Number.isFinite(value)
  if (typeof value !== "string") return false
  const trimmed = value.trim()
  return Boolean(trimmed && Number.isFinite(Number(trimmed)))
}

function validateGeneratedStepArguments(input: {
  keywordDef: KeywordDefinition
  resolvedArguments: ResolvedArgument[]
  generatedDataFiles: GeneratedDataFile[]
  inputDataRoot: string
  dataGenerationPlan?: CaseStepDataGenerationPlan
}): ArgumentQualityResult {
  const { keywordDef, resolvedArguments, generatedDataFiles, inputDataRoot, dataGenerationPlan } = input
  const issues: ArgumentQualityIssue[] = []
  const expectedCount = keywordDef.arguments.length
  const actualCount = resolvedArguments.length

  if (expectedCount !== actualCount) {
    issues.push({
      severity: "error",
      type: "argument_count_mismatch",
      message: `Keyword ${keywordDef.keywordName} expects ${expectedCount} arguments, but ${actualCount} were resolved.`,
    })
  }

  for (const argumentDef of keywordDef.arguments) {
    const resolved = resolvedArguments.find((argument) => argument.name === argumentDef.name)
    const semantic = inferKeywordArgumentSemantic(keywordDef, argumentDef, dataGenerationPlan)
    if (!resolved) {
      issues.push({
        severity: "error",
        type: "missing_argument",
        argument_name: argumentDef.name,
        message: `Argument ${argumentDef.name} was not resolved for keyword ${keywordDef.keywordName}.`,
      })
      continue
    }

    if ((resolved.confidence ?? 1) < 0.35) {
      issues.push({
        severity: "warning",
        type: "low_confidence",
        argument_name: argumentDef.name,
        message: `Argument ${argumentDef.name} was resolved with low confidence ${resolved.confidence}.`,
      })
    }

    if (semantic === "time" && !isValidTimeArgumentValue(resolved.value)) {
      issues.push({
        severity: "error",
        type: "invalid_time",
        argument_name: argumentDef.name,
        message: `Argument ${argumentDef.name} must be a numeric execution time.`,
      })
    }

    if (semantic === "file_path") {
      const value = String(resolved.value)
      const generatedFile = generatedDataFiles.find((file) => file.argument_name === argumentDef.name)
      if (!value.trim() || /^TODO$/i.test(value.trim()) || !generatedFile) {
        issues.push({
          severity: "error",
          type: "unresolved_file_argument",
          argument_name: argumentDef.name,
          message: `File argument ${argumentDef.name} was not materialized for keyword ${keywordDef.keywordName}.`,
        })
        if (!value.trim() || /^TODO$/i.test(value.trim())) continue
      }
      if (!/\.txt$/i.test(value) || value.includes("/") || !/\\\\/.test(value)) {
        issues.push({
          severity: "error",
          type: "invalid_file_path",
          argument_name: argumentDef.name,
          message: `File argument ${argumentDef.name} must be a Robot-facing .txt path with double backslashes.`,
        })
      }

      const absolutePath = generatedFile?.file_path
        ? runtimeInputDataPathToAbsolute(inputDataRoot, generatedFile.file_path)
        : runtimeInputDataPathToAbsolute(inputDataRoot, value)
      if (!existsSync(absolutePath)) {
        issues.push({
          severity: "error",
          type: "missing_file_artifact",
          argument_name: argumentDef.name,
          message: `File argument ${argumentDef.name} points to a missing data file: ${value}.`,
        })
      }
    }
  }

  const hasError = issues.some((issue) => issue.severity === "error")
  const hasWarning = issues.some((issue) => issue.severity === "warning")
  return {
    status: hasError ? "failed" : hasWarning ? "warning" : "pass",
    expected_argument_count: expectedCount,
    actual_argument_count: actualCount,
    issues,
  }
}

function deriveNameFromBusiness(intent: DataFileIntent): string {
  if (intent.requestedFileName) return `${cleanGeneratedDataFileBaseName(intent.requestedFileName) || "unnamed"}.txt`
  const stem = intent.stepDescription?.match(/[\w-]+/g)?.join("-") || intent.keywordName
  return `${cleanGeneratedDataFileBaseName(stem) || "unnamed"}.txt`
}

function decideBusinessPath(intent: DataFileIntent, requestedName: string, flowDirection: FlowDirection = "input"): string {
  return join(flowDirectoryName(flowDirection), requestedName)
}

function buildPacketContent(intent: DataFileIntent, docsContext: DocsContext): string {
  const candidate = findPacketModelCandidate(intent)
  if (candidate) {
    return buildPacketContentFromModel(intent, candidate)
  }

  const lines = [
    `# keyword: ${intent.keywordName}`,
    `# requested-file: ${intent.requestedFileName ?? "generated"}`,
    `# time: ${String(intent.timeValue ?? "")}`,
    `# docs-used: ${[
      docsContext.hardwareDocs.length ? "hardware" : "",
      docsContext.protocolDocs.length ? "protocol" : "",
      docsContext.conventionDocs.length ? "convention" : "",
      docsContext.packetStructureDocs.length ? "packet-structure" : "",
      docsContext.formatRuleDocs.length ? "format-rules" : "",
      docsContext.backgroundDocs.length ? "background" : "",
    ]
      .filter(Boolean)
      .join(", ")}`,
    "# TODO: replace this skeleton payload with real packet serialization",
    "AA 55 00 00 00 00 FF",
  ]
  return lines.join("\n")
}

export function resolveDefaultPaths(workspaceRoot: string): DefaultPaths {
  const matrixDataDir = join(workspaceRoot, ".matrix", "data")
  const dtpArtifactsDir = join(matrixDataDir, "dtp-generation")
  const dtpRoot = join(matrixDataDir, "DTPProject")
  const runtimeDir = "V1"

  return {
    workspaceRoot,
    matrixDataDir,
    dtpArtifactsDir,
    todoFile: join(matrixDataDir, "test-cases-todo.txt"),
    confirmationFile: join(matrixDataDir, "confirmation-tests.json"),
    generatedDataFile: join(dtpArtifactsDir, "generated-test-data.json"),
    generatedDiagnosticsIndexFile: join(dtpArtifactsDir, "generated-test-data-diagnostics.json"),
    generatedCasesDir: join(dtpArtifactsDir, "cases"),
    generatedDiagnosticsDir: join(dtpArtifactsDir, "diagnostics"),
    generatedArgumentRetryContextFile: join(dtpArtifactsDir, "dtp-argument-retry-context.json"),
    generatedDataFilesIndexFile: join(dtpArtifactsDir, "generated-data-files-index.json"),
    projectKnowledgeIndexFile: join(dtpArtifactsDir, "project-knowledge-index.json"),
    tableEvidenceIndexFile: join(dtpArtifactsDir, "dtp-table-evidence-index.json"),
    documentReferenceGraphFile: join(dtpArtifactsDir, "document-reference-graph.json"),
    protocolEvidenceTraceFile: join(dtpArtifactsDir, "protocol-evidence-trace.json"),
    documentCacheDir: join(dtpArtifactsDir, "document-cache"),
    knowledgePackageManifestFile: join(dtpArtifactsDir, "knowledge-package-manifest.json"),
    commandDictionaryIndexFile: join(dtpArtifactsDir, "command-dictionary-index.json"),
    dtpProtocolDefinitionsFile: join(dtpArtifactsDir, "dtp-protocol-definitions.json"),
    dtpProtocolWriterPreviewFile: join(dtpArtifactsDir, "dtp-protocol-writer-preview.json"),
    dtpDataQualityReportFile: join(dtpArtifactsDir, "dtp-data-generation-quality-report.json"),
    dtpProtocolRetryContextFile: join(dtpArtifactsDir, "dtp-protocol-retry-context.json"),
    dtpPerformanceReportFile: join(dtpArtifactsDir, "dtp-data-generation-performance-report.json"),
    dtpCasePerformanceReportFile: join(dtpArtifactsDir, "dtp-case-data-generation-performance-report.json"),
    dtpModelCacheFile: join(dtpArtifactsDir, "dtp-data-model-cache.json"),
    dtpModelCacheEntriesDir: join(dtpArtifactsDir, "model-cache-entries"),
    generatedDataFilesIndexCasesDir: join(dtpArtifactsDir, "generated-data-files-index-cases"),
    dtpRoot,
    runtimeDir,
    inputDataRoot: join(dtpRoot, runtimeDir, "\u8f93\u5165\u6570\u636e"),
    keywordDir: findKeywordDir(dtpRoot),
  }
}

export function loadTodoCaseIds(todoFile: string): TodoCaseId[] {
  if (!existsSync(todoFile)) {
    throw new Error(`Todo file not found: ${todoFile}`)
  }

  return decodeTextFile(todoFile)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

export function loadConfirmationCasesWithStatus(confirmationFile: string): ConfirmationCaseLoadResult {
  if (!existsSync(confirmationFile)) {
    throw new Error(`Confirmation file not found: ${confirmationFile}`)
  }

  const raw = readJsonFile(confirmationFile)
  const root = isRecord(raw) ? raw : {}
  const rawCases = getNestedArray(root, ["test_cases", "cases", "\u6d4b\u8bd5\u7528\u4f8b"])
  const cases: ConfirmationCaseIndex = new Map()
  const skippedCases = new Map<string, SkippedConfirmationCase>()

  for (const rawCase of rawCases) {
    if (!isRecord(rawCase)) continue
    const caseId = getFirstString(rawCase, ["case_id", "caseId", "\u7528\u4f8b\u7f16\u53f7"])
    if (!caseId) continue
    const normalizedCaseId = normalizeCaseId(caseId)
    const testEnvironment = getFirstString(rawCase, ["test_environment", "testEnvironment", "\u6d4b\u8bd5\u73af\u5883"])
    if (testEnvironment?.replace(/\s+/g, "") === HARDWARE_TEST_ENVIRONMENT) {
      skippedCases.set(normalizedCaseId, {
        caseId: normalizedCaseId,
        translateStatus: getFirstString(rawCase, ["translate_status", "translateStatus"]),
        reason: `test_environment is ${HARDWARE_TEST_ENVIRONMENT}`,
      })
      continue
    }
    const translateStatus = getFirstString(rawCase, ["translate_status", "translateStatus"])
    if (translateStatus !== "success") {
      skippedCases.set(normalizedCaseId, {
        caseId: normalizedCaseId,
        translateStatus,
        reason: translateStatus
          ? `translate_status is ${translateStatus}`
          : "translate_status is missing",
      })
      continue
    }

    const stepsSource = getNestedArray(rawCase, ["test_step", "steps", "\u6b65\u9aa4"])
    const steps: ConfirmationStep[] = stepsSource.map((rawStep, stepOffset) => {
      const record = isRecord(rawStep) ? rawStep : {}
      return {
        stepIndex: stepOffset + 1,
        keywordName: getFirstString(record, ["key_name", "keyword_name", "keywordName", "\u5173\u952e\u5b57\u540d\u79f0"]) || "\u63cf\u8ff0",
        stepDescription: sanitizeOptionalExecutableText(
          getFirstString(record, ["step_desc", "step_description", "stepDesc", "\u6b65\u9aa4\u63cf\u8ff0"]),
        ),
        expectedResult: sanitizeOptionalExecutableText(
          getFirstString(record, ["expected_result", "expectedResult", "\u9884\u671f\u7ed3\u679c"]),
        ),
        timeValue: extractTimeOnly(record),
        raw: rawStep,
      }
    })

    cases.set(normalizedCaseId, {
      caseId: normalizedCaseId,
      caseName: getFirstString(rawCase, ["case_name", "caseName", "\u7528\u4f8b\u540d\u79f0"]),
      testPurpose: getFirstString(rawCase, ["test_purpose", "testPurpose", "\u6d4b\u8bd5\u76ee\u7684"]),
      testEnvironment,
      translateStatus: "success",
      steps,
      raw: rawCase,
    })
  }

  return { cases, skippedCases }
}

export function loadConfirmationCases(confirmationFile: string): ConfirmationCaseIndex {
  return loadConfirmationCasesWithStatus(confirmationFile).cases
}



function parseKeywordArguments(rawKeyword: Record<string, unknown>): KeywordArgumentDef[] {
  const argumentsList: KeywordArgumentDef[] = []
  for (const item of getNestedArray(rawKeyword, ["Arguments", "arguments"])) {
    if (!isRecord(item)) continue
    const name = getFirstString(item, ["Name", "name"]) || ""
    if (!name) continue
    argumentsList.push({
      name,
      comments: getFirstString(item, ["Comments", "comments"]),
      required: true,
    })
  }
  return argumentsList
}

function extractKeywordTextBlock(rawText: string, keywordName: string): string {
  const lines = rawText.split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim() === keywordName)
  if (start < 0) return rawText

  const block: string[] = []
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index]
    if (index > start && line.trim() && !/^\s/.test(line)) break
    block.push(line)
  }
  return block.join("\n")
}

function keywordDocumentation(rawKeyword: Record<string, unknown>, rawText: string): string | undefined {
  const fromJson = getFirstString(rawKeyword, ["Comments", "comments", "Documentation", "documentation"])
  if (fromJson) return fromJson
  return rawText.match(/\[Documentation\]\s+(.+)/)?.[1]?.trim()
}

export function loadKeywordCatalog(keywordDir: string): KeywordCatalog {
  const catalog: KeywordCatalog = new Map()
  const entries = readdirSync(keywordDir, { withFileTypes: true })
  const byBaseName = new Map<string, { jsonPath?: string; txtPath?: string }>()

  for (const entry of entries) {
    if (!entry.isFile()) continue
    const fullPath = join(keywordDir, entry.name)
    const baseName = entry.name.replace(/\.(json|txt)$/i, "")
    const pair = byBaseName.get(baseName) ?? {}
    if (entry.name.toLowerCase().endsWith(".json")) pair.jsonPath = fullPath
    if (entry.name.toLowerCase().endsWith(".txt")) pair.txtPath = fullPath
    byBaseName.set(baseName, pair)
  }

  for (const pair of byBaseName.values()) {
    if (!pair.jsonPath || !pair.txtPath) continue

    const rawJson = readJsonFile(pair.jsonPath)
    const jsonRecord = isRecord(rawJson) ? rawJson : {}
    const rawText = decodeTextFile(pair.txtPath)
    const rawKeywordItems = getNestedArray(jsonRecord, ["Items", "items"])
    const keywordRecords = rawKeywordItems.filter(isRecord)
    if (!keywordRecords.length) keywordRecords.push(jsonRecord)

    for (const rawKeyword of keywordRecords) {
      const keywordName = getFirstString(rawKeyword, ["Name", "name"])
      if (!keywordName) continue

      const keywordText = extractKeywordTextBlock(rawText, keywordName)
      catalog.set(keywordName, {
        keywordName,
        txtPath: pair.txtPath,
        jsonPath: pair.jsonPath,
        documentation: keywordDocumentation(rawKeyword, keywordText),
        arguments: parseKeywordArguments(rawKeyword),
        rawJson: rawKeyword,
        rawText: keywordText,
      })
    }
  }

  return catalog
}

export function buildProjectKnowledgeIndex(paths: DefaultPaths, _docsContext: DocsContext): ProjectKnowledgeIndex {
  const primaryDocs = discoverThirdPartyRequirementDocs(paths.workspaceRoot)
  const allDocs = primaryDocs
  const documents = allDocs.map((filePath, index) => {
    return createKnowledgeDocument(filePath, "primary-third-party-test-requirement", index)
  })

  const warnings: string[] = []
  if (primaryDocs.length === 0) {
    warnings.push("No document whose filename contains third-party test requirement was found.")
  }
  if (documents.length === 0) {
    warnings.push("Project knowledge index has no source documents yet.")
  }

  return {
    schema_version: "1.0.0",
    extractor_version: PROJECT_KNOWLEDGE_EXTRACTOR_VERSION,
    project_root: paths.workspaceRoot,
    source_documents: documents,
    topics: defaultKnowledgeTopics(documents.map((document) => document.id)),
    snippets: [],
    tables: [],
    section_protocol_models: [],
    packet_model_candidates: [],
    references: createPlaceholderReferences(documents),
    warnings,
    updated_at: new Date().toISOString(),
  }
}

function buildPortableKnowledgeContentHash(index: ProjectKnowledgeIndex): string {
  const stableKnowledge = {
    extractor_version: index.extractor_version,
    source_documents: index.source_documents.map((document) => ({
      id: document.id,
      file_name: document.file_name,
      role: document.role,
      type: document.type,
      size_bytes: document.size_bytes,
      content_hash: document.content_hash,
      parse_state: document.parse_state,
    })),
    topics: index.topics,
    snippets: index.snippets,
    tables: index.tables,
    section_protocol_models: index.section_protocol_models.map((model) => ({
      id: model.id,
      source_document_id: model.source_document_id,
      section_id: model.section_id,
      section_title: model.section_title,
      section_path: model.section_path,
      chapter_role: model.chapter_role,
      content_role: model.content_role,
      section_snippet_ids: model.section_snippet_ids,
      input_flow_snippet_ids: model.input_flow_snippet_ids,
      output_flow_snippet_ids: model.output_flow_snippet_ids,
      table_ids: model.table_ids,
      primary_table_ids: model.primary_table_ids,
      support_table_ids: model.support_table_ids,
    })),
    packet_model_candidates: index.packet_model_candidates,
    references: index.references,
  }
  return `sha256:${createHash("sha256").update(JSON.stringify(stableKnowledge)).digest("hex")}`
}

function parsePortableKnowledgeMetadata(value: unknown): PortableKnowledgeMetadata | undefined {
  if (!isRecord(value)) return undefined
  const sourceProjectRoot = asString(value.source_project_root)
  const extractorVersion = asString(value.extractor_version)
  const contentHash = asString(value.content_hash)
  const createdAt = asString(value.created_at)
  if (!sourceProjectRoot || !extractorVersion || !contentHash || !createdAt) return undefined
  return {
    package_version: "1.0.0",
    source_project_root: sourceProjectRoot,
    extractor_version: extractorVersion,
    content_hash: contentHash,
    created_at: createdAt,
  }
}

function updatePortableKnowledgeMetadata(index: ProjectKnowledgeIndex): void {
  index.portable_metadata = {
    package_version: "1.0.0",
    source_project_root: index.portable_metadata?.source_project_root ?? index.project_root,
    extractor_version: index.extractor_version,
    content_hash: buildPortableKnowledgeContentHash(index),
    created_at: index.portable_metadata?.created_at ?? new Date().toISOString(),
  }
}

function docsContextHasEntries(docsContext: DocsContext): boolean {
  return Object.values(docsContext).some((entries) => entries.length > 0)
}

export function loadProjectKnowledgeIndex(indexFile: string, paths: DefaultPaths): ProjectKnowledgeIndex | null {
  if (!existsSync(indexFile)) return null

  try {
    const parsed = readJsonFile(indexFile)
    if (!isRecord(parsed)) return null
    return {
      schema_version: "1.0.0",
      extractor_version: asString(parsed.extractor_version) ?? "",
      project_root: asString(parsed.project_root) ?? paths.workspaceRoot,
      portable_metadata: parsePortableKnowledgeMetadata(parsed.portable_metadata),
      source_documents: getNestedArray(parsed, ["source_documents"])
        .map((item) => (isRecord(item) ? item : null))
        .filter((item): item is Record<string, unknown> => Boolean(item))
        .map((item, index) => ({
          id: asString(item.id) ?? `doc-${index + 1}`,
          path: asString(item.path) ?? "",
          file_name: asString(item.file_name) ?? fileNameOf(asString(item.path) ?? ""),
          role: (asString(item.role) as ProjectKnowledgeDocument["role"]) ?? "explicit-supporting-document",
          type: (asString(item.type) as ProjectKnowledgeDocument["type"]) ?? "unknown",
          size_bytes: asNumber(item.size_bytes),
          modified_time: asString(item.modified_time),
          content_hash: asString(item.content_hash),
          parse_state: (asString(item.parse_state) as ProjectKnowledgeDocument["parse_state"]) ?? "metadata-only",
          warnings: getNestedArray(item, ["warnings"])
            .map((warning) => asString(warning))
            .filter((warning): warning is string => Boolean(warning)),
        })),
      topics: getNestedArray(parsed, ["topics"]) as ProjectKnowledgeTopic[],
      snippets: getNestedArray(parsed, ["snippets"]) as ProjectKnowledgeSnippet[],
      tables: getNestedArray(parsed, ["tables"])
        .map((item) => (isRecord(item) ? item : null))
        .filter((item): item is Record<string, unknown> => Boolean(item))
        .map((item) => ({
          id: asString(item.id) ?? "",
          source_document_id: asString(item.source_document_id) ?? "",
          caption: asString(item.caption),
          aliases: getNestedArray(item, ["aliases"])
            .map((alias) => asString(alias))
            .filter((alias): alias is string => Boolean(alias)),
          topic: (asString(item.topic) as ProjectKnowledgeTopic["topic"]) ?? "background_knowledge",
          rows: getNestedArray(item, ["rows"]).filter(Array.isArray) as string[][],
          table_html: asString(item.table_html),
          cells: getNestedArray(item, ["cells"])
            .map((cell) => (isRecord(cell) ? cell : null))
            .filter((cell): cell is Record<string, unknown> => Boolean(cell))
            .map((cell) => ({
              row: asNumber(cell.row) ?? 0,
              col: asNumber(cell.col) ?? 0,
              text: asString(cell.text) ?? "",
              ...(asNumber(cell.rowspan) ? { rowspan: asNumber(cell.rowspan) } : {}),
              ...(asNumber(cell.colspan) ? { colspan: asNumber(cell.colspan) } : {}),
              ...(typeof cell.is_header === "boolean" ? { is_header: cell.is_header } : {}),
            })),
          confidence: asNumber(item.confidence) ?? 0.5,
          warnings: getNestedArray(item, ["warnings"])
            .map((warning) => asString(warning))
            .filter((warning): warning is string => Boolean(warning)),
        })),
      section_protocol_models: getNestedArray(parsed, ["section_protocol_models"]) as SectionProtocolModel[],
      packet_model_candidates: getNestedArray(parsed, ["packet_model_candidates"]) as PacketModelCandidate[],
      references: getNestedArray(parsed, ["references"]) as ProjectKnowledgeReference[],
      warnings: getNestedArray(parsed, ["warnings"])
        .map((warning) => asString(warning))
        .filter((warning): warning is string => Boolean(warning)),
      updated_at: asString(parsed.updated_at) ?? new Date().toISOString(),
    }
  } catch {
    return null
  }
}

export function writeProjectKnowledgeIndex(indexFile: string, index: ProjectKnowledgeIndex): void {
  ensureDirectory(dirname(indexFile))
  index.updated_at = new Date().toISOString()
  updatePortableKnowledgeMetadata(index)
  writeFileSync(indexFile, `${JSON.stringify(index, null, 2)}\n`, "utf-8")
}

export async function prepareProjectKnowledgeIndex(
  paths: DefaultPaths,
  docsContext: DocsContext,
  options: DtpDataGenerationOptions = {},
): Promise<ProjectKnowledgeIndex> {
  const knowledgeMode = options.knowledgeMode ?? "source"
  if (knowledgeMode === "offline") {
    if (!existsSync(paths.projectKnowledgeIndexFile)) {
      throw new Error(
        `Offline knowledge mode requires an existing project knowledge index: ${paths.projectKnowledgeIndexFile}`,
      )
    }

    const manifestWarnings = inspectTrustedKnowledgePackageManifest(paths)
    let rawIndex: unknown
    try {
      rawIndex = readJsonFile(paths.projectKnowledgeIndexFile)
    } catch {
      throw new Error(`Offline project knowledge index is malformed: ${paths.projectKnowledgeIndexFile}`)
    }
    if (!isRecord(rawIndex)) {
      throw new Error(`Offline project knowledge index is malformed: ${paths.projectKnowledgeIndexFile}`)
    }

    const cached = loadProjectKnowledgeIndex(paths.projectKnowledgeIndexFile, paths)
    if (!cached) {
      throw new Error(`Offline project knowledge index is malformed: ${paths.projectKnowledgeIndexFile}`)
    }
    if (
      cached.snippets.length === 0 && cached.tables.length === 0 && cached.section_protocol_models.length === 0
    ) {
      throw new Error("Offline project knowledge index does not contain reusable parsed document evidence.")
    }
    const schemaWarning = rawIndex.schema_version === "1.0.0"
      ? []
      : [`Offline project knowledge index schema ${String(rawIndex.schema_version ?? "missing")} differs from 1.0.0; trusted reuse continued.`]
    const extractorWarning = cached.extractor_version === PROJECT_KNOWLEDGE_EXTRACTOR_VERSION
      ? []
      : [`Offline project knowledge index extractor version ${cached.extractor_version || "missing"} differs from ${PROJECT_KNOWLEDGE_EXTRACTOR_VERSION}; trusted reuse continued.`]
    const portableMetadataWarning = cached.portable_metadata
      ? ["Offline trusted reuse skipped portable content-hash validation."]
      : []
    const docsWarning = docsContextHasEntries(docsContext)
      ? ["Document arguments were ignored because offline knowledge mode does not read source documents."]
      : []
    const refreshed = refreshPacketModelCandidates(cached)
    resolveKnowledgeReferences(refreshed)
    const rebound: ProjectKnowledgeIndex = {
      ...refreshed,
      project_root: paths.workspaceRoot,
      portable_metadata: cached.portable_metadata,
      warnings: uniqueStrings([
        ...refreshed.warnings,
        "Offline trusted knowledge mode reused project-knowledge-index.json without scanning source documents.",
        ...schemaWarning,
        ...extractorWarning,
        ...portableMetadataWarning,
        ...manifestWarnings,
        ...docsWarning,
      ]),
    }
    writeDtpTableEvidenceIndex(paths.tableEvidenceIndexFile, buildDtpTableEvidenceIndex(rebound))
    return rebound
  }

  const current = buildProjectKnowledgeIndex(paths, docsContext)
  const cached = loadProjectKnowledgeIndex(paths.projectKnowledgeIndexFile, paths)

  if (!cached) {
    const enriched = await enrichKnowledgeIndexWithDocumentText(current, paths)
    persistProjectKnowledgeArtifacts(paths, enriched)
    return enriched
  }

  const cachedPrimaryDocuments = cached.source_documents.filter(
    (document) => document.role === "primary-third-party-test-requirement",
  )
  const currentPrimaryDocuments = current.source_documents.filter(
    (document) => document.role === "primary-third-party-test-requirement",
  )
  const currentPrimaryHashes = new Map(
    currentPrimaryDocuments.map((document) => [resolve(document.path), document.content_hash]),
  )
  const primaryDocumentsChanged =
    cachedPrimaryDocuments.length !== currentPrimaryDocuments.length ||
    cachedPrimaryDocuments.some((document) => (
      currentPrimaryHashes.get(resolve(document.path)) !== document.content_hash
    ))
  const referencedDocumentChanged = cached.source_documents
    .filter((document) => document.role === "referenced-document")
    .some((document) => !existsSync(document.path) || getFileContentHash(document.path) !== document.content_hash)
  const referencedDocumentBecameAvailable = hasNewResolvableRequirementSpecification(cached)
  const isStale =
    cached.extractor_version !== PROJECT_KNOWLEDGE_EXTRACTOR_VERSION ||
    cached.project_root !== paths.workspaceRoot ||
    primaryDocumentsChanged ||
    referencedDocumentChanged ||
    referencedDocumentBecameAvailable

  if (isStale) {
    const enriched = await enrichKnowledgeIndexWithDocumentText(current, paths)
    persistProjectKnowledgeArtifacts(paths, enriched)
    return enriched
  }

  const refreshed = refreshPacketModelCandidates(cached)
  resolveKnowledgeReferences(refreshed)
  refreshPacketModelCandidates(refreshed)
  resolveKnowledgeReferences(refreshed)
  persistProjectKnowledgeArtifacts(paths, refreshed)
  return refreshed
}

export function writeDtpProtocolDefinitions(definitionsFile: string, definitions: DtpProtocolDefinitionsDocument): void {
  writeDtpProtocolDefinitionsImpl(definitionsFile, definitions)
}

function mergeNonGeneratedTables(items: DtpNonGeneratedTable[]): DtpNonGeneratedTable[] {
  const merged = new Map<string, DtpNonGeneratedTable>()
  for (const item of items) {
    const key = `${item.table_id}\u0000${item.reason}`
    if (!merged.has(key)) merged.set(key, item)
  }
  return Array.from(merged.values())
}

export async function buildDtpProtocolDefinitionsDocument(
  paths: DefaultPaths,
  knowledgeIndex: ProjectKnowledgeIndex,
  modelHooks?: DtpDataModelHooks | null,
): Promise<DtpProtocolDefinitionsDocument> {
  return buildDtpProtocolDefinitionsDocumentImpl(paths, knowledgeIndex, modelHooks)
}

function buildProtocolSourceFingerprint(
  paths: DefaultPaths,
  knowledgeIndex: ProjectKnowledgeIndex,
): NonNullable<DtpProtocolDefinitionsDocument["source_fingerprint"]> {
  const stableKnowledgeSource = {
    extractor_version: knowledgeIndex.extractor_version,
    project_root: knowledgeIndex.project_root,
    source_documents: knowledgeIndex.source_documents.map((document) => ({
      path: document.path,
      modified_time: document.modified_time,
      size_bytes: document.size_bytes,
    })),
  }
  return {
    knowledge_index_hash: createHash("sha256")
      .update(JSON.stringify(stableKnowledgeSource))
      .digest("hex"),
    portable_knowledge_hash: knowledgeIndex.portable_metadata?.content_hash,
    compiler_version: DTP_PROTOCOL_COMPILER_VERSION,
  }
}

function protocolFingerprintMatches(
  definitions: DtpProtocolDefinitionsDocument,
  fingerprint: NonNullable<DtpProtocolDefinitionsDocument["source_fingerprint"]>,
): boolean {
  const cached = definitions.source_fingerprint
  return Boolean(
    cached &&
    (
      cached.portable_knowledge_hash && fingerprint.portable_knowledge_hash
        ? cached.portable_knowledge_hash === fingerprint.portable_knowledge_hash
        : cached.knowledge_index_hash === fingerprint.knowledge_index_hash
    ) &&
    cached.compiler_version === fingerprint.compiler_version,
  )
}

export type EnsureDtpProtocolDefinitionsResult = {
  knowledge_index: ProjectKnowledgeIndex
  protocol_definitions: DtpProtocolDefinitionsDocument
  cache_hit: boolean
  knowledge_mode: DtpKnowledgeMode
  source_document_scan_performed: boolean
  validation: DtpProtocolDefinitionValidationResult
}

export type EnsureDtpProtocolDefinitionsOptions = {
  scope?: "case" | "full_project"
  case_queries?: string[]
  knowledgeMode?: DtpKnowledgeMode
}

export function collectDtpCaseProtocolQueries(workspaceRoot: string): string[] {
  const paths = resolveDefaultPaths(workspaceRoot)
  const caseIds = loadTodoCaseIds(paths.todoFile)
  const caseIndex = loadConfirmationCasesWithStatus(paths.confirmationFile).cases
  const queries: string[] = []
  for (const caseId of caseIds) {
    const testCase = caseIndex.get(caseId)
    if (!testCase) continue
    queries.push(...testCase.steps.map((step) => semanticCaseStepDescription(step.stepDescription)))
  }
  return uniqueStrings(queries.map((query) => query.trim()).filter(Boolean))
}

const INTERFACE_REQUIREMENT_CHAPTER_WARNING =
  "The 数据及接口需求 chapter was not identified; protocol section selection used full-document fallback."

function isInterfaceRequirementHeadingText(value: string): boolean {
  return /^(?:第\s*[一二三四五六七八九十百0-9]+\s*章(?:节)?\s*)?(?:数据\s*(?:及|和|与)\s*接口|接口\s*(?:及|和|与)?\s*数据|硬件接口)(?:需求|要求)?$/
    .test(value.replace(/[：:]$/, "").trim())
}

function inferredInterfaceRequirementRoot(
  knowledgeIndex: ProjectKnowledgeIndex,
  sourceDocumentId: string,
  headingOrdinal: number,
  snippetOrdinals: Map<string, number>,
): string | undefined {
  const numericModels = knowledgeIndex.section_protocol_models
    .filter((model) => model.source_document_id === sourceDocumentId && /^\d+(?:\.\d+)*$/.test(model.section_id ?? ""))
    .map((model) => ({
      model,
      ordinal: Math.min(...model.section_snippet_ids
        .map((id) => snippetOrdinals.get(id) ?? Number.MAX_SAFE_INTEGER)),
    }))
  const followingModel = numericModels
    .filter((item) => item.ordinal > headingOrdinal)
    .sort((left, right) => left.ordinal - right.ordinal)[0]?.model
  const fallbackModel = numericModels
    .slice()
    .sort((left, right) => (left.model.section_id ?? "").localeCompare(right.model.section_id ?? "", undefined, { numeric: true }))[0]?.model
  return (followingModel ?? fallbackModel)?.section_id?.split(".")[0]
}

function interfaceRequirementChapterIds(knowledgeIndex: ProjectKnowledgeIndex): Map<string, string[]> {
  const roots = new Map<string, string[]>()
  const snippetOrdinals = new Map(knowledgeIndex.snippets.map((snippet, index) => [snippet.id, index]))
  for (const [ordinal, snippet] of knowledgeIndex.snippets.entries()) {
    const heading = sectionHeadingOf(snippet)
    const headingTitle = heading?.title ?? snippet.text
    if (!isInterfaceRequirementHeadingText(headingTitle)) continue
    const sectionId = heading?.sectionId ?? inferredInterfaceRequirementRoot(
      knowledgeIndex,
      snippet.source_document_id,
      ordinal,
      snippetOrdinals,
    )
    if (!sectionId) continue
    const documentRoots = roots.get(snippet.source_document_id) ?? []
    documentRoots.push(sectionId)
    roots.set(snippet.source_document_id, uniqueStrings(documentRoots))
  }
  return roots
}

function isInterfaceRequirementProtocolModel(
  model: SectionProtocolModel,
  rootsByDocument: Map<string, string[]>,
): boolean {
  if (model.chapter_role === "interface_requirement") return true
  const interfaceChapterPattern = /(?:数据\s*(?:及|和|与)\s*接口|接口\s*(?:及|和|与)?\s*数据|硬件接口)(?:需求|要求)?/
  if (model.section_path?.some((item) => interfaceChapterPattern.test(item))) return true
  if (interfaceChapterPattern.test(model.section_title)) return true
  const sectionId = model.section_id
  if (!sectionId) return false
  return (rootsByDocument.get(model.source_document_id) ?? [])
    .some((root) => sectionId === root || sectionId.startsWith(`${root}.`))
}

function isExplicitlyNonProtocolSection(model: SectionProtocolModel): boolean {
  const sectionIdentity = [model.section_title, ...(model.section_path ?? [])].join(" ")
  return /圈复杂度|基本复杂度|代码质量|静态分析|编码规范|代码审查|函数行数|测试终止条件/.test(sectionIdentity)
}

function isStructurallyEligibleInterfaceProtocolModel(model: SectionProtocolModel): boolean {
  if (isExplicitlyNonProtocolSection(model) || isRequirementSummaryProtocolModel(model)) return false
  if (
    model.content_role === "frame_definition" && model.primary_table_ids.length > 0 &&
    (model.input_flow_snippet_ids.length > 0 || model.output_flow_snippet_ids.length > 0) &&
    (model.protocols.some(protocol => model.primary_table_ids.includes(protocol.frame_table_id)) ||
      model.protocol_relations.some(relation => model.primary_table_ids.includes(relation.frame_table_id)))
  ) return true
  const sectionIdentity = [model.section_title, ...(model.section_path ?? [])].join(" ")
  return /(?:CAN|SPI|Space\s*Wire|1553B|RS\s*[-_]?\s*422|UART|串口|总线|接口|输入流|输出流|数据流|遥测|遥控|指令|应答|数据块|帧格式|上行数据|下行数据)/i.test(sectionIdentity)
}

function isRequirementSummaryProtocolModel(model: SectionProtocolModel): boolean {
  return model.content_role === "requirement_summary" ||
    /(?:接口)?需求项?(?:总结|汇总)|需求汇总表/.test(model.section_title)
}

function protocolModelNames(
  model: SectionProtocolModel,
  tablesById: Map<string, ProjectKnowledgeTable>,
): string[] {
  return uniqueStrings([
    ...model.protocols.map((protocol) => protocol.name),
    ...model.protocol_relations.map((relation) => relation.preferred_name),
    ...model.primary_table_ids.map((tableId) => tablesById.get(tableId)?.caption),
  ].filter((item): item is string => Boolean(item?.trim())))
}

function protocolModelCanInterfaceLevel(
  model: SectionProtocolModel,
  knowledgeIndex: ProjectKnowledgeIndex,
): "primary" | "secondary" | undefined {
  const identity = inferDtpSectionCanInterfaceIdentity(knowledgeIndex, model)
  return identity.interfaceLevel === "unknown" ? undefined : identity.interfaceLevel
}

function caseProtocolSectionEntity(query: string): string | undefined {
  const compact = query.replace(/\s+/g, "")
  return [
    "遥控指令应答",
    "遥控指令",
    "遥测轮询控制序列",
    "遥测数据",
    "上行数据块",
    "内存读出指令",
    "内存数据轮询控制序列",
    "辅助数据包",
    "机构控制指令",
    "黑体驱动指令",
    "开关指令",
  ].find((entity) => compact.includes(entity))
}

export function selectCaseProtocolSectionIds(
  knowledgeIndex: ProjectKnowledgeIndex,
  queries: string[],
): string[] {
  if (!queries.length) return knowledgeIndex.section_protocol_models.map((model) => model.id)
  const snippetsById = new Map(knowledgeIndex.snippets.map((snippet) => [snippet.id, snippet.text]))
  const tablesById = new Map(knowledgeIndex.tables.map((table) => [table.id, table]))
  const rootsByDocument = interfaceRequirementChapterIds(knowledgeIndex)
  const interfaceModels = knowledgeIndex.section_protocol_models.filter(
    (model) => isInterfaceRequirementProtocolModel(model, rootsByDocument),
  )
  const referencedTableIds = new Set(
    knowledgeIndex.references
      .filter((reference) => reference.state === "resolved" || reference.state === "fallback_resolved")
      .flatMap((reference) => reference.resolved_table_ids ?? (reference.resolved_table_id ? [reference.resolved_table_id] : [])),
  )
  const referencedModels = knowledgeIndex.section_protocol_models.filter((model) =>
    !isExplicitlyNonProtocolSection(model) && model.table_ids.some((tableId) => referencedTableIds.has(tableId)),
  )
  if (!interfaceModels.length) {
    knowledgeIndex.warnings = uniqueStrings([
      ...knowledgeIndex.warnings,
      INTERFACE_REQUIREMENT_CHAPTER_WARNING,
    ])
  } else {
    knowledgeIndex.warnings = knowledgeIndex.warnings.filter(
      (warning) => warning !== INTERFACE_REQUIREMENT_CHAPTER_WARNING,
    )
  }
  const structuralFallbackModels = knowledgeIndex.section_protocol_models.filter(isStructurallyEligibleInterfaceProtocolModel)
  const exactFrameModels = structuralFallbackModels.filter(model => (
    model.content_role === "frame_definition" && model.primary_table_ids.length > 0 &&
    protocolModelNames(model, tablesById).some(name => {
      const normalizedName = normalizeProtocolMatchText(name)
      return normalizedName.length >= 4 && queries.some(query => normalizeProtocolMatchText(query).includes(normalizedName))
    })
  ))
  const candidateModels = interfaceModels.length
    ? uniqueStrings([...interfaceModels, ...referencedModels, ...exactFrameModels].map((model) => model.id))
        .map((id) => knowledgeIndex.section_protocol_models.find((model) => model.id === id))
        .filter((model): model is SectionProtocolModel => Boolean(model))
    : structuralFallbackModels.length
      ? uniqueStrings([...structuralFallbackModels, ...referencedModels].map((model) => model.id))
          .map((id) => knowledgeIndex.section_protocol_models.find((model) => model.id === id))
          .filter((model): model is SectionProtocolModel => Boolean(model))
      : knowledgeIndex.section_protocol_models
  const interfaceLevelByModelId = new Map(candidateModels.map((model) => [
    model.id,
    protocolModelCanInterfaceLevel(model, knowledgeIndex),
  ]))
  const normalizedQueries = queries.map(normalizeProtocolMatchText).filter(Boolean)
  const selectedIds = new Set<string>()

  for (const query of normalizedQueries) {
    const queryInterface = canInterfaceConstraintFromEvidence(query)
    const ranked = candidateModels.map((model, index) => {
      const sectionText = [
        model.section_title,
        ...model.section_snippet_ids.map((id) => snippetsById.get(id)),
      ].filter(Boolean).join(" ")
      const normalizedSection = normalizeProtocolMatchText(sectionText)
      let score = 0
      const normalizedTitle = normalizeProtocolMatchText(model.section_title)
      const exactProtocolNames = protocolModelNames(model, tablesById)
        .map(normalizeProtocolMatchText)
        .filter((name) => name.length >= 4 && query.includes(name))
      if (exactProtocolNames.length) {
        score = 3_000 + Math.max(...exactProtocolNames.map((name) => name.length))
      } else if (normalizedTitle && (query.includes(normalizedTitle) || normalizedTitle.includes(query))) {
        score = 2_000 + Math.min(query.length, normalizedTitle.length)
      } else if (normalizedSection.includes(query) || query.includes(normalizedSection)) {
        score = 1_000 + Math.min(query.length, normalizedSection.length)
      } else {
        score = longestCommonSubstringLength(query, normalizedSection)
      }
      if (model.primary_table_ids.length) score += 300
      if (isInterfaceRequirementProtocolModel(model, rootsByDocument)) score += 100
      if (isRequirementSummaryProtocolModel(model)) score -= 2_000
      const modelInterfaceLevel = queryInterface.level
        ? interfaceLevelByModelId.get(model.id)
        : undefined
      if (queryInterface.level && modelInterfaceLevel && modelInterfaceLevel !== queryInterface.level) {
        score -= 100_000
      }
      return { id: model.id, index, score }
    })
      .sort((left, right) => right.score - left.score || left.index - right.index)
    const topScore = ranked[0]?.score ?? 0
    ranked
      .filter((item, index) => item.score >= 6 && (
        item.score >= 3_000 || index === 0 || item.score >= topScore * 0.75
      ))
      .slice(0, 3)
      .forEach((item) => selectedIds.add(item.id))
  }

  // Generic case wording such as "二级CAN遥控指令正常发送" may not contain
  // the document's full protocol name "遥控指令应答". Add same-scope entity
  // matches before compiling so deterministic protocol selection has the
  // relevant canonical table available instead of inheriting another bus.
  for (const query of queries) {
    const entity = caseProtocolSectionEntity(query)
    if (!entity) continue
    const queryInterface = canInterfaceConstraintFromEvidence(query)
    const entityMatches = candidateModels.filter((model) => {
      const modelText = [
        model.section_title,
        ...protocolModelNames(model, tablesById),
      ].filter(Boolean).join(" ").replace(/\s+/g, "")
      if (!modelText.includes(entity)) return false
      if (!queryInterface.level) return true
      return interfaceLevelByModelId.get(model.id) === queryInterface.level
    })
    entityMatches.forEach((model) => selectedIds.add(model.id))
  }

  // Word extraction splits adjacent input/output flow blocks into separate
  // models even when they share one numbered protocol section. Once one flow
  // is relevant, compile its siblings as a bounded relationship package.
  const selectedSectionKeys = new Set(candidateModels
    .filter((model) => selectedIds.has(model.id) && model.section_id)
    .map((model) => `${model.source_document_id}\u0000${model.section_id}`))
  for (const model of candidateModels) {
    if (!model.section_id) continue
    if (selectedSectionKeys.has(`${model.source_document_id}\u0000${model.section_id}`)) {
      selectedIds.add(model.id)
    }
  }

  return selectedIds.size
    ? candidateModels
      .filter((model) => selectedIds.has(model.id))
      .map((model) => model.id)
    : candidateModels.slice(0, 3).map((model) => model.id)
}

function mergeProtocolDefinitionDocuments(
  cached: DtpProtocolDefinitionsDocument | null,
  compiled: DtpProtocolDefinitionsDocument,
  fingerprint: NonNullable<DtpProtocolDefinitionsDocument["source_fingerprint"]>,
): DtpProtocolDefinitionsDocument {
  if (!cached || !protocolFingerprintMatches(cached, fingerprint)) {
    return {
      ...compiled,
      source_fingerprint: fingerprint,
    }
  }
  const compiledSectionIds = new Set(compiled.sections.map((section) => section.section_model_id))
  const replacedProtocolIds = new Set(
    cached.sections
      .filter((section) => compiledSectionIds.has(section.section_model_id))
      .flatMap((section) => section.protocol_ids),
  )
  const compiledSectionIdsForSelectors = new Set(compiled.sections.map((section) => section.section_model_id))
  return migrateDtpProtocolDefinitionsDocument({
    ...compiled,
    source_fingerprint: fingerprint,
    source: cached.source === compiled.source ? compiled.source : "mixed",
    sections: [
      ...cached.sections.filter((section) => !compiledSectionIds.has(section.section_model_id)),
      ...compiled.sections,
    ],
    protocols: [
      ...cached.protocols.filter((protocol) => !replacedProtocolIds.has(protocol.protocol_id)),
      ...compiled.protocols,
    ],
    selector_relations: [
      ...(cached.selector_relations ?? []).filter((relation) => !compiledSectionIdsForSelectors.has(relation.section_model_id)),
      ...(compiled.selector_relations ?? []),
    ],
    non_generated_tables: mergeNonGeneratedTables([
      ...cached.non_generated_tables,
      ...compiled.non_generated_tables,
    ]),
    warnings: uniqueStrings([...cached.warnings, ...compiled.warnings]),
    updated_at: new Date().toISOString(),
  })
}

export async function ensureDtpProtocolDefinitions(
  workspaceRoot: string,
  docsContext: DocsContext,
  modelHooks?: DtpDataModelHooks | null,
  options: EnsureDtpProtocolDefinitionsOptions = {},
): Promise<EnsureDtpProtocolDefinitionsResult> {
  const paths = resolveDefaultPaths(workspaceRoot)
  const knowledgeMode = options.knowledgeMode ?? "source"
  const preparedKnowledgeIndex = await prepareProjectKnowledgeIndex(paths, docsContext, { knowledgeMode })
  const fingerprint = buildProtocolSourceFingerprint(paths, preparedKnowledgeIndex)
  const cached = loadDtpProtocolDefinitions(
    paths.dtpProtocolDefinitionsFile,
    knowledgeMode === "offline" ? undefined : workspaceRoot,
    {
      allowLegacySchema: knowledgeMode === "offline",
      allowValidationErrors: knowledgeMode === "offline",
    },
  )
  const reusableCached = knowledgeMode === "offline"
    ? cached
    : cached && protocolFingerprintMatches(cached, fingerprint) ? cached : null
  const requestedSectionIds = options.scope === "full_project"
    ? preparedKnowledgeIndex.section_protocol_models.map((model) => model.id)
    : selectCaseProtocolSectionIds(preparedKnowledgeIndex, options.case_queries ?? [])
  const cachedSectionIds = new Set(reusableCached?.sections.map((section) => section.section_model_id) ?? [])
  const missingSectionIds = requestedSectionIds.filter((sectionId) => !cachedSectionIds.has(sectionId))
  if (reusableCached && missingSectionIds.length === 0) {
    const reboundCached: DtpProtocolDefinitionsDocument = {
      ...reusableCached,
      project_root: workspaceRoot,
      knowledge_index_file: paths.projectKnowledgeIndexFile,
      source_fingerprint: fingerprint,
      updated_at: new Date().toISOString(),
    }
    if (knowledgeMode === "source") {
      writeDtpProtocolDefinitions(paths.dtpProtocolDefinitionsFile, reboundCached)
    }
    writeProtocolEvidenceTrace(
      paths.protocolEvidenceTraceFile,
      buildProtocolEvidenceTrace(paths, preparedKnowledgeIndex, reboundCached),
    )
    if (knowledgeMode === "source") writeKnowledgePackageManifest(paths)
    return {
      knowledge_index: preparedKnowledgeIndex,
      protocol_definitions: reboundCached,
      cache_hit: true,
      knowledge_mode: knowledgeMode,
      source_document_scan_performed: knowledgeMode === "source",
      validation: validateDtpProtocolDefinitions(reboundCached),
    }
  }

  const targetSectionIds = reusableCached
    ? new Set(missingSectionIds)
    : new Set(requestedSectionIds)
  const scopedKnowledgeIndex: ProjectKnowledgeIndex = {
    ...preparedKnowledgeIndex,
    section_protocol_models: preparedKnowledgeIndex.section_protocol_models.filter((model) => targetSectionIds.has(model.id)),
  }
  const knowledgeIndex = await applyDtpDataModelUnderstanding(scopedKnowledgeIndex, modelHooks)
  const understoodModels = new Map(knowledgeIndex.section_protocol_models.map((model) => [model.id, model]))
  const persistedKnowledgeIndex: ProjectKnowledgeIndex = {
    ...preparedKnowledgeIndex,
    section_protocol_models: preparedKnowledgeIndex.section_protocol_models.map(
      (model) => understoodModels.get(model.id) ?? model,
    ),
    warnings: uniqueStrings([...preparedKnowledgeIndex.warnings, ...knowledgeIndex.warnings]),
  }
  if (knowledgeMode === "source") persistProjectKnowledgeArtifacts(paths, persistedKnowledgeIndex)
  const compiled = await buildDtpProtocolDefinitionsDocument(paths, knowledgeIndex, modelHooks)
  const protocolDefinitions = mergeProtocolDefinitionDocuments(reusableCached, compiled, fingerprint)
  const validation = validateDtpProtocolDefinitions(protocolDefinitions)
  if (!validation.valid) {
    protocolDefinitions.warnings = uniqueStrings([
      ...protocolDefinitions.warnings,
      ...validation.issues.map((issue) => `[${issue.severity}] ${issue.protocol_id ?? "document"}: ${issue.message}`),
    ])
  }
  writeDtpProtocolDefinitions(paths.dtpProtocolDefinitionsFile, protocolDefinitions)
  writeProtocolEvidenceTrace(
    paths.protocolEvidenceTraceFile,
    buildProtocolEvidenceTrace(paths, persistedKnowledgeIndex, protocolDefinitions),
  )
  if (knowledgeMode === "source") writeKnowledgePackageManifest(paths)
  return {
    knowledge_index: persistedKnowledgeIndex,
    protocol_definitions: protocolDefinitions,
    cache_hit: false,
    knowledge_mode: knowledgeMode,
    source_document_scan_performed: knowledgeMode === "source",
    validation,
  }
}

function createEmptyDataFileIndex(paths: DefaultPaths, sourceDocuments: string[], warnings: string[]): GeneratedDataFileIndex {
  return {
    schema_version: "1.0.0",
    project_root: paths.workspaceRoot,
    dtp_root: paths.dtpRoot,
    runtime_dir: paths.runtimeDir,
    input_data_root: paths.inputDataRoot,
    source_documents: sourceDocuments,
    entries: [],
    warnings,
    updated_at: new Date().toISOString(),
  }
}

function mergeGeneratedDataFileIndexCaseCheckpoints(
  index: GeneratedDataFileIndex,
  paths: DefaultPaths,
): GeneratedDataFileIndex {
  if (!existsSync(paths.generatedDataFilesIndexCasesDir)) return index
  for (const fileName of readdirSync(paths.generatedDataFilesIndexCasesDir)) {
    if (!fileName.endsWith(".json")) continue
    try {
      const parsed = readJsonFile(join(paths.generatedDataFilesIndexCasesDir, fileName))
      if (!isRecord(parsed)) continue
      for (const item of getNestedArray(parsed, ["entries"])) {
        if (!isRecord(item)) continue
        const requestedFileName = asString(item.requested_file_name)
        const filePath = asString(item.file_path)
        if (!requestedFileName || !filePath) continue
        appendDataFileIndexEntry(index, {
          id: asString(item.id) ?? createHash("sha256").update(filePath).digest("hex").slice(0, 16),
          protocol_name: asString(item.protocol_name),
          requested_file_name: requestedFileName,
          file_path: filePath,
          absolute_file_path: asString(item.absolute_file_path) ?? runtimeInputDataPathToAbsolute(paths.inputDataRoot, filePath),
          source: (asString(item.source) as GeneratedDataFileIndexEntry["source"]) ?? "dynamic-generated",
          source_documents: getNestedArray(item, ["source_documents"]).map(asString).filter((value): value is string => Boolean(value)),
          generation_basis: getNestedArray(item, ["generation_basis"]).map(asString).filter((value): value is string => Boolean(value)),
          checksum_rule: asString(item.checksum_rule),
          field_value_plan: parseStoredFieldValuePlan(item.field_value_plan),
          flow_direction: (asString(item.flow_direction) as FlowDirection | undefined) ?? "unknown",
          source_section: asString(item.source_section),
          source_flow_heading: asString(item.source_flow_heading),
          confidence: asNumber(item.confidence) ?? 0.5,
          state: (asString(item.state) as GeneratedDataFileIndexEntry["state"]) ?? "generated",
          warnings: getNestedArray(item, ["warnings"]).map(asString).filter((value): value is string => Boolean(value)),
        })
      }
    } catch {
      continue
    }
  }
  return index
}

function writeGeneratedDataFileIndexCaseCheckpoint(
  paths: DefaultPaths,
  index: GeneratedDataFileIndex,
  caseId: string,
): void {
  const pathToken = `\u7528\u4f8b\u751f\u6210\\${caseId}\\`.toLowerCase()
  const entries = index.entries.filter((entry) => (
    entry.file_path.replace(/[\\/]+/g, "\\").toLowerCase().includes(pathToken)
  ))
  writeJsonAtomically(join(paths.generatedDataFilesIndexCasesDir, generatedCaseArtifactName(caseId)), {
    schema_version: "1.0.0",
    case_id: caseId,
    entries,
    updated_at: new Date().toISOString(),
  })
}

export function loadGeneratedDataFileIndex(
  indexFile: string,
  paths: DefaultPaths,
  options: DtpDataGenerationOptions = {},
): GeneratedDataFileIndex {
  const knowledgeMode = options.knowledgeMode ?? "source"
  const sourceDocuments = knowledgeMode === "offline" ? [] : discoverThirdPartyRequirementDocs(paths.workspaceRoot)
  const warnings = sourceDocuments.length
    ? []
    : knowledgeMode === "source"
      ? ["No third-party test requirement document was found; data files will be generated from step context when needed."]
      : []

  if (!existsSync(indexFile)) {
    return mergeGeneratedDataFileIndexCaseCheckpoints(
      createEmptyDataFileIndex(paths, sourceDocuments, warnings),
      paths,
    )
  }

  try {
    const parsed = readJsonFile(indexFile)
    if (!isRecord(parsed)) return createEmptyDataFileIndex(paths, sourceDocuments, warnings)
    const storedProjectRoot = asString(parsed.project_root)
    const shouldRebase = Boolean(storedProjectRoot && resolve(storedProjectRoot) !== resolve(paths.workspaceRoot))
    const entries = getNestedArray(parsed, ["entries"])
      .map((item) => (isRecord(item) ? item : null))
      .filter((item): item is Record<string, unknown> => Boolean(item))
      .map((item) => ({
        id: asString(item.id) ?? `${Date.now()}-${Math.random()}`,
        protocol_name: asString(item.protocol_name),
        requested_file_name: asString(item.requested_file_name) ?? "",
        file_path: asString(item.file_path) ?? "",
        absolute_file_path: asString(item.absolute_file_path),
        source: (asString(item.source) as GeneratedDataFileIndexEntry["source"]) ?? "existing-file",
        source_documents: getNestedArray(item, ["source_documents"])
          .map((source) => asString(source))
          .filter((source): source is string => Boolean(source)),
        generation_basis: getNestedArray(item, ["generation_basis"])
          .map((basis) => asString(basis))
          .filter((basis): basis is string => Boolean(basis)),
        checksum_rule: asString(item.checksum_rule),
        field_value_plan: parseStoredFieldValuePlan(item.field_value_plan),
        flow_direction: (asString(item.flow_direction) as FlowDirection | undefined) ?? "unknown",
        source_section: asString(item.source_section),
        source_flow_heading: asString(item.source_flow_heading),
        confidence: asNumber(item.confidence) ?? 0.5,
        state: (asString(item.state) as GeneratedDataFileIndexEntry["state"]) ?? "candidate",
        warnings: getNestedArray(item, ["warnings"])
          .map((warning) => asString(warning))
          .filter((warning): warning is string => Boolean(warning)),
      }))
      .filter((entry) => Boolean(entry.requested_file_name && entry.file_path))
      .map((entry) => shouldRebase
        ? {
            ...entry,
            absolute_file_path: runtimeInputDataPathToAbsolute(paths.inputDataRoot, entry.file_path),
          }
        : entry)
      .filter((entry) => !shouldRebase || !entry.absolute_file_path || existsSync(entry.absolute_file_path))
    return mergeGeneratedDataFileIndexCaseCheckpoints({
      schema_version: "1.0.0",
      project_root: paths.workspaceRoot,
      dtp_root: paths.dtpRoot,
      runtime_dir: paths.runtimeDir,
      input_data_root: paths.inputDataRoot,
      source_documents: uniqueStrings([
        ...getNestedArray(parsed, ["source_documents"]).map((item) => asString(item)).filter((item): item is string => Boolean(item)),
        ...sourceDocuments,
      ]),
      entries,
      warnings: uniqueStrings([
        ...getNestedArray(parsed, ["warnings"]).map((item) => asString(item)).filter((item): item is string => Boolean(item)),
        ...warnings,
        ...(shouldRebase
          ? ["Generated data-file index was rebound to the current workspace; missing transferred files were removed."]
          : []),
      ]),
      updated_at: new Date().toISOString(),
    }, paths)
  } catch {
    return createEmptyDataFileIndex(paths, sourceDocuments, [
      ...warnings,
      `Failed to parse existing data-file index: ${indexFile}`,
    ])
  }
}

export function writeGeneratedDataFileIndex(indexFile: string, index: GeneratedDataFileIndex): void {
  index.updated_at = new Date().toISOString()
  writeJsonAtomically(indexFile, index)
}

export function prepareProjectDataFileIndex(
  paths: DefaultPaths,
  docsContext: DocsContext,
  options: DtpDataGenerationOptions = {},
): GeneratedDataFileIndex {
  const index = loadGeneratedDataFileIndex(paths.generatedDataFilesIndexFile, paths, options)
  const offlineKnowledgeDocs = options.knowledgeMode === "offline"
    ? loadProjectKnowledgeIndex(paths.projectKnowledgeIndexFile, paths)?.source_documents.map((document) => document.path) ?? []
    : []
  const explicitDocs = options.knowledgeMode === "offline"
    ? offlineKnowledgeDocs
    : uniqueStrings([
        ...docsContext.backgroundDocs,
        ...docsContext.hardwareDocs,
        ...docsContext.protocolDocs,
        ...docsContext.conventionDocs,
        ...docsContext.packetStructureDocs,
        ...docsContext.formatRuleDocs,
        ...docsContext.requirementDocs,
      ])

  index.source_documents = uniqueStrings([...index.source_documents, ...explicitDocs])
  if (index.source_documents.length === 0) {
    index.warnings.push(
      "No source documents are available for case-level protocol preparation; existing indexed baselines remain optional.",
    )
  }

  writeGeneratedDataFileIndex(paths.generatedDataFilesIndexFile, index)
  return index
}

function normalizeProtocolMatchText(value: string | undefined): string {
  return normalizeLookupText(value)
    .replace(/\u6b63\u786e\u7684|\u6b63\u786e|\u9519\u8bef\u7684|\u9519\u8bef|\u901a\u8fc7|\u603b\u7ebf|\u53d1\u9001|\u8f93\u5165|\u8f93\u51fa|\u95f4\u63a5\u6307\u4ee4|\u63a7\u5236\u6307\u4ee4|\u6d4b\u8bd5\u6307\u4ee4|\u6307\u4ee4|\u8f6f\u4ef6|\u6570\u636e\u6587\u4ef6|\u6587\u4ef6/g, "")
    .replace(/正确的|正确|错误的|错误|通过|总线|发送|输入|输出|间接指令|控制指令|测试指令|指令|软件|数据文件|文件/g, "")
}

function longestCommonSubstringLength(left: string, right: string): number {
  if (!left || !right) return 0
  const previous = new Array(right.length + 1).fill(0)
  let best = 0

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    for (let rightIndex = right.length; rightIndex >= 1; rightIndex -= 1) {
      if (left[leftIndex - 1] === right[rightIndex - 1]) {
        previous[rightIndex] = previous[rightIndex - 1] + 1
        best = Math.max(best, previous[rightIndex])
      } else {
        previous[rightIndex] = 0
      }
    }
  }

  return best
}

function findExactDataFileIndexEntry(
  index: GeneratedDataFileIndex,
  requestedFileName: string,
  semanticText: string,
): GeneratedDataFileIndexEntry | null {
  const requestedKey = normalizeLookupText(requestedFileName)
  const semanticKey = normalizeLookupText(semanticText)
  const candidates = index.entries
    .filter((entry) => entry.source !== "dynamic-generated")
    .flatMap((entry) => uniqueStrings([
      normalizeLookupText(entry.protocol_name),
      normalizeLookupText(entry.requested_file_name),
    ])
      .filter((key) => key.length >= 4)
      .map((key) => ({ entry, key })))
    .filter(({ key }) => (
      Boolean(requestedKey && key === requestedKey) ||
      Boolean(semanticKey && semanticKey.includes(key))
    ))
    .sort((left, right) =>
      Number(Boolean(requestedKey && right.key === requestedKey)) -
        Number(Boolean(requestedKey && left.key === requestedKey)) ||
      right.key.length - left.key.length ||
      right.entry.confidence - left.entry.confidence,
    )

  return candidates[0]?.entry ?? null
}

function findDataFileIndexEntry(
  index: GeneratedDataFileIndex,
  requestedFileName: string,
  semanticText: string,
): GeneratedDataFileIndexEntry | null {
  const exact = findExactDataFileIndexEntry(index, requestedFileName, semanticText)
  if (exact) return exact
  const requestedKey = normalizeLookupText(requestedFileName)
  const semanticKey = normalizeLookupText(semanticText)
  const semanticProtocolKey = normalizeProtocolMatchText(semanticText)
  let bestSemanticMatch: { entry: GeneratedDataFileIndexEntry; score: number } | null = null

  for (const entry of index.entries) {
    if (entry.source === "dynamic-generated") continue
    const entryKeys = [
      normalizeLookupText(entry.requested_file_name),
      normalizeLookupText(entry.protocol_name),
      normalizeLookupText(entry.file_path),
    ]
    if (requestedKey && entryKeys.some((key) => key && (
      key === requestedKey ||
      key.includes(requestedKey) ||
      requestedKey.includes(key)
    ))) {
      return entry
    }
    if (semanticKey && entryKeys.some((key) => key && (semanticKey.includes(key) || key.includes(semanticKey)))) {
      return entry
    }

    const protocolKey = normalizeProtocolMatchText(
      [entry.protocol_name, entry.requested_file_name].filter(Boolean).join(" "),
    )
    const requestedProtocolKey = normalizeProtocolMatchText(requestedFileName)
    const requestedOverlap = requestedProtocolKey ? longestCommonSubstringLength(requestedProtocolKey, protocolKey) : 0
    if (requestedOverlap >= 4) {
      const score = 100 + requestedOverlap + entry.confidence
      if (!bestSemanticMatch || score > bestSemanticMatch.score) {
        bestSemanticMatch = { entry, score }
      }
    }

    const semanticOverlap = semanticProtocolKey ? longestCommonSubstringLength(semanticProtocolKey, protocolKey) : 0
    if (semanticOverlap >= 6) {
      const score = semanticOverlap + entry.confidence
      if (!bestSemanticMatch || score > bestSemanticMatch.score) {
        bestSemanticMatch = { entry, score }
      }
    }

    if (semanticProtocolKey && protocolKey && protocolKey.length >= 4 && semanticProtocolKey.includes(protocolKey)) {
      const score = protocolKey.length + entry.confidence
      if (!bestSemanticMatch || score > bestSemanticMatch.score) {
        bestSemanticMatch = { entry, score }
      }
    }
  }

  return bestSemanticMatch?.entry ?? null
}

function appendDataFileIndexEntry(index: GeneratedDataFileIndex, entry: GeneratedDataFileIndexEntry): void {
  const existing = index.entries.find((item) =>
    entry.file_path
      ? item.file_path === entry.file_path
      : item.id === entry.id,
  )
  if (existing) {
    Object.assign(existing, entry)
    return
  }
  index.entries.push(entry)
}

function parseStoredFieldValuePlan(rawPlan: unknown): PacketFieldValuePlan[] | undefined {
  const rawItems = Array.isArray(rawPlan) ? rawPlan : []
  const allowedSources = new Set<PacketFieldValuePlan["value_source"]>([
    "frame-table",
    "support-table",
    "dictionary-row",
    "enum-option",
    "bitfield-enum",
    "model",
    "fallback-zero",
  ])
  const plan = rawItems
    .map((raw): PacketFieldValuePlan | null => {
      if (!isRecord(raw)) return null
      const fieldName = asString(raw.field_name)?.toUpperCase()
      const value = normalizeHexByte(asString(raw.value))
      const valueSource = asString(raw.value_source) as PacketFieldValuePlan["value_source"] | undefined
      if (!fieldName || !/^W\d+$/.test(fieldName) || !value || !valueSource || !allowedSources.has(valueSource)) {
        return null
      }
      return {
        field_name: fieldName,
        value,
        value_source: valueSource,
        source_table_id: asString(raw.source_table_id),
        source_text: asString(raw.source_text),
        confidence: Math.max(0, Math.min(1, asNumber(raw.confidence) ?? 0.5)),
        reasoning: getNestedArray(raw, ["reasoning"])
          .map((item) => asString(item))
          .filter((item): item is string => Boolean(item)),
      }
    })
    .filter((item): item is PacketFieldValuePlan => Boolean(item))

  return plan.length ? plan : undefined
}

export function generateDataFile(
  intent: DataFileIntent,
  docsContext: DocsContext,
  outputRoot: string,
  dataFileIndex?: GeneratedDataFileIndex,
): GeneratedDataFile {
  const requestedName = deriveNameFromBusiness(intent)
  const semanticText = semanticCaseStepDescription(intent.stepDescription)

  if (dataFileIndex) {
    const existing = findDataFileIndexEntry(dataFileIndex, requestedName, semanticText)
    if (existing) {
      return {
        argument_name: intent.argument.name,
        content_generation_required: false,
        requested_file_name: existing.requested_file_name,
        file_path: existing.file_path,
        generation_basis: existing.generation_basis,
        checksum_rule: existing.checksum_rule,
        field_value_plan: existing.field_value_plan,
        flow_direction: existing.flow_direction,
        source_section: existing.source_section,
        source_flow_heading: existing.source_flow_heading,
        source_file_state: existing.state === "validated" ? "existing-validated-file" : "generated-from-documents",
        format_notes: [
          `Resolved from generated-data-files-index with confidence ${existing.confidence}.`,
          ...existing.warnings,
        ],
      }
    }
  }

  const relativePath = decideBusinessPath(intent, requestedName, "input")
  const fullPath = join(outputRoot, relativePath)
  const robotFilePath = toRuntimeInputDataPath(relativePath)

  ensureDirectory(dirname(fullPath))
  writeFileSync(fullPath, buildPacketContent(intent, docsContext), "utf-8")

  if (dataFileIndex) {
    appendDataFileIndexEntry(dataFileIndex, {
      id: normalizeLookupText(`${intent.keywordName}-${requestedName}`) || requestedName,
      protocol_name: requestedName.replace(/\.txt$/i, ""),
      requested_file_name: requestedName,
      file_path: robotFilePath,
      absolute_file_path: fullPath,
      source: "dynamic-generated",
      source_documents: dataFileIndex.source_documents,
      generation_basis: [
        "step-context",
        "keyword-argument-comment",
        "third-party-test-requirement-index",
      ],
      checksum_rule: DEFAULT_CHECKSUM_RULE,
      flow_direction: "input",
      source_flow_heading: "\u8f93\u5165\u6d41",
      confidence: dataFileIndex.source_documents.length > 0 ? 0.55 : 0.35,
      state: "generated",
      warnings: dataFileIndex.source_documents.length > 0
        ? []
        : ["Generated without parsed project requirement documents; verify packet content before execution."],
    })
  }

  return {
    argument_name: intent.argument.name,
    content_generation_required: true,
    requested_file_name: requestedName,
    file_path: robotFilePath,
    generation_basis: [
      "hardware-interface-document",
      "data-protocol-document",
      "data-convention-document",
      "packet-structure-document",
      "format-validation-rule",
      "project-background-knowledge",
    ],
    checksum_rule: DEFAULT_CHECKSUM_RULE,
    flow_direction: "input",
    source_flow_heading: "\u8f93\u5165\u6d41",
    source_file_state: "name-only-input",
    format_notes: [
      "Skeleton output: replace placeholder payload generation with project-specific packet serialization.",
      "The upstream step contributes only the file name hint and ${time}.",
    ],
  }
}

function normalizeCaseStepVariant(value: string | undefined): CaseStepDataGenerationPlan["variant_type"] {
  const allowed = new Set<CaseStepDataGenerationPlan["variant_type"]>([
    "correct",
    "title_error",
    "checksum_error",
    "arbitration_error",
    "control_error",
    "length_error",
    "field_error",
    "unknown",
  ])
  return allowed.has(value as CaseStepDataGenerationPlan["variant_type"])
    ? value as CaseStepDataGenerationPlan["variant_type"]
    : "unknown"
}

function normalizeChecksumPolicy(value: string | undefined): CaseStepDataGenerationPlan["checksum_policy"] {
  if (value === "preserve" || value === "recalculate_correctly" || value === "make_incorrect" || value === "none") {
    return value
  }
  return "preserve"
}

function normalizePlanFlowDirection(value: string | undefined): FlowDirection {
  return value === "input" || value === "output" || value === "unknown" ? value : "unknown"
}

function normalizePlanOperation(value: string | undefined): CaseStepDataGenerationPlan["operation"] {
  return value === "memory_write" || value === "bus_send" || value === "bus_receive" ? value : undefined
}

function normalizePlanArtifactScope(value: string | undefined): CaseStepDataGenerationPlan["artifact_scope"] {
  return value === "single_block" || value === "full_package" ? value : undefined
}

function normalizePlanSelectedBlock(value: string | undefined): CaseStepDataGenerationPlan["selected_block"] {
  if (value === "start" || value === "start_block" || value === "start-block") return "start-block"
  if (value === "middle" || value === "middle_block" || value === "middle-block") return "middle-block"
  if (value === "check" || value === "check_block" || value === "check-block") return "check-block"
  return undefined
}

function normalizePlanTargetAddress(value: string | undefined): string | undefined {
  const match = value?.trim().match(/^(?:0x)?([0-9A-F]{4,16})H?$/i)
  return match?.[1].toUpperCase()
}

function sanitizePlanBaseBytes(raw: unknown): string[][] | undefined {
  const rows = Array.isArray(raw) && raw.every((item) => Array.isArray(item))
    ? raw as unknown[][]
    : Array.isArray(raw)
      ? [raw]
      : []
  const normalized = rows
    .map((row) => row.map((value) => normalizeHexByte(asString(value))).filter((value): value is string => Boolean(value)))
    .filter((row) => row.length > 0)
  return normalized.length ? normalized : undefined
}

function sanitizeCaseStepDataPlan(
  raw: unknown,
  fallback: CaseStepDataGenerationPlan,
  source: CaseStepDataGenerationPlan["source"],
): CaseStepDataGenerationPlan {
  if (isRecord(raw) && isRecord(raw.plan)) raw = raw.plan
  if (!isRecord(raw)) return fallback
  const hasExplicitMutations = Object.prototype.hasOwnProperty.call(raw, "mutations")
  const hasExplicitSequenceOperations = Object.prototype.hasOwnProperty.call(raw, "sequence_operations") ||
    Object.prototype.hasOwnProperty.call(raw, "sequenceOperations")
  const mutations = getNestedArray(raw, ["mutations"])
    .map((item): CaseStepDataMutation | null => {
      if (!isRecord(item)) return null
      const field = asString(item.field)
      const operation = asString(item.operation)
      const byteIndex = asNumber(item.byte_index) ?? asNumber(item.byteIndex)
      if (!field || !operation || !["replace", "replace_with_invalid_value", "increment", "xor"].includes(operation)) {
        return null
      }
      return {
        field,
        frame_index: (asNumber(item.frame_index) ?? asNumber(item.frameIndex)) !== undefined
          ? Math.max(1, Math.floor(asNumber(item.frame_index) ?? asNumber(item.frameIndex) ?? 1))
          : undefined,
        byte_index: byteIndex !== undefined ? Math.max(0, Math.floor(byteIndex)) : undefined,
        operation: operation as CaseStepDataMutation["operation"],
        value: normalizeHexByte(asString(item.value)),
      }
    })
    .filter((item): item is CaseStepDataMutation => Boolean(item))
  const sequenceOperations = getNestedArray(raw, ["sequence_operations", "sequenceOperations"])
    .map((item): CaseStepSequenceOperation | null => {
      if (!isRecord(item)) return null
      const operation = asString(item.operation)
      if (!operation || !["drop_frame", "repeat_frame", "swap_frames", "append_frame"].includes(operation)) return null
      const frameIndex = asNumber(item.frame_index) ?? asNumber(item.frameIndex)
      const otherFrameIndex = asNumber(item.other_frame_index) ?? asNumber(item.otherFrameIndex)
      const repeatCount = asNumber(item.repeat_count) ?? asNumber(item.repeatCount)
      const bytes = Array.isArray(item.bytes)
        ? item.bytes.map((value) => normalizeHexByte(asString(value))).filter((value): value is string => Boolean(value))
        : undefined
      return {
        operation: operation as CaseStepSequenceOperation["operation"],
        frame_index: frameIndex !== undefined ? Math.max(1, Math.floor(frameIndex)) : undefined,
        other_frame_index: otherFrameIndex !== undefined ? Math.max(1, Math.floor(otherFrameIndex)) : undefined,
        repeat_count: repeatCount !== undefined ? Math.max(1, Math.floor(repeatCount)) : undefined,
        bytes: bytes?.length ? bytes : undefined,
      }
    })
    .filter((item): item is CaseStepSequenceOperation => Boolean(item))
  const argumentValuesRecord = isRecord(raw.argument_values) ? raw.argument_values : {}
  const argumentValues: Record<string, string | number | boolean> = {}
  for (const [name, value] of Object.entries(argumentValuesRecord)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") argumentValues[name] = value
  }
  const rawCommand = isRecord(raw.command) ? raw.command : undefined
  const commandCode = asString(rawCommand?.code) ?? asString(raw.command_code) ?? fallback.command?.code
  const commandName = asString(rawCommand?.name) ?? asString(raw.command_name) ?? fallback.command?.name
  const commandSourceTableId = asString(rawCommand?.source_table_id) ??
    asString(raw.command_source_table_id) ??
    fallback.command?.source_table_id
  const command = commandCode && commandName && commandSourceTableId
    ? {
      code: commandCode,
      name: commandName,
      source_table_id: commandSourceTableId,
      source_table_caption: asString(rawCommand?.source_table_caption) ??
        asString(raw.command_source_table_caption) ??
        fallback.command?.source_table_caption,
      selection_source: asString(rawCommand?.selection_source) === "document_order_default"
        ? "document_order_default"
        : fallback.command?.selection_source,
    }
    : undefined

  return {
    protocol_id: asString(raw.protocol_id) ??
      asString(raw.canonical_protocol_id) ??
      asString(raw.canonicalProtocolId) ??
      fallback.protocol_id,
    protocol_name: asString(raw.protocol_name) ?? fallback.protocol_name,
    command,
    payload_length_bytes: (() => {
      const value = asNumber(raw.payload_length_bytes) ?? asNumber(raw.payloadLengthBytes)
      return value !== undefined && value > 0 ? Math.floor(value) : fallback.payload_length_bytes
    })(),
    related_message_length_bytes: (() => {
      const value = asNumber(raw.related_message_length_bytes) ?? asNumber(raw.relatedMessageLengthBytes)
      return value !== undefined && value > 0 ? Math.floor(value) : fallback.related_message_length_bytes
    })(),
    flow_direction: normalizePlanFlowDirection(asString(raw.flow_direction) ?? fallback.flow_direction),
    bus: asString(raw.bus) ?? fallback.bus,
    operation: normalizePlanOperation(asString(raw.operation)) ?? fallback.operation,
    target_address: normalizePlanTargetAddress(asString(raw.target_address) ?? asString(raw.targetAddress)) ?? fallback.target_address,
    protocol_entity: asString(raw.protocol_entity) ?? asString(raw.protocolEntity) ?? fallback.protocol_entity,
    artifact_scope: normalizePlanArtifactScope(asString(raw.artifact_scope) ?? asString(raw.artifactScope)) ?? fallback.artifact_scope,
    selected_block: normalizePlanSelectedBlock(asString(raw.selected_block) ?? asString(raw.selectedBlock) ?? asString(raw.block_role)) ?? fallback.selected_block,
    base_file_name: asString(raw.base_file_name) ?? fallback.base_file_name,
    base_file_path: asString(raw.base_file_path) ?? fallback.base_file_path,
    base_bytes: sanitizePlanBaseBytes(raw.base_bytes) ?? fallback.base_bytes,
    variant_type: normalizeCaseStepVariant(asString(raw.variant_type) ?? fallback.variant_type),
    mutations: hasExplicitMutations ? mutations : fallback.mutations,
    sequence_operations: hasExplicitSequenceOperations ? sequenceOperations : fallback.sequence_operations,
    checksum_policy: normalizeChecksumPolicy(asString(raw.checksum_policy) ?? fallback.checksum_policy),
    argument_values: { ...fallback.argument_values, ...argumentValues },
    evidence_ids: uniqueStrings([
      ...fallback.evidence_ids,
      ...getNestedArray(raw, ["evidence_ids"]).map((item) => asString(item)).filter((item): item is string => Boolean(item)),
    ]),
    confidence: Math.max(0, Math.min(1, asNumber(raw.confidence) ?? fallback.confidence)),
    warnings: uniqueStrings([
      ...fallback.warnings,
      ...getNestedArray(raw, ["warnings"]).map((item) => asString(item)).filter((item): item is string => Boolean(item)),
    ]),
    source,
    selection_source: fallback.selection_source,
    interface_level: fallback.interface_level,
    interface_id: fallback.interface_id,
    interface_selection_source: fallback.interface_selection_source,
    matched_interface_alias: fallback.matched_interface_alias,
    deterministic_generation: fallback.deterministic_generation,
    model_used: source !== "heuristic-fallback" || fallback.model_used,
    model_trigger_reasons: fallback.model_trigger_reasons,
    model_skipped_reasons: fallback.model_skipped_reasons,
    fallback_used: fallback.fallback_used,
    rejected_protocols: fallback.rejected_protocols,
  }
}

function inferHeuristicCaseStepDataPlan(
  input: BuildGeneratedStepInput,
): CaseStepDataGenerationPlan {
  const { step, dataFileIndex, keywordDef } = input
  const semanticText = semanticCaseStepDescription(step.stepDescription)
  const implicitIntent = caseStepImplicitProtocolIntent(semanticText)
  const stepText = step.stepDescription ?? ""
  const positiveText = step.stepDescription ?? ""
  const requestedName = extractRequestedFileNameSafe(step) ?? ""
  const existing = findExactDataFileIndexEntry(dataFileIndex, requestedName, semanticText) ??
    findDataFileIndexEntry(dataFileIndex, requestedName, semanticText)
  const titleError = /(?:TITLE.{0,24}(?:错误|异常|非法|非\s*[0-9A-F])|(?:错误|异常|非法).{0,24}TITLE)/i.test(stepText)
  const checksumError = /(?:(?:SUM|CRC|校验(?:和|字)?).{0,24}(?:错误|异常|非法)|(?:错误|异常|非法).{0,24}(?:SUM|CRC|校验(?:和|字)?))/i.test(stepText)
  const arbitrationError = /(?:仲裁场|\bID\b).{0,24}(?:错误|异常|非法)/i.test(stepText)
  const controlError = /(?:控制场|DLC|RTR).{0,24}(?:错误|异常|非法)/i.test(stepText)
  const lengthError = /(?:长度|Length).{0,24}(?:错误|异常|非法)/i.test(stepText)
  const explicitlyCorrectChecksum = /(?:SUM|CRC|校验(?:和|字)?)\s*(?:正确|正常)/i.test(positiveText)
  const variantType: CaseStepDataGenerationPlan["variant_type"] = checksumError
    ? "checksum_error"
    : titleError
      ? "title_error"
      : arbitrationError
        ? "arbitration_error"
        : controlError
          ? "control_error"
          : lengthError
            ? "length_error"
            : /正确|正常/.test(positiveText)
              ? "correct"
              : "unknown"
  const mutations: CaseStepDataMutation[] = []
  if (titleError) mutations.push({ field: "TITLE", operation: "replace_with_invalid_value" })
  if (arbitrationError) mutations.push({ field: "ARBITRATION", operation: "replace_with_invalid_value" })
  if (controlError) mutations.push({ field: "CONTROL", operation: "replace_with_invalid_value" })
  if (lengthError) mutations.push({ field: "LENGTH", operation: "replace_with_invalid_value" })

  const cycleArgument = keywordDef.arguments.find((argument) => inferArgumentSemanticSafe(argument) === "cycle_time")
  return {
    protocol_id: input.protocolAnchorId,
    protocol_name: existing?.protocol_name ?? existing?.requested_file_name.replace(/\.txt$/i, "") ?? (requestedName.replace(/\.txt$/i, "") || undefined),
    payload_length_bytes: uniqueProtocolPayloadLength(step.stepDescription),
    flow_direction: existing?.flow_direction ?? (/接收|输出流/.test(step.stepDescription ?? "") ? "output" : "input"),
    bus: caseProtocolBusConstraint(semanticText) ??
      step.keywordName.match(/CAN[A-Z]?/i)?.[0]?.toUpperCase() ??
      semanticText.match(/CAN[A-Z]?/i)?.[0]?.toUpperCase(),
    operation: implicitIntent.operation,
    target_address: implicitIntent.targetAddress,
    protocol_entity: implicitIntent.protocolEntity,
    artifact_scope: implicitIntent.artifactScope,
    selected_block: implicitIntent.selectedBlock,
    base_file_name: existing?.requested_file_name,
    base_file_path: existing?.file_path,
    variant_type: variantType,
    mutations,
    sequence_operations: [],
    checksum_policy: checksumError
      ? "make_incorrect"
      : mutations.length || explicitlyCorrectChecksum
        ? "recalculate_correctly"
        : "preserve",
    argument_values: cycleArgument ? { [cycleArgument.name]: "1" } : {},
    evidence_ids: [],
    confidence: existing ? 0.72 : 0.45,
    warnings: existing ? [] : ["No matching base data file was found in generated-data-files-index."],
    source: "heuristic-fallback",
    selection_source: "unresolved",
    deterministic_generation: false,
    model_used: false,
    model_trigger_reasons: [],
    model_skipped_reasons: [],
    fallback_used: false,
    rejected_protocols: [],
  }
}

function candidateDataFilesForPlanning(
  dataFileIndex: GeneratedDataFileIndex,
  semanticText: string,
  requestedName: string,
): CaseStepDataPlanningInput["candidate_data_files"] {
  const direct = findExactDataFileIndexEntry(dataFileIndex, requestedName, semanticText) ??
    findDataFileIndexEntry(dataFileIndex, requestedName, semanticText)
  const semanticKey = normalizeProtocolMatchText(semanticText)
  const ranked = dataFileIndex.entries
    .filter((entry) => entry.source !== "dynamic-generated")
    .map((entry) => {
      const key = normalizeProtocolMatchText([entry.protocol_name, entry.requested_file_name].filter(Boolean).join(" "))
      return { entry, score: key ? longestCommonSubstringLength(semanticKey, key) + entry.confidence : 0 }
    })
    .filter((item) => item.score >= 4 || item.entry === direct)
    .sort((left, right) => (left.entry === direct ? -1 : right.entry === direct ? 1 : right.score - left.score))
    .slice(0, 12)
  return ranked.map(({ entry }) => ({
    protocol_name: entry.protocol_name,
    requested_file_name: entry.requested_file_name,
    file_path: entry.file_path,
    flow_direction: entry.flow_direction,
    checksum_rule: entry.checksum_rule,
    confidence: entry.confidence,
  }))
}

export function buildDtpModelFallbackEvidenceIndex(
  knowledgeIndex: ProjectKnowledgeIndex,
  definitions: DtpProtocolDefinitionsDocument | undefined,
  commandDictionaryIndex: CommandDictionaryIndex | undefined,
): DtpModelFallbackEvidenceIndex {
  const selectorRelationsByProtocolId = new Map<string, DtpProtocolSelectorRelation[]>()
  const relatedTableIdsByTableId = new Map<string, Set<string>>()
  const linkTables = (left: string, right: string): void => {
    if (!left || !right || left === right) return
    const leftItems = relatedTableIdsByTableId.get(left) ?? new Set<string>()
    const rightItems = relatedTableIdsByTableId.get(right) ?? new Set<string>()
    leftItems.add(right)
    rightItems.add(left)
    relatedTableIdsByTableId.set(left, leftItems)
    relatedTableIdsByTableId.set(right, rightItems)
  }
  for (const section of knowledgeIndex.section_protocol_models) {
    for (const primaryTableId of section.primary_table_ids) {
      for (const supportTableId of section.support_table_ids) linkTables(primaryTableId, supportTableId)
    }
    for (const relation of section.protocol_relations) {
      if (relation.dictionary_table_id) linkTables(relation.frame_table_id, relation.dictionary_table_id)
      for (const supportTableId of section.support_table_ids) linkTables(relation.frame_table_id, supportTableId)
    }
  }
  for (const relation of definitions?.selector_relations ?? []) {
    for (const mapping of relation.mappings) {
      const items = selectorRelationsByProtocolId.get(mapping.target_protocol_id) ?? []
      items.push(relation)
      selectorRelationsByProtocolId.set(mapping.target_protocol_id, items)
    }
  }
  return {
    tables_by_id: new Map(knowledgeIndex.tables.map((table) => [table.id, table])),
    related_table_ids_by_table_id: new Map(
      [...relatedTableIdsByTableId.entries()].map(([tableId, related]) => [tableId, [...related]]),
    ),
    selector_relations_by_protocol_id: selectorRelationsByProtocolId,
    command_entries_by_protocol_text: (commandDictionaryIndex?.entries ?? []).map((entry) => ({
      normalized_text: normalizeProtocolMatchText([
        entry.command_name,
        entry.command_code,
        entry.source_table_caption,
      ].filter(Boolean).join(" ")),
      entry,
    })),
  }
}

function modelFallbackProtocolFamily(stepText: string): DtpModelFallbackProtocolFamily {
  const role = protocolSemanticRoleFromText(stepText)
  if (role === "telemetry" || role === "poll" || role === "response" || role === "command") return role
  if (/(?:数据块|数据包|程序块|block)/i.test(stepText)) return "data-block"
  return "unknown"
}

function modelFallbackClassification(
  input: BuildGeneratedStepInput,
  plan: CaseStepDataGenerationPlan,
): DtpModelFallbackClassification {
  const stepText = semanticCaseStepDescription(input.step.stepDescription)
  const busType = caseProtocolBusConstraint(stepText, plan.bus) ?? "unknown"
  const interfaceConstraint = caseCanInterfaceConstraint(stepText, input.keywordDef.keywordName)
  return {
    bus_type: busType,
    interface_level: interfaceConstraint.level ?? "unknown",
    protocol_family: modelFallbackProtocolFamily(stepText),
    flow_direction: caseProtocolFlowConstraint(plan, stepText) ?? "unknown",
  }
}

function protocolMatchesFallbackClassification(
  protocol: DtpProtocolDefinition,
  classification: DtpModelFallbackClassification,
): boolean {
  const bus = protocol.bus_context?.bus_type ?? "unknown"
  if (classification.bus_type !== "unknown" && bus !== "unknown" && bus !== classification.bus_type) return false
  const level = protocol.bus_context?.interface_level ?? "unknown"
  if (classification.interface_level !== "unknown" && level !== "unknown" && level !== classification.interface_level) return false
  if (
    classification.flow_direction !== "unknown" &&
    protocol.flow_direction !== "unknown" &&
    protocol.flow_direction !== classification.flow_direction
  ) return false
  const family = protocolSemanticRole(protocol)
  if (
    classification.protocol_family !== "unknown" &&
    classification.protocol_family !== "data-block" &&
    family &&
    family !== classification.protocol_family
  ) return false
  return true
}

function modelFallbackCandidateProtocolIds(
  input: BuildGeneratedStepInput,
  plan: CaseStepDataGenerationPlan,
  profile: DtpModelFallbackProfileSelection,
): string[] {
  const definitions = input.protocolDefinitions
  if (!definitions?.protocols.length) return []
  const stepText = semanticCaseStepDescription(input.step.stepDescription)
  const resolution = resolveProtocolForCasePlanResult(
    plan,
    definitions,
    stepText,
    input.step.stepDescription ?? stepText,
    input.protocolAnchorId,
  )
  const priorityIds = uniqueStrings([
    plan.protocol_id,
    input.protocolAnchorId,
    resolution.protocol?.protocol_id,
    ...resolution.candidateProtocolIds,
  ].filter((item): item is string => Boolean(item)))
  const rejectedIds = new Set(resolution.rejectedProtocols.map((item) => item.protocol_id))
  const semanticKey = normalizeProtocolMatchText(stepText)
  const scoped = definitions.protocols
    .filter((protocol) => !rejectedIds.has(protocol.protocol_id))
    .filter((protocol) => protocolMatchesFallbackClassification(protocol, profile.classification))
    .map((protocol) => ({
      protocol,
      score: Math.max(...protocolMatchAliases(protocol).map((alias) => {
        const normalized = normalizeProtocolMatchText(alias)
        if (!normalized || !semanticKey) return 0
        if (semanticKey.includes(normalized)) return 10_000 + normalized.length
        return longestCommonSubstringLength(semanticKey, normalized)
      })),
    }))
    .sort((left, right) => right.score - left.score || right.protocol.confidence - left.protocol.confidence)
    .map((item) => item.protocol.protocol_id)
  return uniqueStrings([...priorityIds, ...scoped]).slice(0, profile.max_candidates)
}

function fallbackProtocolCandidate(
  protocol: DtpProtocolDefinition,
  definitions: DtpProtocolDefinitionsDocument,
  stepText: string,
): DtpModelFallbackProtocolCandidate {
  const relations = (definitions.selector_relations ?? []).filter((relation) => (
    relation.mappings.some((mapping) => mapping.target_protocol_id === protocol.protocol_id)
  ))
  const frames = getDtpProtocolFrames(protocol)
  const selectedFrames = frames.length <= 4
    ? frames
    : [frames[0], frames[1], frames[frames.length - 1]]
  const explicitFieldNames = new Set(
    Array.from(stepText.matchAll(/\b(?:W\d+|TITLE|SUM|CRC|LENGTH|L|ARBITRATION|CONTROL|ADDRESS|SEQUENCE)\b/gi))
      .map((match) => normalizeLookupText(match[0])),
  )
  return {
    protocol_id: protocol.protocol_id,
    base_file_name: protocol.base_file_name,
    aliases: (protocol.aliases ?? []).slice(0, 6).map((item) => item.slice(0, 160)),
    source_section: protocol.source_section?.slice(0, 320),
    flow_direction: protocol.flow_direction,
    bus_context: protocol.bus_context
      ? {
          bus_type: protocol.bus_context.bus_type,
          interface_level: protocol.bus_context.interface_level,
          interface_id: protocol.bus_context.interface_id,
          interface_name: protocol.bus_context.interface_name,
          profile_scope: protocol.bus_context.profile_scope,
          controller: protocol.bus_context.controller,
          controller_family: protocol.bus_context.controller_family,
          mode: protocol.bus_context.mode,
          frame_format: protocol.bus_context.frame_format,
          frame_buffer_layout: protocol.bus_context.frame_buffer_layout,
          frame_info_byte: protocol.bus_context.frame_info_byte,
          frame_information: protocol.bus_context.frame_information,
          confidence: protocol.bus_context.confidence,
        }
      : undefined,
    frame_count: frames.length,
    omitted_frame_count: Math.max(0, frames.length - selectedFrames.length) || undefined,
    field_layout: selectedFrames.map((frame) => {
      const fields = frame.field_layout.filter((field, index, items) => (
        field.role !== "data" ||
        explicitFieldNames.has(normalizeLookupText(field.name)) ||
        index < 8 ||
        index >= items.length - 4
      ))
      return {
        frame_id: frame.frame_id,
        fields: fields.map((field) => ({
        name: field.name,
        role: field.role,
        byte_offset: field.byte_offset,
        byte_length: field.byte_length,
        default_value: field.default_value,
        value_rule: field.value_rule,
        source_table_id: field.source_table_id,
        source_text: field.source_text?.slice(0, 240),
      })),
        checksum: frame.checksum,
        omitted_field_count: Math.max(0, frame.field_layout.length - fields.length) || undefined,
      }
    }),
    source_table_ids: uniqueStrings(frames.flatMap((frame) => [
      frame.source_table_id,
      ...frame.field_layout.map((field) => field.source_table_id),
    ].filter((item): item is string => Boolean(item)))).slice(0, 12),
    selector_relation_ids: relations.map((relation) => relation.relation_id).slice(0, 8),
    confidence: protocol.confidence,
    warnings: protocol.warnings.slice(0, 2).map((item) => item.slice(0, 240)),
  }
}

function fallbackEvidenceText(table: ProjectKnowledgeTable): string {
  return [table.caption, table.table_html ?? table.rows.map((row) => row.join(" | ")).join("\n")]
    .filter(Boolean)
    .join("\n")
}

function appendFallbackEvidenceWithinBudget(
  target: DtpModelFallbackEvidence[],
  candidate: DtpModelFallbackEvidence,
  remainingChars: number,
): number {
  if (target.some((item) => item.id === candidate.id) || remainingChars <= 0) return remainingChars
  const text = candidate.text.length > remainingChars ? candidate.text.slice(0, remainingChars) : candidate.text
  if (!text.trim()) return remainingChars
  target.push({ ...candidate, text })
  return remainingChars - text.length
}

function relatedFallbackTableIds(
  index: DtpModelFallbackEvidenceIndex,
  sourceTableIds: string[],
  relationDepth: number,
): string[] {
  const visited = new Set(sourceTableIds)
  let frontier = [...sourceTableIds]
  for (let depth = 0; depth < relationDepth; depth += 1) {
    const next: string[] = []
    for (const tableId of frontier) {
      for (const relatedId of index.related_table_ids_by_table_id.get(tableId) ?? []) {
        if (visited.has(relatedId)) continue
        visited.add(relatedId)
        next.push(relatedId)
      }
    }
    frontier = next
    if (frontier.length === 0) break
  }
  return [...visited]
}

function buildDtpModelFallbackPackage(
  input: BuildGeneratedStepInput,
  plan: CaseStepDataGenerationPlan,
): CaseStepDataPlanningInput["model_fallback"] | undefined {
  if (!input.modelFallbackProfiles || !input.protocolDefinitions || !input.modelFallbackEvidenceIndex) return undefined
  const profile = selectDtpModelFallbackPolicy(
    input.modelFallbackProfiles,
    modelFallbackClassification(input, plan),
  )
  const candidateIds = modelFallbackCandidateProtocolIds(input, plan, profile)
  const protocolById = new Map(input.protocolDefinitions.protocols.map((protocol) => [protocol.protocol_id, protocol]))
  const allCandidateProtocols = candidateIds
    .map((protocolId) => protocolById.get(protocolId))
    .filter((protocol): protocol is DtpProtocolDefinition => Boolean(protocol))
    .map((protocol) => fallbackProtocolCandidate(
      protocol,
      input.protocolDefinitions!,
      semanticCaseStepDescription(input.step.stepDescription),
    ))

  const profileOverhead = safeJsonLength({ profile, candidate_protocols: [], evidence: [] })
  const usableBudget = Math.max(0, profile.context_budget_chars - profileOverhead)
  const candidateBudget = Math.floor(usableBudget * 0.52)
  const candidateProtocols: DtpModelFallbackProtocolCandidate[] = []
  for (const candidate of allCandidateProtocols) {
    const next = [...candidateProtocols, candidate]
    if (candidateProtocols.length > 0 && safeJsonLength(next) > candidateBudget) break
    candidateProtocols.push(candidate)
  }

  const evidence: DtpModelFallbackEvidence[] = []
  let remainingChars = Math.max(
    0,
    Math.floor((profile.context_budget_chars - profileOverhead - safeJsonLength(candidateProtocols)) * 0.88),
  )
  for (const candidate of candidateProtocols) {
    for (const tableId of relatedFallbackTableIds(
      input.modelFallbackEvidenceIndex,
      candidate.source_table_ids,
      profile.relation_depth,
    )) {
      const table = input.modelFallbackEvidenceIndex.tables_by_id.get(tableId)
      if (!table) continue
      remainingChars = appendFallbackEvidenceWithinBudget(evidence, {
        id: `table:${table.id}`,
        kind: "source-table",
        source_id: table.id,
        text: fallbackEvidenceText(table),
      }, remainingChars)
    }
    for (const relation of input.modelFallbackEvidenceIndex.selector_relations_by_protocol_id.get(candidate.protocol_id) ?? []) {
      remainingChars = appendFallbackEvidenceWithinBudget(evidence, {
        id: `selector:${relation.relation_id}`,
        kind: "selector-relation",
        source_id: relation.relation_id,
        text: JSON.stringify({
          selector_name: relation.selector_name,
          selector_aliases: relation.selector_aliases,
          mappings: relation.mappings,
          evidence: relation.evidence,
        }),
      }, remainingChars)
    }
  }

  const stepKey = normalizeProtocolMatchText(semanticCaseStepDescription(input.step.stepDescription))
  for (const item of input.modelFallbackEvidenceIndex.command_entries_by_protocol_text) {
    if (!item.normalized_text || longestCommonSubstringLength(stepKey, item.normalized_text) < 4) continue
    remainingChars = appendFallbackEvidenceWithinBudget(evidence, {
      id: `command:${item.entry.id}`,
      kind: "command-dictionary",
      source_id: item.entry.id,
      text: JSON.stringify(item.entry),
    }, remainingChars)
  }
  while (
    evidence.length > 0 &&
    safeJsonLength({ profile, candidate_protocols: candidateProtocols, evidence }) > profile.context_budget_chars
  ) {
    const last = evidence[evidence.length - 1]
    const excess = safeJsonLength({ profile, candidate_protocols: candidateProtocols, evidence }) - profile.context_budget_chars
    if (last.text.length <= excess + 256) {
      evidence.pop()
    } else {
      last.text = last.text.slice(0, Math.max(0, last.text.length - excess - 256))
    }
  }
  const evidenceKinds = new Set(evidence.map((item) => item.kind))
  const missingEvidence = profile.required_evidence.filter((kind) => {
    if (kind === "protocol-definition") return candidateProtocols.length === 0
    return !evidenceKinds.has(kind)
  })
  const promptChars = safeJsonLength({ profile, candidate_protocols: candidateProtocols, evidence })
  return {
    profile,
    candidate_protocols: candidateProtocols,
    evidence,
    missing_evidence: missingEvidence,
    prompt_chars: promptChars,
    estimated_input_tokens: estimateTokenCount(promptChars),
  }
}

function buildCaseStepDataPlanningInput(
  input: BuildGeneratedStepInput,
  includeSupplementalContext = true,
  plan?: CaseStepDataGenerationPlan,
): CaseStepDataPlanningInput {
  const semanticStepDescription = semanticCaseStepDescription(input.step.stepDescription)
  const contextQuery = semanticStepDescription
  const query = [
    contextQuery,
    input.keywordDef.keywordName,
    input.keywordDef.documentation,
    ...input.keywordDef.arguments.map((argument) => argument.comments),
  ].filter(Boolean).join(" ")
  const modelFallback = includeSupplementalContext && plan
    ? buildDtpModelFallbackPackage(input, plan)
    : undefined
  return {
    case_id: input.caseContext.caseId,
    case_name: input.caseContext.caseName,
    keyword: {
      name: input.keywordDef.keywordName,
      documentation: input.keywordDef.documentation,
      arguments: input.keywordDef.arguments,
    },
    step: {
      step_index: input.step.stepIndex,
      step_desc: semanticStepDescription,
      time: input.step.timeValue,
    },
    project_value_evidence: includeSupplementalContext
      ? selectProjectFieldValueEvidence(input.knowledgeIndex, query)
      : [],
    candidate_data_files: candidateDataFilesForPlanning(
      input.dataFileIndex,
      query,
      extractRequestedFileNameSafe(input.step) ?? "",
    ).slice(0, 5),
    model_fallback: modelFallback,
  }
}

function protocolPayloadLengthCandidates(value: string | undefined): number[] {
  if (!value) return []
  const values: number[] = []
  for (const match of value.matchAll(/(?:\u957f\u5ea6\s*)?(\d{1,4})\s*(?:\u5b57\u8282|bytes?\b)/gi)) {
    const parsed = Number.parseInt(match[1], 10)
    if (Number.isFinite(parsed) && parsed > 0) values.push(parsed)
  }
  return Array.from(new Set(values))
}

function uniqueProtocolPayloadLength(value: string | undefined): number | undefined {
  const values = protocolPayloadLengthCandidates(value)
  return values.length === 1 ? values[0] : undefined
}

type ProtocolPayloadLengthEvidence = {
  value?: number
  source?: "base_file_name" | "length_field" | "source_section"
  intrinsic: boolean
}

function protocolPayloadLengthEvidence(protocol: DtpProtocolDefinition): ProtocolPayloadLengthEvidence {
  if (protocol.semantic_identity) {
    if (protocol.semantic_identity.message_length_bytes !== undefined) {
      return { value: protocol.semantic_identity.message_length_bytes, source: "base_file_name", intrinsic: true }
    }
    if (protocol.semantic_identity.role === "response") return { intrinsic: false }
  }
  const nameLength = uniqueProtocolPayloadLength(protocol.base_file_name)
  if (nameLength !== undefined) return { value: nameLength, source: "base_file_name", intrinsic: true }

  for (const frame of getDtpProtocolFrames(protocol)) {
    const lengthField = frame.field_layout.find((field) => /^(?:L|LENGTH|\u957f\u5ea6)$/i.test(field.name))
    const value = normalizeHexByte(lengthField?.default_value)
    if (value) return { value: Number.parseInt(value, 16), source: "length_field", intrinsic: true }
  }

  const sectionLength = uniqueProtocolPayloadLength(protocol.source_section)
  if (sectionLength !== undefined) {
    return { value: sectionLength, source: "source_section", intrinsic: false }
  }
  return { intrinsic: false }
}

function protocolPayloadLengthBytes(protocol: DtpProtocolDefinition): number | undefined {
  return protocolPayloadLengthEvidence(protocol).value
}

function protocolRelatedMessageLengthBytes(
  protocol: DtpProtocolDefinition,
  definitions: DtpProtocolDefinitionsDocument,
): number | undefined {
  if (protocol.semantic_identity?.related_message_length_bytes !== undefined) {
    return protocol.semantic_identity.related_message_length_bytes
  }
  const relation = (definitions.relations ?? []).find((item) => (
    item.type === "responds_to" &&
    item.source_kind === "protocol" &&
    item.source_id === protocol.protocol_id
  ))
  if (!relation || relation.target_kind !== "protocol" || relation.target_ids.length !== 1) return undefined
  return definitions.protocols.find((candidate) => candidate.protocol_id === relation.target_ids[0])
    ?.semantic_identity?.message_length_bytes
}

type CaseProtocolSelectionConstraints = {
  payloadLengthBytes?: number
  payloadLengthScope?: "self" | "related_message"
  declaredFrameCount?: number
}

type CaseProtocolResolution = {
  protocol?: DtpProtocolDefinition
  constraints: CaseProtocolSelectionConstraints
  busConstraint?: DtpProtocolBusContext["bus_type"]
  interfaceConstraint: CaseCanInterfaceConstraint
  ambiguous: boolean
  candidateProtocolIds: string[]
  defaultSelected?: boolean
  equivalentSelected?: boolean
  selectorRelationId?: string
  selectorRelationIds?: string[]
  selectorTargetFrameCount?: number
  semanticRelationId?: string
  selectorValue?: string
  selectedScopeConflicts: string[]
  rejectedProtocols: Array<{
    protocol_id: string
    reason: string
  }>
}

function protocolPhysicalFingerprint(protocol: DtpProtocolDefinition): string {
  const fields = (frame: DtpProtocolFrameDefinition) => [...frame.field_layout]
    .sort((left, right) => (
      left.byte_offset - right.byte_offset ||
      (left.bit_offset ?? -1) - (right.bit_offset ?? -1) ||
      left.name.localeCompare(right.name)
    ))
    .map((field) => ({
      name: field.name.toUpperCase(),
      role: field.role,
      byte_offset: field.byte_offset,
      byte_length: field.byte_length,
      bit_offset: field.bit_offset,
      bit_length: field.bit_length,
      default_value: normalizeHexByte(field.default_value) ?? field.default_value,
      value_rule: field.value_rule,
      options: field.options?.map((option) => ({ value: option.value, label: option.label })),
    }))
  const block = protocol.block_layout
  const fingerprint = {
    bus_type: protocol.bus_context?.bus_type ?? "unknown",
    interface_level: protocol.bus_context?.interface_level ?? "unknown",
    interface_id: protocol.bus_context?.interface_id ?? "unknown",
    flow_direction: protocol.flow_direction,
    semantic_role: protocolSemanticRole(protocol) ?? "unknown",
    semantic_entity: protocolIdentityFamilyText(
      protocol.semantic_identity?.entity ?? protocol.semantic_identity?.canonical_name ?? protocol.base_file_name,
    ),
    payload_length_bytes: protocolPayloadLengthBytes(protocol),
    frames: getDtpProtocolFrames(protocol).map((frame) => ({
      sequence: frame.sequence,
      byte_layout: frame.byte_layout.map((value) => normalizeHexByte(value) ?? value.trim().toUpperCase()),
      field_layout: fields(frame),
      checksum: frame.checksum,
    })),
    variables: [...(protocol.variables ?? [])]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((variable) => ({
        name: variable.name.toUpperCase(),
        type: variable.type,
        default_value: variable.default_value,
        options: variable.options?.map((option) => ({ value: option.value, label: option.label })),
      })),
    frame_envelope: protocol.frame_envelope && {
      type: protocol.frame_envelope.type,
      bytes: protocol.frame_envelope.bytes,
      applies_per_frame: protocol.frame_envelope.applies_per_frame,
      position: protocol.frame_envelope.position,
      byte_order: protocol.frame_envelope.byte_order,
      business_frame_length: protocol.frame_envelope.business_frame_length,
      wire_frame_length: protocol.frame_envelope.wire_frame_length,
      directions: protocol.frame_envelope.directions,
    },
    block_layout: block && {
      kind: block.kind,
      total_bytes: block.total_bytes,
      payload_offset: block.payload_offset,
      payload_capacity: block.payload_capacity,
      start_address: block.start_address,
      address_offset: block.address_offset,
      address_length: block.address_length,
      length_offset: block.length_offset,
      length_length: block.length_length,
      scalar_byte_order: block.scalar_byte_order,
      block_type_offset: block.block_type_offset,
      start_block_type: block.start_block_type,
      middle_block_type: block.middle_block_type,
      check_block_type: block.check_block_type,
      checksums: block.checksums.map((checksum) => ({
        name: checksum.name,
        algorithm: checksum.algorithm,
        source: checksum.source,
        source_start: checksum.source_start,
        source_end: checksum.source_end,
        output_offset: checksum.output_offset,
        output_length: checksum.output_length,
        byte_order: checksum.byte_order,
      })),
    },
  }
  return createHash("sha256").update(JSON.stringify(fingerprint)).digest("hex")
}

function protocolEvidenceCompletenessScore(protocol: DtpProtocolDefinition): number {
  const frames = getDtpProtocolFrames(protocol)
  const provenanceScore = Math.max(0, ...(protocol.provenance ?? []).map((item) => ({
    primary: 4,
    referenced: 3,
    supporting: 2,
    unknown: 1,
  })[item.priority]))
  return (
    (protocol.semantic_identity ? 1_000 : 0) +
    (protocol.transport ? 500 : 0) +
    provenanceScore * 100 +
    frames.reduce((total, frame) => total + frame.field_layout.length, 0) * 4 +
    protocol.evidence.length * 2 +
    Math.round(protocol.confidence * 10)
  )
}

function selectPhysicallyEquivalentProtocol(
  candidates: DtpProtocolDefinition[],
  definitions: DtpProtocolDefinitionsDocument,
): DtpProtocolDefinition | undefined {
  if (candidates.length < 2) return undefined
  if (new Set(candidates.map(protocolPhysicalFingerprint)).size !== 1) return undefined
  const documentOrder = new Map(definitions.protocols.map((protocol, index) => [protocol.protocol_id, index]))
  return [...candidates].sort((left, right) => (
    protocolEvidenceCompletenessScore(right) - protocolEvidenceCompletenessScore(left) ||
    (documentOrder.get(left.protocol_id) ?? Number.MAX_SAFE_INTEGER) -
      (documentOrder.get(right.protocol_id) ?? Number.MAX_SAFE_INTEGER)
  ))[0]
}

function normalizeProtocolSelectorValue(
  value: string,
  type: DtpProtocolSelectorRelation["selector_type"],
): string | undefined {
  const trimmed = value.trim()
  if (!trimmed || /^[-—–/]$/.test(trimmed)) return undefined
  if (type === "uint8") {
    const match = trimmed.match(/^(?:0x)?([0-9A-Fa-f]{1,2})H?$/i)
    return match?.[1].toUpperCase().padStart(2, "0")
  }
  if (type === "integer") {
    const match = trimmed.match(/^\d+$/)
    return match ? String(Number.parseInt(match[0], 10)) : undefined
  }
  return normalizeLookupText(trimmed) || undefined
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function protocolSelectorValueFromStep(
  relation: DtpProtocolSelectorRelation,
  stepText: string,
): string | undefined {
  for (const alias of uniqueStrings([relation.selector_name, ...relation.selector_aliases]).filter(Boolean)) {
    const escaped = escapeRegExp(alias)
    const valuePattern = relation.selector_type === "integer"
      ? "(\\d+)"
      : relation.selector_type === "uint8"
        ? "(?:0x)?([0-9A-Fa-f]{1,2})H?"
        : "([^,，。；;\\s]+)"
    const match = stepText.match(new RegExp(`${escaped}\\s*(?:为|=|:|：)?\\s*${valuePattern}`, "i"))
    const normalized = normalizeProtocolSelectorValue(match?.[1] ?? "", relation.selector_type)
    if (normalized) return normalized
  }
  return undefined
}

type ProtocolSelectorResolution = {
  protocol?: DtpProtocolDefinition
  candidates: DtpProtocolDefinition[]
  relationIds: string[]
  selectorValue: string
  targetFrameCount?: number
  ambiguous: boolean
}

function selectorSemanticKey(relation: DtpProtocolSelectorRelation): string {
  const names = [relation.selector_name, ...relation.selector_aliases].join(" ")
  if (/(?:站|节点|终端|设备|单机)地址|station[_\s-]*address/i.test(names)) return "station_address"
  return `${relation.selector_type}:${normalizeLookupText(relation.selector_name)}`
}

function protocolFromSelectorRelations(
  candidates: DtpProtocolDefinition[],
  definitions: DtpProtocolDefinitionsDocument,
  stepText: string,
  busConstraint: DtpProtocolBusContext["bus_type"] | undefined,
  interfaceConstraint: CaseCanInterfaceConstraint,
): ProtocolSelectorResolution | undefined {
  const candidateById = new Map(candidates.map((protocol) => [protocol.protocol_id, protocol]))
  const protocolById = new Map(definitions.protocols.map((protocol) => [protocol.protocol_id, protocol]))
  const matchesBySelector = new Map<string, Array<{
    relation: DtpProtocolSelectorRelation
    selectorValue: string
    mappings: DtpProtocolSelectorMapping[]
  }>>()
  const stepRole = protocolSemanticRoleFromText(stepText)

  for (const relation of definitions.selector_relations ?? []) {
    if (relation.bus_type && busConstraint && relation.bus_type !== busConstraint) continue
    if (
      relation.interface_level && relation.interface_level !== "unknown" &&
      interfaceConstraint.level && relation.interface_level !== interfaceConstraint.level
    ) continue
    if (relation.interface_id && interfaceConstraint.interfaceId && relation.interface_id !== interfaceConstraint.interfaceId) continue
    if (relation.protocol_family && relation.protocol_family !== "unknown" && relation.protocol_family !== stepRole) continue

    const selectorValue = protocolSelectorValueFromStep(relation, stepText)
    if (!selectorValue) continue
    const mappings = relation.mappings.filter((mapping) => {
        const mappingValue = normalizeProtocolSelectorValue(mapping.selector_value, relation.selector_type)
        if (mappingValue === selectorValue) return true
        return dtpBusSelectorValuesEquivalent(relation.bus_type, {
          relation,
          selectorValue,
          mappingValue,
        })
      })
    if (!mappings.length) continue
    const key = `${relation.protocol_family ?? "unknown"}|${selectorSemanticKey(relation)}`
    matchesBySelector.set(key, [
      ...(matchesBySelector.get(key) ?? []),
      { relation, selectorValue, mappings },
    ])
  }

  if (!matchesBySelector.size) return undefined
  const matchedProtocolFamilies = new Set(Array.from(matchesBySelector.values())
    .flatMap((matches) => matches.map(({ relation }) => relation.protocol_family))
    .filter((family): family is NonNullable<DtpProtocolSelectorRelation["protocol_family"]> => Boolean(family)))
  // A selector value may be reused by unrelated protocol families. Without a
  // semantic role in the step, applying all of them as one constraint would
  // create a false conflict; leave that case to normal identity scoring.
  if (matchedProtocolFamilies.size > 1) return undefined
  let constrainedCandidates = candidates
  const relationIds: string[] = []
  const selectorValues: string[] = []
  const agreedFrameCounts: number[] = []
  for (const matches of matchesBySelector.values()) {
    relationIds.push(...matches.map(({ relation }) => relation.relation_id))
    selectorValues.push(...matches.map(({ selectorValue }) => selectorValue))
    const mappings = matches.flatMap((match) => match.mappings)
    const targetFrameCounts = uniqueStrings(mappings.flatMap((mapping) => {
      const target = protocolById.get(mapping.target_protocol_id)
      const frameCount = mapping.target_frame_count ?? (target ? getDtpProtocolFrames(target).length : undefined)
      return frameCount === undefined ? [] : [String(frameCount)]
    })).map(Number)
    const mappedCandidates = uniqueStrings(mappings.map((mapping) => mapping.target_protocol_id))
      .map((protocolId) => candidateById.get(protocolId))
      .filter((protocol): protocol is DtpProtocolDefinition => Boolean(protocol))
    if (targetFrameCounts.length > 1) {
      return {
        candidates: mappedCandidates,
        relationIds: uniqueStrings(relationIds),
        selectorValue: uniqueStrings(selectorValues).join(","),
        ambiguous: true,
      }
    }
    const targetFrameCount = targetFrameCounts[0]
    if (targetFrameCount !== undefined) agreedFrameCounts.push(targetFrameCount)
    const groupCandidates = mappedCandidates.length
      ? mappedCandidates
      : targetFrameCount !== undefined
        ? constrainedCandidates.filter((protocol) => getDtpProtocolFrames(protocol).length === targetFrameCount)
        : []
    if (!groupCandidates.length) continue
    const groupIds = new Set(groupCandidates.map((protocol) => protocol.protocol_id))
    constrainedCandidates = constrainedCandidates.filter((protocol) => groupIds.has(protocol.protocol_id))
  }

  const frameCounts = uniqueStrings(agreedFrameCounts.map(String)).map(Number)
  if (frameCounts.length > 1 || !constrainedCandidates.length) {
    return {
      candidates: constrainedCandidates,
      relationIds: uniqueStrings(relationIds),
      selectorValue: uniqueStrings(selectorValues).join(","),
      ambiguous: true,
    }
  }
  return {
    protocol: constrainedCandidates.length === 1 ? constrainedCandidates[0] : undefined,
    candidates: constrainedCandidates,
    relationIds: uniqueStrings(relationIds),
    selectorValue: uniqueStrings(selectorValues).join(","),
    targetFrameCount: frameCounts[0],
    ambiguous: false,
  }
}

function caseProtocolBusConstraint(
  stepText: string,
  planBus?: string,
): DtpProtocolBusContext["bus_type"] | undefined {
  return detectDtpBusType(`${stepText} ${planBus ?? ""}`)
}

type CaseCanInterfaceConstraint = {
  level?: "primary" | "secondary"
  interfaceId?: string
  source: "explicit_level" | "interface_id" | "legacy_can_channel_alias" | "unresolved"
  matchedAlias?: string
}

function canInterfaceConstraintFromEvidence(stepText: string): CaseCanInterfaceConstraint {
  const constraint = classifyDtpBusInterface("CAN", stepText)
  return {
    ...constraint,
    source: constraint.source === "legacy_channel_alias" ? "legacy_can_channel_alias" : constraint.source,
  }
}

function caseCanInterfaceConstraint(stepText: string, keywordName?: string): CaseCanInterfaceConstraint {
  const keywordConstraint = canInterfaceConstraintFromEvidence(keywordName ?? "")
  if (keywordConstraint.source !== "unresolved") return keywordConstraint
  return canInterfaceConstraintFromEvidence(stepText)
}

function protocolNameInterfaceLevel(value: string | undefined): "primary" | "secondary" | undefined {
  if (!value) return undefined
  if (/\u4e8c\u7ea7\s*CAN/i.test(value)) return "secondary"
  if (/\u4e00\u7ea7\s*CAN/i.test(value)) return "primary"
  return undefined
}

function stepProtocolDisplayName(stepText: string, payloadLengthBytes?: number): string | undefined {
  const normalized = stepText.replace(/\s+/g, "")
  const entity = normalized.match(
    /(?:\d{1,4}\u5b57\u8282(?:\u7684)?)?(?:\u9065\u63a7\u6307\u4ee4\u5e94\u7b54(?:\u63a7\u5236\u5e8f\u5217)?|\u9065\u63a7\u6307\u4ee4|\u4e0a\u884c\u6570\u636e\u5757|\u9065\u6d4b\u5e27\d+\u8f6e\u8be2\u63a7\u5236\u5e8f\u5217|\u9065\u6d4b\u8f6e\u8be2\u63a7\u5236\u5e8f\u5217|\u5185\u5b58\u8bfb\u51fa\u6307\u4ee4|\u95f4\u63a5\u6307\u4ee4)/i,
  )?.[0]
  if (!entity) return undefined
  const cleanEntity = entity.replace(/\u7684/g, "")
  if (/\d{1,4}\u5b57\u8282/.test(cleanEntity) || payloadLengthBytes === undefined) return cleanEntity
  return `${payloadLengthBytes}\u5b57\u8282${cleanEntity}`
}

function uniqueRejectedProtocols(
  items: CaseProtocolResolution["rejectedProtocols"],
): CaseProtocolResolution["rejectedProtocols"] {
  const byProtocolId = new Map<string, CaseProtocolResolution["rejectedProtocols"][number]>()
  for (const item of items) {
    if (!byProtocolId.has(item.protocol_id)) byProtocolId.set(item.protocol_id, item)
  }
  return [...byProtocolId.values()]
}

function caseProtocolSelectionConstraints(
  semanticText: string,
  stepText = semanticText,
): CaseProtocolSelectionConstraints {
  const stepLength = uniqueProtocolPayloadLength(stepText)
  const compactStep = stepText.replace(/\s+/g, "")
  const relatedResponseLength = /(\d{1,4})字节(?:的)?[^，。；;]{0,24}(?:指令|命令)[^，。；;]{0,12}(?:应答|响应|回复)/.test(compactStep)
  return {
    payloadLengthBytes: stepLength ?? uniqueProtocolPayloadLength(semanticText),
    payloadLengthScope: relatedResponseLength ? "related_message" : "self",
    declaredFrameCount: declaredFrameCountFromStep(stepText),
  }
}

const MAX_PROTOCOL_DISPLAY_TITLE_LENGTH = 48

function cleanPublishedProtocolName(value: string | undefined): string | undefined {
  const cleaned = sanitizeReadableFileBaseName(value)
    .replace(/\s*[（(]\s*doc-\d+-table-\d+\s*[）)]\s*/gi, " ")
    .replace(/(?:^|[-_\s])doc-\d+-table-\d+(?:$|[-_\s])/gi, " ")
    .replace(/^\s*\d+\s*(?:[、)）]|[.．](?!\d))\s*/, "")
    .replace(/\s*(?:格式|结构)(?:定义|说明)?\s*$/u, "")
    .replace(/\s+/g, " ")
    .trim()
  return cleaned || undefined
}

function protocolDisplayTitleCandidate(
  value: string | undefined,
  payloadLengthBytes: number | undefined,
): string | undefined {
  const title = cleanPublishedProtocolName(
    (value ?? "")
      .replace(/^\s*(?:第\s*)?\d+(?:\.\d+)+(?:\s*[章节])?\s*/, "")
      .replace(/^\s*(?:附\s*)?表\s*[A-Za-z]?\s*[-－]?\s*\d+(?:[.\-－]\d+)*\s*/i, "")
      .split(/[：:]/, 1)[0]
  ) ?? ""
  if (
    !/[\u4e00-\u9fff]/.test(title) ||
    title.length > MAX_PROTOCOL_DISPLAY_TITLE_LENGTH ||
    /[=＝]|(?:TITLE|SUM|CRC|W\d+)|仲裁场\s*[\/、和及]\s*控制场|有效数据场|未使用字节/i.test(title) ||
    /^(?:数据及接口需求|(?:一级|二级)?(?:CAN|SPI|SpaceWire|RS422|1553B).*(?:总线)?接口(?:及相关数据流)?)$/i.test(title)
  ) {
    return undefined
  }
  const titlePayloadLength = uniqueProtocolPayloadLength(title)
  if (payloadLengthBytes && titlePayloadLength && titlePayloadLength !== payloadLengthBytes) return undefined
  return title
}

function protocolDisplayName(
  protocol: DtpProtocolDefinition,
  definitions: DtpProtocolDefinitionsDocument | undefined,
  payloadLengthBytes = protocolPayloadLengthBytes(protocol),
): string {
  if (protocol.composition) return cleanPublishedProtocolName(protocol.base_file_name) ?? protocol.base_file_name
  const baseIdentityFamily = protocolIdentityFamilyText(protocol.base_file_name)
  const numberedVariantName = protocolNumberedVariantAliases(protocol).find((alias) => (
    protocolIdentityFamilyText(alias) === baseIdentityFamily
  ))
  let displayName = numberedVariantName ?? protocol.base_file_name
  if (numberedVariantName) return cleanPublishedProtocolName(numberedVariantName) ?? numberedVariantName
  const frameCount = getDtpProtocolFrames(protocol).length
  const baseIdentity = protocolIdentityText(protocol.base_file_name)
  const frameSpecificEvidenceName = frameCount > 1
    ? protocol.evidence
        .map((item) => protocolDisplayTitleCandidate(item, payloadLengthBytes))
        .find((item) => (
          Boolean(item) &&
          new RegExp(`(?:^|[^0-9])${frameCount}\\s*帧`).test(item!) &&
          (!baseIdentity || protocolIdentityText(item).includes(baseIdentity))
        ))
    : undefined
  if (frameSpecificEvidenceName) return frameSpecificEvidenceName
  if (/^[\x00-\x7F]+$/.test(displayName)) {
    displayName = [...protocol.evidence, protocol.source_section]
      .map((item) => protocolDisplayTitleCandidate(item, payloadLengthBytes))
      .find((item): item is string => Boolean(item)) ?? displayName
  }
  displayName = cleanPublishedProtocolName(displayName) ?? displayName
  if (!payloadLengthBytes || uniqueProtocolPayloadLength(displayName) === payloadLengthBytes) {
    return displayName
  }
  const normalizedName = normalizeProtocolMatchText(protocol.base_file_name)
  const hasSameNameSibling = Boolean(definitions?.protocols.some((candidate) => (
    candidate.protocol_id !== protocol.protocol_id &&
    normalizeProtocolMatchText(candidate.base_file_name) === normalizedName
  )))
  return hasSameNameSibling ? `${payloadLengthBytes}\u5b57\u8282${displayName}` : displayName
}

function publishedProtocolDisplayName(
  protocol: DtpProtocolDefinition,
  definitions: DtpProtocolDefinitionsDocument | undefined,
  stepText: string,
  payloadLengthBytes = protocolPayloadLengthBytes(protocol),
): string {
  const stepName = stepProtocolDisplayName(stepText, payloadLengthBytes)
  const explicitStepLength = uniqueProtocolPayloadLength(stepText)
  const pollutedProtocolIdentity = (
    /^\s*\d+\s*(?:[、)）]|[.．](?!\d))/u.test(protocol.base_file_name) ||
    /doc-\d+-table-\d+/i.test(protocol.base_file_name)
  )
  if (
    pollutedProtocolIdentity &&
    stepName &&
    explicitStepLength !== undefined &&
    (payloadLengthBytes === undefined || explicitStepLength === payloadLengthBytes)
  ) {
    return cleanPublishedProtocolName(stepName) ?? stepName
  }
  return protocolDisplayName(protocol, definitions, payloadLengthBytes)
}

function protocolIdentityText(value: string | undefined): string {
  return normalizeLookupText(value)
    .replace(/(?:\u957f\u5ea6)?\d{1,4}\u5b57\u8282/g, "")
    .replace(/\u6b63\u786e\u7684|\u6b63\u786e|\u9519\u8bef\u7684|\u9519\u8bef|\u6570\u636e\u6587\u4ef6|\u6587\u4ef6/g, "")
}

function protocolImplicitEntityScore(protocol: DtpProtocolDefinition, stepText: string): number {
  if (!protocol.block_layout) return 0
  const intent = caseStepImplicitProtocolIntent(stepText)
  const entity = intent.protocolEntity
  if (!entity) return 0
  if (
    intent.selectedBlock &&
    !getDtpProtocolFrames(protocol).some((frame) => frame.frame_id === intent.selectedBlock)
  ) return 0

  let best = 0
  for (const candidate of protocolMatchAliases(protocol)) {
    const candidateEntity = implicitProtocolEntityText(candidate)
    if (candidateEntity.length < 4) continue
    if (candidateEntity === entity) best = Math.max(best, 55_000)
    else if (candidateEntity.includes(entity) || entity.includes(candidateEntity)) {
      best = Math.max(best, 45_000 + Math.min(candidateEntity.length, entity.length))
    } else {
      const overlap = longestCommonSubstringLength(candidateEntity, entity)
      if (overlap >= 4) best = Math.max(best, 20_000 + overlap * 100)
    }
  }
  return best
}

function protocolNumberedVariantAliases(protocol: DtpProtocolDefinition): string[] {
  const aliases: string[] = []
  // Table evidence belongs to the individual protocol, while a shared section title
  // may mention only the first numbered packet and must not override that identity.
  const values = [protocol.base_file_name, ...(protocol.aliases ?? []), ...protocol.evidence, protocol.source_section]
  const numberedProtocolPattern = /(?:辅助数据包|上行数据块|遥控指令|遥测数据包|遥测数据|数据块|数据包|控制序列|指令)\s*[-_]?\s*[一二三四五六七八九十0-9]+/gi
  const embeddedFramePattern = /(?:遥测|遥控)帧\s*[一二三四五六七八九十0-9]+(?:轮询控制序列|控制序列|数据包|数据)?/gi
  for (const value of values) {
    if (!value) continue
    for (const pattern of [numberedProtocolPattern, embeddedFramePattern]) {
      for (const match of value.matchAll(pattern)) {
        const alias = match[0].replace(/\s+/g, "").replace(/_/g, "-")
        if (alias) aliases.push(alias)
      }
    }
  }
  return uniqueStrings(aliases)
}

function protocolMatchAliases(protocol: DtpProtocolDefinition): string[] {
  const aliases = uniqueStrings([
    protocol.base_file_name,
    ...(protocol.aliases ?? []),
    protocol.protocol_id,
    protocol.source_section,
    ...protocolNumberedVariantAliases(protocol),
    ...protocol.evidence,
    ...protocol.evidence.map((item) => item
      .replace(/^(?:\u9644\s*)?\u8868\s*[A-Za-z0-9.\-]+\s*/i, "")
      .trim()),
  ].filter((item): item is string => Boolean(item)))
  const payloadLength = protocolPayloadLengthBytes(protocol)
  const identityText = aliases.join(" ")
  if (payloadLength && /(?:\u9065\u63a7.*\u6307\u4ee4|remote.*(?:command|cmd))/i.test(identityText)) {
    aliases.push(`${payloadLength}\u5b57\u8282\u9065\u63a7\u6307\u4ee4`)
  }
  return uniqueStrings(aliases)
}

function protocolIdentityFamilyText(value: string | undefined): string {
  return protocolIdentityText(value).replace(/\d+$/g, "")
}

function uploadEntitySubject(value: string | undefined): string | undefined {
  const normalized = normalizeLookupText(value)
  const subject = normalized.match(/(.{2,24})上注/)?.[1]
    ?.replace(/(?:spacewire|数据块|程序块|报文块|数据|程序)$/i, "")
  return subject && subject.length >= 2 ? subject : undefined
}

function protocolEntityConflictIsHard(protocol: DtpProtocolDefinition, stepText: string): boolean {
  const step = normalizeLookupText(stepText)
  const protocolName = normalizeLookupText(protocol.base_file_name)
  if (dtpBusProtocolEntityConflicts(protocol, step)) return true
  if (step.includes("遥测") && protocolName.includes("内存") && !step.includes("内存")) return true
  if (step.includes("内存") && protocolName.includes("遥测") && !step.includes("遥测")) return true
  const stepEntity = caseStepImplicitProtocolIntent(stepText).protocolEntity
  const stepUploadSubject = uploadEntitySubject(stepEntity)
  if (stepUploadSubject && protocol.block_layout) {
    const protocolSubjects = uniqueStrings([
      protocol.semantic_identity?.entity ?? "",
      protocol.base_file_name,
      ...(protocol.aliases ?? []),
    ])
      .map(uploadEntitySubject)
      .filter((subject): subject is string => Boolean(subject))
    if (
      protocolSubjects.length &&
      protocolSubjects.every((subject) => !subject.includes(stepUploadSubject) && !stepUploadSubject.includes(subject))
    ) return true
  }
  return false
}

function explicitStepHexBytes(stepText: string): string[] {
  return Array.from(stepText.matchAll(/(?:0x)?([0-9A-F]{2})H\b/gi))
    .map((match) => match[1].toUpperCase())
}

function protocolFixedPrefixBytes(protocol: DtpProtocolDefinition): string[] {
  return getDtpProtocolFrames(protocol).flatMap((frame) => {
    const prefix: string[] = []
    for (const token of frame.byte_layout) {
      const fixed = normalizeHexByte(token)
      if (!fixed) break
      prefix.push(fixed)
    }
    return prefix
  })
}

function protocolStepFingerprintScore(protocol: DtpProtocolDefinition, stepText: string): number {
  const explicitBytes = explicitStepHexBytes(stepText)
  const fixedPrefix = protocolFixedPrefixBytes(protocol)
  if (explicitBytes.length < 2 || fixedPrefix.length < 2) return 0
  let matched = 0
  for (let index = 0; index < Math.min(explicitBytes.length, fixedPrefix.length); index += 1) {
    if (explicitBytes[index] !== fixedPrefix[index]) break
    matched += 1
  }
  return matched >= 2 ? 20_000 + matched * 2_000 : 0
}

function protocolFamilyMatchesStep(protocol: DtpProtocolDefinition, stepText: string): boolean {
  const normalizedStep = protocolIdentityText(stepText)
  return protocolMatchAliases(protocol).some((alias) => {
    const family = protocolIdentityFamilyText(alias)
    return family.length >= 4 && normalizedStep.includes(family)
  })
}

type CaseProtocolSemanticRole = "time_broadcast" | "poll" | "telemetry" | "response" | "command" | "data_block" | "auxiliary"

function protocolSemanticRoleFromText(value: string | undefined): CaseProtocolSemanticRole | undefined {
  const text = (value ?? "").replace(/\s+/g, "")
  if (!text) return undefined
  if (/(?:\u661f\u52a1.*\u65f6\u95f4.*\u5e7f\u64ad|\u65f6\u95f4\u5e7f\u64ad|timebroadcast)/i.test(text)) return "time_broadcast"
  if (/(?:\u5e94\u7b54|\u54cd\u5e94|\u56de\u590d|reply|response|(?:^|[_-])ack(?:$|[_-]))/i.test(text)) return "response"
  if (/(?:\u8f6e\u8be2|poll)/i.test(text) && /(?:\u6307\u4ee4|\u5e8f\u5217|\u63a7\u5236|command)/i.test(text)) return "poll"
  if (/(?:\u9065\u6d4b\u6570\u636e|\u6570\u636e\u4f20\u9001|\u6570\u636e\u56de\u4f20|telemetrydata)/i.test(text)) return "telemetry"
  if (/(?:\u6307\u4ee4|\u547d\u4ee4|\u63a7\u5236\u5e8f\u5217|command|cmd)/i.test(text)) return "command"
  if (/(?:辅助数据包|auxiliarypacket)/i.test(text)) return "auxiliary"
  if (/(?:上行数据块|下行数据块|uplinkdatablock|downlinkdatablock)/i.test(text)) return "data_block"
  return undefined
}

function protocolSemanticRole(protocol: DtpProtocolDefinition): CaseProtocolSemanticRole | undefined {
  const normalizedRole = protocol.semantic_identity?.role
  return normalizedRole && normalizedRole !== "unknown"
    ? normalizedRole
    : protocolSemanticRoleFromText(protocol.base_file_name) ??
    (protocol.aliases ?? []).map(protocolSemanticRoleFromText).find(Boolean) ??
    protocolSemanticRoleFromText(protocol.source_section) ??
    protocolSemanticRoleFromText(protocol.evidence.join(" "))
}

function protocolSemanticRoleConflictIsHard(
  stepRole: CaseProtocolSemanticRole | undefined,
  protocolRole: CaseProtocolSemanticRole | undefined,
  _bus: DtpProtocolBusContext["bus_type"] | undefined,
): boolean {
  if (!stepRole || !protocolRole || stepRole === protocolRole) return false
  if (stepRole === "time_broadcast" || protocolRole === "time_broadcast") return true
  if (
    (stepRole === "poll" && protocolRole === "telemetry") ||
    (stepRole === "telemetry" && protocolRole === "poll")
  ) return true
  return (
    (stepRole === "command" && protocolRole === "response") ||
    (stepRole === "response" && protocolRole === "command")
  )
}

function protocolAnchorMatchesStep(protocol: DtpProtocolDefinition, stepText: string): boolean {
  if (!protocolFamilyMatchesStep(protocol, stepText)) return false
  const stepRole = protocolSemanticRoleFromText(stepText)
  const protocolRole = protocolSemanticRole(protocol)
  return !protocolSemanticRoleConflictIsHard(stepRole, protocolRole, protocol.bus_context?.bus_type)
}

function caseProtocolAnchors(
  caseContext: ConfirmationCase,
  definitions: DtpProtocolDefinitionsDocument | undefined,
): Map<number, string> {
  const anchors = new Map<number, string>()
  if (!definitions?.protocols.length) return anchors
  let activeProtocol: DtpProtocolDefinition | undefined
  let activeProtocolHasExplicitFrameEvidence = false
  for (const step of [...caseContext.steps].sort((left, right) => left.stepIndex - right.stepIndex)) {
    const stepText = semanticCaseStepDescription(step.stepDescription)
    // A framed byte sequence is stronger evidence than the legacy CANA/CANB
    // alias. Use it only while discovering a case anchor, never for ordinary
    // per-step protocol selection.
    const explicitFrameEvidence = hasExplicitFrameBytes(stepText)
    const anchorStepText = explicitFrameEvidence
      ? stepText.replace(/(?:\u901a\u8fc7)?CAN[AB]\s*\u603b\u7ebf/gi, "")
      : stepText
    const matchingFamily = activeProtocol && protocolAnchorMatchesStep(activeProtocol, stepText)
    const seedPlan: CaseStepDataGenerationPlan = {
      protocol_id: matchingFamily ? activeProtocol?.protocol_id : undefined,
      protocol_name: matchingFamily ? activeProtocol?.base_file_name : undefined,
      flow_direction: /(?:\u53d1\u9001|\u4e0b\u53d1|\u6ce8\u5165|\u5199\u5165)/.test(stepText) ? "input" : "unknown",
      bus: caseProtocolBusConstraint(stepText),
      variant_type: "unknown",
      mutations: [],
      sequence_operations: [],
      checksum_policy: "preserve",
      argument_values: {},
      evidence_ids: [],
      confidence: 0,
      warnings: [],
      source: "heuristic-fallback",
    }
    const resolution = resolveProtocolForCasePlanResult(seedPlan, definitions, anchorStepText, anchorStepText)
    if (resolution.protocol) {
      activeProtocol = resolution.protocol
      activeProtocolHasExplicitFrameEvidence = explicitFrameEvidence
    } else if (!(activeProtocolHasExplicitFrameEvidence && matchingFamily)) {
      // A failed or scope-conflicting resolution must normally break the
      // active chain. Keep only anchors originally established by explicit
      // frame bytes; this preserves legacy CANA/CANB cases whose metadata is
      // weaker than their concrete frame evidence.
      activeProtocol = undefined
      activeProtocolHasExplicitFrameEvidence = false
    }
    if (activeProtocol && protocolAnchorMatchesStep(activeProtocol, stepText)) {
      anchors.set(step.stepIndex, activeProtocol.protocol_id)
    }
  }
  return anchors
}

function commandCodeFromStepDescription(stepText: string): string | undefined {
  return stepText.match(/\b((?:TCY|CMD)[-_]?\d{2,})\b/i)?.[1]?.replace(/[-_]/g, "").toUpperCase()
}

type CommandDictionaryMatchSource = "command_code" | "exact_name" | "normalized_name"

function normalizedCommandName(value: string): string {
  return normalizeLookupText(value).replace(/(?:指令|命令)$/u, "")
}

function semanticCommandName(value: string): string {
  return normalizedCommandName(value)
    .replace(/信号/gu, "")
    .replace(/(?:设置|指令|命令)$/u, "")
}

function commandDictionaryNameMatchScore(entry: BusCommandDictionaryEntry, stepText: string): {
  score: number
  source: Exclude<CommandDictionaryMatchSource, "command_code">
} | undefined {
  const stepName = normalizedCommandName(stepText)
  const exactName = normalizedCommandName(entry.command_name)
  if (exactName.length >= 4 && stepName.includes(exactName)) {
    return { score: 2_000 + exactName.length, source: "exact_name" }
  }
  const semanticName = semanticCommandName(entry.command_name)
  const semanticStep = semanticCommandName(stepText)
  if (semanticName.length >= 4 && semanticStep.includes(semanticName)) {
    return { score: 1_000 + semanticName.length, source: "normalized_name" }
  }
  return undefined
}

function commandDictionaryEntryForStep(
  dictionaryIndex: CommandDictionaryIndex | undefined,
  stepText: string,
): { entry?: BusCommandDictionaryEntry; source?: CommandDictionaryMatchSource; warning?: string } {
  const commandCode = commandCodeFromStepDescription(stepText)
  if (!dictionaryIndex) return {}
  const bus = caseProtocolBusConstraint(stepText)
  const canScope = caseCanInterfaceConstraint(stepText)
  const scopedEntries = dictionaryIndex.entries.filter((entry) => (
    (!bus || !entry.bus_type || entry.bus_type === bus) &&
    (!canScope.level || !entry.interface_level || entry.interface_level === canScope.level)
  ))
  if (commandCode) {
    const candidates = scopedEntries.filter((entry) => (
      entry.command_code.replace(/[-_]/g, "").toUpperCase() === commandCode
    ))
    if (candidates.length === 1) return { entry: candidates[0], source: "command_code" }
    if (candidates.length > 1) {
      return { warning: `Command dictionary is ambiguous for ${commandCode}: ${candidates.map((entry) => entry.source_table_id).join(", ")}.` }
    }
    return { warning: `Command ${commandCode} was not found in the project command dictionary.` }
  }

  const ranked = scopedEntries.flatMap((entry) => {
    const match = commandDictionaryNameMatchScore(entry, stepText)
    return match ? [{ entry, ...match }] : []
  }).sort((left, right) => right.score - left.score)
  if (!ranked.length) return {}
  const topMatches = ranked.filter((candidate) => candidate.score === ranked[0].score)
  const topCommandCodes = uniqueStrings(topMatches.map((candidate) => candidate.entry.command_code))
  if (topCommandCodes.length > 1) {
    return {
      warning: `Command dictionary name is ambiguous for the step: ${topMatches.map((candidate) => `${candidate.entry.command_code} (${candidate.entry.command_name})`).join(", ")}.`,
    }
  }
  return { entry: ranked[0].entry, source: ranked[0].source }
}

function defaultCommandDictionaryEntryForStep(
  dictionaryIndex: CommandDictionaryIndex | undefined,
  protocol: DtpProtocolDefinition | undefined,
  stepText: string,
  plan: CaseStepDataGenerationPlan,
): BusCommandDictionaryEntry | undefined {
  if (!dictionaryIndex || !protocol || plan.command || commandCodeFromStepDescription(stepText)) return undefined
  if (!allowDtpBusCommandDictionaryDefault(protocol, stepText)) return undefined
  const semanticFaults = stepFieldMutations(stepText, getDtpProtocolFrames(protocol).length)
  if (semanticFaults.hasExplicitErrors || frameSequenceIntentFromStep(stepText, protocol).hasFault) return undefined

  const payloadLength = protocolPayloadLengthBytes(protocol)
  if (!payloadLength || uniqueProtocolPayloadLength(stepText) !== payloadLength) return undefined
  const unresolvedFields = new Set(unresolvedProtocolVariableFieldPlans(protocol, plan, stepText)
    .map((field) => field.field_name.toUpperCase())
    .filter((field) => /^(?:W|DATA)\d+$/.test(field)))
  if (!unresolvedFields.size) return undefined

  return dictionaryIndex.entries.find((entry) => {
    if (entry.bus_type && protocol.bus_context?.bus_type && entry.bus_type !== protocol.bus_context.bus_type) return false
    if (entry.interface_level && protocol.bus_context?.interface_level && entry.interface_level !== protocol.bus_context.interface_level) return false
    if (entry.payload_length_bytes !== payloadLength) return false
    const providedFields = new Set(entry.field_overrides.map((field) => field.field_name.toUpperCase()))
    return Array.from(unresolvedFields).every((field) => providedFields.has(field))
  })
}

function protocolForCommandDictionaryEntry(
  definitions: DtpProtocolDefinitionsDocument | undefined,
  entry: BusCommandDictionaryEntry,
  stepText: string,
): DtpProtocolDefinition | undefined {
  if (!definitions?.protocols.length) return undefined
  const candidates = definitions.protocols.filter((protocol) => {
    if (entry.bus_type && protocol.bus_context?.bus_type && protocol.bus_context.bus_type !== entry.bus_type) return false
    if (entry.interface_level && protocol.bus_context?.interface_level && protocol.bus_context.interface_level !== "unknown" && protocol.bus_context.interface_level !== entry.interface_level) return false
    if (entry.payload_length_bytes !== undefined && protocolPayloadLengthBytes(protocol) !== entry.payload_length_bytes) return false
    const role = protocolSemanticRole(protocol)
    if (role && role !== "command") return false
    return protocol.flow_direction === "input" || protocol.flow_direction === "unknown"
  })
  const ranked = candidates.map((protocol) => {
    const identity = normalizeProtocolMatchText([protocol.base_file_name, protocol.source_section].filter(Boolean).join(" "))
    const semantic = normalizeProtocolMatchText(stepText)
    let score = longestCommonSubstringLength(identity, semantic)
    if (/遥控/.test(stepText) && /遥控/.test([protocol.base_file_name, protocol.source_section].filter(Boolean).join(""))) score += 200
    if (entry.payload_length_bytes === protocolPayloadLengthBytes(protocol)) score += 100
    if (protocolSemanticRole(protocol) === "command") score += 500
    if (protocol.provenance?.some((item) => item.source_document_id === entry.source_document_id)) score += 2_000
    const provenancePriority = Math.max(0, ...(protocol.provenance ?? []).map((item) => (
      item.priority === "primary" ? 4 : item.priority === "referenced" ? 3 : item.priority === "supporting" ? 2 : 1
    )))
    score += provenancePriority * 100
    return { protocol, score }
  }).sort((left, right) => right.score - left.score || left.protocol.protocol_id.localeCompare(right.protocol.protocol_id))
  if (!ranked.length) return undefined
  const topCandidates = ranked.filter((candidate) => candidate.score === ranked[0].score)
  if (topCandidates.length > 1) {
    const physicalLayout = (protocol: DtpProtocolDefinition): string => JSON.stringify(
      getDtpProtocolFrames(protocol).map((frame) => frame.byte_layout.map((value) => value.trim().toUpperCase())),
    )
    if (new Set(topCandidates.map((candidate) => physicalLayout(candidate.protocol))).size > 1) return undefined
  }
  return ranked[0].protocol
}

function commandDictionaryMutations(
  entry: BusCommandDictionaryEntry,
  protocol: DtpProtocolDefinition | undefined,
): CaseStepDataMutation[] {
  return commandFieldPlanMutations(entry.field_overrides, protocol)
}

function resolvedCommandBaselineFieldNames(
  entry: BusCommandDictionaryEntry,
  protocol: DtpProtocolDefinition | undefined,
): Set<string> {
  const resolvedFields = new Set(entry.field_overrides.map((field) => field.field_name.toUpperCase()))
  for (const field of protocol?.fields ?? []) {
    if (normalizeHexByte(field.value)) resolvedFields.add(field.name.toUpperCase())
  }
  for (const frame of protocol ? getDtpProtocolFrames(protocol) : []) {
    for (const field of frame.field_layout) {
      const layoutToken = frame.byte_layout[field.byte_offset]
      if (normalizeHexByte(field.default_value) || normalizeHexByte(layoutToken)) {
        resolvedFields.add(field.name.toUpperCase())
      }
    }
  }
  return resolvedFields
}

function withoutModelCommandPayloadReplacements(
  mutations: CaseStepDataMutation[],
  entry: BusCommandDictionaryEntry,
  protocol: DtpProtocolDefinition | undefined,
): CaseStepDataMutation[] {
  const lockedFields = resolvedCommandBaselineFieldNames(entry, protocol)
  return mutations.filter((mutation) => !(
    mutation.operation === "replace" &&
    lockedFields.has(mutation.field.toUpperCase())
  ))
}

function specializeCommandFaultMutations(
  mutations: CaseStepDataMutation[],
  entry: BusCommandDictionaryEntry | undefined,
): { mutations: CaseStepDataMutation[]; warnings: string[] } {
  if (!entry) return { mutations, warnings: [] }
  const fieldPlans = new Map(entry.field_overrides.map((field) => [field.field_name.toUpperCase(), field]))
  const warnings: string[] = []
  return {
    mutations: mutations.map((mutation) => {
      if (mutation.operation !== "replace_with_invalid_value" || mutation.value) return mutation
      const fieldPlan = fieldPlans.get(mutation.field.toUpperCase())
      if (!fieldPlan?.source_text || !/D\s*[0-7]\s*[:：]/i.test(fieldPlan.source_text)) return mutation
      const reservedValue = commandDictionaryReservedBitByte(fieldPlan.source_text)
      if (!reservedValue) {
        warnings.push(`Command field ${mutation.field} is a bit field, but no documented reserved value is available for a deterministic invalid mutation.`)
        return mutation
      }
      return { ...mutation, value: reservedValue }
    }),
    warnings: uniqueStrings(warnings),
  }
}

function commandFieldPlanMutations(
  fields: PacketFieldValuePlan[],
  protocol: DtpProtocolDefinition | undefined,
): CaseStepDataMutation[] {
  return fields.map((field) => {
    const mutation: CaseStepDataMutation = {
      field: field.field_name,
      operation: "replace",
      value: field.value,
    }
    const targetFrames = mutationTargetCanonicalFrameIndexes(mutation, protocol)
    return {
      ...mutation,
      ...(targetFrames.length === 1 ? { frame_index: targetFrames[0] + 1 } : {}),
    }
  })
}

function commandDictionaryFieldPlans(
  plan: CaseStepDataGenerationPlan,
  dictionaryIndex: CommandDictionaryIndex | undefined,
): PacketFieldValuePlan[] {
  const command = plan.command
  if (!command || !dictionaryIndex) return []
  const entry = dictionaryIndex.entries.find((candidate) => (
    candidate.command_code === command.code &&
    candidate.source_table_id === command.source_table_id
  ))
  return entry?.field_overrides ?? []
}

function ambiguousCommandFieldWarnings(plan: CaseStepDataGenerationPlan): string[] {
  return plan.warnings.filter((warning) => (
    /^Command field W\d+ has documented non-literal values and requires semantic selection:/i.test(warning) ||
    /^Command field W\d+ is a bit field, but no documented reserved value is available/i.test(warning)
  ))
}

function commandGenerationBasis(plan: CaseStepDataGenerationPlan): string[] {
  return plan.command
    ? [`command:${plan.command.code}`, `command_table:${plan.command.source_table_id}`]
    : []
}

function commandFormatNotes(plan: CaseStepDataGenerationPlan): string[] {
  if (!plan.command) return []
  return [
    `Command ${plan.command.code} (${plan.command.name}) resolved from ${plan.command.source_table_caption ?? plan.command.source_table_id}.`,
  ]
}

function caseProtocolFlowConstraint(
  plan: CaseStepDataGenerationPlan,
  stepText: string,
): FlowDirection | undefined {
  const adapterConstraint = resolveDtpBusFlowConstraint(caseProtocolBusConstraint(stepText, plan.bus), stepText)
  if (adapterConstraint.handled) return adapterConstraint.flow
  if (/(?:\u53d1\u9001|\u4e0b\u53d1|\u6ce8\u5165|\u5199\u5165)/.test(stepText)) return "input"
  if (/(?:\u8f93\u51fa\u6d41|\u63a5\u6536\u6587\u4ef6|\u8bfb\u53d6\u6587\u4ef6)/.test(stepText)) return "output"
  return plan.flow_direction === "unknown" ? undefined : plan.flow_direction
}

function hasExplicitFrameBytes(stepText: string): boolean {
  return /(?:\u5e27|FRAME)\s*\d*\s*[:\uff1a]\s*(?:(?:0x)?[0-9A-F]{1,2}H?\s*){4,}/i.test(stepText)
}

function documentOrderDefaultProtocol(
  candidates: DtpProtocolDefinition[],
  definitions: DtpProtocolDefinitionsDocument,
  constraints: CaseProtocolSelectionConstraints,
  plan: CaseStepDataGenerationPlan,
  stepText: string,
  protocolAnchorId?: string,
): DtpProtocolDefinition | undefined {
  if (
    candidates.length < 2 ||
    constraints.payloadLengthBytes !== undefined ||
    plan.command ||
    commandCodeFromStepDescription(stepText) ||
    plan.protocol_id ||
    protocolAnchorId ||
    plan.selection_source === "data_file_hint" ||
    plan.selection_source === "case_anchor"
  ) {
    return undefined
  }

  const families = new Set(candidates.map((protocol) => protocolIdentityFamilyText(protocol.base_file_name)))
  const remoteCommandFamily = families.size === 1 && families.has(normalizeLookupText("遥控指令"))
  const genericTelemetryPollingFamily = (
    /遥测轮询控制序列/.test(stepText) &&
    !/遥测帧\s*[一二三四五六七八九十0-9]+/.test(stepText) &&
    candidates.every((protocol) => /遥测帧\s*[一二三四五六七八九十0-9]+轮询控制序列/.test(protocol.base_file_name)) &&
    new Set(candidates.map((protocol) => (
      normalizeLookupText(protocol.base_file_name).replace(/帧[一二三四五六七八九十0-9]+/, "帧")
    ))).size === 1
  )
  if (!remoteCommandFamily && !genericTelemetryPollingFamily) return undefined

  const scopes = new Set(candidates.map((protocol) => [
    protocol.bus_context?.bus_type ?? "unknown",
    protocol.bus_context?.interface_level ?? "unknown",
    protocol.bus_context?.interface_id ?? "unknown",
    protocol.flow_direction,
  ].join("|")))
  if (scopes.size !== 1) return undefined

  if (remoteCommandFamily) {
    const lengths = candidates.map((protocol) => protocolPayloadLengthEvidence(protocol))
    if (lengths.some((item) => !item.intrinsic || item.value === undefined)) return undefined
    if (new Set(lengths.map((item) => item.value)).size !== candidates.length) return undefined
  }

  const documentOrder = new Map(definitions.protocols.map((protocol, index) => [protocol.protocol_id, index]))
  const sourceTableOrder = (protocol: DtpProtocolDefinition): number => Math.min(
    ...getDtpProtocolFrames(protocol).map((frame) => {
      const ordinal = frame.source_table_id.match(/(?:^|[-_])table[-_](\d+)(?:$|[-_])/i)?.[1]
      return ordinal ? Number.parseInt(ordinal, 10) : Number.MAX_SAFE_INTEGER
    }),
  )
  return [...candidates].sort((left, right) => {
    const tableOrder = sourceTableOrder(left) - sourceTableOrder(right)
    if (tableOrder !== 0) return tableOrder
    return (documentOrder.get(left.protocol_id) ?? Number.MAX_SAFE_INTEGER) -
      (documentOrder.get(right.protocol_id) ?? Number.MAX_SAFE_INTEGER)
  })[0]
}

function composeOrderedProtocolGroup(
  definitions: DtpProtocolDefinitionsDocument,
  group: DtpProtocolGroup,
): DtpProtocolDefinition | undefined {
  const byId = new Map(definitions.protocols.map((protocol) => [protocol.protocol_id, protocol]))
  const children = group.protocol_ids
    .map((protocolId) => byId.get(protocolId))
    .filter((protocol): protocol is DtpProtocolDefinition => Boolean(protocol))
  if (children.length !== group.protocol_ids.length || children.length < 2) return undefined
  if (children.some((protocol) => protocol.block_layout)) return undefined
  const scopeKeys = new Set(children.map((protocol) => [
    protocol.bus_context?.bus_type ?? "unknown",
    protocol.bus_context?.interface_level ?? "unknown",
    protocol.bus_context?.interface_id ?? "unknown",
    protocol.flow_direction,
  ].join("|")))
  if (scopeKeys.size !== 1) return undefined

  let frameStart = 1
  const compositionChildren: DtpProtocolComposition["children"] = []
  const frames = children.flatMap((protocol) => {
    const childFrames = getDtpProtocolFrames(protocol)
    compositionChildren.push({
      protocol_id: protocol.protocol_id,
      frame_start: frameStart,
      frame_count: childFrames.length,
    })
    frameStart += childFrames.length
    return childFrames.map((frame) => ({
      ...frame,
      frame_id: `${protocol.protocol_id}:${frame.frame_id}`,
      sequence: compositionChildren.at(-1)!.frame_start + frame.sequence - 1,
      packet_group_id: protocol.protocol_id,
    }))
  })
  const variables = new Map<string, DtpProtocolVariableDefinition>()
  for (const variable of children.flatMap((protocol) => protocol.variables ?? [])) {
    variables.set(variable.name, variable)
  }
  return {
    protocol_id: group.group_id,
    source_section: uniqueStrings(children.map((protocol) => protocol.source_section ?? "").filter(Boolean)).join("; "),
    flow_direction: group.flow_direction,
    base_file_name: group.name,
    aliases: uniqueStrings([group.name, ...(group.aliases ?? [])]),
    generation_mode: "single_file",
    frames,
    bus_context: children[0].bus_context,
    variables: [...variables.values()],
    frame_envelope: children.every((protocol) => JSON.stringify(protocol.frame_envelope) === JSON.stringify(children[0].frame_envelope))
      ? children[0].frame_envelope
      : undefined,
    fields: children.flatMap((protocol) => protocol.fields),
    evidence: uniqueStrings([...group.evidence, ...children.flatMap((protocol) => protocol.evidence)]),
    warnings: uniqueStrings([...group.warnings, ...children.flatMap((protocol) => protocol.warnings)]),
    confidence: Math.min(...children.map((protocol) => protocol.confidence)),
    understanding_source: children.some((protocol) => protocol.understanding_source === "heuristic-fallback")
      ? "heuristic-fallback"
      : "model",
    composition: {
      group_id: group.group_id,
      children: compositionChildren,
    },
  }
}

function resolveOrderedProtocolGroup(
  plan: CaseStepDataGenerationPlan,
  definitions: DtpProtocolDefinitionsDocument,
  semanticText: string,
  stepText: string,
  busConstraint: DtpProtocolBusContext["bus_type"] | undefined,
  interfaceConstraint: CaseCanInterfaceConstraint,
  flowConstraint: FlowDirection | undefined,
): { protocol: DtpProtocolDefinition; childProtocolIds: string[] } | undefined {
  const identityText = protocolIdentityText(semanticText)
  const targetText = protocolIdentityText([semanticText, plan.protocol_name, plan.base_file_name].filter(Boolean).join(" "))
  for (const group of definitions.protocol_groups ?? []) {
    const children = group.protocol_ids
      .map((protocolId) => definitions.protocols.find((protocol) => protocol.protocol_id === protocolId))
      .filter((protocol): protocol is DtpProtocolDefinition => Boolean(protocol))
    if (children.length !== group.protocol_ids.length) continue
    const explicitChild = children.some((protocol) => protocolNumberedVariantAliases(protocol).some((alias) => {
      const identity = protocolIdentityText(alias)
      return identity.length >= 4 && identityText.includes(identity)
    }))
    if (explicitChild && plan.protocol_id !== group.group_id) continue
    const groupAliases = uniqueStrings([group.name, ...(group.aliases ?? [])])
    const groupMatches = plan.protocol_id === group.group_id || groupAliases.some((alias) => {
      const identity = protocolIdentityText(alias)
      return identity.length >= 4 && targetText.includes(identity)
    })
    if (!groupMatches) continue
    const first = children[0]
    if (busConstraint && first.bus_context?.bus_type && first.bus_context.bus_type !== "unknown" && first.bus_context.bus_type !== busConstraint) continue
    if (interfaceConstraint.interfaceId && first.bus_context?.interface_id?.toUpperCase() !== interfaceConstraint.interfaceId) continue
    if (interfaceConstraint.level && first.bus_context?.interface_level && first.bus_context.interface_level !== "unknown" && first.bus_context.interface_level !== interfaceConstraint.level) continue
    if (flowConstraint && first.flow_direction !== "unknown" && first.flow_direction !== flowConstraint) continue
    const protocol = composeOrderedProtocolGroup(definitions, group)
    if (protocol) return { protocol, childProtocolIds: group.protocol_ids }
  }
  return undefined
}

function resolveProtocolForCasePlanResult(
  plan: CaseStepDataGenerationPlan,
  definitions: DtpProtocolDefinitionsDocument | undefined,
  semanticText = "",
  stepText = semanticText,
  protocolAnchorId?: string,
): CaseProtocolResolution {
  const constraints = caseProtocolSelectionConstraints(semanticText, stepText)
  const busConstraint = caseProtocolBusConstraint(stepText, plan.bus)
  if (!definitions?.protocols.length) {
    return { constraints, busConstraint, interfaceConstraint: caseCanInterfaceConstraint(stepText), ambiguous: false, candidateProtocolIds: [], selectedScopeConflicts: [], rejectedProtocols: [] }
  }
  const normalizedSemantic = normalizeProtocolMatchText(semanticText)
  const normalizedIdentitySemantic = protocolIdentityText(semanticText)
  const rawSemantic = semanticText.toLowerCase()
  const flowConstraint = caseProtocolFlowConstraint(plan, stepText)
  const interfaceConstraint = caseCanInterfaceConstraint(stepText)
  const orderedGroup = resolveOrderedProtocolGroup(
    plan,
    definitions,
    semanticText,
    stepText,
    busConstraint,
    interfaceConstraint,
    flowConstraint,
  )
  if (orderedGroup) {
    return {
      protocol: orderedGroup.protocol,
      constraints,
      busConstraint,
      interfaceConstraint,
      ambiguous: false,
      candidateProtocolIds: orderedGroup.childProtocolIds,
      selectedScopeConflicts: [],
      rejectedProtocols: [],
    }
  }
  const stepSemanticRole = protocolSemanticRoleFromText(stepText)
  const targets = [plan.protocol_name, plan.base_file_name]
    .map((item) => normalizeProtocolMatchText(item))
    .filter(Boolean)
  const explicitProtocolId = plan.protocol_id ?? definitions.protocols.find((protocol) => (
    normalizeLookupText(protocol.protocol_id) === normalizeLookupText(plan.protocol_name)
  ))?.protocol_id
  const rejectedProtocols: CaseProtocolResolution["rejectedProtocols"] = []
  const eligibleProtocols = definitions.protocols.filter((protocol) => {
    const protocolInterface = protocol.bus_context
    if (
      busConstraint &&
      protocolInterface?.bus_type &&
      protocolInterface.bus_type !== "unknown" &&
      protocolInterface.bus_type !== busConstraint
    ) {
      rejectedProtocols.push({ protocol_id: protocol.protocol_id, reason: `bus ${protocolInterface.bus_type} conflicts with step bus ${busConstraint}` })
      return false
    }
    if (
      interfaceConstraint.interfaceId &&
      protocolInterface?.interface_id &&
      interfaceConstraint.interfaceId !== protocolInterface.interface_id.toUpperCase()
    ) {
      rejectedProtocols.push({ protocol_id: protocol.protocol_id, reason: `interface ${protocolInterface.interface_id} conflicts with step interface ${interfaceConstraint.interfaceId}` })
      return false
    }
    if (
      interfaceConstraint.level &&
      protocolInterface?.interface_level &&
      protocolInterface.interface_level !== "unknown" &&
      protocolInterface.interface_level !== interfaceConstraint.level
    ) {
      rejectedProtocols.push({ protocol_id: protocol.protocol_id, reason: `${protocolInterface.interface_level} CAN conflicts with step ${interfaceConstraint.level} CAN` })
      // Interface scope is a hard constraint. A generic protocol name must not
      // override an explicit primary/secondary CAN selection. The sole
      // exception is a case anchor already established from concrete bytes.
      return protocol.protocol_id === protocolAnchorId
    }
    if (flowConstraint && protocol.flow_direction !== "unknown" && protocol.flow_direction !== flowConstraint) {
      rejectedProtocols.push({ protocol_id: protocol.protocol_id, reason: `flow ${protocol.flow_direction} conflicts with step flow ${flowConstraint}` })
      // Sending/injecting a packet and receiving/reading a packet use
      // different artifacts; never retain a conflicting flow by name match.
      return protocol.protocol_id === protocolAnchorId
    }
    const protocolRole = protocolSemanticRole(protocol)
    if (protocolSemanticRoleConflictIsHard(stepSemanticRole, protocolRole, busConstraint)) {
      rejectedProtocols.push({
        protocol_id: protocol.protocol_id,
        reason: `semantic role ${protocolRole} conflicts with step role ${stepSemanticRole}`,
      })
      return false
    }
    if (protocolEntityConflictIsHard(protocol, stepText)) {
      rejectedProtocols.push({
        protocol_id: protocol.protocol_id,
        reason: "protocol entity conflicts with the step entity",
      })
      return false
    }
    const lengthEvidence = protocolPayloadLengthEvidence(protocol)
    const relatedMessageLength = protocolRelatedMessageLengthBytes(protocol, definitions)
    const comparableLength = constraints.payloadLengthScope === "related_message"
      ? relatedMessageLength
      : lengthEvidence.value
    const comparableLengthIsIntrinsic = constraints.payloadLengthScope === "related_message"
      ? relatedMessageLength !== undefined
      : lengthEvidence.intrinsic
    if (
      constraints.payloadLengthBytes !== undefined &&
      comparableLengthIsIntrinsic &&
      comparableLength !== undefined &&
      comparableLength !== constraints.payloadLengthBytes
    ) {
      rejectedProtocols.push({
        protocol_id: protocol.protocol_id,
        reason: `${constraints.payloadLengthScope === "related_message" ? "related message" : "payload"} length ${comparableLength} conflicts with step length ${constraints.payloadLengthBytes}`,
      })
      return false
    }
    return true
  })
  const selectorMatch = protocolFromSelectorRelations(
    eligibleProtocols,
    definitions,
    stepText,
    busConstraint,
    interfaceConstraint,
  )
  if (selectorMatch?.ambiguous) {
    return {
      constraints,
      busConstraint,
      interfaceConstraint,
      ambiguous: true,
      candidateProtocolIds: selectorMatch.candidates.map((protocol) => protocol.protocol_id),
      selectorRelationId: selectorMatch.relationIds[0],
      selectorRelationIds: selectorMatch.relationIds,
      selectorTargetFrameCount: selectorMatch.targetFrameCount,
      selectorValue: selectorMatch.selectorValue,
      selectedScopeConflicts: [],
      rejectedProtocols: uniqueRejectedProtocols(rejectedProtocols),
    }
  }
  if (selectorMatch?.protocol) {
    return {
      protocol: selectorMatch.protocol,
      constraints,
      busConstraint,
      interfaceConstraint,
      ambiguous: false,
      candidateProtocolIds: [selectorMatch.protocol.protocol_id],
      selectorRelationId: selectorMatch.relationIds[0],
      selectorRelationIds: selectorMatch.relationIds,
      selectorTargetFrameCount: selectorMatch.targetFrameCount,
      selectorValue: selectorMatch.selectorValue,
      selectedScopeConflicts: [],
      rejectedProtocols: uniqueRejectedProtocols(rejectedProtocols),
    }
  }
  const selectorConstrainedProtocols = selectorMatch?.candidates.length
    ? selectorMatch.candidates
    : eligibleProtocols
  if (selectorMatch?.candidates.length) {
    const allowedIds = new Set(selectorMatch.candidates.map((protocol) => protocol.protocol_id))
    rejectedProtocols.push(...eligibleProtocols
      .filter((protocol) => !allowedIds.has(protocol.protocol_id))
      .map((protocol) => ({
        protocol_id: protocol.protocol_id,
        reason: selectorMatch.targetFrameCount !== undefined
          ? `selector requires ${selectorMatch.targetFrameCount} frame(s)`
          : "selector targets a different protocol variant",
      })))
  }
  const identityMatches = new Set(selectorConstrainedProtocols
    .filter((protocol) => protocolMatchAliases(protocol).some((alias) => {
      const identity = protocolIdentityText(alias)
      return identity.length >= 4 && normalizedIdentitySemantic.includes(identity)
    }))
    .map((protocol) => protocol.protocol_id))
  const ranked = selectorConstrainedProtocols.flatMap((protocol) => {
    const lengthEvidence = protocolPayloadLengthEvidence(protocol)
    const relatedMessageLength = protocolRelatedMessageLengthBytes(protocol, definitions)
    const protocolLength = constraints.payloadLengthScope === "related_message"
      ? relatedMessageLength
      : lengthEvidence.value
    const identityMatch = identityMatches.has(protocol.protocol_id)
    const numberedVariantMatch = protocolNumberedVariantAliases(protocol).some((alias) => {
      const identity = protocolIdentityText(alias)
      return identity.length >= 4 && normalizedIdentitySemantic.includes(identity)
    })
    const candidates = protocolMatchAliases(protocol)
      .map((item) => normalizeProtocolMatchText(item))
      .filter(Boolean)
    let score = 0
    if (busConstraint && protocol.bus_context?.bus_type === busConstraint) score += 18_000
    if (interfaceConstraint.interfaceId && protocol.bus_context?.interface_id?.toUpperCase() === interfaceConstraint.interfaceId) score += 15_000
    if (interfaceConstraint.level && protocol.bus_context?.interface_level === interfaceConstraint.level) score += 12_000
    if (explicitProtocolId === protocol.protocol_id && (identityMatch || identityMatches.size === 0)) score += 60_000
    if (
      constraints.payloadLengthBytes !== undefined &&
      protocolLength === constraints.payloadLengthBytes
    ) {
      score += constraints.payloadLengthScope === "related_message" || lengthEvidence.intrinsic ? 10_000 : 100
    }
    if (identityMatch) score += 50_000
    if (numberedVariantMatch) score += 90_000
    const protocolRole = protocolSemanticRole(protocol)
    if (stepSemanticRole && protocolRole === stepSemanticRole) score += 40_000
    score += protocolStepFingerprintScore(protocol, stepText)
    score += protocolImplicitEntityScore(protocol, stepText)
    if (protocol.base_file_name && rawSemantic.includes(protocol.base_file_name.toLowerCase())) {
      score += 10_000 + protocol.base_file_name.length
    }
    for (const candidate of candidates) {
      if (candidate.length >= 4 && normalizedSemantic && normalizedSemantic.includes(candidate)) {
        score += 400 + candidate.length
      } else if (normalizedSemantic) {
        const overlap = longestCommonSubstringLength(normalizedSemantic, candidate)
        if (overlap >= 8) score += Math.min(80, overlap * 4)
      }
      for (const target of targets) {
        if (candidate === target) score += 300
        else if (
          candidate.length >= 4 &&
          target.length >= 4 &&
          (candidate.includes(target) || target.includes(candidate))
        ) {
          score += 120 + Math.min(candidate.length, target.length)
        }
      }
    }
    if (constraints.declaredFrameCount === getDtpProtocolFrames(protocol).length) score += 40
    if (flowConstraint && protocol.flow_direction === flowConstraint) score += 100
    else if (plan.flow_direction !== "unknown" && protocol.flow_direction === plan.flow_direction) score += 8
    return [{ protocol, score }]
  }).sort((left, right) => right.score - left.score)

  const topScore = ranked[0]?.score ?? 0
  if (topScore < 120 && !selectorMatch) {
    return {
      constraints,
      busConstraint,
      interfaceConstraint,
      ambiguous: false,
      candidateProtocolIds: [],
      selectedScopeConflicts: [],
      rejectedProtocols: uniqueRejectedProtocols(rejectedProtocols.concat(ranked.slice(0, 5).map((item) => ({
          protocol_id: item.protocol.protocol_id,
          reason: "protocol identity is not present strongly enough in step_desc",
        })))),
    }
  }
  const topCandidates = ranked.filter((item) => item.score === topScore)
  if (topCandidates.length > 1) {
    const equivalentProtocol = selectPhysicallyEquivalentProtocol(
      topCandidates.map((item) => item.protocol),
      definitions,
    )
    if (equivalentProtocol) {
      return {
        protocol: equivalentProtocol,
        constraints,
        busConstraint,
        interfaceConstraint,
        ambiguous: false,
        candidateProtocolIds: topCandidates.map((item) => item.protocol.protocol_id),
        equivalentSelected: true,
        selectorRelationId: selectorMatch?.relationIds[0],
        selectorRelationIds: selectorMatch?.relationIds,
        selectorTargetFrameCount: selectorMatch?.targetFrameCount,
        selectorValue: selectorMatch?.selectorValue,
        selectedScopeConflicts: [],
        rejectedProtocols,
      }
    }
    const defaultProtocol = documentOrderDefaultProtocol(
      topCandidates.map((item) => item.protocol),
      definitions,
      constraints,
      plan,
      stepText,
      protocolAnchorId,
    )
    if (defaultProtocol) {
      return {
        protocol: defaultProtocol,
        constraints,
        busConstraint,
        interfaceConstraint,
        ambiguous: false,
        candidateProtocolIds: topCandidates.map((item) => item.protocol.protocol_id),
        defaultSelected: true,
        selectorRelationId: selectorMatch?.relationIds[0],
        selectorRelationIds: selectorMatch?.relationIds,
        selectorTargetFrameCount: selectorMatch?.targetFrameCount,
        selectorValue: selectorMatch?.selectorValue,
        selectedScopeConflicts: [],
        rejectedProtocols,
      }
    }
    return {
      constraints,
      busConstraint,
      interfaceConstraint,
      ambiguous: true,
      candidateProtocolIds: topCandidates.map((item) => item.protocol.protocol_id),
      selectorRelationId: selectorMatch?.relationIds[0],
      selectorRelationIds: selectorMatch?.relationIds,
      selectorTargetFrameCount: selectorMatch?.targetFrameCount,
      selectorValue: selectorMatch?.selectorValue,
      selectedScopeConflicts: [],
      rejectedProtocols,
    }
  }
  const selectedProtocolId = topCandidates[0].protocol.protocol_id
  const semanticRelationId = constraints.payloadLengthScope === "related_message"
    ? definitions.relations?.find((relation) => (
        relation.type === "responds_to" &&
        relation.source_kind === "protocol" &&
        relation.source_id === selectedProtocolId
      ))?.relation_id
    : undefined
  const selectedScopeConflicts = rejectedProtocols
    .filter((item) => item.protocol_id === selectedProtocolId && protocolAnchorId === selectedProtocolId)
    .map((item) => item.reason)
  return {
    protocol: topCandidates[0].protocol,
    constraints,
    busConstraint,
    interfaceConstraint,
    ambiguous: false,
    candidateProtocolIds: [selectedProtocolId],
    selectorRelationId: selectorMatch?.relationIds[0],
    selectorRelationIds: selectorMatch?.relationIds,
    selectorTargetFrameCount: selectorMatch?.targetFrameCount,
    selectorValue: selectorMatch?.selectorValue,
    semanticRelationId,
    selectedScopeConflicts,
    rejectedProtocols: uniqueRejectedProtocols(rejectedProtocols.concat(ranked
      .filter((item) => item.protocol.protocol_id !== selectedProtocolId)
      .slice(0, 5)
      .map((item) => ({
        protocol_id: item.protocol.protocol_id,
        reason: item.score >= 120
          ? "step_desc produced a lower protocol identity score"
          : "protocol identity is not present strongly enough in step_desc",
      })))),
  }
}

function resolveProtocolForCasePlan(
  plan: CaseStepDataGenerationPlan,
  definitions: DtpProtocolDefinitionsDocument | undefined,
  semanticText = "",
  stepText = semanticText,
  protocolAnchorId?: string,
): DtpProtocolDefinition | undefined {
  return resolveProtocolForCasePlanResult(plan, definitions, semanticText, stepText, protocolAnchorId).protocol
}

function findProtocolForDataFileEntry(
  definitions: DtpProtocolDefinitionsDocument | undefined,
  entry: GeneratedDataFileIndexEntry | null,
  plan: CaseStepDataGenerationPlan,
  semanticText: string,
  stepText: string,
  protocolAnchorId?: string,
): DtpProtocolDefinition | undefined {
  if (!definitions || !entry) return undefined
  const entryKeys = new Set(uniqueStrings([
    normalizeLookupText(entry.protocol_name),
    normalizeLookupText(entry.requested_file_name),
  ]).filter(Boolean))
  const matchingProtocols = definitions.protocols.filter((protocol) =>
    [protocol.base_file_name, protocol.protocol_id]
      .map(normalizeLookupText)
      .some((key) => entryKeys.has(key)),
  )
  if (!matchingProtocols.length) return undefined
  return resolveProtocolForCasePlan(
    plan,
    { ...definitions, protocols: matchingProtocols },
    semanticText,
    stepText,
    protocolAnchorId,
  )
}

function caseStepSemanticText(input: BuildGeneratedStepInput): string {
  return semanticCaseStepDescription(input.step.stepDescription)
}

function isParenthesizedHexFrameExample(value: string): boolean {
  const tokens = value.trim().split(/[\s,，、;；:：|/\\-]+/).filter(Boolean)
  return tokens.length >= 3 && tokens.every((token) => /^(?:0x)?[0-9A-F]{1,2}H?$/i.test(token))
}

function semanticCaseStepDescription(value: string | undefined): string {
  return (value ?? "")
    .replace(/[（(]([^（）()]*)[）)]/g, (matched, content: string) => (
      isParenthesizedHexFrameExample(content) ? " " : matched
    ))
    .replace(/\s+/g, " ")
    .trim()
}

type CaseStepImplicitProtocolIntent = {
  operation?: CaseStepDataGenerationPlan["operation"]
  targetAddress?: string
  protocolEntity?: string
  artifactScope?: CaseStepDataGenerationPlan["artifact_scope"]
  selectedBlock?: CaseStepDataGenerationPlan["selected_block"]
}

function implicitProtocolEntityText(value: string | undefined): string {
  return normalizeLookupText((value ?? "")
    .replace(/第\s*\d+(?:\.\d+)?\s*秒/gi, " ")
    .replace(/(?:内存|存储|映射)?地址\s*(?:为|是|=|：|:)?\s*(?:0x)?[0-9A-F]{4,16}H?/gi, " ")
    .replace(/(?:设置|写入|写到|装载|加载|存入|置入|配置|发送|下发|注入|接收)/g, " ")
    .replace(/(?:起始块|首块|第一块|初始块|中间块|续块|校验块|末块|完整数据块|整包|全包)/g, " ")
    .replace(/(?:全部字段|所有字段|其余字段)?(?:正确|正常|错误|异常|非法)/g, " ")
    .replace(/(?:的)?数据为|(?:的)?内容为|(?:的)?数据|总线|接口/g, " ")
    .replace(/(?:数据块|程序块|报文块|分块)/g, " "))
}

function caseStepImplicitProtocolIntent(value: string | undefined): CaseStepImplicitProtocolIntent {
  const text = semanticCaseStepDescription(value)
  const targetAddress = normalizePlanTargetAddress(text.match(
    /(?:内存|存储|映射)?地址\s*(?:为|是|=|：|:)?\s*((?:0x)?[0-9A-F]{4,16}H?)/i,
  )?.[1])
  const memoryWrite = (
    /(?:设置|写入|写到|装载|加载|存入|置入|配置)[^。；;\n]{0,32}(?:内存|地址)/.test(text) ||
    /(?:内存|地址)[^。；;\n]{0,32}(?:设置|写入|写到|装载|加载|存入|置入|配置)/.test(text)
  )
  const selectedBlock: CaseStepDataGenerationPlan["selected_block"] =
    /(?:起始块|首块|第一块|初始块)/.test(text)
      ? "start-block"
      : /(?:中间块|续块)/.test(text)
        ? "middle-block"
        : /(?:校验块|末块)/.test(text)
          ? "check-block"
          : undefined
  const fullPackage = /(?:完整(?:的)?[^。；;\n]{0,16}(?:上注|数据块)|(?:整包|全包)[^。；;\n]{0,16}(?:上注|程序))/.test(text)
  const protocolEntity = selectedBlock || memoryWrite
    ? implicitProtocolEntityText(text)
    : undefined
  return {
    operation: memoryWrite
      ? "memory_write"
      : /(?:发送|下发|注入)/.test(text)
        ? "bus_send"
        : /(?:接收|读取)/.test(text)
          ? "bus_receive"
          : undefined,
    targetAddress,
    protocolEntity: protocolEntity && protocolEntity.length >= 4 ? protocolEntity : undefined,
    artifactScope: selectedBlock ? "single_block" : fullPackage ? "full_package" : undefined,
    selectedBlock,
  }
}

function dataFileEntryMatchesSelectedProtocolBlock(
  entry: GeneratedDataFileIndexEntry | null | undefined,
  protocol: DtpProtocolDefinition | undefined,
  selectedBlock: CaseStepDataGenerationPlan["selected_block"],
): boolean {
  if (!entry || !protocol?.block_layout || !selectedBlock) return false
  const entryIntent = caseStepImplicitProtocolIntent(entry.requested_file_name)
  return entryIntent.selectedBlock === selectedBlock && protocolImplicitEntityScore(
    protocol,
    entry.requested_file_name,
  ) > 0
}

function parseFrameCount(value: string | undefined): number | undefined {
  if (!value) return undefined
  if (/^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10)
    return parsed > 0 ? parsed : undefined
  }
  const digits: Record<string, number> = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  }
  if (value === "十") return 10
  const [tensText, unitsText] = value.split("十")
  if (value.includes("十")) {
    const tens = tensText ? digits[tensText] : 1
    const units = unitsText ? digits[unitsText] : 0
    return tens === undefined || units === undefined ? undefined : tens * 10 + units
  }
  return digits[value]
}

function declaredFrameCountFromStep(text: string): number | undefined {
  const match = text.match(/共\s*([0-9一二三四五六七八九十两]+)\s*帧(?:发送)?/)
  return parseFrameCount(match?.[1])
}

function frameSequenceField(
  protocol: DtpProtocolDefinition | undefined,
  frameIndex: number,
): DtpProtocolFieldLayout | undefined {
  const frames = protocol ? getDtpProtocolFrames(protocol) : []
  const frame = frames[frameIndex - 1]
  if (!frame) return undefined
  const explicit = frame.field_layout.find((field) => field.role === "sequence") ??
    frame.field_layout.find((field) => /^(?:FRAME_SEQUENCE|FRAME_INDEX|SEQUENCE|INDEX)$/i.test(field.name))
  if (explicit) return explicit
  if (frames.length < 2) return undefined
  const expected = (frameIndex - 1).toString(16).toUpperCase().padStart(2, "0")
  return frame.field_layout.find((field) => (
    field.byte_offset === 2 &&
    (field.role === "fixed" || field.role === "unknown") &&
    (normalizeHexByte(field.default_value) ?? normalizeHexByte(frame.byte_layout[field.byte_offset])) === expected
  ))
}

function frameSequenceValue(
  protocol: DtpProtocolDefinition | undefined,
  frameIndex: number,
): string | undefined {
  const frame = protocol ? getDtpProtocolFrames(protocol)[frameIndex - 1] : undefined
  const field = frameSequenceField(protocol, frameIndex)
  return frame && field
    ? normalizeHexByte(field.default_value) ?? normalizeHexByte(frame.byte_layout[field.byte_offset])
    : undefined
}

function frameIndexForSequenceValue(
  protocol: DtpProtocolDefinition | undefined,
  value: string | undefined,
): number | undefined {
  const normalized = normalizeHexByte(value)
  if (!protocol || !normalized) return undefined
  return getDtpProtocolFrames(protocol).findIndex((_, index) => frameSequenceValue(protocol, index + 1) === normalized) + 1 || undefined
}

type CaseStepFrameSequenceIntent = {
  mentioned: boolean
  hasFault: boolean
  declaredFrameCount?: number
  targetSequence?: string[]
  mutations: CaseStepDataMutation[]
  operations: CaseStepSequenceOperation[]
  warnings: string[]
}

function explicitFrameSequenceValues(text: string): string[] {
  const sequenceClausePatterns = [
    /帧序号序列\s*(?:为|=|＝|:|：)?\s*([^。；;\n）)]*?)(?=(?:共\s*[0-9一二三四五六七八九十两]+\s*帧|[。；;\n）)]|$))/i,
    /(?:首帧|尾帧|最后一帧|中间帧|第\s*\d+\s*帧)?\s*帧序号\s*(?:错误|异常|不正确|非法)\s*(?:即|为|=|＝|:|：)?\s*(?:帧序号)?\s*((?:(?:0x)?[0-9A-F]{1,2}H)[^。；;\n）)]*?)(?=(?:共\s*[0-9一二三四五六七八九十两]+\s*帧|[。；;\n）)]|$))/i,
  ]
  const clause = sequenceClausePatterns
    .map((pattern) => text.match(pattern)?.[1])
    .find((value): value is string => Boolean(value))
  if (!clause) return []
  const values: string[] = []
  for (const item of clause.matchAll(
    /(?:0x)?([0-9A-F]{1,2})H(?:\s*(?:~|～|至|到)\s*(?:0x)?([0-9A-F]{1,2})H)?/gi,
  )) {
    const start = normalizeHexByte(item[1])
    const end = normalizeHexByte(item[2])
    if (!start) continue
    if (!end) {
      values.push(start)
      continue
    }

    const startNumber = Number.parseInt(start, 16)
    const endNumber = Number.parseInt(end, 16)
    // Descending ranges describe an invalid or intentionally abnormal sequence;
    // retain both endpoints instead of inventing intermediate frames.
    if (startNumber > endNumber) {
      values.push(start, end)
      continue
    }
    for (let value = startNumber; value <= endNumber; value += 1) {
      values.push(value.toString(16).toUpperCase().padStart(2, "0"))
    }
  }
  return values
}

function stepDescribesFrameSequenceFault(text: string): boolean {
  return /(?:帧序号|帧索引|\bINDEX\b)[^，,。；;\n]{0,24}(?:错误|异常|不正确|非法)/i.test(text) ||
    /(?:错误|异常|不正确|非法)[^，,。；;\n]{0,16}(?:帧序号|帧索引|\bINDEX\b)/i.test(text)
}

const UNRESOLVED_FRAME_SEQUENCE_FAULT_MESSAGE =
  "The step describes a frame-sequence fault, but no deterministic frame-sequence mutation could be resolved."

function explicitFrameSequenceIntent(
  targetSequence: string[],
  protocol: DtpProtocolDefinition | undefined,
): Pick<CaseStepFrameSequenceIntent, "hasFault" | "mutations" | "operations" | "warnings"> {
  const frames = protocol ? getDtpProtocolFrames(protocol) : []
  const canonicalSequence = frames.map((_, index) => frameSequenceValue(protocol, index + 1))
  const warnings: string[] = []
  if (!targetSequence.length || !frames.length || canonicalSequence.some((value) => !value)) {
    return {
      hasFault: false,
      mutations: [],
      operations: [],
      warnings: ["Frame sequence values are declared, but the canonical protocol sequence fields are unavailable."],
    }
  }

  const operations: CaseStepSequenceOperation[] = []
  if (targetSequence.length !== canonicalSequence.length) {
    for (const [index, value] of canonicalSequence.entries()) {
      const canonicalCount = canonicalSequence.filter((item) => item === value).length
      const targetCount = targetSequence.filter((item) => item === value).length
      if (targetCount < canonicalCount) {
        operations.push({ operation: "drop_frame", frame_index: index + 1 })
      } else if (targetCount > canonicalCount) {
        operations.push({ operation: "repeat_frame", frame_index: index + 1, repeat_count: targetCount - canonicalCount })
      }
    }
  }
  const renderedIndices = renderedCanonicalFrameIndices(frames.length, operations)
  if (renderedIndices.length !== targetSequence.length) {
    warnings.push(`Declared frame sequence has ${targetSequence.length} frame(s), but deterministic operations produce ${renderedIndices.length}.`)
  }
  const mutations: CaseStepDataMutation[] = []
  for (const [outputIndex, targetValue] of targetSequence.entries()) {
    const canonicalIndex = renderedIndices[outputIndex]
    if (canonicalIndex === undefined) continue
    const expected = canonicalSequence[canonicalIndex]
    if (targetValue === expected) continue
    mutations.push({
      field: "FRAME_SEQUENCE",
      frame_index: canonicalIndex + 1,
      operation: "replace_with_invalid_value",
      value: targetValue,
    })
  }
  return {
    hasFault: targetSequence.some((value, index) => value !== canonicalSequence[index]) || operations.length > 0,
    mutations,
    operations,
    warnings,
  }
}

function hasSignificantCanonicalFrameCountConflict(
  canonicalFrameCount: number | undefined,
  declaredFrameCount: number | undefined,
): boolean {
  if (!canonicalFrameCount || !declaredFrameCount) return false
  return Math.abs(canonicalFrameCount - declaredFrameCount) > 2
}

function explicitSequenceMutationsForCanonicalConflict(
  text: string,
  targetSequence: string[],
  protocol: DtpProtocolDefinition,
): CaseStepDataMutation[] {
  const frames = getDtpProtocolFrames(protocol)
  const canonicalSequence = frames.map((_, index) => frameSequenceValue(protocol, index + 1))
  if (!targetSequence.length || canonicalSequence.some((value) => !value)) return []

  const namedFrame = text.match(/(首帧|尾帧|最后一帧|中间帧)[^，,。；;\n]{0,20}帧序号[^，,。；;\n]{0,12}(?:错误|异常|不正确|非法)/i)?.[1]
  let canonicalIndex: number | undefined
  let targetValue: string | undefined
  if (namedFrame === "首帧") {
    canonicalIndex = 0
    targetValue = targetSequence[0]
  } else if (namedFrame === "尾帧" || namedFrame === "最后一帧") {
    canonicalIndex = frames.length - 1
    targetValue = targetSequence[targetSequence.length - 1]
  } else {
    const firstDifference = targetSequence.findIndex((value, index) => (
      index < canonicalSequence.length && value !== canonicalSequence[index]
    ))
    if (firstDifference >= 0) {
      canonicalIndex = firstDifference
      targetValue = targetSequence[firstDifference]
    }
  }
  if (canonicalIndex === undefined || !targetValue || targetValue === canonicalSequence[canonicalIndex]) return []
  return [{
    field: "FRAME_SEQUENCE",
    frame_index: canonicalIndex + 1,
    operation: "replace_with_invalid_value",
    value: targetValue,
  }]
}

function frameSequenceIntentFromStep(
  text: string,
  protocol: DtpProtocolDefinition | undefined,
): CaseStepFrameSequenceIntent {
  const frames = protocol ? getDtpProtocolFrames(protocol) : []
  const declaredFrameCount = declaredFrameCountFromStep(text)
  const targetSequence = explicitFrameSequenceValues(text)
  const mentioned = /帧序号|帧索引|\bINDEX\b/i.test(text) ||
    /(?:缺少|丢失|未发送).{0,12}(?:首帧|尾帧|最后一帧)/.test(text) ||
    /(?:首帧|尾帧|最后一帧).{0,12}(?:缺少|丢失|未发送)/.test(text) ||
    targetSequence.length > 0
  const operations: CaseStepSequenceOperation[] = []
  const mutations: CaseStepDataMutation[] = []
  const warnings: string[] = []
  let hasFault = false

  if (targetSequence.length) {
    const canonicalFrameCount = frames.length
    if (protocol && hasSignificantCanonicalFrameCountConflict(canonicalFrameCount, targetSequence.length)) {
      mutations.push(...explicitSequenceMutationsForCanonicalConflict(text, targetSequence, protocol))
      hasFault = mutations.length > 0
      warnings.push(
        `Declared frame sequence has ${targetSequence.length} frame(s), but the authoritative canonical layout defines ${canonicalFrameCount}; omitted canonical frames were not converted into drop operations.`,
      )
    } else {
      const explicit = explicitFrameSequenceIntent(targetSequence, protocol)
      if (declaredFrameCount !== undefined && declaredFrameCount !== targetSequence.length) {
        explicit.warnings.push(`Declared frame count ${declaredFrameCount} conflicts with the ${targetSequence.length} value frame sequence.`)
      }
      return {
        mentioned: true,
        hasFault: explicit.hasFault,
        declaredFrameCount,
        targetSequence,
        mutations: explicit.mutations,
        operations: explicit.operations,
        warnings: uniqueStrings(explicit.warnings),
      }
    }
  }

  const missingFirstFrame = /(?:缺少|丢失|未发送)[^，,。;；]{0,12}(?:首帧|00H?首帧)/i.test(text) ||
    /(?:首帧|00H?首帧)[^，,。;；]{0,12}(?:缺少|丢失|未发送)/i.test(text)
  const missingLastFrame = /(?:缺少|丢失|未发送)[^，,。;；]{0,12}(?:尾帧|最后一帧)/i.test(text) ||
    /(?:尾帧|最后一帧)[^，,。;；]{0,12}(?:缺少|丢失|未发送)/i.test(text)
  if (missingFirstFrame && frames.length) {
    operations.push({ operation: "drop_frame", frame_index: 1 })
    hasFault = true
  }
  if (missingLastFrame && frames.length) {
    operations.push({ operation: "drop_frame", frame_index: frames.length })
    hasFault = true
  }

  const repeatByValue = text.match(
    /重复发送\s*([0-9一二三四五六七八九十两]+)\s*帧\s*帧序号\s*(?:=|＝|为)?\s*((?:0x)?[0-9A-F]{1,2}H?)/i,
  )
  const repeatLastByValue = text.match(
    /最后\s*([0-9一二三四五六七八九十两]+)\s*帧\s*帧序号\s*(?:均|都)?\s*(?:=|＝|为)\s*((?:0x)?[0-9A-F]{1,2}H?)/i,
  )
  for (const repeat of [repeatByValue, repeatLastByValue]) {
    if (!repeat) continue
    const occurrenceCount = parseFrameCount(repeat[1])
    const frameIndex = frameIndexForSequenceValue(protocol, repeat[2])
    if (occurrenceCount && occurrenceCount > 1 && frameIndex) {
      operations.push({ operation: "repeat_frame", frame_index: frameIndex, repeat_count: occurrenceCount - 1 })
      hasFault = true
    } else {
      warnings.push(`Frame repetition could not be resolved from: ${repeat[0]}`)
    }
  }

  const addSequenceMutation = (frameIndex: number, rawValue: string): void => {
    const value = normalizeHexByte(rawValue)
    const expected = frameSequenceValue(protocol, frameIndex)
    if (!value || !expected) {
      warnings.push(`Frame sequence field could not be resolved for frame ${frameIndex}.`)
      return
    }
    if (value === expected) return
    mutations.push({
      field: "FRAME_SEQUENCE",
      frame_index: frameIndex,
      operation: "replace_with_invalid_value",
      value,
    })
    hasFault = true
  }

  if (!missingFirstFrame) {
    const firstAssignment = text.match(/首帧帧序号\s*(?:(?:错误|异常)\s*(?:即|为)?\s*(?:帧序号)?\s*)?(?:=|＝|为)?\s*((?:0x)?[0-9A-F]{1,2}H?)/i)
    if (firstAssignment) addSequenceMutation(1, firstAssignment[1])
  }
  if (!missingLastFrame && frames.length) {
    const lastAssignment = text.match(/(?:最后一帧|尾帧)帧序号\s*(?:(?:错误|异常)\s*(?:即|为)?\s*(?:帧序号)?\s*)?(?:=|＝|为)?\s*((?:0x)?[0-9A-F]{1,2}H?)/i)
    if (lastAssignment) addSequenceMutation(frames.length, lastAssignment[1])
  }
  const repeatedFrame = text.match(/(首帧|尾帧|中间帧)\s*(?:帧序号)?\s*(?:重复|重发)/i)?.[1]
  if (repeatedFrame && frames.length) {
    const frameIndex = repeatedFrame === "首帧" ? 1 : repeatedFrame === "尾帧" ? frames.length : Math.ceil(frames.length / 2)
    operations.push({ operation: "repeat_frame", frame_index: frameIndex })
    hasFault = true
  }
  const namedSequenceError = text.match(/(首帧|尾帧|中间帧)\s*帧序号[^，,。；;]{0,24}?(?:由\s*)?(?:0x)?[0-9A-F]{1,2}H?\s*(?:改为|变为|=|＝|为)\s*((?:0x)?[0-9A-F]{1,2})H?/i)
  if (namedSequenceError && frames.length) {
    const frameIndex = namedSequenceError[1] === "首帧" ? 1 : namedSequenceError[1] === "尾帧" ? frames.length : Math.ceil(frames.length / 2)
    addSequenceMutation(frameIndex, namedSequenceError[2])
  }

  const uniqueOperations = new Map<string, CaseStepSequenceOperation>()
  for (const operation of operations) {
    uniqueOperations.set(`${operation.operation}:${operation.frame_index ?? ""}:${operation.other_frame_index ?? ""}`, operation)
  }
  return {
    mentioned,
    hasFault,
    declaredFrameCount,
    mutations,
    operations: Array.from(uniqueOperations.values()),
    warnings: uniqueStrings(warnings),
  }
}

function sequenceOperationsFromStep(text: string): CaseStepSequenceOperation[] {
  const operations: CaseStepSequenceOperation[] = []
  const addFrameMatches = (pattern: RegExp, operation: CaseStepSequenceOperation["operation"]): void => {
    for (const match of text.matchAll(pattern)) {
      const frameIndex = Number.parseInt(match[1], 10)
      if (Number.isFinite(frameIndex) && frameIndex > 0) operations.push({ operation, frame_index: frameIndex })
    }
  }

  addFrameMatches(/(?:跳过(?:发送)?|不(?:再)?发送)第\s*(\d+)\s*帧/g, "drop_frame")
  addFrameMatches(/重复(?:发送)?第\s*(\d+)\s*帧/g, "repeat_frame")
  addFrameMatches(/第\s*(\d+)\s*帧(?:重复发送|重复|重发)/g, "repeat_frame")
  for (const match of text.matchAll(/第\s*(\d+)\s*帧\s*(?:与|和)\s*第\s*(\d+)\s*帧.{0,12}(?:顺序颠倒|交换|互换)/g)) {
    operations.push({
      operation: "swap_frames",
      frame_index: Number.parseInt(match[1], 10),
      other_frame_index: Number.parseInt(match[2], 10),
    })
  }
  addFrameMatches(/(?:追加|再(?:次)?发送)(?:一个)?(?:非法|错误|异常)?第\s*(\d+)\s*帧/g, "append_frame")

  const unique = new Map<string, CaseStepSequenceOperation>()
  for (const operation of operations) {
    if (!operation.frame_index) continue
    unique.set(`${operation.operation}:${operation.frame_index}:${operation.other_frame_index ?? ""}`, operation)
  }
  return Array.from(unique.values())
}

function mergeCaseStepSequenceOperations(
  ...operationGroups: CaseStepSequenceOperation[][]
): CaseStepSequenceOperation[] {
  const merged = new Map<string, CaseStepSequenceOperation>()
  for (const operation of operationGroups.flat()) {
    merged.set(
      `${operation.operation}:${operation.frame_index ?? ""}:${operation.other_frame_index ?? ""}`,
      operation,
    )
  }
  return Array.from(merged.values())
}

type StepFieldMutationClause = {
  frameIndex?: number
  invalidFrameTarget?: boolean
  text: string
}

function fieldMutationClauses(
  text: string,
  protocolFrameCount?: number,
): StepFieldMutationClause[] {
  const declaredFrameCount = declaredFrameCountFromStep(text)
  const frameCount = protocolFrameCount ?? declaredFrameCount
  const matches = Array.from(text.matchAll(
    /首帧(?:\s*[（(]\s*帧?\s*(\d+)\s*[）)])?|(?:尾帧|最后一帧)(?:\s*[（(]\s*帧?\s*(\d+)\s*[）)])?|中间帧(?:\s*[（(]\s*帧?\s*(\d+)\s*[）)])?|第\s*(\d+)\s*帧|帧\s*(\d+)(?=\s*(?:仲裁场|控制场|TITLE|LENGTH|长度|SUM|CRC|校验|W\d+|DATA\d+|由|[:：]))/g,
  )).map((match) => {
    const explicitIndex = [match[1], match[2], match[3], match[4], match[5]]
      .map((value) => value ? Number.parseInt(value, 10) : undefined)
      .find((value): value is number => value !== undefined && Number.isFinite(value) && value > 0)
    const marker = match[0]
    const frameIndex = explicitIndex ?? (
      marker.startsWith("首帧")
        ? 1
        : /^(?:尾帧|最后一帧)/.test(marker)
          ? frameCount
          : marker.startsWith("中间帧") && frameCount
            ? Math.ceil(frameCount / 2)
            : undefined
    )
    return {
      index: match.index ?? 0,
      frameIndex,
      invalidFrameTarget: marker.startsWith("中间帧") && frameCount !== undefined && frameCount < 3,
    }
  })

  // "中间帧（帧2）...帧2仲裁场由..." repeats the same target frame.
  // Keep one clause so its fault statement and explicit replacement stay together.
  const targets = matches.filter((match, index) => (
    index === 0 || match.frameIndex !== matches[index - 1]?.frameIndex
  ))
  return targets.length
    ? targets.map((target, index) => ({
      frameIndex: target.frameIndex,
      invalidFrameTarget: target.invalidFrameTarget,
      text: text.slice(target.index, targets[index + 1]?.index ?? text.length),
    }))
    : [{ frameIndex: undefined, text }]
}

const FIELD_FAULT_PATTERN = "(?:错误|异常|非法|\\berror\\b|\\binvalid\\b|\\bincorrect\\b|\\babnormal\\b)"

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function fieldPatternHasExplicitFault(segment: string, fieldPattern: string, fieldName?: string): boolean {
  if (fieldName === "STATION_ADDRESS") {
    return /(?:站地址|ADDRESS\s*高\s*5\s*位)(?:字段|值)?\s*(?:错误|异常|非法)|(?:错误|异常|非法)(?:的)?\s*(?:站地址|ADDRESS\s*高\s*5\s*位)/i.test(segment)
  }
  const bridge = "[^，,。.;；、()（）]{0,16}"
  const assignedFault = `(?:${fieldPattern})\\s*(?:=|＝|为)\\s*(?:0x)?[0-9A-F]{1,2}H?\\s*[（(]\\s*${FIELD_FAULT_PATTERN}`
  return new RegExp(
    `(?:${assignedFault}|(?:${fieldPattern})${bridge}${FIELD_FAULT_PATTERN}|${FIELD_FAULT_PATTERN}${bridge}(?:${fieldPattern}))`,
    "i",
  ).test(segment)
}

function stepFieldMutations(text: string, protocolFrameCount?: number): {
  variantType?: CaseStepDataGenerationPlan["variant_type"]
  mutations: CaseStepDataMutation[]
  checksumPolicy?: CaseStepDataGenerationPlan["checksum_policy"]
  hasExplicitAssignments: boolean
  hasExplicitErrors: boolean
} {
  const clauses = fieldMutationClauses(text, protocolFrameCount)
  const fieldDefinitions: Array<{
    field: string
    pattern: string
    variant: CaseStepDataGenerationPlan["variant_type"]
  }> = [
    { field: "STATION_ADDRESS", pattern: "\u7ad9\u5730\u5740|ADDRESS\\s*\u9ad8\\s*5\\s*\u4f4d", variant: "field_error" },
    { field: "MESSAGE_TYPE", pattern: "\u6d88\u606f\u7c7b\u578b|\u62a5\u6587\u7c7b\u578b|\u7c7b\u578b(?:\u5b57\u6bb5)?|ADDRESS\\s*\u4f4e\\s*3\\s*\u4f4d", variant: "field_error" },
    { field: "ADDRESS", pattern: "\\bADDRESS\\b(?!\\s*(?:\u9ad8\\s*5\\s*\u4f4d|\u4f4e\\s*3\\s*\u4f4d))", variant: "field_error" },
    { field: "TITLE", pattern: "TITLE", variant: "title_error" },
    { field: "ARBITRATION", pattern: "仲裁场|\\bID\\b", variant: "arbitration_error" },
    { field: "CONTROL", pattern: "控制场|DLC|RTR", variant: "control_error" },
    { field: "LENGTH", pattern: "长度|Length", variant: "length_error" },
    { field: "FRAME_SEQUENCE", pattern: "\\bINDEX\\b", variant: "field_error" },
    { field: "SUM", pattern: "SUM|CRC|校验(?:和|字)?", variant: "checksum_error" },
  ]
  const mutations: CaseStepDataMutation[] = []
  let variantType: CaseStepDataGenerationPlan["variant_type"] | undefined
  let hasExplicitAssignments = false
  let hasExplicitErrors = false
  const addMutation = (
    field: string,
    frameIndex: number | undefined,
    value: string | undefined,
    operation: CaseStepDataMutation["operation"],
  ): void => {
    const existing = mutations.find((mutation) => (
      mutation.field === field && mutation.frame_index === frameIndex
    ))
    if (existing) {
      // A later "由 XX 改为 YY" clause supplies the concrete invalid value,
      // but must not weaken the earlier error classification to a normal replace.
      if (!existing.value && value) existing.value = value
      return
    }
    mutations.push({
      field,
      frame_index: frameIndex,
      operation,
      value,
    })
  }

  for (const clause of clauses) {
    if (clause.invalidFrameTarget) continue
    const segments = clause.text.split(/[，,。.;；、]/).filter(Boolean)
    for (const segment of segments) {
      const isError = /错误|异常|非法|\berror\b|\binvalid\b|\bincorrect\b|\babnormal\b/i.test(segment)
      for (const definition of fieldDefinitions) {
        if (!new RegExp(`(?:${definition.pattern})`, "i").test(segment)) continue
        const definitionIsError = isError && fieldPatternHasExplicitFault(
          segment,
          definition.pattern,
          definition.field,
        )
        const assignment = segment.match(new RegExp(
          `(?:${definition.pattern})\\s*(?:(?:=|＝|为)\\s*|由\\s*(?:0x)?[0-9A-F]{1,2}H?\\s*(?:改为|变为|=|＝|为)\\s*)(?:0x)?([0-9A-F]{1,2})H?`,
          "i",
        ))
        if (assignment?.[1]) hasExplicitAssignments = true
        if (assignment?.[1]) {
          // A normal station-address assignment binds the protocol variable and
          // may drive several bytes, such as arbitration plus W0 or TITLE.
          if (definition.field !== "STATION_ADDRESS" || definitionIsError) {
            addMutation(
              definition.field,
              clause.frameIndex,
              normalizeHexByte(assignment[1]),
              definitionIsError ? "replace_with_invalid_value" : "replace",
            )
          }
        }
        if (definitionIsError) {
          hasExplicitErrors = true
          variantType ??= definition.variant
          if (!assignment?.[1]) {
            addMutation(definition.field, clause.frameIndex, undefined, "replace_with_invalid_value")
          }
        }
      }
      for (const assignment of segment.matchAll(/\b((?:W|DATA)\d+)\s*(?:(?:=|＝|为)\s*|由\s*(?:0x)?[0-9A-F]{1,2}H?\s*(?:改为|变为|=|＝|为)\s*)(?:0x)?([0-9A-F]{1,2})H?/gi)) {
        const assignmentIsError = isError && fieldPatternHasExplicitFault(
          segment,
          escapeRegularExpression(assignment[1]),
        )
        hasExplicitAssignments = true
        if (assignmentIsError) {
          hasExplicitErrors = true
          variantType ??= "field_error"
        }
        addMutation(
          assignment[1].toUpperCase(),
          clause.frameIndex,
          normalizeHexByte(assignment[2]),
          assignmentIsError ? "replace_with_invalid_value" : "replace",
        )
      }
      if (isError) {
        const assignedFields = new Set(
          Array.from(segment.matchAll(/\b((?:W|DATA)\d+)\s*(?:=|＝|为)/gi), (match) => match[1].toUpperCase()),
        )
        const errorFields: string[] = []
        const individualFieldText = segment.replace(/\b(?:W|DATA)\d+\s*(?:~|～|-|至)\s*(?:W|DATA)?\d+\b/gi, (range) => {
          if (!fieldPatternHasExplicitFault(segment, escapeRegularExpression(range))) return range
          const bounds = Array.from(range.matchAll(/\d+/g), (match) => Number.parseInt(match[0], 10))
          const [start, end] = bounds
          if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || end - start > 31) return range
          const prefix = /DATA/i.test(range) ? "DATA" : "W"
          if (/任一|任意|随机|其中一个/.test(segment)) {
            errorFields.push(`${prefix}${start}`)
          } else {
            for (let index = start; index <= end; index += 1) errorFields.push(`${prefix}${index}`)
          }
          return " "
        })
        for (const match of individualFieldText.matchAll(/\b((?:W|DATA)\d+)\b/gi)) {
          if (!fieldPatternHasExplicitFault(segment, escapeRegularExpression(match[1]))) continue
          errorFields.push(match[1].toUpperCase())
        }
        for (const field of uniqueStrings(errorFields)) {
          if (assignedFields.has(field)) continue
          hasExplicitErrors = true
          variantType ??= "field_error"
          addMutation(field, clause.frameIndex, undefined, "replace_with_invalid_value")
        }
      }
    }
  }

  const checksumCorrect = /(?:SUM|CRC|校验(?:和|字)?)\s*(?:正确|正常|correct|valid)/i.test(text)
  const checksumError = !checksumCorrect && /(?:SUM|CRC|校验(?:和|字)?)[^，,。.;；、]{0,24}(?:错误|异常|非法|error|invalid|incorrect|abnormal)/i.test(text)
  if (checksumError) variantType = "checksum_error"
  if (checksumError) hasExplicitErrors = true
  return {
    variantType,
    mutations,
    checksumPolicy: checksumError
      ? "make_incorrect"
      : mutations.length || checksumCorrect
        ? "recalculate_correctly"
        : undefined,
    hasExplicitAssignments,
    hasExplicitErrors,
  }
}

function findCanonicalBaseEntry(
  input: BuildGeneratedStepInput,
  protocol: DtpProtocolDefinition | undefined,
  plan: CaseStepDataGenerationPlan,
): GeneratedDataFileIndexEntry | undefined {
  const explicit = plan.base_file_path
    ? input.dataFileIndex.entries.find((entry) => entry.file_path === plan.base_file_path && entry.source !== "dynamic-generated")
    : undefined
  if (explicit) return explicit
  if (!protocol) return undefined
  const canonicalKey = normalizeProtocolMatchText(protocol.base_file_name)
  const canonical = input.dataFileIndex.entries.find((entry) => {
    if (entry.source === "dynamic-generated") return false
    return [entry.protocol_name, entry.requested_file_name.replace(/\.txt$/i, "")]
      .some((value) => normalizeProtocolMatchText(value) === canonicalKey)
  })
  if (canonical || !plan.selected_block || !protocol.block_layout) return canonical
  const protocolEntity = implicitProtocolEntityText(protocol.base_file_name)
  return input.dataFileIndex.entries.find((entry) => {
    if (entry.source === "dynamic-generated") return false
    const entryIntent = caseStepImplicitProtocolIntent(entry.requested_file_name.replace(/\.txt$/i, ""))
    return entryIntent.selectedBlock === plan.selected_block && entryIntent.protocolEntity === protocolEntity
  })
}

function isProtocolDataValueMutation(
  protocol: DtpProtocolDefinition | undefined,
  mutation: CaseStepDataMutation,
): boolean {
  if (mutation.operation !== "replace" || !normalizeHexByte(mutation.value)) return false
  if (/^W\d+$/i.test(mutation.field)) return true
  return Boolean(protocol && getDtpProtocolFrames(protocol).some((frame) =>
    frame.field_layout.some((field) =>
      field.name.toUpperCase() === mutation.field.toUpperCase() && field.role === "data",
    ),
  ))
}

function mergeCaseStepMutations(
  lowerPriority: CaseStepDataMutation[],
  higherPriority: CaseStepDataMutation[],
): CaseStepDataMutation[] {
  const merged = new Map<string, CaseStepDataMutation>()
  for (const mutation of [...lowerPriority, ...higherPriority]) {
    merged.set(`${mutation.field.toUpperCase()}:${mutation.frame_index ?? "all"}`, mutation)
  }
  return Array.from(merged.values())
}

function reconcileCaseStepMutationByteIndices(
  protocol: DtpProtocolDefinition | undefined,
  mutations: CaseStepDataMutation[],
): { mutations: CaseStepDataMutation[]; warnings: string[] } {
  if (!protocol) return { mutations, warnings: [] }
  const frames = getDtpProtocolFrames(protocol)
  const warnings: string[] = []
  const reconciled = mutations.map((mutation) => {
    if (mutation.byte_index === undefined) return mutation
    const targetFrames = mutation.frame_index
      ? [frames[mutation.frame_index - 1]].filter((frame): frame is DtpProtocolFrameDefinition => Boolean(frame))
      : frames
    const canonicalIndices = uniqueStrings(targetFrames
      .map((frame) => resolvePlanFieldIndex(
        mutation.field,
        frame.byte_layout,
        frame.byte_layout.length,
        frame.field_layout,
      ))
      .filter((index): index is number => index !== undefined)
      .map(String))
      .map((index) => Number.parseInt(index, 10))
    if (canonicalIndices.length !== 1 || canonicalIndices[0] === mutation.byte_index) return mutation
    warnings.push(
      `${mutation.field} byte_index ${mutation.byte_index} was corrected to canonical protocol index ${canonicalIndices[0]}.`,
    )
    return { ...mutation, byte_index: canonicalIndices[0] }
  })
  return { mutations: reconciled, warnings: uniqueStrings(warnings) }
}

function protocolHasDeterministicSum(protocol: DtpProtocolDefinition | undefined): boolean {
  if (!protocol) return false
  return getDtpProtocolFrames(protocol).some((frame) => (
    frame.checksum?.type === "sum_low8" && (
      frame.field_layout.some((field) => field.role === "checksum") ||
      frame.byte_layout.some((token) => /^(?:SUM|CHECKSUM)$/i.test(token))
    )
  ))
}

function normalizeDirectPlanChecksumPolicy(
  input: BuildGeneratedStepInput,
  plan: CaseStepDataGenerationPlan,
): CaseStepDataGenerationPlan {
  const semanticText = caseStepSemanticText(input)
  const semanticStepText = semanticCaseStepDescription(input.step.stepDescription) || semanticText
  // The keyword represents the actual injection interface and therefore has
  // higher scope priority than downstream forwarding details in TR context.
  const stepText = `${input.step.keywordName} ${semanticStepText}`.trim()
  const resolvedProtocol = resolveProtocolForCasePlan(
    plan,
    input.protocolDefinitions,
    semanticText,
    stepText,
    input.protocolAnchorId,
  )
  const protocol = resolvedProtocol ? normalizeDtpProtocolDefinition(resolvedProtocol) : undefined
  if (protocol && !protocol.block_layout && (plan.artifact_scope || plan.selected_block)) {
    plan = {
      ...plan,
      artifact_scope: undefined,
      selected_block: undefined,
      warnings: uniqueStrings([
        ...plan.warnings,
        `Block selection was ignored because protocol ${protocol.protocol_id} is not a block protocol.`,
      ]),
    }
  }
  if (!protocolHasDeterministicSum(protocol)) return plan

  const derivedPolicy = stepFieldMutations(
    stepText,
    protocol ? getDtpProtocolFrames(protocol).length : undefined,
  ).checksumPolicy
  const checksumPolicy = derivedPolicy === "make_incorrect" || plan.checksum_policy === "make_incorrect"
    ? "make_incorrect"
    : "recalculate_correctly"
  return checksumPolicy === plan.checksum_policy ? plan : { ...plan, checksum_policy: checksumPolicy }
}

function reconcileCaseStepDataPlan(
  input: BuildGeneratedStepInput,
  plan: CaseStepDataGenerationPlan,
): CaseStepDataGenerationPlan {
  if (input.protocolAnchorId && plan.protocol_id !== input.protocolAnchorId) {
    plan = {
      ...plan,
      protocol_id: input.protocolAnchorId,
      warnings: uniqueStrings([
        ...plan.warnings,
        `Case protocol anchor ${input.protocolAnchorId} overrode step plan protocol ${plan.protocol_id ?? "unresolved"}.`,
      ]),
    }
  }
  const semanticText = caseStepSemanticText(input)
  const semanticStepText = semanticCaseStepDescription(input.step.stepDescription) || semanticText
  const stepText = `${input.step.keywordName} ${semanticStepText}`.trim()
  const commandDictionaryMatch = commandDictionaryEntryForStep(input.commandDictionaryIndex, stepText)
  let selectedCommandDictionaryEntry = commandDictionaryMatch.entry
  if (commandDictionaryMatch.warning) plan.warnings = uniqueStrings([...plan.warnings, commandDictionaryMatch.warning])
  if (commandDictionaryMatch.entry) {
    const matchedByName = commandDictionaryMatch.source === "exact_name" ||
      commandDictionaryMatch.source === "normalized_name"
    const dictionaryProtocol = protocolForCommandDictionaryEntry(
      input.protocolDefinitions,
      commandDictionaryMatch.entry,
      stepText,
    )
    const dictionaryMutations = commandDictionaryMutations(commandDictionaryMatch.entry, dictionaryProtocol)
    plan = {
      ...plan,
      command: {
        code: commandDictionaryMatch.entry.command_code,
        name: commandDictionaryMatch.entry.command_name,
        source_table_id: commandDictionaryMatch.entry.source_table_id,
        source_table_caption: commandDictionaryMatch.entry.source_table_caption,
        ...(matchedByName ? { selection_source: "step_desc" as const } : {}),
      },
      ...(dictionaryProtocol ? {
        protocol_id: dictionaryProtocol.protocol_id,
        protocol_name: dictionaryProtocol.base_file_name,
        payload_length_bytes: protocolPayloadLengthBytes(dictionaryProtocol),
      } : {}),
      ...(matchedByName ? { selection_source: "step_desc" as const } : {}),
      confidence: matchedByName ? Math.max(plan.confidence, 0.9) : plan.confidence,
      mutations: mergeCaseStepMutations(
        withoutModelCommandPayloadReplacements(plan.mutations, commandDictionaryMatch.entry, dictionaryProtocol),
        dictionaryMutations,
      ),
      warnings: uniqueStrings([
        ...plan.warnings.filter((warning) => !matchedByName || !/^Protocol default selected:/i.test(warning)),
        `Command ${commandDictionaryMatch.entry.command_code} resolved by ${commandDictionaryMatch.source ?? "command_code"} from ${commandDictionaryMatch.entry.source_table_caption ?? commandDictionaryMatch.entry.source_table_id}.`,
        ...commandDictionaryMatch.entry.warnings,
        ...(dictionaryProtocol
          ? []
          : [`No unique protocol matched command ${commandDictionaryMatch.entry.command_code}; command field values were retained without a protocol anchor.`]),
      ]),
    }
  }
  const exactEntry = findExactDataFileIndexEntry(
    input.dataFileIndex,
    extractRequestedFileNameSafe(input.step) ?? "",
    semanticText,
  )
  const protocolResolution = resolveProtocolForCasePlanResult(
    plan,
    input.protocolDefinitions,
    semanticText,
    stepText,
    input.protocolAnchorId,
  )
  const exactProtocol = findProtocolForDataFileEntry(
    input.protocolDefinitions,
    exactEntry,
    plan,
    semanticText,
    stepText,
    input.protocolAnchorId,
  )
  const selectorRejectsExactProtocol = Boolean(
    exactProtocol &&
    protocolResolution.selectorRelationId &&
    protocolResolution.candidateProtocolIds.length &&
    !protocolResolution.candidateProtocolIds.includes(exactProtocol.protocol_id),
  )
  const exactEntryMatchesBlockProtocol = dataFileEntryMatchesSelectedProtocolBlock(
    exactEntry,
    protocolResolution.protocol,
    plan.selected_block,
  )
  const resolvedProtocol = (selectorRejectsExactProtocol ? undefined : exactProtocol) ?? (
    !exactEntry || exactEntryMatchesBlockProtocol ? protocolResolution.protocol : undefined
  )
  const protocol = resolvedProtocol ? normalizeDtpProtocolDefinition(resolvedProtocol) : undefined
  const defaultCommand = defaultCommandDictionaryEntryForStep(
    input.commandDictionaryIndex,
    protocol,
    stepText,
    plan,
  )
  if (defaultCommand) {
    selectedCommandDictionaryEntry = defaultCommand
    plan = {
      ...plan,
      command: {
        code: defaultCommand.command_code,
        name: defaultCommand.command_name,
        source_table_id: defaultCommand.source_table_id,
        source_table_caption: defaultCommand.source_table_caption,
        selection_source: "document_order_default",
      },
      variant_type: "correct",
      mutations: mergeCaseStepMutations(
        withoutModelCommandPayloadReplacements(plan.mutations, defaultCommand, protocol),
        commandDictionaryMutations(defaultCommand, protocol),
      ),
      warnings: uniqueStrings([
        ...plan.warnings,
        `Command default selected: ${defaultCommand.command_code} (${defaultCommand.command_name}) from ${defaultCommand.source_table_caption ?? defaultCommand.source_table_id}.`,
        ...defaultCommand.warnings,
      ]),
    }
  }
  const derived = stepFieldMutations(
    stepText,
    protocol ? getDtpProtocolFrames(protocol).length : undefined,
  )
  const invalidFrameTarget = Boolean(protocol && fieldMutationClauses(stepText, getDtpProtocolFrames(protocol).length)
    .some(clause => clause.invalidFrameTarget))
  const frameSequenceIntent = frameSequenceIntentFromStep(stepText, protocol)
  const deterministicSequenceOperations = mergeCaseStepSequenceOperations(
    sequenceOperationsFromStep(stepText),
    frameSequenceIntent.operations,
  )
  const sequenceOperations = frameSequenceIntent.mentioned || deterministicSequenceOperations.length
    ? deterministicSequenceOperations
    : plan.sequence_operations
  const specializedCommandFaults = specializeCommandFaultMutations(
    mergeCaseStepMutations(derived.mutations, frameSequenceIntent.mutations),
    selectedCommandDictionaryEntry,
  )
  const explicitCorrect = /正确|正常/.test(stepText)
  const implicitCanonicalSend = Boolean(
    protocol &&
    plan.variant_type === "unknown" &&
    /(?:发送|下发|注入|写入)/.test(stepText) &&
    !/(?:错误|异常|非法|不正确|无效|重复|丢失|缺失|错序|乱序)/.test(stepText) &&
    !frameSequenceIntent.hasFault,
  )
  const explicitlyNormal = !derived.hasExplicitErrors && (
    explicitCorrect || derived.hasExplicitAssignments || plan.variant_type === "correct" || implicitCanonicalSend
  )
  const plannedDataValueMutations = canonicalizeCaseStepMutationFrames(
    protocol,
    plan.mutations.filter((mutation) => isProtocolDataValueMutation(protocol, mutation)),
  )
  const deterministicMutations = canonicalizeCaseStepMutationFrames(
    protocol,
    specializedCommandFaults.mutations,
  )
  const reconciledMutations = invalidFrameTarget
    ? plannedDataValueMutations
    : derived.variantType || derived.hasExplicitAssignments || frameSequenceIntent.mutations.length
    ? mergeCaseStepMutations(plannedDataValueMutations, deterministicMutations)
    : explicitlyNormal
      ? plannedDataValueMutations
      : plan.mutations
  const canonicalEntry = exactEntry ?? findCanonicalBaseEntry(input, protocol, plan)
  const groupScopedMutations = scopeUnqualifiedProtocolFaults(protocol, reconciledMutations)
  const mutationReconciliation = reconcileCaseStepMutationByteIndices(protocol, groupScopedMutations.mutations)
  const warnings = plan.warnings.filter((warning) => !protocol || !warning.startsWith("No matching base data file"))
  warnings.push(
    ...frameSequenceIntent.warnings,
    ...specializedCommandFaults.warnings,
    ...groupScopedMutations.warnings,
    ...mutationReconciliation.warnings,
  )
  const canonicalRenderedFrameCount = protocol
    ? renderedCanonicalFrameIndices(getDtpProtocolFrames(protocol).length, sequenceOperations).length
    : undefined
  if (hasSignificantCanonicalFrameCountConflict(canonicalRenderedFrameCount, frameSequenceIntent.declaredFrameCount)) {
    warnings.push(
      `Step frame count ${frameSequenceIntent.declaredFrameCount} conflicts with the authoritative canonical layout (${canonicalRenderedFrameCount} frame(s)); canonical layout was retained.`,
    )
  }
  if (protocol && plan.protocol_id && plan.protocol_id !== protocol.protocol_id) {
    warnings.push(
      `Model protocol_id ${plan.protocol_id} was ignored because deterministic protocol evidence selected ${protocol.protocol_id}.`,
    )
  }
  if (selectorRejectsExactProtocol && exactProtocol) {
    warnings.push(
      `Protocol ${exactProtocol.protocol_id} was ignored because selector evidence restricts the step to: ${protocolResolution.candidateProtocolIds.join(", ")}.`,
    )
  }
  if (protocolResolution.selectedScopeConflicts.length) {
    warnings.push(
      `Protocol identity ${protocol?.protocol_id ?? plan.protocol_id ?? "unknown"} was retained despite scope metadata conflict: ${protocolResolution.selectedScopeConflicts.join("; ")}.`,
    )
  }
  if (exactEntry && !exactProtocol && protocolResolution.ambiguous) {
    warnings.push(
      `Canonical protocol is ambiguous between: ${protocolResolution.candidateProtocolIds.join(", ")}.`,
    )
  } else if (exactEntry && !exactProtocol) {
    warnings.push(
      `Canonical protocol definition is missing for ${exactEntry.requested_file_name}; the exact indexed base file was retained.`,
    )
  } else if (!protocol && protocolResolution.ambiguous) {
    warnings.push(
      `Canonical protocol is ambiguous between: ${protocolResolution.candidateProtocolIds.join(", ")}.`,
    )
  } else if (!protocol) {
    warnings.push("Canonical protocol could not be resolved from the step and protocol definitions.")
  }
  const hasDeterministicSum = protocolHasDeterministicSum(protocol)
  const checksumErrorTargeted = derived.checksumPolicy === "make_incorrect" || (
    derived.checksumPolicy === undefined &&
    !explicitlyNormal &&
    plan.variant_type === "checksum_error"
  )
  const checksumPolicy = hasDeterministicSum
    ? checksumErrorTargeted
      ? "make_incorrect"
      : "recalculate_correctly"
    : derived.checksumPolicy ?? (frameSequenceIntent.mutations.length
      ? "recalculate_correctly"
      : plan.checksum_policy === "make_incorrect"
        ? "make_incorrect"
        : getDtpPrimaryProtocolFrame(protocol)?.checksum && plan.source === "heuristic-fallback"
          ? "recalculate_correctly"
          : plan.checksum_policy)

  const relatedMessageLengthBytes = protocolResolution.constraints.payloadLengthScope === "related_message"
    ? protocolResolution.constraints.payloadLengthBytes
    : plan.related_message_length_bytes
  const payloadLengthBytes = protocolResolution.constraints.payloadLengthScope === "related_message"
    ? protocol ? protocolPayloadLengthBytes(protocol) : plan.payload_length_bytes
    : protocolResolution.constraints.payloadLengthBytes ??
      (protocol ? protocolPayloadLengthBytes(protocol) : plan.payload_length_bytes)
  const interfaceConstraint = protocolResolution.interfaceConstraint
  const plannedNameLevel = protocolNameInterfaceLevel(`${plan.protocol_name ?? ""} ${plan.base_file_name ?? ""}`)
  const protocolNameScopeConflict = Boolean(
    !protocol &&
    plannedNameLevel &&
    interfaceConstraint.level &&
    plannedNameLevel !== interfaceConstraint.level,
  )
  const selectorRejectsPlanProtocol = Boolean(
    plan.protocol_id &&
    protocolResolution.selectorRelationId &&
    protocolResolution.candidateProtocolIds.length &&
    !protocolResolution.candidateProtocolIds.includes(plan.protocol_id),
  )
  const rejectedPlanProtocol = selectorRejectsPlanProtocol || Boolean(
    plan.protocol_id && protocolResolution.rejectedProtocols.some((item) => (
      item.protocol_id === plan.protocol_id && /conflicts with (?:the )?step/.test(item.reason)
    )),
  )
  if (protocolNameScopeConflict) {
    warnings.push(
      `Model protocol name ${plan.protocol_name ?? plan.base_file_name ?? "unknown"} conflicts with the ${interfaceConstraint.level} CAN injection interface and was discarded.`,
    )
  }
  if (selectorRejectsPlanProtocol) {
    warnings.push(
      `Model protocol candidate ${plan.protocol_id} was discarded because selector evidence restricts the step to: ${protocolResolution.candidateProtocolIds.join(", ")}.`,
    )
  } else if (rejectedPlanProtocol) {
    warnings.push(
      `Model protocol candidate ${plan.protocol_id} is outside the deterministic bus/interface/flow scope and was discarded.`,
    )
  }
  if (!protocol && protocolResolution.ambiguous && protocolResolution.constraints.payloadLengthBytes === undefined) {
    warnings.push("Protocol length remains ambiguous because the step does not identify a unique payload length.")
  }
  const unresolvedStepName = stepProtocolDisplayName(semanticStepText, payloadLengthBytes)
  const discardedPlanIdentity = protocolNameScopeConflict || rejectedPlanProtocol
  const selectedProtocolName = protocol
    ? publishedProtocolDisplayName(protocol, input.protocolDefinitions, semanticStepText, payloadLengthBytes)
    : exactEntry?.protocol_name ?? exactEntry?.requested_file_name.replace(/\.txt$/i, "") ??
      (discardedPlanIdentity ? unresolvedStepName : plan.protocol_name) ?? unresolvedStepName ??
      (discardedPlanIdentity ? caseStepImplicitProtocolIntent(semanticStepText).protocolEntity : undefined)
  if (protocolResolution.defaultSelected && protocol) {
    warnings.push(
      `Protocol default selected: ${selectedProtocolName} (${protocol.protocol_id}) was chosen by document order from same-family candidates because the step provides no payload length or command code. Candidates: ${protocolResolution.candidateProtocolIds.join(", ")}.`,
    )
  }
  if (protocolResolution.equivalentSelected && protocol) {
    warnings.push(
      `Physically equivalent protocol definitions were deduplicated to ${protocol.protocol_id}: ${protocolResolution.candidateProtocolIds.join(", ")}.`,
    )
  }
  if (protocolResolution.selectorRelationId && protocol) {
    const relationLabel = (protocolResolution.selectorRelationIds ?? [protocolResolution.selectorRelationId]).join(", ")
    const frameConstraint = protocolResolution.selectorTargetFrameCount === undefined
      ? ""
      : ` under frame_count=${protocolResolution.selectorTargetFrameCount}`
    warnings.push(
      `Protocol selector relation ${relationLabel} selected ${protocol.protocol_id} for value ${protocolResolution.selectorValue}${frameConstraint}.`,
    )
  }
  if (protocolResolution.semanticRelationId && protocol) {
    warnings.push(
      `Protocol relation ${protocolResolution.semanticRelationId} selected ${protocol.protocol_id} for related message length ${relatedMessageLengthBytes}.`,
    )
  }
  const selectedByStepDescription = Boolean(
    protocol &&
    (
      (
        protocolIdentityText(protocol.base_file_name).length >= 4 &&
        protocolIdentityText(semanticText).includes(protocolIdentityText(protocol.base_file_name))
      ) || protocolImplicitEntityScore(protocol, semanticText) > 0
    ),
  )
  const selectedByModel = Boolean(
    protocol &&
    !selectedByStepDescription &&
    plan.source !== "heuristic-fallback" &&
    plan.protocol_id === protocol.protocol_id,
  )
  const selectedByCommandName = Boolean(
    protocol &&
    plan.command?.selection_source === "step_desc",
  )

  return {
    ...plan,
    protocol_id: protocol?.protocol_id ?? (rejectedPlanProtocol ? undefined : plan.protocol_id),
    protocol_name: selectedProtocolName,
    bus: protocol?.bus_context?.bus_type ?? protocolResolution.busConstraint ?? plan.bus,
    payload_length_bytes: payloadLengthBytes,
    related_message_length_bytes: relatedMessageLengthBytes,
    flow_direction: protocol?.flow_direction ?? exactEntry?.flow_direction ?? caseProtocolFlowConstraint(plan, stepText) ?? plan.flow_direction,
    base_file_name: protocol
      ? `${selectedProtocolName}.txt`
      : exactEntry?.requested_file_name ?? (discardedPlanIdentity
        ? selectedProtocolName ? `${selectedProtocolName}.txt` : undefined
        : plan.base_file_name),
    base_file_path: canonicalEntry?.file_path,
    variant_type: derived.variantType ?? (invalidFrameTarget || frameSequenceIntent.hasFault || sequenceOperations.length || stepDescribesFrameSequenceFault(semanticStepText)
      ? "field_error"
      : explicitlyNormal
        ? "correct"
        : plan.variant_type),
    mutations: mutationReconciliation.mutations,
    sequence_operations: mergeCaseStepSequenceOperations(
      sequenceOperations.length ? sequenceOperations : plan.sequence_operations,
    ),
    checksum_policy: checksumPolicy,
    confidence: protocolResolution.defaultSelected
      ? Math.min(0.7, Math.max(plan.confidence, 0.65))
      : plan.confidence,
    warnings: uniqueStrings(warnings),
    selection_source: protocol
      ? exactEntry
        ? "data_file_hint"
        : input.protocolAnchorId === protocol.protocol_id
          ? "case_anchor"
          : protocolResolution.selectorRelationId
            ? "selector_relation"
          : protocolResolution.semanticRelationId
            ? "protocol_relation"
           : protocolResolution.defaultSelected
             ? "document_order_default"
          : selectedByCommandName
            ? "step_desc"
          : selectedByStepDescription
            ? "step_desc"
            : selectedByModel
              ? "model"
              : "unresolved"
      : "unresolved",
    interface_level: protocol?.bus_context?.interface_level ?? protocolResolution.interfaceConstraint.level ?? "unknown",
    interface_id: protocol?.bus_context?.interface_id ?? protocolResolution.interfaceConstraint.interfaceId,
    interface_selection_source: protocolResolution.interfaceConstraint.source === "unresolved" && protocol?.bus_context?.interface_level
      ? "protocol_unique_scope"
      : protocolResolution.interfaceConstraint.source,
    matched_interface_alias: protocolResolution.interfaceConstraint.matchedAlias,
    deterministic_generation: Boolean(protocol && protocolBasePacketLines(protocol).length),
    model_used: plan.model_used ?? plan.source !== "heuristic-fallback",
    fallback_used: plan.fallback_used ?? false,
    rejected_protocols: protocolResolution.rejectedProtocols,
  }
}

function protocolVariableBindings(
  protocol: DtpProtocolDefinition | undefined,
  semanticText: string,
): Map<string, string> {
  const bindings = new Map<string, string>()
  if (!protocol) return bindings
  for (const variable of protocol.variables ?? []) {
    const explicit = variable.name === "station_address"
      ? semanticText.match(/\u7ad9\u5730\u5740\s*(?:\u4e3a|=|:|\uff1a)?\s*(?:0x)?([0-9A-Fa-f]{1,2})H?/i)?.[1]
      : undefined
    if (explicit) {
      bindings.set(variable.name, explicit.toUpperCase().padStart(2, "0"))
      continue
    }
    const normalizedSemantic = normalizeLookupText(semanticText)
    const matchedOptions = (variable.options ?? []).filter((option) => (
      normalizeLookupText(option.label).length >= 2 && normalizedSemantic.includes(normalizeLookupText(option.label))
    ))
    if (matchedOptions.length === 1) {
      bindings.set(variable.name, matchedOptions[0].value)
      continue
    }
    const defaultValue = normalizeHexByte(variable.default_value)
    if (defaultValue) bindings.set(variable.name, defaultValue)
  }
  return bindings
}

function evaluateProtocolValueRule(
  rule: DtpProtocolValueRule | undefined,
  bindings: Map<string, string>,
): string | undefined {
  if (!rule) return undefined
  const fixed = normalizeHexByte(rule.value)
  if (rule.operation === "fixed") return fixed
  const variable = rule.variable ? normalizeHexByte(bindings.get(rule.variable)) : undefined
  if (rule.operation === "variable") return variable
  const base = normalizeHexByte(rule.base)
  if (!base || !variable) return undefined
  const left = Number.parseInt(base, 16)
  const right = Number.parseInt(variable, 16)
  let value: number
  if (rule.operation === "add_low8") value = left + right
  else if (rule.operation === "bit_or") value = left | right
  else if (rule.operation === "bit_and") value = left & right
  else if (rule.operation === "shift_left") value = left << Math.max(0, Math.min(7, rule.shift ?? right))
  else return undefined
  return (value & 0xff).toString(16).toUpperCase().padStart(2, "0")
}

function encodeProtocolUnsignedInteger(
  value: bigint,
  byteLength: number,
  byteOrder: "big" | "little",
): string[] {
  const bytes = Array.from({ length: byteLength }, () => {
    const byte = Number(value & 0xffn).toString(16).toUpperCase().padStart(2, "0")
    value >>= 8n
    return byte
  })
  return byteOrder === "big" ? bytes.reverse() : bytes
}

function protocolBlockPacketLines(protocol: DtpProtocolDefinition): string[][] {
  const block = protocol.block_layout
  if (!block || block.kind !== "spacewire_program_upload") return []
  const payloadCapacity = block.payload_capacity ?? 0
  const payloadOffset = block.payload_offset ?? 0
  const scalarByteOrder = block.scalar_byte_order === "little" ? "little" : "big"
  const startAddress = BigInt(`0x${(block.start_address ?? "00000000").replace(/^0x/i, "")}`)

  return getDtpProtocolFrames(protocol).map((frame) => {
    const bytes = Array.from({ length: block.total_bytes }, (_, byteIndex) => {
      const fixed = normalizeHexByte(frame.byte_layout[byteIndex])
      const field = frame.field_layout.find((item) => (
        item.bit_offset === undefined &&
        item.byte_offset <= byteIndex &&
        item.byte_offset + item.byte_length > byteIndex
      ))
      return fixed ?? normalizeHexByte(field?.default_value) ?? "00"
    })
    const isMiddleBlock = frame.frame_id === "middle-block"
    const isCheckBlock = frame.frame_id === "check-block"
    if (block.block_type_offset !== undefined) {
      bytes[block.block_type_offset] = isMiddleBlock
        ? block.middle_block_type ?? "05"
        : isCheckBlock
          ? block.check_block_type ?? "0A"
          : block.start_block_type ?? "00"
    }
    if (block.address_offset !== undefined && block.address_length) {
      const address = isMiddleBlock ? startAddress + BigInt(payloadCapacity) : startAddress
      bytes.splice(
        block.address_offset,
        block.address_length,
        ...encodeProtocolUnsignedInteger(address, block.address_length, scalarByteOrder),
      )
    }
    if (block.length_offset !== undefined && block.length_length) {
      bytes.splice(
        block.length_offset,
        block.length_length,
        ...encodeProtocolUnsignedInteger(BigInt(payloadCapacity), block.length_length, scalarByteOrder),
      )
    }
    if (!isCheckBlock && payloadCapacity > 0) {
      bytes.splice(payloadOffset, payloadCapacity, ...Array(payloadCapacity).fill("00"))
    }
    return applyDtpBlockFrameChecksums(bytes, protocol).bytes
  })
}

function protocolBasePacketLines(protocol: DtpProtocolDefinition | undefined, semanticText = ""): string[][] {
  if (!protocol) return []
  const blockLines = protocolBlockPacketLines(protocol)
  if (blockLines.length) return blockLines
  const fields = new Map(protocol.fields.map((field) => [field.name.toUpperCase(), field]))
  const bindings = protocolVariableBindings(protocol, semanticText)
  return getDtpProtocolFrames(protocol).map((frame) => frame.byte_layout.map((token, byteIndex) => {
    const fixed = normalizeHexByte(token)
    if (fixed) return fixed
    if (/^SUM$/i.test(token)) return "00"
    const field = fields.get(token.toUpperCase())
    const layoutField = frame.field_layout.find((item) => item.name.toUpperCase() === token.toUpperCase()) ??
      frame.field_layout.find((item) => item.byte_offset === byteIndex && item.bit_offset === undefined)
    if (layoutField && (layoutField.options?.length ?? 0) > 1) {
      const busResolution = resolveDtpBusFieldOption(protocol, layoutField, semanticText)
      if (busResolution) return busResolution.value
    }
    return evaluateProtocolValueRule(layoutField?.value_rule, bindings) ??
      normalizeHexByte(layoutField?.default_value) ??
      normalizeHexByte(layoutField?.options?.[0]?.value) ??
      normalizeHexByte(field?.value) ??
      normalizeHexByte(field?.options?.[0]?.value) ??
      "00"
  }))
}

function unresolvedProtocolVariableFieldPlans(
  protocol: DtpProtocolDefinition | undefined,
  plan: CaseStepDataGenerationPlan,
  semanticText = "",
): PacketFieldValuePlan[] {
  if (!protocol) return []
  const protocolFields = new Map(protocol.fields.map((field) => [field.name.toUpperCase(), field]))
  const explicitlyAssigned = new Set(
    plan.mutations
      .filter((mutation) => normalizeHexByte(mutation.value))
      .map((mutation) => mutation.field.toUpperCase()),
  )
  const unresolved = new Map<string, PacketFieldValuePlan>()
  const bindings = protocolVariableBindings(protocol, semanticText)
  for (const frame of getDtpProtocolFrames(protocol)) {
    for (const [byteIndex, token] of frame.byte_layout.entries()) {
      const dynamicField = frame.field_layout.find((item) => item.byte_offset === byteIndex && item.value_rule)
      if (
        dynamicField?.value_rule &&
        !explicitlyAssigned.has(dynamicField.name.toUpperCase()) &&
        !evaluateProtocolValueRule(dynamicField.value_rule, bindings)
      ) {
        const variableName = dynamicField.value_rule.variable ?? dynamicField.name
        unresolved.set(`${frame.frame_id}:${dynamicField.name}`, {
          field_name: variableName,
          value: "00",
          value_source: "fallback-zero",
          source_table_id: frame.source_table_id,
          source_text: dynamicField.source_text ?? `frame ${frame.sequence}, byte ${byteIndex}`,
          confidence: 0.2,
          reasoning: ["Dynamic protocol variable could not be resolved from step_desc or its protocol dictionary."],
        })
      }
      if (!/^(?:W|DATA)\d+$/i.test(token) || explicitlyAssigned.has(token.toUpperCase())) continue
      const field = protocolFields.get(token.toUpperCase())
      const layoutField = frame.field_layout.find((item) => item.name.toUpperCase() === token.toUpperCase())
      const resolved = normalizeHexByte(layoutField?.default_value) ??
        normalizeHexByte(layoutField?.options?.[0]?.value) ??
        normalizeHexByte(field?.value) ??
        normalizeHexByte(field?.options?.[0]?.value)
      if (resolved) continue
      unresolved.set(`${frame.frame_id}:${token}`, {
        field_name: token.toUpperCase(),
        value: "00",
        value_source: "fallback-zero",
        source_table_id: frame.source_table_id,
        source_text: layoutField?.source_text ?? `frame ${frame.sequence}, byte ${byteIndex}`,
        confidence: 0.2,
        reasoning: ["No explicit value was found in the step, protocol support tables, or project field-value evidence."],
      })
    }
  }
  return Array.from(unresolved.values())
}

function compactFallbackFieldNames(fieldNames: string[]): string[] {
  const numberedFields = new Map<string, Set<number>>()
  const otherFields: string[] = []
  for (const fieldName of uniqueStrings(fieldNames.map((name) => name.toUpperCase()))) {
    const match = fieldName.match(/^(W|DATA)(\d+)$/)
    if (!match) {
      otherFields.push(fieldName)
      continue
    }
    const indexes = numberedFields.get(match[1]) ?? new Set<number>()
    indexes.add(Number.parseInt(match[2], 10))
    numberedFields.set(match[1], indexes)
  }

  const compacted = [...otherFields]
  for (const [prefix, values] of numberedFields) {
    const indexes = [...values].sort((left, right) => left - right)
    const firstIndex = indexes[0]
    if (firstIndex === undefined) continue
    let rangeStart = firstIndex
    let rangeEnd = firstIndex
    const publishRange = () => {
      compacted.push(rangeStart === rangeEnd
        ? `${prefix}${rangeStart}`
        : `${prefix}${rangeStart}-${prefix}${rangeEnd}`)
    }
    for (const index of indexes.slice(1)) {
      if (index === rangeEnd + 1) {
        rangeEnd = index
        continue
      }
      publishRange()
      rangeStart = index
      rangeEnd = index
    }
    publishRange()
  }
  return compacted
}

function uniquePacketFieldValuePlans(plans: PacketFieldValuePlan[]): PacketFieldValuePlan[] {
  const unique = new Map<string, PacketFieldValuePlan>()
  for (const plan of plans) {
    const key = `${plan.field_name}:${plan.source_table_id ?? ""}:${plan.value_source}`
    unique.set(key, plan)
  }
  return Array.from(unique.values())
}

function readPacketLines(filePath: string): string[][] {
  if (!existsSync(filePath)) return []
  return decodeTextFile(filePath)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => Boolean(line && !line.startsWith("#")))
    .map((line) => line.split(/\s+/).map((value) => normalizeHexByte(value)).filter((value): value is string => Boolean(value)))
    .filter((line) => line.length > 0)
}

function normalizeBlockPacketLines(lines: string[][], protocol: DtpProtocolDefinition | undefined): string[][] {
  const totalBytes = protocol?.block_layout?.total_bytes
  if (!totalBytes || !lines.length || lines.every((line) => line.length === totalBytes)) return lines
  const flattened = lines.flat()
  if (flattened.length % totalBytes !== 0) return lines
  return Array.from({ length: flattened.length / totalBytes }, (_, index) => (
    flattened.slice(index * totalBytes, (index + 1) * totalBytes)
  ))
}

function selectedBlockFrameIndex(
  protocol: DtpProtocolDefinition | undefined,
  selectedBlock: CaseStepDataGenerationPlan["selected_block"],
): number | undefined {
  if (!protocol || !selectedBlock) return undefined
  const index = getDtpProtocolFrames(protocol).findIndex((frame) => frame.frame_id === selectedBlock)
  return index >= 0 ? index : undefined
}

function packetLinesMatchSelectedBlock(
  lines: string[][],
  protocol: DtpProtocolDefinition | undefined,
  selectedBlock: CaseStepDataGenerationPlan["selected_block"],
): boolean {
  const block = protocol?.block_layout
  const frameIndex = selectedBlockFrameIndex(protocol, selectedBlock)
  if (!block || frameIndex === undefined || lines.length !== 1 || lines[0].length !== block.total_bytes) return false
  return spaceWireBlockTemplateIndex(protocol, lines[0], frameIndex) === frameIndex
}

function expandSelectedBlockBaseline(
  selectedLines: string[][],
  protocolLines: string[][],
  protocol: DtpProtocolDefinition | undefined,
  selectedBlock: CaseStepDataGenerationPlan["selected_block"],
): string[][] {
  const frameIndex = selectedBlockFrameIndex(protocol, selectedBlock)
  if (frameIndex === undefined || !packetLinesMatchSelectedBlock(selectedLines, protocol, selectedBlock)) return selectedLines
  const expanded = protocolLines.map((line) => line.slice())
  if (frameIndex >= expanded.length) return selectedLines
  expanded[frameIndex] = selectedLines[0].slice()
  return expanded
}

function selectPlannedBlockLines(
  frames: RenderedCaseFrame[],
  protocol: DtpProtocolDefinition | undefined,
  plan: CaseStepDataGenerationPlan,
): RenderedCaseFrame[] {
  if (plan.artifact_scope !== "single_block" || !plan.selected_block) return frames
  const frameIndex = selectedBlockFrameIndex(protocol, plan.selected_block)
  if (frameIndex === undefined) return frames
  const selected = frames.find((frame) => frame.canonicalFrameIndex === frameIndex)
  return selected ? [selected] : frames
}

function packetLinesMatchProtocol(lines: string[][], protocolLines: string[][]): boolean {
  return lines.length === protocolLines.length && lines.every((line, index) => line.length === protocolLines[index]?.length)
}

function spaceWireBlockTemplateIndex(
  protocol: DtpProtocolDefinition | undefined,
  line: string[] | undefined,
  lineIndex: number,
): number {
  const block = protocol?.block_layout
  if (!block || block.kind !== "spacewire_program_upload" || !line || block.block_type_offset === undefined) return lineIndex
  const blockType = normalizeHexByte(line[block.block_type_offset])
  if (blockType === normalizeHexByte(block.start_block_type)) return 0
  if (blockType === normalizeHexByte(block.middle_block_type)) return 1
  if (blockType === normalizeHexByte(block.check_block_type)) return 2
  return lineIndex
}

function packetLinesMatchBlockProtocol(
  lines: string[][],
  protocol: DtpProtocolDefinition | undefined,
): boolean {
  const block = protocol?.block_layout
  if (!block || !lines.length || lines.some((line) => line.length !== block.total_bytes)) return false
  if (block.kind !== "spacewire_program_upload") return true
  if (lines.length < 2 || block.block_type_offset === undefined) return false
  const blockTypeOffset = block.block_type_offset
  const blockTypes = lines.map((line) => normalizeHexByte(line[blockTypeOffset]))
  return blockTypes[0] === normalizeHexByte(block.start_block_type) &&
    blockTypes.at(-1) === normalizeHexByte(block.check_block_type) &&
    blockTypes.slice(1, -1).every((value) => value === normalizeHexByte(block.middle_block_type))
}

const PLAN_FIELD_ROLE_BY_NAME: Record<string, DtpProtocolFieldRole> = {
  ARBITRATION: "arbitration",
  ID: "arbitration",
  CONTROL: "control",
  DLC: "control",
  RTR: "control",
  ADDRESS: "address",
  STATION_ADDRESS: "address",
  MESSAGE_TYPE: "type",
  TYPE: "type",
  PACKAGE_ID: "fixed",
  BLOCK_TYPE: "type",
  START_ADDRESS: "address",
  TITLE: "title",
  LENGTH: "length",
  DATA_LENGTH: "length",
  L: "length",
  FRAME_SEQUENCE: "sequence",
  FRAME_INDEX: "sequence",
  SEQUENCE: "sequence",
  INDEX: "sequence",
  SUM: "checksum",
  CRC: "checksum",
  CHECKSUM: "checksum",
  ISO_CHECKSUM: "checksum",
  PROGRAM_CHECKSUM: "checksum",
}

function declaredPlanFields(
  fieldName: string,
  fieldLayout: DtpProtocolFieldLayout[],
): DtpProtocolFieldLayout[] {
  const normalized = fieldName.toUpperCase()
  const explicitFields = fieldLayout.filter((field) => field.name.toUpperCase() === normalized)
  if (explicitFields.length) return explicitFields
  const role = PLAN_FIELD_ROLE_BY_NAME[normalized]
  return role ? fieldLayout.filter((field) => field.role === role) : []
}

function resolvePlanFieldIndex(
  fieldName: string,
  layout: string[] | undefined,
  byteLength: number,
  fieldLayout: DtpProtocolFieldLayout[] = [],
): number | undefined {
  const normalized = fieldName.toUpperCase()
  const declaredOffsets = new Set(declaredPlanFields(fieldName, fieldLayout).map((field) => field.byte_offset))
  if (declaredOffsets.size === 1) return Array.from(declaredOffsets)[0]
  if (declaredOffsets.size > 1) return undefined
  const wordIndex = normalized.match(/^W(\d+)$/)?.[1]
  if (wordIndex !== undefined) {
    const requestedIndex = Number.parseInt(wordIndex, 10)
    for (const field of fieldLayout) {
      const range = field.source_text?.match(/^\s*W(\d+)(?:\s*[~\uff5e\-]\s*(?:W)?(\d+))?/i)
      if (!range) continue
      const rangeStart = Number.parseInt(range[1], 10)
      const rangeEnd = Number.parseInt(range[2] ?? range[1], 10)
      if (requestedIndex >= rangeStart && requestedIndex <= rangeEnd) {
        return field.byte_offset + requestedIndex - rangeStart
      }
    }
  }
  const layoutIndex = layout?.findIndex((token) => token.toUpperCase() === normalized) ?? -1
  if (layoutIndex >= 0) return layoutIndex
  if (normalized === "ADDRESS" || normalized === "STATION_ADDRESS" || normalized === "\u7ad9\u5730\u5740") return byteLength ? 0 : undefined
  if (normalized === "MESSAGE_TYPE" || normalized === "TYPE" || normalized === "\u7c7b\u578b") return byteLength ? 0 : undefined
  if (normalized === "ARBITRATION" || normalized === "ID" || normalized === "仲裁场") return byteLength ? 0 : undefined
  if (normalized === "CONTROL" || normalized === "控制场" || normalized === "DLC") return byteLength > 1 ? 1 : undefined
  if (normalized === "TITLE") {
    const firstDataWord = layout?.findIndex((token) => /^W0$/i.test(token)) ?? -1
    if (firstDataWord > 0) return firstDataWord - 1
    return byteLength > 2 ? 2 : byteLength ? 0 : undefined
  }
  if (normalized === "SUM" || normalized === "CRC" || normalized === "CHECKSUM") {
    return layout?.length ? undefined : byteLength ? byteLength - 1 : undefined
  }
  if (normalized === "LENGTH" || normalized === "L") {
    const explicit = layout?.findIndex((token) => /^(?:L|LENGTH)$/i.test(token)) ?? -1
    if (explicit >= 0) return explicit
    const firstDataWord = layout?.findIndex((token) => /^W0$/i.test(token)) ?? -1
    return firstDataWord > 1 ? firstDataWord - 2 : undefined
  }
  if (/^(?:FRAME_SEQUENCE|FRAME_INDEX|SEQUENCE|INDEX)$/.test(normalized)) {
    return byteLength > 2 ? 2 : undefined
  }
  return undefined
}

function resolveCaseStepMutationIndex(
  mutation: CaseStepDataMutation,
  layout: string[] | undefined,
  byteLength: number,
  fieldLayout: DtpProtocolFieldLayout[] = [],
): number | undefined {
  const declaredFields = declaredPlanFields(mutation.field, fieldLayout)
  const resolved = resolvePlanFieldIndex(mutation.field, layout, byteLength, fieldLayout)
  if (resolved !== undefined) return resolved
  return declaredFields.length ? undefined : mutation.byte_index
}

function mutationTargetCanonicalFrameIndexes(
  mutation: CaseStepDataMutation,
  protocol: DtpProtocolDefinition | undefined,
  fallbackFrameCount?: number,
): number[] {
  if (mutation.frame_index !== undefined) return [mutation.frame_index - 1]
  const frames = protocol ? getDtpProtocolFrames(protocol) : []
  const matchingFrames = frames.flatMap((frame, frameIndex) => (
    resolveCaseStepMutationIndex(
      mutation,
      frame.byte_layout,
      frame.byte_layout.length,
      frame.field_layout,
    ) !== undefined ? [frameIndex] : []
  ))
  if (matchingFrames.length) return matchingFrames
  return Array.from({ length: fallbackFrameCount ?? frames.length }, (_, frameIndex) => frameIndex)
}

function canonicalizeCaseStepMutationFrames(
  protocol: DtpProtocolDefinition | undefined,
  mutations: CaseStepDataMutation[],
): CaseStepDataMutation[] {
  if (!protocol) return mutations
  return mutations.map((mutation) => {
    if (mutation.frame_index === undefined && /^(?:TITLE|LENGTH|L)$/i.test(mutation.field)) {
      const namedFrames = getDtpProtocolFrames(protocol).flatMap((frame, index) => (
        frame.field_layout.some(field => field.name.toUpperCase() === mutation.field.toUpperCase()) ||
        frame.byte_layout.some(token => token.toUpperCase() === mutation.field.toUpperCase())
          ? [index] : []
      ))
      // A continuation frame's sequence/DLC is not an implicit TITLE/LENGTH.
      if (namedFrames.length === 1) return { ...mutation, frame_index: namedFrames[0] + 1 }
    }
    // Resolve Wn ownership separately; shared structural fields may intentionally
    // apply to multiple frames when there is no unique declared owner.
    if (mutation.frame_index !== undefined || !/^W\d+$/i.test(mutation.field)) return mutation
    const targetFrames = mutationTargetCanonicalFrameIndexes(mutation, protocol)
    return targetFrames.length === 1
      ? { ...mutation, frame_index: targetFrames[0] + 1 }
      : mutation
  })
}

function scopeUnqualifiedProtocolFaults(
  protocol: DtpProtocolDefinition | undefined,
  mutations: CaseStepDataMutation[],
): { mutations: CaseStepDataMutation[]; warnings: string[] } {
  const firstChild = protocol?.composition?.children[0]
  if (!protocol) return { mutations, warnings: [] }
  const frames = getDtpProtocolFrames(protocol)
  const firstStart = firstChild ? firstChild.frame_start - 1 : 0
  const firstEnd = firstChild ? firstStart + firstChild.frame_count : frames.length
  const warnings: string[] = []
  const scoped = mutations.map((mutation) => {
    if (mutation.frame_index !== undefined || mutation.operation === "replace") return mutation
    if (!firstChild && !/^(?:FRAME_SEQUENCE|FRAME_INDEX|SEQUENCE|INDEX)$/i.test(mutation.field)) return mutation
    const targetFrame = frames.findIndex((frame, frameIndex) => (
      frameIndex >= firstStart &&
      frameIndex < firstEnd &&
      resolveCaseStepMutationIndex(
        mutation,
        frame.byte_layout,
        frame.byte_layout.length,
        frame.field_layout,
      ) !== undefined
    ))
    if (targetFrame < 0) return mutation
    warnings.push(firstChild
      ? `${mutation.field} fault did not identify a child packet; it was applied to the first applicable frame of ${firstChild.protocol_id}.`
      : `${mutation.field} fault did not identify a frame; it was applied to the first applicable canonical frame.`)
    return { ...mutation, frame_index: targetFrame + 1 }
  })
  return { mutations: scoped, warnings: uniqueStrings(warnings) }
}

interface PacketChecksumContext {
  checksumFrameIndex: number
  checksumByteIndex: number
  includedBytes: Array<{ frameIndex: number; byteIndex: number }>
}

function resolvePacketChecksumContext(
  lines: string[][],
  layouts: string[][],
  frames: DtpProtocolFrameDefinition[] = [],
): PacketChecksumContext | undefined {
  let checksumFrameIndex = -1
  let checksumByteIndex = -1
  for (const [frameIndex, layout] of layouts.entries()) {
    const checksumField = frames[frameIndex]?.field_layout.find((field) => field.role === "checksum")
    const index = checksumField?.byte_offset ??
      layout.findIndex((token) => /^(?:SUM|CHECKSUM|CRC)$/i.test(token))
    if (index >= 0 && index < (lines[frameIndex]?.length ?? 0)) {
      checksumFrameIndex = frameIndex
      checksumByteIndex = index
      break
    }
  }
  if (checksumFrameIndex < 0 || checksumByteIndex < 0) return undefined

  const checksumDefinition = frames[checksumFrameIndex]?.checksum
  const explicitStart = checksumDefinition?.start?.trim()
  if (explicitStart && !/^TITLE$/i.test(explicitStart)) {
    const checksumLine = lines[checksumFrameIndex]
    const checksumLayout = layouts[checksumFrameIndex]
    const checksumFields = frames[checksumFrameIndex]?.field_layout ?? []
    const startIndex = resolvePlanFieldIndex(explicitStart, checksumLayout, checksumLine.length, checksumFields)
    if (startIndex === undefined || startIndex < 0 || startIndex >= checksumByteIndex) return undefined
    return {
      checksumFrameIndex,
      checksumByteIndex,
      includedBytes: Array.from(
        { length: checksumByteIndex - startIndex },
        (_, offset) => ({ frameIndex: checksumFrameIndex, byteIndex: startIndex + offset }),
      ),
    }
  }

  const includedBytes: PacketChecksumContext["includedBytes"] = []
  let titleLocation: { frameIndex: number; byteIndex: number } | undefined
  for (const [frameIndex, layout] of layouts.entries()) {
    const frameFields = frames[frameIndex]?.field_layout ?? []
    const explicitTitle = frameFields.find((field) => field.role === "title")?.byte_offset ??
      layout.findIndex((token) => /^TITLE$/i.test(token))
    if (explicitTitle >= 0) titleLocation ??= { frameIndex, byteIndex: explicitTitle }
    for (const field of frameFields) {
      if (field.role !== "data") continue
      for (let offset = 0; offset < field.byte_length; offset += 1) {
        const byteIndex = field.byte_offset + offset
        if (byteIndex < (lines[frameIndex]?.length ?? 0)) {
          includedBytes.push({ frameIndex, byteIndex })
        }
      }
    }
    for (const [byteIndex, token] of layout.entries()) {
      if (/^W\d+$/i.test(token) && byteIndex < (lines[frameIndex]?.length ?? 0)) {
        if (!includedBytes.some((item) => item.frameIndex === frameIndex && item.byteIndex === byteIndex)) {
          includedBytes.push({ frameIndex, byteIndex })
        }
        if (/^W0$/i.test(token) && byteIndex > 0) titleLocation ??= { frameIndex, byteIndex: byteIndex - 1 }
      }
    }
  }
  if (titleLocation) includedBytes.unshift(titleLocation)

  if (!includedBytes.length) {
    const line = lines[checksumFrameIndex]
    const layout = layouts[checksumFrameIndex]
    const titleIndex = resolvePlanFieldIndex("TITLE", layout, line.length, frames[checksumFrameIndex]?.field_layout)
    if (titleIndex === undefined || checksumByteIndex <= titleIndex) return undefined
    for (let byteIndex = titleIndex; byteIndex < checksumByteIndex; byteIndex += 1) {
      includedBytes.push({ frameIndex: checksumFrameIndex, byteIndex })
    }
  }
  return { checksumFrameIndex, checksumByteIndex, includedBytes }
}

function expectedPacketChecksum(lines: string[][], context: PacketChecksumContext): number {
  return context.includedBytes.reduce((sum, location) => (
    sum + Number.parseInt(lines[location.frameIndex]?.[location.byteIndex] ?? "00", 16)
  ), 0) & 0xff
}

function resolvePacketChecksumContexts(
  lines: string[][],
  layouts: string[][],
  frames: DtpProtocolFrameDefinition[] = [],
): PacketChecksumContext[] {
  if (!frames.some((frame) => frame.packet_group_id)) {
    const context = resolvePacketChecksumContext(lines, layouts, frames)
    return context ? [context] : []
  }
  const contexts: PacketChecksumContext[] = []
  let start = 0
  while (start < frames.length) {
    const packetGroupId = frames[start].packet_group_id
    let end = start + 1
    while (end < frames.length && frames[end].packet_group_id === packetGroupId) end += 1
    const local = resolvePacketChecksumContext(
      lines.slice(start, end),
      layouts.slice(start, end),
      frames.slice(start, end),
    )
    if (local) {
      contexts.push({
        checksumFrameIndex: local.checksumFrameIndex + start,
        checksumByteIndex: local.checksumByteIndex,
        includedBytes: local.includedBytes.map((location) => ({
          frameIndex: location.frameIndex + start,
          byteIndex: location.byteIndex,
        })),
      })
    }
    start = end
  }
  return contexts
}

function applyPacketChecksumPolicy(
  lines: string[][],
  layouts: string[][],
  policy: CaseStepDataGenerationPlan["checksum_policy"],
  frames: DtpProtocolFrameDefinition[] = [],
): void {
  if (policy !== "recalculate_correctly" && policy !== "make_incorrect") return
  for (const [index, context] of resolvePacketChecksumContexts(lines, layouts, frames).entries()) {
    const expected = expectedPacketChecksum(lines, context)
    const makeIncorrect = policy === "make_incorrect" && index === 0
    const checksum = makeIncorrect ? (expected + 1) & 0xff : expected
    lines[context.checksumFrameIndex][context.checksumByteIndex] = checksum.toString(16).toUpperCase().padStart(2, "0")
  }
}

type RenderedCaseFrame = {
  canonicalFrameIndex: number
  bytes: string[]
}

function encodeCaseFrameTransport(
  renderedFrames: RenderedCaseFrame[],
  protocol: DtpProtocolDefinition | undefined,
): {
  lines: string[][]
  frameInformationBytes: string[]
  envelopeBytes: string[]
  warnings: string[]
} {
  return encodeDtpBusTransport(renderedFrames, protocol)
}

function applyCaseStepPlanToPacketLines(
  baseLines: string[][],
  plan: CaseStepDataGenerationPlan,
  protocol: DtpProtocolDefinition | undefined,
): RenderedCaseFrame[] {
  const frames = protocol ? getDtpProtocolFrames(protocol) : []
  const layouts = frames.map((frame) => frame.byte_layout)
  const mutatedLines = baseLines.map((baseLine, lineIndex) => {
    const line = baseLine.slice()
    const appliedPhysicalTargets = new Set<string>()
    const canonicalFrameIndex = spaceWireBlockTemplateIndex(protocol, baseLine, lineIndex)
    const layout = layouts[canonicalFrameIndex] ?? layouts[lineIndex] ?? layouts[0]
    const fieldLayout = frames[canonicalFrameIndex]?.field_layout ?? frames[lineIndex]?.field_layout
    for (const mutation of plan.mutations) {
      const targetFrames = mutationTargetCanonicalFrameIndexes(mutation, protocol, baseLines.length)
      if (!targetFrames.includes(canonicalFrameIndex)) continue
      const index = resolveCaseStepMutationIndex(
        mutation,
        layout,
        line.length,
        fieldLayout,
      )
      if (index === undefined || index < 0 || index >= line.length) continue
      const current = Number.parseInt(line[index], 16)
      const explicit = normalizeHexByte(mutation.value)
      const declaredFields = declaredPlanFields(mutation.field, fieldLayout ?? [])
      const declaredField = declaredFields.find((field) => field.name.toUpperCase() === mutation.field.toUpperCase()) ??
        declaredFields.find((field) => field.byte_offset === index)
      const physicalTarget = `${index}:${declaredField?.bit_offset ?? "full"}:${declaredField?.bit_length ?? 8}`
      if (appliedPhysicalTargets.has(physicalTarget)) continue
      appliedPhysicalTargets.add(physicalTarget)
      const hasBitRange = declaredField?.bit_offset !== undefined && declaredField.bit_length !== undefined
      let next: string
      if (hasBitRange) {
        const bitOffset = Math.max(0, Math.min(7, Math.floor(declaredField.bit_offset ?? 0)))
        const bitLength = Math.max(1, Math.min(8 - bitOffset, Math.floor(declaredField.bit_length ?? 1)))
        const valueMask = (1 << bitLength) - 1
        const mask = valueMask << bitOffset
        const currentFieldValue = (current >> bitOffset) & valueMask
        const requestedFieldValue = explicit
          ? Number.parseInt(explicit, 16) & valueMask
          : mutation.operation === "xor"
            ? currentFieldValue ^ (Number.parseInt(explicit ?? valueMask.toString(16), 16) & valueMask)
            : (currentFieldValue + 1) & valueMask
        const changedFieldValue = mutation.operation === "replace_with_invalid_value" && requestedFieldValue === currentFieldValue
          ? (currentFieldValue + 1) & valueMask
          : requestedFieldValue
        next = ((current & ~mask) | ((changedFieldValue & valueMask) << bitOffset))
          .toString(16).toUpperCase().padStart(2, "0")
      } else {
        next = (mutation.operation === "replace" || mutation.operation === "replace_with_invalid_value") && explicit
          ? explicit
          : mutation.operation === "xor"
            ? ((current ^ Number.parseInt(explicit ?? "FF", 16)) & 0xff).toString(16).toUpperCase().padStart(2, "0")
            : ((current + 1) & 0xff).toString(16).toUpperCase().padStart(2, "0")
      }
      line[index] = mutation.operation === "replace_with_invalid_value" && next === baseLine[index]
        ? ((current + 1) & 0xff).toString(16).toUpperCase().padStart(2, "0")
        : next
    }

    return line
  })
  if (!protocol?.block_layout) {
    applyPacketChecksumPolicy(mutatedLines, layouts, plan.checksum_policy, frames)
  } else if (plan.checksum_policy !== "none") {
    const isoChecksum = protocol.block_layout.checksums.find((checksum) => (
      checksum.algorithm === "iso_8473" && checksum.source === "frame_range" && checksum.output_length === 2
    ))
    for (const [lineIndex, line] of mutatedLines.entries()) {
      const checksummed = applyDtpBlockFrameChecksums(line, protocol).bytes
      if (plan.checksum_policy === "make_incorrect" && isoChecksum) {
        const current = Number.parseInt(checksummed[isoChecksum.output_offset] ?? "00", 16)
        checksummed[isoChecksum.output_offset] = ((current + 1) & 0xff).toString(16).toUpperCase().padStart(2, "0")
      }
      mutatedLines[lineIndex] = checksummed
    }
  }
  for (const mutation of plan.mutations) {
    if (!/^(?:SUM|CRC|CHECKSUM|校验和|校验字)$/i.test(mutation.field)) continue
    const explicit = normalizeHexByte(mutation.value)
    if (!explicit) continue
    const targetFrames = mutation.frame_index ? [mutation.frame_index - 1] : mutatedLines.map((_, index) => index)
    for (const frameIndex of targetFrames) {
      const line = mutatedLines[frameIndex]
      const canonicalFrameIndex = spaceWireBlockTemplateIndex(protocol, line, frameIndex)
      const layout = layouts[canonicalFrameIndex] ?? layouts[frameIndex] ?? layouts[0]
      if (!line) continue
      const byteIndex = resolveCaseStepMutationIndex(
        mutation,
        layout,
        line.length,
        frames[canonicalFrameIndex]?.field_layout ?? frames[frameIndex]?.field_layout,
      )
      if (byteIndex !== undefined && byteIndex >= 0 && byteIndex < line.length) line[byteIndex] = explicit
    }
  }

  const result: RenderedCaseFrame[] = mutatedLines.map((line, lineIndex) => ({
    canonicalFrameIndex: spaceWireBlockTemplateIndex(protocol, line, lineIndex),
    bytes: line.slice(),
  }))
  for (const operation of plan.sequence_operations) {
    const canonicalIndex = (operation.frame_index ?? 0) - 1
    const index = result.findIndex((frame) => frame.canonicalFrameIndex === canonicalIndex)
    if (operation.operation === "swap_frames") {
      const otherCanonicalIndex = (operation.other_frame_index ?? 0) - 1
      const otherIndex = result.findIndex((frame) => frame.canonicalFrameIndex === otherCanonicalIndex)
      if (index >= 0 && index < result.length && otherIndex >= 0 && otherIndex < result.length) {
        ;[result[index], result[otherIndex]] = [result[otherIndex], result[index]]
      }
      continue
    }
    if (operation.operation === "drop_frame") {
      if (index >= 0 && index < result.length) result.splice(index, 1)
      continue
    }
    if (operation.operation === "repeat_frame") {
      if (index >= 0 && index < result.length) {
        const repeated = Array.from({ length: operation.repeat_count ?? 1 }, () => ({
          canonicalFrameIndex: canonicalIndex,
          bytes: result[index].bytes.slice(),
        }))
        result.splice(index + 1, 0, ...repeated)
      }
      continue
    }
    if (operation.operation === "append_frame") {
      const appended = operation.bytes?.length
        ? operation.bytes.slice()
        : canonicalIndex >= 0 && canonicalIndex < mutatedLines.length
          ? mutatedLines[canonicalIndex].slice()
          : undefined
      if (appended?.length) result.push({ canonicalFrameIndex: canonicalIndex, bytes: appended })
    }
  }
  return result
}

function renderedCanonicalFrameIndices(
  canonicalFrameCount: number,
  operations: CaseStepSequenceOperation[],
): number[] {
  const renderedIndices = Array.from({ length: canonicalFrameCount }, (_, index) => index)
  for (const operation of operations) {
    const canonicalIndex = (operation.frame_index ?? 0) - 1
    const index = renderedIndices.indexOf(canonicalIndex)
    if (operation.operation === "swap_frames") {
      const otherIndex = renderedIndices.indexOf((operation.other_frame_index ?? 0) - 1)
      if (index >= 0 && otherIndex >= 0) {
        ;[renderedIndices[index], renderedIndices[otherIndex]] = [renderedIndices[otherIndex], renderedIndices[index]]
      }
      continue
    }
    if (operation.operation === "drop_frame") {
      if (index >= 0) renderedIndices.splice(index, 1)
      continue
    }
    if (operation.operation === "repeat_frame") {
      if (index >= 0) {
        renderedIndices.splice(index + 1, 0, ...Array.from(
          { length: operation.repeat_count ?? 1 },
          () => canonicalIndex,
        ))
      }
      continue
    }
    if (operation.operation === "append_frame") renderedIndices.push(canonicalIndex)
  }
  return renderedIndices
}

function canonicalPacketLinesFromSequenceOutput(
  lines: string[][],
  canonicalFrameCount: number,
  operations: CaseStepSequenceOperation[],
): string[][] | undefined {
  const renderedIndices = renderedCanonicalFrameIndices(canonicalFrameCount, operations)
  if (renderedIndices.length !== lines.length) return undefined
  const canonicalLines = new Array<string[] | undefined>(canonicalFrameCount)
  for (const [outputIndex, canonicalIndex] of renderedIndices.entries()) {
    if (canonicalIndex < 0 || canonicalIndex >= canonicalFrameCount) continue
    canonicalLines[canonicalIndex] ??= lines[outputIndex]
  }
  const completeCanonicalLines = Array.from(
    { length: canonicalFrameCount },
    (_, index) => canonicalLines[index],
  )
  return completeCanonicalLines.every((line): line is string[] => Array.isArray(line))
    ? completeCanonicalLines
    : undefined
}

function caseStepFaultFramePrefix(
  plan: CaseStepDataGenerationPlan,
  fieldPattern: RegExp,
  canonicalFrameCount?: number,
): string {
  const mutation = plan.mutations.find((item) => fieldPattern.test(item.field))
  const frameIndex = mutation?.frame_index
  if (!frameIndex) return ""
  if (frameIndex === 1) return "首帧"
  if (canonicalFrameCount && frameIndex === canonicalFrameCount) return "尾帧"
  return `第${frameIndex}帧`
}

function caseStepVariantLabel(plan: CaseStepDataGenerationPlan, canonicalFrameCount?: number): string {
  const sequenceOperations = mergeCaseStepSequenceOperations(plan.sequence_operations)
  const sequenceLabels: string[] = []
  for (let index = 0; index < sequenceOperations.length; index += 1) {
    const operation = sequenceOperations[index]
    const frame = operation.frame_index ?? 0
    if (operation.operation === "drop_frame") {
      let rangeEnd = frame
      while (
        index + 1 < sequenceOperations.length &&
        sequenceOperations[index + 1].operation === "drop_frame" &&
        (sequenceOperations[index + 1].frame_index ?? 0) === rangeEnd + 1
      ) {
        index += 1
        rangeEnd += 1
      }
      if (frame !== rangeEnd) sequenceLabels.push(`跳过第${frame}-${rangeEnd}帧`)
      else if (frame === 1) sequenceLabels.push("缺少首帧")
      else if (canonicalFrameCount && frame === canonicalFrameCount) sequenceLabels.push("缺少尾帧")
      else sequenceLabels.push(`跳过第${frame}帧`)
      continue
    }
    if (operation.operation === "repeat_frame") {
      if (frame === 1) sequenceLabels.push("重复首帧")
      else if (canonicalFrameCount && frame === canonicalFrameCount) sequenceLabels.push("重复尾帧")
      else sequenceLabels.push(`重复第${frame}帧`)
      continue
    }
    if (operation.operation === "swap_frames") {
      sequenceLabels.push(`第${frame}帧与第${operation.other_frame_index ?? 0}帧顺序颠倒`)
      continue
    }
    sequenceLabels.push(`追加第${frame}帧`)
  }
  if (sequenceLabels.length) return sequenceLabels.join("-")
  if (plan.variant_type === "title_error") {
    return plan.checksum_policy === "recalculate_correctly" ? "TITLE异常-SUM正确" : "TITLE异常"
  }
  if (plan.variant_type === "checksum_error") return "SUM异常"
  if (plan.variant_type === "arbitration_error") {
    return `${caseStepFaultFramePrefix(plan, /^(?:ARBITRATION|ARBITRATION_FIELD)$/i, canonicalFrameCount)}仲裁场异常`
  }
  if (plan.variant_type === "control_error") {
    return `${caseStepFaultFramePrefix(plan, /^(?:CONTROL|CONTROL_FIELD)$/i, canonicalFrameCount)}控制场异常`
  }
  if (plan.variant_type === "length_error") return "长度异常"
  if (plan.variant_type === "field_error") {
    const sequenceMutation = plan.mutations.find((mutation) => (
      mutation.operation !== "replace" &&
      /^(?:FRAME_SEQUENCE|FRAME_INDEX|SEQUENCE|INDEX)$/i.test(mutation.field)
    ))
    if (sequenceMutation) {
      const frameIndex = sequenceMutation.frame_index ?? 0
      if (frameIndex === 1) return "首帧帧序号异常"
      if (canonicalFrameCount && frameIndex === canonicalFrameCount) return "尾帧帧序号异常"
      if (canonicalFrameCount === 3 && frameIndex === 2) return "中间帧帧序号异常"
      return `第${frameIndex}帧帧序号异常`
    }
    const fields = uniqueStrings(plan.mutations
      .filter((mutation) => mutation.operation !== "replace")
      .map((mutation) => mutation.field.toUpperCase())
      .map((field) => ({
        STATION_ADDRESS: "站地址",
        MESSAGE_TYPE: "消息类型",
        ADDRESS: "ADDRESS",
        INDEX: "INDEX",
      })[field] ?? (/^(?:W|DATA)\d+$/.test(field) ? field : ""))
      .filter(Boolean))
    return fields.length ? `${fields.join("-")}异常` : "字段异常"
  }
  if (plan.variant_type === "correct") return "正常"
  return "待确认"
}

function caseStepDataFileName(
  stepIndex: number,
  protocolName: string,
  plan: CaseStepDataGenerationPlan,
  canonicalFrameCount?: number,
  fallback = false,
): string {
  const baseVariantLabel = caseStepVariantLabel(plan, canonicalFrameCount)
  const variantLabel = fallback && baseVariantLabel !== "待确认"
    ? `${baseVariantLabel}-待确认`
    : baseVariantLabel
  const commandLabel = plan.command && plan.command.selection_source !== "document_order_default"
    ? `-${plan.command.code}-${plan.command.name}`
    : ""
  const blockLabel = plan.artifact_scope === "single_block"
    ? plan.selected_block === "start-block"
      ? "-起始块"
      : plan.selected_block === "middle-block"
        ? "-中间块"
        : plan.selected_block === "check-block"
          ? "-校验块"
          : ""
    : ""
  const rawStem = cleanGeneratedDataFileBaseName(
    `S${String(stepIndex).padStart(2, "0")}-${protocolName}${blockLabel}${commandLabel}-${variantLabel}`,
  )
    .replace(/[，,；;：:。！？!?（）()\[\]{}]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
  if (rawStem.length <= 80) return `${rawStem}.txt`
  const hash = createHash("sha256").update(rawStem).digest("hex").slice(0, 8)
  return `${rawStem.slice(0, 71)}-${hash}.txt`
}

function planHasUnresolvedSemanticFault(
  plan: CaseStepDataGenerationPlan,
  stepText: string,
  protocol: DtpProtocolDefinition | undefined,
): boolean {
  if (protocol && fieldMutationClauses(stepText, getDtpProtocolFrames(protocol).length).some(clause => clause.invalidFrameTarget)) return true
  const semanticFaults = stepFieldMutations(stepText, protocol ? getDtpProtocolFrames(protocol).length : undefined)
  const expectedMutations = scopeUnqualifiedProtocolFaults(
    protocol,
    canonicalizeCaseStepMutationFrames(protocol, semanticFaults.mutations),
  ).mutations
  const missingFieldMutation = expectedMutations
    .filter((mutation) => mutation.operation !== "replace")
    .some((expected) => !plan.mutations.some((actual) => (
      actual.operation !== "replace" &&
      actual.field.toUpperCase() === expected.field.toUpperCase() &&
      actual.frame_index === expected.frame_index
    )))
  if (missingFieldMutation) return true
  if (semanticFaults.variantType === "checksum_error" && plan.checksum_policy !== "make_incorrect") return true

  const sequenceIntent = frameSequenceIntentFromStep(stepText, protocol)
  const hasSequenceMutation = plan.sequence_operations.length > 0 || plan.mutations.some((mutation) => (
    mutation.operation !== "replace" && /^(?:FRAME_SEQUENCE|FRAME_INDEX|SEQUENCE|INDEX)$/i.test(mutation.field)
  ))
  return stepDescribesFrameSequenceFault(stepText) &&
    sequenceIntent.mutations.length === 0 &&
    sequenceIntent.operations.length === 0 &&
    !hasSequenceMutation
}

function generateCaseSpecificFallbackDataFile(
  input: BuildGeneratedStepInput,
  argument: KeywordArgumentDef,
  plan: CaseStepDataGenerationPlan,
): GeneratedDataFile {
  plan.fallback_used = true
  plan.deterministic_generation = false
  const requestedFileName = extractRequestedFileNameSafe(input.step)
  const stepProtocolName = stepProtocolDisplayName(
    semanticCaseStepDescription(input.step.stepDescription),
    plan.payload_length_bytes,
  )
  const protocolName = cleanGeneratedDataFileBaseName(
    stepProtocolName ?? cleanPublishedProtocolName(plan.protocol_name) ??
      cleanPublishedProtocolName(plan.base_file_name?.replace(/\.txt$/i, "")) ??
      requestedFileName?.replace(/\.txt$/i, "") ?? `step-${input.step.stepIndex}`,
  ) || `step-${input.step.stepIndex}`
  const fileName = caseStepDataFileName(input.step.stepIndex, protocolName, plan, undefined, true)
  const flowDirection = plan.flow_direction === "output" ? "output" : "input"
  const relativePath = join(flowDirectoryName(flowDirection), "用例生成", input.caseContext.caseId, fileName)
  const fullPath = join(input.inputDataRoot, relativePath)
  const robotPath = toRuntimeInputDataPath(relativePath)
  const intent: DataFileIntent = {
    keywordName: input.step.keywordName,
    argument,
    requestedFileName,
    stepDescription: input.step.stepDescription,
    timeValue: input.step.timeValue,
    knowledgeIndex: input.knowledgeIndex,
  }
  const packetCandidate = findPacketModelCandidate(intent)
  const content = packetCandidate ? buildPacketContentFromModel(intent, packetCandidate) : "00"
  const warning = packetCandidate
    ? `Canonical protocol data was unavailable; related packet candidate ${packetCandidate.name} was used as an unverified case fallback.`
    : "Canonical protocol data was unavailable; 00 placeholder content was used as an unverified case fallback."

  ensureDirectory(dirname(fullPath))
  writeFileSync(fullPath, `${content.trim()}\n`, "utf-8")
  appendDataFileIndexEntry(input.dataFileIndex, {
    id: createHash("sha256").update(`${input.caseContext.caseId}:${input.step.stepIndex}:${robotPath}`).digest("hex").slice(0, 20),
    protocol_name: plan.protocol_name,
    requested_file_name: fileName,
    file_path: robotPath,
    absolute_file_path: fullPath,
    source: "dynamic-generated",
    source_documents: input.dataFileIndex.source_documents,
    generation_basis: uniqueStrings([
      "case-step-fallback",
      ...commandGenerationBasis(plan),
      ...plan.evidence_ids,
    ]),
    checksum_rule: DEFAULT_CHECKSUM_RULE,
    flow_direction: flowDirection,
    source_flow_heading: flowHeadingName(flowDirection),
    confidence: Math.min(plan.confidence, packetCandidate ? 0.35 : 0.1),
    state: "generated",
    warnings: uniqueStrings([...plan.warnings, warning]),
  })

  return {
    argument_name: argument.name,
    content_generation_required: true,
    requested_file_name: fileName,
    file_path: robotPath,
    generation_basis: uniqueStrings([
      "case-step-fallback",
      ...commandGenerationBasis(plan),
      ...plan.evidence_ids,
    ]),
    checksum_rule: DEFAULT_CHECKSUM_RULE,
    flow_direction: flowDirection,
    source_flow_heading: flowHeadingName(flowDirection),
    source_file_state: "case-fallback",
    variant_type: plan.variant_type,
    format_notes: [...commandFormatNotes(plan), warning],
  }
}

function generateCaseSpecificDataFile(
  input: BuildGeneratedStepInput,
  argument: KeywordArgumentDef,
  plan: CaseStepDataGenerationPlan,
): GeneratedDataFile {
  const semanticText = caseStepSemanticText(input)
  const resolvedProtocol = resolveProtocolForCasePlan(
    plan,
    input.protocolDefinitions,
    semanticText,
    semanticCaseStepDescription(input.step.stepDescription) || semanticText,
    input.protocolAnchorId,
  )
  const protocol = resolvedProtocol ? normalizeDtpProtocolDefinition(resolvedProtocol) : undefined
  const baseEntry = findCanonicalBaseEntry(input, protocol, plan)
  const baseAbsolutePath = baseEntry?.absolute_file_path ?? (baseEntry?.file_path
    ? runtimeInputDataPathToAbsolute(input.inputDataRoot, baseEntry.file_path)
    : undefined)
  const entryLines = normalizeBlockPacketLines(baseAbsolutePath ? readPacketLines(baseAbsolutePath) : [], protocol)
  const protocolLines = protocolBasePacketLines(protocol, semanticText)
  const selectedEntryIsComplete = packetLinesMatchSelectedBlock(entryLines, protocol, plan.selected_block)
  const validatedEntryIsComplete = Boolean(entryLines.length && (
    packetLinesMatchBlockProtocol(entryLines, protocol) ||
    selectedEntryIsComplete ||
    (baseEntry?.state === "validated" && (!protocolLines.length || packetLinesMatchProtocol(entryLines, protocolLines)))
  ))
  const baseLines = validatedEntryIsComplete
    ? selectedEntryIsComplete
      ? expandSelectedBlockBaseline(entryLines, protocolLines, protocol, plan.selected_block)
      : entryLines
    : protocolLines.length
      ? protocolLines
      : entryLines.length
        ? entryLines
        : []

  if (!baseLines.length) {
    return generateCaseSpecificFallbackDataFile(input, argument, plan)
  }

  const commandFieldPlans = commandDictionaryFieldPlans(plan, input.commandDictionaryIndex)
  const commandBaselineMutations = commandFieldPlanMutations(commandFieldPlans, protocol)
  const commandBaselineLines = commandBaselineMutations.length
    ? applyCaseStepPlanToPacketLines(baseLines, {
      ...plan,
      mutations: commandBaselineMutations,
      sequence_operations: [],
      checksum_policy: "preserve",
    }, protocol).map((frame) => frame.bytes)
    : baseLines
  const commandBaselineFields = new Set(commandBaselineMutations.map((mutation) => (
    `${mutation.field.toUpperCase()}:${normalizeHexByte(mutation.value) ?? ""}`
  )))
  const semanticPlan = commandBaselineMutations.length
    ? {
      ...plan,
      mutations: plan.mutations.filter((mutation) => (
        mutation.operation !== "replace" ||
        !commandBaselineFields.has(`${mutation.field.toUpperCase()}:${normalizeHexByte(mutation.value) ?? ""}`)
      )),
    }
    : plan
  const renderedFrames = selectPlannedBlockLines(
    applyCaseStepPlanToPacketLines(commandBaselineLines, semanticPlan, protocol),
    protocol,
    plan,
  )
  const transportEncoding = encodeCaseFrameTransport(renderedFrames, protocol)
  const generatedLines = transportEncoding.lines
  const zeroFallbackFieldPlans = unresolvedProtocolVariableFieldPlans(protocol, plan, semanticText)
  const defaultFieldPlans = documentedDtpBusFieldPlans(protocol, semanticText)
  const protocolName = cleanGeneratedDataFileBaseName(
    (protocol ? publishedProtocolDisplayName(
      protocol,
      input.protocolDefinitions,
      semanticText,
      plan.payload_length_bytes,
    ) : undefined) ??
      plan.protocol_name ?? plan.base_file_name?.replace(/\.txt$/i, "") ?? `step-${input.step.stepIndex}`,
  ) || `step-${input.step.stepIndex}`
  const fileName = caseStepDataFileName(
    input.step.stepIndex,
    protocolName,
    plan,
    getDtpProtocolFrames(protocol).length,
    planHasUnresolvedSemanticFault(plan, semanticCaseStepDescription(input.step.stepDescription) || semanticText, protocol) ||
      ambiguousCommandFieldWarnings(plan).length > 0,
  )
  const flowDirection = plan.flow_direction === "unknown" ? baseEntry?.flow_direction ?? "input" : plan.flow_direction
  const relativePath = join(flowDirectoryName(flowDirection), "\u7528\u4f8b\u751f\u6210", input.caseContext.caseId, fileName)
  const fullPath = join(input.inputDataRoot, relativePath)
  const robotPath = toRuntimeInputDataPath(relativePath)
  ensureDirectory(dirname(fullPath))
  writeFileSync(fullPath, `${generatedLines.map((line) => line.join(" ")).join("\n")}\n`, "utf-8")

  const generatedWarnings = uniqueStrings([
    ...plan.warnings,
    ...transportEncoding.warnings,
    ...defaultFieldPlans.map((field) => (
      `${field.field_name} defaulted to the first valid documented option ${field.value}; the step did not select an explicit option.`
    )),
    ...zeroFallbackFieldPlans.map((field) => `${field.field_name} value was unresolved; 00 fallback was used.`),
  ])
  appendDataFileIndexEntry(input.dataFileIndex, {
    id: createHash("sha256").update(`${input.caseContext.caseId}:${input.step.stepIndex}:${robotPath}`).digest("hex").slice(0, 20),
    protocol_name: plan.protocol_name ?? baseEntry?.protocol_name,
    requested_file_name: fileName,
    file_path: robotPath,
    absolute_file_path: fullPath,
    source: "dynamic-generated",
    source_documents: input.dataFileIndex.source_documents,
    generation_basis: uniqueStrings([
      "case-step-context",
      ...commandGenerationBasis(plan),
      ...plan.evidence_ids,
    ]),
    checksum_rule: baseEntry?.checksum_rule ?? getDtpPrimaryProtocolFrame(protocol)?.checksum?.expression ?? DEFAULT_CHECKSUM_RULE,
    field_value_plan: uniquePacketFieldValuePlans([
      ...(baseEntry?.field_value_plan ?? []),
      ...commandFieldPlans,
      ...defaultFieldPlans,
      ...zeroFallbackFieldPlans,
    ]),
    flow_direction: flowDirection,
    source_section: protocol?.source_section ?? baseEntry?.source_section,
    source_flow_heading: flowHeadingName(flowDirection),
    confidence: plan.confidence,
    state: "generated",
    warnings: generatedWarnings,
  })

  return {
    argument_name: argument.name,
    content_generation_required: true,
    requested_file_name: fileName,
    file_path: robotPath,
    generation_basis: uniqueStrings([
      "case-step-context",
      ...commandGenerationBasis(plan),
      ...plan.evidence_ids,
    ]),
    checksum_rule: baseEntry?.checksum_rule ?? getDtpPrimaryProtocolFrame(protocol)?.checksum?.expression ?? DEFAULT_CHECKSUM_RULE,
    field_value_plan: uniquePacketFieldValuePlans([
      ...(baseEntry?.field_value_plan ?? []),
      ...commandFieldPlans,
      ...defaultFieldPlans,
      ...zeroFallbackFieldPlans,
    ]),
    flow_direction: flowDirection,
    source_section: protocol?.source_section ?? baseEntry?.source_section,
    source_flow_heading: flowHeadingName(flowDirection),
    source_file_state: "generated-from-documents",
    variant_type: plan.variant_type,
    base_file_path: baseEntry?.file_path,
    format_notes: [
      `Generated case-specific ${plan.variant_type} variant.`,
      ...commandFormatNotes(plan),
      ...(transportEncoding.frameInformationBytes.length
        ? [`PeliCAN Frame Information: ${transportEncoding.frameInformationBytes.join(", ")}.`]
        : []),
      ...(transportEncoding.envelopeBytes.length
        ? [`Per-frame interface prefix: ${transportEncoding.envelopeBytes.join(" ")}.`]
        : []),
      ...generatedWarnings,
    ],
  }
}

function inspectCaseFrameTransport(
  rawLines: string[][],
  protocol: DtpProtocolDefinition,
  sequenceOperations: CaseStepSequenceOperation[] = [],
): { payloadLines: string[][]; issues: StepDataQualityIssue[] } {
  const envelope = protocol.frame_envelope
  if (envelope?.type === "fixed_prefix" && envelope.applies_per_frame) {
    const prefix = envelope.bytes.map(normalizeHexByte).filter((item): item is string => Boolean(item))
    const issues: StepDataQualityIssue[] = []
    const payloadLines = rawLines.map((line, index) => {
      if (line.length < prefix.length) {
        issues.push({ severity: "error", type: "frame_envelope_missing", message: `Frame ${index + 1} is shorter than its required interface prefix.` })
        return line
      }
      const actual = line.slice(0, prefix.length)
      if (actual.some((byte, byteIndex) => byte !== prefix[byteIndex])) {
        issues.push({
          severity: "error",
          type: "frame_envelope_mismatch",
          message: `Frame ${index + 1} interface prefix is ${actual.join(" ")}, expected ${prefix.join(" ")}.`,
        })
        return line
      }
      return line.slice(prefix.length)
    })
    return { payloadLines, issues }
  }
  return inspectDtpBusTransport(
    rawLines,
    protocol,
    renderedCanonicalFrameIndices(getDtpProtocolFrames(protocol).length, sequenceOperations),
  )
}

function explicitFaultIsolationIssues(
  stepText: string,
  lines: string[][],
  protocol: DtpProtocolDefinition,
  plan: CaseStepDataGenerationPlan,
): StepDataQualityIssue[] {
  if (!/其余字段正确/.test(stepText) || plan.sequence_operations.length) return []
  const frames = getDtpProtocolFrames(protocol)
  const semanticFaults = stepFieldMutations(stepText, frames.length)
  const faultMutations = canonicalizeCaseStepMutationFrames(protocol, semanticFaults.mutations)
    .filter((mutation) => mutation.operation !== "replace")
  if (!faultMutations.length) return []

  const canonicalLines = protocolBasePacketLines(protocol, stepText)
  if (canonicalLines.length !== lines.length) return []
  const baselinePlan: CaseStepDataGenerationPlan = {
    ...plan,
    variant_type: "correct",
    mutations: plan.mutations.filter((mutation) => mutation.operation === "replace"),
    sequence_operations: [],
    checksum_policy: protocolHasDeterministicSum(protocol) ? "recalculate_correctly" : "preserve",
  }
  const baselineLines = applyCaseStepPlanToPacketLines(canonicalLines, baselinePlan, protocol)
    .map((frame) => frame.bytes)
  const allowedOffsets = new Map<number, Set<number>>()
  for (const mutation of faultMutations) {
    for (const frameIndex of mutationTargetCanonicalFrameIndexes(mutation, protocol, lines.length)) {
      const frame = frames[frameIndex]
      const byteIndex = resolveCaseStepMutationIndex(
        mutation,
        frame?.byte_layout,
        lines[frameIndex]?.length ?? 0,
        frame?.field_layout,
      )
      if (byteIndex === undefined) continue
      const offsets = allowedOffsets.get(frameIndex) ?? new Set<number>()
      offsets.add(byteIndex)
      allowedOffsets.set(frameIndex, offsets)
    }
  }
  if (plan.checksum_policy === "recalculate_correctly" || plan.checksum_policy === "make_incorrect") {
    for (const [frameIndex, frame] of frames.entries()) {
      const offsets = allowedOffsets.get(frameIndex) ?? new Set<number>()
      for (const checksumField of frame.field_layout.filter((field) => field.role === "checksum")) {
        offsets.add(checksumField.byte_offset)
      }
      allowedOffsets.set(frameIndex, offsets)
    }
  }

  const unexpected: string[] = []
  for (const [frameIndex, line] of lines.entries()) {
    const baseline = baselineLines[frameIndex]
    if (!baseline || baseline.length !== line.length) continue
    for (const [byteIndex, value] of line.entries()) {
      if (value === baseline[byteIndex] || allowedOffsets.get(frameIndex)?.has(byteIndex)) continue
      unexpected.push(`frame ${frameIndex + 1} byte ${byteIndex}`)
    }
  }
  return unexpected.length
    ? [{
      severity: "error",
      type: "unexpected_field_mutation",
      message: `Step requires all non-target fields to remain correct, but unexpected changes were found at ${unexpected.join(", ")}.`,
    }]
    : []
}

function validateStepDataFile(
  input: BuildGeneratedStepInput,
  plan: CaseStepDataGenerationPlan | undefined,
  generatedDataFiles: GeneratedDataFile[],
): StepDataQualityResult {
  const issues: StepDataQualityIssue[] = []
  if (!plan || generatedDataFiles.length === 0) return { status: "pass", issues }
  const semanticText = caseStepSemanticText(input)
  const stepText = `${input.step.keywordName} ${semanticCaseStepDescription(input.step.stepDescription) || semanticText}`.trim()
  const exactEntry = findExactDataFileIndexEntry(
    input.dataFileIndex,
    extractRequestedFileNameSafe(input.step) ?? "",
    semanticText,
  )
  const protocolResolution = resolveProtocolForCasePlanResult(
    plan,
    input.protocolDefinitions,
    semanticText,
    stepText,
    input.protocolAnchorId,
  )
  const exactProtocol = findProtocolForDataFileEntry(
    input.protocolDefinitions,
    exactEntry,
    plan,
    semanticText,
    stepText,
    input.protocolAnchorId,
  )
  const exactEntryMatchesBlockProtocol = dataFileEntryMatchesSelectedProtocolBlock(
    exactEntry,
    protocolResolution.protocol,
    plan.selected_block,
  )
  const resolvedProtocol = exactProtocol ?? (
    !exactEntry || exactEntryMatchesBlockProtocol ? protocolResolution.protocol : undefined
  )
  const protocol = resolvedProtocol ? normalizeDtpProtocolDefinition(resolvedProtocol) : undefined
  for (const warning of plan.warnings) {
    if (/protocol name .* conflicts with the .* CAN injection interface/i.test(warning)) {
      issues.push({ severity: "error", type: "protocol_name_interface_conflict", message: warning })
    } else if (/protocol candidate .* outside the deterministic .* scope/i.test(warning)) {
      issues.push({ severity: "error", type: "protocol_candidate_out_of_scope", message: warning })
    } else if (/Protocol length remains ambiguous/i.test(warning)) {
      issues.push({ severity: "warning", type: "protocol_length_ambiguous", message: warning })
    } else if (/^Protocol default selected:/i.test(warning)) {
      issues.push({ severity: "warning", type: "protocol_default_selected", message: warning })
    } else if (/^Command default selected:/i.test(warning)) {
      issues.push({ severity: "warning", type: "command_default_selected", message: warning })
    } else if (/^Command field W\d+ has documented non-literal values and requires semantic selection:/i.test(warning)) {
      issues.push({ severity: "warning", type: "command_field_value_ambiguous", message: warning })
    } else if (/^Command field W\d+ is a bit field, but no documented reserved value is available/i.test(warning)) {
      issues.push({ severity: "warning", type: "command_field_value_ambiguous", message: warning })
    }
  }
  if (protocolResolution.selectedScopeConflicts.length) {
    issues.push({
      severity: "error",
      type: "interface_scope_conflict",
      message: protocolResolution.selectedScopeConflicts.join("; "),
    })
  }
  const frameSequenceIntent = frameSequenceIntentFromStep(
    stepText,
    protocol,
  )
  const semanticFaults = stepFieldMutations(
    stepText,
    protocol ? getDtpProtocolFrames(protocol).length : undefined,
  )
  const expectedSemanticMutations = scopeUnqualifiedProtocolFaults(
    protocol,
    canonicalizeCaseStepMutationFrames(protocol, semanticFaults.mutations),
  ).mutations
  if (protocol && fieldMutationClauses(stepText, getDtpProtocolFrames(protocol).length).some(clause => clause.invalidFrameTarget)) {
    issues.push({
      severity: "error",
      type: "semantic_fault_without_mutation",
      message: "The step targets a middle frame, but the canonical protocol has fewer than three frames; clarify the target frame.",
    })
  }
  issues.push(...validateDtpBusCasePlan(
    protocol,
    stepText,
    plan,
    caseProtocolBusConstraint(stepText, plan.bus) ?? "unknown",
  ))
  for (const expectedMutation of expectedSemanticMutations.filter((mutation) => mutation.operation !== "replace")) {
    const appliedByPlan = plan.mutations.some((mutation) => (
      mutation.field.toUpperCase() === expectedMutation.field.toUpperCase() &&
      mutation.frame_index === expectedMutation.frame_index &&
      mutation.operation !== "replace"
    ))
    if (!appliedByPlan) {
      issues.push({
        severity: "error",
        type: "semantic_fault_without_mutation",
        message: `${expectedMutation.field} is described as faulty, but the generation plan has no matching invalid mutation.`,
      })
    }
  }
  if (semanticFaults.variantType === "checksum_error" && plan.checksum_policy !== "make_incorrect") {
    issues.push({
      severity: "error",
      type: "semantic_fault_without_mutation",
      message: "SUM/CRC is described as faulty, but the generation plan does not make the checksum incorrect.",
    })
  }
  for (const expectedMutation of frameSequenceIntent.mutations) {
    const appliedByPlan = plan.mutations.some((mutation) => (
      /^(?:FRAME_SEQUENCE|FRAME_INDEX|SEQUENCE|INDEX)$/i.test(mutation.field) &&
      mutation.frame_index === expectedMutation.frame_index &&
      normalizeHexByte(mutation.value) === normalizeHexByte(expectedMutation.value)
    ))
    if (!appliedByPlan) {
      issues.push({
        severity: "error",
        type: "semantic_fault_without_mutation",
        message: `Frame ${expectedMutation.frame_index ?? "unknown"} sequence fault is not represented in the generation plan.`,
      })
    }
  }
  for (const expectedOperation of frameSequenceIntent.operations) {
    const appliedByPlan = plan.sequence_operations.some((operation) => (
      operation.operation === expectedOperation.operation &&
      operation.frame_index === expectedOperation.frame_index &&
      operation.other_frame_index === expectedOperation.other_frame_index &&
      (operation.repeat_count ?? 1) === (expectedOperation.repeat_count ?? 1)
    ))
    if (!appliedByPlan) {
      issues.push({
        severity: "error",
        type: "semantic_fault_without_mutation",
        message: `${expectedOperation.operation} for frame ${expectedOperation.frame_index ?? "unknown"} is missing from the generation plan.`,
      })
    }
  }
  const planHasFrameSequenceChange = plan.sequence_operations.length > 0 || plan.mutations.some((mutation) => (
    /^(?:FRAME_SEQUENCE|FRAME_INDEX|SEQUENCE|INDEX)$/i.test(mutation.field) && mutation.operation !== "replace"
  ))
  if (
    stepDescribesFrameSequenceFault(stepText) &&
    frameSequenceIntent.mutations.length === 0 &&
    frameSequenceIntent.operations.length === 0 &&
    !planHasFrameSequenceChange
  ) {
    issues.push({
      severity: "error",
      type: "semantic_fault_without_mutation",
      message: UNRESOLVED_FRAME_SEQUENCE_FAULT_MESSAGE,
    })
  }
  if (exactEntry) {
    const expectedKeys = new Set(uniqueStrings([
      normalizeLookupText(exactEntry.protocol_name),
      normalizeLookupText(exactEntry.requested_file_name),
    ]).filter(Boolean))
    const selectedKeys = uniqueStrings([
      normalizeLookupText(protocol?.base_file_name),
      normalizeLookupText(protocol?.protocol_id),
      normalizeLookupText(plan.protocol_id),
      normalizeLookupText(plan.protocol_name),
      normalizeLookupText(plan.base_file_name),
    ]).filter(Boolean)
    const exactEntryMatchesSelectedBlock = dataFileEntryMatchesSelectedProtocolBlock(
      exactEntry,
      protocol,
      plan.selected_block,
    )
    if (!exactEntryMatchesSelectedBlock && !selectedKeys.some((key) => expectedKeys.has(key))) {
      issues.push({
        severity: "error",
        type: "protocol_mismatch",
        message: `Step explicitly matches ${exactEntry.requested_file_name}, but the selected protocol is ${protocol?.base_file_name ?? plan.protocol_name ?? "unknown"}.`,
      })
    }
    if (
      exactEntry.flow_direction &&
      exactEntry.flow_direction !== "unknown" &&
      plan.flow_direction !== "unknown" &&
      exactEntry.flow_direction !== plan.flow_direction
    ) {
      issues.push({
        severity: "error",
        type: "flow_mismatch",
        message: `Step protocol belongs to ${exactEntry.flow_direction} flow, but the plan selected ${plan.flow_direction}.`,
      })
    }
  }
  const expectedPayloadLength = protocolResolution.constraints.payloadLengthBytes
  const selectedPayloadLength = protocol ? protocolPayloadLengthBytes(protocol) : undefined
  if (
    expectedPayloadLength !== undefined &&
    selectedPayloadLength !== undefined &&
    expectedPayloadLength !== selectedPayloadLength
  ) {
    issues.push({
      severity: "error",
      type: "protocol_length_mismatch",
      message: `Step requires a ${expectedPayloadLength}-byte protocol, but ${protocol?.protocol_id ?? "selected protocol"} defines ${selectedPayloadLength} bytes.`,
    })
  }
  if (!protocol && protocolResolution.ambiguous) {
    issues.push({
      severity: "error",
      type: "protocol_ambiguous",
      message: `Canonical protocol is ambiguous between: ${protocolResolution.candidateProtocolIds.join(", ")}.`,
    })
  } else if (!protocol) {
    issues.push({
      severity: "warning",
      type: "protocol_unresolved",
      message: "Canonical protocol could not be resolved; complete-frame and mutation assertions could not be fully verified.",
    })
  }
  const frames = protocol ? getDtpProtocolFrames(protocol) : []
  const layouts = frames.map((frame) => frame.byte_layout)
  const commandFieldPlans = commandDictionaryFieldPlans(plan, input.commandDictionaryIndex)
  if (protocol && plan.command) {
    for (const commandField of commandFieldPlans) {
      const fieldExists = frames.some((frame) => (
        resolvePlanFieldIndex(
          commandField.field_name,
          frame.byte_layout,
          frame.byte_layout.length,
          frame.field_layout,
        ) !== undefined
      ))
      if (!fieldExists) {
        issues.push({
          severity: "error",
          type: "command_field_unresolved",
          message: `Command ${plan.command.code} requires ${commandField.field_name}, but the selected protocol has no matching field.`,
        })
      }
    }
  }
  const exactBasePath = exactEntry?.absolute_file_path ?? (exactEntry?.file_path
    ? runtimeInputDataPathToAbsolute(input.inputDataRoot, exactEntry.file_path)
    : undefined)
  const exactBaseLines = exactBasePath ? readPacketLines(exactBasePath) : []
  const mentionedFrameCount = Array.from((input.step.stepDescription ?? "").matchAll(/第\s*(\d+)\s*帧/g))
    .reduce((maximum, match) => Math.max(maximum, Number.parseInt(match[1], 10)), 0)
  const declaredFrameCount = protocolResolution.constraints.declaredFrameCount
  const expectedRenderedFrameCount = protocol
    ? plan.artifact_scope === "single_block" && plan.selected_block
      ? 1
      : renderedCanonicalFrameIndices(frames.length, plan.sequence_operations).length
    : undefined
  if (
    declaredFrameCount !== undefined &&
    expectedRenderedFrameCount !== undefined &&
    declaredFrameCount !== expectedRenderedFrameCount
  ) {
    const canonicalLayoutWins = hasSignificantCanonicalFrameCountConflict(
      expectedRenderedFrameCount,
      declaredFrameCount,
    )
    issues.push({
      severity: canonicalLayoutWins ? "warning" : "error",
      type: "case_step_protocol_conflict",
      message: canonicalLayoutWins
        ? `Step declares ${declaredFrameCount} frame(s), but authoritative canonical protocol ${protocol?.protocol_id ?? "unknown"} produces ${expectedRenderedFrameCount}; canonical layout was retained.`
        : `Step declares ${declaredFrameCount} frame(s), but canonical protocol ${protocol?.protocol_id ?? "unknown"} produces ${expectedRenderedFrameCount} frame(s) after sequence operations.`,
    })
  }
  if (protocol && mentionedFrameCount > layouts.length) {
    issues.push({
      severity: "error",
      type: "frame_count_mismatch",
      message: `Step references ${mentionedFrameCount} frames, but the canonical protocol defines only ${layouts.length}.`,
    })
  }
  for (const file of generatedDataFiles) {
    const normalizedCasePath = file.file_path.replace(/[\\/]+/g, "\\").toLowerCase()
    const expectedCasePath = `用例生成\\${input.caseContext.caseId}`.toLowerCase()
    if (!normalizedCasePath.includes(expectedCasePath)) {
      issues.push({
        severity: "error",
        type: "flat_case_file_path",
        message: `Case-step data must be written below 用例生成\\${input.caseContext.caseId}, but got ${file.file_path}.`,
      })
    }
    if (file.source_file_state === "case-fallback") {
      issues.push({
        severity: "error",
        type: "case_data_fallback",
        message: `Canonical packet data was unavailable; ${file.file_path} is an unverified fallback and must not be treated as a valid executable packet.`,
      })
    }
    const fallbackFieldNames = compactFallbackFieldNames((file.field_value_plan ?? [])
      .filter((fieldPlan) => fieldPlan.value_source === "fallback-zero")
      .map((fieldPlan) => fieldPlan.field_name))
    if (fallbackFieldNames.length > 0) {
      issues.push({
        severity: "warning",
        type: "unresolved_field_zero_fallback",
        message: `${fallbackFieldNames.join(", ")} were unresolved and use 00 fallback in ${file.file_path}.`,
      })
    }
    const absolutePath = runtimeInputDataPathToAbsolute(input.inputDataRoot, file.file_path)
    const rawLines = readPacketLines(absolutePath)
    if (!rawLines.length) {
      issues.push({ severity: "error", type: "invalid_hex_content", message: `Generated data file has no valid hex packet lines: ${file.file_path}` })
      continue
    }
    const frameInformationInspection = protocol && file.source_file_state === "generated-from-documents"
      ? inspectCaseFrameTransport(rawLines, protocol, plan.sequence_operations)
      : { payloadLines: rawLines, issues: [] }
    const lines = frameInformationInspection.payloadLines
    issues.push(...frameInformationInspection.issues.map(issue => {
      if (!/^(?:dlc_mismatch|dlc_out_of_range)$/.test(issue.type) || !protocol || plan.sequence_operations.length) return issue
      const frameIndex = Number(issue.message.match(/^Frame (\d+) /)?.[1]) - 1
      const frame = frames[frameIndex]
      const controlIndex = frame ? resolvePlanFieldIndex("CONTROL", frame.byte_layout, frame.byte_layout.length, frame.field_layout) : undefined
      const requestedControlFault = expectedSemanticMutations.some(mutation => (
        /^(?:CONTROL|DLC)$/i.test(mutation.field) && mutation.operation !== "replace" &&
        mutationTargetCanonicalFrameIndexes(mutation, protocol).includes(frameIndex)
      ))
      const actualControl = controlIndex === undefined ? undefined : lines[frameIndex]?.[controlIndex]
      const normalControl = controlIndex === undefined ? undefined : frame?.byte_layout[controlIndex]
      if (!requestedControlFault || !normalControl || !normalizeHexByte(normalControl) ||
          !actualControl || actualControl === normalControl || lines[frameIndex]?.length !== frame?.byte_layout.length) return issue
      return { ...issue, severity: "warning" as const, message: `${issue.message} This mismatch is the explicitly requested control-field fault.` }
    }))
    if (protocol) issues.push(...explicitFaultIsolationIssues(stepText, lines, protocol, plan))
    if (frameSequenceIntent.declaredFrameCount && lines.length !== frameSequenceIntent.declaredFrameCount) {
      const canonicalLayoutWins = hasSignificantCanonicalFrameCountConflict(
        lines.length,
        frameSequenceIntent.declaredFrameCount,
      )
      issues.push({
        severity: canonicalLayoutWins ? "warning" : "error",
        type: "frame_count_mismatch",
        message: canonicalLayoutWins
          ? `Step declares ${frameSequenceIntent.declaredFrameCount} frames, but generated ${lines.length} from the authoritative canonical layout.`
          : `Step declares ${frameSequenceIntent.declaredFrameCount} frames, but generated ${lines.length}.`,
      })
    }
    if (protocol && !protocol.block_layout) {
      let expectedFrameCount = frames.length
      for (const operation of plan.sequence_operations) {
        if (operation.operation === "drop_frame" && (operation.frame_index ?? 0) <= expectedFrameCount) expectedFrameCount -= 1
        if (operation.operation === "repeat_frame") expectedFrameCount += operation.repeat_count ?? 1
        if (operation.operation === "append_frame") expectedFrameCount += 1
      }
      if (lines.length !== expectedFrameCount) {
        issues.push({
          severity: "error",
          type: "frame_count_mismatch",
          message: `Expected ${expectedFrameCount} packet frames after sequence operations, but generated ${lines.length}.`,
        })
      }
    }
    if (protocol) issues.push(...validateDtpBusGeneratedLines(protocol, lines, plan))
    if (protocol && !plan.sequence_operations.length && lines.length === layouts.length) {
      for (const [lineIndex, line] of lines.entries()) {
        if (line.length !== layouts[lineIndex].length) {
          issues.push({
            severity: "error",
            type: "frame_layout_mismatch",
            message: `Frame ${lineIndex + 1} has ${line.length} bytes, but the canonical layout requires ${layouts[lineIndex].length}.`,
          })
        }
      }
    }
    if (!protocol && exactBaseLines.length && !plan.sequence_operations.length) {
      if (lines.length !== exactBaseLines.length) {
        issues.push({
          severity: "error",
          type: "frame_count_mismatch",
          message: `Expected ${exactBaseLines.length} frame(s) from the exact indexed base file, but generated ${lines.length}.`,
        })
      } else {
        for (const [lineIndex, line] of lines.entries()) {
          if (line.length !== exactBaseLines[lineIndex].length) {
            issues.push({
              severity: "error",
              type: "frame_layout_mismatch",
              message: `Frame ${lineIndex + 1} has ${line.length} bytes, but the exact indexed base file has ${exactBaseLines[lineIndex].length}.`,
            })
          }
        }
      }
    }
    const expectedFlow = plan.flow_direction === "unknown" ? file.flow_direction : plan.flow_direction
    if (expectedFlow && !file.file_path.includes(flowDirectoryName(expectedFlow))) {
      issues.push({ severity: "error", type: "flow_mismatch", message: `Data file is not under the expected ${expectedFlow} flow directory.` })
    }
    if (!protocol?.block_layout && (plan.checksum_policy === "recalculate_correctly" || plan.checksum_policy === "make_incorrect")) {
      const checksumLines = plan.sequence_operations.length
        ? canonicalPacketLinesFromSequenceOutput(lines, layouts.length, plan.sequence_operations)
        : lines
      const checksumContexts = checksumLines
        ? resolvePacketChecksumContexts(checksumLines, layouts, frames)
        : []
      if (checksumContexts.length) {
        for (const [contextIndex, checksumContext] of checksumContexts.entries()) {
          const expected = expectedPacketChecksum(checksumLines as string[][], checksumContext)
          const actual = Number.parseInt(
            (checksumLines as string[][])[checksumContext.checksumFrameIndex][checksumContext.checksumByteIndex],
            16,
          )
          const shouldBeIncorrect = plan.checksum_policy === "make_incorrect" && contextIndex === 0
          if (!shouldBeIncorrect && actual !== expected) {
            issues.push({ severity: "error", type: "checksum_expected_correct", message: `SUM must be correct in ${file.file_path}, expected ${expected.toString(16).toUpperCase().padStart(2, "0")}.` })
          }
          if (shouldBeIncorrect && actual === expected) {
            issues.push({ severity: "error", type: "checksum_expected_incorrect", message: `SUM must be intentionally incorrect in ${file.file_path}.` })
          }
        }
      } else {
        issues.push({ severity: "warning", type: "missing_base_data", message: `Checksum positions could not be verified for ${file.file_path}.` })
      }
    }
    if (protocol && !plan.sequence_operations.length) {
      const canonicalLines = protocolBasePacketLines(protocol, stepText)
      for (const mutation of plan.mutations) {
        const targetFrames = mutationTargetCanonicalFrameIndexes(mutation, protocol, lines.length)
        for (const [frameIndex, line] of lines.entries()) {
          const canonicalFrameIndex = spaceWireBlockTemplateIndex(protocol, line, frameIndex)
          if (!targetFrames.includes(canonicalFrameIndex)) continue
          const layout = layouts[canonicalFrameIndex] ?? layouts[frameIndex]
          if (!line || !layout) continue
          const byteIndex = resolveCaseStepMutationIndex(
            mutation,
            layout,
            line.length,
            frames[canonicalFrameIndex]?.field_layout ?? frames[frameIndex]?.field_layout,
          )
          if (byteIndex === undefined || byteIndex >= line.length) {
            issues.push({ severity: "error", type: "mutation_not_applied", message: `${mutation.field} could not be located in frame ${frameIndex + 1}.` })
            continue
          }
          const explicitValue = normalizeHexByte(mutation.value)
          const mutationFields = declaredPlanFields(
            mutation.field,
            frames[canonicalFrameIndex]?.field_layout ?? frames[frameIndex]?.field_layout ?? [],
          )
          const mutationField = mutationFields.find((field) => field.name.toUpperCase() === mutation.field.toUpperCase()) ??
            mutationFields.find((field) => field.byte_offset === byteIndex)
          const applied = explicitValue && mutationField?.bit_offset !== undefined && mutationField.bit_length !== undefined
            ? ((Number.parseInt(line[byteIndex], 16) >> mutationField.bit_offset) & ((1 << mutationField.bit_length) - 1)) ===
              (Number.parseInt(explicitValue, 16) & ((1 << mutationField.bit_length) - 1))
            : explicitValue
              ? line[byteIndex] === explicitValue
              : line[byteIndex] !== canonicalLines[canonicalFrameIndex]?.[byteIndex]
          if (!applied) {
            issues.push({ severity: "error", type: "mutation_not_applied", message: `${mutation.field} was not applied to frame ${frameIndex + 1}.` })
          }
        }
      }
    }
  }
  const hasError = issues.some((issue) => issue.severity === "error")
  const hasWarning = issues.some((issue) => issue.severity === "warning")
  return { status: hasError ? "failed" : hasWarning ? "warning" : "pass", issues }
}

export function buildGeneratedStep(input: BuildGeneratedStepInput): GeneratedStep {
  const dataGenerationPlan = input.dataGenerationPlan
    ? normalizeDirectPlanChecksumPolicy(input, input.dataGenerationPlan)
    : undefined
  const effectiveInput = dataGenerationPlan === input.dataGenerationPlan
    ? input
    : { ...input, dataGenerationPlan }
  const { step, caseContext, keywordDef, inputDataRoot, knowledgeIndex, dataFileIndex, docsContext } = effectiveInput
  const resolvedArguments: ResolvedArgument[] = []
  const generatedDataFiles: GeneratedDataFile[] = []
  const warnings: string[] = []
  const traceNotes: TraceNote[] = []
  if (dataGenerationPlan) warnings.push(...dataGenerationPlan.warnings)

  for (const argumentDef of keywordDef.arguments) {
    if (argumentDef.name === "${time}") {
      if (step.timeValue === undefined || step.timeValue === null || step.timeValue === "") {
        warnings.push(`Missing ${argumentDef.name} for step ${step.stepIndex}`)
      } else {
        resolvedArguments.push({
          name: argumentDef.name,
          value: step.timeValue,
          semantic: "time",
          source: "confirmation-tests.json",
          required: true,
          confidence: 1,
          notes: ["The only upstream parameter value consumed directly."],
        })
        traceNotes.push({
          field: argumentDef.name,
          source: "confirmation-tests.json",
          detail: "The upstream case data is trusted only for ${time}.",
        })
      }
      continue
    }

    const activePlan = dataGenerationPlan
    const argumentSemantic = inferKeywordArgumentSemantic(keywordDef, argumentDef, dataGenerationPlan)
    if (
      activePlan?.operation === "memory_write" &&
      argumentSemantic === "target_address" &&
      activePlan.target_address
    ) {
      resolvedArguments.push({
        name: argumentDef.name,
        value: activePlan.target_address,
        semantic: argumentSemantic,
        source: "step-description-inference",
        required: true,
        confidence: 1,
        notes: ["Extracted deterministically from the memory-write step description."],
      })
      traceNotes.push({
        field: argumentDef.name,
        source: "step-description-inference",
        detail: `Resolved memory-write target address ${activePlan.target_address}.`,
      })
      continue
    }

    const inlineData = activePlan?.operation === "memory_write"
      ? extractInlineMemoryWriteData(step.stepDescription)
      : undefined
    if (inlineData && argumentSemantic === "file_path" && argumentSupportsInlineData(argumentDef)) {
      resolvedArguments.push({
        name: argumentDef.name,
        value: inlineData,
        semantic: "inline_data",
        source: "step-description-inference",
        required: true,
        confidence: 1,
        notes: ["Explicit hexadecimal data was passed inline instead of generating a file."],
      })
      traceNotes.push({
        field: argumentDef.name,
        source: "step-description-inference",
        detail: `Resolved inline memory-write data ${inlineData}.`,
      })
      continue
    }

    if (argumentLooksLikeFile(keywordDef, argumentDef, dataGenerationPlan)) {
      const generatedFile = dataGenerationPlan
        ? generateCaseSpecificDataFile(effectiveInput, argumentDef, dataGenerationPlan)
        : generateDataFile(
            {
              keywordName: step.keywordName,
              argument: argumentDef,
              requestedFileName: extractRequestedFileNameSafe(step),
              stepDescription: step.stepDescription,
              timeValue: step.timeValue,
              knowledgeIndex,
            },
            docsContext,
            inputDataRoot,
            dataFileIndex,
          )

      generatedDataFiles.push(generatedFile)
      resolvedArguments.push({
        name: argumentDef.name,
        value: generatedFile.file_path,
        semantic: "file_path",
        source: "generated-data-file",
        required: true,
        confidence: 0.6,
        notes: ["File arguments are regenerated from documents and business context."],
      })
      traceNotes.push({
        field: argumentDef.name,
        source: "generated-data-file",
        detail: "The upstream file hint is not trusted as an existing artifact.",
      })
      continue
    }

    const plannedValue = activePlan?.argument_values[argumentDef.name]
    if (activePlan && plannedValue !== undefined && plannedValue !== null && plannedValue !== "") {
      resolvedArguments.push({
        name: argumentDef.name,
        value: plannedValue,
        semantic: argumentSemantic,
        source: activePlan.source === "model-retry" ? "case-step-model-retry" : "case-step-plan",
        required: true,
        confidence: activePlan.confidence,
        notes: ["Derived from the case-step generation plan."],
      })
      traceNotes.push({
        field: argumentDef.name,
        source: "case-step-plan",
        detail: `Resolved by ${activePlan.source}.`,
      })
      continue
    }

    if (inferKeywordArgumentSemantic(keywordDef, argumentDef, dataGenerationPlan) === "protocol_name" && dataFileIndex) {
      const semanticText = semanticCaseStepDescription(step.stepDescription)
      const matchedDataFile = findDataFileIndexEntry(
        dataFileIndex,
        extractRequestedFileNameSafe(step) ?? "",
        semanticText,
      )
      if (matchedDataFile) {
        const protocolName = matchedDataFile.requested_file_name.replace(/\.txt$/i, "") ||
          matchedDataFile.protocol_name ||
          "unknown-protocol"
        generatedDataFiles.push({
          argument_name: argumentDef.name,
          content_generation_required: false,
          requested_file_name: matchedDataFile.requested_file_name,
          file_path: matchedDataFile.file_path,
          generation_basis: matchedDataFile.generation_basis,
          checksum_rule: matchedDataFile.checksum_rule,
          field_value_plan: matchedDataFile.field_value_plan,
          source_file_state: matchedDataFile.state === "validated" ? "existing-validated-file" : "generated-from-documents",
          format_notes: [`Resolved protocol argument from generated-data-files-index with confidence ${matchedDataFile.confidence}.`],
        })
        resolvedArguments.push({
          name: argumentDef.name,
          value: protocolName,
          semantic: "protocol_name",
          source: "generated-data-files-index",
          required: true,
          confidence: Math.max(0.75, matchedDataFile.confidence),
          notes: [
            `Matched data file: ${matchedDataFile.file_path}`,
            "Protocol-name arguments keep the protocol/file stem as the Robot argument value.",
          ],
        })
        traceNotes.push({
          field: argumentDef.name,
          source: "generated-data-files-index",
          detail: `Matched ${protocolName} from step context.`,
        })
        continue
      }
    }

    const inferred = inferArgumentValueFromDocsAndContext(argumentDef, step, caseContext, docsContext)
    if (!inferred) {
      warnings.push(`Unresolved argument ${argumentDef.name} for keyword ${step.keywordName}`)
      continue
    }

    resolvedArguments.push({
      name: argumentDef.name,
      value: inferred.value,
      semantic: inferred.semantic,
      source: inferred.source,
      required: true,
      confidence: inferred.value === "TODO" ? 0.2 : 0.7,
      notes: ["Derived instead of trusting upstream step parameters."],
    })
    traceNotes.push({
      field: argumentDef.name,
      source: inferred.source,
      detail: inferred.detail,
    })
  }

  const argumentQuality = validateGeneratedStepArguments({
    keywordDef,
    resolvedArguments,
    generatedDataFiles,
    inputDataRoot,
    dataGenerationPlan,
  })
  for (const issue of argumentQuality.issues) {
    warnings.push(`[${issue.severity}] ${issue.type}${issue.argument_name ? ` ${issue.argument_name}` : ""}: ${issue.message}`)
  }
  const dataQuality = validateStepDataFile(effectiveInput, dataGenerationPlan, generatedDataFiles)
  for (const issue of dataQuality.issues) {
    warnings.push(`[${issue.severity}] ${issue.type}: ${issue.message}`)
  }

  return {
    step_index: step.stepIndex,
    keyword_name: step.keywordName,
    step_description: step.stepDescription,
    expected_result: step.expectedResult,
    keyword_arguments: keywordDef.arguments,
    resolved_arguments: resolvedArguments,
    generated_data_files: generatedDataFiles,
    data_generation_plan: dataGenerationPlan,
    data_quality: dataQuality,
    argument_quality: argumentQuality,
    warnings,
    trace_notes: traceNotes,
  }
}

type CaseStepModelPlanningDecision = {
  required: boolean
  reasons: CaseStepModelTriggerReason[]
  skipped_reasons: string[]
}

const MODEL_FIXABLE_DATA_ISSUES = new Set<StepDataQualityIssue["type"]>([
  "command_field_unresolved",
  "mutation_not_applied",
  "semantic_fault_without_mutation",
])

const DETERMINISTIC_ARGUMENT_SEMANTICS = new Set([
  "time",
  "file_path",
  "protocol_name",
  "cycle_time",
  "data_id",
])

function classifyCaseStepModelPlanning(
  input: BuildGeneratedStepInput,
  plan: CaseStepDataGenerationPlan,
  generated: GeneratedStep,
): CaseStepModelPlanningDecision {
  const reasons: CaseStepModelTriggerReason[] = []
  const skippedReasons: string[] = []
  const semanticText = caseStepSemanticText(input)
  const stepText = semanticCaseStepDescription(input.step.stepDescription) || semanticText
  const resolution = resolveProtocolForCasePlanResult(
    plan,
    input.protocolDefinitions,
    semanticText,
    stepText,
    input.protocolAnchorId,
  )
  const protocol = resolution.protocol
  if (resolution.ambiguous) reasons.push("protocol_ambiguity")
  else if (!protocol) reasons.push("protocol_unresolved")

  const missingBusinessArguments = (generated.argument_quality?.issues ?? []).filter((issue) => {
    if (issue.severity !== "error" || issue.type !== "missing_argument" || !issue.argument_name) return false
    const argument = input.keywordDef.arguments.find((item) => item.name === issue.argument_name)
    if (!argument) return true
    const semantic = inferKeywordArgumentSemantic(input.keywordDef, argument, plan)
    return !semantic || !DETERMINISTIC_ARGUMENT_SEMANTICS.has(semantic)
  })
  if (missingBusinessArguments.length > 0) reasons.push("required_argument_unresolved")
  else if ((generated.argument_quality?.issues ?? []).some((issue) => issue.severity === "error")) {
    skippedReasons.push("argument_issues_are_structural_or_deterministic")
  }

  const unresolvedFields = unresolvedProtocolVariableFieldPlans(protocol, plan, semanticText)
  const targetFields = new Set(plan.mutations
    .filter((mutation) => mutation.operation !== "replace")
    .map((mutation) => mutation.field.toUpperCase()))
  if (unresolvedFields.some((field) => targetFields.has(field.field_name.toUpperCase()))) {
    reasons.push("target_field_unresolved")
  }
  if (unresolvedFields.some((field) => {
    const businessEvidence = [field.source_text, ...field.reasoning].filter(Boolean).join(" ")
    const hasBusinessEvidence = /(?:station|address|mode|command|code|opcode|enum|bit|状态|模式|指令|码字|站地址)/i.test(businessEvidence)
    return (
      (!/^(?:W|DATA)\d+$/i.test(field.field_name) || hasBusinessEvidence) &&
      /(?:station|address|mode|command|code|opcode|enum|bit|状态|模式|指令|码字|站地址)/i.test([
      field.field_name,
      field.source_text,
      ...field.reasoning,
    ].filter(Boolean).join(" "))
    )
  })) {
    reasons.push("business_value_unresolved")
  } else if (unresolvedFields.length > 0) {
    skippedReasons.push("only_non_target_zero_fallbacks")
  }
  if (plan.command && ambiguousCommandFieldWarnings(plan).length > 0) {
    reasons.push("business_value_unresolved")
    const skippedIndex = skippedReasons.indexOf("only_non_target_zero_fallbacks")
    if (skippedIndex >= 0) skippedReasons.splice(skippedIndex, 1)
  }

  const modelFixableIssues = (generated.data_quality?.issues ?? []).filter((issue) => (
    issue.severity === "error" &&
    MODEL_FIXABLE_DATA_ISSUES.has(issue.type) &&
    !(issue.type === "semantic_fault_without_mutation" && issue.message === UNRESOLVED_FRAME_SEQUENCE_FAULT_MESSAGE)
  ))
  if (modelFixableIssues.some((issue) => issue.type === "command_field_unresolved")) {
    reasons.push("business_value_unresolved")
  }
  if (modelFixableIssues.some((issue) => issue.type === "mutation_not_applied" || issue.type === "semantic_fault_without_mutation")) {
    reasons.push("target_field_unresolved")
  }
  const structuralErrors = (generated.data_quality?.issues ?? []).filter((issue) => (
    issue.severity === "error" && !modelFixableIssues.includes(issue)
  ))
  if (structuralErrors.length > 0) skippedReasons.push("structural_quality_issues_not_model_fixable")

  const uniqueReasons = uniqueStrings(reasons) as CaseStepModelTriggerReason[]
  if (uniqueReasons.length === 0 && skippedReasons.length === 0) {
    skippedReasons.push("deterministic_protocol_and_target_mutation")
  }
  return {
    required: uniqueReasons.length > 0,
    reasons: uniqueReasons,
    skipped_reasons: uniqueStrings(skippedReasons),
  }
}

function caseStepNeedsModelRetry(input: BuildGeneratedStepInput, generated: GeneratedStep): boolean {
  const plan = generated.data_generation_plan
  if (!plan?.model_used) return false
  const hasUnresolvedBusinessArgument = (generated.argument_quality?.issues ?? []).some((issue) => {
    if (issue.severity !== "error" || issue.type !== "missing_argument" || !issue.argument_name) return false
    const argument = input.keywordDef.arguments.find((item) => item.name === issue.argument_name)
    if (!argument) return true
    const semantic = inferKeywordArgumentSemantic(input.keywordDef, argument, plan)
    return !semantic || !DETERMINISTIC_ARGUMENT_SEMANTICS.has(semantic)
  })
  if (hasUnresolvedBusinessArgument) return true
  const dataIssues = generated.data_quality?.issues ?? []
  return dataIssues.some((issue) => (
    issue.severity === "error" &&
    (
      issue.type === "command_field_unresolved" ||
      issue.type === "mutation_not_applied" ||
      issue.type === "semantic_fault_without_mutation"
    )
  ))
}

function caseStepFilePrefix(stepIndex: number): string {
  return `S${String(stepIndex).padStart(2, "0")}-`
}

function cloneDataFileIndexForCaseStaging(
  index: GeneratedDataFileIndex,
  realInputDataRoot: string,
): GeneratedDataFileIndex {
  return {
    ...index,
    source_documents: [...index.source_documents],
    warnings: [...index.warnings],
    entries: index.entries.map((entry) => ({
      ...entry,
      absolute_file_path: entry.absolute_file_path ?? runtimeInputDataPathToAbsolute(realInputDataRoot, entry.file_path),
    })),
  }
}

function caseStepStagingInputRoot(input: BuildGeneratedStepInput): string {
  return join(
    input.inputDataRoot,
    ".case-work",
    sanitizeReadableFileBaseName(input.caseContext.caseId),
    caseStepFilePrefix(input.step.stepIndex).replace(/-$/, ""),
  )
}

function removeCaseStepDirectorySafely(inputDataRoot: string, target: string): void {
  const resolvedRoot = resolve(inputDataRoot)
  const resolvedTarget = resolve(target)
  if (!resolvedTarget.startsWith(`${resolvedRoot}${sep}`)) return
  rmSync(resolvedTarget, { recursive: true, force: true })
}

function removePublishedCaseStepFiles(input: BuildGeneratedStepInput): void {
  const prefix = caseStepFilePrefix(input.step.stepIndex)
  const casePathToken = `\u7528\u4f8b\u751f\u6210\\${input.caseContext.caseId}\\`.toLowerCase()
  for (const flowDirection of ["input", "output"] as const) {
    const caseDir = join(
      input.inputDataRoot,
      flowDirectoryName(flowDirection),
      "\u7528\u4f8b\u751f\u6210",
      input.caseContext.caseId,
    )
    if (!existsSync(caseDir)) continue
    for (const entry of readdirSync(caseDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.startsWith(prefix)) {
        rmSync(join(caseDir, entry.name), { force: true })
      }
    }
  }
  input.dataFileIndex.entries = input.dataFileIndex.entries.filter((entry) => {
    if (entry.source !== "dynamic-generated") return true
    const normalizedPath = entry.file_path.replace(/[\\/]+/g, "\\").toLowerCase()
    const fileName = normalizedPath.split("\\").at(-1) ?? normalizedPath
    return !(normalizedPath.includes(casePathToken) && fileName.startsWith(prefix.toLowerCase()))
  })
}

type PublishedCaseStepSnapshot = Array<{
  entry: GeneratedDataFileIndexEntry
  content: string
}>

function capturePublishedCaseStepFiles(input: BuildGeneratedStepInput): PublishedCaseStepSnapshot {
  const prefix = caseStepFilePrefix(input.step.stepIndex).toLowerCase()
  const casePathToken = `\u7528\u4f8b\u751f\u6210\\${input.caseContext.caseId}\\`.toLowerCase()
  return input.dataFileIndex.entries.flatMap((entry) => {
    if (entry.source !== "dynamic-generated") return []
    const normalizedPath = entry.file_path.replace(/[\\/]+/g, "\\").toLowerCase()
    const fileName = normalizedPath.split("\\").at(-1) ?? normalizedPath
    if (!normalizedPath.includes(casePathToken) || !fileName.startsWith(prefix)) return []
    const absolutePath = entry.absolute_file_path ?? runtimeInputDataPathToAbsolute(input.inputDataRoot, entry.file_path)
    if (!existsSync(absolutePath)) return []
    return [{
      entry: { ...entry, absolute_file_path: absolutePath },
      content: readFileSync(absolutePath, "utf-8"),
    }]
  })
}

function snapshotCanProtectPublishedStep(
  snapshot: PublishedCaseStepSnapshot,
  generated: GeneratedStep,
): boolean {
  if (!snapshot.length) return false
  const newResultIsLowerQuality = generated.data_quality?.status === "failed" ||
    generated.generated_data_files.some((file) => file.source_file_state === "case-fallback")
  if (!newResultIsLowerQuality) return false
  const variantLabel = caseStepVariantLabel(generated.data_generation_plan ?? {
    flow_direction: "unknown",
    variant_type: "unknown",
    mutations: [],
    sequence_operations: [],
    checksum_policy: "preserve",
    argument_values: {},
    evidence_ids: [],
    confidence: 0,
    warnings: [],
    source: "heuristic-fallback",
  })
  return snapshot.every(({ entry, content }) => {
    const contentLines = content.trim().split(/\r?\n/).filter(Boolean)
    const hasExecutableBytes = contentLines.length > 0 && contentLines.every((line) => (
      line.trim().split(/\s+/).every((token) => /^[0-9A-F]{2}$/i.test(token))
    )) && contentLines.some((line) => !/^00(?:\s+00)*$/i.test(line.trim()))
    return hasExecutableBytes &&
      !/\u5f85\u786e\u8ba4/.test(entry.requested_file_name) &&
      entry.requested_file_name.includes(variantLabel) &&
      !entry.warnings.some((warning) => /fallback|unverified|placeholder/i.test(warning))
  })
}

function restorePublishedCaseStepSnapshot(
  input: BuildGeneratedStepInput,
  snapshot: PublishedCaseStepSnapshot,
  generated: GeneratedStep,
): void {
  removePublishedCaseStepFiles(input)
  const replacementFiles: GeneratedDataFile[] = []
  for (const [index, item] of snapshot.entries()) {
    const absolutePath = item.entry.absolute_file_path ?? runtimeInputDataPathToAbsolute(input.inputDataRoot, item.entry.file_path)
    ensureDirectory(dirname(absolutePath))
    writeFileSync(absolutePath, item.content, "utf-8")
    appendDataFileIndexEntry(input.dataFileIndex, { ...item.entry, absolute_file_path: absolutePath })
    replacementFiles.push({
      argument_name: generated.generated_data_files[index]?.argument_name ?? generated.generated_data_files[0]?.argument_name ?? "${data_file}",
      content_generation_required: true,
      requested_file_name: item.entry.requested_file_name,
      file_path: item.entry.file_path,
      generation_basis: [...item.entry.generation_basis, "preserved-higher-quality-existing-step-output"],
      checksum_rule: item.entry.checksum_rule,
      field_value_plan: item.entry.field_value_plan,
      flow_direction: item.entry.flow_direction,
      source_section: item.entry.source_section,
      source_flow_heading: item.entry.source_flow_heading,
      source_file_state: item.entry.state === "validated" ? "existing-validated-file" : "generated-from-documents",
      variant_type: generated.data_generation_plan?.variant_type,
      format_notes: ["A lower-quality regenerated result was rejected; the existing executable step file was preserved."],
    })
  }
  generated.generated_data_files = replacementFiles
  for (const argument of generated.resolved_arguments) {
    const replacement = replacementFiles.find((file) => file.argument_name === argument.name)
    if (replacement) argument.value = replacement.file_path
  }
  const issue: StepDataQualityIssue = {
    severity: "warning",
    type: "publication_preserved",
    message: "A failed or fallback regeneration was not allowed to overwrite the existing executable step output.",
  }
  generated.data_quality = {
    status: "warning",
    issues: [...(generated.data_quality?.issues ?? []), issue],
  }
  generated.warnings = uniqueStrings([...generated.warnings, issue.message])
  generated.trace_notes.push({ field: "data_file", source: "existing-file", detail: issue.message })
}

function publishCaseStepGeneratedFiles(
  input: BuildGeneratedStepInput,
  stagingInputRoot: string,
  stagingDataFileIndex: GeneratedDataFileIndex,
  generated: GeneratedStep,
): void {
  removePublishedCaseStepFiles(input)
  for (const file of generated.generated_data_files) {
    if (!file.content_generation_required) continue
    const stagedPath = runtimeInputDataPathToAbsolute(stagingInputRoot, file.file_path)
    if (!existsSync(stagedPath)) continue
    const publishedPath = runtimeInputDataPathToAbsolute(input.inputDataRoot, file.file_path)
    ensureDirectory(dirname(publishedPath))
    copyFileSync(stagedPath, publishedPath)
    const stagedEntry = [...stagingDataFileIndex.entries].reverse().find((entry) => entry.file_path === file.file_path)
    if (stagedEntry) {
      appendDataFileIndexEntry(input.dataFileIndex, {
        ...stagedEntry,
        absolute_file_path: publishedPath,
        source_documents: [...stagedEntry.source_documents],
        generation_basis: [...stagedEntry.generation_basis],
        field_value_plan: stagedEntry.field_value_plan?.map((field) => ({
          ...field,
          reasoning: [...field.reasoning],
        })),
        warnings: [...stagedEntry.warnings],
      })
    }
  }
}

function withModelFallbackDiagnostics(
  plan: CaseStepDataGenerationPlan,
  planningInput: CaseStepDataPlanningInput,
  rawPlan: unknown,
): CaseStepDataGenerationPlan {
  const fallback = planningInput.model_fallback
  if (!fallback) return plan
  return {
    ...plan,
    evidence_ids: uniqueStrings([
      ...plan.evidence_ids,
      ...fallback.evidence.map((item) => item.id),
    ]),
    model_fallback: {
      profile_id: fallback.profile.profile_id,
      profile_version: fallback.profile.profile_version,
      profile_source: fallback.profile.source,
      profile_hash: fallback.profile.profile_hash,
      registry_hash: fallback.profile.registry_hash,
      classification: fallback.profile.classification,
      candidate_protocol_ids: fallback.candidate_protocols.map((candidate) => candidate.protocol_id),
      included_evidence_ids: fallback.evidence.map((item) => item.id),
      missing_evidence: fallback.missing_evidence,
      prompt_chars: fallback.prompt_chars,
      estimated_input_tokens: fallback.estimated_input_tokens,
      cache_hit: rawPlan === undefined
        ? undefined
        : isRecord(rawPlan) && rawPlan.__dtp_cache_hit === true,
    },
  }
}

function constrainModelPlanToFallbackCandidates(
  modelPlan: CaseStepDataGenerationPlan,
  fallbackPlan: CaseStepDataGenerationPlan,
  planningInput: CaseStepDataPlanningInput,
): CaseStepDataGenerationPlan {
  const fallback = planningInput.model_fallback
  if (!fallback) return modelPlan
  const candidateById = new Map(fallback.candidate_protocols.map((candidate) => [candidate.protocol_id, candidate]))
  const candidateFromName = modelPlan.protocol_name
    ? fallback.candidate_protocols.filter((candidate) => (
        [candidate.base_file_name, ...candidate.aliases]
          .some((name) => normalizeProtocolMatchText(name) === normalizeProtocolMatchText(modelPlan.protocol_name))
      ))
    : []
  const selectedProtocolId = modelPlan.protocol_id && candidateById.has(modelPlan.protocol_id)
    ? modelPlan.protocol_id
    : candidateFromName.length === 1
      ? candidateFromName[0].protocol_id
      : fallbackPlan.protocol_id && candidateById.has(fallbackPlan.protocol_id)
        ? fallbackPlan.protocol_id
        : undefined
  const rejectedSelection = Boolean(modelPlan.protocol_id && !candidateById.has(modelPlan.protocol_id))
  const unresolvedSelection = !selectedProtocolId && fallback.candidate_protocols.length > 0
  return {
    ...modelPlan,
    protocol_id: selectedProtocolId,
    protocol_name: selectedProtocolId
      ? candidateById.get(selectedProtocolId)?.base_file_name ?? modelPlan.protocol_name
      : fallbackPlan.protocol_name,
    warnings: uniqueStrings([
      ...modelPlan.warnings,
      ...(rejectedSelection
        ? [`Model-selected protocol ${modelPlan.protocol_id} is outside the supplied fallback candidates and was rejected.`]
        : []),
      ...(unresolvedSelection
        ? ["Model fallback did not select one supplied canonical protocol candidate."]
        : []),
    ]),
  }
}

export async function buildGeneratedStepWithPlanning(
  input: BuildGeneratedStepInput,
  modelHooks?: DtpDataModelHooks | null,
): Promise<GeneratedStep> {
  const deterministicPlanningInput = buildCaseStepDataPlanningInput(input, false)
  const publishedSnapshot = capturePublishedCaseStepFiles(input)
  removePublishedCaseStepFiles(input)
  const stagingInputRoot = caseStepStagingInputRoot(input)
  removeCaseStepDirectorySafely(input.inputDataRoot, stagingInputRoot)
  ensureDirectory(stagingInputRoot)
  const stagingDataFileIndex = cloneDataFileIndexForCaseStaging(input.dataFileIndex, input.inputDataRoot)
  const attemptInput: BuildGeneratedStepInput = {
    ...input,
    inputDataRoot: stagingInputRoot,
    dataFileIndex: stagingDataFileIndex,
  }
  try {
    let plan = inferHeuristicCaseStepDataPlan(input)
    plan = reconcileCaseStepDataPlan(input, plan)
    let planningInput = deterministicPlanningInput
    let generated = buildGeneratedStep({
      ...attemptInput,
      dataGenerationPlan: plan,
    })
    const planningDecision = classifyCaseStepModelPlanning(input, plan, generated)
    plan = {
      ...plan,
      model_trigger_reasons: planningDecision.reasons,
      model_skipped_reasons: planningDecision.skipped_reasons,
    }
    generated.data_generation_plan = plan
    const needsSupplementalPlanning = planningDecision.required
    if (needsSupplementalPlanning) {
      generated = buildGeneratedStep({
        ...attemptInput,
        dataGenerationPlan: plan,
      })
    }

    if (needsSupplementalPlanning && modelHooks?.planCaseStepData) {
      planningInput = buildCaseStepDataPlanningInput(input, true, plan)
      plan = {
        ...plan,
        evidence_ids: uniqueStrings(planningInput.model_fallback?.evidence.map((item) => item.id) ?? []),
        model_used: true,
        warnings: uniqueStrings([
          ...plan.warnings,
          ...(planningInput.model_fallback?.missing_evidence.length
            ? [`Model fallback profile ${planningInput.model_fallback.profile.profile_id} is missing evidence: ${planningInput.model_fallback.missing_evidence.join(", ")}.`]
            : []),
        ]),
      }
      plan = withModelFallbackDiagnostics(plan, planningInput, undefined)
      try {
        if (
          planningInput.model_fallback?.profile.missing_evidence_policy === "fail" &&
          planningInput.model_fallback.missing_evidence.length > 0
        ) {
          throw new Error(`Model fallback evidence policy rejected missing evidence: ${planningInput.model_fallback.missing_evidence.join(", ")}`)
        }
        const runPlanning = () => withTimeout(
          modelHooks.planCaseStepData!(planningInput),
          getDtpModelSectionTimeoutMs(),
          `DTP case-step planning timed out for ${input.caseContext.caseId} step ${input.step.stepIndex}`,
        )
        const rawPlan = modelHooks.performance
          ? await modelHooks.performance.measureModelCall("case_step_planning", planningInput, runPlanning)
          : await runPlanning()
        const constrainedPlan = constrainModelPlanToFallbackCandidates(
          sanitizeCaseStepDataPlan(rawPlan, plan, "model"),
          plan,
          planningInput,
        )
        plan = withModelFallbackDiagnostics({
          ...constrainedPlan,
          model_used: true,
        }, planningInput, rawPlan)
      } catch (error) {
        plan.warnings = uniqueStrings([...plan.warnings, `Case-step model planning failed; heuristic fallback was used: ${error instanceof Error ? error.message : String(error)}`])
      }
      plan = reconcileCaseStepDataPlan(input, plan)
      generated = buildGeneratedStep({
        ...attemptInput,
        dataGenerationPlan: plan,
      })
    }

    for (let attempt = 1; attempt <= DTP_CASE_STEP_RETRY_MAX_ATTEMPTS; attempt += 1) {
      const needsRetry = caseStepNeedsModelRetry(input, generated)
      if (!needsSupplementalPlanning || !needsRetry || !modelHooks?.reviseCaseStepDataPlan) break
      try {
        const retryInput: CaseStepDataPlanRetryInput = {
          planning_input: planningInput,
          current_plan: plan,
          argument_quality: generated.argument_quality as ArgumentQualityResult,
          data_quality: generated.data_quality as StepDataQualityResult,
          attempt,
        }
        const runRetry = () => withTimeout(
          modelHooks.reviseCaseStepDataPlan!(retryInput),
          getDtpCaseStepRetryTimeoutMs(),
          `DTP case-step retry timed out for ${input.caseContext.caseId} step ${input.step.stepIndex}`,
        )
        const retryPerformanceInput = {
          ...getRecord(compactCaseStepRetryInput(retryInput)),
          case_id: input.caseContext.caseId,
          step: { step_index: input.step.stepIndex },
        }
        const rawPlan = modelHooks.performance
          ? await modelHooks.performance.measureModelCall("case_step_retry", retryPerformanceInput, runRetry)
          : await runRetry()
        const constrainedPlan = constrainModelPlanToFallbackCandidates(
          sanitizeCaseStepDataPlan(rawPlan, plan, "model-retry"),
          plan,
          planningInput,
        )
        plan = reconcileCaseStepDataPlan(input, withModelFallbackDiagnostics({
          ...constrainedPlan,
          model_used: true,
        }, planningInput, rawPlan))
        generated = buildGeneratedStep({
          ...attemptInput,
          dataGenerationPlan: plan,
        })
      } catch (error) {
        generated.warnings.push(`Case-step retry ${attempt} failed: ${error instanceof Error ? error.message : String(error)}`)
        break
      }
    }
    if (snapshotCanProtectPublishedStep(publishedSnapshot, generated)) {
      restorePublishedCaseStepSnapshot(input, publishedSnapshot, generated)
    } else {
      publishCaseStepGeneratedFiles(input, stagingInputRoot, stagingDataFileIndex, generated)
    }
    return generated
  } finally {
    removeCaseStepDirectorySafely(input.inputDataRoot, stagingInputRoot)
  }
}

function generatedStepIntentSignature(step: GeneratedStep): string {
  const plan = step.data_generation_plan
  if (!plan) return "unplanned"
  return JSON.stringify({
    protocol_id: plan.protocol_id,
    payload_length_bytes: plan.payload_length_bytes,
    related_message_length_bytes: plan.related_message_length_bytes,
    variant_type: plan.variant_type,
    checksum_policy: plan.checksum_policy,
    sequence_operations: plan.sequence_operations,
    error_mutations: plan.mutations.filter((mutation) => mutation.operation !== "replace"),
  })
}

function flagSuspiciousDuplicateStepContent(steps: GeneratedStep[], inputDataRoot: string): void {
  const byHash = new Map<string, Array<{ step: GeneratedStep; intent: string; path: string }>>()
  for (const step of steps) {
    for (const file of step.generated_data_files) {
      const absolutePath = runtimeInputDataPathToAbsolute(inputDataRoot, file.file_path)
      if (!existsSync(absolutePath)) continue
      const hash = createHash("sha256").update(readFileSync(absolutePath)).digest("hex")
      const group = byHash.get(hash) ?? []
      group.push({ step, intent: generatedStepIntentSignature(step), path: file.file_path })
      byHash.set(hash, group)
    }
  }

  for (const group of byHash.values()) {
    const intents = uniqueStrings(group.map((item) => item.intent))
    if (group.length < 2 || intents.length < 2) continue
    const stepIndexes = group.map((item) => item.step.step_index).sort((left, right) => left - right)
    const correctItems = group.filter((item) => item.step.data_generation_plan?.variant_type === "correct")
    const nonCorrectItems = group.filter((item) => item.step.data_generation_plan?.variant_type !== "correct")
    const suspiciousItems = correctItems.length && nonCorrectItems.length
      ? nonCorrectItems
      : group
    for (const item of suspiciousItems) {
      const issue: StepDataQualityIssue = {
        severity: "error",
        type: "suspicious_duplicate_content",
        message: `Steps ${stepIndexes.join(", ")} have different generation intents but identical data-file content.`,
      }
      item.step.data_quality ??= { status: "pass", issues: [] }
      item.step.data_quality.issues.push(issue)
      item.step.data_quality.status = "failed"
      item.step.warnings.push(`[error] ${issue.type}: ${issue.message}`)
    }
  }
}

function writeJsonAtomically(outputFile: string, value: unknown): void {
  ensureDirectory(dirname(outputFile))
  const temporaryFile = `${outputFile}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(temporaryFile, `${JSON.stringify(value)}\n`, "utf-8")
    readJsonFile(temporaryFile)
    renameSync(temporaryFile, outputFile)
  } finally {
    rmSync(temporaryFile, { force: true })
  }
}

function generatedCaseArtifactName(caseId: string): string {
  const sanitized = caseId.trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
  if (sanitized && sanitized === caseId.trim()) return `${sanitized}.json`
  const hash = createHash("sha256").update(caseId).digest("hex").slice(0, 8)
  return `${sanitized || "case"}-${hash}.json`
}

function generatedArtifactPaths(outputFile: string): {
  diagnosticsIndexFile: string
  caseCheckpointDir: string
  caseDiagnosticsDir: string
} {
  const artifactDir = dirname(outputFile)
  return {
    diagnosticsIndexFile: join(artifactDir, "generated-test-data-diagnostics.json"),
    caseCheckpointDir: join(artifactDir, "cases"),
    caseDiagnosticsDir: join(artifactDir, "diagnostics"),
  }
}

function compactRuntimeStepWarnings(step: GeneratedStep, caseId: string): string[] {
  const issueCounts = new Map<string, number>()
  for (const issue of step.data_quality?.issues ?? []) {
    const key = `${issue.severity}:${issue.type}`
    issueCounts.set(key, (issueCounts.get(key) ?? 0) + 1)
  }
  for (const issue of step.argument_quality?.issues ?? []) {
    const key = `${issue.severity}:argument_${issue.type}`
    issueCounts.set(key, (issueCounts.get(key) ?? 0) + 1)
  }
  const summaries = Array.from(issueCounts.entries()).map(([key, count]) => `${key}(${count})`)
  if (!summaries.length && !step.warnings.length) return []
  const details = `diagnostics/${generatedCaseArtifactName(caseId)}#step-${step.step_index}`
  if (!summaries.length) return [`${step.warnings.length} generation warning(s); details: ${details}`]
  return [`Generation diagnostics: ${summaries.join(", ")}; details: ${details}`]
}

function projectGeneratedRuntimeCase(testCase: GeneratedCase): GeneratedRuntimeCase {
  return {
    case_id: testCase.case_id,
    translate_status: "success",
    case_name: testCase.case_name,
    test_purpose: testCase.test_purpose,
    test_environment: testCase.test_environment,
    generated_steps: testCase.generated_steps.map((step) => ({
      step_index: step.step_index,
      keyword_name: step.keyword_name,
      step_description: step.step_description,
      resolved_arguments: step.resolved_arguments.map((argument) => ({
        name: argument.name,
        value: argument.value,
        semantic: argument.semantic,
      })),
      generated_data_files: step.generated_data_files.map((file) => ({
        argument_name: file.argument_name,
        content_generation_required: file.content_generation_required,
        requested_file_name: file.requested_file_name,
        file_path: file.file_path,
        flow_direction: file.flow_direction,
        variant_type: file.variant_type,
      })),
      warnings: compactRuntimeStepWarnings(step, testCase.case_id),
    })),
    warnings: uniqueStrings(testCase.warnings),
  }
}

function projectGeneratedRuntimeData(outputFile: string, result: GeneratedTestData): GeneratedRuntimeTestData {
  const artifacts = generatedArtifactPaths(outputFile)
  return {
    schema_version: "1.1.0",
    project_name: result.project_name,
    source_files: {
      ...result.source_files,
      generated_test_data_file: outputFile,
      diagnostics_index: artifacts.diagnosticsIndexFile,
      case_checkpoint_dir: artifacts.caseCheckpointDir,
      case_diagnostics_dir: artifacts.caseDiagnosticsDir,
    },
    diagnostics: {
      index_file: artifacts.diagnosticsIndexFile,
      case_checkpoint_dir: artifacts.caseCheckpointDir,
      case_diagnostics_dir: artifacts.caseDiagnosticsDir,
    },
    cases: result.cases.map(projectGeneratedRuntimeCase),
    warnings: uniqueStrings(result.warnings),
  }
}

function generatedCaseQualityCounts(testCase: GeneratedCase): {
  passed_steps: number
  warning_steps: number
  failed_steps: number
} {
  const counts = { passed_steps: 0, warning_steps: 0, failed_steps: 0 }
  for (const step of testCase.generated_steps) {
    const statuses = [step.data_quality?.status ?? "pass", step.argument_quality?.status ?? "pass"]
    const status = statuses.includes("failed") ? "failed" : statuses.includes("warning") ? "warning" : "pass"
    if (status === "failed") counts.failed_steps += 1
    else if (status === "warning") counts.warning_steps += 1
    else counts.passed_steps += 1
  }
  return counts
}

function buildGeneratedDiagnosticsIndex(outputFile: string, result: GeneratedTestData): GeneratedTestDataDiagnosticsIndex {
  const artifacts = generatedArtifactPaths(outputFile)
  const cases = result.cases.map((testCase) => {
    const counts = generatedCaseQualityCounts(testCase)
    const fileName = generatedCaseArtifactName(testCase.case_id)
    return {
      case_id: testCase.case_id,
      diagnostic_file: join(artifacts.caseDiagnosticsDir, fileName),
      checkpoint_file: join(artifacts.caseCheckpointDir, fileName),
      step_count: testCase.generated_steps.length,
      ...counts,
    }
  })
  return {
    schema_version: "1.0.0",
    source_data_file: outputFile,
    project_root: result.source_files.project_root,
    summary: {
      case_count: cases.length,
      step_count: cases.reduce((sum, item) => sum + item.step_count, 0),
      passed_steps: cases.reduce((sum, item) => sum + item.passed_steps, 0),
      warning_steps: cases.reduce((sum, item) => sum + item.warning_steps, 0),
      failed_steps: cases.reduce((sum, item) => sum + item.failed_steps, 0),
    },
    cases,
    warnings: uniqueStrings(result.warnings),
    updated_at: new Date().toISOString(),
  }
}

function writeGeneratedCaseArtifacts(outputFile: string, projectRoot: string, testCase: GeneratedCase): void {
  const artifacts = generatedArtifactPaths(outputFile)
  const fileName = generatedCaseArtifactName(testCase.case_id)
  writeJsonAtomically(join(artifacts.caseCheckpointDir, fileName), {
    schema_version: "1.1.0",
    project_root: projectRoot,
    case: projectGeneratedRuntimeCase(testCase),
  })
  writeJsonAtomically(join(artifacts.caseDiagnosticsDir, fileName), {
    schema_version: "1.0.0",
    project_root: projectRoot,
    case: testCase,
  })
}

function writeGeneratedDiagnosticsIndex(outputFile: string, result: GeneratedTestData): void {
  const artifacts = generatedArtifactPaths(outputFile)
  writeJsonAtomically(artifacts.diagnosticsIndexFile, buildGeneratedDiagnosticsIndex(outputFile, result))
}

function writeGeneratedRuntimeData(outputFile: string, result: GeneratedTestData): void {
  writeGeneratedDiagnosticsIndex(outputFile, result)
  const runtime = projectGeneratedRuntimeData(outputFile, result)
  writeJsonAtomically(outputFile, runtime)
  const parsed = readJsonFile(outputFile)
  if (
    !isRecord(parsed) ||
    parsed.schema_version !== "1.1.0" ||
    !isRecord(parsed.source_files) ||
    !Array.isArray(parsed.cases) ||
    !parsed.cases.every((testCase) =>
      isRecord(testCase) &&
      typeof testCase.case_id === "string" &&
      testCase.translate_status === "success" &&
      Array.isArray(testCase.generated_steps)
    )
  ) {
    throw new Error("generated-test-data.json failed structural validation")
  }
}

export function writeGeneratedTestData(outputFile: string, result: GeneratedTestData): void {
  for (const testCase of result.cases) {
    writeGeneratedCaseArtifacts(outputFile, result.source_files.project_root, testCase)
  }
  writeGeneratedRuntimeData(outputFile, result)
}

function restoreGeneratedStep(value: unknown): GeneratedStep | null {
  if (!isRecord(value)) return null
  const stepIndex = asNumber(value.step_index)
  const keywordName = asString(value.keyword_name)
  if (!stepIndex || !keywordName) return null
  const resolvedArguments = getNestedArray(value, ["resolved_arguments"])
    .filter(isRecord)
    .map((argument) => ({
      name: asString(argument.name) ?? "",
      value: typeof argument.value === "string" || typeof argument.value === "number" || typeof argument.value === "boolean"
        ? argument.value
        : "",
      semantic: asString(argument.semantic),
      source: asString(argument.source) ?? "runtime-contract",
    }))
    .filter((argument) => Boolean(argument.name))
  const generatedDataFiles = getNestedArray(value, ["generated_data_files"])
    .filter(isRecord)
    .map((file) => ({
      argument_name: asString(file.argument_name) ?? "",
      content_generation_required: file.content_generation_required === true,
      requested_file_name: asString(file.requested_file_name) ?? "",
      file_path: asString(file.file_path) ?? "",
      generation_basis: getNestedArray(file, ["generation_basis"])
        .map((item) => asString(item))
        .filter((item): item is string => Boolean(item)),
      flow_direction: normalizePlanFlowDirection(asString(file.flow_direction)),
      variant_type: normalizeCaseStepVariant(asString(file.variant_type)),
    }))
    .filter((file) => Boolean(file.file_path || file.requested_file_name))
  return {
    step_index: stepIndex,
    keyword_name: keywordName,
    step_description: asString(value.step_description),
    expected_result: asString(value.expected_result),
    keyword_arguments: getNestedArray(value, ["keyword_arguments"]) as KeywordArgumentDef[],
    resolved_arguments: resolvedArguments,
    generated_data_files: generatedDataFiles,
    data_generation_plan: isRecord(value.data_generation_plan)
      ? value.data_generation_plan as CaseStepDataGenerationPlan
      : undefined,
    data_quality: isRecord(value.data_quality) ? value.data_quality as StepDataQualityResult : undefined,
    argument_quality: isRecord(value.argument_quality) ? value.argument_quality as ArgumentQualityResult : undefined,
    warnings: getNestedArray(value, ["warnings"])
      .map((warning) => asString(warning))
      .filter((warning): warning is string => Boolean(warning)),
    trace_notes: getNestedArray(value, ["trace_notes"]) as TraceNote[],
  }
}

function restoreGeneratedCase(value: unknown): GeneratedCase | null {
  if (!isRecord(value)) return null
  const caseId = asString(value.case_id)
  if (!caseId || value.translate_status !== "success") return null
  return {
    case_id: caseId,
    translate_status: "success",
    case_name: asString(value.case_name),
    test_purpose: asString(value.test_purpose),
    test_environment: asString(value.test_environment),
    generated_steps: getNestedArray(value, ["generated_steps"])
      .map(restoreGeneratedStep)
      .filter((step): step is GeneratedStep => Boolean(step)),
    warnings: getNestedArray(value, ["warnings"])
      .map((warning) => asString(warning))
      .filter((warning): warning is string => Boolean(warning)),
  }
}

function loadGeneratedDiagnosticCases(caseDiagnosticsDir: string, workspaceRoot: string): GeneratedCase[] {
  if (!existsSync(caseDiagnosticsDir)) return []
  const cases: GeneratedCase[] = []
  for (const fileName of readdirSync(caseDiagnosticsDir).filter((item) => item.toLowerCase().endsWith(".json"))) {
    try {
      const parsed = readJsonFile(join(caseDiagnosticsDir, fileName))
      if (!isRecord(parsed) || asString(parsed.project_root) !== workspaceRoot) continue
      const testCase = restoreGeneratedCase(parsed.case)
      if (testCase) cases.push(testCase)
    } catch {
      // Ignore incomplete case checkpoints; the todo list will regenerate them.
    }
  }
  return cases
}

function loadGeneratedTestDataForResume(outputFile: string, workspaceRoot: string): GeneratedTestData | null {
  if (!existsSync(outputFile)) return null
  try {
    const parsed = readJsonFile(outputFile)
    if (
      !isRecord(parsed) ||
      !["1.0.0", "1.1.0"].includes(asString(parsed.schema_version) ?? "") ||
      !isRecord(parsed.source_files) ||
      asString(parsed.source_files.project_root) !== workspaceRoot ||
      !Array.isArray(parsed.cases)
    ) {
      return null
    }
    const casesById = new Map<string, GeneratedCase>()
    for (const rawCase of parsed.cases) {
      const testCase = restoreGeneratedCase(rawCase)
      if (testCase) casesById.set(testCase.case_id, testCase)
    }
    const diagnosticsDir = asString(parsed.source_files.case_diagnostics_dir) ??
      generatedArtifactPaths(outputFile).caseDiagnosticsDir
    for (const testCase of loadGeneratedDiagnosticCases(diagnosticsDir, workspaceRoot)) {
      casesById.set(testCase.case_id, testCase)
    }
    return {
      schema_version: "1.0.0",
      project_name: asString(parsed.project_name),
      source_files: {
        todo_file: asString(parsed.source_files.todo_file) ?? "",
        confirmation_tests_file: asString(parsed.source_files.confirmation_tests_file) ?? "",
        keyword_dir: asString(parsed.source_files.keyword_dir) ?? "",
        generated_data_files_index: asString(parsed.source_files.generated_data_files_index),
        argument_retry_context: asString(parsed.source_files.argument_retry_context),
        generated_test_data_file: outputFile,
        diagnostics_index: asString(parsed.source_files.diagnostics_index),
        case_checkpoint_dir: asString(parsed.source_files.case_checkpoint_dir),
        case_diagnostics_dir: diagnosticsDir,
        project_root: workspaceRoot,
      },
      cases: Array.from(casesById.values()),
      warnings: getNestedArray(parsed, ["warnings"])
        .map((warning) => asString(warning))
        .filter((warning): warning is string => Boolean(warning)),
    }
  } catch {
    return null
  }
}

function cleanCaseGeneratedDataDirectories(inputDataRoot: string, caseIds: string[]): void {
  for (const flowDirection of ["input", "output"] as const) {
    const generatedRoot = resolve(inputDataRoot, flowDirectoryName(flowDirection), "\u7528\u4f8b\u751f\u6210")
    for (const caseId of caseIds) {
      const target = resolve(generatedRoot, caseId)
      if (target !== generatedRoot && target.startsWith(`${generatedRoot}${sep}`)) {
        rmSync(target, { recursive: true, force: true })
      }
    }
  }
}

function cleanCaseGeneratedData(
  inputDataRoot: string,
  caseIds: string[],
  dataFileIndex: GeneratedDataFileIndex,
): void {
  const caseIdSet = new Set(caseIds)
  cleanCaseGeneratedDataDirectories(inputDataRoot, caseIds)
  dataFileIndex.entries = dataFileIndex.entries.filter((entry) => {
    if (entry.source !== "dynamic-generated") return true
    const segments = entry.file_path.split(/[\\/]/).filter(Boolean)
    const generatedIndex = segments.indexOf("\u7528\u4f8b\u751f\u6210")
    return generatedIndex < 0 || !caseIdSet.has(segments[generatedIndex + 1] ?? "")
  })
}

function cleanGeneratedCaseArtifacts(outputFile: string, caseIds: string[]): void {
  const artifacts = generatedArtifactPaths(outputFile)
  for (const caseId of caseIds) {
    const fileName = generatedCaseArtifactName(caseId)
    rmSync(join(artifacts.caseCheckpointDir, fileName), { force: true })
    rmSync(join(artifacts.caseDiagnosticsDir, fileName), { force: true })
    rmSync(join(dirname(outputFile), "generated-data-files-index-cases", fileName), { force: true })
  }
}

function candidateDataFilesForStep(
  step: GeneratedStep,
  dataFileIndex: GeneratedDataFileIndex,
): ArgumentRetryContext["cases"][number]["steps"][number]["candidate_data_files"] {
  const semanticText = semanticCaseStepDescription(step.step_description)
  const semanticKey = normalizeProtocolMatchText(semanticText)
  const directCandidates = step.generated_data_files
    .map((file) => dataFileIndex.entries.find((entry) => entry.file_path === file.file_path || entry.requested_file_name === file.requested_file_name))
    .filter((entry): entry is GeneratedDataFileIndexEntry => Boolean(entry))
  const semanticCandidates = dataFileIndex.entries
    .filter((entry) => {
      if (!semanticKey) return false
      const entryKey = normalizeProtocolMatchText([entry.protocol_name, entry.requested_file_name].filter(Boolean).join(" "))
      return Boolean(entryKey && (semanticKey.includes(entryKey) || entryKey.includes(semanticKey) || longestCommonSubstringLength(semanticKey, entryKey) >= 6))
    })

  return uniqueStrings([...directCandidates, ...semanticCandidates, ...dataFileIndex.entries.slice(0, 12)]
    .map((entry) => entry.file_path))
    .map((filePath) => dataFileIndex.entries.find((entry) => entry.file_path === filePath))
    .filter((entry): entry is GeneratedDataFileIndexEntry => Boolean(entry))
    .slice(0, 20)
    .map((entry) => ({
      requested_file_name: entry.requested_file_name,
      file_path: entry.file_path,
      protocol_name: entry.protocol_name,
      confidence: entry.confidence,
      state: entry.state,
    }))
}

function buildArgumentRetryContext(
  result: GeneratedTestData,
  dataFileIndex: GeneratedDataFileIndex,
): ArgumentRetryContext {
  const cases = result.cases
    .map((testCase) => ({
      case_id: testCase.case_id,
      case_name: testCase.case_name,
      test_purpose: testCase.test_purpose,
      steps: testCase.generated_steps
        .filter((step) => step.argument_quality && step.argument_quality.status !== "pass")
        .map((step) => ({
          step_index: step.step_index,
          keyword_name: step.keyword_name,
          step_description: step.step_description,
          argument_quality: step.argument_quality as ArgumentQualityResult,
          keyword_arguments: step.keyword_arguments ?? [],
          resolved_arguments: step.resolved_arguments,
          generated_data_files: step.generated_data_files,
          data_generation_plan: step.data_generation_plan,
          data_quality: step.data_quality,
          candidate_data_files: candidateDataFilesForStep(step, dataFileIndex),
        })),
    }))
    .filter((testCase) => testCase.steps.length > 0)

  const failedStepCount = cases.reduce((sum, testCase) => sum + testCase.steps.length, 0)
  return {
    schema_version: "1.0.0",
    status: failedStepCount ? "ready" : "not_needed",
    source_data_file: result.source_files.confirmation_tests_file,
    generated_data_files_index_file: result.source_files.generated_data_files_index ?? "",
    cases,
    warnings: failedStepCount
      ? [
          `Argument retry context contains ${failedStepCount} step(s) with parameter quality issues.`,
          "Use this JSON as the bounded input for local parameter repair; do not regenerate unaffected cases.",
        ]
      : [],
    updated_at: new Date().toISOString(),
  }
}

function writeArgumentRetryContext(outputFile: string, context: ArgumentRetryContext): void {
  ensureDirectory(dirname(outputFile))
  writeFileSync(outputFile, `${JSON.stringify(context, null, 2)}\n`, "utf-8")
}

export async function runDtpCaseDataInstantiation(
  workspaceRoot: string,
  docsContext: DocsContext,
  modelHooks?: DtpDataModelHooks | null,
  preparedProtocols?: EnsureDtpProtocolDefinitionsResult,
  options: DtpDataGenerationOptions = {},
): Promise<GeneratedTestData> {
  const paths = resolveDefaultPaths(workspaceRoot)
  const performance = createDtpDataGenerationPerformanceCollector(paths)
  const caseIds = loadTodoCaseIds(paths.todoFile)
  const confirmationCases = loadConfirmationCasesWithStatus(paths.confirmationFile)
  const caseIndex = confirmationCases.cases
  const skippedCaseIds = Array.from(confirmationCases.skippedCases.keys())
  const cleanupCaseIds = uniqueStrings([...caseIds, ...skippedCaseIds])
  rmSync(join(paths.dtpArtifactsDir, "dtp-requirement-context-index.json"), { force: true })

  const eligibleCaseIds = caseIds.filter((caseId) => caseIndex.has(caseId))
  if (eligibleCaseIds.length === 0) {
    const warnings = [
      ...caseIds.map((caseId) => {
        const skippedCase = confirmationCases.skippedCases.get(caseId)
        return skippedCase
          ? `Case ${caseId} skipped because ${skippedCase.reason}.`
          : `Case not found: ${caseId}`
      }),
      "No executable confirmation cases remain after translate_status and test_environment filtering.",
    ]
    const emptyResult: GeneratedTestData = {
      schema_version: "1.0.0",
      project_name: workspaceRoot.split(/[\\/]/).filter(Boolean).pop(),
      source_files: {
        todo_file: paths.todoFile,
        confirmation_tests_file: paths.confirmationFile,
        keyword_dir: paths.keywordDir ?? "",
        generated_data_files_index: paths.generatedDataFilesIndexFile,
        argument_retry_context: paths.generatedArgumentRetryContextFile,
        generated_test_data_file: paths.generatedDataFile,
        diagnostics_index: paths.generatedDiagnosticsIndexFile,
        case_checkpoint_dir: paths.generatedCasesDir,
        case_diagnostics_dir: paths.generatedDiagnosticsDir,
        performance_report: paths.dtpCasePerformanceReportFile,
        project_root: workspaceRoot,
      },
      cases: [],
      warnings: uniqueStrings(warnings),
    }
    const previousResult = loadGeneratedTestDataForResume(paths.generatedDataFile, workspaceRoot)
    const allCleanupCaseIds = uniqueStrings([
      ...cleanupCaseIds,
      ...(previousResult?.cases.map((testCase) => testCase.case_id) ?? []),
    ])
    const dataFileIndex = loadGeneratedDataFileIndex(paths.generatedDataFilesIndexFile, paths, options)
    cleanCaseGeneratedData(paths.inputDataRoot, allCleanupCaseIds, dataFileIndex)
    writeGeneratedDataFileIndex(paths.generatedDataFilesIndexFile, dataFileIndex)
    cleanGeneratedCaseArtifacts(paths.generatedDataFile, allCleanupCaseIds)
    writeGeneratedTestData(paths.generatedDataFile, emptyResult)
    performance.finalize({ warnings: emptyResult.warnings })
    performance.write(paths.dtpCasePerformanceReportFile)
    return emptyResult
  }

  if (!paths.keywordDir) {
    throw new Error(`Keyword directory not found under ${paths.dtpRoot}`)
  }

  const cachedModelHooks = createCachedDtpDataModelHooks(
    paths,
    modelHooks ? { ...modelHooks, performance } : null,
  )
  const protocolPreparation = preparedProtocols ??
    await ensureDtpProtocolDefinitions(workspaceRoot, docsContext, cachedModelHooks, {
      scope: "case",
      case_queries: collectDtpCaseProtocolQueries(workspaceRoot),
      knowledgeMode: options.knowledgeMode,
    })
  const knowledgeIndex = protocolPreparation.knowledge_index
  const protocolDefinitions = protocolPreparation.protocol_definitions
  const commandDictionaryIndex = buildCommandDictionaryIndex(knowledgeIndex)
  const modelFallbackProfiles = createDtpModelFallbackProfileRegistry()
  const modelFallbackEvidenceIndex = buildDtpModelFallbackEvidenceIndex(
    knowledgeIndex,
    protocolDefinitions,
    commandDictionaryIndex,
  )
  writeCommandDictionaryIndex(paths.commandDictionaryIndexFile, commandDictionaryIndex)
  const dataFileIndex = prepareProjectDataFileIndex(paths, docsContext, options)
  const keywordCatalog = loadKeywordCatalog(paths.keywordDir)
  const previousResult = loadGeneratedTestDataForResume(paths.generatedDataFile, workspaceRoot)
  const staleResumeCaseIds = previousResult?.cases
    .filter((testCase) => !caseIndex.has(testCase.case_id))
    .map((testCase) => testCase.case_id) ?? []
  const allCleanupCaseIds = uniqueStrings([...cleanupCaseIds, ...staleResumeCaseIds])
  cleanCaseGeneratedData(paths.inputDataRoot, allCleanupCaseIds, dataFileIndex)
  const todoCaseIdSet = new Set(caseIds)
  const retainedCases = previousResult?.cases.filter((testCase) => (
    !todoCaseIdSet.has(testCase.case_id) && caseIndex.has(testCase.case_id)
  )) ?? []
  cleanGeneratedCaseArtifacts(paths.generatedDataFile, allCleanupCaseIds)
  const result: GeneratedTestData = {
    schema_version: "1.0.0",
    project_name: workspaceRoot.split(/[\\/]/).filter(Boolean).pop(),
    source_files: {
      todo_file: paths.todoFile,
      confirmation_tests_file: paths.confirmationFile,
      keyword_dir: paths.keywordDir,
      generated_data_files_index: paths.generatedDataFilesIndexFile,
      argument_retry_context: paths.generatedArgumentRetryContextFile,
      generated_test_data_file: paths.generatedDataFile,
      diagnostics_index: paths.generatedDiagnosticsIndexFile,
      case_checkpoint_dir: paths.generatedCasesDir,
      case_diagnostics_dir: paths.generatedDiagnosticsDir,
      performance_report: paths.dtpCasePerformanceReportFile,
      project_root: workspaceRoot,
    },
    cases: [...retainedCases],
    warnings: previousResult
      ? uniqueStrings([
          ...previousResult.warnings,
          `Resumed generated-test-data.json with ${retainedCases.length} non-todo case(s) retained.`,
        ])
      : [],
  }
  for (const retainedCase of retainedCases) {
    writeGeneratedCaseArtifacts(paths.generatedDataFile, workspaceRoot, retainedCase)
  }
  result.warnings.push(...dataFileIndex.warnings)
  result.warnings.push(...knowledgeIndex.warnings)
  result.warnings.push(...commandDictionaryIndex.warnings)
  result.warnings.push(...modelFallbackProfiles.warnings)
  result.warnings.push(...protocolPreparation.validation.issues.map(
    (issue) => `[protocol-${issue.severity}] ${issue.protocol_id ?? "document"}: ${issue.message}`,
  ))
  for (const caseId of caseIds) {
    const caseContext = caseIndex.get(caseId)
    if (!caseContext) {
      const skippedCase = confirmationCases.skippedCases.get(caseId)
      result.warnings.push(
        skippedCase
          ? `Case ${caseId} skipped because ${skippedCase.reason}.`
          : `Case not found: ${caseId}`,
      )
      continue
    }

    const selectedCaseContext = caseContext

    const generatedCase: GeneratedCase = {
      case_id: selectedCaseContext.caseId,
      translate_status: "success",
      case_name: selectedCaseContext.caseName,
      test_purpose: selectedCaseContext.testPurpose,
      test_environment: selectedCaseContext.testEnvironment,
      generated_steps: [],
      warnings: [],
    }
    const protocolAnchors = caseProtocolAnchors(selectedCaseContext, protocolDefinitions)

    const generatedSteps = await performance.measureStage(
      "case_generation",
      { case_id: caseId, step_count: selectedCaseContext.steps.length },
      () => mapWithConcurrency(selectedCaseContext.steps, getDtpModelSectionConcurrency(), (step) => (
        performance.measureStage(
          "case_step_generation",
          { case_id: caseId, step_index: step.stepIndex, keyword_name: step.keywordName },
          async () => {
            const keywordDef = keywordCatalog.get(step.keywordName)
            if (!keywordDef) {
              generatedCase.warnings.push(`Keyword not found: ${step.keywordName}`)
              return null
            }

            return buildGeneratedStepWithPlanning(
              {
                step,
                caseContext: selectedCaseContext,
                keywordDef,
                inputDataRoot: paths.inputDataRoot,
                workspaceRoot,
                knowledgeIndex,
                commandDictionaryIndex,
                dataFileIndex,
                docsContext,
                protocolDefinitions,
                protocolAnchorId: protocolAnchors.get(step.stepIndex),
                modelFallbackProfiles,
                modelFallbackEvidenceIndex,
              },
              cachedModelHooks,
            )
          },
        )
      )),
    )
    generatedCase.generated_steps.push(...generatedSteps.filter((step): step is GeneratedStep => Boolean(step)))
    flagSuspiciousDuplicateStepContent(generatedCase.generated_steps, paths.inputDataRoot)

    result.cases.push(generatedCase)
    writeGeneratedCaseArtifacts(paths.generatedDataFile, workspaceRoot, generatedCase)
    writeGeneratedDiagnosticsIndex(paths.generatedDataFile, result)
    writeGeneratedDataFileIndexCaseCheckpoint(paths, dataFileIndex, caseId)
  }

  const argumentRetryContext = buildArgumentRetryContext(result, dataFileIndex)
  if (argumentRetryContext.status === "ready") {
    result.warnings.push(...argumentRetryContext.warnings)
  }

  writeGeneratedDataFileIndex(paths.generatedDataFilesIndexFile, dataFileIndex)
  cachedModelHooks?.flushCache?.()
  await performance.measureStage(
    "case_generation_summary",
    {
      case_count: result.cases.length,
      step_count: result.cases.reduce((sum, testCase) => sum + testCase.generated_steps.length, 0),
      cache: cachedModelHooks?.cacheStats?.(),
      case_index_checkpoint_count: eligibleCaseIds.length,
    },
    () => undefined,
  )
  performance.finalize({
    sourceDocumentCount: knowledgeIndex.source_documents.length,
    sectionCount: knowledgeIndex.section_protocol_models.length,
    generatedFileCount: dataFileIndex.entries.filter((entry) => entry.source === "dynamic-generated").length,
    warnings: result.warnings,
  })
  performance.write(paths.dtpCasePerformanceReportFile)
  writeArgumentRetryContext(paths.generatedArgumentRetryContextFile, argumentRetryContext)
  writeGeneratedRuntimeData(paths.generatedDataFile, result)
  if ((options.knowledgeMode ?? "source") === "source") writeKnowledgePackageManifest(paths)
  return result
}

export const runDtpTestDataGenerationSkeleton = runDtpCaseDataInstantiation

/**
 * @deprecated Project-wide .txt materialization is no longer exposed by the plugin.
 * Keep this internal migration path only until case-level generation is validated in OpenCode.
 */
export async function runDtpProjectDataFilesGeneration(
  workspaceRoot: string,
  docsContext: DocsContext,
  modelHooks?: DtpDataModelHooks | null,
  options: DtpDataGenerationOptions = {},
): Promise<ProjectDataFilesGenerationResult> {
  const paths = resolveDefaultPaths(workspaceRoot)
  const knowledgeMode = options.knowledgeMode ?? "source"
  const performance = createDtpDataGenerationPerformanceCollector(paths)
  const cachedModelHooks = createCachedDtpDataModelHooks(paths, modelHooks)
  const modelHooksWithPerformance: DtpDataModelHooks = cachedModelHooks
    ? { ...cachedModelHooks, performance }
    : { performance }

  const preparedKnowledgeIndex = await performance.measureStage(
    "prepare_project_knowledge_index",
    { workspace_root: workspaceRoot, knowledge_mode: knowledgeMode },
    () => prepareProjectKnowledgeIndex(paths, docsContext, { knowledgeMode }),
  )
  const knowledgeIndex = await performance.measureStage(
    "model_relation_analysis",
    {
      section_count: preparedKnowledgeIndex.section_protocol_models.length,
      timeout_ms: getDtpModelSectionTimeoutMs(),
      concurrency: getDtpModelSectionConcurrency(),
      cache_file: paths.dtpModelCacheFile,
    },
    () => applyDtpDataModelUnderstanding(preparedKnowledgeIndex, modelHooksWithPerformance),
  )
  if (knowledgeMode === "source") persistProjectKnowledgeArtifacts(paths, knowledgeIndex)
  writeCommandDictionaryIndex(
    paths.commandDictionaryIndexFile,
    buildCommandDictionaryIndex(knowledgeIndex),
  )
  let protocolDefinitions = await performance.measureStage(
    "model_protocol_understanding",
    {
      section_count: knowledgeIndex.section_protocol_models.length,
      timeout_ms: getDtpProtocolUnderstandingTimeoutMs(),
      concurrency: getDtpModelSectionConcurrency(),
      cache_file: paths.dtpModelCacheFile,
    },
    () => buildDtpProtocolDefinitionsDocument(paths, knowledgeIndex, modelHooksWithPerformance),
  )
  protocolDefinitions.source_fingerprint = buildProtocolSourceFingerprint(paths, knowledgeIndex)
  writeDtpProtocolDefinitions(paths.dtpProtocolDefinitionsFile, protocolDefinitions)
  writeProtocolEvidenceTrace(
    paths.protocolEvidenceTraceFile,
    buildProtocolEvidenceTrace(paths, knowledgeIndex, protocolDefinitions),
  )
  if (knowledgeMode === "source") writeKnowledgePackageManifest(paths)
  const dataFileIndex = prepareProjectDataFileIndex(paths, docsContext, options)
  const retryWarnings: string[] = []
  let protocolWriterResult: DtpProtocolDataWriterResult = {
    schema_version: "1.0.0",
    protocol_definitions_file: paths.dtpProtocolDefinitionsFile,
    generated_files: [],
    skipped_protocols: [],
    warnings: [],
  }
  let protocolWriterPreview: DtpProtocolWriterPreviewDocument = {
    schema_version: "1.0.0",
    protocol_definitions_file: paths.dtpProtocolDefinitionsFile,
    legacy_generated_count: 0,
    protocol_writer_generated_count: 0,
    matched_file_paths: [],
    legacy_only_file_paths: [],
    protocol_writer_only_file_paths: [],
    skipped_protocols: [],
    warnings: [],
    updated_at: new Date().toISOString(),
  }
  let dataQualityReport: DtpDataQualityReport = {
    schema_version: "1.0.0",
    status: "pass",
    protocol_definitions_file: paths.dtpProtocolDefinitionsFile,
    protocol_writer_preview_file: paths.dtpProtocolWriterPreviewFile,
    generated_data_files_index_file: paths.generatedDataFilesIndexFile,
    checked_file_count: 0,
    issue_counts: { error: 0, warning: 0, info: 0 },
    issues: [],
    warnings: [],
    updated_at: new Date().toISOString(),
  }
  let retryContext: DtpProtocolRetryContext = {
    schema_version: "1.0.0",
    status: "not_needed",
    protocol_definitions_file: paths.dtpProtocolDefinitionsFile,
    quality_report_file: paths.dtpDataQualityReportFile,
    protocol_writer_preview_file: paths.dtpProtocolWriterPreviewFile,
    affected_protocols: [],
    affected_files: [],
    preview_differences: {
      legacy_only_file_paths: [],
      protocol_writer_only_file_paths: [],
    },
    guidance: [],
    warnings: [],
    updated_at: new Date().toISOString(),
  }

  const runWriter = async (options?: DtpProtocolWriterOptions): Promise<void> => {
    const writerOptions: DtpProtocolWriterOptions = {
      ...options,
      directoryLayout: "flat",
    }
    await performance.measureStage(
      "write_protocol_files",
      {
        allow_fallback_for_unresolved_fields: Boolean(writerOptions.allowFallbackForUnresolvedFields),
        unknown_flow_policy: writerOptions.unknownFlowPolicy,
        directory_layout: writerOptions.directoryLayout,
      },
      () => {
        cleanProjectGeneratedDataFiles(paths.inputDataRoot, dataFileIndex)
        dataFileIndex.entries = dataFileIndex.entries.filter((entry) => entry.source !== "pre-generated")
        protocolWriterResult = writeDtpProtocolDataFiles(paths, protocolDefinitions, dataFileIndex, writerOptions)
      },
    )
    await performance.measureStage(
      "quality_check",
      {
        generated_file_count: protocolWriterResult.generated_files.length,
        skipped_protocol_count: protocolWriterResult.skipped_protocols.length,
      },
      () => {
        protocolWriterPreview = buildDtpProtocolWriterPreview(paths, protocolDefinitions, dataFileIndex, writerOptions)
        dataQualityReport = buildDtpDataQualityReport(paths, protocolDefinitions, protocolWriterPreview, dataFileIndex)
        retryContext = buildDtpProtocolRetryContext(paths, protocolDefinitions, protocolWriterPreview, dataQualityReport)
      },
    )
  }

  await runWriter()
  await performance.measureStage(
    "protocol_retry",
    {
      max_attempts: DTP_PROTOCOL_RETRY_MAX_ATTEMPTS,
      timeout_ms: getDtpModelSectionTimeoutMs(),
      cache_file: paths.dtpModelCacheFile,
    },
    async () => {
      for (let retryAttempt = 1; dataQualityReport.status !== "pass" && retryAttempt <= DTP_PROTOCOL_RETRY_MAX_ATTEMPTS; retryAttempt += 1) {
        const revise = modelHooksWithPerformance.reviseProtocolDefinitions
        if (!revise || retryContext.status !== "ready") break

        try {
          const timeoutMs = getDtpModelSectionTimeoutMs()
          const runRevise = () =>
            withTimeout(
              revise(retryContext),
              timeoutMs,
              `Model protocol retry timed out after ${timeoutMs}ms`,
            )
          const rawPatch = await performance.measureModelCall("protocol_retry", retryContext, runRevise)
          const merged = mergeDtpProtocolDefinitionPatch(protocolDefinitions, rawPatch)
          retryWarnings.push(...merged.warnings.map((warning) => `retry-${retryAttempt}: ${warning}`))
          if (!merged.changed_protocol_ids.length) {
            const warning = `retry-${retryAttempt}: no valid protocol definition patch was applied; final 00 fallback will be used if needed.`
            retryWarnings.push(warning)
            performance.recordFallback("protocol_retry", retryContext, [warning])
            break
          }
          retryWarnings.push(`retry-${retryAttempt}: updated protocol definitions ${merged.changed_protocol_ids.join(", ")}.`)
          protocolDefinitions = merged.definitions
          writeDtpProtocolDefinitions(paths.dtpProtocolDefinitionsFile, protocolDefinitions)
          writeProtocolEvidenceTrace(
            paths.protocolEvidenceTraceFile,
            buildProtocolEvidenceTrace(paths, knowledgeIndex, protocolDefinitions),
          )
          if (knowledgeMode === "source") writeKnowledgePackageManifest(paths)
          await runWriter()
        } catch (error) {
          const warning = `retry-${retryAttempt}: model protocol definition retry failed: ${error instanceof Error ? error.message : String(error)}`
          retryWarnings.push(warning)
          performance.recordFallback("protocol_retry", retryContext, [warning])
          break
        }
      }
    },
  )

  if (dataQualityReport.status !== "pass") {
    retryWarnings.push("Protocol quality issues remained after retry; unresolved frame fields are written with 00 fallback in loose mode.")
    await runWriter({
      allowFallbackForUnresolvedFields: true,
      unknownFlowPolicy: "warn_and_skip",
      fallbackReason: "protocol quality retry did not resolve the field before max attempts",
    })
  }

  const generatedFiles = protocolWriterResult.generated_files
  writeDtpProtocolWriterPreview(
    paths.dtpProtocolWriterPreviewFile,
    protocolWriterPreview,
  )
  writeDtpDataQualityReport(
    paths.dtpDataQualityReportFile,
    dataQualityReport,
  )
  writeDtpProtocolRetryContext(
    paths.dtpProtocolRetryContextFile,
    {
      ...retryContext,
      warnings: uniqueStrings([...retryContext.warnings, ...retryWarnings]),
    },
  )
  writeGeneratedDataFileIndex(paths.generatedDataFilesIndexFile, dataFileIndex)
  const warnings = uniqueStrings([
    ...knowledgeIndex.warnings,
    ...dataFileIndex.warnings,
    ...protocolWriterResult.warnings,
    ...retryWarnings,
  ])
  performance.finalize({
    sourceDocumentCount: knowledgeIndex.source_documents.length,
    sectionCount: knowledgeIndex.section_protocol_models.length,
    generatedFileCount: generatedFiles.length,
    warnings,
  })
  performance.write(paths.dtpPerformanceReportFile)
  cachedModelHooks?.flushCache?.()

  return {
    schema_version: "1.0.0",
    project_root: workspaceRoot,
    knowledge_mode: knowledgeMode,
    source_document_scan_performed: knowledgeMode === "source",
    dtp_root: paths.dtpRoot,
    runtime_dir: paths.runtimeDir,
    input_data_root: paths.inputDataRoot,
    knowledge_index_file: paths.projectKnowledgeIndexFile,
    protocol_definitions_file: paths.dtpProtocolDefinitionsFile,
    protocol_writer_preview_file: paths.dtpProtocolWriterPreviewFile,
    data_quality_report_file: paths.dtpDataQualityReportFile,
    protocol_retry_context_file: paths.dtpProtocolRetryContextFile,
    performance_report_file: paths.dtpPerformanceReportFile,
    data_files_index_file: paths.generatedDataFilesIndexFile,
    generated_files: generatedFiles,
    skipped_candidates: 0,
    warnings,
  }
}

export function normalizeWorkspaceRoot(projectDir?: string, contextDirectory?: string): string {
  const contextRoot = resolve(contextDirectory?.trim() || process.cwd())
  if (!projectDir?.trim()) return contextRoot

  const requestedRoot = resolve(contextRoot, projectDir.trim())
  if (contextDirectory && requestedRoot.toLowerCase() !== contextRoot.toLowerCase()) {
    throw new Error(
      `project_dir must match the current OpenCode workspace: ${contextRoot}; received: ${requestedRoot}`,
    )
  }
  return requestedRoot
}

export function normalizeDocsContext(input?: Partial<DocsContext>): DocsContext {
  return {
    backgroundDocs: input?.backgroundDocs ?? [],
    hardwareDocs: input?.hardwareDocs ?? [],
    protocolDocs: input?.protocolDocs ?? [],
    conventionDocs: input?.conventionDocs ?? [],
    packetStructureDocs: input?.packetStructureDocs ?? [],
    formatRuleDocs: input?.formatRuleDocs ?? [],
    requirementDocs: input?.requirementDocs ?? [],
  }
}
