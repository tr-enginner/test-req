import { tool, type ToolContext, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, isAbsolute, join } from "path"
import { extractText, getDocumentProxy } from "unpdf"
import { extractDocxText } from "./docx-heading-numbering"
import { sanitizePossibleWordXmlLine, sanitizePossibleWordXmlText } from "./word-xml-sanitize"

interface Segment {
  segment_id: string
  title: string
  text: string
  level: number
}

interface TocEntry {
  segment_id: string
  level: number
  title: string
}

const STRUCTURED_REQUIREMENT_ID_RE = /^(?:SRS|REQ|SR|FR|NFR|IR)-((?:\d+|[A-Za-z])(?:\.(?:\d+|[A-Za-z]))*)$/i
async function extractPdfText(filePath: string): Promise<string> {
  const buffer = readFileSync(filePath)
  const pdf = await getDocumentProxy(new Uint8Array(buffer), {
    standardFontDataUrl: "data:application/octet-stream;base64,",
  })
  const result = await extractText(pdf)
  return result.text.join("\n\n")
}

function normalizeText(text: string): string {
  return sanitizePossibleWordXmlText(text)
    .split("\n")
    .map((line) => sanitizePossibleWordXmlLine(line))
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n")
}

function shouldSkipNoiseLine(line: string): boolean {
  const v = line.trim()
  if (!v) return false
  if (/^(?:contents?|\u76ee\u5f55)$/iu.test(v)) return true
  if (/^[-_=.\s]{6,}$/.test(v)) return true
  if (/^(?:page\s*)?\d+\s*\/\s*\d+$/i.test(v)) return true
  if (/^\d+(?:\.\d+)*\s+.+\s+\d+$/.test(v)) return true
  return false
}

function normalizeHeadingCandidate(raw: string): string {
  return sanitizePossibleWordXmlLine(raw)
    .replace(/<a\b[^>]*>/gi, "")
    .replace(/<\/a>/gi, "")
    .replace(/\[([^\]]+)]\(#_Toc[^)]+\)/gi, "$1")
    .replaceAll("\\.", ".")
    .replaceAll("\\(", "(")
    .replaceAll("\\)", ")")
    .replace(/^[_*~`]+/u, "")
    .replace(/[_*~`]+$/u, "")
    .replace(/\s*\.{3,}\s*\d+\s*$/, "")
    .replace(/[ \t]+/g, " ")
    .trim()
}

function normalizeTitleForDedupe(title: string): string {
  return normalizeHeadingCandidate(title).replace(/\s+/g, " ").trim().toLowerCase()
}

function isLikelyHeadingTitle(title: string): boolean {
  const t = normalizeHeadingCandidate(title)
  if (!t || t.length < 2) return false
  if (t.length > 80) return false
  if (/^\d+(?:\s+\d+){2,}$/.test(t)) return false
  if (/^(?:W|P)\d+(?:\.\d+)?\b/i.test(t)) return false
  if (/^\d+\s*[:]/.test(t)) return false
  if (/\b[0-9A-F]{2,}H\b/i.test(t)) return false
  // Removed a broken legacy noise filter that was corrupted by encoding issues.
  if (/^\d+\s+\S+\s+\d+[A-Za-z]?$/.test(t)) return false
  if (/^\d\s+\d/.test(t)) return false
  const letters = (t.match(/[A-Za-z\u4e00-\u9fa5]/g) || []).length
  return letters > 0
}

function isLikelyListItem(line: string): boolean {
  const t = line.trim()
  if (!t) return false
  if (/^\d+[.)]\s+/.test(t)) return true
  if (/^[A-Za-z]\)\s+/.test(t)) return true
  if (/^\(\d+\)\s+/.test(t)) return true
  return false
}

function levelFromId(segmentID: string): number {
  const m = segmentID.match(STRUCTURED_REQUIREMENT_ID_RE)
  if (!m) return 1
  return m[1].split(".").length
}

function normalizeStructuredSegmentId(prefix: string, rawNumber: string): string {
  const normalizedPrefix = (prefix || "SRS").toUpperCase()
  const normalizedNumber = textOf(rawNumber).toUpperCase()
  if (!normalizedNumber) return `${normalizedPrefix}-${pad3(1)}`
  if (/^\d+$/.test(normalizedNumber)) {
    return `${normalizedPrefix}-${pad3(Number(normalizedNumber))}`
  }
  return `${normalizedPrefix}-${normalizedNumber}`
}

