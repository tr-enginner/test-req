import { trackRaw, carryOrigins, publishEditMapping } from "../shared/phase2-edit-mapping"
import { phase2Warnings } from "../shared/phase2-tolerance"
import { readPhase2Json } from "../shared/phase2-json"
import type { ToolContext } from "@opencode-ai/plugin"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, join, resolve } from "path"
import { ReliabilitySafetyTestContent, ReliabilitySafetyTestGaps, ReliabilitySafetyTestRaw, type ReliabilitySafetyTestTableRow } from "../schema/reliability-safety-test-content"
import { PHASE2_REQUIREMENT_SOURCE_REFS_GUIDANCE } from "../shared/phase2-source-ref-guidance"
import { renderReliabilitySafetyTestContentDocx } from "./reliability-safety-test-content-docx"
import { loadPhase2SourceBundle, normalizeAndValidateSourceRefs } from "./phase2-source-bundle"
import { assignStableRequirementIds } from "../shared/phase2-stable-ids"

const baseDir = (ctx: ToolContext) => resolve(ctx.directory || ctx.worktree || process.cwd())
const pathOf = (ctx: ToolContext, relativePath: string) => join(baseDir(ctx), relativePath)
function validReusableRaw(raw: string, source: string): boolean {
  if (!existsSync(raw)) return false
  try { ReliabilitySafetyTestRaw.parse(readPhase2Json(raw)); return true } catch { return false }
}
function workerPrompt(source: string, output: string): string {
  return [
    PHASE2_REQUIREMENT_SOURCE_REFS_GUIDANCE,
    "必须使用 $reliability-safety-test-requirements，一次处理完整源文本并生成唯一reliability-safety.raw.json。",
    "raw每行严格包含reliability_safety_requirement_description、source_refs、related_description；不得输出requirement_id，finalize在去重后生成连续TR-AQ编号。",
    "候选项只能来自可靠性/安全性需求章节；全文其他位置只能用于展开候选项引用。必须用grep定位引用，再用read读取完整上下文。",
    "新生成related_description只能选择：提高安全性的容错方案、异常条件下系统的处理和保护能力、异常条件下软件的处理和保护能力、输入故障模式的测试。按主要测试对象选择系统或软件；无法判断时写open_questions，禁止输出历史兼容值“异常条件下系统软件的处理和保护能力”。",
    "写入raw前必须逐行自检related_description受控分类。此项仅为prompt生成质量要求，不在raw复用或finalize阶段按枚举硬校验。",
    "从地址0/程序入口/起始地址重新运行、重新启动、复位或重新初始化后恢复运行、异常跳转后重新进入正常流程均归4.8恢复性，不生成TR-AQ。复合描述删除恢复部分后不能独立形成检测、隔离或保护需求时整项排除。",
    "不得读取DOCX、硬件接口报告、源码或其他分析JSON；不得生成TR-AQ、最终JSON或DOCX。",
    "TR需求描述不得保留“见表xxx”“详见表xxx”“按表xxx”等孤立引用；应展开来源明确的故障、保护和恢复语义。此项仅为prompt生成质量要求，不进行代码正则硬校验。",
    `<matrix_worker_payload>${JSON.stringify({ source_artifacts_path: source, output_path: output })}</matrix_worker_payload>`,
  ].join("\n")
}

