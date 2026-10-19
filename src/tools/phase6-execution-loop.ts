import { tool, type ToolContext, type ToolDefinition } from "@opencode-ai/plugin"
import type { OpencodeClient } from "@opencode-ai/sdk/client"
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs"
import { dirname, isAbsolute, join } from "path"
import type { z } from "zod"
import { loadPluginConfig } from "../plugin-config"
import {
  SourceConfirmationTestCase,
  SourceConfirmationTestSuite,
  TranslatedConfirmationTestSuite,
  ensureUnifiedSteps,
  extractTranslatedStepsFromUnified,
  type SourceConfirmationTestSuite as SourceConfirmationTestSuiteType,
} from "../schema/confirmation-test-case"
import { TestExecutionReport } from "../schema/test-execution"
import {
  Phase6ExecutionLoopArtifact,
  type Phase6CoverageTarget,
  type Phase6ExecutionLoopRound,
} from "../schema/phase6-execution-loop"
import { ARTIFACT_PATHS, REPORT_PATHS } from "../shared/constants"
import {
  writePhase6TestCasesTodoFile,
  writePhase6TestCasesTodoFromSuite,
} from "../shared/phase6-todo"
import { createDtpRobotGenerator } from "./dtp-robot-generator"
import {
  collectDtpCaseProtocolQueries,
  createDtpDataModelHooks,
  ensureDtpProtocolDefinitions,
  normalizeDocsContext,
  resolveDefaultPaths,
  runDtpCaseDataInstantiation,
  type DtpKnowledgeMode,
} from "./dtp-data-generation-core"
import {
  executeDtpProject,
  type DtpExecutorOptions,
} from "./dtp-executor"
import {
  parseOutputXml,
  type RobotOutputTestResult,
  type RobotTestStatus,
} from "./robot-executor"
import { docGenerator } from "./doc-generator"
type JsonRecord = Record<string, unknown>
type CoverageMetrics = Partial<Record<Phase6CoverageTarget, number>>
type Phase6ResultSource = "test_summary_json" | "output_xml"

export interface Phase6FailedCaseInfo {
  case_id: string
  status: "FAIL"
  message: string
  error_message?: unknown
}

export interface Phase6CaseOptimizationResult {
  sourceSuite: SourceConfirmationTestSuiteType
  changedCaseIds: string[]
  warnings?: string[]
}

export interface Phase6ExecutionLoopOptions {
  source_suite_file?: string
  translated_suite_file?: string
  todo_file?: string
  dtp_root?: string
  knowledge_mode?: DtpKnowledgeMode
  pass_rate_threshold?: number
  coverage_target?: Phase6CoverageTarget
  coverage_threshold?: number
  max_optimization_rounds?: number
}

export interface Phase6ExecutionLoopDeps {
  executeDtp?: (options: DtpExecutorOptions) => Promise<JsonRecord>
  regenerateRobot?: (workspaceRoot: string, ctx?: ToolContext) => Promise<JsonRecord[]>
  optimizeCases?: (
    workspaceRoot: string,
    sourceSuite: SourceConfirmationTestSuiteType,
    analysis: RoundAnalysis,
    ctx?: ToolContext,
  ) => Promise<Phase6CaseOptimizationResult>
  now?: () => Date
}

export interface RoundAnalysis {
  reportsDir: string
  resultSource: Phase6ResultSource
  summaryFile?: string
  outputXml: string
  total: number
  passed: number
  failed: number
  skipped: number
  passRate: number
  robotTests: RobotOutputTestResult[]
  failedCases: Phase6FailedCaseInfo[]
  coverage: {
    file?: string
    metrics: CoverageMetrics
    missing: boolean
    warnings: string[]
  }
}

function getToolBaseDirectory(ctx?: ToolContext): string {
  const candidates = [ctx?.directory, ctx?.worktree, process.cwd()]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
  return candidates[0] || process.cwd()
}

function resolveProjectPath(projectDir: string, supplied: string | undefined, fallback: string): string {
  if (!supplied) return join(projectDir, fallback)
  return isAbsolute(supplied) ? supplied : join(projectDir, supplied)
}

function ensureDir(filePath: string): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"))
}

function writeJsonFile(path: string, value: unknown): void {
  ensureDir(path)
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8")
}

function roundPercentage(value: number): number {
  return Math.round(value * 10) / 10
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, roundPercentage(value)))
}

function coerceCoveragePercent(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return clampPercent(value > 0 && value <= 1 ? value * 100 : value)
  }
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const numeric = Number(trimmed.replace("%", ""))
  if (!Number.isFinite(numeric)) return null
  return clampPercent(numeric > 0 && numeric <= 1 && trimmed.includes(".") ? numeric * 100 : numeric)
}

function coerceExecutionPercent(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return clampPercent(value > 0 && value <= 1 ? value * 100 : value)
  }
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const numeric = Number(trimmed.replace("%", ""))
  if (!Number.isFinite(numeric)) return null
  return clampPercent(numeric > 0 && numeric <= 1 && !trimmed.includes("%") ? numeric * 100 : numeric)
}

function inferCoverageMetric(pathKey: string): Phase6CoverageTarget | null {
  const key = pathKey.toLowerCase().replace(/[\s_%\-./\\]/g, "")
  if (key.includes("mcdc") || key.includes("判定条件") || key.includes("修正条件")) return "mc_dc"
  if (key.includes("statement") || key.includes("linecoverage") || key.includes("语句") || key.includes("行覆盖")) return "statement"
  if (key.includes("branch") || key.includes("decision") || key.includes("分支") || key.includes("判定")) return "branch"
  if (key.includes("condition") || key.includes("条件")) return "condition"
  if (key.includes("path") || key.includes("路径")) return "path"
  return null
}

function isCoveragePercentField(path: string[]): boolean {
  const last = (path[path.length - 1] ?? "").toLowerCase().replace(/[\s_%\-./\\]/g, "")
  if (!last) return false
  if (["percent", "percentage", "pct", "rate", "coverage"].includes(last)) return true
  return ["statement", "linecoverage", "branch", "decision", "mcdc", "condition", "path"].includes(last)
}

