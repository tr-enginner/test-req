import { tool, type ToolContext, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, readFileSync, readdirSync, statSync } from "fs"
import { isAbsolute, join } from "path"
import * as jsonc from "jsonc-parser/lib/esm/main.js"
import { z } from "zod"
import { MatrixConfigSchema } from "../config/schema"
import {
  SourceConfirmationTestSuite,
  TranslatedConfirmationTestSuite,
} from "../schema/confirmation-test-case"
import { Phase6CaseReviewPrepared } from "../schema/phase6-case-review-prepared"
import { Phase6ExecutionLoopArtifact } from "../schema/phase6-execution-loop"
import {
  Phase6GenerationItem,
  Phase6GenerationManifest,
  Phase6RunEvent,
  Phase6RunSnapshot,
  Phase6WorkerDiagnostic,
  Phase6WorkerResultSummary,
} from "../schema/phase6-structured-artifacts"
import { WikiIndex } from "../schema/wiki"
import { ARTIFACT_PATHS, DATA_DIR } from "../shared/constants"
import {
  loadTestRequirementFile,
  preparePhase6Input,
  type PreparedPhase6Requirement,
} from "../shared/test-requirements"

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

const SUPPORTED_ARTIFACTS = [
  "matrix_config",
  "wiki_index",
  "test_requirements",
  "phase6_generation_manifest",
  "phase6_worker_run",
  "phase6_worker_outputs",
  "source_confirmation_suite",
  "translated_confirmation_suite",
  "phase6_case_review_prepared",
  "phase6_execution_loop",
  "phase6_todo",
] as const

type ArtifactName = (typeof SUPPORTED_ARTIFACTS)[number]

interface QueryArgs {
  artifact: string
  view?: string
  requirement_id?: string
  case_id?: string
  run_id?: string
  offset?: number
  limit?: number
  include_steps?: boolean
  include_prompt?: boolean
  include_context?: boolean
}

interface QueryContext {
  projectDir: string
  artifact: string
  view: string
  offset: number
  limit: number
  requirementId?: string
  caseId?: string
  runId?: string
  includeSteps: boolean
  includePrompt: boolean
  includeContext: boolean
}

function getToolBaseDirectory(ctx?: ToolContext): string {
  const candidates = [ctx?.directory, ctx?.worktree, process.cwd()]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
  return candidates[0] || process.cwd()
}

function resolveProjectPath(projectDir: string, filePath: string): string {
  return isAbsolute(filePath) ? filePath : join(projectDir, filePath)
}

function parseJsonFile(filePath: string): { data?: unknown; error?: string } {
  if (!existsSync(filePath)) {
    return { error: "file_missing" }
  }
  try {
    return { data: JSON.parse(readFileSync(filePath, "utf-8")) }
  } catch (error) {
    return { error: `invalid_json: ${error instanceof Error ? error.message : String(error)}` }
  }
}

function parseJsoncConfig(filePath: string): { data?: unknown; error?: string } {
  if (!existsSync(filePath)) return { data: {} }
  const errors: jsonc.ParseError[] = []
  const data = jsonc.parse(readFileSync(filePath, "utf-8"), errors, { allowTrailingComma: true })
  if (errors.length > 0) {
    return { error: `invalid_jsonc: ${errors[0]?.error ?? "unknown"}` }
  }
  return { data: data ?? {} }
}

function validateWithSchema<T>(
  schema: z.ZodType<T>,
  data: unknown,
): { data?: T; error?: string } {
  const result = schema.safeParse(data)
  if (!result.success) {
    const issue = result.error.issues[0]
    const path = issue?.path.length ? issue.path.join(".") : "root"
    return { error: `${path}: ${issue?.message ?? "schema validation failed"}` }
  }
  return { data: result.data }
}

function success(
  ctx: QueryContext,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    status: "success",
    artifact: ctx.artifact,
    view: ctx.view,
    ...payload,
  }
}

function failure(
  ctx: Pick<QueryContext, "artifact" | "view">,
  code: string,
  message: string,
  payload: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    status: "error",
    artifact: ctx.artifact,
    view: ctx.view,
    schema_status: payload.schema_status ?? "not_applicable",
    error: { code, message },
    ...payload,
  }
}

function unsupportedView(ctx: QueryContext, supportedViews: string[]): Record<string, unknown> {
  return failure(
    ctx,
    "unsupported_view",
    `artifact ${ctx.artifact} does not support view ${ctx.view}`,
    { supported_views: supportedViews },
  )
}

function normalizePaging(offset?: number, limit?: number): { offset: number; limit: number } {
  const normalizedOffset = Number.isFinite(offset) ? Math.max(0, Math.trunc(offset as number)) : 0
  const requestedLimit = Number.isFinite(limit) ? Math.trunc(limit as number) : DEFAULT_LIMIT
  return {
    offset: normalizedOffset,
    limit: Math.max(1, Math.min(MAX_LIMIT, requestedLimit)),
  }
}

function paginate<T>(items: T[], offset: number, limit: number): {
  items: T[]
  pagination: { offset: number; limit: number; total: number; returned: number; has_more: boolean }
} {
  const page = items.slice(offset, offset + limit)
  return {
    items: page,
    pagination: {
      offset,
      limit,
      total: items.length,
      returned: page.length,
      has_more: offset + page.length < items.length,
    },
  }
}

function compactRequirement(
  requirement: PreparedPhase6Requirement,
  options: { includeContext: boolean },
): Record<string, unknown> {
  const compact: Record<string, unknown> = {
    requirement_id: requirement.requirement_id,
    category_key: requirement.category_key,
    test_type: requirement.test_type,
    priority: requirement.priority,
    title: requirement.title,
    title_no: requirement.title_no,
    path: requirement.path,
    chapter_title: requirement.chapter_title,
    source_requirement_ids: requirement.source_requirement_ids,
  }
  // handling/inputFlow/outputFlow 可能包含大段 HTML 表格原文，默认不返回，
  // 避免 list 视图因单条需求膨胀到数十 KB；需要完整上下文时传 include_context=true。
  if (options.includeContext) {
    compact.handling = requirement.handling
    compact.inputFlow = requirement.inputFlow
    compact.outputFlow = requirement.outputFlow
  }
  return compact
}

