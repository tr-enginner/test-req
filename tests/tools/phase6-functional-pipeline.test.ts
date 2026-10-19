import { describe, expect, test } from "bun:test"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { dirname, join } from "path"
import { testcaseGeneratorRun, testcaseFormatCheck } from "../../src/tools/testcase-generator-runner"
import { ctSuiteCreate } from "../../src/tools/ct-suite-builder"
import { phase6CaseReviewPrepare } from "../../src/tools/phase6-case-review-prepare"

const categories = [
  ["BOOT", "引导加载", []], ["INIT", "初始化", []],
  ["SWRC", "接收处理Spacewire总线上注数据", ["spacewire"]],
  ["TM", "轮询指令接收处理", ["primary-can"]],
  ["TC", "遥控指令接收处理", ["primary-can"]],
  ["DATA249", "249字节上行数据块处理", ["primary-can", "ordered-upload"]],
  ["DATA72", "72字节上行数据块处理", ["primary-can"]],
  ["NCDC", "内存读出指令接收处理", ["primary-can"]],
  ["NCZL", "内存数据轮询指令接收处理", ["primary-can"]],
  ["FZSJ", "卫星服务系统辅助数据接收处理", ["primary-can"]],
  ["TIME", "星务时间广播接收处理", ["primary-can"]],
  ["SPICJ", "采集SPI总线遥测", ["spi-bus"]],
  ["CANCJ", "采集二级CAN总线遥测", ["secondary-bus"]],
  ["FPGACJ", "采集FPGA状态遥测", ["fpga-telemetry"]],
  ["XJFZ", "发送相机辅助数据", ["primary-can", "secondary-bus"]],
  ["KW", "定标黑体控温", ["primary-can"]],
] as const

function writeJson(file: string, data: unknown) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(data), "utf-8")
}
function ctx(directory: string) {
  return { sessionID: "s", messageID: "m", agent: "test-designer", directory, worktree: directory, abort: new AbortController().signal, metadata: () => {}, ask: async () => {} }
}

