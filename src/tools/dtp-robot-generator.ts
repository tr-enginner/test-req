import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import type { OpencodeClient } from "@opencode-ai/sdk/client"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs"
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "path"
import {
  sanitizeDtpExecutablePlaceholders,
} from "../shared/phase6-placeholder-sanitizer"

type KeywordMeta = {
  keywordName: string
  sourceJsonPath: string
  sourceTxtPath: string | null
  argumentNames: string[]
}

type GeneratedRobotFile = {
  sourceFile: string
  caseName: string
  outputFile: string
  resources: string[]
  warnings: string[]
}

type ProjectGenerationResult = {
  projectDir: string
  keywordDir: string
  outputDir: string
  vteFile: string | null
  confirmationTestsFile: null
  generatedTestDataFile: string
  robotGenerationResultFile: string
  requirementsFile: null
  generatedFiles: GeneratedRobotFile[]
  warnings: string[]
  assetFileCount: number
  keywordMap: Map<string, KeywordMeta>
}

type GeneratedDataArgument = {
  name?: string
  value?: unknown
  semantic?: string
}

type GeneratedDataStep = {
  step_index?: number
  keyword_name?: string
  step_description?: string
  resolved_arguments?: GeneratedDataArgument[] | Record<string, unknown>
  arguments?: GeneratedDataArgument[] | Record<string, unknown>
  warnings?: string[]
}

type GeneratedDataCase = {
  case_id?: string
  translate_status?: string
  case_name?: string
  test_purpose?: string
  test_environment?: string
  generated_steps?: GeneratedDataStep[]
  warnings?: string[]
}

type RobotGenerationCaseJson = {
  case_id: string
  output_robot_file: string
  resource_files: string[]
  vte_file: string
  rendered_step_count: number
  downgraded_step_count: number
  warnings: string[]
}

type RobotGenerationResultJson = {
  schema_version: string
  source_data_file: string
  dtp_root: string
  runtime_dir: string
  output_dir: string
  cases: RobotGenerationCaseJson[]
  warnings: string[]
}

const GENERATED_TEST_DATA_RELATIVE_PATH = ".matrix/data/dtp-generation/generated-test-data.json"
const LEGACY_GENERATED_TEST_DATA_RELATIVE_PATH = ".matrix/data/generated-test-data.json"
const ROBOT_GENERATION_RESULT_FILE_NAME = "robot-generation-result.json"
const DEFAULT_RUNTIME_DIR_NAME = "V1"
const KEYWORD_DIR_NAME = "\u7ec4\u5408\u5173\u952e\u5b57"
const TEST_CASE_DIR_NAME = "\u6d4b\u8bd5\u7528\u4f8b"
const START_VTEST_KEYWORD = "\u542f\u52a8VTEST"
const TEST_END_KEYWORD = "\u6d4b\u8bd5\u7ed3\u675f"
const DESCRIPTION_KEYWORD = "\u63cf\u8ff0"
const FALLBACK_VTE_PATH = "PRJ\\\\PRJ.vte"
const HARDWARE_TEST_ENVIRONMENT = "\u786c\u5e73\u53f0\u6d4b\u8bd5\u73af\u5883"
const TEXT_FILE_ENCODINGS = ["utf-8", "gb18030", "gbk", "gb2312"] as const

function normalizePath(input: string): string {
  return input.replace(/\\/g, "/").replace(/\/{2,}/g, "/")
}

