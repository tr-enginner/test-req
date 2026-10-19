import { existsSync, readFileSync } from "fs"
import { join, parse } from "path"
import { FunctionWiki, WikiGenerationPlan } from "../schema/wiki"
import { ARTIFACT_PATHS } from "../shared/constants"

const wikiReadPathsBySession = new Map<string, Set<string>>()
const WIKI_PHASE_AGENTS = new Set(["wiki-scheduler", "wiki-executor"])

const WIKI_BOTTOM_UP_REMINDER = `<wiki-bottom-up-guard>
When acting as wiki-scheduler or wiki-executor, Phase 1b MUST follow bottom-up code understanding:
- Build and follow the reverse topological order of the call graph: lower-layer leaves first, callers later.
- Dispatch function understanding one caller at a time; do not batch multiple caller analyses into one semantic pass.
- Before analyzing or writing an upper-layer module, you MUST load every already-generated lower-layer dependency module wiki from .matrix/wiki/modules/*.json, either via explicit read or via hook-preloaded dependency context.
- Before analyzing or writing an upper-layer function that calls into another module, you MUST load the relevant lower-layer function wiki and/or dependency module wiki first, either via explicit read or via hook-preloaded dependency context.
- If a required lower-layer wiki artifact does not exist yet, stop and analyze that lower layer first, unless the missing artifact belongs to a detected function-level or module-level cycle (recursive/cyclic calls) — in that case you may continue with partial grounding.
- Writing an upper-layer module/function without first loading lower-layer wiki context is invalid and must be redone, except for cycle-deferred callees.
</wiki-bottom-up-guard>`

export function normalizeWikiArtifactPath(path: string): string {
  const normalized = path.replace(/\\/g, "/")
  const marker = normalized.indexOf(".matrix/wiki/")
  return marker >= 0 ? normalized.slice(marker) : normalized
}

