import { readPhase2Json } from "../shared/phase2-json"
import type { ToolContext } from "@opencode-ai/plugin"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, join, resolve } from "path"
import { FunctionalTestTraceability, FunctionalTestTraceabilityGaps, type FunctionalTestTraceabilityRow } from "../schema/functional-test-traceability"
import { renderFunctionalTestTraceabilityDocx } from "./functional-test-traceability-docx"
import { loadPhase2SourceBundle } from "./phase2-source-bundle"

const pathOf = (ctx: ToolContext, path: string) => join(resolve(ctx.directory || ctx.worktree || process.cwd()), path)
const json = (path: string): any => readPhase2Json(path)
export function parseSrsSectionNumber(ref: string): string | null {
  const raw = ref.match(/(?:^|::)SRS-(\d+(?:\.\d+)*)$/i)?.[1]
  if (!raw) return null
  return raw.split(".").map((part) => String(Number(part))).join(".")
}

const CHAPTERS = [
  ["4.2", "performance-test-content.json"], ["4.3", "interface-test-content.json"], ["4.4", "reliability-safety-test-content.json"],
  ["4.5", "margin-test-content.json"], ["4.6", "boundary-test-content.json"], ["4.7", "data-processing-test-content.json"],
  ["4.8", "recovery-test-content.json"], ["4.9", "strength-test-content.json"],
] as const

function collectFunctional(value: any, out: Array<{ id: string; refs: string[] }>): void {
  if (!value || typeof value !== "object") return
  if (typeof value.requirement_id === "string") out.push({ id: value.requirement_id, refs: value.source_refs || [] })
  for (const child of Object.values(value)) if (Array.isArray(child)) child.forEach((entry) => collectFunctional(entry, out)); else if (child && typeof child === "object") collectFunctional(child, out)
}

export async function generateFunctionalTestTraceability(ctx: ToolContext): Promise<string> {
  const sourceArtifactsPath = pathOf(ctx, ".matrix/data/source-artifacts.json")
  const bundle = loadPhase2SourceBundle(sourceArtifactsPath)
  const mappings: Array<{ chapter: string; id: string; refs: string[] }> = []
  const functionalPath = pathOf(ctx, ".matrix/data/functional-test-content.json")
  if (!existsSync(functionalPath)) return JSON.stringify({ error: `File not found: ${functionalPath}` })
  const functional: Array<{ id: string; refs: string[] }> = []; collectFunctional(json(functionalPath), functional)
  functional.forEach((entry) => mappings.push({ chapter: "4.1", ...entry }))
  for (const [chapter, file] of CHAPTERS) {
    const path = pathOf(ctx, `.matrix/data/${file}`)
    if (!existsSync(path)) return JSON.stringify({ error: `File not found: ${path}` })
    for (const row of json(path).rows || []) mappings.push({ chapter, id: row.requirement_id || row.test_requirement_id, refs: row.source_refs || [] })
  }
  const rows: FunctionalTestTraceabilityRow[] = bundle.sections
    .filter((section) => section.document_role === "primary" && section.text.trim().length > 0)
    .flatMap((section) => {
      const sectionNumber = parseSrsSectionNumber(section.source_ref)
      return sectionNumber ? [{
        source_ref: section.source_ref,
        document_name: "需求规格说明" as const,
        section_number: sectionNumber,
        section_title: section.title,
        test_requirement_ids: [] as string[],
      }] : []
    })
  const rowBySourceRef = new Map(rows.map((row) => [row.source_ref, row]))
  const gaps: Array<{ requirement_id?: string; source_ref?: string; title?: string; message: string }> = []
  for (const mapping of mappings) {
    let mappedToNumericPrimary = false
    for (const ref of mapping.refs) {
      const section = bundle.section_by_ref.get(ref)
      if (!section || section.document_role !== "primary") continue
      const row = rowBySourceRef.get(ref)
      if (!row) continue
      mappedToNumericPrimary = true
      if (mapping.id && !row.test_requirement_ids.includes(mapping.id)) row.test_requirement_ids.push(mapping.id)
    }
    if (!mappedToNumericPrimary) {
      const excludedPrimaryRef = mapping.refs.find((ref) => ref.startsWith("primary::"))
      const excludedSection = excludedPrimaryRef ? bundle.section_by_ref.get(excludedPrimaryRef) : undefined
      const emptyNumericSection = mapping.refs
        .map((ref) => bundle.section_by_ref.get(ref))
        .find((section) => section?.document_role === "primary"
          && parseSrsSectionNumber(section.source_ref) !== null
          && section.text.trim().length === 0)
      gaps.push({
        requirement_id: mapping.id,
        ...(emptyNumericSection
          ? { source_ref: emptyNumericSection.source_ref, ...(emptyNumericSection.title ? { title: emptyNumericSection.title } : {}) }
          : {
              ...(excludedPrimaryRef ? { source_ref: excludedPrimaryRef } : {}),
              ...(excludedSection?.title ? { title: excludedSection.title } : {}),
            }),
        message: emptyNumericSection
          ? "测试需求只引用了正文为空的primary数字标题章节；空正文标题章节不进入追溯表。"
          : "测试需求未引用primary需求规格说明中的有效数字正文章节；附录、前置内容和无编号章节不进入追溯表。",
      })
    }
  }
  const chapterSourceRefs = (["1", "2"] as const).map((chapter) => { const path = pathOf(ctx, `.matrix/data/chapter${chapter}-${chapter === "1" ? "scope" : "system-overview"}.json`); return { chapter, source_refs: existsSync(path) ? json(path).source_refs || [] : [] } })
  const artifact = FunctionalTestTraceability.parse({ version: "3.0", source_artifacts_path: sourceArtifactsPath, rows, chapter_source_refs: chapterSourceRefs, summary: { row_count: rows.length, requirement_count: new Set(mappings.map((m) => m.id).filter(Boolean)).size } })
  const gapsArtifact = FunctionalTestTraceabilityGaps.parse({ version: "3.0", gaps, summary: { total: gaps.length } })
  const outputPath = pathOf(ctx, ".matrix/data/phase2-test-traceability.json"), gapsPath = pathOf(ctx, ".matrix/data/phase2-test-traceability-gaps.json"), reportPath = pathOf(ctx, ".matrix/reports/phase2-test-traceability.docx")
  mkdirSync(dirname(outputPath), { recursive: true }); mkdirSync(dirname(reportPath), { recursive: true })
  writeFileSync(outputPath, JSON.stringify(artifact, null, 2)); writeFileSync(gapsPath, JSON.stringify(gapsArtifact, null, 2)); writeFileSync(reportPath, renderFunctionalTestTraceabilityDocx(artifact))
  return JSON.stringify({ ok: true, mode: "generate_phase2_traceability", output: { phase2_traceability_path: outputPath, phase2_traceability_gaps_path: gapsPath, phase2_traceability_report_path: reportPath }, summary: artifact.summary }, null, 2)
}
