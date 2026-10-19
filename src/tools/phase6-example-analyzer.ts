import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import {
  loadTestRequirementFile,
  splitFunIds,
  type PreparedPhase6Input,
  type PreparedPhase6Requirement,
  preparePhase6Input,
} from "../shared/test-requirements"
import {
  scanKeywordDirs,
  type KeywordMeta,
} from "../shared/testcase-keywords"
import {
  parseProtocolSemanticDocx,
  persistProtocolSemanticDocument,
  type ProtocolSemanticDocument,
} from "../shared/protocol-semantics"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ExampleAnalysisResult {
  example_source_paths: {
    test_requirements: string
    keyword_dir: string
    protocol_docx: string
    reference_tests: string
  }
  keyword_libraries: string[]
  keyword_count: number
  protocol_tables: number
  protocol_fields: number
  requirement_count: number
  test_case_count: number
  pairings: RequirementTestCasePairing[]
  keyword_usage_summary: Record<string, string[]>
  protocol_field_usage_summary: Record<string, string[]>
  step_composition_patterns: StepPattern[]
  expected_result_patterns: ExpectedResultPattern[]
  initial_settings_patterns: InitialSettingsPattern[]
  composite_keyword_hierarchy: CompositeKeywordInfo[]
}

interface RequirementTestCasePairing {
  requirement_id: string
  case_ids: string[]
  test_type: string
  chapter_title: string
  handling: string
  input_flow: string | null
  output_flow: string | null
  matched_keywords: string[]
  referenced_protocol_fields: string[]
  step_count_total: number
  use_cana: boolean
  use_canb: boolean
}

interface StepPattern {
  pattern_type: string
  template: string
  frequency: number
  example_steps: string[]
  used_keywords: string[]
}

interface ExpectedResultPattern {
  pattern_type: string
  template: string
  frequency: number
  example_results: string[]
  field_names: string[]
}

interface InitialSettingsPattern {
  pattern_type: string
  settings_text: string
  frequency: number
  matches_requirements: string[]
}

interface CompositeKeywordInfo {
  library_name: string
  keyword_name: string
  description: string
  argument_count: number
  underlying_calls: string[]
}

// ---------------------------------------------------------------------------
// Analysis helpers
// ---------------------------------------------------------------------------

interface ReferenceTestCase {
  case_id: string
  case_name: string
  test_type: string
  correspond_fun_id: string
  test_purpose: string
  constraints: string
  initial_settings: string
  test_step: Array<{ "步骤描述": string; "预期结果": string }>
}

interface ReferenceTestSuite {
  test_cases: ReferenceTestCase[]
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback
}

function loadReferenceSuite(filePath: string): ReferenceTestSuite {
  const raw = readFileSync(filePath, "utf-8")
  const parsed = JSON.parse(raw)
  const cases = Array.isArray(parsed.test_cases) ? parsed.test_cases : (Array.isArray(parsed) ? parsed : [])
  return { test_cases: cases }
}

function matchKeywordInText(text: string, keywords: Map<string, KeywordMeta>): string[] {
  const matched: string[] = []
  for (const [name] of keywords) {
    if (text.includes(name)) {
      matched.push(name)
    }
  }
  return matched
}

function extractProtocolFieldsFromText(text: string, protocolFields: string[]): string[] {
  const matched: string[] = []
  for (const field of protocolFields) {
    if (text.includes(field)) {
      matched.push(field)
    }
  }
  return matched
}

function detectBusUsage(text: string): { cana: boolean; canb: boolean } {
  return {
    cana: /CANA|总线A/.test(text),
    canb: /CANB|总线B/.test(text),
  }
}

function collectProtocolFieldNames(doc: ProtocolSemanticDocument): string[] {
  const fields = new Set<string>()
  for (const table of doc.tables) {
    for (const row of table.rows) {
      for (const header of table.headers) {
        const value = row[header]
        if (value && value.length > 0 && value.length < 120) {
          fields.add(value.trim())
        }
      }
    }
  }
  for (const para of doc.paragraphs) {
    const split = para.split(/[:：]/)
    if (split.length === 2) {
      const key = split[0].trim()
      if (key.length > 0 && key.length < 64) {
        fields.add(key)
      }
    }
  }
  return [...fields]
}

