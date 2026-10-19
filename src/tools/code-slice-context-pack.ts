import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { spawnSync, type SpawnSyncReturns } from "child_process"
import { existsSync, mkdirSync } from "fs"
import { basename, dirname, isAbsolute, join, resolve, win32 } from "path"
import type { MatrixConfig } from "../config/schema"
import { loadPluginConfig } from "../plugin-config"
import { ARTIFACT_PATHS } from "../shared/constants"
import {
  resolvePackagedPythonExecutable,
  type ResolvedPythonRuntime,
} from "../shared/python-runtime"
import { runtimeAssetRoot } from "../shared/runtime-paths"

type JsonObject = Record<string, unknown>
export type CodeSliceSlicingStrategy = "path" | "local_subgraph"
const DEFAULT_SLICING_STRATEGY: CodeSliceSlicingStrategy = "local_subgraph"

export interface ResolvedCodeSliceHome {
  path: string
  source: "config" | "auto_discovered"
}

export interface CodeSliceInvocation {
  projectDir: string
  outputDir: string
  codeSliceHome: string
  configSource: ResolvedCodeSliceHome["source"]
  cliPath: string
  cwd: string
  args: string[]
  python: ResolvedPythonRuntime
}

export interface CodeSliceContextPackExecuteDeps {
  loadConfig?: (projectDir: string) => MatrixConfig
  resolvePython?: (preferredPath?: string) => ResolvedPythonRuntime
  spawn?: typeof spawnSync
}

interface ResolveCodeSliceHomeOptions {
  env?: NodeJS.ProcessEnv
  execPath?: string
  exists?: (path: string) => boolean
  candidates?: string[]
}

function isWindowsAbsolutePath(input: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(input) || /^\\\\/.test(input)
}

function isAnyAbsolutePath(input: string): boolean {
  return isAbsolute(input) || isWindowsAbsolutePath(input)
}

function joinForPath(root: string, ...segments: string[]): string {
  return isWindowsAbsolutePath(root) ? win32.join(root, ...segments) : join(root, ...segments)
}

function dirnameForPath(input: string): string {
  return isWindowsAbsolutePath(input) ? win32.dirname(input) : dirname(input)
}

function basenameForPath(input: string): string {
  return isWindowsAbsolutePath(input) ? win32.basename(input) : basename(input)
}

function resolvePathInput(input: string): string {
  return isAnyAbsolutePath(input) ? input : resolve(process.cwd(), input)
}

function resolveProjectPath(input: string, projectDir: string): string {
  return isAnyAbsolutePath(input) ? input : resolve(projectDir, input)
}

function truncateText(value: string, maxLength = 4000): string {
  const trimmed = value.trim()
  if (!trimmed) return ""
  if (trimmed.length <= maxLength) return trimmed
  return `${trimmed.slice(0, maxLength)}...(truncated)`
}

function extractJsonObject(text: string): JsonObject {
  const trimmed = text.trim()
  if (!trimmed) {
    throw new Error("CLI stdout is empty.")
  }

  try {
    return JSON.parse(trimmed) as JsonObject
  } catch {
    const start = trimmed.indexOf("{")
    const end = trimmed.lastIndexOf("}")
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("CLI stdout does not contain JSON.")
    }
    return JSON.parse(trimmed.slice(start, end + 1)) as JsonObject
  }
}

export function resolveCodeSliceHome(
  config: Pick<MatrixConfig, "install_root">,
  options: ResolveCodeSliceHomeOptions = {},
): ResolvedCodeSliceHome {
  const pathExists = options.exists ?? existsSync

  if (config.install_root?.trim()) {
    const installRoot = resolvePathInput(config.install_root.trim())
    return {
      path: joinForPath(installRoot, "tools", "code_slicer"),
      source: "config",
    }
  }

  for (const candidate of getCodeSliceHomeCandidates(options)) {
    if (!pathExists(candidate)) continue
    return {
      path: candidate,
      source: "auto_discovered",
    }
  }

  throw new Error(
    "code-slice home not found. Set install_root in .matrix/config/matrix.jsonc, or install code_slicer under the standard relative path <install>/tools/code_slicer.",
  )
}

function getPackageRoot(): string {
  return runtimeAssetRoot(import.meta.url)
}

