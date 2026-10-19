import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { dirname, join, isAbsolute } from "path"
import { readZip, writeZip, type ZipEntry } from "./docx-zip"
import { DefectDatabase } from "../schema/defect"
import { ARTIFACT_PATHS, REPORTS_DIR } from "../shared/constants"
import { resolveTemplateAssetPath } from "../shared/template-resolution"
import { moduleDir } from "../shared/runtime-paths"

function resolvePath(p: string): string {
  return isAbsolute(p) ? p : join(process.cwd(), p)
}

/**
 * issue_report — Generate a DOCX issue report from defects.json using a DOCX template.
 *
 * The tool:
 * 1. Reads defects.json and validates against DefectDatabase schema
 * 2. Reads the DOCX template (a ZIP of XML files)
 * 3. Replaces global placeholders (project_name, date, summary stats)
 * 4. Finds the repeating row block in the defect table (identified by {{seq}} marker)
 *    and duplicates it for each defect
 * 5. Writes the result as a new .docx file
 *
 * No LLM calls — purely deterministic template expansion.
 */
export const issueReportGenerator: ToolDefinition = tool({
  description:
    "Generate a DOCX issue report (软件测试问题报告单) from defects.json data. " +
    "Reads defects from .matrix/data/defects.json, applies data to a DOCX template " +
    "with placeholder substitution, and outputs .matrix/reports/issue-report.docx. " +
    "No LLM calls — purely deterministic template-based generation.",
  args: {
    defects_file: tool.schema
      .string()
      .optional()
      .describe(
        "Path to defects.json file. Default: .matrix/data/defects.json",
      ),
    template_path: tool.schema
      .string()
      .optional()
      .describe(
        "Path to DOCX template file. Default search order: project templates/ first, then runtime bundled templates.",
      ),
    output_path: tool.schema
      .string()
      .optional()
      .describe(
        "Output path for generated DOCX. Default: .matrix/reports/issue-report.docx",
      ),
  },
  async execute({ defects_file, template_path, output_path }) {
    // ── Resolve paths ────────────────────────────────────────────
    const defectsPath = defects_file
      ? resolvePath(defects_file)
      : join(process.cwd(), ARTIFACT_PATHS.DEFECTS)

    const projectDir = process.cwd()
    const { path: templatePath, checked: checkedTemplates } = resolveTemplateAssetPath({
      filename: "issue-report.docx",
      importMetaDir: moduleDir(import.meta.url),
      projectDir,
      preferredPath: template_path ? resolvePath(template_path) : undefined,
    })

    const outputDocxPath = output_path
      ? resolvePath(output_path)
      : join(process.cwd(), REPORTS_DIR, "issue-report.docx")

    // ── Validate inputs ──────────────────────────────────────────
    if (!existsSync(defectsPath)) {
      return JSON.stringify({
        error: `Defects file not found: ${defectsPath}`,
        hint: "Run the testing workflow first to generate defects.json",
      })
    }

    if (!templatePath || !existsSync(templatePath)) {
      return JSON.stringify({
        error: `Template file not found: ${templatePath || "issue-report.docx"}`,
        hint:
          `Checked: ${checkedTemplates.join(", ")}. ` +
          "Prefer putting the template in the project business template path templates/issue-report.docx, " +
          "or run 'bun scripts/create-issue-report-template.ts' to generate the template",
      })
    }

    // ── Read and validate defects data ───────────────────────────
    let rawData: unknown
    try {
      rawData = JSON.parse(readFileSync(defectsPath, "utf-8"))
    } catch (e) {
      return JSON.stringify({
        error: `Failed to parse defects JSON: ${defectsPath}`,
      })
    }

    // Lenient validation: coerce null → undefined for optional fields before parsing
    const coerced = coerceNulls(rawData)
    const parsed = DefectDatabase.safeParse(coerced)
    if (!parsed.success) {
      return JSON.stringify({
        error: "Defects data validation failed",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      })
    }

    const data = parsed.data

    // ── Build replacement maps ───────────────────────────────────
    const globalReplacements: Record<string, string> = {
      "{{project_name}}": data.project_name,
      "{{date}}": new Date().toISOString().split("T")[0],
      "{{total}}": String(data.summary.total),
      "{{open_critical}}": String(data.summary.open_critical),
      "{{by_severity_critical}}": String(data.summary.by_severity["critical"] ?? 0),
      "{{by_severity_major}}": String(data.summary.by_severity["major"] ?? 0),
      "{{by_severity_minor}}": String(data.summary.by_severity["minor"] ?? 0),
      "{{by_severity_suggestion}}": String(data.summary.by_severity["suggestion"] ?? 0),
      "{{by_source_static_analysis}}": String(data.summary.by_source["static_analysis"] ?? 0),
      "{{by_source_code_review}}": String(data.summary.by_source["code_review"] ?? 0),
      "{{by_source_unit_test}}": String(data.summary.by_source["unit_test"] ?? 0),
      "{{by_source_confirmation_test}}": String(data.summary.by_source["confirmation_test"] ?? 0),
      "{{by_source_interrupt_review}}": String(data.summary.by_source["interrupt_review"] ?? 0),
    }

    // ── Process template ─────────────────────────────────────────
    const templateBuffer = readFileSync(templatePath)
    const zipEntries = readZip(Buffer.from(templateBuffer))

    const docXml = zipEntries.get("word/document.xml")
    if (!docXml) {
      return JSON.stringify({
        error: "Template DOCX is missing word/document.xml",
      })
    }

    let xml = docXml.toString("utf-8")

    // Step 1: Normalize split placeholders (two passes)
    // Word may split {{placeholder}} across multiple <w:r> runs.
    // Pass 1: merge adjacent runs with same formatting.
    // Pass 2: force-merge runs across placeholder boundaries regardless of formatting.
    xml = normalizePlaceholders(xml)
    xml = normalizeAggressivePlaceholders(xml)

    // Step 2: Find and expand the repeating defect row block
    xml = expandDefectRows(xml, data.defects)

    // Step 3: Replace global placeholders
    for (const [placeholder, value] of Object.entries(globalReplacements)) {
      xml = xml.replaceAll(placeholder, escapeXml(value))
    }

    // ── Write output ─────────────────────────────────────────────
    zipEntries.set("word/document.xml", Buffer.from(xml, "utf-8"))

    const outputEntries: ZipEntry[] = []
    for (const [path, buf] of zipEntries) {
      outputEntries.push({ path, data: buf })
    }

    const outputBuffer = writeZip(outputEntries)
    const outputDir = dirname(outputDocxPath)
    if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true })
    writeFileSync(outputDocxPath, outputBuffer)

    return JSON.stringify({
      status: "success",
      output_file: outputDocxPath,
      defect_count: data.defects.length,
      size_bytes: outputBuffer.length,
      message: `Generated issue report with ${data.defects.length} defects → ${outputDocxPath}`,
    })
  },
})

