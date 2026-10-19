import { describe, expect, test } from "bun:test"
import {
  applySemanticBindingsToStandardizedCase,
  bindKeywordArgsFromSemantics,
  findBestKeywordCandidateForStep,
  renderDocumentationTemplate,
  type KeywordCandidateContext,
  type PlaceholderSuggestion,
} from "../src/shared/keyword-argument-binding"
import type { ProtocolSemanticDocument } from "../src/shared/protocol-semantics"

describe("keyword argument binding", () => {
  test("binds placeholders from worker suggestions and protocol semantic tables", () => {
    const keyword: KeywordCandidateContext = {
      keywordName: "发送CANA数据",
      description: "第${time}秒,通过CANA总线${para3}发送${para2}",
      argumentNames: ["${time}", "${para1}", "${para2}", "${para3}"],
      argumentComments: [
        "执行时间",
        "参数1：ID:1~255,一个ID对应一种类型指令",
        "参数2：数据协议名称",
        "参数3：循环时间，单位为秒，无参数3只发送当前一次",
      ],
      txtSnippet: "",
    }
    const protocolSemantic: ProtocolSemanticDocument = {
      protocol_name: "间接指令",
      source_file: "/tmp/间接指令.docx",
      paragraphs: [],
      tables: [
        {
          title: "表3.1.1.7-2 间接数据指令说明",
          section_title: "输入流：间接指令，格式及内容如下表所示。",
          headers: ["序号", "指令名称", "指令码", "指令说明", "备注"],
          rows: [
            {
              "序号": "1",
              "指令名称": "中继测控子系统与中继星1通信",
              "指令码": "1501AAAA",
              "指令说明": "缓变遥测（中继星选星结果）为1",
              "备注": "数字型",
            },
          ],
        },
      ],
    }
    const suggestions: PlaceholderSuggestion[] = [
      {
        case_index: 0,
        step_index: 0,
        placeholder: "${time}",
        value: "10.8",
        reason: "需求未显式给出执行时间，按测试常识补全",
      },
    ]

    const result = bindKeywordArgsFromSemantics(keyword, {
      protocolSemantic,
      requirementContext: {
        requirementHandling: "若接收到“中继测控子系统与中继星1星通信”间接指令，则设置缓变遥测书籍中中继星选型结果（W2b7-W2b4）为0x01。",
        chapterBackground: "软件接收到间接指令后，通过总线（CANA或CANB）发送间接指令应答。",
        inputFlow: "间接指令。",
        outputFlow: "间接指令应答数据。",
      },
      placeholderSuggestions: suggestions,
      caseIndex: 0,
      stepIndex: 0,
      template: keyword.description,
    })
    const rendered = renderDocumentationTemplate(keyword.description, result.bindings)

    expect(result.bindings["${time}"]).toBe("10.8")
    expect(result.bindings["${para2}"]).toBe("中继测控子系统与中继星1通信")
    expect(result.bindings["${para3}"]).toBe("")
    expect(rendered.text).toContain("第10.8秒")
    expect(rendered.text).toContain("通过CANA总线发送中继测控子系统与中继星1通信")
  })

  test("allows empty-string placeholder replacement", () => {
    const rendered = renderDocumentationTemplate(
      "通过CANA总线${para3}发送${para2}",
      {
        "${para3}": "",
        "${para2}": "中继测控子系统与中继星1通信",
      },
    )

    expect(rendered.unresolved).toEqual([])
    expect(rendered.text).toBe("通过CANA总线发送中继测控子系统与中继星1通信")
  })

  test("keeps unresolved keyword placeholders as warnings instead of errors", () => {
    const result = applySemanticBindingsToStandardizedCase(
      {
        test_step: [
          {
            步骤描述: "执行${para1}操作。",
            预期结果: "系统记录操作结果。",
          },
        ],
        test_input: "无",
      },
      {
        keywordCandidates: [
          {
            keywordName: "执行参数化操作",
            description: "执行${para1}操作",
            argumentNames: ["${para1}"],
            argumentComments: ["参数1：需求未明确给出的操作参数"],
            txtSnippet: "",
          },
        ],
        datasetRef: ".matrix/data/input-datasets/default.json#normal-01",
        requirementContext: {
          requirementHandling: "执行参数化操作。",
          testTypeChinese: "功能测试",
        },
      },
    )

    expect(result.errors).toEqual([])
    expect(result.test_step[0]["步骤描述"]).toBe("执行${para1}操作")
    expect(result.warnings.some((warning) => warning.includes("${para1}"))).toBe(true)
  })

  test("forces natural-language steps back into Documentation format when a confident keyword candidate exists", () => {
    const result = applySemanticBindingsToStandardizedCase(
      {
        test_step: [
          {
            步骤描述: "通过CANA总线向软件发送一条有效的间接指令。",
            预期结果: "软件正确处理并输出可验证结果。",
          },
        ],
        test_input: "无",
      },
      {
        keywordCandidates: [
          {
            keywordName: "发送CANA数据",
            description: "第${time}秒,通过CANA总线${para3}发送${para2}",
            argumentNames: ["${time}", "${para1}", "${para2}", "${para3}"],
            argumentComments: [
              "执行时间",
              "参数1：ID",
              "参数2：数据协议名称",
              "参数3：循环时间，单位为秒，无参数3只发送当前一次",
            ],
            txtSnippet: "",
          },
        ],
        datasetRef: ".matrix/data/input-datasets/间接指令.json#normal-01",
        protocolSemantic: {
          protocol_name: "间接指令",
          source_file: "/tmp/间接指令.docx",
          paragraphs: [],
          tables: [
            {
              title: "表3.1.1.7-2 间接数据指令说明",
              section_title: "输入流：间接指令，格式及内容如下表所示。",
              headers: ["序号", "指令名称", "指令码", "指令说明", "备注"],
              rows: [
                {
                  序号: "1",
                  指令名称: "中继测控子系统与中继星1通信",
                  指令码: "1501AAAA",
                  指令说明: "缓变遥测（中继星选星结果）为1",
                  备注: "数字型",
                },
              ],
            },
          ],
        },
        requirementContext: {
          requirementHandling:
            "若接收到“中继测控子系统与中继星1星通信”间接指令，则设置缓变遥测书籍中中继星选型结果（W2b7-W2b4）为0x01。",
          chapterBackground: "软件接收到间接指令后，通过总线（CANA或CANB）发送间接指令应答。",
          inputFlow: "间接指令。",
          outputFlow: "间接指令应答数据。",
          testTypeChinese: "功能测试",
        },
        placeholderSuggestions: [
          {
            case_index: 0,
            step_index: 0,
            placeholder: "${time}",
            value: "10.8",
          },
        ],
        caseIndex: 0,
      },
    )

    const steps = result.test_step
    expect(steps[0]["步骤描述"]).toBe("第10.8秒,通过CANA总线发送中继测控子系统与中继星1通信")
    expect(result.test_input).toBe(".matrix/data/input-datasets/间接指令.json#normal-01")
  })

  test("keeps a generic CAN step single because CANA/CANB expansion belongs to suite-level case generation", () => {
    const result = applySemanticBindingsToStandardizedCase(
      {
        test_step: [
          {
            步骤描述: "通过CAN总线向软件发送一条有效的间接指令。",
            预期结果: "软件正确处理并输出可验证结果。",
          },
        ],
        test_input: "无",
      },
      {
        keywordCandidates: [
          {
            keywordName: "发送CANA数据",
            description: "第${time}秒,通过CANA总线${para3}发送${para2}",
            argumentNames: ["${time}", "${para1}", "${para2}", "${para3}"],
            argumentComments: ["执行时间", "参数1：ID", "参数2：数据协议名称", "参数3：循环时间"],
            txtSnippet: "",
          },
          {
            keywordName: "发送CANB数据",
            description: "第${time}秒,通过CANB总线${para3}发送${para2}",
            argumentNames: ["${time}", "${para1}", "${para2}", "${para3}"],
            argumentComments: ["执行时间", "参数1：ID", "参数2：数据协议名称", "参数3：循环时间"],
            txtSnippet: "",
          },
        ],
        datasetRef: ".matrix/data/input-datasets/间接指令.json#normal-01",
        protocolSemantic: {
          protocol_name: "间接指令",
          source_file: "/tmp/间接指令.docx",
          paragraphs: [],
          tables: [
            {
              title: "表3.1.1.7-2 间接数据指令说明",
              section_title: "输入流：间接指令，格式及内容如下表所示。",
              headers: ["序号", "指令名称"],
              rows: [
                {
                  序号: "1",
                  指令名称: "中继测控子系统与中继星1通信",
                },
              ],
            },
          ],
        },
        requirementContext: {
          requirementHandling: "若接收到“中继测控子系统与中继星1星通信”间接指令，则设置结果为0x01。",
          chapterBackground: "软件接收到间接指令后，通过总线（CANA或CANB）发送间接指令应答。",
          inputFlow: "间接指令。",
          outputFlow: "间接指令应答数据。",
          testTypeChinese: "功能测试",
        },
        placeholderSuggestions: [
          { step_index: 0, placeholder: "${time}", value: "10.8" },
        ],
        caseIndex: 0,
      },
    )

    expect(result.errors).toEqual([])
    expect(result.test_step).toHaveLength(1)
    expect(result.test_step[0]["步骤描述"]).toBe("通过CAN总线向软件发送一条有效的间接指令。")
  })
})

