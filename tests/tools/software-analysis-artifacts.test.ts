import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { dirname, join } from "path"
import { SoftwareAnalysisReport } from "../../src/schema/sut"
import { docGenerator, softwareAnalysisArtifacts } from "../../src/tools"

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
  const dir = mkdtempSync(join(tmpdir(), "software-analysis-artifacts-"))
  TEMP_DIRS.push(dir)
  mkdirSync(join(dir, ".matrix", "data"), { recursive: true })
  process.chdir(dir)
  return dir
}

function buildValidPayloads(overrides?: Partial<Record<string, unknown>>) {
  const compileCommandsPath = ".matrix/data/compile_commands.json"
  const compilationEnvPath = ".matrix/data/compilation-env.json"

  return {
    "01-project": {
      project_name: "Demo Flight Controller",
      version: "1.0.0",
      csci_name: "DFC-CSCI",
      system_name: "DFC",
      software_level: "B",
      developer_org: "Matrix",
      source_code_dirs: ["src"],
      requirement_document_paths: ["docs/requirements.md"],
      include_dirs: ["include"],
      excluded_dirs: ["third_party"],
      build_files: ["Makefile"],
      ...(overrides?.["01-project"] as Record<string, unknown> | undefined),
    },
    "02-requirements": {
      requirements: [
        {
          id: "REQ-001",
          title: "Initialize system",
          description: "The system shall initialize the platform before entering the main loop.",
          type: "functional",
          priority: "critical",
          acceptance_criteria: ["Initialization completes before main loop."],
          related_requirements: [],
          resolved_references: [],
          unresolved_references: [],
        },
      ],
      interfaces: [
        {
          id: "IF-001",
          name: "Telemetry UART",
          type: "output",
          protocol: "UART",
          data_format: "binary frame",
        },
      ],
      ...(overrides?.["02-requirements"] as Record<string, unknown> | undefined),
    },
    "03-code": {
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
          line_range: { start: 1, end: 12 },
          return_type: "void",
          parameters: [],
          cyclomatic_complexity: 1,
          calls: [],
          called_by: ["main"],
          safety_critical: true,
          related_requirements: ["REQ-001"],
        },
      ],
      modules: [
        {
          name: "core",
          path: "src",
          functions: ["main", "timer_isr"],
        },
      ],
      data_flow_graph: {
        nodes: [
          { id: "NODE-001", name: "main", type: "function", file_path: "src/main.c", line_range: { start: 1, end: 20 } },
          { id: "NODE-002", name: "timer_isr", type: "function", file_path: "src/isr.c", line_range: { start: 1, end: 12 } },
        ],
        edges: [
          { id: "EDGE-001", source_node: "NODE-001", target_node: "NODE-002", data_name: "tick", data_type: "event" },
        ],
      },
      total_loc: 42,
      ...(overrides?.["03-code"] as Record<string, unknown> | undefined),
    },
    "04-compilation": {
      compile_commands_path: compileCommandsPath,
      compilation_env_path: compilationEnvPath,
      stubs_dir: ".matrix/stubs",
      preprocessed_dir: ".matrix/preprocessed",
      ...(overrides?.["04-compilation"] as Record<string, unknown> | undefined),
    },
    "05-traceability": {
      traceability_matrix: [
        { req_id: "REQ-001", function_ids: ["main", "timer_isr"] },
      ],
      gap_analysis: [],
      orphan_analysis: [],
      runtime_environment: {
        target_cpu: "Cortex-M4",
        programming_language: "C",
        interrupt_table: [
          { name: "SysTick", handler_function: "timer_isr" },
        ],
        io_interfaces_summary: ["UART telemetry"],
      },
      main_functions_summary: "main initializes the platform and then services the runtime loop.",
      ...(overrides?.["05-traceability"] as Record<string, unknown> | undefined),
    },
    "06-finalize": {
      project_name: "Demo Flight Controller",
      version: "1.0.0",
      csci_name: "DFC-CSCI",
      system_name: "DFC",
      software_level: "B",
      developer_org: "Matrix",
      validation_summary: {
        step6: "passed",
      },
      ...(overrides?.["06-finalize"] as Record<string, unknown> | undefined),
    },
  }
}