// ─── Helper Functions ──────────────────────────────────────────────

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/**
 * Normalize split placeholders in DOCX XML.
 *
 * Word often splits text like "{{project_name}}" across multiple <w:r> runs:
 *   <w:r><w:t>{{</w:t></w:r><w:r><w:t>project_name</w:t></w:r><w:r><w:t>}}</w:t></w:r>
 *
 * This function merges adjacent <w:r> runs within each <w:p> paragraph
 * that have the same formatting (or no formatting), then re-splits them.
 */
function normalizePlaceholders(xml: string): string {
  // Process each paragraph
  return xml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (paragraph) => {
    // Check if this paragraph contains any part of a placeholder pattern
    if (!paragraph.includes("{{") && !paragraph.includes("}}")) {
      return paragraph
    }

    // Extract all text content from <w:t> elements within this paragraph
    // and check if joined text contains a placeholder
    const textContents: string[] = []
    paragraph.replace(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g, (_, text) => {
      textContents.push(text)
      return _
    })

    const joinedText = textContents.join("")
    if (!joinedText.includes("{{") || !joinedText.includes("}}")) {
      return paragraph
    }

    // Find runs (<w:r>...</w:r>) and merge adjacent ones that form placeholders
    // Strategy: extract all runs, merge text, then reconstruct
    const runRegex = /<w:r\b(?![^>]*\/>)(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g
    const runs: Array<{ full: string; rPr: string; text: string }> = []
    let match

    while ((match = runRegex.exec(paragraph)) !== null) {
      const runXml = match[0]
      const rPrMatch = runXml.match(/<w:rPr>([\s\S]*?)<\/w:rPr>/)
      const rPr = rPrMatch ? rPrMatch[0] : ""
      const textMatch = runXml.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/)
      const text = textMatch ? textMatch[1] : ""
      runs.push({ full: runXml, rPr, text })
    }

    if (runs.length <= 1) return paragraph

    // Merge adjacent runs with same rPr
    const merged: Array<{ rPr: string; text: string }> = []
    for (const run of runs) {
      if (merged.length > 0 && merged[merged.length - 1].rPr === run.rPr) {
        merged[merged.length - 1].text += run.text
      } else {
        merged.push({ rPr: run.rPr, text: run.text })
      }
    }

    // Reconstruct the paragraph with merged runs
    let newParagraph = paragraph
    // Replace the sequence of original runs with merged runs
    const firstRunIdx = paragraph.indexOf(runs[0].full)
    const lastRun = runs[runs.length - 1]
    const lastRunIdx = paragraph.indexOf(lastRun.full, firstRunIdx)
    const lastRunEnd = lastRunIdx + lastRun.full.length

    if (firstRunIdx === -1 || lastRunIdx === -1) return paragraph

    const before = paragraph.substring(0, firstRunIdx)
    const after = paragraph.substring(lastRunEnd)

    const newRuns = merged.map((r) => {
      const needsPreserve = r.text.startsWith(" ") || r.text.endsWith(" ")
      const spaceAttr = needsPreserve ? ' xml:space="preserve"' : ""
      return `<w:r>${r.rPr}<w:t${spaceAttr}>${r.text}</w:t></w:r>`
    }).join("")

    return before + newRuns + after
  })
}

