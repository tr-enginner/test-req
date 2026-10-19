import type { Fixability } from "../../schema/spec-repair"

/** Rules that can be auto-fixed with deterministic templates */
export const AUTO_FIXABLE_RULES = new Set([
  "CID072", "CID162", "CID3000", "CID181", "CID295", "CID4066",
  "CID126", "CID120", "CID4032", "CID250", "CID147", "CID070",
  "CID152", "CID065", "CID167", "CID283", "CID4605", "CID4059", "CID4113",
])

/** Rules that require human review */
export const NEEDS_REVIEW_RULES = new Set([
  "CID148", "CID138", "CID216", "CID254", "CID249",
  "CID185", "CID118", "CID129", "CID132",
  "CID069", "CID225", "CID4170", "CID4120",
  "CID087", "CID182", "CID4089", "CID4169",
  "CID669", "CID4079",
])

/** Rules that are generally unfixable by automation */
export const UNFIXABLE_RULES = new Set([
  "CID555",  // Compilation errors
  "CID293",  // Comment rate
  "CID274",  // Cyclomatic complexity
  "CID039",  // Function length > 200 lines
])

/** Classify an issue's fixability based on its rule ID */
export function classifyIssue(ruleId: string): Fixability {
  if (UNFIXABLE_RULES.has(ruleId)) return "unfixable"
  if (AUTO_FIXABLE_RULES.has(ruleId)) return "auto_fixable"
  if (NEEDS_REVIEW_RULES.has(ruleId)) return "needs_review"
  return "needs_review"  // default
}
