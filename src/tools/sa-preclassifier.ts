import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, join } from "path"
import { ARTIFACT_PATHS } from "../shared/constants"
import { UNDECIDABLE_RULES } from "../shared/undecidable-rules"
import type { SARawFinding } from "../schema/sa-raw-findings"
import { SARawFindingsReport } from "../schema/sa-raw-findings"
import type {
  PreClassification,
  PreClassifiedFinding,
} from "../schema/sa-preclassification"

function resolveArtifactPath(relativePath: string): string {
  return join(process.cwd(), relativePath)
}

/**
 * Pre-classification decision matrix (programmatic, zero LLM calls).
 *
 * | check_type     | undecidable? | severity          | → classification     |
 * |----------------|-------------|-------------------|----------------------|
 * | runtime_error  | any         | any               | SUSPECTED_DEFECT     |
 * | fault_pattern  | any         | critical/major    | SUSPECTED_DEFECT     |
 * | fault_pattern  | yes         | minor/suggestion  | SUSPECTED_FP         |
 * | fault_pattern  | no          | minor/suggestion  | STANDARDS_ONLY       |
 * | rule_check     | yes         | any               | SUSPECTED_FP         |
 * | rule_check     | no          | any               | STANDARDS_ONLY       |
 */
function classifyFinding(finding: SARawFinding): {
  classification: PreClassification
  reason: string
  undecidable_category?: string
} {
  const checkType = finding.check_type ?? "rule_check"
  const ruleInfo = UNDECIDABLE_RULES.get(finding.rule_id)
  const isUndecidable = ruleInfo !== undefined
  const undecidableCategory = ruleInfo?.category
  const severity = finding.severity
  const isHighSeverity = severity === "critical" || severity === "major"

  // runtime_error → always suspected defect
  if (checkType === "runtime_error") {
    return {
      classification: "suspected_defect",
      reason: `runtime_error check_type (path-sensitive analysis)`,
      undecidable_category: undecidableCategory,
    }
  }

  // fault_pattern
  if (checkType === "fault_pattern") {
    if (isHighSeverity) {
      return {
        classification: "suspected_defect",
        reason: `fault_pattern with ${severity} severity`,
        undecidable_category: undecidableCategory,
      }
    }
    if (isUndecidable) {
      return {
        classification: "suspected_fp",
        reason: `fault_pattern minor/suggestion + undecidable rule (${undecidableCategory})`,
        undecidable_category: undecidableCategory,
      }
    }
    return {
      classification: "standards_only",
      reason: `fault_pattern minor/suggestion + decidable rule`,
    }
  }

  // rule_check (default)
  if (isUndecidable) {
    return {
      classification: "suspected_fp",
      reason: `rule_check undecidable rule (${undecidableCategory})`,
      undecidable_category: undecidableCategory,
    }
  }

  // rule_check + decidable → standards_only
  return {
    classification: "standards_only",
    reason: `rule_check decidable rule`,
  }
}

/**
 * sa_preclassify — Programmatically pre-classify raw SpecChecker findings.
 *
 * Reads sa-raw-findings.json and applies the decision matrix to split findings
 * into three buckets: suspected_defect, suspected_fp, standards_only.
 * Only suspected_defect and suspected_fp need LLM verification; standards_only
 * items are written directly to standards-only.json.
 */
