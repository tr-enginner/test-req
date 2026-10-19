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
  section_path_ids?: string[]
  section_path_titles?: string[]
}

interface TocEntry {
  segment_id: string
  level: number
  title: string
  section_path_ids?: string[]
  section_path_titles?: string[]
}

interface SegmentArtifact {
  file?: string
  format?: string
  extraction_mode?: string
  total_segments: number
  toc: TocEntry[]
  segments: Array<{
    segment_id: string
    level: number
    title: string
    text?: string
    section_path_ids?: string[]
    section_path_titles?: string[]
  }>
}

interface TocAnchorArtifact {
  source_toc_path: string
  total_segments: number
  anchors: Array<{
    section_id: string
    title: string
    labels: FinalCategory[]
  }>
  segments: Array<{
    segment_id: string
    title: string
    section_path_ids?: string[]
    section_path_titles?: string[]
    anchor_section_id?: string | null
    labels: FinalCategory[]
  }>
}

interface TocAnchorSeed {
  section_id: string
  title?: string
  labels: FinalCategory[]
}

interface OutlineNode {
  node_id: string
  parent_id: string | null
  level: number
  title: string
  segment_ids: string[]
  order: number
}

interface OutlineArtifact {
  file?: string
  format?: string
  source_segments_path?: string
  total_nodes: number
  total_segments: number
  unstructured_segment_ids: string[]
  outline_text: string
  nodes: OutlineNode[]
}

type ParserCategory =
  | "functional"
  | "performance"
  | "interface"
  | "safety"
  | "margin"
  | "boundary"
  | "data_processing"
  | "recovery"
  | "stress"
  | "code_review"
  | "static_analysis"
  | "code_walkthrough"
  | "logic_test"
  | "non_requirement"

type FinalCategory = Exclude<ParserCategory, "non_requirement">

const CLASSIFICATION_CATEGORIES: FinalCategory[] = [
  "functional",
  "performance",
  "interface",
  "safety",
  "margin",
  "boundary",
  "data_processing",
  "recovery",
  "stress",
  "code_review",
  "static_analysis",
  "code_walkthrough",
  "logic_test",
]

const STRUCTURED_REQUIREMENT_ID_RE = /^(?:SRS|REQ|SR|FR|NFR|IR)-((?:[A-Za-z]|\d+)(?:\.(?:\d+|[A-Za-z]))*)(?:__\d+)?$/i

function parseFinalCategories(value: unknown): FinalCategory[] {
  if (!Array.isArray(value)) return []
  const result: FinalCategory[] = []
  for (const item of value) {
    if (typeof item !== "string") continue
    if (!CLASSIFICATION_CATEGORIES.includes(item as FinalCategory)) continue
    if (!result.includes(item as FinalCategory)) {
      result.push(item as FinalCategory)
    }
  }
  return result
}

function mergeFinalCategories(...groups: Array<FinalCategory[] | undefined>): FinalCategory[] {
  const merged: FinalCategory[] = []
  for (const group of groups) {
    for (const item of group || []) {
      if (!merged.includes(item)) merged.push(item)
    }
  }
  return merged
}

function normalizeTocEntries(root: Record<string, unknown>): TocEntry[] {
  return readStringRecordArray<Record<string, unknown>>(root.toc).map((item) => ({
    segment_id: textOf(item.segment_id),
    level: typeof item.level === "number" ? item.level : 1,
    title: textOf(item.title),
    section_path_ids: readStringArray(item.section_path_ids),
    section_path_titles: readStringArray(item.section_path_titles),
  }))
}

function findSectionReferenceInToc(
  toc: TocEntry[],
  sectionId: string,
): { title: string; toc_index: number; depth: number } | null {
  let best: { title: string; toc_index: number; depth: number } | null = null

  for (const [index, entry] of toc.entries()) {
    const segmentId = textOf(entry.segment_id)
    if (segmentId === sectionId) {
      return {
        title: textOf(entry.title),
        toc_index: index,
        depth: Math.max(1, readStringArray(entry.section_path_ids).length),
      }
    }

    const pathIds = readStringArray(entry.section_path_ids)
    const matchIndex = pathIds.indexOf(sectionId)
    if (matchIndex < 0) continue

    const pathTitles = readStringArray(entry.section_path_titles)
    const candidate = {
      title: textOf(pathTitles[matchIndex]),
      toc_index: index,
      depth: matchIndex + 1,
    }

    if (!best || candidate.toc_index < best.toc_index || (
      candidate.toc_index === best.toc_index && candidate.depth < best.depth
    )) {
      best = candidate
    }
  }

  return best
}

