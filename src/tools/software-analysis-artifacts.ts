import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { basename, dirname, isAbsolute, join, resolve } from "path"
import { z } from "zod"
import { BuildSystemType, CompilationDatabase, CompilationEnvironment, CompilerDialect } from "../schema/compilation"
import {
  SOFTWARE_ANALYSIS_STAGE_IDS,
  SoftwareAnalysisStage01Payload,
  SoftwareAnalysisStage02Payload,
  SoftwareAnalysisStage03Payload,
  SoftwareAnalysisStage03FunctionChunk,
  SoftwareAnalysisStage04Payload,
  SoftwareAnalysisStage05ChunkArtifact,
  SoftwareAnalysisStage05ChunkRef,
  SoftwareAnalysisStage05Payload,
  SoftwareAnalysisStage06Payload,
  SoftwareAnalysisStageArtifact,
  SoftwareAnalysisStageManifest,
  type SoftwareAnalysisStageArtifact as SoftwareAnalysisStageArtifactType,
  type SoftwareAnalysisStageId,
} from "../schema/software-analysis-stage"
import { SoftwareAnalysisReport, type FunctionInfo } from "../schema/sut"
import {
  ARTIFACT_PATHS,
  SOFTWARE_ANALYSIS_STAGE_03_FUNCTION_CHUNK_SIZE,
  SOFTWARE_ANALYSIS_STAGE_05_TRACEABILITY_CHUNK_SIZE,
  SOFTWARE_ANALYSIS_STAGE_PATHS,
} from "../shared/constants"
import { isCompilerIntrinsicName } from "../shared/compiler-intrinsics"
import { withFileLock } from "../shared/file-mutex"

function resolveArtifactPath(relativePath: string): string {
  return join(process.cwd(), relativePath)
}

const WINDOWS_ABSOLUTE_PATH_RE = /^[A-Za-z]:[\\/]/
const WINDOWS_ABSOLUTE_WITH_LEADING_SLASH_RE = /^[\\/]+([A-Za-z]:[\\/].*)$/

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const path of paths) {
    if (seen.has(path)) continue
    seen.add(path)
    result.push(path)
  }
  return result
}

function normalizeUserPathCandidate(pathValue: string): string {
  if (WINDOWS_ABSOLUTE_PATH_RE.test(pathValue)) return pathValue
  return isAbsolute(pathValue) ? resolve(pathValue) : resolve(process.cwd(), pathValue)
}

function resolveUserPathCandidates(pathValue: string): string[] {
  const trimmed = pathValue.trim()
  const rawCandidates: string[] = []

  const addRaw = (candidate: string | undefined) => {
    if (!candidate) return
    rawCandidates.push(candidate)
  }

  const leadingSlashWindowsPath = WINDOWS_ABSOLUTE_WITH_LEADING_SLASH_RE.exec(trimmed)?.[1]
  addRaw(leadingSlashWindowsPath)
  addRaw(trimmed)
  if (!WINDOWS_ABSOLUTE_PATH_RE.test(trimmed) && !isAbsolute(trimmed)) {
    addRaw(resolve(process.cwd(), trimmed))
  }

  return uniquePaths(rawCandidates.map(normalizeUserPathCandidate))
}

function resolveUserPath(pathValue: string): string {
  const candidates = resolveUserPathCandidates(pathValue)
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0] ?? resolve(process.cwd(), pathValue)
}

function resolveExistingStage04Path(pathValue: string, fileName: string): string {
  const candidates = resolveUserPathCandidates(pathValue)
  const existingPath = candidates.find((candidate) => existsSync(candidate))
  if (existingPath) return existingPath

  throw new Error([
    `Missing ${fileName} referenced by stage 04.`,
    `raw_path: ${pathValue}`,
    `cwd: ${process.cwd()}`,
    `checked_paths: ${candidates.join(" | ")}`,
    "Recovery: verify the file exists once. If it exists under .matrix/data, re-save stage 04 with workspace-relative paths " +
      "compile_commands_path=\".matrix/data/compile_commands.json\" and compilation_env_path=\".matrix/data/compilation-env.json\", then retry finalize once. " +
      "Do not inspect spelling or retry indefinitely.",
  ].join("\n"))
}

function ensureDir(filePath: string): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function getRecommendedTempPayloadFile(stageId: SoftwareAnalysisStageId): string | null {
  switch (stageId) {
    case "03-code":
      return resolveArtifactPath(ARTIFACT_PATHS.SOFTWARE_ANALYSIS_STAGE_03_CODE_TOOL)
    case "05-traceability":
      return resolveArtifactPath(ARTIFACT_PATHS.SOFTWARE_ANALYSIS_STAGE_05_TRACEABILITY_TOOL)
    default:
      return null
  }
}

function shouldDeleteRecommendedTempPayloadFile(stageId: SoftwareAnalysisStageId, payloadFile?: string): boolean {
  if (!payloadFile) return false
  const recommendedPath = getRecommendedTempPayloadFile(stageId)
  if (!recommendedPath) return false
  return resolveUserPath(payloadFile) === recommendedPath
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"))
}

function parsePayload(stageId: SoftwareAnalysisStageId, raw: unknown): unknown {
  const json = typeof raw === "string" ? JSON.parse(raw) : raw
  switch (stageId) {
    case "01-project":
      return SoftwareAnalysisStage01Payload.parse(json)
    case "02-requirements":
      return SoftwareAnalysisStage02Payload.parse(json)
    case "03-code":
      return SoftwareAnalysisStage03Payload.parse(json)
    case "04-compilation":
      return SoftwareAnalysisStage04Payload.parse(json)
    case "05-traceability":
      return SoftwareAnalysisStage05Payload.parse(json)
    case "06-finalize":
      return SoftwareAnalysisStage06Payload.parse(json)
  }
}

