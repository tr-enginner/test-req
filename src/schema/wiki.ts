import { z } from "zod"
import { ReportMeta } from "./report-meta"

// === L3: Function-level wiki ===

export const FunctionAlgorithm = z.object({
  name: z.string(),
  description: z.string(),
  complexity: z.string().optional(),
})

export const FunctionParameterContract = z.object({
  name: z.string(),
  type: z.string(),
  description: z.string(),
})
export type FunctionParameterContract = z.infer<typeof FunctionParameterContract>

export const FunctionReturnValue = z.object({
  type: z.string(),
  description: z.string(),
})
export type FunctionReturnValue = z.infer<typeof FunctionReturnValue>

export const FunctionPrecondition = z.object({
  parameter: z.string(),
  constraint: z.string(),
})

export const FunctionPostcondition = z.object({
  description: z.string(),
})

export const FunctionErrorHandling = z.object({
  error_condition: z.string(),
  response: z.string(),
})

export const FunctionControlFlow = z.object({
  branches: z.number(),
  loops: z.number(),
  early_returns: z.number(),
  description: z.string(),
})

export const FunctionSideEffect = z.object({
  target: z.string(),
  access: z.enum(["read", "write", "read_write"]),
  description: z.string(),
})

export const FunctionConcurrency = z.object({
  is_isr: z.boolean(),
  interrupt_vector: z.string().optional(),
  shared_resources: z.array(z.string()).default([]),
  critical_sections: z.boolean(),
  reentrancy: z.enum(["reentrant", "non_reentrant", "unknown"]),
})

export const RequirementFulfillment = z.object({
  requirement_id: z.string(),
  how: z.string(),
})

export const TestingHints = z.object({
  suggested_focus: z.array(z.string()).default([]),
  stubbing_needs: z.array(z.string()).default([]),
  complexity_warning: z.string().optional(),
})

export const FunctionWiki = z.object({
  id: z.string(),
  name: z.string(),
  file_path: z.string(),
  line_range: z.object({ start: z.number(), end: z.number() }),
  module_id: z.string(),
  signature: z.string(),
  parameters: z.array(FunctionParameterContract),
  return_value: FunctionReturnValue,
  summary: z.string(),
  algorithm: FunctionAlgorithm.optional(),
  preconditions: z.array(FunctionPrecondition).default([]),
  postconditions: z.array(FunctionPostcondition).default([]),
  boundary_conditions: z.array(z.string()).default([]),
  error_handling: z.array(FunctionErrorHandling).default([]),
  control_flow: FunctionControlFlow,
  side_effects: z.array(FunctionSideEffect).default([]),
  concurrency: FunctionConcurrency.optional(),
  requirement_fulfillment: z.array(RequirementFulfillment).default([]),
  testing_hints: TestingHints,
})
export type FunctionWiki = z.infer<typeof FunctionWiki>

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value.trim() : null
}

function ensureStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
  }
  const text = asString(value)
  return text ? [text] : []
}

function normalizeAlgorithm(value: unknown): unknown {
  const text = asString(value)
  if (text) {
    return {
      name: "summary-derived",
      description: text,
    }
  }
  return value
}

function normalizePreconditions(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => {
      const text = asString(item)
      return text ? { parameter: "general", constraint: text } : item
    })
  }
  const text = asString(value)
  return text ? [{ parameter: "general", constraint: text }] : value
}

function normalizePostconditions(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => {
      const text = asString(item)
      return text ? { description: text } : item
    })
  }
  const text = asString(value)
  return text ? [{ description: text }] : value
}

function normalizeErrorHandling(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => {
      const text = asString(item)
      return text ? { error_condition: "general", response: text } : item
    })
  }
  const text = asString(value)
  return text ? [{ error_condition: "general", response: text }] : value
}

function normalizeControlFlow(value: unknown): unknown {
  const text = asString(value)
  if (text) {
    return {
      branches: 0,
      loops: 0,
      early_returns: 0,
      description: text,
    }
  }
  return value
}

function normalizeSideEffects(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => {
      const text = asString(item)
      return text ? { target: "unknown", access: "read_write", description: text } : item
    })
  }
  const text = asString(value)
  return text ? [{ target: "unknown", access: "read_write", description: text }] : value
}

function normalizeConcurrency(value: unknown): unknown {
  const text = asString(value)
  if (text) {
    return {
      is_isr: /\bisr\b|interrupt/i.test(text),
      shared_resources: [],
      critical_sections: false,
      reentrancy: "unknown",
      ...(text ? { interrupt_vector: text } : {}),
    }
  }
  return value
}

function normalizeRequirementFulfillment(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => {
      const text = asString(item)
      return text ? { requirement_id: "UNKNOWN", how: text } : item
    })
  }
  const text = asString(value)
  return text ? [{ requirement_id: "UNKNOWN", how: text }] : value
}

