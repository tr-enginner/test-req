import {describe, expect, test} from "bun:test"
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {applyPhase2InlineBatch, describePhase2InlineEditor, encodePhase2EditKey, phase2EditorMutationFiles} from "../src/tools/phase2-editor"
import {validateGenericInterfaceTableUniqueness} from "../src/tools/filldata-phase2-workflow"

describe("Phase 2 inline editor", () => {
  test("reuses the inline descriptor until an editable raw file changes", () => {
    const directory = mkdtempSync(join(tmpdir(), "phase2-inline-cache-")), data = join(directory, ".matrix", "data")
    mkdirSync(data, {recursive: true})
    const raw = join(data, "chapter1-scope.raw.json")
    writeFileSync(raw, JSON.stringify({document_id: "A"}))
    writeFileSync(join(data, "primary-structure.json"), JSON.stringify({sections: []}))
    writeFileSync(join(data, "source-artifacts.json"), JSON.stringify({primary_document: {role: "primary", structure_path: join(data, "primary-structure.json")}}))
    const first = describePhase2InlineEditor(directory)
    expect(describePhase2InlineEditor(directory)).toBe(first)
    writeFileSync(raw, JSON.stringify({document_id: "B", changed: true}))
    const next = describePhase2InlineEditor(directory)
    expect(next).not.toBe(first)
    expect(next.revision).not.toBe(first.revision)
  })

  test("does not reject a chapter edit when another chapter raw artifact changes", () => {
    const directory = mkdtempSync(join(tmpdir(), "phase2-artifact-revision-")), data = join(directory, ".matrix", "data")
    mkdirSync(join(data, "hardware-interface-blocks"), {recursive: true})
    writeFileSync(join(data, "chapter2-system-overview.raw.json"), JSON.stringify({software_name_and_id: "OLD"}))
    writeFileSync(join(data, "primary-structure.json"), JSON.stringify({sections: []}))
    writeFileSync(join(data, "source-artifacts.json"), JSON.stringify({primary_document: {role: "primary", structure_path: join(data, "primary-structure.json")}}))
    const descriptor = describePhase2InlineEditor(directory)
    writeFileSync(join(data, "hardware-interface-blocks", "if-1.raw.json"), JSON.stringify({interface: {interface_id: "IF-1"}}))
    const result = applyPhase2InlineBatch({directory, expected_revision: descriptor.revision,
      expected_artifact_revisions: descriptor.artifact_revisions, changes: [{
        edit_key: encodePhase2EditKey({artifact: "chapter2-system-overview.json", field: "software_name_and_id"}), value: "NEW"
      }]})
    expect(result.ok).toBe(true)
    expect(JSON.parse(readFileSync(join(data, "chapter2-system-overview.raw.json"), "utf8")).software_name_and_id).toBe("NEW")
  })

  test("still rejects an edit when the same chapter raw artifact changes", () => {
    const directory = mkdtempSync(join(tmpdir(), "phase2-same-artifact-revision-")), data = join(directory, ".matrix", "data")
    mkdirSync(data, {recursive: true})
    const raw = join(data, "chapter2-system-overview.raw.json")
    writeFileSync(raw, JSON.stringify({software_name_and_id: "OLD"}))
    writeFileSync(join(data, "primary-structure.json"), JSON.stringify({sections: []}))
    writeFileSync(join(data, "source-artifacts.json"), JSON.stringify({primary_document: {role: "primary", structure_path: join(data, "primary-structure.json")}}))
    const descriptor = describePhase2InlineEditor(directory)
    writeFileSync(raw, JSON.stringify({software_name_and_id: "GENERATED"}))
    expect(() => applyPhase2InlineBatch({directory, expected_revision: descriptor.revision,
      expected_artifact_revisions: descriptor.artifact_revisions, changes: [{
        edit_key: encodePhase2EditKey({artifact: "chapter2-system-overview.json", field: "software_name_and_id"}), value: "USER"
      }]})).toThrow("chapter2-system-overview.json的raw工件已发生变化")
  })

  test("resolves raw mutation targets and editor state before applying a batch", () => {
    const directory = mkdtempSync(join(tmpdir(), "phase2-mutation-files-")), data = join(directory, ".matrix", "data")
    mkdirSync(data, {recursive: true})
    const raw = join(data, "performance.raw.json")
    writeFileSync(raw, JSON.stringify({rows: [{requirement_id: "TR-XN-001", source_refs: ["primary::SRS-1"]}]}))
    writeFileSync(join(data, "performance-test-content.json"), JSON.stringify({rows: [{requirement_id: "TR-XN-001"}]}))
    const key = encodePhase2EditKey({artifact: "performance-test-content.json", container_id: "performance", field: "rows"})
    expect(phase2EditorMutationFiles({directory, expected_revision: "revision", requirement_operations: [
      {container_key: key, operation: "add_requirement", initial_value: {description: "新增", source_refs: ["primary::SRS-1"]}},
    ]})).toEqual([raw, join(data, "phase2-editor-state.json")].sort())
  })

  test("applies only whitelisted opaque field bindings in one batch", () => {
    const directory = mkdtempSync(join(tmpdir(), "phase2-inline-")), data = join(directory, ".matrix", "data")
    mkdirSync(data, {recursive: true})
    writeFileSync(join(data, "chapter1-scope.raw.json"), JSON.stringify({document_id: "OLD", document_version: "1.0", source_refs: ["primary::SRS-1"]}))
    writeFileSync(join(data, "primary-structure.json"), JSON.stringify({sections: [{section_id: "SRS-1", source_ref: "primary::SRS-1", title: "范围"}]}))
    writeFileSync(join(data, "source-artifacts.json"), JSON.stringify({primary_document: {role: "primary", structure_path: join(data, "primary-structure.json")}, supporting_documents: []}))
    const descriptor = describePhase2InlineEditor(directory)
    const result = applyPhase2InlineBatch({directory, expected_revision: descriptor.revision, changes: [{
      edit_key: encodePhase2EditKey({artifact: "chapter1-scope.json", field: "document_id"}), value: "NEW"
    }]})
    expect(result.ok).toBe(true)
    expect(JSON.parse(readFileSync(join(data, "chapter1-scope.raw.json"), "utf8")).document_id).toBe("NEW")
  })

  test("adds, updates, and deletes chapter 1 project references by document id", () => {
    const directory = mkdtempSync(join(tmpdir(), "phase2-references-")), data = join(directory, ".matrix", "data")
    mkdirSync(data, {recursive: true})
    const rawPath = join(data, "chapter1-scope.raw.json")
    writeFileSync(rawPath, JSON.stringify({references: [
      {document_id: "PROJECT-A", document_title: "原名称", source_kind: "source_document", evidence: "原始需求"},
      {document_id: "PROJECT-B", document_title: "待删除", source_kind: "source_document", evidence: "原始需求"},
    ]}))
    writeFileSync(join(data, "primary-structure.json"), JSON.stringify({sections: []}))
    writeFileSync(join(data, "source-artifacts.json"), JSON.stringify({primary_document: {role: "primary", structure_path: join(data, "primary-structure.json")}}))
    const descriptor = describePhase2InlineEditor(directory)
    const container = encodePhase2EditKey({artifact: "chapter1-scope.json", field: "references"})
    applyPhase2InlineBatch({directory, expected_revision: descriptor.revision, changes: [], reference_operations: [
      {container_key: container, operation: "update_reference", reference_key: "project-a", initial_value: {document_id: "PROJECT-A2", document_title: "修改后名称"}},
      {container_key: container, operation: "delete_reference", reference_key: "PROJECT-B"},
      {container_key: container, operation: "add_reference", initial_value: {document_id: "PROJECT-C", document_title: "在线新增"}},
    ]})
    expect(JSON.parse(readFileSync(rawPath, "utf8")).references).toEqual([
      {document_id: "PROJECT-A2", document_title: "修改后名称", source_kind: "source_document", evidence: "原始需求"},
      {document_id: "PROJECT-C", document_title: "在线新增", source_kind: "manual_edit", evidence: "在线编辑添加"},
    ])
  })

  test("rejects reference ids that conflict with immutable or project references", () => {
    const directory = mkdtempSync(join(tmpdir(), "phase2-reference-conflict-")), data = join(directory, ".matrix", "data")
    mkdirSync(data, {recursive: true})
    const rawPath = join(data, "chapter1-scope.raw.json")
    writeFileSync(rawPath, JSON.stringify({references: [{document_id: "PROJECT-A", document_title: "项目引用", source_kind: "source_document", evidence: "原始需求"}]}))
    writeFileSync(join(data, "primary-structure.json"), JSON.stringify({sections: []}))
    writeFileSync(join(data, "source-artifacts.json"), JSON.stringify({primary_document: {role: "primary", structure_path: join(data, "primary-structure.json")}}))
    const descriptor = describePhase2InlineEditor(directory), container = encodePhase2EditKey({artifact: "chapter1-scope.json", field: "references"})
    expect(() => applyPhase2InlineBatch({directory, expected_revision: descriptor.revision, changes: [], reference_operations: [
      {container_key: container, operation: "add_reference", initial_value: {document_id: "project-a", document_title: "重复"}},
    ]})).toThrow("已存在")
    expect(() => applyPhase2InlineBatch({directory, expected_revision: descriptor.revision, changes: [], reference_operations: [
      {container_key: container, operation: "add_reference", initial_value: {document_id: "qj 3027a-2016", document_title: "冲突"}},
    ]})).toThrow("固定或自动维护")
    expect(JSON.parse(readFileSync(rawPath, "utf8")).references).toHaveLength(1)
  })

  test("rejects forged edits to automatically maintained raw references", () => {
    const directory = mkdtempSync(join(tmpdir(), "phase2-reference-immutable-")), data = join(directory, ".matrix", "data")
    mkdirSync(data, {recursive: true})
    const rawPath = join(data, "chapter1-scope.raw.json")
    writeFileSync(rawPath, JSON.stringify({references: [{document_id: "AUTO-1", document_title: "自动引用", source_kind: "conditional", evidence: "条件生成"}]}))
    writeFileSync(join(data, "primary-structure.json"), JSON.stringify({sections: []}))
    writeFileSync(join(data, "source-artifacts.json"), JSON.stringify({primary_document: {role: "primary", structure_path: join(data, "primary-structure.json")}}))
    const descriptor = describePhase2InlineEditor(directory), container = encodePhase2EditKey({artifact: "chapter1-scope.json", field: "references"})
    expect(() => applyPhase2InlineBatch({directory, expected_revision: descriptor.revision, changes: [], reference_operations: [
      {container_key: container, operation: "delete_reference", reference_key: "AUTO-1"},
    ]})).toThrow("不允许删除")
    expect(JSON.parse(readFileSync(rawPath, "utf8")).references[0].document_title).toBe("自动引用")
  })

  test("rejects replacing the complete references array through a scalar change", () => {
    const directory = mkdtempSync(join(tmpdir(), "phase2-reference-replace-")), data = join(directory, ".matrix", "data")
    mkdirSync(data, {recursive: true})
    writeFileSync(join(data, "chapter1-scope.raw.json"), JSON.stringify({references: []}))
    writeFileSync(join(data, "primary-structure.json"), JSON.stringify({sections: []}))
    writeFileSync(join(data, "source-artifacts.json"), JSON.stringify({primary_document: {role: "primary", structure_path: join(data, "primary-structure.json")}}))
    const descriptor = describePhase2InlineEditor(directory)
    expect(() => applyPhase2InlineBatch({directory, expected_revision: descriptor.revision, changes: [{
      edit_key: encodePhase2EditKey({artifact: "chapter1-scope.json", field: "references"}), value: []
    }]})).toThrow("reference_operations")
  })

  test("rejects fields outside the server whitelist", () => {
    const directory = mkdtempSync(join(tmpdir(), "phase2-inline-")), data = join(directory, ".matrix", "data")
    mkdirSync(data, {recursive: true})
    writeFileSync(join(data, "chapter1-scope.raw.json"), JSON.stringify({document_id: "OLD"}))
    writeFileSync(join(data, "primary-structure.json"), JSON.stringify({sections: []}))
    writeFileSync(join(data, "source-artifacts.json"), JSON.stringify({primary_document: {role: "primary", structure_path: join(data, "primary-structure.json")}}))
    const descriptor = describePhase2InlineEditor(directory)
    const forged = Buffer.from(JSON.stringify({artifact: "chapter1-scope.json", field: "__proto__.polluted"})).toString("base64url")
    expect(() => applyPhase2InlineBatch({directory, expected_revision: descriptor.revision, changes: [{edit_key: forged, value: "x"}]})).toThrow("白名单")
  })

  test("edits dynamic headers and applies row and column operations", () => {
    const directory = mkdtempSync(join(tmpdir(), "phase2-table-")), data = join(directory, ".matrix", "data")
    mkdirSync(data, {recursive: true})
    writeFileSync(join(data, "chapter2-system-overview.raw.json"), JSON.stringify({memory_io_tables: [{title: "原表题", columns: ["序号", "名称"], rows: [["1", "A"], ["2", "B"]]}], interrupts: []}))
    writeFileSync(join(data, "primary-structure.json"), JSON.stringify({sections: [{section_id: "SRS-1", source_ref: "primary::SRS-1", title: "范围"}]}))
    writeFileSync(join(data, "source-artifacts.json"), JSON.stringify({primary_document: {role: "primary", structure_path: join(data, "primary-structure.json")}}))
    const descriptor = describePhase2InlineEditor(directory), container = encodePhase2EditKey({artifact: "chapter2-system-overview.json", field: "memory_io_tables.0"})
    applyPhase2InlineBatch({directory, expected_revision: descriptor.revision,
      changes: [
        {edit_key: encodePhase2EditKey({artifact: "chapter2-system-overview.json", field: "memory_io_tables.0.title"}), value: "新表题"},
        {edit_key: encodePhase2EditKey({artifact: "chapter2-system-overview.json", field: "memory_io_tables.0.columns.1"}), value: "参数名"},
        {edit_key: encodePhase2EditKey({artifact: "chapter2-system-overview.json", field: "memory_io_tables.0.rows.1.0"}), value: "自定义序号"},
      ],
      table_operations: [
        {container_key: container, operation: "delete_row", row_key: encodePhase2EditKey({artifact: "chapter2-system-overview.json", field: "memory_io_tables.0.rows.0"})},
        {container_key: container, operation: "add_row"},
        {container_key: container, operation: "add_column", initial_value: "说明"},
      ]})
    const table = JSON.parse(readFileSync(join(data, "chapter2-system-overview.raw.json"), "utf8")).memory_io_tables[0]
    expect(table.title).toBe("新表题")
    expect(table.columns).toEqual(["序号", "参数名", "说明"])
    expect(table.rows).toEqual([["自定义序号", "B", ""], ["", "", ""]])
  })

  test("persists values entered under a newly added column", () => {
    const directory = mkdtempSync(join(tmpdir(), "phase2-added-column-values-")), data = join(directory, ".matrix", "data")
    mkdirSync(data, {recursive: true})
    writeFileSync(join(data, "chapter2-system-overview.raw.json"), JSON.stringify({memory_io_tables: [{title: "参数表", columns: ["名称"], rows: [["A"], ["B"]]}], interrupts: []}))
    writeFileSync(join(data, "primary-structure.json"), JSON.stringify({sections: []}))
    writeFileSync(join(data, "source-artifacts.json"), JSON.stringify({primary_document: {role: "primary", structure_path: join(data, "primary-structure.json")}}))
    const descriptor = describePhase2InlineEditor(directory)
    applyPhase2InlineBatch({directory, expected_revision: descriptor.revision, changes: [], table_operations: [{
      container_key: encodePhase2EditKey({artifact: "chapter2-system-overview.json", field: "memory_io_tables.0"}),
      operation: "add_column", initial_value: {title: "说明", values: ["第一行", "第二行"]},
    }]})
    const table = JSON.parse(readFileSync(join(data, "chapter2-system-overview.raw.json"), "utf8")).memory_io_tables[0]
    expect(table.columns).toEqual(["名称", "说明"])
    expect(table.rows).toEqual([["A", "第一行"], ["B", "第二行"]])
  })

  test("edits functional table titles, all cells, rows, and columns", () => {
    const directory = mkdtempSync(join(tmpdir(), "phase2-functional-table-")), data = join(directory, ".matrix", "data")
    mkdirSync(join(data, "functional-other-content-leaves"), {recursive: true})
    writeFileSync(join(data, "primary-structure.json"), JSON.stringify({sections: [{section_id: "SRS-1", source_ref: "primary::SRS-1", title: "范围"}]}))
    writeFileSync(join(data, "source-artifacts.json"), JSON.stringify({primary_document: {role: "primary", structure_path: join(data, "primary-structure.json")}}))
    writeFileSync(join(data, "functional-other-content-leaves", "leaf.json"), JSON.stringify({items: [{title_no: "4.1.1", tr_code: "TR-GN-X", processing: [], tables: [
      {table_id: "T-1", title: "原功能表", columns: ["序号", "名称"], rows: [["1", "A"]]}
    ]}]}))
    const descriptor = describePhase2InlineEditor(directory), extra = {container_id: "4.1.1", identity: {title_no: "4.1.1"}}
    applyPhase2InlineBatch({directory, expected_revision: descriptor.revision, changes: [
      {edit_key: encodePhase2EditKey({artifact: "functional-test-content.json", ...extra, field: "tables.0.title"}), value: "新功能表"},
      {edit_key: encodePhase2EditKey({artifact: "functional-test-content.json", ...extra, field: "tables.0.rows.0.0"}), value: "一"},
    ], table_operations: [
      {container_key: encodePhase2EditKey({artifact: "functional-test-content.json", ...extra, field: "tables.0"}), operation: "add_column", initial_value: "说明"},
      {container_key: encodePhase2EditKey({artifact: "functional-test-content.json", ...extra, field: "tables.0"}), operation: "add_row", initial_value: ["二", "B"]},
    ]})
    const table = JSON.parse(readFileSync(join(data, "functional-other-content-leaves", "leaf.json"), "utf8")).items[0].tables[0]
    expect(table.title).toBe("新功能表")
    expect(table.columns).toEqual(["序号", "名称", "说明"])
    expect(table.rows).toEqual([["一", "A", ""], ["二", "B", ""]])
  })

  test("edits functional object-row tables and persists structural changes", () => {
    const directory = mkdtempSync(join(tmpdir(), "phase2-functional-object-table-")), data = join(directory, ".matrix", "data")
    mkdirSync(join(data, "functional-other-content-leaves"), {recursive: true})
    writeFileSync(join(data, "primary-structure.json"), JSON.stringify({sections: []}))
    writeFileSync(join(data, "source-artifacts.json"), JSON.stringify({primary_document: {role: "primary", structure_path: join(data, "primary-structure.json")}}))
    const rawPath = join(data, "functional-other-content-leaves", "leaf.json")
    writeFileSync(rawPath, JSON.stringify({items: [{title_no: "4.1.7.3", tr_code: "TR-GN-X", processing: [], tables: [
      {table_id: "T-1", title: "判据表", columns: ["参数名称", "判据"], rows: [{"参数名称": "电压", "判据": "≤3.6V"}, {"参数名称": "电流", "判据": "≤1A"}]}
    ]}]}))
    const descriptor = describePhase2InlineEditor(directory), extra = {container_id: "4.1.7.3", identity: {title_no: "4.1.7.3"}},
      containerKey = encodePhase2EditKey({artifact: "functional-test-content.json", ...extra, field: "tables.0"})
    applyPhase2InlineBatch({directory, expected_revision: descriptor.revision, changes: [
      {edit_key: encodePhase2EditKey({artifact: "functional-test-content.json", ...extra, field: "tables.0.columns.1"}), value: "判断条件"},
      {edit_key: encodePhase2EditKey({artifact: "functional-test-content.json", ...extra, field: "tables.0.rows.0.0"}), value: "母线电压"},
    ], table_operations: [
      {container_key: containerKey, operation: "add_column", initial_value: {title: "持续时间", values: ["30s", "10s"]}},
      {container_key: containerKey, operation: "add_row", initial_value: ["温度", "≤60℃", "5s"]},
    ]})
    const table = JSON.parse(readFileSync(rawPath, "utf8")).items[0].tables[0]
    expect(table.columns).toEqual(["参数名称", "判断条件", "持续时间"])
    expect(table.rows).toEqual([
      {"参数名称": "母线电压", "判断条件": "≤3.6V", "持续时间": "30s"},
      {"参数名称": "电流", "判断条件": "≤1A", "持续时间": "10s"},
      {"参数名称": "温度", "判断条件": "≤60℃", "持续时间": "5s"},
    ])
  })

  test("selects canonical hardware tables and adds their source refs", () => {
    const directory = mkdtempSync(join(tmpdir(), "phase2-table-select-")), data = join(directory, ".matrix", "data"), blocks = join(data, "hardware-interface-blocks")
    mkdirSync(blocks, {recursive: true})
    writeFileSync(join(data, "primary-structure.json"), JSON.stringify({sections: [{section_id: "SRS-3.1", source_ref: "primary::SRS-3.1", title: "接口", tables: [
      {table_id: "primary::SRS-3.1::table-1", title: "接口表", table_html: "<table></table>"},
      {table_id: "primary::SRS-3.1::table-2", title: "输入表", table_html: "<table></table>"},
    ]}]}))
    writeFileSync(join(data, "source-artifacts.json"), JSON.stringify({primary_document: {role: "primary", path: "/data/projects/demo/source/cnas需求规格说明书.docx", structure_path: join(data, "primary-structure.json")}}))
    writeFileSync(join(blocks, "if.raw.json"), JSON.stringify({interface: {candidate_id: "C-1", interface_id: "IF-1", interface_kind: "can", title: "CAN", source_refs: ["primary::SRS-1"], overview_tables: [], topics: [], input_tables: ["primary::SRS-3.1::table-2"], output_tables: []}}))
    writeFileSync(join(blocks, "if-2.raw.json"), JSON.stringify({interface: {candidate_id: "C-2", interface_id: "IF-2", interface_kind: "can", title: "CAN2", source_refs: ["primary::SRS-3.1"], overview_tables: [{table_id: "primary::SRS-3.1::table-1"}], topics: [], input_tables: [], output_tables: []}}))
    const descriptor = describePhase2InlineEditor(directory)
    expect(descriptor.available_tables).toHaveLength(2)
    expect(descriptor.available_tables[0].document_name).toBe("cnas需求规格说明书.docx")
    expect(descriptor.available_tables[0].section_number).toBe("3.1")
    expect(descriptor.available_source_refs[0].document_name).toBe("cnas需求规格说明书")
    expect(descriptor.available_source_refs[0].number).toBe("3.1")
    applyPhase2InlineBatch({directory, expected_revision: descriptor.revision, changes: [{edit_key: encodePhase2EditKey({artifact: "hardware-interface-model.json", identity: {interface_id: "IF-1", candidate_id: "C-1"}, field: "overview_tables"}), value: ["primary::SRS-3.1::table-2", "primary::SRS-3.1::table-1"]}]})
    const item = JSON.parse(readFileSync(join(blocks, "if.raw.json"), "utf8")).interface
    expect(item.overview_tables).toEqual([
      {table_id: "primary::SRS-3.1::table-2"},
      {table_id: "primary::SRS-3.1::table-1"},
    ])
    expect(item.source_refs).toContain("primary::SRS-3.1")

    const next = describePhase2InlineEditor(directory)
    expect(() => applyPhase2InlineBatch({directory, expected_revision: next.revision, changes: [{edit_key: encodePhase2EditKey({artifact: "hardware-interface-model.json", identity: {interface_id: "IF-1", candidate_id: "C-1"}, field: "overview_tables"}), value: ["primary::SRS-3.1::table-2"]}]})).not.toThrow()
    const duplicated = JSON.parse(readFileSync(join(blocks, "if.raw.json"), "utf8")).interface
    expect(duplicated.overview_tables[0].table_id).toBe("primary::SRS-3.1::table-2")
    expect(duplicated.input_tables[0]).toBe("primary::SRS-3.1::table-2")
  })

  test("allows shared hardware tables across processing groups", () => {
    expect(() => validateGenericInterfaceTableUniqueness({
      overview_tables: [{table_id: "primary::SRS-3.1::table-1"}],
      input_tables: [{table_id: "primary::SRS-3.1::table-1"}],
      output_tables: [], topics: [],
    } as any, "interface 1")).not.toThrow()
  })

  test("defers source reference and unknown table business validation to finalize", () => {
    const directory = mkdtempSync(join(tmpdir(), "phase2-deferred-validation-")), data = join(directory, ".matrix", "data"), blocks = join(data, "hardware-interface-blocks")
    mkdirSync(blocks, {recursive: true})
    writeFileSync(join(data, "primary-structure.json"), JSON.stringify({sections: [{section_id: "SRS-1", source_ref: "primary::SRS-1", title: "范围", tables: []}]}))
    writeFileSync(join(data, "source-artifacts.json"), JSON.stringify({primary_document: {role: "primary", structure_path: join(data, "primary-structure.json")}}))
    writeFileSync(join(blocks, "if.raw.json"), JSON.stringify({interface: {candidate_id: "C-1", interface_id: "IF-1", source_refs: ["primary::SRS-1"], overview_tables: [], input_tables: [], output_tables: [], topics: []}}))
    const descriptor = describePhase2InlineEditor(directory)
    expect(() => applyPhase2InlineBatch({directory, expected_revision: descriptor.revision, changes: [
      {edit_key: encodePhase2EditKey({artifact: "hardware-interface-model.json", identity: {interface_id: "IF-1", candidate_id: "C-1"}, field: "source_refs"}), value: ["supporting-only::SRS-9"]},
      {edit_key: encodePhase2EditKey({artifact: "hardware-interface-model.json", identity: {interface_id: "IF-1", candidate_id: "C-1"}, field: "overview_tables"}), value: ["unknown::table-1", "unknown::table-1"]},
    ]})).not.toThrow()
    const raw = JSON.parse(readFileSync(join(blocks, "if.raw.json"), "utf8")).interface
    expect(raw.source_refs).toEqual([])
    expect(raw.overview_tables).toEqual([{table_id: "unknown::table-1"}, {table_id: "unknown::table-1"}])
  })

  test("updates scalar hardware flows without assigning a string character", () => {
    const directory = mkdtempSync(join(tmpdir(), "phase2-hardware-flow-")), data = join(directory, ".matrix", "data"), blocks = join(data, "hardware-interface-blocks")
    mkdirSync(blocks, {recursive: true})
    writeFileSync(join(data, "primary-structure.json"), JSON.stringify({sections: []}))
    writeFileSync(join(data, "source-artifacts.json"), JSON.stringify({primary_document: {role: "primary", structure_path: join(data, "primary-structure.json")}}))
    writeFileSync(join(blocks, "if.raw.json"), JSON.stringify({interface: {candidate_id: "C-1", interface_id: "IF-1", input_flow: "原输入流", output_flow: "原输出流"}}))
    const descriptor = describePhase2InlineEditor(directory)
    applyPhase2InlineBatch({directory, expected_revision: descriptor.revision, changes: [{
      edit_key: encodePhase2EditKey({artifact: "hardware-interface-model.json", identity: {interface_id: "IF-1", candidate_id: "C-1"}, field: "input_flow"}), value: "修改后的输入流"
    }]})
    const raw = JSON.parse(readFileSync(join(blocks, "if.raw.json"), "utf8")).interface
    expect(raw.input_flow).toBe("修改后的输入流")
    expect(raw.output_flow).toBe("原输出流")
  })

  test("renames, adds, and deletes functional requirements in one batch", () => {
    const directory = mkdtempSync(join(tmpdir(), "phase2-functional-tr-")), data = join(directory, ".matrix", "data")
    mkdirSync(join(data, "functional-other-content-leaves"), {recursive: true})
    writeFileSync(join(data, "primary-structure.json"), JSON.stringify({sections: [{section_id: "SRS-1", source_ref: "primary::SRS-1", title: "范围"}]}))
    writeFileSync(join(data, "source-artifacts.json"), JSON.stringify({primary_document: {role: "primary", structure_path: join(data, "primary-structure.json")}}))
    const rawPath = join(data, "functional-other-content-leaves", "leaf.json")
    writeFileSync(rawPath, JSON.stringify({items: [{title_no: "4.1.2", tr_code: "TR-GN-X", processing: [
      {requirement_id: "TR-GN-X-001", content: "保留并改号", source_refs: ["primary::SRS-1"], table_refs: []},
      {requirement_id: "TR-GN-X-002", content: "删除", source_refs: ["primary::SRS-1"], table_refs: []},
    ]}]}))
    const descriptor = describePhase2InlineEditor(directory), container = {artifact: "functional-test-content.json", container_id: "4.1.2", identity: {title_no: "4.1.2"}}
    const result = applyPhase2InlineBatch({directory, expected_revision: descriptor.revision,
      changes: [{edit_key: encodePhase2EditKey({...container, business_id: "TR-GN-X-001", field: "requirement_id_suffix"}), value: "12"}],
      requirement_operations: [
        {container_key: encodePhase2EditKey({...container, field: "processing"}), operation: "delete_requirement",
          requirement_key: encodePhase2EditKey({...container, business_id: "TR-GN-X-002", field: "content"})},
        {container_key: encodePhase2EditKey({...container, field: "processing"}), operation: "add_requirement", requested_suffix: "20",
          initial_value: {content: "新增", source_refs: ["primary::SRS-1"]}},
      ]})
    const rows = JSON.parse(readFileSync(rawPath, "utf8")).items[0].processing
    expect(rows.map((row: any) => row.requirement_id)).toEqual(["TR-GN-X-012", "TR-GN-X-020"])
    expect(result.requirement_id_renames).toEqual([{from: "TR-GN-X-001", to: "TR-GN-X-012"}])
    const state = JSON.parse(readFileSync(join(data, "phase2-editor-state.json"), "utf8"))
    expect(state.tombstoned_requirement_ids).toEqual(expect.arrayContaining(["TR-GN-X-001", "TR-GN-X-002"]))
  })

  test("adds and deletes non-functional requirements while keeping IDs program-managed", () => {
    const directory = mkdtempSync(join(tmpdir(), "phase2-nonfunctional-tr-")), data = join(directory, ".matrix", "data")
    mkdirSync(data, {recursive: true})
    writeFileSync(join(data, "primary-structure.json"), JSON.stringify({sections: [{section_id: "SRS-1", source_ref: "primary::SRS-1", title: "范围"}]}))
    writeFileSync(join(data, "source-artifacts.json"), JSON.stringify({primary_document: {role: "primary", structure_path: join(data, "primary-structure.json")}}))
    const rawPath = join(data, "performance.raw.json")
    writeFileSync(rawPath, JSON.stringify({rows: [{requirement_id: "TR-XN-001", performance_requirement_description: "旧项", related_description: "", source_refs: ["primary::SRS-1"]}]}))
    writeFileSync(join(data, "performance-test-content.json"), JSON.stringify({section_title_no: "4.2.1", rows: []}))
    const descriptor = describePhase2InlineEditor(directory), container = encodePhase2EditKey({artifact: "performance-test-content.json", field: "rows"})
    expect(() => applyPhase2InlineBatch({directory, expected_revision: descriptor.revision, changes: [], requirement_operations: [
      {container_key: container, operation: "add_requirement", initial_value: {description: "非法项", related_description: "asdasd", source_refs: ["primary::SRS-1"]}},
    ]})).toThrow("performance-test-content.json相关说明无效")
    expect(JSON.parse(readFileSync(rawPath, "utf8")).rows).toHaveLength(1)
    applyPhase2InlineBatch({directory, expected_revision: descriptor.revision, changes: [], requirement_operations: [
      {container_key: container, operation: "delete_requirement", requirement_key: encodePhase2EditKey({artifact: "performance-test-content.json", business_id: "TR-XN-001", field: "performance_requirement_description"})},
      {container_key: container, operation: "add_requirement", initial_value: {description: "新项", related_description: "时间间隔", source_refs: ["primary::SRS-1"]}},
    ]})
    const rows = JSON.parse(readFileSync(rawPath, "utf8")).rows
    expect(rows).toHaveLength(1)
    expect(rows[0].requirement_id).not.toBe("TR-XN-001")
    expect(rows[0].performance_requirement_description).toBe("新项")
    expect(rows[0].related_description).toBe("时间间隔")
  })
})
