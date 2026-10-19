import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, isAbsolute, parse, relative, resolve } from "path"
import { ModuleDependencyGraph } from "../schema/module-dependency-graph"
import {
  SoftwareAnalysisStage03FunctionChunk,
  SoftwareAnalysisStageArtifact,
} from "../schema/software-analysis-stage"
import { ARTIFACT_PATHS } from "../shared/constants"

type ModuleDependencyFunction = {
  id: string
  name: string
  file_path: string
  calls: string[]
}

type ModuleDependencyModule = {
  name: string
  path: string
  functions: string[]
}

function resolveUserPath(pathValue: string): string {
  return isAbsolute(pathValue) ? resolve(pathValue) : resolve(process.cwd(), pathValue)
}

function ensureDir(filePath: string): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid JSON in ${filePath}: ${message}`)
  }
}

function toModuleDependencyFunctions(
  items: Array<{ id: string; name: string; file_path: string; calls: string[] }>,
): ModuleDependencyFunction[] {
  return items.map((item) => ({
    id: item.id,
    name: item.name,
    file_path: item.file_path,
    calls: [...item.calls],
  }))
}

function synthesizeModules(functions: ModuleDependencyFunction[]): ModuleDependencyModule[] {
  const modules = new Map<string, ModuleDependencyModule>()

  for (const fn of functions) {
    const modulePath = fn.file_path
    const moduleName = parse(modulePath.replace(/\\/g, "/")).name
    if (!moduleName) continue

    const moduleKey = normalizeModulePath(modulePath)
    const existing = modules.get(moduleKey)
    if (existing) {
      existing.functions.push(fn.id)
      continue
    }

    modules.set(moduleKey, {
      name: moduleName,
      path: modulePath,
      functions: [fn.id],
    })
  }

  return [...modules.values()]
    .map((module) => ({
      ...module,
      functions: [...new Set(module.functions)].sort((left, right) => left.localeCompare(right)),
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

function normalizeModulePath(pathValue: string): string {
  return pathValue.replace(/\\/g, "/")
}

function getRelativeModulePath(modulePath: string): string {
  const resolvedPath = resolveUserPath(modulePath)
  const relativePath = normalizeModulePath(relative(process.cwd(), resolvedPath))
  return relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath)
    ? relativePath
    : normalizeModulePath(modulePath)
}

function getModulePathLabel(modulePath: string, includeExtension = false): string {
  const normalizedPath = getRelativeModulePath(modulePath)
  const parsed = parse(normalizedPath)
  const leaf = includeExtension ? parsed.base : parsed.name
  return parsed.dir ? `${parsed.dir}/${leaf}` : leaf
}

function normalizeModules(modules: ModuleDependencyModule[]): ModuleDependencyModule[] {
  const mergedByPath = new Map<string, ModuleDependencyModule>()

  for (const module of modules) {
    const normalizedPath = normalizeModulePath(module.path)
    const existing = mergedByPath.get(normalizedPath)
    if (existing) {
      existing.functions.push(...module.functions)
      continue
    }

    mergedByPath.set(normalizedPath, {
      name: module.name,
      path: module.path,
      functions: [...module.functions],
    })
  }

  const mergedModules = [...mergedByPath.values()]
    .map((module) => ({
      ...module,
      functions: [...new Set(module.functions)].sort((left, right) => left.localeCompare(right)),
    }))
    .sort((left, right) => normalizeModulePath(left.path).localeCompare(normalizeModulePath(right.path)))

  const duplicateCounts = new Map<string, number>()
  for (const module of mergedModules) {
    duplicateCounts.set(module.name, (duplicateCounts.get(module.name) ?? 0) + 1)
  }

  const preferredNames = mergedModules.map((module) => ({
    module,
    preferredName:
      (duplicateCounts.get(module.name) ?? 0) > 1
        ? getModulePathLabel(module.path)
        : module.name,
  }))

  const preferredNameCounts = new Map<string, number>()
  for (const entry of preferredNames) {
    preferredNameCounts.set(entry.preferredName, (preferredNameCounts.get(entry.preferredName) ?? 0) + 1)
  }

  const usedNames = new Map<string, number>()
  return preferredNames.map(({ module, preferredName }) => {
    const baseName =
      (preferredNameCounts.get(preferredName) ?? 0) > 1
        ? getModulePathLabel(module.path, true)
        : preferredName
    const seenCount = usedNames.get(baseName) ?? 0
    usedNames.set(baseName, seenCount + 1)

    return {
      ...module,
      name: seenCount === 0 ? baseName : `${baseName}__${seenCount + 1}`,
    }
  })
}

function loadStage03Data(stage03FilePath: string): {
  functions: ModuleDependencyFunction[]
  modules: ModuleDependencyModule[]
} {
  const parsed = SoftwareAnalysisStageArtifact.safeParse(readJsonFile(stage03FilePath))
  if (!parsed.success) {
    throw new Error(`Stage-03 schema mismatch in ${stage03FilePath}: ${parsed.error.message}`)
  }
  if (parsed.data.stage_id !== "03-code") {
    throw new Error(
      `Stage-03 schema mismatch in ${stage03FilePath}: expected stage_id "03-code" but found "${parsed.data.stage_id}"`,
    )
  }

  const payload = parsed.data.payload
  let functions: ModuleDependencyFunction[] = []

  if (payload.function_index.length > 0) {
    functions = toModuleDependencyFunctions(payload.function_index)
  } else if (payload.functions.length > 0) {
    functions = toModuleDependencyFunctions(payload.functions)
  } else {
    for (const chunkRef of payload.function_chunks) {
      const chunkPath = resolveUserPath(chunkRef.file_path)
      if (!existsSync(chunkPath)) {
        throw new Error(`Missing stage-03 function chunk: ${chunkRef.file_path}`)
      }

      const parsedChunk = SoftwareAnalysisStage03FunctionChunk.safeParse(readJsonFile(chunkPath))
      if (!parsedChunk.success) {
        throw new Error(`Invalid stage-03 function chunk ${chunkRef.file_path}: ${parsedChunk.error.message}`)
      }

      functions.push(...toModuleDependencyFunctions(parsedChunk.data.functions))
    }
  }

  const modules = payload.modules.length > 0
    ? payload.modules.map((module) => ({
        name: module.name,
        path: module.path,
        functions: [...module.functions],
      }))
    : synthesizeModules(functions)

  return { functions, modules: normalizeModules(modules) }
}

function buildFunctionIndexes(functions: ModuleDependencyFunction[]) {
  const byId = new Map<string, ModuleDependencyFunction>()
  const byName = new Map<string, ModuleDependencyFunction[]>()

  for (const fn of functions) {
    byId.set(fn.id, fn)
    const sameName = byName.get(fn.name)
    if (sameName) {
      sameName.push(fn)
    } else {
      byName.set(fn.name, [fn])
    }
  }

  return { byId, byName }
}

function resolveModuleMemberFunctions(
  module: ModuleDependencyModule,
  indexes: ReturnType<typeof buildFunctionIndexes>,
): ModuleDependencyFunction[] {
  const resolved = new Map<string, ModuleDependencyFunction>()
  const normalizedModulePath = normalizeModulePath(module.path)

  for (const ref of module.functions) {
    const byId = indexes.byId.get(ref)
    if (byId) {
      resolved.set(byId.id, byId)
      continue
    }

    const byName = indexes.byName.get(ref) ?? []
    if (byName.length === 1) {
      resolved.set(byName[0]!.id, byName[0]!)
      continue
    }

    if (byName.length > 1) {
      const samePathMatches = byName.filter(
        (fn) => normalizeModulePath(fn.file_path) === normalizedModulePath,
      )
      for (const fn of samePathMatches) {
        resolved.set(fn.id, fn)
      }
    }
  }

  return [...resolved.values()].sort((left, right) => left.id.localeCompare(right.id))
}

function buildFunctionToModulesMap(
  resolvedModuleMembers: Map<string, ModuleDependencyFunction[]>,
): Map<string, Set<string>> {
  const functionToModules = new Map<string, Set<string>>()

  for (const [moduleName, members] of resolvedModuleMembers.entries()) {
    for (const fn of members) {
      const targets = functionToModules.get(fn.id) ?? new Set<string>()
      targets.add(moduleName)
      functionToModules.set(fn.id, targets)
    }
  }

  return functionToModules
}

function resolveCalleeFunctions(
  calleeRef: string,
  indexes: ReturnType<typeof buildFunctionIndexes>,
): ModuleDependencyFunction[] {
  const exactById = indexes.byId.get(calleeRef)
  if (exactById) {
    return [exactById]
  }

  return [...(indexes.byName.get(calleeRef) ?? [])]
}

function buildModuleDependencyGraph(
  functions: ModuleDependencyFunction[],
  modules: ModuleDependencyModule[],
) {
  const indexes = buildFunctionIndexes(functions)
  const resolvedModuleMembers = new Map<string, ModuleDependencyFunction[]>()

  for (const module of modules) {
    resolvedModuleMembers.set(module.name, resolveModuleMemberFunctions(module, indexes))
  }

  const functionToModules = buildFunctionToModulesMap(resolvedModuleMembers)
  const dependenciesByModule = new Map<string, Set<string>>()

  for (const module of modules) {
    const dependencies = new Set<string>()
    dependenciesByModule.set(module.name, dependencies)

    for (const fn of resolvedModuleMembers.get(module.name) ?? []) {
      for (const calleeRef of fn.calls) {
        const calleeFunctions = resolveCalleeFunctions(calleeRef, indexes)
        if (calleeFunctions.length === 0) continue

        for (const callee of calleeFunctions) {
          for (const calleeModule of functionToModules.get(callee.id) ?? []) {
            if (calleeModule !== module.name) {
              dependencies.add(calleeModule)
            }
          }
        }
      }
    }
  }

  const graph = Object.fromEntries(
    [...dependenciesByModule.keys()]
      .sort((left, right) => left.localeCompare(right))
      .map((moduleName) => [
        moduleName,
        [...(dependenciesByModule.get(moduleName) ?? [])].sort((left, right) => left.localeCompare(right)),
      ]),
  )

  return ModuleDependencyGraph.parse(graph)
}

export const moduleDependencyBuilder: ToolDefinition = tool({
  description:
    "Build a module dependency graph from the stage-03 software analysis artifact. " +
    "Reads .matrix/data/software-analysis-stage-03-code.json by default and writes " +
    "a module-to-dependent-modules map to .matrix/data/module-dependencies.json.",
  args: {
    stage03_file: tool.schema
      .string()
      .optional()
      .describe(
        "Path to the stage-03 code artifact. Defaults to .matrix/data/software-analysis-stage-03-code.json.",
      ),
    output_file: tool.schema
      .string()
      .optional()
      .describe(
        "Path to write the generated module dependency JSON. Defaults to .matrix/data/module-dependencies.json.",
      ),
  },
  async execute(args = {}) {
    const {
      stage03_file = ARTIFACT_PATHS.SOFTWARE_ANALYSIS_STAGE_03_CODE,
      output_file = ARTIFACT_PATHS.MODULE_DEPENDENCIES,
    } = args as {
      stage03_file?: string
      output_file?: string
    }
    const stage03FilePath = resolveUserPath(stage03_file)
    const outputFilePath = resolveUserPath(output_file)

    try {
      if (!existsSync(stage03FilePath)) {
        return JSON.stringify({
          status: "error",
          error: `Missing stage-03 artifact: ${stage03_file}`,
        }, null, 2)
      }

      const { functions, modules } = loadStage03Data(stage03FilePath)
      const dependencyGraph = buildModuleDependencyGraph(functions, modules)

      ensureDir(outputFilePath)
      writeFileSync(outputFilePath, JSON.stringify(dependencyGraph, null, 2), "utf-8")

      const edgeCount = Object.values(dependencyGraph).reduce((sum, deps) => sum + deps.length, 0)
      return JSON.stringify({
        status: "success",
        stage03_file,
        output_file,
        module_count: Object.keys(dependencyGraph).length,
        edge_count: edgeCount,
      }, null, 2)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return JSON.stringify({
        status: "error",
        error: message,
      }, null, 2)
    }
  },
})
