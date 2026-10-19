/**
 * docx-range-copy.ts — Cross-document section content range extraction and insertion.
 *
 * Extracts XML elements between two headings and replaces placeholders in a template.
 * Also handles revision history extraction and replacement.
 *
 * Migrated from Python _extract_xml_elements_in_range() + _replace_with_range_xml_elements().
 */

import {
  resolveHeadings,
  findHeadingByTitle,
  findSectionRange,
  type HeadingEntry,
} from "./docx-heading-resolver"

// ─── Types ─────────────────────────────────────────────────────────

export interface ExtractedRange {
  /** XML fragment containing all <w:p> and <w:tbl> elements in the range */
  fragment: string
  /** Whether the range was successfully found */
  found: boolean
}

// ─── Range Extraction ──────────────────────────────────────────────

/**
 * Extract content between two headings in a document.
 *
 * @param docXml - Full word/document.xml content
 * @param headings - Pre-resolved headings array
 * @param startTitle - Title of the start heading
 * @param endTitle - Title of the end heading (optional; if omitted, extracts to end of document)
 * @param options - Include/exclude start and end titles
 */
export function extractXmlRange(
  docXml: string,
  headings: HeadingEntry[],
  startTitle: string,
  endTitle?: string,
  options?: { includeStartTitle?: boolean; includeEndTitle?: boolean },
): ExtractedRange {
  const range = findSectionRange(docXml, headings, startTitle, endTitle, options)
  if (!range) {
    return { fragment: "", found: false }
  }

  let fragment = docXml.substring(range.startOffset, range.endOffset)

  // Remove <w:sectPr> elements from the fragment (prevent unwanted page breaks)
  fragment = fragment.replace(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g, "")

  return { fragment, found: true }
}

// ─── Placeholder Replacement ───────────────────────────────────────

/**
 * Replace a placeholder paragraph in template XML with extracted content.
 *
 * The placeholder is a text like {{chapter_1}} within a <w:p> element.
 * The entire paragraph containing the placeholder is replaced with the content fragment.
 */
export function replacePlaceholderWithContent(
  templateXml: string,
  placeholder: string,
  contentFragment: string,
): string {
  // Find the <w:p> paragraph that contains the placeholder
  const escapedPlaceholder = placeholder.replace(/[{}]/g, (c) => `\\${c}`)
  const paraRegex = new RegExp(
    `<w:p\\b[^>]*>[\\s\\S]*?${escapedPlaceholder}[\\s\\S]*?<\\/w:p>`,
  )
  const match = templateXml.match(paraRegex)

  if (!match) {
    // Try with normalized placeholders (split across runs)
    // Look for the placeholder text across multiple <w:t> elements
    return replacePlaceholderAcrossRuns(templateXml, placeholder, contentFragment)
  }

  return templateXml.replace(match[0], contentFragment)
}

/**
 * Handle case where placeholder is split across multiple <w:r> runs.
 */
function replacePlaceholderAcrossRuns(
  templateXml: string,
  placeholder: string,
  contentFragment: string,
): string {
  // Find paragraphs and check if their combined text contains the placeholder
  const paraRegex = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g
  let pm: RegExpExecArray | null

  while ((pm = paraRegex.exec(templateXml)) !== null) {
    const paraXml = pm[0]
    // Extract all text from this paragraph
    const texts: string[] = []
    const tRegex = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g
    let tm: RegExpExecArray | null
    while ((tm = tRegex.exec(paraXml)) !== null) {
      texts.push(tm[1])
    }
    const joinedText = texts.join("")

    if (joinedText.includes(placeholder)) {
      // Replace the entire paragraph
      return templateXml.replace(paraXml, contentFragment)
    }
  }

  // Placeholder not found — return unchanged
  return templateXml
}

// ─── Revision History ──────────────────────────────────────────────

const REVISION_KEYWORDS = ["修订历史记录", "修订历史", "版本历史", "修改历史", "变更历史"]
const REVISION_TABLE_HEADERS = ["日期", "版本", "修订人", "说明", "描述", "变更"]

/**
 * Extract revision history (title paragraph + table) from a reference document.
 */
export function extractRevisionHistory(
  refDocXml: string,
): { paragraphXml: string; tableXml: string } | null {
  // Search for revision history keyword in paragraphs
  const paraRegex = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g
  let pm: RegExpExecArray | null
  let revisionParaXml: string | null = null
  let revisionParaEnd = -1

  while ((pm = paraRegex.exec(refDocXml)) !== null) {
    const paraXml = pm[0]
    const texts: string[] = []
    const tRegex = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g
    let tm: RegExpExecArray | null
    while ((tm = tRegex.exec(paraXml)) !== null) {
      texts.push(tm[1])
    }
    const text = texts.join("")

    if (REVISION_KEYWORDS.some((kw) => text.includes(kw))) {
      revisionParaXml = paraXml
      revisionParaEnd = pm.index + pm[0].length
      break
    }
  }

  if (!revisionParaXml || revisionParaEnd === -1) return null

  // Find the next table after the revision history paragraph
  const afterPara = refDocXml.substring(revisionParaEnd)
  const tblMatch = afterPara.match(/<w:tbl\b[^>]*>[\s\S]*?<\/w:tbl>/)
  if (!tblMatch) return null

  // Validate: check if the table has revision-like headers
  const tableXml = tblMatch[0]
  const hasRevisionHeaders = REVISION_TABLE_HEADERS.some((header) =>
    tableXml.includes(header),
  )
  if (!hasRevisionHeaders) return null

  return { paragraphXml: revisionParaXml, tableXml }
}

/**
 * Replace revision history in the template with content from the reference document.
 */
export function replaceRevisionHistory(
  templateXml: string,
  revision: { paragraphXml: string; tableXml: string },
): string {
  // Find revision history in template
  const paraRegex = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g
  let pm: RegExpExecArray | null
  let templateRevParaStart = -1
  let templateRevParaEnd = -1

  while ((pm = paraRegex.exec(templateXml)) !== null) {
    const texts: string[] = []
    const tRegex = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g
    let tm: RegExpExecArray | null
    while ((tm = tRegex.exec(pm[0])) !== null) {
      texts.push(tm[1])
    }
    const text = texts.join("")

    if (REVISION_KEYWORDS.some((kw) => text.includes(kw))) {
      templateRevParaStart = pm.index
      templateRevParaEnd = pm.index + pm[0].length
      break
    }
  }

  if (templateRevParaStart === -1) return templateXml

  // Find the table after the revision paragraph in the template
  const afterTemplatePara = templateXml.substring(templateRevParaEnd)
  const tblMatch = afterTemplatePara.match(/<w:tbl\b[^>]*>[\s\S]*?<\/w:tbl>/)
  if (!tblMatch) {
    // No table found — just replace the paragraph
    return (
      templateXml.substring(0, templateRevParaStart) +
      revision.paragraphXml +
      revision.tableXml +
      templateXml.substring(templateRevParaEnd)
    )
  }

  // Replace both paragraph and table
  const tblEnd = templateRevParaEnd + (tblMatch.index ?? 0) + tblMatch[0].length
  return (
    templateXml.substring(0, templateRevParaStart) +
    revision.paragraphXml +
    revision.tableXml +
    templateXml.substring(tblEnd)
  )
}