function classifyStepPattern(stepDesc: string): string {
  if (/^(启动测试环境，)?第[\d.]+秒,?通过CANA总线\d*\s*发送/.test(stepDesc)) return "cana_send"
  if (/^(启动测试环境，)?第[\d.]+秒,?通过CANB总线\d*\s*发送/.test(stepDesc)) return "canb_send"
  if (/^(启动测试环境，)?第[\d.]+秒,?通过CANA总线\d*\s*/.test(stepDesc)) return "cana_operation"
  if (/^(启动测试环境，)?第[\d.]+秒,?通过CANB总线\d*\s*/.test(stepDesc)) return "canb_operation"
  if (/^第[\d.]+秒，发送/.test(stepDesc)) return "send_data"
  if (/^第[\d.]+秒，设置/.test(stepDesc)) return "set_value"
  if (/启动测试环境/.test(stepDesc)) return "env_init"
  return "other"
}

function classifyResultPattern(resultText: string): string {
  if (/软件正确输出/.test(resultText) && /。第[\d.]+秒/.test(resultText)) return "output_verify_with_timing"
  if (/软件接收到正确的间接指令后返回间接指令应答帧/.test(resultText)) return "indirect_cmd_response"
  if (/软件\d+s后输出/.test(resultText)) return "output_timing"
  if (/软件每秒发送一次/.test(resultText)) return "periodic_output"
  if (/^第[\d.]+秒/.test(resultText)) return "field_level_assertion"
  if (/内存地址0x/.test(resultText)) return "memory_assertion"
  return "general"
}

function collectCompositeKeywords(keywordMap: Map<string, KeywordMeta>): CompositeKeywordInfo[] {
  const composites: CompositeKeywordInfo[] = []
  for (const [name, meta] of keywordMap) {
    const snippet = meta.txtSnippet || ""
    const underlyingCalls: string[] = []
    const kwRegex = /VTest_SendCmd|VTest_WaitToTime|DataPool_/g
    let m: RegExpExecArray | null
    while ((m = kwRegex.exec(snippet)) !== null) {
      underlyingCalls.push(m[0])
    }

    if (underlyingCalls.length > 0) {
      composites.push({
        library_name: meta.sourceJson.split("/").pop()?.replace(".json", "") || "unknown",
        keyword_name: name,
        description: meta.description,
        argument_count: meta.argumentNames.length,
        underlying_calls: [...new Set(underlyingCalls)],
      })
    }
  }
  return composites
}

// ---------------------------------------------------------------------------
// Tool implementation
// ---------------------------------------------------------------------------

