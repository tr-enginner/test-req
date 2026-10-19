import { describe, expect, test } from "bun:test"
import { translateStandardizedCaseToCombined, type StepPlanHint } from "../../src/shared/phase6-confirmation-translator"
import { scoreKeywordCandidatesByAnchor, type KeywordMeta } from "../../src/shared/testcase-keywords"
import { extractSentPayload, translatedStepSemanticIssues } from "../../src/shared/testcase-step-semantics"

function keyword(name: string, description: string, comments: string[]): KeywordMeta {
  return {
    keywordName: name, description,
    argumentNames: comments.map((_, i) => i === 0 ? "${time}" : `\${para${i}}`),
    argumentComments: comments, sourceJson: "/fixture/UserKeyword.json", txtSnippet: "",
    searchText: [name, description, ...comments].join("\n"),
  }
}
const irq = keyword("触发外部中断", "第${time}秒，${para3}外部中断${para1}", ["执行时间", "参数1：中断号:0~4", "参数2：电平：HIGH:上升沿; LOW:下降沿", "参数3：循环时间，单位秒；[0:;其他:以${para3}为周期;]"])
const sends = ["CANA", "CANB", "二级CAN", "SPI"].map((channel) => keyword(
  `发送${channel}数据_数据文件`, `第\${time}秒，通过${channel}总线\${para3}发送\${para2}`,
  ["执行时间", "参数1：指令ID", "参数2：数据文件名称", "参数3：循环时间，单位秒；[0:;其他:以${para3}秒为周期;]"],
))
const map = new Map([irq, ...sends].map((k) => [k.keywordName, k]))
function translate(desc: string, overrides: Record<string, unknown> = {}, hints: StepPlanHint[] = [], keywords = map) {
  return translateStandardizedCaseToCombined({
    case_name: "回归", test_purpose: "验证步骤动作及语义", test_environment: "无", initial_settings: "无",
    test_input: "无", constraints: "无", assess_criteria: "一致", cease_condition: "完成",
    test_step: [{ 步骤描述: desc, 预期结果: "软件通过CANA发送数据，经二级CAN发送应答，并更新SPI遥测。", ...overrides }],
  }, keywords, hints, undefined, "外部中断2：下降沿触发")
}

