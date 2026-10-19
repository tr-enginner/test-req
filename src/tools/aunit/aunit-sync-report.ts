import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, readFileSync, mkdirSync, createWriteStream } from "fs"
import { join, dirname } from "path"
import { normalizePath, AUNIT_WORKSPACE, normalizeProjectDir, scanGsonPaths } from "./aunit-utils"
import { ARTIFACT_PATHS } from "../../shared/constants"
import { readGsonFile } from "./gbk-encoding"

/**
 * aunit_sync_report — Sync AUnit's gson execution results to Matrix unit-tests.json.
 * Reads actual test data from gson files and writes it in Matrix UnitTestReport format.
 * Eliminates data fabrication by using only real AUnit execution data.
 *
 * Uses streaming JSON write to avoid holding the entire report in memory.
 * Reads gson files in GBK encoding (AUnit/Java default on Chinese Windows).
 * Writes Matrix report in UTF-8 (standard JSON encoding).
 */
export const aunitSyncReport: ToolDefinition = tool({
  description:
    "Synchronize AUnit execution results from gson files to Matrix report format. " +
    "Scans all gson files in the AUnit project, extracts real test case data " +
    "(inputs, outputs, coverage, verdicts), and writes .matrix/data/unit-tests.json. " +
    "Must be called AFTER aunit_run_case completes.",
  args: {
    project_name: tool.schema.string().describe("AUnit project name"),
    project_dir: tool.schema.string().describe("Project root directory"),
    version: tool.schema
      .string()
      .optional()
      .describe("Project version (default: '1.0')"),
    failure_analysis_path: tool.schema
      .string()
      .optional()
      .describe(
        "Path to failure analysis JSON file written by the agent during Step 6b. " +
        "Format: Record<test_case_id, { classification, root_cause, defect_id?, requirement_mismatch, corrected }>. " +
        "If provided, failure analysis data is merged into result entries and a failure_analysis_summary is generated."
      ),
  },
  async execute({ project_name, project_dir, version, failure_analysis_path }) {
    const projDir = normalizePath(normalizeProjectDir(project_dir))
    const utDir = join(projDir, AUNIT_WORKSPACE, project_name, "meta", "model", "UT")

    if (!existsSync(utDir)) {
      return JSON.stringify({
        error: `AUnit UT directory not found at ${utDir}. Run aunit_build + aunit_run_case first.`,
      })
    }

    // Lightweight path-only scan (no file reads)
    const gsonFiles = scanGsonPaths(utDir)
    if (gsonFiles.length === 0) {
      return JSON.stringify({
        error: `No function-level gson files found under ${utDir}.`,
      })
    }

    // Load failure analysis data if provided
    let failureAnalysisMap: Record<string, any> = {}
    if (failure_analysis_path) {
      const faPath = normalizePath(failure_analysis_path)
      if (existsSync(faPath)) {
        try {
          failureAnalysisMap = JSON.parse(readFileSync(faPath, "utf-8"))
        } catch {
          // Ignore parse errors — proceed without failure analysis
        }
      }
    }

    // Failure analysis summary counters
    const faSummary = {
      code_defects: 0,
      test_case_errors: 0,
      requirement_gaps: 0,
      unresolved: 0,
      requirement_mismatches: 0,
    }

    const outPath = join(projDir, ARTIFACT_PATHS.UNIT_TESTS)
    const outDir = dirname(outPath)
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })

    // Use a temp file for streaming write, then rename on success
    const tmpPath = outPath + ".tmp"

    // Aggregate counters (no raw data accumulation)
    const aggregateCoverage: Record<string, { covered: number; total: number }> = {
      line: { covered: 0, total: 0 },
      branch: { covered: 0, total: 0 },
      mcdc: { covered: 0, total: 0 },
    }

    // Per-function: only counters, no per-case arrays
    const perFuncData: Map<string, {
      passed: number
      failed: number
      total: number
      by_source: { autogen: number; functional: number; coverage_supplement: number }
      coverage: { line: { covered: number; total: number }; branch: { covered: number; total: number }; mcdc: { covered: number; total: number } }
    }> = new Map()

    // By-source aggregate counters
    const bySourceAgg = {
      autogen: { total: 0, passed: 0, failed: 0 },
      functional: { total: 0, passed: 0, failed: 0 },
      coverage_supplement: { total: 0, passed: 0, failed: 0 },
    }

    let totalCases = 0
    let totalPassed = 0
    let totalFailed = 0
    let totalResults = 0

    // ── Streaming JSON write ──
    // Write test_cases and results arrays in chunks to avoid holding everything in memory
    const ws = createWriteStream(tmpPath, { encoding: "utf-8" })

    // Write header
    ws.write('{\n')
    ws.write(`  "project_name": ${JSON.stringify(project_name)},\n`)
    ws.write(`  "version": ${JSON.stringify(version || "1.0")},\n`)
    ws.write(`  "created_date": ${JSON.stringify(new Date().toISOString().split("T")[0])},\n`)

    // ── Stream test_cases array ──
    ws.write('  "test_cases": [\n')
    let firstCase = true

    // Collect results in a temp array per chunk, then flush
    // We write results after test_cases, so buffer result entries to a temp file
    const resultEntries: string[] = [] // We still need results for ordering, but each is small (~200 bytes)

    const CHUNK_SIZE = 50
    for (let ci = 0; ci < gsonFiles.length; ci += CHUNK_SIZE) {
      const chunk = gsonFiles.slice(ci, ci + CHUNK_SIZE)

      for (const gsonPath of chunk) {
        let gson: any
        try {
          gson = readGsonFile(gsonPath)
        } catch {
          continue
        }

        const funcName = gson.entry?.funcName
        if (!funcName) continue // Skip files without valid funcName

        const observedExprs: string[] = gson.entry?.observedExprs || ["returnValue"]
        const isVoidFunction = !observedExprs.includes("returnValue")
        const cases: any[] = gson.cases || []

        // Initialize per-function counters
        if (!perFuncData.has(funcName)) {
          perFuncData.set(funcName, {
            passed: 0,
            failed: 0,
            total: 0,
            by_source: { autogen: 0, functional: 0, coverage_supplement: 0 },
            coverage: {
              line: { covered: 0, total: 0 },
              branch: { covered: 0, total: 0 },
              mcdc: { covered: 0, total: 0 },
            },
          })
        }
        const funcCounters = perFuncData.get(funcName)!

        for (const c of cases) {
          const caseId = `UT-${funcName}-${c.caseId}`
          const caseSource = classifyCaseSource(c)
          const reqIds = extractRequirementIds(c)

          const inputs: any[] = (c.paraExprs || []).map((p: any) => ({
            name: p.expr,
            type: "auto",
            value: String(p.in),
          }))

          if (Array.isArray(c.gVars)) {
            for (const gv of c.gVars) {
              if (gv.in && gv.in !== "") {
                inputs.push({
                  name: `${gv.expr} (global, initial)`,
                  type: "auto",
                  value: String(gv.in),
                })
              }
            }
          }

          if (Array.isArray(c.IOValues)) {
            for (const io of c.IOValues) {
              if (io.value && io.value !== "") {
                inputs.push({
                  name: `IO@0x${Number(io.addr).toString(16).toUpperCase()}`,
                  type: "auto",
                  value: String(io.value),
                })
              }
            }
          }

          const typeLabel = c.types?.[0]?.type || ""
          const designMethod = mapTypeToDesignMethod(typeLabel, c.isAIGen)

          const expectedOutputs: any[] = []
          if (c.retValue && c.retValue !== "" && !isVoidFunction) {
            expectedOutputs.push({ name: "returnValue", type: "auto", value: String(c.retValue) })
          }
          if (Array.isArray(c.gVars)) {
            for (const gv of c.gVars) {
              if (gv.out && gv.out !== "") {
                expectedOutputs.push({ name: gv.expr, type: "auto", value: String(gv.out) })
              }
            }
          }
          if (expectedOutputs.length === 0) {
            for (const expr of observedExprs) {
              expectedOutputs.push({ name: expr, type: "auto", value: "N/A" })
            }
          }

          const testCase = {
            id: caseId,
            target_function_id: funcName,
            target_function_name: funcName,
            related_requirement_ids: reqIds,
            title: c.desc || c.caseName || `${funcName} case ${c.caseId}`,
            description: c.desc || `Auto-synced from AUnit gson (caseId=${c.caseId})`,
            design_method: designMethod,
            preconditions: ["AUnit project built and analyzed"],
            inputs,
            expected_outputs: expectedOutputs,
            stubs: [],
            postconditions: [],
            case_source: caseSource,
          }

          // Stream write test case
          if (!firstCase) ws.write(',\n')
          ws.write('    ' + JSON.stringify(testCase))
          firstCase = true // reset below
          firstCase = false
          totalCases++

          // Update counters
          funcCounters.total++
          funcCounters.by_source[caseSource]++
          bySourceAgg[caseSource].total++

          // Process result
          if (c.result && c.result.status) {
            const verdict = c.result.status === "OK" ? "pass" : "fail"
            const actualOutputs = (c.result.obValues || []).map((ob: any) => ({
              name: ob.expr,
              type: "auto",
              value: String(ob.value),
            }))

            const resultEntry: any = {
              test_case_id: caseId,
              verdict,
              actual_outputs: actualOutputs,
              executed_date: c.result.LastRunTime || new Date().toISOString().split("T")[0],
            }

            // Merge failure analysis if available
            const fa = failureAnalysisMap[caseId]
            if (fa && verdict === "fail") {
              resultEntry.failure_analysis = {
                classification: fa.classification,
                root_cause: fa.root_cause || "",
                ...(fa.defect_id ? { defect_id: fa.defect_id } : {}),
                requirement_mismatch: !!fa.requirement_mismatch,
                corrected: !!fa.corrected,
              }
              // Update summary counters
              switch (fa.classification) {
                case "code_defect": faSummary.code_defects++; break
                case "test_case_error": faSummary.test_case_errors++; break
                case "requirement_gap": faSummary.requirement_gaps++; break
                case "unresolved": faSummary.unresolved++; break
              }
              if (fa.requirement_mismatch) faSummary.requirement_mismatches++
            }

            resultEntries.push(JSON.stringify(resultEntry))

            totalResults++
            if (verdict === "pass") {
              totalPassed++
              funcCounters.passed++
              bySourceAgg[caseSource].passed++
            } else {
              totalFailed++
              funcCounters.failed++
              bySourceAgg[caseSource].failed++
            }
          }
        }

        // Accumulate per-function coverage (counters only)
        if (gson.coverageMap) {
          for (const [, cov] of Object.entries(gson.coverageMap as Record<string, any>)) {
            parseCoverageField(cov.lineCov, aggregateCoverage.line)
            parseCoverageField(cov.branchCov, aggregateCoverage.branch)
            parseCoverageField(cov.mcdcCov, aggregateCoverage.mcdc)
            parseCoverageField(cov.lineCov, funcCounters.coverage.line)
            parseCoverageField(cov.branchCov, funcCounters.coverage.branch)
            parseCoverageField(cov.mcdcCov, funcCounters.coverage.mcdc)
          }
        }
      }
      // Chunk boundary: references to gson data in this chunk are released
    }

    ws.write('\n  ],\n')

    // ── Stream results array ──
    ws.write('  "results": [\n')
    for (let i = 0; i < resultEntries.length; i++) {
      if (i > 0) ws.write(',\n')
      ws.write('    ' + resultEntries[i])
    }
    ws.write('\n  ],\n')

    // Free result entries
    resultEntries.length = 0

    // ── Coverage ──
    const covStatement = aggregateCoverage.line.total > 0
      ? Math.round((aggregateCoverage.line.covered / aggregateCoverage.line.total) * 10000) / 100
      : undefined
    const covBranch = aggregateCoverage.branch.total > 0
      ? Math.round((aggregateCoverage.branch.covered / aggregateCoverage.branch.total) * 10000) / 100
      : undefined
    const covMcdc = aggregateCoverage.mcdc.total > 0
      ? Math.round((aggregateCoverage.mcdc.covered / aggregateCoverage.mcdc.total) * 10000) / 100
      : undefined

    const passRate = totalCases > 0 ? Math.round((totalPassed / totalCases) * 10000) / 100 : 0

    // ── Write coverage, summary, per_function_summary ──
    ws.write(`  "coverage": ${JSON.stringify({
      statement: covStatement,
      branch: covBranch,
      mc_dc: covMcdc,
      uncovered_functions: [],
    })},\n`)

    const hasFaSummary = faSummary.code_defects + faSummary.test_case_errors + faSummary.requirement_gaps + faSummary.unresolved > 0

    ws.write(`  "summary": ${JSON.stringify({
      total_cases: totalCases,
      passed: totalPassed,
      failed: totalFailed,
      error: 0,
      skip: totalCases - totalResults,
      pass_rate: passRate,
      by_source: bySourceAgg,
      ...(hasFaSummary ? { failure_analysis_summary: faSummary } : {}),
    })},\n`)

    // Build per_function_summary from counters
    const perFunctionSummary: any[] = []
    for (const [funcName, data] of perFuncData) {
      const covLine = data.coverage.line.total > 0
        ? Math.round((data.coverage.line.covered / data.coverage.line.total) * 10000) / 100
        : undefined
      const covBr = data.coverage.branch.total > 0
        ? Math.round((data.coverage.branch.covered / data.coverage.branch.total) * 10000) / 100
        : undefined
      const covMc = data.coverage.mcdc.total > 0
        ? Math.round((data.coverage.mcdc.covered / data.coverage.mcdc.total) * 10000) / 100
        : undefined

      perFunctionSummary.push({
        function_name: funcName,
        total_cases: data.total,
        passed: data.passed,
        failed: data.failed,
        by_source: data.by_source,
        coverage: { statement: covLine, branch: covBr, mc_dc: covMc },
      })
    }

    ws.write(`  "per_function_summary": ${JSON.stringify(perFunctionSummary)}\n`)
    ws.write('}\n')

    // Wait for stream to finish
    await new Promise<void>((resolve, reject) => {
      ws.end(() => resolve())
      ws.on("error", reject)
    })

    // Rename temp to final
    const { renameSync } = await import("fs")
    renameSync(tmpPath, outPath)

    return JSON.stringify({
      status: "success",
      file: ARTIFACT_PATHS.UNIT_TESTS,
      functions_synced: perFuncData.size,
      total_cases: totalCases,
      passed: totalPassed,
      failed: totalFailed,
      skip: totalCases - totalResults,
      pass_rate: passRate,
      coverage: { statement: covStatement, branch: covBranch, mc_dc: covMcdc },
      message: `Synced ${totalCases} test cases from ${gsonFiles.length} gson files. ` +
        `${totalPassed} passed, ${totalFailed} failed. ` +
        `Coverage: line=${covStatement ?? "N/A"}%, branch=${covBranch ?? "N/A"}%, MC/DC=${covMcdc ?? "N/A"}%.`,
    })
  },
})

