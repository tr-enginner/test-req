import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs"
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "path"
import { DataStructuresFile, type DataStructureEntry, type DataStructureKind } from "../schema/wiki"
import { ARTIFACT_PATHS } from "../shared/constants"
import { withFileLock } from "../shared/file-mutex"
import {
  analyzeCodeFile,
  analyzeDataStructuresFile,
  type AnalyzedDataStructure,
  type CodeParseWarning,
} from "./tree-sitter-code-analyzer"

type PreprocessedTarget = {
  parsePath: string
  reportedPath: string
  lineDelta: number
}

type UsageFunction = {
  id?: string
  name: string
  file_path: string
  line_range?: { start: number; end: number }
}

type UsageModule = {
  name: string
  path?: string
  functions: string[]
}

type UsageLedger = {
  projectName?: string
  functions: UsageFunction[]
  modules: UsageModule[]
}

type EnrichedDataStructure = AnalyzedDataStructure & {
  used_by_functions: string[]
  used_by_modules: string[]
}

const DATA_STRUCTURE_KINDS: DataStructureKind[] = ["struct", "union", "enum", "typedef", "GlobalVar"]

function resolveProjectPath(relativePath: string): string {
  return join(process.cwd(), relativePath)
}

function resolveUserPath(pathValue: string): string {
  return isAbsolute(pathValue) ? resolve(pathValue) : resolve(process.cwd(), pathValue)
}

function ensureDir(filePath: string): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"))
}

