import type {
  TranslatedTestStepRecord,
  UnifiedTestStepRecord,
} from "../schema/confirmation-test-case"
import type { StandardizedCase } from "./phase6-testcase-standardizer"
import { validateFunctionalModelSteps, type FunctionalModel } from "./phase6-functional-model"
import { analyzePacketSequences, packetOperationIdentity } from "./phase6-step-design-policy"
import {
  buildCommentMap,
  inferKeywordArgumentSemantic,
  renderDocumentationTemplate,
  type KeywordArgumentSemantic,
  type KeywordCandidateContext,
} from "./keyword-argument-binding"
import {
  actionClauseOf,
  filterUserKeywordMap,
  scoreKeywordCandidates,
  scoreKeywordCandidatesByAnchor,
  stepActionOnPrimaryBus,
  stepActionOnSecondaryBus,
  type AnchorFilter,
  type KeywordMeta,
  type StepPlan,
} from "./testcase-keywords"
import { resolveGeneratedTestEnvironment } from "./test-environment"
import { extractSentPayload, isPrimaryTelemetryReadback, keywordMatchesStepAction, translatedStepSemanticIssues } from "./testcase-step-semantics"
import {
  sanitizeDtpExecutablePlaceholders,
  sanitizeDtpExecutableValue,
} from "./phase6-placeholder-sanitizer"

export type Phase6TranslationIssueCategory =
  | "keyword_metadata"
  | "documentation_mismatch"
  | "keyword_missing"
  | "empty_executable_steps"

export interface Phase6CandidateTranslationFailure {
  keyword_name: string
  source_json?: string
  source_txt?: string
  category: Phase6TranslationIssueCategory
  issues: string[]
}

function stripTerminalPunctuation(value: string): string {
  return value.trim().replace(/[。．.!！?？]+$/u, "").trim()
}

function normalizeMatchText(value: string): string {
  return stripTerminalPunctuation(value)
    .replace(/，/g, ",")
    .replace(/。|．/g, ".")
    .replace(/；/g, ";")
    .replace(/：/g, ":")
    // 引号剥除(模板与步骤文本同侧归一):UserKeyword 的 Documentation 常写
    // 数据为"${para2}"(全角引号),worker 步骤不带引号——不剥除则模板正则
    // 恒失配,退到语义提取后从预期文本抓数字(2026-09-02 取证:上注起始块
    // 参数2 被填成"704")
    .replace(/["“”‘’'「」『』]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function collectPlaceholdersInOrder(template: string): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const match of template.matchAll(/\$\{[^}]+\}/g)) {
    const name = match[0]
    if (seen.has(name)) continue
    seen.add(name)
    result.push(name)
  }
  return result
}

function buildTemplateMatcher(template: string): {
  regex: RegExp
  placeholders: string[]
} {
  const normalizedTemplate = normalizeMatchText(template)
  const placeholders: string[] = []
  let pattern = "^"
  let cursor = 0
  const placeholderRegex = /\$\{[^}]+\}/g
  let match: RegExpExecArray | null

  while ((match = placeholderRegex.exec(normalizedTemplate)) !== null) {
    const literal = normalizedTemplate.slice(cursor, match.index)
    pattern += escapeRegExp(literal).replace(/\\ /g, "\\s*")
    pattern += "(.*?)"
    placeholders.push(match[0])
    cursor = match.index + match[0].length
  }

  const tail = normalizedTemplate.slice(cursor)
  pattern += escapeRegExp(tail).replace(/\\ /g, "\\s*")
  pattern += "$"

  return {
    regex: new RegExp(pattern, "u"),
    placeholders,
  }
}

function keywordToCandidate(keyword: KeywordMeta): KeywordCandidateContext {
  return {
    keywordName: keyword.keywordName,
    description: keyword.description,
    argumentNames: keyword.argumentNames,
    argumentComments: keyword.argumentComments,
    txtSnippet: keyword.txtSnippet,
  }
}

function parseParameterValue(rawValue: string): string | number | null {
  const trimmed = rawValue.trim()
  if (trimmed === "") return null
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed)
  return trimmed
}

function isExactNoArgMatch(action: string, keyword: KeywordMeta, template: string): boolean {
  const normalizedAction = normalizeMatchText(action)
  const normalizedTemplate = normalizeMatchText(template)
  const normalizedName = normalizeMatchText(keyword.keywordName)

  return (
    normalizedAction === normalizedTemplate ||
    normalizedAction === normalizedName ||
    normalizedAction.includes(normalizedTemplate) ||
    normalizedTemplate.includes(normalizedAction)
  )
}

function orderedArgumentComments(keyword: KeywordMeta): Map<string, string> {
  const result = new Map<string, string>()
  for (let index = 0; index < keyword.argumentNames.length; index += 1) {
    const name = keyword.argumentNames[index]
    if (!name || result.has(name)) continue
    result.set(name, keyword.argumentComments[index] ?? "")
  }
  return result
}

/** Internal placeholder used to substitute %$ (bus channel) when no anchor channel is available. */
const BUS_PLACEHOLDER = "${__bus__}"

/**
 * Undeclared placeholders that are runtime OUTPUT variables (readback/result slots)
 * in DTP Documentation templates, e.g. ${result0}, ${Retval}, ${RealValue}, ${memValue}.
 * They sit on the "readback" side of a "<=>" expectation pair and never map to JSON
 * Arguments — they must not hard-fail the declaration check nor enter the parameter list.
 */
const OUTPUT_PLACEHOLDER_PATTERN = /^\$\{(?:result\d+|Retval|RealValue|RealVal|memValue|VarValue|curtime)\}$/

/**
 * A parameter placeholder that survived template rendering — the step text
 * never supplied a value for it. Readback slots (OUTPUT_PLACEHOLDER_PATTERN)
 * are excluded: their marker text is intentional, not a defect.
 */
const SURVIVING_PARAM_PLACEHOLDER = /\$\{(?!result\d+|Retval|RealValue|RealVal|memValue|VarValue|curtime)[^}]+\}/

// ============================================================
// UNBOUND ARGUMENT FILLING (指令ID / 数据文件说明)
// ============================================================
// 用户拍板的替换语义（2026-08-19）:
// - 指令ID 参数(ID:0~255): 用例内为每个指令从范围内取一个 ID,不重复。
//   同一指令短语跨步骤复用同一 ID(库注释: 一个ID对应一种类型指令)。
// - 数据文件/数据包名称 参数: 值只需说明"什么指令的什么情况",不需要
//   指定具体文件——该指令此种情况的数据本就存放在一个数据文件中,
//   具体文件由后续数据生成阶段生成。

/** Case-scoped allocation state: instruction IDs must not repeat within one test case. */
export interface CaseArgumentAllocationState {
  usedInstructionIds: Set<number>
  instructionIdByPhrase: Map<string, number>
}

const INSTRUCTION_ID_RANGE_PATTERN = /ID\s*[:：]\s*(\d+)\s*[~～]\s*(\d+)/
const DATA_FILE_COMMENT_PATTERN = /数据文件|数据包名称/
const LABEL_MAX_LENGTH = 40

/** Leading glue stripped from an instruction phrase segment ("在被测件再次发送…后"). */
const INSTRUCTION_GLUE_PREFIX_PATTERNS: RegExp[] = [
  /^(?:一级|二级)?(?:CANA|CANB|CAN|SPI)[A-Za-z]*(?:接口|总线)?/,
  /^(?:在被测件|被测件|测试系统|主控|软件|系统)/,
  /^(?:再次|重新|依次|连续\d*次|第\d+次|重复)/,
  // 循环时间触发写法(2026-08-26 用户拍板优化):"以1秒为周期循环发送遥测
  // 轮询控制序列"的指令身份仍是"遥测轮询控制序列"——循环/周期修饰须剥离,
  // 否则触发短语与显式写法不同名,聚合分组与重组命名都会漂移
  /^(?:以[\d.]+秒?为周期|循环|周期性|每隔?[\d.]+秒)+/,
  /^(?:通过|沿|从|由|向|将|把|已|其|该)/,
  /^(?:发送|下发|注入|回传|返回|接收|收到|启动|触发|请求|读出|写入)/,
  // 情况形容词不是指令身份的一部分:"正确的遥测帧1轮询"与"遥测帧1轮询"
  // 是同一指令——聚合分组与标签抽取都必须忽略该修饰
  /^(?:正确|错误|异常|无效|非法|有效)(?:的)?/,
]

function stripInstructionGlue(text: string): string {
  let current = text.trim()
  while (true) {
    let next = current
    for (const pattern of INSTRUCTION_GLUE_PREFIX_PATTERNS) {
      next = next.replace(pattern, "")
    }
    next = next.replace(/^(?:的|后|前|时|，|,|。)+/, "").trim()
    if (next === current) break
    current = next
  }
  return current
}

/** 发送类动词: 指令短语取最后一个发送动词之后的部分,避免"站地址01H"等中缀混入 */
const SEND_VERB_PATTERN = /(?:发送|下发|注入|回传|返回|转发|请求)(?=[^,，。;；]*指令)/g

/** 单文本区内提取指令短语:含"指令"段优先,无指令字样走轮询/数据块/遥测帧N兜底 */
function instructionPhraseFromText(text: string): string {
  const segments = text.split(/[\s,，。;；、()（）【】\[\]:：]/)
  const instructionSegment = segments.find((segment) => segment.includes("指令"))
  if (instructionSegment) {
    // 截到最后一个"后接指令"的发送动词之后,再去引导语
    let tail = instructionSegment
    let lastVerbEnd = -1
    for (const verbMatch of instructionSegment.matchAll(SEND_VERB_PATTERN)) {
      lastVerbEnd = verbMatch.index! + verbMatch[0].length
    }
    if (lastVerbEnd >= 0) tail = instructionSegment.slice(lastVerbEnd)
    const stripped = stripInstructionGlue(tail)
    const match = stripped.match(/(?:\d+字节)?[A-Za-z0-9一-龥/]{0,12}指令[A-Za-z0-9]*/)
    // 计数器名护栏(指令分支,2026-09-08 P1 取证):"管理遥控指令正确指令计数"
    // 这类计数器名含"指令"走本分支,曾抽出幽灵短语"管理遥控指令正确指令"——
    // 聚合按它误报"指令被拆散在N个用例",regroup_directive 照抄成不可执行
    // 指令,重派注定失败。与轮询兜底分支同款护栏:候选后紧跟 计数/站地址
    // 参数词的一律拒绝,落入兜底分支
    const counterTail = match
      ? stripped.slice(match.index! + match[0].length, match.index! + match[0].length + 2)
      : ""
    if (
      match && match[0].length >= 3
      && !counterTail.startsWith("计数") && !counterTail.startsWith("站地址")
    ) {
      // 左most起点的长度上限可能把残留动词卷进短语,再清一次
      const phrase = stripInstructionGlue(match[0])
      if (phrase.includes("指令") && phrase.length >= 3) return stripSituationModifiers(phrase)
    }
  }
  // 无"指令"字样:先去时间/总线引导语,再取 轮询/数据块/遥测帧N 名词段,
  // 否则左most匹配会把"通过CANA总线"等引导语卷进短语。
  // 计数器名护栏(2026-08-26 晚取证):预期结果里的"二级CAN错误轮询**计数**
  // (TMYN397)"曾被轮询兜底截成指令短语"二级CAN错误轮询",修复器按它合成
  // "通过CANA总线发送二级CAN错误轮询"——一级总线发二级协议载荷的垃圾步骤。
  // 候选后紧跟 计数/站地址 参数词的一律拒绝
  const strippedText = stripInstructionGlue(stripLeadingTemporalAndBus(text))
  const pollingRegex = /(?:\d+字节)?[A-Za-z0-9一-龥/]{2,14}?(?:轮询|数据块|遥测帧\d+)/g
  for (const match of strippedText.matchAll(pollingRegex)) {
    const tail = strippedText.slice(match.index! + match[0].length, match.index! + match[0].length + 2)
    if (tail.startsWith("计数") || tail.startsWith("站地址")) continue
    if (/TMYN\d+/.test(match[0])) continue
    return stripSituationModifiers(match[0])
  }
  return ""
}

function instructionPhraseFromStep(corpus: string): string {
  // 步骤描述半区优先(2026-08-26 W0 误报取证):预期结果里的计数器管理文本
  // ("管理错误指令与上行数据包计数")含"指令"字样,曾在描述无指令词的数据块
  // 步骤上被提取为幽灵指令短语,导致 mixed_instruction/配对误判并触发修复器
  // 按幽灵短语拆散用例。描述半区的指令路径与数据块/轮询兜底都失败才查预期。
  const nl = corpus.indexOf("\n")
  if (nl < 0) return instructionPhraseFromText(corpus)
  const fromDesc = instructionPhraseFromText(corpus.slice(0, nl))
  if (fromDesc) return fromDesc
  return instructionPhraseFromText(corpus.slice(nl + 1))
}

/**
 * 去掉短语内嵌的情况修饰前缀:"首帧帧序号错误的10字节遥控指令"→"10字节
 * 遥控指令"。情况(某字段错误)是指令的测试情形,不是指令身份;若不清除,
 * 同一指令的错误步骤与正确步骤会提取出不同短语,配对检测失效、合成的
 * "发送正确的{短语}"文案会荒谬(2026-08-21 修复回放取证)。
 */
function stripSituationModifiers(phrase: string): string {
  let current = phrase
  while (current.includes("的") && current.length > 4) {
    const lastDe = current.lastIndexOf("的")
    const remainder = current.slice(lastDe + 1)
    // 余部须仍是完整指令名(含指令/轮询等身份词)才继续剥离
    if (lastDe > 0 && remainder.length >= 4 && /指令|轮询|数据块|遥测帧/.test(remainder)) {
      current = remainder
    } else break
  }
  return current
}

/** 情况短语: 应答/验证/错误 语义段;没有明确情况时按正常发送处理。 */
function situationPhraseFromStep(corpus: string): string {
  const match =
    corpus.match(/(?:返回|收到|接收到)([^,，。;；]{2,24}应答)/) ??
    corpus.match(/验证([^,，。;；]{2,28})/) ??
    corpus.match(/((?:仲裁场|控制场|数据场|CRC|校验|标识符|地址域)[^,，。;；]{0,16}(?:错误|异常|失败|无效))/) ??
    corpus.match(/((?:错误|异常|无效|超时|丢失|未响应|无应答)[^,，。;；]{0,16})/)
  return match ? match[1].trim() : ""
}

function stripLeadingTemporalAndBus(corpus: string): string {
  return corpus
    .replace(/^第\s*[\d.]+\s*秒\s*[,，]?\s*/, "")
    .replace(/通过(?:一级|二级)?(?:CANA|CANB|CAN|SPI)[A-Za-z]*(?:接口|总线)?[AB]?/, "")
    .replace(/^[\s,，]+/, "")
    .trim()
}

/** 数据文件参数说明: "什么指令的什么情况" (e.g. 10字节遥控指令·仲裁场错误应答)。 */
function dataFileLabelFromStep(corpus: string): string {
  const instruction = instructionPhraseFromStep(corpus)
  const situation = situationPhraseFromStep(corpus)
  let label: string
  if (instruction && situation) {
    label = `${instruction}·${situation}`
  } else if (instruction) {
    label = `${instruction}·正常发送`
  } else {
    // 指令短语无法识别时退化为去引导语后的步骤原文,保证说明非空
    label = stripLeadingTemporalAndBus(corpus) || "待生成数据文件"
  }
  return label.length > LABEL_MAX_LENGTH ? label.slice(0, LABEL_MAX_LENGTH) : label
}

// ============================================================
// CROSS-TR AGGREGATION ANALYSIS (聚合度确定性检测)
// ============================================================
// 用户拍板(2026-08-20):同一指令的不同情况即使分散在多个 TR-ID 描述条目中,
// 也必须聚合到同一个用例中一起测试。worker(LLM)对逐条 TR 枚举形态的
// "处理"字段遵从不稳定(整段合并形态天然聚合),检测器在 format_check/
// persist 阶段用确定性代码兜底:同一指令短语出现在多个用例、且这些用例
// 的 covered_tr_items 不完全一致 = 跨 TR 拆分违规,拒绝落库并反馈重派。

export interface AggregationViolation {
  instruction_phrase: string
  case_names: string[]
  covered_tr_items: string[]
  message: string
  /** 违规涉及的用例下标(确定性修复的牵连集来源) */
  case_indexes?: number[]
}

export interface CaseAggregationAnalysis {
  violations: AggregationViolation[]
  warnings: string[]
  /**
   * TR 覆盖缺口(2026-08-24 两轮运行取证):需求组全部用例 covered_tr_items
   * 的并集未覆盖组内全部 TR——如 8 TR 组只覆盖 4 个,缺失 TR 的检查情况
   * 整体缺席("只参考单一需求"的完整形态)。检测器无法把情况映射回 TR,
   * 但并集对组集合的差集是确定性的。
   */
  coverage_gaps: string[]
}

// ============================================================
// CASE STRUCTURE ANALYSIS (双总线分开 / 错误-正确配对 确定性检测)
// ============================================================
// 模板规则早已存在(test-interface.md:每条总线各自独立用例;步骤按
// "全部正确→某字段错误→全部正确"交替),但 2026-08-20 晚取证:24 个用例
// CANA/CANB 混用、61 处错误步骤后缺"全部正确"配对——LLM 遵从概率性,
// 与跨 TR 聚合同构,需确定性检测 + persist 拒绝 + 重派闭环兜底。

export interface StructureViolation {
  type:
    | "mixed_bus"
    | "missing_bus_counterpart"
    | "missing_correct_after_error"
    | "mixed_instruction"
    | "zero_time_step"
    | "missing_primary_trigger"
    | "duplicate_loop_trigger"
    | "missing_station_address"
    | "missing_instruction_length_variant"
    | "mixed_upload_type"
    | "invalid_auxiliary_interleave"
    | "invalid_memory_read_alignment"
    | "invalid_memory_read_scenarios"
    | "incomplete_memory_read_boundary"
    | "invalid_memory_polling_schedule"
    | "watchdog_shape_violation"
    | "functional_model_violation"
  case_name: string
  message: string
  /** mixed_instruction 违规携带用例内混入的指令短语清单(供重派划分表使用) */
  phrases?: string[]
  /** 违规所属用例的下标(2026-09-08 P2 取证:同名用例时按名称 findIndex 会
   * 错位牵连无辜用例——检测端在逐用例循环内批注,修复端优先按下标定位) */
  case_index?: number
}

export interface CaseStructureAnalysis {
  violations: StructureViolation[]
}

const SEND_STEP_PATTERN = /(发送|下发|注入|回传|返回)/
/** 请求方向动词(发送/下发/注入)——"回传/返回"是应答方向:应答步骤的指令短语是被测指令的应答内容,不算用例内独立指令 */
const REQUEST_DIRECTION_PATTERN = /(发送|下发|注入)/
/** 用例主题本身是双总线行为的(切换/交替/冗余/备份),混用总线是测试目的,豁免 */
const DUAL_BUS_SUBJECT_PATTERN = /(切换|交替|双冗余|双总线|冗余|备份)/
// FPGA状态遥测主体(2026-09-08 用户拍板):设置地址值后需跟多个遥测帧轮询步骤
// (一次设置同时涉及遥测帧1/帧3)——多帧轮询编排不按"一条指令一个用例"拆分
const FPGA_TELEMETRY_SUBJECT_PATTERN = /FPGA状态遥测/
/**
 * 连续错误堆叠主题(自动切换/连续N次未收到正确):连续错误正是测试目的,
 * 恢复发生在切换之后,逐错误配对会误判。比 DUAL_BUS_SUBJECT 更窄——
 * "交替组织"等泛措辞不触发(2026-08-26 自动切换测试取证)
 */
