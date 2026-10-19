import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { basename, dirname, isAbsolute, join, resolve } from "path"
import { z } from "zod"
import { SoftwareAnalysisReport } from "../schema/sut"
import {
  Architecture,
  DataFlowPath,
  DataStructuresFile,
  FunctionWiki,
  ModuleWiki,
  parseFunctionWikiLenient,
  TechStack,
  WikiFunctionEntry,
  WikiFunctionIndexChunk,
  WikiFunctionIndexChunkRef,
  WikiIndex,
  WikiDataStructure,
  WikiModuleEntry,
} from "../schema/wiki"
import {
  ARTIFACT_PATHS,
  WIKI_FUNCTIONS_DIR,
  WIKI_INDEX_FUNCTION_CHUNK_SIZE,
  WIKI_MODULES_DIR,
} from "../shared/constants"
import { withFileLock } from "../shared/file-mutex"

const WikiIndexFinalizePayload = z.object({
  project_name: z.string().optional(),
  version: z.string().optional(),
  created_date: z.string().optional(),
  overview: z.string(),
  tech_stack: TechStack,
  architecture: Architecture,
  data_flow_paths: z.array(DataFlowPath).default([]),
})

type AnalysisFunctionMetadata = {
  id: string
  name: string
  file_path: string
  safety_critical: boolean
}

type FunctionWikiIndexSource = {
  id: string
  name: string
  file_path: string
  module_id: string
}

type FunctionWikiLoadResult = {
  wikis: FunctionWikiIndexSource[]
  warnings: string[]
}

type SoftwareAnalysisMetadataResult = {
  project_name?: string
  version?: string
  functionsByName: Map<string, AnalysisFunctionMetadata>
  warnings: string[]
}

type ModuleWikiIndexSource = {
  id: string
  name: string
  files: string[]
  responsibility: string
}

type ModuleWikiLoadResult = {
  modules: ModuleWikiIndexSource[]
  warnings: string[]
}

const DATA_STRUCTURE_KINDS = ["struct", "union", "enum", "typedef", "GlobalVar"] as const

type DataStructureSummaryEntry = z.infer<typeof WikiDataStructure>

type DataStructureSummaryLoadResult = {
  dataStructures: DataStructureSummaryEntry[]
  warnings: string[]
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function booleanField(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key]
  return typeof value === "boolean" ? value : undefined
}

function stringArrayField(record: Record<string, unknown>, key: string): string[] {
  const value = record[key]
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
  }
  const text = stringField(record, key)
  return text ? [text] : []
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const value of values) {
    if (seen.has(value)) continue
    seen.add(value)
    unique.push(value)
  }
  return unique
}

function functionNameFromPath(filePath: string): string {
  return basename(filePath).replace(/\.json$/i, "")
}

function moduleNameFromPath(filePath: string): string {
  return basename(filePath).replace(/\.json$/i, "")
}

function buildBestEffortFunctionWikiSource(filePath: string, raw: unknown): FunctionWikiIndexSource {
  const record = isRecord(raw) ? raw : {}
  const name = stringField(record, "name") ?? stringField(record, "function_name") ?? stringField(record, "functionName") ?? functionNameFromPath(filePath)

  return {
    id: stringField(record, "id") ?? stringField(record, "function_id") ?? stringField(record, "functionId") ?? name,
    name,
    file_path: stringField(record, "file_path") ?? stringField(record, "filePath") ?? "",
    module_id: stringField(record, "module_id") ?? stringField(record, "moduleId") ?? stringField(record, "module_name") ?? stringField(record, "moduleName") ?? "unknown",
  }
}

