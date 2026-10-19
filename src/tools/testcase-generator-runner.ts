import { tool, type ToolContext, type ToolDefinition } from "@opencode-ai/plugin"
import { MULTIPACKET_SEQUENCE_RULE } from "../shared/phase6-step-design-policy"
import { createHash } from "crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs"
import { basename, dirname, isAbsolute, join } from "path"
import {
  TEST_ENVIRONMENT_MODE_VALUES,
} from "../shared/test-environment"
import { loadPluginConfig } from "../plugin-config"
import {
  buildRequirementStepPlan,
  filterUserKeywordMap,
  scanKeywordDirs,
  scoreKeywordCandidatesWeighted,
  type KeywordMeta,
} from "../shared/testcase-keywords"
import {
  buildRequirementIndex,
  expandFunIdString,
  loadTestRequirementFile,
  type PreparedPhase6Input,
  type PreparedPhase6Requirement,
  preparePhase6Input,

  findCrossRequirementContext,
  getStressProtocolContextGaps,
} from "../shared/test-requirements"
import { appendConfirmationCaseToSuiteData } from "./ct-suite-builder"
import {
  requiredPrimaryBusesFromRequirementContext,
  serializeKeywordCandidate,
} from "../shared/keyword-argument-binding"
import {
  PHASE6_EXPLICIT_OUTPUT_RULE,
  PHASE6_FUNCTIONAL_SCOPE_RULE,
  PHASE6_NO_EXTRA_TEST_TYPE_RULE,
  PHASE6_NO_UNRESOLVED_PLACEHOLDER_RULE,
} from "../shared/phase6-testcase-policy"
import {
  injectInterfaceSections,
  loadPhase6PromptTemplates,
  formatMarkdownPromptTemplate,
  normalizePhase6TestType,
  resolvePhase6PromptTemplate,
  type Phase6ProjectType,
  type ResolvedPhase6PromptTemplate,
  loadGenerationGuide,
  injectGenerationGuideIntoPrompt,
} from "../shared/phase6-prompt-templates"
import { moduleDir } from "../shared/runtime-paths"
import { classifyJsonParseError } from "./phase6-worker-output-append"
import { extractJsonFromMarkdown } from "../shared/phase6-testcase-standardizer"
import {
  DEFAULT_INPUT_DATASET_ID,
} from "../shared/input-dataset-generator"
import { ARTIFACT_PATHS } from "../shared/constants"
import type { Phase6GenerationItem } from "../schema/phase6-structured-artifacts"
import { buildSingleRequirementWorkerPrompt, buildPhase6ValidationRepairDirective, buildPhase6FileRepairPrompt } from "../shared/phase6-worker-prompt"
import { buildPhase6DomainKnowledge } from "../shared/phase6-domain-knowledge"
import { isManualTestRequirement, manualTestEnvironment, isIntegratedStressTest, testTypeGenerationRules, validateTestTypeCases } from "../shared/phase6-test-type-policy"
import { resolveFunctionalModel, functionalInterfaceSections, functionalModelRules, isAutonomousTelemetry } from "../shared/phase6-functional-model"
import {
  buildCoverageChecklist,
  buildTrItemCoverageList,
} from "../shared/phase6-coverage-checklist"

import { standardizeGeneratedTestcases } from "../shared/phase6-testcase-standardizer"
import {
  analyzeCaseAggregation,
  analyzeCaseStructure,
  suppressContradictoryAggregation,
  type CaseStructureAnalysis,
  extractLengthVariantBases,
  buildRegroupDirective,
  repairCaseStructure,
  type MemoryAddressRange,
  type RepairableStep,
  stepPlanToHints,
  translateStandardizedCaseToCombined,
} from "../shared/phase6-confirmation-translator"


// ---------------------------------------------------------------------------
// 步骤计划（B1a）manifest 映射
// ---------------------------------------------------------------------------

function purposeToOperationType(purpose: string): string | undefined {
  const map: Record<string, string> = {
    inject_input: "inject_input",
    trigger_output: "trigger_output",
    verify: "verify",
    set_input_data: "set_input_data",
    verify_telemetry: "verify_telemetry",
    send_command: "send_command",
    verify_response: "verify_response",
  }
  return map[purpose]
}

function extractTemporalFromDesc(desc?: string): string | undefined {
  if (!desc) return undefined
  const match = desc.match(/第(\d+(?:\.\d+)?)秒/)
  return match ? `第${match[1]}秒` : undefined
}

// ---------------------------------------------------------------------------
// 共享字段映射表（两个工具共用）
// ---------------------------------------------------------------------------

/** 将 matrix TestRequirement.type 映射为模板使用的中文测试类型。
 *  覆盖软件动态测试支持的全部类型。 */
const TYPE_TO_CHINESE: Record<string, string> = {
  functional: "功能测试",
  interface: "接口测试",
  performance: "性能测试",
  robustness: "可靠性安全性测试",
  safety: "可靠性安全性测试",
  boundary: "边界测试",
  stress: "强度测试",
  margin: "余量测试",
  data_processing: "数据处理测试",
  recovery: "恢复性测试",
  logic: "逻辑测试",
  logic_test: "逻辑测试",
  timing: "时序测试",
}

/** 将 CNAS 新格式父节点 title（中文测试类型）映射为英文 type 枚举值 */
const CHINESE_TITLE_TO_TYPE: Record<string, string> = {
  "功能测试": "functional",
  "接口测试": "interface",
  "性能测试": "performance",
  "可靠性安全性测试": "safety",
  "安全性测试": "safety", // Legacy requirement input; generation uses the canonical Chinese name.
  "健壮性测试": "robustness",
  "边界测试": "boundary",
  "强度测试": "stress",
  "余量测试": "margin",
  "数据处理测试": "data_processing",
  "恢复性测试": "recovery",
  "逻辑测试": "logic",
  "时序测试": "timing",
}

const DEFAULT_KEYWORD_DIRS = [
  ".matrix/data/DTPProject/组合关键字",
]

export function resolveKeywordSearchDirs(
  projectDir: string,
  configuredDirs?: string[],
): string[] {
  const dirs = (configuredDirs && configuredDirs.length > 0)
    ? configuredDirs
    : DEFAULT_KEYWORD_DIRS

  return dirs.map((dir) => resolveKeywordSearchDir(projectDir, dir))
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value)
}

function isPosixAbsolutePath(value: string): boolean {
  return value.startsWith("/") && !isWindowsAbsolutePath(value)
}

function resolveKeywordSearchDir(projectDir: string, dir: string): string {
  if (isPosixAbsolutePath(dir) || isWindowsAbsolutePath(dir)) return dir
  if (isPosixAbsolutePath(projectDir)) {
    const base = projectDir.replace(/\/+$/, "")
    const child = dir.replace(/^[\\/]+/, "").replace(/\\/g, "/")
    return `${base}/${child}`
  }
  return join(projectDir, dir)
}

function getToolBaseDirectory(ctx?: ToolContext): string {
  const candidates = [ctx?.directory, ctx?.worktree, process.cwd()]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
  return candidates[0] || process.cwd()
}

function resolveTestRequirementsFilePath(projectDir: string, supplied?: string): string {
  if (!supplied) return join(projectDir, ARTIFACT_PATHS.TEST_REQUIREMENTS)
  return isAbsolute(supplied) ? supplied : join(projectDir, supplied)
}

function persistSingleRequirementWorkerPrompt(
  projectDir: string,
  requirementId: string,
  workerPrompt: string,
): string {
  const safeRequirementId = requirementId.replace(/[^\w.-]+/g, "_")
  const dir = join(projectDir, ARTIFACT_PATHS.PHASE6_WORKER_PROMPTS_DIR)
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, `${safeRequirementId}.txt`)
  writeFileSync(filePath, workerPrompt, "utf-8")
  return filePath
}


/**
 * 引用条款错误分支送达(2026-09-17):功能测试的总线收发类需求(收到指令X→
 * 发送/返回Y),其错误处理常定义在同项目其他需求组(如 NCDC/NCZL 注明"错误
 * 处理见TR-JK-001~003";TM 组甚至无引用,错误分支只在接口组条款中)。扫描
 * 其他需求组的处理描述,提取同时命中本组指令/数据名与错误语义(错误/丢弃/
 * 计数)的句子,作为 <referenced_error_clauses> 注入生成提示,供 worker 编写
 * 错误交替步骤——没有它,worker 只能漏掉错误覆盖或编造计数语义。
 */
function buildReferencedErrorClausesBlock(
  req: Pick<PreparedPhase6Requirement, "requirement_id" | "test_type" | "handling" | "inputFlow">,
  allRequirements: PreparedPhase6Requirement[],
): string {
  if (req.test_type !== "functional") return ""
  const selfCorpus = `${req.handling ?? ""}\n${req.inputFlow ?? ""}`
  if (!/收到|接收/.test(selfCorpus) || !/总线|指令|控制序列/.test(selfCorpus)) return ""
  const cores = new Set<string>()
  for (const m of selfCorpus.matchAll(/[\u4e00-\u9fa5A-Za-z0-9]{2,12}?(?:控制序列|指令|数据块)/g)) {
    if (m[0].length >= 6) cores.add(m[0])
  }
  if (cores.size === 0) return ""
  const stripDigits = (t: string) => t.replace(/[0-9~～]/g, "")
  const normCores = [...cores].map(stripDigits)
  const sentences: string[] = []
  for (const other of allRequirements) {
    if (other.requirement_id === req.requirement_id) continue
    for (const s of (other.handling ?? "").split(/[。；\n]/)) {
      const t = s.trim()
      if (t.length < 8 || t.length > 160) continue
      if (!/错误|丢弃|计数/.test(t)) continue
      const normT = stripDigits(t)
      if (normCores.some((c) => normT.includes(c))) sentences.push(t)
    }
  }
  const unique = [...new Set(sentences)].slice(0, 6)
  if (unique.length === 0) return ""
  return [
    "",
    "<referenced_error_clauses>",
    "相关需求条款中与本指令/数据相关的错误处理描述（编写错误注入与恢复步骤时，错误类型与软件响应以此为准，禁止编造）：",
    ...unique.map((t, i) => `${i + 1}. ${t}`),
    "</referenced_error_clauses>",
  ].join("\n")
}

/**
 * 功能测试中的一级 CAN 接收处理需求虽然验证的是业务处理结果，但其输入
 * 仍是有明确帧/包结构的协议数据。接口测试模板已有完整的字段、代表帧和
 * 帧序号覆盖规则；功能模板过去只写“错误注入”，worker 会把协议载荷当成
 * 一个不可分的名字，造成字段漏测、两帧数据按单帧处理，以及双辅助数据包
 * 被拆成彼此无关的正常/异常步骤。
 *
 * 这里按需求语义注入一段确定性的功能测试协议规则，使 markdown、legacy、
 * satellite 三类模板路径得到同一份约束。step_plan 仍只负责关键字/通道路由，
 * 不得覆盖本段从格式表恢复出的包数、帧数和步骤编排。
 */
function extractMemoryAddressRanges(corpus: string): MemoryAddressRange[] {
  const ranges: MemoryAddressRange[] = []
  const seen = new Set<string>()
  const patterns = [
    /(0x[0-9a-f]+)\s*(?:~|～)\s*(0x[0-9a-f]+)/gi,
    /[\[(（]\s*(0x[0-9a-f]+)\s*[,，]\s*(0x[0-9a-f]+)\s*[\])）]/gi,
  ]
  for (const pattern of patterns) {
    for (const match of corpus.matchAll(pattern)) {
      const lower = match[1]!
      const upper = match[2]!
      const key = `${lower.toLowerCase()}:${upper.toLowerCase()}`
      if (seen.has(key)) continue
      seen.add(key)
      ranges.push({ lower, upper })
    }
  }
  return ranges
}

