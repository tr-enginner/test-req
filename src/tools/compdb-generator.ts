import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { dirname, join, resolve, relative } from "path"
import {
  detectBuildSystem,
  parseBuildSystem,
} from "./preprocessing/build-parsers"
import { detectDialect } from "./preprocessing/dialect-rules"
import {
  resolveAllIncludes,
  extractIncludes,
} from "./preprocessing/include-resolver"
import { DATA_DIR } from "../shared/constants"
import { ensureMatrixDirs } from "../shared/data-store"
import { resolveMatrixWorkspace } from "../shared/workspace-root"
import { CompilationEnvironment } from "../schema/compilation"

function writeCompilationEnvironment({
  matrixRoot,
  sourcePath,
  buildSystem,
  compilerDialect,
  targetCpu,
  compileCommandsPath,
  filesIndexed,
  includeDirs,
  defines,
  missingHeaders,
  preprocessedDir,
}: {
  matrixRoot: string
  sourcePath: string
  buildSystem: string | null
  compilerDialect: string
  targetCpu?: string
  compileCommandsPath: string
  filesIndexed: number
  includeDirs: string[]
  defines: string[]
  missingHeaders: string[]
  preprocessedDir?: string
}): string {
  const outputPath = join(matrixRoot, DATA_DIR, "compilation-env.json")
  const parsed = CompilationEnvironment.parse({
    project_path: sourcePath,
    build_system: buildSystem ?? "none",
    compiler_dialect: compilerDialect,
    ...(targetCpu ? { target_cpu: targetCpu } : {}),
    compile_commands_path: compileCommandsPath,
    files_indexed: filesIndexed,
    include_dirs: includeDirs,
    defines,
    missing_headers: missingHeaders,
    stubs: [],
    ...(preprocessedDir ? { preprocessed_dir: preprocessedDir } : {}),
    created_date: new Date().toISOString(),
  })

  writeFileSync(outputPath, JSON.stringify(parsed, null, 2), "utf-8")
  return outputPath
}

/**
 * compdb_generator — Detect the build system, detect compiler dialect,
 * and generate a compile_commands.json (JSON Compilation Database)
 * even when the build system is incomplete or missing.
 */