function toRobotPath(input: string): string {
  return normalizePath(input).replace(/\//g, "\\\\")
}

function toDtpRootRobotPath(dtpRoot: string, filePath: string): string {
  return toRobotPath(relative(dtpRoot, filePath))
}

function toVteRobotPath(dtpRoot: string, runtimeDir: string, filePath: string): string {
  const runtimeRelative = normalizePath(relative(runtimeDir, filePath))
  if (runtimeRelative && !runtimeRelative.startsWith("../")) return toRobotPath(runtimeRelative)
  return toDtpRootRobotPath(dtpRoot, filePath)
}

function sanitizeFilename(input: string): string {
  const sanitized = input.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim()
  return sanitized.length > 0 ? sanitized : "unnamed"
}

function decodeTextFile(filePath: string): string {
  const bytes = readFileSync(filePath) as Uint8Array

  for (const encoding of TEXT_FILE_ENCODINGS) {
    try {
      const text = new TextDecoder(encoding as "utf-8", { fatal: true }).decode(bytes)
      return text.replace(/^\uFEFF/, "")
    } catch {
      // Try the next compatible encoding.
    }
  }

  return new TextDecoder("utf-8").decode(bytes).replace(/^\uFEFF/, "")
}

function safeReadJson(filePath: string): unknown {
  return JSON.parse(decodeTextFile(filePath))
}

export function parseInputDatasetRef(testInput: string): { filePath: string; datasetId?: string } | null {
  const trimmed = String(testInput ?? "").trim()
  if (!trimmed || trimmed === "\u65e0") return null

  const [filePath, datasetId] = trimmed.split("#", 2)
  const normalizedFilePath = filePath?.trim()
  if (!normalizedFilePath) return null

  return {
    filePath: normalizedFilePath,
    datasetId: datasetId?.trim() || undefined,
  }
}

export function resolvePreferredInputFile(
  testInput: string,
  assetCatalog: { outputDir: string },
): string | null {
  const ref = parseInputDatasetRef(testInput)
  if (!ref) return null

  const absolutePath = ref.filePath.startsWith("/") || /^[A-Za-z]:\\/.test(ref.filePath)
    ? ref.filePath
    : join(process.cwd(), ref.filePath)
  if (!existsSync(absolutePath)) return null

  return toRobotPath(normalizePath(relative(assetCatalog.outputDir, absolutePath)))
}

function ensureDirectory(dirPath: string): void {
  if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true })
}

function listSubdirectories(dirPath: string): string[] {
  if (!existsSync(dirPath)) return []
  return readdirSync(dirPath)
    .map((name) => join(dirPath, name))
    .filter((entry) => {
      try {
        return statSync(entry).isDirectory()
      } catch {
        return false
      }
    })
}

function walkFiles(dirPath: string, visitor: (filePath: string) => void): void {
  if (!existsSync(dirPath)) return
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = join(dirPath, entry.name)
    if (entry.isDirectory()) {
      walkFiles(fullPath, visitor)
      continue
    }
    if (entry.isFile()) visitor(fullPath)
  }
}

