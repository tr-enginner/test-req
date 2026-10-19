import { existsSync, readFileSync, readdirSync, writeFileSync } from "fs"
import { basename, isAbsolute, join } from "path"
import {
  SourceConfirmationTestSuite,
  TranslatedConfirmationTestSuite,
} from "../schema/confirmation-test-case"
import { DefectDatabase } from "../schema/defect"
import { ReviewRecord } from "../schema/review"
import { SoftwareAnalysisReport } from "../schema/sut"
import { TestExecutionReport } from "../schema/test-execution"
import { Phase6ExecutionLoopArtifact } from "../schema/phase6-execution-loop"
import { TestRequirementsArtifact } from "../schema/test-requirement"
import { TestSummary } from "../schema/test-summary"
import { UnitTestReport } from "../schema/unit-test-case"
import { BehaviorSafetyBatchRecord, BehaviorSafetyRecord } from "../schema/behavior-safety"
import {
  DataStructuresFile,
  FunctionWiki,
  ModuleWiki,
  parseFunctionWikiLenient,
  WikiIndex,
} from "../schema/wiki"
import { TestEnvironmentDesign, BaselineTestResult } from "../schema/test-environment"
import type { z } from "zod"

/** Map of .matrix/data file names to their Zod schemas */
const DATA_SCHEMA_MAP: Record<string, z.ZodType<any>> = {
  "software-analysis.json": SoftwareAnalysisReport,
  "test-requirements.json": TestRequirementsArtifact,
  "defects.json": DefectDatabase,
  "unit-tests.json": UnitTestReport,
  "confirmation-tests.json": SourceConfirmationTestSuite,
  "phase6-execution-loop.json": Phase6ExecutionLoopArtifact,
  "test-execution.json": TestExecutionReport,
  "test-summary.json": TestSummary,
  "req-review.json": ReviewRecord,
  "env-review.json": ReviewRecord,
  "case-review.json": ReviewRecord,
  "env-design.json": TestEnvironmentDesign,
  "baseline-results.json": BaselineTestResult,
}

function resolveArtifactSchema(filePath: string): {
  schema: z.ZodType<any>
  schemaLabel: string
} | null {
  const normalizedPath = filePath.replace(/\\/g, "/")
  const fileName = basename(normalizedPath)

  const dataSchema = DATA_SCHEMA_MAP[fileName]
  if (dataSchema) {
    return {
      schema: dataSchema,
      schemaLabel: fileName,
    }
  }

  if (normalizedPath.endsWith(".matrix/wiki/index.json")) {
    return {
      schema: WikiIndex,
      schemaLabel: "wiki index",
    }
  }

  if (normalizedPath.endsWith(".matrix/wiki/data-structures.json")) {
    return {
      schema: DataStructuresFile,
      schemaLabel: "wiki data structures",
    }
  }

  if (/\.matrix\/wiki\/modules\/[^/\s]+\.json$/i.test(normalizedPath)) {
    return {
      schema: ModuleWiki,
      schemaLabel: "wiki module",
    }
  }

  if (/\.matrix\/wiki\/functions\/[^/\s]+\.json$/i.test(normalizedPath)) {
    return {
      schema: FunctionWiki,
      schemaLabel: "wiki function",
    }
  }

  if (normalizedPath.includes("/.matrix/data/safety-records/")) {
    return {
      schema: BehaviorSafetyRecord,
      schemaLabel: "behavior safety record",
    }
  }

  if (normalizedPath.includes("/.matrix/data/safety-batches/")) {
    return {
      schema: BehaviorSafetyBatchRecord,
      schemaLabel: "behavior safety batch",
    }
  }

  return null
}

