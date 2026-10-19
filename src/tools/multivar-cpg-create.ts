import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, mkdirSync } from "fs"
import { join } from "path"
import { execSync } from "child_process"
import { resolveJoernBin, findMatrixRoot } from "./joern-resolve-cli"
import { ensureMatrixDirs } from "../shared/data-store"
import { resolveMatrixWorkspace } from "../shared/workspace-root"

const IS_WINDOWS = process.platform === "win32"

/**
 * multivar_cpg_create — Create a Joern Code Property Graph (CPG) from C/C++ source.
 * Used by: MultivarAtomicityChecker agent (Phase 3)
 *
 * Calls joern-parse to generate a CPG binary that is subsequently used by
 * multivar_correlated_vars and multivar_violation_detect for dataflow analysis.
 */
export const multivarCpgCreate: ToolDefinition = tool({
  description:
    "Create a Joern Code Property Graph (CPG) from C/C++ source files. " +
    "The CPG is a binary representation of the code's abstract syntax tree, control flow, " +
    "and data flow, required for correlated variable identification and violation detection. " +
    "Returns the path to the generated CPG file.",
  args: {
    source_dir: tool.schema
      .string()
      .describe(
        "Absolute path to the directory containing C/C++ source files to analyze.",
      ),
    project_name: tool.schema
      .string()
      .describe(
        "Project name used to label the CPG (e.g., 'my_firmware'). " +
        "Used as the CPG filename prefix.",
      ),
    output_dir: tool.schema
      .string()
      .optional()
      .describe(
        "Absolute path to the directory where the CPG file will be written. " +
        "Defaults to '<current_project_dir>/.matrix/cpg/' if not specified.",
      ),
  },
  async execute({ source_dir, project_name, output_dir }) {
    // Validate source directory exists
    if (!existsSync(source_dir)) {
      return JSON.stringify({
        status: "error",
        error: `Source directory not found: ${source_dir}`,
      })
    }

    // Determine output directory
    const matrixRoot = findMatrixRoot(source_dir) ?? resolveMatrixWorkspace(process.cwd()).workspaceDir
    ensureMatrixDirs(matrixRoot)
    const cpgDir = output_dir ?? join(matrixRoot, ".matrix", "cpg")
    if (!existsSync(cpgDir)) {
      mkdirSync(cpgDir, { recursive: true })
    }

    // Build CPG file path
    const cpgFileName = `${project_name}.bin`
    const cpgPath = join(cpgDir, cpgFileName)

    // Resolve joern-parse binary
    const projectRoot = matrixRoot
    const joernParse = resolveJoernBin("joern-parse", projectRoot)

    // Build the command
    // joern-parse <source_dir> --output <cpg_path>
    const cmd = `${joernParse} "${source_dir}" --output "${cpgPath}"`

    try {
      const stdout = execSync(cmd, {
        stdio: "pipe",
        timeout: 300_000, // 5 minutes
        encoding: "utf-8",
        maxBuffer: 50 * 1024 * 1024,
        ...(IS_WINDOWS && { shell: "cmd.exe" }),
      })

      // Verify CPG file was created
      if (!existsSync(cpgPath)) {
        return JSON.stringify({
          status: "error",
          error:
            "joern-parse completed but CPG file was not created. " +
            `Expected at: ${cpgPath}`,
          stdout: stdout.slice(0, 2000),
        })
      }

      return JSON.stringify({
        status: "success",
        cpg_path: cpgPath,
        project_name,
        source_dir,
        message: `CPG created successfully at ${cpgPath}`,
      })
    } catch (err: any) {
      const stderr = err.stderr
        ? String(err.stderr).slice(0, 2000)
        : ""
      const stdout = err.stdout
        ? String(err.stdout).slice(0, 2000)
        : ""
      return JSON.stringify({
        status: "error",
        error: `joern-parse failed: ${(err.message || String(err)).slice(0, 500)}`,
        stderr,
        stdout,
        hint:
          "Ensure Joern is installed. Set JOERN_HOME environment variable or " +
          "place joern-cli in D:\\joern-cli\\joern-cli\\ (Windows).",
      })
    }
  },
})
