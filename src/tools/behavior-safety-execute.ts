import { tool, type ToolContext, type ToolDefinition } from "@opencode-ai/plugin"
import type { OpencodeClient } from "@opencode-ai/sdk/client"
import { z } from "zod"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  readdirSync,
  statSync,
} from "fs"
import { basename, extname, join, relative, resolve } from "path"
import { codeParser } from "./code-parser"
import { executeCodeSliceContextPack } from "./code-slice-context-pack"
import { BehaviorSafetyBatchRecord, BehaviorSafetyRecord } from "../schema/behavior-safety"
import { Defect } from "../schema/defect"
import { SoftwareAnalysisReport, type FunctionInfo } from "../schema/sut"
import { CompilationEnvironment } from "../schema/compilation"
import {
  InspectorLocalSubgraphContext,
  InspectorLocalSubgraphManifest,
  type InspectorLocalSubgraphContext as InspectorLocalSubgraphContextData,
} from "../schema/context-pack"

const DEFAULT_BATCH_CONCURRENCY = 1
const SAFETY_PLAN_PATH = ".matrix/data/behavior-safety-plan.json"
const CONTEXTS_OUTPUT_DIR = ".matrix/data/contexts"
const CODE_SLICE_BATCH_DIR = "__local_subgraph__"
const BehaviorSafetyStrategy = tool.schema.enum(["code_slice", "per_file_fallback"])

const BatchFinding = tool.schema.object({
  file_path: tool.schema.string().min(1),
  function_name: tool.schema.string(),
  line_start: tool.schema.number(),
  line_end: tool.schema.number().optional(),
  category: tool.schema.enum([
    "logic_error",
    "boundary_error",
    "null_pointer",
    "buffer_overflow",
    "integer_overflow",
    "resource_leak",
    "concurrency",
    "interrupt_conflict",
    "atomicity_violation",
    "coding_standard",
    "requirement_mismatch",
    "interface_error",
    "performance",
    "timing",
    "dangling_pointer",
    "float_error",
    "uninitialized_variable",
    "double_free",
    "alignment_error",
    "other",
  ]),
  severity: tool.schema.enum(["critical", "major", "minor", "suggestion"]),
  title: tool.schema.string().optional().default("Behavioral safety issue"),
  description: tool.schema.string().optional().default(""),
  trigger: tool.schema.string().optional().default(""),
  consequence: tool.schema.string().optional().default(""),
  related_requirement_ids: tool.schema.array(tool.schema.string()).optional(),
})

const BatchLLMResponse = tool.schema.object({
  reviewed_functions: tool.schema.array(tool.schema.string()),
  findings: tool.schema.array(BatchFinding).default([]),
})

const PlannedReviewedFunction = tool.schema.object({
  function_name: tool.schema.string(),
  function_id: tool.schema.string().optional(),
  file_path: tool.schema.string().optional(),
  line_range: tool.schema.object({
    start: tool.schema.number(),
    end: tool.schema.number(),
  }),
  batch_id: tool.schema.string().optional(),
})

const BehaviorSafetyPlanBatch = tool.schema.object({
  batch_id: tool.schema.string(),
  batch_index: tool.schema.number(),
  source_file: tool.schema.string(),
  absolute_path: tool.schema.string(),
  strategy: BehaviorSafetyStrategy,
  slicing_strategy: tool.schema.enum(["local_subgraph"]).optional(),
  functions_in_batch: tool.schema.array(PlannedReviewedFunction),
  context_id: tool.schema.string().optional(),
  context_path: tool.schema.string().optional(),
  context_function_names: tool.schema.array(tool.schema.string()).optional(),
})

const BehaviorSafetyPlanFile = tool.schema.object({
  source_file: tool.schema.string(),
  absolute_path: tool.schema.string(),
  strategy: BehaviorSafetyStrategy,
  analysis_unit: tool.schema.enum(["slice", "file"]),
  function_count: tool.schema.number(),
  batch_count: tool.schema.number(),
  batch_ids: tool.schema.array(tool.schema.string()),
  fallback_reason: tool.schema.string().optional(),
})

const BehaviorSafetyExecutionPlan = tool.schema.object({
  status: tool.schema.literal("success"),
  strategy: BehaviorSafetyStrategy,
  slicing_strategy: tool.schema.enum(["local_subgraph"]).optional(),
  files_analyzed: tool.schema.number(),
  analysis_unit: tool.schema.enum(["slice", "file"]),
  fallback_reason: tool.schema.string().optional(),
  planned_files: tool.schema.array(BehaviorSafetyPlanFile),
  planned_batches: tool.schema.array(BehaviorSafetyPlanBatch),
})

type BehaviorSafetyPlanBatch = z.infer<typeof BehaviorSafetyPlanBatch>
type BehaviorSafetyPlanFile = z.infer<typeof BehaviorSafetyPlanFile>
type BehaviorSafetyExecutionPlan = z.infer<typeof BehaviorSafetyExecutionPlan>

const BATCH_CATEGORIES = [
  "logic_error",
  "boundary_error",
  "null_pointer",
  "buffer_overflow",
  "integer_overflow",
  "resource_leak",
  "concurrency",
  "interrupt_conflict",
  "atomicity_violation",
  "coding_standard",
  "requirement_mismatch",
  "interface_error",
  "performance",
  "timing",
  "dangling_pointer",
  "float_error",
  "uninitialized_variable",
  "double_free",
  "alignment_error",
  "other",
] as const

const BATCH_SEVERITIES = ["critical", "major", "minor", "suggestion"] as const

type BatchCategory = (typeof BATCH_CATEGORIES)[number]
type BatchSeverity = (typeof BATCH_SEVERITIES)[number]

interface ResolvedLLMConfig {
  providerID: string
  modelID: string
}