function buildFunctionalCanReceiveProtocolRules(
  req: Pick<PreparedPhase6Requirement,
    "test_type" | "name" | "requirementContext" | "handling" | "inputFlow" | "outputFlow">,
): string {
  if (req.test_type !== "functional") return ""
  if (resolveFunctionalModel({ name: req.name, testType: req.test_type }) !== "default") return ""
  const corpus = [
    req.name,
    req.requirementContext,
    req.handling,
    req.inputFlow,
    req.outputFlow,
  ].filter(Boolean).join("\n")
  if (!/(收到|接收)/.test(corpus)) return ""

  const pollingSequence = /轮询控制序列/.test(corpus)
  const timeBroadcast = /星务时间广播/.test(corpus)
  const memoryReadCommand = /内存读出指令接收处理/.test(req.name)
    || (/内存读出指令/.test(req.name) && extractMemoryAddressRanges(corpus).length > 0)
  const memoryDataPolling = /内存数据轮询(?:指令|控制序列)?接收处理/.test(req.name)
    || (/内存数据轮询/.test(req.name) && /内存读出指令/.test(corpus))
  const twoAuxiliaryPackets = /辅助数据/.test(corpus)
    && /(?:每秒[^。；\n]{0,20}(?:2|两)包|(?:2|两)个数据包|辅助数据包\s*(?:1|一)[\s\S]{0,2000}辅助数据包\s*(?:2|二)|第\s*1\s*包[\s\S]{0,2000}第\s*2\s*包)/.test(corpus)
  if (!pollingSequence && !timeBroadcast && !twoAuxiliaryPackets && !memoryReadCommand && !memoryDataPolling) return ""

  const lines = [
    "",
    "<functional_can_receive_protocol_rules>",
    "以下规则是功能测试中一级 CAN 接收协议的强制步骤模型，优先级高于 step_plan；step_plan 只提供关键字和通道路由，不能替代格式表中的包数、帧数和字段结构。",
    "- 必须逐表读取输入流格式：先区分数据包，再统计每包帧数，并从表头、首帧/中间帧/尾帧行及处理描述汇总全部校核字段。不得把多帧包写成一条未说明帧结构的原子数据，也不得只抽样部分字段。",
    "- 每个错误步骤只注入一个字段或一种帧序号错误；仲裁场与控制场是两个独立字段，禁止合并成“仲裁场/控制场错误”。步骤只写包名、代表帧和错误字段，不罗列具体协议字节值。",
    "- 对每条接收总线分别生成一个用例；同一总线内保留完整协议测试主线，不按正常/异常或字段类型拆成多个用例。",
  ]

  if (pollingSequence) {
    lines.push(
      "- 轮询控制序列：按格式表逐字段/逐字节覆盖全部错误情况。初始发送一次完整正确序列，随后按“单字段错误→完整正确序列”交替；必须覆盖仲裁场、控制场以及有效数据场内每个协议字段/字节（含 TITLE/类型字、功能/选择字、数据字、SUM 等表中实际存在的字段），不能只生成仲裁场、TITLE、SUM 三种样例。",
    )
  }

  if (timeBroadcast) {
    lines.push(
      "- 星务时间广播：输入格式表有2条帧记录，因此每次发送的是一个完整2帧数据包，不是单帧数据。正确步骤必须明确“发送完整2帧的正确星务时间广播数据”；错误步骤必须标明首帧或尾帧。首帧、尾帧分别覆盖其适用字段错误，并覆盖2帧协议的6类帧序号错误（首帧重复/序号错误/丢失，尾帧重复/序号错误/丢失）；2帧数据不存在中间帧。",
      "- 星务时间广播的字段位置以格式表为准：LENGTH、TITLE 等只在首帧出现的字段只测首帧，SUM 等只在尾帧出现的字段只测尾帧；仲裁场、控制场、INDEX/帧序号等逐帧字段在首帧和尾帧分别覆盖。",
    )
  }

  if (twoAuxiliaryPackets) {
    lines.push(
      "- 卫星服务系统辅助数据：需求定义的是两个不同的多帧输入包（辅助数据包1、辅助数据包2），两包必须放在同一总线的同一个用例中，不得使用不带包号的“辅助数据包”，也不得把正常测试与错误测试拆成不同用例。",
      `- ${MULTIPACKET_SEQUENCE_RULE}`,
      "- 代表帧适用字段按格式表判定：首帧覆盖仲裁场、控制场、INDEX、LENGTH、TITLE 等实际字段；中间帧覆盖仲裁场、控制场、INDEX/帧序号等实际字段；尾帧覆盖仲裁场、控制场、INDEX、SUM 等实际字段。3帧及以上的帧序号错误覆盖首/中/尾各3类（重复、序号错误、丢失），每步只放一种错误。",
      "- 计数预期从需求给定初值（未给出时按0）连续计算：每个完整正确数据包被处理并转发，正确计数加1并写绝对值；错误包不处理、不转发，正确计数保持上一步绝对值。只有需求或引用条款明确给出错误计数器时才写错误计数加1及其绝对值，禁止编造错误计数器。",
      "- 双辅助数据包同样以包2正确收尾：正确包1→包1单字段错误→包2剩余字段逐项错误→完整正确包2。它替代旧的四步循环及通用同包错误后立即恢复规则。",
    )
  }

  if (memoryReadCommand) {
    lines.push(
      "- 内存读出指令每条接收总线只设计两类场景，字段错误场景与地址边界场景分成两个独立用例，不再按MRAM/SRAM、区内/区外继续拆分。",
      "- 字段错误场景：从完整正确指令开始，按“单字段错误→完整正确指令”交替；覆盖仲裁场、控制场、LENGTH、TITLE、INDEX、SUM及格式表中的其他校验字段，并必须增加“地址非4字节对齐”这一单错误步骤。",
      "- 非4字节对齐的地址本身就是错误指令，禁止将其向下对齐后当作正确指令处理。预期必须是不读取、不更新内存读出数据，正确指令计数保持，错误指令计数加1并写绝对值。",
      "- 地址边界场景：对需求中每个独立地址区间分别覆盖下边界-1、下边界、下边界+1、区间内任意一个4字节对齐值、上边界-1、上边界、上边界+1；区间较窄时将重合值去重，不编造重复场景。",
      "- 边界步骤按原始指令地址判定：只有位于任一合法区间且为4字节对齐的地址才是正确指令；越界或非对齐地址均按错误指令处理。最后一个“上边界+1”错误后可追加一次区间内正确地址用于恢复校验。",
    )
  }

  if (memoryDataPolling) {
    lines.push(
      "- 内存数据轮询接收处理：每条总线用例的第1个业务步骤必须是“第3.0秒，通过当前总线以5秒为周期循环发送正确的内存读出指令”。不得用设置内存数据或 initial_settings 代替该前置指令，也不得在后续重复手工发送。",
      "- 周期内存读出指令的实际时刻为3.0、8.0、13.0秒…；后续内存数据轮询步骤必须严格在每次读出指令2秒后执行，即5.0、10.0、15.0秒…。",
      "- 轮询步骤从完整正确轮询开始，再按“单字段错误→完整正确轮询”交替，依次覆盖仲裁场、控制场、TITLE、W0、W1、SUM等格式表全部字段。正确轮询才组帧返回内存读出数据，错误轮询不处理且不返回。",
      "- 该用例中“内存读出指令”是“内存数据轮询控制序列”的必要前置，两者必须保留在同一用例，不按混指令拆分。",
    )
  }

  lines.push("</functional_can_receive_protocol_rules>")
  return lines.join("\n")
}

function persistPhase6GenerationManifest(projectDir: string, payload: unknown): string {
  const filePath = join(projectDir, ARTIFACT_PATHS.PHASE6_GENERATION_MANIFEST)
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf-8")
  return filePath
}

