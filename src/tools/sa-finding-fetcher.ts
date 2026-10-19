import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { ARTIFACT_PATHS } from "../shared/constants"
import { UNDECIDABLE_RULES } from "../shared/undecidable-rules"
import { PreClassificationReport } from "../schema/sa-preclassification"

function resolveArtifactPath(relativePath: string): string {
  return join(process.cwd(), relativePath)
}

/**
 * sa_fetch_findings — Paginated extraction of pre-classified findings.
 *
 * Reads sa-preclassification.json and returns a slice of findings from
 * the specified category (suspected_defect or suspected_fp) using
 * offset + limit pagination. Avoids loading the entire file into
 * agent context.
 */
export const saFindingFetcher: ToolDefinition = tool({
  description:
    "Fetch a paginated batch of pre-classified findings from " +
    "sa-preclassification.json. Specify category (suspected_defect or " +
    "suspected_fp), offset, and limit. Returns the slice plus total/remaining " +
    "counts. Use this instead of reading the full file to avoid context bloat.",
  args: {
    category: tool.schema
      .enum(["suspected_defect", "suspected_fp"])
      .describe("Which pre-classification category to fetch from"),
    offset: tool.schema
      .number()
      .optional()
      .describe("Starting index (0-based). Default: 0"),
    limit: tool.schema
      .number()
      .optional()
      .describe("Number of findings to return. Default: 10, max: 50"),
  },
  async execute(args) {
    const preclassPath = resolveArtifactPath(
      ARTIFACT_PATHS.SA_PRECLASSIFICATION,
    )

    if (!existsSync(preclassPath)) {
      return JSON.stringify({
        error: "sa-preclassification.json not found",
        hint: "Run sa_preclassify first to generate pre-classification data",
      })
    }

    let report: PreClassificationReport
    try {
      const raw = readFileSync(preclassPath, "utf-8")
      const parsed = PreClassificationReport.safeParse(JSON.parse(raw))
      if (!parsed.success) {
        return JSON.stringify({
          error: "Failed to validate sa-preclassification.json",
          details: parsed.error.message,
        })
      }
      report = parsed.data
    } catch (e: unknown) {
      return JSON.stringify({
        error: "Failed to read sa-preclassification.json",
        details: e instanceof Error ? e.message : String(e),
      })
    }

    const category = args.category as "suspected_defect" | "suspected_fp"
    const offset = (args.offset as number | undefined) ?? 0
    const limit = Math.min((args.limit as number | undefined) ?? 10, 50)

    const findings = report.findings[category]
    const slice = findings.slice(offset, offset + limit)
    const returned = slice.length

    // Inject per-finding undecidable rule metadata so page workers get
    // rule_name + fp_guidance without needing the full 139-rule table
    const enrichedSlice = slice.map((f) => {
      if (!f.undecidable_category) return f
      const ruleInfo = UNDECIDABLE_RULES.get(f.rule_id)
      if (!ruleInfo) return f
      return {
        ...f,
        rule_name: ruleInfo.rule_name,
        fp_guidance: ruleInfo.fp_guidance,
      }
    })

    const instruction = `Process all ${returned} findings above individually, then flush results with append_defects and/or sa_append_review_results.`

    return JSON.stringify({
      category,
      returned,
      findings: enrichedSlice,
      instruction,
    })
  },
})
