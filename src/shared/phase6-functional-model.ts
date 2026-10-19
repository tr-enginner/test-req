import { isPeriodicSend, isPrimaryTelemetryReadback } from "./testcase-step-semantics"
import { analyzePacketSequences, MULTIPACKET_SEQUENCE_RULE } from "./phase6-step-design-policy"

/** Requirement identity, not keywords in referenced tables, selects the functional model. */
export interface FunctionalModelContext {
  name?: string
  requirementId?: string
  testType?: string
  corpus?: string
}

export type FunctionalModel = "manual" | "spacewire" | "spi-telemetry"
  | "secondary-telemetry" | "fpga-telemetry" | "camera-auxiliary" | "ordered-upload" | "default"

export function resolveFunctionalModel(context: FunctionalModelContext): FunctionalModel {
  if (context.testType && !["functional", "功能测试"].includes(context.testType)) return "default"
  const name = (context.name ?? "").replace(/\s/g, "")
  const ids = (context.requirementId ?? "").split(/[、,，]/).filter(Boolean)
  if (/^(?:引导加载|初始化)(?:需求项|需求|功能|测试|\[|$)/.test(name)
    || (ids.length > 0 && ids.every((id) => /^TR-GN-(?:BOOT|INIT)-\d+(?:[~～-]\d+)?$/.test(id)))) return "manual"
  if (/接收处理Spacewire总线上注数据/i.test(name)) return "spacewire"
  if (/采集SPI总线遥测/i.test(name)) return "spi-telemetry"
  if (/采集二级CAN总线遥测/i.test(name)) return "secondary-telemetry"
  if (/采集FPGA状态遥测/i.test(name)) return "fpga-telemetry"
  if (/发送相机辅助数据/.test(name)) return "camera-auxiliary"
  if (/249字节上行数据块处理/.test(name)) return "ordered-upload"
  return "default"
}

/** Undefined keeps ordinary interface detection; [] deliberately injects no bus models. */
export function functionalInterfaceSections(model: FunctionalModel): string[] | undefined {
  switch (model) {
    case "manual": return []
    case "spacewire": return ["spacewire"]
    case "spi-telemetry": return ["spi-bus"]
    case "secondary-telemetry": return ["secondary-bus"]
    case "fpga-telemetry": return ["fpga-telemetry"]
    case "camera-auxiliary": return ["primary-can", "secondary-bus"]
    case "ordered-upload": return ["primary-can", "ordered-upload"]
    default: return undefined
  }
}

export function functionalModelRules(model: FunctionalModel): string {
  const rules: Partial<Record<FunctionalModel, string>> = {
    manual: "本需求为人工验证的引导加载/初始化需求。保留可供人工执行和检查的步骤及预期结果，不编造自动化操作、地址或数据包；不进行关键字匹配、参数绑定或翻译，translate_status 由工具标记为 not_applicable。operation_type 写 other，channel 留空；不得套用 CAN 收发模型或强加软平台秒级发送时序。",
    spacewire: "本需求的输入交付只适用 Spacewire 上注数据块测试模型：每块写协议数据→写 ID→触发外部中断。输出流中的二级 CAN 转发是被测软件行为，不是测试系统的输入动作；禁止通过 CANA/CANB 发送管控程序或二级节点上注数据块。",
    "spi-telemetry": "本需求采用 SPI 模拟单板遥测模型，不得通过一级 CAN 发送电机/黑体/指令板遥测数据。必须先设置一级 CAN 周期发送对应遥测帧轮询控制序列的回读步骤，用于读取并验证更新值和错误计数，覆盖本用例涉及的全部遥测帧；同一帧只声明一次循环，不同帧可分别声明。该回读不是 SPI 轮询触发，软件自主轮询不能豁免回读。触发 SPI 轮询的步骤根据测试需要和需求依据另行添加，不能凭空编造；测试系统按真实轮询时刻发送有站地址的 SPI 正确/单字段错误遥测，更新和错误计数写入预期结果。",
    "secondary-telemetry": "本需求采用二级 CAN 模拟从节点遥测模型，不得把从节点遥测数据通过一级 CAN 发送。必须先设置一级 CAN 周期发送对应遥测帧轮询控制序列的回读步骤，用于读取并验证更新值和错误计数，覆盖本用例涉及的全部遥测帧；同一帧只声明一次循环，不同帧可分别声明。该回读不是二级 CAN 轮询触发，软件自主轮询不能豁免回读。触发二级 CAN 轮询的步骤根据测试需要和需求依据另行添加；测试系统按真实节点轮询顺序和时刻模拟正确/单字段错误遥测，携带对应站地址。",
    "fpga-telemetry": "本需求采用 FPGA 状态遥测模型：按输入地址表设置具体状态值，再通过一级 CAN 轮询所有涉及的遥测帧验证映射。Spacewire 仅是被采集的状态字段，不适用上注三步模型。",
    "camera-auxiliary": "本需求采用二级总线输出模型：测试系统发送输入流定义的图像数据特征标识设置指令，软件按500ms周期组帧并经二级CAN广播相机辅助数据；广播及位域映射写入预期结果。不得把软件发送广播写成测试系统发送步骤；广播无需应答时不得编造二级应答。",
    "ordered-upload": MULTIPACKET_SEQUENCE_RULE,
  }
  return rules[model] ? `\n<functional_model_rules>\n以下按当前需求身份选择的规则优先于通用规则和 step_plan；只使用本需求明确的输入/输出方向与触发条件。\n${rules[model]}\n</functional_model_rules>\n` : ""
}

export function isAutonomousTelemetry(model: FunctionalModel, corpus: string): boolean {
  return ["spi-telemetry", "secondary-telemetry"].includes(model)
    && /每(?:秒|\s*\d+(?:\.\d+)?\s*(?:秒|ms|毫秒))[^。\n]{0,100}(?:发送|轮询)/.test(corpus)
}

/** Reject semantic model errors instead of repairing them by inventing actions/data. */
export function validateFunctionalModelSteps(
  model: FunctionalModel,
  steps: Array<{ 步骤描述: string; 预期结果: string }>,
  corpus = "",
): string[] {
  const business = steps.filter((step) => !/^启动软平台[。.]?$/.test(step.步骤描述.trim()))
  const descs = business.map((step) => step.步骤描述)
  const primary = /通过(?:一级)?\s*CAN[AB]?\s*总线[^。；\n]*发送/i
  const write = /(?:设置|写入|写)[^。；\n]*内存地址/i
  const errors: string[] = []
  if (model === "spacewire") {
    if (business.length === 0 || business.length % 3 !== 0 || descs.some((desc, i) =>
      i % 3 === 2 ? !/触发[^。；\n]*外部中断\s*\d+/.test(desc) : !write.test(desc))) {
      errors.push("Spacewire 每个数据块必须依次包含写协议数据、写ID、触发有编号的外部中断三个独立步骤。")
    }
    if (descs.some((desc) => /(?:通过|经)[^。；\n]*(?:CAN|Spacewire)[^。；\n]*发送[^。；\n]*上注/i.test(desc))) {
      errors.push("Spacewire 上注不得直接通过 CANA/CANB 或 Spacewire 发送数据块。")
    }
  }
  if (model === "spi-telemetry" || model === "secondary-telemetry") {
    const channel = model === "spi-telemetry" ? /SPI\s*总线/i : /二级\s*CAN(?:[AB]|总线[AB])?/i
    if (!descs.some((desc) => channel.test(desc) && /发送/.test(desc))) {
      errors.push("遥测采集须由测试系统通过对应 SPI/二级CAN 通道主动发送输入遥测，模拟单板/从节点返回。")
    }
    if (descs.some((desc) => primary.test(desc) && /发送[^。；\n]*(?:电机|黑体|指令板|从节点)?遥测数据/.test(desc))) {
      errors.push("不能将 SPI/二级CAN 输入遥测改写为一级 CAN 发送。")
    }
    const firstInput = descs.findIndex((desc) => channel.test(desc) && /发送/.test(desc))
    const readbacks = descs.flatMap((desc, i) => isPrimaryTelemetryReadback(desc) && isPeriodicSend(desc) ? [{ desc, index: i }] : [])
    if (!readbacks.length || (firstInput >= 0 && readbacks.some((s) => s.index >= firstInput))) {
      errors.push("SPI/二级CAN遥测用例须在模拟输入前设置一级CAN周期发送对应遥测帧轮询控制序列的回读步骤，用于读取并验证遥测；自主轮询不豁免回读，回读也不能代替按需设计的轮询触发。")
    }
    const expectedFrames = new Set(business.flatMap((s) => [...s.预期结果.matchAll(/遥测帧\s*(\d+)|([一二三]|\d+)类遥测/g)]
      .map((m) => m[1] ?? (/[一二三]/.test(m[2]!) ? String("一二三".indexOf(m[2]!) + 1) : m[2]!))))
    const readFrames = readbacks.flatMap((s) => [...s.desc.matchAll(/遥测帧\s*(\d+)\s*轮询控制序列/g)].map((m) => m[1]!))
    const missing = [...expectedFrames].filter((frame) => !readFrames.includes(frame))
    if (missing.length) errors.push(`一级CAN周期回读未覆盖预期结果涉及的遥测帧${missing.join("、")}，须按协议分别发送相应遥测帧轮询控制序列。`)
    if (new Set(readFrames).size < readFrames.length) errors.push("同一遥测帧的一级CAN周期回读只需声明一次，不得重复启动循环。")
  }
  if (model === "fpga-telemetry") {
    const writes = descs.flatMap((desc, i) => write.test(desc) ? [i] : [])
    const polls = descs.flatMap((desc, i) => primary.test(desc) && /轮询/.test(desc) ? [i] : [])
    if (!writes.length || !polls.length || Math.min(...polls) <= Math.max(...writes)) {
      errors.push("FPGA状态遥测必须先设置输入内存地址，再通过一级CAN轮询相关遥测帧，不能以发送FPGA遥测数据代替内存写入。")
    }
  }
  if (model === "camera-auxiliary") {
    if (descs.some((desc) => /发送[^。；\n]*相机辅助数据/.test(desc))) {
      errors.push("相机辅助数据广播是软件的二级CAN输出，只能写入预期结果，不能写为测试系统发送步骤。")
    }
    if (!business.some((step) => /二级\s*CAN/i.test(step.预期结果) && /(?:广播|发送)/.test(step.预期结果))) {
      errors.push("相机辅助数据用例必须验证软件经二级CAN输出的广播行为。")
    }
  }
  if (model === "ordered-upload") {
    errors.push(...analyzePacketSequences(business, { required: true, corpus }).issues.map((issue) => issue.message))
  }
  return errors
}
