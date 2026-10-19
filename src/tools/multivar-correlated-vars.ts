import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "fs"
import { join, dirname } from "path"
import { execSync } from "child_process"
import { tmpdir } from "os"
import { resolveJoernBin, resolveJoernScriptPath, findMatrixRoot, normalizeVariableName as sharedNormalize } from "./joern-resolve-cli"

const IS_WINDOWS = process.platform === "win32"

// ── Inline types (matches schema/atomicity.ts) ──

interface SourceLoc {
  file_path: string
  line: number
  column: number
  function: string
  code: string
}

interface VarAccess {
  variable_name: string
  access_type: "READ" | "WRITE"
  location: SourceLoc
  entry_function: string
  expression: string
  role: "DECISION" | "ACTION" | "SINK_OPERAND" | "TRANSACTIONAL" | "UNKNOWN"
}

interface CVGroup {
  id: string
  variables: string[]
  anchor_type: "DFC" | "TUP" | "DAC"
  accesses: VarAccess[]
  evidence: Record<string, number>
  confidence: number
  anchor_location?: SourceLoc
  anchor_id?: string
  struct_base?: string
  domain_category: string
  multi_site_count?: number // 同一变量集合在不同代码位置的出现次数
}

interface JoernStatsData {
  global_var: number
  shared_var: number
  saa: number
  dfc_tup: number
  sink: number
  update: number
  dac: number
  pairs: number
  dfc_tup_pairs: number
  sink_pairs: number
  update_pairs: number
  dac_pairs: number
}

// ── Constants ──

const FLAG_PATTERN =
  /(flag|status|state|ready|valid|done|busy|enable|disable|active|pending|lock|mode|phase)/i
const DATA_PATTERN =
  /(data|buf|buffer|val|value|result|output|payload|msg|message|packet|frame|sample|reading)/i

// ── Helper functions ──

function extractStructBase(varName: string): string | undefined {
  for (const sep of [".", "->"]) {
    if (varName.includes(sep)) return varName.split(sep)[0]
  }
  if (varName.includes("[")) return varName.split("[")[0]
  return undefined
}

function extractCommonStructBase(accesses: VarAccess[]): string | undefined {
  const bases = new Set<string>()
  for (const a of accesses) {
    const b = extractStructBase(a.variable_name)
    if (b) bases.add(b)
  }
  return bases.size === 1 ? [...bases][0] : undefined
}

function isArrayElementGroup(accesses: VarAccess[]): boolean {
  const bases = new Set<string>()
  let hasIndex = false
  for (const a of accesses) {
    if (a.variable_name.includes("[")) {
      hasIndex = true
      bases.add(a.variable_name.split("[")[0])
    }
  }
  return hasIndex && bases.size === 1
}

// ── Joern output parsing ──

function parseJoernStats(raw: any): JoernStatsData {
  const s = raw?.Stats ?? {}
  return {
    global_var: s.globalVar ?? 0,
    shared_var: s.sharedVar ?? 0,
    saa: s.saa ?? 0,
    dfc_tup: s.svc ?? 0,
    sink: s.sink ?? 0,
    update: s.update ?? 0,
    dac: s.dac ?? 0,
    pairs: s.pairs ?? 0,
    dfc_tup_pairs: s.svc_pairs ?? 0,
    sink_pairs: s.sink_pairs ?? 0,
    update_pairs: s.update_pairs ?? 0,
    dac_pairs: s.dac_pairs ?? 0,
  }
}

function inferAnchorType(
  accesses: VarAccess[],
): "DFC" | "TUP" | "DAC" {
  const readVars = new Set<string>()
  const writeVars = new Set<string>()
  for (const a of accesses) {
    if (a.access_type === "WRITE") writeVars.add(a.variable_name)
    else readVars.add(a.variable_name)
  }
  // All writes, no reads → check for transactional patterns
  if (writeVars.size > 0 && readVars.size === 0) {
    // Check 1: Same struct/array base
    const bases = new Set<string>()
    for (const v of writeVars) {
      const b = extractStructBase(v)
      if (b) bases.add(b)
    }
    if (bases.size === 1) return "TUP"

    // Check 2: Same array, different elements (e.g., snd_sig[2], snd_sig[4])
    const writeAccesses = accesses.filter((a) => a.access_type === "WRITE")
    if (isArrayElementGroup(writeAccesses)) return "TUP"

    // Check 3: Adjacent address pattern (e.g., regH, regL)
    if (hasAdjacentAddressPattern([...writeVars])) return "TUP"
  }
  // Disjoint read/write sets → DAC pattern
  if (readVars.size > 0 && writeVars.size > 0) {
    let disjoint = true
    for (const v of readVars) {
      if (writeVars.has(v)) {
        disjoint = false
        break
      }
    }
    if (disjoint) return "DAC"
  }
  return "DFC"
}

function assignVariableRoles(
  accesses: VarAccess[],
  anchorType: "DFC" | "TUP" | "DAC",
): void {
  if (anchorType === "DAC") {
    const readVars = new Set(
      accesses
        .filter((a) => a.access_type === "READ")
        .map((a) => a.variable_name),
    )
    for (const a of accesses) {
      if (readVars.has(a.variable_name) && a.access_type === "READ")
        a.role = "DECISION"
      else a.role = "ACTION"
    }
  } else if (anchorType === "TUP") {
    for (const a of accesses) a.role = "TRANSACTIONAL"
  } else {
    for (const a of accesses) a.role = "SINK_OPERAND"
  }
}

