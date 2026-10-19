import { z } from "zod"

/** Variable access type */
export const AccessType = z.enum(["READ", "WRITE"])
export type AccessType = z.infer<typeof AccessType>

/** Semantic atomicity anchor type */
export const AnchorType = z.enum(["DFC", "TUP", "DAC"])
export type AnchorType = z.infer<typeof AnchorType>

/** Role of a variable within a correlated group */
export const VariableRole = z.enum([
  "DECISION",
  "ACTION",
  "SINK_OPERAND",
  "TRANSACTIONAL",
  "UNKNOWN",
])
export type VariableRole = z.infer<typeof VariableRole>

/** Violation pattern types */
export const ViolationPattern = z.enum(["DFC_RWWR", "TUP_WRRW", "TUP_WWWW", "DAC_RWWW", "DAC_RWWR"])
export type ViolationPattern = z.infer<typeof ViolationPattern>

/** Z3 feasibility verification status */
export const FeasibilityStatus = z.enum([
  "CONFIRMED",
  "INFEASIBLE",
  "UNKNOWN",
  "UNCHECKED",
])
export type FeasibilityStatus = z.infer<typeof FeasibilityStatus>

/** A location in source code */
export const AtomSourceLocation = z.object({
  file_path: z.string(),
  line: z.number(),
  column: z.number().default(0),
  function: z.string().default(""),
  code: z.string().default(""),
})
export type AtomSourceLocation = z.infer<typeof AtomSourceLocation>

/** A single shared variable access instance */
export const VariableAccess = z.object({
  variable_name: z.string(),
  access_type: AccessType,
  location: AtomSourceLocation,
  entry_function: z.string().default(""),
  expression: z.string().default(""),
  role: VariableRole.default("UNKNOWN"),
})
export type VariableAccess = z.infer<typeof VariableAccess>

/** Statistics from Joern correlated variable analysis */
export const JoernStats = z.object({
  global_var: z.number().default(0),
  shared_var: z.number().default(0),
  saa: z.number().default(0),
  dfc_tup: z.number().default(0),
  sink: z.number().default(0),
  update: z.number().default(0),
  dac: z.number().default(0),
  pairs: z.number().default(0),
  dfc_tup_pairs: z.number().default(0),
  sink_pairs: z.number().default(0),
  update_pairs: z.number().default(0),
  dac_pairs: z.number().default(0),
})
export type JoernStats = z.infer<typeof JoernStats>

/** A group of variables identified as semantically correlated */
export const CorrelatedVariableGroup = z.object({
  id: z.string(),
  variables: z.array(z.string()),
  anchor_type: AnchorType,
  accesses: z.array(VariableAccess).default([]),
  evidence: z.record(z.string(), z.number()).default({}),
  confidence: z.number().default(0),
  anchor_location: AtomSourceLocation.optional(),
  anchor_id: z.string().optional(),
  struct_base: z.string().optional(),
  domain_category: z.string().default(""),
})
export type CorrelatedVariableGroup = z.infer<typeof CorrelatedVariableGroup>

/** A point where interrupt preemption can occur */
export const PreemptionPoint = z.object({
  location: AtomSourceLocation,
  interrupt_enabled: z.boolean().default(true),
  in_critical_section: z.boolean().default(false),
})
export type PreemptionPoint = z.infer<typeof PreemptionPoint>

/** An access in the interrupt context that may conflict */
export const InterruptAccessPair = z.object({
  isr_name: z.string(),
  priority: z.number().default(0),
  access: VariableAccess,
})
export type InterruptAccessPair = z.infer<typeof InterruptAccessPair>

/** An interrupt state change detected along a path */
export const InterruptStateChange = z.object({
  api: z.string(),
  line: z.number(),
  effect: z.enum(["enable", "disable"]),
})
export type InterruptStateChange = z.infer<typeof InterruptStateChange>

