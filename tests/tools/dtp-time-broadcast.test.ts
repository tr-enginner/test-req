import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  buildDtpProtocolDefinitionsDocument, buildGeneratedStepWithPlanning,
  prepareProjectDataFileIndex, resolveDefaultPaths, selectCaseProtocolSectionIds,
  type DocsContext, type ProjectKnowledgeIndex,
} from "../../src/tools/dtp-data-generation-core"

const docs: DocsContext = {
  backgroundDocs: [], hardwareDocs: [], protocolDocs: [], conventionDocs: [],
  packetStructureDocs: [], formatRuleDocs: [], requirementDocs: [],
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dtp-time-broadcast-"))
  mkdirSync(join(root, ".matrix", "data", "DTPProject"), { recursive: true })
  const index: ProjectKnowledgeIndex = {
    schema_version: "1.0.0", extractor_version: "test", project_root: root,
    source_documents: [], topics: [], packet_model_candidates: [], references: [], warnings: [],
    updated_at: new Date().toISOString(),
    snippets: [
      { id: "doc-1-snippet-1", source_document_id: "doc-1", topic: "hardware_interface", text: "IF-CAN0-001：一级CAN总线接口，SJA1000T，标准PELICAN模式。", confidence: 1 },
      { id: "doc-1-snippet-2", source_document_id: "doc-1", topic: "requirement_input_flow", text: "输入流：星务时间广播数据。通过二级CAN总线透明转发。", confidence: 1 },
      { id: "doc-1-snippet-3", source_document_id: "doc-1", topic: "packet_structure", text: "表7.2-1 星务时间广播格式", confidence: 1 },
    ],
    tables: [{
      id: "doc-1-table-1", source_document_id: "doc-1", caption: "表7.2-1 星务时间广播格式",
      topic: "packet_structure", aliases: [], confidence: 1, warnings: [],
      rows: [
        ["帧序号", "仲裁场、控制场", "", "有效数据场", "", "", "", "", "", "", ""],
        ["", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"],
        ["", "ID10～ID3", "ID2～ID0，RTR，DLC", "", "", "", "", "", "", "", ""],
        ["1", "4FH", "28H", "00", "L08H", "T40H", "W0", "W1", "W2", "W3", "W4"],
        ["2", "4FH", "25H", "01", "W5", "W6", "W7", "SUM", "-", "-", "-"],
      ],
    }],
    section_protocol_models: [{
      id: "time-section", source_document_id: "doc-1", section_id: "7.2", section_title: "7.2 星务时间广播格式",
      section_path: [], chapter_role: "other", content_role: "frame_definition",
      section_snippet_ids: ["doc-1-snippet-2", "doc-1-snippet-3"],
      input_flow_snippet_ids: ["doc-1-snippet-2", "doc-1-snippet-3"], output_flow_snippet_ids: [],
      table_ids: ["doc-1-table-1"], primary_table_ids: ["doc-1-table-1"], support_table_ids: [],
      protocol_relations: [{
        frame_table_id: "doc-1-table-1", generation_mode: "frame_file", preferred_name: "星务时间广播数据",
        flow_direction: "input", source_flow_heading: "输入流", should_generate_frame_table_file: true,
        checksum_rule: "SUM = low8(byte-sum(TITLE + W0 + W1 + ... + W(n-1)))", confidence: 1, reasoning: [],
      }],
      protocols: [{
        name: "星务时间广播数据", frame_table_id: "doc-1-table-1", data_dictionary_table_ids: [],
        generation_mode: "frame_file", flow_direction: "input", source_flow_heading: "输入流",
        should_generate_frame_table_file: true, basis: ["doc-1-table-1"], confidence: 1,
      }],
      confidence: 1, warnings: [],
    }],
  }
  return { root, index, paths: resolveDefaultPaths(root) }
}

async function generator() {
  const f = fixture()
  const definitions = await buildDtpProtocolDefinitionsDocument(f.paths, f.index)
  const dataFileIndex = prepareProjectDataFileIndex(f.paths, docs)
  const generate = async (description: string, stepIndex = 1, hooks?: Parameters<typeof buildGeneratedStepWithPlanning>[1]) => {
    const step = await buildGeneratedStepWithPlanning({
      workspaceRoot: f.root, inputDataRoot: f.paths.inputDataRoot,
      knowledgeIndex: f.index, protocolDefinitions: definitions, dataFileIndex, docsContext: docs,
      caseContext: { caseId: "TC-TIME", requirementIds: [], steps: [] },
      keywordDef: { keywordName: "发送CAN数据文件", txtPath: "", jsonPath: "", arguments: [{ name: "${para2}", comments: "数据文件" }] },
      step: { stepIndex, keywordName: "发送CAN数据文件", stepDescription: description, timeValue: stepIndex },
    }, hooks)
    const file = step.generated_data_files[0]
    const bytes = readFileSync(join(f.paths.dtpRoot, "V1", file.file_path.replace(/\\+/g, "/")), "utf8").trim().split(/\r?\n/)
    return { step, bytes }
  }
  return { ...f, definitions, generate }
}

describe("time broadcast protocol identity", () => {
  test("selects a linked frame table without title keywords and ignores a forwarding destination", () => {
    const { index } = fixture()
    const queries = ["通过CANA总线发送正确的星务时间广播数据"]
    const summary = structuredClone(index.section_protocol_models[0])
    summary.id = "summary"
    summary.section_title = "需求项总结表"
    summary.content_role = "requirement_summary"
    index.section_protocol_models.push(summary)
    expect(selectCaseProtocolSectionIds(index, queries)).toEqual(["time-section"])
    // Another recovered chapter must not hide an exact frame match with missing ancestry.
    const other = structuredClone(index.section_protocol_models[0])
    other.id = "other-chapter"
    other.section_id = "8.1"
    other.section_title = "8.1 遥控指令"
    other.chapter_role = "interface_requirement"
    other.protocols = []
    other.primary_table_ids = []
    other.table_ids = []
    index.section_protocol_models.push(other)
    expect(selectCaseProtocolSectionIds(index, queries)).toContain("time-section")
  })

  test("compiles the owning CAN interface and two frames with no trailing dash padding", async () => {
    const { definitions, generate } = await generator()
    expect(definitions.protocols[0].bus_context).toMatchObject({ bus_type: "CAN", interface_level: "primary" })
    let calls = 0
    const result = await generate("通过CANB总线发送正确的星务时间广播数据（全部帧字段正确）", 1, {
      planCaseStepData: async () => { calls++; return {} },
    })
    expect(result.bytes).toEqual(["08 4F 28 00 08 40 00 00 00 00 00", "05 4F 25 01 00 00 00 40"])
    expect(result.step.generated_data_files[0].flow_direction).toBe("input")
    expect(result.step.generated_data_files[0].requested_file_name).toBe("S01-星务时间广播数据-正常.txt")
    expect(result.step.data_quality?.status, JSON.stringify(result.step.data_quality)).not.toBe("failed")
    expect(calls).toBe(0)
  })

  test.each([
    ["首帧仲裁场错误", "ARBITRATION", 1],
    ["首帧控制场错误", "CONTROL", 1],
    ["尾帧控制场错误", "CONTROL", 2],
    ["TITLE字段错误", "TITLE", 1],
    ["LENGTH字段错误", "LENGTH", 1],
    ["首帧INDEX字段错误", "FRAME_SEQUENCE", 1],
  ] as const)("locates %s in the canonical frame", async (fault, field, frameIndex) => {
    const { generate } = await generator()
    const baseline = await generate("通过CANA总线发送正确的星务时间广播数据")
    const result = await generate(`通过CANA总线发送星务时间广播数据（${fault},其余字段正确）`, 2)
    expect(result.step.data_generation_plan?.mutations).toContainEqual(expect.objectContaining({ field }))
    expect(result.step.data_quality?.status, JSON.stringify(result.step.data_quality)).not.toBe("failed")
    expect(result.bytes).toHaveLength(2)
    expect(result.bytes[frameIndex - 1]).not.toBe(baseline.bytes[frameIndex - 1])
    // TITLE participates in the package checksum in the tail frame.
    if (field !== "TITLE") expect(result.bytes[2 - frameIndex]).toBe(baseline.bytes[2 - frameIndex])
    if (field === "TITLE") expect(result.bytes).toEqual([
      "08 4F 28 00 08 41 00 00 00 00 00", "05 4F 25 01 00 00 00 41",
    ])
  })

  test("changes SUM only for a checksum fault", async () => {
    const { generate } = await generator()
    const baseline = await generate("通过CANA总线发送正确的星务时间广播数据")
    const result = await generate("通过CANA总线发送星务时间广播数据（SUM字段错误,其余字段正确）", 2)
    expect(result.bytes[0]).toBe(baseline.bytes[0])
    expect(result.bytes[1].split(" ").slice(0, -1)).toEqual(baseline.bytes[1].split(" ").slice(0, -1))
    expect(result.bytes[1]).not.toBe(baseline.bytes[1])
    expect(result.step.data_quality?.status).not.toBe("failed")
  })

  test("does not relax malformed DLC checks for normal steps", async () => {
    const { definitions, generate } = await generator()
    const frame = definitions.protocols[0].frames![0]
    frame.byte_layout[1] = "29"
    frame.field_layout.find(field => field.name === "CONTROL")!.default_value = "29"
    const { step } = await generate("通过CANA总线发送正确的星务时间广播数据")
    expect(step.data_quality?.issues).toContainEqual(expect.objectContaining({ type: "dlc_out_of_range", severity: "error" }))
    expect(step.data_quality?.status).toBe("failed")
  })

  test("reports nonexistent middle frames and unscoped INDEX errors without labelling them normal", async () => {
    const { generate } = await generator()
    const baseline = await generate("通过CANA总线发送正确的星务时间广播数据", 10)
    for (const [i, fault] of ["中间帧仲裁场错误", "INDEX字段错误"].entries()) {
      const { step, bytes } = await generate(`通过CANA总线发送星务时间广播数据（${fault},其余字段正确）`, i + 1)
      expect(step.data_quality?.status).toBe("failed")
      expect(step.data_quality?.issues).toContainEqual(expect.objectContaining({ type: "semantic_fault_without_mutation" }))
      expect(step.generated_data_files[0].requested_file_name).not.toContain("-正常")
      expect(bytes).toEqual(baseline.bytes)
    }
  })

  test("accepts documented aliases without requiring an identical display name", async () => {
    const { definitions, generate } = await generator()
    definitions.protocols[0].base_file_name = "航天器授时包"
    definitions.protocols[0].aliases = ["星务时间广播数据"]
    definitions.protocols[0].source_section = "授时服务"
    definitions.protocols[0].evidence = []
    const { step, bytes } = await generate("通过CANA总线发送正确的星务时间广播数据")
    expect(step.data_generation_plan?.protocol_id).toBe(definitions.protocols[0].protocol_id)
    expect(step.data_quality?.status).not.toBe("failed")
    expect(bytes).toHaveLength(2)
  })

  test("rejects an unrelated model protocol even when all suitable candidates are missing", async () => {
    const { definitions, generate } = await generator()
    const unrelated = definitions.protocols[0]
    unrelated.protocol_id = "uplink-249"
    unrelated.base_file_name = "249字节上行数据块"
    unrelated.source_section = "上行数据块"
    unrelated.aliases = []
    unrelated.evidence = []
    let candidateIds: string[] = []
    let calls = 0
    const { step } = await generate("通过CANB总线发送正确的星务时间广播数据", 1, {
      planCaseStepData: async input => {
        calls++
        candidateIds = input.model_fallback?.candidate_protocols.map(p => p.protocol_id) ?? []
        return {
          protocol_id: "uplink-249", protocol_name: "249字节上行数据块", base_file_name: "249字节上行数据块.txt",
          bus: "CAN", flow_direction: "input", variant_type: "correct", mutations: [], sequence_operations: [],
          checksum_policy: "recalculate_correctly", confidence: 0.9, warnings: [],
        }
      },
    })
    expect(candidateIds).not.toContain("uplink-249")
    expect(calls).toBeGreaterThan(0)
    expect(step.data_generation_plan?.protocol_id).not.toBe("uplink-249")
    expect(step.generated_data_files[0].requested_file_name).not.toContain("上行数据块")
    expect(step.data_quality?.status).toBe("failed")
  })
})
