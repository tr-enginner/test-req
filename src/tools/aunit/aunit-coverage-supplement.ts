import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, readFileSync, readdirSync } from "fs"
import { join } from "path"
import { normalizePath, AUNIT_WORKSPACE, normalizeProjectDir, scanGsonPaths } from "./aunit-utils"
import { readGsonFile, decodeGbk } from "./gbk-encoding"

/**
 * aunit_coverage_supplement — Analyze CFG and per-case coverage data for
 * functions below coverage target, returning structured gap analysis for
 * the agent to design supplementary test cases.
 *
 * Reads:
 * - gson files under meta/model/UT/ for coverageMap and existing cases
 * - CFG files under out/.cache/cfg/ for control flow graph data
 * - .cox.json files under meta/data/UT/uniform/.../cidir/ for per-case coverage
 *
 * When include_seed_analysis=true, additionally returns branch_nodes[] for
 * each below-target function — a DFS-ordered list of CFG branch decision points
 * enriched with seed_candidates. Each seed candidate supplies an existing test
 * case (that already reaches the node) plus its covered-branch info, enabling
 * LLM-driven seed mutation: the agent only needs to tweak inputs to flip the
 * branch direction rather than designing cases from scratch.
 *
 * Poll counts (how many times a node has been attempted) are persisted to
 * .matrix/state/coverage-poll-counts.json and read back here so is_unreachable
 * is accurate across multiple tool invocations.
 */
