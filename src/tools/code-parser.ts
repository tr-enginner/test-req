import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs"
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "path"
import {
  analyzeCodeFile,
  type AnalyzedFunction,
  type CodeParseWarning,
} from "./tree-sitter-code-analyzer"

/**
 * code_parser - Parse C/C++ source code with Tree-sitter ASTs and extract
 * function signatures, call graphs, control flow, and complexity metrics.
 */
export const codeParser: ToolDefinition = tool({
  description:
    "Parse C/C++ source files with Tree-sitter ASTs and extract function signatures, " +
    "call relationships, cyclomatic complexity estimates, and module structure. " +
    "Returns structured JSON with functions, calls, and metrics.",
  args: {
    path: tool.schema
      .string()
      .describe("Path to a C/C++ source file or directory to parse"),
    recursive: tool.schema
      .boolean()
      .optional()
      .describe("If path is a directory, parse recursively (default: true)"),
    preprocessed_path: tool.schema
      .string()
      .optional()
      .describe(
        "Path to preprocessed version of the file or directory (from code_preprocessor). " +
        "If provided, parsing uses the preprocessed (dialect-translated) source for more " +
        "accurate function extraction, but reports original file paths in results.",
      ),
    function_names: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe(
        "Optional list of function names to include in the result. Useful for incremental large-file analysis.",
      ),
    include_bodies: tool.schema
      .boolean()
      .optional()
      .describe(
        "When true, include the parsed function body text in each returned function record. Default: false.",
      ),
    output_file: tool.schema
      .string()
      .optional()
      .describe(
        "Optional file path to persist the full parse result. When provided, the tool writes the full JSON to this path and returns only a compact summary.",
      ),
  },
  async execute({ path, recursive = true, preprocessed_path, function_names, include_bodies = false, output_file }) {
    if (!existsSync(path)) {
      return JSON.stringify({ error: `Path not found: ${path}` })
    }

    const stat = statSync(path)
    const files: string[] = []
    const requestedNames = function_names?.length ? new Set(function_names) : null

    if (stat.isDirectory()) {
      collectCFiles(path, files, recursive, { skipGeneratedDirs: true })
    } else {
      files.push(path)
    }

    const usePreprocessed = Boolean(preprocessed_path && existsSync(preprocessed_path))
    const preprocessedFiles: string[] = []
    if (usePreprocessed && preprocessed_path) {
      const preprocessedStat = statSync(preprocessed_path)
      if (preprocessedStat.isDirectory()) {
        collectCFiles(preprocessed_path, preprocessedFiles, recursive, { skipGeneratedDirs: false })
      } else {
        preprocessedFiles.push(preprocessed_path)
      }
    }

    const projectRoot = inferProjectRoot(path, preprocessed_path)
    const preprocessedMap = buildPreprocessedMap(files, preprocessedFiles, projectRoot, path)
    const parseWarnings: CodeParseWarning[] = []
    const parsedFunctions: AnalyzedFunction[] = []
    let totalLoc = 0

    for (const filePath of files) {
      const originalContent = readFileSync(filePath, "utf-8")
      totalLoc += originalContent.split("\n").length

      const target = preprocessedMap.get(resolve(filePath))
      const parsePath = target?.parsePath ?? filePath
      const parseContent = readFileSync(parsePath, "utf-8")
      const analysis = await analyzeCodeFile({
        originalPath: filePath,
        parsePath,
        reportedPath: target?.reportedPath ?? filePath,
        parseContent,
        originalContent,
        lineDelta: target?.lineDelta ?? 0,
        includeBodies: include_bodies,
      })

      parseWarnings.push(...analysis.warnings)
      parsedFunctions.push(...analysis.functions)
    }

    const selectedFunctions = requestedNames
      ? parsedFunctions.filter((fn) => requestedNames.has(fn.name))
      : parsedFunctions

    const allFunctions = selectedFunctions.map((fn, index) => ({
      id: `FUNC-${String(index + 1).padStart(3, "0")}`,
      ...fn,
      called_by: [] as string[],
    }))

    const byName = new Map(allFunctions.map((fn) => [fn.name, fn]))
    for (const fn of allFunctions) {
      for (const callee of fn.calls) {
        const target = byName.get(callee)
        if (target && !target.called_by.includes(fn.name)) {
          target.called_by.push(fn.name)
        }
      }
    }

    const modules = Array.from(
      allFunctions.reduce((map, fn) => {
        const key = fn.file_path
        const existing = map.get(key) ?? {
          name: basename(fn.file_path, extname(fn.file_path)),
          path: fn.file_path,
          functions: [] as string[],
        }
        if (!existing.functions.includes(fn.name)) existing.functions.push(fn.name)
        map.set(key, existing)
        return map
      }, new Map<string, { name: string; path: string; functions: string[] }>()),
    ).map(([, module]) => module)

    const dataFlowGraph = {
      nodes: allFunctions.map((fn) => ({
        id: fn.id,
        name: fn.name,
        type: "function" as const,
        file_path: fn.file_path,
        line_range: fn.line_range,
      })),
      edges: allFunctions.flatMap((fn) =>
        fn.calls
          .map((callee, index) => {
            const target = byName.get(callee)
            if (!target) return null
            return {
              id: `EDGE-${fn.id}-${index + 1}`,
              source_node: fn.id,
              target_node: target.id,
              data_name: "call",
              data_type: "control_flow",
              description: `${fn.name} calls ${callee}`,
            }
          })
          .filter((edge): edge is {
            id: string
            source_node: string
            target_node: string
            data_name: string
            data_type: string
            description: string
          } => edge !== null),
      ),
    }

    const result = {
      path,
      files_parsed: files.length,
      total_loc: totalLoc,
      total_functions: allFunctions.length,
      functions: allFunctions,
      modules,
      data_flow_graph: dataFlowGraph,
      avg_complexity:
        allFunctions.length > 0
          ? Math.round(
              (allFunctions.reduce((s, f) => s + f.cyclomatic_complexity, 0) /
                allFunctions.length) *
                10,
            ) / 10
          : 0,
      ...(parseWarnings.length > 0 ? { parse_warnings: parseWarnings } : {}),
    }

    if (output_file) {
      const fullOutputPath = isAbsolute(output_file) ? resolve(output_file) : resolve(process.cwd(), output_file)
      const dir = dirname(fullOutputPath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(fullOutputPath, JSON.stringify(result, null, 2), "utf-8")

      return JSON.stringify({
        path,
        output_file,
        files_parsed: files.length,
        total_loc: totalLoc,
        total_functions: allFunctions.length,
        avg_complexity: result.avg_complexity,
        ...(parseWarnings.length > 0 ? { parse_warnings: parseWarnings } : {}),
      }, null, 2)
    }

    return JSON.stringify(result, null, 2)
  },
})

type PreprocessedTarget = {
  parsePath: string
  reportedPath: string
  lineDelta: number
}

function collectCFiles(
  dir: string,
  files: string[],
  recursive: boolean,
  options?: { skipGeneratedDirs?: boolean },
): void {
  const entries = readdirSync(dir)
  for (const entry of entries) {
    if (options?.skipGeneratedDirs && shouldSkipGeneratedDir(entry)) {
      continue
    }
    const fullPath = join(dir, entry)
    const stat = statSync(fullPath)
    if (stat.isDirectory() && recursive) {
      collectCFiles(fullPath, files, recursive, options)
    } else if (stat.isFile()) {
      const ext = extname(entry).toLowerCase()
      if ([".c", ".h", ".cpp", ".hpp", ".cc", ".cxx"].includes(ext)) {
        files.push(fullPath)
      }
    }
  }
}

function shouldSkipGeneratedDir(name: string): boolean {
  return name === ".matrix" || name === ".git" || name === "node_modules"
}

function buildPreprocessedMap(
  originalFiles: string[],
  preprocessedFiles: string[],
  projectRoot: string,
  originalInputPath: string,
): Map<string, PreprocessedTarget> {
  const map = new Map<string, PreprocessedTarget>()
  if (preprocessedFiles.length === 0) return map

  const originalByResolved = new Map(originalFiles.map((file) => [resolve(file).toLowerCase(), resolve(file)]))
  const originalByBaseName = new Map<string, string[]>()
  for (const file of originalFiles) {
    const key = basename(file).toLowerCase()
    const group = originalByBaseName.get(key) ?? []
    group.push(resolve(file))
    originalByBaseName.set(key, group)
  }

  for (const parsePath of preprocessedFiles) {
    const directive = readLineDirective(parsePath)
    const directivePath = directive
      ? resolveDirectivePath(directive.path, projectRoot)
      : null
    const fallbackPath = findOriginalByFallback(parsePath, originalFiles, originalByBaseName, originalInputPath)
    const originalPath = directivePath
      ? originalByResolved.get(resolve(directivePath).toLowerCase()) ??
        findOriginalByDirectiveSuffix(directive?.path ?? "", originalFiles) ??
        fallbackPath
      : fallbackPath

    if (!originalPath) continue

    const lineDelta = directive
      ? directive.originalStartLine - (directive.directiveLine + 1)
      : 0

    map.set(resolve(originalPath), {
      parsePath,
      reportedPath: existsSync(originalPath) ? originalPath : resolve(originalPath),
      lineDelta,
    })
  }

  return map
}

function readLineDirective(filePath: string): {
  directiveLine: number
  originalStartLine: number
  path: string
} | null {
  const lines = readFileSync(filePath, "utf-8").split("\n")
  for (let index = 0; index < Math.min(lines.length, 10); index++) {
    const match = lines[index].match(/^#line\s+(\d+)\s+"([^"]+)"/)
    if (match) {
      return {
        directiveLine: index + 1,
        originalStartLine: Number(match[1]),
        path: match[2],
      }
    }
  }
  return null
}

function resolveDirectivePath(directivePath: string, projectRoot: string): string {
  return isAbsolute(directivePath) ? resolve(directivePath) : resolve(projectRoot, directivePath)
}

function findOriginalByFallback(
  parsePath: string,
  originalFiles: string[],
  originalByBaseName: Map<string, string[]>,
  originalInputPath: string,
): string | null {
  const inputStat = existsSync(originalInputPath) ? statSync(originalInputPath) : null
  if (inputStat?.isDirectory()) {
    const relativeCandidate = resolve(originalInputPath, relative(dirname(parsePath), parsePath))
    const found = originalFiles.find((file) => resolve(file).toLowerCase() === relativeCandidate.toLowerCase())
    if (found) return resolve(found)
  }

  const basenameMatches = originalByBaseName.get(basename(parsePath).toLowerCase()) ?? []
  return basenameMatches.length === 1 ? basenameMatches[0] : null
}

function findOriginalByDirectiveSuffix(directivePath: string, originalFiles: string[]): string | null {
  const normalizedDirective = directivePath.replace(/\\/g, "/").toLowerCase()
  const matches = originalFiles.filter((file) =>
    resolve(file).replace(/\\/g, "/").toLowerCase().endsWith(normalizedDirective),
  )
  return matches.length === 1 ? resolve(matches[0]) : null
}

function inferProjectRoot(originalPath: string, preprocessedPath?: string): string {
  if (preprocessedPath) {
    const normalized = resolve(preprocessedPath).replace(/\\/g, "/")
    const marker = "/.matrix/preprocessed"
    const markerIndex = normalized.indexOf(marker)
    if (markerIndex >= 0) {
      return normalized.slice(0, markerIndex)
    }
  }

  const resolvedOriginal = resolve(originalPath)
  if (existsSync(resolvedOriginal) && statSync(resolvedOriginal).isDirectory()) {
    return resolvedOriginal
  }
  return dirname(resolvedOriginal)
}
