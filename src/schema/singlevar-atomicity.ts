import { z } from "zod"
import {
  AccessType,
  AtomSourceLocation,
  FeasibilityStatus,
  InterruptStateChange,
  SubPathAnalysis,
  VariableAccess,
} from "./multivar-atomicity"

/**
 * Single-variable atomicity violation schemas.
 *
 * Distinct from `multivar-atomicity.ts` (multi-variable): targets the 4 single-variable
 * 3-access interleaving patterns from Lu et al. AVIO / intAtom (ISSTA '22):
 *   RWR, RWW, WRW, WWR
 *
 * Plus WWW (two consecutive writes interrupted by ISR write) which intAtom
 * groups under multi-variable TUP_WWWW but is treated here as a single-var
 * case when both writes target the same variable.
 *
 * Shared concepts (VariableAccess, AtomSourceLocation, sub-path analysis)
 * are reused from `multivar-atomicity.ts` to keep cross-agent reports unified per
 * the conflict-detector-contracts.md spec.
 */

/** Access interleaving pattern for single-variable atomicity violation */
export const SinglevarPattern = z.enum([
  "RWR", // local read, ISR write, local read   — two reads see different values
  "RWW", // local read, ISR write, local write  — lost update
  "WRW", // local write, ISR read, local write  — ISR sees intermediate
  "WWR", // local write, ISR write, local read  — local read sees ISR overwrite
  "WWW", // local write, ISR write, local write — final state inconsistent
])
export type SinglevarPattern = z.infer<typeof SinglevarPattern>

/** Three accesses composing a single-variable violation candidate */
export const SinglevarAccessTriple = z.object({
  /** First local access (in low-priority context: main task or low-pri ISR) */
  local1: VariableAccess,
  /** Remote access from the higher-priority context (typically ISR) */
  remote: VariableAccess,
  /** Second local access — must be in the same function as local1 by default;
   *  cross-function relaxation is governed by `cross_function` flag below. */
  local2: VariableAccess,
})
export type SinglevarAccessTriple = z.infer<typeof SinglevarAccessTriple>

/** Cross-function relaxation metadata. When local1 and local2 are not in the
 *  same function, this records the validated call chain. */
export const CrossFunctionRelaxation = z.object({
  /** Functions on the call path from local1 site to local2 site, inclusive */
  call_chain: z.array(z.string()),
  /** Depth of the chain (call_chain.length); used as confidence decay factor */
  depth: z.number(),
  /** Whether any function on the chain enables/disables interrupts */
  has_interrupt_state_change: z.boolean().default(false),
  /** Whether any function on the chain yields the CPU (sleep, taskYield, etc.) */
  has_yield_call: z.boolean().default(false),
  /** Whether any function on the chain spins on a shared variable */
  has_spin_wait: z.boolean().default(false),
  /** Confidence multiplier applied due to relaxation (1.0 = same function) */
  confidence_multiplier: z.number().default(1.0),
})
export type CrossFunctionRelaxation = z.infer<typeof CrossFunctionRelaxation>

/** A pair of consecutive local accesses to the same variable in the low-priority
 *  context. Mirrors intAtom's "consecutive access pair" (e_p, e_c). */
export const ConsecutiveLocalPair = z.object({
  id: z.string(),
  variable_name: z.string(),
  /** Normalized variable identity — for struct members like CAN.InitCount4s
   *  this stores the alias-normalized canonical form. */
  canonical_var: z.string(),
  local1: VariableAccess,
  local2: VariableAccess,
  /** True when local1 and local2 are in the same function (intAtom strict mode) */
  same_function: z.boolean(),
  cross_function: CrossFunctionRelaxation.optional(),
  /** Set when this pair was filtered as infeasible by intAtom Stage 2.
   *  An infeasible pair means programmer has no atomicity intention. */
  pair_feasibility: FeasibilityStatus.default("UNCHECKED"),
  /** Reason for infeasibility (e.g., "guarded by mutually exclusive flag") */
  pair_infeasibility_reason: z.string().optional(),
})
export type ConsecutiveLocalPair = z.infer<typeof ConsecutiveLocalPair>

