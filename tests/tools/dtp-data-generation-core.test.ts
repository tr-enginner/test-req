import { describe, expect, test } from "bun:test"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { dirname, join, resolve } from "path"
import {
  buildDtpProtocolDefinitionsDocument,
  buildDtpTableEvidenceIndex,
  buildDocumentReferenceGraph,
  buildProtocolEvidenceTrace,
  buildDtpModelFallbackEvidenceIndex,
  buildDtpProtocolContextPackages,
  buildDtpDataQualityReport,
  buildDtpProtocolRetryContext,
  buildDtpProtocolWriterPreview,
  buildCommandDictionaryIndex,
  buildGeneratedStep,
  buildGeneratedStepWithPlanning,
  buildProjectKnowledgeIndex,
  createDtpDataModelHooks,
  ensureDtpProtocolDefinitions,
  extractReferencesFromText,
  generateDataFile,
  loadConfirmationCases,
  loadConfirmationCasesWithStatus,
  loadGeneratedDataFileIndex,
  normalizeWorkspaceRoot,
  prepareProjectKnowledgeIndex,
  prepareProjectDataFileIndex,
  resolveDefaultPaths,
  resolveKnowledgeReferences,
  runDtpCaseDataInstantiation,
  runDtpProjectDataFilesGeneration,
  selectCaseProtocolSectionIds,
  writeDtpProtocolDataFiles,
  writeGeneratedTestData,
  type DataFileIntent,
  type DocsContext,
  type DtpProtocolDefinitionsDocument,
  type GeneratedDataFileIndex,
  type ProjectKnowledgeIndex,
} from "../../src/tools/dtp-data-generation-core"
import {
  prepareProtocolUnderstandingContexts,
  prepareRequestedProtocolEvidenceContext,
  prepareSectionRelationModelInputs,
} from "../../src/tools/dtp-model-evidence"
import { createDtpModelFallbackProfileRegistry } from "../../src/tools/dtp-bus-adapters"
import {
  loadDtpProtocolDefinitions,
  migrateDtpProtocolDefinitionsDocument,
  validateDtpProtocolDefinitions,
} from "../../src/tools/dtp-protocol-definitions"

describe("DTP workspace boundary", () => {
  test("uses the OpenCode workspace without scanning sibling projects", () => {
    const parent = mkdtempSync(join(tmpdir(), "dtp-workspace-boundary-"))
    const workspace = join(parent, "active-project")
    const sibling = join(parent, "other-project")
    mkdirSync(workspace, { recursive: true })
    mkdirSync(join(sibling, ".matrix", "data", "DTPProject"), { recursive: true })

    expect(normalizeWorkspaceRoot(undefined, workspace)).toBe(resolve(workspace))
    expect(normalizeWorkspaceRoot(".", workspace)).toBe(resolve(workspace))
    expect(() => normalizeWorkspaceRoot(sibling, workspace)).toThrow(
      "project_dir must match the current OpenCode workspace",
    )
  })

  test("runs DTP model prompts in an isolated child session", async () => {
    let createBody: Record<string, unknown> | undefined
    let promptBody: Record<string, unknown> | undefined
    const client = {
      session: {
        message: async () => ({ data: { info: { providerID: "test-provider", modelID: "test-model" } } }),
        create: async (request: any) => {
          createBody = request.body
          return { data: { id: "isolated-dtp-session" } }
        },
        prompt: async (request: any) => {
          promptBody = request.body
          return {
            data: {
              info: {},
              parts: [{ type: "text", text: JSON.stringify({ protocol_name: "test-protocol" }) }],
            },
          }
        },
        abort: async () => ({ data: true }),
        delete: async () => ({ data: true }),
      },
      config: { get: async () => ({ data: {} }) },
    }
    const hooks = createDtpDataModelHooks(client as any, {
      directory: "D:\\isolated-workspace",
      sessionID: "parent-session",
      messageID: "parent-message",
    } as any)

    const result = await hooks?.planCaseStepData?.({
      case_id: "TC-ISOLATED",
      keyword: { name: "send", arguments: [] },
      step: { step_index: 1, step_desc: "send test protocol" },
      project_value_evidence: [],
      candidate_data_files: [],
    })

    expect(result).toEqual({ protocol_name: "test-protocol" })
    expect(createBody).toEqual({ title: "dtp-data-generation-core" })
    expect(createBody).not.toHaveProperty("parentID")
    expect(promptBody?.system).toContain("仅将 step_desc 作为")
    expect(promptBody?.system).toContain("只返回一个 JSON 对象")
    const promptText = (promptBody?.parts as Array<{ text?: string }> | undefined)?.[0]?.text ?? ""
    expect(promptText).toContain("字段名和枚举值不得翻译")
    expect(promptText).toContain('"variant_type":"correct | title_error')
    expect(promptText).toContain('"evidence_ids":["table:source-table-id","relation:selector-relation-id"]')
    expect(promptText).not.toContain("TR-id:evidence-id")
  })

  test("requires an existing project knowledge index in offline mode", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "dtp-offline-missing-index-"))
    mkdirSync(join(workspace, ".matrix", "data", "DTPProject"), { recursive: true })

    await expect(
      prepareProjectKnowledgeIndex(resolveDefaultPaths(workspace), EMPTY_DOCS_CONTEXT, { knowledgeMode: "offline" }),
    ).rejects.toThrow("Offline knowledge mode requires an existing project knowledge index")
  })

  test("trusts and rebinds an offline project knowledge index without source documents", async () => {
    const sourceWorkspace = join(tmpdir(), `dtp-offline-source-${Date.now()}`)
    const targetWorkspace = mkdtempSync(join(tmpdir(), "dtp-offline-target-"))
    const paths = resolveDefaultPaths(targetWorkspace)
    mkdirSync(paths.dtpArtifactsDir, { recursive: true })
    const sourceIndex = createCanBusProfileKnowledgeIndex(sourceWorkspace, ["SJA1000T PeliCAN"])
    const importedContent = `${JSON.stringify(sourceIndex, null, 2)}\n`
    writeFileSync(paths.projectKnowledgeIndexFile, importedContent, "utf-8")

    const prepared = await prepareProjectKnowledgeIndex(paths, {
      ...EMPTY_DOCS_CONTEXT,
      hardwareDocs: [join(targetWorkspace, "must-not-be-read.docx")],
    }, { knowledgeMode: "offline" })

    expect(prepared.project_root).toBe(targetWorkspace)
    expect(prepared.source_documents[0].path).toContain(sourceWorkspace)
    expect(prepared.portable_metadata).toBeUndefined()
    expect(readFileSync(paths.projectKnowledgeIndexFile, "utf-8")).toBe(importedContent)
    expect(prepared.warnings).toContain(
      "Offline trusted knowledge mode reused project-knowledge-index.json without scanning source documents.",
    )
    expect(prepared.warnings).toContain(
      "Offline trusted reuse continued without the optional knowledge-package-manifest.json.",
    )
    expect(prepared.warnings).toContain(
      "Document arguments were ignored because offline knowledge mode does not read source documents.",
    )
    expect(existsSync(join(targetWorkspace, "must-not-be-read.docx"))).toBe(false)
  })

  test("trusts a modified portable offline project knowledge index without hash validation", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "dtp-offline-tampered-"))
    const paths = resolveDefaultPaths(workspace)
    mkdirSync(paths.dtpArtifactsDir, { recursive: true })
    const sourceIndex = createCanBusProfileKnowledgeIndex(workspace, ["SJA1000T PeliCAN"])
    sourceIndex.portable_metadata = {
      package_version: "1.0.0",
      source_project_root: workspace,
      extractor_version: sourceIndex.extractor_version,
      content_hash: "sha256:stale-content-hash",
      created_at: new Date().toISOString(),
    }
    writeFileSync(paths.projectKnowledgeIndexFile, `${JSON.stringify(sourceIndex, null, 2)}\n`, "utf-8")

    const tampered = JSON.parse(readFileSync(paths.projectKnowledgeIndexFile, "utf-8"))
    tampered.snippets[0].text = "tampered protocol evidence"
    writeFileSync(paths.projectKnowledgeIndexFile, `${JSON.stringify(tampered, null, 2)}\n`, "utf-8")

    const prepared = await prepareProjectKnowledgeIndex(paths, EMPTY_DOCS_CONTEXT, { knowledgeMode: "offline" })

    expect(prepared.snippets[0].text).toBe("tampered protocol evidence")
    expect(prepared.warnings).toContain("Offline trusted reuse skipped portable content-hash validation.")
  })

  test("does not block trusted offline reuse when manifest SHA-256 metadata is stale", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "dtp-offline-stale-manifest-"))
    const paths = resolveDefaultPaths(workspace)
    mkdirSync(paths.dtpArtifactsDir, { recursive: true })
    const sourceIndex = createCanBusProfileKnowledgeIndex(workspace, ["SJA1000T PeliCAN"])
    const importedContent = `${JSON.stringify(sourceIndex, null, 2)}\n`
    writeFileSync(paths.projectKnowledgeIndexFile, importedContent, "utf-8")
    writeFileSync(paths.knowledgePackageManifestFile, `${JSON.stringify({
      schema_version: "2.0.0",
      extractor_version: "legacy-extractor",
      protocol_schema_version: "3.0.0",
      protocol_compiler_version: "legacy-compiler",
      artifacts: [{
        path: "project-knowledge-index.json",
        size_bytes: 1,
        sha256: "deliberately-stale",
        mutable: false,
      }],
      created_at: new Date().toISOString(),
    }, null, 2)}\n`, "utf-8")

    const prepared = await prepareProjectKnowledgeIndex(paths, EMPTY_DOCS_CONTEXT, { knowledgeMode: "offline" })

    expect(prepared.section_protocol_models.length).toBeGreaterThan(0)
    expect(prepared.warnings).toContain(
      "Offline trusted reuse does not enforce manifest SHA-256 checks or source-document freshness.",
    )
    expect(readFileSync(paths.projectKnowledgeIndexFile, "utf-8")).toBe(importedContent)
  })

  test("reuses portable protocol definitions after moving to a new workspace", async () => {
    const sourceWorkspace = mkdtempSync(join(tmpdir(), "dtp-portable-protocol-source-"))
    const targetWorkspace = mkdtempSync(join(tmpdir(), "dtp-portable-protocol-target-"))
    const sourcePaths = resolveDefaultPaths(sourceWorkspace)
    const targetPaths = resolveDefaultPaths(targetWorkspace)
    mkdirSync(sourcePaths.dtpArtifactsDir, { recursive: true })
    mkdirSync(targetPaths.dtpArtifactsDir, { recursive: true })
    writeFileSync(
      sourcePaths.projectKnowledgeIndexFile,
      `${JSON.stringify(createCanBusProfileKnowledgeIndex(sourceWorkspace, ["SJA1000T PeliCAN"]), null, 2)}\n`,
      "utf-8",
    )

    const first = await ensureDtpProtocolDefinitions(sourceWorkspace, EMPTY_DOCS_CONTEXT, null, {
      scope: "full_project",
      knowledgeMode: "offline",
    })
    const legacyDefinitions = JSON.parse(readFileSync(sourcePaths.dtpProtocolDefinitionsFile, "utf-8"))
    legacyDefinitions.schema_version = "3.0.0"
    writeFileSync(sourcePaths.dtpProtocolDefinitionsFile, `${JSON.stringify(legacyDefinitions, null, 2)}\n`, "utf-8")
    copyFileSync(sourcePaths.projectKnowledgeIndexFile, targetPaths.projectKnowledgeIndexFile)
    copyFileSync(sourcePaths.dtpProtocolDefinitionsFile, targetPaths.dtpProtocolDefinitionsFile)

    const second = await ensureDtpProtocolDefinitions(targetWorkspace, EMPTY_DOCS_CONTEXT, null, {
      scope: "full_project",
      knowledgeMode: "offline",
    })

    expect(first.cache_hit).toBe(false)
    expect(second.cache_hit).toBe(true)
    expect(second.protocol_definitions.project_root).toBe(targetWorkspace)
    expect(second.knowledge_mode).toBe("offline")
    expect(second.source_document_scan_performed).toBe(false)
  })

  test("rebases a transferred data-file index and removes missing files", () => {
    const workspace = mkdtempSync(join(tmpdir(), "dtp-portable-data-index-"))
    const paths = resolveDefaultPaths(workspace)
    mkdirSync(paths.dtpArtifactsDir, { recursive: true })
    writeFileSync(paths.generatedDataFilesIndexFile, `${JSON.stringify({
      schema_version: "1.0.0",
      project_root: "D:\\old-workspace",
      dtp_root: "D:\\old-workspace\\.matrix\\data\\DTPProject",
      runtime_dir: "V1",
      input_data_root: "D:\\old-workspace\\.matrix\\data\\DTPProject\\V1\\input-data",
      source_documents: ["D:\\old-workspace\\third-party-test-requirement.docx"],
      entries: [{
        id: "old-entry",
        requested_file_name: "old.txt",
        file_path: "input-data\\\\input-flow\\\\old.txt",
        absolute_file_path: "D:\\old-workspace\\old.txt",
        source: "pre-generated",
        source_documents: [],
        generation_basis: [],
        confidence: 0.8,
        state: "generated",
        warnings: [],
      }],
      warnings: [],
      updated_at: new Date().toISOString(),
    }, null, 2)}\n`, "utf-8")

    const loaded = loadGeneratedDataFileIndex(paths.generatedDataFilesIndexFile, paths, { knowledgeMode: "offline" })

    expect(loaded.project_root).toBe(workspace)
    expect(loaded.dtp_root).toBe(paths.dtpRoot)
    expect(loaded.entries).toHaveLength(0)
    expect(loaded.warnings).toContain(
      "Generated data-file index was rebound to the current workspace; missing transferred files were removed.",
    )
  })
})

const EXTRACTOR_VERSION = "2026-09-11-reference-closure-v4"
const INPUT_DATA = "\u8f93\u5165\u6570\u636e"
const INPUT_FLOW = "\u8f93\u5165\u6d41"
const OUTPUT_FLOW = "\u8f93\u51fa\u6d41"
const DATA_BLOCK = "\u84c4\u7535\u6c60\u6e29\u63a7\u53c2\u6570\u6570\u636e\u5757"
const MAIN_LOOP = "\u84c4\u7535\u6c60\u7ec4\u4e3b\u52a0\u70ed\u56de\u8def"
const BACKUP_LOOP = "\u84c4\u7535\u6c60\u7ec4\u5907\u52a0\u70ed\u56de\u8def"
const CLOSED_DEFAULT = "\u95ed\u73af\u9ed8\u8ba4\u63a7\u6e29"
const OPEN_HEAT_ON = "\u5f00\u73af\u65f6\u5f00\u542f\u52a0\u70ed"
const OPEN_HEAT_OFF = "\u5f00\u73af\u65f6\u505c\u6b62\u52a0\u70ed"
const TEMPERATURE_1 = "\u84c4\u7535\u6c60\u7ec4\u6e29\u5ea61"
const TEMPERATURE_7 = "\u84c4\u7535\u6c60\u7ec4\u6e29\u5ea67"
const FAST_POLL = "\u901f\u53d8\u9065\u6d4b\u8f6e\u8be2\u63a7\u5236\u5e8f\u5217"
const FAST_TM = "\u901f\u53d8\u9065\u6d4b\u53c2\u6570"
const DIRTY_OUTPUT_NAME = "\u536b\u661f\u7535\u6c60\u7ba1\u7406\u4e0b\u4f4d\u673a\u7f13\u53d8\u9065\u6d4b\u53c2\u6570\u5904\u7406\u65b9\u6cd5\u6c47\u603b\u8868-\u7cfb\u7edf\u6b63\u5e38\uff0cD7=.txt"
const CLEAN_OUTPUT_NAME = "\u536b\u661f\u7535\u6c60\u7ba1\u7406\u4e0b\u4f4d\u673a\u7f13\u53d8\u9065\u6d4b\u53c2\u6570\u5904\u7406\u65b9\u6cd5\u6c47\u603b\u8868-\u7cfb\u7edf\u6b63\u5e38.txt"
const EMPTY_DOCS_CONTEXT: DocsContext = {
  backgroundDocs: [],
  hardwareDocs: [],
  protocolDocs: [],
  conventionDocs: [],
  packetStructureDocs: [],
  formatRuleDocs: [],
  requirementDocs: [],
}

function createEmptyKnowledgeIndex(workspaceRoot: string): ProjectKnowledgeIndex {
  return {
    schema_version: "1.0.0",
    extractor_version: EXTRACTOR_VERSION,
    project_root: workspaceRoot,
    source_documents: [],
    topics: [],
    snippets: [],
    tables: [],
    section_protocol_models: [],
    packet_model_candidates: [],
    references: [],
    warnings: [],
    updated_at: new Date().toISOString(),
  }
}

describe("DTP document references", () => {
  test("parses exact internal targets and only follows requirement-specification documents", () => {
    const document = {
      id: "doc-primary",
      path: "third-party.docx",
      file_name: "third-party.docx",
      role: "primary-third-party-test-requirement",
      type: "docx",
      parse_state: "parsed",
      warnings: [],
    } as any
    const references = extractReferencesFromText(
      document,
      "\u8be6\u89c1\u88683.1.1.5-1\uff0c\u5e76\u89c1\u300a744\u9700\u6c42\u89c4\u683c\u8bf4\u660e\u300b\u9644\u5f55K\uff1b\u53e6\u89c1\u300a\u6d4b\u63a7\u5355\u5143\u6570\u636e\u7ea6\u5b9a\u300b\u3002",
      "doc-primary-snippet-1",
    )

    expect(references).toHaveLength(3)
    expect(references[0]).toMatchObject({
      reference_type: "requirement-specification",
      target_document_hint: "744\u9700\u6c42\u89c4\u683c\u8bf4\u660e",
      target_hint: "\u9644\u5f55K",
      target_kind: "appendix",
      depth: 1,
    })
    expect(references.find((reference) => reference.target_hint === "\u88683.1.1.5-1")).toMatchObject({
      reference_type: "internal",
      target_kind: "table",
      depth: 0,
    })
    expect(references.find((reference) => reference.target_hint === "\u6d4b\u63a7\u5355\u5143\u6570\u636e\u7ea6\u5b9a")).toMatchObject({
      reference_type: "unsupported-external",
      state: "unsupported",
    })
  })

  test("resolves a compound requirement-specification reference to its most specific table", async () => {
    const index = createEmptyKnowledgeIndex("D:\\project")
    index.source_documents = [{
      id: "doc-primary",
      path: "D:\\project\\third-party.docx",
      file_name: "third-party.docx",
      role: "primary-third-party-test-requirement",
      type: "docx",
      parse_state: "parsed",
      warnings: [],
    }, {
      id: "doc-spec",
      path: "D:\\project\\requirement-specification.docx",
      file_name: "requirement-specification.docx",
      role: "referenced-requirement-specification",
      type: "docx",
      parse_state: "parsed",
      warnings: [],
    }]
    index.snippets = [{
      id: "doc-primary-snippet-10",
      source_document_id: "doc-primary",
      topic: "data_protocol",
      text: "DATA0~DATA4见需求规格说明附录J第1节表5。",
      confidence: 1,
    }, {
      id: "doc-spec-snippet-100",
      source_document_id: "doc-spec",
      topic: "data_protocol",
      text: "附录J SPI数据约定",
      confidence: 1,
    }, {
      id: "doc-spec-snippet-110",
      source_document_id: "doc-spec",
      topic: "data_protocol",
      text: "表1指令格式",
      confidence: 1,
    }, {
      id: "doc-spec-snippet-150",
      source_document_id: "doc-spec",
      topic: "data_protocol",
      text: "表5电机遥测数据",
      confidence: 1,
    }, {
      id: "doc-spec-snippet-200",
      source_document_id: "doc-spec",
      topic: "data_protocol",
      text: "附录K 其他数据约定",
      confidence: 1,
    }]
    index.tables = [{
      id: "doc-primary-table-49",
      source_document_id: "doc-primary",
      caption: "表3.1.4.1-4 电机遥测数据格式",
      aliases: ["表3.1.4.1-4"],
      topic: "packet_structure",
      rows: [
        ["ADDRESS", "LENGTH", "DATA0", "DATA1", "DATA2", "DATA3", "DATA4", "SUM"],
        ["5DH", "05H", "DATA0", "DATA1", "DATA2", "DATA3", "DATA4", "SUM"],
      ],
      confidence: 1,
      warnings: [],
    }, {
      id: "doc-spec-table-1",
      source_document_id: "doc-spec",
      caption: "表1指令格式",
      aliases: ["表1"],
      topic: "packet_structure",
      rows: [["ADDRESS", "LENGTH", "DATA0", "SUM"]],
      confidence: 1,
      warnings: [],
    }, {
      id: "doc-spec-table-5",
      source_document_id: "doc-spec",
      caption: "表5电机遥测数据",
      aliases: ["表5"],
      topic: "packet_structure",
      rows: [["ADDRESS", "LENGTH", "DATA0", "DATA1", "DATA2", "DATA3", "DATA4", "SUM"]],
      confidence: 1,
      warnings: [],
    }]
    index.section_protocol_models = [{
      id: "section-protocol-motor-telemetry",
      source_document_id: "doc-primary",
      section_id: "3.1.4.1",
      section_title: "3.1.4.1 SPI总线接口 输入流：电机遥测数据",
      section_snippet_ids: ["doc-primary-snippet-10"],
      input_flow_snippet_ids: ["doc-primary-snippet-10"],
      output_flow_snippet_ids: [],
      table_ids: ["doc-primary-table-49"],
      primary_table_ids: ["doc-primary-table-49"],
      support_table_ids: [],
      protocol_relations: [{
        frame_table_id: "doc-primary-table-49",
        generation_mode: "frame_file",
        preferred_name: "电机遥测数据",
        flow_direction: "input",
        should_generate_frame_table_file: true,
        checksum_rule: "SUM is the low byte of ADDRESS through DATA",
        confidence: 1,
        reasoning: ["test fixture"],
      }],
      protocols: [],
      confidence: 1,
      warnings: [],
    }]
    const references = extractReferencesFromText(
      index.source_documents[0],
      index.snippets[0].text,
      index.snippets[0].id,
    )
    expect(references).toHaveLength(1)
    expect(references[0]).toMatchObject({
      reference_type: "requirement-specification",
      target_hint: "表5",
      target_kind: "table",
      target_path: [
        { kind: "appendix", value: "J" },
        { kind: "section", value: "1" },
        { kind: "table", value: "5" },
      ],
    })
    references[0].resolved_document_id = "doc-spec"
    index.references = references

    resolveKnowledgeReferences(index)

    expect(index.references[0]).toMatchObject({
      state: "resolved",
      resolved_table_id: "doc-spec-table-5",
      resolved_table_ids: ["doc-spec-table-5"],
    })
    expect(index.references[0].semantic_roles).toContain("payload_definition")
    expect(index.references[0].semantic_roles).not.toContain("frame_layout")

    const context = buildDtpProtocolContextPackages(index)
      .find((item) => item.section_model_id === "section-protocol-motor-telemetry")
    expect(context?.primary_table_ids).toEqual(["doc-primary-table-49"])
    expect(context?.tables.map((table) => table.id)).toEqual(expect.arrayContaining([
      "doc-primary-table-49",
      "doc-spec-table-5",
    ]))
    expect(context?.reference_evidence?.[0]?.semantic_roles).toContain("payload_definition")

    const definitions = await buildDtpProtocolDefinitionsDocument(resolveDefaultPaths(index.project_root), index)
    const motorTelemetry = definitions.protocols.find((protocol) => (
      protocol.frames?.some((frame) => frame.source_table_id === "doc-primary-table-49")
    ))
    expect(motorTelemetry?.base_file_name).toBe("电机遥测数据")
    expect(motorTelemetry?.frames?.[0]?.byte_layout).toEqual([
      "5D", "05", "DATA0", "DATA1", "DATA2", "DATA3", "DATA4", "SUM",
    ])
    expect(definitions.protocols.some((protocol) => (
      protocol.frames?.some((frame) => frame.source_table_id === "doc-spec-table-5")
    ))).toBe(false)
  })

  test("keeps table-origin references and expands a bounded multi-hop evidence closure", () => {
    const index = createEmptyKnowledgeIndex("D:\\project")
    index.source_documents = [{
      id: "doc-primary",
      path: "D:\\project\\third-party.docx",
      file_name: "third-party.docx",
      role: "primary-third-party-test-requirement",
      type: "docx",
      parse_state: "parsed",
      warnings: [],
    }]
    index.snippets = [
      { id: "snippet-a", source_document_id: "doc-primary", topic: "data_protocol", text: "1.1 \u4e3b\u534f\u8bae\uff0c\u89c1\u88681-1", confidence: 0.9 },
      { id: "snippet-b", source_document_id: "doc-primary", topic: "data_protocol", text: "1.2 \u5b57\u6bb5\u8bf4\u660e", confidence: 0.9 },
      { id: "snippet-c", source_document_id: "doc-primary", topic: "data_protocol", text: "1.3 \u6821\u9a8c\u8bf4\u660e", confidence: 0.9 },
    ]
    index.tables = [
      {
        id: "table-a",
        source_document_id: "doc-primary",
        caption: "\u88681-1 \u6570\u636e\u5b57\u6bb5\u5b9a\u4e49\uff0c\u89c1\u88681-2",
        aliases: ["\u88681-1"],
        topic: "packet_structure",
        rows: [["TITLE", "W0", "SUM"]],
        confidence: 0.9,
        warnings: [],
      },
      {
        id: "table-b",
        source_document_id: "doc-primary",
        caption: "\u88681-2 SUM\u6821\u9a8c\u7b97\u6cd5",
        aliases: ["\u88681-2"],
        topic: "format_validation",
        rows: [["SUM", "TITLE~W0\u7d2f\u52a0\u548c\u4f4e8\u4f4d"]],
        confidence: 0.9,
        warnings: [],
      },
    ]
    index.section_protocol_models = [
      {
        id: "section-a",
        source_document_id: "doc-primary",
        section_id: "1.1",
        section_title: "1.1 \u4e3b\u534f\u8bae",
        section_snippet_ids: ["snippet-a"],
        input_flow_snippet_ids: ["snippet-a"],
        output_flow_snippet_ids: [],
        table_ids: [],
        primary_table_ids: [],
        support_table_ids: [],
        protocol_relations: [],
        protocols: [],
        confidence: 0.9,
        warnings: [],
      },
      {
        id: "section-b",
        source_document_id: "doc-primary",
        section_id: "1.2",
        section_title: "1.2 \u5b57\u6bb5\u8bf4\u660e",
        section_snippet_ids: ["snippet-b"],
        input_flow_snippet_ids: [],
        output_flow_snippet_ids: [],
        table_ids: ["table-a"],
        primary_table_ids: ["table-a"],
        support_table_ids: [],
        protocol_relations: [],
        protocols: [],
        confidence: 0.9,
        warnings: [],
      },
      {
        id: "section-c",
        source_document_id: "doc-primary",
        section_id: "1.3",
        section_title: "1.3 \u6821\u9a8c\u8bf4\u660e",
        section_snippet_ids: ["snippet-c"],
        input_flow_snippet_ids: [],
        output_flow_snippet_ids: [],
        table_ids: ["table-b"],
        primary_table_ids: [],
        support_table_ids: ["table-b"],
        protocol_relations: [],
        protocols: [],
        confidence: 0.9,
        warnings: [],
      },
    ]
    const directReference = extractReferencesFromText(
      index.source_documents[0],
      "\u89c1\u88681-1",
      "snippet-a",
    )[0]
    const tableReference = extractReferencesFromText(
      index.source_documents[0],
      "\u88681-1\u4e2d\u8bf4\u660e\u8be6\u89c1\u88681-2",
      undefined,
      "table-a",
    ).find((reference) => reference.target_hint === "\u88681-2")!
    expect(tableReference.source_table_id).toBe("table-a")
    index.references = [directReference, tableReference]

    resolveKnowledgeReferences(index)
    expect(index.references[0].semantic_roles).toContain("frame_layout")
    expect(index.references[1].semantic_roles).toContain("checksum_definition")

    const context = buildDtpProtocolContextPackages(index)
      .find((candidate) => candidate.section_model_id === "section-a")
    expect(context?.tables.map((table) => table.id)).toEqual(["table-a", "table-b"])
    expect(context?.reference_evidence?.map((reference) => reference.source_id)).toEqual([
      "snippet-a",
      "table-a",
    ])
    expect(context?.reference_evidence?.[1].semantic_roles).toContain("checksum_definition")
    const trace = buildProtocolEvidenceTrace(
      resolveDefaultPaths("D:\\project"),
      index,
      {
        protocols: [{
          protocol_id: "protocol-a",
          base_file_name: "main-protocol",
          source_section: "1.1 \u4e3b\u534f\u8bae",
          frames: [{
            frame_id: "frame-1",
            sequence: 1,
            source_table_id: "table-a",
            byte_layout: ["TITLE", "W0", "SUM"],
            field_layout: [],
          }],
          fields: [],
          flow_direction: "input",
          generation_mode: "single_file",
          evidence: ["table-a"],
          warnings: [],
          confidence: 0.9,
          understanding_source: "model",
        }],
      } as any,
    )
    expect(trace.protocols[0].references[0].target_ids).toContain("table-a")
  })

  test("materializes a protocol window whose frame layout exists only through a resolved reference", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "dtp-reference-backed-window-"))
    const paths = resolveDefaultPaths(workspaceRoot)
    mkdirSync(paths.dtpArtifactsDir, { recursive: true })
    const index = createEmptyKnowledgeIndex(workspaceRoot)
    index.source_documents = [{
      id: "doc-primary",
      path: join(workspaceRoot, "third-party-test-requirement.docx"),
      file_name: "third-party-test-requirement.docx",
      role: "primary-third-party-test-requirement",
      type: "docx",
      parse_state: "parsed",
      warnings: [],
    }]
    index.snippets = [
      { id: "doc-primary-snippet-1", source_document_id: "doc-primary", topic: "hardware_interface", text: "3.1.2 Spacewire总线接口及相关数据流", confidence: 1 },
      { id: "doc-primary-snippet-2", source_document_id: "doc-primary", topic: "hardware_interface", text: "IF-Spacewire-001：通过FPGA接收二级节点上注数据。", confidence: 1 },
      { id: "doc-primary-snippet-3", source_document_id: "doc-primary", topic: "requirement_input_flow", text: "输入流：二级节点上注数据块。包含2包，每包20字节，具体见表3.1.3.4-1。", confidence: 1 },
      { id: "doc-primary-snippet-4", source_document_id: "doc-primary", topic: "hardware_interface", text: "3.1.3.4 视频程序上注数据包广播格式", confidence: 1 },
      { id: "doc-primary-snippet-5", source_document_id: "doc-primary", topic: "output_flow", text: "输出流：视频程序上注数据包。其格式及内容如下表：", confidence: 1 },
      { id: "doc-primary-snippet-6", source_document_id: "doc-primary", topic: "packet_structure", text: "表3.1.3.4-1 视频程序上注数据包广播格式", confidence: 1 },
    ]
    index.tables = [{
      id: "doc-primary-table-1",
      source_document_id: "doc-primary",
      caption: "表3.1.3.4-1 视频程序上注数据包广播格式",
      aliases: ["表3.1.3.4-1"],
      topic: "packet_structure",
      rows: [
        ["序号", "仲裁场、控制场", "", "数据场", "", "", "", "", "", "", ""],
        ["", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"],
        ["", "ID10~ID3", "ID2~ID0 RTR DLC", "", "", "", "", "", "", "", ""],
        ["", "BFH", "68H", "I00H", "LF9H", "TC0H", "", "", "", "", ""],
        ["", "BFH", "68H", "01H", "", "", "", "", "", "", ""],
      ],
      confidence: 1,
      warnings: [],
    }]
    index.references = [{
      reference_id: "reference-secondary-upload",
      source_document_id: "doc-primary",
      source_snippet_id: "doc-primary-snippet-3",
      reference_text: "见表3.1.3.4-1",
      reference_type: "internal",
      target_kind: "table",
      target_hint: "表3.1.3.4-1",
      resolved_table_id: "doc-primary-table-1",
      resolved_table_ids: ["doc-primary-table-1"],
      semantic_roles: ["frame_layout"],
      state: "resolved",
      confidence: 1,
    }]
    writeFileSync(paths.projectKnowledgeIndexFile, `${JSON.stringify(index, null, 2)}\n`, "utf-8")

    const prepared = await prepareProjectKnowledgeIndex(paths, EMPTY_DOCS_CONTEXT, { knowledgeMode: "offline" })
    const referenceModel = prepared.section_protocol_models.find((model) => (
      model.reference_backed && model.section_snippet_ids.includes("doc-primary-snippet-3")
    ))
    expect(referenceModel).toMatchObject({
      section_id: "3.1.2",
      referenced_primary_table_ids: ["doc-primary-table-1"],
    })
    expect(referenceModel?.protocol_relations[0]).toMatchObject({
      preferred_name: "二级节点上注数据块",
      flow_direction: "input",
      source_section: "3.1.2 Spacewire总线接口及相关数据流",
    })

    let referenceRelationModelCalls = 0
    await ensureDtpProtocolDefinitions(
      workspaceRoot,
      EMPTY_DOCS_CONTEXT,
      {
        analyzeSectionProtocolRelations: async (input) => {
          if (input.reference_backed) referenceRelationModelCalls += 1
          return null
        },
      },
      { knowledgeMode: "offline", scope: "full_project" },
    )
    expect(referenceRelationModelCalls).toBe(0)

    const definitions = await buildDtpProtocolDefinitionsDocument(paths, prepared)
    const protocol = definitions.protocols.find((candidate) => candidate.base_file_name === "二级节点上注数据块")
    expect(protocol?.flow_direction).toBe("input")
    expect(protocol?.bus_context?.bus_type).toBe("SpaceWire")
    expect(protocol?.frame_envelope).toBeUndefined()
    expect(protocol?.frames).toHaveLength(4)
    expect(protocol?.frames?.every((frame) => frame.byte_layout.length === 10)).toBe(true)
    expect(protocol?.frames?.map((frame) => frame.packet_group_id)).toEqual([
      "packet-1", "packet-1", "packet-2", "packet-2",
    ])
    expect(protocol?.frames?.[0]?.byte_layout).toEqual([
      "BF", "68", "00", "F9", "C0", "W0", "W1", "W2", "W3", "W4",
    ])
  })

  test("keeps a table referenced by its own flow as a local protocol table", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "dtp-local-self-reference-"))
    const paths = resolveDefaultPaths(workspaceRoot)
    mkdirSync(paths.dtpArtifactsDir, { recursive: true })
    const index = createEmptyKnowledgeIndex(workspaceRoot)
    index.source_documents = [{
      id: "doc-primary",
      path: join(workspaceRoot, "third-party-test-requirement.docx"),
      file_name: "third-party-test-requirement.docx",
      role: "primary-third-party-test-requirement",
      type: "docx",
      parse_state: "parsed",
      warnings: [],
    }]
    index.snippets = [
      { id: "doc-primary-snippet-1", source_document_id: "doc-primary", topic: "hardware_interface", text: "3 数据及接口需求", confidence: 1 },
      { id: "doc-primary-snippet-2", source_document_id: "doc-primary", topic: "hardware_interface", text: "3.1.3 二级CAN总线接口及相关数据流", confidence: 1 },
      { id: "doc-primary-snippet-3", source_document_id: "doc-primary", topic: "hardware_interface", text: "3.1.3.3 遥控指令应答格式定义", confidence: 1 },
      { id: "doc-primary-snippet-4", source_document_id: "doc-primary", topic: "requirement_input_flow", text: "输入流：遥控指令应答，格式见表3.1.3.3-3。", confidence: 1 },
      { id: "doc-primary-snippet-5", source_document_id: "doc-primary", topic: "packet_structure", text: "表3.1.3.3-3 遥控指令应答格式定义", confidence: 1 },
    ]
    index.tables = [{
      id: "doc-primary-table-1",
      source_document_id: "doc-primary",
      caption: "表3.1.3.3-3 遥控指令应答格式定义",
      aliases: ["表3.1.3.3-3"],
      topic: "packet_structure",
      rows: [
        ["序号", "仲裁场", "控制场", "数据场", "", ""],
        ["1", "40H+站地址", "48H", "T站地址", "W0FFH", "SUM"],
      ],
      confidence: 1,
      warnings: [],
    }]
    index.references = [{
      reference_id: "reference-local-response",
      source_document_id: "doc-primary",
      source_snippet_id: "doc-primary-snippet-4",
      reference_text: "见表3.1.3.3-3",
      reference_type: "internal",
      target_kind: "table",
      target_hint: "表3.1.3.3-3",
      resolved_table_id: "doc-primary-table-1",
      resolved_table_ids: ["doc-primary-table-1"],
      semantic_roles: ["frame_layout"],
      state: "resolved",
      confidence: 1,
    }]
    writeFileSync(paths.projectKnowledgeIndexFile, `${JSON.stringify(index, null, 2)}\n`, "utf-8")

    const prepared = await prepareProjectKnowledgeIndex(paths, EMPTY_DOCS_CONTEXT, { knowledgeMode: "offline" })
    const responseModels = prepared.section_protocol_models.filter((model) => (
      model.primary_table_ids.includes("doc-primary-table-1") &&
      model.section_snippet_ids.includes("doc-primary-snippet-4")
    ))

    expect(responseModels).toHaveLength(1)
    expect(responseModels[0].reference_backed).toBeUndefined()
    expect(responseModels[0].referenced_primary_table_ids).toBeUndefined()
    const definitions = await buildDtpProtocolDefinitionsDocument(paths, prepared)
    expect(definitions.protocols.find((protocol) => protocol.base_file_name.includes("遥控指令应答"))?.bus_context)
      .toMatchObject({ bus_type: "CAN", interface_level: "secondary" })
  })

  test("keeps full frame tables but sends only matched rows from a large dictionary table", async () => {
    let promptText = ""
    const client = {
      session: {
        message: async () => ({ data: { info: { providerID: "test-provider", modelID: "test-model" } } }),
        create: async () => ({ data: { id: "isolated-dtp-session" } }),
        prompt: async (request: any) => {
          promptText = (request.body.parts as Array<{ text?: string }>)[0]?.text ?? ""
          return {
            data: {
              info: {},
              parts: [{ type: "text", text: JSON.stringify({ protocols: [], non_generated_tables: [], warnings: [] }) }],
            },
          }
        },
        abort: async () => ({ data: true }),
        delete: async () => ({ data: true }),
      },
      config: { get: async () => ({ data: {} }) },
    }
    const rows = [
      ["\u6307\u4ee4\u540d\u79f0", "W0", "W1"],
      ...Array.from({ length: 38 }, (_, index) => [
        index === 24 ? "TCY215 \u5b9a\u6807\u9ed1\u4f53\u63a7\u6e29\u7cfb\u6570\u8c03\u6574" : `TCY${300 + index}`,
        "00",
        "00",
      ]),
    ]
    rows[26] = ["TCY999 \u4e0d\u76f8\u5173\u6307\u4ee4", "FF", "FF"]
    const tableHtml = `<table>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</table>`
    const hooks = createDtpDataModelHooks(client as any, {
      directory: "D:\\isolated-workspace",
      sessionID: "parent-session",
      messageID: "parent-message",
    } as any)

    await hooks?.understandSectionProtocols?.({
      section_model_id: "section-command",
      source_document_id: "doc-primary",
      section_id: "3.1.1.5",
      section_title: "3.1.1.5 \u9065\u63a7\u6307\u4ee4",
      interface_context_text: "CAN interface",
      section_text: "\u672c\u6b21\u9700\u8981TCY215\u5b9a\u6807\u9ed1\u4f53\u63a7\u6e29\u7cfb\u6570\u8c03\u6574\u6307\u4ee4",
      flow_blocks: {
        input: { direction: "input", heading_text: "\u8f93\u5165\u6d41", snippet_ids: [], text: "TCY215", table_ids: ["table-dictionary"] },
        output: { direction: "output", heading_text: "", snippet_ids: [], text: "", table_ids: [] },
      },
      tables: [{
        id: "table-dictionary",
        caption: "\u9644\u5f55K \u603b\u7ebf\u6307\u4ee4",
        ordinal: 1,
        is_frame_format: false,
        headers: rows[0],
        rows,
        table_html: tableHtml,
        cells: rows.flatMap((row, rowIndex) => row.map((text, col) => ({ row: rowIndex, col, text }))),
        aliases: ["\u9644\u5f55K"],
        topic: "data_protocol",
      }],
      primary_table_ids: [],
      support_table_ids: ["table-dictionary"],
      heuristic_relations: [],
      bus_profiles: [],
    })

    expect(promptText).toContain('"payload_mode":"header_and_matched_rows"')
    expect(promptText).toContain("TCY215")
    expect(promptText).not.toContain("TCY999")
    expect(promptText).not.toContain('"cells"')
    expect(promptText).not.toContain('"rows"')
  })

  test("uses one bounded relation window instead of expanding every primary table", () => {
    const table = (id: string, caption: string, isFrameFormat: boolean) => ({
      id,
      caption,
      ordinal: Number(id.replace(/\D/g, "")) || 1,
      is_frame_format: isFrameFormat,
      headers: ["字段", "取值"],
      rows: [["字段", "取值"], ["W0", "00H"]],
      aliases: [],
      topic: "data_protocol" as const,
    })
    const inputs = prepareSectionRelationModelInputs({
      section_model_id: "appendix-g",
      source_document_id: "doc-primary",
      section_id: "appendix-G",
      section_title: "附录G 二级CAN协议",
      section_text: "遥测协议字段见支持表",
      input_flow_text: "输入流",
      output_flow_text: "",
      tables: [
        table("frame-1", "遥测帧1", true),
        table("frame-2", "遥测帧2", true),
        table("frame-3", "遥测帧3", true),
        table("frame-4", "遥测帧4", true),
        table("frame-5", "遥测帧5", true),
        table("support-1", "遥测协议字段说明", false),
        table("unrelated-1", "人员信息汇总", false),
      ],
      primary_table_ids: ["frame-1", "frame-2", "frame-3", "frame-4", "frame-5"],
      support_table_ids: ["support-1"],
      heuristic_relations: [],
    })

    expect(inputs).toHaveLength(1)
    expect(inputs[0].primary_table_ids).toHaveLength(2)
    expect(inputs[0].tables.some((item) => item.id === "support-1")).toBe(true)
    expect(inputs[0].tables.some((item) => item.id === "unrelated-1")).toBe(false)
    expect(inputs[0].model_input_metrics?.token_budget).toBe(20000)
    expect(inputs[0].model_input_metrics?.final_prompt_tokens).toBeLessThanOrEqual(20000)
    expect(inputs[0].model_timeout_ms).toBe(100000)
  })

  test("limits protocol understanding to two bounded windows", () => {
    const table = (id: string) => ({
      id,
      caption: `${id} 数据格式`,
      ordinal: Number(id.replace(/\D/g, "")) || 1,
      is_frame_format: true,
      headers: ["TITLE", "W0", "SUM"],
      rows: [["TITLE", "W0", "SUM"], ["20H", "00H", "SUM"]],
      aliases: [],
      topic: "data_protocol" as const,
    })
    const contexts = prepareProtocolUnderstandingContexts({
      section_model_id: "appendix-many-protocols",
      source_document_id: "doc-primary",
      section_title: "附录 大型协议集合",
      section_text: "多个协议格式定义",
      flow_blocks: {
        input: { direction: "input", heading_text: "输入流", snippet_ids: [], text: "输入协议", table_ids: [] },
        output: { direction: "output", heading_text: "", snippet_ids: [], text: "", table_ids: [] },
      },
      tables: [1, 2, 3, 4, 5, 6].map((index) => table(`frame-${index}`)),
      primary_table_ids: [1, 2, 3, 4, 5, 6].map((index) => `frame-${index}`),
      support_table_ids: [],
      heuristic_relations: [],
      bus_profiles: [],
    })

    expect(contexts).toHaveLength(2)
    expect(contexts.flatMap((context) => context.primary_table_ids)).toHaveLength(4)
    expect(contexts.every((context) => (
      (context.model_input_metrics?.final_prompt_tokens ?? Infinity) <= 30000
    ))).toBe(true)
  })

  test("routes a large protocol dictionary to matching rows and applies the small-input timeout", () => {
    const rows = [
      ["指令名称", "W0", "W1"],
      ...Array.from({ length: 80 }, (_, index) => [
        index === 37 ? "TCY215 定标黑体控温系数调整" : `TCY${500 + index}`,
        "00H",
        "00H",
      ]),
    ]
    const tableHtml = `<table>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</table>`
    const [prepared] = prepareProtocolUnderstandingContexts({
      section_model_id: "appendix-k",
      source_document_id: "doc-primary",
      section_id: "appendix-K",
      section_title: "附录K 总线指令",
      section_text: "解析TCY215定标黑体控温系数调整",
      flow_blocks: {
        input: { direction: "input", heading_text: "输入流", snippet_ids: [], text: "TCY215", table_ids: [] },
        output: { direction: "output", heading_text: "", snippet_ids: [], text: "", table_ids: [] },
      },
      tables: [{
        id: "dictionary-k",
        caption: "附录K总线指令",
        ordinal: 1,
        is_frame_format: false,
        headers: rows[0],
        rows,
        table_html: tableHtml,
        cells: rows.flatMap((row, rowIndex) => row.map((text, col) => ({ row: rowIndex, col, text }))),
        aliases: ["总线指令"],
        topic: "data_protocol",
      }],
      primary_table_ids: [],
      support_table_ids: ["dictionary-k"],
      heuristic_relations: [],
      bus_profiles: [],
    })

    expect(prepared.model_timeout_ms).toBe(150000)
    expect(prepared.model_input_metrics).toMatchObject({
      candidate_table_count: 1,
      selected_table_count: 1,
      token_budget: 30000,
      applied_timeout_ms: 150000,
    })
    expect(prepared.tables[0].payload_mode).toBe("header_and_matched_rows")
    expect(prepared.tables[0].table_html).toContain("TCY215")
    expect(prepared.tables[0].table_html).not.toContain("TCY579")
    expect(prepared.tables[0].cells).toBeUndefined()
    expect(prepared.tables[0].rows).toEqual([])
  })

  test("keeps a multi-frame primary table complete when it remains within the table budget", () => {
    const rows = [
      ["帧序号", "TITLE", "W0", "SUM"],
      ...Array.from({ length: 40 }, (_, index) => [
        String(index + 1),
        "20H",
        `${index.toString(16).padStart(2, "0")}H`,
        "SUM",
      ]),
    ]
    const [prepared] = prepareProtocolUnderstandingContexts({
      section_model_id: "multi-frame-section",
      source_document_id: "doc-primary",
      section_title: "多帧遥测数据格式",
      section_text: "每一行定义一帧",
      flow_blocks: {
        input: { direction: "input", heading_text: "输入流", snippet_ids: [], text: "多帧遥测", table_ids: ["frame-table"] },
        output: { direction: "output", heading_text: "", snippet_ids: [], text: "", table_ids: [] },
      },
      tables: [{
        id: "frame-table",
        caption: "40帧遥测数据格式",
        ordinal: 1,
        is_frame_format: true,
        headers: rows[0],
        rows,
        aliases: [],
        topic: "data_protocol",
      }],
      primary_table_ids: ["frame-table"],
      support_table_ids: [],
      heuristic_relations: [],
      bus_profiles: [],
    })

    expect(prepared.tables[0].payload_mode).toBe("complete")
    expect(prepared.tables[0].rows).toHaveLength(41)
    expect(prepared.tables[0].selected_row_indexes).toHaveLength(41)
  })

  test("supplements only the table rows explicitly requested by protocol understanding", () => {
    const dictionaryRows = [
      ["指令名称", "W0"],
      ["TCY214 无关指令", "00H"],
      ["TCY215 定标黑体控温系数调整", "15H"],
      ...Array.from({ length: 35 }, (_, index) => [`TCY${300 + index}`, "00H"]),
    ]
    const context = {
      section_model_id: "section-command",
      source_document_id: "doc-primary",
      section_title: "遥控指令",
      section_text: "指令取值见附录K",
      flow_blocks: {
        input: { direction: "input", heading_text: "输入流", snippet_ids: [], text: "遥控指令", table_ids: ["frame"] },
        output: { direction: "output", heading_text: "", snippet_ids: [], text: "", table_ids: [] },
      },
      tables: [
        {
          id: "frame",
          caption: "遥控指令格式",
          ordinal: 1,
          is_frame_format: true,
          headers: ["TITLE", "W0", "SUM"],
          rows: [["TITLE", "W0", "SUM"], ["46H", "W0", "SUM"]],
          aliases: [],
          topic: "data_protocol",
        },
        {
          id: "dictionary",
          caption: "附录K总线指令",
          ordinal: 2,
          is_frame_format: false,
          headers: dictionaryRows[0],
          rows: dictionaryRows,
          aliases: [],
          topic: "data_protocol",
        },
      ],
      primary_table_ids: ["frame"],
      support_table_ids: ["dictionary"],
      heuristic_relations: [],
      bus_profiles: [],
    } as any

    const supplemental = prepareRequestedProtocolEvidenceContext(context, [{
      table_id: "dictionary",
      row_keys: ["TCY215"],
      fields: ["W0"],
    }])

    expect(supplemental?.section_model_id).toContain("evidence-supplement")
    expect(supplemental?.tables.map((table) => table.id)).toEqual(["frame", "dictionary"])
    expect(JSON.stringify(supplemental?.tables)).toContain("TCY215")
    expect(JSON.stringify(supplemental?.tables)).not.toContain("TCY334")
  })

  test("builds a lightweight table evidence index without table body payloads", () => {
    const index = createEmptyKnowledgeIndex("D:\\project")
    index.tables = [{
      id: "table-can-1",
      source_document_id: "doc-primary",
      caption: "表1 二级CAN遥控指令",
      aliases: ["遥控指令"],
      topic: "data_protocol",
      rows: [["字段", "取值"], ["W0", "01H"]],
      confidence: 1,
      warnings: [],
    }]
    index.section_protocol_models = [{
      id: "section-can-1",
      source_document_id: "doc-primary",
      section_title: "3.1 数据及接口需求 二级CAN",
      section_path: ["3 数据及接口需求", "3.1 二级CAN"],
      section_snippet_ids: [],
      input_flow_snippet_ids: [],
      output_flow_snippet_ids: [],
      table_ids: ["table-can-1"],
      primary_table_ids: ["table-can-1"],
      support_table_ids: [],
      protocol_relations: [],
      protocols: [],
      confidence: 1,
      warnings: [],
    }]

    const evidenceIndex = buildDtpTableEvidenceIndex(index)

    expect(evidenceIndex.tables[0]).toMatchObject({
      table_id: "table-can-1",
      row_count: 2,
      headers: ["字段", "取值"],
      bus_scope: ["secondary-can"],
      semantic_roles: ["frame_layout"],
    })
    expect(evidenceIndex.tables[0]).not.toHaveProperty("rows")
    expect(evidenceIndex.tables[0]).not.toHaveProperty("table_html")
  })

  test("resolves dotted table ids exactly and builds one-hop appendix graph edges", () => {
    const index = createEmptyKnowledgeIndex("D:\\project")
    index.source_documents = [
      {
        id: "doc-primary",
        path: "D:\\project\\third-party.docx",
        file_name: "third-party.docx",
        role: "primary-third-party-test-requirement",
        type: "docx",
        parse_state: "parsed",
        warnings: [],
      },
      {
        id: "doc-spec",
        path: "D:\\project\\744-requirement-specification.docx",
        file_name: "744-requirement-specification.docx",
        role: "referenced-document",
        type: "docx",
        parse_state: "parsed",
        warnings: [],
      },
    ]
    index.snippets = [
      {
        id: "doc-primary-snippet-1",
        source_document_id: "doc-primary",
        topic: "data_protocol",
        text: "1.1 protocol",
        confidence: 0.9,
      },
      {
        id: "doc-spec-snippet-1",
        source_document_id: "doc-spec",
        topic: "data_protocol",
        text: "\u9644\u5f55K \u603b\u7ebf\u6307\u4ee4",
        confidence: 0.9,
      },
    ]
    index.tables = [
      {
        id: "table-exact",
        source_document_id: "doc-primary",
        caption: "\u88683.1.1.5-1 \u6307\u4ee4\u683c\u5f0f",
        aliases: ["\u88683.1.1.5-1"],
        topic: "packet_structure",
        rows: [["W0", "SUM"]],
        confidence: 0.9,
        warnings: [],
      },
      {
        id: "table-neighbor",
        source_document_id: "doc-primary",
        caption: "\u88683.1.1.5-2 \u5e94\u7b54\u683c\u5f0f",
        aliases: ["\u88683.1.1.5-2"],
        topic: "packet_structure",
        rows: [["W0", "SUM"]],
        confidence: 0.9,
        warnings: [],
      },
      {
        id: "table-appendix-k",
        source_document_id: "doc-spec",
        caption: "\u9644\u5f55K \u603b\u7ebf\u6307\u4ee4\u8868",
        aliases: ["\u9644\u5f55K"],
        topic: "data_protocol",
        rows: [["TCY215", "20", "15"]],
        confidence: 0.9,
        warnings: [],
      },
    ]
    index.section_protocol_models = [
      {
        id: "section-primary",
        source_document_id: "doc-primary",
        section_id: "1.1",
        section_title: "1.1 protocol",
        section_snippet_ids: ["doc-primary-snippet-1"],
        input_flow_snippet_ids: ["doc-primary-snippet-1"],
        output_flow_snippet_ids: [],
        table_ids: ["table-exact", "table-neighbor"],
        primary_table_ids: ["table-exact"],
        support_table_ids: ["table-neighbor"],
        protocol_relations: [],
        protocols: [],
        confidence: 0.9,
        warnings: [],
      },
      {
        id: "section-appendix-k",
        source_document_id: "doc-spec",
        section_id: "appendix-K",
        section_title: "\u9644\u5f55K \u603b\u7ebf\u6307\u4ee4",
        section_snippet_ids: ["doc-spec-snippet-1"],
        input_flow_snippet_ids: [],
        output_flow_snippet_ids: [],
        table_ids: ["table-appendix-k"],
        primary_table_ids: [],
        support_table_ids: ["table-appendix-k"],
        protocol_relations: [],
        protocols: [],
        confidence: 0.9,
        warnings: [],
      },
    ]
    index.references = [
      {
        source_document_id: "doc-primary",
        source_snippet_id: "doc-primary-snippet-1",
        reference_text: "\u89c1\u88683.1.1.5-1",
        reference_type: "internal",
        target_kind: "table",
        target_hint: "\u88683.1.1.5-1",
        depth: 0,
        state: "pending-parser",
      },
      {
        source_document_id: "doc-primary",
        source_snippet_id: "doc-primary-snippet-1",
        reference_text: "\u89c1\u9700\u6c42\u89c4\u683c\u8bf4\u660e\u9644\u5f55K",
        reference_type: "requirement-specification",
        target_kind: "appendix",
        target_document_hint: "\u9700\u6c42\u89c4\u683c\u8bf4\u660e",
        target_hint: "\u9644\u5f55K",
        resolved_document_id: "doc-spec",
        depth: 1,
        state: "pending-parser",
      },
    ]

    resolveKnowledgeReferences(index)
    expect(index.references[0]).toMatchObject({ state: "resolved", resolved_table_id: "table-exact" })
    expect(index.references[1]).toMatchObject({
      state: "resolved",
      resolved_snippet_id: "doc-spec-snippet-1",
      resolved_table_id: "table-appendix-k",
    })
    const primaryContext = buildDtpProtocolContextPackages(index)
      .find((context) => context.section_model_id === "section-primary")
    expect(primaryContext?.tables.map((table) => table.id)).toContain("table-appendix-k")
    expect(primaryContext?.referenced_context_text).toContain("\u9644\u5f55K")
    const graph = buildDocumentReferenceGraph(index)
    expect(graph.nodes).toContainEqual(expect.objectContaining({ id: "doc-spec-snippet-1", type: "appendix" }))
    expect(graph.edges).toContainEqual(expect.objectContaining({
      source: "doc-primary-snippet-1",
      target: "section-appendix-k",
      relation: "references",
      depth: 1,
    }))
  })

  test("falls back to the same appendix when the referenced specification is unavailable", () => {
    const index = createEmptyKnowledgeIndex("D:\\project")
    index.source_documents = [{
      id: "doc-primary",
      path: "D:\\project\\third-party.docx",
      file_name: "third-party.docx",
      role: "primary-third-party-test-requirement",
      type: "docx",
      parse_state: "parsed",
      warnings: [],
    }]
    index.snippets = [{
      id: "doc-primary-snippet-9",
      source_document_id: "doc-primary",
      topic: "data_protocol",
      text: "\u9644\u5f55K \u603b\u7ebf\u6307\u4ee4",
      confidence: 0.9,
    }]
    index.references = [{
      source_document_id: "doc-primary",
      reference_text: "\u89c1\u9700\u6c42\u89c4\u683c\u8bf4\u660e\u9644\u5f55K",
      reference_type: "requirement-specification",
      target_kind: "appendix",
      target_document_hint: "\u9700\u6c42\u89c4\u683c\u8bf4\u660e",
      target_hint: "\u9644\u5f55K",
      depth: 1,
      state: "unresolved",
    }]

    resolveKnowledgeReferences(index)
    expect(index.references[0].state).toBe("fallback_resolved")
    expect(index.references[0].resolved_document_id).toBe("doc-primary")
    expect(index.references[0].warnings?.join(" ")).toContain("third-party test requirement")
  })
})

function createCanBusProfileKnowledgeIndex(
  workspaceRoot: string,
  hardwareInterfaceTexts: string[],
): ProjectKnowledgeIndex {
  return {
    schema_version: "1.0.0",
    extractor_version: EXTRACTOR_VERSION,
    project_root: workspaceRoot,
    source_documents: [
      {
        id: "doc-can",
        path: join(workspaceRoot, "third-party-test-requirement.docx"),
        file_name: "third-party-test-requirement.docx",
        role: "primary-third-party-test-requirement",
        type: "docx",
        parse_state: "parsed",
        warnings: [],
      },
    ],
    topics: [],
    snippets: [
      ...hardwareInterfaceTexts.map((text, index) => ({
        id: `doc-can-snippet-${index + 1}`,
        source_document_id: "doc-can",
        topic: "hardware_interface" as const,
        text,
        confidence: 0.9,
      })),
      {
        id: "doc-can-snippet-100",
        source_document_id: "doc-can",
        topic: "requirement_input_flow",
        text: "\u8f93\u5165\u6d41\uff1a\u9065\u6d4b\u5e271\u8f6e\u8be2\u63a7\u5236\u5e8f\u5217\u3002",
        confidence: 0.9,
      },
    ],
    tables: [
      {
        id: "doc-can-table-1",
        source_document_id: "doc-can",
        caption: "\u88683.1.1.1-1 \u9065\u6d4b\u5e271\u8f6e\u8be2\u63a7\u5236\u5e8f\u5217",
        aliases: [],
        topic: "packet_structure",
        rows: [
          ["\u5e27\u5e8f\u53f7", "\u4ef2\u88c1\u573a\u3001\u63a7\u5236\u573a", "\u6709\u6548\u6570\u636e\u573a"],
          ["1", "2", "3", "4", "5", "6"],
          ["", "ID10\uff5eID3", "ID2\uff5eID0\uff0cRTR\uff0cDLC", "", "", ""],
          ["1", "8DH", "04H", "T00H", "10H", "01H", "SUM"],
        ],
        confidence: 0.9,
        warnings: [],
      },
    ],
    section_protocol_models: [
      {
        id: "section-can-input",
        source_document_id: "doc-can",
        section_id: "3.1.1.1",
        section_title: "3.1.1.1 \u9065\u6d4b\u5e271\u8f6e\u8be2\u63a7\u5236\u5e8f\u5217",
        section_snippet_ids: ["doc-can-snippet-100"],
        input_flow_snippet_ids: ["doc-can-snippet-100"],
        output_flow_snippet_ids: [],
        table_ids: ["doc-can-table-1"],
        primary_table_ids: ["doc-can-table-1"],
        support_table_ids: [],
        protocol_relations: [],
        protocols: [],
        confidence: 0.9,
        warnings: [],
      },
    ],
    packet_model_candidates: [],
    references: [],
    warnings: [],
    updated_at: new Date().toISOString(),
  }
}

function canProtocolModelResponse(
  context: { section_model_id: string; section_title: string },
  busContext: Record<string, unknown>,
): unknown {
  return {
    protocols: [
      {
        protocol_id: `${context.section_model_id}-model-1`,
        source_section: context.section_title,
        flow_direction: "input",
        base_file_name: "\u9065\u6d4b\u5e271\u8f6e\u8be2\u63a7\u5236\u5e8f\u5217",
        generation_mode: "single_file",
        frames: [
          {
            frame_id: "frame-1",
            sequence: 1,
            source_table_id: "doc-can-table-1",
            byte_layout: ["8D", "04", "00", "10", "01", "SUM"],
            field_layout: [
              { name: "ARBITRATION", role: "arbitration", byte_offset: 0, byte_length: 1, default_value: "8D" },
              { name: "CONTROL", role: "control", byte_offset: 1, byte_length: 1, default_value: "04" },
              { name: "RTR", role: "control", byte_offset: 1, byte_length: 1, bit_offset: 4, bit_length: 1 },
              { name: "DLC", role: "length", byte_offset: 1, byte_length: 1, bit_offset: 0, bit_length: 4 },
              { name: "TITLE", role: "title", byte_offset: 2, byte_length: 1, default_value: "00" },
              { name: "W0", role: "data", byte_offset: 3, byte_length: 1, default_value: "10" },
              { name: "W1", role: "data", byte_offset: 4, byte_length: 1, default_value: "01" },
              { name: "SUM", role: "checksum", byte_offset: 5, byte_length: 1 },
            ],
            checksum: { type: "sum_low8", start: "TITLE", end: "BEFORE_SUM" },
          },
        ],
        bus_context: busContext,
        fields: [],
        evidence: ["doc-can-table-1"],
        warnings: [],
        confidence: 0.9,
      },
    ],
    non_generated_tables: [],
    warnings: [],
  }
}

function createProtocolDefinitions(
  workspaceRoot: string,
  protocols: DtpProtocolDefinitionsDocument["protocols"],
): DtpProtocolDefinitionsDocument {
  return migrateDtpProtocolDefinitionsDocument({
    schema_version: "4.0.0",
    project_root: workspaceRoot,
    knowledge_index_file: join(
      workspaceRoot,
      ".matrix",
      "data",
      "dtp-generation",
      "project-knowledge-index.json",
    ),
    source: "heuristic-fallback",
    sections: [],
    protocols,
    non_generated_tables: [],
    warnings: [],
    updated_at: new Date().toISOString(),
  })
}

describe("DTP protocol and case-data generation", () => {
  test("indexes only documents whose names contain third-party test requirement", () => {
    const workspaceRoot = join(tmpdir(), `dtp-doc-scope-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    const primaryDoc = join(workspaceRoot, "设备第三方测试需求说明.docx")
    const unrelatedDoc = join(workspaceRoot, "硬件接口说明.docx")
    writeFileSync(primaryDoc, "primary", "utf-8")
    writeFileSync(unrelatedDoc, "unrelated", "utf-8")

    const index = buildProjectKnowledgeIndex(paths, {
      ...EMPTY_DOCS_CONTEXT,
      hardwareDocs: [unrelatedDoc],
      requirementDocs: [unrelatedDoc],
    })

    expect(index.source_documents.map((document) => document.path)).toEqual([primaryDoc])
    expect(index.source_documents[0].role).toBe("primary-third-party-test-requirement")
  })

  test("selects an exact frame definition under data and interface requirements over a summary table", () => {
    const workspaceRoot = join(tmpdir(), `dtp-section-scope-${Date.now()}`)
    const index = createEmptyKnowledgeIndex(workspaceRoot)
    index.snippets = [{
      id: "doc-1-snippet-1",
      source_document_id: "doc-1",
      topic: "hardware_interface",
      text: "第三章 数据及接口需求",
      confidence: 0.9,
    }]
    index.tables = [
      {
        id: "table-frame",
        source_document_id: "doc-1",
        caption: "表3-1 遥测帧1轮询控制序列",
        aliases: [],
        topic: "packet_structure",
        rows: [["帧序号", "仲裁场", "控制场", "TITLE", "W0", "SUM"]],
        confidence: 0.9,
        warnings: [],
      },
      {
        id: "table-summary",
        source_document_id: "doc-1",
        caption: "接口需求项总结表",
        aliases: [],
        topic: "background_knowledge",
        rows: [["TR-JK-001", "发送遥测帧1轮询控制序列"]],
        confidence: 0.9,
        warnings: [],
      },
    ]
    const common = {
      source_document_id: "doc-1",
      section_snippet_ids: [],
      input_flow_snippet_ids: [],
      output_flow_snippet_ids: [],
      support_table_ids: [],
      protocol_relations: [],
      protocols: [],
      confidence: 0.9,
      warnings: [],
    }
    index.section_protocol_models = [
      {
        ...common,
        id: "section-frame",
        section_id: "3.1.1.1",
        section_title: "3.1.1.1 遥测帧1轮询及应答格式说明",
        content_role: "frame_definition",
        table_ids: ["table-frame"],
        primary_table_ids: ["table-frame"],
      },
      {
        ...common,
        id: "section-summary",
        section_id: "3.9",
        section_title: "3.9 接口需求项总结表",
        content_role: "requirement_summary",
        table_ids: ["table-summary"],
        primary_table_ids: ["table-summary"],
      },
    ]

    expect(selectCaseProtocolSectionIds(
      index,
      ["第1.0秒，通过CANB总线发送正确的遥测帧1轮询控制序列"],
    )).toEqual(["section-frame"])
  })

  test("infers the interface-requirement root from an unnumbered Word heading", () => {
    const workspaceRoot = join(tmpdir(), `dtp-bare-interface-heading-${Date.now()}`)
    const index = createEmptyKnowledgeIndex(workspaceRoot)
    index.warnings = [
      "The 数据及接口需求 chapter was not identified; protocol section selection used full-document fallback.",
    ]
    index.snippets = [{
      id: "doc-1-snippet-heading",
      source_document_id: "doc-1",
      topic: "hardware_interface",
      text: "数据及接口需求",
      confidence: 0.9,
    }, {
      id: "doc-1-snippet-flow",
      source_document_id: "doc-1",
      topic: "data_protocol",
      text: "输入流：遥控指令应答。其格式及内容如下表：",
      confidence: 0.9,
    }]
    index.tables = [{
      id: "response-table",
      source_document_id: "doc-1",
      caption: "表3.1.3.3-3 遥控指令应答格式定义",
      aliases: [],
      topic: "data_protocol",
      rows: [["仲裁场", "控制场", "TITLE", "W0", "SUM"]],
      confidence: 0.9,
      warnings: [],
    }]
    index.section_protocol_models = [{
      id: "secondary-response",
      source_document_id: "doc-1",
      section_id: "3.1.3.3",
      section_title: "3.1.3.3 输入流：遥控指令应答",
      section_snippet_ids: ["doc-1-snippet-flow"],
      input_flow_snippet_ids: ["doc-1-snippet-flow"],
      output_flow_snippet_ids: [],
      table_ids: ["response-table"],
      primary_table_ids: ["response-table"],
      support_table_ids: [],
      protocol_relations: [],
      protocols: [],
      content_role: "frame_definition",
      confidence: 0.9,
      warnings: [],
    }]

    expect(selectCaseProtocolSectionIds(
      index,
      ["第3.1秒，通过二级CAN总线发送站地址01H的10字节遥控指令应答"],
    )).toEqual(["secondary-response"])
    expect(index.warnings).not.toContain(
      "The 数据及接口需求 chapter was not identified; protocol section selection used full-document fallback.",
    )
  })

  test("keeps sibling flow blocks from the same protocol section in the case compilation scope", () => {
    const workspaceRoot = join(tmpdir(), `dtp-section-siblings-${Date.now()}`)
    const index = createEmptyKnowledgeIndex(workspaceRoot)
    const common = {
      source_document_id: "doc-1",
      section_id: "3.1.3.3",
      section_path: ["3 数据及接口需求", "3.1.3 二级CAN总线接口"],
      section_snippet_ids: [],
      input_flow_snippet_ids: [],
      output_flow_snippet_ids: [],
      support_table_ids: [],
      protocol_relations: [],
      protocols: [],
      confidence: 0.9,
      warnings: [],
    }
    index.section_protocol_models = [
      {
        ...common,
        id: "primary-remote-command",
        section_id: "3.1.1.5",
        section_path: ["3 数据及接口需求", "3.1.1 一级CAN总线接口"],
        section_title: "3.1.1.5 遥控指令格式定义 输入流：遥控指令",
        table_ids: ["primary-command-table"],
        primary_table_ids: ["primary-command-table"],
      },
      {
        ...common,
        id: "secondary-command-response",
        section_title: "3.1.3.3 遥控指令应答格式定义 输入流：遥控指令应答",
        table_ids: ["response-table"],
        primary_table_ids: ["response-table"],
      },
      {
        ...common,
        id: "secondary-compensation-command",
        section_title: "3.1.3.3 遥控指令应答格式定义 输出流：补偿镜控制器参数上注数据包",
        table_ids: ["compensation-command-table"],
        primary_table_ids: ["compensation-command-table"],
      },
      {
        ...common,
        id: "secondary-compensation-response",
        section_title: "3.1.3.3 遥控指令应答格式定义 输入流：补偿镜控制器参数上注数据包应答",
        table_ids: ["compensation-response-table"],
        primary_table_ids: ["compensation-response-table"],
      },
    ]
    index.tables = [
      ["primary-command-table", "表3.1.1.5-1 遥控指令格式定义"],
      ["response-table", "表3.1.3.3-3 遥控指令应答格式定义"],
      ["compensation-command-table", "表3.1.3.3-1 补偿镜控制器参数上注数据包指令格式定义"],
      ["compensation-response-table", "表3.1.3.3-2 补偿镜控制器参数上注数据包应答格式定义"],
    ].map(([id, caption]) => ({
      id,
      source_document_id: "doc-1",
      caption,
      aliases: [],
      topic: "data_protocol" as const,
      rows: [["序号", "仲裁场", "控制场", "数据场"]],
      confidence: 0.9,
      warnings: [],
    }))

    expect(selectCaseProtocolSectionIds(
      index,
      ["第3.1秒，发送二级CAN数据为遥控指令正常发送"],
    )).toEqual([
      "secondary-command-response",
      "secondary-compensation-command",
      "secondary-compensation-response",
    ])
  })

  test("filters code-quality sections when the interface-requirement chapter heading is missing", () => {
    const workspaceRoot = join(tmpdir(), `dtp-section-fallback-${Date.now()}`)
    const index = createEmptyKnowledgeIndex(workspaceRoot)
    index.tables = [
      {
        id: "spi-response-table",
        source_document_id: "doc-1",
        caption: "机构控制指令应答格式",
        aliases: [], topic: "packet_structure", rows: [["ADDRESS", "LENGTH", "DATA0", "SUM"]],
        confidence: 1, warnings: [],
      },
      {
        id: "polluted-response-table",
        source_document_id: "doc-1",
        caption: "机构控制指令应答格式",
        aliases: [], topic: "packet_structure", rows: [["ADDRESS", "LENGTH", "DATA0", "SUM"]],
        confidence: 1, warnings: [],
      },
    ]
    const common = {
      source_document_id: "doc-1", section_snippet_ids: [], input_flow_snippet_ids: [], output_flow_snippet_ids: [],
      support_table_ids: [], protocol_relations: [], protocols: [], confidence: 1, warnings: [],
    }
    index.section_protocol_models = [
      {
        ...common,
        id: "spi-interface-section",
        section_id: "3.1.4.1",
        section_title: "3.1.4.1 机构控制指令格式",
        section_path: ["3 数据及接口需求", "3.1.4 SPI总线接口及相关数据流"],
        table_ids: ["spi-response-table"], primary_table_ids: ["spi-response-table"],
      },
      {
        ...common,
        id: "complexity-section",
        section_id: "5.2.3.4",
        section_title: "5.2.3.4 尽量避免模块的圈复杂度超过10",
        section_path: ["5 软件质量要求", "5.2.3 静态分析"],
        table_ids: ["polluted-response-table"], primary_table_ids: ["polluted-response-table"],
      },
    ]

    expect(selectCaseProtocolSectionIds(index, ["通过SPI总线发送机构控制指令应答"]))
      .toEqual(["spi-interface-section"])
  })

  test("sanitizes unresolved placeholders when loading executable confirmation cases", () => {
    const workspaceRoot = join(tmpdir(), `dtp-placeholder-${Date.now()}`)
    const confirmationFile = join(workspaceRoot, ".matrix", "data", "confirmation-tests.json")
    mkdirSync(join(workspaceRoot, ".matrix", "data"), { recursive: true })
    writeFileSync(
      confirmationFile,
      `${JSON.stringify({
        test_cases: [
          {
            case_id: "TC-PLACEHOLDER-001",
            translate_status: "success",
            case_name: "占位符兼容",
            test_purpose: "验证 DTP 执行侧占位符兼容。",
            requirement_ids: ["TR-001"],
            test_step: [
              {
                key_name: "执行参数化操作",
                step_desc: "执行${para1}操作",
                parameter: [
                  { Name: "${time}", Value: "${time}", Comments: "执行时间" },
                  { Name: "${para1}", Value: "${para1}", Comments: "参数1" },
                ],
                expected_result: "系统记录${para1}",
              },
            ],
          },
        ],
      }, null, 2)}\n`,
      "utf-8",
    )

    const cases = loadConfirmationCases(confirmationFile)
    const testCase = cases.get("TC-PLACEHOLDER-001")
    const step = testCase?.steps[0]

    expect(step?.stepDescription).toBe("执行{para1}操作")
    expect(step?.expectedResult).toBe("系统记录{para1}")
    expect(step?.timeValue).toBe("{time}")
  })

  test("loads only successful non-hardware confirmation cases", () => {
    const workspaceRoot = join(tmpdir(), `dtp-translation-status-${Date.now()}`)
    const confirmationFile = join(workspaceRoot, ".matrix", "data", "confirmation-tests.json")
    mkdirSync(join(workspaceRoot, ".matrix", "data"), { recursive: true })
    writeFileSync(
      confirmationFile,
      `${JSON.stringify({
        test_cases: [
          { case_id: "TC-SUCCESS", translate_status: "success", test_step: [] },
          { case_id: "TC-HARDWARE", translate_status: "success", test_environment: "硬平台测试环境", test_step: [] },
          { case_id: "TC-FAILED", translate_status: "failed", test_step: [] },
          { case_id: "TC-MISSING", test_step: [] },
        ],
      }, null, 2)}\n`,
      "utf-8",
    )

    const loaded = loadConfirmationCasesWithStatus(confirmationFile)

    expect([...loaded.cases.keys()]).toEqual(["TC-SUCCESS"])
    expect(loaded.skippedCases.get("TC-HARDWARE")?.reason).toBe("test_environment is 硬平台测试环境")
    expect(loaded.skippedCases.get("TC-FAILED")?.reason).toBe("translate_status is failed")
    expect(loaded.skippedCases.get("TC-MISSING")?.reason).toBe("translate_status is missing")
  })

  test("ignores requirement-link metadata when loading confirmation cases", () => {
    const workspaceRoot = join(tmpdir(), `dtp-multi-tr-${Date.now()}`)
    const confirmationFile = join(workspaceRoot, ".matrix", "data", "confirmation-tests.json")
    mkdirSync(join(workspaceRoot, ".matrix", "data"), { recursive: true })
    writeFileSync(
      confirmationFile,
      `${JSON.stringify({
        test_cases: [
          {
            case_id: "TC-MULTI-TR-001",
            translate_status: "success",
            correspond_fun_id: "TR-JK-001、 TR-JK-002，TR-JK-003;TR-JK-002；TR-JK-004",
            test_step: [],
          },
        ],
      }, null, 2)}\n`,
      "utf-8",
    )

    const testCase = loadConfirmationCases(confirmationFile).get("TC-MULTI-TR-001")

    expect(testCase).not.toHaveProperty("correspondFunId")
    expect(testCase).not.toHaveProperty("requirementIds")
  })

  test("writes an empty executable dataset when every todo case is non-success", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-no-success-${Date.now()}`)
    const matrixDataDir = join(workspaceRoot, ".matrix", "data")
    mkdirSync(join(matrixDataDir, "DTPProject"), { recursive: true })
    writeFileSync(join(matrixDataDir, "test-cases-todo.txt"), "TC-FAILED\nTC-HARDWARE\n", "utf-8")
    writeFileSync(
      join(matrixDataDir, "confirmation-tests.json"),
      `${JSON.stringify({
        test_cases: [
          { case_id: "TC-FAILED", translate_status: "failed", test_step: [] },
          { case_id: "TC-HARDWARE", translate_status: "success", test_environment: "硬平台测试环境", test_step: [] },
        ],
      }, null, 2)}\n`,
      "utf-8",
    )

    const generated = await runDtpCaseDataInstantiation(workspaceRoot, EMPTY_DOCS_CONTEXT)

    expect(generated.cases).toEqual([])
    expect(generated.warnings).toContain("Case TC-FAILED skipped because translate_status is failed.")
    expect(generated.warnings).toContain("Case TC-HARDWARE skipped because test_environment is 硬平台测试环境.")
    expect(generated.warnings).toContain("No executable confirmation cases remain after translate_status and test_environment filtering.")
    const saved = JSON.parse(readFileSync(resolveDefaultPaths(workspaceRoot).generatedDataFile, "utf-8"))
    expect(saved.cases).toEqual([])
  })

  test("ignores requirements-context.json and requirement-link metadata", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-ignore-requirement-context-${Date.now()}`)
    const matrixDataDir = join(workspaceRoot, ".matrix", "data")
    const keywordDir = join(matrixDataDir, "DTPProject", "组合关键字")
    mkdirSync(keywordDir, { recursive: true })
    writeFileSync(join(matrixDataDir, "test-cases-todo.txt"), "TC-IGNORE-TR-001\n", "utf-8")
    writeFileSync(join(matrixDataDir, "confirmation-tests.json"), `${JSON.stringify({
      test_cases: [{
        case_id: "TC-IGNORE-TR-001",
        translate_status: "success",
        correspond_fun_id: "TR-JK-001、TR-JK-002",
        test_step: [{
          key_name: "执行未知协议操作",
          step_desc: "第1.0秒,执行未知协议操作",
          parameter: [],
        }],
      }],
    }, null, 2)}\n`, "utf-8")
    const contextFile = join(matrixDataDir, "requirements-context.json")
    writeFileSync(contextFile, `${JSON.stringify({
      funItem: [{
        funId: ["TR-JK-001"],
        requirementContext: "This content must not enter DTP planning.",
        inputFlowContext: "Conflicting secondary CAN evidence.",
      }],
    }, null, 2)}\n`, "utf-8")
    writeFileSync(join(keywordDir, "Unknown.json"), `${JSON.stringify({ Name: "执行未知协议操作", Arguments: [] }, null, 2)}\n`, "utf-8")
    writeFileSync(join(keywordDir, "Unknown.txt"), "执行未知协议操作\n", "utf-8")
    const paths = resolveDefaultPaths(workspaceRoot)
    mkdirSync(paths.dtpArtifactsDir, { recursive: true })
    const obsoleteIndex = join(paths.dtpArtifactsDir, "dtp-requirement-context-index.json")
    writeFileSync(obsoleteIndex, "{}\n", "utf-8")

    let planningInput: any
    const generated = await runDtpCaseDataInstantiation(workspaceRoot, EMPTY_DOCS_CONTEXT, {
      planCaseStepData: async (input) => {
        planningInput = input
        return {
          flow_direction: "unknown",
          variant_type: "correct",
          mutations: [],
          checksum_policy: "recompute",
          argument_values: {},
          confidence: 0.9,
          warnings: [],
        }
      },
    })

    expect(generated.cases[0]).not.toHaveProperty("correspond_fun_id")
    expect(generated.cases[0]).not.toHaveProperty("requirement_ids")
    expect(generated.cases[0]).not.toHaveProperty("selected_requirement_id")
    expect(generated.source_files).not.toHaveProperty("requirements_context_file")
    expect(generated.source_files).not.toHaveProperty("requirement_context_index")
    expect(planningInput).not.toHaveProperty("selected_requirement_id")
    expect(planningInput).not.toHaveProperty("requirement_context")
    expect(planningInput).not.toHaveProperty("selected_evidence")
    expect(planningInput).not.toHaveProperty("context_usage")
    expect(JSON.stringify(planningInput)).not.toContain("This content must not enter DTP planning")
    expect(existsSync(contextFile)).toBe(true)
    expect(existsSync(obsoleteIndex)).toBe(false)
  })


  test("reuses identical case-step timeouts only within the current run", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-run-timeout-memo-${Date.now()}`)
    const matrixDataDir = join(workspaceRoot, ".matrix", "data")
    const keywordDir = join(matrixDataDir, "DTPProject", "组合关键字")
    mkdirSync(keywordDir, { recursive: true })
    writeFileSync(join(matrixDataDir, "test-cases-todo.txt"), "TC-TIMEOUT-MEMO\n", "utf-8")
    writeFileSync(
      join(matrixDataDir, "confirmation-tests.json"),
      `${JSON.stringify({
        test_cases: [{
          case_id: "TC-TIMEOUT-MEMO",
          translate_status: "success",
          test_step: [1, 2].map((stepIndex) => ({
            key_name: "执行未知协议操作",
            step_desc: `第${stepIndex}.0秒,执行同一个未知协议操作`,
            parameter: [],
          })),
        }],
      }, null, 2)}\n`,
      "utf-8",
    )
    writeFileSync(
      join(keywordDir, "Unknown.json"),
      `${JSON.stringify({ Name: "执行未知协议操作", Arguments: [] }, null, 2)}\n`,
      "utf-8",
    )
    writeFileSync(join(keywordDir, "Unknown.txt"), "执行未知协议操作\n", "utf-8")

    let planningCalls = 0
    const previousConcurrency = process.env.DTP_MODEL_SECTION_CONCURRENCY
    process.env.DTP_MODEL_SECTION_CONCURRENCY = "1"
    let generated: Awaited<ReturnType<typeof runDtpCaseDataInstantiation>>
    try {
      generated = await runDtpCaseDataInstantiation(workspaceRoot, EMPTY_DOCS_CONTEXT, {
        planCaseStepData: async () => {
          planningCalls += 1
          throw new Error("DTP case-step planning timed out for timeout memo fixture")
        },
      })
    } finally {
      if (previousConcurrency === undefined) delete process.env.DTP_MODEL_SECTION_CONCURRENCY
      else process.env.DTP_MODEL_SECTION_CONCURRENCY = previousConcurrency
    }

    expect(generated.cases[0].generated_steps).toHaveLength(2)
    expect(planningCalls).toBe(1)
    const performanceReport = JSON.parse(readFileSync(resolveDefaultPaths(workspaceRoot).dtpCasePerformanceReportFile, "utf-8"))
    const summaryStage = performanceReport.stages.find((stage: any) => stage.name === "case_generation_summary")
    expect(summaryStage.details.cache).toMatchObject({
      misses: 1,
      timeouts: 1,
      timeout_memo_reuses: 1,
      writes: 0,
    })
  })

  test("uses test-cases-todo as the rerun set and retains non-todo generated cases", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-todo-rerun-${Date.now()}`)
    const matrixDataDir = join(workspaceRoot, ".matrix", "data")
    const keywordDir = join(matrixDataDir, "DTPProject", "组合关键字")
    mkdirSync(keywordDir, { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    writeFileSync(join(matrixDataDir, "test-cases-todo.txt"), "TC-RERUN\n", "utf-8")
    writeFileSync(
      join(matrixDataDir, "confirmation-tests.json"),
      `${JSON.stringify({
        test_cases: [
          {
            case_id: "TC-RERUN",
            translate_status: "success",
            test_step: [
              { key_name: "执行上下文操作", step_desc: "第1.0秒,重新生成用例" },
            ],
          },
          {
            case_id: "TC-KEEP",
            translate_status: "success",
            test_step: [
              { key_name: "执行上下文操作", step_desc: "第1.0秒,保留历史用例" },
            ],
          },
          {
            case_id: "TC-HARDWARE",
            translate_status: "success",
            test_environment: "硬平台测试环境",
            test_step: [
              { key_name: "执行上下文操作", step_desc: "第1.0秒,硬平台历史用例" },
            ],
          },
        ],
      }, null, 2)}\n`,
      "utf-8",
    )
    writeFileSync(
      join(keywordDir, "Context.json"),
      `${JSON.stringify({ Name: "执行上下文操作", Arguments: [] }, null, 2)}\n`,
      "utf-8",
    )
    writeFileSync(join(keywordDir, "Context.txt"), "执行上下文操作\n", "utf-8")

    writeGeneratedTestData(paths.generatedDataFile, {
      schema_version: "1.0.0",
      project_name: "old-project",
      source_files: {
        todo_file: paths.todoFile,
        confirmation_tests_file: paths.confirmationFile,
        keyword_dir: keywordDir,
        project_root: workspaceRoot,
      },
      cases: [
        {
          case_id: "TC-KEEP",
          translate_status: "success",
          case_name: "kept case",
          generated_steps: [],
          warnings: ["historical case marker"],
        },
        {
          case_id: "TC-RERUN",
          translate_status: "success",
          case_name: "stale rerun case",
          generated_steps: [],
          warnings: ["stale case marker"],
        },
        {
          case_id: "TC-HARDWARE",
          translate_status: "success",
          case_name: "stale hardware case",
          test_environment: "硬平台测试环境",
          generated_steps: [],
          warnings: ["must not be retained"],
        },
      ],
      warnings: ["historical warning"],
    })

    const generated = await runDtpCaseDataInstantiation(workspaceRoot, EMPTY_DOCS_CONTEXT)
    const saved = JSON.parse(readFileSync(paths.generatedDataFile, "utf-8"))

    expect(generated.cases.map((testCase) => testCase.case_id)).toEqual(["TC-KEEP", "TC-RERUN"])
    expect(generated.cases.find((testCase) => testCase.case_id === "TC-KEEP")?.warnings).toContain("historical case marker")
    expect(generated.cases.find((testCase) => testCase.case_id === "TC-RERUN")?.warnings).not.toContain("stale case marker")
    expect(saved.cases.map((testCase: any) => testCase.case_id)).toEqual(["TC-KEEP", "TC-RERUN"])
    expect(saved.warnings).toContain("Resumed generated-test-data.json with 1 non-todo case(s) retained.")
    expect(saved.schema_version).toBe("1.1.0")
    expect(readFileSync(paths.generatedDataFile, "utf-8").split(/\r?\n/).filter(Boolean)).toHaveLength(1)
    expect(saved.cases.find((testCase: any) => testCase.case_id === "TC-RERUN").generated_steps[0]).not.toHaveProperty(
      "trace_notes",
    )
    expect(existsSync(join(paths.generatedCasesDir, "TC-RERUN.json"))).toBe(true)
    expect(existsSync(join(paths.generatedCasesDir, "TC-HARDWARE.json"))).toBe(false)
    expect(existsSync(join(paths.generatedDiagnosticsDir, "TC-RERUN.json"))).toBe(true)
    const diagnostic = JSON.parse(readFileSync(join(paths.generatedDiagnosticsDir, "TC-RERUN.json"), "utf-8"))
    expect(diagnostic.case.generated_steps[0]).toHaveProperty("trace_notes")
    const diagnosticIndex = JSON.parse(readFileSync(paths.generatedDiagnosticsIndexFile, "utf-8"))
    expect(diagnosticIndex.summary.case_count).toBe(2)
    expect(diagnosticIndex.summary.step_count).toBe(1)
    expect(existsSync(paths.dtpCasePerformanceReportFile)).toBe(true)
    const performanceReport = JSON.parse(readFileSync(paths.dtpCasePerformanceReportFile, "utf-8"))
    expect(performanceReport.stages.some((stage: any) => (
      stage.name === "case_generation" && stage.details?.case_id === "TC-RERUN"
    ))).toBe(true)
    expect(existsSync(join(paths.generatedDataFilesIndexCasesDir, "TC-RERUN.json"))).toBe(true)
  })

  test("includes argument-quality failures in the diagnostics summary", () => {
    const workspaceRoot = join(tmpdir(), `dtp-argument-diagnostics-${Date.now()}`)
    const paths = resolveDefaultPaths(workspaceRoot)
    mkdirSync(paths.dtpArtifactsDir, { recursive: true })

    writeGeneratedTestData(paths.generatedDataFile, {
      schema_version: "1.0.0",
      source_files: {
        todo_file: paths.todoFile,
        confirmation_tests_file: paths.confirmationFile,
        keyword_dir: paths.keywordDir,
        project_root: workspaceRoot,
      },
      cases: [{
        case_id: "TC-ARG-FAILED",
        translate_status: "success",
        generated_steps: [{
          step_index: 1,
          keyword_name: "发送CANBTXT数据",
          resolved_arguments: [{
            name: "${para2}",
            value: "TODO",
            source: "document-inference",
            required: true,
            confidence: 0.2,
          }],
          generated_data_files: [],
          data_quality: { status: "pass", issues: [] },
          argument_quality: {
            status: "failed",
            expected_argument_count: 1,
            actual_argument_count: 1,
            issues: [{
              severity: "error",
              type: "unresolved_file_argument",
              argument_name: "${para2}",
              message: "File argument ${para2} was not materialized.",
            }],
          },
          warnings: [],
          trace_notes: [],
        }],
        warnings: [],
      }],
      warnings: [],
    })

    const diagnostics = JSON.parse(readFileSync(paths.generatedDiagnosticsIndexFile, "utf-8"))
    expect(diagnostics.summary).toMatchObject({
      step_count: 1,
      passed_steps: 0,
      warning_steps: 0,
      failed_steps: 1,
    })
  })

  test("does not emit requirement-context warnings during case-step planning", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-no-tr-context-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    const dataFileIndex = prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT)
    const generated = await buildGeneratedStepWithPlanning({
      step: {
        stepIndex: 1,
        keywordName: "执行上下文操作",
        stepDescription: "execute without matching requirement context",
      },
      caseContext: {
        caseId: "TC-NO-TR-CONTEXT-001",
        translateStatus: "success",
        steps: [],
      },
      keywordDef: {
        keywordName: "执行上下文操作",
        txtPath: "",
        jsonPath: "",
        arguments: [],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot),
      dataFileIndex,
      docsContext: EMPTY_DOCS_CONTEXT,
    })

    expect(generated.warnings.some((warning) => warning.includes("Requirement context"))).toBe(false)
  })

  test("sanitizes requested filenames before writing generated data files", () => {
    const workspaceRoot = join(tmpdir(), `dtp-requested-name-${Date.now()}`)
    const outputRoot = join(workspaceRoot, "generated")
    mkdirSync(outputRoot, { recursive: true })

    const intent: DataFileIntent = {
      keywordName: "project-data-file-pre-generation",
      argument: { name: "${file}", comments: "Project-level pre-generated input data file." },
      requestedFileName: DIRTY_OUTPUT_NAME,
      stepDescription: "system-normal file hint",
      expectedResult: "write generated data file",
      testPurpose: "clean requested file name",
    }

    const generated = generateDataFile(intent, EMPTY_DOCS_CONTEXT, outputRoot)
    const inputDir = join(outputRoot, INPUT_FLOW)

    expect(generated.requested_file_name).toBe(CLEAN_OUTPUT_NAME)
    expect(generated.file_path).toContain(`\u8f93\u5165\u6570\u636e\\\\\u8f93\u5165\u6d41\\\\${CLEAN_OUTPUT_NAME}`)
    expect(readdirSync(inputDir)).toContain(CLEAN_OUTPUT_NAME)
  })

  test("expands enum and bit-field variants into input-flow data files", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-variant-${Date.now()}`)
    const matrixDataDir = join(workspaceRoot, ".matrix", "data")
    const dtpRoot = join(matrixDataDir, "DTPProject")
    const knowledgeIndexFile = resolveDefaultPaths(workspaceRoot).projectKnowledgeIndexFile
    mkdirSync(dtpRoot, { recursive: true })
    mkdirSync(dirname(knowledgeIndexFile), { recursive: true })

    writeFileSync(
      knowledgeIndexFile,
      `${JSON.stringify({
        schema_version: "1.0.0",
        extractor_version: EXTRACTOR_VERSION,
        project_root: workspaceRoot,
        source_documents: [],
        topics: [],
        snippets: [
          {
            id: "doc-1-snippet-1",
            source_document_id: "doc-1",
            topic: "hardware_interface",
            text: "3.1.1.4 \u4e0a\u884c\u6570\u636e\u5757\u53ca\u5e94\u7b54\u683c\u5f0f\u8bf4\u660e",
            confidence: 0.9,
          },
          {
            id: "doc-1-snippet-2",
            source_document_id: "doc-1",
            topic: "requirement_input_flow",
            text: `${INPUT_FLOW}\uff1a${DATA_BLOCK}`,
            confidence: 0.9,
          },
          {
            id: "doc-1-snippet-3",
            source_document_id: "doc-1",
            topic: "packet_structure",
            text: "\u8868 B-10 \u53d1\u5411\u7535\u6c60\u7ba1\u7406\u4e0b\u4f4d\u673a\u957f\u5ea6 9 \u5b57\u8282\u7684\u4e0a\u884c\u6570\u636e\u5757",
            confidence: 0.9,
          },
          {
            id: "doc-1-snippet-4",
            source_document_id: "doc-1",
            topic: "packet_structure",
            text: `\u8868 B-12 ${DATA_BLOCK}`,
            confidence: 0.9,
          },
        ],
        tables: [
          {
            id: "doc-1-table-1",
            source_document_id: "doc-1",
            caption: "\u8868 B-10 \u53d1\u5411\u7535\u6c60\u7ba1\u7406\u4e0b\u4f4d\u673a\u957f\u5ea6 9 \u5b57\u8282\u7684\u4e0a\u884c\u6570\u636e\u5757",
            aliases: [],
            topic: "packet_structure",
            rows: [
              ["\u5e8f\u53f7", "\u4ef2\u88c1\u573a", "\u63a7\u5236\u573a", "TITLE", "LENGTH", "W0", "W1", "W2", "W3", "W4", "SUM"],
              ["1.", "86H", "04H", "T23H", "L06H", "W0", "W1", "W2", "W3", "W4", "SUM"],
            ],
            confidence: 0.9,
            warnings: [],
          },
          {
            id: "doc-1-table-2",
            source_document_id: "doc-1",
            caption: `\u8868 B-12 ${DATA_BLOCK}`,
            aliases: [],
            topic: "packet_structure",
            rows: [
              ["\u5b57\u6bb5", "\u8bf4\u660e", "\u53d6\u503c"],
              ["W0", "\u56fa\u5b9a\u503c", "11H"],
              ["W1", "\u56fa\u5b9a\u503c", "22H"],
              ["W2", "\u56fa\u5b9a\u503c", "33H"],
              ["W3", `\u52a0\u70ed\u56de\u8def\u9009\u62e9\n01H\uff1a${MAIN_LOOP}\uff1b\n02H\uff1a${BACKUP_LOOP}`, ""],
              [
                "W4",
                `\u63a7\u6e29\u6a21\u5f0f
D7D6 \uff1a01-\u95ed\u73af\uff0c10-\u5f00\u73af
D5 \uff1a1-${OPEN_HEAT_ON}\uff0c0-${OPEN_HEAT_OFF}
D4\uff1a0-\u6062\u590d\u4e3a\u9ed8\u8ba4\u63a7\u6e29\u7535\u963b\u9009\u53d6\u51c6\u5219 1-\u6309\u7167D3D2D1D0\u4f4d\u9009\u53d6\u63a7\u6e29\u7535\u963b
D3D2D1D0    0001\uff1a${TEMPERATURE_1}
0010\uff1a\u84c4\u7535\u6c60\u7ec4\u6e29\u5ea62
0011\uff1a\u84c4\u7535\u6c60\u7ec4\u6e29\u5ea63
0100\uff1a\u84c4\u7535\u6c60\u7ec4\u6e29\u5ea64
0101\uff1a\u84c4\u7535\u6c60\u7ec4\u6e29\u5ea65
0110\uff1a\u84c4\u7535\u6c60\u7ec4\u6e29\u5ea66
0111\uff1a${TEMPERATURE_7}`,
                "",
              ],
            ],
            confidence: 0.9,
            warnings: [],
          },
        ],
        section_protocol_models: [
          {
            id: "section-1",
            source_document_id: "doc-1",
            section_id: "3.1.1.4",
            section_title: "3.1.1.4 \u4e0a\u884c\u6570\u636e\u5757\u53ca\u5e94\u7b54\u683c\u5f0f\u8bf4\u660e",
            section_snippet_ids: ["doc-1-snippet-1", "doc-1-snippet-2", "doc-1-snippet-3", "doc-1-snippet-4"],
            input_flow_snippet_ids: ["doc-1-snippet-2", "doc-1-snippet-3", "doc-1-snippet-4"],
            output_flow_snippet_ids: [],
            table_ids: ["doc-1-table-1", "doc-1-table-2"],
            primary_table_ids: ["doc-1-table-1"],
            support_table_ids: ["doc-1-table-2"],
            protocol_relations: [
              {
                frame_table_id: "doc-1-table-1",
                generation_mode: "frame_file",
                preferred_name: DATA_BLOCK,
                flow_direction: "input",
                source_section: "3.1.1.4 \u4e0a\u884c\u6570\u636e\u5757\u53ca\u5e94\u7b54\u683c\u5f0f\u8bf4\u660e",
                source_flow_heading: INPUT_FLOW,
                should_generate_frame_table_file: true,
                checksum_rule: "SUM = low8(byte-sum(TITLE + W0 + W1 + ... + W(n-1)))",
                confidence: 0.9,
                reasoning: ["test fixture"],
              },
            ],
            protocols: [],
            confidence: 0.9,
            warnings: [],
          },
        ],
        packet_model_candidates: [],
        references: [],
        warnings: [],
        updated_at: new Date().toISOString(),
      }, null, 2)}\n`,
      "utf-8",
    )

    const result = await runDtpProjectDataFilesGeneration(
      workspaceRoot,
      {
        backgroundDocs: [],
        hardwareDocs: [],
        protocolDocs: [],
        conventionDocs: [],
        packetStructureDocs: [],
        formatRuleDocs: [],
        requirementDocs: [],
      },
      undefined,
      { knowledgeMode: "offline" },
    )

    const inputDataDir = join(dtpRoot, "V1", INPUT_DATA)
    const protocolDefinitionsFile = resolveDefaultPaths(workspaceRoot).dtpProtocolDefinitionsFile
    const protocolDefinitions = JSON.parse(readFileSync(protocolDefinitionsFile, "utf-8"))
    const fileNames = readdirSync(inputDataDir).filter((name) => name.endsWith(".txt")).sort()

    expect(result.generated_files.length).toBe(20)
    expect(result.protocol_definitions_file).toBe(protocolDefinitionsFile)
    expect(protocolDefinitions.source).toBe("heuristic-fallback")
    expect(protocolDefinitions.protocols[0].flow_direction).toBe("input")
    expect(protocolDefinitions.protocols[0].frames?.[0].source_table_id).toBe("doc-1-table-1")
    expect(protocolDefinitions.protocols[0].evidence).toContain("\u8868 B-12 \u84c4\u7535\u6c60\u6e29\u63a7\u53c2\u6570\u6570\u636e\u5757")
    expect(fileNames).toContain(`${DATA_BLOCK}-${MAIN_LOOP}-${CLOSED_DEFAULT}.txt`)
    expect(fileNames).toContain(`${DATA_BLOCK}-${BACKUP_LOOP}-${OPEN_HEAT_ON}.txt`)
    expect(fileNames).toContain(`${DATA_BLOCK}-${MAIN_LOOP}-${TEMPERATURE_1}.txt`)
    expect(fileNames).toContain(`${DATA_BLOCK}-${BACKUP_LOOP}-${TEMPERATURE_7}.txt`)
    expect(fileNames.some((name) => /D5|D4|D3D2D1D0|[:\uff1a]/.test(name))).toBe(false)
    expect(existsSync(join(dtpRoot, "V1", INPUT_DATA, OUTPUT_FLOW))).toBe(false)

    const openHeatFile = join(inputDataDir, `${DATA_BLOCK}-${MAIN_LOOP}-${OPEN_HEAT_ON}.txt`)
    const temperatureFile = join(inputDataDir, `${DATA_BLOCK}-${MAIN_LOOP}-${TEMPERATURE_1}.txt`)
    expect(readFileSync(openHeatFile, "utf-8")).toContain("01 A0")
    expect(readFileSync(temperatureFile, "utf-8")).toContain("01 51")
    expect(result.generated_files.every((entry) => entry.file_path.split(/\\\\+/).length === 2)).toBe(true)
    expect(result.generated_files.some((entry) => entry.field_value_plan?.some((item) => item.value_source === "bitfield-enum"))).toBe(true)
  })

  test("writes project-level input and output protocols flat while preserving flow metadata", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-flow-${Date.now()}`)
    const matrixDataDir = join(workspaceRoot, ".matrix", "data")
    const dtpRoot = join(matrixDataDir, "DTPProject")
    const knowledgeIndexFile = resolveDefaultPaths(workspaceRoot).projectKnowledgeIndexFile
    mkdirSync(dtpRoot, { recursive: true })
    mkdirSync(dirname(knowledgeIndexFile), { recursive: true })

    writeFileSync(
      knowledgeIndexFile,
      `${JSON.stringify({
        schema_version: "1.0.0",
        extractor_version: EXTRACTOR_VERSION,
        project_root: workspaceRoot,
        source_documents: [],
        topics: [],
        snippets: [
          {
            id: "doc-2-snippet-1",
            source_document_id: "doc-2",
            topic: "hardware_interface",
            text: "3.1.1.1 \u901f\u53d8\u9065\u6d4b\u8f6e\u8be2\u53ca\u5e94\u7b54\u683c\u5f0f\u8bf4\u660e",
            confidence: 0.9,
          },
          {
            id: "doc-2-snippet-2",
            source_document_id: "doc-2",
            topic: "requirement_input_flow",
            text: `${INPUT_FLOW}\uff1a${FAST_POLL}\u3002`,
            confidence: 0.9,
          },
          {
            id: "doc-2-snippet-3",
            source_document_id: "doc-2",
            topic: "packet_structure",
            text: `\u8868 B-1 ${FAST_POLL}`,
            confidence: 0.9,
          },
          {
            id: "doc-2-snippet-4",
            source_document_id: "doc-2",
            topic: "requirement_output_flow",
            text: `${OUTPUT_FLOW}\uff1a${FAST_TM}\uff1b`,
            confidence: 0.9,
          },
          {
            id: "doc-2-snippet-5",
            source_document_id: "doc-2",
            topic: "packet_structure",
            text: `\u8868 B-2 ${FAST_TM}\u4f20\u9001\u683c\u5f0f`,
            confidence: 0.9,
          },
        ],
        tables: [
          {
            id: "doc-2-table-1",
            source_document_id: "doc-2",
            caption: `\u8868 B-1 ${FAST_POLL}`,
            aliases: [],
            topic: "packet_structure",
            rows: [
              ["\u5e8f\u53f7", "\u4ef2\u88c1\u573a", "\u63a7\u5236\u573a", "TITLE", "W0", "SUM"],
              ["1.", "86H", "04H", "T10H", "W0", "SUM"],
            ],
            confidence: 0.9,
            warnings: [],
          },
          {
            id: "doc-2-table-2",
            source_document_id: "doc-2",
            caption: `\u8868 B-2 ${FAST_TM}\u4f20\u9001\u683c\u5f0f`,
            aliases: [],
            topic: "packet_structure",
            rows: [
              ["\u5e8f\u53f7", "\u4ef2\u88c1\u573a", "\u63a7\u5236\u573a", "TITLE", "LENGTH", "W0", "SUM"],
              ["1.", "87H", "05H", "T23H", "L1FH", "W0", "SUM"],
            ],
            confidence: 0.9,
            warnings: [],
          },
        ],
        section_protocol_models: [],
        packet_model_candidates: [],
        references: [],
        warnings: [],
        updated_at: new Date().toISOString(),
      }, null, 2)}\n`,
      "utf-8",
    )

    const result = await runDtpProjectDataFilesGeneration(
      workspaceRoot,
      {
        backgroundDocs: [],
        hardwareDocs: [],
        protocolDocs: [],
        conventionDocs: [],
        packetStructureDocs: [],
        formatRuleDocs: [],
        requirementDocs: [],
      },
      undefined,
      { knowledgeMode: "offline" },
    )

    const paths = resolveDefaultPaths(workspaceRoot)
    const inputDataDir = join(dtpRoot, "V1", INPUT_DATA)
    const protocolDefinitions = JSON.parse(readFileSync(paths.dtpProtocolDefinitionsFile, "utf-8"))
    const writerPreview = JSON.parse(readFileSync(paths.dtpProtocolWriterPreviewFile, "utf-8"))
    const qualityReport = JSON.parse(readFileSync(paths.dtpDataQualityReportFile, "utf-8"))
    const retryContext = JSON.parse(readFileSync(paths.dtpProtocolRetryContextFile, "utf-8"))
    const fileNames = readdirSync(inputDataDir).filter((name) => name.endsWith(".txt")).sort()

    expect(result.generated_files.length).toBe(2)
    expect(result.protocol_writer_preview_file).toBe(paths.dtpProtocolWriterPreviewFile)
    expect(protocolDefinitions.protocols.map((protocol: any) => protocol.flow_direction).sort()).toEqual(["input", "output"])
    expect(protocolDefinitions.protocols.map((protocol: any) => protocol.base_file_name).sort()).toEqual([FAST_POLL, FAST_TM].sort())
    expect(writerPreview.legacy_generated_count).toBe(0)
    expect(writerPreview.protocol_writer_generated_count).toBe(2)
    expect(writerPreview.matched_file_paths).toEqual([])
    expect(writerPreview.legacy_only_file_paths).toEqual([])
    expect(writerPreview.protocol_writer_only_file_paths).toEqual([])
    expect(writerPreview.skipped_protocols).toEqual([])
    expect(qualityReport.status).toBe("pass")
    expect(qualityReport.checked_file_count).toBe(2)
    expect(qualityReport.issue_counts.error).toBe(0)
    expect(retryContext.status).toBe("not_needed")
    expect(retryContext.affected_protocols.length).toBe(0)
    expect(fileNames).toEqual([`${FAST_POLL}.txt`, `${FAST_TM}.txt`].sort())
    expect(fileNames.some((name) => name.includes("\u8868"))).toBe(false)
    expect(result.generated_files.some((entry) => entry.file_path === `${INPUT_DATA}\\\\${FAST_POLL}.txt` && entry.flow_direction === "input")).toBe(true)
    expect(result.generated_files.some((entry) => entry.file_path === `${INPUT_DATA}\\\\${FAST_TM}.txt` && entry.flow_direction === "output")).toBe(true)
  })

  test("builds model-backed protocol definitions from section context packages", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-protocol-model-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    const knowledgeIndex = {
      schema_version: "1.0.0",
      extractor_version: EXTRACTOR_VERSION,
      project_root: workspaceRoot,
      source_documents: [],
      topics: [],
      snippets: [
        {
          id: "doc-3-snippet-1",
          source_document_id: "doc-3",
          topic: "hardware_interface",
          text: "3.1.1.1 \u901f\u53d8\u9065\u6d4b\u8f6e\u8be2\u53ca\u5e94\u7b54\u683c\u5f0f\u8bf4\u660e",
          confidence: 0.9,
        },
        {
          id: "doc-3-snippet-2",
          source_document_id: "doc-3",
          topic: "output_flow",
          text: `${OUTPUT_FLOW}\uff1a${FAST_TM}\u3002`,
          confidence: 0.9,
        },
        {
          id: "doc-3-snippet-3",
          source_document_id: "doc-3",
          topic: "packet_structure",
          text: `\u8868 B-2 ${FAST_TM}\u4f20\u9001\u683c\u5f0f`,
          confidence: 0.9,
        },
      ],
      tables: [
        {
          id: "doc-3-table-1",
          source_document_id: "doc-3",
          caption: `\u8868 B-2 ${FAST_TM}\u4f20\u9001\u683c\u5f0f`,
          aliases: [],
          topic: "packet_structure",
          rows: [
            ["\u5e8f\u53f7", "\u4ef2\u88c1\u573a", "\u63a7\u5236\u573a", "TITLE", "W0", "SUM"],
            ["1.", "87H", "05H", "T23H", "W0", "SUM"],
          ],
          confidence: 0.9,
          warnings: [],
        },
      ],
      section_protocol_models: [
        {
          id: "section-model-output",
          source_document_id: "doc-3",
          section_id: "3.1.1.1",
          section_title: "3.1.1.1 \u901f\u53d8\u9065\u6d4b\u8f6e\u8be2\u53ca\u5e94\u7b54\u683c\u5f0f\u8bf4\u660e",
          section_snippet_ids: ["doc-3-snippet-1", "doc-3-snippet-2", "doc-3-snippet-3"],
          input_flow_snippet_ids: [],
          output_flow_snippet_ids: ["doc-3-snippet-2", "doc-3-snippet-3"],
          table_ids: ["doc-3-table-1"],
          primary_table_ids: ["doc-3-table-1"],
          support_table_ids: [],
          protocol_relations: [],
          protocols: [],
          confidence: 0.9,
          warnings: [],
        },
      ],
      packet_model_candidates: [],
      references: [],
      warnings: [],
      updated_at: new Date().toISOString(),
    } as any

    const definitions = await buildDtpProtocolDefinitionsDocument(paths, knowledgeIndex, {
      understandSectionProtocols: async (context) => ({
        protocols: [
          {
            protocol_id: `${context.section_model_id}-model-1`,
            source_section: context.section_title,
            flow_direction: "output",
            base_file_name: FAST_TM,
            generation_mode: "single_file",
            frame: {
              source_table_id: "doc-3-table-1",
              byte_layout: ["87", "05", "23", "W0", "SUM"],
              checksum: { type: "sum_low8", start: "TITLE", end: "BEFORE_SUM" },
            },
            bus_context: {
              bus_type: "CAN",
              controller: "SJA1000T",
              mode: "PELICAN",
              frame_format: "standard",
              frame_buffer_layout: "business-payload",
              frame_information: {
                apply_to_case_data: true,
                strategy: "derive_from_ff_rtr_dlc",
              },
            },
            fields: [
              { name: "W0", type: "fixed", value: "1A", source_table_id: "doc-3-table-1", confidence: 0.9 },
            ],
            variants: [
              {
                name: "\u6a21\u578b\u53d8\u4f53D7=",
                fields: [
                  { name: "W0", type: "fixed", value: "2A", source_table_id: "doc-3-table-1", confidence: 0.9 },
                ],
                evidence: ["model variant fixture"],
                warnings: [],
                confidence: 0.88,
              },
            ],
            evidence: ["\u8868 B-2"],
            warnings: [],
            confidence: 0.95,
          },
        ],
        non_generated_tables: [],
        warnings: [],
      }),
    })

    expect(definitions.source).toBe("model")
    expect(definitions.protocols[0].understanding_source).toBe("model")
    expect(definitions.protocols[0].flow_direction).toBe("output")
    expect(definitions.protocols[0].fields[0].value).toBe("1A")
    expect(definitions.protocols[0].variants?.[0].name).toBe("\u6a21\u578b\u53d8\u4f53")
    expect(definitions.protocols[0].variants?.[0].fields[0].value).toBe("2A")
    expect(definitions.protocols[0].bus_context).toMatchObject({
      bus_type: "CAN",
      controller: "SJA1000T",
      controller_family: "SJA1000",
      mode: "PeliCAN",
      frame_information: {
        apply_to_case_data: true,
        strategy: "derive_from_ff_rtr_dlc",
      },
    })
    expect(definitions.sections[0].protocol_ids).toEqual(["section-model-output-model-1"])
  })

  test("keeps an explicit CAN DLC table layout when the model expands trailing placeholders", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-can-dlc-table-layout-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    const knowledgeIndex = createCanBusProfileKnowledgeIndex(workspaceRoot, [
      "IF-CAN0-001 uses SJA1000T in standard PeliCAN mode.",
    ])
    knowledgeIndex.tables[0].rows = [
      ["帧序号", "仲裁场、控制场", "", "有效数据场", "", "", "", "", "", "", ""],
      ["", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"],
      ["", "ID10～ID3", "ID2～ID0，RTR，DLC", "", "", "", "", "", "", "", ""],
      ["", "8DH", "04H", "T00H", "10H", "01H", "SUM", "-", "-", "-", "-"],
    ]

    const definitions = await buildDtpProtocolDefinitionsDocument(paths, knowledgeIndex, {
      understandSectionProtocols: async (context) => {
        const response = canProtocolModelResponse(context, {
          bus_type: "CAN",
          interface_level: "primary",
          interface_id: "IF-CAN0-001",
          controller: "SJA1000T",
          mode: "PeliCAN",
          frame_format: "standard",
          frame_information: { apply_to_case_data: true, strategy: "derive_from_ff_rtr_dlc" },
        }) as any
        const frame = response.protocols[0].frames[0]
        frame.byte_layout = ["8D", "04", "00", "10", "01", "SUM", "00", "00", "00", "00"]
        frame.field_layout.push(
          { name: "UNUSED", role: "unknown", byte_offset: 6, byte_length: 1, default_value: "00", source_text: "-" },
          { name: "UNUSED", role: "unknown", byte_offset: 7, byte_length: 1, default_value: "00", source_text: "-" },
          { name: "UNUSED", role: "unknown", byte_offset: 8, byte_length: 1, default_value: "00", source_text: "-" },
          { name: "UNUSED", role: "unknown", byte_offset: 9, byte_length: 1, default_value: "00", source_text: "-" },
        )
        return response
      },
    })

    const frame = definitions.protocols[0].frames?.[0]
    expect(frame?.byte_layout).toEqual(["8D", "04", "00", "10", "01", "SUM"])
    expect(frame?.field_layout.some((field) => field.byte_offset >= 6)).toBe(false)
  })

  test("inherits a unique document-level SJA1000T PeliCAN profile for case data", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-document-can-profile-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    mkdirSync(paths.inputDataRoot, { recursive: true })
    const knowledgeIndex = createCanBusProfileKnowledgeIndex(workspaceRoot, [
      "\u603b\u7ebf\u63a7\u5236\u5668\u91c7\u7528 SJA1000T\uff0c\u6807\u51c6 PELICAN \u6a21\u5f0f\u3002",
    ])
    let capturedProfiles: unknown
    const definitions = await buildDtpProtocolDefinitionsDocument(paths, knowledgeIndex, {
      understandSectionProtocols: async (context) => {
        capturedProfiles = context.bus_profiles
        return canProtocolModelResponse(context, {
          bus_type: "CAN",
          controller: "unknown",
          controller_family: "unknown",
          mode: "unknown",
          frame_format: "standard",
          frame_buffer_layout: "business-payload",
        })
      },
    })

    expect(capturedProfiles).toEqual([
      expect.objectContaining({
        controller: "SJA1000T",
        controller_family: "SJA1000",
        mode: "PeliCAN",
      }),
    ])
    expect(definitions.protocols[0].bus_context).toMatchObject({
      bus_type: "CAN",
      controller: "SJA1000T",
      controller_family: "SJA1000",
      mode: "PeliCAN",
      frame_information: {
        apply_to_case_data: true,
        strategy: "derive_from_ff_rtr_dlc",
      },
    })

    const dataFileIndex = prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT)
    const generated = buildGeneratedStep({
      step: {
        stepIndex: 1,
        keywordName: "SendCANDataFile",
        stepDescription: "\u901a\u8fc7CAN\u603b\u7ebf\u53d1\u9001\u6b63\u786e\u7684\u9065\u6d4b\u5e271\u8f6e\u8be2\u63a7\u5236\u5e8f\u5217",
        rawParams: [],
      },
      caseContext: {
        caseId: "TC-DOCUMENT-PROFILE-001",
        testPurpose: "\u9a8c\u8bc1\u6587\u6863\u7ea7 PeliCAN \u914d\u7f6e\u7ee7\u627f",
        requirementIds: [],
        steps: [],
      },
      keywordDef: {
        keywordName: "SendCANDataFile",
        txtPath: "",
        jsonPath: "",
        arguments: [{ name: "${para2}", comments: "\u6570\u636e\u6587\u4ef6" }],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex,
      dataFileIndex,
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions: definitions,
      dataGenerationPlan: {
        protocol_name: "\u9065\u6d4b\u5e271\u8f6e\u8be2\u63a7\u5236\u5e8f\u5217",
        flow_direction: "input",
        variant_type: "correct",
        mutations: [],
        sequence_operations: [],
        checksum_policy: "recalculate_correctly",
        argument_values: {},
        evidence_ids: [],
        confidence: 1,
        warnings: [],
        source: "heuristic-fallback",
      },
    })
    const outputFile = join(
      paths.inputDataRoot,
      INPUT_FLOW,
      "\u7528\u4f8b\u751f\u6210",
      "TC-DOCUMENT-PROFILE-001",
      generated.generated_data_files[0].requested_file_name,
    )
    expect(readFileSync(outputFile, "utf-8").trim()).toBe("04 8D 04 00 10 01 11")
  })

  test("uses the nearest structural CAN interface heading instead of a transparent-forwarding sentence", () => {
    const workspaceRoot = join(tmpdir(), `dtp-can-structural-scope-${Date.now()}`)
    const index = createEmptyKnowledgeIndex(workspaceRoot)
    index.snippets = [
      { id: "doc-scope-snippet-1", source_document_id: "doc-scope", topic: "hardware_interface", text: "一级CAN总线接口及相关数据流", confidence: 1 },
      { id: "doc-scope-snippet-2", source_document_id: "doc-scope", topic: "hardware_interface", text: "IF-CAN0-001：一级CAN总线接口", confidence: 1 },
      { id: "doc-scope-snippet-3", source_document_id: "doc-scope", topic: "requirement_input_flow", text: "输入流：星务时间广播数据，通过二级CAN总线透明转发。", confidence: 1 },
      { id: "doc-scope-snippet-4", source_document_id: "doc-scope", topic: "background_knowledge", text: "表3.1.1.10-1 星务时间广播格式", confidence: 1 },
    ]
    index.section_protocol_models = [{
      id: "section-scope",
      source_document_id: "doc-scope",
      section_id: "3.1.1.10",
      section_title: "3.1.1.10 星务时间广播格式",
      section_path: [],
      chapter_role: "interface_requirement",
      content_role: "frame_definition",
      section_snippet_ids: ["doc-scope-snippet-3", "doc-scope-snippet-4"],
      input_flow_snippet_ids: ["doc-scope-snippet-3", "doc-scope-snippet-4"],
      output_flow_snippet_ids: [],
      table_ids: [],
      primary_table_ids: [],
      support_table_ids: [],
      protocol_relations: [],
      protocols: [],
      confidence: 1,
      warnings: [],
    }]

    const context = buildDtpProtocolContextPackages(index)[0]

    expect(context.interface_context_text).toContain("IF-CAN0-001")
    expect(context.interface_context_text).not.toContain("透明转发")
  })

  test("keeps a CAN frame table on CAN when its context references SpaceWire", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-can-spacewire-reference-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    const knowledgeIndex = createCanBusProfileKnowledgeIndex(workspaceRoot, [
      "一级CAN总线接口及相关数据流",
      "IF-CAN0-001：一级CAN总线接口",
    ])
    knowledgeIndex.snippets.push({
      id: "doc-can-spacewire-reference",
      source_document_id: "doc-can",
      topic: "requirement_input_flow",
      text: "星务时间广播数据可由 SpaceWire 接口相关功能引用，但本表定义的是一级CAN接收帧。",
      confidence: 1,
    })
    knowledgeIndex.section_protocol_models[0] = {
      ...knowledgeIndex.section_protocol_models[0],
      section_id: "3.1.1.10",
      section_title: "3.1.1.10 星务时间广播格式",
      section_snippet_ids: ["doc-can-snippet-100", "doc-can-spacewire-reference"],
      input_flow_snippet_ids: ["doc-can-snippet-100", "doc-can-spacewire-reference"],
    }
    knowledgeIndex.tables[0] = {
      ...knowledgeIndex.tables[0],
      caption: "表3.1.1.10-1 星务时间广播格式",
      rows: [
        ["帧序号", "仲裁场", "控制场", "帧序号", "LENGTH", "TITLE", "W0", "W1", "W2", "W3", "W4"],
        ["1", "4FH", "28H", "00H", "08H", "T40H", "W0", "W1", "W2", "W3", "W4"],
        ["2", "4FH", "25H", "01H", "W5", "W6", "W7", "SUM"],
      ],
    }

    const definitions = await buildDtpProtocolDefinitionsDocument(paths, knowledgeIndex, {
      understandSectionProtocols: async (context) => canProtocolModelResponse(context, {
        bus_type: "SpaceWire",
        interface_id: "IF-Spacewire-001",
        interface_name: "SpaceWire总线接口",
        controller: "FPGA",
      }),
    })

    expect(definitions.protocols[0].bus_context).toMatchObject({
      bus_type: "CAN",
    })
    expect(definitions.protocols[0].bus_context?.warnings).toContain(
      "Model bus_type SpaceWire was overridden by table-local CAN frame evidence.",
    )
  })

  test("does not inherit a primary CAN PeliCAN profile into a secondary CAN section", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-interface-scoped-can-profile-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    const knowledgeIndex = createCanBusProfileKnowledgeIndex(workspaceRoot, [
      "一级CAN总线接口采用 SJA1000T，标准 PELICAN 模式。",
      "二级CAN总线接口由 FPGA 实现，每帧使用独立接口封装。",
    ])
    knowledgeIndex.section_protocol_models[0].section_title = "3.1.3.1 二级CAN遥测数据"
    knowledgeIndex.section_protocol_models[0].section_path = [
      "3 数据及接口需求",
      "3.1.3 二级CAN总线接口",
    ]

    const definitions = await buildDtpProtocolDefinitionsDocument(paths, knowledgeIndex, {
      understandSectionProtocols: async (context) => canProtocolModelResponse(context, {
        bus_type: "CAN",
        controller: "unknown",
        controller_family: "unknown",
        mode: "unknown",
        frame_format: "standard",
        frame_buffer_layout: "business-payload",
      }),
    })

    expect(definitions.protocols[0].bus_context).toMatchObject({
      interface_level: "secondary",
      profile_scope: "interface",
      controller: "FPGA",
      controller_family: "unknown",
      mode: "unknown",
    })
    expect(definitions.protocols[0].bus_context?.frame_information).toBeUndefined()
    expect(definitions.protocols[0].bus_context?.warnings).toContain(
      "Document-level CAN bus profiles conflict with the explicit section bus context; section values were kept.",
    )
  })

  test("compiles secondary CAN station expressions and a fixed FPGA envelope from section evidence", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-secondary-can-compiler-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    const knowledgeIndex = createCanBusProfileKnowledgeIndex(workspaceRoot, [
      "二级CAN总线接口由FPGA实现，每帧10字节业务帧前增加0010H后形成12字节接口数据。",
    ])
    knowledgeIndex.section_protocol_models[0].section_title = "3.1.3.1 二级CAN遥测数据"
    knowledgeIndex.section_protocol_models[0].section_path = [
      "3 数据及接口需求",
      "3.1.3 二级CAN总线接口",
    ]
    knowledgeIndex.tables[0].caption = "表3.1.3.1-3 3帧遥测数据格式定义"
    knowledgeIndex.tables[0].rows = [
      ["帧序号", "仲裁场", "控制场", "帧序号", "长度", "TITLE", "W0", "W1", "W2", "W3", "W4"],
      ["1", "80H+站地址", "68H", "00H", "12H", "T20H+站地址", "00H", "00H", "00H", "00H", "00H"],
    ]
    knowledgeIndex.tables.push({
      id: "doc-can-table-stations",
      source_document_id: "doc-can",
      caption: "站地址定义",
      aliases: [],
      topic: "data_convention",
      rows: [
        ["单机名称", "站地址"],
        ["测试单机", "0CH"],
      ],
      confidence: 0.9,
      warnings: [],
    })
    knowledgeIndex.section_protocol_models[0].table_ids.push("doc-can-table-stations")
    knowledgeIndex.section_protocol_models[0].support_table_ids.push("doc-can-table-stations")

    const definitions = await buildDtpProtocolDefinitionsDocument(paths, knowledgeIndex, {
      understandSectionProtocols: async (context) => canProtocolModelResponse(context, {
        bus_type: "CAN",
        controller: "unknown",
        controller_family: "unknown",
        mode: "unknown",
        frame_format: "standard",
        frame_buffer_layout: "business-payload",
      }),
    })
    const protocol = definitions.protocols[0]
    const frame = protocol.frames?.[0]

    expect(protocol.bus_context).toMatchObject({
      interface_level: "secondary",
      controller: "FPGA",
      profile_scope: "interface",
    })
    expect(protocol.variables).toEqual([
      expect.objectContaining({
        name: "station_address",
        options: [expect.objectContaining({ value: "0C", label: "测试单机" })],
      }),
    ])
    expect(frame?.field_layout.find((field) => field.byte_offset === 0)?.value_rule).toEqual({
      operation: "add_low8",
      base: "80",
      variable: "station_address",
    })
    expect(frame?.field_layout.find((field) => field.name === "TITLE")?.value_rule).toEqual({
      operation: "add_low8",
      base: "20",
      variable: "station_address",
    })
    expect(protocol.frame_envelope).toMatchObject({
      type: "fixed_prefix",
      bytes: ["00", "10"],
      applies_per_frame: true,
      position: "before_frame",
      raw_value: "0010H",
      byte_order: "document_order",
      business_frame_length: 10,
      wire_frame_length: 12,
      confidence: 1,
    })
  })

  test("rejects conflicting secondary CAN per-frame prefixes instead of guessing", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-secondary-can-envelope-conflict-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    const knowledgeIndex = createCanBusProfileKnowledgeIndex(workspaceRoot, [
      "二级CAN由FPGA实现，发送时在每帧10字节业务帧前增加0008H后形成12字节数据；备用通道接收时在每帧10字节业务帧前增加0010H后形成12字节数据。",
    ])
    knowledgeIndex.section_protocol_models[0].section_title = "3.1.3 二级CAN总线接口"
    knowledgeIndex.section_protocol_models[0].section_path = ["3 数据及接口需求", "3.1.3 二级CAN总线接口"]

    const definitions = await buildDtpProtocolDefinitionsDocument(paths, knowledgeIndex, {
      understandSectionProtocols: async (context) => canProtocolModelResponse(context, {
        bus_type: "CAN",
        controller: "unknown",
        controller_family: "unknown",
        mode: "unknown",
        frame_format: "standard",
        frame_buffer_layout: "business-payload",
      }),
    })

    expect(definitions.protocols[0].frame_envelope).toBeUndefined()
    expect(definitions.protocols[0].warnings).toContain(
      "Conflicting per-frame prefixes were documented for the same secondary CAN interface: 00 08, 00 10.",
    )
  })

  test("accepts a model-extracted per-frame prefix only when source evidence supports it", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-secondary-can-envelope-model-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    const knowledgeIndex = createCanBusProfileKnowledgeIndex(workspaceRoot, [
      "注：二级CAN接口每帧采用固定前缀0010H，业务帧为10字节，封装后形成12字节接口帧。",
    ])
    knowledgeIndex.section_protocol_models[0].section_title = "3.1.3 二级CAN总线接口"
    knowledgeIndex.section_protocol_models[0].section_path = ["3 数据及接口需求", "3.1.3 二级CAN总线接口"]

    const definitions = await buildDtpProtocolDefinitionsDocument(paths, knowledgeIndex, {
      understandSectionProtocols: async (context) => {
        const response = canProtocolModelResponse(context, {
          bus_type: "CAN",
          interface_level: "secondary",
          controller: "FPGA",
          controller_family: "unknown",
          mode: "unknown",
          frame_format: "standard",
          frame_buffer_layout: "business-payload",
        }) as { protocols: Array<Record<string, unknown>> }
        response.protocols[0].frame_envelope = {
          type: "fixed_prefix",
          bytes: ["00", "10"],
          applies_per_frame: true,
          position: "before_frame",
          raw_value: "0010H",
          byte_order: "document_order",
          business_frame_length: 10,
          wire_frame_length: 12,
          directions: ["send", "receive"],
          confidence: 0.88,
          source_text: "二级CAN接口每帧采用固定前缀0010H",
        }
        return response
      },
    })

    expect(definitions.protocols[0].frame_envelope).toMatchObject({
      bytes: ["00", "10"],
      applies_per_frame: true,
      business_frame_length: 10,
      wire_frame_length: 12,
      confidence: 0.88,
    })
    expect(validateDtpProtocolDefinitions(definitions).valid).toBe(true)
  })

  test("rejects a frame envelope whose prefix and documented lengths do not agree", () => {
    const definitions = createProtocolDefinitions("D:\\workspace", [{
      protocol_id: "invalid-frame-envelope-length",
      source_section: "3.1.3 二级CAN总线接口",
      flow_direction: "input",
      base_file_name: "二级CAN遥控指令",
      generation_mode: "single_file",
      frame: {
        byte_layout: ["40", "48", "00", "10", "01", "SUM"],
        field_layout: [
          { name: "ARBITRATION", role: "arbitration", byte_offset: 0, byte_length: 1, default_value: "40" },
          { name: "CONTROL", role: "control", byte_offset: 1, byte_length: 1, default_value: "48" },
          { name: "TITLE", role: "title", byte_offset: 2, byte_length: 1, default_value: "00" },
          { name: "W0", role: "data", byte_offset: 3, byte_length: 1, default_value: "10" },
          { name: "W1", role: "data", byte_offset: 4, byte_length: 1, default_value: "01" },
          { name: "SUM", role: "checksum", byte_offset: 5, byte_length: 1 },
        ],
        checksum: { type: "sum_low8", start: "TITLE", end: "BEFORE_SUM" },
      },
      bus_context: { bus_type: "CAN", interface_level: "secondary", controller: "FPGA" },
      frame_envelope: {
        type: "fixed_prefix",
        bytes: ["00", "10"],
        applies_per_frame: true,
        business_frame_length: 10,
        wire_frame_length: 13,
      },
      fields: [],
      evidence: [],
      warnings: [],
      confidence: 1,
      understanding_source: "model",
    }])

    expect(validateDtpProtocolDefinitions(definitions)).toMatchObject({
      valid: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ message: "The frame-envelope length equation is inconsistent: 10+2!=13." }),
      ]),
    })
  })

  test("preserves station-address value cells in a secondary CAN response layout", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-secondary-can-response-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    mkdirSync(paths.inputDataRoot, { recursive: true })
    const knowledgeIndex = createCanBusProfileKnowledgeIndex(workspaceRoot, [
      "二级CAN总线由FPGA实现，每帧写入前增加0008H两个接口字节。",
    ])
    knowledgeIndex.section_protocol_models[0].section_title = "3.1.3.3 遥控指令应答格式定义"
    knowledgeIndex.section_protocol_models[0].section_path = ["3 数据及接口需求", "3.1.3 二级CAN总线接口"]
    knowledgeIndex.tables[0].caption = "表3.1.3.3-3 遥控指令应答格式定义"
    knowledgeIndex.tables[0].rows = [
      ["序号", "仲裁场、控制场", "", "数据场", "", "", "", "", "", "", ""],
      ["", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"],
      ["", "ID10～ID3", "ID2～ID0 RTR DLC", "", "", "", "", "", "", "", ""],
      ["1", "40H+站地址", "48H", "T站地址", "W0FFH", "W120H", "W2FFH", "W320H", "W4FFH", "W520H", "SUM"],
    ]

    const definitions = await buildDtpProtocolDefinitionsDocument(paths, knowledgeIndex, {
      understandSectionProtocols: async (context) => {
        const response = canProtocolModelResponse(context, {
          bus_type: "CAN",
          interface_level: "secondary",
          interface_id: "IF-CAN1-001",
          controller: "FPGA",
          frame_format: "standard",
          frame_buffer_layout: "business-payload",
        }) as any
        response.protocols[0].base_file_name = "遥控指令应答"
        response.protocols[0].frames[0].byte_layout = ["00", "48", "W0", "W1", "W2", "W3", "W4", "W5", "SUM"]
        return response
      },
    })
    const protocol = definitions.protocols[0]
    const frame = protocol.frames?.[0]

    expect(frame?.byte_layout).toEqual([
      "DYNAMIC_STATION_ADDRESS", "48", "TITLE", "W0", "W1", "W2", "W3", "W4", "W5", "SUM",
    ])
    expect(frame?.field_layout.find((field) => field.name === "TITLE")).toMatchObject({
      byte_offset: 2,
      value_rule: { operation: "variable", variable: "station_address" },
    })
    expect(frame?.field_layout.find((field) => field.name === "W0")).toMatchObject({
      byte_offset: 3,
      default_value: "FF",
    })
    expect(frame?.field_layout.filter((field) => field.name === "W0")).toHaveLength(1)

    const generated = buildGeneratedStep({
      step: {
        stepIndex: 2,
        keywordName: "发送二级CANTXT数据",
        stepDescription: "第3.5秒，通过二级CAN总线发送正确的遥控指令应答（站地址为01H）",
      },
      caseContext: { caseId: "TC-SECONDARY-RESPONSE", requirementIds: [], steps: [] },
      keywordDef: {
        keywordName: "发送二级CANTXT数据",
        txtPath: "",
        jsonPath: "",
        arguments: [{ name: "${para2}", comments: "数据文件" }],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex,
      dataFileIndex: prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT),
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions: definitions,
      dataGenerationPlan: {
        protocol_id: protocol.protocol_id,
        protocol_name: "遥控指令应答",
        flow_direction: "input",
        variant_type: "correct",
        mutations: [],
        sequence_operations: [],
        checksum_policy: "recalculate_correctly",
        argument_values: {},
        evidence_ids: [],
        confidence: 1,
        warnings: [],
        source: "heuristic-fallback",
      },
    })
    const outputFile = join(
      paths.inputDataRoot,
      INPUT_FLOW,
      "用例生成",
      "TC-SECONDARY-RESPONSE",
      generated.generated_data_files[0].requested_file_name,
    )
    expect(readFileSync(outputFile, "utf-8").trim()).toBe("00 08 41 48 01 FF 20 FF 20 FF 20 5E")
    expect(generated.data_quality?.status).toBe("pass")

    const arbitrationFault = await buildGeneratedStepWithPlanning({
      step: {
        stepIndex: 3,
        keywordName: "发送二级CANTXT数据",
        stepDescription: "第4.1秒，通过二级CAN总线发送站地址01H的10字节遥控指令应答(仲裁场错误,其余字段正确)",
      },
      caseContext: { caseId: "TC-SECONDARY-RESPONSE-FAULT", requirementIds: [], steps: [] },
      keywordDef: {
        keywordName: "发送二级CANTXT数据",
        txtPath: "",
        jsonPath: "",
        arguments: [{ name: "${para2}", comments: "数据文件" }],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex,
      dataFileIndex: prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT),
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions: definitions,
    })
    const arbitrationFaultFile = join(
      paths.inputDataRoot,
      INPUT_FLOW,
      "用例生成",
      "TC-SECONDARY-RESPONSE-FAULT",
      arbitrationFault.generated_data_files[0].requested_file_name,
    )
    expect(arbitrationFault.data_generation_plan?.variant_type).toBe("arbitration_error")
    expect(arbitrationFault.data_generation_plan?.mutations).toEqual([
      { field: "ARBITRATION", frame_index: undefined, operation: "replace_with_invalid_value", value: undefined },
    ])
    expect(arbitrationFault.generated_data_files[0].requested_file_name)
      .toBe("S03-遥控指令应答-仲裁场异常.txt")
    expect(readFileSync(arbitrationFaultFile, "utf-8").trim())
      .toBe("00 08 42 48 01 FF 20 FF 20 FF 20 5E")
    expect(arbitrationFault.data_quality?.status).toBe("pass")

    const contaminatedControlFault = buildGeneratedStep({
      step: {
        stepIndex: 5,
        keywordName: "发送二级CANTXT数据",
        stepDescription: "第6.1秒，通过二级CAN总线发送站地址01H的10字节遥控指令应答(控制场错误,其余字段正确)",
      },
      caseContext: { caseId: "TC-SECONDARY-RESPONSE-CONTAMINATED", requirementIds: [], steps: [] },
      keywordDef: {
        keywordName: "发送二级CANTXT数据",
        txtPath: "",
        jsonPath: "",
        arguments: [{ name: "${para2}", comments: "数据文件" }],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex,
      dataFileIndex: prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT),
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions: definitions,
      dataGenerationPlan: {
        protocol_id: protocol.protocol_id,
        protocol_name: "遥控指令应答",
        flow_direction: "input",
        variant_type: "control_error",
        mutations: [
          { field: "STATION_ADDRESS", operation: "replace_with_invalid_value" },
          { field: "CONTROL", operation: "replace_with_invalid_value" },
        ],
        sequence_operations: [],
        checksum_policy: "recalculate_correctly",
        argument_values: {},
        evidence_ids: [],
        confidence: 1,
        warnings: [],
        source: "heuristic-fallback",
      },
    })
    expect(contaminatedControlFault.data_quality?.status).toBe("failed")
    expect(contaminatedControlFault.data_quality?.issues.some((issue) => issue.type === "unexpected_field_mutation"))
      .toBe(true)
  })

  test("keeps W0 station address and W1 command identifier in a two-frame secondary CAN command", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-secondary-can-command-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    const knowledgeIndex = createCanBusProfileKnowledgeIndex(workspaceRoot, [])
    knowledgeIndex.section_protocol_models[0].section_title = "3.1.3.2 15字节遥控指令格式定义"
    knowledgeIndex.section_protocol_models[0].section_path = ["3 数据及接口需求", "3.1.3 二级CAN总线接口"]
    knowledgeIndex.tables[0].caption = "表3.1.3.2-2 15字节遥控指令格式定义"
    knowledgeIndex.tables[0].rows = [
      ["序号", "仲裁场、控制场", "", "数据场", "", "", "", "", "", "", ""],
      ["", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"],
      ["", "ID10～ID3", "ID2～ID0 RTR DLC", "", "", "", "", "", "", "", ""],
      ["1", "40H+站地址", "28H", "I00H", "L0BH", "T20H", "W0站地址", "W1指令标识", "W2", "W3", "W4"],
      ["2", "40H+站地址", "28H", "I01H", "W5", "W6", "W7", "W8", "W9", "W10", "SUM"],
    ]

    const definitions = await buildDtpProtocolDefinitionsDocument(paths, knowledgeIndex, {
      understandSectionProtocols: async (context) => canProtocolModelResponse(context, {
        bus_type: "CAN",
        interface_level: "secondary",
        interface_id: "IF-CAN1-001",
        controller: "FPGA",
        frame_format: "standard",
        frame_buffer_layout: "business-payload",
      }),
    })
    const protocol = definitions.protocols[0]
    const frames = protocol.frames ?? []

    expect(frames.map((frame) => frame.byte_layout)).toEqual([
      ["DYNAMIC_STATION_ADDRESS", "28", "00", "0B", "20", "W0", "W1", "W2", "W3", "W4"],
      ["DYNAMIC_STATION_ADDRESS", "28", "01", "W5", "W6", "W7", "W8", "W9", "W10", "SUM"],
    ])
    expect(frames[0].field_layout.find((field) => field.name === "W0")).toMatchObject({
      byte_offset: 5,
      value_rule: { operation: "variable", variable: "station_address" },
    })
    expect(frames[0].field_layout.find((field) => field.name === "W1")).toMatchObject({
      byte_offset: 6,
      value_rule: { operation: "variable", variable: "command_identifier" },
    })
    expect(frames[1].field_layout.find((field) => field.name === "FRAME_SEQUENCE")).toMatchObject({
      byte_offset: 2,
      default_value: "01",
    })
    expect(protocol.variables?.map((variable) => variable.name)).toEqual(expect.arrayContaining([
      "station_address",
      "command_identifier",
    ]))
  })

  test("recognizes an unlabeled sequential CAN byte column as FRAME_SEQUENCE", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-implicit-frame-sequence-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    const knowledgeIndex = createCanBusProfileKnowledgeIndex(workspaceRoot, [])
    knowledgeIndex.section_protocol_models[0].section_title = "3.1.1.10 星时广播"
    knowledgeIndex.section_protocol_models[0].section_path = ["3 数据及接口需求", "3.1.1 一级CAN总线接口"]
    knowledgeIndex.tables[0].caption = "表3.1.1.10-1 星时广播数据格式"
    knowledgeIndex.tables[0].rows = [
      ["帧序号", "仲裁场、控制场", "", "数据场", "", "", "", "", "", ""],
      ["", "1", "2", "3", "4", "5", "6", "7", "8", "9"],
      ["", "ID10～ID3", "ID2～ID0 RTR DLC", "", "", "", "", "", "", ""],
      ["1", "4FH", "28H", "00H", "L08H", "T40H", "W0", "W1", "W2", "W3"],
      ["2", "4FH", "25H", "01H", "W4", "W5", "W6", "W7", "SUM", "-"],
    ]
    knowledgeIndex.section_protocol_models[0].protocol_relations = [{
      frame_table_id: "doc-can-table-1",
      generation_mode: "frame_file",
      preferred_name: "星时广播",
      flow_direction: "input",
      should_generate_frame_table_file: true,
      checksum_rule: "SUM = low8(byte-sum(TITLE + W0 + ... + W7))",
      confidence: 0.9,
      reasoning: [],
      field_value_plan: [],
    }]

    const definitions = await buildDtpProtocolDefinitionsDocument(paths, knowledgeIndex)
    const frames = definitions.protocols[0].frames ?? []
    expect(frames[0].field_layout.find((field) => field.name === "FRAME_SEQUENCE")).toMatchObject({
      byte_offset: 2,
      default_value: "00",
    })
    expect(frames[1].field_layout.find((field) => field.name === "FRAME_SEQUENCE")).toMatchObject({
      byte_offset: 2,
      default_value: "01",
    })
  })

  test("repairs an implicit CAN frame sequence when loading portable protocol definitions", () => {
    const workspaceRoot = join(tmpdir(), `dtp-portable-frame-sequence-${Date.now()}`)
    const definitions = createProtocolDefinitions(workspaceRoot, [{
      protocol_id: "portable-multi-frame",
      source_section: "multi-frame CAN",
      flow_direction: "input",
      base_file_name: "portable multi-frame",
      generation_mode: "single_file",
      frames: ["00", "01"].map((sequence, index) => ({
        frame_id: `frame-${index + 1}`,
        sequence: index + 1,
        source_table_id: "portable-table",
        byte_layout: ["4F", "28", sequence, "10"],
        field_layout: [
          { name: "ARBITRATION", role: "arbitration", byte_offset: 0, byte_length: 1, default_value: "4F" },
          { name: "CONTROL", role: "control", byte_offset: 1, byte_length: 1, default_value: "28" },
          { name: sequence, role: "fixed", byte_offset: 2, byte_length: 1, default_value: sequence },
          { name: `W${index}`, role: "data", byte_offset: 3, byte_length: 1, default_value: "10" },
        ],
      })),
      bus_context: { bus_type: "CAN", interface_level: "primary" },
      fields: [], evidence: [], warnings: [], confidence: 1, understanding_source: "heuristic-fallback",
    }])

    const migrated = migrateDtpProtocolDefinitionsDocument(definitions)
    expect(migrated.protocols[0].frames?.map((frame) => frame.field_layout.find((field) => (
      field.name === "FRAME_SEQUENCE"
    ))?.default_value)).toEqual(["00", "01"])
  })

  test("supplements primary CAN remote-command tables omitted by model understanding", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-primary-can-command-supplement-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    const knowledgeIndex = createCanBusProfileKnowledgeIndex(workspaceRoot, [])
    knowledgeIndex.snippets.find((snippet) => snippet.id === "doc-can-snippet-100")!.text =
      "输入流：遥控指令，包括10字节遥控指令和15字节遥控指令。"
    knowledgeIndex.section_protocol_models[0].section_id = "3.1.1.5"
    knowledgeIndex.section_protocol_models[0].section_title =
      "3.1.1.5 发向相机管理控制器的遥控指令"
    knowledgeIndex.section_protocol_models[0].section_path = ["3 数据及接口需求", "3.1.1 一级CAN总线接口"]
    knowledgeIndex.tables.push(
      {
        ...knowledgeIndex.tables[0],
        id: "doc-can-table-13",
        caption: "表3.1.1.5-1 发向相机管理控制器长度10字节的遥控指令",
        rows: [
          ["帧序号", "仲裁场、控制场", "", "数据场", "", "", "", "", "", "", ""],
          ["", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"],
          ["", "ID10～ID3", "ID2～ID0 RTR DLC", "", "", "", "", "", "", "", ""],
          ["1", "4DH", "28H", "I00H", "L0AH", "T40H", "W0", "W1", "W2", "W3", "W4"],
          ["2", "4DH", "27H", "I01H", "W5", "W6", "W7", "W8", "W9", "SUM", "-"],
        ],
      },
      {
        ...knowledgeIndex.tables[0],
        id: "doc-can-table-14",
        caption: "表3.1.1.5-2 发向相机管理控制器长度15字节的遥控指令",
        rows: [
          ["帧序号", "仲裁场、控制场", "", "数据场", "", "", "", "", "", "", ""],
          ["", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"],
          ["", "ID10～ID3", "ID2～ID0 RTR DLC", "", "", "", "", "", "", "", ""],
          ["1", "4DH", "28H", "I00H", "L0FH", "T40H", "W0", "W1", "W2", "W3", "W4"],
          ["2", "4DH", "28H", "I01H", "W5", "W6", "W7", "W8", "W9", "W10", "W11"],
          ["3", "4DH", "25H", "I02H", "W12", "W13", "W14", "SUM", "-", "-", "-"],
        ],
      },
    )
    knowledgeIndex.section_protocol_models[0].table_ids.push("doc-can-table-13", "doc-can-table-14")
    knowledgeIndex.section_protocol_models[0].primary_table_ids.push("doc-can-table-13", "doc-can-table-14")
    knowledgeIndex.section_protocol_models[0].protocol_relations.push(
      {
        frame_table_id: "doc-can-table-13",
        generation_mode: "frame_file",
        preferred_name: "遥控指令",
        flow_direction: "input",
        should_generate_frame_table_file: true,
        confidence: 0.9,
        reasoning: [],
      },
      {
        frame_table_id: "doc-can-table-14",
        generation_mode: "frame_file",
        preferred_name: "遥控指令",
        flow_direction: "input",
        should_generate_frame_table_file: true,
        confidence: 0.9,
        reasoning: [],
      },
    )

    const definitions = await buildDtpProtocolDefinitionsDocument(paths, knowledgeIndex, {
      understandSectionProtocols: async (context) => canProtocolModelResponse(context, {
        bus_type: "CAN",
        interface_level: "primary",
        interface_id: "IF-CAN0-001",
      }),
    })
    const remoteCommands = definitions.protocols.filter((protocol) => /字节遥控指令/.test(protocol.base_file_name))

    expect(remoteCommands.map((protocol) => protocol.base_file_name).sort()).toEqual([
      "10字节遥控指令",
      "15字节遥控指令",
    ])
    expect(remoteCommands.map((protocol) => protocol.bus_context?.interface_level)).toEqual(["primary", "primary"])
    expect(remoteCommands.map((protocol) => protocol.frames?.length).sort()).toEqual([2, 3])
    expect(definitions.warnings).toContain(
      "Deterministic table extraction supplemented 2 protocol(s) omitted by model understanding.",
    )
  })

  test("rejects a secondary CAN model name for a primary CAN injection step", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-primary-can-model-scope-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    mkdirSync(paths.inputDataRoot, { recursive: true })
    const secondaryProtocol = createProtocolDefinitions(workspaceRoot, [{
      protocol_id: "secondary-can-command",
      source_section: "3.1.3 二级CAN总线接口",
      flow_direction: "output",
      base_file_name: "二级CAN遥控指令",
      generation_mode: "single_file",
      frame: {
        source_table_id: "secondary-command-table",
        byte_layout: ["40", "28", "00", "0A", "20", "W0", "W1", "W2", "W3", "SUM"],
        checksum: { type: "sum_low8", start: "TITLE", end: "BEFORE_SUM" },
      },
      bus_context: { bus_type: "CAN", interface_level: "secondary", interface_id: "IF-CAN1-001" },
      fields: [], evidence: [], warnings: [], confidence: 1, understanding_source: "model",
    }])

    const generated = await buildGeneratedStepWithPlanning({
      step: {
        stepIndex: 1,
        keywordName: "发送CANATXT数据",
        stepDescription: "第3.0秒,通过CANA总线发送遥控指令",
      },
      caseContext: { caseId: "TC-PRIMARY-SCOPE", requirementIds: [], steps: [] },
      keywordDef: {
        keywordName: "发送CANATXT数据",
        txtPath: "",
        jsonPath: "",
        arguments: [{ name: "${para2}", comments: "数据文件" }],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot),
      dataFileIndex: prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT),
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions: secondaryProtocol,
    }, {
      planCaseStepData: async () => ({
        protocol_id: "secondary-can-command",
        protocol_name: "二级CAN遥控指令",
        flow_direction: "input",
        bus: "CAN",
        variant_type: "unknown",
        mutations: [],
        sequence_operations: [],
        checksum_policy: "recalculate_correctly",
        argument_values: {}, evidence_ids: [], confidence: 0.9, warnings: [], source: "model",
      }),
    })

    expect(generated.data_generation_plan?.protocol_id).toBeUndefined()
    expect(generated.data_generation_plan?.interface_level).toBe("primary")
    expect(generated.generated_data_files[0].requested_file_name).toBe("S01-遥控指令-待确认.txt")
    expect(generated.generated_data_files[0].requested_file_name.match(/待确认/g)).toHaveLength(1)
    expect(generated.data_quality?.issues.map((issue) => issue.type)).toEqual(expect.arrayContaining([
      "protocol_name_interface_conflict",
      "protocol_candidate_out_of_scope",
      "case_data_fallback",
    ]))
  })

  test("defaults a generic primary CAN remote command to the first document-order length", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-primary-command-default-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    mkdirSync(paths.inputDataRoot, { recursive: true })
    const protocolDefinitions = createProtocolDefinitions(workspaceRoot, [
      {
        protocol_id: "primary-command-10",
        source_section: "3.1.1.5 一级CAN遥控指令",
        flow_direction: "input",
        base_file_name: "10字节遥控指令",
        generation_mode: "single_file",
        frame: {
          source_table_id: "primary-command-table-10",
          byte_layout: ["4D", "28", "00", "0A", "40", "W0", "W1", "W2", "W3", "W4"],
          byte_layouts: [
            ["4D", "28", "00", "0A", "40", "W0", "W1", "W2", "W3", "W4"],
            ["4D", "27", "01", "W5", "W6", "W7", "W8", "W9", "SUM"],
          ],
          checksum: { type: "sum_low8", start: "TITLE", end: "BEFORE_SUM" },
        },
        bus_context: { bus_type: "CAN", interface_level: "primary", interface_id: "IF-CAN0-001" },
        fields: [], evidence: [], warnings: [], confidence: 1, understanding_source: "heuristic-fallback",
      },
      {
        protocol_id: "primary-command-15",
        source_section: "3.1.1.5 一级CAN遥控指令",
        flow_direction: "input",
        base_file_name: "15字节遥控指令",
        generation_mode: "single_file",
        frame: {
          source_table_id: "primary-command-table-15",
          byte_layout: ["4D", "28", "00", "0F", "40", "W0", "W1", "W2", "W3", "W4"],
          byte_layouts: [
            ["4D", "28", "00", "0F", "40", "W0", "W1", "W2", "W3", "W4"],
            ["4D", "28", "01", "W5", "W6", "W7", "W8", "W9", "W10", "W11"],
            ["4D", "25", "02", "W12", "W13", "W14", "SUM"],
          ],
          checksum: { type: "sum_low8", start: "TITLE", end: "BEFORE_SUM" },
        },
        bus_context: { bus_type: "CAN", interface_level: "primary", interface_id: "IF-CAN0-001" },
        fields: [], evidence: [], warnings: [], confidence: 1, understanding_source: "heuristic-fallback",
      },
    ])
    let modelCallCount = 0
    const baseInput = {
      caseContext: { caseId: "TC-PRIMARY-DEFAULT", requirementIds: [], steps: [] },
      keywordDef: {
        keywordName: "发送CANATXT数据",
        txtPath: "",
        jsonPath: "",
        arguments: [{ name: "${para2}", comments: "数据文件" }],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot),
      dataFileIndex: prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT),
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions,
    }
    const generated = await buildGeneratedStepWithPlanning({
      ...baseInput,
      step: {
        stepIndex: 1,
        keywordName: "发送CANATXT数据",
        stepDescription: "第3.0秒,通过CANA总线发送正确的遥控指令",
      },
    }, {
      planCaseStepData: async () => {
        modelCallCount += 1
        throw new Error("model should not be called")
      },
    })

    expect(modelCallCount).toBe(0)
    expect(generated.data_generation_plan).toMatchObject({
      protocol_id: "primary-command-10",
      protocol_name: "10字节遥控指令",
      selection_source: "document_order_default",
      confidence: 0.65,
    })
    expect(generated.generated_data_files[0].requested_file_name).toBe("S01-10字节遥控指令-正常.txt")
    expect(generated.data_quality?.status).toBe("warning")
    expect(generated.data_quality?.issues.some((issue) => issue.type === "protocol_default_selected")).toBe(true)

    const explicitLength = await buildGeneratedStepWithPlanning({
      ...baseInput,
      caseContext: { caseId: "TC-PRIMARY-EXPLICIT", requirementIds: [], steps: [] },
      step: {
        stepIndex: 1,
        keywordName: "发送CANATXT数据",
        stepDescription: "第3.0秒,通过CANA总线发送正确的15字节遥控指令",
      },
    })
    expect(explicitLength.data_generation_plan?.protocol_id).toBe("primary-command-15")
    expect(explicitLength.data_generation_plan?.selection_source).not.toBe("document_order_default")

    const commandSpecific = await buildGeneratedStepWithPlanning({
      ...baseInput,
      dataFileIndex: prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT),
      caseContext: { caseId: "TC-PRIMARY-COMMAND-CODE", requirementIds: [], steps: [] },
      step: {
        stepIndex: 1,
        keywordName: "发送CANATXT数据",
        stepDescription: "第3.0秒,通过CANA总线发送遥控指令TCY215",
      },
    })
    expect(commandSpecific.data_generation_plan?.selection_source).not.toBe("document_order_default")
    expect(commandSpecific.data_generation_plan?.protocol_id).toBeUndefined()

    const defaultCommand = await buildGeneratedStepWithPlanning({
      ...baseInput,
      commandDictionaryIndex: {
        schema_version: "1.0.0",
        source_documents: ["appendix-k.docx"],
        entries: [{
          id: "appendix-k:TCY101",
          command_code: "TCY101",
          command_name: "默认测试指令",
          bus_type: "CAN",
          interface_level: "primary",
          payload_length_bytes: 10,
          field_overrides: Array.from({ length: 10 }, (_, index) => ({
            field_name: `W${index}`,
            value: index.toString(16).toUpperCase().padStart(2, "0"),
            value_source: "dictionary-row" as const,
            source_table_id: "appendix-k",
            confidence: 0.95,
            reasoning: ["test fixture"],
          })),
          source_document_id: "appendix-k.docx",
          source_table_id: "appendix-k",
          source_table_caption: "附录K总线指令",
          warnings: [],
        }],
        warnings: [],
        updated_at: new Date().toISOString(),
      },
      caseContext: { caseId: "TC-PRIMARY-DEFAULT-COMMAND", requirementIds: [], steps: [] },
      step: {
        stepIndex: 1,
        keywordName: "发送CANATXT数据",
        stepDescription: "第3.0秒,通过CANA总线以1S为周期发送10字节遥控指令",
      },
    })
    expect(defaultCommand.data_generation_plan?.command).toMatchObject({
      code: "TCY101",
      name: "默认测试指令",
      selection_source: "document_order_default",
    })
    expect(defaultCommand.generated_data_files[0].requested_file_name)
      .toBe("S01-10字节遥控指令-正常.txt")
    expect(defaultCommand.generated_data_files[0].field_value_plan?.some((field) => field.value_source === "fallback-zero"))
      .toBe(false)
    expect(defaultCommand.data_quality?.issues.some((issue) => issue.type === "command_default_selected"))
      .toBe(true)

    const incompleteDefaultCommand = await buildGeneratedStepWithPlanning({
      ...baseInput,
      commandDictionaryIndex: {
        schema_version: "1.0.0",
        source_documents: ["appendix-k.docx"],
        entries: [{
          id: "appendix-k:INCOMPLETE",
          command_code: "TCY000",
          command_name: "不完整指令",
          bus_type: "CAN",
          interface_level: "primary",
          payload_length_bytes: 10,
          field_overrides: [{
            field_name: "W0",
            value: "00",
            value_source: "dictionary-row",
            source_table_id: "appendix-k",
            confidence: 0.95,
            reasoning: ["test fixture"],
          }],
          source_document_id: "appendix-k.docx",
          source_table_id: "appendix-k",
          warnings: [],
        }],
        warnings: [],
        updated_at: new Date().toISOString(),
      },
      caseContext: { caseId: "TC-PRIMARY-INCOMPLETE-COMMAND", requirementIds: [], steps: [] },
      step: {
        stepIndex: 1,
        keywordName: "发送CANATXT数据",
        stepDescription: "第3.0秒,通过CANA总线以1S为周期发送10字节遥控指令",
      },
    })
    expect(incompleteDefaultCommand.data_generation_plan?.command).toBeUndefined()
    expect(incompleteDefaultCommand.generated_data_files[0].requested_file_name).toBe("S01-10字节遥控指令-正常.txt")
  })

  test("preserves an existing executable step file when regeneration falls back", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-case-publication-guard-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    const dataFileIndex = prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT)
    const fileName = "S01-遥控指令-正常.txt"
    const absolutePath = join(paths.inputDataRoot, INPUT_FLOW, "用例生成", "TC-PUBLISH-GUARD", fileName)
    const runtimePath = `${INPUT_DATA}\\${INPUT_FLOW}\\用例生成\\TC-PUBLISH-GUARD\\${fileName}`
    mkdirSync(dirname(absolutePath), { recursive: true })
    writeFileSync(absolutePath, "4D 28 00 0A 40 01 02 03 04 4A\n", "utf-8")
    dataFileIndex.entries.push({
      id: "existing-step-output",
      protocol_name: "遥控指令",
      requested_file_name: fileName,
      file_path: runtimePath,
      absolute_file_path: absolutePath,
      source: "dynamic-generated",
      source_documents: [],
      generation_basis: ["previous-deterministic-generation"],
      flow_direction: "input",
      confidence: 0.9,
      state: "validated",
      warnings: [],
    })

    const generated = await buildGeneratedStepWithPlanning({
      step: {
        stepIndex: 1,
        keywordName: "发送CANATXT数据",
        stepDescription: "第3.0秒,通过CANA总线发送正确的遥控指令",
      },
      caseContext: { caseId: "TC-PUBLISH-GUARD", requirementIds: [], steps: [] },
      keywordDef: {
        keywordName: "发送CANATXT数据",
        txtPath: "",
        jsonPath: "",
        arguments: [{ name: "${para2}", comments: "数据文件" }],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot),
      dataFileIndex,
      docsContext: EMPTY_DOCS_CONTEXT,
    })

    expect(generated.generated_data_files[0].requested_file_name).toBe(fileName)
    expect(readFileSync(absolutePath, "utf-8").trim()).toBe("4D 28 00 0A 40 01 02 03 04 4A")
    expect(generated.data_quality?.status).toBe("warning")
    expect(generated.data_quality?.issues.some((issue) => issue.type === "publication_preserved")).toBe(true)
  })

  test("keeps an explicit section BasicCAN mode over a document PeliCAN profile", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-local-basiccan-profile-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    const knowledgeIndex = createCanBusProfileKnowledgeIndex(workspaceRoot, [
      "\u603b\u7ebf\u63a7\u5236\u5668\u91c7\u7528 SJA1000T\uff0c\u6807\u51c6 PELICAN \u6a21\u5f0f\u3002",
    ])
    const definitions = await buildDtpProtocolDefinitionsDocument(paths, knowledgeIndex, {
      understandSectionProtocols: async (context) => canProtocolModelResponse(context, {
        bus_type: "CAN",
        controller: "SJA1000T",
        controller_family: "SJA1000",
        mode: "BasicCAN",
        frame_format: "standard",
        frame_buffer_layout: "business-payload",
      }),
    })

    expect(definitions.protocols[0].bus_context?.mode).toBe("BasicCAN")
    expect(definitions.protocols[0].bus_context?.frame_information).toBeUndefined()
    expect(definitions.protocols[0].bus_context?.warnings).toContain(
      "Document-level CAN bus profiles conflict with the explicit section bus context; section values were kept.",
    )
  })

  test("does not guess when document-level CAN profiles are ambiguous", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-ambiguous-can-profile-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    const knowledgeIndex = createCanBusProfileKnowledgeIndex(workspaceRoot, [
      "\u63a5\u53e3A\u91c7\u7528 SJA1000T PELICAN \u6a21\u5f0f\u3002",
      "\u63a5\u53e3B\u91c7\u7528 SJA1000T BasicCAN \u6a21\u5f0f\u3002",
    ])
    const definitions = await buildDtpProtocolDefinitionsDocument(paths, knowledgeIndex, {
      understandSectionProtocols: async (context) => canProtocolModelResponse(context, {
        bus_type: "CAN",
        controller: "unknown",
        controller_family: "unknown",
        mode: "unknown",
        frame_format: "standard",
        frame_buffer_layout: "business-payload",
      }),
    })

    expect(definitions.protocols[0].bus_context).toMatchObject({
      controller: "unknown",
      controller_family: "unknown",
      mode: "unknown",
    })
    expect(definitions.protocols[0].bus_context?.warnings?.[0]).toContain(
      "Multiple document-level CAN bus profiles match this section",
    )
  })

  test("passes structure-fidelity table html without duplicate cells or rows", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-table-fidelity-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    let capturedContext: any
    const tableHtml = "<table><tr><td>\u5e8f\u53f7</td><td>W0</td></tr><tr><td></td><td>10H</td></tr></table>"
    const cells = [
      { row: 0, col: 0, text: "\u5e8f\u53f7" },
      { row: 0, col: 1, text: "W0" },
      { row: 1, col: 0, text: "" },
      { row: 1, col: 1, text: "10H" },
    ]

    const knowledgeIndex = {
      schema_version: "1.0.0",
      extractor_version: EXTRACTOR_VERSION,
      project_root: workspaceRoot,
      source_documents: [],
      topics: [],
      snippets: [
        {
          id: "doc-fidelity-snippet-1",
          source_document_id: "doc-fidelity",
          topic: "hardware_interface",
          text: "1.1 \u8f93\u5165\u6d41\uff1a\u95f4\u63a5\u6307\u4ee4",
          confidence: 0.9,
        },
      ],
      tables: [
        {
          id: "doc-fidelity-table-1",
          source_document_id: "doc-fidelity",
          caption: "\u8868 1 \u95f4\u63a5\u6307\u4ee4\u683c\u5f0f",
          aliases: [],
          topic: "packet_structure",
          rows: [
            ["\u5e8f\u53f7", "W0"],
            ["", "10H"],
          ],
          table_html: tableHtml,
          cells,
          confidence: 0.9,
          warnings: [],
        },
      ],
      section_protocol_models: [
        {
          id: "section-fidelity",
          source_document_id: "doc-fidelity",
          section_id: "1.1",
          section_title: "1.1 \u95f4\u63a5\u6307\u4ee4",
          section_snippet_ids: ["doc-fidelity-snippet-1"],
          input_flow_snippet_ids: ["doc-fidelity-snippet-1"],
          output_flow_snippet_ids: [],
          table_ids: ["doc-fidelity-table-1"],
          primary_table_ids: ["doc-fidelity-table-1"],
          support_table_ids: [],
          protocol_relations: [],
          protocols: [],
          confidence: 0.9,
          warnings: [],
        },
      ],
      packet_model_candidates: [],
      references: [],
      warnings: [],
      updated_at: new Date().toISOString(),
    } as any

    await buildDtpProtocolDefinitionsDocument(paths, knowledgeIndex, {
      understandSectionProtocols: async (context) => {
        capturedContext = context
        return { protocols: [], non_generated_tables: [], warnings: [] }
      },
    })

    expect(capturedContext.tables[0].table_html).toBe(tableHtml)
    expect(capturedContext.tables[0].cells).toBeUndefined()
    expect(capturedContext.tables[0].rows).toEqual([])
    expect(capturedContext.tables[0].payload_mode).toBe("complete")
    expect(capturedContext.tables[0].selected_row_indexes).toEqual([0, 1])
    expect(capturedContext.model_input_metrics).toMatchObject({
      candidate_table_count: 1,
      selected_table_count: 1,
      selected_row_count: 2,
      applied_timeout_ms: 150000,
    })
  })

  test("ignores numeric table index rows when building heuristic frame layouts", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-frame-layout-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    const definitions = await buildDtpProtocolDefinitionsDocument(
      paths,
      {
        schema_version: "1.0.0",
        extractor_version: EXTRACTOR_VERSION,
        project_root: workspaceRoot,
        source_documents: [],
        topics: [],
        snippets: [],
        tables: [
          {
            id: "table-b1",
            source_document_id: "doc-5",
            caption: `\u8868 B-1 ${FAST_POLL}`,
            aliases: [],
            topic: "packet_structure",
            rows: [
              ["\u5e27\u5e8f\u53f7", "\u4ef2\u88c1\u573a\u3001\u63a7\u5236\u573a", "\u6709\u6548\u6570\u636e\u573a", "\u8bf4\u660e"],
              ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"],
              ["ID10\uff5eID3", "ID2\uff5eID0 \uff0cRTR \uff0cDLC"],
              ["1.", "86H", "04H", "T00H", "10H", "01H", "SUM"],
            ],
            confidence: 0.9,
            warnings: [],
          },
        ],
        section_protocol_models: [
          {
            id: "section-frame-layout",
            source_document_id: "doc-5",
            section_id: "3.1.1.1",
            section_title: "3.1.1.1 \u901f\u53d8\u9065\u6d4b\u8f6e\u8be2\u53ca\u5e94\u7b54\u683c\u5f0f\u8bf4\u660e",
            section_snippet_ids: [],
            input_flow_snippet_ids: [],
            output_flow_snippet_ids: [],
            table_ids: ["table-b1"],
            primary_table_ids: ["table-b1"],
            support_table_ids: [],
            protocol_relations: [
              {
                frame_table_id: "table-b1",
                generation_mode: "frame_file",
                preferred_name: FAST_POLL,
                flow_direction: "input",
                source_section: "3.1.1.1",
                source_flow_heading: INPUT_FLOW,
                should_generate_frame_table_file: true,
                checksum_rule: "SUM = low8(byte-sum(TITLE + W0 + W1 + ... + W(n-1)))",
                confidence: 0.9,
                reasoning: ["test fixture"],
              },
            ],
            protocols: [],
            confidence: 0.9,
            warnings: [],
          },
        ],
        packet_model_candidates: [],
        references: [],
        warnings: [],
        updated_at: new Date().toISOString(),
      } as any,
    )

    expect(definitions.protocols[0].frames?.[0].byte_layout).toEqual(["86", "04", "00", "10", "01", "SUM"])
    expect(definitions.schema_version).toBe("4.0.0")
    expect(definitions.protocols[0].frame).toBeUndefined()
    expect(definitions.protocols[0].frames?.[0].field_layout.map((field) => field.name)).toEqual([
      "ARBITRATION",
      "CONTROL",
      "TITLE",
      "W0",
      "W1",
      "SUM",
      "RTR",
      "DLC",
    ])
    const rtr = definitions.protocols[0].frames?.[0].field_layout.find((field) => field.name === "RTR")
    const dlc = definitions.protocols[0].frames?.[0].field_layout.find((field) => field.name === "DLC")
    expect({ byte: rtr?.byte_offset, bit: rtr?.bit_offset, length: rtr?.bit_length }).toEqual({
      byte: 1,
      bit: 4,
      length: 1,
    })
    expect({ byte: dlc?.byte_offset, bit: dlc?.bit_offset, length: dlc?.bit_length }).toEqual({
      byte: 1,
      bit: 0,
      length: 4,
    })
  })

  test("keeps table TITLE and W-field positions when the model shifts its field_layout", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-table-layout-authority-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    const knowledgeIndex = createEmptyKnowledgeIndex(workspaceRoot)
    knowledgeIndex.tables = [{
      id: "table-title-authority",
      source_document_id: "doc-title-authority",
      caption: "表 B-1 遥测帧1轮询控制序列",
      aliases: [],
      topic: "packet_structure",
      rows: [
        ["帧序号", "仲裁场", "控制场", "有效数据场", "", "", ""],
        ["", "ID10～ID3", "ID2～ID0，RTR，DLC", "", "", "", ""],
        ["1", "8DH", "04H", "T\n00H", "10H", "01H", "SUM"],
      ],
      table_html: "<table><tr><td>1</td><td>8DH</td><td>04H</td><td><p>T</p><p>00H</p></td><td>10H</td><td>01H</td><td>SUM</td></tr></table>",
      confidence: 1,
      warnings: [],
    }]
    knowledgeIndex.section_protocol_models = [{
      id: "section-title-authority",
      source_document_id: "doc-title-authority",
      section_id: "3.1.1.1",
      section_title: "3.1.1.1 遥测帧1轮询控制序列",
      section_snippet_ids: [],
      input_flow_snippet_ids: [],
      output_flow_snippet_ids: [],
      table_ids: ["table-title-authority"],
      primary_table_ids: ["table-title-authority"],
      support_table_ids: [],
      protocol_relations: [{
        frame_table_id: "table-title-authority",
        generation_mode: "frame_file",
        preferred_name: "遥测帧1轮询控制序列",
        flow_direction: "input",
        source_section: "3.1.1.1",
        source_flow_heading: INPUT_FLOW,
        should_generate_frame_table_file: true,
        checksum_rule: "SUM = low8(byte-sum(TITLE + W0 + W1))",
        confidence: 1,
        reasoning: ["test fixture"],
      }],
      protocols: [],
      confidence: 1,
      warnings: [],
    }]

    const definitions = await buildDtpProtocolDefinitionsDocument(paths, knowledgeIndex, {
      understandSectionProtocols: async () => ({
        protocols: [{
          protocol_id: "frame1-poll-control",
          source_section: "3.1.1.1",
          flow_direction: "input",
          base_file_name: "遥测帧1轮询控制序列",
          generation_mode: "single_file",
          frames: [{
            frame_id: "frame-1",
            sequence: 1,
            source_table_id: "table-title-authority",
            byte_layout: ["8D", "04", "00", "10", "01", "SUM"],
            field_layout: [
              { name: "ARBITRATION", role: "arbitration", byte_offset: 0, byte_length: 1 },
              { name: "CONTROL", role: "control", byte_offset: 1, byte_length: 1 },
              { name: "W0", role: "data", byte_offset: 2, byte_length: 1, default_value: "00" },
              { name: "W1", role: "data", byte_offset: 3, byte_length: 1, default_value: "10" },
              { name: "W2", role: "data", byte_offset: 4, byte_length: 1, default_value: "01" },
              { name: "SUM", role: "checksum", byte_offset: 5, byte_length: 1 },
            ],
            checksum: { type: "sum_low8", start: "TITLE", end: "BEFORE_SUM" },
          }],
          fields: [],
          evidence: ["model fixture"],
          warnings: [],
          confidence: 0.9,
        }],
        non_generated_tables: [],
        warnings: [],
      }),
    })

    const frame = definitions.protocols[0].frames?.[0]
    expect(frame?.byte_layout).toEqual(["8D", "04", "00", "10", "01", "SUM"])
    expect(frame?.field_layout).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "TITLE", role: "title", byte_offset: 2, default_value: "00" }),
      expect.objectContaining({ name: "W0", role: "data", byte_offset: 3, default_value: "10" }),
      expect.objectContaining({ name: "W1", role: "data", byte_offset: 4, default_value: "01" }),
    ]))
    expect(definitions.protocols[0].warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("model field W0@2 conflicts with table layout @3"),
    ]))
    expect(validateDtpProtocolDefinitions(definitions).valid).toBe(true)
  })

  test("rejects canonical layouts where TITLE and W0 share a byte", () => {
    const definitions = createProtocolDefinitions("D:\\workspace", [{
      protocol_id: "invalid-title-w0-overlap",
      source_section: "3 数据及接口需求",
      flow_direction: "input",
      base_file_name: "invalid",
      generation_mode: "single_file",
      frames: [{
        frame_id: "frame-1",
        sequence: 1,
        source_table_id: "table-invalid",
        byte_layout: ["8D", "04", "00", "10", "01", "SUM"],
        field_layout: [
          { name: "TITLE", role: "title", byte_offset: 2, byte_length: 1 },
          { name: "W0", role: "data", byte_offset: 2, byte_length: 1 },
          { name: "W1", role: "data", byte_offset: 3, byte_length: 1 },
          { name: "SUM", role: "checksum", byte_offset: 5, byte_length: 1 },
        ],
        checksum: { type: "sum_low8", start: "TITLE", end: "BEFORE_SUM" },
      }],
      fields: [
        { name: "W0", type: "fixed", value: "01", source: "table", confidence: 1, warnings: [] },
        { name: "W1", type: "fixed", value: "02", source: "table", confidence: 1, warnings: [] },
      ],
      evidence: [],
      warnings: [],
      confidence: 1,
      understanding_source: "model",
    }])

    const validation = validateDtpProtocolDefinitions(definitions)
    expect(validation.valid).toBe(false)
    expect(validation.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "error", message: "TITLE and W0 resolve to the same byte offset." }),
    ]))
  })

  test("writes multi-frame protocol table rows into one generated data file", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-multi-frame-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    const knowledgeIndex = {
      schema_version: "1.0.0",
      extractor_version: EXTRACTOR_VERSION,
      project_root: workspaceRoot,
      source_documents: [],
      topics: [],
      snippets: [],
      tables: [
        {
          id: "doc-multi-table-1",
          source_document_id: "doc-multi",
          caption: "\u8868 3.1.1-5 \u7f13\u53d8\u9065\u6d4b\u6570\u636e\u4f20\u9001\u683c\u5f0f",
          aliases: [],
          topic: "packet_structure",
          rows: [
            ["\u5e27\u5e8f\u53f7", "\u4ef2\u88c1\u573a", "\u63a7\u5236\u573a", "TITLE", "LENGTH", "TYPE", "W0", "W1", "SUM"],
            ["1", "2", "3", "4", "5", "6", "7", "8", "9"],
            ["1", "3DH", "68H", "00H", "24H", "52H", "W0", "W1", "SUM"],
            ["2", "3DH", "68H", "00H", "24H", "53H", "W2", "W3", "SUM"],
          ],
          confidence: 0.9,
          warnings: [],
        },
      ],
      section_protocol_models: [
        {
          id: "section-multi",
          source_document_id: "doc-multi",
          section_id: "1.1.1.2",
          section_title: "1.1.1.2 \u7f13\u53d8\u9065\u6d4b\u8f6e\u8be2\u63a7\u5236\u5e8f\u5217",
          section_snippet_ids: [],
          input_flow_snippet_ids: [],
          output_flow_snippet_ids: [],
          table_ids: ["doc-multi-table-1"],
          primary_table_ids: ["doc-multi-table-1"],
          support_table_ids: [],
          protocol_relations: [
            {
              frame_table_id: "doc-multi-table-1",
              generation_mode: "frame_file",
              preferred_name: "\u7f13\u53d8\u9065\u6d4b\u6570\u636e",
              flow_direction: "output",
              should_generate_frame_table_file: true,
              checksum_rule: "SUM = low8(byte-sum(TITLE + W0 + ...))",
              confidence: 0.9,
              reasoning: [],
            },
          ],
          protocols: [],
          confidence: 0.9,
          warnings: [],
        },
      ],
      packet_model_candidates: [],
      references: [],
      warnings: [],
      updated_at: new Date().toISOString(),
    } as any

    const definitions = await buildDtpProtocolDefinitionsDocument(paths, knowledgeIndex)
    const dataFileIndex = prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT)
    writeDtpProtocolDataFiles(paths, definitions, dataFileIndex, { allowFallbackForUnresolvedFields: true })

    const output = readFileSync(join(paths.inputDataRoot, OUTPUT_FLOW, "\u7f13\u53d8\u9065\u6d4b\u6570\u636e.txt"), "utf-8")
      .trim()
      .split(/\r?\n/)

    expect(definitions.protocols[0].frames?.map((frame) => frame.byte_layout)).toEqual([
      ["3D", "68", "00", "24", "52", "W0", "W1", "SUM"],
      ["3D", "68", "00", "24", "53", "W2", "W3", "SUM"],
    ])
    expect(output.length).toBe(2)
    expect(output[0].startsWith("3D 68 00 24 52 00 00")).toBe(true)
    expect(output[1].startsWith("3D 68 00 24 53 00 00")).toBe(true)
  })

  test("reconstructs sparse continuation fields in a multi-frame CAN table", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-sparse-multi-frame-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    const knowledgeIndex = createEmptyKnowledgeIndex(workspaceRoot)
    knowledgeIndex.tables = [
      {
        id: "doc-memory-table-1",
        source_document_id: "doc-memory",
        caption: "\u88683.1.1.7-1 \u53d1\u5411\u4e0b\u4f4d\u673a\u7684\u5185\u5b58\u8bfb\u51fa\u6307\u4ee4\u683c\u5f0f",
        aliases: [],
        topic: "data_protocol",
        rows: [
          ["\u5e27\u5e8f\u53f7", "\u4ef2\u88c1\u573a\u3001\u63a7\u5236\u573a", "", "\u6709\u6548\u6570\u636e\u573a", "", "", "", "", "", "", ""],
          ["", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"],
          ["", "ID10~ID3", "ID2~ID0,RTR,DLC", "Index", "", "", "", "", "", "", ""],
          ["", "4DH", "28H", "00H", "L0AH", "TE0H", "W0", "", "", "", ""],
          ["", "4DH", "27H", "01H", "", "", "", "", "", "SUM", "-"],
        ],
        confidence: 0.9,
        warnings: [],
      },
    ]
    knowledgeIndex.section_protocol_models = [
      {
        id: "section-memory-read",
        source_document_id: "doc-memory",
        section_id: "1.1.1.7",
        section_title: "1.1.1.7 \u5185\u5b58\u8bfb\u51fa\u6307\u4ee4\u76f8\u5173\u6570\u636e\u6d41",
        section_snippet_ids: [],
        input_flow_snippet_ids: [],
        output_flow_snippet_ids: [],
        table_ids: ["doc-memory-table-1"],
        primary_table_ids: ["doc-memory-table-1"],
        support_table_ids: [],
        protocol_relations: [
          {
            frame_table_id: "doc-memory-table-1",
            generation_mode: "frame_file",
            preferred_name: "\u5185\u5b58\u8bfb\u51fa\u6307\u4ee4",
            flow_direction: "input",
            should_generate_frame_table_file: true,
            checksum_rule: "SUM = low8(byte-sum(TITLE + W0 + ... + W9))",
            confidence: 0.9,
            reasoning: [],
          },
        ],
        protocols: [],
        confidence: 0.9,
        warnings: [],
      },
    ]

    const definitions = await buildDtpProtocolDefinitionsDocument(paths, knowledgeIndex)

    expect(definitions.protocols[0].frames?.map((frame) => frame.byte_layout)).toEqual([
      ["4D", "28", "00", "0A", "E0", "W0", "W1", "W2", "W3", "W4"],
      ["4D", "27", "01", "W5", "W6", "W7", "W8", "W9", "SUM"],
    ])
    expect(validateDtpProtocolDefinitions(definitions).valid).toBe(true)
  })

  test("uses the first-frame TITLE when validating and writing a tail-frame SUM", () => {
    const workspaceRoot = join(tmpdir(), `dtp-cross-frame-sum-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    const definitions = createProtocolDefinitions(workspaceRoot, [{
      protocol_id: "cross-frame-title-sum",
      source_section: "multi-frame CAN command",
      flow_direction: "input",
      base_file_name: "cross-frame-command",
      generation_mode: "single_file",
      frames: [
        {
          frame_id: "frame-1",
          sequence: 1,
          source_table_id: "table-cross-frame",
          byte_layout: ["4D", "28", "00", "0A", "40", "W0"],
          field_layout: [
            { name: "TITLE", role: "title", byte_offset: 4, byte_length: 1, default_value: "40" },
            { name: "W0", role: "data", byte_offset: 5, byte_length: 1, default_value: "01" },
          ],
          checksum: { type: "sum_low8", start: "TITLE", end: "BEFORE_SUM" },
        },
        {
          frame_id: "frame-2",
          sequence: 2,
          source_table_id: "table-cross-frame",
          byte_layout: ["4D", "27", "01", "W1", "SUM"],
          field_layout: [
            { name: "W1", role: "data", byte_offset: 3, byte_length: 1, default_value: "02" },
            { name: "SUM", role: "checksum", byte_offset: 4, byte_length: 1 },
          ],
          checksum: { type: "sum_low8", start: "TITLE", end: "BEFORE_SUM" },
        },
      ],
      fields: [
        { name: "W0", type: "fixed", value: "01", source: "table", confidence: 1, warnings: [] },
        { name: "W1", type: "fixed", value: "02", source: "table", confidence: 1, warnings: [] },
      ],
      evidence: [],
      warnings: [],
      confidence: 1,
      understanding_source: "heuristic-fallback",
    }])

    expect(validateDtpProtocolDefinitions(definitions).valid).toBe(true)
    const index = prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT)
    const writerResult = writeDtpProtocolDataFiles(paths, definitions, index)
    const outputPath = writerResult.generated_files[0]?.absolute_file_path
    expect(outputPath).toBeDefined()
    const lines = readFileSync(outputPath!, "utf-8")
      .trim()
      .split(/\r?\n/)
    expect(lines).toEqual(["4D 28 00 0A 40 01", "4D 27 01 02 43"])
  })

  test("preserves inline W-field defaults and physical columns in multi-frame CAN tables", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-inline-field-defaults-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    const knowledgeIndex = createEmptyKnowledgeIndex(workspaceRoot)
    knowledgeIndex.tables = [
      {
        id: "doc-remote-table-1",
        source_document_id: "doc-remote",
        caption: "10-byte remote command",
        aliases: [],
        topic: "data_protocol",
        rows: [
          ["frame", "arbitration", "control RTR DLC", "data", "", "", "", "", "", "", ""],
          ["", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"],
          ["", "ID10-ID3", "ID2-ID0,RTR,DLC", "帧序号", "", "", "", "", "", "", ""],
          ["", "4DH", "28H", "00H", "L0AH", "T40H", "W001H", "W10DH", "W2", "W306H", "W4"],
          ["", "4DH", "27H", "01H", "W5", "W6", "W7", "W8", "W9", "SUM", "-"],
        ],
        confidence: 0.9,
        warnings: [],
      },
    ]
    knowledgeIndex.section_protocol_models = [
      {
        id: "section-remote-command",
        source_document_id: "doc-remote",
        section_id: "3.1.1.5",
        section_title: "3.1.1.5 10-byte remote command",
        section_snippet_ids: [],
        input_flow_snippet_ids: [],
        output_flow_snippet_ids: [],
        table_ids: ["doc-remote-table-1"],
        primary_table_ids: ["doc-remote-table-1"],
        support_table_ids: [],
        protocol_relations: [
          {
            frame_table_id: "doc-remote-table-1",
            generation_mode: "frame_file",
            preferred_name: "remote-command",
            flow_direction: "input",
            should_generate_frame_table_file: true,
            checksum_rule: "SUM = low8(byte-sum(TITLE + W0 + ... + W9))",
            confidence: 0.9,
            reasoning: [],
            field_value_plan: [
              { field_name: "W0", value: "01", value_source: "model", confidence: 0.9, reasoning: [] },
              { field_name: "W1", value: "0D", value_source: "model", confidence: 0.9, reasoning: [] },
              { field_name: "W3", value: "06", value_source: "model", confidence: 0.9, reasoning: [] },
            ],
          },
        ],
        protocols: [],
        confidence: 0.9,
        warnings: [],
      },
    ]

    const definitions = await buildDtpProtocolDefinitionsDocument(paths, knowledgeIndex)
    const frames = definitions.protocols[0].frames ?? []

    expect(frames.map((frame) => frame.byte_layout)).toEqual([
      ["4D", "28", "00", "0A", "40", "W0", "W1", "W2", "W3", "W4"],
      ["4D", "27", "01", "W5", "W6", "W7", "W8", "W9", "SUM"],
    ])
    expect(frames[0].field_layout.find((field) => field.name === "W0")?.default_value).toBe("01")
    expect(frames[0].field_layout.find((field) => field.name === "W1")?.default_value).toBe("0D")
    expect(frames[0].field_layout.find((field) => field.name === "W3")?.default_value).toBe("06")
    expect(frames[0].field_layout.find((field) => field.name === "FRAME_SEQUENCE")).toMatchObject({
      role: "sequence",
      byte_offset: 2,
      default_value: "00",
    })
    expect(frames[1].field_layout.find((field) => field.name === "FRAME_SEQUENCE")).toMatchObject({
      role: "sequence",
      byte_offset: 2,
      default_value: "01",
    })
    expect(frames[1].field_layout.map((field) => field.name)).toContain("W9")
    expect(frames[1].field_layout.map((field) => field.name)).not.toContain("W0")

    definitions.protocols[0].bus_context = {
      bus_type: "CAN",
      controller: "SJA1000T",
      controller_family: "SJA1000",
      mode: "PeliCAN",
      frame_format: "standard",
      frame_buffer_layout: "business-payload",
      frame_information: { apply_to_case_data: true, strategy: "derive_from_ff_rtr_dlc" },
    }
    const dataFileIndex = prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT)
    const generated = buildGeneratedStep({
      step: {
        stepIndex: 1,
        keywordName: "SendCANDataFile",
        stepDescription: "Send the correct 10-byte remote command",
      },
      caseContext: {
        caseId: "TC-REMOTE-001",
        testPurpose: "Verify the complete multi-frame command",
        requirementIds: ["TR-REMOTE-001"],
        steps: [],
      },
      keywordDef: {
        keywordName: "SendCANDataFile",
        txtPath: "",
        jsonPath: "",
        arguments: [{ name: "${para2}", comments: "data file" }],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex,
      dataFileIndex,
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions: definitions,
      dataGenerationPlan: {
        protocol_name: "remote-command",
        flow_direction: "input",
        variant_type: "correct",
        mutations: [],
        sequence_operations: [],
        checksum_policy: "recalculate_correctly",
        argument_values: {},
        evidence_ids: [],
        confidence: 1,
        warnings: [],
        source: "heuristic-fallback",
      },
    })
    const outputFile = join(
      paths.inputDataRoot,
      INPUT_FLOW,
      "\u7528\u4f8b\u751f\u6210",
      "TC-REMOTE-001",
      generated.generated_data_files[0].requested_file_name,
    )
    expect(readFileSync(outputFile, "utf-8").trim().split(/\r?\n/)).toEqual([
      "08 4D 28 00 0A 40 01 0D 00 06 00",
      "07 4D 27 01 00 00 00 00 00 54",
    ])
  })

  test("normalizes model frame tokens and enriches dictionary option names from source tables", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-model-dictionary-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    const knowledgeIndex: ProjectKnowledgeIndex = {
      schema_version: "1.0.0",
      extractor_version: EXTRACTOR_VERSION,
      project_root: workspaceRoot,
      source_documents: [],
      topics: [],
      snippets: [
        {
          id: "doc-1-snippet-1",
          source_document_id: "doc-1",
          text: "3.1.1.7 间接指令 输入流：间接指令。",
          tags: ["hardware_interface"],
        },
      ],
      tables: [
        {
          id: "doc-1-table-17",
          source_document_id: "doc-1",
          caption: "表3.1.1.7-1 间接指令格式",
          rows: [
            ["帧序号", "仲裁场、控制场", "有效数据场"],
            ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"],
            ["1", "65H", "06H", "T20H", "15H", "W1", "W2", "W3", "SUM", "-", "-"],
          ],
        },
        {
          id: "doc-1-table-18",
          source_document_id: "doc-1",
          caption: "表3.1.1.7-2 间接数据指令说明",
          rows: [
            ["序号", "指令名称", "指令码", "指令说明", "备注"],
            ["-X6-测控子系统与-X4-1通信", "1501AAAA", "缓变遥测-X4-选星结果为1", "数字型"],
            ["-X2-关机", "1510AAAA", "速变遥测-X2-开关状态：0", "输出KCB_OUT_001指令"],
          ],
        },
      ],
      section_protocol_models: [
        {
          id: "section-indirect",
          source_document_id: "doc-1",
          section_id: "3.1.1.7",
          section_title: "3.1.1.7 间接指令",
          section_snippet_ids: ["doc-1-snippet-1"],
          input_flow_snippet_ids: ["doc-1-snippet-1"],
          output_flow_snippet_ids: [],
          table_ids: ["doc-1-table-17", "doc-1-table-18"],
          primary_table_ids: ["doc-1-table-17"],
          support_table_ids: ["doc-1-table-18"],
          protocol_relations: [],
          protocols: [],
          confidence: 0.9,
          warnings: [],
        },
      ],
      packet_model_candidates: [],
      references: [],
      warnings: [],
      updated_at: new Date().toISOString(),
    } as any

    const definitions = await buildDtpProtocolDefinitionsDocument(paths, knowledgeIndex, {
      understandSectionProtocols: async () => ({
        protocols: [
          {
            protocol_id: "indirect-command",
            source_section: "3.1.1.7 间接指令",
            flow_direction: "input",
            base_file_name: "间接指令",
            generation_mode: "one_file_per_dictionary_row",
            frame: {
              source_table_id: "doc-1-table-17",
              byte_layout: ["65H", "06H", "T20H", "15H", "W1", "W2", "W3", "SUM", "-", "-"],
              checksum: { type: "sum_low8", start: "TITLE", end: "BEFORE_SUM" },
            },
            fields: [
              {
                name: "W1",
                type: "enum",
                source_table_id: "doc-1-table-18",
                options: [
                  { value: "01", label: "与X4-1通信", source: "表3.1.1.7-2 1501" },
                  { value: "10", label: "X2-关机", source: "表3.1.1.7-2 1510" },
                ],
              },
              { name: "W2", type: "fixed", value: "AA", source_table_id: "doc-1-table-17" },
              { name: "W3", type: "fixed", value: "AA", source_table_id: "doc-1-table-17" },
            ],
            evidence: ["表3.1.1.7-1", "表3.1.1.7-2"],
            warnings: [],
            confidence: 0.95,
          },
        ],
        non_generated_tables: [],
        warnings: [],
      }),
    })
    const dataFileIndex = prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT)
    const result = writeDtpProtocolDataFiles(paths, definitions, dataFileIndex)

    const generatedNames = result.generated_files.map((file) => file.requested_file_name).sort()
    expect(definitions.protocols[0].frames?.[0].byte_layout).toEqual(["65", "06", "20", "15", "W1", "W2", "W3", "SUM"])
    expect(generatedNames).toEqual([
      "间接指令-X2-关机.txt",
      "间接指令-X6-测控子系统与-X4-1通信.txt",
    ])
    expect(readFileSync(join(paths.inputDataRoot, INPUT_FLOW, "间接指令-X2-关机.txt"), "utf-8").trim()).toBe("65 06 20 15 10 AA AA 99")
  })

  test("uses dictionary row names and drops fixed command prefix in heuristic fallback", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-heuristic-dictionary-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    const knowledgeIndex: ProjectKnowledgeIndex = {
      schema_version: "1.0.0",
      extractor_version: EXTRACTOR_VERSION,
      project_root: workspaceRoot,
      source_documents: [],
      topics: [],
      snippets: [],
      tables: [
        {
          id: "doc-1-table-17",
          source_document_id: "doc-1",
          caption: "表3.1.1.7-1 间接指令格式",
          rows: [
            ["帧序号", "仲裁场、控制场", "有效数据场"],
            ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"],
            ["1", "65H", "06H", "T20H", "15H", "W1", "W2", "W3", "SUM", "-", "-"],
          ],
        },
        {
          id: "doc-1-table-18",
          source_document_id: "doc-1",
          caption: "表3.1.1.7-2 间接数据指令说明",
          rows: [
            ["序号", "指令名称", "指令码", "指令说明", "备注"],
            ["-X6-测控子系统与-X4-1通信", "1501AAAA", "缓变遥测-X4-选星结果为1", "数字型"],
            ["-X2-关机", "1510AAAA", "速变遥测-X2-开关状态：0", "输出KCB_OUT_001指令"],
          ],
        },
      ],
      section_protocol_models: [
        {
          id: "section-indirect-heuristic",
          source_document_id: "doc-1",
          section_id: "3.1.1.7",
          section_title: "3.1.1.7 间接指令",
          section_snippet_ids: [],
          input_flow_snippet_ids: [],
          output_flow_snippet_ids: [],
          table_ids: ["doc-1-table-17", "doc-1-table-18"],
          primary_table_ids: ["doc-1-table-17"],
          support_table_ids: ["doc-1-table-18"],
          protocol_relations: [
            {
              frame_table_id: "doc-1-table-17",
              dictionary_table_id: "doc-1-table-18",
              generation_mode: "one_file_per_dictionary_row",
              preferred_name: "间接指令",
              flow_direction: "input",
              source_section: "3.1.1.7 间接指令",
              source_flow_heading: INPUT_FLOW,
              should_generate_frame_table_file: true,
              checksum_rule: "SUM = low8(byte-sum(TITLE + W0 + W1 + ... + W(n-1)))",
              confidence: 0.9,
              reasoning: ["test fixture"],
            },
          ],
          protocols: [],
          confidence: 0.9,
          warnings: [],
        },
      ],
      packet_model_candidates: [],
      references: [],
      warnings: [],
      updated_at: new Date().toISOString(),
    } as any

    const definitions = await buildDtpProtocolDefinitionsDocument(paths, knowledgeIndex)
    const dataFileIndex = prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT)
    const result = writeDtpProtocolDataFiles(paths, definitions, dataFileIndex)

    const generatedNames = result.generated_files.map((file) => file.requested_file_name).sort()
    expect(generatedNames).toEqual([
      "间接指令-X2-关机.txt",
      "间接指令-X6-测控子系统与-X4-1通信.txt",
    ])
    expect(generatedNames.some((name) => /1501AAAA|1510AAAA/.test(name))).toBe(false)
    expect(readFileSync(join(paths.inputDataRoot, INPUT_FLOW, "间接指令-X2-关机.txt"), "utf-8").trim()).toBe("65 06 20 15 10 AA AA 99")
  })

  test("uses model-backed protocol writer as project-level output source", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-project-protocol-writer-${Date.now()}`)
    const matrixDataDir = join(workspaceRoot, ".matrix", "data")
    const dtpRoot = join(matrixDataDir, "DTPProject")
    const knowledgeIndexFile = resolveDefaultPaths(workspaceRoot).projectKnowledgeIndexFile
    mkdirSync(dtpRoot, { recursive: true })
    mkdirSync(dirname(knowledgeIndexFile), { recursive: true })

    writeFileSync(
      knowledgeIndexFile,
      `${JSON.stringify({
        schema_version: "1.0.0",
        extractor_version: EXTRACTOR_VERSION,
        project_root: workspaceRoot,
        source_documents: [],
        topics: [],
        snippets: [
          {
            id: "doc-4-snippet-1",
            source_document_id: "doc-4",
            topic: "hardware_interface",
            text: "3.1.1.1 \u901f\u53d8\u9065\u6d4b\u8f6e\u8be2\u53ca\u5e94\u7b54\u683c\u5f0f\u8bf4\u660e",
            confidence: 0.9,
          },
          {
            id: "doc-4-snippet-2",
            source_document_id: "doc-4",
            topic: "requirement_input_flow",
            text: `${INPUT_FLOW}\uff1a${FAST_POLL}\u3002`,
            confidence: 0.9,
          },
        ],
        tables: [
          {
            id: "doc-4-table-1",
            source_document_id: "doc-4",
            caption: `\u8868 B-1 ${FAST_POLL}`,
            aliases: [],
            topic: "packet_structure",
            rows: [
              ["\u5e8f\u53f7", "\u4ef2\u88c1\u573a", "\u63a7\u5236\u573a", "TITLE", "W0", "SUM"],
              ["1.", "86H", "04H", "T10H", "W0", "SUM"],
            ],
            confidence: 0.9,
            warnings: [],
          },
        ],
        section_protocol_models: [
          {
            id: "section-model-input",
            source_document_id: "doc-4",
            section_id: "3.1.1.1",
            section_title: "3.1.1.1 \u901f\u53d8\u9065\u6d4b\u8f6e\u8be2\u53ca\u5e94\u7b54\u683c\u5f0f\u8bf4\u660e",
            section_snippet_ids: ["doc-4-snippet-1", "doc-4-snippet-2"],
            input_flow_snippet_ids: ["doc-4-snippet-2"],
            output_flow_snippet_ids: [],
            table_ids: ["doc-4-table-1"],
            primary_table_ids: ["doc-4-table-1"],
            support_table_ids: [],
            protocol_relations: [],
            protocols: [],
            confidence: 0.9,
            warnings: [],
          },
        ],
        packet_model_candidates: [],
        references: [],
        warnings: [],
        updated_at: new Date().toISOString(),
      }, null, 2)}\n`,
      "utf-8",
    )

    const result = await runDtpProjectDataFilesGeneration(
      workspaceRoot,
      EMPTY_DOCS_CONTEXT,
      {
        understandSectionProtocols: async (context) => ({
          protocols: [
            {
              protocol_id: `${context.section_model_id}-model-1`,
              source_section: context.section_title,
              flow_direction: "input",
              base_file_name: FAST_POLL,
              generation_mode: "single_file",
              frame: {
                source_table_id: "doc-4-table-1",
                byte_layout: ["86", "04", "10", "W0", "SUM"],
                checksum: { type: "sum_low8", start: "TITLE", end: "BEFORE_SUM" },
              },
              fields: [
                { name: "W0", type: "fixed", value: "01", source_table_id: "doc-4-table-1", confidence: 0.9 },
              ],
              evidence: ["\u8868 B-1"],
              warnings: [],
              confidence: 0.95,
            },
          ],
          non_generated_tables: [],
          warnings: [],
        }),
      },
      { knowledgeMode: "offline" },
    )

    const outputFile = join(dtpRoot, "V1", INPUT_DATA, `${FAST_POLL}.txt`)
    const writerPreview = JSON.parse(readFileSync(resolveDefaultPaths(workspaceRoot).dtpProtocolWriterPreviewFile, "utf-8"))

    expect(result.generated_files.length).toBe(1)
    expect(result.generated_files[0].file_path).toBe(`${INPUT_DATA}\\\\${FAST_POLL}.txt`)
    expect(readFileSync(outputFile, "utf-8").trim()).toBe("86 04 10 01 11")
    expect(writerPreview.legacy_generated_count).toBe(0)
    expect(writerPreview.protocol_writer_generated_count).toBe(1)
    expect(writerPreview.matched_file_paths).toEqual([])
  })

  test("retries protocol definitions from retry context before writing data files", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-protocol-retry-${Date.now()}`)
    const matrixDataDir = join(workspaceRoot, ".matrix", "data")
    const dtpRoot = join(matrixDataDir, "DTPProject")
    const knowledgeIndexFile = resolveDefaultPaths(workspaceRoot).projectKnowledgeIndexFile
    mkdirSync(dtpRoot, { recursive: true })
    mkdirSync(dirname(knowledgeIndexFile), { recursive: true })
    writeFileSync(
      knowledgeIndexFile,
      `${JSON.stringify({
        schema_version: "1.0.0",
        extractor_version: EXTRACTOR_VERSION,
        project_root: workspaceRoot,
        source_documents: [],
        topics: [],
        snippets: [
          {
            id: "doc-retry-snippet-1",
            source_document_id: "doc-retry",
            topic: "hardware_interface",
            text: "3.1.1.1 retry section",
            confidence: 0.9,
          },
          {
            id: "doc-retry-snippet-2",
            source_document_id: "doc-retry",
            topic: "requirement_input_flow",
            text: `${INPUT_FLOW}\uff1a${FAST_POLL}`,
            confidence: 0.9,
          },
        ],
        tables: [
          {
            id: "doc-retry-table-1",
            source_document_id: "doc-retry",
            caption: `\u8868 B-1 ${FAST_POLL}`,
            aliases: [],
            topic: "packet_structure",
            rows: [
              ["\u5e8f\u53f7", "\u4ef2\u88c1\u573a", "\u63a7\u5236\u573a", "TITLE", "W0", "SUM"],
              ["1.", "86H", "04H", "T10H", "W0", "SUM"],
            ],
            confidence: 0.9,
            warnings: [],
          },
        ],
        section_protocol_models: [
          {
            id: "section-model-retry",
            source_document_id: "doc-retry",
            section_id: "3.1.1.1",
            section_title: "3.1.1.1 retry section",
            section_snippet_ids: ["doc-retry-snippet-1", "doc-retry-snippet-2"],
            input_flow_snippet_ids: ["doc-retry-snippet-2"],
            output_flow_snippet_ids: [],
            table_ids: ["doc-retry-table-1"],
            primary_table_ids: ["doc-retry-table-1"],
            support_table_ids: [],
            protocol_relations: [],
            protocols: [],
            confidence: 0.9,
            warnings: [],
          },
        ],
        packet_model_candidates: [],
        references: [],
        warnings: [],
        updated_at: new Date().toISOString(),
      }, null, 2)}\n`,
      "utf-8",
    )

    let retryCalls = 0
    const result = await runDtpProjectDataFilesGeneration(
      workspaceRoot,
      EMPTY_DOCS_CONTEXT,
      {
        understandSectionProtocols: async (context) => ({
          protocols: [
            {
              protocol_id: `${context.section_model_id}-model-1`,
              source_section: context.section_title,
              flow_direction: "input",
              base_file_name: FAST_POLL,
              generation_mode: "single_file",
              frame: {
                source_table_id: "doc-retry-table-1",
                byte_layout: ["86", "04", "10", "W0", "SUM"],
                checksum: { type: "sum_low8", start: "TITLE", end: "BEFORE_SUM" },
              },
              fields: [],
              evidence: ["retry fixture"],
              warnings: [],
              confidence: 0.8,
            },
          ],
          non_generated_tables: [],
          warnings: [],
        }),
        reviseProtocolDefinitions: async (retryContext) => {
          retryCalls += 1
          return {
            protocols: [
              {
                protocol_id: retryContext.affected_protocols[0]?.protocol_id,
                flow_direction: "input",
                base_file_name: FAST_POLL,
                generation_mode: "single_file",
                frame: {
                  source_table_id: "doc-retry-table-1",
                  byte_layout: ["86", "04", "10", "W0", "SUM"],
                  checksum: { type: "sum_low8", start: "TITLE", end: "BEFORE_SUM" },
                },
                fields: [
                  { name: "W0", type: "fixed", value: "01", source_table_id: "doc-retry-table-1", confidence: 0.9 },
                ],
                evidence: ["retry patched W0"],
                warnings: [],
                confidence: 0.95,
              },
            ],
            warnings: [],
          }
        },
      },
      { knowledgeMode: "offline" },
    )

    const outputFile = join(dtpRoot, "V1", INPUT_DATA, `${FAST_POLL}.txt`)
    const qualityReport = JSON.parse(readFileSync(resolveDefaultPaths(workspaceRoot).dtpDataQualityReportFile, "utf-8"))
    const retryContext = JSON.parse(readFileSync(resolveDefaultPaths(workspaceRoot).dtpProtocolRetryContextFile, "utf-8"))

    expect(retryCalls).toBe(1)
    expect(result.generated_files.length).toBe(1)
    expect(readFileSync(outputFile, "utf-8").trim()).toBe("86 04 10 01 11")
    expect(qualityReport.status).toBe("pass")
    expect(retryContext.warnings.some((warning: string) => warning.includes("retry-1"))).toBe(true)
  })

  test("uses 00 fallback after protocol retry cannot resolve fields", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-protocol-retry-fallback-${Date.now()}`)
    const matrixDataDir = join(workspaceRoot, ".matrix", "data")
    const dtpRoot = join(matrixDataDir, "DTPProject")
    const knowledgeIndexFile = resolveDefaultPaths(workspaceRoot).projectKnowledgeIndexFile
    mkdirSync(dtpRoot, { recursive: true })
    mkdirSync(dirname(knowledgeIndexFile), { recursive: true })
    writeFileSync(
      knowledgeIndexFile,
      `${JSON.stringify({
        schema_version: "1.0.0",
        extractor_version: EXTRACTOR_VERSION,
        project_root: workspaceRoot,
        source_documents: [],
        topics: [],
        snippets: [
          {
            id: "doc-fallback-snippet-1",
            source_document_id: "doc-fallback",
            topic: "hardware_interface",
            text: "3.1.1.1 fallback section",
            confidence: 0.9,
          },
          {
            id: "doc-fallback-snippet-2",
            source_document_id: "doc-fallback",
            topic: "requirement_input_flow",
            text: `${INPUT_FLOW}\uff1a${FAST_POLL}`,
            confidence: 0.9,
          },
        ],
        tables: [
          {
            id: "doc-fallback-table-1",
            source_document_id: "doc-fallback",
            caption: `\u8868 B-1 ${FAST_POLL}`,
            aliases: [],
            topic: "packet_structure",
            rows: [
              ["\u5e8f\u53f7", "\u4ef2\u88c1\u573a", "\u63a7\u5236\u573a", "TITLE", "W0", "SUM"],
              ["1.", "86H", "04H", "T10H", "W0", "SUM"],
            ],
            confidence: 0.9,
            warnings: [],
          },
        ],
        section_protocol_models: [
          {
            id: "section-model-fallback",
            source_document_id: "doc-fallback",
            section_id: "3.1.1.1",
            section_title: "3.1.1.1 fallback section",
            section_snippet_ids: ["doc-fallback-snippet-1", "doc-fallback-snippet-2"],
            input_flow_snippet_ids: ["doc-fallback-snippet-2"],
            output_flow_snippet_ids: [],
            table_ids: ["doc-fallback-table-1"],
            primary_table_ids: ["doc-fallback-table-1"],
            support_table_ids: [],
            protocol_relations: [],
            protocols: [],
            confidence: 0.9,
            warnings: [],
          },
        ],
        packet_model_candidates: [],
        references: [],
        warnings: [],
        updated_at: new Date().toISOString(),
      }, null, 2)}\n`,
      "utf-8",
    )

    const result = await runDtpProjectDataFilesGeneration(
      workspaceRoot,
      EMPTY_DOCS_CONTEXT,
      {
        understandSectionProtocols: async (context) => ({
          protocols: [
            {
              protocol_id: `${context.section_model_id}-model-1`,
              source_section: context.section_title,
              flow_direction: "input",
              base_file_name: FAST_POLL,
              generation_mode: "single_file",
              frame: {
                source_table_id: "doc-fallback-table-1",
                byte_layout: ["86", "04", "10", "W0", "SUM"],
                checksum: { type: "sum_low8", start: "TITLE", end: "BEFORE_SUM" },
              },
              fields: [],
              evidence: ["fallback fixture"],
              warnings: [],
              confidence: 0.8,
            },
          ],
          non_generated_tables: [],
          warnings: [],
        }),
        reviseProtocolDefinitions: async () => null,
      },
      { knowledgeMode: "offline" },
    )

    const outputFile = join(dtpRoot, "V1", INPUT_DATA, `${FAST_POLL}.txt`)
    const qualityReport = JSON.parse(readFileSync(resolveDefaultPaths(workspaceRoot).dtpDataQualityReportFile, "utf-8"))

    expect(result.generated_files.length).toBe(1)
    expect(readFileSync(outputFile, "utf-8").trim()).toBe("86 04 10 00 10")
    expect(qualityReport.status).toBe("warning")
    expect(qualityReport.issues.some((issue: any) => issue.reason.includes("Fallback-zero"))).toBe(true)
  })

  test("writes fixed protocol definitions into input and output flow data files", () => {
    const workspaceRoot = join(tmpdir(), `dtp-protocol-writer-fixed-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    const dataFileIndex = prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT)

    const result = writeDtpProtocolDataFiles(
      paths,
      {
        schema_version: "1.0.0",
        project_root: workspaceRoot,
        knowledge_index_file: paths.projectKnowledgeIndexFile,
        source: "model",
        sections: [],
        protocols: [
          {
            protocol_id: "protocol-input-fixed",
            source_section: "3.1.1.1",
            flow_direction: "input",
            base_file_name: FAST_POLL,
            generation_mode: "single_file",
            frame: {
              source_table_id: "table-b1",
              byte_layout: ["86", "04", "10", "W0", "SUM"],
              checksum: { type: "sum_low8", start: "TITLE", end: "BEFORE_SUM" },
            },
            fields: [{ name: "W0", type: "fixed", value: "01", confidence: 0.9 }],
            evidence: ["\u8868 B-1"],
            warnings: [],
            confidence: 0.9,
            understanding_source: "model",
          },
          {
            protocol_id: "protocol-output-fixed",
            source_section: "3.1.1.1",
            flow_direction: "output",
            base_file_name: FAST_TM,
            generation_mode: "single_file",
            frame: {
              source_table_id: "table-b2",
              byte_layout: ["87", "05", "23", "W0", "SUM"],
              checksum: { type: "sum_low8", start: "TITLE", end: "BEFORE_SUM" },
            },
            fields: [{ name: "W0", type: "fixed", value: "02", confidence: 0.9 }],
            evidence: ["\u8868 B-2"],
            warnings: [],
            confidence: 0.9,
            understanding_source: "model",
          },
        ],
        non_generated_tables: [],
        warnings: [],
        updated_at: new Date().toISOString(),
      },
      dataFileIndex,
    )

    const inputFile = join(paths.inputDataRoot, INPUT_FLOW, `${FAST_POLL}.txt`)
    const outputFile = join(paths.inputDataRoot, OUTPUT_FLOW, `${FAST_TM}.txt`)

    expect(result.generated_files.length).toBe(2)
    expect(readFileSync(inputFile, "utf-8").trim()).toBe("86 04 10 01 11")
    expect(readFileSync(outputFile, "utf-8").trim()).toBe("87 05 23 02 25")
    expect(dataFileIndex.entries.map((entry) => entry.file_path).sort()).toEqual([
      `${INPUT_DATA}\\\\${INPUT_FLOW}\\\\${FAST_POLL}.txt`,
      `${INPUT_DATA}\\\\${OUTPUT_FLOW}\\\\${FAST_TM}.txt`,
    ].sort())
  })

  test("writes dictionary row protocol variants with row names and low8 SUM", () => {
    const workspaceRoot = join(tmpdir(), `dtp-protocol-writer-dictionary-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    const dataFileIndex = prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT)

    const result = writeDtpProtocolDataFiles(
      paths,
      {
        schema_version: "1.0.0",
        project_root: workspaceRoot,
        knowledge_index_file: paths.projectKnowledgeIndexFile,
        source: "heuristic-fallback",
        sections: [],
        protocols: [
          {
            protocol_id: "protocol-b8-dictionary",
            source_section: "3.1.1.3",
            flow_direction: "input",
            base_file_name: "\u95f4\u63a5\u6307\u4ee4",
            generation_mode: "one_file_per_dictionary_row",
            frame: {
              source_table_id: "table-b7",
              byte_layout: ["46", "06", "20", "W0", "W1", "W2", "W3", "SUM"],
              checksum: { type: "sum_low8", start: "TITLE", end: "BEFORE_SUM" },
            },
            fields: [],
            variants: [
              {
                name: "\u914d\u7535\u6a21\u57571\u8f93\u51fa\u6307\u4ee4",
                fields: [
                  { name: "W0", type: "fixed", value: "A3", source: "dictionary-row", confidence: 0.9 },
                  { name: "W1", type: "fixed", value: "01", source: "dictionary-row", confidence: 0.9 },
                  { name: "W2", type: "fixed", value: "AA", source: "dictionary-row", confidence: 0.9 },
                  { name: "W3", type: "fixed", value: "AA", source: "dictionary-row", confidence: 0.9 },
                ],
                evidence: ["\u8868 B-8"],
                warnings: [],
                confidence: 0.9,
              },
            ],
            evidence: ["\u8868 B-7", "\u8868 B-8"],
            warnings: [],
            confidence: 0.9,
            understanding_source: "heuristic-fallback",
          },
        ],
        non_generated_tables: [],
        warnings: [],
        updated_at: new Date().toISOString(),
      },
      dataFileIndex,
    )

    const outputFile = join(paths.inputDataRoot, INPUT_FLOW, "\u95f4\u63a5\u6307\u4ee4-\u914d\u7535\u6a21\u57571\u8f93\u51fa\u6307\u4ee4.txt")

    expect(result.generated_files.length).toBe(1)
    expect(result.generated_files[0].requested_file_name).toBe("\u95f4\u63a5\u6307\u4ee4-\u914d\u7535\u6a21\u57571\u8f93\u51fa\u6307\u4ee4.txt")
    expect(readFileSync(outputFile, "utf-8").trim()).toBe("46 06 20 A3 01 AA AA 18")
  })

  test("skips dictionary-row protocols when model returns no expandable rows", () => {
    const workspaceRoot = join(tmpdir(), `dtp-protocol-writer-empty-dictionary-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    const dataFileIndex = prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT)

    const result = writeDtpProtocolDataFiles(
      paths,
      {
        schema_version: "1.0.0",
        project_root: workspaceRoot,
        knowledge_index_file: paths.projectKnowledgeIndexFile,
        source: "model",
        sections: [],
        protocols: [
          {
            protocol_id: "bad-indirect-model",
            source_section: "3.1.1.7",
            flow_direction: "input",
            base_file_name: "间接指令",
            generation_mode: "one_file_per_dictionary_row",
            frame: {
              source_table_id: "table-b7",
              byte_layout: ["86", "04", "23", "06", "W0", "W1", "SUM"],
              checksum: { type: "sum_low8", start: "TITLE", end: "BEFORE_SUM" },
            },
            fields: [
              { name: "W0", type: "fixed", value: "00", confidence: 0.9 },
              { name: "W1", type: "bitfield", confidence: 0.3 },
            ],
            evidence: ["bad model fixture"],
            warnings: [],
            confidence: 0.4,
            understanding_source: "model",
          },
        ],
        non_generated_tables: [],
        warnings: [],
        updated_at: new Date().toISOString(),
      },
      dataFileIndex,
    )

    expect(result.generated_files).toEqual([])
    expect(result.skipped_protocols[0].protocol_id).toBe("bad-indirect-model")
    expect(existsSync(join(paths.inputDataRoot, INPUT_FLOW, "间接指令.txt"))).toBe(false)
  })

  test("uses dictionary caption instead of frame-header caption for dictionary variant filenames", () => {
    const workspaceRoot = join(tmpdir(), `dtp-protocol-writer-header-name-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    const dataFileIndex = prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT)

    const result = writeDtpProtocolDataFiles(
      paths,
      {
        schema_version: "1.0.0",
        project_root: workspaceRoot,
        knowledge_index_file: paths.projectKnowledgeIndexFile,
        source: "heuristic-fallback",
        sections: [],
        protocols: [
          {
            protocol_id: "protocol-b8-header-caption",
            source_section: "3.1.1.3",
            flow_direction: "input",
            base_file_name: "\u5e8f\u53f7ID10\uff5eID3ID2\uff5eID0RTRDLC",
            generation_mode: "one_file_per_dictionary_row",
            frame: {
              source_table_id: "table-b7",
              byte_layout: ["46", "06", "20", "W0", "W1", "W2", "W3", "SUM"],
              checksum: { type: "sum_low8", start: "TITLE", end: "BEFORE_SUM" },
            },
            fields: [],
            variants: [
              {
                name: "\u5145\u7535\u7ec8\u6b62\u63a7\u5236\u63a5\u901a",
                fields: [
                  { name: "W0", type: "fixed", value: "A3", source: "dictionary-row", confidence: 0.9 },
                  { name: "W1", type: "fixed", value: "0D", source: "dictionary-row", confidence: 0.9 },
                  { name: "W2", type: "fixed", value: "AA", source: "dictionary-row", confidence: 0.9 },
                  { name: "W3", type: "fixed", value: "AA", source: "dictionary-row", confidence: 0.9 },
                ],
                evidence: ["\u8868 B-8 \u95f4\u63a5\u6307\u4ee4\u7801\u5b9a\u4e49\u8868"],
                warnings: [],
                confidence: 0.9,
              },
            ],
            evidence: [
              "\u5e8f \u53f7 ID10\uff5eID3 ID2\uff5eID0 \uff0cRTR \uff0cDLC",
              "\u8868 B-8 \u95f4\u63a5\u6307\u4ee4\u7801\u5b9a\u4e49\u8868",
            ],
            warnings: [],
            confidence: 0.9,
            understanding_source: "heuristic-fallback",
          },
        ],
        non_generated_tables: [],
        warnings: [],
        updated_at: new Date().toISOString(),
      },
      dataFileIndex,
    )

    const expectedName = "\u95f4\u63a5\u6307\u4ee4-\u5145\u7535\u7ec8\u6b62\u63a7\u5236\u63a5\u901a.txt"
    const outputFile = join(paths.inputDataRoot, INPUT_FLOW, expectedName)

    expect(result.generated_files[0].requested_file_name).toBe(expectedName)
    expect(result.generated_files[0].protocol_name).toBe("\u95f4\u63a5\u6307\u4ee4")
    expect(readFileSync(outputFile, "utf-8").trim()).toBe("46 06 20 A3 0D AA AA 24")
  })

  test("uses full generated file stem for protocol-name arguments", () => {
    const workspaceRoot = join(tmpdir(), `dtp-case-protocol-name-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    const index: GeneratedDataFileIndex = {
      schema_version: "1.0.0",
      project_root: workspaceRoot,
      dtp_root: paths.dtpRoot,
      runtime_dir: paths.runtimeDir,
      input_data_root: paths.inputDataRoot,
      source_documents: [],
      entries: [
        {
          id: "indirect-command-pdu",
          protocol_name: "\u95f4\u63a5\u6307\u4ee4",
          requested_file_name: "\u95f4\u63a5\u6307\u4ee4-\u914d\u7535\u6a21\u57571\u8f93\u51fa\u6307\u4ee4.txt",
          file_path: `${INPUT_DATA}\\\\${INPUT_FLOW}\\\\\u95f4\u63a5\u6307\u4ee4-\u914d\u7535\u6a21\u57571\u8f93\u51fa\u6307\u4ee4.txt`,
          source: "pre-generated",
          source_documents: [],
          generation_basis: ["\u8868 B-8"],
          flow_direction: "input",
          confidence: 0.9,
          state: "generated",
          warnings: [],
        },
      ],
      warnings: [],
      updated_at: new Date().toISOString(),
    }
    const knowledgeIndex: ProjectKnowledgeIndex = {
      schema_version: "1.0.0",
      extractor_version: EXTRACTOR_VERSION,
      project_root: workspaceRoot,
      source_documents: [],
      topics: [],
      snippets: [],
      tables: [],
      section_protocol_models: [],
      packet_model_candidates: [],
      references: [],
      warnings: [],
      updated_at: new Date().toISOString(),
    }

    const step = buildGeneratedStep({
      step: {
        stepIndex: 1,
        keywordName: "\u53d1\u9001\u95f4\u63a5\u6307\u4ee4",
        stepDescription: "\u53d1\u9001\u914d\u7535\u6a21\u57571\u8f93\u51fa\u6307\u4ee4",
      },
      caseContext: {
        caseId: "TC-001",
        testPurpose: "\u95f4\u63a5\u6307\u4ee4\u53d1\u9001",
        requirementIds: [],
        steps: [],
      },
      keywordDef: {
        keywordName: "\u53d1\u9001\u95f4\u63a5\u6307\u4ee4",
        txtPath: "",
        jsonPath: "",
        arguments: [
          {
            name: "${protocol}",
            comments: "\u6570\u636e\u534f\u8bae\u540d\u79f0",
          },
        ],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex,
      dataFileIndex: index,
      docsContext: EMPTY_DOCS_CONTEXT,
    })

    expect(step.resolved_arguments[0].semantic).toBe("protocol_name")
    expect(step.resolved_arguments[0].value).toBe("\u95f4\u63a5\u6307\u4ee4-\u914d\u7535\u6a21\u57571\u8f93\u51fa\u6307\u4ee4")
  })

  test("reports argument quality issues for unresolved keyword parameters", () => {
    const workspaceRoot = join(tmpdir(), `dtp-argument-quality-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    const index = prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT)
    const knowledgeIndex: ProjectKnowledgeIndex = {
      schema_version: "1.0.0",
      extractor_version: EXTRACTOR_VERSION,
      project_root: workspaceRoot,
      source_documents: [],
      topics: [],
      snippets: [],
      tables: [],
      section_protocol_models: [],
      packet_model_candidates: [],
      references: [],
      warnings: [],
      updated_at: new Date().toISOString(),
    }

    const step = buildGeneratedStep({
      step: {
        stepIndex: 1,
        keywordName: "\u53d1\u9001CANA\u6570\u636e_\u6570\u636e\u6587\u4ef6",
        stepDescription: "\u53d1\u9001\u901f\u53d8\u9065\u6d4b\u8f6e\u8be2\u63a7\u5236\u5e8f\u5217",
      },
      caseContext: {
        caseId: "TC-ARG-001",
        testPurpose: "\u53c2\u6570\u8d28\u91cf\u6821\u9a8c",
        requirementIds: [],
        steps: [],
      },
      keywordDef: {
        keywordName: "\u53d1\u9001CANA\u6570\u636e_\u6570\u636e\u6587\u4ef6",
        txtPath: "",
        jsonPath: "",
        arguments: [
          { name: "${time}", comments: "\u6267\u884c\u65f6\u95f4" },
          { name: "${para2}", comments: "\u6570\u636e\u6587\u4ef6" },
        ],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex,
      dataFileIndex: index,
      docsContext: EMPTY_DOCS_CONTEXT,
    })

    expect(step.argument_quality?.status).toBe("failed")
    expect(step.argument_quality?.expected_argument_count).toBe(2)
    expect(step.argument_quality?.actual_argument_count).toBe(1)
    expect(step.argument_quality?.issues.some((issue) => issue.type === "missing_argument" && issue.argument_name === "${time}")).toBe(true)
    expect(step.generated_data_files[0].file_path).toContain(`${INPUT_DATA}\\\\${INPUT_FLOW}`)
  })

  test("writes argument retry context for failed case parameter quality", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-argument-retry-${Date.now()}`)
    const matrixDataDir = join(workspaceRoot, ".matrix", "data")
    const keywordDir = join(matrixDataDir, "DTPProject", "\u7ec4\u5408\u5173\u952e\u5b57")
    mkdirSync(keywordDir, { recursive: true })
    writeFileSync(join(matrixDataDir, "test-cases-todo.txt"), "TC-ARG-RETRY-001\n", "utf-8")
    writeFileSync(
      join(matrixDataDir, "confirmation-tests.json"),
      `${JSON.stringify({
        test_cases: [
          {
            case_id: "TC-ARG-RETRY-001",
            translate_status: "success",
            test_purpose: "\u53c2\u6570\u4fee\u590d\u4e0a\u4e0b\u6587",
            test_step: [
              {
                key_name: "\u53d1\u9001CANA\u6570\u636e_\u6570\u636e\u6587\u4ef6",
                step_desc: "\u53d1\u9001\u901f\u53d8\u9065\u6d4b\u8f6e\u8be2\u63a7\u5236\u5e8f\u5217",
              },
            ],
          },
        ],
      }, null, 2)}\n`,
      "utf-8",
    )
    writeFileSync(
      join(keywordDir, "Protocol.json"),
      `${JSON.stringify({
        Name: "\u53d1\u9001CANA\u6570\u636e_\u6570\u636e\u6587\u4ef6",
        Arguments: [
          { Name: "${time}", Comments: "\u6267\u884c\u65f6\u95f4" },
          { Name: "${para2}", Comments: "\u6570\u636e\u6587\u4ef6" },
        ],
      }, null, 2)}\n`,
      "utf-8",
    )
    writeFileSync(
      join(keywordDir, "Protocol.txt"),
      "\u53d1\u9001CANA\u6570\u636e_\u6570\u636e\u6587\u4ef6\n    [Arguments]    ${time}    ${para2}\n",
      "utf-8",
    )

    const generated = await runDtpCaseDataInstantiation(workspaceRoot, EMPTY_DOCS_CONTEXT)

    const retryContext = JSON.parse(readFileSync(resolveDefaultPaths(workspaceRoot).generatedArgumentRetryContextFile, "utf-8"))
    expect(generated.cases[0].translate_status).toBe("success")
    expect(retryContext.status).toBe("ready")
    expect(retryContext.cases[0].case_id).toBe("TC-ARG-RETRY-001")
    expect(retryContext.cases[0].steps[0].keyword_arguments.map((argument: any) => argument.name)).toEqual(["${time}", "${para2}"])
    expect(retryContext.cases[0].steps[0].argument_quality.issues.some((issue: any) => issue.type === "missing_argument")).toBe(true)
  })

  test("expands enum and bitfield protocol definition variants deterministically", () => {
    const workspaceRoot = join(tmpdir(), `dtp-protocol-writer-variant-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    const dataFileIndex = prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT)

    const result = writeDtpProtocolDataFiles(
      paths,
      {
        schema_version: "1.0.0",
        project_root: workspaceRoot,
        knowledge_index_file: paths.projectKnowledgeIndexFile,
        source: "model",
        sections: [],
        protocols: [
          {
            protocol_id: "protocol-b12-variants",
            source_section: "3.1.1.4",
            flow_direction: "input",
            base_file_name: DATA_BLOCK,
            generation_mode: "expand_variants",
            frame: {
              source_table_id: "table-b10",
              byte_layout: ["86", "04", "23", "06", "W3", "W4", "SUM"],
              checksum: { type: "sum_low8", start: "TITLE", end: "BEFORE_SUM" },
            },
            fields: [
              {
                name: "W3",
                type: "enum",
                options: [
                  { value: "01", label: "\u4e3b\u56de\u8def" },
                  { value: "02", label: "\u5907\u56de\u8def" },
                ],
                confidence: 0.9,
              },
              {
                name: "W4",
                type: "bitfield",
                options: [
                  { value: "51", label: "\u6e29\u5ea61" },
                  { value: "52", label: "\u6e29\u5ea62" },
                ],
                confidence: 0.9,
              },
            ],
            evidence: ["\u8868 B-10", "\u8868 B-12"],
            warnings: [],
            confidence: 0.9,
            understanding_source: "model",
          },
        ],
        non_generated_tables: [],
        warnings: [],
        updated_at: new Date().toISOString(),
      },
      dataFileIndex,
    )

    const inputFlowDir = join(paths.inputDataRoot, INPUT_FLOW)
    const fileNames = readdirSync(inputFlowDir).sort()
    const mainTemp1File = join(inputFlowDir, `${DATA_BLOCK}-\u4e3b\u56de\u8def-\u6e29\u5ea61.txt`)

    expect(result.generated_files.length).toBe(4)
    expect(fileNames).toContain(`${DATA_BLOCK}-\u4e3b\u56de\u8def-\u6e29\u5ea61.txt`)
    expect(fileNames).toContain(`${DATA_BLOCK}-\u5907\u56de\u8def-\u6e29\u5ea62.txt`)
    expect(readFileSync(mainTemp1File, "utf-8").trim()).toBe("86 04 23 06 01 51 75")
    expect(result.generated_files.some((entry) => entry.field_value_plan?.some((item) => item.value_source === "bitfield-enum"))).toBe(true)
  })

  test("keeps SJA1000 PeliCAN mentions from changing business-payload protocol bytes", () => {
    const workspaceRoot = join(tmpdir(), `dtp-can-business-payload-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    const dataFileIndex = prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT)

    const result = writeDtpProtocolDataFiles(
      paths,
      {
        schema_version: "1.0.0",
        project_root: workspaceRoot,
        knowledge_index_file: paths.projectKnowledgeIndexFile,
        source: "model",
        sections: [],
        protocols: [
          {
            protocol_id: "protocol-can-business-payload",
            source_section: "CAN business packet",
            flow_direction: "input",
            base_file_name: FAST_POLL,
            generation_mode: "single_file",
            frame: {
              source_table_id: "table-can-business",
              byte_layout: ["86", "04", "10", "W0", "SUM"],
              checksum: { type: "sum_low8", start: "TITLE", end: "BEFORE_SUM" },
            },
            bus_context: {
              bus_type: "CAN",
              controller: "SJA1000",
              mode: "PeliCAN",
              frame_format: "standard",
              frame_buffer_layout: "business-payload",
              evidence: ["SJA1000 is mentioned in the hardware interface background."],
              confidence: 0.8,
              warnings: [],
            },
            fields: [{ name: "W0", type: "fixed", value: "01", confidence: 0.9 }],
            evidence: ["business packet with TITLE/W0/SUM"],
            warnings: [],
            confidence: 0.9,
            understanding_source: "model",
          },
        ],
        non_generated_tables: [],
        warnings: [],
        updated_at: new Date().toISOString(),
      },
      dataFileIndex,
    )

    const outputFile = join(paths.inputDataRoot, INPUT_FLOW, `${FAST_POLL}.txt`)

    expect(result.generated_files.length).toBe(1)
    expect(readFileSync(outputFile, "utf-8").trim()).toBe("86 04 10 01 11")
    expect(result.generated_files[0].warnings.some((warning) => warning.includes("frame_info_byte"))).toBe(false)
  })

  test("prepends explicit SJA1000 PeliCAN frame-info byte for frame-buffer layouts", () => {
    const workspaceRoot = join(tmpdir(), `dtp-can-pelican-buffer-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    const dataFileIndex = prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT)

    const result = writeDtpProtocolDataFiles(
      paths,
      {
        schema_version: "1.0.0",
        project_root: workspaceRoot,
        knowledge_index_file: paths.projectKnowledgeIndexFile,
        source: "model",
        sections: [],
        protocols: [
          {
            protocol_id: "protocol-sja1000-pelican-buffer",
            source_section: "SJA1000 frame buffer",
            flow_direction: "input",
            base_file_name: "\u6807\u51c6\u5e27\u7f13\u51b2\u533a\u793a\u4f8b",
            generation_mode: "single_file",
            frame: {
              source_table_id: "table-sja1000-buffer",
              byte_layout: ["86", "04", "01", "02"],
              checksum: { type: "none" },
            },
            bus_context: {
              bus_type: "CAN",
              controller: "SJA1000",
              mode: "PeliCAN",
              frame_format: "standard",
              frame_buffer_layout: "sja1000-pelican",
              frame_info_byte: "88",
              evidence: ["PeliCAN frame buffer includes a frame information byte."],
              confidence: 0.9,
              warnings: [],
            },
            fields: [],
            evidence: ["SJA1000 PeliCAN frame buffer"],
            warnings: [],
            confidence: 0.9,
            understanding_source: "model",
          },
        ],
        non_generated_tables: [],
        warnings: [],
        updated_at: new Date().toISOString(),
      },
      dataFileIndex,
    )

    const outputFile = join(paths.inputDataRoot, INPUT_FLOW, "\u6807\u51c6\u5e27\u7f13\u51b2\u533a\u793a\u4f8b.txt")

    expect(result.generated_files.length).toBe(1)
    expect(readFileSync(outputFile, "utf-8").trim()).toBe("88 86 04 01 02")
    expect(result.generated_files[0].warnings.some((warning) => warning.includes("frame_info_byte 88"))).toBe(true)
  })

  test("reports deterministic data quality issues for bad generated files", () => {
    const workspaceRoot = join(tmpdir(), `dtp-quality-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    const dataFileIndex = prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT)
    const definitions = {
      schema_version: "1.0.0",
      project_root: workspaceRoot,
      knowledge_index_file: paths.projectKnowledgeIndexFile,
      source: "model",
      sections: [],
      protocols: [
        {
          protocol_id: "protocol-quality",
          source_section: "3.1.1.1",
          flow_direction: "input",
          base_file_name: FAST_POLL,
          generation_mode: "single_file",
          frame: {
            source_table_id: "table-b1",
            byte_layout: ["86", "04", "10", "W0", "SUM"],
            checksum: { type: "sum_low8", start: "TITLE", end: "BEFORE_SUM" },
          },
          fields: [{ name: "W0", type: "fixed", value: "01", confidence: 0.9 }],
          evidence: ["\u8868 B-1"],
          warnings: [],
          confidence: 0.9,
          understanding_source: "model",
        },
      ],
      non_generated_tables: [],
      warnings: [],
      updated_at: new Date().toISOString(),
    } as any

    const writerResult = writeDtpProtocolDataFiles(paths, definitions, dataFileIndex)
    const preview = buildDtpProtocolWriterPreview(paths, definitions, dataFileIndex)
    const generatedEntry = dataFileIndex.entries[0]
    writeFileSync(generatedEntry.absolute_file_path!, "86 04 10 01 00\n", "utf-8")
    generatedEntry.file_path = `${INPUT_DATA}\\\\${OUTPUT_FLOW}\\\\${FAST_POLL}.txt`

    const report = buildDtpDataQualityReport(paths, definitions, preview, dataFileIndex)
    const retryContext = buildDtpProtocolRetryContext(paths, definitions, preview, report)

    expect(report.status).toBe("fail")
    expect(report.issue_counts.error).toBe(2)
    expect(report.issues.map((issue) => issue.type).sort()).toEqual(["checksum_mismatch", "invalid_file_path"])
    expect(retryContext.status).toBe("ready")
    expect(retryContext.affected_protocols[0].protocol_id).toBe("protocol-quality")
    expect(retryContext.affected_files[0].file_path).toBe(`${INPUT_DATA}\\\\${OUTPUT_FLOW}\\\\${FAST_POLL}.txt`)
    expect(retryContext.guidance.some((item) => item.includes("corrected protocol definitions"))).toBe(true)
  })

  test("cleans dirty variant captions before emitting pre-generated output-flow files", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-dirty-name-${Date.now()}`)
    const matrixDataDir = join(workspaceRoot, ".matrix", "data")
    const dtpRoot = join(matrixDataDir, "DTPProject")
    const knowledgeIndexFile = resolveDefaultPaths(workspaceRoot).projectKnowledgeIndexFile
    mkdirSync(dtpRoot, { recursive: true })
    mkdirSync(dirname(knowledgeIndexFile), { recursive: true })

    writeFileSync(
      knowledgeIndexFile,
      `${JSON.stringify({
        schema_version: "1.0.0",
        extractor_version: EXTRACTOR_VERSION,
        project_root: workspaceRoot,
        source_documents: [],
        topics: [],
        snippets: [],
        tables: [
          {
            id: "doc-3-table-1",
            source_document_id: "doc-3",
            caption: "\u8f93\u51fa\u6d41\u7a7a\u95f4\u7ffb\u8bd1\u62a5\u6587\u5b57\u6bb5\u914d\u7f6e",
            aliases: [],
            topic: "packet_structure",
            rows: [
              ["\u5e8f\u53f7", "\u4ef2\u88c1\u573a", "\u63a7\u5236\u573a", "TITLE", "W0", "W1", "W2", "SUM"],
              ["1.", "86H", "04H", "T10H", "W0", "W1", "W2", "SUM"],
            ],
            confidence: 0.9,
            warnings: [],
          },
          {
            id: "doc-3-table-2",
            source_document_id: "doc-3",
            caption: DIRTY_OUTPUT_NAME.replace(/\.txt$/i, ""),
            aliases: [],
            topic: "packet_structure",
            rows: [
              ["\u5b57\u6bb5", "\u8bf4\u660e", "\u53d6\u503c"],
              ["W0", "\u56fa\u5b9a\u503c", "11H"],
              ["W1", "\u56fa\u5b9a\u503c", "22H"],
              ["W2", "\u56fa\u5b9a\u503c", "33H"],
            ],
            confidence: 0.9,
            warnings: [],
          },
        ],
        section_protocol_models: [],
        packet_model_candidates: [],
        references: [],
        warnings: [],
        updated_at: new Date().toISOString(),
      }, null, 2)}\n`,
      "utf-8",
    )

    const result = await runDtpProjectDataFilesGeneration(
      workspaceRoot,
      {
        backgroundDocs: [],
        hardwareDocs: [],
        protocolDocs: [],
        conventionDocs: [],
        packetStructureDocs: [],
        formatRuleDocs: [],
        requirementDocs: [],
      },
      {
        analyzeSectionProtocolRelations: async (input) => {
          if (!input.tables.some((table) => table.id === "doc-3-table-1")) return null
          return [
            {
              frame_table_id: "doc-3-table-1",
              generation_mode: "frame_file",
              preferred_name: "\u8f93\u51fa\u6d41\u5217\u8868",
              flow_direction: "output",
              source_section: "3.1.1",
              source_flow_heading: OUTPUT_FLOW,
              should_generate_frame_table_file: true,
              checksum_rule: "SUM = low8(byte-sum(TITLE + W0 + W1 + ...))",
              confidence: 0.9,
              reasoning: ["test fixture"],
            },
          ]
        },
      },
      { knowledgeMode: "offline" },
    )

    const inputDataDir = join(dtpRoot, "V1", INPUT_DATA)
    const fileNames = readdirSync(inputDataDir).filter((name) => name.endsWith(".txt")).sort()

    expect(result.generated_files.length).toBe(1)
    expect(fileNames).toEqual([CLEAN_OUTPUT_NAME])
    expect(result.generated_files[0].requested_file_name).toBe(CLEAN_OUTPUT_NAME)
    expect(result.generated_files[0].file_path).toBe(`${INPUT_DATA}\\\\${CLEAN_OUTPUT_NAME}`)
    expect(result.generated_files[0].flow_direction).toBe("output")
    expect(existsSync(result.performance_report_file)).toBe(true)
    expect(existsSync(resolveDefaultPaths(workspaceRoot).dtpModelCacheFile)).toBe(true)
    expect(existsSync(resolveDefaultPaths(workspaceRoot).tableEvidenceIndexFile)).toBe(true)

    const performanceReport = JSON.parse(readFileSync(result.performance_report_file, "utf-8"))
    expect(performanceReport.summary.generated_file_count).toBe(1)
    expect(performanceReport.stages.find((stage: { name: string }) => stage.name === "model_relation_analysis")?.details)
      .toMatchObject({ concurrency: 3, timeout_ms: 100000 })
    expect(performanceReport.stages.map((stage: { name: string }) => stage.name)).toContain("model_relation_analysis")
    const relationCall = performanceReport.section_calls.find(
      (call: { stage: string; status: string }) => call.stage === "model_relation_analysis" && call.status === "success",
    )
    expect(relationCall.payload).toMatchObject({
      raw_context_tokens: expect.any(Number),
      final_prompt_tokens: expect.any(Number),
      candidate_table_count: expect.any(Number),
      selected_table_count: expect.any(Number),
      applied_timeout_ms: 100000,
    })
    expect(
      performanceReport.section_calls.some(
        (call: { stage: string; status: string }) =>
          call.stage === "model_relation_analysis" && call.status === "success",
      ),
    ).toBe(true)
  })

  test("anchors case-step files to the complete canonical frame instead of model-truncated bytes", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-case-canonical-frame-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    mkdirSync(paths.inputDataRoot, { recursive: true })
    const dataFileIndex = prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT)
    const protocolDefinitions = createProtocolDefinitions(workspaceRoot, [
      {
        protocol_id: "telemetry-frame-1-poll",
        source_section: "1.1.1.1 遥测帧1相关数据流",
        flow_direction: "input",
        base_file_name: "遥测帧1轮询控制序列",
        generation_mode: "single_file",
        frame: {
          source_table_id: "table-telemetry-frame-1",
          byte_layout: ["8D", "04", "TITLE", "W0", "W1", "SUM"],
          checksum: { type: "sum_low8", start: "TITLE", end: "BEFORE_SUM" },
        },
        fields: [
          { name: "TITLE", type: "fixed", value: "00", options: [], confidence: 1, warnings: [] },
          { name: "W0", type: "fixed", value: "10", options: [], confidence: 1, warnings: [] },
          { name: "W1", type: "fixed", value: "01", options: [], confidence: 1, warnings: [] },
        ],
        evidence: ["test fixture"],
        warnings: [],
        confidence: 1,
        understanding_source: "heuristic-fallback",
      },
    ])

    const generated = await buildGeneratedStepWithPlanning(
      {
        step: {
          stepIndex: 1,
          keywordName: "发送CANBTXT数据",
          stepDescription: "第1.0秒,通过CANB总线发送正确的遥测帧1轮询控制序列,TITLE=00H",
          expectedResult: "系统正常返回遥测参数",
          timeValue: 1,
        },
        caseContext: {
          caseId: "TC-JK-003",
          testPurpose: "验证TITLE异常处理",
          correspondFunId: "TR-JK-002",
          requirementIds: ["TR-JK-002"],
          steps: [],
        },
        keywordDef: {
          keywordName: "发送CANBTXT数据",
          txtPath: "",
          jsonPath: "",
          arguments: [
            { name: "${time}", comments: "执行时间" },
            { name: "${para1}", comments: "参数1：ID:0~255" },
            { name: "${para2}", comments: "参数2：数据包名称。" },
            { name: "${para3}", comments: "参数3：循环时间，单位秒" },
          ],
        },
        inputDataRoot: paths.inputDataRoot,
        workspaceRoot,
        knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot),
        dataFileIndex,
        docsContext: EMPTY_DOCS_CONTEXT,
        protocolDefinitions,
      },
      {
        planCaseStepData: async () => ({
          protocol_name: "CAN-Telemetry-Frame1-Poll",
          flow_direction: "input",
          base_bytes: [["00", "10", "01", "11"]],
          variant_type: "correct",
          mutations: [],
          checksum_policy: "preserve",
          argument_values: { "${para1}": 141, "${para3}": 0 },
          evidence_ids: ["TR-JK-002:input-flow:13"],
          confidence: 0.9,
          warnings: [],
        }),
      },
    )

    expect(generated.data_generation_plan?.protocol_name).toBe("遥测帧1轮询控制序列")
    expect(generated.data_generation_plan?.variant_type).toBe("correct")
    expect(generated.data_generation_plan?.checksum_policy).toBe("recalculate_correctly")
    expect(generated.generated_data_files[0].requested_file_name).toBe("S01-遥测帧1轮询控制序列-正常.txt")
    expect(generated.resolved_arguments.find((argument) => argument.name === "${para2}")).toMatchObject({
      semantic: "file_path",
      source: "generated-data-file",
    })
    expect(generated.resolved_arguments.find((argument) => argument.name === "${para2}")?.value).not.toBe("TODO")
    expect(generated.argument_quality?.status).toBe("pass")
    const outputPath = join(
      paths.inputDataRoot,
      INPUT_FLOW,
      "用例生成",
      "TC-JK-003",
      "S01-遥测帧1轮询控制序列-正常.txt",
    )
    expect(readFileSync(outputPath, "utf-8").trim()).toBe("8D 04 00 10 01 11")
    expect(generated.data_quality?.status).toBe("pass")
  })

  test("keeps explicit protocol-name arguments out of TXT file materialization", () => {
    const workspaceRoot = join(tmpdir(), `dtp-protocol-name-argument-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    mkdirSync(paths.inputDataRoot, { recursive: true })

    const generated = buildGeneratedStep({
      step: {
        stepIndex: 1,
        keywordName: "发送自定义TXT数据",
        stepDescription: "第1.0秒发送遥测协议",
        timeValue: 1,
      },
      caseContext: {
        caseId: "TC-PROTOCOL-NAME-001",
        requirementIds: [],
        steps: [],
      },
      keywordDef: {
        keywordName: "发送自定义TXT数据",
        txtPath: "",
        jsonPath: "",
        arguments: [
          { name: "${time}", comments: "执行时间" },
          { name: "${para2}", comments: "参数2：数据协议名称" },
        ],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot),
      dataFileIndex: prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT),
      docsContext: EMPTY_DOCS_CONTEXT,
    })

    expect(generated.generated_data_files).toEqual([])
    expect(generated.resolved_arguments.find((argument) => argument.name === "${para2}")?.semantic).toBe("protocol_name")
    expect(generated.argument_quality?.issues.some((issue) => issue.type === "unresolved_file_argument")).toBe(false)
  })

  test("uses an explicit payload length to disambiguate same-name canonical protocols without a frame-count phrase", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-case-protocol-length-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    mkdirSync(paths.inputDataRoot, { recursive: true })
    const dataFileIndex = prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT)
    const genericBasePath = join(paths.inputDataRoot, INPUT_FLOW, "\u9065\u63a7\u6307\u4ee4.txt")
    mkdirSync(dirname(genericBasePath), { recursive: true })
    writeFileSync(genericBasePath, "4D 28 00 0A 40 01 0D 00 06 00\n4D 27 01 00 00 00 00 00 54\n", "utf-8")
    dataFileIndex.entries.push({
      id: "generic-remote-command",
      protocol_name: "\u9065\u63a7\u6307\u4ee4",
      requested_file_name: "\u9065\u63a7\u6307\u4ee4.txt",
      file_path: `${INPUT_DATA}\\${INPUT_FLOW}\\\u9065\u63a7\u6307\u4ee4.txt`,
      absolute_file_path: genericBasePath,
      source: "pre-generated",
      source_documents: [],
      generation_basis: ["test fixture"],
      flow_direction: "input",
      confidence: 1,
      state: "validated",
      warnings: [],
    })
    const frame = (frameId: string, sequence: number, bytes: string[]) => ({
      frame_id: frameId,
      sequence,
      source_table_id: `${frameId}-table`,
      byte_layout: bytes,
      field_layout: [],
    })
    const protocolDefinitions = createProtocolDefinitions(workspaceRoot, [
      {
        protocol_id: "remote-command-10-byte",
        source_section: "3.1.1.5 \u53d1\u5411\u76f8\u673a\u7ba1\u7406\u63a7\u5236\u5668\u957f\u5ea610\u5b57\u8282\u7684\u9065\u63a7\u6307\u4ee4",
        flow_direction: "input",
        base_file_name: "\u9065\u63a7\u6307\u4ee4",
        generation_mode: "single_file",
        frames: [
          frame("10-byte-frame-1", 1, ["4D", "28", "00", "0A", "40", "01", "0D", "00", "06", "00"]),
          frame("10-byte-frame-2", 2, ["4D", "27", "01", "00", "00", "00", "00", "00", "54"]),
        ],
        fields: [],
        evidence: ["10-byte fixture"],
        warnings: [],
        confidence: 1,
        understanding_source: "model",
      },
      {
        protocol_id: "remote-command-15-byte",
        source_section: "3.1.1.5 \u53d1\u5411\u76f8\u673a\u7ba1\u7406\u63a7\u5236\u5668\u957f\u5ea615\u5b57\u8282\u7684\u9065\u63a7\u6307\u4ee4",
        flow_direction: "input",
        base_file_name: "\u9065\u63a7\u6307\u4ee4",
        generation_mode: "single_file",
        frames: [
          frame("15-byte-frame-1", 1, ["4D", "28", "00", "0F", "40", "01", "0D", "00", "0B", "00"]),
          frame("15-byte-frame-2", 2, ["4D", "28", "01", "00", "00", "00", "00", "00", "00", "00"]),
          frame("15-byte-frame-3", 3, ["4D", "25", "02", "00", "00", "00", "59"]),
        ],
        fields: [],
        evidence: ["15-byte fixture"],
        warnings: [],
        confidence: 1,
        understanding_source: "model",
      },
    ])

    const generated = await buildGeneratedStepWithPlanning({
      step: {
        stepIndex: 1,
        keywordName: "\u53d1\u9001CANATXT\u6570\u636e",
        stepDescription: "\u7b2c1.0\u79d2,\u901a\u8fc7CANA\u603b\u7ebf\u53d1\u9001\u6b63\u786e\u768415\u5b57\u8282\u9065\u63a7\u6307\u4ee4\uff08\u9996\u5e27\uff09",
        timeValue: 1,
      },
      caseContext: {
        caseId: "TC-JK-005",
        testPurpose: "\u9a8c\u8bc1\u9065\u63a7\u6307\u4ee4\u6b63\u5e38\u63a5\u6536",
        requirementIds: ["TR-JK-001"],
        translateStatus: "success",
        steps: [],
      },
      keywordDef: {
        keywordName: "\u53d1\u9001CANATXT\u6570\u636e",
        txtPath: "",
        jsonPath: "",
        arguments: [{ name: "${para2}", comments: "\u6570\u636e\u6587\u4ef6" }],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot),
      dataFileIndex,
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions,
    }, {
      planCaseStepData: async () => ({
        protocol_name: "\u9065\u63a7\u6307\u4ee4",
        flow_direction: "input",
        base_bytes: [
          ["4D", "28", "00", "0A", "40", "01", "0D", "00", "06", "00"],
          ["4D", "27", "01", "00", "00", "00", "00", "00", "54"],
        ],
        variant_type: "correct",
        mutations: [],
        sequence_operations: [],
        checksum_policy: "none",
        argument_values: {},
        evidence_ids: [],
        confidence: 0.9,
        warnings: [],
      }),
    })

    expect(generated.data_generation_plan).toMatchObject({
      protocol_id: "remote-command-15-byte",
      protocol_name: "15\u5b57\u8282\u9065\u63a7\u6307\u4ee4",
      payload_length_bytes: 15,
    })
    expect(generated.generated_data_files[0].requested_file_name).toBe("S01-15\u5b57\u8282\u9065\u63a7\u6307\u4ee4-\u6b63\u5e38.txt")
    const outputPath = join(
      paths.inputDataRoot,
      INPUT_FLOW,
      "\u7528\u4f8b\u751f\u6210",
      "TC-JK-005",
      "S01-15\u5b57\u8282\u9065\u63a7\u6307\u4ee4-\u6b63\u5e38.txt",
    )
    expect(readFileSync(outputPath, "utf-8").trim().split(/\r?\n/)).toEqual([
      "4D 28 00 0F 40 01 0D 00 0B 00",
      "4D 28 01 00 00 00 00 00 00 00",
      "4D 25 02 00 00 00 59",
    ])
    expect(generated.data_quality?.status).toBe("pass")

    const ambiguous = await buildGeneratedStepWithPlanning({
      step: {
        stepIndex: 2,
        keywordName: "\u53d1\u9001CANATXT\u6570\u636e",
        stepDescription: "\u7b2c2.0\u79d2,\u901a\u8fc7CANA\u603b\u7ebf\u53d1\u9001\u6b63\u786e\u7684\u9065\u63a7\u6307\u4ee4",
        timeValue: 2,
      },
      caseContext: {
        caseId: "TC-JK-005",
        testPurpose: "\u9a8c\u8bc1\u9065\u63a7\u6307\u4ee4\u6b63\u5e38\u63a5\u6536",
        requirementIds: ["TR-JK-001"],
        translateStatus: "success",
        steps: [],
      },
      keywordDef: {
        keywordName: "\u53d1\u9001CANATXT\u6570\u636e",
        txtPath: "",
        jsonPath: "",
        arguments: [{ name: "${para2}", comments: "\u6570\u636e\u6587\u4ef6" }],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot),
      dataFileIndex,
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions,
    }, {
      planCaseStepData: async () => ({
        protocol_name: "\u9065\u63a7\u6307\u4ee4",
        flow_direction: "input",
        base_bytes: [["4D", "28", "00", "0A", "40", "01", "0D", "00", "06", "00"]],
        variant_type: "correct",
        mutations: [],
        sequence_operations: [],
        checksum_policy: "none",
        argument_values: {},
        evidence_ids: [],
        confidence: 0.9,
        warnings: [],
      }),
    })
    expect(ambiguous.data_generation_plan?.protocol_id).toBe("remote-command-10-byte")
    expect(ambiguous.data_quality?.issues.some((issue) => issue.type === "protocol_ambiguous")).toBe(false)
  })

  test("keeps deterministic TC-JK-004 input protocol selection without consulting the model", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-case-flow-identity-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    mkdirSync(paths.inputDataRoot, { recursive: true })
    const dataFileIndex = prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT)
    const sharedSection = "3.1.1.5 \u957f\u5ea610\u5b57\u8282\u7684\u9065\u63a7\u6307\u4ee4\u53ca\u5e94\u7b54\u683c\u5f0f"
    const frame = (frameId: string, sequence: number, bytes: string[]) => ({
      frame_id: frameId,
      sequence,
      source_table_id: `${frameId}-table`,
      byte_layout: bytes,
      field_layout: [
        { name: "ARBITRATION", role: "arbitration" as const, byte_offset: 0, byte_length: 1 },
        { name: "CONTROL", role: "control" as const, byte_offset: 1, byte_length: 1 },
        { name: "RTR", role: "control" as const, byte_offset: 1, byte_length: 1, bit_offset: 4, bit_length: 1 },
        { name: "DLC", role: "length" as const, byte_offset: 1, byte_length: 1, bit_offset: 0, bit_length: 4 },
      ],
    })
    const protocolDefinitions = createProtocolDefinitions(workspaceRoot, [
      {
        protocol_id: "section-protocol-9-1",
        source_section: sharedSection,
        flow_direction: "input",
        base_file_name: "\u9065\u63a7\u6307\u4ee4",
        generation_mode: "single_file",
        frames: [
          frame("remote-command-frame-1", 1, ["4D", "28", "00", "0A", "40", "01", "0D", "00", "06", "00"]),
          frame("remote-command-frame-2", 2, ["4D", "27", "01", "00", "00", "00", "00", "00", "54"]),
        ],
        bus_context: {
          bus_type: "CAN",
          controller: "SJA1000T",
          controller_family: "SJA1000",
          mode: "PeliCAN",
          frame_format: "standard",
          frame_buffer_layout: "business-payload",
          frame_information: { apply_to_case_data: true, strategy: "derive_from_ff_rtr_dlc" },
        },
        fields: [],
        evidence: ["input protocol fixture"],
        warnings: [],
        confidence: 1,
        understanding_source: "model",
      },
      {
        protocol_id: "section-protocol-10-1",
        source_section: sharedSection,
        flow_direction: "output",
        base_file_name: "\u9065\u63a7\u6307\u4ee4\u5e94\u7b54\u63a7\u5236\u5e8f\u5217",
        generation_mode: "single_file",
        frames: [frame("remote-command-response", 1, ["4D", "03", "00", "0A", "14"])],
        fields: [],
        evidence: ["output protocol fixture"],
        warnings: [],
        confidence: 1,
        understanding_source: "model",
      },
    ])

    let planningCalls = 0
    const generated = await buildGeneratedStepWithPlanning({
      step: {
        stepIndex: 8,
        keywordName: "\u53d1\u9001CANB\u6570\u636e_\u6570\u636e\u6587\u4ef6",
        stepDescription: "\u7b2c8.0\u79d2,\u901a\u8fc7CANB\u603b\u7ebf\u53d1\u9001\u6b63\u786e\u768410\u5b57\u8282\u9065\u63a7\u6307\u4ee4\uff08\u5c3e\u5e27,\u51712\u5e27\u53d1\u9001\uff09",
        timeValue: 8,
      },
      caseContext: {
        caseId: "TC-JK-004",
        testPurpose: "\u9a8c\u8bc1CANB\u9065\u63a7\u6307\u4ee4\u63a5\u6536",
        requirementIds: ["TR-JK-001"],
        translateStatus: "success",
        steps: [],
      },
      keywordDef: {
        keywordName: "\u53d1\u9001CANB\u6570\u636e_\u6570\u636e\u6587\u4ef6",
        txtPath: "",
        jsonPath: "",
        arguments: [
          { name: "${para2}", comments: "\u6570\u636e\u6587\u4ef6" },
          { name: "${para3}", comments: "\u5faa\u73af\u65f6\u95f4" },
        ],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot),
      dataFileIndex,
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions,
    }, {
      planCaseStepData: async () => {
        planningCalls += 1
        return {
          protocol_id: "section-protocol-10-1",
          protocol_name: "\u9065\u63a7\u6307\u4ee4\u5e94\u7b54\u63a7\u5236\u5e8f\u5217",
          payload_length_bytes: 10,
          flow_direction: "output",
          base_bytes: [["4D", "28", "00", "01", "0D", "01", "06", "06"], ["4D", "27", "01"]],
          variant_type: "correct",
          mutations: [],
          sequence_operations: [],
          checksum_policy: "none",
          argument_values: {},
          evidence_ids: [],
          confidence: 0.9,
          warnings: [],
        }
      },
    })

    expect(generated.data_generation_plan).toMatchObject({
      protocol_id: "section-protocol-9-1",
      protocol_name: "\u9065\u63a7\u6307\u4ee4",
      payload_length_bytes: 10,
      flow_direction: "input",
    })
    const generatedFile = generated.generated_data_files[0]
    const outputPath = join(paths.inputDataRoot, ...generatedFile.file_path.split("\\\\").slice(1))
    expect(readFileSync(outputPath, "utf-8").trim().split(/\r?\n/)).toEqual([
      "08 4D 28 00 0A 40 01 0D 00 06 00",
      "07 4D 27 01 00 00 00 00 00 54",
    ])
    expect(planningCalls).toBe(0)
    expect(generated.data_generation_plan).toMatchObject({
      selection_source: "step_desc",
      deterministic_generation: true,
      model_used: false,
    })
    expect(generated.data_quality?.status).not.toBe("failed")
  })

  test("keeps deterministic zero fallback warnings from triggering case-step model planning", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-case-no-model-for-zero-fallback-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    mkdirSync(paths.inputDataRoot, { recursive: true })
    const dataFileIndex = prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT)
    const protocolDefinitions = createProtocolDefinitions(workspaceRoot, [
      {
        protocol_id: "dynamic-telemetry-frame",
        source_section: "3.1.1.1 telemetry",
        flow_direction: "input",
        base_file_name: "\u9065\u6d4b\u5e271\u8f6e\u8be2\u63a7\u5236\u5e8f\u5217",
        generation_mode: "single_file",
        frame: {
          source_table_id: "table-dynamic-telemetry",
          byte_layout: ["8D", "06", "TITLE", "W0", "W1", "W2", "SUM"],
          checksum: { type: "sum_low8", start: "TITLE", end: "BEFORE_SUM" },
        },
        fields: [
          { name: "TITLE", type: "fixed", value: "00", options: [], confidence: 1, warnings: [] },
        ],
        evidence: ["test fixture"],
        warnings: [],
        confidence: 1,
        understanding_source: "model",
      },
    ])
    let planningCalls = 0

    const generated = await buildGeneratedStepWithPlanning({
      step: {
        stepIndex: 1,
        keywordName: "SendCANDataFile",
        stepDescription: "\u7b2c1.0\u79d2,\u901a\u8fc7CANA\u603b\u7ebf\u53d1\u9001\u6b63\u786e\u7684\u9065\u6d4b\u5e271\u8f6e\u8be2\u63a7\u5236\u5e8f\u5217",
        timeValue: 1,
      },
      caseContext: {
        caseId: "TC-NO-MODEL-ZERO",
        requirementIds: ["TR-JK-001"],
        translateStatus: "success",
        steps: [],
      },
      keywordDef: {
        keywordName: "SendCANDataFile",
        txtPath: "",
        jsonPath: "",
        arguments: [
          { name: "${para2}", comments: "\u6570\u636e\u6587\u4ef6" },
          { name: "${para3}", comments: "\u5faa\u73af\u5468\u671f" },
          { name: "${custom_required}", comments: "\u5fc5\u987b\u7531\u6a21\u578b\u8865\u5145\u7684\u81ea\u5b9a\u4e49\u53c2\u6570" },
        ],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot),
      dataFileIndex,
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions,
    }, {
      planCaseStepData: async () => {
        planningCalls += 1
        return null
      },
    })

    expect(planningCalls).toBe(0)
    expect(generated.data_generation_plan).toMatchObject({
      protocol_id: "dynamic-telemetry-frame",
      deterministic_generation: true,
      model_used: false,
    })
    expect(generated.data_quality?.status).toBe("warning")
    const fallbackIssues = generated.data_quality?.issues.filter((issue) => issue.type === "unresolved_field_zero_fallback") ?? []
    expect(fallbackIssues).toHaveLength(1)
    expect(fallbackIssues[0]?.message).toContain("W0-W2")
    expect(generated.data_generation_plan?.model_skipped_reasons).toContain("only_non_target_zero_fallbacks")
  })

  test("compacts supplemental case-step model input to project evidence only", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-case-compact-model-input-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    mkdirSync(paths.inputDataRoot, { recursive: true })
    const longFlow = "\u9065\u6d4b\u5e271\u8f6e\u8be2\u63a7\u5236\u5e8f\u5217 TITLE W0 SUM ".repeat(500)
    let observedInput: unknown

    await buildGeneratedStepWithPlanning({
      step: {
        stepIndex: 1,
        keywordName: "SendCANDataFile",
        stepDescription: "\u7b2c1.0\u79d2,\u901a\u8fc7CANA\u603b\u7ebf\u53d1\u9001\u6b63\u786e\u7684\u672a\u77e5\u534f\u8bae",
        timeValue: 1,
      },
      caseContext: {
        caseId: "TC-COMPACT-MODEL",
        correspondFunId: "TR-JK-001",
        requirementIds: ["TR-JK-001"],
        translateStatus: "success",
        steps: [],
      },
      keywordDef: {
        keywordName: "SendCANDataFile",
        txtPath: "",
        jsonPath: "",
        arguments: [
          { name: "${para2}", comments: "\u6570\u636e\u6587\u4ef6" },
          { name: "${para3}", comments: "\u5faa\u73af\u5468\u671f" },
        ],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex: {
        ...createEmptyKnowledgeIndex(workspaceRoot),
        snippets: [{
          id: "long-project-evidence",
          source_document_id: "doc-1",
          topic: "data_protocol",
          text: longFlow,
          confidence: 1,
        }],
      },
      dataFileIndex: prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT),
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions: createProtocolDefinitions(workspaceRoot, []),
    }, {
      planCaseStepData: async (input) => {
        observedInput = input
        return {
          protocol_name: "unknown",
          flow_direction: "input",
          variant_type: "unknown",
          mutations: [],
          sequence_operations: [],
          checksum_policy: "none",
          argument_values: {},
          evidence_ids: [],
          confidence: 0,
          warnings: ["test fallback"],
        }
      },
    })

    const input = observedInput as Record<string, any>
    expect(input).not.toHaveProperty("requirement_context")
    expect(input).not.toHaveProperty("selected_evidence")
    expect(input).not.toHaveProperty("context_usage")
    expect(JSON.stringify(input.project_value_evidence).length).toBeLessThan(5_000)
  })

  test("publishes only the final case-step retry and removes stale pending files", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-case-staged-retry-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    mkdirSync(paths.inputDataRoot, { recursive: true })
    const dataFileIndex = prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT)
    const caseDir = join(paths.inputDataRoot, INPUT_FLOW, "\u7528\u4f8b\u751f\u6210", "TC-JK-004")
    mkdirSync(caseDir, { recursive: true })
    writeFileSync(join(caseDir, "S08-old-\u5f85\u786e\u8ba4.txt"), "DE AD\n", "utf-8")
    const protocolDefinitions = createProtocolDefinitions(workspaceRoot, [{
      protocol_id: "remote-command",
      source_section: "3 \u6570\u636e\u53ca\u63a5\u53e3\u9700\u6c42",
      flow_direction: "input",
      base_file_name: "\u9065\u63a7\u6307\u4ee4",
      generation_mode: "single_file",
      frames: [{
        frame_id: "remote-command-frame",
        sequence: 1,
        source_table_id: "remote-command-table",
        byte_layout: ["4D", "04", "00", "10", "01", "15"],
        field_layout: [{
          name: "COMMAND",
          role: "command",
          byte_offset: 0,
          byte_length: 1,
          default_value: "4D",
          value_rule: { operation: "add_low8", base: "4D", variable: "command_code" },
          source_text: "command code is resolved by supplemental planning when needed",
        }],
      }],
      fields: [],
      evidence: ["retry fixture"],
      warnings: [],
      confidence: 1,
      understanding_source: "model",
    }])
    let retryObservedPublishedFiles: string[] | undefined

    const generated = await buildGeneratedStepWithPlanning({
      step: {
        stepIndex: 8,
        keywordName: "\u53d1\u9001CANB\u6570\u636e_\u6570\u636e\u6587\u4ef6",
        stepDescription: "\u7b2c8.0\u79d2,\u901a\u8fc7CANB\u603b\u7ebf\u53d1\u9001W99\u9519\u8bef\u7684\u9065\u63a7\u6307\u4ee4",
        timeValue: 8,
      },
      caseContext: {
        caseId: "TC-JK-004",
        testPurpose: "\u9a8c\u8bc1\u6570\u636e\u63a5\u6536",
        requirementIds: ["TR-JK-001"],
        translateStatus: "success",
        steps: [],
      },
      keywordDef: {
        keywordName: "\u53d1\u9001CANB\u6570\u636e_\u6570\u636e\u6587\u4ef6",
        txtPath: "",
        jsonPath: "",
        arguments: [
          { name: "${para2}", comments: "\u6570\u636e\u6587\u4ef6" },
          { name: "${para3}", comments: "\u5faa\u73af\u5468\u671f" },
          { name: "${para4}", comments: "\u5fc5\u987b\u7531\u6a21\u578b\u4fee\u590d\u7684\u4e1a\u52a1\u53c2\u6570" },
        ],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot),
      dataFileIndex,
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions,
    }, {
      planCaseStepData: async () => ({
        protocol_id: "remote-command",
        protocol_name: "\u9065\u63a7\u6307\u4ee4",
        flow_direction: "input",
        base_bytes: [["DE", "AD"]],
        variant_type: "field_error",
        mutations: [{ field: "W99", value: "FF", operation: "make_invalid" }],
        sequence_operations: [],
        checksum_policy: "none",
        argument_values: {},
        evidence_ids: [],
        confidence: 0.2,
        warnings: [],
      }),
      reviseCaseStepDataPlan: async () => {
        retryObservedPublishedFiles = existsSync(caseDir)
          ? readdirSync(caseDir).filter((name) => name.startsWith("S08-"))
          : []
        return {
          protocol_id: "remote-command",
          protocol_name: "\u9065\u63a7\u6307\u4ee4",
          flow_direction: "input",
          base_bytes: [["DE", "AD"]],
          variant_type: "correct",
          mutations: [],
          sequence_operations: [],
          checksum_policy: "none",
          argument_values: { "${para2}": "fixed-by-retry.txt", "${para3}": "0", "${para4}": "1" },
          evidence_ids: [],
          confidence: 0.9,
          warnings: [],
        }
      },
    })

    expect(retryObservedPublishedFiles).toEqual([])
    const publishedFiles = readdirSync(caseDir).filter((name) => name.startsWith("S08-"))
    expect(publishedFiles).toEqual([generated.generated_data_files[0].requested_file_name])
    expect(publishedFiles[0]).not.toContain("\u5f85\u786e\u8ba4")
    expect(readFileSync(join(caseDir, publishedFiles[0]), "utf-8").trim()).toBe("4D 04 00 10 01 15")
    expect(existsSync(join(paths.inputDataRoot, ".case-work", "TC-JK-004", "S08"))).toBe(false)
  })

  test("prefers protocol-local payload length over a conflicting shared section title", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-case-shared-section-length-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    mkdirSync(paths.inputDataRoot, { recursive: true })
    const dataFileIndex = prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT)
    const sharedSourceSection = "3.1.1.6 长度249字节的上行数据块及应答格式说明"
    const protocolDefinitions = createProtocolDefinitions(workspaceRoot, [
      {
        protocol_id: "uplink-data-249-byte",
        source_section: sharedSourceSection,
        flow_direction: "input",
        base_file_name: "249字节上行数据块",
        generation_mode: "single_file",
        frames: [{
          frame_id: "uplink-249-frame",
          sequence: 1,
          source_table_id: "table-uplink-249",
          byte_layout: ["65", "08", "00", "F9", "00"],
          field_layout: [],
        }],
        fields: [],
        evidence: [],
        warnings: [],
        confidence: 1,
        understanding_source: "model",
      },
      {
        protocol_id: "uplink-data-72-byte",
        source_section: sharedSourceSection,
        flow_direction: "input",
        base_file_name: "72字节上行数据块",
        generation_mode: "single_file",
        frames: [{
          frame_id: "uplink-72-frame",
          sequence: 1,
          source_table_id: "table-uplink-72",
          byte_layout: ["65", "08", "00", "48", "00"],
          field_layout: [],
        }],
        fields: [],
        evidence: [],
        warnings: [],
        confidence: 1,
        understanding_source: "model",
      },
    ])
    const keywordDef = {
      keywordName: "发送CANATXT数据",
      txtPath: "",
      jsonPath: "",
      arguments: [{ name: "${para2}", comments: "数据文件" }],
    }
    const generate = (stepIndex: number, payloadLength: number) => buildGeneratedStepWithPlanning({
      step: {
        stepIndex,
        keywordName: keywordDef.keywordName,
        stepDescription: `第${stepIndex}.0秒,通过CANA总线发送正确的${payloadLength}字节上行数据块`,
        timeValue: stepIndex,
      },
      caseContext: {
        caseId: "TC-JK-UPLINK-LENGTH",
        testPurpose: "验证上行数据块长度选择",
        requirementIds: ["TR-JK-UPLINK"],
        translateStatus: "success",
        steps: [],
      },
      keywordDef,
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot),
      dataFileIndex,
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions,
    }, {
      planCaseStepData: async () => ({
        protocol_name: "上行数据块",
        flow_direction: "input",
        base_bytes: [["00"]],
        variant_type: "correct",
        mutations: [],
        sequence_operations: [],
        checksum_policy: "none",
        argument_values: {},
        evidence_ids: [],
        confidence: 0.9,
        warnings: [],
      }),
    })

    const generated72 = await generate(1, 72)
    const generated249 = await generate(2, 249)

    expect(generated72.data_generation_plan).toMatchObject({
      protocol_id: "uplink-data-72-byte",
      payload_length_bytes: 72,
    })
    expect(generated72.generated_data_files[0].requested_file_name).toContain("72字节上行数据块")
    expect(generated249.data_generation_plan).toMatchObject({
      protocol_id: "uplink-data-249-byte",
      payload_length_bytes: 249,
    })
    expect(generated249.generated_data_files[0].requested_file_name).toContain("249字节上行数据块")
  })

  test("keeps unresolved case fallbacks isolated by case and step and rejects unrelated summary tables", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-case-isolated-fallback-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    mkdirSync(paths.inputDataRoot, { recursive: true })
    const dataFileIndex = prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT)
    const knowledgeIndex = createEmptyKnowledgeIndex(workspaceRoot)
    knowledgeIndex.packet_model_candidates.push({
      id: "summary-table",
      name: "表4.3-1 接口需求项总结表",
      source_snippet_ids: [],
      fields: [],
      packet_lines: [["00", "00", "00"]],
      byte_values: [],
      confidence: 0.99,
      warnings: [],
    })
    knowledgeIndex.packet_model_candidates.push({
      id: "synthetic-placeholder",
      name: "上行数据块",
      source_snippet_ids: [],
      fields: [],
      byte_values: ["AA", "55", "00", "00"],
      confidence: 0.99,
      warnings: ["No explicit hex bytes were found; packet model uses a minimal fallback byte layout."],
    })
    knowledgeIndex.packet_model_candidates.push({
      id: "partial-field-fragment",
      name: "上行数据块",
      source_snippet_ids: [],
      fields: [{ field_name: "W0", default_value: "10" }],
      packet_lines: [["10", "10"]],
      byte_values: ["10", "10"],
      confidence: 1,
      warnings: [],
    })
    const keywordDef = {
      keywordName: "发送CANATXT数据",
      txtPath: "",
      jsonPath: "",
      arguments: [{ name: "${para2}", comments: "数据文件" }],
    }
    const caseContext = {
      caseId: "TC-JK-UNRESOLVED",
      testPurpose: "验证上行数据块错误处理",
      requirementIds: ["TR-JK-UPLINK"],
      translateStatus: "success" as const,
      steps: [],
    }
    const generate = (stepIndex: number, variant: "control_error" | "arbitration_error") => buildGeneratedStepWithPlanning({
      step: {
        stepIndex,
        keywordName: keywordDef.keywordName,
        stepDescription: variant === "control_error"
          ? `第${stepIndex}.0秒,通过CANA总线发送控制场错误的上行数据块`
          : `第${stepIndex}.0秒,通过CANA总线发送仲裁场错误的上行数据块`,
        timeValue: stepIndex,
        raw: {
          parameter: [{ name: "${para2}", value: "错误的上行数据块数据文件" }],
        },
      },
      caseContext,
      keywordDef,
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex,
      dataFileIndex,
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions: createProtocolDefinitions(workspaceRoot, []),
    }, {
      planCaseStepData: async () => ({
        protocol_name: "上行数据块",
        flow_direction: "input",
        base_bytes: [],
        variant_type: variant,
        mutations: [{
          field: variant === "control_error" ? "CONTROL" : "ARBITRATION",
          operation: "replace_with_invalid_value",
        }],
        sequence_operations: [],
        checksum_policy: "recalculate_correctly",
        argument_values: {},
        evidence_ids: [],
        confidence: 0.8,
        warnings: [],
      }),
    })

    const [control, arbitration] = await Promise.all([
      generate(1, "control_error"),
      generate(2, "arbitration_error"),
    ])
    const files = [control, arbitration].map((generated) => generated.generated_data_files[0])

    expect(files[0].file_path).not.toBe(files[1].file_path)
    expect(files.every((file) => file.file_path.includes(`用例生成\\\\${caseContext.caseId}`))).toBe(true)
    expect(files.every((file) => file.source_file_state === "case-fallback")).toBe(true)
    expect(files.every((file) => readFileSync(
      join(paths.inputDataRoot, ...file.file_path.split("\\\\").slice(1)),
      "utf-8",
    ).trim() === "00")).toBe(true)
    expect(control.data_quality).toMatchObject({ status: "failed" })
    expect(control.data_quality?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "error", type: "case_data_fallback" }),
    ]))
    expect(existsSync(join(paths.inputDataRoot, INPUT_FLOW, "错误的上行数据块数据文件.txt"))).toBe(false)
  })

  test("ignores parenthesized hex frame examples and deterministically applies a semantic W0 fault", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-case-semantic-w0-fault-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    mkdirSync(paths.inputDataRoot, { recursive: true })
    const dataFileIndex = prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT)
    const protocolDefinitions = createProtocolDefinitions(workspaceRoot, [
      {
        protocol_id: "telemetry-frame-1-poll",
        source_section: "3 数据及接口需求",
        flow_direction: "input",
        base_file_name: "遥测帧1轮询控制序列",
        generation_mode: "single_file",
        frames: [{
          frame_id: "frame-1",
          sequence: 1,
          source_table_id: "table-telemetry-frame-1",
          byte_layout: ["8D", "04", "TITLE", "W0", "W1", "SUM"],
          field_layout: [
            { name: "ARBITRATION", role: "arbitration", byte_offset: 0, byte_length: 1 },
            { name: "CONTROL", role: "control", byte_offset: 1, byte_length: 1, default_value: "04" },
            { name: "DLC", role: "length", byte_offset: 1, byte_length: 1, bit_offset: 0, bit_length: 4 },
            { name: "TITLE", role: "title", byte_offset: 2, byte_length: 1, default_value: "00" },
            { name: "W0", role: "data", byte_offset: 3, byte_length: 1, default_value: "10" },
            { name: "W1", role: "data", byte_offset: 4, byte_length: 1, default_value: "01" },
            { name: "SUM", role: "checksum", byte_offset: 5, byte_length: 1 },
          ],
          checksum: { type: "sum_low8", start: "TITLE", end: "BEFORE_SUM" },
        }],
        bus_context: {
          bus_type: "CAN",
          controller: "SJA1000T",
          controller_family: "SJA1000",
          mode: "PeliCAN",
          frame_format: "standard",
          frame_information: { apply_to_case_data: true, strategy: "derive_from_ff_rtr_dlc" },
        },
        fields: [],
        evidence: ["test fixture"],
        warnings: [],
        confidence: 1,
        understanding_source: "model",
      },
      {
        protocol_id: "memory-data-poll",
        source_section: "3 数据及接口需求",
        flow_direction: "input",
        base_file_name: "内存数据轮询控制序列",
        generation_mode: "single_file",
        frames: [{
          frame_id: "memory-frame-1",
          sequence: 1,
          source_table_id: "table-memory-data-poll",
          byte_layout: ["8D", "04", "00", "10", "61", "SUM"],
          field_layout: [
            { name: "ARBITRATION", role: "arbitration", byte_offset: 0, byte_length: 1 },
            { name: "CONTROL", role: "control", byte_offset: 1, byte_length: 1, default_value: "04" },
            { name: "TITLE", role: "title", byte_offset: 2, byte_length: 1, default_value: "00" },
            { name: "W0", role: "data", byte_offset: 3, byte_length: 1, default_value: "10" },
            { name: "W1", role: "data", byte_offset: 4, byte_length: 1, default_value: "61" },
            { name: "SUM", role: "checksum", byte_offset: 5, byte_length: 1 },
          ],
          checksum: { type: "sum_low8", start: "TITLE", end: "BEFORE_SUM" },
        }],
        fields: [],
        evidence: ["competing protocol fixture"],
        warnings: [],
        confidence: 1,
        understanding_source: "model",
      },
    ])
    let plannedStepDescription: string | undefined

    const generated = await buildGeneratedStepWithPlanning({
      step: {
        stepIndex: 10,
        keywordName: "发送CANA数据_数据文件",
        stepDescription: "第10.0秒,通过CANA总线发送W0错误的遥测帧1轮询控制序列（发送后等待响应）（8DH 04H 00H FFH 01H 0FH）",
        timeValue: 10,
      },
      caseContext: {
        caseId: "TC-JK-001",
        testPurpose: "验证遥测帧1~4轮询控制序列和内存数据轮询控制序列字段错误处理",
        requirementIds: ["TR-JK-003"],
        translateStatus: "success",
        steps: [],
      },
      keywordDef: {
        keywordName: "发送CANA数据_数据文件",
        txtPath: "",
        jsonPath: "",
        arguments: [{ name: "${para2}", comments: "数据文件" }],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot),
      dataFileIndex,
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions,
    }, {
      planCaseStepData: async (input) => {
        plannedStepDescription = input.step.step_desc
        return {
          protocol_name: "遥测帧1轮询控制序列",
          payload_length_bytes: 4,
          flow_direction: "input",
          base_bytes: [["8D", "04", "00", "FF", "01", "0F"]],
          variant_type: "correct",
          mutations: [],
          sequence_operations: [],
          checksum_policy: "preserve",
          argument_values: {},
          evidence_ids: [],
          confidence: 0.9,
          warnings: [],
        }
      },
    })

    expect(plannedStepDescription).toBeUndefined()
    expect(generated.data_generation_plan).toMatchObject({
      variant_type: "field_error",
      checksum_policy: "recalculate_correctly",
      mutations: [{ field: "W0", operation: "replace_with_invalid_value" }],
      selection_source: "step_desc",
      model_used: false,
    })
    expect(generated.data_generation_plan?.rejected_protocols).toContainEqual({
      protocol_id: "memory-data-poll",
      reason: "protocol entity conflicts with the step entity",
    })
    expect(generated.generated_data_files[0].requested_file_name).toBe("S10-遥测帧1轮询控制序列-W0异常.txt")
    const outputPath = join(
      paths.inputDataRoot,
      INPUT_FLOW,
      "用例生成",
      "TC-JK-001",
      "S10-遥测帧1轮询控制序列-W0异常.txt",
    )
    expect(readFileSync(outputPath, "utf-8").trim()).toBe("04 8D 04 00 11 01 12")
    expect(generated.data_quality?.status).toBe("pass")
  })

  test("reconciles first-frame faults, model byte indexes, and frame-sequence semantics", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-case-first-frame-arbitration-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    mkdirSync(paths.inputDataRoot, { recursive: true })
    const dataFileIndex = prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT)
    const sharedControlFields = (control: string) => [
      { name: "ARBITRATION", role: "arbitration" as const, byte_offset: 0, byte_length: 1, default_value: "4D" },
      { name: "CONTROL", role: "control" as const, byte_offset: 1, byte_length: 1, default_value: control },
      { name: "RTR", role: "control" as const, byte_offset: 1, byte_length: 1, bit_offset: 4, bit_length: 1 },
      { name: "DLC", role: "length" as const, byte_offset: 1, byte_length: 1, bit_offset: 0, bit_length: 4 },
    ]
    const protocolDefinitions = createProtocolDefinitions(workspaceRoot, [{
      protocol_id: "remote-command-10-byte",
      source_section: "3.1.1.5 发向相机管理控制器长度10字节的遥控指令",
      flow_direction: "input",
      base_file_name: "遥控指令",
      generation_mode: "single_file",
      frames: [
        {
          frame_id: "frame-1",
          sequence: 1,
          source_table_id: "remote-command-table",
          byte_layout: ["4D", "28", "00", "0A", "40", "W0", "W1", "W2", "W3", "W4"],
          field_layout: [
            ...sharedControlFields("28"),
            { name: "00", role: "fixed", byte_offset: 2, byte_length: 1, default_value: "00" },
            { name: "LENGTH", role: "length", byte_offset: 3, byte_length: 1, default_value: "0A" },
            { name: "TITLE", role: "title", byte_offset: 4, byte_length: 1, default_value: "40" },
            { name: "W0", role: "data", byte_offset: 5, byte_length: 1, source_text: "command code value from requirement evidence" },
            { name: "W1", role: "data", byte_offset: 6, byte_length: 1 },
            { name: "W2", role: "data", byte_offset: 7, byte_length: 1, default_value: "00" },
            { name: "W3", role: "data", byte_offset: 8, byte_length: 1 },
            { name: "W4", role: "data", byte_offset: 9, byte_length: 1, default_value: "00" },
          ],
          checksum: { type: "sum_low8", start: "TITLE", end: "BEFORE_SUM" },
        },
        {
          frame_id: "frame-2",
          sequence: 2,
          source_table_id: "remote-command-table",
          byte_layout: ["4D", "27", "01", "W5", "W6", "W7", "W8", "W9", "SUM"],
          field_layout: [
            ...sharedControlFields("27"),
            { name: "01", role: "fixed", byte_offset: 2, byte_length: 1, default_value: "01" },
            { name: "W5", role: "data", byte_offset: 3, byte_length: 1, default_value: "00" },
            { name: "W6", role: "data", byte_offset: 4, byte_length: 1, default_value: "00" },
            { name: "W7", role: "data", byte_offset: 5, byte_length: 1, default_value: "00" },
            { name: "W8", role: "data", byte_offset: 6, byte_length: 1, default_value: "00" },
            { name: "W9", role: "data", byte_offset: 7, byte_length: 1, default_value: "00" },
            { name: "SUM", role: "checksum", byte_offset: 8, byte_length: 1 },
          ],
          checksum: { type: "sum_low8", start: "TITLE", end: "BEFORE_SUM" },
        },
      ],
      bus_context: {
        bus_type: "CAN",
        controller: "SJA1000T",
        controller_family: "SJA1000",
        mode: "PeliCAN",
        frame_format: "standard",
        frame_information: { apply_to_case_data: true, strategy: "derive_from_ff_rtr_dlc" },
      },
      fields: [],
      evidence: ["test fixture"],
      warnings: [],
      confidence: 1,
      understanding_source: "model",
    }])

    const generated = await buildGeneratedStepWithPlanning({
      step: {
        stepIndex: 2,
        keywordName: "发送CANATXT数据",
        stepDescription: "第2.0秒,通过CANA总线发送首帧仲裁场错误的10字节遥控指令（仲裁场不等于根据协议确定,共2帧发送）",
        timeValue: 2,
      },
      caseContext: {
        caseId: "TC-JK-003",
        testPurpose: "验证软件可正确丢弃首帧仲裁场错误的遥控指令",
        requirementIds: ["TR-JK-001"],
        translateStatus: "success",
        steps: [],
      },
      keywordDef: {
        keywordName: "发送CANATXT数据",
        txtPath: "",
        jsonPath: "",
        arguments: [{ name: "${para2}", comments: "数据文件" }],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot),
      dataFileIndex,
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions,
    }, {
      planCaseStepData: async () => ({
        protocol_name: "遥控指令",
        flow_direction: "input",
        variant_type: "arbitration_error",
        mutations: [
          { field: "W0", frame_index: 1, byte_index: 6, operation: "replace", value: "01" },
          { field: "W1", frame_index: 1, byte_index: 7, operation: "replace", value: "0D" },
          { field: "W3", frame_index: 1, byte_index: 9, operation: "replace", value: "06" },
          { field: "ARBITRATION", operation: "replace_with_invalid_value" },
        ],
        sequence_operations: [],
        checksum_policy: "recalculate_correctly",
        argument_values: {},
        evidence_ids: [],
        confidence: 0.9,
        warnings: [],
      }),
    })

    expect(generated.data_generation_plan?.mutations).toEqual([
      { field: "W0", frame_index: 1, byte_index: 5, operation: "replace", value: "01" },
      { field: "W1", frame_index: 1, byte_index: 6, operation: "replace", value: "0D" },
      { field: "W3", frame_index: 1, byte_index: 8, operation: "replace", value: "06" },
      { field: "ARBITRATION", frame_index: 1, operation: "replace_with_invalid_value", value: undefined },
    ])
    expect(generated.data_generation_plan?.warnings).toEqual(expect.arrayContaining([
      "W0 byte_index 6 was corrected to canonical protocol index 5.",
      "W1 byte_index 7 was corrected to canonical protocol index 6.",
      "W3 byte_index 9 was corrected to canonical protocol index 8.",
    ]))
    expect(generated.data_generation_plan?.model_trigger_reasons).toContain("business_value_unresolved")
    const outputPath = join(
      paths.inputDataRoot,
      INPUT_FLOW,
      "用例生成",
      "TC-JK-003",
      "S02-遥控指令-首帧仲裁场异常.txt",
    )
    expect(readFileSync(outputPath, "utf-8").trim().split(/\r?\n/)).toEqual([
      "08 4E 28 00 0A 40 01 0D 00 06 00",
      "07 4D 27 01 00 00 00 00 00 54",
    ])
    expect(generated.data_quality?.issues.some((issue) => issue.severity === "error")).toBe(false)

    const generateFrameSequenceStep = (stepIndex: number, stepDescription: string) => buildGeneratedStepWithPlanning({
      step: {
        stepIndex,
        keywordName: "发送CANATXT数据",
        stepDescription,
        timeValue: stepIndex,
      },
      caseContext: {
        caseId: "TC-JK-003",
        testPurpose: "验证多帧遥控指令帧序号异常处理",
        requirementIds: ["TR-JK-001"],
        translateStatus: "success",
        steps: [],
      },
      keywordDef: {
        keywordName: "发送CANATXT数据",
        txtPath: "",
        jsonPath: "",
        arguments: [{ name: "${para2}", comments: "数据文件" }],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot),
      dataFileIndex,
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions,
    }, {
      planCaseStepData: async () => ({
        protocol_name: "遥控指令",
        flow_direction: "input",
        variant_type: "correct",
        mutations: [
          { field: "W0", frame_index: 1, operation: "replace", value: "01" },
          { field: "W1", frame_index: 1, operation: "replace", value: "0D" },
          { field: "W3", frame_index: 1, operation: "replace", value: "06" },
        ],
        sequence_operations: [],
        checksum_policy: "recalculate_correctly",
        argument_values: {},
        evidence_ids: [],
        confidence: 0.9,
        warnings: [],
      }),
    })

    const repeatedFirst = await generateFrameSequenceStep(
      17,
      "第17.0秒,通过CANA总线发送10字节遥控指令,首帧帧序号为00H（重复发送两帧帧序号=00H）,后续帧序号为01H~01H（共3帧发送）",
    )
    expect(repeatedFirst.generated_data_files[0].requested_file_name).toBe("S17-遥控指令-重复首帧.txt")
    expect(repeatedFirst.data_generation_plan?.sequence_operations).toEqual([
      { operation: "repeat_frame", frame_index: 1, repeat_count: 1 },
    ])
    expect(readFileSync(join(
      paths.inputDataRoot,
      INPUT_FLOW,
      "用例生成",
      "TC-JK-003",
      "S17-遥控指令-重复首帧.txt",
    ), "utf-8").trim().split(/\r?\n/)).toEqual([
      "08 4D 28 00 0A 40 01 0D 00 06 00",
      "08 4D 28 00 0A 40 01 0D 00 06 00",
      "07 4D 27 01 00 00 00 00 00 54",
    ])

    const invalidFirstSequence = await generateFrameSequenceStep(
      19,
      "第19.0秒,通过CANA总线发送10字节遥控指令,首帧帧序号为01H（非00H）,后续帧序号为01H~01H（共2帧发送）",
    )
    expect(invalidFirstSequence.generated_data_files[0].requested_file_name)
      .toBe("S19-遥控指令-首帧帧序号异常.txt")
    expect(invalidFirstSequence.data_generation_plan?.mutations).toContainEqual({
      field: "FRAME_SEQUENCE",
      frame_index: 1,
      operation: "replace_with_invalid_value",
      value: "01",
    })
    expect(readFileSync(join(
      paths.inputDataRoot,
      INPUT_FLOW,
      "用例生成",
      "TC-JK-003",
      "S19-遥控指令-首帧帧序号异常.txt",
    ), "utf-8").trim().split(/\r?\n/)).toEqual([
      "08 4D 28 01 0A 40 01 0D 00 06 00",
      "07 4D 27 01 00 00 00 00 00 54",
    ])

    const missingFirst = await generateFrameSequenceStep(
      21,
      "第21.0秒,通过CANA总线发送10字节遥控指令,首帧帧序号为01H（缺少00H首帧）,后续帧序号为02H~01H（共1帧发送）",
    )
    expect(missingFirst.generated_data_files[0].requested_file_name).toBe("S21-遥控指令-缺少首帧.txt")
    expect(missingFirst.data_generation_plan?.sequence_operations).toEqual([
      { operation: "drop_frame", frame_index: 1 },
    ])
    expect(readFileSync(join(
      paths.inputDataRoot,
      INPUT_FLOW,
      "用例生成",
      "TC-JK-003",
      "S21-遥控指令-缺少首帧.txt",
    ), "utf-8").trim()).toBe("07 4D 27 01 00 00 00 00 00 54")

    const invalidLastSequence = await generateFrameSequenceStep(
      25,
      "第25.0秒,通过CANA总线发送10字节遥控指令,前面帧序号00H~00H正常,最后一帧帧序号为FFH（非01H）,共2帧发送",
    )
    expect(invalidLastSequence.generated_data_files[0].requested_file_name)
      .toBe("S25-遥控指令-尾帧帧序号异常.txt")
    expect(readFileSync(join(
      paths.inputDataRoot,
      INPUT_FLOW,
      "用例生成",
      "TC-JK-003",
      "S25-遥控指令-尾帧帧序号异常.txt",
    ), "utf-8").trim().split(/\r?\n/)).toEqual([
      "08 4D 28 00 0A 40 01 0D 00 06 00",
      "07 4D 27 FF 00 00 00 00 00 54",
    ])

    const invalidFirstSequenceFromClause = await generateFrameSequenceStep(
      14,
      "第14.0秒,通过CANA总线发送10字节遥控指令（首帧帧序号错误即帧序号01H起,后跟01H,共2帧）",
    )
    expect(invalidFirstSequenceFromClause.generated_data_files[0].requested_file_name)
      .toBe("S14-遥控指令-首帧帧序号异常.txt")
    expect(invalidFirstSequenceFromClause.data_generation_plan?.mutations).toContainEqual({
      field: "FRAME_SEQUENCE",
      frame_index: 1,
      operation: "replace_with_invalid_value",
      value: "01",
    })

    const invalidLastSequenceFromClause = await generateFrameSequenceStep(
      20,
      "第20.0秒,通过CANB总线发送10字节遥控指令（尾帧帧序号错误即帧序号00H、02H,共2帧）",
    )
    expect(invalidLastSequenceFromClause.generated_data_files[0].requested_file_name)
      .toBe("S20-遥控指令-尾帧帧序号异常.txt")
    expect(invalidLastSequenceFromClause.data_generation_plan?.mutations).toContainEqual({
      field: "FRAME_SEQUENCE",
      frame_index: 2,
      operation: "replace_with_invalid_value",
      value: "02",
    })
    expect(readFileSync(join(
      paths.inputDataRoot,
      INPUT_FLOW,
      "用例生成",
      "TC-JK-003",
      "S20-遥控指令-尾帧帧序号异常.txt",
    ), "utf-8").trim().split(/\r?\n/)).toEqual([
      "08 4D 28 00 0A 40 01 0D 00 06 00",
      "07 4D 27 02 00 00 00 00 00 54",
    ])
    expect(repeatedFirst.data_quality?.issues.filter((issue) => issue.severity === "error")).toEqual([])
    expect(invalidFirstSequence.data_quality?.issues.filter((issue) => issue.severity === "error")).toEqual([])
    expect(missingFirst.data_quality?.issues.filter((issue) => issue.severity === "error")).toEqual([])
    expect(invalidLastSequence.data_quality?.issues.filter((issue) => issue.severity === "error")).toEqual([])
    expect(invalidFirstSequenceFromClause.data_quality?.issues.filter((issue) => issue.severity === "error")).toEqual([])
    expect(invalidLastSequenceFromClause.data_quality?.issues.filter((issue) => issue.severity === "error")).toEqual([])
  })

  test("does not treat an empty requested file name as the first data-file index entry", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-case-empty-file-hint-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    const inputFlowDir = join(paths.inputDataRoot, INPUT_FLOW)
    const outputFlowDir = join(paths.inputDataRoot, OUTPUT_FLOW)
    mkdirSync(inputFlowDir, { recursive: true })
    mkdirSync(outputFlowDir, { recursive: true })
    const telemetryPath = join(inputFlowDir, "遥测帧1轮询控制序列.txt")
    const memoryPath = join(outputFlowDir, "内存读出数据.txt")
    writeFileSync(telemetryPath, "8D 04 00 10 01 11\n", "utf-8")
    writeFileSync(memoryPath, "8D 68 00 F0 88 00 00 00 00 00 00 F0\n", "utf-8")
    const dataFileIndex: GeneratedDataFileIndex = {
      schema_version: "1.0.0",
      project_root: workspaceRoot,
      dtp_root: paths.dtpRoot,
      runtime_dir: paths.runtimeDir,
      input_data_root: paths.inputDataRoot,
      source_documents: [],
      entries: [
        {
          id: "memory-first",
          protocol_name: "内存读出数据",
          requested_file_name: "内存读出数据.txt",
          file_path: `${INPUT_DATA}\\${OUTPUT_FLOW}\\内存读出数据.txt`,
          absolute_file_path: memoryPath,
          source: "pre-generated",
          source_documents: [],
          generation_basis: ["test"],
          flow_direction: "output",
          confidence: 1,
          state: "validated",
          warnings: [],
        },
        {
          id: "telemetry-second",
          protocol_name: "遥测帧1轮询控制序列",
          requested_file_name: "遥测帧1轮询控制序列.txt",
          file_path: `${INPUT_DATA}\\${INPUT_FLOW}\\遥测帧1轮询控制序列.txt`,
          absolute_file_path: telemetryPath,
          source: "pre-generated",
          source_documents: [],
          generation_basis: ["test"],
          flow_direction: "input",
          confidence: 1,
          state: "validated",
          warnings: [],
        },
      ],
      warnings: [],
      updated_at: new Date().toISOString(),
    }
    const protocolDefinitions = createProtocolDefinitions(workspaceRoot, [
      {
        protocol_id: "memory-read",
        source_section: "内存读出",
        flow_direction: "output",
        base_file_name: "内存读出数据",
        generation_mode: "single_file",
        frame: {
          source_table_id: "table-memory-read",
          byte_layout: ["8D", "68", "00", "F0", "88", "W0", "W1", "SUM"],
          checksum: { type: "sum_low8", start: "TITLE", end: "BEFORE_SUM" },
        },
        fields: [],
        evidence: ["test fixture"],
        warnings: [],
        confidence: 1,
        understanding_source: "model",
      },
    ])

    const generated = await buildGeneratedStepWithPlanning(
      {
        step: {
          stepIndex: 1,
          keywordName: "发送CANB数据_数据文件",
          stepDescription: "第1.0秒,通过CANB总线发送正确的遥测帧1轮询控制序列,TITLE=00H,SUM正确",
          timeValue: 1,
        },
        caseContext: {
          caseId: "TC-JK-003",
          testPurpose: "验证遥测帧1轮询控制序列TITLE异常处理",
          correspondFunId: "TR-JK-002",
          requirementIds: ["TR-JK-002"],
          steps: [],
        },
        keywordDef: {
          keywordName: "发送CANB数据_数据文件",
          txtPath: "",
          jsonPath: "",
          arguments: [
            { name: "${time}", comments: "执行时间" },
            { name: "${para1}", comments: "参数1：ID" },
            { name: "${para2}", comments: "参数2：数据文件" },
            { name: "${para3}", comments: "参数3：循环时间" },
          ],
        },
        inputDataRoot: paths.inputDataRoot,
        workspaceRoot,
        knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot),
        dataFileIndex,
        docsContext: EMPTY_DOCS_CONTEXT,
        protocolDefinitions,
      },
      {
        planCaseStepData: async () => ({
          protocol_name: "内存读出数据",
          flow_direction: "output",
          variant_type: "correct",
          mutations: [],
          checksum_policy: "recalculate_correctly",
          argument_values: { "${para1}": 141, "${para3}": 0 },
          confidence: 0.9,
          warnings: [],
        }),
      },
    )

    expect(generated.data_generation_plan?.protocol_name).toBe("遥测帧1轮询控制序列")
    expect(generated.data_generation_plan?.flow_direction).toBe("input")
    expect(generated.generated_data_files[0].requested_file_name).toBe("S01-遥测帧1轮询控制序列-正常.txt")
    expect(
      readFileSync(
        join(paths.inputDataRoot, INPUT_FLOW, "用例生成", "TC-JK-003", "S01-遥测帧1轮询控制序列-正常.txt"),
        "utf-8",
      ).trim(),
    ).toBe("8D 04 00 10 01 11")
    expect(generated.data_quality?.status).not.toBe("failed")
  })

  test("applies TITLE errors to the canonical frame and recalculates SUM", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-case-title-error-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    mkdirSync(paths.inputDataRoot, { recursive: true })
    const dataFileIndex = prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT)
    const protocolDefinitions = createProtocolDefinitions(workspaceRoot, [
      {
        protocol_id: "telemetry-frame-1-poll",
        source_section: "1.1.1.1 遥测帧1相关数据流",
        flow_direction: "input",
        base_file_name: "遥测帧1轮询控制序列",
        generation_mode: "single_file",
        frame: {
          source_table_id: "table-telemetry-frame-1",
          byte_layout: ["8D", "04", "TITLE", "W0", "W1", "SUM"],
          checksum: { type: "sum_low8", start: "TITLE", end: "BEFORE_SUM" },
        },
        fields: [
          { name: "TITLE", type: "fixed", value: "00", options: [], confidence: 1, warnings: [] },
          { name: "W0", type: "fixed", value: "10", options: [], confidence: 1, warnings: [] },
          { name: "W1", type: "fixed", value: "01", options: [], confidence: 1, warnings: [] },
        ],
        evidence: ["test fixture"],
        warnings: [],
        confidence: 1,
        understanding_source: "heuristic-fallback",
      },
    ])

    const generated = await buildGeneratedStepWithPlanning(
      {
        step: {
          stepIndex: 2,
          keywordName: "发送CANBTXT数据",
          stepDescription: "第3.0秒,通过CANB总线发送遥测帧1轮询控制序列,TITLE字段错误（非00H）,SUM正确",
          expectedResult: "系统检测到TITLE格式错误",
          timeValue: 3,
        },
        caseContext: {
          caseId: "TC-JK-003",
          testPurpose: "验证TITLE异常处理",
          correspondFunId: "TR-JK-002",
          requirementIds: ["TR-JK-002"],
          steps: [],
        },
        keywordDef: {
          keywordName: "发送CANBTXT数据",
          txtPath: "",
          jsonPath: "",
          arguments: [
            { name: "${time}", comments: "执行时间" },
            { name: "${para1}", comments: "参数1：ID:0~255" },
            { name: "${para2}", comments: "参数2：数据文件，文件内容为十六进制数据" },
            { name: "${para3}", comments: "参数3：循环时间，单位秒" },
          ],
        },
        inputDataRoot: paths.inputDataRoot,
        workspaceRoot,
        knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot),
        dataFileIndex,
        docsContext: EMPTY_DOCS_CONTEXT,
        protocolDefinitions,
      },
      {
        planCaseStepData: async () => ({
          protocol_name: "卫星平台CAN总线协议",
          flow_direction: "input",
          base_bytes: [["00", "10", "01", "11"]],
          variant_type: "title_error",
          mutations: [{ field: "TITLE", byte_index: 0, operation: "replace_with_invalid_value", value: "01" }],
          checksum_policy: "recalculate_correctly",
          argument_values: { "${para1}": 141, "${para3}": 0 },
          confidence: 0.9,
          warnings: [],
        }),
      },
    )

    expect(generated.generated_data_files[0].requested_file_name).toBe("S02-遥测帧1轮询控制序列-TITLE异常-SUM正确.txt")
    const outputPath = join(
      paths.inputDataRoot,
      INPUT_FLOW,
      "用例生成",
      "TC-JK-003",
      "S02-遥测帧1轮询控制序列-TITLE异常-SUM正确.txt",
    )
    expect(readFileSync(outputPath, "utf-8").trim()).toBe("8D 04 01 10 01 12")
    expect(generated.data_quality?.status).toBe("pass")
  })

  test("uses V2 field_layout to mutate a fixed TITLE byte", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-case-v2-field-layout-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    mkdirSync(paths.inputDataRoot, { recursive: true })
    const dataFileIndex = prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT)
    const protocolDefinitions = createProtocolDefinitions(workspaceRoot, [
      {
        protocol_id: "telemetry-v2",
        source_section: "Telemetry input flow",
        flow_direction: "input",
        base_file_name: "TelemetryFrame",
        generation_mode: "single_file",
        frames: [
          {
            frame_id: "frame-1",
            sequence: 1,
            source_table_id: "table-telemetry",
            byte_layout: ["8D", "04", "00", "10", "01", "SUM"],
            field_layout: [
              { name: "ARBITRATION", role: "arbitration", byte_offset: 0, byte_length: 1, default_value: "8D" },
              { name: "CONTROL", role: "control", byte_offset: 1, byte_length: 1, default_value: "04" },
              { name: "TITLE", role: "title", byte_offset: 2, byte_length: 1, default_value: "00" },
              { name: "W0", role: "data", byte_offset: 3, byte_length: 1, default_value: "10" },
              { name: "W1", role: "data", byte_offset: 4, byte_length: 1, default_value: "01" },
              { name: "SUM", role: "checksum", byte_offset: 5, byte_length: 1 },
            ],
            checksum: { type: "sum_low8", start: "TITLE", end: "BEFORE_SUM" },
          },
        ],
        fields: [],
        evidence: ["test fixture"],
        warnings: [],
        confidence: 1,
        understanding_source: "model",
      },
    ])

    const generated = await buildGeneratedStepWithPlanning({
      step: {
        stepIndex: 2,
        keywordName: "SendDataFile",
        stepDescription: "Send TelemetryFrame with TITLE error and correct SUM",
        expectedResult: "This text must not affect data generation",
        timeValue: 1,
      },
      caseContext: {
        caseId: "TC-V2-001",
        testPurpose: "Verify invalid TITLE handling",
        correspondFunId: "TR-V2-001",
        requirementIds: ["TR-V2-001"],
        steps: [],
      },
      keywordDef: {
        keywordName: "SendDataFile",
        txtPath: "",
        jsonPath: "",
        arguments: [{ name: "${para2}", comments: "data file" }],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot),
      dataFileIndex,
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions,
    }, {
      planCaseStepData: async () => ({
        protocol_name: "TelemetryFrame",
        flow_direction: "input",
        variant_type: "title_error",
        mutations: [{ field: "TITLE", operation: "replace_with_invalid_value", value: "01" }],
        sequence_operations: [],
        checksum_policy: "recalculate_correctly",
        argument_values: {},
        evidence_ids: ["TR-V2-001:input-flow"],
        confidence: 1,
        warnings: [],
      }),
    })

    const generatedFile = generated.generated_data_files[0]
    const outputPath = join(
      paths.inputDataRoot,
      INPUT_FLOW,
      "\u7528\u4f8b\u751f\u6210",
      "TC-V2-001",
      generatedFile.requested_file_name,
    )
    expect(readFileSync(outputPath, "utf-8").trim()).toBe("8D 04 01 10 01 12")
    expect(generated.data_quality?.status).toBe("pass")
  })

  test("treats standalone CANA as a primary CAN compatibility alias before protocol scoring", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-case-can-interface-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    mkdirSync(paths.inputDataRoot, { recursive: true })
    const dataFileIndex = prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT)
    const frame = (arbitration: string, table: string) => ({
      frame_id: "frame-1",
      sequence: 1,
      source_table_id: table,
      byte_layout: [arbitration, "04", "00", "10", "01", "SUM"],
      field_layout: [
        { name: "ARBITRATION", role: "arbitration" as const, byte_offset: 0, byte_length: 1 },
        { name: "CONTROL", role: "control" as const, byte_offset: 1, byte_length: 1 },
        { name: "TITLE", role: "title" as const, byte_offset: 2, byte_length: 1 },
        { name: "W0", role: "data" as const, byte_offset: 3, byte_length: 1 },
        { name: "W1", role: "data" as const, byte_offset: 4, byte_length: 1 },
        { name: "SUM", role: "checksum" as const, byte_offset: 5, byte_length: 1 },
      ],
      checksum: { type: "sum_low8" as const, start: "TITLE", end: "BEFORE_SUM" },
    })
    const protocolDefinitions = createProtocolDefinitions(workspaceRoot, [
      {
        protocol_id: "primary-telemetry",
        source_section: "\u4e00\u7ea7CAN\u603b\u7ebf\u63a5\u53e3",
        flow_direction: "input",
        base_file_name: "\u9065\u6d4b\u8f6e\u8be2\u63a7\u5236\u5e8f\u5217",
        generation_mode: "single_file",
        frames: [frame("8D", "table-primary")],
        bus_context: { bus_type: "CAN", interface_level: "primary", interface_id: "IF-CAN0-001" },
        fields: [], evidence: [], warnings: [], confidence: 1, understanding_source: "model",
      },
      {
        protocol_id: "secondary-telemetry",
        source_section: "\u4e8c\u7ea7CAN\u603b\u7ebf\u63a5\u53e3",
        flow_direction: "input",
        base_file_name: "\u9065\u6d4b\u8f6e\u8be2\u63a7\u5236\u5e8f\u5217",
        generation_mode: "single_file",
        frames: [frame("9D", "table-secondary")],
        bus_context: { bus_type: "CAN", interface_level: "secondary", interface_id: "IF-CAN1-001" },
        fields: [], evidence: [], warnings: [], confidence: 1, understanding_source: "model",
      },
    ])
    const generated = await buildGeneratedStepWithPlanning({
      step: { stepIndex: 1, keywordName: "SendCANDataFile", stepDescription: "\u7b2c1\u79d2,\u901a\u8fc7CANA\u603b\u7ebf\u53d1\u9001\u6b63\u786e\u7684\u9065\u6d4b\u8f6e\u8be2\u63a7\u5236\u5e8f\u5217" },
      caseContext: { caseId: "TC-CAN-ALIAS", requirementIds: [], steps: [] },
      keywordDef: { keywordName: "SendCANDataFile", txtPath: "", jsonPath: "", arguments: [{ name: "${para2}", comments: "\u6570\u636e\u6587\u4ef6" }] },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot),
      dataFileIndex,
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions,
    }, null)

    const outputFile = join(paths.inputDataRoot, INPUT_FLOW, "\u7528\u4f8b\u751f\u6210", "TC-CAN-ALIAS", generated.generated_data_files[0].requested_file_name)
    expect(readFileSync(outputFile, "utf-8").trim()).toBe("8D 04 00 10 01 11")
    expect(generated.data_generation_plan).toMatchObject({
      protocol_id: "primary-telemetry",
      interface_level: "primary",
      interface_selection_source: "legacy_can_channel_alias",
      matched_interface_alias: "CANA",
    })
    expect(generated.data_generation_plan?.rejected_protocols).toContainEqual({
      protocol_id: "secondary-telemetry",
      reason: "secondary CAN conflicts with step primary CAN",
    })

    const explicitSecondaryPlan = buildGeneratedStep({
      step: { stepIndex: 2, keywordName: "SendCANDataFile", stepDescription: "第2秒,通过CANA总线发送正确的遥测轮询控制序列" },
      caseContext: { caseId: "TC-CAN-ALIAS", requirementIds: [], steps: [] },
      keywordDef: { keywordName: "SendCANDataFile", txtPath: "", jsonPath: "", arguments: [{ name: "${para2}", comments: "数据文件" }] },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot),
      dataFileIndex,
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions,
      dataGenerationPlan: {
        protocol_id: "secondary-telemetry",
        protocol_name: "遥测轮询控制序列",
        flow_direction: "input",
        bus: "CAN",
        variant_type: "correct",
        mutations: [],
        sequence_operations: [],
        checksum_policy: "recalculate_correctly",
        argument_values: {},
        evidence_ids: [],
        confidence: 1,
        warnings: [],
        source: "model",
      },
    })
    const explicitOutput = join(paths.inputDataRoot, INPUT_FLOW, "用例生成", "TC-CAN-ALIAS", explicitSecondaryPlan.generated_data_files[0].requested_file_name)
    expect(readFileSync(explicitOutput, "utf-8").trim()).toBe("8D 04 00 10 01 11")
    expect(explicitSecondaryPlan.data_quality?.issues.some((issue) => issue.type === "protocol_mismatch")).toBe(false)
  })

  test("prefers an exact protocol identity over unrelated primary CAN metadata", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-case-can-identity-priority-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    mkdirSync(paths.inputDataRoot, { recursive: true })
    const frame = (word: string, table: string) => ({
      frame_id: "frame-1",
      sequence: 1,
      source_table_id: table,
      byte_layout: ["8D", "04", "00", "10", word, "SUM"],
      field_layout: [
        { name: "ARBITRATION", role: "arbitration" as const, byte_offset: 0, byte_length: 1 },
        { name: "CONTROL", role: "control" as const, byte_offset: 1, byte_length: 1 },
        { name: "TITLE", role: "title" as const, byte_offset: 2, byte_length: 1 },
        { name: "W0", role: "data" as const, byte_offset: 3, byte_length: 1 },
        { name: "W1", role: "data" as const, byte_offset: 4, byte_length: 1 },
        { name: "SUM", role: "checksum" as const, byte_offset: 5, byte_length: 1 },
      ],
      checksum: { type: "sum_low8" as const, start: "TITLE", end: "BEFORE_SUM" },
    })
    const protocolDefinitions = createProtocolDefinitions(workspaceRoot, [
      {
        protocol_id: "IF-CAN0-001-TM1",
        source_section: "3.1.1.1 遥测帧1轮询控制序列",
        flow_direction: "input",
        base_file_name: "遥测帧1轮询控制序列",
        generation_mode: "single_file",
        frames: [frame("01", "table-tm1")],
        bus_context: { bus_type: "CAN", interface_level: "unknown", interface_id: "IF-CAN0-001" },
        fields: [], evidence: [], warnings: [], confidence: 1, understanding_source: "model",
      },
      ...[2, 3, 4].map((index) => ({
        protocol_id: `IF-CAN0-001-TM${index}`,
        source_section: `3.1.1.${index} 遥测帧${index}轮询控制序列`,
        flow_direction: "input" as const,
        base_file_name: `遥测帧${index}轮询控制序列`,
        generation_mode: "single_file" as const,
        frames: [frame(`0${index}`, `table-tm${index}`)],
        bus_context: { bus_type: "CAN" as const, interface_level: "primary" as const, interface_id: "IF-CAN0-001" },
        fields: [], evidence: [], warnings: [], confidence: 1, understanding_source: "model" as const,
      })),
    ])

    const generated = await buildGeneratedStepWithPlanning({
      step: {
        stepIndex: 1,
        keywordName: "发送CANATXT数据",
        stepDescription: "第1.0秒,通过CANA总线发送正确的遥测帧1轮询控制序列8DH 04H 00H 10H 01H 11H",
        timeValue: 1,
      },
      caseContext: { caseId: "TC-JK-001", requirementIds: [], steps: [] },
      keywordDef: {
        keywordName: "发送CANATXT数据",
        txtPath: "",
        jsonPath: "",
        arguments: [{ name: "${para2}", comments: "参数2：数据文件" }],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot),
      dataFileIndex: prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT),
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions,
    }, null)

    const outputFile = join(
      paths.inputDataRoot,
      INPUT_FLOW,
      "用例生成",
      "TC-JK-001",
      generated.generated_data_files[0].requested_file_name,
    )
    expect(generated.data_generation_plan?.protocol_id).toBe("IF-CAN0-001-TM1")
    expect(generated.generated_data_files[0].requested_file_name).toBe("S01-遥测帧1轮询控制序列-正常.txt")
    expect(readFileSync(outputFile, "utf-8").trim()).toBe("8D 04 00 10 01 11")
    expect(generated.data_quality?.status).toBe("pass")
  })

  test("uses a concise section title instead of protocol field evidence in case file names", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-case-display-name-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    mkdirSync(paths.inputDataRoot, { recursive: true })
    const protocolDefinitions = createProtocolDefinitions(workspaceRoot, [{
      protocol_id: "can-primary-tm1-poll",
      source_section: "3.1.1.1 遥测帧1轮询控制序列",
      flow_direction: "input",
      base_file_name: "can_primary_tm1_poll_control_seq",
      generation_mode: "single_file",
      frames: [{
        frame_id: "frame-1",
        sequence: 1,
        source_table_id: "table-tm1-poll",
        byte_layout: ["8D", "04", "00", "10", "01", "SUM"],
        field_layout: [
          { name: "ARBITRATION", role: "arbitration", byte_offset: 0, byte_length: 1 },
          { name: "CONTROL", role: "control", byte_offset: 1, byte_length: 1 },
          { name: "TITLE", role: "title", byte_offset: 2, byte_length: 1 },
          { name: "W0", role: "data", byte_offset: 3, byte_length: 1 },
          { name: "W1", role: "data", byte_offset: 4, byte_length: 1 },
          { name: "SUM", role: "checksum", byte_offset: 5, byte_length: 1 },
        ],
        checksum: { type: "sum_low8", start: "TITLE", end: "BEFORE_SUM" },
      }],
      bus_context: { bus_type: "CAN", interface_level: "primary", interface_id: "IF-CAN0-001" },
      fields: [],
      evidence: [
        "表3.1.1.1-1 遥测帧1轮询控制序列: 仲裁场/控制场=8DH/04H, 有效数据场=TITLE(00H)/W0(10H)/W1(01H)/SUM/4个未使用字节",
      ],
      warnings: [],
      confidence: 1,
      understanding_source: "model",
    }])
    const generated = await buildGeneratedStepWithPlanning({
      step: {
        stepIndex: 2,
        keywordName: "发送CANA数据_数据文件",
        stepDescription: "第2.0秒,通过CANA总线发送仲裁场错误的遥测帧1轮询控制序列",
      },
      caseContext: { caseId: "TC-JK-001", requirementIds: [], steps: [] },
      keywordDef: {
        keywordName: "发送CANA数据_数据文件",
        txtPath: "",
        jsonPath: "",
        arguments: [{ name: "${para2}", comments: "数据文件" }],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot),
      dataFileIndex: prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT),
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions,
    }, {
      planCaseStepData: async () => ({
        protocol_id: "can-primary-tm1-poll",
        protocol_name: "can_primary_tm1_poll_control_seq",
        flow_direction: "input",
        bus: "CAN",
        variant_type: "arbitration_error",
        mutations: [{ field: "ARBITRATION", operation: "replace_with_invalid_value" }],
        sequence_operations: [],
        checksum_policy: "recalculate_correctly",
        argument_values: {},
        evidence_ids: [],
        confidence: 1,
        warnings: [],
        source: "heuristic-fallback",
      }),
    })

    expect(generated.generated_data_files[0].requested_file_name)
      .toBe("S02-遥测帧1轮询控制序列-仲裁场异常.txt")
  })

  test("uses primary CAN evidence aliases when a model-selected secondary protocol has the exact Chinese name", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-case-can-evidence-alias-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    mkdirSync(paths.inputDataRoot, { recursive: true })
    const legacyFrame = {
      source_table_id: "table-camera-remote-command-15",
      byte_layout: ["4D", "28", "00", "0F", "40", "W0", "W1", "W2", "W3", "W4"],
      byte_layouts: [
        ["4D", "28", "00", "0F", "40", "W0", "W1", "W2", "W3", "W4"],
        ["4D", "28", "01", "W5", "W6", "W7", "W8", "W9", "W10", "W11"],
        ["4D", "25", "02", "W12", "W13", "W14", "SUM"],
      ],
      checksum: { type: "sum_low8" as const, start: "TITLE", end: "BEFORE_SUM" },
    }
    const protocolDefinitions = createProtocolDefinitions(workspaceRoot, [
      {
        protocol_id: "IF-CAN0-001-input-remote-cmd-15byte",
        source_section: "3.1.1.5 发向相机管理控制器长度10字节的遥控指令",
        flow_direction: "input",
        base_file_name: "primary_can_remote_cmd_15byte",
        generation_mode: "single_file",
        frame: legacyFrame,
        bus_context: { bus_type: "CAN", interface_level: "primary", interface_id: "IF-CAN0-001" },
        fields: [],
        evidence: ["表3.1.1.5-2 发向相机管理控制器长度15字节的遥控指令"],
        warnings: [], confidence: 1, understanding_source: "model",
      },
      {
        protocol_id: "secondary-can-remote-command-15byte",
        source_section: "3.1.3 二级CAN总线接口",
        flow_direction: "output",
        base_file_name: "遥控指令_15字节",
        generation_mode: "single_file",
        frame: { ...legacyFrame, source_table_id: "table-secondary-command-15" },
        bus_context: { bus_type: "CAN", interface_level: "secondary", interface_id: "IF-CAN1-001" },
        fields: [], evidence: ["二级CAN遥控指令"], warnings: [], confidence: 1, understanding_source: "model",
      },
    ])
    const generated = await buildGeneratedStepWithPlanning({
      step: {
        stepIndex: 1,
        keywordName: "发送CANA数据_数据文件",
        stepDescription: "第1.0秒,通过CANA总线发送W14错误的15字节遥控指令",
      },
      caseContext: { caseId: "TC-CAN-EVIDENCE", requirementIds: [], steps: [] },
      keywordDef: {
        keywordName: "发送CANA数据_数据文件",
        txtPath: "",
        jsonPath: "",
        arguments: [{ name: "${para2}", comments: "数据文件" }],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot),
      dataFileIndex: prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT),
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions,
    }, {
      planCaseStepData: async () => ({
        protocol_id: "secondary-can-remote-command-15byte",
        protocol_name: "遥控指令_15字节",
        flow_direction: "input",
        bus: "CAN",
        variant_type: "correct",
        mutations: [],
        sequence_operations: [],
        checksum_policy: "recalculate_correctly",
        argument_values: {}, evidence_ids: [], confidence: 1, warnings: [], source: "model",
      }),
    })

    expect(generated.data_generation_plan?.protocol_id).toBe("IF-CAN0-001-input-remote-cmd-15byte")
    expect(generated.generated_data_files[0].requested_file_name)
      .toBe("S01-发向相机管理控制器长度15字节的遥控指令-W14异常.txt")
    const outputFile = join(
      paths.inputDataRoot,
      INPUT_FLOW,
      "用例生成",
      "TC-CAN-EVIDENCE",
      generated.generated_data_files[0].requested_file_name,
    )
    expect(readFileSync(outputFile, "utf-8").trim().split(/\r?\n/)).toEqual([
      "4D 28 00 0F 40 00 00 00 00 00",
      "4D 28 01 00 00 00 00 00 00 00",
      "4D 25 02 00 00 01 41",
    ])
    expect(generated.data_generation_plan?.rejected_protocols).toContainEqual({
      protocol_id: "secondary-can-remote-command-15byte",
      reason: "secondary CAN conflicts with step primary CAN",
    })
  })

  test("does not retain a primary CAN case anchor for an explicit secondary CAN step", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-case-anchor-scope-${Date.now()}`)
    const paths = resolveDefaultPaths(workspaceRoot)
    const keywordDir = join(paths.dtpRoot, "组合关键字")
    mkdirSync(keywordDir, { recursive: true })
    writeFileSync(paths.todoFile, "TC-ANCHOR-SCOPE\n", "utf-8")
    writeFileSync(paths.confirmationFile, `${JSON.stringify({
      test_cases: [{
        case_id: "TC-ANCHOR-SCOPE",
        translate_status: "success",
        test_step: [
          {
            key_name: "发送CANATXT数据",
            step_desc: "第3.0秒,通过CANA总线发送正确的10字节遥控指令",
            parameter: [{ Name: "${time}", Value: 3 }],
          },
          {
            key_name: "发送二级CANTXT数据",
            step_desc: "第3.1秒，发送二级CAN数据为站地址01H的遥控指令应答正常发送",
            parameter: [{ Name: "${time}", Value: 3.1 }],
          },
        ],
      }],
    }, null, 2)}\n`, "utf-8")
    for (const keywordName of ["发送CANATXT数据", "发送二级CANTXT数据"]) {
      writeFileSync(join(keywordDir, `${keywordName}.json`), `${JSON.stringify({
        Name: keywordName,
        Arguments: [
          { Name: "${time}", Comments: "执行时间" },
          { Name: "${para1}", Comments: "数据文件" },
        ],
      }, null, 2)}\n`, "utf-8")
      writeFileSync(join(keywordDir, `${keywordName}.txt`), `${keywordName}\n`, "utf-8")
    }

    const protocolDefinitions = createProtocolDefinitions(workspaceRoot, [
      {
        protocol_id: "primary-remote-command",
        source_section: "3.1.1.5 一级CAN遥控指令",
        flow_direction: "input",
        base_file_name: "10字节遥控指令",
        generation_mode: "single_file",
        frames: [{
          frame_id: "frame-1",
          sequence: 1,
          source_table_id: "primary-command-table",
          byte_layout: ["4D", "28", "00", "0A", "40", "SUM"],
          field_layout: [
            { name: "ARBITRATION", role: "arbitration", byte_offset: 0, byte_length: 1, default_value: "4D" },
            { name: "CONTROL", role: "control", byte_offset: 1, byte_length: 1, default_value: "28" },
            { name: "FRAME_SEQUENCE", role: "sequence", byte_offset: 2, byte_length: 1, default_value: "00" },
            { name: "LENGTH", role: "length", byte_offset: 3, byte_length: 1, default_value: "0A" },
            { name: "TITLE", role: "title", byte_offset: 4, byte_length: 1, default_value: "40" },
            { name: "SUM", role: "checksum", byte_offset: 5, byte_length: 1 },
          ],
          checksum: { type: "sum_low8", start: "TITLE", end: "BEFORE_SUM" },
        }],
        bus_context: { bus_type: "CAN", interface_level: "primary", interface_id: "IF-CAN0-001" },
        fields: [], evidence: [], warnings: [], confidence: 1, understanding_source: "model",
      },
      {
        protocol_id: "secondary-remote-response",
        source_section: "3.1.3.3 二级CAN遥控指令应答",
        flow_direction: "input",
        base_file_name: "遥控指令应答",
        generation_mode: "single_file",
        frames: [{
          frame_id: "frame-1",
          sequence: 1,
          source_table_id: "secondary-response-table",
          byte_layout: ["DYNAMIC_STATION_ADDRESS", "48", "TITLE", "FF", "20", "FF", "20", "FF", "20", "SUM"],
          field_layout: [
            { name: "ARBITRATION", role: "arbitration", byte_offset: 0, byte_length: 1, value_rule: { operation: "add_low8", base: "40", variable: "station_address" } },
            { name: "CONTROL", role: "control", byte_offset: 1, byte_length: 1, default_value: "48" },
            { name: "TITLE", role: "title", byte_offset: 2, byte_length: 1, value_rule: { operation: "variable", variable: "station_address" } },
            { name: "SUM", role: "checksum", byte_offset: 9, byte_length: 1 },
          ],
          checksum: { type: "sum_low8", start: "TITLE", end: "BEFORE_SUM" },
        }],
        bus_context: { bus_type: "CAN", interface_level: "secondary", interface_id: "IF-CAN1-001", controller: "FPGA" },
        variables: [{ name: "station_address", display_name: "站地址", type: "uint8" }],
        frame_envelope: { type: "fixed_prefix", bytes: ["00", "08"], applies_per_frame: true },
        fields: [], evidence: [], warnings: [], confidence: 1, understanding_source: "model",
      },
    ])
    const knowledgeIndex = createEmptyKnowledgeIndex(workspaceRoot)
    const prepared = {
      knowledge_index: knowledgeIndex,
      protocol_definitions: protocolDefinitions,
      cache_hit: false,
      knowledge_mode: "source" as const,
      source_document_scan_performed: false,
      validation: validateDtpProtocolDefinitions(protocolDefinitions),
    }

    const generated = await runDtpCaseDataInstantiation(workspaceRoot, EMPTY_DOCS_CONTEXT, null, prepared)
    const [primaryStep, secondaryStep] = generated.cases[0].generated_steps

    expect(primaryStep.data_generation_plan?.protocol_id).toBe("primary-remote-command")
    expect(secondaryStep.data_generation_plan?.protocol_id).toBe("secondary-remote-response")
    expect(secondaryStep.data_generation_plan?.interface_level).toBe("secondary")
  })

  test("uses explicit frame bytes and a case anchor when same-name CAN scope metadata conflicts", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-case-protocol-anchor-${Date.now()}`)
    const paths = resolveDefaultPaths(workspaceRoot)
    const keywordDir = join(paths.dtpRoot, "组合关键字")
    mkdirSync(keywordDir, { recursive: true })
    writeFileSync(paths.todoFile, "TC-JK-023\n", "utf-8")
    writeFileSync(paths.confirmationFile, `${JSON.stringify({
      test_cases: [{
        case_id: "TC-JK-023",
        translate_status: "success",
        test_step: [
          {
            key_name: "发送CANATXT数据",
            step_desc: "第1.0秒,通过CANA总线发送正确的星务时间广播数据,帧1:4FH 28H 00H 08H 40H W0 W1 W2 W3 W4,帧2:4FH 25H 01H W5 W6 W7 SUM",
            parameter: [{ Name: "${time}", Value: 1 }],
          },
          {
            key_name: "发送CANATXT数据",
            step_desc: "第2.0秒,通过CANA总线发送首帧仲裁场错误的星务时间广播数据,帧1仲裁场由4FH改为4EH,其余字段正确",
            parameter: [{ Name: "${time}", Value: 2 }],
          },
        ],
      }],
    }, null, 2)}\n`, "utf-8")
    writeFileSync(join(keywordDir, "CAN.json"), `${JSON.stringify({
      Name: "发送CANATXT数据",
      Arguments: [
        { Name: "${time}", Comments: "执行时间" },
        { Name: "${para2}", Comments: "数据文件" },
      ],
    }, null, 2)}\n`, "utf-8")
    writeFileSync(join(keywordDir, "CAN.txt"), "发送CANATXT数据\n", "utf-8")

    const frame = (id: string, sequence: number, bytes: string[]) => ({
      frame_id: id,
      sequence,
      source_table_id: `${id}-table`,
      byte_layout: bytes,
      field_layout: [],
      checksum: { type: "sum_low8" as const, start: "TITLE", end: "BEFORE_SUM" },
    })
    const protocolDefinitions = createProtocolDefinitions(workspaceRoot, [
      {
        protocol_id: "SJB-GB-001",
        source_section: "3.1.1.10 星务时间广播格式",
        flow_direction: "input",
        base_file_name: "星务时间广播数据",
        generation_mode: "single_file",
        frames: [
          frame("star-time-1", 1, ["4F", "28", "00", "08", "40", "W0", "W1", "W2", "W3", "W4"]),
          frame("star-time-2", 2, ["4F", "25", "01", "W5", "W6", "W7", "SUM"]),
        ],
        bus_context: { bus_type: "CAN", interface_level: "secondary" },
        fields: [], evidence: [], warnings: [], confidence: 1, understanding_source: "model",
      },
      {
        protocol_id: "CAN0-SJGB-001",
        source_section: "3.1.3.7 相机辅助数据广播格式定义",
        flow_direction: "output",
        base_file_name: "星务时间广播数据",
        generation_mode: "single_file",
        frames: [
          frame("camera-time-1", 1, ["2F", "28", "00", "0B", "80", "W0", "W1", "W2", "W3", "W4"]),
          frame("camera-time-2", 2, ["2F", "28", "01", "W5", "W6", "W7", "00", "00", "00", "SUM"]),
        ],
        bus_context: { bus_type: "CAN", interface_level: "primary", interface_id: "IF-CAN0-001" },
        fields: [], evidence: [], warnings: [], confidence: 1, understanding_source: "model",
      },
    ])
    const knowledgeIndex = createEmptyKnowledgeIndex(workspaceRoot)
    const prepared = {
      knowledge_index: knowledgeIndex,
      protocol_definitions: protocolDefinitions,
      cache_hit: false,
      validation: validateDtpProtocolDefinitions(protocolDefinitions),
    }

    const generated = await runDtpCaseDataInstantiation(workspaceRoot, EMPTY_DOCS_CONTEXT, null, prepared)
    const [normal, arbitrationError] = generated.cases[0].generated_steps

    expect(normal.data_generation_plan).toMatchObject({
      protocol_id: "SJB-GB-001",
      selection_source: "case_anchor",
    })
    expect(arbitrationError.data_generation_plan).toMatchObject({
      protocol_id: "SJB-GB-001",
      selection_source: "case_anchor",
    })
    expect(normal.generated_data_files[0].requested_file_name).not.toContain("待确认")
    expect(arbitrationError.generated_data_files[0].requested_file_name).not.toContain("待确认")
    expect(readFileSync(join(
      paths.inputDataRoot,
      INPUT_FLOW,
      "用例生成",
      "TC-JK-023",
      normal.generated_data_files[0].requested_file_name,
    ), "utf-8").trim().split(/\r?\n/)).toEqual([
      "4F 28 00 08 40 00 00 00 00 00",
      "4F 25 01 00 00 00 40",
    ])
  })

  test("retains an authoritative canonical frame layout when the declared frame count is substantially shorter", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-case-frame-conflict-${Date.now()}`)
    const paths = resolveDefaultPaths(workspaceRoot)
    mkdirSync(paths.inputDataRoot, { recursive: true })
    const frames = Array.from({ length: 37 }, (_, index) => ({
      frame_id: `frame-${index + 1}`,
      sequence: index + 1,
      source_table_id: "table-auxiliary",
      byte_layout: ["9D", "28", index.toString(16).toUpperCase().padStart(2, "0"), "00"],
      field_layout: [],
    }))
    const protocolDefinitions = createProtocolDefinitions(workspaceRoot, [{
      protocol_id: "auxiliary-packet-1",
      source_section: "3.1.1.9 辅助数据包1",
      flow_direction: "input",
      base_file_name: "辅助数据包1",
      generation_mode: "single_file",
      frames,
      bus_context: { bus_type: "CAN", interface_level: "primary" },
      fields: [], evidence: [], warnings: [], confidence: 1, understanding_source: "model",
    }])

    const generated = await buildGeneratedStepWithPlanning({
      step: {
        stepIndex: 1,
        keywordName: "发送CANBTXT数据",
        stepDescription: "第1.0秒,通过CANB总线发送正确的辅助数据包1,共12帧发送",
      },
      caseContext: { caseId: "TC-JK-022", requirementIds: [], steps: [] },
      keywordDef: {
        keywordName: "发送CANBTXT数据",
        txtPath: "",
        jsonPath: "",
        arguments: [{ name: "${para2}", comments: "数据文件" }],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot),
      dataFileIndex: prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT),
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions,
      protocolAnchorId: "auxiliary-packet-1",
    }, null)

    expect(generated.data_quality?.issues).toContainEqual(expect.objectContaining({
      severity: "warning",
      type: "case_step_protocol_conflict",
    }))
    expect(generated.data_generation_plan?.protocol_id).toBe("auxiliary-packet-1")
    expect(generated.generated_data_files[0].requested_file_name).not.toContain("待确认")
    expect(readFileSync(join(
      paths.inputDataRoot,
      INPUT_FLOW,
      "用例生成",
      "TC-JK-022",
      generated.generated_data_files[0].requested_file_name,
    ), "utf-8").trim().split(/\r?\n/)).toHaveLength(37)
  })

  test("uses the numbered protocol identity from authoritative table captions", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-numbered-protocol-variant-${Date.now()}`)
    const paths = resolveDefaultPaths(workspaceRoot)
    mkdirSync(paths.inputDataRoot, { recursive: true })
    const protocol = (id: string, title: string, titleByte: string) => ({
      protocol_id: id,
      source_section: "3.1.1.9 辅助数据包",
      flow_direction: "input" as const,
      base_file_name: "辅助数据包",
      generation_mode: "single_file" as const,
      frames: Array.from({ length: 37 }, (_, index) => ({
        frame_id: `${id}-frame-${index + 1}`,
        sequence: index + 1,
        source_table_id: `table-${id}`,
        byte_layout: ["9D", "28", index.toString(16).toUpperCase().padStart(2, "0"), "FC", titleByte],
        field_layout: [],
      })),
      bus_context: {
        bus_type: "CAN" as const,
        interface_level: "primary" as const,
        evidence: ["oversized nested protocol evidence ".repeat(2_000)],
        warnings: ["oversized nested protocol warning ".repeat(2_000)],
      },
      fields: [],
      evidence: [`表3.1.1.9-${id === "auxiliary-1" ? "1" : "2"} 卫星发向相机管理控制器长度252字节的${title}`],
      warnings: [],
      confidence: 1,
      understanding_source: "model" as const,
    })
    const protocolDefinitions = createProtocolDefinitions(workspaceRoot, [
      protocol("auxiliary-1", "辅助数据包1", "60"),
      protocol("auxiliary-2", "辅助数据包2", "80"),
    ])

    const generated = await buildGeneratedStepWithPlanning({
      step: {
        stepIndex: 1,
        keywordName: "发送CANBTXT数据",
        stepDescription: "第1.0秒,通过CANA总线发送正确的辅助数据包1,共13帧发送",
      },
      caseContext: { caseId: "TC-JK-021", requirementIds: [], steps: [] },
      keywordDef: {
        keywordName: "发送CANBTXT数据",
        txtPath: "",
        jsonPath: "",
        arguments: [{ name: "${para2}", comments: "数据文件" }],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot),
      dataFileIndex: prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT),
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions,
    }, null)

    expect(generated.data_generation_plan?.protocol_id).toBe("auxiliary-1")
    expect(generated.generated_data_files[0].requested_file_name).toBe("S01-辅助数据包1-正常.txt")
    const outputLines = readFileSync(join(
      paths.inputDataRoot,
      INPUT_FLOW,
      "用例生成",
      "TC-JK-021",
      "S01-辅助数据包1-正常.txt",
    ), "utf-8").trim().split(/\r?\n/)
    expect(outputLines).toHaveLength(37)
    expect(outputLines[0]).toBe("9D 28 00 FC 60")
    expect(generated.data_quality?.issues).toContainEqual(expect.objectContaining({
      severity: "warning",
      type: "case_step_protocol_conflict",
    }))

    const sequenceFault = await buildGeneratedStepWithPlanning({
      step: {
        stepIndex: 2,
        keywordName: "发送CANBTXT数据",
        stepDescription: "第2.0秒,通过CANA总线发送辅助数据包1（中间帧帧序号错误即帧序号00H~05H、08H、07H~0CH,共13帧）",
      },
      caseContext: { caseId: "TC-JK-021", requirementIds: [], steps: [] },
      keywordDef: {
        keywordName: "发送CANBTXT数据",
        txtPath: "",
        jsonPath: "",
        arguments: [{ name: "${para2}", comments: "数据文件" }],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot),
      dataFileIndex: prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT),
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions,
    }, null)
    expect(sequenceFault.data_generation_plan?.sequence_operations).toEqual([])
    expect(sequenceFault.data_generation_plan?.mutations).toContainEqual({
      field: "FRAME_SEQUENCE",
      frame_index: 7,
      operation: "replace_with_invalid_value",
      value: "08",
    })
    const sequenceFaultLines = readFileSync(join(
      paths.inputDataRoot,
      INPUT_FLOW,
      "用例生成",
      "TC-JK-021",
      sequenceFault.generated_data_files[0].requested_file_name,
    ), "utf-8").trim().split(/\r?\n/)
    expect(sequenceFaultLines).toHaveLength(37)
    expect(sequenceFaultLines[6]).toBe("9D 28 08 FC 60")
  })

  test("renders a generic numbered protocol family as one ordered multi-packet file", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-ordered-protocol-group-${Date.now()}`)
    const paths = resolveDefaultPaths(workspaceRoot)
    mkdirSync(paths.inputDataRoot, { recursive: true })
    const packet = (
      id: string,
      tableTitle: string,
      arbitration: string,
      title: string,
      values: [string, string],
    ) => ({
      protocol_id: id,
      source_section: "3.1.1.9 卫星发向相机管理控制器长度252字节的辅助数据包1",
      flow_direction: "input" as const,
      base_file_name: "252字节辅助数据包",
      generation_mode: "single_file" as const,
      frames: [
        {
          frame_id: `${id}-frame-1`, sequence: 1, source_table_id: `table-${id}`,
          byte_layout: [arbitration, "04", "00", title, values[0]],
          field_layout: [
            { name: "ARBITRATION", role: "arbitration" as const, byte_offset: 0, byte_length: 1, default_value: arbitration },
            { name: "CONTROL", role: "control" as const, byte_offset: 1, byte_length: 1, default_value: "04" },
            { name: "FRAME_SEQUENCE", role: "sequence" as const, byte_offset: 2, byte_length: 1, default_value: "00" },
            { name: "TITLE", role: "title" as const, byte_offset: 3, byte_length: 1, default_value: title },
            { name: "W0", role: "data" as const, byte_offset: 4, byte_length: 1, default_value: values[0] },
          ],
          checksum: { type: "sum_low8" as const, start: "TITLE", end: "BEFORE_SUM" as const },
        },
        {
          frame_id: `${id}-frame-2`, sequence: 2, source_table_id: `table-${id}`,
          byte_layout: [arbitration, "04", "01", values[1], "SUM"],
          field_layout: [
            { name: "ARBITRATION", role: "arbitration" as const, byte_offset: 0, byte_length: 1, default_value: arbitration },
            { name: "CONTROL", role: "control" as const, byte_offset: 1, byte_length: 1, default_value: "04" },
            { name: "FRAME_SEQUENCE", role: "sequence" as const, byte_offset: 2, byte_length: 1, default_value: "01" },
            { name: "W1", role: "data" as const, byte_offset: 3, byte_length: 1, default_value: values[1] },
            { name: "SUM", role: "checksum" as const, byte_offset: 4, byte_length: 1 },
          ],
          checksum: { type: "sum_low8" as const, start: "TITLE", end: "BEFORE_SUM" as const },
        },
      ],
      bus_context: {
        bus_type: "CAN" as const,
        interface_level: "primary" as const,
        controller: "SJA1000T" as const,
        controller_family: "SJA1000" as const,
        mode: "PeliCAN" as const,
        frame_format: "standard" as const,
        frame_buffer_layout: "business-payload" as const,
        frame_information: { apply_to_case_data: true, strategy: "derive_from_ff_rtr_dlc" as const },
      },
      fields: [], evidence: [tableTitle], warnings: [], confidence: 1, understanding_source: "model" as const,
    })
    const rawDefinitions = createProtocolDefinitions(workspaceRoot, [
      packet("auxiliary-1", "表3.1.1.9-1 卫星发向相机管理控制器长度252字节的辅助数据包1", "8D", "60", ["01", "02"]),
      packet("auxiliary-2", "表3.1.1.9-2 卫星发向相机管理控制器长度252字节的辅助数据包2", "9D", "80", ["03", "04"]),
    ])
    rawDefinitions.sections = [{
      section_model_id: "section-auxiliary",
      section_title: "辅助数据包，每1s发送2个数据包，两个数据包间隔125ms",
      protocol_ids: ["auxiliary-1", "auxiliary-2"],
      warnings: [],
    }]
    const protocolDefinitions = migrateDtpProtocolDefinitionsDocument(rawDefinitions)
    expect(protocolDefinitions.protocol_groups).toEqual([expect.objectContaining({
      name: "辅助数据包",
      protocol_ids: ["auxiliary-1", "auxiliary-2"],
    })])
    expect(protocolDefinitions.protocol_families).toEqual(expect.arrayContaining([
      expect.objectContaining({
        composition: expect.objectContaining({
          type: "ordered_packets",
          members: [
            expect.objectContaining({ protocol_id: "auxiliary-1", order: 1, cardinality: "1" }),
            expect.objectContaining({ protocol_id: "auxiliary-2", order: 2, cardinality: "1" }),
          ],
        }),
      }),
    ]))

    let modelCalls = 0
    const generated = await buildGeneratedStepWithPlanning({
      step: {
        stepIndex: 1,
        keywordName: "发送CANATXT数据",
        stepDescription: "第1.0秒,通过CANA总线发送正确的辅助数据包",
      },
      caseContext: { caseId: "TC-AUXILIARY-GROUP", requirementIds: [], steps: [] },
      keywordDef: {
        keywordName: "发送CANATXT数据", txtPath: "", jsonPath: "",
        arguments: [{ name: "${para2}", comments: "数据文件" }],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot),
      dataFileIndex: prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT),
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions,
    }, {
      planCaseStepData: async () => {
        modelCalls += 1
        return null
      },
    })

    expect(modelCalls).toBe(0)
    expect(generated.data_generation_plan?.protocol_id).toBe(protocolDefinitions.protocol_groups?.[0].group_id)
    expect(generated.generated_data_files[0].requested_file_name).toBe("S01-辅助数据包-正常.txt")
    expect(readFileSync(join(
      paths.inputDataRoot,
      INPUT_FLOW,
      "用例生成",
      "TC-AUXILIARY-GROUP",
      "S01-辅助数据包-正常.txt",
    ), "utf-8").trim().split(/\r?\n/)).toEqual([
      "04 8D 04 00 60 01",
      "04 8D 04 01 02 63",
      "04 9D 04 00 80 03",
      "04 9D 04 01 04 87",
    ])
    expect(generated.data_quality?.status).toBe("pass")

    const explicitChild = await buildGeneratedStepWithPlanning({
      step: {
        stepIndex: 2,
        keywordName: "发送CANATXT数据",
        stepDescription: "第2.0秒,通过CANA总线发送正确的辅助数据包2",
      },
      caseContext: { caseId: "TC-AUXILIARY-CHILD", requirementIds: [], steps: [] },
      keywordDef: {
        keywordName: "发送CANATXT数据", txtPath: "", jsonPath: "",
        arguments: [{ name: "${para2}", comments: "数据文件" }],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot),
      dataFileIndex: prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT),
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions,
    }, null)
    expect(explicitChild.data_generation_plan?.protocol_id).toBe("auxiliary-2")
    expect(explicitChild.generated_data_files[0].requested_file_name).toBe("S02-辅助数据包2-正常.txt")
    expect(readFileSync(join(
      paths.inputDataRoot,
      INPUT_FLOW,
      "用例生成",
      "TC-AUXILIARY-CHILD",
      "S02-辅助数据包2-正常.txt",
    ), "utf-8").trim().split(/\r?\n/)).toEqual([
      "04 9D 04 00 80 03",
      "04 9D 04 01 04 87",
    ])

    const indexFault = await buildGeneratedStepWithPlanning({
      step: {
        stepIndex: 3,
        keywordName: "发送CANATXT数据",
        stepDescription: "第3.0秒,通过CANA总线发送辅助数据包（INDEX错误,其余字段正确）",
      },
      caseContext: { caseId: "TC-AUXILIARY-GROUP-INDEX", requirementIds: [], steps: [] },
      keywordDef: {
        keywordName: "发送CANATXT数据", txtPath: "", jsonPath: "",
        arguments: [{ name: "${para2}", comments: "数据文件" }],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot),
      dataFileIndex: prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT),
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions,
    }, null)
    expect(indexFault.generated_data_files[0].requested_file_name).toBe("S03-辅助数据包-首帧帧序号异常.txt")
    expect(readFileSync(join(
      paths.inputDataRoot,
      INPUT_FLOW,
      "用例生成",
      "TC-AUXILIARY-GROUP-INDEX",
      "S03-辅助数据包-首帧帧序号异常.txt",
    ), "utf-8").trim().split(/\r?\n/)).toEqual([
      "04 8D 04 01 60 01",
      "04 8D 04 01 02 63",
      "04 9D 04 00 80 03",
      "04 9D 04 01 04 87",
    ])
    expect(indexFault.data_quality?.status).toBe("pass")
  })

  test("scopes an unqualified grouped protocol fault to the first child packet", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-ordered-protocol-group-fault-${Date.now()}`)
    const paths = resolveDefaultPaths(workspaceRoot)
    mkdirSync(paths.inputDataRoot, { recursive: true })
    const packet = (id: string, name: string, arbitration: string) => ({
      protocol_id: id, source_section: name, flow_direction: "input" as const, base_file_name: name,
      generation_mode: "single_file" as const,
      frames: [{
        frame_id: `${id}-frame-1`, sequence: 1, source_table_id: `table-${id}`,
        byte_layout: [arbitration, "04", "00", "10", "SUM"],
        field_layout: [
          { name: "ARBITRATION", role: "arbitration" as const, byte_offset: 0, byte_length: 1, default_value: arbitration },
          { name: "CONTROL", role: "control" as const, byte_offset: 1, byte_length: 1, default_value: "04" },
          { name: "TITLE", role: "title" as const, byte_offset: 2, byte_length: 1, default_value: "00" },
          { name: "W0", role: "data" as const, byte_offset: 3, byte_length: 1, default_value: "10" },
          { name: "SUM", role: "checksum" as const, byte_offset: 4, byte_length: 1 },
        ],
        checksum: { type: "sum_low8" as const, start: "TITLE", end: "BEFORE_SUM" as const },
      }],
      bus_context: { bus_type: "CAN" as const, interface_level: "primary" as const },
      fields: [], evidence: [], warnings: [], confidence: 1, understanding_source: "model" as const,
    })
    const definitions = createProtocolDefinitions(workspaceRoot, [
      packet("auxiliary-1", "辅助数据包1", "8D"),
      packet("auxiliary-2", "辅助数据包2", "9D"),
    ])
    definitions.sections = [{
      section_model_id: "section-auxiliary", section_title: "辅助数据包，每1s发送2个数据包，两个数据包间隔125ms",
      protocol_ids: ["auxiliary-1", "auxiliary-2"], warnings: [],
    }]
    const protocolDefinitions = migrateDtpProtocolDefinitionsDocument(definitions)
    const generated = await buildGeneratedStepWithPlanning({
      step: {
        stepIndex: 2, keywordName: "发送CANATXT数据",
        stepDescription: "第2.0秒,通过CANA总线发送仲裁场错误的辅助数据包",
      },
      caseContext: { caseId: "TC-AUXILIARY-GROUP-FAULT", requirementIds: [], steps: [] },
      keywordDef: {
        keywordName: "发送CANATXT数据", txtPath: "", jsonPath: "",
        arguments: [{ name: "${para2}", comments: "数据文件" }],
      },
      inputDataRoot: paths.inputDataRoot, workspaceRoot,
      knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot),
      dataFileIndex: prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT),
      docsContext: EMPTY_DOCS_CONTEXT, protocolDefinitions,
    }, null)

    const output = readFileSync(join(
      paths.inputDataRoot,
      INPUT_FLOW,
      "用例生成",
      "TC-AUXILIARY-GROUP-FAULT",
      generated.generated_data_files[0].requested_file_name,
    ), "utf-8").trim().split(/\r?\n/)
    expect(output).toEqual(["8E 04 00 10 10", "9D 04 00 10 10"])
    expect(generated.data_generation_plan?.mutations).toContainEqual(expect.objectContaining({
      field: "ARBITRATION", frame_index: 1,
    }))
    expect(generated.warnings).toContainEqual(expect.stringContaining("first applicable frame of auxiliary-1"))
    expect(generated.data_quality?.status).toBe("pass")
  })

  test("accepts canonical_protocol_id from a supplemental model plan", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-case-canonical-protocol-id-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    mkdirSync(paths.inputDataRoot, { recursive: true })
    const protocol = (id: string, arbitration: string) => ({
      protocol_id: id,
      source_section: "CAN input",
      flow_direction: "input" as const,
      base_file_name: "同名控制序列",
      generation_mode: "single_file" as const,
      frames: [{
        frame_id: "frame-1", sequence: 1, source_table_id: `table-${id}`,
        byte_layout: [arbitration, "04", "00", "10", "01", "SUM"],
        field_layout: [
          { name: "ARBITRATION", role: "arbitration" as const, byte_offset: 0, byte_length: 1 },
          { name: "CONTROL", role: "control" as const, byte_offset: 1, byte_length: 1 },
          { name: "TITLE", role: "title" as const, byte_offset: 2, byte_length: 1 },
          { name: "W0", role: "data" as const, byte_offset: 3, byte_length: 1 },
          { name: "W1", role: "data" as const, byte_offset: 4, byte_length: 1 },
          { name: "SUM", role: "checksum" as const, byte_offset: 5, byte_length: 1 },
        ],
        checksum: { type: "sum_low8" as const, start: "TITLE", end: "BEFORE_SUM" },
      }],
      bus_context: { bus_type: "CAN" as const, interface_level: "primary" as const },
      fields: [], evidence: [], warnings: [], confidence: 1, understanding_source: "model" as const,
    })
    const protocolDefinitions = createProtocolDefinitions(workspaceRoot, [
      protocol("canonical-a", "8D"),
      protocol("canonical-b", "9D"),
    ])
    const knowledgeIndex = createEmptyKnowledgeIndex(workspaceRoot)
    knowledgeIndex.tables.push(
      {
        id: "table-canonical-a",
        source_document_id: "doc-1",
        caption: "同名控制序列 A",
        aliases: [],
        topic: "packet_structure",
        rows: [["仲裁场", "控制场", "TITLE", "W0", "W1", "SUM"], ["8D", "04", "00", "10", "01", "SUM"]],
        table_html: "<table><tr><td>仲裁场</td><td>控制场</td><td>TITLE</td><td>W0</td><td>W1</td><td>SUM</td></tr></table>",
        confidence: 1,
        warnings: [],
      },
      {
        id: "table-canonical-b",
        source_document_id: "doc-1",
        caption: "同名控制序列 B",
        aliases: [],
        topic: "packet_structure",
        rows: [["仲裁场", "控制场", "TITLE", "W0", "W1", "SUM"], ["9D", "04", "00", "10", "01", "SUM"]],
        confidence: 1,
        warnings: [],
      },
    )
    const fallbackProfiles = createDtpModelFallbackProfileRegistry()
    const fallbackEvidenceIndex = buildDtpModelFallbackEvidenceIndex(knowledgeIndex, protocolDefinitions, undefined)
    let planningInput: any
    const generated = await buildGeneratedStepWithPlanning({
      step: { stepIndex: 1, keywordName: "SendCANDataFile", stepDescription: "通过CANA总线发送同名控制序列" },
      caseContext: { caseId: "TC-CANONICAL-ID", requirementIds: [], steps: [] },
      keywordDef: { keywordName: "SendCANDataFile", txtPath: "", jsonPath: "", arguments: [{ name: "${para2}", comments: "数据文件" }] },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex,
      dataFileIndex: prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT),
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions,
      modelFallbackProfiles: fallbackProfiles,
      modelFallbackEvidenceIndex: fallbackEvidenceIndex,
    }, {
      planCaseStepData: async (input) => {
        planningInput = input
        return {
        canonical_protocol_id: "canonical-a",
        protocol_name: "同名控制序列",
        flow_direction: "input",
        variant_type: "correct",
        mutations: [],
        sequence_operations: [],
        checksum_policy: "recalculate_correctly",
        argument_values: {},
        evidence_ids: [],
        confidence: 1,
        warnings: [],
        } as any
      },
    })

    expect(generated.data_generation_plan?.protocol_id).toBe("canonical-a")
    expect(planningInput.model_fallback.profile.profile_id).toBe("primary-can")
    expect(planningInput.model_fallback.candidate_protocols.map((candidate: any) => candidate.protocol_id)).toEqual([
      "canonical-a",
      "canonical-b",
    ])
    expect(planningInput.model_fallback.evidence.map((item: any) => item.id)).toContain("table:table-canonical-a")
    expect(JSON.stringify(planningInput.model_fallback).length).toBeLessThanOrEqual(
      planningInput.model_fallback.profile.context_budget_chars,
    )
    expect(planningInput.model_fallback.candidate_protocols[0].bus_context.evidence).toBeUndefined()
    expect(generated.data_generation_plan?.model_fallback).toMatchObject({
      profile_id: "primary-can",
      candidate_protocol_ids: ["canonical-a", "canonical-b"],
    })
    expect(generated.generated_data_files[0].requested_file_name).not.toContain("待确认")
  })

  test("defaults a generic primary-CAN telemetry polling step to the first numbered telemetry frame", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-generic-telemetry-poll-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    mkdirSync(paths.inputDataRoot, { recursive: true })
    const protocol = (protocolId: string, name: string, marker: string) => ({
      protocol_id: protocolId,
      source_section: "3.1.1 primary CAN telemetry polling",
      flow_direction: "input" as const,
      base_file_name: name,
      generation_mode: "single_file" as const,
      frames: [{
        frame_id: "frame-1", sequence: 1, source_table_id: `table-${protocolId}`,
        byte_layout: ["8D", "04", "00", "10", marker, "SUM"],
        field_layout: [
          { name: "ARBITRATION", role: "arbitration" as const, byte_offset: 0, byte_length: 1, default_value: "8D" },
          { name: "CONTROL", role: "control" as const, byte_offset: 1, byte_length: 1, default_value: "04" },
          { name: "TITLE", role: "title" as const, byte_offset: 2, byte_length: 1, default_value: "00" },
          { name: "W0", role: "data" as const, byte_offset: 3, byte_length: 1, default_value: "10" },
          { name: "W1", role: "data" as const, byte_offset: 4, byte_length: 1, default_value: marker },
          { name: "SUM", role: "checksum" as const, byte_offset: 5, byte_length: 1 },
        ],
        checksum: { type: "sum_low8" as const, start: "TITLE", end: "BEFORE_SUM" },
      }],
      bus_context: { bus_type: "CAN" as const, interface_level: "primary" as const, interface_id: "IF-CAN0-001" },
      fields: [], evidence: [], warnings: [], confidence: 1, understanding_source: "model" as const,
    })
    const protocolDefinitions = createProtocolDefinitions(workspaceRoot, [
      protocol("telemetry-frame-1-poll", "遥测帧1轮询控制序列", "01"),
      protocol("telemetry-frame-2-poll", "遥测帧2轮询控制序列", "02"),
      protocol("memory-poll", "内存数据轮询控制序列", "61"),
    ])
    const generated = await buildGeneratedStepWithPlanning({
      step: { stepIndex: 1, keywordName: "SendCANDataFile", stepDescription: "第3.0秒,通过CANA总线发送遥测轮询控制序列" },
      caseContext: { caseId: "TC-GENERIC-TELEMETRY", requirementIds: [], steps: [] },
      keywordDef: { keywordName: "SendCANDataFile", txtPath: "", jsonPath: "", arguments: [{ name: "${para2}", comments: "数据文件" }] },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot),
      dataFileIndex: prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT),
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions,
    })

    expect(generated.data_generation_plan?.protocol_id).toBe("telemetry-frame-1-poll")
    expect(generated.data_generation_plan?.selection_source).toBe("document_order_default")
    expect(generated.generated_data_files[0].requested_file_name).toContain("遥测帧1轮询控制序列")
    expect(generated.generated_data_files[0].requested_file_name).not.toContain("待确认")
  })

  test("derives secondary CAN station fields and applies the FPGA prefix to every frame", () => {
    const workspaceRoot = join(tmpdir(), `dtp-case-secondary-can-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    mkdirSync(paths.inputDataRoot, { recursive: true })
    const dataFileIndex = prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT)
    const dynamicField = (name: string, role: "arbitration" | "title", byteOffset: number, base: string) => ({
      name, role, byte_offset: byteOffset, byte_length: 1,
      value_rule: { operation: "add_low8" as const, base, variable: "station_address" },
    })
    const dataFields = (start: number, count: number, offset: number) => Array.from({ length: count }, (_, index) => ({
      name: `W${start + index}`, role: "data" as const, byte_offset: offset + index, byte_length: 1, default_value: "00",
    }))
    const protocolDefinitions = createProtocolDefinitions(workspaceRoot, [{
      protocol_id: "secondary-three-frame-telemetry",
      source_section: "3.1.3.1 \u4e8c\u7ea7CAN\u9065\u6d4b\u8f6e\u8be2",
      flow_direction: "input",
      base_file_name: "3\u5e27\u9065\u6d4b\u6570\u636e",
      generation_mode: "single_file",
      frames: [
        {
          frame_id: "frame-1", sequence: 1, source_table_id: "table-3.1.3.1-3",
          byte_layout: ["DYNAMIC_STATION_ADDRESS", "68", "00", "12", "TITLE", "W0", "W1", "W2", "W3", "W4"],
          field_layout: [dynamicField("ARBITRATION", "arbitration", 0, "80"), { name: "CONTROL", role: "control", byte_offset: 1, byte_length: 1 }, { name: "FRAME_SEQUENCE", role: "sequence", byte_offset: 2, byte_length: 1 }, { name: "LENGTH", role: "length", byte_offset: 3, byte_length: 1 }, dynamicField("TITLE", "title", 4, "20"), ...dataFields(0, 5, 5)],
          checksum: { type: "sum_low8", start: "TITLE", end: "BEFORE_SUM" },
        },
        {
          frame_id: "frame-2", sequence: 2, source_table_id: "table-3.1.3.1-3",
          byte_layout: ["DYNAMIC_STATION_ADDRESS", "68", "01", "W5", "W6", "W7", "W8", "W9", "W10", "W11"],
          field_layout: [dynamicField("ARBITRATION", "arbitration", 0, "80"), { name: "CONTROL", role: "control", byte_offset: 1, byte_length: 1 }, { name: "FRAME_SEQUENCE", role: "sequence", byte_offset: 2, byte_length: 1 }, ...dataFields(5, 7, 3)],
          checksum: { type: "sum_low8", start: "TITLE", end: "BEFORE_SUM" },
        },
        {
          frame_id: "frame-3", sequence: 3, source_table_id: "table-3.1.3.1-3",
          byte_layout: ["DYNAMIC_STATION_ADDRESS", "68", "02", "W12", "W13", "W14", "W15", "W16", "W17", "SUM"],
          field_layout: [dynamicField("ARBITRATION", "arbitration", 0, "80"), { name: "CONTROL", role: "control", byte_offset: 1, byte_length: 1 }, { name: "FRAME_SEQUENCE", role: "sequence", byte_offset: 2, byte_length: 1 }, ...dataFields(12, 6, 3), { name: "SUM", role: "checksum", byte_offset: 9, byte_length: 1 }],
          checksum: { type: "sum_low8", start: "TITLE", end: "BEFORE_SUM" },
        },
      ],
      bus_context: { bus_type: "CAN", interface_level: "secondary", interface_id: "IF-CAN1-001", controller: "FPGA", profile_scope: "interface" },
      variables: [{ name: "station_address", display_name: "\u7ad9\u5730\u5740", type: "uint8", options: [{ value: "0C", label: "\u6d4b\u8bd5\u5355\u673a" }] }],
      frame_envelope: { type: "fixed_prefix", bytes: ["00", "08"], applies_per_frame: true },
      fields: [], evidence: [], warnings: [], confidence: 1, understanding_source: "model",
    }])
    const generated = buildGeneratedStep({
      step: { stepIndex: 1, keywordName: "SendCANDataFile", stepDescription: "\u7b2c1\u79d2,\u901a\u8fc7\u4e8c\u7ea7CAN\u603b\u7ebf\u53d1\u9001\u6d4b\u8bd5\u5355\u673a\u7684\u6b63\u786e3\u5e27\u9065\u6d4b\u6570\u636e" },
      caseContext: { caseId: "TC-SECONDARY-CAN", requirementIds: [], steps: [] },
      keywordDef: { keywordName: "SendCANDataFile", txtPath: "", jsonPath: "", arguments: [{ name: "${para2}", comments: "\u6570\u636e\u6587\u4ef6" }] },
      inputDataRoot: paths.inputDataRoot, workspaceRoot,
      knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot), dataFileIndex, docsContext: EMPTY_DOCS_CONTEXT, protocolDefinitions,
      dataGenerationPlan: { protocol_id: "secondary-three-frame-telemetry", protocol_name: "3\u5e27\u9065\u6d4b\u6570\u636e", flow_direction: "input", variant_type: "correct", mutations: [], sequence_operations: [], checksum_policy: "recalculate_correctly", argument_values: {}, evidence_ids: [], confidence: 1, warnings: [], source: "heuristic-fallback" },
    })

    const outputFile = join(paths.inputDataRoot, INPUT_FLOW, "\u7528\u4f8b\u751f\u6210", "TC-SECONDARY-CAN", generated.generated_data_files[0].requested_file_name)
    expect(readFileSync(outputFile, "utf-8").trim().split(/\r?\n/)).toEqual([
      "00 08 8C 68 00 12 2C 00 00 00 00 00",
      "00 08 8C 68 01 00 00 00 00 00 00 00",
      "00 08 8C 68 02 00 00 00 00 00 00 2C",
    ])
    expect(generated.generated_data_files[0].format_notes).toContain("Per-frame interface prefix: 00 08.")
    expect(generated.data_quality?.status).toBe("pass")
  })

  test("compiles station-address selector relations from a section support table", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-selector-table-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    const knowledgeIndex = createEmptyKnowledgeIndex(workspaceRoot)
    knowledgeIndex.source_documents = [{
      id: "doc-selector",
      path: join(workspaceRoot, "third-party-test-requirement.docx"),
      file_name: "third-party-test-requirement.docx",
      role: "primary-third-party-test-requirement",
      type: "docx",
      parse_state: "parsed",
      warnings: [],
    }, {
      id: "doc-spec",
      path: join(workspaceRoot, "software-requirement-specification.docx"),
      file_name: "software-requirement-specification.docx",
      role: "referenced-requirement-specification",
      type: "docx",
      parse_state: "parsed",
      warnings: [],
    }]
    knowledgeIndex.snippets = [{
      id: "selector-snippet",
      source_document_id: "doc-selector",
      topic: "hardware_interface",
      text: "3.1.3.1 二级CAN遥测轮询相关数据流。注：发送数据在每帧10字节前加0008H组成12字节FPGA格式帧。具体格式见需求规格说明附录G。",
      confidence: 1,
    }, {
      id: "telemetry-snippet",
      source_document_id: "doc-spec",
      topic: "hardware_interface",
      text: "附录G 二级CAN总线协议。",
      confidence: 1,
    }]
    knowledgeIndex.references = [{
      source_document_id: "doc-selector",
      source_snippet_id: "selector-snippet",
      reference_text: "见需求规格说明附录G",
      reference_type: "requirement-specification",
      target_kind: "appendix",
      resolved_document_id: "doc-spec",
      resolved_section_model_id: "secondary-telemetry-data-section",
      state: "resolved",
      confidence: 1,
      warnings: [],
    }]
    knowledgeIndex.tables = [
      {
        id: "station-table",
        source_document_id: "doc-selector",
        caption: "相机二级CAN总线站地址定义",
        aliases: [],
        topic: "hardware_interface",
        rows: [
          ["单机名称", "二级节点站地址", "遥测帧数"],
          ["四帧设备", "01H", "4"],
          ["三帧设备", "07H", "3"],
          ["管理控制器", "00H", "-"],
        ],
        confidence: 1,
        warnings: [],
      },
      {
        id: "telemetry-3-table",
        source_document_id: "doc-spec",
        caption: "3帧遥测数据格式定义",
        aliases: [],
        topic: "packet_structure",
        rows: [["帧序号", "仲裁场", "控制场"], ["1", "80H+站地址", "68H"]],
        confidence: 1,
        warnings: [],
      },
      {
        id: "telemetry-4-table",
        source_document_id: "doc-spec",
        caption: "4帧遥测数据格式定义",
        aliases: [],
        topic: "packet_structure",
        rows: [["帧序号", "仲裁场", "控制场"], ["1", "80H+站地址", "68H"]],
        confidence: 1,
        warnings: [],
      },
    ]
    knowledgeIndex.section_protocol_models = [{
      id: "secondary-telemetry-selector-section",
      source_document_id: "doc-selector",
      section_id: "3.1.3.1",
      section_title: "3.1.3.1 二级CAN遥测轮询相关数据流",
      section_path: ["3 数据及接口需求", "3.1.3 二级CAN总线接口"],
      section_snippet_ids: ["selector-snippet"],
      input_flow_snippet_ids: [],
      output_flow_snippet_ids: [],
      table_ids: ["station-table"],
      primary_table_ids: ["station-table"],
      support_table_ids: [],
      protocol_relations: [],
      protocols: [],
      confidence: 1,
      warnings: [],
    }, {
      id: "secondary-telemetry-data-section",
      source_document_id: "doc-spec",
      section_id: "appendix-G",
      section_title: "附录G 二级CAN总线协议",
      section_path: ["附录G 二级CAN总线协议"],
      section_snippet_ids: ["telemetry-snippet"],
      input_flow_snippet_ids: ["telemetry-snippet"],
      output_flow_snippet_ids: [],
      table_ids: ["telemetry-3-table", "telemetry-4-table"],
      primary_table_ids: ["telemetry-3-table", "telemetry-4-table"],
      support_table_ids: [],
      protocol_relations: [],
      protocols: [],
      confidence: 1,
      warnings: [],
    }]
    const rawProtocol = (protocolId: string, tableId: string, frameCount: number) => ({
      protocol_id: protocolId,
      source_section: "3.1.3.1 二级CAN遥测轮询相关数据流",
      flow_direction: "input",
      base_file_name: `${frameCount}帧遥测数据`,
      generation_mode: "single_file",
      frames: Array.from({ length: frameCount }, (_, index) => ({
        frame_id: `frame-${index + 1}`,
        sequence: index + 1,
        source_table_id: tableId,
        byte_layout: ["80", "68", index.toString(16).padStart(2, "0"), "00"],
        field_layout: [],
        checksum: { type: "none" },
      })),
      bus_context: { bus_type: "CAN", interface_level: "secondary", interface_id: "IF-CAN1-001" },
      fields: [],
      evidence: [tableId, `${frameCount}帧遥测数据格式定义`],
      warnings: [],
      confidence: 1,
    })

    const definitions = await buildDtpProtocolDefinitionsDocument(paths, knowledgeIndex, {
      understandSectionProtocols: async (context) => ({
        protocols: context.section_model_id === "secondary-telemetry-data-section"
          ? [
              rawProtocol("secondary-telemetry-3", "telemetry-3-table", 3),
              rawProtocol("secondary-telemetry-4", "telemetry-4-table", 4),
            ]
          : [{
              ...rawProtocol("secondary-interface-envelope", "station-table", 1),
              base_file_name: "二级CAN物理封装",
              frame_envelope: {
                type: "fixed_prefix",
                bytes: ["00", "08"],
                applies_per_frame: true,
                position: "before_frame",
                raw_value: "0008H",
                business_frame_length: 10,
                wire_frame_length: 12,
              },
            }],
        selector_relations: [{
          relation_id: "model-device-selector",
          selector_name: "设备编码",
          selector_aliases: ["设备号"],
          selector_type: "uint8",
          protocol_family: "telemetry",
          mappings: [{
            selector_value: "A1H",
            target_protocol_id: context.section_model_id === "secondary-telemetry-data-section"
              ? "secondary-telemetry-4"
              : "missing-protocol",
            target_frame_count: 4,
            evidence: ["正文说明设备编码A1H采用4帧遥测格式"],
          }],
          evidence: ["正文说明设备编码决定遥测格式"],
          confidence: 0.82,
          warnings: [],
        }],
        non_generated_tables: [],
        warnings: [],
      }),
    })

    expect(definitions.selector_relations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        selector_name: "二级节点站地址",
        protocol_family: "telemetry",
        source: "table",
        mappings: expect.arrayContaining([
          expect.objectContaining({ selector_value: "01", target_protocol_id: "secondary-telemetry-4", target_frame_count: 4 }),
          expect.objectContaining({ selector_value: "07", target_protocol_id: "secondary-telemetry-3", target_frame_count: 3 }),
        ]),
      }),
      expect.objectContaining({
        relation_id: "model-device-selector",
        selector_name: "设备编码",
        source: "model",
        mappings: [expect.objectContaining({
          selector_value: "A1",
          target_protocol_id: "secondary-telemetry-4",
        })],
      }),
    ]))
    expect(definitions.protocols.find((protocol) => protocol.protocol_id === "secondary-telemetry-4")?.frame_envelope)
      .toEqual(expect.objectContaining({ bytes: ["00", "08"], applies_per_frame: true }))
    expect(definitions.interface_envelopes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        bus_type: "CAN",
        interface_level: "secondary",
        source_document_ids: expect.arrayContaining(["doc-selector", "doc-spec"]),
      }),
    ]))
    expect(definitions.protocol_families).toEqual(expect.arrayContaining([
      expect.objectContaining({
        bus_type: "CAN",
        interface_level: "secondary",
        semantic_role: "telemetry",
        selectors: expect.arrayContaining([
          expect.objectContaining({
            selector_aliases: expect.arrayContaining(["二级节点站地址", "站地址"]),
            mappings: expect.arrayContaining([
              expect.objectContaining({ selector_value: "01", target_frame_count: 4 }),
              expect.objectContaining({ selector_value: "07", target_frame_count: 3 }),
            ]),
          }),
        ]),
      }),
    ]))
  })

  test("uses a selector relation to choose the four-frame secondary CAN telemetry protocol", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-case-selector-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    mkdirSync(paths.inputDataRoot, { recursive: true })
    const makeProtocol = (protocolId: string, frameCount: number) => ({
      protocol_id: protocolId,
      source_section: "3.1.3.1 二级CAN遥测轮询相关数据流",
      flow_direction: "input" as const,
      base_file_name: frameCount === 3 ? "遥测数据" : "4帧遥测数据",
      generation_mode: "single_file" as const,
      frames: Array.from({ length: frameCount }, (_, index) => ({
        frame_id: `frame-${index + 1}`,
        sequence: index + 1,
        source_table_id: `telemetry-${frameCount}-table`,
        byte_layout: ["81", "68", index.toString(16).padStart(2, "0"), "21"],
        field_layout: [],
        checksum: { type: "none" as const },
      })),
      bus_context: { bus_type: "CAN" as const, interface_level: "secondary" as const, interface_id: "IF-CAN1-001" },
      fields: [], evidence: [`${frameCount}帧遥测数据格式定义`], warnings: [], confidence: 1,
      understanding_source: "model" as const,
    })
    const protocolDefinitions: DtpProtocolDefinitionsDocument = {
      ...createProtocolDefinitions(workspaceRoot, [
        makeProtocol("secondary-telemetry-3", 3),
        makeProtocol("secondary-telemetry-4", 4),
      ]),
      selector_relations: [{
        relation_id: "secondary-telemetry-station-selector",
        section_model_id: "secondary-telemetry-section",
        selector_name: "站地址",
        selector_aliases: ["节点地址", "终端地址"],
        selector_type: "uint8",
        protocol_family: "telemetry",
        bus_type: "CAN",
        interface_level: "secondary",
        interface_id: "IF-CAN1-001",
        mappings: [
          { selector_value: "01", target_protocol_id: "secondary-telemetry-4", target_frame_count: 4, evidence: ["station-table"] },
          { selector_value: "07", target_protocol_id: "secondary-telemetry-3", target_frame_count: 3, evidence: ["station-table"] },
        ],
        evidence: ["station-table"],
        source: "table",
        confidence: 1,
        warnings: [],
      }],
    }
    const fourFrameProtocol = protocolDefinitions.protocols.find((protocol) => (
      protocol.protocol_id === "secondary-telemetry-4"
    ))!
    fourFrameProtocol.base_file_name = "4帧遥测"
    fourFrameProtocol.semantic_identity = {
      canonical_name: "4帧遥测",
      normalized_name: "4帧遥测",
      role: "telemetry",
      entity: "遥测数据",
    }
    fourFrameProtocol.evidence = ["4帧遥测数据格式定义 (doc-1-table-33)"]
    const generated = await buildGeneratedStepWithPlanning({
      step: {
        stepIndex: 1,
        keywordName: "发送二级CANTXT数据",
        stepDescription: "第3.1秒，通过二级CAN总线发送站地址01H的正确的遥测数据。",
      },
      caseContext: { caseId: "TC-JK-007", requirementIds: [], steps: [] },
      keywordDef: { keywordName: "发送二级CANTXT数据", txtPath: "", jsonPath: "", arguments: [{ name: "${para2}", comments: "数据文件" }] },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot),
      dataFileIndex: prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT),
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions,
    })

    expect(generated.data_generation_plan).toMatchObject({
      protocol_id: "secondary-telemetry-4",
      selection_source: "selector_relation",
      deterministic_generation: true,
    })
    expect(generated.data_generation_plan?.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("secondary-telemetry-station-selector selected secondary-telemetry-4"),
    ]))
    const outputFile = join(
      paths.inputDataRoot,
      INPUT_FLOW,
      "用例生成",
      "TC-JK-007",
      generated.generated_data_files[0].requested_file_name,
    )
    expect(readFileSync(outputFile, "utf-8").trim().split(/\r?\n/)).toHaveLength(4)
    expect(generated.generated_data_files[0].requested_file_name).toBe("S01-4帧遥测数据-正常.txt")
    expect(generated.generated_data_files[0].requested_file_name).not.toContain("doc-1-table-33")
  })

  test("deduplicates physically identical protocol definitions before model fallback", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-case-equivalent-protocol-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    mkdirSync(paths.inputDataRoot, { recursive: true })
    const makeProtocol = (protocolId: string, sourceSection: string) => ({
      protocol_id: protocolId,
      source_section: sourceSection,
      flow_direction: "input" as const,
      base_file_name: "9、补偿镜控制器参数上注数据包格式",
      generation_mode: "single_file" as const,
      frames: [{
        frame_id: `${protocolId}-frame`,
        sequence: 1,
        source_table_id: `${protocolId}-table`,
        byte_layout: ["8D", "08", "00", ...Array.from({ length: 68 }, () => "00"), "SUM"],
        field_layout: [
          { name: "ARBITRATION", role: "arbitration" as const, byte_offset: 0, byte_length: 1, default_value: "8D" },
          { name: "CONTROL", role: "control" as const, byte_offset: 1, byte_length: 1, default_value: "08" },
          { name: "TITLE", role: "title" as const, byte_offset: 2, byte_length: 1, default_value: "00" },
          { name: "W0", role: "data" as const, byte_offset: 3, byte_length: 1, default_value: "10" },
          { name: "SUM", role: "checksum" as const, byte_offset: 71, byte_length: 1 },
        ],
        checksum: { type: "sum_low8" as const, start: "TITLE", end: "BEFORE_SUM" },
      }],
      bus_context: { bus_type: "CAN" as const, interface_level: "primary" as const },
      fields: [],
      evidence: [sourceSection],
      warnings: [],
      confidence: 0.9,
      understanding_source: "model" as const,
    })
    const protocolDefinitions = createProtocolDefinitions(workspaceRoot, [
      makeProtocol("section-protocol-12-10", "3.1.1 一级CAN上行数据块"),
      makeProtocol("section-protocol-13-10", "3.1.1 一级CAN上行数据块"),
    ])
    const generated = await buildGeneratedStepWithPlanning({
      step: {
        stepIndex: 2,
        keywordName: "发送CANATXT数据",
        stepDescription: "第2.0秒，通过CANA总线发送首帧仲裁场错误的72字节上行数据块",
      },
      caseContext: { caseId: "TC-JK-017", requirementIds: [], steps: [] },
      keywordDef: {
        keywordName: "发送CANATXT数据",
        txtPath: "",
        jsonPath: "",
        arguments: [{ name: "${para2}", comments: "数据文件" }],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot),
      dataFileIndex: prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT),
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions,
    }, {
      planCaseStepData: async () => ({
        protocol_name: "72字节上行数据块",
        payload_length_bytes: 72,
        flow_direction: "input",
        bus: "CAN",
        variant_type: "arbitration_error",
        mutations: [{ field: "ARBITRATION", frame_index: 1, operation: "replace_with_invalid_value" }],
        sequence_operations: [],
        checksum_policy: "recalculate_correctly",
        argument_values: {},
        evidence_ids: [],
        confidence: 0.8,
        warnings: [],
      }),
    })

    expect(generated.data_generation_plan?.protocol_id).toBe("section-protocol-12-10")
    expect(generated.data_quality?.issues.some((issue) => issue.type === "protocol_ambiguous")).toBe(false)
    expect(generated.generated_data_files[0].requested_file_name)
      .toBe("S02-72字节上行数据块-首帧仲裁场异常.txt")
    expect(generated.generated_data_files[0].requested_file_name).not.toContain("9、")
  })

  test("keeps selector consensus inside the four-frame protocol variants", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-case-selector-family-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    mkdirSync(paths.inputDataRoot, { recursive: true })
    const makeProtocol = (protocolId: string, frameCount: number, title: string, baseFileName: string) => ({
      protocol_id: protocolId,
      source_section: "3.1.3.1 二级CAN遥测轮询相关数据流",
      flow_direction: "input" as const,
      base_file_name: baseFileName,
      generation_mode: "single_file" as const,
      frames: Array.from({ length: frameCount }, (_, index) => ({
        frame_id: `${protocolId}-frame-${index + 1}`,
        sequence: index + 1,
        source_table_id: `${protocolId}-table`,
        byte_layout: ["81", "68", index.toString(16).padStart(2, "0"), title],
        field_layout: [],
        checksum: { type: "none" as const },
      })),
      bus_context: { bus_type: "CAN" as const, interface_level: "secondary" as const, interface_id: "IF-CAN1-001" },
      fields: [], evidence: [`${frameCount}帧遥测数据格式定义`], warnings: [], confidence: 1,
      understanding_source: "model" as const,
    })
    const protocolDefinitions = migrateDtpProtocolDefinitionsDocument({
      ...createProtocolDefinitions(workspaceRoot, [
        makeProtocol("telemetry-3", 3, "31", "遥测数据"),
        makeProtocol("telemetry-4-a", 4, "41", "遥测数据"),
        makeProtocol("telemetry-4-b", 4, "42", "工程参数数据"),
      ]),
      selector_relations: [{
        relation_id: "station-selector-table", section_model_id: "section", selector_name: "站地址",
        selector_aliases: ["节点地址"], selector_type: "uint8", protocol_family: "telemetry", bus_type: "CAN",
        interface_level: "secondary", interface_id: "IF-CAN1-001",
        mappings: [{ selector_value: "01", target_protocol_id: "telemetry-4-a", target_frame_count: 4, evidence: ["station-table"] }],
        evidence: ["station-table"], source: "table", confidence: 1, warnings: [],
      }, {
        relation_id: "station-selector-model", section_model_id: "section", selector_name: "二级节点站地址",
        selector_aliases: ["终端地址"], selector_type: "uint8", protocol_family: "telemetry", bus_type: "CAN",
        interface_level: "secondary", interface_id: "IF-CAN1-001",
        mappings: [{ selector_value: "01", target_protocol_id: "telemetry-4-b", target_frame_count: 4, evidence: ["section-text"] }],
        evidence: ["section-text"], source: "model", confidence: 0.9, warnings: [],
      }],
    })
    const generated = await buildGeneratedStepWithPlanning({
      step: { stepIndex: 1, keywordName: "发送二级CANTXT数据", stepDescription: "通过二级CAN总线发送站地址01H的正确遥测数据" },
      caseContext: { caseId: "TC-SELECTOR-FAMILY", requirementIds: [], steps: [] },
      keywordDef: { keywordName: "发送二级CANTXT数据", txtPath: "", jsonPath: "", arguments: [{ name: "${para2}", comments: "数据文件" }] },
      inputDataRoot: paths.inputDataRoot, workspaceRoot, knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot),
      dataFileIndex: prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT), docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions,
      dataGenerationPlan: {
        protocol_id: "telemetry-3", protocol_name: "遥测数据", flow_direction: "input", bus: "CAN",
        variant_type: "correct", mutations: [], sequence_operations: [], checksum_policy: "none",
        argument_values: {}, evidence_ids: [], confidence: 0.8, warnings: [], source: "heuristic-fallback",
      },
    }, null)

    expect(generated.data_generation_plan?.protocol_id).toMatch(/^telemetry-4-/)
    expect(generated.data_generation_plan?.selection_source).toBe("selector_relation")
    expect(generated.data_generation_plan?.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("frame_count=4"),
    ]))
    const outputFile = join(
      paths.inputDataRoot,
      INPUT_FLOW,
      "用例生成",
      "TC-SELECTOR-FAMILY",
      generated.generated_data_files[0].requested_file_name,
    )
    expect(readFileSync(outputFile, "utf-8").trim().split(/\r?\n/)).toHaveLength(4)
    const family = protocolDefinitions.protocol_families?.find((item) => item.semantic_role === "telemetry")
    expect(family?.selectors[0].mappings).toContainEqual(expect.objectContaining({
      selector_value: "01",
      target_frame_count: 4,
      variant_keys: expect.arrayContaining([
        expect.stringContaining("frame_count_4_"),
      ]),
    }))
  })

  test("keeps protocol selection ambiguous when selector mappings conflict", () => {
    const workspaceRoot = join(tmpdir(), `dtp-case-selector-conflict-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    mkdirSync(paths.inputDataRoot, { recursive: true })
    const makeProtocol = (protocolId: string, frameCount: number) => ({
      protocol_id: protocolId,
      source_section: "二级CAN遥测",
      flow_direction: "input" as const,
      base_file_name: "遥测数据",
      generation_mode: "single_file" as const,
      frames: Array.from({ length: frameCount }, (_, index) => ({
        frame_id: `frame-${index + 1}`, sequence: index + 1, source_table_id: `table-${frameCount}`,
        byte_layout: ["81", "68", "00"], field_layout: [], checksum: { type: "none" as const },
      })),
      bus_context: { bus_type: "CAN" as const, interface_level: "secondary" as const },
      fields: [], evidence: ["遥测数据"], warnings: [], confidence: 1, understanding_source: "model" as const,
    })
    const protocolDefinitions: DtpProtocolDefinitionsDocument = {
      ...createProtocolDefinitions(workspaceRoot, [makeProtocol("telemetry-3", 3), makeProtocol("telemetry-4", 4)]),
      selector_relations: [{
        relation_id: "conflicting-selector", section_model_id: "section", selector_name: "站地址",
        selector_aliases: [], selector_type: "uint8", protocol_family: "telemetry", bus_type: "CAN",
        interface_level: "secondary",
        mappings: [
          { selector_value: "01", target_protocol_id: "telemetry-3", evidence: [] },
          { selector_value: "01", target_protocol_id: "telemetry-4", evidence: [] },
        ],
        evidence: [], source: "model", confidence: 0.5, warnings: ["conflict fixture"],
      }],
    }
    const generated = buildGeneratedStep({
      step: { stepIndex: 1, keywordName: "发送二级CANTXT数据", stepDescription: "通过二级CAN总线发送站地址01H的遥测数据" },
      caseContext: { caseId: "TC-CONFLICT", requirementIds: [], steps: [] },
      keywordDef: { keywordName: "发送二级CANTXT数据", txtPath: "", jsonPath: "", arguments: [{ name: "${para2}", comments: "数据文件" }] },
      inputDataRoot: paths.inputDataRoot, workspaceRoot, knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot),
      dataFileIndex: prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT), docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions,
      dataGenerationPlan: {
        protocol_name: "遥测数据", flow_direction: "input", bus: "CAN", variant_type: "correct",
        mutations: [], sequence_operations: [], checksum_policy: "none", argument_values: {}, evidence_ids: [],
        confidence: 0.8, warnings: [], source: "heuristic-fallback",
      },
    })

    expect(generated.data_generation_plan?.protocol_id).toBeUndefined()
    expect(generated.data_quality?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "error", type: "protocol_ambiguous" }),
    ]))
  })

  test("matches an SPI command ADDRESS to a response ADDRESS by documented station bits", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-spi-station-selector-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    mkdirSync(paths.inputDataRoot, { recursive: true })
    const makeResponse = (id: string, address: string) => ({
      protocol_id: id,
      source_section: "3.1.4.1 SPI机构控制指令应答",
      flow_direction: "input" as const,
      base_file_name: "机构控制指令应答",
      generation_mode: "single_file" as const,
      frames: [{
        frame_id: "response", sequence: 1, source_table_id: `${id}-table`,
        byte_layout: [address, "01", "A5", "01"],
        field_layout: [
          { name: "ADDRESS", role: "address" as const, byte_offset: 0, byte_length: 1, default_value: address },
          { name: "STATION_ADDRESS", role: "address" as const, byte_offset: 0, byte_length: 1, bit_offset: 3, bit_length: 5 },
          { name: "MESSAGE_TYPE", role: "type" as const, byte_offset: 0, byte_length: 1, bit_offset: 0, bit_length: 3 },
        ],
        checksum: { type: "none" as const },
      }],
      bus_context: { bus_type: "SPI" as const, controller: "FPGA" },
      fields: [], evidence: [], warnings: [], confidence: 1, understanding_source: "model" as const,
    })
    const protocolDefinitions: DtpProtocolDefinitionsDocument = {
      ...createProtocolDefinitions(workspaceRoot, [
        makeResponse("spi-response-5b", "5B"),
        makeResponse("spi-response-63", "63"),
      ]),
      selector_relations: [{
        relation_id: "spi-response-station-selector",
        section_model_id: "spi-response-section",
        selector_name: "站地址",
        selector_aliases: [],
        selector_type: "uint8",
        protocol_family: "response",
        bus_type: "SPI",
        mappings: [
          { selector_value: "5B", target_protocol_id: "spi-response-5b", evidence: [] },
          { selector_value: "63", target_protocol_id: "spi-response-63", evidence: [] },
        ],
        evidence: [], source: "table", confidence: 1, warnings: [],
      }],
    }
    const generated = await buildGeneratedStepWithPlanning({
      step: { stepIndex: 1, keywordName: "发送SPI数据", stepDescription: "通过SPI总线发送站地址59H的机构控制指令应答，全部字段正确" },
      caseContext: { caseId: "TC-SPI-STATION", requirementIds: [], steps: [] },
      keywordDef: { keywordName: "发送SPI数据", txtPath: "", jsonPath: "", arguments: [{ name: "${para2}", comments: "数据文件" }] },
      inputDataRoot: paths.inputDataRoot, workspaceRoot,
      knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot), dataFileIndex: prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT),
      docsContext: EMPTY_DOCS_CONTEXT, protocolDefinitions,
      dataGenerationPlan: {
        protocol_name: "机构控制指令应答", flow_direction: "input", bus: "SPI", variant_type: "correct",
        mutations: [], sequence_operations: [], checksum_policy: "none", argument_values: {}, evidence_ids: [],
        confidence: 1, warnings: [], source: "heuristic-fallback",
      },
    })

    expect(generated.data_generation_plan?.protocol_id).toBe("spi-response-5b")
    const output = generated.generated_data_files[0]
    expect(readFileSync(join(paths.inputDataRoot, output.file_path.replace(/^输入数据[\\/]/, "")), "utf-8").trim())
      .toBe("5B 01 A5 01")
  })

  test("defaults an explicit CAN TITLE/SUM layout to low-byte SUM before adding PeliCAN Frame Information", () => {
    const workspaceRoot = join(tmpdir(), `dtp-case-pelican-fi-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    mkdirSync(paths.inputDataRoot, { recursive: true })
    const dataFileIndex = prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT)
    const protocolDefinitions = createProtocolDefinitions(workspaceRoot, [
      {
        protocol_id: "telemetry-pelican",
        source_section: "CAN telemetry",
        flow_direction: "input",
        base_file_name: "TelemetryFrame",
        generation_mode: "single_file",
        frames: [
          {
            frame_id: "frame-1",
            sequence: 1,
            source_table_id: "table-telemetry",
            byte_layout: ["8D", "04", "00", "10", "01", "SUM"],
            field_layout: [
              { name: "ARBITRATION", role: "arbitration", byte_offset: 0, byte_length: 1 },
              { name: "CONTROL", role: "control", byte_offset: 1, byte_length: 1 },
              { name: "RTR", role: "control", byte_offset: 1, byte_length: 1, bit_offset: 4, bit_length: 1 },
              { name: "DLC", role: "length", byte_offset: 1, byte_length: 1, bit_offset: 0, bit_length: 4 },
              { name: "TITLE", role: "title", byte_offset: 2, byte_length: 1 },
              { name: "W0", role: "data", byte_offset: 3, byte_length: 1 },
              { name: "W1", role: "data", byte_offset: 4, byte_length: 1 },
              { name: "SUM", role: "checksum", byte_offset: 5, byte_length: 1 },
            ],
            checksum: {
              type: "unknown",
              start: "unknown",
              end: "unknown",
              expression: "The frame marks SUM but does not define a specialized checksum algorithm.",
            },
          },
        ],
        bus_context: {
          bus_type: "CAN",
          controller: "SJA1000T",
          controller_family: "SJA1000",
          mode: "PeliCAN",
          frame_format: "standard",
          frame_buffer_layout: "business-payload",
          frame_information: {
            apply_to_case_data: true,
            strategy: "derive_from_ff_rtr_dlc",
          },
        },
        fields: [],
        evidence: ["SJA1000T PeliCAN"],
        warnings: [],
        confidence: 1,
        understanding_source: "model",
      },
    ])
    const generated = buildGeneratedStep({
      step: {
        stepIndex: 1,
        keywordName: "SendCANDataFile",
        stepDescription: "Send the correct TelemetryFrame",
      },
      caseContext: {
        caseId: "TC-PELICAN-001",
        testPurpose: "Verify PeliCAN Frame Information",
        correspondFunId: "TR-PELICAN-001",
        requirementIds: ["TR-PELICAN-001"],
        steps: [],
      },
      keywordDef: {
        keywordName: "SendCANDataFile",
        txtPath: "",
        jsonPath: "",
        arguments: [{ name: "${para2}", comments: "数据文件" }],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot),
      dataFileIndex,
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions,
      dataGenerationPlan: {
        protocol_name: "TelemetryFrame",
        flow_direction: "input",
        variant_type: "correct",
        mutations: [],
        sequence_operations: [],
        checksum_policy: "preserve",
        argument_values: {},
        evidence_ids: ["TR-PELICAN-001:input-flow"],
        confidence: 1,
        warnings: [],
        source: "heuristic-fallback",
      },
    })

    const outputFile = join(
      paths.inputDataRoot,
      INPUT_FLOW,
      "\u7528\u4f8b\u751f\u6210",
      "TC-PELICAN-001",
      generated.generated_data_files[0].requested_file_name,
    )
    expect(readFileSync(outputFile, "utf-8").trim()).toBe("04 8D 04 00 10 01 11")
    expect(generated.generated_data_files[0].format_notes).toContain("PeliCAN Frame Information: 04.")
    expect(generated.data_generation_plan?.checksum_policy).toBe("recalculate_correctly")
    expect(generated.data_quality?.status).toBe("pass")
  })

  test("discards cached trailing CAN placeholders beyond the explicit DLC before transport encoding", () => {
    const workspaceRoot = join(tmpdir(), `dtp-case-can-dlc-tail-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    mkdirSync(paths.inputDataRoot, { recursive: true })
    const dataFileIndex = prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT)
    const protocolDefinitions = createProtocolDefinitions(workspaceRoot, [
      {
        protocol_id: "telemetry-cached-placeholder-tail",
        source_section: "CAN telemetry",
        flow_direction: "input",
        base_file_name: "TelemetryFrame",
        generation_mode: "single_file",
        frames: [
          {
            frame_id: "frame-1",
            sequence: 1,
            source_table_id: "table-telemetry",
            byte_layout: ["8D", "04", "00", "10", "01", "SUM", "00", "00", "00", "00"],
            field_layout: [
              { name: "ARBITRATION", role: "arbitration", byte_offset: 0, byte_length: 1 },
              { name: "CONTROL", role: "control", byte_offset: 1, byte_length: 1 },
              { name: "RTR", role: "control", byte_offset: 1, byte_length: 1, bit_offset: 4, bit_length: 1 },
              { name: "DLC", role: "length", byte_offset: 1, byte_length: 1, bit_offset: 0, bit_length: 4 },
              { name: "TITLE", role: "title", byte_offset: 2, byte_length: 1 },
              { name: "W0", role: "data", byte_offset: 3, byte_length: 1 },
              { name: "W1", role: "data", byte_offset: 4, byte_length: 1 },
              { name: "SUM", role: "checksum", byte_offset: 5, byte_length: 1 },
              { name: "UNUSED", role: "reserved", byte_offset: 6, byte_length: 1, default_value: "00", source_text: "-" },
              { name: "UNUSED", role: "reserved", byte_offset: 7, byte_length: 1, default_value: "00", source_text: "-" },
              { name: "UNUSED", role: "reserved", byte_offset: 8, byte_length: 1, default_value: "00", source_text: "-" },
              { name: "UNUSED", role: "reserved", byte_offset: 9, byte_length: 1, default_value: "00", source_text: "-" },
            ],
            checksum: {
              type: "sum_low8",
              start: "TITLE",
              end: "BEFORE_SUM",
              expression: "SUM is the low byte of TITLE through the byte before SUM.",
            },
          },
        ],
        bus_context: {
          bus_type: "CAN",
          controller: "SJA1000T",
          controller_family: "SJA1000",
          mode: "PeliCAN",
          frame_format: "standard",
          frame_buffer_layout: "business-payload",
          frame_information: {
            apply_to_case_data: true,
            strategy: "derive_from_ff_rtr_dlc",
          },
        },
        fields: [],
        evidence: ["SJA1000T PeliCAN"],
        warnings: [],
        confidence: 1,
        understanding_source: "model",
      },
    ])
    const generated = buildGeneratedStep({
      step: {
        stepIndex: 1,
        keywordName: "SendCANDataFile",
        stepDescription: "Send the correct TelemetryFrame",
      },
      caseContext: {
        caseId: "TC-CAN-DLC-TAIL-001",
        testPurpose: "Verify cached CAN placeholder repair",
        correspondFunId: "TR-CAN-DLC-TAIL-001",
        requirementIds: ["TR-CAN-DLC-TAIL-001"],
        steps: [],
      },
      keywordDef: {
        keywordName: "SendCANDataFile",
        txtPath: "",
        jsonPath: "",
        arguments: [{ name: "${para2}", comments: "data file" }],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot),
      dataFileIndex,
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions,
      dataGenerationPlan: {
        protocol_name: "TelemetryFrame",
        flow_direction: "input",
        variant_type: "correct",
        mutations: [],
        sequence_operations: [],
        checksum_policy: "recalculate_correctly",
        argument_values: {},
        evidence_ids: ["TR-CAN-DLC-TAIL-001:input-flow"],
        confidence: 1,
        warnings: [],
        source: "heuristic-fallback",
      },
    })

    const outputFile = join(
      paths.inputDataRoot,
      INPUT_FLOW,
      "\u7528\u4f8b\u751f\u6210",
      "TC-CAN-DLC-TAIL-001",
      generated.generated_data_files[0].requested_file_name,
    )
    expect(readFileSync(outputFile, "utf-8").trim()).toBe("04 8D 04 00 10 01 11")
    expect(generated.generated_data_files[0].format_notes).toContain(
      "Frame 1 discarded 4 trailing CAN placeholder byte(s) beyond DLC 4.",
    )
    expect(generated.data_quality?.issues.some((issue) => issue.code === "dlc_mismatch")).toBe(false)
  })

  test("repairs cached CAN protocols whose explicit SUM layout was stored as unknown", () => {
    const workspaceRoot = join(tmpdir(), `dtp-can-default-sum-cache-${Date.now()}`)
    const definitions = createProtocolDefinitions(workspaceRoot, [
      {
        protocol_id: "cached-can-sum",
        source_section: "CAN input flow",
        flow_direction: "input",
        base_file_name: "TelemetryFrame",
        generation_mode: "single_file",
        frames: [{
          frame_id: "frame-1",
          sequence: 1,
          source_table_id: "table-telemetry",
          byte_layout: ["8D", "04", "00", "10", "01", "SUM"],
          field_layout: [
            { name: "ARBITRATION", role: "arbitration", byte_offset: 0, byte_length: 1 },
            { name: "CONTROL", role: "control", byte_offset: 1, byte_length: 1 },
            { name: "TITLE", role: "title", byte_offset: 2, byte_length: 1 },
            { name: "W0", role: "data", byte_offset: 3, byte_length: 1 },
            { name: "W1", role: "data", byte_offset: 4, byte_length: 1 },
            { name: "SUM", role: "checksum", byte_offset: 5, byte_length: 1 },
          ],
          checksum: {
            type: "unknown",
            start: "unknown",
            end: "unknown",
            expression: "SUM rule was not stated in this section.",
          },
        }],
        bus_context: { bus_type: "CAN", interface_level: "primary" },
        fields: [],
        evidence: ["table-telemetry"],
        warnings: [],
        confidence: 1,
        understanding_source: "model",
      },
    ])

    const migrated = migrateDtpProtocolDefinitionsDocument(definitions)
    expect(migrated.protocols[0].frames?.[0].checksum).toMatchObject({
      type: "sum_low8",
      start: "TITLE",
      end: "BEFORE_SUM",
    })
    expect(migrated.protocols[0].bus_context?.interface_level).toBe("primary")
    expect(migrated.protocols[0].warnings).toContain(
      "frame-1: explicit CAN TITLE/SUM layout uses the default low-byte SUM because no specialized checksum algorithm was defined.",
    )
  })

  test("preserves an explicit SUM error value before adding PeliCAN Frame Information", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-case-pelican-explicit-sum-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    const dataFileIndex = prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT)
    const protocolDefinitions = createProtocolDefinitions(workspaceRoot, [
      {
        protocol_id: "telemetry-pelican-explicit-sum",
        source_section: "3.1.1.1 遥测帧1轮询控制序列",
        flow_direction: "input",
        base_file_name: "遥测帧1轮询控制序列",
        generation_mode: "single_file",
        frames: [{
          frame_id: "frame-1",
          sequence: 1,
          source_table_id: "table-telemetry",
          byte_layout: ["8D", "04", "00", "10", "01", "SUM"],
          field_layout: [
            { name: "ARBITRATION", role: "arbitration", byte_offset: 0, byte_length: 1 },
            { name: "CONTROL", role: "control", byte_offset: 1, byte_length: 1 },
            { name: "DLC", role: "length", byte_offset: 1, byte_length: 1, bit_offset: 0, bit_length: 4 },
            { name: "TITLE", role: "title", byte_offset: 2, byte_length: 1 },
            { name: "W0", role: "data", byte_offset: 3, byte_length: 1 },
            { name: "W1", role: "data", byte_offset: 4, byte_length: 1 },
            { name: "SUM", role: "checksum", byte_offset: 5, byte_length: 1 },
          ],
          checksum: { type: "sum_low8", start: "TITLE", end: "BEFORE_SUM" },
        }],
        bus_context: {
          bus_type: "CAN",
          controller: "SJA1000T",
          controller_family: "SJA1000",
          mode: "PeliCAN",
          frame_format: "standard",
          frame_information: { apply_to_case_data: true, strategy: "derive_from_ff_rtr_dlc" },
        },
        fields: [],
        evidence: ["data-and-interface-requirement"],
        warnings: [],
        confidence: 1,
        understanding_source: "model",
      },
    ])

    const generated = await buildGeneratedStepWithPlanning({
      step: {
        stepIndex: 8,
        keywordName: "发送CANA数据_数据文件",
        stepDescription: "第8.0秒,通过CANA总线发送遥测帧1轮询控制序列,SUM=FFH(错误)",
        timeValue: 8,
      },
      caseContext: {
        caseId: "TC-JK-001",
        testPurpose: "验证错误SUM处理",
        requirementIds: ["TR-JK-001"],
        translateStatus: "success",
        steps: [],
      },
      keywordDef: {
        keywordName: "发送CANA数据_数据文件",
        txtPath: "",
        jsonPath: "",
        arguments: [{ name: "${para2}", comments: "数据文件" }],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot),
      dataFileIndex,
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions,
    }, {
      planCaseStepData: async () => ({
        protocol_name: "遥测帧1轮询控制序列",
        flow_direction: "input",
        variant_type: "correct",
        mutations: [{ field: "W0", operation: "replace", value: "22" }],
        sequence_operations: [],
        checksum_policy: "preserve",
        argument_values: {},
        evidence_ids: [],
        confidence: 0.9,
        warnings: [],
      }),
    })

    const outputPath = join(
      paths.inputDataRoot,
      INPUT_FLOW,
      "用例生成",
      "TC-JK-001",
      generated.generated_data_files[0].requested_file_name,
    )
    expect(readFileSync(outputPath, "utf-8").trim()).toBe("04 8D 04 00 10 01 FF")
    expect(generated.data_generation_plan).toMatchObject({
      selection_source: "step_desc",
      model_used: false,
    })
    expect(generated.data_generation_plan?.checksum_policy).toBe("make_incorrect")
    expect(generated.data_quality?.status).toBe("pass")
  })

  test("derives PeliCAN Frame Information independently for every case-level frame", () => {
    const workspaceRoot = join(tmpdir(), `dtp-case-pelican-multiframe-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    mkdirSync(paths.inputDataRoot, { recursive: true })
    const frameFieldLayout = (controlValue: string) => [
      { name: "ARBITRATION", role: "arbitration" as const, byte_offset: 0, byte_length: 1 },
      { name: "CONTROL", role: "control" as const, byte_offset: 1, byte_length: 1, default_value: controlValue },
      { name: "RTR", role: "control" as const, byte_offset: 1, byte_length: 1, bit_offset: 4, bit_length: 1 },
      { name: "DLC", role: "length" as const, byte_offset: 1, byte_length: 1, bit_offset: 0, bit_length: 4 },
    ]
    const protocolDefinitions = createProtocolDefinitions(workspaceRoot, [
      {
        protocol_id: "multi-pelican",
        source_section: "Multi-frame CAN",
        flow_direction: "input",
        base_file_name: "MultiFrame",
        generation_mode: "single_file",
        frames: [
          {
            frame_id: "frame-1",
            sequence: 1,
            source_table_id: "table-multi",
            byte_layout: ["8D", "04", "00", "10", "01", "11"],
            field_layout: frameFieldLayout("04"),
            checksum: { type: "none" },
          },
          {
            frame_id: "frame-2",
            sequence: 2,
            source_table_id: "table-multi",
            byte_layout: ["9D", "03", "20", "30", "40"],
            field_layout: frameFieldLayout("03"),
            checksum: { type: "none" },
          },
        ],
        bus_context: {
          bus_type: "CAN",
          controller: "SJA1000T",
          controller_family: "SJA1000",
          mode: "PeliCAN",
          frame_format: "standard",
          frame_information: {
            apply_to_case_data: true,
            strategy: "derive_from_ff_rtr_dlc",
          },
        },
        fields: [],
        evidence: ["SJA1000T PeliCAN multi-frame"],
        warnings: [],
        confidence: 1,
        understanding_source: "model",
      },
    ])
    const generated = buildGeneratedStep({
      step: {
        stepIndex: 1,
        keywordName: "SendCANDataFile",
        stepDescription: "Send the correct MultiFrame packet",
      },
      caseContext: {
        caseId: "TC-PELICAN-002",
        testPurpose: "Verify per-frame DLC",
        requirementIds: [],
        steps: [],
      },
      keywordDef: {
        keywordName: "SendCANDataFile",
        txtPath: "",
        jsonPath: "",
        arguments: [{ name: "${para2}", comments: "数据文件" }],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot),
      dataFileIndex: prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT),
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions,
      dataGenerationPlan: {
        protocol_name: "MultiFrame",
        flow_direction: "input",
        variant_type: "correct",
        mutations: [],
        sequence_operations: [],
        checksum_policy: "none",
        argument_values: {},
        evidence_ids: [],
        confidence: 1,
        warnings: [],
        source: "heuristic-fallback",
      },
    })
    const outputFile = join(
      paths.inputDataRoot,
      INPUT_FLOW,
      "\u7528\u4f8b\u751f\u6210",
      "TC-PELICAN-002",
      generated.generated_data_files[0].requested_file_name,
    )
    expect(readFileSync(outputFile, "utf-8").trim().split(/\r?\n/)).toEqual([
      "04 8D 04 00 10 01 11",
      "03 9D 03 20 30 40",
    ])
    expect(generated.data_quality?.status).toBe("pass")
  })

  test("scopes middle and tail CAN field faults to their declared frame", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-case-pelican-frame-target-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    mkdirSync(paths.inputDataRoot, { recursive: true })
    const controlFields = (control: string) => [
      { name: "ARBITRATION", role: "arbitration" as const, byte_offset: 0, byte_length: 1 },
      { name: "CONTROL", role: "control" as const, byte_offset: 1, byte_length: 1, default_value: control },
      { name: "RTR", role: "control" as const, byte_offset: 1, byte_length: 1, bit_offset: 4, bit_length: 1 },
      { name: "DLC", role: "length" as const, byte_offset: 1, byte_length: 1, bit_offset: 0, bit_length: 4 },
    ]
    const protocolDefinitions = createProtocolDefinitions(workspaceRoot, [{
      protocol_id: "camera-remote-command-15",
      source_section: "3.1.1.5 发向相机管理控制器长度15字节的遥控指令",
      flow_direction: "input",
      base_file_name: "遥控指令_15字节",
      generation_mode: "single_file",
      frames: [
        {
          frame_id: "frame-1",
          sequence: 1,
          source_table_id: "camera-command-table",
          byte_layout: ["4D", "28", "00", "0F", "40", "01", "0D", "00", "0B", "00"],
          field_layout: controlFields("28"),
          checksum: { type: "none" },
        },
        {
          frame_id: "frame-2",
          sequence: 2,
          source_table_id: "camera-command-table",
          byte_layout: ["4D", "28", "01", "00", "00", "00", "00", "00", "00", "00"],
          field_layout: controlFields("28"),
          checksum: { type: "none" },
        },
        {
          frame_id: "frame-3",
          sequence: 3,
          source_table_id: "camera-command-table",
          byte_layout: ["4D", "25", "02", "00", "00", "00", "59"],
          field_layout: controlFields("25"),
          checksum: { type: "none" },
        },
      ],
      bus_context: {
        bus_type: "CAN",
        controller: "SJA1000T",
        controller_family: "SJA1000",
        mode: "PeliCAN",
        frame_format: "standard",
        frame_information: { apply_to_case_data: true, strategy: "derive_from_ff_rtr_dlc" },
      },
      fields: [],
      evidence: ["test fixture"],
      warnings: [],
      confidence: 1,
      understanding_source: "model",
    }])

    const generate = async (stepIndex: number, stepDescription: string) => {
      const generated = await buildGeneratedStepWithPlanning({
        step: { stepIndex, keywordName: "发送CANATXT数据", stepDescription, timeValue: stepIndex },
        caseContext: {
          caseId: "TC-JK-013",
          testPurpose: "验证三帧遥控指令的指定帧字段错误",
          requirementIds: ["TR-JK-001"],
          translateStatus: "success",
          steps: [],
        },
        keywordDef: {
          keywordName: "发送CANATXT数据",
          txtPath: "",
          jsonPath: "",
          arguments: [{ name: "${para2}", comments: "数据文件" }],
        },
        inputDataRoot: paths.inputDataRoot,
        workspaceRoot,
        knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot),
        dataFileIndex: prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT),
        docsContext: EMPTY_DOCS_CONTEXT,
        protocolDefinitions,
      }, {
        // Model output intentionally omits frame_index; deterministic parsing must correct it.
        planCaseStepData: async () => ({
          protocol_id: "camera-remote-command-15",
          protocol_name: "遥控指令_15字节",
          flow_direction: "input",
          variant_type: "arbitration_error",
          mutations: [{ field: "ARBITRATION", operation: "replace_with_invalid_value" }],
          sequence_operations: [],
          checksum_policy: "preserve",
          argument_values: {},
          evidence_ids: [],
          confidence: 0.9,
          warnings: [],
        }),
      })
      const outputFile = join(
        paths.inputDataRoot,
        INPUT_FLOW,
        "用例生成",
        "TC-JK-013",
        generated.generated_data_files[0].requested_file_name,
      )
      return {
        generated,
        lines: readFileSync(outputFile, "utf-8").trim().split(/\r?\n/),
      }
    }

    const middleArbitration = await generate(
      6,
      "第6.0秒,通过CANA总线发送中间帧（帧2）仲裁场错误的15字节遥控指令,帧2仲裁场由4DH改为4EH,其余字段正确",
    )
    expect(middleArbitration.generated.data_generation_plan?.mutations).toEqual([
      { field: "ARBITRATION", frame_index: 2, operation: "replace_with_invalid_value", value: "4E" },
    ])
    expect(middleArbitration.lines).toEqual([
      "08 4D 28 00 0F 40 01 0D 00 0B 00",
      "08 4E 28 01 00 00 00 00 00 00 00",
      "05 4D 25 02 00 00 00 59",
    ])

    const middleControl = await generate(
      8,
      "第8.0秒,通过CANA总线发送中间帧（帧2）控制场错误的15字节遥控指令,帧2控制场由28H改为29H,其余字段正确",
    )
    expect(middleControl.generated.data_generation_plan?.mutations).toEqual([
      { field: "CONTROL", frame_index: 2, operation: "replace_with_invalid_value", value: "29" },
    ])
    expect(middleControl.lines).toEqual([
      "08 4D 28 00 0F 40 01 0D 00 0B 00",
      "09 4D 29 01 00 00 00 00 00 00 00",
      "05 4D 25 02 00 00 00 59",
    ])

    const tailArbitration = await generate(
      10,
      "第10.0秒,通过CANA总线发送尾帧（帧3）仲裁场错误的15字节遥控指令,帧3仲裁场由4DH改为4EH,其余字段正确",
    )
    expect(tailArbitration.generated.data_generation_plan?.mutations).toEqual([
      { field: "ARBITRATION", frame_index: 3, operation: "replace_with_invalid_value", value: "4E" },
    ])
    expect(tailArbitration.lines).toEqual([
      "08 4D 28 00 0F 40 01 0D 00 0B 00",
      "08 4D 28 01 00 00 00 00 00 00 00",
      "05 4E 25 02 00 00 00 59",
    ])

    const implicitTail = await generate(
      12,
      "第12.0秒,通过CANA总线发送尾帧仲裁场错误的15字节遥控指令,仲裁场由4DH改为4EH,其余字段正确",
    )
    expect(implicitTail.generated.data_generation_plan?.mutations).toEqual([
      { field: "ARBITRATION", frame_index: 3, operation: "replace_with_invalid_value", value: "4E" },
    ])

    const allFrames = await generate(
      13,
      "第13.0秒,通过CANA总线发送仲裁场错误的15字节遥控指令,仲裁场由4DH改为4EH,其余字段正确",
    )
    expect(allFrames.generated.data_generation_plan?.mutations).toEqual([
      { field: "ARBITRATION", frame_index: undefined, operation: "replace_with_invalid_value", value: "4E" },
    ])
    expect(allFrames.lines).toEqual([
      "08 4E 28 00 0F 40 01 0D 00 0B 00",
      "08 4E 28 01 00 00 00 00 00 00 00",
      "05 4E 25 02 00 00 00 59",
    ])
  })

  test("does not prepend PeliCAN Frame Information for BasicCAN case data", () => {
    const workspaceRoot = join(tmpdir(), `dtp-case-basiccan-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    mkdirSync(paths.inputDataRoot, { recursive: true })
    const protocolDefinitions = createProtocolDefinitions(workspaceRoot, [
      {
        protocol_id: "basiccan-frame",
        flow_direction: "input",
        base_file_name: "BasicCanFrame",
        generation_mode: "single_file",
        frames: [
          {
            frame_id: "frame-1",
            sequence: 1,
            source_table_id: "table-basiccan",
            byte_layout: ["8D", "04", "00", "10", "01", "11"],
            field_layout: [],
            checksum: { type: "none" },
          },
        ],
        bus_context: {
          bus_type: "CAN",
          controller: "SJA1000T",
          controller_family: "SJA1000",
          mode: "BasicCAN",
          frame_format: "standard",
        },
        fields: [],
        evidence: ["SJA1000T BasicCAN"],
        warnings: [],
        confidence: 1,
        understanding_source: "model",
      },
    ])
    const generated = buildGeneratedStep({
      step: {
        stepIndex: 1,
        keywordName: "SendCANDataFile",
        stepDescription: "Send BasicCanFrame",
      },
      caseContext: {
        caseId: "TC-BASICCAN-001",
        testPurpose: "Verify BasicCAN compatibility",
        requirementIds: [],
        steps: [],
      },
      keywordDef: {
        keywordName: "SendCANDataFile",
        txtPath: "",
        jsonPath: "",
        arguments: [{ name: "${para2}", comments: "数据文件" }],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot),
      dataFileIndex: prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT),
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions,
      dataGenerationPlan: {
        protocol_name: "BasicCanFrame",
        flow_direction: "input",
        variant_type: "correct",
        mutations: [],
        sequence_operations: [],
        checksum_policy: "none",
        argument_values: {},
        evidence_ids: [],
        confidence: 1,
        warnings: [],
        source: "heuristic-fallback",
      },
    })
    const outputFile = join(
      paths.inputDataRoot,
      INPUT_FLOW,
      "\u7528\u4f8b\u751f\u6210",
      "TC-BASICCAN-001",
      generated.generated_data_files[0].requested_file_name,
    )
    expect(readFileSync(outputFile, "utf-8").trim()).toBe("8D 04 00 10 01 11")
    expect(generated.data_quality?.status).toBe("pass")
  })

  test("excludes expected_result from case-step planning semantics", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-case-no-expected-result-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    mkdirSync(paths.inputDataRoot, { recursive: true })
    let planningInput: Record<string, unknown> | undefined

    const generated = await buildGeneratedStepWithPlanning({
      step: {
        stepIndex: 1,
        keywordName: "Wait",
        stepDescription: "Perform the normal operation",
        expectedResult: "TITLE must be invalid",
        timeValue: 1,
      },
      caseContext: {
        caseId: "TC-NO-EXPECTED-001",
        testPurpose: "Verify the normal operation",
        correspondFunId: "TR-NO-EXPECTED-001",
        requirementIds: ["TR-NO-EXPECTED-001"],
        steps: [],
      },
      keywordDef: {
        keywordName: "Wait",
        txtPath: "",
        jsonPath: "",
        arguments: [{ name: "${time}", comments: "execution time" }],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot),
      dataFileIndex: prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT),
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions: createProtocolDefinitions(workspaceRoot, []),
    }, {
      planCaseStepData: async (input) => {
        planningInput = input as unknown as Record<string, unknown>
        return {
          flow_direction: "unknown",
          variant_type: "correct",
          mutations: [],
          sequence_operations: [],
          checksum_policy: "none",
          argument_values: {},
          evidence_ids: [],
          confidence: 1,
          warnings: [],
        }
      },
    })

    expect((planningInput?.step as Record<string, unknown>)).not.toHaveProperty("expected_result")
    expect(JSON.stringify(planningInput)).not.toContain("TITLE must be invalid")
    expect(generated.expected_result).toBe("TITLE must be invalid")
  })

  test("reuses valid V2 protocol definitions on a repeated ensure", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-protocol-cache-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const first = await ensureDtpProtocolDefinitions(workspaceRoot, EMPTY_DOCS_CONTEXT)
    const second = await ensureDtpProtocolDefinitions(workspaceRoot, EMPTY_DOCS_CONTEXT)

    expect(first.cache_hit).toBe(false)
    expect(second.cache_hit).toBe(true)
    expect(second.protocol_definitions.schema_version).toBe("4.0.0")
    expect(second.validation.valid).toBe(true)
  })

  test("applies deterministic multi-frame sequence operations from the step description", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-case-sequence-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    mkdirSync(paths.inputDataRoot, { recursive: true })
    const dataFileIndex = prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT)
    const protocolDefinitions = createProtocolDefinitions(workspaceRoot, [
      {
        protocol_id: "auxiliary-data-packet",
        source_section: "1.1.1.9 辅助数据相关数据流",
        flow_direction: "input",
        base_file_name: "辅助数据包",
        generation_mode: "single_file",
        frame: {
          source_table_id: "table-auxiliary-data",
          byte_layout: ["9D", "28", "00", "FC", "60", "W0", "W1", "W2"],
          byte_layouts: [
            ["9D", "28", "00", "FC", "60", "W0", "W1", "W2"],
            ["9D", "28", "01", "W3", "W4", "W5", "W6", "W7"],
            ["9D", "28", "02", "W8", "W9", "W10", "W11", "SUM"],
          ],
          checksum: { type: "sum_low8", start: "TITLE", end: "BEFORE_SUM" },
        },
        fields: [],
        evidence: ["test fixture"],
        warnings: [],
        confidence: 1,
        understanding_source: "heuristic-fallback",
      },
    ])

    const generated = await buildGeneratedStepWithPlanning(
      {
        step: {
          stepIndex: 8,
          keywordName: "发送CANBTXT数据",
          stepDescription: "通过CANB总线发送辅助数据包,跳过第2帧,其余帧正常发送",
          expectedResult: "系统丢弃不完整数据包",
          timeValue: 24,
        },
        caseContext: {
          caseId: "TC-JK-036",
          testPurpose: "验证多帧序列异常",
          correspondFunId: "TR-JK-001",
          requirementIds: ["TR-JK-001"],
          steps: [],
        },
        keywordDef: {
          keywordName: "发送CANBTXT数据",
          txtPath: "",
          jsonPath: "",
          arguments: [
            { name: "${time}", comments: "执行时间" },
            { name: "${para1}", comments: "参数1：ID:0~255" },
            { name: "${para2}", comments: "参数2：数据文件，文件内容为十六进制数据" },
            { name: "${para3}", comments: "参数3：循环时间，单位秒" },
          ],
        },
        inputDataRoot: paths.inputDataRoot,
        workspaceRoot,
        knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot),
        dataFileIndex,
        docsContext: EMPTY_DOCS_CONTEXT,
        protocolDefinitions,
      },
      {
        planCaseStepData: async () => ({
          protocol_name: "辅助数据包",
          flow_direction: "input",
          variant_type: "correct",
          mutations: [],
          checksum_policy: "preserve",
          argument_values: { "${para1}": 157, "${para3}": 0 },
          confidence: 0.9,
          warnings: [],
        }),
      },
    )

    expect(generated.generated_data_files[0].requested_file_name).toBe("S08-辅助数据包-跳过第2帧.txt")
    const outputPath = join(
      paths.inputDataRoot,
      INPUT_FLOW,
      "用例生成",
      "TC-JK-036",
      "S08-辅助数据包-跳过第2帧.txt",
    )
    expect(readFileSync(outputPath, "utf-8").trim().split(/\r?\n/)).toEqual([
      "9D 28 00 FC 60 00 00 00",
      "9D 28 02 00 00 00 00 60",
    ])
    expect(generated.data_generation_plan?.checksum_policy).toBe("recalculate_correctly")
    expect(generated.data_quality?.status).toBe("warning")
    expect(generated.data_quality?.issues.some((issue) => issue.type === "unresolved_field_zero_fallback")).toBe(true)
  })

  test("uses an explicit frame sequence as the authoritative multi-frame variant", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-case-explicit-sequence-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    mkdirSync(paths.inputDataRoot, { recursive: true })
    const protocolDefinitions = createProtocolDefinitions(workspaceRoot, [
      {
        protocol_id: "camera-remote-command-15",
        source_section: "3.1.1.5 发向相机管理控制器长度15字节的遥控指令",
        flow_direction: "input",
        base_file_name: "15字节遥控指令",
        generation_mode: "single_file",
        frame: {
          source_table_id: "table-camera-15",
          byte_layout: ["4D", "28", "00", "0F", "40", "W0", "W1", "W2", "W3", "W4"],
          byte_layouts: [
            ["4D", "28", "00", "0F", "40", "W0", "W1", "W2", "W3", "W4"],
            ["4D", "28", "01", "W5", "W6", "W7", "W8", "W9", "W10", "W11"],
            ["4D", "25", "02", "W12", "W13", "W14", "SUM"],
          ],
          checksum: { type: "sum_low8", start: "TITLE", end: "BEFORE_SUM" },
        },
        fields: [],
        evidence: ["test fixture"],
        warnings: [],
        confidence: 1,
        understanding_source: "heuristic-fallback",
      },
    ])

    const generated = await buildGeneratedStepWithPlanning({
      step: {
        stepIndex: 20,
        keywordName: "发送CANA数据_数据文件",
        stepDescription: "第20.0秒,通过CANA总线发送首帧重复的15字节遥控指令,帧序号序列为00H、00H、01H~02H共四帧",
        timeValue: 20,
      },
      caseContext: { caseId: "TC-JK-013", requirementIds: [], steps: [] },
      keywordDef: {
        keywordName: "发送CANA数据_数据文件",
        txtPath: "",
        jsonPath: "",
        arguments: [{ name: "${time}" }, { name: "${para2}", comments: "数据文件" }],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot),
      dataFileIndex: prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT),
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions,
    })

    const outputFile = join(paths.inputDataRoot, INPUT_FLOW, "用例生成", "TC-JK-013", generated.generated_data_files[0].requested_file_name)
    expect(readFileSync(outputFile, "utf-8").trim().split(/\r?\n/)).toEqual([
      "4D 28 00 0F 40 00 00 00 00 00",
      "4D 28 00 0F 40 00 00 00 00 00",
      "4D 28 01 00 00 00 00 00 00 00",
      "4D 25 02 00 00 00 40",
    ])
    expect(generated.generated_data_files[0].requested_file_name).toBe("S20-15字节遥控指令-重复首帧.txt")
    expect(generated.data_generation_plan?.sequence_operations).toEqual([
      { operation: "repeat_frame", frame_index: 1, repeat_count: 1 },
    ])

    const missingTail = await buildGeneratedStepWithPlanning({
      step: {
        stepIndex: 30,
        keywordName: "发送CANA数据_数据文件",
        stepDescription: "第30.0秒,通过CANA总线发送尾帧丢失的15字节遥控指令,帧序号序列为00H~01H共两帧",
        timeValue: 30,
      },
      caseContext: { caseId: "TC-JK-013", requirementIds: [], steps: [] },
      keywordDef: {
        keywordName: "发送CANA数据_数据文件",
        txtPath: "",
        jsonPath: "",
        arguments: [{ name: "${time}" }, { name: "${para2}", comments: "数据文件" }],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot),
      dataFileIndex: prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT),
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions,
    })

    expect(missingTail.data_generation_plan?.sequence_operations).toEqual([
      { operation: "drop_frame", frame_index: 3 },
    ])
    expect(missingTail.generated_data_files[0].requested_file_name)
      .toBe("S30-15字节遥控指令-缺少尾帧.txt")
    expect(readFileSync(join(
      paths.inputDataRoot,
      INPUT_FLOW,
      "用例生成",
      "TC-JK-013",
      "S30-15字节遥控指令-缺少尾帧.txt",
    ), "utf-8").trim().split(/\r?\n/)).toEqual([
      "4D 28 00 0F 40 00 00 00 00 00",
      "4D 28 01 00 00 00 00 00 00 00",
    ])

    const reverseMissingFirst = await buildGeneratedStepWithPlanning({
      step: {
        stepIndex: 31,
        keywordName: "发送CANA数据_数据文件",
        stepDescription: "第31.0秒,通过CANA总线发送首帧丢失的15字节遥控指令,共2帧发送",
        timeValue: 31,
      },
      caseContext: { caseId: "TC-JK-013", requirementIds: [], steps: [] },
      keywordDef: {
        keywordName: "发送CANA数据_数据文件",
        txtPath: "",
        jsonPath: "",
        arguments: [{ name: "${time}" }, { name: "${para2}", comments: "数据文件" }],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot),
      dataFileIndex: prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT),
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions,
    })
    expect(reverseMissingFirst.data_generation_plan?.sequence_operations).toEqual([
      { operation: "drop_frame", frame_index: 1 },
    ])
    expect(reverseMissingFirst.generated_data_files[0].requested_file_name)
      .toBe("S31-15字节遥控指令-缺少首帧.txt")

    const reverseMissingLast = await buildGeneratedStepWithPlanning({
      step: {
        stepIndex: 32,
        keywordName: "发送CANA数据_数据文件",
        stepDescription: "第32.0秒,通过CANA总线发送尾帧丢失的15字节遥控指令,共2帧发送",
        timeValue: 32,
      },
      caseContext: { caseId: "TC-JK-013", requirementIds: [], steps: [] },
      keywordDef: {
        keywordName: "发送CANA数据_数据文件",
        txtPath: "",
        jsonPath: "",
        arguments: [{ name: "${time}" }, { name: "${para2}", comments: "数据文件" }],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot),
      dataFileIndex: prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT),
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions,
    })
    expect(reverseMissingLast.data_generation_plan?.sequence_operations).toEqual([
      { operation: "drop_frame", frame_index: 3 },
    ])
    expect(reverseMissingLast.generated_data_files[0].requested_file_name)
      .toBe("S32-15字节遥控指令-缺少尾帧.txt")

    const invalidMiddle = await buildGeneratedStepWithPlanning({
      step: {
        stepIndex: 34,
        keywordName: "发送CANA数据_数据文件",
        stepDescription: "第34.0秒,通过CANA总线发送中间帧帧序号错误的15字节遥控指令,帧序号序列为00H、03H、02H共三帧",
        timeValue: 34,
      },
      caseContext: { caseId: "TC-JK-013", requirementIds: [], steps: [] },
      keywordDef: {
        keywordName: "发送CANA数据_数据文件",
        txtPath: "",
        jsonPath: "",
        arguments: [{ name: "${time}" }, { name: "${para2}", comments: "数据文件" }],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot),
      dataFileIndex: prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT),
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions,
    })
    expect(invalidMiddle.generated_data_files[0].requested_file_name)
      .toBe("S34-15字节遥控指令-中间帧帧序号异常.txt")
    expect(invalidMiddle.data_generation_plan?.mutations).toContainEqual({
      field: "FRAME_SEQUENCE",
      frame_index: 2,
      operation: "replace_with_invalid_value",
      value: "03",
    })
    expect(invalidMiddle.data_quality?.issues.filter((issue) => issue.severity === "error")).toEqual([])

    const compactRange = buildGeneratedStep({
      step: {
        stepIndex: 20,
        keywordName: "发送CANA数据_数据文件",
        stepDescription: "第20.0秒,通过CANA总线发送首帧重复的15字节遥控指令",
      },
      caseContext: { caseId: "TC-SEQUENCE-NAME", requirementIds: [], steps: [] },
      keywordDef: {
        keywordName: "发送CANA数据_数据文件",
        txtPath: "",
        jsonPath: "",
        arguments: [{ name: "${para2}", comments: "数据文件" }],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot),
      dataFileIndex: prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT),
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions,
      dataGenerationPlan: {
        protocol_id: "camera-remote-command-15",
        protocol_name: "15字节遥控指令",
        flow_direction: "input",
        bus: "CAN",
        variant_type: "field_error",
        mutations: [],
        sequence_operations: [
          { operation: "repeat_frame", frame_index: 1, repeat_count: 1 },
          ...Array.from({ length: 25 }, (_, index) => ({
            operation: "drop_frame" as const,
            frame_index: index + 13,
          })),
        ],
        checksum_policy: "recalculate_correctly",
        argument_values: {},
        evidence_ids: [],
        confidence: 1,
        warnings: [],
        source: "heuristic-fallback",
      },
    })
    expect(compactRange.generated_data_files[0].requested_file_name)
      .toBe("S20-15字节遥控指令-重复首帧-跳过第13-37帧.txt")
    expect(compactRange.data_generation_plan?.sequence_operations).toHaveLength(26)

    const duplicateDropOperation = buildGeneratedStep({
      step: {
        stepIndex: 30,
        keywordName: "发送CANA数据_数据文件",
        stepDescription: "通过CANA总线发送尾帧帧序号异常的249字节上行数据块",
      },
      caseContext: { caseId: "TC-SEQUENCE-DUPLICATE-NAME", requirementIds: [], steps: [] },
      keywordDef: {
        keywordName: "发送CANA数据_数据文件",
        txtPath: "",
        jsonPath: "",
        arguments: [{ name: "${para2}", comments: "数据文件" }],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot),
      dataFileIndex: prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT),
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions,
      dataGenerationPlan: {
        protocol_id: "camera-remote-command-15",
        protocol_name: "249字节上行数据块",
        flow_direction: "input",
        bus: "CAN",
        variant_type: "field_error",
        mutations: [],
        sequence_operations: Array.from({ length: 24 }, () => ({
          operation: "drop_frame" as const,
          frame_index: 14,
        })),
        checksum_policy: "recalculate_correctly",
        argument_values: {},
        evidence_ids: [],
        confidence: 1,
        warnings: [],
        source: "model",
      },
    })
    expect(duplicateDropOperation.generated_data_files[0].requested_file_name)
      .toBe("S30-249字节上行数据块-跳过第14帧-待确认.txt")
  })

  test("parses mixed long frame-sequence ranges without treating ordinary hex examples as sequences", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-case-long-sequence-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    mkdirSync(paths.inputDataRoot, { recursive: true })
    const protocolDefinitions = createProtocolDefinitions(workspaceRoot, [{
      protocol_id: "uplink-data-72-byte",
      source_section: "3.1 数据及接口需求 72字节上行数据块",
      flow_direction: "input",
      base_file_name: "72字节上行数据块",
      generation_mode: "single_file",
      frames: Array.from({ length: 11 }, (_, index) => {
        const sequence = index.toString(16).toUpperCase().padStart(2, "0")
        return {
          frame_id: `uplink-72-frame-${index + 1}`,
          sequence: index + 1,
          source_table_id: "table-uplink-72",
          byte_layout: ["65", "08", sequence, "00"],
          field_layout: [{
            name: "FRAME_SEQUENCE",
            role: "sequence" as const,
            byte_offset: 2,
            byte_length: 1,
            default_value: sequence,
          }],
        }
      }),
      fields: [],
      evidence: ["test fixture"],
      warnings: [],
      confidence: 1,
      understanding_source: "heuristic-fallback",
    }])
    let supplementalPlanningCalls = 0
    const generate = (stepIndex: number, stepDescription: string) => buildGeneratedStepWithPlanning({
      step: {
        stepIndex,
        keywordName: "发送CANBTXT数据",
        stepDescription,
        timeValue: stepIndex,
      },
      caseContext: { caseId: "TC-JK-018", requirementIds: [], steps: [] },
      keywordDef: {
        keywordName: "发送CANBTXT数据",
        txtPath: "",
        jsonPath: "",
        arguments: [{ name: "${para2}", comments: "数据文件" }],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot),
      dataFileIndex: prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT),
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions,
    }, {
      planCaseStepData: async () => {
        supplementalPlanningCalls += 1
        return {
          protocol_id: "uplink-data-72-byte",
          protocol_name: "72字节上行数据块",
          flow_direction: "input",
          variant_type: "correct",
          mutations: [],
          sequence_operations: [],
          checksum_policy: "none",
          argument_values: {},
          evidence_ids: [],
          confidence: 0.9,
          warnings: [],
        }
      },
    })

    const mixedRange = await generate(
      20,
      "通过CANB总线发送帧序号错误的72字节上行数据块,帧序号序列为00H~04H、07H、06H~0AH共十一帧",
    )
    expect(mixedRange.data_generation_plan?.mutations).toContainEqual({
      field: "FRAME_SEQUENCE",
      frame_index: 6,
      operation: "replace_with_invalid_value",
      value: "07",
    })
    expect(mixedRange.generated_data_files[0].requested_file_name)
      .toBe("S20-72字节上行数据块-第6帧帧序号异常.txt")
    expect(mixedRange.data_quality?.issues.filter((issue) => issue.severity === "error")).toEqual([])

    const ordinaryHexExample = await generate(
      21,
      "通过CANB总线发送正确的72字节上行数据块（65H 08H 00H 48H 00H）",
    )
    expect(ordinaryHexExample.data_generation_plan?.mutations.some((mutation) => (
      /^(?:FRAME_SEQUENCE|FRAME_INDEX|SEQUENCE|INDEX)$/i.test(mutation.field)
    ))).toBe(false)
    expect(ordinaryHexExample.data_generation_plan?.sequence_operations).toEqual([])

    const unresolvedSequenceFault = await generate(
      22,
      "通过CANB总线发送首帧帧序号错误的72字节上行数据块，但步骤未给出目标帧序号",
    )
    expect(unresolvedSequenceFault.data_quality?.issues).toContainEqual(expect.objectContaining({
      severity: "error",
      type: "semantic_fault_without_mutation",
      message: "The step describes a frame-sequence fault, but no deterministic frame-sequence mutation could be resolved.",
    }))
    expect(unresolvedSequenceFault.data_generation_plan?.model_skipped_reasons)
      .toContain("structural_quality_issues_not_model_fixable")
    expect(unresolvedSequenceFault.generated_data_files[0].requested_file_name).toContain("待确认")
    expect(supplementalPlanningCalls).toBe(0)
  })

  test("resolves natural-language command names before applying command field faults", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-command-name-match-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    mkdirSync(paths.inputDataRoot, { recursive: true })
    const knowledgeIndex: ProjectKnowledgeIndex = {
      ...createEmptyKnowledgeIndex(workspaceRoot),
      source_documents: [{
        id: "doc-1",
        path: join(workspaceRoot, "第三方测试需求.docx"),
        file_name: "第三方测试需求.docx",
        role: "primary-third-party-test-requirement",
        type: "docx",
        parse_state: "parsed",
        warnings: [],
      }],
      tables: [{
        id: "command-table",
        source_document_id: "doc-1",
        caption: "附录K 一级CAN总线指令",
        topic: "hardware_interface",
        rows: [
          ["指令代号", "指令名称", "W2", "W3", "W4", "W5", "W6", "W7", "W8", "W9"],
          ["TCY203", "秒脉冲切换设置", "20H", "06H", "00H", "23H", "选择秒脉冲：3CH：秒脉冲A（默认） C3H：秒脉冲B", "00H", "00H", "00H"],
          ["TCY211", "成像控制信号", "20H", "06H", "00H", "2BH", "选择设置的通道：D7：通道A D6：通道B D3：预留 D0：通道H", "00H", "00H", "00H"],
        ],
        cells: [],
        confidence: 1,
        warnings: [],
      }],
    }
    const dictionary = buildCommandDictionaryIndex(knowledgeIndex)
    expect(dictionary.entries.find((entry) => entry.command_code === "TCY203")?.field_overrides)
      .toContainEqual(expect.objectContaining({ field_name: "W6", value: "3C" }))
    const imagingCommand = dictionary.entries.find((entry) => entry.command_code === "TCY211")
    expect(imagingCommand?.field_overrides).toContainEqual(expect.objectContaining({ field_name: "W6", value: "01" }))
    expect(imagingCommand?.warnings.some((warning) => warning.includes("W6") && warning.includes("requires semantic selection")))
      .toBe(false)

    const primaryCommandProtocol = {
      protocol_id: "primary-command-10",
      source_section: "3.1.1.5 一级CAN遥控指令",
      flow_direction: "input" as const,
      base_file_name: "10字节遥控指令",
      generation_mode: "single_file" as const,
      frame: {
        source_table_id: "primary-command-table-10",
        byte_layout: ["4D", "28", "00", "0A", "40", "W0", "W1", "W2", "W3", "W4"],
        byte_layouts: [
          ["4D", "28", "00", "0A", "40", "W0", "W1", "W2", "W3", "W4"],
          ["4D", "27", "01", "W5", "W6", "W7", "W8", "W9", "SUM"],
        ],
        checksum: { type: "sum_low8" as const, start: "TITLE", end: "BEFORE_SUM" },
      },
      bus_context: { bus_type: "CAN" as const, interface_level: "primary" as const, interface_id: "IF-CAN0-001" },
      fields: [
        { name: "W0", type: "fixed" as const, value: "01", source: "table" as const, confidence: 1, warnings: [] },
        { name: "W1", type: "fixed" as const, value: "0D", source: "table" as const, confidence: 1, warnings: [] },
      ],
      evidence: [],
      warnings: [],
      confidence: 1,
      understanding_source: "heuristic-fallback" as const,
      provenance: [{
        source_document_id: "doc-1",
        source_table_ids: ["primary-command-table-10"],
        source_sections: ["3.1.1.5"],
        evidence: ["10字节遥控指令"],
        priority: "primary" as const,
      }],
    }
    const protocolDefinitions = createProtocolDefinitions(workspaceRoot, [
      primaryCommandProtocol,
      {
        ...primaryCommandProtocol,
        protocol_id: "referenced-command-10",
        source_section: "附录G 10字节遥控指令",
        frame: {
          ...primaryCommandProtocol.frame,
          source_table_id: "referenced-command-table-10",
          byte_layout: ["5D", "28", "00", "0A", "40", "W0", "W1", "W2", "W3", "W4"],
          byte_layouts: [
            ["5D", "28", "00", "0A", "40", "W0", "W1", "W2", "W3", "W4"],
            ["5D", "27", "01", "W5", "W6", "W7", "W8", "W9", "SUM"],
          ],
        },
        provenance: [{
          source_document_id: "doc-2",
          source_table_ids: ["referenced-command-table-10"],
          source_sections: ["附录G"],
          evidence: ["10字节遥控指令"],
          priority: "referenced" as const,
        }],
      },
    ])
    const baseInput = {
      keywordDef: {
        keywordName: "发送CANA数据_数据文件",
        txtPath: "",
        jsonPath: "",
        arguments: [{ name: "${para2}", comments: "数据文件" }],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex,
      commandDictionaryIndex: dictionary,
      dataFileIndex: prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT),
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions,
    }
    const generate = (caseId: string, stepIndex: number, stepDescription: string) => buildGeneratedStepWithPlanning({
      ...baseInput,
      caseContext: { caseId, requirementIds: [], steps: [] },
      step: {
        stepIndex,
        keywordName: "发送CANA数据_数据文件",
        stepDescription,
      },
    })

    const pulse = await generate("TC-GN-TC-001", 1, "第3.0秒,通过CANA总线发送正确的秒脉冲信号切换指令")
    expect(pulse.data_generation_plan?.command).toMatchObject({
      code: "TCY203",
      name: "秒脉冲切换设置",
      selection_source: "step_desc",
    })
    expect(pulse.data_generation_plan?.selection_source).toBe("step_desc")
    expect(pulse.generated_data_files[0].requested_file_name)
      .toBe("S01-10字节遥控指令-TCY203-秒脉冲切换设置-正常.txt")
    expect(readFileSync(join(
      paths.inputDataRoot,
      INPUT_FLOW,
      "用例生成",
      "TC-GN-TC-001",
      pulse.generated_data_files[0].requested_file_name,
    ), "utf-8").trim().split(/\r?\n/)).toEqual([
      "4D 28 00 0A 40 01 0D 20 06 00",
      "4D 27 01 23 3C 00 00 00 D3",
    ])

    const pulseW2Fault = await generate(
      "TC-GN-TC-001",
      2,
      "第4.0秒,通过CANA总线发送秒脉冲信号切换指令（W2字段错误,其余字段正确）",
    )
    expect(readFileSync(join(
      paths.inputDataRoot,
      INPUT_FLOW,
      "用例生成",
      "TC-GN-TC-001",
      pulseW2Fault.generated_data_files[0].requested_file_name,
    ), "utf-8").trim().split(/\r?\n/)).toEqual([
      "4D 28 00 0A 40 01 0D 21 06 00",
      "4D 27 01 23 3C 00 00 00 D4",
    ])

    const imaging = await generate("TC-GN-TC-002", 1, "第3.0秒,通过CANA总线发送正确的成像控制信号指令")
    expect(imaging.data_generation_plan?.command).toMatchObject({
      code: "TCY211",
      name: "成像控制信号",
      selection_source: "step_desc",
    })
    expect(imaging.generated_data_files[0].requested_file_name).not.toContain("待确认")
    expect(imaging.data_generation_plan?.model_trigger_reasons).not.toContain("business_value_unresolved")
    const imagingLines = readFileSync(join(
      paths.inputDataRoot,
      INPUT_FLOW,
      "用例生成",
      "TC-GN-TC-002",
      imaging.generated_data_files[0].requested_file_name,
    ), "utf-8").trim().split(/\r?\n/).map((line) => line.split(/\s+/))
    expect(imagingLines[1]?.[4]).toBe("01")

    const imagingW6Fault = await generate(
      "TC-GN-TC-002",
      2,
      "第4.0秒,通过CANA总线发送成像控制信号指令（W6字段错误,其余字段正确）",
    )
    expect(imagingW6Fault.generated_data_files[0].requested_file_name).not.toContain("待确认")
    const imagingFaultLines = readFileSync(join(
      paths.inputDataRoot,
      INPUT_FLOW,
      "用例生成",
      "TC-GN-TC-002",
      imagingW6Fault.generated_data_files[0].requested_file_name,
    ), "utf-8").trim().split(/\r?\n/).map((line) => line.split(/\s+/))
    expect(imagingFaultLines[1]?.[4]).toBe("08")
    expect(imagingFaultLines[0]).toEqual(imagingLines[0])
  })

  test("fills a TCY command from a command dictionary table outside the protocol section", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-command-dictionary-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    mkdirSync(paths.inputDataRoot, { recursive: true })
    const knowledgeIndex: ProjectKnowledgeIndex = {
      ...createEmptyKnowledgeIndex(workspaceRoot),
      source_documents: [{
        id: "doc-1",
        path: join(workspaceRoot, "第三方测试需求.docx"),
        file_name: "第三方测试需求.docx",
        role: "primary-third-party-test-requirement",
        type: "docx",
        parse_state: "parsed",
        warnings: [],
      }],
      tables: [{
        id: "appendix-command-table",
        source_document_id: "doc-1",
        caption: "附录C 总线指令",
        topic: "hardware_interface",
        rows: [
          ["指令代号", "指令名称", "W2 一级CAN指令标识", "W3 有效数据长度", "W4", "W5", "W6", "W7", "W8", "W9", "W10", "W11", "W12", "W13", "W14"],
          ["TCY215", "定标黑体控温系数调整", "20H", "0BH", "00H", "2FH", "01H：主热敏参数", "0000H-FFFFH", "00H-FFH", "00H-FFH", "00H-FFH", "00H", "00H", "00H", "00H"],
        ],
        cells: [],
        confidence: 1,
        warnings: [],
      }],
    }
    const dictionary = buildCommandDictionaryIndex(knowledgeIndex)
    expect(dictionary.entries).toHaveLength(1)
    expect(dictionary.entries[0]).toMatchObject({ command_code: "TCY215", payload_length_bytes: 15 })

    const protocolDefinitions = createProtocolDefinitions(workspaceRoot, [
      {
        protocol_id: "camera-remote-command-15",
        source_section: "3.1.1.5 发向相机管理控制器长度15字节的遥控指令",
        flow_direction: "input",
        base_file_name: "发向相机管理控制器遥控指令_15字节",
        generation_mode: "single_file",
        frame: {
          source_table_id: "table-camera-15",
          byte_layout: ["4D", "28", "00", "0F", "40", "W0", "W1", "W2", "W3", "W4"],
          byte_layouts: [
            ["4D", "28", "00", "0F", "40", "W0", "W1", "W2", "W3", "W4"],
            ["4D", "28", "01", "W5", "W6", "W7", "W8", "W9", "W10", "W11"],
            ["4D", "25", "02", "W12", "W13", "W14", "SUM"],
          ],
          checksum: { type: "sum_low8", start: "TITLE", end: "BEFORE_SUM" },
        },
        bus_context: { bus_type: "CAN", interface_level: "primary" },
        fields: [],
        evidence: ["test fixture"],
        warnings: [],
        confidence: 1,
        understanding_source: "heuristic-fallback",
      },
    ])
    const oldFileName = "S38-发向相机管理控制器遥控指令_15字节-正常.txt"
    const oldFilePath = join(paths.inputDataRoot, INPUT_FLOW, "用例生成", "TC-JK-013", oldFileName)
    mkdirSync(dirname(oldFilePath), { recursive: true })
    writeFileSync(oldFilePath, "obsolete generic command file\n", "utf-8")
    const generated = await buildGeneratedStepWithPlanning({
      step: {
        stepIndex: 38,
        keywordName: "发送CANA数据_数据文件",
        stepDescription: "第38.0秒,通过CANA总线发送定标黑体控温系数调整指令TCY215（W0~W6、W11~W14均正确）",
        timeValue: 38,
      },
      caseContext: { caseId: "TC-JK-013", requirementIds: [], steps: [] },
      keywordDef: {
        keywordName: "发送CANA数据_数据文件",
        txtPath: "",
        jsonPath: "",
        arguments: [{ name: "${time}" }, { name: "${para2}", comments: "数据文件" }],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex,
      commandDictionaryIndex: dictionary,
      dataFileIndex: prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT),
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions,
    })

    const expectedFileName = "S38-发向相机管理控制器遥控指令_15字节-TCY215-定标黑体控温系数调整-正常.txt"
    expect(generated.generated_data_files[0].requested_file_name).toBe(expectedFileName)
    expect(generated.data_generation_plan?.command).toEqual({
      code: "TCY215",
      name: "定标黑体控温系数调整",
      source_table_id: "appendix-command-table",
      source_table_caption: "附录C 总线指令",
    })
    expect(generated.generated_data_files[0].generation_basis).toEqual(expect.arrayContaining([
      "command:TCY215",
      "command_table:appendix-command-table",
    ]))
    expect(generated.generated_data_files[0].field_value_plan).toEqual(expect.arrayContaining([
      expect.objectContaining({ field_name: "W2", value: "20", value_source: "dictionary-row" }),
      expect.objectContaining({ field_name: "W5", value: "2F", value_source: "dictionary-row" }),
    ]))
    expect(existsSync(oldFilePath)).toBe(false)
    const outputFile = join(paths.inputDataRoot, INPUT_FLOW, "用例生成", "TC-JK-013", expectedFileName)
    expect(readFileSync(outputFile, "utf-8").trim().split(/\r?\n/)).toEqual([
      "4D 28 00 0F 40 00 00 20 0B 00",
      "4D 28 01 2F 01 00 00 00 00 00",
      "4D 25 02 00 00 00 9B",
    ])
    expect(generated.data_generation_plan?.protocol_id).toBe("camera-remote-command-15")
    expect(generated.data_generation_plan?.warnings.some((warning) => warning.includes("TCY215"))).toBe(true)
    expect(generated.data_quality?.issues.some((issue) => issue.type === "mutation_not_applied")).toBe(false)

    const invalidW14 = await buildGeneratedStepWithPlanning({
      step: {
        stepIndex: 39,
        keywordName: "发送CANA数据_数据文件",
        stepDescription: "第39.0秒,通过CANA总线发送TCY215指令（W14错误,W0~W6、W11~W13正确）",
        timeValue: 39,
      },
      caseContext: { caseId: "TC-JK-014", requirementIds: [], steps: [] },
      keywordDef: {
        keywordName: "发送CANA数据_数据文件",
        txtPath: "",
        jsonPath: "",
        arguments: [{ name: "${time}" }, { name: "${para2}", comments: "数据文件" }],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex,
      commandDictionaryIndex: dictionary,
      dataFileIndex: prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT),
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions,
    })
    expect(invalidW14.data_generation_plan?.mutations.filter((mutation) => mutation.field === "W14")).toEqual([
      { field: "W14", frame_index: 3, operation: "replace_with_invalid_value" },
    ])
    expect(invalidW14.generated_data_files[0].requested_file_name).toContain("W14异常")
    const invalidW14Output = join(
      paths.inputDataRoot,
      INPUT_FLOW,
      "用例生成",
      "TC-JK-014",
      invalidW14.generated_data_files[0].requested_file_name,
    )
    expect(readFileSync(invalidW14Output, "utf-8").trim().split(/\r?\n/)).toEqual([
      "4D 28 00 0F 40 00 00 20 0B 00",
      "4D 28 01 2F 01 00 00 00 00 00",
      "4D 25 02 00 00 01 9C",
    ])
    expect(invalidW14.data_quality?.issues.some((issue) => issue.type === "mutation_not_applied")).toBe(false)
  })

  test("keeps normal multi-frame steps intact and scopes field errors to the named frame", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-case-frame-scoped-mutation-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    mkdirSync(paths.inputDataRoot, { recursive: true })
    const dataFileIndex = prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT)
    const protocolName = "\u5185\u5b58\u8bfb\u51fa\u6307\u4ee4"
    const protocolDefinitions = createProtocolDefinitions(workspaceRoot, [
      {
        protocol_id: "memory-read-command",
        source_section: "1.1.1.7 \u5185\u5b58\u8bfb\u51fa\u6307\u4ee4\u76f8\u5173\u6570\u636e\u6d41",
        flow_direction: "input",
        base_file_name: protocolName,
        generation_mode: "single_file",
        frame: {
          source_table_id: "table-memory-read-command",
          byte_layout: ["4D", "28", "00", "0A", "E0", "W0", "W1", "W2", "W3", "W4"],
          byte_layouts: [
            ["4D", "28", "00", "0A", "E0", "W0", "W1", "W2", "W3", "W4"],
            ["4D", "27", "01", "W5", "W6", "W7", "W8", "W9", "SUM"],
          ],
          checksum: { type: "sum_low8", start: "TITLE", end: "BEFORE_SUM" },
        },
        fields: [],
        evidence: ["test fixture"],
        warnings: [],
        confidence: 1,
        understanding_source: "heuristic-fallback",
      },
    ])
    const caseContext = {
      caseId: "TC-JK-035",
      testPurpose: "\u9a8c\u8bc1\u5185\u5b58\u8bfb\u51fa\u6307\u4ee4\u4ef2\u88c1\u573a\u3001\u63a7\u5236\u573a\u6216\u5e27\u5e8f\u53f7\u9519\u8bef\u65f6\u4e22\u5f03\u76f8\u5e94\u5e27",
      correspondFunId: "TR-JK-001",
      requirementIds: ["TR-JK-001"],
      steps: [],
    }
    const keywordDef = {
      keywordName: "\u53d1\u9001CANB\u6570\u636e_\u6570\u636e\u6587\u4ef6",
      txtPath: "",
      jsonPath: "",
      arguments: [
        { name: "${time}", comments: "\u6267\u884c\u65f6\u95f4" },
        { name: "${para1}", comments: "\u53c2\u65701\uff1aID" },
        { name: "${para2}", comments: "\u53c2\u65702\uff1a\u6570\u636e\u6587\u4ef6" },
        { name: "${para3}", comments: "\u53c2\u65703\uff1a\u5faa\u73af\u65f6\u95f4" },
      ],
    }
    const generate = (stepIndex: number, stepDescription: string, expectedResult: string) => buildGeneratedStepWithPlanning({
      step: {
        stepIndex,
        keywordName: keywordDef.keywordName,
        stepDescription,
        expectedResult,
        timeValue: stepIndex === 1 ? 3 : 6.5,
      },
      caseContext,
      keywordDef,
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot),
      dataFileIndex,
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions,
    })

    const normal = await generate(
      1,
      "\u7b2c3.0\u79d2,\u901a\u8fc7CANB\u603b\u7ebf\u53d1\u9001\u5185\u5b58\u8bfb\u51fa\u6307\u4ee4\u7b2c1\u5e27\uff08\u4ef2\u88c1\u573a=4DH\u3001\u63a7\u5236\u573a=28H\uff09.\u7b2c3.5\u79d2,\u53d1\u9001\u7b2c2\u5e27\uff08\u4ef2\u88c1\u573a=4DH\u3001\u63a7\u5236\u573a=27H\uff09",
      "\u8f6f\u4ef6\u6b63\u5e38\u63a5\u6536\u4e24\u5e27\u5185\u5b58\u8bfb\u51fa\u6307\u4ee4",
    )
    const arbitrationError = await generate(
      2,
      "\u7b2c6.5\u79d2,\u901a\u8fc7CANB\u603b\u7ebf\u53d1\u9001\u5185\u5b58\u8bfb\u51fa\u6307\u4ee4\u7b2c1\u5e27\uff08\u4ef2\u88c1\u573a=5DH(\u9519\u8bef)\u3001\u63a7\u5236\u573a=28H\uff09.\u7b2c7.0\u79d2,\u53d1\u9001\u7b2c2\u5e27\uff08\u4ef2\u88c1\u573a=4DH\u3001\u63a7\u5236\u573a=27H\uff09",
      "\u8f6f\u4ef6\u4e22\u5f03\u7b2c1\u5e27\u4ef2\u88c1\u573a\u9519\u8bef\u7684\u6307\u4ee4",
    )

    expect(normal.data_generation_plan?.variant_type).toBe("correct")
    expect(normal.data_generation_plan?.mutations).toEqual([
      { field: "ARBITRATION", frame_index: 1, operation: "replace", value: "4D" },
      { field: "CONTROL", frame_index: 1, operation: "replace", value: "28" },
      { field: "ARBITRATION", frame_index: 2, operation: "replace", value: "4D" },
      { field: "CONTROL", frame_index: 2, operation: "replace", value: "27" },
    ])
    expect(normal.data_quality?.status).toBe("warning")
    expect(normal.data_quality?.issues.some((issue) => issue.type === "unresolved_field_zero_fallback")).toBe(true)
    expect(arbitrationError.data_generation_plan?.mutations).toContainEqual(
      { field: "ARBITRATION", frame_index: 1, operation: "replace_with_invalid_value", value: "5D" },
    )
    expect(arbitrationError.data_quality?.status).toBe("warning")

    const normalFile = join(paths.inputDataRoot, INPUT_FLOW, "\u7528\u4f8b\u751f\u6210", "TC-JK-035", `S01-${protocolName}-\u6b63\u5e38.txt`)
    const errorFile = join(paths.inputDataRoot, INPUT_FLOW, "\u7528\u4f8b\u751f\u6210", "TC-JK-035", `S02-${protocolName}-\u9996\u5e27\u4ef2\u88c1\u573a\u5f02\u5e38.txt`)
    expect(readFileSync(normalFile, "utf-8").trim().split(/\r?\n/)).toEqual([
      "4D 28 00 0A E0 00 00 00 00 00",
      "4D 27 01 00 00 00 00 00 E0",
    ])
    expect(readFileSync(errorFile, "utf-8").trim().split(/\r?\n/)).toEqual([
      "5D 28 00 0A E0 00 00 00 00 00",
      "4D 27 01 00 00 00 00 00 E0",
    ])
  })

})


describe("DTP SPI protocol generation", () => {
  test("keeps SPI commands on their documented output flow and reports unspecified faults", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-spi-command-flow-${Date.now()}`)
    const paths = resolveDefaultPaths(workspaceRoot)
    mkdirSync(paths.inputDataRoot, { recursive: true })
    const makeProtocol = (id: string, name: string, flow: "input" | "output") => ({
      protocol_id: id, base_file_name: name, source_section: "SPI", flow_direction: flow,
      generation_mode: "single_file" as const,
      frames: [{ frame_id: "frame-1", sequence: 1, source_table_id: id,
        byte_layout: ["59", "01", "A5", "SUM"],
        field_layout: [
          { name: "ADDRESS", role: "address" as const, byte_offset: 0, byte_length: 1, default_value: "59" },
          { name: "LENGTH", role: "length" as const, byte_offset: 1, byte_length: 1, default_value: "01" },
          { name: "DATA0", role: "data" as const, byte_offset: 2, byte_length: 1, default_value: "A5" },
          { name: "SUM", role: "checksum" as const, byte_offset: 3, byte_length: 1 },
        ], checksum: { type: "sum_low8" as const, start: "ADDRESS", end: "BEFORE_SUM" } }],
      bus_context: { bus_type: "SPI" as const }, fields: [], evidence: [], warnings: [],
      confidence: 1, understanding_source: "model" as const,
    })
    const definitions = createProtocolDefinitions(workspaceRoot, [
      makeProtocol("command", "机构控制指令", "output"),
      makeProtocol("response", "机构控制指令应答", "input"),
      makeProtocol("unrelated", "指令板模拟量遥测", "input"),
    ])
    const switched = makeProtocol("switch", "开关指令", "output")
    switched.frames[0].byte_layout[0] = "ADDRESS"
    const switchAddress = switched.frames[0].field_layout[0]
    delete switchAddress.default_value
    definitions.protocols.push({ ...switched, frames: [{ ...switched.frames[0], field_layout: [
      { ...switchAddress, options: [{ value: "6B", label: "ADDRESS=6BH" }, { value: "73", label: "ADDRESS=73H" }] },
      ...switched.frames[0].field_layout.slice(1),
    ] }] })
    for (const [index, description, expectedId] of [
      [1, "发送SPI数据为机构控制指令·正常发送", "command"],
      [2, "发送SPI数据为机构控制指令应答·正常发送", "response"],
      [3, "发送SPI数据为机构控制指令·错误", "command"],
      [4, "发送SPI数据为开关指令·正常发送", "switch"],
      [5, "发送SPI数据为开关指令·正常发送，ADDRESS=73H", "switch"],
    ] as const) {
      let modelCalls = 0
      const generated = await buildGeneratedStepWithPlanning({
        step: { stepIndex: index, keywordName: "发送SPI数据", stepDescription: description },
        caseContext: { caseId: "TC-SPI-FLOW", requirementIds: [], steps: [] },
        keywordDef: { keywordName: "发送SPI数据", txtPath: "", jsonPath: "", arguments: [{ name: "${file}", comments: "数据文件" }] },
        inputDataRoot: paths.inputDataRoot, workspaceRoot,
        knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot),
        dataFileIndex: prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT),
        docsContext: EMPTY_DOCS_CONTEXT, protocolDefinitions: definitions,
      }, { planCaseStepData: async () => { modelCalls++; return {} } })
      expect(generated.data_generation_plan?.protocol_id).toBe(expectedId)
      if (index === 3) {
        expect(modelCalls).toBe(1)
        expect(generated.data_quality?.issues.some(issue => issue.type === "semantic_fault_without_mutation")).toBe(true)
        expect(generated.data_quality?.status).toBe("failed")
      } else if (index === 4) {
        expect(modelCalls).toBe(0)
        expect(generated.data_quality?.issues.some(issue => issue.type === "protocol_default_selected")).toBe(true)
        expect(generated.data_quality?.status).toBe("warning")
        const file = generated.generated_data_files[0]
        expect(readFileSync(join(paths.inputDataRoot, "输出流", "用例生成", "TC-SPI-FLOW", file.requested_file_name), "utf8").trim()).toBe("6B 01 A5 11")
        expect(file.field_value_plan).toContainEqual(expect.objectContaining({
          field_name: "ADDRESS",
          value: "6B",
          value_source: "enum-option",
        }))
      } else {
        expect(modelCalls).toBe(0)
        expect(generated.data_quality?.status).toBe("pass")
        if (index === 5) {
          const file = generated.generated_data_files[0]
          expect(readFileSync(join(paths.inputDataRoot, "输出流", "用例生成", "TC-SPI-FLOW", file.requested_file_name), "utf8").trim()).toBe("73 01 A5 19")
        }
      }
    }
  })
  test("recovers the SPI response deterministically when model understanding times out", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-spi-timeout-fallback-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    const knowledgeIndex: ProjectKnowledgeIndex = {
      ...createEmptyKnowledgeIndex(workspaceRoot),
      snippets: [
        {
          id: "doc-spi-snippet-1",
          source_document_id: "doc-spi",
          topic: "hardware_interface",
          text: "3.1.2 SpaceWire\u603b\u7ebf\u63a5\u53e3\u53ca\u76f8\u5173\u6570\u636e\u6d41",
          confidence: 1,
        },
        {
          id: "doc-spi-snippet-2",
          source_document_id: "doc-spi",
          topic: "hardware_interface",
          text: "3.1.3 \u4e8c\u7ea7CAN\u603b\u7ebf\u63a5\u53e3\u53ca\u76f8\u5173\u6570\u636e\u6d41\uff0cFPGA\u6bcf\u5e27\u589e\u52a00008H\u3002",
          confidence: 1,
        },
        {
          id: "doc-spi-snippet-100",
          source_document_id: "doc-spi",
          topic: "data_protocol",
          text: "\u8f93\u5165\u6d411\uff1a\u673a\u6784\u63a7\u5236\u6307\u4ee4\u5e94\u7b54\u3002\u5176\u683c\u5f0f\u89c1\u4e0b\u8868\u3002",
          confidence: 1,
        },
        {
          id: "doc-spi-snippet-101",
          source_document_id: "doc-spi",
          topic: "data_protocol",
          text: "\u88683.1.4.1-2 \u673a\u6784\u63a7\u5236\u6307\u4ee4\u5e94\u7b54\u683c\u5f0f",
          confidence: 1,
        },
      ],
      tables: [{
        id: "doc-spi-table-47",
        source_document_id: "doc-spi",
        caption: "\u88683.1.4.1-2 \u673a\u6784\u63a7\u5236\u6307\u4ee4\u5e94\u7b54\u683c\u5f0f",
        aliases: [],
        topic: "data_protocol",
        rows: [
          ["ADDRESS", "", "LENGTH", "", "DATA0", "SUM"],
          ["\u7ad9\u5730\u5740", "\u7c7b\u578b", "-", "\u6570\u636e\u957f\u5ea6", "-", "-"],
          ["01011", "011", "00", "000001", "-", "-"],
          ["5BH", "", "01H", "", "A5H", "SUM"],
        ],
        table_html: "<table><tr><td colspan=\"2\">ADDRESS</td><td colspan=\"2\">LENGTH</td><td>DATA0</td><td>SUM</td></tr><tr><td>\u7ad9\u5730\u5740</td><td>\u7c7b\u578b</td><td>-</td><td>\u6570\u636e\u957f\u5ea6</td><td>-</td><td>-</td></tr><tr><td>01011</td><td>011</td><td>00</td><td>000001</td><td>-</td><td>-</td></tr><tr><td colspan=\"2\">5BH</td><td colspan=\"2\">01H</td><td>A5H</td><td>SUM</td></tr></table>",
        confidence: 1,
        warnings: [],
      }],
      section_protocol_models: [{
        id: "spi-timeout-section",
        source_document_id: "doc-spi",
        section_id: "3.1.4.1",
        section_title: "3.1.4.1 \u673a\u6784\u63a7\u5236\u6307\u4ee4\u683c\u5f0f",
        section_path: [],
        section_snippet_ids: ["doc-spi-snippet-100", "doc-spi-snippet-101"],
        input_flow_snippet_ids: [],
        output_flow_snippet_ids: [],
        table_ids: ["doc-spi-table-47"],
        primary_table_ids: ["doc-spi-table-47"],
        support_table_ids: [],
        protocol_relations: [{
          frame_table_id: "doc-spi-table-47",
          generation_mode: "frame_file",
          flow_direction: "unknown",
          should_generate_frame_table_file: true,
          checksum_rule: "SUM is the low byte of ADDRESS through DATA",
          confidence: 0.72,
          reasoning: ["heuristic fixture"],
        }],
        protocols: [],
        confidence: 1,
        warnings: [],
      }],
    } as ProjectKnowledgeIndex

    let modelCallCount = 0
    const definitions = await buildDtpProtocolDefinitionsDocument(paths, knowledgeIndex, {
      understandSectionProtocols: async () => {
        modelCallCount += 1
        throw new Error("Model protocol understanding timed out after 100000ms")
      },
    })
    const protocol = definitions.protocols.find((item) => item.frames?.[0]?.source_table_id === "doc-spi-table-47")
    const frame = protocol?.frames?.[0]

    expect(modelCallCount).toBe(1)
    expect(protocol).toMatchObject({
      base_file_name: "\u673a\u6784\u63a7\u5236\u6307\u4ee4\u5e94\u7b54",
      flow_direction: "input",
      bus_context: { bus_type: "SPI" },
      understanding_source: "heuristic-fallback",
    })
    expect(protocol?.frame_envelope).toBeUndefined()
    expect(protocol?.frames).toHaveLength(1)
    expect(frame?.byte_layout).toEqual(["5B", "01", "A5", "SUM"])
    expect(frame?.field_layout.find((field) => field.name === "STATION_ADDRESS")).toMatchObject({ bit_offset: 3, bit_length: 5 })
    expect(frame?.field_layout.find((field) => field.name === "MESSAGE_TYPE")).toMatchObject({ bit_offset: 0, bit_length: 3 })

    const dataFileIndex = prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT)
    writeDtpProtocolDataFiles(paths, definitions, dataFileIndex)
    expect(readFileSync(join(paths.inputDataRoot, INPUT_FLOW, "\u673a\u6784\u63a7\u5236\u6307\u4ee4\u5e94\u7b54.txt"), "utf-8").trim()).toBe("5B 01 A5 01")

    const variants = [
      { suffix: "\u6b63\u5e38", desc: "\u7b2c3.1\u79d2\uff0c\u901a\u8fc7SPI\u603b\u7ebf\u53d1\u9001\u7ad9\u5730\u574059H\u7684\u673a\u6784\u63a7\u5236\u6307\u4ee4\u5e94\u7b54\uff08\u5168\u90e8\u5b57\u6bb5\u6b63\u786e\uff09" },
      { suffix: "\u7ad9\u5730\u5740\u5f02\u5e38", desc: "\u7b2c4.1\u79d2\uff0c\u901a\u8fc7SPI\u603b\u7ebf\u53d1\u9001\u7ad9\u5730\u574059H\u7684\u673a\u6784\u63a7\u5236\u6307\u4ee4\u5e94\u7b54\uff08\u7ad9\u5730\u5740\u5b57\u6bb5\u9519\u8bef\uff0c\u5176\u4f59\u5b57\u6bb5\u6b63\u786e\uff09" },
      { suffix: "\u6d88\u606f\u7c7b\u578b\u5f02\u5e38", desc: "\u7b2c6.1\u79d2\uff0c\u901a\u8fc7SPI\u603b\u7ebf\u53d1\u9001\u7ad9\u5730\u574059H\u7684\u673a\u6784\u63a7\u5236\u6307\u4ee4\u5e94\u7b54\uff08\u7c7b\u578b\u5b57\u6bb5\u9519\u8bef\uff0c\u5176\u4f59\u5b57\u6bb5\u6b63\u786e\uff09" },
      { suffix: "\u957f\u5ea6\u5f02\u5e38", desc: "\u7b2c8.1\u79d2\uff0c\u901a\u8fc7SPI\u603b\u7ebf\u53d1\u9001\u7ad9\u5730\u574059H\u7684\u673a\u6784\u63a7\u5236\u6307\u4ee4\u5e94\u7b54\uff08LENGTH\u5b57\u6bb5\u9519\u8bef\uff0c\u5176\u4f59\u5b57\u6bb5\u6b63\u786e\uff09" },
      { suffix: "DATA0\u5f02\u5e38", desc: "\u7b2c10.1\u79d2\uff0c\u901a\u8fc7SPI\u603b\u7ebf\u53d1\u9001\u7ad9\u5730\u574059H\u7684\u673a\u6784\u63a7\u5236\u6307\u4ee4\u5e94\u7b54\uff08DATA0\u5b57\u6bb5\u9519\u8bef\uff0c\u5176\u4f59\u5b57\u6bb5\u6b63\u786e\uff09" },
      { suffix: "SUM\u5f02\u5e38", desc: "\u7b2c12.1\u79d2\uff0c\u901a\u8fc7SPI\u603b\u7ebf\u53d1\u9001\u7ad9\u5730\u574059H\u7684\u673a\u6784\u63a7\u5236\u6307\u4ee4\u5e94\u7b54\uff08SUM\u5b57\u6bb5\u9519\u8bef\uff0c\u5176\u4f59\u5b57\u6bb5\u6b63\u786e\uff09" },
    ]
    for (const [index, variant] of variants.entries()) {
      const generated = await buildGeneratedStepWithPlanning({
        step: { stepIndex: index + 1, keywordName: "\u53d1\u9001SPI\u63a5\u53e3\u6570\u636e", stepDescription: variant.desc },
        caseContext: { caseId: `TC-SPI-${index + 1}`, requirementIds: [], steps: [] },
        keywordDef: {
          keywordName: "\u53d1\u9001SPI\u63a5\u53e3\u6570\u636e",
          txtPath: "",
          jsonPath: "",
          arguments: [{ name: "${para2}", comments: "\u6570\u636e\u6587\u4ef6" }],
        },
        inputDataRoot: paths.inputDataRoot,
        workspaceRoot,
        knowledgeIndex,
        dataFileIndex,
        docsContext: EMPTY_DOCS_CONTEXT,
        protocolDefinitions: definitions,
      })
      const output = generated.generated_data_files[0]
      expect(output.requested_file_name).toContain(variant.suffix)
      expect(output.requested_file_name).not.toContain("\u5f85\u786e\u8ba4")
      expect(readFileSync(join(paths.inputDataRoot, output.file_path.replace(/^\u8f93\u5165\u6570\u636e[\\/]/, "")), "utf-8").trim()).not.toBe("00")
    }
  })

  test("keeps the SPI table layout authoritative and computes SUM from ADDRESS", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-spi-table-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    const knowledgeIndex: ProjectKnowledgeIndex = {
      ...createEmptyKnowledgeIndex(workspaceRoot),
      snippets: [
        { id: "spi-snippet-1", source_document_id: "spi-doc", topic: "hardware_interface", text: "3.3 SPI总线接口及相关数据流 IF-SPI-001 FPGA SPI；ADDRESS高5位为站地址，低3位为消息类型。", confidence: 1 },
        { id: "spi-snippet-2", source_document_id: "spi-doc", topic: "input_flow", text: "输入流1：机构控制指令应答。SUM从ADDRESS开始到最后一个DATA的字节累加和。", confidence: 1 },
      ],
      tables: [
        {
          id: "spi-table-1",
          source_document_id: "spi-doc",
          caption: "机构控制指令应答格式",
          aliases: [],
          topic: "packet_structure",
          rows: [
            ["序号", "ADDRESS", "LENGTH", "DATA0~DATA4", "SUM"],
            ["1", "5CH", "05H", "F3H 00H 00H 00H 00H", "SUM"],
          ],
          confidence: 1,
          warnings: [],
        },
      ],
      section_protocol_models: [
        {
          id: "spi-section-model",
          source_document_id: "spi-doc",
          section_id: "3.3",
          section_title: "3.3 SPI总线接口及相关数据流",
          section_snippet_ids: ["spi-snippet-1", "spi-snippet-2"],
          input_flow_snippet_ids: ["spi-snippet-2"],
          output_flow_snippet_ids: [],
          table_ids: ["spi-table-1"],
          primary_table_ids: ["spi-table-1"],
          support_table_ids: [],
          protocol_relations: [],
          protocols: [],
          confidence: 1,
          warnings: [],
        },
      ],
    } as any

    const definitions = await buildDtpProtocolDefinitionsDocument(paths, knowledgeIndex, {
      understandSectionProtocols: async () => ({
        protocols: [
          {
            protocol_id: "spi-response",
            source_section: "3.3 SPI总线接口及相关数据流",
            flow_direction: "input",
            base_file_name: "spi-mechanism-control-response",
            generation_mode: "single_file",
            frame: {
              source_table_id: "spi-table-1",
              byte_layout: ["5C", "05", "F3", "00", "00", "00", "00", "SUM"],
              field_layout: [
                { name: "TITLE", role: "title", byte_offset: 0, byte_length: 1 },
                { name: "W0", role: "data", byte_offset: 1, byte_length: 1 },
              ],
              checksum: { type: "sum_low8", start: "TITLE", end: "BEFORE_SUM" },
            },
            bus_context: { bus_type: "SPI", controller: "FPGA" },
            fields: [],
            evidence: ["spi-table-1"],
            warnings: [],
            confidence: 1,
          },
        ],
        non_generated_tables: [],
        warnings: [],
      }),
    })

    const protocol = definitions.protocols[0]
    const frame = protocol.frames?.[0]
    expect(protocol.base_file_name).toBe("机构控制指令应答")
    expect(protocol.aliases).toContain("spi-mechanism-control-response")
    expect(protocol.bus_context?.bus_type).toBe("SPI")
    expect(frame?.byte_layout).toEqual(["5C", "05", "F3", "00", "00", "00", "00", "SUM"])
    expect(frame?.field_layout.find((field) => field.name === "ADDRESS")?.byte_offset).toBe(0)
    expect(frame?.field_layout.find((field) => field.name === "LENGTH")?.byte_offset).toBe(1)
    expect(frame?.field_layout.find((field) => field.name === "DATA0")?.byte_offset).toBe(2)
    expect(frame?.field_layout.find((field) => field.name === "DATA4")?.byte_offset).toBe(6)
    expect(frame?.field_layout.find((field) => field.name === "STATION_ADDRESS")).toMatchObject({ bit_offset: 3, bit_length: 5 })
    expect(frame?.field_layout.find((field) => field.name === "MESSAGE_TYPE")).toMatchObject({ bit_offset: 0, bit_length: 3 })
    expect(frame?.checksum).toMatchObject({ type: "sum_low8", start: "ADDRESS", end: "BEFORE_SUM" })
    expect(validateDtpProtocolDefinitions(definitions).valid).toBe(true)

    const dataFileIndex = prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT)
    writeDtpProtocolDataFiles(paths, definitions, dataFileIndex)
    expect(readFileSync(join(paths.inputDataRoot, INPUT_FLOW, "机构控制指令应答.txt"), "utf-8").trim()).toBe("5C 05 F3 00 00 00 00 54")
  })

  test("selects SPI over a same-name CAN protocol and mutates ADDRESS station bits", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-spi-case-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    mkdirSync(paths.inputDataRoot, { recursive: true })
    const spiFrame = {
      frame_id: "frame-1",
      sequence: 1,
      source_table_id: "spi-table",
      byte_layout: ["5B", "01", "A5", "SUM"],
      field_layout: [
        { name: "ADDRESS", role: "address" as const, byte_offset: 0, byte_length: 1, default_value: "5B" },
        { name: "STATION_ADDRESS", role: "address" as const, byte_offset: 0, byte_length: 1, bit_offset: 3, bit_length: 5, default_value: "0B" },
        { name: "MESSAGE_TYPE", role: "type" as const, byte_offset: 0, byte_length: 1, bit_offset: 0, bit_length: 3, default_value: "03" },
        { name: "LENGTH", role: "length" as const, byte_offset: 1, byte_length: 1, default_value: "01" },
        { name: "DATA0", role: "data" as const, byte_offset: 2, byte_length: 1, default_value: "A5" },
        { name: "SUM", role: "checksum" as const, byte_offset: 3, byte_length: 1 },
      ],
      checksum: { type: "sum_low8" as const, start: "ADDRESS", end: "BEFORE_SUM" },
    }
    const definitions = createProtocolDefinitions(workspaceRoot, [
      {
        protocol_id: "can-same-name",
        source_section: "CAN",
        flow_direction: "input",
        base_file_name: "开关指令应答",
        generation_mode: "single_file",
        frames: [{ ...spiFrame, source_table_id: "can-table" }],
        bus_context: { bus_type: "CAN", interface_level: "primary" },
        fields: [], evidence: ["CAN"], warnings: [], confidence: 1, understanding_source: "model",
      },
      {
        protocol_id: "spi-same-name",
        source_section: "SPI",
        flow_direction: "input",
        base_file_name: "开关指令应答",
        generation_mode: "single_file",
        frames: [spiFrame],
        bus_context: { bus_type: "SPI", controller: "FPGA" },
        fields: [], evidence: ["SPI"], warnings: [], confidence: 1, understanding_source: "model",
      },
    ])
    const generated = await buildGeneratedStepWithPlanning({
      step: {
        stepIndex: 1,
        keywordName: "发送SPI接口数据",
        stepDescription: "第1.0秒,通过SPI总线发送站地址错误的开关指令应答,SUM正确",
        timeValue: 1,
      },
      caseContext: {
        caseId: "TC-SPI-001",
        testPurpose: "SPI station address",
        correspondFunId: "TR-SPI-001",
        requirementIds: ["TR-SPI-001"],
        steps: [],
      },
      keywordDef: {
        keywordName: "发送SPI接口数据",
        txtPath: "",
        jsonPath: "",
        arguments: [
          { name: "${time}", comments: "执行时间" },
          { name: "${para1}", comments: "ID" },
          { name: "${para2}", comments: "数据文件，文件内容为十六进制数据" },
          { name: "${para3}", comments: "延时" },
        ],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot),
      dataFileIndex: prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT),
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions: definitions,
    })

    expect(generated.data_generation_plan?.protocol_id).toBe("spi-same-name")
    expect(generated.data_generation_plan?.bus).toBe("SPI")
    const outputDir = join(paths.inputDataRoot, INPUT_FLOW, "用例生成", "TC-SPI-001")
    const outputFile = readdirSync(outputDir).find((name) => name.endsWith(".txt"))
    expect(outputFile).toBeTruthy()
    expect(readFileSync(join(outputDir, outputFile!), "utf-8").trim()).toBe("63 01 A5 09")
    expect(generated.data_quality?.status).toBe("pass")
  })
})

describe("DTP SpaceWire block generation", () => {
  function createSpaceWireKnowledgeIndex(workspaceRoot: string): ProjectKnowledgeIndex {
    return {
      ...createEmptyKnowledgeIndex(workspaceRoot),
      snippets: [
        {
          id: "spacewire-snippet-1",
          source_document_id: "spacewire-doc",
          topic: "hardware_interface",
          text: "3.1.2 SpaceWire\u603b\u7ebf\u63a5\u53e3\u53ca\u76f8\u5173\u6570\u636e\u6d41 FPGA\u901a\u8fc7\u6620\u5c04\u5b58\u50a8\u533a\u63a5\u6536\u7ba1\u63a7\u7a0b\u5e8f\u4e0a\u6ce8\u6570\u636e\u5757\u3002",
          confidence: 1,
        },
        {
          id: "spacewire-snippet-2",
          source_document_id: "spacewire-doc",
          topic: "input_flow",
          text: "\u8f93\u5165\u6d41\uff1a\u7ba1\u63a7\u7a0b\u5e8f\u4e0a\u6ce8\u6570\u636e\u5757\uff0c\u6bcf\u5757720\u5b57\u8282\u3002",
          confidence: 1,
        },
      ],
      tables: [
        {
          id: "spacewire-start-middle-table",
          source_document_id: "spacewire-doc",
          caption: "\u88683.1.2-2 \u7ba1\u63a7\u7a0b\u5e8f\u4e0a\u6ce8\u8d77\u59cb\u5757\u548c\u4e2d\u95f4\u5757\u683c\u5f0f",
          aliases: [],
          topic: "packet_structure",
          rows: [
            ["\u5b57\u8282", "\u5185\u5bb9", "\u6570\u636e"],
            ["W0~W1", "\u586b\u5145", "0000H"],
            ["W2", "\u5305\u6807\u8bc6", "01H\uff08\u7ba1\u7406\u63a7\u5236\u5668\u7a0b\u5e8f\u4e0a\u6ce8\uff09"],
            ["W3", "\u5305\u7c7b\u578b", "\u8d77\u59cb\u575700H\uff0c\u4e2d\u95f4\u575705H"],
            ["W4~W7", "\u8d77\u59cb\u5730\u5740", "10000000H"],
            ["W8~W11", "\u6570\u636e\u957f\u5ea6", "704\u5b57\u8282"],
            ["W12~W715", "\u6709\u6548\u6570\u636e", "704\u5b57\u8282"],
            ["W716~W717", "ISO\u6821\u9a8c", "W12~W715"],
            ["W718~W719", "\u586b\u5145", "0000H"],
          ],
          confidence: 1,
          warnings: [],
        },
        {
          id: "spacewire-check-table",
          source_document_id: "spacewire-doc",
          caption: "\u88683.1.2-3 \u7ba1\u63a7\u7a0b\u5e8f\u4e0a\u6ce8\u6821\u9a8c\u5757\u683c\u5f0f",
          aliases: [],
          topic: "packet_structure",
          rows: [
            ["\u5b57\u8282", "\u5185\u5bb9", "\u6570\u636e"],
            ["W0~W1", "\u586b\u5145", "0000H"],
            ["W2", "\u5305\u6807\u8bc6", "01H\uff08\u7ba1\u7406\u63a7\u5236\u5668\u7a0b\u5e8f\u4e0a\u6ce8\uff09"],
            ["W3", "\u5305\u7c7b\u578b", "\u6821\u9a8c\u57570AH"],
            ["W4~W7", "\u8d77\u59cb\u5730\u5740", "10000000H"],
            ["W8~W11", "\u6570\u636e\u957f\u5ea6", "N"],
            ["W12~W15", "\u7a0b\u5e8f\u6821\u9a8c\u548c", "\u6309\u5b57\u8282\u7d2f\u52a0\u548c"],
            ["W16~W715", "\u586b\u5145", "00H"],
            ["W716~W717", "ISO\u6821\u9a8c", "W12~W715"],
            ["W718~W719", "\u586b\u5145", "0000H"],
          ],
          confidence: 1,
          warnings: [],
        },
      ],
      section_protocol_models: [
        {
          id: "spacewire-section-model",
          source_document_id: "spacewire-doc",
          section_id: "3.1.2",
          section_title: "3.1.2 SpaceWire\u603b\u7ebf\u63a5\u53e3\u53ca\u76f8\u5173\u6570\u636e\u6d41",
          section_snippet_ids: ["spacewire-snippet-1", "spacewire-snippet-2"],
          input_flow_snippet_ids: ["spacewire-snippet-2"],
          output_flow_snippet_ids: [],
          table_ids: ["spacewire-start-middle-table", "spacewire-check-table"],
          primary_table_ids: ["spacewire-start-middle-table"],
          support_table_ids: ["spacewire-check-table"],
          protocol_relations: [],
          protocols: [],
          confidence: 1,
          warnings: [],
        },
      ],
    } as ProjectKnowledgeIndex
  }

  async function createSpaceWireDefinitions(workspaceRoot: string): Promise<DtpProtocolDefinitionsDocument> {
    const paths = resolveDefaultPaths(workspaceRoot)
    return buildDtpProtocolDefinitionsDocument(paths, createSpaceWireKnowledgeIndex(workspaceRoot), {
      understandSectionProtocols: async () => ({
        protocols: [],
        non_generated_tables: [],
        warnings: [],
      }),
    })
  }

  test("compiles the related SpaceWire tables into authoritative 720-byte block templates", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-spacewire-definition-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const definitions = await createSpaceWireDefinitions(workspaceRoot)
    const protocol = definitions.protocols.find((item) => item.bus_context?.bus_type === "SpaceWire")

    expect(protocol).toBeDefined()
    expect(protocol?.block_layout).toMatchObject({
      kind: "spacewire_program_upload",
      total_bytes: 720,
      payload_offset: 12,
      payload_capacity: 704,
      block_type_offset: 3,
      checksums: [
        expect.objectContaining({
          name: "ISO_CHECKSUM",
          algorithm: "iso_8473",
          source_start: 12,
          source_end: 715,
          output_offset: 716,
          output_length: 2,
        }),
        expect.any(Object),
      ],
    })
    expect(protocol?.frames?.map((frame) => frame.byte_layout.length)).toEqual([720, 720, 720])
    expect(protocol?.frames?.map((frame) => frame.byte_layout[3])).toEqual(["00", "05", "0A"])
    expect(protocol?.frames?.[0].byte_layout.slice(0, 12)).toEqual([
      "00", "00", "01", "00", "10", "00", "00", "00", "00", "00", "02", "C0",
    ])
    expect(protocol?.frames?.[0].byte_layout.slice(712, 716)).toEqual([
      "PAYLOAD_700", "PAYLOAD_701", "PAYLOAD_702", "PAYLOAD_703",
    ])
    expect(protocol?.frames?.[0].field_layout.find((field) => field.name === "PAYLOAD")).toMatchObject({
      byte_offset: 12,
      byte_length: 704,
    })
    expect(definitions.protocol_families).toEqual(expect.arrayContaining([
      expect.objectContaining({
        bus_type: "SpaceWire",
        composition: expect.objectContaining({
          type: "ordered_blocks",
          members: [
            expect.objectContaining({ role: "start", order: 1, cardinality: "1" }),
            expect.objectContaining({ role: "middle", order: 2, cardinality: "0..n" }),
            expect.objectContaining({ role: "check", order: 3, cardinality: "1" }),
          ],
        }),
      }),
    ]))
    expect(validateDtpProtocolDefinitions(definitions).valid).toBe(true)
  })

  test("writes a permissive zero-filled start block and check block when no program image exists", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-spacewire-zero-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    const definitions = await createSpaceWireDefinitions(workspaceRoot)
    const dataFileIndex = prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT)
    const result = writeDtpProtocolDataFiles(paths, definitions, dataFileIndex)
    const generated = result.generated_files.find((item) => item.protocol_name === "\u7ba1\u63a7\u7a0b\u5e8f\u4e0a\u6ce8\u6570\u636e\u5757")
    const lines = readFileSync(generated!.absolute_file_path!, "utf-8").trim().split(/\r?\n/)
    const start = lines[0].split(/\s+/)
    const check = lines[1].split(/\s+/)

    expect(lines).toHaveLength(2)
    expect(start).toHaveLength(720)
    expect(check).toHaveLength(720)
    expect(start.slice(0, 12)).toEqual(["00", "00", "01", "00", "10", "00", "00", "00", "00", "00", "02", "C0"])
    expect(check.slice(0, 16)).toEqual(["00", "00", "01", "0A", "10", "00", "00", "00", "00", "00", "02", "C0", "00", "00", "00", "00"])
    expect(generated?.warnings.some((warning) => warning.includes("No SpaceWire program image"))).toBe(true)
    expect(generated?.warnings.some((warning) => warning.includes("ISO_CHECKSUM"))).toBe(false)
  })

  test("computes the documented ISO checksum for the verified 720-byte start-block vector", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-spacewire-iso-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const payloadFile = join(workspaceRoot, "program.bin")
    writeFileSync(payloadFile, Uint8Array.from({ length: 704 }, (_, index) => (0x20 + index) & 0xff))
    const paths = resolveDefaultPaths(workspaceRoot)
    const definitions = await createSpaceWireDefinitions(workspaceRoot)
    definitions.protocols[0].block_layout!.payload_file = payloadFile
    const dataFileIndex = prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT)
    const result = writeDtpProtocolDataFiles(paths, definitions, dataFileIndex)
    const generated = result.generated_files.find((item) => item.protocol_name === "\u7ba1\u63a7\u7a0b\u5e8f\u4e0a\u6ce8\u6570\u636e\u5757")!
    const start = readFileSync(generated.absolute_file_path!, "utf-8").trim().split(/\r?\n/)[0].split(/\s+/)

    expect(start).toHaveLength(720)
    expect(start.slice(0, 12)).toEqual(["00", "00", "01", "00", "10", "00", "00", "00", "00", "00", "02", "C0"])
    expect(start.slice(12, 16)).toEqual(["20", "21", "22", "23"])
    expect(start.slice(716, 720)).toEqual(["32", "CD", "00", "00"])
  })

  test("chunks a program image, advances addresses, and writes the full-image checksum block", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-spacewire-payload-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const payloadFile = join(workspaceRoot, "program.bin")
    writeFileSync(payloadFile, new Uint8Array(705).fill(1))
    const paths = resolveDefaultPaths(workspaceRoot)
    const definitions = await createSpaceWireDefinitions(workspaceRoot)
    const protocol = definitions.protocols.find((item) => item.bus_context?.bus_type === "SpaceWire")!
    protocol.block_layout!.payload_file = payloadFile
    const dataFileIndex = prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT)
    const result = writeDtpProtocolDataFiles(paths, definitions, dataFileIndex)
    const generated = result.generated_files.find((item) => item.protocol_name === "\u7ba1\u63a7\u7a0b\u5e8f\u4e0a\u6ce8\u6570\u636e\u5757")!
    const lines = readFileSync(generated.absolute_file_path!, "utf-8").trim().split(/\r?\n/).map((line) => line.split(/\s+/))

    expect(lines).toHaveLength(3)
    expect(lines.every((line) => line.length === 720)).toBe(true)
    expect(lines[0].slice(2, 12)).toEqual(["01", "00", "10", "00", "00", "00", "00", "00", "02", "C0"])
    expect(lines[1].slice(2, 12)).toEqual(["01", "05", "10", "00", "02", "C0", "00", "00", "02", "C0"])
    expect(lines[2].slice(2, 16)).toEqual(["01", "0A", "10", "00", "00", "00", "00", "00", "02", "C1", "00", "00", "02", "C1"])
    expect(lines[0].slice(12, 716).every((byte) => byte === "01")).toBe(true)
    expect(lines[1][12]).toBe("01")
    expect(lines[1].slice(13, 716).every((byte) => byte === "00")).toBe(true)
    const preview = buildDtpProtocolWriterPreview(paths, definitions, dataFileIndex)
    const quality = buildDtpDataQualityReport(paths, definitions, preview, dataFileIndex)
    expect(quality.issue_counts.error).toBe(0)
  })

  test("reuses the generated SpaceWire block file for case-level step data", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-spacewire-case-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const payloadFile = join(workspaceRoot, "program.bin")
    writeFileSync(payloadFile, new Uint8Array(705).fill(1))
    const paths = resolveDefaultPaths(workspaceRoot)
    const definitions = await createSpaceWireDefinitions(workspaceRoot)
    definitions.protocols[0].block_layout!.payload_file = payloadFile
    const dataFileIndex = prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT)
    writeDtpProtocolDataFiles(paths, definitions, dataFileIndex)

    const generated = await buildGeneratedStepWithPlanning({
      step: {
        stepIndex: 1,
        keywordName: "\u53d1\u9001SpaceWire\u6570\u636e_\u6570\u636e\u6587\u4ef6",
        stepDescription: "\u7b2c1.0\u79d2,\u901a\u8fc7SpaceWire\u603b\u7ebf\u53d1\u9001\u6b63\u786e\u7684\u7ba1\u63a7\u7a0b\u5e8f\u4e0a\u6ce8\u6570\u636e\u5757",
        timeValue: 1,
      },
      caseContext: {
        caseId: "TC-SW-001",
        testPurpose: "SpaceWire program upload",
        correspondFunId: "TR-GN-SWRC-001",
        requirementIds: ["TR-GN-SWRC-001"],
        steps: [],
      },
      keywordDef: {
        keywordName: "\u53d1\u9001SpaceWire\u6570\u636e_\u6570\u636e\u6587\u4ef6",
        txtPath: "",
        jsonPath: "",
        arguments: [
          { name: "${time}", comments: "execution time" },
          { name: "${para1}", comments: "ID" },
          { name: "${para2}", comments: "data file" },
          { name: "${para3}", comments: "cycle" },
        ],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex: createSpaceWireKnowledgeIndex(workspaceRoot),
      dataFileIndex,
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions: definitions,
    })

    expect(generated.data_generation_plan?.protocol_id).toBe(definitions.protocols[0].protocol_id)
    expect(generated.data_generation_plan?.bus).toBe("SpaceWire")
    const outputFile = generated.generated_data_files[0]
    const outputLines = readFileSync(
      join(paths.inputDataRoot, outputFile.file_path.replace(/^\u8f93\u5165\u6570\u636e[\\/]/, "")),
      "utf-8",
    ).trim().split(/\r?\n/).map((line) => line.split(/\s+/))
    expect(outputLines).toHaveLength(3)
    expect(outputLines[0].slice(12, 716).every((byte) => byte === "01")).toBe(true)
    expect(outputLines[1][12]).toBe("01")
    expect(outputLines[2].slice(8, 16)).toEqual(["00", "00", "02", "C1", "00", "00", "02", "C1"])
    expect(generated.data_quality?.status).not.toBe("failed")
  })

  test("infers SpaceWire from an implicit program-upload start-block memory-write step", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-spacewire-implicit-start-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const payloadFile = join(workspaceRoot, "program.bin")
    writeFileSync(payloadFile, Uint8Array.from({ length: 704 }, (_, index) => (0x20 + index) & 0xff))
    const paths = resolveDefaultPaths(workspaceRoot)
    const definitions = await createSpaceWireDefinitions(workspaceRoot)
    definitions.protocols[0].block_layout!.payload_file = payloadFile
    const dataFileIndex = prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT)
    writeDtpProtocolDataFiles(paths, definitions, dataFileIndex)

    const generated = await buildGeneratedStepWithPlanning({
      step: {
        stepIndex: 3,
        keywordName: "\u8bbe\u7f6e\u5185\u5b58\u6570\u636e_\u6570\u636e\u6587\u4ef6",
        stepDescription: "\u7b2c3.0\u79d2\uff0c\u8bbe\u7f6e\u5185\u5b58\u5730\u574021142000H\u7684\u6570\u636e\u4e3a\u7ba1\u63a7\u7a0b\u5e8f\u4e0a\u6ce8\u8d77\u59cb\u5757\u5168\u90e8\u5b57\u6bb5\u6b63\u786e\u3002",
        timeValue: 3,
      },
      caseContext: {
        caseId: "TC-SW-IMPLICIT-001",
        steps: [],
      },
      keywordDef: {
        keywordName: "\u8bbe\u7f6e\u5185\u5b58\u6570\u636e_\u6570\u636e\u6587\u4ef6",
        txtPath: "",
        jsonPath: "",
        arguments: [
          { name: "${time}", comments: "execution time" },
          { name: "${para1}", comments: "target address" },
          { name: "${para2}", comments: "data file" },
        ],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex: createSpaceWireKnowledgeIndex(workspaceRoot),
      dataFileIndex,
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions: definitions,
    })

    expect(generated.data_generation_plan).toMatchObject({
      protocol_id: definitions.protocols[0].protocol_id,
      bus: "SpaceWire",
      operation: "memory_write",
      target_address: "21142000",
      protocol_entity: "\u7ba1\u63a7\u7a0b\u5e8f\u4e0a\u6ce8",
      artifact_scope: "single_block",
      selected_block: "start-block",
      variant_type: "correct",
    })
    const outputFile = generated.generated_data_files[0]
    expect(outputFile.requested_file_name).toContain("\u7ba1\u63a7\u7a0b\u5e8f\u4e0a\u6ce8\u6570\u636e\u5757-\u8d77\u59cb\u5757-\u6b63\u5e38")
    const outputLines = readFileSync(
      join(paths.inputDataRoot, outputFile.file_path.replace(/^\u8f93\u5165\u6570\u636e[\\/]/, "")),
      "utf-8",
    ).trim().split(/\r?\n/).map((line) => line.split(/\s+/))
    expect(outputLines).toHaveLength(1)
    expect(outputLines[0]).toHaveLength(720)
    expect(outputLines[0].slice(0, 12)).toEqual(["00", "00", "01", "00", "10", "00", "00", "00", "00", "00", "02", "C0"])
    expect(outputLines[0].slice(716, 720)).toEqual(["32", "CD", "00", "00"])
    expect(generated.data_quality?.status).not.toBe("failed")
  })

  test("does not reuse a management-control upload block for a secondary-node upload", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-spacewire-entity-scope-${Date.now()}`)
    mkdirSync(join(workspaceRoot, ".matrix", "data", "DTPProject"), { recursive: true })
    const paths = resolveDefaultPaths(workspaceRoot)
    const definitions = await createSpaceWireDefinitions(workspaceRoot)
    const generated = await buildGeneratedStepWithPlanning({
      step: {
        stepIndex: 1,
        keywordName: "\u8bbe\u7f6e\u5185\u5b58\u6570\u636e_\u6570\u636e\u6587\u4ef6",
        stepDescription: "\u7b2c1.0\u79d2\uff0c\u8bbe\u7f6e\u5185\u5b58\u5730\u574021142000H\u7684\u6570\u636e\u4e3a\u4e8c\u7ea7\u8282\u70b9\u7a0b\u5e8f\u4e0a\u6ce8\u8d77\u59cb\u5757\u5168\u90e8\u5b57\u6bb5\u6b63\u786e\u3002",
        timeValue: 1,
      },
      caseContext: { caseId: "TC-SW-ENTITY-001", steps: [] },
      keywordDef: {
        keywordName: "\u8bbe\u7f6e\u5185\u5b58\u6570\u636e_\u6570\u636e\u6587\u4ef6",
        txtPath: "",
        jsonPath: "",
        arguments: [
          { name: "${time}", comments: "execution time" },
          { name: "${para1}", comments: "target address" },
          { name: "${para2}", comments: "data file" },
        ],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex: createSpaceWireKnowledgeIndex(workspaceRoot),
      dataFileIndex: prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT),
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions: definitions,
    })

    expect(generated.data_generation_plan?.protocol_id).not.toBe(definitions.protocols[0].protocol_id)
    expect(generated.data_quality?.status).toBe("failed")
    expect(generated.generated_data_files[0]?.requested_file_name).toContain("\u5f85\u786e\u8ba4")
  })

  test("renders a canonical SpaceWire start block without a pre-generated project baseline", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-spacewire-direct-case-${Date.now()}`)
    const paths = resolveDefaultPaths(workspaceRoot)
    mkdirSync(paths.inputDataRoot, { recursive: true })
    const knowledgeIndex = createSpaceWireKnowledgeIndex(workspaceRoot)
    const definitions = await buildDtpProtocolDefinitionsDocument(paths, knowledgeIndex, {
      understandSectionProtocols: async () => ({ protocols: [], non_generated_tables: [], warnings: [] }),
    })
    const dataFileIndex = prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT)

    const generated = await buildGeneratedStepWithPlanning({
      step: {
        stepIndex: 1,
        keywordName: "\u8bbe\u7f6e32\u4f4d\u5730\u5740\u6570\u636e",
        stepDescription: "\u7b2c3.0\u79d2\uff0c\u8bbe\u7f6e\u5185\u5b58\u5730\u574021142000H\u7684\u6570\u636e\u4e3a\u201c\u7ba1\u63a7\u7a0b\u5e8f\u4e0a\u6ce8\u8d77\u59cb\u5757\u00b7\u5168\u90e8\u5b57\u6bb5\u6b63\u786e\u201d",
        timeValue: 3,
      },
      caseContext: { caseId: "TC-SW-DIRECT-001", steps: [] },
      keywordDef: {
        keywordName: "\u8bbe\u7f6e32\u4f4d\u5730\u5740\u6570\u636e",
        txtPath: "",
        jsonPath: "",
        arguments: [
          { name: "${time}", comments: "\u6267\u884c\u65f6\u95f4" },
          { name: "${para1}", comments: "\u53c2\u65701\uff1a\u8d77\u59cb\u5730\u5740\uff0c\u5341\u516d\u8fdb\u5236" },
          { name: "${para2}", comments: "\u53c2\u65702\uff1a\u6570\u636e\u6216\u6587\u4ef6\uff0c\u6587\u4ef6\u7c7b\u578b\u5305\u62ectxt\u548cbin" },
        ],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex,
      dataFileIndex,
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions: definitions,
    })

    const output = generated.generated_data_files[0]
    const bytes = readFileSync(
      join(paths.inputDataRoot, output.file_path.replace(/^\u8f93\u5165\u6570\u636e[\\/]/, "")),
      "utf-8",
    ).trim().split(/\s+/)
    expect(generated.data_generation_plan).toMatchObject({
      protocol_id: definitions.protocols[0].protocol_id,
      operation: "memory_write",
      target_address: "21142000",
      selected_block: "start-block",
    })
    expect(generated.resolved_arguments).toContainEqual(expect.objectContaining({
      name: "${para1}",
      value: "21142000",
      semantic: "target_address",
    }))
    expect(bytes).toHaveLength(720)
    expect(bytes.slice(0, 12)).toEqual(["00", "00", "01", "00", "10", "00", "00", "00", "00", "00", "02", "C0"])
    expect(bytes.slice(712, 716)).toEqual(["00", "00", "00", "00"])
  })

  test("passes explicit memory-write hexadecimal data inline for a data-or-file argument", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-inline-memory-data-${Date.now()}`)
    const paths = resolveDefaultPaths(workspaceRoot)
    mkdirSync(paths.inputDataRoot, { recursive: true })
    const knowledgeIndex = createEmptyKnowledgeIndex(workspaceRoot)
    const dataFileIndex = prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT)

    const generated = await buildGeneratedStepWithPlanning({
      step: {
        stepIndex: 2,
        keywordName: "\u8bbe\u7f6e32\u4f4d\u5730\u5740\u6570\u636e",
        stepDescription: "\u7b2c3.1\u79d2\uff0c\u8bbe\u7f6e\u5185\u5b58\u5730\u574021142E00H\u7684\u6570\u636e\u4e3a\u201c2501H\u201d",
        timeValue: 3.1,
      },
      caseContext: { caseId: "TC-SW-INLINE-001", steps: [] },
      keywordDef: {
        keywordName: "\u8bbe\u7f6e32\u4f4d\u5730\u5740\u6570\u636e",
        txtPath: "",
        jsonPath: "",
        arguments: [
          { name: "${time}", comments: "\u6267\u884c\u65f6\u95f4" },
          { name: "${para1}", comments: "\u53c2\u65701\uff1a\u8d77\u59cb\u5730\u5740\uff0c\u5341\u516d\u8fdb\u5236" },
          { name: "${para2}", comments: "\u53c2\u65702\uff1a\u6570\u636e\u6216\u6587\u4ef6\uff0c\u6587\u4ef6\u7c7b\u578b\u5305\u62ectxt\u548cbin" },
        ],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex,
      dataFileIndex,
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions: {
        schema_version: "4.0.0",
        project_root: workspaceRoot,
        knowledge_index_file: paths.projectKnowledgeIndexFile,
        source: "heuristic-fallback",
        sections: [],
        protocols: [],
        non_generated_tables: [],
        warnings: [],
        updated_at: new Date().toISOString(),
      },
    })

    expect(generated.generated_data_files).toEqual([])
    expect(generated.resolved_arguments).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "${time}", value: 3.1, semantic: "time" }),
      expect.objectContaining({ name: "${para1}", value: "21142E00", semantic: "target_address" }),
      expect.objectContaining({ name: "${para2}", value: "2501H", semantic: "inline_data" }),
    ]))
    expect(generated.resolved_arguments.some((argument) => argument.value === "TODO")).toBe(false)
  })

  test("rejects persisted protocol definitions from before schema v4", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "dtp-schema-v4-"))
    const definitionsFile = join(workspaceRoot, "dtp-protocol-definitions.json")
    writeFileSync(definitionsFile, JSON.stringify({
      schema_version: "3.0.0",
      project_root: workspaceRoot,
      protocols: [],
    }), "utf-8")

    expect(loadDtpProtocolDefinitions(definitionsFile, workspaceRoot)).toBeNull()
  })

  test("canonicalizes structurally identical protocols and merges their provenance", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "dtp-canonical-protocol-"))
    const protocol = (
      protocolId: string,
      priority: "primary" | "referenced",
      documentId: string,
    ) => ({
      protocol_id: protocolId,
      source_section: "3.1.3.3 遥控指令应答格式定义",
      flow_direction: "input" as const,
      base_file_name: "15字节遥控指令应答",
      generation_mode: "single_file" as const,
      frames: [{
        frame_id: "response",
        sequence: 1,
        source_table_id: documentId + "-table",
        byte_layout: ["41", "48", "01", "FF", "20", "FF", "20", "FF", "20", "5E"],
        field_layout: [],
      }],
      bus_context: { bus_type: "CAN" as const, interface_level: "secondary" as const },
      fields: [],
      evidence: ["遥控指令应答格式定义"],
      warnings: [],
      confidence: 1,
      understanding_source: "model" as const,
      provenance: [{
        source_document_id: documentId,
        source_table_ids: [documentId + "-table"],
        source_sections: ["3.1.3.3"],
        evidence: ["遥控指令应答格式定义"],
        priority,
      }],
    })
    const definitions = migrateDtpProtocolDefinitionsDocument({
      schema_version: "4.0.0",
      project_root: workspaceRoot,
      knowledge_index_file: "project-knowledge-index.json",
      source: "model",
      sections: [{
        section_model_id: "response-section",
        section_title: "遥控指令应答",
        protocol_ids: ["referenced-response", "primary-response"],
        warnings: [],
      }],
      protocols: [
        protocol("referenced-response", "referenced", "doc-spec"),
        protocol("primary-response", "primary", "doc-test"),
      ],
      non_generated_tables: [],
      warnings: [],
      updated_at: new Date().toISOString(),
    })

    expect(definitions.protocols).toHaveLength(1)
    expect(definitions.protocols[0].protocol_id).toBe("primary-response")
    expect(definitions.protocols[0].provenance?.map((item) => item.source_document_id).sort())
      .toEqual(["doc-spec", "doc-test"])
    expect(definitions.protocols[0].frames?.[0].wire_length).toBe(10)
    expect(definitions.sections[0].protocol_ids).toEqual(["primary-response"])
  })

  test("recognizes an English ack suffix as a response protocol role", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "dtp-english-ack-role-"))
    const definitions = createProtocolDefinitions(workspaceRoot, [{
      protocol_id: "secondary-command-ack",
      source_section: "附录G 二级CAN总线协议",
      flow_direction: "input",
      base_file_name: "sec_can_cmd_10byte_ack",
      generation_mode: "single_file",
      frames: [{
        frame_id: "response",
        sequence: 1,
        source_table_id: "response-table",
        byte_layout: ["41", "48", "01", "FF", "20", "FF", "20", "FF", "20", "5E"],
        field_layout: [],
      }],
      bus_context: { bus_type: "CAN", interface_level: "secondary" },
      fields: [],
      evidence: ["表2 10字节遥控指令应答格式定义"],
      warnings: [],
      confidence: 1,
      understanding_source: "model",
    }])

    expect(definitions.protocols[0].semantic_identity?.role).toBe("response")
  })

  test("inherits a unique secondary CAN FPGA envelope into referenced protocols from the same document", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "dtp-secondary-envelope-"))
    const makeProtocol = (
      protocolId: string,
      name: string,
      bytes: string[],
      frameEnvelope?: DtpProtocolDefinitionsDocument["protocols"][number]["frame_envelope"],
    ): DtpProtocolDefinitionsDocument["protocols"][number] => ({
      protocol_id: protocolId,
      source_section: protocolId === "secondary-command" ? "3.1.3 二级CAN" : "附录G 二级CAN",
      flow_direction: "input",
      base_file_name: name,
      generation_mode: "single_file",
      frames: [{
        frame_id: "frame-1",
        sequence: 1,
        source_table_id: `${protocolId}-table`,
        byte_layout: bytes,
        field_layout: [],
      }],
      bus_context: { bus_type: "CAN", interface_level: "secondary" },
      frame_envelope: frameEnvelope,
      fields: [],
      evidence: [name],
      warnings: [],
      confidence: 1,
      understanding_source: "heuristic-fallback",
      provenance: [{
        source_document_id: "doc-test",
        source_table_ids: [`${protocolId}-table`],
        source_sections: [protocolId === "secondary-command" ? "3.1.3" : "附录G"],
        evidence: [name],
        priority: protocolId === "secondary-command" ? "primary" : "referenced",
      }],
    })
    const definitions = createProtocolDefinitions(workspaceRoot, [
      makeProtocol(
        "secondary-command",
        "10字节遥控指令",
        ["4D", "28", "00", "0A", "40", "01", "0D", "10", "06", "00"],
        { type: "fixed_prefix", bytes: ["00", "08"], applies_per_frame: true },
      ),
      makeProtocol(
        "secondary-response",
        "10字节遥控指令应答",
        ["41", "48", "01", "FF", "20", "FF", "20", "FF", "20", "5E"],
      ),
    ])

    expect(definitions.protocols.find((protocol) => protocol.protocol_id === "secondary-response")?.frame_envelope)
      .toEqual({ type: "fixed_prefix", bytes: ["00", "08"], applies_per_frame: true })
  })

  test("does not reuse a secondary CAN command anchor for an explicit response step", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "dtp-response-anchor-"))
    const paths = resolveDefaultPaths(workspaceRoot)
    mkdirSync(paths.inputDataRoot, { recursive: true })
    const makeProtocol = (
      protocolId: string,
      name: string,
      bytes: string[],
    ): DtpProtocolDefinitionsDocument["protocols"][number] => ({
      protocol_id: protocolId,
      source_section: "appendix-G 附录G 二级CAN总线协议",
      flow_direction: "unknown",
      base_file_name: name,
      generation_mode: "single_file",
      frames: [{
        frame_id: "frame-1",
        sequence: 1,
        source_table_id: `${protocolId}-table`,
        byte_layout: bytes,
        field_layout: [],
      }],
      bus_context: { bus_type: "CAN", interface_level: "secondary" },
      fields: [],
      evidence: [name],
      warnings: [],
      confidence: 1,
      understanding_source: "heuristic-fallback",
    })
    const definitions = createProtocolDefinitions(workspaceRoot, [
      makeProtocol(
        "secondary-command",
        "二级CAN_10字节遥控指令",
        ["41", "08", "20", "01", "00", "00", "00", "00", "00", "21"],
      ),
      makeProtocol(
        "secondary-response",
        "二级CAN_10字节遥控指令应答",
        ["41", "48", "01", "FF", "20", "FF", "20", "FF", "20", "5E"],
      ),
    ])
    const response = definitions.protocols.find((protocol) => protocol.protocol_id === "secondary-response")
    expect(response?.aliases).toEqual(expect.arrayContaining(["遥控指令应答", "10字节遥控指令应答"]))

    const generated = await buildGeneratedStepWithPlanning({
      step: {
        stepIndex: 2,
        keywordName: "发送二级CAN-TXT数据",
        stepDescription: "第3.1秒，发送二级CAN数据为站地址01H的正确的10字节遥控指令应答",
      },
      caseContext: { caseId: "TC-JK-019", steps: [] },
      keywordDef: {
        keywordName: "发送二级CAN-TXT数据",
        txtPath: "",
        jsonPath: "",
        arguments: [{ name: "${para1}", comments: "数据文件" }],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot),
      dataFileIndex: prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT),
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions: definitions,
      protocolAnchorId: "secondary-command",
    })

    expect(generated.data_generation_plan?.protocol_id).toBe("secondary-response")
    expect(generated.data_generation_plan?.protocol_name).toContain("遥控指令应答")
    expect(generated.data_generation_plan?.selection_source).not.toBe("case_anchor")
    expect(generated.generated_data_files[0].requested_file_name).toBe("S02-二级CAN_10字节遥控指令应答-正常.txt")
  })

  test("uses response relations without treating the command length as response wire length", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "dtp-response-relation-"))
    const paths = resolveDefaultPaths(workspaceRoot)
    mkdirSync(paths.inputDataRoot, { recursive: true })
    const makeProtocol = (protocolId: string, name: string, bytes: string[]) => ({
      protocol_id: protocolId,
      source_section: "二级CAN " + name,
      flow_direction: "input" as const,
      base_file_name: name,
      generation_mode: "single_file" as const,
      frames: [{
        frame_id: "frame-1",
        sequence: 1,
        source_table_id: protocolId + "-table",
        byte_layout: bytes,
        field_layout: [],
      }],
      bus_context: { bus_type: "CAN" as const, interface_level: "secondary" as const },
      fields: [],
      evidence: [name],
      warnings: [],
      confidence: 1,
      understanding_source: "model" as const,
    })
    const definitions = createProtocolDefinitions(workspaceRoot, [
      makeProtocol("command-10", "10字节遥控指令", Array(10).fill("10")),
      makeProtocol("command-15", "15字节遥控指令", Array(15).fill("15")),
      makeProtocol("response-to-10", "10字节遥控指令应答", ["41", "48", "01", "FF", "20", "FF", "20", "FF", "20", "5E"]),
      makeProtocol("response-to-15", "15字节遥控指令应答", ["42", "48", "01", "FF", "20", "FF", "20", "FF", "20", "5F"]),
    ])

    expect(definitions.relations).toContainEqual(expect.objectContaining({
      type: "responds_to",
      source_id: "response-to-15",
      target_ids: ["command-15"],
    }))

    const generated = await buildGeneratedStepWithPlanning({
      step: {
        stepIndex: 1,
        keywordName: "发送二级CAN数据_数据文件",
        stepDescription: "第1.0秒，通过二级CAN总线发送正确的15字节遥控指令应答",
      },
      caseContext: { caseId: "TC-RESPONSE-RELATION", steps: [] },
      keywordDef: {
        keywordName: "发送二级CAN数据_数据文件",
        txtPath: "",
        jsonPath: "",
        arguments: [{ name: "$" + "{para2}", comments: "数据文件" }],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex: createEmptyKnowledgeIndex(workspaceRoot),
      dataFileIndex: prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT),
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions: definitions,
    }, {
      planCaseStepData: async () => ({
        protocol_id: "response-to-10",
        protocol_name: "10字节遥控指令应答",
        flow_direction: "input",
        bus: "CAN",
        artifact_scope: "single_block",
        selected_block: "start-block",
        variant_type: "correct",
        mutations: [],
        sequence_operations: [],
        checksum_policy: "none",
        argument_values: {},
        evidence_ids: [],
        confidence: 1,
        warnings: [],
      }),
    })

    expect(generated.data_generation_plan?.protocol_id).toBe("response-to-15")
    expect(generated.data_generation_plan?.payload_length_bytes).toBeUndefined()
    expect(generated.data_generation_plan?.related_message_length_bytes).toBe(15)
    expect(generated.data_generation_plan?.selection_source).toBe("protocol_relation")
    expect(generated.data_generation_plan?.selected_block).toBeUndefined()
    expect(generated.generated_data_files[0].requested_file_name).toBe("S01-15字节遥控指令应答-正常.txt")
    const output = readFileSync(join(
      paths.inputDataRoot,
      INPUT_FLOW,
      "用例生成",
      "TC-RESPONSE-RELATION",
      generated.generated_data_files[0].requested_file_name,
    ), "utf-8").trim().split(/\s+/)
    expect(output).toHaveLength(10)
    expect(output).toEqual(["42", "48", "01", "FF", "20", "FF", "20", "FF", "20", "5F"])
  })

  test("reuses a physically wrapped verified start-block file as one logical block", async () => {
    const workspaceRoot = join(tmpdir(), `dtp-spacewire-wrapped-start-${Date.now()}`)
    const paths = resolveDefaultPaths(workspaceRoot)
    mkdirSync(paths.inputDataRoot, { recursive: true })
    const definitions = await createSpaceWireDefinitions(workspaceRoot)
    const payload = Array.from({ length: 704 }, (_, index) => (0x20 + index) & 0xff)
    const bytes = [
      0x00, 0x00, 0x01, 0x00, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0xc0,
      ...payload,
      0x32, 0xcd, 0x00, 0x00,
    ].map((value) => value.toString(16).toUpperCase().padStart(2, "0"))
    const baselinePath = join(paths.inputDataRoot, "管控程序上注-起始块.txt")
    writeFileSync(
      baselinePath,
      `${Array.from({ length: Math.ceil(bytes.length / 16) }, (_, index) => (
        bytes.slice(index * 16, (index + 1) * 16).join(" ")
      )).join("\n")}\n`,
      "utf-8",
    )
    const dataFileIndex = prepareProjectDataFileIndex(paths, EMPTY_DOCS_CONTEXT)
    dataFileIndex.entries.push({
      id: "verified-spacewire-start-block",
      protocol_name: "管控程序上注起始块",
      requested_file_name: "管控程序上注-起始块.txt",
      file_path: "输入数据\\管控程序上注-起始块.txt",
      absolute_file_path: baselinePath,
      source: "existing-file",
      source_documents: [],
      generation_basis: ["verified-reference-vector"],
      flow_direction: "input",
      confidence: 1,
      state: "validated",
      warnings: [],
    })

    const generated = await buildGeneratedStepWithPlanning({
      step: {
        stepIndex: 3,
        keywordName: "设置内存数据_数据文件",
        stepDescription: "第3.0秒，设置内存地址21142000H的数据为管控程序上注起始块全部字段正确。",
        timeValue: 3,
      },
      caseContext: { caseId: "TC-SW-WRAPPED-001", steps: [] },
      keywordDef: {
        keywordName: "设置内存数据_数据文件",
        txtPath: "",
        jsonPath: "",
        arguments: [
          { name: "${time}", comments: "execution time" },
          { name: "${para1}", comments: "target address" },
          { name: "${para2}", comments: "data file" },
        ],
      },
      inputDataRoot: paths.inputDataRoot,
      workspaceRoot,
      knowledgeIndex: createSpaceWireKnowledgeIndex(workspaceRoot),
      dataFileIndex,
      docsContext: EMPTY_DOCS_CONTEXT,
      protocolDefinitions: definitions,
    })

    const output = generated.generated_data_files[0]
    const outputBytes = readFileSync(
      join(paths.inputDataRoot, output.file_path.replace(/^输入数据[\\/]/, "")),
      "utf-8",
    ).trim().split(/\s+/)
    expect(generated.data_generation_plan?.protocol_id).toBe(definitions.protocols[0].protocol_id)
    expect(generated.resolved_arguments).toContainEqual(expect.objectContaining({
      name: "${para1}",
      value: "21142000",
      semantic: "target_address",
    }))
    expect(outputBytes).toEqual(bytes)
    expect(generated.data_quality?.issues.filter((issue) => issue.severity === "error")).toEqual([])
  })
})