function parseJoernAccessLists(raw: any): {
  groups: CVGroup[]
  stats: JoernStatsData
} {
  const groups: CVGroup[] = []
  const accessLists = raw?.AccessLists ?? []
  const stats = parseJoernStats(raw)

  for (let idx = 0; idx < accessLists.length; idx++) {
    const al = accessLists[idx]
    if (!Array.isArray(al) || al.length < 2) continue

    const variables: string[] = []
    const accesses: VarAccess[] = []

    for (const entry of al) {
      if (typeof entry !== "object" || !entry) continue

      const rawExpr: string = entry.ExprText ?? ""
      const varExpr = sharedNormalize(rawExpr)
      // Determine access type: Joern's AccessType may report READ for assignment
      // expressions like "snd_sig[3] = 0". Detect simple assignment (=) in the
      // raw expression to correct access type to WRITE.
      let accessType: "READ" | "WRITE" =
        entry.AccessType === "WRITE" ? "WRITE" : "READ"
      if (accessType === "READ" && /(?<![!<>=])=(?!=)/.test(rawExpr)) {
        accessType = "WRITE"
      }

      const loc: SourceLoc = {
        file_path: entry.FilePath ?? "",
        line: entry.Line ?? 0,
        column: entry.Column ?? 0,
        function: entry.Function ?? "",
        code: rawExpr,
      }

      const access: VarAccess = {
        variable_name: varExpr,
        access_type: accessType,
        location: loc,
        entry_function: entry.Entry ?? "",
        expression: rawExpr,
        role: "UNKNOWN",
      }

      if (!variables.includes(varExpr)) variables.push(varExpr)
      accesses.push(access)
    }

    if (variables.length < 2) continue

    // ── Anchor type determination ──
    // Primary: use Joern source dimension tag (added in multivarCorrelatedVarsIdentify.scala)
    // Fallback: heuristic inference from access read/write patterns
    const joernSource: string | undefined = al[0]?.Source
    let anchorType: "DFC" | "TUP" | "DAC"
    if (joernSource === "dac") {
      anchorType = "DAC"
    } else if (joernSource === "update") {
      anchorType = "TUP"
    } else if (joernSource === "sink") {
      anchorType = "DFC"
    } else {
      // Fallback: heuristic inference (backward compatible with old Joern output)
      anchorType = inferAnchorType(accesses)
    }

    // C2: TUP same-function check — transactional writes must be in the same function.
    // Cross-function writes are not a valid transactional group and are discarded
    // (not downgraded to DFC, as TUP and DFC represent different semantics).
    if (anchorType === "TUP") {
      const fns = new Set(accesses.map((a) => a.location.function).filter(Boolean))
      if (fns.size > 1) {
        continue // discard: cross-function TUP is invalid
      }
    }

    // C1: DFC same-function constraint
    if (anchorType === "DFC") {
      // Same-function constraint: split cross-function groups
      const byFunction = new Map<string, typeof accesses>()
      for (const a of accesses) {
        const fn = a.location.function || "__unknown__"
        if (!byFunction.has(fn)) byFunction.set(fn, [])
        byFunction.get(fn)!.push(a)
      }

      if (byFunction.size > 1) {
        // Split into per-function sub-groups
        let subIdx = 0
        for (const [fn, fnAccesses] of byFunction) {
          const fnVars = [...new Set(fnAccesses.map((a) => a.variable_name))]
          if (fnVars.length < 2) continue // need at least 2 variables

          const subAnchor = inferAnchorType(fnAccesses)
          assignVariableRoles(fnAccesses, subAnchor)
          const subGroup: CVGroup = {
            id: `cg_${String(idx).padStart(4, "0")}_${subIdx}`,
            variables: fnVars,
            anchor_type: subAnchor,
            accesses: fnAccesses,
            evidence: {},
            confidence: 0,
            struct_base: extractCommonStructBase(fnAccesses),
            domain_category: "",
          }
          groups.push(subGroup)
          subIdx++
        }
        continue // skip the original multi-function group
      }
    }

    assignVariableRoles(accesses, anchorType)

    const bases = new Set<string>()
    for (const v of variables) {
      const b = extractStructBase(v)
      if (b) bases.add(b)
    }
    const structBase = bases.size === 1 ? [...bases][0] : undefined

    // Compute anchor_id for DAC groups: groups sharing the same condition
    // expression location (function + line) belong to the same anchor.
    // This enables the agent to read code once per anchor while evaluating
    // each (decision_var, action_var) pair individually.
    let anchorId: string | undefined
    if (anchorType === "DAC") {
      // Find the DECISION access location — represents the condition expression
      const decisionAccess = accesses.find((a) => a.role === "DECISION")
      if (decisionAccess && decisionAccess.location.line > 0) {
        const fn = decisionAccess.location.function || "__unknown__"
        anchorId = `dac_${fn}_L${decisionAccess.location.line}`
      }
    }

    groups.push({
      id: `cg_${String(idx).padStart(4, "0")}`,
      variables,
      anchor_type: anchorType,
      accesses,
      evidence: {},
      confidence: 0,
      anchor_location: accesses[0]?.location,
      anchor_id: anchorId,
      struct_base: structBase,
      domain_category: "",
    })
  }

  return { groups, stats }
}

// ── Scoring functions ──

