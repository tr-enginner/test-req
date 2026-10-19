import { describe, expect, test } from "bun:test"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { dirname, join } from "path"
import { validateTestTypeCases } from "../../src/shared/phase6-test-type-policy"
import { buildRequirementIndex } from "../../src/shared/test-requirements"
import { appendConfirmationCaseToSuiteData } from "../../src/tools/ct-suite-builder"
import { phase6CaseReviewPrepare } from "../../src/tools/phase6-case-review-prepare"
import { testcaseFormatCheck, testcaseGeneratorRun } from "../../src/tools/testcase-generator-runner"

// The AQ prefix deliberately disagrees with testType: classification must use the requirement.
const requirementId = "TR-AQ-018"
const recoveryRequirement = {
  funId: [requirementId], testType: "恢复性测试", titleNo: "4.3.1", title: "数据接收功能恢复",
  requirementContext: "验证规定条件下软件恢复数据接收。",
  inputFlowContext: "无。", outputFlowContext: "无。",
  processingContext: `${requirementId}：通信恢复后软件正常运行，数据接收状态为已恢复。`,
}
const validCase = {
  case_name: "数据接收恢复检查", test_purpose: "验证通信恢复后数据接收状态为已恢复。",
  correspond_fun_id: requirementId, covered_tr_items: [requirementId], test_type: "恢复性测试",
  test_step: [
    { 步骤描述: "第3秒，检查软件运行状态。", 预期结果: "软件处于正常运行状态。" },
    { 步骤描述: "第4秒，检查软件数据接收状态。", 预期结果: "数据接收状态为已恢复。" },
  ],
}
const zeroTimeCase = {
  ...validCase,
  test_step: [
    { 步骤描述: "第0.0秒，初始化测试环境。", 预期结果: "测试环境初始化完成。" },
    ...validCase.test_step,
  ],
}
const conflictingTimeViews = [
  {
    name: "rendered step_desc is zero while the source is nonzero",
    patch: { source_step_desc: "第3秒，检查软件运行状态。", step_desc: "第0.0秒，检查软件运行状态。" },
  },
  {
    name: "temporal anchor is zero while both descriptions are nonzero",
    patch: { source_step_desc: "第3秒，检查软件运行状态。", step_desc: "第3秒，检查软件运行状态。", temporal: "0s" },
  },
  {
    name: "source_step_desc is zero while the action, rendering, and anchor are nonzero",
    patch: { source_step_desc: "在第零秒，检查软件运行状态。", step_desc: "第3秒，检查软件运行状态。", temporal: "第3秒" },
  },
]

