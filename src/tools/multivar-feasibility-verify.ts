import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync } from "fs"
import { join, dirname } from "path"
import { execSync } from "child_process"
import { tmpdir } from "os"
import { resolveZ3Bin, resolveJoernBin, resolveJoernScriptPath, findMatrixRoot } from "./joern-resolve-cli"

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
  role: string
}

interface InterruptAccessPair {
  isr_name: string
  priority: number
  access: VarAccess
}

interface PreemptionPoint {
  location: SourceLoc
  interrupt_enabled: boolean
  in_critical_section: boolean
}

interface ViolationInput {
  id: string
  pattern: string
  correlated_group_id: string
  variables: string[]
  main_accesses: VarAccess[]
  interrupt_accesses: InterruptAccessPair[]
  preemption_point?: PreemptionPoint
  feasibility: string
  severity: string
  description: string
}

/** Map feasibility result to severity level per methodology §5 */
function feasibilityToSeverity(feasibility: string): string {
  switch (feasibility) {
    case "CONFIRMED": return "critical"
    case "INFEASIBLE": return "info"
    case "UNKNOWN": return "major"
    default: return "major"
  }
}

interface InterruptStateChange {
  api: string
  line: number
  effect: "enable" | "disable"
}

interface PathAssignment {
  variable: string
  value: string
  line: number
  is_constant: boolean
}

interface PathCondition {
  expression: string
  branch: string
  line: number
}

interface SubPathResult {
  type: string
  reachable: boolean
  conditions: PathCondition[]
  assignments: PathAssignment[]
  enclosing_conditions: PathCondition[]
  interrupt_state_changes: InterruptStateChange[]
  path_length: number
  via_calls: string[]
  reason?: string
  // Inter-procedural caller-side conditions (from call chain analysis)
  caller_conditions?: PathCondition[]
  caller_assignments?: PathAssignment[]
  caller_enclosing_conditions?: PathCondition[]
  call_chain?: string[]
  has_multiple_call_sites?: boolean
}

interface PreemptionState {
  active_conditions: PathCondition[]
  active_assignments: PathAssignment[]
  enclosing_conditions: PathCondition[]
  short_circuit_constraints: PathCondition[]
  // Inter-procedural caller-side conditions propagated from SP1
  caller_conditions?: PathCondition[]
  caller_assignments?: PathAssignment[]
  caller_enclosing_conditions?: PathCondition[]
}

interface PathAnalysisResult {
  sub_path_1: SubPathResult
  sub_path_2: SubPathResult
  sub_path_3: SubPathResult
  state_at_preemption: PreemptionState
  interrupt_enabled: boolean
  infeasibility_reason?: string
}

interface VerifiedViolation extends ViolationInput {
  feasibility: "CONFIRMED" | "INFEASIBLE" | "UNKNOWN"
  path_constraint: string
  path_analysis?: PathAnalysisResult
}

// ── Joern path query ──

/**
 * Build sub-path specs for a single violation to send to Joern.
 */
function buildSubPathSpecs(violation: ViolationInput): Array<Record<string, unknown>> {
  const mainAccesses = violation.main_accesses
  const isrAccesses = violation.interrupt_accesses

  // Accept single-variable schema (3 total accesses: 2 main + 1 ISR) as well
  // as the multi-variable 4-access schema (2 main + 2 ISR). When only 1 ISR
  // access is present, the "isr_internal" sub-path degenerates to a single
  // point (access1 == access2 in the ISR), which is trivially reachable.
  if (mainAccesses.length < 2 || isrAccesses.length < 1) {
    return []
  }

  // Sort main accesses by line number (execution order)
  const sortedMain = [...mainAccesses].sort((a, b) => a.location.line - b.location.line)
  const mainA1 = sortedMain[0]
  const mainA2 = sortedMain[sortedMain.length - 1]

  // Sort ISR accesses by line number — the array order from violation-detect
  // may not match the execution order within the ISR function
  const sortedIsr = [...isrAccesses].sort((a, b) => a.access.location.line - b.access.location.line)
  const isrA1 = sortedIsr[0].access
  const isrA2 = sortedIsr[sortedIsr.length - 1].access

  return [
    {
      type: "main_to_access1",
      function: mainA1.location.function,
      entry_function: mainA1.entry_function || mainA1.location.function,
      entry_line: -1,
      target_line: mainA1.location.line,
      target_variable: mainA1.variable_name,
    },
    {
      type: "isr_internal",
      function: isrA1.location.function,
      entry_function: sortedIsr[0].isr_name || isrA1.entry_function || isrA1.location.function,
      access1_line: isrA1.location.line,
      access1_variable: isrA1.variable_name,
      access2_line: isrA2.location.line,
      access2_variable: isrA2.variable_name,
    },
    {
      type: "access1_to_access2",
      function: mainA2.location.function,
      from_line: mainA1.location.line,
      from_variable: mainA1.variable_name,
      to_line: mainA2.location.line,
      to_variable: mainA2.variable_name,
    },
  ]
}

/**
 * Call Joern's analyzePathFeasibility() for a batch of violations.
 * Returns raw JSON results from the Scala script.
 */
function queryPathFeasibility(
  cpgPath: string,
  projectName: string,
  violations: ViolationInput[],
  interruptApis: string[],
  projectRoot: string | null,
): Map<string, { sub_paths: SubPathResult[]; state_at_preemption?: PreemptionState }> {
  const scriptPath = resolveJoernScriptPath()
  const cpgPathForScala = cpgPath.replace(/\\/g, "/")
  const scriptPathForScala = scriptPath.replace(/\\/g, "/")

  // Build violations spec for Joern
  const violationSpecs = violations.map((v) => ({
    id: v.id,
    sub_paths: buildSubPathSpecs(v),
  })).filter((v) => v.sub_paths.length === 3)

  if (violationSpecs.length === 0) {
    return new Map()
  }

  const interruptApisJsonStr = JSON.stringify(interruptApis)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')

  // Write violations spec to a temp JSON file to avoid Joern's "UTF8 string too large"
  // error when the JSON is embedded as a string literal in the Scala script.
  const ts = Date.now()
  const violationsFilePath = join(tmpdir(), `atomicity_fv_violations_${ts}.json`)
  const violationsFilePathForScala = violationsFilePath.replace(/\\/g, "/")
  writeFileSync(violationsFilePath, JSON.stringify(violationSpecs), "utf-8")

  const wrapperContent = [
    `//> using file ${scriptPathForScala}`,
    `importCpg("${cpgPathForScala}", "${projectName}")`,
    `val violationsJson = scala.io.Source.fromFile("${violationsFilePathForScala}").mkString`,
    `val _result = analyzePathFeasibility("${projectName}", violationsJson, "${interruptApisJsonStr}")`,
    `println(_result)`,
  ].join("\n")

  const wrapperPath = join(tmpdir(), `atomicity_fv_joern_wrapper_${ts}.sc`)
  writeFileSync(wrapperPath, wrapperContent, "utf-8")

  const joernBin = resolveJoernBin("joern", projectRoot)
  const cmd = `${joernBin} --script "${wrapperPath}"`

  let stdout: string
  try {
    stdout = execSync(cmd, {
      stdio: "pipe",
      timeout: 600_000,
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024,
      ...(IS_WINDOWS && { shell: "cmd.exe" }),
    })
  } catch (err: any) {
    throw new Error(`Joern path analysis failed: ${(err.message || String(err)).slice(0, 2000)}`)
  } finally {
    try { unlinkSync(wrapperPath) } catch { /* ignore cleanup errors */ }
    try { unlinkSync(violationsFilePath) } catch { /* ignore cleanup errors */ }
  }

  // Parse JSON from Joern output
  const jsonStart = stdout.indexOf("{")
  const jsonEnd = stdout.lastIndexOf("}")
  if (jsonStart === -1 || jsonEnd === -1) {
    throw new Error("Failed to parse JSON from Joern analyzePathFeasibility output")
  }

  const rawJson = JSON.parse(stdout.substring(jsonStart, jsonEnd + 1))
  const results: Array<{
    id: string
    sub_paths: SubPathResult[]
    state_at_preemption?: PreemptionState
  }> = rawJson.results ?? []

  const resultMap = new Map<string, { sub_paths: SubPathResult[]; state_at_preemption?: PreemptionState }>()
  for (const r of results) {
    resultMap.set(r.id, {
      sub_paths: r.sub_paths,
      state_at_preemption: r.state_at_preemption,
    })
  }
  return resultMap
}