export async function prepareReliabilitySafetyTestContent(ctx: ToolContext): Promise<string> {
  const prerequisite = pathOf(ctx, ".matrix/data/functional-test-content.json")
  const source = pathOf(ctx, ".matrix/data/source-artifacts.json")
  const raw = pathOf(ctx, ".matrix/data/reliability-safety.raw.json")
  const final = pathOf(ctx, ".matrix/data/reliability-safety-test-content.json")
  const gaps = pathOf(ctx, ".matrix/data/reliability-safety-test-content-gaps.json")
  const report = pathOf(ctx, ".matrix/reports/reliability-safety-test-content.docx")
  if (!existsSync(prerequisite)) return JSON.stringify({ error: `File not found: ${prerequisite}`, missing_prerequisite: "functional_test_content" })
  if (!existsSync(source)) return JSON.stringify({ error: `File not found: ${source}`, missing_prerequisite: "source_artifacts" })
  const reused = validReusableRaw(raw, source)
  return JSON.stringify({ ok: true, mode: "prepare_reliability_safety_test_content", output: { reliability_safety_test_raw_path: raw, reliability_safety_test_content_path: final, reliability_safety_test_gaps_path: gaps, reliability_safety_test_report_path: report }, summary: { worker_count: reused ? 0 : 1, raw_reused: reused }, ...(reused ? {} : { worker: { subagent_type: "reliability-safety-test-content-modeler", output_path: raw, worker_payload: { source_artifacts_path: source, output_path: raw }, worker_prompt: workerPrompt(source, raw) } }) }, null, 2)
}

export async function finalizeReliabilitySafetyTestContent(ctx: ToolContext): Promise<string> {
  const source = pathOf(ctx, ".matrix/data/source-artifacts.json")
  const rawPath = pathOf(ctx, ".matrix/data/reliability-safety.raw.json")
  const final = pathOf(ctx, ".matrix/data/reliability-safety-test-content.json")
  const gapsPath = pathOf(ctx, ".matrix/data/reliability-safety-test-content-gaps.json")
  const report = pathOf(ctx, ".matrix/reports/reliability-safety-test-content.docx")
  if (!existsSync(source) || !existsSync(rawPath)) return JSON.stringify({ error: `File not found: ${!existsSync(source) ? source : rawPath}` })
  const bundle = loadPhase2SourceBundle(source)
  const raw = trackRaw(ReliabilitySafetyTestRaw.parse(readPhase2Json(rawPath)), rawPath), seen = new Set<string>()
  const normalizedRows = raw.rows.map((r, i) => ({ ...r, source_refs: normalizeAndValidateSourceRefs(r.source_refs, bundle, `reliability.rows[${i}]`) })).filter((r) => { const k = `${r.reliability_safety_requirement_description}|${r.related_description}`; if (seen.has(k)) return false; seen.add(k); return true })
  const rows: ReliabilitySafetyTestTableRow[] = assignStableRequirementIds(normalizedRows, "TR-AQ")
  const gaps = [...new Set([...raw.open_questions, ...phase2Warnings()].map(question => question.trim()).filter(Boolean))].map((question) => ({ question }))
  const model = ReliabilitySafetyTestContent.parse({ version: "2.0", chapter_title_no: "4.4", chapter_title: "可靠性安全性测试", section_title_no: "4.4.1", section_title: "可靠性安全性需求项[TR-AQ]", source_artifacts_path: source, rows, test_requirements: { sufficiency: "C1、C2", termination: "Z1、Z2", priority: "低优先级" }, summary: { total: rows.length, gap_count: gaps.length } })
  const gapModel = ReliabilitySafetyTestGaps.parse({ version: "1.0", gaps, summary: { total: gaps.length } })
  mkdirSync(dirname(final), { recursive: true }); mkdirSync(dirname(report), { recursive: true })
  carryOrigins(rows, model.rows)
  carryOrigins({ ...raw, rows: undefined }, model)

  writeFileSync(final, JSON.stringify(model, null, 2)); writeFileSync(gapsPath, JSON.stringify(gapModel, null, 2)); writeFileSync(report, renderReliabilitySafetyTestContentDocx(model))
  publishEditMapping(final, model)
  return JSON.stringify({ ok: true, mode: "finalize_reliability_safety_test_content", output: { reliability_safety_test_content_path: final, reliability_safety_test_gaps_path: gapsPath, reliability_safety_test_report_path: report }, summary: model.summary }, null, 2)
}
