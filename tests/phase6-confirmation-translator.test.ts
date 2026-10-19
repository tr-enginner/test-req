import { describe, expect, test } from "bun:test"
import {
  analyzeCaseAggregation,
  analyzeCaseStructure,
  extractLengthVariantBases,
  buildRegroupDirective,
  repairCaseStructure,
  stepPlanToHints,
  suppressContradictoryAggregation,
  translateStandardizedCaseToCombined,
} from "../src/shared/phase6-confirmation-translator"
import {
  applyCommentValueMapping,
  buildCommentMap,
  renderDocumentationTemplate,
} from "../src/shared/keyword-argument-binding"
import type { StandardizedCase } from "../src/shared/phase6-testcase-standardizer"
import type { KeywordMeta, StepPlan } from "../src/shared/testcase-keywords"

function keyword(overrides: Partial<KeywordMeta>): KeywordMeta {
  const meta: KeywordMeta = {
    keywordName: "发送CANA数据",
    description: "第${time}s，通过CAN总线${para3}发送${para2}",
    argumentNames: ["${time}", "${para3}", "${para2}", "${extra}"],
    argumentComments: [
      "执行时间",
      "参数3：循环时间，单位为秒，无参数3只发送当前一次，-1位停止发送。[-1:停止;0: ;其他:以${cycTime}秒为周期]；",
      "参数2：数据协议名称",
      "未引用参数",
    ],
    txtSnippet: "",
    sourceJson: "/tmp/Demo.json",
    searchText: "",
    ...overrides,
  }
  return {
    ...meta,
    searchText: [
      meta.keywordName,
      meta.description,
      meta.argumentNames.join(" "),
      meta.argumentComments.join(" "),
      meta.txtSnippet,
    ].join("\n"),
  }
}

describe("B1a step plan hints", () => {
  const keywordMap = new Map<string, KeywordMeta>([
    ["发送CANA数据", keyword({})],
    ["发送CANB数据", keyword({ keywordName: "发送CANB数据", description: "第${time}s，通过CANB总线${para3}发送${para2}" })],
  ])

  function standardizedCase(
    steps: Array<{ 步骤描述: string; 预期结果: string } & Record<string, unknown>>,
  ): StandardizedCase {
    return {
      case_name: "用例",
      test_purpose: "目的。",
      test_step: steps,
      test_environment: "无",
      initial_settings: "无",
      test_input: "无",
      constraints: "无",
      assess_criteria: "无",
      cease_condition: "无",
    }
  }

  test("applies the hint with precomputed bindings when the step has no anchors", () => {
    const result = translateStandardizedCaseToCombined(
      standardizedCase([{ 步骤描述: "第3s，通过CAN总线发送间接指令", 预期结果: "系统正确处理" }]),
      keywordMap,
      [{
        keyword_name: "发送CANA数据",
        argument_bindings: { "${time}": "3", "${para2}": "间接指令", "${para3}": "" },
        suggested_operation_type: "send_command",
        suggested_channel: "CANA",
      }],
    )

    expect(result.translate_status).toBe("success")
    expect(result.steps[0].key_name).toBe("发送CANA数据")
    expect(result.steps[0].parameter.find((p) => p.Name === "${time}")?.Value).toBe(3)
    expect(result.steps[0].step_desc).toContain("间接指令")
  })

  test("skips the hint when the step anchors contradict it and falls back to regular matching", () => {
    // Hint recommends CANB, but the step's own channel anchor says CANA:
    // the hint must be skipped, and anchor/global matching picks 发送CANA数据.
    const result = translateStandardizedCaseToCombined(
      standardizedCase([{
        步骤描述: "第3s，通过CAN总线发送间接指令",
        预期结果: "系统正确处理",
        operation_type: "send_command",
        channel: "CANA",
      }]),
      keywordMap,
      [{
        keyword_name: "发送CANB数据",
        argument_bindings: { "${time}": "3", "${para2}": "间接指令", "${para3}": "" },
        suggested_operation_type: "send_command",
        suggested_channel: "CANB",
      }],
    )

    expect(result.steps[0].key_name).toBe("发送CANA数据")
  })

  test("falls back to regular matching when the hinted keyword is missing from the library", () => {
    const result = translateStandardizedCaseToCombined(
      standardizedCase([{ 步骤描述: "第3s，通过CAN总线发送间接指令", 预期结果: "系统正确处理" }]),
      keywordMap,
      [{
        keyword_name: "不存在的关键字",
        argument_bindings: { "${time}": "3" },
        suggested_operation_type: "send_command",
      }],
    )

    expect(result.translate_status).toBe("success")
    expect(result.steps[0].key_name).toBe("发送CANA数据")
    expect(result.issues.some((issue) => issue.includes("不在组合关键字库中"))).toBe(true)
  })

  test("stepPlanToHints derives routing anchors and strips synthetic values", () => {
    const stepPlan: StepPlan[] = [
      {
        step_index: 1,
        purpose: "send_command",
        description: "通过CANA总线发送间接指令",
        keyword_name: "发送CANA数据",
        bus_channel: "CANA",
        // 计划的合成值(时序时间/占位字面量)不得进入提示——它们与 worker
        // 实际步骤文本错位,会直接渲染进最终套件(2026-08-20 事故)
        argument_bindings: { "${time}": "3", "${para1}": "{para1}", "${para3}": "" },
        resolved_step_desc: "第3秒,通过CANA总线发送间接指令",
      },
    ]

    const hints = stepPlanToHints(stepPlan)

    expect(hints).toHaveLength(1)
    expect(hints[0]).toEqual({
      keyword_name: "发送CANA数据",
      argument_bindings: {},
      suggested_operation_type: "send_command",
      suggested_channel: "CANA",
      suggested_temporal: undefined,
    })
  })
})

describe("semantic extraction fallback (A)", () => {
  function standardizedCase(
    steps: Array<{ 步骤描述: string; 预期结果: string } & Record<string, unknown>>,
  ): StandardizedCase {
    return {
      case_name: "用例",
      test_purpose: "目的。",
      test_step: steps,
      test_environment: "无",
      initial_settings: "无",
      test_input: "无",
      constraints: "无",
      assess_criteria: "无",
      cease_condition: "无",
    }
  }

  test("translates prose against an empty-Documentation keyword via argument-comment extraction", () => {
    // Real-world failure shape: the keyword exists but its Documentation is
    // empty, so template regex can never match — values must be extracted
    // from the prose by argument-comment semantics instead.
    const kw = keyword({
      keywordName: "设置32位地址数据",
      description: "",
      argumentNames: ["${time}", "${para1}", "${para2}"],
      argumentComments: [
        "执行时间",
        "参数1：起始地址，十六进制",
        "参数2：数据或文件，文件类型包括txt和bin，txt格式为每个字节空格隔开",
      ],
    })
    const map = new Map<string, KeywordMeta>([[kw.keywordName, kw]])

    const result = translateStandardizedCaseToCombined(
      standardizedCase([{
        步骤描述: "第1.0秒，通过CPU-FPGA接口设置32位地址数据，起始地址0x21143000，数据0x0000AAAA。",
        预期结果: "内存地址0x21143000的数据为0x0000AAAA。",
      }]),
      map,
      [],
    )

    expect(result.translate_status).toBe("success")
    expect(result.steps[0].key_name).toBe("设置32位地址数据")
    expect(result.steps[0].step_desc).toContain("起始地址0x21143000")
    expect(result.steps[0].step_desc).toContain("数据0x0000AAAA")
    expect(result.steps[0].parameter.find((p) => p.Name === "${time}")?.Value).toBe(1)
    expect(result.steps[0].parameter.find((p) => p.Name === "${para1}")?.Value).toBe("0x21143000")
    expect(result.steps[0].parameter.find((p) => p.Name === "${para2}")?.Value).toBe("0x0000AAAA")
  })

  test("falls back to semantic extraction when the template regex does not match the prose", () => {
    const kw = keyword({
      keywordName: "发送CANATXT数据",
      description: "第${time}秒,通过%$总线${para3}发送${para2}",
      argumentNames: ["${time}", "${para1}", "${para2}", "${para3}"],
      argumentComments: [
        "执行时间",
        "参数1：ID:0~255,一个ID对应一种类型指令。",
        "参数2：数据文件",
        "参数3：循环时间，单位秒，[0:只发送一次;其他:以该值为周期]",
      ],
    })
    const map = new Map<string, KeywordMeta>([[kw.keywordName, kw]])

    // Prose deliberately breaks the template shape (使用…通道下发 instead of
    // 通过…总线…发送) so the regex path fails and semantic extraction runs.
    const result = translateStandardizedCaseToCombined(
      standardizedCase([{
        步骤描述: "第3秒，使用CANA通道下发数据文件frame1.txt，指令ID为5。",
        预期结果: "软件正确接收数据。",
      }]),
      map,
      [],
    )

    expect(result.translate_status).toBe("success")
    const step = result.steps[0]
    expect(step.key_name).toBe("发送CANATXT数据")
    expect(step.step_desc).toContain("CANA")
    expect(step.step_desc).toContain("frame1.txt")
    const value = (name: string) => String(step.parameter.find((p) => p.Name === name)?.Value)
    expect(value("${time}")).toBe("3")
    expect(value("${para1}")).toBe("5")
    expect(value("${para2}")).toContain("frame1.txt")
    expect(value("${para3}")).toBe("0")
  })

  test("keeps the match with {name} placeholders when a patterned argument cannot be extracted (soft binding)", () => {
    const kw = keyword({
      keywordName: "设置32位地址数据",
      description: "",
      argumentNames: ["${time}", "${para1}", "${para2}"],
      argumentComments: ["执行时间", "参数1：起始地址，十六进制", "参数2：数据或文件"],
    })
    const map = new Map<string, KeywordMeta>([[kw.keywordName, kw]])

    const result = translateStandardizedCaseToCombined(
      standardizedCase([{ 步骤描述: "第1秒，设置32位地址数据。", 预期结果: "设置成功。" }]),
      map,
      [],
    )

    // 语义正确的关键字不得因个别参数未在步骤文本中出现而整条失败:
    // ${time} 已提取 → 匹配成功,未提取参数保留 {para1}/{para2} 占位,
    // 由后续数据生成阶段填充;提取缺口在 issues 中可见。
    expect(result.translate_status).toBe("success")
    expect(result.steps[0].key_name).toBe("设置32位地址数据")
    const value = (name: string) => String(result.steps[0].parameter.find((p) => p.Name === name)?.Value)
    expect(value("${time}")).toBe("1")
    expect(value("${para1}")).toBe("{para1}")
    expect(value("${para2}")).toBe("{para2}")
    expect(result.issues.some((issue) => issue.includes("未能从步骤文本中提取"))).toBe(true)
  })
})