function summarizeStage(stageId: SoftwareAnalysisStageId, payload: unknown): Record<string, unknown> {
  switch (stageId) {
    case "01-project": {
      const data = payload as z.infer<typeof SoftwareAnalysisStage01Payload>
      return {
        project_name: data.project_name ?? null,
        version: data.version ?? null,
        source_code_dirs: data.source_code_dirs.length,
        requirement_document_paths: data.requirement_document_paths.length,
        include_dirs: data.include_dirs.length,
        excluded_dirs: data.excluded_dirs.length,
      }
    }
    case "02-requirements": {
      const data = payload as z.infer<typeof SoftwareAnalysisStage02Payload>
      return {
        requirements: data.requirements.length,
        interfaces: data.interfaces.length,
      }
    }
    case "03-code": {
      const data = payload as z.infer<typeof SoftwareAnalysisStage03Payload>
      return {
        functions: countStage03Functions(data),
        function_index: data.function_index.length,
        function_chunks: data.function_chunks.length,
        modules: data.modules.length,
        data_flow_nodes: data.data_flow_graph.nodes.length,
        data_flow_edges: data.data_flow_graph.edges.length,
        total_loc: data.total_loc,
      }
    }
    case "04-compilation": {
      const data = payload as z.infer<typeof SoftwareAnalysisStage04Payload>
      return {
        compile_commands_path: data.compile_commands_path,
        compilation_env_path: data.compilation_env_path,
        compile_commands_count: data.compile_commands_count ?? null,
        files_indexed: data.files_indexed ?? null,
        missing_headers_count: data.missing_headers_count ?? null,
        stub_count: data.stub_count ?? null,
      }
    }
    case "05-traceability": {
      const data = payload as z.infer<typeof SoftwareAnalysisStage05Payload>
      return {
        traceability_entries: countStage05Entries(data.traceability_matrix, data.traceability_chunks),
        gaps: countStage05Entries(data.gap_analysis, data.gap_chunks),
        orphans: countStage05Entries(data.orphan_analysis, data.orphan_chunks),
        interrupt_count: data.runtime_environment?.interrupt_table.length ?? 0,
      }
    }
    case "06-finalize": {
      const data = payload as z.infer<typeof SoftwareAnalysisStage06Payload>
      return {
        project_name: data.project_name ?? null,
        version: data.version ?? null,
        validation_summary_keys: data.validation_summary ? Object.keys(data.validation_summary).length : 0,
      }
    }
  }
}

function countStage03Functions(payload: z.infer<typeof SoftwareAnalysisStage03Payload>): number {
  return payload.functions.length + payload.function_chunks.reduce((sum, chunk) => sum + chunk.function_count, 0)
}

function countStage05Entries<TEntry>(
  entries: TEntry[],
  chunkRefs: z.infer<typeof SoftwareAnalysisStage05ChunkRef>[],
): number {
  return entries.length + chunkRefs.reduce((sum, chunk) => sum + chunk.entry_count, 0)
}

type Stage05ChunkKind = z.infer<typeof SoftwareAnalysisStage05ChunkRef>["chunk_kind"]
type Stage05EntriesByKind = {
  traceability_matrix: z.infer<typeof SoftwareAnalysisStage05Payload>["traceability_matrix"]
  gap_analysis: z.infer<typeof SoftwareAnalysisStage05Payload>["gap_analysis"]
  orphan_analysis: z.infer<typeof SoftwareAnalysisStage05Payload>["orphan_analysis"]
}

function createEmptyManifest() {
  const now = new Date().toISOString()
  const stageEntries = Object.fromEntries(
    SOFTWARE_ANALYSIS_STAGE_IDS.map((stageId) => [
      stageId,
      {
        stage_id: stageId,
        file_path: SOFTWARE_ANALYSIS_STAGE_PATHS[stageId],
        exists: false,
      },
    ]),
  )

  return SoftwareAnalysisStageManifest.parse({
    artifact_type: "software-analysis-stage-manifest",
    schema_version: 1,
    created_date: now,
    updated_date: now,
    stages: stageEntries,
  })
}

function loadManifest(manifestPath: string) {
  if (!existsSync(manifestPath)) return createEmptyManifest()
  try {
    return SoftwareAnalysisStageManifest.parse(readJsonFile(manifestPath))
  } catch {
    return createEmptyManifest()
  }
}

function readStageArtifact<TStageId extends SoftwareAnalysisStageId>(
  stageId: TStageId,
): Extract<SoftwareAnalysisStageArtifactType, { stage_id: TStageId }> {
  const stagePath = resolveArtifactPath(SOFTWARE_ANALYSIS_STAGE_PATHS[stageId])
  if (!existsSync(stagePath)) {
    throw new Error(`Missing required software analysis stage artifact: ${SOFTWARE_ANALYSIS_STAGE_PATHS[stageId]}`)
  }

  const parsed = SoftwareAnalysisStageArtifact.safeParse(readJsonFile(stagePath))
  if (!parsed.success) {
    throw new Error(`Invalid stage artifact ${SOFTWARE_ANALYSIS_STAGE_PATHS[stageId]}: ${parsed.error.message}`)
  }
  if (parsed.data.stage_id !== stageId) {
    throw new Error(`Stage artifact ${SOFTWARE_ANALYSIS_STAGE_PATHS[stageId]} has mismatched stage_id ${parsed.data.stage_id}`)
  }
  return parsed.data as Extract<SoftwareAnalysisStageArtifactType, { stage_id: TStageId }>
}

function stage03ChunkFilePath(chunkIndex: number): string {
  return `${ARTIFACT_PATHS.SOFTWARE_ANALYSIS_STAGE_03_FUNCTIONS_DIR}/chunk-${String(chunkIndex + 1).padStart(4, "0")}.json`
}

function stage05ChunkFilePath(
  chunkKind: Stage05ChunkKind,
  chunkIndex: number,
): string {
  return `${ARTIFACT_PATHS.SOFTWARE_ANALYSIS_STAGE_05_TRACEABILITY_DIR}/${chunkKind}-chunk-${String(chunkIndex + 1).padStart(4, "0")}.json`
}

