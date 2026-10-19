import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { __behaviorSafetyTestHooks } from "../../src/tools/behavior-safety-execute"

const TEMP_DIRS: string[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  TEMP_DIRS.push(dir)
  return dir
}

function cleanup(): void {
  for (const dir of TEMP_DIRS.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("behavior-safety local_subgraph planning", () => {
  test("builds one code-slice batch per local_subgraph context", () => {
    const root = "D:\\repo"
    const plan = __behaviorSafetyTestHooks.buildCodeSlicePlanFromContexts(
      root,
      [join(root, "src", "a.c"), join(root, "src", "b.c")],
      [
        {
          path: join(root, ".matrix", "data", "contexts", "contexts", "ctx-0001.json"),
          data: {
            context_id: "ctx-0001",
            block: {
              block_id: "abc",
              block_kind: "local_subgraph",
              slicing_strategy: "local_subgraph",
              root_function_name: "boot",
              function_ids: [1, 2],
            },
            outline: {
              globals: [],
              types: [],
              macros: ["BOOT_INCREMENT"],
              function_region: ["boot", "helper"],
            },
            locations: {
              functions: [
                { name: "boot", path: "src/a.c", start_line: 1, end_line: 10 },
                { name: "helper", path: "src/b.c", start_line: 3, end_line: 8 },
              ],
              globals: [],
              types: [],
              macros: [
                { name: "BOOT_INCREMENT", path: "include/model.h", start_line: 1, end_line: 1, kind: "object" },
              ],
            },
            prompt_ready: {
              text: "[Context]\nslicing_strategy: local_subgraph\nincludes_macros: BOOT_INCREMENT\n\n[Macros]\n#define BOOT_INCREMENT 1",
            },
          },
        },
      ],
    )

    expect(plan.strategy).toBe("code_slice")
    expect(plan.slicing_strategy).toBe("local_subgraph")
    expect(plan.planned_batches).toHaveLength(1)
    expect(plan.planned_batches[0].batch_id).toBe("batch-001")
    expect(plan.planned_batches[0].context_id).toBe("ctx-0001")
    expect(plan.planned_batches[0].slicing_strategy).toBe("local_subgraph")
    expect(plan.planned_batches[0].source_file).toBe("__local_subgraph__")
    expect(plan.planned_batches[0].functions_in_batch.map((fn) => fn.file_path)).toEqual(["src/a.c", "src/b.c"])
  })

  test("code-slice prompt requires preassembled local_subgraph and unique defect locations", () => {
    const prompt = __behaviorSafetyTestHooks.buildCodeSliceBatchPrompt({
      projectRelativePath: "__local_subgraph__",
      compilationContext: "compiler=gcc",
      batchIndex: 1,
      batchCount: 1,
      contextID: "ctx-0001",
      contextText: "[Context]\nslicing_strategy: local_subgraph\nincludes_macros: BOOT_INCREMENT\n\n[Macros]\n#define BOOT_INCREMENT 1",
      functionsInBatch: [
        {
          id: "planned-1",
          name: "boot",
          file_path: "src/a.c",
          line_range: { start: 1, end: 10 },
          return_type: "",
          parameters: [],
          cyclomatic_complexity: 0,
          calls: [],
          safety_critical: false,
        },
      ],
      traceability: [],
    })

    expect(prompt).toContain("local_subgraph context already assembled by code-slice")
    expect(prompt).toContain("Do not infer hidden chain/path relationships or rebuild a function_chain")
    expect(prompt).toContain("Do not reconstruct, split, merge, or reinterpret the context structure.")
    expect(prompt).toContain("Use prompt_ready.text as the primary semantic evidence.")
    expect(prompt).toContain("[Macros]\n#define BOOT_INCREMENT 1")
    expect(prompt).toContain("file_path, function_name, line_start, and line_end")
    expect(prompt).toContain("do not classify defects by context_id")
    expect(prompt).toContain('"file_path":"src/a.c"')
  })

  test("rejects non-local-subgraph manifests through the Inspector reader", () => {
    const dir = makeTempDir("matrix-local-subgraph-")
    try {
      mkdirSync(join(dir, "contexts"), { recursive: true })
      writeFileSync(
        join(dir, "manifest.json"),
        JSON.stringify({
          project_path: dir,
          generated_at: "2026-05-12T00:00:00Z",
          context_count: 1,
          contexts: [
            {
              context_id: "ctx-0001",
              entry_name: "boot",
              slicing_strategy: "path",
              block_kind: "path",
              file: "contexts/ctx-0001.json",
            },
          ],
        }, null, 2),
        "utf-8",
      )

      expect(() => __behaviorSafetyTestHooks.readInspectorLocalSubgraphContexts(dir)).toThrow("Invalid local_subgraph manifest")
    } finally {
      cleanup()
    }
  })

  test("keeps per-file fallback planning unchanged", () => {
    const root = "D:\\repo"
    const absolutePath = join(root, "src", "a.c")
    const plan = __behaviorSafetyTestHooks.buildPerFileFallbackPlan(
      root,
      new Map([
        [
          absolutePath,
          [
            {
              id: "fn-1",
              name: "boot",
              file_path: absolutePath,
              line_range: { start: 1, end: 10 },
              return_type: "void",
              parameters: [],
              cyclomatic_complexity: 1,
              calls: [],
              safety_critical: false,
            },
          ],
        ],
      ]),
      "code-slice failed",
    )

    expect(plan.strategy).toBe("per_file_fallback")
    expect(plan.fallback_reason).toBe("code-slice failed")
    expect(plan.planned_batches).toHaveLength(1)
    expect(plan.planned_batches[0].functions_in_batch[0].file_path).toBe("src/a.c")
  })

  test("falls back when code-slice invocation fails", () => {
    const root = "D:\\repo"
    const absolutePath = join(root, "src", "a.c")
    const plan = __behaviorSafetyTestHooks.buildExecutionPlanFromCodeSliceResult(
      root,
      [absolutePath],
      new Map([
        [
          absolutePath,
          [
            {
              id: "fn-1",
              name: "boot",
              file_path: absolutePath,
              line_range: { start: 1, end: 10 },
              return_type: "void",
              parameters: [],
              cyclomatic_complexity: 1,
              calls: [],
              safety_critical: false,
            },
          ],
        ],
      ]),
      {
        status: "error",
        error: "code-slice context-pack exited with status 2.",
        hint: "Check install_root.",
      },
    )

    expect(plan.strategy).toBe("per_file_fallback")
    expect(plan.fallback_reason).toContain("code-slice context-pack exited with status 2")
    expect(plan.fallback_reason).toContain("Check install_root.")
    expect(plan.planned_batches[0].source_file).toBe("src/a.c")
  })

  test("falls back when local_subgraph validation fails", () => {
    const root = makeTempDir("matrix-local-subgraph-fallback-")
    const sourceFile = join(root, "src", "a.c")
    const outputDir = join(root, ".matrix", "data", "contexts")
    const manifestPath = join(outputDir, "manifest.json")

    try {
      mkdirSync(join(root, "src"), { recursive: true })
      mkdirSync(join(outputDir, "contexts"), { recursive: true })
      writeFileSync(sourceFile, "void boot(void) {}\n", "utf-8")
      writeFileSync(
        manifestPath,
        JSON.stringify({
          project_path: root,
          generated_at: "2026-05-12T00:00:00Z",
          context_count: 1,
          contexts: [
            {
              context_id: "ctx-0001",
              entry_name: "boot",
              slicing_strategy: "local_subgraph",
              block_kind: "local_subgraph",
              file: "contexts/ctx-0001.json",
            },
          ],
        }, null, 2),
        "utf-8",
      )
      writeFileSync(
        join(outputDir, "contexts", "ctx-0001.json"),
        JSON.stringify({
          context_id: "ctx-0001",
          block: {
            block_id: "abc",
            block_kind: "path",
            slicing_strategy: "path",
            root_function_name: "boot",
            function_ids: [1],
          },
          outline: {
            function_chain: ["boot"],
          },
          locations: {
            functions: [],
            globals: [],
            types: [],
          },
          prompt_ready: {
            text: "[Context]\nid: ctx-0001",
          },
        }, null, 2),
        "utf-8",
      )

      const plan = __behaviorSafetyTestHooks.buildExecutionPlanFromCodeSliceResult(
        root,
        [sourceFile],
        new Map([
          [
            sourceFile,
            [
              {
                id: "fn-1",
                name: "boot",
                file_path: sourceFile,
                line_range: { start: 1, end: 1 },
                return_type: "void",
                parameters: [],
                cyclomatic_complexity: 1,
                calls: [],
                safety_critical: false,
              },
            ],
          ],
        ]),
        {
          status: "success",
          manifest_file: manifestPath,
          context_count: 1,
          blocks: {
            slicing_strategy: "local_subgraph",
          },
        },
      )

      expect(plan.strategy).toBe("per_file_fallback")
      expect(plan.fallback_reason).toContain("Invalid local_subgraph context ctx-0001")
      expect(plan.planned_batches[0].source_file).toBe("src/a.c")
    } finally {
      cleanup()
    }
  })
})
