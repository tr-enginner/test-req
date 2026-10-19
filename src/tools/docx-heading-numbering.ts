import { sanitizePossibleWordXmlText } from "./word-xml-sanitize"
import { resolveHeadings } from "./docx-heading-resolver"

const mammoth = require("mammoth") as typeof import("mammoth") & {
  convertToMarkdown(
    input: { path: string } | { buffer: Buffer },
    options?: {
      styleMap?: string[]
      transformDocument?: (element: unknown) => unknown
    },
  ): Promise<{ value: string; messages: unknown[] }>
  transforms: {
    paragraph(transformParagraph: (paragraph: any) => any): (element: unknown) => unknown
  }
}

const mammothDocuments = require("mammoth/lib/documents") as {
  Run(children: unknown[], properties?: Record<string, unknown>): unknown
  Text(value: string): unknown
}
const mammothUnzip = require("mammoth/lib/unzip") as {
  openZip(input: { path: string } | { buffer: Buffer }): Promise<{
    exists(name: string): boolean
    read(name: string, encoding?: string): Promise<string | Uint8Array>
  }>
}
const mammothDocxReader = require("mammoth/lib/docx/docx-reader") as {
  _findPartPaths(docxFile: unknown): Promise<{
    mainDocument: string
    numbering: string
    styles: string
  }>
}
const mammothOfficeXmlReader = require("mammoth/lib/docx/office-xml-reader") as {
  readXmlFromZipFile(docxFile: unknown, path: string): Promise<MammothXmlElement | null>
}
const mammothStylesReader = require("mammoth/lib/docx/styles-reader") as {
  readStylesXml(root: MammothXmlElement): MammothStyles
  defaultStyles: MammothStyles
}

export const DOCX_STYLE_MAP = [
  "p[style-name='Title'] => h1:fresh",
  "p[style-name='\u6807\u9898'] => h1:fresh",
  "p[style-name='\u6807\u98981'] => h1:fresh",
  "p[style-name='\u6807\u9898 1'] => h1:fresh",
  "p[style-name='Subtitle'] => h2:fresh",
  "p[style-name='\u526f\u6807\u9898'] => h2:fresh",
  "p[style-name='\u6807\u98982'] => h2:fresh",
  "p[style-name='\u6807\u9898 2'] => h2:fresh",
  "p[style-name='\u6807\u98983'] => h3:fresh",
  "p[style-name='\u6807\u9898 3'] => h3:fresh",
  "p[style-name='\u6807\u98984'] => h4:fresh",
  "p[style-name='\u6807\u9898 4'] => h4:fresh",
  "p[style-name='\u6807\u98985'] => h5:fresh",
  "p[style-name='\u6807\u9898 5'] => h5:fresh",
  "p[style-name='\u6807\u98986'] => h6:fresh",
  "p[style-name='\u6807\u9898 6'] => h6:fresh",
  "p[style-name='\u6807\u98987'] => h6:fresh",
  "p[style-name='\u6807\u9898 7'] => h6:fresh",
  "p[style-name='\u6807\u98988'] => h6:fresh",
  "p[style-name='\u6807\u9898 8'] => h6:fresh",
  "p[style-name='\u6807\u98989'] => h6:fresh",
  "p[style-name='\u6807\u9898 9'] => h6:fresh",
  "p[style-name='Heading 1'] => h1:fresh",
  "p[style-name='Heading 2'] => h2:fresh",
  "p[style-name='Heading 3'] => h3:fresh",
  "p[style-name='Heading 4'] => h4:fresh",
  "p[style-name='Heading 5'] => h5:fresh",
  "p[style-name='Heading 6'] => h6:fresh",
  "p[style-name='Heading 7'] => h6:fresh",
  "p[style-name='Heading 8'] => h6:fresh",
  "p[style-name='Heading 9'] => h6:fresh",
  "p[style-name='Matrix Heading 1'] => h1:fresh",
  "p[style-name='Matrix Heading 2'] => h2:fresh",
  "p[style-name='Matrix Heading 3'] => h3:fresh",
  "p[style-name='Matrix Heading 4'] => h4:fresh",
  "p[style-name='Matrix Heading 5'] => h5:fresh",
  "p[style-name='Matrix Heading 6'] => h6:fresh",
  "p[style-name='Matrix Heading 7'] => h6:fresh",
  "p[style-name='Matrix Heading 8'] => h6:fresh",
  "p[style-name='Matrix Heading 9'] => h6:fresh",
] as const