const CONSECUTIVE_ERROR_SUBJECT_PATTERN = /(自动切换|总线切换|连续\s*\d*\s*次|未收到.{0,8}正确)/
const BUS_OF_STEP_PATTERN = /通过(CANA|CANB)总线/

/** 双辅助数据包功能模式中的包号。两包共同组成同一业务周期，不能被“混指令”
 * 门禁拆开；其恢复节奏是正确包1→包1错误→正确包2→包2错误，而非通用的
 * 同包错误后立即重发同包。 */
function auxiliaryPacketNumber(desc: string): 1 | 2 | null {
  if (!/辅助数据/.test(desc)) return null
  const match = desc.match(/辅助数据包\s*(?:第\s*)?([12一二])(?:\s*包)?|第\s*([12])\s*包[^。；;\n]{0,12}辅助数据/)
  const value = match?.[1] ?? match?.[2]
  if (value === "1" || value === "一") return 1
  if (value === "2" || value === "二") return 2
  return null
}

export interface MemoryAddressRange {
  lower: string
  upper: string
}

function inputAddressOfMemoryRead(desc: string): bigint | null {
  if (!/内存读出指令/.test(desc)) return null
  // 生成步骤既可写“指令中绝对地址为0x...”，也常按协议字段写成
  // “地址W0~W3为0x...”/“绝对地址（W0-W3）=0x...”。地址语义是数值，
  // 不应依赖某一种字面句式或前导 0。
  const match = desc.match(
    /(?:指令中)?(?:绝对)?地址(?:值)?(?:\s*[（(]?\s*W\d+\s*(?:~|～|-|至)\s*W\d+\s*[）)]?)?\s*(?:为|=|：|:)\s*(0x[0-9a-f]+)/i,
  )
  if (!match?.[1]) return null
  try {
    return BigInt(match[1])
  } catch {
    return null
  }
}

function absoluteTimeOfStep(desc: string): number | null {
  const match = desc.match(/第\s*(\d+(?:\.\d+)?)\s*秒/)
  if (!match?.[1]) return null
  const value = Number(match[1])
  return Number.isFinite(value) ? value : null
}

function hexAddress(value: bigint): string {
  return `0x${value.toString(16).toUpperCase()}`
}

/**
 * 步骤文本字段双拼写:标准化视图用 步骤描述/预期结果,翻译后 Unified 步骤
 * 用 step_desc/expected_result。结构检测与修复的谓词必须两者皆读——修复
 * 分支的 merged 视图喂的是翻译后步骤,只读 步骤描述 会全部读到空串,
 * 导致修复通道静默空转(2026-08-24 两轮运行取证:拒绝两次后 flag 落库,
 * repair_actions=0、残留假报 0,单 TR 拆分用例原样入库)。
 */
export interface StructureStep {
  步骤描述?: string
  预期结果?: string
  step_desc?: string
  expected_result?: string
  [key: string]: unknown
}

function descOfStep(step: StructureStep | undefined): string {
  if (!step) return ""
  return String(step.步骤描述 ?? step.step_desc ?? "")
}

function expectOfStep(step: StructureStep | undefined): string {
  if (!step) return ""
  return String(step.预期结果 ?? step.expected_result ?? "")
}

function busOfStepDesc(desc: string): "CANA" | "CANB" | "" {
  const match = desc.match(BUS_OF_STEP_PATTERN)
  return (match?.[1] as "CANA" | "CANB") ?? ""
}

function isCorrectSendStep(desc: string): boolean {
  return SEND_STEP_PATTERN.test(desc) && desc.includes("正确") && !desc.includes("错误")
}

function isErrorSendStep(desc: string): boolean {
  // 只看注入类步骤:含发送动词 + "错误";验证/查询步骤(如"验证…错误计数")
  // 无发送动词,天然排除;"连续/持续 N 次"容错场景豁免
  return SEND_STEP_PATTERN.test(desc) && desc.includes("错误")
    && !/(连续|持续|多次)/.test(desc)
}

/**
 * 二级总线(软件↔下位机)模拟应答:软件经二级总线向下位机发指令并被动等应答,
 * 软平台无下位机组件,测试系统通过二级总线**主动发送应答**模拟被动应答
 * (2026-08-25 用户拍板的二级总线测试模型)。
 */
const SECONDARY_BUS_PATTERN = /二级(?:CAN)?总线/
/**
 * 二级通道统称:二级CAN总线 + SPI 总线/接口。SPI 与二级CAN 同构(软件经 SPI
 * 与内部单板通信,测试系统主动发送应答/遥测模拟单板返回,2026-08-28 拍板)。
 * 配对/恢复单元判定按通道统称,不能只认二级CAN——SPI 错误应答后的正确
 * 恢复步骤同样是有效的单步恢复单元。
 */
const SECONDARY_CHANNEL_PATTERN = /二级(?:CAN)?总线|SPI(?:总线|接口)/

/**
 * 步骤动作是否发生在 SPI 总线(动作从句含"通过SPI总线/接口")。
 * SPI 是与二级CAN 同构的二级总线:SPI 步骤的载荷名(SPI 输入流名)与一级
 * 触发指令名**本就不同名**(黑体驱动遥控指令↔黑体驱动指令应答),若不被
 * 识别为二级模拟应答,混指令门禁/聚合分桶/重组分桶会把 SPI 应答当独立
 * 第二条指令,把"一级触发+SPI应答"的完整用例拆成两条废用例(2026-08-28
 * TC-JK-028/029 取证:worker 两轮输出都正确,auto_repair 按幽灵短语分桶拆散)
 */
function isSpiSecondaryStep(desc: string): boolean {
  return /通过SPI(?:总线|接口)/.test(actionClauseOf(desc))
}

function isSecondarySimulatedResponse(desc: string): boolean {
  // 模拟应答的内容/动词形态多样:"××应答""返回遥测数据""发送遥测数据"。
  // 判定依据是**动作从句在二级总线**——足以排除一级触发步骤(其结果从句
  // 常提及二级转发,但动作从句点名 CANA/CANB)。动词限定(返回|回传)曾把
  // "通过二级CAN总线发送遥测数据"形态漏杀:应答步骤计入 mixed_instruction
  // 且恢复单元不被识别,修复器按幽灵短语拆散合并用例(2026-08-26 午后
  // TC-JK-017/018 取证)
  if (SECONDARY_BUS_PATTERN.test(desc) && desc.includes("应答")) return true
  if (isSpiSecondaryStep(desc)) return true
  return stepActionOnSecondaryBus(desc)
}

/**
 * 二级总线的"错误→正确"恢复单元是两步:[一级重发同指令] + [二级发送正确应答],
 * 不是一级总线规则的"紧跟同总线正确发送"。检测与修复共用本判定。
 * 恢复单元是位置性结构([一级请求方向重发]+[二级正确应答]),不比对指令短语:
 * 错误/正确应答步骤的短语常落在预期结果的计数器文本上("遥测帧3参数二级CAN
 * 错误轮询计数"),两侧措辞不同会误杀配对(2026-08-26 遥测轮询取证)。
 */
function secondaryRecoveryPaired(steps: StructureStep[], errorIndex: number): boolean {
  const resend = steps[errorIndex + 1]
  const correct = steps[errorIndex + 2]
  if (!resend || !correct) return false
  const resendDesc = descOfStep(resend)
  const correctDesc = descOfStep(correct)
  // 重发是一级再触发:其指令名是一级协议侧的,与被转发的二级指令名可以合法
  // 不同("发送间接指令触发"转发"遥控指令"是正当形态),只要求一级请求方向
  // (BUS_OF_STEP_PATTERN 只匹配"通过CANA/CANB总线",二级步骤天然不满足)
  const resendIsPrimaryTrigger = REQUEST_DIRECTION_PATTERN.test(resendDesc)
    && BUS_OF_STEP_PATTERN.test(resendDesc)
  const correctIsResponse = isCorrectSendStep(correctDesc)
    && SECONDARY_CHANNEL_PATTERN.test(correctDesc)
  return resendIsPrimaryTrigger && correctIsResponse
}

/** 循环触发步骤的文本特征(与配对检测的 loopTriggerMode 同一模式) */
const LOOP_TRIGGER_STEP_PATTERN = /以[\d.]+秒?为周期|循环发送|周期发送/

/**
 * 验证类步骤:"发送X,验证A总线仍正常工作"——其目的是验证而非触发,不满足
 * 一级触发步骤的存在性判定(2026-08-26 晚取证:切换用例仅有的主步骤是 worker
 * 自创的验证步骤,占住主步骤位让缺触发门禁漏判)
 */
function isVerificationStyleStep(desc: string): boolean {
  return /验证.{0,14}(?:正常|工作|切换|仍|输出|保持)/.test(desc)
}

/**
 * 用例是否存在有效一级触发步骤。三重判定:
 * ① 动作从句在一级总线;② 非验证目的步骤;③ 触发载荷与二级数据流匹配——
 * 遥测数据类用例的触发必须是轮询控制序列,发的是别的指令(如切换用例收尾
 * 补发遥控指令确认B总线)不算有效触发(2026-08-26 晚取证:两种措辞的收尾
 * 步骤都曾占住触发位让缺触发门禁漏判)
 */
function hasEffectivePrimaryTrigger(steps: StructureStep[], excludeTelemetryReadback = false): boolean {
  // 纯 SPI 二级用例:一级触发名(上游遥控指令名)与 SPI 输入流名本就不同名
  // (黑体驱动遥控指令↔黑体驱动指令应答),CAN 的"触发名=应答反推名"匹配
  // 模型不适用——只要求存在一级动作、非验证、请求方向的触发步骤(2026-08-28
  // SPI 同构取证:名称匹配会把 worker 写对的触发判成缺触发,连带修复器插错名)
  const secondaryDescs = steps
    .map((step) => descOfStep(step))
    .filter((desc) => isSecondarySimulatedResponse(desc))
  const spiOnly = secondaryDescs.length > 0 && secondaryDescs.every((desc) => isSpiSecondaryStep(desc))
  if (spiOnly) {
    return steps.some((step) => {
      const desc = descOfStep(step)
      if (excludeTelemetryReadback && isPrimaryTelemetryReadback(desc)) return false
      return stepActionOnPrimaryBus(desc) && !isVerificationStyleStep(desc)
        && REQUEST_DIRECTION_PATTERN.test(desc)
    })
  }
  const derived = primaryTriggerNameForSecondarySteps(steps)
  return steps.some((step) => {
    const desc = descOfStep(step)
    if (excludeTelemetryReadback && isPrimaryTelemetryReadback(desc)) return false
    if (!stepActionOnPrimaryBus(desc) || isVerificationStyleStep(desc)) return false
    if (derived && /轮询|遥测帧/.test(derived)) {
      return desc.includes(derived) || /轮询控制序列/.test(desc)
    }
    if (derived) return desc.includes(derived)
    return true
  })
}

/**
 * 从用例的二级模拟应答载荷反推一级触发指令名(2026-08-26 晚取证:
 * worker 对遥测轮询/切换用例漏写触发步骤,确定性补齐需要正确的指令名)。
 * - "发送(正确的)遥控指令应答" → 应答前的指令名"遥控指令"
 * - "发送遥测数据/遥测帧…" → 一级以轮询控制序列触发(帧号任选其一)
 */
function primaryTriggerNameForSecondarySteps(steps: StructureStep[]): string {
  for (const step of steps) {
    const desc = descOfStep(step)
    if (!isSecondarySimulatedResponse(desc)) continue
    // SPI 步骤不参与反推:SPI 输入流名与一级指令名不同名,按 SPI 应答名
    // 合成一级触发步骤会插入错名载荷(2026-08-28);纯 SPI 半截用例由
    // 门禁如实报缺触发、重派补齐,不做确定性插补
    if (isSpiSecondaryStep(desc)) continue
    const response = desc.match(/(?:发送|返回|回传)(?:模拟下位机)?(.{2,24}?)应答/)
    if (response) {
      // 去修饰前缀,顺序无关:"站地址01H的正确的遥控指令应答"→"遥控指令"
      // (字符类须含 H——站地址十六进制后缀;顺序写死曾把整段修饰卷进指令名)
      let name = response[1]!
      for (;;) {
        const stripped = name.replace(
          /^(?:站地址[0-9A-Fa-fHhXx]{0,4}的|正确的|错误的|全部正确的|模拟下位机)/,
          "",
        )
        if (stripped === name) break
        name = stripped
      }
      if (name.length >= 2 && name.length <= 16 && !/二级/.test(name)) return name
    }
    if (/遥测数据|遥测帧/.test(desc)) return "遥测帧1轮询控制序列"
  }
  return ""
}

/**
 * 由二级错误应答步骤派生其"全部正确"变体:保留原载荷命名(指令名/站地址/
 * 数据名逐字保留),只把错误情形改为全部正确。修复插入的恢复步骤载荷必须
 * 与错误步骤同源——按幽灵短语合成会产出"发送正确的二级CAN错误轮询应答"
 * 这类计数器名载荷(2026-08-26 晚取证)
 */
function correctVariantOfSecondaryErrorStep(step: RepairableStep): RepairableStep {
  const clone: RepairableStep = { ...step }
  const rewrite = (desc: string): string => desc
    .replace(/[(（][^()（）]*错误[^()（）]*[)）]/, "（全部字段正确）")
    .replace(
      /(?:[A-Za-z]+字节|[A-Za-z]+字段|[A-Za-z一-龥]{1,4}场)错误\d*(?:，|,)?(?:其余(?:字节|字段)正确)?/g,
      "全部字段正确",
    )
    .replace(/错误的/g, "正确的")
  if (typeof clone.步骤描述 === "string") clone.步骤描述 = rewrite(clone.步骤描述)
  if (typeof clone.step_desc === "string") clone.step_desc = rewrite(clone.step_desc)
  if (typeof clone.预期结果 === "string") {
    clone.预期结果 = "软件正常接收并处理该正确数据,更新相应一级总线遥测,错误计数保持不变。"
  }
  if (typeof clone.expected_result === "string") {
    clone.expected_result = "软件正常接收并处理该正确数据,更新相应一级总线遥测,错误计数保持不变。"
  }
  return clone
}

/**
 * 从需求输入流语料解析第一个"从节点"的站地址(HTML 表格行:
 * 序号|单机名称|终端类型|站地址|遥测帧数)。站地址↔从节点对应关系在二级
 * 总线数据流定义部分(2026-08-26 用户拍板:一个用例只对应一个从节点,
 * 一般随机挑一个;修复通道确定性取第一个从节点)
 */
function parseFirstSlaveStationAddress(corpus: string): { name: string; address: string } | null {
  const htmlRow = corpus.match(
    /<td>[^<]*<\/td><td>([^<]+)<\/td><td>从节点<\/td><td>([0-9A-Fa-f]{1,2}H)<\/td>/,
  )
  if (htmlRow) return { name: htmlRow[1]!.trim(), address: htmlRow[2]!.toUpperCase() }
  const textRow = corpus.match(/从节点[^0-9A-Fa-f]{0,24}([0-9A-Fa-f]{1,2}H)/)
  if (textRow) return { name: "", address: textRow[1]!.toUpperCase() }
  return null
}

/** 站地址注入:二级步骤载荷前插"站地址XXH的",预期中"该应答中站地址"类指代落为具体值 */
function injectStationAddressIntoStep(step: RepairableStep, address: string): RepairableStep {
  const clone: RepairableStep = { ...step }
  const rewriteDesc = (desc: string): string => desc.includes("站地址")
    ? desc
    : desc.replace(/(发送|返回|回传)(?![^，。;；]*站地址)/, `$1站地址${address}的`)
  const rewriteExpect = (expect: string): string => expect
    .replace(/该(?:错误)?(?:应答|遥测数据|遥测)(?:中)?的?站地址/g, `站地址${address}`)
  if (typeof clone.步骤描述 === "string") clone.步骤描述 = rewriteDesc(clone.步骤描述)
  if (typeof clone.step_desc === "string") clone.step_desc = rewriteDesc(clone.step_desc)
  if (typeof clone.预期结果 === "string") clone.预期结果 = rewriteExpect(clone.预期结果)
  if (typeof clone.expected_result === "string") clone.expected_result = rewriteExpect(clone.expected_result)
  return clone
}

/**
 * 从数据流定义语料提取"长度变体指令"基名:数据流定义中同名指令以不同字节
 * 长度成文(如"10字节遥控指令""15字节遥控指令")时,载荷必须带长度限定词
 * 逐字使用定义名(2026-08-27 用户裁定:只写"遥控指令"不指明长度是缺陷——
 * 两种长度是两种格式,按分组规则各成一个用例)。基名 → 限定名列表
 */
export function extractLengthVariantBases(corpus: string): Map<string, string[]> {
  const bases = new Map<string, string[]>()
  // 惰量捕获止于首个"指令/数据块"后缀(贪婪会把"…指令和15字节遥控"整段卷进
  // 基名);数据流表格标题多用"长度10字节的遥控指令"形态,剥前导"的"归一到
  // 基名。后缀不只"指令":"249字节上行数据块""72字节上行数据块"是数据块
  // 后缀的同名长度变体,同样必须带限定词各立用例(2026-08-28 取证:只认
  // "指令"后缀时上行数据块变体表为空,门禁从未生效,大小信息被 worker 丢失)
  for (const match of corpus.matchAll(/(\d+)字节([一-龥A-Za-z]{2,12}?(?:指令|数据块))/g)) {
    const base = match[2]!.replace(/^的+/, "")
    const qualified = `${match[1]!}字节${base}`
    if (qualified === `字节${base}`) continue
    const list = bases.get(base) ?? []
    if (!list.includes(qualified)) list.push(qualified)
    bases.set(base, list)
  }
  // 只出现一种长度的不是变体(单一定义名,无需限定词)
  for (const [base, list] of [...bases]) {
    if (list.length < 2) bases.delete(base)
  }
  return bases
}

/** 结构检测可选项:长度变体指令基名表(数据流定义语料提取) */
export interface StructureAnalysisOptions {
  requirementCorpus?: string
  functionalModel?: FunctionalModel
  autonomousTelemetry?: boolean
  lengthVariantBases?: Map<string, string[]>
  /** 当前 requirement 明确定义辅助数据包1+包2，末包正确之前补齐剩余错误。 */
  functionalTwoAuxiliaryPackets?: boolean
  /** 内存读出指令的合法地址区间，用于4字节对齐和边界覆盖门禁。 */
  functionalMemoryReadRanges?: MemoryAddressRange[]
  /** 内存数据轮询需要“3s启动5s周期内存读出，每次2s后轮询”。 */
  functionalMemoryPollingPrerequisite?: boolean
  /** requirement 语料明确要求覆盖的一级 CAN 通道；在整个用例集按指令核对对应案。 */
  requiredPrimaryBuses?: Array<"CANA" | "CANB">
}