export const aunitCoverageSupplement: ToolDefinition = tool({
  description:
    "Analyze coverage gaps for functions below target coverage. " +
    "Reads CFG (control flow graph) files and per-case .cox.json coverage data " +
    "to identify uncovered branches/paths. Returns structured gap analysis " +
    "for the agent to design supplementary test cases. " +
    "When include_seed_analysis=true, returns branch_nodes[] with seed_candidates " +
    "enabling targeted seed-mutation case generation (patent method). " +
    "Must be called AFTER aunit_run_case completes.",
  args: {
    project_name: tool.schema.string().describe("AUnit project name"),
    project_dir: tool.schema.string().describe("Project root directory"),
    coverage_target: tool.schema
      .string()
      .describe('Target coverage type: "statement" | "branch" | "mc_dc"'),
    target_percentage: tool.schema
      .number()
      .describe("Target coverage percentage (e.g. 80)"),
    function_names: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe(
        "Optional list of specific function names to analyze. If omitted, analyzes all functions below target.",
      ),
    include_seed_analysis: tool.schema
      .boolean()
      .optional()
      .describe(
        "When true, enriches each below-target function with branch_nodes[]: " +
        "a DFS-ordered list of CFG decision nodes, each containing seed_candidates " +
        "that pair an uncovered branch with the best existing test case to mutate. " +
        "Reads poll counts from .matrix/state/coverage-poll-counts.json to mark " +
        "exhausted nodes as is_unreachable. Default: false.",
      ),
    poll_limit: tool.schema
      .number()
      .optional()
      .describe(
        "Maximum number of generation attempts per branch node before it is " +
        "marked is_unreachable. Only used when include_seed_analysis=true. Default: 3.",
      ),
    max_functions: tool.schema
      .number()
      .optional()
      .describe(
        "Maximum number of below-target functions to return detailed analysis for. " +
        "Functions are sorted by coverage gap (worst first). Default: 10.",
      ),
    compact: tool.schema
      .boolean()
      .optional()
      .describe(
        "When true (default), omits cfg.raw, cfg.nodes, cfg.edges from the response " +
        "and trims per_case_coverage to only cases relevant to uncovered branches. " +
        "Set to false for full data.",
      ),
    aunit_path: tool.schema
      .string()
      .optional()
      .describe("AUnit installation path (optional — auto-detected)"),
  },
  async execute({
    project_name,
    project_dir,
    coverage_target,
    target_percentage,
    function_names,
    include_seed_analysis,
    poll_limit,
    max_functions,
    compact,
  }) {
    const projDir = normalizePath(normalizeProjectDir(project_dir))
    const projectPath = join(projDir, AUNIT_WORKSPACE, project_name)
    const utDir = join(projectPath, "meta", "model", "UT")

    if (!existsSync(utDir)) {
      return JSON.stringify({
        status: "error",
        error: `AUnit UT directory not found at ${utDir}. Run aunit_build + aunit_run_case first.`,
      })
    }

    // 1. Discover all gson files and extract coverage + case info
    const gsonFiles = findAllGsonFilesWithCoverage(utDir)
    if (gsonFiles.length === 0) {
      return JSON.stringify({
        status: "error",
        error: `No function-level gson files found under ${utDir}.`,
      })
    }

    // 2. Filter to requested functions (if specified)
    const targetFunctions = function_names
      ? gsonFiles.filter((g) => function_names.includes(g.funcName))
      : gsonFiles

    const isCompact = compact !== false // default true

    // 3. Compute coverage percentages and filter to below-target
    // First pass: identify all below-target functions and their coverage gaps
    const belowTargetCandidates: { gf: GsonFunctionInfo; gap: number; percentages: { line: number | null; branch: number | null; mcdc: number | null } }[] = []
    const aboveTargetRequested: typeof belowTargetCandidates = [] // for explicitly requested functions that are above target
    let totalAnalyzed = 0

    for (const gf of targetFunctions) {
      totalAnalyzed++
      const cov = gf.coverage
      const percentages = {
        line: computePercentage(cov.line),
        branch: computePercentage(cov.branch),
        mcdc: computePercentage(cov.mcdc),
      }

      const belowTarget =
        (percentages.line !== null && percentages.line < target_percentage) ||
        (percentages.branch !== null && percentages.branch < target_percentage) ||
        (percentages.mcdc !== null && percentages.mcdc < target_percentage)

      if (belowTarget) {
        // Compute gap = how far below target (worst of all coverage types)
        const gaps: number[] = []
        if (percentages.line !== null && percentages.line < target_percentage)
          gaps.push(target_percentage - percentages.line)
        if (percentages.branch !== null && percentages.branch < target_percentage)
          gaps.push(target_percentage - percentages.branch)
        if (percentages.mcdc !== null && percentages.mcdc < target_percentage)
          gaps.push(target_percentage - percentages.mcdc)
        belowTargetCandidates.push({ gf, gap: Math.max(...gaps), percentages })
      } else if (function_names) {
        // Explicitly requested but above target — include without heavy analysis
        aboveTargetRequested.push({ gf, gap: 0, percentages })
      }
    }

    // Sort by coverage gap descending (worst first)
    belowTargetCandidates.sort((a, b) => b.gap - a.gap)

    // Apply max_functions limit
    const effectiveMax = max_functions ?? 10
    const truncated = !function_names && belowTargetCandidates.length > effectiveMax
    const selectedBelow = truncated
      ? belowTargetCandidates.slice(0, effectiveMax)
      : belowTargetCandidates

    // 4-6. Build detailed analysis only for selected functions
    const analysis: FunctionAnalysis[] = []

    for (const { gf, percentages } of [...selectedBelow, ...aboveTargetRequested]) {
      const cov = gf.coverage
      const belowTarget = selectedBelow.some(s => s.gf === gf)

      const cfg = readCfgFile(projectPath, gf.funcName)
      const perCaseCov = readPerCaseCoverage(projectPath, gf.funcName)
      const uncoveredBranches = computeUncoveredBranches(cfg, perCaseCov)

      // Compact mode: trim CFG and per-case coverage data
      let compactCfg = cfg
      let compactPerCaseCov = perCaseCov
      if (isCompact && cfg) {
        compactCfg = {
          source: cfg.source,
          decisions: cfg.decisions,
          // Omit nodes, edges, raw in compact mode
        }
        if (cfg.source === "raw" && cfg.raw) {
          // Keep raw but truncated to 5000 chars
          compactCfg.raw = cfg.raw.length > 5000
            ? cfg.raw.substring(0, 5000) + "\n... [truncated]"
            : cfg.raw
        }
      }

      if (isCompact && perCaseCov.length > 0 && uncoveredBranches.length > 0) {
        // In compact mode, only keep per-case coverage data for cases that might
        // be relevant to uncovered branches (limit to 20 entries)
        compactPerCaseCov = perCaseCov.slice(0, 20)
      }

      analysis.push({
        function_name: gf.funcName,
        gson_path: gf.gsonPath,
        current_coverage: {
          line: cov.line.raw,
          branch: cov.branch.raw,
          mcdc: cov.mcdc.raw,
        },
        coverage_percentages: percentages,
        below_target: belowTarget,
        total_cases: gf.totalCases,
        cfg: compactCfg,
        uncovered_branches: uncoveredBranches,
        per_case_coverage: compactPerCaseCov,
      })
    }

    // 7. Seed analysis enrichment (patent method)
    if (include_seed_analysis) {
      const pollCounts = loadPollCounts(projDir)
      const effectivePollLimit = poll_limit ?? 3

      for (const fa of analysis) {
        const gsonCases = readGsonCases(fa.gson_path)
        fa.branch_nodes = buildBranchNodes(
          fa.cfg,
          fa.per_case_coverage,
          gsonCases,
          pollCounts,
          effectivePollLimit,
          fa.function_name,
        )
      }
    }

    const belowCount = belowTargetCandidates.length

    return JSON.stringify({
      status: "success",
      coverage_target,
      target_percentage,
      functions_analyzed: totalAnalyzed,
      functions_below_target: belowCount,
      functions_returned: analysis.filter(a => a.below_target).length,
      ...(truncated ? {
        functions_omitted: belowCount - effectiveMax,
        truncation_note: `Showing top ${effectiveMax} functions by coverage gap. ${belowCount - effectiveMax} more below-target functions not shown. Use max_functions or function_names to see more.`,
      } : {}),
      analysis,
      compact_mode: isCompact,
      seed_analysis_enabled: include_seed_analysis === true,
      poll_counts_file: include_seed_analysis
        ? join(projDir, POLL_COUNTS_FILE)
        : undefined,
      message:
        `Analyzed ${totalAnalyzed} functions. ` +
        `${belowCount} below ${target_percentage}% ${coverage_target} coverage` +
        (truncated ? ` (showing top ${effectiveMax})` : '') + `. ` +
        (belowCount > 0
          ? include_seed_analysis
            ? `Use branch_nodes[].seed_candidates for targeted seed-mutation case generation.`
            : `Use the CFG and uncovered_branches data to design supplementary test cases.`
          : `All functions meet the coverage target.`),
    })
  },
})

