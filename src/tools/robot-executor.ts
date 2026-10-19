import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, readFileSync, mkdirSync } from "fs"
import { join, resolve } from "path"
import { execSync } from "child_process"

/**
 * Detect Robot Framework availability.
 * Returns the command prefix to invoke Robot Framework, or null if not found.
 */
function detectRobotFramework(): string | null {
  const isWindows = process.platform === "win32"
  const whichCmd = isWindows ? "where robot" : "which robot"

  // Try direct `robot` command on PATH
  try {
    execSync(whichCmd, { stdio: "pipe", timeout: 10_000 })
    return "robot"
  } catch {
    // not on PATH
  }

  // Try `python -m robot`
  try {
    execSync("python -m robot --version", { stdio: "pipe", timeout: 10_000 })
    return "python -m robot"
  } catch {
    // not available via python either
  }

  // Try `python3 -m robot` (Linux/macOS)
  if (!isWindows) {
    try {
      execSync("python3 -m robot --version", { stdio: "pipe", timeout: 10_000 })
      return "python3 -m robot"
    } catch {
      // not available
    }
  }

  return null
}

export type RobotTestStatus = "PASS" | "FAIL" | "SKIP" | "NOT RUN"

export interface RobotOutputTestResult {
  name: string
  status: RobotTestStatus
  message: string
}

function normalizeRobotStatus(value: string | undefined): RobotTestStatus {
  if (!value) return "NOT RUN"
  const upper = value.toUpperCase()
  if (upper === "PASS") return "PASS"
  if (upper === "FAIL") return "FAIL"
  if (upper === "SKIP") return "SKIP"
  return "NOT RUN"
}

/**
 * Parse Robot Framework output.xml to extract test results.
 * Returns summary statistics and per-test results with status.
 */
export function parseOutputXml(outputXmlPath: string): {
  total: number
  passed: number
  failed: number
  skipped: number
  details: Array<{ name: string; message: string }>
  tests: RobotOutputTestResult[]
} {
  const tests: RobotOutputTestResult[] = []
  const result = {
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    details: [] as Array<{ name: string; message: string }>,
    tests,
  }

  if (!existsSync(outputXmlPath)) {
    return result
  }

  const xml = readFileSync(outputXmlPath, "utf-8")

  // Extract statistics from <stat> elements in <total>
  // Pattern: <stat pass="N" fail="N" skip="N">All Tests</stat>
  const totalStatMatch = xml.match(
    /<stat\s+pass="(\d+)"\s+fail="(\d+)"(?:\s+skip="(\d+)")?>All Tests<\/stat>/,
  )
  if (totalStatMatch) {
    result.passed = parseInt(totalStatMatch[1], 10)
    result.failed = parseInt(totalStatMatch[2], 10)
    result.skipped = parseInt(totalStatMatch[3] || "0", 10)
    result.total = result.passed + result.failed + result.skipped
  }

  // Extract test details for all statuses
  // Pattern: <test ... name="TestName"> ... <status status="..." ...>message</status> ... </test>
  const testBlockRegex = /<test\s[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/test>/g
  let match: RegExpExecArray | null
  while ((match = testBlockRegex.exec(xml)) !== null) {
    const testName = match[1]
    const testBody = match[2]

    const statusMatch = testBody.match(
      /<status\s+status="([^"]*)"[^>]*>([^<]*)<\/status>/,
    )
    if (statusMatch) {
      const rawStatus = statusMatch[1]
      const message = statusMatch[2] || ""
      const status = normalizeRobotStatus(rawStatus)
      result.details.push({
        name: testName,
        message: message || "No failure message",
      })
      tests.push({
        name: testName,
        status,
        message: message || "No failure message",
      })
    }
  }

  return result
}

/**
 * robot_executor — Execute Robot Framework test suites (.robot files).
 *
 * Detects Robot Framework installation, builds and executes the `robot` command,
 * parses output.xml for results, and returns a structured JSON summary.
 */