function normalizeTocAnchorSeeds(
  value: unknown,
  toc: TocEntry[],
  tocPath: string,
): TocAnchorSeed[] {
  const mergedById = new Map<string, TocAnchorSeed>()
  const missingIds: string[] = []

  for (const item of readStringRecordArray<Record<string, unknown>>(value)) {
    const sectionId = textOf(item.section_id)
    if (!sectionId) continue

    const tocRef = findSectionReferenceInToc(toc, sectionId)
    if (!tocRef) {
      missingIds.push(sectionId)
      continue
    }

    const prev = mergedById.get(sectionId)
    const labels = parseFinalCategories(item.labels)
    mergedById.set(sectionId, {
      section_id: sectionId,
      title: textOf(item.title) || prev?.title || tocRef.title || sectionId,
      labels: mergeFinalCategories(prev?.labels, labels),
    })
  }

  if (missingIds.length > 0) {
    throw new Error(
      `toc anchor seeds reference unknown section_id values not present in ${tocPath}: ` +
      `${missingIds.join(", ")}`,
    )
  }

  return Array.from(mergedById.values()).sort((a, b) => {
    const aRef = findSectionReferenceInToc(toc, a.section_id)
    const bRef = findSectionReferenceInToc(toc, b.section_id)
    if (!aRef && !bRef) return a.section_id.localeCompare(b.section_id)
    if (!aRef) return 1
    if (!bRef) return -1
    if (aRef.toc_index !== bRef.toc_index) return aRef.toc_index - bRef.toc_index
    if (aRef.depth !== bRef.depth) return aRef.depth - bRef.depth
    return a.section_id.localeCompare(b.section_id)
  })
}

function resolveNearestAnchorSectionId(entry: TocEntry, anchorIds: Set<string>): string | null {
  const candidateIds = readStringArray(entry.section_path_ids)
  const segmentId = textOf(entry.segment_id)
  if (segmentId && !candidateIds.includes(segmentId)) {
    candidateIds.push(segmentId)
  }

  for (let i = candidateIds.length - 1; i >= 0; i -= 1) {
    const candidate = candidateIds[i]
    if (anchorIds.has(candidate)) return candidate
  }

  return null
}

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

function isLikelyBase64BlobLine(line: string): boolean {
  const compact = line.replace(/\s+/g, "")
  if (compact.length < 120) return false
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(compact)) return true
  return /^[A-Za-z0-9+/=]+$/.test(compact)
}

function sanitizeExtractedDocumentText(text: string): string {
  return text
    .replace(/<!--\s*image\s*-->/gi, "")
    .replace(/<img\b[^>]*>/gi, "")
    .replace(/<a\b[^>]*>/gi, "")
    .replace(/<\/a>/gi, "")
    .replace(/\[([^\]]+)]\(#_Toc[^)]+\)/gi, "$1")
    .replace(/!\[[^\]]*]\([^)]*\)/g, "")
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim()
      if (!trimmed) return true
      if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(trimmed)) return false
      if (/data:image\/[a-z0-9.+-]+;base64,/i.test(trimmed)) return false
      if (isLikelyBase64BlobLine(trimmed)) return false
      return true
    })
    .join("\n")
}

