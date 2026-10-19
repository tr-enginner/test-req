/**
 * docx-heading-resolver.ts — OOXML heading parsing and section location.
 *
 * Provides heading-level parsing from word/document.xml + word/numbering.xml,
 * section range finding, and table extraction within sections.
 *
 * Migrated from Java OutlineSectionExtractVisitorV2 + AbstractDocParser.
 * Shared by: outline-tr-extractor, docx-range-copy, eval-desc-generator.
 */

// ─── Types ─────────────────────────────────────────────────────────

export interface HeadingEntry {
  label: string       // e.g. "6.2.1"
  title: string       // e.g. "功能测试"
  level: number       // 1, 2, 3, ...
  paraIndex: number   // 0-based index among all <w:p> elements in body
  label_source?: "numbering" | "text" | "inferred"
}

interface ActiveAnnexHeading {
  label: string
  level: number
  childCounters: number[]
}

function matchAnnexRootTitle(value: string): RegExpMatchArray | null {
  return value.match(
    /^(?:\d+(?:\.\d+)*[.\uFF0E\u3002]?\s*)?(?:\u9644\u4ef6|\u9644\u5f55)\s*([A-Za-z])(?:\s*[\uFF08(][^\uFF09)]*[\uFF09)])?(?:\s+|$)/u,
  )
}

function explicitAnnexChildLabel(value: string, annexLabel: string): string | null {
  const match = extractExplicitHeadingPrefix(value)
  if (!match || !/^[A-Za-z](?:\.\d+)+$/u.test(match.label) || !match.label.toUpperCase().startsWith(`${annexLabel}.`)) return null
  return match.label.toUpperCase()
}

function extractExplicitHeadingPrefix(value: string): { label: string; length: number } | null {
  const hierarchical = value.match(/^((?:\d+(?:\.\d+)+)|(?:[A-Za-z](?:\.\d+)+))[.\uFF0E\u3002]?\s*/u)
  if (hierarchical) return { label: hierarchical[1], length: hierarchical[0].length }

  const delimited = value.match(/^(\d+)(?:[.\uFF0E\u3002]\s*|\s+)(?=\S)/u)
  if (delimited) return { label: delimited[1], length: delimited[0].length }

  // Compact top-level chapters are commonly written as "5需求" or
  // "12指令格式定义". Keep the plausible chapter range narrow so years, byte
  // counts, and other ordinary numeric prose are not mistaken for sections.
  const compactTopLevel = value.match(/^(\d{1,2})(?=[A-Za-z\u4e00-\u9fff（(])/u)
  if (!compactTopLevel || Number(compactTopLevel[1]) < 1 || Number(compactTopLevel[1]) > 20) return null
  return { label: compactTopLevel[1], length: compactTopLevel[0].length }
}

function recordAnnexChildLabel(active: ActiveAnnexHeading, label: string): void {
  const parts = label.split(".").slice(1).map((part) => Number.parseInt(part, 10))
  if (parts.length === 0 || parts.some((part) => !Number.isFinite(part))) return
  active.childCounters = parts
}

function nextAnnexChildLabel(active: ActiveAnnexHeading, level: number): string {
  const relativeLevel = Math.max(1, level - active.level)
  while (active.childCounters.length < relativeLevel) active.childCounters.push(0)
  for (let index = relativeLevel; index < active.childCounters.length; index += 1) {
    active.childCounters[index] = 0
  }
  active.childCounters[relativeLevel - 1] = (active.childCounters[relativeLevel - 1] || 0) + 1
  for (let index = 0; index < relativeLevel - 1; index += 1) {
    if (!active.childCounters[index]) active.childCounters[index] = 1
  }
  return `${active.label}.${active.childCounters.slice(0, relativeLevel).join(".")}`
}

export interface ParsedCell {
  paragraphs: string[]
  subTables?: ParsedTable[]
}

export interface ParsedTableRow {
  cells: ParsedCell[]
}

export interface ParsedTable {
  rows: ParsedTableRow[]
}

export interface TopLevelDocxBodyElement {
  tag: "p" | "tbl" | "sectPr"
  xml: string
  text?: string
  table?: ParsedTable
  body_element_index: number
  start_offset: number
  end_offset: number
}

export function isDocxBodyLabelOrListParagraph(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (!normalized) return false

  // Requirement/body field labels are often copied from heading-like paragraphs in Word,
  // but they are semantic labels inside a requirement item, not document headings.
  if (/^(?:标识符|输入|输入流|输出|输出流|处理|测试要求|测试充分性要求|测试终止要求|优先级)\s*[:：]\s*.*$/u.test(normalized)) {
    return true
  }

  // Chinese/Latin ordered body list items, e.g. "1、引导加载..." or "a. BM3803初始化".
  if (/^(?:\d+|[A-Za-z])\s*[、,，.．)]\s*\S+/u.test(normalized)) {
    return true
  }

  if (/^（\s*(?:\d+|[A-Za-z])\s*）\s*\S+/u.test(normalized)) {
    return true
  }

  return false
}

