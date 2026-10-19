import { describe, expect, test } from "bun:test"
import { resolveFunctionalModel, functionalInterfaceSections, isAutonomousTelemetry, validateFunctionalModelSteps } from "../../src/shared/phase6-functional-model"
import { analyzeCaseStructure, repairCaseStructure, translateStandardizedCaseToCombined } from "../../src/shared/phase6-confirmation-translator"
import { extractTranslatedStepsFromUnified, UnifiedTestStepArray } from "../../src/schema/confirmation-test-case"

const step = (步骤描述: string, 预期结果 = "软件按需求处理，正确计数为1。") => ({ 步骤描述, 预期结果 })
const send = (packet: string, error?: string) => step(`第3.0秒，通过CANA总线发送${error ? "" : "正确的"}249字节上行数据块${packet}（${error ?? "完整多帧，全部字段正确"}）。`)
const cycle = () => [send("第一包"), send("第一包", "首帧仲裁场错误，其余字段正确"), send("第二包"), send("第二包", "中间帧控制场错误，其余字段正确"), send("最后一包", "尾帧SUM错误，其余字段正确"), send("最后一包")]

describe("functional model selection", () => {
  test("manual exemptions are based on requirement identity, never incidental initialization prose", () => {
    expect(resolveFunctionalModel({ name: "引导加载需求项[TR-GN-BOOT]", testType: "功能测试" })).toBe("manual")
    expect(resolveFunctionalModel({ name: "初始化需求项[TR-GN-INIT]" })).toBe("manual")
    expect(resolveFunctionalModel({ requirementId: "TR-GN-INIT-001、TR-GN-INIT-002" })).toBe("manual")
    expect(resolveFunctionalModel({ requirementId: "TR-GN-INIT-001、TR-GN-TC-001" })).toBe("default")
    expect(resolveFunctionalModel({ name: "发送初始化指令", corpus: "引导加载后初始化总线" })).toBe("default")
    expect(resolveFunctionalModel({ name: "初始化需求项", testType: "接口测试" })).toBe("default")
    expect(functionalInterfaceSections("manual")).toEqual([])
  })

  test("FPGA status references to Spacewire and interrupt tables cannot select upload model", () => {
    const model = resolveFunctionalModel({ name: "采集FPGA状态遥测需求项", corpus: "Spacewire上注总线中断、二级CAN、SPI总线" })
    expect(functionalInterfaceSections(model)).toEqual(["fpga-telemetry"])
  })

  test("periodic telemetry is not an implicit primary-CAN trigger", () => {
    expect(isAutonomousTelemetry("spi-telemetry", "每秒通过SPI总线发送电机遥测轮询指令")).toBe(true)
    expect(isAutonomousTelemetry("secondary-telemetry", "每秒通过二级CAN总线发送一个从节点的遥测轮询控制序列")).toBe(true)
    expect(isAutonomousTelemetry("default", "每秒发送指令")).toBe(false)
  })
})

describe("manual steps do not enter keyword translation", () => {
  test("keeps source and expected results verbatim, with explicit non-executable status", () => {
    const sourceSteps = [step("检查SRAM中的引导参数。", "引导参数为默认值。"), step("检查初始化寄存器。", "寄存器与初值表一致。")]
    const result = translateStandardizedCaseToCombined({
      case_name: "引导加载", test_purpose: "验证引导参数", test_step: sourceSteps,
      test_environment: "软平台测试环境", initial_settings: "无", test_input: "无", constraints: "无", assess_criteria: "一致", cease_condition: "完成",
    }, new Map(), [], "软平台测试环境", undefined, true)
    expect(result.translate_status).toBe("not_applicable")
    expect(result.translatedSteps).toBe(0)
    expect(result.failedSteps).toBe(0)
    expect(result.skippedManualSteps).toBe(2)
    expect(result.steps.map((s) => s.step_desc)).toEqual(sourceSteps.map((s) => s.步骤描述))
    expect(result.steps.every((s) => !s.key_name && s.parameter.length === 0 && s.translation_exempt_reason === "manual_requirement")).toBe(true)
    expect(UnifiedTestStepArray.safeParse(result.steps).success).toBe(true)
    expect(extractTranslatedStepsFromUnified(result.steps)).toEqual([])
  })
})

describe("ordered upload valid stream and non-destructive validation", () => {
  test("distributed errors end with the correct final packet without same-packet recovery", () => {
    const steps = cycle()
    expect(validateFunctionalModelSteps("ordered-upload", steps)).toEqual([])
    const cases = [{ case_name: "249字节上行数据块CANA测试", test_step: steps }]
    expect(analyzeCaseStructure(cases, { functionalModel: "ordered-upload" }).violations).toEqual([])
    const repaired = repairCaseStructure(cases, { functionalModel: "ordered-upload" })
    expect(repaired.cases).toEqual(cases)
    expect(repaired.actions).toEqual([])
  })

  test("repeating first correct packet, wrong error packet, and trailing partial cycle fail", () => {
    for (const steps of [
      [send("第一包"), send("第一包", "仲裁场错误"), send("第一包"), send("第一包", "控制场错误"), send("第二包"), send("最后一包")],
      [send("第一包"), send("第二包", "仲裁场错误"), send("第二包"), send("最后一包")],
      [...cycle(), send("第一包")],
      [...cycle(), ...cycle()],
    ]) expect(validateFunctionalModelSteps("ordered-upload", steps).length).toBeGreaterThan(0)
  })

  test("error coverage remainder can finish with correct packets only; numbered extra middle packets are allowed", () => {
    expect(validateFunctionalModelSteps("ordered-upload", [send("第1包"), send("第1包", "长度字段错误"), send("第2包"), send("第3包"), send("最后一包")])).toEqual([])
  })
})