function writeStage03FunctionChunks(
  payload: z.infer<typeof SoftwareAnalysisStage03Payload>,
  createdDate: string,
): z.infer<typeof SoftwareAnalysisStage03Payload> {
  if (payload.functions.length === 0) {
    return {
      ...payload,
      function_index: payload.function_index.length > 0
        ? payload.function_index
        : [],
    }
  }

  const chunkDir = resolveArtifactPath(ARTIFACT_PATHS.SOFTWARE_ANALYSIS_STAGE_03_FUNCTIONS_DIR)
  rmSync(chunkDir, { recursive: true, force: true })
  mkdirSync(chunkDir, { recursive: true })

  const functionChunks: z.infer<typeof SoftwareAnalysisStage03Payload>["function_chunks"] = []
  const functionIndex: z.infer<typeof SoftwareAnalysisStage03Payload>["function_index"] = []
  for (let start = 0, chunkIndex = 0; start < payload.functions.length; start += SOFTWARE_ANALYSIS_STAGE_03_FUNCTION_CHUNK_SIZE, chunkIndex++) {
    const functions = payload.functions.slice(start, start + SOFTWARE_ANALYSIS_STAGE_03_FUNCTION_CHUNK_SIZE)
    const chunkPath = stage03ChunkFilePath(chunkIndex)
    const chunkArtifact = SoftwareAnalysisStage03FunctionChunk.parse({
      artifact_type: "software-analysis-stage-03-function-chunk",
      schema_version: 1,
      stage_id: "03-code",
      chunk_index: chunkIndex,
      created_date: createdDate,
      functions,
    })
    const absoluteChunkPath = resolveArtifactPath(chunkPath)
    ensureDir(absoluteChunkPath)
    writeFileSync(absoluteChunkPath, JSON.stringify(chunkArtifact, null, 2), "utf-8")
    functionChunks.push({
      chunk_index: chunkIndex,
      file_path: chunkPath,
      function_count: functions.length,
      first_function_id: functions[0]?.id,
      last_function_id: functions[functions.length - 1]?.id,
    })
    functionIndex.push(
      ...functions.map((fn) => ({
        id: fn.id,
        name: fn.name,
        file_path: fn.file_path,
        line_range: fn.line_range,
        return_type: fn.return_type,
        parameters: fn.parameters,
        calls: fn.calls,
        called_by: fn.called_by,
        safety_critical: fn.safety_critical,
        chunk_index: chunkIndex,
        chunk_file_path: chunkPath,
      })),
    )
  }

  return {
    ...payload,
    functions: [],
    function_index: functionIndex,
    function_chunks: functionChunks,
  }
}

function readStage03Functions(payload: z.infer<typeof SoftwareAnalysisStage03Payload>): FunctionInfo[] {
  const chunkFunctions = payload.function_chunks.flatMap((chunkRef) => {
    const chunkPath = resolveArtifactPath(chunkRef.file_path)
    if (!existsSync(chunkPath)) {
      throw new Error(`Missing stage 03 function chunk: ${chunkRef.file_path}`)
    }
    const parsedChunk = SoftwareAnalysisStage03FunctionChunk.safeParse(readJsonFile(chunkPath))
    if (!parsedChunk.success) {
      throw new Error(`Invalid stage 03 function chunk ${chunkRef.file_path}: ${parsedChunk.error.message}`)
    }
    if (parsedChunk.data.chunk_index !== chunkRef.chunk_index) {
      throw new Error(`Stage 03 function chunk ${chunkRef.file_path} has mismatched chunk_index ${parsedChunk.data.chunk_index}`)
    }
    if (parsedChunk.data.functions.length !== chunkRef.function_count) {
      throw new Error(
        `Stage 03 function chunk ${chunkRef.file_path} expected ${chunkRef.function_count} functions but found ${parsedChunk.data.functions.length}`,
      )
    }
    return parsedChunk.data.functions
  })

  return [...payload.functions, ...chunkFunctions]
}

function writeStage05Chunks(
  payload: z.infer<typeof SoftwareAnalysisStage05Payload>,
  createdDate: string,
): z.infer<typeof SoftwareAnalysisStage05Payload> {
  const hasInlineEntries = payload.traceability_matrix.length > 0 || payload.gap_analysis.length > 0 || payload.orphan_analysis.length > 0
  if (!hasInlineEntries) {
    return payload
  }

  const chunkDir = resolveArtifactPath(ARTIFACT_PATHS.SOFTWARE_ANALYSIS_STAGE_05_TRACEABILITY_DIR)
  rmSync(chunkDir, { recursive: true, force: true })
  mkdirSync(chunkDir, { recursive: true })

  const writeChunks = <TEntry, TChunkKind extends Stage05ChunkKind>(
    chunkKind: TChunkKind,
    entries: TEntry[],
  ) => {
    const chunkRefs: z.infer<typeof SoftwareAnalysisStage05ChunkRef>[] = []
    for (let start = 0, chunkIndex = 0; start < entries.length; start += SOFTWARE_ANALYSIS_STAGE_05_TRACEABILITY_CHUNK_SIZE, chunkIndex++) {
      const chunkEntries = entries.slice(start, start + SOFTWARE_ANALYSIS_STAGE_05_TRACEABILITY_CHUNK_SIZE)
      const chunkPath = stage05ChunkFilePath(chunkKind, chunkIndex)
      const chunkArtifact = SoftwareAnalysisStage05ChunkArtifact.parse({
        artifact_type: "software-analysis-stage-05-chunk",
        schema_version: 1,
        stage_id: "05-traceability",
        chunk_kind: chunkKind,
        chunk_index: chunkIndex,
        created_date: createdDate,
        entries: chunkEntries,
      })
      const absoluteChunkPath = resolveArtifactPath(chunkPath)
      ensureDir(absoluteChunkPath)
      writeFileSync(absoluteChunkPath, JSON.stringify(chunkArtifact, null, 2), "utf-8")
      chunkRefs.push({
        chunk_kind: chunkKind,
        chunk_index: chunkIndex,
        file_path: chunkPath,
        entry_count: chunkEntries.length,
      })
    }
    return chunkRefs
  }

  return {
    ...payload,
    traceability_matrix: [],
    traceability_chunks: writeChunks("traceability_matrix", payload.traceability_matrix),
    gap_analysis: [],
    gap_chunks: writeChunks("gap_analysis", payload.gap_analysis),
    orphan_analysis: [],
    orphan_chunks: writeChunks("orphan_analysis", payload.orphan_analysis),
  }
}