function collectCoverageMetrics(node: unknown, path: string[] = [], metrics: CoverageMetrics = {}): CoverageMetrics {
  if (!node || typeof node !== "object") return metrics
  if (Array.isArray(node)) {
    for (let index = 0; index < node.length; index += 1) {
      collectCoverageMetrics(node[index], [...path, String(index)], metrics)
    }
    return metrics
  }

  for (const [key, value] of Object.entries(node as JsonRecord)) {
    const nextPath = [...path, key]
    const metric = inferCoverageMetric(nextPath.join("_"))
    const percent = isCoveragePercentField(nextPath) ? coerceCoveragePercent(value) : null
    if (metric && percent !== null && metrics[metric] === undefined) {
      metrics[metric] = percent
    }
    if (value && typeof value === "object") {
      collectCoverageMetrics(value, nextPath, metrics)
    }
  }

  return metrics
}

function readNestedRecord(node: unknown, key: string): JsonRecord | null {
  if (!node || typeof node !== "object" || Array.isArray(node)) return null
  const value = (node as JsonRecord)[key]
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null
}

export function parseDtpCoverageData(data: unknown): CoverageMetrics {
  const metrics: CoverageMetrics = {}
  const totalCoverage = readNestedRecord(data, "total_coverage")

  if (totalCoverage) {
    for (const target of ["statement", "branch", "mc_dc", "condition", "path"] as const) {
      const exact = readNestedRecord(totalCoverage, target)
      const percent = exact ? coerceCoveragePercent(exact.percent) : null
      if (percent !== null) metrics[target] = percent
    }
  }

  return collectCoverageMetrics(data, [], metrics)
}

export function parseDtpCoverageDataFile(coverageFile: string): CoverageMetrics {
  return parseDtpCoverageData(readJsonFile(coverageFile))
}

function readCoverageMetrics(reportsDir: string): RoundAnalysis["coverage"] {
  const coverageFile = join(reportsDir, "coverage_report", "coverage_data.json")
  if (!existsSync(coverageFile)) {
    return {
      metrics: {},
      missing: true,
      warnings: [`覆盖率文件不存在：${coverageFile}`],
    }
  }

  try {
    return {
      file: coverageFile,
      metrics: parseDtpCoverageDataFile(coverageFile),
      missing: false,
      warnings: [],
    }
  } catch (error) {
    return {
      file: coverageFile,
      metrics: {},
      missing: true,
      warnings: [`覆盖率文件无法解析：${String(error)}`],
    }
  }
}

function normalizeRobotStats(parsed: ReturnType<typeof parseOutputXml>): {
  total: number
  passed: number
  failed: number
  skipped: number
} {
  if (parsed.total > 0) {
    return {
      total: parsed.total,
      passed: parsed.passed,
      failed: parsed.failed,
      skipped: parsed.skipped,
    }
  }

  const passed = parsed.tests.filter((item) => item.status === "PASS").length
  const failed = parsed.tests.filter((item) => item.status === "FAIL").length
  const skipped = parsed.tests.filter((item) => item.status === "SKIP" || item.status === "NOT RUN").length
  return {
    total: parsed.tests.length,
    passed,
    failed,
    skipped,
  }
}

function coerceInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.floor(value))
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value.trim())
    if (Number.isFinite(numeric)) return Math.max(0, Math.floor(numeric))
  }
  return null
}

function normalizeDtpTestStatus(value: unknown): RobotTestStatus {
  const status = String(value ?? "NOT RUN").trim().toUpperCase()
  if (status === "PASS" || status === "FAIL" || status === "SKIP" || status === "NOT RUN") return status
  return "NOT RUN"
}

function formatObjectValue(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function formatDtpErrorMessage(errorMessage: unknown): string {
  if (errorMessage === null || errorMessage === undefined || errorMessage === "") return ""
  if (typeof errorMessage === "string") return errorMessage
  if (!Array.isArray(errorMessage)) return formatObjectValue(errorMessage)

  return errorMessage
    .map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return formatObjectValue(item)
      }
      const record = item as JsonRecord
      const parts = [
        typeof record.keyword === "string" && record.keyword ? `keyword=${record.keyword}` : "",
        record.expect !== undefined ? `expect=${formatObjectValue(record.expect)}` : "",
        record.actual !== undefined ? `actual=${formatObjectValue(record.actual)}` : "",
        record.failmsg !== undefined ? `failmsg=${formatObjectValue(record.failmsg)}` : "",
        record.argments !== undefined ? `argments=${formatObjectValue(record.argments)}` : "",
        record.arguments !== undefined ? `arguments=${formatObjectValue(record.arguments)}` : "",
      ].filter(Boolean)
      return parts.length > 0 ? `${index + 1}. ${parts.join("; ")}` : `${index + 1}. ${formatObjectValue(item)}`
    })
    .filter(Boolean)
    .join("\n")
}

export interface DtpTestSummaryParseResult {
  total: number
  passed: number
  failed: number
  skipped: number
  passRate: number
  robotTests: RobotOutputTestResult[]
  failedCases: Phase6FailedCaseInfo[]
}

export function parseDtpTestSummary(data: unknown): DtpTestSummaryParseResult {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("test_summary.json 顶层必须是对象")
  }
  const record = data as JsonRecord
  const summary = readNestedRecord(record, "summary") ?? {}
  const rawCases = Array.isArray(record.test_cases) ? record.test_cases : []

  const robotTests: RobotOutputTestResult[] = []
  const failedCases: Phase6FailedCaseInfo[] = []

  for (const item of rawCases) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue
    const testCase = item as JsonRecord
    const name = String(testCase.name ?? "").trim()
    if (!name) continue
    const status = normalizeDtpTestStatus(testCase.status)
    const message = formatDtpErrorMessage(testCase.error_message)
    robotTests.push({ name, status, message })
    if (status === "FAIL") {
      failedCases.push({
        case_id: name,
        status: "FAIL",
        message: message || "DTP test_summary.json 显示该用例执行失败",
        ...(testCase.error_message !== undefined ? { error_message: testCase.error_message } : {}),
      })
    }
  }

  const countedPassed = robotTests.filter((item) => item.status === "PASS").length
  const countedFailed = robotTests.filter((item) => item.status === "FAIL").length
  const countedSkipped = robotTests.filter((item) => item.status === "SKIP" || item.status === "NOT RUN").length
  const total = coerceInteger(summary.total) ?? robotTests.length
  const passed = coerceInteger(summary.passed) ?? countedPassed
  const failed = coerceInteger(summary.failed) ?? countedFailed
  const reportedSkipped = coerceInteger((summary as JsonRecord).skipped)
  const inferredSkipped = total >= passed + failed ? total - passed - failed : countedSkipped
  const skipped = Math.max(0, reportedSkipped ?? inferredSkipped)
  const passRate = coerceExecutionPercent(summary.pass_rate)
    ?? (total > 0 ? clampPercent((passed / total) * 100) : 0)

  return {
    total,
    passed,
    failed,
    skipped,
    passRate,
    robotTests,
    failedCases,
  }
}