function ctx(directory: string) {
  return {
    directory, worktree: directory, sessionID: "recovery-time", messageID: "m", agent: "test-designer",
    abort: new AbortController().signal, metadata: () => {}, ask: async () => {},
  }
}
function writeJson(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value), "utf8")
}
async function withFixture(run: (dir: string, item: any) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "matrix-recovery-time-"))
  const previousGeneratorPath = process.env.MATRIX_TESTCASE_GENERATOR_PATH
  try {
    cpSync(join(import.meta.dir, "../../templates/testcase-prompts"), join(dir, "testcase-prompts"), { recursive: true })
    process.env.MATRIX_TESTCASE_GENERATOR_PATH = dir
    const requirementFile = join(dir, ".matrix/data/test-requirements.json")
    writeJson(requirementFile, { funItem: [recoveryRequirement] })
    const result = JSON.parse(await (testcaseGeneratorRun as any).execute({ test_requirements_file: requirementFile }, ctx(dir)))
    expect(result.status).toBe("success")
    const manifest = JSON.parse(readFileSync(result.generation_manifest_file, "utf8"))
    const item = manifest.items.find((entry: any) => entry.requirement_id === requirementId)
    expect(item).toBeDefined()
    await run(dir, item)
  } finally {
    if (previousGeneratorPath === undefined) delete process.env.MATRIX_TESTCASE_GENERATOR_PATH
    else process.env.MATRIX_TESTCASE_GENERATOR_PATH = previousGeneratorPath
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("recovery zero-time source-step gate", () => {
  test("the recovery manifest selects its template and forbids zero-time steps regardless of the AQ id", async () => {
    await withFixture(async (_dir, item) => {
      expect(item.test_type_chinese).toBe("恢复性测试")
      expect(item.template_file).toEndWith("test-software-recovery.md")
      expect(item.prompt).toContain("禁止0秒")
      expect(readFileSync(item.worker_prompt_file, "utf8")).toContain("禁止0秒")
      expect(JSON.parse(item.normalization_context_json).test_type_chinese).toBe("恢复性测试")
    })
  })

  test("preview and persistence reject source initialization at 0.0 seconds before automatic repair", async () => {
    await withFixture(async (dir) => {
      const sourceFile = join(dir, `.matrix/data/${requirementId}_output.json`)
      const suiteFile = join(dir, ".matrix/data/confirmation-tests.json")
      const legacySuiteFile = join(dir, ".matrix/data/source-confirmation-tests.json")
      writeJson(sourceFile, [zeroTimeCase])
      const originalSource = readFileSync(sourceFile, "utf8")
      for (const persist of [false, true]) {
        const result = JSON.parse(await (testcaseFormatCheck as any).execute({
          requirement_id: requirementId, generated_text_file: sourceFile, persist,
          auto_repair_structural_violations: true,
        }, ctx(dir)))
        expect(result.valid).toBe(false)
        expect(JSON.stringify(result.errors)).toContain("禁止0秒")
        expect(existsSync(suiteFile)).toBe(false)
        expect(existsSync(legacySuiteFile)).toBe(false)
        expect(readFileSync(sourceFile, "utf8")).toBe(originalSource)
      }

      // A failed retry also leaves an existing suite byte-for-byte unchanged.
      const previousSuite = JSON.stringify({ project_name: "既有恢复性测试", version: "1.0", test_cases: [] })
      writeFileSync(suiteFile, previousSuite, "utf8")
      const retried = JSON.parse(await (testcaseFormatCheck as any).execute({
        requirement_id: requirementId, generated_text_file: sourceFile, persist: true,
        auto_repair_structural_violations: true,
      }, ctx(dir)))
      expect(retried.valid).toBe(false)
      expect(retried.persisted).toBe(false)
      expect(JSON.stringify(retried.errors)).toContain("禁止0秒")
      expect(readFileSync(suiteFile, "utf8")).toBe(previousSuite)
      expect(readFileSync(sourceFile, "utf8")).toBe(originalSource)
    })
  })

  test("direct builder rejects zero-time recovery without a manifest and honors the authoritative type", () => {
    expect(() => appendConfirmationCaseToSuiteData({ test_cases: [] }, zeroTimeCase)).toThrow("禁止0秒")
    const index = buildRequirementIndex({ funItem: [recoveryRequirement] } as any)
    expect(() => appendConfirmationCaseToSuiteData(
      { test_cases: [] }, { ...zeroTimeCase, test_type: "可靠性安全性测试" }, index,
    )).toThrow("禁止0秒")
    const result = appendConfirmationCaseToSuiteData(
      { test_cases: [] }, { ...validCase, test_type: "可靠性安全性测试" }, index,
    )
    expect(result.persisted_case.test_type).toBe("恢复性测试")
    expect(result.persisted_case.test_step.map(step => step.source_step_desc)).toEqual(validCase.test_step.map(step => step.步骤描述))
  })

  for (const { name, patch } of conflictingTimeViews) {
    test(`format, direct builder, and review reject conflicting timing: ${name}`, async () => {
      await withFixture(async (dir) => {
        const source = {
          ...validCase,
          test_step: [{ ...validCase.test_step[0]!, ...patch }, validCase.test_step[1]!],
        }
        const suiteFile = join(dir, ".matrix/data/confirmation-tests.json")
        for (const persist of [false, true]) {
          const formatted = JSON.parse(await (testcaseFormatCheck as any).execute({
            requirement_id: requirementId, generated_text: JSON.stringify([source]), persist,
            auto_repair_structural_violations: true,
          }, ctx(dir)))
          expect(formatted.valid).toBe(false)
          expect(JSON.stringify(formatted.errors)).toContain("禁止0秒")
          expect(existsSync(suiteFile)).toBe(false)
        }
        expect(() => appendConfirmationCaseToSuiteData({ test_cases: [] }, source)).toThrow("禁止0秒")

        // Keep the raw temporal anchor in the JSON, before schema parsing can strip it.
        const imported = appendConfirmationCaseToSuiteData({ test_cases: [] }, validCase).persisted_case
        Object.assign(imported.test_step[0]!, patch)
        writeJson(suiteFile, {
          project_name: "恢复性时间视图回归", version: "1.0", created_date: "20261009", test_cases: [imported],
          traceability: [{ test_req_id: requirementId, case_ids: [imported.case_id], coverage_status: "full" }],
          summary: { total_cases: 1, by_type: { 恢复性测试: 1 } },
        })
        const review = JSON.parse(await (phase6CaseReviewPrepare as any).execute({ project_dir: dir }, ctx(dir)))
        expect(review.status).toBe("success")
        const prepared = JSON.parse(readFileSync(review.prepared_file, "utf8"))
        const failures = prepared.semantic_validation_failures.filter((failure: any) => failure.correspond_fun_id === requirementId)
        expect(JSON.stringify(failures)).toContain("禁止0秒")
      })
    })
  }

  test("a keyword document cannot introduce zero time after a valid source step passes validation", async () => {
    await withFixture(async (dir) => {
      writeJson(join(dir, ".matrix/data/DTPProject/组合关键字/UserKeyword.json"), {
        Items: [{
          Name: "检查软件运行状态", Comments: "第0.0秒，检查软件运行状态。",
          Arguments: [{ Name: "${time}", Comments: "执行时间" }],
        }],
      })
      const sourceFile = join(dir, `.matrix/data/${requirementId}_output.json`)
      writeJson(sourceFile, [{ ...validCase, test_step: [validCase.test_step[0]!] }])
      const originalSource = readFileSync(sourceFile, "utf8")
      expect(originalSource).not.toContain("第0")
      for (const persist of [false, true]) {
        const formatted = JSON.parse(await (testcaseFormatCheck as any).execute({
          requirement_id: requirementId, generated_text_file: sourceFile, persist,
          auto_repair_structural_violations: true,
        }, ctx(dir)))
        expect(formatted.valid).toBe(false)
        expect(JSON.stringify(formatted.errors)).toContain("禁止0秒")
        expect(existsSync(join(dir, ".matrix/data/confirmation-tests.json"))).toBe(false)
        expect(readFileSync(sourceFile, "utf8")).toBe(originalSource)
      }
    })
  })

  test("recovery steps starting at 3 seconds pass preview, persistence, and independent review", async () => {
    await withFixture(async (dir) => {
      writeJson(join(dir, ".matrix/data/confirmation-tests.json"), {
        project_name: "恢复性时间回归", version: "1.0", created_date: "20261009", test_cases: [],
        traceability: [], summary: { total_cases: 0, by_type: {} },
      })
      writeJson(join(dir, ".matrix/data/DTPProject/组合关键字/UserKeyword.json"), {
        Items: ["检查软件运行状态", "检查软件数据接收状态"].map(Name => ({
          Name, Comments: `第\${time}秒，${Name}。`, Arguments: [{ Name: "${time}", Comments: "执行时间" }],
        })),
      })
      for (const persist of [false, true]) {
        const result = JSON.parse(await (testcaseFormatCheck as any).execute({
          requirement_id: requirementId, generated_text: JSON.stringify([validCase]), persist,
          auto_repair_structural_violations: true,
        }, ctx(dir)))
        expect(result.valid).toBe(true)
        if (persist) expect(result.persisted).toBe(true)
      }
      const suite = JSON.parse(readFileSync(join(dir, ".matrix/data/confirmation-tests.json"), "utf8"))
      expect(suite.test_cases).toHaveLength(1)
      expect(suite.test_cases[0].test_type).toBe("恢复性测试")
      expect(suite.test_cases[0].test_step.some((step: any) => step.source_step_desc === validCase.test_step[0]!.步骤描述)).toBe(true)
      const review = JSON.parse(await (phase6CaseReviewPrepare as any).execute({ project_dir: dir }, ctx(dir)))
      expect(review.status).toBe("success")
      const prepared = JSON.parse(readFileSync(review.prepared_file, "utf8"))
      expect(prepared.semantic_validation_failures).toEqual([])
    })
  })

  test("fractional nonzero starts and zeros in fields, waits, and expectations remain valid", async () => {
    expect(validateTestTypeCases("恢复性测试", [{
      test_step: [{ 步骤描述: "0秒后检查软件运行状态。", 预期结果: "软件运行状态为正常。" }],
    }])).toEqual([])
    await withFixture(async (dir) => {
      const suiteFile = join(dir, ".matrix/data/confirmation-tests.json")
      writeJson(suiteFile, {
        project_name: "恢复性零值边界回归", version: "1.0", created_date: "20261009", test_cases: [],
        traceability: [], summary: { total_cases: 0, by_type: {} },
      })
      writeJson(join(dir, ".matrix/data/DTPProject/组合关键字/UserKeyword.json"), {
        Items: ["检查软件运行状态", "检查故障标志字段为0", "等待0秒"].map(Name => ({
          Name, Comments: `第\${time}秒，${Name}。`, Arguments: [{ Name: "${time}", Comments: "执行时间" }],
        })),
      })
      const accepted = [
        { name: "小数非零时刻", 步骤描述: "第0.5秒，检查软件运行状态。", temporal: "第0.5秒", 预期结果: "软件运行状态为正常。" },
        { name: "字段零值", 步骤描述: "第3秒，检查故障标志字段为0。", temporal: "第3秒", 预期结果: "故障标志字段为0。" },
        { name: "等待零秒", 步骤描述: "第3秒，等待0秒。", temporal: "第3秒", 预期结果: "软件运行状态为正常。" },
        { name: "预期结果零时刻", 步骤描述: "第3秒，检查软件运行状态。", temporal: "第3秒", 预期结果: "第0秒，软件运行状态为正常。" },
      ]
      for (const { name, ...step } of accepted) {
        const source = { ...validCase, case_name: name, test_step: [step] }
        expect(() => appendConfirmationCaseToSuiteData({ test_cases: [] }, source)).not.toThrow()
        for (const persist of [false, true]) {
          const formatted = JSON.parse(await (testcaseFormatCheck as any).execute({
            requirement_id: requirementId, generated_text: JSON.stringify([source]), persist,
            auto_repair_structural_violations: true,
          }, ctx(dir)))
          expect(formatted.valid).toBe(true)
          if (persist) expect(formatted.persisted).toBe(true)
        }
      }
      const suite = JSON.parse(readFileSync(suiteFile, "utf8"))
      expect(suite.test_cases).toHaveLength(accepted.length)
      const review = JSON.parse(await (phase6CaseReviewPrepare as any).execute({ project_dir: dir }, ctx(dir)))
      expect(review.status).toBe("success")
      const prepared = JSON.parse(readFileSync(review.prepared_file, "utf8"))
      expect(prepared.semantic_validation_failures).toEqual([])
    })
  })

  test("independent review rejects an imported suite whose source has a hidden zero-time step", async () => {
    await withFixture(async (dir) => {
      const imported = appendConfirmationCaseToSuiteData({ test_cases: [] }, validCase).persisted_case
      // Simulate a hand edit to source provenance; the rendered step still says 第3秒.
      imported.test_step[0]!.source_step_desc = zeroTimeCase.test_step[0]!.步骤描述
      writeJson(join(dir, ".matrix/data/confirmation-tests.json"), {
        project_name: "恢复性时间回归", version: "1.0", created_date: "20261009", test_cases: [imported],
        traceability: [{ test_req_id: requirementId, case_ids: [imported.case_id], coverage_status: "full" }],
        summary: { total_cases: 1, by_type: { 恢复性测试: 1 } },
      })
      const review = JSON.parse(await (phase6CaseReviewPrepare as any).execute({ project_dir: dir }, ctx(dir)))
      expect(review.status).toBe("success")
      const prepared = JSON.parse(readFileSync(review.prepared_file, "utf8"))
      const failures = prepared.semantic_validation_failures.filter((failure: any) => failure.correspond_fun_id === requirementId)
      expect(failures.length).toBeGreaterThan(0)
      expect(JSON.stringify(failures)).toContain("禁止0秒")
    })
  })
})