function shouldSkipNoiseLine(line: string): boolean {
  const v = line.trim()
  if (!v) return false
  if (/^(?:contents?|\u76ee\u5f55)$/iu.test(v)) return true
  if (/^[-_=.\s]{6,}$/.test(v)) return true
  if (/^(?:page\s*)?\d+\s*\/\s*\d+$/i.test(v)) return true
  if (/_Toc\d+/i.test(v)) return true
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

function extractTopLevelStructuredNumber(sectionId: string): number | null {
  const match = textOf(sectionId).match(STRUCTURED_REQUIREMENT_ID_RE)
  if (!match) return null
  const [head] = match[1].split(".")
  if (!/^\d+$/.test(head || "")) return null
  return Number.parseInt(head, 10)
}

function currentTopLevelStructuredNumber(
  headingStack: Array<{ section_id: string; title: string; level: number }>,
): number | null {
  for (const entry of headingStack) {
    const num = extractTopLevelStructuredNumber(entry.section_id)
    if (num !== null) return num
  }
  return null
}

function isLikelySingleNumberChapterTitle(
  rawNumber: string,
  title: string,
  currentTopLevelNumber: number | null,
): boolean {
  const t = normalizeHeadingCandidate(title)
  if (!isLikelyHeadingTitle(t)) return false
  const chapterNumber = Number.parseInt(rawNumber, 10)
  if (!Number.isNaN(chapterNumber) && chapterNumber <= 0) return false
  if (!Number.isNaN(chapterNumber) && chapterNumber > 50) return false
  if (
    currentTopLevelNumber !== null &&
    !Number.isNaN(chapterNumber) &&
    currentTopLevelNumber >= 2 &&
    chapterNumber < currentTopLevelNumber
  ) {
    return false
  }
  if (t.length > 40) return false
  if (/^[：:；;，,。.!！？、]/u.test(t)) return false
  if (/[；;。!?！？]/u.test(t)) return false
  if (/^(?:次|秒|分钟|小时|天|月|年|个|项|位|路|帧|字节|字|安|伏|毫秒|A|V|Ah|ms|s|h)(?:[：:；;，,。、]|$)/iu.test(t)) {
    return false
  }
  return true
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
  const annexMatch = normalized.match(
    /^(?:\d+(?:\.\d+)*[.\uFF0E\u3002]?\s*)?(?:\u9644\u4ef6|\u9644\u5f55)\s*([A-Za-z])(?:\s*[\uFF08(][^\uFF09)]*[\uFF09)])?\s*(.+)$/u,
  )
  if (annexMatch) {
    const [, rawNumber, rawHeadingTitle] = annexMatch
    const headingTitle = normalizeHeadingCandidate(rawHeadingTitle)
    if (!headingTitle || !isLikelyHeadingTitle(headingTitle)) return null
    return {
      segment_id: normalizeStructuredSegmentId(prefix, rawNumber),
      title: headingTitle,
    }
  }

  // Some Word/WPS documents store the final punctuation of a visible heading
  // number as literal paragraph text instead of numbering metadata, for example
  // "5.2.4.3. Title". Treat that punctuation as part of the label separator so
  // the heading keeps its canonical SRS id instead of falling back to SEG-NNN.
  const hierarchical = normalized.match(/^(\d+(?:\.\d+)+|[A-Za-z](?:\.\d+)+)[.\uFF0E\u3002]?\s*(.+)$/u)
  const delimitedTopLevel = normalized.match(/^(\d+)(?:[.\uFF0E\u3002]\s*|\s+)(.+)$/u)
  const compactCandidate = normalized.match(/^(\d{1,2})([A-Za-z\u4e00-\u9fff（(].*)$/u)
  const compactTopLevel = compactCandidate && Number(compactCandidate[1]) >= 1 && Number(compactCandidate[1]) <= 20
    ? compactCandidate
    : null
  const match = hierarchical || delimitedTopLevel || compactTopLevel
  if (!match) return null
  const [, rawNumber, rawHeadingTitle] = match
  const headingTitle = normalizeHeadingCandidate(rawHeadingTitle)
  if (!headingTitle || !isLikelyHeadingTitle(headingTitle)) return null
  return {
    segment_id: normalizeStructuredSegmentId(prefix, rawNumber),
    title: headingTitle,
  }
}

function makeFallbackSegmentId(seq: number): string {
  return `SEG-${pad3(seq)}`
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
  const headingStack: Array<{ section_id: string; title: string; level: number }> = []
  let sawMarkdownHeading = false

  const newSegment = (
    title: string,
    idHint?: string,
    sectionPathIds: string[] = [],
    sectionPathTitles: string[] = [],
    levelHint?: number,
  ) => {
    seq += 1
    const segmentID = idHint || makeFallbackSegmentId(seq)
    current = {
      segment_id: segmentID,
      title: normalizeHeadingCandidate(title) || `segment-${seq}`,
      text: "",
      level: levelHint ?? levelFromId(segmentID),
      section_path_ids: sectionPathIds,
      section_path_titles: sectionPathTitles,
    }
  }

  const pushStructuredHeading = (segmentID: string, title: string, levelHint?: number) => {
    const normalizedTitle = normalizeHeadingCandidate(title) || title.trim()
    const level = levelHint ?? levelFromId(segmentID)
    while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
      headingStack.pop()
    }
    headingStack.push({
      section_id: segmentID,
      title: normalizedTitle,
      level,
    })
    return {
      ids: headingStack.map((entry) => entry.section_id),
      titles: headingStack.map((entry) => entry.title),
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
    const headingLine = line
      .replaceAll("\\.", ".")
      .replaceAll("\\(", "(")
      .replaceAll("\\)", ")")
    const normalizedMarker = line.replace(/^[_*~\s]+|[_*~\s]+$/g, "")
    if (/^(?:contents?|\u76ee\u5f55)$/iu.test(normalizedMarker)) {
      inTocBlock = true
      continue
    }
    if (shouldSkipNoiseLine(line)) continue

    const mdHeadingMarker = headingLine.match(/^(#{1,6})\s+/)?.[1] || ""
    const mdHeadingLevel = mdHeadingMarker.length || undefined
    const mdHeader = headingLine.match(/^#{1,6}\s+(?:(SRS|REQ|SR|FR|NFR|IR)-((?:\d+|[A-Za-z])(?:\.(?:\d+|[A-Za-z]))*)[:\s]+)?(.+)/i)

    const numHeader = !markdownHeadersOnly && !mdHeader
      ? headingLine.match(/^(\d+(?:\.\d+)+)[.\uFF0E\u3002]?\s+(.+?)(?:\s*\.{3,}\s*\d+)?$/u)
      : null
    const chapterHeader = !markdownHeadersOnly && !mdHeader && !numHeader
      ? headingLine.match(/^(\d+)\s+(.+?)(?:\s*\.{3,}\s*\d+)?$/)
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
      isLikelySingleNumberChapterTitle(chapterHeader[1], chapterHeader[2], currentTopLevelStructuredNumber(headingStack))
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
      const id = num
        ? normalizeStructuredSegmentId(prefix, num)
        : parsedFromTitle?.segment_id
      const headingTitle = parsedFromTitle?.title || mdHeader[3]
      if (id) {
        const effectiveHeadingLevel = /^SRS-[A-Z]$/i.test(id) ? 1 : mdHeadingLevel
        const path = pushStructuredHeading(id, headingTitle, effectiveHeadingLevel)
        newSegment(headingTitle, id, path.ids, path.titles, effectiveHeadingLevel)
      } else {
        const fallbackId = makeFallbackSegmentId(seq + 1)
        const path = pushStructuredHeading(fallbackId, headingTitle, mdHeadingLevel)
        newSegment(headingTitle, fallbackId, path.ids, path.titles, mdHeadingLevel)
      }
      continue
    }

    if (
      acceptedNumHeader &&
      numHeader &&
      !isTocLine &&
      !isLikelyListItem(line)
    ) {
      flush()
      const id = normalizeStructuredSegmentId("SRS", numHeader[1])
      const path = pushStructuredHeading(id, numHeader[2])
      newSegment(numHeader[2], id, path.ids, path.titles)
      continue
    }

    if (
      acceptedChapterHeader &&
      chapterHeader &&
      !isTocChapterLine &&
      !isLikelyListItem(line)
    ) {
      flush()
      const id = normalizeStructuredSegmentId("SRS", chapterHeader[1])
      const path = pushStructuredHeading(id, chapterHeader[2])
      newSegment(chapterHeader[2], id, path.ids, path.titles)
      continue
    }

    if (!current && line) {
      if (preservePreamble) {
        newSegment("文档前置内容", "SRS-PREAMBLE", ["SRS-PREAMBLE"], ["文档前置内容"], 1)
      } else {
        newSegment("preamble")
      }
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
    section_path_ids: Array.isArray(s.section_path_ids) ? [...s.section_path_ids] : [],
    section_path_titles: Array.isArray(s.section_path_titles) ? [...s.section_path_titles] : [],
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

function readJson<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2), "utf-8")
}

function pad3(n: number): string {
  return String(n).padStart(3, "0")
}

function textOf(v: unknown): string {
  return typeof v === "string" ? v.trim() : ""
}

function readStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

function readStringRecordArray<T extends Record<string, unknown>>(value: unknown): T[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is T => Boolean(item && typeof item === "object"))
}

function stripSegmentChunkSuffix(segmentId: string): string {
  return textOf(segmentId).replace(/__\d+$/u, "")
}

function isStructuredSegmentId(segmentId: string): boolean {
  return STRUCTURED_REQUIREMENT_ID_RE.test(textOf(segmentId))
}

function buildOutlineText(nodes: OutlineNode[]): string {
  return nodes
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((node) => `${"  ".repeat(Math.max(0, node.level - 1))}${node.node_id} ${node.title} [segments=${node.segment_ids.length}]`)
    .join("\n")
}

function buildOutlineArtifact(sourceArtifact: SegmentArtifact, sourceSegmentsPath: string): OutlineArtifact {
  const segments = Array.isArray(sourceArtifact.segments) ? sourceArtifact.segments : []
  const nodesById = new Map<string, OutlineNode>()
  const unstructuredSegmentIds: string[] = []
  let nextOrder = 0

  const ensureNode = (
    nodeId: string,
    parentId: string | null,
    level: number,
    title: string,
  ) => {
    const normalizedId = textOf(nodeId)
    if (!normalizedId) return null
    const normalizedTitle = textOf(title) || normalizedId
    const existing = nodesById.get(normalizedId)
    if (existing) {
      if (!existing.parent_id && parentId) existing.parent_id = parentId
      if (!existing.title && normalizedTitle) existing.title = normalizedTitle
      if (existing.level <= 0 && level > 0) existing.level = level
      return existing
    }
    nextOrder += 1
    const node: OutlineNode = {
      node_id: normalizedId,
      parent_id: parentId,
      level: Math.max(1, level),
      title: normalizedTitle,
      segment_ids: [],
      order: nextOrder,
    }
    nodesById.set(normalizedId, node)
    return node
  }

  for (const segment of segments) {
    const segmentId = textOf(segment.segment_id)
    if (!segmentId) continue

    let pathIds = readStringArray(segment.section_path_ids)
    let pathTitles = readStringArray(segment.section_path_titles)
    if (pathIds.length === 0 && isStructuredSegmentId(segmentId)) {
      pathIds = [stripSegmentChunkSuffix(segmentId)]
      pathTitles = [textOf(segment.title)]
    }

    if (pathIds.length === 0) {
      unstructuredSegmentIds.push(segmentId)
      continue
    }

    for (let i = 0; i < pathIds.length; i += 1) {
      ensureNode(
        pathIds[i],
        i > 0 ? pathIds[i - 1] : null,
        i + 1,
        pathTitles[i] || (i === pathIds.length - 1 ? textOf(segment.title) : pathIds[i]),
      )
    }

    const leafNodeId = pathIds[pathIds.length - 1]
    const leafNode = nodesById.get(leafNodeId)
    if (leafNode && !leafNode.segment_ids.includes(segmentId)) {
      leafNode.segment_ids.push(segmentId)
    }
  }

  const nodes = Array.from(nodesById.values()).sort((a, b) => a.order - b.order)
  return {
    file: sourceArtifact.file,
    format: sourceArtifact.format,
    source_segments_path: sourceSegmentsPath,
    total_nodes: nodes.length,
    total_segments: segments.length,
    unstructured_segment_ids: uniqueStrings(unstructuredSegmentIds),
    outline_text: buildOutlineText(nodes),
    nodes,
  }
}

async function executeExtractMode(args: {
  file_path?: string
  format?: "markdown" | "text" | "docx" | "pdf"
  write_artifacts?: boolean
  segments_path?: string
  toc_path?: string
}, ctx: ToolContext) {
  const { file_path, format, write_artifacts = true } = args
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

  content = sanitizeExtractedDocumentText(content)
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
      section_path_ids: Array.isArray(s.section_path_ids) ? [...s.section_path_ids] : [],
      section_path_titles: Array.isArray(s.section_path_titles) ? [...s.section_path_titles] : [],
    })),
  }

  const tocOnly = {
    file: file_path,
    format: outputFormat(format, isPdf, isDocx),
    extraction_mode: "segments_toc_only_v1",
    total_segments: segments.length,
    toc,
  }

  let outPath = ""
  let tocPath = ""
  if (write_artifacts) {
    outPath = resolveArtifactPath(ctx, args.segments_path, "req-segments.json")
    tocPath = resolveArtifactPath(ctx, args.toc_path, "req-segments-toc.json")
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
    {
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

function executeBuildOutlineMode(args: {
  segments_path?: string
  outline_path?: string
  write_artifacts?: boolean
}, ctx: ToolContext) {
  const segmentsPath = resolveArtifactPath(ctx, args.segments_path, "req-segments.json")
  const outlinePath = resolveArtifactPath(ctx, args.outline_path, "req-outline.json")
  const writeArtifacts = args.write_artifacts !== false

  if (!existsSync(segmentsPath)) {
    return JSON.stringify({ error: `File not found: ${segmentsPath}` })
  }

  try {
    const sourceArtifact = readJson<SegmentArtifact>(segmentsPath)
    const outline = buildOutlineArtifact(sourceArtifact, segmentsPath)

    if (writeArtifacts) {
      writeJson(outlinePath, outline)
    }

    if (ctx) {
      ctx.metadata({
        title: "Built requirement outline",
        metadata: {
          mode: "build_outline",
          segments_path: segmentsPath,
          output_file: writeArtifacts ? outlinePath : undefined,
          total_nodes: outline.total_nodes,
          total_segments: outline.total_segments,
          unstructured_segments: outline.unstructured_segment_ids.length,
        },
      })
    }

    return JSON.stringify({
      ok: true,
      mode: "build_outline",
      input: {
        segments_path: segmentsPath,
      },
      output: {
        outline_path: writeArtifacts ? outlinePath : undefined,
      },
      summary: {
        total_nodes: outline.total_nodes,
        total_segments: outline.total_segments,
        unstructured_segments: outline.unstructured_segment_ids.length,
      },
    }, null, 2)
  } catch (err) {
    return JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
      input: {
        segments_path: segmentsPath,
        outline_path: outlinePath,
      },
    })
  }
}

