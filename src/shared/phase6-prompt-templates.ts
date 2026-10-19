import { existsSync, readFileSync } from "fs"
import { createHash } from "crypto"
import { dirname, join } from "path"
import { z } from "zod"
import { buildTemplateAssetCandidates, resolveTemplateAssetPath } from "./template-resolution"
import {
  PHASE6_EXPLICIT_OUTPUT_RULE,
  PHASE6_FUNCTIONAL_SCOPE_RULE,
  PHASE6_NO_UNRESOLVED_PLACEHOLDER_RULE,
} from "./phase6-testcase-policy"
import { PHASE6_GENERATION_GUIDE } from "./constants"

export const TESTCASE_PROMPT_INDEX_FILE = "testcase-prompts/index.json"
export const LEGACY_PROMPT_TEMPLATE_FILE = "prompt_templates.json"

export type Phase6ProjectType = "software" | "fpga" | "requirements" | "software_variant"

export interface PromptTemplateIndexMatch {
  project_types?: string[]
  test_types?: string[]
  domain?: string
}

export interface PromptTemplateIndexEntry {
  key: string
  file: string
  match?: PromptTemplateIndexMatch
  fallback?: boolean
  priority?: number
}

const nonemptyIndexString = z.string().refine((value) => value.trim().length > 0)
const PromptTemplateIndexDocumentSchema = z.object({
  version: z.number().int().positive(),
  templates: z.array(z.object({
    key: nonemptyIndexString,
    file: nonemptyIndexString,
    match: z.object({
      project_types: z.array(nonemptyIndexString).optional(),
      test_types: z.array(nonemptyIndexString).optional(),
      domain: nonemptyIndexString.optional(),
    }).optional(),
    fallback: z.boolean().optional(),
    priority: z.number().finite().optional(),
  })),
})

export interface LoadedMarkdownPromptTemplates {
  templates: Record<string, string>
  entries: PromptTemplateIndexEntry[]
  files: Record<string, string>
  index_file?: string
  hashes?: Record<string, string>
}

export interface LoadedPhase6PromptTemplates {
  templates: Record<string, string>
  template_sources: Record<string, "legacy" | "builtin">
  markdown_catalog: LoadedMarkdownPromptTemplates | null
  warnings: string[]
  checked_prompt_index_candidates: string[]
  checked_legacy_template_candidates: string[]
}

export interface ResolvedPhase6PromptTemplate {
  key: string
  body: string
  source: "markdown" | "legacy" | "builtin"
  file?: string
  hash?: string
  index_file?: string
  selection_reason?: string
}

export interface Phase6PromptRuleSections {
  general_rules: string[]
  type_rules: string[]
}