interface MammothXmlElement {
  type?: string
  name?: string
  attributes: Record<string, string | undefined>
  children: Array<MammothXmlElement | MammothXmlText>
  first(name: string): MammothXmlElement | null
  firstOrEmpty(name: string): MammothXmlElement
  getElementsByTagName(name: string): MammothXmlElement[]
  text(): string
}

interface MammothXmlText {
  type: "text"
  value: string
}

interface MammothStyles {
  findParagraphStyleById(styleId: string): { name?: string | null } | undefined
  findNumberingStyleById(styleId: string): { numId?: string | null } | undefined
}

interface MammothParagraphLike {
  styleId?: string | null
  styleName?: string | null
  numbering?: {
    isOrdered?: boolean
    level?: string | number | null
    paragraphStyleId?: string | null
  } | null
  children?: unknown[]
}

interface NumberingLevelDef {
  level: number
  start: number
  numFmt: string
  lvlText: string
  paragraphStyleId: string | null
}

interface AbstractNumberingDef {
  abstractNumId: string
  numStyleLink: string | null
  levels: Map<number, NumberingLevelDef>
}

interface NumberingTarget {
  sequenceKey: string
  level: number
  levels: Map<number, NumberingLevelDef>
}

const HEADING_STYLE_PATTERNS: Array<{ pattern: RegExp; level: number }> = [
  { pattern: /^title$/i, level: 1 },
  { pattern: /^\u6807\u9898$/u, level: 1 },
  { pattern: /^\u6807\u9898\s*1$/u, level: 1 },
  { pattern: /^subtitle$/i, level: 2 },
  { pattern: /^\u526f\u6807\u9898$/u, level: 2 },
  { pattern: /^\u6807\u9898\s*2$/u, level: 2 },
  { pattern: /^\u6807\u9898\s*3$/u, level: 3 },
  { pattern: /^\u6807\u9898\s*4$/u, level: 4 },
  { pattern: /^heading\s*1$/i, level: 1 },
  { pattern: /^heading\s*2$/i, level: 2 },
  { pattern: /^heading\s*3$/i, level: 3 },
  { pattern: /^heading\s*4$/i, level: 4 },
  { pattern: /^matrix\s*heading\s*1$/i, level: 1 },
  { pattern: /^matrix\s*heading\s*2$/i, level: 2 },
  { pattern: /^matrix\s*heading\s*3$/i, level: 3 },
  { pattern: /^matrix\s*heading\s*4$/i, level: 4 },
  { pattern: /^matrixheading\s*1$/i, level: 1 },
  { pattern: /^matrixheading\s*2$/i, level: 2 },
  { pattern: /^matrixheading\s*3$/i, level: 3 },
  { pattern: /^matrixheading\s*4$/i, level: 4 },
  { pattern: /^\u6807\u9898\s*5$/u, level: 5 },
  { pattern: /^\u6807\u9898\s*6$/u, level: 6 },
  { pattern: /^\u6807\u9898\s*7$/u, level: 7 },
  { pattern: /^\u6807\u9898\s*8$/u, level: 8 },
  { pattern: /^\u6807\u9898\s*9$/u, level: 9 },
  { pattern: /^heading\s*5$/i, level: 5 },
  { pattern: /^heading\s*6$/i, level: 6 },
  { pattern: /^heading\s*7$/i, level: 7 },
  { pattern: /^heading\s*8$/i, level: 8 },
  { pattern: /^heading\s*9$/i, level: 9 },
  { pattern: /^matrix\s*heading\s*5$/i, level: 5 },
  { pattern: /^matrix\s*heading\s*6$/i, level: 6 },
  { pattern: /^matrix\s*heading\s*7$/i, level: 7 },
  { pattern: /^matrix\s*heading\s*8$/i, level: 8 },
  { pattern: /^matrix\s*heading\s*9$/i, level: 9 },
  { pattern: /^matrixheading\s*5$/i, level: 5 },
  { pattern: /^matrixheading\s*6$/i, level: 6 },
  { pattern: /^matrixheading\s*7$/i, level: 7 },
  { pattern: /^matrixheading\s*8$/i, level: 8 },
  { pattern: /^matrixheading\s*9$/i, level: 9 },
]

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function attrOf(element: MammothXmlElement | null | undefined, name: string): string {
  return textOf(element?.attributes?.[name])
}

