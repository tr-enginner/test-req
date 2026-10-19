import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  actionChannelOfText,
  buildRequirementStepPlan,
  filterUserKeywordMap,
  scanKeywordDirs,
  scoreKeywordCandidates,
  scoreKeywordCandidatesByAnchor,
  type KeywordMeta,
} from "../src/shared/testcase-keywords"

describe("testcase keyword catalog", () => {
  test("loads keyword json/txt and scores candidates", () => {
    const root = mkdtempSync(join(tmpdir(), "matrix-keywords-"))
    try {
      const keywordDir = join(root, "组合关键字")
      mkdirSync(keywordDir, { recursive: true })
      const jsonPath = join(keywordDir, "UserKeyword.json")
      const txtPath = join(keywordDir, "UserKeyword.txt")

      writeFileSync(
        jsonPath,
        JSON.stringify({
          Items: [
            {
              Name: "发送CANA数据",
              Comments: "第${time}秒,通过CANA总线${para3}发送${para2}",
              Arguments: [
                { Name: "${time}", Comments: "执行时间" },
                { Name: "${para1}", Comments: "参数1" },
              ],
            },
          ],
        }),
        "utf-8",
      )

      writeFileSync(
        txtPath,
        [
          "*** Keywords ***",
          "发送CANA数据",
          "    [Documentation]    第${time}秒,通过CANA总线${para3}发送${para2}",
          "    [Arguments]    ${time}    ${para1}    ${para2}    ${para3}",
        ].join("\n"),
        "utf-8",
      )

      const catalog = scanKeywordDirs([keywordDir])
      expect(catalog.keywordMap.has("发送CANA数据")).toBe(true)
      const keyword = catalog.keywordMap.get("发送CANA数据")!
      expect(keyword.txtSnippet.length).toBeGreaterThan(0)

      const candidates = scoreKeywordCandidates("通过CANA总线发送数据", catalog.keywordMap, 3)
      expect(candidates[0]?.keywordName).toBe("发送CANA数据")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("prefers CAN send keywords over unrelated memory-setting keywords for indirect-instruction requirements", () => {
    const root = mkdtempSync(join(tmpdir(), "matrix-keywords-priority-"))
    try {
      const keywordDir = join(root, "组合关键字")
      mkdirSync(keywordDir, { recursive: true })
      writeFileSync(
        join(keywordDir, "UserKeyword.json"),
        JSON.stringify({
          Items: [
            {
              Name: "发送CANA数据",
              Comments: "第${time}秒,通过CANA总线${para3}发送${para2}",
              Arguments: [
                { Name: "${time}", Comments: "执行时间" },
                { Name: "${para2}", Comments: "参数2：数据协议名称" },
              ],
            },
            {
              Name: "设置内存数据8bit",
              Comments: "设置内存地址${addr}的8bit值为${value}",
              Arguments: [
                { Name: "${addr}", Comments: "内存地址" },
                { Name: "${value}", Comments: "目标值" },
              ],
            },
          ],
        }),
        "utf-8",
      )

      const catalog = scanKeywordDirs([keywordDir])
      const candidates = scoreKeywordCandidates(
        "软件接收到间接指令后，通过总线（CANA或CANB）发送间接指令应答。",
        catalog.keywordMap,
        5,
      )

      expect(candidates[0]?.keywordName).toBe("发送CANA数据")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

function keywordMeta(name: string, description: string): KeywordMeta {
  return {
    keywordName: name,
    description,
    argumentNames: ["${time}", "${para2}", "${para3}"],
    argumentComments: ["执行时间", "数据协议名称", "循环周期"],
    txtSnippet: "",
    sourceJson: "/tmp/Demo.json",
    searchText: [name, description].join("\n"),
  }
}

describe("buildRequirementStepPlan (B1a flat-field step plans)", () => {
  const keywordMap = new Map<string, KeywordMeta>([
    ["发送CANA数据", keywordMeta("发送CANA数据", "第${time}秒,通过CANA总线${para3}发送${para2}")],
    ["发送CANB数据", keywordMeta("发送CANB数据", "第${time}秒,通过CANB总线${para3}发送${para2}")],
  ])

  test("classifies 间接指令 requirement as command_execution and plans CANA send + verify steps", () => {
    const result = buildRequirementStepPlan({
      handling: "软件接收到间接指令后执行相应的处理，并通过CANA总线发送应答。",
      inputFlow: "间接指令。",
      outputFlow: "间接指令应答数据。",
      chapterContent: "接口需求背景。",
      keywordMap,
    })

    expect(result.pattern).toBe("command_execution")
    expect(result.dual_bus_generated).toBe(false)
    expect(result.step_plan).toHaveLength(2)
    expect(result.step_plan[0].purpose).toBe("send_command")
    expect(result.step_plan[0].keyword_name).toBe("发送CANA数据")
    expect(result.step_plan[0].bus_channel).toBe("CANA")
    // 2026-08-20 事故修正:计划不再携带合成参数值(时序时间/流名)——它们与
    // worker 实际步骤文本错位并经 B1a 提示直渲染进套件。计划只保留路由价值。
    expect(result.step_plan[0].argument_bindings).toEqual({})
    expect(result.step_plan[1].purpose).toBe("verify_response")
    expect(result.step_plan[1].argument_bindings).toEqual({})
  })

  test("generates CANB backup steps when the requirement text indicates dual redundancy", () => {
    const result = buildRequirementStepPlan({
      handling: "软件接收到间接指令后执行相应的处理，通过总线（CANA或CANB）发送间接指令应答，CANA与CANB互相备份。",
      inputFlow: "间接指令。",
      outputFlow: "间接指令应答数据。",
      chapterContent: "",
      keywordMap,
    })

    expect(result.pattern).toBe("command_execution")
    expect(result.dual_bus_generated).toBe(true)
    expect(result.step_plan).toHaveLength(4)
    expect(result.step_plan[2].bus_channel).toBe("CANB")
    expect(result.step_plan[2].keyword_name).toBe("发送CANB数据")
  })

  test("classifies 轮询控制序列 as can_communication", () => {
    const result = buildRequirementStepPlan({
      handling: "接收到遥测帧1轮询控制序列后处理。",
      inputFlow: "遥测帧1轮询控制序列。",
      outputFlow: "处理结果。",
      chapterContent: "",
      keywordMap,
    })

    expect(result.pattern).toBe("can_communication")
    expect(result.step_plan.length).toBeGreaterThan(0)
    expect(result.step_plan[0].purpose).toBe("inject_input")
  })

  test("falls back to the minimal general plan for unmatched requirement text", () => {
    const result = buildRequirementStepPlan({
      handling: "对某功能进行测试。",
      inputFlow: "输入数据。",
      outputFlow: "输出结果。",
      chapterContent: "",
      keywordMap,
    })

    expect(result.pattern).toBe("general")
    expect(result.step_plan.length).toBeGreaterThanOrEqual(1)
  })

  test("resolves the send keyword by argument contract when the preferred name is absent", () => {
    // C: the fallback scan must skip a /^发送CANA/ keyword whose arguments
    // cannot carry a data payload and pick the contract-valid one instead.
    const map = new Map<string, KeywordMeta>([
      ["发送CANA指令", { ...keywordMeta("发送CANA指令", "第${time}秒,发送CANA指令${para2}"), argumentComments: ["执行时间", "指令码", "循环周期"] }],
      ["发送CANATXT数据", { ...keywordMeta("发送CANATXT数据", "第${time}秒,通过CANA总线${para3}发送${para2}"), argumentComments: ["执行时间", "参数2：数据文件", "参数3：循环时间"] }],
    ])

    const result = buildRequirementStepPlan({
      handling: "软件接收到间接指令后执行相应的处理，并通过CANA总线发送应答。",
      inputFlow: "间接指令。",
      outputFlow: "间接指令应答数据。",
      chapterContent: "",
      keywordMap: map,
    })

    expect(result.step_plan[0].keyword_name).toBe("发送CANATXT数据")
  })

  test("leaves plan keyword_name empty when no contract-valid send keyword exists", () => {
    // C: no bogus library-absent keyword name may enter the plan — empty
    // keyword_name cleanly disables the hint instead of producing noise.
    const map = new Map<string, KeywordMeta>([
      ["发送CANA指令", { ...keywordMeta("发送CANA指令", "第${time}秒,发送CANA指令${para2}"), argumentComments: ["执行时间", "指令码", "循环周期"] }],
    ])

    const result = buildRequirementStepPlan({
      handling: "软件接收到间接指令后执行相应的处理，并通过CANA总线发送应答。",
      inputFlow: "间接指令。",
      outputFlow: "间接指令应答数据。",
      chapterContent: "",
      keywordMap: map,
    })

    expect(result.step_plan.length).toBeGreaterThan(0)
    expect(result.step_plan.every((step) => step.keyword_name === "")).toBe(true)
  })
})

describe("2026-08-28 回归:锚点通道硬约束(SPI/二级CAN 步骤被 set_input_data 模式滤进内存关键字)", () => {
  // 真实 UserKeyWord 条目形态(doc/参数逐字取自 workdir 项目库)
  function buildRealShapeCatalog() {
    const root = mkdtempSync(join(tmpdir(), "matrix-keywords-anchor-"))
    const keywordDir = join(root, "组合关键字")
    mkdirSync(keywordDir, { recursive: true })
    writeFileSync(
      join(keywordDir, "UserKeyWord.json"),
      JSON.stringify({
        Items: [
          {
            Name: "发送SPITXT接口数据",
            Comments: "第${time}秒，通过SPI接口发送${para2}",
            Arguments: [
              { Name: "${time}", Comments: "执行时间" },
              { Name: "${para2}", Comments: "参数2：数据协议名称；" },
            ],
          },
          {
            Name: "发送二级CANTXT数据",
            Comments: "第${time}秒，通过二级CAN总线发送${para2}",
            Arguments: [
              { Name: "${time}", Comments: "执行时间" },
              { Name: "${para2}", Comments: "参数2：数据协议名称；" },
            ],
          },
          {
            Name: "发送CANATXT数据",
            Comments: "第${time}秒,通过%$总线${para3}发送${para2}",
            Arguments: [
              { Name: "${time}", Comments: "执行时间" },
              { Name: "${para1}", Comments: "参数1：指令ID 1~20；" },
              { Name: "${para2}", Comments: "参数2：数据协议名称；" },
              { Name: "${para3}", Comments: "参数3：循环时间，单位为秒，无参数3只发送当前一次；" },
            ],
          },
          {
            Name: "循环发送CANA指令",
            Comments: "通过%$总线以${para4}秒为周期${para5}发送${para1}.txt中从${para2}到${para3}的指令",
            Arguments: [
              { Name: "${time}", Comments: "执行时间" },
              { Name: "${para1}", Comments: "参数1：数据文件；" },
              { Name: "${para2}", Comments: "参数2：开始索引，十进制；" },
              { Name: "${para3}", Comments: "参数3：结束索引，十进制；" },
              { Name: "${para4}", Comments: "参数4：单指令间循环时间；" },
              { Name: "${para5}", Comments: "参数5：是否轮询(N/Y),[N:单次；Y：轮询]" },
            ],
          },
          {
            Name: "设置16位数据至32位地址",
            Comments: "",
            Arguments: [
              { Name: "${time}", Comments: "执行时间" },
              { Name: "${para1}", Comments: "参数1：起始地址，十六进制" },
              { Name: "${para2}", Comments: "参数2：数据或文件，文件类型包括txt和bin，txt格式为每个字节空格隔开" },
              { Name: "${para3}", Comments: "参数3：High16 or Low16" },
            ],
          },
        ],
      }),
      "utf-8",
    )
    return { root, keywordMap: scanKeywordDirs([keywordDir]).keywordMap }
  }

  test("actionChannelOfText:动作从句通道识别;验证类步骤(无发送动词)与预期半区不误判", () => {
    expect(actionChannelOfText("第3.1秒，通过SPI总线A发送站地址59H的机构控制指令应答（全部字段正确）。")).toBe("SPI")
    expect(actionChannelOfText("第4.1秒，通过二级CAN总线发送站地址01H的10字节遥控指令应答。")).toBe("二级CAN")
    expect(actionChannelOfText("第3.0秒，通过CANA总线以1秒为周期循环发送遥控指令TCY216。")).toBe("CANA")
    expect(actionChannelOfText("第5.0秒，验证遥测帧2通过CANA总线输出的轮询数据。")).toBe(null)
    // 通道词必须在发送动词之前的动作从句里;结果从句提及总线不算
    expect(actionChannelOfText("第5.0秒，设置地址0x2000的16位数据。\n软件通过CANA总线返回。")).toBe(null)
  })

  test("set_input_data 锚点+SPI 步骤:发送SPITXT接口数据 胜出,内存关键字出局", () => {
    const { root, keywordMap } = buildRealShapeCatalog()
    try {
      const ranked = scoreKeywordCandidatesByAnchor(
        "第3.1秒，通过SPI总线A发送站地址59H的机构控制指令应答（全部字段正确）。\n软件正常处理应答，SPI错误应答计数TMYN229保持0。",
        keywordMap,
        { operation_type: "set_input_data", channel: "" },
      )
      expect(ranked[0]?.keywordName).toBe("发送SPITXT接口数据")
      expect(ranked.some((k) => k.keywordName.includes("设置"))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("set_input_data 锚点+二级CAN 步骤:发送二级CANTXT数据 胜出,内存/一级关键字出局", () => {
    const { root, keywordMap } = buildRealShapeCatalog()
    try {
      const ranked = scoreKeywordCandidatesByAnchor(
        "第4.1秒，通过二级CAN总线发送站地址01H的10字节遥控指令应答（仲裁场错误，其余字段正确）。\n软件识别错误。",
        keywordMap,
        { operation_type: "set_input_data", channel: "" },
      )
      expect(ranked[0]?.keywordName).toBe("发送二级CANTXT数据")
      expect(ranked.some((k) => k.keywordName.includes("设置"))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("真内存步骤(无总线动作)不受影响:set_memory 模式过滤保留", () => {
    const { root, keywordMap } = buildRealShapeCatalog()
    try {
      const ranked = scoreKeywordCandidatesByAnchor(
        "第5.0秒，设置地址0x2000起始的16位数据为0x1234。",
        keywordMap,
        { operation_type: "set_memory" },
      )
      expect(ranked.some((k) => k.keywordName === "设置16位数据至32位地址")).toBe(true)
      expect(ranked.some((k) => k.keywordName === "发送SPITXT接口数据")).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("一级触发步骤(send_command/CANA):CANA 家族候选保留,通道外关键字出局", () => {
    const { root, keywordMap } = buildRealShapeCatalog()
    try {
      const ranked = scoreKeywordCandidatesByAnchor(
        "第3.0秒，通过CANA总线以1秒为周期循环发送遥控指令TCY216（循环时间=1.0）。",
        keywordMap,
        { operation_type: "send_command", channel: "CANA" },
      )
      // 合成迷你库评分顺序与真实库(循环发送CANA指令居首)不同,不按名次断言;
      // 行为断言:CANA 发送家族两关键字都在候选内,内存/SPI/二级关键字出局
      expect(ranked.some((k) => k.keywordName === "循环发送CANA指令")).toBe(true)
      expect(ranked.some((k) => k.keywordName === "发送CANATXT数据")).toBe(true)
      expect(ranked.some((k) => k.keywordName.includes("设置"))).toBe(false)
      expect(ranked.some((k) => k.keywordName === "发送SPITXT接口数据")).toBe(false)
      expect(ranked.some((k) => k.keywordName === "发送二级CANTXT数据")).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("2026-08-31 审计回归:Phase B 全局评分 SPI 通道硬约束", () => {
  test("SPI 动作步骤不被二级CAN/内存关键字抢占——预期半区提及二级转发也不行", () => {
    const root = mkdtempSync(join(tmpdir(), "matrix-keywords-spi-phaseb-"))
    try {
      const keywordDir = join(root, "组合关键字")
      mkdirSync(keywordDir, { recursive: true })
      writeFileSync(
        join(keywordDir, "UserKeyWord.json"),
        JSON.stringify({
          Items: [
            { Name: "发送SPITXT接口数据", Comments: "第${time}秒，通过SPI接口发送${para2}", Arguments: [{ Name: "${time}", Comments: "执行时间" }, { Name: "${para2}", Comments: "参数2：数据协议名称；" }] },
            { Name: "发送二级CANTXT数据", Comments: "第${time}秒，通过二级CAN总线发送${para2}", Arguments: [{ Name: "${time}", Comments: "执行时间" }, { Name: "${para2}", Comments: "参数2：数据协议名称；" }] },
            { Name: "发送CANATXT数据", Comments: "第${time}秒,通过%$总线${para3}发送${para2}", Arguments: [{ Name: "${time}", Comments: "执行时间" }, { Name: "${para1}", Comments: "参数1：ID:0~255" }, { Name: "${para2}", Comments: "参数2：数据文件" }, { Name: "${para3}", Comments: "参数3：循环时间" }] },
            { Name: "设置16位数据至32位地址", Comments: "", Arguments: [{ Name: "${time}", Comments: "执行时间" }, { Name: "${para1}", Comments: "参数1：起始地址，十六进制" }, { Name: "${para2}", Comments: "参数2：数据或文件" }, { Name: "${para3}", Comments: "参数3：High16 or Low16" }] },
          ],
        }),
        "utf-8",
      )
      const keywordMap = scanKeywordDirs([keywordDir]).keywordMap
      const ranked = scoreKeywordCandidates(
        "第3.1秒，通过SPI接口发送应答数据，并设置站地址为59H。\n被测软件通过二级CAN总线转发应答数据。",
        keywordMap,
        12,
      )
      expect(ranked[0]?.keywordName).toBe("发送SPITXT接口数据")
      expect(ranked.some((k) => k.keywordName === "发送二级CANTXT数据")).toBe(false)
      expect(ranked.some((k) => k.keywordName === "发送CANATXT数据")).toBe(false)
      expect(ranked.some((k) => k.keywordName.includes("设置"))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("2026-09-02 回归:数据文件变体确定性偏好(_数据文件 压过同名基础变体)", () => {
  test("同 Documentation 的双胞胎关键字,总线发送步骤选 _数据文件 变体(不再按加载序随机)", () => {
    const root = mkdtempSync(join(tmpdir(), "matrix-keywords-filevar-"))
    try {
      const keywordDir = join(root, "组合关键字")
      mkdirSync(keywordDir, { recursive: true })
      writeFileSync(
        join(keywordDir, "UserKeyWord.json"),
        JSON.stringify({
          Items: [
            {
              Name: "发送CANA数据",
              Comments: "第${time}秒,通过CANA总线${para3}发送${para2}",
              Arguments: [
                { Name: "${time}", Comments: "执行时间" },
                { Name: "${para1}", Comments: "参数1：ID:1~255,一个ID对应一种类型指令，由用户自定义；" },
                { Name: "${para2}", Comments: "参数2：数据协议名称" },
                { Name: "${para3}", Comments: "参数3：循环时间，单位为秒，无参数3只发送当前一次，-1位停止发送。" },
              ],
            },
            {
              Name: "发送CANA数据_数据文件",
              Comments: "第${time}秒,通过CANA总线${para3}发送${para2}",
              Arguments: [
                { Name: "${time}", Comments: "执行时间" },
                { Name: "${para1}", Comments: "参数1：ID:0~255,一个ID对应一种类型指令，由用户自定义；" },
                { Name: "${para2}", Comments: "参数2：数据文件，文件内容为十六进制数据，每个字节空格隔开。" },
                { Name: "${para3}", Comments: "参数3：循环时间，单位为秒，无参数3只发送当前一次，-1位停止发送。" },
              ],
            },
          ],
        }),
        "utf-8",
      )
      const keywordMap = scanKeywordDirs([keywordDir]).keywordMap
      const ranked = scoreKeywordCandidates(
        "第3.0秒，通过CANA总线发送遥测帧1轮询控制序列。\n系统正确接收。",
        keywordMap,
        4,
      )
      // 基础变体在库中先加载;文件变体必须凭偏好分胜出
      expect(ranked[0]?.keywordName).toBe("发送CANA数据_数据文件")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("2026-09-02 回归:数据池排除/TXT最优/限定词减分/中断对齐/\\bsend\\b 词边界", () => {
  function metaOf(name: string, description: string, comments: string[], snippet = ""): KeywordMeta {
    return {
      keywordName: name,
      description,
      argumentNames: comments.map((_, i) => i === 0 ? "${time}" : `${"${para" + i + "}"}`),
      argumentComments: comments,
      txtSnippet: snippet,
      sourceJson: "/tmp/Demo.json",
      searchText: [name, description, comments.join(" "), snippet].filter(Boolean).join("\n"),
    }
  }

  test("数据池关键字全局排除:UserKeyWord 命中与全库回退两形态都不参与匹配", () => {
    const normal = metaOf("设置32位地址数据", "第${time}秒，设置内存地址${para1}的数据为${para2}", ["执行时间", "参数1：起始地址，十六进制", "参数2：数据或文件"])
    const pool = metaOf("设置数据池数据", "第${time}秒，设置${para1}的值为${para2}", ["执行时间", "参数1", "参数2"])
    // 形态1:UserKeyWord 源命中时,数据池条目被剔除
    const userSourced = new Map([["设置32位地址数据", { ...normal, sourceJson: "/x/UserKeyWord.json" }], ["设置数据池数据", { ...pool, sourceJson: "/x/UserKeyWord.json" }]])
    const filtered = filterUserKeywordMap(userSourced)
    expect(filtered.has("设置32位地址数据")).toBe(true)
    expect(filtered.has("设置数据池数据")).toBe(false)
    // 形态2:无 UserKeyWord 源回退全库时,数据池条目同样剔除
    const fallback = filterUserKeywordMap(new Map([["设置32位地址数据", normal], ["设置数据池数据", pool]]))
    expect(fallback.has("设置32位地址数据")).toBe(true)
    expect(fallback.has("设置数据池数据")).toBe(false)
  })

  test("TXT/数据文件 最优:SPI 发送步骤选 发送SPI-TXT数据,SPICap 记录类让位(txt 片段 VTest_SendCmd 不再误判 send)", () => {
    const map = new Map<string, KeywordMeta>([
      // 真实形态:SPICap 空 doc,txt 片段含组件调用名 VTest_SendCmd
      ["开始SPICap数据记录", metaOf("开始SPICap数据记录", "", ["执行时间"], "VTest_SendCmd  软平台,开始SPICap数据记录")],
      ["发送SPI-TXT数据", metaOf("发送SPI-TXT数据", "第${time}秒，发送SPI数据为${para1}", ["执行时间", "参数1：数据文件"])],
    ])
    const ranked = scoreKeywordCandidates(
      "第3.1秒,通过SPI总线发送站地址5BH的机构控制指令应答(全部字段正确)。",
      map, 4,
    )
    expect(ranked[0]?.keywordName).toBe("发送SPI-TXT数据")
  })

  test("括号限定词减分:非 C33 语境选无后缀的 设置32位地址数据,双胞胎稳定不再随机", () => {
    const map = new Map<string, KeywordMeta>([
      ["设置32位地址数据", metaOf("设置32位地址数据", "第${time}秒，设置内存地址${para1}的数据为${para2}", ["执行时间", "参数1：起始地址，十六进制", "参数2：数据或文件"])],
      ["设置32位地址数据(针对C33处理器)", metaOf("设置32位地址数据(针对C33处理器)", "第${time}秒，设置内存地址${para1}的数据为${para2}", ["执行时间", "参数1：起始地址，十六进制", "参数2：数据或文件"])],
    ])
    const ranked = scoreKeywordCandidates(
      "第4.0秒，设置内存地址21142000H的数据为二级节点上注数据块·全部字段正确。",
      map, 4,
    )
    expect(ranked[0]?.keywordName).toBe("设置32位地址数据")
  })

  test("触发中断对齐:触发外部中断步骤选 触发外部中断,压过 触发TRAP中断 与 设置类", () => {
    const map = new Map<string, KeywordMeta>([
      ["触发TRAP中断", metaOf("触发TRAP中断", "第${time}秒，触发TRAP中断${para1}", ["执行时间", "参数1：中断号"])],
      ["触发外部中断", metaOf("触发外部中断", "第${time}秒，${para3}外部中断${para1}", ["执行时间", "参数1：中断号", "参数2", "参数3"])],
      ["设置32位地址数据", metaOf("设置32位地址数据", "第${time}秒，设置内存地址${para1}的数据为${para2}", ["执行时间", "参数1：起始地址，十六进制", "参数2：数据或文件"])],
    ])
    const ranked = scoreKeywordCandidates("第3.2秒，触发Spacewire外部中断2。", map, 4)
    expect(ranked[0]?.keywordName).toBe("触发外部中断")
  })
})

describe("2026-09-02 回归:宽度限定词减分(内存写双胞胎稳定)", () => {
  function memMeta(name: string, comments: string[]): KeywordMeta {
    return {
      keywordName: name,
      description: "第${time}秒，设置内存地址${para1}的数据为“${para2}”",
      argumentNames: comments.map((_, i) => i === 0 ? "${time}" : `${"${para" + (i + 1) + "}"}`),
      argumentComments: comments,
      txtSnippet: "",
      sourceJson: "/tmp/Demo.json",
      searchText: [name].join("\n"),
    }
  }
  const map = new Map<string, KeywordMeta>([
    ["设置32位地址数据", memMeta("设置32位地址数据", ["执行时间", "参数1：起始地址，十六进制", "参数2：数据或文件"])],
    ["设置16位数据至32位地址", memMeta("设置16位数据至32位地址", ["执行时间", "参数1：起始地址，十六进制", "参数2：数据或文件", "参数3：High16 or Low16"])],
    ["设置32位地址数据(针对C33处理器)", memMeta("设置32位地址数据(针对C33处理器)", ["执行时间", "参数1：起始地址，十六进制", "参数2：数据或文件"])],
  ])

  test("无宽度语义的内存写步骤:载荷措辞不再翻转选型,稳定选 设置32位地址数据", () => {
    const payloadA = scoreKeywordCandidates("第3.0秒，设置内存地址21142000H的数据为管控程序上注起始块·全部字段正确。", map, 3)
    const payloadB = scoreKeywordCandidates("第4.0秒，设置内存地址21142000H的数据为二级节点上注数据块·全部字段正确。", map, 3)
    expect(payloadA[0]?.keywordName).toBe("设置32位地址数据")
    expect(payloadB[0]?.keywordName).toBe("设置32位地址数据")
  })

  test("步骤明确 16位 语义时宽度变体不减速分,照常胜出", () => {
    const ranked = scoreKeywordCandidates("第5.0秒，设置内存地址21142000H的16位数据为0x1234。", map, 3)
    expect(ranked[0]?.keywordName).toBe("设置16位数据至32位地址")
  })
})
