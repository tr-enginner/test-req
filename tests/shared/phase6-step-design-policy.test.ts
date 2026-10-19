import { describe, expect, test } from "bun:test"
import { analyzePacketSequences, hasMultipleOperations, packetRole } from "../../src/shared/phase6-step-design-policy"
import { validateTestTypeCases } from "../../src/shared/phase6-test-type-policy"
import { buildRequirementStepPlan } from "../../src/shared/testcase-keywords"
import { analyzeCaseStructure, repairCaseStructure } from "../../src/shared/phase6-confirmation-translator"

const step = (步骤描述: string) => ({ 步骤描述, 预期结果: "软件按需求处理。" })
const packet = (n: number, error?: string, subject = "249字节上行数据块") => step(
  `第3秒，通过CANA总线发送${subject}第${n}包（${error ? `${error}错误，其余字段正确` : "完整多帧，全部字段正确"}）。`,
)
const timed = (steps: ReturnType<typeof step>[]) => steps.map((s, i) => ({ ...s, 步骤描述: s.步骤描述.replace(/^第3秒/, `第${3 + i}秒`) }))
const command = (name: string, valid: boolean, bus = "CANA") => step(`第3秒，通过${bus}总线发送${name}（${valid ? "全部字段正确" : "仲裁场错误，其余字段正确"}）。`)
const issues = (type: string, steps: ReturnType<typeof step>[], corpus = "") => validateTestTypeCases(type, [{ test_step: timed(steps) }], corpus)

describe("shared ordered packet state machine", () => {
  test("three-packet sequence distributes errors and completes with the correct final packet", () => {
    const steps = timed([packet(1), packet(1, "首帧A字段"), packet(2), packet(2, "中间帧B字段"), packet(3, "尾帧C字段"), packet(3, "尾帧SUM"), packet(3)])
    for (const type of ["功能测试", "接口测试", "数据处理测试", "强度测试"]) expect(issues(type, steps, "数据共3包。")).toEqual([])
    const cases = [{ case_name: "249字节上行数据块", test_step: steps }]
    expect(analyzeCaseStructure(cases).violations).toEqual([])
    const repaired = repairCaseStructure(cases)
    expect(repaired.cases).toEqual(cases)
    expect(repaired.actions).toEqual([])
  })

  test("two auxiliary packets use the same terminal-error rule, not the old four-step cycle", () => {
    const aux = (n: number, err?: string) => packet(n, err, "辅助数据包")
    expect(issues("功能测试", [aux(1), aux(1, "首帧A字段"), aux(2, "中间帧B字段"), aux(2, "尾帧SUM"), aux(2)])).toEqual([])
    expect(issues("功能测试", [aux(1), aux(1, "首帧A字段"), aux(2), aux(2, "尾帧SUM")]).length).toBeGreaterThan(0)
    const compact = [
      step("第3秒，通过CANA总线发送完整正确的辅助数据包1。"),
      step("第4秒，通过CANA总线发送辅助数据包1（首帧仲裁场错误，其余字段正确）。"),
      step("第5秒，通过CANA总线发送辅助数据包2（尾帧SUM错误，其余字段正确）。"),
      step("第6秒，通过CANA总线发送完整正确的辅助数据包2。"),
    ]
    expect(issues("接口测试", compact)).toEqual([])
  })

  test("exhausted errors permit a correct-only tail, and packet count is not frame count", () => {
    expect(issues("强度测试", [packet(1), packet(1, "首帧A字段"), packet(2), packet(3), packet(4)], "共4包，每包12帧。")).toEqual([])
    expect(issues("数据处理测试", [packet(1), packet(2)], "共2包，每包37帧。")).toEqual([])
    expect(packetRole("第3秒，发送星务时间广播（第2帧错误）。")).toBeNull()
    expect(issues("功能测试", [step("第3秒，发送正确的遥测包1。")])).toEqual([])
  })

  test("rejects missing, repeated, wrong-role, and post-completion errors in every affected type", () => {
    const invalid = [
      [packet(1), packet(1, "A字段"), packet(1), packet(2), packet(3)],
      [packet(1), packet(1, "A字段"), packet(3)],
      [packet(1), packet(2, "A字段"), packet(2), packet(3)],
      [packet(1), packet(1, "A字段"), packet(2), packet(3, "SUM")],
      [packet(1), packet(2), packet(3), packet(3, "SUM")],
      [packet(1), packet(2), packet(2, "SUM"), packet(3)],
      [packet(1)],
      [step("第3秒，通过CANA总线发送正确的249字节上行数据块。")],
    ]
    for (const type of ["功能测试", "接口测试", "数据处理测试", "强度测试"]) {
      for (const steps of invalid) expect(issues(type, steps, "数据共3包。").length).toBeGreaterThan(0)
    }
  })

  test("repeated rounds require explicit requirement evidence, and buses do not fill each other's gaps", () => {
    const oneRound = [packet(1), packet(1, "A字段"), packet(2)]
    expect(analyzePacketSequences([...oneRound, ...oneRound]).issues.length).toBeGreaterThan(0)
    expect(analyzePacketSequences([...oneRound, ...oneRound], { corpus: "共2包，重复运行测试。" }).issues).toEqual([])
    expect(analyzePacketSequences([packet(1), { ...packet(2), 步骤描述: packet(2).步骤描述.replace("CANA", "CANB") }], { packetCount: 2 }).issues.length).toBeGreaterThan(0)
  })

  test("a packet stream does not exempt unrelated commands, and repair leaves protocol errors intact", () => {
    const mixed = [{ case_name: "数据接收", test_step: timed([packet(1), packet(2), command("开关指令", true)]) }]
    expect(analyzeCaseStructure(mixed).violations.some(v => v.type === "mixed_instruction")).toBe(true)
    expect(repairCaseStructure(mixed).cases).toEqual(mixed)
    const incomplete = [{ case_name: "数据接收", test_step: timed([packet(1), packet(1, "A字段"), packet(1), packet(2)]) }]
    const repaired = repairCaseStructure(incomplete)
    expect(repaired.cases).toEqual(incomplete)
    expect(repaired.residual_structure_violations.length).toBeGreaterThan(0)
  })
})

