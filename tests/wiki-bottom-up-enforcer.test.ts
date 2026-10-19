import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type { SoftwareAnalysisReport } from "../src/schema/sut"
import {
  collectFunctionDependencies,
  collectModuleDependencies,
  createWikiBottomUpEnforcerHook,
  validateFunctionDependencyContext,
  validateModuleDependencyContext,
} from "../src/hooks/wiki-bottom-up-enforcer"

const analysisFixture: SoftwareAnalysisReport = {
  project_name: "demo",
  created_date: "2026-03-13",
  requirements: [],
  interfaces: [],
  data_flow_graph: { nodes: [], edges: [] },
  functions: [
    {
      id: "FUNC-001",
      name: "leaf_read",
      file_path: "src/leaf.c",
      line_range: { start: 1, end: 10 },
      return_type: "int",
      parameters: [],
      calls: [],
      called_by: ["middle_process"],
      safety_critical: false,
      related_requirements: [],
    },
    {
      id: "FUNC-002",
      name: "middle_process",
      file_path: "src/middle.c",
      line_range: { start: 1, end: 20 },
      return_type: "int",
      parameters: [],
      calls: ["leaf_read"],
      called_by: ["top_entry"],
      safety_critical: false,
      related_requirements: [],
    },
    {
      id: "FUNC-003",
      name: "top_entry",
      file_path: "src/top.c",
      line_range: { start: 1, end: 30 },
      return_type: "int",
      parameters: [],
      calls: ["middle_process"],
      called_by: [],
      safety_critical: false,
      related_requirements: [],
    },
  ],
  modules: [
    { name: "leaf", path: "src/leaf.c", functions: ["leaf_read"] },
    { name: "middle", path: "src/middle.c", functions: ["middle_process"] },
    { name: "top", path: "src/top.c", functions: ["top_entry"] },
  ],
  summary: {
    total_functions: 3,
    total_loc: 60,
    total_requirements: 0,
    total_interfaces: 0,
    safety_critical_functions: 0,
  },
}

const sameModuleFunctionFixture: SoftwareAnalysisReport = {
  project_name: "same-module-demo",
  created_date: "2026-03-13",
  requirements: [],
  interfaces: [],
  data_flow_graph: { nodes: [], edges: [] },
  functions: [
    {
      id: "FUNC-101",
      name: "filter_init",
      file_path: "src/temp_monitor.c",
      line_range: { start: 1, end: 10 },
      return_type: "void",
      parameters: [],
      calls: [],
      called_by: ["filter_update"],
      safety_critical: false,
      related_requirements: [],
    },
    {
      id: "FUNC-102",
      name: "filter_update",
      file_path: "src/temp_monitor.c",
      line_range: { start: 11, end: 25 },
      return_type: "int32_t",
      parameters: [],
      calls: ["filter_init"],
      called_by: ["main"],
      safety_critical: false,
      related_requirements: [],
    },
  ],
  modules: [
    { name: "temp_monitor", path: "src/temp_monitor.c", functions: ["filter_init", "filter_update"] },
  ],
  summary: {
    total_functions: 2,
    total_loc: 25,
    total_requirements: 0,
    total_interfaces: 0,
    safety_critical_functions: 0,
  },
}

const moduleScopedFixture: SoftwareAnalysisReport = {
  project_name: "module-scoped-demo",
  created_date: "2026-03-17",
  requirements: [],
  interfaces: [],
  data_flow_graph: { nodes: [], edges: [] },
  functions: [
    {
      id: "FUNC-012",
      name: "load_shed_noncritical",
      file_path: "power_control.c",
      line_range: { start: 1, end: 5 },
      return_type: "void",
      parameters: [],
      calls: [],
      called_by: ["battery_manage"],
      safety_critical: true,
      related_requirements: [],
    },
    {
      id: "FUNC-013",
      name: "load_restore_noncritical",
      file_path: "power_control.c",
      line_range: { start: 6, end: 10 },
      return_type: "void",
      parameters: [],
      calls: [],
      called_by: ["battery_manage"],
      safety_critical: true,
      related_requirements: [],
    },
    {
      id: "FUNC-008",
      name: "battery_manage",
      file_path: "power_control.c",
      line_range: { start: 11, end: 40 },
      return_type: "void",
      parameters: [],
      calls: ["load_shed_noncritical", "load_restore_noncritical"],
      called_by: ["main"],
      safety_critical: true,
      related_requirements: [],
    },
  ],
  modules: [
    {
      name: "power_control",
      path: "power_control.c",
      functions: ["load_shed_noncritical", "load_restore_noncritical", "battery_manage"],
    },
  ],
  summary: {
    total_functions: 3,
    total_loc: 40,
    total_requirements: 0,
    total_interfaces: 0,
    safety_critical_functions: 3,
  },
}

