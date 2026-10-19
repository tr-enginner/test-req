import { trackRaw, carryOrigins, publishEditMapping } from "../shared/phase2-edit-mapping"
import { phase2Warnings } from "../shared/phase2-tolerance"
import { readPhase2Json } from "../shared/phase2-json"
import type { ToolContext } from "@opencode-ai/plugin"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, join, resolve } from "path"
import { BoundaryTestContent, BoundaryTestGaps, BoundaryTestRaw, type BoundaryTestTableRow } from "../schema/boundary-test-content"
import { PHASE2_REQUIREMENT_SOURCE_REFS_GUIDANCE } from "../shared/phase2-source-ref-guidance"
import { renderBoundaryTestContentDocx } from "./boundary-test-content-docx"
import { loadPhase2SourceBundle, normalizeAndValidateSourceRefs } from "./phase2-source-bundle"
import { assignStableRequirementIds } from "../shared/phase2-stable-ids"

const baseDir = (ctx: ToolContext) => resolve(ctx.directory || ctx.worktree || process.cwd())
const pathOf = (ctx: ToolContext, relativePath: string) => join(baseDir(ctx), relativePath)


function validReusableRaw(raw: string, _source: string): boolean {
  if (!existsSync(raw)) return false
  try {
    BoundaryTestRaw.parse(readPhase2Json(raw))
    return true
  } catch {
    return false
  }
}

function workerPrompt(source: string, output: string): string {
  return [
    PHASE2_REQUIREMENT_SOURCE_REFS_GUIDANCE,
    "必须使用 $boundary-test-requirements，一次读取source_artifacts_path引用的全部structure并生成唯一boundary.raw.json；每行必须输出source_refs。",
    "raw每行严格包含boundary_requirement_description、source_refs、related_description；不得输出requirement_id，finalize在去重后生成连续TR-BJ编号。",
    "related_description必须采用具体对象名称加受控后缀，或采用固定的状态转换分类；写入raw前逐行自检。此项仅为prompt生成质量要求，不在raw复用或finalize阶段按后缀/分类硬校验。",
    "只提取具有明确对象、原文边界依据和边界处预期行为的需求；不成立候选项直接忽略，允许rows为空，禁止生成否定性伪需求。",
    "新生成区间不得使用start~end或start～end：闭区间写[start, end]，开区间写(start, end)，半开区间写[start, end)或(start, end]，逗号后保留一个空格。按原文保留开闭关系、数值进制、精度、符号和单位，例如十六进制值不得转为十进制；单侧边界不补造另一端，枚举/离散值不改成区间，100±10等容差不自行计算端点。",
    "必须主动识别程序注入、烧录、内存访问、缓冲区和数据搬运中的地址边界：起始/结束地址、合法区间、基址与偏移范围、对齐、禁止/保留/只读区、起始地址+长度-1、地址加法溢出或回绕、跨区及越过缓冲区边界。",
    "地址row必须包含具体地址对象、原文明示的合法性依据和合法/越界/未对齐时的预期行为；地址归输入域，related_description使用具体对象加现有数据输入域边界/端点后缀，不新增枚举。程序注入起始地址、注入长度和组合末地址的结果或异常处理不同时分别生成row。",
    "保留原文地址进制、位宽、符号和单位；原文0x1000~0x1FFF写为[0x1000, 0x1FFF]。可保留原文明示的起始地址+长度-1关系，但不得依据位宽、容量或常识计算未给出的端点；离散合法地址、禁区和保留地址保持集合表达。",
    "仅给出基址而没有范围、对齐或越界行为时不生成row，必要时写open_questions；普通地址计算、文件写入或烧录步骤本身不成立，只有存在合法区间、端点、对齐、禁区、跨区或溢出约束时才生成地址边界TR。",
    "不得补造原文没有的±1值、阈值、单位或处理行为；不得读取DOCX、硬件接口报告、源码或其他分析JSON。",
    "不得生成TR-BJ、最终JSON或DOCX。",
    "TR需求描述不得保留“见表xxx”“详见表xxx”“按表xxx”等孤立引用；应写出来源明确的边界条件和预期行为。此项仅为prompt生成质量要求，不进行代码正则硬校验。",
    `<matrix_worker_payload>${JSON.stringify({ source_artifacts_path: source, output_path: output })}</matrix_worker_payload>`,
  ].join("\n")
}

