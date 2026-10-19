import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { dirname, join } from "path"
import { CompilationEnvironment } from "../../src/schema/compilation"
import { compdbGenerator } from "../../src/tools"

const TEMP_DIRS: string[] = []
const ORIGINAL_CWD = process.cwd()

function writeFile(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, "utf-8")
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T
}

function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), "compdb-generator-"))
  TEMP_DIRS.push(dir)
  process.chdir(dir)
  return dir
}

afterEach(() => {
  process.chdir(ORIGINAL_CWD)
  for (const dir of TEMP_DIRS.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("compdbGenerator", () => {
  test("writes a valid compilation-env.json alongside compile_commands.json", async () => {
    const root = makeWorkspace()
    writeFile(join(root, "src", "power.c"), [
      "sbit LED = P1 ^ 0;",
      "unsigned char xdata counter;",
      "void main(void) { counter = 1; }",
    ].join("\n"))

    const toolImpl = compdbGenerator as unknown as {
      execute: (args: { source_path: string; compiler_dialect?: string }) => Promise<string>
    }
    const result = JSON.parse(await toolImpl.execute({
      source_path: root,
      compiler_dialect: "auto",
    }))

    expect(result.error).toBeUndefined()
    expect(existsSync(result.compile_commands_path)).toBe(true)
    expect(existsSync(result.compilation_env_path)).toBe(true)

    const env = readJson<any>(result.compilation_env_path)
    const parsed = CompilationEnvironment.safeParse(env)
    expect(parsed.success).toBe(true)
    expect(env.project_path).toBe(root)
    expect(env.compiler_dialect).toBe("c51")
    expect(env.compile_commands_path).toBe(result.compile_commands_path)
    expect(env.files_indexed).toBe(1)
    expect(env.stubs).toEqual([])
  })
})