function parseStructuredHeadingFromTitle(
  rawTitle: string,
  prefix = "SRS",
): { segment_id: string; title: string } | null {
  const normalized = normalizeHeadingCandidate(rawTitle)
  const annexMatch = normalized.match(/^(?:附件|附录)\s*([A-Za-z])(?:\s*[（(][^）)]*[）)])?\s*(.+)$/u)
  if (annexMatch) {
    const [, rawNumber, rawHeadingTitle] = annexMatch
    const headingTitle = normalizeHeadingCandidate(rawHeadingTitle)
    if (!headingTitle || !isLikelyHeadingTitle(headingTitle)) return null
    return {
      segment_id: normalizeStructuredSegmentId(prefix, rawNumber),
      title: headingTitle,
    }
  }

  const match = normalized.match(/^((?:\d+(?:\.\d+)*)|(?:[A-Za-z](?:\.\d+)+))\s+(.+)$/)
  if (!match) return null
  const [, rawNumber, rawHeadingTitle] = match
  const headingTitle = normalizeHeadingCandidate(rawHeadingTitle)
  if (!headingTitle || !isLikelyHeadingTitle(headingTitle)) return null
  return {
    segment_id: normalizeStructuredSegmentId(prefix, rawNumber),
    title: headingTitle,
  }
}

interface ParseSegmentsOptions {
  markdownHeadersOnly?: boolean
  skipUntilFirstHeading?: boolean
  preservePreamble?: boolean
}

