import { describe, expect, test } from "bun:test"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { dirname, join } from "path"
import { testcaseGeneratorRun, testcaseFormatCheck } from "../../src/tools/testcase-generator-runner"
import { ctSuiteCreate, appendConfirmationCaseToSuiteData } from "../../src/tools/ct-suite-builder"
import { phase6CaseReviewPrepare } from "../../src/tools/phase6-case-review-prepare"
import { isManualTestRequirement, validateTestTypeCases } from "../../src/shared/phase6-test-type-policy"
import { normalizeTestRequirements } from "../../src/shared/test-requirements"
import { loadConfirmationCasesWithStatus } from "../../src/tools/dtp-data-generation-core"
import { generateDtpRobotScripts } from "../../src/tools/dtp-robot-generator"
import { getTestTypeChinese, getTestTypeEnglish } from "../../src/tools/dynamic-content-mapper"

function writeJson(file: string, data: unknown) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(data), "utf-8")
}
function ctx(directory: string) {
  return { sessionID: "s", messageID: "m", agent: "test-designer", directory, worktree: directory, abort: new AbortController().signal, metadata: () => {}, ask: async () => {} }
}
const categories = [
  ["XN", "性能测试", "test-software-performance.md", "软件初始化时间小于10s。"],
  ["YL", "余量测试", "test-margin.md", "PROM空间为128K，实际使用空间不超过80%。"],
  ["SJ", "数据处理测试", "test-data-processing.md", "处理输入数据并输出结果。"],
  ["HF", "恢复性测试", "test-software-recovery.md", "规定条件下恢复数据接收。"],
  ["QD", "强度测试", "test-software-stress.md", "连续运行24小时，覆盖遥测轮询与开关指令接收。"],
  ["BJ", "边界测试", "test-boundary.md", "输入值范围为[1,3]。"],
  ["AQ", "可靠性安全性测试", "test-software-safety.md", "按需求规定的投票逻辑处理数据。"],
] as const
const manualSteps = [
  { 步骤描述: "使用示波器多次测试软件初始化时间。", 预期结果: "软件初始化时间小于10s。" },
  { 步骤描述: "查看资源量使用文件，确认PROM空间使用量。", 预期结果: "PROM空间为128K，实际使用空间不超过80%。" },
]