/**
 * Analyze interrupt enable state across the full main-task path leading to
 * and including the preemption window.
 *
 * Protection primitives (e.g. DisableClockIRQ) are typically called BEFORE
 * the first shared-variable access, which places them on sub-path 1
 * (entry → access1).  The preemption window lies between access1 and access2
 * (sub-path 3).  To correctly determine whether interrupts are enabled at the
 * preemption point we must track state changes across BOTH sub-paths:
 *
 *   entry ──[sp1]──→ access1 ──[sp3]──→ access2
 *                         ↑ preemption window starts here
 *
 * Returns { enabled: true } if a preemption window exists (violation feasible),
 * or { enabled: false, reason } if interrupts are disabled throughout the entire
 * preemption window (violation infeasible / protected).
 */
function analyzeInterruptEnabled(
  subPath1: SubPathResult,
  subPath3: SubPathResult,
  preemptionPoint?: PreemptionPoint,
): { enabled: boolean; reason?: string } {
  // Check explicit preemption point flags from violation-detect
  if (preemptionPoint) {
    if (preemptionPoint.in_critical_section) {
      return { enabled: false, reason: "preemption point is inside critical section" }
    }
    if (!preemptionPoint.interrupt_enabled) {
      return { enabled: false, reason: "interrupts explicitly disabled at preemption point" }
    }
  }

  const sp1Changes = (subPath1.interrupt_state_changes ?? []).sort((a, b) => a.line - b.line)
  const sp3Changes = (subPath3.interrupt_state_changes ?? []).sort((a, b) => a.line - b.line)

  if (sp1Changes.length === 0 && sp3Changes.length === 0) {
    // No interrupt state changes on either path → interrupts remain enabled (default)
    return { enabled: true }
  }

  // Phase 1: Determine interrupt state at end of sub-path 1 (= state at access1).
  // Default interrupt state is "enabled" (most embedded systems after init).
  let stateAtAccess1 = true
  for (const change of sp1Changes) {
    if (change.effect === "disable") {
      stateAtAccess1 = false
    } else if (change.effect === "enable") {
      stateAtAccess1 = true
    }
  }

  // Phase 2: Walk sub-path 3 (the preemption window) starting from the state
  // inherited from sub-path 1.  Check if there is ANY segment within the
  // preemption window where interrupts are enabled.
  let currentlyEnabled = stateAtAccess1
  let hasEnabledWindow = stateAtAccess1  // if enabled entering the window, the start is a valid preemption point

  for (const change of sp3Changes) {
    if (change.effect === "disable") {
      currentlyEnabled = false
    } else if (change.effect === "enable") {
      currentlyEnabled = true
      hasEnabledWindow = true
    }
  }

  // After the last change, if still enabled, there's a window at the end too
  if (currentlyEnabled) {
    hasEnabledWindow = true
  }

  if (!hasEnabledWindow) {
    // Find the disable call that caused the state — could be on sp1 or sp3
    const firstDisable = sp1Changes.find((c) => c.effect === "disable")
      ?? sp3Changes.find((c) => c.effect === "disable")
    const disableDesc = firstDisable
      ? `first disable by ${firstDisable.api} at L${firstDisable.line}`
      : "unknown disable source"
    return {
      enabled: false,
      reason: `interrupts disabled throughout preemption window: ${disableDesc}, never re-enabled before end of preemption window`,
    }
  }

  return { enabled: true }
}

// ── Path condition parsing ──

/** Operator mapping from C to SMT-LIB2 */
const C_TO_SMT_OPS: Record<string, string> = {
  "==": "=", "!=": "distinct",
  ">": ">", "<": "<", ">=": ">=", "<=": "<=",
}

/** C comparison operator regex: var op literal  or  literal op var */
const COMPARISON_RE = /^\s*(\w[\w.*>\[\]]*)\s*(==|!=|>=|<=|>|<)\s*(\w[\w.*>\[\]]*)\s*$/

/**
 * Split a compound C condition expression on `&&` / `||` operators into
 * individual sub-conditions.  Handles parenthesised sub-expressions like:
 *   "(control_num == 0) && (flag_control_exec == FALSE)"
 * Returns an array of { expr, connector } where connector is "&&" or "||"
 * indicating how this clause was joined.  The first element always has
 * connector "&&" (treated as the start).
 *
 * If the expression is a simple condition with no logical connectors, returns
 * a single-element array.
 */
function splitCompoundCondition(
  rawExpr: string,
): Array<{ expr: string; connector: "&&" | "||" }> {
  // Strategy: split on && and || that are NOT inside parentheses.
  // We track paren depth to avoid splitting inside nested expressions.
  const parts: Array<{ expr: string; connector: "&&" | "||" }> = []
  let depth = 0
  let current = ""
  let currentConnector: "&&" | "||" = "&&"
  let i = 0

  while (i < rawExpr.length) {
    const ch = rawExpr[i]
    if (ch === "(") {
      depth++
      current += ch
      i++
    } else if (ch === ")") {
      depth--
      current += ch
      i++
    } else if (depth === 0 && rawExpr[i] === "&" && rawExpr[i + 1] === "&") {
      if (current.trim()) {
        parts.push({ expr: current.trim(), connector: currentConnector })
      }
      currentConnector = "&&"
      current = ""
      i += 2
    } else if (depth === 0 && rawExpr[i] === "|" && rawExpr[i + 1] === "|") {
      if (current.trim()) {
        parts.push({ expr: current.trim(), connector: currentConnector })
      }
      currentConnector = "||"
      current = ""
      i += 2
    } else {
      current += ch
      i++
    }
  }
  if (current.trim()) {
    parts.push({ expr: current.trim(), connector: currentConnector })
  }

  // Strip outer parentheses from each part: "(foo == 0)" → "foo == 0"
  return parts.map((p) => ({
    expr: p.expr.replace(/^\((.+)\)$/, "$1").trim(),
    connector: p.connector,
  }))
}

/**
 * Try to translate a (possibly compound) condition expression into SMT
 * assertions.  Returns an array of SMT assertion strings.  Entries that are
 * null indicate opaque sub-conditions.
 *
 * For a compound `&&` branch=true:  each sub-condition is asserted individually.
 * For a compound `&&` branch=false: ¬(A ∧ B) = ¬A ∨ ¬B — we cannot simply
 *   negate each; the whole conjunction must hold, so we treat the full expression
 *   as opaque when branch=false and it contains `||` or `&&` with branch=false.
 */
function tryTranslateCompoundCondition(
  rawExpr: string,
  branch: string,
  declaredVars: Set<string>,
  declarations: string[],
): Array<string | null> {
  const parts = splitCompoundCondition(rawExpr)

  // If no split happened (single condition), fall back to simple translation
  if (parts.length <= 1) {
    return [tryTranslateCondition(parts[0]?.expr ?? rawExpr, branch, declaredVars, declarations)]
  }

  // Compound conditions:
  // branch=true + all connectors "&&":  assert each sub-condition individually
  // branch=false + all connectors "&&": ¬(A∧B∧C) = ¬A∨¬B∨¬C — too complex, treat as opaque
  // branch=true + some "||": A||B = disjunction, only one must hold — too complex, treat as opaque
  // branch=false + all "||": ¬(A||B||C) = ¬A∧¬B∧¬C — can negate each
  const allAnd = parts.every((p) => p.connector === "&&")
  const allOr = parts.slice(1).every((p) => p.connector === "||")

  if (branch === "true" && allAnd) {
    // Each sub-condition must be true → assert each
    return parts.map((p) =>
      tryTranslateCondition(p.expr, "true", declaredVars, declarations),
    )
  }

  if (branch === "false" && allOr) {
    // ¬(A||B||C) = ¬A ∧ ¬B ∧ ¬C → negate each
    return parts.map((p) =>
      tryTranslateCondition(p.expr, "false", declaredVars, declarations),
    )
  }

  // Other cases (mixed connectors, false+&&, true+||): treat entire expr as opaque
  return [null]
}