function parseSegments(content: string, options: ParseSegmentsOptions = {}): Segment[] {
  const lines = content.split("\n")
  const segments: Segment[] = []
  const markdownHeadersOnly = options.markdownHeadersOnly === true
  const skipUntilFirstHeading = options.skipUntilFirstHeading === true
  const preservePreamble = options.preservePreamble === true

  let current: Segment | null = null
  let seq = 0
  let inTocBlock = false
  let sawMarkdownHeading = false

  const newSegment = (title: string, idHint?: string) => {
    seq += 1
    const segmentID = idHint || `SRS-${String(seq).padStart(3, "0")}`
    current = {
      segment_id: segmentID,
      title: normalizeHeadingCandidate(title) || `segment-${seq}`,
      text: "",
      level: levelFromId(segmentID),
    }
  }

  const flush = () => {
    if (!current) return
    current.text = normalizeText(current.text)
    if (current.title || current.text) {
      segments.push(current)
    }
  }

  for (const rawLine of lines) {
    const sanitizedLine = sanitizePossibleWordXmlLine(rawLine)
    const line = sanitizedLine.trim()
    const normalizedMarker = line.replace(/^[_*~\s]+|[_*~\s]+$/g, "")
    if (/^(?:contents?|\u76ee\u5f55)$/iu.test(normalizedMarker)) {
      inTocBlock = true
      continue
    }
    if (shouldSkipNoiseLine(line)) continue

    const mdHeader = line.match(/^#{1,6}\s+(?:(SRS|REQ|SR|FR|NFR|IR)-((?:\d+|[A-Za-z])(?:\.(?:\d+|[A-Za-z]))*)[:\s]+)?(.+)/i)

    const numHeader = !markdownHeadersOnly && !mdHeader
      ? line.match(/^(\d+(?:\.\d+)+)\s+(.+?)(?:\s*\.{3,}\s*\d+)?$/)
      : null
    const chapterHeader = !markdownHeadersOnly && !mdHeader && !numHeader
      ? line.match(/^(\d+)\s+(.+?)(?:\s*\.{3,}\s*\d+)?$/)
      : null
    const acceptedMdHeader = !!(mdHeader && isLikelyHeadingTitle(mdHeader[3]))
    const acceptedNumHeader = !!(
      numHeader &&
      !isLikelyListItem(line) &&
      isLikelyHeadingTitle(numHeader[2])
    )
    const acceptedChapterHeader = !!(
      chapterHeader &&
      !isLikelyListItem(line) &&
      isLikelyHeadingTitle(chapterHeader[2])
    )

    if (!sawMarkdownHeading && (acceptedMdHeader || acceptedNumHeader || acceptedChapterHeader)) {
      sawMarkdownHeading = true
    }
    if (skipUntilFirstHeading && !sawMarkdownHeading) continue

    const isTocLine = !!(numHeader && /\.{3,}\s*\d+\s*$/.test(line))
    const isTocChapterLine = !!(chapterHeader && /\.{3,}\s*\d+\s*$/.test(line))

    if (inTocBlock && !mdHeader && !numHeader && !chapterHeader) continue
    if (inTocBlock && (numHeader || chapterHeader) && !isTocLine && !isTocChapterLine) {
      inTocBlock = false
    }
    if (mdHeader) inTocBlock = false

    if (acceptedMdHeader && mdHeader) {
      flush()
      const prefix = (mdHeader[1] || "SRS").toUpperCase()
      const num = mdHeader[2]
      const parsedFromTitle = !num ? parseStructuredHeadingFromTitle(mdHeader[3], prefix) : null
      const id = num ? normalizeStructuredSegmentId(prefix, num) : parsedFromTitle?.segment_id
      const headingTitle = parsedFromTitle?.title || mdHeader[3]
      newSegment(headingTitle, id)
      continue
    }

    if (
      acceptedNumHeader &&
      numHeader &&
      !isTocLine &&
      !isLikelyListItem(line)
    ) {
      flush()
      newSegment(numHeader[2], normalizeStructuredSegmentId("SRS", numHeader[1]))
      continue
    }

    if (
      acceptedChapterHeader &&
      chapterHeader &&
      !isTocChapterLine &&
      !isLikelyListItem(line)
    ) {
      flush()
      newSegment(chapterHeader[2], normalizeStructuredSegmentId("SRS", chapterHeader[1]))
      continue
    }

    if (!current && line) {
      newSegment(preservePreamble ? "文档前置内容" : "preamble", preservePreamble ? "SRS-PREAMBLE" : undefined)
    }
    if (current as Segment | null) {
      current!.text += (current!.text ? "\n" : "") + sanitizedLine
    }
  }

  flush()
  const filtered = segments.filter((s) => s.title.length > 0 || s.text.length > 0)
  const seenNonRequirementTitles = new Set<string>()
  const deduped: Segment[] = []
  for (const segment of filtered) {
    const normalizedTitle = normalizeTitleForDedupe(segment.title)
    if (
      normalizedTitle
      && isLikelyNonRequirementByTitle(segment.title)
      && !/^(?:SRS|REQ|SR|FR|NFR|IR)-(?:(?:\d+|[A-Za-z])\.)+(?:\d+|[A-Za-z])$/i.test(segment.segment_id)
    ) {
      if (seenNonRequirementTitles.has(normalizedTitle)) {
        continue
      }
      seenNonRequirementTitles.add(normalizedTitle)
    }
    deduped.push(segment)
  }
  return deduped
}

function buildToc(segments: Segment[]): TocEntry[] {
  return segments.map((s) => ({
    segment_id: s.segment_id,
    level: s.level,
    title: s.title,
  }))
}

function outputFormat(explicit: string | undefined, isPdf: boolean, isDocx: boolean): string {
  if (explicit) return explicit
  if (isPdf) return "pdf"
  if (isDocx) return "docx"
  return "markdown"
}

function isLikelyNonRequirementByTitle(title: string): boolean {
  const normalized = title.replace(/\s+/g, " ").trim()
  if (!normalized) return false
  if (/^preamble$/iu.test(normalized)) return true
  if (/^文档前置内容$/u.test(normalized)) return true
  if (/需求规格说明/u.test(normalized)) return true
  if (/^(附件|附录)\s*[A-Za-z0-9一二三四五六七八九十]/u.test(normalized)) return true
  if (/^(表格?|图)\s*[A-Za-z0-9一二三四五六七八九十]/u.test(normalized)) return true
  return /(封面|修订|版本|目录|文档概述|引言|标识|引用文档|验收|可跟踪|人员需求|培训需求|其他需求|附录|前言)/u.test(normalized)
}

function getBaseDirectory(ctx: ToolContext): string {
  return ctx?.directory || process.cwd()
}

function resolveArtifactPath(ctx: ToolContext, providedPath: string | undefined, defaultFileName: string): string {
  const base = getBaseDirectory(ctx)
  if (providedPath) {
    return isAbsolute(providedPath) ? providedPath : join(base, providedPath)
  }
  return join(base, ".matrix/data", defaultFileName)
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2), "utf-8")
}

function countStructuredSegments(segments: Segment[]): number {
  return segments.filter((s) =>
    s.title !== "preamble" && STRUCTURED_REQUIREMENT_ID_RE.test(s.segment_id)
  ).length
}

function pad3(n: number): string {
  return String(n).padStart(3, "0")
}

function textOf(v: unknown): string {
  return typeof v === "string" ? v.trim() : ""
}

