import { describe, expect, test } from "bun:test"
import {
  buildRequirementIndex,
  findCrossRequirementContext,
  getStressProtocolContextGaps,
  preparePhase6InputFromFlat,
  type PreparedPhase6Requirement,
} from "../../src/shared/test-requirements"

function requirement(id: string, fields: Partial<PreparedPhase6Requirement> = {}): PreparedPhase6Requirement {
  return {
    requirement_id: id,
    source_requirement_ids: [id],
    title: id,
    title_no: "4.1",
    path: "/4/1/",
    category_key: "GN",
    chapter_title: "功能测试",
    chapter_background: "",
    test_type: "functional",
    priority: "medium",
    handling: "",
    name: id,
    sufficiency: null,
    test_method: "",
    pass_criteria: "",
    inputFlow: "无。",
    outputFlow: "无。",
    ...fields,
  }
}

describe("强度测试按当前需求集合补全协议上下文", () => {
  test("从长 processing/handling 枚举中关联所有实际流，不受短候选截断影响", () => {
    const stress = requirement("TR-QD-001", {
      test_type: "stress",
      handling: [
        "a、以1s为周期通过一级CAN总线发送辅助数据包1、辅助数据包2及星务时间广播数据；",
        "b、通过一级CAN总线随机发送72字节上行数据块、249字节上行数据块、内存读出指令及内存数据轮询控制序列；",
        "c、通过spacewire总线随机输入正确、错误的管控程序上注数据块、二级节点程序上注数据块；",
        "d、通过二级CAN总线设置正确、错误的遥测数据；",
        "e、通过SPI总线设置正确、错误的机构控制指令应答、电机遥测数据、黑体遥测数据。",
      ].join("\n"),
    })
    const flows = [
      "辅助数据包1", "辅助数据包2", "星务时间广播", "72字节上行数据块", "249字节上行数据块",
      "内存读出指令", "内存数据轮询控制序列", "Spacewire管控程序上注数据块", "Spacewire二级节点程序上注数据块",
      "二级CAN遥测数据", "SPI机构控制指令应答", "SPI电机遥测数据", "SPI黑体遥测数据",
    ]
    const protocols = flows.map((name, index) => requirement(`TR-JK-${index}`, {
      inputFlow: `#### 4.1.${index + 1} ${name}数据流\n仅此协议定义：字段-${index}。`,
    }))
    const result = findCrossRequirementContext(stress, [stress, ...protocols])
    expect(result?.upstream_flows.map((flow) => flow.requirement_id)).toEqual(protocols.map((r) => r.requirement_id))
    expect(result?.upstream_flows[4].inputFlow).toContain("249字节上行数据块")
    expect(result?.upstream_flows[4].inputFlow).toContain("字段-4")
  })

  test("仅补充匹配协议节，同时保留首中尾帧嵌套格式", () => {
    const stress = requirement("TR-QD-001", { test_type: "stress", handling: "发送249字节上行数据块。" })
    const protocol = requirement("TR-JK-001", {
      inputFlow: [
        "### 4.1.1 249字节上行数据块数据流",
        "本次完整传输共3包。",
        "#### 4.1.1.1 首帧格式", "仲裁场、控制场、INDEX。",
        "#### 4.1.1.2 尾帧格式", "SUM。",
        "### 4.1.2 无关视频注入数据流", "不得注入的无关协议内容。",
      ].join("\n"),
    })
    const result = findCrossRequirementContext(stress, [stress, protocol])
    expect(result?.upstream_flows).toHaveLength(1)
    expect(result?.upstream_flows[0].inputFlow).toContain("共3包")
    expect(result?.upstream_flows[0].inputFlow).toContain("尾帧格式\nSUM")
    expect(result?.upstream_flows[0].inputFlow).not.toContain("无关")
  })

  test("同名遥测只按明确通道关联，不能由通道名导入整库", () => {
    const stress = requirement("TR-QD-001", { test_type: "stress", handling: "通过SPI总线设置正确、错误的遥测数据。" })
    const spi = requirement("TR-SPI", { inputFlow: "#### SPI遥测数据流\nSPI协议。" })
    const can = requirement("TR-CAN", { inputFlow: "#### 二级CAN遥测数据流\nCAN协议。" })
    const unrelated = requirement("TR-SPI-OTHER", { inputFlow: "#### SPI相机参数配置数据流\n相机协议。" })
    const generic = requirement("TR-GENERIC", { inputFlow: "#### 遥测数据流\n不明确所属接口。" })
    expect(findCrossRequirementContext(stress, [stress, spi, can, unrelated, generic])?.upstream_flows.map((f) => f.requirement_id))
      .toEqual(["TR-SPI"])
  })

  test("未提及流名、共享中断表或仅重复自身不构成关联依据", () => {
    const stress = requirement("TR-QD-001", {
      test_type: "stress",
      handling: "持续运行25小时，检查系统状态。",
      interruptContext: "Spacewire管控程序上注数据块外部中断2。",
    })
    const protocol = requirement("TR-JK-001", { inputFlow: "#### Spacewire管控程序上注数据块数据流\n协议。" })
    expect(findCrossRequirementContext(stress, [stress, protocol])).toBeNull()
    const selfWithInput = { ...stress, inputFlow: "#### 249字节上行数据块数据流\n协议。" }
    expect(findCrossRequirementContext(selfWithInput, [selfWithInput])).toBeNull()
  })

  test("当前需求集合没有协议定义时返回缺失，不推测包数或读其他项目", () => {
    const stress = requirement("TR-QD-001", { test_type: "stress", handling: "发送249字节上行数据块及辅助数据包1、辅助数据包2。" })
    const other = requirement("TR-BJ-001", { handling: "249字节上行数据块中程序编号范围为[0x9,0x32]。" })
    expect(findCrossRequirementContext(stress, [stress, other])).toBeNull()
  })

  test("既有非强度前置输入匹配行为保持不变", () => {
    const memoryPoll = requirement("TR-POLL", { chapter_background: "先通过CANA总线发送内存读出指令，再发送轮询指令。" })
    const memoryRead = requirement("TR-READ", { inputFlow: "#### 4.1.1 内存读出指令数据流\n地址字段。" })
    expect(findCrossRequirementContext(memoryPoll, [memoryPoll, memoryRead])?.upstream_flows[0].requirement_id).toBe("TR-READ")
  })

  test("需求索引和生成使用相同协议来源，无来源时不制造 protocolContext", () => {
    const artifact = {
      funItem: [
        { funId: ["TR-QD-001"], title: "强度", test_type: "强度测试", inputFlowContext: "无。", processingContext: "发送249字节上行数据块。" },
        { funId: ["TR-JK-001"], title: "协议", test_type: "接口测试", inputFlowContext: "#### 4.1 249字节上行数据块数据流\n首帧INDEX，尾帧SUM。" },
      ],
    }
    const prepared = preparePhase6InputFromFlat(artifact).requirements
    const generationContext = findCrossRequirementContext(prepared[0], prepared)
    expect(buildRequirementIndex(artifact).get("TR-QD-001")?.protocolContext).toBe(JSON.stringify(generationContext, null, 2))
    expect(buildRequirementIndex(artifact).get("TR-QD-001")?.contextGaps).toBeUndefined()
    expect(buildRequirementIndex(artifact).get("TR-JK-001")?.protocolContext).toBeUndefined()
    const missingSource = buildRequirementIndex({ funItem: artifact.funItem.slice(0, 1) }).get("TR-QD-001")
    expect(missingSource?.protocolContext).toBeUndefined()
    expect(missingSource?.contextGaps).toEqual(getStressProtocolContextGaps(prepared[0]))
    expect(buildRequirementIndex(artifact).get("TR-JK-001")?.contextGaps).toBeUndefined()
  })

  test("有249引用但无输入协议时报告两个明确缺项；无多包要求不能拦截", () => {
    const stress = requirement("TR-QD-001", { test_type: "stress", handling: "发送249字节上行数据块及辅助数据包1、辅助数据包2。" })
    const gaps = getStressProtocolContextGaps(stress)
    expect(gaps).toHaveLength(2)
    expect(gaps[0]).toContain("249字节上行数据块")
    expect(gaps[0]).toContain("分包规则")
    expect(gaps[1]).toContain("字段定义")
    expect(getStressProtocolContextGaps({ ...stress, handling: "周期发送星务时间广播，运行25小时。" })).toEqual([])
    expect(getStressProtocolContextGaps({ ...stress, test_type: "functional" })).toEqual([])
    expect(getStressProtocolContextGaps({ ...stress, handling: "以多包形式连续上注数据。" })).toHaveLength(2)
  })

  test("匹配来源或自身格式足够，不要求需求预先给定总包数", () => {
    const stress = requirement("TR-QD-001", { test_type: "stress", handling: "发送249字节上行数据块。" })
    const source = requirement("TR-JK-001", { inputFlow: "#### 249字节上行数据块数据流\n首帧INDEX；尾帧SUM。" })
    const cross = findCrossRequirementContext(stress, [stress, source])
    expect(getStressProtocolContextGaps(stress, cross)).toEqual([])
    expect(getStressProtocolContextGaps({
      ...stress,
      handling: "249字节上行数据块使用首帧、中间帧及尾帧；首帧携带INDEX，尾帧包含SUM。传输数据量由测试选择。",
    })).toEqual([])
    expect(getStressProtocolContextGaps({
      ...stress,
      handling: "249字节上行数据块每包最多携带20条指令，首包记录总条数，按指令序号累加直至总条数。",
    })).toEqual([])
    expect(getStressProtocolContextGaps({ ...stress, inputFlow: source.inputFlow })).toEqual([])
  })

  test("无关协议来源及其他工作负载的帧定义不能填补249上下文", () => {
    const stress = requirement("TR-QD-001", {
      test_type: "stress",
      handling: "b、发送249字节上行数据块；\nf、通过SPI总线设置遥测数据，首帧仲裁场、尾帧SUM。",
    })
    const irrelevantContext = { upstream_flows: [{ requirement_id: "TR-SPI", name: "SPI", bus_level: "", inputFlow: "#### SPI遥测数据流\n首帧INDEX，尾帧SUM。" }] }
    expect(getStressProtocolContextGaps(stress, irrelevantContext)).toHaveLength(2)
  })

  test("其他协议正文偶然提到249或只有空标题，不构成249协议来源", () => {
    const stress = requirement("TR-QD-001", { test_type: "stress", handling: "发送249字节上行数据块。" })
    const context = (inputFlow: string) => ({ upstream_flows: [{ requirement_id: "TR-JK", name: "接口", bus_level: "", inputFlow }] })
    expect(getStressProtocolContextGaps(stress, context("#### SPI遥测数据流\nSPI帧结构不同于249字节上行数据块。"))).toHaveLength(2)
    expect(getStressProtocolContextGaps(stress, context("#### 249字节上行数据块数据流\n"))).toHaveLength(2)
    expect(getStressProtocolContextGaps(stress, context("#### 249字节上行数据块数据流\n首帧INDEX，尾帧SUM。"))).toEqual([])
  })

  test("多包引用不能被另一个多包协议补全", () => {
    const stress = requirement("TR-QD-001", { test_type: "stress", handling: "a、甲类数据块按多包发送。\nb、通过SPI总线设置遥测数据。" })
    const context = (name: string) => ({ upstream_flows: [{ requirement_id: "TR-JK", name, bus_level: "", inputFlow: `#### ${name}数据流\n分包结构包含首包和末包。` }] })
    expect(getStressProtocolContextGaps(stress, context("乙类数据块"))).toHaveLength(2)
    expect(getStressProtocolContextGaps(stress, context("SPI遥测"))).toHaveLength(2)
    expect(getStressProtocolContextGaps(stress, context("甲类数据块"))).toEqual([])
  })

  test("首帧及字段测试目标枚举不能冒充格式定义", () => {
    const stress = requirement("TR-QD-001", { test_type: "stress" })
    for (const description of [
      "249字节上行数据块使用多帧发送，应覆盖首帧、中间帧、尾帧。",
      "249字节上行数据块需覆盖首帧、尾帧的INDEX、SUM错误。",
      "249字节上行数据块分包规则为正确错误交替，首帧和尾帧需要覆盖。",
      "249字节上行数据块包序号为有效值，测试首帧所有字段错误。",
    ]) {
      expect(getStressProtocolContextGaps({ ...stress, handling: description })).toHaveLength(2)
    }
    // These are real structure/termination definitions without a fixed count.
    for (const description of [
      "249字节上行数据块首帧携带INDEX，尾帧包含SUM。",
      "249字节上行数据块包序号从0递增，最后一包结束标志为1。",
      "249字节上行数据块总包数由总长度和每包容量确定。",
    ]) {
      expect(getStressProtocolContextGaps({ ...stress, handling: description })).toEqual([])
    }
  })
})