function normalizeStyleKey(value: string | null | undefined): string {
  return textOf(value)
    .replace(/[-_]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function headingLevelFromStyle(styleId: string | null | undefined, styleName: string | null | undefined): number | null {
  const candidates = [normalizeStyleKey(styleName), normalizeStyleKey(styleId)]
  for (const candidate of candidates) {
    if (!candidate) continue
    for (const { pattern, level } of HEADING_STYLE_PATTERNS) {
      if (pattern.test(candidate)) return level
    }
  }
  return null
}

function parseInteger(value: string, fallback: number): number {
  return /^\d+$/.test(value) ? Number.parseInt(value, 10) : fallback
}

function parseNumberingLevels(numberingRoot: MammothXmlElement | null) {
  const abstractNums = new Map<string, AbstractNumberingDef>()
  const nums = new Map<string, { abstractNumId: string }>()

  if (!numberingRoot) {
    return { abstractNums, nums }
  }

  for (const abstractNumElement of numberingRoot.getElementsByTagName("w:abstractNum")) {
    const abstractNumId = attrOf(abstractNumElement, "w:abstractNumId")
    if (!abstractNumId) continue

    const levels = new Map<number, NumberingLevelDef>()
    let levelWithoutIndex: NumberingLevelDef | null = null

    for (const levelElement of abstractNumElement.getElementsByTagName("w:lvl")) {
      const rawLevel = attrOf(levelElement, "w:ilvl")
      const parsedLevel = rawLevel ? parseInteger(rawLevel, 0) : 0
      const levelDef: NumberingLevelDef = {
        level: parsedLevel,
        start: parseInteger(attrOf(levelElement.first("w:start"), "w:val"), 1),
        numFmt: attrOf(levelElement.first("w:numFmt"), "w:val") || "decimal",
        lvlText: attrOf(levelElement.first("w:lvlText"), "w:val") || `%${parsedLevel + 1}`,
        paragraphStyleId: attrOf(levelElement.first("w:pStyle"), "w:val") || null,
      }

      if (rawLevel) {
        levels.set(parsedLevel, levelDef)
      } else if (!levels.has(0)) {
        levelWithoutIndex = levelDef
      }
    }

    if (levelWithoutIndex && !levels.has(levelWithoutIndex.level)) {
      levels.set(levelWithoutIndex.level, levelWithoutIndex)
    }

    abstractNums.set(abstractNumId, {
      abstractNumId,
      numStyleLink: attrOf(abstractNumElement.first("w:numStyleLink"), "w:val") || null,
      levels,
    })
  }

  for (const numElement of numberingRoot.getElementsByTagName("w:num")) {
    const numId = attrOf(numElement, "w:numId")
    const abstractNumId = attrOf(numElement.first("w:abstractNumId"), "w:val")
    if (!numId || !abstractNumId) continue
    nums.set(numId, { abstractNumId })
  }

  return { abstractNums, nums }
}

function createNumberingResolver(numberingRoot: MammothXmlElement | null, styles: MammothStyles) {
  const { abstractNums, nums } = parseNumberingLevels(numberingRoot)
  const resolvedLevelCache = new Map<string, Map<number, NumberingLevelDef> | null>()
  const styleTargets = new Map<string, NumberingTarget>()

  const resolveLevelsForAbstractNum = (
    abstractNumId: string,
    seen = new Set<string>(),
  ): Map<number, NumberingLevelDef> | null => {
    if (resolvedLevelCache.has(abstractNumId)) {
      return resolvedLevelCache.get(abstractNumId) || null
    }
    if (seen.has(abstractNumId)) return null
    seen.add(abstractNumId)

    const abstractNum = abstractNums.get(abstractNumId)
    if (!abstractNum) {
      resolvedLevelCache.set(abstractNumId, null)
      return null
    }

    if (abstractNum.numStyleLink) {
      const linkedStyle = styles.findNumberingStyleById(abstractNum.numStyleLink)
      const linkedNumId = textOf(linkedStyle?.numId)
      const linkedAbstractNumId = linkedNumId ? nums.get(linkedNumId)?.abstractNumId : undefined
      if (linkedAbstractNumId) {
        const linkedLevels = resolveLevelsForAbstractNum(linkedAbstractNumId, seen)
        resolvedLevelCache.set(abstractNumId, linkedLevels)
        return linkedLevels
      }
    }

    const ownLevels = abstractNum.levels.size > 0 ? abstractNum.levels : null
    resolvedLevelCache.set(abstractNumId, ownLevels)
    return ownLevels
  }

  for (const abstractNum of abstractNums.values()) {
    const resolvedLevels = resolveLevelsForAbstractNum(abstractNum.abstractNumId)
    if (!resolvedLevels) continue
    for (const levelDef of abstractNum.levels.values()) {
      if (!levelDef.paragraphStyleId) continue
      styleTargets.set(levelDef.paragraphStyleId, {
        sequenceKey: `abstract:${abstractNum.abstractNumId}`,
        level: levelDef.level,
        levels: resolvedLevels,
      })
    }
  }

  const resolveExplicitNum = (numId: string, levelHint: number): NumberingTarget | null => {
    const num = nums.get(numId)
    if (!num) return null
    const levels = resolveLevelsForAbstractNum(num.abstractNumId)
    if (!levels) return null
    const fallbackLevel = levels.has(0) ? 0 : Math.min(...Array.from(levels.keys()))
    return {
      sequenceKey: `num:${numId}`,
      level: levels.has(levelHint) ? levelHint : fallbackLevel,
      levels,
    }
  }

  const resolveForParagraph = (paragraph: MammothParagraphLike): NumberingTarget | null => {
    const paragraphStyleId = textOf(paragraph.numbering?.paragraphStyleId)
    const styleId = textOf(paragraph.styleId)
    const candidateStyleIds = [paragraphStyleId, styleId].filter(Boolean)
    const levelHint = parseInteger(textOf(paragraph.numbering?.level), 0)

    for (const candidateStyleId of candidateStyleIds) {
      const target = styleTargets.get(candidateStyleId)
      if (!target) continue
      const resolvedLevel = target.levels.has(levelHint) ? levelHint : target.level
      return {
        sequenceKey: target.sequenceKey,
        level: resolvedLevel,
        levels: target.levels,
      }
    }

    // Fallback for ordered paragraphs that may rely on explicit numId in XML but
    // still expose a style-linked numbering level through Mammoth.
    if (paragraph.numbering?.isOrdered && styleId) {
      for (const num of nums.values()) {
        const levels = resolveLevelsForAbstractNum(num.abstractNumId)
        if (!levels) continue
        const levelDef = levels.get(levelHint)
        if (!levelDef || levelDef.paragraphStyleId !== styleId) continue
        return {
          sequenceKey: `abstract:${num.abstractNumId}`,
          level: levelHint,
          levels,
        }
      }
    }

    return null
  }

  return {
    resolveForParagraph,
    hasTargets: styleTargets.size > 0,
  }
}

function formatAlphabetic(value: number, uppercase: boolean): string {
  if (value <= 0) return String(value)
  let remaining = value
  let result = ""
  while (remaining > 0) {
    remaining -= 1
    result = String.fromCharCode((remaining % 26) + (uppercase ? 65 : 97)) + result
    remaining = Math.floor(remaining / 26)
  }
  return result
}

function formatRoman(value: number, uppercase: boolean): string {
  if (value <= 0) return String(value)
  const numerals: Array<[number, string]> = [
    [1000, "M"],
    [900, "CM"],
    [500, "D"],
    [400, "CD"],
    [100, "C"],
    [90, "XC"],
    [50, "L"],
    [40, "XL"],
    [10, "X"],
    [9, "IX"],
    [5, "V"],
    [4, "IV"],
    [1, "I"],
  ]
  let remaining = value
  let result = ""
  for (const [threshold, numeral] of numerals) {
    while (remaining >= threshold) {
      result += numeral
      remaining -= threshold
    }
  }
  return uppercase ? result : result.toLowerCase()
}

function formatNumberValue(numFmt: string, value: number): string {
  switch (numFmt) {
    case "decimal":
      return String(value)
    case "upperLetter":
      return formatAlphabetic(value, true)
    case "lowerLetter":
      return formatAlphabetic(value, false)
    case "upperRoman":
      return formatRoman(value, true)
    case "lowerRoman":
      return formatRoman(value, false)
    default:
      return String(value)
  }
}

function normalizeRenderedPrefix(prefix: string): string {
  return prefix
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.)\u3001\uFF0E\u3002]+$/u, "")
}

