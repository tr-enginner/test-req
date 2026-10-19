import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, readFileSync, readdirSync } from "fs"
import { join } from "path"
import { normalizePath, AUNIT_WORKSPACE, normalizeProjectDir, sanitizeCaseValue, sanitizeSequenceValue } from "./aunit-utils"
import { readGsonFile, writeGsonFile, decodeGbk } from "./gbk-encoding"

/**
 * aunit_enrich_cases — Enrich existing AUnit test cases with expected values and descriptions.
 *
 * After aunit_autogen, the Z3-solver-generated cases lack retValue (expected return value)
 * and meaningful desc (test description). This tool updates those fields in-place
 * without creating new cases.
 *
 * Also used in the failure-analysis loop to correct retValue/gVars after execution.
 *
 * Reads/writes gson files in GBK encoding.
 */
/** Single enrichment item schema (shared by single and batch modes) */
const enrichmentItemSchema = tool.schema.object({
  caseId: tool.schema.number().describe("Case ID to enrich (must exist in gson)"),
  retValue: tool.schema
    .string()
    .optional()
    .describe("Expected return value to set (e.g. '200', '-1')"),
  gVars: tool.schema
    .array(
      tool.schema.object({
        expr: tool.schema.string().describe("Global variable name"),
        in: tool.schema.string().describe("Input value (initial state)"),
        out: tool.schema.string().describe("Expected output value after execution"),
      }),
    )
    .optional()
    .describe("Global variable expectations to set or update"),
  stubInss: tool.schema
    .array(
      tool.schema.object({
        stubName: tool.schema.string().describe("Stub function name"),
        inputs: tool.schema
          .array(
            tool.schema.object({
              expr: tool.schema.string().describe("Expression name (e.g. 'returnValue')"),
              value: tool.schema.string().describe("Value or semicolon-separated value sequence"),
            }),
          )
          .describe("Stub input values"),
        expects: tool.schema
          .array(tool.schema.any())
          .optional()
          .describe("Expected observations (usually empty)"),
      }),
    )
    .optional()
    .describe("Stub function input settings to set or update (merged by stubName)"),
  iterTimes: tool.schema
    .string()
    .optional()
    .describe("Number of times the function under test is called within one case execution (default '1'). Set >1 when static variables or persistent state require multiple calls for branch coverage"),
  IOValues: tool.schema
    .array(
      tool.schema.object({
        addr: tool.schema.number().describe("I/O port address as decimal integer (e.g. 1075838976 for 0x40200000)"),
        value: tool.schema.string().describe("Value or semicolon-separated sequence for successive reads (e.g. '1;2')"),
      }),
    )
    .optional()
    .describe("Memory-mapped I/O port values to set or update (merged by addr)"),
  desc: tool.schema
    .string()
    .optional()
    .describe("Detailed test case description: [测试目的] [测试方法] [输入条件] → [预期行为]"),
})

export const aunitEnrichCases: ToolDefinition = tool({
  description:
    "Enrich existing AUnit test cases with expected values (retValue, gVars) and descriptions. " +
    "Updates cases in-place by caseId — does NOT create new cases. " +
    "BATCH MODE (preferred): use function_enrichments[] to enrich multiple functions in one call — " +
    "greatly reduces tool call count for large projects. " +
    "SINGLE MODE: use function_name + enrichments[] for a single function. " +
    "Use after aunit_autogen to add expected values, or after aunit_run_case to correct values.",
  args: {
    project_name: tool.schema.string().describe("AUnit project name"),
    project_dir: tool.schema.string().describe("Project root directory"),
    // Batch mode
    function_enrichments: tool.schema
      .array(
        tool.schema.object({
          function_name: tool.schema.string().describe("Target function name"),
          enrichments: tool.schema.array(enrichmentItemSchema).describe("Enrichments for this function"),
        }),
      )
      .optional()
      .describe("BATCH MODE: enrich cases for multiple functions in one call (preferred for large projects)"),
    // Single mode
    function_name: tool.schema.string().optional().describe("SINGLE MODE: target function name"),
    enrichments: tool.schema.array(enrichmentItemSchema).optional().describe("SINGLE MODE: enrichment updates"),
  },
  async execute({ project_name, project_dir, function_enrichments, function_name, enrichments }) {
    const utDir = join(
      normalizePath(normalizeProjectDir(project_dir)),
      AUNIT_WORKSPACE,
      project_name,
      "meta",
      "model",
      "UT",
    )

    if (!existsSync(utDir)) {
      return JSON.stringify({
        error: `AUnit UT directory not found at ${utDir}. Run aunit_build first.`,
      })
    }

    // ── Batch mode ───────────────────────────────────────────────────────────
    if (function_enrichments && function_enrichments.length > 0) {
      const batchResults: Array<{ function_name: string; enriched_count: number; error?: string }> = []
      let totalEnriched = 0

      for (const { function_name: fn, enrichments: fnEnrichments } of function_enrichments) {
        const gsonPath = findGsonForFunction(utDir, fn)
        if (!gsonPath) {
          batchResults.push({ function_name: fn, enriched_count: 0, error: "gson file not found" })
          continue
        }
        let gson: any
        try {
          gson = readGsonFile(gsonPath)
        } catch {
          batchResults.push({ function_name: fn, enriched_count: 0, error: "failed to parse gson" })
          continue
        }
        const enrichedCount = enrichCasesInGson(gson, fnEnrichments)
        writeGsonFile(gsonPath, gson)
        totalEnriched += enrichedCount
        batchResults.push({ function_name: fn, enriched_count: enrichedCount })
      }

      return JSON.stringify({
        status: "success",
        mode: "batch",
        total_functions: function_enrichments.length,
        total_enriched: totalEnriched,
        results: batchResults,
      })
    }

    // ── Single mode ──────────────────────────────────────────────────────────
    if (!function_name || !enrichments) {
      return JSON.stringify({ error: "Provide either function_enrichments (batch) or function_name + enrichments (single)." })
    }

    const gsonPath = findGsonForFunction(utDir, function_name)
    if (!gsonPath) {
      return JSON.stringify({
        error: `No gson file found for function "${function_name}" under ${utDir}.`,
      })
    }

    let gson: any
    try {
      gson = readGsonFile(gsonPath)
    } catch (err) {
      return JSON.stringify({
        error: `Failed to parse gson file: ${gsonPath}`,
        details: err instanceof Error ? err.message : String(err),
      })
    }

    const enrichedCount = enrichCasesInGson(gson, enrichments)
    writeGsonFile(gsonPath, gson)

    return JSON.stringify({
      status: "success",
      mode: "single",
      function_name,
      enriched_count: enrichedCount,
      total_cases: gson.cases?.length ?? 0,
    })
  },
})

