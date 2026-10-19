import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, isAbsolute, join, parse, resolve } from "path"
import { z } from "zod"
import {
  SoftwareAnalysisStage03FunctionChunk,
  SoftwareAnalysisStageArtifact,
} from "../schema/software-analysis-stage"
import { SoftwareAnalysisReport, type FunctionInfo } from "../schema/sut"
import {
  DataStructuresFile,
  FunctionWiki,
  WikiExecutionCompleteStep,
  WikiExecutionDataStructuresStep,
  WikiExecutionFunctionStep,
  WikiExecutionGlobalSynthesisStep,
  WikiExecutionModuleStep,
  WikiExecutionNextStep,
  WikiExecutionStepArtifact,
  WikiExecutionStepPointer,
  WikiExecutionState,
  WikiGenerationPlan,
  WikiIndex,
} from "../schema/wiki"
import { ARTIFACT_PATHS } from "../shared/constants"
import { withFileLock } from "../shared/file-mutex"

type AnalysisFunction = {
  id: string
  name: string
  file_path: string
  line_range: {
    start: number
    end: number
  }
}

type AnalysisModule = {
  name: string
  path?: string
  functions: string[]
}

type AnalysisLedger = {
  functions: AnalysisFunction[]
  modules: AnalysisModule[]
}

type NextStep = z.infer<typeof WikiExecutionNextStep>

const WikiExecutionPlannerMode = z.enum(["next_step"])

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

function hasReusableFunctionWiki(relativePath: string): boolean {
  const absolutePath = resolveProjectPath(relativePath)
  if (!existsSync(absolutePath)) return false
  try {
    return FunctionWiki.safeParse(readJsonFile(absolutePath)).success
  } catch {
    return false
  }
}

function toAnalysisFunction(item: Pick<FunctionInfo, "id" | "name" | "file_path" | "line_range">): AnalysisFunction {
  return {
    id: item.id,
    name: item.name,
    file_path: item.file_path,
    line_range: item.line_range,
  }
}

function synthesizeModules(functions: AnalysisFunction[]): AnalysisModule[] {
  const modules = new Map<string, AnalysisModule>()

  for (const fn of functions) {
    const moduleName = parse(fn.file_path.replace(/\\/g, "/")).name
    if (!moduleName) continue
    const existing = modules.get(moduleName)
    if (existing) {
      existing.functions.push(fn.id)
      if (!existing.path) existing.path = fn.file_path
    } else {
      modules.set(moduleName, {
        name: moduleName,
        path: fn.file_path,
        functions: [fn.id],
      })
    }
  }

  return [...modules.values()].sort((left, right) => left.name.localeCompare(right.name))
}

function loadStage03Functions(stage03Path: string): AnalysisFunction[] {
  const parsed = SoftwareAnalysisStageArtifact.safeParse(readJsonFile(stage03Path))
  if (!parsed.success || parsed.data.stage_id !== "03-code") {
    throw new Error(`Invalid stage-03 artifact at ${stage03Path}`)
  }

  const payload = parsed.data.payload
  const indexedFunctions = payload.function_index.map((entry) => ({
    id: entry.id,
    name: entry.name,
    file_path: entry.file_path,
    line_range: entry.line_range,
  }))
  if (indexedFunctions.length > 0) return indexedFunctions

  const inlineFunctions = payload.functions.map(toAnalysisFunction)
  if (inlineFunctions.length > 0) return inlineFunctions

  const chunkFunctions: AnalysisFunction[] = []
  for (const chunkRef of payload.function_chunks) {
    const chunkPath = resolveProjectPath(chunkRef.file_path)
    if (!existsSync(chunkPath)) continue
    const parsedChunk = SoftwareAnalysisStage03FunctionChunk.safeParse(readJsonFile(chunkPath))
    if (!parsedChunk.success) {
      throw new Error(`Invalid stage-03 function chunk at ${chunkPath}: ${parsedChunk.error.message}`)
    }
    chunkFunctions.push(...parsedChunk.data.functions.map(toAnalysisFunction))
  }
  return chunkFunctions
}