function buildBestEffortSoftwareAnalysisMetadata(raw: unknown): Omit<SoftwareAnalysisMetadataResult, "warnings"> {
  const record = isRecord(raw) ? raw : {}
  const functionsByName = new Map<string, AnalysisFunctionMetadata>()
  const rawFunctions = Array.isArray(record.functions) ? record.functions : []

  for (const rawFunction of rawFunctions) {
    if (!isRecord(rawFunction)) continue
    const name = stringField(rawFunction, "name") ?? stringField(rawFunction, "function_name") ?? stringField(rawFunction, "functionName")
    if (!name || functionsByName.has(name)) continue
    functionsByName.set(name, {
      id: stringField(rawFunction, "id") ?? stringField(rawFunction, "function_id") ?? stringField(rawFunction, "functionId") ?? name,
      name,
      file_path: stringField(rawFunction, "file_path") ?? stringField(rawFunction, "filePath") ?? stringField(rawFunction, "path") ?? "",
      safety_critical: booleanField(rawFunction, "safety_critical") ?? booleanField(rawFunction, "safetyCritical") ?? false,
    })
  }

  return {
    project_name: stringField(record, "project_name") ?? stringField(record, "projectName"),
    version: stringField(record, "version"),
    functionsByName,
  }
}

function loadSoftwareAnalysisMetadata(): SoftwareAnalysisMetadataResult {
  const analysisPath = resolveProjectPath(ARTIFACT_PATHS.SOFTWARE_ANALYSIS)
  if (!existsSync(analysisPath)) {
    return {
      functionsByName: new Map<string, AnalysisFunctionMetadata>(),
      warnings: [],
    }
  }

  let raw: unknown
  try {
    raw = readJsonFile(analysisPath)
  } catch (error) {
    return {
      functionsByName: new Map<string, AnalysisFunctionMetadata>(),
      warnings: [`Skipped software-analysis schema enforcement for ${analysisPath}: invalid_json (${error instanceof Error ? error.message : String(error)})`],
    }
  }

  const parsed = SoftwareAnalysisReport.safeParse(raw)
  if (!parsed.success) {
    const bestEffort = buildBestEffortSoftwareAnalysisMetadata(raw)
    return {
      ...bestEffort,
      warnings: [`Skipped software-analysis schema enforcement for ${analysisPath}: invalid_schema (${parsed.error.message})`],
    }
  }

  const functionsByName = new Map<string, AnalysisFunctionMetadata>()
  for (const fn of parsed.data.functions) {
    if (functionsByName.has(fn.name)) {
      continue
    }
    functionsByName.set(fn.name, {
      id: fn.id,
      name: fn.name,
      file_path: fn.file_path,
      safety_critical: fn.safety_critical,
    })
  }

  return {
    project_name: parsed.data.project_name,
    version: parsed.data.version,
    functionsByName,
    warnings: [],
  }
}

function listJsonFiles(relativeDir: string): string[] {
  const absoluteDir = resolveProjectPath(relativeDir)
  if (!existsSync(absoluteDir)) return []
  return readdirSync(absoluteDir)
    .filter((file) => file.toLowerCase().endsWith(".json"))
    .sort()
    .map((file) => join(absoluteDir, file))
}

function loadFunctionWikis(): FunctionWikiLoadResult {
  const wikis: FunctionWikiIndexSource[] = []
  const warnings: string[] = []

  for (const filePath of listJsonFiles(WIKI_FUNCTIONS_DIR)) {
    let raw: unknown
    try {
      raw = readJsonFile(filePath)
    } catch (error) {
      warnings.push(`Skipped FunctionWiki schema enforcement for ${filePath}: invalid_json (${error instanceof Error ? error.message : String(error)})`)
      wikis.push(buildBestEffortFunctionWikiSource(filePath, undefined))
      continue
    }

    const parsed = parseFunctionWikiLenient(raw)
    if (!parsed) {
      const strict = FunctionWiki.safeParse(raw)
      warnings.push(`Skipped FunctionWiki schema enforcement for ${filePath}: invalid_schema (${strict.success ? "unknown validation failure" : strict.error.message})`)
      wikis.push(buildBestEffortFunctionWikiSource(filePath, raw))
      continue
    }
    if (parsed.repaired) {
      warnings.push(`Skipped FunctionWiki schema rewrite for ${filePath}: used lenient normalized data in memory`)
    }
    wikis.push(parsed.data)
  }

  return { wikis, warnings }
}