/** Condition schema shared by path conditions and caller conditions */
const ConditionEntry = z.object({
  expression: z.string(),
  line: z.number(),
  branch: z.string().default("true"),
  caller: z.string().optional(),
  hop: z.number().optional(),
})

/** Assignment schema shared by path assignments and caller assignments */
const AssignmentEntry = z.object({
  variable: z.string(),
  value: z.string(),
  line: z.number(),
  is_constant: z.boolean().default(false),
  caller: z.string().optional(),
  hop: z.number().optional(),
})

/** Result of CFG sub-path reachability analysis */
export const SubPathAnalysis = z.object({
  type: z.string().default(""),
  reachable: z.boolean(),
  conditions: z.array(ConditionEntry).default([]),
  assignments: z.array(AssignmentEntry).default([]),
  enclosing_conditions: z.array(ConditionEntry).default([]),
  interrupt_state_changes: z.array(InterruptStateChange).default([]),
  path_length: z.number().default(0),
  via_calls: z.array(z.string()).default([]),
  reason: z.string().optional(),
  // Inter-procedural caller-side data
  caller_conditions: z.array(ConditionEntry).default([]),
  caller_assignments: z.array(AssignmentEntry).default([]),
  caller_enclosing_conditions: z.array(ConditionEntry).default([]),
  call_chain: z.array(z.string()).default([]),
  has_multiple_call_sites: z.boolean().default(false),
})
export type SubPathAnalysis = z.infer<typeof SubPathAnalysis>

/** State at preemption point (between main_access1 and main_access2) */
const PreemptionStateSchema = z.object({
  active_conditions: z.array(ConditionEntry).default([]),
  active_assignments: z.array(AssignmentEntry).default([]),
  enclosing_conditions: z.array(ConditionEntry).default([]),
  short_circuit_constraints: z.array(ConditionEntry).default([]),
  caller_conditions: z.array(ConditionEntry).default([]),
  caller_assignments: z.array(AssignmentEntry).default([]),
  caller_enclosing_conditions: z.array(ConditionEntry).default([]),
}).optional()

/** Path feasibility analysis result for a violation */
export const PathAnalysis = z.object({
  sub_path_1: SubPathAnalysis,
  sub_path_2: SubPathAnalysis,
  sub_path_3: SubPathAnalysis,
  state_at_preemption: PreemptionStateSchema,
  interrupt_enabled: z.boolean().default(true),
  infeasibility_reason: z.string().optional(),
})
export type PathAnalysis = z.infer<typeof PathAnalysis>

/** A detected multi-variable atomicity violation */
export const AtomicityViolation = z.object({
  id: z.string(),
  pattern: ViolationPattern,
  correlated_group_id: z.string(),
  variables: z.array(z.string()),
  main_accesses: z.array(VariableAccess).default([]),
  interrupt_accesses: z.array(InterruptAccessPair).default([]),
  preemption_point: PreemptionPoint.optional(),
  feasibility: FeasibilityStatus.default("UNCHECKED"),
  path_constraint: z.string().default(""),
  path_analysis: PathAnalysis.optional(),
  severity: z.string().default("warning"),
  description: z.string().default(""),
})
export type AtomicityViolation = z.infer<typeof AtomicityViolation>

/** Minimal confirmed violation for multivar-confirmed.json output */
export const ConfirmedViolationAccess = z.object({
  variable: z.string(),
  access_type: AccessType,
  file: z.string(),
  line: z.number(),
  code: z.string(),
})
export type ConfirmedViolationAccess = z.infer<typeof ConfirmedViolationAccess>

export const ConfirmedViolation = z.object({
  id: z.string(),
  pattern: ViolationPattern,
  correlated_group_id: z.string(),
  variables: z.array(z.string()),
  description: z.string(),
  severity: z.string(),
  main_function: z.string(),
  isr_name: z.string(),
  main_accesses: z.array(ConfirmedViolationAccess),
  isr_accesses: z.array(ConfirmedViolationAccess),
})
export type ConfirmedViolation = z.infer<typeof ConfirmedViolation>