export function parseDtpTestSummaryFile(summaryFile: string): DtpTestSummaryParseResult {
  return parseDtpTestSummary(readJsonFile(summaryFile))
}

function analyzeRound(reportsDir: string): RoundAnalysis {
  const summaryFile = join(reportsDir, "test_summary.json")
  const outputXml = join(reportsDir, "output.xml")
  if (existsSync(summaryFile)) {
    const parsedSummary = parseDtpTestSummaryFile(summaryFile)
    return {
      reportsDir,
      resultSource: "test_summary_json",
      summaryFile,
      outputXml,
      ...parsedSummary,
      coverage: readCoverageMetrics(reportsDir),
    }
  }

  const parsed = parseOutputXml(outputXml)
  const stats = normalizeRobotStats(parsed)
  const passRate = stats.total > 0 ? clampPercent((stats.passed / stats.total) * 100) : 0
  const failedCases = parsed.tests
    .filter((item) => item.status === "FAIL" && item.name.trim())
    .map((item) => ({
      case_id: item.name,
      status: "FAIL" as const,
      message: item.message || "Robot output.xml 显示该用例执行失败",
    }))

  return {
    reportsDir,
    resultSource: "output_xml",
    outputXml,
    ...stats,
    passRate,
    robotTests: parsed.tests,
    failedCases,
    coverage: readCoverageMetrics(reportsDir),
  }
}

function normalizeCaseLookupKey(value: string): string {
  return value.trim().toLowerCase()
}

function robotStatusToVerdict(status: RobotTestStatus): "pass" | "fail" | "blocked" | "not_executed" {
  if (status === "PASS") return "pass"
  if (status === "FAIL") return "fail"
  if (status === "SKIP") return "blocked"
  return "not_executed"
}

function buildStepResults(
  testCase: SourceConfirmationTestCase | null,
  verdict: "pass" | "fail" | "blocked" | "not_executed",
  message: string,
): z.infer<typeof TestExecutionReport>["executions"][number]["step_results"] {
  const steps = testCase?.test_step ?? [{
    key_name: "", step_desc: "DTP执行", parameter: [],
    source_step_desc: "DTP执行", expected_result: "执行完成",
    expected_key_name: "保留", source_expected_key_name: "保留", expected_parameter: [],
    is_startup_step: false,
  }]
  return steps.map((_step, index) => {
    const isFirst = index === 0
    const stepVerdict = verdict === "fail"
      ? (isFirst ? "fail" : "not_executed")
      : verdict

    return {
      step_number: index + 1,
      actual_result: verdict === "pass"
        ? "DTP执行通过"
        : message || "DTP执行未通过",
      verdict: stepVerdict,
      evidence: message || undefined,
    }
  })
}

function buildFallbackRobotAssignments(analysis: RoundAnalysis): RobotOutputTestResult[] {
  const assignments: RobotOutputTestResult[] = []
  for (let index = 0; index < analysis.passed; index += 1) {
    assignments.push({ name: "", status: "PASS", message: "" })
  }
  for (let index = 0; index < analysis.failed; index += 1) {
    assignments.push({ name: "", status: "FAIL", message: "DTP报告显示该用例执行失败" })
  }
  for (let index = 0; index < analysis.skipped; index += 1) {
    assignments.push({ name: "", status: "SKIP", message: "DTP报告显示该用例被跳过" })
  }
  return assignments
}

function buildExecutionReport(
  sourceSuite: SourceConfirmationTestSuiteType,
  analysis: RoundAnalysis,
): z.infer<typeof TestExecutionReport> {
  const testCaseById = new Map(sourceSuite.test_cases.map((testCase) => [normalizeCaseLookupKey(testCase.case_id), testCase]))
  const testCaseByName = new Map(sourceSuite.test_cases.map((testCase) => [normalizeCaseLookupKey(testCase.case_name), testCase]))
  const robotByName = new Map<string, RobotOutputTestResult>()
  for (const robotTest of analysis.robotTests) {
    robotByName.set(normalizeCaseLookupKey(robotTest.name), robotTest)
  }

  const usedRobotNames = new Set<string>()
  const fallbackAssignments = buildFallbackRobotAssignments(analysis)
  const executions: z.infer<typeof TestExecutionReport>["executions"] = []

  for (const testCase of sourceSuite.test_cases) {
    const byId = robotByName.get(normalizeCaseLookupKey(testCase.case_id))
    const byName = robotByName.get(normalizeCaseLookupKey(testCase.case_name))
    const fallback = analysis.robotTests.length === 0 ? fallbackAssignments.shift() : undefined
    const robotTest = byId ?? byName ?? fallback
    const verdict = robotTest ? robotStatusToVerdict(robotTest.status) : "not_executed"
    const message = robotTest?.message ?? ""

    if (byId || byName) usedRobotNames.add(normalizeCaseLookupKey((byId ?? byName)!.name))

    executions.push({
      test_case_id: testCase.case_id,
      execution_id: `EXEC-${testCase.case_id}`,
      verdict,
      step_results: buildStepResults(testCase, verdict, message),
      defect_ids: [],
      environment: {
        platform: "DTP",
        software_version: sourceSuite.version,
        tools: ["DTP", "Robot Framework"],
      },
      executed_by: "phase6_execution_loop",
      executed_date: new Date().toISOString(),
      notes: message || undefined,
    })
  }

  for (const robotTest of analysis.robotTests) {
    const key = normalizeCaseLookupKey(robotTest.name)
    if (usedRobotNames.has(key) || testCaseById.has(key) || testCaseByName.has(key)) continue
    const verdict = robotStatusToVerdict(robotTest.status)
    executions.push({
      test_case_id: robotTest.name,
      execution_id: `EXEC-${robotTest.name}`,
      verdict,
      step_results: buildStepResults(null, verdict, robotTest.message),
      defect_ids: [],
      environment: {
        platform: "DTP",
        software_version: sourceSuite.version,
        tools: ["DTP", "Robot Framework"],
      },
      executed_by: "phase6_execution_loop",
      executed_date: new Date().toISOString(),
      notes: "DTP报告中存在未匹配到 confirmation-tests.json 的用例。",
    })
  }

  const summary = executions.reduce(
    (acc, execution) => {
      acc.total_executed += 1
      if (execution.verdict === "pass") acc.passed += 1
      if (execution.verdict === "fail") acc.failed += 1
      if (execution.verdict === "blocked") acc.blocked += 1
      if (execution.verdict === "not_executed") acc.not_executed += 1
      return acc
    },
    {
      total_executed: 0,
      passed: 0,
      failed: 0,
      blocked: 0,
      not_executed: 0,
      pass_rate: 0,
      total_defects_found: 0,
    },
  )
  summary.pass_rate = summary.total_executed > 0
    ? clampPercent((summary.passed / summary.total_executed) * 100)
    : 0

  const passedCaseIds = new Set(
    executions.filter((execution) => execution.verdict === "pass").map((execution) => execution.test_case_id),
  )
  const requirementTotal = sourceSuite.traceability.length
  const requirementCovered = sourceSuite.traceability.filter((entry) =>
    entry.case_ids.some((caseId) => passedCaseIds.has(caseId)),
  ).length
  const testCaseCoverage = sourceSuite.test_cases.length > 0
    ? clampPercent((executions.filter((execution) => execution.verdict !== "not_executed").length / sourceSuite.test_cases.length) * 100)
    : 0

  const report = {
    project_name: sourceSuite.project_name,
    version: sourceSuite.version,
    created_date: new Date().toISOString().split("T")[0],
    executions,
    coverage: {
      requirement_coverage: requirementTotal > 0 ? clampPercent((requirementCovered / requirementTotal) * 100) : 0,
      test_case_coverage: testCaseCoverage,
      ...(analysis.coverage.metrics.statement !== undefined ? { code_statement: analysis.coverage.metrics.statement } : {}),
      ...(analysis.coverage.metrics.branch !== undefined ? { code_branch: analysis.coverage.metrics.branch } : {}),
      ...(analysis.coverage.metrics.mc_dc !== undefined ? { code_mc_dc: analysis.coverage.metrics.mc_dc } : {}),
      ...(analysis.coverage.metrics.condition !== undefined ? { code_condition: analysis.coverage.metrics.condition } : {}),
      ...(analysis.coverage.metrics.path !== undefined ? { code_path: analysis.coverage.metrics.path } : {}),
    },
    summary,
  }

  return TestExecutionReport.parse(report)
}

