import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { basename, dirname, extname } from "path"
import { readZip } from "./docx-zip"
import { extractTopLevelBodyElements } from "./docx-heading-resolver"

type DocumentQualitySeverity = "error" | "warning" | "info"

export interface DocumentQualityInput {
  path: string
  role: string
  format?: string
}

interface ParagraphInfo {
  body_element_index: number
  text: string
  style_id: string
  style_name: string
  outline_level: number | null
  style_heading_level: number | null
  visible_label: string
  visible_label_depth: number | null
}

interface DocumentQualityIssue {
  severity: DocumentQualitySeverity
  category: string
  location: string
  message: string
  evidence?: string
}

interface DocumentQualityResult {
  path: string
  role: string
  format: string
  heading_count: number
  table_count: number
  issues: DocumentQualityIssue[]
}

export interface DocumentQualityReportSummary {
  output_path: string
  total_documents: number
  total_issues: number
  error_count: number
  warning_count: number
  info_count: number
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

function markdownEscape(value: string): string {
  return collapseWhitespace(value)
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/`/g, "'")
}

function readAttribute(xml: string, attrName: string): string {
  const match = xml.match(new RegExp(`\\b${attrName}="([^"]*)"`))
  return match ? decodeXmlEntities(match[1]) : ""
}

function buildParagraphStyleNameMap(stylesXml: string | undefined): Map<string, string> {
  const map = new Map<string, string>()
  if (!stylesXml) return map

  const styleRegex = /<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g
  let match: RegExpExecArray | null
  while ((match = styleRegex.exec(stylesXml)) !== null) {
    const attrs = match[1]
    if (!/\bw:type="paragraph"/.test(attrs)) continue
    const styleId = readAttribute(attrs, "w:styleId")
    if (!styleId) continue

    const nameMatch = match[2].match(/<w:name\b[^>]*\bw:val="([^"]*)"/)
    const styleName = nameMatch ? decodeXmlEntities(nameMatch[1]) : ""
    map.set(styleId, styleName)
  }
  return map
}