/**
 * Sanitize a C identifier or expression into a valid SMT-LIB2 symbol name.
 * Replaces non-alphanumeric chars with underscores.
 */
function toSmtSymbol(cIdent: string): string {
  return cIdent.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^(\d)/, "v_$1")
}

/**
 * Try to parse a simple integer literal (decimal, hex, or named constant).
 * Returns the integer value or null if not a simple literal.
 */
function tryParseIntLiteral(token: string): number | null {
  // Decimal
  if (/^-?\d+[UuLl]*$/.test(token)) return parseInt(token, 10)
  // Hex
  if (/^0[xX][0-9a-fA-F]+[UuLl]*$/.test(token)) return parseInt(token, 16)
  // Common named constants
  const named: Record<string, number> = {
    "NULL": 0, "nullptr": 0, "TRUE": 1, "true": 1, "FALSE": 0, "false": 0,
  }
  if (token in named) return named[token]
  return null
}

/**
 * Attempt to translate a C condition expression into an SMT-LIB2 assertion.
 * Returns the assertion string if parseable, or null for opaque conditions.
 *
 * For conditions that reference the same variable across sub-paths, we use
 * a shared SMT symbol, creating cross-path coupling.
 *
 * @param declaredVars Set of already-declared SMT variable names (mutated)
 * @param declarations Array to push new declarations into (mutated)
 */
function tryTranslateCondition(
  expr: string,
  branch: string,
  declaredVars: Set<string>,
  declarations: string[],
): string | null {
  const match = COMPARISON_RE.exec(expr)
  if (!match) return null

  const [, lhs, op, rhs] = match
  const smtOp = C_TO_SMT_OPS[op]
  if (!smtOp) return null

  const lhsLit = tryParseIntLiteral(lhs)
  const rhsLit = tryParseIntLiteral(rhs)

  // We need at least one side to be a variable
  if (lhsLit !== null && rhsLit !== null) {
    // Both literals: evaluate statically
    const result = evalComparison(lhsLit, op, rhsLit)
    const pathNeedsBranch = branch === "true" ? result : !result
    return pathNeedsBranch ? null : "(assert false)" // infeasible if contradicts
  }

  // Build the SMT comparison
  let smtLhs: string
  let smtRhs: string

  if (lhsLit !== null) {
    smtLhs = String(lhsLit)
    smtRhs = toSmtSymbol(rhs)
    if (!declaredVars.has(smtRhs)) {
      declarations.push(`(declare-const ${smtRhs} Int)`)
      declaredVars.add(smtRhs)
    }
  } else if (rhsLit !== null) {
    smtLhs = toSmtSymbol(lhs)
    smtRhs = String(rhsLit)
    if (!declaredVars.has(smtLhs)) {
      declarations.push(`(declare-const ${smtLhs} Int)`)
      declaredVars.add(smtLhs)
    }
  } else {
    // Both are variables — still useful for cross-path coupling
    smtLhs = toSmtSymbol(lhs)
    smtRhs = toSmtSymbol(rhs)
    if (!declaredVars.has(smtLhs)) {
      declarations.push(`(declare-const ${smtLhs} Int)`)
      declaredVars.add(smtLhs)
    }
    if (!declaredVars.has(smtRhs)) {
      declarations.push(`(declare-const ${smtRhs} Int)`)
      declaredVars.add(smtRhs)
    }
  }

  const comparison = `(${smtOp} ${smtLhs} ${smtRhs})`
  if (branch === "true") {
    return `(assert ${comparison})`
  } else {
    return `(assert (not ${comparison}))`
  }
}

function evalComparison(lhs: number, op: string, rhs: number): boolean {
  switch (op) {
    case "==": return lhs === rhs
    case "!=": return lhs !== rhs
    case ">":  return lhs > rhs
    case "<":  return lhs < rhs
    case ">=": return lhs >= rhs
    case "<=": return lhs <= rhs
    default: return true
  }
}

/**
 * Encode a path assignment (variable = value) as an SMT assertion.
 * Only encodes constant assignments and simple variable-to-variable assignments.
 * Complex expressions are emitted as comments (conservative: no constraint added).
 */
function encodeAssignment(
  assign: PathAssignment,
  declaredVars: Set<string>,
  declarations: string[],
  lines: string[],
): void {
  const varSmt = toSmtSymbol(assign.variable)

  if (assign.is_constant) {
    const intVal = tryParseIntLiteral(assign.value)
    if (intVal !== null) {
      if (!declaredVars.has(varSmt)) {
        declarations.push(`(declare-const ${varSmt} Int)`)
        declaredVars.add(varSmt)
      }
      lines.push(`; assignment L${assign.line}: ${assign.variable} = ${assign.value}`)
      lines.push(`(assert (= ${varSmt} ${intVal}))`)
      return
    }
  }

  // Variable-to-variable assignment: x = y
  if (/^\w+$/.test(assign.value) && !assign.is_constant) {
    const rhsSmt = toSmtSymbol(assign.value)
    if (!declaredVars.has(varSmt)) {
      declarations.push(`(declare-const ${varSmt} Int)`)
      declaredVars.add(varSmt)
    }
    if (!declaredVars.has(rhsSmt)) {
      declarations.push(`(declare-const ${rhsSmt} Int)`)
      declaredVars.add(rhsSmt)
    }
    lines.push(`; assignment L${assign.line}: ${assign.variable} = ${assign.value}`)
    lines.push(`(assert (= ${varSmt} ${rhsSmt}))`)
    return
  }

  // Complex expression — emit as comment only (conservative)
  lines.push(`; opaque assignment L${assign.line}: ${assign.variable} = ${assign.value}`)
}

// NOTE: The old extractImplicitPreconditions() heuristic has been REMOVED.
// It was replaced by Joern AST-derived state_at_preemption which includes:
// - enclosing_conditions: from AST ancestor walk (getEnclosingConditions in Scala)
// - short_circuit_constraints: from AST logicalAnd chain (getShortCircuitConstraints in Scala)
// This is path-sensitive and AST-structural, not regex-based on source text.

// ── SMT-LIB2 encoding ──

/**
 * Encode a single violation candidate as an SMT-LIB2 formula with path analysis.
 *
 * The encoding models:
 * 1. Sub-path reachability: each of the 3 sub-paths must be CFG-reachable
 * 2. Path conditions: branch conditions translated to SMT integer constraints
 *    where possible (simple comparisons), with cross-path variable coupling
 * 3. Path assignments: variable assignments along sub-paths (constant and var-to-var)
 * 4. Enclosing conditions: conditions from if/while bodies containing access nodes
 * 5. Short-circuit constraints: && sub-conditions preceding the second read (from AST)
 * 6. Opaque conditions: unparseable expressions become free Bool variables
 * 7. Interrupt enable: flow-sensitive interrupt state along the preemption window
 * 8. ISR preemption: ISR must occur between the two main accesses
 * 9. Variable value change: ISR must write at least one correlated variable
 */
