import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { trackRaw, publishEditMapping, restoreEditOrigins } from "../../src/shared/phase2-edit-mapping"
import { normalizeLocalTables, withPhase2Diagnostics } from "../../src/shared/phase2-tolerance"
import { renderFunctionalOtherContentDocx } from "../../src/tools/functional-other-content-docx"
import { readZip } from "../../src/tools/docx-zip"
import { filldataPhase2Workflow } from "../../src/tools/filldata-phase2-workflow"
import { applyPhase2Editor, applyPhase2InlineBatch, describePhase2Editor, describePhase2InlineEditor, encodePhase2EditKey, phase2EditorMutationFiles } from "../../src/tools/phase2-editor"
import { writePhase2SourceBundleFixture } from "./phase2-source-fixture"

const directories: string[] = []
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, {recursive: true, force: true}) })
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "phase2-editor-tolerance-")); directories.push(directory)
  writePhase2SourceBundleFixture(directory)
  const path = (name: string) => join(directory, ".matrix/data", name)
  const write = (name: string, value: any) => { mkdirSync(dirname(path(name)), {recursive: true}); writeFileSync(path(name), JSON.stringify(value)); return path(name) }
  const read = (name: string) => JSON.parse(readFileSync(path(name), "utf8"))
  const run = async (mode: string) => JSON.parse(await (filldataPhase2Workflow as any).execute({mode}, {directory, worktree: directory}))
  return {directory, path, write, read, run}
}

test("finalize maps repaired IDs through deduplication; a batch edits only its two selected raw rows", async () => {
  const f = fixture()
  const row = (body: string) => ({requirement_id: "wrong", performance_requirement_description: body, related_description: "响应时间", source_refs: ["unknown"]})
  const original = {rows: [row("重复"), row("重复"), row("目标")], open_questions: []}
  f.write("performance.raw.json", original)
  expect((await f.run("finalize_performance_test_content")).ok).toBe(true)
  expect(f.read("performance.raw.json")).toEqual(original)
  const model = f.read("performance-test-content.json")
  const request = {directory: f.directory, artifact: "performance-test-content.json", business_id: model.rows[1].requirement_id}
  const description = describePhase2Editor(request)
  expect(description.editable).toBe(true)
  expect(description.value.source_refs).toEqual([])
  const inline = describePhase2InlineEditor(f.directory)
  const batch = {directory: f.directory, expected_revision: inline.revision, changes: model.rows.map((row: any, index: number) => ({
    edit_key: encodePhase2EditKey({...request, business_id: row.requirement_id, field: "performance_requirement_description"}), value: `修改${index}`,
  }))}
  expect(phase2EditorMutationFiles(batch)).toContain(f.path("performance.raw.json"))
  applyPhase2InlineBatch(batch)
  const rows = f.read("performance.raw.json").rows
  expect(rows.map((row: any) => row.performance_requirement_description)).toEqual(["修改0", "重复", "修改1"])
  expect(rows.every((row: any) => row.requirement_id === "wrong")).toBe(true)
  expect(() => describePhase2Editor(request)).toThrow("过期")
  expect((await f.run("finalize_performance_test_content")).ok).toBe(true)
})

test("mapped functional tables preserve raw positions after filtering and ordering, and placeholders are read-only", () => {
  const f = fixture()
  const rawFile = f.write("functional-other-content-leaves/one.raw.json", {items: [{title_no: "wrong", tr_code: "wrong", summary: "正文", processing: [], tables: [
    {table_id: "bad", title: "坏表", columns: ["值"], rows: [{错: "坏"}]},
    {table_id: "good", title: "好表", columns: ["值"], rows: [{值: "原始"}]},
  ]}]})
  const raw = trackRaw(f.read("functional-other-content-leaves/one.raw.json"), rawFile)
  const item = normalizeLocalTables({...raw.items[0], title_no: "4.1.2", tr_code: "TR-GN-X"})
  const intermediate = {items: [item]}
  const intermediateFile = f.write("functional-other-content.json", intermediate)
  publishEditMapping(intermediateFile, intermediate)
  const restored = restoreEditOrigins(intermediateFile, f.read("functional-other-content.json"))
  const model = {children: [{other_content: restored.items[0]}, {other_content: {title_no: "4.1.3", summary: "内容未生成", processing: []}}]}
  const finalFile = f.write("functional-test-content.json", model)
  publishEditMapping(finalFile, model)
  const key = {artifact: "functional-test-content.json", container_id: "4.1.2", field: "tables.0.rows.0.0"}
  applyPhase2InlineBatch({directory: f.directory, expected_revision: describePhase2InlineEditor(f.directory).revision,
    changes: [{edit_key: encodePhase2EditKey(key), value: "修改"}]})
  const tables = f.read("functional-other-content-leaves/one.raw.json").items[0].tables
  expect(tables[0].rows).toEqual([{错: "坏"}])
  expect(tables[1].rows).toEqual([{值: "修改"}])
  const placeholder = describePhase2Editor({directory: f.directory, artifact: key.artifact, container_id: "4.1.3"})
  expect(placeholder.editable).toBe(false)
})

