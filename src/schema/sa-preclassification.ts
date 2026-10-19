import { z } from "zod"
import { SARawFinding } from "./sa-raw-findings"

/** Pre-classification result assigned by the programmatic sa_preclassify tool */
export const PreClassification = z.enum([
  "suspected_defect",
  "suspected_fp",
  "standards_only",
])
export type PreClassification = z.infer<typeof PreClassification>

/** A raw finding enriched with pre-classification metadata */
export const PreClassifiedFinding = SARawFinding.extend({
  pre_classification: PreClassification,
  pre_classification_reason: z.string(), // e.g. "runtime_error check_type"
  undecidable_category: z.string().optional(),
})
export type PreClassifiedFinding = z.infer<typeof PreClassifiedFinding>

/** Full pre-classification report — only suspected_defect and suspected_fp
 *  are stored here; standards_only findings are written directly to standards-only.json */
export const PreClassificationReport = z.object({
  project_name: z.string(),
  total: z.number(),
  breakdown: z.object({
    suspected_defect: z.number(),
    suspected_fp: z.number(),
    standards_only: z.number(),
  }),
  findings: z.object({
    suspected_defect: z.array(PreClassifiedFinding),
    suspected_fp: z.array(PreClassifiedFinding),
  }),
})
export type PreClassificationReport = z.infer<typeof PreClassificationReport>
