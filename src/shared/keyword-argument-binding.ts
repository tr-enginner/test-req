import {
  loadProtocolSemanticDocument,
  type ProtocolSemanticDocument,
  type ProtocolSemanticTable,
} from "./protocol-semantics"
import { actionChannelOfText, stepActionOnPrimaryBus, stepActionOnSecondaryBus } from "./testcase-keywords"
import type { KeywordMeta } from "./testcase-keywords"

export type KeywordArgumentSemantic =
  | "time"
  | "protocol_name"
  | "loop_interval"
  | "bus_channel"
  | "data_id"
  | "expected_value"
  | "file_path"
  | "generic"

export interface KeywordCandidateContext {
  keywordName: string
  description: string
  argumentNames: string[]
  argumentComments: string[]
  txtSnippet: string
}

export interface PlaceholderSuggestion {
  case_index?: number
  step_index: number
  placeholder: string
  value: string
  reason?: string
}

export interface RequirementSemanticContext {
  requirementId?: string
  requirementHandling?: string
  chapterBackground?: string
  chapterTitle?: string
  inputFlow?: string
  outputFlow?: string
  testTypeChinese?: string
}

export interface KeywordBindingResult {
  bindings: Record<string, string>
  semantics: Record<string, KeywordArgumentSemantic>
  warnings: string[]
}

const DEFAULT_PHASE6_TIME_VALUE = "10.8"

function normalizeText(value: string): string {
  return value
    .replace(/[\s\t\r\n]+/g, " ")
    .replace(/[，。；：、,.!?:;()[\]{}<>\-_/\\]+/g, " ")
    .toLowerCase()
    .trim()
}

function compactText(value: string): string {
  return normalizeText(value).replace(/\s+/g, "")
}

function ensureChinesePeriod(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ""
  return /[。！？!?]$/.test(trimmed) ? trimmed : `${trimmed}。`
}

function bigrams(value: string): Set<string> {
  const text = compactText(value)
  if (!text) return new Set<string>()
  if (text.length === 1) return new Set<string>([text])

  const results = new Set<string>()
  for (let index = 0; index < text.length - 1; index += 1) {
    results.add(text.slice(index, index + 2))
  }
  return results
}

function similarityScore(left: string, right: string): number {
  const leftCompact = compactText(left)
  const rightCompact = compactText(right)
  if (!leftCompact || !rightCompact) return 0
  if (leftCompact === rightCompact) return 30
  if (leftCompact.includes(rightCompact) || rightCompact.includes(leftCompact)) return 18

  const leftBigrams = bigrams(left)
  const rightBigrams = bigrams(right)
  let overlap = 0
  for (const gram of leftBigrams) {
    if (rightBigrams.has(gram)) overlap += 1
  }
  return overlap * 2
}

function stripPlaceholders(value: string): string {
  return value.replace(/\$\{[^}]+\}/g, " ")
}

function findHeaderByPatterns(headers: string[], patterns: RegExp[]): string | null {
  let best: { header: string; score: number } | null = null

  for (const header of headers) {
    let score = 0
    for (const pattern of patterns) {
      if (pattern.test(header)) score += 5
    }
    if (score > 0 && (!best || score > best.score)) {
      best = { header, score }
    }
  }

  return best?.header ?? null
}

function extractQuotedPhrases(text: string): string[] {
  const results = new Set<string>()
  const pattern = /[“"'‘’「『](.{1,80}?)[”"'’」』]/g
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text)) !== null) {
    const phrase = String(match[1] ?? "").trim()
    if (phrase) results.add(phrase)
  }

  return [...results]
}

function extractExplicitHexValue(text: string): string | undefined {
  // Exclude negated contexts ("W0不为0x10" describes an INVALID value, not an
  // expected one). Grabbing the first hex anywhere in the corpus and pairing it
  // with an unrelated field produced unfounded reference values.
  const match = text.match(/(?:设置|置|设定|结果|取值|状态|(?<!不|未|非)为)\s*(0x[0-9a-fA-F]+)/)
  return match?.[1]
}

function extractExplicitSeconds(text: string): string | undefined {
  const match = text.match(/(\d+(?:\.\d+)?)\s*秒/)
  return match?.[1]
}

function detectExplicitBuses(text: string): string[] {
  const normalized = text.toUpperCase()
  const hasCana = normalized.includes("CANA")
  const hasCanb = normalized.includes("CANB")
  if (hasCana && hasCanb) return ["CANA", "CANB"]
  if (hasCana) return ["CANA"]
  if (hasCanb) return ["CANB"]
  return []
}

export type ExplicitPrimaryBus = "CANA" | "CANB"

/**
 * 从 requirement 级语料中提取明确要求覆盖的一级 CAN 通道。
 *
 * 注意：这是 requirement/suite 级约束，不是单用例约束。总线收发类
 * 功能需求要求“每条指令 × 每条总线”分案，因此不能对每个独立用例
 * 强制同时出现 CANA/CANB。
 */
