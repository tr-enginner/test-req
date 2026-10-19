import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { basename, dirname, isAbsolute, join, parse, resolve } from "path"
import { z } from "zod"
import {
  SoftwareAnalysisStage03FunctionChunk,
  SoftwareAnalysisStageArtifact,
} from "../schema/software-analysis-stage"
import { SoftwareAnalysisReport, type FunctionInfo, type SoftwareModule } from "../schema/sut"
import { DataStructuresFile, FunctionWiki, WikiGenerationPlan, type WikiGenerationPlanCycle } from "../schema/wiki"
import { ARTIFACT_PATHS } from "../shared/constants"
import { withFileLock } from "../shared/file-mutex"

type PlanningFunction = {
  id: string
  name: string
  file_path: string
  line_range: {
    start: number
    end: number
  }
  return_type: string
  parameters: PlanningFunctionParameter[]
  calls: string[]
}

type PlanningFunctionParameter = {
  name: string
  type: string
  description?: string
}

type PlanningModule = {
  name: string
  functions: string[]
}

type PlanningAnalysis = {
  project_name: string
  functions: PlanningFunction[]
  modules: PlanningModule[]
}

type FunctionMaps = {
  byId: Map<string, PlanningFunction>
  byName: Map<string, PlanningFunction[]>
}

const WikiPlanBuilderMode = z.enum(["build_plan"])

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

function toPlanningFunction(item: Pick<FunctionInfo, "id" | "name" | "file_path" | "line_range" | "return_type" | "parameters" | "calls">): PlanningFunction {
  return {
    id: item.id,
    name: item.name,
    file_path: item.file_path,
    line_range: item.line_range,
    return_type: item.return_type,
    parameters: item.parameters.map((param) => ({
      name: param.name,
      type: param.type,
      ...(param.description ? { description: param.description } : {}),
    })),
    calls: [...item.calls],
  }
}

function toPlanningFunctionFromIndex(
  entry: {
    id: string
    name: string
    file_path: string
    line_range: { start: number; end: number }
    return_type?: string
    parameters?: PlanningFunctionParameter[]
    calls: string[]
  },
  detail?: PlanningFunction,
): PlanningFunction {
  return {
    id: entry.id,
    name: entry.name,
    file_path: entry.file_path,
    line_range: entry.line_range,
    return_type: entry.return_type ?? detail?.return_type ?? "unknown",
    parameters: entry.parameters ?? detail?.parameters ?? [],
    calls: [...entry.calls],
  }
}

