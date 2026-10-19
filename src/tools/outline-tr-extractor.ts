/**
 * outline-tr-extractor.ts — Extract test requirement items (TR) from outline DOCX documents.
 *
 * Parses Section 6.2 ("测试项及方法") of aerospace/FPGA outline documents,
 * extracting TR items from structured tables.
 *
 * Migrated from Java:
 * - OutlineTrExtractSaveServiceImpl.java (software)
 * - FPGADocTrExtractSaveServiceImpl.java (FPGA)
 * - OutlineSectionExtractVisitorV2.java (table extraction)
 * - AbstractDocParser.java (heading traversal)
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { dirname, join, isAbsolute } from "path"
import { readZip } from "./docx-zip"
import {
  resolveHeadings,
  getSubHeadings,
  findSectionRange,
  extractTablesInRange,
  type HeadingEntry,
  type ParsedTable,
} from "./docx-heading-resolver"
import { OutlineTrItem, OutlineSection, OutlineParsingResult } from "../schema/outline-tr"
import { DATA_DIR } from "../shared/constants"

function resolvePath(p: string): string {
  return isAbsolute(p) ? p : join(process.cwd(), p)
}

// ─── Table Parsing (migrated from Java) ────────────────────────────

interface ExtractedTr {
  funId: string
  name: string
  handling: string
  reqDesc: string
  sufficiency: string
  testMethod: string
  passCriteria: string
  priority: string
  tracing: string
  path: string
}

/**
 * Parse TR items from tables in a section.
 *
 * Table format (from outline Section 6.2):
 * - Header row (6 cells): cell[1]=name, cell[3]=funId, cell[5]=priority
 * - Data rows (2+ cells): cell[0]=field name, cell[1]=field content
 * - Field mapping: "测试项描述"→handling, "充分性要求"→sufficiency, etc.
 */
function parseTrFromTables(
  tables: ParsedTable[],
  targetHeading: string,
  isFpga: boolean,
): ExtractedTr[] {
  const results: ExtractedTr[] = []

  for (const table of tables) {
    let name = ""
    let priority = ""
    let funId = ""
    let handling = ""
    let sufficiency = ""
    let testMethod = ""
    let passCriteria = ""
    let tracing = ""
    let reqDesc = ""

    const rows = table.rows
    if (rows.length === 0) continue

    // Header row: must have 6 cells
    const headerRow = rows[0]
    if (headerRow.cells.length < 6) continue

    // Extract header fields
    name = cellText(headerRow.cells[1]) || ""
    funId = cellText(headerRow.cells[3]) || ""
    priority = cellText(headerRow.cells[5]) || ""

    // Data rows (row 1+)
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r]
      if (row.cells.length < 2) continue

      const fieldName = cellText(row.cells[0]).trim()
      const fieldContent = cellText(row.cells[1])

      switch (fieldName) {
        case "测试项描述":
          if (fieldContent.trim()) handling = fieldContent
          break
        case "充分性要求":
          if (fieldContent.trim()) sufficiency = fieldContent
          break
        case "测试方法":
          if (fieldContent.trim()) testMethod = fieldContent
          break
        case "通过准则":
          if (fieldContent.trim()) passCriteria = fieldContent
          break
        case "追踪关系":
          if (fieldContent.trim()) tracing = fieldContent
          break
        case "需求描述":
          if (fieldContent.trim()) reqDesc = fieldContent
          break
      }
    }

    // Only add if we got meaningful content
    if (handling.trim()) {
      // Build path (migrated from Java)
      let path: string
      if (isFpga) {
        const lastChar = targetHeading.charAt(targetHeading.length - 1)
        path = lastChar === "."
          ? "/" + targetHeading.replace(/\./g, "/")
          : "/" + targetHeading.replace(/\./g, "/") + "/"
      } else {
        path = "/" + targetHeading.replace(/\./g, "/") + "/"
      }

      results.push({
        funId, name, handling, reqDesc,
        sufficiency, testMethod, passCriteria,
        priority, tracing, path,
      })
    }
  }

  return results
}

function cellText(cell: { paragraphs: string[] }): string {
  return cell.paragraphs.join("\n")
}

