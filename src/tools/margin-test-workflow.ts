import { trackRaw, carryOrigins, publishEditMapping } from "../shared/phase2-edit-mapping"
import { phase2Warnings } from "../shared/phase2-tolerance"
import { readPhase2Json } from "../shared/phase2-json"
import type { ToolContext } from "@opencode-ai/plugin"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, join, resolve } from "path"
import { MarginTestContent, MarginTestGaps, MarginTestRaw, type MarginTestTableRow } from "../schema/margin-test-content"
import { PHASE2_REQUIREMENT_SOURCE_REFS_GUIDANCE } from "../shared/phase2-source-ref-guidance"
import { renderMarginTestContentDocx } from "./margin-test-content-docx"
import { loadPhase2SourceBundle, normalizeAndValidateSourceRefs } from "./phase2-source-bundle"
import { assignStableRequirementIds } from "../shared/phase2-stable-ids"

const baseDir = (ctx: ToolContext) => resolve(ctx.directory || ctx.worktree || process.cwd())
const pathOf = (ctx: ToolContext, relativePath: string) => join(baseDir(ctx), relativePath)
function validReusableRaw(raw: string, source: string): boolean {
  if (!existsSync(raw)) return false
  try {
    MarginTestRaw.parse(readPhase2Json(raw))
    return true
  } catch { return false }
}
function workerPrompt(source: string, output: string): string {
  return [
    PHASE2_REQUIREMENT_SOURCE_REFS_GUIDANCE,
    "必须使用 $margin-test-requirements，一次读取source_artifacts_path引用的全部structure并生成唯一margin.raw.json；每行必须输出source_refs。",
    "raw每行严格包含margin_requirement_description、source_refs、related_description；不得输出requirement_id，finalize在去重后生成连续TR-YL编号。",
    "related_description必须严格使用技能规定的三类受控说明；写入raw前逐行自检。此项仅为prompt生成质量要求，不在raw复用或finalize阶段按枚举硬校验。",
    "只有形成资源能力与允许占用或实际需求之间可追溯且可执行的约束关系才是余量需求。存储余量按独立存储区拆分：不同介质分别生成，同一介质的多个命名区或独立地址范围也分别生成；地址只识别对象，不得通过地址差值计算容量。",
    "20%不是默认值。仅当原文明示单区余量≥20%，或明示全部存储区统一余量≥20%时才使用；统一要求应应用到每个明确存储区，其他比例保留原值。只有地址/容量而无适用余量约束时不生成row且不得补写20%，有审计价值时写open_questions。",
    "时间余量仅在原文明示时间余量、预留比例或预算占用上限时生成；普通中断/任务周期、响应时间、截止时间和处理上限属于性能测试，直接排除且不写open_questions。禁止通过周期-处理时间或处理时间÷周期推导5%、10%、20%等时间余量；周期500μs/处理50μs和周期1ms/处理50μs均不得生成row。",
    "吞吐余量必须同时有通道最大能力、可施加的峰值负载、明确余量/占用阈值和可观察统计口径；仅有标称速率和余量比例时不生成row，并在open_questions记录缺少峰值负载或观测口径。",
    "不得读取DOCX、硬件接口报告、源码或其他分析JSON；不得生成TR-YL、最终JSON或DOCX。",
    "TR需求描述不得保留“见表xxx”“详见表xxx”“按表xxx”等孤立引用；应写出来源明确的余量对象、限制和结果。此项仅为prompt生成质量要求，不进行代码正则硬校验。",
    `<matrix_worker_payload>${JSON.stringify({ source_artifacts_path: source, output_path: output })}</matrix_worker_payload>`,
  ].join("\n")
}