function executeBuildTocAnchorMapMode(args: {
  toc_path?: string
  toc_anchor_path?: string
  toc_anchor_seeds?: Array<{
    section_id?: string
    title?: string
    labels?: string[]
  }>
  write_artifacts?: boolean
}, ctx: ToolContext) {
  const tocPath = resolveArtifactPath(ctx, args.toc_path, "req-segments-toc.json")
  const outputPath = resolveArtifactPath(ctx, args.toc_anchor_path, "toc-anchor-map.json")
  const writeArtifacts = args.write_artifacts !== false

  if (!existsSync(tocPath)) {
    return JSON.stringify({ error: `File not found: ${tocPath}` })
  }

  try {
    const tocRoot = readJson<Record<string, unknown>>(tocPath)
    const toc = normalizeTocEntries(tocRoot)
    const anchors = normalizeTocAnchorSeeds(args.toc_anchor_seeds, toc, tocPath)
    const anchorById = new Map(anchors.map((anchor) => [anchor.section_id, anchor] as const))
    const anchorIds = new Set(anchorById.keys())

    const segments = toc.map((entry) => {
      const anchorSectionId = resolveNearestAnchorSectionId(entry, anchorIds)
      const anchor = anchorSectionId ? anchorById.get(anchorSectionId) : undefined
      return {
        segment_id: textOf(entry.segment_id),
        title: textOf(entry.title),
        section_path_ids: readStringArray(entry.section_path_ids),
        section_path_titles: readStringArray(entry.section_path_titles),
        anchor_section_id: anchorSectionId,
        labels: anchor ? [...anchor.labels] : [],
      }
    })

    const artifact: TocAnchorArtifact = {
      source_toc_path: tocPath,
      total_segments: segments.length,
      anchors: anchors.map((anchor) => ({
        section_id: anchor.section_id,
        title: textOf(anchor.title) || anchor.section_id,
        labels: [...anchor.labels],
      })),
      segments,
    }

    if (writeArtifacts) {
      writeJson(outputPath, artifact)
    }

    if (ctx) {
      ctx.metadata({
        title: "Built TOC anchor map",
        metadata: {
          mode: "build_toc_anchor_map",
          toc_path: tocPath,
          output_file: writeArtifacts ? outputPath : undefined,
          total_anchors: artifact.anchors.length,
          total_segments: artifact.total_segments,
          anchored_segments: artifact.segments.filter((segment) => Boolean(segment.anchor_section_id)).length,
        },
      })
    }

    return JSON.stringify({
      ok: true,
      mode: "build_toc_anchor_map",
      input: {
        toc_path: tocPath,
        toc_anchor_seed_count: anchors.length,
      },
      output: {
        toc_anchor_path: writeArtifacts ? outputPath : undefined,
      },
      summary: {
        total_anchors: artifact.anchors.length,
        total_segments: artifact.total_segments,
        anchored_segments: artifact.segments.filter((segment) => Boolean(segment.anchor_section_id)).length,
        labeled_segments: artifact.segments.filter((segment) => segment.labels.length > 0).length,
      },
    }, null, 2)
  } catch (err) {
    return JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
      input: {
        toc_path: tocPath,
        toc_anchor_path: outputPath,
      },
    })
  }
}