function encodeViolationAsSmt(
  violation: ViolationInput,
  pathAnalysis: PathAnalysisResult | undefined,
  criticalSectionApis: Set<string>,
): string {
  const lines: string[] = []
  lines.push("; Atomicity violation feasibility check (enhanced with path analysis)")
  lines.push(`; Violation: ${violation.id} Pattern: ${violation.pattern}`)
  lines.push(`; Variables: ${violation.variables.join(", ")}`)
  lines.push("")
  lines.push("(set-logic QF_LIA)")
  lines.push("")

  // Shared state for cross-path variable coupling
  const declaredVars = new Set<string>()
  const varDeclarations: string[] = []
  let opaqueCounter = 0

  /**
   * Encode conditions for a sub-path.
   * Compound conditions (e.g. `A && B`) are split into individual sub-conditions.
   * Translatable conditions become integer constraints with shared variables.
   * Opaque conditions become free Bool variables (unconstrained = may be true or false).
   */
  function encodeSubPathConditions(
    spLabel: string,
    conditions: Array<unknown>,
  ) {
    for (const rawCond of conditions) {
      const cond = rawCond as Record<string, unknown>
      const expr = (cond.expression ?? String(rawCond)) as string
      const branch = (cond.branch ?? "true") as string
      const condLine = (cond.line ?? -1) as number

      // Try to translate (possibly compound) condition to SMT constraints
      const smtAssertions = tryTranslateCompoundCondition(
        expr, branch, declaredVars, varDeclarations,
      )

      // Sanitize multi-line expressions in comments: ensure every line starts with ";"
      const safeComment = (text: string) =>
        text.replace(/\n/g, "\n; ")

      // Track whether we emitted the top-level comment already
      let headerEmitted = false
      for (const smtAssertion of smtAssertions) {
        if (smtAssertion) {
          if (!headerEmitted) {
            lines.push(`; ${spLabel} L${condLine}: ${safeComment(expr)} [${branch}]`)
            headerEmitted = true
          }
          lines.push(smtAssertion)
        } else {
          // Opaque sub-condition — declare as free Bool (not asserted true or false)
          // This means Z3 can choose either value, which is sound:
          // if all opaque conditions being true still leads to UNSAT, the
          // violation is truly infeasible; if SAT, it's feasible under some
          // assignment of opaque conditions.
          opaqueCounter++
          const boolName = `opaque_${opaqueCounter}`
          if (!headerEmitted) {
            lines.push(`; ${spLabel} L${condLine}: ${safeComment(expr)} [${branch}] (partial opaque)`)
            headerEmitted = true
          }
          lines.push(`(declare-const ${boolName} Bool)`)
        }
      }
    }
  }

  // ── Sub-path reachability + condition constraints ──

  if (pathAnalysis) {
    const { sub_path_1: sp1, sub_path_2: sp2, sub_path_3: sp3 } = pathAnalysis

    // ── Helper to detect and filter loop-contradicted assignments ──
    // In a for-loop like `for(i=0; i<17; i++)`, the BFS path collector
    // picks up both the init assignment `i=0` AND the exit condition
    // `i<17 [false]` (i.e. i>=17). These contradict each other because
    // the assignment represents the pre-loop state while the condition
    // represents the post-loop state. We detect such pairs and skip the
    // assignment, treating the variable as unconstrained at the condition
    // check point.
    function filterLoopConflictedAssignments(
      assignments: PathAssignment[],
      conditions: PathCondition[],
    ): PathAssignment[] {
      if (assignments.length === 0 || conditions.length === 0) return assignments

      // For each constant assignment, check if a later condition on the same
      // variable would contradict the assigned value.
      // e.g., assign i=0 at L154, condition i<17 [false] at L154
      //   -> condition requires i>=17, but assignment says i=0 → contradiction
      //   -> skip the assignment (it's a loop init, not the value at loop exit)

      return assignments.filter((assign) => {
        if (!assign.is_constant) return true
        const intVal = tryParseIntLiteral(assign.value)
        if (intVal === null) return true

        // Check if any condition on the same variable at the SAME LINE would
        // contradict this value. The same-line constraint ensures we only
        // handle the for-loop init/exit pattern (where Joern attributes both
        // the init assignment and the loop condition to the for-statement line),
        // and do NOT falsely remove unrelated earlier assignments that happen
        // to contradict a later conditional branch.
        for (const cond of conditions) {
          const expr = cond.expression ?? ""
          const branch = cond.branch ?? "true"
          const condLine = cond.line ?? -1

          // Structural guard: only consider conditions on the same line as the
          // assignment. In C for-loops, Joern reports both `i=0` and `i<17`
          // at the for-statement line. For separate `int i = 0;` on line X
          // and `if (i < 17)` on line Y, the lines differ → no conflict.
          if (condLine !== assign.line) continue

          const match = COMPARISON_RE.exec(expr)
          if (!match) continue
          const [, lhs, op, rhs] = match
          const lhsLit = tryParseIntLiteral(lhs)
          const rhsLit = tryParseIntLiteral(rhs)
          // Identify which side is the same variable as the assignment
          let condOp = op
          let condLit: number | null = null
          if (lhs === assign.variable && rhsLit !== null) {
            condLit = rhsLit
          } else if (rhs === assign.variable && lhsLit !== null) {
            // Flip: "17 > i" → "i < 17"
            condLit = lhsLit
            const flipMap: Record<string, string> = { ">": "<", "<": ">", ">=": "<=", "<=": ">=", "==": "==", "!=": "!=" }
            condOp = flipMap[op] ?? op
          }
          if (condLit === null) continue

          // Evaluate: does the assigned value satisfy the condition's branch?
          const condResult = evalComparison(intVal, condOp, condLit)
          const branchExpectsTrue = branch === "true"
          if (condResult !== branchExpectsTrue) {
            // The assigned value would make the condition fail on the required branch.
            // This is a for-loop init vs loop-exit contradiction. Skip the assignment.
            lines.push(`; SKIPPED loop-conflicted assignment L${assign.line}: ${assign.variable} = ${assign.value}`)
            lines.push(`; (contradicts condition "${expr}" [${branch}] at L${condLine})`)
            return false
          }
        }
        return true
      })
    }

    // ── Helper to encode a sub-path's conditions, assignments, and enclosing conditions ──
    function encodeSubPath(
      label: string,
      sp: SubPathResult,
    ): void {
      if (!sp.reachable) {
        lines.push(`; NOT reachable: ${sp.reason ?? "no CFG path found"}`)
        lines.push("(assert false)")
        lines.push("")
        return
      }
      lines.push(`; Reachable (path_length=${sp.path_length})`)
      if (sp.via_calls && sp.via_calls.length > 0) {
        lines.push(`; Via calls: ${sp.via_calls.join(", ")}`)
      }

      // Branch conditions collected along the BFS path
      encodeSubPathConditions(label, sp.conditions ?? [])

      // Assignments collected along the BFS path — filter out loop-contradicted ones
      const rawAssignments = sp.assignments ?? []
      const spAssignments = filterLoopConflictedAssignments(rawAssignments, sp.conditions ?? [])
      if (spAssignments.length > 0) {
        lines.push(`; ${label} path assignments (${spAssignments.length}):`)
        for (const assign of spAssignments) {
          encodeAssignment(assign, declaredVars, varDeclarations, lines)
        }
      }

      // Enclosing conditions of the target node (from AST ancestor walk)
      const enclosing = sp.enclosing_conditions ?? []
      if (enclosing.length > 0) {
        lines.push(`; ${label} enclosing conditions (node is inside these if/while bodies):`)
        encodeSubPathConditions(`${label}_ENCL`, enclosing)
      }

      // Inter-procedural caller-side conditions (from call chain analysis)
      const callerConds = sp.caller_conditions ?? []
      if (callerConds.length > 0) {
        const chain = sp.call_chain ?? []
        lines.push(`; ${label} caller conditions (call chain: ${chain.join(" -> ")}):`)
        if (sp.has_multiple_call_sites) {
          lines.push(`; WARNING: target function has multiple call sites; only first call site analyzed.`)
          lines.push(`; Constraints from other call sites are not included — result may be incomplete.`)
        }
        encodeSubPathConditions(`${label}_CALLER`, callerConds)
      }

      const callerAssigns = sp.caller_assignments ?? []
      if (callerAssigns.length > 0) {
        lines.push(`; ${label} caller assignments (${callerAssigns.length}):`)
        for (const assign of callerAssigns) {
          encodeAssignment(assign, declaredVars, varDeclarations, lines)
        }
      }

      const callerEnclosing = sp.caller_enclosing_conditions ?? []
      if (callerEnclosing.length > 0) {
        lines.push(`; ${label} caller enclosing conditions (call site inside these if/while bodies):`)
        encodeSubPathConditions(`${label}_CALLER_ENCL`, callerEnclosing)
      }

      lines.push("")
    }

    // Sub-path 1: entry → first main access
    lines.push("; ── Sub-path 1: Entry → MainAccess1 ──")
    encodeSubPath("SP1", sp1)

    // Sub-path 2: ISR entry → ISR accesses
    lines.push("; ── Sub-path 2: ISR Entry → ISR Accesses ──")
    encodeSubPath("SP2", sp2)

    // Sub-path 3: first main access → second main access (preemption window)
    lines.push("; ── Sub-path 3: MainAccess1 → MainAccess2 (preemption window) ──")
    encodeSubPath("SP3", sp3)
    // Additional: interrupt state changes on the preemption window
    if (sp3.reachable && sp3.interrupt_state_changes.length > 0) {
      lines.push("; Interrupt state changes on preemption window path:")
      for (const change of sp3.interrupt_state_changes) {
        lines.push(`; L${change.line}: ${change.api} -> ${change.effect}`)
      }
      lines.push("")
    }

    // ── State at preemption point (from Joern AST analysis) ──
    // Models the global variable state when the ISR fires between main_access1
    // and main_access2.  This replaces the old heuristic extractImplicitPreconditions().
    const ps = pathAnalysis.state_at_preemption
    if (ps) {
      const hasAny = (ps.active_conditions?.length ?? 0) > 0 ||
        (ps.active_assignments?.length ?? 0) > 0 ||
        (ps.enclosing_conditions?.length ?? 0) > 0 ||
        (ps.short_circuit_constraints?.length ?? 0) > 0

      if (hasAny) {
        lines.push("; ── State at preemption point (Joern AST-derived) ──")
        lines.push("; These constraints model the global state when ISR fires.")
        lines.push("; ISR inherits variable values from the main task at this point.")

        // Active conditions from SP1 path
        if (ps.active_conditions && ps.active_conditions.length > 0) {
          lines.push("; SP1 path conditions (already decided before preemption):")
          encodeSubPathConditions("PREEMPT_PATH", ps.active_conditions)
        }

        // Assignments along SP1 path (variable values at preemption point)
        // Filter out loop-conflicted assignments (same as in encodeSubPath)
        if (ps.active_assignments && ps.active_assignments.length > 0) {
          const filteredPreemptAssigns = filterLoopConflictedAssignments(
            ps.active_assignments, ps.active_conditions ?? [],
          )
          if (filteredPreemptAssigns.length > 0) {
            lines.push(`; SP1 path assignments (${filteredPreemptAssigns.length} — values at preemption):`)
            for (const assign of filteredPreemptAssigns) {
              encodeAssignment(assign, declaredVars, varDeclarations, lines)
            }
          }
        }

        // Enclosing conditions of access1 (from AST ancestor walk)
        if (ps.enclosing_conditions && ps.enclosing_conditions.length > 0) {
          lines.push("; Access1 enclosing conditions (node inside these if/while bodies):")
          encodeSubPathConditions("PREEMPT_ENCL", ps.enclosing_conditions)
        }

        // Short-circuit && constraints (from AST logicalAnd chain analysis)
        if (ps.short_circuit_constraints && ps.short_circuit_constraints.length > 0) {
          lines.push("; Short-circuit && constraints (sub-conditions already true at preemption):")
          lines.push("; Derived from AST structure of logicalAnd chain, NOT regex on source text.")
          encodeSubPathConditions("PREEMPT_SC", ps.short_circuit_constraints)
        }

        // Inter-procedural caller-side conditions at preemption point
        if (ps.caller_conditions && ps.caller_conditions.length > 0) {
          lines.push("; Caller conditions at preemption (from inter-procedural call chain):")
          encodeSubPathConditions("PREEMPT_CALLER", ps.caller_conditions)
        }

        if (ps.caller_assignments && ps.caller_assignments.length > 0) {
          lines.push(`; Caller assignments at preemption (${ps.caller_assignments.length}):`)
          for (const assign of ps.caller_assignments) {
            encodeAssignment(assign, declaredVars, varDeclarations, lines)
          }
        }

        if (ps.caller_enclosing_conditions && ps.caller_enclosing_conditions.length > 0) {
          lines.push("; Caller enclosing conditions at preemption (call site inside if/while):")
          encodeSubPathConditions("PREEMPT_CALLER_ENCL", ps.caller_enclosing_conditions)
        }

        lines.push("")
      }
    }

    // Interrupt enable constraint
    lines.push("; ── Interrupt enable state ──")
    if (!pathAnalysis.interrupt_enabled) {
      lines.push(`; Interrupts DISABLED: ${pathAnalysis.infeasibility_reason}`)
      lines.push("(assert false)")
    } else {
      lines.push("; Interrupts enabled — preemption window exists")
    }
    lines.push("")
  } else {
    // Fallback: no path analysis, use legacy checks
    lines.push("; ── Legacy mode (no Joern path analysis) ──")
    const pp = violation.preemption_point
    if (pp) {
      if (pp.in_critical_section) {
        lines.push("; Preemption point is inside critical section — infeasible")
        lines.push("(assert false)")
      }
      if (!pp.interrupt_enabled) {
        lines.push("; Interrupts disabled at preemption point — infeasible")
        lines.push("(assert false)")
      }
    }
    lines.push("")
  }

  // Insert variable declarations before assertions
  // (SMT-LIB2 requires declarations before use, so we insert them at the top)
  if (varDeclarations.length > 0) {
    // Insert after the (set-logic ...) line
    const insertIdx = lines.indexOf("(set-logic QF_LIA)") + 2
    lines.splice(insertIdx, 0,
      "; ── Shared program variable declarations ──",
      ...varDeclarations,
      "",
    )
  }

  // ── Timeline ordering ──
  lines.push("; ── Timeline ordering ──")
  const mainAccesses = violation.main_accesses
  for (let i = 0; i < mainAccesses.length; i++) {
    lines.push(`(declare-const t_main_${i} Int)`)
  }
  lines.push("(declare-const t_isr Int)")
  lines.push("")

  for (let i = 0; i < mainAccesses.length; i++) {
    lines.push(`(assert (= t_main_${i} ${i * 2}))`) // abstract ordinals with gaps for ISR
  }
  for (let i = 1; i < mainAccesses.length; i++) {
    lines.push(`(assert (< t_main_${i - 1} t_main_${i}))`)
  }
  if (mainAccesses.length >= 2) {
    lines.push(`(assert (> t_isr t_main_0))`)
    lines.push(`(assert (< t_isr t_main_${mainAccesses.length - 1}))`)
  }
  lines.push("")

  // ── Critical section API check ──
  for (const access of mainAccesses) {
    const code = access.location.code ?? ""
    for (const api of criticalSectionApis) {
      if (code.includes(api)) {
        lines.push(`; Main access at L${access.location.line} involves critical section API: ${api}`)
      }
    }
  }

  // ── ISR access constraint (defensive) ──
  // Tool B guarantees ISR-side access types match the pattern:
  //   DFC_RWWR/TUP_WWWW/DAC_RWWW/DAC_RWWR → ISR side is WRITE+WRITE
  //   TUP_WRRW → ISR side is READ+READ (no write constraint needed)
  // The previous isr_changes_* Bool variables were unconstrained free variables
  // whose (assert (or ...)) was always satisfiable — they added zero constraint
  // power to the SMT formula. Removed for clarity; only a defensive check remains.
  lines.push("; ── ISR access constraint (defensive) ──")
  const isTupWR = violation.pattern === "TUP_WRRW"
  if (isTupWR) {
    lines.push("; TUP_WRRW pattern: ISR reads inconsistent state — no write constraint needed")
  } else {
    const isrWrites = violation.interrupt_accesses.filter(
      (ia) => ia.access.access_type === "WRITE",
    )
    if (isrWrites.length === 0) {
      // Should never happen: Tool B guarantees WRITE pairs for non-WR patterns.
      // If reached, indicates a data inconsistency upstream.
      lines.push("; DEFENSIVE: No ISR writes found — Tool B data inconsistency")
      lines.push("(assert false)")
    } else {
      lines.push(`; ISR has ${isrWrites.length} write access(es) — guaranteed by pattern matching, no SMT constraint needed`)
    }
  }

  lines.push("")
  lines.push("(check-sat)")
  lines.push("(exit)")

  return lines.join("\n")
}

