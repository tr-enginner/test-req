import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "fs"
import { join, dirname } from "path"
import { execSync } from "child_process"
import { tmpdir } from "os"
import { resolveJoernBin, resolveJoernScriptPath, findMatrixRoot, normalizeVariableName as sharedNormalizeVariableName } from "./joern-resolve-cli"

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
  struct_base?: string
}

interface InterruptAccessPairData {
  isr_name: string
  priority: number
  access: VarAccess
}

interface PreemptionPointData {
  location: SourceLoc
  interrupt_enabled: boolean
  in_critical_section: boolean
}

interface ViolationData {
  id: string
  pattern: "DFC_RWWR" | "TUP_WRRW" | "TUP_WWWW" | "DAC_RWWW" | "DAC_RWWR"
  correlated_group_id: string
  variables: string[]
  main_accesses: VarAccess[]
  interrupt_accesses: InterruptAccessPairData[]
  preemption_point?: PreemptionPointData
  severity: string
  description: string
}

// ── Interrupt model (ported from interrupt_model.py) ──

type ExecContext = "MAIN_TASK" | "ISR"


function canPreempt(
  lowCtx: string,
  highCtx: string,
  isrEntries: Set<string>,
  priorities: Record<string, number>,
): boolean {
  const lowIsIsr = isrEntries.has(lowCtx)
  const highIsIsr = isrEntries.has(highCtx)

  // ISR can always preempt main task
  if (!lowIsIsr && highIsIsr) return true

  // Higher-priority ISR can preempt lower-priority ISR.
  // When no priorities are configured, default to NO ISR-to-ISR preemption:
  // most embedded platforms (e.g. ARM Cortex-M NVIC) do not allow same-priority
  // ISR nesting. The bidirectional assumption generated N×(N-1) false candidates.
  // Users can explicitly configure interrupt_priorities to enable ISR↔ISR analysis.
  if (lowIsIsr && highIsIsr) {
    if (Object.keys(priorities).length === 0) return false
    const lowPri = priorities[lowCtx] ?? 0
    const highPri = priorities[highCtx] ?? 0
    return highPri > lowPri
  }

  return false
}

// ── Access sequence helper ──

interface AccessSequence {
  context_name: string
  context_type: ExecContext
  accesses: VarAccess[]
}

function getAccessesForVar(seq: AccessSequence, varName: string): VarAccess[] {
  return seq.accesses.filter((a) => a.variable_name === varName)
}

/**
 * Extract consecutive access pairs for the correlated variable group from a
 * given context. "Consecutive" means the two accesses (to varA and varB) are
 * adjacent in source-line order among ALL accesses to the group's variables,
 * with no intervening access to any group variable between them.
 *
 * Returns array of [accessToVarA, accessToVarB] pairs where the first
 * element corresponds to varA with accessTypeA and the second to varB
 * with accessTypeB.
 *
 * Known limitation: ordering is based on (line, column) which approximates
 * but does not guarantee CFG execution order. Macro expansions or inline
 * functions may produce multiple accesses on the same line with unreliable
 * column values. Same-line, same-variable-name accesses with different
 * access types are treated as both orderings to avoid missing valid pairs.
 */
function getConsecutiveAccessPairs(
  seq: AccessSequence,
  groupVars: string[],
  varA: string,
  varB: string,
  accessTypeA: "READ" | "WRITE",
  accessTypeB: "READ" | "WRITE",
): [VarAccess, VarAccess][] {
  const groupVarSet = new Set(groupVars)
  const allGroupAccesses = seq.accesses
    .filter((a) => groupVarSet.has(a.variable_name))
    .sort((a, b) => a.location.line - b.location.line || a.location.column - b.location.column)

  const pairs: [VarAccess, VarAccess][] = []
  for (let i = 0; i < allGroupAccesses.length - 1; i++) {
    const first = allGroupAccesses[i]
    const second = allGroupAccesses[i + 1]

    // Match (varA:typeA, varB:typeB) in order
    if (
      first.variable_name === varA &&
      first.access_type === accessTypeA &&
      second.variable_name === varB &&
      second.access_type === accessTypeB
    ) {
      pairs.push([first, second])
    }
    // Match (varB:typeB, varA:typeA) in order — normalize so varA is first element
    if (
      first.variable_name === varB &&
      first.access_type === accessTypeB &&
      second.variable_name === varA &&
      second.access_type === accessTypeA
    ) {
      pairs.push([second, first])
    }

    // Same-line ambiguity: when both accesses are on the same line (e.g., macro
    // expansion), column ordering may not reflect execution order. Accept both
    // orderings to avoid missing valid pairs due to unreliable column values.
    if (first.location.line === second.location.line && first.location.line > 0) {
      // Try reversed ordering only if it wasn't already matched above
      if (
        first.variable_name === varB &&
        first.access_type === accessTypeA &&
        second.variable_name === varA &&
        second.access_type === accessTypeB &&
        varA !== varB
      ) {
        pairs.push([first, second])
      }
    }
  }
  return pairs
}

// ── Pattern matching (ported from pattern_matcher.py) ──

let violationCounter = 0

function buildDescription(
  pattern: string,
  variables: string[],
  lowCtxName: string,
  lowCtxType: ExecContext,
  highCtxName: string,
  first: VarAccess,
  second: VarAccess,
): string {
  const descs: Record<string, string> = {
    DFC_RWWR: "Read-Write interleave (DFC)",
    TUP_WRRW: "Write-Read interleave (TUP)",
    TUP_WWWW: "Write-Write interleave (TUP)",
    DAC_RWWW: "Decision-Action violation, action=WRITE (DAC)",
    DAC_RWWR: "Decision-Action violation, action=READ (DAC)",
  }
  const lowLabel = lowCtxType === "ISR"
    ? `low-priority ISR '${lowCtxName}'`
    : `main task '${lowCtxName}'`
  return (
    `${descs[pattern] ?? pattern}: ` +
    `Variables <${variables.join(", ")}> accessed in ${lowLabel} ` +
    `at L${first.location.line}-L${second.location.line} ` +
    `can be preempted by higher-priority ISR '${highCtxName}'`
  )
}