async function executeExtractMode(args: {
  file_path?: string
  format?: "markdown" | "text" | "docx" | "pdf"
  write_artifacts?: boolean
  output_file?: string
  output_toc_file?: string
}, ctx: ToolContext) {
  const { file_path, format, write_artifacts = true, output_file, output_toc_file } = args
  if (!file_path) {
    return JSON.stringify({ error: "file_path is required when mode=extract" })
  }
  if (!existsSync(file_path)) {
    return JSON.stringify({ error: `File not found: ${file_path}` })
  }

  const isPdf = format === "pdf" || file_path.toLowerCase().endsWith(".pdf")
  const isDocx = format === "docx" || file_path.toLowerCase().endsWith(".docx")
  let content = ""

  if (isPdf) {
    try {
      content = await extractPdfText(file_path)
    } catch (err) {
      return JSON.stringify({
        error: `PDF extraction failed: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  } else if (isDocx) {
    try {
      content = await extractDocxText(file_path)
    } catch (err) {
      return JSON.stringify({
        error: `DOCX extraction failed: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  } else {
    content = readFileSync(file_path, "utf-8")
  }

  const segments = parseSegments(
    content,
    isDocx
      ? {
          markdownHeadersOnly: true,
          preservePreamble: true,
        }
      : undefined,
  )
  const toc = buildToc(segments)

  const extraction = {
    file: file_path,
    format: outputFormat(format, isPdf, isDocx),
    extraction_mode: "segments_only_v1",
    total_segments: segments.length,
    toc,
    segments: segments.map((s) => ({
      segment_id: s.segment_id,
      level: s.level,
      title: s.title,
      text: s.text,
      likely_non_requirement: isLikelyNonRequirementByTitle(s.title),
    })),
  }

  const tocOnly = {
    file: file_path,
    format: outputFormat(format, isPdf, isDocx),
    extraction_mode: "segments_toc_only_v1",
    total_segments: segments.length,
    toc,
  }

  const shouldWriteArtifacts = write_artifacts || !!output_file || !!output_toc_file
  let outPath = ""
  let tocPath = ""
  if (shouldWriteArtifacts) {
    outPath = resolveArtifactPath(ctx, output_file, "req-segments.json")
    tocPath = resolveArtifactPath(ctx, output_toc_file, "req-segments-toc.json")
    writeJson(outPath, extraction)
    writeJson(tocPath, tocOnly)
  }

  if (ctx) {
    ctx.metadata({
      title: "Extracted requirement heading catalog",
      metadata: {
        extraction_mode: "segments_only_v1",
        total_segments: segments.length,
        output_file: outPath || undefined,
        output_toc_file: tocPath || undefined,
      },
    })
  }

  return JSON.stringify(
    shouldWriteArtifacts
      ? {
          ok: true,
          mode: "extract",
          file: file_path,
          extraction_mode: "segments_only_v1",
          total_segments: segments.length,
          output: {
            req_segments_path: outPath || undefined,
            req_segments_toc_path: tocPath || undefined,
          },
          summary: {
            toc_entries: toc.length,
            structured_segments: countStructuredSegments(segments),
            non_requirement_title_candidates: segments.filter((s) => isLikelyNonRequirementByTitle(s.title)).length,
          },
        }
      : {
      ok: true,
      mode: "extract",
      file: file_path,
      extraction_mode: "segments_only_v1",
      total_segments: segments.length,
      output: {
        req_segments_path: outPath || undefined,
        req_segments_toc_path: tocPath || undefined,
      },
      toc,
    },
    null,
    2,
  )
}

export function configureReqParserClient(_client: unknown): void {
  // no-op: classification is moved to agent workflow
}

export const reqParser: ToolDefinition = tool({
  description:
    "Extract requirement document segments and their table of contents.",
  args: {
    mode: tool.schema
      .enum(["extract"])
      .optional()
      .describe("Execution mode. Default: extract."),
    file_path: tool.schema
      .string()
      .optional()
      .describe("Path to the requirement document (required when mode=extract)."),
    format: tool.schema
      .enum(["markdown", "text", "docx", "pdf"])
      .optional()
      .describe("Document format. Supports markdown, text, docx, and pdf."),
    write_artifacts: tool.schema
      .boolean()
      .optional()
      .describe("When mode=extract, write .matrix/data/req-segments*.json (default: true)."),
    output_file: tool.schema
      .string()
      .optional()
      .describe("When mode=extract, optional output path for the full req-segments artifact. When provided, the tool writes the extraction to disk and returns a compact summary."),
    output_toc_file: tool.schema
      .string()
      .optional()
      .describe("When mode=extract, optional output path for the req-segments-toc artifact. Defaults to .matrix/data/req-segments-toc.json when extraction artifacts are written."),
    segments_path: tool.schema
      .string()
      .optional()
      .describe("Optional path override for req-segments.json."),
  },
  async execute(args, ctx: ToolContext) {
    const mode = args.mode || "extract"
    if (mode === "extract") {
      return executeExtractMode(args, ctx)
    }
    return JSON.stringify({
      error: `unsupported req_parser mode: ${String(mode)}`,
    })
  },
})





