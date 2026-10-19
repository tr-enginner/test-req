import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, writeFileSync, mkdirSync } from "fs"
import { join, dirname } from "path"
import { execSync } from "child_process"
import {
  resolveJoernBin,
  resolveJoernScriptPath,
  findMatrixRoot,
} from "./joern-resolve-cli"
import { ensureMatrixDirs } from "../shared/data-store"
import { resolveMatrixWorkspace } from "../shared/workspace-root"

const IS_WINDOWS = process.platform === "win32"

/**
 * singlevar_pattern_detect — Stage 1 of single-variable atomicity detection.
 *
 * P0 SKELETON: This is the initial skeleton wired to a Joern Scala script
 * (`singlevarAtomicityIdentify.scala`). The TypeScript layer:
 *   1. Resolves the CPG path and Scala script
 *   2. Invokes joern --script with required parameters
 *   3. Parses the JSON output the Scala script writes
 *   4. Forwards results to the requested output paths
 *
 * The Scala script (P0 also skeleton — to be filled in subsequent phases)
 * performs:
 *   - Shared variable discovery (global, static, multi-function-accessed)
 *   - Alias normalization (struct fields, fixed array indices, MMIO defines)
 *   - Consecutive local access pair identification (same function default,
 *     cross-function relaxation up to max_call_chain_depth)
 *   - ISR remote access enumeration
 *   - Pattern matching against {RWR, RWW, WRW, WWR, WWW}
 *   - Structural confidence scoring (AQ + OE per skill §3)
 *   - Loop context capture for any access inside a loop
 *
 * Output JSON schema is defined in src/schema/singlevar-atomicity.ts:
 *   - singlevar-pairs.json: ConsecutiveLocalPair[]
 *   - singlevar-candidates.json: SinglevarViolationCandidate[]
 */
export const singlevarPatternDetect: ToolDefinition = tool({
  description:
    "Stage 1 of single-variable atomicity detection: matches 5 access interleaving patterns " +
    "(RWR/RWW/WRW/WWR/WWW) on a single shared variable using Joern dataflow analysis with " +
    "alias normalization and cross-function relaxation. Outputs candidates to be filtered in " +
    "Stage 2 (atomic intent) and verified in Stage 3 (path feasibility).",
  args: {
    cpg_path: tool.schema
      .string()
      .describe("Absolute path to the Joern CPG binary (from singlevar_cpg_get)."),
    project_name: tool.schema
      .string()
      .describe("Project name."),
    task_entries: tool.schema
      .string()
      .describe("JSON array string of task entry function names (e.g., '[\"main\"]')."),
    isr_entries: tool.schema
      .string()
      .describe("JSON array string of ISR entry function names."),
    interrupt_priorities: tool.schema
      .string()
      .optional()
      .describe(
        "Optional JSON object string mapping ISR name -> priority level (lower = higher priority). " +
          "When provided, ISR-to-ISR interleaving candidates are also generated. " +
          "When omitted, only main↔ISR candidates are generated (same-level ISRs assumed non-preemptive).",
      ),
    max_call_chain_depth: tool.schema
      .number()
      .optional()
      .describe("Cross-function relaxation max depth (default 5)."),
    output_path: tool.schema
      .string()
      .describe("Output path for singlevar-candidates.json (recommended: '.matrix/data/singlevar-candidates.json')."),
    pairs_output_path: tool.schema
      .string()
      .optional()
      .describe("Output path for singlevar-pairs.json (recommended: '.matrix/data/singlevar-pairs.json')."),
    md_output_path: tool.schema
      .string()
      .optional()
      .describe("Output path for Markdown summary of candidates."),
  },
  async execute({
    cpg_path,
    project_name,
    task_entries,
    isr_entries,
    interrupt_priorities,
    max_call_chain_depth,
    output_path,
    pairs_output_path,
    md_output_path,
  }) {
    if (!existsSync(cpg_path)) {
      return JSON.stringify({
        status: "error",
        error: `CPG file not found: ${cpg_path}`,
      })
    }

    const matrixRoot =
      findMatrixRoot(cpg_path) ?? resolveMatrixWorkspace(process.cwd()).workspaceDir
    ensureMatrixDirs(matrixRoot)

    // Ensure output dirs exist
    for (const p of [output_path, pairs_output_path, md_output_path].filter(
      (x): x is string => typeof x === "string" && x.length > 0,
    )) {
      const dir = dirname(p)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    }

    // Resolve Joern binary + Scala script
    const joernBin = resolveJoernBin("joern", matrixRoot)
    let scalaScript: string
    try {
      scalaScript = resolveJoernScriptPath("singlevarAtomicityIdentify.scala", matrixRoot)
    } catch (err: any) {
      return JSON.stringify({
        status: "error",
        error: `Scala script not found: ${err.message ?? String(err)}`,
        hint:
          "Ensure singlevarAtomicityIdentify.scala exists under the plugin's joern/ folder " +
          "or the project's joern/ folder.",
      })
    }

    // Build parameter JSON for the Scala script
    const params = {
      cpg_path,
      project_name,
      task_entries: JSON.parse(task_entries) as string[],
      isr_entries: JSON.parse(isr_entries) as string[],
      interrupt_priorities: interrupt_priorities
        ? (JSON.parse(interrupt_priorities) as Record<string, number>)
        : {},
      max_call_chain_depth: max_call_chain_depth ?? 5,
      output_path,
      pairs_output_path: pairs_output_path ?? join(matrixRoot, ".matrix", "data", "singlevar-pairs.json"),
      md_output_path:
        md_output_path ?? join(matrixRoot, ".matrix", "reports", "singlevar-candidates.md"),
    }

    // Write parameter file (Scala script reads JSON from this path)
    const paramsPath = join(matrixRoot, ".matrix", "data", "singlevar-params.json")
    if (!existsSync(dirname(paramsPath))) {
      mkdirSync(dirname(paramsPath), { recursive: true })
    }
    writeFileSync(paramsPath, JSON.stringify(params, null, 2), "utf-8")

    // Invoke Joern with the script
    // joern --script <scala> --param paramsPath=<paramsPath>
    const cmd = `${joernBin} --script "${scalaScript}" --param paramsPath="${paramsPath}"`
    try {
      const stdout = execSync(cmd, {
        stdio: "pipe",
        timeout: 600_000, // 10 minutes
        encoding: "utf-8",
        maxBuffer: 100 * 1024 * 1024,
        ...(IS_WINDOWS && { shell: "cmd.exe" }),
      })

      if (!existsSync(output_path)) {
        return JSON.stringify({
          status: "error",
          error: "Scala script completed but output_path was not written",
          stdout: stdout.slice(0, 4000),
          expected_output: output_path,
        })
      }

      return JSON.stringify({
        status: "success",
        candidates_path: output_path,
        pairs_path: params.pairs_output_path,
        md_path: params.md_output_path,
        params_path: paramsPath,
        message: `Stage 1 complete. Candidates written to ${output_path}`,
      })
    } catch (err: any) {
      return JSON.stringify({
        status: "error",
        error: `Joern script execution failed: ${(err.message || String(err)).slice(0, 500)}`,
        stderr: err.stderr ? String(err.stderr).slice(0, 4000) : "",
        stdout: err.stdout ? String(err.stdout).slice(0, 4000) : "",
        hint:
          "Inspect stderr/stdout above for the actual Joern error. " +
          "Common causes: Joern version mismatch, CPG missing/corrupted, or Scala compilation error.",
      })
    }
  },
})