function executeGetSegmentMode(args: {
  segments_path?: string
  segment_id?: string
}, ctx: ToolContext) {
  const segmentId = textOf(args.segment_id)
  if (!segmentId) {
    return JSON.stringify({ error: "segment_id is required when mode=get_segment" })
  }

  const segmentsPath = resolveArtifactPath(ctx, args.segments_path, "req-segments.json")
  if (!existsSync(segmentsPath)) {
    return JSON.stringify({ error: `File not found: ${segmentsPath}` })
  }

  try {
    const root = readJson<SegmentArtifact>(segmentsPath)
    const segment = Array.isArray(root.segments)
      ? root.segments.find((item) => textOf(item.segment_id) === segmentId)
      : undefined

    if (!segment) {
      return JSON.stringify({
        ok: false,
        error: `segment_id ${segmentId} not found in ${segmentsPath}`,
      })
    }

    return JSON.stringify(
      {
        ok: true,
        mode: "get_segment",
        input: {
          segments_path: segmentsPath,
          segment_id: segmentId,
        },
        segment: {
          segment_id: textOf(segment.segment_id),
          level: typeof segment.level === "number" ? segment.level : 1,
          title: textOf(segment.title),
          text: textOf(segment.text),
        },
      },
      null,
      2,
    )
  } catch (err) {
    return JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
      input: {
        segments_path: segmentsPath,
        segment_id: segmentId,
      },
    })
  }
}