/**
 * 验证“每条指令 × 每条接收总线”的 suite 级完整性。
 *
 * 单用例只应包含 CANA 或 CANB 之一；另一条总线由同指令的对应用例
 * 覆盖。旧逻辑在每个用例内要求两条总线，与 mixed_bus 拆分门禁直接冲突。
 */
export function analyzeRequiredPrimaryBusCoverage(
  cases: Array<{
    case_name?: string
    test_purpose?: string
    test_step: StructureStep[]
  }>,
  requiredBuses: Array<"CANA" | "CANB">,
): StructureViolation[] {
  const required = [...new Set(requiredBuses)]
  if (required.length < 2) return []

  const coverage = new Map<string, {
    buses: Set<"CANA" | "CANB">
    caseNames: Set<string>
  }>()

  for (const caseRecord of cases) {
    const caseName = String(caseRecord.case_name ?? "未命名用例")
    if (DUAL_BUS_SUBJECT_PATTERN.test(`${caseName} ${caseRecord.test_purpose ?? ""}`)) continue

    for (const step of caseRecord.test_step ?? []) {
      const desc = descOfStep(step)
      if (!REQUEST_DIRECTION_PATTERN.test(desc) || isSecondarySimulatedResponse(desc)) continue
      if (isPrimaryTelemetryReadback(desc) && caseRecord.test_step.some((s) => isSecondarySimulatedResponse(descOfStep(s)))) continue
      const phrase = instructionPhraseFromStep(`${desc}\n${expectOfStep(step)}`)
      if (!phrase) continue
      const item = coverage.get(phrase) ?? {
        buses: new Set<"CANA" | "CANB">(),
        caseNames: new Set<string>(),
      }
      const bus = busOfStepDesc(desc)
      if (bus) item.buses.add(bus)
      item.caseNames.add(caseName)
      coverage.set(phrase, item)
    }
  }

  const violations: StructureViolation[] = []
  for (const [phrase, item] of coverage) {
    const missing = required.filter((bus) => !item.buses.has(bus))
    if (missing.length === 0) continue
    const caseNames = [...item.caseNames]
    violations.push({
      type: "missing_bus_counterpart",
      case_name: caseNames.join("、") || phrase,
      message:
        `指令"${phrase}"在当前需求用例集中已覆盖 ${[...item.buses].join("/")}，` +
        `但缺少 ${missing.join("/")} 对应的独立用例。应按“每条指令×每条总线”分案，` +
        "不得把 CANA/CANB 合并到同一用例。",
    })
  }
  return violations
}

export function analyzeCaseStructure(
  cases: Array<{
    case_name?: string
    test_purpose?: string
    test_step: StructureStep[]
  }>,
  options?: StructureAnalysisOptions,
): CaseStructureAnalysis {
  const violations: StructureViolation[] = analyzeRequiredPrimaryBusCoverage(
    cases,
    options?.requiredPrimaryBuses ?? [],
  )

  // 内存读出地址边界是 requirement 级覆盖，需要跨用例统计。
  // 每个接收总线、每个地址区间都覆盖 lower-1/lower/lower+1/
  // 中间有效值/upper-1/upper/upper+1；窄区间候选重合时自然去重。
  const memoryReadRanges = options?.functionalMemoryReadRanges ?? []
  if (memoryReadRanges.length > 0) {
    for (const bus of ["CANA", "CANB"] as const) {
      const relevantCases = cases
        .map((caseRecord, index) => ({ caseRecord, index }))
        .filter(({ caseRecord }) => (caseRecord.test_step ?? []).some((step) => {
          const desc = descOfStep(step)
          return busOfStepDesc(desc) === bus && SEND_STEP_PATTERN.test(desc) && /内存读出指令/.test(desc)
        }))
      const busSteps = relevantCases.flatMap(({ caseRecord }) => caseRecord.test_step ?? [])
        .map((step) => ({ desc: descOfStep(step), expected: expectOfStep(step) }))
        .filter(({ desc }) => busOfStepDesc(desc) === bus && SEND_STEP_PATTERN.test(desc) && /内存读出指令/.test(desc))
      if (busSteps.length === 0) continue
      const fieldErrorCases = relevantCases.filter(({ caseRecord }) =>
        (caseRecord.test_step ?? []).some((step) =>
          /(?:仲裁场|控制场|LENGTH|TITLE|INDEX|SUM|数据字|W\d+)\s*错误/i.test(descOfStep(step))
        )
      )
      const boundaryCases = relevantCases.filter(({ caseRecord }) => {
        if (/边界/.test(`${caseRecord.case_name ?? ""} ${caseRecord.test_purpose ?? ""}`)) return true
        const addresses = new Set(
          (caseRecord.test_step ?? [])
            .map((step) => inputAddressOfMemoryRead(descOfStep(step)))
            .filter((value): value is bigint => value !== null),
        )
        return addresses.size >= 5
      })
      const fieldCaseSteps = fieldErrorCases.length === 1
        ? fieldErrorCases[0]!.caseRecord.test_step ?? []
        : []
      const fieldErrorIndexes = (pattern: RegExp): number[] => fieldCaseSteps
        .map((step, index) => ({ desc: descOfStep(step), index }))
        .filter(({ desc }) => pattern.test(desc) && /错误/.test(desc))
        .map(({ index }) => index)
      const arbitrationIndexes = fieldErrorIndexes(/仲裁场/)
      const controlIndexes = fieldErrorIndexes(/控制场/)
      const requiredFieldsCovered = arbitrationIndexes.length > 0
        && controlIndexes.length > 0
        && fieldErrorIndexes(/LENGTH/i).length > 0
        && fieldErrorIndexes(/TITLE/i).length > 0
        && fieldErrorIndexes(/INDEX/i).length > 0
        && fieldErrorIndexes(/SUM/i).length > 0
      const arbitrationAndControlSeparated = arbitrationIndexes.some((index) => !controlIndexes.includes(index))
        && controlIndexes.some((index) => !arbitrationIndexes.includes(index))
      const misalignmentCoveredInFieldCase = fieldCaseSteps.some((step) => {
        const desc = descOfStep(step)
        const address = inputAddressOfMemoryRead(desc)
        return (address !== null && address % 4n !== 0n)
          || /(?:非|[未不])\s*4字节对齐/.test(desc)
      })
      if (relevantCases.length !== 2
        || fieldErrorCases.length !== 1
        || boundaryCases.length !== 1
        || fieldErrorCases[0]?.index === boundaryCases[0]?.index
        || !requiredFieldsCovered
        || !arbitrationAndControlSeparated
        || !misalignmentCoveredInFieldCase) {
        violations.push({
          type: "invalid_memory_read_scenarios",
          case_name: `${bus}总线内存读出指令场景划分`,
          message:
            `${bus}总线的内存读出指令必须且只能收敛为两个场景用例:` +
            "一个字段错误用例（包含全部协议字段错误、非4字节对齐错误及正确恢复），" +
            "一个地址边界用例（同时覆盖需求中所有地址区间）。" +
            "字段用例至少分步覆盖仲裁场、控制场、LENGTH、TITLE、INDEX、SUM和非4字节对齐地址；" +
            "禁止再按MRAM/SRAM、区内/区外或单字段拆分。",
        })
      }
      const addresses = new Set(
        busSteps.map(({ desc }) => inputAddressOfMemoryRead(desc)).filter((value): value is bigint => value !== null),
      )
      for (const range of memoryReadRanges) {
        let lower: bigint
        let upper: bigint
        try {
          lower = BigInt(range.lower)
          upper = BigInt(range.upper)
        } catch {
          continue
        }
        if (upper < lower) continue
        const required = new Set([
          lower - 1n,
          lower,
          lower + 1n,
          upper - 1n,
          upper,
          upper + 1n,
        ])
        const missing = [...required].filter((value) => !addresses.has(value))
        const needsDistinctMiddle = upper - lower >= 4n
        const hasAlignedMiddle = [...addresses].some((value) =>
          value > lower + 1n && value < upper - 1n && value % 4n === 0n
        )
        if (missing.length > 0 || (needsDistinctMiddle && !hasAlignedMiddle)) {
          violations.push({
            type: "incomplete_memory_read_boundary",
            case_name: `${bus}总线内存读出地址边界测试`,
            message:
              `${bus}总线未完整覆盖地址区间[${hexAddress(lower)},${hexAddress(upper)}]的边界值:` +
              `${missing.length > 0 ? ` 缺少${missing.map(hexAddress).join("、")}` : ""}` +
              `${needsDistinctMiddle && !hasAlignedMiddle ? " 缺少一个区间内部的4字节对齐值" : ""}。` +
              "应覆盖下边界-1/下边界/下边界+1/中间值/上边界-1/上边界/上边界+1，重合值去重。",
          })
        }
      }
    }
  }

  let caseIndexCursor = 0
  for (const caseRecord of cases) {
    const caseIndex = caseIndexCursor++
    const caseName = String(caseRecord.case_name ?? "未命名用例")
    const steps = caseRecord.test_step ?? []
    if (options?.functionalModel === "manual") continue
    for (const message of validateFunctionalModelSteps(options?.functionalModel ?? "default", steps.map((step) => ({
      步骤描述: descOfStep(step), 预期结果: expectOfStep(step),
    })), options?.requirementCorpus)) {
      violations.push({ type: "functional_model_violation", case_name: caseName, case_index: caseIndex, message })
    }
    const auxiliaryPacketNumbers = new Set(
      steps.map((step) => auxiliaryPacketNumber(descOfStep(step))).filter((value): value is 1 | 2 => value !== null),
    )
    const auxiliaryTwoPacketSubject = options?.functionalTwoAuxiliaryPackets === true
      || (auxiliaryPacketNumbers.has(1) && auxiliaryPacketNumbers.has(2))
    const memoryPollingSubject = options?.functionalMemoryPollingPrerequisite === true

    if (memoryReadRanges.length > 0) {
      const incorrectlyAcceptedIndexes = steps
        .map((step, index) => ({
          desc: descOfStep(step),
          expected: expectOfStep(step),
          index,
        }))
        .filter(({ desc, expected }) => {
          if (!SEND_STEP_PATTERN.test(desc) || !/内存读出指令/.test(desc)) return false
          const address = inputAddressOfMemoryRead(desc)
          if (address === null || address % 4n === 0n) return false
          const expectedAccepts = /(正确接收|正常处理|对齐后地址.+(?:读出|更新)|正确指令计数.+加1|内存读出数据更新)/.test(expected)
          const expectedRejects = /(错误指令|不(?:处理|执行|读取|更新)|错误.+计数.+加1|正确.+计数.+保持)/.test(expected)
          return expectedAccepts || (isCorrectSendStep(desc) && !expectedRejects)
        })
        .map(({ index }) => index)
      if (incorrectlyAcceptedIndexes.length > 0) {
        violations.push({
          type: "invalid_memory_read_alignment",
          case_name: caseName,
          case_index: caseIndex,
          message:
            `用例"${caseName}"的第 ${incorrectlyAcceptedIndexes.map((index) => index + 1).join("、")} 个步骤` +
            "把非4字节对齐的内存读出地址对齐后当成正确指令处理。非4字节对齐本身就是错误指令，" +
            "必须不读取、不更新内存读出数据，正确计数不增加，错误计数加1。",
        })
      }
    }

    if (memoryPollingSubject) {
      const firstDesc = descOfStep(steps[0])
      const prerequisiteOk = /第\s*3(?:\.0+)?\s*秒/.test(firstDesc)
        && /以\s*5(?:\.0+)?\s*秒为周期/.test(firstDesc)
        && /循环发送.+内存读出指令/.test(firstDesc)
        && isCorrectSendStep(firstDesc)
      const pollingSteps = steps
        .slice(1)
        .map((step, index) => ({ desc: descOfStep(step), index: index + 1 }))
        .filter(({ desc }) => SEND_STEP_PATTERN.test(desc) && /内存数据轮询(?:控制序列|指令)/.test(desc))
      const malformedPollingIndexes: number[] = []
      for (let i = 0; i < pollingSteps.length; i += 1) {
        const item = pollingSteps[i]!
        const time = absoluteTimeOfStep(item.desc)
        const expectedTime = 5 + i * 5
        const expectedKind = i % 2 === 0 ? "correct" : "error"
        const actualKind = isCorrectSendStep(item.desc)
          ? "correct"
          : isErrorSendStep(item.desc) ? "error" : "unknown"
        if (time === null || Math.abs(time - expectedTime) > 1e-9 || actualKind !== expectedKind) {
          malformedPollingIndexes.push(item.index)
        }
      }
      const unexpectedLaterMemoryRead = steps.slice(1).some((step) => {
        const desc = descOfStep(step)
        return SEND_STEP_PATTERN.test(desc) && /内存读出指令/.test(desc)
      })
      if (!prerequisiteOk
        || pollingSteps.length === 0
        || malformedPollingIndexes.length > 0
        || unexpectedLaterMemoryRead) {
        violations.push({
          type: "invalid_memory_polling_schedule",
          case_name: caseName,
          case_index: caseIndex,
          message:
            `用例"${caseName}"未按内存数据轮询的强制时序编排:` +
            "第1步必须在第3.0秒启动以5秒为周期循环发送正确的内存读出指令；" +
            "后续只在第5.0、10.0、15.0秒…（每次读出指令发出2秒后）发送内存数据轮询控制序列，" +
            "并从正确开始按正确/单字段错误交替。",
        })
      }
    }

    // One validator owns every numbered multi-packet stream, across test types.
    const packetSequence = analyzePacketSequences(steps.map((step) => ({
      步骤描述: descOfStep(step), 预期结果: expectOfStep(step),
    })), { required: auxiliaryTwoPacketSubject, packetCount: auxiliaryTwoPacketSubject ? 2 : undefined, corpus: options?.requirementCorpus })
    for (const issue of packetSequence.issues) violations.push({
      type: auxiliaryTwoPacketSubject ? "invalid_auxiliary_interleave" : "functional_model_violation",
      case_name: caseName, case_index: caseIndex, message: issue.message,
    })

    // ⓪ 步骤时间:业务步骤禁止第0.0秒/第0秒——0 秒时刻属软平台初始化,
    // 业务触发/应答步骤应从第1秒后开始(本套件惯例第3.0秒起,软平台启动
    // 步骤占用前段;启动步骤由套件构建器注入,不经过本检测)
    // (2026-08-26 用户裁定:"第一个步骤的时间绝对不是0.0秒")
    const zeroTimeIndexes = steps
      .map((step, index) => ({ desc: descOfStep(step), index }))
      .filter(({ desc }) => /第\s*0(?:\.0+)?\s*秒/.test(desc))
      .map(({ index }) => index)
    if (zeroTimeIndexes.length > 0) {
      violations.push({
        type: "zero_time_step",
        case_name: caseName,
        message:
          `用例"${caseName}"的第 ${zeroTimeIndexes.map((i) => i + 1).join("、")} 个步骤时间为第0.0秒——` +
          `业务步骤禁止从第0秒开始(0秒时刻属软平台初始化),触发/应答步骤应设合理起始时间` +
          `(本套件惯例第3.0秒起,逐步骤递增)`,
      })
    }

    // ⓪b 二级总线触发结构:有二级模拟应答步骤的用例必须有一级触发步骤,
    //    且循环触发声明唯一(2026-08-26 晚取证:worker 对遥测轮询/切换用例
    //    漏写触发步骤→只有二级数据的半截用例;对遥控指令用例重复声明 6 次
    //    循环发送)。触发与应答是同一测试的两半,拆开即两者都失效
    const secondaryDescs = steps
      .map((step) => descOfStep(step))
      .filter((desc) => isSecondarySimulatedResponse(desc))
    const functionalTelemetry = options?.functionalModel === "spi-telemetry" || options?.functionalModel === "secondary-telemetry"
    if (secondaryDescs.length > 0) {
      const hasPrimaryTrigger = hasEffectivePrimaryTrigger(steps, functionalTelemetry)
      if (!hasPrimaryTrigger && !options?.autonomousTelemetry) {
        violations.push({
          type: "missing_primary_trigger",
          case_name: caseName,
          message:
            `用例"${caseName}"的全部发送步骤都在二级总线上,没有任何一级总线触发步骤——` +
            `二级模拟应答(下位机视角)必须由一级总线指令触发(循环触发:以1秒为周期循环发送,` +
            `唯一一条触发步骤),一级触发与二级应答是同一测试的两半,不得拆开`,
        })
      }
      const loopTriggerIndexes = steps
        .map((step, index) => ({ desc: descOfStep(step), index }))
        .filter(({ desc }) => LOOP_TRIGGER_STEP_PATTERN.test(desc)
          && REQUEST_DIRECTION_PATTERN.test(desc)
          && !(functionalTelemetry && isPrimaryTelemetryReadback(desc))
          && stepActionOnPrimaryBus(desc))
        .map(({ index }) => index)
      if (loopTriggerIndexes.length > 1) {
        violations.push({
          type: "duplicate_loop_trigger",
          case_name: caseName,
          message:
            `用例"${caseName}"的第 ${loopTriggerIndexes.map((i) => i + 1).join("、")} 个步骤重复声明循环发送——` +
            `循环触发步骤必须唯一(首条声明后按周期自动重发),后续步骤不再编写触发步骤`,
        })
      }
      // ⓪c 站地址:二级指令/数据必须指明站地址(站地址↔从节点对应关系在
      //    二级总线数据流定义部分;一个用例只对应一个从节点,全步骤统一)
      if (!secondaryDescs.some((desc) => desc.includes("站地址"))) {
        violations.push({
          type: "missing_station_address",
          case_name: caseName,
          message:
            `用例"${caseName}"的二级总线发送步骤均未指明站地址——` +
            `二级CAN指令/数据必须写明从节点的站地址(从站地址定义表选定一个从节点,全用例统一),` +
            `预期结果中的站地址参数应写该站地址具体值而非"该应答中站地址"`,
        })
      }
    }

    // ⓪d 长度变体限定词:数据流定义中同名指令有长度变体(如 10字节/15字节
    //    遥控指令)时,一级发送步骤载荷必须带长度限定词逐字使用定义名
    //    (2026-08-27 用户裁定:不指明长度无法确定测的是哪种格式)。只查一级
    //    请求方向步骤——二级应答按数据流定义的应答名(单一格式)
    const variantBases = options?.lengthVariantBases
    if (variantBases && variantBases.size > 0) {
      const bareHits = new Map<string, number[]>()
      steps.forEach((step, index) => {
        const desc = descOfStep(step)
        if (!REQUEST_DIRECTION_PATTERN.test(desc) || !stepActionOnPrimaryBus(desc)) return
        for (const [base] of variantBases) {
          // 裸基名出现且不被"N字节(的)"限定(限定名内含基名,负向后顾排除;
          // 两种限定形态:"10字节遥控指令"与"10字节的遥控指令")
          if (new RegExp(`(?<![0-9]字节)(?<!字节的)${base}`).test(desc)) {
            const list = bareHits.get(base) ?? []
            list.push(index)
            bareHits.set(base, list)
          }
        }
      })
      for (const [base, indexes] of bareHits) {
        const variants = variantBases.get(base)!
        violations.push({
          type: "missing_instruction_length_variant",
          case_name: caseName,
          message:
            `用例"${caseName}"的第 ${indexes.map((i) => i + 1).join("、")} 个步骤载荷用裸指令名"${base}"——` +
            `数据流定义中该指令有 ${variants.length} 种长度格式(${variants.join("、")}),` +
            `载荷必须带长度限定词逐字使用定义名(如"${variants[0]}");` +
            `不同长度=不同格式,每种长度独立一个用例`,
        })
      }
    }

    // ⓪e 上注数据块类型混用(SpaceWire):管控程序上注与二级节点上注是不同
    //    数据块类型/ID 族,必须分别独立成用例(2026-09-02 用户裁定)。此类步骤
    //    无发送动词,混指令门禁不覆盖,单独检测
    const MASTER_UPLOAD_PATTERN = /(管控|管理控制)[^,，。;；]{0,8}上注/
    const SLAVE_UPLOAD_PATTERN = /二级节点(程序)?上注/
    const hasMasterUpload = steps.some((step) => MASTER_UPLOAD_PATTERN.test(descOfStep(step)))
    const hasSlaveUpload = steps.some((step) => SLAVE_UPLOAD_PATTERN.test(descOfStep(step)))
    if (hasMasterUpload && hasSlaveUpload) {
      violations.push({
        type: "mixed_upload_type",
        case_name: caseName,
        message:
          `用例"${caseName}"同时包含管控程序上注与二级节点上注数据块步骤——` +
          `两者是不同的上注数据块类型/ID 族(如 2501H=管控、2502H~2511H=二级节点),` +
          `测试目的不同,必须分别独立成用例;请按上注类型拆分后重新生成`,
      })
    }

    // ① 双总线分开:同一指令短语在 CANA 与 CANB 上都有发送步骤 = 混用
    //    (验证类步骤不经发送动词,不参与;SPI 输入 + CANA/CANB 遥测输出校验不会误报)
    const subjectExempt = DUAL_BUS_SUBJECT_PATTERN.test(`${caseName} ${caseRecord.test_purpose ?? ""}`)
    if (!subjectExempt) {
      const busesByPhrase = new Map<string, Set<string>>()
      for (const step of steps) {
        const desc = descOfStep(step)
        const bus = busOfStepDesc(desc)
        if (!bus || !SEND_STEP_PATTERN.test(desc)) continue
        const phrase = instructionPhraseFromStep(`${desc}
${expectOfStep(step)}`)
        if (!phrase) continue
        const set = busesByPhrase.get(phrase) ?? new Set<string>()
        set.add(bus)
        busesByPhrase.set(phrase, set)
      }
      for (const [phrase, buses] of busesByPhrase) {
        if (buses.has("CANA") && buses.has("CANB")) {
          violations.push({
            type: "mixed_bus",
            case_name: caseName,
            message:
              `用例"${caseName}"中指令"${phrase}"同时通过 CANA 与 CANB 总线发送——` +
              `双冗余总线必须每条总线各自独立一个用例(字段/序号校核类测试),不得混在同一用例;` +
              `总线切换/交替/冗余备份类行为测试除外`,
          })
        }
      }
    }

    // ①b 用例内多指令:一个用例混入多条不同指令 = 违反"一条指令的所有
    //    情况在一个用例中完成"的划分原则(与跨 TR 拆分互为对偶:一个查
    //    "同指令被拆散",一个查"不同指令被合并")。只统计请求方向步骤
    //    (发送/下发/注入)的指令短语——应答步骤("SPI总线返回机构控制
    //    指令应答")的短语是被测指令的应答内容,不是用例内第二条指令;
    //    二级总线模拟应答同理("主动发送模拟被动应答"的模型下应答步骤
    //    用发送动词,但其短语仍是被转发指令的应答内容)
    if (!subjectExempt
      && !auxiliaryTwoPacketSubject
      && !memoryPollingSubject
      && options?.functionalModel !== "ordered-upload"
      && options?.functionalModel !== "fpga-telemetry"
      && !FPGA_TELEMETRY_SUBJECT_PATTERN.test(`${caseName} ${caseRecord.test_purpose ?? ""}`)) {
      const phrases = new Set<string>()
      for (const [index, step] of steps.entries()) {
        const desc = descOfStep(step)
        if (!REQUEST_DIRECTION_PATTERN.test(desc)) continue
        if (isSecondarySimulatedResponse(desc)) continue
        if (secondaryDescs.length && isPrimaryTelemetryReadback(desc)) continue
        const phrase = packetSequence.stepIndexes.has(index) ? packetOperationIdentity(desc) : instructionPhraseFromStep(`${desc}
${expectOfStep(step)}`)
        if (phrase) phrases.add(phrase)
      }
      if (phrases.size > 1) {
        const phraseList = [...phrases]
        violations.push({
          type: "mixed_instruction",
          case_name: caseName,
          phrases: phraseList,
          message:
            `用例"${caseName}"内混入 ${phraseList.length} 条不同指令(${phraseList.join("、")})——` +
            `一种功能/一条指令作为一个完整用例,同一指令的所有情况在同一用例步骤中完成测试,` +
            `不同指令必须拆分为各自独立的用例(双总线再每条总线独立)`,
        })
      }
    }

    // ② 错误-正确配对:每个字段/字节错误发送步骤后,必须紧跟同指令同总线的"全部正确"步骤。
    // 连续错误堆叠主题(自动切换/连续N次未收到正确)豁免:连续错误正是测试
    // 目的(如 TR-JK-010 "连续3次未收到正确遥测→切换总线"),恢复发生在切换
    // 之后,逐错误配对会误判(2026-08-26 自动切换测试取证)。
    // 二级总线两种触发写法的恢复单元不同(2026-08-26 用户拍板循环时间优化):
    // - 显式逐条触发:恢复单元是[一级重发]+[二级正确应答]两步(secondaryRecoveryPaired)
    // - 循环触发(触发步骤带 循环/以N秒为周期,循环发送自动重发):恢复单元是
    //   紧跟的[二级正确应答]单步——循环步骤自动按周期重发,无需也不应再写触发步骤
    const loopTriggerMode = steps.some((step) =>
      !(functionalTelemetry && isPrimaryTelemetryReadback(descOfStep(step)))
      && /以[\d.]+秒?为周期|循环发送|周期发送/.test(descOfStep(step)))
    const consecutiveErrorSubject = CONSECUTIVE_ERROR_SUBJECT_PATTERN.test(
      `${caseName} ${caseRecord.test_purpose ?? ""}`)
    for (let i = 0; i < steps.length; i++) {
      const desc = descOfStep(steps[i])
      if (!isErrorSendStep(desc)) continue
      if (packetSequence.stepIndexes.has(i)) continue
      if (options?.functionalModel === "ordered-upload") continue // Dedicated accepted-packet sequence check above.
      if (consecutiveErrorSubject) continue
      const phrase = instructionPhraseFromStep(`${desc}
${expectOfStep(steps[i])}`)
      const bus = busOfStepDesc(desc)
      const next = i + 1 < steps.length ? descOfStep(steps[i + 1]) : ""
      const nextIsCorrectSecondary = isCorrectSendStep(next) && SECONDARY_CHANNEL_PATTERN.test(next)
      const secondaryPaired = isSecondarySimulatedResponse(desc)
        && (loopTriggerMode || options?.autonomousTelemetry
          ? nextIsCorrectSecondary
          : secondaryRecoveryPaired(steps, i))
      const paired = secondaryPaired
        || (!isSecondarySimulatedResponse(desc)
          && isCorrectSendStep(next)
          && busOfStepDesc(next) === bus
          && (!phrase || instructionPhraseFromStep(`${next}
${expectOfStep(steps[i + 1])}`) === phrase))
      if (!paired) {
        violations.push({
          type: "missing_correct_after_error",
          case_name: caseName,
          message:
            `用例"${caseName}"步骤"${desc.slice(0, 40)}…"注入错误后未紧跟同指令同总线的"全部正确"步骤` +
            `(下一个步骤是"${next.slice(0, 30) || "(无)"}")——步骤必须按"全部正确→某字段错误→全部正确"交替组织,` +
            `每个错误步骤都要配一条恢复正常的正确步骤`,
        })
      }
    }

    // 批注违规所属用例下标(2026-09-08 P2):同名用例时按名称定位会错位
    // 牵连无辜用例——循环内逐案批注保证归属精确,修复端优先按下标定位
    for (const violation of violations) {
      if (violation.case_name === caseName && violation.case_index === undefined) {
        violation.case_index = caseIndex
      }
    }
  }

  return { violations }
}