// ─── Poll count state ────────────────────────────────────────────────────────

/** Path (relative to project_dir) for poll count persistence */
const POLL_COUNTS_FILE = ".matrix/state/coverage-poll-counts.json"

interface PollCounts {
  [funcName: string]: {
    [nodeId: string]: number
  }
}

/** Load poll counts from disk; returns empty object if file absent or unreadable */
function loadPollCounts(projDir: string): PollCounts {
  const filePath = join(projDir, POLL_COUNTS_FILE)
  if (!existsSync(filePath)) return {}
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as PollCounts
  } catch {
    return {}
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface CoverageField {
  raw: string // e.g. "6/8"
  covered: number
  total: number
}

interface GsonFunctionInfo {
  funcName: string
  gsonPath: string
  totalCases: number
  coverage: {
    line: CoverageField
    branch: CoverageField
    mcdc: CoverageField
  }
}

interface CfgData {
  source: "json" | "raw"
  nodes?: any[]
  edges?: any[]
  decisions?: any[]
  raw?: string
}

interface PerCaseCoverage {
  case_id: string
  file_name: string
  data: any
}

interface UncoveredBranch {
  description: string
  source: string
}

/** A single seed candidate: pairs an uncovered branch with an existing case to mutate */
interface SeedCandidate {
  /** The branch direction this candidate aims to cover: "true" | "false" */
  target_branch: string
  /** Case ID of the seed (from gson caseId, 1-indexed string) */
  seed_case_id: string
  /**
   * Which branch the seed case took at this node.
   * "true" | "false" when determinable from .cox.json; "unknown" means the
   * agent must infer from code logic.
   */
  seed_covered_branch: string
  /** Input parameters from the seed case's paraExprs */
  seed_params: Array<{ expr: string; in: string }>
  /** Expected return value from the seed case */
  seed_ret_value: string
  /** Test case description from the seed case */
  seed_desc: string
}

/**
 * A CFG decision (branch) node, DFS-ordered, enriched with coverage status
 * and seed candidates for the uncovered branches.
 */
interface BranchNode {
  /** Stable identifier: e.g. "s_a_gt_0_line_6" */
  node_id: string
  /** Source line of the branch condition */
  line: number
  /** Human-readable condition expression: e.g. "s->a > 0" */
  condition: string
  /** Whether the true branch has been covered by any existing case */
  true_branch_covered: boolean
  /** Whether the false branch has been covered by any existing case */
  false_branch_covered: boolean
  /** true iff both branches are covered */
  fully_covered: boolean
  /**
   * One entry per uncovered branch (at most 2: one for true, one for false).
   * Empty when fully_covered=true or is_unreachable=true.
   */
  seed_candidates: SeedCandidate[]
  /** How many generation attempts have been made for this node (from state file) */
  poll_count: number
  /** Maximum allowed attempts (from poll_limit param) */
  poll_limit: number
  /**
   * True when poll_count >= poll_limit — this node is treated as having an
   * infeasible/unreachable branch and should be skipped.
   */
  is_unreachable: boolean
}

interface FunctionAnalysis {
  function_name: string
  gson_path: string
  current_coverage: { line: string; branch: string; mcdc: string }
  coverage_percentages: { line: number | null; branch: number | null; mcdc: number | null }
  below_target: boolean
  total_cases: number
  cfg: CfgData | null
  uncovered_branches: UncoveredBranch[]
  per_case_coverage: PerCaseCoverage[]
  /**
   * Present only when include_seed_analysis=true.
   * DFS-ordered list of CFG decision nodes for this function.
   * Empty array if CFG data is unavailable or yields no parseable branch nodes.
   */
  branch_nodes?: BranchNode[]
}

// ─── Branch node construction ────────────────────────────────────────────────

interface RawBranchPoint {
  line: number
  condition: string
  condition_short: string
}

/**
 * Build the branch_nodes array for a function by correlating:
 * 1. CFG data → branch point locations + conditions
 * 2. Per-case .cox.json → which branches each case covered
 * 3. Gson cases → seed candidate parameters
 * 4. Poll counts → attempt tracking
 */
function buildBranchNodes(
  cfg: CfgData | null,
  perCaseCov: PerCaseCoverage[],
  gsonCases: any[],
  pollCounts: PollCounts,
  pollLimit: number,
  funcName: string,
): BranchNode[] {
  const rawPoints = extractBranchPointsFromCfg(cfg)
  if (rawPoints.length === 0) return []

  const funcPolls = pollCounts[funcName] ?? {}
  const nodes: BranchNode[] = []

  for (const bp of rawPoints) {
    const nodeId = `${bp.condition_short}_line_${bp.line}`

    const { trueCovered, falseCovered, trueCaseIds, falseCaseIds } =
      computePerBranchCoverage(bp.line, perCaseCov)

    const fullyCovered = trueCovered && falseCovered
    const pollCount = funcPolls[nodeId] ?? 0
    const isUnreachable = pollCount >= pollLimit

    const seeds: SeedCandidate[] = []

    if (!fullyCovered && !isUnreachable) {
      if (!trueCovered) {
        const s = selectBestSeedCandidate("true", falseCaseIds, gsonCases)
        if (s) seeds.push(s)
      }
      if (!falseCovered) {
        const s = selectBestSeedCandidate("false", trueCaseIds, gsonCases)
        if (s) seeds.push(s)
      }
    }

    nodes.push({
      node_id: nodeId,
      line: bp.line,
      condition: bp.condition,
      true_branch_covered: trueCovered,
      false_branch_covered: falseCovered,
      fully_covered: fullyCovered,
      seed_candidates: seeds,
      poll_count: pollCount,
      poll_limit: pollLimit,
      is_unreachable: isUnreachable,
    })
  }

  return nodes
}

/**
 * Extract branch decision points from CFG data.
 * Tries multiple JSON formats, then falls back to regex on raw text.
 * Returns deduplicated points ordered by line number (DFS approximation).
 */
function extractBranchPointsFromCfg(cfg: CfgData | null): RawBranchPoint[] {
  if (!cfg) return []

  const points: RawBranchPoint[] = []

  if (cfg.source === "json") {
    // Format A: decisions[] array — most common in Java coverage tools
    if (Array.isArray(cfg.decisions) && cfg.decisions.length > 0) {
      for (const d of cfg.decisions) {
        const line = d.line ?? d.lineNumber ?? d.startLine ?? 0
        const condition =
          d.condition ?? d.expression ?? d.text ?? d.label ?? d.description
        if (typeof condition === "string" && condition) {
          points.push({
            line: Number(line) || 0,
            condition,
            condition_short: makeNodeIdSafe(condition),
          })
        }
      }
    }

    // Format B: nodes[] with typed branch/decision entries
    if (points.length === 0 && Array.isArray(cfg.nodes) && cfg.nodes.length > 0) {
      for (const n of cfg.nodes) {
        const isBranchNode =
          n.type === "branch" ||
          n.type === "decision" ||
          n.type === "condition" ||
          n.isBranch === true ||
          n.isDecision === true
        if (!isBranchNode) continue

        const line = n.line ?? n.lineNumber ?? n.startLine ?? 0
        const condition = n.condition ?? n.label ?? n.expression ?? n.text ?? `node_${n.id ?? line}`
        points.push({
          line: Number(line) || 0,
          condition: String(condition),
          condition_short: makeNodeIdSafe(String(condition)),
        })
      }
    }

    // Format C: edges[] contain branch condition metadata
    if (points.length === 0 && Array.isArray(cfg.edges) && cfg.edges.length > 0) {
      const seen = new Set<string>()
      for (const e of cfg.edges) {
        const line = e.sourceLine ?? e.line ?? e.fromLine ?? 0
        const condition = e.condition ?? e.label ?? e.guard
        if (condition && typeof condition === "string" && !seen.has(`${line}_${condition}`)) {
          seen.add(`${line}_${condition}`)
          points.push({
            line: Number(line) || 0,
            condition,
            condition_short: makeNodeIdSafe(condition),
          })
        }
      }
    }
  }

  // Format D: raw CFG text — parse common textual patterns
  if (points.length === 0 && cfg.source === "raw" && cfg.raw) {
    const patterns = [
      /line\s*[=:]?\s*(\d+)[,\s]+(?:condition|cond|expr)[:\s]+([^\n;,]+)/gi,
      /(\d+):\s*if\s*\(([^)]+)\)/g,
      /branch[^:]*:\s*line\s*(\d+)[,\s]+([^\n]+)/gi,
      /\[(\d+)\]\s*(?:if|while|for)\s*\(([^)]+)\)/g,
    ]
    for (const pattern of patterns) {
      let match: RegExpExecArray | null
      while ((match = pattern.exec(cfg.raw)) !== null) {
        const line = parseInt(match[1], 10)
        const condition = match[2].trim()
        if (!isNaN(line) && condition) {
          points.push({ line, condition, condition_short: makeNodeIdSafe(condition) })
        }
      }
      if (points.length > 0) break
    }
  }

  // Deduplicate by line, sort ascending (DFS approximation for sequential code)
  const seen = new Set<number>()
  return points
    .filter((p) => {
      if (seen.has(p.line)) return false
      seen.add(p.line)
      return true
    })
    .sort((a, b) => a.line - b.line)
}

