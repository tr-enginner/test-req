import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, join } from "path"
import { Defect, DefectDatabase } from "../schema/defect"
import { ARTIFACT_PATHS } from "../shared/constants"
import { dedupeBy } from "../shared/dedup"
import { withFileLock } from "../shared/file-mutex"

function resolveArtifactPath(relativePath: string): string {
  return join(process.cwd(), relativePath)
}

function defectDedupKey(defect: Defect): string {
  return defect.raw_finding_id
    ? `${defect.source}:raw:${defect.raw_finding_id}`
    : `${defect.source}:id:${defect.id}`
}

/**
 * append_defects — Atomically append defects to defects.json (concurrent-safe).
 *
 * Multiple agents (Code-Review Summary, StaticAnalyzer, ISR-Reviewer) may write defects
 * in parallel during Phase 3. This tool serializes access via an async mutex
 * to prevent data loss from concurrent read-modify-write.
 */
export const defectAppender: ToolDefinition = tool({
  description:
    "Atomically append defects to .matrix/data/defects.json with concurrent-safe " +
    "read-modify-write. Use this instead of the write tool whenever you need to add " +
    "defects to defects.json. Supports two modes: (1) append new defects from a " +
    "specific source while preserving all other sources, (2) replace all defects from " +
    "a specific source with a new set. Always recalculates the summary.",
  args: {
    project_name: tool.schema
      .string()
      .describe("Project name for the DefectDatabase"),
    defects: tool.schema
      .string()
      .describe(
        "JSON string of Defect[] array to append/replace. Each defect must follow " +
          "the Defect schema (id, source, severity, category, location, title, " +
          "description, detected_by, detected_date, etc.)",
      ),
    replace_source: tool.schema
      .string()
      .optional()
      .describe(
        "If provided, remove all existing defects with this source value before " +
          "appending the new ones. Use this when an agent produces a complete set " +
          "of defects for its source (e.g., Code-Review Summary replaces all " +
          '"code_review" defects). Valid values: static_analysis, code_review, ' +
          "interrupt_review, unit_test, confirmation_test.",
      ),
  },
  async execute({ project_name, defects: defectsJson, replace_source }) {
    const filePath = resolveArtifactPath(ARTIFACT_PATHS.DEFECTS)

    // Parse and validate the incoming defects
    let newDefects: unknown[]
    try {
      newDefects = JSON.parse(defectsJson)
    } catch {
      return JSON.stringify({
        error: "Failed to parse defects JSON string",
      })
    }

    if (!Array.isArray(newDefects)) {
      return JSON.stringify({
        error: "defects must be a JSON array",
      })
    }

    const validated: Defect[] = []
    for (let i = 0; i < newDefects.length; i++) {
      const result = Defect.safeParse(newDefects[i])
      if (!result.success) {
        return JSON.stringify({
          error: `Defect at index ${i} validation failed`,
          details: result.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        })
      }
      validated.push(result.data)
    }

    // Atomic read-modify-write under file lock
    const result = await withFileLock(filePath, () => {
      // Load existing database
      let db: DefectDatabase
      if (existsSync(filePath)) {
        try {
          const raw = readFileSync(filePath, "utf-8")
          db = JSON.parse(raw)
        } catch {
          db = {
            project_name,
            defects: [],
            summary: { total: 0, by_source: {}, by_severity: {}, by_category: {}, by_status: {}, open_critical: 0 },
          }
        }
      } else {
        db = {
          project_name,
          defects: [],
          summary: { total: 0, by_source: {}, by_severity: {}, by_category: {}, by_status: {}, open_critical: 0 },
        }
      }

      // Update project name if provided
      if (project_name) {
        db.project_name = project_name
      }

      // Replace mode: remove existing defects of the specified source
      if (replace_source) {
        db.defects = db.defects.filter((d) => d.source !== replace_source)
      }

      // Append new defects
      db.defects.push(...validated)

      // Keep append_defects idempotent for page retries / late background workers.
      const deduped = dedupeBy(db.defects, defectDedupKey)
      db.defects = deduped.items

      // Recalculate summary
      const by_source: Record<string, number> = {}
      const by_severity: Record<string, number> = {}
      const by_category: Record<string, number> = {}
      const by_status: Record<string, number> = {}
      let open_critical = 0

      for (const d of db.defects) {
        by_source[d.source] = (by_source[d.source] || 0) + 1
        by_severity[d.severity] = (by_severity[d.severity] || 0) + 1
        by_category[d.category] = (by_category[d.category] || 0) + 1
        by_status[d.status] = (by_status[d.status] || 0) + 1
        if (d.severity === "critical" && d.status === "open") {
          open_critical++
        }
      }

      db.summary = {
        total: db.defects.length,
        by_source,
        by_severity,
        by_category,
        by_status,
        open_critical,
      }

      // Write back
      const dir = dirname(filePath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(filePath, JSON.stringify(db, null, 2), "utf-8")

      return {
        total_defects: db.defects.length,
        appended: validated.length,
        deduplicated: deduped.removed,
        replaced_source: replace_source || null,
      }
    })

    return JSON.stringify({
      status: "success",
      action: replace_source ? "replaced_and_appended" : "appended",
      file: ARTIFACT_PATHS.DEFECTS,
      ...result,
      message: replace_source
        ? `Replaced ${replace_source} defects and appended ${validated.length} new defects (total: ${result.total_defects}, deduplicated: ${result.deduplicated})`
        : `Appended ${validated.length} defects (total: ${result.total_defects}, deduplicated: ${result.deduplicated})`,
    })
  },
})