function countBy<T>(items: T[], keyFn: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const item of items) {
    const key = keyFn(item) || "unknown"
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

function compactGenerationItem(
  item: z.infer<typeof Phase6GenerationItem>,
  options: { includePrompt: boolean; includeContext: boolean },
): Record<string, unknown> {
  const context = options.includeContext && item.normalization_context_json
    ? (() => {
      try {
        return JSON.parse(item.normalization_context_json as string)
      } catch {
        return { error: "normalization_context_json is not valid JSON" }
      }
    })()
    : undefined

  return {
    requirement_id: item.requirement_id,
    category_key: item.category_key,
    requirement_type: item.requirement_type,
    requirement_priority: item.requirement_priority,
    test_type_chinese: item.test_type_chinese,
    source_requirement_ids: item.source_requirement_ids ?? [],
    path: item.path,
    template_key: item.template_key,
    template_file: item.template_file,
    template_source: item.template_source,
    template_hash: item.template_hash,
    template_index_file: item.template_index_file,
    template_domain: item.template_domain,
    template_selection_reason: item.template_selection_reason,
    worker_prompt_file: item.worker_prompt_file,
    generation_status: item.generation_status,
    context_gaps: item.context_gaps ?? [],
    protocol_summary_file: item.protocol_summary_file,
    protocol_semantic_file: item.protocol_semantic_file,
    input_dataset_ref: item.input_dataset_ref,
    input_dataset_file: item.input_dataset_file,
    input_dataset_id: item.input_dataset_id,
    keyword_candidate_count: item.keyword_candidates?.length ?? 0,
    ...(options.includePrompt ? { prompt: item.prompt } : {}),
    ...(options.includeContext ? { normalization_context: context } : {}),
  }
}

function compactSourceCase(testCase: Record<string, any>, includeSteps: boolean): Record<string, unknown> {
  const steps = Array.isArray(testCase.test_step) ? testCase.test_step : []
  return {
    case_id: testCase.case_id,
    case_name: testCase.case_name,
    correspond_fun_id: testCase.correspond_fun_id,
    test_type: testCase.test_type,
    path: testCase.path,
    test_input: testCase.test_input,
    related_software_req_ids: testCase.related_software_req_ids ?? "",
    step_count: steps.length,
    ...(includeSteps ? { test_step: steps } : {}),
  }
}

function compactTranslatedCase(testCase: Record<string, any>, includeSteps: boolean): Record<string, unknown> {
  const steps = Array.isArray(testCase.test_step) ? testCase.test_step : []
  return {
    case_id: testCase.case_id,
    case_name: testCase.case_name,
    translate_status: testCase.translate_status,
    correspond_fun_id: testCase.correspond_fun_id,
    test_type: testCase.test_type,
    path: testCase.path,
    test_input: testCase.test_input,
    related_software_req_ids: testCase.related_software_req_ids ?? "",
    step_count: steps.length,
    keyword_names: steps
      .map((step: Record<string, unknown>) => String(step.key_name ?? ""))
      .filter(Boolean),
    ...(includeSteps ? { test_step: steps } : {}),
  }
}

function summarizeSuite(suite: { test_cases: Array<Record<string, any>>; summary?: unknown; traceability?: unknown }): Record<string, unknown> {
  return {
    total_cases: suite.test_cases.length,
    by_type: countBy(suite.test_cases, (testCase) => String(testCase.test_type ?? "")),
    traceability_count: Array.isArray(suite.traceability) ? suite.traceability.length : 0,
    file_summary: suite.summary,
  }
}

function queryMatrixConfig(ctx: QueryContext): Record<string, unknown> {
  const relativePath = ARTIFACT_PATHS.CONFIG
  const filePath = resolveProjectPath(ctx.projectDir, relativePath)
  if (ctx.view !== "summary") return unsupportedView(ctx, ["summary"])

  const parsed = parseJsoncConfig(filePath)
  if (parsed.error) {
    return failure(ctx, "invalid_jsonc", "matrix.jsonc is not valid JSONC", {
      source_file: relativePath,
      schema_status: "invalid",
      details: parsed.error,
    })
  }
  const validated = validateWithSchema(MatrixConfigSchema, parsed.data ?? {})
  if (validated.error) {
    return failure(ctx, "schema_invalid", "matrix.jsonc does not match MatrixConfig schema", {
      source_file: relativePath,
      schema_status: "invalid",
      details: validated.error,
    })
  }

  const config = validated.data!
  return success(ctx, {
    source_file: relativePath,
    schema_status: existsSync(filePath) ? "valid" : "missing",
    summary: {
      project: config.project,
      standard: config.standard,
      doc_standard: config.doc_standard,
      output_language: config.output_language,
      coverage_target: config.coverage_target,
      coverage_target_percentage: config.coverage_target_percentage,
      phase6_worker_concurrency: config.phase6_worker_concurrency,
      phase6_execution_pass_rate_threshold: config.phase6_execution_pass_rate_threshold,
      phase6_execution_max_optimization_rounds: config.phase6_execution_max_optimization_rounds,
      keyword_dirs: config.keyword_dirs,
      protocol_search_dirs_ignored_by_phase6: config.protocol_search_dirs,
    },
    warnings: existsSync(filePath) ? undefined : ["matrix.jsonc 不存在，已返回默认配置摘要。"],
  })
}

function queryWikiIndex(ctx: QueryContext): Record<string, unknown> {
  const relativePath = ARTIFACT_PATHS.WIKI_INDEX
  const filePath = resolveProjectPath(ctx.projectDir, relativePath)
  if (!["summary", "list_modules", "list_functions"].includes(ctx.view)) {
    return unsupportedView(ctx, ["summary", "list_modules", "list_functions"])
  }
  if (!existsSync(filePath)) {
    return success(ctx, {
      source_file: relativePath,
      schema_status: "missing",
      summary: { exists: false, total_modules: 0, total_functions: 0 },
    })
  }
  const parsed = parseJsonFile(filePath)
  if (parsed.error) {
    return failure(ctx, "invalid_json", "wiki index is not valid JSON", {
      source_file: relativePath,
      schema_status: "invalid",
      details: parsed.error,
    })
  }
  const validated = validateWithSchema(WikiIndex, parsed.data)
  if (validated.error) {
    return failure(ctx, "schema_invalid", "wiki index schema validation failed", {
      source_file: relativePath,
      schema_status: "invalid",
      details: validated.error,
    })
  }
  const wiki = validated.data!
  if (ctx.view === "list_modules") {
    const { items, pagination } = paginate(wiki.modules, ctx.offset, ctx.limit)
    return success(ctx, {
      source_file: relativePath,
      schema_status: "valid",
      summary: { total_modules: wiki.modules.length },
      items,
      pagination,
    })
  }
  const functions = Object.entries(wiki.function_index).map(([function_id, item]) => ({
    function_id,
    ...item,
  }))
  if (ctx.view === "list_functions") {
    const { items, pagination } = paginate(functions, ctx.offset, ctx.limit)
    return success(ctx, {
      source_file: relativePath,
      schema_status: "valid",
      summary: { total_functions: functions.length },
      items,
      pagination,
    })
  }
  return success(ctx, {
    source_file: relativePath,
    schema_status: "valid",
    summary: {
      exists: true,
      overview: wiki.overview,
      total_modules: wiki.modules.length,
      total_functions: functions.length,
      function_index_chunks: wiki.function_index_chunks.length,
      data_structures: wiki.data_structures.length,
      data_flow_paths: wiki.data_flow_paths.length,
      modules: wiki.modules.slice(0, ctx.limit),
    },
  })
}

function queryTestRequirements(ctx: QueryContext): Record<string, unknown> {
  const relativePath = ARTIFACT_PATHS.TEST_REQUIREMENTS
  const filePath = resolveProjectPath(ctx.projectDir, relativePath)
  if (!["summary", "list_requirements", "get_requirement"].includes(ctx.view)) {
    return unsupportedView(ctx, ["summary", "list_requirements", "get_requirement"])
  }
  let prepared
  try {
    const artifact = loadTestRequirementFile(filePath)
    const configResult = validateWithSchema(
      MatrixConfigSchema,
      parseJsoncConfig(resolveProjectPath(ctx.projectDir, ARTIFACT_PATHS.CONFIG)).data ?? {},
    )
    prepared = preparePhase6Input(artifact, {
      project_meta: configResult.data?.project,
      workdir: ctx.projectDir,
    })
  } catch (error) {
    return failure(ctx, existsSync(filePath) ? "schema_invalid" : "file_missing", "test-requirements artifact is not queryable", {
      source_file: relativePath,
      schema_status: existsSync(filePath) ? "invalid" : "missing",
      details: error instanceof Error ? error.message : String(error),
    })
  }

  const compact = prepared.requirements.map((req) =>
    compactRequirement(req, { includeContext: ctx.includeContext }),
  )
  const summary = {
    total_requirements: prepared.requirements.length,
    by_test_type: countBy(prepared.requirements, (item) => item.test_type),
    artifact_meta: prepared.artifact_meta,
    suite_meta: prepared.suite_meta,
  }
  if (ctx.view === "summary") {
    return success(ctx, { source_file: relativePath, schema_status: "valid", summary })
  }
  if (ctx.view === "get_requirement") {
    const item = compact.find((entry) => entry.requirement_id === ctx.requirementId)
    if (!item) {
      return failure(ctx, "not_found", `requirement not found: ${ctx.requirementId ?? ""}`, {
        source_file: relativePath,
        schema_status: "valid",
        summary,
      })
    }
    return success(ctx, { source_file: relativePath, schema_status: "valid", summary, item })
  }
  const { items, pagination } = paginate(compact, ctx.offset, ctx.limit)
  return success(ctx, { source_file: relativePath, schema_status: "valid", summary, items, pagination })
}

function loadGenerationManifest(ctx: QueryContext) {
  const relativePath = ARTIFACT_PATHS.PHASE6_GENERATION_MANIFEST
  const filePath = resolveProjectPath(ctx.projectDir, relativePath)
  const parsed = parseJsonFile(filePath)
  if (parsed.error) {
    return {
      error: failure(ctx, existsSync(filePath) ? "invalid_json" : "file_missing", "phase6 generation manifest is not queryable", {
        source_file: relativePath,
        schema_status: existsSync(filePath) ? "invalid" : "missing",
        details: parsed.error,
      }),
    }
  }
  const validated = validateWithSchema(Phase6GenerationManifest, parsed.data)
  if (validated.error) {
    return {
      error: failure(ctx, "schema_invalid", "phase6 generation manifest schema validation failed", {
        source_file: relativePath,
        schema_status: "invalid",
        details: validated.error,
      }),
    }
  }
  return { relativePath, manifest: validated.data! }
}

function queryGenerationManifest(ctx: QueryContext): Record<string, unknown> {
  const supported = ["summary", "paths", "list_items", "get_item", "warnings"]
  if (!supported.includes(ctx.view)) {
    return unsupportedView(ctx, supported)
  }
  const loaded = loadGenerationManifest(ctx)
  if (loaded.error) return loaded.error
  const { relativePath, manifest } = loaded
  const warnings = manifest.warnings ?? []
  const summary = {
    status: manifest.status,
    template_provenance_version: manifest.template_provenance_version,
    domain: manifest.domain,
    template_source: manifest.template_source,
    template_usage: manifest.template_usage,
    input_format: manifest.input_format,
    test_requirements_file: manifest.test_requirements_file,
    generation_manifest_file: relativePath,
    total_items: manifest.items.length,
    project_type: manifest.project_type,
    suite_meta: manifest.suite_meta,
    artifact_meta: manifest.artifact_meta,
    warnings_count: warnings.length,
    next_queries: {
      paths: { artifact: "phase6_generation_manifest", view: "paths" },
      list_items: { artifact: "phase6_generation_manifest", view: "list_items" },
      get_item: { artifact: "phase6_generation_manifest", view: "get_item", requirement_id: "<requirement_id>" },
      warnings: { artifact: "phase6_generation_manifest", view: "warnings" },
    },
  }
  if (ctx.view === "summary") {
    return success(ctx, { source_file: relativePath, schema_status: "valid", summary })
  }
  if (ctx.view === "paths") {
    const workerPromptFiles = manifest.items
      .map((item) => item.worker_prompt_file)
      .filter((value): value is string => typeof value === "string" && value.length > 0)
    return success(ctx, {
      source_file: relativePath,
      schema_status: "valid",
      summary,
      item: {
        generation_manifest_file: relativePath,
        test_requirements_file: manifest.test_requirements_file,
        worker_prompt_files_count: workerPromptFiles.length,
        worker_prompt_files_preview: workerPromptFiles.slice(0, ctx.limit),
      },
    })
  }
  if (ctx.view === "warnings") {
    const page = paginate(warnings.map((message, index) => ({ index, message })), ctx.offset, ctx.limit)
    return success(ctx, { source_file: relativePath, schema_status: "valid", summary, ...page })
  }
  const items = manifest.items.map((item) =>
    compactGenerationItem(item, {
      includePrompt: ctx.includePrompt,
      includeContext: ctx.includeContext,
    }))
  if (ctx.view === "get_item") {
    const item = items.find((entry) => entry.requirement_id === ctx.requirementId)
    if (!item) {
      return failure(ctx, "not_found", `generation item not found: ${ctx.requirementId ?? ""}`, {
        source_file: relativePath,
        schema_status: "valid",
        summary,
      })
    }
    return success(ctx, { source_file: relativePath, schema_status: "valid", summary, item })
  }
  const page = paginate(items, ctx.offset, ctx.limit)
  return success(ctx, { source_file: relativePath, schema_status: "valid", summary, ...page })
}

function safeRequirementId(value: string): string {
  return value.replace(/[^\w.-]+/g, "_") || "unnamed"
}

function resolveWorkerRunFiles(ctx: QueryContext): {
  runId?: string
  runDir?: string
  latestFile: string
  statusFile?: string
  eventsFile?: string
  resultSummaryFile?: string
  error?: Record<string, unknown>
} {
  const latestFile = resolveProjectPath(ctx.projectDir, ARTIFACT_PATHS.PHASE6_WORKER_RUNS_LATEST)
  if (ctx.runId) {
    const runDir = resolveProjectPath(ctx.projectDir, join(ARTIFACT_PATHS.PHASE6_WORKER_RUNS_DIR, ctx.runId))
    return {
      runId: ctx.runId,
      runDir,
      latestFile,
      statusFile: join(runDir, "status.json"),
      eventsFile: join(runDir, "events.jsonl"),
      resultSummaryFile: join(runDir, "result-summary.json"),
    }
  }
  const parsed = parseJsonFile(latestFile)
  if (parsed.error) {
    return {
      latestFile,
      error: failure(ctx, existsSync(latestFile) ? "invalid_json" : "file_missing", "phase6 latest worker run is not available", {
        source_file: ARTIFACT_PATHS.PHASE6_WORKER_RUNS_LATEST,
        schema_status: existsSync(latestFile) ? "invalid" : "missing",
        details: parsed.error,
      }),
    }
  }
  const validated = validateWithSchema(Phase6RunSnapshot, parsed.data)
  if (validated.error) {
    return {
      latestFile,
      error: failure(ctx, "schema_invalid", "phase6 latest worker run schema validation failed", {
        source_file: ARTIFACT_PATHS.PHASE6_WORKER_RUNS_LATEST,
        schema_status: "invalid",
        details: validated.error,
      }),
    }
  }
  const latest = validated.data!
  const runDir = latest.run_dir
    ? resolveProjectPath(ctx.projectDir, latest.run_dir)
    : resolveProjectPath(ctx.projectDir, join(ARTIFACT_PATHS.PHASE6_WORKER_RUNS_DIR, latest.run_id))
  return {
    runId: latest.run_id,
    runDir,
    latestFile,
    statusFile: latest.status_file ? resolveProjectPath(ctx.projectDir, latest.status_file) : join(runDir, "status.json"),
    eventsFile: latest.events_file ? resolveProjectPath(ctx.projectDir, latest.events_file) : join(runDir, "events.jsonl"),
    resultSummaryFile: latest.result_summary_file
      ? resolveProjectPath(ctx.projectDir, latest.result_summary_file)
      : join(runDir, "result-summary.json"),
  }
}

function loadRunStatus(ctx: QueryContext, statusFile: string) {
  const parsed = parseJsonFile(statusFile)
  if (parsed.error) {
    return {
      error: failure(ctx, existsSync(statusFile) ? "invalid_json" : "file_missing", "phase6 worker status is not queryable", {
        source_file: statusFile,
        schema_status: existsSync(statusFile) ? "invalid" : "missing",
        details: parsed.error,
      }),
    }
  }
  const validated = validateWithSchema(Phase6RunSnapshot, parsed.data)
  if (validated.error) {
    return {
      error: failure(ctx, "schema_invalid", "phase6 worker status schema validation failed", {
        source_file: statusFile,
        schema_status: "invalid",
        details: validated.error,
      }),
    }
  }
  return { status: validated.data! }
}

function loadWorkerResultSummary(ctx: QueryContext, resultSummaryFile: string) {
  const parsed = parseJsonFile(resultSummaryFile)
  if (parsed.error) {
    return {
      error: failure(ctx, existsSync(resultSummaryFile) ? "invalid_json" : "file_missing", "phase6 worker result summary is not queryable", {
        source_file: resultSummaryFile,
        schema_status: existsSync(resultSummaryFile) ? "invalid" : "missing",
        details: parsed.error,
      }),
    }
  }
  const validated = validateWithSchema(Phase6WorkerResultSummary, parsed.data)
  if (validated.error) {
    return {
      error: failure(ctx, "schema_invalid", "phase6 worker result summary schema validation failed", {
        source_file: resultSummaryFile,
        schema_status: "invalid",
        details: validated.error,
      }),
    }
  }
  return { resultSummary: validated.data! }
}

function queryWorkerRun(ctx: QueryContext): Record<string, unknown> {
  const supported = ["summary", "latest", "status", "result_summary", "list_requirements", "events_tail", "failed_requirements", "diagnostic"]
  if (!supported.includes(ctx.view)) return unsupportedView(ctx, supported)
  const files = resolveWorkerRunFiles(ctx)
  if (files.error) return files.error

  if (ctx.view === "latest") {
    const parsed = parseJsonFile(files.latestFile)
    const validated = parsed.data ? validateWithSchema(Phase6RunSnapshot, parsed.data) : { error: parsed.error }
    if (validated.error) {
      return failure(ctx, existsSync(files.latestFile) ? "schema_invalid" : "file_missing", "phase6 latest worker run is not queryable", {
        source_file: ARTIFACT_PATHS.PHASE6_WORKER_RUNS_LATEST,
        schema_status: existsSync(files.latestFile) ? "invalid" : "missing",
        details: validated.error,
      })
    }
    return success(ctx, {
      source_file: ARTIFACT_PATHS.PHASE6_WORKER_RUNS_LATEST,
      schema_status: "valid",
      summary: {
        run_id: validated.data!.run_id,
        total: validated.data!.total,
        succeeded: validated.data!.succeeded,
        failed: validated.data!.failed,
        pending: validated.data!.pending,
        running: validated.data!.running,
        peak_in_flight: validated.data!.peak_in_flight,
      },
      item: validated.data,
    })
  }

  if (!files.statusFile || !files.eventsFile || !files.runDir) {
    return failure(ctx, "run_not_resolved", "phase6 worker run files could not be resolved")
  }
  const statusLoaded = loadRunStatus(ctx, files.statusFile)
  if (statusLoaded.error) return statusLoaded.error
  const status = statusLoaded.status!
  const summary = {
    run_id: status.run_id,
    total: status.total,
    pending: status.pending,
    running: status.running,
    succeeded: status.succeeded,
    failed: status.failed,
    peak_in_flight: status.peak_in_flight,
    failed_requirement_count: status.failed_requirement_ids?.length ?? 0,
    result_summary_file: files.resultSummaryFile,
    next_queries: {
      result_summary: { artifact: "phase6_worker_run", view: "result_summary", run_id: status.run_id },
      list_requirements: { artifact: "phase6_worker_run", view: "list_requirements", run_id: status.run_id },
      failed_requirements: { artifact: "phase6_worker_run", view: "failed_requirements", run_id: status.run_id },
      events_tail: { artifact: "phase6_worker_run", view: "events_tail", run_id: status.run_id },
      diagnostic: { artifact: "phase6_worker_run", view: "diagnostic", run_id: status.run_id, requirement_id: "<requirement_id>" },
    },
  }
  if (ctx.view === "summary") {
    let resultSummary: z.infer<typeof Phase6WorkerResultSummary> | undefined
    if (files.resultSummaryFile && existsSync(files.resultSummaryFile)) {
      const resultLoaded = loadWorkerResultSummary(ctx, files.resultSummaryFile)
      if (resultLoaded.error) return resultLoaded.error
      resultSummary = resultLoaded.resultSummary
    }
    return success(ctx, {
      source_file: files.statusFile,
      schema_status: "valid",
      summary: {
        ...summary,
        final_status: resultSummary?.status,
        persisted_case_count: resultSummary?.persisted_case_count,
        persisted_requirement_count: resultSummary?.persisted_requirement_count,
        translation_status: resultSummary?.translation_status,
        translation_summary: resultSummary?.translation_summary,
        translation_failed_locations: resultSummary?.translation_failed_locations?.slice(0, ctx.limit),
        suite_file: resultSummary?.suite_file,
        source_suite_file: resultSummary?.source_suite_file,
        translated_suite_file: resultSummary?.translated_suite_file,
      },
    })
  }
  if (ctx.view === "status") {
    return success(ctx, { source_file: files.statusFile, schema_status: "valid", summary, item: status })
  }
  if (ctx.view === "result_summary") {
    if (!files.resultSummaryFile) {
      return failure(ctx, "result_summary_not_resolved", "phase6 worker result summary file could not be resolved", {
        source_file: files.runDir,
        schema_status: "missing",
      })
    }
    const resultLoaded = loadWorkerResultSummary(ctx, files.resultSummaryFile)
    if (resultLoaded.error) return resultLoaded.error
    const { requirements: _requirements, ...compactSummary } = resultLoaded.resultSummary!
    return success(ctx, {
      source_file: files.resultSummaryFile,
      schema_status: "valid",
      summary: {
        run_id: compactSummary.run_id,
        status: compactSummary.status,
        total: compactSummary.total,
        succeeded: compactSummary.succeeded,
        failed: compactSummary.failed,
        persisted_case_count: compactSummary.persisted_case_count,
        persisted_requirement_count: compactSummary.persisted_requirement_count,
        translation_status: compactSummary.translation_status,
      },
      item: {
        ...compactSummary,
        requirements_count: resultLoaded.resultSummary!.requirements.length,
      },
    })
  }
  if (ctx.view === "list_requirements") {
    if (!files.resultSummaryFile) {
      return failure(ctx, "result_summary_not_resolved", "phase6 worker result summary file could not be resolved", {
        source_file: files.runDir,
        schema_status: "missing",
      })
    }
    const resultLoaded = loadWorkerResultSummary(ctx, files.resultSummaryFile)
    if (resultLoaded.error) return resultLoaded.error
    const page = paginate(resultLoaded.resultSummary!.requirements, ctx.offset, ctx.limit)
    return success(ctx, { source_file: files.resultSummaryFile, schema_status: "valid", summary, ...page })
  }
  if (ctx.view === "failed_requirements") {
    let fromSummary: z.infer<typeof Phase6WorkerResultSummary>["requirements"] | null = null
    if (files.resultSummaryFile && existsSync(files.resultSummaryFile)) {
      const resultLoaded = loadWorkerResultSummary(ctx, files.resultSummaryFile)
      if (resultLoaded.error) return resultLoaded.error
      fromSummary = resultLoaded.resultSummary!.requirements.filter((item) => item.status === "error")
    }
    const ids = status.failed_requirement_ids ?? []
    const items = fromSummary ?? ids.map((id) => ({
      requirement_id: id,
      status: "error",
      diagnostic_file: join(files.runDir!, `${safeRequirementId(id)}.json`),
    }))
    const page = paginate(items, ctx.offset, ctx.limit)
    return success(ctx, { source_file: files.statusFile, schema_status: "valid", summary, ...page })
  }
  if (ctx.view === "diagnostic") {
    if (!ctx.requirementId) {
      return failure(ctx, "missing_requirement_id", "requirement_id is required for diagnostic view", {
        source_file: files.runDir,
        schema_status: "not_applicable",
      })
    }
    const diagnosticFile = join(files.runDir, `${safeRequirementId(ctx.requirementId)}.json`)
    const parsed = parseJsonFile(diagnosticFile)
    if (parsed.error) {
      return failure(ctx, existsSync(diagnosticFile) ? "invalid_json" : "file_missing", "worker diagnostic is not queryable", {
        source_file: diagnosticFile,
        schema_status: existsSync(diagnosticFile) ? "invalid" : "missing",
        details: parsed.error,
      })
    }
    const validated = validateWithSchema(Phase6WorkerDiagnostic, parsed.data)
    if (validated.error) {
      return failure(ctx, "schema_invalid", "worker diagnostic schema validation failed", {
        source_file: diagnosticFile,
        schema_status: "invalid",
        details: validated.error,
      })
    }
    return success(ctx, { source_file: diagnosticFile, schema_status: "valid", summary, item: validated.data })
  }

  if (!existsSync(files.eventsFile)) {
    return failure(ctx, "file_missing", "phase6 worker events file is missing", {
      source_file: files.eventsFile,
      schema_status: "missing",
    })
  }
  const lines = readFileSync(files.eventsFile, "utf-8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
  const parsedEvents = lines.map((line, index) => {
    try {
      const parsed = JSON.parse(line)
      const validated = Phase6RunEvent.safeParse(parsed)
      return validated.success
        ? validated.data
        : { event: "invalid_event", line: index + 1, validation_error: validated.error.issues[0]?.message }
    } catch (error) {
      return { event: "invalid_json_line", line: index + 1, parse_error: error instanceof Error ? error.message : String(error) }
    }
  })
  const tail = parsedEvents.slice(Math.max(0, parsedEvents.length - ctx.limit))
  return success(ctx, {
    source_file: files.eventsFile,
    schema_status: "valid",
    summary: { ...summary, total_events: parsedEvents.length },
    items: tail,
    pagination: {
      offset: Math.max(0, parsedEvents.length - tail.length),
      limit: ctx.limit,
      total: parsedEvents.length,
      returned: tail.length,
      has_more: parsedEvents.length > tail.length,
    },
  })
}

function querySuite(ctx: QueryContext, translated: boolean): Record<string, unknown> {
  const relativePath = translated ? ARTIFACT_PATHS.CONFIRMATION_TESTS : ARTIFACT_PATHS.CONFIRMATION_TESTS
  const compactCase = translated ? compactTranslatedCase : compactSourceCase
  const supported = ["summary", "list_cases", "get_case"]
  if (!supported.includes(ctx.view)) return unsupportedView(ctx, supported)
  const filePath = resolveProjectPath(ctx.projectDir, relativePath)
  const parsed = parseJsonFile(filePath)
  if (parsed.error) {
    return failure(ctx, existsSync(filePath) ? "invalid_json" : "file_missing", "confirmation suite is not queryable", {
      source_file: relativePath,
      schema_status: existsSync(filePath) ? "invalid" : "missing",
      details: parsed.error,
    })
  }
  let suite: { test_cases: Array<Record<string, any>>; summary?: unknown; traceability?: unknown }
  let schemaStatus = "valid"
  let schemaDetails: string | undefined
  if (translated) {
    // Translated 严格 schema 要求 key_name 非空，但修复循环中部分步骤未翻译
    // （key_name 为空）是常态。严格校验失败时降级用 Source schema 继续提供
    // 查询并标注 invalid + 原因，避免整个结构化查询通道（summary/list_cases/
    // get_case）因单处未翻译而整体失效，把智能体逼回裸读文件。
    const strict = validateWithSchema(TranslatedConfirmationTestSuite, parsed.data)
    if (strict.error) {
      const tolerant = validateWithSchema(SourceConfirmationTestSuite, parsed.data)
      if (tolerant.error) {
        return failure(ctx, "schema_invalid", "confirmation suite schema validation failed", {
          source_file: relativePath,
          schema_status: "invalid",
          details: `${strict.error}; source-schema: ${tolerant.error}`,
        })
      }
      suite = tolerant.data as any
      schemaStatus = "invalid"
      schemaDetails = strict.error
    } else {
      suite = strict.data as any
    }
  } else {
    const validated = validateWithSchema(SourceConfirmationTestSuite, parsed.data)
    if (validated.error) {
      return failure(ctx, "schema_invalid", "confirmation suite schema validation failed", {
        source_file: relativePath,
        schema_status: "invalid",
        details: validated.error,
      })
    }
    suite = validated.data as any
  }
  const statusPayload = {
    source_file: relativePath,
    schema_status: schemaStatus,
    ...(schemaDetails ? { details: schemaDetails } : {}),
  }
  const summary = summarizeSuite(suite)
  if (ctx.view === "summary") {
    return success(ctx, { ...statusPayload, summary })
  }
  const cases = suite.test_cases.map((testCase: Record<string, any>) => compactCase(testCase, ctx.includeSteps))
  if (ctx.view === "get_case") {
    const item = cases.find((testCase: Record<string, unknown>) => testCase.case_id === ctx.caseId)
    if (!item) {
      return failure(ctx, "not_found", `case not found: ${ctx.caseId ?? ""}`, {
        ...statusPayload,
        summary,
      })
    }
    return success(ctx, { ...statusPayload, summary, item })
  }
  const page = paginate(cases, ctx.offset, ctx.limit)
  return success(ctx, { ...statusPayload, summary, ...page })
}

function queryCaseReviewPrepared(ctx: QueryContext): Record<string, unknown> {
  const relativePath = ARTIFACT_PATHS.CASE_REVIEW_PREPARED
  const supported = [
    "summary",
    "candidate_issues",
    "unresolved_placeholders",
    "field_issues",
    "semantic_validation_failures",
    "template_baselines",
    "coverage",
    "broken_links",
    "path_mismatches",
    "related_requirement_mismatches",
    "warnings",
    "errors",
  ]
  if (!supported.includes(ctx.view)) return unsupportedView(ctx, supported)
  const filePath = resolveProjectPath(ctx.projectDir, relativePath)
  const parsed = parseJsonFile(filePath)
  if (parsed.error) {
    return failure(ctx, existsSync(filePath) ? "invalid_json" : "file_missing", "phase6 case review prepared artifact is not queryable", {
      source_file: relativePath,
      schema_status: existsSync(filePath) ? "invalid" : "missing",
      details: parsed.error,
    })
  }
  const validated = validateWithSchema(Phase6CaseReviewPrepared, parsed.data)
  if (validated.error) {
    return failure(ctx, "schema_invalid", "phase6 case review prepared schema validation failed", {
      source_file: relativePath,
      schema_status: "invalid",
      details: validated.error,
    })
  }
  const prepared = validated.data!
  const summary = {
    status: prepared.status,
    generated_at: prepared.generated_at,
    confirmation_tests_file: prepared.confirmation_tests_file,
    test_requirements_file: prepared.test_requirements_file,
    project_type: prepared.project_type,
    summary: prepared.summary,
    warnings_count: prepared.warnings.length,
    errors_count: prepared.errors.length,
    candidate_issues: prepared.candidate_issues.length,
  }
  if (ctx.view === "summary") {
    return success(ctx, { source_file: relativePath, schema_status: "valid", summary })
  }
  const viewMap: Record<string, unknown[]> = {
    candidate_issues: prepared.candidate_issues,
    unresolved_placeholders: prepared.unresolved_placeholders,
    field_issues: prepared.field_issues,
    semantic_validation_failures: prepared.semantic_validation_failures,
    template_baselines: prepared.template_baselines,
    coverage: prepared.coverage ? [prepared.coverage] : [],
    broken_links: prepared.broken_links,
    path_mismatches: prepared.path_mismatches,
    related_requirement_mismatches: prepared.related_requirement_mismatches,
    warnings: prepared.warnings.map((message) => ({ message })),
    errors: prepared.errors.map((message) => ({ message })),
  }
  const page = paginate(viewMap[ctx.view] ?? [], ctx.offset, ctx.limit)
  return success(ctx, { source_file: relativePath, schema_status: "valid", summary, ...page })
}

function queryExecutionLoop(ctx: QueryContext): Record<string, unknown> {
  const relativePath = ARTIFACT_PATHS.PHASE6_EXECUTION_LOOP
  const supported = ["summary", "list_rounds", "get_round"]
  if (!supported.includes(ctx.view)) return unsupportedView(ctx, supported)
  const filePath = resolveProjectPath(ctx.projectDir, relativePath)
  const parsed = parseJsonFile(filePath)
  if (parsed.error) {
    return failure(ctx, existsSync(filePath) ? "invalid_json" : "file_missing", "phase6 execution loop artifact is not queryable", {
      source_file: relativePath,
      schema_status: existsSync(filePath) ? "invalid" : "missing",
      details: parsed.error,
    })
  }
  const validated = validateWithSchema(Phase6ExecutionLoopArtifact, parsed.data)
  if (validated.error) {
    return failure(ctx, "schema_invalid", "phase6 execution loop schema validation failed", {
      source_file: relativePath,
      schema_status: "invalid",
      details: validated.error,
    })
  }
  const artifact = validated.data!
  const summary = {
    gate_status: artifact.gate_status,
    pass_rate_threshold: artifact.pass_rate_threshold,
    coverage_target: artifact.coverage_target,
    coverage_threshold: artifact.coverage_threshold,
    max_optimization_rounds: artifact.max_optimization_rounds,
    rounds: artifact.rounds.length,
    final: artifact.final,
  }
  if (ctx.view === "summary") {
    return success(ctx, { source_file: relativePath, schema_status: "valid", summary })
  }
  if (ctx.view === "get_round") {
    const roundIndex = ctx.requirementId ? Number(ctx.requirementId) : Number.NaN
    const item = artifact.rounds.find((round) => round.round_index === roundIndex)
    if (!item) {
      return failure(ctx, "not_found", `execution round not found: ${ctx.requirementId ?? ""}`, {
        source_file: relativePath,
        schema_status: "valid",
        summary,
      })
    }
    return success(ctx, { source_file: relativePath, schema_status: "valid", summary, item })
  }
  const items = artifact.rounds.map((round) => ({
    round_index: round.round_index,
    kind: round.kind,
    dtp_success: round.dtp_success,
    pass_rate: round.pass_rate,
    pass_rate_met: round.pass_rate_met,
    coverage_target: round.coverage_target,
    coverage_value: round.coverage_value,
    coverage_met: round.coverage_met,
    failed_cases: round.failed_cases,
    optimization_applied: round.optimization_applied,
    optimization_case_ids: round.optimization_case_ids,
    errors: round.errors,
    warnings: round.warnings,
  }))
  const page = paginate(items, ctx.offset, ctx.limit)
  return success(ctx, { source_file: relativePath, schema_status: "valid", summary, ...page })
}

function queryTodo(ctx: QueryContext): Record<string, unknown> {
  const relativePath = ARTIFACT_PATHS.PHASE6_TEST_CASES_TODO
  const supported = ["summary", "list_case_ids"]
  if (!supported.includes(ctx.view)) return unsupportedView(ctx, supported)
  const filePath = resolveProjectPath(ctx.projectDir, relativePath)
  if (!existsSync(filePath)) {
    return failure(ctx, "file_missing", "phase6 todo file is missing", {
      source_file: relativePath,
      schema_status: "missing",
    })
  }
  const caseIds = readFileSync(filePath, "utf-8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const summary = { total_case_ids: caseIds.length }
  if (ctx.view === "summary") {
    return success(ctx, { source_file: relativePath, schema_status: "valid", summary })
  }
  const page = paginate(caseIds.map((case_id) => ({ case_id })), ctx.offset, ctx.limit)
  return success(ctx, { source_file: relativePath, schema_status: "valid", summary, ...page })
}

function queryPhase6WorkerOutputs(ctx: QueryContext): Record<string, unknown> {
  const supported = ["summary", "list_files"]
  if (!supported.includes(ctx.view)) return unsupportedView(ctx, supported)
  const dataDir = resolveProjectPath(ctx.projectDir, DATA_DIR)
  let entries: string[]
  try {
    entries = readdirSync(dataDir)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code === "ENOENT" ? "dir_missing" : "read_error"
    return failure(ctx, code, `phase6 worker outputs directory is not readable: ${dataDir}`, {
      source_file: DATA_DIR,
      schema_status: code === "dir_missing" ? "missing" : "invalid",
    })
  }
  const files = entries
    .filter((name) => name.endsWith("_output.json"))
    .sort()
    .map((name) => {
      const filePath = join(dataDir, name)
      const parsed = parseJsonFile(filePath)
      let sizeBytes: number | undefined
      try {
        sizeBytes = statSync(filePath).size
      } catch {
        // file vanished between readdir and stat; json_status covers it
      }
      return {
        requirement_id: name.slice(0, -"_output.json".length),
        file: `${DATA_DIR}/${name}`,
        size_bytes: sizeBytes,
        json_status:
          parsed.data !== undefined
            ? "valid"
            : parsed.error?.startsWith("invalid_json")
              ? "invalid_json"
              : "unreadable",
      }
    })

  const manifestFile = resolveProjectPath(ctx.projectDir, ARTIFACT_PATHS.PHASE6_GENERATION_MANIFEST)
  const manifestParsed = parseJsonFile(manifestFile)
  let manifestStatus = "missing"
  let expectedIds: string[] = []
  if (manifestParsed.data !== undefined) {
    const validated = validateWithSchema(Phase6GenerationManifest, manifestParsed.data)
    if (validated.error) {
      manifestStatus = "invalid"
    } else {
      manifestStatus = "valid"
      expectedIds = validated.data!.items
        .map((item) => item.requirement_id)
        .filter((value): value is string => typeof value === "string" && value.length > 0)
    }
  }
  const landedIds = files.map((file) => file.requirement_id)
  const matchedExpectedIds = new Set(
    expectedIds.filter((id) => landedIds.includes(id) || landedIds.includes(safeRequirementId(id))),
  )
  const reconciliation =
    manifestStatus === "valid"
      ? {
          landed_requirement_ids: [...matchedExpectedIds],
          missing_requirement_ids: expectedIds.filter((id) => !matchedExpectedIds.has(id)),
          extra_requirement_ids: landedIds.filter(
            (id) => !expectedIds.some((expected) => expected === id || safeRequirementId(expected) === id),
          ),
        }
      : {}

  const summary = {
    data_dir: DATA_DIR,
    manifest_file: ARTIFACT_PATHS.PHASE6_GENERATION_MANIFEST,
    manifest_status: manifestStatus,
    total_files: files.length,
    valid_count: files.filter((file) => file.json_status === "valid").length,
    invalid_count: files.length - files.filter((file) => file.json_status === "valid").length,
    next_queries: {
      list_files: { artifact: "phase6_worker_outputs", view: "list_files" },
    },
  }
  if (ctx.view === "summary") {
    return success(ctx, { source_file: DATA_DIR, schema_status: "valid", summary, ...reconciliation })
  }
  const page = paginate(files, ctx.offset, ctx.limit)
  return success(ctx, { source_file: DATA_DIR, schema_status: "valid", summary, ...reconciliation, ...page })
}

function normalizeArtifactName(artifact: string): ArtifactName | null {
  return SUPPORTED_ARTIFACTS.includes(artifact as ArtifactName) ? artifact as ArtifactName : null
}

function executeQuery(ctx: QueryContext): Record<string, unknown> {
  const artifact = normalizeArtifactName(ctx.artifact)
  if (!artifact) {
    return failure(ctx, "unsupported_artifact", `unsupported artifact: ${ctx.artifact}`, {
      supported_artifacts: [...SUPPORTED_ARTIFACTS],
    })
  }
  switch (artifact) {
    case "matrix_config":
      return queryMatrixConfig(ctx)
    case "wiki_index":
      return queryWikiIndex(ctx)
    case "test_requirements":
      return queryTestRequirements(ctx)
    case "phase6_generation_manifest":
      return queryGenerationManifest(ctx)
    case "phase6_worker_run":
      return queryWorkerRun(ctx)
    case "phase6_worker_outputs":
      return queryPhase6WorkerOutputs(ctx)
    case "source_confirmation_suite":
      return querySuite(ctx, false)
    case "translated_confirmation_suite":
      return querySuite(ctx, true)
    case "phase6_case_review_prepared":
      return queryCaseReviewPrepared(ctx)
    case "phase6_execution_loop":
      return queryExecutionLoop(ctx)
    case "phase6_todo":
      return queryTodo(ctx)
  }
}

export const matrixArtifactQuery: ToolDefinition = tool({
  description:
    "Query predefined Matrix JSON/JSONL/TXT artifacts through schema-aware compact views. " +
    "Use this instead of read/repo_read for Phase 6 structured artifacts such as test-requirements, " +
    "confirmation suites, worker runs, landed worker output files, review-prepared data, execution loop, and todo files. " +
    "It does not accept arbitrary file paths.",
  args: {
    artifact: tool.schema
      .string()
      .describe("Artifact name, e.g. test_requirements, phase6_worker_run, source_confirmation_suite."),
    view: tool.schema
      .string()
      .optional()
      .describe("Query view. Defaults to summary. Examples: summary, list_requirements, get_requirement, list_cases, get_case, list_files."),
    requirement_id: tool.schema
      .string()
      .optional()
      .describe("Requirement id for requirement/item/diagnostic lookups."),
    case_id: tool.schema
      .string()
      .optional()
      .describe("Case id for confirmation-suite or translation-failure lookups."),
    run_id: tool.schema
      .string()
      .optional()
      .describe("Optional Phase 6 worker run id. If omitted, latest-run.json is used."),
    offset: tool.schema
      .number()
      .optional()
      .describe("Zero-based list offset. Defaults to 0."),
    limit: tool.schema
      .number()
      .optional()
      .describe(`Maximum list items to return. Defaults to ${DEFAULT_LIMIT}, capped at ${MAX_LIMIT}.`),
    include_steps: tool.schema
      .boolean()
      .optional()
      .describe("Include test steps in case detail/list responses. Defaults to false."),
    include_prompt: tool.schema
      .boolean()
      .optional()
      .describe("Include generation prompt text for phase6_generation_manifest views. Defaults to false."),
    include_context: tool.schema
      .boolean()
      .optional()
      .describe("Include long context payloads: for test_requirements views the handling/inputFlow/outputFlow fields, for phase6_generation_manifest views the parsed normalization context. Defaults to false."),
  },
  async execute(args: QueryArgs, toolContext) {
    const { offset, limit } = normalizePaging(args.offset, args.limit)
    const ctx: QueryContext = {
      projectDir: getToolBaseDirectory(toolContext),
      artifact: String(args.artifact ?? "").trim(),
      view: String(args.view ?? "summary").trim() || "summary",
      offset,
      limit,
      requirementId: args.requirement_id,
      caseId: args.case_id,
      runId: args.run_id,
      includeSteps: Boolean(args.include_steps),
      includePrompt: Boolean(args.include_prompt),
      includeContext: Boolean(args.include_context),
    }
    const result = executeQuery(ctx)
    return JSON.stringify(result)
  },
})
