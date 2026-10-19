# Unit-Tester AUnit-Driven Workflow Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Redesign unit-tester to use AUnit tool chain as primary flow, with parallel functional test case generation sub-agent, and deterministic gson→Matrix report sync.

**Architecture:** AUnit CLI tools form the serial backbone (create→build→autogen→run→report). A parallel sub-agent generates functional test cases from requirements+code analysis and injects them into AUnit's gson files before execution. A sync tool bridges gson results to Matrix report format, eliminating data fabrication.

**Tech Stack:** TypeScript, `@opencode-ai/plugin` tool API, Zod schemas, AUnit gson (JSON), OpenCode SKILL.md format.

---

### Task 1: Create `aunit_inject_cases` Tool

**Files:**
- Create: `src/tools/aunit/aunit-inject-cases.ts`

**Step 1: Create the tool file**

```typescript
import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, readFileSync, writeFileSync, readdirSync } from "fs"
import { join } from "path"
import { normalizePath, AUNIT_WORKSPACE } from "./aunit-utils"

/**
 * aunit_inject_cases — Inject AI-designed functional test cases into AUnit's gson files.
 * Cases are appended to the existing cases[] array with incremental caseId.
 * After injection, aunit_run_case will execute them alongside auto-generated cases.
 */
export const aunitInjectCases: ToolDefinition = tool({
  description:
    "Inject functional test cases into an AUnit project's gson file for a specific function. " +
    "Cases are appended to the existing cases[] array with auto-incremented caseId. " +
    "Must be called AFTER aunit_build (so gson files exist) and BEFORE aunit_run_case.",
  args: {
    project_name: tool.schema.string().describe("AUnit project name"),
    project_dir: tool.schema.string().describe("Project root directory"),
    function_name: tool.schema.string().describe("Target function name to inject cases for"),
    cases: tool.schema
      .array(
        tool.schema.object({
          desc: tool.schema.string().describe("Test case description"),
          paraExprs: tool.schema
            .array(
              tool.schema.object({
                expr: tool.schema.string().describe("Parameter name"),
                in: tool.schema.string().describe("Input value as string"),
              }),
            )
            .describe("Input parameter values"),
          types: tool.schema
            .array(
              tool.schema.object({
                type: tool.schema.string().describe("Test type label (e.g. '功能测试')"),
                comment: tool.schema.string().optional().describe("Optional comment"),
              }),
            )
            .optional()
            .describe("Test type classification"),
        }),
      )
      .describe("Array of functional test cases to inject"),
  },
  async execute({ project_name, project_dir, function_name, cases }) {
    // Locate the gson file for the target function
    const utDir = join(
      normalizePath(project_dir),
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

    // Recursively find gson file matching function_name
    const gsonPath = findGsonForFunction(utDir, function_name)
    if (!gsonPath) {
      return JSON.stringify({
        error: `No gson file found for function "${function_name}" under ${utDir}. ` +
          `Check that the function was successfully analyzed by aunit_build.`,
      })
    }

    // Read existing gson
    let gson: any
    try {
      const raw = readFileSync(gsonPath, "utf-8")
      gson = JSON.parse(raw)
    } catch (err) {
      return JSON.stringify({
        error: `Failed to parse gson file: ${gsonPath}`,
        details: err instanceof Error ? err.message : String(err),
      })
    }

    // Find max caseId from existing cases
    const existingCases: any[] = gson.cases || []
    let maxCaseId = 0
    for (const c of existingCases) {
      if (c.caseId > maxCaseId) maxCaseId = c.caseId
    }

    // Build new cases in gson format
    const injected: any[] = []
    for (const c of cases) {
      maxCaseId++
      const newCase = {
        caseId: maxCaseId,
        caseName: `功能用例${maxCaseId}`,
        testSetIdex: 0,
        isAIGen: true,
        desc: c.desc,
        manualCode: "",
        caseCode: "",
        iterTimes: "1",
        property: {},
        result: {},
        ManualResult: { active: false, status: "UNKNOWN", description: " " },
        IOValues: [],
        gVars: [],
        manualExprs: [],
        paraExprs: c.paraExprs,
        userDefExprs: [],
        stubSeqs: [],
        stubInss: [],
        stubCallTimes: [],
        notStubCallTimes: [],
        types: (c.types || [{ type: "功能测试", comment: "" }]).map((t: any) => ({
          type: t.type,
          comment: t.comment || "",
          editable: false,
        })),
        coverageMap: {},
      }
      injected.push(newCase)
    }

    // Append to gson
    gson.cases = [...existingCases, ...injected]
    gson.curIndex = maxCaseId

    // Write back
    writeFileSync(gsonPath, JSON.stringify(gson, null, 2), "utf-8")

    return JSON.stringify({
      status: "success",
      function_name,
      gson_path: gsonPath,
      injected_count: injected.length,
      total_cases: gson.cases.length,
      case_ids: injected.map((c: any) => c.caseId),
      message: `Injected ${injected.length} functional test cases for "${function_name}".`,
    })
  },
})

/** Recursively find a gson file whose entry.funcName matches the target */
function findGsonForFunction(dir: string, funcName: string): string | null {
  const normalDir = normalizePath(dir)
  if (!existsSync(normalDir)) return null

  const entries = readdirSync(normalDir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(normalDir, entry.name)
    if (entry.isDirectory()) {
      // Skip preanalysis directory
      if (entry.name === "preanalysis") continue
      const found = findGsonForFunction(fullPath, funcName)
      if (found) return found
    } else if (entry.name.endsWith(".gson")) {
      try {
        const raw = readFileSync(fullPath, "utf-8")
        const data = JSON.parse(raw)
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
```

