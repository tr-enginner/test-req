import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs"
import { dirname, join } from "path"
import { ARTIFACT_PATHS } from "../shared/constants"
import { dedupeBy } from "../shared/dedup"
import { withFileLock } from "../shared/file-mutex"

function resolveArtifactPath(relativePath: string): string {
  return join(process.cwd(), relativePath)
}

interface FPEntry {
  raw_finding_id: string
  rule_id: string
  undecidable_category?: string
  file: string
  line: number
  reason: string
}

interface StandardsOnlyEntry {
  raw_finding_id: string
  rule_id: string
  file: string
  line: number
  reason: string
}

/**
 * sa_append_review_results — Atomically append false positives and/or
 * standards-only entries to their respective JSON files (concurrent-safe).
 *
 * Used by SA-Reviewer in page-by-page flush mode: after verifying each page
 * of findings, immediately persist FP and standards-only results so that
 * earlier pages can be reclaimed from context.
 */
export const saResultAppender: ToolDefinition = tool({
  description:
    "Atomically append false-positive and/or standards-only entries to " +
    "their respective JSON files (.matrix/data/false-positives.json and " +
    ".matrix/data/standards-only.json). Concurrent-safe via file locking. " +
    "Use after verifying each page of findings to flush results immediately.",
  args: {
    project_name: tool.schema
      .string()
      .describe("Project name for the report files"),
    false_positives: tool.schema
      .string()
      .optional()
      .describe(
        "JSON string of false-positive entries array. Each entry: " +
          "{ raw_finding_id, rule_id, undecidable_category?, file, line, reason }. " +
          "For large batches, prefer false_positives_file instead.",
      ),
    standards_only: tool.schema
      .string()
      .optional()
      .describe(
        "JSON string of standards-only entries array. Each entry: " +
          "{ raw_finding_id, rule_id, file, line, reason }. " +
          "For large batches, prefer standards_only_file instead.",
      ),
    false_positives_file: tool.schema
      .string()
      .optional()
      .describe(
        "Path to a JSON file containing the false-positive entries array. " +
          "Use this instead of false_positives to avoid large inline JSON in tool calls.",
      ),
    standards_only_file: tool.schema
      .string()
      .optional()
      .describe(
        "Path to a JSON file containing the standards-only entries array. " +
          "Use this instead of standards_only to avoid large inline JSON in tool calls.",
      ),
  },
  async execute({ project_name, false_positives, standards_only, false_positives_file, standards_only_file }) {
    const results: Record<string, unknown> = { status: "success" }

    // --- Resolve file-based inputs (override inline JSON), then delete temp files ---
    let fpTempPath: string | null = null
    let soTempPath: string | null = null
    const fpSource = false_positives_file
      ? (() => { try { fpTempPath = join(process.cwd(), false_positives_file as string); return readFileSync(fpTempPath, "utf-8") } catch { return null } })()
      : (false_positives as string | undefined)
    const soSource = standards_only_file
      ? (() => { try { soTempPath = join(process.cwd(), standards_only_file as string); return readFileSync(soTempPath, "utf-8") } catch { return null } })()
      : (standards_only as string | undefined)

    if (false_positives_file && !fpSource) {
      return JSON.stringify({ error: `Failed to read false_positives_file: ${false_positives_file}` })
    }
    if (standards_only_file && !soSource) {
      return JSON.stringify({ error: `Failed to read standards_only_file: ${standards_only_file}` })
    }

    // --- Append false positives ---
    if (fpSource) {
      let entries: FPEntry[]
      try {
        entries = JSON.parse(fpSource)
      } catch {
        return JSON.stringify({ error: "Failed to parse false_positives JSON" })
      }
      if (!Array.isArray(entries)) {
        return JSON.stringify({ error: "false_positives must be a JSON array" })
      }

      const fpPath = resolveArtifactPath(ARTIFACT_PATHS.FALSE_POSITIVES)
      const fpResult = await withFileLock(fpPath, () => {
        let db: {
          project_name: string
          generated_date: string
          tool: string
          summary: { total_violations_checked: number; false_positives_found: number }
          false_positives: FPEntry[]
        }

        if (existsSync(fpPath)) {
          try {
            db = JSON.parse(readFileSync(fpPath, "utf-8"))
          } catch {
            db = {
              project_name,
              generated_date: new Date().toISOString().split("T")[0]!,
              tool: "specchecker",
              summary: { total_violations_checked: 0, false_positives_found: 0 },
              false_positives: [],
            }
          }
        } else {
          db = {
            project_name,
            generated_date: new Date().toISOString().split("T")[0]!,
            tool: "specchecker",
            summary: { total_violations_checked: 0, false_positives_found: 0 },
            false_positives: [],
          }
        }

        db.false_positives.push(...entries)
        const deduped = dedupeBy(db.false_positives, (e) => e.raw_finding_id)
        db.false_positives = deduped.items
        db.summary.false_positives_found = db.false_positives.length

        const dir = dirname(fpPath)
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        writeFileSync(fpPath, JSON.stringify(db, null, 2), "utf-8")

        return { appended: entries.length, total: db.false_positives.length, deduplicated: deduped.removed }
      })

      results.false_positives = {
        file: ARTIFACT_PATHS.FALSE_POSITIVES,
        ...fpResult,
      }
    }

    // --- Append standards-only ---
    if (soSource) {
      let entries: StandardsOnlyEntry[]
      try {
        entries = JSON.parse(soSource)
      } catch {
        return JSON.stringify({ error: "Failed to parse standards_only JSON" })
      }
      if (!Array.isArray(entries)) {
        return JSON.stringify({ error: "standards_only must be a JSON array" })
      }

      const soPath = resolveArtifactPath(ARTIFACT_PATHS.STANDARDS_ONLY)
      const soResult = await withFileLock(soPath, () => {
        let db: {
          project_name: string
          generated_date: string
          tool: string
          summary: { total_violations_checked: number; standards_only_found: number }
          standards_only: StandardsOnlyEntry[]
        }

        if (existsSync(soPath)) {
          try {
            db = JSON.parse(readFileSync(soPath, "utf-8"))
          } catch {
            db = {
              project_name,
              generated_date: new Date().toISOString().split("T")[0]!,
              tool: "specchecker",
              summary: { total_violations_checked: 0, standards_only_found: 0 },
              standards_only: [],
            }
          }
        } else {
          db = {
            project_name,
            generated_date: new Date().toISOString().split("T")[0]!,
            tool: "specchecker",
            summary: { total_violations_checked: 0, standards_only_found: 0 },
            standards_only: [],
          }
        }

        db.standards_only.push(...entries)
        const deduped = dedupeBy(db.standards_only, (e) => e.raw_finding_id)
        db.standards_only = deduped.items
        db.summary.standards_only_found = db.standards_only.length

        const dir = dirname(soPath)
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        writeFileSync(soPath, JSON.stringify(db, null, 2), "utf-8")

        return { appended: entries.length, total: db.standards_only.length, deduplicated: deduped.removed }
      })

      results.standards_only = {
        file: ARTIFACT_PATHS.STANDARDS_ONLY,
        ...soResult,
      }
    }

    if (!fpSource && !soSource) {
      return JSON.stringify({
        error: "At least one of false_positives or standards_only must be provided",
      })
    }

    // --- Clean up temp files after successful append ---
    if (fpTempPath) { try { unlinkSync(fpTempPath) } catch { /* ignore */ } }
    if (soTempPath) { try { unlinkSync(soTempPath) } catch { /* ignore */ } }

    return JSON.stringify(results)
  },
})
