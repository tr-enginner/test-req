import type { RiskLevel, PatchHunk } from "../../schema/spec-repair"

interface PatternDef {
  pattern: RegExp
  description: string
}

/** Patterns that indicate dangerous code changes */
const DANGEROUS_PATTERNS: PatternDef[] = [
  { pattern: /\bsystem\s*\(/, description: "system() call" },
  { pattern: /\bexec[lvpe]*\s*\(/, description: "exec family call" },
  { pattern: /\bgets\s*\(/, description: "unsafe gets() call" },
  { pattern: /\bstrcpy\s*\(/, description: "unsafe strcpy()" },
  { pattern: /\bsprintf\s*\(/, description: "unsafe sprintf()" },
  { pattern: /#\s*pragma\s+/, description: "pragma directive" },
  { pattern: /\b__asm\b|\basm\s*\(/, description: "inline assembly" },
]

/** Patterns indicating structural changes */
const STRUCTURAL_PATTERNS: PatternDef[] = [
  { pattern: /\bmalloc\s*\(/, description: "dynamic memory allocation" },
  { pattern: /\bcalloc\s*\(/, description: "dynamic memory allocation" },
  { pattern: /\brealloc\s*\(/, description: "dynamic memory reallocation" },
  { pattern: /\bfree\s*\(/, description: "memory deallocation" },
  { pattern: /\bgoto\s+/, description: "goto statement" },
  { pattern: /\bsetjmp\s*\(|\blongjmp\s*\(/, description: "setjmp/longjmp" },
]

const RISK_ORDER: RiskLevel[] = ["safe", "low", "medium", "high", "dangerous"]

function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_ORDER.indexOf(a) >= RISK_ORDER.indexOf(b) ? a : b
}

/** Count pattern matches in text */
function countMatches(text: string, pattern: RegExp): number {
  const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g")
  return (text.match(global) || []).length
}

/** Assess risk level of a single patch hunk */
export function assessPatchRisk(hunk: PatchHunk): { level: RiskLevel; warnings: string[] } {
  const warnings: string[] = []
  let risk: RiskLevel = "safe"

  const { original_code, repaired_code } = hunk

  // Check dangerous patterns (new in repaired, not in original)
  for (const { pattern, description } of DANGEROUS_PATTERNS) {
    if (countMatches(repaired_code, pattern) > countMatches(original_code, pattern)) {
      warnings.push(`Introduces ${description}`)
      risk = "dangerous"
    }
  }

  // Check structural patterns
  for (const { pattern, description } of STRUCTURAL_PATTERNS) {
    if (countMatches(repaired_code, pattern) > countMatches(original_code, pattern)) {
      warnings.push(`Introduces ${description}`)
      risk = maxRisk(risk, "high")
    }
  }

  // Change magnitude
  const origLines = original_code.trim().split("\n").length
  const newLines = repaired_code.trim().split("\n").length
  const diff = Math.abs(newLines - origLines)
  if (diff > 20) {
    warnings.push(`Large change: ${diff} lines difference`)
    risk = maxRisk(risk, "medium")
  } else if (diff > 5) {
    risk = maxRisk(risk, "low")
  }

  // Empty replacement
  if (!repaired_code.trim() && original_code.trim()) {
    warnings.push("Deletes code entirely")
    risk = maxRisk(risk, "high")
  }

  return { level: risk, warnings }
}