export const BUILTIN_PHASE6_PROMPT_TEMPLATES: Record<string, string> = {
  "TR-XQ": [
    "### 任务目标",
    "你要为一条测试需求生成确认测试用例。",
    "",
    "### 输出格式",
    "- 只输出 JSON 数组。",
    "- 每个用例包含 `test_case_name`、`test_purpose`、`test_step`。",
    "- `test_step` 是数组；每个元素包含 `步骤描述`、`预期结果`。可选地，添加 `operation_type`、`channel`、`temporal`、`data_checks` 锚点字段以辅助后续关键字匹配。",
    "",
    "### 通用生成规则",
    "- 只围绕当前 requirement 生成，不补充无关场景。",
    "- `步骤描述`写人工操作，`预期结果`写可观察、可验证结果。",
    "- `步骤描述`和`预期结果`都以中文句号结尾。",
    "- JSON 必须使用双引号、无末尾逗号、可直接解析。",
    "",
    "### 类型专属规则",
    "- 只覆盖需求明确描述的核心测试点，不自动扩展边界、异常、恢复或并发场景，除非输入信息明确要求。",
    "- 测试目的要简洁说明验证意图，步骤与预期结果要一一对应。",
    `- ${PHASE6_EXPLICIT_OUTPUT_RULE}`,
    `- ${PHASE6_NO_UNRESOLVED_PLACEHOLDER_RULE}`,
    "",
    "### 输入信息",
    "- 测试需求：{tr_id}：{tr_handling}",
  ].join("\n"),
  "TR-DG-STEP-GENERATED": [
    "### 任务目标",
    "你要为一条软件测试需求生成确认测试用例。",
    "",
    "### 输出格式",
    "- 只输出 JSON 数组。",
    "- 每个用例包含 `test_case_name`、`test_purpose`、`test_step`。",
    "- `test_step` 是数组；每个元素包含 `步骤描述`、`预期结果`。可选地，添加 `operation_type`、`channel`、`temporal`、`data_checks` 锚点字段以辅助后续关键字匹配。",
    "",
    "### 步骤元数据规则（可选，强烈推荐）",
    "- 如果步骤语义明确，为每个 test_step 元素附加上下文锚点以辅助关键字匹配：",
    "- `operation_type`: send_command / inject_input / trigger_output / set_input_data / set_memory / verify_telemetry / verify_response / verify / bus_communication / initialization / other",
    "- `channel`: CANA / CANB / 空字符串",
    "- `temporal`: 如 '第3.0秒'",
    "- `data_checks`: 预期结果中的具体检查项",
    "- 示例：{\"步骤描述\":\"第3.0秒，通过CANA总线发送指令\",\"预期结果\":\"系统接收到指令。\",\"operation_type\":\"send_command\",\"channel\":\"CANA\",\"temporal\":\"第3.0秒\"}",
    "",
    "### 通用生成规则",
    "- 只围绕当前 requirement 生成，不补充无关场景。",
    "- `步骤描述`写人工操作，`预期结果`写可观察、可验证结果。",
    "- `步骤描述`和`预期结果`都以中文句号结尾。",
    "- JSON 必须使用双引号、无末尾逗号、可直接解析。",
    "",
    "### 类型专属规则",
    "- 优先依据测试方法、通过准则和充分性要求组织步骤。",
    "- 按功能点划分用例：每个需求明确描述的独立功能点一个用例；同一功能点的多种情况在同一用例多步骤覆盖，不无故拆分；不同功能点不合并进同一个用例。",
    "- 总线接收类功能需求必须把协议格式表转成覆盖清单：识别数据包数和每包帧数，仲裁场/控制场分开测试，单帧轮询逐字段/逐字节覆盖，多帧按首帧/中间代表帧/尾帧覆盖适用字段和帧序号错误（2帧仅首+尾），每步只注入一个错误。",
    "- 有序多包含双辅助数据包：正确包按1至n推进，各包分摊单字段错误；前n-1包正确后紧随同包一个错误，剩余错误用末包在正确末包之前逐项补测，最终以完整正确末包收尾；错误已测完则剩余包连续正确发送。不得为覆盖字段重启正确包序列。",
    "- 内存读出指令每条总线分字段错误和地址边界两个用例；非4字节对齐地址直接按错误指令处理；每个地址区间覆盖下边界-1/下边界/下边界+1/中间对齐值/上边界-1/上边界/上边界+1。",
    "- 内存数据轮询用例第1步在3.0s启动5s周期内存读出指令，后续在5.0/10.0/15.0s…发送正确/单字段错误交替的轮询控制序列，不得用初始化内存代替前置指令。",
    `- ${PHASE6_EXPLICIT_OUTPUT_RULE}`,
    `- ${PHASE6_NO_UNRESOLVED_PLACEHOLDER_RULE}`,
    "",
    "### 输入信息",
    "- 测试项名称：{tr_name}",
    "- 测试需求：{tr_id}：{tr_handling}",
    "- 充分性要求：{tr_sufficiency}",
    "- 测试方法：{tr_testMethod}",
    "- 通过准则：{tr_passCriteria}",
  ].join("\n"),
  "FPGA-DG-STEP-NOT-GENERATED": [
    "### 任务目标",
    "你要为一条 FPGA 测试需求生成确认测试用例。",
    "",
    "### 输出格式",
    "- 只输出 JSON 数组。",
    "- 每个用例包含 `test_case_name`、`test_purpose`、`test_step`。",
    "- `test_step` 是数组；每个元素包含 `步骤描述`、`预期结果`。可选地，添加 `operation_type`、`channel`、`temporal`、`data_checks` 锚点字段以辅助后续关键字匹配。",
    "",
    "### 通用生成规则",
    "- 只围绕当前 requirement 生成，不补充无关场景。",
    "- `步骤描述`写测试动作，`预期结果`写可观察、可验证结果。",
    "- `步骤描述`和`预期结果`都以中文句号结尾。",
    "- JSON 必须使用双引号、无末尾逗号、可直接解析。",
    "",
    "### 类型专属规则",
    "- 如果测试方法和通过准则都按序号列出且条数一致，优先按序号一一对应生成步骤与预期结果；若条数不一致，以测试方法条数为准组织步骤，再结合通过准则生成对应预期结果。",
    "- 优先依据测试方法和通过准则组织步骤，不加入无关示例或额外解释。",
    "",
    "### 输入信息",
    "- 测试项名称：{tr_name}",
    "- 测试需求：{tr_id}：{tr_handling}",
    "- 充分性要求：{tr_sufficiency}",
    "- 测试方法：{tr_testMethod}",
    "- 通过准则：{tr_passCriteria}",
  ].join("\n"),
  "test-接口测试-STEP-GENERATED": [
    "### 任务目标",
    "你要为一条接口测试需求项生成测试用例。",
    "",
    "### 输出格式",
    "- 只输出 JSON 数组。",
    "- 每个用例必须包含 `test_case_name`、`test_purpose`、`covered_tr_items`、`test_step`。",
    "- `test_case_name` 使用简洁的中文短语描述该用例的测试场景。",
    "- `covered_tr_items` 是一个字符串数组，列出本用例覆盖的具体 TR 子需求项编号。",
    "- `test_step` 是数组；每个元素必须包含 `步骤描述` 和 `预期结果`。",
    "",
    "### 通用生成规则",
    "- 只输出严格 JSON 数组，不要输出解释、标题或代码块标记。",
    "- 仅围绕当前测试需求项相关内容生成，不补充无关场景。",
    "- `步骤描述`写人工操作，`预期结果`写可观察、可验证结果。",
    "- JSON 必须使用双引号、无末尾逗号、可直接解析。",
    "",
    "### 类型专属规则",
    "**强制覆盖率检查（生成前必须逐条确认，不可遗漏）**",
    "1. 查看输入流说明中的指令数据格式表格，统计每个指令的总帧数。",
    "2. 每条具体指令（数据流定义逐条，如遥测帧1轮询/遥测帧2轮询/内存数据轮询是三条不同指令，即使同为单帧格式）+每条总线生成一个独立测试用例。双冗余总线时 CANA 和 CANB 各一个用例。",
    "3. 格式不同或字节长度不同的指令拆分为不同用例。",
    "4. 单帧指令用例步骤按 正确→字段错误→正确→字段错误→正确 编排。",
    "5. 多帧指令必须覆盖每一帧的字段错误 + 4类帧序号错误。",
    "6. 步骤描述只说明步骤情况，禁止罗列帧字段值清单：正确步骤写“第3.0秒，通过CANB总线发送正确的遥测帧1轮询控制序列”；字段错误步骤写“第3.5秒，通过CANB总线发送遥测帧1轮询控制序列（仲裁场错误，其余字段正确）”；不得出现 仲裁场=8DH、控制场=04H 之类的字段值列举。字段的具体取值由执行阶段的数据文件承载。步骤中的操作性参数（第N秒、内存地址、数据文件名等单值参数）保留。",
    "7. 生成后自检：是否所有指令类型都已覆盖？是否 CANA 和 CANB 各有用例？",
    "",
    "### 输入信息",
    "- 需求项名称：{tr_name}",
    "- 需求项简介：{tr_summary}",
    "- 输入流说明：{input_flow}",
    "- 处理：{tr_handling}",
    "- 输出流说明：{tr_output_flow}",
    "- 测试要求：{tr_testConstraint}",
  ].join("\n"),
}

const SUPPORTED_TEST_TYPES = [
  "功能测试", "性能测试", "接口测试", "可靠性安全性测试", "余量测试",
  "边界测试", "强度测试", "数据处理测试", "恢复性测试", "逻辑测试", "时序测试",
] as const

/** Software case generation always uses this prompt family; domain guides are additive. */
export const PHASE6_SOFTWARE_TEMPLATE_FILES: Record<string, string> = {
  "功能测试": "test-functional.md",
  "性能测试": "test-software-performance.md",
  "接口测试": "test-interface.md",
  "可靠性安全性测试": "test-software-safety.md",
  "余量测试": "test-margin.md",
  "边界测试": "test-boundary.md",
  "强度测试": "test-software-stress.md",
  "数据处理测试": "test-data-processing.md",
  "恢复性测试": "test-software-recovery.md",
  "逻辑测试": "test-logic.md",
  "时序测试": "test-timing.md",
}