export const phase6ExampleAnalyze: ToolDefinition = tool({
  description:
    "分析已有测试用例设计示例，提取关键字使用模式、协议字段映射、步骤组合模式和预期结果模式。" +
    "输入：1) test-requirements.json 路径 2) 组合关键字目录路径 3) 数据协议 DOCX 路径 4) 参考 confirmation-tests.json 路径。" +
    "输出：生成 phase6-example-analysis.json 到 .matrix/data/ 目录。",
  args: {
    test_requirements_file: tool.schema
      .string()
      .describe("test-requirements.json 文件的路径"),
    keyword_dir: tool.schema
      .string()
      .describe("组合关键字目录的路径"),
    protocol_docx_file: tool.schema
      .string()
      .describe("第三方测试需求 DOCX 文件的路径"),
    reference_tests_file: tool.schema
      .string()
      .describe("参考 confirmation-tests.json 文件的路径"),
    project_dir: tool.schema
      .string()
      .describe("项目根目录，用于确定 .matrix/data/ 输出位置"),
  },
  async execute(args, _ctx) {
    const testRequirementsFile = asString(args.test_requirements_file)
    const keywordDir = asString(args.keyword_dir)
    const protocolDocxFile = asString(args.protocol_docx_file)
    const referenceTestsFile = asString(args.reference_tests_file)
    const projectDir = asString(args.project_dir)

    // Validate inputs
    const errors: string[] = []
    if (!existsSync(testRequirementsFile)) errors.push(`test-requirements.json 不存在: ${testRequirementsFile}`)
    if (!existsSync(keywordDir)) errors.push(`关键字目录不存在: ${keywordDir}`)
    if (!existsSync(protocolDocxFile)) errors.push(`协议 DOCX 不存在: ${protocolDocxFile}`)
    if (!existsSync(referenceTestsFile)) errors.push(`参考测试用例文件不存在: ${referenceTestsFile}`)

    if (errors.length > 0) {
      return JSON.stringify({ status: "error", errors })
    }

    // Load all artifacts
    const treeArtifact = loadTestRequirementFile(testRequirementsFile)
    const preparedInput: PreparedPhase6Input = preparePhase6Input(treeArtifact)

    const keywordCatalog = scanKeywordDirs([keywordDir])
    const referenceSuite = loadReferenceSuite(referenceTestsFile)

    const protocolDoc = await parseProtocolSemanticDocx(protocolDocxFile)
    persistProtocolSemanticDocument(projectDir, protocolDoc, "example-analysis")

    const protocolFieldNames = collectProtocolFieldNames(protocolDoc)

    // Build requirement index
    const reqIndex = new Map<string, PreparedPhase6Requirement>()
    for (const req of preparedInput.requirements) {
      reqIndex.set(req.requirement_id, req)
    }

    // Pair test cases with requirements
    const pairings: RequirementTestCasePairing[] = []
    const keywordUsageSummary: Record<string, string[]> = {}
    const protocolFieldUsageSummary: Record<string, string[]> = {}
    const stepPatternCounts = new Map<string, { count: number; examples: string[]; keywords: Set<string> }>()
    const resultPatternCounts = new Map<string, { count: number; examples: string[]; fieldNames: Set<string> }>()
    const settingsPatternCounts = new Map<string, { count: number; matches: string[] }>()

    for (const refCase of referenceSuite.test_cases) {
      const funId = refCase.correspond_fun_id
      // correspond_fun_id may be 、-separated multi-ID — try exact (joined) match first,
      // then fall back to first individual ID.
      const req = reqIndex.get(funId)
        ?? reqIndex.get(splitFunIds(funId)[0] ?? "")

      const allStepDescs = refCase.test_step.map(s => s["步骤描述"]).filter(Boolean)
      const allExpectedResults = refCase.test_step.map(s => s["预期结果"]).filter(Boolean)
      const allStepText = [...allStepDescs, ...allExpectedResults, refCase.initial_settings].join(" ")

      const matchedKeywords = matchKeywordInText(allStepText, keywordCatalog.keywordMap)
      const referencedFields = extractProtocolFieldsFromText(allStepText, protocolFieldNames)
      const busUsage = detectBusUsage(allStepText)

      // Record step patterns
      for (const desc of allStepDescs) {
        const patternType = classifyStepPattern(desc)
        const existing = stepPatternCounts.get(patternType)
        if (existing) {
          existing.count++
          if (existing.examples.length < 3) existing.examples.push(desc)
          matchedKeywords.forEach(k => existing.keywords.add(k))
        } else {
          stepPatternCounts.set(patternType, {
            count: 1,
            examples: [desc],
            keywords: new Set(matchedKeywords),
          })
        }
      }

      // Record expected result patterns
      for (const result of allExpectedResults) {
        const patternType = classifyResultPattern(result)
        const existing = resultPatternCounts.get(patternType)
        if (existing) {
          existing.count++
          if (existing.examples.length < 3) existing.examples.push(result)
          referencedFields.forEach(f => existing.fieldNames.add(f))
        } else {
          resultPatternCounts.set(patternType, {
            count: 1,
            examples: [result],
            fieldNames: new Set(referencedFields),
          })
        }
      }

      // Record initial settings patterns
      if (refCase.initial_settings && refCase.initial_settings.trim().length > 0) {
        const settingsKey = refCase.initial_settings.slice(0, 60)
        const existing = settingsPatternCounts.get(settingsKey)
        if (existing) {
          existing.count++
          existing.matches.push(funId)
        } else {
          settingsPatternCounts.set(settingsKey, { count: 1, matches: [funId] })
        }
      }

      // Update keyword usage summary
      const reqType = refCase.test_type
      if (!keywordUsageSummary[reqType]) keywordUsageSummary[reqType] = []
      for (const kw of matchedKeywords) {
        if (!keywordUsageSummary[reqType].includes(kw)) {
          keywordUsageSummary[reqType].push(kw)
        }
      }

      // Update protocol field usage summary
      if (!protocolFieldUsageSummary[reqType]) protocolFieldUsageSummary[reqType] = []
      for (const field of referencedFields) {
        if (!protocolFieldUsageSummary[reqType].includes(field)) {
          protocolFieldUsageSummary[reqType].push(field)
        }
      }

      // Find existing pairing or create new one
      let pairing = pairings.find(p => p.requirement_id === funId)
      if (!pairing) {
        pairing = {
          requirement_id: funId,
          case_ids: [],
          test_type: refCase.test_type,
          chapter_title: req?.chapter_title || "",
          handling: req?.handling || "",
          input_flow: req?.inputFlow || null,
          output_flow: req?.outputFlow || null,
          matched_keywords: [],
          referenced_protocol_fields: [],
          step_count_total: 0,
          use_cana: false,
          use_canb: false,
        }
        pairings.push(pairing)
      }

      if (!pairing.case_ids.includes(refCase.case_id)) {
        pairing.case_ids.push(refCase.case_id)
      }
      pairing.step_count_total += refCase.test_step.length
      pairing.use_cana = pairing.use_cana || busUsage.cana
      pairing.use_canb = pairing.use_canb || busUsage.canb

      for (const kw of matchedKeywords) {
        if (!pairing.matched_keywords.includes(kw)) pairing.matched_keywords.push(kw)
      }
      for (const field of referencedFields) {
        if (!pairing.referenced_protocol_fields.includes(field)) pairing.referenced_protocol_fields.push(field)
      }
    }

    // Build final step patterns
    const stepPatterns: StepPattern[] = [...stepPatternCounts.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .map(([type, data]) => ({
        pattern_type: type,
        template: data.examples[0] || "",
        frequency: data.count,
        example_steps: data.examples,
        used_keywords: [...data.keywords],
      }))

    // Build final result patterns
    const expectedResultPatterns: ExpectedResultPattern[] = [...resultPatternCounts.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .map(([type, data]) => ({
        pattern_type: type,
        template: data.examples[0] || "",
        frequency: data.count,
        example_results: data.examples,
        field_names: [...data.fieldNames],
      }))

    // Build initial settings patterns
    const initialSettingsPatterns: InitialSettingsPattern[] = [...settingsPatternCounts.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .map(([key, data]) => ({
        pattern_type: key.length > 20 ? "detailed_config" : "simple_config",
        settings_text: key,
        frequency: data.count,
        matches_requirements: data.matches,
      }))

    const compositeKeywords = collectCompositeKeywords(keywordCatalog.keywordMap)

    const result: ExampleAnalysisResult = {
      example_source_paths: {
        test_requirements: testRequirementsFile,
        keyword_dir: keywordDir,
        protocol_docx: protocolDocxFile,
        reference_tests: referenceTestsFile,
      },
      keyword_libraries: keywordCatalog.scannedDirs.flatMap(dir => {
        return readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isFile() && e.name.endsWith(".json"))
          .map((e) => e.name.replace(".json", ""))
      }),
      keyword_count: keywordCatalog.keywordMap.size,
      protocol_tables: protocolDoc.tables.length,
      protocol_fields: protocolFieldNames.length,
      requirement_count: preparedInput.requirements.length,
      test_case_count: referenceSuite.test_cases.length,
      pairings,
      keyword_usage_summary: keywordUsageSummary,
      protocol_field_usage_summary: protocolFieldUsageSummary,
      step_composition_patterns: stepPatterns,
      expected_result_patterns: expectedResultPatterns,
      initial_settings_patterns: initialSettingsPatterns,
      composite_keyword_hierarchy: compositeKeywords,
    }

    // Persist the analysis result
    const outputDir = join(projectDir, ".matrix", "data")
    mkdirSync(outputDir, { recursive: true })
    const outputPath = join(outputDir, "phase6-example-analysis.json")
    writeFileSync(outputPath, JSON.stringify(result, null, 2), "utf-8")

    return JSON.stringify({
      status: "ok",
      output_file: outputPath,
      summary: {
        pairings_count: pairings.length,
        keyword_libraries_count: result.keyword_libraries.length,
        keyword_count: result.keyword_count,
        composite_keywords_count: compositeKeywords.length,
        protocol_tables: protocolDoc.tables.length,
        protocol_fields: protocolFieldNames.length,
        step_patterns: stepPatterns.map(p => `${p.pattern_type}(${p.frequency})`),
        result_patterns: expectedResultPatterns.map(p => `${p.pattern_type}(${p.frequency})`),
        top_keywords_by_type: Object.fromEntries(
          Object.entries(keywordUsageSummary).map(([type, kws]) => [type, kws.slice(0, 5)]),
        ),
      },
    })
  },
}) satisfies ToolDefinition