export function extractWikiArtifactPaths(text: string): string[] {
  const matches =
    text.match(/(?:[A-Za-z]:)?[^"'`\s]*\.matrix[\\/]+wiki[\\/]+(?:modules|functions)[\\/][^"'`\s]+\.json/g) ?? []
  return [...new Set(matches.map(normalizeWikiArtifactPath))]
}

function getOrCreateSessionReadSet(sessionID: string): Set<string> {
  const existing = wikiReadPathsBySession.get(sessionID)
  if (existing) return existing
  const created = new Set<string>()
  wikiReadPathsBySession.set(sessionID, created)
  return created
}

function resetSessionReadSet(sessionID: string): Set<string> {
  const created = new Set<string>()
  wikiReadPathsBySession.set(sessionID, created)
  return created
}

function collectTextParts(parts: any[]): string {
  return parts
    .map((part) => (part && typeof part.text === "string" ? part.text : ""))
    .join("\n")
}

function extractPromptToken(promptText: string, key: string): string | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = promptText.match(new RegExp(`${escapedKey}=([^\\s]+)`))
  return match?.[1] ?? null
}

type MinimalFunctionInfo = {
  id: string
  name: string
  filePath?: string
  calls: string[]
}

type MinimalModuleInfo = {
  name: string
  functions: string[]
}

type MinimalAnalysis = {
  functions: MinimalFunctionInfo[]
  modules: MinimalModuleInfo[]
}

type FunctionCycleInfo = {
  exemptFunctionIds: Set<string>
  exemptWikiPaths: Set<string>
}

function loadStage03Analysis(directory: string): MinimalAnalysis | null {
  const stage03Path = join(directory, ARTIFACT_PATHS.SOFTWARE_ANALYSIS_STAGE_03_CODE)
  if (!existsSync(stage03Path)) return null

  try {
    const raw = readFileSync(stage03Path, "utf-8")
    const parsed = JSON.parse(raw) as {
      payload?: {
        functions?: Array<{
          id?: unknown
          name?: unknown
          file_path?: unknown
          calls?: unknown
        }>
        function_index?: Array<{
          id?: unknown
          name?: unknown
          file_path?: unknown
          line_range?: unknown
          calls?: unknown
          called_by?: unknown
          safety_critical?: unknown
          chunk_index?: unknown
          chunk_file_path?: unknown
        }>
        function_chunks?: Array<{
          file_path?: unknown
        }>
        modules?: Array<{ name?: unknown; functions?: unknown }>
      }
    }

    const stagePayload = parsed.payload
    if (!stagePayload) return null

    const indexedFunctions = parseMinimalFunctions(stagePayload.function_index)
    const functions = indexedFunctions.length > 0
      ? indexedFunctions
      : [
          ...parseMinimalFunctions(stagePayload.functions),
          ...loadStage03ChunkFunctions(directory, stagePayload.function_chunks),
        ]

    const declaredModules = Array.isArray(stagePayload.modules)
      ? stagePayload.modules
          .map((item) => {
            if (typeof item?.name !== "string" || !Array.isArray(item.functions)) {
              return null
            }
            const functions = item.functions.filter(
              (ref): ref is string => typeof ref === "string",
            )
            return {
              name: item.name,
              functions,
            }
          })
          .filter((item): item is MinimalModuleInfo => item !== null)
      : []

    const modules =
      declaredModules.length > 0
        ? declaredModules
        : synthesizeModulesFromFunctions(functions)

    if (functions.length === 0 || modules.length === 0) {
      return null
    }

    return { functions, modules }
  } catch {
    return null
  }
}

function loadSoftwareAnalysis(directory: string): MinimalAnalysis | null {
  const analysisPath = join(directory, ARTIFACT_PATHS.SOFTWARE_ANALYSIS)
  if (!existsSync(analysisPath)) {
    return loadStage03Analysis(directory)
  }

  try {
    const raw = readFileSync(analysisPath, "utf-8")
    const parsed = JSON.parse(raw) as {
      functions?: Array<{
        id?: unknown
        name?: unknown
        file_path?: unknown
        calls?: unknown
      }>
      modules?: Array<{ name?: unknown; functions?: unknown }>
    }

    const functions = Array.isArray(parsed.functions)
      ? parsed.functions
          .map((item): MinimalFunctionInfo | null => {
            if (typeof item?.id !== "string" || typeof item?.name !== "string") {
              return null
            }
            const calls = Array.isArray(item.calls)
              ? item.calls.filter((call): call is string => typeof call === "string")
              : []
            const functionInfo: MinimalFunctionInfo = {
              id: item.id,
              name: item.name,
              calls,
            }
            if (typeof item.file_path === "string") {
              functionInfo.filePath = item.file_path
            }
            return functionInfo
          })
          .filter((item): item is MinimalFunctionInfo => item !== null)
      : []

    const declaredModules = Array.isArray(parsed.modules)
      ? parsed.modules
          .map((item) => {
            if (typeof item?.name !== "string" || !Array.isArray(item.functions)) {
              return null
            }
            const functions = item.functions.filter(
              (ref): ref is string => typeof ref === "string",
            )
            return {
              name: item.name,
              functions,
            }
          })
          .filter((item): item is MinimalModuleInfo => item !== null)
      : []

    const modules =
      declaredModules.length > 0
        ? declaredModules
        : synthesizeModulesFromFunctions(functions)

    if (functions.length === 0 || modules.length === 0) {
      return loadStage03Analysis(directory)
    }

    return { functions, modules }
  } catch {
    return loadStage03Analysis(directory)
  }
}

function synthesizeModulesFromFunctions(
  functions: MinimalFunctionInfo[],
): MinimalModuleInfo[] {
  const modules = new Map<string, string[]>()

  for (const fn of functions) {
    if (!fn.filePath) continue
    const moduleName = parse(fn.filePath.replace(/\\/g, "/")).name
    if (!moduleName) continue

    const refs = modules.get(moduleName)
    if (refs) {
      refs.push(fn.id)
    } else {
      modules.set(moduleName, [fn.id])
    }
  }

  return [...modules.entries()].map(([name, functionRefs]) => ({
    name,
    functions: functionRefs,
  }))
}

function findFunctionByReference(
  analysis: MinimalAnalysis,
  reference: string,
): MinimalFunctionInfo | undefined {
  return analysis.functions.find(
    (item) => item.id === reference || item.name === reference,
  )
}

function buildFunctionToModuleMap(analysis: MinimalAnalysis): Map<string, string> {
  const map = new Map<string, string>()
  for (const module of analysis.modules) {
    for (const functionRef of module.functions) {
      const fn = findFunctionByReference(analysis, functionRef)
      if (!fn) continue
      if (!map.has(fn.id)) {
        map.set(fn.id, module.name)
      }
      if (!map.has(fn.name)) {
        map.set(fn.name, module.name)
      }
    }
  }
  return map
}

function buildFunctionsByName(analysis: MinimalAnalysis): Map<string, MinimalFunctionInfo[]> {
  const map = new Map<string, MinimalFunctionInfo[]>()
  for (const fn of analysis.functions) {
    const list = map.get(fn.name)
    if (list) {
      list.push(fn)
    } else {
      map.set(fn.name, [fn])
    }
  }
  return map
}

export function collectModuleDependencies(
  analysis: MinimalAnalysis,
  moduleName: string,
): string[] {
  const functionToModule = buildFunctionToModuleMap(analysis)
  const module = analysis.modules.find((item) => item.name === moduleName)
  if (!module) return []

  const dependencies = new Set<string>()
  for (const fnRef of module.functions) {
    const fn = findFunctionByReference(analysis, fnRef)
    if (!fn) continue
    for (const calleeName of fn.calls) {
      const calleeModule = functionToModule.get(calleeName)
      if (calleeModule && calleeModule !== moduleName) {
        dependencies.add(calleeModule)
      }
    }
  }

  return [...dependencies]
}

type FunctionDependencyContext = {
  calleeId: string
  calleeName: string
  moduleName: string
  sameModule: boolean
}

function splitFunctionArtifactReference(reference: string): {
  functionToken: string
  moduleHint?: string
} {
  const normalized = normalizeWikiArtifactPath(reference)
    .replace(/\\/g, "/")
    .replace(/^\.matrix\/wiki\/functions\//, "")
    .replace(/\.json$/, "")
  const parts = normalized.split("/").filter(Boolean)
  if (parts.length === 0) {
    return { functionToken: reference }
  }
  const baseToken = parts[parts.length - 1] ?? reference
  const duplicateSuffixMatch = baseToken.match(/^(.*)__([^/]+)$/)
  return {
    functionToken: duplicateSuffixMatch?.[2] ?? baseToken,
    moduleHint: parts.length > 1 ? parts[parts.length - 2] : undefined,
  }
}

function loadFunctionCycleInfo(
  directory: string,
  functionId: string | null,
): FunctionCycleInfo {
  if (!functionId) {
    return {
      exemptFunctionIds: new Set<string>(),
      exemptWikiPaths: new Set<string>(),
    }
  }

  const planPath = join(directory, ARTIFACT_PATHS.WIKI_PLAN)
  if (!existsSync(planPath)) {
    return {
      exemptFunctionIds: new Set<string>(),
      exemptWikiPaths: new Set<string>(),
    }
  }

  try {
    const parsed = WikiGenerationPlan.safeParse(JSON.parse(readFileSync(planPath, "utf-8")))
    if (!parsed.success) {
      return {
        exemptFunctionIds: new Set<string>(),
        exemptWikiPaths: new Set<string>(),
      }
    }

    const exemptFunctionIds = new Set<string>()
    const exemptWikiPaths = new Set<string>()

    const funcCycle = parsed.data.detected_cycles.find(
      (item) => item.level === "function" && item.members.includes(functionId),
    )
    if (funcCycle) {
      for (const member of funcCycle.members) {
        if (member !== functionId) {
          exemptFunctionIds.add(member)
          const wikiPath = parsed.data.per_function_wiki_paths[member]
          if (typeof wikiPath === "string") {
            exemptWikiPaths.add(wikiPath)
          }
        }
      }
    }

    const functionModule = Object.entries(parsed.data.per_module_function_order).find(
      ([, funcIds]) => funcIds.includes(functionId),
    )?.[0]

    if (functionModule) {
      const moduleCycle = parsed.data.detected_cycles.find(
        (item) => item.level === "module" && item.members.includes(functionModule),
      )

      if (moduleCycle) {
        const otherCycleModules = moduleCycle.members.filter((m) => m !== functionModule)
        for (const otherModule of otherCycleModules) {
          const otherModuleFuncIds = parsed.data.per_module_function_order[otherModule] ?? []
          for (const otherFuncId of otherModuleFuncIds) {
            exemptFunctionIds.add(otherFuncId)
            const wikiPath = parsed.data.per_function_wiki_paths[otherFuncId]
            if (typeof wikiPath === "string") {
              exemptWikiPaths.add(wikiPath)
            }
          }
        }
      }
    }

    return { exemptFunctionIds, exemptWikiPaths }
  } catch {
    return {
      exemptFunctionIds: new Set<string>(),
      exemptWikiPaths: new Set<string>(),
    }
  }
}

function findFunctionByArtifactReference(
  analysis: MinimalAnalysis,
  reference: string,
): MinimalFunctionInfo | undefined {
  const direct = findFunctionByReference(analysis, reference)
  if (direct) return direct

  const { functionToken, moduleHint } = splitFunctionArtifactReference(reference)
  const candidates = analysis.functions.filter(
    (item) => item.id === functionToken || item.name === functionToken,
  )
  if (candidates.length <= 1 || !moduleHint) {
    return candidates[0]
  }

  const functionToModule = buildFunctionToModuleMap(analysis)
  return candidates.find((item) => functionToModule.get(item.id) === moduleHint)
}

function getFunctionWikiPathCandidates(
  functionRef: Pick<MinimalFunctionInfo, "id" | "name">,
): string[] {
  return [
    `.matrix/wiki/functions/${functionRef.name}.json`,
    `.matrix/wiki/functions/${functionRef.name}__${functionRef.id}.json`,
  ]
}

function getExistingFunctionWikiPaths(
  directory: string,
  functionRef: Pick<MinimalFunctionInfo, "id" | "name">,
): string[] {
  return getFunctionWikiPathCandidates(functionRef).filter((path) =>
    existsSync(join(directory, path)),
  )
}

export function collectFunctionDependencies(
  analysis: MinimalAnalysis,
  functionReference: string,
): FunctionDependencyContext[] {
  const target = findFunctionByArtifactReference(analysis, functionReference)
  if (!target) return []

  const functionToModule = buildFunctionToModuleMap(analysis)
  const functionsByName = buildFunctionsByName(analysis)
  const currentModule = functionToModule.get(target.id)
  if (!currentModule) return []

  const dependencies = new Map<string, FunctionDependencyContext>()
  for (const calleeName of target.calls) {
    for (const callee of functionsByName.get(calleeName) ?? []) {
      const calleeModule = functionToModule.get(callee.id)
      if (!calleeModule) continue
      if (callee.id === target.id) continue
      dependencies.set(callee.id, {
        calleeId: callee.id,
        calleeName: callee.name,
        moduleName: calleeModule,
        sameModule: calleeModule === currentModule,
      })
    }
  }

  return [...dependencies.values()]
}

export function validateModuleDependencyContext(
  analysis: MinimalAnalysis,
  moduleName: string,
  readPaths: Set<string>,
  directory: string,
) {
  const dependencyModules = collectModuleDependencies(analysis, moduleName)
  const dependencyWikiPaths = dependencyModules.map(
    (dep) => `.matrix/wiki/modules/${dep}.json`,
  )

  return {
    dependencyModules,
    missingReads: dependencyWikiPaths.filter((path) => !readPaths.has(path)),
    missingArtifacts: dependencyWikiPaths.filter(
      (path) => !existsSync(join(directory, path)),
    ),
  }
}

export function validateFunctionDependencyContext(
  analysis: MinimalAnalysis,
  functionReference: string,
  readPaths: Set<string>,
  directory: string,
) {
  const target = findFunctionByArtifactReference(analysis, functionReference)
  const cycleInfo = loadFunctionCycleInfo(directory, target?.id ?? null)
  const dependencies = collectFunctionDependencies(analysis, functionReference)
  const missingContexts = dependencies.filter((dep) => {
    if (cycleInfo.exemptFunctionIds.has(dep.calleeId)) {
      return false
    }

    const functionWikiPaths = getExistingFunctionWikiPaths(directory, {
      id: dep.calleeId,
      name: dep.calleeName,
    })
    const moduleWikiPath = `.matrix/wiki/modules/${dep.moduleName}.json`
    const hasModuleArtifact = existsSync(join(directory, moduleWikiPath))

    if (functionWikiPaths.length > 0) {
      return !functionWikiPaths.some((path) => readPaths.has(path))
    }

    if (!dep.sameModule && hasModuleArtifact) {
      return !readPaths.has(moduleWikiPath)
    }

    return true
  })

  return {
    dependencies,
    missingContexts,
  }
}

function appendGuardMessage(
  output: { output: string; metadata: any },
  message: string,
) {
  output.output += `\n\n[BOTTOM-UP GUARD] ${message}`
  output.metadata = {
    ...output.metadata,
    wiki_bottom_up_guard: "failed",
  }
}

function isNestedFunctionWikiPath(path: string): boolean {
  return /\.matrix\/wiki\/functions\/[^/\s]+\/[^/\s]+\.json/.test(path)
}

function isIdBasedFunctionWikiPath(
  analysis: MinimalAnalysis,
  functionReference: string,
): boolean {
  const target = findFunctionByArtifactReference(analysis, functionReference)
  if (!target) return false

  const normalized = normalizeWikiArtifactPath(functionReference).replace(/\\/g, "/")
  if (/\.matrix\/wiki\/functions\/.+__[^/]+\.json$/.test(normalized)) {
    return false
  }

  const { functionToken } = splitFunctionArtifactReference(functionReference)
  return functionToken === target.id && target.name !== target.id
}

function parseMinimalFunctions(items: unknown): MinimalFunctionInfo[] {
  return Array.isArray(items)
    ? items
        .map((item: unknown): MinimalFunctionInfo | null => {
          if (typeof item !== "object" || item === null) {
            return null
          }
          const record = item as {
            id?: unknown
            name?: unknown
            file_path?: unknown
            calls?: unknown
          }
          if (typeof record.id !== "string" || typeof record.name !== "string") {
            return null
          }
          const calls = Array.isArray(record.calls)
            ? record.calls.filter((call: unknown): call is string => typeof call === "string")
            : []
          const functionInfo: MinimalFunctionInfo = {
            id: record.id,
            name: record.name,
            calls,
          }
          if (typeof record.file_path === "string") {
            functionInfo.filePath = record.file_path
          }
          return functionInfo
        })
        .filter((item): item is MinimalFunctionInfo => item !== null)
    : []
}

function loadStage03ChunkFunctions(
  directory: string,
  chunkRefs: unknown,
): MinimalFunctionInfo[] {
  if (!Array.isArray(chunkRefs)) return []

  const loaded: MinimalFunctionInfo[] = []
  for (const chunkRef of chunkRefs) {
    if (typeof chunkRef?.file_path !== "string") continue
    const chunkPath = join(directory, chunkRef.file_path)
    if (!existsSync(chunkPath)) continue
    try {
      const raw = readFileSync(chunkPath, "utf-8")
      const parsed = JSON.parse(raw) as {
        functions?: Array<{
          id?: unknown
          name?: unknown
          file_path?: unknown
          calls?: unknown
        }>
      }
      loaded.push(...parseMinimalFunctions(parsed.functions))
    } catch {
      continue
    }
  }
  return loaded
}

function summarizeWikiArtifact(raw: string, normalizedPath: string): string | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, any>

    if (normalizedPath.includes("/functions/")) {
      const name =
        typeof parsed.name === "string" ? parsed.name : normalizedPath.split("/").pop()?.replace(/\.json$/, "")
      const summary = typeof parsed.summary === "string" ? parsed.summary : "No summary available."
      const signature = typeof parsed.signature === "string" ? parsed.signature : "unknown signature"
      return `### Preloaded Function Wiki: ${name}\n- Path: ${normalizedPath}\n- Signature: ${signature}\n- Summary: ${summary}`
    }

    if (normalizedPath.includes("/modules/")) {
      const name =
        typeof parsed.name === "string" ? parsed.name : normalizedPath.split("/").pop()?.replace(/\.json$/, "")
      const summary =
        typeof parsed.summary === "string"
          ? parsed.summary
          : typeof parsed.responsibility === "string"
            ? parsed.responsibility
            : "No summary available."
      return `### Preloaded Module Wiki: ${name}\n- Path: ${normalizedPath}\n- Summary: ${summary}`
    }
  } catch {
    return `### Preloaded Wiki Artifact\n- Path: ${normalizedPath}\n- Note: Artifact exists but could not be summarized as JSON.`
  }

  return null
}

