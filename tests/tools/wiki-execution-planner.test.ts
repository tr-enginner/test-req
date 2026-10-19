import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { dirname, join } from "path"
import { WikiExecutionState, WikiExecutionStepArtifact, WikiGenerationPlan, WikiIndex } from "../../src/schema/wiki"
import { wikiExecutionPlanner } from "../../src/tools/wiki-execution-planner"

const TEMP_DIRS: string[] = []
const ORIGINAL_CWD = process.cwd()

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2), "utf-8")
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T
}

function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), "wiki-execution-planner-"))
  TEMP_DIRS.push(dir)
  mkdirSync(join(dir, ".matrix", "plans"), { recursive: true })
  mkdirSync(join(dir, ".matrix", "wiki", "functions"), { recursive: true })
  mkdirSync(join(dir, ".matrix", "wiki", "modules"), { recursive: true })
  mkdirSync(join(dir, ".matrix", "data"), { recursive: true })
  process.chdir(dir)
  return dir
}

function writeSoftwareAnalysis(root: string, totalFunctions: number, moduleName = "shell") {
  writeJson(join(root, ".matrix", "data", "software-analysis.json"), {
    project_name: "Planner Test",
    version: "1.0",
    created_date: "2026-04-02T00:00:00.000Z",
    requirements: [],
    interfaces: [],
    data_flow_graph: { nodes: [], edges: [] },
    functions: Array.from({ length: totalFunctions }, (_, index) => ({
      id: `FUNC-${String(index + 1).padStart(3, "0")}`,
      name: `fn${String(index + 1).padStart(3, "0")}`,
      file_path: `src/${moduleName}.c`,
      line_range: { start: index * 5 + 1, end: index * 5 + 4 },
      return_type: "void",
      parameters: [],
      calls: [],
      called_by: [],
      safety_critical: false,
      related_requirements: [],
    })),
    modules: [{ name: moduleName, path: `src/${moduleName}.c`, functions: Array.from({ length: totalFunctions }, (_, index) => `FUNC-${String(index + 1).padStart(3, "0")}`) }],
    summary: {
      total_functions: totalFunctions,
      total_loc: totalFunctions * 5,
      total_requirements: 0,
      total_interfaces: 0,
      safety_critical_functions: 0,
    },
  })
}

function buildPlan(totalFunctions: number, moduleName = "shell") {
  const perModuleOrder: Record<string, string[]> = {
    [moduleName]: [],
  }
  const perFunctionNames: Record<string, string> = {}
  const perFunctionWikiPaths: Record<string, string> = {}
  const perFunctionSourceLocations: Record<string, { file_path: string; line_range: { start: number; end: number } }> = {}
  const perFunctionDirectCallees: Record<string, string[]> = {}
  const perFunctionDependencyWikiPaths: Record<string, string[]> = {}
  const perFunctionInterfaces: Record<string, { return_type: string; parameters: Array<{ name: string; type: string }> }> = {}
  const reusableFunctionWikiPaths: Record<string, string> = {}
  const skippedFunctionDispatches: Array<{ function_name: string; module_name: string; wiki_path: string; reason: string }> = []

  for (let index = 0; index < totalFunctions; index++) {
    const functionId = `FUNC-${String(index + 1).padStart(3, "0")}`
    const functionName = `fn${String(index + 1).padStart(3, "0")}`
    perModuleOrder[moduleName].push(functionId)
    perFunctionNames[functionId] = functionName
    perFunctionWikiPaths[functionId] = `.matrix/wiki/functions/${functionName}.json`
    perFunctionSourceLocations[functionId] = {
      file_path: `src/${moduleName}.c`,
      line_range: { start: index * 5 + 1, end: index * 5 + 4 },
    }
    perFunctionDirectCallees[functionId] = index === 0 ? [] : [`FUNC-${String(index).padStart(3, "0")}`]
    perFunctionDependencyWikiPaths[functionId] = index === 0 ? [] : [`.matrix/wiki/functions/fn${String(index).padStart(3, "0")}.json`]
    perFunctionInterfaces[functionId] = {
      return_type: index % 2 === 0 ? "void" : "int",
      parameters: index % 2 === 0 ? [] : [{ name: "value", type: "int" }],
    }
    if (index < 40) {
      reusableFunctionWikiPaths[functionId] = `.matrix/wiki/functions/${functionName}.json`
      skippedFunctionDispatches.push({
        function_name: functionName,
        module_name: moduleName,
        wiki_path: `.matrix/wiki/functions/${functionName}.json`,
        reason: "reused_existing_artifact",
      })
    }
  }

  return WikiGenerationPlan.parse({
    artifact_type: "wiki-generation-plan",
    created_date: "2026-04-02T03:30:00.000Z",
    project: {
      project_name: "Planner Test",
      total_functions: totalFunctions,
      total_modules: 1,
    },
    reused_data_structures_wiki: false,
    module_order: [moduleName],
    detected_cycles: [],
    dependency_requirements: {
      [moduleName]: {
        module_dependencies: [],
        required_lower_layer_paths: [],
      },
    },
    per_module_function_order: perModuleOrder,
    per_function_names: perFunctionNames,
    per_function_direct_callees: perFunctionDirectCallees,
    per_function_dependency_wiki_paths: perFunctionDependencyWikiPaths,
    per_function_source_locations: perFunctionSourceLocations,
    per_function_interfaces: perFunctionInterfaces,
    per_function_wiki_paths: perFunctionWikiPaths,
    reusable_function_wiki_paths: reusableFunctionWikiPaths,
    skipped_function_dispatches: skippedFunctionDispatches,
  })
}

