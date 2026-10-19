import { BUILTIN_SKILLS, type SkillEntry } from "./skills-data"
import type { PatchHunk } from "../../schema/spec-repair"

/** Index skills by rule ID for fast lookup */
const ruleIndex = new Map<string, SkillEntry[]>()
for (const skill of BUILTIN_SKILLS) {
  for (const ruleId of skill.rule_ids) {
    const existing = ruleIndex.get(ruleId) || []
    existing.push(skill)
    ruleIndex.set(ruleId, existing)
  }
}

/** Find all skills matching a rule ID */
export function findSkillsForRule(ruleId: string): SkillEntry[] {
  return ruleIndex.get(ruleId) || []
}

/** Get skill context for LLM reasoning (fix_template + examples) */
export function getSkillContext(ruleId: string): { skill_name: string; fix_template: string; check_pattern: string; examples: SkillEntry["examples"] } | null {
  const skills = findSkillsForRule(ruleId)
  if (skills.length === 0) return null
  // Pick highest priority skill
  const best = skills.reduce((a, b) => a.priority >= b.priority ? a : b)
  return {
    skill_name: best.name,
    fix_template: best.fix_template,
    check_pattern: best.check_pattern,
    examples: best.examples,
  }
}

/** Try to apply a skill's check_pattern as regex repair */
export function trySkillRepair(ruleId: string, filePath: string, fileLines: string[], violationLine: number): PatchHunk | null {
  const skills = findSkillsForRule(ruleId)
  if (skills.length === 0) return null
  if (violationLine < 1 || violationLine > fileLines.length) return null

  // Try each skill's check_pattern
  for (const skill of skills) {
    if (!skill.check_pattern) continue
    try {
      const pattern = new RegExp(skill.check_pattern)
      const original = fileLines[violationLine - 1]
      if (pattern.test(original)) {
        // Apply fix_template as simple replacement hint
        // For regex-based patterns, try direct replacement
        const repaired = original.replace(pattern, skill.fix_template)
        if (repaired !== original) {
          return {
            file: filePath,
            start_line: violationLine,
            end_line: violationLine,
            original_code: original,
            repaired_code: repaired,
          }
        }
      }
    } catch {
      // Invalid regex in check_pattern, skip
      continue
    }
  }
  return null
}

/** Get total count of loaded skills */
export function getSkillCount(): number {
  return BUILTIN_SKILLS.length
}