export function requiredPrimaryBusesFromRequirementContext(
  context?: RequirementSemanticContext,
): ExplicitPrimaryBus[] {
  return detectExplicitBuses(buildRequirementCorpus(context))
    .filter((bus): bus is ExplicitPrimaryBus => bus === "CANA" || bus === "CANB")
}

function hasLoopIntent(text: string): boolean {
  return /(循环|周期|每.*秒|持续发送|重复发送|轮询)/.test(text)
}

function appendExpectationClause(base: string, clause: string): string {
  const trimmedClause = clause.trim().replace(/[。；]+$/g, "")
  if (!trimmedClause) return ensureChinesePeriod(base)

  const current = base.trim()
  if (!current) return ensureChinesePeriod(trimmedClause)
  if (compactText(current).includes(compactText(trimmedClause))) {
    return ensureChinesePeriod(current)
  }

  const separator = /[。；]$/.test(current) ? "" : "；"
  return ensureChinesePeriod(`${current}${separator}${trimmedClause}`)
}

/**
 * Extract a "遥测字段显式输出验证" expectation clause from the requirement
 * handling text. Pairs each W-field with the value stated in ITS OWN sentence:
 * - explicit "设置为/为 0xXX" (negated forms like "不为0xXX" are excluded by
 *   extractExplicitHexValue)
 * - "加N/递增N" with no stated initial value → assume initial 0, observable N
 *
 * Previously the first hex value anywhere in the handling text (e.g. the
 * "W0不为0x10" validity check) was paired with the first W-field paren (W170),
 * producing an unfounded reference value ("W170设置为0x10").
 */
function extractTelemetryFieldClause(context?: RequirementSemanticContext): string | undefined {
  const handling = context?.requirementHandling ?? ""
  const sentences = handling
    .split(/[。；\n]/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)

  for (const sentence of sentences) {
    const fieldInParens = sentence.match(/（([^）]*W[^）]*)）/)
    const field = String(fieldInParens?.[1] ?? "").trim()
    if (!field) continue

    const explicit = extractExplicitHexValue(sentence)
    if (explicit) return `缓变遥测数据${field}设置为${explicit}`

    const increment = sentence.match(/(?<!增)加\s*(\d+)|递增\s*(\d+)/)
    if (increment) {
      const delta = parseInt(increment[1] ?? increment[2] ?? "0", 10)
      // 需求未说明初始值时假定初值为 0，加 N 后的可观测值为 N
      return `缓变遥测数据${field}为${delta}`
    }
  }

  return undefined
}

function enrichExpectedResult(
  step: { 步骤描述: string; 预期结果: string },
  context?: RequirementSemanticContext,
): { 步骤描述: string; 预期结果: string } {
  let expected = step.预期结果
  const corpus = buildRequirementCorpus(context)
  const buses = detectExplicitBuses(step.步骤描述)
  const bus = buses[0]

  if (bus && /(间接指令应答)/.test(corpus)) {
    expected = appendExpectationClause(expected, `${bus}总线发送间接指令应答数据`)
  }

  // Counter expectation clauses are appended only to steps whose text mentions
  // the counter's field code (e.g. W170). Appending to every step would claim
  // the counter value on steps where no counting event occurs (e.g. 正确→错误
  // →正确 sequences).
  const counterClauses: string[] = []

  // Only when the requirement itself mentions the W2b3~W2b1 bit-slice; the
  // generic 计数加1 pattern would otherwise force this clause onto unrelated
  // counters (e.g. SPI polling counters). "加1" without a stated initial value
  // → assume initial 0, observable value 1.
  if (/(W2b3\W*W2b1)/.test(corpus)) {
    counterClauses.push("缓变遥测数据W2b3~W2b1为1")
  }

  const telemetryClause = extractTelemetryFieldClause(context)
  if (telemetryClause) {
    counterClauses.push(telemetryClause)
  }

  for (const clause of counterClauses) {
    // No trailing word boundary: fields like "W2b7" (bit-slice) must still
    // resolve to field code W2.
    const fieldCode = clause.match(/\bW\d+/)?.[0]
    if (!fieldCode) continue
    const mentionRe = new RegExp(fieldCode, "i")
    const valueRe = new RegExp(`${fieldCode}[^。；\\n]{0,12}(?:为|等于|值为)\\s*\\d+`, "i")
    const descText = compactText(step.步骤描述)
    const expectText = compactText(step.预期结果)
    const mentioned = mentionRe.test(descText) || mentionRe.test(expectText)
    // 已写明可观测值形式的预期结果不再重复追加
    if (mentioned && !valueRe.test(expectText)) {
      expected = appendExpectationClause(expected, clause)
    }
  }

  return {
    ...step,
    预期结果: ensureChinesePeriod(expected),
  }
}