function writeCompilationFiles(root: string) {
  writeJson(join(root, ".matrix", "data", "compile_commands.json"), [
    {
      directory: root,
      command: "clang -c src/main.c",
      file: "src/main.c",
    },
  ])
  writeJson(join(root, ".matrix", "data", "compilation-env.json"), {
    project_path: root,
    build_system: "make",
    compiler_dialect: "gcc",
    target_cpu: "Cortex-M4",
    compile_commands_path: ".matrix/data/compile_commands.json",
    files_indexed: 2,
    include_dirs: ["include"],
    defines: ["UNIT_TEST"],
    missing_headers: [],
    stubs: [],
    preprocessed_dir: ".matrix/preprocessed",
    created_date: "2026-03-31T00:00:00.000Z",
  })
}

async function saveStage(stageId: string, payload: unknown) {
  const toolImpl = softwareAnalysisArtifacts as unknown as {
    execute: (args: { mode: "save_stage"; stage_id: string; payload?: unknown; payload_json?: string | object }) => Promise<string>
  }
  return JSON.parse(await toolImpl.execute({
    mode: "save_stage",
    stage_id: stageId,
    payload,
  }))
}

async function saveStageFromPayloadFile(stageId: string, payloadFile: string) {
  const toolImpl = softwareAnalysisArtifacts as unknown as {
    execute: (args: { mode: "save_stage"; stage_id: string; payload_file: string }) => Promise<string>
  }
  return JSON.parse(await toolImpl.execute({
    mode: "save_stage",
    stage_id: stageId,
    payload_file: payloadFile,
  }))
}

async function finalizeArtifacts() {
  const toolImpl = softwareAnalysisArtifacts as unknown as {
    execute: (args: { mode: "finalize" }) => Promise<string>
  }
  return JSON.parse(await toolImpl.execute({ mode: "finalize" }))
}

async function saveAllStages(root: string, overrides?: Partial<Record<string, unknown>>) {
  writeCompilationFiles(root)
  const payloads = buildValidPayloads(overrides)
  for (const stageId of Object.keys(payloads)) {
    const result = await saveStage(stageId, payloads[stageId as keyof typeof payloads])
    expect(result.error).toBeUndefined()
  }
}