/** Convert a condition expression to a short ASCII-safe node ID fragment */
function makeNodeIdSafe(s: string): string {
  return s
    .replace(/->|>=|<=|!=|==|&&|\|\|/g, "_")
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .substring(0, 24)
    .toLowerCase() || "cond"
}

// ─── Per-case branch coverage ────────────────────────────────────────────────

interface BranchCoverageResult {
  trueCovered: boolean
  falseCovered: boolean
  trueCaseIds: string[]
  falseCaseIds: string[]
}

/**
 * For a given CFG branch node (identified by its source line), determine
 * which existing test cases covered the true branch and which covered false.
 *
 * Tries multiple .cox.json field naming conventions; falls back to marking
 * both coverage flags as false (unknown) when the format is unrecognized.
 */
function computePerBranchCoverage(
  targetLine: number,
  perCaseCov: PerCaseCoverage[],
): BranchCoverageResult {
  let trueCovered = false
  let falseCovered = false
  const trueCaseIds: string[] = []
  const falseCaseIds: string[] = []

  for (const caseCov of perCaseCov) {
    const data = caseCov.data
    if (!data) continue

    const trueHit = getBranchHit(data, targetLine, true)
    const falseHit = getBranchHit(data, targetLine, false)

    if (trueHit === true) {
      trueCovered = true
      trueCaseIds.push(caseCov.case_id)
    }
    if (falseHit === true) {
      falseCovered = true
      falseCaseIds.push(caseCov.case_id)
    }
  }

  return { trueCovered, falseCovered, trueCaseIds, falseCaseIds }
}