function buildBestEffortModuleWikiSource(filePath: string, raw: unknown): ModuleWikiIndexSource {
  const record = isRecord(raw) ? raw : {}
  const name = stringField(record, "name") ?? stringField(record, "module_name") ?? stringField(record, "moduleName") ?? moduleNameFromPath(filePath)
  const files = uniqueStrings([
    ...stringArrayField(record, "files"),
    ...stringArrayField(record, "file_paths"),
    ...stringArrayField(record, "filePaths"),
    ...stringArrayField(record, "source_paths"),
    ...stringArrayField(record, "sourcePaths"),
    ...stringArrayField(record, "file_path"),
    ...stringArrayField(record, "filePath"),
    ...stringArrayField(record, "path"),
  ])

  return {
    id: stringField(record, "id") ?? stringField(record, "module_id") ?? stringField(record, "moduleId") ?? name,
    name,
    files,
    responsibility: stringField(record, "responsibility") ?? stringField(record, "description") ?? stringField(record, "summary") ?? `${name} module`,
  }
}

function loadModuleWikis(): ModuleWikiLoadResult {
  const modules: ModuleWikiIndexSource[] = []
  const warnings: string[] = []

  for (const filePath of listJsonFiles(WIKI_MODULES_DIR)) {
    let raw: unknown
    try {
      raw = readJsonFile(filePath)
    } catch (error) {
      warnings.push(`Skipped ModuleWiki schema enforcement for ${filePath}: invalid_json (${error instanceof Error ? error.message : String(error)})`)
      modules.push(buildBestEffortModuleWikiSource(filePath, undefined))
      continue
    }

    const parsed = ModuleWiki.safeParse(raw)
    if (!parsed.success) {
      warnings.push(`Skipped ModuleWiki schema enforcement for ${filePath}: invalid_schema (${parsed.error.message})`)
      modules.push(buildBestEffortModuleWikiSource(filePath, raw))
      continue
    }
    modules.push(parsed.data)
  }

  return { modules, warnings }
}

function isDataStructureKind(value: unknown): value is DataStructureSummaryEntry["kind"] {
  return typeof value === "string" && DATA_STRUCTURE_KINDS.includes(value as DataStructureSummaryEntry["kind"])
}

function dataStructureNameFromRecord(record: Record<string, unknown>): string | undefined {
  return (
    stringField(record, "name") ??
    stringField(record, "variable_name") ??
    stringField(record, "variableName") ??
    stringField(record, "type_name") ??
    stringField(record, "typeName")
  )
}

function dataStructureSummaryFromRecord(
  record: Record<string, unknown>,
  defaultKind: DataStructureSummaryEntry["kind"],
): DataStructureSummaryEntry | undefined {
  const name = dataStructureNameFromRecord(record)
  if (!name) return undefined

  const rawKind = record.kind
  return {
    name,
    file_path: stringField(record, "file_path") ?? stringField(record, "filePath") ?? stringField(record, "path") ?? "",
    kind: isDataStructureKind(rawKind) ? rawKind : defaultKind,
  }
}

function buildBestEffortDataStructureSummary(raw: unknown): DataStructureSummaryEntry[] {
  const record = isRecord(raw) ? raw : {}
  const entries: DataStructureSummaryEntry[] = []
  const seen = new Set<string>()

  const addEntry = (entry: DataStructureSummaryEntry | undefined) => {
    if (!entry) return
    const key = `${entry.kind}\0${entry.name}\0${entry.file_path}`
    if (seen.has(key)) return
    seen.add(key)
    entries.push(entry)
  }

  for (const kind of DATA_STRUCTURE_KINDS) {
    const bucket = record[kind]
    if (!Array.isArray(bucket)) continue
    for (const item of bucket) {
      if (isRecord(item)) addEntry(dataStructureSummaryFromRecord(item, kind))
    }
  }

  for (const legacyKey of ["structures", "data_structures", "dataStructures"]) {
    const legacyEntries = record[legacyKey]
    if (!Array.isArray(legacyEntries)) continue
    for (const item of legacyEntries) {
      if (isRecord(item)) addEntry(dataStructureSummaryFromRecord(item, "struct"))
    }
  }

  return entries
}