**Step 2: Verify file compiles**

Run: `cd "D:\code\matrix-embedded-agent" && bun run typecheck`
Expected: no errors from this file

**Step 3: Commit**

```bash
git add src/tools/aunit/aunit-inject-cases.ts
git commit -m "feat: add aunit_inject_cases tool for functional test case injection"
```

---

### Task 2: Create `aunit_sync_report` Tool

**Files:**
- Create: `src/tools/aunit/aunit-sync-report.ts`

**Step 1: Create the tool file**

```typescript
import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs"
import { join, dirname } from "path"
import { normalizePath, AUNIT_WORKSPACE } from "./aunit-utils"
import { ARTIFACT_PATHS } from "../../shared/constants"

/**
 * aunit_sync_report — Sync AUnit's gson execution results to Matrix unit-tests.json.
 * Reads actual test data from gson files and writes it in Matrix UnitTestReport format.
 * Eliminates data fabrication by using only real AUnit execution data.
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
  },
  async execute({ project_name, project_dir, version }) {
    const projDir = normalizePath(project_dir)
    const utDir = join(projDir, AUNIT_WORKSPACE, project_name, "meta", "model", "UT")

    if (!existsSync(utDir)) {
      return JSON.stringify({
        error: `AUnit UT directory not found at ${utDir}. Run aunit_build + aunit_run_case first.`,
      })
    }

    // Collect all gson files (skip preanalysis, skip model-root gson)
    const gsonFiles = findAllGsonFiles(utDir)
    if (gsonFiles.length === 0) {
      return JSON.stringify({
        error: `No function-level gson files found under ${utDir}.`,
      })
    }

    const testCases: any[] = []
    const results: any[] = []
    const aggregateCoverage: Record<string, { covered: number; total: number }> = {
      line: { covered: 0, total: 0 },
      branch: { covered: 0, total: 0 },
      mcdc: { covered: 0, total: 0 },
    }

    for (const gsonPath of gsonFiles) {
      let gson: any
      try {
        const raw = readFileSync(gsonPath, "utf-8")
        gson = JSON.parse(raw)
      } catch {
        continue // skip unparseable
      }

      const funcName = gson.entry?.funcName || "unknown"
      const observedExprs = gson.entry?.observedExprs || ["returnValue"]
      const cases: any[] = gson.cases || []

      for (const c of cases) {
        const caseId = `UT-${funcName}-${c.caseId}`

        // Map paraExprs → inputs
        const inputs = (c.paraExprs || []).map((p: any) => ({
          name: p.expr,
          type: "auto",
          value: String(p.in),
        }))

        // Determine design method from types
        const typeLabel = c.types?.[0]?.type || ""
        const designMethod = mapTypeToDesignMethod(typeLabel, c.isAIGen)

        // Build test case
        const testCase: any = {
          id: caseId,
          target_function_id: funcName,
          target_function_name: funcName,
          related_requirement_ids: [],
          title: c.desc || c.caseName || `${funcName} case ${c.caseId}`,
          description: c.desc || `Auto-synced from AUnit gson (caseId=${c.caseId})`,
          design_method: designMethod,
          preconditions: ["AUnit project built and analyzed"],
          inputs,
          expected_outputs: observedExprs.map((expr: string) => ({
            name: expr,
            type: "auto",
            value: "N/A",
          })),
          stubs: [],
          postconditions: [],
        }
        testCases.push(testCase)

        // Map result (only if case was executed)
        if (c.result && c.result.status) {
          const verdict = c.result.status === "OK" ? "pass" : "fail"
          const actualOutputs = (c.result.obValues || []).map((ob: any) => ({
            name: ob.expr,
            type: "auto",
            value: String(ob.value),
          }))

          // Update expected_outputs with actual observed values for executed cases
          if (actualOutputs.length > 0) {
            testCase.expected_outputs = actualOutputs.map((ao: any) => ({ ...ao }))
          }

          results.push({
            test_case_id: caseId,
            verdict,
            actual_outputs: actualOutputs,
            executed_date: c.result.LastRunTime || new Date().toISOString().split("T")[0],
          })
        }
      }

      // Parse top-level coverageMap for aggregate coverage
      if (gson.coverageMap) {
        for (const [, cov] of Object.entries(gson.coverageMap as Record<string, any>)) {
          parseCoverageField(cov.lineCov, aggregateCoverage.line)
          parseCoverageField(cov.branchCov, aggregateCoverage.branch)
          parseCoverageField(cov.mcdcCov, aggregateCoverage.mcdc)
        }
      }
    }

    // Compute coverage percentages
    const covStatement = aggregateCoverage.line.total > 0
      ? Math.round((aggregateCoverage.line.covered / aggregateCoverage.line.total) * 10000) / 100
      : undefined
    const covBranch = aggregateCoverage.branch.total > 0
      ? Math.round((aggregateCoverage.branch.covered / aggregateCoverage.branch.total) * 10000) / 100
      : undefined
    const covMcdc = aggregateCoverage.mcdc.total > 0
      ? Math.round((aggregateCoverage.mcdc.covered / aggregateCoverage.mcdc.total) * 10000) / 100
      : undefined

    // Compute summary
    const passed = results.filter((r) => r.verdict === "pass").length
    const failed = results.filter((r) => r.verdict === "fail").length
    const total = testCases.length
    const passRate = total > 0 ? Math.round((passed / total) * 10000) / 100 : 0

    const report = {
      project_name,
      version: version || "1.0",
      test_date: new Date().toISOString().split("T")[0],
      test_cases: testCases,
      results,
      coverage: {
        statement: covStatement,
        branch: covBranch,
        mc_dc: covMcdc,
        uncovered_functions: [],
      },
      summary: {
        total_cases: total,
        passed,
        failed,
        error: 0,
        skip: total - results.length,
        pass_rate: passRate,
      },
    }

    // Write to .matrix/data/unit-tests.json
    const outPath = join(projDir, ARTIFACT_PATHS.UNIT_TESTS)
    const outDir = dirname(outPath)
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
    writeFileSync(outPath, JSON.stringify(report, null, 2), "utf-8")

    return JSON.stringify({
      status: "success",
      file: ARTIFACT_PATHS.UNIT_TESTS,
      functions_synced: gsonFiles.length,
      total_cases: total,
      passed,
      failed,
      skip: total - results.length,
      pass_rate: passRate,
      coverage: { statement: covStatement, branch: covBranch, mc_dc: covMcdc },
      message: `Synced ${total} test cases from ${gsonFiles.length} gson files. ` +
        `${passed} passed, ${failed} failed. ` +
        `Coverage: line=${covStatement ?? "N/A"}%, branch=${covBranch ?? "N/A"}%, MC/DC=${covMcdc ?? "N/A"}%.`,
    })
  },
})

/** Recursively find all function-level gson files under UT directory */
function findAllGsonFiles(dir: string): string[] {
  const results: string[] = []
  const normalDir = normalizePath(dir)
  if (!existsSync(normalDir)) return results

  const entries = readdirSync(normalDir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(normalDir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "preanalysis") continue
      results.push(...findAllGsonFiles(fullPath))
    } else if (entry.name.endsWith(".gson")) {
      // Only include files that have entry.funcName (function-level, not project-level)
      try {
        const raw = readFileSync(fullPath, "utf-8")
        const data = JSON.parse(raw)
        if (data.entry?.funcName) {
          results.push(fullPath)
        }
      } catch {
        // skip
      }
    }
  }
  return results
}

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
  if (typeLabel.includes("功能")) return "equivalence_partition"
  if (typeLabel.includes("边界")) return "boundary_value"
  if (typeLabel.includes("路径")) return "basic_path"
  if (typeLabel.includes("条件") || typeLabel.includes("MC/DC")) return "condition_combination"
  if (typeLabel.includes("状态")) return "state_transition"
  if (isAIGen) return "equivalence_partition"
  // AUnit auto-gen default: condition_combination (Z3 solver for coverage)
  return "condition_combination"
}
```