type ParsedFunction = {
  id: string
  name: string
  file_path: string
  line_range: { start: number; end: number }
  return_type: string
  parameters: Array<{ name: string; type: string }>
  cyclomatic_complexity: number
  calls: string[]
  safety_critical: boolean
  body?: string
}

function readInspectorLocalSubgraphContexts(
  outputDir: string,
  manifestPathInput?: string,
): Array<{ path: string; data: InspectorLocalSubgraphContextData }> {
  const manifestPath = manifestPathInput ? resolve(manifestPathInput) : resolve(outputDir, "manifest.json")
  const manifestParsed = InspectorLocalSubgraphManifest.safeParse(JSON.parse(readFileSync(manifestPath, "utf-8")))
  if (!manifestParsed.success) {
    throw new Error(`Invalid local_subgraph manifest: ${manifestParsed.error.message}`)
  }
  return manifestParsed.data.contexts.map((entry) => {
    const contextPath = resolve(outputDir, entry.file)
    const parsed = InspectorLocalSubgraphContext.safeParse(JSON.parse(readFileSync(contextPath, "utf-8")))
    if (!parsed.success) {
      throw new Error(`Invalid local_subgraph context ${entry.context_id}: ${parsed.error.message}`)
    }
    if (parsed.data.context_id !== entry.context_id) {
      throw new Error(`Context file ${contextPath} has mismatched context_id ${parsed.data.context_id}; expected ${entry.context_id}.`)
    }
    return {
      path: contextPath,
      data: parsed.data,
    }
  })
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
    if (providerID && modelID) {
      return {
        providerID,
        modelID,
      }
    }
  }

  return null
}

async function resolveRuntimeModel(
  client: OpencodeClient,
  context: ToolContext,
): Promise<ResolvedLLMConfig> {
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
  if (fromCurrentMessage) {
    return fromCurrentMessage
  }

  const cfg = await client.config.get({
    query: { directory: context.directory },
  })
  if (cfg.error || !cfg.data) {
    throw new Error("Failed to resolve current OpenCode model")
  }

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

  const providerConfigObj = providerConfig as {
    models?: Record<string, unknown>
  }

  if (!modelID) {
    const providerModels = providerConfigObj.models ?? {}
    if (Object.keys(providerModels).length === 1) {
      modelID = Object.keys(providerModels)[0] ?? ""
    }
  }

  if (!providerID || !modelID) {
    throw new Error("OpenCode model/provider config is incomplete")
  }

  return {
    providerID,
    modelID,
  }
}
async function callLLM(
  client: OpencodeClient,
  prompt: string,
  context: ToolContext,
): Promise<string> {
  const config = await resolveRuntimeModel(client, context)
  const child = await client.session.create({
    query: { directory: context.directory },
    body: {
      parentID: context.sessionID,
      title: "behavioral-safety-batch",
    },
  })
  if (child.error || !child.data) {
    throw new Error("Failed to create OpenCode execution session for behavioral safety batch")
  }

  const sessionID = child.data.id

  try {
    const response = await client.session.prompt({
      path: { id: sessionID },
      query: { directory: context.directory },
      body: {
        model: {
          providerID: config.providerID,
          modelID: config.modelID,
        },
        system: [
          "You are a batch behavioral safety analyzer for embedded C/C++.",
          "Return exactly one JSON object with keys reviewed_functions and findings.",
          "Do not call tools.",
          "Do not add markdown fences or prose.",
        ].join("\n"),
        tools: {},
        parts: [{ type: "text", text: prompt }],
      },
    })

    if (response.error || !response.data) {
      throw new Error("OpenCode session prompt failed for behavioral safety batch")
    }
    if (response.data.info.error) {
      const err = response.data.info.error
      if (err.name === "APIError") {
        throw new Error(`LLM API ${err.data.statusCode ?? "error"}: ${err.data.responseBody ?? err.data.message}`)
      }
      throw new Error(typeof err.data?.message === "string" ? err.data.message : err.name)
    }


    const text = response.data.parts
      .flatMap((part) => (part.type === "text" && typeof (part as any).text === "string") ? [(part as any).text as string] : [])
      .join("\n")
      .trim()

    return text
  } finally {
    await client.session.delete({
      path: { id: sessionID },
      query: { directory: context.directory },
    }).catch(() => undefined)
  }
}

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced?.[1]) return fenced[1].trim()
  const firstBrace = text.indexOf("{")
  const lastBrace = text.lastIndexOf("}")
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return text.slice(firstBrace, lastBrace + 1)
  }
  return text.trim()
}

function normalizeLineNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(1, Math.floor(value))
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim())
    if (Number.isFinite(parsed)) {
      return Math.max(1, Math.floor(parsed))
    }
  }
  return fallback
}

function normalizeString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
}

function normalizeCategory(value: unknown): BatchCategory {
  if (typeof value === "string" && (BATCH_CATEGORIES as readonly string[]).includes(value)) {
    return value as BatchCategory
  }
  return "other"
}

function normalizeSeverity(value: unknown): BatchSeverity {
  if (typeof value === "string" && (BATCH_SEVERITIES as readonly string[]).includes(value)) {
    return value as BatchSeverity
  }
  return "major"
}