const TEST_TYPE_ALIASES: Record<string, string> = {
  functional: "功能测试", performance: "性能测试", interface: "接口测试",
  safety: "可靠性安全性测试", margin: "余量测试", boundary: "边界测试",
  stress: "强度测试", data_processing: "数据处理测试", recovery: "恢复性测试",
  logic: "逻辑测试", logic_test: "逻辑测试", timing: "时序测试", robustness: "可靠性安全性测试",
  "安全": "可靠性安全性测试", "安全测试": "可靠性安全性测试",
  "安全性": "可靠性安全性测试", "安全性测试": "可靠性安全性测试",
  "恢复": "恢复性测试", "恢复测试": "恢复性测试",
}

const FPGA_SPECIFIC_TYPES = ["功能测试", "逻辑测试", "接口测试", "边界测试", "可靠性安全性测试"] as const

export function extractPromptBlock(markdown: string): string | null {
  const match = markdown.match(/```prompt\s*\r?\n([\s\S]*?)```/m)
  const body = match?.[1]?.trim()
  return body ? `${body}\n` : null
}

export function normalizePhase6TestType(testType: string | undefined): string | null {
  if (typeof testType !== "string") return null
  const normalized = testType.trim()
  if (!normalized) return null

  if ((SUPPORTED_TEST_TYPES as readonly string[]).includes(normalized)) return normalized
  const aliasKey = normalized.toLowerCase().replace(/-/g, "_")
  if (Object.hasOwn(TEST_TYPE_ALIASES, aliasKey)) return TEST_TYPE_ALIASES[aliasKey]

  for (const supported of SUPPORTED_TEST_TYPES) {
    if (normalized === supported.replace(/测试$/, "")) {
      return supported
    }
  }

  return null
}

export function extractPhase6PromptRuleSections(prompt: string): Phase6PromptRuleSections {
  const lines = prompt.split(/\r?\n/)
  const collectSection = (heading: string): string[] => {
    const results: string[] = []
    let active = false
    for (const line of lines) {
      if (/^###\s+/.test(line.trim())) {
        active = line.trim() === `### ${heading}`
        continue
      }
      if (!active) continue
      const bullet = line.match(/^\s*-\s+(.*)$/)
      if (bullet?.[1]) {
        results.push(bullet[1].trim())
      }
    }
    return results
  }

  return {
    general_rules: collectSection("通用生成规则"),
    type_rules: collectSection("类型专属规则"),
  }
}

export function loadMarkdownPromptTemplates(indexFile: string): {
  catalog: LoadedMarkdownPromptTemplates | null
  warnings: string[]
} {
  const warnings: string[] = []

  try {
    const raw = readFileSync(indexFile, "utf-8")
    const validated = PromptTemplateIndexDocumentSchema.safeParse(JSON.parse(raw))
    if (!validated.success) {
      return {
        catalog: null,
        warnings: [`testcase-prompts/index.json 格式非法：${indexFile}。${validated.error.message}`],
      }
    }

    // Validate identities before reading any files: even a missing/invalid
    // duplicate must not be able to mask another entry or overwrite its body.
    const parsed = validated.data
    const seenKeys = new Set<string>()
    for (const entry of parsed.templates) {
      if (seenKeys.has(entry.key)) {
        return { catalog: null, warnings: [`testcase-prompts/index.json 存在重复模板 key='${entry.key}'：${indexFile}，停止加载。`] }
      }
      seenKeys.add(entry.key)
    }

    const templates: Record<string, string> = Object.create(null)
    const files: Record<string, string> = Object.create(null)
    const hashes: Record<string, string> = Object.create(null)
    const entries: PromptTemplateIndexEntry[] = []
    const indexDir = dirname(indexFile)

    for (const entry of parsed.templates) {
      const templatePath = join(indexDir, entry.file)
      if (!existsSync(templatePath)) {
        warnings.push(`testcase-prompts 模板文件缺失：${templatePath}，已跳过 key='${entry.key}'。`)
        continue
      }

      const markdown = readFileSync(templatePath, "utf-8")
      const prompt = extractPromptBlock(markdown)
      if (!prompt) {
        warnings.push(`testcase-prompts 模板文件缺少 \`\`\`prompt 代码块：${templatePath}，已跳过 key='${entry.key}'。`)
        continue
      }

      entries.push(entry)
      templates[entry.key] = prompt
      files[entry.key] = templatePath
      hashes[entry.key] = createHash("sha256").update(markdown, "utf-8").digest("hex")
    }

    if (entries.length === 0) {
      warnings.push(`testcase-prompts/index.json 未加载到任何有效模板：${indexFile}。`)
      return { catalog: null, warnings }
    }

    return {
      catalog: {
        templates,
        entries,
        files,
        hashes,
        index_file: indexFile,
      },
      warnings,
    }
  } catch (err) {
    return {
      catalog: null,
      warnings: [
        `解析 testcase-prompts/index.json 失败（${indexFile}）：${err instanceof Error ? err.message : String(err)}`,
      ],
    }
  }
}

function matchesProjectType(match: PromptTemplateIndexMatch | undefined, projectType: string): boolean {
  const projectTypes = match?.project_types
  if (!projectTypes || projectTypes.length === 0) return true
  return projectTypes.includes(projectType)
}

function matchesTestType(match: PromptTemplateIndexMatch | undefined, testTypeChinese: string | null): boolean {
  const testTypes = match?.test_types
  if (!testTypes || testTypes.length === 0) return true
  if (!testTypeChinese) return false
  return testTypes.some((type) => (normalizePhase6TestType(type) ?? type) === testTypeChinese)
}

function matchesDomain(match: PromptTemplateIndexMatch | undefined, domain: string | undefined): boolean {
  // Entry with no domain restriction matches any domain
  if (!match?.domain) return true
  // Entry with domain restriction only matches if domain is explicitly set
  if (!domain) return false
  return match.domain === domain
}