interface EvidenceBreakdown {
  [key: string]: number
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

function computeDataflowScore(group: CVGroup): { score: number; breakdown: EvidenceBreakdown } {
  const breakdown: EvidenceBreakdown = {}

  // AQ: Anchor Quality — degraded mode (Phase 1), unified 0.45
  // Phase 2 will use Joern sink subtype tags (sink:arithmetic → 0.50, sink:comparison → 0.45,
  // sink:call → 0.40, sink:indirect:N → 0.45/0.35) for finer discrimination.
  breakdown.aq = 0.45

  // OE: struct_cohesion (+0.12) — same struct fields or same array base
  if (group.struct_base || isArrayElementGroup(group.accesses)) {
    breakdown.struct_cohesion = 0.12
  }

  // OE: multi_site (+0.10) — same variable set appears at ≥2 independent code locations
  if ((group.multi_site_count ?? 0) >= 2) {
    breakdown.multi_site = 0.10
  }

  // OE: naming_affinity (+0.08) — merged H/L suffix pattern + shared prefix
  const uniqueVars = [...new Set(group.variables)]
  if (hasAdjacentAddressPattern(uniqueVars) || extractCommonPrefix(uniqueVars)) {
    breakdown.naming_affinity = 0.08
  }

  // LLM score placeholder — value set by agent Step 3.5 as discrete judgment.
  // Input: 0 (NONE), 0.5 (WEAK), or 1.0 (STRONG). Scale: × 0.15 → 0~0.15 contribution.
  // DFC tool max ~0.75 + llm max 0.15 = 0.90 (residual headroom for Phase 2 AQ refinement).
  const llmScore = group.evidence?.llm_score ?? 0
  if (llmScore > 0) {
    breakdown.llm_contribution = round3(llmScore * 0.15)
  }

  const score = Object.values(breakdown).reduce((sum, v) => sum + v, 0)
  return { score: round3(score), breakdown }
}

function computeTransactionalScore(group: CVGroup): { score: number; breakdown: EvidenceBreakdown } {
  const breakdown: EvidenceBreakdown = {}

  // AQ: based on write operation line gap
  // gap ≤ 1 → 0.38 (strictly adjacent, strongest transactional signal)
  // 1 < gap ≤ 5 → 0.33 (within window but with intervening code)
  const writeLines = group.accesses
    .filter((a) => a.access_type === "WRITE")
    .map((a) => a.location.line)
    .filter((l) => l > 0)
    .sort((a, b) => a - b)
  const gap = writeLines.length >= 2
    ? writeLines[writeLines.length - 1] - writeLines[0]
    : 0
  breakdown.aq = gap <= 1 ? 0.38 : 0.33

  // OE: struct_cohesion (+0.12) — same struct fields or same array base
  if (group.struct_base || isArrayElementGroup(group.accesses)) {
    breakdown.struct_cohesion = 0.12
  }

  // OE: multi_site (+0.10) — same variable set appears at ≥2 independent code locations
  if ((group.multi_site_count ?? 0) >= 2) {
    breakdown.multi_site = 0.10
  }

  // OE: naming_affinity (+0.08) — merged H/L suffix pattern + shared prefix
  const uniqueVars = [...new Set(group.variables)]
  if (hasAdjacentAddressPattern(uniqueVars) || extractCommonPrefix(uniqueVars)) {
    breakdown.naming_affinity = 0.08
  }

  // LLM score placeholder — value set by agent Step 3.5 as discrete judgment.
  // Input: 0 (NONE), 0.5 (WEAK), or 1.0 (STRONG). Scale: × 0.15 → 0~0.15 contribution.
  // TUP tool max ~0.68 + llm max 0.15 = 0.83 (residual headroom for Phase 2 AQ refinement).
  const llmScore = group.evidence?.llm_score ?? 0
  if (llmScore > 0) {
    breakdown.llm_contribution = round3(llmScore * 0.15)
  }

  const score = Object.values(breakdown).reduce((sum, v) => sum + v, 0)
  return { score: round3(score), breakdown }
}

const ADJACENT_ADDRESS_PATTERNS = [
  /^(.+)[._]?(H|L|Hi|Lo|High|Low|MSB|LSB)$/i,
  /^(.+)(H|L)$/, // Case-sensitive bare H/L suffix — avoids false matches on lowercase words ending in h/l
]

function hasAdjacentAddressPattern(variables: string[]): boolean {
  if (variables.length < 2) return false
  for (const pat of ADJACENT_ADDRESS_PATTERNS) {
    const bases = new Set<string>()
    let matched = 0
    for (const v of variables) {
      const m = v.match(pat)
      if (m) {
        bases.add(m[1])
        matched++
      }
    }
    if (matched >= 2 && bases.size === 1) return true
  }
  return false
}

/** Extract common naming prefix from variable names (e.g., "g_chg_state" + "g_chg_mode" → "g_chg_") */
function extractCommonPrefix(variables: string[]): string | undefined {
  if (variables.length < 2) return undefined
  // Strip struct field access to get base names
  const baseNames = variables.map((v) => {
    const dotIdx = v.indexOf(".")
    const arrowIdx = v.indexOf("->")
    const bracketIdx = v.indexOf("[")
    const sepIdx = [dotIdx, arrowIdx, bracketIdx].filter((i) => i >= 0)
    return sepIdx.length > 0 ? v.slice(0, Math.min(...sepIdx)) : v
  })
  if (baseNames.length < 2) return undefined
  // Find longest common prefix among base names
  let prefix = baseNames[0]
  for (let i = 1; i < baseNames.length; i++) {
    while (!baseNames[i].startsWith(prefix) && prefix.length > 0) {
      prefix = prefix.slice(0, -1)
    }
    if (prefix.length === 0) return undefined
  }
  // Must end at a word boundary (_, or end of string) and be meaningful (>= 3 chars, not just "g_")
  const trimmed = prefix.replace(/_$/, "")
  if (trimmed.length < 3) return undefined
  return prefix
}

// ── DAC role assignment ──

function assignDacRoles(group: CVGroup): void {
  const readVars = new Set(
    group.accesses
      .filter((a) => a.access_type === "READ")
      .map((a) => a.variable_name),
  )
  const writeVars = new Set(
    group.accesses
      .filter((a) => a.access_type === "WRITE")
      .map((a) => a.variable_name),
  )

  // Case 1: Both R and W exist — read-only vars are DECISION, others are ACTION
  const readOnly = new Set([...readVars].filter((v) => !writeVars.has(v)))
  if (readOnly.size > 0 && writeVars.size > 0) {
    for (const a of group.accesses) {
      if (readOnly.has(a.variable_name) && a.access_type === "READ")
        a.role = "DECISION"
      else a.role = "ACTION"
    }
    return
  }

  // Case 2: All READ (common for DAC — Joern's determineAccessType may report
  // body accesses as READ when they are function arguments or non-assignment uses).
  //
  // Strategy: Use Joern's anchor_location (condition expression position) as the
  // primary decision point. The anchor_location line comes from the Joern DAC
  // analysis — the condition expression node in the CPG. Variables accessed at
  // the anchor line are DECISION; those accessed at different lines are ACTION.
  //
  // Fallback to min-line heuristic when anchor_location is unavailable.
  // This handles do-while correctly: `do { use(buf); } while (flag);` —
  // anchor_location points to the while condition line (flag), not the body.
  if (writeVars.size === 0 && readVars.size >= 2) {
    // Try anchor_location first (set from Joern DAC condition expression)
    const anchorLine = group.anchor_location?.line
    if (anchorLine && anchorLine > 0) {
      // Variables accessed at the anchor (condition) line are DECISION
      const varsAtAnchor = new Set(
        group.accesses
          .filter((a) => a.location.line === anchorLine)
          .map((a) => a.variable_name),
      )
      const varsNotAtAnchor = new Set(
        group.accesses
          .filter((a) => a.location.line !== anchorLine)
          .map((a) => a.variable_name),
      )
      // Only use this if we get a clean split (some vars at anchor, some not)
      if (varsAtAnchor.size > 0 && varsNotAtAnchor.size > 0) {
        for (const a of group.accesses) {
          a.role = varsAtAnchor.has(a.variable_name) ? "DECISION" : "ACTION"
        }
        return
      }
    }

    // Fallback: Group accesses by variable name and get minimum line for each
    const varMinLine = new Map<string, number>()
    for (const a of group.accesses) {
      if (a.location.line > 0) {
        const cur = varMinLine.get(a.variable_name)
        if (cur === undefined || a.location.line < cur)
          varMinLine.set(a.variable_name, a.location.line)
      }
    }
    if (varMinLine.size >= 2) {
      const minLine = Math.min(...varMinLine.values())
      const maxLine = Math.max(...varMinLine.values())

      // If all variables at the same line, try naming heuristic before giving up
      if (minLine === maxLine) {
        const hasFlag = [...readVars].some((v) => FLAG_PATTERN.test(v))
        const hasData = [...readVars].some((v) => DATA_PATTERN.test(v))
        if (hasFlag && hasData) {
          for (const a of group.accesses) {
            a.role = FLAG_PATTERN.test(a.variable_name) ? "DECISION" : "ACTION"
          }
          return
        }
        // Cannot disambiguate — fall through to final fallback
      } else {
        // Variables at the earliest line are decisions (condition vars)
        const decisionNames = new Set(
          [...varMinLine.entries()]
            .filter(([, line]) => line === minLine)
            .map(([name]) => name),
        )
        for (const a of group.accesses) {
          a.role = decisionNames.has(a.variable_name) ? "DECISION" : "ACTION"
        }
        return
      }
    }
  }

  // Case 3: Line ordering with writes — reads before first write → DECISION
  const sorted = [...group.accesses]
    .filter((a) => a.location.line > 0)
    .sort(
      (a, b) =>
        a.location.line - b.location.line ||
        a.location.column - b.location.column,
    )
  const firstWriteLine = sorted.find(
    (a) => a.access_type === "WRITE",
  )?.location.line
  if (firstWriteLine !== undefined) {
    for (const a of group.accesses) {
      if (a.access_type === "READ" && a.location.line < firstWriteLine)
        a.role = "DECISION"
      else a.role = "ACTION"
    }
  } else {
    // Fall back to naming-based heuristic
    for (const a of group.accesses) {
      if (FLAG_PATTERN.test(a.variable_name)) a.role = "DECISION"
      else if (DATA_PATTERN.test(a.variable_name)) a.role = "ACTION"
      else a.role = "UNKNOWN"
    }
  }
}

function computeDacScore(group: CVGroup): { score: number; breakdown: EvidenceBreakdown } {
  const breakdown: EvidenceBreakdown = {}

  // AQ: Anchor Quality — degraded mode (Phase 1), unified 0.20
  // Phase 2 will use Joern ctrl_type tags (dac:if → 0.22, dac:switch → 0.18,
  // dac:nested → 0.15) for finer discrimination.
  breakdown.aq = 0.20

  // OE: struct_cohesion (+0.12) — same struct fields or same array base
  if (group.struct_base || isArrayElementGroup(group.accesses)) {
    breakdown.struct_cohesion = 0.12
  }

  // OE: multi_site (+0.10) — same variable set appears at ≥2 independent code locations
  if ((group.multi_site_count ?? 0) >= 2) {
    breakdown.multi_site = 0.10
  }

  // OE: naming_affinity (+0.08) — merged flag/data naming pattern + H/L suffix + shared prefix
  const uniqueVars = [...new Set(group.variables)]
  if (hasAdjacentAddressPattern(uniqueVars) || extractCommonPrefix(uniqueVars)) {
    breakdown.naming_affinity = 0.08
  } else {
    // Check flag+data naming pattern as fallback for naming_affinity
    const decisionVarNames = group.accesses
      .filter((a) => a.role === "DECISION")
      .map((a) => a.variable_name)
    const actionVarNames = group.accesses
      .filter((a) => a.role === "ACTION")
      .map((a) => a.variable_name)
    const decisionMatchesFlag = decisionVarNames.some((v) => FLAG_PATTERN.test(v))
    const actionMatchesData = actionVarNames.some((v) => DATA_PATTERN.test(v))
    if (decisionMatchesFlag && actionMatchesData) {
      breakdown.naming_affinity = 0.08
    } else if (decisionMatchesFlag || actionMatchesData) {
      breakdown.naming_affinity = 0.05
    }
  }

  // LLM score placeholder — value set by agent Step 3.5 as discrete judgment.
  // Input: 0 (NONE), 0.5 (WEAK), or 1.0 (STRONG). Scale: × 0.40 → 0~0.40 contribution.
  // DAC tool max ~0.50 + llm max 0.40 = 0.90. DAC is the primary LLM judgment channel.
  const llmScore = group.evidence?.llm_score ?? 0
  if (llmScore > 0) {
    breakdown.llm_contribution = round3(llmScore * 0.40)
  }

  const score = Object.values(breakdown).reduce((sum, v) => sum + v, 0)
  return { score: round3(score), breakdown }
}

// ── LLM semantic evaluation placeholder ──
//
// The LLM evaluation runs as Agent Step 3.5 using discrete 3-level judgments:
//   STRONG (L=1.0): variables have a clear consistency contract, must be atomic
//   WEAK   (L=0.5): variables may be related, but the relationship is uncertain
//   NONE   (L=0.0): no semantic correlation, structural co-occurrence is coincidental
//
// The agent writes L values to evidence.llm_score. The scoring functions
// convert this to anchor-type-specific contributions via llm_contribution:
//   - DFC: L × 0.15 (tool max ~0.75 + llm max 0.15 = 0.90)
//   - TUP: L × 0.15 (tool max ~0.68 + llm max 0.15 = 0.83)
//   - DAC: L × 0.40 (tool max ~0.50 + llm max 0.40 = 0.90)
//
// Trigger rules (agent decides when to invoke LLM):
//   - DFC: S ≥ 0.55 → skip (direct pass); 0.40 ≤ S < 0.55 → evaluate; S < 0.40 → discard
//   - TUP: S ≥ 0.55 → skip (direct pass); 0.35 ≤ S < 0.55 → evaluate; S < 0.35 → discard
//   - DAC: S ≥ 0.20 → always evaluate (LLM is the primary judgment channel); S < 0.20 → discard
//
// Current implementation: The evaluation is performed by the multivar-atomicity-checker
// agent, which reads tool output, evaluates semantics via its own LLM context,
// and writes back evidence.llm_score to the JSON file before the final filter.
//
// Future: When a direct LLM API interface is available, evaluation can be
// integrated into the tool itself via the following interface.

// ── Anchor data structures ──

interface AnchorRecord {
  id: string
  anchor_type: "DFC" | "TUP" | "DAC"
  function: string
  file: string
  variables: string[]
  // DFC-specific
  sink_expr?: string
  sink_line?: number
  // TUP-specific
  write_lines?: number[]
  gap?: number
  // DAC-specific
  ctrl_type?: string
  condition_var?: string
  condition_expr?: string
  condition_line?: number
  body_vars?: string[]
}

/**
 * Build anchor records from refined groups.
 * Anchors represent the structural pattern (sink/write-window/condition) that
 * gave rise to the correlated variable pair. Multiple pairs may share the same anchor.
 */
function buildAnchors(groups: CVGroup[]): AnchorRecord[] {
  const anchors: AnchorRecord[] = []
  const seen = new Set<string>()  // dedup by anchor key

  for (const g of groups) {
    const fn = g.accesses[0]?.location?.function || ""
    const file = g.accesses[0]?.location?.file_path || ""

    if (g.anchor_type === "DFC") {
      // DFC anchor: sink expression
      const sinkAccess = g.accesses[0]
      const key = `DFC_${fn}_L${sinkAccess?.location?.line ?? 0}`
      if (seen.has(key)) continue
      seen.add(key)
      anchors.push({
        id: `anc_${String(anchors.length + 1).padStart(3, "0")}`,
        anchor_type: "DFC",
        function: fn,
        file,
        variables: [...new Set(g.variables)],
        sink_expr: sinkAccess?.expression || "",
        sink_line: sinkAccess?.location?.line ?? 0,
      })
    } else if (g.anchor_type === "TUP") {
      const writeLines = g.accesses
        .filter((a) => a.access_type === "WRITE")
        .map((a) => a.location.line)
        .filter((l) => l > 0)
        .sort((a, b) => a - b)
      const key = `TUP_${fn}_L${writeLines[0] ?? 0}`
      if (seen.has(key)) continue
      seen.add(key)
      const gap = writeLines.length >= 2
        ? writeLines[writeLines.length - 1] - writeLines[0]
        : 0
      anchors.push({
        id: `anc_${String(anchors.length + 1).padStart(3, "0")}`,
        anchor_type: "TUP",
        function: fn,
        file,
        variables: [...new Set(g.variables)],
        write_lines: writeLines,
        gap,
      })
    } else if (g.anchor_type === "DAC") {
      const decisionAccess = g.accesses.find((a) => a.role === "DECISION")
      const condLine = decisionAccess?.location?.line ?? 0
      const key = g.anchor_id || `DAC_${fn}_L${condLine}`
      if (seen.has(key)) continue
      seen.add(key)
      const bodyVars = [...new Set(
        g.accesses.filter((a) => a.role === "ACTION").map((a) => a.variable_name),
      )]
      anchors.push({
        id: `anc_${String(anchors.length + 1).padStart(3, "0")}`,
        anchor_type: "DAC",
        function: fn,
        file,
        variables: [...new Set(g.variables)],
        condition_var: decisionAccess?.variable_name || "",
        condition_expr: decisionAccess?.expression || "",
        condition_line: condLine,
        body_vars: bodyVars,
      })
    }
  }
  return anchors
}

/**
 * Build correlatedVars.json format with status field (PASS/GRAY/FILTERED).
 */
function buildCorrelatedVarsPairs(
  groups: CVGroup[],
  anchors: AnchorRecord[],
): any[] {
  // Build anchor lookup: key → anchor id
  const anchorIdMap = new Map<string, string>()
  for (const a of anchors) {
    if (a.anchor_type === "DFC") {
      anchorIdMap.set(`DFC_${a.function}_L${a.sink_line ?? 0}`, a.id)
    } else if (a.anchor_type === "TUP") {
      anchorIdMap.set(`TUP_${a.function}_L${a.write_lines?.[0] ?? 0}`, a.id)
    } else if (a.anchor_type === "DAC") {
      anchorIdMap.set(`DAC_${a.function}_L${a.condition_line ?? 0}`, a.id)
    }
  }

  return groups.map((g, i) => {
    const fn = g.accesses[0]?.location?.function || ""
    const line = g.anchor_location?.line ?? g.accesses[0]?.location?.line ?? 0
    let anchorKey: string
    if (g.anchor_type === "DFC") {
      anchorKey = `DFC_${fn}_L${g.accesses[0]?.location?.line ?? 0}`
    } else if (g.anchor_type === "TUP") {
      const writeLines = g.accesses
        .filter((a) => a.access_type === "WRITE")
        .map((a) => a.location.line)
        .filter((l) => l > 0)
        .sort((a, b) => a - b)
      anchorKey = `TUP_${fn}_L${writeLines[0] ?? 0}`
    } else {
      const decisionAccess = g.accesses.find((a) => a.role === "DECISION")
      anchorKey = g.anchor_id || `DAC_${fn}_L${decisionAccess?.location?.line ?? 0}`
    }

    // Determine status based on thresholds
    const grayLower = g.anchor_type === "DFC" ? 0.40
      : g.anchor_type === "TUP" ? 0.35
      : 0.20
    let status: string
    if (g.confidence >= 0.55) {
      status = "PASS"
    } else if (g.confidence >= grayLower) {
      status = "GRAY"
    } else {
      status = "FILTERED"
    }

    return {
      id: `cv_${String(i + 1).padStart(3, "0")}`,
      anchor_id: anchorIdMap.get(anchorKey) ?? "",
      anchor_type: g.anchor_type,
      variables: g.variables,
      function: fn,
      file: g.accesses[0]?.location?.file_path || "",
      location: { line },
      confidence: g.confidence,
      evidence: { ...g.evidence },
      status,
    }
  })
}

// ── Multi-site computation ──

/**
 * Compute multi_site_count for each group: how many independent code locations
 * share the same variable set (sorted variable names). Groups at different
 * functions or line regions (gap > 20) count as different sites.
 */
function computeMultiSiteCounts(groups: CVGroup[]): void {
  // Group by sorted variable set key
  const varSetMap = new Map<string, CVGroup[]>()
  for (const g of groups) {
    const key = [...new Set(g.variables)].sort().join("|")
    if (!varSetMap.has(key)) varSetMap.set(key, [])
    varSetMap.get(key)!.push(g)
  }

  for (const [, sameVarGroups] of varSetMap) {
    // Count distinct code locations: different function OR line gap > 20
    const locations: { fn: string; line: number }[] = []
    for (const g of sameVarGroups) {
      const fn = g.accesses[0]?.location?.function || "__unknown__"
      const line = g.anchor_location?.line ?? g.accesses[0]?.location?.line ?? 0
      locations.push({ fn, line })
    }

    // Deduplicate locations: same function + line within 20 = same site
    const sites: { fn: string; line: number }[] = []
    for (const loc of locations) {
      const existing = sites.find(
        (s) => s.fn === loc.fn && Math.abs(s.line - loc.line) <= 20,
      )
      if (!existing) sites.push(loc)
    }

    const count = sites.length
    for (const g of sameVarGroups) {
      g.multi_site_count = count
    }
  }
}

// ── Evidence aggregation ──

function refineEvidence(groups: CVGroup[]): CVGroup[] {
  const refined: CVGroup[] = []
  for (const group of groups) {
    // Re-compute evidence breakdown (in case evidence was modified externally, e.g. by agent LLM step)
    let result: { score: number; breakdown: EvidenceBreakdown }
    switch (group.anchor_type) {
      case "DFC":
        result = computeDataflowScore(group)
        break
      case "TUP":
        result = computeTransactionalScore(group)
        break
      case "DAC":
        result = computeDacScore(group)
        break
      default:
        continue
    }
    // Preserve any existing evidence keys (e.g., llm_score from agent unified LLM step)
    group.evidence = { ...group.evidence, ...result.breakdown }
    group.confidence = result.score

    // Differentiated tool-level threshold (aligned with AQ degraded values):
    // - DFC >= 0.40: AQ=0.45 passes by default; filters only anomalous cases
    // - TUP >= 0.35: AQ=0.33-0.38; filters TUP without any structural evidence
    // - DAC >= 0.20: AQ=0.20; low bar to let all DAC groups pass to agent for LLM evaluation
    const threshold = group.anchor_type === "DAC" ? 0.20
      : group.anchor_type === "TUP" ? 0.35
      : 0.40  // DFC
    if (group.confidence >= threshold) {
      refined.push(group)
    }
  }
  return refined
}

function parseJsonFromOutput(output: string): any {
  const trimmed = output.trim()
  for (const [startChar, endChar] of [
    ["{", "}"],
    ["[", "]"],
  ] as const) {
    const start = trimmed.indexOf(startChar)
    if (start !== -1) {
      const end = trimmed.lastIndexOf(endChar)
      if (end !== -1) {
        try {
          return JSON.parse(trimmed.substring(start, end + 1))
        } catch {
          continue
        }
      }
    }
  }
  return null
}

// ── Markdown report generation ──

function formatEvidenceBreakdown(evidence: Record<string, number>): string {
  return Object.entries(evidence)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${k}=${v.toFixed(3)}`)
    .join(", ")
}

function generateCorrelatedGroupsMd(
  groups: CVGroup[],
  stats: JoernStatsData,
  summary: { total_candidates: number; after_refinement: number; by_type: Record<string, number> },
): string {
  const lines: string[] = []
  lines.push("# 关联变量组分析结果")
  lines.push("")
  lines.push(`**日期**: ${new Date().toISOString().split("T")[0]}`)
  lines.push("")

  // Summary table
  lines.push("## 概览")
  lines.push("")
  lines.push("| 指标 | 值 |")
  lines.push("|------|------|")
  lines.push(`| 全局变量数 | ${stats.global_var} |`)
  lines.push(`| 共享变量数 | ${stats.shared_var} |`)
  lines.push(`| 候选组总数 | ${summary.total_candidates} |`)
  lines.push(`| 过滤后组数 | ${summary.after_refinement} |`)
  lines.push("")

  // By type
  lines.push("## 按锚点类型分布")
  lines.push("")
  lines.push("| 锚点类型 | 数量 | 平均置信度 |")
  lines.push("|----------|------|-----------|")
  for (const anchorType of ["DFC", "TUP", "DAC"] as const) {
    const typeGroups = groups.filter((g) => g.anchor_type === anchorType)
    const count = typeGroups.length
    const avgConf = count > 0
      ? (typeGroups.reduce((sum, g) => sum + g.confidence, 0) / count).toFixed(3)
      : "-"
    lines.push(`| ${anchorType} | ${count} | ${avgConf} |`)
  }
  lines.push(`| **合计** | **${groups.length}** | |`)
  lines.push("")

  // Group details
  lines.push("## 关联变量组详情")
  lines.push("")
  if (groups.length === 0) {
    lines.push("> 未识别到关联变量组。")
  } else {
    lines.push(`> 按置信度降序排列，共 ${groups.length} 个。`)
    lines.push("")
    lines.push("| # | ID | 锚点类型 | 变量 | 置信度 | 证据分解 | 位置 |")
    lines.push("|---|-----|---------|------|--------|---------|------|")
    const sorted = [...groups].sort((a, b) => b.confidence - a.confidence)
    for (let i = 0; i < sorted.length; i++) {
      const g = sorted[i]
      const vars = g.variables.map((v) => `\`${v}\``).join(", ")
      const loc = g.anchor_location
        ? `${g.anchor_location.file_path.split(/[\\/]/).pop()}:${g.anchor_location.line}`
        : "-"
      const breakdown = formatEvidenceBreakdown(g.evidence)
      lines.push(`| ${i + 1} | ${g.id} | ${g.anchor_type} | ${vars} | ${g.confidence.toFixed(3)} | ${breakdown} | ${loc} |`)
    }
  }
  lines.push("")

  return lines.join("\n")
}

