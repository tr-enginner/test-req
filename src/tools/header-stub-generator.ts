import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { join, resolve, dirname, basename } from "path"
import {
  resolveAllIncludes,
  discoverExpectedSymbols,
  generateDemandStub,
} from "./preprocessing/include-resolver"
import {
  getPrebuiltStub,
  categorizeHeader,
} from "./preprocessing/standard-stubs"
import { STUBS_DIR, DATA_DIR } from "../shared/constants"

/**
 * header_stub_generator — Generate minimal stub headers for missing
 * #include references so that preprocessing and parsing can proceed.
 */
export const headerStubGenerator: ToolDefinition = tool({
  description:
    "Generate minimal stub headers for missing #include references in a C/C++ project. " +
    "Analyzes source files to find unresolvable headers, then generates stubs with " +
    "type declarations, function prototypes, and macros that the source code expects. " +
    "Supports standard C library, CMSIS, FreeRTOS, and common vendor HAL headers. " +
    "Updates compile_commands.json to include the stub directory.",
  args: {
    compile_commands_path: tool.schema
      .string()
      .describe("Path to compile_commands.json (from compdb_generator)"),
    source_path: tool.schema
      .string()
      .describe("Path to the source code root directory"),
    stub_output_dir: tool.schema
      .string()
      .optional()
      .describe("Directory to write stub headers (default: .matrix/stubs/)"),
    compiler_dialect: tool.schema
      .enum([
        "gcc", "armcc", "armclang", "iar", "keil",
        "c51", "greenhill", "ti", "windriver", "generic",
      ])
      .optional()
      .describe("Compiler dialect for selecting appropriate stubs"),
  },
  async execute({
    compile_commands_path,
    source_path,
    stub_output_dir,
    compiler_dialect,
  }) {
    const sourcePath = resolve(source_path)
    const compdbPath = resolve(compile_commands_path)

    if (!existsSync(compdbPath)) {
      return JSON.stringify({ error: `compile_commands.json not found: ${compile_commands_path}` })
    }

    // Parse compile_commands.json
    let compileCommands: Array<{ directory: string; command: string; file: string }>
    try {
      compileCommands = JSON.parse(readFileSync(compdbPath, "utf-8"))
    } catch (e) {
      return JSON.stringify({ error: `Failed to parse compile_commands.json: ${e}` })
    }

    // Extract source files and include dirs from compile_commands
    const sourceFiles: string[] = compileCommands.map((e) => e.file)
    const includeDirs: string[] = []
    for (const entry of compileCommands) {
      const flags = entry.command.split(/\s+/)
      for (const flag of flags) {
        if (flag.startsWith("-I")) {
          const dir = resolve(entry.directory, flag.slice(2))
          if (!includeDirs.includes(dir)) includeDirs.push(dir)
        }
      }
    }

    // Resolve includes to find missing headers
    const resolution = resolveAllIncludes(sourceFiles, includeDirs)

    if (resolution.missing_headers.length === 0) {
      return JSON.stringify({
        stubs_generated: 0,
        stub_dir: stub_output_dir || join(sourcePath, STUBS_DIR),
        stubs: [],
        updated_compile_commands: false,
      }, null, 2)
    }

    // Set up stub output directory
    const stubDir = resolve(stub_output_dir || join(sourcePath, STUBS_DIR))
    if (!existsSync(stubDir)) {
      mkdirSync(stubDir, { recursive: true })
    }

    const stubs: Array<{
      header_name: string
      stub_path: string
      category: string
      symbols_stubbed: number
    }> = []

    for (const missing of resolution.missing_headers) {
      const headerName = missing.header
      const headerBasename = basename(headerName)
      const category = categorizeHeader(headerName)

      // Determine stub file path (preserve subdirectory structure)
      const stubPath = join(stubDir, headerName)
      const stubFileDir = dirname(stubPath)
      if (!existsSync(stubFileDir)) {
        mkdirSync(stubFileDir, { recursive: true })
      }

      // Try pre-built stub first
      let stubContent = getPrebuiltStub(headerBasename)
      let symbolCount = 0

      if (stubContent) {
        // Count symbols in pre-built stub (rough estimate)
        symbolCount = (stubContent.match(/\b(?:typedef|void|int|uint|char|struct|enum|#define)\b/g) || []).length
      } else {
        // Generate demand-driven stub by analyzing what the source expects
        const symbols = discoverExpectedSymbols(headerName, missing.referenced_by)
        stubContent = generateDemandStub(headerName, symbols)
        symbolCount = symbols.types.length + symbols.functions.length + symbols.macros.length
      }

      writeFileSync(stubPath, stubContent, "utf-8")

      stubs.push({
        header_name: headerName,
        stub_path: stubPath,
        category,
        symbols_stubbed: symbolCount,
      })
    }

    // Update compile_commands.json to include the stub directory
    let updatedCompdb = false
    const stubIncludeFlag = `-I${stubDir}`

    const updatedCommands = compileCommands.map((entry) => {
      if (!entry.command.includes(stubDir)) {
        updatedCompdb = true
        return {
          ...entry,
          command: `${entry.command} ${stubIncludeFlag}`,
        }
      }
      return entry
    })

    if (updatedCompdb) {
      writeFileSync(compdbPath, JSON.stringify(updatedCommands, null, 2), "utf-8")
    }

    return JSON.stringify({
      stubs_generated: stubs.length,
      stub_dir: stubDir,
      stubs,
      updated_compile_commands: updatedCompdb,
    }, null, 2)
  },
})