describe("UserKeyWord 优先匹配（项目可变库优先，固定库不参与步骤匹配）", () => {
  const USER_JSON = "/proj/.matrix/data/DTPProject/组合关键字/UserKeyWord.json"
  const FIXED_JSON = "/proj/.matrix/data/DTPProject/组合关键字/VTest.json"

  function standardizedCase(
    steps: Array<{ 步骤描述: string; 预期结果: string }>,
  ): StandardizedCase {
    return {
      case_name: "用例",
      test_purpose: "目的。",
      test_step: steps,
      test_environment: "软平台测试环境",
      initial_settings: "无",
      test_input: "无",
      constraints: "无",
      assess_criteria: "无",
      cease_condition: "无",
    }
  }

  function sendKeyword(keywordName: string, sendPhrase: string): KeywordMeta {
    return keyword({
      keywordName,
      description: `第\${time}秒，设置${sendPhrase}\${para1}，对应数据文件\${para2},延时应答时间为\${para3}秒`,
      argumentNames: ["${time}", "${para1}", "${para2}", "${para3}"],
      argumentComments: [
        "执行时间",
        "参数1：ID:1~20,一个ID对应一种类型指令",
        "参数2：数据包名称",
        "参数3：延时应答时间，单位秒，默认为0",
      ],
      sourceJson: USER_JSON,
    })
  }

  // 镜像真实项目 UserKeyWord 库的干扰项 + 固定库(VTest)低层关键字
  const keywordMap = new Map<string, KeywordMeta>([
    ["发送二级CANTXT数据", sendKeyword("发送二级CANTXT数据", "发送二级CAN数据指令")],
    ["发送SPI接口数据", sendKeyword("发送SPI接口数据", "发送SPI接口数据")],
    ["发送CANATXT数据", sendKeyword("发送CANATXT数据", "发送CANA数据指令")],
    [
      "循环发送CANA指令",
      keyword({
        keywordName: "循环发送CANA指令",
        description: "通过%$总线以${para4}秒为周期${para5}发送${para1}.txt中从${para2}到${para3}的指令",
        argumentNames: ["${time}", "${para1}", "${para2}", "${para3}", "${para4}", "${para5}"],
        argumentComments: [
          "执行时间",
          "参数1：数据文件；",
          "参数2：开始索引，十进制；",
          "参数3：结束索引，十进制；",
          "参数4：单指令间循环时间；",
          "参数5：是否轮询(N/Y),[N:单次；Y：轮询]",
        ],
        sourceJson: USER_JSON,
      }),
    ],
    [
      "设置CANA寄存器值",
      keyword({
        keywordName: "设置CANA寄存器值",
        description: "第${time}秒，设置${para1}地址的CANA总线寄存器值为${para2}",
        argumentNames: ["${time}", "${para1}", "${para2}", "${para3}", "${para4}"],
        argumentComments: ["执行时间", "参数1：寄存器地址", "参数2：寄存器值", "参数3：保留", "参数4：保留"],
        sourceJson: USER_JSON,
      }),
    ],
    [
      "设置CANA总线帧间隔",
      keyword({
        keywordName: "设置CANA总线帧间隔",
        description: "第${time}秒，设置CANA总线发送帧间隔${para1}秒",
        argumentNames: ["${time}", "${para1}", "${para2}"],
        argumentComments: ["执行时间", "参数1：帧间隔", "参数2：保留"],
        sourceJson: USER_JSON,
      }),
    ],
    [
      "监视协议发送",
      keyword({
        keywordName: "监视协议发送",
        description: "第${time}秒，监视协议总线发送数据${para1}",
        argumentNames: ["${time}", "${para1}"],
        argumentComments: ["执行时间", "参数1：协议"],
        sourceJson: FIXED_JSON,
      }),
    ],
  ])

  test("二级CAN 发送步骤匹配『发送二级CANTXT数据』而非一级 CANA 关键字", () => {
    const result = translateStandardizedCaseToCombined(
      standardizedCase([{
        步骤描述: "第3.0秒，通过二级CAN总线A向站地址01H发送10字节遥控指令（40H 08H 20H 01H W2 W3 W4 W5 SUM），由FPGA寄存器接口设置发送控制。",
        预期结果: "系统接收到指令并正确应答。",
      }]),
      keywordMap,
      [],
    )

    expect(result.translate_status).toBe("success")
    expect(result.steps[0].key_name).toBe("发送二级CANTXT数据")
    const value = (name: string) => String(result.steps[0].parameter.find((p) => p.Name === name)?.Value)
    expect(value("${time}")).toBe("3")
    // ID 按用例内唯一分配，载荷保留实际协议字段，不能合成为丢信息的短标签。
    expect(value("${para1}")).toBe("1")
    expect(value("${para2}")).toBe("10字节遥控指令（40H 08H 20H 01H W2 W3 W4 W5 SUM）")
    expect(value("${para3}")).toBe("0")
  })

  test("SPI 发送步骤匹配『发送SPI接口数据』(SPI总线不再被误判为 CAN)", () => {
    const result = translateStandardizedCaseToCombined(
      standardizedCase([{
        步骤描述: "第3.0秒，连续3次通过SPI总线A向同一节点发送电机遥测轮询指令，每次均注入错误的电机遥测数据或不返回。",
        预期结果: "系统对错误数据正确校核。",
      }]),
      keywordMap,
      [],
    )

    expect(result.translate_status).toBe("success")
    expect(result.steps[0].key_name).toBe("发送SPI接口数据")
    expect(result.steps[0].step_desc).toContain("SPI")
    expect(result.steps[0].step_desc).not.toContain("CANA")
  })

  test("UserKeyWord 无条目时回退全库,固定库关键字仍可匹配", () => {
    const fixedOnly = new Map<string, KeywordMeta>(
      [...keywordMap.entries()].filter(([, meta]) => meta.sourceJson === FIXED_JSON),
    )
    const result = translateStandardizedCaseToCombined(
      standardizedCase([{
        步骤描述: "第3.0秒，通过CANA总线发送指令。",
        预期结果: "发送成功。",
      }]),
      fixedOnly,
      [],
    )
    expect(result.translate_status).toBe("success")
    expect(result.steps[0].key_name).toBe("监视协议发送")
  })

  test("同一用例的 CANA 文件发送步骤匹配稳定:数据名含『轮询』『内存』不翻转意图", () => {
    const result = translateStandardizedCaseToCombined(
      standardizedCase([
        { 步骤描述: "第3.0秒，通过CANA总线发送10字节遥控指令数据文件cmd10.txt。", 预期结果: "系统正确接收指令。" },
        { 步骤描述: "第5.0秒，通过CANA总线发送遥测帧1轮询控制序列数据文件tm1.txt。", 预期结果: "系统返回遥测数据。" },
        { 步骤描述: "第7.0秒，连续3次通过CANA总线发送内存读出指令数据文件mr.txt。", 预期结果: "系统返回内存数据。" },
      ]),
      keywordMap,
      [],
    )

    // 裸"轮询"只是数据名的一部分、内存/寄存器字样只是指令名的一部分:
    // 三条同为一次性文件发送,必须全部稳定匹配『发送CANATXT数据』
    expect(result.translate_status).toBe("success")
    expect(result.steps.map((s) => s.key_name)).toEqual([
      "发送CANATXT数据",
      "发送CANATXT数据",
      "发送CANATXT数据",
    ])
  })

  test("显式周期标记(以N秒为周期循环发送):零泄漏的『发送CANATXT数据』优先(2026-08-28 用户裁定)", () => {
    const result = translateStandardizedCaseToCombined(
      standardizedCase([{
        步骤描述: "第9.0秒，通过CANA总线以2秒为周期循环发送249字节上行数据块数据文件up249.txt。",
        预期结果: "系统持续接收数据块。",
      }]),
      keywordMap,
      [],
    )

    // 循环发送CANA指令 的 开始索引/结束索引/是否轮询 无法从步骤文本绑定(泄漏
    // {paraN} 占位);发送CANATXT数据 只需循环时间参数即可完整承载周期意图
    expect(result.translate_status).toBe("success")
    expect(result.steps[0].key_name).toBe("发送CANATXT数据")
    const leaks = (result.steps[0].parameter || []).filter(
      (p) => typeof p.Value === "string" && /^\{para\d*\}$/.test(p.Value),
    )
    expect(leaks).toHaveLength(0)
  })

  test("参数未提取时:ID 用例内分配、数据文件填『指令·情况』说明,step_desc 无占位", () => {
    // 用户拍板的替换语义(2026-08-19):步骤处理"什么指令的什么情况",该情况数据
    // 本就存放在一个数据文件中 → 数据文件参数只需说明指令+情况,不指定具体文件;
    // 指令ID 参数从范围内(ID:1~20)为用例内每个指令取一个,不重复。
    const result = translateStandardizedCaseToCombined(
      standardizedCase([{
        步骤描述: "第4.0秒，在被测件再次发送10字节遥控指令后，通过CANA总线返回全部字节正确的应答。",
        预期结果: "软件判定10字节遥控指令应答正确。",
      }]),
      keywordMap,
      [],
    )

    expect(result.translate_status).toBe("success")
    expect(result.steps[0].key_name).toBe("发送CANATXT数据")
    const value = (name: string) => String(result.steps[0].parameter.find((p) => p.Name === name)?.Value)
    expect(value("${time}")).toBe("4")
    expect(value("${para1}")).toBe("1")
    expect(value("${para2}")).toBe("10字节遥控指令·全部字节正确的应答")
    expect(value("${para3}")).toBe("0")
    // 全参数有值 → 模板完整渲染,step_desc 不残留 {para} 占位
    expect(result.steps[0].step_desc).not.toMatch(/\{para\d+\}/)
    expect(result.steps[0].step_desc).toContain("对应数据文件10字节遥控指令·全部字节正确的应答")
  })

  test("指令ID 用例内唯一分配:同指令复用、异指令递增、显式ID不冲突", () => {
    const result = translateStandardizedCaseToCombined(
      standardizedCase([
        // 显式给出指令ID为5 → 记为已用
        { 步骤描述: "第1.0秒，通过CANA总线下发间接指令，指令ID为5。", 预期结果: "系统接收指令。" },
        // 同一指令(10字节遥控指令)两个不同情况 → 复用同一 ID
        { 步骤描述: "第3.5秒,在被测件发送10字节遥控指令后，通过CANA总线返回仲裁场错误且其余字节正确的应答。", 预期结果: "软件判定应答错误。" },
        { 步骤描述: "第4.0秒,在被测件再次发送10字节遥控指令后，通过CANA总线返回全部字节正确的应答。", 预期结果: "软件判定应答正确。" },
      ]),
      keywordMap,
      [],
    )

    expect(result.translate_status).toBe("success")
    expect(result.steps.map((s) => s.key_name)).toEqual(["发送CANATXT数据", "发送CANATXT数据", "发送CANATXT数据"])
    const idOf = (index: number) => String(result.steps[index].parameter.find((p) => p.Name === "${para1}")?.Value)
    const labelOf = (index: number) => String(result.steps[index].parameter.find((p) => p.Name === "${para2}")?.Value)
    // 显式 ID 5 优先保留
    expect(idOf(0)).toBe("5")
    // 新指令从范围最小值 1 开始分配;同指令跨步骤复用同一 ID
    expect(idOf(1)).toBe("1")
    expect(idOf(2)).toBe("1")
    expect(labelOf(1)).toBe("10字节遥控指令·仲裁场错误且其余字节正确的应答")
    expect(labelOf(2)).toBe("10字节遥控指令·全部字节正确的应答")
  })

  test("需求步骤计划的脏绑定不得污染翻译:以实际步骤文本为准", () => {
    // 2026-08-20 事故:步骤计划从需求上下文合成参数值——${para2} 被绑成整段
    // 接口描述背景、另一处绑成"无"、${para1} 绑成字面 "{para1}"、${time} 绑成
    // 3.0/4.5 合成时序,经 B1a 提示路径直接渲染进最终套件。
    const hints = stepPlanToHints([
      {
        step_index: 1,
        purpose: "send_command",
        description: "通过CANA总线发送遥测帧1轮询控制序列",
        keyword_name: "发送CANATXT数据",
        bus_channel: "CANA",
        argument_bindings: {
          "${time}": "3",
          "${para1}": "{para1}",
          "${para2}": "IF-CAN0-001：相机管理控制器采用CAN总线与卫星进行总线通讯，采用双冗余总线结构，总线控制器采用Philips公司的总线协议芯片SJA1000T，接口芯片采用PCA82C250T,波特率500Kbit/s（16MHz晶振），标准PELICAN模式。A、B总线寄存器基址 21180000H、21181000H",
          "${para3}": "",
        },
        resolved_step_desc: "第3秒,通过%$总线发送IF-CAN0-001：相机管理控制器采用CAN总线与卫星进行总线通讯",
      },
      {
        step_index: 2,
        purpose: "verify_response",
        description: "验证软件接收到指令后正确处理",
        keyword_name: "发送CANATXT数据",
        bus_channel: "CANA",
        argument_bindings: {
          "${time}": "4.5",
          "${para1}": "{para1}",
          "${para2}": "无",
          "${para3}": "",
        },
        resolved_step_desc: "第4.5秒,通过%$总线发送无",
      },
    ])

    const result = translateStandardizedCaseToCombined(
      standardizedCase([
        { 步骤描述: "第0.5秒,通过CANA总线发送正确的遥测帧1轮询控制序列。", 预期结果: "遥测帧1被正常处理。" },
        { 步骤描述: "第1.0秒,通过CANA总线发送遥测帧1轮询控制序列（仲裁场错误,其余字段正确）。", 预期结果: "遥测帧1被丢弃。" },
      ]),
      keywordMap,
      hints,
    )

    expect(result.translate_status).toBe("success")
    const value = (index: number, name: string) =>
      String(result.steps[index].parameter.find((p) => p.Name === name)?.Value)
    // 时间来自实际步骤文本,而非计划的合成时序 3.0/4.5
    expect(value(0, "${time}")).toBe("0.5")
    expect(value(1, "${time}")).toBe("1")
    // para1 由用例内 ID 分配器取值,不再是 "{para1}" 字面占位
    expect(value(0, "${para1}")).toBe("1")
    // para2 是从实际步骤文本得到的说明,而非背景段落或"无"
    expect(value(0, "${para2}")).not.toContain("相机管理控制器")
    expect(value(1, "${para2}")).not.toBe("无")
    expect(value(1, "${para2}")).toContain("仲裁场错误")
  })

  test("模板正则路径也输出并分配模板未引用的指令ID参数", () => {
    // 真实库 发送CANATXT数据 的 Documentation 是 "第${time}秒,通过%$总线${para3}
    // 发送${para2}"——不含 ${para1},但 Arguments 声明了它且运行时调用需要:
    // 正则路径必须补发该参数并由用例内分配器取值。
    const canaTxt = keyword({
      keywordName: "发送CANATXT数据",
      description: "第${time}秒,通过CANA总线${para3}发送${para2}",
      argumentNames: ["${time}", "${para1}", "${para2}", "${para3}"],
      argumentComments: [
        "执行时间",
        "参数1：ID:0~255,一个ID对应一种类型指令。",
        "参数2：数据文件",
        "参数3：循环时间，单位秒，[0:只发送一次;其他:以该值为周期]",
      ],
    })
    const map = new Map<string, KeywordMeta>([["发送CANATXT数据", canaTxt]])

    const result = translateStandardizedCaseToCombined(
      standardizedCase([
        { 步骤描述: "第1.5秒,通过CANA总线发送遥测帧1轮询控制序列。", 预期结果: "遥测帧1被正常处理。" },
      ]),
      map,
      [],
    )

    expect(result.translate_status).toBe("success")
    const para1 = result.steps[0].parameter.find((p) => p.Name === "${para1}")
    expect(para1).toBeDefined()
    expect(String(para1?.Value)).toBe("0")
    // 模板占位参数照常:时间取自文本,循环时间取文档化默认 0
    const value = (name: string) => String(result.steps[0].parameter.find((p) => p.Name === name)?.Value)
    expect(value("${time}")).toBe("1.5")
    expect(value("${para3}")).toBe("0")
  })
})

describe("analyzeCaseAggregation(跨TR聚合度确定性检测)", () => {
  const TRS = ["TR-JK-001", "TR-JK-002", "TR-JK-003", "TR-JK-004"]

  function caseOf(
    name: string,
    covered: string[],
    steps: Array<{ 步骤描述: string; 预期结果: string }>,
  ) {
    return { case_name: name, covered_tr_items: covered, test_step: steps }
  }

  test("同一指令短语跨不同 TR 子集拆分 → 违规;全单TR覆盖 → 警告", () => {
    // 镜像 2026-08-20 真实缺陷形态:worker 对逐条 TR 枚举的"处理"字段
    // 按 TR 逐条拆分用例,"遥测帧1轮询"的错误情况被拆进覆盖 TR-JK-001 与
    // TR-JK-003 的两个用例——同一指令的不同情况必须聚合到一个用例。
    const analysis = analyzeCaseAggregation([
      caseOf("单帧遥测帧轮询ID错误丢弃测试", ["TR-JK-001"], [
        { 步骤描述: "第0.5秒,通过CANA总线发送正确的遥测帧1轮询控制序列。", 预期结果: "正常处理。" },
      ]),
      caseOf("单帧W0字段错误丢弃测试", ["TR-JK-003"], [
        { 步骤描述: "第1.0秒,通过CANA总线发送遥测帧1轮询控制序列（W0错误,其余字段正确）。", 预期结果: "丢弃。" },
      ]),
      caseOf("遥控指令多帧字段错误测试", ["TR-JK-004"], [
        { 步骤描述: "第0.5秒,通过CANA总线发送正确的10字节遥控指令。", 预期结果: "计数正确。" },
      ]),
    ], TRS)

    expect(analysis.violations).toHaveLength(1)
    expect(analysis.violations[0].instruction_phrase).toBe("遥测帧1轮询")
    expect(analysis.violations[0].case_names).toEqual([
      "单帧遥测帧轮询ID错误丢弃测试", "单帧W0字段错误丢弃测试",
    ])
    expect(analysis.violations[0].covered_tr_items).toEqual(["TR-JK-001", "TR-JK-003"])
    // 需求组 4 个 TR、全部用例单 TR 覆盖 → 聚合提示警告
    expect(analysis.warnings.some((w) => w.includes("只覆盖单一 TR"))).toBe(true)
  })

  test("同短语同 TR 覆盖、不同指令短语、以及聚合好的用例 → 无违规", () => {
    const analysis = analyzeCaseAggregation([
      // 同一指令两个情况在同一用例、覆盖多个 TR —— 期望形态
      caseOf("遥测帧轮询各字段错误测试", ["TR-JK-001", "TR-JK-003"], [
        { 步骤描述: "第0.5秒,通过CANA总线发送遥测帧1轮询控制序列（仲裁场错误）。", 预期结果: "丢弃。" },
        { 步骤描述: "第1.0秒,通过CANA总线发送遥测帧1轮询控制序列（W0错误）。", 预期结果: "丢弃。" },
      ]),
      // 同短语但 covered 完全一致 —— 同一 TR 内的拆分不在跨 TR 聚合规则范围
      caseOf("TITLE错误", ["TR-JK-002"], [
        { 步骤描述: "第0.5秒,通过CANA总线发送遥测帧3轮询控制序列（TITLE错误）。", 预期结果: "计数加1。" },
      ]),
      caseOf("SUM错误", ["TR-JK-002"], [
        { 步骤描述: "第1.0秒,通过CANA总线发送遥测帧3轮询控制序列（SUM错误）。", 预期结果: "计数加1。" },
      ]),
      // 不同指令类型 —— 合法的独立用例
      caseOf("上行数据块字段错误测试", ["TR-JK-004"], [
        { 步骤描述: "第0.5秒,通过CANA总线发送249字节上行数据块（LENGTH错误）。", 预期结果: "计数加1。" },
      ]),
    ], TRS)

    expect(analysis.violations).toHaveLength(0)
    expect(analysis.warnings).toHaveLength(0)
  })
})

describe("analyzeCaseStructure(双总线分开/错误-正确配对 确定性检测)", () => {
  function caseOf(name: string, purpose: string, steps: Array<[string, string]>) {
    return {
      case_name: name,
      test_purpose: purpose,
      test_step: steps.map(([步骤描述, 预期结果]) => ({ 步骤描述, 预期结果 })),
    }
  }

  test("同一指令经 CANA 与 CANB 发送于同一用例 → mixed_bus 违规;切换类用例豁免", () => {
    const analysis = analyzeCaseStructure([
      // 2026-08-20 晚真实缺陷形态:字段错误校核用例混入双总线
      caseOf("遥测帧1轮询控制序列CAN总线字段错误校核测试", "验证双通道字段错误处理。", [
        ["第3.0秒,通过CANA总线发送正确的遥测帧1轮询控制序列。", "正常处理。"],
        ["第4.0秒,通过CANB总线发送遥测帧1轮询控制序列（仲裁场错误,其余字段正确）。", "丢弃。"],
      ]),
      // 总线切换行为测试:混用是测试目的,豁免
      caseOf("二级CAN总线遥测轮询及自动切换测试", "验证总线自动切换。", [
        ["第3.0秒,通过CANA总线发送二级CAN轮询指令。", "正常应答。"],
        ["第6.0秒,通过CANB总线发送二级CAN轮询指令。", "切换后正常应答。"],
      ]),
    ])
    const mixed = analysis.violations.filter((v) => v.type === "mixed_bus")
    expect(mixed).toHaveLength(1)
    expect(mixed[0].case_name).toContain("字段错误校核")
    expect(mixed[0].message).toContain("遥测帧1轮询")
  })

  test("字段错误步骤后未紧跟全部正确步骤 → missing_correct_after_error;交替组织通过;连续场景豁免", () => {
    const analysis = analyzeCaseStructure([
      caseOf("字段错误配对测试", "验证交替组织。", [
        // 错误后紧跟正确 ✓
        ["第3.0秒,通过CANA总线发送遥测帧1轮询控制序列（仲裁场错误,其余字段正确）。", "丢弃。"],
        ["第4.0秒,通过CANA总线发送正确的遥测帧1轮询控制序列。", "正常处理。"],
        // 错误后紧跟另一个错误 ✗(真实缺口形态)
        ["第5.0秒,通过CANA总线发送遥测帧1轮询控制序列（控制场错误,其余字段正确）。", "丢弃。"],
        ["第6.0秒,通过CANA总线发送遥测帧1轮询控制序列（TITLE错误,其余字段正确）。", "丢弃。"],
        // 连续N次容错场景:豁免
        ["第7.0秒,连续3次通过CANA总线发送错误的遥测帧1轮询控制序列。", "持续丢弃。"],
        // 错误后跟的是异总线正确步骤 ✗
        ["第8.0秒,通过CANA总线发送遥测帧1轮询控制序列（SUM错误,其余字段正确）。", "丢弃。"],
        ["第9.0秒,通过CANB总线发送正确的遥测帧1轮询控制序列。", "正常处理。"],
      ]),
    ])
    const missing = analysis.violations.filter((v) => v.type === "missing_correct_after_error")
    expect(missing).toHaveLength(3)
    expect(missing.map((v) => v.message).join("\n")).toContain("控制场错误")
    expect(missing.map((v) => v.message).join("\n")).toContain("TITLE错误")
    expect(missing.map((v) => v.message).join("\n")).toContain("SUM错误")
  })

  test("SPI 输入 + CANA/CANB 遥测输出校验不误报;完整交替用例零违规", () => {
    const analysis = analyzeCaseStructure([
      // SPI 二级模拟应答(2026-08-28 同构:须有一级循环触发,步骤标站地址)
      // + CANA/CANB 验证(非发送动词)不构成混用
      caseOf("SPI遥测轮询错误校核测试", "验证SPI轮询。", [
        ["第3.0秒,通过CANA总线以1秒为周期循环发送遥测轮询控制序列。", "软件接收并经SPI总线向单板转发。"],
        ["第3.1秒,通过SPI总线发送站地址5CH的电机遥测数据（站地址错误）。", "计数加1。"],
        ["第4.1秒,通过SPI总线发送站地址5CH的正确的电机遥测数据。", "遥测更新。"],
        ["第5.0秒,验证遥测帧2通过CANA总线输出的轮询数据。", "数据正确。"],
        ["第6.0秒,验证遥测帧2通过CANB总线输出的轮询数据。", "数据正确。"],
      ]),
      // 每个错误都紧跟正确 ✓
      caseOf("内存读出指令字段错误测试", "验证交替。", [
        ["第3.0秒,通过CANA总线发送内存读出指令（LENGTH错误,其余字段正确）。", "丢弃。"],
        ["第4.0秒,通过CANA总线发送正确的内存读出指令。", "正常。"],
      ]),
    ])
    expect(analysis.violations).toHaveLength(0)
  })
})