describe("wiki bottom-up dependency helpers", () => {
  test("collects direct module dependencies from call graph", () => {
    expect(collectModuleDependencies(analysisFixture, "leaf")).toEqual([])
    expect(collectModuleDependencies(analysisFixture, "middle")).toEqual(["leaf"])
    expect(collectModuleDependencies(analysisFixture, "top")).toEqual(["middle"])
  })

  test("collects function dependencies for upper-layer functions", () => {
    expect(collectFunctionDependencies(analysisFixture, "FUNC-001")).toEqual([])
    expect(collectFunctionDependencies(analysisFixture, "FUNC-003")).toEqual([
      {
        calleeId: "FUNC-002",
        calleeName: "middle_process",
        moduleName: "middle",
        sameModule: false,
      },
    ])
    expect(collectFunctionDependencies(analysisFixture, "top_entry")).toEqual([
      {
        calleeId: "FUNC-002",
        calleeName: "middle_process",
        moduleName: "middle",
        sameModule: false,
      },
    ])
  })

  test("requires lower-layer module wiki artifact to exist and be read before upper-layer module write", () => {
    const root = mkdtempSync(join(tmpdir(), "wiki-bottom-up-module-"))
    mkdirSync(join(root, ".matrix", "wiki", "modules"), { recursive: true })

    const missingArtifact = validateModuleDependencyContext(
      analysisFixture,
      "top",
      new Set<string>(),
      root,
    )
    expect(missingArtifact.missingArtifacts).toEqual([".matrix/wiki/modules/middle.json"])
    expect(missingArtifact.missingReads).toEqual([".matrix/wiki/modules/middle.json"])

    writeFileSync(
      join(root, ".matrix", "wiki", "modules", "middle.json"),
      "{}",
      "utf-8",
    )

    const satisfied = validateModuleDependencyContext(
      analysisFixture,
      "top",
      new Set<string>([".matrix/wiki/modules/middle.json"]),
      root,
    )
    expect(satisfied.missingArtifacts).toEqual([])
    expect(satisfied.missingReads).toEqual([])
  })

  test("accepts function context when callee function wiki was read", () => {
    const root = mkdtempSync(join(tmpdir(), "wiki-bottom-up-function-"))
    mkdirSync(join(root, ".matrix", "wiki", "functions"), { recursive: true })
    mkdirSync(join(root, ".matrix", "wiki", "modules"), { recursive: true })

    writeFileSync(
      join(root, ".matrix", "wiki", "functions", "middle_process.json"),
      "{}",
      "utf-8",
    )

    const missing = validateFunctionDependencyContext(
      analysisFixture,
      "FUNC-003",
      new Set<string>(),
      root,
    )
    expect(missing.missingContexts).toHaveLength(1)

    const byFunctionRead = validateFunctionDependencyContext(
      analysisFixture,
      "FUNC-003",
      new Set<string>([".matrix/wiki/functions/middle_process.json"]),
      root,
    )
    expect(byFunctionRead.missingContexts).toEqual([])

  })

  test("falls back to stage-03 code artifact when software-analysis.json is absent", () => {
    const root = mkdtempSync(join(tmpdir(), "wiki-bottom-up-stage03-"))
    mkdirSync(join(root, ".matrix", "data"), { recursive: true })
    mkdirSync(join(root, ".matrix", "data", "software-analysis-stage-03-functions"), { recursive: true })
    mkdirSync(join(root, ".matrix", "wiki", "functions"), { recursive: true })

    writeFileSync(
      join(root, ".matrix", "data", "software-analysis-stage-03-code.json"),
      JSON.stringify({
        artifact_type: "software-analysis-stage",
        schema_version: 1,
        stage_id: "03-code",
        created_date: "2026-03-31",
        payload: {
          functions: [],
          function_index: analysisFixture.functions.map((fn, index) => ({
            id: fn.id,
            name: fn.name,
            file_path: fn.file_path,
            line_range: fn.line_range,
            calls: fn.calls,
            called_by: fn.called_by,
            safety_critical: fn.safety_critical,
            chunk_index: 0,
            chunk_file_path: ".matrix/data/software-analysis-stage-03-functions/chunk-0001.json",
          })),
          function_chunks: [
            {
              chunk_index: 0,
              file_path: ".matrix/data/software-analysis-stage-03-functions/chunk-0001.json",
              function_count: analysisFixture.functions.length,
              first_function_id: analysisFixture.functions[0]?.id,
              last_function_id: analysisFixture.functions[analysisFixture.functions.length - 1]?.id,
            },
          ],
          modules: analysisFixture.modules,
          data_flow_graph: analysisFixture.data_flow_graph,
          total_loc: analysisFixture.summary.total_loc,
        },
      }, null, 2),
      "utf-8",
    )
    writeFileSync(
      join(root, ".matrix", "data", "software-analysis-stage-03-functions", "chunk-0001.json"),
      JSON.stringify({
        artifact_type: "software-analysis-stage-03-function-chunk",
        schema_version: 1,
        stage_id: "03-code",
        chunk_index: 0,
        created_date: "2026-03-31",
        functions: analysisFixture.functions,
      }, null, 2),
      "utf-8",
    )

    writeFileSync(
      join(root, ".matrix", "wiki", "functions", "middle_process.json"),
      "{}",
      "utf-8",
    )

    const validation = validateFunctionDependencyContext(
      analysisFixture,
      "top_entry",
      new Set<string>([".matrix/wiki/functions/middle_process.json"]),
      root,
    )

    expect(validation.missingContexts).toEqual([])
  })

  test("falls back to stage-03 code artifact when software-analysis.json exists but is unusable", () => {
    const root = mkdtempSync(join(tmpdir(), "wiki-bottom-up-invalid-final-"))
    mkdirSync(join(root, ".matrix", "data"), { recursive: true })
    mkdirSync(join(root, ".matrix", "data", "software-analysis-stage-03-functions"), { recursive: true })
    mkdirSync(join(root, ".matrix", "wiki", "functions"), { recursive: true })

    writeFileSync(
      join(root, ".matrix", "data", "software-analysis.json"),
      JSON.stringify({
        artifact_type: "software-analysis",
        schema_version: 1,
        summary: {
          total_functions: 3,
        },
      }, null, 2),
      "utf-8",
    )
    writeFileSync(
      join(root, ".matrix", "data", "software-analysis-stage-03-code.json"),
      JSON.stringify({
        artifact_type: "software-analysis-stage",
        schema_version: 1,
        stage_id: "03-code",
        created_date: "2026-03-31",
        payload: {
          functions: [],
          function_index: analysisFixture.functions.map((fn) => ({
            id: fn.id,
            name: fn.name,
            file_path: fn.file_path,
            line_range: fn.line_range,
            calls: fn.calls,
            called_by: fn.called_by,
            safety_critical: fn.safety_critical,
            chunk_index: 0,
            chunk_file_path: ".matrix/data/software-analysis-stage-03-functions/chunk-0001.json",
          })),
          function_chunks: [
            {
              chunk_index: 0,
              file_path: ".matrix/data/software-analysis-stage-03-functions/chunk-0001.json",
              function_count: analysisFixture.functions.length,
              first_function_id: analysisFixture.functions[0]?.id,
              last_function_id: analysisFixture.functions[analysisFixture.functions.length - 1]?.id,
            },
          ],
          modules: analysisFixture.modules,
          data_flow_graph: analysisFixture.data_flow_graph,
          total_loc: analysisFixture.summary.total_loc,
        },
      }, null, 2),
      "utf-8",
    )
    writeFileSync(
      join(root, ".matrix", "data", "software-analysis-stage-03-functions", "chunk-0001.json"),
      JSON.stringify({
        artifact_type: "software-analysis-stage-03-function-chunk",
        schema_version: 1,
        stage_id: "03-code",
        chunk_index: 0,
        created_date: "2026-03-31",
        functions: analysisFixture.functions,
      }, null, 2),
      "utf-8",
    )
    writeFileSync(
      join(root, ".matrix", "wiki", "functions", "middle_process.json"),
      "{}",
      "utf-8",
    )

    const validation = validateFunctionDependencyContext(
      analysisFixture,
      "top_entry",
      new Set<string>([".matrix/wiki/functions/middle_process.json"]),
      root,
    )

    expect(validation.missingContexts).toEqual([])
  })

  test("hook enforces bottom-up function dependencies using stage-03 artifact when final software-analysis.json is absent", async () => {
    const root = mkdtempSync(join(tmpdir(), "wiki-bottom-up-stage03-hook-"))
    mkdirSync(join(root, ".matrix", "data"), { recursive: true })
    mkdirSync(join(root, ".matrix", "data", "software-analysis-stage-03-functions"), { recursive: true })
    mkdirSync(join(root, ".matrix", "wiki", "functions"), { recursive: true })

    writeFileSync(
      join(root, ".matrix", "data", "software-analysis-stage-03-code.json"),
      JSON.stringify({
        artifact_type: "software-analysis-stage",
        schema_version: 1,
        stage_id: "03-code",
        created_date: "2026-03-31",
        payload: {
          functions: [],
          function_index: analysisFixture.functions.map((fn) => ({
            id: fn.id,
            name: fn.name,
            file_path: fn.file_path,
            line_range: fn.line_range,
            calls: fn.calls,
            called_by: fn.called_by,
            safety_critical: fn.safety_critical,
            chunk_index: 0,
            chunk_file_path: ".matrix/data/software-analysis-stage-03-functions/chunk-0001.json",
          })),
          function_chunks: [
            {
              chunk_index: 0,
              file_path: ".matrix/data/software-analysis-stage-03-functions/chunk-0001.json",
              function_count: analysisFixture.functions.length,
              first_function_id: analysisFixture.functions[0]?.id,
              last_function_id: analysisFixture.functions[analysisFixture.functions.length - 1]?.id,
            },
          ],
          modules: analysisFixture.modules,
          data_flow_graph: analysisFixture.data_flow_graph,
          total_loc: analysisFixture.summary.total_loc,
        },
      }, null, 2),
      "utf-8",
    )
    writeFileSync(
      join(root, ".matrix", "data", "software-analysis-stage-03-functions", "chunk-0001.json"),
      JSON.stringify({
        artifact_type: "software-analysis-stage-03-function-chunk",
        schema_version: 1,
        stage_id: "03-code",
        chunk_index: 0,
        created_date: "2026-03-31",
        functions: analysisFixture.functions,
      }, null, 2),
      "utf-8",
    )

    const hook = createWikiBottomUpEnforcerHook(root)
    const output = {
      title: "write",
      output: "Saved to .matrix/wiki/functions/top_entry.json",
      metadata: {} as Record<string, unknown>,
    }

    await hook["tool.execute.after"]?.(
      { tool: "write", sessionID: "stage03-only" },
      output,
    )

    expect(output.output).toContain("[BOTTOM-UP GUARD]")
    expect(output.output).toContain("middle_process")
    expect(output.metadata.wiki_bottom_up_guard).toBe("failed")
  })

  test("requires same-module callee function wiki to be read before caller function write", () => {
    const root = mkdtempSync(join(tmpdir(), "wiki-bottom-up-same-module-"))
    mkdirSync(join(root, ".matrix", "wiki", "functions"), { recursive: true })

    const missingArtifact = validateFunctionDependencyContext(
      sameModuleFunctionFixture,
      "FUNC-102",
      new Set<string>(),
      root,
    )
    expect(missingArtifact.missingContexts).toHaveLength(1)
    expect(missingArtifact.missingContexts[0]?.calleeId).toBe("FUNC-101")

    writeFileSync(
      join(root, ".matrix", "wiki", "functions", "filter_init.json"),
      "{}",
      "utf-8",
    )

    const stillMissingRead = validateFunctionDependencyContext(
      sameModuleFunctionFixture,
      "FUNC-102",
      new Set<string>(),
      root,
    )
    expect(stillMissingRead.missingContexts).toHaveLength(1)

    const satisfied = validateFunctionDependencyContext(
      sameModuleFunctionFixture,
      "FUNC-102",
      new Set<string>([".matrix/wiki/functions/filter_init.json"]),
      root,
    )
    expect(satisfied.missingContexts).toEqual([])
  })

  test("accepts name-based function wiki artifacts and caller references", () => {
    const root = mkdtempSync(join(tmpdir(), "wiki-bottom-up-name-based-"))
    mkdirSync(join(root, ".matrix", "wiki", "functions"), { recursive: true })

    writeFileSync(
      join(root, ".matrix", "wiki", "functions", "filter_init.json"),
      "{}",
      "utf-8",
    )
    writeFileSync(
      join(root, ".matrix", "wiki", "functions", "filter_update.json"),
      "{}",
      "utf-8",
    )

    const missing = validateFunctionDependencyContext(
      {
        ...sameModuleFunctionFixture,
        functions: [
          ...sameModuleFunctionFixture.functions,
          {
            id: "FUNC-103",
            name: "main",
            file_path: "src/temp_monitor.c",
            line_range: { start: 26, end: 40 },
            return_type: "int",
            parameters: [],
            calls: ["filter_init", "filter_update"],
            called_by: [],
            safety_critical: false,
            related_requirements: [],
          },
        ],
        modules: [
          {
            name: "temp_monitor",
            path: "src/temp_monitor.c",
            functions: ["filter_init", "filter_update", "main"],
          },
        ],
        summary: {
          total_functions: 3,
          total_loc: 40,
          total_requirements: 0,
          total_interfaces: 0,
          safety_critical_functions: 0,
        },
      },
      "main",
      new Set<string>([".matrix/wiki/functions/filter_init.json"]),
      root,
    )
    expect(missing.missingContexts).toHaveLength(1)
    expect(missing.missingContexts[0]?.calleeName).toBe("filter_update")

    const satisfied = validateFunctionDependencyContext(
      {
        ...sameModuleFunctionFixture,
        functions: [
          ...sameModuleFunctionFixture.functions,
          {
            id: "FUNC-103",
            name: "main",
            file_path: "src/temp_monitor.c",
            line_range: { start: 26, end: 40 },
            return_type: "int",
            parameters: [],
            calls: ["filter_init", "filter_update"],
            called_by: [],
            safety_critical: false,
            related_requirements: [],
          },
        ],
        modules: [
          {
            name: "temp_monitor",
            path: "src/temp_monitor.c",
            functions: ["filter_init", "filter_update", "main"],
          },
        ],
        summary: {
          total_functions: 3,
          total_loc: 40,
          total_requirements: 0,
          total_interfaces: 0,
          safety_critical_functions: 0,
        },
      },
      "main",
      new Set<string>([
        ".matrix/wiki/functions/filter_init.json",
        ".matrix/wiki/functions/filter_update.json",
      ]),
      root,
    )
    expect(satisfied.missingContexts).toEqual([])
  })

  test("resolves module-hinted function references against flat function wiki paths", () => {
    const root = mkdtempSync(join(tmpdir(), "wiki-bottom-up-module-scoped-"))
    mkdirSync(join(root, ".matrix", "wiki", "functions"), { recursive: true })

    writeFileSync(
      join(root, ".matrix", "wiki", "functions", "load_shed_noncritical.json"),
      "{}",
      "utf-8",
    )
    writeFileSync(
      join(root, ".matrix", "wiki", "functions", "load_restore_noncritical.json"),
      "{}",
      "utf-8",
    )

    const missing = validateFunctionDependencyContext(
      moduleScopedFixture,
      "power_control/battery_manage",
      new Set<string>(),
      root,
    )
    expect(missing.missingContexts).toHaveLength(2)

    const satisfied = validateFunctionDependencyContext(
      moduleScopedFixture,
      "power_control/battery_manage",
      new Set<string>([
        ".matrix/wiki/functions/load_shed_noncritical.json",
        ".matrix/wiki/functions/load_restore_noncritical.json",
      ]),
      root,
    )
    expect(satisfied.missingContexts).toEqual([])
  })

  test("injects a skip directive when the scheduled function wiki already exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "wiki-bottom-up-skip-existing-"))
    mkdirSync(join(root, ".matrix", "wiki", "functions"), { recursive: true })

    writeFileSync(
      join(root, ".matrix", "wiki", "functions", "filter_update.json"),
      JSON.stringify({
        id: "FUNC-102",
        name: "filter_update",
        file_path: "src/temp_monitor.c",
        line_range: { start: 11, end: 25 },
        module_id: "temp_monitor",
        signature: "int32_t filter_update(void)",
        parameters: [],
        return_value: {
          type: "int32_t",
          description: "Status code returned by filter_update.",
        },
        summary: "Updates the filter state.",
        control_flow: { branches: 0, loops: 0, early_returns: 0, description: "simple" },
        testing_hints: { suggested_focus: [], stubbing_needs: [] },
        preconditions: [],
        postconditions: [],
        boundary_conditions: [],
        error_handling: [],
        side_effects: [],
        requirement_fulfillment: [],
      }),
      "utf-8",
    )

    const hook = createWikiBottomUpEnforcerHook(root)
    const output = {
      message: {},
      parts: [
        {
          type: "text",
          text:
            "wiki_mode=function-analysis function_id=FUNC-102 function_name=filter_update " +
            "function_wiki_path=.matrix/wiki/functions/filter_update.json",
        },
      ],
    }

    await hook["chat.message"]?.(
      { sessionID: "skip-existing", agent: "wiki-executor" },
      output,
    )

    const combined = output.parts
      .map((part: any) => (typeof part.text === "string" ? part.text : ""))
      .join("\n")

    expect(combined).toContain("<wiki-existing-function-artifact>")
    expect(combined).toContain("A schema-valid function wiki with parameters and return_value already exists at .matrix/wiki/functions/filter_update.json")
    expect(combined).toContain("You MUST skip regeneration")
    expect(combined).toContain("do NOT rewrite .matrix/wiki/functions/filter_update.json")
  })

  test("allows missing callee wiki when caller and callee are in the same detected function cycle", async () => {
    const root = mkdtempSync(join(tmpdir(), "wiki-bottom-up-cycle-allow-"))
    mkdirSync(join(root, ".matrix", "data"), { recursive: true })
    mkdirSync(join(root, ".matrix", "plans"), { recursive: true })

    writeFileSync(
      join(root, ".matrix", "plans", "wiki-generation-plan.json"),
      JSON.stringify({
        artifact_type: "wiki-generation-plan",
        created_date: "2026-04-02T04:00:00.000Z",
        project: {
          project_name: "cycle-demo",
          total_functions: 2,
          total_modules: 1,
        },
        reused_data_structures_wiki: false,
        module_order: ["cycle_mod"],
        detected_cycles: [
          {
            level: "function",
            module_name: "cycle_mod",
            members: ["FUNC-A", "FUNC-B"],
          },
        ],
        dependency_requirements: {
          cycle_mod: {
            module_dependencies: [],
            required_lower_layer_paths: [],
          },
        },
        per_module_function_order: {
          cycle_mod: ["FUNC-A", "FUNC-B"],
        },
        per_function_names: {
          "FUNC-A": "funcA",
          "FUNC-B": "funcB",
        },
        per_function_direct_callees: {
          "FUNC-A": ["FUNC-B"],
          "FUNC-B": ["FUNC-A"],
        },
        per_function_dependency_wiki_paths: {
          "FUNC-A": [".matrix/wiki/functions/funcB.json"],
          "FUNC-B": [".matrix/wiki/functions/funcA.json"],
        },
        per_function_source_locations: {
          "FUNC-A": { file_path: "src/cycle.c", line_range: { start: 1, end: 20 } },
          "FUNC-B": { file_path: "src/cycle.c", line_range: { start: 21, end: 40 } },
        },
        per_function_wiki_paths: {
          "FUNC-A": ".matrix/wiki/functions/funcA.json",
          "FUNC-B": ".matrix/wiki/functions/funcB.json",
        },
        reusable_function_wiki_paths: {},
        skipped_function_dispatches: [],
      }, null, 2),
      "utf-8",
    )

    const hook = createWikiBottomUpEnforcerHook(root)
    const output = {
      message: {},
      parts: [
        {
          type: "text",
          text:
            "wiki_mode=function-analysis function_id=FUNC-A function_name=funcA " +
            "required_callee_wiki_paths=[.matrix/wiki/functions/funcB.json]",
        },
      ],
    }

    await hook["chat.message"]?.(
      { sessionID: "cycle-allow", agent: "wiki-executor" },
      output,
    )

    const combined = output.parts
      .map((part: any) => (typeof part.text === "string" ? part.text : ""))
      .join("\n")

    expect(combined).not.toContain("<wiki-missing-dependencies>")
    expect(combined).toContain("<wiki-cycle-dependencies>")
    expect(combined).toContain(".matrix/wiki/functions/funcB.json")
    expect(combined).toContain("You may continue this function-analysis turn without those missing callee wiki files")
  })
})