function firstExistingPath(paths: string[]): string | null {
  for (const candidate of paths) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

function isPathWithinWorkspace(workspaceRoot: string, candidatePath: string): boolean {
  const relation = relative(resolve(workspaceRoot), resolve(candidatePath))
  return relation === "" || (!isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`))
}

function resolvePathWithinWorkspace(workspaceRoot: string, inputPath: string, label: string): string {
  const resolvedPath = resolve(workspaceRoot, inputPath)
  if (!isPathWithinWorkspace(workspaceRoot, resolvedPath)) {
    throw new Error(`${label} must stay inside the current OpenCode workspace: ${workspaceRoot}; received: ${resolvedPath}`)
  }
  return resolvedPath
}

function resolveDefaultDtpRoot(workspaceRoot: string): string {
  return (
    firstExistingPath([
      join(workspaceRoot, ".matrix/data/DTPProject"),
      join(workspaceRoot, ".matrix/data/DTPPrject"),
    ]) ?? join(workspaceRoot, ".matrix/data/DTPProject")
  )
}

function resolveGeneratedTestDataFile(workspaceRoot: string, input?: string): string | null {
  if (input) {
    const resolvedInput = resolve(workspaceRoot, input)
    if (existsSync(resolvedInput)) return resolvedInput
  }
  return firstExistingPath([
    join(workspaceRoot, GENERATED_TEST_DATA_RELATIVE_PATH),
    join(workspaceRoot, LEGACY_GENERATED_TEST_DATA_RELATIVE_PATH),
  ])
}

function resolveRuntimeDir(dtpRoot: string): string {
  const defaultRuntimeDir = join(dtpRoot, DEFAULT_RUNTIME_DIR_NAME)
  if (existsSync(defaultRuntimeDir) && statSync(defaultRuntimeDir).isDirectory()) return defaultRuntimeDir

  const versionDirs = listSubdirectories(dtpRoot)
    .filter((dirPath) => /^v\d+$/i.test(basename(dirPath)))
    .sort((left, right) => basename(left).localeCompare(basename(right), undefined, { numeric: true }))
  return versionDirs[0] ?? defaultRuntimeDir
}

function looksLikeKeywordDir(dirPath: string): boolean {
  if (basename(dirPath) === KEYWORD_DIR_NAME || basename(dirPath).toLowerCase().includes("keyword")) return true

  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    if (!entry.isFile() || extname(entry.name).toLowerCase() !== ".json") continue
    try {
      const parsed = safeReadJson(join(dirPath, entry.name)) as { Items?: unknown[] }
      if (Array.isArray(parsed.Items)) return true
    } catch {
      // Ignore malformed files while searching for the keyword directory.
    }
  }

  return false
}

function findKeywordDir(rootDir: string): string | null {
  const directKeywordDir = join(rootDir, KEYWORD_DIR_NAME)
  if (existsSync(directKeywordDir) && statSync(directKeywordDir).isDirectory()) return directKeywordDir

  const queue = [rootDir]
  while (queue.length > 0) {
    const current = queue.shift()!
    if (looksLikeKeywordDir(current)) return current
    for (const subdir of listSubdirectories(current)) queue.push(subdir)
  }
  return null
}

function resolveKeywordDir(dtpRoot: string, runtimeDir: string): string | null {
  return findKeywordDir(dtpRoot) ?? findKeywordDir(runtimeDir)
}

function loadKeywordCatalog(keywordDir: string): { keywordMap: Map<string, KeywordMeta>; warnings: string[] } {
  const keywordMap = new Map<string, KeywordMeta>()
  const warnings: string[] = []

  for (const entry of readdirSync(keywordDir, { withFileTypes: true })) {
    if (!entry.isFile() || extname(entry.name).toLowerCase() !== ".json") continue

    const sourceJsonPath = join(keywordDir, entry.name)
    let parsed: {
      Items?: Array<{
        Name?: string
        Arguments?: Array<{ Name?: string }>
      }>
    }

    try {
      parsed = safeReadJson(sourceJsonPath) as {
        Items?: Array<{
          Name?: string
          Arguments?: Array<{ Name?: string }>
        }>
      }
    } catch (error) {
      warnings.push(`Keyword JSON parse failed: ${sourceJsonPath} (${String(error)})`)
      continue
    }

    const sourceTxtCandidate = join(keywordDir, `${basename(entry.name, ".json")}.txt`)
    const sourceTxtPath = existsSync(sourceTxtCandidate) ? sourceTxtCandidate : null

    for (const item of parsed.Items ?? []) {
      const keywordName = String(item.Name ?? "").trim()
      if (!keywordName) continue
      if (keywordMap.has(keywordName)) {
        warnings.push(`Duplicate keyword ignored: ${keywordName}`)
        continue
      }

      keywordMap.set(keywordName, {
        keywordName,
        sourceJsonPath,
        sourceTxtPath,
        argumentNames: (item.Arguments ?? []).map((arg) => String(arg.Name ?? "").trim()).filter(Boolean),
      })
    }
  }

  return { keywordMap, warnings }
}

function findVteFiles(searchRoot: string): string[] {
  const files: string[] = []
  walkFiles(searchRoot, (filePath) => {
    if (extname(filePath).toLowerCase() === ".vte") files.push(filePath)
  })
  return files.sort((left, right) => left.length - right.length)
}

function pickBestVteFile(files: string[]): string | null {
  const nonCopies = files.filter((filePath) => !basename(filePath).includes("\u526f\u672c"))
  return (nonCopies.length > 0 ? nonCopies : files)[0] ?? null
}

function resolveVteFile(dtpRoot: string, runtimeDir: string): string | null {
  return pickBestVteFile(findVteFiles(runtimeDir)) ?? pickBestVteFile(findVteFiles(dtpRoot))
}

function listGeneratedDataArguments(raw: GeneratedDataStep["resolved_arguments"]): GeneratedDataArgument[] {
  if (Array.isArray(raw)) return raw
  if (!raw || typeof raw !== "object") return []

  return Object.entries(raw).map(([name, value]) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return { name, ...(value as Record<string, unknown>) }
    }
    return { name, value }
  })
}

function getGeneratedStepArguments(step: GeneratedDataStep): GeneratedDataArgument[] {
  const resolved = listGeneratedDataArguments(step.resolved_arguments)
  if (resolved.length > 0) return resolved
  return listGeneratedDataArguments(step.arguments)
}

function valueToRobotArgument(value: unknown): string {
  if (value === null || value === undefined) return ""
  const text = sanitizeDtpExecutablePlaceholders(String(value).trim())
  return /[\\/]/.test(text) ? toRobotPath(text) : text
}

function generatedStepArgumentValues(step: GeneratedDataStep): string[] {
  return getGeneratedStepArguments(step)
    .map((argument) => valueToRobotArgument(argument.value))
    .filter((value) => value.length > 0)
}

function generatedStepScheduledTimes(step: GeneratedDataStep): number[] {
  const values: number[] = []
  for (const argument of getGeneratedStepArguments(step)) {
    const name = String(argument.name ?? "").trim().toLowerCase()
    const semantic = String(argument.semantic ?? "").trim().toLowerCase()
    if (semantic !== "time" && name !== "${time}" && name !== "time") continue
    const numericValue = Number(argument.value)
    if (Number.isFinite(numericValue)) values.push(numericValue)
  }

  if (values.length > 0) return values
  return extractAllTimeValues(String(step.step_description ?? ""))
}

function extractAllTimeValues(text: string): number[] {
  const values: number[] = []
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*(?:\u79d2|s|S)/g)) {
    values.push(Number(match[1]))
  }
  return values
}

function computeTeardownValue(scheduledTimes: number[]): string {
  const finiteTimes = scheduledTimes.filter((value) => Number.isFinite(value))
  if (finiteTimes.length === 0) return "5"
  const value = Math.max(...finiteTimes) + 2.5
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "")
}

function loadGeneratedDataCases(generatedTestDataFile: string): {
  cases: GeneratedDataCase[]
  skippedCases: Array<{ caseId: string; reason: string }>
} {
  const parsed = safeReadJson(generatedTestDataFile) as Record<string, unknown>
  const schemaVersion = typeof parsed.schema_version === "string" ? parsed.schema_version : "1.0.0"
  if (schemaVersion !== "1.0.0" && schemaVersion !== "1.1.0") {
    throw new Error(`Unsupported generated-test-data.json schema_version: ${schemaVersion}`)
  }
  const rawCases = Array.isArray(parsed.cases) ? parsed.cases : []
  const normalized = rawCases
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => ({
      case_id: typeof item.case_id === "string" ? item.case_id : undefined,
      translate_status: typeof item.translate_status === "string" ? item.translate_status.trim() : undefined,
      case_name: typeof item.case_name === "string" ? item.case_name : undefined,
      test_purpose: typeof item.test_purpose === "string" ? item.test_purpose : undefined,
      test_environment: typeof item.test_environment === "string" ? item.test_environment.trim() : undefined,
      generated_steps: Array.isArray(item.generated_steps) ? (item.generated_steps as GeneratedDataStep[]) : [],
      warnings: Array.isArray(item.warnings) ? item.warnings.map((value) => String(value ?? "").trim()).filter(Boolean) : [],
    }))
    .filter((item) => (item.case_id ?? item.case_name ?? "").trim().length > 0)

  return {
    cases: normalized.filter((item) => (
      item.translate_status === "success" &&
      item.test_environment?.replace(/\s+/g, "") !== HARDWARE_TEST_ENVIRONMENT
    )),
    skippedCases: normalized.flatMap((item) => {
      const caseId = item.case_id ?? item.case_name ?? "unnamed"
      if (item.test_environment?.replace(/\s+/g, "") === HARDWARE_TEST_ENVIRONMENT) {
        return [{ caseId, reason: `test_environment is ${HARDWARE_TEST_ENVIRONMENT}` }]
      }
      if (item.translate_status !== "success") {
        return [{ caseId, reason: "translate_status is not success" }]
      }
      return []
    }),
  }
}

function generatedRobotOutputFile(outputDir: string, generatedCase: GeneratedDataCase): string {
  const caseName = generatedCase.case_id || generatedCase.case_name || "unnamed"
  return join(outputDir, `${sanitizeFilename(caseName)}.robot`)
}

function removeStaleGeneratedRobotFiles(
  resultFile: string,
  outputDir: string,
  generatedCases: GeneratedDataCase[],
): string[] {
  if (!existsSync(resultFile)) return []

  const currentFiles = new Set(generatedCases.map((item) => resolve(generatedRobotOutputFile(outputDir, item))))
  let parsed: Record<string, unknown>
  try {
    parsed = safeReadJson(resultFile) as Record<string, unknown>
  } catch {
    return []
  }
  const previousCases = Array.isArray(parsed.cases) ? parsed.cases : []
  const removed: string[] = []
  const resolvedOutputDir = resolve(outputDir)

  for (const previousCase of previousCases) {
    if (!previousCase || typeof previousCase !== "object") continue
    const outputFile = (previousCase as Record<string, unknown>).output_robot_file
    if (typeof outputFile !== "string" || !outputFile.trim()) continue
    const resolvedOutputFile = resolve(outputFile)
    const relativeToOutput = relative(resolvedOutputDir, resolvedOutputFile)
    if (
      relativeToOutput.startsWith("..") ||
      resolve(resolvedOutputDir, relativeToOutput) !== resolvedOutputFile ||
      extname(resolvedOutputFile).toLowerCase() !== ".robot" ||
      currentFiles.has(resolvedOutputFile) ||
      !existsSync(resolvedOutputFile)
    ) {
      continue
    }
    rmSync(resolvedOutputFile, { force: true })
    removed.push(resolvedOutputFile)
  }

  return removed
}

function collectResourceFiles(
  usedKeywords: Iterable<string>,
  keywordMap: Map<string, KeywordMeta>,
  dtpRoot: string,
  warnings: string[],
): string[] {
  const resources: string[] = []
  const seen = new Set<string>()

  for (const keywordName of usedKeywords) {
    const keyword = keywordMap.get(keywordName)
    if (!keyword) continue
    if (!keyword.sourceTxtPath) {
      warnings.push(`Keyword resource .txt missing: ${keywordName} (${keyword.sourceJsonPath})`)
      continue
    }

    const resource = toDtpRootRobotPath(dtpRoot, keyword.sourceTxtPath)
    if (!seen.has(resource)) {
      seen.add(resource)
      resources.push(resource)
    }
  }

  return resources
}

function renderGeneratedDataRobot(params: {
  generatedCase: GeneratedDataCase
  dtpRoot: string
  runtimeDir: string
  outputDir: string
  keywordMap: Map<string, KeywordMeta>
  vteFile: string | null
  generatedTestDataFile: string
}): { generated: GeneratedRobotFile; caseJson: RobotGenerationCaseJson } {
  const { generatedCase, dtpRoot, runtimeDir, outputDir, keywordMap, vteFile, generatedTestDataFile } = params
  const warnings: string[] = [...(generatedCase.warnings ?? [])]
  const caseName = generatedCase.case_id || generatedCase.case_name || "unnamed"
  const outputFile = generatedRobotOutputFile(outputDir, generatedCase)
  const vteRelative = vteFile ? toVteRobotPath(dtpRoot, runtimeDir, vteFile) : FALLBACK_VTE_PATH
  const descriptionKeyword = keywordMap.has(DESCRIPTION_KEYWORD) ? DESCRIPTION_KEYWORD : "Log"

  const usedKeywords = new Set<string>()
  for (const keywordName of [START_VTEST_KEYWORD, TEST_END_KEYWORD, descriptionKeyword]) {
    if (keywordMap.has(keywordName)) usedKeywords.add(keywordName)
  }

  const bodyLines: string[] = []
  const scheduledTimes: number[] = []
  let renderedStepCount = 0
  let downgradedStepCount = 0

  for (const step of generatedCase.generated_steps ?? []) {
    const keywordName = String(step.keyword_name ?? "").trim()
    const stepDescription = sanitizeDtpExecutablePlaceholders(String(step.step_description ?? "").trim())
    const stepLabel = `step ${step.step_index ?? renderedStepCount + downgradedStepCount + 1}`
    scheduledTimes.push(...generatedStepScheduledTimes(step))

    if (!keywordName || !keywordMap.has(keywordName)) {
      downgradedStepCount += 1
      const reason = keywordName ? `Keyword not found: ${keywordName}` : `Missing keyword_name for ${stepLabel}`
      warnings.push(`${stepLabel}: ${reason}; downgraded to description-style step.`)
      bodyLines.push(`    ${descriptionKeyword}    ${stepDescription || keywordName || stepLabel}`)
      continue
    }

    const argumentValues = generatedStepArgumentValues(step)
    const expectedCount = keywordMap.get(keywordName)?.argumentNames.length ?? 0
    if (expectedCount > 0 && argumentValues.length !== expectedCount) {
      warnings.push(`${caseName}/${stepLabel}: ${keywordName} expected ${expectedCount} argument(s), rendered ${argumentValues.length}.`)
    }

    usedKeywords.add(keywordName)
    renderedStepCount += 1
    bodyLines.push(`    ${[keywordName, ...argumentValues].join("    ")}`)
  }

  const teardownValue = computeTeardownValue(scheduledTimes)
  const lines = [
    "*** Settings ***",
    `Test Setup        ${START_VTEST_KEYWORD}    ${vteRelative}`,
    `Test Teardown        ${TEST_END_KEYWORD}    ${teardownValue}`,
  ]
  const resources = collectResourceFiles(usedKeywords, keywordMap, dtpRoot, warnings)
  for (const resource of resources) lines.push(`Resource    ${resource}`)

  lines.push("", "*** Variables ***", "", "", "*** Test Cases ***", caseName)
  if ((generatedCase.test_purpose ?? "").trim()) lines.push(`    [Documentation]    ${String(generatedCase.test_purpose).trim()}`)
  lines.push(`    [Setup]        ${START_VTEST_KEYWORD}    ${vteRelative}`)
  lines.push(...bodyLines)
  lines.push(`    [Teardown]        ${TEST_END_KEYWORD}    ${teardownValue}`)

  writeFileSync(outputFile, `${lines.join("\n")}\n`, "utf-8")

  return {
    generated: {
      sourceFile: generatedTestDataFile,
      caseName,
      outputFile,
      resources,
      warnings,
    },
    caseJson: {
      case_id: caseName,
      output_robot_file: outputFile,
      resource_files: resources,
      vte_file: vteFile ?? FALLBACK_VTE_PATH,
      rendered_step_count: renderedStepCount,
      downgraded_step_count: downgradedStepCount,
      warnings,
    },
  }
}

export function generateDtpRobotScripts(params?: {
  workspaceRoot?: string
  dtpRoot?: string
  generatedTestDataFile?: string
  confirmationTestsFile?: string
  requirementsFile?: string
}): { results: ProjectGenerationResult[]; warnings: string[] } {
  if (params?.confirmationTestsFile || params?.requirementsFile) {
    throw new Error("Legacy confirmation-tests robot generation has been removed. Run dtp_test_data_generate first and pass generated-test-data.json.")
  }

  const workspaceRoot = resolve(params?.workspaceRoot ?? process.cwd())
  const dtpRoot = params?.workspaceRoot
    ? resolvePathWithinWorkspace(workspaceRoot, params.dtpRoot ?? resolveDefaultDtpRoot(workspaceRoot), "dtp_root")
    : resolve(params?.dtpRoot ?? resolveDefaultDtpRoot(workspaceRoot))
  const requestedGeneratedTestDataFile = params?.workspaceRoot && params.generatedTestDataFile
    ? resolvePathWithinWorkspace(workspaceRoot, params.generatedTestDataFile, "generated_test_data_file")
    : params?.generatedTestDataFile
  const generatedTestDataFile = resolveGeneratedTestDataFile(workspaceRoot, requestedGeneratedTestDataFile)
  const warnings: string[] = []

  if (!existsSync(dtpRoot)) throw new Error(`DTP project root does not exist: ${dtpRoot}`)
  if (!generatedTestDataFile) throw new Error(`generated-test-data.json not found; default path is ${GENERATED_TEST_DATA_RELATIVE_PATH}`)

  const runtimeDir = resolveRuntimeDir(dtpRoot)
  const keywordDir = resolveKeywordDir(dtpRoot, runtimeDir)
  if (!keywordDir) throw new Error(`Keyword directory not found under DTP project root: ${dtpRoot}`)

  const outputDir = join(runtimeDir, TEST_CASE_DIR_NAME)
  ensureDirectory(outputDir)

  const generatedData = loadGeneratedDataCases(generatedTestDataFile)
  const generatedCases = generatedData.cases
  const robotGenerationResultFile = join(dirname(generatedTestDataFile), ROBOT_GENERATION_RESULT_FILE_NAME)
  warnings.push(...generatedData.skippedCases.map(
    ({ caseId, reason }) => `Case ${caseId} skipped because ${reason}.`,
  ))
  const removedRobotFiles = removeStaleGeneratedRobotFiles(
    robotGenerationResultFile,
    outputDir,
    generatedCases,
  )
  warnings.push(...removedRobotFiles.map((filePath) => `Removed stale generated Robot file: ${filePath}`))
  if (generatedCases.length === 0) {
    const emptyResult: RobotGenerationResultJson = {
      schema_version: "1.0.0",
      source_data_file: generatedTestDataFile,
      dtp_root: dtpRoot,
      runtime_dir: runtimeDir,
      output_dir: outputDir,
      cases: [],
      warnings: [...warnings, "No renderable cases were available after translate_status and test_environment filtering."],
    }
    writeFileSync(robotGenerationResultFile, `${JSON.stringify(emptyResult, null, 2)}\n`, "utf-8")
    throw new Error(`No renderable cases found in generated-test-data.json after translate_status and test_environment filtering: ${generatedTestDataFile}`)
  }

  const { keywordMap, warnings: keywordWarnings } = loadKeywordCatalog(keywordDir)
  warnings.push(...keywordWarnings)

  const projectWarnings: string[] = []
  const vteFile = resolveVteFile(dtpRoot, runtimeDir)
  if (!vteFile) projectWarnings.push(`No .vte file found under runtime project; fallback placeholder ${FALLBACK_VTE_PATH} will be used.`)

  const generatedFiles: GeneratedRobotFile[] = []
  const robotResult: RobotGenerationResultJson = {
    schema_version: "1.0.0",
    source_data_file: generatedTestDataFile,
    dtp_root: dtpRoot,
    runtime_dir: runtimeDir,
    output_dir: outputDir,
    cases: [],
    warnings: [...warnings, ...projectWarnings],
  }

  for (const generatedCase of generatedCases) {
    const rendered = renderGeneratedDataRobot({
      generatedCase,
      dtpRoot,
      runtimeDir,
      outputDir,
      keywordMap,
      vteFile,
      generatedTestDataFile,
    })
    generatedFiles.push(rendered.generated)
    robotResult.cases.push(rendered.caseJson)
    projectWarnings.push(...rendered.generated.warnings.map((warning) => `${rendered.generated.caseName}: ${warning}`))
  }

  robotResult.warnings = [...warnings, ...projectWarnings]
  writeFileSync(robotGenerationResultFile, `${JSON.stringify(robotResult, null, 2)}\n`, "utf-8")

  return {
    results: [
      {
        projectDir: runtimeDir,
        keywordDir,
        outputDir,
        vteFile,
        confirmationTestsFile: null,
        generatedTestDataFile,
        robotGenerationResultFile,
        requirementsFile: null,
        generatedFiles,
        warnings: projectWarnings,
        assetFileCount: 0,
        keywordMap,
      },
    ],
    warnings,
  }
}

export async function generateDtpRobotScriptsWithHooks(
  params?: {
    workspaceRoot?: string
    dtpRoot?: string
    generatedTestDataFile?: string
    confirmationTestsFile?: string
    requirementsFile?: string
  },
): Promise<{ results: ProjectGenerationResult[]; warnings: string[] }> {
  return generateDtpRobotScripts(params)
}

export function createDtpRobotGenerator(_client?: OpencodeClient | null): ToolDefinition {
  return tool({
    description:
      "Generate DTP Robot scripts from .matrix/data/dtp-generation/generated-test-data.json. " +
      "This render+validate stage validates keyword_name against the DTP keyword library, derives Resource lines, resolves .vte, and writes .robot files to DTPProject/V1/test-case output.",
    args: {
      dtp_root: tool.schema
        .string()
        .optional()
        .describe("DTPProject root directory inside the current OpenCode workspace. Defaults to .matrix/data/DTPProject, with DTPPrject fallback."),
      generated_test_data_file: tool.schema
        .string()
        .optional()
        .describe("generated-test-data.json path inside the current OpenCode workspace. Defaults to .matrix/data/dtp-generation/generated-test-data.json, with legacy root-path fallback."),
    },
    async execute({ dtp_root, generated_test_data_file }, context) {
      try {
        const workspaceRoot = resolve(context.directory)
        const { results, warnings } = generateDtpRobotScripts({
          workspaceRoot,
          dtpRoot: dtp_root,
          generatedTestDataFile: generated_test_data_file,
        })

        return JSON.stringify(
          {
            status: "success",
            dtp_root: results[0]?.keywordDir ? dirname(results[0].keywordDir) : resolveDefaultDtpRoot(workspaceRoot),
            generated_test_data_file: results[0]?.generatedTestDataFile,
            robot_generation_result_file: results[0]?.robotGenerationResultFile,
            project_count: results.length,
            generated_count: results.reduce((sum, item) => sum + item.generatedFiles.length, 0),
            results: results.map((item) => ({
              project_dir: item.projectDir,
              keyword_dir: item.keywordDir,
              output_dir: item.outputDir,
              vte_file: item.vteFile,
              generated_test_data_file: item.generatedTestDataFile,
              robot_generation_result_file: item.robotGenerationResultFile,
              generated_files: item.generatedFiles.map((generated) => ({
                source_file: generated.sourceFile,
                case_name: generated.caseName,
                output_file: generated.outputFile,
                resources: generated.resources,
                warnings: generated.warnings,
              })),
              warnings: item.warnings,
            })),
            warnings,
          },
          null,
          2,
        )
      } catch (error) {
        return JSON.stringify({
          status: "error",
          error: String(error),
        })
      }
    },
  })
}

export const dtpRobotGenerator: ToolDefinition = createDtpRobotGenerator()