describe("mixed_instruction 检测与确定性修复(2026-08-21 拍板:确定性兜底)", () => {
  function rcase(name: string, covered: string[], steps: Array<Record<string, unknown>>) {
    return { case_name: name, covered_tr_items: covered, test_purpose: `验证${name}。`, test_step: steps }
  }

  test("一个用例混入多条指令 → mixed_instruction 违规;应答短语不算第二条指令", () => {
    const analysis = analyzeCaseStructure([
      {
        case_name: "CANA轮询指令组合测试",
        test_purpose: "验证轮询与内存读出。",
        test_step: [
          { 步骤描述: "第3.0秒,通过CANA总线发送正确的遥测帧1轮询控制序列。", 预期结果: "正常。" },
          { 步骤描述: "第4.0秒,通过CANA总线发送正确的内存读出指令。", 预期结果: "正常。" },
          // 应答方向:机构控制指令是被测指令的应答内容,不是第二条被测指令
          { 步骤描述: "第5.0秒,SPI总线返回机构控制指令应答（站地址错误）。", 预期结果: "拒签。" },
        ],
      },
    ])
    const mixed = analysis.violations.filter((v) => v.type === "mixed_instruction")
    expect(mixed).toHaveLength(1)
    expect(mixed[0].phrases).toEqual(["遥测帧1轮询", "内存读出指令"])
  })

  test("短语抽取剥离情况修饰前缀:错误步骤与正确步骤提取同一指令短语", () => {
    const analysis = analyzeCaseStructure([
      {
        case_name: "帧序号错误测试",
        test_purpose: "验证帧序号校验。",
        test_step: [
          { 步骤描述: "第3.0秒,通过CANA总线发送正确的10字节遥控指令。", 预期结果: "正常。" },
          // "首帧帧序号错误的10字节遥控指令"的指令身份是"10字节遥控指令"
          { 步骤描述: "第3.5秒,通过CANA总线发送首帧帧序号错误的10字节遥控指令(帧序号01H)。", 预期结果: "丢弃。" },
        ],
      },
    ])
    // 错误步骤紧跟的下一步不是同指令"全部正确" → 应检出 missing_correct
    // (此前"帧序号错误的10字节遥控指令"≠"10字节遥控指令"会漏检配对)
    expect(analysis.violations.some((v) => v.type === "missing_correct_after_error")).toBe(true)
    expect(analysis.violations.filter((v) => v.type === "mixed_instruction")).toHaveLength(0)
  })

  test("确定性修复:跨TR拆分同总线用例合并、多指令用例拆分、缺配对自动补齐、时间单调", () => {
    const cases = [
      rcase("CANA遥测轮询ID错误测试", ["TR-JK-001"], [
        { 步骤描述: "第1.0秒,通过CANA总线发送正确的遥测帧1轮询控制序列。", 预期结果: "正常处理。" },
        { 步骤描述: "第1.5秒,通过CANA总线发送遥测帧1轮询控制序列（仲裁场错误）。", 预期结果: "丢弃。" },
      ]),
      rcase("CANA遥测轮询W0错误测试", ["TR-JK-003"], [
        { 步骤描述: "第1.0秒,通过CANA总线发送遥测帧1轮询控制序列（W0错误）。", 预期结果: "丢弃。" },
      ]),
      rcase("混合多指令测试", ["TR-JK-004"], [
        { 步骤描述: "第1.0秒,通过CANA总线发送正确的10字节遥控指令。", 预期结果: "正常。" },
        { 步骤描述: "第1.5秒,通过CANA总线发送正确的内存读出指令。", 预期结果: "正常。" },
      ]),
    ]
    const repair = repairCaseStructure(cases)
    // 前两个用例合并为 CANA遥测帧1轮询测试(covered 并集);第三个拆为两个单指令用例
    const names = repair.cases.map((c) => c.case_name)
    expect(names).toContain("CANA遥测帧1轮询测试")
    expect(names).toContain("CANA10字节遥控指令测试")
    expect(names).toContain("CANA内存读出指令测试")
    const merged = repair.cases.find((c) => c.case_name === "CANA遥测帧1轮询测试")!
    expect(merged.covered_tr_items).toEqual(["TR-JK-001", "TR-JK-003"])
    // 初始化步骤(第一条)保留在合并用例中;错误步骤后自动补"全部正确"
    expect(String(merged.test_step[0].步骤描述)).toContain("正确的遥测帧1轮询控制序列")
    const errorIndex = merged.test_step.findIndex((s) => String(s.步骤描述).includes("仲裁场错误"))
    const afterError = merged.test_step[errorIndex + 1]
    expect(String(afterError.步骤描述)).toContain("正确")
    expect(String(afterError.步骤描述)).not.toContain("错误")
    // 残留违规为 0(修复后重检)
    expect(repair.residual_structure_violations).toHaveLength(0)
    expect(repair.residual_aggregation_violations).toHaveLength(0)
    // 修复动作可读
    expect(repair.actions.some((a) => a.includes("已重组") && a.includes("CANA遥测帧1轮询测试"))).toBe(true)
  })

  test("总线感知聚合:同指令 CANA/CANB 各一个用例不算拆分违规;覆盖不对称 → 警告", () => {
    const analysis = analyzeCaseAggregation([
      rcase("CANA10字节遥控指令测试", ["TR-JK-001"], [
        { 步骤描述: "第1.0秒,通过CANA总线发送正确的10字节遥控指令。", 预期结果: "正常。" },
      ]),
      rcase("CANB10字节遥控指令测试", ["TR-JK-004"], [
        { 步骤描述: "第1.0秒,通过CANB总线发送正确的10字节遥控指令。", 预期结果: "正常。" },
      ]),
    ], ["TR-JK-001", "TR-JK-004"])
    expect(analysis.violations).toHaveLength(0)
    expect(analysis.warnings.some((w) => w.includes("覆盖不一致") || w.includes("不对称"))).toBe(true)
  })

  test("buildRegroupDirective 产出可嵌入重派 prompt 的划分表", () => {
    const aggregation = analyzeCaseAggregation([
      rcase("A用例", ["TR-JK-001"], [
        { 步骤描述: "第1.0秒,通过CANA总线发送正确的遥测帧1轮询控制序列。", 预期结果: "正常。" },
      ]),
      rcase("B用例", ["TR-JK-002"], [
        { 步骤描述: "第1.5秒,通过CANA总线发送遥测帧1轮询控制序列（W0错误）。", 预期结果: "丢弃。" },
      ]),
    ], ["TR-JK-001", "TR-JK-002"])
    const structure = analyzeCaseStructure([
      rcase("A用例", ["TR-JK-001"], [
        { 步骤描述: "第1.0秒,通过CANA总线发送正确的遥测帧1轮询控制序列。", 预期结果: "正常。" },
        { 步骤描述: "第1.5秒,通过CANA总线发送遥测帧1轮询控制序列（W0错误）。", 预期结果: "丢弃。" },
      ]),
    ])
    const lines = buildRegroupDirective(aggregation, structure)
    expect(lines.some((l) => l.includes("遥测帧1轮询") && l.includes("TR-JK-001、TR-JK-002"))).toBe(true)
    expect(lines.some((l) => l.includes("全部正确"))).toBe(true)
  })
})

describe("Comments 值映射渲染(step_desc 参数值语义,2026-08-21 用户拍板)", () => {
  const meta = {
    keywordName: "发送CANATXT数据",
    description: "第${time}秒,通过%$总线${para3}发送${para2}",
    argumentNames: ["${time}", "${para1}", "${para2}", "${para3}"],
    argumentComments: [
      "执行时间",
      "参数1：ID:0~255,一个ID对应一种类型指令。",
      "参数2：数据文件",
      "参数3：循环时间，单位秒，；[0:;其他:以${para3}S为周期;]",
    ],
    txtSnippet: "",
  }

  test("循环时间 0 → 占位处渲染为空(不再产出'通过CANA总线0发送')", () => {
    const rendered = renderDocumentationTemplate(
      meta.description,
      { "${time}": "3.0", "${para2}": "正确的遥测帧1轮询控制序列", "${para3}": "0", "%$": "CANA" },
      buildCommentMap(meta),
    )
    expect(rendered.text).toBe("第3.0秒,通过%$总线发送正确的遥测帧1轮询控制序列")
    expect(rendered.text).not.toContain("总线0")
  })

  test("循环时间非 0 → 渲染'以NS为周期';数值等价(0/0.0)命中同一映射键", () => {
    const rendered = renderDocumentationTemplate(
      meta.description,
      { "${time}": "3.0", "${para2}": "数据", "${para3}": "5", "%$": "CANA" },
      buildCommentMap(meta),
    )
    expect(rendered.text).toContain("通过%$总线以5S为周期发送数据")
    expect(applyCommentValueMapping("0.0", meta.argumentComments[3], { "${para3}": "0.0" })).toBe("")
    expect(applyCommentValueMapping("5", meta.argumentComments[3], { "${para3}": "5" })).toBe("以5S为周期")
  })

  test("无映射规格的参数照常平铺代值", () => {
    expect(applyCommentValueMapping("3.0", "执行时间", {})).toBe("3.0")
    expect(applyCommentValueMapping("7", "参数1：ID:0~255,一个ID对应一种类型指令。", {})).toBe("7")
  })
})

describe("无 Documentation 关键字的参数取值(地址/数据/掩码,2026-08-21 用户反馈)", () => {
  function standardizedCase(
    steps: Array<{ 步骤描述: string; 预期结果: string } & Record<string, unknown>>,
  ): StandardizedCase {
    return {
      case_name: "用例",
      test_purpose: "目的。",
      test_step: steps,
      test_environment: "无",
      initial_settings: "无",
      test_input: "无",
      constraints: "无",
      assess_criteria: "无",
      cease_condition: "无",
    }
  }

  const bitSetKeyword = (name: string) => keyword({
    keywordName: name,
    description: "",
    argumentNames: ["${time}", "${para1}", "${para2}", "${para3}"],
    argumentComments: [
      "执行时间",
      "参数1：地址，0x表示十六进制，否则为十进制",
      "参数2：数据，0x表示十六进制，否则为十进制",
      "参数3：掩码，0x表示十六进制，否则为十进制",
    ],
  })

  test("用户实例:向地址21143000H写入AAAAH → 地址/数据 H后缀归一化,掩码默认全1", () => {
    const kw = bitSetKeyword("设置32位地址bit数据")
    const result = translateStandardizedCaseToCombined(
      standardizedCase([{
        步骤描述: "第3.0秒，CPU软件通过FPGA接口向地址21143000H写入AAAAH。",
        预期结果: "地址0x21143000的数据为0x0000AAAA。",
      }]),
      new Map([[kw.keywordName, kw]]),
      // 真实管线形态:步骤计划 hint 纯路由(空绑定)选中关键字,值由语义提取
      [{ keyword_name: kw.keywordName, argument_bindings: {} }],
    )
    const parameter = result.steps[0].parameter
    // 地址 21143000H → 0x21143000(曾被存为十进制 21143000,被执行器误读)
    expect(parameter.find((p) => p.Name === "${para1}")?.Value).toBe("0x21143000")
    // 无标签数据 "写入AAAAH" → 0xAAAA(曾落成 "{para2}" 无意义占位)
    expect(parameter.find((p) => p.Name === "${para2}")?.Value).toBe("0xAAAA")
    // 掩码未在步骤中声明 → 32 位全 1(位写操作默认全部位生效)
    expect(parameter.find((p) => p.Name === "${para3}")?.Value).toBe("0xFFFFFFFF")
    // step_desc 保持自然语言原文
    expect(String(result.steps[0].step_desc)).toContain("向地址21143000H写入AAAAH")
  })

  test("显式掩码可抽取;16位关键字默认 0xFFFF;写入N次不误捕为数据", () => {
    const kw = bitSetKeyword("设置16位地址bit数据")
    const result = translateStandardizedCaseToCombined(
      standardizedCase([{
        步骤描述: "第1.0秒，向地址8000H写入3CH，掩码0x0F。",
        预期结果: "低4位被写入。",
      }]),
      new Map([[kw.keywordName, kw]]),
      [{ keyword_name: kw.keywordName, argument_bindings: {} }],
    )
    const parameter = result.steps[0].parameter
    expect(parameter.find((p) => p.Name === "${para1}")?.Value).toBe("0x8000")
    expect(parameter.find((p) => p.Name === "${para2}")?.Value).toBe("0x3C")
    expect(parameter.find((p) => p.Name === "${para3}")?.Value).toBe("0x0F")

    // "写入10次"的量词不得被当作数据值
    const kw2 = bitSetKeyword("设置32位地址bit数据")
    const result2 = translateStandardizedCaseToCombined(
      standardizedCase([{
        步骤描述: "第1.0秒，向地址90000H写入10次。",
        预期结果: "写入完成。",
      }]),
      new Map([[kw2.keywordName, kw2]]),
      [{ keyword_name: kw2.keywordName, argument_bindings: {} }],
    )
    const para2 = result2.steps[0].parameter.find((p) => p.Name === "${para2}")?.Value
    expect(String(para2)).not.toContain("10")
  })
})

describe("二级总线(软件↔下位机)测试模型(2026-08-25 用户拍板)", () => {
  const trigger = (t: number) => ({ 步骤描述: `第${t}秒，通过CANA总线发送遥控指令。`, 预期结果: "软件接收并通过二级CAN总线转发。" })
  // 2026-08-26 站地址铁律:二级步骤统一标注选定从节点的站地址
  const correctResp = (t: number) => ({ 步骤描述: `第${t}秒，通过二级CAN总线发送站地址01H的正确的遥控指令应答。`, 预期结果: "软件接收并更新一级CANA相应遥测。" })
  const errorResp = (t: number, field: string, n: number) => ({
    步骤描述: `第${t}秒，通过二级CAN总线发送站地址01H的遥控指令应答-${field}错误。`,
    预期结果: `遥测帧3参数TMYN395为${n}，TMYN396为${n}，TMYN397为${n}，TMYN398为站地址01H。`,
  })
  // 用户示例节奏:基线(触发+正确) → 每类错误[触发+错误应答+触发+正确应答]
  const canonicalCase = {
    case_name: "二级CAN遥控指令应答处理测试",
    test_purpose: "验证二级CAN应答错误计数与遥测更新。",
    test_step: [
      trigger(1.0), correctResp(1.5),
      trigger(2.0), errorResp(2.5, "仲裁场", 1), trigger(3.0), correctResp(3.5),
      trigger(4.0), errorResp(4.5, "控制场", 2), trigger(5.0), correctResp(5.5),
    ],
  }

  test("用户示例节奏(触发→错误应答→触发→正确应答)不再被判配对违规", () => {
    const analysis = analyzeCaseStructure([canonicalCase])
    expect(analysis.violations).toHaveLength(0)
  })

  test("二级错误应答后缺恢复单元仍判违规;修复插入[一级重发+二级正确应答]两步", () => {
    const broken = {
      ...canonicalCase,
      // 去掉最后的恢复(触发+正确应答),错误应答成为末步
      test_step: canonicalCase.test_step.slice(0, 8),
    }
    const analysis = analyzeCaseStructure([broken])
    expect(analysis.violations.filter((v) => v.type === "missing_correct_after_error")).toHaveLength(1)

    const repair = repairCaseStructure([broken])
    expect(repair.actions.some((a) => a.includes("已补配对(二级总线)") && a.includes("恢复单元"))).toBe(true)
    expect(repair.residual_structure_violations).toHaveLength(0)
    const steps = repair.cases[0]!.test_step.map((s) => String((s as any).步骤描述 ?? (s as any).step_desc))
    // 末尾两步为插入的恢复单元:一级重发载荷从二级载荷反推("遥控指令"),
    // 正确应答从错误步骤派生(载荷逐字保留,错误情形改为全部正确)
    expect(steps[steps.length - 2]).toContain("通过CANA总线发送遥控指令")
    expect(steps[steps.length - 2]).not.toContain("二级")
    expect(steps[steps.length - 1]).toContain("遥控指令应答")
    expect(steps[steps.length - 1]).not.toContain("错误")
  })

  test("一级总线标准配对规则不受影响(错误后紧跟同总线正确步骤仍必须)", () => {
    const primaryOnly = {
      case_name: "一级CAN字段错误测试",
      test_purpose: "验证一级总线字段校验。",
      test_step: [
        { 步骤描述: "第1.0秒，通过CANA总线发送正确的遥测帧1轮询控制序列。", 预期结果: "正常处理。" },
        { 步骤描述: "第1.5秒，通过CANA总线发送遥测帧1轮询控制序列（仲裁场错误，其余字段正确）。", 预期结果: "丢弃。" },
      ],
    }
    expect(analyzeCaseStructure([primaryOnly]).violations.some((v) => v.type === "missing_correct_after_error")).toBe(true)
  })
})