/** Parse "6/6" → add to accumulator {covered, total} */
function parseCoverageField(
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

/** Map AUnit type label to Matrix design_method enum */
function mapTypeToDesignMethod(typeLabel: string, isAIGen: boolean): string {
  if (typeLabel.includes("覆盖率补充")) return "basic_path"
  if (typeLabel.includes("功能")) return "equivalence_partition"
  if (typeLabel.includes("边界")) return "boundary_value"
  if (typeLabel.includes("路径")) return "basic_path"
  if (typeLabel.includes("条件") || typeLabel.includes("MC/DC")) return "condition_combination"
  if (typeLabel.includes("状态")) return "state_transition"
  if (isAIGen) return "equivalence_partition"
  return "condition_combination"
}

/** Classify case source from gson case data */
function classifyCaseSource(c: any): "autogen" | "functional" | "coverage_supplement" {
  const typeLabel = c.types?.[0]?.type || ""
  if (!c.isAIGen) return "autogen" // Z3 auto-generated cases have no isAIGen or isAIGen=false
  if (typeLabel.includes("覆盖率补充")) return "coverage_supplement"
  return "functional" // isAIGen=true and not coverage supplement → functional case
}

/** Extract requirement IDs from types[].comment and desc fields */
function extractRequirementIds(c: any): string[] {
  const ids = new Set<string>()
  const regex = /((?:REQ|TR|SR)-[\w-]+)/g
  // Search types[].comment
  for (const t of (c.types || [])) {
    for (const m of (t.comment || "").matchAll(regex)) ids.add(m[1])
  }
  // Search desc
  for (const m of (c.desc || "").matchAll(regex)) ids.add(m[1])
  return [...ids]
}