export const robotExecutor: ToolDefinition = tool({
  description:
    "Execute Robot Framework test suites (.robot files). " +
    "Runs the `robot` CLI, parses output.xml for results, and returns " +
    "a structured summary with pass/fail counts, failure details, and output paths. " +
    "Requires Robot Framework to be installed (pip install robotframework).",
  args: {
    suite_path: tool.schema
      .string()
      .describe(
        "Path to a .robot file or directory containing .robot files (absolute or relative path)",
      ),
    output_dir: tool.schema
      .string()
      .optional()
      .describe(
        "Output directory for Robot Framework results (log.html, report.html, output.xml). " +
        "Default: .matrix/data/robot-output",
      ),
    variables: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe(
        "Robot Framework variables in KEY:VALUE format, e.g. ['ENV:staging', 'TIMEOUT:30']",
      ),
    include_tags: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("Only run test cases with these tags"),
    exclude_tags: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("Exclude test cases with these tags"),
    timeout: tool.schema
      .number()
      .optional()
      .describe("Execution timeout in seconds (default: 300)"),
  },
  async execute({ suite_path, output_dir, variables, include_tags, exclude_tags, timeout }) {
    const startTime = Date.now()

    // 1. Detect Robot Framework
    const robotCmd = detectRobotFramework()
    if (!robotCmd) {
      return JSON.stringify({
        status: "error",
        error:
          "Robot Framework not found. Install it with: pip install robotframework",
        hint: "Ensure 'robot' is on PATH, or 'python -m robot' works.",
      })
    }

    // 2. Resolve paths
    const suitePath = resolve(suite_path)
    if (!existsSync(suitePath)) {
      return JSON.stringify({
        status: "error",
        error: `Suite path not found: ${suitePath}`,
      })
    }

    const outputDir = resolve(output_dir || ".matrix/data/robot-output")
    mkdirSync(outputDir, { recursive: true })

    const outputXmlPath = join(outputDir, "output.xml")
    const timeoutMs = (timeout || 300) * 1000

    // 3. Build command
    const cmdParts: string[] = [robotCmd]
    cmdParts.push("--outputdir", `"${outputDir}"`)

    if (variables && variables.length > 0) {
      for (const v of variables) {
        cmdParts.push("--variable", `"${v}"`)
      }
    }

    if (include_tags && include_tags.length > 0) {
      for (const tag of include_tags) {
        cmdParts.push("--include", `"${tag}"`)
      }
    }

    if (exclude_tags && exclude_tags.length > 0) {
      for (const tag of exclude_tags) {
        cmdParts.push("--exclude", `"${tag}"`)
      }
    }

    cmdParts.push(`"${suitePath}"`)
    const cmd = cmdParts.join(" ")

    // 4. Execute
    let stdout = ""
    let stderr = ""
    let exitCode = 0

    try {
      stdout = execSync(cmd, {
        stdio: "pipe",
        timeout: timeoutMs,
        encoding: "utf-8",
        maxBuffer: 20 * 1024 * 1024,
        cwd: process.cwd(),
      })
    } catch (err: any) {
      exitCode = err.status ?? 1
      stdout = err.stdout || ""
      stderr = err.stderr || ""

      // Robot Framework returns non-zero exit code when tests fail,
      // but output.xml is still generated — continue to parse results.
      // Only treat as hard error if output.xml was not created.
      if (!existsSync(outputXmlPath)) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
        return JSON.stringify({
          status: "error",
          error: `Robot Framework execution failed (exit code ${exitCode})`,
          stderr: stderr.slice(0, 3000),
          stdout: stdout.slice(0, 3000),
          elapsed: `${elapsed}s`,
          command: cmd,
        })
      }
    }

    // 5. Parse output.xml
    const results = parseOutputXml(outputXmlPath)
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)

    // 6. Determine overall status
    const status = results.failed > 0 ? "failed" : "passed"

    return JSON.stringify({
      status,
      total: results.total,
      passed: results.passed,
      failed: results.failed,
      skipped: results.skipped,
      output_dir: outputDir,
      output_files: {
        log: join(outputDir, "log.html"),
        report: join(outputDir, "report.html"),
        output_xml: outputXmlPath,
      },
      details: results.details,
      elapsed: `${elapsed}s`,
      command: cmd,
    })
  },
})
