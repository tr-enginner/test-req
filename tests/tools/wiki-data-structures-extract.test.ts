import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { dirname, join } from "path"
import { DataStructuresFile, type DataStructureKind } from "../../src/schema/wiki"
import { wikiDataStructuresExtract } from "../../src/tools"

const TEMP_DIRS: string[] = []
const ORIGINAL_CWD = process.cwd()

function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), "wiki-data-structures-"))
  TEMP_DIRS.push(dir)
  process.chdir(dir)
  return dir
}

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2), "utf-8")
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T
}

function containsDescription(value: unknown): boolean {
  if (!value || typeof value !== "object") return false
  if (Array.isArray(value)) return value.some(containsDescription)
  const record = value as Record<string, unknown>
  return Object.keys(record).includes("description") ||
    Object.values(record).some(containsDescription)
}

const DATA_STRUCTURE_KINDS: DataStructureKind[] = ["struct", "union", "enum", "typedef", "GlobalVar"]

function allDataStructures(artifact: DataStructuresFile) {
  return DATA_STRUCTURE_KINDS.flatMap((kind) =>
    artifact[kind].map((item) => ({ ...item, kind })),
  )
}

async function extract(args: Record<string, unknown>) {
  const toolImpl = wikiDataStructuresExtract as unknown as {
    execute: (args: Record<string, unknown>) => Promise<string>
  }
  return JSON.parse(await toolImpl.execute(args))
}