/** 指令短语 → 出现它的用例下标集合(聚合检测与确定性修复共用) */
function phraseCaseIndexes(
  cases: Array<{
    test_step: StructureStep[]
  }>,
): Map<string, number[]> {
  const casesByPhrase = new Map<string, number[]>()
  cases.forEach((caseRecord, caseIndex) => {
    const phrases = new Set<string>()
    for (const step of caseRecord.test_step ?? []) {
      // 二级模拟应答(二级CAN/SPI)的短语是被转发指令的应答内容,不是独立
      // 指令——计入会把预期结果半区的计数器/遥测帧名捞成幽灵短语("SPI错误
      // 轮询""缓变遥测数据遥测帧2"),跨用例误报聚合违规(2026-08-28 取证)。
      // 描述字段按双拼写读取(与 StructureStep 判定同一纪律)
      const desc = descOfStep(step)
      if (isSecondarySimulatedResponse(desc)) continue
      if (isPrimaryTelemetryReadback(desc) && caseRecord.test_step.some((s) => isSecondarySimulatedResponse(descOfStep(s)))) continue
      const phrase = instructionPhraseFromStep(`${desc}\n${expectOfStep(step)}`)
      if (phrase) phrases.add(phrase)
    }
    for (const phrase of phrases) {
      const list = casesByPhrase.get(phrase) ?? []
      list.push(caseIndex)
      casesByPhrase.set(phrase, list)
    }
  })
  return casesByPhrase
}

export function analyzeCaseAggregation(
  cases: Array<{
    case_name?: string
    test_purpose?: string
    covered_tr_items?: string[]
    test_step: StructureStep[]
  }>,
  requirementTrIds: string[],
): CaseAggregationAnalysis {
  const violations: AggregationViolation[] = []
  const warnings: string[] = []

  const coveredKeyOf = (covered?: string[]) => [...(covered ?? [])].sort().join(",")

  // 连续错误堆叠主题(自动切换/连续N次未收到)的用例是独立测试模型,
  // 其一级指令与其余用例同名(如都用"遥控指令"验证)不构成"同一指令拆散"——
  // 跨用例聚合压力曾把切换用例与错误处理用例误判为拆分(2026-08-26 晚取证)
  const isConsecutiveErrorSubjectCase = (index: number): boolean =>
    CONSECUTIVE_ERROR_SUBJECT_PATTERN.test(
      `${cases[index]?.case_name ?? ""} ${cases[index]?.test_purpose ?? ""}`)

  for (const [phrase, caseIndexes] of phraseCaseIndexes(cases)) {
    const aggregableIndexes = caseIndexes.filter((index) => !isConsecutiveErrorSubjectCase(index))
    if (aggregableIndexes.length < 2) continue
    // 总线感知分组:同指令在 CANA/CANB 各自独立用例是双总线分开规则的
    // 正当拆分,不算跨 TR 拆分违规;只有同(指令,总线)组内拆散多个
    // covered 不同的用例才是真违规。跨总线 covered 不对称是内容缺口,
    // 降为警告提示补齐(2026-08-21 修复回放取证:总线盲判定与总线分开
    // 规则自相矛盾,曾把修复后的正当双总线用例报成"必须聚合")
    const casesByBus = new Map<string, number[]>()
    const busLabelOfCase = new Map<number, string>()
    for (const index of aggregableIndexes) {
      const buses = new Set<string>()
      for (const step of cases[index].test_step ?? []) {
        const desc = descOfStep(step)
        if (!SEND_STEP_PATTERN.test(desc)) continue
        if (instructionPhraseFromStep(`${desc}\n${expectOfStep(step)}`) !== phrase) continue
        const bus = busOfStepDesc(desc)
        if (bus) buses.add(bus)
      }
      const label = buses.size === 1 ? [...buses][0]! : buses.size === 0 ? "未标注总线" : "多总线"
      busLabelOfCase.set(index, label)
      const list = casesByBus.get(label) ?? []
      list.push(index)
      casesByBus.set(label, list)
    }
    let reported = false
    for (const [busLabel, busCaseIndexes] of casesByBus) {
      if (busCaseIndexes.length < 2) continue
      const coveredKeys = busCaseIndexes.map((i) => coveredKeyOf(cases[i].covered_tr_items))
      // 各用例 covered 完全一致时不判违规:同一 TR 内的用例拆分不在
      // 跨 TR 聚合规则约束范围(不同字节长度/格式的指令短语本就不同)
      if (new Set(coveredKeys).size <= 1) continue
      const caseNames = busCaseIndexes.map((i) => String(cases[i].case_name ?? `case[${i}]`))
      const coveredUnion = [...new Set(busCaseIndexes.flatMap((i) => cases[i].covered_tr_items ?? []))]
      violations.push({
        instruction_phrase: phrase,
        case_names: caseNames,
        covered_tr_items: coveredUnion,
        case_indexes: busCaseIndexes,
        message:
          `指令"${phrase}"(${busLabel})的不同情况被拆散在 ${busCaseIndexes.length} 个覆盖不同 TR 子集的用例中` +
          `（${caseNames.join("、")}，覆盖 ${coveredUnion.join("、") || "无"}）。` +
          `同一指令的多种情况即使分散在多个 TR-ID 描述条目中也必须聚合到同一个用例中一起测试，` +
          `不得按 TR-ID 逐条拆分用例`,
      })
      reported = true
    }
    // 跨总线 covered 不对称:双总线分开正确,但两总线应对称覆盖该指令全部情况。
    // 比较必须剥掉总线标签只比覆盖集内容——带标签的字符串恒不同,曾让对称
    // 覆盖也告警(2026-08-26 取证:15 条"覆盖不一致"全部是两侧集合相同的伪警告)
    if (!reported && casesByBus.size > 1) {
      const busCovered = [...casesByBus.entries()]
        .filter(([label]) => label !== "未标注总线")
        .map(([label, indexes]) => `${label}:[${[...new Set(indexes.flatMap((i) => cases[i].covered_tr_items ?? []))].join("、") || "无"}]`)
      if (new Set(busCovered.map((s) => s.slice(s.indexOf(":") + 1))).size > 1) {
        warnings.push(
          `指令"${phrase}"在 CANA/CANB 两条总线的用例覆盖不一致(${busCovered.join(" / ")})——` +
          `双总线分开用例是正确结构,但两总线应对称覆盖该指令的全部情况,建议重派补齐缺失总线的情况`,
        )
      }
    }
  }

  // TR 覆盖完整性:全部用例 covered 并集必须覆盖需求组全部 TR——缺失 TR
  // 的检查情况整体缺席是硬违规(2026-08-24 两轮运行取证:8 TR 组仅覆盖 4 个,
  // 每指令恰好一个用例、无跨用例短语碰撞,拆分检测与全单TR警告均不可见)
  const coveredUnion = new Set(cases.flatMap((c) => c.covered_tr_items ?? []))
  const coverage_gaps = requirementTrIds.filter((trId) => !coveredUnion.has(trId))

  if (requirementTrIds.length > 1 && cases.length > 0) {
    const allSingle = cases.every((c) => (c.covered_tr_items ?? []).length <= 1)
    if (allSingle) {
      warnings.push(
        `需求项含 ${requirementTrIds.length} 个 TR，但全部 ${cases.length} 个用例只覆盖单一 TR——` +
        `请确认已按指令/数据流类型跨 TR 聚合（若各用例确属不同指令类型则此警告可忽略）`,
      )
    }
  }

  return { violations, warnings, coverage_gaps }
}

/**
 * 聚合规则与拆分规则的矛盾消解(2026-09-08 P3 取证):SWRC 组同批收到
 * "管控/二级节点必须分开"(mixed_upload_type)与"上注数据块必须聚合"
 * (aggregation 按数据块短语)两个方向相反的指令——拆分规则(按上注类型拆分用例)比聚合
 * 规则(按共享短语合并)更具体时,聚合违规对涉及用例让位,不再同时下达。
 */
export function suppressContradictoryAggregation(
  aggregation: CaseAggregationAnalysis,
  structure: CaseStructureAnalysis,
): CaseAggregationAnalysis {
  const uploadSplitCases = new Set(
    structure.violations
      .filter((violation) => violation.type === "mixed_upload_type")
      .map((violation) => violation.case_name),
  )
  if (uploadSplitCases.size === 0) return aggregation
  return {
    ...aggregation,
    violations: aggregation.violations.filter(
      (violation) => !violation.case_names.some((name) => uploadSplitCases.has(name)),
    ),
  }
}

// ============================================================
// DETERMINISTIC STRUCTURE REPAIR (确定性兜底修复,2026-08-21 用户拍板)
// ============================================================
// 检测闭环的最后一环:重派一次仍存在聚合/多指令/混总线/配对违规时,不再
// 原样放行落库,而是用确定性代码把用例集重组为"指令×总线"划分:
// ① 牵连用例的全部步骤按(指令短语,总线)全局重分组,同指令同总线合并为
//    一个用例(跨用例合并)、混入的多指令按组拆开;各用例首条发送步骤之前
//    的初始化步骤复制进每个派生用例,其后无指令短语步骤跟随最近的前驱
//    发送步骤所在组;
// ② 错误发送步骤后缺失的"全部正确"配对步骤,克隆同指令同总线最近的前驱
//    正确步骤(无则合成最小步骤)插入,时间取错误步骤+0.5秒,并级联保证
//    时间单调递增。
// 修复后重跑检测,残留违规如实上报(不为零时仍需人工/重派处理)。

export interface RepairableStep {
  /** 双拼写:标准化视图 步骤描述/预期结果,翻译后 Unified 步骤 step_desc/expected_result */
  步骤描述?: string
  预期结果?: string
  step_desc?: string
  expected_result?: string
  [key: string]: unknown
}

export interface RepairableCase {
  case_name?: string
  test_purpose?: string
  covered_tr_items?: string[]
  correspond_fun_id?: string
  test_step: RepairableStep[]
}

export interface CaseRepairResult {
  cases: RepairableCase[]
  actions: string[]
  residual_structure_violations: StructureViolation[]
  residual_aggregation_violations: AggregationViolation[]
}

const STEP_TIME_PATTERN = /第\s*([\d.]+)\s*秒/

function timeOfStep(step: RepairableStep): number | null {
  const match = descOfStep(step).match(STEP_TIME_PATTERN)
  return match ? Number.parseFloat(match[1]) : null
}

function retimeStep(step: RepairableStep, seconds: number): RepairableStep {
  const clone: RepairableStep = { ...step }
  const t = String(seconds)
  // 双拼写字段同步更新:哪种存在改哪种,两者都有则两者都改
  if (typeof clone.步骤描述 === "string" && clone.步骤描述) {
    clone.步骤描述 = clone.步骤描述.replace(STEP_TIME_PATTERN, `第${t}秒`)
  }
  if (typeof clone.step_desc === "string" && clone.step_desc) {
    clone.step_desc = clone.step_desc.replace(STEP_TIME_PATTERN, `第${t}秒`)
  }
  if (typeof clone.temporal === "string" && clone.temporal) {
    clone.temporal = clone.temporal.replace(STEP_TIME_PATTERN, `第${t}秒`)
  }
  return clone
}