/**
 * Run Z3 on an SMT-LIB2 file and return "sat", "unsat", or "unknown".
 */
function runZ3(smtContent: string, z3Bin: string): "sat" | "unsat" | "unknown" {
  const smtPath = join(tmpdir(), `atomicity_fv_z3_${Date.now()}.smt2`)
  writeFileSync(smtPath, smtContent, "utf-8")

  try {
    const cmd = `${z3Bin} "${smtPath}"`
    const stdout = execSync(cmd, {
      stdio: "pipe",
      timeout: 30_000,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      ...(IS_WINDOWS && { shell: "cmd.exe" }),
    })

    const result = stdout.trim().toLowerCase()
    if (result.includes("unsat")) return "unsat"
    if (result.includes("sat")) return "sat" // must check after unsat
    return "unknown"
  } catch (err: any) {
    // Z3 may exit with non-zero code due to comment parsing warnings,
    // but still output a valid sat/unsat result in stdout.
    const stdout = (err.stdout ?? "").toString().trim().toLowerCase()
    if (stdout.includes("unsat")) return "unsat"
    if (stdout.includes("sat")) return "sat"
    return "unknown"
  } finally {
    try { unlinkSync(smtPath) } catch { /* ignore cleanup errors */ }
  }
}

// ── Markdown report generation ──