export function hasExplicitHierarchicalHeadingLabel(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim()
  return /^(?:\d+(?:\.\d+)+|[A-Za-z](?:\.\d+)+)[.\uFF0E\u3002]?(?=\s|[A-Za-z\u4e00-\u9fff（(]|$)/u.test(normalized)
}

export function shouldSuppressDocxBodyHeading(text: string): boolean {
  return isDocxBodyLabelOrListParagraph(text) && !hasExplicitHierarchicalHeadingLabel(text)
}

// ─── Numbering Parser ──────────────────────────────────────────────

interface NumLevel {
  ilvl: number
  numFmt: string    // decimal, chineseCountingThousand, etc.
  lvlText: string   // "%1." or "%1.%2." etc.
  start: number
  paragraphStyleId?: string
}

interface AbstractNumDef {
  abstractNumId: string
  levels: NumLevel[]
}

interface NumIdMapping {
  numId: string
  abstractNumId: string
  startOverrides: Map<number, number>
  levelOverrides: Map<number, NumLevel>
}

/**
 * Parse numbering.xml to build abstractNum definitions and numId→abstractNumId mappings.
 */
function parseParagraphStyleNames(stylesXml: string | undefined): Map<string, string> {
  const names = new Map<string, string>()
  if (!stylesXml) return names

  const styleRegex = /<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g
  let match: RegExpExecArray | null
  while ((match = styleRegex.exec(stylesXml)) !== null) {
    const attrs = match[1]
    if (!/\bw:type="paragraph"/.test(attrs)) continue
    const styleId = attrs.match(/\bw:styleId="([^"]+)"/)?.[1] || ""
    if (!styleId) continue

    const styleName = match[2].match(/<w:name\b[^>]*\bw:val="([^"]*)"/)?.[1] || ""
    if (styleName) {
      names.set(styleId, decodeXmlEntities(styleName))
    }
  }
  return names
}

function parseParagraphStyleNumbering(stylesXml: string | undefined): Map<string, { numId: string; ilvl: number }> {
  const numbering = new Map<string, { numId: string; ilvl: number }>()
  if (!stylesXml) return numbering
  const styleRegex = /<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g
  let match: RegExpExecArray | null
  while ((match = styleRegex.exec(stylesXml)) !== null) {
    if (!/\bw:type="paragraph"/.test(match[1])) continue
    const styleId = match[1].match(/\bw:styleId="([^"]+)"/)?.[1] || ""
    const numPr = match[2].match(/<w:numPr>([\s\S]*?)<\/w:numPr>/)?.[1] || ""
    const numId = numPr.match(/<w:numId\b[^>]*\bw:val="([^"]+)"/)?.[1] || ""
    if (!styleId || !numId) continue
    const ilvl = Number.parseInt(numPr.match(/<w:ilvl\b[^>]*\bw:val="(\d+)"/)?.[1] || "0", 10)
    numbering.set(styleId, { numId, ilvl })
  }
  return numbering
}