function writePlan(root: string, totalFunctions: number, moduleName = "shell") {
  const plan = buildPlan(totalFunctions, moduleName)
  writeJson(join(root, ".matrix", "plans", "wiki-generation-plan.json"), plan)
  return plan
}

function writeFunctionWiki(root: string, functionName: string) {
  writeJson(join(root, ".matrix", "wiki", "functions", `${functionName}.json`), {
    id: `wiki-${functionName}`,
    name: functionName,
    file_path: "src/shell.c",
    line_range: { start: 1, end: 2 },
    module_id: "mod_shell",
    signature: `void ${functionName}(void)`,
    parameters: [],
    return_value: {
      type: "void",
      description: `${functionName} does not return a direct value.`,
    },
    summary: `${functionName} summary`,
    control_flow: { branches: 0, loops: 0, early_returns: 0, description: "simple" },
    testing_hints: { suggested_focus: [], stubbing_needs: [] },
    preconditions: [],
    postconditions: [],
    boundary_conditions: [],
    error_handling: [],
    side_effects: [],
    requirement_fulfillment: [],
  })
}

function writeLegacyFunctionWiki(root: string, functionName: string) {
  writeJson(join(root, ".matrix", "wiki", "functions", `${functionName}.json`), {
    id: `wiki-${functionName}`,
    name: functionName,
    file_path: "src/shell.c",
    line_range: { start: 1, end: 2 },
    module_id: "mod_shell",
    signature: `void ${functionName}(void)`,
    summary: `${functionName} legacy summary`,
    control_flow: { branches: 0, loops: 0, early_returns: 0, description: "simple" },
    testing_hints: { suggested_focus: [], stubbing_needs: [] },
    preconditions: [],
    postconditions: [],
    boundary_conditions: [],
    error_handling: [],
    side_effects: [],
    requirement_fulfillment: [],
  })
}

function writeModuleWiki(root: string, moduleName = "shell") {
  writeJson(join(root, ".matrix", "wiki", "modules", `${moduleName}.json`), {
    id: `mod_${moduleName}`,
    name: moduleName,
    files: [`src/${moduleName}.c`],
    responsibility: `${moduleName} responsibility`,
    design_rationale: `${moduleName} rationale`,
    public_interface: [],
    internal_functions: [],
    dependencies: [],
    dependents: [],
    state_machines: [],
    hardware_interactions: [],
    invariants: [],
    complexity_notes: [],
  })
}