describe("2026-08-26 两类误报回归(步骤均取自当日真实运行,逐字保留触发措辞)", () => {
  // 事故A:预期结果里的计数器管理文本("管理上行数据包正确指令计数")含"指令"
  // 字样,曾被提取为幽灵指令短语 → mixed_instruction + 配对误判 → 修复器按
  // 幽灵短语把好用的 W0 用例拆散重组("CANA管理上行数据包正确指令测试")
  test("W0错误用例:预期含'管理…指令计数'计数器文本不得产生幽灵指令短语", () => {
    const w0Case = {
      case_name: "CANA总线249字节上行数据块W0错误测试",
      covered_tr_items: ["TR-JK-008"],
      test_step: [
        {
          步骤描述: "第3.0秒，通过CANA总线发送正确的249字节上行数据块（共12帧，首帧W0即功能ID正确）。",
          预期结果: "软件正确接收并解析249字节上行数据块，管理上行数据包正确指令计数（遥测帧1参数TMYN002）为1，TMYN003计数保持初值。",
        },
        {
          步骤描述: "第4.0秒，通过CANA总线发送249字节上行数据块（首帧W0即功能ID错误，其余字段正确）。",
          预期结果: "管理错误指令与上行数据包计数（遥测帧1参数TMYN003）为1。",
        },
        {
          步骤描述: "第5.0秒，通过CANA总线发送正确的249字节上行数据块（共12帧，首帧W0即功能ID正确）。",
          预期结果: "软件正确接收并解析249字节上行数据块，管理上行数据包正确指令计数（遥测帧1参数TMYN002）为2，TMYN003计数保持为1。",
        },
      ],
    }
    const analysis = analyzeCaseStructure([w0Case])
    expect(analysis.violations).toHaveLength(0)
  })

  // 事故B:一级触发写类别名"间接指令"、二级应答用具体名"遥控指令"——名称
  // 漂移曾让 mixed_instruction 把合并用例判为多指令、配对判定失败,修复器按
  // 短语拆桶把"触发+应答"拆成两条废用例
  test("二级合并用例(触发名'间接指令'≠应答名'遥控指令')不得判多指令/配对违规", () => {
    const combined = {
      case_name: "遥控指令CANA应答错误处理测试",
      covered_tr_items: ["TR-JK-009"],
      test_step: [
        {
          步骤描述: "第3.0秒，通过CANA总线发送间接指令触发，触发软件通过二级CAN总线向目标节点发送遥控指令。",
          预期结果: "软件接收一级CANA总线间接指令，按二级CAN协议组装遥控指令帧并通过二级CAN总线向目标节点转发。",
        },
        {
          步骤描述: "第3.5秒，通过二级CAN总线发送站地址01H的全部正确的遥控指令应答（仲裁场、控制场、LENGTH、TITLE、INDEX、SUM均正确）。",
          预期结果: "软件接收到正确的应答，二级CAN错误应答计数TMYN395保持为0，二级CAN错误应答站地址TMYN396保持初值不变，建立基线。",
        },
        {
          步骤描述: "第4.0秒，通过CANA总线发送间接指令触发，触发软件通过二级CAN总线向目标节点发送遥控指令。",
          预期结果: "软件接收一级CANA总线间接指令，按二级CAN协议组装遥控指令帧并通过二级CAN总线向目标节点转发。",
        },
        {
          步骤描述: "第4.5秒，通过二级CAN总线发送站地址01H的遥控指令应答（仲裁场字节错误，其余字段正确）。",
          预期结果: "软件检测到应答任一字节错误，遥测帧3参数二级CAN错误应答计数TMYN395由0加1变为1，二级CAN错误应答站地址TMYN396被设置为该应答中的站地址值。",
        },
        {
          步骤描述: "第5.0秒，通过CANA总线发送间接指令触发，触发软件通过二级CAN总线向目标节点发送遥控指令。",
          预期结果: "软件接收一级CANA总线间接指令，按二级CAN协议组装遥控指令帧并通过二级CAN总线向目标节点转发。",
        },
        {
          步骤描述: "第5.5秒，通过二级CAN总线发送站地址01H的全部正确的遥控指令应答（仲裁场、控制场、LENGTH、TITLE、INDEX、SUM均正确）。",
          预期结果: "软件接收到正确的应答，二级CAN错误应答计数TMYN395保持为1不再递增，错误计数恢复基线。",
        },
      ],
    }
    expect(analyzeCaseStructure([combined]).violations).toHaveLength(0)
    // 修复器重分组也不得把触发与应答拆散:无违规时不进重组,原样保留
    const repair = repairCaseStructure([combined] as any)
    expect(repair.cases).toHaveLength(1)
    expect(repair.cases[0]!.test_step).toHaveLength(6)
  })

  // 遥测轮询变体:应答是"返回遥测数据"(无"应答"字样),预期结果的计数器
  // 文本("遥测帧3参数二级CAN错误轮询计数")经轮询兜底提取的短语两侧不同
  test("遥测轮询二级应答('返回遥测数据'+计数器文本预期)配对按位置性恢复单元判定", () => {
    const polling = {
      case_name: "遥测轮询CANA错误处理测试",
      covered_tr_items: ["TR-GN-CANCJ-002"],
      test_step: [
        { 步骤描述: "第3.0秒，通过CANA总线发送遥测轮询控制序列，触发软件通过二级CAN总线向目标节点发起遥测轮询。", 预期结果: "软件接收并通过二级CAN总线发起遥测轮询。" },
        { 步骤描述: "第3.5秒，通过二级CAN总线返回站地址01H的全部正确的遥测数据（仲裁场、控制场、LENGTH、TITLE、INDEX、SUM均正确）。", 预期结果: "软件接收到正确的遥测数据，更新相应一级CANA总线遥测参数。" },
        { 步骤描述: "第4.0秒，通过CANA总线发送遥测轮询控制序列，触发软件通过二级CAN总线向目标节点发起遥测轮询。", 预期结果: "软件接收并通过二级CAN总线发起遥测轮询。" },
        { 步骤描述: "第4.5秒，通过二级CAN总线返回站地址01H的遥测数据（仲裁场字节错误，其余字段正确）。", 预期结果: "软件检测到遥测数据任一字段错误，遥测帧3参数二级CAN错误轮询计数TMYN397由0加1变为1，二级CAN错误轮询站地址TMYN398被设置为该遥测数据中的站地址值。" },
        { 步骤描述: "第5.0秒，通过CANA总线发送遥测轮询控制序列，触发软件通过二级CAN总线向目标节点发起遥测轮询。", 预期结果: "软件接收并通过二级CAN总线发起遥测轮询。" },
        { 步骤描述: "第5.5秒，通过二级CAN总线返回站地址01H的全部正确的遥测数据（仲裁场、控制场、LENGTH、TITLE、INDEX、SUM均正确）。", 预期结果: "软件接收到正确的遥测数据，二级CAN错误轮询计数TMYN397保持为1不再递增，错误计数恢复基线。" },
      ],
    }
    expect(analyzeCaseStructure([polling]).violations).toHaveLength(0)
  })

  // 聚合警告曾因比较带总线标签的字符串而对对称覆盖告警(当日 15 条全伪)
  test("CANA/CANB 对称覆盖不得告警;不对称覆盖才提示补齐", () => {
    const mkCase = (bus: string, covered: string[]) => ({
      case_name: `${bus}总线遥测帧1轮询控制序列字段错误测试`,
      covered_tr_items: covered,
      test_step: [
        { 步骤描述: `第1.0秒，通过${bus}总线发送正确的遥测帧1轮询控制序列。`, 预期结果: "正常。" },
        { 步骤描述: `第1.5秒，通过${bus}总线发送遥测帧1轮询控制序列（仲裁场错误，其余字段正确）。`, 预期结果: "计数加1。" },
        { 步骤描述: `第2.0秒，通过${bus}总线发送正确的遥测帧1轮询控制序列。`, 预期结果: "恢复基线。" },
      ],
    })
    const symmetric = analyzeCaseAggregation([mkCase("CANA", ["TR-JK-001", "TR-JK-002"]), mkCase("CANB", ["TR-JK-001", "TR-JK-002"])], [])
    expect(symmetric.warnings).toHaveLength(0)
    const asymmetric = analyzeCaseAggregation([mkCase("CANA", ["TR-JK-001", "TR-JK-002"]), mkCase("CANB", ["TR-JK-001"])], [])
    expect(asymmetric.warnings.some((w) => w.includes("覆盖不一致"))).toBe(true)
  })

  // 2026-08-26 午用户裁定:业务步骤禁止第0.0秒(当日运行 worker 写了 第0.0秒/第0.1秒)
  test("第0.0秒/第0秒步骤判 zero_time_step 违规;第3.0秒起步不误报;修复器不因此重组", () => {
    const zeroTime = {
      case_name: "二级CANA总线遥控指令发送与应答错误处理测试",
      covered_tr_items: ["TR-JK-009"],
      test_step: [
        { 步骤描述: "第0.0秒,通过一级CAN总线发送遥控指令触发软件向二级CANA总线转发遥控指令数据包。", 预期结果: "软件接收并转发。" },
        { 步骤描述: "第0.1秒,通过二级CANA总线返回正确的应答数据包（所有字段均正确）。", 预期结果: "软件正确处理应答。" },
        { 步骤描述: "第0秒,通过一级CAN总线发送遥控指令触发软件向二级CANA总线转发。", 预期结果: "软件接收并转发。" },
        { 步骤描述: "第0.5秒,通过二级CANA总线返回遥控指令应答。", 预期结果: "软件正确处理应答。" },
      ],
    }
    const analysis = analyzeCaseStructure([zeroTime])
    const zeroViolations = analysis.violations.filter((v) => v.type === "zero_time_step")
    expect(zeroViolations).toHaveLength(1)
    expect(zeroViolations[0]!.message).toContain("1、3")
    // 修复器不把 0 秒用例牵连进重组(时间值由重派给出,重组无法发明合理时间)
    const repair = repairCaseStructure([zeroTime] as any)
    expect(repair.actions.every((a) => !a.includes("已重组"))).toBe(true)

    const normalStart = {
      ...zeroTime,
      test_step: zeroTime.test_step.map((s, i) => ({
        ...s,
        步骤描述: String(s.步骤描述).replace(/第0(?:\.0+|\.1|\.5)?秒/, `第${3 + i}秒`),
      })),
    }
    expect(analyzeCaseStructure([normalStart]).violations.filter((v) => v.type === "zero_time_step")).toHaveLength(0)
  })

  // 2026-08-26 晚两案:TC-JK-017/018 拆散("发送遥测数据"应答被漏杀) + 循环时间优化
  test("'发送遥测数据'型二级应答(无应答/返回字样)不再误判多指令与配对", () => {
    const combined = {
      case_name: "二级CAN遥测轮询错误计数测试",
      covered_tr_items: ["TR-GN-CANCJ-002"],
      test_step: [
        { 步骤描述: "第3.0秒,通过CANA总线发送遥测轮询控制序列,触发软件通过二级CAN总线向目标节点发起遥测轮询。", 预期结果: "软件接收并通过二级CAN总线转发。" },
        { 步骤描述: "第3.5秒,通过二级CAN总线发送站地址01H的正确的遥测数据。", 预期结果: "软件接收到正确的遥测数据,更新相应一级CANA总线遥测。" },
        { 步骤描述: "第4.0秒,通过CANA总线发送遥测轮询控制序列,触发软件通过二级CAN总线向目标节点发起遥测轮询。", 预期结果: "软件接收并通过二级CAN总线转发。" },
        { 步骤描述: "第4.5秒,通过二级CAN总线发送站地址01H的遥测数据(仲裁场字节错误,其余字段正确)。", 预期结果: "遥测帧3参数二级CAN错误轮询计数TMYN397由0加1变为1,二级CAN错误轮询站地址TMYN398为站地址01H。" },
        { 步骤描述: "第5.0秒,通过CANA总线发送遥测轮询控制序列,触发软件通过二级CAN总线向目标节点发起遥测轮询。", 预期结果: "软件接收并通过二级CAN总线转发。" },
        { 步骤描述: "第5.5秒,通过二级CAN总线发送站地址01H的正确的遥测数据。", 预期结果: "二级CAN错误轮询计数TMYN397保持为1不再递增,错误计数恢复基线。" },
      ],
    }
    expect(analyzeCaseStructure([combined]).violations).toHaveLength(0)
    // 无违规不进重组,合并结构原样保留
    const repair = repairCaseStructure([combined] as any)
    expect(repair.cases).toHaveLength(1)
    expect(repair.cases[0]!.test_step).toHaveLength(6)
  })

  test("循环触发模式:唯一循环触发+应答交替;错误后紧跟正确应答即配对;修复器单步补配对", () => {
    const loopCase = {
      case_name: "二级CANA总线遥测轮询错误计数测试",
      covered_tr_items: ["TR-GN-CANCJ-002"],
      test_step: [
        { 步骤描述: "第3.0秒,通过CANA总线以1秒为周期循环发送遥测轮询控制序列。", 预期结果: "软件接收遥测轮询控制序列,按二级CAN总线协议组装后通过二级CAN总线转发。" },
        { 步骤描述: "第3.1秒,通过二级CAN总线发送站地址01H的正确的遥测数据。", 预期结果: "软件接收到正确的遥测数据,更新相应一级CANA总线遥测。" },
        { 步骤描述: "第4.1秒,通过二级CAN总线发送站地址01H的遥测数据(仲裁场字节错误,其余字段正确)。", 预期结果: "二级CAN错误轮询计数TMYN397由0加1变为1。" },
        { 步骤描述: "第5.1秒,通过二级CAN总线发送站地址01H的正确的遥测数据。", 预期结果: "二级CAN错误轮询计数TMYN397保持为1。" },
      ],
    }
    expect(analyzeCaseStructure([loopCase]).violations).toHaveLength(0)
    // 去掉末尾正确应答 → 违规;修复器在循环模式只补单步[二级正确应答]
    const broken = { ...loopCase, test_step: loopCase.test_step.slice(0, 3) }
    const analysis = analyzeCaseStructure([broken])
    expect(analysis.violations.filter((v) => v.type === "missing_correct_after_error")).toHaveLength(1)
    const repair = repairCaseStructure([broken] as any)
    expect(repair.actions.some((a) => a.includes("二级总线·循环模式"))).toBe(true)
    expect(repair.cases[0]!.test_step).toHaveLength(4)
    const lastDesc = String((repair.cases[0]!.test_step[3] as any).步骤描述 ?? (repair.cases[0]!.test_step[3] as any).step_desc)
    // 恢复步骤从错误步骤派生:载荷/站地址逐字保留,错误情形改为全部正确
    expect(lastDesc).toContain("站地址01H")
    expect(lastDesc).toContain("遥测数据")
    expect(lastDesc).not.toContain("错误")
  })

  test("自动切换主题用例的连续错误不判配对违规(连续错误是测试目的)", () => {
    const switchCase = {
      case_name: "二级CAN总线自动切换测试",
      test_purpose: "验证二级CAN总线自动切换:连续3次未收到同一节点正确遥测数据则切换总线。",
      covered_tr_items: ["TR-JK-010"],
      test_step: [
        { 步骤描述: "第3.0秒,通过CANA总线向站地址X发送遥测轮询控制序列。", 预期结果: "软件接收并转发。" },
        { 步骤描述: "第3.5秒,通过二级CAN总线A发送站地址X的错误遥测数据（SUM校验和错误）。", 预期结果: "错误轮询计数加1。" },
        { 步骤描述: "第4.0秒,通过CANA总线向站地址X发送遥测轮询控制序列。", 预期结果: "软件接收并转发。" },
        { 步骤描述: "第4.5秒,通过二级CAN总线A发送站地址X的错误遥测数据（SUM校验和错误）。", 预期结果: "错误轮询计数加2。" },
        { 步骤描述: "第5.0秒,通过CANA总线向站地址X发送遥测轮询控制序列。", 预期结果: "软件接收并转发。" },
        { 步骤描述: "第5.5秒,通过二级CAN总线A发送站地址X的错误遥测数据（SUM校验和错误）。", 预期结果: "连续3次错误,软件切换到B总线。" },
        { 步骤描述: "第6.5秒,通过二级CAN总线B发送站地址X的正确的遥测数据。", 预期结果: "切换后恢复正确接收。" },
      ],
    }
    expect(analyzeCaseStructure([switchCase]).violations).toHaveLength(0)
  })

  // 2026-08-26 晚经验固化:自动切换标准模式(循环触发 + N-1连错+1正确 + N连错切换)
  test("自动切换标准模式(secondary-bus-switch.md 示例)通过全部结构门禁", () => {
    const canonical = {
      case_name: "二级CAN总线自动切换测试",
      test_purpose: "验证二级CAN总线自动切换:连续3次未收到同一节点正确遥测数据则切换总线。",
      covered_tr_items: ["TR-JK-010"],
      test_step: [
        { 步骤描述: "第3.0秒，通过CANA总线以1秒为周期循环发送遥测帧1轮询控制序列。", 预期结果: "软件接收并通过二级总线A转发遥测轮询控制序列。" },
        { 步骤描述: "第3.1秒，通过二级总线A发送站地址X的遥测数据（TITLE字节错误，其余字段正确）。", 预期结果: "软件继续通过二级总线A输出遥测轮询控制序列。" },
        { 步骤描述: "第4.1秒，通过二级总线A发送站地址X的遥测数据（TITLE字节错误，其余字段正确）。", 预期结果: "软件继续通过二级总线A输出遥测轮询控制序列。" },
        { 步骤描述: "第5.1秒，通过二级总线A发送站地址X的全部正确的遥测数据。", 预期结果: "软件继续通过二级总线A输出遥测轮询控制序列。" },
        { 步骤描述: "第6.1秒，通过二级总线A发送站地址X的遥测数据（TITLE字节错误，其余字段正确）。", 预期结果: "软件继续通过二级总线A输出遥测轮询控制序列。" },
        { 步骤描述: "第7.1秒，通过二级总线A发送站地址X的遥测数据（TITLE字节错误，其余字段正确）。", 预期结果: "软件继续通过二级总线A输出遥测轮询控制序列。" },
        { 步骤描述: "第8.1秒，通过二级总线A发送站地址X的遥测数据（TITLE字节错误，其余字段正确）。", 预期结果: "连续3次未收到,软件已切换总线,通过二级总线B输出遥测轮询控制序列。" },
      ],
    }
    expect(analyzeCaseStructure([canonical]).violations).toHaveLength(0)
    const repair = repairCaseStructure([canonical] as any)
    expect(repair.cases).toHaveLength(1)
    expect(repair.cases[0]!.test_step).toHaveLength(7)
  })
})

