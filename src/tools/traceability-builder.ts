import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, isAbsolute, resolve } from "path"
import { z } from "zod"
import { CompilationEnvironment } from "../schema/compilation"
import {
  SoftwareAnalysisStage02Payload,
  SoftwareAnalysisStage03FunctionChunk,
  SoftwareAnalysisStage03Payload,
  SoftwareAnalysisStage05Payload,
  SoftwareAnalysisStageArtifact,
} from "../schema/software-analysis-stage"
import { FunctionInfo, RuntimeEnvironment } from "../schema/sut"
import { ARTIFACT_PATHS } from "../shared/constants"

const TraceabilityLinkOverride = z.object({
  function_id: z.string().optional(),
  function_name: z.string().optional(),
  requirement_ids: z.array(z.string()).default([]),
}).refine(
  (value) => Boolean(value.function_id || value.function_name),
  { message: "Each link override must include function_id or function_name." },
)

function resolveProjectPath(relativePath: string): string {
  return resolve(process.cwd(), relativePath)
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

function readStageArtifact<TStageId extends "02-requirements" | "03-code">(
  stageId: TStageId,
  filePath: string,
): Extract<z.infer<typeof SoftwareAnalysisStageArtifact>, { stage_id: TStageId }> {
  if (!existsSync(filePath)) {
    throw new Error(`Missing required stage artifact: ${filePath}`)
  }
  const parsed = SoftwareAnalysisStageArtifact.safeParse(readJsonFile(filePath))
  if (!parsed.success) {
    throw new Error(`Invalid stage artifact ${filePath}: ${parsed.error.message}`)
  }
  if (parsed.data.stage_id !== stageId) {
    throw new Error(`Stage artifact ${filePath} has mismatched stage_id ${parsed.data.stage_id}`)
  }
  return parsed.data as Extract<z.infer<typeof SoftwareAnalysisStageArtifact>, { stage_id: TStageId }>
}

function readStage03Functions(payload: z.infer<typeof SoftwareAnalysisStage03Payload>): z.infer<typeof FunctionInfo>[] {
  const functions = [...payload.functions]
  for (const chunkRef of payload.function_chunks) {
    const chunkPath = resolveProjectPath(chunkRef.file_path)
    if (!existsSync(chunkPath)) {
      throw new Error(`Missing stage 03 function chunk: ${chunkRef.file_path}`)
    }
    const parsedChunk = SoftwareAnalysisStage03FunctionChunk.safeParse(readJsonFile(chunkPath))
    if (!parsedChunk.success) {
      throw new Error(`Invalid stage 03 function chunk ${chunkRef.file_path}: ${parsedChunk.error.message}`)
    }
    functions.push(...parsedChunk.data.functions)
  }
  return functions
}

function detectProgrammingLanguage(functions: z.infer<typeof FunctionInfo>[], compilationEnv?: z.infer<typeof CompilationEnvironment>): string | undefined {
  if (compilationEnv?.compiler_dialect) {
    const dialect = compilationEnv.compiler_dialect.toLowerCase()
    if (dialect.includes("c++") || dialect.includes("cpp")) return "C++"
    if (dialect.includes("c")) return "C"
  }

  const hasCpp = functions.some((fn) => /\.(cpp|hpp|cc|cxx)$/i.test(fn.file_path))
  const hasC = functions.some((fn) => /\.(c|h)$/i.test(fn.file_path))
  if (hasCpp) return "C++"
  if (hasC) return "C"
  return undefined
}

function inferInterruptTable(functions: z.infer<typeof FunctionInfo>[]) {
  return functions
    .filter((fn) => /(?:isr|irq|interrupt|handler)/i.test(fn.name))
    .map((fn) => ({
      name: fn.name,
      handler_function: fn.id,
    }))
}

function buildMainFunctionsSummary(
  functions: z.infer<typeof FunctionInfo>[],
  runtimeEnvironment: z.infer<typeof RuntimeEnvironment>,
): string {
  const mainFunction = functions.find((fn) => fn.name === "main")
  const initCalls = mainFunction
    ? mainFunction.calls.filter((call) => /init|setup|config/i.test(call)).slice(0, 5)
    : []
  const interruptCount = runtimeEnvironment.interrupt_table.length
  const interruptPhrase = interruptCount > 0
    ? `${interruptCount} interrupt handler(s) are recorded in runtime_environment.`
    : "No interrupt handlers were structurally identified."

  if (mainFunction) {
    const initPhrase = initCalls.length > 0
      ? `Before entering the main loop, main() calls initialization routines such as ${initCalls.join(", ")}.`
      : "The main() function acts as the primary entry point and coordinates initialization before entering the main loop."
    return `${initPhrase} ${interruptPhrase}`.trim()
  }

  return `No main() function was identified in the analyzed function set. ${interruptPhrase}`.trim()
}

function normalizeRuntimeEnvironment(
  runtimeEnvironmentInput: unknown,
  functions: z.infer<typeof FunctionInfo>[],
  compilationEnv?: z.infer<typeof CompilationEnvironment>,
): z.infer<typeof RuntimeEnvironment> {
  const provided = runtimeEnvironmentInput === undefined
    ? undefined
    : RuntimeEnvironment.parse(runtimeEnvironmentInput)
  const inferredInterruptTable = provided?.interrupt_table.length
    ? provided.interrupt_table
    : inferInterruptTable(functions)

  return RuntimeEnvironment.parse({
    ...provided,
    target_cpu: provided?.target_cpu ?? compilationEnv?.target_cpu,
    programming_language: provided?.programming_language ?? detectProgrammingLanguage(functions, compilationEnv),
    interrupt_table: inferredInterruptTable,
    io_interfaces_summary: provided?.io_interfaces_summary ?? [],
  })
}

export const traceabilityBuilder: ToolDefinition = tool({
  description:
    "Build the large stage-05 traceability payload on the tool side from staged requirements/code artifacts, " +
    "then write it to a JSON file so the model does not need to serialize large traceability arrays.",
  args: {
    requirements_file: tool.schema
      .string()
      .optional()
      .describe("Optional path to the stage-02 requirements artifact. Defaults to .matrix/data/software-analysis-stage-02-requirements.json."),
    code_stage_file: tool.schema
      .string()
      .optional()
      .describe("Optional path to the stage-03 code artifact. Defaults to .matrix/data/software-analysis-stage-03-code.json."),
    compilation_env_file: tool.schema
      .string()
      .optional()
      .describe("Optional path to compilation-env.json for target/runtime hints. Defaults to .matrix/data/compilation-env.json when present."),
    output_file: tool.schema
      .string()
      .optional()
      .describe("Optional output path for the generated stage-05 payload. Defaults to .matrix/data/software-analysis-stage-05-traceability-tool.json."),
    runtime_environment: tool.schema
      .object({})
      .passthrough()
      .optional()
      .describe("Optional small runtime_environment override object. Use this for analyst-provided ISR or platform hints without hand-writing the large traceability arrays."),
    runtime_environment_file: tool.schema
      .string()
      .optional()
      .describe("Optional JSON file containing runtime_environment. This is useful when another tool prepared runtime metadata on disk."),
    main_functions_summary: tool.schema
      .string()
      .optional()
      .describe("Optional small summary for main()/entry-point behavior. If omitted, the tool synthesizes a compact summary."),
    link_overrides: tool.schema
      .array(
        tool.schema.object({
          function_id: tool.schema.string().optional(),
          function_name: tool.schema.string().optional(),
          requirement_ids: tool.schema.array(tool.schema.string()),
        }).passthrough(),
      )
      .optional()
      .describe("Optional sparse function-to-requirement override links. Use this to add or correct mappings without hand-writing the full traceability matrix."),
    link_overrides_file: tool.schema
      .string()
      .optional()
      .describe("Optional JSON file containing sparse link_overrides."),
  },
  async execute({
    requirements_file,
    code_stage_file,
    compilation_env_file,
    output_file,
    runtime_environment,
    runtime_environment_file,
    main_functions_summary,
    link_overrides,
    link_overrides_file,
  }) {
    try {
      const requirementsPath = resolveUserPath(requirements_file ?? ARTIFACT_PATHS.SOFTWARE_ANALYSIS_STAGE_02_REQUIREMENTS)
      const codeStagePath = resolveUserPath(code_stage_file ?? ARTIFACT_PATHS.SOFTWARE_ANALYSIS_STAGE_03_CODE)
      const outputPath = resolveUserPath(output_file ?? ARTIFACT_PATHS.SOFTWARE_ANALYSIS_STAGE_05_TRACEABILITY_TOOL)

      const stage02 = readStageArtifact("02-requirements", requirementsPath)
      const stage03 = readStageArtifact("03-code", codeStagePath)
      const functions = readStage03Functions(stage03.payload)

      const compilationEnvPath = resolveUserPath(compilation_env_file ?? ARTIFACT_PATHS.COMPILATION_ENV)
      const compilationEnv = existsSync(compilationEnvPath)
        ? CompilationEnvironment.parse(readJsonFile(compilationEnvPath))
        : undefined

      const runtimeEnvironmentInput = runtime_environment_file
        ? readJsonFile(resolveUserPath(runtime_environment_file))
        : runtime_environment
      const normalizedRuntimeEnvironment = normalizeRuntimeEnvironment(runtimeEnvironmentInput, functions, compilationEnv)

      const parsedOverrides = link_overrides_file
        ? z.array(TraceabilityLinkOverride).parse(readJsonFile(resolveUserPath(link_overrides_file)))
        : z.array(TraceabilityLinkOverride).parse(link_overrides ?? [])

      const functionById = new Map(functions.map((fn) => [fn.id, fn]))
      const functionByName = new Map(functions.map((fn) => [fn.name, fn]))
      const requirementIds = new Set(stage02.payload.requirements.map((requirement) => requirement.id))
      const requirementToFunctions = new Map<string, Set<string>>()
      const functionToRequirements = new Map<string, Set<string>>()

      const linkFunctionToRequirement = (functionId: string, requirementId: string) => {
        if (!requirementIds.has(requirementId)) {
          throw new Error(`Traceability override references unknown requirement "${requirementId}"`)
        }
        const functionRequirements = functionToRequirements.get(functionId) ?? new Set<string>()
        functionRequirements.add(requirementId)
        functionToRequirements.set(functionId, functionRequirements)

        const implementingFunctions = requirementToFunctions.get(requirementId) ?? new Set<string>()
        implementingFunctions.add(functionId)
        requirementToFunctions.set(requirementId, implementingFunctions)
      }

      for (const fn of functions) {
        for (const requirementId of fn.related_requirements) {
          linkFunctionToRequirement(fn.id, requirementId)
        }
      }

      for (const override of parsedOverrides) {
        const fn = override.function_id
          ? functionById.get(override.function_id)
          : override.function_name
            ? functionByName.get(override.function_name)
            : undefined
        if (!fn) {
          throw new Error(
            `Traceability override references unknown function "${override.function_id ?? override.function_name ?? "unknown"}"`,
          )
        }
        for (const requirementId of override.requirement_ids) {
          linkFunctionToRequirement(fn.id, requirementId)
        }
      }

      const traceabilityMatrix = stage02.payload.requirements
        .map((requirement) => {
          const functionIds = Array.from(requirementToFunctions.get(requirement.id) ?? []).sort()
          return functionIds.length > 0 ? { req_id: requirement.id, function_ids: functionIds } : null
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)

      const gapAnalysis = stage02.payload.requirements
        .filter((requirement) => !requirementToFunctions.has(requirement.id))
        .map((requirement) => ({
          req_id: requirement.id,
          reason: "No implementing functions were structurally linked in stage 03 traceability data.",
        }))

      const orphanAnalysis = functions
        .filter((fn) => (functionToRequirements.get(fn.id)?.size ?? 0) === 0)
        .map((fn) => ({
          function_id: fn.id,
          function_name: fn.name,
          file_path: fn.file_path,
        }))

      const payload = SoftwareAnalysisStage05Payload.parse({
        traceability_matrix: traceabilityMatrix,
        gap_analysis: gapAnalysis,
        orphan_analysis: orphanAnalysis,
        runtime_environment: normalizedRuntimeEnvironment,
        main_functions_summary: main_functions_summary ?? buildMainFunctionsSummary(functions, normalizedRuntimeEnvironment),
      })

      ensureDir(outputPath)
      writeFileSync(outputPath, JSON.stringify(payload, null, 2), "utf-8")

      return JSON.stringify({
        status: "success",
        action: "built_traceability_payload",
        output_file: outputPath,
        summary: {
          requirements: stage02.payload.requirements.length,
          functions: functions.length,
          traceability_entries: payload.traceability_matrix.length,
          gaps: payload.gap_analysis.length,
          orphans: payload.orphan_analysis.length,
          interrupt_count: payload.runtime_environment?.interrupt_table.length ?? 0,
        },
      })
    } catch (error) {
      return JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      })
    }
  },
})