/** A remote access in an ISR that may conflict with a local access pair */
export const RemoteAccess = z.object({
  isr_name: z.string(),
  priority: z.number().default(0),
  access: VariableAccess,
})
export type RemoteAccess = z.infer<typeof RemoteAccess>

/** intAtom interrupt summary — symbolic constraints captured at each
 *  representative preemption point inside an ISR, reused across multiple
 *  violation candidates. */
export const InterruptSummaryEntry = z.object({
  /** Representative preemption point location within the ISR */
  preemption_point: AtomSourceLocation,
  /** Path condition from ISR entry to this preemption point */
  pc_to_point: z.array(z.string()).default([]),
  /** Symbolic state of relevant globals at this point (var -> SMT expr string) */
  exit_state: z.record(z.string(), z.string()).default({}),
  /** Interrupt enable/disable changes on the path */
  interrupt_state_changes: z.array(InterruptStateChange).default([]),
  /** Whether this point is selected as representative or covered by another */
  is_representative: z.boolean().default(true),
  /** ID of the representative point that covers this one (when not representative) */
  represented_by: z.string().optional(),
})
export type InterruptSummaryEntry = z.infer<typeof InterruptSummaryEntry>

/** Symbolic summary of a single ISR — intAtom's per-interrupt summary */
export const InterruptSummary = z.object({
  isr_name: z.string(),
  /** Entries indexed by representative preemption points */
  entries: z.array(InterruptSummaryEntry),
  /** All accesses to shared variables in this ISR (read set + write set) */
  shared_accesses: z.array(VariableAccess).default([]),
  /** When this summary was built — used for cache invalidation */
  built_at: z.string(),
})
export type InterruptSummary = z.infer<typeof InterruptSummary>

/** Variable alias normalization information.
 *
 *  Joern struct/array support is shallow — this layer records the rules used
 *  to treat `CAN.InitCount4s`, `T_Can_SlowRmt[52]`, `*ptr_to_x` as the same
 *  canonical variable for matching purposes.
 */
export const AliasRule = z.enum([
  "EXACT",                  // exact symbol match
  "STRUCT_FIELD",           // CAN.InitCount4s == CAN.InitCount4s; CAN.foo != CAN.bar
  "ARRAY_ELEMENT_FIXED",    // arr[5] == arr[5]; arr[i] uses index-symbolic match
  "ARRAY_ELEMENT_SYMBOLIC", // arr[i] aliases arr[j] (conservative: same array)
  "POINTER_DEREF",          // *p resolved via points-to to known location
  "MMIO_REGISTER",          // *(volatile uint32_t*)0x4000 normalized to register name
])
export type AliasRule = z.infer<typeof AliasRule>

export const AliasNormalization = z.object({
  original_expression: z.string(),
  canonical_name: z.string(),
  rule: AliasRule,
  confidence: z.number().default(1.0),
  /** Aliasing notes for the report (e.g., "array index symbolic — over-approximation") */
  note: z.string().optional(),
})
export type AliasNormalization = z.infer<typeof AliasNormalization>

/** Loop context for one or more of the three accesses */
export const LoopContext = z.object({
  loop_header_line: z.number(),
  loop_kind: z.enum(["for", "while", "do_while"]),
  /** Inferred iteration bound; null = unknown (over-approximate) */
  iteration_bound: z.union([z.number(), z.null()]).default(null),
  /** Inference source */
  bound_source: z.enum(["constant", "macro", "llm_inferred", "unknown"]).default("unknown"),
  /** Whether path condition simplification ignored loop-variable constraints
   *  (per intAtom's documented FP source — see paper §4.2 benchmark FPs). */
  path_condition_simplified: z.boolean().default(false),
})
export type LoopContext = z.infer<typeof LoopContext>