function normalizeTestingHints(value: unknown): unknown {
  const text = asString(value)
  if (text) {
    return {
      suggested_focus: [],
      stubbing_needs: [],
      complexity_warning: text,
    }
  }
  return value
}

export function normalizeFunctionWikiCandidate(value: unknown): unknown {
  const record = asRecord(value)
  if (!record) return value

  return {
    ...record,
    boundary_conditions: ensureStringArray(record.boundary_conditions),
    algorithm: normalizeAlgorithm(record.algorithm),
    preconditions: normalizePreconditions(record.preconditions),
    postconditions: normalizePostconditions(record.postconditions),
    error_handling: normalizeErrorHandling(record.error_handling),
    control_flow: normalizeControlFlow(record.control_flow),
    side_effects: normalizeSideEffects(record.side_effects),
    concurrency: normalizeConcurrency(record.concurrency),
    requirement_fulfillment: normalizeRequirementFulfillment(record.requirement_fulfillment),
    testing_hints: normalizeTestingHints(record.testing_hints),
  }
}

export function parseFunctionWikiLenient(value: unknown): { data: FunctionWiki; repaired: boolean } | null {
  const direct = FunctionWiki.safeParse(value)
  if (direct.success) {
    return { data: direct.data, repaired: false }
  }

  const normalized = normalizeFunctionWikiCandidate(value)
  const repaired = FunctionWiki.safeParse(normalized)
  if (!repaired.success) {
    return null
  }

  return { data: repaired.data, repaired: true }
}

// === L2: Module-level wiki ===

export const ModuleFunction = z.object({
  function_id: z.string(),
  name: z.string(),
  signature: z.string().optional(),
  purpose: z.string(),
})

export const ModuleInternalFunction = z.object({
  function_id: z.string(),
  name: z.string(),
  purpose: z.string(),
})

export const ModuleDependency = z.object({
  module_id: z.string(),
  module_name: z.string(),
  relationship: z.string(),
})

export const StateMachineTransition = z.object({
  from: z.string(),
  to: z.string(),
  trigger: z.string(),
  action: z.string().optional(),
})

export const StateMachine = z.object({
  name: z.string(),
  states: z.array(z.string()),
  transitions: z.array(StateMachineTransition),
  description: z.string(),
})

export const HardwareInteraction = z.object({
  peripheral: z.string(),
  access_type: z.enum(["read", "write", "read_write", "interrupt"]),
  registers: z.array(z.string()).default([]),
  description: z.string(),
})

export const ModuleWiki = z.object({
  id: z.string(),
  name: z.string(),
  files: z.array(z.string()),
  responsibility: z.string(),
  design_rationale: z.string(),
  public_interface: z.array(ModuleFunction).default([]),
  internal_functions: z.array(ModuleInternalFunction).default([]),
  dependencies: z.array(ModuleDependency).default([]),
  dependents: z.array(ModuleDependency).default([]),
  state_machines: z.array(StateMachine).default([]),
  hardware_interactions: z.array(HardwareInteraction).default([]),
  invariants: z.array(z.string()).default([]),
  complexity_notes: z.array(z.string()).default([]),
})
export type ModuleWiki = z.infer<typeof ModuleWiki>

// === L1: Global index ===

export const TechStack = z.object({
  language: z.string(),
  compiler_dialect: z.string(),
  target_cpu: z.string(),
  rtos: z.string().optional(),
  frameworks: z.array(z.string()).default([]),
})

export const Architecture = z.object({
  pattern: z.string(),
  description: z.string(),
  layers: z.array(z.string()).default([]),
})

export const WikiModuleEntry = z.object({
  id: z.string(),
  name: z.string(),
  files: z.array(z.string()),
  description: z.string(),
  function_count: z.number(),
  safety_critical: z.boolean(),
})

export const WikiFunctionEntry = z.object({
  id: z.string(),
  module_id: z.string(),
  file_path: z.string(),
  safety_critical: z.boolean(),
})

export const WikiFunctionIndexChunkRef = z.object({
  chunk_index: z.number().int().nonnegative(),
  file_path: z.string(),
  entry_count: z.number().int().nonnegative(),
  first_function_name: z.string().optional(),
  last_function_name: z.string().optional(),
})
export type WikiFunctionIndexChunkRef = z.infer<typeof WikiFunctionIndexChunkRef>

export const WikiFunctionIndexChunk = z.object({
  artifact_type: z.literal("wiki-function-index-chunk"),
  schema_version: z.literal(1),
  chunk_index: z.number().int().nonnegative(),
  created_date: z.string(),
  entries: z.record(z.string(), WikiFunctionEntry),
})
export type WikiFunctionIndexChunk = z.infer<typeof WikiFunctionIndexChunk>