describe("2026-08-31 审计回归:绑定候选通道硬约束(SPI)", () => {
  const candidates: KeywordCandidateContext[] = [
    {
      keywordName: "设置16位数据至32位地址",
      description: "",
      argumentNames: ["${time}", "${para1}", "${para2}", "${para3}"],
      argumentComments: ["执行时间", "参数1：起始地址，十六进制", "参数2：数据或文件", "参数3：High16 or Low16"],
      txtSnippet: "",
    },
    {
      keywordName: "发送二级CANTXT数据",
      description: "第${time}秒，通过二级CAN总线发送${para2}",
      argumentNames: ["${time}", "${para2}"],
      argumentComments: ["执行时间", "参数2：数据协议名称；"],
      txtSnippet: "",
    },
    {
      keywordName: "发送SPITXT接口数据",
      description: "第${time}秒，通过SPI接口发送${para2}",
      argumentNames: ["${time}", "${para2}"],
      argumentComments: ["执行时间", "参数2：数据协议名称；"],
      txtSnippet: "",
    },
  ]

  test("SPI 动作步骤的绑定候选必须是 SPI 关键字——站地址注释不再吸引内存关键字", () => {
    const best = findBestKeywordCandidateForStep(
      "第3.1秒，通过SPI总线发送站地址59H的机构控制指令应答（全部字段正确）。",
      candidates,
    )
    expect(best?.keywordName).toBe("发送SPITXT接口数据")
  })

  test("无 SPI 通道词的普通 CAN 步骤不受该约束影响", () => {
    const best = findBestKeywordCandidateForStep(
      "第4.1秒，通过二级CAN总线发送站地址01H的10字节遥控指令应答。",
      candidates,
    )
    expect(best?.keywordName).toBe("发送二级CANTXT数据")
  })
})
