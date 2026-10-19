import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { dirname, join } from "path"
import { ModuleDependencyGraph } from "../../src/schema/module-dependency-graph"
import { moduleDependencyBuilder } from "../../src/tools"

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
  const dir = mkdtempSync(join(tmpdir(), "module-dependency-builder-"))
  TEMP_DIRS.push(dir)
  mkdirSync(join(dir, ".matrix", "data"), { recursive: true })
  process.chdir(dir)
  return dir
}

function createStage03Envelope(payload: Record<string, unknown>) {
  return {
    artifact_type: "software-analysis-stage",
    schema_version: 1,
    stage_id: "03-code",
    created_date: "2026-04-20T00:00:00.000Z",
    payload,
  }
}

async function buildModuleDependencies(args?: { stage03_file?: string; output_file?: string }) {
  const toolImpl = moduleDependencyBuilder as unknown as {
    execute: (toolArgs?: { stage03_file?: string; output_file?: string }) => Promise<string>
  }
  return JSON.parse(await toolImpl.execute(args))
}

afterEach(() => {
  process.chdir(ORIGINAL_CWD)
  for (const dir of TEMP_DIRS.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("moduleDependencyBuilder", () => {
  test("builds module dependencies from function_index, ignores external calls, and keeps empty modules", async () => {
    const root = makeWorkspace()
    writeJson(join(root, ".matrix", "data", "software-analysis-stage-03-code.json"), createStage03Envelope({
      functions: [],
      function_index: [
        {
          id: "FUNC-001",
          name: "core_helper",
          file_path: "src/core.c",
          line_range: { start: 1, end: 3 },
          calls: [],
          called_by: ["core_worker"],
          safety_critical: false,
        },
        {
          id: "FUNC-002",
          name: "core_worker",
          file_path: "src/core.c",
          line_range: { start: 5, end: 12 },
          calls: ["core_helper", "interface_send", "printf"],
          called_by: [],
          safety_critical: false,
        },
        {
          id: "FUNC-003",
          name: "interface_send",
          file_path: "src/interface.c",
          line_range: { start: 1, end: 4 },
          calls: [],
          called_by: ["core_worker"],
          safety_critical: false,
        },
        {
          id: "FUNC-004",
          name: "idle",
          file_path: "src/idle.c",
          line_range: { start: 1, end: 2 },
          calls: [],
          called_by: [],
          safety_critical: false,
        },
      ],
      function_chunks: [],
      modules: [
        {
          name: "core",
          path: "src/core.c",
          functions: ["core_helper", "core_worker"],
        },
        {
          name: "interface",
          path: "src/interface.c",
          functions: ["interface_send"],
        },
        {
          name: "idle",
          path: "src/idle.c",
          functions: ["idle"],
        },
      ],
      data_flow_graph: { nodes: [], edges: [] },
      total_loc: 20,
    }))

    const result = await buildModuleDependencies()
    expect(result.status).toBe("success")
    expect(result.stage03_file).toBe(".matrix/data/software-analysis-stage-03-code.json")
    expect(result.output_file).toBe(".matrix/data/module-dependencies.json")
    expect(result.module_count).toBe(3)
    expect(result.edge_count).toBe(1)
    expect(existsSync(join(root, ".matrix", "data", "module-dependencies.json"))).toBe(true)

    const graph = ModuleDependencyGraph.parse(readJson(join(root, ".matrix", "data", "module-dependencies.json")))
    expect(graph).toEqual({
      core: ["interface"],
      idle: [],
      interface: [],
    })
  })

  test("resolves module membership when modules reference function ids", async () => {
    const root = makeWorkspace()
    writeJson(join(root, ".matrix", "data", "software-analysis-stage-03-code.json"), createStage03Envelope({
      functions: [],
      function_index: [
        {
          id: "FUNC-001",
          name: "alpha_main",
          file_path: "src/alpha.c",
          line_range: { start: 1, end: 6 },
          calls: ["beta_helper"],
          called_by: [],
          safety_critical: false,
        },
        {
          id: "FUNC-002",
          name: "beta_helper",
          file_path: "src/beta.c",
          line_range: { start: 1, end: 4 },
          calls: [],
          called_by: ["alpha_main"],
          safety_critical: false,
        },
      ],
      function_chunks: [],
      modules: [
        {
          name: "alpha",
          path: "src/alpha.c",
          functions: ["FUNC-001"],
        },
        {
          name: "beta",
          path: "src/beta.c",
          functions: ["FUNC-002"],
        },
      ],
      data_flow_graph: { nodes: [], edges: [] },
      total_loc: 10,
    }))

    const result = await buildModuleDependencies()
    expect(result.status).toBe("success")

    const graph = ModuleDependencyGraph.parse(readJson(join(root, ".matrix", "data", "module-dependencies.json")))
    expect(graph).toEqual({
      alpha: ["beta"],
      beta: [],
    })
  })

  test("falls back to payload.functions when function_index is empty", async () => {
    const root = makeWorkspace()
    writeJson(join(root, ".matrix", "data", "software-analysis-stage-03-code.json"), createStage03Envelope({
      functions: [
        {
          id: "FUNC-001",
          name: "root",
          file_path: "src/root.c",
          line_range: { start: 1, end: 8 },
          return_type: "void",
          parameters: [],
          cyclomatic_complexity: 1,
          calls: ["leaf"],
          called_by: [],
          safety_critical: false,
          related_requirements: [],
        },
        {
          id: "FUNC-002",
          name: "leaf",
          file_path: "src/leaf.c",
          line_range: { start: 1, end: 4 },
          return_type: "void",
          parameters: [],
          cyclomatic_complexity: 1,
          calls: [],
          called_by: ["root"],
          safety_critical: false,
          related_requirements: [],
        },
      ],
      function_index: [],
      function_chunks: [],
      modules: [
        {
          name: "root",
          path: "src/root.c",
          functions: ["root"],
        },
        {
          name: "leaf",
          path: "src/leaf.c",
          functions: ["leaf"],
        },
      ],
      data_flow_graph: { nodes: [], edges: [] },
      total_loc: 12,
    }))

    const result = await buildModuleDependencies()
    expect(result.status).toBe("success")

    const graph = ModuleDependencyGraph.parse(readJson(join(root, ".matrix", "data", "module-dependencies.json")))
    expect(graph).toEqual({
      leaf: [],
      root: ["leaf"],
    })
  })

  test("falls back to function chunks when stage-03 only contains chunk refs", async () => {
    const root = makeWorkspace()
    writeJson(join(root, ".matrix", "data", "software-analysis-stage-03-code.json"), createStage03Envelope({
      functions: [],
      function_index: [],
      function_chunks: [
        {
          chunk_index: 0,
          file_path: ".matrix/data/software-analysis-stage-03-functions/chunk-0001.json",
          function_count: 2,
          first_function_id: "FUNC-001",
          last_function_id: "FUNC-002",
        },
      ],
      modules: [
        {
          name: "alpha",
          path: "src/alpha.c",
          functions: ["alpha"],
        },
        {
          name: "beta",
          path: "src/beta.c",
          functions: ["beta"],
        },
      ],
      data_flow_graph: { nodes: [], edges: [] },
      total_loc: 12,
    }))
    writeJson(join(root, ".matrix", "data", "software-analysis-stage-03-functions", "chunk-0001.json"), {
      artifact_type: "software-analysis-stage-03-function-chunk",
      schema_version: 1,
      stage_id: "03-code",
      chunk_index: 0,
      created_date: "2026-04-20T00:00:00.000Z",
      functions: [
        {
          id: "FUNC-001",
          name: "alpha",
          file_path: "src/alpha.c",
          line_range: { start: 1, end: 4 },
          return_type: "void",
          parameters: [],
          cyclomatic_complexity: 1,
          calls: ["beta"],
          called_by: [],
          safety_critical: false,
          related_requirements: [],
        },
        {
          id: "FUNC-002",
          name: "beta",
          file_path: "src/beta.c",
          line_range: { start: 1, end: 4 },
          return_type: "void",
          parameters: [],
          cyclomatic_complexity: 1,
          calls: [],
          called_by: ["alpha"],
          safety_critical: false,
          related_requirements: [],
        },
      ],
    })

    const result = await buildModuleDependencies()
    expect(result.status).toBe("success")

    const graph = ModuleDependencyGraph.parse(readJson(join(root, ".matrix", "data", "module-dependencies.json")))
    expect(graph).toEqual({
      alpha: ["beta"],
      beta: [],
    })
  })

  test("synthesizes modules from file paths when payload.modules is empty", async () => {
    const root = makeWorkspace()
    writeJson(join(root, ".matrix", "data", "software-analysis-stage-03-code.json"), createStage03Envelope({
      functions: [],
      function_index: [
        {
          id: "FUNC-001",
          name: "sensor_read",
          file_path: "src/sensor.c",
          line_range: { start: 1, end: 5 },
          calls: ["bus_write"],
          called_by: [],
          safety_critical: false,
        },
        {
          id: "FUNC-002",
          name: "bus_write",
          file_path: "src/bus.c",
          line_range: { start: 1, end: 3 },
          calls: [],
          called_by: ["sensor_read"],
          safety_critical: false,
        },
      ],
      function_chunks: [],
      modules: [],
      data_flow_graph: { nodes: [], edges: [] },
      total_loc: 8,
    }))

    const result = await buildModuleDependencies()
    expect(result.status).toBe("success")

    const graph = ModuleDependencyGraph.parse(readJson(join(root, ".matrix", "data", "module-dependencies.json")))
    expect(graph).toEqual({
      bus: [],
      sensor: ["bus"],
    })
  })

  test("disambiguates synthesized modules when different directories share the same file name", async () => {
    const root = makeWorkspace()
    writeJson(join(root, ".matrix", "data", "software-analysis-stage-03-code.json"), createStage03Envelope({
      functions: [],
      function_index: [
        {
          id: "FUNC-001",
          name: "root_entry",
          file_path: "src/root.c",
          line_range: { start: 1, end: 6 },
          calls: ["left_helper", "right_helper"],
          called_by: [],
          safety_critical: false,
        },
        {
          id: "FUNC-002",
          name: "left_helper",
          file_path: "platform/a/common.c",
          line_range: { start: 1, end: 3 },
          calls: [],
          called_by: ["root_entry"],
          safety_critical: false,
        },
        {
          id: "FUNC-003",
          name: "right_helper",
          file_path: "platform/b/common.c",
          line_range: { start: 1, end: 3 },
          calls: [],
          called_by: ["root_entry"],
          safety_critical: false,
        },
      ],
      function_chunks: [],
      modules: [],
      data_flow_graph: { nodes: [], edges: [] },
      total_loc: 12,
    }))

    const result = await buildModuleDependencies()
    expect(result.status).toBe("success")
    expect(result.module_count).toBe(3)
    expect(result.edge_count).toBe(2)

    const graph = ModuleDependencyGraph.parse(readJson(join(root, ".matrix", "data", "module-dependencies.json")))
    expect(graph).toEqual({
      "platform/a/common": [],
      "platform/b/common": [],
      root: ["platform/a/common", "platform/b/common"],
    })
  })

  test("disambiguates declared modules when different directories share the same module name", async () => {
    const root = makeWorkspace()
    writeJson(join(root, ".matrix", "data", "software-analysis-stage-03-code.json"), createStage03Envelope({
      functions: [],
      function_index: [
        {
          id: "FUNC-001",
          name: "root_entry",
          file_path: "src/root.c",
          line_range: { start: 1, end: 6 },
          calls: ["left_helper", "right_helper"],
          called_by: [],
          safety_critical: false,
        },
        {
          id: "FUNC-002",
          name: "left_helper",
          file_path: "platform/a/common.c",
          line_range: { start: 1, end: 3 },
          calls: [],
          called_by: ["root_entry"],
          safety_critical: false,
        },
        {
          id: "FUNC-003",
          name: "right_helper",
          file_path: "platform/b/common.c",
          line_range: { start: 1, end: 3 },
          calls: [],
          called_by: ["root_entry"],
          safety_critical: false,
        },
      ],
      function_chunks: [],
      modules: [
        {
          name: "root",
          path: "src/root.c",
          functions: ["FUNC-001"],
        },
        {
          name: "common",
          path: "platform/a/common.c",
          functions: ["FUNC-002"],
        },
        {
          name: "common",
          path: "platform/b/common.c",
          functions: ["FUNC-003"],
        },
      ],
      data_flow_graph: { nodes: [], edges: [] },
      total_loc: 12,
    }))

    const result = await buildModuleDependencies()
    expect(result.status).toBe("success")
    expect(result.module_count).toBe(3)
    expect(result.edge_count).toBe(2)

    const graph = ModuleDependencyGraph.parse(readJson(join(root, ".matrix", "data", "module-dependencies.json")))
    expect(graph).toEqual({
      "platform/a/common": [],
      "platform/b/common": [],
      root: ["platform/a/common", "platform/b/common"],
    })
  })

  test("uses relative paths with extensions when duplicate modules still collide after removing extensions", async () => {
    const root = makeWorkspace()
    writeJson(join(root, ".matrix", "data", "software-analysis-stage-03-code.json"), createStage03Envelope({
      functions: [],
      function_index: [
        {
          id: "FUNC-001",
          name: "main_loop",
          file_path: "main.c",
          line_range: { start: 1, end: 6 },
          calls: ["scs_impl", "scs_decl"],
          called_by: [],
          safety_critical: false,
        },
        {
          id: "FUNC-002",
          name: "scs_impl",
          file_path: "SCS.c",
          line_range: { start: 1, end: 3 },
          calls: [],
          called_by: ["main_loop"],
          safety_critical: false,
        },
        {
          id: "FUNC-003",
          name: "scs_decl",
          file_path: "SCS.h",
          line_range: { start: 1, end: 1 },
          calls: [],
          called_by: ["main_loop"],
          safety_critical: false,
        },
      ],
      function_chunks: [],
      modules: [
        {
          name: "MAIN",
          path: "main.c",
          functions: ["FUNC-001"],
        },
        {
          name: "SCS",
          path: "SCS.c",
          functions: ["FUNC-002"],
        },
        {
          name: "SCS",
          path: "SCS.h",
          functions: ["FUNC-003"],
        },
      ],
      data_flow_graph: { nodes: [], edges: [] },
      total_loc: 10,
    }))

    const result = await buildModuleDependencies()
    expect(result.status).toBe("success")

    const graph = ModuleDependencyGraph.parse(readJson(join(root, ".matrix", "data", "module-dependencies.json")))
    expect(graph).toEqual({
      MAIN: ["SCS.c", "SCS.h"],
      "SCS.c": [],
      "SCS.h": [],
    })
  })

  test("uses conservative resolution when a callee name exists in multiple external modules", async () => {
    const root = makeWorkspace()
    writeJson(join(root, ".matrix", "data", "software-analysis-stage-03-code.json"), createStage03Envelope({
      functions: [],
      function_index: [
        {
          id: "FUNC-001",
          name: "root_entry",
          file_path: "src/root.c",
          line_range: { start: 1, end: 6 },
          calls: ["shared_helper"],
          called_by: [],
          safety_critical: false,
        },
        {
          id: "FUNC-002",
          name: "shared_helper",
          file_path: "src/left.c",
          line_range: { start: 1, end: 3 },
          calls: [],
          called_by: ["root_entry"],
          safety_critical: false,
        },
        {
          id: "FUNC-003",
          name: "shared_helper",
          file_path: "src/right.c",
          line_range: { start: 1, end: 3 },
          calls: [],
          called_by: ["root_entry"],
          safety_critical: false,
        },
      ],
      function_chunks: [],
      modules: [
        {
          name: "root",
          path: "src/root.c",
          functions: ["FUNC-001"],
        },
        {
          name: "left",
          path: "src/left.c",
          functions: ["FUNC-002"],
        },
        {
          name: "right",
          path: "src/right.c",
          functions: ["FUNC-003"],
        },
      ],
      data_flow_graph: { nodes: [], edges: [] },
      total_loc: 12,
    }))

    const result = await buildModuleDependencies()
    expect(result.status).toBe("success")
    expect(result.edge_count).toBe(2)

    const graph = ModuleDependencyGraph.parse(readJson(join(root, ".matrix", "data", "module-dependencies.json")))
    expect(graph).toEqual({
      left: [],
      right: [],
      root: ["left", "right"],
    })
  })

  test("returns a clear error when the default stage-03 file is missing", async () => {
    makeWorkspace()

    const result = await buildModuleDependencies()
    expect(result.status).toBe("error")
    expect(result.error).toContain("Missing stage-03 artifact")
  })

  test("returns a clear error when the stage-03 file contains invalid JSON", async () => {
    const root = makeWorkspace()
    const stage03Path = join(root, ".matrix", "data", "software-analysis-stage-03-code.json")
    writeFileSync(stage03Path, "{ invalid json", "utf-8")

    const result = await buildModuleDependencies()
    expect(result.status).toBe("error")
    expect(result.error).toContain("Invalid JSON")
  })

  test("returns a clear error when the stage-03 schema is invalid", async () => {
    const root = makeWorkspace()
    writeJson(join(root, ".matrix", "data", "software-analysis-stage-03-code.json"), {
      artifact_type: "software-analysis-stage",
      schema_version: 1,
      stage_id: "03-code",
      created_date: "2026-04-20T00:00:00.000Z",
      payload: {
        function_index: "not-an-array",
      },
    })

    const result = await buildModuleDependencies()
    expect(result.status).toBe("error")
    expect(result.error).toContain("schema mismatch")
  })

  test("returns a clear error when a referenced chunk is missing", async () => {
    const root = makeWorkspace()
    writeJson(join(root, ".matrix", "data", "software-analysis-stage-03-code.json"), createStage03Envelope({
      functions: [],
      function_index: [],
      function_chunks: [
        {
          chunk_index: 0,
          file_path: ".matrix/data/software-analysis-stage-03-functions/chunk-0001.json",
          function_count: 1,
          first_function_id: "FUNC-001",
          last_function_id: "FUNC-001",
        },
      ],
      modules: [],
      data_flow_graph: { nodes: [], edges: [] },
      total_loc: 1,
    }))

    const result = await buildModuleDependencies()
    expect(result.status).toBe("error")
    expect(result.error).toContain("Missing stage-03 function chunk")
  })
})