function normalizeBatchResponse(
  rawValue: unknown,
  batchFunctions: ParsedFunction[],
): z.input<typeof BatchLLMResponse> {
  const expectedFunctionNames = batchFunctions.map((fn) => fn.name)
  const root = rawValue && typeof rawValue === "object" ? rawValue as Record<string, unknown> : {}
  const findings = Array.isArray(root.findings) ? root.findings : []

  return {
    reviewed_functions: normalizeStringArray(root.reviewed_functions) ?? expectedFunctionNames,
    findings: findings
      .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
      .map((finding, index) => {
        const fallbackFn = expectedFunctionNames[0] ?? ""
        return {
          file_path: normalizeString(finding.file_path, ""),
          function_name: normalizeString(finding.function_name, fallbackFn),
          line_start: normalizeLineNumber(finding.line_start, batchFunctions[0]?.line_range.start ?? index + 1),
          line_end: finding.line_end === undefined
            ? undefined
            : normalizeLineNumber(finding.line_end, batchFunctions[0]?.line_range.end ?? batchFunctions[0]?.line_range.start ?? index + 1),
          category: normalizeCategory(finding.category),
          severity: normalizeSeverity(finding.severity),
          title: normalizeString(finding.title, "Behavioral safety issue"),
          description: normalizeString(finding.description, ""),
          trigger: normalizeString(finding.trigger, ""),
          consequence: normalizeString(finding.consequence, ""),
          related_requirement_ids: normalizeStringArray(finding.related_requirement_ids),
        }
      }),
  }
}

function buildBatchRepairPrompt(options: {
  rawOutput: string
  errorMessage: string
  batchFunctions: ParsedFunction[]
}): string {
  const expectedFunctionNames = options.batchFunctions.map((fn) => fn.name)
  return [
    "Repair the following invalid behavioral safety analysis output.",
    "Return exactly one valid JSON object and nothing else.",
    `The reviewed_functions field must be this exact array: ${JSON.stringify(expectedFunctionNames)}.`,
    "If there are no defects, return findings as [].",
    "Every finding must contain: file_path, function_name, line_start, category, severity, title, description, trigger, consequence.",
    "Allowed category values: logic_error, boundary_error, null_pointer, buffer_overflow, integer_overflow, resource_leak, concurrency, interrupt_conflict, atomicity_violation, coding_standard, requirement_mismatch, interface_error, performance, timing, dangling_pointer, float_error, uninitialized_variable, double_free, alignment_error, other.",
    "Allowed severity values: critical, major, minor, suggestion.",
    `Validation error: ${options.errorMessage}`,
    `Invalid output: ${options.rawOutput}`,
  ].join("\n")
}

async function parseBatchResponseWithRepair(options: {
  client: OpencodeClient
  context: ToolContext
  rawOutput: string
  batchFunctions: ParsedFunction[]
}): Promise<z.infer<typeof BatchLLMResponse>> {
  const attemptParse = (rawText: string): z.infer<typeof BatchLLMResponse> => {
    const parsedJson = JSON.parse(extractJson(rawText))
    const normalized = normalizeBatchResponse(parsedJson, options.batchFunctions)
    return BatchLLMResponse.parse(normalized)
  }

  try {
    return attemptParse(options.rawOutput)
  } catch (error) {
    const repairPrompt = buildBatchRepairPrompt({
      rawOutput: options.rawOutput,
      errorMessage: error instanceof Error ? error.message : String(error),
      batchFunctions: options.batchFunctions,
    })
    const repairedRaw = await callLLM(options.client, repairPrompt, options.context)
    return attemptParse(repairedRaw)
  }
}

function loadAnalysis(projectDir: string): { projectName: string; version: string; functions: FunctionInfo[] } {
  const path = join(projectDir, ".matrix/data/software-analysis.json")
  if (!existsSync(path)) {
    return { projectName: basename(projectDir), version: "unknown", functions: [] }
  }
  const parsed = SoftwareAnalysisReport.safeParse(JSON.parse(readFileSync(path, "utf-8")))
  if (!parsed.success) {
    return { projectName: basename(projectDir), version: "unknown", functions: [] }
  }
  return {
    projectName: parsed.data.project_name,
    version: parsed.data.version,
    functions: parsed.data.functions,
  }
}

function loadCompilationContext(projectDir: string): string {
  const path = join(projectDir, ".matrix/data/compilation-env.json")
  if (!existsSync(path)) return "unknown"
  const parsed = CompilationEnvironment.safeParse(JSON.parse(readFileSync(path, "utf-8")))
  if (!parsed.success) return "unknown"
  const data = parsed.data
  return JSON.stringify({
    compiler_dialect: data.compiler_dialect,
    target_cpu: data.target_cpu,
    build_system: data.build_system,
    include_dirs: data.include_dirs?.slice(0, 12) ?? [],
  })
}

function collectImplementationFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if ([".git", ".matrix", "node_modules", "dist", "release"].includes(entry)) continue
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      collectImplementationFiles(full, out)
      continue
    }
    if (!st.isFile()) continue
    const ext = extname(entry).toLowerCase()
    if ([".c", ".cc", ".cpp", ".cxx"].includes(ext)) {
      out.push(full)
    }
  }
}

async function parseFunctions(filePath: string, functionNames?: string[], includeBodies = false): Promise<ParsedFunction[]> {
  const raw = await (codeParser as any).execute({
    path: filePath,
    recursive: false,
    ...(functionNames?.length ? { function_names: functionNames } : {}),
    ...(includeBodies ? { include_bodies: true } : {}),
  })
  const parsed = JSON.parse(raw)
  return (parsed.functions || []) as ParsedFunction[]
}

function batchId(batchIndex: number): string {
  return `batch-${String(batchIndex).padStart(3, "0")}`
}

function clearDirectory(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
}

function sanitizeBaseName(filePath: string): string {
  return basename(filePath).replace(/[^\w.-]+/g, "_")
}

function projectRelative(root: string, filePath: string): string {
  return relative(root, filePath).replace(/\\/g, "/")
}

function getPlanPath(root: string): string {
  return join(root, SAFETY_PLAN_PATH)
}