function deriveInstallRootFromPath(candidatePath?: string): string | null {
  if (!candidatePath?.trim()) return null

  let current = resolvePathInput(candidatePath.trim())
  while (true) {
    const parent = dirnameForPath(current)
    if (parent === current) return null
    if (basenameForPath(current).toLowerCase() === "runtime") {
      return parent
    }
    current = parent
  }
}

export function getCodeSliceHomeCandidates(options: ResolveCodeSliceHomeOptions = {}): string[] {
  const packageRoot = getPackageRoot()
  const env = options.env ?? process.env
  const execPath = options.execPath ?? process.execPath

  const installRoots = [
    deriveInstallRootFromPath(execPath),
    deriveInstallRootFromPath(env.MATRIX_PYTHON),
  ].filter((value): value is string => Boolean(value))

  const candidates = [
    ...(options.candidates ?? []),
    ...installRoots.map((root) => joinForPath(root, "tools", "code_slicer")),
    join(packageRoot, "tools", "code_slicer"),
  ]

  return [...new Set(candidates.map((candidate) => resolvePathInput(candidate)))]
}

export function buildCodeSliceInvocation(
  args: {
    project_dir?: string
    output_dir?: string
    max_functions?: number
    max_total_lines?: number
    slicing_strategy?: CodeSliceSlicingStrategy
    python_executable?: string
  },
  deps: Pick<CodeSliceContextPackExecuteDeps, "loadConfig" | "resolvePython"> = {},
): CodeSliceInvocation {
  const projectDir = args.project_dir ? resolvePathInput(args.project_dir) : process.cwd()
  const outputDir = args.output_dir
    ? resolveProjectPath(args.output_dir, projectDir)
    : resolve(projectDir, ARTIFACT_PATHS.CONTEXTS_DIR)
  const config = (deps.loadConfig ?? loadPluginConfig)(projectDir)
  const codeSlice = resolveCodeSliceHome(config)
  const cwd = resolve(codeSlice.path, "work")
  const cliPath = resolve(cwd, "run_cli.py")
  const python = (deps.resolvePython ?? resolvePackagedPythonExecutable)(args.python_executable)
  const slicingStrategy = args.slicing_strategy ?? DEFAULT_SLICING_STRATEGY

  return {
    projectDir,
    outputDir,
    codeSliceHome: codeSlice.path,
    configSource: codeSlice.source,
    cliPath,
    cwd,
    python,
    args: [
      cliPath,
      "context-pack",
      "--repo",
      projectDir,
      "--out",
      outputDir,
      ...(typeof args.max_functions === "number" ? ["--max-functions", String(args.max_functions)] : []),
      ...(typeof args.max_total_lines === "number" ? ["--max-total-lines", String(args.max_total_lines)] : []),
      "--slicing-strategy",
      slicingStrategy,
    ],
  }
}

function normalizeSpawnText(value: SpawnSyncReturns<string>["stdout"] | SpawnSyncReturns<string>["stderr"]): string {
  return typeof value === "string" ? value : value ? String(value) : ""
}