function synthesizeModules(functions: PlanningFunction[]): PlanningModule[] {
  const modules = new Map<string, string[]>()

  for (const fn of functions) {
    const moduleName = parse(fn.file_path.replace(/\\/g, "/")).name
    if (!moduleName) continue
    const refs = modules.get(moduleName)
    if (refs) {
      refs.push(fn.id)
    } else {
      modules.set(moduleName, [fn.id])
    }
  }

  return [...modules.entries()]
    .map(([name, refs]) => ({ name, functions: refs }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

function loadStage03Functions(stage03Path: string): PlanningFunction[] {
  const parsed = SoftwareAnalysisStageArtifact.safeParse(readJsonFile(stage03Path))
  if (!parsed.success || parsed.data.stage_id !== "03-code") {
    throw new Error(`Invalid stage-03 artifact at ${stage03Path}`)
  }

  const payload = parsed.data.payload
  const inlineFunctions = payload.functions.map(toPlanningFunction)
  const chunkFunctions: PlanningFunction[] = []
  for (const chunkRef of payload.function_chunks) {
    const chunkPath = resolveProjectPath(chunkRef.file_path)
    if (!existsSync(chunkPath)) continue
    const parsedChunk = SoftwareAnalysisStage03FunctionChunk.safeParse(readJsonFile(chunkPath))
    if (!parsedChunk.success) {
      throw new Error(`Invalid stage-03 function chunk at ${chunkPath}: ${parsedChunk.error.message}`)
    }
    chunkFunctions.push(...parsedChunk.data.functions.map(toPlanningFunction))
  }
  const detailById = new Map([...inlineFunctions, ...chunkFunctions].map((fn) => [fn.id, fn]))

  const fromIndex = payload.function_index.map((entry) => toPlanningFunctionFromIndex(entry, detailById.get(entry.id)))
  if (fromIndex.length > 0) return fromIndex
  if (inlineFunctions.length > 0) return inlineFunctions
  return chunkFunctions
}

function loadPlanningAnalysis(): PlanningAnalysis {
  const analysisPath = resolveProjectPath(ARTIFACT_PATHS.SOFTWARE_ANALYSIS)
  if (existsSync(analysisPath)) {
    const parsed = SoftwareAnalysisReport.safeParse(readJsonFile(analysisPath))
    if (parsed.success && parsed.data.functions.length > 0) {
      const functions = parsed.data.functions.map(toPlanningFunction)
      const modules = parsed.data.modules.length > 0
        ? parsed.data.modules.map((module) => ({
            name: module.name,
            functions: [...module.functions],
          }))
        : synthesizeModules(functions)
      return {
        project_name: parsed.data.project_name,
        functions,
        modules,
      }
    }
  }

  const stage03Path = resolveProjectPath(ARTIFACT_PATHS.SOFTWARE_ANALYSIS_STAGE_03_CODE)
  if (!existsSync(stage03Path)) {
    throw new Error("Neither software-analysis.json nor a usable stage-03 code artifact is available for wiki planning")
  }

  const parsed = SoftwareAnalysisStageArtifact.safeParse(readJsonFile(stage03Path))
  if (!parsed.success || parsed.data.stage_id !== "03-code") {
    throw new Error(`Invalid stage-03 artifact at ${stage03Path}`)
  }

  const functions = loadStage03Functions(stage03Path)
  const modules = parsed.data.payload.modules.length > 0
    ? parsed.data.payload.modules.map((module) => ({
        name: module.name,
        functions: [...module.functions],
      }))
    : synthesizeModules(functions)

  return {
    project_name: basename(process.cwd()),
    functions,
    modules,
  }
}

function buildFunctionMaps(functions: PlanningFunction[]): FunctionMaps {
  const byId = new Map<string, PlanningFunction>()
  const byName = new Map<string, PlanningFunction[]>()

  for (const fn of functions) {
    if (byId.has(fn.id)) {
      throw new Error(`Duplicate function id "${fn.id}" prevents deterministic wiki plan generation`)
    }
    const sameName = byName.get(fn.name)
    if (sameName) {
      sameName.push(fn)
    } else {
      byName.set(fn.name, [fn])
    }
    byId.set(fn.id, fn)
  }

  return { byId, byName }
}

function getFunctionWikiPath(fn: Pick<PlanningFunction, "name">): string {
  return `.matrix/wiki/functions/${fn.name}.json`
}

function resolveCallee(
  currentModuleName: string,
  calleeName: string,
  functionMaps: FunctionMaps,
  functionToModule: Map<string, string>,
): PlanningFunction | undefined {
  const candidates = functionMaps.byName.get(calleeName) ?? []
  if (candidates.length <= 1) {
    return candidates[0]
  }

  const sameModule = candidates.find((candidate) => functionToModule.get(candidate.id) === currentModuleName)
  if (sameModule) return sameModule

  return [...candidates].sort((left, right) => {
    const fileCompare = left.file_path.localeCompare(right.file_path)
    return fileCompare !== 0 ? fileCompare : left.id.localeCompare(right.id)
  })[0]
}

function resolveModuleFunctions(
  modules: PlanningModule[],
  functionsById: Map<string, PlanningFunction>,
  functionsByName: Map<string, PlanningFunction>,
) {
  const resolved = new Map<string, PlanningFunction[]>()

  for (const module of modules) {
    const members: PlanningFunction[] = []
    for (const ref of module.functions) {
      const fn = functionsById.get(ref) ?? functionsByName.get(ref)
      if (fn) {
        members.push(fn)
      }
    }
    resolved.set(module.name, members)
  }

  return resolved
}

function synthesizeMissingModuleMembership(
  modules: PlanningModule[],
  moduleFunctions: Map<string, PlanningFunction[]>,
  functions: PlanningFunction[],
) {
  const knownIds = new Set<string>()
  for (const members of moduleFunctions.values()) {
    for (const fn of members) knownIds.add(fn.id)
  }

  for (const fn of functions) {
    if (knownIds.has(fn.id)) continue
    const moduleName = parse(fn.file_path.replace(/\\/g, "/")).name
    const members = moduleFunctions.get(moduleName)
    if (members) {
      members.push(fn)
    } else {
      modules.push({ name: moduleName, functions: [fn.id] })
      moduleFunctions.set(moduleName, [fn])
    }
  }
}

function buildFunctionToModuleMap(moduleFunctions: Map<string, PlanningFunction[]>) {
  const functionToModule = new Map<string, string>()
  for (const [moduleName, members] of moduleFunctions.entries()) {
    for (const fn of members) {
      functionToModule.set(fn.id, moduleName)
      functionToModule.set(fn.name, moduleName)
    }
  }
  return functionToModule
}

function buildBottomUpOrder(
  nodes: string[],
  dependenciesByNode: Map<string, Set<string>>,
): { order: string[]; cycleNodes: string[] } {
  const adjacency = new Map<string, Set<string>>()
  const inDegree = new Map<string, number>()

  for (const node of nodes) {
    adjacency.set(node, new Set<string>())
    inDegree.set(node, 0)
  }

  for (const [node, dependencies] of dependenciesByNode.entries()) {
    for (const dependency of dependencies) {
      if (!adjacency.has(dependency) || !inDegree.has(node)) continue
      adjacency.get(dependency)!.add(node)
      inDegree.set(node, (inDegree.get(node) ?? 0) + 1)
    }
  }

  const ready = [...nodes.filter((node) => (inDegree.get(node) ?? 0) === 0)].sort((left, right) =>
    left.localeCompare(right),
  )
  const order: string[] = []

  while (ready.length > 0) {
    const current = ready.shift()!
    order.push(current)
    const dependents = [...(adjacency.get(current) ?? [])].sort((left, right) => left.localeCompare(right))
    for (const dependent of dependents) {
      const nextDegree = (inDegree.get(dependent) ?? 0) - 1
      inDegree.set(dependent, nextDegree)
      if (nextDegree === 0) {
        ready.push(dependent)
        ready.sort((left, right) => left.localeCompare(right))
      }
    }
  }

  const cycleNodes = nodes
    .filter((node) => !order.includes(node))
    .sort((left, right) => left.localeCompare(right))

  if (cycleNodes.length > 0) {
    order.push(...cycleNodes)
  }

  return { order, cycleNodes }
}

function detectExistingFunctionWiki(directory: string, relativePath: string): string | null {
  const absolutePath = join(directory, relativePath)
  if (!existsSync(absolutePath)) return null
  try {
    const parsed = FunctionWiki.safeParse(readJsonFile(absolutePath))
    if (!parsed.success) return null
  } catch {
    return null
  }
  return relativePath
}

function hasReusableDataStructuresWiki(directory: string): boolean {
  const path = join(directory, ARTIFACT_PATHS.WIKI_DATA_STRUCTURES)
  if (!existsSync(path)) return false
  try {
    return DataStructuresFile.safeParse(readJsonFile(path)).success
  } catch {
    return false
  }
}

export const wikiPlanBuilder: ToolDefinition = tool({
  description:
    "Build the canonical bottom-up Phase 1b wiki-generation plan from software-analysis artifacts " +
    "and write .matrix/plans/wiki-generation-plan.json so the model does not need to hand-write large schedule JSON.",
  args: {
    mode: tool.schema.enum(WikiPlanBuilderMode.options).describe("Build the canonical wiki generation plan."),
    output_file: tool.schema
      .string()
      .optional()
      .describe("Optional custom output path. Defaults to .matrix/plans/wiki-generation-plan.json."),
  },
  async execute({ output_file }) {
    const outputPath = output_file
      ? resolveUserPath(output_file)
      : resolveProjectPath(ARTIFACT_PATHS.WIKI_PLAN)

    return await withFileLock(outputPath, async () => {
      try {
        const analysis = loadPlanningAnalysis()
        const functionMaps = buildFunctionMaps(analysis.functions)
        const { byId } = functionMaps
        const modules = [...analysis.modules]
        const moduleFunctions = resolveModuleFunctions(modules, byId, new Map(
          [...functionMaps.byName.entries()].map(([name, entries]) => [name, entries[0]!]),
        ))
        synthesizeMissingModuleMembership(modules, moduleFunctions, analysis.functions)

        const functionToModule = buildFunctionToModuleMap(moduleFunctions)
        const knownModuleNames = new Set(modules.map((module) => module.name))
        const moduleDependencies = new Map<string, Set<string>>()
        const perModuleFunctionOrder: Record<string, string[]> = {}
        const perFunctionNames: Record<string, string> = {}
        const perFunctionDirectCallees: Record<string, string[]> = {}
        const perFunctionDependencyWikiPaths: Record<string, string[]> = {}
        const perFunctionSourceLocations: Record<string, { file_path: string; line_range: { start: number; end: number } }> = {}
        const perFunctionInterfaces: Record<string, { return_type: string; parameters: PlanningFunctionParameter[] }> = {}
        const perFunctionWikiPaths: Record<string, string> = {}
        const reusableFunctionWikiPaths: Record<string, string> = {}
        const skippedFunctionDispatches: Array<{
          function_name: string
          module_name: string
          wiki_path: string
          reason: "reused_existing_artifact"
        }> = []
        const detectedCycles: WikiGenerationPlanCycle[] = []

        for (const module of modules) {
          const members = [...(moduleFunctions.get(module.name) ?? [])].sort((left, right) => left.name.localeCompare(right.name))
          const memberIds = new Set(members.map((fn) => fn.id))
          const intraModuleDependencies = new Map<string, Set<string>>()
          const lowerModules = new Set<string>()

          for (const fn of members) {
            const directProjectCallees = fn.calls
              .map((calleeName) => resolveCallee(module.name, calleeName, functionMaps, functionToModule))
              .filter((callee): callee is PlanningFunction => callee !== undefined && callee.id !== fn.id)

            perFunctionNames[fn.id] = fn.name
            perFunctionWikiPaths[fn.id] = getFunctionWikiPath(fn)
            perFunctionDirectCallees[fn.id] = directProjectCallees.map((callee) => callee.id)
            perFunctionDependencyWikiPaths[fn.id] = directProjectCallees.map(
              (callee) => getFunctionWikiPath(callee),
            )
            perFunctionSourceLocations[fn.id] = {
              file_path: fn.file_path,
              line_range: fn.line_range,
            }
            perFunctionInterfaces[fn.id] = {
              return_type: fn.return_type,
              parameters: fn.parameters,
            }

            const reusablePath = detectExistingFunctionWiki(
              process.cwd(),
              getFunctionWikiPath(fn),
            )
            if (reusablePath) {
              reusableFunctionWikiPaths[fn.id] = reusablePath
              skippedFunctionDispatches.push({
                function_name: fn.name,
                module_name: module.name,
                wiki_path: reusablePath,
                reason: "reused_existing_artifact",
              })
            }

            const sameModuleDependencies = new Set<string>()
            for (const callee of directProjectCallees) {
              const calleeModule = functionToModule.get(callee.id) ?? functionToModule.get(callee.name)
              if (calleeModule && calleeModule !== module.name && knownModuleNames.has(calleeModule)) {
                lowerModules.add(calleeModule)
              }
              if (memberIds.has(callee.id)) {
                sameModuleDependencies.add(callee.id)
              }
            }
            intraModuleDependencies.set(fn.id, sameModuleDependencies)
          }

          const functionIds = members.map((fn) => fn.id)
          const { order, cycleNodes } = buildBottomUpOrder(functionIds, intraModuleDependencies)
          perModuleFunctionOrder[module.name] = order
          if (cycleNodes.length > 0) {
            detectedCycles.push({
              level: "function",
              module_name: module.name,
              members: cycleNodes,
            })
          }

          moduleDependencies.set(module.name, lowerModules)
        }

        const moduleNames = modules.map((module) => module.name)
        const { order: moduleOrder, cycleNodes: moduleCycleNodes } = buildBottomUpOrder(moduleNames, moduleDependencies)
        if (moduleCycleNodes.length > 0) {
          detectedCycles.push({
            level: "module",
            members: moduleCycleNodes,
          })
        }

        const dependencyRequirements = Object.fromEntries(
          moduleOrder.map((moduleName) => {
            const dependencies = [...(moduleDependencies.get(moduleName) ?? [])].sort((left, right) => left.localeCompare(right))
            return [
              moduleName,
              {
                module_dependencies: dependencies,
                required_lower_layer_paths: dependencies.map((dependency) => `.matrix/wiki/modules/${dependency}.json`),
              },
            ]
          }),
        )

        const plan = WikiGenerationPlan.parse({
          artifact_type: "wiki-generation-plan",
          created_date: new Date().toISOString(),
          project: {
            project_name: analysis.project_name,
            total_functions: analysis.functions.length,
            total_modules: modules.length,
          },
          reused_data_structures_wiki: hasReusableDataStructuresWiki(process.cwd()),
          module_order: moduleOrder,
          detected_cycles: detectedCycles,
          dependency_requirements: dependencyRequirements,
          per_module_function_order: perModuleFunctionOrder,
          per_function_names: perFunctionNames,
          per_function_direct_callees: perFunctionDirectCallees,
          per_function_dependency_wiki_paths: perFunctionDependencyWikiPaths,
          per_function_source_locations: perFunctionSourceLocations,
          per_function_interfaces: perFunctionInterfaces,
          per_function_wiki_paths: perFunctionWikiPaths,
          reusable_function_wiki_paths: reusableFunctionWikiPaths,
          skipped_function_dispatches: skippedFunctionDispatches,
        })

        ensureDir(outputPath)
        writeFileSync(outputPath, JSON.stringify(plan, null, 2), "utf-8")

        return JSON.stringify({
          status: "success",
          output_path: output_file ?? ARTIFACT_PATHS.WIKI_PLAN,
          summary: {
            total_functions: plan.project.total_functions,
            total_modules: plan.project.total_modules,
            scheduled_modules: plan.module_order.length,
            scheduled_functions: Object.values(plan.per_module_function_order).reduce(
              (total, functions) => total + functions.length,
              0,
            ),
            reused_functions: Object.keys(plan.reusable_function_wiki_paths).length,
            detected_cycles: plan.detected_cycles.length,
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
