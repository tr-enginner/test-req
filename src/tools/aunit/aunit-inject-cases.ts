import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, readFileSync, readdirSync } from "fs"
import { join } from "path"
import { normalizePath, AUNIT_WORKSPACE, normalizeProjectDir, sanitizeCaseValues, sanitizeSequenceValue } from "./aunit-utils"
import { readGsonFile, writeGsonFile, decodeGbk } from "./gbk-encoding"

/**
 * aunit_inject_cases — Inject test cases (functional or coverage supplement) into AUnit's gson files.
 * Cases are appended to the existing cases[] array with incremental caseId.
 * After injection, aunit_run_case will execute them alongside auto-generated cases.
 *
 * Expected outputs use AUnit's native gson format:
 * - retValue: expected return value (string)
 * - gVars[]: global variable expectations with {expr, in, out}
 *
 * Reads/writes gson files in GBK encoding (AUnit/Java default on Chinese Windows).
 */
/** Single function case input type (shared by single and batch modes) */
const caseItemSchema = tool.schema.object({
  desc: tool.schema.string().describe("Test case description"),
  paraExprs: tool.schema
    .array(
      tool.schema.object({
        expr: tool.schema.string().describe("Parameter name"),
        in: tool.schema.string().describe("Input value as string"),
      }),
    )
    .describe("Input parameter values"),
  retValue: tool.schema
    .string()
    .optional()
    .describe("Expected return value as string (e.g. '123', '0', '-1')"),
  gVars: tool.schema
    .array(
      tool.schema.object({
        expr: tool.schema.string().describe("Global variable name"),
        in: tool.schema.string().describe("Input value (initial state before call)"),
        out: tool.schema.string().describe("Expected output value after call"),
      }),
    )
    .optional()
    .describe("Global variable expectations: expr=name, in=initial value, out=expected value after execution"),
  stubInss: tool.schema
    .array(
      tool.schema.object({
        stubName: tool.schema.string().describe("Stub function name"),
        inputs: tool.schema
          .array(
            tool.schema.object({
              expr: tool.schema.string().describe("Expression name (e.g. 'returnValue' for return value, parameter name for pointer params)"),
              value: tool.schema.string().describe("Value or semicolon-separated value sequence (e.g. '0;2;3;4' — each value used on successive calls)"),
            }),
          )
          .describe("Stub input values"),
        expects: tool.schema
          .array(tool.schema.any())
          .optional()
          .describe("Expected observations (usually empty for injection)"),
      }),
    )
    .optional()
    .describe("Stub function input settings. Use value sequences (';'-separated) when the stub is called multiple times"),
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
    .describe("Memory-mapped I/O port values for absolute address pointers. Use entry.IOPorts[] from gson to find available ports and their decimal addresses. Semicolon-separated values for successive reads of the same address."),
  types: tool.schema
    .array(
      tool.schema.object({
        type: tool.schema.string().describe("Test type label (e.g. '功能测试')"),
        comment: tool.schema.string().optional().describe("Optional comment"),
      }),
    )
    .optional()
    .describe("Test type classification"),
})