function textOfContext(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/**
 * B1b: 按 requirement_id 从 phase6-generation-items.json 回填标准化上下文。
 * testcase_generator_run 已把每条 requirement 的 normalization_context 持久化在
 * manifest 中；主智能体调用 testcase_format_check 时未显式传五字段上下文时，
 * 用与生成阶段一致的上下文兜底，保证占位符解析与步骤计划重算输入一致。
 */
function loadNormalizationContextFromManifest(
  projectDir: string,
  requirementId: string,
): Record<string, unknown> | null {
  const manifestPath = join(projectDir, ARTIFACT_PATHS.PHASE6_GENERATION_MANIFEST)
  if (!existsSync(manifestPath)) return null
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf-8"))
    const items = Array.isArray((parsed as Record<string, unknown>)?.items)
      ? (parsed as Record<string, unknown>).items
      : []
    const item = (items as Array<Record<string, unknown>>).find(
      (entry) => entry?.requirement_id === requirementId,
    )
    if (!item || typeof item.normalization_context_json !== "string") return null
    const context = JSON.parse(item.normalization_context_json)
    if (!context || typeof context !== "object") return null
    // 中断上下文随 item 透传(工件级字段,翻译层电平参数兜底需要它)
    if (typeof item.interruptContext === "string" && item.interruptContext.trim()) {
      ;(context as Record<string, unknown>).interruptContext = item.interruptContext
    }
    return context as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * persist=true 分支:把 format_check 已标准化+翻译的全部用例直接写入
 * confirmation-tests.json(文件到文件,主智能体零回显)。
 *
 * 背景:大用例集(如 216KB、12 用例的接口测试输出)若要求主智能体把
 * worker 落盘 JSON 经 generated_text 参数回显,必然超出单次输出能力,
 * 触发主智能体手工分块并丢失用例。persist 分支在工具侧完成保存:
 * cfid=需求项整组 funId(canonicalize 自动补全)、covered_tr_items 透传、
 * path/test_type 由 requirementIndex 从 test-requirements.json 权威解析。
 */
function persistCheckedCasesToSuite(args: {
  projectDir: string
  requirementId: string
  cases: Array<{
    case_name: string
    test_purpose: string
    test_step: unknown
    covered_tr_items?: string[]
    initial_settings?: string
    test_input?: string
    test_environment?: string
  }>
  translationResults: Array<{ steps: unknown; translate_status?: "success" | "failure" | "not_applicable" }>
}): { error?: string; persisted_case_count?: number; case_ids?: string[]; warnings?: string[] } {
  const suitePath = join(args.projectDir, ARTIFACT_PATHS.CONFIRMATION_TESTS)
  if (!existsSync(suitePath)) {
    return { error: "persist 失败:confirmation-tests.json 不存在,请先调用 ct_suite_create 再使用 persist。" }
  }

  let suite: Record<string, unknown>
  try {
    suite = JSON.parse(readFileSync(suitePath, "utf-8"))
  } catch (error) {
    return { error: `persist 失败:suite 文件不是合法 JSON:${error instanceof Error ? error.message : String(error)}` }
  }

  let requirementIndex = new Map()
  try {
    requirementIndex = buildRequirementIndex(loadTestRequirementFile(join(args.projectDir, ARTIFACT_PATHS.TEST_REQUIREMENTS)))
  } catch {
    // 需求文件缺失时按空索引保存(canonicalize 保持输入原样)
  }

  const warnings: string[] = []
  const caseIds: string[] = []
  for (let i = 0; i < args.cases.length; i++) {
    const stdCase = args.cases[i]
    const translated = args.translationResults[i]
    const appended = appendConfirmationCaseToSuiteData(
      suite,
      {
        case_name: stdCase.case_name,
        test_purpose: stdCase.test_purpose,
        correspond_fun_id: args.requirementId,
        test_type: "",
        test_step: translated?.steps ?? stdCase.test_step,
        translate_status: translated?.translate_status,
        covered_tr_items: stdCase.covered_tr_items,
        // 标准化按用例提取的初始状态/测试输入(语义绑定可能已改写为数据集引用)
        // 必须随 persist 一起落库——此前两条保存路径不一致,persist 路径恒落"无"
        initial_settings: stdCase.initial_settings,
        test_input: stdCase.test_input,
        // 看门狗等硬平台用例的环境随标准化结果透传(append 按 mode 解析)
        test_environment: stdCase.test_environment,
        test_environment_mode: stdCase.test_environment === "硬平台测试环境" ? "evaluation" : undefined,
      },
      requirementIndex,
    )
    suite = appended.suite
    caseIds.push(appended.canonical_case_id)
    warnings.push(...appended.warnings)
  }

  const tempPath = `${suitePath}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tempPath, JSON.stringify(suite, null, 2), "utf-8")
  renameSync(tempPath, suitePath)
  return { persisted_case_count: caseIds.length, case_ids: caseIds, warnings }
}

function clearStalePhase6PublishedOutputs(projectDir: string): string[] {
  const staleFiles = [
    join(projectDir, ".matrix", "reports", "test-cases.md"),
    join(projectDir, ".matrix", "reports", "confirmation-tests.docx"),
  ]

  const removed: string[] = []
  for (const filePath of staleFiles) {
    if (!existsSync(filePath)) continue
    unlinkSync(filePath)
    removed.push(filePath)
  }

  return removed
}

/**
 * 根据 priority 派生出的充分性要求。
 * 会填充到提示词模板中的 `{tr_sufficiency}` 占位符。
 */
const PRIORITY_SUFFICIENCY: Record<string, string> = {
  critical: "需覆盖所有等价类、边界值和异常/错误注入场景，进行全面验证。",
  high: "需覆盖主要等价类和关键边界值，包含正常和异常场景。",
  medium: "需覆盖代表性等价类，包含正常场景和主要边界值。",
  low: "需覆盖基本功能场景和典型边界值。",
}

function resolveChineseTestType(type: string | undefined): string | null {
  const direct = normalizePhase6TestType(type)
  if (direct) return direct
  const normalized = normalizeRequirementType(type)
  return normalizePhase6TestType(TYPE_TO_CHINESE[normalized])
}

function normalizeRequirementType(type: string | undefined): string {
  const normalized = String(type ?? "").trim()
  if (!normalized) return ""
  if (normalized in TYPE_TO_CHINESE) return normalized
  if (normalized in CHINESE_TITLE_TO_TYPE) return CHINESE_TITLE_TO_TYPE[normalized]

  const lower = normalized.toLowerCase()
  if (lower in TYPE_TO_CHINESE) return lower

  return normalized
}

/**
 * 每种需求类型的默认测试方法说明。
 * 会填充到提示词模板中的 `{tr_testMethod}` 占位符。
 */
const TEST_METHOD_BY_TYPE: Record<string, string> = {
  functional:
    "采用功能验证方法进行功能测试，仅验证当前需求明确描述的功能点是否实现正确。" +
    "如背景知识明确存在 CANA/CANB 等并行通道，应在同一测试用例的不同步骤中覆盖；" +
    "除非需求明确提出，否则不要自动扩展边界值、异常输入、无效格式、恢复错误影响、未收到数据、连续接收等附加场景。",
  interface:
    "采用边界值分析和错误注入方法进行接口测试。" +
    "1）验证接口参数在合法范围内的正确响应；" +
    "2）验证接口参数在边界值处的处理行为；" +
    "3）验证接口参数超出合法范围时的错误处理。" +
    "同一接口的正常和异常测试必须合并在同一测试用例中。",
  performance:
    "硬平台测试环境，人工使用示波器多次测试需求指定的时间指标，预期直接陈述指标约束；不翻译关键字、不进入 DTP/Robot。",
  robustness:
    "采用与功能测试相似的操作步骤完成可靠性安全性需求覆盖，不增加需求未规定的故障、保护或恢复场景。",
  safety:
    "采用与功能测试相似的操作步骤完成可靠性安全性需求覆盖，不增加需求未规定的故障、保护或恢复场景。",
  boundary:
    "采用边界值分析方法进行边界测试。对每个参数，依次测试：" +
    "下边界-1（下边界外）、下边界、下边界+1、代表中间值、上边界-1、上边界、上边界+1（上边界外），" +
    "重合值去重，窄区间不必凑足七步；根据需求判断各点合法性，同一需求项的不同边界值在同一用例的不同步骤中。",
  stress:
    "验证系统长时间运行状态下的响应，一条需求只能生成一个综合用例，覆盖其中所有功能，步骤采用同一时间原点连续编排，不按总线或指令拆例。",
  margin:
    "人工分析，查看资源量使用文件，确认需求指定的资源余量；预期陈述需求规定的容量/比例约束，不翻译关键字、不进入 DTP/Robot。",
  data_processing:
    "采用与功能测试相似的操作步骤覆盖需求规定的数据处理分支和输出，不自由增加异常、性能或边界场景。",
  recovery:
    "采用与可靠性安全性测试相似的步骤覆盖需求规定的恢复条件和恢复后行为，不自由增加故障、复位、重试、时限或状态。",
  logic:
    "采用逻辑覆盖测试方法。使用代码覆盖率分析工具对源代码进行插桩，在测试环境中运行被测软件，" +
    "执行功能测试等各种测试用例，查看语句、分支的覆盖情况，并根据覆盖情况设计新的测试用例，" +
    "逐步达到语句覆盖率、分支覆盖率100%的要求。",
}

function resolveRequirementSufficiency(
  req: Pick<PreparedPhase6Requirement, "sufficiency" | "priority" | "test_type">,
): string {
  if (req.sufficiency != null && req.sufficiency !== "") {
    return req.sufficiency
  }

  if (req.test_type === "functional") {
    return "仅覆盖需求明确描述的功能点正确行为；不要自动扩展边界、异常、无效或恢复类附加场景。"
  }

  return PRIORITY_SUFFICIENCY[req.priority] ?? ""
}

// ---------------------------------------------------------------------------
// TR 项提取（自 excel-requirement-loader 迁移；Excel 路径已移除）
// ---------------------------------------------------------------------------

/** TR item with its description */
interface TrItem {
  /** TR item ID, e.g. "TR-GN-BOOT-001" */
  id: string
  /** Condition/description from the handling field */
  description: string
}

const TR_ID_PATTERN = /TR-[A-Z]+(?:-[A-Z]+)*-\d+/g

/**
 * Extract TR item IDs and their descriptions from the handling text.
 * Each TR item is of the form: "TR-xxx-xxx-NNN：description..."
 */
function extractTrItems(handling: string): TrItem[] {
  if (!handling) return []

  const items: TrItem[] = []

  // Split by TR-xxx-xxx-NNN pattern boundaries
  const parts = handling.split(/(?=TR-[A-Z]+(?:-[A-Z]+)*-\d+[：:])/)
  for (const part of parts) {
    const match = part.match(/^(TR-[A-Z]+(?:-[A-Z]+)*-\d+)[：:]\s*(.*)/s)
    if (match) {
      items.push({
        id: match[1].trim(),
        description: match[2].trim().replace(/\s+/g, " "),
      })
    }
  }

  return items
}

/** Collect all unique TR item IDs from a handling text. */
function extractTrIds(handling: string): string[] {
  if (!handling) return []
  const matches = handling.match(TR_ID_PATTERN) ?? []
  return [...new Set(matches)]
}

// ---------------------------------------------------------------------------
// testcase_generator_run —— 辅助函数
// ---------------------------------------------------------------------------

function toTrItem(req: PreparedPhase6Requirement): Record<string, string> {
  const sufficiencyValue = resolveRequirementSufficiency(req)

  const item: Record<string, string> = {
    funId: req.requirement_id,
    handling: req.handling,
    sufficiency: sufficiencyValue,
    testMethod: TEST_METHOD_BY_TYPE[req.test_type] ?? (TYPE_TO_CHINESE[req.test_type] ?? "功能测试"),
    passCriteria: req.pass_criteria,
    inputFlow: req.inputFlow ?? "",
    outputFlow: req.outputFlow ?? "",
    // New template placeholders for test-*.md templates
    summary: req.requirementContext || req.chapter_background || "",
    testConstraint: req.constraintContext || "",
  }
  // name 字段 —— 用于 FPGA 模板以及包含 {tr_name} 的软件模板
  if (req.name) {
    item.name = req.name
  }
  return item
}

/**
 * 与 auto-testcase-generator 中 docx_type 对应的项目类型：
 *   1 = requirements（TR-XQ 模板，仅包含 tr_id + tr_handling）
 *   2/4 = software（类型专属模板或 TR-DG-STEP-GENERATED）
 *   3 = FPGA（FPGA 专属模板或 FPGA-DG-STEP-NOT-GENERATED）
 */
type DocxType = 1 | 2 | 3 | 4

/** 将 project_type 字符串参数映射为数值型 docx_type */
const PROJECT_TYPE_TO_DOCX: Record<string, DocxType> = {
  requirements: 1,
  software: 2,
  fpga: 3,
  software_variant: 4,
}

/**
 * 通过替换 {placeholder} 占位符来格式化模板字符串。
 * 对应 auto-testcase-generator 中 model_helper._build_prompt()：
 *   - docx_type 1：仅包含 tr_id、tr_handling
 *   - docx_type 2/3/4：包含 tr_id、tr_handling、tr_sufficiency、tr_testMethod、tr_passCriteria、tr_name
 */
function formatTemplate(
  template: string,
  values: Record<string, string>,
  docxType: DocxType = 2,
): string {
  // 构建替换映射，处理正确的前缀映射
  const replacements: Record<string, string> = {
    tr_id: values.funId ?? "",
    tr_handling: values.handling ?? "",
  }

  if (docxType !== 1) {
    replacements.tr_sufficiency = values.sufficiency ?? ""
    replacements.tr_testMethod = values.testMethod ?? ""
    replacements.tr_passCriteria = values.passCriteria ?? ""
    replacements.tr_input_flow = values.inputFlow ?? ""
    replacements.tr_output_flow = values.outputFlow ?? ""
    // New placeholders for test-*.md templates (priority 45)
    replacements.tr_summary = values.summary ?? ""
    replacements.tr_testConstraint = values.testConstraint ?? ""
    // {input_flow} (without "tr_" prefix) — used by test-*.md templates
    replacements["input_flow"] = values.inputFlow ?? ""
    // tr_name 为可选字段 —— 用于 FPGA 模板以及包含 {tr_name} 的软件模板
    if (template.includes("{tr_name}")) {
      replacements.tr_name = values.name ?? ""
    }
  }

  return template.replace(/\{(\w+)\}/g, (match, key) => {
    return key in replacements ? replacements[key] : match
  })
}

function buildRequirementSearchText(req: PreparedPhase6Requirement): string {
  return [
    req.handling,
    req.pass_criteria,
    req.chapter_background ?? "",
    req.chapter_title ?? "",
    req.inputFlow ?? "",
    req.outputFlow ?? "",
    req.name ?? "",
  ]
    .filter(Boolean)
    .join(" ")
}

function buildGenerationPromptSuffix(args: {
  requirementId: string
  testTypeChinese: string
  chapterBackground: string
  chapterTitle: string
  inputFlow: string
  outputFlow: string
}): string {
  const compact = (value: string): string => {
    const normalized = value.replace(/\s*\n+\s*/g, " ").replace(/\s+/g, " ").trim()
    return normalized || "无"
  }

  return [
    "",
    "### 补充上下文",
    "- 下列内容用于补充 requirement 背景；若同时提供 `<normalization_context>`，以后者为准。",
    `- requirement_id：${compact(args.requirementId)}`,
    `- 测试类型：${compact(args.testTypeChinese)}`,
    `- 章节标题：${compact(args.chapterTitle)}`,
    `- 章节背景：${compact(args.chapterBackground)}`,
    `- 输入流：${compact(args.inputFlow)}`,
    `- 输出流：${compact(args.outputFlow)}`,
    "",
    "### 统一补充要求",
    "- 最终的关键字匹配、协议名称替换与 Documentation 格式收敛由后续 testcase_format_check 统一完成。",
    "- 若需求语义明确存在总线发送动作，步骤应围绕真实操作意图展开，不要写成泛泛的概述性口号。",
    "- 对于需求和协议中都没有明确值的占位符，可在后续调用 testcase_format_check 时通过 placeholder_suggestions 提供建议值；若仍无法解析，标准化阶段会保留原占位符并给出非阻断提示。",
    `- ${PHASE6_EXPLICIT_OUTPUT_RULE}`,
    `- ${PHASE6_NO_UNRESOLVED_PLACEHOLDER_RULE}`,
    args.testTypeChinese === "功能测试"
      ? `- ${PHASE6_FUNCTIONAL_SCOPE_RULE}`
      : "",
    args.testTypeChinese === "功能测试"
      ? "- 需要同时覆盖 CANA/CANB 时，同一指令按总线分成两个独立用例（CANA 用例、CANB 用例）；不得将两条总线混在同一用例。"
      : "",
    args.testTypeChinese === "功能测试"
      ? `- ${PHASE6_NO_EXTRA_TEST_TYPE_RULE}`
      : "",
  ].join("\n")
}

// ---------------------------------------------------------------------------
// 工具 1：testcase_generator_run
// ---------------------------------------------------------------------------

/**
 * testcase_generator_run
 *
 * 实现 generateTestcaseFromDb 工作流中的第 1–2 步：
 *   Step 1 —— 接收条目化测试需求
 *   Step 2 —— 选择类型专属提示词模板并完成格式化
 *
 * 为每条需求返回可直接使用的生成提示词。
 * 调用该工具的 agent 会在 Step 3 中作为 LLM，按每条 prompt 继续生成。
 */
export const testcaseGeneratorRun: ToolDefinition = tool({
  description:
    "基于 auto-testcase-generator 的提示词模板准备测试用例生成提示词。 " +
    "当前主输入是 `.matrix/data/test-requirements.json` 顶层工件对象。 " +
    "工具会直接读取该文件中的 flat funItem[] 数组，每条 requirement 均自包含测试类型、接口上下文等必要字段——无需上层手工展平或内联整棵 JSON。 " +
    "针对每条需求，工具会选择对应的类型专属模板（功能测试、接口测试、边界测试、" +
    "性能测试、可靠性安全性测试、余量测试、强度测试、数据处理测试、恢复性测试、逻辑测试、时序测试），" +
    "并返回简洁的 requirement 级 prompt，以及稳定可嵌入 worker prompt 的 normalization_context_json。支持 software（默认）、FPGA 和 requirements 项目类型。 " +
    "调用该工具的 agent 会按每条 prompt 继续生成测试用例（agent 本身就是 LLM），" +
    "然后在使用 ct_suite 工具保存之前调用 testcase_format_check 完成校验。 " +
    "测试用例提示词模板优先从 `templates/testcase-prompts/` 子目录加载：项目 templates/、项目 .matrix/templates/、项目内 OpenCode templates/、插件内置模板，" +
    "最后才回退到 MATRIX_TESTCASE_GENERATOR_PATH 指向的历史 auto-testcase-generator 路径中的 legacy prompt_templates.json。",
  args: {
    test_requirements_file: tool.schema
      .string()
      .optional()
      .describe(
        "测试需求工件路径。默认使用当前项目的 `.matrix/data/test-requirements.json`。" +
        "该文件必须是顶层包含 funItem[] 数组的 flat 格式工件对象。",
      ),
    requirements: tool.schema
      .any()
      .optional()
      .describe(
        "已废弃的旧参数。Phase 6 现仅支持从 test-requirements.json 文件读取需求工件；如传入 requirements，工具会明确报错。",
      ),
    chapter_tr_list: tool.schema
      .any()
      .optional()
      .describe("已废弃的旧参数。Phase 6 现不再接受 chapter_tr_list 内联对象。"),
    project_type: tool.schema
      .enum(["software", "fpga", "requirements", "software_variant"])
      .optional()
      .describe(
        "用于控制模板族选择的项目类型。 " +
        "'software'（默认）及 'software_variant' 严格使用对应测试类型的 test-*.md 主模板；" +
        "'fpga' 使用 FPGA 专属模板或 FPGA-DG-STEP-NOT-GENERATED 模板；" +
        "'requirements' 使用 TR-XQ 模板（仅包含 tr_id + tr_handling）。",
      ),
  },

  async execute({ test_requirements_file, requirements, chapter_tr_list, project_type }, ctx) {
    const projectDir = getToolBaseDirectory(ctx)
    const pluginConfig = loadPluginConfig(projectDir)
    const warnings: string[] = []

    if (requirements !== undefined) {
      return JSON.stringify({
        error:
          "testcase_generator_run 现在只接受 test-requirements.json 文件输入。请改为传入 test_requirements_file，或直接使用默认 `.matrix/data/test-requirements.json`；requirements 平铺数组格式已废弃。",
        items: [],
      })
    }
    if (chapter_tr_list !== undefined) {
      return JSON.stringify({
        error:
          "testcase_generator_run 不再接受 chapter_tr_list 内联对象。请改为传入 test_requirements_file，或直接使用默认 `.matrix/data/test-requirements.json`。",
        items: [],
      })
    }
    const testRequirementsPath = resolveTestRequirementsFilePath(projectDir, test_requirements_file)

    let preparedInput: PreparedPhase6Input
    try {
      const artifact = loadTestRequirementFile(testRequirementsPath)
      preparedInput = preparePhase6Input(artifact, {
        project_meta: pluginConfig.project,
        workdir: projectDir,
      })
    } catch (error) {
      return JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        items: [],
      })
    }

    if (preparedInput.requirements.length === 0) {
      return JSON.stringify({ error: "test-requirements.json 中未找到任何 funItem。", items: [] })
    }

    // 生成和预审共用唯一解析入口。先验证全部需求的模板，再修改本轮产物，
    // 防止后续需求类型未知/模板损坏时留下半成品或清除上轮正式文档。
    const domain = pluginConfig.domain ?? "generic"
    const projectType = (project_type ?? "software") as Phase6ProjectType
    let resolvedRequirements: Array<{
      req: PreparedPhase6Requirement
      testTypeChinese: string
      template: ResolvedPhase6PromptTemplate
    }>
    try {
      const loadedTemplates = loadPhase6PromptTemplates({
        projectDir,
        importMetaDir: moduleDir(import.meta.url),
      })
      warnings.push(...loadedTemplates.warnings)
      resolvedRequirements = preparedInput.requirements.map((req) => {
        const testTypeChinese = resolveChineseTestType(req.test_type) ?? req.test_type
        try {
          return {
            req,
            testTypeChinese,
            template: resolvePhase6PromptTemplate({ loaded: loadedTemplates, testTypeChinese, projectType, domain }),
          }
        } catch (error) {
          throw new Error(`${req.requirement_id}：${error instanceof Error ? error.message : String(error)}`)
        }
      })
    } catch (error) {
      return JSON.stringify({
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        error_category: "template_resolution",
        items: [],
        warnings,
      })
    }

    const clearedPublishedOutputs = clearStalePhase6PublishedOutputs(projectDir)
    const keywordDirs = resolveKeywordSearchDirs(projectDir, pluginConfig.keyword_dirs)
    const keywordCatalog = scanKeywordDirs(keywordDirs)
    warnings.push(...keywordCatalog.warnings)
    // 关键字匹配限定 UserKeyWord 库（其他库为全项目固定内容,执行中跳过；
    // UserKeyWord 无条目时回退全库）
    const matchKeywordMap = filterUserKeywordMap(keywordCatalog.keywordMap)
    // Load project-specific generation guide (falls back to built-in satellite-dsp domain)
    const generationGuide = loadGenerationGuide(projectDir, domain)

    // 根据 project_type 参数确定 docx_type
    const docxType: DocxType = PROJECT_TYPE_TO_DOCX[project_type ?? "software"] ?? 2

    const items: Array<Phase6GenerationItem & {
      template_file: string | null
      template_source: ResolvedPhase6PromptTemplate["source"]
    }> = []
    for (const { req, testTypeChinese, template } of resolvedRequirements) {
      const functionalModel = resolveFunctionalModel({ name: req.name, requirementId: req.requirement_id, testType: req.test_type })
      const manualRequirement = isManualTestRequirement({ name: req.name, requirementId: req.requirement_id, testType: testTypeChinese })
      const crossContext = findCrossRequirementContext(req, preparedInput.requirements)
      const crossRequirementContextJson = crossContext ? JSON.stringify(crossContext, null, 2) : undefined
      const contextGaps = getStressProtocolContextGaps(req, crossContext)
      const trItem = toTrItem(req)
      const usedMarkdownTemplate = template.source === "markdown"
      const markdownTemplateFile = usedMarkdownTemplate ? template.file : undefined
      // 领域经验作为补充注入，不能替换按测试类型选择的 test-* 主模板。
      const templateBody = generationGuide
        ? injectGenerationGuideIntoPrompt(template.body, generationGuide, testTypeChinese)
        : template.body
      const requirementText = buildRequirementSearchText(req)

      const keywordCandidates = manualRequirement ? [] : scoreKeywordCandidatesWeighted(
        requirementText,
        matchKeywordMap,
        12,
        {
          keywordWeights: generationGuide?.keyword_priority,
          preferComposite: true,
          busContext: /CANA.*CANB|CANB.*CANA/.test(requirementText) ? "both"
            : /CANA/.test(requirementText) ? "cana"
            : /CANB/.test(requirementText) ? "canb" : null,
          timingSensitive: /第\d+秒|周期|轮询/.test(requirementText),
        },
      )
      const keywordCandidatePayloads = keywordCandidates.map(serializeKeywordCandidate)

      // B1a: 基于 flat 字段生成需求级步骤计划（关键字名与参数预绑定），
      // 随 normalization_context 下发供 worker 对齐参考；翻译阶段按相同输入重算。
      const stepPlanResult = !manualRequirement && keywordCatalog.keywordMap.size > 0
        ? buildRequirementStepPlan({
            handling: req.handling,
            inputFlow: req.inputFlow ?? "",
            outputFlow: req.outputFlow ?? "",
            chapterContent: req.requirementContext ?? req.chapter_background ?? "",
            keywordMap: matchKeywordMap,
          })
        : null
      const stepPlanPayload = stepPlanResult
        ? stepPlanResult.step_plan.map((sp) => ({
            step_index: sp.step_index,
            purpose: sp.purpose,
            description: sp.description,
            keyword_name: sp.keyword_name,
            bus_channel: sp.bus_channel,
            argument_bindings: sp.argument_bindings,
            resolved_step_desc: sp.resolved_step_desc,
            suggested_operation_type: purposeToOperationType(sp.purpose),
            suggested_channel: sp.bus_channel || undefined,
            suggested_temporal: extractTemporalFromDesc(sp.resolved_step_desc),
          }))
        : null

      const normalizationContext = {
        requirement_id: req.requirement_id,
        test_type_chinese: testTypeChinese,
        chapter_title: req.chapter_title ?? req.title,
        requirement_name: req.name,
        // 上下文字段统一使用 flat 格式的五字段命名（I-05）
        requirementContext: req.requirementContext,
        inputFlowContext: req.inputFlow,
        processingContext: req.handling,
        outputFlowContext: req.outputFlow,
        constraintContext: req.constraintContext,
        protocolContext: crossRequirementContextJson,
        generation_status: contextGaps.length ? "context_required" : "ready",
        context_gaps: contextGaps,
        step_plan: stepPlanPayload,
      }

      let prompt: string
      if (usedMarkdownTemplate) {
        // Markdown template: format with test-*.md placeholders, no suffix
        // 键名与 flat 五字段输入 JSON 一致；旧命名占位符经 fallback 链同样可解析
        prompt = formatMarkdownPromptTemplate(templateBody, {
          tr_id: req.requirement_id,
          requirement_id: req.requirement_id,
          title: req.name,
          requirementContext: req.requirementContext ?? req.chapter_background ?? "",
          inputFlowContext: req.inputFlow ?? "",
          processingContext: req.handling,
          outputFlowContext: req.outputFlow ?? "",
          constraintContext: req.constraintContext ?? "",
        })
      } else {
        // Legacy template: formatTemplate + buildGenerationPromptSuffix
        prompt = [
          formatTemplate(templateBody, trItem, docxType),
          buildGenerationPromptSuffix({
            requirementId: req.requirement_id,
            testTypeChinese,
            chapterBackground: req.chapter_background ?? "",
            chapterTitle: req.chapter_title ?? "",
            inputFlow: req.inputFlow ?? "",
            outputFlow: req.outputFlow ?? "",
          }),
        ].join("\n")
      }

      const domainKnowledge = buildPhase6DomainKnowledge(domain, testTypeChinese, requirementText)
      if (domainKnowledge) prompt += `\n\n${domainKnowledge}`

      // Append coverage checklist for interface tests
      prompt += buildCoverageChecklist(req.inputFlow ?? "", testTypeChinese, req.handling)
      // 中断上下文块:markdown/legacy 两路共用,可选
      prompt += buildInterruptContextBlock(req.interruptContext)
      // 引用条款错误分支送达(可选,无命中则为空串)
      prompt += buildReferencedErrorClausesBlock(req, preparedInput.requirements)
      // 功能测试的一级 CAN 接收协议结构(轮询逐字段、两帧时间广播、
      // 双辅助数据包有序发送)按需求语义确定性注入,不依赖所选模板族。
      prompt += buildFunctionalCanReceiveProtocolRules(req)

      // Append structured TR item list for functional tests with multiple TR items
      const trItems = extractTrItems(req.handling)
      if (testTypeChinese === "功能测试" && trItems.length > 1) {
        prompt += buildTrItemCoverageList(trItems)
      }

      const normalizationContextJson = JSON.stringify(normalizationContext, null, 2)
      const guideText = generationGuide
        ? [
          "### 项目特有生成指南",
          `- 步骤组成规则：${generationGuide.step_composition_rules.join("；")}`,
          `- 预期结果规则：${generationGuide.expected_result_composition_rules.join("；")}`,
          `- 初始设置规则：${generationGuide.initial_settings_rules.join("；")}`,
          `- 关键字选择规则：${generationGuide.keyword_selection_rules.join("；")}`,
          `- 协议字段映射规则：${generationGuide.protocol_field_mapping_rules.join("；")}`,
          generationGuide.type_specific_guidance[testTypeChinese]
            ? `- 当前类型专属指导：${generationGuide.type_specific_guidance[testTypeChinese]}`
            : "",
        ].filter(Boolean).join("\n")
        : undefined
      // Look up upstream data flows from other requirements as preconditions
      // 接口类型专属规则分节按需注入:模板只含通用章节与 {{INTERFACE_SECTIONS}}
      // 标记,按需求上下文检测涉及的接口类型,只拼接相关分节(不相关接口的
      // 经验与约束不进入生成上下文)。在占位符替换之后注入,分节内容不受
      // {xxx} 占位符替换影响;注入结果记入 manifest item 便于诊断。
      let interfaceSections: string[] = []
      if (markdownTemplateFile) {
        const injectedResult = injectInterfaceSections(prompt, {
          corpus: [
            req.name,
            req.requirementContext,
            req.inputFlow,
            req.handling,
            req.outputFlow,
            req.constraintContext,
            // 共享中断表不是当前需求的接口证据；只补充已关联的数据流上下文。
            ...(req.test_type === "functional" ? [] : [crossContext ? JSON.stringify(crossContext) : ""]),
          ].filter(Boolean).join("\n"),
          catalogDir: dirname(markdownTemplateFile),
          ...(manualRequirement ? { sectionTypes: [] } : req.test_type === "functional" ? {
            sectionTypes: functionalInterfaceSections(functionalModel)
              ?? (/(?:接收处理|上行数据块处理)/.test(req.name) ? ["primary-can"] : undefined),
          } : !/(?:CAN|SPI|SpaceWire|总线|多包|辅助数据包|249字节上行|FPGA状态遥测|看门狗|硬件狗|秒脉冲|成像控制)/i.test(
            [req.name, req.requirementContext, req.inputFlow, req.handling, req.outputFlow, crossRequirementContextJson].filter(Boolean).join("\n"),
          ) ? { sectionTypes: [] } : {}),
        })
        prompt = injectedResult.prompt
        interfaceSections = injectedResult.injected_sections
        warnings.push(...injectedResult.warnings)
      }

      prompt += functionalModelRules(functionalModel)
      prompt += testTypeGenerationRules(testTypeChinese)
      if (contextGaps.length) {
        prompt += `\n\n<generation_context_gaps>\nCONTEXT_REQUIRED：当前需求缺少生成依据，禁止猜测或简化覆盖；补充以下资料并重新准备生成上下文后再执行：\n${contextGaps.map((gap) => `- ${gap}`).join("\n")}\n</generation_context_gaps>`
      }

      const workerPrompt = buildSingleRequirementWorkerPrompt({
        requirementId: req.requirement_id,
        generationPrompt: prompt,
        normalizationContextJson,
        generationGuide: guideText,
        crossRequirementContextJson,
      })
      const workerPromptFile = persistSingleRequirementWorkerPrompt(
        projectDir,
        req.requirement_id,
        workerPrompt,
      )

      items.push({
        requirement_id: req.requirement_id,
        generation_status: contextGaps.length ? "context_required" : "ready",
        context_gaps: contextGaps,
        category_key: req.category_key,
        requirement_type: req.test_type,
        requirement_priority: req.priority,
        test_type_chinese: testTypeChinese,
        source_requirement_ids: req.source_requirement_ids,
        template_key: template.key,
        template_file: template.file ?? null,
        template_source: template.source,
        template_hash: template.hash ?? createHash("sha256").update(template.body).digest("hex"),
        template_index_file: template.index_file ?? null,
        template_domain: domain,
        template_selection_reason: template.selection_reason ?? `${projectType}:${testTypeChinese}:${template.source}`,
        project_type: project_type ?? "software",
        tr_item: trItem,
        prompt,
        interface_sections: interfaceSections,
        functional_model: functionalModel,
        normalization_context_json: normalizationContextJson,
        worker_prompt_file: workerPromptFile,
        keyword_candidates: keywordCandidatePayloads,
        requirementContext: req.requirementContext ?? undefined,
        interruptContext: req.interruptContext,
        chapter_title: req.chapter_title ?? undefined,
        ...(req.path ? { path: req.path } : {}),
      })
    }

    const result = {
      status: "success",
      template_provenance_version: 1,
      domain,
      template_source: [...new Set(items.map((item) => item.template_source))].join(","),
      template_usage: [...new Set(items.map((item) => item.template_file))].map((file) => ({
        template_file: file,
        requirement_count: items.filter((item) => item.template_file === file).length,
      })),
      input_format: "test_requirements_file",
      test_requirements_file: testRequirementsPath,
      artifact_meta: preparedInput.artifact_meta,
      suite_meta: preparedInput.suite_meta,
      project_type: project_type ?? "software",
      total: items.length,
      items,
      warnings: warnings.length > 0 ? warnings : undefined,
    }

    const finalWarnings = [
      ...(result.warnings ?? []),
      // 元数据回退告警(2026-09-08 P5 取证:配置缺 csci_name 且目录名平凡时,
      // project_name="workdir"/version="未标注" 直通最终 DOCX 无任何提示)
      ...(preparedInput.suite_meta.project_name === basename(projectDir)
        && !/[一-龥A-Za-z]{2,}/.test(preparedInput.suite_meta.project_name.replace(basename(projectDir), ""))
        ? [`suite 元数据回退：project_name 未配置(matrix.jsonc::project.csci_name 缺失)，已回退为工作目录名 "${preparedInput.suite_meta.project_name}"——该值将进入最终报告，请在 matrix.jsonc 配置 project.csci_name/version 后重跑`]
        : []),
      ...clearedPublishedOutputs.map((filePath) =>
        `已清理旧的 Phase 6 正式文档，等待本轮 review 通过后重新发布：${filePath}`,
      ),
    ]
    const generationManifestFile = persistPhase6GenerationManifest(projectDir, {
      ...result,
      warnings: finalWarnings.length > 0 ? finalWarnings : undefined,
    })
    return JSON.stringify({
      status: result.status,
      template_provenance_version: result.template_provenance_version,
      domain: result.domain,
      template_source: result.template_source,
      template_usage: result.template_usage,
      input_format: result.input_format,
      test_requirements_file: result.test_requirements_file,
      artifact_meta: result.artifact_meta,
      suite_meta: result.suite_meta,
      project_type: result.project_type,
      total: result.total,
      ready_count: items.filter((item) => item.generation_status === "ready").length,
      context_required_requirements: items.filter((item) => item.generation_status === "context_required")
        .map((item) => ({ requirement_id: item.requirement_id, context_gaps: item.context_gaps })),
      generation_manifest_file: generationManifestFile,
      query: {
        artifact: "phase6_generation_manifest",
        summary_view: "summary",
        paths_view: "paths",
        list_view: "list_items",
        item_view: "get_item",
      },
      warnings: finalWarnings.length > 0 ? finalWarnings : undefined,
    })
  },
})

/**
 * 中断上下文块(SpaceWire 等中断触发类接口,2026-09-02 用户裁定):可选,
 * interruptContext 非空才追加——markdown 与 legacy 两条模板路径共用,
 * 触发中断步骤的中断号/向量以该上下文原文为准,禁止编造。
 */
function buildInterruptContextBlock(interruptContext: string | undefined): string {
  const value = (interruptContext ?? "").replace(/\s*\n+\s*/g, " ").replace(/\s+/g, " ").trim()
  if (!value) return ""
  return [
    "",
    "### 中断上下文",
    "- 触发中断类接口步骤的中断号/向量等以下列上下文原文为准（逐字取值，禁止编造）：",
    `- ${value}`,
  ].join("\n")
}

// ---------------------------------------------------------------------------
// 工具 2：testcase_format_check
// ---------------------------------------------------------------------------

/**
 * testcase_format_check
 *
 * 实现 generateTestcaseFromDb 工作流中的 Step 4：
 *   校验 LLM 生成的测试用例 JSON 格式。
 *
 * 对应 model_helper.py 中的校验链路：
 *   extract_json_from_markdown → json.loads → _validate_and_create_testcase_objects
 *   → _standardize_testcase_data
 *
 * 成功时  → 返回 {valid: true, cases: [...normalized...], warnings: [...]}
 * 失败时  → 返回 {valid: false, errors: [...具体错误信息...], warnings: [...]}
 *           errors 数组会明确告诉 agent 下一次应修复什么问题。
 *
 * 自动修复项（静默应用，并记录到 warnings）：
 *   - test_case_name > 20 字：自动截断
 *   - test_purpose / 步骤描述 / 预期结果 未以 。 结尾：自动补句号
 *
 * 硬错误（会导致 valid: false）：
 *   - JSON 无法解析
 *   - 根节点无法规范化为非空数组
 *   - 任意测试用例缺少 test_case_name、test_purpose 或 test_step
 *   - 任意步骤缺少 步骤描述 或 预期结果
 */
export const testcaseFormatCheck: ToolDefinition = tool({
  description:
    "将 LLM 生成的测试用例 JSON 校验并规范化为数据库格式（工作流 Step 4）。" +
    "支持带字段别名的 LLM 输出（case_name/test_case_name/testCaseName、" +
    "步骤描述/step_desc/source_step_desc/action/description、预期结果/expected_result，以及数组或 JSON 字符串形式的 test_step）。" +
    "成功时返回 {valid:true, cases:[{case_name, test_purpose, test_step（JSON 数组）, " +
    "test_environment, initial_settings, test_input, constraints, assess_criteria, cease_condition}]}. " +
    "工具会基于当前项目的真实关键字目录完成关键字 Documentation 模板匹配与占位符替换；keyword_candidates 若提供，仅作为可选提示。 " +
    "若同时提供需求背景（test-requirements.json 中的处理说明/输入流/输出流/章节背景）与 placeholder_suggestions，工具会在标准化后按关键字 Documentation 模板替换占位符；无法解析的参数占位符会原样保留并作为 warning 返回。 " +
    "五字段上下文未显式提供时，工具会按 requirement_id 从 .matrix/data/phase6-generation-items.json 自动回填与生成阶段一致的标准化上下文（回填时返回 warning）。 " +
    "性能测试固定硬平台测试环境，余量测试固定人工分析；两类保留人工步骤，标记 not_applicable，不进行关键字翻译。其他环境按模式与专属规则填写。 " +
    "强度测试一条需求只能生成一个综合用例，时间线连续，不按指令/总线或步数拆例。 " +
    "失败时返回 {valid:false, errors:[...]}，其中包含 agent 需要修复的具体字段/步骤错误。",
  args: {
    generated_text: tool.schema
      .string()
      .optional()
      .describe(
        "LLM 的原始输出文本，可能包含被 ```json``` 代码块包裹的 JSON 数组。 " +
        "请不做修改地传入完整生成结果。worker 以 FILE: 落盘的大 JSON 必须改用 generated_text_file，" +
        "禁止 Read 后经此参数回显全文（超大内容会被截断导致用例丢失）。",
      ),
    generated_text_file: tool.schema
      .string()
      .optional()
      .describe(
        "生成结果文件路径（worker 回包 FILE: 声明的 .matrix/data/{requirement_id}_output.json），" +
        "与 generated_text 二选一。工具直接读文件解析，大 JSON 必须走此参数；" +
        "相对路径按项目目录解析。",
      ),
    persist: tool.schema
      .boolean()
      .optional()
      .describe(
        "true=标准化与关键字翻译通过后，由工具侧把全部用例直接写入 confirmation-tests.json" +
        "（需先调用 ct_suite_create）：correspond_fun_id=需求项整组 funId、covered_tr_items 自动透传、" +
        "path/test_type 从 test-requirements.json 权威解析；返回精简摘要，不回传 combined_translations。" +
        "大输出（FILE: 落盘）强烈建议 generated_text_file + persist=true 组合使用。",
      ),
    auto_repair_structural_violations: tool.schema
      .boolean()
      .optional()
      .describe(
        "结构确定性修复通道：检测到结构违规（跨 TR 拆分：同一指令的不同情况被拆散在覆盖不同 TR 子集的多个用例中；" +
        "用例内多指令：一个用例混入多条不同指令；双总线混用：同一指令同时经 CANA 与 CANB 发送在同一用例" +
        "（切换/交替/冗余类行为测试除外）；错误步骤未配对：字段/字节错误发送步骤后未紧跟同指令同总线的" +
        "'全部正确'步骤）时，persist 会被拒绝并返回违规明细与 regroup_directive（目标用例划分表）；" +
        "主智能体应把划分表原文嵌入重派 prompt 重新生成一次。重派后仍违规才把本参数置 true——工具将按" +
        "'指令×总线'确定性重组用例（跨用例合并/多指令拆分/双总线分开）并自动补'全部正确'配对步骤后落库，" +
        "修复动作记入 warnings 如实上报，禁止首轮生成直接置 true 跳过检查。",
      ),
    test_environment_mode: tool.schema
      .enum(TEST_ENVIRONMENT_MODE_VALUES)
      .optional()
      .describe(
        "系统填写 test_environment 时使用的模式。software=软平台测试环境（默认），" +
        "evaluation=硬平台测试环境。预留给后续按软件/鉴定类型切换。",
      ),
    input_dataset_ref: tool.schema
      .string()
      .optional()
      .describe("输入数据引用，格式 .matrix/data/input-datasets/<protocol>.json#dataset_id"),
    input_dataset_file: tool.schema
      .string()
      .optional()
      .describe("输入数据文件路径；保留给执行阶段引用，不参与 Phase 6 占位符替换"),
    input_dataset_id: tool.schema
      .string()
      .optional()
      .describe(`输入数据集 ID；缺省为 ${DEFAULT_INPUT_DATASET_ID}`),
    requirement_id: tool.schema
      .string()
      .optional()
      .describe("当前 requirement 的 ID；用于功能测试单需求校验、上下文跟踪，以及未显式提供五字段上下文时按 manifest 自动回填标准化上下文"),
    processingContext: tool.schema
      .string()
      .optional()
      .describe("当前 requirement 的 processingContext 文本；用于协议语义匹配与占位符替换"),
    test_type_chinese: tool.schema
      .string()
      .optional()
      .describe("当前 requirement 的中文测试类型，例如 功能测试；用于类型专属校验"),
    requirementContext: tool.schema
      .string()
      .optional()
      .describe("当前 requirement 的 requirementContext（章节背景知识）"),
    chapter_title: tool.schema
      .string()
      .optional()
      .describe("当前 requirement 所在章节标题"),
    inputFlowContext: tool.schema
      .string()
      .optional()
      .describe("当前 requirement 的 inputFlowContext；用于定位协议语义"),
    outputFlowContext: tool.schema
      .string()
      .optional()
      .describe("当前 requirement 的 outputFlowContext；用于辅助语义判断"),
    constraintContext: tool.schema
      .string()
      .optional()
      .describe("当前 requirement 的 constraintContext；用于辅助测试约束判断"),
    keyword_candidates: tool.schema
      .array(
        tool.schema.object({
          keywordName: tool.schema.string(),
          description: tool.schema.string(),
          argumentNames: tool.schema.array(tool.schema.string()),
          argumentComments: tool.schema.array(tool.schema.string()),
          txtSnippet: tool.schema.string(),
        }),
      )
      .optional()
      .describe("本条需求的关键字候选提示列表；工具仍会优先基于真实关键字目录重新检索并确定最终 Documentation 模板"),
    placeholder_suggestions: tool.schema
      .array(
        tool.schema.object({
          case_index: tool.schema.number().optional(),
          step_index: tool.schema.number(),
          placeholder: tool.schema.string(),
          value: tool.schema.string(),
          reason: tool.schema.string().optional(),
        }),
      )
      .optional()
      .describe("worker 对无法直接从需求和协议中推导的占位符建议值，例如 ${time}=10.8"),
  },

  async execute({
    generated_text,
    generated_text_file,
    persist,
    auto_repair_structural_violations,
    test_environment_mode,
    input_dataset_ref,
    input_dataset_file,
    input_dataset_id,
    requirement_id,
    processingContext,
    test_type_chinese,
    requirementContext,
    chapter_title,
    inputFlowContext,
    outputFlowContext,
    constraintContext,
    keyword_candidates,
    placeholder_suggestions,
  }, ctx) {
    const testEnvironmentMode = test_environment_mode ?? "software"
    const projectDir = getToolBaseDirectory(ctx)
    const pluginConfig = loadPluginConfig(projectDir)
    const keywordDirs = resolveKeywordSearchDirs(projectDir, pluginConfig.keyword_dirs)
    const keywordCatalog = scanKeywordDirs(keywordDirs)
    // 关键字匹配限定 UserKeyWord 库（其他库为全项目固定内容,执行中跳过；
    // UserKeyWord 无条目时回退全库）
    const matchKeywordMap = filterUserKeywordMap(keywordCatalog.keywordMap)

    // generated_text / generated_text_file 二选一：大 JSON 走文件入口,
    // 避免主智能体经参数回显超大内容被截断(曾导致 12 用例只保存 1 个)。
    if (generated_text_file !== undefined && generated_text !== undefined) {
      return JSON.stringify({ error: "generated_text 与 generated_text_file 只能二选一。" })
    }
    let generatedContent: string
    if (generated_text_file !== undefined) {
      const resolvedFile = isAbsolute(generated_text_file) || isWindowsAbsolutePath(generated_text_file)
        ? generated_text_file
        : join(projectDir, generated_text_file)
      if (!existsSync(resolvedFile)) {
        return JSON.stringify({ error: `generated_text_file 不存在: ${generated_text_file}（解析为 ${resolvedFile}）。` })
      }
      try {
        generatedContent = readFileSync(resolvedFile, "utf-8")
      } catch (error) {
        return JSON.stringify({ error: `generated_text_file 读取失败: ${error instanceof Error ? error.message : String(error)}` })
      }
    } else if (generated_text !== undefined) {
      generatedContent = generated_text
    } else {
      return JSON.stringify({ error: "必须提供 generated_text 或 generated_text_file 之一。" })
    }

    // B1b: 主智能体未显式传五字段上下文时，按 requirement_id 从 manifest 回填，
    // 保证标准化与步骤计划重算使用与生成阶段一致的上下文。
    const manifestContext = requirement_id
      ? loadNormalizationContextFromManifest(projectDir, requirement_id) ?? {}
      : {}
    const contextFallbackUsed = Object.keys(manifestContext).length > 0
    const effectiveProcessingContext = processingContext ?? textOfContext(manifestContext.processingContext)
    const rawTestType = test_type_chinese ?? textOfContext(manifestContext.test_type_chinese)
    const effectiveTestTypeChinese = normalizePhase6TestType(rawTestType) ?? rawTestType
    const effectiveRequirementContext = requirementContext ?? textOfContext(manifestContext.requirementContext)
    const effectiveChapterTitle = chapter_title ?? textOfContext(manifestContext.chapter_title)
    const effectiveInputFlowContext = inputFlowContext ?? textOfContext(manifestContext.inputFlowContext)
    const effectiveOutputFlowContext = outputFlowContext ?? textOfContext(manifestContext.outputFlowContext)
    const effectiveConstraintContext = constraintContext ?? textOfContext(manifestContext.constraintContext)
    const protocolContext = textOfContext(manifestContext.protocolContext)
    const contextGaps = Array.isArray(manifestContext.context_gaps)
      ? manifestContext.context_gaps.filter((gap): gap is string => typeof gap === "string" && gap.trim().length > 0)
      : []
    if (contextGaps.length) {
      return JSON.stringify({
        valid: false,
        persisted: false,
        failure_kind: "context_required",
        retry_allowed: false,
        source_output_status: generated_text_file !== undefined
          ? (generatedContent.trim() ? "landed_nonempty" : "landed_empty") : "inline",
        requirement_id,
        context_gaps: contextGaps,
        errors: contextGaps.map((message) => ({ case_index: -1, field: "requirement_context", message: `CONTEXT_REQUIRED：${message}` })),
        next_action: "补充当前项目协议依据，重新执行 testcase_generate 更新上下文后再生成；不得重派猜测或改作单包绕过。",
      })
    }
    // 看门狗语料门控标记(persist/非 persist 两条路径共用)
    const watchdogRequirement = !manualTestEnvironment(effectiveTestTypeChinese) && !isIntegratedStressTest(effectiveTestTypeChinese) && /硬件狗|看门狗|喂狗/.test(
      [effectiveRequirementContext, effectiveInputFlowContext, textOfContext(manifestContext.processingContext)].filter(Boolean).join(" "),
    )
    const functionalProtocolCorpus = [
      effectiveRequirementContext,
      effectiveInputFlowContext,
      effectiveProcessingContext,
      effectiveOutputFlowContext,
      protocolContext,
    ].filter(Boolean).join("\n")
    const functionalTwoAuxiliaryPackets = effectiveTestTypeChinese === "功能测试"
      && /辅助数据/.test(functionalProtocolCorpus)
      && /(?:每秒[^。；\n]{0,20}(?:2|两)包|(?:2|两)个数据包|辅助数据包\s*(?:1|一)[\s\S]{0,2000}辅助数据包\s*(?:2|二)|第\s*1\s*包[\s\S]{0,2000}第\s*2\s*包)/.test(functionalProtocolCorpus)
    const functionalRequirementName = [effectiveChapterTitle, textOfContext(manifestContext.requirement_name)]
      .filter(Boolean).join("\n")
    const functionalModel = resolveFunctionalModel({
      name: textOfContext(manifestContext.requirement_name) ?? effectiveChapterTitle,
      requirementId: requirement_id,
      testType: effectiveTestTypeChinese,
    })
    const manualRequirement = isManualTestRequirement({
      name: textOfContext(manifestContext.requirement_name) ?? effectiveChapterTitle,
      requirementId: requirement_id,
      testType: effectiveTestTypeChinese,
    })
    const autonomousTelemetry = isAutonomousTelemetry(functionalModel, functionalProtocolCorpus)
    const functionalMemoryReadTarget = effectiveTestTypeChinese === "功能测试"
      && /内存读出指令接收处理/.test(functionalRequirementName)
    const functionalMemoryReadRanges = functionalMemoryReadTarget
      ? extractMemoryAddressRanges(functionalProtocolCorpus)
      : []
    const functionalMemoryPollingPrerequisite = effectiveTestTypeChinese === "功能测试"
      && /内存数据轮询(?:指令|控制序列)?接收处理/.test(functionalRequirementName)
      && /内存读出指令/.test(functionalProtocolCorpus)
    const requiredPrimaryBuses = requiredPrimaryBusesFromRequirementContext({
      requirementId: requirement_id ?? textOfContext(manifestContext.requirement_id),
      requirementHandling: effectiveProcessingContext,
      chapterBackground: effectiveRequirementContext,
      chapterTitle: effectiveChapterTitle,
      inputFlow: effectiveInputFlowContext,
      outputFlow: effectiveOutputFlowContext,
      testTypeChinese: effectiveTestTypeChinese,
    })

    // F2.1 截断/格式错误精确诊断(2026-08-20 卡死事故:文件写一半无人知,
    // 智能体只能笼统报"校验失败")——先于标准化做一次快速判别
    try {
      JSON.parse(extractJsonFromMarkdown(generatedContent))
    } catch {
      const classified = classifyJsonParseError(generatedContent)
      return JSON.stringify({
        valid: false,
        error_kind: classified.kind,
        error: classified.kind === "truncated"
          ? `worker 输出内容不完整(末尾不是合法 JSON 闭合,疑似生成/写入中途断流): ${classified.detail}`
          : `生成内容 JSON 格式错误: ${classified.detail}`,
        head: generatedContent.trim().slice(0, 80),
        hint: classified.kind === "truncated"
          ? "不要人工修补。重派该 requirement 的 worker 重新生成并落盘(先可用 phase6_worker_output_append 只传 requirement_id 查询落盘状态),成功后重新调用本工具。"
          : "重派该 requirement 的 worker,要求按分段小步落盘后重试本工具。",
      })
    }

    let result = standardizeGeneratedTestcases(generatedContent, {
      projectDir,
      testEnvironmentMode,
      input_dataset_ref,
      input_dataset_file,
      input_dataset_id,
      requirement_id,
      processingContext: effectiveProcessingContext,
      test_type_chinese: effectiveTestTypeChinese,
      requirementContext: effectiveRequirementContext,
      chapter_title: effectiveChapterTitle,
      inputFlowContext: effectiveInputFlowContext,
      outputFlowContext: effectiveOutputFlowContext,
      constraintContext: effectiveConstraintContext,
      protocolContext,
      keyword_candidates,
      keyword_map: matchKeywordMap,
      placeholder_suggestions,
    })

    const sourceStatus = generated_text_file !== undefined ? (generatedContent.trim() ? "landed_nonempty" : "landed_empty") : "inline"

    // Inline keyword translation: map natural-language steps to Combined format
    // B1a: 用与生成阶段相同的输入重算需求级步骤计划作为翻译提示
    // （步骤计划是纯函数产物，重算与读 manifest 等价且更稳健）。
    let translationResults: Array<ReturnType<typeof translateStandardizedCaseToCombined>> | undefined
    // 提升到修复分支可见:修复后的用例要用同一提示重翻译(2026-08-26 晚取证)
    let stepPlanHints: ReturnType<typeof stepPlanToHints> = []
    if (result.valid && result.cases && result.cases.length > 0 && (manualRequirement || keywordCatalog.keywordMap.size > 0)) {
      stepPlanHints = manualRequirement ? [] : stepPlanToHints(
        buildRequirementStepPlan({
          handling: effectiveProcessingContext ?? "",
          inputFlow: effectiveInputFlowContext ?? "",
          outputFlow: effectiveOutputFlowContext ?? "",
          chapterContent: effectiveRequirementContext ?? "",
          keywordMap: matchKeywordMap,
        }).step_plan,
      )
      // 需求级上下文语料:未绑定参数兜底从上下文取值(2026-09-10 取证:
      // 触发外部中断 的电平参数取中断上下文表"触发方式"列——步骤文本不带电平注记)
      const requirementContextCorpus = [
        effectiveRequirementContext,
        effectiveInputFlowContext,
        protocolContext,
        textOfContext(manifestContext?.interruptContext),
      ].filter(Boolean).join("\n")
      translationResults = result.cases.map((stdCase) =>
        translateStandardizedCaseToCombined(stdCase, matchKeywordMap, stepPlanHints, testEnvironmentMode, requirementContextCorpus, manualRequirement)
      )
    }

    if (result.valid && effectiveTestTypeChinese === "恢复性测试" && translationResults) {
      const timingIssues = validateTestTypeCases(effectiveTestTypeChinese, translationResults.map((translation) => ({
        test_step: translation.steps.map((step) => ({
          ...step, 步骤描述: step.source_step_desc, 预期结果: step.expected_result,
        })),
      })), functionalProtocolCorpus)
      if (timingIssues.length) {
        result = { valid: false, errors: timingIssues, warnings: result.warnings }
        translationResults = undefined
      }
    }

    // Content/translation failure is not a file-write failure. Freeze the
    // original task and pinpoint the failed steps instead of redesigning it.
    const repairDirective = !result.valid ? buildPhase6ValidationRepairDirective({
      requirementId: requirement_id ?? textOfContext(manifestContext.requirement_id) ?? "未指定",
      testType: effectiveTestTypeChinese,
      errors: result.errors,
    }) : undefined
    let repairWorkerPromptFile: string | undefined
    if (persist && repairDirective && requirement_id) {
      const safeRequirementId = requirement_id.replace(/[^\w.-]+/g, "_")
      const originalFile = join(projectDir, ARTIFACT_PATHS.PHASE6_WORKER_PROMPTS_DIR, `${safeRequirementId}.txt`)
      if (existsSync(originalFile)) {
        repairWorkerPromptFile = persistSingleRequirementWorkerPrompt(projectDir, `${requirement_id}.repair`, buildPhase6FileRepairPrompt({
          originalWorkerPrompt: readFileSync(originalFile, "utf-8"),
          repairDirective,
          previousOutput: generatedContent,
        }))
      }
    }

    // persist=true：工具侧直接保存,返回精简摘要(不回传大 combined_translations,
    // 避免 OpenCode 工具输出截断导致主智能体拿不到完整翻译步骤)。
    if (persist) {
      if (!result.valid || !result.cases || result.cases.length === 0) {
        return JSON.stringify({
          valid: false,
          persisted: false,
          failure_kind: "content_validation_failed",
          source_output_status: sourceStatus,
          repair_directive: repairDirective,
          repair_worker_prompt_file: repairWorkerPromptFile,
          errors: result.valid ? [] : (result.errors ?? []),
          warnings: ["persist 未执行：标准化校验未通过，请先按 errors 修复。"],
        })
      }
      const effectiveRequirementId = requirement_id
        ?? textOfContext(manifestContext.requirement_id)
        ?? ""
      if (!effectiveRequirementId) {
        return JSON.stringify({
          error: "persist 失败：未能确定 requirement_id（参数未传且 manifest 未命中），请显式传入 requirement_id。",
        })
      }
      // 聚合度+结构确定性检测:跨 TR 拆分/用例内多指令/双总线混用/错误
      // 步骤未配对。worker 对逐条 TR 枚举形态的处理是概率性的(2026-08-20
      // 取证),此处用代码兜底:违规拒绝落库并反馈"目标用例划分表"重派;
      // 重派一次仍违规(auto_repair_structural_violations=true)则按
      // 指令×总线确定性重组 + 自动补配对步骤后落库(2026-08-21 用户拍板,
      // 取代原"接受违规落库"通道)。
      let aggregation = analyzeCaseAggregation(
        result.cases.map((c) => ({
          case_name: c.case_name,
          covered_tr_items: c.covered_tr_items,
          test_step: c.test_step,
        })),
        expandFunIdString(effectiveRequirementId),
      )
      // Manual measurements are not command×bus cases; retain only TR coverage checks.
      if (manualRequirement) aggregation.violations = []
      // 长度变体指令基名:数据流定义中同名指令有 10字节/15字节 等多种长度时,
      // 载荷必须带长度限定词(2026-08-27 用户裁定)
      const lengthVariantBases = extractLengthVariantBases(effectiveInputFlowContext ?? "")
      const structure: CaseStructureAnalysis = manualRequirement || isIntegratedStressTest(effectiveTestTypeChinese)
        ? { violations: [] } : analyzeCaseStructure(
        result.cases.map((c) => ({
          case_name: c.case_name,
          test_purpose: c.test_purpose,
          test_step: c.test_step,
        })),
        {
          lengthVariantBases,
          functionalTwoAuxiliaryPackets,
          functionalMemoryReadRanges,
          functionalMemoryPollingPrerequisite,
          requiredPrimaryBuses,
          functionalModel,
          requirementCorpus: functionalProtocolCorpus,
          autonomousTelemetry,
        },
      )
      // 看门狗固定句式门禁(2026-09-08 二次取证:worker 两轮无视模板,自行
      // "软平台自适应改写"成内存写喂狗步骤/推迟鉴定测评形态)——语料门控:
      // 需求上下文属硬件狗时,用例必须逐字符合固定三段句式,违规拒绝落库
      if (watchdogRequirement) {
        for (const caseRecord of result.cases) {
          const steps = caseRecord.test_step ?? []
          const firstDesc = String((steps[0] as Record<string, unknown> | undefined)?.["步骤描述"] ?? "")
          const firstExpected = String((steps[0] as Record<string, unknown> | undefined)?.["预期结果"] ?? "")
          const shapeOk = steps.length === 1
            && /使用示波器多次测试清看门狗时间间隔/.test(firstDesc)
            && /软件清看门狗时间间隔最大不超过.+s/.test(firstExpected)
          if (!shapeOk) {
            structure.violations.push({
              type: "watchdog_shape_violation",
              case_name: String(caseRecord.case_name ?? "未命名用例"),
              message:
                `用例"${String(caseRecord.case_name ?? "未命名用例")}"不符合硬件狗固定句式(2026-09-08 用户拍板):` +
                `测试目的=测试软件清看门狗时间间隔(即<端口号>相邻两次写操作的时间间隔)的情况;考虑了插入中断的最坏情况;` +
                `步骤=使用示波器多次测试清看门狗时间间隔(即<端口号>相邻两次写操作的时间间隔);` +
                `预期=软件清看门狗时间间隔最大不超过<清看门狗最大时间>s(保留字面文本,禁止填狗咬时间);` +
                `单用例单步骤;当前用例是自由发挥形态(内存写喂狗步骤/多步骤/推迟鉴定测评等)`,
            })
          }
        }
      }
      // 聚合/拆分矛盾消解(2026-09-08 P3):mixed_upload_type 拆分用例比按短语聚合
      // 聚合更具体——涉及用例的聚合违规让位,不再同时下达相反指令
      aggregation = suppressContradictoryAggregation(aggregation, structure)
      const hasViolations = aggregation.violations.length > 0 || structure.violations.length > 0
      const hasCoverageGaps = aggregation.coverage_gaps.length > 0
      if ((hasViolations || hasCoverageGaps)
        && (!auto_repair_structural_violations || manualRequirement || isIntegratedStressTest(effectiveTestTypeChinese))) {
        return JSON.stringify({
          valid: true,
          persisted: false,
          ...(aggregation.violations.length > 0 ? { aggregation_violations: aggregation.violations } : {}),
          ...(structure.violations.length > 0 ? { structure_violations: structure.violations } : {}),
          ...(hasCoverageGaps ? { tr_coverage_gaps: aggregation.coverage_gaps } : {}),
          aggregation_warnings: aggregation.warnings,
          regroup_directive: manualRequirement || isIntegratedStressTest(effectiveTestTypeChinese)
            ? `${testTypeGenerationRules(effectiveTestTypeChinese)}\n按当前类型规则补齐未覆盖子需求：${aggregation.coverage_gaps.join("、")}；禁止套用指令×总线机械重组。`
            : buildRegroupDirective(aggregation, structure),
          hint: "存在结构违规（跨 TR 拆分/用例内多指令/双总线混用/错误步骤未配对/0秒步骤/专属协议步骤模式或地址边界不完整/TR 覆盖缺口——tr_coverage_gaps 列出的 TR 无任何用例参考），persist 已拒绝。请把 regroup_directive（目标用例划分表）原文嵌入重派 prompt，重新生成该需求的测试用例后再调用 testcase_format_check(generated_text_file + persist=true)；重派一次后仍违规才置 auto_repair_structural_violations=true——工具将按'指令×总线'确定性重组用例并自动补配对步骤后落库；协议步骤模式、地址语义与周期时序必须由重派重新生成，不会被机械自愈。禁止首轮直接置 true 跳过检查。",
        })
      }
      // 确定性修复通道(2026-08-26 晚取证重构):作用于标准化视图——与检测
      // 端同一文本;修复器吃翻译后步骤时,关键字渲染文本让短语提取与检测端
      // 不一致,内部重检漏报。修复后对修复产物统一重翻译:插入/改写的步骤
      // 也获得关键字绑定(key_name 非空),不再产生"key_name 空值"半成品,
      // 杜绝人工返工通道从源重建时把修复步骤当缺陷丢弃
      let finalCases: typeof result.cases = result.cases
      let finalTranslationResults: typeof translationResults = translationResults
      let repairActions: string[] = []
      let repairResidual: string[] = []
      let nonRepairableStructureResidual: CaseStructureAnalysis["violations"] = []
      if (hasViolations) {
        const merged = result.cases.map((c) => ({
          case_name: c.case_name,
          test_purpose: c.test_purpose,
          covered_tr_items: c.covered_tr_items,
          correspond_fun_id: c.correspond_fun_id ?? effectiveRequirementId,
          test_step: c.test_step as unknown as RepairableStep[],
        }))
        const repair = repairCaseStructure(merged, {
          functionalModel,
          requirementCorpus: functionalProtocolCorpus,
          autonomousTelemetry,
          stationAddressCorpus: effectiveInputFlowContext ?? "",
          lengthVariantBases,
          functionalTwoAuxiliaryPackets,
          functionalMemoryReadRanges,
          functionalMemoryPollingPrerequisite,
          requiredPrimaryBuses,
        })
        finalCases = repair.cases as typeof result.cases
        // 重组重建的用例对象不带 case 级字段——initial_settings/test_input 以
        // 首用例为代理回填(与下方重翻译的 auxFields 同口径),persist 落库不再恒"无"
        const auxCase = result.cases[0]
        finalCases = repair.cases.map((c) => {
          const record = c as unknown as Record<string, unknown>
          return {
            ...c,
            initial_settings:
              (record.initial_settings as string | undefined) ?? auxCase?.initial_settings,
            test_input:
              (record.test_input as string | undefined) ?? auxCase?.test_input,
            test_environment:
              (record.test_environment as string | undefined) ?? auxCase?.test_environment,
          }
        }) as typeof result.cases
        if (manualRequirement || matchKeywordMap.size > 0) {
          const auxFields = result.cases[0]
          finalTranslationResults = repair.cases.map((c) =>
            translateStandardizedCaseToCombined(
              {
                test_environment: auxFields?.test_environment ?? "",
                initial_settings: auxFields?.initial_settings ?? "",
                test_input: auxFields?.test_input ?? "",
                constraints: auxFields?.constraints ?? "",
                assess_criteria: auxFields?.assess_criteria ?? "",
                cease_condition: auxFields?.cease_condition ?? "",
                case_name: c.case_name ?? "",
                test_purpose: c.test_purpose ?? "",
                test_step: (c.test_step ?? []) as unknown as Array<{ 步骤描述: string; 预期结果: string }>,
                correspond_fun_id: c.correspond_fun_id,
                covered_tr_items: c.covered_tr_items,
              },
              matchKeywordMap,
              stepPlanHints,
              testEnvironmentMode,
              // 修复重译同样携带需求级语料(电平等兜底与常规路径一致)
              [
                effectiveRequirementContext,
                effectiveInputFlowContext,
                textOfContext(manifestContext?.interruptContext),
              ].filter(Boolean).join("\n"),
              manualRequirement,
            ),
          )
        } else {
          // 无关键字库:保留原边界形状归一(persist 的 Unified schema 要求
          // step_desc 双拼写),跳过重翻译
          finalTranslationResults = []
          finalCases = repair.cases.map((c) => ({
            ...c,
            test_step: (c.test_step ?? []).map((step) => {
              if (typeof step.step_desc === "string") return step
              const desc = typeof step.步骤描述 === "string" ? step.步骤描述 : ""
              const expected = typeof step.预期结果 === "string" ? step.预期结果 : ""
              return {
                ...step,
                key_name: typeof step.key_name === "string" ? step.key_name : "",
                step_desc: desc,
                source_step_desc: desc,
                expected_result: expected,
                parameter: Array.isArray(step.parameter) ? step.parameter : [],
              }
            }),
          })) as typeof result.cases
        }
        repairActions = repair.actions
        repairResidual = [
          ...repair.residual_aggregation_violations.map((v) => `[聚合违规-修复后残留] ${v.message}`),
          ...repair.residual_structure_violations.map((v) => `[结构违规-修复后残留] ${v.message}`),
        ]
        const nonRepairableTypes = new Set([
          "functional_model_violation",
          "invalid_auxiliary_interleave",
          "invalid_memory_read_alignment",
          "invalid_memory_read_scenarios",
          "incomplete_memory_read_boundary",
          "invalid_memory_polling_schedule",
          "missing_bus_counterpart",
        ])
        nonRepairableStructureResidual = repair.residual_structure_violations
          .filter((violation) => nonRepairableTypes.has(violation.type))
      }
      if (nonRepairableStructureResidual.length > 0) {
        const residualStructure = { violations: nonRepairableStructureResidual }
        return JSON.stringify({
          valid: true,
          persisted: false,
          structure_violations: nonRepairableStructureResidual,
          regroup_directive: buildRegroupDirective(
            { violations: [], warnings: [], coverage_gaps: [] },
            residualStructure,
          ),
          hint:
            "专属协议步骤模式、内存地址语义/边界或周期时序在确定性修复后仍违规，" +
            "该类内容不允许通过 auto_repair_structural_violations 绕过；请按 regroup_directive 重派 worker 重新生成。",
        })
      }
      if (hasCoverageGaps) {
        repairResidual.push(
          `[TR覆盖缺口-重派后仍缺失] TR ${aggregation.coverage_gaps.join("、")} 的检查情况仍无任何用例参考` +
          `（确定性修复无法凭空合成缺失 TR 的用例，需重派生成补齐）`,
        )
      }
      const persistResult = persistCheckedCasesToSuite({
        projectDir,
        requirementId: effectiveRequirementId,
        cases: finalCases,
        translationResults: finalTranslationResults ?? [],
      })
      if (persistResult.error) {
        return JSON.stringify({ valid: true, ...persistResult })
      }
      // 截断保护(2026-09-08 P11 取证):20 用例时 per_case_status/repair_actions/
      // warnings 全量回显曾被截断,主智能体只能另查 suite 确认——数组封顶,
      // 总数另报,不再依赖超限回显
      const capList = <T,>(list: T[], limit: number): T[] | (T | string)[] =>
        list.length <= limit ? list : [...list.slice(0, limit), `……其余 ${list.length - limit} 条略(共 ${list.length} 条)`]
      return JSON.stringify({
        valid: true,
        persisted: true,
        persisted_case_count: persistResult.persisted_case_count,
        case_ids: persistResult.case_ids,
        ...(repairActions.length > 0 ? { repair_actions: capList(repairActions, 8) } : {}),
        per_case_status_total: (finalTranslationResults ?? []).length,
        per_case_status: (finalTranslationResults ?? []).slice(0, 6).map((t, i) => ({
          case_name: finalCases![i]?.case_name,
          translate_status: t?.translate_status,
        })),
        warnings: capList([
          ...keywordCatalog.warnings,
          ...(contextFallbackUsed
            ? [`requirement_id=${requirement_id ?? ""} 未显式提供上下文，已从 phase6-generation-items.json 回填标准化上下文。`]
            : []),
          ...(result.warnings ?? []),
          ...aggregation.warnings,
          ...(repairActions.length > 0
            ? [
              ...aggregation.violations.map((v) => `[聚合违规-已确定性修复] ${v.message}`),
              ...structure.violations.map((v) => `[结构违规-已确定性修复] ${v.message}`),
              ...repairActions.map((a) => `[结构修复] ${a}`),
            ]
            : []),
          ...repairResidual,
          ...(persistResult.warnings ?? []),
        ], 8),
      })
    }

    let nonPersistAggregation = result.valid && result.cases && result.cases.length > 0
      ? analyzeCaseAggregation(
        result.cases.map((c) => ({
          case_name: c.case_name,
          covered_tr_items: c.covered_tr_items,
          test_step: c.test_step,
        })),
        expandFunIdString(requirement_id ?? textOfContext(manifestContext.requirement_id) ?? ""),
      )
      : { violations: [], warnings: [], coverage_gaps: [] }
    if (manualRequirement) nonPersistAggregation.violations = []
    // 结构校验补齐(2026-09-17 旁路封堵,2026-08-31 审计 P6 遗留项):非 persist
    // (小输出)路径此前完全不跑结构门禁,混总线/混指令/固定句式偏离的用例带病
    // 直落——与 persist 路径同规则
    const nonPersistCases = result.valid && result.cases ? result.cases : []
    const nonPersistStructure: CaseStructureAnalysis = nonPersistCases.length > 0 && !manualRequirement && !isIntegratedStressTest(effectiveTestTypeChinese)
      ? analyzeCaseStructure(
        nonPersistCases.map((c) => ({
          case_name: c.case_name,
          test_purpose: c.test_purpose,
          test_step: c.test_step,
        })),
        {
          lengthVariantBases: extractLengthVariantBases(effectiveInputFlowContext ?? ""),
          functionalTwoAuxiliaryPackets,
          functionalMemoryReadRanges,
          functionalMemoryPollingPrerequisite,
          functionalModel,
          requirementCorpus: functionalProtocolCorpus,
          autonomousTelemetry,
        },
      )
      : { violations: [] }
    if (watchdogRequirement) {
      for (const caseRecord of nonPersistCases) {
        const steps = caseRecord.test_step ?? []
        const firstDesc = String((steps[0] as Record<string, unknown> | undefined)?.["步骤描述"] ?? "")
        const firstExpected = String((steps[0] as Record<string, unknown> | undefined)?.["预期结果"] ?? "")
        const shapeOk = steps.length === 1
          && /使用示波器多次测试清看门狗时间间隔/.test(firstDesc)
          && /软件清看门狗时间间隔最大不超过.+s/.test(firstExpected)
        if (!shapeOk) {
          nonPersistStructure.violations.push({
            type: "watchdog_shape_violation",
            case_name: String(caseRecord.case_name ?? "未命名用例"),
            message: "看门狗用例须为固定句式（单用例单步骤：使用示波器多次测试清看门狗时间间隔；预期为清看门狗最大时间上限，禁止填狗咬时间、禁止内存写喂狗步骤）",
          })
        }
      }
    }
    nonPersistAggregation = suppressContradictoryAggregation(nonPersistAggregation, nonPersistStructure)

    return JSON.stringify({
      ...result,
      ...(!result.valid ? {
        failure_kind: "content_validation_failed",
        source_output_status: sourceStatus,
        repair_directive: repairDirective,
      } : {}),
      combined_translations: translationResults ?? [],
      aggregation_violations: nonPersistAggregation.violations.length > 0
        ? nonPersistAggregation.violations
        : undefined,
      structure_violations: nonPersistStructure.violations.length > 0
        ? nonPersistStructure.violations
        : undefined,
      ...(nonPersistStructure.violations.length > 0
        ? {
          regroup_directive: buildRegroupDirective(nonPersistAggregation, nonPersistStructure),
          hint: "结构校验未通过：请勿将本响应中的用例直接 ct_suite_add_case 落库；请按 regroup_directive 重派 worker 重新生成，再以 persist=true 重新校验入库。",
        }
        : {}),
      warnings: [
        ...keywordCatalog.warnings,
        ...(contextFallbackUsed
          ? [`requirement_id=${requirement_id ?? ""} 未显式提供上下文，已从 phase6-generation-items.json 回填标准化上下文。`]
          : []),
        ...(result.warnings ?? []),
        ...nonPersistAggregation.warnings,
      ],
    })
  },
})
