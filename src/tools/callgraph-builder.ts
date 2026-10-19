import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, isAbsolute, resolve } from "path"
import { CallGraph } from "../schema/callgraph"
import {
  SoftwareAnalysisStage03FunctionChunk,
  SoftwareAnalysisStageArtifact,
} from "../schema/software-analysis-stage"
import { ARTIFACT_PATHS } from "../shared/constants"

type CallgraphFunction = {
  name: string
  calls: string[]
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

function toCallgraphFunctions(
  items: Array<{ name: string; calls: string[] }>,
): CallgraphFunction[] {
  return items.map((item) => ({
    name: item.name,
    calls: [...item.calls],
  }))
}

function loadStage03Functions(stage03FilePath: string): CallgraphFunction[] {
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
  if (payload.function_index.length > 0) {
    return toCallgraphFunctions(payload.function_index)
  }
  if (payload.functions.length > 0) {
    return toCallgraphFunctions(payload.functions)
  }

  const functions: CallgraphFunction[] = []
  for (const chunkRef of payload.function_chunks) {
    const chunkPath = resolveUserPath(chunkRef.file_path)
    if (!existsSync(chunkPath)) {
      throw new Error(`Missing stage-03 function chunk: ${chunkRef.file_path}`)
    }

    const parsedChunk = SoftwareAnalysisStage03FunctionChunk.safeParse(readJsonFile(chunkPath))
    if (!parsedChunk.success) {
      throw new Error(`Invalid stage-03 function chunk ${chunkRef.file_path}: ${parsedChunk.error.message}`)
    }

    functions.push(...toCallgraphFunctions(parsedChunk.data.functions))
  }

  return functions
}

function buildCallGraph(functions: CallgraphFunction[]) {
  const merged = new Map<string, Set<string>>()

  for (const fn of functions) {
    const callees = merged.get(fn.name) ?? new Set<string>()
    merged.set(fn.name, callees)
    for (const callee of fn.calls) {
      callees.add(callee)
    }
  }

  const callGraph = Object.fromEntries(
    [...merged.keys()]
      .sort((left, right) => left.localeCompare(right))
      .map((caller) => [caller, [...(merged.get(caller) ?? [])].sort((left, right) => left.localeCompare(right))]),
  )

  return CallGraph.parse(callGraph)
}

export const callgraphBuilder: ToolDefinition = tool({
  description:
    "Build a function call graph from the stage-03 software analysis artifact. " +
    "Reads .matrix/data/software-analysis-stage-03-code.json by default and writes " +
    "a caller-to-callee map to .matrix/data/callgraph.json.",
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
        "Path to write the generated call graph JSON. Defaults to .matrix/data/callgraph.json.",
      ),
  },
  async execute(args = {}) {
    const {
      stage03_file = ARTIFACT_PATHS.SOFTWARE_ANALYSIS_STAGE_03_CODE,
      output_file = ARTIFACT_PATHS.CALLGRAPH,
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

      const functions = loadStage03Functions(stage03FilePath)
      const callGraph = buildCallGraph(functions)

      ensureDir(outputFilePath)
      writeFileSync(outputFilePath, JSON.stringify(callGraph, null, 2), "utf-8")

      const edgeCount = Object.values(callGraph).reduce((sum, callees) => sum + callees.length, 0)
      return JSON.stringify({
        status: "success",
        stage03_file,
        output_file,
        caller_count: Object.keys(callGraph).length,
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
