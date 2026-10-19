import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { dirname, join } from "path"
import { CallGraph } from "../../src/schema/callgraph"
import { callgraphBuilder } from "../../src/tools"

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
  const dir = mkdtempSync(join(tmpdir(), "callgraph-builder-"))
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
    created_date: "2026-04-15T00:00:00.000Z",
    payload,
  }
}

async function buildCallgraph(args?: { stage03_file?: string; output_file?: string }) {
  const toolImpl = callgraphBuilder as unknown as {
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

describe("callgraphBuilder", () => {
  test("builds callgraph from payload.function_index and writes default output", async () => {
    const root = makeWorkspace()
    writeJson(join(root, ".matrix", "data", "software-analysis-stage-03-code.json"), createStage03Envelope({
      functions: [],
      function_index: [
        {
          id: "FUNC-001",
          name: "helper",
          file_path: "src/util.c",
          line_range: { start: 1, end: 3 },
          calls: [],
          called_by: ["worker"],
          safety_critical: false,
        },
        {
          id: "FUNC-002",
          name: "worker",
          file_path: "src/main.c",
          line_range: { start: 4, end: 10 },
          calls: ["helper", "sqlite3_malloc", "helper"],
          called_by: [],
          safety_critical: false,
        },
      ],
      function_chunks: [],
      modules: [],
      data_flow_graph: { nodes: [], edges: [] },
      total_loc: 10,
    }))

    const result = await buildCallgraph()
    expect(result.status).toBe("success")
    expect(result.stage03_file).toBe(".matrix/data/software-analysis-stage-03-code.json")
    expect(result.output_file).toBe(".matrix/data/callgraph.json")
    expect(result.caller_count).toBe(2)
    expect(result.edge_count).toBe(2)
    expect(existsSync(join(root, ".matrix", "data", "callgraph.json"))).toBe(true)

    const callgraph = CallGraph.parse(readJson(join(root, ".matrix", "data", "callgraph.json")))
    expect(callgraph).toEqual({
      helper: [],
      worker: ["helper", "sqlite3_malloc"],
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
          file_path: "src/root.c",
          line_range: { start: 10, end: 12 },
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
      modules: [],
      data_flow_graph: { nodes: [], edges: [] },
      total_loc: 12,
    }))

    const result = await buildCallgraph()
    expect(result.status).toBe("success")

    const callgraph = CallGraph.parse(readJson(join(root, ".matrix", "data", "callgraph.json")))
    expect(callgraph).toEqual({
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
      modules: [],
      data_flow_graph: { nodes: [], edges: [] },
      total_loc: 12,
    }))
    writeJson(join(root, ".matrix", "data", "software-analysis-stage-03-functions", "chunk-0001.json"), {
      artifact_type: "software-analysis-stage-03-function-chunk",
      schema_version: 1,
      stage_id: "03-code",
      chunk_index: 0,
      created_date: "2026-04-15T00:00:00.000Z",
      functions: [
        {
          id: "FUNC-001",
          name: "alpha",
          file_path: "src/a.c",
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
          file_path: "src/a.c",
          line_range: { start: 5, end: 8 },
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

    const result = await buildCallgraph()
    expect(result.status).toBe("success")

    const callgraph = CallGraph.parse(readJson(join(root, ".matrix", "data", "callgraph.json")))
    expect(callgraph).toEqual({
      alpha: ["beta"],
      beta: [],
    })
  })

  test("merges duplicate caller names and keeps empty callers", async () => {
    const root = makeWorkspace()
    writeJson(join(root, ".matrix", "data", "software-analysis-stage-03-code.json"), createStage03Envelope({
      functions: [],
      function_index: [
        {
          id: "FUNC-001",
          name: "beginTimer",
          file_path: "src/a.c",
          line_range: { start: 1, end: 4 },
          calls: ["helper_b", "helper_a"],
          called_by: [],
          safety_critical: false,
        },
        {
          id: "FUNC-002",
          name: "beginTimer",
          file_path: "src/b.c",
          line_range: { start: 1, end: 4 },
          calls: ["helper_c", "helper_a"],
          called_by: [],
          safety_critical: false,
        },
        {
          id: "FUNC-003",
          name: "idle",
          file_path: "src/c.c",
          line_range: { start: 1, end: 2 },
          calls: [],
          called_by: [],
          safety_critical: false,
        },
      ],
      function_chunks: [],
      modules: [],
      data_flow_graph: { nodes: [], edges: [] },
      total_loc: 10,
    }))

    const result = await buildCallgraph()
    expect(result.status).toBe("success")
    expect(result.caller_count).toBe(2)
    expect(result.edge_count).toBe(3)

    const callgraph = CallGraph.parse(readJson(join(root, ".matrix", "data", "callgraph.json")))
    expect(callgraph).toEqual({
      beginTimer: ["helper_a", "helper_b", "helper_c"],
      idle: [],
    })
  })

  test("returns a clear error when the default stage-03 file is missing", async () => {
    makeWorkspace()

    const result = await buildCallgraph()
    expect(result.status).toBe("error")
    expect(result.error).toContain("Missing stage-03 artifact")
  })

  test("returns a clear error when the stage-03 file contains invalid JSON", async () => {
    const root = makeWorkspace()
    const stage03Path = join(root, ".matrix", "data", "software-analysis-stage-03-code.json")
    writeFileSync(stage03Path, "{ invalid json", "utf-8")

    const result = await buildCallgraph()
    expect(result.status).toBe("error")
    expect(result.error).toContain("Invalid JSON")
  })

  test("returns a clear error when the stage-03 schema is invalid", async () => {
    const root = makeWorkspace()
    writeJson(join(root, ".matrix", "data", "software-analysis-stage-03-code.json"), {
      artifact_type: "software-analysis-stage",
      schema_version: 1,
      stage_id: "03-code",
      created_date: "2026-04-15T00:00:00.000Z",
      payload: {
        function_index: "not-an-array",
      },
    })

    const result = await buildCallgraph()
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

    const result = await buildCallgraph()
    expect(result.status).toBe("error")
    expect(result.error).toContain("Missing stage-03 function chunk")
  })
})