export const compdbGenerator: ToolDefinition = tool({
  description:
    "Detect the build system and compiler dialect of a C/C++ embedded project, " +
    "then generate a compile_commands.json (JSON Compilation Database). " +
    "Works even when the build system is incomplete or missing by inferring " +
    "include paths from directory structure and #include directives. " +
    "Returns the path to the generated compile_commands.json along with " +
    "detected build system, dialect, and any missing headers.",
  args: {
    source_path: tool.schema
      .string()
      .describe("Path to the source code root directory"),
    compiler_dialect: tool.schema
      .enum([
        "auto", "gcc", "armcc", "armclang", "iar", "keil",
        "c51", "greenhill", "ti", "windriver", "generic",
      ])
      .optional()
      .describe("Compiler dialect to use (default: auto-detect from source)"),
    extra_includes: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("Additional include directories to add"),
    extra_defines: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("Additional preprocessor defines (e.g., 'STM32F407xx', 'USE_HAL_DRIVER')"),
    target_cpu: tool.schema
      .string()
      .optional()
      .describe("Target CPU architecture (e.g., 'cortex-m4', 'cortex-a9')"),
  },
  async execute({
    source_path,
    compiler_dialect = "auto",
    extra_includes = [],
    extra_defines = [],
    target_cpu,
  }) {
    const sourcePath = resolve(source_path)
    if (!existsSync(sourcePath)) {
      return JSON.stringify({ error: `Source path not found: ${source_path}` })
    }

    const warnings: string[] = []

    // 1. Detect build system
    const detected = detectBuildSystem(sourcePath)

    // If an existing compile_commands.json was found, load and augment it
    if (detected.type === "none" && detected.path && detected.path.endsWith("compile_commands.json")) {
      try {
        const existing = JSON.parse(readFileSync(detected.path, "utf-8"))
        const matrixRoot = resolveMatrixWorkspace(process.cwd()).workspaceDir
        ensureMatrixDirs(matrixRoot)
        const compilationEnvPath = writeCompilationEnvironment({
          matrixRoot,
          sourcePath,
          buildSystem: "none",
          compilerDialect: compiler_dialect === "auto" ? "gcc" : compiler_dialect,
          targetCpu: target_cpu,
          compileCommandsPath: detected.path,
          filesIndexed: existing.length,
          includeDirs: [],
          defines: [],
          missingHeaders: [],
        })

        return JSON.stringify({
          compile_commands_path: detected.path,
          compilation_env_path: compilationEnvPath,
          build_system_detected: "compile_commands.json (existing)",
          compiler_dialect: compiler_dialect === "auto" ? "gcc" : compiler_dialect,
          files_indexed: existing.length,
          include_dirs: [],
          defines: [],
          missing_headers: [],
          warnings: ["Using existing compile_commands.json"],
        }, null, 2)
      } catch {
        warnings.push("Failed to parse existing compile_commands.json, regenerating")
      }
    }

    // 2. Parse build system to extract build info
    const buildInfo = parseBuildSystem(detected, sourcePath)

    // Merge with extra includes/defines
    const allIncludes = [...buildInfo.includes, ...extra_includes.map((p) => resolve(sourcePath, p))]
    const allDefines = [...buildInfo.defines, ...extra_defines]

    // If no sources found from build system, scan the directory
    if (buildInfo.sources.length === 0) {
      warnings.push("No source files found from build system, scanning directory")
      // The inferFromSource in build-parsers already handles this
      // but buildInfo.sources may be empty if the parse method didn't find them
      const fallback = parseBuildSystem({ type: "none", path: null }, sourcePath)
      buildInfo.sources.push(...fallback.sources)
      for (const inc of fallback.includes) {
        if (!allIncludes.includes(inc)) allIncludes.push(inc)
      }
      for (const def of fallback.defines) {
        if (!allDefines.includes(def)) allDefines.push(def)
      }
    }

    // 3. Detect compiler dialect
    let dialect = compiler_dialect
    if (dialect === "auto") {
      // Sample up to 20 source files for dialect detection
      const sampleContents: string[] = []
      for (const src of buildInfo.sources.slice(0, 20)) {
        try {
          sampleContents.push(readFileSync(src, "utf-8"))
        } catch {
          // Skip unreadable
        }
      }
      dialect = detectDialect(sampleContents) as typeof dialect
    }

    // 4. Resolve includes and find missing headers
    const resolution = resolveAllIncludes(buildInfo.sources, allIncludes)
    const missingHeaders = resolution.missing_headers.map((m) => m.header)

    // 5. Build compiler command string
    const includeFlags = allIncludes.map((d) => `-I${d}`).join(" ")
    const defineFlags = allDefines.map((d) => `-D${d}`).join(" ")
    const cpuFlag = target_cpu ? `-mcpu=${target_cpu}` : ""
    const baseCommand = `cc ${includeFlags} ${defineFlags} ${cpuFlag} ${buildInfo.compiler_flags.join(" ")}`.replace(/\s+/g, " ").trim()

    // 6. Generate compile_commands.json
    const compileCommands = buildInfo.sources.map((srcFile) => ({
      directory: sourcePath,
      command: `${baseCommand} -c ${srcFile}`,
      file: srcFile,
    }))

    // Always persist under the current OpenCode project directory rather than sourcePath,
    // otherwise opening the project from both root and a source subdirectory can create
    // duplicate .matrix trees.
    const matrixRoot = resolveMatrixWorkspace(process.cwd()).workspaceDir
    ensureMatrixDirs(matrixRoot)
    const outputDir = join(matrixRoot, DATA_DIR)
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true })
    }
    const outputPath = join(matrixRoot, DATA_DIR, "compile_commands.json")
    writeFileSync(outputPath, JSON.stringify(compileCommands, null, 2), "utf-8")
    const compilationEnvPath = writeCompilationEnvironment({
      matrixRoot,
      sourcePath,
      buildSystem: detected.type === "none" ? "none" : detected.type,
      compilerDialect: dialect,
      targetCpu: target_cpu,
      compileCommandsPath: outputPath,
      filesIndexed: compileCommands.length,
      includeDirs: allIncludes,
      defines: allDefines,
      missingHeaders,
      preprocessedDir: join(matrixRoot, ".matrix", "preprocessed"),
    })

    return JSON.stringify({
      compile_commands_path: outputPath,
      compilation_env_path: compilationEnvPath,
      matrix_root: matrixRoot,
      build_system_detected: detected.type === "none" ? null : detected.type,
      compiler_dialect: dialect,
      files_indexed: compileCommands.length,
      include_dirs: allIncludes,
      defines: allDefines,
      missing_headers: missingHeaders,
      warnings,
    }, null, 2)
  },
})