function preloadDependencyContext(
  directory: string,
  promptText: string,
  sessionReadPaths: Set<string>,
) {
  const cycleInfo = loadFunctionCycleInfo(
    directory,
    extractPromptToken(promptText, "function_id"),
  )
  const referencedPaths = extractWikiArtifactPaths(promptText)
  const preloadedSummaries: string[] = []
  const missingPaths: string[] = []
  const cycleDeferredPaths: string[] = []

  for (const path of referencedPaths) {
    const absolutePath = join(directory, path)
    if (!existsSync(absolutePath)) {
      if (cycleInfo.exemptWikiPaths.has(path)) {
        cycleDeferredPaths.push(path)
      } else {
        missingPaths.push(path)
      }
      continue
    }

    sessionReadPaths.add(path)

    const raw = readFileSync(absolutePath, "utf-8")
    const summary = summarizeWikiArtifact(raw, path)
    if (summary) {
      preloadedSummaries.push(summary)
    }
  }

  return { preloadedSummaries, missingPaths, cycleDeferredPaths }
}

function buildExistingFunctionWikiSkipMessage(
  directory: string,
  agent: string | undefined,
  promptText: string,
): string | null {
  if (agent !== "wiki-executor") return null
  if (!promptText.includes("wiki_mode=function-analysis")) return null

  const scheduledPath =
    extractPromptToken(promptText, "function_wiki_path") ??
    (() => {
      const functionName = extractPromptToken(promptText, "function_name")
      return functionName ? `.matrix/wiki/functions/${functionName}.json` : null
    })()

  if (!scheduledPath) return null

  const normalizedPath = normalizeWikiArtifactPath(scheduledPath)
  const absolutePath = join(directory, normalizedPath)
  if (!existsSync(absolutePath)) return null
  try {
    const parsed = FunctionWiki.safeParse(JSON.parse(readFileSync(absolutePath, "utf-8")))
    if (!parsed.success) return null
  } catch {
    return null
  }
  return (
    `<wiki-existing-function-artifact>\n` +
    `A schema-valid function wiki with parameters and return_value already exists at ${normalizedPath} for this scheduled function-analysis turn.\n` +
    `You MUST skip regeneration, do NOT read source code for this function, do NOT rewrite ${normalizedPath}, and report that the existing artifact was reused.\n` +
    `</wiki-existing-function-artifact>`
  )
}

