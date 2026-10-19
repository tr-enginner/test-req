import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { codeParser } from "../../src/tools/code-parser"

const TEMP_DIRS: string[] = []

afterEach(() => {
  for (const dir of TEMP_DIRS.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("code_parser tool", () => {
  test("writes full parse result to output_file and returns a compact summary", async () => {
    const root = mkdtempSync(join(tmpdir(), "code-parser-tool-"))
    TEMP_DIRS.push(root)
    mkdirSync(join(root, "src"), { recursive: true })
    const sourcePath = join(root, "src", "main.c")
    const outputPath = join(root, ".matrix", "data", "software-analysis-stage-03-code-tool.json")

    writeFileSync(sourcePath, [
      "void helper(void) {",
      "}",
      "",
      "int main(void) {",
      "  helper();",
      "  return 0;",
      "}",
      "",
    ].join("\n"), "utf-8")

    const result = JSON.parse(await (codeParser as any).execute({
      path: sourcePath,
      recursive: false,
      output_file: outputPath,
    }))

    expect(result.output_file).toBe(outputPath)
    expect(result.total_functions).toBe(2)
    expect(result.functions).toBeUndefined()
    expect(existsSync(outputPath)).toBe(true)

    const fileData = JSON.parse(readFileSync(outputPath, "utf-8"))
    expect(fileData.functions).toHaveLength(2)
    expect(fileData.modules).toHaveLength(1)
    expect(fileData.data_flow_graph.nodes).toHaveLength(2)
    expect(fileData.data_flow_graph.edges).toHaveLength(1)
    const helperFn = fileData.functions.find((fn: any) => fn.name === "helper")
    expect(helperFn.called_by).toEqual(["main"])
  })

  test("skips generated .matrix sources when parsing a project root recursively", async () => {
    const root = mkdtempSync(join(tmpdir(), "code-parser-root-"))
    TEMP_DIRS.push(root)
    mkdirSync(join(root, "src"), { recursive: true })
    mkdirSync(join(root, ".matrix", "preprocessed"), { recursive: true })

    writeFileSync(join(root, "src", "main.c"), [
      "void helper(void) {",
      "}",
      "",
      "int main(void) {",
      "  helper();",
      "  return 0;",
      "}",
      "",
    ].join("\n"), "utf-8")

    writeFileSync(join(root, ".matrix", "preprocessed", "main.c"), [
      "void helper(void) {",
      "}",
      "",
      "int main(void) {",
      "  helper();",
      "  return 0;",
      "}",
      "",
    ].join("\n"), "utf-8")

    const result = JSON.parse(await (codeParser as any).execute({
      path: root,
      recursive: true,
    }))

    expect(result.total_functions).toBe(2)
    expect(result.functions).toHaveLength(2)
    expect(result.functions.every((fn: any) => !String(fn.file_path).includes(".matrix"))).toBe(true)
  })

  test("parses comment-suffixed and interrupt-qualified function definitions without inventing comment calls", async () => {
    const root = mkdtempSync(join(tmpdir(), "code-parser-signatures-"))
    TEMP_DIRS.push(root)
    mkdirSync(join(root, "src"), { recursive: true })

    const sourcePath = join(root, "src", "irq.c")
    writeFileSync(sourcePath, [
      "void TimeSharing(void)// scheduler tick",
      "{",
      "}",
      "",
      "void GPT_viTmr3(void) interrupt T3INT",
      "{",
      "  TimeSharing();",
      "  // voltage time comment should not become calls",
      "}",
      "",
    ].join("\n"), "utf-8")

    const result = JSON.parse(await (codeParser as any).execute({
      path: sourcePath,
      recursive: false,
    }))

    expect(result.total_functions).toBe(2)
    expect(result.functions.map((fn: any) => fn.name)).toEqual(["TimeSharing", "GPT_viTmr3"])
    const isr = result.functions.find((fn: any) => fn.name === "GPT_viTmr3")
    expect(isr.calls).toEqual(["TimeSharing"])
  })

  test("parses 8051 using-qualified and interrupt-using function definitions", async () => {
    const root = mkdtempSync(join(tmpdir(), "code-parser-8051-signatures-"))
    TEMP_DIRS.push(root)
    mkdirSync(join(root, "src"), { recursive: true })

    const sourcePath = join(root, "src", "c51.c")
    writeFileSync(sourcePath, [
      "void CANRXD(void) using 1",
      "{",
      "}",
      "",
      "void CAN_ISR(void) interrupt 0 using 1",
      "{",
      "  CANRXD();",
      "}",
      "",
      "void TIMER_ISR(void) interrupt 1 using 2",
      "{",
      "  CANRXD();",
      "}",
      "",
    ].join("\n"), "utf-8")

    const result = JSON.parse(await (codeParser as any).execute({
      path: sourcePath,
      recursive: false,
    }))

    expect(result.total_functions).toBe(3)
    expect(result.functions.map((fn: any) => fn.name)).toEqual(["CANRXD", "CAN_ISR", "TIMER_ISR"])
    expect(result.functions.find((fn: any) => fn.name === "CAN_ISR")?.calls).toEqual(["CANRXD"])
    expect(result.functions.find((fn: any) => fn.name === "TIMER_ISR")?.calls).toEqual(["CANRXD"])
  })

  test("parses multi-line function signatures and pointer-returning helpers", async () => {
    const root = mkdtempSync(join(tmpdir(), "code-parser-multiline-signatures-"))
    TEMP_DIRS.push(root)
    mkdirSync(join(root, "src"), { recursive: true })

    const sourcePath = join(root, "src", "multiline.c")
    writeFileSync(sourcePath, [
      "int",
      "digest_init(void)",
      "{",
      "  return 0;",
      "}",
      "",
      "static const void *body(const void *data)",
      "{",
      "  return data;",
      "}",
      "",
      "static inline unsigned int",
      "_tokenize_sentence(char *sentence)",
      "{",
      "  return (unsigned int)strlen(sentence);",
      "}",
      "",
    ].join("\n"), "utf-8")

    const result = JSON.parse(await (codeParser as any).execute({
      path: sourcePath,
      recursive: false,
    }))

    expect(result.total_functions).toBe(3)
    expect(result.functions.map((fn: any) => fn.name)).toEqual(["digest_init", "body", "_tokenize_sentence"])
    expect(result.functions.find((fn: any) => fn.name === "body")?.return_type).toBe("static const void *")
    expect(result.functions.find((fn: any) => fn.name === "_tokenize_sentence")?.line_range).toEqual({ start: 12, end: 16 })
  })

  test("uses the actual function signature line when a block comment appears immediately above it", async () => {
    const root = mkdtempSync(join(tmpdir(), "code-parser-comment-prefix-"))
    TEMP_DIRS.push(root)
    mkdirSync(join(root, "src"), { recursive: true })

    const sourcePath = join(root, "src", "commented.c")
    writeFileSync(sourcePath, [
      "/*",
      "** Helper description line 1",
      "** Helper description line 2",
      "*/",
      "static int isAlterableTable(Parse *pParse, Table *pTab){",
      "  return 0;",
      "}",
      "",
    ].join("\n"), "utf-8")

    const result = JSON.parse(await (codeParser as any).execute({
      path: sourcePath,
      recursive: false,
    }))

    expect(result.total_functions).toBe(1)
    expect(result.functions[0]).toMatchObject({
      name: "isAlterableTable",
      return_type: "static int",
      line_range: { start: 5, end: 7 },
    })
  })

  test("parses long multi-line signatures with the closing paren and brace on their own line", async () => {
    const root = mkdtempSync(join(tmpdir(), "code-parser-long-signature-"))
    TEMP_DIRS.push(root)
    mkdirSync(join(root, "src"), { recursive: true })

    const sourcePath = join(root, "src", "alter.c")
    writeFileSync(sourcePath, [
      "/*",
      "** Generate code to verify that schemas can still be parsed.",
      "*/",
      "static void renameTestSchema(",
      "  Parse *pParse,",
      "  const char *zDb,",
      "  int bTemp,",
      "  const char *zWhen,",
      "  int bNoDQS",
      "){",
      "  sqlite3NestedParse(pParse, zDb, bTemp, zWhen, bNoDQS);",
      "}",
      "",
    ].join("\n"), "utf-8")

    const result = JSON.parse(await (codeParser as any).execute({
      path: sourcePath,
      recursive: false,
    }))

    expect(result.total_functions).toBe(1)
    expect(result.functions[0]).toMatchObject({
      name: "renameTestSchema",
      return_type: "static void",
      line_range: { start: 4, end: 12 },
      calls: ["sqlite3NestedParse"],
    })
  })

  test("keeps compiler intrinsics in calls", async () => {
    const root = mkdtempSync(join(tmpdir(), "code-parser-intrinsics-"))
    TEMP_DIRS.push(root)
    mkdirSync(join(root, "src"), { recursive: true })

    const sourcePath = join(root, "src", "intrinsic.c")
    writeFileSync(sourcePath, [
      "void busy_wait(void)",
      "{",
      "  _nop_();",
      "  _srvwdt_();",
      "}",
      "",
    ].join("\n"), "utf-8")

    const result = JSON.parse(await (codeParser as any).execute({
      path: sourcePath,
      recursive: false,
    }))

    expect(result.total_functions).toBe(1)
    expect(result.functions.find((fn: any) => fn.name === "busy_wait")?.calls).toEqual(["_nop_", "_srvwdt_"])
  })

  test("filters standard library calls such as abs from the call graph", async () => {
    const root = mkdtempSync(join(tmpdir(), "code-parser-stdlib-"))
    TEMP_DIRS.push(root)
    mkdirSync(join(root, "src"), { recursive: true })

    const sourcePath = join(root, "src", "stdlib.c")
    writeFileSync(sourcePath, [
      "int helper(int value)",
      "{",
      "  return value + 1;",
      "}",
      "",
      "int clamp(int value)",
      "{",
      "  return helper(abs(value));",
      "}",
      "",
    ].join("\n"), "utf-8")

    const result = JSON.parse(await (codeParser as any).execute({
      path: sourcePath,
      recursive: false,
    }))

    expect(result.total_functions).toBe(2)
    expect(result.functions.find((fn: any) => fn.name === "clamp")?.calls).toEqual(["helper"])
  })

  test("uses AST structure so comments strings and initializer braces do not affect function boundaries", async () => {
    const root = mkdtempSync(join(tmpdir(), "code-parser-ast-boundaries-"))
    TEMP_DIRS.push(root)
    mkdirSync(join(root, "src"), { recursive: true })

    const sourcePath = join(root, "src", "boundaries.c")
    writeFileSync(sourcePath, [
      "int helper(void) {",
      "  return 1;",
      "}",
      "",
      "int main(void) {",
      "  const char *text = \"not_a_call(); }\";",
      "  int values[3] = { helper(), 2, 3 };",
      "  if (helper()) {",
      "    return values[0];",
      "  }",
      "  return 0;",
      "}",
      "",
    ].join("\n"), "utf-8")

    const result = JSON.parse(await (codeParser as any).execute({
      path: sourcePath,
      recursive: false,
    }))

    expect(result.total_functions).toBe(2)
    expect(result.functions.map((fn: any) => fn.name)).toEqual(["helper", "main"])
    expect(result.functions.find((fn: any) => fn.name === "main")).toMatchObject({
      line_range: { start: 5, end: 12 },
      calls: ["helper"],
    })
  })

  test("maps preprocessed 8051 sources back to original file paths and line ranges", async () => {
    const root = mkdtempSync(join(tmpdir(), "code-parser-preprocessed-map-"))
    TEMP_DIRS.push(root)
    mkdirSync(join(root, "src"), { recursive: true })
    mkdirSync(join(root, ".matrix", "preprocessed", "src"), { recursive: true })

    const sourcePath = join(root, "src", "c51.c")
    const preprocessedPath = join(root, ".matrix", "preprocessed", "src", "c51.c")
    writeFileSync(sourcePath, [
      "void CANRXD(void) using 1",
      "{",
      "}",
      "",
      "void CAN_ISR(void) interrupt 0 using 1",
      "{",
      "  CANRXD();",
      "}",
      "",
    ].join("\n"), "utf-8")
    writeFileSync(preprocessedPath, [
      "#line 1 \"src/c51.c\"",
      "void CANRXD(void)",
      "{",
      "}",
      "",
      "void CAN_ISR(void)",
      "{",
      "  CANRXD();",
      "}",
      "",
    ].join("\n"), "utf-8")

    const result = JSON.parse(await (codeParser as any).execute({
      path: join(root, "src"),
      recursive: true,
      preprocessed_path: join(root, ".matrix", "preprocessed"),
    }))

    expect(result.total_functions).toBe(2)
    expect(result.functions.every((fn: any) => fn.file_path === sourcePath)).toBe(true)
    expect(result.functions.find((fn: any) => fn.name === "CANRXD")?.line_range).toEqual({ start: 1, end: 3 })
    expect(result.functions.find((fn: any) => fn.name === "CAN_ISR")?.line_range).toEqual({ start: 5, end: 8 })
    expect(result.functions.find((fn: any) => fn.name === "CAN_ISR")?.calls).toEqual(["CANRXD"])
  })

  test("parses basic C++ namespace and class method definitions", async () => {
    const root = mkdtempSync(join(tmpdir(), "code-parser-cpp-"))
    TEMP_DIRS.push(root)
    mkdirSync(join(root, "src"), { recursive: true })

    const sourcePath = join(root, "src", "controller.cpp")
    writeFileSync(sourcePath, [
      "namespace ns {",
      "int helper(int x) {",
      "  return x;",
      "}",
      "class Controller {",
      "public:",
      "  int sample(int x) {",
      "    return helper(x);",
      "  }",
      "};",
      "}",
      "",
    ].join("\n"), "utf-8")

    const result = JSON.parse(await (codeParser as any).execute({
      path: sourcePath,
      recursive: false,
    }))

    expect(result.total_functions).toBe(2)
    expect(result.functions.map((fn: any) => fn.name)).toEqual(["helper", "sample"])
    expect(result.functions.find((fn: any) => fn.name === "sample")).toMatchObject({
      return_type: "int",
      calls: ["helper"],
    })
  })

  test("ignores function-like macro names while keeping real calls and intrinsics", async () => {
    const root = mkdtempSync(join(tmpdir(), "code-parser-macros-"))
    TEMP_DIRS.push(root)
    mkdirSync(join(root, "src"), { recursive: true })

    const sourcePath = join(root, "src", "macros.c")
    writeFileSync(sourcePath, [
      "#define ASSERT(x) do { if (!(x)) fail(); } while (0)",
      "void real(void) {",
      "}",
      "int ok(void) {",
      "  return 1;",
      "}",
      "void run(void) {",
      "  ASSERT(ok());",
      "  real();",
      "  _nop_();",
      "}",
      "",
    ].join("\n"), "utf-8")

    const result = JSON.parse(await (codeParser as any).execute({
      path: sourcePath,
      recursive: false,
    }))

    const run = result.functions.find((fn: any) => fn.name === "run")
    expect(run.calls).toEqual(["ok", "real", "_nop_"])
    expect(run.calls).not.toContain("ASSERT")
    expect(run.calls).not.toContain("fail")
  })

  test("honors function_names filtering and include_bodies output", async () => {
    const root = mkdtempSync(join(tmpdir(), "code-parser-filter-body-"))
    TEMP_DIRS.push(root)
    mkdirSync(join(root, "src"), { recursive: true })

    const sourcePath = join(root, "src", "filter.c")
    writeFileSync(sourcePath, [
      "void skip(void) {",
      "}",
      "",
      "int target(int value) {",
      "  return value + 1;",
      "}",
      "",
    ].join("\n"), "utf-8")

    const result = JSON.parse(await (codeParser as any).execute({
      path: sourcePath,
      recursive: false,
      function_names: ["target"],
      include_bodies: true,
    }))

    expect(result.total_functions).toBe(1)
    expect(result.functions[0].name).toBe("target")
    expect(result.functions[0].body).toContain("int target(int value)")
    expect(result.functions[0].parameters).toEqual([{ name: "value", type: "int" }])
  })
})
