import { trackRaw, carryOrigins, publishEditMapping } from "../shared/phase2-edit-mapping"
import { phase2Warnings } from "../shared/phase2-tolerance"
import { readPhase2Json } from "../shared/phase2-json"
import type { ToolContext } from "@opencode-ai/plugin"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, join, resolve } from "path"
import {
  StrengthTestContent,
  StrengthTestGaps,
  StrengthTestRaw,
  type StrengthTestTableRow,
} from "../schema/strength-test-content"
import { PHASE2_REQUIREMENT_SOURCE_REFS_GUIDANCE } from "../shared/phase2-source-ref-guidance"
import { renderStrengthTestContentDocx } from "./strength-test-content-docx"
import { loadPhase2SourceBundle, normalizeAndValidateSourceRefs } from "./phase2-source-bundle"
import { assignStableRequirementIds } from "../shared/phase2-stable-ids"

const baseDir = (ctx: ToolContext) => resolve(ctx.directory || ctx.worktree || process.cwd())
const pathOf = (ctx: ToolContext, relativePath: string) => join(baseDir(ctx), relativePath)


function validReusableRaw(rawPath: string, _sourcePath: string): boolean {
  if (!existsSync(rawPath)) return false
  try {
    StrengthTestRaw.parse(readPhase2Json(rawPath))
    return true
  } catch {
    return false
  }
}

function workerPrompt(sourcePath: string, outputPath: string): string {
  return [
    PHASE2_REQUIREMENT_SOURCE_REFS_GUIDANCE,
    "必须使用 $strength-test-requirements，一次读取source_artifacts_path引用的全部structure并生成唯一strength.raw.json；每行必须输出source_refs。",
    "raw每行严格包含strength_requirement_description、source_refs、related_description；不得输出requirement_id，finalize在去重后生成连续TR-QD编号。",
    "提取超正常负载、接近极限、最大数据量、功能并发、异常输入、长时间连续运行、逐步加压、异常点/故障点、粗到细步长、稳定点反复确认等强度测试需求；允许rows为空。",
    "related_description严格只能是：长时间连续不间断综合功能测试、提供数据能力的饱和性试验指标。",
    "写入raw前必须逐行自检related_description受控分类。此项仅为prompt生成质量要求，不在raw复用或finalize阶段按枚举硬校验。",
    "不得读取DOCX、硬件接口报告、源码或其他分析JSON；不得生成TR-QD、最终JSON或DOCX；不得拆分批次。",
    "TR需求描述不得保留“见表xxx”“详见表xxx”“按表xxx”等孤立引用；应写出来源明确的施压条件和可观测结果。此项仅为prompt生成质量要求，不进行代码正则硬校验。",
    `<matrix_worker_payload>${JSON.stringify({ source_artifacts_path: sourcePath, output_path: outputPath })}</matrix_worker_payload>`,
  ].join("\n")
}

export async function prepareStrengthTestContent(ctx: ToolContext): Promise<string> {
  const prerequisite = pathOf(ctx, ".matrix/data/functional-test-content.json")
  const sourcePath = pathOf(ctx, ".matrix/data/source-artifacts.json")
  const rawPath = pathOf(ctx, ".matrix/data/strength.raw.json")
  const finalPath = pathOf(ctx, ".matrix/data/strength-test-content.json")
  const gapsPath = pathOf(ctx, ".matrix/data/strength-test-content-gaps.json")
  const reportPath = pathOf(ctx, ".matrix/reports/strength-test-content.docx")

  if (!existsSync(prerequisite)) return JSON.stringify({ error: `File not found: ${prerequisite}`, missing_prerequisite: "functional_test_content" })
  if (!existsSync(sourcePath)) return JSON.stringify({ error: `File not found: ${sourcePath}`, missing_prerequisite: "source_artifacts" })

  const reused = validReusableRaw(rawPath, sourcePath)
  return JSON.stringify({
    ok: true,
    mode: "prepare_strength_test_content",
    output: {
      strength_test_raw_path: rawPath,
      strength_test_content_path: finalPath,
      strength_test_gaps_path: gapsPath,
      strength_test_report_path: reportPath,
    },
    summary: { worker_count: reused ? 0 : 1, raw_reused: reused },
    ...(reused ? {} : {
      worker: {
        subagent_type: "strength-test-content-modeler",
        output_path: rawPath,
        worker_payload: { source_artifacts_path: sourcePath, output_path: rawPath },
        worker_prompt: workerPrompt(sourcePath, rawPath),
      },
    }),
  }, null, 2)
}

export async function finalizeStrengthTestContent(ctx: ToolContext): Promise<string> {
  const sourcePath = pathOf(ctx, ".matrix/data/source-artifacts.json")
  const rawPath = pathOf(ctx, ".matrix/data/strength.raw.json")
  const finalPath = pathOf(ctx, ".matrix/data/strength-test-content.json")
  const gapsPath = pathOf(ctx, ".matrix/data/strength-test-content-gaps.json")
  const reportPath = pathOf(ctx, ".matrix/reports/strength-test-content.docx")
  if (!existsSync(sourcePath)) return JSON.stringify({ error: `File not found: ${sourcePath}` })
  if (!existsSync(rawPath)) return JSON.stringify({ error: `File not found: ${rawPath}` })

  const bundle = loadPhase2SourceBundle(sourcePath)
  const raw = trackRaw(StrengthTestRaw.parse(readPhase2Json(rawPath)), rawPath)
  const seen = new Set<string>()
  const normalizedRows = raw.rows.map((row, index) => ({ ...row, source_refs: normalizeAndValidateSourceRefs(row.source_refs, bundle, `strength.rows[${index}]`) })).filter((row) => {
    const key = `${row.strength_requirement_description}|${row.related_description}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const rows: StrengthTestTableRow[] = assignStableRequirementIds(normalizedRows, "TR-QD")
  const gaps = [...new Set([...raw.open_questions, ...phase2Warnings()].map(question => question.trim()).filter(Boolean))].map((question) => ({ question }))
  const model = StrengthTestContent.parse({
    version: "2.0",
    chapter_title_no: "4.9",
    chapter_title: "强度测试",
    section_title_no: "4.9.1",
    section_title: "强度需求项[TR-QD]",
    source_artifacts_path: sourcePath,
    rows,
    test_requirements: { sufficiency: "C1、C2", termination: "Z1、Z2", priority: "低优先级" },
    summary: { total: rows.length, gap_count: gaps.length },
  })
  const gapModel = StrengthTestGaps.parse({ version: "1.0", gaps, summary: { total: gaps.length } })

  mkdirSync(dirname(finalPath), { recursive: true })
  mkdirSync(dirname(reportPath), { recursive: true })
  carryOrigins(rows, model.rows)
  carryOrigins({ ...raw, rows: undefined }, model)

  writeFileSync(finalPath, JSON.stringify(model, null, 2), "utf-8")
  writeFileSync(gapsPath, JSON.stringify(gapModel, null, 2), "utf-8")
  writeFileSync(reportPath, renderStrengthTestContentDocx(model))
  publishEditMapping(finalPath, model)
  return JSON.stringify({
    ok: true,
    mode: "finalize_strength_test_content",
    output: {
      strength_test_content_path: finalPath,
      strength_test_gaps_path: gapsPath,
      strength_test_report_path: reportPath,
    },
    summary: model.summary,
  }, null, 2)
}