function readStage05ChunkEntries(
  chunkKind: "traceability_matrix",
  chunkRefs: z.infer<typeof SoftwareAnalysisStage05ChunkRef>[],
): Stage05EntriesByKind["traceability_matrix"]
function readStage05ChunkEntries(
  chunkKind: "gap_analysis",
  chunkRefs: z.infer<typeof SoftwareAnalysisStage05ChunkRef>[],
): Stage05EntriesByKind["gap_analysis"]
function readStage05ChunkEntries(
  chunkKind: "orphan_analysis",
  chunkRefs: z.infer<typeof SoftwareAnalysisStage05ChunkRef>[],
): Stage05EntriesByKind["orphan_analysis"]
function readStage05ChunkEntries(
  chunkKind: Stage05ChunkKind,
  chunkRefs: z.infer<typeof SoftwareAnalysisStage05ChunkRef>[],
) {
  switch (chunkKind) {
    case "traceability_matrix": {
      const entries: Stage05EntriesByKind["traceability_matrix"] = []
      for (const chunkRef of chunkRefs) {
        if (chunkRef.chunk_kind !== chunkKind) {
          throw new Error(`Stage 05 chunk ref ${chunkRef.file_path} expected kind ${chunkKind} but found ${chunkRef.chunk_kind}`)
        }
        const chunkPath = resolveArtifactPath(chunkRef.file_path)
        if (!existsSync(chunkPath)) {
          throw new Error(`Missing stage 05 ${chunkKind} chunk: ${chunkRef.file_path}`)
        }
        const parsedChunk = SoftwareAnalysisStage05ChunkArtifact.safeParse(readJsonFile(chunkPath))
        if (!parsedChunk.success) {
          throw new Error(`Invalid stage 05 chunk ${chunkRef.file_path}: ${parsedChunk.error.message}`)
        }
        if (parsedChunk.data.chunk_kind !== chunkKind) {
          throw new Error(`Stage 05 chunk ${chunkRef.file_path} has mismatched chunk_kind ${parsedChunk.data.chunk_kind}`)
        }
        if (parsedChunk.data.chunk_index !== chunkRef.chunk_index) {
          throw new Error(`Stage 05 chunk ${chunkRef.file_path} has mismatched chunk_index ${parsedChunk.data.chunk_index}`)
        }
        if (parsedChunk.data.entries.length !== chunkRef.entry_count) {
          throw new Error(
            `Stage 05 chunk ${chunkRef.file_path} expected ${chunkRef.entry_count} entries but found ${parsedChunk.data.entries.length}`,
          )
        }
        entries.push(...parsedChunk.data.entries)
      }
      return entries
    }
    case "gap_analysis": {
      const entries: Stage05EntriesByKind["gap_analysis"] = []
      for (const chunkRef of chunkRefs) {
        if (chunkRef.chunk_kind !== chunkKind) {
          throw new Error(`Stage 05 chunk ref ${chunkRef.file_path} expected kind ${chunkKind} but found ${chunkRef.chunk_kind}`)
        }
        const chunkPath = resolveArtifactPath(chunkRef.file_path)
        if (!existsSync(chunkPath)) {
          throw new Error(`Missing stage 05 ${chunkKind} chunk: ${chunkRef.file_path}`)
        }
        const parsedChunk = SoftwareAnalysisStage05ChunkArtifact.safeParse(readJsonFile(chunkPath))
        if (!parsedChunk.success) {
          throw new Error(`Invalid stage 05 chunk ${chunkRef.file_path}: ${parsedChunk.error.message}`)
        }
        if (parsedChunk.data.chunk_kind !== chunkKind) {
          throw new Error(`Stage 05 chunk ${chunkRef.file_path} has mismatched chunk_kind ${parsedChunk.data.chunk_kind}`)
        }
        if (parsedChunk.data.chunk_index !== chunkRef.chunk_index) {
          throw new Error(`Stage 05 chunk ${chunkRef.file_path} has mismatched chunk_index ${parsedChunk.data.chunk_index}`)
        }
        if (parsedChunk.data.entries.length !== chunkRef.entry_count) {
          throw new Error(
            `Stage 05 chunk ${chunkRef.file_path} expected ${chunkRef.entry_count} entries but found ${parsedChunk.data.entries.length}`,
          )
        }
        entries.push(...parsedChunk.data.entries)
      }
      return entries
    }
    case "orphan_analysis": {
      const entries: Stage05EntriesByKind["orphan_analysis"] = []
      for (const chunkRef of chunkRefs) {
        if (chunkRef.chunk_kind !== chunkKind) {
          throw new Error(`Stage 05 chunk ref ${chunkRef.file_path} expected kind ${chunkKind} but found ${chunkRef.chunk_kind}`)
        }
        const chunkPath = resolveArtifactPath(chunkRef.file_path)
        if (!existsSync(chunkPath)) {
          throw new Error(`Missing stage 05 ${chunkKind} chunk: ${chunkRef.file_path}`)
        }
        const parsedChunk = SoftwareAnalysisStage05ChunkArtifact.safeParse(readJsonFile(chunkPath))
        if (!parsedChunk.success) {
          throw new Error(`Invalid stage 05 chunk ${chunkRef.file_path}: ${parsedChunk.error.message}`)
        }
        if (parsedChunk.data.chunk_kind !== chunkKind) {
          throw new Error(`Stage 05 chunk ${chunkRef.file_path} has mismatched chunk_kind ${parsedChunk.data.chunk_kind}`)
        }
        if (parsedChunk.data.chunk_index !== chunkRef.chunk_index) {
          throw new Error(`Stage 05 chunk ${chunkRef.file_path} has mismatched chunk_index ${parsedChunk.data.chunk_index}`)
        }
        if (parsedChunk.data.entries.length !== chunkRef.entry_count) {
          throw new Error(
            `Stage 05 chunk ${chunkRef.file_path} expected ${chunkRef.entry_count} entries but found ${parsedChunk.data.entries.length}`,
          )
        }
        entries.push(...parsedChunk.data.entries)
      }
      return entries
    }
  }
}

function readStage05Payload(payload: z.infer<typeof SoftwareAnalysisStage05Payload>): z.infer<typeof SoftwareAnalysisStage05Payload> {
  return {
    ...payload,
    traceability_matrix: [...payload.traceability_matrix, ...readStage05ChunkEntries("traceability_matrix", payload.traceability_chunks)],
    gap_analysis: [...payload.gap_analysis, ...readStage05ChunkEntries("gap_analysis", payload.gap_chunks)],
    orphan_analysis: [...payload.orphan_analysis, ...readStage05ChunkEntries("orphan_analysis", payload.orphan_chunks)],
  }
}

