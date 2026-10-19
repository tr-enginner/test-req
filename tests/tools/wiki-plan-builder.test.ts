import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { dirname, join } from "path"
import { WikiGenerationPlan } from "../../src/schema/wiki"
import { wikiPlanBuilder } from "../../src/tools"

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
  const dir = mkdtempSync(join(tmpdir(), "wiki-plan-builder-"))
  TEMP_DIRS.push(dir)
  mkdirSync(join(dir, ".matrix", "data"), { recursive: true })
  mkdirSync(join(dir, ".matrix", "wiki", "functions"), { recursive: true })
  process.chdir(dir)
  return dir
}

function writeStage03Artifact(root: string) {
  writeJson(join(root, ".matrix", "data", "software-analysis-stage-03-code.json"), {
    artifact_type: "software-analysis-stage",
    schema_version: 1,
    stage_id: "03-code",
    created_date: "2026-04-02T03:30:00.000Z",
    payload: {
      functions: [],
      function_index: [
        {
          id: "FUNC-001",
          name: "helper",
          file_path: "src/util.c",
          line_range: { start: 10, end: 20 },
          return_type: "int",
          parameters: [{ name: "value", type: "int" }],
          calls: [],
          called_by: ["mid"],
          safety_critical: false,
          chunk_index: 0,
          chunk_file_path: ".matrix/data/software-analysis-stage-03-functions/chunk-0001.json",
        },
        {
          id: "FUNC-002",
          name: "leaf",
          file_path: "src/shell.c",
          line_range: { start: 30, end: 40 },
          return_type: "void",
          parameters: [],
          calls: [],
          called_by: ["mid"],
          safety_critical: false,
          chunk_index: 0,
          chunk_file_path: ".matrix/data/software-analysis-stage-03-functions/chunk-0001.json",
        },
        {
          id: "FUNC-003",
          name: "mid",
          file_path: "src/shell.c",
          line_range: { start: 50, end: 70 },
          return_type: "int",
          parameters: [{ name: "mode", type: "uint8_t" }],
          calls: ["leaf", "helper", "sqlite3_malloc"],
          called_by: ["root"],
          safety_critical: true,
          chunk_index: 0,
          chunk_file_path: ".matrix/data/software-analysis-stage-03-functions/chunk-0001.json",
        },
        {
          id: "FUNC-004",
          name: "root",
          file_path: "src/shell.c",
          line_range: { start: 80, end: 110 },
          return_type: "void",
          parameters: [],
          calls: ["mid"],
          called_by: [],
          safety_critical: true,
          chunk_index: 0,
          chunk_file_path: ".matrix/data/software-analysis-stage-03-functions/chunk-0001.json",
        },
      ],
      function_chunks: [],
      modules: [
        { name: "util", path: "src/util.c", functions: ["helper"] },
        { name: "shell", path: "src/shell.c", functions: ["leaf", "mid", "root"] },
      ],
      data_flow_graph: { nodes: [], edges: [] },
      total_loc: 100,
    },
  })
}

function writeFunctionWiki(root: string, name: string, id: string, moduleId: string, filePath: string) {
  writeJson(join(root, ".matrix", "wiki", "functions", `${name}.json`), {
    id,
    name,
    file_path: filePath,
    line_range: { start: 1, end: 2 },
    module_id: moduleId,
    signature: `void ${name}(void)`,
    parameters: [],
    return_value: {
      type: "void",
      description: `${name} does not return a direct value.`,
    },
    summary: `${name} summary`,
    algorithm: { name: "straight-line", description: `${name} algorithm` },
    preconditions: [],
    postconditions: [],
    boundary_conditions: [],
    error_handling: [],
    control_flow: { branches: 0, loops: 0, early_returns: 0, description: "simple flow" },
    side_effects: [],
    concurrency: { is_isr: false, shared_resources: [], critical_sections: false, reentrancy: "unknown" },
    requirement_fulfillment: [],
    testing_hints: { suggested_focus: [], stubbing_needs: [] },
  })
}

function writeLegacyFunctionWiki(root: string, name: string, id: string, moduleId: string, filePath: string) {
  writeJson(join(root, ".matrix", "wiki", "functions", `${name}.json`), {
    id,
    name,
    file_path: filePath,
    line_range: { start: 1, end: 2 },
    module_id: moduleId,
    signature: `void ${name}(void)`,
    summary: `${name} legacy summary`,
    algorithm: { name: "straight-line", description: `${name} algorithm` },
    preconditions: [],
    postconditions: [],
    boundary_conditions: [],
    error_handling: [],
    control_flow: { branches: 0, loops: 0, early_returns: 0, description: "simple flow" },
    side_effects: [],
    concurrency: { is_isr: false, shared_resources: [], critical_sections: false, reentrancy: "unknown" },
    requirement_fulfillment: [],
    testing_hints: { suggested_focus: [], stubbing_needs: [] },
  })
}

async function buildPlan() {
  const toolImpl = wikiPlanBuilder as unknown as {
    execute: (args: { mode: "build_plan" }) => Promise<string>
  }
  return JSON.parse(await toolImpl.execute({ mode: "build_plan" }))
}

