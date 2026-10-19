import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { DEFAULT_CONFIG } from "../../src/config/schema"
import {
  buildCodeSliceInvocation,
  executeCodeSliceContextPack,
  getCodeSliceHomeCandidates,
  resolveCodeSliceHome,
} from "../../src/tools/code-slice-context-pack"
import { resolvePackagedPythonExecutable } from "../../src/shared/python-runtime"

const TEMP_DIRS: string[] = []
const ORIGINAL_MATRIX_PYTHON = process.env.MATRIX_PYTHON

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  TEMP_DIRS.push(dir)
  return dir
}

afterEach(() => {
  process.env.MATRIX_PYTHON = ORIGINAL_MATRIX_PYTHON

  for (const dir of TEMP_DIRS.splice(0)) {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

describe("code-slice-context-pack", () => {
  test("resolves code-slice path from install_root config", () => {
    expect(
      resolveCodeSliceHome(
        { ...DEFAULT_CONFIG, install_root: "D:\\Matrix" },
      ),
    ).toEqual({
      path: "D:\\Matrix\\tools\\code_slicer",
      source: "config",
    })
  })

  test("auto-discovers code-slice path from install-relative paths", () => {
    const discovered = "D:\\Matrix\\tools\\code_slicer"

    expect(
      resolveCodeSliceHome(
        DEFAULT_CONFIG,
        {
          env: { MATRIX_PYTHON: "D:\\Matrix\\runtime\\python\\python.exe" } as NodeJS.ProcessEnv,
          execPath: "D:\\Matrix\\runtime\\opencode.exe",
          exists: (path) => path === discovered,
        },
      ),
    ).toEqual({
      path: discovered,
      source: "auto_discovered",
    })
  })

  test("includes runtime-derived install candidates before repo-relative fallbacks", () => {
    const candidates = getCodeSliceHomeCandidates({
      env: { MATRIX_PYTHON: "D:\\Matrix\\runtime\\python\\python.exe" } as NodeJS.ProcessEnv,
      execPath: "D:\\Matrix\\runtime\\opencode.exe",
      candidates: ["D:\\custom\\code_slicer"],
    })

    expect(candidates[0]).toBe("D:\\custom\\code_slicer")
    expect(candidates).toContain("D:\\Matrix\\tools\\code_slicer")
  })

  test("resolves packaged Python with arg > env > packaged candidates and never needs code-slice venv", () => {
    const temp = makeTempDir("matrix-python-")
    const argPython = join(temp, "arg", "python.exe")
    const envPython = join(temp, "env", "python.exe")
    const runtimePython = join(temp, "runtime", "python.exe")
    const archivePython = join(temp, "archive", "python.exe")

    for (const file of [argPython, envPython, runtimePython, archivePython]) {
      mkdirSync(join(file, ".."), { recursive: true })
      writeFileSync(file, "")
    }

    process.env.MATRIX_PYTHON = envPython

    expect(
      resolvePackagedPythonExecutable(argPython, {
        env: process.env,
        candidates: [
          { path: runtimePython, source: "runtime" } as any,
          { path: archivePython, source: "tools-archive" } as any,
        ],
        canExecute: () => true,
      }),
    ).toEqual({
      executable: argPython,
      source: "arg",
    })

    expect(
      resolvePackagedPythonExecutable(undefined, {
        env: process.env,
        candidates: [
          { path: runtimePython, source: "runtime" } as any,
          { path: archivePython, source: "tools-archive" } as any,
        ],
        canExecute: () => true,
      }),
    ).toEqual({
      executable: envPython,
      source: "env",
    })

    delete process.env.MATRIX_PYTHON

    expect(
      resolvePackagedPythonExecutable(undefined, {
        env: process.env,
        candidates: [
          { path: runtimePython, source: "runtime" } as any,
          { path: archivePython, source: "tools-archive" } as any,
        ],
        canExecute: (candidate) => candidate === archivePython,
      }),
    ).toEqual({
      executable: archivePython,
      source: "tools-archive",
    })
  })

  test("builds absolute repo/out arguments and defaults to local_subgraph slicing", () => {
    const projectDir = makeTempDir("matrix-project-")
    const codeSliceHome = makeTempDir("code-slice-home-")

    const invocation = buildCodeSliceInvocation(
      {
        project_dir: projectDir,
        output_dir: ".matrix/data/contexts",
        max_functions: 7,
        max_total_lines: 120,
      },
      {
        loadConfig: () => ({ ...DEFAULT_CONFIG, install_root: codeSliceHome }),
        resolvePython: () => ({ executable: "D:\\runtime\\python.exe", source: "runtime" }),
      },
    )

    expect(invocation.cwd).toBe(join(codeSliceHome, "tools", "code_slicer", "work"))
    expect(invocation.cliPath).toBe(join(codeSliceHome, "tools", "code_slicer", "work", "run_cli.py"))
    expect(invocation.args).toEqual([
      join(codeSliceHome, "tools", "code_slicer", "work", "run_cli.py"),
      "context-pack",
      "--repo",
      projectDir,
      "--out",
      join(projectDir, ".matrix", "data", "contexts"),
      "--max-functions",
      "7",
      "--max-total-lines",
      "120",
      "--slicing-strategy",
      "local_subgraph",
    ])
    expect(invocation.args[5]).toBe(join(projectDir, ".matrix", "data", "contexts"))
    expect(invocation.args[5]).not.toBe(join(codeSliceHome, "tools", "code_slicer", "work", ".matrix", "data", "contexts"))
  })

  test("passes an explicit local_subgraph slicing strategy to the CLI", () => {
    const projectDir = makeTempDir("matrix-project-")
    const codeSliceHome = makeTempDir("code-slice-home-")

    const invocation = buildCodeSliceInvocation(
      {
        project_dir: projectDir,
        output_dir: ".matrix/data/contexts",
        slicing_strategy: "local_subgraph",
      },
      {
        loadConfig: () => ({ ...DEFAULT_CONFIG, install_root: codeSliceHome }),
        resolvePython: () => ({ executable: "D:\\runtime\\python.exe", source: "runtime" }),
      },
    )

    expect(invocation.args).toContain("--slicing-strategy")
    expect(invocation.args).toContain("local_subgraph")
  })

  test("allows explicit path slicing when call-chain contexts are requested", () => {
    const projectDir = makeTempDir("matrix-project-")
    const codeSliceHome = makeTempDir("code-slice-home-")

    const invocation = buildCodeSliceInvocation(
      {
        project_dir: projectDir,
        slicing_strategy: "path",
      },
      {
        loadConfig: () => ({ ...DEFAULT_CONFIG, install_root: codeSliceHome }),
        resolvePython: () => ({ executable: "D:\\runtime\\python.exe", source: "runtime" }),
      },
    )

    expect(invocation.args.slice(-2)).toEqual(["--slicing-strategy", "path"])
  })

  test("returns a clear error when the code-slice work directory is missing", async () => {
    const projectDir = makeTempDir("matrix-project-")
    const installRoot = makeTempDir("matrix-install-")

    const result = await executeCodeSliceContextPack(
      { project_dir: projectDir },
      {
        loadConfig: () => ({ ...DEFAULT_CONFIG, install_root: installRoot }),
        resolvePython: () => ({ executable: "D:\\runtime\\python.exe", source: "runtime" }),
      },
    )

    expect(result.status).toBe("error")
    expect(result.error).toContain("work directory not found")
  })

  test("returns a clear error when the CLI script is missing", async () => {
    const projectDir = makeTempDir("matrix-project-")
    const installRoot = makeTempDir("matrix-install-")
    mkdirSync(join(installRoot, "tools", "code_slicer", "work"), { recursive: true })

    const result = await executeCodeSliceContextPack(
      { project_dir: projectDir },
      {
        loadConfig: () => ({ ...DEFAULT_CONFIG, install_root: installRoot }),
        resolvePython: () => ({ executable: "D:\\runtime\\python.exe", source: "runtime" }),
      },
    )

    expect(result.status).toBe("error")
    expect(result.error).toContain("CLI script not found")
  })

  test("returns a clear error when the packaged Python runtime is missing", async () => {
    const projectDir = makeTempDir("matrix-project-")
    const installRoot = makeTempDir("matrix-install-")
    const workDir = join(installRoot, "tools", "code_slicer", "work")
    mkdirSync(workDir, { recursive: true })
    writeFileSync(join(workDir, "run_cli.py"), "")

    const result = await executeCodeSliceContextPack(
      { project_dir: projectDir },
      {
        loadConfig: () => ({ ...DEFAULT_CONFIG, install_root: installRoot }),
        resolvePython: () => {
          throw new Error("Python executable not found. Set MATRIX_PYTHON or ensure the packaged runtime/python payload is installed.")
        },
      },
    )

    expect(result.status).toBe("error")
    expect(result.error).toContain("Python executable not found")
  })

  test("returns the CLI summary without validating generated context files", async () => {
    const projectDir = makeTempDir("matrix-project-")
    const installRoot = makeTempDir("matrix-install-")
    const workDir = join(installRoot, "tools", "code_slicer", "work")
    const outputDir = join(projectDir, ".matrix", "data", "contexts")
    const manifestPath = join(outputDir, "manifest.json")
    const dbPath = join(projectDir, ".matrix", "data", "index.db")

    mkdirSync(workDir, { recursive: true })
    writeFileSync(join(workDir, "run_cli.py"), "")

    const result = await executeCodeSliceContextPack(
      { project_dir: projectDir, slicing_strategy: "local_subgraph" },
      {
        loadConfig: () => ({ ...DEFAULT_CONFIG, install_root: installRoot }),
        resolvePython: () => ({ executable: "D:\\runtime\\python.exe", source: "runtime" }),
        spawn: (() => ({
          status: 0,
          stdout: JSON.stringify({
            repo_path: projectDir,
            db_path: dbPath,
            out_dir: outputDir,
            manifest_file: manifestPath,
            context_count: 1,
            index: {
              files_indexed: 3,
            },
            blocks: {
              slicing_strategy: "local_subgraph",
              max_functions: 10,
              max_total_lines: 400,
            },
          }),
          stderr: "",
        })) as any,
      },
    )

    expect(result).toEqual({
      status: "success",
      project_dir: projectDir,
      output_dir: outputDir,
      manifest_file: manifestPath,
      db_path: dbPath,
      context_count: 1,
      python_executable: "D:\\runtime\\python.exe",
      python_source: "runtime",
      code_slice_path: join(installRoot, "tools", "code_slicer"),
      config_source: "config",
      index: {
        files_indexed: 3,
      },
      blocks: {
        slicing_strategy: "local_subgraph",
        max_functions: 10,
        max_total_lines: 400,
      },
    })
  })

  test("returns stdout and stderr when the CLI exits with an error", async () => {
    const projectDir = makeTempDir("matrix-project-")
    const installRoot = makeTempDir("matrix-install-")
    const workDir = join(installRoot, "tools", "code_slicer", "work")

    mkdirSync(workDir, { recursive: true })
    writeFileSync(join(workDir, "run_cli.py"), "")

    const result = await executeCodeSliceContextPack(
      { project_dir: projectDir },
      {
        loadConfig: () => ({ ...DEFAULT_CONFIG, install_root: installRoot }),
        resolvePython: () => ({ executable: "D:\\runtime\\python.exe", source: "runtime" }),
        spawn: (() => ({
          status: 2,
          stdout: "partial output",
          stderr: "repo path does not exist",
        })) as any,
      },
    )

    expect(result.status).toBe("error")
    expect(result.error).toContain("exited with status 2")
    expect(result.stdout).toBe("partial output")
    expect(result.stderr).toBe("repo path does not exist")
  })
})