export function configureFilldataParserClient(_client: unknown): void {
  // no-op: classification is handled by the Phase 2 agent workflow.
}

export const filldataParser: ToolDefinition = tool({
  description:
    "Phase 2 document extraction, outline generation, TOC anchor expansion, and targeted segment retrieval.",
  args: {
    mode: tool.schema
      .enum([
        "extract",
        "build_outline",
        "build_toc_anchor_map",
        "get_segment",
      ])
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
    outline_path: tool.schema
      .string()
      .optional()
      .describe("Path override for req-outline.json. Used by mode=build_outline."),
    toc_anchor_path: tool.schema
      .string()
      .optional()
      .describe("Path override for toc-anchor-map.json. Used by mode=build_toc_anchor_map."),
    toc_anchor_seeds: tool.schema
      .array(tool.schema.object({
        section_id: tool.schema.string().describe("TOC section_id to promote as a sparse anchor, for example SRS-3.2."),
        title: tool.schema.string().optional().describe("Optional override title for the anchor; otherwise derived from req-segments-toc.json."),
        labels: tool.schema
          .array(tool.schema.enum([
            "functional",
            "performance",
            "interface",
            "safety",
            "margin",
            "boundary",
            "data_processing",
            "recovery",
            "stress",
            "code_review",
            "static_analysis",
            "code_walkthrough",
            "logic_test",
          ]))
          .optional()
          .describe("Category labels attached to this sparse anchor. Use [] when the anchor is structural/non-requirement."),
      }))
      .optional()
      .describe("Sparse TOC anchor definitions used by mode=build_toc_anchor_map. Code expands descendants into the full toc-anchor-map.json artifact."),
    segments_path: tool.schema
      .string()
      .optional()
      .describe("Path override for req-segments.json. Required when mode=get_segment and optional when mode=build_outline."),
    segment_id: tool.schema
      .string()
      .optional()
      .describe("Segment identifier to retrieve when mode=get_segment."),
  },
  async execute(args, ctx: ToolContext) {
    const mode = args.mode || "extract"
    if (mode === "extract") {
      return executeExtractMode(args, ctx)
    }
    if (mode === "build_outline") {
      return executeBuildOutlineMode(args, ctx)
    }
    if (mode === "build_toc_anchor_map") {
      return executeBuildTocAnchorMapMode(args, ctx)
    }
    if (mode === "get_segment") {
      return executeGetSegmentMode(args, ctx)
    }
    return JSON.stringify({
      error: `unsupported filldata_parser mode: ${String(mode)}`,
    })
  },
})