export function repairCaseStructure(
  cases: RepairableCase[],
  options?: StructureAnalysisOptions & {
    stationAddressCorpus?: string
    lengthVariantBases?: Map<string, string[]>
    functionalTwoAuxiliaryPackets?: boolean
    functionalMemoryReadRanges?: MemoryAddressRange[]
    functionalMemoryPollingPrerequisite?: boolean
    requiredPrimaryBuses?: Array<"CANA" | "CANB">
  },
): CaseRepairResult {
  const actions: string[] = []
  // Protocol model changes are semantic: do not manufacture CAN triggers or
  // same-packet recovery steps that destroy the required stateful sequence.
  if ((options?.functionalModel && options.functionalModel !== "default") || cases.some((record) =>
    analyzePacketSequences((record.test_step ?? []).map((step) => ({ 步骤描述: descOfStep(step), 预期结果: expectOfStep(step) })),
      { corpus: options?.requirementCorpus }).stepIndexes.size > 0)) {
    return {
      cases, actions,
      residual_structure_violations: analyzeCaseStructure(cases, options).violations,
      residual_aggregation_violations: analyzeCaseAggregation(cases, []).violations,
    }
  }

  // ⓪ 确定性自愈(2026-08-26 晚取证):触发结构/站地址是文本级修正,在重组
  // 与配对之前先治愈——半截用例(只有二级数据)先补齐一级循环触发,后续
  // 配对检测即进入循环模式(恢复单元=单步正确应答),不再产生
  // "[一级重发]+[二级正确应答]"显式恢复单元的连环插入
  const stationAddress = options?.stationAddressCorpus
    ? parseFirstSlaveStationAddress(options.stationAddressCorpus)
    : null
  for (const record of cases) {
    // a. 重复循环触发声明:只保留首条,其余删除(循环按周期自动重发,
    //    重复声明是把循环又当逐条触发写,与循环模型自相矛盾)
    const loopDeclIndexes = (record.test_step ?? [])
      .map((step, index) => ({ step, index }))
      .filter(({ step }) => {
        const desc = descOfStep(step)
        return LOOP_TRIGGER_STEP_PATTERN.test(desc)
          && REQUEST_DIRECTION_PATTERN.test(desc)
          && stepActionOnPrimaryBus(desc)
      })
      .map(({ index }) => index)
    if (loopDeclIndexes.length > 1) {
      const drop = new Set(loopDeclIndexes.slice(1))
      record.test_step = (record.test_step ?? []).filter((_, index) => !drop.has(index))
      actions.push(
        `已去重循环触发:用例"${record.case_name ?? "未命名用例"}"保留第 ${loopDeclIndexes[0]! + 1} 条循环声明,` +
        `删除其余 ${drop.size} 条重复声明(循环触发唯一,按周期自动重发)`,
      )
    }
    // b. 缺一级触发:从二级载荷反推指令名,头部插入唯一循环触发步骤
    //    (验证类步骤不算有效触发——它是收尾确认,顶替不了触发)
    const healedSteps = record.test_step ?? []
    const hasSecondary = healedSteps.some((step) => isSecondarySimulatedResponse(descOfStep(step)))
    const hasPrimary = hasEffectivePrimaryTrigger(healedSteps)
    if (hasSecondary && !hasPrimary) {
      const triggerName = primaryTriggerNameForSecondarySteps(healedSteps)
      if (triggerName) {
        // 一级总线指令不带站地址(2026-08-27 用户裁定:站地址只属于二级总线
        // 步骤;轮询帧格式里的"80H+站地址"是帧内容,不是步骤载荷属性)
        const trigger: RepairableStep = {
          步骤描述: `第3.0秒，通过CANA总线以1秒为周期循环发送${triggerName}。`,
          预期结果:
            `软件接收${triggerName}并按二级总线协议组装后通过二级总线向下位机转发${triggerName}` +
            "（循环时间=1.0，实际发送时刻 3.0s、4.0s…）。",
          operation_type: "send_command",
          channel: "CANA",
          temporal: "第3.0秒",
        }
        record.test_step = [trigger, ...healedSteps]
        actions.push(
          `已补一级循环触发:用例"${record.case_name ?? "未命名用例"}"头部插入"以1秒为周期循环发送${triggerName}"` +
          "(一级触发与二级应答是同一测试的两半,不得拆开)",
        )
      } else {
        actions.push(
          `[无法自愈] 用例"${record.case_name ?? "未命名用例"}"缺少一级触发步骤,且无法从二级载荷反推指令名——需重派补齐`,
        )
      }
    }
    // c. 站地址注入:二级步骤统一标注从节点的站地址(取站地址定义表第一个
    //    从节点,确定性;worker 侧按模板随机挑选)
    if (stationAddress) {
      const needsAddress = (record.test_step ?? []).some((step) => {
        const desc = descOfStep(step)
        return isSecondarySimulatedResponse(desc) && !desc.includes("站地址")
      })
      if (needsAddress) {
        record.test_step = (record.test_step ?? []).map((step) => {
          const desc = descOfStep(step)
          if (!isSecondarySimulatedResponse(desc) || desc.includes("站地址")) return step
          return injectStationAddressIntoStep(step, stationAddress.address)
        })
        actions.push(
          `已注入站地址:用例"${record.case_name ?? "未命名用例"}"二级步骤统一标注站地址${stationAddress.address}` +
          (stationAddress.name ? `(${stationAddress.name})` : "") +
          ",预期中站地址指代同步落为具体值",
        )
      }
    }
  }

  const structure = analyzeCaseStructure(cases as Parameters<typeof analyzeCaseStructure>[0], {
    requirementCorpus: options?.requirementCorpus,
    lengthVariantBases: options?.lengthVariantBases,
    functionalTwoAuxiliaryPackets: options?.functionalTwoAuxiliaryPackets,
    functionalMemoryReadRanges: options?.functionalMemoryReadRanges,
    functionalMemoryPollingPrerequisite: options?.functionalMemoryPollingPrerequisite,
    requiredPrimaryBuses: options?.requiredPrimaryBuses,
  })
  const aggregation = analyzeCaseAggregation(cases as Parameters<typeof analyzeCaseAggregation>[0], [])

  // ① 牵连用例下标:同(指令,总线)组内跨 TR 拆分涉及的 + 混总线/多指令违规的
  const implicated = new Set<number>()
  for (const violation of aggregation.violations) {
    for (const index of violation.case_indexes ?? []) implicated.add(index)
  }
  for (const violation of structure.violations) {
    // 配对缺失由④补配对修复;0秒时间违规由重派修正(时间值是内容判断,
    // 确定性重组无法给出"合理时间");触发/站地址违规已由⓪确定性自愈——
    // 都不进入重组牵连集
    if (violation.type === "missing_correct_after_error"
      || violation.type === "zero_time_step"
      || violation.type === "missing_primary_trigger"
      || violation.type === "duplicate_loop_trigger"
      || violation.type === "missing_station_address"
      || violation.type === "missing_instruction_length_variant"
      // 上注类型混用不做确定性拆分(块序列编排是内容判断),如实残留需重派
      || violation.type === "mixed_upload_type"
      // 多包顺序需按协议和字段语义重新生成，不做机械重排
      || violation.type === "invalid_auxiliary_interleave"
      // 地址语义/边界集/周期时序都必须重新生成，不做机械重排
      || violation.type === "invalid_memory_read_alignment"
      || violation.type === "invalid_memory_read_scenarios"
      || violation.type === "incomplete_memory_read_boundary"
      || violation.type === "invalid_memory_polling_schedule"
      || violation.type === "missing_bus_counterpart"
      // 看门狗固定句式无法确定性重写(内容逐字约束),如实残留需重派
      || violation.type === "watchdog_shape_violation") continue
    // 优先按下标定位(2026-09-08 P2):同名用例时按名称 findIndex 恒命中
    // 第一个,真正违规的用例可能原样保留而无辜用例被重组/丢弃
    const index = violation.case_index
      ?? cases.findIndex((c) => String(c.case_name ?? "未命名用例") === violation.case_name)
    if (index >= 0) implicated.add(index)
  }
  const implicatedSorted = [...implicated].sort((a, b) => a - b)

  // ② 全局重分组:牵连用例的步骤按(指令短语,总线)归并
  interface RegroupBucket {
    phrase: string
    bus: string
    steps: RepairableStep[]
    sources: number[]
  }
  const buckets = new Map<string, RegroupBucket>()
  const prefixByCase = new Map<number, RepairableStep[]>()
  const sourceGroupCount = new Map<number, number>()

  for (const caseIndex of implicatedSorted) {
    const record = cases[caseIndex]!
    let lastKey: string | null = null
    let prefixSteps: RepairableStep[] | null = null
    for (const step of record.test_step ?? []) {
      const desc = descOfStep(step)
      const phrase = SEND_STEP_PATTERN.test(desc)
        ? instructionPhraseFromStep(`${desc}\n${expectOfStep(step)}`)
        : ""
      // 二级模拟应答不独立成桶:它是前驱一级触发的应答环节,附着到触发的桶,
      // 防止重组把"一级触发+二级应答"合并结构拆散(2026-08-26 二级总线拆用例
      // 事故:触发与应答短语不同曾各自成桶,好用的合并用例被拆成两条废用例)
      if (REQUEST_DIRECTION_PATTERN.test(desc) && phrase && !isSecondarySimulatedResponse(desc)) {
        const bus = busOfStepDesc(desc) || "-"
        lastKey = `${phrase}|${bus}`
        const bucket = buckets.get(lastKey) ?? { phrase, bus, steps: [], sources: [] }
        bucket.steps.push(step)
        if (!bucket.sources.includes(caseIndex)) {
          bucket.sources.push(caseIndex)
          sourceGroupCount.set(caseIndex, (sourceGroupCount.get(caseIndex) ?? 0) + 1)
        }
        buckets.set(lastKey, bucket)
      } else if (lastKey) {
        buckets.get(lastKey)!.steps.push(step)
      } else {
        // 首条请求步骤之前:初始化/准备步骤,复制进该用例派生的每个用例
        prefixSteps = prefixSteps ?? []
        prefixSteps.push(step)
      }
    }
    if (prefixSteps) prefixByCase.set(caseIndex, prefixSteps)
  }

  // ③ 重建:牵连用例替换为重组用例(保持全序列顺序:未牵连原位,重组块按首次出现位置)
  const repairedCases: RepairableCase[] = []
  const rebuilt: RepairableCase[] = []
  for (const bucket of buckets.values()) {
    // 前缀步骤:该组各来源用例的初始化步骤按来源顺序去重拼接
    const prefixSteps: RepairableStep[] = []
    const seenPrefix = new Set<string>()
    for (const source of bucket.sources) {
      for (const step of prefixByCase.get(source) ?? []) {
        const dedup = descOfStep(step)
        if (seenPrefix.has(dedup)) continue
        seenPrefix.add(dedup)
        prefixSteps.push(step)
      }
    }
    const steps = [...prefixSteps, ...bucket.steps]
    const soloSource = bucket.sources.length === 1
      && (sourceGroupCount.get(bucket.sources[0]!) ?? 0) === 1
    const busTag = bucket.bus === "-" ? "" : bucket.bus
    const name = soloSource
      ? String(cases[bucket.sources[0]!]?.case_name ?? `${busTag}${bucket.phrase}测试`)
      : `${busTag}${bucket.phrase}测试`
    const purpose = [...new Set(
      bucket.sources.map((i) => cases[i]?.test_purpose).filter((p): p is string => typeof p === "string" && p.length > 0),
    )].join(";")
    const covered = [...new Set(bucket.sources.flatMap((i) => cases[i]?.covered_tr_items ?? []))]
    // 多来源合并时时间可能冲突,顺序重排(首步时间起 +0.5 递增);单来源拆分保留原时间
    let finalSteps = steps
    if (bucket.sources.length > 1) {
      let t = timeOfStep(steps[0]!) ?? 1
      finalSteps = steps.map((step) => {
        const retimed = timeOfStep(step) === null ? step : retimeStep(step, t)
        t += 0.5
        return retimed
      })
    }
    rebuilt.push({
      case_name: name,
      test_purpose: purpose,
      covered_tr_items: covered,
      correspond_fun_id: cases[bucket.sources[0]!]?.correspond_fun_id,
      test_step: finalSteps,
    })
    actions.push(
      `已重组:${name} ← ${[...new Set(bucket.sources.map((i) => String(cases[i]?.case_name ?? `case[${i}]`)))].join("、")}` +
      `${covered.length > 0 ? `(覆盖 ${covered.join("、")})` : ""}`,
    )
  }

  // 输出序列:未牵连用例原样保留,重组块插在首个牵连用例的位置。
  // 牵连但无法归桶的用例原样保留(2026-09-08 P2 取证:短语只出现在
  // 回传/返回步骤或预期半区的用例被检测端牵连、修复端建不出任何桶——
  // 主题动词不在 REQUEST 表的整批用例(如"上注")更是零桶,
  // 曾致 persisted_case_count=0、用例整条蒸发)
  const bucketedSources = new Set([...buckets.values()].flatMap((bucket) => bucket.sources))
  const firstImplicated = implicatedSorted[0] ?? -1
  cases.forEach((record, index) => {
    if (index === firstImplicated) repairedCases.push(...rebuilt)
    if (implicated.has(index)) {
      if (!bucketedSources.has(index)) {
        repairedCases.push(record)
        actions.push(
          `[保留原用例] 用例"${String(record.case_name ?? "未命名用例")}"被牵连但无法按(指令短语,总线)归桶——` +
          "原样保留不蒸发,残留违规以重派为准",
        )
      }
      return
    }
    repairedCases.push(record)
  })
  if (firstImplicated < 0 && rebuilt.length > 0) repairedCases.push(...rebuilt)

  // ④ 配对修复:错误发送步骤后补"全部正确"(克隆同指令同总线前驱正确步骤,无则合成)
  for (const record of repairedCases) {
    const steps = record.test_step ?? []
    const packetSequence = analyzePacketSequences(steps.map((step) => ({ 步骤描述: descOfStep(step), 预期结果: expectOfStep(step) })), { corpus: options?.requirementCorpus })
    const output: RepairableStep[] = []
    // 循环触发模式(触发步骤带 循环/以N秒为周期):恢复单元是[二级正确应答]单步,
    // 循环发送自动重发,不需要也不应插入一级重发步骤
    const loopTriggerMode = steps.some((s) =>
      /以[\d.]+秒?为周期|循环发送|周期发送/.test(descOfStep(s)))
    // 连续错误堆叠主题豁免配对插入(连续错误是测试目的,检测端同样豁免)
    const consecutiveErrorSubject = CONSECUTIVE_ERROR_SUBJECT_PATTERN.test(
      `${record.case_name ?? ""} ${record.test_purpose ?? ""}`)
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!
      output.push(step)
      const desc = descOfStep(step)
      if (!isErrorSendStep(desc)) continue
      if (packetSequence.stepIndexes.has(i)) continue // Never clone correct packets into a stateful stream.
      if (consecutiveErrorSubject) continue
      const phrase = instructionPhraseFromStep(`${desc}\n${expectOfStep(step)}`)
      const bus = busOfStepDesc(desc)
      const nextDesc = i + 1 < steps.length ? descOfStep(steps[i + 1]) : ""
      const nextIsCorrectSecondary = isCorrectSendStep(nextDesc) && SECONDARY_CHANNEL_PATTERN.test(nextDesc)
      const secondaryPaired = isSecondarySimulatedResponse(desc)
        && (loopTriggerMode ? nextIsCorrectSecondary : secondaryRecoveryPaired(steps, i))
      const paired = secondaryPaired
        || (!isSecondarySimulatedResponse(desc)
          && isCorrectSendStep(nextDesc)
          && busOfStepDesc(nextDesc) === bus
          && (!phrase || instructionPhraseFromStep(`${nextDesc}\n${expectOfStep(steps[i + 1])}`) === phrase))
      if (paired) continue
      // 模板:同用例内最近的前驱正确步骤
      let template: RepairableStep | null = null
      for (let j = i - 1; j >= 0; j--) {
        const candidate = steps[j]!
        const candidateDesc = descOfStep(candidate)
        if (!isCorrectSendStep(candidateDesc) || busOfStepDesc(candidateDesc) !== bus) continue
        if (phrase && instructionPhraseFromStep(`${candidateDesc}\n${expectOfStep(candidate)}`) !== phrase) continue
        template = candidate
        break
      }
      const t = (timeOfStep(step) ?? 1) + 0.5
      if (isSecondarySimulatedResponse(desc) && loopTriggerMode) {
        // 循环模式:只补[二级正确应答]单步,循环触发自动重发。恢复步骤载荷
        // 从错误步骤本身派生(逐字保留指令/数据名),不按短语合成——幽灵短语
        // 曾把计数器名合成进载荷(2026-08-26 晚取证)
        const response = retimeStep(correctVariantOfSecondaryErrorStep(step), t)
        output.push(response)
        actions.push(`已补配对(二级总线·循环模式):用例"${record.case_name ?? "未命名用例"}"步骤"${desc.slice(0, 30)}…"后插入[二级正确应答]恢复步骤`)
        continue
      }
      if (isSecondarySimulatedResponse(desc)) {
        // 二级总线显式触发模式,恢复单元是两步:[一级重发同指令]+[二级正确应答](2026-08-25 用户拍板模型)。
        // 一级重发载荷优先从二级载荷反推指令名;载荷层级铁律——一级步骤载荷
        // 禁止"二级CAN/二级总线"协议名,反推不出干净名称时宁可跳过也不插垃圾
        const derivedTriggerName = primaryTriggerNameForSecondarySteps(steps)
        const triggerName = derivedTriggerName || phrase
        // SPI 二级应答的一级重发载荷是一级指令名,与 SPI 应答名本就不同名
        // (黑体驱动遥控指令↔黑体驱动指令应答)——按 SPI 应答名合成一级重发
        // 就是插错名触发,宁可跳过留给重派(2026-08-28 SPI 同构取证)
        if (isSpiSecondaryStep(desc) || !triggerName || /二级/.test(triggerName)) {
          actions.push(
            `[跳过插入] 用例"${record.case_name ?? "未命名用例"}"步骤"${desc.slice(0, 30)}…"的恢复单元无法确定一级指令名` +
            (isSpiSecondaryStep(desc)
              ? "(SPI 应答名与一级指令名不同名,不得按 SPI 应答名合成一级重发)"
              : `(候选"${triggerName || "无"}"含二级协议名或为空)`) +
            "——需重派按循环触发模型改写",
          )
          continue
        }
        const trigger: RepairableStep = {
          步骤描述: `第${t}秒,通过CANA总线发送${triggerName}。`,
          预期结果: "软件接收并通过二级总线转发。",
          operation_type: "send_command",
          channel: "CANA",
          temporal: `第${t}秒`,
        }
        const response = retimeStep(correctVariantOfSecondaryErrorStep(step), t + 0.5)
        output.push(trigger, response)
        actions.push(`已补配对(二级总线):用例"${record.case_name ?? "未命名用例"}"步骤"${desc.slice(0, 30)}…"后插入[一级重发+二级正确应答]恢复单元`)
        continue
      }
      const inserted = template
        ? retimeStep(template, t)
        : {
          步骤描述: `第${t}秒,通过${bus || "CANA"}总线发送正确的${phrase || "指令序列"}`,
          预期结果: "指令被正确接收并正常处理",
          operation_type: "send_command",
          ...(bus ? { channel: bus } : {}),
          temporal: `第${t}秒`,
        }
      output.push(inserted)
      actions.push(`已补配对:用例"${record.case_name ?? "未命名用例"}"步骤"${desc.slice(0, 30)}…"后插入"全部正确"步骤`)
    }
    record.test_step = output
    // 时间单调性:插入导致的冲突级联顺延(仅调整带时间前缀的步骤)
    for (let i = 1; i < record.test_step.length; i++) {
      const prev = timeOfStep(record.test_step[i - 1]!)
      const curr = timeOfStep(record.test_step[i]!)
      if (prev !== null && curr !== null && curr <= prev) {
        record.test_step[i] = retimeStep(record.test_step[i]!, prev + 0.5)
      }
    }
  }

  // ⑤ 重跑检测,残留如实上报(长度变体是内容选择,确定性修复不擅自挑变体)
  const residualStructure = analyzeCaseStructure(repairedCases as Parameters<typeof analyzeCaseStructure>[0], {
    requirementCorpus: options?.requirementCorpus,
    lengthVariantBases: options?.lengthVariantBases,
    functionalTwoAuxiliaryPackets: options?.functionalTwoAuxiliaryPackets,
    functionalMemoryReadRanges: options?.functionalMemoryReadRanges,
    functionalMemoryPollingPrerequisite: options?.functionalMemoryPollingPrerequisite,
    requiredPrimaryBuses: options?.requiredPrimaryBuses,
  })
  const residualAggregation = analyzeCaseAggregation(
    repairedCases as Parameters<typeof analyzeCaseAggregation>[0],
    [],
  )
  return {
    cases: repairedCases,
    actions,
    residual_structure_violations: residualStructure.violations,
    residual_aggregation_violations: residualAggregation.violations,
  }
}

