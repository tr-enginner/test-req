import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { PerformanceTestRaw } from "../../src/schema/performance-test-content"
import { ReliabilitySafetyTestRaw } from "../../src/schema/reliability-safety-test-content"
import { MarginTestRaw } from "../../src/schema/margin-test-content"
import { BoundaryTestRaw } from "../../src/schema/boundary-test-content"
import { DataProcessingTestRaw } from "../../src/schema/data-processing-test-content"
import { RecoveryTestRaw } from "../../src/schema/recovery-test-content"
import { StrengthTestRaw } from "../../src/schema/strength-test-content"
import { InterfaceTestBatchRaw } from "../../src/schema/interface-test-content"
import { readZip } from "../../src/tools/docx-zip"
import { finalizePerformanceTestContent } from "../../src/tools/performance-test-workflow"
import { finalizeReliabilitySafetyTestContent } from "../../src/tools/reliability-safety-test-workflow"
import { finalizeMarginTestContent } from "../../src/tools/margin-test-workflow"
import { finalizeBoundaryTestContent } from "../../src/tools/boundary-test-workflow"
import { finalizeDataProcessingTestContent } from "../../src/tools/data-processing-test-workflow"
import { finalizeRecoveryTestContent } from "../../src/tools/recovery-test-workflow"
import { finalizeStrengthTestContent } from "../../src/tools/strength-test-workflow"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "phase2-raw-final-contract-"))
  dirs.push(dir)
  const data = join(dir, ".matrix", "data")
  mkdirSync(data, { recursive: true })
  const structure = join(data, "req-document-structure.json")
  writeFileSync(structure, JSON.stringify({ sections: [{ source_ref: "primary::SRS-3.2.1", section_id: "SRS-3.2.1", title: "需求", level: 2, section_path_titles: ["需求"], text: "需求正文", tables: [] }] }))
  writeFileSync(join(data, "source-artifacts.json"), JSON.stringify({ primary_document: { path: join(dir, "requirements.docx"), structure_path: structure }, supporting_documents: [] }))
  return { dir, data, ctx: { directory: dir, worktree: dir } as any }
}

describe("Phase 2 raw/final row contracts", () => {
  test("raw performance rows allow optional source refs and editor IDs", () => {
    const row = { performance_requirement_description: "软件应在2ms内响应。", source_refs: ["primary::SRS-3.2.1"], related_description: "响应时间" }
    expect(PerformanceTestRaw.safeParse({ rows: [row], open_questions: [] }).success).toBe(true)
    expect(PerformanceTestRaw.safeParse({ rows: [{ ...row, requirement_id: "TR-XN-001" }], open_questions: [] }).success).toBe(true)
    expect(PerformanceTestRaw.safeParse({ rows: [{ performance_requirement_description: row.performance_requirement_description, related_description: row.related_description }], open_questions: [] }).success).toBe(true)
  })

  test("interface raw rows use the complete six-field contract", () => {
    const row = { interface_requirement_description: "软件应接收接口数据。", test_requirement_id: "AUTO_TR_JK", source_refs: ["primary::SRS-3.2.1"], related_description: "接口正常情况的测试", interface_name: "CAN", interface_id: "IF-CAN-001" }
    expect(InterfaceTestBatchRaw.safeParse({ batch_id: "B-1", interface_name: "CAN", interface_id: "IF-CAN-001", rows: [row], open_questions: [] }).success).toBe(true)
    const { source_refs: _removed, ...withoutRefs } = row
    expect(InterfaceTestBatchRaw.safeParse({ batch_id: "B-1", interface_name: "CAN", interface_id: "IF-CAN-001", rows: [withoutRefs], open_questions: [] }).success).toBe(true)
  })

  test("all non-functional finalizers accept and render non-controlled related descriptions", async () => {
    const { data, ctx } = fixture()
    const cases = [
      ["performance.raw.json", "performance-test-content.json", "performance_requirement_description", "模型生成的性能相关说明", "TR-XN", finalizePerformanceTestContent, PerformanceTestRaw],
      ["reliability-safety.raw.json", "reliability-safety-test-content.json", "reliability_safety_requirement_description", "模型生成的可靠性相关说明", "TR-AQ", finalizeReliabilitySafetyTestContent, ReliabilitySafetyTestRaw],
      ["margin.raw.json", "margin-test-content.json", "margin_requirement_description", "模型生成的余量相关说明", "TR-YL", finalizeMarginTestContent, MarginTestRaw],
      ["boundary.raw.json", "boundary-test-content.json", "boundary_requirement_description", "模型生成的边界相关说明", "TR-BJ", finalizeBoundaryTestContent, BoundaryTestRaw],
      ["data-processing.raw.json", "data-processing-test-content.json", "data_processing_requirement_description", "模型生成的数据处理相关说明", "TR-SC", finalizeDataProcessingTestContent, DataProcessingTestRaw],
      ["recovery.raw.json", "recovery-test-content.json", "recovery_requirement_description", "模型生成的恢复性相关说明", "TR-HF", finalizeRecoveryTestContent, RecoveryTestRaw],
      ["strength.raw.json", "strength-test-content.json", "strength_requirement_description", "模型生成的强度相关说明", "TR-QD", finalizeStrengthTestContent, StrengthTestRaw],
    ] as const
    for (const [rawName, finalName, descriptionKey, related, prefix, finalize, rawSchema] of cases) {
      const row = { [descriptionKey]: "需求A", source_refs: ["primary::SRS-3.2.1"], related_description: related }
      const raw = { rows: [row, row, { ...row, [descriptionKey]: "需求B" }], open_questions: [] }
      expect(rawSchema.safeParse(raw).success, `${rawName} should accept a non-controlled related description`).toBe(true)
      expect(rawSchema.safeParse({ rows: [{ ...row, related_description: "" }], open_questions: [] }).success).toBe(false)
      expect(rawSchema.safeParse({ rows: [{ ...row, related_description: 1 }], open_questions: [] }).success).toBe(false)
      writeFileSync(join(data, rawName), JSON.stringify(raw))
      const result = JSON.parse(await finalize(ctx))
      expect(result.ok, `${rawName} should finalize`).toBe(true)
      const model = JSON.parse(readFileSync(join(data, finalName), "utf-8"))
      expect(model.rows.map((item: any) => item.requirement_id)).toEqual([`${prefix}-001`, `${prefix}-002`])
      expect(model.rows.every((item: any) => item.related_description === related)).toBe(true)
      const reportPath = Object.values(result.output as Record<string, unknown>).find(value => typeof value === "string" && value.endsWith(".docx")) as string
      const xml = readZip(readFileSync(reportPath)).get("word/document.xml")?.toString("utf-8") || ""
      expect(xml).toContain(related)
    }
  })
})
