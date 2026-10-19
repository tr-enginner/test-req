import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { join, dirname } from "path"
import { findMatrixRoot } from "./joern-resolve-cli"
import { ensureMatrixDirs } from "../shared/data-store"
import { resolveMatrixWorkspace } from "../shared/workspace-root"
import { multivarFeasibilityVerify } from "./multivar-feasibility-verify"

/**
 * singlevar_feasibility_verify — Stage 3 of single-variable atomicity detection.
 *
 * Wraps multivar_feasibility_verify for code reuse. The 3-access singlevar
 * schema is mapped to the 4-access multivar schema with isrA1 == isrA2
 * degenerating to a trivially-reachable point (allowed since PR #98 relaxed
 * the multivar isrAccesses.length check from < 2 to < 1).
 *
 * Flow:
 *   1. Read singlevar-candidates.json (Stage 1/2 output)
 *   2. Transform each SinglevarViolationCandidate → ViolationInput
 *   3. Write bridge input file, invoke multivarFeasibilityVerify.execute()
 *   4. Read multivar VerifiedViolation[] output
 *   5. Merge feasibility + path_analysis back into the original candidates,
 *      producing SinglevarViolation[]
 *   6. Write singlevar-violations.json
 *
 * The two bridge files (.matrix/data/singlevar-z3-{input,output}.json) are
 * preserved on disk — when Z3 verdicts surprise, diffing these against
 * singlevar-candidates.json is the quickest path to root cause.
 */

interface SinglevarCandidate {
  id: string
  pattern: string
  variable_name: string
  canonical_var: string
  accesses: {
    local1: unknown
    remote: unknown
    local2: unknown
  }
  remote_isr: {
    isr_name: string
    priority: number
    access: unknown
  }
  [key: string]: unknown
}

interface VerifiedViolationLite {
  id: string
  feasibility: string
  path_analysis?: unknown
  [key: string]: unknown
}

function feasibilityToSeverity(f: string): "critical" | "major" | "info" {
  switch (f) {
    case "CONFIRMED":
      return "critical"
    case "INFEASIBLE":
      return "info"
    default:
      return "major"
  }
}

function ensureDir(filePath: string): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

