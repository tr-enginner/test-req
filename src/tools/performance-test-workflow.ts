import { trackRaw, carryOrigins, publishEditMapping } from "../shared/phase2-edit-mapping"
import { phase2Warnings } from "../shared/phase2-tolerance"
import { readPhase2Json } from "../shared/phase2-json"
import type { ToolContext } from "@opencode-ai/plugin"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, join, resolve } from "path"
import {
  PerformanceTestContent,
  PerformanceTestGaps,
  PerformanceTestRaw,
  type PerformanceTestTableRow,
} from "../schema/performance-test-content"
import { PHASE2_REQUIREMENT_SOURCE_REFS_GUIDANCE } from "../shared/phase2-source-ref-guidance"
import { renderPerformanceTestContentDocx } from "./performance-test-content-docx"
import { loadPhase2SourceBundle, normalizeAndValidateSourceRefs } from "./phase2-source-bundle"
import { assignStableRequirementIds } from "../shared/phase2-stable-ids"

function baseDir(ctx: ToolContext): string {
  return resolve(ctx.directory || ctx.worktree || process.cwd())
}

function pathOf(ctx: ToolContext, relativePath: string): string {
  return join(baseDir(ctx), relativePath)
}


function validReusableRaw(rawPath: string): boolean {
  if (!existsSync(rawPath)) return false
  try {
    PerformanceTestRaw.parse(readPhase2Json(rawPath))
    return true
  } catch {
    return false
  }
}

function workerPrompt(sourceArtifactsPath: string, outputPath: string): string {
  const payload = { source_artifacts_path: sourceArtifactsPath, output_path: outputPath }
  return [
    PHASE2_REQUIREMENT_SOURCE_REFS_GUIDANCE,
    "必须使用 $performance-test-requirements。读取source_artifacts_path清单及其structure_path；正文来自section.text，表格占位符通过同章节tables[].table_html读取。不得虚构source_ref。",
    "raw每行严格包含performance_requirement_description、source_refs、related_description；不得输出requirement_id，finalize在去重后生成连续TR-XN编号。",
    "related_description必须严格使用技能规定的受控分类；写入raw前逐行自检。此项仅为prompt生成质量要求，不在raw复用或finalize阶段按枚举硬校验。",
    "不得拆分批次，不得读取DOCX、硬件接口报告、源码或其他分析JSON，不得生成TR-XN、最终JSON或DOCX。",
    "TR需求描述不得保留“见表xxx”“详见表xxx”“按表xxx”等孤立引用；应写出来源明确的可测试语义。此项仅为prompt生成质量要求，不进行代码正则硬校验。",
    "按指标语义而不是时间单位、周期/频率关键词或所在章节分类。固定调度或设计配置（如“定时周期为10毫秒”“每1秒更新并发送一次”）不得生成性能row；带可验收边界的“采集周期小于1秒”、响应/处理截止时间、时间误差、抖动、帧间隔范围和吞吐能力仍可生成row。“周期为10毫秒，误差不超过±1毫秒”只围绕误差生成row。",
    "明确排除项不生成row。raw没有warnings字段，因此在open_questions中按“已排除（固定调度周期/设计约束）：<原始摘要>；来源：<canonical source_ref>；理由：<理由>”记录审计说明；真正语义不明的候选才写普通待确认问题。",
    `<matrix_worker_payload>${JSON.stringify(payload)}</matrix_worker_payload>`,
  ].join("\n")
}