function createViolation(
  pattern: "DFC_RWWR" | "TUP_WRRW" | "TUP_WWWW" | "DAC_RWWW" | "DAC_RWWR",
  group: CVGroup,
  variables: string[],
  lowAccesses: VarAccess[],
  lowCtxName: string,
  lowCtxType: ExecContext,
  highCtxName: string,
  highAccesses: VarAccess[],
  first: VarAccess,
  second: VarAccess,
  priority: number,
): ViolationData {
  violationCounter++
  const id = `av_${String(violationCounter).padStart(4, "0")}`

  return {
    id,
    pattern,
    correlated_group_id: group.id,
    variables,
    main_accesses: lowAccesses,
    interrupt_accesses: highAccesses.map((a) => ({
      isr_name: highCtxName,
      priority,
      access: a,
    })),
    preemption_point: {
      location: {
        file_path: first.location.file_path,
        line: first.location.line,
        column: first.location.column,
        function: first.location.function,
        code: `Preemption between ${first.variable_name} and ${second.variable_name}`,
      },
      interrupt_enabled: true,
      in_critical_section: false,
    },
    severity: "warning",
    description: buildDescription(pattern, variables, lowCtxName, lowCtxType, highCtxName, first, second),
  }
}

// ── Per-pattern matching functions ──
// Each function matches exactly one violation pattern, dispatched by anchor type.

/**
 * DFC_RWWR: R₁(A) - [W₂(A), W₂(B)] - R₁(B)
 * Low-priority reads two correlated variables; ISR writes both in between.
 * Used for DFC anchors where the R-R pair is in the low-priority context.
 *
 * ISR-side constraint: the two write accesses must be consecutive among all
 * accesses to the group's correlated variables (no intervening group-variable
 * access between them).
 */
function matchDfcRW(
  group: CVGroup,
  lowSeq: AccessSequence,
  highSeq: AccessSequence,
  priority: number,
): ViolationData[] {
  const violations: ViolationData[] = []
  const vars = group.variables
  if (vars.length < 2) return violations

  for (let i = 0; i < vars.length; i++) {
    for (let j = i + 1; j < vars.length; j++) {
      const orderings: [string, string][] = [[vars[i], vars[j]], [vars[j], vars[i]]]
      for (const [varA, varB] of orderings) {
        const readsA = getAccessesForVar(lowSeq, varA).filter((a) => a.access_type === "READ")
        const readsB = getAccessesForVar(lowSeq, varB).filter((a) => a.access_type === "READ")

        if (readsA.length === 0 || readsB.length === 0) continue

        // ISR side: only consecutive write pairs
        const highWritePairs = getConsecutiveAccessPairs(highSeq, vars, varA, varB, "WRITE", "WRITE")
        if (highWritePairs.length === 0) continue

        for (const ra of readsA) {
          for (const rb of readsB) {
            if (ra.location.line <= rb.location.line) {
              for (const [wha, whb] of highWritePairs) {
                violations.push(
                  createViolation(
                    "DFC_RWWR", group, [varA, varB],
                    [ra, rb], lowSeq.context_name, lowSeq.context_type,
                    highSeq.context_name, [wha, whb],
                    ra, rb, priority,
                  ),
                )
              }
            }
          }
        }
      }
    }
  }
  return violations
}

/**
 * TUP_WRRW: W₁(A) - [R₂(A), R₂(B)] - W₁(B)
 * Low-priority writes two correlated variables; ISR reads both in between.
 * Used for TUP anchors where the W-W pair is in the low-priority context
 * and the ISR reads an inconsistent state.
 *
 * ISR-side constraint: the two read accesses must be consecutive among all
 * accesses to the group's correlated variables.
 */
function matchTupWR(
  group: CVGroup,
  lowSeq: AccessSequence,
  highSeq: AccessSequence,
  priority: number,
): ViolationData[] {
  const violations: ViolationData[] = []
  const vars = group.variables
  if (vars.length < 2) return violations

  for (let i = 0; i < vars.length; i++) {
    for (let j = i + 1; j < vars.length; j++) {
      const orderings: [string, string][] = [[vars[i], vars[j]], [vars[j], vars[i]]]
      for (const [varA, varB] of orderings) {
        const writesALow = getAccessesForVar(lowSeq, varA).filter((a) => a.access_type === "WRITE")
        const writesBLow = getAccessesForVar(lowSeq, varB).filter((a) => a.access_type === "WRITE")

        if (writesALow.length === 0 || writesBLow.length === 0) continue

        // ISR side: only consecutive read pairs
        const highReadPairs = getConsecutiveAccessPairs(highSeq, vars, varA, varB, "READ", "READ")
        if (highReadPairs.length === 0) continue

        for (const wa of writesALow) {
          for (const wb of writesBLow) {
            if (wa.location.line <= wb.location.line) {
              for (const [rha, rhb] of highReadPairs) {
                violations.push(
                  createViolation(
                    "TUP_WRRW", group, [varA, varB],
                    [wa, wb], lowSeq.context_name, lowSeq.context_type,
                    highSeq.context_name, [rha, rhb],
                    wa, wb, priority,
                  ),
                )
              }
            }
          }
        }
      }
    }
  }
  return violations
}

/**
 * TUP_WWWW: W₁(A) - [W₂(A), W₂(B)] - W₁(B)
 * Low-priority writes two correlated variables; ISR also writes both in between.
 * Used for TUP anchors.
 *
 * ISR-side constraint: the two write accesses must be consecutive among all
 * accesses to the group's correlated variables.
 */