export const aunitInjectCases: ToolDefinition = tool({
  description:
    "Inject test cases (functional or coverage supplement) into AUnit gson files. " +
    "BATCH MODE (preferred): use function_cases[] to inject for multiple functions in one call — " +
    "greatly reduces tool call count for large projects. " +
    "SINGLE MODE: use function_name + cases[] for a single function. " +
    "Cases are appended with auto-incremented caseId. Use types[].type to classify: '功能测试' for functional, '覆盖率补充' for structural coverage supplement. " +
    "Expected outputs use native gson format: retValue for return value, gVars[].out for globals. " +
    "For memory-mapped I/O (absolute address pointers like 0x40200000), use IOValues[] with the decimal addr from entry.IOPorts[]. " +
    "Semicolon-separated values (e.g. '1;2') set successive read values for branch coverage. " +
    "Must be called AFTER aunit_build (so gson files exist) and BEFORE aunit_run_case.",
  args: {
    project_name: tool.schema.string().describe("AUnit project name"),
    project_dir: tool.schema.string().describe("Project root directory"),
    // Batch mode
    function_cases: tool.schema
      .array(
        tool.schema.object({
          function_name: tool.schema.string().describe("Target function name"),
          cases: tool.schema.array(caseItemSchema).describe("Cases to inject for this function"),
        }),
      )
      .optional()
      .describe("BATCH MODE: inject cases for multiple functions in one call (preferred for large projects)"),
    // Single mode (kept for backwards compat and per-node coverage supplement calls)
    function_name: tool.schema.string().optional().describe("SINGLE MODE: target function name"),
    cases: tool.schema.array(caseItemSchema).optional().describe("SINGLE MODE: cases to inject"),
  },
  async execute({ project_name, project_dir, function_cases, function_name, cases }) {
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
    if (function_cases && function_cases.length > 0) {
      const batchResults: Array<{ function_name: string; injected_count: number; total_cases: number; error?: string }> = []
      let totalInjected = 0

      for (const { function_name: fn, cases: fnCases } of function_cases) {
        const gsonPath = findGsonForFunction(utDir, fn)
        if (!gsonPath) {
          batchResults.push({ function_name: fn, injected_count: 0, total_cases: 0, error: "gson file not found" })
          continue
        }
        let gson: any
        try {
          gson = readGsonFile(gsonPath)
        } catch {
          batchResults.push({ function_name: fn, injected_count: 0, total_cases: 0, error: "failed to parse gson" })
          continue
        }
        const { count: injectedCount, sanitized_warnings } = injectCasesIntoGson(gson, fnCases)
        writeGsonFile(gsonPath, gson)
        totalInjected += injectedCount
        batchResults.push({
          function_name: fn,
          injected_count: injectedCount,
          total_cases: gson.cases.length,
          ...(sanitized_warnings.length > 0 ? { sanitized_warnings } : {}),
        })
      }

      return JSON.stringify({
        status: "success",
        mode: "batch",
        total_functions: function_cases.length,
        total_injected: totalInjected,
        results: batchResults,
      })
    }

    // ── Single mode ──────────────────────────────────────────────────────────
    if (!function_name || !cases) {
      return JSON.stringify({ error: "Provide either function_cases (batch) or function_name + cases (single)." })
    }

    const gsonPath = findGsonForFunction(utDir, function_name)
    if (!gsonPath) {
      return JSON.stringify({
        error: `No gson file found for function "${function_name}" under ${utDir}. ` +
          `Check that the function was successfully analyzed by aunit_build.`,
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

    const { count: injectedCount, sanitized_warnings } = injectCasesIntoGson(gson, cases)
    writeGsonFile(gsonPath, gson)

    return JSON.stringify({
      status: "success",
      mode: "single",
      function_name,
      injected_count: injectedCount,
      ...(sanitized_warnings.length > 0 ? { sanitized_warnings } : {}),
      total_cases: gson.cases.length,
    })
  },
})

/** Inject cases into a gson object in-place. Returns count and sanitization warnings. */
function injectCasesIntoGson(gson: any, cases: any[]): { count: number; sanitized_warnings: string[] } {
  const existingCases: any[] = gson.cases || []
  let maxCaseId = 0
  for (const c of existingCases) {
    if (c.caseId > maxCaseId) maxCaseId = c.caseId
  }

  // Detect void functions: if observedExprs doesn't include "returnValue", the function returns void
  const observedExprs: string[] = gson.entry?.observedExprs || []
  const isVoidFunction = !observedExprs.includes("returnValue")

  // Build pointer → user variable mapping from entry.defaultPtrTargets
  const ptrTargets = new Map<string, string>()
  for (const pt of gson.entry?.defaultPtrTargets || []) {
    ptrTargets.set(pt.key, pt.value)
  }

  const injected: any[] = []
  const allWarnings: string[] = []
  for (const c of cases) {
    maxCaseId++
    const typeLabel = c.types?.[0]?.type || ""
    const caseName = typeLabel.includes("覆盖率补充") ? `覆盖率补充用例${maxCaseId}` : `功能用例${maxCaseId}`
    const caseObj: any = {
      caseId: maxCaseId,
      caseName,
      testSetIdex: 0,
      isAIGen: true,
      desc: c.desc,
      manualCode: "",
      caseCode: "",
      iterTimes: c.iterTimes || "1",
      property: {},
      retValue: isVoidFunction ? "" : (c.retValue || ""),
      result: {},
      ManualResult: { active: false, status: "UNKNOWN", description: " " },
      IOValues: (c.IOValues || []).map((io: any) => ({
        addr: io.addr,
        value: sanitizeSequenceValue(io.value) || io.value,
      })),
      gVars: c.gVars || [],
      manualExprs: [],
      paraExprs: c.paraExprs,
      userDefExprs: [],
      stubSeqs: [],
      stubInss: (c.stubInss || []).map((s: any) => ({
        stubName: s.stubName,
        inputs: (s.inputs || []).map((inp: any) => ({
          expr: inp.expr,
          value: sanitizeSequenceValue(inp.value) || inp.value,
        })),
        expects: s.expects || [],
      })),
      stubCallTimes: [],
      notStubCallTimes: [],
      types: (c.types || [{ type: "功能测试", comment: "" }]).map((t: any) => ({
        type: t.type,
        comment: t.comment || "",
        editable: false,
      })),
      coverageMap: {},
    }

    // Redirect pointer parameters to backing user-defined variables
    if (ptrTargets.size > 0) {
      // Redirect paraExprs: pointer param value → userDefExprs via backing array
      for (const pe of caseObj.paraExprs) {
        const target = ptrTargets.get(pe.expr)
        if (target && pe.in !== target) {
          const originalValue = pe.in
          pe.in = target
          caseObj.userDefExprs.push({ expr: `${target}[0]`, in: originalValue })
        }
      }
      // Redirect gVars: pointer global variable value → userDefExprs via backing array
      for (const gv of caseObj.gVars) {
        const target = ptrTargets.get(gv.expr)
        if (target && gv.in !== target) {
          const originalValue = gv.in
          gv.in = target
          caseObj.userDefExprs.push({ expr: `${target}[0]`, in: originalValue })
        }
      }
    }

    // Sanitize values to prevent C compilation failures from invalid tokens
    const warnings = sanitizeCaseValues(caseObj)
    if (warnings.length > 0) {
      allWarnings.push(`case ${maxCaseId}: ${warnings.join("; ")}`)
    }
    injected.push(caseObj)
  }

  gson.cases = [...existingCases, ...injected]
  gson.curIndex = maxCaseId
  return { count: injected.length, sanitized_warnings: allWarnings }
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