export async function prepareBoundaryTestContent(ctx: ToolContext): Promise<string> {
  const prerequisite = pathOf(ctx, ".matrix/data/functional-test-content.json")
  const source = pathOf(ctx, ".matrix/data/source-artifacts.json")
  const raw = pathOf(ctx, ".matrix/data/boundary.raw.json")
  const final = pathOf(ctx, ".matrix/data/boundary-test-content.json")
  const gaps = pathOf(ctx, ".matrix/data/boundary-test-content-gaps.json")
  const report = pathOf(ctx, ".matrix/reports/boundary-test-content.docx")
  if (!existsSync(prerequisite)) return JSON.stringify({ error: `File not found: ${prerequisite}`, missing_prerequisite: "functional_test_content" })
  if (!existsSync(source)) return JSON.stringify({ error: `File not found: ${source}`, missing_prerequisite: "source_artifacts" })
  const reused = validReusableRaw(raw, source)
  return JSON.stringify({
    ok: true,
    mode: "prepare_boundary_test_content",
    output: { boundary_test_raw_path: raw, boundary_test_content_path: final, boundary_test_gaps_path: gaps, boundary_test_report_path: report },
    summary: { worker_count: reused ? 0 : 1, raw_reused: reused },
    ...(reused ? {} : { worker: { subagent_type: "boundary-test-content-modeler", output_path: raw, worker_payload: { source_artifacts_path: source, output_path: raw }, worker_prompt: workerPrompt(source, raw) } }),
  }, null, 2)
}

export async function finalizeBoundaryTestContent(ctx: ToolContext): Promise<string> {
  const source = pathOf(ctx, ".matrix/data/source-artifacts.json")
  const rawPath = pathOf(ctx, ".matrix/data/boundary.raw.json")
  const final = pathOf(ctx, ".matrix/data/boundary-test-content.json")
  const gapsPath = pathOf(ctx, ".matrix/data/boundary-test-content-gaps.json")
  const report = pathOf(ctx, ".matrix/reports/boundary-test-content.docx")
  if (!existsSync(source) || !existsSync(rawPath)) return JSON.stringify({ error: `File not found: ${!existsSync(source) ? source : rawPath}` })
  const bundle = loadPhase2SourceBundle(source)
  const raw = trackRaw(BoundaryTestRaw.parse(readPhase2Json(rawPath)), rawPath)
  const seen = new Set<string>()
  const normalizedRows = raw.rows.map((row, index) => ({ ...row, source_refs: normalizeAndValidateSourceRefs(row.source_refs, bundle, `boundary.rows[${index}]`) })).filter((row) => {
    const key = `${row.boundary_requirement_description}|${row.related_description}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const rows: BoundaryTestTableRow[] = assignStableRequirementIds(normalizedRows, "TR-BJ")
  const gaps = [...new Set([...raw.open_questions, ...phase2Warnings()].map(question => question.trim()).filter(Boolean))].map((question) => ({ question }))
  const model = BoundaryTestContent.parse({
    version: "2.0",
    chapter_title_no: "4.6",
    chapter_title: "边界测试",
    section_title_no: "4.6.1",
    section_title: "边界需求项[TR-BJ]",
    source_artifacts_path: source,
    rows,
    test_requirements: { sufficiency: "C1、C2、C3、C4、C5", termination: "Z1、Z2", priority: "高优先级" },
    summary: { total: rows.length, gap_count: gaps.length },
  })
  const gapModel = BoundaryTestGaps.parse({ version: "1.0", gaps, summary: { total: gaps.length } })
  mkdirSync(dirname(final), { recursive: true })
  mkdirSync(dirname(report), { recursive: true })
  carryOrigins(rows, model.rows)
  carryOrigins({ ...raw, rows: undefined }, model)

  writeFileSync(final, JSON.stringify(model, null, 2))
  writeFileSync(gapsPath, JSON.stringify(gapModel, null, 2))
  writeFileSync(report, renderBoundaryTestContentDocx(model))
  publishEditMapping(final, model)
  return JSON.stringify({
    ok: true,
    mode: "finalize_boundary_test_content",
    output: { boundary_test_content_path: final, boundary_test_gaps_path: gapsPath, boundary_test_report_path: report },
    summary: model.summary,
  }, null, 2)
}