function normalizeStyleName(value: string): string {
  return value
    .replace(/[-_]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function headingLevelFromStyle(styleId: string, styleName: string): number {
  const candidates = [normalizeStyleName(styleName), normalizeStyleName(styleId)]
  for (const candidate of candidates) {
    if (!candidate) continue

    const english = candidate.match(/^heading\s*(\d+)$/i)
    if (english) {
      const level = parseInt(english[1], 10)
      return level >= 1 && level <= 9 ? level : -1
    }

    const compactEnglish = candidate.match(/^heading(\d+)$/i)
    if (compactEnglish) {
      const level = parseInt(compactEnglish[1], 10)
      return level >= 1 && level <= 9 ? level : -1
    }

    const chinese = candidate.match(/^标题\s*(\d+)$/u)
    if (chinese) {
      const level = parseInt(chinese[1], 10)
      return level >= 1 && level <= 9 ? level : -1
    }
  }
  return -1
}

function synchronizeLevelCounters(label: string, counters: number[]): void {
  if (!/^\d+(?:\.\d+)*$/u.test(label)) return
  const parts = label.split(".").map((part) => Number.parseInt(part, 10))
  if (parts.some((part) => !Number.isFinite(part) || part < 0)) return

  for (let index = 0; index < counters.length; index += 1) {
    counters[index] = index < parts.length ? parts[index] : 0
  }
}

function parseNumberingXml(numberingXml: string): {
  abstractNums: Map<string, AbstractNumDef>
  numIdMap: Map<string, NumIdMapping>
} {
  const abstractNums = new Map<string, AbstractNumDef>()
  const numIdMap = new Map<string, NumIdMapping>()

  // Parse <w:abstractNum>
  const abstractRegex = /<w:abstractNum\s+w:abstractNumId="(\d+)"[^>]*>([\s\S]*?)<\/w:abstractNum>/g
  let m: RegExpExecArray | null
  while ((m = abstractRegex.exec(numberingXml)) !== null) {
    const abstractNumId = m[1]
    const body = m[2]
    const levels: NumLevel[] = []

    const lvlRegex = /<w:lvl\s+w:ilvl="(\d+)"[^>]*>([\s\S]*?)<\/w:lvl>/g
    let lm: RegExpExecArray | null
    while ((lm = lvlRegex.exec(body)) !== null) {
      const ilvl = parseInt(lm[1], 10)
      const lvlBody = lm[2]
      const numFmt = lvlBody.match(/<w:numFmt\s+w:val="([^"]+)"/)?.[1] ?? "decimal"
      const lvlText = lvlBody.match(/<w:lvlText\s+w:val="([^"]+)"/)?.[1] ?? ""
      const start = parseInt(lvlBody.match(/<w:start\s+w:val="(\d+)"/)?.[1] ?? "1", 10)
      const paragraphStyleId = lvlBody.match(/<w:pStyle\b[^>]*\bw:val="([^"]+)"/)?.[1] || undefined
      levels.push({ ilvl, numFmt, lvlText, start, paragraphStyleId })
    }

    abstractNums.set(abstractNumId, { abstractNumId, levels })
  }

  // Parse <w:num>
  const numRegex = /<w:num\b([^>]*)>([\s\S]*?)<\/w:num>/g
  while ((m = numRegex.exec(numberingXml)) !== null) {
    const numId = m[1].match(/\bw:numId="([^"]+)"/)?.[1] || ""
    const abstractNumId = m[2].match(/<w:abstractNumId\b[^>]*\bw:val="([^"]+)"/)?.[1] || ""
    if (!numId || !abstractNumId) continue
    const startOverrides = new Map<number, number>()
    const levelOverrides = new Map<number, NumLevel>()
    const overrideRegex = /<w:lvlOverride\b[^>]*\bw:ilvl="(\d+)"[^>]*>([\s\S]*?)<\/w:lvlOverride>/g
    let overrideMatch: RegExpExecArray | null
    while ((overrideMatch = overrideRegex.exec(m[2])) !== null) {
      const start = overrideMatch[2].match(/<w:startOverride\b[^>]*\bw:val="(\d+)"/)?.[1]
      if (start) startOverrides.set(Number.parseInt(overrideMatch[1], 10), Number.parseInt(start, 10))
      const levelBody = overrideMatch[2].match(/<w:lvl\b[^>]*>([\s\S]*?)<\/w:lvl>/)?.[1]
      if (levelBody) {
        const ilvl = Number.parseInt(overrideMatch[1], 10)
        levelOverrides.set(ilvl, {
          ilvl,
          numFmt: levelBody.match(/<w:numFmt\b[^>]*\bw:val="([^"]+)"/)?.[1] ?? "decimal",
          lvlText: levelBody.match(/<w:lvlText\b[^>]*\bw:val="([^"]+)"/)?.[1] ?? "",
          start: Number.parseInt(levelBody.match(/<w:start\b[^>]*\bw:val="(\d+)"/)?.[1] ?? "1", 10),
          paragraphStyleId: levelBody.match(/<w:pStyle\b[^>]*\bw:val="([^"]+)"/)?.[1] || undefined,
        })
      }
    }
    numIdMap.set(numId, { numId, abstractNumId, startOverrides, levelOverrides })
  }

  return { abstractNums, numIdMap }
}

// ─── Heading Resolution ────────────────────────────────────────────

/**
 * Resolve all headings in a DOCX document.xml.
 *
 * Strategy:
 * 1. Primary: use <w:pStyle> to identify Heading1/2/3 and <w:numPr> to get numbering
 * 2. Fallback: use <w:outlineLvl> for heading level detection
 * 3. If numbering cannot be resolved from numbering.xml, infer labels by counting
 */
