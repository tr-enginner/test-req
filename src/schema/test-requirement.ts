import { z } from "zod"
import { ReportMeta } from "./report-meta"

/** Test requirement item */
export const TestRequirement = z.object({
  id: z.string(),
  source_requirement_ids: z.array(z.string()),
  title: z.string(),
  description: z.string(),
  type: z.enum([
    "functional",
    "interface",
    "performance",
    "robustness",
    "safety",
    "boundary",
    "stress",
    "margin",
    "data_processing",
    "recovery",
    "logic",
    "hmi",
    "capacity",
    "installation",
    "document_review",
    "code_review",
    "static_analysis",
    "code_walkthrough",
    "logic_test",
    "information_security",
    "compatibility",
  ]),
  priority: z.enum(["critical", "high", "medium", "low"]),
  test_level: z.enum(["unit", "integration", "system", "confirmation"]),
  verification_method: z.enum(["test", "analysis", "inspection", "demonstration"]),
  verification_criteria: z.string(),
  testability: z.enum(["testable", "partially_testable", "not_testable"]),
  testability_notes: z.string().optional(),
  coverage_target: z
    .enum(["statement", "branch", "mc_dc", "condition", "path"])
    .optional(),
  /** Test adequacy requirements (C1-C5) per GJB/Z 141 */
  adequacy_requirements: z.array(z.enum(["C1", "C2", "C3", "C4", "C5"])).default([]),
  /** Test termination requirement per GJB/Z 141 */
  termination_requirement: z.enum(["Z1", "Z2", "Z3"]).optional(),
  /** Input data flows for this requirement (functional types) */
  input_flows: z.array(z.string()).default([]),
  /** Processing logic description */
  processing: z.string().optional(),
  /** Output data flows for this requirement (functional types) */
  output_flows: z.array(z.string()).default([]),
  status: z.enum(["draft", "reviewed", "approved", "modified"]).default("draft"),
})
export type TestRequirement = z.infer<typeof TestRequirement>

/** Test requirement specification — main output of ReqArchitect */
export const TestRequirementSpec = ReportMeta.merge(z.object({
  standard: z.string(),
  requirements: z.array(TestRequirement),
  traceability: z.array(
    z.object({
      software_req_id: z.string(),
      test_req_ids: z.array(z.string()),
      coverage_status: z.enum(["full", "partial", "none"]),
    }),
  ),
  summary: z.object({
    total: z.number(),
    by_type: z.record(z.string(), z.number()),
    by_priority: z.record(z.string(), z.number()),
    testable_count: z.number(),
    not_testable_count: z.number(),
  }),
  /** Technical elements analysis (Chapter 5 of industry template) */
  technical_elements: z.object({
    /** New state items (new hardware, interfaces, protocols, functions, algorithms, environments) */
    new_states: z.array(z.object({
      description: z.string(),
      test_req_id: z.string(),
      category: z.enum([
        "new_hardware", "new_interface", "new_protocol",
        "new_function", "new_algorithm", "new_environment",
      ]),
    })).default([]),
    /** Safety-critical function items */
    safety_critical_functions: z.array(z.object({
      description: z.string(),
      test_req_id: z.string(),
      category: z.string(),
    })).default([]),
    /** Key test focus points */
    test_focus_points: z.array(z.object({
      description: z.string(),
      test_req_id: z.string(),
    })).default([]),
    /** Interrupt usage summary for document export */
    interrupt_usage: z.array(z.object({
      name: z.string(),
      priority: z.string().default(""),
      cycles: z.string().default(""),
      trigger: z.string().default(""),
      function: z.string().default(""),
    })).default([]),
  }).default({
    new_states: [],
    safety_critical_functions: [],
    test_focus_points: [],
    interrupt_usage: [],
  }),
  /** Design constraints (Chapter 6) */
  design_constraints: z.array(z.object({
    id: z.string(),
    description: z.string(),
  })).default([]),
  /** Document-level traceability (Chapter 7 coverage table) */
  document_traceability: z.array(z.object({
    document_name: z.string(),
    section_number: z.string(),
    section_title: z.string(),
    test_req_ids: z.array(z.string()),
  })).default([]),
}))
export type TestRequirementSpec = z.infer<typeof TestRequirementSpec>


// ============================================================
// Flat Format (new: top-level funItem[], no tree structure)
// ============================================================
/** Normalize camelCase field names to snake_case for known flat-format fields. */
export function normalizeFlatFieldNames(item: unknown): unknown {
  if (typeof item !== "object" || item === null) return item
  const obj = item as Record<string, unknown>
  const result = { ...obj }
  // testType → test_type
  if ("testType" in result && !("test_type" in result)) {
    result.test_type = result.testType
    delete result.testType
  }
  // funId with single string → wrap in array
  if (typeof result.funId === "string") {
    result.funId = [result.funId]
  }
  return result
}

/** A single test requirement item in the flat format — self-contained, not nested in a tree. */
export const TestRequirementFlatItem = z.preprocess(
  normalizeFlatFieldNames,
  z.object({
    funId: z.array(z.string()),
    test_type: z.string(),
    titleNo: z.string().optional(),
    title: z.string(),
    requirementContext: z.string().optional(),
    inputFlowContext: z.string().optional(),
    processingContext: z.string().optional(),
    outputFlowContext: z.string().optional(),
    constraintContext: z.string().optional(),
    interruptContext: z.string().optional(),
  }).passthrough(),
)
export type TestRequirementFlatItem = z.infer<typeof TestRequirementFlatItem>

/** Flat-format test requirement artifact — top-level funItem[] array. */
export const TestRequirementFlatArtifact = z.object({
  funItem: z.array(TestRequirementFlatItem),
  docType: z.number().optional(),
  projectId: z.string().optional(),
  codeVersion: z.string().optional(),
  project_name: z.string().optional(),
  version: z.string().optional(),
  standard: z.string().optional(),
  // 工件级中断上下文(2026-09-02 用户数据形态):中断使用说明表放在顶层而非
  // 逐 funItem——preparer 以"项级 ?? 工件级"回退注入各 requirement
  interruptContext: z.string().optional(),
}).passthrough()
export type TestRequirementFlatArtifact = z.infer<typeof TestRequirementFlatArtifact>

/** Format detection: flat format has top-level funItem[] with array funId. */
export function isFlatTestRequirements(
  artifact: unknown,
): artifact is TestRequirementFlatArtifact {
  if (!artifact || typeof artifact !== "object") return false
  const candidate = artifact as Record<string, unknown>
  const funItem = candidate.funItem
  return (
    Array.isArray(funItem) &&
    funItem.length > 0 &&
    typeof funItem[0] === "object" &&
    funItem[0] !== null &&
    "funId" in funItem[0] &&
    Array.isArray((funItem[0] as Record<string, unknown>).funId)
  )
}

export const TestRequirementsArtifact = z.union([
  TestRequirementSpec,
  TestRequirementFlatArtifact,
])
export type TestRequirementsArtifact = z.infer<typeof TestRequirementsArtifact>