function matchTupWW(
  group: CVGroup,
  lowSeq: AccessSequence,
  highSeq: AccessSequence,
  priority: number,
): ViolationData[] {
  const violations: ViolationData[] = []
  const vars = group.variables
  if (vars.length < 2) return violations

  for (let i = 0; i < vars.length; i++) {
    for (let j = i + 1; j < vars.length; j++) {
      const orderings: [string, string][] = [[vars[i], vars[j]], [vars[j], vars[i]]]
      for (const [varA, varB] of orderings) {
        const writesALow = getAccessesForVar(lowSeq, varA).filter((a) => a.access_type === "WRITE")
        const writesBLow = getAccessesForVar(lowSeq, varB).filter((a) => a.access_type === "WRITE")

        if (writesALow.length === 0 || writesBLow.length === 0) continue

        // ISR side: only consecutive write pairs
        const highWritePairs = getConsecutiveAccessPairs(highSeq, vars, varA, varB, "WRITE", "WRITE")
        if (highWritePairs.length === 0) continue

        for (const wa of writesALow) {
          for (const wb of writesBLow) {
            if (wa.location.line <= wb.location.line) {
              for (const [wha, whb] of highWritePairs) {
                violations.push(
                  createViolation(
                    "TUP_WWWW", group, [varA, varB],
                    [wa, wb], lowSeq.context_name, lowSeq.context_type,
                    highSeq.context_name, [wha, whb],
                    wa, wb, priority,
                  ),
                )
              }
            }
          }
        }
      }
    }
  }
  return violations
}

/**
 * DAC_RWWW: R₁(A) - [W₂(A), W₂(B)] - W₁(B)
 * Low-priority reads decision variable then writes action variable;
 * ISR writes both in between, invalidating the decision.
 * Used for DAC anchors.
 *
 * ISR-side constraint: the two write accesses must be consecutive among all
 * accesses to the group's correlated variables.
 */
function matchDacRWWW(
  group: CVGroup,
  lowSeq: AccessSequence,
  highSeq: AccessSequence,
  priority: number,
): ViolationData[] {
  const violations: ViolationData[] = []
  const vars = group.variables
  if (vars.length < 2) return violations

  // Identify decision/action variables from roles
  const decisionVars = new Set(
    group.accesses.filter((a) => a.role === "DECISION").map((a) => a.variable_name),
  )
  const actionVars = new Set(
    group.accesses.filter((a) => a.role === "ACTION").map((a) => a.variable_name),
  )

  let pairs: [string, string][]
  if (decisionVars.size > 0 && actionVars.size > 0) {
    pairs = []
    for (const d of decisionVars) {
      for (const a of actionVars) {
        if (d !== a) pairs.push([d, a])
      }
    }
  } else {
    pairs = []
    for (let i = 0; i < vars.length; i++) {
      for (let j = 0; j < vars.length; j++) {
        if (i !== j) pairs.push([vars[i], vars[j]])
      }
    }
  }

  for (const [varA, varB] of pairs) {
    // R₁(A) - [W₂(A), W₂(B)] - W₁(B)
    const lowReadsA = getAccessesForVar(lowSeq, varA).filter((a) => a.access_type === "READ")
    const lowWritesB = getAccessesForVar(lowSeq, varB).filter((a) => a.access_type === "WRITE")

    if (lowReadsA.length === 0 || lowWritesB.length === 0) continue

    // ISR side: only consecutive write pairs
    const highWritePairs = getConsecutiveAccessPairs(highSeq, vars, varA, varB, "WRITE", "WRITE")
    if (highWritePairs.length === 0) continue

    for (const ra of lowReadsA) {
      for (const wb of lowWritesB) {
        if (ra.location.line <= wb.location.line) {
          for (const [wha, whb] of highWritePairs) {
            violations.push(
              createViolation(
                "DAC_RWWW", group, [varA, varB],
                [ra, wb], lowSeq.context_name, lowSeq.context_type,
                highSeq.context_name, [wha, whb],
                ra, wb, priority,
              ),
            )
          }
        }
      }
    }
  }

  return violations
}

/**
 * DAC_RWWR: R₁(A) - [W₂(A), W₂(B)] - R₁(B)
 * Low-priority reads decision variable then reads action variable;
 * ISR writes both in between, invalidating the decision.
 * Used for DAC anchors where action side is a READ (e.g., if(flag){use(buf)}).
 *
 * ISR-side constraint: the two write accesses must be consecutive among all
 * accesses to the group's correlated variables.
 */
function matchDacRWWR(
  group: CVGroup,
  lowSeq: AccessSequence,
  highSeq: AccessSequence,
  priority: number,
): ViolationData[] {
  const violations: ViolationData[] = []
  const vars = group.variables
  if (vars.length < 2) return violations

  // Identify decision/action variables from roles
  const decisionVars = new Set(
    group.accesses.filter((a) => a.role === "DECISION").map((a) => a.variable_name),
  )
  const actionVars = new Set(
    group.accesses.filter((a) => a.role === "ACTION").map((a) => a.variable_name),
  )

  let pairs: [string, string][]
  if (decisionVars.size > 0 && actionVars.size > 0) {
    pairs = []
    for (const d of decisionVars) {
      for (const a of actionVars) {
        if (d !== a) pairs.push([d, a])
      }
    }
  } else {
    pairs = []
    for (let i = 0; i < vars.length; i++) {
      for (let j = 0; j < vars.length; j++) {
        if (i !== j) pairs.push([vars[i], vars[j]])
      }
    }
  }

  for (const [varA, varB] of pairs) {
    // R₁(A) - [W₂(A), W₂(B)] - R₁(B)
    const lowReadsA = getAccessesForVar(lowSeq, varA).filter((a) => a.access_type === "READ")
    const lowReadsB = getAccessesForVar(lowSeq, varB).filter((a) => a.access_type === "READ")

    if (lowReadsA.length === 0 || lowReadsB.length === 0) continue

    // ISR side: only consecutive write pairs
    const highWritePairs = getConsecutiveAccessPairs(highSeq, vars, varA, varB, "WRITE", "WRITE")
    if (highWritePairs.length === 0) continue

    for (const ra of lowReadsA) {
      for (const rb of lowReadsB) {
        if (ra.location.line <= rb.location.line) {
          for (const [wha, whb] of highWritePairs) {
            violations.push(
              createViolation(
                "DAC_RWWR", group, [varA, varB],
                [ra, rb], lowSeq.context_name, lowSeq.context_type,
                highSeq.context_name, [wha, whb],
                ra, rb, priority,
              ),
            )
          }
        }
      }
    }
  }

  return violations
}

