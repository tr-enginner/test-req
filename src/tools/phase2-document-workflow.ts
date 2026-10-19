import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs"
import { dirname, resolve } from "path"
import type { ToolContext } from "@opencode-ai/plugin"
import { readZip, writeZip, type ZipEntry } from "./docx-zip"
import { formatTestRequirementsDocx } from "./test-requirements-docx-format"
import { resolveTemplateAssetPath } from "../shared/template-resolution"
import { moduleDir } from "../shared/runtime-paths"

interface ChapterReport {
  title: string
  path: string
}

const CONTENT_TYPES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>'
const ROOT_RELS_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
const DOCUMENT_RELS_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'
const DOCUMENT_OPEN =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:w10="urn:schemas-microsoft-com:office:word" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup" xmlns:wpi="http://schemas.microsoft.com/office/word/2010/wordprocessingInk" xmlns:wne="http://schemas.microsoft.com/office/word/2006/wordml" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" mc:Ignorable="w14 w15 wp14"><w:body>'
const DEFAULT_SECT_PR =
  '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1080" w:bottom="1440" w:left="1080"/></w:sectPr>'
const PHASE2_COVER_TEMPLATE = "phase2-test-requirements-cover.docx"

interface Chapter1CoverData {
  software_name_and_id: string
  document_id: string
  system_name: string
  model_name: string
}

function reportPath(ctx: ToolContext, fallback: string): string {
  return resolve(ctx.directory, fallback)
}

function chapterReports(ctx: ToolContext): ChapterReport[] {
  return [
    { title: "1 范围", path: reportPath(ctx, ".matrix/reports/chapter1-scope.docx") },
    { title: "2 系统概述", path: reportPath(ctx, ".matrix/reports/chapter2-system-overview.docx") },
    { title: "3.1 硬件接口", path: reportPath(ctx, ".matrix/reports/hardware-interface-model.docx") },
    { title: "4.1 功能测试", path: reportPath(ctx, ".matrix/reports/functional-test-content.docx") },
    { title: "4.2 性能测试", path: reportPath(ctx, ".matrix/reports/performance-test-content.docx") },
    { title: "4.3 接口测试", path: reportPath(ctx, ".matrix/reports/interface-test-content.docx") },
    { title: "4.4 可靠性安全性测试", path: reportPath(ctx, ".matrix/reports/reliability-safety-test-content.docx") },
    { title: "4.5 余量测试", path: reportPath(ctx, ".matrix/reports/margin-test-content.docx") },
    { title: "4.6 边界测试", path: reportPath(ctx, ".matrix/reports/boundary-test-content.docx") },
    { title: "4.7 数据处理测试", path: reportPath(ctx, ".matrix/reports/data-processing-test-content.docx") },
    { title: "4.8 恢复性测试", path: reportPath(ctx, ".matrix/reports/recovery-test-content.docx") },
    { title: "4.9 强度测试", path: reportPath(ctx, ".matrix/reports/strength-test-content.docx") },
    { title: "6  测试需求覆盖性说明", path: reportPath(ctx, ".matrix/reports/phase2-test-traceability.docx") },
  ]
}

function bodyContent(documentXml: string, sourcePath: string): { content: string; sectPr: string } {
  const body = documentXml.match(/<w:body\b[^>]*>([\s\S]*?)<\/w:body>/)
  if (!body) throw new Error(`Invalid DOCX document.xml without w:body: ${sourcePath}`)
  const sectMatches = [...body[1].matchAll(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g)]
  const sectPr = sectMatches.at(-1)?.[0] ?? DEFAULT_SECT_PR
  return {
    content: body[1].replace(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g, ""),
    sectPr,
  }
}

function styleBlocks(stylesXml: string): Array<{ id: string; xml: string }> {
  const result: Array<{ id: string; xml: string }> = []
  const regex = /<w:style\b[^>]*w:styleId="([^"]+)"[^>]*>[\s\S]*?<\/w:style>/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(stylesXml)) !== null) result.push({ id: match[1], xml: match[0] })
  return result
}