**Step 2: Verify file compiles**

Run: `cd "D:\code\matrix-embedded-agent" && bun run typecheck`
Expected: no errors

**Step 3: Commit**

```bash
git add src/tools/aunit/aunit-sync-report.ts
git commit -m "feat: add aunit_sync_report tool for gson-to-Matrix data sync"
```

---

### Task 3: Register New Tools

**Files:**
- Modify: `src/tools/aunit/index.ts`
- Modify: `src/create-tools.ts`

**Step 1: Update barrel exports**

In `src/tools/aunit/index.ts`, append:

```typescript
export { aunitInjectCases } from "./aunit-inject-cases"
export { aunitSyncReport } from "./aunit-sync-report"
```

**Step 2: Register in create-tools.ts**

In `src/create-tools.ts`, add to imports:

```typescript
import {
  aunitCreateProject,
  aunitBuild,
  aunitAutogen,
  aunitRunCase,
  aunitReport,
  aunitInjectCases,
  aunitSyncReport,
} from "./tools/aunit"
```

Add to `allTools` object after existing AUnit entries:

```typescript
    aunit_inject_cases: aunitInjectCases,
    aunit_sync_report: aunitSyncReport,
```

**Step 3: Typecheck**

Run: `cd "D:\code\matrix-embedded-agent" && bun run typecheck`
Expected: PASS