afterEach(() => {
  process.chdir(ORIGINAL_CWD)
  for (const dir of TEMP_DIRS.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("wikiPlanBuilder", () => {
  test("builds a bottom-up wiki plan from stage-03 when final software-analysis.json is unusable", async () => {
    const root = makeWorkspace()
    writeJson(join(root, ".matrix", "data", "software-analysis.json"), { artifact_type: "broken-final" })
    writeStage03Artifact(root)
    writeFunctionWiki(root, "helper", "FUNC-001", "mod_util", "src/util.c")

    const result = await buildPlan()
    expect(result.status).toBe("success")
    expect(result.summary.total_functions).toBe(4)
    expect(result.summary.scheduled_functions).toBe(4)

    const plan = WikiGenerationPlan.parse(readJson(join(root, ".matrix", "plans", "wiki-generation-plan.json")))
    expect(plan.project.total_functions).toBe(4)
    expect(plan.module_order).toEqual(["util", "shell"])
    expect(plan.per_module_function_order.util).toEqual(["FUNC-001"])
    expect(plan.per_module_function_order.shell).toEqual(["FUNC-002", "FUNC-003", "FUNC-004"])
    expect(plan.per_function_names["FUNC-003"]).toBe("mid")
    expect(plan.per_function_direct_callees["FUNC-003"]).toEqual(["FUNC-002", "FUNC-001"])
    expect(plan.per_function_dependency_wiki_paths["FUNC-003"]).toEqual([
      ".matrix/wiki/functions/leaf.json",
      ".matrix/wiki/functions/helper.json",
    ])
    expect(plan.per_function_source_locations["FUNC-004"]).toEqual({
      file_path: "src/shell.c",
      line_range: { start: 80, end: 110 },
    })
    expect(plan.per_function_interfaces["FUNC-003"]).toEqual({
      return_type: "int",
      parameters: [{ name: "mode", type: "uint8_t" }],
    })
    expect(plan.per_function_wiki_paths["FUNC-004"]).toBe(".matrix/wiki/functions/root.json")
    expect(plan.dependency_requirements.shell).toEqual({
      module_dependencies: ["util"],
      required_lower_layer_paths: [".matrix/wiki/modules/util.json"],
    })
    expect(plan.reusable_function_wiki_paths).toEqual({
      "FUNC-001": ".matrix/wiki/functions/helper.json",
    })
    expect(plan.skipped_function_dispatches).toEqual([
      {
        function_name: "helper",
        module_name: "util",
        wiki_path: ".matrix/wiki/functions/helper.json",
        reason: "reused_existing_artifact",
      },
    ])
  })

  test("ignores duplicate function names by disambiguating planning keys with function ids", async () => {
    const root = makeWorkspace()
    writeJson(join(root, ".matrix", "data", "software-analysis.json"), { artifact_type: "broken-final" })
    writeJson(join(root, ".matrix", "data", "software-analysis-stage-03-code.json"), {
      artifact_type: "software-analysis-stage",
      schema_version: 1,
      stage_id: "03-code",
      created_date: "2026-04-02T03:30:00.000Z",
      payload: {
        functions: [],
        function_index: [
          {
            id: "FUNC-009",
            name: "beginTimer",
            file_path: "src/a.c",
            line_range: { start: 10, end: 20 },
            calls: [],
            called_by: ["worker"],
            safety_critical: false,
          },
          {
            id: "FUNC-013",
            name: "beginTimer",
            file_path: "src/b.c",
            line_range: { start: 30, end: 40 },
            calls: [],
            called_by: [],
            safety_critical: false,
          },
          {
            id: "FUNC-020",
            name: "worker",
            file_path: "src/a.c",
            line_range: { start: 50, end: 70 },
            calls: ["beginTimer"],
            called_by: [],
            safety_critical: false,
          },
        ],
        function_chunks: [],
        modules: [
          { name: "a", path: "src/a.c", functions: ["FUNC-009", "FUNC-020"] },
          { name: "b", path: "src/b.c", functions: ["FUNC-013"] },
        ],
        data_flow_graph: { nodes: [], edges: [] },
        total_loc: 70,
      },
    })

    const result = await buildPlan()
    expect(result.status).toBe("success")

    const plan = WikiGenerationPlan.parse(readJson(join(root, ".matrix", "plans", "wiki-generation-plan.json")))
    expect(plan.project.total_functions).toBe(3)
    expect(plan.per_module_function_order.a).toEqual(["FUNC-009", "FUNC-020"])
    expect(plan.per_module_function_order.b).toEqual(["FUNC-013"])
    expect(plan.per_function_names["FUNC-009"]).toBe("beginTimer")
    expect(plan.per_function_names["FUNC-013"]).toBe("beginTimer")
    expect(plan.per_function_wiki_paths["FUNC-009"]).toBe(".matrix/wiki/functions/beginTimer.json")
    expect(plan.per_function_wiki_paths["FUNC-013"]).toBe(".matrix/wiki/functions/beginTimer.json")
    expect(plan.per_function_direct_callees["FUNC-020"]).toEqual(["FUNC-009"])
    expect(plan.per_function_dependency_wiki_paths["FUNC-020"]).toEqual([
      ".matrix/wiki/functions/beginTimer.json",
    ])
  })

  test("does not mark legacy function wiki without interface fields as reusable", async () => {
    const root = makeWorkspace()
    writeJson(join(root, ".matrix", "data", "software-analysis.json"), { artifact_type: "broken-final" })
    writeStage03Artifact(root)
    writeLegacyFunctionWiki(root, "helper", "FUNC-001", "mod_util", "src/util.c")

    const result = await buildPlan()
    expect(result.status).toBe("success")

    const plan = WikiGenerationPlan.parse(readJson(join(root, ".matrix", "plans", "wiki-generation-plan.json")))
    expect(plan.reusable_function_wiki_paths).toEqual({})
    expect(plan.skipped_function_dispatches).toEqual([])
  })
})