function advanceSequence(target: NumberingTarget, countersBySequence: Map<string, number[]>): string | null {
  const counters = countersBySequence.get(target.sequenceKey) || []
  const levelDef = target.levels.get(target.level)
  if (!levelDef) return null

  for (let i = target.level + 1; i < counters.length; i += 1) {
    counters[i] = 0
  }

  const currentValue = counters[target.level] || 0
  counters[target.level] = currentValue > 0 ? currentValue + 1 : Math.max(1, levelDef.start)

  for (let i = 0; i < target.level; i += 1) {
    if (!counters[i]) {
      counters[i] = Math.max(1, target.levels.get(i)?.start || 1)
    }
  }

  countersBySequence.set(target.sequenceKey, counters)

  const rendered = levelDef.lvlText.replace(/%(\d+)/g, (_match, rawIndex) => {
    const referencedLevel = Math.max(0, Number.parseInt(rawIndex, 10) - 1)
    const referencedDef = target.levels.get(referencedLevel)
    const currentCounter = counters[referencedLevel] || referencedDef?.start || 1
    return formatNumberValue(referencedDef?.numFmt || "decimal", currentCounter)
  })

  const normalized = normalizeRenderedPrefix(rendered)
  return normalized || null
}

function collectPlainText(node: any): string {
  if (!node || typeof node !== "object") return ""
  if (node.type === "text" && typeof node.value === "string") {
    return node.value
  }
  const children: unknown[] = Array.isArray(node.children) ? node.children : []
  return children.map((child: unknown) => collectPlainText(child)).join("")
}