export const DataStructureKind = z.enum(["struct", "enum", "union", "typedef", "GlobalVar"])
export type DataStructureKind = z.infer<typeof DataStructureKind>

export const WikiDataStructure = z.object({
  name: z.string(),
  file_path: z.string(),
  kind: DataStructureKind,
}).strict()

export const WikiFunctionSourceLocation = z.object({
  file_path: z.string(),
  line_range: z.object({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
  }),
})
export type WikiFunctionSourceLocation = z.infer<typeof WikiFunctionSourceLocation>

export const WikiFunctionParameterMetadata = z.object({
  name: z.string(),
  type: z.string(),
  description: z.string().optional(),
})
export type WikiFunctionParameterMetadata = z.infer<typeof WikiFunctionParameterMetadata>

export const WikiFunctionInterfaceMetadata = z.object({
  return_type: z.string(),
  parameters: z.array(WikiFunctionParameterMetadata).default([]),
})
export type WikiFunctionInterfaceMetadata = z.infer<typeof WikiFunctionInterfaceMetadata>

export const DataFlowPath = z.object({
  name: z.string(),
  description: z.string(),
  modules_involved: z.array(z.string()),
})

export const WikiIndex = ReportMeta.merge(z.object({
  overview: z.string(),
  tech_stack: TechStack,
  architecture: Architecture,
  modules: z.array(WikiModuleEntry),
  function_index: z.record(z.string(), WikiFunctionEntry),
  function_index_chunks: z.array(WikiFunctionIndexChunkRef).default([]),
  data_structures: z.array(WikiDataStructure).default([]),
  data_flow_paths: z.array(DataFlowPath).default([]),
}))
export type WikiIndex = z.infer<typeof WikiIndex>

export const WikiGenerationPlanDependencyRequirement = z.object({
  module_dependencies: z.array(z.string()).default([]),
  required_lower_layer_paths: z.array(z.string()).default([]),
})
export type WikiGenerationPlanDependencyRequirement = z.infer<typeof WikiGenerationPlanDependencyRequirement>

export const WikiGenerationPlanCycle = z.object({
  level: z.enum(["module", "function"]),
  module_name: z.string().optional(),
  members: z.array(z.string()).default([]),
})
export type WikiGenerationPlanCycle = z.infer<typeof WikiGenerationPlanCycle>

export const WikiGenerationPlanSkippedFunctionDispatch = z.object({
  function_name: z.string(),
  module_name: z.string(),
  wiki_path: z.string(),
  reason: z.string().default("reused_existing_artifact"),
})
export type WikiGenerationPlanSkippedFunctionDispatch = z.infer<typeof WikiGenerationPlanSkippedFunctionDispatch>

export const WikiGenerationPlan = z.object({
  artifact_type: z.literal("wiki-generation-plan"),
  created_date: z.string(),
  project: z.object({
    project_name: z.string(),
    total_functions: z.number().int().nonnegative(),
    total_modules: z.number().int().nonnegative(),
  }),
  reused_data_structures_wiki: z.boolean(),
  module_order: z.array(z.string()).default([]),
  detected_cycles: z.array(WikiGenerationPlanCycle).default([]),
  dependency_requirements: z.record(z.string(), WikiGenerationPlanDependencyRequirement).default({}),
  per_module_function_order: z.record(z.string(), z.array(z.string())).default({}),
  per_function_names: z.record(z.string(), z.string()).default({}),
  per_function_direct_callees: z.record(z.string(), z.array(z.string())).default({}),
  per_function_dependency_wiki_paths: z.record(z.string(), z.array(z.string())).default({}),
  per_function_source_locations: z.record(z.string(), WikiFunctionSourceLocation).default({}),
  per_function_interfaces: z.record(z.string(), WikiFunctionInterfaceMetadata).default({}),
  per_function_wiki_paths: z.record(z.string(), z.string()).default({}),
  reusable_function_wiki_paths: z.record(z.string(), z.string()).default({}),
  skipped_function_dispatches: z.array(WikiGenerationPlanSkippedFunctionDispatch).default([]),
})
export type WikiGenerationPlan = z.infer<typeof WikiGenerationPlan>

export const WikiExecutionStepKind = z.enum([
  "data-structures",
  "function-analysis",
  "module-analysis",
  "global-synthesis",
  "complete",
])
export type WikiExecutionStepKind = z.infer<typeof WikiExecutionStepKind>

export const WikiExecutionFunctionStep = z.object({
  kind: z.literal("function-analysis"),
  module_name: z.string(),
  module_order_index: z.number().int().positive(),
  module_order_total: z.number().int().positive(),
  function_id: z.string(),
  function_name: z.string(),
  function_wiki_path: z.string(),
  function_file_path: z.string(),
  function_line_range: z.object({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
  }),
  function_return_type: z.string().default("unknown"),
  function_parameters: z.array(WikiFunctionParameterMetadata).default([]),
  function_order_index: z.number().int().positive(),
  function_order_total: z.number().int().positive(),
  direct_callees: z.array(z.string()).default([]),
  required_callee_wiki_paths: z.array(z.string()).default([]),
  reused: z.boolean().default(false),
})
export type WikiExecutionFunctionStep = z.infer<typeof WikiExecutionFunctionStep>