async function writeExecutionReport(projectDir: string, sourceSuite: SourceConfirmationTestSuiteType, analysis: RoundAnalysis): Promise<{
  dataFile: string
  reportFile: string
}> {
  const dataFile = join(projectDir, ARTIFACT_PATHS.TEST_EXECUTION)
  const reportFile = join(projectDir, REPORT_PATHS.TEST_EXECUTION)
  writeJsonFile(dataFile, buildExecutionReport(sourceSuite, analysis))
  await (docGenerator as any).execute({
    data_file: dataFile,
    doc_type: "test-execution",
    output_file: reportFile,
  })
  return { dataFile, reportFile }
}

export function optimizePhase6CasesFromExecutionReport(
  _sourceSuite: SourceConfirmationTestSuiteType,
  analysis: RoundAnalysis,
): string[] {
  const seen = new Set<string>()
  const caseIds: string[] = []
  for (const failedCase of analysis.failedCases) {
    const caseId = failedCase.case_id.trim()
    if (!caseId || seen.has(caseId)) continue
    seen.add(caseId)
    caseIds.push(caseId)
  }
  return caseIds
}

interface ResolvedLLMConfig {
  providerID: string
  modelID: string
}

function extractJsonObjectFromText(text: string): JsonRecord | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  const candidates = [trimmed]
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced?.[1]) candidates.unshift(fenced[1].trim())
  const firstBrace = trimmed.indexOf("{")
  const lastBrace = trimmed.lastIndexOf("}")
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1))
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as JsonRecord
    } catch {
      continue
    }
  }
  return null
}

function extractModelFromMessageInfo(info: any): ResolvedLLMConfig | null {
  if (!info || typeof info !== "object") return null
  if (typeof info.providerID === "string" && typeof info.modelID === "string") {
    return {
      providerID: info.providerID,
      modelID: info.modelID,
    }
  }
  if (info.model && typeof info.model === "object") {
    const providerID = typeof info.model.providerID === "string" ? info.model.providerID : ""
    const modelID = typeof info.model.modelID === "string" ? info.model.modelID : ""
    if (providerID && modelID) return { providerID, modelID }
  }
  return null
}

async function resolveRuntimeModel(client: OpencodeClient, context: ToolContext): Promise<ResolvedLLMConfig> {
  const currentMessage = await client.session.message({
    path: {
      id: context.sessionID,
      messageID: context.messageID,
    },
    query: {
      directory: context.directory,
    },
  })

  const fromCurrentMessage = extractModelFromMessageInfo(currentMessage.data?.info)
  if (fromCurrentMessage) return fromCurrentMessage

  const cfg = await client.config.get({
    query: { directory: context.directory },
  })
  if (cfg.error || !cfg.data) throw new Error("Failed to resolve current OpenCode model")

  const modelRef = cfg.data.model ?? ""
  const providerConfigs = cfg.data.provider ?? {}
  let providerID = ""
  let modelID = ""

  if (modelRef.includes("/")) {
    const parts = modelRef.split("/")
    providerID = parts[0] ?? ""
    modelID = parts.slice(1).join("/")
  } else if (modelRef) {
    modelID = modelRef
  }
  if (!providerID && Object.keys(providerConfigs).length === 1) {
    providerID = Object.keys(providerConfigs)[0] ?? ""
  }

  const providerConfig = providerID ? providerConfigs[providerID] : undefined
  if (!providerConfig || typeof providerConfig !== "object") {
    throw new Error("OpenCode provider config is missing")
  }
  const providerModels = (providerConfig as { models?: Record<string, unknown> }).models ?? {}
  if (!modelID && Object.keys(providerModels).length === 1) {
    modelID = Object.keys(providerModels)[0] ?? ""
  }
  if (!providerID || !modelID) throw new Error("OpenCode model/provider config is incomplete")

  return { providerID, modelID }
}