describe("2026-08-26 晚取证回归:站地址/触发结构/切换用例三案(步骤取自当晚真实运行)", () => {
  // inputFlowContext 中的站地址定义表(截取自真实 worker 提示词)
  const STATION_TABLE =
    "表3.1.3.1-2  相机二级CAN总线站地址定义" +
    "<table><tr><th>序号</th><th>单机名称</th><th>终端类型</th><th>站地址</th><th>遥测帧数</th></tr>" +
    "<tr><td>1.</td><td>管理控制器</td><td>主节点</td><td>00H</td><td>-</td></tr>" +
    "<tr><td>2.</td><td>对地高分红外视频处理器短波</td><td>从节点</td><td>01H</td><td>4</td></tr>" +
    "<tr><td>3.</td><td>对地高分红外视频处理器中波</td><td>从节点</td><td>02H</td><td>4</td></tr></table>"

  // 案1:worker 真实形态——只有二级数据步骤(无一级触发)+ 无站地址(遥测轮询用例)
  const secondaryOnlyPolling = {
    case_name: "二级CAN遥测轮询错误处理测试",
    test_purpose: "验证二级CAN遥测数据字段错误的检测与错误轮询计数TMYN397累加。",
    covered_tr_items: ["TR-GN-CANCJ-002"],
    test_step: [
      { 步骤描述: "第3.0秒，通过二级CAN总线模拟下位机发送遥测数据（全部字段正确：仲裁场、控制场、LENGTH、TITLE、INDEX、SUM均正确）。", 预期结果: "二级CAN错误轮询计数TMYN397保持初始值0，二级CAN错误轮询站地址TMYN398保持初始值0。" },
      { 步骤描述: "第3.5秒，通过二级CAN总线模拟下位机发送遥测数据（仲裁场/控制场错误，其余字段正确）。", 预期结果: "二级CAN错误轮询计数TMYN397由0累加为1，二级CAN错误轮询站地址TMYN398更新为该遥测数据中站地址。" },
      { 步骤描述: "第4.0秒，通过二级CAN总线模拟下位机发送遥测数据（全部字段正确）。", 预期结果: "二级CAN错误轮询计数TMYN397保持1不变。" },
    ],
  }

  test("案1门禁:缺一级触发+缺站地址双双报违规;重派指令表给出对应指引", () => {
    const types = analyzeCaseStructure([secondaryOnlyPolling as any]).violations.map((v) => v.type)
    expect(types).toContain("missing_primary_trigger")
    expect(types).toContain("missing_station_address")
    const directive = buildRegroupDirective(
      { violations: [], warnings: [], coverage_gaps: [] },
      analyzeCaseStructure([secondaryOnlyPolling as any]),
    )
    expect(directive.some((l) => l.includes("缺少一级总线触发步骤"))).toBe(true)
    expect(directive.some((l) => l.includes("未指明站地址"))).toBe(true)
  })

  test("案1自愈:头部补循环触发(载荷从遥测数据反推为轮询控制序列)+注入站地址01H+无垃圾一级载荷", () => {
    const repair = repairCaseStructure([secondaryOnlyPolling] as any, {
      stationAddressCorpus: STATION_TABLE,
    })
    const steps = repair.cases[0]!.test_step as any[]
    // 头部触发:唯一循环触发,载荷为一级协议的轮询控制序列
    expect(String(steps[0]!.步骤描述)).toContain("以1秒为周期循环发送遥测帧1轮询控制序列")
    // 一级总线指令不带站地址(2026-08-27 用户裁定:站地址只属于二级步骤)
    expect(String(steps[0]!.步骤描述)).not.toContain("站地址")
    expect(String(steps[0]!.步骤描述)).not.toContain("二级")
    // 全部二级步骤统一站地址01H(取站地址表第一个从节点)
    const secondarySteps = steps.filter((s) => String(s.步骤描述).includes("二级CAN总线"))
    expect(secondarySteps.length).toBeGreaterThanOrEqual(3)
    for (const s of secondarySteps) expect(String(s.步骤描述)).toContain("站地址01H")
    // 预期结果中的站地址指代落为具体值
    expect(String(steps[2]!.预期结果)).toContain("站地址01H")
    expect(String(steps[2]!.预期结果)).not.toContain("该遥测数据中站地址")
    // 触发补齐后进入循环模式:错误步骤后已有正确步骤,不再插入显式恢复单元
    expect(repair.actions.some((a) => a.includes("恢复单元"))).toBe(false)
    // 修复后该用例无残留结构违规
    expect(repair.residual_structure_violations.filter((v) => v.case_name === secondaryOnlyPolling.case_name)).toHaveLength(0)
  })

  test("案2:重复循环触发声明报违规;修复只保留首条声明(循环按周期自动重发)", () => {
    const repeated = {
      case_name: "二级CAN遥控指令应答错误处理测试",
      test_purpose: "验证二级CAN遥控指令应答字段错误与错误应答计数TMYN395。",
      covered_tr_items: ["TR-JK-009"],
      test_step: [
        { 步骤描述: "第3.0秒，通过一级总线CANA发送遥控指令（首次发送）。", 预期结果: "软件接收并转发。" },
        { 步骤描述: "第3.5秒，通过二级CAN总线模拟下位机发送站地址01H的遥控指令应答（全部字段正确）。", 预期结果: "计数保持0。" },
        { 步骤描述: "第4.0秒，通过一级总线CANA以1秒周期循环发送遥控指令。", 预期结果: "按周期继续接收。" },
        { 步骤描述: "第4.5秒，通过二级CAN总线模拟下位机发送站地址01H的遥控指令应答（仲裁场错误，其余字段正确）。", 预期结果: "计数累加为1。" },
        { 步骤描述: "第5.0秒，通过一级总线CANA以1秒周期循环发送遥控指令。", 预期结果: "按周期继续接收。" },
        { 步骤描述: "第5.5秒，通过二级CAN总线模拟下位机发送站地址01H的遥控指令应答（全部字段正确）。", 预期结果: "计数保持1。" },
      ],
    }
    const types = analyzeCaseStructure([repeated as any]).violations.map((v) => v.type)
    expect(types).toContain("duplicate_loop_trigger")
    const repair = repairCaseStructure([repeated] as any)
    expect(repair.actions.some((a) => a.includes("已去重循环触发"))).toBe(true)
    const descs = (repair.cases[0]!.test_step as any[]).map((s) => String(s.步骤描述))
    expect(descs.filter((d) => /循环发送/.test(d))).toHaveLength(1)
    expect(repair.residual_structure_violations.filter((v) => v.case_name === repeated.case_name)).toHaveLength(0)
  })

  test("案3:切换用例豁免跨用例聚合压力(与其余用例共享'遥控指令'短语不判拆散)", () => {
    const remoteCase = {
      case_name: "二级CAN遥控指令应答错误处理测试",
      test_purpose: "验证遥控指令应答错误计数。",
      covered_tr_items: ["TR-JK-009"],
      test_step: [
        { 步骤描述: "第3.0秒，通过CANA总线发送遥控指令。", 预期结果: "软件接收并转发。" },
        { 步骤描述: "第4.0秒，通过一级总线CANA以1秒周期循环发送遥控指令。", 预期结果: "按周期继续接收。" },
        { 步骤描述: "第4.5秒，通过二级CAN总线模拟下位机发送站地址01H的遥控指令应答（仲裁场错误，其余字段正确）。", 预期结果: "计数累加。" },
      ],
    }
    const switchUntriggered = {
      case_name: "二级CAN自动切换未触发测试",
      test_purpose: "验证连续2次错误+1次正确未达切换阈值，不发生总线切换。",
      covered_tr_items: ["TR-JK-010"],
      test_step: [
        { 步骤描述: "第3.0秒，通过二级CAN总线（A总线）模拟下位机发送遥测数据（TITLE字段错误1，其余字段正确）。", 预期结果: "连续错误计数1，仍在A总线。" },
        { 步骤描述: "第3.5秒，通过二级CAN总线（A总线）模拟下位机发送遥测数据（TITLE字段错误2，其余字段正确）。", 预期结果: "连续错误计数2，仍在A总线。" },
        { 步骤描述: "第4.0秒，通过二级CAN总线（A总线）模拟下位机发送遥测数据（全部字段正确）。", 预期结果: "计数清零，未切换。" },
        // worker 自创的验证步骤(当晚真实形态;模板已禁止,但检测必须豁免其聚合牵连)
        { 步骤描述: "第4.5秒，通过一级总线CANA发送遥控指令，验证A总线仍正常工作。", 预期结果: "软件经A总线正常转发。" },
      ],
    }
    const analysis = analyzeCaseAggregation(
      [remoteCase, switchUntriggered] as any,
      ["TR-JK-009", "TR-JK-010"],
    )
    expect(analysis.violations).toHaveLength(0)
  })

  test("案4:切换场景用例(纯二级连错)自愈——补触发+注站地址;连续错误豁免配对插入", () => {
    const switchTriggered = {
      case_name: "二级CAN自动切换触发测试",
      test_purpose: "验证连续3次未收到同一节点正确遥测数据时由A总线切换到B总线。",
      covered_tr_items: ["TR-JK-010"],
      test_step: [
        { 步骤描述: "第3.0秒，通过二级CAN总线（A总线）模拟下位机发送遥测数据（TITLE字段错误1，其余字段正确）。", 预期结果: "连续错误计数1，仍在A总线。" },
        { 步骤描述: "第3.5秒，通过二级CAN总线（A总线）模拟下位机发送遥测数据（TITLE字段错误2，其余字段正确）。", 预期结果: "连续错误计数2，仍在A总线。" },
        { 步骤描述: "第4.0秒，通过二级CAN总线（A总线）模拟下位机发送遥测数据（TITLE字段错误3，其余字段正确）。", 预期结果: "连续3次未收到正确遥测,切换到B总线。" },
        // worker 自创的验证步骤(当晚真实形态;模板已禁止)——验证类步骤不算有效触发
        { 步骤描述: "第4.5秒，通过一级总线CANA发送遥控指令，验证B总线已切换成功。", 预期结果: "软件经B总线正常接收应答。" },
      ],
    }
    const types = analyzeCaseStructure([switchTriggered as any]).violations.map((v) => v.type)
    expect(types).toContain("missing_primary_trigger")
    expect(types).toContain("missing_station_address")
    const repair = repairCaseStructure([switchTriggered] as any, {
      stationAddressCorpus: STATION_TABLE,
    })
    const steps = repair.cases[0]!.test_step as any[]
    expect(String(steps[0]!.步骤描述)).toContain("以1秒为周期循环发送遥测帧1轮询控制序列")
    // 一级总线指令不带站地址(2026-08-27 用户裁定:站地址只属于二级步骤)
    expect(String(steps[0]!.步骤描述)).not.toContain("站地址")
    expect(String(steps[3]!.步骤描述)).toContain("站地址01H")
    // 连续错误是测试目的:不为连错步骤插入正确应答恢复
    expect(repair.actions.some((a) => a.includes("补配对"))).toBe(false)
    expect(repair.residual_structure_violations.filter((v) => v.case_name === switchTriggered.case_name)).toHaveLength(0)
  })

  test("案5短语护栏:预期结果中的计数器名不再成为一级重发载荷;无法反推时跳过插入不产垃圾", () => {
    // 预期文本的"二级CAN错误轮询计数TMYN397"曾是垃圾载荷来源(当晚真实插入:
    // "第4秒,通过CANA总线发送二级CAN错误轮询。")
    const explicitMode = {
      case_name: "二级CAN遥测轮询错误处理测试",
      test_purpose: "验证遥测数据字段错误与错误轮询计数。",
      covered_tr_items: ["TR-GN-CANCJ-002"],
      test_step: [
        { 步骤描述: "第3.0秒，通过二级CAN总线模拟下位机发送站地址01H的遥测数据（仲裁场/控制场错误，其余字段正确）。", 预期结果: "二级CAN错误轮询计数TMYN397由0累加为1，二级CAN错误轮询站地址TMYN398更新为该遥测数据中站地址。" },
      ],
    }
    const repair = repairCaseStructure([explicitMode] as any, {
      stationAddressCorpus: STATION_TABLE,
    })
    const descs = (repair.cases[0]!.test_step as any[]).map((s) => String(s.步骤描述))
    // 一级步骤载荷禁止二级协议名(载荷层级铁律适用于修复插入)
    for (const d of descs) {
      if (/通过CANA总线发送/.test(d)) {
        expect(d).not.toContain("二级")
      }
    }
    // 遥测数据可反推为轮询控制序列:自愈插入的循环触发头步载荷必须是轮询控制序列,
    // 而非预期文本里的计数器名"二级CAN错误轮询"
    expect(descs.some((d) => d.includes("以1秒为周期循环发送遥测帧1轮询控制序列"))).toBe(true)
    expect(descs.some((d) => d.includes("二级CAN错误轮询。"))).toBe(false)
    // 无法反推指令名的形态:跳过插入并如实上报,不合成垃圾步骤
    const underivable = {
      case_name: "二级CAN数据测试",
      test_purpose: "验证数据错误处理。",
      covered_tr_items: ["TR-GN-CANCJ-002"],
      test_step: [
        { 步骤描述: "第3.0秒，通过CANA总线发送测试指令。", 预期结果: "软件接收并转发。" },
        { 步骤描述: "第3.5秒，通过二级CAN总线发送数据（格式错误）。", 预期结果: "软件判定数据错误。" },
      ],
    }
    const repair2 = repairCaseStructure([underivable] as any)
    const descs2 = (repair2.cases[0]!.test_step as any[]).map((s) => String(s.步骤描述))
    expect(repair2.actions.some((a) => a.includes("[跳过插入]"))).toBe(true)
    for (const d of descs2) {
      if (/通过CANA总线发送/.test(d) && !d.includes("测试指令")) {
        expect(d).not.toContain("二级")
      }
    }
  })
})