export async function prepareMarginTestContent(ctx: ToolContext): Promise<string> {
  const prerequisite = pathOf(ctx, ".matrix/data/functional-test-content.json")
  const source = pathOf(ctx, ".matrix/data/source-artifacts.json")
  const raw = pathOf(ctx, ".matrix/data/margin.raw.json")
  const final = pathOf(ctx, ".matrix/data/margin-test-content.json")
  const gaps = pathOf(ctx, ".matrix/data/margin-test-content-gaps.json")
  const report = pathOf(ctx, ".matrix/reports/margin-test-content.docx")
  if (!existsSync(prerequisite)) return JSON.stringify({ error: `File not found: ${prerequisite}`, missing_prerequisite: "functional_test_content" })
  if (!existsSync(source)) return JSON.stringify({ error: `File not found: ${source}`, missing_prerequisite: "source_artifacts" })
  const reused = validReusableRaw(raw, source)
  return JSON.stringify({ ok: true, mode: "prepare_margin_test_content", output: { margin_test_raw_path: raw, margin_test_content_path: final, margin_test_gaps_path: gaps, margin_test_report_path: report }, summary: { worker_count: reused ? 0 : 1, raw_reused: reused }, ...(reused ? {} : { worker: { subagent_type: "margin-test-content-modeler", output_path: raw, worker_payload: { source_artifacts_path: source, output_path: raw }, worker_prompt: workerPrompt(source, raw) } }) }, null, 2)
}

export async function finalizeMarginTestContent(ctx: ToolContext): Promise<string> {
  const source = pathOf(ctx, ".matrix/data/source-artifacts.json")
  const rawPath = pathOf(ctx, ".matrix/data/margin.raw.json")
  const final = pathOf(ctx, ".matrix/data/margin-test-content.json")
  const gapsPath = pathOf(ctx, ".matrix/data/margin-test-content-gaps.json")
  const report = pathOf(ctx, ".matrix/reports/margin-test-content.docx")
  if (!existsSync(source) || !existsSync(rawPath)) return JSON.stringify({ error: `File not found: ${!existsSync(source) ? source : rawPath}` })
  const bundle = loadPhase2SourceBundle(source)
  const raw = trackRaw(MarginTestRaw.parse(readPhase2Json(rawPath)), rawPath), seen = new Set<string>()
  const normalizedRows = raw.rows.map((r, i) => ({ ...r, source_refs: normalizeAndValidateSourceRefs(r.source_refs, bundle, `margin.rows[${i}]`) })).filter((r) => { const key = `${r.margin_requirement_description}|${r.related_description}`; if (seen.has(key)) return false; seen.add(key); return true })
  const rows: MarginTestTableRow[] = assignStableRequirementIds(normalizedRows, "TR-YL")
  const gaps = [...new Set([...raw.open_questions, ...phase2Warnings()].map(question => question.trim()).filter(Boolean))].map((question) => ({ question }))
  const model = MarginTestContent.parse({ version: "2.0", chapter_title_no: "4.5", chapter_title: "余量测试", section_title_no: "4.5.1", section_title: "余量需求项[TR-YL]", source_artifacts_path: source, rows, test_requirements: { sufficiency: "C1、C2", termination: "Z1、Z2", priority: "低优先级" }, summary: { total: rows.length, gap_count: gaps.length } })
  const gapModel = MarginTestGaps.parse({ version: "1.0", gaps, summary: { total: gaps.length } })
  mkdirSync(dirname(final), { recursive: true }); mkdirSync(dirname(report), { recursive: true })
  carryOrigins(rows, model.rows)
  carryOrigins({ ...raw, rows: undefined }, model)

  writeFileSync(final, JSON.stringify(model, null, 2)); writeFileSync(gapsPath, JSON.stringify(gapModel, null, 2)); writeFileSync(report, renderMarginTestContentDocx(model))
  publishEditMapping(final, model)
  return JSON.stringify({ ok: true, mode: "finalize_margin_test_content", output: { margin_test_content_path: final, margin_test_gaps_path: gapsPath, margin_test_report_path: report }, summary: model.summary }, null, 2)
}