/**
 * Attempt to read whether a test case's .cox.json data records a hit on the
 * true or false outcome of the branch at `targetLine`.
 *
 * Returns true (covered), false (not covered), or null (format unrecognized).
 */
function getBranchHit(data: any, targetLine: number, wantTrue: boolean): boolean | null {
  const branchIdx = wantTrue ? 0 : 1

  // Format 1: branchHits array — [{line, branchIndex, covered}]
  if (Array.isArray(data.branchHits)) {
    for (const h of data.branchHits) {
      const l = h.line ?? h.lineNumber ?? -1
      if (l !== targetLine) continue
      const isTrue =
        h.branchIndex === 0 ||
        h.outcome === "true" ||
        h.outcome === "T" ||
        h.label === "true" ||
        h.taken === true
      const isFalse =
        h.branchIndex === 1 ||
        h.outcome === "false" ||
        h.outcome === "F" ||
        h.label === "false" ||
        h.taken === false
      if (wantTrue && isTrue) return h.covered === true || (h.count ?? h.hits ?? 0) > 0
      if (!wantTrue && isFalse) return h.covered === true || (h.count ?? h.hits ?? 0) > 0
    }
  }

  // Format 2: conditions array — [{line, trueHit, falseHit}]
  if (Array.isArray(data.conditions)) {
    for (const c of data.conditions) {
      const l = c.line ?? c.lineNumber ?? -1
      if (l !== targetLine) continue
      if (wantTrue) return (c.trueHit ?? c.trueBranch ?? c.trueCount ?? 0) > 0
      return (c.falseHit ?? c.falseBranch ?? c.falseCount ?? 0) > 0
    }
  }

  // Format 3: branchCoverage map — {"6_0": true, "6_1": false}
  if (data.branchCoverage && typeof data.branchCoverage === "object") {
    const key = `${targetLine}_${branchIdx}`
    if (key in data.branchCoverage) return Boolean(data.branchCoverage[key])
  }

  // Format 4: decisions array with outcomes — [{line, outcomes: [{label, covered}]}]
  if (Array.isArray(data.decisions)) {
    for (const dec of data.decisions) {
      const l = dec.line ?? dec.lineNumber ?? -1
      if (l !== targetLine) continue
      const outcomes: any[] = dec.outcomes ?? dec.branches ?? []
      for (const o of outcomes) {
        const isTrue =
          o.label === "true" || o.outcome === "T" || o.index === 0 || o.branchIndex === 0
        const isFalse =
          o.label === "false" || o.outcome === "F" || o.index === 1 || o.branchIndex === 1
        if (wantTrue && isTrue)
          return o.covered === true || (o.count ?? o.hits ?? 0) > 0
        if (!wantTrue && isFalse)
          return o.covered === true || (o.count ?? o.hits ?? 0) > 0
      }
    }
  }

  // Format 5: lineBranches map — {"6": [true, false]} (index 0=true, 1=false)
  if (data.lineBranches && typeof data.lineBranches === "object") {
    const entry = data.lineBranches[String(targetLine)]
    if (Array.isArray(entry) && entry.length > branchIdx) {
      return Boolean(entry[branchIdx])
    }
  }

  return null // Format unrecognized
}