function normalizeHeadingTextForMatch(value: string): string {
  return value
    .replace(/^\s*(?:\d+(?:\.\d+)*|[A-Za-z](?:\.\d+)*)\s*[.)\u3001\uFF0E\u3002]?\s+/u, "")
    .replace(/[.:：;；,，\u3001\uFF0E\u3002]+\s*$/u, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase()
}

function findMatchingResolvedHeading(
  resolvedHeadings: ReturnType<typeof resolveHeadings>,
  startIndex: number,
  paragraphText: string,
  paragraphLevel: number,
): { heading: ReturnType<typeof resolveHeadings>[number]; nextIndex: number } | null {
  const normalizedParagraphText = normalizeHeadingTextForMatch(paragraphText)
  if (!normalizedParagraphText) return null

  for (let index = Math.max(0, startIndex); index < resolvedHeadings.length; index += 1) {
    const heading = resolvedHeadings[index]
    if (heading.level !== paragraphLevel) continue
    if (normalizeHeadingTextForMatch(heading.title) !== normalizedParagraphText) continue
    return { heading, nextIndex: index + 1 }
  }

  // Mammoth and raw OOXML can disagree on a custom heading's level (notably
  // WPS/Word templates with outlineLvl plus a custom paragraph style). The
  // heading identity is still stable by normalized text and document order, so
  // use the nearest forward exact-title match rather than dropping its label.
  // Dropping it makes parseSegments create a SEG-* node and detaches its children.
  const lookaheadEnd = Math.min(resolvedHeadings.length, Math.max(0, startIndex) + 24)
  for (let index = Math.max(0, startIndex); index < lookaheadEnd; index += 1) {
    const heading = resolvedHeadings[index]
    if (normalizeHeadingTextForMatch(heading.title) !== normalizedParagraphText) continue
    return { heading, nextIndex: index + 1 }
  }

  return null
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function paragraphAlreadyStartsWithPrefix(paragraph: any, prefix: string): boolean {
  const plainText = collectPlainText(paragraph).replace(/\s+/g, " ").trim()
  if (!plainText) return false
  if (/^[A-Za-z]$/u.test(prefix)) {
    const annexMatch = plainText.match(
      /^(?:\d+(?:\.\d+)*[.\uFF0E\u3002]?\s*)?(?:\u9644\u4ef6|\u9644\u5f55)\s*([A-Za-z])(?:\s|$)/u,
    )
    if (annexMatch?.[1].toUpperCase() === prefix.toUpperCase()) return true
  }
  // A manually materialized Word/WPS heading may contain the numbering
  // separator in the text itself ("5.2.4.3. Title"). It already carries the
  // resolved label and must not be prefixed a second time.
  return new RegExp(
    `^${escapeRegex(prefix)}(?:[.\\uFF0E\\u3002\\u3001)]?(?:\\s|$)|(?=[A-Za-z\\u4e00-\\u9fff（(]))`,
    "u",
  ).test(plainText)
}

function prependPrefixToParagraph(paragraph: any, prefix: string): any {
  if (!prefix || paragraphAlreadyStartsWithPrefix(paragraph, prefix)) return paragraph
  const children = Array.isArray(paragraph.children) ? paragraph.children : []
  return {
    ...paragraph,
    children: [
      mammothDocuments.Run([mammothDocuments.Text(`${prefix} `)], {}),
      ...children,
    ],
  }
}

async function readDocxNumberingResolver(filePath: string): Promise<ReturnType<typeof createNumberingResolver>> {
  const docxFile = await mammothUnzip.openZip({ path: filePath })
  const partPaths = await mammothDocxReader._findPartPaths(docxFile)
  const [numberingRoot, stylesRoot] = await Promise.all([
    mammothOfficeXmlReader.readXmlFromZipFile(docxFile, partPaths.numbering),
    mammothOfficeXmlReader.readXmlFromZipFile(docxFile, partPaths.styles),
  ])

  const styles = stylesRoot ? mammothStylesReader.readStylesXml(stylesRoot) : mammothStylesReader.defaultStyles
  return createNumberingResolver(numberingRoot, styles)
}

export async function extractDocxText(filePath: string): Promise<string> {
  let numberingResolver: ReturnType<typeof createNumberingResolver> | null = null
  try {
    numberingResolver = await readDocxNumberingResolver(filePath)
  } catch {
    numberingResolver = null
  }

  if (!numberingResolver) {
    const mdResult = await mammoth.convertToMarkdown({ path: filePath }, { styleMap: [...DOCX_STYLE_MAP] })
    return sanitizePossibleWordXmlText(mdResult.value)
  }

  let resolvedHeadings: ReturnType<typeof resolveHeadings> = []
  try {
    const docxFile = await mammothUnzip.openZip({ path: filePath })
    const partPaths = await mammothDocxReader._findPartPaths(docxFile)
    const [documentXml, numberingXml, stylesXml] = await Promise.all([
      docxFile.read(partPaths.mainDocument, "utf-8"),
      docxFile.read(partPaths.numbering, "utf-8"),
      docxFile.read(partPaths.styles, "utf-8"),
    ])
    resolvedHeadings = resolveHeadings(String(documentXml || ""), String(numberingXml || ""), String(stylesXml || ""))
  } catch {
    resolvedHeadings = []
  }

  const countersBySequence = new Map<string, number[]>()
  let resolvedHeadingCursor = 0
  const mdResult = await mammoth.convertToMarkdown(
    { path: filePath },
    {
      styleMap: [...DOCX_STYLE_MAP],
      transformDocument: mammoth.transforms.paragraph((paragraph: MammothParagraphLike) => {
        const styleId = textOf(paragraph.styleId)
        const styleName = textOf(paragraph.styleName)
        const headingLevel = headingLevelFromStyle(styleId || null, styleName || null)
        if (!headingLevel) return paragraph

        const matchedHeading = findMatchingResolvedHeading(
          resolvedHeadings,
          resolvedHeadingCursor,
          collectPlainText(paragraph),
          headingLevel,
        )
        // Keep Markdown segmentation and document-structure table assignment on the
        // same canonical OOXML heading labels. Match by heading identity instead of
        // array position because the OOXML and Mammoth heading filters can differ.
        if (matchedHeading?.heading.label) {
          resolvedHeadingCursor = matchedHeading.nextIndex
          return prependPrefixToParagraph(paragraph, matchedHeading.heading.label)
        }

        // When OOXML produced a canonical heading catalog, an unmatched Mammoth
        // heading must not consume or borrow another section's label. Leaving it
        // unchanged lets later headings realign against the same forward cursor.
        if (resolvedHeadings.length > 0) return paragraph

        const target = numberingResolver.resolveForParagraph(paragraph)
        if (!target) return paragraph

        const prefix = advanceSequence(target, countersBySequence)
        if (!prefix) return paragraph
        return prependPrefixToParagraph(paragraph, prefix)
      }),
    },
  )

  return sanitizePossibleWordXmlText(mdResult.value)
}