function templateBodyContent(documentXml: string): { content: string; sectPr: string } {
  const body = documentXml.match(/<w:body\b[^>]*>([\s\S]*?)<\/w:body>/)
  if (!body) throw new Error(`Invalid DOCX document.xml without w:body: ${PHASE2_COVER_TEMPLATE}`)
  const sectMatches = [...body[1].matchAll(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g)]
  const finalSection = sectMatches.at(-1)
  if (!finalSection || finalSection.index === undefined) {
    throw new Error("Phase 2 cover template is missing its final section properties.")
  }
  return {
    content: body[1].slice(0, finalSection.index) + body[1].slice(finalSection.index + finalSection[0].length),
    sectPr: finalSection[0],
  }
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function xmlUnescape(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
}

interface TextNodeMatch {
  contentStart: number
  contentEnd: number
  text: string
  plainStart: number
  plainEnd: number
}

function textNodes(xml: string): TextNodeMatch[] {
  const result: TextNodeMatch[] = []
  const regex = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g
  let plainOffset = 0
  let match: RegExpExecArray | null
  while ((match = regex.exec(xml)) !== null) {
    const text = xmlUnescape(match[1])
    const contentStart = match.index + match[0].indexOf(match[1])
    result.push({
      contentStart,
      contentEnd: contentStart + match[1].length,
      text,
      plainStart: plainOffset,
      plainEnd: plainOffset + text.length,
    })
    plainOffset += text.length
  }
  return result
}

/** Replace visible Word text even when one placeholder is split across multiple runs. */
function replaceVisibleText(xml: string, search: string, replacement: string): string {
  while (true) {
    const nodes = textNodes(xml)
    const plainText = nodes.map((node) => node.text).join("")
    const occurrence = plainText.indexOf(search)
    if (occurrence < 0) return xml
    const occurrenceEnd = occurrence + search.length
    const affected = nodes.filter((node) => node.plainEnd > occurrence && node.plainStart < occurrenceEnd)
    if (affected.length === 0) return xml

    const edits: Array<{ start: number; end: number; value: string }> = []
    affected.forEach((node, index) => {
      const localStart = Math.max(0, occurrence - node.plainStart)
      const localEnd = Math.min(node.text.length, occurrenceEnd - node.plainStart)
      const prefix = node.text.slice(0, localStart)
      const suffix = node.text.slice(localEnd)
      edits.push({
        start: node.contentStart,
        end: node.contentEnd,
        value: xmlEscape(prefix + (index === 0 ? replacement : "") + suffix),
      })
    })
    edits.sort((left, right) => right.start - left.start)
    for (const edit of edits) xml = xml.slice(0, edit.start) + edit.value + xml.slice(edit.end)
  }
}

function replaceCoverPlaceholders(xml: string, data: Chapter1CoverData): string {
  const compositeVariants = [
    "{型号或者项目代号}{软件全称}（{软件标识号}）",
    "{型号或者项目代号} {软件全称}（{软件标识号}）",
    "{型号或者项目代号}  {软件全称}（{软件标识号}）",
  ]
  for (const placeholder of compositeVariants) {
    xml = replaceVisibleText(xml, placeholder, data.software_name_and_id)
  }
  return [
    ["{文档标识}", data.document_id],
    ["{软件全称}", data.system_name],
    ["{型号或者项目代号}", data.model_name],
    ["{软件标识号}", ""],
  ].reduce((result, [placeholder, value]) => replaceVisibleText(result, placeholder, value), xml)
}

function removeFrontMatterHeadingStyles(documentXml: string): string {
  return documentXml.replace(/<w:pStyle\b[^>]*w:val="(?:[234]|Heading[123])"[^>]*\/?\s*>/g, "")
}

function fitCoverSoftwareName(documentXml: string, softwareNameAndId: string): string {
  const escapedValue = xmlEscape(softwareNameAndId)
  const valueOffset = documentXml.indexOf(escapedValue)
  if (valueOffset < 0) return documentXml
  const paragraphMatches = [...documentXml.slice(0, valueOffset).matchAll(/<w:p(?:\s[^>]*)?>/g)]
  const paragraphStart = paragraphMatches.at(-1)?.index ?? -1
  const paragraphEnd = documentXml.indexOf("</w:p>", valueOffset)
  if (paragraphStart < 0 || paragraphEnd < 0) return documentXml
  let paragraph = documentXml.slice(paragraphStart, paragraphEnd + "</w:p>".length)
  paragraph = paragraph.replace(/<w:spacing\b[^>]*\/?\s*>/, '<w:spacing w:line="360" w:lineRule="auto"/>')
  paragraph = paragraph
    .replace(/<w:sz\b[^>]*w:val="(?:30|32)"[^>]*\/?\s*>/g, '<w:sz w:val="24"/>')
    .replace(/<w:szCs\b[^>]*w:val="(?:30|32)"[^>]*\/?\s*>/g, '<w:szCs w:val="24"/>')
  return documentXml.slice(0, paragraphStart) + paragraph + documentXml.slice(paragraphEnd + "</w:p>".length)
}

function matchingFieldEnd(xml: string, beginOffset: number): number {
  const fieldChar = /<w:fldChar\b[^>]*w:fldCharType="(begin|end)"[^>]*\/?\s*>/g
  fieldChar.lastIndex = beginOffset
  let depth = 0
  let match: RegExpExecArray | null
  while ((match = fieldChar.exec(xml)) !== null) {
    if (match[1] === "begin") depth += 1
    else depth -= 1
    if (depth === 0) return fieldChar.lastIndex
  }
  throw new Error("Phase 2 cover template contains an unbalanced TOC field.")
}

function resetTableOfContents(documentXml: string): string {
  const instruction = documentXml.match(/<w:instrText\b[^>]*>[\s\S]*?TOC[\s\S]*?<\/w:instrText>/)
  if (!instruction || instruction.index === undefined) {
    throw new Error("Phase 2 cover template is missing its TOC field.")
  }
  const beginMatches = [...documentXml.slice(0, instruction.index).matchAll(/<w:fldChar\b[^>]*w:fldCharType="begin"[^>]*\/?\s*>/g)]
  const begin = beginMatches.at(-1)
  if (!begin || begin.index === undefined) throw new Error("Phase 2 cover template TOC field has no begin marker.")
  const beginOffset = begin.index
  const fieldEnd = matchingFieldEnd(documentXml, beginOffset)
  const paragraphMatches = [...documentXml.slice(0, beginOffset).matchAll(/<w:p(?:\s[^>]*)?>/g)]
  const paragraphStart = paragraphMatches.at(-1)?.index ?? -1
  const paragraphEnd = documentXml.indexOf("</w:p>", fieldEnd)
  if (paragraphStart < 0 || paragraphEnd < 0) throw new Error("Phase 2 cover template TOC paragraph is invalid.")
  const title = '<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="0" w:after="240"/></w:pPr>' +
    '<w:r><w:rPr><w:rFonts w:eastAsia="黑体"/><w:b/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr><w:t>目  录</w:t></w:r></w:p>'
  const toc = '<w:p><w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r>' +
    '<w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u \\w </w:instrText></w:r>' +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
    '<w:r><w:t>请点击“引用 → 更新目录”，选择更新整个目录。</w:t></w:r>' +
    '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
  return documentXml.slice(0, paragraphStart) + title + toc + documentXml.slice(paragraphEnd + "</w:p>".length)
}

function enableFieldUpdates(entries: Map<string, Buffer>): void {
  const settingsPath = "word/settings.xml"
  let settings = entries.get(settingsPath)?.toString("utf-8")
  if (!settings) throw new Error("Phase 2 cover template is missing word/settings.xml.")
  if (/<w:updateFields\b/.test(settings)) {
    settings = settings.replace(/<w:updateFields\b[^>]*\/?\s*>/g, '<w:updateFields w:val="true"/>')
  } else {
    settings = settings.replace(/<\/w:settings>/, '<w:updateFields w:val="true"/></w:settings>')
  }
  entries.set(settingsPath, Buffer.from(settings, "utf-8"))

  for (const [path, value] of entries) {
    if (!/^word\/(?:document|header\d+|footer\d+)\.xml$/.test(path)) continue
    const xml = value.toString("utf-8").replace(
      /<w:fldChar\b([^>]*w:fldCharType="begin"[^>]*)\/?\s*>/g,
      (_all, attributes: string) => `<w:fldChar${attributes.replace(/\s+w:dirty="[^"]*"/g, "").replace(/\/\s*$/, "")} w:dirty="true"/>`,
    )
    entries.set(path, Buffer.from(xml, "utf-8"))
  }
}

function mergeStyles(templateStyles: string, chapterStyles: string): string {
  const existing = new Set(styleBlocks(templateStyles).map((style) => style.id))
  const additions = styleBlocks(chapterStyles).filter((style) => !existing.has(style.id)).map((style) => style.xml)
  return additions.length === 0 ? templateStyles : templateStyles.replace(/<\/w:styles>/, additions.join("") + "</w:styles>")
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Cover templates and copied source documents commonly use short numeric style IDs.
 * A duplicate ID does not mean the styles are equivalent: for example, source-table
 * style "10" may collide with the cover's numbered Heading 9 style. Namespace only
 * the conflicting chapter styles and rewrite all of their references before merging.
 */
function isolateChapterStyleCollisions(
  templateStyles: string,
  chapterStyles: string,
  chapterContent: string,
): { styles: string; content: string } {
  const templateById = new Map(styleBlocks(templateStyles).map((style) => [style.id, style.xml]))
  const chapterBlocks = styleBlocks(chapterStyles)
  const usedIds = new Set([...templateById.keys(), ...chapterBlocks.map((style) => style.id)])
  const remapped = new Map<string, string>()

  for (const style of chapterBlocks) {
    const templateStyle = templateById.get(style.id)
    if (!templateStyle || templateStyle === style.xml || /^Heading[1-9]$/.test(style.id)) continue
    const stem = `MatrixBody_${style.id.replace(/[^A-Za-z0-9_.-]/g, "_")}`
    let candidate = stem
    let suffix = 2
    while (usedIds.has(candidate)) candidate = `${stem}_${suffix++}`
    usedIds.add(candidate)
    remapped.set(style.id, candidate)
  }

  if (remapped.size === 0) return { styles: chapterStyles, content: chapterContent }

  const rewriteReferences = (xml: string): string => {
    for (const [oldId, newId] of remapped) {
      const old = regexEscape(oldId)
      xml = xml
        .replace(new RegExp(`(<w:style\\b[^>]*\\bw:styleId=")${old}(")`, "g"), `$1${newId}$2`)
        .replace(
          new RegExp(`(<w:(?:pStyle|rStyle|tblStyle|basedOn|next|link)\\b[^>]*\\bw:val=")${old}(")`, "g"),
          `$1${newId}$2`,
        )
    }
    return xml
  }

  return { styles: rewriteReferences(chapterStyles), content: rewriteReferences(chapterContent) }
}

const TOC_TEXT_POSITIONS = [420, 709, 993] as const

/** Store the template's previously direct formatting in persistent TOC styles. */
function normalizeTocFormatting(entries: Map<string, Buffer>): void {
  let styles = entries.get("word/styles.xml")!.toString("utf-8")
  for (let level = 1; level <= 3; level++) {
    const existing = styleBlocks(styles).find((style) =>
      new RegExp(`<w:name\\b[^>]*w:val="toc\\s*${level}"`, "i").test(style.xml))
    const id = existing?.id ?? `TOC${level}`
    const position = TOC_TEXT_POSITIONS[level - 1]
    const normalized = `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="toc ${level}"/><w:qFormat/>` +
      `<w:pPr><w:tabs><w:tab w:val="left" w:pos="${position}"/><w:tab w:val="right" w:leader="dot" w:pos="8296"/></w:tabs>` +
      `<w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/><w:ind w:left="${position}" w:hanging="${position}"/>` +
      '<w:jc w:val="left"/><w:outlineLvl w:val="9"/></w:pPr>' +
      '<w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体" w:cs="Times New Roman"/>' +
      '<w:b w:val="0"/><w:bCs w:val="0"/><w:color w:val="000000"/><w:sz w:val="24"/><w:szCs w:val="24"/><w:u w:val="none"/></w:rPr></w:style>'
    styles = existing ? styles.replace(existing.xml, normalized) : styles.replace("</w:styles>", normalized + "</w:styles>")
  }
  entries.set("word/styles.xml", Buffer.from(styles, "utf-8"))
  const document = entries.get("word/document.xml")!.toString("utf-8").replace(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g, (paragraph) => {
    const heading = paragraph.match(/<w:pStyle\b[^>]*w:val="Heading([1-3])"/)
    if (!heading) return paragraph
    const plain = textNodes(paragraph).map((node) => node.text).join("")
    const prefix = plain.match(/^(\d+(?:\.\d+)*)([ \u3000]+)(?=\S)/)
    if (!prefix) return paragraph
    // Only the separator after the chapter number becomes a tab; title text stays intact.
    paragraph = replaceVisibleText(paragraph, prefix[0], prefix[1] + "__MATRIX_TOC_TAB__")
      .replace("__MATRIX_TOC_TAB__", '</w:t><w:tab/><w:t xml:space="preserve">')
    return paragraph.replace(/<w:pPr\b[^>]*>[\s\S]*?<\/w:pPr>/, (properties) =>
      properties.replace(/<w:tabs\b[^>]*>[\s\S]*?<\/w:tabs>/g, "")
        .replace("</w:pPr>", `<w:tabs><w:tab w:val="left" w:pos="${TOC_TEXT_POSITIONS[Number(heading[1]) - 1]}"/></w:tabs></w:pPr>`))
  })
  entries.set("word/document.xml", Buffer.from(document, "utf-8"))
}

/** Give WPS explicit outline levels and avoid duplicate built-in heading names. */
function normalizeFinalHeadings(entries: Map<string, Buffer>): void {
  const path = "word/styles.xml"
  let styles = entries.get(path)!.toString("utf-8")
  for (const style of styleBlocks(styles)) {
    const heading = style.id.match(/^Heading([1-9])$/)
    if (heading) continue
    // Template headings use numeric IDs but the same built-in names as our body.
    const renamed = style.xml.replace(/<w:name\b[^>]*w:val="heading\s*([1-9])"[^>]*\/>/i,
      '<w:name w:val="Matrix Cover Heading $1"/>')
    styles = styles.replace(style.xml, renamed)
  }
  for (let level = 1; level <= 9; level++) {
    const existing = styleBlocks(styles).find((style) => style.id === `Heading${level}`)
    let normalized = existing?.xml ?? `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/></w:style>`
    normalized = normalized.replace(/<w:outlineLvl\b[^>]*\/>/g, "")
    const outline = `<w:outlineLvl w:val="${level - 1}"/>`
    if (normalized.includes("</w:pPr>")) normalized = normalized.replace("</w:pPr>", outline + "</w:pPr>")
    else normalized = normalized.replace("</w:style>", `<w:pPr>${outline}</w:pPr></w:style>`)
    styles = existing ? styles.replace(existing.xml, normalized) : styles.replace("</w:styles>", normalized + "</w:styles>")
  }
  entries.set(path, Buffer.from(styles, "utf-8"))
  const document = entries.get("word/document.xml")!.toString("utf-8").replace(
    /<w:pPr\b[^>]*>[\s\S]*?<\/w:pPr>/g,
    (properties) => {
      const level = properties.match(/<w:pStyle\b[^>]*w:val="Heading([1-9])"/)
      if (!level) return properties
      return properties.replace(/<w:outlineLvl\b[^>]*\/>/g, "")
        .replace("</w:pPr>", `<w:outlineLvl w:val="${Number(level[1]) - 1}"/></w:pPr>`)
    },
  )
  entries.set("word/document.xml", Buffer.from(document, "utf-8"))
}

function appendChapterContent(templateEntries: Map<string, Buffer>, chapterBuffer: Buffer): void {
  const chapterEntries = readZip(chapterBuffer)
  const chapterDocument = chapterEntries.get("word/document.xml")?.toString("utf-8")
  const templateDocument = templateEntries.get("word/document.xml")?.toString("utf-8")
  if (!chapterDocument || !templateDocument) throw new Error("Phase 2 document package is missing word/document.xml.")
  const templateStyles = templateEntries.get("word/styles.xml")?.toString("utf-8") ?? ""
  const chapterStyles = chapterEntries.get("word/styles.xml")?.toString("utf-8") ?? ""
  const extractedChapter = bodyContent(chapterDocument, "merged Phase 2 chapters")
  const isolated = isolateChapterStyleCollisions(templateStyles, chapterStyles, extractedChapter.content)
  const chapter = { ...extractedChapter, content: isolated.content }
  const template = templateBodyContent(templateDocument)
  const sectionBreak = `<w:p><w:pPr>${template.sectPr}</w:pPr></w:p>`
  const mergedBody = template.content + sectionBreak + chapter.content + template.sectPr
  templateEntries.set(
    "word/document.xml",
    Buffer.from(templateDocument.replace(/<w:body\b[^>]*>[\s\S]*?<\/w:body>/, `<w:body>${mergedBody}</w:body>`), "utf-8"),
  )
  templateEntries.set("word/styles.xml", Buffer.from(mergeStyles(templateStyles, isolated.styles), "utf-8"))
}

function validateRelationships(entries: Map<string, Buffer>, sourcePath: string): void {
  if ([...entries.keys()].some((path) => path.startsWith("word/media/"))) {
    throw new Error(`Unsupported media relationship in chapter DOCX: ${sourcePath}`)
  }
  const rels = entries.get("word/_rels/document.xml.rels")?.toString("utf-8")
  if (!rels) return
  const relationshipRegex = /<Relationship\b([^>]*)\/?>/g
  let match: RegExpExecArray | null
  while ((match = relationshipRegex.exec(rels)) !== null) {
    const type = match[1].match(/\bType="([^"]+)"/)?.[1] ?? ""
    if (type && !type.endsWith("/styles")) {
      throw new Error(`Unsupported document relationship in chapter DOCX: ${sourcePath}`)
    }
  }
}

function mergeChapterReports(reports: ChapterReport[]): Buffer {
  const contents: string[] = []
  const styles = new Map<string, string>()
  let finalSectPr = DEFAULT_SECT_PR

  reports.forEach((report) => {
    let entries: Map<string, Buffer>
    try {
      entries = readZip(readFileSync(report.path))
    } catch (error) {
      throw new Error(`Invalid chapter DOCX ${report.path}: ${error instanceof Error ? error.message : String(error)}`)
    }
    validateRelationships(entries, report.path)
    const documentXml = entries.get("word/document.xml")
    if (!documentXml) throw new Error(`Chapter DOCX is missing word/document.xml: ${report.path}`)
    const extracted = bodyContent(documentXml.toString("utf-8"), report.path)
    contents.push(extracted.content)
    finalSectPr = extracted.sectPr

    const stylesXml = entries.get("word/styles.xml")?.toString("utf-8") ?? ""
    for (const style of styleBlocks(stylesXml)) {
      if (!styles.has(style.id)) styles.set(style.id, style.xml)
    }
  })

  const stylesXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    [...styles.values()].join("") +
    "</w:styles>"
  const documentXml = DOCUMENT_OPEN + contents.join("") + finalSectPr + "</w:body></w:document>"
  const entries: ZipEntry[] = [
    { path: "[Content_Types].xml", data: Buffer.from(CONTENT_TYPES_XML, "utf-8") },
    { path: "_rels/.rels", data: Buffer.from(ROOT_RELS_XML, "utf-8") },
    { path: "word/document.xml", data: Buffer.from(documentXml, "utf-8") },
    { path: "word/styles.xml", data: Buffer.from(stylesXml, "utf-8") },
    { path: "word/_rels/document.xml.rels", data: Buffer.from(DOCUMENT_RELS_XML, "utf-8") },
  ]
  return formatTestRequirementsDocx(writeZip(entries))
}

export function mergePhase2ChapterDocx(
  reports: ChapterReport[],
  templateBuffer: Buffer,
  coverData: Chapter1CoverData,
): Buffer {
  const entries = readZip(templateBuffer)
  const documentPath = "word/document.xml"
  const document = entries.get(documentPath)
  if (!document) throw new Error("Phase 2 cover template is missing word/document.xml.")
  entries.set(documentPath, Buffer.from(resetTableOfContents(removeFrontMatterHeadingStyles(document.toString("utf-8"))), "utf-8"))
  for (const [path, value] of entries) {
    if (!path.endsWith(".xml")) continue
    entries.set(path, Buffer.from(replaceCoverPlaceholders(value.toString("utf-8"), coverData), "utf-8"))
  }
  entries.set(documentPath, Buffer.from(fitCoverSoftwareName(entries.get(documentPath)!.toString("utf-8"), coverData.software_name_and_id), "utf-8"))
  appendChapterContent(entries, mergeChapterReports(reports))
  normalizeFinalHeadings(entries)
  normalizeTocFormatting(entries)
  enableFieldUpdates(entries)
  return writeZip([...entries].map(([path, data]) => ({ path, data })))
}

function readCoverData(path: string): Chapter1CoverData {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, "utf-8"))
  } catch (error) {
    throw new Error(`Invalid Chapter 1 raw JSON ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid Chapter 1 raw JSON object: ${path}`)
  }
  const record = value as Record<string, unknown>
  const fields: Array<keyof Chapter1CoverData> = ["software_name_and_id", "document_id", "system_name", "model_name"]
  const missing = fields.filter((field) => typeof record[field] !== "string")
  if (missing.length > 0) throw new Error(`Chapter 1 raw JSON is missing required cover fields: ${missing.join(", ")}`)
  return Object.fromEntries(fields.map((field) => [field, (record[field] as string).trim() || "XX"])) as unknown as Chapter1CoverData
}