function loadAnalysisLedger(): AnalysisLedger {
  const analysisPath = resolveProjectPath(ARTIFACT_PATHS.SOFTWARE_ANALYSIS)
  if (existsSync(analysisPath)) {
    const parsed = SoftwareAnalysisReport.safeParse(readJsonFile(analysisPath))
    if (parsed.success && parsed.data.functions.length > 0) {
      const functions = parsed.data.functions.map(toAnalysisFunction)
      const modules = parsed.data.modules.length > 0
        ? parsed.data.modules.map((module) => ({
            name: module.name,
            path: module.path,
            functions: [...module.functions],
          }))
        : synthesizeModules(functions)
      return { functions, modules }
    }
  }

  const stage03Path = resolveProjectPath(ARTIFACT_PATHS.SOFTWARE_ANALYSIS_STAGE_03_CODE)
  if (!existsSync(stage03Path)) {
    return { functions: [], modules: [] }
  }

  const parsed = SoftwareAnalysisStageArtifact.safeParse(readJsonFile(stage03Path))
  if (!parsed.success || parsed.data.stage_id !== "03-code") {
    return { functions: [], modules: [] }
  }

  const functions = loadStage03Functions(stage03Path)
  const modules = parsed.data.payload.modules.length > 0
    ? parsed.data.payload.modules.map((module) => ({
        name: module.name,
        path: module.path,
        functions: [...module.functions],
      }))
    : synthesizeModules(functions)

  return { functions, modules }
}

function getModuleWikiPath(moduleName: string): string {
  return `.matrix/wiki/modules/${moduleName}.json`
}

function getFunctionNameFromWikiPath(pathValue: string): string {
  return parse(pathValue.replace(/\\/g, "/")).name
}

function normalizeRelativePath(pathValue: string): string {
  return pathValue.replace(/\\/g, "/")
}

function uniquePreservingOrder(values: string[]): string[] {
  const seen = new Set<string>()
  const unique: string[] = []

  for (const value of values) {
    if (seen.has(value)) continue
    seen.add(value)
    unique.push(value)
  }

  return unique
}

function countCompletedFunctions(plan: z.infer<typeof WikiGenerationPlan>): {
  completedFunctionIds: Set<string>
  reusedFunctionIds: Set<string>
} {
  const completedFunctionIds = new Set<string>()
  const reusedFunctionIds = new Set<string>()

  for (const [functionId, wikiPath] of Object.entries(plan.per_function_wiki_paths)) {
    if (!hasReusableFunctionWiki(wikiPath)) continue
    completedFunctionIds.add(functionId)
    if (plan.reusable_function_wiki_paths[functionId]) {
      reusedFunctionIds.add(functionId)
    }
  }

  return { completedFunctionIds, reusedFunctionIds }
}

function countCompletedModules(plan: z.infer<typeof WikiGenerationPlan>): Set<string> {
  const completedModules = new Set<string>()
  for (const moduleName of plan.module_order) {
    if (existsSync(resolveProjectPath(getModuleWikiPath(moduleName)))) {
      completedModules.add(moduleName)
    }
  }
  return completedModules
}

function hasValidDataStructuresArtifact(): boolean {
  const dataStructuresPath = resolveProjectPath(ARTIFACT_PATHS.WIKI_DATA_STRUCTURES)
  if (!existsSync(dataStructuresPath)) return false

  try {
    const parsed = DataStructuresFile.safeParse(readJsonFile(dataStructuresPath))
    return parsed.success
  } catch {
    return false
  }
}

function isIndexAligned(plan: z.infer<typeof WikiGenerationPlan>): boolean {
  const indexPath = resolveProjectPath(ARTIFACT_PATHS.WIKI_INDEX)
  if (!existsSync(indexPath)) return false

  const parsed = WikiIndex.safeParse(readJsonFile(indexPath))
  if (!parsed.success) return false

  const expectedModuleNames = new Set(plan.module_order)
  for (const moduleName of expectedModuleNames) {
    if (!parsed.data.modules.some((entry) => entry.name === moduleName)) {
      return false
    }
  }

  const expectedFunctionNames = new Set(
    uniquePreservingOrder(Object.values(plan.per_function_wiki_paths).map(getFunctionNameFromWikiPath)),
  )
  const indexedNames = new Set(Object.keys(parsed.data.function_index))
  for (const functionName of expectedFunctionNames) {
    if (!indexedNames.has(functionName)) {
      return false
    }
  }

  return true
}

function resolveModuleSourcePaths(
  moduleName: string,
  plan: z.infer<typeof WikiGenerationPlan>,
  ledger: AnalysisLedger,
): string[] {
  const sources: string[] = []
  const moduleMeta = ledger.modules.find((module) => module.name === moduleName)
  if (moduleMeta?.path) {
    sources.push(normalizeRelativePath(moduleMeta.path))
  }

  for (const functionId of plan.per_module_function_order[moduleName] ?? []) {
    const location = plan.per_function_source_locations[functionId]
    if (location?.file_path) {
      sources.push(normalizeRelativePath(location.file_path))
    }
  }

  return uniquePreservingOrder(sources)
}