**Step 4: Commit**

```bash
git add src/tools/aunit/index.ts src/create-tools.ts
git commit -m "feat: register aunit_inject_cases and aunit_sync_report tools"
```

---

### Task 4: Create Functional Case Generation Skill

**Files:**
- Create: `skills/functional-case-gen/SKILL.md`

**Step 1: Write skill file**

```markdown
---
name: functional-case-gen
description: "Design functional correctness test cases for embedded C/C++ functions based on software requirements and code analysis. Outputs gson-compatible case structures for injection into AUnit projects via aunit_inject_cases."
metadata:
  phase: "4"
  agent: "unit-tester"
  category: "testing"
---

## Role

You are a functional test case designer for embedded software. Your job is to design test cases that verify **functional correctness** — whether the code correctly implements its requirements. You complement AUnit's auto-generated coverage-driven cases with requirement-driven cases.

## Inputs

Read these artifacts before designing cases:

1. `.matrix/data/software-analysis.json` — function list, parameters, requirement traceability
2. `.matrix/wiki/index.json` → `.matrix/wiki/functions/<func_id>.json` — semantic understanding, boundary conditions, error handling hints
3. `.matrix/data/test-requirements.json` (if exists) — formal test requirements with traceability

## Design Methodology

For each function with requirement traceability, apply these methods in order:

### 1. Requirement-Driven Cases
For each linked requirement:
- **Positive case**: inputs that satisfy the requirement's normal path
- **Negative case**: inputs that trigger the requirement's error/boundary path
- Trace each case back to the requirement ID

### 2. Equivalence Partition
- Partition the input domain into equivalence classes based on requirement clauses
- Select one representative value from each class
- Include at least one invalid/out-of-range class per parameter

### 3. Boundary Value Analysis
- For each parameter boundary mentioned in requirements or detected in code:
  - Test at the boundary value itself
  - Test one step inside (boundary - 1 or + 1 as appropriate)
  - Test one step outside

### 4. Error Guessing (Embedded-Specific)
Based on common embedded defects:
- Integer overflow/underflow at type limits
- NULL/zero pointer for pointer parameters
- Division by zero for divisor parameters
- Array out-of-bounds for index parameters
- Interrupt-safe access patterns for shared variables

## Output Format

Return a JSON array of function-case groups. Each group targets one function and contains cases ready for `aunit_inject_cases`:

```json
[
  {
    "function_name": "MCDCTest",
    "cases": [
      {
        "desc": "验证当 a<0 且 b<100 且 c<100 时返回 2*(b+c)",
        "paraExprs": [
          {"expr": "a", "in": "-1"},
          {"expr": "b", "in": "50"},
          {"expr": "c", "in": "50"}
        ],
        "types": [{"type": "功能测试", "comment": "需求正向验证"}]
      }
    ]
  }
]
```

### Field Rules

- `desc`: Chinese description of what the case verifies and which requirement it traces to
- `paraExprs`: must match the function's parameter names exactly (from software-analysis.json or wiki)
- `paraExprs[].in`: always a string representation of the value (e.g., `"-1"`, `"100"`, `"0"`)
- `types[].type`: use `"功能测试"` for requirement-driven, `"边界测试"` for boundary, `"异常测试"` for error guessing

## Constraints

- ONLY design cases for functions that have requirement traceability or are safety-critical
- Do NOT design coverage-driven cases (MC/DC, basic path) — AUnit autogen handles those
- Do NOT fabricate parameter names — read them from software-analysis.json or code wiki
- Each case must have a clear desc linking it to a requirement or boundary condition
- Limit to 10 cases per function maximum (focus on high-value cases)
```

