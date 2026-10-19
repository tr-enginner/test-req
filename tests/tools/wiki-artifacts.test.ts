import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { dirname, join } from "path"
import { WikiIndex } from "../../src/schema/wiki"
import { wikiArtifacts } from "../../src/tools"

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
  const dir = mkdtempSync(join(tmpdir(), "wiki-artifacts-"))
  TEMP_DIRS.push(dir)
  mkdirSync(join(dir, ".matrix", "wiki", "functions"), { recursive: true })
  mkdirSync(join(dir, ".matrix", "wiki", "modules"), { recursive: true })
  process.chdir(dir)
  return dir
}

function writeSoftwareAnalysis(root: string, count = 205) {
  writeJson(join(root, ".matrix", "data", "software-analysis.json"), {
    project_name: "Demo Wiki Project",
    version: "1.0.0",
    created_date: "2026-04-01T00:00:00.000Z",
    requirements: [],
    interfaces: [],
    data_flow_graph: { nodes: [], edges: [] },
    functions: Array.from({ length: count }, (_, index) => ({
      id: `FUNC-${String(index + 1).padStart(3, "0")}`,
      name: `fn_${String(index + 1).padStart(3, "0")}`,
      file_path: index < Math.ceil(count / 2) ? "src/core.c" : "src/io.c",
      line_range: { start: index + 1, end: index + 2 },
      return_type: "void",
      parameters: [],
      calls: [],
      called_by: [],
      safety_critical: index % 2 === 0,
      related_requirements: [],
    })),
    modules: [
      { name: "core", path: "src/core.c", functions: [] },
      { name: "io", path: "src/io.c", functions: [] },
    ],
    summary: {
      total_functions: count,
      total_loc: count * 2,
      total_requirements: 0,
      total_interfaces: 0,
      safety_critical_functions: Math.ceil(count / 2),
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

function writeModuleWiki(root: string, id: string, name: string, files: string[]) {
  writeJson(join(root, ".matrix", "wiki", "modules", `${name}.json`), {
    id,
    name,
    files,
    responsibility: `${name} responsibility`,
    design_rationale: `${name} rationale`,
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

async function finalizeIndex(payload: unknown) {
  const toolImpl = wikiArtifacts as unknown as {
    execute: (args: { mode: "finalize_index"; payload: unknown }) => Promise<string>
  }
  return JSON.parse(await toolImpl.execute({ mode: "finalize_index", payload }))
}

afterEach(() => {
  process.chdir(ORIGINAL_CWD)
  for (const dir of TEMP_DIRS.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("wikiArtifacts", () => {
  test("finalize_index builds wiki index and chunked function-index artifacts from existing wiki files", async () => {
    const root = makeWorkspace()
    writeSoftwareAnalysis(root, 205)
    writeModuleWiki(root, "mod_core", "core", ["src/core.c"])
    writeModuleWiki(root, "mod_io", "io", ["src/io.c"])

    for (let index = 0; index < 205; index++) {
      const name = `fn_${String(index + 1).padStart(3, "0")}`
      writeFunctionWiki(
        root,
        name,
        `FUNC-${String(index + 1).padStart(3, "0")}`,
        index < 103 ? "mod_core" : "mod_io",
        index < 103 ? "src/core.c" : "src/io.c",
      )
    }

    writeJson(join(root, ".matrix", "wiki", "data-structures.json"), {
      schema_version: 3,
      project_name: "Demo Wiki Project",
      created_date: "2026-04-01T00:00:00.000Z",
      struct: [
        {
          name: "ControlState",
          file_path: "include/control.h",
          line_range: { start: 1, end: 10 },
          fields: [],
          used_by_functions: ["fn_001"],
          used_by_modules: ["core"],
        },
      ],
      GlobalVar: [
        {
          name: "g_control_state",
          file_path: "src/core.c",
          line_range: { start: 12, end: 12 },
          type: "ControlState",
          fields: [],
          used_by_functions: ["fn_001"],
          used_by_modules: ["core"],
        },
      ],
    })

    const result = await finalizeIndex({
      overview: "Demo overview",
      tech_stack: {
        language: "C",
        compiler_dialect: "C99",
        target_cpu: "generic",
        frameworks: [],
      },
      architecture: {
        pattern: "layered",
        description: "demo architecture",
        layers: ["core", "io"],
      },
      data_flow_paths: [
        { name: "control-loop", description: "control flow", modules_involved: ["core", "io"] },
      ],
    })

    expect(result.status).toBe("success")
    expect(result.summary.functions).toBe(205)
    expect(result.summary.function_index_chunks).toBe(2)
    expect(existsSync(join(root, ".matrix", "wiki", "index.json"))).toBe(true)

    const index = WikiIndex.parse(readJson(join(root, ".matrix", "wiki", "index.json")))
    expect(Object.keys(index.function_index)).toHaveLength(205)
    expect(index.function_index_chunks).toHaveLength(2)
    expect(index.modules).toHaveLength(2)
    expect(index.modules[0]?.function_count).toBeGreaterThan(0)
    expect(index.data_structures).toHaveLength(2)
    expect(index.data_structures[0]).toEqual({
      name: "ControlState",
      file_path: "include/control.h",
      kind: "struct",
    })
    expect(index.data_structures[1]).toEqual({
      name: "g_control_state",
      file_path: "src/core.c",
      kind: "GlobalVar",
    })
    expect(index.data_structures[0]).not.toHaveProperty("description")
    expect(index.data_structures[1]).not.toHaveProperty("description")

    const chunk1 = readJson<any>(join(root, ".matrix", "wiki", "index-functions", "chunk-0001.json"))
    expect(Object.keys(chunk1.entries)).toHaveLength(200)
    const chunk2 = readJson<any>(join(root, ".matrix", "wiki", "index-functions", "chunk-0002.json"))
    expect(Object.keys(chunk2.entries)).toHaveLength(5)
  })

  test("finalize_index uses lenient FunctionWiki data in memory without rewriting the artifact", async () => {
    const root = makeWorkspace()
    writeSoftwareAnalysis(root, 1)
    writeModuleWiki(root, "mod_core", "core", ["src/core.c"])

    const functionWikiPath = join(root, ".matrix", "wiki", "functions", "fn_001.json")
    const driftedFunctionWiki = {
      id: "FUNC-001",
      name: "fn_001",
      file_path: "src/core.c",
      line_range: { start: 1, end: 2 },
      module_id: "mod_core",
      signature: "void fn_001(void)",
      parameters: [],
      return_value: {
        type: "void",
        description: "fn_001 does not return a direct value.",
      },
      summary: "fn_001 summary",
      algorithm: "straight-line algorithm",
      preconditions: "caller must initialize state",
      postconditions: "state is updated",
      boundary_conditions: "input may be zero",
      error_handling: "returns early on invalid input",
      control_flow: "single branch with early return",
      side_effects: "updates shared state",
      concurrency: "not an ISR",
      requirement_fulfillment: "REQ-001 via state update",
      testing_hints: "focus on invalid input handling",
    }
    writeJson(functionWikiPath, driftedFunctionWiki)

    const result = await finalizeIndex({
      overview: "Demo overview",
      tech_stack: {
        language: "C",
        compiler_dialect: "C99",
        target_cpu: "generic",
        frameworks: [],
      },
      architecture: {
        pattern: "layered",
        description: "demo architecture",
        layers: ["core"],
      },
      data_flow_paths: [],
    })

    expect(result.status).toBe("success")
    expect(result.warnings[0]).toContain("Skipped FunctionWiki schema rewrite")
    expect(readJson<any>(functionWikiPath)).toEqual(driftedFunctionWiki)

    const index = WikiIndex.parse(readJson(join(root, ".matrix", "wiki", "index.json")))
    expect(index.function_index.fn_001).toEqual({
      id: "FUNC-001",
      module_id: "mod_core",
      file_path: "src/core.c",
      safety_critical: true,
    })
  })

  test("finalize_index ignores invalid FunctionWiki schema and builds a best-effort function index", async () => {
    const root = makeWorkspace()
    writeSoftwareAnalysis(root, 1)
    writeModuleWiki(root, "mod_core", "core", ["src/core.c"])

    const functionWikiPath = join(root, ".matrix", "wiki", "functions", "fn_001.json")
    const invalidFunctionWiki = {
      functionId: "FUNC-001",
      functionName: "fn_001",
      moduleName: "mod_core",
      filePath: "src/old-path.c",
      what: "legacy shape that does not match FunctionWiki",
    }
    writeJson(functionWikiPath, invalidFunctionWiki)

    const result = await finalizeIndex({
      overview: "Demo overview",
      tech_stack: {
        language: "C",
        compiler_dialect: "C99",
        target_cpu: "generic",
        frameworks: [],
      },
      architecture: {
        pattern: "layered",
        description: "demo architecture",
        layers: ["core"],
      },
      data_flow_paths: [],
    })

    expect(result.status).toBe("success")
    expect(result.warnings[0]).toContain("Skipped FunctionWiki schema enforcement")
    expect(readJson<any>(functionWikiPath)).toEqual(invalidFunctionWiki)

    const index = WikiIndex.parse(readJson(join(root, ".matrix", "wiki", "index.json")))
    expect(index.function_index.fn_001).toEqual({
      id: "FUNC-001",
      module_id: "mod_core",
      file_path: "src/core.c",
      safety_critical: true,
    })
  })

  test("finalize_index ignores invalid ModuleWiki schema and builds best-effort module entries", async () => {
    const root = makeWorkspace()
    writeSoftwareAnalysis(root, 1)
    writeFunctionWiki(root, "fn_001", "FUNC-001", "mod_core", "src/core.c")

    const moduleWikiPath = join(root, ".matrix", "wiki", "modules", "core.json")
    const invalidModuleWiki = {
      moduleId: "mod_core",
      moduleName: "core",
      filePath: "src/core.c",
      summary: "legacy module summary",
    }
    writeJson(moduleWikiPath, invalidModuleWiki)

    const result = await finalizeIndex({
      overview: "Demo overview",
      tech_stack: {
        language: "C",
        compiler_dialect: "C99",
        target_cpu: "generic",
        frameworks: [],
      },
      architecture: {
        pattern: "layered",
        description: "demo architecture",
        layers: ["core"],
      },
      data_flow_paths: [],
    })

    expect(result.status).toBe("success")
    expect(result.warnings.some((warning: string) => warning.includes("Skipped ModuleWiki schema enforcement"))).toBe(true)
    expect(readJson<any>(moduleWikiPath)).toEqual(invalidModuleWiki)

    const index = WikiIndex.parse(readJson(join(root, ".matrix", "wiki", "index.json")))
    expect(index.modules).toEqual([
      {
        id: "mod_core",
        name: "core",
        files: ["src/core.c"],
        description: "legacy module summary",
        function_count: 1,
        safety_critical: true,
      },
    ])
  })

  test("finalize_index ignores invalid data-structures schema and keeps only index summary fields", async () => {
    const root = makeWorkspace()
    writeSoftwareAnalysis(root, 1)
    writeModuleWiki(root, "mod_core", "core", ["src/core.c"])
    writeFunctionWiki(root, "fn_001", "FUNC-001", "mod_core", "src/core.c")

    writeJson(join(root, ".matrix", "wiki", "data-structures.json"), {
      schema_version: 2,
      project_name: "Demo Wiki Project",
      created_date: "2026-04-01T00:00:00.000Z",
      structures: [
        {
          name: "LegacyState",
          file_path: "src/core.c",
          kind: "GlobalVar",
          description: "legacy description must not appear in index",
        },
      ],
    })

    const result = await finalizeIndex({
      overview: "Demo overview",
      tech_stack: {
        language: "C",
        compiler_dialect: "C99",
        target_cpu: "generic",
        frameworks: [],
      },
      architecture: {
        pattern: "layered",
        description: "demo architecture",
        layers: ["core"],
      },
      data_flow_paths: [],
    })

    expect(result.status).toBe("success")
    expect(result.warnings.some((warning: string) => warning.includes("Skipped data-structures schema enforcement"))).toBe(true)

    const index = WikiIndex.parse(readJson(join(root, ".matrix", "wiki", "index.json")))
    expect(index.data_structures).toEqual([
      {
        name: "LegacyState",
        file_path: "src/core.c",
        kind: "GlobalVar",
      },
    ])
    expect(index.data_structures[0]).not.toHaveProperty("description")
  })

  test("finalize_index ignores invalid software-analysis schema and uses best-effort metadata", async () => {
    const root = makeWorkspace()
    writeModuleWiki(root, "mod_core", "core", ["src/core.c"])
    writeFunctionWiki(root, "fn_001", "WIKI-FUNC-001", "mod_core", "src/from-wiki.c")

    writeJson(join(root, ".matrix", "data", "software-analysis.json"), {
      projectName: "Legacy Analysis",
      version: "9.9.9",
      functions: [
        {
          functionId: "FUNC-001",
          functionName: "fn_001",
          filePath: "src/from-analysis.c",
          safetyCritical: true,
        },
      ],
    })

    const result = await finalizeIndex({
      overview: "Demo overview",
      tech_stack: {
        language: "C",
        compiler_dialect: "C99",
        target_cpu: "generic",
        frameworks: [],
      },
      architecture: {
        pattern: "layered",
        description: "demo architecture",
        layers: ["core"],
      },
      data_flow_paths: [],
    })

    expect(result.status).toBe("success")
    expect(result.warnings.some((warning: string) => warning.includes("Skipped software-analysis schema enforcement"))).toBe(true)

    const index = WikiIndex.parse(readJson(join(root, ".matrix", "wiki", "index.json")))
    expect(index.project_name).toBe("Legacy Analysis")
    expect(index.version).toBe("9.9.9")
    expect(index.function_index.fn_001).toEqual({
      id: "FUNC-001",
      module_id: "mod_core",
      file_path: "src/from-analysis.c",
      safety_critical: true,
    })
  })
})