afterEach(() => {
  process.chdir(ORIGINAL_CWD)
  for (const dir of TEMP_DIRS.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("wiki_data_structures_extract tool", () => {
  test("extracts C data structures with fields and no description fields", async () => {
    const root = makeWorkspace()
    mkdirSync(join(root, "src"), { recursive: true })
    const sourcePath = join(root, "src", "types.c")

    writeFileSync(sourcePath, [
      "typedef struct {",
      "  int a, *b;",
      "  unsigned flags:3;",
      "  char name[16];",
      "} Foo;",
      "struct Bar { Foo foo; enum Mode mode; };",
      "union Value { int i; float f; };",
      "enum Mode { MODE_A = 1, MODE_B };",
      "typedef unsigned long U32;",
      "static volatile Foo *g_foo;",
      "int g_count = 0, *g_count_ptr;",
      "char g_name[8];",
      "const unsigned char code onoffTab[16] = {0x04, 0x03};",
      "struct Bar xdata heatPara[2];",
      "unsigned char xdata heatParaTH[7];",
      "void declared_only(void);",
      "void use(void) {",
      "  Foo foo;",
      "  struct Bar bar;",
      "  enum Mode mode;",
      "  g_count++;",
      "  g_foo = &foo;",
      "  (void)foo; (void)bar; (void)mode; (void)g_name;",
      "  int local_only;",
      "  (void)local_only;",
      "}",
      "",
    ].join("\n"), "utf-8")

    writeJson(join(root, ".matrix", "data", "software-analysis.json"), {
      project_name: "Data Structure Demo",
      functions: [
        {
          id: "FUNC-001",
          name: "use",
          file_path: sourcePath,
          line_range: { start: 17, end: 26 },
        },
      ],
      modules: [
        {
          name: "types",
          path: sourcePath,
          functions: ["FUNC-001"],
        },
      ],
    })

    const result = await extract({ path: sourcePath, recursive: false, force: true })

    expect(result.status).toBe("success")
    expect(result.action).toBe("extracted_data_structures")
    expect(existsSync(join(root, ".matrix", "wiki", "data-structures.json"))).toBe(true)

    const artifact = DataStructuresFile.parse(
      readJson(join(root, ".matrix", "wiki", "data-structures.json")),
    )
    expect(containsDescription(artifact)).toBe(false)
    expect(artifact.schema_version).toBe(3)
    expect((artifact as unknown as { structures?: unknown }).structures).toBeUndefined()

    const byName = new Map(allDataStructures(artifact).map((item) => [item.name, item]))
    expect([...byName.keys()]).toEqual(expect.arrayContaining([
      "Foo",
      "Bar",
      "Value",
      "Mode",
      "U32",
      "g_foo",
      "g_count",
      "g_count_ptr",
      "g_name",
      "onoffTab",
      "heatPara",
      "heatParaTH",
    ]))
    expect([...byName.keys()]).not.toContain("code")
    expect([...byName.keys()]).not.toContain("xdata")
    expect([...byName.keys()]).not.toContain("declared_only")
    expect([...byName.keys()]).not.toContain("local_only")
    expect(byName.get("Foo")?.kind).toBe("typedef")
    expect(byName.get("Foo")?.fields).toEqual([
      { name: "a", type: "int" },
      { name: "b", type: "int *" },
      { name: "flags", type: "unsigned :3" },
      { name: "name", type: "char [16]" },
    ])
    expect(byName.get("Mode")?.fields).toEqual([
      { name: "MODE_A", type: "enum_constant" },
      { name: "MODE_B", type: "enum_constant" },
    ])
    expect(byName.get("g_foo")).toMatchObject({
      kind: "GlobalVar",
      type: "static volatile Foo *",
      fields: [],
    })
    expect(byName.get("g_count")).toMatchObject({ kind: "GlobalVar", type: "int" })
    expect(byName.get("g_count_ptr")).toMatchObject({ kind: "GlobalVar", type: "int *" })
    expect(byName.get("g_name")).toMatchObject({ kind: "GlobalVar", type: "char [8]" })
    expect(byName.get("onoffTab")).toMatchObject({ kind: "GlobalVar", type: "const unsigned char code [16]" })
    expect(byName.get("heatPara")).toMatchObject({ kind: "GlobalVar", type: "struct Bar xdata [2]" })
    expect(byName.get("heatParaTH")).toMatchObject({ kind: "GlobalVar", type: "unsigned char xdata [7]" })
    expect(byName.get("Foo")?.used_by_functions).toEqual(["use"])
    expect(byName.get("Foo")?.used_by_modules).toEqual(["types"])
    expect(byName.get("g_count")?.used_by_functions).toEqual(["use"])
  })

  test("maps preprocessed source locations back to original line directives", async () => {
    const root = makeWorkspace()
    mkdirSync(join(root, "src"), { recursive: true })
    mkdirSync(join(root, ".matrix", "preprocessed", "src"), { recursive: true })
    const sourcePath = join(root, "src", "device.c")
    const preprocessedPath = join(root, ".matrix", "preprocessed", "src", "device.c")

    writeFileSync(sourcePath, [
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "typedef xdata struct { int raw; } Sensor;",
      "",
    ].join("\n"), "utf-8")

    writeFileSync(preprocessedPath, [
      "#line 10 \"src/device.c\"",
      "typedef struct { int raw; } Sensor;",
      "",
    ].join("\n"), "utf-8")

    await extract({
      path: join(root, "src"),
      recursive: true,
      preprocessed_path: join(root, ".matrix", "preprocessed"),
      force: true,
    })

    const artifact = DataStructuresFile.parse(
      readJson(join(root, ".matrix", "wiki", "data-structures.json")),
    )
    expect(artifact.typedef).toHaveLength(1)
    expect(artifact.typedef[0]).toMatchObject({
      name: "Sensor",
      file_path: sourcePath,
      line_range: { start: 10, end: 10 },
      fields: [{ name: "raw", type: "int" }],
    })
  })

  test("regenerates legacy data-structures artifacts containing description fields", async () => {
    const root = makeWorkspace()
    mkdirSync(join(root, "src"), { recursive: true })
    const sourcePath = join(root, "src", "fresh.c")

    writeFileSync(sourcePath, "struct Fresh { int ok; };\n", "utf-8")
    writeJson(join(root, ".matrix", "wiki", "data-structures.json"), {
      project_name: "legacy",
      created_date: "2026-04-01T00:00:00.000Z",
      structures: [
        {
          name: "Legacy",
          file_path: "legacy.h",
          line_range: { start: 1, end: 1 },
          kind: "struct",
          description: "old prose",
          fields: [{ name: "old", type: "int", description: "old field prose" }],
          used_by_functions: [],
          used_by_modules: [],
        },
      ],
    })

    const result = await extract({ path: sourcePath, recursive: false })
    const artifact = DataStructuresFile.parse(
      readJson(join(root, ".matrix", "wiki", "data-structures.json")),
    )

    expect(result.action).toBe("extracted_data_structures")
    expect(artifact.struct.map((item) => item.name)).toEqual(["Fresh"])
    expect((artifact as unknown as { structures?: unknown }).structures).toBeUndefined()
    expect(containsDescription(artifact)).toBe(false)
  })

  test("maps global variable usage from source functions when Phase 1 artifacts are absent", async () => {
    const root = makeWorkspace()
    mkdirSync(join(root, "src"), { recursive: true })
    const sourcePath = join(root, "src", "power.c")

    writeFileSync(sourcePath, [
      "#define FALSE 0",
      "unsigned char xdata fgDischargeEn;",
      "unsigned char xdata untouchedFlag;",
      "void DataInit(void)",
      "{",
      "  fgDischargeEn = FALSE;",
      "}",
      "",
    ].join("\n"), "utf-8")

    await extract({ path: sourcePath, recursive: false, force: true })

    const artifact = DataStructuresFile.parse(
      readJson(join(root, ".matrix", "wiki", "data-structures.json")),
    )
    const byName = new Map(allDataStructures(artifact).map((item) => [item.name, item]))

    expect(byName.get("fgDischargeEn")?.used_by_functions).toEqual(["DataInit"])
    expect(byName.get("fgDischargeEn")?.used_by_modules).toEqual(["power"])
    expect(byName.get("untouchedFlag")?.used_by_functions).toEqual([])
  })
})