// ─── Seed candidate selection ────────────────────────────────────────────────

/**
 * Find the best seed case for covering `targetBranch` of a CFG node.
 *
 * Strategy:
 * 1. Prefer cases from `oppositeBranchCaseIds` — those that reached the node
 *    and took the opposite branch. Mutating their inputs to flip the condition
 *    is the minimal change needed.
 * 2. Fall back to the first available gson case if no opposite-branch cases are
 *    known (happens when .cox.json format is unrecognized).
 *
 * Returns null if no cases exist at all.
 */
function selectBestSeedCandidate(
  targetBranch: string,
  oppositeBranchCaseIds: string[],
  gsonCases: any[],
): SeedCandidate | null {
  if (gsonCases.length === 0) return null

  let seedCaseId: string
  let seedCoveredBranch: string

  if (oppositeBranchCaseIds.length > 0) {
    // Best: a case that definitely reached this node via the opposite branch
    seedCaseId = oppositeBranchCaseIds[0]
    seedCoveredBranch = targetBranch === "true" ? "false" : "true"
  } else {
    // Fallback: first available case; agent must reason about reachability
    const firstCase = gsonCases[0]
    seedCaseId = String(firstCase.caseId ?? "1")
    seedCoveredBranch = "unknown"
  }

  // Look up the case in gson by caseId (1-indexed) or array position
  const numId = parseInt(seedCaseId, 10)
  const gsonCase =
    gsonCases.find((c: any) => String(c.caseId) === seedCaseId) ??
    gsonCases[Number.isNaN(numId) ? 0 : numId - 1] ??
    gsonCases[0]

  if (!gsonCase) return null

  const params: Array<{ expr: string; in: string }> = Array.isArray(gsonCase.paraExprs)
    ? gsonCase.paraExprs.map((p: any) => ({
        expr: String(p.expr ?? ""),
        in: String(p.in ?? ""),
      }))
    : []

  return {
    target_branch: targetBranch,
    seed_case_id: String(gsonCase.caseId ?? seedCaseId),
    seed_covered_branch: seedCoveredBranch,
    seed_params: params,
    seed_ret_value: String(gsonCase.retValue ?? ""),
    seed_desc: String(gsonCase.desc ?? ""),
  }
}

// ─── Gson case reader ────────────────────────────────────────────────────────