describe("functional generation/format/review pipeline", () => {
  test("all 16 groups keep test-functional.md and inject the proper interface models; manual cases persist untranslated", async () => {
    const dir = mkdtempSync(join(tmpdir(), "matrix-functional-models-"))
    const oldCwd = process.cwd()
    const oldGeneratorPath = process.env.MATRIX_TESTCASE_GENERATOR_PATH
    try {
      cpSync(join(import.meta.dir, "../../templates/testcase-prompts"), join(dir, "testcase-prompts"), { recursive: true })
      process.env.MATRIX_TESTCASE_GENERATOR_PATH = dir
      process.chdir(dir)
      const reqFile = join(dir, ".matrix/data/test-requirements.json")
      writeJson(reqFile, {
        // Shared interrupt context must not turn BOOT/INIT/FPGA into Spacewire uploads.
        interruptContext: "外部中断2：Spacewire总线上注数据块接收处理；SPI总线遥测；二级CAN总线。",
        funItem: categories.map(([id, title], i) => ({
          funId: [`TR-GN-${id}-001`], testType: "功能测试", titleNo: `4.1.${i + 1}`, title: `${title}需求项[TR-GN-${id}]`,
          requirementContext: `${title}。`, inputFlowContext: "无。", outputFlowContext: "无。",
          processingContext: `TR-GN-${id}-001：验证${title}是否符合需求。`,
        })),
      })
      const generation = JSON.parse(await (testcaseGeneratorRun as any).execute({ test_requirements_file: reqFile }, ctx(dir)))
      expect(generation.status).toBe("success")
      const manifest = JSON.parse(readFileSync(generation.generation_manifest_file, "utf-8"))
      expect(manifest.items).toHaveLength(16)
      for (const [id, , sections] of categories) {
        const item = manifest.items.find((item: any) => item.requirement_id === `TR-GN-${id}-001`)
        expect(item.template_file).toEndWith("test-functional.md")
        expect(item.interface_sections).toEqual([...sections])
        if (["BOOT", "INIT"].includes(id)) {
          expect(item.keyword_candidates).toEqual([])
          expect(JSON.parse(item.normalization_context_json).step_plan).toBeNull()
        }
        expect(item.prompt).not.toContain("{{INTERFACE_SECTIONS}}")
      }
      expect(manifest.items.find((item: any) => item.requirement_id === "TR-GN-SWRC-001").prompt).toContain("Spacewire 上注数据块测试模型")
      expect(manifest.items.find((item: any) => item.requirement_id === "TR-GN-DATA249-001").prompt).toContain("所有包共同分摊错误清单")
      for (const id of ["SPICJ", "CANCJ"]) {
        const prompt = manifest.items.find((item: any) => item.requirement_id === `TR-GN-${id}-001`).prompt
        expect(prompt).toContain("回读")
        expect(prompt).toContain("自主轮询不能豁免回读")
      }

      await (ctSuiteCreate as any).execute({ project_name: "模型回归", version: "1.0" })
      for (const id of ["BOOT", "INIT"]) {
        const requirementId = `TR-GN-${id}-001`
        const source = [{ case_name: `${id}人工验证`, test_purpose: "验证需求规定的引导参数和初始化状态。", covered_tr_items: [requirementId], test_step: [{ 步骤描述: "检查SRAM中的引导参数及初始化状态。", 预期结果: "引导参数及初始化状态与需求规定值一致。" }] }]
        const formatted = JSON.parse(await (testcaseFormatCheck as any).execute({ generated_text: JSON.stringify(source), requirement_id: requirementId, persist: true }, ctx(dir)))
        expect(formatted.persisted).toBe(true)
        expect(formatted.per_case_status[0].translate_status).toBe("not_applicable")
      }
      const suite = JSON.parse(readFileSync(join(dir, ".matrix/data/confirmation-tests.json"), "utf-8"))
      expect(suite.test_cases).toHaveLength(2)
      expect(suite.test_cases.every((c: any) => c.translate_status === "not_applicable" && c.test_step.every((s: any) => !s.key_name && s.translation_exempt_reason === "manual_requirement"))).toBe(true)

      const review = JSON.parse(await (phase6CaseReviewPrepare as any).execute({ project_dir: dir }, ctx(dir)))
      const prepared = JSON.parse(readFileSync(review.prepared_file, "utf-8"))
      expect(prepared.summary.covered_requirements).toBe(2)
      expect(prepared.semantic_validation_failures ?? []).toEqual([])

      // Neither normal persistence nor the mechanical-repair retry may admit
      // the historical CANA Spacewire input or repeated-first-packet sequence.
      for (const [id, descriptions] of [
        ["SWRC", ["第3秒，通过CANA总线发送正确的管控程序上注数据块。"]],
        ["DATA249", ["第3秒，通过CANA总线发送正确的249字节上行数据块第一包。", "第4秒，通过CANA总线发送249字节上行数据块第一包（首帧仲裁场错误，其余字段正确）。", "第5秒，通过CANA总线发送正确的249字节上行数据块第一包。"]],
        ["SPICJ", ["第3秒，通过SPI总线发送站地址11H的正确电机遥测数据。"]],
        ["CANCJ", ["第3秒，通过二级CAN总线发送站地址11H的正确遥测数据。"]],
      ] as const) {
        for (const autoRepair of [false, true]) {
          const formatted = JSON.parse(await (testcaseFormatCheck as any).execute({
            requirement_id: `TR-GN-${id}-001`, persist: true, auto_repair_structural_violations: autoRepair,
            generated_text: JSON.stringify([{ case_name: `${id}错误模型`, test_purpose: "验证数据包的接收处理。", covered_tr_items: [`TR-GN-${id}-001`], test_step: descriptions.map((步骤描述) => ({ 步骤描述, 预期结果: "软件按需求处理，正确计数为1。" })) }]),
          }, ctx(dir)))
          expect(formatted.persisted).toBe(false)
          expect((formatted.structure_violations ?? []).some((v: any) => v.type === "functional_model_violation")
            || (formatted.errors ?? []).some((v: any) => /多包/.test(v.message))).toBe(true)
        }
      }
      expect(JSON.parse(readFileSync(join(dir, ".matrix/data/confirmation-tests.json"), "utf-8")).test_cases).toHaveLength(2)

      // Review catches old, incorrectly translated manual artifacts as well.
      suite.test_cases[0].translate_status = "success"
      suite.test_cases[0].test_step[0].key_name = "读取数据包数据"
      // Legacy successful records must also be checked against their source
      // action and payload, not accepted solely on translate_status=success.
      for (const [id, source, rendered, payload] of [
        ["SWRC", "第3.2秒，触发外部中断2。", "第3.2秒，通过CANA总线发送开关指令", "开关指令"],
        ["SPICJ", "第4秒，通过SPI总线发送遥测数据（站地址错误，其余字段正确）。", "第4秒，通过SPI总线发送遥测数据（站地址错误", "遥测数据（站地址错误"],
      ]) {
        suite.test_cases.push({
          ...suite.test_cases[0], case_id: `TC-GN-${id}-001`, case_name: `${id}历史错误翻译`, correspond_fun_id: `TR-GN-${id}-001`,
          test_step: [{ ...suite.test_cases[0].test_step[0], translation_exempt_reason: undefined,
            source_step_desc: source, step_desc: rendered, key_name: id === "SWRC" ? "发送CANA数据_数据文件" : "发送SPI-TXT数据",
            parameter: [{ Name: "${para2}", Value: payload, Comments: "数据文件" }],
          }],
        })
      }
      writeJson(join(dir, ".matrix/data/confirmation-tests.json"), suite)
      const recheck = JSON.parse(await (phase6CaseReviewPrepare as any).execute({ project_dir: dir }, ctx(dir)))
      const invalidReview = JSON.parse(readFileSync(recheck.prepared_file, "utf-8"))
      expect(invalidReview.semantic_validation_failures.some((v: any) => v.errors.some((s: string) => s.includes("不得执行关键字翻译")))).toBe(true)
      expect(invalidReview.semantic_validation_failures.some((v: any) => v.errors.some((s: string) => s.includes("实际动作不一致")))).toBe(true)
      expect(invalidReview.semantic_validation_failures.some((v: any) => v.errors.some((s: string) => s.includes("载荷参数丢失")))).toBe(true)
    } finally {
      process.chdir(oldCwd)
      if (oldGeneratorPath === undefined) delete process.env.MATRIX_TESTCASE_GENERATOR_PATH
      else process.env.MATRIX_TESTCASE_GENERATOR_PATH = oldGeneratorPath
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