describe("2026-08-27 回归:一级指令不带站地址 + 长度变体限定词(取自当日用户反馈)", () => {
  // 数据流定义原文形态:遥控指令有两种长度;15字节/10字节各出现于表格标题
  const REMOTE_FLOW =
    "遥控指令相关数据流 输入流：遥控指令。SMU发向相机管理控制器的遥控指令有两种格式，" +
    "包括10字节遥控指令和15字节遥控指令（有效字节数）。表3.1.1.5-1 发向相机管理控制器长度10字节的遥控指令。" +
    "表3.1.1.5-2 发向相机管理控制器长度15字节的遥控指令。另:上行数据块指令只有15字节上行数据块指令一种格式。"

  test("提取器:同名指令≥2种长度才算变体基名;单一长度不算", () => {
    const bases = extractLengthVariantBases(REMOTE_FLOW)
    expect(bases.get("遥控指令")).toEqual(["10字节遥控指令", "15字节遥控指令"])
    expect(bases.has("上行数据块指令")).toBe(false)
  })

  const bareCase = {
    case_name: "二级CAN遥控指令应答错误处理测试",
    test_purpose: "验证遥控指令应答错误计数。",
    covered_tr_items: ["TR-JK-009"],
    test_step: [
      { 步骤描述: "第3.0秒，通过CANA总线以1秒为周期循环发送遥控指令。", 预期结果: "软件接收并通过二级总线转发。" },
      { 步骤描述: "第3.5秒，通过二级CAN总线发送站地址01H的遥控指令应答（全部字段正确）。", 预期结果: "计数保持0。" },
    ],
  }
  const bases = extractLengthVariantBases(REMOTE_FLOW)

  test("门禁:裸'遥控指令'报 missing_instruction_length_variant;带限定词不报", () => {
    const bare = analyzeCaseStructure([bareCase as any], { lengthVariantBases: bases })
      .violations.filter((v) => v.type === "missing_instruction_length_variant")
    expect(bare).toHaveLength(1)
    expect(bare[0]!.message).toContain("10字节遥控指令")
    const directive = buildRegroupDirective(
      { violations: [], warnings: [], coverage_gaps: [] },
      analyzeCaseStructure([bareCase as any], { lengthVariantBases: bases }),
    )
    expect(directive.some((l) => l.includes("长度限定词") && l.includes("遥控指令"))).toBe(true)

    const qualified = {
      ...bareCase,
      test_step: [
        { 步骤描述: "第3.0秒，通过CANA总线以1秒为周期循环发送10字节遥控指令。", 预期结果: "软件接收并通过二级总线转发。" },
        { 步骤描述: "第3.5秒，通过二级CAN总线发送站地址01H的遥控指令应答（全部字段正确）。", 预期结果: "计数保持0。" },
      ],
    }
    expect(analyzeCaseStructure([qualified as any], { lengthVariantBases: bases }).violations).toHaveLength(0)
  })

  test("修复:确定性修复不擅自挑选长度变体——残留如实上报,不产垃圾改写", () => {
    const repair = repairCaseStructure([bareCase] as any, {
      stationAddressCorpus: "",
      lengthVariantBases: bases,
    })
    expect(repair.residual_structure_violations.some((v) => v.type === "missing_instruction_length_variant")).toBe(true)
    // 不得把裸指令改写成擅自挑选的变体
    const descs = (repair.cases[0]!.test_step as any[]).map((s) => String(s.步骤描述))
    expect(descs.some((d) => d.includes("10字节遥控指令") || d.includes("15字节遥控指令"))).toBe(false)
  })
})

describe("2026-08-28 回归:SPI 二级同构 + 上行数据块长度变体(取自当日 TC-JK-028/029 拆散与上行数据块取证)", () => {
  // 数据流定义原文形态:上行数据块两种长度(数据块后缀,非"指令"后缀)
  const UPLINK_FLOW =
    "上行数据相关数据流 输入流：上行数据块。上行数据块格式有两种，249字节上行数据块（具体内容见需求规格说明附录E）" +
    "和72字节上行数据块（具体内容见需求规格说明附录H）。表3.1.1.6-1 发向相机管理控制器长度249字节的多帧上行数据块。"

  test("提取器:数据块后缀的同名长度变体同样成基名(此前只认'指令'后缀,上行数据块变体表恒空、门禁从未生效)", () => {
    const bases = extractLengthVariantBases(UPLINK_FLOW)
    expect(bases.get("上行数据块")).toEqual(["249字节上行数据块", "72字节上行数据块"])
  })

  test("门禁:裸'上行数据块'报 missing_instruction_length_variant(249/72 各立用例);带限定词不报", () => {
    const bases = extractLengthVariantBases(UPLINK_FLOW)
    const bare = {
      case_name: "CANA总线上行数据块校核测试",
      test_purpose: "验证上行数据块校核处理。",
      covered_tr_items: ["TR-JK-001"],
      test_step: [
        { 步骤描述: "第3.0秒，通过CANA总线发送正确的上行数据块（多帧数据，LENGTH/TITLE/INDEX/SUM均正确，W0功能ID有效）。", 预期结果: "软件接收、组帧并返回应答，TMYN002=1。" },
        { 步骤描述: "第3.5秒，通过CANA总线发送上行数据块（LENGTH字节错误，其余字段正确）。", 预期结果: "软件识别LENGTH错误，W170=1。" },
        { 步骤描述: "第4.0秒，通过CANA总线发送正确的上行数据块。", 预期结果: "TMYN002=2。" },
      ],
    }
    const violations = analyzeCaseStructure([bare as any], { lengthVariantBases: bases }).violations
    expect(violations.filter((v) => v.type === "missing_instruction_length_variant")).toHaveLength(1)
    expect(violations[0]!.message).toContain("249字节上行数据块")
    expect(violations[0]!.message).toContain("72字节上行数据块")

    const qualified = {
      ...bare,
      test_step: [
        { 步骤描述: "第3.0秒，通过CANA总线发送正确的249字节上行数据块（LENGTH/TITLE/INDEX/SUM均正确，W0功能ID有效）。", 预期结果: "软件接收、组帧并返回应答，TMYN002=1。" },
        { 步骤描述: "第3.5秒，通过CANA总线发送249字节上行数据块（LENGTH字节错误，其余字段正确）。", 预期结果: "软件识别LENGTH错误，W170=1。" },
        { 步骤描述: "第4.0秒，通过CANA总线发送正确的249字节上行数据块。", 预期结果: "TMYN002=2。" },
      ],
    }
    expect(analyzeCaseStructure([qualified as any], { lengthVariantBases: bases }).violations).toHaveLength(0)
  })

  // worker 真实输出形态(2026-08-27 18:58 TR-JK-011 组逐字风格):一级触发名与 SPI 输入流名本就不同名
  const spiWholeCase = {
    case_name: "SPI黑体驱动遥控指令CANA总线测试",
    test_purpose: "验证黑体驱动遥控指令经SPI总线的发送与应答处理。",
    covered_tr_items: ["TR-JK-011"],
    test_step: [
      { 步骤描述: "第3.0秒，通过CANA总线以1秒为周期循环发送黑体驱动遥控指令（黑体驱动指令=驱动打开，目标温度=设定温度档位1）。", 预期结果: "软件接收，按黑体驱动电路数据流定义组包，经SPI总线A向黑体驱动单板发送黑体驱动指令（循环时间=1.0）。" },
      { 步骤描述: "第3.1秒，通过SPI总线A发送站地址5AH的黑体驱动指令应答（全部字段正确）。", 预期结果: "软件正常处理应答，SPI错误应答计数TMYN229保持0。" },
      { 步骤描述: "第4.1秒，通过SPI总线A发送站地址5AH的黑体驱动指令应答（站地址错误，其余字段正确）。", 预期结果: "SPI错误应答计数TMYN229为1，SPI错误应答站地址TMYN230为该应答中站地址。" },
      { 步骤描述: "第5.1秒，通过SPI总线A发送站地址5AH的黑体驱动指令应答（全部字段正确）。", 预期结果: "SPI错误应答计数TMYN229保持1。" },
    ],
  }

  test("SPI 同构:触发名(黑体驱动遥控指令)≠SPI应答名(黑体驱动指令应答)不再判混指令/缺触发;站地址/配对/时间全过", () => {
    // 2026-08-27 18:51/18:58 两次运行:该形态被判 mixed_instruction,auto_repair
    // 按"黑体驱动遥控指令|黑体驱动指令"分桶拆成 TC-JK-028(纯触发)+TC-JK-029(纯SPI)
    expect(analyzeCaseStructure([spiWholeCase as any]).violations).toHaveLength(0)
  })

  test("SPI 半截用例(只有 SPI 应答步骤)报缺一级触发;自愈不插错名触发(SPI 应答名≠一级指令名),如实报需重派", () => {
    const half = {
      ...spiWholeCase,
      case_name: "黑体驱动指令测试",
      test_step: spiWholeCase.test_step.slice(1),
    }
    const violations = analyzeCaseStructure([half as any]).violations
    expect(violations.some((v) => v.type === "missing_primary_trigger")).toBe(true)

    const repair = repairCaseStructure([JSON.parse(JSON.stringify(half))] as any, {})
    expect((repair.cases[0]!.test_step as any[])).toHaveLength(3)
    expect(repair.actions.some((a) => a.includes("需重派") || a.includes("无法自愈"))).toBe(true)
  })

  test("聚合:SPI 应答步骤的预期半区(缓变遥测帧名/SPI错误轮询)不再产幽灵短语,不同 TR 的 SPI 用例不误报合并", () => {
    const cases = [
      { ...spiWholeCase },
      {
        case_name: "SPI电机遥测轮询判定CANA总线校核测试",
        test_purpose: "验证电机遥测轮询错误计数。",
        covered_tr_items: ["TR-GN-SPICJ-001"],
        test_step: [
          { 步骤描述: "第3.0秒，通过CANA总线以1秒为周期循环发送电机遥测轮询指令（一级触发指令）。", 预期结果: "软件接收并经SPI总线A向单板发送电机遥测轮询指令。" },
          { 步骤描述: "第3.1秒，通过SPI总线A发送站地址5CH的电机遥测数据（全部字段正确）。", 预期结果: "软件更新相应遥测帧，缓变遥测数据遥测帧2参数W190为0。" },
          { 步骤描述: "第4.1秒，通过SPI总线A发送站地址5CH的电机遥测数据（LENGTH错误，其余字段正确）。", 预期结果: "W190为1，SPI错误轮询站地址W191为站地址5CH的具体值。" },
          { 步骤描述: "第5.1秒，通过SPI总线A发送站地址5CH的电机遥测数据（全部字段正确）。", 预期结果: "W190保持1。" },
        ],
      },
    ]
    // 电机遥测轮询用例本身也应零结构违规(轮询类触发名≠遥测数据名,spiOnly 不做名称匹配)
    expect(analyzeCaseStructure(cases as any).violations).toHaveLength(0)
    expect(analyzeCaseAggregation(cases as any, []).violations).toHaveLength(0)
  })

  test("重组:真混指令违规触发重组时,SPI 应答步骤附着触发桶,不拆成纯触发/纯SPI两案", () => {
    const mixed = {
      ...spiWholeCase,
      test_step: [
        ...spiWholeCase.test_step,
        { 步骤描述: "第6.1秒，通过CANA总线发送机构控制指令（遥控指令TCY216）。", 预期结果: "软件接收并经SPI总线发送机构控制指令。" },
      ],
    }
    expect(analyzeCaseStructure([mixed as any]).violations.some((v) => v.type === "mixed_instruction")).toBe(true)
    const repair = repairCaseStructure([JSON.parse(JSON.stringify(mixed))] as any, {})
    const hasTrigger = (steps: any[]) => steps.some((s) => /CANA总线/.test(String(s.步骤描述)) && /循环发送/.test(String(s.步骤描述)))
    const hasSpi = (steps: any[]) => steps.some((s) => /SPI总线/.test(String(s.步骤描述)))
    const spiSteps = (steps: any[]) => steps.filter((s) => /SPI总线/.test(String(s.步骤描述))).length
    // 含 SPI 步骤的重组结果必须同时含一级触发;SPI 步骤总数不丢(3)
    const spiCases = repair.cases.filter((c) => hasSpi(c.test_step as any[]))
    expect(spiCases.length).toBeGreaterThanOrEqual(1)
    for (const c of spiCases) expect(hasTrigger(c.test_step as any[])).toBe(true)
    const totalSpi = repair.cases.reduce((sum, c) => sum + spiSteps(c.test_step as any[]), 0)
    expect(totalSpi).toBe(3)
  })
})

describe("2026-08-28 回归:绑定完整度偏好(循环触发步骤选 发送CANATXT数据 而非泄漏索引/轮询占位的 循环发送CANA指令)", () => {
  const loopSendCana = keyword({
    keywordName: "循环发送CANA指令",
    description: "通过%$总线以${para4}秒为周期${para5}发送${para1}.txt中从${para2}到${para3}的指令",
    argumentNames: ["${time}", "${para1}", "${para2}", "${para3}", "${para4}", "${para5}"],
    argumentComments: [
      "执行时间",
      "参数1：数据文件；",
      "参数2：开始索引，十进制；",
      "参数3：结束索引，十进制；",
      "参数4：单指令间循环时间；",
      "参数5：是否轮询(N/Y),[N:单次；Y：轮询]",
    ],
  })
  const sendCanaTxt = keyword({
    keywordName: "发送CANATXT数据",
    description: "第${time}秒,通过%$总线${para3}发送${para2}",
    argumentNames: ["${time}", "${para1}", "${para2}", "${para3}"],
    // 参数注释逐字取自真实 UserKeyWord 库——语义提取/确定性填充按注释模式驱动
    argumentComments: [
      "执行时间",
      "参数1：ID:0~255,一个ID对应一种类型指令。",
      "参数2：数据文件",
      "参数3：循环时间，单位秒，；[0:;其他:以${para3}S为周期;]",
    ],
  })
  const triggerStep = {
    步骤描述: "第3.0秒，通过CANA总线以1秒为周期循环发送遥控指令TCY216（循环时间=1.0，实际发送3.0s、4.0s、5.0s…）。",
    预期结果: "软件接收遥控指令TCY216后按数据流定义组包发送。",
    operation_type: "send_command",
    channel: "CANA",
    temporal: "第3.0秒",
  }

  function combinedOf(map: Map<string, KeywordMeta>) {
    return translateStandardizedCaseToCombined(
      {
        case_name: "机构控制指令CANA总线测试",
        test_purpose: "验证机构控制指令。",
        covered_tr_items: ["TR-JK-011"],
        test_step: [triggerStep],
      } as any,
      map,
    )
  }

  test("两候选并存:零泄漏的 发送CANATXT数据 胜过泄漏 开始索引/结束索引/是否轮询 的 循环发送CANA指令", () => {
    const map = new Map<string, KeywordMeta>([
      ["循环发送CANA指令", loopSendCana],
      ["发送CANATXT数据", sendCanaTxt],
    ])
    const result = combinedOf(map)
    expect(result.steps[0]!.key_name).toBe("发送CANATXT数据")
    const leaks = (result.steps[0]!.parameter || []).filter(
      (p) => typeof p.Value === "string" && /^\{para\d*\}$/.test(p.Value),
    )
    expect(leaks).toHaveLength(0)
  })

  test("仅有泄漏候选时保留占位不整条失败(回退首个成功者)", () => {
    const map = new Map<string, KeywordMeta>([["循环发送CANA指令", loopSendCana]])
    const result = combinedOf(map)
    expect(result.steps[0]!.key_name).toBe("循环发送CANA指令")
    const leaks = (result.steps[0]!.parameter || [])
      .filter((p) => typeof p.Value === "string" && /^\{para\d*\}$/.test(p.Value))
      .map((p) => p.Name)
    expect(leaks).toContain("${para2}")
    expect(leaks).toContain("${para5}")
  })
})