function hasReusableDataStructuresArtifact(path: string): boolean {
  try {
    return DataStructuresFile.safeParse(readJsonFile(path)).success
  } catch {
    return false
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null
}

function asLineRange(value: unknown): { start: number; end: number } | undefined {
  const record = asRecord(value)
  const start = record && typeof record.start === "number" ? record.start : null
  const end = record && typeof record.end === "number" ? record.end : null
  return start !== null && end !== null ? { start, end } : undefined
}

function collectCFiles(
  dir: string,
  files: string[],
  recursive: boolean,
  options?: { skipGeneratedDirs?: boolean },
): void {
  const entries = readdirSync(dir)
  for (const entry of entries) {
    if (options?.skipGeneratedDirs && shouldSkipGeneratedDir(entry)) {
      continue
    }
    const fullPath = join(dir, entry)
    const stat = statSync(fullPath)
    if (stat.isDirectory() && recursive) {
      collectCFiles(fullPath, files, recursive, options)
    } else if (stat.isFile() && isSourceFile(fullPath)) {
      files.push(fullPath)
    }
  }
}

function shouldSkipGeneratedDir(name: string): boolean {
  return name === ".matrix" || name === ".git" || name === "node_modules" || name === "dist"
}

function isSourceFile(pathValue: string): boolean {
  return [".c", ".h", ".cpp", ".hpp", ".cc", ".cxx"].includes(extname(pathValue).toLowerCase())
}

function collectInputFiles(pathValue: string | undefined, recursive: boolean, ledger: UsageLedger): string[] {
  if (pathValue) {
    const resolved = resolveUserPath(pathValue)
    if (!existsSync(resolved)) {
      throw new Error(`Path not found: ${pathValue}`)
    }
    const stat = statSync(resolved)
    if (stat.isDirectory()) {
      const files: string[] = []
      collectCFiles(resolved, files, recursive, { skipGeneratedDirs: true })
      return files.sort()
    }
    return isSourceFile(resolved) ? [resolved] : []
  }

  const ledgerFiles = uniquePreservingOrder([
    ...ledger.functions.map((fn) => fn.file_path),
    ...ledger.modules.map((module) => module.path).filter((item): item is string => Boolean(item)),
  ])
    .map((item) => resolveUserPath(item))
    .filter((item) => existsSync(item) && statSync(item).isFile() && isSourceFile(item))

  if (ledgerFiles.length > 0) {
    return ledgerFiles.sort()
  }

  const fallbackFiles: string[] = []
  collectCFiles(process.cwd(), fallbackFiles, recursive, { skipGeneratedDirs: true })
  return fallbackFiles.sort()
}

function buildPreprocessedMap(
  originalFiles: string[],
  preprocessedFiles: string[],
  projectRoot: string,
  originalInputPath: string,
): Map<string, PreprocessedTarget> {
  const map = new Map<string, PreprocessedTarget>()
  if (preprocessedFiles.length === 0) return map

  const originalByResolved = new Map(originalFiles.map((file) => [resolve(file).toLowerCase(), resolve(file)]))
  const originalByBaseName = new Map<string, string[]>()
  for (const file of originalFiles) {
    const key = basename(file).toLowerCase()
    const group = originalByBaseName.get(key) ?? []
    group.push(resolve(file))
    originalByBaseName.set(key, group)
  }

  for (const parsePath of preprocessedFiles) {
    const directive = readLineDirective(parsePath)
    const directivePath = directive
      ? resolveDirectivePath(directive.path, projectRoot)
      : null
    const fallbackPath = findOriginalByFallback(parsePath, originalFiles, originalByBaseName, originalInputPath)
    const originalPath = directivePath
      ? originalByResolved.get(resolve(directivePath).toLowerCase()) ??
        findOriginalByDirectiveSuffix(directive?.path ?? "", originalFiles) ??
        fallbackPath
      : fallbackPath

    if (!originalPath) continue

    const lineDelta = directive
      ? directive.originalStartLine - (directive.directiveLine + 1)
      : 0

    map.set(resolve(originalPath), {
      parsePath,
      reportedPath: existsSync(originalPath) ? originalPath : resolve(originalPath),
      lineDelta,
    })
  }

  return map
}

function readLineDirective(filePath: string): {
  directiveLine: number
  originalStartLine: number
  path: string
} | null {
  const lines = readFileSync(filePath, "utf-8").split("\n")
  for (let index = 0; index < Math.min(lines.length, 10); index++) {
    const match = lines[index].match(/^#line\s+(\d+)\s+"([^"]+)"/)
    if (match) {
      return {
        directiveLine: index + 1,
        originalStartLine: Number(match[1]),
        path: match[2],
      }
    }
  }
  return null
}

function resolveDirectivePath(directivePath: string, projectRoot: string): string {
  return isAbsolute(directivePath) ? resolve(directivePath) : resolve(projectRoot, directivePath)
}

function findOriginalByFallback(
  parsePath: string,
  originalFiles: string[],
  originalByBaseName: Map<string, string[]>,
  originalInputPath: string,
): string | null {
  const inputStat = existsSync(originalInputPath) ? statSync(originalInputPath) : null
  if (inputStat?.isDirectory()) {
    const relativeCandidate = resolve(originalInputPath, relative(dirname(parsePath), parsePath))
    const found = originalFiles.find((file) => resolve(file).toLowerCase() === relativeCandidate.toLowerCase())
    if (found) return resolve(found)
  }

  const basenameMatches = originalByBaseName.get(basename(parsePath).toLowerCase()) ?? []
  return basenameMatches.length === 1 ? basenameMatches[0] : null
}

function findOriginalByDirectiveSuffix(directivePath: string, originalFiles: string[]): string | null {
  const normalizedDirective = directivePath.replace(/\\/g, "/").toLowerCase()
  const matches = originalFiles.filter((file) =>
    resolve(file).replace(/\\/g, "/").toLowerCase().endsWith(normalizedDirective),
  )
  return matches.length === 1 ? resolve(matches[0]) : null
}

function inferProjectRoot(originalPath: string | undefined, preprocessedPath?: string): string {
  if (preprocessedPath) {
    const normalized = resolve(preprocessedPath).replace(/\\/g, "/")
    const marker = "/.matrix/preprocessed"
    const markerIndex = normalized.indexOf(marker)
    if (markerIndex >= 0) {
      return normalized.slice(0, markerIndex)
    }
  }

  if (originalPath) {
    const resolvedOriginal = resolveUserPath(originalPath)
    if (existsSync(resolvedOriginal) && statSync(resolvedOriginal).isDirectory()) {
      return resolvedOriginal
    }
    return dirname(resolvedOriginal)
  }

  return process.cwd()
}

function collectPreprocessedFiles(preprocessedPath: string | undefined, recursive: boolean): string[] {
  if (!preprocessedPath || !existsSync(preprocessedPath)) return []

  const resolved = resolveUserPath(preprocessedPath)
  const stat = statSync(resolved)
  if (stat.isDirectory()) {
    const files: string[] = []
    collectCFiles(resolved, files, recursive, { skipGeneratedDirs: false })
    return files.sort()
  }

  return isSourceFile(resolved) ? [resolved] : []
}

function loadUsageLedger(): UsageLedger {
  const analysis = loadUsageLedgerFromSoftwareAnalysis()
  if (analysis) return analysis
  return loadUsageLedgerFromStage03() ?? { functions: [], modules: [] }
}

function loadUsageLedgerFromSoftwareAnalysis(): UsageLedger | null {
  const path = resolveProjectPath(ARTIFACT_PATHS.SOFTWARE_ANALYSIS)
  if (!existsSync(path)) return null

  const root = asRecord(readJsonFile(path))
  if (!root) return null

  return {
    projectName: asString(root.project_name) ?? undefined,
    functions: parseFunctions(root.functions),
    modules: parseModules(root.modules),
  }
}

function loadUsageLedgerFromStage03(): UsageLedger | null {
  const path = resolveProjectPath(ARTIFACT_PATHS.SOFTWARE_ANALYSIS_STAGE_03_CODE)
  if (!existsSync(path)) return null

  const root = asRecord(readJsonFile(path))
  const payload = asRecord(root?.payload)
  if (!payload) return null

  const functions = [
    ...parseFunctions(payload.function_index),
    ...parseFunctions(payload.functions),
    ...loadStage03ChunkFunctions(payload.function_chunks),
  ]
  const byName = new Map<string, UsageFunction>()
  for (const fn of functions) {
    if (!byName.has(fn.name)) byName.set(fn.name, fn)
  }

  return {
    functions: [...byName.values()],
    modules: parseModules(payload.modules),
  }
}

function loadStage03ChunkFunctions(value: unknown): UsageFunction[] {
  if (!Array.isArray(value)) return []

  const functions: UsageFunction[] = []
  for (const item of value) {
    const record = asRecord(item)
    const filePath = asString(record?.file_path)
    if (!filePath) continue

    const absolutePath = resolveProjectPath(filePath)
    if (!existsSync(absolutePath)) continue

    const chunk = asRecord(readJsonFile(absolutePath))
    functions.push(...parseFunctions(chunk?.functions))
  }
  return functions
}

function parseFunctions(value: unknown): UsageFunction[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((item) => {
    const record = asRecord(item)
    const name = asString(record?.name)
    const filePath = asString(record?.file_path)
    if (!record || !name || !filePath) return []

    return [{
      id: asString(record.id) ?? undefined,
      name,
      file_path: filePath,
      line_range: asLineRange(record.line_range),
    }]
  })
}

function parseModules(value: unknown): UsageModule[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((item) => {
    const record = asRecord(item)
    const name = asString(record?.name)
    if (!record || !name) return []

    return [{
      name,
      path: asString(record.path) ?? undefined,
      functions: Array.isArray(record.functions)
        ? record.functions.filter((fn): fn is string => typeof fn === "string")
        : [],
    }]
  })
}

async function buildSourceUsageLedger(
  files: string[],
  preprocessedMap: Map<string, PreprocessedTarget>,
  projectName?: string,
): Promise<{ ledger: UsageLedger; warnings: CodeParseWarning[] }> {
  const functions: UsageFunction[] = []
  const moduleMap = new Map<string, UsageModule>()
  const warnings: CodeParseWarning[] = []

  for (const filePath of files) {
    const originalContent = readFileSync(filePath, "utf-8")
    const target = preprocessedMap.get(resolve(filePath))
    const parsePath = target?.parsePath ?? filePath
    const parseContent = readFileSync(parsePath, "utf-8")
    const analysis = await analyzeCodeFile({
      originalPath: filePath,
      parsePath,
      reportedPath: target?.reportedPath ?? filePath,
      parseContent,
      originalContent,
      lineDelta: target?.lineDelta ?? 0,
      includeBodies: false,
    })

    warnings.push(...analysis.warnings)
    const moduleName = basename(filePath, extname(filePath))
    const module = moduleMap.get(moduleName) ?? {
      name: moduleName,
      path: target?.reportedPath ?? filePath,
      functions: [],
    }
    moduleMap.set(moduleName, module)

    for (const fn of analysis.functions) {
      const id = `${moduleName}:${fn.name}:${fn.line_range.start}`
      functions.push({
        id,
        name: fn.name,
        file_path: fn.file_path,
        line_range: fn.line_range,
      })
      module.functions.push(id)
    }
  }

  return {
    ledger: {
      projectName,
      functions,
      modules: [...moduleMap.values()],
    },
    warnings,
  }
}

function enrichUsage(
  structures: AnalyzedDataStructure[],
  ledger: UsageLedger,
): EnrichedDataStructure[] {
  const fileCache = new Map<string, string[]>()
  const moduleByFunctionRef = new Map<string, string[]>()

  for (const module of ledger.modules) {
    for (const fnRef of module.functions) {
      const refs = moduleByFunctionRef.get(fnRef) ?? []
      refs.push(module.name)
      moduleByFunctionRef.set(fnRef, refs)
    }
  }

  return structures.map((structure) => {
    const usagePattern = new RegExp(`\\b${escapeRegExp(structure.name)}\\b`)
    const usedFunctions = ledger.functions
      .filter((fn) => functionUsesName(fn, usagePattern, fileCache))
      .map((fn) => fn.name)

    const usedByFunctionSet = new Set(usedFunctions)
    const usedModules = new Set<string>()
    for (const fn of ledger.functions) {
      if (!usedByFunctionSet.has(fn.name)) continue
      for (const moduleName of [
        ...(fn.id ? moduleByFunctionRef.get(fn.id) ?? [] : []),
        ...(moduleByFunctionRef.get(fn.name) ?? []),
      ]) {
        usedModules.add(moduleName)
      }
    }

    for (const module of ledger.modules) {
      if (usedModules.has(module.name)) continue
      if (module.path && fileUsesName(module.path, usagePattern, fileCache)) {
        usedModules.add(module.name)
      }
    }

    return {
      ...structure,
      used_by_functions: uniquePreservingOrder(usedFunctions),
      used_by_modules: [...usedModules].sort(),
    }
  })
}

function bucketDataStructures(items: EnrichedDataStructure[]): Pick<DataStructuresFile, DataStructureKind> {
  const buckets: Pick<DataStructuresFile, DataStructureKind> = {
    struct: [],
    union: [],
    enum: [],
    typedef: [],
    GlobalVar: [],
  }

  for (const item of items) {
    const { kind, ...entry } = item
    buckets[kind].push(entry satisfies DataStructureEntry)
  }

  return buckets
}

function countDataStructures(artifact: DataStructuresFile): number {
  return DATA_STRUCTURE_KINDS.reduce((total, kind) => total + artifact[kind].length, 0)
}

function functionUsesName(
  fn: UsageFunction,
  pattern: RegExp,
  fileCache: Map<string, string[]>,
): boolean {
  const lines = readFileLines(fn.file_path, fileCache)
  if (!lines) return false

  if (!fn.line_range) {
    return pattern.test(lines.join("\n"))
  }

  const start = Math.max(0, fn.line_range.start - 1)
  const end = Math.min(lines.length, fn.line_range.end)
  return pattern.test(lines.slice(start, end).join("\n"))
}

function fileUsesName(
  filePath: string,
  pattern: RegExp,
  fileCache: Map<string, string[]>,
): boolean {
  const lines = readFileLines(filePath, fileCache)
  return lines ? pattern.test(lines.join("\n")) : false
}

function readFileLines(filePath: string, fileCache: Map<string, string[]>): string[] | null {
  const resolved = resolveUserPath(filePath)
  if (fileCache.has(resolved)) return fileCache.get(resolved)!
  if (!existsSync(resolved) || !statSync(resolved).isFile()) return null

  const lines = readFileSync(resolved, "utf-8").split("\n")
  fileCache.set(resolved, lines)
  return lines
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function uniquePreservingOrder<T>(values: T[]): T[] {
  const seen = new Set<T>()
  const unique: T[] = []
  for (const value of values) {
    if (seen.has(value)) continue
    seen.add(value)
    unique.push(value)
  }
  return unique
}

function uniqueParseWarnings(warnings: CodeParseWarning[]): CodeParseWarning[] {
  const seen = new Set<string>()
  const unique: CodeParseWarning[] = []
  for (const warning of warnings) {
    const key = JSON.stringify(warning)
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(warning)
  }
  return unique
}

export const wikiDataStructuresExtract: ToolDefinition = tool({
  description:
    "Extract C/C++ data structures and GlobalVar global variables with Tree-sitter and write the canonical " +
    ".matrix/wiki/data-structures.json artifact for Phase 1b code understanding. The output intentionally omits all description fields.",
  args: {
    path: tool.schema
      .string()
      .optional()
      .describe("Optional C/C++ source file or directory. Defaults to Phase 1 source files, then the project root."),
    recursive: tool.schema
      .boolean()
      .optional()
      .describe("If path is a directory, scan recursively. Default: true."),
    preprocessed_path: tool.schema
      .string()
      .optional()
      .describe("Optional preprocessed source file or directory, usually .matrix/preprocessed."),
    output_file: tool.schema
      .string()
      .optional()
      .describe("Optional output JSON path. Defaults to .matrix/wiki/data-structures.json."),
    force: tool.schema
      .boolean()
      .optional()
      .describe("When true, overwrite even if a current schema-valid data-structures artifact exists."),
  },
  async execute({ path, recursive = true, preprocessed_path, output_file, force = false }) {
    const outputPath = output_file
      ? resolveUserPath(output_file)
      : resolveProjectPath(ARTIFACT_PATHS.WIKI_DATA_STRUCTURES)

    return await withFileLock(outputPath, async () => {
      try {
        if (!force && existsSync(outputPath)) {
          if (hasReusableDataStructuresArtifact(outputPath)) {
            const existing = DataStructuresFile.parse(readJsonFile(outputPath))
            return JSON.stringify({
              status: "success",
              action: "reused_existing_artifact",
              output_file: output_file ?? ARTIFACT_PATHS.WIKI_DATA_STRUCTURES,
              structures: countDataStructures(existing),
            })
          }
        }

        let ledger = loadUsageLedger()
        const files = collectInputFiles(path, recursive, ledger)
        const preprocessedFiles = collectPreprocessedFiles(preprocessed_path, recursive)
        const projectRoot = inferProjectRoot(path, preprocessed_path)
        const preprocessedMap = buildPreprocessedMap(files, preprocessedFiles, projectRoot, path ? resolveUserPath(path) : process.cwd())
        const parseWarnings: CodeParseWarning[] = []
        const structures: AnalyzedDataStructure[] = []

        if (ledger.functions.length === 0 && files.length > 0) {
          const sourceLedger = await buildSourceUsageLedger(
            files,
            preprocessedMap,
            ledger.projectName ?? basename(process.cwd()),
          )
          ledger = sourceLedger.ledger
          parseWarnings.push(...sourceLedger.warnings)
        }

        for (const filePath of files) {
          const originalContent = readFileSync(filePath, "utf-8")
          const target = preprocessedMap.get(resolve(filePath))
          const parsePath = target?.parsePath ?? filePath
          const parseContent = readFileSync(parsePath, "utf-8")
          const analysis = await analyzeDataStructuresFile({
            originalPath: filePath,
            parsePath,
            reportedPath: target?.reportedPath ?? filePath,
            parseContent,
            originalContent,
            lineDelta: target?.lineDelta ?? 0,
          })

          parseWarnings.push(...analysis.warnings)
          structures.push(...analysis.structures)
        }

        const enrichedStructures = enrichUsage(structures, ledger)
        const artifact = DataStructuresFile.parse({
          schema_version: 3,
          project_name: ledger.projectName ?? basename(process.cwd()),
          created_date: new Date().toISOString(),
          ...bucketDataStructures(enrichedStructures),
        })

        ensureDir(outputPath)
        writeFileSync(outputPath, JSON.stringify(artifact, null, 2), "utf-8")

        const uniqueWarnings = uniqueParseWarnings(parseWarnings)

        return JSON.stringify({
          status: "success",
          action: "extracted_data_structures",
          output_file: output_file ?? ARTIFACT_PATHS.WIKI_DATA_STRUCTURES,
          files_parsed: files.length,
          structures: countDataStructures(artifact),
          ...(uniqueWarnings.length > 0 ? { parse_warnings: uniqueWarnings } : {}),
        })
      } catch (error) {
        return JSON.stringify({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        })
      }
    })
  },
})