/** 重派划分表:由违规明细确定性生成的"目标用例划分"指令,供主智能体原文嵌入重派 prompt。 */
export function buildRegroupDirective(
  aggregation: CaseAggregationAnalysis,
  structure: CaseStructureAnalysis,
): string[] {
  const lines: string[] = []
  if (aggregation.coverage_gaps.length > 0) {
    lines.push(
      `缺失 TR 覆盖:${aggregation.coverage_gaps.join("、")}——这些 TR 的检查情况当前没有任何用例参考,` +
      `必须把它们的情况并入对应指令的用例(或补充用例),并把这些 TR 计入该用例 covered_tr_items`,
    )
  }
  for (const violation of aggregation.violations) {
    lines.push(
      `指令"${violation.instruction_phrase}":将用例 ${violation.case_names.join("、")} 的该指令全部情况` +
      `合并为每条总线一个用例,须覆盖 TR:${violation.covered_tr_items.join("、") || "并集"}`,
    )
  }
  for (const violation of structure.violations) {
    if (violation.type === "mixed_instruction") {
      lines.push(
        `用例"${violation.case_name}":拆分为每条指令独立用例(${(violation.phrases ?? []).join("、")}),双总线再每条总线独立`,
      )
    } else if (violation.type === "mixed_bus") {
      lines.push(`用例"${violation.case_name}":按总线拆分为 CANA/CANB 各自独立用例`)
    } else if (violation.type === "missing_bus_counterpart") {
      lines.push(violation.message + "——请补生成缺失总线的对应用例")
    } else if (violation.type === "zero_time_step") {
      lines.push(`用例"${violation.case_name}":0秒步骤改为合理起始时间(第3.0秒起,逐步骤递增),禁止第0.0秒`)
    } else if (violation.type === "missing_primary_trigger") {
      lines.push(
        `用例"${violation.case_name}":缺少一级总线触发步骤——头部补一条唯一循环触发步骤` +
        "(第3.0秒,通过CANA总线以1秒为周期循环发送该指令,循环时间参数=1.0,后续步骤不再编写触发步骤)",
      )
    } else if (violation.type === "duplicate_loop_trigger") {
      lines.push(
        `用例"${violation.case_name}":循环触发声明重复——只保留首条循环触发步骤,其余触发步骤删除(循环按周期自动重发)`,
      )
    } else if (violation.type === "missing_station_address") {
      lines.push(
        `用例"${violation.case_name}":二级总线步骤未指明站地址——从站地址定义表选定一个从节点,` +
        "全部二级步骤统一标注该站地址,预期结果中站地址参数写该站地址具体值",
      )
    } else if (violation.type === "missing_instruction_length_variant") {
      lines.push(violation.message + "——请指明长度限定词并按长度拆分用例后重新生成")
    } else if (violation.type === "mixed_upload_type") {
      lines.push(violation.message + "——请按上注类型拆分为独立用例后重新生成")
    } else if (violation.type === "invalid_auxiliary_interleave") {
      lines.push(violation.message + "——请按完整正确包序列重新生成，剩余错误在末包正确前覆盖")
    } else if (violation.type === "invalid_memory_read_alignment") {
      lines.push(violation.message + "——请把非4字节对齐地址改为单独的错误指令步骤")
    } else if (violation.type === "invalid_memory_read_scenarios") {
      lines.push(violation.message + "——请按当前总线重新生成两个场景用例")
    } else if (violation.type === "incomplete_memory_read_boundary") {
      lines.push(violation.message + "——请在独立的地址边界场景中补齐")
    } else if (violation.type === "invalid_memory_polling_schedule") {
      lines.push(violation.message + "——请按首步周期前置+后续2秒偏移时刻重新生成")
    } else if (violation.type === "watchdog_shape_violation") {
      lines.push(violation.message + "——请按硬件狗固定句式模板逐字重写(单用例单步骤,禁止内存写喂狗/软平台自适应改写/推迟鉴定测评形态)")
    } else if (violation.type === "functional_model_violation") {
      lines.push(`用例"${violation.case_name}":${violation.message}——按当前需求的接口/有序多包模型重新生成，禁止机械补发绕过。`)
    }
  }
  const pairingByCase = new Map<string, number>()
  for (const violation of structure.violations) {
    if (violation.type !== "missing_correct_after_error") continue
    pairingByCase.set(violation.case_name, (pairingByCase.get(violation.case_name) ?? 0) + 1)
  }
  for (const [caseName, count] of pairingByCase) {
    lines.push(`用例"${caseName}":${count} 处错误发送步骤后须紧跟同指令同总线"全部正确"步骤(全部正确→某字段错误→全部正确交替)`)
  }
  return lines
}

/**
 * Fill ID-like and data-file-like arguments the step text did not supply.
 * Mutates `bindings`; returns the argument names it filled so callers can
 * drop the now-stale "未能从步骤文本中提取" diagnostics.
 */
function fillUnboundKeywordArguments(
  keyword: KeywordMeta,
  bindings: Record<string, string>,
  corpus: string,
  state: CaseArgumentAllocationState | undefined,
): string[] {
  if (!state) return []
  const filled: string[] = []
  for (let index = 0; index < keyword.argumentNames.length; index += 1) {
    const name = keyword.argumentNames[index]
    if (!name || name === "${time}") continue
    const comment = keyword.argumentComments[index] ?? ""
    const idRange = comment.match(INSTRUCTION_ID_RANGE_PATTERN)
    if (idRange) {
      const bound = bindings[name]
      if (bound) {
        const boundId = Number.parseInt(bound, 10)
        if (Number.isInteger(boundId)) {
          state.usedInstructionIds.add(boundId)
          const phrase = instructionPhraseFromStep(corpus)
          if (phrase && !state.instructionIdByPhrase.has(phrase)) {
            state.instructionIdByPhrase.set(phrase, boundId)
          }
        }
        continue
      }
      // 同一指令短语跨步骤复用同一 ID(一个ID对应一种类型指令)
      const phrase = instructionPhraseFromStep(corpus)
      const reused = phrase ? state.instructionIdByPhrase.get(phrase) : undefined
      let allocated: number | undefined = reused
      if (allocated === undefined) {
        const min = Number.parseInt(idRange[1], 10)
        const max = Number.parseInt(idRange[2], 10)
        for (let id = min; id <= max; id += 1) {
          if (!state.usedInstructionIds.has(id)) {
            allocated = id
            break
          }
        }
        if (allocated !== undefined && phrase) {
          state.instructionIdByPhrase.set(phrase, allocated)
        }
      }
      if (allocated !== undefined) {
        state.usedInstructionIds.add(allocated)
        bindings[name] = String(allocated)
        filled.push(name)
      }
      continue
    }
    if (DATA_FILE_COMMENT_PATTERN.test(comment) && !bindings[name]) {
      bindings[name] = dataFileLabelFromStep(corpus)
      filled.push(name)
      continue
    }
    // 电平参数(2026-09-02 SpaceWire 取证):注释形如 "电平：HIGH:上升沿; LOW:下降沿"
    // 且不在 Documentation 模板引用中(触发外部中断 的 ${para2})——按步骤文本的
    // 低电平/下降沿、高电平/上升沿 注记,从注释枚举对解析规范值绑定,
    // 不再留 "{para2}" 占位丢弃触发方式信息
    if (!bindings[name] && /电平/.test(comment)) {
      const edge = /低电平|下降沿/.test(corpus)
        ? "下降"
        : /高电平|上升沿/.test(corpus)
          ? "上升"
          : null
      if (edge) {
        const pair = comment.match(new RegExp(`[A-Za-z]+\\s*[:：]\\s*[^;；]*${edge}[^;；]*`))
        const value = pair
          ? pair[0].slice(pair[0].search(/[:：]/) + 1).trim()
          : ""
        if (value) {
          bindings[name] = value
          filled.push(name)
        }
      }
    }
  }
  return filled
}

/**
 * Resolve a Documentation placeholder written as ${参数N} (Chinese ordinal alias)
 * to the declared argument whose JSON Argument comment is numbered "参数N：…".
 * The DTP keyword libraries use ${参数N} in Documentation as an alias of the Nth
 * declared parameter, e.g. Documentation "${参数2}" ↔ Arguments "${para2}" whose
 * comment reads "参数2：时间间隔，单位秒；".
 */
function resolvePositionalPlaceholderAlias(
  placeholder: string,
  keyword: KeywordMeta,
): string | null {
  const match = placeholder.match(/^\$\{参数([一二三四五六七八九十]|\d+)\}$/)
  if (!match) return null
  const number = match[1]
  for (let index = 0; index < keyword.argumentNames.length; index += 1) {
    const comment = keyword.argumentComments[index] ?? ""
    if (comment.includes(`参数${number}`)) return keyword.argumentNames[index]
  }
  return null
}

/**
 * Strip common LLM-added noise from the step text before Documentation template
 * matching (conservative, word-boundary-anchored rules grounded in real failure
 * samples). Rules:
 * - "初始化设置" → "设置"
 * - "再次通过X总线" → "通过X总线"（channel 无关）
 * - "触发…，同时通过X总线…" → 保留"同时"之后的主体动作，并补回时间前缀
 * - 句首"解除…后，" → 保留其后主体动作，并补回时间前缀
 */
function stripStepMatchNoise(stepText: string, temporalPrefix?: string): string {
  let text = stepText
  text = text.replace(/初始化设置/g, "设置")
  text = text.replace(/再次(?=通过(?:CANA|CANB)总线)/g, "")
  text = text.replace(/再次通过%\$总线/g, "通过%\$总线")

  const simultaneous = text.match(/[，,]\s*同时(?=通过(?:CANA|CANB)总线|通过%\$总线)/)
  if (simultaneous) {
    const after = text.slice(simultaneous.index! + simultaneous[0].length)
    text = temporalPrefix ? `${temporalPrefix}，${after}` : after
  }

  const unlocked = text.match(/^([^，,]*[，,]\s*)?[^，,]*解除[^，,]*后[，,]\s*/)
  if (unlocked) {
    const after = text.slice(unlocked[0].length)
    text = temporalPrefix ? `${temporalPrefix}，${after}` : after
  }

  return text
}

function categorizeTranslationIssues(issues: string[]): Phase6TranslationIssueCategory {
  if (issues.some((issue) => issue.includes("未在 JSON Arguments 中声明"))) {
    return "keyword_metadata"
  }
  if (issues.some((issue) => issue.includes("Documentation 不匹配") || issue.includes("无参数关键字"))) {
    return "documentation_mismatch"
  }
  if (issues.some((issue) => issue.includes("未加载到组合关键字库") || issue.includes("未匹配到组合关键字"))) {
    return "keyword_missing"
  }
  return "documentation_mismatch"
}

/**
 * Normalize a captured numeric literal to the canonical hex/decimal form the
 * DTP executor reads per argument comments ("0x表示十六进制,否则为十进制"):
 * assembly-style H-suffix hex ("21143000H") must become "0x21143000" — the
 * bare digits would otherwise be misread as decimal (2026-08-21 用户反馈同族
 * 缺陷:地址 21143000H 曾被存为十进制 21143000)。
 */
function normalizeHexLikeValue(raw: string): string {
  const text = raw.trim()
  if (/^[0-9A-Fa-f]+[Hh]$/.test(text)) return `0x${text.slice(0, -1)}`
  return text
}

/**
 * Level-4 fallback (semantic extraction): when template regex matching fails,
 * extract argument values directly from the step prose using label-anchored
 * patterns derived from each declared argument's semantic / comment
 * (e.g. "起始地址0x21143000" → ${para1}). This is the only path that can
 * translate keywords whose Documentation is empty (13% of one real library),
 * for which a synthesized Documentation is rendered from the Arguments.
 */
function argumentExtractionPatterns(
  argName: string,
  argumentComment: string,
  semantic: KeywordArgumentSemantic,
): RegExp[] {
  const corpus = `${argName} ${argumentComment}`
  if (semantic === "loop_interval") {
    return [
      /以\s*(-?\d+(?:\.\d+)?)\s*(?:秒|s)\s*为周期/i,
      /(?:周期|间隔|循环时间)(?:参数)?\s*(?:为|是|[=:：])?\s*(-?\d+(?:\.\d+)?)\s*秒?/,
    ]
  }
  // Delay args ("延时应答时间，默认为0") must anchor on 延时/延迟 — the generic
  // time branch below would otherwise capture the step's EXECUTION time
  // ("第3.0秒") as the delay duration.
  if (/延时|延迟/.test(corpus)) {
    return [/(?:延时|延迟)(?:应答)?(?:时间)?\s*(?:为|是|[:：])?\s*(\d+(?:\.\d+)?)\s*秒?/]
  }
  if (semantic === "time" || /时间|时刻/.test(corpus)) {
    return [/第\s*(\d+(?:\.\d+)?)\s*秒/, /(?:^|[^\w.])(\d+(?:\.\d+)?)\s*秒/]
  }
  if (/掩码/.test(corpus)) {
    return [/掩码\s*(?:为|是|[:：])?\s*(0[xX][0-9A-Fa-f]+|[0-9A-Fa-f]+[Hh])/i]
  }
  if (/地址/.test(corpus) && !/类型|type/i.test(corpus)) {
    // 值组三种形态:0x 前缀 / H 后缀十六进制(可全字母,如 F000H)/ 无后缀十进制
    return [/(?:起始地址|目的地址|基地址|地址)\s*(?:为|是|[:：])?\s*(0[xX][0-9A-Fa-f]+|[0-9A-Fa-f]+[Hh]|\d[A-Fa-f\d]{2,})/i]
  }
  if (semantic === "file_path" || /文件|数据流/.test(corpus)) {
    return [
      /([\w.\-/\\]+\.(?:txt|bin))\b/i,
      /(?:数据|文件)\s*(?:为|是|[:：])?\s*(0[xX][0-9A-Fa-f]+|-?\d+(?:\.\d+)?)/i,
      // Named send payloads are captured with balanced groups before regex fallback.
    ]
  }
  if (semantic === "data_id" || /指令码|数据标识|\bID\b/i.test(corpus)) {
    return [/(?:ID|id|指令码|数据标识)\s*(?:为|是|[:：])?\s*([0-9]{1,3})/]
  }
  if (semantic === "bus_channel") {
    return [/\b(CANA|CANB)\b/i]
  }
  if (semantic === "expected_value" || /期望|预期|等于/.test(corpus)) {
    return [/(?:期望|预期|等于)\s*(?:值)?\s*(?:为|是|[:：])?\s*(0[xX][0-9A-Fa-f]+|-?\d+(?:\.\d+)?)/i]
  }
  if (/数据/.test(corpus)) {
    return [
      /(?:数据|数值)\s*(?:为|是|[:：])?\s*(0[xX][0-9A-Fa-f]+|-?\d+(?:\.\d+)?)/i,
      // 无标签裸值:动词后的十六进制/十进制("向地址…写入AAAAH" → 数据=AAAAH,
      // 2026-08-21 用户反馈:曾有值不抽、落成 "{para2}" 无意义占位)。
      // 纯十进制后加负向断言,避免"写入10次/写入N个"把量词当数据
      /(?:写入|写出|写|置为|设置为|赋值|载入)\s*(?:为|是|[:：])?\s*(0[xX][0-9A-Fa-f]+|[0-9A-Fa-f]+[Hh]|-?\d+(?:\.\d+)?(?!\s*[次个条帧位秒]))/i,
    ]
  }
  return []
}