function generateVerifiedViolationsMd(
  violations: VerifiedViolation[],
  summary: { total: number; confirmed: number; infeasible: number; unknown: number; path_analysis_available: boolean; infeasible_by_path: number },
  message: string,
): string {
  const lines: string[] = []
  lines.push("# 原子性违反检测结果 — 可行性验证")
  lines.push("")
  lines.push(`**日期**: ${new Date().toISOString().split("T")[0]}`)
  lines.push("")

  // Summary
  lines.push("## 概览")
  lines.push("")
  lines.push("| 指标 | 值 |")
  lines.push("|------|------|")
  lines.push(`| 候选总数 | ${summary.total} |`)
  lines.push(`| CONFIRMED (critical) | ${summary.confirmed} |`)
  lines.push(`| INFEASIBLE (info) | ${summary.infeasible} |`)
  lines.push(`| UNKNOWN (major) | ${summary.unknown} |`)
  lines.push(`| 路径分析可用 | ${summary.path_analysis_available ? "是" : "否"} |`)
  if (summary.path_analysis_available) {
    lines.push(`| 路径分析排除数 | ${summary.infeasible_by_path} |`)
  }
  lines.push("")
  lines.push(`> ${message}`)
  lines.push("")

  // By pattern
  lines.push("## 按模式分布")
  lines.push("")
  lines.push("| 模式 | CONFIRMED | INFEASIBLE | UNKNOWN | 合计 |")
  lines.push("|------|-----------|------------|---------|------|")
  for (const p of ["DFC_RWWR", "TUP_WRRW", "TUP_WWWW", "DAC_RWWW", "DAC_RWWR"]) {
    const pv = violations.filter((v) => v.pattern === p)
    const conf = pv.filter((v) => v.feasibility === "CONFIRMED").length
    const inf = pv.filter((v) => v.feasibility === "INFEASIBLE").length
    const unk = pv.filter((v) => v.feasibility === "UNKNOWN").length
    if (pv.length > 0) {
      lines.push(`| ${p} | ${conf} | ${inf} | ${unk} | ${pv.length} |`)
    }
  }
  lines.push(`| **合计** | **${summary.confirmed}** | **${summary.infeasible}** | **${summary.unknown}** | **${summary.total}** |`)
  lines.push("")

  // Detailed results — CONFIRMED first, then UNKNOWN/UNCHECKED (skip INFEASIBLE)
  const reportable = violations.filter((v) => v.feasibility !== "INFEASIBLE")
  const sorted = [...reportable].sort((a, b) => {
    const order: Record<string, number> = { "CONFIRMED": 0, "UNKNOWN": 1, "UNCHECKED": 2 }
    return (order[a.feasibility] ?? 3) - (order[b.feasibility] ?? 3)
  })

  lines.push("## 缺陷详情")
  lines.push("")
  if (sorted.length === 0) {
    lines.push("> 无 CONFIRMED、UNKNOWN 或 UNCHECKED 违反。所有候选均被排除 (INFEASIBLE)。")
  } else {
    lines.push(`> 共 ${sorted.length} 个（CONFIRMED + UNKNOWN + UNCHECKED），按严重度排序。最多展示前 30 个。`)
    lines.push("")
    const display = sorted.slice(0, 30)
    for (const v of display) {
      const severity = v.feasibility === "CONFIRMED" ? "🔴 critical" : "🟡 major"
      lines.push(`### ${v.id}: ${v.pattern} — ${v.feasibility}`)
      lines.push("")
      lines.push(`- **严重度**: ${severity}`)
      lines.push(`- **关联组**: ${v.correlated_group_id}`)
      lines.push(`- **变量**: \`${v.variables.join("`, `")}\``)
      lines.push(`- **描述**: ${v.description}`)
      lines.push("")

      // 4-access interleaving table
      lines.push("**4次访问交错序列**:")
      lines.push("")
      lines.push("| # | 上下文 | 变量 | 访问类型 | 文件 | 行号 | 代码 |")
      lines.push("|---|--------|------|---------|------|------|------|")
      const ma1 = v.main_accesses?.[0]
      if (ma1) {
        const f1 = ma1.location.file_path.split(/[\\/]/).pop() ?? ""
        lines.push(`| 1 | 低优先级 | \`${ma1.variable_name}\` | ${ma1.access_type} | ${f1} | ${ma1.location.line} | \`${ma1.location.code.slice(0, 60)}\` |`)
      }
      for (let i = 0; i < (v.interrupt_accesses?.length ?? 0); i++) {
        const ia = v.interrupt_accesses[i]
        const fh = ia.access.location.file_path.split(/[\\/]/).pop() ?? ""
        lines.push(`| ${i + 2} | **${ia.isr_name}** | \`${ia.access.variable_name}\` | ${ia.access.access_type} | ${fh} | ${ia.access.location.line} | \`${ia.access.location.code.slice(0, 60)}\` |`)
      }
      const ma2 = v.main_accesses?.[1]
      if (ma2) {
        const f2 = ma2.location.file_path.split(/[\\/]/).pop() ?? ""
        lines.push(`| ${(v.interrupt_accesses?.length ?? 0) + 2} | 低优先级 | \`${ma2.variable_name}\` | ${ma2.access_type} | ${f2} | ${ma2.location.line} | \`${ma2.location.code.slice(0, 60)}\` |`)
      }

      // Path analysis info
      if (v.path_analysis) {
        lines.push("")
        lines.push("**路径分析**:")
        const pa = v.path_analysis
        lines.push(`- Sub-path 1 (入口→访问1): ${pa.sub_path_1.reachable ? "✅ 可达" : "❌ 不可达"}`)
        lines.push(`- Sub-path 2 (ISR内部): ${pa.sub_path_2.reachable ? "✅ 可达" : "❌ 不可达"}`)
        lines.push(`- Sub-path 3 (访问1→访问2): ${pa.sub_path_3.reachable ? "✅ 可达" : "❌ 不可达"}`)
        lines.push(`- 中断使能: ${pa.interrupt_enabled ? "✅ 是" : "❌ 否"}`)
        // Inter-procedural call chain info
        const sp1Chain = pa.sub_path_1.call_chain ?? []
        const sp2Chain = pa.sub_path_2.call_chain ?? []
        if (sp1Chain.length > 1) {
          lines.push(`- SP1 调用链: ${sp1Chain.join(" → ")} (调用者条件: ${pa.sub_path_1.caller_conditions?.length ?? 0})`)
        }
        if (sp2Chain.length > 1) {
          lines.push(`- SP2 调用链: ${sp2Chain.join(" → ")} (调用者条件: ${pa.sub_path_2.caller_conditions?.length ?? 0})`)
        }
      }
      lines.push("")
    }
  }

  return lines.join("\n")
}