/** A single-variable atomicity violation candidate (post Stage 1) */
export const SinglevarViolationCandidate = z.object({
  id: z.string(),
  pattern: SinglevarPattern,
  variable_name: z.string(),
  canonical_var: z.string(),
  alias_info: AliasNormalization.optional(),
  consecutive_pair_id: z.string(),
  accesses: SinglevarAccessTriple,
  remote_isr: RemoteAccess,
  /** Loop contexts for any of the three accesses (empty if all are loop-free) */
  loop_contexts: z.array(LoopContext).default([]),
  /** Cross-function relaxation if local1/local2 span functions */
  cross_function: CrossFunctionRelaxation.optional(),
  /** Structural evidence score before Stage 2/3 */
  structural_score: z.number().default(0),
})
export type SinglevarViolationCandidate = z.infer<typeof SinglevarViolationCandidate>

/** Final single-variable atomicity violation (post Stage 3) */
export const SinglevarViolation = z.object({
  id: z.string(),
  pattern: SinglevarPattern,
  variable_name: z.string(),
  canonical_var: z.string(),
  alias_info: AliasNormalization.optional(),
  accesses: SinglevarAccessTriple,
  remote_isr: RemoteAccess,

  feasibility: FeasibilityStatus,
  severity: z.enum(["critical", "major", "info"]),
  description: z.string(),

  /** Path analysis result (reuses multi-var schema for cross-agent consistency) */
  path_analysis: z
    .object({
      sub_path_local1_to_remote: SubPathAnalysis,
      sub_path_remote_internal: SubPathAnalysis,
      sub_path_remote_to_local2: SubPathAnalysis,
      interrupt_enabled_at_preemption: z.boolean().default(true),
      infeasibility_reason: z.string().optional(),
    })
    .optional(),

  /** intAtom Stage 2 result: whether local1-local2 pair was deemed atomic-intentioned */
  atomic_intent: z.object({
    has_intent: z.boolean(),
    inferred_by: z.enum(["path_mutex", "llm_judgment", "both", "unchecked"]),
    llm_judgment: z.enum(["STRONG", "WEAK", "NONE"]).nullable().default(null),
    llm_reason: z.string().nullable().default(null),
    /** When inferred_by includes path_mutex, this records the constraint */
    mutex_constraint: z.string().nullable().default(null),
  }),

  /** Confidence breakdown — fed into evidence_breakdown for defects.json */
  confidence: z.number(),
  evidence_breakdown: z.record(z.string(), z.number()).default({}),

  /** Suggested fix per benchmark fix_strategy taxonomy */
  fix_suggestion: z.object({
    strategy: z.enum([
      "disable_global_interrupt",
      "disable_specific_interrupt",
      "copy_under_protection",
      "atomic_intrinsic",
      "redesign",
    ]),
    rationale: z.string(),
  }),
})
export type SinglevarViolation = z.infer<typeof SinglevarViolation>

/** Top-level output of the singlevar-atomicity tool chain */
export const SinglevarAnalysisResult = z.object({
  project_name: z.string(),
  cpg_path: z.string(),
  timestamp: z.string(),
  source_hash: z.string(),

  /** Stage 1 output: all consecutive local pairs found in tasks/ISRs */
  consecutive_pairs: z.array(ConsecutiveLocalPair),
  /** Stage 1 output: all violation candidates matching one of 5 patterns */
  candidates: z.array(SinglevarViolationCandidate),
  /** Stage 3 output: interrupt summaries built per ISR */
  interrupt_summaries: z.array(InterruptSummary).default([]),
  /** Stage 3 output: final violations after path-feasibility filtering */
  violations: z.array(SinglevarViolation),

  summary: z.object({
    total_pairs: z.number(),
    pairs_dropped_by_path_mutex: z.number(),
    total_candidates: z.number(),
    candidates_dropped_by_stage3: z.number(),
    confirmed: z.number(),
    unknown: z.number(),
    infeasible: z.number(),
    by_pattern: z.record(SinglevarPattern, z.number()).default({} as Record<SinglevarPattern, number>),
    timing: z.object({
      stage1_ms: z.number().default(0),
      stage2_ms: z.number().default(0),
      stage3_ms: z.number().default(0),
      total_ms: z.number().default(0),
    }),
  }),
})
export type SinglevarAnalysisResult = z.infer<typeof SinglevarAnalysisResult>

// Re-exports for convenience
export { AccessType, FeasibilityStatus, VariableAccess }
