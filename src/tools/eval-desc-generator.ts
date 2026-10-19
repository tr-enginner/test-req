/**
 * eval-desc-generator.ts — Generate 鉴定测评说明 DOCX documents.
 *
 * Assembles a complete evaluation description document from:
 * - Template DOCX (base structure with placeholders)
 * - Reference document (outline) for static chapter content
 * - Content library for dynamic test type content
 * - Confirmation test cases for test case filling
 *
 * Migrated from Python:
 * - range_title_xml_extractor_complete_image.py (main pipeline)
 * - business_service.py (orchestration)
 * - routes.py (range mapping generation)
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { dirname, join, isAbsolute } from "path"
import { readZip, writeZip, type ZipEntry } from "./docx-zip"
import { resolveHeadings } from "./docx-heading-resolver"
import { buildStyleMapping, applyStyleMapping, mergeStyles } from "./docx-style-mapper"
import {
  collectImageReferences,
  migrateImages,
  mergeRelationships,
} from "./docx-image-handler"
import {
  extractXmlRange,
  replacePlaceholderWithContent,
  extractRevisionHistory,
  replaceRevisionHistory,
} from "./docx-range-copy"
import {
  unifyNumberingStructure,
  fixCaptionNumbering,
  extractTestCaseNumId,
} from "./docx-numbering-fixer"
import {
  generateFpgaRangeMappings,
  generateSoftwareRangeMappings,
  extractDynamicContentByType,
} from "./dynamic-content-mapper"
import type { RangeMapping } from "../schema/eval-desc"
import { ARTIFACT_PATHS, DATA_DIR, REPORTS_DIR } from "../shared/constants"
import { resolveTemplateAssetPath } from "../shared/template-resolution"
import { moduleDir } from "../shared/runtime-paths"

function resolvePath(p: string): string {
  return isAbsolute(p) ? p : join(process.cwd(), p)
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

// ─── Global Placeholder Replacement ────────────────────────────────

function replaceGlobalPlaceholders(
  xml: string,
  replacements: Record<string, string>,
): string {
  let result = xml
  for (const [placeholder, value] of Object.entries(replacements)) {
    result = result.replaceAll(placeholder, escapeXml(value))
  }
  return result
}

// ─── Cover Placeholder Replacement ─────────────────────────────────

function replaceCoverPlaceholders(
  xml: string,
  coverInfoPath: string,
): string {
  if (!existsSync(coverInfoPath)) return xml

  try {
    const coverData = JSON.parse(readFileSync(coverInfoPath, "utf-8"))
    const fieldNames = [
      "config_id", "file_name", "cover_date",
      "preparation", "proofread", "review", "std_review", "countersign", "approval",
      "req_version", "design_version", "guide_version",
      "static_test_tool", "simulation_test_tool", "static_timing_analysis_tool",
      "resource_remain", "clock_remain", "develop_environment",
    ]

    let result = xml
    for (const field of fieldNames) {
      const value = coverData[field]
      if (value != null && value !== "") {
        result = result.replaceAll(`{{${field}}}`, escapeXml(String(value)))
      }
    }
    return result
  } catch {
    return xml
  }
}

// ─── Normalize Split Placeholders ──────────────────────────────────

function normalizePlaceholders(xml: string): string {
  return xml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (paragraph) => {
    if (!paragraph.includes("{{") && !paragraph.includes("}}")) {
      return paragraph
    }

    const textContents: string[] = []
    paragraph.replace(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g, (_, text) => {
      textContents.push(text)
      return _
    })

    const joinedText = textContents.join("")
    if (!joinedText.includes("{{") || !joinedText.includes("}}")) {
      return paragraph
    }

    const runRegex = /<w:r\b(?![^>]*\/>)(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g
    const runs: Array<{ full: string; rPr: string; text: string }> = []
    let match: RegExpExecArray | null
    while ((match = runRegex.exec(paragraph)) !== null) {
      const runXml = match[0]
      const rPrMatch = runXml.match(/<w:rPr>([\s\S]*?)<\/w:rPr>/)
      const rPr = rPrMatch ? rPrMatch[0] : ""
      const textMatch = runXml.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/)
      const text = textMatch ? textMatch[1] : ""
      runs.push({ full: runXml, rPr, text })
    }

    if (runs.length <= 1) return paragraph

    const merged: Array<{ rPr: string; text: string }> = []
    for (const run of runs) {
      if (merged.length > 0 && merged[merged.length - 1].rPr === run.rPr) {
        merged[merged.length - 1].text += run.text
      } else {
        merged.push({ rPr: run.rPr, text: run.text })
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
      .map((r) => {
        const needsPreserve = r.text.startsWith(" ") || r.text.endsWith(" ")
        const spaceAttr = needsPreserve ? ' xml:space="preserve"' : ""
        return `<w:r>${r.rPr}<w:t${spaceAttr}>${r.text}</w:t></w:r>`
      })
      .join("")

    return before + newRuns + after
  })
}

// ─── Tool Definition ───────────────────────────────────────────────

export const evalDescGenerator: ToolDefinition = tool({
  description:
    "Generate a complete 鉴定测评说明 (evaluation description) DOCX document. " +
    "Only requires doc_type and reference_path — template and content library " +
    "are resolved automatically from the project templates/ directory first, then runtime bundled templates. " +
    "Handles: static chapter copying, dynamic test type content, style mapping, " +
    "image migration, numbering unification, revision history, and cover placeholders. " +
    "Supports both software and FPGA document types.",
  args: {
    doc_type: tool.schema
      .enum(["software", "fpga"])
      .describe("Document type: software or fpga"),
    reference_path: tool.schema
      .string()
      .describe("Path to the reference document (鉴定测评大纲 DOCX)"),
    test_cases_file: tool.schema
      .string()
      .optional()
      .describe("Path to confirmation-tests.json. Default: .matrix/data/confirmation-tests.json"),
    cover_info_file: tool.schema
      .string()
      .optional()
      .describe("Path to cover-info.json. Default: .matrix/data/cover-info.json"),
    output_path: tool.schema
      .string()
      .optional()
      .describe(
        "Output path for generated DOCX. Default: .matrix/reports/{type}-eval-desc.docx",
      ),
    software_id: tool.schema
      .string()
      .optional()
      .describe("Software identifier for {{software_id}} placeholder"),
    code_version: tool.schema
      .string()
      .optional()
      .describe("Code version for {{code_version}} placeholder"),
    designer: tool.schema
      .string()
      .optional()
      .describe("Designer name for {{designer}} placeholder"),
  },
  async execute({
    doc_type,
    reference_path,
    test_cases_file,
    cover_info_file,
    output_path,
    software_id,
    code_version,
    designer,
  }) {
    const isFpga = doc_type === "fpga"
    const projectDir = process.cwd()

    // ── Resolve paths ────────────────────────────────────────────
    const refPath = resolvePath(reference_path)

    const tmplName = isFpga ? "FPGA测试说明模板.docx" : "软件测试说明模板.docx"
    const { path: tmplPath, checked: checkedTemplatePaths } = resolveTemplateAssetPath({
      filename: tmplName,
      importMetaDir: moduleDir(import.meta.url),
      projectDir,
    })

    const clibName = isFpga ? "FPGA测试说明内容库.docx" : "软件测试说明内容库.docx"
    const { path: clibPath, checked: checkedLibraryPaths } = resolveTemplateAssetPath({
      filename: clibName,
      importMetaDir: moduleDir(import.meta.url),
      projectDir,
    })

    const testCasesPath = test_cases_file
      ? resolvePath(test_cases_file)
      : join(projectDir, ARTIFACT_PATHS.CONFIRMATION_TESTS)

    const coverInfoPath = cover_info_file
      ? resolvePath(cover_info_file)
      : join(projectDir, DATA_DIR, "cover-info.json")

    const outputDocxPath = output_path
      ? resolvePath(output_path)
      : join(projectDir, REPORTS_DIR, `${isFpga ? "fpga" : "software"}-eval-desc.docx`)

    // ── Validate required files ──────────────────────────────────
    if (!existsSync(refPath)) {
      return JSON.stringify({
        status: "error",
        message: `Reference document not found: ${refPath}`,
      })
    }

    if (!tmplPath || !existsSync(tmplPath)) {
      return JSON.stringify({
        status: "error",
        message: `Template file not found. Searched: ${checkedTemplatePaths.join(", ")}`,
        hint: `Place ${tmplName} in the project business template directory templates/, or let the runtime bundled templates provide it.`,
      })
    }

    if (!clibPath || !existsSync(clibPath)) {
      return JSON.stringify({
        status: "error",
        message: `Content library file not found. Searched: ${checkedLibraryPaths.join(", ")}`,
        hint: `Place ${clibName} in the project business template directory templates/, or let the runtime bundled templates provide it.`,
      })
    }

    try {
      // ── Step 1: Read all DOCX files ──────────────────────────────
      const templateEntries = readZip(Buffer.from(readFileSync(tmplPath)))
      const refEntries = readZip(Buffer.from(readFileSync(refPath)))

      let clibEntries: Map<string, Buffer> | undefined
      if (clibPath && existsSync(clibPath)) {
        clibEntries = readZip(Buffer.from(readFileSync(clibPath)))
      }

      const templateDocXml = templateEntries.get("word/document.xml")
      const refDocXml = refEntries.get("word/document.xml")
      if (!templateDocXml || !refDocXml) {
        return JSON.stringify({
          status: "error",
          message: "Missing word/document.xml in template or reference document",
        })
      }

      let docXml = templateDocXml.toString("utf-8")
      const refXml = refDocXml.toString("utf-8")

      // ── Step 2: Normalize placeholders ───────────────────────────
      docXml = normalizePlaceholders(docXml)

      // ── Step 3: Extract test case numId from template ────────────
      const _testCaseNumId = extractTestCaseNumId(docXml)

      // ── Step 4: Global placeholder replacement ───────────────────
      const globalReplacements: Record<string, string> = {}
      if (software_id) globalReplacements["{{software_id}}"] = software_id
      if (code_version) globalReplacements["{{code_version}}"] = code_version
      if (designer) globalReplacements["{{designer}}"] = designer
      docXml = replaceGlobalPlaceholders(docXml, globalReplacements)

      // ── Step 5: Cover placeholder replacement ────────────────────
      docXml = replaceCoverPlaceholders(docXml, coverInfoPath)

      // ── Step 6: Style mapping ────────────────────────────────────
      const templateStylesXml = templateEntries.get("word/styles.xml")?.toString("utf-8") ?? ""
      const refStylesXml = refEntries.get("word/styles.xml")?.toString("utf-8") ?? ""
      const styleMapping = buildStyleMapping(refStylesXml, templateStylesXml)

      // Merge new styles into template
      if (styleMapping.newStyleDefs.length > 0 && templateStylesXml) {
        const mergedStyles = mergeStyles(templateStylesXml, styleMapping.newStyleDefs)
        templateEntries.set("word/styles.xml", Buffer.from(mergedStyles, "utf-8"))
      }

      // ── Step 7: Resolve headings ─────────────────────────────────
      const refNumberingXml = refEntries.get("word/numbering.xml")?.toString("utf-8")
      const refHeadings = resolveHeadings(refXml, refNumberingXml)

      let clibXml: string | undefined
      let clibHeadings: ReturnType<typeof resolveHeadings> | undefined
      if (clibEntries) {
        clibXml = clibEntries.get("word/document.xml")?.toString("utf-8")
        if (clibXml) {
          const clibNumberingXml = clibEntries.get("word/numbering.xml")?.toString("utf-8")
          clibHeadings = resolveHeadings(clibXml, clibNumberingXml)
        }
      }

      // ── Step 8: Generate range mappings ──────────────────────────
      const rangeMappings: RangeMapping[] = isFpga
        ? generateFpgaRangeMappings(clibPath)
        : generateSoftwareRangeMappings(clibPath)

      // ── Step 9: Process range mappings ───────────────────────────
      const templateRelsXml = templateEntries.get("word/_rels/document.xml.rels")?.toString("utf-8") ?? ""
      const refRelsXml = refEntries.get("word/_rels/document.xml.rels")?.toString("utf-8") ?? ""
      let currentRelsXml = templateRelsXml
      const allNewMediaFiles: Array<{ targetMediaPath: string; data: Buffer }> = []

      let staticProcessed = 0
      let dynamicProcessed = 0

      for (const mapping of rangeMappings) {
        const isDynamic = mapping.dynamicContent?.enabled === true

        if (!isDynamic) {
          // Static mapping: extract from reference document
          const extracted = extractXmlRange(
            refXml,
            refHeadings,
            mapping.startTitle,
            mapping.endTitle,
            {
              includeStartTitle: mapping.includeStartTitle,
              includeEndTitle: mapping.includeEndTitle,
            },
          )

          if (extracted.found) {
            // Apply style mapping
            let fragment = applyStyleMapping(extracted.fragment, styleMapping)

            // Handle images
            const imageRefs = collectImageReferences(fragment)
            if (imageRefs.length > 0) {
              const imgResult = migrateImages(
                refEntries,
                currentRelsXml,
                fragment,
                imageRefs,
                refRelsXml,
                templateEntries,
              )
              fragment = imgResult.updatedFragment
              allNewMediaFiles.push(
                ...imgResult.newMediaFiles.map((f) => ({
                  targetMediaPath: f.targetMediaPath,
                  data: f.data,
                })),
              )
              currentRelsXml = mergeRelationships(currentRelsXml, imgResult.newRelEntries)
            }

            // Replace placeholder
            docXml = replacePlaceholderWithContent(docXml, mapping.placeholder, fragment)
            staticProcessed++
          }
        } else if (clibXml && clibHeadings) {
          // Dynamic mapping: extract from content library
          const fragment = extractDynamicContentByType(
            clibXml,
            clibHeadings,
            mapping.dynamicContent!.type,
          )

          if (fragment) {
            // Apply style mapping from content library
            if (clibEntries) {
              const clibStylesXml = clibEntries.get("word/styles.xml")?.toString("utf-8") ?? ""
              const clibStyleMapping = buildStyleMapping(clibStylesXml, templateStylesXml)
              const mappedFragment = applyStyleMapping(fragment, clibStyleMapping)
              docXml = replacePlaceholderWithContent(docXml, mapping.placeholder, mappedFragment)
            } else {
              docXml = replacePlaceholderWithContent(docXml, mapping.placeholder, fragment)
            }
            dynamicProcessed++
          }
        }
      }

      // ── Step 10: Revision history ────────────────────────────────
      const revision = extractRevisionHistory(refXml)
      if (revision) {
        let revFragment = applyStyleMapping(
          revision.paragraphXml + revision.tableXml,
          styleMapping,
        )
        docXml = replaceRevisionHistory(docXml, {
          paragraphXml: revision.paragraphXml,
          tableXml: revision.tableXml,
        })
      }

      // ── Step 11: Numbering fix ───────────────────────────────────
      let numberingXml = templateEntries.get("word/numbering.xml")?.toString("utf-8") ?? ""
      const numbResult = unifyNumberingStructure(docXml, numberingXml, isFpga)
      docXml = numbResult.docXml
      numberingXml = numbResult.numberingXml

      const captionResult = fixCaptionNumbering(docXml, numberingXml)
      docXml = captionResult.docXml
      numberingXml = captionResult.numberingXml

      // ── Step 12: Write output DOCX ───────────────────────────────
      templateEntries.set("word/document.xml", Buffer.from(docXml, "utf-8"))

      if (numberingXml) {
        templateEntries.set("word/numbering.xml", Buffer.from(numberingXml, "utf-8"))
      }

      // Update relationships
      if (currentRelsXml !== templateRelsXml) {
        templateEntries.set(
          "word/_rels/document.xml.rels",
          Buffer.from(currentRelsXml, "utf-8"),
        )
      }

      // Add migrated media files
      for (const mediaFile of allNewMediaFiles) {
        templateEntries.set(mediaFile.targetMediaPath, mediaFile.data)
      }

      // Build output ZIP
      const outputEntries: ZipEntry[] = []
      for (const [path, buf] of templateEntries) {
        outputEntries.push({ path, data: buf })
      }

      const outputBuffer = writeZip(outputEntries)
      const outputDir = dirname(outputDocxPath)
      if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true })
      writeFileSync(outputDocxPath, outputBuffer)

      return JSON.stringify({
        status: "success",
        output_file: outputDocxPath,
        doc_type,
        template_used: tmplPath,
        content_library_used: clibPath ?? null,
        static_sections_processed: staticProcessed,
        dynamic_sections_processed: dynamicProcessed,
        images_migrated: allNewMediaFiles.length,
        size_bytes: outputBuffer.length,
        message:
          `Generated ${doc_type} evaluation description document → ${outputDocxPath} ` +
          `(${staticProcessed} static + ${dynamicProcessed} dynamic sections, ` +
          `${allNewMediaFiles.length} images migrated)`,
      })
    } catch (e: any) {
      return JSON.stringify({
        status: "error",
        message: `Failed to generate eval description: ${e.message}`,
        stack: e.stack?.split("\n").slice(0, 5),
      })
    }
  },
})
