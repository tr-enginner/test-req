import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { prepareInterfaceTestContent, getInterfaceTestWorkerBatch, finalizeInterfaceTestContent } from "../../src/tools/interface-test-workflow"
import { readZip } from "../../src/tools/docx-zip"
import { InterfaceTestContent, InterfaceTestGaps, InterfaceTestPlan } from "../../src/schema/interface-test-content"
import { describePhase2Editor, applyPhase2Editor } from "../../src/tools/phase2-editor"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "interface-test-content-")); dirs.push(dir)
  mkdirSync(join(dir, ".matrix", "data"), { recursive: true })
  writeFileSync(join(dir, ".matrix", "data", "functional-test-content.json"), "{}")
  const structurePath = join(dir, ".matrix", "data", "req-document-structure.json")
  writeFileSync(structurePath, JSON.stringify({ sections: [{
    section_id: "SRS-3.2", source_ref: "primary::SRS-3.2", title: "功能需求", level: 1,
    section_path_titles: ["功能需求"],
    text: "管理控制器通过一级CAN接收遥控指令。字段正确时执行指令，字段错误时丢弃并增加错误计数。\n外部设备通过SPI发送状态查询请求；请求正确时软件返回状态应答，站地址、类型、LENGTH或SUM错误时不应答。",
    tables: [],
  }, {
    section_id: "SRS-3.3", source_ref: "primary::SRS-3.3", title: "遥测接口", level: 1,
    section_path_titles: ["遥测接口"],
    text: "快帧遥测和慢帧遥测通过一级CAN发送，采用相同发送处理和错误处置。",
    tables: [],
  }] }, null, 2))
  writeFileSync(join(dir, ".matrix", "data", "source-artifacts.json"), JSON.stringify({
    primary_document: { role: "primary", path: join(dir, "requirements.docx"), structure_path: structurePath },
    supporting_documents: [],
  }, null, 2))
  writeFileSync(join(dir, ".matrix", "data", "hardware-interface-report-text.md"), [
    "# 硬件接口", "## 3.1.1 CAN总线接口及相关数据流", "### 快帧遥测和慢帧遥测", "表3.1.1-1 快帧遥测数据帧格式", "表3.1.1-2 慢帧遥测数据帧格式", "快帧和慢帧采用相同发送处理，包含ID、LENGTH、TITLE和SUM。",
    "## SPI总线接口", "### 状态查询请求及应答", "表3.1.2-1 状态查询请求格式", "表3.1.2-2 状态应答格式", "外部设备发送状态查询请求，软件返回状态应答。",
  ].join("\n"))
  return { dir, ctx: { directory: dir, worktree: dir } as any }
}