// ── Tool definition ──

/**
 * multivar_feasibility_verify — Verify feasibility of atomicity violation candidates
 * using Joern CFG path analysis and Z3 SMT solver.
 */
export const multivarFeasibilityVerify: ToolDefinition = tool({
  description:
    "Verify the feasibility of detected atomicity violation candidates using Joern CPG " +
    "path analysis and Z3 SMT solver. Decomposes each violation into 3 sub-paths " +
    "(entry→access1, ISR_entry→ISR_accesses, access1→access2), verifies CFG reachability, " +
    "performs flow-sensitive interrupt enable analysis, then encodes remaining candidates " +
    "as SMT-LIB2 constraints for Z3 solving. Returns each violation with updated " +
    "feasibility status: CONFIRMED (sat), INFEASIBLE (unsat), or UNKNOWN. " +
    "Use violations_path to read violations from a file (RECOMMENDED for large datasets).",
  args: {
    violations_path: tool.schema
      .string()
      .optional()
      .describe(
        "Path to the candidates.json file produced by multivar_violation_detect " +
        "(e.g., '.matrix/data/multivar-candidates.json'). " +
        "RECOMMENDED: Use this instead of the violations parameter — it avoids passing " +
        "large JSON through the LLM context. The tool reads violations directly from the file.",
      ),
    violations: tool.schema
      .string()
      .optional()
      .describe(
        "JSON string of atomicity violations to verify " +
        "(the violations array from multivar_violation_detect output). " +
        "Only use this for small datasets. For normal use, prefer violations_path.",
      ),
    cpg_path: tool.schema
      .string()
      .optional()
      .describe(
        "Absolute path to the Joern CPG binary file (from multivar_cpg_create output). " +
        "Required for enhanced path analysis. If not provided, falls back to legacy mode.",
      ),
    project_name: tool.schema
      .string()
      .optional()
      .describe(
        "Project name used when the CPG was created. Required when cpg_path is provided.",
      ),
    critical_section_apis: tool.schema
      .string()
      .optional()
      .describe(
        "JSON array of critical section API function names " +
        "(e.g., EnterCriticalSection, taskENTER_CRITICAL, __disable_irq)." +
        " Used to detect protection around access sequences.",
      ),
    interrupt_apis: tool.schema
      .string()
      .optional()
      .describe(
        "JSON array of interrupt enable/disable API function names " +
        '(e.g., ["__disable_irq", "__enable_irq", "EA"]). ' +
        "Merged with built-in defaults for flow-sensitive interrupt state tracking.",
      ),
    output_path: tool.schema
      .string()
      .optional()
      .describe(
        "Path to write the verified violations result JSON file " +
        "(e.g., '.matrix/data/multivar-violations.json'). " +
        "RECOMMENDED: The result can be very large — writing to a file avoids flooding the LLM context. " +
        "When specified, the tool returns only a compact summary; the full result is in the file.",
      ),
    md_output_path: tool.schema
      .string()
      .optional()
      .describe(
        "Absolute path to write a Markdown summary of verified violations. " +
        "Recommended: '.matrix/reports/multivar-violations.md'.",
      ),
    init_functions: tool.schema
      .string()
      .optional()
      .describe(
        "JSON array of function names that execute during the initialization phase " +
        "BEFORE interrupts are enabled (e.g., '[\"CPUInitial\", \"SystemInit\", \"HardwareSetup\"]'). " +
        "Violations where ALL main-context accesses occur within these functions are marked " +
        "INFEASIBLE because no ISR can preempt during init phase. " +
        "The agent determines this list by tracing main()'s call sequence before the first " +
        "interrupt-enable call (e.g., enable_isr(), EA=1, __enable_irq()).",
      ),
  },
  async execute({ violations_path, violations, cpg_path, project_name, critical_section_apis, interrupt_apis, output_path, md_output_path, init_functions }) {
    let violationList: ViolationInput[]
    let csApis: string[]
    let intApis: string[]

    // ── Load violations from file path (preferred) or inline JSON ──
    let rawViolationsJson: string | undefined
    if (violations_path) {
      if (!existsSync(violations_path)) {
        return JSON.stringify({
          status: "error",
          error: `Violations file not found: ${violations_path}`,
        })
      }
      rawViolationsJson = readFileSync(violations_path, "utf-8")
    } else if (violations) {
      rawViolationsJson = violations
    } else {
      return JSON.stringify({
        status: "error",
        error: "Either violations_path or violations must be provided.",
      })
    }

    try {
      const parsed = JSON.parse(rawViolationsJson)
      // Support both the full output object (with .violations key) and a raw array
      if (Array.isArray(parsed)) {
        violationList = parsed
      } else if (parsed.violations && Array.isArray(parsed.violations)) {
        violationList = parsed.violations
      } else {
        return JSON.stringify({
          status: "error",
          error: "violations JSON must be an array or an object with a 'violations' array field.",
        })
      }
    } catch {
      return JSON.stringify({
        status: "error",
        error: "Invalid JSON in violations parameter or file",
      })
    }

    try {
      csApis = critical_section_apis ? JSON.parse(critical_section_apis) : []
    } catch {
      csApis = []
    }

    try {
      intApis = interrupt_apis ? JSON.parse(interrupt_apis) : []
    } catch {
      intApis = []
    }

    // Parse init-phase functions (execute before interrupts are enabled)
    let initFuncSet: Set<string>
    try {
      const initFuncs: string[] = init_functions ? JSON.parse(init_functions) : []
      initFuncSet = new Set(initFuncs)
    } catch {
      initFuncSet = new Set()
    }

    const csApiSet = new Set(csApis)

    if (violationList.length === 0) {
      return JSON.stringify({
        status: "success",
        violations: [],
        summary: { total: 0, confirmed: 0, infeasible: 0, unknown: 0 },
        message: "No violations to verify.",
      })
    }

    // ── Phase 1: Joern path analysis (if CPG available) ──
    let pathResults: Map<string, { sub_paths: SubPathResult[]; state_at_preemption?: PreemptionState }> | null = null
    let joernAvailable = false

    const projectRoot = cpg_path ? findMatrixRoot(dirname(cpg_path)) : null

    if (cpg_path && project_name && existsSync(cpg_path)) {
      try {
        pathResults = queryPathFeasibility(cpg_path, project_name, violationList, intApis, projectRoot)
        joernAvailable = true
      } catch (err: any) {
        // Joern path analysis failed — fall back to legacy mode
        // Log the error for diagnostics but don't fail the entire tool
        console.error(`[multivar_feasibility_verify] Joern path analysis failed, falling back to legacy mode: ${(err.message || String(err)).slice(0, 500)}`)
        pathResults = null
      }
    }

    // ── Phase 2: Resolve Z3 ──
    const z3Bin = resolveZ3Bin(projectRoot)
    let z3Available = true
    try {
      const testCmd = `${z3Bin} --version`
      execSync(testCmd, {
        stdio: "pipe",
        timeout: 10_000,
        encoding: "utf-8",
        ...(IS_WINDOWS && { shell: "cmd.exe" }),
      })
    } catch {
      z3Available = false
    }

    // ── Phase 3: Verify each violation ──
    const results: VerifiedViolation[] = []

    for (const violation of violationList) {
      // ── Init-phase check: if ALL main-context accesses are in init functions,
      // interrupts are not yet enabled → violation is infeasible ──
      if (initFuncSet.size > 0) {
        const mainFunctions = (violation.main_accesses ?? [])
          .map((a) => a.location?.function)
          .filter(Boolean)
        if (mainFunctions.length > 0 && mainFunctions.every((f) => initFuncSet.has(f!))) {
          const initFuncNames = [...new Set(mainFunctions)].join(", ")
          results.push({
            ...violation,
            feasibility: "INFEASIBLE",
            severity: feasibilityToSeverity("INFEASIBLE"),
            path_constraint: "",
            path_analysis: {
              sub_path_1: { type: "entry_to_access1", reachable: true, conditions: [], assignments: [], enclosing_conditions: [], interrupt_state_changes: [], path_length: 0, via_calls: [] },
              sub_path_2: { type: "isr_internal", reachable: true, conditions: [], assignments: [], enclosing_conditions: [], interrupt_state_changes: [], path_length: 0, via_calls: [] },
              sub_path_3: { type: "access1_to_access2", reachable: true, conditions: [], assignments: [], enclosing_conditions: [], interrupt_state_changes: [], path_length: 0, via_calls: [] },
              state_at_preemption: { active_conditions: [], active_assignments: [], enclosing_conditions: [], short_circuit_constraints: [] },
              interrupt_enabled: false,
              infeasibility_reason: `init-phase function (${initFuncNames}) executes before interrupts are enabled — no ISR preemption possible`,
            },
          })
          continue
        }
      }

      // Build path analysis result for this violation
      let pathAnalysis: PathAnalysisResult | undefined

      if (pathResults) {
        const pathData = pathResults.get(violation.id)
        if (pathData && pathData.sub_paths.length === 3) {
          const sp1 = pathData.sub_paths[0]
          const sp2 = pathData.sub_paths[1]
          const sp3 = pathData.sub_paths[2]
          const stateAtPreemption = pathData.state_at_preemption

          // Analyze interrupt enable state across sp1 (entry→access1) and sp3 (preemption window)
          const intState = analyzeInterruptEnabled(sp1, sp3, violation.preemption_point)

          // Determine infeasibility or uncertainty reason from path analysis.
          // When reachable is explicitly false → INFEASIBLE (proven unreachable).
          // When reachable is null/undefined with hit_search_limit → UNKNOWN
          // (BFS exhausted search budget, cannot prove either way).
          let infeasibilityReason: string | undefined
          let searchLimitReason: string | undefined
          if (sp1.reachable === false) {
            if ((sp1 as any).hit_search_limit) {
              searchLimitReason = `sub-path 1 (entry→access1): BFS search limit reached, cannot determine reachability`
            } else {
              infeasibilityReason = `sub-path 1 (entry→access1) not reachable: ${sp1.reason ?? "no CFG path"}`
            }
          } else if (sp2.reachable === false) {
            if ((sp2 as any).hit_search_limit) {
              searchLimitReason = `sub-path 2 (ISR internal): BFS search limit reached, cannot determine reachability`
            } else {
              infeasibilityReason = `sub-path 2 (ISR internal) not reachable: ${sp2.reason ?? "no CFG path"}`
            }
          } else if (sp3.reachable === false) {
            if ((sp3 as any).hit_search_limit) {
              searchLimitReason = `sub-path 3 (access1→access2): BFS search limit reached, cannot determine reachability`
            } else {
              infeasibilityReason = `sub-path 3 (access1→access2) not reachable: ${sp3.reason ?? "no CFG path"}`
            }
          } else if (!intState.enabled) {
            infeasibilityReason = `interrupts disabled: ${intState.reason}`
          }

          pathAnalysis = {
            sub_path_1: sp1,
            sub_path_2: sp2,
            sub_path_3: sp3,
            state_at_preemption: stateAtPreemption ?? {
              active_conditions: [],
              active_assignments: [],
              enclosing_conditions: [],
              short_circuit_constraints: [],
            },
            interrupt_enabled: intState.enabled,
            infeasibility_reason: infeasibilityReason ?? searchLimitReason,
          }

          // Fast path: if any sub-path is proven unreachable or interrupts disabled,
          // mark INFEASIBLE without invoking Z3
          if (infeasibilityReason) {
            const smtContent = encodeViolationAsSmt(violation, pathAnalysis, csApiSet)
            results.push({
              ...violation,
              feasibility: "INFEASIBLE",
              severity: feasibilityToSeverity("INFEASIBLE"),
              path_constraint: smtContent,
              path_analysis: pathAnalysis,
            })
            continue
          }

          // Search limit path: BFS exhausted without finding target — cannot prove
          // infeasibility, so mark UNKNOWN rather than incorrectly claiming INFEASIBLE
          if (searchLimitReason) {
            const smtContent = encodeViolationAsSmt(violation, pathAnalysis, csApiSet)
            results.push({
              ...violation,
              feasibility: "UNKNOWN",
              severity: feasibilityToSeverity("UNKNOWN"),
              path_constraint: smtContent,
              path_analysis: pathAnalysis,
            })
            continue
          }
        }
      }

      // Need Z3 for remaining violations
      if (!z3Available) {
        results.push({
          ...violation,
          feasibility: "UNKNOWN",
          severity: feasibilityToSeverity("UNKNOWN"),
          path_constraint: "",
          path_analysis: pathAnalysis,
        })
        continue
      }

      const smtContent = encodeViolationAsSmt(violation, pathAnalysis, csApiSet)
      const z3Result = runZ3(smtContent, z3Bin)

      let feasibility: "CONFIRMED" | "INFEASIBLE" | "UNKNOWN"
      if (z3Result === "sat") {
        feasibility = "CONFIRMED"
      } else if (z3Result === "unsat") {
        feasibility = "INFEASIBLE"
      } else {
        feasibility = "UNKNOWN"
      }

      results.push({
        ...violation,
        feasibility,
        severity: feasibilityToSeverity(feasibility),
        path_constraint: smtContent,
        path_analysis: pathAnalysis,
      })
    }

    const infeasibleByInit = results.filter(
      (v) => v.feasibility === "INFEASIBLE" && v.path_analysis?.infeasibility_reason?.startsWith("init-phase function"),
    ).length

    const summary = {
      total: results.length,
      confirmed: results.filter((v) => v.feasibility === "CONFIRMED").length,
      infeasible: results.filter((v) => v.feasibility === "INFEASIBLE").length,
      unknown: results.filter((v) => v.feasibility === "UNKNOWN").length,
      path_analysis_available: joernAvailable,
      infeasible_by_path: results.filter(
        (v) => v.feasibility === "INFEASIBLE" && v.path_analysis?.infeasibility_reason,
      ).length,
      ...(infeasibleByInit > 0 && { infeasible_by_init_phase: infeasibleByInit }),
    }

    const message = joernAvailable
      ? `Path analysis enabled. ${summary.infeasible_by_path} violations ruled out by CFG/interrupt analysis.`
      : z3Available
        ? "Legacy mode (no CPG path). Only Z3 timeline constraints applied."
        : "Z3 solver not available. All violations marked as UNKNOWN."

    const fullResult = {
      status: "success",
      violations: results,
      summary,
      message,
    }


    // Write Markdown summary if md_output_path is specified
    if (md_output_path) {
      try {
        const mdDir = join(md_output_path, "..")
        if (!existsSync(mdDir)) {
          mkdirSync(mdDir, { recursive: true })
        }
        const md = generateVerifiedViolationsMd(results, summary, message)
        writeFileSync(md_output_path, md, "utf-8")
      } catch { /* best-effort */ }
    }

    // Write full result to file if output_path is specified
    if (output_path) {
      try {
        const dir = join(output_path, "..")
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true })
        }
        writeFileSync(output_path, JSON.stringify(fullResult, null, 2), "utf-8")
      } catch (err: any) {
        return JSON.stringify({
          status: "error",
          error: `Failed to write output file: ${err.message}`,
        })
      }

      // Return compact summary only — full data is in the file
      return JSON.stringify({
        status: "success",
        output_path,
        summary,
        message,
        note: `Full results (${results.length} violations) written to ${output_path}. ` +
          "Read the file for detailed per-violation path analysis and feasibility status.",
      })
    }

    return JSON.stringify(fullResult)
  },
})