describe("stress source steps", () => {
  test("rejects actual zero-time and combined periodic-command shapes", () => {
    const zero = validateTestTypeCases("强度测试", [{ test_step: [step("第0.0秒，初始化测试环境。")]}])
    expect(zero.some(i => i.message.includes("禁止0秒"))).toBe(true)
    for (const desc of [
      "第3秒，通过一级CAN总线以1s为周期发送遥测帧1~4轮询控制序列。",
      "第3秒，通过CANA总线发送辅助数据包1、辅助数据包2。",
      "第3秒，通过CANA总线发送内存读出指令和内存数据轮询指令。",
      "第3秒，通过CANA总线发送上行数据块（72字节或249字节，全部字段正确）。",
      "第3秒，发送开关指令，然后设置内存地址0x1000的数据为1。",
    ]) expect(hasMultipleOperations(desc)).toBe(true)
    expect(hasMultipleOperations("第3秒，通过CANA总线发送正确的二级总线设置指令。")).toBe(false)
    expect(hasMultipleOperations("第3秒，发送输入。")).toBe(false)
  })

  test("same-command adjacent legal/illegal pairs pass, unrelated and background inputs do not", () => {
    expect(issues("强度测试", [command("开关指令", true), command("开关指令", false), command("内存读出指令", true), command("内存读出指令", false)])).toEqual([])
    for (const steps of [
      [command("开关指令", true), command("内存读出指令", false)],
      [command("开关指令", true), command("开关指令", false, "CANB")],
      [command("开关指令", true), command("开关指令", false), command("开关指令", false), command("开关指令", true)],
      [step("第3秒，通过CANA总线以1秒为周期循环发送正确的开关指令。"), command("开关指令", false)],
    ]) expect(issues("强度测试", steps).length).toBeGreaterThan(0)
  })

  test("Spacewire write/write/interrupt delivery is not mistaken for ordinary command-send pairing", () => {
    expect(issues("强度测试", [
      step("第3秒，设置内存地址21142000H的数据为管控程序上注数据块（SUM错误，其余字段正确）。"),
      step("第3秒，设置内存地址21142E00H的数据为2501H。"),
      step("第3秒，触发外部中断2。"),
    ])).toEqual([])
  })
})

describe("actionable source text and boundary values", () => {
  test("boundary role stays out of the operation body and never replaces the actual value", () => {
    expect(issues("边界测试", [step("第3秒，发送数据，程序编号为0x8。")])).toEqual([])
    expect(issues("边界测试", [step("第3秒，发送数据，程序编号为0x8（下边界-1）。")])).toEqual([])
    expect(issues("边界测试", [step("第3秒，发送数据，程序编号为下边界-1值0x8。")]).length).toBeGreaterThan(0)
    expect(issues("边界测试", [step("第3秒，发送249字节数据，程序编号（下边界-1）。")]).length).toBeGreaterThan(0)
  })

  test("invented generic command and effects in action text are blocked, sourced names are allowed", () => {
    const invalid = issues("可靠性安全性测试", [step("第3秒，通过CANA总线发送配置指令，使SRAM刷新功能开启。")], "SRAM刷新开启时软件周期刷新SRAM。")
    expect(invalid).toHaveLength(2)
    expect(issues("可靠性安全性测试", [step("第3秒，通过CANA总线发送SRAM刷新指令（刷新开启）。")], "SRAM刷新指令支持刷新开启。")).toEqual([])
    expect(issues("可靠性安全性测试", [step("第3秒，发送配置指令。")], "协议明确名称为配置指令。")).toEqual([])
  })

  test("no input/output flow must not become a fabricated CAN send plan", () => {
    const plan = buildRequirementStepPlan({ handling: "SRAM刷新开启时周期刷新。", inputFlow: "无。", outputFlow: "无。", chapterContent: "可靠性需求", keywordMap: new Map() })
    expect(plan.step_plan).toEqual([])
    expect(plan.warnings[0]).toContain("不生成发送参考步骤")
    expect(plan.input_keywords).toEqual([])
  })
})