/**
 * Second-pass placeholder normalization for stubborn split placeholders.
 * Force-merges runs between "{{" and "}}" regardless of formatting differences.
 */
function normalizeAggressivePlaceholders(xml: string): string {
  return xml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (paragraph) => {
    const textContents: string[] = []
    paragraph.replace(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g, (_, text) => {
      textContents.push(text)
      return _
    })
    const joinedText = textContents.join("")
    if (!joinedText.includes("{{") || !joinedText.includes("}}")) {
      return paragraph
    }

    // Check if all placeholders are already in single runs
    const placeholderRe = /\{\{[^{}]+\}\}/g
    const expectedPlaceholders = joinedText.match(placeholderRe) || []
    if (expectedPlaceholders.length === 0) return paragraph

    const runRegex = /<w:r\b(?![^>]*\/>)(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g
    const runs: Array<{ full: string; rPr: string; text: string }> = []
    let match
    while ((match = runRegex.exec(paragraph)) !== null) {
      const runXml = match[0]
      const rPrMatch = runXml.match(/<w:rPr>([\s\S]*?)<\/w:rPr>/)
      const rPr = rPrMatch ? rPrMatch[0] : ""
      const textMatch = runXml.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/)
      const text = textMatch ? textMatch[1] : ""
      runs.push({ full: runXml, rPr, text })
    }

    if (runs.length <= 1) return paragraph

    // Check completeness
    const runTexts = runs.map((r) => r.text)
    let allComplete = true
    for (const ph of expectedPlaceholders) {
      if (!runTexts.some((rt) => rt.includes(ph))) {
        allComplete = false
        break
      }
    }
    if (allComplete) return paragraph

    // Force-merge runs within {{ ... }}
    const merged: Array<{ rPr: string; text: string }> = []
    let inPlaceholder = false
    let openIdx = -1

    for (const run of runs) {
      const text = run.text
      if (!inPlaceholder) {
        const openPos = text.indexOf("{{")
        if (openPos !== -1) {
          const before = text.substring(0, openPos)
          const after = text.substring(openPos)
          if (before) merged.push({ rPr: run.rPr, text: before })
          if (after.includes("}}")) {
            merged.push({ rPr: run.rPr, text: after })
          } else {
            inPlaceholder = true
            openIdx = merged.length
            merged.push({ rPr: run.rPr, text: after })
          }
        } else {
          merged.push({ rPr: run.rPr, text })
        }
      } else {
        const closePos = text.indexOf("}}")
        if (closePos !== -1) {
          const inside = text.substring(0, closePos + 2)
          const after = text.substring(closePos + 2)
          merged[openIdx].text += inside
          inPlaceholder = false
          if (after) {
            const nextOpen = after.indexOf("{{")
            if (nextOpen !== -1 && !after.includes("}}")) {
              const beforeNext = after.substring(0, nextOpen)
              const fromNext = after.substring(nextOpen)
              if (beforeNext) merged.push({ rPr: run.rPr, text: beforeNext })
              inPlaceholder = true
              openIdx = merged.length
              merged.push({ rPr: run.rPr, text: fromNext })
            } else {
              merged.push({ rPr: run.rPr, text: after })
            }
          }
        } else {
          merged[openIdx].text += text
        }
      }
    }

    const firstRunIdx = paragraph.indexOf(runs[0].full)
    const lastRun = runs[runs.length - 1]
    const lastRunIdx = paragraph.indexOf(lastRun.full, firstRunIdx)
    const lastRunEnd = lastRunIdx + lastRun.full.length
    if (firstRunIdx === -1 || lastRunIdx === -1) return paragraph

    const before = paragraph.substring(0, firstRunIdx)
    const after = paragraph.substring(lastRunEnd)
    const newRuns = merged
      .filter((r) => r.text.length > 0)
      .map((r) => {
        const needsPreserve = r.text.startsWith(" ") || r.text.endsWith(" ")
        const spaceAttr = needsPreserve ? ' xml:space="preserve"' : ""
        return `<w:r>${r.rPr}<w:t${spaceAttr}>${r.text}</w:t></w:r>`
      })
      .join("")

    return before + newRuns + after
  })
}

