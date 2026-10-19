import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  INTERFACE_SECTIONS_MARKER,
  detectInterfaceSectionTypes,
  injectInterfaceSections,
} from "../../src/shared/phase6-prompt-templates"

describe("接口类型专属分节按需注入(2026-08-25 用户需求)", () => {
  test("检测:二级CAN 需求 → 一级底座+二级总线;纯一级 → 仅一级;无信号 → 保守默认一级", () => {
    expect(detectInterfaceSectionTypes("通过二级CAN总线发送遥控指令后等待返回应答")).toEqual(["primary-can", "secondary-bus"])
    expect(detectInterfaceSectionTypes("通过CANA总线发送遥测帧1轮询控制序列")).toEqual(["primary-can"])
    expect(detectInterfaceSectionTypes("二级总线自动切换时初始使用A总线")).toEqual(["primary-can", "secondary-bus", "secondary-bus-switch"])
    expect(detectInterfaceSectionTypes("采集FPGA状态遥测接口数据")).toEqual(["primary-can"])
  })

  test("检测:SPI总线需求 → 注入 spi-bus 二级总线模型(2026-08-27 用户拍板:SPI与二级CAN同构)", () => {
    // TR-JK-011 组真实 processingContext 摘录
    expect(detectInterfaceSectionTypes(
      "TR-JK-011：通过SPI总线发送机构控制指令、黑体驱动指令、开关指令后，等待返回相应应答，若应答中站地址、类型、LENGTH、DATA0、SUM任一错误，则SPI错误应答计数加1。TR-GN-SPICJ-001~002：每秒通过SPI总线发送电机遥测轮询指令，并等待返回遥测。TR-JK-013：内部SPI总线自动切换时，初始使用A总线，若连续3次未收到同一节点正确遥测数据，则切换总线",
    )).toEqual(["primary-can", "spi-bus"])
    // "SPI接口"监视寄存器类需求(无板间通信语义)不触发
    expect(detectInterfaceSectionTypes("通过SPI接口发送监视FPGA接口输出的秒脉冲切换方式")).toEqual(["primary-can"])
    // 纯一级语料不含 spi-bus
    expect(detectInterfaceSectionTypes("通过CANA总线发送遥测帧1轮询控制序列")).toEqual(["primary-can"])
  })

  test("检测:Spacewire 上注需求 → 注入 spacewire 三步交付模型(2026-09-02 用户拍板)", () => {
    // TR-GN-SWRC 组真实语料摘录(requirementContext+inputFlowContext 拼接形态)
    expect(detectInterfaceSectionTypes(
      "Spacewire总线接口 IF-Spacewire-001：相机管理控制器通过集成在FPGA的Spacewire总线接口接收来自星务的管控上注程序和二级节点上注数据。" +
      "ID地址 21142E00H，上注数据块地址 21142000H~211422CFH。管控程序上注数据块，包含起始块、中间块、校验块。",
    )).toEqual(["primary-can", "spacewire"])
    // 仅复位/监视类 Spacewire 语料(无上注数据块语义)不触发
    expect(detectInterfaceSectionTypes("读完数据之后向Spacewire复位地址写0AH进行复位")).toEqual(["primary-can"])
    // 纯二级CAN/SPI 语料不误触发 spacewire
    expect(detectInterfaceSectionTypes("通过二级CAN总线发送遥控指令后等待返回应答")).toEqual(["primary-can", "secondary-bus"])
    expect(detectInterfaceSectionTypes("通过SPI总线发送机构控制指令后等待返回应答")).toEqual(["primary-can", "spi-bus"])
  })

  test("检测:秒脉冲接口需求 → 注入 second-pulse 一级遥控指令模型(2026-09-02 用户拍板)", () => {
    // TR-GN-TC-003 真实语料(requirementContext+inputFlowContext 拼接形态)
    expect(detectInterfaceSectionTypes(
      "秒脉冲接口 IF-GPS-001：CPU软件通过与FPGA之间的接口转发秒脉冲信号切换指令，对应地址21143000H。输出流：秒脉冲切换方式。AAAAH：切换GPSA，BBBBH：切换GPSB。",
    )).toEqual(["primary-can", "second-pulse"])
    // 无"切换"语义的秒脉冲语料不触发
    expect(detectInterfaceSectionTypes("秒脉冲信号采集与监视")).toEqual(["primary-can"])
    // 纯二级CAN/SPI/Spacewire 语料不误触发 second-pulse
    expect(detectInterfaceSectionTypes("通过二级CAN总线发送遥控指令后自动切换总线")).toEqual(["primary-can", "secondary-bus", "secondary-bus-switch"])
  })

  test("检测:成像控制接口需求 → 注入 imaging-control 一级遥控指令模型(2026-09-08 用户拍板,与秒脉冲同构)", () => {
    // TR-GN-TC-011 真实语料(requirementContext+inputFlowContext 拼接形态)
    expect(detectInterfaceSectionTypes(
      "成像控制接口 IF-CXKZ-001：CPU软件通过与FPGA之间的接口转发成像控制信号指令，对应地址21144000H。输出流：成像控制信号。",
    )).toEqual(["primary-can", "imaging-control"])
    // 一级CAN组语料仅含"成像控制信号指令"字样(遥控指令数据流表),无转发/输出流短语 → 不触发
    expect(detectInterfaceSectionTypes("10字节遥控指令包括成像控制信号指令等多种指令类型，通过一级CAN总线发送")).toEqual(["primary-can"])
    // 秒脉冲语料不误触发 imaging-control(反之亦然)
    expect(detectInterfaceSectionTypes(
      "秒脉冲接口 转发秒脉冲信号切换指令，对应地址21143000H。输出流：秒脉冲切换方式。",
    )).toEqual(["primary-can", "second-pulse"])
  })

  test("检测:FPGA状态遥测需求 → 注入 fpga-telemetry 设置+轮询模型(2026-09-08 用户拍板)", () => {
    // TR-GN-FPGACJ-001 真实语料(requirementContext+inputFlowContext 拼接形态)
    expect(detectInterfaceSectionTypes(
      "FPGA状态遥测接口 IF-Status-001：软件运行过程中通过FPGA状态接口取得综合电子FPGA运行状态遥测。FPGA GPS秒脉冲遥测 21143004H 输入，对应1类遥测W58。",
    )).toEqual(["primary-can", "fpga-telemetry"])
    // 秒脉冲/成像控制语料不误触发 fpga-telemetry(反之亦然)
    expect(detectInterfaceSectionTypes("秒脉冲接口 转发秒脉冲信号切换指令，输出流：秒脉冲切换方式。")).toEqual(["primary-can", "second-pulse"])
    expect(detectInterfaceSectionTypes("成像控制接口 转发成像控制信号指令，输出流：成像控制信号。")).toEqual(["primary-can", "imaging-control"])
  })

  test("检测:硬件狗需求 → 注入 hardware-watchdog 固定模式(2026-09-08 用户拍板)", () => {
    // TR-XN-001 真实语料
    expect(detectInterfaceSectionTypes(
      "硬件狗接口 IF-DOG-001：通过BM3803的PIO12写操作实现喂狗。狗咬时间为1.8s。输出流：喂狗信号。",
    )).toEqual(["primary-can", "hardware-watchdog"])
    // 无看门词语料不触发
    expect(detectInterfaceSectionTypes("通过CANA总线发送遥测帧1轮询控制序列")).toEqual(["primary-can"])
  })

  test("检测:其它接口兜底需求 → 注入 other-interface 一级遥控指令模型(2026-09-08 用户拍板)", () => {
    // TR-GN-TC-006 真实语料(requirementContext+inputFlowContext+processingContext 拼接形态)
    expect(detectInterfaceSectionTypes(
      "其它接口 IF-OTH-001：一级CANA、CANB总线复位端口分别对应PIO3、PIO7。输出流1：一级CANA总线复位脉冲信号。当收到平台CAN总线复位指令时，根据指令输出PIO3复位脉冲信号使CANA复位。",
    )).toEqual(["primary-can", "other-interface"])
    // 无指令+脉冲语义的其他接口语料不触发(异形态回落通用规则)
    expect(detectInterfaceSectionTypes("其他接口：数据格式转换与转发处理")).toEqual(["primary-can"])
    // 秒脉冲/成像控制语料互不触发 other-interface
    expect(detectInterfaceSectionTypes("秒脉冲接口 转发秒脉冲信号切换指令，输出流：秒脉冲切换方式。")).toEqual(["primary-can", "second-pulse"])
    expect(detectInterfaceSectionTypes("成像控制接口 转发成像控制信号指令，输出流：成像控制信号。")).toEqual(["primary-can", "imaging-control"])
  })

  test("检测:自动切换需求 → 追加切换专属模型;非切换二级/广播交替不追加(2026-08-26 经验固化)", () => {
    // TR-JK-010 真实 processingContext
    expect(detectInterfaceSectionTypes(
      "二级CAN总线自动切换时，初始使用A总线，若连续3次未收到同一节点正确遥测数据，则切换总线；二级CAN总线广播数据采用A、B交替发送",
    )).toEqual(["primary-can", "secondary-bus", "secondary-bus-switch"])
    // 切换语义依赖二级底座:一级语料里的"切换总线"不触发
    expect(detectInterfaceSectionTypes("通过CANA总线发送指令后切换总线")).toEqual(["primary-can"])
    // 广播A、B交替(无切换语义)不触发切换模型
    expect(detectInterfaceSectionTypes("二级CAN总线广播数据采用A、B交替发送")).toEqual(["primary-can", "secondary-bus"])
  })

  test("注入:标记被替换为检测到的分节内容;未检出分节则移除标记行", () => {
    const dir = mkdtempSync(join(tmpdir(), "iface-sec-"))
    try {
      const secDir = join(dir, "interface-sections")
      mkdirSync(secDir, { recursive: true })
      writeFileSync(join(secDir, "primary-can.md"), "### 一级CAN规则\n帧数与字段错误规则。", "utf-8")
      writeFileSync(join(secDir, "secondary-bus.md"), "### 二级总线测试模型\n触发→模拟应答。", "utf-8")

      const template = `### 通用规则\n共享内容。\n${INTERFACE_SECTIONS_MARKER}\n### 强制覆盖率检查`
      const both = injectInterfaceSections(template, {
        corpus: "通过二级CAN总线发送遥控指令",
        catalogDir: dir,
      })
      expect(both.prompt).toContain("### 二级总线测试模型")
      expect(both.prompt).toContain("### 一级CAN规则")
      expect(both.prompt).not.toContain(INTERFACE_SECTIONS_MARKER)
      expect(both.injected_sections).toEqual(["primary-can", "secondary-bus"])

      const primaryOnly = injectInterfaceSections(template, {
        corpus: "通过CANA总线发送遥测帧1轮询控制序列",
        catalogDir: dir,
      })
      expect(primaryOnly.prompt).toContain("### 一级CAN规则")
      expect(primaryOnly.prompt).not.toContain("二级总线测试模型")
      expect(primaryOnly.injected_sections).toEqual(["primary-can"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("兼容:模板无标记不做注入;分节目录缺失告警并跳过", () => {
    const untouched = injectInterfaceSections("无标记模板", { corpus: "二级CAN", catalogDir: "/tmp" })
    expect(untouched.prompt).toBe("无标记模板")
    expect(untouched.injected_sections).toEqual([])

    const dir = mkdtempSync(join(tmpdir(), "iface-miss-"))
    try {
      const missing = injectInterfaceSections(`模板\n${INTERFACE_SECTIONS_MARKER}`, {
        corpus: "二级CAN",
        catalogDir: dir,
      })
      expect(missing.warnings.some((w) => w.includes("接口分节文件缺失"))).toBe(true)
      expect(missing.prompt).not.toContain(INTERFACE_SECTIONS_MARKER)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

import { scoreKeywordCandidatesByAnchor, scanKeywordDirs, stepActionOnPrimaryBus, stepActionOnSecondaryBus } from "../../src/shared/testcase-keywords"

describe("二级CAN步骤关键字匹配(2026-08-25 错配修复:曾选中 发送CANATXT数据)", () => {
  const workdirKeywords = "/home/greatwall/桌面/测试用例生成Agent/00-git/workdir/.matrix/data/DTPProject/组合关键字"
  const hasLibrary = existsSync(workdirKeywords)

  test("二级应答步骤在锚点路径(channel=CANA)必须匹配二级关键字而非一级", () => {
    if (!hasLibrary) return // 无真实库环境时跳过(依赖工装目录)
    const catalog = scanKeywordDirs([workdirKeywords])
    // 2026-09-02 用户更新库:新一代连字符关键字 发送二级CAN-TXT数据 胜出
    // (旧 发送二级CANTXT数据 已被库移除)
    const ranked = scoreKeywordCandidatesByAnchor(
      "第1.1秒,通过二级CANA总线发送正确的二级CAN遥测轮询应答。\nCPU接收正确应答,更新一级CAN总线相应遥测。",
      catalog.keywordMap,
      { operation_type: "send_command", channel: "CANA" },
      5,
    )
    expect(ranked[0]?.keywordName).toBe("发送二级CAN-TXT数据")
  })

  test("一级触发步骤(结果从句提及二级转发)必须匹配一级关键字而非二级(2026-08-26 事故)", () => {
    if (!hasLibrary) return
    const catalog = scanKeywordDirs([workdirKeywords])
    // 当日真实触发步骤:动作在 CANA,结果从句"触发软件通过二级CAN总线…发送遥控指令"
    // 2026-09-02 用户拍板:载荷经数据文件承载,"_数据文件"变体压过同名基础变体
    const trigger =
      "第3.0秒，通过CANA总线发送间接指令触发，触发软件通过二级CAN总线向目标节点发送遥控指令。\n软件接收一级CANA总线间接指令，按二级CAN协议组装遥控指令帧并通过二级CAN总线向目标节点转发。"
    const byAnchor = scoreKeywordCandidatesByAnchor(trigger, catalog.keywordMap, { operation_type: "send_command", channel: "CANA" }, 3)
    expect(byAnchor[0]?.keywordName).toBe("发送CANA数据_数据文件")
  })

  test("动作从句层级判定:触发步骤在一级,模拟应答在二级", () => {
    const trigger = "第3.0秒，通过CANA总线发送间接指令触发，触发软件通过二级CAN总线向目标节点发送遥控指令。"
    expect(stepActionOnPrimaryBus(trigger)).toBe(true)
    expect(stepActionOnSecondaryBus(trigger)).toBe(false)
    const response = "第3.5秒，通过二级CAN总线发送全部正确的遥控指令应答（仲裁场、控制场、LENGTH、TITLE、INDEX、SUM均正确）。"
    expect(stepActionOnSecondaryBus(response)).toBe(true)
    expect(stepActionOnPrimaryBus(response)).toBe(false)
    const secondaryA = "第1.1秒，通过二级CANA总线发送正确的二级CAN遥测轮询应答。"
    expect(stepActionOnSecondaryBus(secondaryA)).toBe(true)
    expect(stepActionOnPrimaryBus(secondaryA)).toBe(false)
  })
})