function normalizeSuggestedValue(value: string, semantic: KeywordArgumentSemantic): string {
  const trimmed = value.trim()
  if (!trimmed) return ""

  if (semantic === "time" || semantic === "loop_interval") {
    const matched = trimmed.match(/-?\d+(?:\.\d+)?/)
    return matched?.[0] ?? trimmed
  }

  return trimmed
}

function isValidSuggestion(value: string, semantic: KeywordArgumentSemantic): boolean {
  if (semantic === "loop_interval" && value === "") {
    return true
  }
  if (semantic === "time" || semantic === "loop_interval") {
    return /^-?\d+(?:\.\d+)?$/.test(value)
  }
  return value.length > 0
}

function resolveSuggestionValue(
  suggestions: PlaceholderSuggestion[],
  caseIndex: number,
  stepIndex: number,
  placeholder: string,
  semantic: KeywordArgumentSemantic,
): string | undefined {
  const exact = suggestions.find((item) =>
    (item.case_index === undefined || item.case_index === caseIndex) &&
    item.step_index === stepIndex &&
    item.placeholder === placeholder
  )
  if (!exact) return undefined

  const normalized = normalizeSuggestedValue(exact.value, semantic)
  return isValidSuggestion(normalized, semantic) ? normalized : undefined
}

function buildRequirementCorpus(context?: RequirementSemanticContext): string {
  return [
    context?.requirementId ?? "",
    context?.requirementHandling ?? "",
    context?.chapterBackground ?? "",
    context?.chapterTitle ?? "",
    context?.inputFlow ?? "",
    context?.outputFlow ?? "",
    context?.testTypeChinese ?? "",
  ]
    .filter(Boolean)
    .join("\n")
}

function isFunctionalTestContext(context?: RequirementSemanticContext): boolean {
  return String(context?.testTypeChinese ?? "").trim() === "功能测试"
}

function stepLooksLikeFunctionalOverreach(stepText: string): boolean {
  return /(边界|异常|无效|非法|校验和错误|未收到|不处理|连续接收|连续发送|边界值|最大值|最小值)/.test(stepText)
}

function caseLooksLikeFunctionalOverreach(
  steps: Array<{ 步骤描述: string; 预期结果: string }>,
): string[] {
  const errors: string[] = []

  for (let index = 0; index < steps.length; index += 1) {
    const text = `${steps[index].步骤描述} ${steps[index].预期结果}`
    if (stepLooksLikeFunctionalOverreach(text)) {
      errors.push(
        `step[${index}] 包含边界/异常/无效等扩展场景，当前功能测试默认只允许验证需求明确描述的功能点`,
      )
    }
  }

  return errors
}

function collectNeedles(context?: RequirementSemanticContext): string[] {
  const results = new Set<string>()
  const handling = context?.requirementHandling ?? ""
  const background = context?.chapterBackground ?? ""

  for (const phrase of extractQuotedPhrases(handling)) {
    results.add(phrase)
  }
  for (const phrase of extractQuotedPhrases(background)) {
    results.add(phrase)
  }
  if (handling.trim()) results.add(handling.trim())
  if (context?.inputFlow?.trim()) results.add(context.inputFlow.trim())

  return [...results]
}

function findBestProtocolRow(
  document: ProtocolSemanticDocument | undefined,
  context?: RequirementSemanticContext,
): {
  table: ProtocolSemanticTable
  row: Record<string, string>
  nameKey?: string
  descKey?: string
  codeKey?: string
} | null {
  if (!document) return null

  const needles = collectNeedles(context)
  const inputFlow = context?.inputFlow ?? ""
  let best: {
    score: number
    table: ProtocolSemanticTable
    row: Record<string, string>
    nameKey?: string
    descKey?: string
    codeKey?: string
  } | null = null

  for (const table of document.tables) {
    const nameKey = findHeaderByPatterns(table.headers, [/指令名称/, /协议名称/, /名称/])
    const descKey = findHeaderByPatterns(table.headers, [/说明/, /描述/, /内容/])
    const codeKey = findHeaderByPatterns(table.headers, [/指令码/, /数据标识/, /\bID\b/i])
    const tableBias = similarityScore(`${table.title} ${table.section_title ?? ""}`, inputFlow)

    for (const row of table.rows) {
      const nameValue = nameKey ? row[nameKey] ?? "" : ""
      const descValue = descKey ? row[descKey] ?? "" : ""
      const rowText = Object.values(row).join(" ")
      let score = tableBias

      for (const needle of needles) {
        score += similarityScore(needle, nameValue) * 5
        score += similarityScore(needle, descValue) * 3
        score += similarityScore(needle, rowText)
      }

      if (nameKey) score += 3
      if (descKey) score += 1

      if (!best || score > best.score) {
        best = { score, table, row, nameKey: nameKey ?? undefined, descKey: descKey ?? undefined, codeKey: codeKey ?? undefined }
      }
    }
  }

  return best && best.score > 0 ? best : null
}