describe("functional interface model guards", () => {
  test("Spacewire requires independent write/write/interrupt triples", () => {
    expect(validateFunctionalModelSteps("spacewire", [step("第3秒，通过CANA总线发送正确的管控程序上注数据块")]).length).toBeGreaterThan(0)
    const correct = [step("第3秒，设置内存地址21142000H的数据为管控程序起始块"), step("第3.1秒，设置内存地址21142E00H的数据为2501H"), step("第3.2秒，触发外部中断2")]
    expect(validateFunctionalModelSteps("spacewire", correct)).toEqual([])
    expect(validateFunctionalModelSteps("spacewire", correct.slice(0, 2)).length).toBeGreaterThan(0)
  })

  test("autonomous SPI/secondary telemetry needs periodic readback, not an invented trigger", () => {
    expect(validateFunctionalModelSteps("spi-telemetry", [step("第3秒，通过CANA总线发送电机遥测数据")]).length).toBeGreaterThan(0)
    for (const [model, channel] of [["spi-telemetry", "SPI"], ["secondary-telemetry", "二级CAN"]] as const) {
      const steps = [step(`第3秒，通过${channel}总线发送站地址11H的电机遥测数据（全部字段正确）`), step(`第4秒，通过${channel}总线发送站地址11H的电机遥测数据（SUM错误，其余字段正确）`), step(`第5秒，通过${channel}总线发送站地址11H的电机遥测数据（全部字段正确）`)]
      const options = { functionalModel: model, autonomousTelemetry: true }
      expect(analyzeCaseStructure([{ case_name: "遥测采集", test_step: steps }], options).violations.some((v) => v.message.includes("回读"))).toBe(true)
      const read = step("第3秒，通过CANA总线以1秒为周期循环发送遥测帧1轮询控制序列", "软件返回遥测帧1，用于读取并验证结果。")
      expect(analyzeCaseStructure([{ case_name: "遥测采集", test_step: [read, ...steps] }], options).violations).toEqual([])
      expect(validateFunctionalModelSteps(model, [step("第3秒，通过CANA总线发送遥测帧1轮询控制序列"), ...steps]).some((e) => e.includes("回读"))).toBe(true)
      expect(validateFunctionalModelSteps(model, [...steps, read]).some((e) => e.includes("回读"))).toBe(true)
      // Multiple readback frames are not duplicate triggers, and readback does
      // not satisfy a real trigger requirement when polling is not autonomous.
      const read2 = step("第3.01秒，通过CANA总线以1秒为周期循环发送遥测帧2轮询控制序列")
      const complete = [read, read2, ...steps]
      expect(analyzeCaseStructure([{ case_name: "遥测采集", test_step: complete }], options).violations).toEqual([])
      expect(analyzeCaseStructure([{ case_name: "遥测采集", test_step: complete }], { ...options, autonomousTelemetry: false }).violations.some((v) => v.type === "missing_primary_trigger")).toBe(true)
      expect(validateFunctionalModelSteps(model, [read, read, ...steps]).some((e) => e.includes("重复"))).toBe(true)
      expect(validateFunctionalModelSteps(model, [read, step(`第4秒，通过${channel}总线发送站地址11H的正确遥测数据`, "更新2类遥测W170。")]).some((e) => e.includes("遥测帧2"))).toBe(true)
    }
  })

  test("FPGA uses memory before polls; camera broadcast belongs to expected result", () => {
    expect(validateFunctionalModelSteps("fpga-telemetry", [step("第3秒，通过CANA总线发送FPGA状态遥测数据")]).length).toBeGreaterThan(0)
    expect(validateFunctionalModelSteps("fpga-telemetry", [step("第3秒，设置内存地址21143004H的数据为0x78123456"), step("第4秒，通过CANA总线发送遥测帧1轮询控制序列")])).toEqual([])
    expect(validateFunctionalModelSteps("camera-auxiliary", [step("第3秒，通过二级CAN总线发送相机辅助数据广播")]).length).toBeGreaterThan(0)
    expect(validateFunctionalModelSteps("camera-auxiliary", [step("第3秒，通过CANA总线发送正确的图像数据特征标识设置指令", "软件每500ms通过二级CAN总线发送相机辅助数据广播，图像数据特征标识为1。")])).toEqual([])
  })
})
