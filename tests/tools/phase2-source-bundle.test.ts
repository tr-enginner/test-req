import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { loadPhase2SourceBundle, normalizeAndValidateSourceRefs } from "../../src/tools/phase2-source-bundle"

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

describe("phase2 source bundle", () => {
  test("indexes text and HTML tables and validates primary provenance", () => {
    const dir = mkdtempSync(join(tmpdir(), "phase2-source-")); dirs.push(dir)
    const data = join(dir, "data"); mkdirSync(data)
    const structure = join(data, "structure.json")
    writeFileSync(structure, JSON.stringify({ sections: [{ section_id: "SRS-1", source_ref: "primary::SRS-1", title: "需求", level: 1, section_path_titles: ["需求"], text: "正文\n[表格：primary::SRS-1::table-1]", tables: [{ table_id: "primary::SRS-1::table-1", title: "表1", table_html: "<table><tr><td>A</td></tr></table>" }] }] }))
    const manifest = join(data, "source-artifacts.json")
    const supporting = join(data, "supporting-structure.json")
    writeFileSync(supporting, JSON.stringify({ sections: [{ section_id: "SRS-8.4", source_ref: "supporting-002-protocol::SRS-8.4", title: "协议", level: 2, section_path_titles: ["协议"], text: "补充证据", tables: [] }] }))
    writeFileSync(manifest, JSON.stringify({ primary_document: { path: "srs.docx", structure_path: structure }, supporting_documents: [{ path: "protocol.docx", structure_path: supporting }] }))
    const bundle = loadPhase2SourceBundle(manifest)
    expect(bundle.searchable_text).toContain("<table>")
    expect(normalizeAndValidateSourceRefs(["primary::SRS-1", "primary::SRS-1"], bundle, "row")).toEqual(["primary::SRS-1"])
    expect(normalizeAndValidateSourceRefs(["primary::SRS-1", "supporting-002-protocol::SRS-8.4", "primary::SRS-1"], bundle, "row")).toEqual(["primary::SRS-1", "supporting-002-protocol::SRS-8.4"])
    expect(normalizeAndValidateSourceRefs(["supporting::SRS-1"], bundle, "row")).toEqual([])
    expect(normalizeAndValidateSourceRefs(["supporting-002-protocol::SRS-8.4"], bundle, "row")).toEqual(["supporting-002-protocol::SRS-8.4"])
    expect(normalizeAndValidateSourceRefs(["SRS-1"], bundle, "row")).toEqual([])
    expect(normalizeAndValidateSourceRefs(["primary::SRS-1::table-1"], bundle, "row")).toEqual([])
    expect(normalizeAndValidateSourceRefs(["primary::SRS-404"], bundle, "row")).toEqual([])
  })

  test("rejects legacy rows-only tables", () => {
    const dir = mkdtempSync(join(tmpdir(), "phase2-legacy-")); dirs.push(dir)
    const structure = join(dir, "structure.json")
    writeFileSync(structure, JSON.stringify({ sections: [{ source_ref: "primary::SRS-1", tables: [{ table_id: "t", rows: [["A"]] }] }] }))
    const manifest = join(dir, "source-artifacts.json")
    writeFileSync(manifest, JSON.stringify({ primary_document: { path: "srs.docx", structure_path: structure }, supporting_documents: [] }))
    expect(() => loadPhase2SourceBundle(manifest)).toThrow("Re-run requirements document parsing")
  })
})