// ── Joern CPG query helpers ──


interface JoernAccessEntry {
  variable: string
  entry_function: string
  function: string
  access_type: "READ" | "WRITE"
  file_path: string
  line: number
  column: number
  code: string
}

const normalizeVariableName = sharedNormalizeVariableName

/**
 * Query the Joern CPG for all access sites of the given variables across
 * all entry functions (main tasks + ISRs). Returns VarAccess[] classified
 * by entry_function so that the pattern matcher can split main/ISR contexts.
 */
function queryAccessesFromCpg(
  cpgPath: string,
  projectName: string,
  varNames: string[],
  entryFunctions: string[],
  projectRoot: string | null,
): VarAccess[] {
  const scriptPath = resolveJoernScriptPath()

  // Use forward slashes in Scala string literals to avoid Windows backslash issues
  const cpgPathForScala = cpgPath.replace(/\\/g, "/")
  const scriptPathForScala = scriptPath.replace(/\\/g, "/")

  const varNamesScalaList = varNames.map((v) => `"${v}"`).join(", ")
  const entryFuncsScalaList = entryFunctions.map((f) => `"${f}"`).join(", ")

  const wrapperContent = [
    `//> using file ${scriptPathForScala}`,
    `importCpg("${cpgPathForScala}", "${projectName}")`,
    `val _result = queryVariableAccesses("${projectName}", List(${varNamesScalaList}), List(${entryFuncsScalaList}))`,
    `println(_result)`,
  ].join("\n")

  const wrapperPath = join(tmpdir(), `atomicity_vd_joern_wrapper_${Date.now()}.sc`)
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
  } finally {
    try { unlinkSync(wrapperPath) } catch { /* ignore cleanup errors */ }
  }

  // Parse JSON from Joern output (may contain non-JSON preamble)
  const jsonStart = stdout.indexOf("{")
  const jsonEnd = stdout.lastIndexOf("}")
  if (jsonStart === -1 || jsonEnd === -1) {
    throw new Error("Failed to parse JSON from Joern queryVariableAccesses output")
  }

  const rawJson = JSON.parse(stdout.substring(jsonStart, jsonEnd + 1))
  const rawAccesses: JoernAccessEntry[] = rawJson.accesses ?? []

  // Convert to VarAccess[]
  return rawAccesses.map((a) => ({
    variable_name: normalizeVariableName(a.variable ?? a.code ?? ""),
    access_type: a.access_type === "WRITE" ? ("WRITE" as const) : ("READ" as const),
    location: {
      file_path: a.file_path ?? "",
      line: a.line ?? 0,
      column: a.column ?? 0,
      function: a.function ?? "",
      code: a.code ?? "",
    },
    entry_function: a.entry_function ?? "",
    expression: a.code ?? "",
    role: "UNKNOWN" as const,
  }))
}

// ── Markdown report generation ──

function generateCandidatesMd(
  violations: ViolationData[],
  summary: { total: number; by_pattern: Record<string, number>; candidate_stats: Record<string, any> },
): string {
  const lines: string[] = []
  lines.push("# 原子性违反候选 — 4次访问序列")
  lines.push("")
  lines.push(`**日期**: ${new Date().toISOString().split("T")[0]}`)
  lines.push("")

  // Summary
  lines.push("## 概览")
  lines.push("")
  lines.push("| 指标 | 值 |")
  lines.push("|------|------|")
  lines.push(`| 候选总数 | ${summary.total} |`)
  const cs = summary.candidate_stats
  lines.push(`| 原始候选数 | ${cs.raw_candidates} |`)
  lines.push(`| 去重移除 | ${cs.duplicates_removed} |`)
  lines.push(`| 涉及关联组数 | ${cs.correlated_groups_involved} |`)
  lines.push(`| 涉及变量对数 | ${cs.variable_pairs_involved} |`)
  lines.push("")

  // By pattern
  lines.push("## 按模式分布")
  lines.push("")
  lines.push("| 违反模式 | 候选数量 |")
  lines.push("|---------|---------|")
  for (const p of ["DFC_RWWR", "TUP_WRRW", "TUP_WWWW", "DAC_RWWW", "DAC_RWWR"]) {
    const count = (summary.by_pattern as Record<string, number>)[p] ?? 0
    lines.push(`| ${p} | ${count} |`)
  }
  lines.push(`| **合计** | **${summary.total}** |`)
  lines.push("")

  // Violation details
  lines.push("## 候选详情")
  lines.push("")
  if (violations.length === 0) {
    lines.push("> 未检测到原子性违反候选。")
  } else {
    lines.push(`> 共 ${violations.length} 个候选，按 ID 排序。`)
    lines.push("")
    for (const v of violations) {
      lines.push(`### ${v.id}: ${v.pattern}`)
      lines.push("")
      lines.push(`- **关联组**: ${v.correlated_group_id}`)
      lines.push(`- **变量**: \`${v.variables.join("`, `")}\``)
      lines.push(`- **描述**: ${v.description}`)
      lines.push("")
      lines.push("**4次访问交错序列**:")
      lines.push("")
      lines.push("| # | 上下文 | 变量 | 访问类型 | 文件 | 行号 | 代码 |")
      lines.push("|---|--------|------|---------|------|------|------|")
      // Main access 1
      const ma1 = v.main_accesses[0]
      if (ma1) {
        const f1 = ma1.location.file_path.split(/[\\/]/).pop() ?? ""
        lines.push(`| 1 | 低优先级 | \`${ma1.variable_name}\` | ${ma1.access_type} | ${f1} | ${ma1.location.line} | \`${ma1.location.code.slice(0, 60)}\` |`)
      }
      // ISR accesses
      for (let i = 0; i < v.interrupt_accesses.length; i++) {
        const ia = v.interrupt_accesses[i]
        const fh = ia.access.location.file_path.split(/[\\/]/).pop() ?? ""
        lines.push(`| ${i + 2} | **${ia.isr_name}** | \`${ia.access.variable_name}\` | ${ia.access.access_type} | ${fh} | ${ia.access.location.line} | \`${ia.access.location.code.slice(0, 60)}\` |`)
      }
      // Main access 2
      const ma2 = v.main_accesses[1]
      if (ma2) {
        const f2 = ma2.location.file_path.split(/[\\/]/).pop() ?? ""
        lines.push(`| ${v.interrupt_accesses.length + 2} | 低优先级 | \`${ma2.variable_name}\` | ${ma2.access_type} | ${f2} | ${ma2.location.line} | \`${ma2.location.code.slice(0, 60)}\` |`)
      }
      lines.push("")
    }
  }

  return lines.join("\n")
}