/** Read the cases array from a gson file (returns [] on any error) */
function readGsonCases(gsonPath: string): any[] {
  try {
    const gson = readGsonFile(gsonPath)
    return Array.isArray(gson.cases) ? gson.cases : []
  } catch {
    return []
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Parse "6/8" format into structured coverage field */
function parseCoverageField(field: string | undefined): CoverageField {
  if (!field || typeof field !== "string") {
    return { raw: "0/0", covered: 0, total: 0 }
  }
  const parts = field.split("/")
  if (parts.length === 2) {
    const covered = parseInt(parts[0], 10)
    const total = parseInt(parts[1], 10)
    if (!isNaN(covered) && !isNaN(total)) {
      return { raw: field, covered, total }
    }
  }
  return { raw: field, covered: 0, total: 0 }
}

/** Compute percentage from coverage field, returns null if total is 0 */
function computePercentage(cov: CoverageField): number | null {
  if (cov.total === 0) return null
  return Math.round((cov.covered / cov.total) * 10000) / 100
}

/** Find all gson files and extract coverage data. Uses scanGsonPaths for directory traversal. */
function findAllGsonFilesWithCoverage(dir: string): GsonFunctionInfo[] {
  const results: GsonFunctionInfo[] = []
  const paths = scanGsonPaths(dir)

  for (const fullPath of paths) {
    try {
      const gson = readGsonFile(fullPath)
      const funcName = gson.entry?.funcName
      if (!funcName) continue

      // Aggregate coverage across all entries in coverageMap
      const lineCov = { covered: 0, total: 0 }
      const branchCov = { covered: 0, total: 0 }
      const mcdcCov = { covered: 0, total: 0 }

      if (gson.coverageMap) {
        for (const [, cov] of Object.entries(
          gson.coverageMap as Record<string, any>,
        )) {
          accumulateCoverage((cov as any).lineCov, lineCov)
          accumulateCoverage((cov as any).branchCov, branchCov)
          accumulateCoverage((cov as any).mcdcCov, mcdcCov)
        }
      }

      results.push({
        funcName,
        gsonPath: fullPath,
        totalCases: Array.isArray(gson.cases) ? gson.cases.length : 0,
        coverage: {
          line: {
            raw: `${lineCov.covered}/${lineCov.total}`,
            covered: lineCov.covered,
            total: lineCov.total,
          },
          branch: {
            raw: `${branchCov.covered}/${branchCov.total}`,
            covered: branchCov.covered,
            total: branchCov.total,
          },
          mcdc: {
            raw: `${mcdcCov.covered}/${mcdcCov.total}`,
            covered: mcdcCov.covered,
            total: mcdcCov.total,
          },
        },
      })
    } catch {
      // skip unparseable gson files
    }
  }
  return results
}

/** Accumulate "6/8" style coverage into an accumulator */
function accumulateCoverage(
  field: string | undefined,
  acc: { covered: number; total: number },
): void {
  if (!field || typeof field !== "string") return
  const parts = field.split("/")
  if (parts.length === 2) {
    const covered = parseInt(parts[0], 10)
    const total = parseInt(parts[1], 10)
    if (!isNaN(covered) && !isNaN(total)) {
      acc.covered += covered
      acc.total += total
    }
  }
}

/**
 * Read CFG file for a function from out/.cache/cfg/
 *
 * CFG file format is unknown at design time. The tool attempts:
 * 1. JSON parse — extract nodes/edges/decisions if present
 * 2. Fall back to raw text content for agent interpretation
 *
 * Files may be GBK-encoded (generated by the same Java tool).
 */
function readCfgFile(projectPath: string, funcName: string): CfgData | null {
  const cfgDir = join(projectPath, "out", ".cache", "cfg")
  if (!existsSync(cfgDir)) return null

  // Try common naming patterns
  const candidates = [
    `${funcName}.cfg`,
    `${funcName}.json`,
    `${funcName}.cfg.json`,
  ]

  // Also scan the directory for files containing the function name
  let cfgFilePath: string | null = null

  for (const candidate of candidates) {
    const path = join(cfgDir, candidate)
    if (existsSync(path)) {
      cfgFilePath = path
      break
    }
  }

  // If exact match not found, scan directory for files containing funcName
  if (!cfgFilePath) {
    cfgFilePath = findFileContainingName(cfgDir, funcName)
  }

  if (!cfgFilePath) return null

  try {
    const buffer = readFileSync(cfgFilePath)
    // Try GBK decode first (AUnit Java tool default on Chinese Windows)
    let text: string
    try {
      text = decodeGbk(buffer)
    } catch {
      text = buffer.toString("utf-8")
    }

    // Try JSON parse
    try {
      const data = JSON.parse(text)
      return {
        source: "json",
        nodes: data.nodes || data.basicBlocks || data.blocks || undefined,
        edges: data.edges || data.transitions || data.arcs || undefined,
        decisions:
          data.decisions ||
          data.branches ||
          data.conditions ||
          data.decisionPoints ||
          undefined,
        raw: text.length > 20000 ? undefined : text,
      }
    } catch {
      // Not JSON — return raw content (truncated if very large)
      return {
        source: "raw",
        raw: text.length > 20000 ? text.substring(0, 20000) + "\n... [truncated]" : text,
      }
    }
  } catch {
    return null
  }
}

/**
 * Read per-case coverage (.cox.json) files for a function.
 *
 * Path pattern: meta/data/UT/uniform/<subdir>/<funcName>/cidir/<funcName>_#_<caseNum>.cox.json
 * The <subdir> varies per source file, so we must recursively scan.
 *
 * Files may be GBK-encoded.
 */
function readPerCaseCoverage(
  projectPath: string,
  funcName: string,
): PerCaseCoverage[] {
  const results: PerCaseCoverage[] = []
  const uniformDir = join(projectPath, "meta", "data", "UT", "uniform")
  if (!existsSync(uniformDir)) return results

  // Recursively find the cidir directory for this function
  const cidir = findCidirForFunction(uniformDir, funcName)
  if (!cidir) return results

  try {
    const entries = readdirSync(cidir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (!entry.name.endsWith(".cox.json")) continue
      // Match pattern: funcName_#_N.cox.json
      if (!entry.name.startsWith(funcName)) continue

      const filePath = join(cidir, entry.name)
      try {
        const buffer = readFileSync(filePath)
        let text: string
        try {
          text = decodeGbk(buffer)
        } catch {
          text = buffer.toString("utf-8")
        }

        const data = JSON.parse(text)

        // Extract case ID from filename: funcName_#_3.cox.json → "3"
        const match = entry.name.match(/_#_(\d+)\.cox\.json$/)
        const caseId = match ? match[1] : entry.name

        results.push({
          case_id: caseId,
          file_name: entry.name,
          data,
        })
      } catch {
        // skip unparseable coverage files
      }
    }
  } catch {
    // directory read error
  }

  return results
}

/** Recursively find cidir directory for a function under uniform/ */
function findCidirForFunction(dir: string, funcName: string): string | null {
  if (!existsSync(dir)) return null

  try {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const fullPath = join(dir, entry.name)

      if (entry.name === funcName) {
        // Found the function directory, look for cidir inside
        const cidir = join(fullPath, "cidir")
        if (existsSync(cidir)) return cidir
      }

      // Recurse into subdirectories
      const found = findCidirForFunction(fullPath, funcName)
      if (found) return found
    }
  } catch {
    // ignore unreadable directories
  }

  return null
}

/** Find a file in a directory whose name contains the given function name */
function findFileContainingName(dir: string, funcName: string): string | null {
  if (!existsSync(dir)) return null

  try {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isFile() && entry.name.includes(funcName)) {
        return join(dir, entry.name)
      }
      if (entry.isDirectory()) {
        const found = findFileContainingName(join(dir, entry.name), funcName)
        if (found) return found
      }
    }
  } catch {
    // ignore
  }
  return null
}

