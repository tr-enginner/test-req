import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, join } from "path"
import { SourceConfirmationTestSuite, type SourceConfirmationTestSuite as SourceConfirmationTestSuiteType } from "../schema/confirmation-test-case"
import { ARTIFACT_PATHS } from "./constants"

export interface Phase6TodoWriteResult {
  todo_file: string
  case_ids: string[]
  case_count: number
  reason: string
}

function ensureDir(filePath: string): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

export function extractPhase6CaseIds(sourceSuite: SourceConfirmationTestSuiteType): string[] {
  const seen = new Set<string>()
  const caseIds: string[] = []

  for (const testCase of sourceSuite.test_cases) {
    const caseId = testCase.case_id.trim()
    if (!caseId || seen.has(caseId)) continue
    seen.add(caseId)
    caseIds.push(caseId)
  }

  return caseIds
}

export function writePhase6TestCasesTodoFile(
  projectDir: string,
  caseIds: string[],
  reason = "full_suite",
): Phase6TodoWriteResult {
  const todoFile = join(projectDir, ARTIFACT_PATHS.PHASE6_TEST_CASES_TODO)
  ensureDir(todoFile)
  writeFileSync(todoFile, caseIds.length > 0 ? `${caseIds.join("\n")}\n` : "", "utf-8")

  return {
    todo_file: ARTIFACT_PATHS.PHASE6_TEST_CASES_TODO,
    case_ids: caseIds,
    case_count: caseIds.length,
    reason,
  }
}

export function writePhase6TestCasesTodoFromSuite(
  projectDir: string,
  sourceSuite: SourceConfirmationTestSuiteType,
  reason = "full_suite",
): Phase6TodoWriteResult {
  return writePhase6TestCasesTodoFile(projectDir, extractPhase6CaseIds(sourceSuite), reason)
}

export function ensurePhase6TodoFromSourceSuiteFile(
  projectDir: string,
  sourceSuiteFile: string,
  reason = "full_suite",
): Phase6TodoWriteResult {
  const raw = JSON.parse(readFileSync(sourceSuiteFile, "utf-8"))
  const sourceSuite = SourceConfirmationTestSuite.parse(raw)
  return writePhase6TestCasesTodoFromSuite(projectDir, sourceSuite, reason)
}