export function createWikiBottomUpEnforcerHook(directory: string) {
  return {
    "chat.message": async (
      input: { sessionID: string; agent?: string },
      output: { message: any; parts: any[] },
    ) => {
      if (!input.agent || !WIKI_PHASE_AGENTS.has(input.agent)) return
      const sessionReadPaths = resetSessionReadSet(input.sessionID)
      const promptText = collectTextParts(output.parts)
      const { preloadedSummaries, missingPaths, cycleDeferredPaths } = preloadDependencyContext(
        directory,
        promptText,
        sessionReadPaths,
      )

      const injectedParts = [{ type: "text", text: WIKI_BOTTOM_UP_REMINDER }]
      const existingFunctionWikiSkipMessage = buildExistingFunctionWikiSkipMessage(
        directory,
        input.agent,
        promptText,
      )

      if (existingFunctionWikiSkipMessage) {
        injectedParts.push({
          type: "text",
          text: existingFunctionWikiSkipMessage,
        })
      }

      if (preloadedSummaries.length > 0) {
        injectedParts.push({
          type: "text",
          text:
            `<wiki-preloaded-dependencies>\n` +
            `The hook auto-loaded dependency wiki context for this turn. Treat these artifacts as already loaded; do not re-read them unless you truly need more detail.\n\n` +
            preloadedSummaries.join("\n\n") +
            `\n</wiki-preloaded-dependencies>`,
        })
      }

      if (missingPaths.length > 0) {
        injectedParts.push({
          type: "text",
          text:
            `<wiki-missing-dependencies>\n` +
            `The hook could not preload these dependency wiki artifacts because they do not exist yet:\n` +
            missingPaths.map((path) => `- ${path}`).join("\n") +
            `\nThese are not part of any detected cycle, so reschedule those lower-layer artifacts before proceeding.\n` +
            `</wiki-missing-dependencies>`,
        })
      }

      if (cycleDeferredPaths.length > 0) {
        injectedParts.push({
          type: "text",
          text:
            `<wiki-cycle-dependencies>\n` +
            `These dependency wiki artifacts are missing, but they belong to the same detected function-level or module-level cycle as the current target:\n` +
            cycleDeferredPaths.map((path) => `- ${path}`).join("\n") +
            `\nYou may continue this function-analysis turn without those missing callee wiki files. When describing the function, note that cyclic callees were not yet grounded from wiki artifacts in this turn.\n` +
            `</wiki-cycle-dependencies>`,
        })
      }

      output.parts = [...injectedParts, ...output.parts]
    },

    "tool.execute.after": async (
      input: { tool: string; sessionID: string },
      output: { title: string; output: string; metadata: any },
    ) => {
      const sessionReadPaths = getOrCreateSessionReadSet(input.sessionID)
      const combinedText = `${output.title || ""}\n${output.output || ""}`

      if (input.tool === "read" || input.tool === "repo_read") {
        for (const path of extractWikiArtifactPaths(combinedText)) {
          sessionReadPaths.add(path)
        }
        return
      }

      if (input.tool !== "write") return
      if (!combinedText.includes(".matrix/wiki/")) return

      const analysis = loadSoftwareAnalysis(directory)
      if (!analysis) return

      const normalizedOutput = normalizeWikiArtifactPath(combinedText)

      if (isNestedFunctionWikiPath(normalizedOutput)) {
        appendGuardMessage(
          output,
          "Function wiki JSON must be written directly under .matrix/wiki/functions/. Do not generate module or functional subdirectories such as .matrix/wiki/functions/<module>/<function>.json.",
        )
        return
      }

      const moduleWriteMatch = normalizedOutput.match(
        /\.matrix\/wiki\/modules\/([^/\s]+)\.json/,
      )
      if (moduleWriteMatch) {
        const moduleName = moduleWriteMatch[1]
        const validation = validateModuleDependencyContext(
          analysis,
          moduleName,
          sessionReadPaths,
          directory,
        )

        if (validation.missingArtifacts.length > 0) {
          appendGuardMessage(
            output,
            `Topological order violation for module "${moduleName}". Lower-layer dependency wiki artifacts do not exist yet: ${validation.missingArtifacts.join(", ")}. Analyze those lower-layer modules first, then come back to "${moduleName}".`,
          )
          return
        }

        if (validation.missingReads.length > 0) {
          appendGuardMessage(
            output,
            `Module "${moduleName}" depends on lower-layer modules [${validation.dependencyModules.join(", ")}], but this session did not use read to load their wiki files before writing the upper-layer module. Required reads: ${validation.missingReads.join(", ")}. Read those files and rewrite .matrix/wiki/modules/${moduleName}.json.`,
          )
          return
        }
      }

      const functionWriteMatch = normalizedOutput.match(
        /\.matrix\/wiki\/functions\/([^\s]+)\.json/,
      )
      if (functionWriteMatch) {
        const functionRef = functionWriteMatch[1]
        const targetFunction = findFunctionByArtifactReference(analysis, functionRef)

        if (isIdBasedFunctionWikiPath(analysis, functionRef) && targetFunction) {
          appendGuardMessage(
            output,
            `Function wiki JSON must use the function name as the file name. Write .matrix/wiki/functions/${targetFunction.name}.json instead of .matrix/wiki/functions/${targetFunction.id}.json.`,
          )
          return
        }

        const validation = validateFunctionDependencyContext(
          analysis,
          functionRef,
          sessionReadPaths,
          directory,
        )

        if (validation.missingContexts.length > 0) {
          const missingDescriptions = validation.missingContexts.map((dep) => {
            const functionWikiPaths = getExistingFunctionWikiPaths(directory, {
              id: dep.calleeId,
              name: dep.calleeName,
            })
            const functionWikiPath =
              functionWikiPaths.length > 0
                ? functionWikiPaths.join(" or ")
                : getFunctionWikiPathCandidates({
                    id: dep.calleeId,
                    name: dep.calleeName,
                  }).join(" or ")
            const moduleWikiPath = `.matrix/wiki/modules/${dep.moduleName}.json`
            return dep.sameModule
              ? `${dep.calleeName} (${functionWikiPath})`
              : `${dep.calleeName} (${functionWikiPath} or ${moduleWikiPath})`
          })

          appendGuardMessage(
            output,
            `Function "${functionRef}" was written without loading lower-layer callee context via read. Missing dependency context: ${missingDescriptions.join(", ")}. Read the corresponding lower-layer function/module wiki first, then rewrite .matrix/wiki/functions/${targetFunction?.name ?? functionRef}.json.`,
          )
        }
      }
    },
  }
}