export const saPreclassifier: ToolDefinition = tool({
  description:
    "Pre-classify SpecChecker raw findings from sa-raw-findings.json into " +
    "three categories (suspected_defect, suspected_fp, standards_only) using " +
    "a programmatic decision matrix. Zero LLM token cost. Writes " +
    "sa-preclassification.json and standards-only.json. Returns a summary " +
    "with counts — does NOT return full finding data to avoid context bloat.",
  args: {},
  async execute() {
    const rawPath = resolveArtifactPath(ARTIFACT_PATHS.SA_RAW_FINDINGS)

    if (!existsSync(rawPath)) {
      return JSON.stringify({
        error: "sa-raw-findings.json not found",
        hint: "Run static-analyzer first to generate raw findings",
      })
    }

    // Load and validate raw findings
    let report: SARawFindingsReport
    try {
      const raw = readFileSync(rawPath, "utf-8")
      const parsed = SARawFindingsReport.safeParse(JSON.parse(raw))
      if (!parsed.success) {
        return JSON.stringify({
          error: "Failed to validate sa-raw-findings.json",
          details: parsed.error.message,
        })
      }
      report = parsed.data
    } catch (e: unknown) {
      return JSON.stringify({
        error: "Failed to read sa-raw-findings.json",
        details: e instanceof Error ? e.message : String(e),
      })
    }

    // Classify each finding
    const suspectedDefects: PreClassifiedFinding[] = []
    const suspectedFPs: PreClassifiedFinding[] = []
    const standardsOnly: PreClassifiedFinding[] = []

    for (const finding of report.violations) {
      const { classification, reason, undecidable_category } =
        classifyFinding(finding)

      const classified: PreClassifiedFinding = {
        ...finding,
        pre_classification: classification,
        pre_classification_reason: reason,
        ...(undecidable_category ? { undecidable_category } : {}),
      }

      switch (classification) {
        case "suspected_defect":
          suspectedDefects.push(classified)
          break
        case "suspected_fp":
          suspectedFPs.push(classified)
          break
        case "standards_only":
          standardsOnly.push(classified)
          break
      }
    }

    // Write sa-preclassification.json (only defect + FP candidates for LLM review)
    const preclassPath = resolveArtifactPath(
      ARTIFACT_PATHS.SA_PRECLASSIFICATION,
    )
    const preclassDir = dirname(preclassPath)
    if (!existsSync(preclassDir)) mkdirSync(preclassDir, { recursive: true })

    const preclassReport = {
      project_name: report.project_name,
      total: report.violations.length,
      breakdown: {
        suspected_defect: suspectedDefects.length,
        suspected_fp: suspectedFPs.length,
        standards_only: standardsOnly.length,
      },
      findings: {
        suspected_defect: suspectedDefects,
        suspected_fp: suspectedFPs,
      },
    }
    writeFileSync(preclassPath, JSON.stringify(preclassReport, null, 2), "utf-8")

    // Write standards-only.json directly (these bypass LLM review)
    const standardsOnlyPath = resolveArtifactPath(
      ARTIFACT_PATHS.STANDARDS_ONLY,
    )
    const standardsOnlyReport = {
      project_name: report.project_name,
      generated_date: new Date().toISOString().split("T")[0],
      tool: "specchecker" as const,
      summary: {
        total_violations_checked: report.violations.length,
        standards_only_found: standardsOnly.length,
      },
      standards_only: standardsOnly.map((f) => ({
        raw_finding_id: f.id,
        rule_id: f.rule_id,
        file: f.file,
        line: f.line,
        reason: f.pre_classification_reason,
      })),
    }
    writeFileSync(
      standardsOnlyPath,
      JSON.stringify(standardsOnlyReport, null, 2),
      "utf-8",
    )

    // Initialize empty false-positives.json (will be populated incrementally by sa_append_review_results)
    const fpPath = resolveArtifactPath(ARTIFACT_PATHS.FALSE_POSITIVES)
    const fpReport = {
      project_name: report.project_name,
      generated_date: new Date().toISOString().split("T")[0],
      tool: "specchecker" as const,
      summary: {
        total_violations_checked: report.violations.length,
        false_positives_found: 0,
      },
      false_positives: [] as unknown[],
    }
    writeFileSync(fpPath, JSON.stringify(fpReport, null, 2), "utf-8")

    // Return summary only (no full data — avoid context bloat)
    const total = report.violations.length
    const pctStandards =
      total > 0
        ? ((standardsOnly.length / total) * 100).toFixed(1)
        : "0.0"

    return JSON.stringify({
      status: "success",
      total_findings: total,
      breakdown: {
        suspected_defect: suspectedDefects.length,
        suspected_fp: suspectedFPs.length,
        standards_only: standardsOnly.length,
      },
      standards_only_percentage: `${pctStandards}%`,
      files_written: [
        ARTIFACT_PATHS.SA_PRECLASSIFICATION,
        ARTIFACT_PATHS.STANDARDS_ONLY,
        ARTIFACT_PATHS.FALSE_POSITIVES,
      ],
      next_steps:
        "Use sa_fetch_findings to fetch suspected_defect and suspected_fp " +
        "findings page by page (offset+limit). After verifying each page, " +
        "IMMEDIATELY flush results: functional defects → append_defects, " +
        "false positives and standards-only downgrades → sa_append_review_results. " +
        "Do NOT accumulate results across pages. Standards-only findings from " +
        "pre-classification have already been written to standards-only.json.",
    })
  },
})