function computeSummary(functions: FunctionInfo[], requirementsCount: number, interfacesCount: number, totalLoc: number) {
  const safetyCriticalCount = functions.filter((fn) => fn.safety_critical).length
  const complexities = functions
    .map((fn) => fn.cyclomatic_complexity)
    .filter((value): value is number => typeof value === "number")
  const avgComplexity = complexities.length > 0
    ? Number((complexities.reduce((sum, value) => sum + value, 0) / complexities.length).toFixed(2))
    : undefined

  return {
    total_functions: functions.length,
    total_loc: totalLoc,
    total_requirements: requirementsCount,
    total_interfaces: interfacesCount,
    safety_critical_functions: safetyCriticalCount,
    ...(avgComplexity !== undefined ? { avg_complexity: avgComplexity } : {}),
  }
}

function extractPathFromSourceLocation(sourceLocation: string): string | null {
  const trimmed = sourceLocation.trim()
  if (!trimmed) return null
  const beforeHash = trimmed.split("#")[0] ?? trimmed
  if (!/[\\/]/.test(beforeHash) && !/\.[A-Za-z0-9]{1,8}/.test(beforeHash)) return null

  if (/^[A-Za-z]:[\\/]/.test(beforeHash)) {
    return beforeHash.replace(/:(\d+)(?::\d+)?$/, "")
  }
  return beforeHash.replace(/:(\d+)(?::\d+)?$/, "")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function numberOrDefault(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

function normalizeBuildSystem(value: unknown): z.infer<typeof BuildSystemType> {
  if (typeof value !== "string") return "none"
  const normalized = value.trim().toLowerCase()
  const parsed = BuildSystemType.safeParse(normalized)
  if (parsed.success) return parsed.data
  if (normalized.includes("cmake")) return "cmake"
  if (normalized.includes("make")) return "make"
  if (normalized.includes("uvproj")) return "keil_uvprojx"
  if (normalized.includes("iar") || normalized.includes("ewp")) return "iar_ewp"
  if (normalized.includes("eclipse") || normalized.includes("cproject")) return "eclipse_cproject"
  if (normalized.includes("scons")) return "scons"
  if (normalized.includes("meson")) return "meson"
  if (normalized.includes("ninja")) return "ninja"
  return "none"
}

function normalizeCompilerDialect(value: unknown): z.infer<typeof CompilerDialect> {
  if (typeof value !== "string") return "auto"
  const normalized = value.trim().toLowerCase()
  const parsed = CompilerDialect.safeParse(normalized)
  if (parsed.success) return parsed.data
  if (normalized.includes("c51") || normalized.includes("8051")) return "c51"
  if (normalized.includes("keil")) return "keil"
  if (normalized.includes("armclang")) return "armclang"
  if (normalized.includes("armcc")) return "armcc"
  if (normalized.includes("iar")) return "iar"
  if (normalized.includes("greenhill")) return "greenhill"
  if (normalized.includes("windriver")) return "windriver"
  if (normalized.includes("ti")) return "ti"
  if (normalized.includes("gcc") || normalized.includes("gnu")) return "gcc"
  return "auto"
}

function splitCompileCommand(command: string | undefined): string[] {
  if (!command) return []
  const matches = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
  return matches.map((item) => item.replace(/^["']|["']$/g, ""))
}

function resolveFlagPath(baseDir: string, value: string): string {
  return WINDOWS_ABSOLUTE_PATH_RE.test(value) || isAbsolute(value) ? normalizeUserPathCandidate(value) : resolve(baseDir, value)
}

function extractCompileFlags(compileCommands: z.infer<typeof CompilationDatabase>) {
  const includeDirs = new Set<string>()
  const defines = new Set<string>()

  for (const entry of compileCommands) {
    const args = entry.arguments ?? splitCompileCommand(entry.command)
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index] ?? ""
      if (arg === "-I" || arg === "/I") {
        const value = args[index + 1]
        if (value) includeDirs.add(resolveFlagPath(entry.directory, value))
        index += 1
        continue
      }
      if (arg.startsWith("-I") && arg.length > 2) {
        includeDirs.add(resolveFlagPath(entry.directory, arg.slice(2)))
        continue
      }
      if (arg.startsWith("/I") && arg.length > 2) {
        includeDirs.add(resolveFlagPath(entry.directory, arg.slice(2)))
        continue
      }
      if (arg === "-D" || arg === "/D") {
        const value = args[index + 1]
        if (value) defines.add(value)
        index += 1
        continue
      }
      if (arg.startsWith("-D") && arg.length > 2) {
        defines.add(arg.slice(2))
        continue
      }
      if (arg.startsWith("/D") && arg.length > 2) {
        defines.add(arg.slice(2))
      }
    }
  }

  return {
    include_dirs: [...includeDirs],
    defines: [...defines],
  }
}

function normalizeHeaderStubs(value: unknown): z.infer<typeof CompilationEnvironment>["stubs"] {
  if (!Array.isArray(value)) return []
  const categories = new Set(["vendor_hal", "bsp", "rtos", "compiler_builtin", "standard_lib", "driver", "middleware", "unknown"])
  const stubs: z.infer<typeof CompilationEnvironment>["stubs"] = []

  for (const item of value) {
    if (!isRecord(item)) continue
    const stubPath = stringOrUndefined(item.stub_path)
    const headerName = stringOrUndefined(item.header_name) ?? (stubPath ? basename(stubPath) : undefined)
    if (!headerName || !stubPath) continue
    const category = typeof item.category === "string" && categories.has(item.category) ? item.category : "unknown"
    stubs.push({
      header_name: headerName,
      stub_path: stubPath,
      category: category as z.infer<typeof CompilationEnvironment>["stubs"][number]["category"],
      symbols_stubbed: numberOrDefault(item.symbols_stubbed, 0),
      referenced_by: stringArray(item.referenced_by),
    })
  }

  return stubs
}

function buildCompilationEnvironmentFallback(
  raw: unknown,
  compileCommands: z.infer<typeof CompilationDatabase>,
  payload: z.infer<typeof SoftwareAnalysisStage04Payload>,
): z.infer<typeof CompilationEnvironment> {
  const rawObject = isRecord(raw) ? raw : {}
  const firstCommand = compileCommands[0]
  const extractedFlags = extractCompileFlags(compileCommands)
  const includeDirs = stringArray(rawObject.include_dirs)
  const defines = stringArray(rawObject.defines)
  const targetCpu = stringOrUndefined(rawObject.target_cpu)
  const preprocessedDir = stringOrUndefined(rawObject.preprocessed_dir) ?? payload.preprocessed_dir
  const projectPath =
    stringOrUndefined(rawObject.project_path) ??
    stringOrUndefined(rawObject.matrix_root) ??
    firstCommand?.directory ??
    process.cwd()

  return CompilationEnvironment.parse({
    project_path: projectPath,
    build_system: normalizeBuildSystem(rawObject.build_system ?? rawObject.build_system_detected),
    compiler_dialect: normalizeCompilerDialect(rawObject.compiler_dialect),
    ...(targetCpu ? { target_cpu: targetCpu } : {}),
    compile_commands_path: stringOrUndefined(rawObject.compile_commands_path) ?? payload.compile_commands_path,
    files_indexed: numberOrDefault(rawObject.files_indexed, compileCommands.length),
    include_dirs: includeDirs.length > 0 ? includeDirs : extractedFlags.include_dirs,
    defines: defines.length > 0 ? defines : extractedFlags.defines,
    missing_headers: stringArray(rawObject.missing_headers),
    stubs: normalizeHeaderStubs(rawObject.stubs),
    ...(preprocessedDir ? { preprocessed_dir: preprocessedDir } : {}),
    created_date: stringOrUndefined(rawObject.created_date) ?? new Date().toISOString(),
  })
}

function readJsonFileIfPresent(path: string): { exists: true; value: unknown; parse_error?: undefined } | { exists: true; value?: undefined; parse_error: string } | { exists: false; value?: undefined; parse_error?: undefined } {
  if (!existsSync(path)) return { exists: false }
  try {
    return { exists: true, value: readJsonFile(path) }
  } catch (error) {
    return {
      exists: true,
      parse_error: error instanceof Error ? error.message : String(error),
    }
  }
}

function loadCompilationEnvironmentBestEffort(
  pathValue: string,
  compileCommands: z.infer<typeof CompilationDatabase>,
  payload: z.infer<typeof SoftwareAnalysisStage04Payload>,
) {
  const envPath = resolveUserPath(pathValue)
  const readResult = readJsonFileIfPresent(envPath)

  if (readResult.exists) {
    if (!readResult.parse_error) {
      const parsed = CompilationEnvironment.safeParse(readResult.value)
      if (parsed.success) {
        return { compilation_env: parsed.data }
      }

      const fallback = buildCompilationEnvironmentFallback(readResult.value, compileCommands, payload)
      return {
        compilation_env: fallback,
        compilation_env_issue: {
          path: envPath,
          reason: "invalid_schema",
          message: parsed.error.message,
        },
      }
    }

    const fallback = buildCompilationEnvironmentFallback({}, compileCommands, payload)
    return {
      compilation_env: fallback,
      compilation_env_issue: {
        path: envPath,
        reason: "invalid_json",
        message: readResult.parse_error,
      },
    }
  }

  const fallback = buildCompilationEnvironmentFallback({}, compileCommands, payload)
  return {
    compilation_env: fallback,
    compilation_env_issue: {
      path: envPath,
      reason: "missing_file",
      message: "Skipped compilation-env.json validation and continued with fallback summary from stage 04 and compile_commands.json.",
    },
  }
}

function validateCompilationStage(payload: z.infer<typeof SoftwareAnalysisStage04Payload>) {
  const compileCommandsPath = resolveExistingStage04Path(payload.compile_commands_path, "compile_commands.json")

  const compileCommandsParsed = CompilationDatabase.safeParse(readJsonFile(compileCommandsPath))
  if (!compileCommandsParsed.success) {
    throw new Error(`Invalid compile_commands.json referenced by stage 04: ${compileCommandsParsed.error.message}`)
  }

  const compilationEnvResult = loadCompilationEnvironmentBestEffort(
    payload.compilation_env_path,
    compileCommandsParsed.data,
    payload,
  )

  return {
    compile_commands_count: compileCommandsParsed.data.length,
    ...compilationEnvResult,
  }
}

function validateFinalReport(report: z.infer<typeof SoftwareAnalysisReport>) {
  const errors: string[] = []
  const requirementIds = new Set<string>()
  const functionIds = new Set<string>()
  const functionNames = new Set<string>()
  const functionNamesInFile = new Set<string>()
  const functionRefs = new Set<string>()
  const duplicateRequirementIds = new Set<string>()
  const duplicateFunctionIds = new Set<string>()
  const duplicateFunctionNamesInFile = new Set<string>()

  for (const requirement of report.requirements) {
    if (requirementIds.has(requirement.id)) duplicateRequirementIds.add(requirement.id)
    requirementIds.add(requirement.id)

    const resolvedRefs = new Set(requirement.resolved_references.map((entry) => entry.ref_text))
    for (const unresolved of requirement.unresolved_references) {
      if (resolvedRefs.has(unresolved.ref_text)) {
        errors.push(`Requirement ${requirement.id} has ref_text "${unresolved.ref_text}" in both resolved_references and unresolved_references`)
      }
    }

    for (const resolved of requirement.resolved_references) {
      if (!resolved.source_location) continue
      const maybePath = extractPathFromSourceLocation(resolved.source_location)
      if (!maybePath) continue
      if (!existsSync(resolveUserPath(maybePath))) {
        errors.push(`Requirement ${requirement.id} references missing source_location path: ${resolved.source_location}`)
      }
    }
  }

  for (const fn of report.functions) {
    if (functionIds.has(fn.id)) duplicateFunctionIds.add(fn.id)
    functionIds.add(fn.id)
    functionNames.add(fn.name)
    functionRefs.add(fn.id)
    functionRefs.add(fn.name)

    const perFileKey = `${fn.file_path}::${fn.name}`
    if (functionNamesInFile.has(perFileKey)) duplicateFunctionNamesInFile.add(perFileKey)
    functionNamesInFile.add(perFileKey)
  }

  if (duplicateRequirementIds.size > 0) {
    errors.push(`Duplicate requirement IDs found: ${Array.from(duplicateRequirementIds).sort().join(", ")}`)
  }
  if (duplicateFunctionIds.size > 0) {
    errors.push(`Duplicate function IDs found: ${Array.from(duplicateFunctionIds).sort().join(", ")}`)
  }
  if (duplicateFunctionNamesInFile.size > 0) {
    errors.push(`Duplicate function names within the same file: ${Array.from(duplicateFunctionNamesInFile).sort().join(", ")}`)
  }

  for (const module of report.modules) {
    for (const functionRef of module.functions) {
      if (!functionRefs.has(functionRef)) {
        errors.push(`Module ${module.name} references unknown function "${functionRef}"`)
      }
    }
  }

  for (const fn of report.functions) {
    for (const callee of fn.calls) {
      if (!functionRefs.has(callee) && !isCompilerIntrinsicName(callee)) {
        errors.push(`Function ${fn.id} (${fn.name}) calls unknown callee "${callee}"`)
      }
    }
  }

  for (const entry of report.traceability_matrix ?? []) {
    if (!requirementIds.has(entry.req_id)) {
      errors.push(`Traceability entry references unknown requirement "${entry.req_id}"`)
    }
    for (const functionId of entry.function_ids) {
      if (!functionRefs.has(functionId)) {
        errors.push(`Traceability entry ${entry.req_id} references unknown function "${functionId}"`)
      }
    }
  }

  for (const gap of report.gap_analysis ?? []) {
    if (!requirementIds.has(gap.req_id)) {
      errors.push(`GAP analysis references unknown requirement "${gap.req_id}"`)
    }
  }

  for (const orphan of report.orphan_analysis ?? []) {
    if (!functionRefs.has(orphan.function_id)) {
      errors.push(`ORPHAN analysis references unknown function "${orphan.function_id}"`)
    }
  }

  for (const interrupt of report.runtime_environment?.interrupt_table ?? []) {
    if (!functionRefs.has(interrupt.handler_function)) {
      errors.push(`Interrupt handler "${interrupt.handler_function}" is not present in functions[]`)
    }
  }

  const heuristicIsrCount = report.functions.filter((fn) => /\b(?:isr|irq|interrupt|handler)\b/i.test(fn.name)).length
  const interruptCount = report.runtime_environment?.interrupt_table.length ?? 0
  if (heuristicIsrCount > 0 && Math.abs(interruptCount - heuristicIsrCount) > Math.max(2, Math.ceil(heuristicIsrCount * 0.5))) {
    errors.push(`Interrupt table count ${interruptCount} does not roughly match ISR-like functions ${heuristicIsrCount}`)
  }

  if (report.summary.total_requirements !== report.requirements.length) {
    errors.push(`summary.total_requirements (${report.summary.total_requirements}) does not match requirements.length (${report.requirements.length})`)
  }
  if (report.summary.total_functions !== report.functions.length) {
    errors.push(`summary.total_functions (${report.summary.total_functions}) does not match functions.length (${report.functions.length})`)
  }
  if (report.summary.total_interfaces !== report.interfaces.length) {
    errors.push(`summary.total_interfaces (${report.summary.total_interfaces}) does not match interfaces.length (${report.interfaces.length})`)
  }

  if (errors.length > 0) {
    throw new Error(errors.join("\n"))
  }
}

export const softwareAnalysisArtifacts: ToolDefinition = tool({
  description:
    "Persist Phase 1 software-analysis stage artifacts to fixed .matrix/data paths and " +
    "finalize them into the canonical .matrix/data/software-analysis.json report.",
  args: {
    mode: tool.schema.enum(["save_stage", "finalize"]).describe("Whether to save one stage artifact or finalize all stages into software-analysis.json."),
    stage_id: tool.schema
      .enum(SOFTWARE_ANALYSIS_STAGE_IDS)
      .optional()
      .describe("Required for save_stage. Fixed stage identifier to persist."),
    payload: tool.schema
      .object({})
      .passthrough()
      .optional()
      .describe("Structured stage payload object. Preferred over payload_json when the agent can pass native tool arguments."),
    payload_json: tool.schema
      .union([tool.schema.string(), tool.schema.object({}).passthrough()])
      .optional()
      .describe("Stage payload as a JSON string or object. Prefer payload for native structured tool calls; use payload_file for larger inputs."),
    payload_file: tool.schema
      .string()
      .optional()
      .describe("Optional JSON file containing the stage payload. Use this instead of payload/payload_json for large artifacts."),
  },
  async execute({ mode, stage_id, payload, payload_json, payload_file }) {
    const manifestPath = resolveArtifactPath(ARTIFACT_PATHS.SOFTWARE_ANALYSIS_STAGE_MANIFEST)

    if (mode === "save_stage") {
      if (!stage_id) {
        return JSON.stringify({ error: "stage_id is required when mode=save_stage" })
      }
      if (payload === undefined && payload_json === undefined && !payload_file) {
        return JSON.stringify({ error: "payload, payload_json, or payload_file is required when mode=save_stage" })
      }

      return await withFileLock(manifestPath, async () => {
        try {
          const payloadSource = payload_file
            ? readFileSync(resolveUserPath(payload_file), "utf-8")
            : payload !== undefined
              ? payload
              : payload_json
          const createdDate = new Date().toISOString()
          const parsedPayload = parsePayload(stage_id, payloadSource)
          const normalizedPayload = stage_id === "03-code"
            ? writeStage03FunctionChunks(parsedPayload as z.infer<typeof SoftwareAnalysisStage03Payload>, createdDate)
            : stage_id === "05-traceability"
              ? writeStage05Chunks(parsedPayload as z.infer<typeof SoftwareAnalysisStage05Payload>, createdDate)
              : parsedPayload
          const artifact = SoftwareAnalysisStageArtifact.parse({
            artifact_type: "software-analysis-stage",
            schema_version: 1,
            stage_id,
            created_date: createdDate,
            payload: normalizedPayload,
          })
          const stagePath = resolveArtifactPath(SOFTWARE_ANALYSIS_STAGE_PATHS[stage_id])
          ensureDir(stagePath)
          writeFileSync(stagePath, JSON.stringify(artifact, null, 2), "utf-8")

          const manifest = loadManifest(manifestPath)
          manifest.updated_date = createdDate
          manifest.stages[stage_id] = {
            stage_id,
            file_path: SOFTWARE_ANALYSIS_STAGE_PATHS[stage_id],
            exists: true,
            updated_date: createdDate,
            summary: summarizeStage(stage_id, normalizedPayload),
          }

          ensureDir(manifestPath)
          writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8")

          const deleted_temp_payload_file = shouldDeleteRecommendedTempPayloadFile(stage_id, payload_file)
          if (deleted_temp_payload_file) {
            rmSync(resolveUserPath(payload_file!), { force: true })
          }

          return JSON.stringify({
            status: "success",
            action: "saved_stage",
            stage_id,
            file: SOFTWARE_ANALYSIS_STAGE_PATHS[stage_id],
            manifest_file: ARTIFACT_PATHS.SOFTWARE_ANALYSIS_STAGE_MANIFEST,
            ...(deleted_temp_payload_file ? { deleted_temp_payload_file: payload_file } : {}),
            summary: manifest.stages[stage_id].summary,
          })
        } catch (error) {
          return JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          })
        }
      })
    }

    return await withFileLock(manifestPath, async () => {
      try {
        const manifest = loadManifest(manifestPath)
        const stage01 = readStageArtifact("01-project")
        const stage02 = readStageArtifact("02-requirements")
        const stage03 = readStageArtifact("03-code")
        const stage04 = readStageArtifact("04-compilation")
        const stage05 = readStageArtifact("05-traceability")
        const stage06 = readStageArtifact("06-finalize")
        const stage03Functions = readStage03Functions(stage03.payload)
        const stage05Payload = readStage05Payload(stage05.payload)

        const compilationValidation = validateCompilationStage(stage04.payload)
        const finalizeWarnings = compilationValidation.compilation_env_issue
          ? [
            `Skipped non-blocking compilation-env.json issue (${compilationValidation.compilation_env_issue.reason}) at ${compilationValidation.compilation_env_issue.path}`,
          ]
          : []

        const projectName = stage06.payload.project_name ?? stage01.payload.project_name
        const version = stage06.payload.version ?? stage01.payload.version
        if (!projectName) throw new Error("Missing required project_name across stages 01 and 06")
        if (!version) throw new Error("Missing required version across stages 01 and 06")

        const reportData = {
          project_name: projectName,
          version,
          created_date: stage06.created_date || stage01.created_date,
          ...(stage06.payload.csci_name ?? stage01.payload.csci_name ? { csci_name: stage06.payload.csci_name ?? stage01.payload.csci_name } : {}),
          ...(stage06.payload.system_name ?? stage01.payload.system_name ? { system_name: stage06.payload.system_name ?? stage01.payload.system_name } : {}),
          ...(stage06.payload.software_level ?? stage01.payload.software_level ? { software_level: stage06.payload.software_level ?? stage01.payload.software_level } : {}),
          ...(stage06.payload.developer_org ?? stage01.payload.developer_org ? { developer_org: stage06.payload.developer_org ?? stage01.payload.developer_org } : {}),
          requirements: stage02.payload.requirements,
          interfaces: stage02.payload.interfaces,
          data_flow_graph: stage03.payload.data_flow_graph,
          functions: stage03Functions,
          modules: stage03.payload.modules,
          ...(stage05Payload.traceability_matrix.length > 0 ? { traceability_matrix: stage05Payload.traceability_matrix } : {}),
          ...(stage05Payload.gap_analysis.length > 0 ? { gap_analysis: stage05Payload.gap_analysis } : {}),
          ...(stage05Payload.orphan_analysis.length > 0 ? { orphan_analysis: stage05Payload.orphan_analysis } : {}),
          ...(stage05Payload.runtime_environment ? { runtime_environment: stage05Payload.runtime_environment } : {}),
          ...(stage05Payload.main_functions_summary ? { main_functions_summary: stage05Payload.main_functions_summary } : {}),
          summary: computeSummary(
            stage03Functions,
            stage02.payload.requirements.length,
            stage02.payload.interfaces.length,
            stage03.payload.total_loc,
          ),
        }

        const parsedReport = SoftwareAnalysisReport.safeParse(reportData)
        if (!parsedReport.success) {
          throw new Error(`Final SoftwareAnalysisReport schema validation failed: ${parsedReport.error.message}`)
        }

        validateFinalReport(parsedReport.data)

        const outputPath = resolveArtifactPath(ARTIFACT_PATHS.SOFTWARE_ANALYSIS)
        ensureDir(outputPath)
        writeFileSync(outputPath, JSON.stringify(parsedReport.data, null, 2), "utf-8")

        const finalizedDate = new Date().toISOString()
        manifest.updated_date = finalizedDate
        manifest.finalized_output_path = ARTIFACT_PATHS.SOFTWARE_ANALYSIS
        manifest.stages["04-compilation"] = {
          stage_id: "04-compilation",
          file_path: SOFTWARE_ANALYSIS_STAGE_PATHS["04-compilation"],
          exists: true,
          updated_date: stage04.created_date,
          summary: {
            ...summarizeStage("04-compilation", stage04.payload),
            compile_commands_count: compilationValidation.compile_commands_count,
            files_indexed: compilationValidation.compilation_env.files_indexed,
            missing_headers_count: compilationValidation.compilation_env.missing_headers.length,
            stub_count: compilationValidation.compilation_env.stubs.length,
            ...(compilationValidation.compilation_env_issue
              ? {
                compilation_env_valid: false,
                compilation_env_issue: compilationValidation.compilation_env_issue.reason,
              }
              : { compilation_env_valid: true }),
          },
        }
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8")

        return JSON.stringify({
          status: "success",
          action: "finalized",
          file: ARTIFACT_PATHS.SOFTWARE_ANALYSIS,
          manifest_file: ARTIFACT_PATHS.SOFTWARE_ANALYSIS_STAGE_MANIFEST,
          summary: parsedReport.data.summary,
          ...(finalizeWarnings.length > 0 ? { warnings: finalizeWarnings } : {}),
        })
      } catch (error) {
        return JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        })
      }
    })
  },
})
