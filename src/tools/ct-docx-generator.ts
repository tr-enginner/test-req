import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "fs"
import { dirname, join, isAbsolute } from "path"
import { readZip, writeZip, type ZipEntry } from "./docx-zip"
import {
  SourceConfirmationTestSuite,
  extractSourceSteps,
} from "../schema/confirmation-test-case"
import { ARTIFACT_PATHS, DATA_DIR, REPORTS_DIR } from "../shared/constants"
import { resolveTemplateAssetPath } from "../shared/template-resolution"
import { moduleDir } from "../shared/runtime-paths"
import {
  formatFunIdsAsRange,
  loadTestRequirementFile,
  normalizeTestRequirements,
  splitFunIds,
} from "../shared/test-requirements"

function resolvePath(p: string): string {
  return isAbsolute(p) ? p : join(process.cwd(), p)
}

// ─── XML Helpers ──────────────────────────────────────────────────

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
 * This merges adjacent <w:r> runs with same formatting within each <w:p>.
 */
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

// ─── Test Step Parsing ────────────────────────────────────────────

interface TestStep {
  步骤描述: string
  预期结果: string
}

/**
 * Parse the test_step field from ConfirmationTestCase.
 * New files store arrays; historical files may still contain JSON strings.
 * Unified steps render the SOURCE natural-language text (source_step_desc),
 * not the rendered keyword form (step_desc) — the DOCX is a human-readable
 * test specification.
 */
function parseTestSteps(testStep: unknown): TestStep[] {
  return extractSourceSteps(testStep).map((item) => ({
    步骤描述: String(item["步骤描述"] ?? ""),
    预期结果: String(item["预期结果"] ?? ""),
  }))
}

// ─── Step Row XML Generation ──────────────────────────────────────

/**
 * Build a single <w:tr> XML for a test step data row.
 * Matches the template structure: 序号(1808) | 测试步骤(5812, span4) | 预期结果(5374, span10) | 实际结果(1289)
 * Font: 宋体/Times New Roman, szCs=21 (10.5pt)
 */
function buildStepRow(index: number, action: string, expected: string): string {
  const escapedAction = escapeXml(action)
  const escapedExpected = escapeXml(expected)

  return [
    `<w:tr>`,
    `<w:trPr><w:trHeight w:val="104"/></w:trPr>`,
    // Cell 0: 序号 (center)
    `<w:tc>`,
    `<w:tcPr><w:tcW w:w="1808" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="auto"/><w:vAlign w:val="center"/></w:tcPr>`,
    `<w:p><w:pPr><w:jc w:val="center"/><w:rPr><w:szCs w:val="21"/></w:rPr></w:pPr>`,
    `<w:r><w:rPr><w:szCs w:val="21"/></w:rPr><w:t>${index}</w:t></w:r></w:p>`,
    `</w:tc>`,
    // Cell 1: 测试步骤 (left, gridSpan=4)
    `<w:tc>`,
    `<w:tcPr><w:tcW w:w="5812" w:type="dxa"/><w:gridSpan w:val="4"/><w:shd w:val="clear" w:color="auto" w:fill="auto"/><w:vAlign w:val="center"/></w:tcPr>`,
    `<w:p><w:pPr><w:rPr><w:szCs w:val="20"/></w:rPr></w:pPr>`,
    `<w:r><w:rPr><w:szCs w:val="20"/></w:rPr><w:t xml:space="preserve">${escapedAction}</w:t></w:r></w:p>`,
    `</w:tc>`,
    // Cell 2: 预期结果 (left, gridSpan=10)
    `<w:tc>`,
    `<w:tcPr><w:tcW w:w="5374" w:type="dxa"/><w:gridSpan w:val="10"/><w:tcBorders><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tcBorders><w:shd w:val="clear" w:color="auto" w:fill="auto"/><w:vAlign w:val="center"/></w:tcPr>`,
    `<w:p><w:pPr><w:rPr><w:szCs w:val="21"/></w:rPr></w:pPr>`,
    `<w:r><w:rPr><w:szCs w:val="21"/></w:rPr><w:t xml:space="preserve">${escapedExpected}</w:t></w:r></w:p>`,
    `</w:tc>`,
    // Cell 3: 实际结果 (center)
    `<w:tc>`,
    `<w:tcPr><w:tcW w:w="1289" w:type="dxa"/><w:tcBorders><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tcBorders><w:shd w:val="clear" w:color="auto" w:fill="auto"/><w:vAlign w:val="center"/></w:tcPr>`,
    `<w:p><w:pPr><w:jc w:val="center"/><w:rPr><w:szCs w:val="21"/></w:rPr></w:pPr>`,
    `<w:r><w:rPr><w:szCs w:val="21"/></w:rPr><w:t>-</w:t></w:r></w:p>`,
    `</w:tc>`,
    `</w:tr>`,
  ].join("")
}