/**
 * Find the defect template table and expand it into one independent table per defect.
 *
 * The template has a `<w:tbl>` containing rows with {{seq}}, {{id}}, etc.
 * This function:
 * 1. Finds the entire `<w:tbl>...</w:tbl>` that contains the {{seq}} marker
 * 2. For each defect, clones the whole table and replaces per-defect placeholders
 * 3. Inserts a spacing paragraph `<w:p/>` between each table for visual separation
 */
function expandDefectRows(xml: string, defects: any[]): string {
  const seqMarker = "{{seq}}"

  // Find the <w:tbl> that contains {{seq}}
  const seqPos = xml.indexOf(seqMarker)
  if (seqPos === -1) return xml

  // Search backwards from seqPos to find the opening <w:tbl>
  const tblOpenTag = "<w:tbl>"
  let tblStart = xml.lastIndexOf(tblOpenTag, seqPos)
  if (tblStart === -1) return xml

  // Search forwards from seqPos to find the closing </w:tbl>
  const tblCloseTag = "</w:tbl>"
  let tblEnd = xml.indexOf(tblCloseTag, seqPos)
  if (tblEnd === -1) return xml
  tblEnd += tblCloseTag.length

  // Handle nested tables: ensure we capture the correct closing tag
  // Count nested <w:tbl> between tblStart and our found tblEnd
  const tblContent = xml.substring(tblStart, tblEnd)
  const openCount = (tblContent.match(/<w:tbl>/g) || []).length
  const closeCount = (tblContent.match(/<\/w:tbl>/g) || []).length
  if (openCount > closeCount) {
    // Need to find more closing tags
    let searchFrom = tblEnd
    for (let i = 0; i < openCount - closeCount; i++) {
      const nextClose = xml.indexOf(tblCloseTag, searchFrom)
      if (nextClose === -1) return xml
      tblEnd = nextClose + tblCloseTag.length
      searchFrom = tblEnd
    }
  }

  const templateTableXml = xml.substring(tblStart, tblEnd)

  // Spacing paragraph between defect tables
  const spacingPara = `<w:p><w:pPr><w:spacing w:before="120" w:after="120"/></w:pPr></w:p>`

  // Generate one table per defect
  const expandedTables: string[] = []
  for (let i = 0; i < defects.length; i++) {
    const defect = defects[i]
    let table = templateTableXml

    const location = defect.location
      ? `${defect.location.file_path}:${defect.location.line_start}${defect.location.function_name ? ` (${defect.location.function_name})` : ""}`
      : "N/A"

    const replacements: Record<string, string> = {
      "{{seq}}": String(i + 1),
      "{{id}}": defect.id ?? "",
      "{{title}}": defect.title ?? "",
      "{{severity}}": defect.severity ?? "",
      "{{category}}": defect.category ?? "",
      "{{source}}": defect.source ?? "",
      "{{location}}": location,
      "{{description}}": defect.description ?? "",
      "{{rule_id}}": defect.rule_id ?? "N/A",
      "{{related_reqs}}": (defect.related_requirement_ids ?? []).join(", ") || "N/A",
      "{{status}}": defect.status ?? "",
      "{{detected_by}}": defect.detected_by ?? "",
      "{{detected_date}}": defect.detected_date ?? "",
    }

    for (const [placeholder, value] of Object.entries(replacements)) {
      table = table.replaceAll(placeholder, escapeXml(value))
    }

    expandedTables.push(table)
  }

  // Replace the original template table with all expanded tables, separated by spacing
  return (
    xml.substring(0, tblStart) +
    expandedTables.join("\n" + spacingPara + "\n") +
    xml.substring(tblEnd)
  )
}

/**
 * Recursively coerce null values to undefined so Zod's .optional() accepts them.
 * Real-world JSON data often uses null for absent optional fields.
 */
function coerceNulls(obj: unknown): unknown {
  if (obj === null) return undefined
  if (Array.isArray(obj)) return obj.map(coerceNulls)
  if (typeof obj === "object" && obj !== null) {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj)) {
      result[key] = coerceNulls(value)
    }
    return result
  }
  return obj
}