export const WikiExecutionModuleStep = z.object({
  kind: z.literal("module-analysis"),
  module_name: z.string(),
  module_order_index: z.number().int().positive(),
  module_order_total: z.number().int().positive(),
  module_source_paths: z.array(z.string()).default([]),
  module_dependencies: z.array(z.string()).default([]),
  function_order: z.array(z.string()).default([]),
  module_function_wiki_paths: z.array(z.string()).default([]),
  reused: z.boolean().default(false),
})
export type WikiExecutionModuleStep = z.infer<typeof WikiExecutionModuleStep>

export const WikiExecutionDataStructuresStep = z.object({
  kind: z.literal("data-structures"),
  wiki_path: z.string(),
  reused: z.boolean().default(false),
})
export type WikiExecutionDataStructuresStep = z.infer<typeof WikiExecutionDataStructuresStep>

export const WikiExecutionGlobalSynthesisStep = z.object({
  kind: z.literal("global-synthesis"),
  index_path: z.string(),
  module_wiki_paths: z.array(z.string()).default([]),
  function_wiki_paths: z.array(z.string()).default([]),
  reused: z.boolean().default(false),
})
export type WikiExecutionGlobalSynthesisStep = z.infer<typeof WikiExecutionGlobalSynthesisStep>

export const WikiExecutionCompleteStep = z.object({
  kind: z.literal("complete"),
})
export type WikiExecutionCompleteStep = z.infer<typeof WikiExecutionCompleteStep>

export const WikiExecutionNextStep = z.discriminatedUnion("kind", [
  WikiExecutionDataStructuresStep,
  WikiExecutionFunctionStep,
  WikiExecutionModuleStep,
  WikiExecutionGlobalSynthesisStep,
  WikiExecutionCompleteStep,
])
export type WikiExecutionNextStep = z.infer<typeof WikiExecutionNextStep>

export const WikiExecutionStepArtifact = z.object({
  artifact_type: z.literal("wiki-execution-step"),
  updated_at: z.string(),
  step: WikiExecutionNextStep,
})
export type WikiExecutionStepArtifact = z.infer<typeof WikiExecutionStepArtifact>

export const WikiExecutionStepPointer = z.object({
  kind: WikiExecutionStepKind,
  step_file: z.string().optional(),
  module_name: z.string().optional(),
  function_id: z.string().optional(),
  function_name: z.string().optional(),
  function_wiki_path: z.string().optional(),
  index_path: z.string().optional(),
  wiki_path: z.string().optional(),
})
export type WikiExecutionStepPointer = z.infer<typeof WikiExecutionStepPointer>

export const WikiExecutionState = z.object({
  artifact_type: z.literal("wiki-execution-state"),
  updated_at: z.string(),
  total_functions: z.number().int().nonnegative(),
  completed_functions: z.number().int().nonnegative(),
  reused_functions: z.number().int().nonnegative(),
  pending_functions: z.number().int().nonnegative(),
  completed_modules: z.number().int().nonnegative(),
  total_modules: z.number().int().nonnegative(),
  global_synthesis_completed: z.boolean(),
  last_dispatched_step: WikiExecutionStepPointer.optional(),
})
export type WikiExecutionState = z.infer<typeof WikiExecutionState>

// === Data structures file ===

export const DataStructureEntry = z.object({
  name: z.string(),
  file_path: z.string(),
  line_range: z.object({ start: z.number(), end: z.number() }),
  type: z.string().optional(),
  fields: z
    .array(
      z.object({
        name: z.string(),
        type: z.string(),
      }).strict(),
    )
    .default([]),
  used_by_functions: z.array(z.string()).default([]),
  used_by_modules: z.array(z.string()).default([]),
}).strict()
export type DataStructureEntry = z.infer<typeof DataStructureEntry>

export const DataStructureDetail = DataStructureEntry
export type DataStructureDetail = z.infer<typeof DataStructureDetail>

export const DataStructuresFile = z.object({
  schema_version: z.literal(3),
  project_name: z.string(),
  created_date: z.string(),
  struct: z.array(DataStructureEntry).default([]),
  union: z.array(DataStructureEntry).default([]),
  enum: z.array(DataStructureEntry).default([]),
  typedef: z.array(DataStructureEntry).default([]),
  GlobalVar: z.array(DataStructureEntry).default([]),
}).strict()
export type DataStructuresFile = z.infer<typeof DataStructuresFile>