test("auxiliary catalog failures permit unrelated editing and explicit empty refs, but reject nonempty ref edits", () => {
  const f = fixture()
  f.write("source-artifacts.json", {primary_document: {role: "primary", structure_path: f.path("missing.json")}})
  f.write("performance.raw.json", {rows: [{requirement_id: "TR-XN-001", performance_requirement_description: "正文", related_description: "响应时间", source_refs: ["primary::SRS-1"]}]})
  f.write("performance-test-content.json", f.read("performance.raw.json"))
  const request = {directory: f.directory, artifact: "performance-test-content.json", business_id: "TR-XN-001"}
  const description = describePhase2Editor(request)
  expect(description.warnings!.length).toBeGreaterThan(0)
  expect(description.value.source_refs).toEqual([])
  expect(describePhase2InlineEditor(f.directory).warnings.length).toBeGreaterThan(0)
  applyPhase2Editor({...request, operation: "update", expected_revision: description.revision, value: {performance_requirement_description: "修改"}})
  expect(f.read("performance.raw.json").rows[0].source_refs).toEqual(["primary::SRS-1"])
  const revision = describePhase2Editor(request).revision
  expect(() => applyPhase2Editor({...request, operation: "update", expected_revision: revision, value: {source_refs: ["primary::SRS-1"]}})).toThrow("目录不可用")
  applyPhase2Editor({...request, operation: "update", expected_revision: revision, value: {source_refs: []}})
  expect(f.read("performance.raw.json").rows[0].source_refs).toEqual([])
  f.write("missing.json", {sections: [{section_id: "SRS-1", source_ref: "primary::SRS-1", tables: []}]})
  expect(describePhase2InlineEditor(f.directory).warnings).toEqual([])
})

test("legacy duplicate IDs are not resolved by first match; mapping paths cannot escape data directory", () => {
  const f = fixture()
  const row = {requirement_id: "TR-XN-001", performance_requirement_description: "相同", source_refs: []}
  f.write("performance.raw.json", {rows: [row, row]}); f.write("performance-test-content.json", {rows: [row]})
  expect(() => describePhase2Editor({directory: f.directory, artifact: "performance-test-content.json", business_id: row.requirement_id})).toThrow("不唯一")
  expect(() => describePhase2Editor({directory: f.directory, artifact: "../../outside.json"})).toThrow("目录")
})

test("one failed table is attempted once without leaving generated references", async () => {
  let attempts = 0
  const row = {get 值(): string { attempts++; throw new Error("table-render-failure") }}
  const model: any = {items: [{title_no: "4.1.2", title: "测试", processing: [
    {requirement_id: "TR-GN-X-001", content: "有效正文", table_refs: ["bad"]},
    {requirement_id: "TR-GN-X-002", content: "第二正文", table_refs: ["bad"]},
  ], tables: [{table_id: "bad", title: "失败表", columns: ["值"], rows: [row]}]}]}
  let xml = ""
  const result = JSON.parse(await withPhase2Diagnostics("render", async () => {
    xml = readZip(renderFunctionalOtherContentDocx(model)).get("word/document.xml")!.toString()
    return JSON.stringify({ok: true})
  }))
  expect(result.skipped_count).toBe(1)
  expect(attempts).toBe(1)
  expect(xml).toContain("有效正文")
  expect(xml).not.toContain("详细格式见")
  expect(xml).not.toContain("失败表")
  expect(model.items[0].tables[0].table_no).toBeUndefined()
})

test("a failed report write never publishes a new mapping or alters raw", async () => {
  const f = fixture()
  const value = {rows: [{performance_requirement_description: "正文", related_description: "响应时间", source_refs: []}]}
  f.write("performance.raw.json", value)
  f.write("phase2-editor-state.json", {version: 1, next_sequences: {"TR-XN": 8}, tombstoned_requirement_ids: ["TR-XN-001"]})
  mkdirSync(join(f.directory, ".matrix/reports/performance-test-content.docx"), {recursive: true})
  expect((await f.run("finalize_performance_test_content")).ok).toBe(false)
  expect(f.read("performance.raw.json")).toEqual(value)
  expect(f.read("phase2-editor-state.json")).toEqual({version: 1, next_sequences: {"TR-XN": 8}, tombstoned_requirement_ids: ["TR-XN-001"]})
})
