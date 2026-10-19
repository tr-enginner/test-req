import { z } from "zod"
import { Defect } from "./defect"

/** Single atomic sub-item verification record */
export const SubItemRecord = z.object({
  id: z.string(),
  assertion: z.string(),
  code_locations: z.array(z.string()),
  req_specifies: z.string(),
  code_does: z.string(),
  dimensions: z.record(z.string(), z.string()), // D1..D10 → "MATCH" | "MISMATCH: reason"
  verdict: z.enum(["MATCH", "MISMATCH"]),
  defect_ids: z.array(z.string()).default([]),
})
export type SubItemRecord = z.infer<typeof SubItemRecord>

/** Per-requirement structured review record */
export const ReviewRecord = z.object({
  requirement_id: z.string(),
  requirement_title: z.string(),
  target_architecture: z.string().default("generic"),
  sub_items: z.array(SubItemRecord),
  d9_completeness: z.enum(["COMPLETE", "PARTIAL", "NO_IMPL"]),
  d9_detail: z.string().optional(),
  overall_verdict: z.enum(["CONSISTENT", "INCONSISTENT"]),
  defects: z.array(Defect).default([]),
})
export type ReviewRecord = z.infer<typeof ReviewRecord>
