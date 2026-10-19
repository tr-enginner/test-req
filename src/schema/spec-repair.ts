import { z } from "zod"

// SpecChecker rule
export const SpecRule = z.object({
  id: z.string(),           // CID format, e.g. "CID181"
  name: z.string(),         // Chinese rule name
  category_id: z.string(),  // C001-C016
  category_name: z.string(),// Chinese category name
  conformance: z.string(),  // L001(强制)/L002(推荐)/L004(其他)
  priority: z.string(),     // P001(高)/P002(中)/P003(低)
  description: z.string(),  // Full rule description
})
export type SpecRule = z.infer<typeof SpecRule>

export const SpecRuleset = z.object({
  rules: z.array(SpecRule),
  categories: z.record(z.string(), z.string()),  // C001 -> "声明定义类"
})
export type SpecRuleset = z.infer<typeof SpecRuleset>

// Fixability classification
export const Fixability = z.enum(["auto_fixable", "needs_review", "unfixable"])
export type Fixability = z.infer<typeof Fixability>

// Risk level for repair patches
export const RiskLevel = z.enum(["safe", "low", "medium", "high", "dangerous"])
export type RiskLevel = z.infer<typeof RiskLevel>

// Repair confidence
export const RepairConfidence = z.enum(["high", "medium", "low"])
export type RepairConfidence = z.infer<typeof RepairConfidence>

// A single patch hunk
export const PatchHunk = z.object({
  file: z.string(),
  start_line: z.number(),
  end_line: z.number(),
  original_code: z.string(),
  repaired_code: z.string(),
})
export type PatchHunk = z.infer<typeof PatchHunk>

// Repair rationale
export const RepairRationale = z.object({
  rule_description: z.string(),
  violation_reason: z.string(),
  fix_reason: z.string(),
  safety_argument: z.string(),
})
export type RepairRationale = z.infer<typeof RepairRationale>

// A single repair suggestion
export const RepairSuggestion = z.object({
  id: z.string(),
  rule_id: z.string(),
  fixability: Fixability,
  risk_level: RiskLevel,
  confidence: RepairConfidence,
  summary: z.string(),
  rationale: RepairRationale,
  patches: z.array(PatchHunk),
  is_auto_applicable: z.boolean(),
  skill_used: z.string().optional(),
  status: z.enum(["pending", "accepted", "rejected"]).default("pending"),
})
export type RepairSuggestion = z.infer<typeof RepairSuggestion>

// Verification result
export const VerificationResult = z.object({
  passed: z.boolean(),
  iterations_used: z.number(),
  original_issue_resolved: z.boolean().optional(),
  new_issues_introduced: z.number().default(0),
  message: z.string().optional(),
})
export type VerificationResult = z.infer<typeof VerificationResult>

// Repair plan (collection of suggestions)
export const RepairPlan = z.object({
  project_name: z.string(),
  total_violations: z.number(),
  suggestions: z.array(RepairSuggestion),
  summary: z.object({
    auto_fixable: z.number(),
    needs_review: z.number(),
    unfixable: z.number(),
    total_suggestions: z.number(),
    safe_suggestions: z.number(),
  }),
})
export type RepairPlan = z.infer<typeof RepairPlan>