// ─── Software Version Extraction ───────────────────────────────────

/**
 * Extract software ID and code version from Section 5.1 "软件基本信息" table.
 * Migrated from Java parsingDocOutLineTableSoftVersion().
 */
function extractSoftwareVersion(
  docXml: string,
  headings: HeadingEntry[],
): { softwareId: string; codeVersion: string } {
  let softwareId = ""
  let codeVersion = ""

  // Find section 5.1 sub-headings
  const sub51 = getSubHeadings(headings, "5.1")
  const softInfoHeading = sub51.find((h) => h.title.includes("软件基本信息"))

  if (!softInfoHeading) return { softwareId, codeVersion }

  // Extract tables in the software info section
  const range = findSectionRange(docXml, headings, softInfoHeading.title)
  if (!range) return { softwareId, codeVersion }

  const tables = extractTablesInRange(docXml, range.startOffset, range.endOffset)

  for (const table of tables) {
    if (table.rows.length < 2) continue

    // Find column indices for "软件名称" and "版本"
    const headerRow = table.rows[0]
    let softCol = -1
    let versionCol = -1

    for (let i = 0; i < headerRow.cells.length; i++) {
      const text = cellText(headerRow.cells[i]).trim()
      if (text.includes("软件名称")) softCol = i
      if (text.includes("版本")) versionCol = i
    }

    if (softCol === -1 || versionCol === -1) continue

    // Get data from first data row
    for (let r = 1; r < table.rows.length; r++) {
      const row = table.rows[r]
      if (row.cells.length <= Math.max(softCol, versionCol)) continue

      const softText = cellText(row.cells[softCol]).trim()
      if (softText) {
        if (softText.startsWith("XHDZ") && softText.length >= 12) {
          softwareId = softText.substring(0, 12)
        } else {
          softwareId = softText
        }
      }

      const versionText = cellText(row.cells[versionCol]).trim()
      if (versionText) {
        codeVersion = versionText.toUpperCase().startsWith("V")
          ? versionText.substring(1)
          : versionText
      }

      if (softwareId || codeVersion) break
    }

    if (softwareId || codeVersion) break
  }

  return { softwareId, codeVersion }
}

// ─── Tool Definition ───────────────────────────────────────────────