// ── LLM Evaluation Merge ──

interface LlmEvaluation {
  group_id: string
  llm_judgment: "STRONG" | "WEAK" | "NONE"
  llm_reason: string
}

interface MergeInput {
  correlated_groups_path: string
  evaluations: LlmEvaluation[]
  skipped_pass_ids: string[]
  skipped_filtered_ids: string[]
  budget_skipped_ids: string[]
  project_name: string
  llm_model: string
  final_threshold: number
  md_output_path?: string
}

const LAMBDA: Record<string, number> = { DFC: 0.15, TUP: 0.15, DAC: 0.40 }

function judgmentToL(judgment: "STRONG" | "WEAK" | "NONE"): number {
  return judgment === "STRONG" ? 1.0 : judgment === "WEAK" ? 0.5 : 0.0
}

function mergeLlmEvaluation(input: MergeInput): string {
  if (!existsSync(input.correlated_groups_path)) {
    return JSON.stringify({ status: "error", error: `File not found: ${input.correlated_groups_path}` })
  }
  let rawData: any
  try {
    rawData = JSON.parse(readFileSync(input.correlated_groups_path, "utf-8"))
  } catch (err: any) {
    return JSON.stringify({ status: "error", error: `Failed to parse JSON: ${err.message}` })
  }

  const groups: any[] = rawData.groups || []
  const dacAnchors: any[] = rawData.dac_anchors || []

  const evalMap = new Map<string, LlmEvaluation>()
  for (const e of input.evaluations) {
    evalMap.set(e.group_id, e)
  }
  const passSet = new Set(input.skipped_pass_ids)
  const filteredSet = new Set(input.skipped_filtered_ids)
  const budgetSet = new Set(input.budget_skipped_ids)

  // ── Contract validation: detect groups that need LLM evaluation but were not provided ──
  const missingGroups: { id: string; anchor_type: string; confidence: number; reason: string }[] = []
  for (const g of groups) {
    const id = g.id as string
    const S = g.confidence as number
    const type = g.anchor_type as string
    if (passSet.has(id) || filteredSet.has(id) || evalMap.has(id) || budgetSet.has(id)) continue
    if (type === "DAC") {
      missingGroups.push({ id, anchor_type: type, confidence: S, reason: "DAC groups always require LLM evaluation" })
    } else if (type === "DFC" && S >= 0.40 && S < 0.55) {
      missingGroups.push({ id, anchor_type: type, confidence: S, reason: "DFC gray-zone (0.40 ≤ S < 0.55) requires LLM evaluation" })
    } else if (type === "TUP" && S >= 0.35 && S < 0.55) {
      missingGroups.push({ id, anchor_type: type, confidence: S, reason: "TUP gray-zone (0.35 ≤ S < 0.55) requires LLM evaluation" })
    }
  }
  if (missingGroups.length > 0) {
    return JSON.stringify({
      status: "needs_evaluation",
      message: `${missingGroups.length} group(s) require LLM evaluation before merging. Complete §3.5b/3.5c for these groups, then re-call merge_llm_evaluation.`,
      missing_groups: missingGroups,
    })
  }

  const stats = {
    evaluated: 0, skipped_pass: 0, skipped_filtered: 0, budget_skipped: 0, unavailable: 0,
    by_judgment: { STRONG: 0, WEAK: 0, NONE: 0 },
  }

  for (const g of groups) {
    const id = g.id as string
    g.confidence_tool_layer = g.confidence

    if (passSet.has(id)) {
      g.llm_status = "SKIPPED_PASS"
      g.evidence.llm_score = 0
      stats.skipped_pass++
    } else if (filteredSet.has(id)) {
      g.llm_status = "SKIPPED_FILTERED"
      g.evidence.llm_score = 0
      stats.skipped_filtered++
    } else if (evalMap.has(id)) {
      const ev = evalMap.get(id)!
      const L = judgmentToL(ev.llm_judgment)
      g.llm_status = "EVALUATED"
      g.llm_judgment = ev.llm_judgment
      g.llm_reason = ev.llm_reason
      g.evidence.llm_score = L
      stats.evaluated++
      stats.by_judgment[ev.llm_judgment]++
    } else if (budgetSet.has(id)) {
      g.llm_status = "BUDGET_SKIPPED"
      g.evidence.llm_score = 0
      stats.budget_skipped++
    } else {
      g.llm_status = "UNAVAILABLE"
      g.evidence.llm_score = 0
      stats.unavailable++
    }

    const lambda = LAMBDA[g.anchor_type as string] ?? 0.15
    const llmScore = g.evidence.llm_score ?? 0
    let structuralSum = 0
    for (const [key, val] of Object.entries(g.evidence)) {
      if (key !== "llm_score" && key !== "llm_contribution" && typeof val === "number") {
        structuralSum += val
      }
    }
    g.confidence = structuralSum + llmScore * lambda
  }

  const passed = groups.filter((g: any) => g.confidence >= input.final_threshold)
  const passedIds = new Set(passed.map((g: any) => g.id))

  const cleanedAnchors = dacAnchors
    .map((a: any) => ({
      ...a,
      group_ids: (a.group_ids || []).filter((id: string) => passedIds.has(id)),
    }))
    .filter((a: any) => a.group_ids.length > 0)

  const refinedResult = {
    ...rawData,
    groups: passed,
    dac_anchors: cleanedAnchors,
    summary: {
      ...rawData.summary,
      after_refinement: passed.length,
      by_type: {
        dfc: passed.filter((g: any) => g.anchor_type === "DFC").length,
        tup: passed.filter((g: any) => g.anchor_type === "TUP").length,
        dac: passed.filter((g: any) => g.anchor_type === "DAC").length,
      },
    },
  }

  try {
    writeFileSync(input.correlated_groups_path, JSON.stringify(refinedResult, null, 2), "utf-8")
  } catch (err: any) {
    return JSON.stringify({ status: "error", error: `Failed to write: ${err.message}` })
  }

  // Regenerate MD with final filtered groups (overwrites Tool A's initial version)
  if (input.md_output_path) {
    try {
      const md = generateCorrelatedGroupsMd(passed, rawData.stats, refinedResult.summary)
      writeFileSync(input.md_output_path, md, "utf-8")
    } catch { /* best-effort */ }
  }

  return JSON.stringify({
    status: "ok",
    summary: {
      total_groups: groups.length,
      evaluated: stats.evaluated,
      skipped_pass: stats.skipped_pass,
      skipped_filtered: stats.skipped_filtered,
      budget_skipped: stats.budget_skipped,
      by_judgment: stats.by_judgment,
      after_filter: passed.length,
    },
  })
}