**Step 2: Verify skill file exists in correct location**

Run: `ls "D:/code/matrix-embedded-agent/skills/functional-case-gen/SKILL.md"`
Expected: file listed

**Step 3: Commit**

```bash
git add skills/functional-case-gen/SKILL.md
git commit -m "feat: add functional-case-gen skill for requirement-driven test case design"
```

---

### Task 5: Rewrite Unit-Tester Agent Prompt

**Files:**
- Modify: `src/agents/unit-tester.ts`

**Step 1: Rewrite the system prompt and tools map**

Replace the entire `UNIT_TESTER_SYSTEM_PROMPT` with the AUnit-tool-chain-driven workflow. Replace the `tools` map to include the two new tools.

Key changes:
- Remove Steps 3-8 (manual ut_report flow)
- Main line: AUnit tool chain serial calls
- Step 3: parallel dispatch of aunit_autogen + functional-case-gen sub-agent
- Step 4: aunit_inject_cases to merge functional cases
- Step 5: aunit_run_case
- Step 6: aunit_sync_report
- Step 7: aunit_report
- Add `aunit_inject_cases` and `aunit_sync_report` to tools map
- Keep `task` permission for spawning functional-case-gen sub-agent

**Step 2: Typecheck**

Run: `cd "D:\code\matrix-embedded-agent" && bun run typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add src/agents/unit-tester.ts
git commit -m "feat: rewrite unit-tester prompt for AUnit-driven workflow"
```

---

### Task 6: Build, Deploy, and Verify

**Step 1: Full typecheck**

Run: `cd "D:\code\matrix-embedded-agent" && bun run typecheck`
Expected: PASS

**Step 2: Build**

Run: `cd "D:\code\matrix-embedded-agent" && bun run build`
Expected: Bundled N modules, dist/index.js created

**Step 3: Deploy to OpenCode**

Run: `cp "D:/code/matrix-embedded-agent/dist/index.js" "C:/Users/lyw/.config/opencode/plugins/matrix-embedded-agent.js"`
Expected: file copied

**Step 4: Commit all remaining changes**

```bash
git add -A
git commit -m "feat: complete unit-tester AUnit-driven workflow redesign"
```