export async function finalizePhase2Document(ctx: ToolContext): Promise<string> {
  const reports = chapterReports(ctx)
  const missing = reports.filter((report) => !existsSync(report.path))
  if (missing.length > 0) {
    return JSON.stringify({
      ok: false,
      mode: "finalize_phase2_document",
      error: "missing_chapter_reports",
      missing_chapter_reports: missing,
    }, null, 2)
  }

  try {
    const chapter1RawPath = reportPath(ctx, ".matrix/data/chapter1-scope.raw.json")
    if (!existsSync(chapter1RawPath)) {
      return JSON.stringify({
        ok: false,
        mode: "finalize_phase2_document",
        error: "missing_chapter1_raw",
        chapter1_raw_path: chapter1RawPath,
      }, null, 2)
    }
    const template = resolveTemplateAssetPath({
      filename: PHASE2_COVER_TEMPLATE,
      importMetaDir: moduleDir(import.meta.url),
      projectDir: ctx.directory,
    })
    if (!template.path) {
      return JSON.stringify({
        ok: false,
        mode: "finalize_phase2_document",
        error: "missing_phase2_cover_template",
        checked_template_paths: template.checked,
      }, null, 2)
    }
    const coverData = readCoverData(chapter1RawPath)
    const outputPath = reportPath(ctx, ".matrix/reports/phase2-test-requirements.docx")
    const output = mergePhase2ChapterDocx(reports, readFileSync(template.path), coverData)
    mkdirSync(dirname(outputPath), { recursive: true })
    const tempPath = `${outputPath}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tempPath, output)
    try {
      renameSync(tempPath, outputPath)
    } finally {
      if (existsSync(tempPath)) rmSync(tempPath)
    }
    return JSON.stringify({
      ok: true,
      mode: "finalize_phase2_document",
      output: { phase2_report_path: outputPath },
      summary: {
        chapter_count: reports.length,
        chapter_order: reports.map((report) => report.title),
        template_front_matter_pages: 3,
        cover_template_path: template.path,
      },
    }, null, 2)
  } catch (error) {
    return JSON.stringify({
      ok: false,
      mode: "finalize_phase2_document",
      error: error instanceof Error ? error.message : String(error),
    }, null, 2)
  }
}