function buildOptimizationPrompt(testCase: SourceConfirmationTestCase, failedCase: Phase6FailedCaseInfo): string {
  return [
    "请根据 DTP 执行失败信息修订这个 Phase 6 确认测试用例设计。",
    "只修订导致脚本失败的测试输入、步骤描述、预期结果、初始设置或判定准则；保持 case_id、correspond_fun_id、test_type、path、追踪关系和元数据不变。",
    "必须继续使用当前项目的组合关键字 Documentation 风格表达步骤，不要新增无关场景，不要解释。",
    "输出严格 JSON 对象，顶层字段必须是 source_case，source_case 是修订后的完整源用例对象。",
    "",
    "<failed_case>",
    JSON.stringify(failedCase, null, 2),
    "</failed_case>",
    "",
    "<current_source_case>",
    JSON.stringify(testCase, null, 2),
    "</current_source_case>",
  ].join("\n")
}

async function optimizeOneCaseWithClient(
  client: OpencodeClient,
  context: ToolContext,
  model: ResolvedLLMConfig,
  testCase: SourceConfirmationTestCase,
  failedCase: Phase6FailedCaseInfo,
): Promise<SourceConfirmationTestCase> {
  const child = await client.session.create({
    query: { directory: context.directory },
    body: {
      parentID: context.sessionID,
      title: `phase6-execution-optimize:${failedCase.case_id}`,
    },
  })
  if (child.error || !child.data) {
    throw new Error(`Failed to create optimization session for ${failedCase.case_id}`)
  }

  const sessionID = child.data.id
  try {
    const response = await client.session.prompt({
      path: { id: sessionID },
      query: { directory: context.directory },
      body: {
        model: {
          providerID: model.providerID,
          modelID: model.modelID,
        },
        system: [
          "你是 Phase 6 执行结果驱动的测试用例修订器。",
          "你只输出 JSON，不调用工具，不输出 Markdown 或解释。",
        ].join("\n"),
        tools: {},
        parts: [{ type: "text", text: buildOptimizationPrompt(testCase, failedCase) }],
      },
    })

    if (response.error || !response.data) {
      throw new Error(`OpenCode session prompt failed for ${failedCase.case_id}`)
    }
    if (response.data.info.error) {
      const err = response.data.info.error
      if (err.name === "APIError") {
        throw new Error(`LLM API ${err.data.statusCode ?? "error"}: ${err.data.responseBody ?? err.data.message}`)
      }
      throw new Error(typeof err.data?.message === "string" ? err.data.message : err.name)
    }

    const text = response.data.parts
      .flatMap((part) => (part.type === "text" && typeof (part as any).text === "string" ? [(part as any).text as string] : []))
      .join("\n")
      .trim()
    const parsed = extractJsonObjectFromText(text)
    const sourceCase = parsed?.source_case && typeof parsed.source_case === "object" && !Array.isArray(parsed.source_case)
      ? parsed.source_case as JsonRecord
      : parsed
    if (!sourceCase) throw new Error(`优化输出不是合法 JSON 对象：${failedCase.case_id}`)

    // Migrate LLM-output steps to unified format if needed
    const merged = {
      ...testCase,
      ...sourceCase,
      case_id: testCase.case_id,
      correspond_fun_id: testCase.correspond_fun_id,
      test_type: testCase.test_type,
      path: testCase.path,
      related_software_req_ids: testCase.related_software_req_ids,
    }
    merged.test_step = ensureUnifiedSteps(merged.test_step)
    return SourceConfirmationTestCase.parse(merged)
  } finally {
    await client.session
      .delete({
        path: { id: sessionID },
        query: { directory: context.directory },
      })
      .catch(() => undefined)
  }
}

function writeOptimizedPhase6Suites(projectDir: string, sourceSuite: SourceConfirmationTestSuiteType): void {
  const validatedSource = SourceConfirmationTestSuite.parse(sourceSuite)

  // Derive translated suite from unified step records
  const translatedCases = validatedSource.test_cases
    .map((tc) => ({
      ...tc,
      test_step: extractTranslatedStepsFromUnified(tc.test_step),
    }))
    .filter((tc) => tc.test_step.length > 0)

  const byType: Record<string, number> = {}
  for (const tc of translatedCases) {
    byType[tc.test_type] = (byType[tc.test_type] ?? 0) + 1
  }
  const translated: TranslatedConfirmationTestSuite = TranslatedConfirmationTestSuite.parse({
    ...validatedSource,
    test_cases: translatedCases,
    summary: { total_cases: translatedCases.length, by_type: byType },
  })

  writeJsonFile(join(projectDir, ARTIFACT_PATHS.CONFIRMATION_TESTS), validatedSource)
}

function emitPhase6ExecutionMetadata(
  ctx: ToolContext | undefined,
  title: string,
  metadata: Record<string, unknown>,
): void {
  try {
    ctx?.metadata({ title, metadata })
  } catch {
    // Metadata is best-effort and must never affect the execution loop.
  }
}

async function defaultOptimizeFailedCases(
  _workspaceRoot: string,
  sourceSuite: SourceConfirmationTestSuiteType,
  analysis: RoundAnalysis,
  client?: OpencodeClient | null,
  ctx?: ToolContext,
): Promise<Phase6CaseOptimizationResult> {
  if (!client || !ctx) {
    return {
      sourceSuite,
      changedCaseIds: [],
      warnings: ["当前运行环境缺少 OpenCode client/context，无法自动优化失败用例。"],
    }
  }

  const failedCaseIds = optimizePhase6CasesFromExecutionReport(sourceSuite, analysis)
  const sourceCaseById = new Map(sourceSuite.test_cases.map((testCase) => [testCase.case_id, testCase]))
  const failedCaseById = new Map(analysis.failedCases.map((failedCase) => [failedCase.case_id, failedCase]))
  const model = await resolveRuntimeModel(client, ctx)
  const replacements = new Map<string, SourceConfirmationTestCase>()
  const warnings: string[] = []

  for (const caseId of failedCaseIds) {
    const testCase = sourceCaseById.get(caseId)
    const failedCase = failedCaseById.get(caseId)
    if (!testCase || !failedCase) {
      warnings.push(`未在 confirmation-tests.json 中找到失败用例：${caseId}`)
      continue
    }
    const optimized = await optimizeOneCaseWithClient(client, ctx, model, testCase, failedCase)
    replacements.set(caseId, optimized)
  }

  const changedCaseIds = [...replacements.keys()]
  const optimizedSuite = SourceConfirmationTestSuite.parse({
    ...sourceSuite,
    test_cases: sourceSuite.test_cases.map((testCase) => replacements.get(testCase.case_id) ?? testCase),
  })
  return {
    sourceSuite: optimizedSuite,
    changedCaseIds,
    warnings,
  }
}