function loadDataStructureSummary(): DataStructureSummaryLoadResult {
  const path = resolveProjectPath(ARTIFACT_PATHS.WIKI_DATA_STRUCTURES)
  if (!existsSync(path)) return { dataStructures: [], warnings: [] }

  let raw: unknown
  try {
    raw = readJsonFile(path)
  } catch (error) {
    return {
      dataStructures: [],
      warnings: [`Skipped data-structures schema enforcement for ${path}: invalid_json (${error instanceof Error ? error.message : String(error)})`],
    }
  }

  const parsed = DataStructuresFile.safeParse(raw)
  if (!parsed.success) {
    return {
      dataStructures: buildBestEffortDataStructureSummary(raw),
      warnings: [`Skipped data-structures schema enforcement for ${path}: invalid_schema (${parsed.error.message})`],
    }
  }

  return {
    dataStructures: DATA_STRUCTURE_KINDS.flatMap((kind) =>
      parsed.data[kind].map((item) => ({
        name: item.name,
        file_path: item.file_path,
        kind,
      })),
    ),
    warnings: [],
  }
}

function stageIndexChunkPath(chunkIndex: number): string {
  return `${ARTIFACT_PATHS.WIKI_INDEX_FUNCTIONS_DIR}/chunk-${String(chunkIndex + 1).padStart(4, "0")}.json`
}

function writeFunctionIndexChunks(functionIndex: Record<string, z.infer<typeof WikiFunctionEntry>>, createdDate: string) {
  const entries = Object.entries(functionIndex).sort(([left], [right]) => left.localeCompare(right))
  const chunkDir = resolveProjectPath(ARTIFACT_PATHS.WIKI_INDEX_FUNCTIONS_DIR)
  rmSync(chunkDir, { recursive: true, force: true })
  mkdirSync(chunkDir, { recursive: true })

  const chunkRefs: z.infer<typeof WikiFunctionIndexChunkRef>[] = []
  for (let start = 0, chunkIndex = 0; start < entries.length; start += WIKI_INDEX_FUNCTION_CHUNK_SIZE, chunkIndex++) {
    const chunkEntries = Object.fromEntries(entries.slice(start, start + WIKI_INDEX_FUNCTION_CHUNK_SIZE))
    const chunkPath = stageIndexChunkPath(chunkIndex)
    const chunkArtifact = WikiFunctionIndexChunk.parse({
      artifact_type: "wiki-function-index-chunk",
      schema_version: 1,
      chunk_index: chunkIndex,
      created_date: createdDate,
      entries: chunkEntries,
    })
    const absoluteChunkPath = resolveProjectPath(chunkPath)
    ensureDir(absoluteChunkPath)
    writeFileSync(absoluteChunkPath, JSON.stringify(chunkArtifact, null, 2), "utf-8")
    const chunkNames = Object.keys(chunkEntries)
    chunkRefs.push({
      chunk_index: chunkIndex,
      file_path: chunkPath,
      entry_count: chunkNames.length,
      first_function_name: chunkNames[0],
      last_function_name: chunkNames[chunkNames.length - 1],
    })
  }
  return chunkRefs
}

function buildFunctionIndex(
  functionWikis: FunctionWikiIndexSource[],
  analysisByName: Map<string, AnalysisFunctionMetadata>,
): Record<string, z.infer<typeof WikiFunctionEntry>> {
  const functionIndex: Record<string, z.infer<typeof WikiFunctionEntry>> = {}

  for (const wiki of functionWikis) {
    if (functionIndex[wiki.name]) {
      continue
    }
    const analysis = analysisByName.get(wiki.name)
    functionIndex[wiki.name] = {
      id: analysis?.id ?? wiki.id,
      module_id: wiki.module_id,
      file_path: analysis?.file_path ?? wiki.file_path,
      safety_critical: analysis?.safety_critical ?? false,
    }
  }

  return functionIndex
}

function buildModuleEntries(
  moduleWikis: ModuleWikiIndexSource[],
  functionIndex: Record<string, z.infer<typeof WikiFunctionEntry>>,
): z.infer<typeof WikiModuleEntry>[] {
  return moduleWikis
    .map((wiki) => {
      const moduleFunctions = Object.entries(functionIndex).filter(([, entry]) => entry.module_id === wiki.id)
      return WikiModuleEntry.parse({
        id: wiki.id,
        name: wiki.name,
        files: wiki.files,
        description: wiki.responsibility,
        function_count: moduleFunctions.length,
        safety_critical: moduleFunctions.some(([, entry]) => entry.safety_critical),
      })
    })
    .sort((left, right) => left.name.localeCompare(right.name))
}