function resolveProtocolName(
  protocolSemantic: ProtocolSemanticDocument | undefined,
  context?: RequirementSemanticContext,
): string | undefined {
  const bestRow = findBestProtocolRow(protocolSemantic, context)
  if (bestRow?.nameKey) {
    const value = bestRow.row[bestRow.nameKey]?.trim()
    if (value) return value
  }

  return context?.inputFlow?.trim() || protocolSemantic?.protocol_name
}

function resolveDataId(
  protocolSemantic: ProtocolSemanticDocument | undefined,
  context?: RequirementSemanticContext,
): string | undefined {
  const bestRow = findBestProtocolRow(protocolSemantic, context)
  if (bestRow?.codeKey) {
    const value = bestRow.row[bestRow.codeKey]?.trim()
    if (value) return value
  }

  const corpus = buildRequirementCorpus(context)
  return corpus.match(/\b\d+\b/)?.[0]
}

function resolveExpectedValue(
  protocolSemantic: ProtocolSemanticDocument | undefined,
  context?: RequirementSemanticContext,
): string | undefined {
  const corpus = buildRequirementCorpus(context)
  const explicit = extractExplicitHexValue(corpus)
  if (explicit) return explicit

  const bestRow = findBestProtocolRow(protocolSemantic, context)
  if (bestRow?.descKey) {
    return extractExplicitHexValue(bestRow.row[bestRow.descKey] ?? "")
  }

  return undefined
}

export function serializeKeywordCandidate(keyword: KeywordMeta): KeywordCandidateContext {
  return {
    keywordName: keyword.keywordName,
    description: keyword.description,
    argumentNames: keyword.argumentNames,
    argumentComments: keyword.argumentComments,
    txtSnippet: keyword.txtSnippet,
  }
}

export function inferKeywordArgumentSemantic(
  argumentName: string,
  argumentComment: string,
  keyword?: KeywordCandidateContext,
): KeywordArgumentSemantic {
  const argumentCorpus = normalizeText(`${argumentName} ${argumentComment}`)
  const fullCorpus = normalizeText(`${argumentName} ${argumentComment} ${keyword?.keywordName ?? ""}`)

  if (/(循环|周期|停止发送|间隔|overtime|interval)/.test(argumentCorpus)) return "loop_interval"
  if (/(time|时间|秒)/.test(argumentCorpus)) return "time"
  if (/(协议|报文|protocol)/.test(fullCorpus)) return "protocol_name"
  if (/(指令码|数据标识|\bid\b)/.test(fullCorpus)) return "data_id"
  if (/(期望|预期|结果|状态|value)/.test(fullCorpus)) return "expected_value"
  if (/(总线|通道|bus|channel)/.test(fullCorpus)) return "bus_channel"
  if (/(文件|路径|file|path)/.test(fullCorpus)) return "file_path"
  return "generic"
}

/**
 * Comments 值映射 DSL 解析:"[0:;其他:以${para3}S为周期;]" 表示值为 0 时
 * 渲染为空、其他值渲染为"以NS为周期"。用户拍板(2026-08-21):步骤描述
 * step_desc 中的参数占位替换必须遵循 Comments 的值语义——如循环时间
 * ${para3}=0 意为不循环,占位处应渲染为空,而不是把字面值"0"写进文案
 * (曾产出"通过CANA总线0发送…"的错误描述)。无映射规格的参数照常平铺代值。
 */
export function applyCommentValueMapping(
  value: string,
  comment: string | undefined,
  bindings: Record<string, string>,
): string {
  if (!comment) return value
  const spec = comment.match(/\[([^\]]*)\]/)
  if (!spec) return value
  let matched: string | null = null
  let fallback: string | null = null
  for (const segment of spec[1]!.split(";")) {
    const trimmed = segment.trim()
    if (!trimmed) continue
    const separator = trimmed.indexOf(":")
    if (separator < 0) continue
    const key = trimmed.slice(0, separator).trim()
    const replacement = trimmed.slice(separator + 1)
    if (key === "其他") {
      fallback = replacement
      continue
    }
    const keyNumber = Number(key)
    const valueNumber = Number(value)
    const hit = key === value
      || (key !== "" && value !== "" && Number.isFinite(keyNumber) && Number.isFinite(valueNumber) && keyNumber === valueNumber)
    if (hit) {
      matched = replacement
      break
    }
  }
  const replacement = matched !== null ? matched : fallback
  if (replacement === null) return value
  // 映射文案内的占位(如"以${para3}S为周期")用同一绑定集代值;缺绑定时退化为原值
  return replacement.replace(/\$\{[^}]+\}/g, (placeholder) => bindings[placeholder] ?? value)
}

/** argumentNames/argumentComments 平行数组 → 占位符→Comments 映射(渲染时代值用)。 */
export function buildCommentMap(meta: {
  argumentNames: string[]
  argumentComments: string[]
}): Record<string, string> {
  const map: Record<string, string> = {}
  meta.argumentNames.forEach((name, index) => {
    const comment = meta.argumentComments[index]
    if (name && typeof comment === "string" && comment) map[name] = comment
  })
  return map
}

