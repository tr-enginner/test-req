import { z } from "zod"

/** Review issue */
export const ReviewIssue = z.object({
  severity: z.enum(["blocking", "major", "minor"]),
  description: z.string(),
  location: z.string().optional(),
  suggestion: z.string().optional(),
})
export type ReviewIssue = z.infer<typeof ReviewIssue>

/** Review record */
export const ReviewRecord = z.object({
  id: z.string(),
  phase: z.string(),
  target_artifact: z.string(),
  verdict: z.enum(["PASS", "REVISE"]),
  issues: z.array(ReviewIssue),
  reviewer: z.string(),
  review_date: z.string(),
})
export type ReviewRecord = z.infer<typeof ReviewRecord>