export function resolveHeadings(
  docXml: string,
  numberingXml?: string,
  stylesXml?: string,
  options?: { styleOnly?: boolean },
): HeadingEntry[] {
  const headings: HeadingEntry[] = []
  const paragraphStyleNames = parseParagraphStyleNames(stylesXml)
  const paragraphStyleNumbering = parseParagraphStyleNumbering(stylesXml)

  // Parse numbering definitions
  let numInfo: ReturnType<typeof parseNumberingXml> | null = null
  if (numberingXml) {
    numInfo = parseNumberingXml(numberingXml)
  }

  // Track counters per level for label inference
  const levelCounters: number[] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  const countersBySequence = new Map<string, number[]>()
  let activeAnnex: ActiveAnnexHeading | null = null

  // Extract all <w:p> elements from <w:body>
  const bodyMatch = docXml.match(/<w:body>([\s\S]*)<\/w:body>/)
  if (!bodyMatch) return headings

  const bodyContent = bodyMatch[1]

  // Walk structurally parsed top-level body elements. A regex beginning with
  // `<w:p ...>` also matches self-closing empty paragraphs (`<w:p/>`) and can
  // then consume everything through a later `</w:p>`, swallowing headings that
  // follow tables. Top-level traversal avoids both that corruption and the need
  // to infer table nesting by counting tags.
  const bodyElements = findBodyElements(bodyContent)
  let paraIndex = 0

  for (const element of bodyElements) {
    if (element.tag !== "p") continue
    const paraXml = bodyContent.substring(element.start, element.end)
    const paraContent = paraXml

    // Extract paragraph properties
    const pPrMatch = paraContent.match(/<w:pPr>([\s\S]*?)<\/w:pPr>/)
    if (!pPrMatch) {
      paraIndex++
      continue
    }

    const pPrContent = pPrMatch[1]

    // Detect heading level from style
    const styleMatch = pPrContent.match(/<w:pStyle\s+w:val="([^"]+)"/)
    const styleName = styleMatch?.[1] ?? ""
    const displayStyleName = paragraphStyleNames.get(styleName) || ""

    // Detect from outlineLvl
    const outlineLvlMatch = pPrContent.match(/<w:outlineLvl\s+w:val="(\d+)"/)
    const outlineLvl = outlineLvlMatch ? parseInt(outlineLvlMatch[1], 10) : -1

    // Determine heading level
    let level = -1
    let levelSource: "style" | "outline" | null = null
    if (/^Heading\s*1$/i.test(styleName) || styleName === "标题 1" || styleName === "heading 1") {
      level = 1
      levelSource = "style"
    } else if (/^Heading\s*2$/i.test(styleName) || styleName === "标题 2" || styleName === "heading 2") {
      level = 2
      levelSource = "style"
    } else if (/^Heading\s*3$/i.test(styleName) || styleName === "标题 3" || styleName === "heading 3") {
      level = 3
      levelSource = "style"
    } else if (/^Heading\s*4$/i.test(styleName) || styleName === "标题 4" || styleName === "heading 4") {
      level = 4
      levelSource = "style"
    } else if (/^MatrixHeading\s*1$/i.test(styleName) || /^Matrix\s+Heading\s*1$/i.test(styleName)) {
      level = 1
      levelSource = "style"
    } else if (/^MatrixHeading\s*2$/i.test(styleName) || /^Matrix\s+Heading\s*2$/i.test(styleName)) {
      level = 2
      levelSource = "style"
    } else if (/^MatrixHeading\s*3$/i.test(styleName) || /^Matrix\s+Heading\s*3$/i.test(styleName)) {
      level = 3
      levelSource = "style"
    } else if (/^MatrixHeading\s*4$/i.test(styleName) || /^Matrix\s+Heading\s*4$/i.test(styleName)) {
      level = 4
      levelSource = "style"
    } else if (!options?.styleOnly && outlineLvl >= 0 && outlineLvl <= 8) {
      level = outlineLvl + 1
      levelSource = "outline"
    }

    const resolvedStyleLevel = headingLevelFromStyle(styleName, displayStyleName)
    if (resolvedStyleLevel >= 1) {
      level = resolvedStyleLevel
      levelSource = "style"
    }

    if (level < 1) {
      paraIndex++
      continue
    }

    // Extract text content
    // Reuse the boundary-safe OOXML text extractor. The former `<w:t[^>]*>`
    // expression also matched tags such as `<w:tab>`, then consumed bookmark
    // and run XML up to the next `</w:t>`, contaminating heading titles.
    const title = extractParagraphText(paraXml).trim()
    if (!title) {
      paraIndex++
      continue
    }
    const annexRootTitleMatch = matchAnnexRootTitle(title)
    if (!annexRootTitleMatch && shouldSuppressDocxBodyHeading(title)) {
      paraIndex++
      continue
    }

    // Annex roots form a separate letter-based hierarchy. Word/WPS documents
    // often apply Heading 1's decimal numbering style to them even though the
    // visible title is "Appendix A". Resolve the annex before touching the
    // decimal counters so appendices do not turn chapter 9 into chapter 14.
    let label = ""
    let labelSource: HeadingEntry["label_source"]
    const annexRoot = annexRootTitleMatch
    if (annexRoot) {
      label = annexRoot[1].toUpperCase()
      labelSource = "text"
      activeAnnex = { label, level, childCounters: [] }
    } else if (activeAnnex && level > activeAnnex.level) {
      const explicitChildLabel = explicitAnnexChildLabel(title, activeAnnex.label)
      label = explicitChildLabel || nextAnnexChildLabel(activeAnnex, level)
      if (explicitChildLabel) recordAnnexChildLabel(activeAnnex, explicitChildLabel)
      labelSource = "inferred"
    } else {
      if (activeAnnex && level <= activeAnnex.level) activeAnnex = null
      const explicitLabel = extractExplicitHeadingPrefix(title)?.label
      if (explicitLabel) {
        label = explicitLabel
        labelSource = "text"
      }
    }

    // Try to resolve numbering label from <w:numPr>
    const numPrMatch = pPrContent.match(/<w:numPr>([\s\S]*?)<\/w:numPr>/)
    if (!label && numInfo) {
      const directNumId = numPrMatch?.[1].match(/<w:numId\b[^>]*\bw:val="([^"]+)"/)?.[1]
      const directIlvl = numPrMatch?.[1].match(/<w:ilvl\b[^>]*\bw:val="(\d+)"/)?.[1]
      const inheritedNumbering = paragraphStyleNumbering.get(styleName)
      let numId = directNumId || inheritedNumbering?.numId
      let ilvl = directIlvl !== undefined ? Number.parseInt(directIlvl, 10) : inheritedNumbering?.ilvl
      let mapping = numId ? numInfo.numIdMap.get(numId) : undefined
      if (!mapping && styleName) {
        const styleLinkedAbstract = Array.from(numInfo.abstractNums.values()).find((definition) =>
          definition.levels.some((item) => item.paragraphStyleId === styleName)
        )
        const styleLinkedLevel = styleLinkedAbstract?.levels.find((item) => item.paragraphStyleId === styleName)
        if (styleLinkedAbstract && styleLinkedLevel) {
          numId = `abstract:${styleLinkedAbstract.abstractNumId}`
          ilvl = styleLinkedLevel.ilvl
          mapping = {
            numId,
            abstractNumId: styleLinkedAbstract.abstractNumId,
            startOverrides: new Map(),
            levelOverrides: new Map(),
          }
        }
      }
      if (numId && ilvl !== undefined) {
        if (mapping) {
          const abstractDef = numInfo.abstractNums.get(mapping.abstractNumId)
          if (abstractDef) {
            const sequenceKey = mapping.abstractNumId
            const counters = countersBySequence.get(sequenceKey) || []
            for (let i = ilvl + 1; i < counters.length; i++) {
              counters[i] = 0
            }
            const levelDef = mapping.levelOverrides.get(ilvl) ?? abstractDef.levels.find((item) => item.ilvl === ilvl)
            const currentOverride = mapping.startOverrides.get(ilvl)
            const initial = currentOverride ?? levelDef?.start ?? 1
            // numId commonly alternates by heading level while all instances
            // still reference the same abstract multilevel sequence. A numId
            // switch is therefore not a restart. Apply startOverride only when
            // this level is currently uninitialized (including after a parent
            // heading reset its descendants), otherwise continue the sequence.
            counters[ilvl] = counters[ilvl] > 0 ? counters[ilvl] + 1 : initial
            for (let i = 0; i < ilvl; i++) {
              const parentOverride = mapping.startOverrides.get(i)
              if (counters[i]) continue
              const parentDef = mapping.levelOverrides.get(i) ?? abstractDef.levels.find((item) => item.ilvl === i)
              counters[i] = parentOverride ?? parentDef?.start ?? 1
            }
            countersBySequence.set(sequenceKey, counters)
            const template = levelDef?.lvlText || Array.from({ length: ilvl + 1 }, (_, index) => `%${index + 1}`).join(".")
            label = template.replace(/%(\d+)/g, (_match, rawIndex) => String(counters[Number.parseInt(rawIndex, 10) - 1] || 1))
              .replace(/[.)、．。]+$/u, "")
              .trim()
            labelSource = "numbering"
          }
        }
      }
    }

    // Fallback: try to extract label from title text (e.g. "6.2.1 功能测试")
    if (!label) {
      const labelFromText = extractExplicitHeadingPrefix(title)
      if (labelFromText) {
        label = labelFromText.label
        labelSource = "text"
      }
    }

    // Word documents frequently mix automatic numbering, manually materialized
    // labels and headings whose numbering metadata is unavailable. Keep the
    // shared fallback counters aligned with every authoritative numeric label;
    // otherwise the first unnumbered heading restarts at chapter 1 and corrupts
    // all descendant section IDs (for example 3.2.1 becomes 1.2.1).
    if (label) {
      synchronizeLevelCounters(label, levelCounters)
    }

    // Fallback: infer from level counters
    if (!label) {
      for (let i = level; i < levelCounters.length; i++) levelCounters[i] = 0
      levelCounters[level - 1]++
      const parts: string[] = []
      for (let i = 0; i < level; i++) {
        parts.push(String(levelCounters[i]))
      }
      label = parts.join(".")
      labelSource = "inferred"
    }

    // Clean title: remove the label prefix if present
    const explicitPrefix = extractExplicitHeadingPrefix(title)
    const cleanTitle = (explicitPrefix ? title.slice(explicitPrefix.length) : title).trim() || title

    headings.push({
      label,
      title: cleanTitle,
      level,
      paraIndex,
      label_source: labelSource,
    })

    paraIndex++
    continue
  }

  return headings
}

