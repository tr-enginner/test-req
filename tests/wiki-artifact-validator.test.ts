import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { createArtifactValidatorHook } from "../src/hooks/artifact-validator"

function makeProjectRoot() {
  return mkdtempSync(join(tmpdir(), "matrix-wiki-validator-"))
}

function writeSoftwareAnalysis(
  root: string,
  functions: Array<{
    id: string
    name: string
    file_path: string
    line_range: { start: number; end: number }
  }>,
) {
  mkdirSync(join(root, ".matrix", "data"), { recursive: true })
  writeFileSync(
    join(root, ".matrix", "data", "software-analysis.json"),
    JSON.stringify(
      {
        project_name: "demo",
        version: "1.0",
        created_date: "2026-03-30",
        requirements: [],
        interfaces: [],
        data_flow_graph: { nodes: [], edges: [] },
        functions: functions.map((fn) => ({
          ...fn,
          return_type: "void",
          parameters: [],
          calls: [],
          called_by: [],
          safety_critical: false,
          related_requirements: [],
        })),
        modules: functions.map((fn, index) => ({
          name: `mod_${index + 1}`,
          path: fn.file_path,
          functions: [fn.name],
        })),
        summary: {
          total_functions: functions.length,
          total_loc: functions.reduce(
            (sum, fn) => sum + (fn.line_range.end - fn.line_range.start + 1),
            0,
          ),
          total_requirements: 0,
          total_interfaces: 0,
          safety_critical_functions: 0,
        },
      },
      null,
      2,
    ),
    "utf-8",
  )
}

function writeValidFunctionWiki(
  root: string,
  fileName: string,
  id: string,
  name: string,
  options?: {
    file_path?: string
    line_range?: { start: number; end: number }
    module_id?: string
  },
) {
  mkdirSync(join(root, ".matrix", "wiki", "functions"), { recursive: true })
  writeFileSync(
    join(root, ".matrix", "wiki", "functions", fileName),
    JSON.stringify(
      {
        id,
        name,
        file_path: options?.file_path ?? "src/main.c",
        line_range: options?.line_range ?? { start: 1, end: 5 },
        module_id: options?.module_id ?? "mod_1",
        signature: `void ${name}(void)`,
        parameters: [],
        return_value: {
          type: "void",
          description: `${name} does not return a direct value.`,
        },
        summary: `${name} summary`,
        algorithm: {
          name: `${name}-algorithm`,
          description: `${name} algorithm`,
        },
        preconditions: [],
        postconditions: [],
        boundary_conditions: [],
        error_handling: [],
        control_flow: {
          branches: 0,
          loops: 0,
          early_returns: 0,
          description: "straight-line flow",
        },
        side_effects: [],
        concurrency: {
          is_isr: false,
          shared_resources: [],
          critical_sections: false,
          reentrancy: "unknown",
        },
        requirement_fulfillment: [],
        testing_hints: {
          suggested_focus: [],
          stubbing_needs: [],
        },
      },
      null,
      2,
    ),
    "utf-8",
  )
}

function writeWikiIndex(
  root: string,
  functionIndex: Record<
    string,
    {
      id: string
      module_id: string
      file_path: string
      safety_critical: boolean
    }
  >,
) {
  mkdirSync(join(root, ".matrix", "wiki"), { recursive: true })
  writeFileSync(
    join(root, ".matrix", "wiki", "index.json"),
    JSON.stringify(
      {
        project_name: "demo",
        version: "1.0",
        created_date: "2026-03-30",
        overview: "demo overview",
        tech_stack: {
          language: "C",
          compiler_dialect: "C99",
          target_cpu: "generic",
          frameworks: [],
        },
        architecture: {
          pattern: "layered",
          description: "demo architecture",
          layers: [],
        },
        modules: [],
        function_index: functionIndex,
        data_structures: [],
        data_flow_paths: [],
      },
      null,
      2,
    ),
    "utf-8",
  )
}