export function selectTemplateKeyFromIndex(
  testTypeChinese: string | null,
  projectType: Phase6ProjectType,
  catalog: LoadedMarkdownPromptTemplates,
  domain?: string,
): string | null {
  const sortByPriority = (left: PromptTemplateIndexEntry, right: PromptTemplateIndexEntry) =>
    (right.priority ?? 0) - (left.priority ?? 0)

  if (projectType === "software" || projectType === "software_variant") {
    const normalizedType = normalizePhase6TestType(testTypeChinese ?? undefined)
    const expectedFile = normalizedType ? PHASE6_SOFTWARE_TEMPLATE_FILES[normalizedType] : undefined
    if (!expectedFile) {
      throw new Error(`软件测试类型未识别：'${testTypeChinese ?? "未指定"}'；必须指定受支持的测试类型，不允许回退到旧模板或默认模板。`)
    }
    const selected = catalog.entries
      .filter((entry) => !entry.fallback
        && entry.file === expectedFile
        && matchesProjectType(entry.match, projectType)
        && matchesTestType(entry.match, normalizedType)
        && !entry.match?.domain
        && Boolean(catalog.templates[entry.key]?.trim()))
      .sort(sortByPriority)[0]
    if (!selected) {
      throw new Error(`软件${normalizedType}必须使用 ${expectedFile}，但索引 ${catalog.index_file ?? "testcase-prompts/index.json"} 中缺少有效且适用于 ${projectType} 的模板；请检查索引注册、文件及 prompt 正文，禁止回退到 software-/satellite-/legacy 模板。`)
    }
    return selected.key
  }

  const candidates = catalog.entries
    .filter((entry) =>
      !entry.fallback
      && matchesProjectType(entry.match, projectType)
      && matchesTestType(entry.match, testTypeChinese)
      && matchesDomain(entry.match, domain)
    )
    .sort(sortByPriority)

  // Prefer domain-specific matches over generic ones
  const domainMatch = candidates.find((entry) => entry.match?.domain === domain)
  if (domainMatch) return domainMatch.key

  // Fall back to any match (generic without domain restriction)
  const anyMatch = candidates.find((entry) => !entry.match?.domain)
  if (anyMatch) return anyMatch.key

  // Fallback entries: domain-specific first, then generic
  const fallbackCandidates = catalog.entries
    .filter((entry) =>
      entry.fallback
      && matchesProjectType(entry.match, projectType)
      && matchesDomain(entry.match, domain)
    )
    .sort(sortByPriority)

  const domainFallback = fallbackCandidates.find((entry) => entry.match?.domain === domain)
  if (domainFallback) return domainFallback.key

  const genericFallback = fallbackCandidates.find((entry) => !entry.match?.domain)
  return genericFallback?.key ?? null
}

export function selectLegacyTemplateKey(
  testTypeChinese: string | null,
  templates: Record<string, string>,
  projectType: Phase6ProjectType,
  domain?: string,
): string {
  const normalizedType = normalizePhase6TestType(testTypeChinese ?? undefined)

  if (normalizedType) {
    if (projectType === "software" || projectType === "software_variant") {
      // Prefer domain-specific satellite templates when available
      if (domain === "satellite-dsp") {
        const satelliteKey = `satellite-${normalizedType}-STEP-GENERATED`
        if (satelliteKey in templates) return satelliteKey
      }
      const key = `${normalizedType}-STEP-GENERATED`
      if (key in templates) return key
    } else if (projectType === "fpga") {
      if ((FPGA_SPECIFIC_TYPES as readonly string[]).includes(normalizedType)) {
        const fpgaKey = `FPGA-${normalizedType}-STEP-GENERATED`
        if (fpgaKey in templates) return fpgaKey
      }
    }
  }

  // Fallback when normalizedType is null or no type-specific template found
  if (projectType === "requirements") return "TR-XQ"
  if (projectType === "fpga") return "FPGA-DG-STEP-NOT-GENERATED"
  // Use satellite fallback for software projects when domain is satellite-dsp
  if (domain === "satellite-dsp" && (projectType === "software" || projectType === "software_variant")) {
    const satelliteFallback = "satellite-TR-DG-STEP-GENERATED"
    if (satelliteFallback in templates) return satelliteFallback
  }
  return "TR-DG-STEP-GENERATED"
}