// ── Tool definition ──

/**
 * multivar_violation_detect — Match correlated variable groups against violation patterns
 * by independently querying the CPG for all access sites.
 */
export const multivarViolationDetect: ToolDefinition = tool({
  description:
    "Detect multi-variable atomicity violation candidates by querying the Joern CPG for " +
    "all access sites of correlated variables across main/ISR contexts, then matching " +
    "against 5 violation patterns (DFC_RWWR, TUP_WRRW, TUP_WWWW, DAC_RWWW, DAC_RWWR). " +
    "Requires cpg_path and project_name to invoke Joern for independent access analysis. " +
    "Outputs JSON data to output_path and a Markdown summary to md_output_path.",
  args: {
    correlated_groups_path: tool.schema
      .string()
      .optional()
      .describe(
        "Absolute path to the correlated groups JSON file written by multivar_correlated_vars " +
        "(e.g., '.matrix/data/multivar-correlated-groups.json'). Preferred over correlated_groups string.",
      ),
    correlated_groups: tool.schema
      .string()
      .optional()
      .describe(
        "JSON string — either the full multivar_correlated_vars output " +
        'or just the groups array directly. Use correlated_groups_path instead when possible.',
      ),
    isr_entries: tool.schema
      .string()
      .describe(
        'JSON array of ISR entry function names (e.g., \'["Timer0_ISR", "UART_IRQHandler"]\').',
      ),
    task_entries: tool.schema
      .string()
      .describe(
        'JSON array of task/main entry function names (e.g., \'["main"]\').',
      ),
    cpg_path: tool.schema
      .string()
      .describe(
        "Absolute path to the Joern CPG binary file (from multivar_cpg_create output).",
      ),
    project_name: tool.schema
      .string()
      .describe(
        "Project name used when the CPG was created.",
      ),
    interrupt_priorities: tool.schema
      .string()
      .optional()
      .describe(
        'JSON object mapping ISR names to priority levels (e.g., \'{"Timer0_ISR": 1, "UART_IRQHandler": 2}\'). ' +
        "Higher number = higher priority. Defaults to all priority 0 if not provided.",
      ),
    output_path: tool.schema
      .string()
      .optional()
      .describe(
        "Absolute path to write the violations JSON result file. " +
        "If provided, the full result is written to this file AND returned as tool output. " +
        "Recommended: use '.matrix/data/multivar-candidates.json'.",
      ),
    md_output_path: tool.schema
      .string()
      .optional()
      .describe(
        "Absolute path to write a Markdown summary of violation candidates. " +
        "Recommended: '.matrix/reports/multivar-candidates.md'.",
      ),
  },
  async execute({ correlated_groups_path, correlated_groups, isr_entries, task_entries, cpg_path, project_name, interrupt_priorities, output_path, md_output_path }) {
    // Reset counter per invocation
    violationCounter = 0

    let groups: CVGroup[]
    let isrList: string[]
    let taskList: string[]
    let priorities: Record<string, number>

    // Load correlated groups — prefer file path, fall back to inline JSON string
    let rawGroupsJson: string | undefined
    if (correlated_groups_path) {
      if (!existsSync(correlated_groups_path)) {
        return JSON.stringify({
          status: "error",
          error: `Correlated groups file not found: ${correlated_groups_path}`,
        })
      }
      try {
        rawGroupsJson = readFileSync(correlated_groups_path, "utf-8")
      } catch (err: any) {
        return JSON.stringify({
          status: "error",
          error: `Failed to read correlated groups file: ${err.message}`,
        })
      }
    } else if (correlated_groups) {
      rawGroupsJson = correlated_groups
    } else {
      return JSON.stringify({
        status: "error",
        error: "Either correlated_groups_path or correlated_groups must be provided.",
      })
    }

    try {
      const parsed = JSON.parse(rawGroupsJson!)
      // Accept either the raw groups array or the full tool result
      // (the agent may pass { status, groups, stats, ... } instead of just the groups array)
      if (Array.isArray(parsed)) {
        groups = parsed
      } else if (parsed && Array.isArray(parsed.groups)) {
        groups = parsed.groups
      } else {
        return JSON.stringify({
          status: "error",
          error:
            "correlated_groups must be a JSON array of groups or an object with a `groups` array field.",
        })
      }
    } catch {
      return JSON.stringify({ status: "error", error: "Invalid JSON in correlated_groups" })
    }

    try {
      isrList = JSON.parse(isr_entries)
    } catch {
      return JSON.stringify({ status: "error", error: "Invalid JSON in isr_entries" })
    }

    try {
      taskList = JSON.parse(task_entries)
    } catch {
      return JSON.stringify({ status: "error", error: "Invalid JSON in task_entries" })
    }

    try {
      priorities = interrupt_priorities ? JSON.parse(interrupt_priorities) : {}
    } catch {
      priorities = {}
    }

    if (!existsSync(cpg_path)) {
      return JSON.stringify({ status: "error", error: `CPG file not found: ${cpg_path}` })
    }

    const isrSet = new Set(isrList)

    // ── Fix 2: Step 3.5 enforcement (MUST run before Fix 1 filter) ──
    // Check ALL DAC groups in the original data for missing llm_score.
    // This must run BEFORE the confidence filter (Fix 1), because Fix 1 would remove
    // all low-confidence DAC groups, leaving none to check, causing Fix 2 to silently pass.
    const allDacGroups = groups.filter((g) => g.anchor_type === "DAC")
    const dacGroupsMissingLlm = allDacGroups.filter(
      (g) => !("llm_score" in (g.evidence ?? {}))
    )
    if (dacGroupsMissingLlm.length > 0) {
      return JSON.stringify({
        status: "error",
        error:
          `Step 3.5 not completed: ${dacGroupsMissingLlm.length} DAC group(s) are missing ` +
          `'llm_score' in their evidence field. ` +
          `LLM evaluation (Step 3.5) MUST be completed and written back to ` +
          `multivar-correlated-groups.json before calling this tool. ` +
          `Use the 'write' tool to update the JSON file directly — do NOT use Python/exec/bash. ` +
          `Affected group IDs: ${dacGroupsMissingLlm.slice(0, 5).map((g) => g.id).join(", ")}` +
          (dacGroupsMissingLlm.length > 5 ? ` ... (${dacGroupsMissingLlm.length - 5} more)` : ""),
      })
    }

    // ── Fix 1: Confidence filter ──
    // Groups below 0.55 should have been removed by Step 3.5 LLM evaluation.
    // This defensive filter prevents low-quality groups from generating noise candidates
    // even when the agent skips Step 3.5.
    const beforeFilter = groups.length
    groups = groups.filter((g) => (g.confidence ?? 0) >= 0.55)
    const filteredCount = beforeFilter - groups.length
    if (filteredCount > 0) {
      console.warn(
        `[multivar_violation_detect] Filtered ${filteredCount} group(s) with confidence < 0.55 ` +
        `(Step 3.5 should have removed these). Proceeding with ${groups.length} group(s).`
      )
    }

    if (groups.length === 0) {
      const emptyResult = {
        status: "success",
        violations: [],
        summary: { total: 0 },
        message: "No correlated variable groups to analyze.",
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

    // Collect all unique variable names across all correlated groups
    const allVarNames = new Set<string>()
    for (const group of groups) {
      for (const v of group.variables) allVarNames.add(v)
    }

    // All entry functions = task entries + ISR entries
    const allEntryFunctions = [...taskList, ...isrList]
    const projectRoot = cpg_path ? findMatrixRoot(dirname(cpg_path)) : null

    // Query Joern CPG for all access sites of these variables
    let allAccesses: VarAccess[]
    try {
      allAccesses = queryAccessesFromCpg(
        cpg_path,
        project_name,
        [...allVarNames],
        allEntryFunctions,
        projectRoot,
      )
    } catch (err: any) {
      return JSON.stringify({
        status: "error",
        error: `Joern CPG query failed: ${(err.message || String(err)).slice(0, 2000)}`,
      })
    }

    // Build a lookup: variable name -> VarAccess[]
    const accessesByVar = new Map<string, VarAccess[]>()
    for (const a of allAccesses) {
      const existing = accessesByVar.get(a.variable_name)
      if (existing) existing.push(a)
      else accessesByVar.set(a.variable_name, [a])
    }

    // Build array-base index: for variables with constant array indices
    // (e.g. "arr[0]", "mRoughVector.v3[1]"), compute the base without index
    // (e.g. "arr", "mRoughVector.v3"). This allows matching Joern accesses
    // that use variable indices (e.g. "arr[i]", "mRoughVector.v3[i]").
    const CONST_INDEX_RE = /\[\d+\]$/
    function stripConstIndex(varName: string): string | null {
      return CONST_INDEX_RE.test(varName)
        ? varName.replace(CONST_INDEX_RE, "")
        : null
    }

    // Build reverse map: array base -> Set of group variable names with that base
    // e.g. "mRoughVector.v3" -> Set("mRoughVector.v3[0]", "mRoughVector.v3[1]")
    const allArrayBases = new Map<string, Set<string>>()
    for (const v of allVarNames) {
      const base = stripConstIndex(v)
      if (base) {
        const existing = allArrayBases.get(base)
        if (existing) existing.add(v)
        else allArrayBases.set(base, new Set([v]))
      }
    }

    // Also build an array-base lookup for Joern-returned accesses that have
    // variable indices. An access with variable_name like "mRoughVector.v3[i]"
    // has a non-constant index, so stripConstIndex returns null. We detect
    // these by checking if the trailing bracket contains a NON-constant index.
    // A constant index is: decimal (123), hex (0x1A), or with type suffix (17U).
    // Anything else (identifiers, expressions) is a variable index.
    const TRAILING_BRACKET_RE = /\[([^\]]*)\]$/
    function stripVarIndex(varName: string): string | null {
      const m = TRAILING_BRACKET_RE.exec(varName)
      if (!m) return null
      const indexContent = m[1].trim()
      // If the index content is a constant (decimal, hex, or with U/L suffix), it's NOT a variable index
      if (/^-?(\d+|0[xX][0-9a-fA-F]+)[UuLl]*$/.test(indexContent)) return null
      // Otherwise it's a variable index — strip the trailing bracket
      return varName.replace(TRAILING_BRACKET_RE, "")
    }

    // Build a secondary lookup: array base -> VarAccess[] for accesses with
    // variable indices (i.e., accesses NOT in the primary accessesByVar map)
    const accessesByArrayBase = new Map<string, VarAccess[]>()
    for (const a of allAccesses) {
      // If the access has a variable index (like arr[i]), map it by its base
      const varBase = stripVarIndex(a.variable_name)
      if (varBase && allArrayBases.has(varBase)) {
        const existing = accessesByArrayBase.get(varBase)
        if (existing) existing.push(a)
        else accessesByArrayBase.set(varBase, [a])
      }
    }

    // Each group from correlated-vars represents an independent correlated access
    // pair at a specific code location. Analyse each group independently to
    // maintain data traceability (correlated pair → 4-access sequence → defect).
    // The group's own accesses define the low-priority (main/task) access scope,
    // while ISR accesses are gathered from the CPG global query.
    const uniqueGroups = groups

    const allViolations: ViolationData[] = []

    for (const group of uniqueGroups) {
      // The group's own accesses provide the location-specific "anchor" side
      // (preserving cross-block fix: only the group's own code location is used,
      // preventing false violations from mixing different code blocks).
      // CPG-queried accesses provide the "other context" side — filtered to
      // exclude the group's own entry function(s) to prevent same-context
      // cross-block contamination.
      // For main-vs-ISR: group in main, CPG provides ISR accesses.
      // For ISR-vs-ISR: group in ISR_A, CPG provides ISR_B (+ main) accesses.
      const groupOwnAccesses = group.accesses
      const groupEntryFunctions = new Set(group.accesses.map(a => a.entry_function))
      const cpgAccesses: VarAccess[] = []
      for (const v of group.variables) {
        // Direct match: exact variable name
        const allVarAccesses = accessesByVar.get(v) ?? []
        for (const a of allVarAccesses) {
          if (!groupEntryFunctions.has(a.entry_function)) {
            cpgAccesses.push(a)
          }
        }
        // Array-base match: for variables like "arr[0]", also collect
        // accesses with variable indices like "arr[i]", renaming them to
        // match the group variable name for pattern matching.
        const base = stripConstIndex(v)
        if (base) {
          const baseAccesses = accessesByArrayBase.get(base) ?? []
          for (const a of baseAccesses) {
            if (!groupEntryFunctions.has(a.entry_function)) {
              // Clone the access with the group's constant-indexed variable name
              // so pattern matching can correlate it with the group accesses.
              cpgAccesses.push({
                ...a,
                variable_name: v,
              })
            }
          }
        }
      }
      // Merge group-own + CPG accesses (no overlap since CPG excludes group's
      // own entry functions, but dedup for safety).
      const seen = new Set<string>()
      const groupAccesses: VarAccess[] = []
      for (const a of [...groupOwnAccesses, ...cpgAccesses]) {
        const key = `${a.variable_name}:${a.entry_function}:${a.location.line}:${a.location.column}`
        if (!seen.has(key)) {
          seen.add(key)
          groupAccesses.push(a)
        }
      }

      // NOTE: Do NOT mutate group.accesses here. matchDacRwww/matchDacRwwr reads group.accesses
      // for DECISION/ACTION role extraction — the original Tool A accesses already
      // have correct roles assigned by assignDacRoles(). Overwriting with the merged
      // groupAccesses would add CPG-queried entries (role="UNKNOWN") that, while
      // currently filtered out, make the code fragile and violate input immutability.
      // Pattern matching uses lowSeq/highSeq built from the local groupAccesses below.

      // Build access sequences by context (unified: main tasks + ISRs).
      // Accesses from shared helper functions (entry_function not in task/ISR set)
      // are duplicated into ALL known contexts, since the helper can be called from
      // any of them. This prevents shared sub-function accesses from forming
      // isolated sequences that bypass preemption relationship checks.
      const allSequences: Record<string, AccessSequence> = {}
      const knownContexts = new Set([...taskList, ...isrList])

      for (const access of groupAccesses) {
        const name = access.entry_function || "main"
        if (knownContexts.has(name)) {
          // Direct task/ISR context — assign directly
          if (!allSequences[name]) {
            const ctxType = isrSet.has(name) ? "ISR" as const : "MAIN_TASK" as const
            allSequences[name] = { context_name: name, context_type: ctxType, accesses: [] }
          }
          allSequences[name].accesses.push(access)
        } else {
          // Shared helper function (not a known entry) — duplicate into all contexts
          // that could call it. Since we don't have call-graph info here, duplicate
          // into all known contexts as a conservative approximation.
          for (const ctx of knownContexts) {
            if (!allSequences[ctx]) {
              const ctxType = isrSet.has(ctx) ? "ISR" as const : "MAIN_TASK" as const
              allSequences[ctx] = { context_name: ctx, context_type: ctxType, accesses: [] }
            }
            allSequences[ctx].accesses.push(access)
          }
        }
      }

      // Iterate all (lowCtx, highCtx) pairs where highCtx can preempt lowCtx.
      // This covers main-vs-ISR AND ISR-vs-higher-priority-ISR interleavings.
      // Pattern matching is dispatched by anchor_type:
      //   DFC (R,R):   DFC_RWWR only
      //   TUP (W,W):   TUP_WRRW + TUP_WWWW
      //   DAC (R→?):   DAC_RWWW (action=W) + DAC_RWWR (action=R)
      const contextNames = Object.keys(allSequences)
      for (const lowCtx of contextNames) {
        for (const highCtx of contextNames) {
          if (lowCtx === highCtx) continue
          if (!canPreempt(lowCtx, highCtx, isrSet, priorities)) continue
          // At least one side must be the group's own context to maintain
          // traceability (group → candidate). Without this, a CAN_ISR group
          // could generate spurious (main, TIMER_ISR) candidates.
          if (!groupEntryFunctions.has(lowCtx) && !groupEntryFunctions.has(highCtx)) continue

          const lowSeq = allSequences[lowCtx]
          const highSeq = allSequences[highCtx]
          const priority = priorities[highCtx] ?? 0

          switch (group.anchor_type) {
            case "DFC":
              // DFC (R-R anchor) → DFC_RWWR
              allViolations.push(...matchDfcRW(group, lowSeq, highSeq, priority))
              break
            case "TUP":
              // TUP (W-W anchor) → TUP_WRRW + TUP_WWWW
              allViolations.push(...matchTupWR(group, lowSeq, highSeq, priority))
              allViolations.push(...matchTupWW(group, lowSeq, highSeq, priority))
              break
            case "DAC":
              allViolations.push(...matchDacRWWW(group, lowSeq, highSeq, priority))
              allViolations.push(...matchDacRWWR(group, lowSeq, highSeq, priority))
              break
          }
        }
      }
    }

    // ── Pre-dedup candidate statistics ──
    // Capture raw candidate counts BEFORE dedup so the report can show the
    // full picture of the initial pattern matching pass.
    const rawCandidateTotal = allViolations.length
    const rawByPattern = {
      DFC_RWWR: allViolations.filter((v) => v.pattern === "DFC_RWWR").length,
      TUP_WRRW: allViolations.filter((v) => v.pattern === "TUP_WRRW").length,
      TUP_WWWW: allViolations.filter((v) => v.pattern === "TUP_WWWW").length,
      DAC_RWWW: allViolations.filter((v) => v.pattern === "DAC_RWWW").length,
      DAC_RWWR: allViolations.filter((v) => v.pattern === "DAC_RWWR").length,
    }
    // Unique variable pairs that contributed at least one candidate
    const candidateVarPairs = new Set<string>()
    // Unique correlated groups that contributed at least one candidate
    const candidateGroupIds = new Set<string>()
    for (const v of allViolations) {
      candidateVarPairs.add([...v.variables].sort().join(","))
      candidateGroupIds.add(v.correlated_group_id)
    }

    // ── Deduplicate violations ──
    // A violation is a unique 4-access interleaving candidate identified by
    // its pattern, variable pair, and the line numbers of all 4 accesses
    // (2 main-side + 2 ISR-side). Only when all 4 line numbers are identical
    // do we consider two violations as duplicates.
    const seenViolations = new Set<string>()
    const dedupedViolations: ViolationData[] = []
    for (const v of allViolations) {
      const mainPos = v.main_accesses
        .map((a) => `${a.location.line}:${a.location.column}`)
        .sort()
        .join(",")
      const isrPos = v.interrupt_accesses
        .map((ia) => `${ia.access.location.line}:${ia.access.location.column}`)
        .sort()
        .join(",")
      const key = `${v.pattern}:${[...v.variables].sort().join(",")}:${mainPos}:${isrPos}`
      if (seenViolations.has(key)) continue
      seenViolations.add(key)
      dedupedViolations.push(v)
    }

    // Re-number violations sequentially after dedup
    for (let i = 0; i < dedupedViolations.length; i++) {
      dedupedViolations[i].id = `av_${String(i + 1).padStart(4, "0")}`
    }

    const summary = {
      total: dedupedViolations.length,
      by_pattern: {
        DFC_RWWR: dedupedViolations.filter((v) => v.pattern === "DFC_RWWR").length,
        TUP_WRRW: dedupedViolations.filter((v) => v.pattern === "TUP_WRRW").length,
        TUP_WWWW: dedupedViolations.filter((v) => v.pattern === "TUP_WWWW").length,
        DAC_RWWW: dedupedViolations.filter((v) => v.pattern === "DAC_RWWW").length,
        DAC_RWWR: dedupedViolations.filter((v) => v.pattern === "DAC_RWWR").length,
      },
      candidate_stats: {
        raw_candidates: rawCandidateTotal,
        raw_by_pattern: rawByPattern,
        after_dedup: dedupedViolations.length,
        duplicates_removed: rawCandidateTotal - dedupedViolations.length,
        correlated_groups_involved: candidateGroupIds.size,
        variable_pairs_involved: candidateVarPairs.size,
        input_groups_total: uniqueGroups.length,
        total_accesses_queried: allAccesses.length,
      },
    }

    const result = {
      status: "success",
      violations: dedupedViolations,
      summary,
    }

    const resultJson = JSON.stringify(result)

    // Write result to file if output_path is specified
    if (output_path) {
      try {
        const dir = join(output_path, "..")
        mkdirSync(dir, { recursive: true })
        writeFileSync(output_path, JSON.stringify(result, null, 2), "utf-8")
      } catch { /* best-effort file write */ }
    }

    // Write Markdown summary if md_output_path is specified
    if (md_output_path) {
      try {
        const mdDir = join(md_output_path, "..")
        mkdirSync(mdDir, { recursive: true })
        const md = generateCandidatesMd(dedupedViolations, summary)
        writeFileSync(md_output_path, md, "utf-8")
      } catch { /* best-effort */ }
    }

    return resultJson
  },
})