describe("nonfunctional test-type policy", () => {
  test("manual exemption follows the requirement type, not measurement words in steps", () => {
    expect(isManualTestRequirement({ testType: "performance" })).toBe(true)
    expect(isManualTestRequirement({ testType: "余量测试" })).toBe(true)
    expect(isManualTestRequirement({ testType: "功能测试", name: "使用示波器多次测试时间" })).toBe(false)
    expect(isManualTestRequirement({ testType: "recovery", name: "初始化异常恢复" })).toBe(false)
  })

  test("fixed manual sentence/environment and stress singleton/time continuity are enforced", () => {
    expect(validateTestTypeCases("性能测试", [{ test_environment: "硬平台测试环境", test_step: [manualSteps[0]!] }])).toEqual([])
    expect(validateTestTypeCases("余量测试", [{ test_environment: "人工分析", test_step: [manualSteps[1]!] }])).toEqual([])
    expect(validateTestTypeCases("余量测试", [{ test_environment: "软平台测试环境", test_step: [manualSteps[0]!] }])).toHaveLength(2)
    const stressCase = { test_step: ["第3秒，发送输入。", "第1分钟，检查输出。", "第24小时，检查输出。"].map((步骤描述) => ({ 步骤描述, 预期结果: "需求规定的功能正常。" })) }
    expect(validateTestTypeCases("stress", [stressCase])).toEqual([])
    expect(validateTestTypeCases("强度测试", [stressCase, stressCase])[0]!.message).toContain("只能")
    expect(validateTestTypeCases("强度测试", [{ test_step: [...stressCase.test_step, { 步骤描述: "第3秒，进入下一轮。", 预期结果: "正常。" }] }])[0]!.message).toContain("回拨")
    expect(validateTestTypeCases("强度测试", [{ test_step: [{ 步骤描述: "进入下一轮。", 预期结果: "正常。" }] }])[0]!.message).toContain("时间原点")
  })

  test("direct suite writes force manual state and canonical safety name and reject split stress cases", () => {
    const base = { case_name: "性能检查", test_purpose: "验证软件初始化耗时满足要求。", correspond_fun_id: "TR-XN-001", test_type: "性能测试", test_step: [manualSteps[0]!], translate_status: "success" as const, test_environment: "软平台测试环境" }
    const manual = appendConfirmationCaseToSuiteData({ test_cases: [] }, base).persisted_case
    expect(manual.test_environment).toBe("硬平台测试环境")
    expect(manual.translate_status).toBe("not_applicable")
    expect(manual.test_step[0]!.key_name).toBe("")
    const safety = appendConfirmationCaseToSuiteData({ test_cases: [] }, { ...base, test_type: "安全性测试" }).persisted_case
    expect(safety.test_type).toBe("可靠性安全性测试")
    const stressInput = { ...base, test_type: "强度测试", correspond_fun_id: "TR-QD-001", test_step: [{ 步骤描述: "第3秒，发送输入。", 预期结果: "软件处理输入。" }] }
    const first = appendConfirmationCaseToSuiteData({ test_cases: [] }, stressInput)
    expect(() => appendConfirmationCaseToSuiteData(first.suite, stressInput)).toThrow("只能生成一个综合用例")
    const normalized = normalizeTestRequirements({ funItem: [{ funId: ["TR-AQ-001"], testType: "可靠性安全性测试", title: "可靠性保护", processingContext: "处理数据。" }] })
    expect(normalized[0]!.type).toBe("safety")
    expect(getTestTypeEnglish("安全性测试")).toBe("security_test")
    expect(getTestTypeEnglish("可靠性安全性测试")).toBe("security_test")
    expect(getTestTypeChinese("security_test")).toBe("可靠性安全性测试")
  })

  test("all seven templates route correctly; manual format/persistence/review agree and stress is not split", async () => {
    const dir = mkdtempSync(join(tmpdir(), "matrix-nonfunctional-"))
    const oldCwd = process.cwd()
    const oldGeneratorPath = process.env.MATRIX_TESTCASE_GENERATOR_PATH
    try {
      cpSync(join(import.meta.dir, "../../templates/testcase-prompts"), join(dir, "testcase-prompts"), { recursive: true })
      process.env.MATRIX_TESTCASE_GENERATOR_PATH = dir
      process.chdir(dir)
      // A plausible keyword exists: manual exemption must not depend on an empty catalog.
      writeJson(join(dir, ".matrix/data/DTPProject/组合关键字/UserKeyWord.json"), { Items: [{
        Name: "测量初始化时间", Documentation: "使用示波器多次测试软件初始化时间", Arguments: [],
      }] })
      const reqFile = join(dir, ".matrix/data/test-requirements.json")
      writeJson(reqFile, { interruptContext: "共享表：Spacewire外部中断2、SPI总线遥测、二级CAN总线轮询。", funItem: categories.map(([id, type, , handling], i) => ({
        funId: [`TR-${id}-001`], testType: type, titleNo: `4.${i + 1}.1`, title: `${type}需求项`,
        requirementContext: handling, inputFlowContext: "无。", outputFlowContext: "无。", processingContext: `TR-${id}-001：${handling}`,
      })) })
      const generation = JSON.parse(await (testcaseGeneratorRun as any).execute({ test_requirements_file: reqFile }, ctx(dir)))
      expect(generation.status).toBe("success")
      const manifest = JSON.parse(readFileSync(generation.generation_manifest_file, "utf-8"))
      expect(manifest.items).toHaveLength(7)
      for (const [id, type, filename] of categories) {
        const item = manifest.items.find((item: any) => item.requirement_id === `TR-${id}-001`)
        expect(item.template_file).toEndWith(filename)
        expect(item.test_type_chinese).toBe(type)
        expect(item.prompt).toContain("<test_type_rules>")
        expect(item.prompt).not.toContain("{{INTERFACE_SECTIONS}}")
        // Shared interrupt tables are not evidence that this requirement operates those interfaces.
        expect(item.interface_sections).not.toContain("spacewire")
        expect(item.interface_sections).not.toContain("spi-bus")
        if (id === "AQ") expect(item.interface_sections).toEqual([])
        expect(item.prompt).not.toContain("发送无")
        if (["XN", "YL"].includes(id)) {
          expect(item.keyword_candidates).toEqual([])
          expect(JSON.parse(item.normalization_context_json).step_plan).toBeNull()
          expect(item.interface_sections).toEqual([])
        }
      }
      const boundaryPrompt = manifest.items.find((item: any) => item.requirement_id === "TR-BJ-001").prompt
      expect(boundaryPrompt).toContain("下边界-1、下边界、下边界+1、中间值、上边界-1、上边界、上边界+1")
      expect(boundaryPrompt).toContain("重合值去重")
      await (ctSuiteCreate as any).execute({ project_name: "非功能回归", version: "1.0" })
      for (const [index, id] of ["XN", "YL"].entries()) {
        const requirementId = `TR-${id}-001`
        const source = [{ case_name: `${id}指标检查`, test_purpose: `验证${manualSteps[index]!.预期结果}`, covered_tr_items: [requirementId], test_step: [manualSteps[index]!] }]
        for (const persist of [false, true]) {
          const formatted = JSON.parse(await (testcaseFormatCheck as any).execute({ generated_text: JSON.stringify(source), requirement_id: requirementId, persist }, ctx(dir)))
          expect(formatted.valid).toBe(true)
          if (persist) expect(formatted.persisted).toBe(true)
          else expect(formatted.combined_translations[0].translate_status).toBe("not_applicable")
        }
      }
      const suiteFile = join(dir, ".matrix/data/confirmation-tests.json")
      const suite = JSON.parse(readFileSync(suiteFile, "utf-8"))
      expect(suite.test_cases.map((c: any) => c.test_environment)).toEqual(["硬平台测试环境", "人工分析"])
      expect(suite.test_cases.every((c: any) => c.translate_status === "not_applicable" && c.test_step.every((s: any) => !s.key_name && !s.parameter.length && s.translation_exempt_reason === "manual_requirement"))).toBe(true)
      const dtpCases = loadConfirmationCasesWithStatus(suiteFile)
      expect(dtpCases.cases.size).toBe(0)
      expect(dtpCases.skippedCases.size).toBe(2)
      // Even if a manual record reaches generated-test-data, Robot must skip it.
      const dtpRoot = join(dir, "DTP")
      const keywordDir = join(dtpRoot, "组合关键字")
      mkdirSync(join(dtpRoot, "V1"), { recursive: true })
      mkdirSync(keywordDir, { recursive: true })
      writeFileSync(join(keywordDir, "Demo.txt"), "", "utf-8")
      writeJson(join(keywordDir, "Demo.json"), { Items: [] })
      const generatedFile = join(dir, ".matrix/data/generated-test-data.json")
      writeJson(generatedFile, { schema_version: "1.1.0", cases: suite.test_cases.map((c: any) => ({ ...c, generated_steps: [] })) })
      expect(() => generateDtpRobotScripts({ workspaceRoot: dir, dtpRoot, generatedTestDataFile: generatedFile }))
        .toThrow("No cases with translate_status=success")
      const review = JSON.parse(await (phase6CaseReviewPrepare as any).execute({ project_dir: dir }, ctx(dir)))
      const prepared = JSON.parse(readFileSync(review.prepared_file, "utf-8"))
      expect(prepared.semantic_validation_failures).toEqual([])

      // Multi-command/multi-bus stress is one integrated sequence, not a structure violation.
      const stressCase = { case_name: "长时间综合测试", test_purpose: "验证24小时内遥测轮询与开关指令接收正确。", covered_tr_items: ["TR-QD-001"], test_step: [
        { 步骤描述: "第3秒，通过CANA总线发送正确的遥测帧1轮询控制序列。", 预期结果: "软件返回遥测帧1。" },
        { 步骤描述: "第4秒，通过CANB总线发送正确的开关指令。", 预期结果: "软件处理开关指令。" },
        { 步骤描述: "第24小时，检查软件处理结果。", 预期结果: "遥测轮询及开关指令处理正常。" },
      ] }
      const validStress = JSON.parse(await (testcaseFormatCheck as any).execute({ generated_text: JSON.stringify([stressCase]), requirement_id: "TR-QD-001" }, ctx(dir)))
      expect(validStress.valid).toBe(true)
      expect(validStress.structure_violations ?? []).toEqual([])
      // Source validation happens before translation and cannot be bypassed by auto-repair.
      for (const desc of [
        "第0秒，初始化测试环境。",
        "第3秒，通过CANA总线以1秒为周期发送遥测帧1~4轮询控制序列。",
        "第3秒，通过CANA总线发送开关指令（仲裁场错误，其余字段正确）。",
        "第3秒，通过CANA总线发送正确的249字节上行数据块。",
      ]) {
        const malformed = { ...stressCase, test_step: [{ 步骤描述: desc, 预期结果: "软件按需求处理。" }] }
        const formatted = JSON.parse(await (testcaseFormatCheck as any).execute({ generated_text: JSON.stringify([malformed]), requirement_id: "TR-QD-001", persist: true, auto_repair_structural_violations: true }, ctx(dir)))
        expect(formatted.valid).toBe(false)
        expect(() => appendConfirmationCaseToSuiteData({ test_cases: [] }, { ...malformed, correspond_fun_id: "TR-QD-001", test_type: "强度测试" })).toThrow()
      }
      for (const [id, desc, reason] of [
        ["BJ", "第3秒，发送数据，取值为下边界-1值0。", "边界步骤"],
        ["AQ", "第3秒，通过CANA总线发送配置指令，使SRAM刷新功能开启。", "指令名称缺乏依据"],
      ]) {
        const formatted = JSON.parse(await (testcaseFormatCheck as any).execute({ generated_text: JSON.stringify([{ case_name: "源步骤错误", test_purpose: "验证需求。", covered_tr_items: [`TR-${id}-001`], test_step: [{ 步骤描述: desc, 预期结果: "满足要求。" }] }]), requirement_id: `TR-${id}-001`, persist: true }, ctx(dir)))
        expect(formatted.valid).toBe(false)
        expect(JSON.stringify(formatted)).toContain(reason)
      }
      for (const autoRepair of [false, true]) {
        const invalidStress = JSON.parse(await (testcaseFormatCheck as any).execute({ generated_text: JSON.stringify([stressCase, stressCase]), requirement_id: "TR-QD-001", persist: true, auto_repair_structural_violations: autoRepair }, ctx(dir)))
        expect(invalidStress.valid).toBe(false)
        expect(JSON.stringify(invalidStress)).toContain("只能对应一个综合用例")
        const incomplete = JSON.parse(await (testcaseFormatCheck as any).execute({
          generated_text: JSON.stringify([{ ...stressCase, covered_tr_items: [] }]), requirement_id: "TR-QD-001",
          persist: true, auto_repair_structural_violations: autoRepair,
        }, ctx(dir)))
        expect(incomplete.persisted).toBe(false)
        expect(incomplete.regroup_directive).toContain("禁止套用指令×总线机械重组")
      }
      suite.test_cases[0].translate_status = "success"
      suite.test_cases[0].test_step[0].key_name = "读取数据包数据"
      suite.test_cases[1].test_environment = "软平台测试环境"
      // Simulate a hand-edited persisted record: independent review must reject it too.
      const stressRecord = appendConfirmationCaseToSuiteData({ test_cases: [] }, { ...stressCase, correspond_fun_id: "TR-QD-001", test_type: "强度测试" }).persisted_case
      stressRecord.test_step[0]!.source_step_desc = "第0秒，通过CANA总线发送配置指令，使SRAM刷新功能开启。"
      suite.test_cases.push(stressRecord)
      writeJson(suiteFile, suite)
      const badReview = JSON.parse(await (phase6CaseReviewPrepare as any).execute({ project_dir: dir }, ctx(dir)))
      const badPrepared = JSON.parse(readFileSync(badReview.prepared_file, "utf-8"))
      expect(badPrepared.semantic_validation_failures.length).toBeGreaterThanOrEqual(2)
      expect(JSON.stringify(badPrepared.semantic_validation_failures)).toContain("禁止0秒")
      expect(JSON.stringify(badPrepared.semantic_validation_failures)).toContain("指令名称缺乏依据")
    } finally {
      process.chdir(oldCwd)
      if (oldGeneratorPath === undefined) delete process.env.MATRIX_TESTCASE_GENERATOR_PATH
      else process.env.MATRIX_TESTCASE_GENERATOR_PATH = oldGeneratorPath
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