/** Enrich cases in a gson object in-place. Returns the number of cases updated. */
function enrichCasesInGson(gson: any, enrichments: any[]): number {
  const cases: any[] = gson.cases || []
  const caseMap = new Map<number, any>()
  for (const c of cases) {
    caseMap.set(c.caseId, c)
  }

  // Detect void functions: if observedExprs doesn't include "returnValue", the function returns void
  const observedExprs: string[] = gson.entry?.observedExprs || []
  const isVoidFunction = !observedExprs.includes("returnValue")

  let enrichedCount = 0
  for (const e of enrichments) {
    const c = caseMap.get(e.caseId)
    if (!c) continue

    if (e.retValue !== undefined && e.retValue !== "" && !isVoidFunction) {
      const cleanedRet = sanitizeCaseValue(e.retValue)
      if (cleanedRet !== "") {
        c.retValue = cleanedRet
      }
      // If sanitization cleared the value, skip the update to avoid overwriting a valid existing retValue
    }
    if (e.gVars && e.gVars.length > 0) {
      const gvarMap = new Map<string, any>()
      for (const gv of (c.gVars || [])) {
        gvarMap.set(gv.expr, gv)
      }
      for (const gv of e.gVars) {
        gvarMap.set(gv.expr, {
          expr: gv.expr,
          in: sanitizeCaseValue(gv.in) || gv.in,
          out: sanitizeCaseValue(gv.out) || gv.out,
        })
      }
      c.gVars = Array.from(gvarMap.values())
    }
    if (e.stubInss && e.stubInss.length > 0) {
      const stubMap = new Map<string, any>()
      for (const s of (c.stubInss || [])) {
        stubMap.set(s.stubName, s)
      }
      for (const s of e.stubInss) {
        stubMap.set(s.stubName, {
          stubName: s.stubName,
          inputs: (s.inputs || []).map((inp: any) => ({
            expr: inp.expr,
            value: sanitizeSequenceValue(inp.value) || inp.value,
          })),
          expects: s.expects || [],
        })
      }
      c.stubInss = Array.from(stubMap.values())
    }
    if (e.IOValues && e.IOValues.length > 0) {
      const ioMap = new Map<number, any>()
      for (const io of (c.IOValues || [])) {
        ioMap.set(io.addr, io)
      }
      for (const io of e.IOValues) {
        ioMap.set(io.addr, {
          addr: io.addr,
          value: sanitizeSequenceValue(io.value) || io.value,
        })
      }
      c.IOValues = Array.from(ioMap.values())
    }
    if (e.iterTimes !== undefined && e.iterTimes !== "") {
      c.iterTimes = e.iterTimes
    }
    if (e.desc !== undefined && e.desc !== "") {
      c.desc = e.desc
    }
    enrichedCount++
  }

  return enrichedCount
}

/** Recursively find a gson file whose entry.funcName matches the target */
function findGsonForFunction(dir: string, funcName: string): string | null {
  const normalDir = normalizePath(dir)
  if (!existsSync(normalDir)) return null

  const entries = readdirSync(normalDir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(normalDir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "preanalysis") continue
      const found = findGsonForFunction(fullPath, funcName)
      if (found) return found
    } else if (entry.name.endsWith(".gson")) {
      try {
        const buffer = readFileSync(fullPath)
        const text = decodeGbk(buffer)
        const data = JSON.parse(text)
        if (data.entry?.funcName === funcName) {
          return fullPath
        }
      } catch {
        // skip unparseable files
      }
    }
  }
  return null
}