// ─── Section Range ─────────────────────────────────────────────────

/**
 * Find the character offset range in docXml between two headings.
 * Returns start/end byte offsets in the body XML.
 */
export function findSectionRange(
  docXml: string,
  headings: HeadingEntry[],
  startTitle: string,
  endTitle?: string,
  options?: { includeStartTitle?: boolean; includeEndTitle?: boolean },
): { startOffset: number; endOffset: number } | null {
  const includeStart = options?.includeStartTitle ?? false
  const includeEnd = options?.includeEndTitle ?? false

  // Find start heading
  const startHeading = findHeadingByTitle(headings, startTitle)
  if (!startHeading) return null

  // Find end heading
  let endHeading: HeadingEntry | null = null
  if (endTitle) {
    endHeading = findHeadingByTitle(headings, endTitle)
  }

  // Find the actual XML positions using paragraph indices
  const bodyMatch = docXml.match(/<w:body>([\s\S]*)<\/w:body>/)
  if (!bodyMatch) return null

  const bodyStart = docXml.indexOf("<w:body>") + "<w:body>".length
  const bodyContent = bodyMatch[1]

  // Find nth <w:p> or <w:tbl> positions
  const allElements = findBodyElements(bodyContent)

  let startParaOffset = -1
  let startParaEndOffset = -1
  let endParaOffset = -1

  // Find start paragraph position
  let pIdx = 0
  for (const elem of allElements) {
    if (elem.tag === "p") {
      if (pIdx === startHeading.paraIndex) {
        startParaOffset = elem.start
        startParaEndOffset = elem.end
        break
      }
      pIdx++
    }
  }

  if (startParaOffset === -1) return null

  // Find end paragraph position
  if (endHeading) {
    pIdx = 0
    for (const elem of allElements) {
      if (elem.tag === "p") {
        if (pIdx === endHeading.paraIndex) {
          endParaOffset = elem.start
          break
        }
        pIdx++
      }
    }
  }

  const rangeStart = includeStart
    ? bodyStart + startParaOffset
    : bodyStart + startParaEndOffset

  const rangeEnd = endParaOffset !== -1
    ? (includeEnd
        ? bodyStart + findElementEnd(allElements, endHeading!.paraIndex)
        : bodyStart + endParaOffset)
    : docXml.indexOf("</w:body>")

  if (rangeStart >= rangeEnd) return null

  return { startOffset: rangeStart, endOffset: rangeEnd }
}