function writeIndex(root: string, totalFunctions: number, moduleName = "shell") {
  const functionIndex = Object.fromEntries(
    Array.from({ length: totalFunctions }, (_, index) => {
      const functionName = `fn${String(index + 1).padStart(3, "0")}`
      return [
        functionName,
        {
          id: `FUNC-${String(index + 1).padStart(3, "0")}`,
          module_id: `mod_${moduleName}`,
          file_path: `src/${moduleName}.c`,
          safety_critical: false,
        },
      ]
    }),
  )

  writeJson(join(root, ".matrix", "wiki", "index.json"), WikiIndex.parse({
    project_name: "Planner Test",
    version: "1.0",
    created_date: "2026-04-02T03:30:00.000Z",
    overview: "overview",
    tech_stack: {
      language: "C",
      compiler_dialect: "C99",
      target_cpu: "generic",
      frameworks: [],
    },
    architecture: {
      pattern: "layered",
      description: "desc",
      layers: [],
    },
    modules: [
      {
        id: `mod_${moduleName}`,
        name: moduleName,
        files: [`src/${moduleName}.c`],
        description: `${moduleName} responsibility`,
        function_count: totalFunctions,
        safety_critical: false,
      },
    ],
    function_index: functionIndex,
    function_index_chunks: [],
    data_structures: [],
    data_flow_paths: [],
  }))
}

async function nextStep() {
  const toolImpl = wikiExecutionPlanner as unknown as {
    execute: (args: { mode: "next_step" }) => Promise<string>
  }
  return JSON.parse(await toolImpl.execute({ mode: "next_step" }))
}