function resolveTargetFiles(root: string, target_file?: string, target_dir?: string): string[] {
  const files: string[] = []
  if (target_file) {
    const abs = resolve(target_file)
    if (!existsSync(abs)) {
      throw new Error(`target_file not found: ${target_file}`)
    }
    files.push(abs)
    return files
  }

  const dir = resolve(target_dir || ".")
  if (!existsSync(dir)) {
    throw new Error(`target_dir not found: ${target_dir || "."}`)
  }
  collectImplementationFiles(dir, files)
  return files
}

function getBatchDir(root: string, absolutePath: string): string {
  return join(root, ".matrix/data/safety-batches", sanitizeBaseName(absolutePath))
}

function getCodeSliceBatchDir(root: string): string {
  return join(root, ".matrix/data/safety-batches", CODE_SLICE_BATCH_DIR)
}

function toReviewedFunction(
  functionName: string,
  lineRange: { start: number; end: number },
  batchID?: string,
  functionID?: string,
  filePath?: string,
): z.infer<typeof PlannedReviewedFunction> {
  return {
    function_name: functionName,
    ...(functionID ? { function_id: functionID } : {}),
    ...(filePath ? { file_path: filePath } : {}),
    line_range: lineRange,
    ...(batchID ? { batch_id: batchID } : {}),
  }
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function dedupeReviewedFunctions(
  functions: Array<z.infer<typeof PlannedReviewedFunction>>,
): Array<z.infer<typeof PlannedReviewedFunction>> {
  const seen = new Set<string>()
  const result: Array<z.infer<typeof PlannedReviewedFunction>> = []
  for (const item of functions) {
    const key = item.function_id ?? `${item.file_path ?? ""}:${item.function_name}:${item.line_range.start}:${item.line_range.end}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(item)
  }
  return result
}

function writePlan(root: string, plan: BehaviorSafetyExecutionPlan): void {
  const planPath = getPlanPath(root)
  mkdirSync(join(root, ".matrix/data"), { recursive: true })
  writeFileSync(planPath, JSON.stringify(plan, null, 2), "utf-8")
}

function loadPlan(root: string): BehaviorSafetyExecutionPlan {
  const planPath = getPlanPath(root)
  if (!existsSync(planPath)) {
    throw new Error(`behavior safety plan not found: ${projectRelative(root, planPath)}`)
  }
  return BehaviorSafetyExecutionPlan.parse(JSON.parse(readFileSync(planPath, "utf-8")))
}

function toFallbackReason(result: Record<string, unknown>): string {
  const error = typeof result.error === "string" ? result.error : "code-slice context-pack failed"
  const hint = typeof result.hint === "string" ? result.hint : ""
  return hint ? `${error} ${hint}` : error
}

function buildPerFileFallbackPlan(
  root: string,
  inventories: Map<string, ParsedFunction[]>,
  fallbackReason: string,
): BehaviorSafetyExecutionPlan {
  const plannedFiles: BehaviorSafetyPlanFile[] = []
  const plannedBatches: BehaviorSafetyPlanBatch[] = []
  let globalBatchIndex = 1

  for (const [absolutePath, inventory] of inventories.entries()) {
    const sourceFile = projectRelative(root, absolutePath)
    const currentBatchID = batchId(globalBatchIndex)
    globalBatchIndex += 1
    plannedFiles.push({
      source_file: sourceFile,
      absolute_path: absolutePath,
      strategy: "per_file_fallback",
      analysis_unit: "file",
      function_count: inventory.length,
      batch_count: 1,
      batch_ids: [currentBatchID],
      fallback_reason: fallbackReason,
    })
    plannedBatches.push({
      batch_id: currentBatchID,
      batch_index: plannedBatches.length + 1,
      source_file: sourceFile,
      absolute_path: absolutePath,
      strategy: "per_file_fallback",
      functions_in_batch: inventory.map((fn) => toReviewedFunction(fn.name, fn.line_range, currentBatchID, fn.id, sourceFile)),
    })
  }

  return {
    status: "success",
    strategy: "per_file_fallback",
    files_analyzed: plannedFiles.length,
    analysis_unit: "file",
    fallback_reason: fallbackReason,
    planned_files: plannedFiles,
    planned_batches: plannedBatches,
  }
}

function buildCodeSlicePlanFromContexts(
  root: string,
  targetFiles: string[],
  contexts: Array<{ path: string; data: InspectorLocalSubgraphContextData }>,
): BehaviorSafetyExecutionPlan {
  if (contexts.length === 0) {
    throw new Error("code-slice generated no local_subgraph contexts")
  }

  const plannedBatches: BehaviorSafetyPlanBatch[] = []
  const batchIDs: string[] = []
  const syntheticSourceFile = "__local_subgraph__"

  contexts.forEach((entry, index) => {
    const currentBatchID = batchId(index + 1)
    batchIDs.push(currentBatchID)
    const reviewedFunctions = dedupeReviewedFunctions(
      entry.data.locations.functions.map((location) =>
        toReviewedFunction(
          location.name,
          { start: location.start_line, end: location.end_line },
          currentBatchID,
          undefined,
          location.path.replace(/\\/g, "/"),
        ),
      )
    )

    plannedBatches.push({
      batch_id: currentBatchID,
      batch_index: index + 1,
      source_file: syntheticSourceFile,
      absolute_path: root,
      strategy: "code_slice",
      slicing_strategy: "local_subgraph",
      context_id: entry.data.context_id,
      context_path: entry.path,
      context_function_names: dedupeStrings(entry.data.locations.functions.map((fn) => fn.name)),
      functions_in_batch: reviewedFunctions,
    })
  })

  const plannedFiles: BehaviorSafetyPlanFile[] = [{
    source_file: syntheticSourceFile,
    absolute_path: root,
    strategy: "code_slice",
    analysis_unit: "slice",
    function_count: plannedBatches.reduce((total, batch) => total + batch.functions_in_batch.length, 0),
    batch_count: batchIDs.length,
    batch_ids: batchIDs,
  }]

  return {
    status: "success",
    strategy: "code_slice",
    slicing_strategy: "local_subgraph",
    files_analyzed: targetFiles.length,
    analysis_unit: "slice",
    planned_files: plannedFiles,
    planned_batches: plannedBatches,
  }
}

async function buildExecutionPlan(root: string, targetFiles: string[]): Promise<BehaviorSafetyExecutionPlan> {
  const inventories = new Map<string, ParsedFunction[]>()
  for (const filePath of targetFiles) {
    inventories.set(filePath, await parseFunctions(filePath))
  }

  const codeSliceResult = await executeCodeSliceContextPack({
    project_dir: root,
    output_dir: CONTEXTS_OUTPUT_DIR,
    slicing_strategy: "local_subgraph",
  })
  return buildExecutionPlanFromCodeSliceResult(root, targetFiles, inventories, codeSliceResult)
}

function buildExecutionPlanFromCodeSliceResult(
  root: string,
  targetFiles: string[],
  inventories: Map<string, ParsedFunction[]>,
  codeSliceResult: Record<string, unknown>,
): BehaviorSafetyExecutionPlan {
  if (codeSliceResult.status !== "success") {
    return buildPerFileFallbackPlan(root, inventories, toFallbackReason(codeSliceResult))
  }

  try {
    const contexts = readInspectorLocalSubgraphContexts(
      join(root, CONTEXTS_OUTPUT_DIR),
      typeof codeSliceResult.manifest_file === "string" ? codeSliceResult.manifest_file : undefined,
    )
    return buildCodeSlicePlanFromContexts(root, targetFiles, contexts)
  } catch (error) {
    return buildPerFileFallbackPlan(
      root,
      inventories,
      error instanceof Error ? error.message : String(error),
    )
  }
}

function findPlanFileByBatchID(plan: BehaviorSafetyExecutionPlan, batchID: string): BehaviorSafetyPlanFile | undefined {
  return plan.planned_files.find((file) => file.batch_ids.includes(batchID))
}

function findPlanBatchByID(
  plan: BehaviorSafetyExecutionPlan,
  batchID: string,
): BehaviorSafetyPlanBatch | undefined {
  return plan.planned_batches.find((batch) => batch.batch_id === batchID)
}

function findPlanFile(plan: BehaviorSafetyExecutionPlan, sourceFile: string): BehaviorSafetyPlanFile | undefined {
  return plan.planned_files.find((file) => file.source_file === sourceFile)
}

function buildTraceabilityHints(
  analysisFunctions: FunctionInfo[],
  functionNames: string[],
): Array<{
  name: string
  id: string
  related_requirements: string[]
  safety_critical: boolean
}> {
  return analysisFunctions
    .filter((fn) => functionNames.includes(fn.name))
    .map((fn) => ({
      name: fn.name,
      id: fn.id,
      related_requirements: fn.related_requirements,
      safety_critical: fn.safety_critical,
    }))
}

function buildCodeSliceBatchPrompt(options: {
  projectRelativePath: string
  compilationContext: string
  batchIndex: number
  batchCount: number
  contextID: string
  contextText: string
  functionsInBatch: ParsedFunction[]
  traceability: Array<{
    name: string
    id: string
    related_requirements: string[]
    safety_critical: boolean
  }>
}): string {
  return [
    "You are a behavioral safety analyzer for embedded C/C++.",
    "Analyze the provided local_subgraph code-slice context and return JSON only.",
    "The input is a local_subgraph context already assembled by code-slice.",
    "Do not reconstruct, split, merge, or reinterpret the context structure.",
    "Do not infer hidden chain/path relationships or rebuild a function_chain; the only accepted context shape is local_subgraph.",
    "The batch unit is one local_subgraph context, not one function or source file.",
    "Use prompt_ready.text as the primary semantic evidence.",
    "Only report concrete defects with an identifiable trigger and consequence.",
    "Do not report coding-style-only issues or speculative risks.",
    "Every finding must include one unique source location: file_path, function_name, line_start, and line_end.",
    "Use the exact file_path from the code-slice text; do not classify defects by context_id or by the synthetic batch source file.",
    "If no defect exists, return the exact reviewed_functions array for this batch and findings: [].",
    "Output schema:",
    '{"reviewed_functions":["fn1"],"findings":[{"file_path":"src/a.c","function_name":"...","line_start":1,"line_end":2,"category":"logic_error","severity":"major","title":"...","description":"...","trigger":"...","consequence":"...","related_requirement_ids":["REQ-1"]}]}',
    `Owned source file: ${options.projectRelativePath}`,
    `Batch: ${options.batchIndex}/${options.batchCount}`,
    `Context ID: ${options.contextID}`,
    `Compilation context: ${options.compilationContext}`,
    `Traceability hints: ${JSON.stringify(options.traceability)}`,
    `Reviewed functions for this batch: ${JSON.stringify(options.functionsInBatch.map((fn) => ({ name: fn.name, line_range: fn.line_range, calls: fn.calls })))}`,
    "Code-slice context:",
    options.contextText,
  ].join("\n")
}

function buildPerFileBatchPrompt(options: {
  projectRelativePath: string
  compilationContext: string
  allFunctions: ParsedFunction[]
  analysisFunctions: FunctionInfo[]
}): string {
  const inventory = options.allFunctions.map((fn) => ({
    name: fn.name,
    line_range: fn.line_range,
    return_type: fn.return_type,
    parameters: fn.parameters,
    calls: fn.calls,
    body: fn.body ?? "",
  }))
  const traceability = buildTraceabilityHints(
    options.analysisFunctions,
    options.allFunctions.map((fn) => fn.name),
  )

  return [
    "You are a behavioral safety analyzer for embedded C/C++.",
    "Analyze the entire provided source file as one fallback batch and return JSON only.",
    "The primary unit here is the whole source file because code-slice was unavailable.",
    "Only report concrete semantic or behavioral defects with clear trigger and consequence.",
    "Do not report coding-style-only issues or speculative risks.",
    "Every finding must include the source file path and a concrete line range.",
    "If no defect exists, return the exact reviewed_functions array for this batch and findings: [].",
    "Output schema:",
    '{"reviewed_functions":["fn1"],"findings":[{"file_path":"src/a.c","function_name":"...","line_start":1,"line_end":2,"category":"logic_error","severity":"major","title":"...","description":"...","trigger":"...","consequence":"...","related_requirement_ids":["REQ-1"]}]}',
    `Source file: ${options.projectRelativePath}`,
    `Compilation context: ${options.compilationContext}`,
    `Traceability hints: ${JSON.stringify(traceability)}`,
    `Full file function inventory with bodies: ${JSON.stringify(inventory)}`,
  ].join("\n")
}

function createPseudoParsedFunctions(batch: BehaviorSafetyPlanBatch): ParsedFunction[] {
  return batch.functions_in_batch.map((fn, index) => ({
    id: fn.function_id ?? `planned-${index + 1}`,
    name: fn.function_name,
    file_path: fn.file_path ?? batch.source_file,
    line_range: fn.line_range,
    return_type: "",
    parameters: [],
    cyclomatic_complexity: 0,
    calls: [],
    safety_critical: false,
    body: "",
  }))
}

function toDefect(
  finding: {
    file_path: string
    function_name: string
    line_start: number
    line_end?: number
    category: z.infer<typeof BatchFinding>["category"]
    severity: z.infer<typeof BatchFinding>["severity"]
    title: string
    description: string
    trigger: string
    consequence: string
    related_requirement_ids?: string[]
  },
  functionMeta?: FunctionInfo,
  ordinal?: number,
) {
  const filePath = finding.file_path.replace(/\\/g, "/")
  return {
    id: `DEF-BS-F${String(ordinal ?? 1).padStart(3, "0")}`,
    source: "code_review" as const,
    severity: finding.severity,
    category: finding.category,
    location: {
      file_path: filePath,
      line_start: finding.line_start,
      ...(finding.line_end ? { line_end: finding.line_end } : {}),
      function_name: finding.function_name,
      ...(functionMeta?.id ? { function_id: functionMeta.id } : {}),
    },
    title: finding.title,
    description:
      `${finding.description}\nTrigger: ${finding.trigger}\nConsequence: ${finding.consequence}`,
    related_requirement_ids: finding.related_requirement_ids ?? functionMeta?.related_requirements ?? [],
    status: "open" as const,
    detected_by: "behavioral-safety-review",
    detected_date: new Date().toISOString(),
  }
}

function renumberDefects(defects: z.infer<typeof Defect>[]): z.infer<typeof Defect>[] {
  return defects.map((defect, index) => ({
    ...defect,
    id: `DEF-BS-F${String(index + 1).padStart(3, "0")}`,
  }))
}

function isSameProjectFile(root: string, defectPath: string, absolutePath: string): boolean {
  const normalizedDefectPath = defectPath.replace(/\\/g, "/")
  const projectPath = projectRelative(root, absolutePath)
  const absoluteNormalized = absolutePath.replace(/\\/g, "/")
  return normalizedDefectPath === projectPath
    || normalizedDefectPath === absoluteNormalized
    || absoluteNormalized.endsWith(normalizedDefectPath)
}

function readBatchRecordsFromDir(dir: string): {
  batchFiles: string[]
  batchRecords: z.infer<typeof BehaviorSafetyBatchRecord>[]
  invalidBatches: string[]
} {
  mkdirSync(dir, { recursive: true })
  const batchFiles = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()

  const batchRecords: z.infer<typeof BehaviorSafetyBatchRecord>[] = []
  const invalidBatches: string[] = []

  for (const name of batchFiles) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, name), "utf-8"))
      const parsed = BehaviorSafetyBatchRecord.safeParse(raw)
      if (parsed.success) {
        batchRecords.push(parsed.data)
      } else {
        invalidBatches.push(name)
      }
    } catch {
      invalidBatches.push(name)
    }
  }

  return {
    batchFiles,
    batchRecords,
    invalidBatches,
  }
}

async function executeOneBatch(options: {
  client: OpencodeClient
  context: ToolContext
  root: string
  projectName: string
  version: string
  compilationContext: string
  analysisFunctions: FunctionInfo[]
  planBatch: BehaviorSafetyPlanBatch
  planFile: BehaviorSafetyPlanFile
}): Promise<z.infer<typeof BehaviorSafetyBatchRecord>> {
  const {
    client,
    context,
    root,
    projectName,
    version,
    compilationContext,
    analysisFunctions,
    planBatch,
    planFile,
  } = options
  const fileAnalysisFunctions = analysisFunctions.filter(
    (fn) => resolve(fn.file_path) === planBatch.absolute_path || fn.file_path.replace(/\\/g, "/").endsWith(planBatch.source_file),
  )

  let batchFunctions: ParsedFunction[] = []
  let prompt = ""

  if (planBatch.strategy === "code_slice") {
    if (!planBatch.context_path || !existsSync(planBatch.context_path)) {
      throw new Error(`context_path not found for ${planBatch.batch_id}: ${planBatch.context_path ?? "missing"}`)
    }
    const contextData = InspectorLocalSubgraphContext.parse(JSON.parse(readFileSync(planBatch.context_path, "utf-8")))
    batchFunctions = createPseudoParsedFunctions(planBatch)
    prompt = buildCodeSliceBatchPrompt({
      projectRelativePath: planBatch.source_file,
      compilationContext,
      batchIndex: planBatch.batch_index,
      batchCount: planFile.batch_count,
      contextID: planBatch.context_id ?? contextData.context_id,
      contextText: contextData.prompt_ready.text,
      functionsInBatch: batchFunctions,
      traceability: buildTraceabilityHints(
        fileAnalysisFunctions,
        dedupeStrings(batchFunctions.map((fn) => fn.name)),
      ),
    })
  } else {
    batchFunctions = await parseFunctions(planBatch.absolute_path, undefined, true)
    prompt = buildPerFileBatchPrompt({
      projectRelativePath: planBatch.source_file,
      compilationContext,
      allFunctions: batchFunctions,
      analysisFunctions: fileAnalysisFunctions,
    })
  }

  const reviewedFunctionsForRepair = batchFunctions.length > 0 ? batchFunctions : createPseudoParsedFunctions(planBatch)

  const raw = await callLLM(client, prompt, context)
  const parsedResponse = await parseBatchResponseWithRepair({
    client,
    context,
    rawOutput: raw,
    batchFunctions: reviewedFunctionsForRepair,
  })

  const reviewedFns = dedupeReviewedFunctions(
    reviewedFunctionsForRepair.map((fn) =>
      toReviewedFunction(
        fn.name,
        fn.line_range,
        planBatch.batch_id,
        fileAnalysisFunctions.find((x) => x.name === fn.name)?.id ?? fn.id,
        fn.file_path.replace(/\\/g, "/"),
      ),
    ),
  )

  const defects = parsedResponse.findings.map((finding, findingIndex) =>
    toDefect(
      finding,
      analysisFunctions.find((fn) =>
        fn.name === finding.function_name
          && fn.file_path.replace(/\\/g, "/").endsWith(finding.file_path.replace(/\\/g, "/")),
      ) ?? fileAnalysisFunctions.find((fn) => fn.name === finding.function_name),
      findingIndex + 1,
    ),
  )

  const batchRecord = BehaviorSafetyBatchRecord.parse({
    project_name: projectName,
    version,
    created_date: new Date().toISOString(),
    schema_name: "BehaviorSafetyBatchRecord",
    batch_id: planBatch.batch_id,
    strategy: planBatch.strategy,
    source_file: planBatch.source_file,
    ...(planBatch.context_id ? { context_id: planBatch.context_id } : {}),
    ...(planBatch.context_path ? { context_path: planBatch.context_path } : {}),
    functions_in_batch: reviewedFns,
    defects,
    summary: {
      functions_in_batch: reviewedFns.length,
      defects_in_batch: defects.length,
      status: "completed",
    },
  })

  const batchDir = planBatch.strategy === "code_slice"
    ? getCodeSliceBatchDir(root)
    : getBatchDir(root, planBatch.absolute_path)
  const batchPath = join(batchDir, `${batchRecord.batch_id}.json`)
  mkdirSync(batchDir, { recursive: true })
  writeFileSync(batchPath, JSON.stringify(batchRecord, null, 2), "utf-8")
  return batchRecord
}

async function finalizeOneFile(
  root: string,
  absolutePath: string,
  projectName: string,
  version: string,
  planFile?: BehaviorSafetyPlanFile,
): Promise<{
  source_file: string
  batch_count: number
  valid_batch_count: number
  reviewed_functions: number
  total_defects: number
  final_record: string
}> {
  const projectRelativePath = projectRelative(root, absolutePath)
  const inventory = await parseFunctions(absolutePath)
  const executionStrategy = planFile?.strategy
  const readResult = executionStrategy === "code_slice"
    ? readBatchRecordsFromDir(getCodeSliceBatchDir(root))
    : readBatchRecordsFromDir(getBatchDir(root, absolutePath))
  const batchFiles = readResult.batchFiles
  const invalidBatches = readResult.invalidBatches
  const batchRecords = readResult.batchRecords

  const allReviewedFunctions = dedupeReviewedFunctions(
    batchRecords.flatMap((record) => record.functions_in_batch)
      .filter((fn) => !fn.file_path || isSameProjectFile(root, fn.file_path, absolutePath)),
  )
  const allDefects = renumberDefects(
    batchRecords.flatMap((record) => record.defects)
      .filter((defect) => isSameProjectFile(root, defect.location.file_path, absolutePath)),
  )
  const resolvedExecutionStrategy = executionStrategy ?? batchRecords[0]?.strategy
  const analysisUnit = planFile?.analysis_unit
    ?? (resolvedExecutionStrategy === "code_slice" ? "slice" : resolvedExecutionStrategy === "per_file_fallback" ? "file" : "function")
  const totalUnits = planFile?.batch_count ?? inventory.length
  const reviewedUnits = analysisUnit === "file" ? Math.min(batchRecords.length, totalUnits) : batchRecords.length
  const coverageStatus =
    totalUnits === 0
      ? "none"
      : invalidBatches.length === 0 && reviewedUnits >= totalUnits
        ? "full"
        : reviewedUnits > 0
          ? "partial"
          : "none"

  const finalRecord = BehaviorSafetyRecord.parse({
    project_name: projectName,
    version,
    created_date: new Date().toISOString(),
    schema_name: "BehaviorSafetyRecord",
    source_file: projectRelativePath,
    functions_reviewed: allReviewedFunctions,
    defects: allDefects,
    summary: {
      total_functions: inventory.length,
      reviewed_functions: allReviewedFunctions.length,
      total_defects: allDefects.length,
      batch_count: batchFiles.length,
      ...(resolvedExecutionStrategy ? { execution_strategy: resolvedExecutionStrategy } : {}),
      ...(analysisUnit ? { analysis_unit: analysisUnit } : {}),
      total_units: totalUnits,
      reviewed_units: reviewedUnits,
      coverage_status: coverageStatus,
      ...(invalidBatches.length > 0
        ? {
            invalid_batch_count: invalidBatches.length,
            invalid_batches: invalidBatches,
          }
        : {}),
    },
  })

  const finalPath = join(root, ".matrix/data/safety-records", `${sanitizeBaseName(absolutePath)}.json`)
  mkdirSync(join(root, ".matrix/data/safety-records"), { recursive: true })
  writeFileSync(finalPath, JSON.stringify(finalRecord, null, 2), "utf-8")

  return {
    source_file: projectRelativePath,
    batch_count: batchFiles.length,
    valid_batch_count: batchRecords.length,
    reviewed_functions: allReviewedFunctions.length,
    total_defects: allDefects.length,
    final_record: projectRelative(root, finalPath),
  }
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return

  let nextIndex = 0
  const workerCount = Math.max(1, Math.min(concurrency, items.length))

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const current = nextIndex
        nextIndex += 1
        if (current >= items.length) return
        await worker(items[current], current)
      }
    }),
  )
}

export function createBehaviorSafetyPlan(client: OpencodeClient): ToolDefinition {
  return tool({
    description: "Plan behavioral safety review by discovering target files, preferring code-slice batches, and clearing old artifacts before a fresh run.",
    args: {
      target_file: tool.schema.string().optional(),
      target_dir: tool.schema.string().optional(),
    },
    async execute({ target_file, target_dir }, context) {
      void client
      const root = context.directory
      const files = resolveTargetFiles(root, target_file, target_dir)
      const safetyRecordsDir = join(root, ".matrix/data/safety-records")
      const safetyBatchesDir = join(root, ".matrix/data/safety-batches")
      clearDirectory(safetyRecordsDir)
      clearDirectory(safetyBatchesDir)
      const plan = await buildExecutionPlan(root, files)
      writePlan(root, plan)
      return JSON.stringify(plan, null, 2)
    },
  })
}

export function createBehaviorSafetyRunBatch(client: OpencodeClient): ToolDefinition {
  return tool({
    description: "Run one behavioral safety batch from the persisted plan and persist one BehaviorSafetyBatchRecord.",
    args: {
      batch_id: tool.schema.string().describe("Batch id from behavior_safety_plan"),
      batch_concurrency: tool.schema.number().optional().describe("Optional concurrent batch execution hint; default is 1."),
    },
    async execute({ batch_id, batch_concurrency }, context) {
      void batch_concurrency
      const root = context.directory
      const { projectName, version, functions: analysisFunctions } = loadAnalysis(root)
      const compilationContext = loadCompilationContext(root)
      const plan = loadPlan(root)
      const planFile = findPlanFileByBatchID(plan, batch_id)
      if (!planFile) {
        return JSON.stringify({ status: "error", error: `batch_id not found in behavior safety plan: ${batch_id}` })
      }
      const planBatch = findPlanBatchByID(plan, batch_id)
      if (!planBatch) {
        return JSON.stringify({ status: "error", error: `batch_id not found in behavior safety plan: ${batch_id}` })
      }
      if (!existsSync(planBatch.absolute_path)) {
        return JSON.stringify({ status: "error", error: `batch source path not found: ${planBatch.absolute_path}` })
      }

      const record = await executeOneBatch({
        client,
        context,
        root,
        projectName,
        version,
        compilationContext,
        analysisFunctions,
        planBatch,
        planFile,
      })

      return JSON.stringify({
        status: "success",
        source_file: record.source_file,
        strategy: record.strategy,
        slicing_strategy: planBatch.slicing_strategy,
        batch_id: record.batch_id,
        batch_index: planBatch.batch_index,
        total_batches: planFile.batch_count,
        completed_batches: planBatch.batch_index,
        remaining_batches: Math.max(0, planFile.batch_count - planBatch.batch_index),
        analysis_unit: planFile.analysis_unit,
        context_id: record.context_id,
        reviewed_functions: record.functions_in_batch.length,
        defects_in_batch: record.defects.length,
      }, null, 2)
    },
  })
}

export function createBehaviorSafetyFinalize(client: OpencodeClient): ToolDefinition {
  return tool({
    description: "Finalize behavioral safety review by merging batch artifacts into final BehaviorSafetyRecord files.",
    args: {
      target_file: tool.schema.string().optional(),
      target_dir: tool.schema.string().optional(),
    },
    async execute({ target_file, target_dir }, context) {
      void client
      void runWithConcurrency
      void DEFAULT_BATCH_CONCURRENCY
      const root = context.directory
      const { projectName, version } = loadAnalysis(root)
      const files = resolveTargetFiles(root, target_file, target_dir)
      const plan = existsSync(getPlanPath(root)) ? loadPlan(root) : null
      const results: Array<{
        source_file: string
        batch_count: number
        valid_batch_count: number
        reviewed_functions: number
        total_defects: number
        final_record: string
      }> = []

      for (const filePath of files) {
        const planFile = plan?.strategy === "code_slice"
          ? plan.planned_files[0]
          : plan ? findPlanFile(plan, projectRelative(root, filePath)) : undefined
        results.push(
          await finalizeOneFile(
            root,
            filePath,
            projectName,
            version,
            planFile,
          ),
        )
      }

      return JSON.stringify({
        status: "success",
        files_analyzed: results.length,
        strategy: plan?.strategy,
        analysis_unit: plan?.analysis_unit,
        results,
      }, null, 2)
    },
  })
}

export const __behaviorSafetyTestHooks: Record<string, any> = {
  buildCodeSliceBatchPrompt,
  buildCodeSlicePlanFromContexts,
  buildExecutionPlanFromCodeSliceResult,
  buildPerFileFallbackPlan,
  readInspectorLocalSubgraphContexts,
}