function findElementEnd(allElements: BodyElement[], paraIndex: number): number {
  let pIdx = 0
  for (const elem of allElements) {
    if (elem.tag === "p") {
      if (pIdx === paraIndex) {
        return elem.end
      }
      pIdx++
    }
  }
  return -1
}

// ─── Table Extraction ──────────────────────────────────────────────

/**
 * Extract all tables within a given section of docXml.
 * Section is defined by character offset range.
 */
export function extractTablesInRange(
  docXml: string,
  startOffset: number,
  endOffset: number,
): ParsedTable[] {
  const rangeXml = docXml.substring(startOffset, endOffset)
  return extractTablesFromXml(rangeXml)
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
}

function extractParagraphText(paragraphXml: string): string {
  const tokenPattern = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>/g
  let text = ""
  let match: RegExpExecArray | null
  while ((match = tokenPattern.exec(paragraphXml)) !== null) {
    if (match[1] !== undefined) {
      text += decodeXmlEntities(match[1])
      continue
    }
    const token = match[0]
    if (token.startsWith("<w:tab")) {
      text += "\t"
    } else if (token.startsWith("<w:br")) {
      text += "\n"
    }
  }
  return text
}

/**
 * Extract tables from an XML fragment.
 */
export function extractTablesFromXml(xml: string): ParsedTable[] {
  const tables: ParsedTable[] = []
  const tableFragments = findTopLevelElementXml(xml, "tbl")

  for (const tableFragment of tableFragments) {
    const tblXml = stripOuterElement(tableFragment, "tbl")
    if (!tblXml) continue
    const rows: ParsedTableRow[] = []

    const trRegex = /<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g
    let trm: RegExpExecArray | null
    while ((trm = trRegex.exec(tblXml)) !== null) {
      const trXml = trm[1]
      const cells: ParsedCell[] = []

      const tcRegex = /<w:tc\b[^>]*>[\s\S]*?<\/w:tc>/g
      let tcm: RegExpExecArray | null
      while ((tcm = tcRegex.exec(trXml)) !== null) {
        const tcXml = tcm[0]
        const tcInnerXml = stripOuterElement(tcXml, "tc")
        if (!tcInnerXml) continue
        const paragraphs: string[] = []
        const subTables: ParsedTable[] = []

        // Extract paragraphs
        const pRegex = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g
        let pm2: RegExpExecArray | null
        while ((pm2 = pRegex.exec(tcInnerXml)) !== null) {
          const text = extractParagraphText(pm2[0])
          if (text.trim()) {
            paragraphs.push(text)
          }
        }

        // Extract sub-tables
        for (const subTableXml of findTopLevelElementXml(tcInnerXml, "tbl")) {
          const subTblTables = extractTablesFromXml(subTableXml)
          subTables.push(...subTblTables)
        }

        cells.push({ paragraphs, subTables: subTables.length > 0 ? subTables : undefined })
      }

      if (cells.length > 0) {
        rows.push({ cells })
      }
    }

    if (rows.length > 0) {
      tables.push({
        rows,
      })
    }
  }

  return tables
}

function stripOuterElement(xml: string, tagName: string): string {
  const match = xml.match(new RegExp(`^<w:${tagName}\\b[^>]*>([\\s\\S]*)<\\/w:${tagName}>$`))
  return match?.[1] ?? ""
}