// ── Tool definition ──

export const multivarCorrelatedVars: ToolDefinition = tool({
  description:
    "Identify correlated variable groups from a Joern CPG, or merge LLM evaluation results. " +
    "Action 'identify' (default): Joern dataflow analysis → DFC/TUP/DAC classification with tiered evidence scoring. " +
    "Action 'merge_llm_evaluation': merge LLM judgments into existing groups, recalculate confidence, apply 0.55 filter, write back in-place.",
  args: {
    cpg_path: tool.schema
      .string()
      .describe(
        "Absolute path to the Joern CPG binary file (created by multivar_cpg_create)",
      ),
    project_name: tool.schema
      .string()
      .describe(
        "Project name (must match the name used during CPG creation)",
      ),
    task_entries: tool.schema
      .string()
      .describe(
        `JSON array of task/main entry function names (e.g., '["main", "app_task"]').`,
      ),
    isr_entries: tool.schema
      .string()
      .describe(
        `JSON array of ISR entry function names (e.g., '["Timer0_ISR", "UART_IRQHandler"]').`,
      ),
    output_path: tool.schema
      .string()
      .optional()
      .describe(
        "Absolute path to write the correlated groups JSON result file. " +
        "If provided, the full result is written to this file AND returned as tool output. " +
        "Recommended: use '.matrix/data/multivar-correlated-accesses.json' so that multivar_violation_detect " +
        "can read it via correlated_groups_path.",
      ),
    md_output_path: tool.schema
      .string()
      .optional()
      .describe(
        "Absolute path to write a Markdown summary of correlated variable groups. " +
        "Recommended: '.matrix/reports/multivar-correlated-pairs.md'.",
      ),
    // ── merge_llm_evaluation action params ──
    action: tool.schema
      .string()
      .optional()
      .describe(
        "Action: 'identify' (default) runs Joern analysis; " +
        "'merge_llm_evaluation' merges LLM judgments into existing groups.",
      ),
    evaluations: tool.schema
      .string()
      .optional()
      .describe(
        "JSON array of LLM evaluations: [{group_id, llm_judgment: STRONG|WEAK|NONE, llm_reason}]. " +
        "Only for merge_llm_evaluation.",
      ),
    skipped_pass_ids: tool.schema
      .string()
      .optional()
      .describe(
        "JSON array of group IDs that direct-pass (S >= 0.55). Only for merge_llm_evaluation.",
      ),
    skipped_filtered_ids: tool.schema
      .string()
      .optional()
      .describe(
        "JSON array of group IDs direct-discarded (below gray zone). Only for merge_llm_evaluation.",
      ),
    budget_skipped_ids: tool.schema
      .string()
      .optional()
      .describe(
        "JSON array of group IDs intentionally skipped due to §3.5e budget limits. " +
        "These groups receive llm_status='BUDGET_SKIPPED' and llm_score=0, and are eliminated by the final threshold filter. " +
        "ONLY use for DAC groups explicitly omitted under §3.5e — do NOT use to bypass evaluation of important groups.",
      ),
    correlated_groups_path: tool.schema
      .string()
      .optional()
      .describe(
        "Path to correlated-accesses.json for in-place merge. Only for merge_llm_evaluation.",
      ),
    md_output_path_for_merge: tool.schema
      .string()
      .optional()
      .describe(
        "Path to write the final correlated-pairs.md after LLM filtering. " +
        "Recommended: '.matrix/reports/multivar-correlated-pairs.md'. Only for merge_llm_evaluation.",
      ),
    project_name_for_merge: tool.schema
      .string()
      .optional()
      .describe("Project name for merge metadata. Only for merge_llm_evaluation."),
    llm_model: tool.schema
      .string()
      .optional()
      .describe("LLM model identifier. Only for merge_llm_evaluation."),
    final_threshold: tool.schema
      .number()
      .optional()
      .describe("Confidence threshold for final filter (default 0.55). Only for merge_llm_evaluation."),
  },
  async execute(params: any) {
    // Route by action
    if (params.action === "merge_llm_evaluation") {
      let evaluations: LlmEvaluation[]
      let skipPass: string[]
      let skipFiltered: string[]
      let budgetSkipped: string[]
      try {
        evaluations = JSON.parse(params.evaluations || "[]")
        skipPass = JSON.parse(params.skipped_pass_ids || "[]")
        skipFiltered = JSON.parse(params.skipped_filtered_ids || "[]")
        budgetSkipped = JSON.parse(params.budget_skipped_ids || "[]")
      } catch (err: any) {
        return JSON.stringify({ status: "error", error: `Invalid JSON: ${err.message}` })
      }
      return mergeLlmEvaluation({
        correlated_groups_path: params.correlated_groups_path,
        evaluations,
        skipped_pass_ids: skipPass,
        skipped_filtered_ids: skipFiltered,
        budget_skipped_ids: budgetSkipped,
        project_name: params.project_name_for_merge || params.project_name,
        llm_model: params.llm_model || "unknown",
        final_threshold: params.final_threshold ?? 0.55,
        md_output_path: params.md_output_path_for_merge,
      })
    }

    // ── Original identify action (unchanged) ──
    const { cpg_path, project_name, task_entries, isr_entries, output_path, md_output_path } = params
    // Validate CPG exists
    if (!existsSync(cpg_path)) {
      return JSON.stringify({
        status: "error",
        error: `CPG file not found: ${cpg_path}`,
      })
    }

    // Parse entry lists
    let taskList: string[]
    let isrList: string[]
    try {
      taskList = JSON.parse(task_entries)
      isrList = JSON.parse(isr_entries)
    } catch {
      return JSON.stringify({
        status: "error",
        error:
          "task_entries and isr_entries must be valid JSON arrays of strings.",
      })
    }

    // Resolve Joern script
    let scriptPath: string
    try {
      scriptPath = resolveJoernScriptPath()
    } catch (err: any) {
      return JSON.stringify({ status: "error", error: err.message })
    }

    // Build Joern wrapper script
    const allEntries = [...taskList, ...isrList]
    const entriesScalaList = allEntries.map((e) => `"${e}"`).join(", ")
    const cpgPathForScala = cpg_path.replace(/\\/g, "/")
    const scriptPathForScala = scriptPath.replace(/\\/g, "/")

    const wrapperContent = [
      `//> using file ${scriptPathForScala}`,
      `importCpg("${cpgPathForScala}", "${project_name}")`,
      `val _result = useDefChainAnalysis("${project_name}", List(${entriesScalaList}))`,
      `println(_result)`,
    ].join("\n")

    const wrapperPath = join(
      tmpdir(),
      `atomicity_joern_wrapper_${Date.now()}.sc`,
    )
    writeFileSync(wrapperPath, wrapperContent, "utf-8")

    // Execute Joern
    const projectRoot = findMatrixRoot(dirname(cpg_path))
    const joernBin = resolveJoernBin("joern", projectRoot)
    const cmd = `${joernBin} --script "${wrapperPath}"`

    let stdout: string
    try {
      stdout = execSync(cmd, {
        stdio: "pipe",
        timeout: 600_000, // 10 minutes
        encoding: "utf-8",
        maxBuffer: 50 * 1024 * 1024,
        ...(IS_WINDOWS && { shell: "cmd.exe" }),
      })
    } catch (err: any) {
      const msg = err.stderr || err.message || String(err)
      return JSON.stringify({
        status: "error",
        error: `Joern script execution failed: ${msg.slice(0, 2000)}`,
        wrapper_content: wrapperContent,
      })
    } finally {
      try {
        unlinkSync(wrapperPath)
      } catch {}
    }

    // Parse Joern output
    const rawResult = parseJsonFromOutput(stdout)
    if (!rawResult) {
      return JSON.stringify({
        status: "error",
        error: "Failed to parse JSON from Joern output",
        raw_output: stdout.slice(0, 3000),
      })
    }

    // Parse access lists into groups
    const { groups: rawGroups, stats } = parseJoernAccessLists(rawResult)

    if (rawGroups.length === 0) {
      const emptyResult = {
        status: "success",
        groups: [],
        stats,
        message: "No correlated variable groups identified.",
      }
      if (output_path) {
        try {
          const dir = join(output_path, "..")
          mkdirSync(dir, { recursive: true })
          writeFileSync(output_path, JSON.stringify(emptyResult, null, 2), "utf-8")
        } catch { /* best-effort */ }
      }
      return JSON.stringify(emptyResult)
    }

    // Compute multi_site_count: how many independent code locations share the same variable set
    computeMultiSiteCounts(rawGroups)

    // Score each group by anchor type and assign DAC roles
    for (const group of rawGroups) {
      if (group.anchor_type === "DAC") {
        assignDacRoles(group)
      }
    }

    // Apply scoring and filter by confidence threshold
    const refined = refineEvidence(rawGroups)
    refined.sort((a, b) => b.confidence - a.confidence)

    // Build anchor records and correlatedVars pairs for structured output
    const anchorRecords = buildAnchors(refined)
    const cvPairs = buildCorrelatedVarsPairs(refined, anchorRecords)

    // Write anchor.json (Step 1 output)
    if (output_path) {
      try {
        const dataDir = join(output_path, "..")
        const anchorPath = join(dataDir, "anchor.json")
        const anchorData = {
          project: project_name,
          timestamp: new Date().toISOString(),
          stats: {
            total: anchorRecords.length,
            by_type: {
              DFC: anchorRecords.filter((a) => a.anchor_type === "DFC").length,
              TUP: anchorRecords.filter((a) => a.anchor_type === "TUP").length,
              DAC: anchorRecords.filter((a) => a.anchor_type === "DAC").length,
            },
            shared_vars_count: stats.shared_var,
            functions_scanned: stats.saa,
          },
          anchors: anchorRecords,
        }
        writeFileSync(anchorPath, JSON.stringify(anchorData, null, 2), "utf-8")
      } catch { /* best-effort */ }

    }

    // Build dac_anchors summary: group DAC pairs by anchor_id so the agent
    // can read source code once per anchor and evaluate each pair individually.
    const dacGroups = refined.filter((g) => g.anchor_type === "DAC" && g.anchor_id)
    const anchorMap = new Map<string, CVGroup[]>()
    for (const g of dacGroups) {
      const key = g.anchor_id!
      if (!anchorMap.has(key)) anchorMap.set(key, [])
      anchorMap.get(key)!.push(g)
    }
    const dacAnchors = [...anchorMap.entries()].map(([anchorId, groups]) => {
      const decisionVars = [...new Set(
        groups.flatMap((g) =>
          g.accesses.filter((a) => a.role === "DECISION").map((a) => a.variable_name),
        ),
      )]
      const actionVars = [...new Set(
        groups.flatMap((g) =>
          g.accesses.filter((a) => a.role === "ACTION").map((a) => a.variable_name),
        ),
      )]
      // Use the first group's DECISION access location as the anchor location
      const firstDecision = groups[0]?.accesses.find((a) => a.role === "DECISION")
      return {
        anchor_id: anchorId,
        condition_location: firstDecision?.location ?? null,
        decision_vars: decisionVars,
        action_vars: actionVars,
        pair_count: groups.length,
        group_ids: groups.map((g) => g.id),
      }
    })

    const result = {
      status: "success",
      groups: refined,
      stats,
      summary: {
        total_candidates: rawGroups.length,
        after_refinement: refined.length,
        by_type: {
          dfc: refined.filter(
            (g) => g.anchor_type === "DFC",
          ).length,
          tup: refined.filter(
            (g) => g.anchor_type === "TUP",
          ).length,
          dac: refined.filter((g) => g.anchor_type === "DAC").length,
        },
      },
      dac_anchors: dacAnchors,
    }

    const resultJson = JSON.stringify(result)

    // Write result to file if output_path is specified
    if (output_path) {
      try {
        const dir = join(output_path, "..")
        mkdirSync(dir, { recursive: true })
        writeFileSync(output_path, JSON.stringify(result, null, 2), "utf-8")
      } catch (err: any) {
        return JSON.stringify({
          status: "error",
          error: `Failed to write output file: ${err.message}`,
          groups: refined,
        })
      }
    }

    // Write Markdown summary if md_output_path is specified
    if (md_output_path) {
      try {
        const mdDir = join(md_output_path, "..")
        mkdirSync(mdDir, { recursive: true })
        const md = generateCorrelatedGroupsMd(refined, stats, result.summary)
        writeFileSync(md_output_path, md, "utf-8")
      } catch { /* best-effort */ }
    }

    return resultJson
  },
})