export function renderDocumentationTemplate(
  template: string,
  bindings: Record<string, string>,
  commentsByPlaceholder?: Record<string, string>,
): { text: string; unresolved: string[] } {
  const unresolved: string[] = []
  const text = template.replace(/\$\{[^}]+\}/g, (placeholder) => {
    if (!(placeholder in bindings)) {
      unresolved.push(placeholder)
      return placeholder
    }
    const value = bindings[placeholder] ?? ""
    return applyCommentValueMapping(value, commentsByPlaceholder?.[placeholder], bindings)
  })
  return { text, unresolved }
}

export function findBestKeywordCandidateForStep(
  stepDesc: string,
  keywordCandidates: KeywordCandidateContext[],
  requirementContext?: RequirementSemanticContext,
): KeywordCandidateContext | null {
  const stepNormalized = normalizeText(stripPlaceholders(stepDesc))
  if (!stepNormalized) return null
  const contextCorpus = buildRequirementCorpus(requirementContext)
  const searchCorpus = `${stepDesc}\n${contextCorpus}`
  const normalizedSearchCorpus = normalizeText(stripPlaceholders(searchCorpus))

  // 步骤动作的 CAN 层级(硬约束判定,函数级——map 内打分与排序后过滤共用)。
  // 只看步骤描述的动作从句(首个发送动词之前):全语料判定曾把
  // "通过CANA总线发送X,触发软件通过二级CAN总线转发Y"的一级触发步骤判为
  // 二级,错配二级关键字(2026-08-26 取证);需求上下文提及二级也不代表本步骤在二级。
  // 层级规则双向:动作在一级(从句点名 CANA/CANB)时二级候选反向让位——
  // 触发步骤的结果从句密集出现"二级CAN",二级关键字文本重叠分天然压过一级
  const stepMentionsSecondary = stepActionOnSecondaryBus(stepDesc)
  const stepActionPrimary = stepActionOnPrimaryBus(stepDesc)
  // SPI 通道硬约束(2026-08-31 审计):动作从句点名 SPI 且是发送动作时,
  // 绑定候选必须是 SPI 关键字——此前绑定层只有 CAN 层级约束,SPI 步骤可被
  // 内存关键字的参数注释("站地址XXH"→起始地址)反超绑定
  const stepActionSpi = actionChannelOfText(stepDesc) === "SPI"
  const ranked = keywordCandidates
    .map((candidate) => {
      const descriptionScore = similarityScore(stepNormalized, stripPlaceholders(candidate.description))
      const nameScore = similarityScore(stepNormalized, candidate.keywordName)
      const candidateCorpus = normalizeText([
        candidate.keywordName,
        candidate.description,
        candidate.argumentComments.join(" "),
      ].join(" "))

      const hasCan = /(cana|canb|can|总线)/.test(normalizedSearchCorpus)
      const hasCana = /cana/.test(normalizedSearchCorpus)
      const hasCanb = /canb/.test(normalizedSearchCorpus)
      const hasSend = /(发送|下发|注入|send)/.test(normalizedSearchCorpus)
      const hasIndirectInstruction = /(间接指令|间接数据指令)/.test(normalizedSearchCorpus)
      const hasMemoryIntent = /(内存|寄存器|8bit|16bit|32bit|bit|数据区)/.test(normalizedSearchCorpus)

      const candidateHasCan = /(cana|canb|can|总线)/.test(candidateCorpus)
      const candidateHasCana = /cana/.test(candidateCorpus)
      const candidateHasCanb = /canb/.test(candidateCorpus)
      // \b 词边界:组件调用名(VTest_SendCmd)不是发送语义(与打分层同规则)
      const candidateHasSend = /(发送|\bsend\b)/.test(candidateCorpus)
      const candidateHasMemoryIntent = /(内存|寄存器|8bit|16bit|32bit|bit|数据区)/.test(candidateCorpus)

      let score = descriptionScore * 2 + nameScore

      // CAN 层级对齐(动作从句判定,双向):动作在二级→二级 +40/一级 -40
      // (曾因"二级CANA"含字面 CANA,一级候选拿满总线分压过二级,
      // 2026-08-25 用户取证);动作在一级→二级 -40(结果从句的"二级CAN"
      // 文本重叠曾把一级触发步骤顶成二级,2026-08-26 取证)
      const candidateSecondary = /二级\s*(?:can)?总线|二级can/i.test(candidateCorpus)
      if (stepMentionsSecondary) score += candidateSecondary ? 40 : -40
      else if (stepActionPrimary && candidateSecondary) score -= 40

      if (hasCan && hasSend && candidateHasCan && candidateHasSend) score += 36
      if (hasIndirectInstruction && candidateHasCan && candidateHasSend) score += 18
      if (hasCana && candidateHasCana) score += 20
      if (hasCanb && candidateHasCanb) score += 20
      if (hasCan && !hasCana && !hasCanb && (candidateHasCana || candidateHasCanb)) score += 10
      if (!hasMemoryIntent && candidateHasMemoryIntent) score -= 24

      return { candidate, score }
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)

  // CAN 层级硬约束(动作从句,双向):与 scoreKeywordCandidatesWeighted 保持
  // 一致——动作在二级且存在二级候选时一级让位;动作在一级且存在一级候选时
  // 二级让位。SPI 通道约束优先于 CAN 层级(SPI 与 CAN 是不同总线族)
  const candidateIsSecondary = (item: { candidate: KeywordCandidateContext }) =>
    /二级\s*(?:can)?总线|二级can/i.test(normalizeText([
      item.candidate.keywordName,
      item.candidate.description,
      item.candidate.argumentComments.join(" "),
    ].join(" ")))
  const candidateIsSpi = (item: { candidate: KeywordCandidateContext }) =>
    /spi/i.test(normalizeText([
      item.candidate.keywordName,
      item.candidate.description,
      item.candidate.argumentComments.join(" "),
    ].join(" ")))
  if (stepActionSpi) {
    const spiOnly = ranked.filter((item) => candidateIsSpi(item))
    if (spiOnly.length > 0) return spiOnly[0]!.candidate
  } else if (stepMentionsSecondary) {
    const secondaryOnly = ranked.filter((item) => candidateIsSecondary(item))
    if (secondaryOnly.length > 0) return secondaryOnly[0]!.candidate
  } else if (stepActionPrimary) {
    const primaryOnly = ranked.filter((item) => !candidateIsSecondary(item))
    if (primaryOnly.length > 0) return primaryOnly[0]!.candidate
  }

  return ranked[0]?.candidate ?? null
}

function shouldForceDocumentationTemplate(
  rawDesc: string,
  keywordCandidate: KeywordCandidateContext,
): boolean {
  const normalizedDesc = normalizeText(stripPlaceholders(rawDesc))
  const normalizedKeywordName = normalizeText(keywordCandidate.keywordName)
  const normalizedKeywordDescription = normalizeText(stripPlaceholders(keywordCandidate.description))

  if (!normalizedDesc || !normalizedKeywordDescription) return false
  // Only force template replacement when the step explicitly uses keyword
  // references (placeholders or exact keyword names), NOT when it is already
  // natural language that merely happens to resemble a keyword description.
  if (rawDesc.includes("${")) return true
  if (normalizedDesc === normalizedKeywordName) return true
  if (normalizedDesc === normalizedKeywordDescription) return true

  return false
}

export function bindKeywordArgsFromSemantics(
  keyword: KeywordCandidateContext,
  options: {
    protocolSemantic?: ProtocolSemanticDocument
    requirementContext?: RequirementSemanticContext
    placeholderSuggestions?: PlaceholderSuggestion[]
    caseIndex?: number
    stepIndex?: number
    template?: string
    sourceStepText?: string
  },
): KeywordBindingResult {
  const bindings: Record<string, string> = {}
  const semantics: Record<string, KeywordArgumentSemantic> = {}
  const warnings: string[] = []
  const template = options.template ?? keyword.description
  const placeholdersInTemplate = new Set(template.match(/\$\{[^}]+\}/g) ?? [])
  const requirementCorpus = buildRequirementCorpus(options.requirementContext)

  for (let index = 0; index < keyword.argumentNames.length; index += 1) {
    const argName = keyword.argumentNames[index] ?? ""
    if (!placeholdersInTemplate.has(argName)) continue

    const argComment = keyword.argumentComments[index] ?? ""
    const semantic = inferKeywordArgumentSemantic(argName, argComment, keyword)
    semantics[argName] = semantic

    const suggestionValue = resolveSuggestionValue(
      options.placeholderSuggestions ?? [],
      options.caseIndex ?? 0,
      options.stepIndex ?? 0,
      argName,
      semantic,
    )
    if (suggestionValue !== undefined) {
      bindings[argName] = suggestionValue
      continue
    }

    if (semantic === "protocol_name") {
      const resolved = resolveProtocolName(options.protocolSemantic, options.requirementContext)
      if (resolved) {
        bindings[argName] = resolved
        continue
      }
    }

    if (semantic === "loop_interval") {
      if (!hasLoopIntent(requirementCorpus)) {
        bindings[argName] = ""
        continue
      }
      const explicitSeconds = extractExplicitSeconds(requirementCorpus)
      if (explicitSeconds) {
        bindings[argName] = explicitSeconds
        continue
      }
    }

    if (semantic === "data_id") {
      const resolved = resolveDataId(options.protocolSemantic, options.requirementContext)
      if (resolved) {
        bindings[argName] = resolved
        continue
      }
    }

    if (semantic === "expected_value") {
      const resolved = resolveExpectedValue(options.protocolSemantic, options.requirementContext)
      if (resolved) {
        bindings[argName] = resolved
        continue
      }
    }

    if (semantic === "time") {
      const explicitSeconds = extractExplicitSeconds(requirementCorpus)
      if (explicitSeconds) {
        bindings[argName] = explicitSeconds
        continue
      }
      bindings[argName] = DEFAULT_PHASE6_TIME_VALUE
      warnings.push(
        `关键字 ${keyword.keywordName} 的参数 ${argName} 缺少 worker 建议值，已使用默认时间值 ${DEFAULT_PHASE6_TIME_VALUE}`,
      )
      continue
    }

    if (semantic === "bus_channel") {
      const buses = detectExplicitBuses([options.sourceStepText ?? "", requirementCorpus].join("\n"))
      if (buses.length === 1) {
        bindings[argName] = buses[0]
        continue
      }
    }

    warnings.push(`关键字 ${keyword.keywordName} 的参数 ${argName} 未能从需求语义中解析到具体值`)
  }

  return { bindings, semantics, warnings }
}