export async function executeCodeSliceContextPack(
  args: {
    project_dir?: string
    output_dir?: string
    max_functions?: number
    max_total_lines?: number
    slicing_strategy?: CodeSliceSlicingStrategy
    python_executable?: string
  },
  deps: CodeSliceContextPackExecuteDeps = {},
): Promise<JsonObject> {
  try {
    const invocation = buildCodeSliceInvocation(args, deps)

    if (!existsSync(invocation.projectDir)) {
      return {
        status: "error",
        error: `Project directory not found: ${invocation.projectDir}`,
      }
    }

    if (!existsSync(invocation.cwd)) {
      return {
        status: "error",
        error: `code-slice work directory not found: ${invocation.cwd}`,
        code_slice_path: invocation.codeSliceHome,
        config_source: invocation.configSource,
      }
    }

    if (!existsSync(invocation.cliPath)) {
      return {
        status: "error",
        error: `code-slice CLI script not found: ${invocation.cliPath}`,
        code_slice_path: invocation.codeSliceHome,
        config_source: invocation.configSource,
      }
    }

    mkdirSync(invocation.outputDir, { recursive: true })

    const spawn = deps.spawn ?? spawnSync
    const result = spawn(invocation.python.executable, invocation.args, {
      cwd: invocation.cwd,
      encoding: "utf-8",
      stdio: "pipe",
    })

    const stdout = normalizeSpawnText(result.stdout)
    const stderr = normalizeSpawnText(result.stderr)

    if (result.error) {
      return {
        status: "error",
        error: `Failed to launch code-slice context-pack: ${result.error.message}`,
        project_dir: invocation.projectDir,
        output_dir: invocation.outputDir,
        code_slice_path: invocation.codeSliceHome,
        config_source: invocation.configSource,
        python_executable: invocation.python.executable,
        stdout: truncateText(stdout),
        stderr: truncateText(stderr),
      }
    }

    if (result.status !== 0) {
      return {
        status: "error",
        error: `code-slice context-pack exited with status ${result.status}.`,
        hint: "Check install_root, MATRIX_PYTHON, and the repo/output paths.",
        project_dir: invocation.projectDir,
        output_dir: invocation.outputDir,
        code_slice_path: invocation.codeSliceHome,
        config_source: invocation.configSource,
        python_executable: invocation.python.executable,
        stdout: truncateText(stdout),
        stderr: truncateText(stderr),
      }
    }

    const summary = extractJsonObject(stdout)
    if (typeof summary.manifest_file !== "string" || !summary.manifest_file.trim()) {
      return {
        status: "error",
        error: "code-slice context-pack summary is missing manifest_file.",
        project_dir: invocation.projectDir,
        output_dir: invocation.outputDir,
        stdout: truncateText(stdout),
        stderr: truncateText(stderr),
      }
    }
    if (typeof summary.context_count !== "number" || !Number.isInteger(summary.context_count) || summary.context_count < 0) {
      return {
        status: "error",
        error: "code-slice context-pack summary has invalid context_count.",
        project_dir: invocation.projectDir,
        output_dir: invocation.outputDir,
        stdout: truncateText(stdout),
        stderr: truncateText(stderr),
      }
    }
    if (typeof summary.blocks !== "object" || summary.blocks === null) {
      return {
        status: "error",
        error: "code-slice context-pack summary is missing blocks.",
        project_dir: invocation.projectDir,
        output_dir: invocation.outputDir,
        stdout: truncateText(stdout),
        stderr: truncateText(stderr),
      }
    }
    const blocks = summary.blocks as JsonObject
    if (blocks.slicing_strategy !== "path" && blocks.slicing_strategy !== "local_subgraph") {
      return {
        status: "error",
        error: "code-slice context-pack summary has invalid blocks.slicing_strategy.",
        project_dir: invocation.projectDir,
        output_dir: invocation.outputDir,
        stdout: truncateText(stdout),
        stderr: truncateText(stderr),
      }
    }
    const manifestFile = resolvePathInput(summary.manifest_file)

    return {
      status: "success",
      project_dir: invocation.projectDir,
      output_dir: invocation.outputDir,
      manifest_file: manifestFile,
      db_path: typeof summary.db_path === "string"
        ? resolvePathInput(summary.db_path)
        : resolve(invocation.projectDir, ARTIFACT_PATHS.INDEX_DB),
      context_count: summary.context_count,
      python_executable: invocation.python.executable,
      python_source: invocation.python.source,
      code_slice_path: invocation.codeSliceHome,
      config_source: invocation.configSource,
      index: typeof summary.index === "object" && summary.index !== null ? summary.index : {},
      blocks,
    }
  } catch (error) {
    return {
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export const codeSliceContextPack: ToolDefinition = tool({
  description:
    "Run code-slice context-pack for the current project and return the CLI summary. Defaults to local_subgraph contexts. This tool does not validate generated context file contents.",
  args: {
    project_dir: tool.schema.string().optional().describe("Project root directory. Default: current working directory."),
    output_dir: tool.schema.string().optional().describe("Output directory. Default: .matrix/data/contexts under the project."),
    max_functions: tool.schema.number().optional().describe("Optional max functions per block override."),
    max_total_lines: tool.schema.number().optional().describe("Optional source-function line limit for block growth; one seed function may exceed it."),
    slicing_strategy: tool.schema.enum(["path", "local_subgraph"]).optional().describe("Optional code-slice slicing strategy. Default: local_subgraph."),
    python_executable: tool.schema.string().optional().describe("Optional packaged Python override for testing/debugging."),
  },
  async execute(args) {
    return JSON.stringify(await executeCodeSliceContextPack(args))
  },
})
