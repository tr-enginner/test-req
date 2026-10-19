import { describe, expect, test } from "bun:test"
import { analyzePacketSequences, hasMultipleOperations, operationIdentity, packetRole, stepValidity } from "../../src/shared/phase6-step-design-policy"
import { validateTestTypeCases } from "../../src/shared/phase6-test-type-policy"

const step = (步骤描述: string) => ({ 步骤描述, 预期结果: "软件按需求处理。" })
const packet = (role: string, correct = true) => step(`第3秒，通过CANA总线发送249字节上行数据块${role}（${correct ? "完整正确" : "首帧仲裁场错误，其余字段正确"}）。`)

describe("stress semantics do not depend on one sentence spelling", () => {
  test("field-error modifiers do not create a new command or packet stream", () => {
    const correct = "第3秒，通过CANA总线发送正确的开关指令。"
    const invalid = "第4秒，通过CANA总线发送仲裁场错误的开关指令。"
    expect(operationIdentity(invalid)).toBe(operationIdentity(correct))
    expect(validateTestTypeCases("强度测试", [{ test_step: [step(correct), step(invalid)] }])).toEqual([])
    const steps = [
      packet("第1包"),
      step("第4秒，通过CANA总线发送249字节上行数据块第1包的首帧仲裁场错误，其余字段正确。"),
      packet("第2包"),
    ]
    expect(analyzePacketSequences(steps).issues).toEqual([])
    expect(analyzePacketSequences(steps.map(s => ({ ...s, 步骤描述: s.步骤描述.replace("第1包的首帧", "第1包-首帧") }))).issues).toEqual([])
    expect(operationIdentity("第3秒，通过CANA总线发送正确的内存读取指令。")).toBe("CANA:内存读取指令")
    expect(operationIdentity("第3秒，通过CANA总线发送正确的数据检查指令。")).toBe("CANA:数据检查指令")
  })

  test("parenthesized packet roles and ordinary numeric roles identify the same payload", () => {
    expect(analyzePacketSequences([
      step("第3秒，通过CANA总线发送正确的249字节上行数据块（第1包，全部字段正确）。"),
      step("第4秒，通过CANA总线发送249字节上行数据块第1包（首帧仲裁场错误，其余字段正确）。"),
      packet("第2包"),
    ]).issues).toEqual([])
  })

  test("observed telemetry packets are not outgoing ordered packet identities", () => {
    const desc = "第3秒，通过CANA总线发送正确的遥测帧2轮询控制序列，读取遥测包2。"
    expect(packetRole(desc)).toBeNull()
    expect(analyzePacketSequences([step(desc)]).issues).toEqual([])
    expect(packetRole("第3秒，通过CANA总线发送正确的遥测帧2轮询控制序列（用于读取遥测包2）。")).toBeNull()
  })

  test("the final numbered error and symbolic last correct packet refer to one packet", () => {
    expect(analyzePacketSequences([
      packet("第1包"), packet("第1包", false),
      packet("第2包"), packet("第2包", false),
      packet("第3包", false), packet("最后一包"),
    ]).issues).toEqual([])
    expect(analyzePacketSequences([
      packet("第1包"), packet("第1包", false), packet("第2包", false), packet("最后一包"),
    ]).issues).toEqual([])
    // A numeric correct packet before an unspecified last packet is not itself the last packet.
    expect(analyzePacketSequences([packet("第1包"), packet("第2包"), packet("最后一包")]).issues).toEqual([])
  })

  test("a periodic word in the payload name does not suppress sequence checking", () => {
    const steps = [packet("第1包"), packet("第1包", false), packet("第1包"), packet("第2包")]
      .map(s => ({ ...s, 步骤描述: s.步骤描述.replace("249字节上行数据块", "249字节上行数据块（周期刷新数据）") }))
    expect(analyzePacketSequences(steps).issues.length).toBeGreaterThan(0)
    expect(analyzePacketSequences([step("第3秒，通过CANA总线以1秒为周期发送完整正确的辅助数据包1。")]).issues).toEqual([])
  })

  test("counter descriptions and negated faults do not make correct input illegal", () => {
    expect(stepValidity("第3秒，通过CANA总线发送正确的开关指令（错误计数保持不变）。")).toBe("correct")
    expect(stepValidity("第3秒，通过CANA总线发送正确的开关指令（无错误）。")).toBe("correct")
    expect(stepValidity("第3秒，通过CANA总线发送开关指令（SUM错误，其余字段正确）。")).toBe("error")
  })

  test("setting a sent field is not a second command, but a separate memory write is", () => {
    expect(hasMultipleOperations("第3秒，通过CANA总线发送正确的遥测数据包，设置长度字段为249。")).toBe(false)
    expect(hasMultipleOperations("第3秒，通过CANA总线发送正确的遥测数据包，设置长度字段为249并发送开关指令。")).toBe(true)
    expect(hasMultipleOperations("第3秒，通过CANA总线发送正确的开关指令，然后设置内存地址0x1000的数据为1。")).toBe(true)
    expect(hasMultipleOperations("第3秒，通过CANA总线发送内存读出指令和内存数据轮询指令。")).toBe(true)
  })

  test("semantic normalization never excuses missing packets or errors after completion", () => {
    expect(analyzePacketSequences([packet("第1包"), packet("第3包")], { packetCount: 3 }).issues.length).toBeGreaterThan(0)
    expect(analyzePacketSequences([packet("第1包"), packet("第2包"), packet("第2包", false)]).issues.length).toBeGreaterThan(0)
    expect(analyzePacketSequences([packet("第1包"), packet("第1包", false), packet("第2包", false)]).issues.length).toBeGreaterThan(0)
  })
})
