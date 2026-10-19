import type { PatchHunk } from "../../schema/spec-repair"

/** A builtin repair strategy function */
type RepairStrategy = (fileLines: string[], line: number) => PatchHunk | null

/** Registry of built-in deterministic repair strategies by rule ID */
const strategies = new Map<string, RepairStrategy>()

function register(ruleId: string, fn: RepairStrategy) {
  strategies.set(ruleId, fn)
}

/** Helper to build a PatchHunk */
function hunk(file: string, startLine: number, endLine: number, original: string, repaired: string): PatchHunk {
  return { file, start_line: startLine, end_line: endLine, original_code: original, repaired_code: repaired }
}

// CID181: Remove goto statement
register("CID181", (lines, ln) => {
  if (ln < 1 || ln > lines.length) return null
  const original = lines[ln - 1]
  if (!original.includes("goto")) return null
  const repaired = original.replace(/\bgoto\b/, "/* goto removed */  //")
  return hunk("", ln, ln, original, repaired)
})

// CID4066: for(;;) → while(1)
register("CID4066", (lines, ln) => {
  if (ln < 1 || ln > lines.length) return null
  const original = lines[ln - 1]
  if (!original.includes("for") || !original.includes(";;")) return null
  const repaired = original.replace(/for\s*\(\s*;;\s*\)/, "while (1)")
  return hunk("", ln, ln, original, repaired)
})

// CID4032: Replace 0 with NULL for pointer initialization
register("CID4032", (lines, ln) => {
  if (ln < 1 || ln > lines.length) return null
  const original = lines[ln - 1]
  let repaired = original.replace(/=\s*\(\s*\w+\s*\*\s*\)\s*0\b/, "= NULL")
  repaired = repaired.replace(/=\s*0\s*;(\s*\/\*.*?\*\/)?$/, "= NULL;$1")
  if (repaired === original) return null
  return hunk("", ln, ln, original, repaired)
})

// CID3000: Add braces to if/else statements
register("CID3000", (lines, ln) => {
  if (ln < 1 || ln > lines.length) return null
  const idx = ln - 1
  const current = lines[idx]
  if (idx + 1 >= lines.length) return null
  const next = lines[idx + 1]
  if (!next.trim() || next.trim().startsWith("{")) return null
  const indent = current.match(/^(\s*)/)?.[1] ?? ""
  const origBlock = current + "\n" + next
  const repaired = current.trimEnd() + " {\n" + next + "\n" + indent + "}"
  return hunk("", ln, ln + 1, origBlock, repaired)
})

// CID162: Add braces to loop bodies (same logic as CID3000)
register("CID162", (lines, ln) => {
  const s = strategies.get("CID3000")
  return s ? s(lines, ln) : null
})

// CID065: Add comment in empty else branch
register("CID065", (lines, ln) => {
  if (ln < 1 || ln > lines.length) return null
  const idx = ln - 1
  const current = lines[idx]
  if (!current.includes("else") || !current.includes("{")) return null
  for (let i = idx + 1; i < Math.min(idx + 3, lines.length); i++) {
    const line = lines[i]
    if (line.includes("}") && !line.trim().replace(/}/g, "").trim()) {
      const indent = (line.match(/^(\s*)/)?.[1] ?? "") + "    "
      const origBlock = lines.slice(idx, i + 1).join("\n")
      const repairedLines = [...lines.slice(idx, i), indent + "/* No action required */", lines[i]]
      return hunk("", ln, i + 1, origBlock, repairedLines.join("\n"))
    }
  }
  return null
})

// CID126: Convert nested comments to single-line comments
register("CID126", (lines, ln) => {
  if (ln < 1 || ln > lines.length) return null
  const original = lines[ln - 1]
  const repaired = original.replace(/\/\*/g, "//").replace(/\*\//g, "")
  if (repaired === original) return null
  return hunk("", ln, ln, original, repaired)
})

// CID4605: Add break to case fallthrough
register("CID4605", (lines, ln) => {
  if (ln < 1 || ln > lines.length) return null
  const original = lines[ln - 1]
  const indent = (original.match(/^(\s*)/)?.[1] ?? "") + "    "
  const repaired = original + "\n" + indent + "break;"
  return hunk("", ln, ln, original, repaired)
})

/** Try to generate a deterministic repair for a given rule violation */
export function tryBuiltinRepair(ruleId: string, filePath: string, fileLines: string[], violationLine: number): PatchHunk | null {
  const strategy = strategies.get(ruleId)
  if (!strategy) return null
  const result = strategy(fileLines, violationLine)
  if (result) result.file = filePath
  return result
}

/** Check if a builtin strategy exists for a rule */
export function hasBuiltinStrategy(ruleId: string): boolean {
  return strategies.has(ruleId)
}