describe("functional translation action and payload regressions", () => {
  test("explicit interrupt survives inject_input and misleading bus anchors/results", () => {
    const desc = "第3.2秒，触发外部中断2。"
    expect(scoreKeywordCandidatesByAnchor(desc, map, { operation_type: "inject_input", channel: "CANA" })[0]?.keywordName).toBe(irq.keywordName)
    for (const anchors of [{}, { operation_type: "inject_input" }, { operation_type: "inject_input", channel: "CANA" }]) {
      const result = translate(desc, anchors)
      expect(result.translate_status).toBe("success")
      expect(result.steps[0]!.key_name).toBe(irq.keywordName)
      expect(result.steps[0]!.parameter.find((p) => p.Name === "${para1}")?.Value).toBe(2)
      expect(result.steps[0]!.parameter.find((p) => p.Name === "${para3}")?.Value).toBe(0)
    }
  })

  test("misleading step plan cannot override explicit interrupt; missing keyword fails closed", () => {
    const hint = { keyword_name: sends[0]!.keywordName, argument_bindings: { "${time}": "3.2", "${para2}": "开关指令", "${para3}": "0" } }
    expect(translate("第3.2秒，触发外部中断2。", {}, [hint]).steps[0]!.key_name).toBe(irq.keywordName)
    const result = translate("第3.2秒，触发外部中断2。", { operation_type: "inject_input" }, [hint], new Map(sends.map((k) => [k.keywordName, k])))
    expect(result.translate_status).toBe("failure")
    expect(result.steps[0]!.key_name).toBe("")
  })

  test("observing software sends cannot become a test-system send", () => {
    const result = translate("第3.0秒，监测软件通过二级CAN总线向从节点发出的遥测轮询控制序列及轮询周期。", { operation_type: "inject_input", channel: "二级CAN" })
    expect(result.translate_status).toBe("failure")
    const desc = "第3.0秒，监测软件通过二级CAN总线向从节点发出的遥测轮询控制序列及轮询周期。"
    const observe = keyword("监测二级CAN轮询", "第${time}秒，监测软件通过二级CAN总线向从节点发出的遥测轮询控制序列及轮询周期", ["执行时间"])
    const unrelated = keyword("循环设置地址数据数据", "第${time}秒，设置地址数据", ["执行时间"])
    expect(translate(desc, {}, [], new Map([...map, [unrelated.keywordName, unrelated]])).translate_status).toBe("failure")
    expect(translate(desc, {}, [], new Map([...map, [observe.keywordName, observe]])).steps[0]!.key_name).toBe(observe.keywordName)
  })

  test("periodic primary readback retains its interval through semantic fallback", () => {
    const result = translate("第3.0秒，通过一级CANA总线以1秒为周期循环发送遥测帧3轮询控制序列。", { operation_type: "verify_telemetry" })
    expect(result.translate_status).toBe("success")
    expect(result.steps[0]!.parameter.find((p) => p.Name === "${para3}")?.Value).toBe(1)
    expect(result.steps[0]!.step_desc).toContain("以1秒为周期")
  })

  for (const channel of ["一级CANA", "CANB", "二级CAN", "SPI"]) {
    for (const payload of [
      "249字节上行数据块（第一包，首帧仲裁场错误，其余字段正确）",
      "正确的249字节上行数据块（最后一包，完整多帧、全部字段正确）",
      "站地址11H的遥测数据（中间帧INDEX错误（值为0，期望1），其余字段正确）",
      "遥测数据(尾帧SUM错误,其余字段正确)",
    ]) {
      test(`${channel} keeps packet, frame and fault qualifiers in both text and parameters: ${payload}`, () => {
        const result = translate(`第4.0秒，通过${channel}总线发送${payload}。`, { operation_type: "inject_input" })
        expect(result.translate_status).toBe("success")
        expect(result.steps[0]!.parameter.find((p) => p.Name === "${para2}")?.Value).toBe(payload)
        expect(result.steps[0]!.step_desc).toContain(payload)
      })
    }
  }

  test("a precomputed payload cannot erase actual fault qualifiers", () => {
    const payload = "249字节上行数据块（第二包，控制场错误，其余字段正确）"
    const result = translate(`第4.0秒，通过CANA总线发送${payload}。`, {}, [{ keyword_name: sends[0]!.keywordName, argument_bindings: { "${time}": "4", "${para2}": "249字节上行数据块", "${para3}": "0" } }])
    expect(result.steps[0]!.parameter.find((p) => p.Name === "${para2}")?.Value).toBe(payload)
  })

  test("balanced capture stops at the next action, but preserves quoted commas", () => {
    expect(extractSentPayload("第3秒，通过SPI总线发送“遥测数据（站地址错，其他正确）”，验证软件丢弃。"))
      .toBe("遥测数据（站地址错，其他正确）")
    expect(extractSentPayload('第3秒，通过SPI总线发送"a,b.txt"，验证软件处理。')).toBe("a,b.txt")
    expect(extractSentPayload("第3秒，通过CANA总线发送数据（第一包，错误。")).toBeUndefined()
  })

  test("review rejects legacy successful translations with wrong actions or truncated payload parameters", () => {
    expect(translatedStepSemanticIssues("第3.2秒，触发外部中断2。", { key_name: sends[0]!.keywordName, step_desc: "第3.2秒，通过CANA总线发送开关指令", parameter: [] })).toHaveLength(1)
    expect(translatedStepSemanticIssues("第3.2秒，触发外部中断2。", { key_name: "", step_desc: "第3.2秒，触发外部中断2。", parameter: [] })).toHaveLength(1)
    const source = "第3秒，通过SPI总线发送遥测数据（站地址错误，其余字段正确）。"
    expect(translatedStepSemanticIssues(source, { key_name: sends[3]!.keywordName, step_desc: "第3秒，通过SPI总线发送遥测数据（站地址错误", parameter: [{ Value: "遥测数据（站地址错误", Comments: "数据文件" }] })).toHaveLength(2)
    expect(translatedStepSemanticIssues(source, { key_name: sends[3]!.keywordName, step_desc: source, parameter: [{ Value: "遥测数据（站地址错误", Comments: "数据文件" }] })).toHaveLength(1)
  })
})
