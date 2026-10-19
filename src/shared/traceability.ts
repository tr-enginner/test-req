import type { SoftwareAnalysisReport } from "../schema/sut"
import type { TestRequirementsArtifact } from "../schema/test-requirement"
import type { ConfirmationTestSuite } from "../schema/confirmation-test-case"
import type { UnitTestReport } from "../schema/unit-test-case"
import type { TestExecutionReport } from "../schema/test-execution"
import type { DefectDatabase } from "../schema/defect"
import { expandFunIdString, normalizeTestRequirements, splitFunIds } from "./test-requirements"

/** Full traceability chain entry:
 *  SRS-ID → TR-ID → CT-ID/UT-ID → EXEC-ID → DEF-ID
 */
export interface TraceabilityEntry {
  software_req_id: string
  software_req_title: string
  test_req_ids: string[]
  unit_test_ids: string[]
  confirmation_test_ids: string[]
  execution_ids: string[]
  defect_ids: string[]
  coverage_status: "full" | "partial" | "none"
}

/** Build full traceability matrix from all structured data */
export function buildTraceabilityMatrix(options: {
  analysis?: SoftwareAnalysisReport | null
  testReqs?: TestRequirementsArtifact | null
  unitTests?: UnitTestReport | null
  confirmationTests?: ConfirmationTestSuite | null
  testExecution?: TestExecutionReport | null
  defects?: DefectDatabase | null
}): TraceabilityEntry[] {
  const { analysis, testReqs, unitTests, confirmationTests, testExecution, defects } = options

  if (!analysis) return []

  const normalizedTestReqs = normalizeTestRequirements(testReqs)

  const entries: TraceabilityEntry[] = []

  for (const req of analysis.requirements) {
    const entry: TraceabilityEntry = {
      software_req_id: req.id,
      software_req_title: req.title,
      test_req_ids: [],
      unit_test_ids: [],
      confirmation_test_ids: [],
      execution_ids: [],
      defect_ids: [],
      coverage_status: "none",
    }

    // SRS → TR mapping
    if (normalizedTestReqs.length > 0) {
      for (const tr of normalizedTestReqs) {
        if (tr.source_requirement_ids.includes(req.id)) {
          entry.test_req_ids.push(tr.id)
        }
      }
    }

    // TR → UT mapping
    if (unitTests) {
      for (const ut of unitTests.test_cases) {
        if (ut.related_requirement_ids.some((id) => entry.test_req_ids.includes(id) || id === req.id)) {
          entry.unit_test_ids.push(ut.id)
        }
      }
    }

    // TR → CT mapping (via correspond_fun_id or optional related_software_req_ids extension)
    if (confirmationTests) {
      for (const ct of confirmationTests.test_cases) {
        // Skip test cases whose translation failed — they cannot be executed by DTP.
        if (ct.translate_status && !["success", "not_applicable"].includes(ct.translate_status)) continue
        // correspond_fun_id may be a 、-separated multi-ID string — check overlap with
        // this SRS's TR IDs (which may themselves be 、-joined when funId is an array).
        const caseFunIds = splitFunIds(ct.correspond_fun_id)
        const trOverlap = caseFunIds.some((id) =>
          entry.test_req_ids.some((trId) => splitFunIds(trId).includes(id)),
        )
        // related_software_req_ids is now a range-style string — expand both
        // it and correspond_fun_id to atomic IDs for membership checks.
        const caseTrIds = new Set([
          ...expandFunIdString(ct.correspond_fun_id ?? ""),
          ...expandFunIdString(ct.related_software_req_ids ?? ""),
        ])
        if (
          caseTrIds.has(req.id) ||
          entry.test_req_ids.includes(ct.correspond_fun_id) ||
          trOverlap
        ) {
          entry.confirmation_test_ids.push(ct.case_id)
        }
      }
    }

    // CT → EXEC mapping
    if (testExecution) {
      for (const exec of testExecution.executions) {
        if (entry.confirmation_test_ids.includes(exec.test_case_id)) {
          entry.execution_ids.push(exec.execution_id)
        }
      }
    }

    // DEF mapping
    if (defects) {
      for (const def of defects.defects) {
        if (def.related_requirement_ids.some(
          (id) => id === req.id || entry.test_req_ids.includes(id),
        )) {
          entry.defect_ids.push(def.id)
        }
      }
    }

    // Calculate coverage status
    if (entry.test_req_ids.length > 0 && (entry.unit_test_ids.length > 0 || entry.confirmation_test_ids.length > 0)) {
      entry.coverage_status = "full"
    } else if (entry.test_req_ids.length > 0) {
      entry.coverage_status = "partial"
    } else {
      entry.coverage_status = "none"
    }

    entries.push(entry)
  }

  return entries
}

/** Calculate coverage statistics from traceability matrix */
export function calculateCoverageStats(matrix: TraceabilityEntry[]) {
  const total = matrix.length
  const full = matrix.filter((e) => e.coverage_status === "full").length
  const partial = matrix.filter((e) => e.coverage_status === "partial").length
  const none = matrix.filter((e) => e.coverage_status === "none").length

  return {
    total_requirements: total,
    fully_covered: full,
    partially_covered: partial,
    not_covered: none,
    coverage_pct: total > 0 ? Math.round(((full + partial * 0.5) / total) * 100) : 0,
  }
}