describe("2026-09-02 回归:引号剥除 + 上注类型混用门禁(SpaceWire 取证)", () => {
  const setMemory32 = keyword({
    keywordName: "设置32位地址数据",
    // 真实形态:Documentation 的参数带全角引号
    description: "第${time}秒，设置内存地址${para1}的数据为“${para2}”",
    argumentNames: ["${time}", "${para1}", "${para2}"],
    argumentComments: ["执行时间", "参数1：起始地址，十六进制", "参数2：数据或文件，文件类型包括txt和bin"],
  })

  test("带引号模板对无引号步骤可匹配:参数2 绑载荷标签而非从预期抓数字(704 事故)", () => {
    const result = translateStandardizedCaseToCombined(
      {
        case_name: "管控程序上注起始块测试",
        test_purpose: "验证管控程序上注起始块接收。",
        covered_tr_items: ["TR-GN-SWRC-001"],
        test_step: [{
          步骤描述: "第3.0秒，设置内存地址21142000H的数据为管控程序上注起始块·全部字段正确。",
          预期结果: "软件读取上注数据块数据（数据长度=704字节，有效数据704字节，ISO校验正确）。",
        }],
      } as any,
      new Map([["设置32位地址数据", setMemory32]]),
    )
    expect(result.steps[0]!.key_name).toBe("设置32位地址数据")
    const para2 = (result.steps[0]!.parameter || []).find((p) => p.Name === "${para2}")
    expect(String(para2?.Value)).toContain("管控程序上注起始块")
    expect(String(para2?.Value)).not.toBe("704")
  })

  test("门禁:管控程序上注与二级节点上注混一案报 mixed_upload_type;单类型不报", () => {
    const mixed = [{
      case_name: "Spacewire上注处理测试",
      test_purpose: "验证上注处理。",
      covered_tr_items: ["TR-GN-SWRC-001"],
      test_step: [
        { 步骤描述: "第3.0秒，设置内存地址21142000H的数据为管控程序上注起始块·全部字段正确。", 预期结果: "正确接收。" },
        { 步骤描述: "第3.1秒，设置内存地址21142E00H的数据为2501H。", 预期结果: "ID 写入。" },
        { 步骤描述: "第3.2秒，触发外部中断2。", 预期结果: "读取数据。" },
        { 步骤描述: "第4.0秒，设置内存地址21142000H的数据为二级节点上注数据块·全部字段正确。", 预期结果: "正确接收。" },
      ],
    }]
    const violations = analyzeCaseStructure(mixed as any).violations
    expect(violations.some((v) => v.type === "mixed_upload_type")).toBe(true)

    const single = [{
      ...mixed[0],
      test_step: mixed[0]!.test_step.slice(0, 3),
    }]
    expect(analyzeCaseStructure(single as any).violations.filter((v) => v.type === "mixed_upload_type")).toHaveLength(0)

    const directive = buildRegroupDirective({ violations: [], warnings: [], coverage_gaps: [] }, analyzeCaseStructure(mixed as any))
    expect(directive.some((l) => l.includes("上注类型拆分"))).toBe(true)

    // 修复通道:不做确定性拆分,残留如实上报
    const repair = repairCaseStructure([JSON.parse(JSON.stringify(mixed[0]))] as any, {})
    expect(repair.residual_structure_violations.some((v) => v.type === "mixed_upload_type")).toBe(true)
  })
})

describe("2026-09-02 回归:触发外部中断 电平参数映射 + 中断号净化(SpaceWire 取证)", () => {
  // 真实 UserKeyword 形态:doc 只引用 ${para3}/${para1},电平在 ${para2} 注释枚举中
  const triggerIrq = keyword({
    keywordName: "触发外部中断",
    description: "第${time}秒，${para3}外部中断${para1}",
    argumentNames: ["${time}", "${para1}", "${para2}", "${para3}"],
    argumentComments: [
      "执行时间",
      "参数1：中断号:0~4",
      "参数2：电平：HIGH:上升沿; LOW:下降沿",
      "参数3：循环时间，单位秒，小于等于0时，触发一次或停止触发；[0:;其他:以${para3}为周期;]",
    ],
  })
  const map = new Map([["触发外部中断", triggerIrq]])

  function translate(desc: string) {
    const result = translateStandardizedCaseToCombined(
      {
        case_name: "Spacewire上注测试",
        test_purpose: "验证上注触发。",
        covered_tr_items: ["TR-GN-SWRC-001"],
        test_step: [{ 步骤描述: desc, 预期结果: "软件触发Spacewire接收中断。", operation_type: "trigger_output", temporal: "第3.2秒" }],
      } as any,
      map,
    )
    return result.steps[0]!
  }
  const valueOf = (step: any, name: string) =>
    String((step.parameter || []).find((p: any) => p.Name === name)?.Value)

  test("低电平注记:para2 映射 下降沿,para1 中断号净化为纯数字", () => {
    const step = translate("第3.2秒，触发外部中断2（低电平）。")
    expect(step.key_name).toBe("触发外部中断")
    expect(valueOf(step, "${para2}")).toBe("下降沿")
    expect(valueOf(step, "${para1}")).toBe("2")
    expect(valueOf(step, "${para3}")).toBe("0")
  })

  test("高电平注记:para2 映射 上升沿", () => {
    const step = translate("第5.2秒，触发外部中断3（高电平）。")
    expect(valueOf(step, "${para2}")).toBe("上升沿")
    expect(valueOf(step, "${para1}")).toBe("3")
  })

  test("步骤不带电平注记时,从中断上下文语料(触发方式列)兜底映射 para2=下降沿(2026-09-10 取证)", () => {
    const irqTable = "表2-4 中断使用说明：<table><tr><td>外部中断2（IO6）</td><td>26</td><td>随机（频繁）</td><td>低电平</td><td>spacewire总线中断</td></tr></table>"
    const withCorpus = translateStandardizedCaseToCombined(
      {
        case_name: "Spacewire上注测试",
        test_purpose: "验证上注触发。",
        covered_tr_items: ["TR-GN-SWRC-001"],
        test_step: [{ 步骤描述: "第4.2秒，触发外部中断2。", 预期结果: "软件触发Spacewire接收中断。", operation_type: "trigger_output", temporal: "第4.2秒" }],
      } as any,
      map,
      [],
      undefined,
      irqTable,
    )
    expect(valueOf(withCorpus.steps[0]!, "${para2}")).toBe("下降沿")
    expect(valueOf(withCorpus.steps[0]!, "${para1}")).toBe("2")
    // 对照:不传语料时保留占位(不误填)
    const without = translateStandardizedCaseToCombined(
      {
        case_name: "Spacewire上注测试",
        test_purpose: "验证上注触发。",
        covered_tr_items: ["TR-GN-SWRC-001"],
        test_step: [{ 步骤描述: "第4.2秒，触发外部中断2。", 预期结果: "软件触发Spacewire接收中断。", operation_type: "trigger_output", temporal: "第4.2秒" }],
      } as any,
      map,
    )
    expect(valueOf(without.steps[0]!, "${para2}")).toBe("{para2}")
  })

  test("无电平注记:para2 保留 {para2} 占位不误填", () => {
    const step = translate("第7.2秒，触发外部中断1。")
    expect(valueOf(step, "${para2}")).toBe("{para2}")
    expect(valueOf(step, "${para1}")).toBe("1")
  })
})

describe("2026-09-02 回归:发送载荷尾段捕获(doc 字面与步骤措辞失配时不再合成标签)", () => {
  // 真实 UserKeyword 形态:发送SPI-TXT数据 的 doc 字面"发送SPI数据为"与
  // 步骤措辞"通过SPI总线发送…"不一致,模板恒失配——载荷须取实际发送尾段
  const spiTxt = keyword({
    keywordName: "发送SPI-TXT数据",
    description: "第${time}秒，发送SPI数据为${para1}",
    argumentNames: ["${time}", "${para1}", "${para2}"],
    argumentComments: [
      "执行时间",
      "参数1：数据文件，文件内容为十六进制数据，每个字节空格隔开，XX为随机数，SUM为校验和",
      "参数2：循环时间，单位秒，无参数3只发送当前一次；-1为停止发送",
    ],
  })

  test("SPI 应答步骤:para1 绑实际载荷(站地址+应答名+情况),desc 按载荷渲染", () => {
    const result = translateStandardizedCaseToCombined(
      {
        case_name: "SPI机构控制指令应答测试",
        test_purpose: "验证应答处理。",
        covered_tr_items: ["TR-JK-011"],
        test_step: [{
          步骤描述: "第3.1秒，通过SPI总线发送站地址5BH的机构控制指令应答（全部字段正确）。",
          预期结果: "软件正常处理应答，SPI错误应答计数TMYN229保持0。",
        }],
      } as any,
      new Map([["发送SPI-TXT数据", spiTxt]]),
    )
    const step = result.steps[0]!
    expect(step.key_name).toBe("发送SPI-TXT数据")
    const para1 = (step.parameter || []).find((p) => p.Name === "${para1}")!
    expect(String(para1.Value)).toBe("站地址5BH的机构控制指令应答（全部字段正确）")
    expect(step.step_desc).toContain("发送SPI数据为站地址5BH的机构控制指令应答（全部字段正确）")
  })

  test("载荷捕获锚定『通过X总线发送』动作从句:预期半句的『经X总线…发送…』不误捕获", () => {
    // 内存写步骤(file 语义参数):desc 无发送动作,预期半句含"经SPI总线…发送"
    // ——锚定从句确保不把预期半句的发送对象绑成数据文件参数
    const mem32 = keyword({
      keywordName: "设置32位地址数据",
      description: "第${time}秒，设置内存地址${para1}的数据为“${para2}”",
      argumentNames: ["${time}", "${para1}", "${para2}"],
      argumentComments: ["执行时间", "参数1：起始地址，十六进制", "参数2：数据或文件，文件类型包括txt和bin"],
    })
    const result = translateStandardizedCaseToCombined(
      {
        case_name: "上注起始块测试",
        test_purpose: "验证上注接收。",
        covered_tr_items: ["TR-GN-SWRC-001"],
        test_step: [{
          步骤描述: "第3.0秒，设置内存地址21142000H的数据为管控程序上注起始块·全部字段正确。",
          预期结果: "软件读取后经SPI总线A向单板发送机构控制指令。",
        }],
      } as any,
      new Map([["设置32位地址数据", mem32]]),
    )
    const para2 = (result.steps[0]!.parameter || []).find((p) => p.Name === "${para2}")!
    expect(String(para2.Value)).toContain("管控程序上注起始块")
    expect(String(para2.Value)).not.toContain("机构控制指令")
  })
})

describe("2026-09-08 回归:FPGA状态遥测主体豁免混指令(同案多帧轮询编排)", () => {
  const fpgaCase = {
    case_name: "FPGA状态遥测采集测试",
    test_purpose: "验证FPGA状态遥测位域映射。",
    covered_tr_items: ["TR-GN-FPGACJ-001"],
    test_step: [
      { 步骤描述: "第3.0秒，设置内存地址21143004H的数据为0x78123456。", 预期结果: "内存地址21143004H的数据设置成功。" },
      { 步骤描述: "第3.5秒，设置内存地址21120028H的数据为0xF1F2F3F4。", 预期结果: "内存地址21120028H的数据设置成功。" },
      { 步骤描述: "第4.0秒，通过CANA总线发送遥测帧1轮询控制序列。", 预期结果: "遥测帧1参数W58为0x12、W59为0x34、W60为0x56。" },
      { 步骤描述: "第5.0秒，通过CANA总线发送遥测帧3轮询控制序列。", 预期结果: "遥测帧3参数W156为0xF2、W157为0xF3。" },
    ],
  }

  test("FPGA状态遥测主体用例:帧1+帧3轮询同案编排不判 mixed_instruction", () => {
    const violations = analyzeCaseStructure([fpgaCase as any]).violations
    expect(violations.filter((v) => v.type === "mixed_instruction")).toHaveLength(0)
  })

  test("非 FPGA状态遥测主体的同形态用例仍被判混指令(豁免不外溢)", () => {
    const plain = { ...fpgaCase, case_name: "遥测轮询测试", test_purpose: "验证遥测轮询。" }
    const violations = analyzeCaseStructure([plain as any]).violations
    expect(violations.some((v) => v.type === "mixed_instruction")).toBe(true)
  })
})

describe("2026-09-08 回归:P1 幽灵指令护栏 / P2 蒸发与下标 / P3 矛盾消解(日志取证报告修复)", () => {
  test("P1:计数器名'管理遥控指令正确指令计数'不再被抽成幽灵指令短语", () => {
    const cases = [
      {
        case_name: "遥控指令计数测试",
        test_purpose: "验证遥控指令计数。",
        covered_tr_items: ["TR-JK-006"],
        test_step: [
          { 步骤描述: "第3.0秒,通过CANA总线发送正确的10字节遥控指令。", 预期结果: "管理遥控指令正确指令计数加1。" },
        ],
      },
      {
        case_name: "内存读出指令测试",
        test_purpose: "验证内存读出。",
        covered_tr_items: ["TR-JK-007"],
        test_step: [
          { 步骤描述: "第4.0秒,通过CANA总线发送正确的内存读出指令。", 预期结果: "管理遥控指令正确指令计数保持。" },
        ],
      },
    ]
    const aggregation = analyzeCaseAggregation(cases as any, ["TR-JK-006", "TR-JK-007"])
    // 此前:两用例预期半区的计数器名被抽成同一幽灵短语"管理遥控指令正确指令"
    // → 误报"指令被拆散在2个用例" → regroup_directive 照抄成不可执行指令
    expect(aggregation.violations.filter((v) => v.instruction_phrase.includes("正确指令") || v.instruction_phrase.includes("计数"))).toHaveLength(0)
    // 对照:真实共享指令仍正常聚合检出
    const real = [
      { ...cases[0]!, test_step: [{ 步骤描述: "第3.0秒,通过CANA总线发送正确的10字节遥控指令。", 预期结果: "正常。" }] },
      { ...cases[1]!, test_step: [{ 步骤描述: "第4.0秒,通过CANA总线发送10字节遥控指令（LENGTH错误）。", 预期结果: "丢弃。" }] },
    ]
    expect(analyzeCaseAggregation(real as any, ["TR-JK-006", "TR-JK-007"]).violations.length).toBeGreaterThan(0)
  })

  test("P2a:被牵连但无法归桶的用例原样保留,不再静默蒸发(persisted_case_count=0 机理)", () => {
    const cases = [
      {
        case_name: "轮询用例",
        test_purpose: "验证轮询。",
        covered_tr_items: ["TR-A"],
        test_step: [
          { 步骤描述: "第3.0秒,通过CANA总线发送遥测帧1轮询控制序列。", 预期结果: "返回遥测。" },
        ],
      },
      {
        case_name: "无请求步骤用例",
        test_purpose: "验证输出。",
        covered_tr_items: ["TR-B"],
        test_step: [
          { 步骤描述: "第5.0秒,通过CANA总线返回遥测帧1轮询应答数据。", 预期结果: "应答正确。" },
        ],
      },
    ]
    const repair = repairCaseStructure([JSON.parse(JSON.stringify(cases[0])), JSON.parse(JSON.stringify(cases[1]))] as any, {})
    // 此前:两用例共享短语被聚合牵连,但第二用例无请求动词步骤建不出桶 → 整条蒸发
    expect(repair.cases.some((c) => String(c.case_name) === "无请求步骤用例")).toBe(true)
    expect(repair.actions.some((a) => a.includes("保留原用例"))).toBe(true)
  })

  test("P2b:结构违规携带 case_index,同名用例不再错位牵连", () => {
    const cases = [
      {
        case_name: "Spacewire上注处理测试",
        test_purpose: "验证上注。",
        covered_tr_items: ["TR-GN-SWRC-001"],
        test_step: [
          { 步骤描述: "第3.0秒，设置内存地址21142000H的数据为管控程序上注起始块·全部字段正确。", 预期结果: "接收。" },
          { 步骤描述: "第4.0秒，设置内存地址21142000H的数据为二级节点上注数据块·全部字段正确。", 预期结果: "接收。" },
        ],
      },
      {
        case_name: "Spacewire上注处理测试",
        test_purpose: "验证二级节点上注。",
        covered_tr_items: ["TR-GN-SWRC-002"],
        test_step: [
          { 步骤描述: "第6.0秒，设置内存地址21142000H的数据为二级节点上注数据块·全部字段正确。", 预期结果: "接收。" },
        ],
      },
    ]
    const analysis = analyzeCaseStructure(cases as any)
    const mixed = analysis.violations.filter((v) => v.type === "mixed_upload_type")
    expect(mixed.length).toBeGreaterThan(0)
    // 违规归属第一个用例(管控/二级节点混排的那个),下标精确为 0
    expect(mixed.every((v) => v.case_index === 0)).toBe(true)
  })

  test("P3:mixed_upload_type 拆分用例优先,涉及用例的聚合违规让位;无关聚合违规保留", () => {
    const aggregation = {
      violations: [
        { instruction_phrase: "上注数据块", case_names: ["管控案", "二级节点案"], covered_tr_items: [], message: "须聚合" },
        { instruction_phrase: "内存读出指令", case_names: ["甲案", "乙案"], covered_tr_items: [], message: "须聚合" },
      ],
      warnings: [],
      coverage_gaps: [],
    } as any
    const structure = analyzeCaseStructure([
      {
        case_name: "管控案",
        test_purpose: "验证管控上注。",
        covered_tr_items: ["TR-GN-SWRC-001"],
        test_step: [
          { 步骤描述: "第3.0秒，设置内存地址21142000H的数据为管控程序上注起始块·全部字段正确。", 预期结果: "接收。" },
          { 步骤描述: "第4.0秒，设置内存地址21142000H的数据为二级节点上注数据块·全部字段正确。", 预期结果: "接收。" },
        ],
      },
    ] as any)
    const reconciled = suppressContradictoryAggregation(aggregation, structure)
    expect(reconciled.violations.map((v) => v.instruction_phrase)).toEqual(["内存读出指令"])
  })
})