function findTopLevelElementXml(xml: string, tagName: string): string[] {
  const fragments: string[] = []
  const openTag = `<w:${tagName}`
  const closeTag = `</w:${tagName}>`
  let searchFrom = 0

  while (searchFrom < xml.length) {
    const start = xml.indexOf(openTag, searchFrom)
    if (start === -1) break

    let cursor = start
    let depth = 0
    let completed = false

    while (cursor < xml.length) {
      const nextOpen = findNextTagStart(xml, openTag, cursor)
      const nextClose = xml.indexOf(closeTag, cursor)

      if (nextOpen === -1 && nextClose === -1) break

      if (nextOpen !== -1 && (nextOpen < nextClose || nextClose === -1)) {
        const openEnd = xml.indexOf(">", nextOpen)
        if (openEnd === -1) break
        const isSelfClosing = xml[openEnd - 1] === "/"
        depth += 1
        cursor = openEnd + 1
        if (isSelfClosing) {
          depth -= 1
          if (depth === 0) {
            fragments.push(xml.slice(start, cursor))
            searchFrom = cursor
            completed = true
            break
          }
        }
        continue
      }

      if (nextClose === -1) break
      depth -= 1
      cursor = nextClose + closeTag.length
      if (depth === 0) {
        fragments.push(xml.slice(start, cursor))
        searchFrom = cursor
        completed = true
        break
      }
    }

    if (!completed) {
      break
    }
  }

  return fragments
}

function findNextTagStart(xml: string, tagPrefix: string, from: number): number {
  let index = xml.indexOf(tagPrefix, from)
  while (index !== -1) {
    const boundary = xml[index + tagPrefix.length]
    if (boundary === ">" || boundary === "/" || boundary === " " || boundary === "\t" || boundary === "\r" || boundary === "\n") {
      return index
    }
    index = xml.indexOf(tagPrefix, index + tagPrefix.length)
  }
  return -1
}

// ─── Heading Lookup Helpers ────────────────────────────────────────

/**
 * Find a heading by its title text (fuzzy match: contains or starts-with).
 */
export function findHeadingByTitle(
  headings: HeadingEntry[],
  title: string,
): HeadingEntry | null {
  // Exact match first
  let found = headings.find((h) => h.title === title)
  if (found) return found

  // Contains match
  found = headings.find((h) => h.title.includes(title))
  if (found) return found

  // Label match (e.g. "6.2")
  found = headings.find((h) => h.label === title)
  if (found) return found

  // Regex match for attachment titles like "附件3" or "附件 3"
  const attachmentMatch = title.match(/^附件\s*(\d+)$/)
  if (attachmentMatch) {
    const num = attachmentMatch[1]
    found = headings.find(
      (h) => h.title.match(new RegExp(`^附件\\s*${num}`)) != null,
    )
    if (found) return found
  }

  return null
}

/**
 * Find a heading by label (e.g. "6.2").
 */
export function findHeadingByLabel(
  headings: HeadingEntry[],
  label: string,
): HeadingEntry | null {
  return headings.find((h) => h.label === label) ?? null
}

/**
 * Get all sub-headings under a parent heading label.
 * E.g. getSubHeadings(headings, "6.2") returns 6.2.1, 6.2.2, etc.
 */
export function getSubHeadings(
  headings: HeadingEntry[],
  parentLabel: string,
): HeadingEntry[] {
  const parentLevel = parentLabel.split(".").length
  return headings.filter((h) => {
    if (!h.label.startsWith(parentLabel + ".")) return false
    const childLevel = h.label.split(".").length
    return childLevel === parentLevel + 1
  })
}

/**
 * Extract XML fragment between two offsets in the document.
 */
export function extractXmlFragment(
  docXml: string,
  startOffset: number,
  endOffset: number,
): string {
  return docXml.substring(startOffset, endOffset)
}

export function extractTopLevelBodyElements(docXml: string): TopLevelDocxBodyElement[] {
  const bodyMatch = docXml.match(/<w:body>([\s\S]*)<\/w:body>/)
  if (!bodyMatch) return []

  const bodyStart = docXml.indexOf("<w:body>") + "<w:body>".length
  const bodyContent = bodyMatch[1]
  const elements = findBodyElements(bodyContent)

  return elements.map((element, index) => {
    const xml = bodyContent.substring(element.start, element.end)
    if (element.tag === "p") {
      return {
        tag: "p",
        xml,
        text: extractText(xml),
        body_element_index: index,
        start_offset: bodyStart + element.start,
        end_offset: bodyStart + element.end,
      }
    }
    if (element.tag === "tbl") {
      const table = extractTablesFromXml(xml)[0]
      return {
        tag: "tbl",
        xml,
        table,
        body_element_index: index,
        start_offset: bodyStart + element.start,
        end_offset: bodyStart + element.end,
      }
    }
    return {
      tag: "sectPr",
      xml,
      body_element_index: index,
      start_offset: bodyStart + element.start,
      end_offset: bodyStart + element.end,
    }
  })
}

// ─── Body Element Parsing ──────────────────────────────────────────

interface BodyElement {
  tag: "p" | "tbl" | "sectPr"
  start: number  // offset relative to body content start
  end: number
}

/**
 * Find top-level body elements (<w:p>, <w:tbl>, <w:sectPr>) with their offsets.
 * This handles nesting properly by tracking depth.
 */