describe("interface test workflow", () => {
  for (const withPreviousPlan of [false, true]) {
    test(`empty hardware interfaces finalize successfully (previous plan: ${withPreviousPlan})`, async () => {
      const { dir, ctx } = fixture()
      const data = join(dir, ".matrix", "data")
      const discoveryPath = join(data, "interface-test-identifiers.json")
      let staleRawPath: string | undefined
      if (withPreviousPlan) {
        writeFileSync(discoveryPath, JSON.stringify({ interfaces: [{
          interface_id: "IF-CAN0-001", interface_name: "CAN", section_titles: ["CAN"], order: 0,
        }], open_questions: [] }))
        const previous = JSON.parse(await prepareInterfaceTestContent(ctx))
        const previousBatch = JSON.parse(await getInterfaceTestWorkerBatch(previous.worker_batches[0].batch_index, ctx)).worker_batch
        staleRawPath = previousBatch.output_path
        const target = previousBatch.worker_payload.target_interface_batch
        writeFileSync(staleRawPath!, JSON.stringify({
          batch_id: target.batch_id, interface_id: target.interface_id, interface_name: target.interface_name,
          rows: [{ interface_requirement_description: "旧接口需求", test_requirement_id: "AUTO_TR_JK",
            source_refs: ["primary::SRS-3.2"], related_description: "旧接口说明",
            interface_name: target.interface_name, interface_id: target.interface_id }], open_questions: [],
        }))
        await finalizeInterfaceTestContent(ctx)
      }
      writeFileSync(join(data, "hardware-interface-report-text.md"), "## 3.1 硬件接口\n未识别到可展示的硬件接口内容。")
      const discovery = JSON.stringify({ interfaces: [], open_questions: ["本项目无硬件接口。"] })
      writeFileSync(discoveryPath, discovery)
      for (let attempt = 0; attempt < 2; attempt++) {
        const prepared = JSON.parse(await prepareInterfaceTestContent(ctx))
        expect(prepared.ok).toBe(true)
        expect(prepared.mode).toBe("prepare_interface_test_content")
        expect(prepared.worker_batches).toEqual([])
        expect(prepared.summary).toEqual({ batch_count: 0, worker_batch_count: 0, reused_batch_count: 0 })
        const plan = InterfaceTestPlan.parse(JSON.parse(readFileSync(prepared.output.interface_test_plan_path, "utf-8")))
        expect(plan.batches).toEqual([])
        expect(plan.reused_batch_ids).toEqual([])
        const finalized = JSON.parse(await finalizeInterfaceTestContent(ctx))
        expect(finalized.ok).toBe(true)
        expect(finalized.mode).toBe("finalize_interface_test_content")
        const model = InterfaceTestContent.parse(JSON.parse(readFileSync(finalized.output.interface_test_content_path, "utf-8")))
        expect(model.rows).toEqual([])
        expect(model.summary).toEqual({ total: 0, gap_count: 0, reused_batch_count: 0 })
        const gaps = InterfaceTestGaps.parse(JSON.parse(readFileSync(finalized.output.interface_test_gaps_path, "utf-8")))
        expect(gaps.gaps).toEqual([])
        expect(gaps.summary.total).toBe(0)
        const xml = readZip(readFileSync(finalized.output.interface_test_report_path)).get("word/document.xml")!.toString("utf-8")
        expect(xml).toContain("共总结如下 0 项接口需求")
        expect(xml).not.toContain("旧接口需求")
        expect(readFileSync(discoveryPath, "utf-8")).toBe(discovery)
        if (staleRawPath) expect(existsSync(staleRawPath)).toBe(true)
      }
    })
  }

  test("prepare enforces 4.1, source artifacts, and hardware interface derived text prerequisites", async () => {
    const { dir, ctx } = fixture()
    rmSync(join(dir, ".matrix", "data", "functional-test-content.json"))
    const result = JSON.parse(await prepareInterfaceTestContent(ctx))
    expect(result.missing_prerequisite).toBe("functional_test_content")
  })

  test("prepares topic batches, finalizes IDs and renders standalone 4.3 DOCX", async () => {
    const { ctx } = fixture()
    const discoveryPrep = JSON.parse(await prepareInterfaceTestContent(ctx))
    expect(discoveryPrep.awaiting_interface_identifier_discovery).toBe(true)
    expect(discoveryPrep.interface_identifier_discovery_batch.subagent_type).toBe("interface-test-identifier-discoverer")
    writeFileSync(discoveryPrep.output.interface_test_identifier_discovery_path, JSON.stringify({
      interfaces: [
        { interface_id: "IF-CAN0-001", interface_name: "3.1.1 CAN总线接口及相关数据流", section_titles: ["快帧遥测", "慢帧遥测"], order: 0 },
        { interface_id: "IF-CAN0-001", interface_name: "CAN总线接口", section_titles: ["另一主题"], order: 1 },
        { interface_id: "IF-SPI-001", interface_name: "SPI总线接口", section_titles: ["轮询指令及应答"], order: 2 },
      ],
      open_questions: [],
    }, null, 2))
    const hardwareTextPath = join(ctx.directory, ".matrix", "data", "hardware-interface-report-text.md")
    writeFileSync(hardwareTextPath, `${readFileSync(hardwareTextPath, "utf-8")}\n`)
    const prepared = JSON.parse(await prepareInterfaceTestContent(ctx))
    expect(prepared.ok).toBe(true)
    expect(JSON.stringify(prepared).length).toBeLessThan(10000)
    expect(prepared.worker_batches.every((batch: any) => batch.worker_prompt === undefined)).toBe(true)
    expect(prepared.awaiting_interface_identifier_discovery).toBeUndefined()
    expect(prepared.worker_batches).toHaveLength(2)
    const plan = JSON.parse(readFileSync(prepared.output.interface_test_plan_path, "utf-8"))
    expect(plan.version).toBe("2.2")
    expect(plan.functional_source_hash).toBeUndefined()
    expect(plan.hardware_interface_hash).toBeUndefined()
    expect(plan.plan_hash).toBeUndefined()
    for (const batch of plan.batches) {
      expect(batch.functional_source_hash).toBeUndefined()
      expect(batch.hardware_interface_hash).toBeUndefined()
      expect(batch.plan_hash).toBeUndefined()
      expect(batch.skill_version).toBeUndefined()
      expect(batch.prompt_version).toBeUndefined()
    }
    const can = JSON.parse(await getInterfaceTestWorkerBatch(prepared.worker_batches[0].batch_index, ctx)).worker_batch
    const spi = JSON.parse(await getInterfaceTestWorkerBatch(prepared.worker_batches[1].batch_index, ctx)).worker_batch
    expect(can.worker_payload.target_interface_batch.interface_name).toBe("CAN总线接口")
    expect(can.worker_payload.target_interface_batch.batch_id).toBe("IF-CAN0-001")
    expect(can.worker_payload.target_interface_batch.topic).toContain("快帧遥测")
    expect(can.worker_payload.target_interface_batch.topic).toContain("慢帧遥测")
    expect(spi.worker_payload.target_interface_batch.batch_id).toBe("IF-SPI-001")
    expect(can.worker_payload.target_interface_batch.functional_source_hash).toBeUndefined()
    expect(can.worker_payload.target_interface_batch.hardware_interface_hash).toBeUndefined()
    expect(can.worker_payload.target_interface_batch.plan_hash).toBeUndefined()
    expect(can.worker_payload.target_interface_batch.skill_version).toBeUndefined()
    expect(can.worker_payload.target_interface_batch.prompt_version).toBeUndefined()
    expect(can.worker_payload.target_interface_batch.directions).toBeUndefined()
    expect(can.worker_prompt).not.toContain("functional_source_hash")
    expect(can.worker_prompt).not.toContain("hardware_interface_hash")
    expect(can.worker_prompt).not.toContain("plan_hash")
    expect(can.worker_prompt).not.toContain("skill_version")
    expect(can.worker_prompt).not.toContain("prompt_version")
    expect(can.worker_prompt).not.toContain('"directions"')
    expect(can.worker_prompt).toContain("成对提取正常与异常行为")
    expect(can.worker_prompt).toContain("两侧均有证据时合并在同一row")
    expect(can.worker_prompt).toContain("不得写接收后的业务执行")
    expect(can.worker_prompt).toContain("只有正常证据只写“接口正常情况的测试”并在open_questions记录异常条件或响应缺口")
    expect(can.worker_prompt).toContain("只有异常证据只写“接口异常（明确字段）情况的测试”")
    expect(can.worker_prompt).toContain("不得用协议常识补写丢弃、不应答或错误应答")
    expect(can.worker_prompt).toContain("请求—应答类正文只写收到符合请求表格式的请求时按应答表返回什么")
    expect(can.worker_prompt).toContain("不得写接收后的业务执行、解析暂存、计算、模式切换、内部状态或存储")
    expect(can.worker_prompt).toContain("内部错误计数和日志不写入正文")
    expect(can.worker_prompt).toContain("错误字段集合及错误应答建立合并签名")
    expect(can.worker_prompt).toContain("单向输出处理族只生成一行")
    expect(can.worker_prompt).toContain("第三章硬件接口表格是数据帧格式的唯一展示位置")
    expect(can.worker_prompt).toContain("请求—应答类接口TR必须引用请求与应答的真实明确表号")
    expect(can.worker_prompt).toContain("不得复制Byte/W字节位置")
    expect(can.worker_prompt).toContain("请求与响应使用不同格式表时分别引用各自表号")
    expect(can.worker_prompt).toContain("缺失表号及已搜索关键词")
    expect(can.worker_prompt).toContain("建立合并签名并分组")
    expect(can.worker_prompt).toContain("快帧遥测与慢帧遥测等单向输出处理族只生成一行")
    expect(can.worker_prompt).toContain("多个显式来源TR号用“、”连接")
    expect(can.worker_prompt).toContain("不得先按消息名生成多行后依赖finalize文本去重")
    for (const [batch, sourceId] of [[can, ""], [spi, "TR-GN-POLL-001、TR-GN-POLL-002"]] as const) {
      const target = batch.worker_payload.target_interface_batch
      const isCan = target.interface_id === "IF-CAN0-001"
      const rows = [{
        interface_requirement_description: isCan
          ? `软件通过${target.interface_name}向星务计算机发送快帧遥测和慢帧遥测，分别采用表3.1.1-1和表3.1.1-2规定的数据帧格式。`
          : `通过${target.interface_name}收到符合表3.1.2-1规定格式的状态查询请求时，按照表3.1.2-2返回状态应答；收到站地址、类型、LENGTH或SUM错误的请求时不应答。`,
        test_requirement_id: sourceId || "AUTO_TR_JK",
        source_refs: isCan ? ["primary::SRS-3.2", "primary::SRS-3.3"] : ["primary::SRS-3.2"],
        related_description: isCan
          ? "a. 接口信息格式及内容的测试；\nb. 接口正常情况的测试；"
          : "a. 接口信息格式及内容的测试；\nb. 接口正常/异常（站地址、类型、LENGTH、SUM）情况的测试；",
        interface_name: target.interface_name,
        interface_id: target.interface_id,
      }]
      writeFileSync(batch.output_path, JSON.stringify({
        batch_id: target.batch_id, interface_name: target.interface_name, interface_id: target.interface_id,
        rows,
        open_questions: [],
      }, null, 2))
      const raw = JSON.parse(readFileSync(batch.output_path, "utf-8"))
      expect(Object.keys(raw)).toEqual(["batch_id", "interface_name", "interface_id", "rows", "open_questions"])
    }
    const finalized = JSON.parse(await finalizeInterfaceTestContent(ctx))
    expect(finalized.ok).toBe(true)
    const model = JSON.parse(readFileSync(finalized.output.interface_test_content_path, "utf-8"))
    expect(model.rows).toHaveLength(2)
    expect(model.rows[0].test_requirement_id).toBe("TR-JK-001")
    expect(model.rows[1].test_requirement_id).toBe("TR-GN-POLL-001、TR-GN-POLL-002")
    expect(model.rows[0].interface_requirement_description).toContain("快帧遥测和慢帧遥测")
    expect(model.rows[0].interface_requirement_description).toContain("表3.1.1-1和表3.1.1-2")
    expect(model.rows[0].source_refs).toEqual(["primary::SRS-3.2", "primary::SRS-3.3"])
    expect(model.rows[0].interface_requirement_description).not.toContain("Byte1")
    expect(model.rows[0].related_description).toContain("接口正常情况的测试")
    expect(model.rows[0].interface_requirement_description).not.toContain("共同校验字段")
    expect(model.rows[1].related_description).toContain("接口正常/异常（站地址、类型、LENGTH、SUM）")
    expect(model.rows[1].interface_requirement_description).toContain("返回状态应答")
    expect(model.rows[1].interface_requirement_description).toContain("请求时不应答")
    expect(model.rows[1].interface_requirement_description).not.toContain("执行指令")
    expect(model.rows[1].interface_requirement_description).not.toContain("错误计数")
    expect(model.summary.gap_count).toBe(0)
    const gaps = JSON.parse(readFileSync(finalized.output.interface_test_gaps_path, "utf-8"))
    expect(gaps.gaps).toHaveLength(0)
    expect(Object.keys(model.rows[0])).toEqual([
      "interface_requirement_description", "test_requirement_id", "source_refs", "related_description", "interface_name", "interface_id",
    ])
    expect(model.test_requirements).toEqual({ sufficiency: "C1、C2", termination: "Z1、Z2", priority: "高优先级" })
    expect(existsSync(finalized.output.interface_test_report_path)).toBe(true)
    const zip = readZip(readFileSync(finalized.output.interface_test_report_path))
    const xml = zip.get("word/document.xml")?.toString("utf-8") || ""
    expect(xml).toContain("4.3 接口测试")
    expect(xml).toContain("表4.3-1  接口需求项总结表")
    expect(xml).toContain("对应测试需求标识")
    expect(xml).toContain("测试充分性要求：C1、C2")
    expect(xml).not.toContain("<w:shd")
    expect(xml).toContain('<w:jc w:val="left"/>')
    expect(xml).toContain('<w:jc w:val="both"/>')
    expect(xml).toContain('<w:top w:val="single" w:sz="12" w:color="000000"/>')
    expect(xml).toContain('<w:right w:val="single" w:sz="12" w:color="000000"/>')
    expect(xml).toContain('<w:spacing w:before="0" w:after="0" w:line="360" w:lineRule="auto"/>')
    expect(xml).toContain('<w:sz w:val="21"/>')

    const reused = JSON.parse(await prepareInterfaceTestContent(ctx))
    expect(reused.worker_batches).toHaveLength(0)
    expect(reused.summary.reused_batch_count).toBe(2)

    writeFileSync(prepared.output.interface_test_plan_path, JSON.stringify({ ...plan, version: "2.1" }, null, 2))
    const stalePlan = JSON.parse(await prepareInterfaceTestContent(ctx))
    expect(stalePlan.worker_batches).toHaveLength(0)
    expect(stalePlan.summary.reused_batch_count).toBe(2)
    const canRaw = JSON.parse(readFileSync(can.output_path, "utf-8"))
    const spiRaw = JSON.parse(readFileSync(spi.output_path, "utf-8"))
    delete canRaw.rows[0].test_requirement_id
    delete canRaw.rows[0].interface_id
    spiRaw.rows[0].test_requirement_id = "TR-JK-001"
    writeFileSync(can.output_path, JSON.stringify(canRaw))
    writeFileSync(spi.output_path, JSON.stringify(spiRaw))
    expect(JSON.parse(await prepareInterfaceTestContent(ctx)).worker_batches).toHaveLength(0)
    const repaired = JSON.parse(await finalizeInterfaceTestContent(ctx))
    const repairedModel = JSON.parse(readFileSync(repaired.output.interface_test_content_path, "utf-8"))
    expect(repairedModel.rows.map((row: any) => row.test_requirement_id)).toEqual(["TR-JK-002", "TR-JK-001"])
    expect(repairedModel.rows[0].interface_id).toBe(can.worker_payload.target_interface_batch.interface_id)
    const editRequest = {directory: ctx.directory, artifact: "interface-test-content.json", business_id: "TR-JK-002"}
    const descriptor = describePhase2Editor(editRequest)
    expect(descriptor.editable).toBe(true)
    applyPhase2Editor({...editRequest, operation: "update", expected_revision: descriptor.revision, value: {source_refs: []}})
    expect(JSON.parse(readFileSync(can.output_path, "utf8")).rows[0].source_refs).toEqual([])
  })

  test("redispatches identifier discovery only when the existing artifact is invalid", async () => {
    const { dir, ctx } = fixture()
    const identifierPath = join(dir, ".matrix", "data", "interface-test-identifiers.json")
    writeFileSync(identifierPath, JSON.stringify({ interfaces: [{ interface_id: "broken" }] }))

    const prepared = JSON.parse(await prepareInterfaceTestContent(ctx))

    expect(prepared.ok).toBe(true)
    expect(prepared.awaiting_interface_identifier_discovery).toBe(true)
    expect(prepared.interface_identifier_discovery_batch.output_path).toBe(identifierPath)
  })

  test("finalize skips invalid source refs and retains the interface row", async () => {
    const { dir, ctx } = fixture()
    const data = join(dir, ".matrix", "data")
    writeFileSync(join(data, "interface-test-identifiers.json"), JSON.stringify({
      interfaces: [{ interface_id: "IF-CAN0-001", interface_name: "CAN总线接口", section_titles: ["快帧遥测"], order: 0 }],
      open_questions: [],
    }))
    const prepared = JSON.parse(await prepareInterfaceTestContent(ctx))
    const batch = JSON.parse(await getInterfaceTestWorkerBatch(prepared.worker_batches[0].batch_index, ctx)).worker_batch
    const target = batch.worker_payload.target_interface_batch
    writeFileSync(batch.output_path, JSON.stringify({
      batch_id: target.batch_id,
      interface_name: target.interface_name,
      interface_id: target.interface_id,
      rows: [{
        interface_requirement_description: "CAN接口需求。",
        test_requirement_id: "AUTO_TR_JK",
        source_refs: ["primary::SRS-UNKNOWN"],
        related_description: "接口测试。",
        interface_name: target.interface_name,
        interface_id: target.interface_id,
      }],
      open_questions: [],
    }))

    expect(JSON.parse(await finalizeInterfaceTestContent(ctx)).ok).toBe(true)
    const final = JSON.parse(readFileSync(join(ctx.directory, ".matrix/data/interface-test-content.json"), "utf-8"))
    expect(final.rows).toHaveLength(1)
    expect(final.rows[0].source_refs).toEqual([])
  })
})