function buildFunctionStep(
  plan: z.infer<typeof WikiGenerationPlan>,
  moduleName: string,
  functionId: string,
  moduleOrderIndex: number,
  functionOrderIndex: number,
): z.infer<typeof WikiExecutionFunctionStep> {
  const location = plan.per_function_source_locations[functionId]
  if (!location) {
    throw new Error(`wiki-generation-plan.json is missing source location for ${functionId}`)
  }
  const functionInterface = plan.per_function_interfaces[functionId]

  return WikiExecutionFunctionStep.parse({
    kind: "function-analysis",
    module_name: moduleName,
    module_order_index: moduleOrderIndex + 1,
    module_order_total: plan.module_order.length,
    function_id: functionId,
    function_name: plan.per_function_names[functionId] ?? functionId,
    function_wiki_path: plan.per_function_wiki_paths[functionId],
    function_file_path: location.file_path,
    function_line_range: location.line_range,
    function_return_type: functionInterface?.return_type ?? "unknown",
    function_parameters: functionInterface?.parameters ?? [],
    function_order_index: functionOrderIndex + 1,
    function_order_total: (plan.per_module_function_order[moduleName] ?? []).length,
    direct_callees: (plan.per_function_direct_callees[functionId] ?? []).map(
      (calleeId) => plan.per_function_names[calleeId] ?? calleeId,
    ),
    required_callee_wiki_paths: [...(plan.per_function_dependency_wiki_paths[functionId] ?? [])],
    reused: false,
  })
}

function buildModuleStep(
  plan: z.infer<typeof WikiGenerationPlan>,
  ledger: AnalysisLedger,
  moduleName: string,
  moduleOrderIndex: number,
): z.infer<typeof WikiExecutionModuleStep> {
  const functionIds = plan.per_module_function_order[moduleName] ?? []
  return WikiExecutionModuleStep.parse({
    kind: "module-analysis",
    module_name: moduleName,
    module_order_index: moduleOrderIndex + 1,
    module_order_total: plan.module_order.length,
    module_source_paths: resolveModuleSourcePaths(moduleName, plan, ledger),
    module_dependencies: [...(plan.dependency_requirements[moduleName]?.module_dependencies ?? [])],
    function_order: functionIds.map((functionId) => plan.per_function_names[functionId] ?? functionId),
    module_function_wiki_paths: uniquePreservingOrder(
      functionIds
        .map((functionId) => plan.per_function_wiki_paths[functionId])
        .filter((pathValue): pathValue is string => typeof pathValue === "string"),
    ),
    reused: false,
  })
}

function buildGlobalStep(plan: z.infer<typeof WikiGenerationPlan>): z.infer<typeof WikiExecutionGlobalSynthesisStep> {
  return WikiExecutionGlobalSynthesisStep.parse({
    kind: "global-synthesis",
    index_path: ARTIFACT_PATHS.WIKI_INDEX,
    module_wiki_paths: plan.module_order.map(getModuleWikiPath),
    function_wiki_paths: uniquePreservingOrder(Object.values(plan.per_function_wiki_paths)),
    reused: false,
  })
}

function buildCompleteStep(): z.infer<typeof WikiExecutionCompleteStep> {
  return WikiExecutionCompleteStep.parse({ kind: "complete" })
}

function buildStepPointer(step: NextStep, stepFile: string) {
  switch (step.kind) {
    case "data-structures":
      return WikiExecutionStepPointer.parse({
        kind: step.kind,
        wiki_path: step.wiki_path,
        step_file: stepFile,
      })
    case "function-analysis":
      return WikiExecutionStepPointer.parse({
        kind: step.kind,
        step_file: stepFile,
        module_name: step.module_name,
        function_id: step.function_id,
        function_name: step.function_name,
        function_wiki_path: step.function_wiki_path,
      })
    case "module-analysis":
      return WikiExecutionStepPointer.parse({
        kind: step.kind,
        step_file: stepFile,
        module_name: step.module_name,
      })
    case "global-synthesis":
      return WikiExecutionStepPointer.parse({
        kind: step.kind,
        step_file: stepFile,
        index_path: step.index_path,
      })
    case "complete":
      return WikiExecutionStepPointer.parse({
        kind: step.kind,
      })
  }
}

function writeStepArtifact(stepPath: string, step: NextStep) {
  const artifact = WikiExecutionStepArtifact.parse({
    artifact_type: "wiki-execution-step",
    updated_at: new Date().toISOString(),
    step,
  })
  ensureDir(stepPath)
  writeFileSync(stepPath, JSON.stringify(artifact, null, 2), "utf-8")
}