afterEach(() => {
  process.chdir(ORIGINAL_CWD)
  for (const dir of TEMP_DIRS.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("wikiExecutionPlanner", () => {
  test("returns data-structures when the existing artifact still has legacy description fields", async () => {
    const root = makeWorkspace()
    writeSoftwareAnalysis(root, 1)
    writePlan(root, 1)
    writeJson(join(root, ".matrix", "wiki", "data-structures.json"), {
      project_name: "Planner Test",
      created_date: "2026-04-02T03:30:00.000Z",
      structures: [
        {
          name: "Legacy",
          file_path: "src/types.h",
          line_range: { start: 1, end: 2 },
          kind: "struct",
          description: "legacy prose",
          fields: [{ name: "value", type: "int", description: "legacy field prose" }],
          used_by_functions: [],
          used_by_modules: [],
        },
      ],
    })

    const result = await nextStep()
    expect(result.status).toBe("success")
    expect(result.next_step.kind).toBe("data-structures")
  })

  test("returns data-structures when the artifact predates the bucketed schema", async () => {
    const root = makeWorkspace()
    writeSoftwareAnalysis(root, 1)
    writePlan(root, 1)
    writeJson(join(root, ".matrix", "wiki", "data-structures.json"), {
      project_name: "Planner Test",
      created_date: "2026-04-02T03:30:00.000Z",
      structures: [],
    })

    const result = await nextStep()
    expect(result.status).toBe("success")
    expect(result.next_step.kind).toBe("data-structures")
  })

  test("keeps returning the next missing function while any function wiki is still absent", async () => {
    const root = makeWorkspace()
    writeSoftwareAnalysis(root, 205)
    writePlan(root, 205)
    writeJson(join(root, ".matrix", "wiki", "data-structures.json"), {
      schema_version: 3,
      project_name: "Planner Test",
      created_date: "2026-04-02T03:30:00.000Z",
    })
    for (let index = 0; index < 40; index++) {
      writeFunctionWiki(root, `fn${String(index + 1).padStart(3, "0")}`)
    }

    const result = await nextStep()
    expect(result.status).toBe("success")
    expect(result.next_step.kind).toBe("function-analysis")
    expect(result.next_step.function_id).toBe("FUNC-041")
    expect(result.next_step.function_name).toBe("fn041")
    expect(result.state_summary.pending_functions).toBe(165)

    const stepArtifact = WikiExecutionStepArtifact.parse(
      readJson(join(root, ".matrix", "state", "wiki-next-step.json")),
    )
    expect(stepArtifact.step.kind).toBe("function-analysis")
    if (stepArtifact.step.kind === "function-analysis") {
      expect(stepArtifact.step.function_return_type).toBe("void")
      expect(stepArtifact.step.function_parameters).toEqual([])
    }

    const state = WikiExecutionState.parse(readJson(join(root, ".matrix", "state", "wiki-execution-state.json")))
    expect(state.completed_functions).toBe(40)
    expect(state.reused_functions).toBe(40)
    expect(state.pending_functions).toBe(165)
    expect(state.last_dispatched_step?.kind).toBe("function-analysis")
    expect(state.last_dispatched_step?.step_file).toBe(".matrix/state/wiki-next-step.json")
  })

  test("does not return complete or module/global synthesis when only part of the function inventory exists", async () => {
    const root = makeWorkspace()
    writeSoftwareAnalysis(root, 459)
    writePlan(root, 459)
    writeJson(join(root, ".matrix", "wiki", "data-structures.json"), {
      schema_version: 3,
      project_name: "Planner Test",
      created_date: "2026-04-02T03:30:00.000Z",
    })
    for (let index = 0; index < 44; index++) {
      writeFunctionWiki(root, `fn${String(index + 1).padStart(3, "0")}`)
    }
    writeModuleWiki(root)
    writeIndex(root, 459)

    const result = await nextStep()
    expect(result.status).toBe("success")
    expect(result.next_step.kind).toBe("function-analysis")
    expect(result.next_step.function_id).toBe("FUNC-045")
  })

  test("regenerates legacy function wiki artifacts that lack interface fields", async () => {
    const root = makeWorkspace()
    writeSoftwareAnalysis(root, 1)
    writePlan(root, 1)
    writeJson(join(root, ".matrix", "wiki", "data-structures.json"), {
      schema_version: 3,
      project_name: "Planner Test",
      created_date: "2026-04-02T03:30:00.000Z",
    })
    writeLegacyFunctionWiki(root, "fn001")

    const result = await nextStep()
    expect(result.status).toBe("success")
    expect(result.next_step.kind).toBe("function-analysis")
    expect(result.next_step.function_id).toBe("FUNC-001")
    expect(result.state_summary.completed_functions).toBe(0)
  })

  test("advances from function completion to module synthesis to global synthesis and then complete", async () => {
    const root = makeWorkspace()
    writeSoftwareAnalysis(root, 3)
    writePlan(root, 3)
    writeJson(join(root, ".matrix", "wiki", "data-structures.json"), {
      schema_version: 3,
      project_name: "Planner Test",
      created_date: "2026-04-02T03:30:00.000Z",
    })

    for (const name of ["fn001", "fn002", "fn003"]) {
      writeFunctionWiki(root, name)
    }

    const moduleResult = await nextStep()
    expect(moduleResult.status).toBe("success")
    expect(moduleResult.next_step.kind).toBe("module-analysis")
    expect(moduleResult.next_step.module_name).toBe("shell")
    expect(moduleResult.next_step.step_file).toBe(".matrix/state/wiki-next-step.json")

    const moduleStepArtifact = WikiExecutionStepArtifact.parse(
      readJson(join(root, ".matrix", "state", "wiki-next-step.json")),
    )
    expect(moduleStepArtifact.step.kind).toBe("module-analysis")
    if (moduleStepArtifact.step.kind === "module-analysis") {
      expect(moduleStepArtifact.step.module_source_paths).toEqual(["src/shell.c"])
      expect(moduleStepArtifact.step.module_function_wiki_paths).toHaveLength(3)
    }

    writeModuleWiki(root)

    const globalResult = await nextStep()
    expect(globalResult.status).toBe("success")
    expect(globalResult.next_step.kind).toBe("global-synthesis")
    expect(globalResult.next_step.step_file).toBe(".matrix/state/wiki-next-step.json")

    writeIndex(root, 3)

    const completeResult = await nextStep()
    expect(completeResult.status).toBe("success")
    expect(completeResult.next_step.kind).toBe("complete")
    expect(completeResult.state_summary.global_synthesis_completed).toBe(true)
  })
})