afterEach(() => {
  process.chdir(ORIGINAL_CWD)
  for (const dir of TEMP_DIRS.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("softwareAnalysisArtifacts", () => {
  test("save_stage writes the fixed stage artifact and updates the manifest", async () => {
    const root = makeWorkspace()
    writeCompilationFiles(root)

    const result = await saveStage("01-project", buildValidPayloads()["01-project"])
    expect(result.status).toBe("success")
    expect(result.file).toBe(".matrix/data/software-analysis-stage-01-project.json")
    expect(existsSync(join(root, ".matrix", "data", "software-analysis-stage-01-project.json"))).toBe(true)

    const manifest = readJson<any>(join(root, ".matrix", "data", "software-analysis-stage-manifest.json"))
    expect(manifest.stages["01-project"].exists).toBe(true)
    expect(manifest.stages["01-project"].summary.project_name).toBe("Demo Flight Controller")
  })

  test("save_stage also accepts object payload_json for agent compatibility", async () => {
    const root = makeWorkspace()
    writeCompilationFiles(root)
    const toolImpl = softwareAnalysisArtifacts as unknown as {
      execute: (args: { mode: "save_stage"; stage_id: string; payload_json: object }) => Promise<string>
    }

    const result = JSON.parse(await toolImpl.execute({
      mode: "save_stage",
      stage_id: "02-requirements",
      payload_json: buildValidPayloads()["02-requirements"],
    }))

    expect(result.status).toBe("success")
    const artifact = readJson<any>(join(root, ".matrix", "data", "software-analysis-stage-02-requirements.json"))
    expect(artifact.payload.requirements.length).toBe(1)
  })

  test("save_stage chunks stage 03 functions into tool-managed files", async () => {
    const root = makeWorkspace()
    writeCompilationFiles(root)

    const result = await saveStage("03-code", buildValidPayloads()["03-code"])
    expect(result.status).toBe("success")
    expect(result.summary.functions).toBe(2)
    expect(result.summary.function_chunks).toBe(1)

    const artifact = readJson<any>(join(root, ".matrix", "data", "software-analysis-stage-03-code.json"))
    expect(artifact.payload.functions).toEqual([])
    expect(artifact.payload.function_index).toHaveLength(2)
    expect(artifact.payload.function_chunks).toHaveLength(1)
    expect(artifact.payload.function_index[0]).toMatchObject({
      id: "FUNC-001",
      name: "main",
      return_type: "int",
      parameters: [],
      chunk_index: 0,
      chunk_file_path: ".matrix/data/software-analysis-stage-03-functions/chunk-0001.json",
    })

    const chunkPath = join(root, ".matrix", "data", "software-analysis-stage-03-functions", "chunk-0001.json")
    expect(existsSync(chunkPath)).toBe(true)
    const chunk = readJson<any>(chunkPath)
    expect(chunk.functions).toHaveLength(2)
    expect(chunk.functions.map((fn: any) => fn.name)).toEqual(["main", "timer_isr"])
  })

  test("save_stage removes the recommended temporary stage 03 tool file after canonical artifacts are saved", async () => {
    const root = makeWorkspace()
    writeCompilationFiles(root)
    const tempToolFile = join(root, ".matrix", "data", "software-analysis-stage-03-code-tool.json")
    writeJson(tempToolFile, buildValidPayloads()["03-code"])

    const result = await saveStageFromPayloadFile("03-code", tempToolFile)
    expect(result.status).toBe("success")
    expect(result.deleted_temp_payload_file).toBe(tempToolFile)
    expect(existsSync(tempToolFile)).toBe(false)
    expect(existsSync(join(root, ".matrix", "data", "software-analysis-stage-03-code.json"))).toBe(true)
    expect(existsSync(join(root, ".matrix", "data", "software-analysis-stage-03-functions", "chunk-0001.json"))).toBe(true)
  })

  test("save_stage chunks stage 05 traceability artifacts into tool-managed files", async () => {
    const root = makeWorkspace()
    writeCompilationFiles(root)

    const traceabilityMatrix = Array.from({ length: 205 }, (_, index) => ({
      req_id: `REQ-${String(index + 1).padStart(3, "0")}`,
      function_ids: ["main"],
    }))
    const gapAnalysis = Array.from({ length: 205 }, (_, index) => ({
      req_id: `REQ-GAP-${String(index + 1).padStart(3, "0")}`,
      reason: `Gap ${index + 1}`,
    }))
    const orphanAnalysis = Array.from({ length: 205 }, (_, index) => ({
      function_id: index === 0 ? "main" : `orphan_${index + 1}`,
      function_name: index === 0 ? "main" : `orphan_${index + 1}`,
      file_path: "src/orphan.c",
    }))

    const result = await saveStage("05-traceability", {
      ...buildValidPayloads()["05-traceability"],
      traceability_matrix: traceabilityMatrix,
      gap_analysis: gapAnalysis,
      orphan_analysis: orphanAnalysis,
    })

    expect(result.status).toBe("success")
    expect(result.summary.traceability_entries).toBe(205)
    expect(result.summary.gaps).toBe(205)
    expect(result.summary.orphans).toBe(205)

    const artifact = readJson<any>(join(root, ".matrix", "data", "software-analysis-stage-05-traceability.json"))
    expect(artifact.payload.traceability_matrix).toEqual([])
    expect(artifact.payload.gap_analysis).toEqual([])
    expect(artifact.payload.orphan_analysis).toEqual([])
    expect(artifact.payload.traceability_chunks).toHaveLength(2)
    expect(artifact.payload.gap_chunks).toHaveLength(2)
    expect(artifact.payload.orphan_chunks).toHaveLength(2)

    const traceabilityChunk = readJson<any>(
      join(root, ".matrix", "data", "software-analysis-stage-05-traceability", "traceability_matrix-chunk-0001.json"),
    )
    expect(traceabilityChunk.entries).toHaveLength(200)
    const gapChunk = readJson<any>(
      join(root, ".matrix", "data", "software-analysis-stage-05-traceability", "gap_analysis-chunk-0002.json"),
    )
    expect(gapChunk.entries).toHaveLength(5)
    const orphanChunk = readJson<any>(
      join(root, ".matrix", "data", "software-analysis-stage-05-traceability", "orphan_analysis-chunk-0002.json"),
    )
    expect(orphanChunk.entries).toHaveLength(5)
  })

  test("save_stage removes the recommended temporary stage 05 tool file after canonical artifacts are saved", async () => {
    const root = makeWorkspace()
    writeCompilationFiles(root)
    const tempToolFile = join(root, ".matrix", "data", "software-analysis-stage-05-traceability-tool.json")
    writeJson(tempToolFile, buildValidPayloads()["05-traceability"])

    const result = await saveStageFromPayloadFile("05-traceability", tempToolFile)
    expect(result.status).toBe("success")
    expect(result.deleted_temp_payload_file).toBe(tempToolFile)
    expect(existsSync(tempToolFile)).toBe(false)
    expect(existsSync(join(root, ".matrix", "data", "software-analysis-stage-05-traceability.json"))).toBe(true)
    expect(
      existsSync(join(root, ".matrix", "data", "software-analysis-stage-05-traceability", "traceability_matrix-chunk-0001.json")),
    ).toBe(true)
  })

  test("finalize builds software-analysis.json from staged artifacts and remains compatible with doc_generator", async () => {
    const root = makeWorkspace()
    await saveAllStages(root)

    const finalized = await finalizeArtifacts()
    expect(finalized.status).toBe("success")
    expect(finalized.file).toBe(".matrix/data/software-analysis.json")

    const outputPath = join(root, ".matrix", "data", "software-analysis.json")
    const parsed = SoftwareAnalysisReport.safeParse(readJson(outputPath))
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.summary.total_functions).toBe(2)
    expect(parsed.success && parsed.data.summary.total_requirements).toBe(1)
    expect(parsed.success && parsed.data.functions.map((fn) => fn.name)).toEqual(["main", "timer_isr"])

    const docTool = docGenerator as unknown as {
      execute: (args: { data_file: string; output_file: string; doc_type: "software-analysis" }) => Promise<string>
    }
    const reportResult = JSON.parse(await docTool.execute({
      data_file: outputPath,
      output_file: join(root, ".matrix", "reports", "software-analysis.md"),
      doc_type: "software-analysis",
    }))

    expect(reportResult.status).toBe("success")
    const markdown = readFileSync(join(root, ".matrix", "reports", "software-analysis.md"), "utf-8")
    expect(markdown).toContain("Demo Flight Controller")
    expect(markdown).toContain("Functions (2)")
  })

  test("finalize accepts stage 04 Windows drive paths with a leading slash", async () => {
    if (process.platform !== "win32") {
      expect(true).toBe(true)
      return
    }

    const root = makeWorkspace()
    const slashRoot = root.replace(/\\/g, "/")
    await saveAllStages(root, {
      "04-compilation": {
        compile_commands_path: `/${slashRoot}/.matrix/data/compile_commands.json`,
        compilation_env_path: `/${slashRoot}/.matrix/data/compilation-env.json`,
        stubs_dir: ".matrix/stubs",
        preprocessed_dir: ".matrix/preprocessed",
      },
    })

    const finalized = await finalizeArtifacts()
    expect(finalized.status).toBe("success")
    expect(existsSync(join(root, ".matrix", "data", "software-analysis.json"))).toBe(true)
  })

  test("finalize ignores a missing stage 04 compilation-env.json and does not regenerate it", async () => {
    const root = makeWorkspace()
    await saveAllStages(root)
    rmSync(join(root, ".matrix", "data", "compilation-env.json"), { force: true })

    const finalized = await finalizeArtifacts()
    expect(finalized.status).toBe("success")
    expect(finalized.warnings[0]).toContain("Skipped non-blocking compilation-env.json issue (missing_file)")
    expect(existsSync(join(root, ".matrix", "data", "compilation-env.json"))).toBe(false)

    const manifest = readJson<any>(join(root, ".matrix", "data", "software-analysis-stage-manifest.json"))
    expect(manifest.stages["04-compilation"].summary.compilation_env_valid).toBe(false)
    expect(manifest.stages["04-compilation"].summary.compilation_env_issue).toBe("missing_file")
  })

  test("finalize ignores an invalid stage 04 compilation-env.json schema without rewriting it", async () => {
    const root = makeWorkspace()
    await saveAllStages(root)
    const invalidEnv = {
      compiler_dialect: "c51",
      files_indexed: 1,
      stubs: [
        {
          header_name: "reg51.h",
          stub_path: join(root, ".matrix", "stubs", "reg51.h"),
          category: "compiler_builtin",
          symbols_stubbed: 3,
        },
      ],
    }
    writeJson(join(root, ".matrix", "data", "compilation-env.json"), invalidEnv)

    const finalized = await finalizeArtifacts()
    expect(finalized.status).toBe("success")
    expect(finalized.warnings[0]).toContain("Skipped non-blocking compilation-env.json issue (invalid_schema)")
    expect(readJson<any>(join(root, ".matrix", "data", "compilation-env.json"))).toEqual(invalidEnv)

    const manifest = readJson<any>(join(root, ".matrix", "data", "software-analysis-stage-manifest.json"))
    expect(manifest.stages["04-compilation"].summary.compilation_env_valid).toBe(false)
    expect(manifest.stages["04-compilation"].summary.compilation_env_issue).toBe("invalid_schema")
  })

  test("finalize ignores malformed stage 04 compilation-env.json content without rewriting it", async () => {
    const root = makeWorkspace()
    await saveAllStages(root)
    const envPath = join(root, ".matrix", "data", "compilation-env.json")
    writeFileSync(envPath, "{not valid json", "utf-8")

    const finalized = await finalizeArtifacts()
    expect(finalized.status).toBe("success")
    expect(finalized.warnings[0]).toContain("Skipped non-blocking compilation-env.json issue (invalid_json)")
    expect(readFileSync(envPath, "utf-8")).toBe("{not valid json")

    const manifest = readJson<any>(join(root, ".matrix", "data", "software-analysis-stage-manifest.json"))
    expect(manifest.stages["04-compilation"].summary.compilation_env_valid).toBe(false)
    expect(manifest.stages["04-compilation"].summary.compilation_env_issue).toBe("invalid_json")
  })

  test("finalize reports actionable diagnostics for missing stage 04 compile_commands.json", async () => {
    const root = makeWorkspace()
    await saveAllStages(root)
    rmSync(join(root, ".matrix", "data", "compile_commands.json"), { force: true })

    const finalized = await finalizeArtifacts()
    expect(finalized.status).toBeUndefined()
    expect(finalized.error).toContain("Missing compile_commands.json referenced by stage 04")
    expect(finalized.error).toContain("raw_path:")
    expect(finalized.error).toContain("cwd:")
    expect(finalized.error).toContain("checked_paths:")
    expect(finalized.error).toContain("re-save stage 04 with workspace-relative paths")
    expect(finalized.error).toContain("Do not inspect spelling")
  })

  test("finalize merges stage 03 function chunks across multiple chunk files", async () => {
    const root = makeWorkspace()
    writeCompilationFiles(root)

    const manyFunctions = Array.from({ length: 205 }, (_, index) => ({
      id: `FUNC-${String(index + 1).padStart(3, "0")}`,
      name: `fn_${String(index + 1).padStart(3, "0")}`,
      file_path: "src/big.c",
      line_range: { start: index + 1, end: index + 1 },
      return_type: "void",
      parameters: [],
      cyclomatic_complexity: 1,
      calls: [],
      called_by: [],
      safety_critical: false,
      related_requirements: [],
    }))

    await saveAllStages(root, {
      "03-code": {
        functions: manyFunctions,
        modules: [{ name: "big", path: "src/big.c", functions: manyFunctions.map((fn) => fn.name) }],
        data_flow_graph: { nodes: [], edges: [] },
        total_loc: 205,
      },
      "05-traceability": {
        ...buildValidPayloads()["05-traceability"],
        traceability_matrix: [],
        runtime_environment: {
          target_cpu: "Cortex-M4",
          programming_language: "C",
          interrupt_table: [],
          io_interfaces_summary: [],
        },
      },
    })

    const stage03 = readJson<any>(join(root, ".matrix", "data", "software-analysis-stage-03-code.json"))
    expect(stage03.payload.functions).toEqual([])
    expect(stage03.payload.function_index).toHaveLength(205)
    expect(stage03.payload.function_chunks).toHaveLength(2)
    expect(stage03.payload.function_index[0].chunk_index).toBe(0)
    expect(stage03.payload.function_index[0].return_type).toBe("void")
    expect(stage03.payload.function_index[0].parameters).toEqual([])
    expect(stage03.payload.function_index[204].chunk_index).toBe(1)

    const finalized = await finalizeArtifacts()
    expect(finalized.status).toBe("success")

    const output = readJson<any>(join(root, ".matrix", "data", "software-analysis.json"))
    expect(output.summary.total_functions).toBe(205)
    expect(output.functions).toHaveLength(205)
    expect(output.functions[0].name).toBe("fn_001")
    expect(output.functions[204].name).toBe("fn_205")
  })

  test("finalize merges stage 05 chunked traceability artifacts back into software-analysis.json", async () => {
    const root = makeWorkspace()
    writeCompilationFiles(root)

    const traceabilityMatrix = Array.from({ length: 205 }, (_, index) => ({
      req_id: "REQ-001",
      function_ids: index % 2 === 0 ? ["main"] : ["timer_isr"],
    }))

    await saveAllStages(root, {
      "05-traceability": {
        ...buildValidPayloads()["05-traceability"],
        traceability_matrix: traceabilityMatrix,
        gap_analysis: Array.from({ length: 205 }, () => ({
          req_id: "REQ-001",
          reason: "Needs tests",
        })),
        orphan_analysis: [],
      },
    })

    const stage05 = readJson<any>(join(root, ".matrix", "data", "software-analysis-stage-05-traceability.json"))
    expect(stage05.payload.traceability_chunks).toHaveLength(2)
    expect(stage05.payload.gap_chunks).toHaveLength(2)

    const finalized = await finalizeArtifacts()
    expect(finalized.status).toBe("success")

    const output = readJson<any>(join(root, ".matrix", "data", "software-analysis.json"))
    expect(output.traceability_matrix).toHaveLength(205)
    expect(output.gap_analysis).toHaveLength(205)
    expect(output.traceability_matrix[0].req_id).toBe("REQ-001")
    expect(output.gap_analysis[204].reason).toBe("Needs tests")
  })

  test("finalize fails when a required stage artifact is missing", async () => {
    const root = makeWorkspace()
    writeCompilationFiles(root)
    const payloads = buildValidPayloads()

    for (const stageId of ["01-project", "02-requirements", "03-code", "05-traceability", "06-finalize"]) {
      const result = await saveStage(stageId, payloads[stageId as keyof typeof payloads])
      expect(result.error).toBeUndefined()
    }

    const finalized = await finalizeArtifacts()
    expect(finalized.error).toContain("Missing required software analysis stage artifact")
  })

  test("finalize rejects duplicate requirement IDs", async () => {
    const root = makeWorkspace()
    await saveAllStages(root, {
      "02-requirements": {
        requirements: [
          {
            id: "REQ-001",
            title: "Req A",
            description: "A",
            type: "functional",
            priority: "high",
            acceptance_criteria: ["A"],
            related_requirements: [],
            resolved_references: [],
            unresolved_references: [],
          },
          {
            id: "REQ-001",
            title: "Req B",
            description: "B",
            type: "functional",
            priority: "high",
            acceptance_criteria: ["B"],
            related_requirements: [],
            resolved_references: [],
            unresolved_references: [],
          },
        ],
        interfaces: [],
      },
    })

    const finalized = await finalizeArtifacts()
    expect(finalized.error).toContain("Duplicate requirement IDs found")
  })

  test("finalize rejects duplicate function names within the same file", async () => {
    const root = makeWorkspace()
    await saveAllStages(root, {
      "03-code": {
        functions: [
          {
            id: "FUNC-001",
            name: "main",
            file_path: "src/main.c",
            line_range: { start: 1, end: 10 },
            return_type: "int",
            parameters: [],
            cyclomatic_complexity: 1,
            calls: [],
            called_by: [],
            safety_critical: false,
            related_requirements: ["REQ-001"],
          },
          {
            id: "FUNC-002",
            name: "main",
            file_path: "src/main.c",
            line_range: { start: 12, end: 20 },
            return_type: "int",
            parameters: [],
            cyclomatic_complexity: 1,
            calls: [],
            called_by: [],
            safety_critical: false,
            related_requirements: ["REQ-001"],
          },
        ],
        modules: [{ name: "core", path: "src", functions: ["main"] }],
        data_flow_graph: { nodes: [], edges: [] },
        total_loc: 20,
      },
    })

    const finalized = await finalizeArtifacts()
    expect(finalized.error).toContain("Duplicate function names within the same file")
  })

  test("finalize rejects modules that reference unknown functions", async () => {
    const root = makeWorkspace()
    await saveAllStages(root, {
      "03-code": {
        ...buildValidPayloads()["03-code"],
        modules: [{ name: "core", path: "src", functions: ["ghost_fn"] }],
      },
    })

    const finalized = await finalizeArtifacts()
    expect(finalized.error).toContain("references unknown function")
  })

  test("finalize allows compiler intrinsics in calls", async () => {
    const root = makeWorkspace()
    await saveAllStages(root, {
      "03-code": {
        ...buildValidPayloads()["03-code"],
        functions: [
          {
            ...buildValidPayloads()["03-code"].functions[0],
            calls: ["timer_isr", "_nop_", "abs", "crol", "_crol_"],
          },
          buildValidPayloads()["03-code"].functions[1],
        ],
      },
    })

    const finalized = await finalizeArtifacts()
    expect(finalized.status).toBe("success")

    const output = readJson<any>(join(root, ".matrix", "data", "software-analysis.json"))
    expect(output.functions[0].calls).toEqual(["timer_isr", "_nop_", "abs", "crol", "_crol_"])
  })

  test("finalize rejects interrupt handlers that are not present in functions", async () => {
    const root = makeWorkspace()
    await saveAllStages(root, {
      "05-traceability": {
        ...buildValidPayloads()["05-traceability"],
        runtime_environment: {
          target_cpu: "Cortex-M4",
          programming_language: "C",
          interrupt_table: [
            { name: "SysTick", handler_function: "missing_isr" },
          ],
          io_interfaces_summary: [],
        },
      },
    })

    const finalized = await finalizeArtifacts()
    expect(finalized.error).toContain("Interrupt handler \"missing_isr\" is not present in functions[]")
  })

  test("re-saving a stage and finalizing again refreshes software-analysis.json", async () => {
    const root = makeWorkspace()
    await saveAllStages(root)

    let finalized = await finalizeArtifacts()
    expect(finalized.status).toBe("success")

    const updatedRequirements = {
      ...buildValidPayloads()["02-requirements"],
      requirements: [
        {
          id: "REQ-001",
          title: "Initialize system v2",
          description: "The system shall initialize the platform before entering the main loop.",
          type: "functional",
          priority: "critical",
          acceptance_criteria: ["Initialization completes before main loop."],
          related_requirements: [],
          resolved_references: [],
          unresolved_references: [],
        },
      ],
    }
    const saveResult = await saveStage("02-requirements", updatedRequirements)
    expect(saveResult.status).toBe("success")

    finalized = await finalizeArtifacts()
    expect(finalized.status).toBe("success")

    const output = readJson<any>(join(root, ".matrix", "data", "software-analysis.json"))
    expect(output.requirements[0].title).toBe("Initialize system v2")
  })
})