function findBodyElements(bodyContent: string): BodyElement[] {
  const elements: BodyElement[] = []
  let pos = 0
  const len = bodyContent.length

  while (pos < len) {
    // Find next < w:p, <w:tbl, or <w:sectPr at depth 0
    const nextP = findNextTagStart(bodyContent, "<w:p", pos)
    const nextTbl = findNextTagStart(bodyContent, "<w:tbl", pos)
    const nextSectPr = findNextTagStart(bodyContent, "<w:sectPr", pos)

    // Find the closest one
    const candidates: { tag: "p" | "tbl" | "sectPr"; idx: number }[] = []
    if (nextP !== -1) candidates.push({ tag: "p", idx: nextP })
    if (nextTbl !== -1) candidates.push({ tag: "tbl", idx: nextTbl })
    if (nextSectPr !== -1) candidates.push({ tag: "sectPr", idx: nextSectPr })

    if (candidates.length === 0) break

    candidates.sort((a, b) => a.idx - b.idx)
    const candidate = candidates[0]

    // Check this is actually a tag (not inside a string etc.)
    const tagStart = candidate.idx

    // Verify it's a proper tag
    const afterTag = bodyContent.substring(tagStart)
    let closeTag: string
    let endOffset: number

    if (candidate.tag === "p") {
      // Check for self-closing <w:p/>
      const selfClose = afterTag.match(/^<w:p\b[^>]*\/>/)
      if (selfClose) {
        endOffset = tagStart + selfClose[0].length
      } else {
        // Find matching </w:p>
        const closeIdx = findMatchingClose(bodyContent, tagStart, "w:p")
        if (closeIdx === -1) {
          pos = tagStart + 1
          continue
        }
        endOffset = closeIdx
      }
    } else if (candidate.tag === "tbl") {
      const closeIdx = findMatchingClose(bodyContent, tagStart, "w:tbl")
      if (closeIdx === -1) {
        pos = tagStart + 1
        continue
      }
      endOffset = closeIdx
    } else {
      // sectPr
      const closeIdx = findMatchingClose(bodyContent, tagStart, "w:sectPr")
      if (closeIdx === -1) {
        const selfClose = afterTag.match(/^<w:sectPr\b[^>]*\/>/)
        if (selfClose) {
          endOffset = tagStart + selfClose[0].length
        } else {
          pos = tagStart + 1
          continue
        }
      } else {
        endOffset = closeIdx
      }
    }

    elements.push({ tag: candidate.tag, start: tagStart, end: endOffset })
    pos = endOffset
  }

  return elements
}

/**
 * Find the end position of the matching close tag, handling nesting.
 */
function findMatchingClose(xml: string, openStart: number, tagName: string): number {
  const closePattern = `</${tagName}>`
  const closeLen = closePattern.length

  let depth = 0
  let pos = openStart

  // Skip the opening tag
  const firstClose = xml.indexOf(">", pos)
  if (firstClose === -1) return -1
  pos = firstClose + 1
  depth = 1

  while (depth > 0 && pos < xml.length) {
    const nextOpen = findNextTagStart(xml, `<${tagName}`, pos)
    const nextClose = xml.indexOf(closePattern, pos)

    if (nextClose === -1) return -1

    if (nextOpen !== -1 && nextOpen < nextClose) {
      // Check if it's a self-closing tag
      const tagEnd = xml.indexOf(">", nextOpen)
      if (tagEnd !== -1 && xml[tagEnd - 1] === "/") {
        // Self-closing, don't increase depth
        pos = tagEnd + 1
      } else {
        depth++
        pos = tagEnd !== -1 ? tagEnd + 1 : nextOpen + 1
      }
    } else {
      depth--
      if (depth === 0) {
        return nextClose + closeLen
      }
      pos = nextClose + closeLen
    }
  }

  return -1
}

// ─── Paragraph Text Extraction ─────────────────────────────────────

/**
 * Extract text from all <w:t> elements in an XML fragment.
 */
export function extractText(xml: string): string {
  // Text inside DrawingML/VML objects belongs to the visual object (for example,
  // labels in a block diagram), not to the surrounding Word paragraph. Keeping
  // it here also risks leaking the object's OOXML into downstream plain text.
  const textXml = xml
    .replace(/<w:drawing\b[\s\S]*?<\/w:drawing>/gi, "")
    .replace(/<w:pict\b[\s\S]*?<\/w:pict>/gi, "")
    .replace(/<w:object\b[\s\S]*?<\/w:object>/gi, "")
  const texts: string[] = []
  const regex = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g
  let m: RegExpExecArray | null
  while ((m = regex.exec(textXml)) !== null) {
    texts.push(m[1])
  }
  return texts.join("")
}

/**
 * Compare two heading labels numerically.
 * Returns negative if a < b, 0 if equal, positive if a > b.
 */
export function compareHeadingLabels(a: string, b: string): number {
  const aParts = a.replace(/[^\d.]/g, "").split(".").filter(Boolean)
  const bParts = b.replace(/[^\d.]/g, "").split(".").filter(Boolean)

  const len = Math.min(aParts.length, bParts.length)
  for (let i = 0; i < len; i++) {
    const ai = parseInt(aParts[i], 10)
    const bi = parseInt(bParts[i], 10)
    if (ai !== bi) return ai - bi
  }
  return aParts.length - bParts.length
}