export async function preparePerformanceTestContent(ctx: ToolContext): Promise<string> {
  const functionalTestPath = pathOf(ctx, ".matrix/data/functional-test-content.json")
  const sourcePath = pathOf(ctx, ".matrix/data/source-artifacts.json")
  const rawPath = pathOf(ctx, ".matrix/data/performance.raw.json")
  const finalPath = pathOf(ctx, ".matrix/data/performance-test-content.json")
  const gapsPath = pathOf(ctx, ".matrix/data/performance-test-content-gaps.json")
  const reportPath = pathOf(ctx, ".matrix/reports/performance-test-content.docx")

  for (const [path, prerequisite] of [[functionalTestPath, "functional_test_content"], [sourcePath, "source_artifacts"]] as const) {
    if (!existsSync(path)) return JSON.stringify({ error: `File not found: ${path}`, missing_prerequisite: prerequisite })
  }

  const bundle = loadPhase2SourceBundle(sourcePath)
  const reused = validReusableRaw(rawPath)
  const prompt = workerPrompt(sourcePath, rawPath)
  return JSON.stringify({
    ok: true,
    mode: "prepare_performance_test_content",
    output: {
      performance_test_raw_path: rawPath,
      performance_test_content_path: finalPath,
      performance_test_gaps_path: gapsPath,
      performance_test_report_path: reportPath,
    },
    summary: { worker_count: reused ? 0 : 1, raw_reused: reused },
    ...(reused ? {} : {
      worker: {
        subagent_type: "performance-test-content-modeler",
        output_path: rawPath,
        worker_payload: { source_artifacts_path: sourcePath, output_path: rawPath },
        worker_prompt: prompt,
      },
    }),
  }, null, 2)
}

export async function finalizePerformanceTestContent(ctx: ToolContext): Promise<string> {
  const sourcePath = pathOf(ctx, ".matrix/data/source-artifacts.json")
  const rawPath = pathOf(ctx, ".matrix/data/performance.raw.json")
  const finalPath = pathOf(ctx, ".matrix/data/performance-test-content.json")
  const gapsPath = pathOf(ctx, ".matrix/data/performance-test-content-gaps.json")
  const reportPath = pathOf(ctx, ".matrix/reports/performance-test-content.docx")
  if (!existsSync(sourcePath)) return JSON.stringify({ error: `File not found: ${sourcePath}` })
  if (!existsSync(rawPath)) return JSON.stringify({ error: `File not found: ${rawPath}` })

  const bundle = loadPhase2SourceBundle(sourcePath)
  const rawValue = readPhase2Json(rawPath)
  const raw = trackRaw(PerformanceTestRaw.parse(rawValue), rawPath)
  const seen = new Set<string>()
  const normalizedRows = raw.rows.map((row, index) => ({ ...row, source_refs: normalizeAndValidateSourceRefs(row.source_refs, bundle, `performance.rows[${index}]`) })).filter((row) => {
    const key = `${row.performance_requirement_description}|${row.related_description}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const rows: PerformanceTestTableRow[] = assignStableRequirementIds(normalizedRows, "TR-XN")
  const gaps = [...new Set([...raw.open_questions, ...phase2Warnings()].map(question => question.trim()).filter(Boolean))].map((question) => ({ question }))
  const model = PerformanceTestContent.parse({
    version: "2.0",
    chapter_title_no: "4.2",
    chapter_title: "性能测试",
    section_title_no: "4.2.1",
    section_title: "性能需求项[TR-XN]",
    source_artifacts_path: sourcePath,
    rows,
    test_requirements: { sufficiency: "C1、C2", termination: "Z1、Z2", priority: "低优先级" },
    summary: { total: rows.length, gap_count: gaps.length },
  })
  const gapsArtifact = PerformanceTestGaps.parse({ version: "1.0", gaps, summary: { total: gaps.length } })

  mkdirSync(dirname(finalPath), { recursive: true })
  mkdirSync(dirname(reportPath), { recursive: true })
  carryOrigins(rows, model.rows)
  carryOrigins({ ...raw, rows: undefined }, model)

  writeFileSync(finalPath, JSON.stringify(model, null, 2), "utf-8")
  writeFileSync(gapsPath, JSON.stringify(gapsArtifact, null, 2), "utf-8")
  writeFileSync(reportPath, renderPerformanceTestContentDocx(model))
  publishEditMapping(finalPath, model)
  return JSON.stringify({
    ok: true,
    mode: "finalize_performance_test_content",
    output: {
      performance_test_content_path: finalPath,
      performance_test_gaps_path: gapsPath,
      performance_test_report_path: reportPath,
    },
    summary: model.summary,
  }, null, 2)
}