describe("2026-09-17 回归:混总线门禁对功能测试合并样例生效(用户取证)", () => {
  test("A/B 总线合并在一个用例 → mixed_bus 触发(轮询指令接收处理功能测试实测样例)", () => {
    const merged = {
      case_name: "遥测帧1轮询控制序列处理测试",
      test_purpose: "验证遥测帧1轮询控制序列接收处理。",
      covered_tr_items: ["TR-GN-TM-001"],
      test_step: [
        { 步骤描述: "第3.0秒，通过CANA总线发送正确的遥测帧1轮询控制序列。", 预期结果: "软件向卫星星务发送遥测帧1参数。" },
        { 步骤描述: "第5.0秒，通过CANB总线发送正确的遥测帧1轮询控制序列。", 预期结果: "软件向卫星星务发送遥测帧1参数。" },
      ],
    }
    const v = analyzeCaseStructure([merged])
    expect(v.violations.filter((x) => x.type === "mixed_bus")).toHaveLength(1)
  })

  test("同一指令的 CANA/CANB 分属两个用例 → suite级覆盖通过", () => {
    const cases = ["CANA", "CANB"].map((bus) => ({
      case_name: `开关指令${bus}总线接收处理测试`,
      test_purpose: `验证${bus}总线开关指令接收处理。`,
      test_step: [
        { 步骤描述: `第3.0秒，通过${bus}总线发送正确的开关指令。`, 预期结果: "软件正确处理。" },
      ],
    }))
    const result = analyzeCaseStructure(cases, { requiredPrimaryBuses: ["CANA", "CANB"] })
    expect(result.violations.some((v) => v.type === "missing_bus_counterpart")).toBe(false)
    expect(result.violations.some((v) => v.type === "mixed_bus")).toBe(false)
  })

  test("只有 CANA 用例时 → 缺少 CANB 对应案", () => {
    const result = analyzeCaseStructure([
      {
        case_name: "开关指令CANA总线接收处理测试",
        test_step: [
          { 步骤描述: "第3.0秒，通过CANA总线发送正确的开关指令。", 预期结果: "软件正确处理。" },
        ],
      },
    ], { requiredPrimaryBuses: ["CANA", "CANB"] })
    const violation = result.violations.find((v) => v.type === "missing_bus_counterpart")
    expect(violation?.message).toContain("缺少 CANB")
  })

  test("只写泛化 CAN 时 → 不得视为已覆盖 CANA/CANB", () => {
    const result = analyzeCaseStructure([
      {
        case_name: "开关指令接收处理测试",
        test_step: [
          { 步骤描述: "第3.0秒，通过CAN总线发送正确的开关指令。", 预期结果: "软件正确处理。" },
        ],
      },
    ], { requiredPrimaryBuses: ["CANA", "CANB"] })
    const violation = result.violations.find((v) => v.type === "missing_bus_counterpart")
    expect(violation?.message).toContain("缺少 CANA/CANB")
  })
})

describe("双辅助数据包统一有序发送规则", () => {
  test("正确包1→包1错误→包2剩余错误→正确包2不被通用恢复门禁误拆", () => {
    const result = analyzeCaseStructure([
      {
        case_name: "CANA总线卫星服务系统辅助数据双包接收处理测试",
        test_purpose: "验证每秒两包辅助数据的正确处理与字段错误拒收。",
        test_step: [
          { 步骤描述: "第3.0秒，通过CANA总线发送完整正确的辅助数据包第1包。", 预期结果: "软件处理并转发，正确计数为1。" },
          { 步骤描述: "第4.0秒，通过CANA总线发送辅助数据包第1包（首帧仲裁场错误，其余字段正确）。", 预期结果: "软件不处理，正确计数保持为1。" },
          { 步骤描述: "第5.0秒，通过CANA总线发送辅助数据包第2包（中间帧控制场错误，其余字段正确）。", 预期结果: "软件不处理，正确计数保持为1。" },
          { 步骤描述: "第6.0秒，通过CANA总线发送辅助数据包第2包（尾帧SUM错误，其余字段正确）。", 预期结果: "软件不处理，正确计数保持为1。" },
          { 步骤描述: "第7.0秒，通过CANA总线发送完整正确的辅助数据包第2包。", 预期结果: "软件处理并转发，正确计数为2。" },
        ],
      },
    ], { functionalTwoAuxiliaryPackets: true })

    expect(result.violations.filter((v) =>
      v.type === "mixed_instruction"
      || v.type === "missing_correct_after_error"
      || v.type === "invalid_auxiliary_interleave"
    )).toHaveLength(0)
  })

  test("未发送正确末包被多包门禁拒绝，不套用普通同包恢复", () => {
    const result = analyzeCaseStructure([
      {
        case_name: "CANA总线卫星服务系统辅助数据双包接收处理测试",
        test_step: [
          { 步骤描述: "第3.0秒，通过CANA总线发送完整正确的辅助数据包第1包。", 预期结果: "正确计数为1。" },
          { 步骤描述: "第4.0秒，通过CANA总线发送辅助数据包第1包（首帧仲裁场错误，其余字段正确）。", 预期结果: "正确计数保持为1。" },
          { 步骤描述: "第5.0秒，通过CANA总线发送辅助数据包第2包（首帧仲裁场错误，其余字段正确）。", 预期结果: "正确计数保持为1。" },
        ],
      },
    ], { functionalTwoAuxiliaryPackets: true })

    expect(result.violations.some((v) => v.type === "missing_correct_after_error")).toBe(false)
    expect(result.violations.some((v) => v.type === "invalid_auxiliary_interleave")).toBe(true)
  })

  test("正常包结束后追加错误被多包门禁拒绝", () => {
    const result = analyzeCaseStructure([
      {
        case_name: "CANA总线卫星服务系统辅助数据双包接收处理测试",
        test_step: [
          { 步骤描述: "第3.0秒，通过CANA总线发送完整正确的辅助数据包第1包。", 预期结果: "正确计数为1。" },
          { 步骤描述: "第4.0秒，通过CANA总线发送完整正确的辅助数据包第2包。", 预期结果: "正确计数为2。" },
          { 步骤描述: "第5.0秒，通过CANA总线发送辅助数据包第1包（首帧仲裁场错误，其余字段正确）。", 预期结果: "正确计数保持为2。" },
          { 步骤描述: "第6.0秒，通过CANA总线发送辅助数据包第2包（首帧仲裁场错误，其余字段正确）。", 预期结果: "正确计数保持为2。" },
        ],
      },
    ], { functionalTwoAuxiliaryPackets: true })

    expect(result.violations.some((v) => v.type === "invalid_auxiliary_interleave")).toBe(true)
  })
})

describe("2026-09-20 回归:内存读出地址语义与轮询前置时序", () => {
  const memoryRange = [{ lower: "0x10000000", upper: "0x10000014" }]

  test("非4字节对齐地址被当作正确指令处理时拒绝", () => {
    const result = analyzeCaseStructure([
      {
        case_name: "CANA内存读出指令字段错误测试",
        test_step: [
          {
            步骤描述: "第3.0秒，通过CANA总线发送正确的内存读出指令，指令中绝对地址为0x10000002。",
            预期结果: "软件将地址对齐后正确接收，更新内存读出数据，正确指令计数加1。",
          },
        ],
      },
    ], { functionalMemoryReadRanges: memoryRange })

    expect(result.violations.some((v) => v.type === "invalid_memory_read_alignment")).toBe(true)
    expect(result.violations.some((v) => v.type === "invalid_memory_read_scenarios")).toBe(true)
  })

  test("实际生成句式“地址W0~W3为”可按数值解析，不受前导0影响", () => {
    const result = analyzeCaseStructure([
      {
        case_name: "CANA内存读出指令地址边界测试",
        test_step: [
          { 步骤描述: "第3.0秒，通过CANA总线发送内存读出指令（地址W0~W3为0x0FFFFFFF）。", 预期结果: "按错误指令处理。" },
          { 步骤描述: "第4.0秒，通过CANA总线发送内存读出指令（地址W0~W3为0x10000000）。", 预期结果: "正常处理。" },
          { 步骤描述: "第5.0秒，通过CANA总线发送内存读出指令（地址W0~W3为0x10000001）。", 预期结果: "按错误指令处理。" },
          { 步骤描述: "第6.0秒，通过CANA总线发送内存读出指令（地址W0~W3为0x10000008）。", 预期结果: "正常处理。" },
          { 步骤描述: "第7.0秒，通过CANA总线发送内存读出指令（地址W0~W3为0x10000013）。", 预期结果: "按错误指令处理。" },
          { 步骤描述: "第8.0秒，通过CANA总线发送内存读出指令（地址W0~W3为0x10000014）。", 预期结果: "正常处理。" },
          { 步骤描述: "第9.0秒，通过CANA总线发送内存读出指令（地址W0~W3为0x10000015）。", 预期结果: "按错误指令处理。" },
        ],
      },
    ], { functionalMemoryReadRanges: memoryRange })

    expect(result.violations.some((v) => v.type === "incomplete_memory_read_boundary")).toBe(false)
  })

  test("“地址W0~W3为”的非对齐值被当作正确指令时拒绝", () => {
    const result = analyzeCaseStructure([
      {
        case_name: "CANA内存读出指令字段错误测试",
        test_step: [
          {
            步骤描述: "第3.0秒，通过CANA总线发送内存读出指令（地址W0~W3为0x10000013，其余字段正确）。",
            预期结果: "软件正确接收并更新内存读出数据，正确指令计数加1。",
          },
        ],
      },
    ], { functionalMemoryReadRanges: memoryRange })
    expect(result.violations.some((v) => v.type === "invalid_memory_read_alignment")).toBe(true)
  })

  test("完整边界集+恢复步骤通过地址专属门禁", () => {
    const result = analyzeCaseStructure([
      {
        case_name: "CANA内存读出指令地址边界测试",
        test_step: [
          { 步骤描述: "第3.0秒，通过CANA总线发送内存读出指令（地址越界错误），指令中绝对地址为0x0FFFFFFF。", 预期结果: "按错误指令处理。" },
          { 步骤描述: "第4.0秒，通过CANA总线发送正确的内存读出指令，指令中绝对地址为0x10000000。", 预期结果: "正常处理。" },
          { 步骤描述: "第5.0秒，通过CANA总线发送内存读出指令（地址非4字节对齐错误），指令中绝对地址为0x10000001。", 预期结果: "按错误指令处理。" },
          { 步骤描述: "第6.0秒，通过CANA总线发送正确的内存读出指令，指令中绝对地址为0x10000008。", 预期结果: "正常处理。" },
          { 步骤描述: "第7.0秒，通过CANA总线发送内存读出指令（地址非4字节对齐错误），指令中绝对地址为0x10000013。", 预期结果: "按错误指令处理。" },
          { 步骤描述: "第8.0秒，通过CANA总线发送正确的内存读出指令，指令中绝对地址为0x10000014。", 预期结果: "正常处理。" },
          { 步骤描述: "第9.0秒，通过CANA总线发送内存读出指令（地址越界错误），指令中绝对地址为0x10000015。", 预期结果: "按错误指令处理。" },
          { 步骤描述: "第10.0秒，通过CANA总线发送正确的内存读出指令，指令中绝对地址为0x10000000。", 预期结果: "恢复正常处理。" },
        ],
      },
      {
        case_name: "CANA内存读出指令字段错误测试",
        test_step: [
          { 步骤描述: "第3.0秒，通过CANA总线发送内存读出指令（仲裁场错误，其余字段正确），指令中绝对地址为0x10000000。", 预期结果: "按错误指令处理。" },
          { 步骤描述: "第4.0秒，通过CANA总线发送正确的内存读出指令，指令中绝对地址为0x10000000。", 预期结果: "恢复正常处理。" },
          { 步骤描述: "第5.0秒，通过CANA总线发送内存读出指令（控制场错误，其余字段正确），指令中绝对地址为0x10000000。", 预期结果: "按错误指令处理。" },
          { 步骤描述: "第6.0秒，通过CANA总线发送正确的内存读出指令，指令中绝对地址为0x10000000。", 预期结果: "恢复正常处理。" },
          { 步骤描述: "第7.0秒，通过CANA总线发送内存读出指令（LENGTH错误，其余字段正确），指令中绝对地址为0x10000000。", 预期结果: "按错误指令处理。" },
          { 步骤描述: "第8.0秒，通过CANA总线发送正确的内存读出指令，指令中绝对地址为0x10000000。", 预期结果: "恢复正常处理。" },
          { 步骤描述: "第9.0秒，通过CANA总线发送内存读出指令（TITLE错误，其余字段正确），指令中绝对地址为0x10000000。", 预期结果: "按错误指令处理。" },
          { 步骤描述: "第10.0秒，通过CANA总线发送正确的内存读出指令，指令中绝对地址为0x10000000。", 预期结果: "恢复正常处理。" },
          { 步骤描述: "第11.0秒，通过CANA总线发送内存读出指令（INDEX错误，其余字段正确），指令中绝对地址为0x10000000。", 预期结果: "按错误指令处理。" },
          { 步骤描述: "第12.0秒，通过CANA总线发送正确的内存读出指令，指令中绝对地址为0x10000000。", 预期结果: "恢复正常处理。" },
          { 步骤描述: "第13.0秒，通过CANA总线发送内存读出指令（SUM错误，其余字段正确），指令中绝对地址为0x10000000。", 预期结果: "按错误指令处理。" },
          { 步骤描述: "第14.0秒，通过CANA总线发送正确的内存读出指令，指令中绝对地址为0x10000000。", 预期结果: "恢复正常处理。" },
          { 步骤描述: "第15.0秒，通过CANA总线发送内存读出指令（地址非4字节对齐错误，其余字段正确），指令中绝对地址为0x10000002。", 预期结果: "按错误指令处理。" },
          { 步骤描述: "第16.0秒，通过CANA总线发送正确的内存读出指令，指令中绝对地址为0x10000000。", 预期结果: "恢复正常处理。" },
        ],
      },
    ], { functionalMemoryReadRanges: memoryRange })

    expect(result.violations.some((v) =>
      v.type === "invalid_memory_read_alignment"
      || v.type === "invalid_memory_read_scenarios"
      || v.type === "incomplete_memory_read_boundary"
    )).toBe(false)
  })

  test("周期内存读出前置+每次2秒后轮询不被混指令门禁误拆", () => {
    const result = analyzeCaseStructure([
      {
        case_name: "CANA内存数据轮询接收处理测试",
        test_step: [
          { 步骤描述: "第3.0秒，通过CANA总线以5秒为周期循环发送正确的内存读出指令。", 预期结果: "软件正确接收。" },
          { 步骤描述: "第5.0秒，通过CANA总线发送正确的内存数据轮询控制序列。", 预期结果: "组帧返回内存读出数据。" },
          { 步骤描述: "第10.0秒，通过CANA总线发送内存数据轮询控制序列（TITLE错误，其余字段正确）。", 预期结果: "不处理且不返回数据。" },
          { 步骤描述: "第15.0秒，通过CANA总线发送正确的内存数据轮询控制序列。", 预期结果: "组帧返回内存读出数据。" },
        ],
      },
    ], { functionalMemoryPollingPrerequisite: true })

    expect(result.violations.some((v) =>
      v.type === "mixed_instruction" || v.type === "invalid_memory_polling_schedule"
    )).toBe(false)
  })

  test("用内存初始化代替前置指令、轮询从3秒开始时拒绝", () => {
    const result = analyzeCaseStructure([
      {
        case_name: "CANA内存数据轮询接收处理测试",
        test_step: [
          { 步骤描述: "第1.0秒，设置软件内存中待读出数据。", 预期结果: "设置完成。" },
          { 步骤描述: "第3.0秒，通过CANA总线发送正确的内存数据轮询控制序列。", 预期结果: "返回数据。" },
        ],
      },
    ], { functionalMemoryPollingPrerequisite: true })

    expect(result.violations.some((v) => v.type === "invalid_memory_polling_schedule")).toBe(true)
  })
})
