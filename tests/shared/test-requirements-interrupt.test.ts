import { describe, expect, test } from "bun:test"
import { preparePhase6InputFromFlat } from "../../src/shared/test-requirements"

describe("2026-09-02 回归:interruptContext 可选字段贯通(flat → PreparedPhase6Requirement)", () => {
  const artifact: Parameters<typeof preparePhase6InputFromFlat>[0] = {
    funItem: [
      {
        funId: ["TR-GN-SWRC-001"],
        test_type: "接口测试",
        titleNo: "4.3.1",
        title: "Spacewire总线接口",
        requirementContext: "Spacewire总线接口",
        inputFlowContext: "上注数据块地址 21142000H，ID地址 21142E00H。",
        processingContext: "通过Spacewire总线读出ID号进行上注处理。",
        interruptContext: "外部中断4：Spacewire接收中断，中断号4，触发后软件读取上注数据块。",
      },
      {
        funId: ["TR-GN-INIT-001"],
        test_type: "功能测试",
        titleNo: "4.1.1",
        title: "初始化",
      },
    ],
  } as any

  test("interruptContext 存在时透传到 prepared requirement;缺失时为 undefined 不报错", () => {
    const prepared = preparePhase6InputFromFlat(artifact)
    const sw = prepared.requirements.find((r) => r.requirement_id === "TR-GN-SWRC-001")
    expect(sw?.interruptContext).toContain("外部中断4")
    const init = prepared.requirements.find((r) => r.requirement_id === "TR-GN-INIT-001")
    expect(init?.interruptContext).toBeUndefined()
  })
})

describe("2026-09-02 回归:interruptContext 工件级顶层字段回退", () => {
  test("顶层 interruptContext(项目级中断表)对未单独提供的 requirement 生效", () => {
    const artifact = {
      interruptContext: "表2-4 中断使用说明：外部中断2（IO6），执行功能 spacewire总线中断。",
      funItem: [
        {
          funId: ["TR-GN-SWRC-001"],
          test_type: "接口测试",
          titleNo: "4.3.1",
          title: "Spacewire总线接口",
        },
        {
          funId: ["TR-JK-001"],
          test_type: "接口测试",
          titleNo: "4.3.1",
          title: "一级CAN",
        },
      ],
    } as any
    const prepared = preparePhase6InputFromFlat(artifact)
    for (const req of prepared.requirements) {
      expect(req.interruptContext).toContain("外部中断2")
    }
  })
})