async function defaultRegenerateRobotOutputs(
  workspaceRoot: string,
  client?: OpencodeClient | null,
  ctx?: ToolContext,
  dtpRoot?: string,
  knowledgeMode: DtpKnowledgeMode = "source",
): Promise<JsonRecord[]> {
  const docsContext = normalizeDocsContext()
  const modelHooks = createDtpDataModelHooks(client ?? undefined, ctx)
  const generatedTestDataFile = resolveDefaultPaths(workspaceRoot).generatedDataFile
  const outputs: JsonRecord[] = []

  emitPhase6ExecutionMetadata(ctx, "Phase 6 DTP 准备：标准协议定义检查", {
    stage: "dtp_protocol_definitions_ensure",
  })
  const protocolPreparation = await ensureDtpProtocolDefinitions(workspaceRoot, docsContext, modelHooks, {
    scope: "case",
    case_queries: collectDtpCaseProtocolQueries(workspaceRoot),
    knowledgeMode,
  })
  outputs.push({
    tool: "dtp_protocol_definitions_ensure",
    status: "success",
    cache_hit: protocolPreparation.cache_hit,
    knowledge_mode: protocolPreparation.knowledge_mode,
    source_document_scan_performed: protocolPreparation.source_document_scan_performed,
    protocol_count: protocolPreparation.protocol_definitions.protocols.length,
    validation_issue_count: protocolPreparation.validation.issues.length,
  })

  emitPhase6ExecutionMetadata(ctx, "Phase 6 DTP 准备：用例数据实例化", {
    stage: "dtp_test_data_generate",
  })
  const testData = await runDtpCaseDataInstantiation(
    workspaceRoot,
    docsContext,
    modelHooks,
    protocolPreparation,
    { knowledgeMode },
  )
  outputs.push({
    tool: "dtp_test_data_generate",
    status: "success",
    knowledge_mode: knowledgeMode,
    case_count: testData.cases.length,
  })

  emitPhase6ExecutionMetadata(ctx, "Phase 6 DTP 准备：Robot 渲染", {
    stage: "dtp_robot_generate",
    generated_test_data_file: generatedTestDataFile,
  })
  const dtpTool = createDtpRobotGenerator(client ?? undefined)
  const robotRaw = await (dtpTool as any).execute(
    {
      dtp_root: dtpRoot,
      generated_test_data_file: generatedTestDataFile,
    },
    ctx,
  )
  outputs.push({ tool: "dtp_robot_generate", status: "success", result: JSON.parse(robotRaw) })

  emitPhase6ExecutionMetadata(ctx, "Phase 6 DTP 准备完成", {
    stage: "dtp_generation_complete",
    output_count: outputs.length,
  })
  return outputs
}

function buildErrorArtifact(params: {
  now: Date
  sourceSuiteFile: string
  translatedSuiteFile: string
  todoFile: string
  dtpRoot: string
  passRateThreshold: number
  coverageTarget: Phase6CoverageTarget
  coverageThreshold: number
  maxOptimizationRounds: number
  message: string
  rounds?: Phase6ExecutionLoopRound[]
}): z.infer<typeof Phase6ExecutionLoopArtifact> {
  return {
    schema_version: "1.0.0",
    created_at: params.now.toISOString(),
    updated_at: params.now.toISOString(),
    source_suite_file: params.sourceSuiteFile,
    translated_suite_file: params.translatedSuiteFile,
    todo_file: params.todoFile,
    dtp_root: params.dtpRoot,
    pass_rate_threshold: params.passRateThreshold,
    coverage_target: params.coverageTarget,
    coverage_threshold: params.coverageThreshold,
    max_optimization_rounds: params.maxOptimizationRounds,
    gate_status: "error",
    rounds: params.rounds ?? [],
    final: {
      pass_rate: null,
      pass_rate_met: false,
      coverage_value: null,
      coverage_met: false,
      attempts: params.rounds?.length ?? 0,
      optimization_rounds_used: Math.max((params.rounds?.length ?? 1) - 1, 0),
      message: params.message,
    },
  }
}

function writeLoopArtifact(projectDir: string, artifact: z.infer<typeof Phase6ExecutionLoopArtifact>): string {
  const artifactPath = join(projectDir, ARTIFACT_PATHS.PHASE6_EXECUTION_LOOP)
  const validated = Phase6ExecutionLoopArtifact.parse(artifact)
  writeJsonFile(artifactPath, validated)
  return artifactPath
}

