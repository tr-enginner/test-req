import { z } from "zod"

export const Phase6PreparedTemplateBaseline = z.object({
  test_type: z.string(),
  project_type: z.string(),
  template_key: z.string(),
  template_source: z.enum(["markdown", "legacy", "builtin", "unresolved"]),
  template_file: z.string().optional(),
  template_hash: z.string().optional(),
  template_index_file: z.string().optional(),
  template_domain: z.string().optional(),
  template_selection_reason: z.string().optional(),
  general_rules: z.array(z.string()).default([]),
  type_rules: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
})
export type Phase6PreparedTemplateBaseline = z.infer<typeof Phase6PreparedTemplateBaseline>

export const Phase6PreparedCoverage = z.object({
  covered_requirement_ids: z.array(z.string()).default([]),
  uncovered_requirement_ids: z.array(z.string()).default([]),
})
export type Phase6PreparedCoverage = z.infer<typeof Phase6PreparedCoverage>

export const Phase6PreparedBrokenLink = z.object({
  case_id: z.string(),
  field: z.string(),
  referenced_id: z.string(),
  message: z.string(),
})
export type Phase6PreparedBrokenLink = z.infer<typeof Phase6PreparedBrokenLink>

export const Phase6PreparedPathMismatch = z.object({
  case_id: z.string(),
  correspond_fun_id: z.string(),
  expected_path: z.string(),
  actual_path: z.string(),
})
export type Phase6PreparedPathMismatch = z.infer<typeof Phase6PreparedPathMismatch>

export const Phase6PreparedRelatedRequirementMismatch = z.object({
  case_id: z.string(),
  correspond_fun_id: z.string(),
  expected_ids: z.array(z.string()).default([]),
  actual_ids: z.array(z.string()).default([]),
})
export type Phase6PreparedRelatedRequirementMismatch = z.infer<typeof Phase6PreparedRelatedRequirementMismatch>

export const Phase6PreparedPlaceholder = z.object({
  case_id: z.string(),
  correspond_fun_id: z.string(),
  location: z.string(),
  placeholders: z.array(z.string()).default([]),
})
export type Phase6PreparedPlaceholder = z.infer<typeof Phase6PreparedPlaceholder>

export const Phase6PreparedFieldIssue = z.object({
  case_id: z.string(),
  field: z.string(),
  message: z.string(),
})
export type Phase6PreparedFieldIssue = z.infer<typeof Phase6PreparedFieldIssue>

export const Phase6PreparedSemanticValidationFailure = z.object({
  case_id: z.string(),
  correspond_fun_id: z.string(),
  errors: z.array(z.string()).default([]),
})
export type Phase6PreparedSemanticValidationFailure = z.infer<typeof Phase6PreparedSemanticValidationFailure>

export const Phase6PreparedCandidateIssue = z.object({
  severity: z.enum(["blocking", "major", "minor"]),
  category: z.string(),
  description: z.string(),
  suggestion: z.string().optional(),
  count: z.number().int().nonnegative().optional(),
  sample_ids: z.array(z.string()).default([]),
  sample_locations: z.array(z.string()).default([]),
})
export type Phase6PreparedCandidateIssue = z.infer<typeof Phase6PreparedCandidateIssue>

export const Phase6PreparedSummary = z.object({
  total_requirements: z.number().int().nonnegative(),
  total_cases: z.number().int().nonnegative(),
  covered_requirements: z.number().int().nonnegative(),
  uncovered_requirements: z.number().int().nonnegative(),
  broken_requirement_links: z.number().int().nonnegative(),
  path_mismatches: z.number().int().nonnegative(),
  related_requirement_mismatches: z.number().int().nonnegative(),
  empty_mandatory_fields: z.number().int().nonnegative(),
  unclear_test_purposes: z.number().int().nonnegative(),
  unresolved_placeholders: z.number().int().nonnegative(),
  semantic_validation_failures: z.number().int().nonnegative(),
})
export type Phase6PreparedSummary = z.infer<typeof Phase6PreparedSummary>

export const Phase6CaseReviewPrepared = z.object({
  status: z.enum(["success", "error"]),
  generated_at: z.string(),
  confirmation_tests_file: z.string(),
  test_requirements_file: z.string(),
  project_type: z.string(),
  summary: Phase6PreparedSummary.optional(),
  coverage: Phase6PreparedCoverage.optional(),
  template_baselines: z.array(Phase6PreparedTemplateBaseline).default([]),
  broken_links: z.array(Phase6PreparedBrokenLink).default([]),
  path_mismatches: z.array(Phase6PreparedPathMismatch).default([]),
  related_requirement_mismatches: z.array(Phase6PreparedRelatedRequirementMismatch).default([]),
  unresolved_placeholders: z.array(Phase6PreparedPlaceholder).default([]),
  field_issues: z.array(Phase6PreparedFieldIssue).default([]),
  semantic_validation_failures: z.array(Phase6PreparedSemanticValidationFailure).default([]),
  candidate_issues: z.array(Phase6PreparedCandidateIssue).default([]),
  warnings: z.array(z.string()).default([]),
  errors: z.array(z.string()).default([]),
})
export type Phase6CaseReviewPrepared = z.infer<typeof Phase6CaseReviewPrepared>