function extractArgumentBindingsFromStep(
  keyword: KeywordMeta,
  step: { 步骤描述: string; 预期结果: string },
  temporalOverride?: string,
): { bindings: Record<string, string>; issues: string[]; extractedCount: number } {
  // 操作参数优先取自步骤描述(操作内容);预期结果(结果状态)仅作回退——
  // 预期结果里的"数据为0x0000AAAA"是终态陈述,不是写入值(掩码写/计数
  // 类步骤两者会不同),曾抢先命中标签模式导致取值来源错位
  const stepCorpus = step.步骤描述
  const fullCorpus = `${step.步骤描述}\n${step.预期结果}`
  const bindings: Record<string, string> = {}
  const issues: string[] = []
  let extractedCount = 0

  for (let index = 0; index < keyword.argumentNames.length; index += 1) {
    const argName = keyword.argumentNames[index]
    if (!argName) continue
    const comment = keyword.argumentComments[index] ?? ""
    const semantic = inferKeywordArgumentSemantic(argName, comment, keywordToCandidate(keyword))
    const payload = semantic === "file_path" || /文件|数据流|数据包名称|数据协议名称/.test(comment)
      ? extractSentPayload(stepCorpus) : undefined
    if (payload && !/^(?:数据|文件)\s*(?:为|是|[:：])\s*(?:0x|-?\d)/i.test(payload)
      && (/[（(【\[]/.test(payload) || !/[\w.\-/\\]+\.(?:txt|bin)\b/i.test(payload))) {
      bindings[argName] = payload
      extractedCount += 1
      continue
    }
    const patterns = argumentExtractionPatterns(argName, comment, semantic)
    if (patterns.length === 0) continue

    let matched: RegExpMatchArray | null = null
    for (const corpus of [stepCorpus, fullCorpus]) {
      for (const pattern of patterns) {
        matched = corpus.match(pattern)
        if (matched) break
      }
      if (matched) break
    }
    if (!matched && semantic === "loop_interval") {
      // Documented one-shot default: 0 = send only once
      bindings[argName] = "0"
      extractedCount += 1
      continue
    }
    if (!matched && /延时|延迟/.test(comment)) {
      // Documented delay default: 0 = no delayed response
      bindings[argName] = "0"
      extractedCount += 1
      continue
    }
    if (!matched && /掩码/.test(comment)) {
      // 位写操作未声明掩码 = 全部位生效(写整个字);位宽取自关键字名
      // (设置32位地址bit数据 → 0xFFFFFFFF)。2026-08-21 用户拍板方向:
      // 参数须按操作内容与注释语义填合适值,不得留 "{paraN}" 无意义占位
      const width = /8位|8bit/i.test(keyword.keywordName)
        ? "0xFF"
        : /16位|16bit/i.test(keyword.keywordName)
          ? "0xFFFF"
          : "0xFFFFFFFF"
      bindings[argName] = width
      extractedCount += 1
      continue
    }
    if (!matched && semantic === "time" && temporalOverride) {
      bindings[argName] = temporalOverride
      extractedCount += 1
      continue
    }
    if (!matched) {
      issues.push(`关键字 ${keyword.keywordName} 的参数 ${argName}（${semantic}）未能从步骤文本中提取`)
      continue
    }
    // H 后缀十六进制归一化为 0x 形式,避免被执行器按十进制误读
    bindings[argName] = normalizeHexLikeValue((matched[1] ?? "").trim())
    extractedCount += 1
  }

  return { bindings, issues, extractedCount }
}

/**
 * Synthesize a Documentation-style template for keywords whose Documentation
 * is empty, from the keyword name plus per-argument labels extracted from
 * argument comments ("参数1：起始地址，十六进制" → "起始地址").
 */
function synthesizeDocumentationTemplate(keyword: KeywordMeta): string {
  const parts: string[] = []
  if (keyword.argumentNames.includes("${time}")) parts.push("第${time}秒")
  parts.push(keyword.keywordName)
  for (let index = 0; index < keyword.argumentNames.length; index += 1) {
    const name = keyword.argumentNames[index]
    if (!name || name === "${time}") continue
    const label = (keyword.argumentComments[index] ?? "")
      .replace(/^参数\d+\s*[:：]\s*/, "")
      .split(/[，,;；或]/)[0]
      .trim()
    parts.push(label ? `${label}${name}` : name)
  }
  return parts.join("，")
}

/**
 * step_desc is what humans read in the final suite and what DTP data
 * generation treats as the authoritative statement of a step's protocol and
 * fault intent. A half-rendered template ("…发送{para2}") is neither — when a
 * parameter placeholder survives rendering, fall back to the original step
 * prose, which always states the real intent. The soft-bound parameter list
 * keeps the {para} slots for the later data-generation phase.
 */
function finalizeStepDesc(renderedText: string, sourceDesc: string): string {
  if (!SURVIVING_PARAM_PLACEHOLDER.test(renderedText)) {
    return sanitizeDtpExecutablePlaceholders(stripTerminalPunctuation(renderedText))
  }
  return sanitizeDtpExecutablePlaceholders(stripTerminalPunctuation(sourceDesc))
}

/** Plans and normalized template captures must not replace the actual packet/fault qualifiers. */
function restoreQualifiedPayloadBinding(keyword: KeywordMeta, bindings: Record<string, string>, sourceDesc: string): void {
  const payload = extractSentPayload(sourceDesc)
  if (!payload || !/[（(【\[]/.test(payload)) return
  keyword.argumentNames.forEach((name, i) => {
    const comment = keyword.argumentComments[i] ?? ""
    if (inferKeywordArgumentSemantic(name, comment, keywordToCandidate(keyword)) === "file_path"
      || /数据包名称|数据协议名称/.test(comment)) {
      bindings[name] = payload
    }
  })
}

function translateStepBySemanticExtraction(
  step: { 步骤描述: string; 预期结果: string },
  keyword: KeywordMeta,
  temporalOverride?: string,
  channelOverride?: string,
  caseState?: CaseArgumentAllocationState,
  contextCorpus?: string,
): { step?: TranslatedTestStepRecord; issues: string[] } {
  const { bindings, issues, extractedCount } = extractArgumentBindingsFromStep(
    keyword,
    step,
    temporalOverride,
  )
  restoreQualifiedPayloadBinding(keyword, bindings, step.步骤描述)
  // Soft success: at least ONE value must actually come from the step text
  // (still prevents garbage matches on keywords unrelated to the step).
  // Arguments the step text does not spell out (e.g. 指令ID/数据包名称) keep
  // their {name} placeholder for the later data-generation phase instead of
  // failing the whole match — a semantically right keyword must not lose to a
  // wrong one or to total failure merely because a parameter is implied.
  if (extractedCount === 0) return { issues }

  const template = keyword.description.trim()
    ? keyword.description.trim().replace(/%\$/g, channelOverride ?? BUS_PLACEHOLDER)
    : synthesizeDocumentationTemplate(keyword)
  if (template.includes(BUS_PLACEHOLDER) && !bindings[BUS_PLACEHOLDER]) {
    const busMatch = step.步骤描述.match(/(CANA|CANB)/i)
    bindings[BUS_PLACEHOLDER] = busMatch ? busMatch[1] : (channelOverride ?? "")
  }

  // 指令ID 用例内唯一分配 / 数据文件填"指令·情况"说明(用户拍板的替换语义)
  // 标签说明的是步骤"发送什么指令的什么情况",只看步骤描述,不掺预期结果
  const filledArgs = fillUnboundKeywordArguments(
    keyword,
    bindings,
    contextCorpus ? `${step.步骤描述}\n${contextCorpus}` : step.步骤描述,
    caseState,
  )
  const remainingIssues = filledArgs.length > 0
    ? issues.filter((issue) => !filledArgs.some((name) => issue.includes(`参数 ${name}`)))
    : issues

  const parameter = keyword.argumentNames
    .filter((name) => name && name !== BUS_PLACEHOLDER)
    .map((name) => {
      const raw = bindings[name] ?? `{${name.replace(/^\$\{/, "").replace(/\}$/, "")}}`
      return {
        Value: parseParameterValue(String(sanitizeDtpExecutableValue(raw))),
        Name: name,
        Comments: keyword.argumentComments[keyword.argumentNames.indexOf(name)] ?? "",
      }
    })

  const rendered = renderDocumentationTemplate(template, bindings, buildCommentMap(keyword))
  // 空 Documentation 关键字没有官方文案模板:合成模板只服务于绑定校验,
  // 人类可读的 step_desc 保持 worker 原始自然语言(2026-08-21 用户确认该
  // 形态"意图准确且取值正确"——取值已全部呈现在参数列表中,不再用合成
  // 模板改写步骤文本)
  const stepDescSource = keyword.description.trim() ? rendered.text : step.步骤描述
  return {
    issues: remainingIssues,
    step: {
      key_name: keyword.keywordName,
      step_desc: finalizeStepDesc(stepDescSource, step.步骤描述),
      parameter,
      expected_result: sanitizeDtpExecutablePlaceholders(stripTerminalPunctuation(step.预期结果)),
    },
  }
}

/**
 * 参数泄漏:绑定结果的 Value 仍是 "{paraN}" 占位(未从步骤文本提取到)。
 * 供候选选择做绑定完整度比较(2026-08-28 用户裁定:循环触发步骤应选只需
 * 循环时间参数即可完整绑定的 发送CANATXT数据,而非泄漏 开始索引/结束索引/
 * 是否轮询 三个占位的 循环发送CANA指令——匹配度高但参数绑不全的关键字
 * 不如参数能全部落地的关键字)。
 */
function hasUnboundParameterLeak(
  step: TranslatedTestStepRecord | undefined,
  keyword?: KeywordMeta,
): boolean {
  if (!step) return false
  // 泄漏只计 Documentation 模板实际引用的参数:模板未引用而已声明的参数
  // (如 触发外部中断 的 ${para2},运行时辅助参数)留占位不影响渲染正确性,
  // 计入会把正确关键字误降级,让语义提取的乱码竞争者反超(2026-09-02 取证)
  let referenced: Set<string> | null = null
  if (keyword) {
    const template = keyword.description.trim() || keyword.keywordName
    const docPlaceholders = collectPlaceholdersInOrder(template)
    referenced = new Set(docPlaceholders.flatMap((placeholder) => [
      placeholder,
      resolvePositionalPlaceholderAlias(placeholder, keyword) ?? placeholder,
    ]))
  }
  return step.parameter.some((parameter) =>
    typeof parameter.Value === "string" && /^\{para\d*\}$/.test(parameter.Value.trim())
    && (!referenced || referenced.has(parameter.Name)))
}

function translateStepWithKeyword(
  step: { 步骤描述: string; 预期结果: string },
  keyword: KeywordMeta,
  precomputedBindings?: Record<string, string>,
  /** Pre-fill ${time} from anchor temporal field to avoid regex dependency */
  temporalOverride?: string,
  /** Replace %$ placeholder in Documentation template with actual bus channel */
  channelOverride?: string,
  /** Raw temporal anchor (e.g. "第108.0秒") used to rebuild noise-stripped step prefixes */
  temporalPrefix?: string,
  /** Case-scoped allocation state for unbound 指令ID/数据文件 arguments */
  caseState?: CaseArgumentAllocationState,
  /** 需求级上下文语料:未绑定参数兜底提取的补充取值来源 */
  contextCorpus?: string,
): { step?: TranslatedTestStepRecord; issues: string[] } {
  if (!keywordMatchesStepAction(step.步骤描述, keyword.keywordName)) {
    return { issues: [`关键字 ${keyword.keywordName} 与步骤实际动作不一致，禁止仅凭时间参数或预期结果完成翻译`] }
  }
  let templateText = keyword.description.trim() || keyword.keywordName

  // Replace %$ (DTP bus placeholder) with actual channel from anchor field
  // so that regex matching works against real step descriptions.
  // Without this, templates like "通过%$总线..." never match "通过CANA总线..."
  // When no anchor channel is available, %$ becomes an internal wildcard
  // placeholder that captures either CANA or CANB.
  if (templateText.includes("%$")) {
    templateText = templateText.replace(/%\$/g, channelOverride ?? BUS_PLACEHOLDER)
  }

  // If precomputed bindings exist, use them to render directly without regex matching.
  // Only REAL hint bindings qualify: an empty hint (e.g. sanitized plan hints)
  // must fall through to full regex/semantic extraction — the bus auto-merge
  // below used to fabricate a non-empty binding set out of an empty one,
  // bypassing extraction and losing ${time}/${para3} entirely.
  // 未绑定参数兜底提取的语料 = 步骤描述 + 需求级上下文(中断表等)——
  // 电平/ID/数据文件类注释可从上下文取值(2026-09-10 取证:触发外部中断的
  // 电平参数在中断上下文表的"触发方式"列,步骤文本本身不带电平注记)
  const fillCorpus = contextCorpus ? `${step.步骤描述}\n${contextCorpus}` : step.步骤描述
  const hintBindingsProvided = Boolean(precomputedBindings && Object.keys(precomputedBindings).length > 0)
  // Merge in temporal override if not already bound
  if (hintBindingsProvided && temporalOverride && !precomputedBindings!["${time}"]) {
    precomputedBindings = { ...precomputedBindings!, ["${time}"]: temporalOverride }
  }
  // Resolve the internal bus wildcard marker from the step text when hint bindings
  // render the template directly (no anchor channel available)
  if (hintBindingsProvided && precomputedBindings && !precomputedBindings[BUS_PLACEHOLDER] && templateText.includes(BUS_PLACEHOLDER)) {
    const busMatch = step.步骤描述.match(/(CANA|CANB)/i)
    precomputedBindings = { ...precomputedBindings, [BUS_PLACEHOLDER]: busMatch ? busMatch[1] : "" }
  }
  if (hintBindingsProvided && precomputedBindings && Object.keys(precomputedBindings).length > 0) {
    precomputedBindings = { ...precomputedBindings }
    restoreQualifiedPayloadBinding(keyword, precomputedBindings, step.步骤描述)
    fillUnboundKeywordArguments(keyword, precomputedBindings, fillCorpus, caseState)
    const rendered = renderDocumentationTemplate(templateText, precomputedBindings, buildCommentMap(keyword))
    const parameter = Object.entries(precomputedBindings)
      .filter(([placeholder]) => placeholder !== BUS_PLACEHOLDER)
      .map(([placeholder, value]) => ({
        Value: parseParameterValue(String(sanitizeDtpExecutableValue(value))),
        Name: placeholder,
        Comments: keyword.argumentComments[keyword.argumentNames.indexOf(placeholder)] ?? "",
      }))
    return {
      issues: [],
      step: {
        key_name: keyword.keywordName,
        step_desc: finalizeStepDesc(rendered.text, step.步骤描述),
        parameter,
        expected_result: sanitizeDtpExecutablePlaceholders(stripTerminalPunctuation(step.预期结果)),
      },
    }
  }

  const template = templateText
  const placeholdersInDocumentation = collectPlaceholdersInOrder(template)
  const argumentComments = orderedArgumentComments(keyword)
  const issues: string[] = []

  // ${参数N} aliases resolve to the declared argument numbered "参数N：" in its comment
  const placeholderAliases = new Map<string, string>()
  for (const placeholder of placeholdersInDocumentation) {
    if (argumentComments.has(placeholder)) continue
    const alias = resolvePositionalPlaceholderAlias(placeholder, keyword)
    if (alias) placeholderAliases.set(placeholder, alias)
  }

  for (const placeholder of placeholdersInDocumentation) {
    if (argumentComments.has(placeholder)) continue
    if (placeholder === BUS_PLACEHOLDER) continue
    if (placeholderAliases.has(placeholder)) continue
    if (OUTPUT_PLACEHOLDER_PATTERN.test(placeholder)) continue
    issues.push(`关键字 ${keyword.keywordName} 的 Documentation 参数 ${placeholder} 未在 JSON Arguments 中声明`)
  }
  if (issues.length > 0) return { issues }

  const bindings: Record<string, string> = {}
  if (placeholdersInDocumentation.length > 0) {
    // Strip common LLM-added noise modifiers that break regex matching against
    // keyword Documentation templates. e.g. "再次通过CANA总线" → "通过CANA总线",
    // "第108.0秒，触发…，同时通过CANA总线发送…" → "第108.0秒，通过CANA总线发送…"
    const stepTextForMatch = stripStepMatchNoise(step.步骤描述, temporalPrefix)
    const matcher = buildTemplateMatcher(template)
    const matched = normalizeMatchText(stepTextForMatch).match(matcher.regex)
    if (!matched) {
      const semantic = translateStepBySemanticExtraction(step, keyword, temporalOverride, channelOverride, caseState, contextCorpus)
      if (semantic.step) return semantic
      return {
        issues: [
          `步骤描述 "${step.步骤描述}" 与关键字 ${keyword.keywordName} 的 Documentation 不匹配`,
          ...semantic.issues,
        ],
      }
    }

    matcher.placeholders.forEach((placeholder, index) => {
      bindings[placeholder] = String(matched[index + 1] ?? "").trim()
    })
    // Apply temporal override from anchor if regex didn't capture a clear time value
    if (temporalOverride && bindings["${time}"] && !/^\d/.test(bindings["${time}"])) {
      bindings["${time}"] = temporalOverride
    }
  } else if (keyword.argumentNames.length > 0) {
    // Documentation carries no placeholders while the keyword declares
    // arguments (empty-Documentation keywords): a mere name-containment match
    // would be a false success — the parameter list would be empty. Semantic
    // extraction is the only path to a complete executable step here.
    const semantic = translateStepBySemanticExtraction(step, keyword, temporalOverride, channelOverride, caseState, contextCorpus)
    if (semantic.step) return semantic
    return {
      issues: [
        `步骤描述 "${step.步骤描述}" 与关键字 ${keyword.keywordName} 的 Documentation 不匹配`,
        ...semantic.issues,
      ],
    }
  } else if (!isExactNoArgMatch(step.步骤描述, keyword, template)) {
    return {
      issues: [`步骤描述 "${step.步骤描述}" 与无参数关键字 ${keyword.keywordName} 不匹配`],
    }
  }

  // Output placeholders (readback slots) keep their marker text when unmatched —
  // mirrors the declared-placeholder behaviour without entering the parameter list.
  for (const placeholder of placeholdersInDocumentation) {
    if (OUTPUT_PLACEHOLDER_PATTERN.test(placeholder) && !bindings[placeholder]) {
      bindings[placeholder] = placeholder
    }
  }

  // 指令ID 用例内唯一分配 / 数据文件填"指令·情况"说明(用户拍板的替换语义)
  restoreQualifiedPayloadBinding(keyword, bindings, step.步骤描述)
  fillUnboundKeywordArguments(
    keyword,
    bindings,
    contextCorpus ? `${step.步骤描述}\n${contextCorpus}` : step.步骤描述,
    caseState,
  )

  const parameter = placeholdersInDocumentation
    .filter((placeholder) => placeholder !== BUS_PLACEHOLDER && !OUTPUT_PLACEHOLDER_PATTERN.test(placeholder))
    .map((placeholder) => {
      const declaredName = placeholderAliases.get(placeholder) ?? placeholder
      const rawValue = bindings[placeholder] ?? ""
      const semantic = inferKeywordArgumentSemantic(
        declaredName,
        argumentComments.get(declaredName) ?? "",
        keywordToCandidate(keyword),
      )
      if (rawValue === "" && semantic === "loop_interval") {
        // 文档化默认: 0 = 只发送当前一次(与语义提取路径的默认一致;
        // 空捕获不再产出 Value:null,避免下游 schema 校验 invalid_union)
        bindings[placeholder] = "0"
      } else if (rawValue === "") {
        bindings[placeholder] = declaredName
      } else if (semantic === "loop_interval") {
        // 模板捕获的循环时间可能是原文片段("以1秒为周期循环")——按值语义
        // 归一为数值("1"),否则渲染层 Comments 映射会把原文再嵌一层
        // "以XS为周期",产出"以以1秒为周期循环S为周期"乱码
        // (2026-08-26 循环触发模式取证)。捕获不到数字(如 触发外部中断 的
        // doc 槽位吞进了动词"触发")按无周期归 0——注释映射 [0:] 渲染为
        // 单次触发,不再产出"以触发为周期"乱码(2026-09-02 SpaceWire 取证)
        const numeric = rawValue.match(/-?\d+(?:\.\d+)?/)?.[0]
        bindings[placeholder] = numeric ?? "0"
      } else if (/(中断号|TRAP_ID)/.test(argumentComments.get(declaredName) ?? "")) {
        // 中断号是纯整数参数("中断号:0~4"):模板捕获可能吞进括号注记
        // ("2（低电平）"),按数字提取净化(2026-09-02 SpaceWire 取证)——电平
        // 注记由电平参数分支单独承载
        const numeric = rawValue.match(/-?\d+/)?.[0]
        if (numeric && numeric !== rawValue.trim()) bindings[placeholder] = numeric
      }

      return {
        Value: parseParameterValue(String(sanitizeDtpExecutableValue(bindings[placeholder] ?? rawValue))),
        Name: declaredName,
        Comments: argumentComments.get(declaredName) ?? "",
      }
    })

  // Documentation 模板未引用但已声明的参数(如 发送CANATXT数据 的 ${para1}
  // 指令ID——模板不含它,但运行时 VTest_SendCmd 调用需要,且用户要求指令ID
  // 在用例内取值)也要输出:值来自上面的 fill 分配,未填充类型保留占位。
  const declaredInTemplate = new Set(placeholdersInDocumentation.map((p) => placeholderAliases.get(p) ?? p))
  for (const name of keyword.argumentNames) {
    if (!name || declaredInTemplate.has(name)) continue
    parameter.push({
      Value: parseParameterValue(String(sanitizeDtpExecutableValue(
        bindings[name] ?? `{${name.replace(/^\$\{/, "").replace(/\}$/, "")}}`,
      ))),
      Name: name,
      Comments: argumentComments.get(name) ?? "",
    })
  }

  if (issues.length > 0) return { issues }

  const rendered = renderDocumentationTemplate(template, bindings, buildCommentMap(keyword))
  return {
    issues: [],
    step: {
      key_name: keyword.keywordName,
      step_desc: finalizeStepDesc(rendered.text, step.步骤描述),
      parameter,
      expected_result: sanitizeDtpExecutablePlaceholders(stripTerminalPunctuation(step.预期结果)),
    },
  }
}

export interface StepPlanHint {
  keyword_name: string
  argument_bindings: Record<string, string>
  /** Suggested operation_type anchor from step plan */
  suggested_operation_type?: string
  /** Suggested channel anchor from step plan */
  suggested_channel?: string
  /** Suggested temporal anchor from step plan */
  suggested_temporal?: string
}

const PURPOSE_TO_OPERATION_TYPE: Record<string, string> = {
  inject_input: "inject_input",
  trigger_output: "trigger_output",
  verify: "verify",
  set_input_data: "set_input_data",
  verify_telemetry: "verify_telemetry",
  send_command: "send_command",
  verify_response: "verify_response",
}

/**
 * Drop hint binding values that are not real values: placeholder literals
 * ("{para1}" / "${para1}") block the case-level ID allocator at translation
 * time, "无" is a field default, and overlong texts are requirement
 * background paragraphs pasted as data-file names. ${time} is dropped too —
 * the plan's synthetic timing (3.0s + 1.5s/step) cannot know the actual
 * step's 第N秒, and a wrong pre-bound time renders verbatim. Leave those to
 * the translator, which extracts from the actual step text.
 */
function sanitizeHintArgumentBindings(
  bindings: Record<string, string> | undefined,
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(bindings ?? {})) {
    if (name === "${time}") continue
    const text = String(value ?? "").trim()
    if (!text) continue
    if (/^\{[^}]+\}$/.test(text) || /^\$\{[^}]+\}$/.test(text)) continue
    if (text === "无") continue
    if (text.length > 60) continue
    result[name] = text
  }
  return result
}

/**
 * Convert a generated step plan into translator hints (B1a).
 * Mirrors the pre-f3086c9 manifest mapping so the hint carries the same
 * keyword name, pre-bound arguments, and suggested anchors.
 */
export function stepPlanToHints(stepPlan: StepPlan[]): StepPlanHint[] {
  return stepPlan.map((sp) => ({
    keyword_name: sp.keyword_name,
    argument_bindings: sanitizeHintArgumentBindings(sp.argument_bindings),
    suggested_operation_type: PURPOSE_TO_OPERATION_TYPE[sp.purpose],
    suggested_channel: sp.bus_channel || undefined,
    // 计划的 resolved_step_desc 是从需求上下文合成的,其"第N秒"是 3.0+1.5n
    // 合成时序,与 worker 实际步骤的时间必然错位——不作为时间建议下发;
    // 时间由翻译阶段从实际步骤文本提取(第N秒 模式),缺失时才用步骤自身锚点。
    suggested_temporal: undefined,
  }))
}

/** Local anchor-bearing step used within the translator */
interface StepWithAnchors {
  步骤描述: string
  预期结果: string
  operation_type?: string
  channel?: string
  temporal?: string
  data_checks?: string[]
}

function translateStep(
  step: StepWithAnchors,
  keywordMap: Map<string, KeywordMeta>,
  hint?: StepPlanHint,
  caseState?: CaseArgumentAllocationState,
  contextCorpus?: string,
): {
  step?: TranslatedTestStepRecord
  issues: string[]
  candidate_failures: Phase6CandidateTranslationFailure[]
} {
  if (keywordMap.size === 0) {
    return {
      issues: ["未加载到组合关键字库，无法生成 confirmation-tests.json"],
      candidate_failures: [],
    }
  }

  // 步骤匹配优先项目可变的 UserKeyWord 库（其他库文件为全项目固定内容，
  // 只会稀释候选排序）；UserKeyWord 无条目时回退全库。
  const matchMap = new Map([...filterUserKeywordMap(keywordMap)]
    .filter(([, candidate]) => keywordMatchesStepAction(step.步骤描述, candidate.keywordName)))

  // Pre-computed step plan hint: use the recommended keyword with precomputed bindings.
  // The hint is a strong preference, not a verdict: a step whose own semantic
  // anchors contradict the plan's suggestion is translated by the regular
  // anchor/global paths, and a failed hint render falls through to them too
  // (previously the hint was authoritative and failures aborted the step).
  const hintApplicable = Boolean(
    hint?.keyword_name &&
    !(step.operation_type && hint.suggested_operation_type &&
      step.operation_type !== hint.suggested_operation_type) &&
    !(step.channel && hint.suggested_channel && step.channel !== hint.suggested_channel),
  )
  const hintIssues: string[] = []
  if (hintApplicable) {
    const hintedKeyword = matchMap.get(hint!.keyword_name)
    if (hintedKeyword) {
      // 步骤自身锚点的时间优先于提示建议——提示时间来自计划合成,可能与
      // 实际步骤文本错位(2026-08-20 事故:0.5秒 被合成时序 3 覆盖)
      const temporalFromHint = step.temporal ?? hint!.suggested_temporal
      const hintedTranslated = translateStepWithKeyword(
        step, hintedKeyword, hint!.argument_bindings,
        temporalFromHint?.replace(/[^\d.]/g, ""),
        step.channel,
        temporalFromHint,
        caseState,
        contextCorpus,
      )
      if (hintedTranslated.step) return { ...hintedTranslated, candidate_failures: [] }
      hintIssues.push(
        ...(hintedTranslated.issues.length > 0
          ? hintedTranslated.issues
          : [`步骤计划提示中的关键字 ${hint!.keyword_name} 翻译失败`]),
      )
    } else {
      hintIssues.push(
        keywordMap.has(hint!.keyword_name)
          ? `步骤计划提示中的关键字 ${hint!.keyword_name} 不在 UserKeyWord 关键字库中（步骤匹配优先 UserKeyWord），已跳过`
          : `步骤计划提示中的关键字 ${hint!.keyword_name} 不在组合关键字库中`,
      )
    }
  }

  // Extract temporal value for pre-fill (strip Chinese characters, keep digits and dot)
  const temporalValue = step.temporal?.replace(/[^\d.]/g, "") || undefined

  // === Phase A: Anchor-guided candidate selection (new) ===
  const operationType = step.operation_type?.trim()
  const channel = step.channel?.trim()
  const hasAnchor = Boolean(operationType || channel)

  if (hasAnchor) {
    const anchorFilter: AnchorFilter = {
      ...(operationType ? { operation_type: operationType } : {}),
      ...(channel ? { channel } : {}),
    }

    const anchorCandidates = scoreKeywordCandidatesByAnchor(
      step.步骤描述,
      matchMap,
      anchorFilter,
      5,
    )

    const directName = matchMap.get(stripTerminalPunctuation(step.步骤描述))
    const anchorOrdered = [
      ...(directName && !anchorCandidates.some(c => c.keywordName === directName.keywordName)
        ? [directName] : []),
      ...anchorCandidates.filter(c => c.keywordName !== directName?.keywordName),
    ]
    // A candidate whose full keyword name appears verbatim in the step text is
    // the strongest possible signal — rank it before score-ordered peers so a
    // high-scoring near-miss (e.g. 设置内存数据8bit vs 设置32位地址数据) cannot win.
    const candidates = [
      ...anchorOrdered.filter((c) => step.步骤描述.includes(c.keywordName)),
      ...anchorOrdered.filter((c) => !step.步骤描述.includes(c.keywordName)),
    ]

    const failedIssues: string[] = []
    const candidateFailures: Phase6CandidateTranslationFailure[] = []
    // 绑定完整度偏好:首个成功者有 {paraN} 泄漏时继续尝试,优先返回零泄漏
    // 候选;全部泄漏才回退首个成功者(保留占位不整条失败的现行语义)
    let firstLeakySuccess: { step: TranslatedTestStepRecord; issues: string[] } | null = null
    for (const candidate of candidates) {
      const translated = translateStepWithKeyword(step, candidate, undefined, temporalValue, step.channel, step.temporal, caseState, contextCorpus)
      if (translated.step) {
        if (!hasUnboundParameterLeak(translated.step, candidate)) {
          // Soft-binding diagnostics (未提取参数占位) 必须随成功结果上抛,不能被 hintIssues 覆盖
          return { ...translated, issues: [...hintIssues, ...translated.issues], candidate_failures: [] }
        }
        firstLeakySuccess ??= { step: translated.step, issues: translated.issues }
        continue
      }
      candidateFailures.push({
        keyword_name: candidate.keywordName,
        source_json: candidate.sourceJson,
        source_txt: candidate.sourceTxt,
        category: categorizeTranslationIssues(translated.issues),
        issues: translated.issues,
      })
      failedIssues.push(...translated.issues)
    }
    if (firstLeakySuccess) {
      return { step: firstLeakySuccess.step, issues: [...hintIssues, ...firstLeakySuccess.issues], candidate_failures: [] }
    }

    // Don't fall back to global scoring yet — anchor info should be reliable
    // If anchor-guided matching failed, log and fall through to global scoring
  }

  // === Phase B: Traditional global keyword scoring (backward-compatible fallback) ===
  const directName = matchMap.get(stripTerminalPunctuation(step.步骤描述))
  // Verbatim name hits: a keyword whose full name appears in the step text is
  // the strongest match signal, yet score ranking can push it far below the
  // candidate cutoff (observed: rank 20 with limit 12, lost to keywords with
  // richer Documentation). Inject every name hit ahead of the scored peers,
  // longest name first (most specific).
  const nameHits = [...matchMap.values()]
    .filter((c) => c.keywordName !== directName?.keywordName && step.步骤描述.includes(c.keywordName))
    .sort((a, b) => b.keywordName.length - a.keywordName.length)
  const candidates = [
    ...(directName ? [directName] : []),
    ...nameHits,
    ...scoreKeywordCandidates(step.步骤描述, matchMap, 12)
      .filter((candidate) => candidate.keywordName !== directName?.keywordName
        && !step.步骤描述.includes(candidate.keywordName)),
  ]

  const failedIssues: string[] = []
  const candidateFailures: Phase6CandidateTranslationFailure[] = []
  // 绑定完整度偏好(与 Phase A 同规则):零泄漏候选优先,首个成功者仅作回退
  let firstLeakySuccess: { step: TranslatedTestStepRecord; issues: string[] } | null = null
  for (const candidate of candidates) {
    const translated = translateStepWithKeyword(step, candidate, undefined, temporalValue, step.channel, step.temporal, caseState, contextCorpus)
    if (translated.step) {
      if (!hasUnboundParameterLeak(translated.step, candidate)) {
        // Soft-binding diagnostics (未提取参数占位) 必须随成功结果上抛,不能被 hintIssues 覆盖
        return { ...translated, issues: [...hintIssues, ...translated.issues], candidate_failures: [] }
      }
      firstLeakySuccess ??= { step: translated.step, issues: translated.issues }
      continue
    }
    candidateFailures.push({
      keyword_name: candidate.keywordName,
      source_json: candidate.sourceJson,
      source_txt: candidate.sourceTxt,
      category: categorizeTranslationIssues(translated.issues),
      issues: translated.issues,
    })
    failedIssues.push(...translated.issues)
  }
  if (firstLeakySuccess) {
    return { step: firstLeakySuccess.step, issues: [...hintIssues, ...firstLeakySuccess.issues], candidate_failures: [] }
  }

  const allFailedIssues = [...hintIssues, ...failedIssues]
  return {
    issues: allFailedIssues.length > 0
      ? allFailedIssues.slice(0, 3)
      : [`步骤描述 "${step.步骤描述}" 未匹配到组合关键字`],
    candidate_failures: candidateFailures.slice(0, 5),
  }
}

// ============================================================
// INLINE TRANSLATION FOR BATCH WORKER
// ============================================================
// Called right after standardization to produce unified step records
// that carry both source descriptions and keyword-matched executable data.

export interface StandardizedCaseCombinedResult {
  steps: UnifiedTestStepRecord[]
  translate_status: "success" | "failure" | "not_applicable"
  issues: string[]
  totalSteps: number
  translatedSteps: number
  failedSteps: number
  skippedStartupSteps: number
  skippedManualSteps?: number
}

/** Lightweight startup step check (doesn't need full SourceConfirmationTestCase). */
function isStartupStep(
  step: { 步骤描述: string; 预期结果: string },
  stepIndex: number,
  testEnvironment?: string,
): boolean {
  const defaultEnv = "无"
  const swEnv = resolveGeneratedTestEnvironment("software")
  const env = testEnvironment ?? defaultEnv
  return (
    stepIndex === 0 &&
    stripTerminalPunctuation(env) === stripTerminalPunctuation(swEnv) &&
    stripTerminalPunctuation(step.步骤描述) === "启动软平台" &&
    stripTerminalPunctuation(step.预期结果) === "软件正常运行"
  )
}

/**
 * Translate a single StandardizedCase into unified (combined) step records.
 *
 * Called during batch generation, right after standardization and BEFORE
 * persistence. This replaces the old two-step flow where translation ran
 * after the source suite was already saved.
 *
 * @param standardizedCase - The standardized case from the standardizer
 * @param keywordMap - Pre-loaded keyword library
 * @param stepPlanHints - Optional pre-computed step plan hints (indexed by real step order)
 * @param testEnvironment - Optional test environment for startup step detection
 */
export function translateStandardizedCaseToCombined(
  standardizedCase: StandardizedCase,
  keywordMap: Map<string, KeywordMeta>,
  stepPlanHints: StepPlanHint[] = [],
  testEnvironment?: string,
  /** 需求级上下文语料(五字段/interruptContext)——未绑定参数的注释驱动
   * 兜底提取可从中取值(如 触发外部中断 的电平参数取中断表的触发方式) */
  contextCorpus?: string,
  manualRequirement = false,
): StandardizedCaseCombinedResult {
  if (manualRequirement) {
    return {
      steps: standardizedCase.test_step.map((step) => ({
        key_name: "", step_desc: step.步骤描述, parameter: [],
        source_step_desc: step.步骤描述, expected_result: step.预期结果,
        expected_key_name: "保留", source_expected_key_name: "保留", expected_parameter: [],
        is_startup_step: false, translation_exempt_reason: "manual_requirement",
      })),
      translate_status: "not_applicable", issues: [],
      totalSteps: standardizedCase.test_step.length, translatedSteps: 0, failedSteps: 0,
      skippedStartupSteps: 0, skippedManualSteps: standardizedCase.test_step.length,
    }
  }
  const issues: string[] = []
  let translatedCount = 0
  let failedCount = 0
  let skippedCount = 0
  // 指令ID 的分配范围是"当前测试用例":同一用例内每个指令一个 ID,不重复
  const caseState: CaseArgumentAllocationState = {
    usedInstructionIds: new Set<number>(),
    instructionIdByPhrase: new Map<string, number>(),
  }

  const unifiedSteps: UnifiedTestStepRecord[] = []
  let realStepIndex = 0 // counter for non-startup steps (aligns with StepPlanHint indices)

  for (let i = 0; i < standardizedCase.test_step.length; i++) {
    const sourceStep = standardizedCase.test_step[i]

    // Check startup step
    if (isStartupStep(sourceStep, i, testEnvironment)) {
      skippedCount++
      unifiedSteps.push({
        key_name: "",
        step_desc: sourceStep.步骤描述,
        parameter: [],
        source_step_desc: sourceStep.步骤描述,
        expected_result: sourceStep.预期结果,
        expected_key_name: "保留",
        source_expected_key_name: "保留",
        expected_parameter: [],
        is_startup_step: true,
      })
      continue
    }

    // Build StepWithAnchors from the standardized step
    const stepRecord = sourceStep as Record<string, unknown>
    const stepWithAnchors: StepWithAnchors = {
      步骤描述: sourceStep.步骤描述,
      预期结果: sourceStep.预期结果,
      operation_type: typeof stepRecord.operation_type === "string" ? stepRecord.operation_type : undefined,
      channel: typeof stepRecord.channel === "string" ? stepRecord.channel : undefined,
      temporal: typeof stepRecord.temporal === "string" ? stepRecord.temporal : undefined,
      data_checks: Array.isArray(stepRecord.data_checks) ? stepRecord.data_checks as string[] : undefined,
    }

    // Use hint by real step order
    const hint = stepPlanHints.length > realStepIndex ? stepPlanHints[realStepIndex] : undefined
    realStepIndex++

    const translated = translateStep(stepWithAnchors, keywordMap, hint, caseState, contextCorpus)
    if (translated.step) {
      const semanticIssues = translatedStepSemanticIssues(sourceStep.步骤描述, translated.step)
      if (semanticIssues.length) {
        translated.issues.push(...semanticIssues)
        translated.step = undefined
      }
    }

    if (translated.step) {
      translatedCount++
      // A successful fallback after a rejected/failed hint still carries the
      // hint diagnostics (e.g. keyword missing from library) — keep them so
      // callers can see why the plan hint was not used.
      if (translated.issues.length > 0) issues.push(...translated.issues)
      unifiedSteps.push({
        key_name: translated.step.key_name,
        step_desc: translated.step.step_desc,
        parameter: translated.step.parameter.map((p) => ({
          Value: p.Value,
          Name: p.Name,
          Comments: p.Comments,
        })),
        source_step_desc: sourceStep.步骤描述,
        expected_result: sourceStep.预期结果,
        expected_key_name: "保留",
        source_expected_key_name: "保留",
        expected_parameter: [],
        is_startup_step: false,
      })
    } else {
      failedCount++
      issues.push(...translated.issues)
      // Still produce a record — marked as failed, with source-only data
      unifiedSteps.push({
        key_name: "",
        step_desc: sourceStep.步骤描述,
        parameter: [],
        source_step_desc: sourceStep.步骤描述,
        expected_result: sourceStep.预期结果,
        expected_key_name: "保留",
        source_expected_key_name: "保留",
        expected_parameter: [],
        is_startup_step: false,
      })
    }
  }

  return {
    steps: unifiedSteps,
    translate_status: failedCount === 0 ? "success" : "failure",
    issues,
    totalSteps: standardizedCase.test_step.length,
    translatedSteps: translatedCount,
    failedSteps: failedCount,
    skippedStartupSteps: skippedCount,
  }
}