/**
 * Compute uncovered branches by combining CFG data with per-case coverage.
 *
 * Since CFG and .cox.json formats are unknown at design time, this function
 * attempts best-effort extraction. The agent will interpret the raw data
 * if structured extraction fails.
 */
function computeUncoveredBranches(
  cfg: CfgData | null,
  perCaseCov: PerCaseCoverage[],
): UncoveredBranch[] {
  const uncovered: UncoveredBranch[] = []

  // If we have structured CFG data with decisions
  if (cfg?.source === "json" && cfg.decisions && Array.isArray(cfg.decisions)) {
    for (const decision of cfg.decisions) {
      // Try to identify uncovered branches from the decision structure
      const branches = decision.branches || decision.outcomes || []
      for (const branch of branches) {
        const isCovered = branch.covered === true || branch.hit_count > 0
        if (!isCovered) {
          uncovered.push({
            description:
              branch.condition ||
              branch.label ||
              `Decision at line ${decision.line || "?"}`,
            source: "cfg",
          })
        }
      }
    }
  }

  // If we have per-case coverage data, try to extract uncovered info
  if (perCaseCov.length > 0) {
    // Collect all covered lines/branches across all cases
    const coveredLines = new Set<number>()
    const coveredBranches = new Set<string>()

    for (const caseCov of perCaseCov) {
      const data = caseCov.data
      if (!data) continue

      // Try common coverage data structures
      if (Array.isArray(data.coveredLines || data.lines)) {
        for (const line of data.coveredLines || data.lines) {
          coveredLines.add(typeof line === "number" ? line : parseInt(line, 10))
        }
      }

      if (Array.isArray(data.coveredBranches || data.branches)) {
        for (const b of data.coveredBranches || data.branches) {
          coveredBranches.add(typeof b === "string" ? b : JSON.stringify(b))
        }
      }

      // If coverage data has uncovered info directly
      if (Array.isArray(data.uncoveredBranches)) {
        for (const ub of data.uncoveredBranches) {
          uncovered.push({
            description: typeof ub === "string" ? ub : JSON.stringify(ub),
            source: "cox",
          })
        }
      }
    }
  }

  return uncovered
}