export const wikiArtifacts: ToolDefinition = tool({
  description:
    "Generate the canonical .matrix/wiki/index.json and chunked function-index side artifacts " +
    "from existing Phase 1b wiki files so the model does not need to hand-write a large function index.",
  args: {
    mode: tool.schema.enum(["finalize_index"]).describe("Finalize the global wiki index from existing function/module wiki artifacts."),
    payload: tool.schema
      .object({})
      .passthrough()
      .optional()
      .describe("Structured wiki-index summary payload. Preferred over payload_json when passing native tool arguments."),
    payload_json: tool.schema
      .union([tool.schema.string(), tool.schema.object({}).passthrough()])
      .optional()
      .describe("Wiki-index summary payload as JSON string or object."),
    payload_file: tool.schema
      .string()
      .optional()
      .describe("Optional JSON file containing the wiki-index summary payload."),
  },
  async execute({ payload, payload_json, payload_file }) {
    const lockPath = resolveProjectPath(ARTIFACT_PATHS.WIKI_INDEX)

    return await withFileLock(lockPath, async () => {
      try {
        const payloadSource = payload_file
          ? readFileSync(resolveUserPath(payload_file), "utf-8")
          : payload !== undefined
            ? payload
            : payload_json
        if (payloadSource === undefined) {
          return JSON.stringify({ error: "payload, payload_json, or payload_file is required when mode=finalize_index" })
        }

        const parsedPayload = WikiIndexFinalizePayload.parse(
          typeof payloadSource === "string" ? JSON.parse(payloadSource) : payloadSource,
        )
        const createdDate = parsedPayload.created_date ?? new Date().toISOString()
        const softwareAnalysis = loadSoftwareAnalysisMetadata()
        const functionWikiResult = loadFunctionWikis()
        const moduleWikiResult = loadModuleWikis()
        const functionIndex = buildFunctionIndex(functionWikiResult.wikis, softwareAnalysis.functionsByName)
        const functionIndexChunks = writeFunctionIndexChunks(functionIndex, createdDate)
        const modules = buildModuleEntries(moduleWikiResult.modules, functionIndex)
        const dataStructureResult = loadDataStructureSummary()
        const warnings = [
          ...softwareAnalysis.warnings,
          ...functionWikiResult.warnings,
          ...moduleWikiResult.warnings,
          ...dataStructureResult.warnings,
        ]

        const wikiIndex = WikiIndex.parse({
          project_name: parsedPayload.project_name ?? softwareAnalysis.project_name ?? basename(process.cwd()),
          version: parsedPayload.version ?? softwareAnalysis.version ?? "unknown",
          created_date: createdDate,
          overview: parsedPayload.overview,
          tech_stack: parsedPayload.tech_stack,
          architecture: parsedPayload.architecture,
          modules,
          function_index: functionIndex,
          function_index_chunks: functionIndexChunks,
          data_structures: dataStructureResult.dataStructures,
          data_flow_paths: parsedPayload.data_flow_paths,
        })

        const outputPath = resolveProjectPath(ARTIFACT_PATHS.WIKI_INDEX)
        ensureDir(outputPath)
        writeFileSync(outputPath, JSON.stringify(wikiIndex, null, 2), "utf-8")

        return JSON.stringify({
          status: "success",
          action: "finalized_index",
          file: ARTIFACT_PATHS.WIKI_INDEX,
          chunk_dir: ARTIFACT_PATHS.WIKI_INDEX_FUNCTIONS_DIR,
          summary: {
            modules: wikiIndex.modules.length,
            functions: Object.keys(wikiIndex.function_index).length,
            function_index_chunks: wikiIndex.function_index_chunks.length,
            data_structures: wikiIndex.data_structures.length,
          },
          ...(warnings.length > 0 ? { warnings } : {}),
        })
      } catch (error) {
        return JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        })
      }
    })
  },
})
