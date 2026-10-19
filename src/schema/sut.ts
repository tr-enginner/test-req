import { z } from "zod"
import { ReportMeta } from "./report-meta"

/** Software requirement item */
export const SoftwareRequirement = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  type: z.enum(["functional", "interface", "performance", "safety", "constraint"]),
  priority: z.enum(["critical", "high", "medium", "low"]),
  source: z.string().optional(),
  acceptance_criteria: z.array(z.string()),
  related_requirements: z.array(z.string()).default([]),
  resolved_references: z
    .array(
      z.object({
        ref_text: z.string(),
        ref_type: z.enum([
          "internal_section",
          "internal_requirement",
          "external_document",
          "standard",
          "domain_knowledge",
        ]),
        source_location: z.string().optional(),
        resolved_content: z.string(),
      }),
    )
    .default([]),
  unresolved_references: z
    .array(
      z.object({
        ref_text: z.string(),
        ref_type: z.string(),
        reason: z.string(),
      }),
    )
    .default([]),
})
export type SoftwareRequirement = z.infer<typeof SoftwareRequirement>

/** Interface definition */
export const InterfaceDefinition = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(["input", "output", "bidirectional"]),
  protocol: z.string(),
  data_format: z.string(),
  range: z
    .object({
      min: z.number().optional(),
      max: z.number().optional(),
      unit: z.string().optional(),
    })
    .optional(),
  timing: z
    .object({
      period_ms: z.number().optional(),
      latency_ms: z.number().optional(),
      jitter_ms: z.number().optional(),
    })
    .optional(),
  source_module: z.string().optional(),
  target_module: z.string().optional(),
})
export type InterfaceDefinition = z.infer<typeof InterfaceDefinition>

/** Data flow graph node */
export const DataFlowNode = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(["process", "data_store", "external_entity", "function"]),
  file_path: z.string().optional(),
  line_range: z.object({ start: z.number(), end: z.number() }).optional(),
  description: z.string().optional(),
})
export type DataFlowNode = z.infer<typeof DataFlowNode>

/** Data flow graph edge */
export const DataFlowEdge = z.object({
  id: z.string(),
  source_node: z.string(),
  target_node: z.string(),
  data_name: z.string(),
  data_type: z.string(),
  description: z.string().optional(),
})
export type DataFlowEdge = z.infer<typeof DataFlowEdge>

/** Data flow graph */
export const DataFlowGraph = z.object({
  nodes: z.array(DataFlowNode),
  edges: z.array(DataFlowEdge),
})
export type DataFlowGraph = z.infer<typeof DataFlowGraph>

/** Code function info */
export const FunctionInfo = z.object({
  id: z.string(),
  name: z.string(),
  file_path: z.string(),
  line_range: z.object({ start: z.number(), end: z.number() }),
  return_type: z.string(),
  parameters: z.array(
    z.object({
      name: z.string(),
      type: z.string(),
      description: z.string().optional(),
    }),
  ),
  cyclomatic_complexity: z.number().optional(),
  calls: z.array(z.string()).default([]),
  called_by: z.array(z.string()).default([]),
  safety_critical: z.boolean().default(false),
  related_requirements: z.array(z.string()).default([]),
})
export type FunctionInfo = z.infer<typeof FunctionInfo>

/** Software module grouping */
export const SoftwareModule = z.object({
  name: z.string(),
  path: z.string(),
  description: z.string().optional(),
  functions: z.array(z.string()),
})
export type SoftwareModule = z.infer<typeof SoftwareModule>

/** Traceability mapping: requirement → implementing functions */
export const TraceabilityEntry = z.object({
  req_id: z.string(),
  function_ids: z.array(z.string()),
})
export type TraceabilityEntry = z.infer<typeof TraceabilityEntry>

/** GAP: requirement with no implementing functions (structural) */
export const GapEntry = z.object({
  req_id: z.string(),
  reason: z.string(),
})
export type GapEntry = z.infer<typeof GapEntry>

/** ORPHAN: function with no linked requirements (structural) */
export const OrphanEntry = z.object({
  function_id: z.string(),
  function_name: z.string(),
  file_path: z.string(),
})
export type OrphanEntry = z.infer<typeof OrphanEntry>

/** Interrupt table entry — derived by Analyst from code analysis */
export const InterruptEntry = z.object({
  name: z.string(),
  vector: z.string().optional(),
  priority: z.string().optional(),
  period_or_trigger: z.string().optional(),
  trigger_mode: z.string().optional(),
  handler_function: z.string(),
  description: z.string().optional(),
})
export type InterruptEntry = z.infer<typeof InterruptEntry>

/** Runtime environment info — derived by Analyst from code/build analysis */
export const RuntimeEnvironment = z.object({
  target_cpu: z.string().optional(),
  clock_frequency: z.string().optional(),
  programming_language: z.string().optional(),
  interrupt_table: z.array(InterruptEntry).default([]),
  memory_map: z.object({
    rom_total: z.string().optional(),
    ram_total: z.string().optional(),
    stack_size: z.string().optional(),
  }).optional(),
  io_interfaces_summary: z.array(z.string()).default([]),
})
export type RuntimeEnvironment = z.infer<typeof RuntimeEnvironment>

/** Software analysis report — main output of Analyst */
export const SoftwareAnalysisReport = ReportMeta.merge(z.object({
  /** CSCI name (配置项名称) — extracted from requirement docs or user input */
  csci_name: z.string().optional(),
  /** Parent system name — extracted from requirement docs or user input */
  system_name: z.string().optional(),
  /** Software criticality level (e.g., "A", "B", "甲") */
  software_level: z.string().optional(),
  /** Developer organization */
  developer_org: z.string().optional(),
  requirements: z.array(SoftwareRequirement),
  interfaces: z.array(InterfaceDefinition),
  data_flow_graph: DataFlowGraph,
  functions: z.array(FunctionInfo),
  modules: z.array(SoftwareModule),
  traceability_matrix: z.array(TraceabilityEntry).optional(),
  gap_analysis: z.array(GapEntry).optional(),
  orphan_analysis: z.array(OrphanEntry).optional(),
  runtime_environment: RuntimeEnvironment.optional(),
  main_functions_summary: z.string().optional(),
  summary: z.object({
    total_functions: z.number(),
    total_loc: z.number(),
    total_requirements: z.number(),
    total_interfaces: z.number(),
    safety_critical_functions: z.number(),
    avg_complexity: z.number().optional(),
  }),
}))
export type SoftwareAnalysisReport = z.infer<typeof SoftwareAnalysisReport>