export function loadPhase6PromptTemplates(options: {
  projectDir: string
  importMetaDir: string
  legacyGeneratorPath?: string
  builtinTemplates?: Record<string, string>
}): LoadedPhase6PromptTemplates {
  const builtinTemplates = options.builtinTemplates ?? BUILTIN_PHASE6_PROMPT_TEMPLATES
  const warnings: string[] = []
  const legacyGeneratorPath =
    options.legacyGeneratorPath
    ?? process.env.MATRIX_TESTCASE_GENERATOR_PATH
    ?? "/home/greatwall/00-git/auto-testcase-generator"

  // Phase 6 has one authoritative project-first lookup. An existing project
  // index is authoritative even when invalid; never silently skip it.
  const checkedPromptIndexCandidates = [...new Set([
    join(options.projectDir, "templates", TESTCASE_PROMPT_INDEX_FILE),
    join(options.projectDir, ".matrix", "templates", TESTCASE_PROMPT_INDEX_FILE),
    join(options.projectDir, ".opencode", "templates", TESTCASE_PROMPT_INDEX_FILE),
    join(options.projectDir, ".config", "opencode", "templates", TESTCASE_PROMPT_INDEX_FILE),
    ...buildTemplateAssetCandidates({
      filename: TESTCASE_PROMPT_INDEX_FILE,
      importMetaDir: options.importMetaDir,
      projectDir: options.projectDir,
      envVarName: "MATRIX_TESTCASE_GENERATOR_PATH",
      envPathResolver: (value) => join(value, TESTCASE_PROMPT_INDEX_FILE),
      extraCandidates: [join(legacyGeneratorPath, TESTCASE_PROMPT_INDEX_FILE)],
    }),
  ])]
  const promptIndexFile = checkedPromptIndexCandidates.find((candidate) => existsSync(candidate)) ?? null

  let markdownCatalog: LoadedMarkdownPromptTemplates | null = null
  if (promptIndexFile) {
    const loadedMarkdownCatalog = loadMarkdownPromptTemplates(promptIndexFile)
    markdownCatalog = loadedMarkdownCatalog.catalog
    warnings.push(...loadedMarkdownCatalog.warnings)
    if (!markdownCatalog) {
      throw new Error(`已选 Phase 6 提示词索引无效，停止生成而不切换模板来源：${promptIndexFile}。${loadedMarkdownCatalog.warnings.join(" ")}`)
    }
  }

  const { path: legacyTemplateFile, checked: checkedLegacyTemplateCandidates } = resolveTemplateAssetPath({
    filename: LEGACY_PROMPT_TEMPLATE_FILE,
    importMetaDir: options.importMetaDir,
    projectDir: options.projectDir,
    envVarName: "MATRIX_TESTCASE_GENERATOR_PATH",
    envPathResolver: (value) => join(value, LEGACY_PROMPT_TEMPLATE_FILE),
    extraCandidates: [join(legacyGeneratorPath, LEGACY_PROMPT_TEMPLATE_FILE)],
  })

  const templates: Record<string, string> = { ...builtinTemplates }
  const templateSources: Record<string, "legacy" | "builtin"> = {}
  for (const key of Object.keys(builtinTemplates)) {
    templateSources[key] = "builtin"
  }

  let legacyTemplateLoaded = false
  if (legacyTemplateFile) {
    try {
      const parsed = JSON.parse(readFileSync(legacyTemplateFile, "utf-8")) as Record<string, string>
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value !== "string") continue
        templates[key] = value
        templateSources[key] = "legacy"
      }
      legacyTemplateLoaded = true
    } catch (err) {
      warnings.push(
        `解析 legacy prompt_templates.json 失败，已自动回退到内置模板：${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  if (!markdownCatalog && !legacyTemplateLoaded) {
    warnings.push(
      `未找到 testcase-prompts/index.json 与 legacy prompt_templates.json；内置模板仅供 FPGA/需求项目兼容使用，软件项目将拒绝生成。已检查路径：${[
        ...checkedPromptIndexCandidates,
        ...checkedLegacyTemplateCandidates,
      ].join(", ")}`,
    )
  }

  return {
    templates,
    template_sources: templateSources,
    markdown_catalog: markdownCatalog,
    warnings,
    checked_prompt_index_candidates: checkedPromptIndexCandidates,
    checked_legacy_template_candidates: checkedLegacyTemplateCandidates,
  }
}

export function resolvePhase6PromptTemplate(options: {
  loaded: LoadedPhase6PromptTemplates
  testTypeChinese: string | null
  projectType: Phase6ProjectType
  domain?: string
}): ResolvedPhase6PromptTemplate {
  // Software routing is strict; other project families retain compatibility.
  if (options.loaded.markdown_catalog) {
    const markdownKey = selectTemplateKeyFromIndex(
      options.testTypeChinese,
      options.projectType,
      options.loaded.markdown_catalog,
      options.domain,
    )
    if (markdownKey) {
      const catalog = options.loaded.markdown_catalog
      const file = catalog.files[markdownKey]
      return {
        key: markdownKey,
        body: options.loaded.markdown_catalog.templates[markdownKey],
        source: "markdown",
        file,
        hash: catalog.hashes?.[markdownKey]
          ?? (file && existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : undefined),
        index_file: catalog.index_file,
        selection_reason: options.projectType === "software" || options.projectType === "software_variant"
          ? `测试类型 ${normalizePhase6TestType(options.testTypeChinese ?? undefined)} 固定选择 test-* 主模板；领域 ${options.domain ?? "generic"} 仅作为补充知识。`
          : `按项目类型 ${options.projectType}、测试类型及领域选择模板。`,
      }
    }
  }

  if (options.projectType === "software" || options.projectType === "software_variant") {
    throw new Error(`软件测试用例生成必须使用 testcase-prompts/index.json 中对应的 test-*.md 模板，当前没有可用索引；禁止降级到 legacy 或内置模板。已检查：${options.loaded.checked_prompt_index_candidates.join(", ")}`)
  }

  // Fallback: legacy/builtin template path (minimal absolute fallbacks only)
  const legacyKey = selectLegacyTemplateKey(
    options.testTypeChinese,
    options.loaded.templates,
    options.projectType,
    options.domain,
  )
  return {
    key: legacyKey,
    body: options.loaded.templates[legacyKey],
    source: options.loaded.template_sources[legacyKey] ?? "builtin",
  }
}

// ---------------------------------------------------------------------------
// Built-in Domain Guides — satellite DSP domain knowledge baked into code
// ---------------------------------------------------------------------------

const BUILTIN_DOMAIN_GUIDES: Record<string, Phase6GenerationGuide> = {
  "satellite-dsp": {
    generated_at: "2026-05-11",
    example_source: "DSP_0509_1614 中继测控单元接口处理DSP软件",
    keyword_selection_rules: [
      "CAN总线数据发送类操作优先使用 UserKeyword 中的『发送CANA数据』或『发送CANB数据』组合关键字",
      "CAN总线帧间隔配置使用『设置CANA总线帧间隔』或『设置CANB总线帧间隔』",
      "内存/寄存器数据设置使用『设置32位地址数据』指定起始地址和数据内容",
      "FPGA遥测数据发送按芯片类型选择：CE0→『发送CE0遥测数据_数据池』，CE2（基带信号处理）→『发送CE2_遥测数据_数据池』，CE3（配置管理）→『发送CE3_配置管理FPGA遥测_数据池』",
      "前向短报文数据发送使用『发送CE2_前向短报文遥测数据_数据池』",
      "外部中断触发使用『触发外部中断』，参数包括中断号、电平（HIGH/LOW）和周期",
      "监控类操作优先从 GlobalVar/WatchMem 系列库中选择对应的『监视』关键字",
      "CAN总线指令批量发送时使用『循环发送CANA指令』或『循环发送CANB指令』",
      "除非需求明确要求手动逐字节设置内存，否则优先使用组合关键字而非底层 VTest API",
      "轮询控制序列操作优先检查 UserKeyword 是否提供对应的高层关键字",
    ],
    protocol_field_mapping_rules: [
      "遥测数据字段在预期结果中的引用格式为『遥测数据_字段名 = 期望值』",
      "缓变遥测数据字引用格式为『缓变遥测数据_W{序号} = {值}』或『缓变遥测数据_W{序号}_{字段名} = {值}』",
      "速变遥测数据字段引用格式为『速变遥测数据_{字段名} = {值}』",
      "下泄遥测数据字段引用格式为『下泄遥测数据_{字段名} = {值}』",
      "CAN总线应答帧期望格式为十六进制字节序列如『65H 44H 15H FFH 20H 34H』",
      "内存地址断言格式为『内存地址0x{地址}的数据为{值}』",
      "总线状态引用使用『A总线命令状态』、『B总线命令状态』、『A总线复位计数』、『B总线复位计数』",
      "时间相关字段使用『第{time}秒』作为绝对仿真时间的前缀",
      "数据包名称需与协议 DOCX 中定义的名称一致",
    ],
    step_composition_rules: [
      "每个步骤描述必须以『第{time}秒』开头指定仿真时间",
      "方法：先分析需求意图（接收X→发送Y / 接收X→设置Y / 采集X→组帧Y），确定步骤数量",
      "方法：通信类需求至少2步——步骤1发送输入流（让被测件收到数据），步骤2发送输出流（触发被测件输出处理）",
      "方法：总线通道与输入/输出流信息见 normalization_context 的 inputFlowContext/outputFlowContext，处理描述见 processingContext",
      "方法：normalization_context.step_plan 仅辅助理解动作和通道，参数与时刻以当前需求和实际生成步骤为准，不直接复用空白或不匹配的 argument_bindings",
      "方法：如 step_plan 中包含 CANB 通道步骤（双冗余需求），为CANA和CANB各生成对应步骤",
      "CAN总线操作格式：『第{time}秒,通过CANA总线发送{协议名称}』或对应的 CANB 形式",
      "总线收发类功能需求（收到指令X→发送/返回Y）按接口模式：每条指令×每条接收总线（CANA/CANB）独立成用例；用例内正确与错误交替注入，每个错误后必配恢复",
      "总线接收类功能需求必须读取协议格式表：识别包数/帧数并覆盖全部字段；仲裁场与控制场分开，单帧轮询逐字段/字节，多帧按首/中/尾代表帧覆盖（2帧仅首/尾）",
      "有序多包含双辅助数据包：正确包1至n完整推进，错误覆盖由全部包分摊；末包之前补齐剩余单字段错误，以正确末包收尾；错误耗尽后剩余包连续正确发送，正确计数仅在正确包递增",
      "内存读出指令的非4字节对齐地址直接按错误指令处理，地址区间覆盖七点边界法（窄区间去重）",
      "内存数据轮询先于3.0s启动5s周期内存读出指令，再于5.0/10.0/15.0s…执行轮询步骤",
      "功能测试按功能点划分用例：每个独立功能点一个用例；总线收发类需求每条指令×每条接收总线独立成用例，用例内正确与错误交替注入",
      "步骤描述以中文句号结尾",
    ],
    expected_result_composition_rules: [
      "预期结果优先列出软件的整体行为，再列出具体字段值",
      "字段级断言格式：『第{time}秒，{数据类别}_{字段名} = {值}』",
      "间接指令应答帧格式：『软件接收到正确的间接指令后返回间接指令应答帧：{hex_bytes}』",
      "内存检查格式：『第{time}秒,内存地址{addr}的数据为{value}』",
      "周期性输出描述格式：『软件每秒发送一次{数据类型}，其中{具体内容描述}』",
      "数值使用十六进制（0x前缀）表示，特殊值使用十进制",
      "字段值需与协议 DOCX 中对应表格的定义一致",
      "预期结果以中文句号结尾",
    ],
    initial_settings_rules: [
      "CAN总线初始化必须设置帧间隔，分别配置输出和输入方向",
      "双总线（A+B）场景需分别配置A、B总线的帧间隔",
      "需按固定顺序周期性发送轮询指令启动各个遥测采集通道",
      "轮询指令发送顺序：速变遥测轮询→缓变遥测轮询→下泄遥测轮询→星务时间广播→姿控姿态广播→前向短报文遥控数据轮询",
      "每个轮询指令需指定总线（CANA/CANB）和总线ID",
      "当需求涉及间接指令时，initial_settings 中需包含所有前置轮询指令的发送",
      "CANA 和 CANB 的寄存器值和其他特殊配置可在 initial_settings 中按需设置",
    ],
    type_specific_guidance: {
      "功能测试": "按功能点划分用例：每个独立功能点一个用例（不设上限）。总线收发类需求每条指令×每条接收总线独立成用例；从格式表识别包数、帧数和全部字段，多帧按首/中/尾代表帧覆盖。有序多包含双辅助数据包统一按正确包1至n推进并分摊错误，剩余错误置于正确末包前，错误耗尽则连续发送剩余正确包。预期写软件可观察响应与计数绝对值。初始设置包含必要总线初始化。",
      "性能测试": "环境固定为硬平台测试环境，人工使用示波器多次测试需求指定的时间指标；预期直接陈述指标约束，不翻译关键字，不进入 DTP/Robot。",
      "可靠性安全性测试": "采用功能测试式的操作与预期结果覆盖需求明确的可靠性安全性处理；故障注入、保护和恢复仅在需求规定时设计，不自行扩展。",
      "余量测试": "环境固定为人工分析，步骤采用查看资源量使用文件，确认需求指定的余量内容；预期给出需求规定的容量/比例约束，不翻译关键字，不进入 DTP/Robot。",
      "边界测试": "覆盖下边界-1/下边界/下边界+1/中间值/上边界-1/上边界/上边界+1，重合值去重，依据需求判定有效性。",
      "强度测试": "一条需求只能生成一个长时间运行综合用例，覆盖全部综合性功能；按同一时间原点连续编排，周期输入只声明一次，不按指令或总线拆例。",
    },
    keyword_priority: {
      "发送CANA数据": 10,
      "发送CANB数据": 10,
      "设置CANA总线帧间隔": 8,
      "设置CANB总线帧间隔": 8,
      "设置32位地址数据": 7,
      "发送CE0遥测数据_数据池": 9,
      "发送CE2_遥测数据_数据池": 9,
      "发送CE3_配置管理FPGA遥测_数据池": 9,
      "发送CE2_前向短报文遥测数据_数据池": 8,
      "设置数据池数据": 6,
      "读取数据池数据": 5,
      "触发外部中断": 7,
      "循环发送CANA指令": 6,
      "循环发送CANB指令": 6,
      "设置CANA寄存器值": 5,
      "设置CANB寄存器值": 5,
      "设置8位地址数据": 4,
      "设置16位数据至32位地址": 4,
      "设置8位数据至32位地址": 4,
      "设置32位地址bit数据": 4,
      "设置寄存器数据": 4,
    },
    protocol_field_priority: {
      "速变遥测": ["标志位", "状态位", "功放功率遥测", "前向短报文接收计数", "返向短报文发送计数", "前向报文捕获成功计数", "前向报文帧同步计数", "前向短报文多普勒频偏", "前向短报文载噪比", "前向短报文基带AGC"],
      "缓变遥测": ["W0", "W2", "W4", "W5", "W42", "W43", "W44", "W46", "W51", "W52", "W55", "W57", "A总线命令状态", "B总线命令状态", "A总线复位计数", "B总线复位计数", "上注状态遥测", "波束固定指向状态遥测", "中继星选星结果", "引入姿态角校正状态"],
      "下泄遥测": ["UTC时间", "半长轴a", "偏心率e", "轨道倾角i", "升交点赤经Ω", "近点幅角ω", "平近点角M"],
      "间接指令应答": ["65H 44H 15H FFH 20H 34H"],
      "内存地址关键位置": ["0x00400040", "0x00400020", "0x02000000"],
    },
  },
}

// ---------------------------------------------------------------------------
// Generation Guide — project-specific learned patterns
// ---------------------------------------------------------------------------

export interface Phase6GenerationGuide {
  generated_at: string
  example_source: string
  keyword_selection_rules: string[]
  protocol_field_mapping_rules: string[]
  step_composition_rules: string[]
  expected_result_composition_rules: string[]
  initial_settings_rules: string[]
  type_specific_guidance: Record<string, string>
  keyword_priority: Record<string, number>
  protocol_field_priority: Record<string, string[]>
}

export function loadGenerationGuide(
  projectDir: string,
  domain?: string,
): Phase6GenerationGuide | null {
  // 1. Try project-specific generation guide first
  const guidePath = join(projectDir, PHASE6_GENERATION_GUIDE)
  if (existsSync(guidePath)) {
    try {
      const raw = readFileSync(guidePath, "utf-8")
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === "object") return parsed as Phase6GenerationGuide
    } catch {
      // Fall through to domain defaults
    }
  }

  // 2. Fall back to built-in domain guide
  if (domain && BUILTIN_DOMAIN_GUIDES[domain]) {
    return BUILTIN_DOMAIN_GUIDES[domain]
  }

  // 3. Default to satellite-dsp domain
  return BUILTIN_DOMAIN_GUIDES["satellite-dsp"] ?? null
}

export function injectGenerationGuideIntoPrompt(
  basePrompt: string,
  guide: Phase6GenerationGuide,
  testTypeChinese: string | null,
): string {
  const typeGuidance = testTypeChinese
    ? Object.entries(guide.type_specific_guidance).find(([type]) => normalizePhase6TestType(type) === normalizePhase6TestType(testTypeChinese))?.[1]
    : null
  const guideSection = [
    "",
    "### 项目特有生成指南（从已有人工设计示例中学习）",
    "- 以下内容仅为领域补充知识，不得替换主提示词模板，不得覆盖 test-* 模板的测试类型范围、指令×总线用例粒度或当前需求的约束与参数；仅采用与当前需求相关且有证据支持的规则。",
    guide.step_composition_rules.length > 0
      ? `- 步骤组成规则：${guide.step_composition_rules.join("；")}`
      : "",
    guide.expected_result_composition_rules.length > 0
      ? `- 预期结果规则：${guide.expected_result_composition_rules.join("；")}`
      : "",
    guide.initial_settings_rules.length > 0
      ? `- 初始设置规则：${guide.initial_settings_rules.join("；")}`
      : "",
    guide.keyword_selection_rules.length > 0
      ? `- 关键字选择规则：${guide.keyword_selection_rules.join("；")}`
      : "",
    guide.protocol_field_mapping_rules.length > 0
      ? `- 协议字段映射规则：${guide.protocol_field_mapping_rules.join("；")}`
      : "",
    typeGuidance ? `- 当前类型专属指导：${typeGuidance}` : "",
  ]
    .filter(Boolean)
    .join("\n")

  // Insert guide section before the input info section
  const inputInfoMarker = "### 输入信息"
  if (basePrompt.includes(inputInfoMarker)) {
    return basePrompt.replace(inputInfoMarker, `${guideSection}\n\n${inputInfoMarker}`)
  }
  return `${basePrompt}\n${guideSection}`
}

/**
 * Format a test-*.md markdown prompt template by replacing placeholders.
 *
 * Supported placeholders（新命名与 flat 五字段输入 JSON 字段一致）:
 *   {title}              → requirement title / name
 *   {requirementContext} → requirement summary / context
 *   {inputFlowContext}   → input flow description
 *   {processingContext}  → processing logic
 *   {outputFlowContext}  → output flow description
 *   {constraintContext}  → test constraints
 *
 * Legacy placeholders（兼容旧自定义模板与内置 fallback 模板）:
 *   {tr_name} / {tr_summary} / {input_flow} / {tr_input_flow} /
 *   {tr_handling} / {tr_output_flow} / {tr_testConstraint}
 *
 * Any unmatched placeholder is replaced with "（无）".
 */
export function formatMarkdownPromptTemplate(
  templateBody: string,
  replacements: Record<string, string>,
): string {
  const resolved: Record<string, string> = {
    "{tr_id}":              replacements.tr_id ?? replacements.requirement_id ?? "",
    "{title}":              replacements.title ?? replacements.tr_name ?? replacements.name ?? "",
    "{requirementContext}": replacements.requirementContext ?? replacements.tr_summary ?? replacements.summary ?? "",
    "{inputFlowContext}":   replacements.inputFlowContext ?? replacements.input_flow ?? replacements.inputFlow ?? "",
    "{processingContext}":  replacements.processingContext ?? replacements.tr_handling ?? replacements.handling ?? "",
    "{outputFlowContext}":  replacements.outputFlowContext ?? replacements.tr_output_flow ?? replacements.outputFlow ?? "",
    "{constraintContext}":  replacements.constraintContext ?? replacements.tr_testConstraint ?? replacements.testConstraint ?? "",
    "{tr_name}":            replacements.tr_name ?? replacements.name ?? replacements.title ?? "",
    "{tr_summary}":         replacements.tr_summary ?? replacements.summary ?? replacements.requirementContext ?? "",
    "{input_flow}":         replacements.input_flow ?? replacements.inputFlow ?? replacements.inputFlowContext ?? "",
    "{tr_input_flow}":      replacements.tr_input_flow ?? replacements.inputFlow ?? replacements.inputFlowContext ?? "",
    "{tr_handling}":        replacements.tr_handling ?? replacements.handling ?? replacements.processingContext ?? "",
    "{tr_output_flow}":     replacements.tr_output_flow ?? replacements.outputFlow ?? replacements.outputFlowContext ?? "",
    "{tr_testConstraint}":  replacements.tr_testConstraint ?? replacements.testConstraint ?? replacements.constraintContext ?? "",
  }

  let result = templateBody
  for (const [placeholder, value] of Object.entries(resolved)) {
    result = result.split(placeholder).join(value || "（无）")
  }
  return result
}

// ---------------------------------------------------------------------------
// 接口类型专属规则分节(2026-08-25 用户需求:按需加载,避免全量接口经验
// 挤占上下文并干扰目标接口生成)
// ---------------------------------------------------------------------------
// test-interface.md 只保留通用章节与 {{INTERFACE_SECTIONS}} 占位标记;接口
// 专属章节拆分到 catalog 目录下 interface-sections/<type>.md,构建 item.prompt
// 时按需求上下文确定性检测涉及的接口类型,只拼接相关分节。worker 零改动,
// 不相关接口的知识不进入生成上下文。

export const INTERFACE_SECTIONS_MARKER = "{{INTERFACE_SECTIONS}}"

const INTERFACE_SECTION_FILES: Record<string, string> = {
  "primary-can": "primary-can.md",
  "secondary-bus": "secondary-bus.md",
  "secondary-bus-switch": "secondary-bus-switch.md",
  "spi-bus": "spi-bus.md",
  "spacewire": "spacewire.md",
  "second-pulse": "second-pulse.md",
  "imaging-control": "imaging-control.md",
  "fpga-telemetry": "fpga-telemetry.md",
  "hardware-watchdog": "hardware-watchdog.md",
  "other-interface": "other-interface.md",
  "ordered-upload": "ordered-upload.md",
}

/**
 * 检测需求上下文涉及的接口类型。
 * - 一级 CAN 规则是本工程指令/遥测交互的公共底座(二级总线的触发也经一级
 *   发送,应答同为 CAN 帧格式),故显式 CAN 信号或"什么都没检出"时保守注入
 *   (与拆分前全量模板行为一致,不回归)。
 * - 二级总线仅在上下文显式提及时注入。
 * 未来新增接口类型(spi/fpga...)在此登记文件名并给检出关键词。
 */
export function detectInterfaceSectionTypes(corpus: string): string[] {
  // 一级CAN 帧规则恒注入:本工程指令/遥测交互的公共底座——二级总线的触发
  // 经一级发送、应答同为 CAN 帧格式;显式 CAN 信号之外的保守默认(与拆分
  // 前全量模板行为一致,不回归)。
  const types: string[] = ["primary-can"]
  if (/有序多包|多包数据|249字节上行|辅助数据包\s*[1一][\s\S]*辅助数据包\s*[2二]/.test(corpus)) types.push("ordered-upload")
  const isSecondary = /二级\s*(?:CAN)?总线|二级CAN/.test(corpus)
  if (isSecondary) types.push("secondary-bus")
  // 二级总线自动切换(连续N次未收到正确→切换)专属模型:仅在切换语义出现
  // 时注入(2026-08-26 用户拍板经验固化,依赖 secondary-bus 底座先行注入;
  // 广播A、B交替发送是另一场景,不触发本节)
  if (isSecondary && /(自动切换|连续\s*\d+\s*次[^,，。;；]{0,12}未收到|切换总线)/.test(corpus)) {
    types.push("secondary-bus-switch")
  }
  // SPI总线(软件↔内部单板)二级总线模型:SPI 同为二级总线(指令/轮询经 SPI
  // 下发单板,应答/遥测由测试系统模拟),但语料只写"SPI总线"不写"二级总线"
  // ——曾因此拿不到二级模型,生成出无应答交替/轮询方向写反的用例
  // (2026-08-27 用户拍板:SPI 与二级CAN同构,一级触发+SPI模拟应答交替)。
  // 双条件防误伤:须有"SPI总线"字样 + 板间通信语义词("SPI接口"监视寄存器
  // 类需求不触发)
  if (/SPI总线/.test(corpus) && /(应答|轮询|遥测|单板|切换)/.test(corpus)) {
    types.push("spi-bus")
  }
  // Spacewire 总线(软件↔星务上注)模型:上注数据块经"写协议数据→写ID→触发
  // 中断"三步交付(2026-09-02 用户拍板)。双条件防误伤:须有 spacewire 字样
  // + 上注/数据块/中断语义词(仅提 Spacewire 复位/监视类需求不触发本节)
  if (/spacewire/i.test(corpus) && /(上注|数据块|外部中断)/.test(corpus)) {
    types.push("spacewire")
  }
  // 秒脉冲接口(软件↔FPGA 转发)模型:数据流定义的地址属于输出流(软件输出
  // 切换方式的监视地址),测试模型是一级总线遥控指令收发+正确错误交替
  // (2026-09-02 用户拍板)。必须出现"秒脉冲…切换指令"的指令语义——
  // 仅"监视…秒脉冲切换方式"类语料(SPI 监视需求)不触发本节
  if (/秒脉冲[^,，。;；\n]{0,6}切换指令|秒脉冲信号切换指令/.test(corpus)) {
    types.push("second-pulse")
  }
  // 成像控制接口(软件↔FPGA 转发)模型:与秒脉冲同构(2026-09-08 用户拍板)
  // ——输出流地址+一级遥控指令收发。检测词取 TC-011 独有短语:
  // "转发成像控制信号指令"/"输出流:成像控制信号"(一级CAN组的遥控指令
  // 数据流表也含"成像控制信号指令"字样,单短语会误触发)
  if (/转发成像控制信号指令|输出流[：:]成像控制信号/.test(corpus)) {
    types.push("imaging-control")
  }
  // FPGA状态遥测接口(软件采集FPGA状态)模型:地址表方向为输入——写内存模拟
  // FPGA状态数据+遥测轮询验证位域映射(2026-09-08 用户拍板)。双条件:须有
  // FPGA状态遥测 + 地址/输入字样(泛提"采集FPGA状态遥测"的语料不触发)
  if (/FPGA状态遥测/.test(corpus) && /(地址|输入)/.test(corpus)) {
    types.push("fpga-telemetry")
  }
  // 硬件狗(看门狗)接口:用例形态固定(示波器实测清狗间隔,硬平台环境)
  // (2026-09-08 用户拍板)
  if (/硬件狗|看门狗|喂狗/.test(corpus)) {
    types.push("hardware-watchdog")
  }
  // 其它(其他)接口兜底:需求归不进具体接口类,但数据流呈"收到某遥控指令→
  // 通过PIO口输出脉冲/信号"形态时,按一级遥控指令收发模型处理
  // (2026-09-08 用户拍板,与秒脉冲/成像控制同构)。语义门三条件,防将来
  // 异形态的"其他接口"需求误入
  if (/(其他接口|其它接口)/.test(corpus) && /指令/.test(corpus) && /(PIO|脉冲)/.test(corpus)) {
    types.push("other-interface")
  }
  return types
}

export function injectInterfaceSections(
  prompt: string,
  options: { corpus: string; catalogDir: string; sectionTypes?: string[] },
): { prompt: string; injected_sections: string[]; warnings: string[] } {
  const warnings: string[] = []
  if (!prompt.includes(INTERFACE_SECTIONS_MARKER)) {
    // 自定义模板未放置标记:不做注入(兼容既有目录)
    return { prompt, injected_sections: [], warnings }
  }
  const detected = options.sectionTypes ?? detectInterfaceSectionTypes(options.corpus)
  const sections: string[] = []
  const injected: string[] = []
  for (const type of detected) {
    const file = INTERFACE_SECTION_FILES[type]
    if (!file) continue
    const path = join(options.catalogDir, "interface-sections", file)
    if (!existsSync(path)) {
      warnings.push(`接口分节文件缺失:${path}(已跳过 ${type} 分节)`)
      continue
    }
    sections.push(readFileSync(path, "utf-8").trim())
    injected.push(type)
  }
  const replacement = sections.length > 0 ? sections.join("\n\n") : ""
  const next = replacement
    ? prompt.replace(INTERFACE_SECTIONS_MARKER, replacement)
    : prompt.split(`\n${INTERFACE_SECTIONS_MARKER}`).join("").split(INTERFACE_SECTIONS_MARKER).join("")
  return { prompt: next, injected_sections: injected, warnings }
}