function validateExpectedResults(
  steps: Array<{ 步骤描述: string; 预期结果: string }>,
): string[] {
  const errors: string[] = []

  for (let index = 0; index < steps.length; index += 1) {
    const action = compactText(steps[index].步骤描述)
    const expected = compactText(steps[index].预期结果)
    if (action && expected && action === expected) {
      errors.push(`step[${index}] 的预期结果不能仅复述步骤描述`)
    }
  }

  return errors
}

function validateExpectedOutputCoverage(
  steps: Array<{ 步骤描述: string; 预期结果: string }>,
  context?: RequirementSemanticContext,
): string[] {
  const errors: string[] = []
  const corpus = buildRequirementCorpus(context)
  const needsIndirectResponse = /(间接指令应答)/.test(corpus)

  if (needsIndirectResponse) {
    for (let index = 0; index < steps.length; index += 1) {
      const buses = detectExplicitBuses(steps[index].步骤描述)
      const bus = buses[0]
      if (!bus) continue
      const expected = compactText(steps[index].预期结果)
      const expectedClause = compactText(`${bus}总线发送间接指令应答数据`)
      if (!expected.includes(expectedClause)) {
        errors.push(`step[${index}] 的预期结果必须明确验证 ${bus} 总线发送间接指令应答数据`)
      }
    }
  }

  // Counter expectations are checked CASE-LOCALLY: only cases whose expected
  // results mention the counter field (e.g. W170) are required to state its
  // observable value. Cases that never exercise the counter (e.g. ID 错误丢弃
  // cases under the same requirement item) must not be forced to claim it.
  const counterClauses: string[] = []
  if (/(W2b3\W*W2b1)/.test(corpus)) {
    counterClauses.push("缓变遥测数据W2b3~W2b1为1")
  }
  const telemetryClause = extractTelemetryFieldClause(context)
  if (telemetryClause) {
    counterClauses.push(telemetryClause)
  }

  for (const clause of counterClauses) {
    // No trailing word boundary: fields like "W2b7" (bit-slice) must still
    // resolve to field code W2.
    const fieldCode = clause.match(/\bW\d+/)?.[0]
    if (!fieldCode) continue
    const mentionRe = new RegExp(fieldCode, "i")
    const valueRe = new RegExp(`${fieldCode}[^。；\\n]{0,12}(?:为|等于|值为)\\s*\\d+`, "i")
    const expectedTexts = steps.map((step) => compactText(step.预期结果))
    const mentioned = expectedTexts.some((text) => mentionRe.test(text))
    if (mentioned && !expectedTexts.some((text) => valueRe.test(text))) {
      errors.push(
        `预期结果必须写明 ${fieldCode} 的可观测绝对值（需求未说明初始值时假定初值为0），` +
        `不得只描述动作或相对变化（如"${fieldCode}加1"、"比注错前${fieldCode}增加1"）`,
      )
    }
  }

  return errors
}