export const outlineTrExtractor: ToolDefinition = tool({
  description:
    "Extract test requirement items (TR) from a 鉴定测评大纲 DOCX document. " +
    "Parses Section 6.2 (测试项及方法) to extract TR items including funId, name, " +
    "handling, sufficiency, testMethod, passCriteria, tracing, and reqDesc. " +
    "Supports both software and FPGA outline formats. " +
    "Results are saved to .matrix/data/outline-tr.json in chapterTrList format " +
    "compatible with testcase_generator_run.",
  args: {
    docx_path: tool.schema
      .string()
      .describe("Path to the outline DOCX document (鉴定测评大纲)"),
    doc_type: tool.schema
      .enum(["software", "fpga"])
      .optional()
      .describe(
        "Document type. If not specified, auto-detected from filename " +
        "(contains 'FPGA' → fpga, otherwise → software)",
      ),
  },
  async execute({ docx_path, doc_type }) {
    const docxPath = resolvePath(docx_path)

    if (!existsSync(docxPath)) {
      return JSON.stringify({
        status: "error",
        message: `File not found: ${docxPath}`,
      })
    }

    try {
      // Auto-detect doc type from filename
      const isFpga = doc_type === "fpga" ||
        (!doc_type && /fpga/i.test(docxPath))
      const detectedType: "software" | "fpga" = isFpga ? "fpga" : "software"

      // Read DOCX as ZIP
      const docxBuffer = readFileSync(docxPath)
      const zipEntries = readZip(Buffer.from(docxBuffer))

      const docXmlBuf = zipEntries.get("word/document.xml")
      if (!docXmlBuf) {
        return JSON.stringify({
          status: "error",
          message: "DOCX is missing word/document.xml",
        })
      }

      const docXml = docXmlBuf.toString("utf-8")
      const numberingXmlBuf = zipEntries.get("word/numbering.xml")
      const numberingXml = numberingXmlBuf?.toString("utf-8")

      // Resolve headings
      const headings = resolveHeadings(docXml, numberingXml)

      if (headings.length === 0) {
        return JSON.stringify({
          status: "error",
          message: "No headings found in document. The document may not have standard heading styles.",
        })
      }

      // Extract software version (software type only)
      let softwareId = ""
      let codeVersion = ""
      if (!isFpga) {
        const versionInfo = extractSoftwareVersion(docXml, headings)
        softwareId = versionInfo.softwareId
        codeVersion = versionInfo.codeVersion
      }

      // Find Section 6.2 sub-headings
      const sub62 = getSubHeadings(headings, "6.2")

      if (sub62.length === 0) {
        // Try alternative: look for heading containing "测试项及方法"
        const testMethodHeading = headings.find((h) =>
          h.title.includes("测试项及方法") || h.title.includes("测试项")
        )

        if (!testMethodHeading) {
          return JSON.stringify({
            status: "error",
            message: 'Section 6.2 (测试项及方法) not found in document headings.',
            headings_found: headings.map((h) => `${h.label} ${h.title}`).slice(0, 20),
          })
        }
      }

      // Traverse 6.2 sub-sections and extract TR items
      const chapterTrList: Array<{ title: string; funItem: any[] }> = []
      let totalTrCount = 0

      for (const thirdLevelHeading of sub62) {
        const sectionTitle = thirdLevelHeading.title

        // Check for fourth-level sub-headings
        const fourthLevel = getSubHeadings(headings, thirdLevelHeading.label)

        if (fourthLevel.length > 0) {
          // Has sub-sections — process each fourth-level heading
          const sectionItems: any[] = []

          for (const fourthHeading of fourthLevel) {
            const range = findSectionRange(
              docXml, headings,
              fourthHeading.title,
            )
            if (!range) continue

            const tables = extractTablesInRange(docXml, range.startOffset, range.endOffset)
            const trItems = parseTrFromTables(tables, fourthHeading.label, isFpga)
            sectionItems.push(...trItems)
          }

          if (sectionItems.length > 0) {
            chapterTrList.push({
              title: sectionTitle,
              funItem: sectionItems,
            })
            totalTrCount += sectionItems.length
          }
        } else {
          // No sub-sections — process this heading directly
          const range = findSectionRange(
            docXml, headings,
            thirdLevelHeading.title,
          )
          if (!range) continue

          const tables = extractTablesInRange(docXml, range.startOffset, range.endOffset)
          const trItems = parseTrFromTables(tables, thirdLevelHeading.label, isFpga)

          if (trItems.length > 0) {
            chapterTrList.push({
              title: sectionTitle,
              funItem: trItems,
            })
            totalTrCount += trItems.length
          }
        }
      }

      // Build result
      const result: OutlineParsingResult = {
        docType: detectedType,
        softwareId: softwareId || undefined,
        codeVersion: codeVersion || undefined,
        chapterTrList,
        totalTrCount,
      }

      // Validate with Zod
      const parsed = OutlineParsingResult.safeParse(result)
      if (!parsed.success) {
        return JSON.stringify({
          status: "error",
          message: "Output validation failed",
          issues: parsed.error.issues.slice(0, 5),
        })
      }

      // Save to .matrix/data/outline-tr.json
      const outputPath = join(process.cwd(), DATA_DIR, "outline-tr.json")
      const outputDir = dirname(outputPath)
      if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true })
      writeFileSync(outputPath, JSON.stringify(result, null, 2), "utf-8")

      return JSON.stringify({
        status: "success",
        doc_type: detectedType,
        software_id: softwareId || null,
        code_version: codeVersion || null,
        total_tr_count: totalTrCount,
        sections: chapterTrList.map((s) => ({
          title: s.title,
          tr_count: s.funItem.length,
        })),
        output_file: outputPath,
        message: `Extracted ${totalTrCount} TR items from ${chapterTrList.length} sections → ${outputPath}`,
      })
    } catch (e: any) {
      return JSON.stringify({
        status: "error",
        message: `Failed to extract outline TR: ${e.message}`,
        stack: e.stack?.split("\n").slice(0, 5),
      })
    }
  },
})
