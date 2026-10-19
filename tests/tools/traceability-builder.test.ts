import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { dirname, join } from "path"
import { softwareAnalysisArtifacts, traceabilityBuilder } from "../../src/tools"

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
  const dir = mkdtempSync(join(tmpdir(), "traceability-builder-"))
  TEMP_DIRS.push(dir)
  mkdirSync(join(dir, ".matrix", "data"), { recursive: true })
  process.chdir(dir)
  return dir
}

async function saveStage(stageId: string, payload: unknown) {
  const toolImpl = softwareAnalysisArtifacts as unknown as {
    execute: (args: { mode: "save_stage"; stage_id: string; payload: unknown }) => Promise<string>
  }
  return JSON.parse(await toolImpl.execute({
    mode: "save_stage",
    stage_id: stageId,
    payload,
  }))
}

afterEach(() => {
  process.chdir(ORIGINAL_CWD)
  for (const dir of TEMP_DIRS.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("traceabilityBuilder", () => {
  test("builds a stage-05 tool payload from staged requirements/code artifacts and sparse overrides", async () => {
    const root = makeWorkspace()
    writeJson(join(root, ".matrix", "data", "compilation-env.json"), {
      project_path: root,
      build_system: "make",
      compiler_dialect: "gcc",
      target_cpu: "Cortex-M4",
      compile_commands_path: ".matrix/data/compile_commands.json",
      files_indexed: 2,
      include_dirs: [],
      defines: [],
      missing_headers: [],
      stubs: [],
      preprocessed_dir: ".matrix/preprocessed",
      created_date: "2026-04-02T00:00:00.000Z",
    })

    expect((await saveStage("02-requirements", {
      requirements: [
        {
          id: "REQ-001",
          title: "Initialize",
          description: "Initialize before main loop.",
          type: "functional",
          priority: "critical",
          acceptance_criteria: ["Main loop starts after init."],
          related_requirements: [],
          resolved_references: [],
          unresolved_references: [],
        },
        {
          id: "REQ-002",
          title: "Timer interrupt",
          description: "Timer interrupt shall service periodic work.",
          type: "functional",
          priority: "high",
          acceptance_criteria: ["Interrupt runs periodically."],
          related_requirements: [],
          resolved_references: [],
          unresolved_references: [],
        },
      ],
      interfaces: [],
    })).error).toBeUndefined()

    expect((await saveStage("03-code", {
      functions: [
        {
          id: "FUNC-001",
          name: "main",
          file_path: "src/main.c",
          line_range: { start: 1, end: 20 },
          return_type: "int",
          parameters: [],
          cyclomatic_complexity: 2,
          calls: ["timer_isr"],
          called_by: [],
          safety_critical: false,
          related_requirements: ["REQ-001"],
        },
        {
          id: "FUNC-002",
          name: "timer_isr",
          file_path: "src/isr.c",
          line_range: { start: 1, end: 10 },
          return_type: "void",
          parameters: [],
          cyclomatic_complexity: 1,
          calls: [],
          called_by: ["main"],
          safety_critical: true,
          related_requirements: [],
        },
      ],
      modules: [
        { name: "main", path: "src/main.c", functions: ["main"] },
        { name: "isr", path: "src/isr.c", functions: ["timer_isr"] },
      ],
      data_flow_graph: { nodes: [], edges: [] },
      total_loc: 30,
    })).error).toBeUndefined()

    const toolImpl = traceabilityBuilder as unknown as {
      execute: (args: {
        output_file: string
        link_overrides: Array<{ function_name: string; requirement_ids: string[] }>
        runtime_environment: { io_interfaces_summary: string[] }
      }) => Promise<string>
    }

    const result = JSON.parse(await toolImpl.execute({
      output_file: ".matrix/data/software-analysis-stage-05-traceability-tool.json",
      link_overrides: [
        { function_name: "timer_isr", requirement_ids: ["REQ-002"] },
      ],
      runtime_environment: {
        io_interfaces_summary: ["UART telemetry"],
      },
    }))

    expect(result.status).toBe("success")
    expect(result.summary.traceability_entries).toBe(2)
    expect(result.summary.gaps).toBe(0)
    expect(result.summary.orphans).toBe(0)
    expect(existsSync(join(root, ".matrix", "data", "software-analysis-stage-05-traceability-tool.json"))).toBe(true)

    const payload = readJson<any>(join(root, ".matrix", "data", "software-analysis-stage-05-traceability-tool.json"))
    expect(payload.traceability_matrix).toEqual([
      { req_id: "REQ-001", function_ids: ["FUNC-001"] },
      { req_id: "REQ-002", function_ids: ["FUNC-002"] },
    ])
    expect(payload.runtime_environment.target_cpu).toBe("Cortex-M4")
    expect(payload.runtime_environment.programming_language).toBe("C")
    expect(payload.runtime_environment.io_interfaces_summary).toEqual(["UART telemetry"])
    expect(payload.runtime_environment.interrupt_table).toEqual([
      { name: "timer_isr", handler_function: "FUNC-002" },
    ])
    expect(typeof payload.main_functions_summary).toBe("string")
    expect(payload.main_functions_summary.length).toBeGreaterThan(0)
  })
})