function validateFunctionalScope(
  steps: Array<{ 步骤描述: string; 预期结果: string }>,
  context?: RequirementSemanticContext,
): string[] {
  if (!isFunctionalTestContext(context)) return []
  return caseLooksLikeFunctionalOverreach(steps)
}

export function collectUnresolvedPlaceholders(text: string): string[] {
  const placeholders = String(text ?? "").match(/\$\{[^}]+\}/g) ?? []
  return [...new Set(placeholders)]
}

export function validatePersistedPhase6Steps(
  steps: Array<{ 步骤描述: string; 预期结果: string }>,
  context?: RequirementSemanticContext,
): string[] {
  const errors: string[] = []
  for (let i = 0; i < steps.length; i++) {
    const desc = steps[i].步骤描述?.trim()
    const expect = steps[i].预期结果?.trim()
    if (!desc) errors.push(`step[${i}] 步骤描述为空，关键字绑定可能产生了空的步骤描述`)
    if (!expect) errors.push(`step[${i}] 预期结果为空`)
  }
  if (errors.length > 0) return errors

  return [
    ...validateExpectedResults(steps),
    ...validateExpectedOutputCoverage(steps, context),
  ]
}

export function applySemanticBindingsToStandardizedCase(
  caseRecord: {
    test_step: Array<{ 步骤描述: string; 预期结果: string }> | string
    test_input: string
  },
  options: {
    keywordCandidates: KeywordCandidateContext[]
    datasetRef: string
    protocolSemantic?: ProtocolSemanticDocument
    requirementContext?: RequirementSemanticContext
    placeholderSuggestions?: PlaceholderSuggestion[]
    caseIndex?: number
  },
): {
  test_step: Array<{ 步骤描述: string; 预期结果: string }>
  test_input: string
  warnings: string[]
  errors: string[]
} {
  const warnings: string[] = []
  let steps: Array<{ 步骤描述: string; 预期结果: string }>

  if (Array.isArray(caseRecord.test_step)) {
    steps = caseRecord.test_step
  } else {
    try {
      steps = JSON.parse(caseRecord.test_step) as Array<{ 步骤描述: string; 预期结果: string }>
    } catch {
      return { test_step: [], test_input: caseRecord.test_input, warnings, errors: [] }
    }
  }

  const explicitBuses = detectExplicitBuses(buildRequirementCorpus(options.requirementContext))
  const busKeywordCandidates = new Map<string, KeywordCandidateContext>()
  for (const bus of explicitBuses) {
    const matched = options.keywordCandidates.find((candidate) =>
      candidate.keywordName.toUpperCase().includes(bus) ||
      candidate.description.toUpperCase().includes(bus)
    )
    if (matched) busKeywordCandidates.set(bus, matched)
  }

  const renderStepWithCandidate = (
    step: { 步骤描述: string; 预期结果: string },
    stepIndex: number,
    keywordCandidate: KeywordCandidateContext,
    sourceStepText: string,
  ) => {
    let template = shouldForceDocumentationTemplate(sourceStepText, keywordCandidate)
      ? keywordCandidate.description
      : sourceStepText.includes("${")
        ? sourceStepText
        : (sourceStepText.trim() === keywordCandidate.keywordName && keywordCandidate.description
          ? keywordCandidate.description
          : sourceStepText)

    if (!template || template.trim().length === 0) template = sourceStepText

    if (!template.includes("${")) {
      return {
        ...step,
        步骤描述: template,
      }
    }

    const binding = bindKeywordArgsFromSemantics(keywordCandidate, {
      protocolSemantic: options.protocolSemantic,
      requirementContext: options.requirementContext,
      placeholderSuggestions: options.placeholderSuggestions,
      caseIndex: options.caseIndex,
      stepIndex,
      template,
      sourceStepText,
    })
    warnings.push(...binding.warnings)

    const rendered = renderDocumentationTemplate(template, binding.bindings, buildCommentMap(keywordCandidate))
    if (rendered.unresolved.length > 0) {
      warnings.push(`step[${stepIndex}] 保留未替换占位符: ${rendered.unresolved.join(", ")}`)
    }

    return {
      ...step,
      步骤描述: rendered.text,
    }
  }

  const updatedSteps = steps.flatMap((step, stepIndex) => {
    const rawDesc = String(step.步骤描述 ?? "")

    // 双总线"同用例展开"已移除(2026-08-20):模板规则要求双冗余总线每条总线
    // 各自独立一个用例,把通用 CAN 步骤展开成 CANA+CANB 两条步骤塞进同一用例
    // 与之直接矛盾,且会让 persist 结构检测的重派循环无法收敛。通用总线步骤
    // 保持原样,由 worker 按规则分总线生成用例。

    const keywordCandidate = findBestKeywordCandidateForStep(
      rawDesc,
      options.keywordCandidates,
      options.requirementContext,
    )
    if (!keywordCandidate) {
      if (rawDesc.includes("${")) {
        warnings.push(`step[${stepIndex}] 未匹配到关键字候选，无法替换占位符`)
      }
      return [step]
    }

    return [renderStepWithCandidate(step, stepIndex, keywordCandidate, rawDesc)]
  })

  const enrichedSteps = updatedSteps.map((step) =>
    enrichExpectedResult(step, options.requirementContext),
  )

  const errors = [
    ...validatePersistedPhase6Steps(enrichedSteps, options.requirementContext),
  ]

  return {
    test_step: enrichedSteps,
    test_input: caseRecord.test_input === "无" ? options.datasetRef : caseRecord.test_input,
    warnings,
    errors,
  }
}

export function loadProtocolSemanticContext(filePath: string): ProtocolSemanticDocument {
  return loadProtocolSemanticDocument(filePath)
}