function determineNextStep(
  plan: z.infer<typeof WikiGenerationPlan>,
  ledger: AnalysisLedger,
): NextStep {
  if (!hasValidDataStructuresArtifact()) {
    return WikiExecutionDataStructuresStep.parse({
      kind: "data-structures",
      wiki_path: ARTIFACT_PATHS.WIKI_DATA_STRUCTURES,
      reused: false,
    })
  }

  for (let moduleIndex = 0; moduleIndex < plan.module_order.length; moduleIndex++) {
    const moduleName = plan.module_order[moduleIndex]!
    const functionOrder = plan.per_module_function_order[moduleName] ?? []

    for (let functionIndex = 0; functionIndex < functionOrder.length; functionIndex++) {
      const functionId = functionOrder[functionIndex]!
      const wikiPath = plan.per_function_wiki_paths[functionId]
      if (!wikiPath) {
        throw new Error(`wiki-generation-plan.json is missing per_function_wiki_paths entry for ${functionId}`)
      }
      if (!hasReusableFunctionWiki(wikiPath)) {
        return buildFunctionStep(plan, moduleName, functionId, moduleIndex, functionIndex)
      }
    }

    const modulePath = resolveProjectPath(getModuleWikiPath(moduleName))
    if (!existsSync(modulePath)) {
      return buildModuleStep(plan, ledger, moduleName, moduleIndex)
    }
  }

  if (!isIndexAligned(plan)) {
    return buildGlobalStep(plan)
  }

  return buildCompleteStep()
}

export const wikiExecutionPlanner: ToolDefinition = tool({
  description:
    "Compute the next strict Phase 1b wiki-execution step from wiki-generation-plan.json and current wiki files, " +
    "and persist .matrix/state/wiki-execution-state.json so the model cannot prematurely skip unfinished function work.",
  args: {
    mode: tool.schema.enum(WikiExecutionPlannerMode.options).describe("Compute the next strict Phase 1b execution step."),
    plan_file: tool.schema
      .string()
      .optional()
      .describe("Optional custom wiki-generation plan path. Defaults to .matrix/plans/wiki-generation-plan.json."),
    state_file: tool.schema
      .string()
      .optional()
      .describe("Optional custom wiki execution state path. Defaults to .matrix/state/wiki-execution-state.json."),
  },
  async execute({ plan_file, state_file }) {
    const planPath = plan_file ? resolveUserPath(plan_file) : resolveProjectPath(ARTIFACT_PATHS.WIKI_PLAN)
    const statePath = state_file ? resolveUserPath(state_file) : resolveProjectPath(ARTIFACT_PATHS.WIKI_EXECUTION_STATE)
    const stepPath = resolveProjectPath(ARTIFACT_PATHS.WIKI_NEXT_STEP)

    return await withFileLock(statePath, async () => {
      try {
        if (!existsSync(planPath)) {
          throw new Error(`Missing wiki-generation plan at ${planPath}`)
        }

        const plan = WikiGenerationPlan.parse(readJsonFile(planPath))
        const ledger = loadAnalysisLedger()
        const nextStep = determineNextStep(plan, ledger)
        writeStepArtifact(stepPath, nextStep)
        const nextStepPointer = buildStepPointer(nextStep, ARTIFACT_PATHS.WIKI_NEXT_STEP)
        const { completedFunctionIds, reusedFunctionIds } = countCompletedFunctions(plan)
        const completedModules = countCompletedModules(plan)
        const globalSynthesisCompleted = nextStep?.kind === "complete" && isIndexAligned(plan)

        const state = WikiExecutionState.parse({
          artifact_type: "wiki-execution-state",
          updated_at: new Date().toISOString(),
          total_functions: Object.keys(plan.per_function_wiki_paths).length,
          completed_functions: completedFunctionIds.size,
          reused_functions: reusedFunctionIds.size,
          pending_functions: Math.max(0, Object.keys(plan.per_function_wiki_paths).length - completedFunctionIds.size),
          completed_modules: completedModules.size,
          total_modules: plan.module_order.length,
          global_synthesis_completed: globalSynthesisCompleted,
          last_dispatched_step: nextStepPointer,
        })

        ensureDir(statePath)
        writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8")

        return JSON.stringify({
          status: "success",
          plan_path: plan_file ?? ARTIFACT_PATHS.WIKI_PLAN,
          state_path: state_file ?? ARTIFACT_PATHS.WIKI_EXECUTION_STATE,
          next_step: nextStepPointer,
          state_summary: {
            total_functions: state.total_functions,
            completed_functions: state.completed_functions,
            reused_functions: state.reused_functions,
            pending_functions: state.pending_functions,
            completed_modules: state.completed_modules,
            total_modules: state.total_modules,
            global_synthesis_completed: state.global_synthesis_completed,
          },
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