/**
 * Find the header row containing "序号"/"测试步骤" and insert step data rows after it.
 */
function insertTestStepRows(tableXml: string, steps: TestStep[]): string {
  if (steps.length === 0) return tableXml

  // Find the header row: <w:tr> that contains both "序号" and "测试步骤"
  const trRegex = /<w:tr\b[^>]*>[\s\S]*?<\/w:tr>/g
  let headerMatch: RegExpExecArray | null = null
  let m: RegExpExecArray | null
  while ((m = trRegex.exec(tableXml)) !== null) {
    if (m[0].includes("序号") && m[0].includes("测试步骤")) {
      headerMatch = m
      break
    }
  }

  if (!headerMatch) return tableXml

  const insertPos = headerMatch.index + headerMatch[0].length
  const stepRowsXml = steps
    .map((step, i) => buildStepRow(i + 1, step.步骤描述, step.预期结果))
    .join("")

  return (
    tableXml.substring(0, insertPos) +
    stepRowsXml +
    tableXml.substring(insertPos)
  )
}

// ─── Aggressive Placeholder Normalization ─────────────────────────

/**
 * Second-pass placeholder normalization for stubborn split placeholders.
 *
 * After the basic normalizePlaceholders() which only merges runs with identical rPr,
 * this handles cases where Word applies different formatting to different parts of
 * a placeholder (e.g., bold on "{{" but not on "project_name}}").
 *
 * For each paragraph that still has incomplete placeholders, it force-merges
 * all runs between "{{" and "}}" using the first run's formatting.
 */