export async function runPhase6ExecutionLoop(
  projectDir: string,
  options: Phase6ExecutionLoopOptions = {},
  deps: Phase6ExecutionLoopDeps = {},
  ctx?: ToolContext,
  client?: OpencodeClient | null,
): Promise<JsonRecord> {
  const now = deps.now ?? (() => new Date())
  const startedAt = now()
  const config = loadPluginConfig(projectDir)
  const sourceSuiteFile = resolveProjectPath(projectDir, options.source_suite_file, ARTIFACT_PATHS.CONFIRMATION_TESTS)
  const translatedSuiteFile = resolveProjectPath(projectDir, options.translated_suite_file, ARTIFACT_PATHS.CONFIRMATION_TESTS)
  const todoFile = resolveProjectPath(projectDir, options.todo_file, ARTIFACT_PATHS.PHASE6_TEST_CASES_TODO)
  const dtpRoot = resolveProjectPath(projectDir, options.dtp_root, join(".matrix", "data", "DTPProject"))
  const passRateThreshold = options.pass_rate_threshold ?? config.phase6_execution_pass_rate_threshold
  const coverageTarget = options.coverage_target ?? "branch"
  const coverageThreshold = options.coverage_threshold ?? 70
  const maxOptimizationRounds = options.max_optimization_rounds ?? config.phase6_execution_max_optimization_rounds
  const rounds: Phase6ExecutionLoopRound[] = []

  const errorBase = {
    now: startedAt,
    sourceSuiteFile,
    translatedSuiteFile,
    todoFile,
    dtpRoot,
    passRateThreshold,
    coverageTarget,
    coverageThreshold,
    maxOptimizationRounds,
  }

  try {
    if (!existsSync(sourceSuiteFile)) throw new Error(`confirmation-tests.json 不存在：${sourceSuiteFile}`)
    if (!existsSync(translatedSuiteFile)) throw new Error(`confirmation-tests.json 不存在：${translatedSuiteFile}`)
    if (!isDirectory(dtpRoot)) throw new Error(`DTPProject 目录不存在：${dtpRoot}`)

    let sourceSuite = SourceConfirmationTestSuite.parse(readJsonFile(sourceSuiteFile))
    TranslatedConfirmationTestSuite.parse(readJsonFile(translatedSuiteFile))

    if (!existsSync(todoFile)) {
      writePhase6TestCasesTodoFromSuite(projectDir, sourceSuite, "execution_loop_initial_fallback")
    }

    const executeDtp = deps.executeDtp ?? ((executeOptions) => executeDtpProject(executeOptions) as Promise<JsonRecord>)
    const regenerateRobot = deps.regenerateRobot ?? ((workspaceRoot, toolCtx) =>
      defaultRegenerateRobotOutputs(workspaceRoot, client, toolCtx, dtpRoot, options.knowledge_mode ?? "source"))
    const optimizeCases = deps.optimizeCases ?? ((workspaceRoot, suite, analysis, toolCtx) =>
      defaultOptimizeFailedCases(workspaceRoot, suite, analysis, client, toolCtx))
    let finalStatus: "passed" | "failed" = "failed"
    let finalMessage = "Phase 6 执行闭环未达标。"
    let latestPassRate: number | null = null
    let latestCoverageValue: number | null = null
    let latestPassRateMet = false
    let latestCoverageMet = false

    for (let roundIndex = 0; roundIndex <= maxOptimizationRounds; roundIndex += 1) {
      const roundStarted = now()
      let robotRegenerated = false
      let dtpGenerationOutputs: JsonRecord[] | undefined

      if (roundIndex === 0) {
        try {
          dtpGenerationOutputs = await regenerateRobot(projectDir, ctx)
          robotRegenerated = true
        } catch (error) {
          const errorMessage = `DTP准备失败：${error instanceof Error ? error.message : String(error)}`
          rounds.push({
            round_index: roundIndex,
            kind: "initial",
            started_at: roundStarted.toISOString(),
            completed_at: now().toISOString(),
            dtp_success: false,
            reports_dir: join(dtpRoot, "报告"),
            total: 0,
            passed: 0,
            failed: 0,
            skipped: 0,
            pass_rate: 0,
            pass_rate_threshold: passRateThreshold,
            pass_rate_met: false,
            coverage_target: coverageTarget,
            coverage_value: null,
            coverage_threshold: coverageThreshold,
            coverage_met: false,
            coverage_missing: true,
            failed_cases: [],
            optimization_applied: false,
            robot_regenerated: false,
            ...(dtpGenerationOutputs ? { dtp_generation_outputs: dtpGenerationOutputs } : {}),
            errors: [errorMessage],
            warnings: [],
          })
          throw new Error(errorMessage)
        }
      }

      const dtpResult = await executeDtp({
        project_dir: dtpRoot,
        project_name: "DTPProject",
      })

      if (dtpResult.success === false) {
        const errorMessage = `DTP执行失败：${String(dtpResult.error ?? "unknown error")}`
        rounds.push({
          round_index: roundIndex,
          kind: roundIndex === 0 ? "initial" : "optimization",
          started_at: roundStarted.toISOString(),
          completed_at: now().toISOString(),
          dtp_success: false,
          reports_dir: typeof dtpResult.reports_dir === "string" ? dtpResult.reports_dir : join(dtpRoot, "报告"),
          total: 0,
          passed: 0,
          failed: 0,
          skipped: 0,
          pass_rate: 0,
          pass_rate_threshold: passRateThreshold,
          pass_rate_met: false,
          coverage_target: coverageTarget,
          coverage_value: null,
          coverage_threshold: coverageThreshold,
          coverage_met: false,
          coverage_missing: true,
          failed_cases: [],
          optimization_applied: false,
          robot_regenerated: robotRegenerated,
          ...(dtpGenerationOutputs ? { dtp_generation_outputs: dtpGenerationOutputs } : {}),
          errors: [errorMessage],
          warnings: [],
        })
        throw new Error(errorMessage)
      }

      const reportsDir = typeof dtpResult.reports_dir === "string"
        ? dtpResult.reports_dir
        : join(dtpRoot, "报告")
      const analysis = analyzeRound(reportsDir)
      const coverageValue = analysis.coverage.metrics[coverageTarget] ?? null
      const passRateMet = analysis.passRate >= passRateThreshold
      const coverageMet = passRateMet && coverageValue !== null && coverageValue >= coverageThreshold
      const executionFiles = await writeExecutionReport(projectDir, sourceSuite, analysis)
      const roundCompleted = now()

      latestPassRate = analysis.passRate
      latestCoverageValue = coverageValue
      latestPassRateMet = passRateMet
      latestCoverageMet = coverageMet

      const round: Phase6ExecutionLoopRound = {
        round_index: roundIndex,
        kind: roundIndex === 0 ? "initial" : "optimization",
        started_at: roundStarted.toISOString(),
        completed_at: roundCompleted.toISOString(),
        dtp_success: true,
        reports_dir: reportsDir,
        summary_file: analysis.summaryFile,
        result_source: analysis.resultSource,
        output_xml: analysis.outputXml,
        total: analysis.total,
        passed: analysis.passed,
        failed: analysis.failed,
        skipped: analysis.skipped,
        pass_rate: analysis.passRate,
        pass_rate_threshold: passRateThreshold,
        pass_rate_met: passRateMet,
        coverage_target: coverageTarget,
        coverage_value: coverageValue,
        coverage_threshold: coverageThreshold,
        coverage_met: coverageMet,
        coverage_file: analysis.coverage.file,
        coverage_missing: analysis.coverage.missing || coverageValue === null,
        test_execution_file: executionFiles.dataFile,
        test_execution_report: executionFiles.reportFile,
        failed_cases: analysis.failedCases,
        optimization_applied: false,
        robot_regenerated: robotRegenerated,
        ...(dtpGenerationOutputs ? { dtp_generation_outputs: dtpGenerationOutputs } : {}),
        warnings: analysis.coverage.warnings,
        errors: [],
      }

      if (passRateMet && coverageMet) {
        rounds.push(round)
        finalStatus = "passed"
        finalMessage = "Phase 6 DTP 执行通过率和覆盖率均已达标。"
        break
      }

      if (roundIndex >= maxOptimizationRounds) {
        rounds.push(round)
        finalMessage = !passRateMet
          ? "Phase 6 DTP 执行未达标：通过率低于阈值，且已达到闭环次数上限。"
          : coverageValue === null
            ? "Phase 6 DTP 执行未达标：覆盖率数据缺失或目标覆盖率不可用，且已达到闭环次数上限。"
            : "Phase 6 DTP 执行未达标，且已达到闭环次数上限。"
        break
      }

      const changedCaseIds = optimizePhase6CasesFromExecutionReport(sourceSuite, analysis)
      if (changedCaseIds.length === 0) {
        round.errors.push("未找到 status=FAIL 且可定位的测试用例，无法执行针对性优化。")
        rounds.push(round)
        finalMessage = "Phase 6 DTP 执行未达标，但未找到可优化的失败用例。"
        break
      }

      const optimized = await optimizeCases(projectDir, sourceSuite, analysis, ctx)
      const allowedCaseIds = new Set(changedCaseIds)
      const optimizedCaseIds = optimized.changedCaseIds
        .map((caseId) => caseId.trim())
        .filter((caseId, index, array) => caseId && allowedCaseIds.has(caseId) && array.indexOf(caseId) === index)

      if (optimized.warnings?.length) round.warnings.push(...optimized.warnings)
      if (optimizedCaseIds.length === 0) {
        round.errors.push("失败用例优化未产生任何成功修改的 case_id。")
        rounds.push(round)
        finalMessage = "Phase 6 DTP 执行未达标，且失败用例优化未产生可重跑用例。"
        break
      }

      sourceSuite = SourceConfirmationTestSuite.parse(optimized.sourceSuite)
      writeOptimizedPhase6Suites(projectDir, sourceSuite)

      const todo = writePhase6TestCasesTodoFile(projectDir, optimizedCaseIds, "execution_result_failed_cases")
      await regenerateRobot(projectDir, ctx)
      round.optimization_applied = true
      round.todo_file = join(projectDir, todo.todo_file)
      round.todo_case_count = todo.case_count
      round.optimization_case_ids = optimizedCaseIds
      round.robot_regenerated = true
      rounds.push(round)
    }

    const completedAt = now()
    const artifact = Phase6ExecutionLoopArtifact.parse({
      schema_version: "1.0.0",
      created_at: startedAt.toISOString(),
      updated_at: completedAt.toISOString(),
      source_suite_file: sourceSuiteFile,
      translated_suite_file: translatedSuiteFile,
      todo_file: todoFile,
      dtp_root: dtpRoot,
      pass_rate_threshold: passRateThreshold,
      coverage_target: coverageTarget,
      coverage_threshold: coverageThreshold,
      max_optimization_rounds: maxOptimizationRounds,
      gate_status: finalStatus,
      rounds,
      final: {
        pass_rate: latestPassRate,
        pass_rate_met: latestPassRateMet,
        coverage_value: latestCoverageValue,
        coverage_met: latestCoverageMet,
        attempts: rounds.length,
        optimization_rounds_used: Math.max(rounds.length - 1, 0),
        message: finalMessage,
      },
    })
    const artifactPath = writeLoopArtifact(projectDir, artifact)

    return {
      status: finalStatus === "passed" ? "success" : "error",
      gate_status: finalStatus,
      message: finalMessage,
      phase6_execution_loop_file: artifactPath,
      test_execution_file: join(projectDir, ARTIFACT_PATHS.TEST_EXECUTION),
      test_execution_report: join(projectDir, REPORT_PATHS.TEST_EXECUTION),
      attempts: rounds.length,
      pass_rate: latestPassRate,
      pass_rate_threshold: passRateThreshold,
      pass_rate_met: latestPassRateMet,
      coverage_target: coverageTarget,
      coverage_value: latestCoverageValue,
      coverage_threshold: coverageThreshold,
      coverage_met: latestCoverageMet,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const artifact = buildErrorArtifact({
      ...errorBase,
      message,
      rounds,
    })
    const artifactPath = writeLoopArtifact(projectDir, artifact)
    return {
      status: "error",
      gate_status: "error",
      error: message,
      phase6_execution_loop_file: artifactPath,
    }
  }
}

export function createPhase6ExecutionLoop(client?: OpencodeClient | null): ToolDefinition {
  return tool({
    description:
      "Phase 6 确认测试执行闭环：在用例/Robot 发布完成后执行 DTP，解析报告目录，" +
      "优先读取 test_summary.json 与 coverage_data.json，按通过率和分支覆盖率阈值判定是否允许 Phase 6 完成；" +
      "未达标时仅针对 FAIL 用例优化并重建 todo/Robot 后重试。",
    args: {
      source_suite_file: tool.schema
        .string()
        .optional()
        .describe("源确认测试用例文件，默认 .matrix/data/confirmation-tests.json"),
      translated_suite_file: tool.schema
        .string()
        .optional()
        .describe("翻译后的可执行确认测试用例文件，默认 .matrix/data/confirmation-tests.json"),
      todo_file: tool.schema
        .string()
        .optional()
        .describe("待生成 Robot 的 case_id 列表，默认 .matrix/data/test-cases-todo.txt"),
      dtp_root: tool.schema
        .string()
        .optional()
        .describe("DTPProject 根目录，默认 .matrix/data/DTPProject"),
      knowledge_mode: tool.schema
        .enum(["source", "offline"])
        .optional()
        .describe(
          "DTP 知识来源模式。source 扫描第三方测试需求文档；offline 只复用 project-knowledge-index.json。默认 source。",
        ),
      pass_rate_threshold: tool.schema
        .number()
        .optional()
        .describe("通过率阈值百分比，默认读取 phase6_execution_pass_rate_threshold（默认 60）"),
      coverage_target: tool.schema
        .enum(["statement", "branch", "mc_dc", "condition", "path"])
        .optional()
        .describe("覆盖率门禁指标，默认 branch"),
      coverage_threshold: tool.schema
        .number()
        .optional()
        .describe("覆盖率阈值百分比，默认 70"),
      max_optimization_rounds: tool.schema
        .number()
        .optional()
        .describe("初次失败后的最大优化闭环次数，默认读取 phase6_execution_max_optimization_rounds"),
    },
    async execute(args, ctx) {
      const projectDir = getToolBaseDirectory(ctx)
      const result = await runPhase6ExecutionLoop(
        projectDir,
        args as Phase6ExecutionLoopOptions,
        {},
        ctx,
        client,
      )
      return JSON.stringify(result, null, 2)
    },
  })
}

export const phase6ExecutionLoop: ToolDefinition = createPhase6ExecutionLoop()