export const singlevarFeasibilityVerify: ToolDefinition = tool({
  description:
    "Stage 3 of single-variable atomicity detection: verifies concurrency feasibility " +
    "of Stage 2-filtered candidates by reusing the multi-variable Z3 pipeline. " +
    "Internally adapts the 3-access singlevar schema to the multivar ViolationInput " +
    "shape (the multivar isrAccesses.length check was relaxed in PR #98 to accept " +
    "the degenerate 1-ISR-access case). Returns CONFIRMED / INFEASIBLE / UNKNOWN per candidate. " +
    "Writes singlevar-violations.json to output_path; also persists transient bridge files " +
    ".matrix/data/singlevar-z3-{input,output}.json and .matrix/reports/singlevar-z3-debug.md " +
    "for debugging.",
  args: {
    candidates_path: tool.schema
      .string()
      .describe(
        "Path to singlevar-candidates.json from Stage 1/2 (recommended: '.matrix/data/singlevar-candidates.json').",
      ),
    cpg_path: tool.schema.string().describe("Path to the Joern CPG binary."),
    project_name: tool.schema.string().describe("Project name."),
    output_path: tool.schema
      .string()
      .describe(
        "Output path for singlevar-violations.json (recommended: '.matrix/data/singlevar-violations.json').",
      ),
    md_output_path: tool.schema
      .string()
      .optional()
      .describe(
        "Output path for the underlying multivar Markdown trace " +
          "(recommended: '.matrix/reports/singlevar-z3-debug.md'). Useful for debugging Z3 verdicts.",
      ),
    critical_section_apis: tool.schema
      .string()
      .optional()
      .describe(
        "Optional JSON array of critical-section API function names " +
          "(e.g., '[\"taskENTER_CRITICAL\", \"taskEXIT_CRITICAL\"]'). Forwarded to multivar tool.",
      ),
    interrupt_apis: tool.schema
      .string()
      .optional()
      .describe(
        "Optional JSON array of interrupt enable/disable API names " +
          '(e.g., \'["__disable_irq", "__enable_irq", "EA"]\'). Forwarded to multivar tool.',
      ),
    init_functions: tool.schema
      .string()
      .optional()
      .describe(
        "Optional JSON array of init-phase function names. Candidates whose " +
          "ALL local accesses occur in these functions are marked INFEASIBLE by the multivar tool.",
      ),
  },
  async execute(
    {
      candidates_path,
      cpg_path,
      project_name,
      output_path,
      md_output_path,
      critical_section_apis,
      interrupt_apis,
      init_functions,
    },
    ctx,
  ) {
    // ── Sanity checks ──
    if (!existsSync(candidates_path)) {
      return JSON.stringify({
        status: "error",
        error: `Candidates file not found: ${candidates_path}`,
      })
    }
    if (!existsSync(cpg_path)) {
      return JSON.stringify({
        status: "error",
        error: `CPG file not found: ${cpg_path}`,
      })
    }

    const matrixRoot =
      findMatrixRoot(cpg_path) ?? resolveMatrixWorkspace(process.cwd()).workspaceDir
    ensureMatrixDirs(matrixRoot)

    // ── Step 1: Read singlevar candidates ──
    let candidates: SinglevarCandidate[]
    try {
      const raw = JSON.parse(readFileSync(candidates_path, "utf-8"))
      candidates = Array.isArray(raw) ? raw : ((raw.candidates as SinglevarCandidate[]) ?? [])
    } catch (err: any) {
      return JSON.stringify({
        status: "error",
        error: `Failed to parse candidates JSON (${candidates_path}): ${err.message ?? String(err)}`,
      })
    }

    if (candidates.length === 0) {
      ensureDir(output_path)
      writeFileSync(
        output_path,
        JSON.stringify(
          {
            status: "success",
            project_name,
            violations: [],
            summary: { total: 0, confirmed: 0, infeasible: 0, unknown: 0 },
            message: "No candidates to verify (Stage 1/2 produced empty output)",
          },
          null,
          2,
        ),
        "utf-8",
      )
      return JSON.stringify({
        status: "success",
        violations_path: output_path,
        summary: { total: 0, confirmed: 0, infeasible: 0, unknown: 0 },
        message: "No candidates to verify",
      })
    }

    // ── Step 2: Transform singlevar candidates → multivar ViolationInput[] ──
    const multivarViolations = candidates.map((c) => ({
      id: c.id,
      pattern: c.pattern,
      correlated_group_id: c.canonical_var,
      variables: [c.variable_name],
      main_accesses: [c.accesses.local1, c.accesses.local2],
      interrupt_accesses: [
        {
          isr_name: c.remote_isr.isr_name,
          priority: c.remote_isr.priority,
          access: c.accesses.remote,
        },
      ],
      feasibility: "PENDING",
      severity: "major",
      description: `Single-variable ${c.pattern} on ${c.variable_name}`,
    }))

    // ── Step 3: Write bridge input file ──
    const bridgeInputPath = join(matrixRoot, ".matrix", "data", "singlevar-z3-input.json")
    const bridgeOutputPath = join(matrixRoot, ".matrix", "data", "singlevar-z3-output.json")
    const bridgeMdPath =
      md_output_path ?? join(matrixRoot, ".matrix", "reports", "singlevar-z3-debug.md")

    ensureDir(bridgeInputPath)
    writeFileSync(
      bridgeInputPath,
      JSON.stringify({ violations: multivarViolations }, null, 2),
      "utf-8",
    )

    // ── Step 4: Invoke multivar_feasibility_verify.execute() ──
    // Synthesize a minimal ToolContext when one was not passed in (e.g., when
    // this tool is invoked from a script rather than the opencode runtime).
    const synthCtx = ctx ?? {
      sessionID: "singlevar-internal",
      messageID: "singlevar-internal",
      agent: "singlevar-atomicity-checker",
      directory: matrixRoot,
      worktree: matrixRoot,
      abort: new AbortController().signal,
      metadata() {},
      async ask() {},
    }

    let multivarResultStr: string
    try {
      multivarResultStr = await multivarFeasibilityVerify.execute(
        {
          violations_path: bridgeInputPath,
          cpg_path,
          project_name,
          critical_section_apis,
          interrupt_apis,
          init_functions,
          output_path: bridgeOutputPath,
          md_output_path: bridgeMdPath,
        } as any,
        synthCtx as any,
      )
    } catch (err: any) {
      return JSON.stringify({
        status: "error",
        error: `multivar_feasibility_verify threw: ${err.message ?? String(err)}`,
        bridge_input_path: bridgeInputPath,
      })
    }

    let multivarParsed: any
    try {
      multivarParsed = JSON.parse(multivarResultStr)
    } catch {
      multivarParsed = { status: "error", error: "multivar returned non-JSON" }
    }
    if (multivarParsed.status === "error") {
      return JSON.stringify({
        status: "error",
        error: `multivar_feasibility_verify failed: ${multivarParsed.error}`,
        bridge_input_path: bridgeInputPath,
      })
    }

    // ── Step 5: Read multivar VerifiedViolation[] output ──
    let verifiedList: VerifiedViolationLite[]
    try {
      const raw = JSON.parse(readFileSync(bridgeOutputPath, "utf-8"))
      verifiedList = (raw.violations as VerifiedViolationLite[]) ?? []
    } catch (err: any) {
      return JSON.stringify({
        status: "error",
        error: `Failed to read multivar output (${bridgeOutputPath}): ${err.message ?? String(err)}`,
        bridge_input_path: bridgeInputPath,
      })
    }

    // ── Step 6: Merge feasibility back into singlevar shape ──
    const verifiedById = new Map(verifiedList.map((v) => [v.id, v]))
    const singlevarViolations = candidates.map((c) => {
      const v = verifiedById.get(c.id)
      if (!v) {
        return {
          ...c,
          feasibility: "UNKNOWN",
          severity: "major",
          description: `Single-variable ${c.pattern} on ${c.variable_name}`,
        }
      }
      return {
        ...c,
        feasibility: v.feasibility,
        severity: feasibilityToSeverity(v.feasibility),
        description: `Single-variable ${c.pattern} on ${c.variable_name}`,
        ...(v.path_analysis ? { path_analysis: v.path_analysis } : {}),
      }
    })

    const summary = {
      total: singlevarViolations.length,
      confirmed: singlevarViolations.filter((v) => v.feasibility === "CONFIRMED").length,
      infeasible: singlevarViolations.filter((v) => v.feasibility === "INFEASIBLE").length,
      unknown: singlevarViolations.filter((v) => v.feasibility === "UNKNOWN").length,
    }

    // ── Step 7: Write singlevar-violations.json ──
    ensureDir(output_path)
    writeFileSync(
      output_path,
      JSON.stringify(
        {
          status: "success",
          project_name,
          violations: singlevarViolations,
          summary,
        },
        null,
        2,
      ),
      "utf-8",
    )

    return JSON.stringify({
      status: "success",
      violations_path: output_path,
      bridge_input_path: bridgeInputPath,
      bridge_output_path: bridgeOutputPath,
      bridge_md_path: bridgeMdPath,
      summary,
      message: `Single-var Stage 3: ${summary.total} verified (${summary.confirmed} CONFIRMED, ${summary.unknown} UNKNOWN, ${summary.infeasible} INFEASIBLE)`,
    })
  },
})