function resolveFullArtifactPath(directory: string, filePath: string): string {
  if (isAbsolute(filePath)) {
    return filePath
  }
  return join(directory, filePath.replace(/^\.\//, ""))
}

function loadSoftwareAnalysisForWikiChecks(
  directory: string,
): z.infer<typeof SoftwareAnalysisReport> | null {
  const analysisPath = join(directory, ".matrix", "data", "software-analysis.json")
  if (!existsSync(analysisPath)) {
    return null
  }

  try {
    const raw = readFileSync(analysisPath, "utf-8")
    const parsed = SoftwareAnalysisReport.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function getExpectedFlatFunctionNames(
  report: z.infer<typeof SoftwareAnalysisReport>,
): string[] {
  const duplicateNameSet = new Set(getDuplicateFunctionNames(report))
  return report.functions
    .filter((fn) => !duplicateNameSet.has(fn.name))
    .map((fn) => fn.name)
}

function summarizeItems(items: string[], limit = 5): string {
  if (items.length <= limit) {
    return items.join(", ")
  }
  return `${items.slice(0, limit).join(", ")} (+${items.length - limit} more)`
}

function normalizePathValue(value: string): string {
  return value.replace(/\\/g, "/")
}

function lineRangeMatches(
  actual: { start: number; end: number },
  expected: { start: number; end: number },
): boolean {
  return actual.start === expected.start && actual.end === expected.end
}

function getDuplicateFunctionNames(
  report: z.infer<typeof SoftwareAnalysisReport>,
): string[] {
  const counts = new Map<string, number>()
  for (const fn of report.functions) {
    counts.set(fn.name, (counts.get(fn.name) ?? 0) + 1)
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([name]) => name)
    .sort()
}

function loadFunctionIndexFromDisk(directory: string): z.infer<typeof WikiIndex> | null {
  const indexPath = join(directory, ".matrix", "wiki", "index.json")
  if (!existsSync(indexPath)) {
    return null
  }

  try {
    const raw = readFileSync(indexPath, "utf-8")
    const parsed = WikiIndex.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function collectMissingFunctionWikiNames(
  directory: string,
  report: z.infer<typeof SoftwareAnalysisReport>,
): string[] {
  const functionDir = join(directory, ".matrix", "wiki", "functions")
  return getExpectedFlatFunctionNames(report).filter(
    (name) => !existsSync(join(functionDir, `${name}.json`)),
  )
}

function buildExactFunctionInventoryMessages(
  directory: string,
  report: z.infer<typeof SoftwareAnalysisReport>,
  indexData: z.infer<typeof WikiIndex>,
): string[] {
  const messages: string[] = []
  const duplicateNames = getDuplicateFunctionNames(report)
  const duplicateNameSet = new Set(duplicateNames)

  const expectedFunctions = report.functions.filter((fn) => !duplicateNameSet.has(fn.name))
  const expectedNames = new Set(expectedFunctions.map((fn) => fn.name))
  const functionDir = join(directory, ".matrix", "wiki", "functions")
  const actualFunctionFiles = existsSync(functionDir)
    ? readdirSync(functionDir).filter((file) => file.toLowerCase().endsWith(".json"))
    : []
  const actualFunctionNames = actualFunctionFiles.map((file) => basename(file, ".json"))

  const missingIndexEntries = expectedFunctions
    .filter((fn) => !(fn.name in indexData.function_index))
    .map((fn) => fn.name)
  if (missingIndexEntries.length > 0) {
    messages.push(
      "wiki/index.json is missing function_index entries for functions from " +
        `software-analysis.json: ${summarizeItems(missingIndexEntries)}.`,
    )
  }

  const unexpectedIndexEntries = Object.keys(indexData.function_index)
    .filter((name) => !expectedNames.has(name))
    .sort()
  if (unexpectedIndexEntries.length > 0) {
    messages.push(
      "wiki/index.json contains function_index entries that do not exist in " +
        `software-analysis.json: ${summarizeItems(unexpectedIndexEntries)}.`,
    )
  }

  const missingFunctionWikiFiles = expectedFunctions
    .filter((fn) => !existsSync(join(functionDir, `${fn.name}.json`)))
    .map((fn) => fn.name)
  if (missingFunctionWikiFiles.length > 0) {
    messages.push(
      "Missing function wiki artifacts for functions declared in software-analysis.json: " +
        `${summarizeItems(missingFunctionWikiFiles)}.`,
    )
  }

  const unexpectedFunctionWikiFiles = actualFunctionNames
    .filter((name) => !expectedNames.has(name))
    .sort()
  if (unexpectedFunctionWikiFiles.length > 0) {
    messages.push(
      "Unexpected function wiki artifacts that do not map to software-analysis.json: " +
        `${summarizeItems(unexpectedFunctionWikiFiles)}.`,
    )
  }

  for (const fn of expectedFunctions) {
    const indexEntry = indexData.function_index[fn.name]
    if (indexEntry) {
      const indexMismatches: string[] = []
      if (indexEntry.id !== fn.id) {
        indexMismatches.push(`id expected ${fn.id} but found ${indexEntry.id}`)
      }
      if (normalizePathValue(indexEntry.file_path) !== normalizePathValue(fn.file_path)) {
        indexMismatches.push(
          `file_path expected ${fn.file_path} but found ${indexEntry.file_path}`,
        )
      }
      if (indexEntry.safety_critical !== fn.safety_critical) {
        indexMismatches.push(
          "safety_critical expected " +
            `${String(fn.safety_critical)} but found ${String(indexEntry.safety_critical)}`,
        )
      }
      if (indexMismatches.length > 0) {
        messages.push(
          `wiki/index.json entry for "${fn.name}" does not match software-analysis.json: ` +
            `${indexMismatches.join("; ")}.`,
        )
      }
    }

    const functionWikiPath = join(functionDir, `${fn.name}.json`)
    if (!existsSync(functionWikiPath)) {
      continue
    }

    try {
      const raw = readFileSync(functionWikiPath, "utf-8")
      const parsed = FunctionWiki.safeParse(JSON.parse(raw))
      if (!parsed.success) {
        messages.push(
          `Function wiki ".matrix/wiki/functions/${fn.name}.json" exists but is ` +
            "schema-invalid and cannot be reconciled.",
        )
        continue
      }

      const wikiData = parsed.data
      const wikiMismatches: string[] = []
      if (wikiData.id !== fn.id) {
        wikiMismatches.push(`id expected ${fn.id} but found ${wikiData.id}`)
      }
      if (wikiData.name !== fn.name) {
        wikiMismatches.push(`name expected ${fn.name} but found ${wikiData.name}`)
      }
      if (normalizePathValue(wikiData.file_path) !== normalizePathValue(fn.file_path)) {
        wikiMismatches.push(
          `file_path expected ${fn.file_path} but found ${wikiData.file_path}`,
        )
      }
      if (!lineRangeMatches(wikiData.line_range, fn.line_range)) {
        wikiMismatches.push(
          "line_range expected " +
            `${fn.line_range.start}-${fn.line_range.end} but found ` +
            `${wikiData.line_range.start}-${wikiData.line_range.end}`,
        )
      }
      if (wikiMismatches.length > 0) {
        messages.push(
          `Function wiki ".matrix/wiki/functions/${fn.name}.json" does not match ` +
            `software-analysis.json for "${fn.name}": ${wikiMismatches.join("; ")}.`,
        )
      }

      if (indexEntry) {
        const crossMismatches: string[] = []
        if (wikiData.id !== indexEntry.id) {
          crossMismatches.push(
            `id mismatch between wiki (${wikiData.id}) and index (${indexEntry.id})`,
          )
        }
        if (
          normalizePathValue(wikiData.file_path) !==
          normalizePathValue(indexEntry.file_path)
        ) {
          crossMismatches.push(
            `file_path mismatch between wiki (${wikiData.file_path}) and index (${indexEntry.file_path})`,
          )
        }
        if (crossMismatches.length > 0) {
          messages.push(
            `Function "${fn.name}" is not reconciled between wiki/index.json and ` +
              `.matrix/wiki/functions/${fn.name}.json: ${crossMismatches.join("; ")}.`,
          )
        }
      }
    } catch {
      messages.push(
        `Function wiki ".matrix/wiki/functions/${fn.name}.json" could not be parsed for reconciliation.`,
      )
    }
  }

  return messages
}

function buildSingleFunctionReconciliationMessages(
  directory: string,
  report: z.infer<typeof SoftwareAnalysisReport>,
  filePath: string,
  data: z.infer<typeof FunctionWiki>,
): string[] {
  const normalizedPath = normalizePathValue(filePath)
  const functionNameFromPath = basename(normalizedPath, ".json")
  const duplicateNames = new Set(getDuplicateFunctionNames(report))
  const matchingFunctions = report.functions.filter((fn) => fn.name === functionNameFromPath)
  const messages: string[] = []

  if (duplicateNames.has(functionNameFromPath)) {
    messages.push(
      `Function wiki "${functionNameFromPath}" is ambiguous because software-analysis.json contains duplicate functions with the same name.`,
    )
    return messages
  }

  if (matchingFunctions.length === 0) {
    messages.push(
      `Function wiki "${functionNameFromPath}" does not map to any function declared in software-analysis.json.`,
    )
    return messages
  }

  const expected = matchingFunctions[0]
  const mismatches: string[] = []
  if (data.id !== expected.id) {
    mismatches.push(`id expected ${expected.id} but found ${data.id}`)
  }
  if (data.name !== expected.name) {
    mismatches.push(`name expected ${expected.name} but found ${data.name}`)
  }
  if (normalizePathValue(data.file_path) !== normalizePathValue(expected.file_path)) {
    mismatches.push(`file_path expected ${expected.file_path} but found ${data.file_path}`)
  }
  if (!lineRangeMatches(data.line_range, expected.line_range)) {
    mismatches.push(
      "line_range expected " +
        `${expected.line_range.start}-${expected.line_range.end} but found ` +
        `${data.line_range.start}-${data.line_range.end}`,
    )
  }
  if (mismatches.length > 0) {
    messages.push(
      `Function wiki ".matrix/wiki/functions/${functionNameFromPath}.json" does not match software-analysis.json: ` +
        `${mismatches.join("; ")}.`,
    )
  }

  const indexData = loadFunctionIndexFromDisk(directory)
  if (!indexData) {
    return messages
  }

  const indexEntry = indexData.function_index[functionNameFromPath]
  if (!indexEntry) {
    messages.push(
      `wiki/index.json is missing function_index entry for "${functionNameFromPath}" while its function wiki already exists.`,
    )
    return messages
  }

  const crossMismatches: string[] = []
  if (indexEntry.id !== expected.id) {
    crossMismatches.push(`index id expected ${expected.id} but found ${indexEntry.id}`)
  }
  if (normalizePathValue(indexEntry.file_path) !== normalizePathValue(expected.file_path)) {
    crossMismatches.push(
      `index file_path expected ${expected.file_path} but found ${indexEntry.file_path}`,
    )
  }
  if (data.id !== indexEntry.id) {
    crossMismatches.push(`wiki/id ${data.id} does not match index/id ${indexEntry.id}`)
  }
  if (normalizePathValue(data.file_path) !== normalizePathValue(indexEntry.file_path)) {
    crossMismatches.push(
      `wiki/file_path ${data.file_path} does not match index/file_path ${indexEntry.file_path}`,
    )
  }
  if (crossMismatches.length > 0) {
    messages.push(
      `Function "${functionNameFromPath}" is not fully reconciled across software-analysis.json, ` +
        `wiki/index.json, and its function wiki: ${crossMismatches.join("; ")}.`,
    )
  }

  return messages
}

function buildWikiInventoryMessages(
  directory: string,
  filePath: string,
  data: unknown,
): string[] {
  const normalizedPath = normalizePathValue(filePath)
  const isWikiPath = normalizedPath.includes(".matrix/wiki/")
  const isSoftwareAnalysisPath = normalizedPath.endsWith(".matrix/data/software-analysis.json")
  if (!isWikiPath && !isSoftwareAnalysisPath) {
    return []
  }

  const report = loadSoftwareAnalysisForWikiChecks(directory)
  if (!report) {
    return []
  }

  const messages: string[] = []

  if (/\.matrix\/wiki\/functions\/[^/\s]+\.json$/i.test(normalizedPath)) {
    const parsedFunctionWiki = FunctionWiki.safeParse(data)
    if (parsedFunctionWiki.success) {
      messages.push(
        ...buildSingleFunctionReconciliationMessages(
          directory,
          report,
          filePath,
          parsedFunctionWiki.data,
        ),
      )
    }
  }

  if (normalizedPath.endsWith(".matrix/wiki/index.json")) {
    const parsedIndex = WikiIndex.safeParse(data)
    if (parsedIndex.success) {
      messages.push(
        ...buildExactFunctionInventoryMessages(directory, report, parsedIndex.data),
      )
    }
  } else if (isSoftwareAnalysisPath) {
    const existingIndex = loadFunctionIndexFromDisk(directory)
    if (existingIndex) {
      messages.push(
        ...buildExactFunctionInventoryMessages(directory, report, existingIndex),
      )
    }
  }

  return messages
}

/**
 * artifact-validator hook — Validates artifacts written to .matrix/data/
 * and .matrix/wiki/ against their Zod schemas. Rejects invalid data and reports errors.
 */
export function createArtifactValidatorHook(directory: string) {
  return {
    "tool.execute.after": async (
      input: { tool: string; sessionID: string },
      output: { title: string; output: string; metadata: any },
    ) => {
      if (input.tool !== "write") return

      const outputNorm = output.output.replace(/\\/g, "/")
      if (!outputNorm.includes(".matrix/data/") && !outputNorm.includes(".matrix/wiki/")) {
        return
      }

      const filePathMatch = outputNorm.match(
        /(?:wrote|created|saved)\s+(?:to\s+)?([^\s]+\.json)/i,
      )
      if (!filePathMatch) return

      const filePath = filePathMatch[1]
      const fileName = basename(filePath)
      const resolved = resolveArtifactSchema(filePath)
      if (!resolved) return

      const fullPath = resolveFullArtifactPath(directory, filePath)
      if (!existsSync(fullPath)) return

      try {
        const raw = readFileSync(fullPath, "utf-8")
        const parsedRaw = JSON.parse(raw)

        let data = parsedRaw
        let result = resolved.schema.safeParse(data)

        if (!result.success && resolved.schemaLabel === "wiki function") {
          const repaired = parseFunctionWikiLenient(parsedRaw)
          if (repaired) {
            data = repaired.data
            writeFileSync(fullPath, JSON.stringify(repaired.data, null, 2), "utf-8")
            result = resolved.schema.safeParse(data)
            output.metadata = {
              ...output.metadata,
              schema_auto_repaired: true,
            }
            output.output +=
              "\n\n[SCHEMA AUTO-REPAIRED] wiki function contained common model-format drift and was normalized to the canonical FunctionWiki schema."
          }
        }

        if (!result.success) {
          const errorSummary = result.error.issues
            .slice(0, 5)
            .map((issue: any) => `  - ${issue.path.join(".")}: ${issue.message}`)
            .join("\n")

          output.output +=
            `\n\n[SCHEMA VALIDATION FAILED] ${resolved.schemaLabel} does not match expected schema:\n` +
            errorSummary +
            `\n\nPlease fix the data and rewrite the file.`
          output.metadata = {
            ...output.metadata,
            schema_validation: "failed",
            schema_errors: result.error.issues.length,
          }
        } else {
          output.metadata = {
            ...output.metadata,
            schema_validation: "passed",
          }

          const wikiInventoryMessages = buildWikiInventoryMessages(
            directory,
            filePath,
            data,
          )
          if (wikiInventoryMessages.length > 0) {
            const report = loadSoftwareAnalysisForWikiChecks(directory)
            const missingFunctionWikiNames = report
              ? collectMissingFunctionWikiNames(directory, report)
              : []
            const missingFunctionResumptionInstruction =
              missingFunctionWikiNames.length > 0
                ? ` Missing function wiki artifacts detected for: ${summarizeItems(missingFunctionWikiNames)}. Immediately resume wiki-scheduler dispatch and run one function-analysis task for each missing function before re-running module/global synthesis.`
                : ""
            output.output +=
              `\n\n[WIKI INVENTORY CHECK FAILED] ${wikiInventoryMessages.join("\n")}` +
              `\n\nsoftware-analysis.json is the authoritative function ledger. Reconcile every listed function one-by-one against wiki/index.json and .matrix/wiki/functions/<function_name>.json before treating Phase 1b as complete.` +
              missingFunctionResumptionInstruction +
              ` If the missing or mismatched artifacts are part of Phase 1b generation, immediately resume wiki-scheduler dispatch to backfill the missing function-analysis/module/global-synthesis work. Do not stop at reporting the gap.`
            output.metadata = {
              ...output.metadata,
              wiki_inventory_validation: "failed",
              wiki_inventory_issues: wikiInventoryMessages.length,
            }
          } else if (filePath.replace(/\\/g, "/").includes(".matrix/wiki/")) {
            output.metadata = {
              ...output.metadata,
              wiki_inventory_validation: "passed",
            }
          }

          if (fileName === "software-analysis.json") {
            const forbiddenFields = [
              "consistency_check",
              "consistency_results",
              "verification_results",
              "pass_fail_status",
            ]
            const foundForbidden = forbiddenFields.filter(
              (field) => field in data,
            )
            if (foundForbidden.length > 0) {
              output.output +=
                `\n\n[SCOPE VIOLATION WARNING] software-analysis.json contains fields that are outside the Analyst's scope: ${foundForbidden.join(", ")}. ` +
                `Consistency verdicts and pass/fail status belong to the Spec-Implementation Review agent (Phase 3). ` +
                `Please remove these fields from the report and rewrite the file.`
              output.metadata = {
                ...output.metadata,
                scope_violation: true,
                forbidden_fields: foundForbidden,
              }
            }
          }
        }
      } catch (err) {
        output.output += `\n\n[SCHEMA VALIDATION ERROR] Could not validate ${fileName}: ${err}`
      }
    },
  }
}