describe("wiki artifact validator", () => {
  test("flags incomplete function wiki json that does not match FunctionWiki schema", async () => {
    const root = makeProjectRoot()
    try {
      const targetDir = join(root, ".matrix", "wiki", "functions")
      mkdirSync(targetDir, { recursive: true })

      writeFileSync(
        join(targetDir, "InitDriver.json"),
        JSON.stringify(
          {
            functionId: "FUNC-004",
            functionName: "InitDriver",
            moduleName: "Main",
            summary: "minimal summary only",
          },
          null,
          2,
        ),
        "utf-8",
      )

      const hook = createArtifactValidatorHook(root)
      const output = {
        title: "write",
        output: "Saved to .matrix/wiki/functions/InitDriver.json",
        metadata: {} as Record<string, unknown>,
      }

      await hook["tool.execute.after"]?.(
        { tool: "write", sessionID: "wiki-invalid" },
        output,
      )

      expect(output.output).toContain("[SCHEMA VALIDATION FAILED]")
      expect(output.output).toContain("wiki function")
      expect(output.output).toContain("id")
      expect(output.metadata.schema_validation).toBe("failed")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("accepts complete function wiki json that matches FunctionWiki schema", async () => {
    const root = makeProjectRoot()
    try {
      const targetDir = join(root, ".matrix", "wiki", "functions")
      mkdirSync(targetDir, { recursive: true })

      writeFileSync(
        join(targetDir, "InitDriver.json"),
        JSON.stringify(
          {
            id: "FUNC-004",
            name: "InitDriver",
            file_path: "src/main.c",
            line_range: { start: 10, end: 30 },
            module_id: "MOD-001",
            signature: "void InitDriver(void)",
            parameters: [],
            return_value: {
              type: "void",
              description: "InitDriver does not return a direct value.",
            },
            summary:
              "Initializes the external DSP reset lines and emits a reset pulse sequence.",
            algorithm: {
              name: "gpio-reset-sequence",
              description:
                "Configure GPIO pins, drive reset high, delay, then drive reset low.",
            },
            preconditions: [],
            postconditions: [
              { description: "External DSP reset pulse has been issued." },
            ],
            boundary_conditions: [],
            error_handling: [],
            control_flow: {
              branches: 0,
              loops: 0,
              early_returns: 0,
              description:
                "Straight-line register configuration and delay sequence.",
            },
            side_effects: [
              {
                target: "GPIO16/GPIO17",
                access: "write",
                description: "Updates reset-related GPIO outputs.",
              },
            ],
            concurrency: {
              is_isr: false,
              shared_resources: [],
              critical_sections: false,
              reentrancy: "unknown",
            },
            requirement_fulfillment: [],
            testing_hints: {
              suggested_focus: [
                "Verify GPIO pulse ordering",
                "Check delay timing boundaries",
              ],
              stubbing_needs: ["GPIO register writes", "delay_us"],
            },
          },
          null,
          2,
        ),
        "utf-8",
      )

      const hook = createArtifactValidatorHook(root)
      const output = {
        title: "write",
        output: "Saved to .matrix/wiki/functions/InitDriver.json",
        metadata: {} as Record<string, unknown>,
      }

      await hook["tool.execute.after"]?.(
        { tool: "write", sessionID: "wiki-valid" },
        output,
      )

      expect(output.output).not.toContain("[SCHEMA VALIDATION FAILED]")
      expect(output.metadata.schema_validation).toBe("passed")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("flags legacy function wiki json missing simplified interface fields", async () => {
    const root = makeProjectRoot()
    try {
      const targetDir = join(root, ".matrix", "wiki", "functions")
      mkdirSync(targetDir, { recursive: true })

      writeFileSync(
        join(targetDir, "InitDriver.json"),
        JSON.stringify(
          {
            id: "FUNC-004",
            name: "InitDriver",
            file_path: "src/main.c",
            line_range: { start: 10, end: 30 },
            module_id: "MOD-001",
            signature: "void InitDriver(void)",
            summary: "Initializes the driver.",
            preconditions: [],
            postconditions: [],
            boundary_conditions: [],
            error_handling: [],
            control_flow: {
              branches: 0,
              loops: 0,
              early_returns: 0,
              description: "straight-line setup",
            },
            side_effects: [],
            requirement_fulfillment: [],
            testing_hints: {
              suggested_focus: [],
              stubbing_needs: [],
            },
          },
          null,
          2,
        ),
        "utf-8",
      )

      const hook = createArtifactValidatorHook(root)
      const output = {
        title: "write",
        output: "Saved to .matrix/wiki/functions/InitDriver.json",
        metadata: {} as Record<string, unknown>,
      }

      await hook["tool.execute.after"]?.(
        { tool: "write", sessionID: "wiki-legacy-interface" },
        output,
      )

      expect(output.output).toContain("[SCHEMA VALIDATION FAILED]")
      expect(output.output).toContain("parameters")
      expect(output.output).toContain("return_value")
      expect(output.metadata.schema_validation).toBe("failed")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("auto-repairs common function wiki field-shape drift instead of failing validation", async () => {
    const root = makeProjectRoot()
    try {
      const targetDir = join(root, ".matrix", "wiki", "functions")
      mkdirSync(targetDir, { recursive: true })

      writeFileSync(
        join(targetDir, "InitDriver.json"),
        JSON.stringify(
          {
            id: "FUNC-004",
            name: "InitDriver",
            file_path: "src/main.c",
            line_range: { start: 10, end: 30 },
            module_id: "MOD-001",
            signature: "void InitDriver(void)",
            parameters: [],
            return_value: {
              type: "void",
              description: "InitDriver does not return a direct value.",
            },
            summary: "Initializes the driver.",
            algorithm: "gpio reset sequence",
            preconditions: "hardware power is stable",
            postconditions: "driver is initialized",
            boundary_conditions: "timing may vary",
            error_handling: "returns early on invalid state",
            control_flow: "straight-line setup",
            side_effects: "writes hardware registers",
            concurrency: "non-isr context",
            requirement_fulfillment: "REQ-001 through initialization",
            testing_hints: "focus on timing tolerance",
          },
          null,
          2,
        ),
        "utf-8",
      )

      const hook = createArtifactValidatorHook(root)
      const output = {
        title: "write",
        output: "Saved to .matrix/wiki/functions/InitDriver.json",
        metadata: {} as Record<string, unknown>,
      }

      await hook["tool.execute.after"]?.(
        { tool: "write", sessionID: "wiki-auto-repair" },
        output,
      )

      expect(output.output).toContain("[SCHEMA AUTO-REPAIRED]")
      expect(output.output).not.toContain("[SCHEMA VALIDATION FAILED]")
      expect(output.metadata.schema_auto_repaired).toBe(true)
      expect(output.metadata.schema_validation).toBe("passed")

      const repaired = JSON.parse(
        readFileSync(join(targetDir, "InitDriver.json"), "utf-8"),
      ) as any
      expect(repaired.algorithm).toEqual({
        name: "summary-derived",
        description: "gpio reset sequence",
      })
      expect(repaired.control_flow).toEqual({
        branches: 0,
        loops: 0,
        early_returns: 0,
        description: "straight-line setup",
      })
      expect(repaired.testing_hints).toEqual({
        suggested_focus: [],
        stubbing_needs: [],
        complexity_warning: "focus on timing tolerance",
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("flags wiki index when software-analysis functions are missing from index and function artifacts", async () => {
    const root = makeProjectRoot()
    try {
      writeSoftwareAnalysis(root, [
        {
          id: "FUNC-001",
          name: "InitDriver",
          file_path: "src/main.c",
          line_range: { start: 1, end: 10 },
        },
        {
          id: "FUNC-002",
          name: "StartTask",
          file_path: "src/main.c",
          line_range: { start: 11, end: 20 },
        },
      ])
      writeValidFunctionWiki(root, "InitDriver.json", "FUNC-001", "InitDriver", {
        line_range: { start: 1, end: 10 },
      })
      writeWikiIndex(root, {
        InitDriver: {
          id: "FUNC-001",
          module_id: "mod_1",
          file_path: "src/main.c",
          safety_critical: false,
        },
      })

      const hook = createArtifactValidatorHook(root)
      const output = {
        title: "write",
        output: "Saved to .matrix/wiki/index.json",
        metadata: {} as Record<string, unknown>,
      }

      await hook["tool.execute.after"]?.(
        { tool: "write", sessionID: "wiki-index-incomplete" },
        output,
      )

      expect(output.output).toContain("[WIKI INVENTORY CHECK FAILED]")
      expect(output.output).toContain("StartTask")
      expect(output.output).toContain("software-analysis.json is the authoritative function ledger")
      expect(output.output).toContain("run one function-analysis task for each missing function")
      expect(output.output).toContain("immediately resume wiki-scheduler dispatch")
      expect(output.metadata.wiki_inventory_validation).toBe("failed")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("flags wiki index when a function wiki file exists but does not exactly match software-analysis", async () => {
    const root = makeProjectRoot()
    try {
      writeSoftwareAnalysis(root, [
        {
          id: "FUNC-001",
          name: "InitDriver",
          file_path: "src/main.c",
          line_range: { start: 10, end: 30 },
        },
      ])
      writeValidFunctionWiki(root, "InitDriver.json", "FUNC-999", "InitDriver", {
        line_range: { start: 1, end: 5 },
      })
      writeWikiIndex(root, {
        InitDriver: {
          id: "FUNC-999",
          module_id: "mod_1",
          file_path: "src/main.c",
          safety_critical: false,
        },
      })

      const hook = createArtifactValidatorHook(root)
      const output = {
        title: "write",
        output: "Saved to .matrix/wiki/index.json",
        metadata: {} as Record<string, unknown>,
      }

      await hook["tool.execute.after"]?.(
        { tool: "write", sessionID: "wiki-index-mismatch" },
        output,
      )

      expect(output.output).toContain("[WIKI INVENTORY CHECK FAILED]")
      expect(output.output).toContain('wiki/index.json entry for "InitDriver" does not match software-analysis.json')
      expect(output.output).toContain('Function wiki ".matrix/wiki/functions/InitDriver.json" does not match software-analysis.json')
      expect(output.metadata.wiki_inventory_validation).toBe("failed")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("flags function wiki writes when existing index entry is not reconciled", async () => {
    const root = makeProjectRoot()
    try {
      writeSoftwareAnalysis(root, [
        {
          id: "FUNC-001",
          name: "InitDriver",
          file_path: "src/main.c",
          line_range: { start: 10, end: 30 },
        },
      ])
      writeWikiIndex(root, {
        InitDriver: {
          id: "FUNC-777",
          module_id: "mod_1",
          file_path: "src/main.c",
          safety_critical: false,
        },
      })
      writeValidFunctionWiki(root, "InitDriver.json", "FUNC-001", "InitDriver", {
        line_range: { start: 10, end: 30 },
      })

      const hook = createArtifactValidatorHook(root)
      const output = {
        title: "write",
        output: "Saved to .matrix/wiki/functions/InitDriver.json",
        metadata: {} as Record<string, unknown>,
      }

      await hook["tool.execute.after"]?.(
        { tool: "write", sessionID: "wiki-function-mismatch" },
        output,
      )

      expect(output.output).toContain("[WIKI INVENTORY CHECK FAILED]")
      expect(output.output).toContain('Function "InitDriver" is not fully reconciled across software-analysis.json, wiki/index.json, and its function wiki')
      expect(output.metadata.wiki_inventory_validation).toBe("failed")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("flags software-analysis writes when existing wiki inventory no longer matches function ledger", async () => {
    const root = makeProjectRoot()
    try {
      writeValidFunctionWiki(root, "InitDriver.json", "FUNC-001", "InitDriver", {
        line_range: { start: 10, end: 30 },
      })
      writeWikiIndex(root, {
        InitDriver: {
          id: "FUNC-001",
          module_id: "mod_1",
          file_path: "src/main.c",
          safety_critical: false,
        },
      })
      writeSoftwareAnalysis(root, [
        {
          id: "FUNC-001",
          name: "InitDriver",
          file_path: "src/main.c",
          line_range: { start: 10, end: 30 },
        },
        {
          id: "FUNC-002",
          name: "StartTask",
          file_path: "src/main.c",
          line_range: { start: 31, end: 50 },
        },
      ])

      const hook = createArtifactValidatorHook(root)
      const output = {
        title: "write",
        output: "Saved to .matrix/data/software-analysis.json",
        metadata: {} as Record<string, unknown>,
      }

      await hook["tool.execute.after"]?.(
        { tool: "write", sessionID: "software-analysis-mismatch" },
        output,
      )

      expect(output.output).toContain("[WIKI INVENTORY CHECK FAILED]")
      expect(output.output).toContain("StartTask")
      expect(output.metadata.wiki_inventory_validation).toBe("failed")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