function normalizeAggressivePlaceholders(xml: string): string {
  return xml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (paragraph) => {
    // Quick check: does this paragraph even contain partial placeholders?
    const textContents: string[] = []
    paragraph.replace(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g, (_, text) => {
      textContents.push(text)
      return _
    })
    const joinedText = textContents.join("")
    if (!joinedText.includes("{{") || !joinedText.includes("}}")) {
      return paragraph
    }

    // Check if any single run already contains a complete placeholder
    // If all placeholders are already whole, no need to aggressive-merge
    const placeholderRe = /\{\{[^{}]+\}\}/g
    const wholePlaceholders = joinedText.match(placeholderRe) || []

    // Check per-run completeness
    let allComplete = true
    const runTexts: string[] = []
    paragraph.replace(/<w:r\b(?![^>]*\/>)(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g, (runXml) => {
      const textMatch = runXml.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/)
      runTexts.push(textMatch ? textMatch[1] : "")
      return runXml
    })

    // Reconstruct text and check if there are split placeholders
    const combined = runTexts.join("")
    const expectedPlaceholders = combined.match(placeholderRe) || []
    if (expectedPlaceholders.length === 0) return paragraph

    // Check each run for complete placeholders
    for (const ph of expectedPlaceholders) {
      const foundInSingleRun = runTexts.some((rt) => rt.includes(ph))
      if (!foundInSingleRun) {
        allComplete = false
        break
      }
    }

    if (allComplete) return paragraph

    // Need to force-merge runs across placeholder boundaries
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

    // Build merged array: force-merge runs within {{ ... }}
    const merged: Array<{ rPr: string; text: string }> = []
    let inPlaceholder = false
    let openIdx = -1

    for (let i = 0; i < runs.length; i++) {
      const run = runs[i]
      const text = run.text

      if (!inPlaceholder) {
        // Check if this run starts (or contains) "{{"
        const openPos = text.indexOf("{{")
        if (openPos !== -1) {
          // Split: text before {{ goes as-is, then start merging
          const before = text.substring(0, openPos)
          const after = text.substring(openPos)

          if (before) {
            merged.push({ rPr: run.rPr, text: before })
          }

          // Check if same run also closes the placeholder
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
        // Inside a placeholder — append text to the opening run
        const closePos = text.indexOf("}}")
        if (closePos !== -1) {
          const inside = text.substring(0, closePos + 2)
          const after = text.substring(closePos + 2)

          merged[openIdx].text += inside
          inPlaceholder = false

          if (after) {
            // Check if another placeholder opens
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
          // Still inside placeholder
          merged[openIdx].text += text
        }
      }
    }

    // Reconstruct paragraph
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

// ─── Font Normalization ───────────────────────────────────────────

/**
 * Normalize font properties in all <w:r> runs to:
 * - Font: Times New Roman (ascii/hAnsi/cs) + 宋体 (eastAsia)
 * - Size: 五号 (10.5pt = w:val="21")
 *
 * Ported from Python DocxTemplateProcessor.fix_font_properties().
 */
function fixFontProperties(xml: string): string {
  const fontXml = '<w:rFonts w:ascii="Times New Roman" w:eastAsia="宋体" w:hAnsi="Times New Roman" w:cs="Times New Roman"/>'
  const sizeXml = "<w:sz w:val=\"21\"/>"
  const sizeCsXml = "<w:szCs w:val=\"21\"/>"

  return xml.replace(/<w:r\b(?![^>]*\/>)(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g, (runXml) => {
    // Check if run has <w:rPr>
    const rPrMatch = runXml.match(/<w:rPr>([\s\S]*?)<\/w:rPr>/)
    if (rPrMatch) {
      let rPrContent = rPrMatch[1]

      // Replace or insert font
      if (/<w:rFonts\b/.test(rPrContent)) {
        rPrContent = rPrContent.replace(/<w:rFonts\b[^/>]*\/?>/, fontXml)
      } else {
        rPrContent = fontXml + rPrContent
      }

      // Replace or insert size
      if (/<w:sz\b/.test(rPrContent)) {
        rPrContent = rPrContent.replace(/<w:sz\b[^/>]*\/?>/, sizeXml)
      } else {
        rPrContent += sizeXml
      }

      // Replace or insert szCs
      if (/<w:szCs\b/.test(rPrContent)) {
        rPrContent = rPrContent.replace(/<w:szCs\b[^/>]*\/?>/, sizeCsXml)
      } else {
        rPrContent += sizeCsXml
      }

      return runXml.replace(/<w:rPr>[\s\S]*?<\/w:rPr>/, `<w:rPr>${rPrContent}</w:rPr>`)
    } else {
      // No rPr — insert one after <w:r> opening tag
      const rPr = `<w:rPr>${fontXml}${sizeXml}${sizeCsXml}</w:rPr>`
      return runXml.replace(/<w:r\b([^>]*)>/, `<w:r$1>${rPr}`)
    }
  })
}

// ─── Paragraph Spacing Fix ──────────────────────────────────────────

/**
 * Normalize paragraph spacing to fixed line height (15pt = w:line="300"):
 * - before="0", after="0", line="300", lineRule="exact"
 *
 * Preserves <w:numPr> and <w:jc> elements within <w:pPr>.
 * Ported from Python DocxTemplateProcessor.fix_paragraph_spacing().
 */
function fixParagraphSpacing(xml: string): string {
  const spacingXml = '<w:spacing w:before="0" w:after="0" w:line="300" w:lineRule="exact"/>'

  return xml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (paraXml) => {
    const pPrMatch = paraXml.match(/<w:pPr>([\s\S]*?)<\/w:pPr>/)
    if (pPrMatch) {
      let pPrContent = pPrMatch[1]

      // Replace or insert spacing
      if (/<w:spacing\b/.test(pPrContent)) {
        pPrContent = pPrContent.replace(/<w:spacing\b[^/>]*\/?>/, spacingXml)
      } else {
        pPrContent += spacingXml
      }

      return paraXml.replace(/<w:pPr>[\s\S]*?<\/w:pPr>/, `<w:pPr>${pPrContent}</w:pPr>`)
    } else {
      // No pPr — insert one after <w:p> opening tag
      const pPr = `<w:pPr>${spacingXml}</w:pPr>`
      return paraXml.replace(/<w:p\b([^>]*)>/, `<w:p$1>${pPr}`)
    }
  })
}

// ─── Numbering Restart ──────────────────────────────────────────────

interface NumberingResult {
  updatedCaseXml: string
  newNumberingEntries: string[]
}

function buildCaseDisplayNumber(caseIndex: number): string {
  return String(caseIndex + 1).padStart(4, "0")
}

function parseNumToAbstractMap(numberingXml: string): Map<number, number> {
  const mapping = new Map<number, number>()
  const numEntryRegex = /<w:num\b[^>]*w:numId="(\d+)"[^>]*>([\s\S]*?)<\/w:num>/g
  let match: RegExpExecArray | null
  while ((match = numEntryRegex.exec(numberingXml)) !== null) {
    const numId = Number.parseInt(match[1], 10)
    const body = match[2]
    const abstractMatch = body.match(/<w:abstractNumId\s+w:val="(\d+)"\/>/)
    if (abstractMatch) {
      mapping.set(numId, Number.parseInt(abstractMatch[1], 10))
    }
  }
  return mapping
}

function parseAbstractNumberingMap(numberingXml: string): Map<number, string> {
  const mapping = new Map<number, string>()
  const abstractRegex = /<w:abstractNum\b[^>]*w:abstractNumId="(\d+)"[^>]*>[\s\S]*?<\/w:abstractNum>/g
  let match: RegExpExecArray | null
  while ((match = abstractRegex.exec(numberingXml)) !== null) {
    mapping.set(Number.parseInt(match[1], 10), match[0])
  }
  return mapping
}

function isDynamicCaseTitleNumbering(abstractXml: string): boolean {
  return /<w:lvlText\b[^>]*w:val="测试用例%1"/.test(abstractXml)
}

function isFixedCaseTitleNumbering(abstractXml: string): boolean {
  return /<w:lvlText\b[^>]*w:val="测试用例0*1"/.test(abstractXml)
}

function cloneFixedCaseTitleAbstract(
  abstractXml: string,
  newAbstractNumId: number,
  caseIndex: number,
): string {
  return abstractXml
    .replace(
      /(<w:abstractNum\b[^>]*w:abstractNumId=")\d+(")/,
      `$1${newAbstractNumId}$2`,
    )
    .replace(
      /(<w:lvlText\b[^>]*w:val=")([^"]+)(")/,
      `$1测试用例${buildCaseDisplayNumber(caseIndex)}$3`,
    )
}

/**
 * Restart Word numbering for cloned template bodies.
 *
 * When a template body with numbered lists is cloned for each test case,
 * Word continues numbering across clones. This creates new numbering entries
 * per clone. Ordinary list numbering is restarted from 1, while the custom
 * "测试用例0001" title numbering is advanced to the current case index.
 *
 * @param caseXml - The cloned template XML for this test case
 * @param numberingXml - Content of word/numbering.xml
 * @param caseIndex - 0-based index of the test case clone
 * @returns Updated caseXml and new <w:num> entries to append to numbering.xml
 */
function restartNumbering(
  caseXml: string,
  numberingXml: string,
  caseIndex: number,
): NumberingResult {
  // Skip first case (index 0) — it uses the original numbering
  if (caseIndex === 0) {
    return { updatedCaseXml: caseXml, newNumberingEntries: [] }
  }

  // Find all numId references in the case XML
  const numIdRefs = new Set<number>()
  const numIdRefRegex = /<w:numId\s+w:val="(\d+)"/g
  let m: RegExpExecArray | null
  while ((m = numIdRefRegex.exec(caseXml)) !== null) {
    numIdRefs.add(parseInt(m[1], 10))
  }

  if (numIdRefs.size === 0) {
    return { updatedCaseXml: caseXml, newNumberingEntries: [] }
  }

  const numToAbstract = parseNumToAbstractMap(numberingXml)
  const abstractMap = parseAbstractNumberingMap(numberingXml)
  const existingNumIds = [...numToAbstract.keys()]
  const existingAbstractNumIds = [...abstractMap.keys()]
  const maxExistingNumId = existingNumIds.length > 0 ? Math.max(...existingNumIds) : 0
  const maxExistingAbstractNumId = existingAbstractNumIds.length > 0 ? Math.max(...existingAbstractNumIds) : 0

  // Generate new numId for each referenced numId
  const newEntries: string[] = []
  let updatedXml = caseXml
  let seq = 0

  for (const oldNumId of numIdRefs) {
    const abstractNumId = numToAbstract.get(oldNumId)
    if (abstractNumId === undefined) continue

    const abstractXml = abstractMap.get(abstractNumId) ?? ""
    let targetAbstractNumId = abstractNumId
    let startOverride = 1

    if (isDynamicCaseTitleNumbering(abstractXml)) {
      startOverride = caseIndex + 1
    } else if (isFixedCaseTitleNumbering(abstractXml)) {
      targetAbstractNumId = maxExistingAbstractNumId + caseIndex * 100 + seq + 1
      newEntries.push(cloneFixedCaseTitleAbstract(abstractXml, targetAbstractNumId, caseIndex))
    }

    const newNumId = maxExistingNumId + caseIndex * 100 + seq + 1
    seq += 1

    // Create new <w:num> entry with startOverride
    const entry =
      `<w:num w:numId="${newNumId}">` +
      `<w:abstractNumId w:val="${targetAbstractNumId}"/>` +
      `<w:lvlOverride w:ilvl="0"><w:startOverride w:val="${startOverride}"/></w:lvlOverride>` +
      `</w:num>`

    newEntries.push(entry)

    // Replace old numId references in the case XML
    const oldPattern = new RegExp(`<w:numId\\s+w:val="${oldNumId}"`, "g")
    updatedXml = updatedXml.replace(oldPattern, `<w:numId w:val="${newNumId}"`)
  }

  return { updatedCaseXml: updatedXml, newNumberingEntries: newEntries }
}

// ─── Replacement Dict ─────────────────────────────────────────────

/**
 * Convert path field ("/6/2/1/") to section number ("6.2.1").
 * Mirrors Python `extract_section_number()`.
 */
function extractSectionNumber(path?: string): string {
  if (!path) return ""
  const cleaned = path.replace(/^\/+|\/+$/g, "")
  return cleaned ? cleaned.replace(/\//g, ".") : ""
}

/**
 * Format date string to "YYYYMMDD".
 * Handles ISO strings, "YYYY-MM-DD HH:MM:SS", or already-formatted "YYYYMMDD".
 */
function formatDate(dateStr?: string): string {
  if (!dateStr) return ""
  // Already YYYYMMDD
  if (/^\d{8}$/.test(dateStr)) return dateStr
  try {
    const dt = new Date(dateStr)
    if (isNaN(dt.getTime())) return ""
    const y = dt.getFullYear()
    const m = String(dt.getMonth() + 1).padStart(2, "0")
    const d = String(dt.getDate()).padStart(2, "0")
    return `${y}${m}${d}`
  } catch {
    return ""
  }
}

interface ReplacementContext {
  softwareId: string
  codeVersion: string
}

/**
 * Build placeholder → value replacement dict for a single test case.
 * Mirrors Python `convert_test_case_to_replacement_dict()`.
 */
function buildReplacementDict(
  tc: any,
  ctx: ReplacementContext,
  caseDisplayIndex: number,
): Record<string, string> {
  const correspondFunId = tc.correspond_fun_id ?? ""
  // correspond_fun_id may be 、-separated multi-ID — use the first ID for middle-part parsing
  const primaryFunId = splitFunIds(correspondFunId)[0] ?? correspondFunId
  // 覆盖测试需求项显示的是本用例实际覆盖的 TR 子集(related_software_req_ids),
  // 不是需求项整组 funId(correspond_fun_id)——2026-08-20 用户报告:曾把整组
  // TR-JK-001~008 显示进覆盖列,夸大单用例覆盖范围。rsrid 缺失(历史数据)才回退整组。
  const relatedReqIds = typeof tc.related_software_req_ids === "string" ? tc.related_software_req_ids.trim() : ""
  const trIdDisplay = relatedReqIds
    ? (formatFunIdsAsRange(splitFunIds(relatedReqIds)) || relatedReqIds)
    : (formatFunIdsAsRange(splitFunIds(correspondFunId)) || correspondFunId)

  // Parse TR ID middle part (simplified — split on '-')
  let trIdMiddle = ""
  if (primaryFunId) {
    const parts = primaryFunId.split("-")
    if (parts.length > 1) {
      // Middle = everything between first element and trailing numbers
      const middleParts: string[] = []
      for (let i = 1; i < parts.length; i++) {
        // If it's a zero-padded pure number at the end, skip
        if (i === parts.length - 1 && /^0\d+$/.test(parts[i])) break
        middleParts.push(parts[i])
      }
      trIdMiddle = middleParts.join("-") || parts[1] || ""
    } else {
      trIdMiddle = primaryFunId
    }
  }

  return {
    "{{software_id}}": ctx.softwareId,
    "{{code_version}}": ctx.codeVersion,
    "{{case_id}}": tc.case_id ?? "",
    "{{tr_id_middle}}": trIdMiddle,
    "{{tr_id}}": trIdDisplay,
    "{{section_number}}": extractSectionNumber(tc.path),
    "{{category}}": tc.test_type ?? "",
    "{{date}}": formatDate(tc.designer_date || tc.create_time),
    "{{test_environ}}": tc.test_environment ?? "",
    "{{init_settings}}": tc.initial_settings ?? "",
    "{{designer}}": tc.designer ?? "",
    "{{test_input}}": tc.test_input ?? "",
    "{{case_number}}": String(caseDisplayIndex).padStart(4, "0"),
    "{{tc_number}}": String(caseDisplayIndex).padStart(3, "0"),
    "{{test_case_name}}": tc.case_name ?? "",
    "{{test_purpose}}": tc.test_purpose ?? "",
    "{{constraints}}": tc.constraints ?? "",
    "{{assess_criteria}}": tc.assess_criteria ?? "",
    "{{cease_condition}}": tc.cease_condition ?? "",
  }
}

// ─── Template Body Extraction ─────────────────────────────────────

/**
 * Extract the repeating template body elements (everything between <w:body> and <w:sectPr>).
 * The template contains: heading <w:p> + <w:tbl> + empty <w:p/> for each test case.
 * Returns the template fragment that will be cloned per test case.
 */
function extractTemplateBody(xml: string): { before: string; template: string; sectPr: string; after: string } | null {
  // Find <w:body> ... </w:body>
  const bodyStart = xml.indexOf("<w:body>")
  const bodyEnd = xml.indexOf("</w:body>")
  if (bodyStart === -1 || bodyEnd === -1) return null

  const bodyContentStart = bodyStart + "<w:body>".length
  const bodyContent = xml.substring(bodyContentStart, bodyEnd)

  // Find <w:sectPr ...>...</w:sectPr> at the end of body
  const sectPrMatch = bodyContent.match(/<w:sectPr\b[\s\S]*?<\/w:sectPr>\s*$/)
  if (!sectPrMatch) return null

  const sectPrStart = bodyContent.lastIndexOf(sectPrMatch[0])
  const templateContent = bodyContent.substring(0, sectPrStart).trim()
  const sectPrContent = sectPrMatch[0]

  return {
    before: xml.substring(0, bodyContentStart),
    template: templateContent,
    sectPr: sectPrContent,
    after: xml.substring(bodyEnd),
  }
}

// ─── Page Break XML ───────────────────────────────────────────────

const PAGE_BREAK = `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`

// ─── Requirement Order Helper ─────────────────────────────────────

function loadReqOrderMap(testRequirementsPath: string): Map<string, number> {
  const orderMap = new Map<string, number>()
  try {
    if (!existsSync(testRequirementsPath)) return orderMap
    const artifact = loadTestRequirementFile(testRequirementsPath)
    const reqs = normalizeTestRequirements(artifact)
    reqs.forEach((req, idx) => {
      if (req.id) orderMap.set(req.id, idx)
    })
  } catch { /* ignore */ }
  return orderMap
}

// ─── Tool Definition ──────────────────────────────────────────────

/**
 * ct_docx_generate — Generate a DOCX confirmation test case document from confirmation-tests.json.
 *
 * Ported from auto-testcase-generator's /generateWordFromDb service.
 * Reads test cases from .matrix/data/confirmation-tests.json, applies each to a DOCX template
 * with placeholder substitution and dynamic step row insertion, outputs a multi-page DOCX.
 *
 * No LLM calls — purely deterministic template expansion.
 */
export const ctDocxGenerator: ToolDefinition = tool({
  description:
    "Generate a DOCX confirmation test case document (确认测试用例文档) from confirmation-tests.json. " +
    "Reads test cases from .matrix/data/confirmation-tests.json, clones a DOCX template per case " +
    "with placeholder substitution and dynamic test step row insertion, outputs .matrix/reports/confirmation-tests.docx. " +
    "No LLM calls — purely deterministic template-based generation.",
  args: {
    test_cases_file: tool.schema
      .string()
      .optional()
      .describe(
        "Path to confirmation-tests.json file. Default: .matrix/data/confirmation-tests.json",
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
        "Output path for generated DOCX. Default: .matrix/reports/confirmation-tests.docx",
      ),
    software_id: tool.schema
      .string()
      .optional()
      .describe(
        "Software identifier to fill {{software_id}} placeholder. Default: empty string",
      ),
    code_version: tool.schema
      .string()
      .optional()
      .describe(
        "Code version to fill {{code_version}} placeholder. Default: empty string",
      ),
    cover_info_file: tool.schema
      .string()
      .optional()
      .describe(
        "Path to cover-info.json (from cover_info_extract tool). " +
        "All 18 cover fields become additional placeholders. " +
        "Default: .matrix/data/cover-info.json (auto-loaded if exists)",
      ),
    fix_formatting: tool.schema
      .boolean()
      .optional()
      .describe(
        "Apply DOCX format quality control: font normalization (宋体/Times New Roman 五号), " +
        "paragraph spacing fix (fixed 15pt line height), and numbering restart per test case. " +
        "Default: true",
      ),
  },
  async execute({ test_cases_file, template_path, output_path, software_id, code_version, cover_info_file, fix_formatting }) {
    // ── Resolve paths ────────────────────────────────────────────
    const testCasesPath = test_cases_file
      ? resolvePath(test_cases_file)
      : join(process.cwd(), ARTIFACT_PATHS.CONFIRMATION_TESTS)

    const projectDir = process.cwd()
    const { path: templatePath, checked: checkedTemplates } = resolveTemplateAssetPath({
      filename: "ct-template.docx",
      importMetaDir: moduleDir(import.meta.url),
      projectDir,
      preferredPath: template_path ? resolvePath(template_path) : undefined,
    })

    const outputDocxPath = output_path
      ? resolvePath(output_path)
      : join(process.cwd(), REPORTS_DIR, "confirmation-tests.docx")

    // ── Validate inputs ──────────────────────────────────────────
    if (!existsSync(testCasesPath)) {
      return JSON.stringify({
        error: `Confirmation tests file not found: ${testCasesPath}`,
        hint: "Run Phase 6 (Test Case Design) first to generate confirmation-tests.json",
      })
    }

    if (!templatePath || !existsSync(templatePath)) {
      return JSON.stringify({
        error: `Template file not found: ${templatePath || "ct-template.docx"}`,
        hint:
          `Checked: ${checkedTemplates.join(", ")}. ` +
          "Place the confirmation test template at the project business template path templates/ct-template.docx, " +
          "or provide a template_path argument. " +
          "The original template is '测试用例生成模板-web.docx' from auto-testcase-generator.",
      })
    }

    // ── Read and validate test case data ─────────────────────────
    let rawData: unknown
    try {
      rawData = JSON.parse(readFileSync(testCasesPath, "utf-8"))
    } catch (e) {
      return JSON.stringify({
        error: `Failed to parse confirmation tests JSON: ${testCasesPath}`,
      })
    }

    // Validate the file as written FIRST: parameter Value may legitimately be
    // null (schema: z.union([string, number, null])), and the historical
    // null→undefined coercion made those entries fail as invalid_union.
    // The coercion stays as a lenient second chance for optional fields that
    // arrive as explicit nulls.
    let parsed = SourceConfirmationTestSuite.safeParse(rawData)
    if (!parsed.success) {
      const coercedParse = SourceConfirmationTestSuite.safeParse(coerceNulls(rawData))
      if (coercedParse.success) {
        parsed = coercedParse
      }
    }
    if (!parsed.success) {
      return JSON.stringify({
        error: "Confirmation tests data validation failed",
        issues: parsed.error.issues.slice(0, 10).map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      })
    }

    const suite = parsed.data

    const reqOrderMap = loadReqOrderMap(join(dirname(testCasesPath), "test-requirements.json"))
    const testCases = suite.test_cases
      .map((testCase, originalIndex) => ({ testCase, originalIndex }))
      .sort((a, b) => {
        const aReqId = String(a.testCase.correspond_fun_id ?? "")
        const bReqId = String(b.testCase.correspond_fun_id ?? "")
        const ai = reqOrderMap.get(aReqId)
        const bi = reqOrderMap.get(bReqId)

        if (ai !== undefined && bi !== undefined && ai !== bi) {
          return ai - bi
        }

        return a.originalIndex - b.originalIndex
      })
      .map((entry) => entry.testCase)

    if (testCases.length === 0) {
      return JSON.stringify({
        error: "No test cases found in confirmation-tests.json",
        hint: "Run Phase 6 (Test Case Design) first to generate test cases",
      })
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
    xml = normalizePlaceholders(xml)
    xml = normalizeAggressivePlaceholders(xml)

    // Step 2: Extract template body (content between <w:body> and <w:sectPr>)
    const parts = extractTemplateBody(xml)
    if (!parts) {
      return JSON.stringify({
        error: "Failed to extract template body structure from document.xml",
      })
    }

    // Step 2.5: Load cover info if available
    const coverInfoPath = cover_info_file
      ? resolvePath(cover_info_file)
      : join(process.cwd(), DATA_DIR, "cover-info.json")

    let coverReplacements: Record<string, string> = {}
    if (existsSync(coverInfoPath)) {
      try {
        const coverData = JSON.parse(readFileSync(coverInfoPath, "utf-8"))
        // Map all cover info fields to {{field_name}} placeholders
        const fieldNames = [
          "config_id", "file_name", "cover_date",
          "preparation", "proofread", "review", "std_review", "countersign", "approval",
          "req_version", "design_version", "guide_version",
          "static_test_tool", "simulation_test_tool", "static_timing_analysis_tool",
          "resource_remain", "clock_remain", "develop_environment",
        ]
        for (const field of fieldNames) {
          const value = coverData[field]
          if (value != null && value !== "") {
            coverReplacements[`{{${field}}}`] = String(value)
          }
        }
      } catch { /* ignore parse errors */ }
    }

    // Step 2.6: Read numbering.xml for numbering restart
    const applyFormatting = fix_formatting !== false // default true
    const numberingXmlBuf = zipEntries.get("word/numbering.xml")
    const numberingXml = numberingXmlBuf?.toString("utf-8") ?? null

    // Step 3: Clone template per test case, replace placeholders, insert step rows
    const ctx: ReplacementContext = {
      softwareId: software_id ?? "",
      codeVersion: code_version ?? "",
    }

    const expandedBodies: string[] = []
    const allNewNumEntries: string[] = []

    for (let i = 0; i < testCases.length; i++) {
      const tc = testCases[i]
      let caseXml = parts.template

      // Build replacement dict
      const replacements = buildReplacementDict(tc, ctx, i + 1)

      // Parse test steps and insert rows into the table
      const steps = parseTestSteps(tc.test_step)
      caseXml = insertTestStepRows(caseXml, steps)

      // Replace per-case placeholders
      for (const [placeholder, value] of Object.entries(replacements)) {
        caseXml = caseXml.replaceAll(placeholder, escapeXml(value))
      }

      // Replace cover info placeholders
      for (const [placeholder, value] of Object.entries(coverReplacements)) {
        caseXml = caseXml.replaceAll(placeholder, escapeXml(value))
      }

      // Remove the {{test_step}} placeholder text if it still exists
      caseXml = caseXml.replaceAll("{{test_step}}", "")

      // Apply DOCX format quality control
      if (applyFormatting) {
        caseXml = fixFontProperties(caseXml)
        caseXml = fixParagraphSpacing(caseXml)
      }

      // Restart numbering for cloned bodies (skip first case)
      if (numberingXml && i > 0) {
        const result = restartNumbering(caseXml, numberingXml, i)
        caseXml = result.updatedCaseXml
        allNewNumEntries.push(...result.newNumberingEntries)
      }

      expandedBodies.push(caseXml)
    }

    // Step 4: Join with page breaks, reconstruct document
    const joinedBody = expandedBodies.join(PAGE_BREAK)
    const newXml = parts.before + joinedBody + parts.sectPr + parts.after

    // ── Write output ─────────────────────────────────────────────
    zipEntries.set("word/document.xml", Buffer.from(newXml, "utf-8"))

    // Append new numbering entries to word/numbering.xml
    if (allNewNumEntries.length > 0 && numberingXml) {
      const updatedNumbering = numberingXml.replace(
        /<\/w:numbering>/,
        allNewNumEntries.join("") + "</w:numbering>",
      )
      zipEntries.set("word/numbering.xml", Buffer.from(updatedNumbering, "utf-8"))
    }

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
      test_case_count: testCases.length,
      size_bytes: outputBuffer.length,
      message: `Generated confirmation test document with ${testCases.length} test cases → ${outputDocxPath}`,
    })
  },
})

// ─── Utility ──────────────────────────────────────────────────────

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