function normalizeStyleName(value: string): string {
  return textOf(value)
    .replace(/[-_]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function headingLevelFromStyle(styleId: string, styleName: string): number | null {
  const candidates = [normalizeStyleName(styleName), normalizeStyleName(styleId)]
  for (const candidate of candidates) {
    if (!candidate) continue

    const english = candidate.match(/^heading\s*(\d+)$/i)
    if (english) {
      const level = Number.parseInt(english[1], 10)
      return level >= 1 && level <= 9 ? level : null
    }

    const compactEnglish = candidate.match(/^heading(\d+)$/i)
    if (compactEnglish) {
      const level = Number.parseInt(compactEnglish[1], 10)
      return level >= 1 && level <= 9 ? level : null
    }

    const chinese = candidate.match(/^标题\s*(\d+)$/u)
    if (chinese) {
      const level = Number.parseInt(chinese[1], 10)
      return level >= 1 && level <= 9 ? level : null
    }
  }
  return null
}

function visibleHeadingLabel(text: string): { label: string; depth: number | null } {
  const normalized = collapseWhitespace(text)
  const match = normalized.match(/^(?:第\s*)?([A-Za-z]|\d+(?:\.\d+)*)(?:\s*[.．、:：]|\s+)(.+)$/u)
  if (!match) return { label: "", depth: null }

  const label = match[1]
  const rest = textOf(match[2])
  if (!rest) return { label: "", depth: null }
  if (/^\d+(?:\.\d+)*$/.test(label)) {
    if (/^\d+$/.test(label) && Number.parseInt(label, 10) > 50) {
      return { label: "", depth: null }
    }
    return { label, depth: label.split(".").length }
  }
  if (/^[a-z]$/.test(label) || /^[A-Z]$/.test(label)) {
    return { label: "", depth: null }
  }
  return { label, depth: 1 }
}

function isTocTitle(text: string): boolean {
  const compact = text.replace(/\s+/g, "")
  return /^(目录|目次|contents|tableofcontents)$/iu.test(compact)
}

function isLikelyTocLine(text: string): boolean {
  const normalized = collapseWhitespace(text)
  if (!normalized) return false
  if (isTocTitle(normalized)) return true
  if (/\.{3,}\s*\d+\s*$/.test(normalized)) return true
  if (/^\d+(?:\.\d+)*\s+.+\s+\d+$/.test(normalized)) return true
  if (/^\d+(?:\.\d+)*\s{2,}.+\s{2,}\d+$/.test(text)) return true
  return false
}

function isTableCaption(text: string): boolean {
  return /^(?:表格?|附表)\s*[A-Za-z0-9一二三四五六七八九十]+/u.test(collapseWhitespace(text))
}

function isLikelyHeadingText(text: string): boolean {
  const normalized = collapseWhitespace(text)
  if (!normalized || normalized.length < 2 || normalized.length > 100) return false
  if (isLikelyTocLine(normalized) || isTableCaption(normalized)) return false
  const visible = visibleHeadingLabel(normalized)
  if (!visible.label) return false
  const letters = normalized.match(/[A-Za-z\u4e00-\u9fa5]/g) || []
  if (letters.length === 0) return false
  if (/^\d+\s*[:：]/u.test(normalized)) return false
  if (/\b[0-9A-F]{2,}H\b/iu.test(normalized)) return false
  return true
}

function paragraphInfo(element: ReturnType<typeof extractTopLevelBodyElements>[number], styleNames: Map<string, string>): ParagraphInfo {
  const xml = element.xml
  const styleId = xml.match(/<w:pStyle\b[^>]*\bw:val="([^"]*)"/)?.[1] || ""
  const styleName = styleNames.get(styleId) || ""
  const outlineMatch = xml.match(/<w:outlineLvl\b[^>]*\bw:val="(\d+)"/)
  const outlineLevel = outlineMatch ? Number.parseInt(outlineMatch[1], 10) : null
  const visible = visibleHeadingLabel(textOf(element.text))

  return {
    body_element_index: element.body_element_index,
    text: collapseWhitespace(textOf(element.text)),
    style_id: styleId,
    style_name: styleName,
    outline_level: outlineLevel,
    style_heading_level: headingLevelFromStyle(styleId, styleName),
    visible_label: visible.label,
    visible_label_depth: visible.depth,
  }
}

function issue(
  severity: DocumentQualitySeverity,
  category: string,
  paragraphOrLocation: ParagraphInfo | string,
  message: string,
  evidence?: string,
): DocumentQualityIssue {
  const location = typeof paragraphOrLocation === "string"
    ? paragraphOrLocation
    : `body element ${paragraphOrLocation.body_element_index + 1}`
  return {
    severity,
    category,
    location,
    message,
    ...(evidence ? { evidence: collapseWhitespace(evidence).slice(0, 160) } : {}),
  }
}

function analyzeDocx(path: string, role: string): DocumentQualityResult {
  const zipEntries = readZip(readFileSync(path))
  const docXml = zipEntries.get("word/document.xml")?.toString("utf-8")
  if (!docXml) {
    return {
      path,
      role,
      format: "docx",
      heading_count: 0,
      table_count: 0,
      issues: [issue("error", "docx", "document", "DOCX is missing word/document.xml.")],
    }
  }

  const styleNames = buildParagraphStyleNameMap(zipEntries.get("word/styles.xml")?.toString("utf-8"))
  const elements = extractTopLevelBodyElements(docXml)
  const issues: DocumentQualityIssue[] = []
  const seenLabels = new Map<string, ParagraphInfo>()
  let headingCount = 0
  let tableCount = 0
  let lastHeadingLevel = 0
  let currentHeading: ParagraphInfo | null = null
  let suspiciousSinceHeading: ParagraphInfo | null = null
  let inToc = false

  for (const element of elements) {
    if (element.tag === "tbl") {
      tableCount += 1
      if (!currentHeading) {
        issues.push(issue(
          "warning",
          "table",
          `body element ${element.body_element_index + 1}`,
          "表格出现在第一个有效标题之前；严格模式不会把它强行挂到某个章节。",
        ))
      } else if (suspiciousSinceHeading) {
        issues.push(issue(
          "warning",
          "table",
          `body element ${element.body_element_index + 1}`,
          `表格前最近出现了未套标题样式的疑似标题，严格模式会挂到上一个有效标题“${currentHeading.text}”。`,
          suspiciousSinceHeading.text,
        ))
      }
      continue
    }

    if (element.tag !== "p") continue

    const paragraph = paragraphInfo(element, styleNames)
    if (!paragraph.text) continue

    if (isTocTitle(paragraph.text)) {
      inToc = true
      continue
    }

    if (inToc && isLikelyTocLine(paragraph.text)) {
      continue
    }

    const isStyledHeading = paragraph.style_heading_level !== null
    if (isStyledHeading) {
      inToc = false
      suspiciousSinceHeading = null
      currentHeading = paragraph
      headingCount += 1

      const level = paragraph.style_heading_level || 1
      if (lastHeadingLevel > 0 && level > lastHeadingLevel + 1) {
        issues.push(issue(
          "warning",
          "heading-level",
          paragraph,
          `标题层级从 ${lastHeadingLevel} 跳到 ${level}，中间层级缺失时章节树可能不完整。`,
          paragraph.text,
        ))
      }
      lastHeadingLevel = level

      if (paragraph.visible_label && paragraph.visible_label_depth && paragraph.visible_label_depth !== level) {
        issues.push(issue(
          "warning",
          "heading-numbering",
          paragraph,
          `标题编号深度是 ${paragraph.visible_label_depth}，但标题样式级别是 ${level}。`,
          paragraph.text,
        ))
      }

      if (paragraph.visible_label) {
        const previous = seenLabels.get(paragraph.visible_label)
        if (previous) {
          issues.push(issue(
            "warning",
            "heading-numbering",
            paragraph,
            `标题编号“${paragraph.visible_label}”重复出现。`,
            paragraph.text,
          ))
        } else {
          seenLabels.set(paragraph.visible_label, paragraph)
        }
      }
      continue
    }

    const outlineLooksHeading = paragraph.outline_level !== null && paragraph.outline_level >= 0 && paragraph.outline_level <= 8
    if (outlineLooksHeading || isLikelyHeadingText(paragraph.text)) {
      suspiciousSinceHeading = paragraph
      issues.push(issue(
        "warning",
        "heading-style",
        paragraph,
        "这行看起来像章节标题，但没有使用 Word/WPS 标题样式；严格模式不会把它当作章节边界。",
        paragraph.text,
      ))
    }
  }

  return {
    path,
    role,
    format: "docx",
    heading_count: headingCount,
    table_count: tableCount,
    issues,
  }
}

function analyzeDocument(input: DocumentQualityInput): DocumentQualityResult {
  const format = textOf(input.format) || extname(input.path).replace(/^\./, "").toLowerCase() || "unknown"
  if (!existsSync(input.path)) {
    return {
      path: input.path,
      role: input.role,
      format,
      heading_count: 0,
      table_count: 0,
      issues: [issue("error", "file", "document", "Document file does not exist.")],
    }
  }

  if (format === "docx" || input.path.toLowerCase().endsWith(".docx")) {
    try {
      return analyzeDocx(input.path, input.role)
    } catch (err) {
      return {
        path: input.path,
        role: input.role,
        format: "docx",
        heading_count: 0,
        table_count: 0,
        issues: [issue(
          "error",
          "docx",
          "document",
          `DOCX 质量检查失败：${err instanceof Error ? err.message : String(err)}`,
        )],
      }
    }
  }

  return {
    path: input.path,
    role: input.role,
    format,
    heading_count: 0,
    table_count: 0,
    issues: [issue("info", "format", "document", "非 DOCX 文档暂不检查 Word/WPS 标题样式。")],
  }
}

function renderIssue(issue: DocumentQualityIssue): string {
  const evidence = issue.evidence ? `；证据：${markdownEscape(issue.evidence)}` : ""
  return `- [${issue.severity}] ${markdownEscape(issue.category)} @ ${markdownEscape(issue.location)}：${markdownEscape(issue.message)}${evidence}`
}

function renderReport(results: DocumentQualityResult[]): string {
  const totalIssues = results.reduce((sum, item) => sum + item.issues.length, 0)
  const lines: string[] = []
  lines.push("# 文档质量检查报告")
  lines.push("")
  lines.push(`生成时间：${new Date().toISOString()}`)
  lines.push("")
  lines.push(totalIssues === 0
    ? "结论：未发现影响严格章节切分和表格挂载的结构问题。"
    : `结论：发现 ${totalIssues} 个结构风险点；流程已继续执行，请按下方清单修正文档以提升切分和表格挂载准确度。`)
  lines.push("")
  lines.push("## 汇总")
  lines.push("")
  lines.push("| 文档 | 角色 | 格式 | 有效标题数 | 表格数 | 问题数 |")
  lines.push("| --- | --- | --- | ---: | ---: | ---: |")
  for (const result of results) {
    lines.push(`| ${markdownEscape(basename(result.path))} | ${markdownEscape(result.role)} | ${markdownEscape(result.format)} | ${result.heading_count} | ${result.table_count} | ${result.issues.length} |`)
  }
  lines.push("")
  lines.push("## 问题清单")
  lines.push("")
  if (totalIssues === 0) {
    lines.push("无。")
  } else {
    for (const result of results) {
      lines.push(`### ${markdownEscape(basename(result.path))}`)
      lines.push("")
      if (result.issues.length === 0) {
        lines.push("- 无。")
      } else {
        const maxIssues = 120
        for (const item of result.issues.slice(0, maxIssues)) {
          lines.push(renderIssue(item))
        }
        if (result.issues.length > maxIssues) {
          lines.push(`- 还有 ${result.issues.length - maxIssues} 个问题未展开显示。`)
        }
      }
      lines.push("")
    }
  }
  lines.push("## 解析策略说明")
  lines.push("")
  lines.push("- 后续章节切分默认只信任 Word/WPS 标题样式形成的结构。")
  lines.push("- DOCX 表格默认挂载到它前面最近的有效标题章节。")
  lines.push("- 未套标题样式的疑似标题会被记录在本报告中，但不会中断流程。")
  lines.push("")
  return lines.join("\n")
}

export function writeDocumentQualityReport(
  documents: DocumentQualityInput[],
  outputPath: string,
): DocumentQualityReportSummary {
  const results = documents.map((document) => analyzeDocument(document))
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, renderReport(results), "utf-8")

  const issueCounts = results
    .flatMap((result) => result.issues)
    .reduce(
      (counts, item) => {
        counts.total_issues += 1
        if (item.severity === "error") counts.error_count += 1
        else if (item.severity === "warning") counts.warning_count += 1
        else counts.info_count += 1
        return counts
      },
      { total_issues: 0, error_count: 0, warning_count: 0, info_count: 0 },
    )

  return {
    output_path: outputPath,
    total_documents: documents.length,
    ...issueCounts,
  }
}
