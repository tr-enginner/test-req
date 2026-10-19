import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { resolve } from "path"
import { resolveAunitCli, execAunit, buildArgs, normalizePath, AUNIT_WORKSPACE, normalizeProjectDir } from "./aunit-utils"
import { REPORTS_DIR } from "../../shared/constants"

/**
 * aunit_report — Export test reports from an AUnit project.
 * Wraps: SunwiseAUnit.cli.bat ut report
 */
export const aunitReport: ToolDefinition = tool({
  description:
    "Export unit test reports from a SunwiseAUnit project. " +
    "Supports doc (Word), pdf, and html output formats.",
  args: {
    project_name: tool.schema.string().describe("AUnit project name"),
    format: tool.schema
      .enum(["doc", "pdf", "html"])
      .optional()
      .describe("Report format (default: doc)"),
    output_path: tool.schema
      .string()
      .optional()
      .describe("Output file path (default: .matrix/reports/)"),
    template_path: tool.schema
      .string()
      .optional()
      .describe("Custom report template file path (.template)"),
    aunit_path: tool.schema
      .string()
      .optional()
      .describe("Path to AUnit installation directory (optional — auto-detected from PATH if omitted)"),
    project_dir: tool.schema
      .string()
      .describe("Project root directory"),
  },
  async execute({ project_name, format, output_path, template_path, aunit_path, project_dir }) {
    let cliPath: string
    let installDir: string
    try {
      const cli = resolveAunitCli(aunit_path)
      cliPath = cli.cliPath
      installDir = cli.installDir
    } catch (err) {
      return JSON.stringify({
        status: "abnormal",
        error: err instanceof Error ? err.message : String(err),
      })
    }

    const reportFormat = format || "doc"
    const normalizedDir = normalizeProjectDir(project_dir)
    const projectPath = resolve(normalizePath(normalizedDir), AUNIT_WORKSPACE, project_name)

    // Default output to .matrix/reports/
    const defaultOutput = resolve(normalizePath(normalizedDir), REPORTS_DIR, `aunit-report.${reportFormat}`)
    const outputFile = output_path || defaultOutput

    const args = buildArgs({
      "-pp": projectPath,
      "-f": reportFormat,
      "-o": outputFile,
      "-template": template_path,
    })

    const result = execAunit(cliPath, installDir, "ut", "report", args, 1_800_000, project_dir)

    if (result.exitCode !== 0 && !result.stdout.includes("success")) {
      return JSON.stringify({
        status: "error",
        exit_code: result.exitCode,
        message: "AUnit report generation failed",
        cmd: result.cmd,
        stdout: result.stdout.slice(0, 3000),
        stderr: result.stderr.slice(0, 3000),
      })
    }

    return JSON.stringify({
      status: "success",
      project_name,
      format: reportFormat,
      output_path: outputFile,
      cmd: result.cmd,
      stdout: result.stdout.slice(0, 3000),
    })
  },
})
