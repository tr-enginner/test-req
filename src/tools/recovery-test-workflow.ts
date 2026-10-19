import { trackRaw, carryOrigins, publishEditMapping } from "../shared/phase2-edit-mapping"
import { phase2Warnings } from "../shared/phase2-tolerance"
import { readPhase2Json } from "../shared/phase2-json"
import type { ToolContext } from "@opencode-ai/plugin"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, join, resolve } from "path"
import {
  RecoveryTestContent,
  RecoveryTestGaps,
  RecoveryTestRaw,
  type RecoveryTestTableRow,
} from "../schema/recovery-test-content"
import { PHASE2_REQUIREMENT_SOURCE_REFS_GUIDANCE } from "../shared/phase2-source-ref-guidance"
import { renderRecoveryTestContentDocx } from "./recovery-test-content-docx"
import { loadPhase2SourceBundle, normalizeAndValidateSourceRefs } from "./phase2-source-bundle"
import { assignStableRequirementIds } from "../shared/phase2-stable-ids"

const baseDir = (ctx: ToolContext) => resolve(ctx.directory || ctx.worktree || process.cwd())
const pathOf = (ctx: ToolContext, relativePath: string) => join(baseDir(ctx), relativePath)


function validReusableRaw(rawPath: string, _sourcePath: string): boolean {
  if (!existsSync(rawPath)) return false
  try {
    RecoveryTestRaw.parse(readPhase2Json(rawPath))
    return true
  } catch {
    return false
  }
}

function workerPrompt(sourcePath: string, outputPath: string): string {
  return [
    PHASE2_REQUIREMENT_SOURCE_REFS_GUIDANCE,
    "必须使用 $recovery-test-requirements，一次读取source_artifacts_path引用的全部structure并生成唯一recovery.raw.json；每行必须输出source_refs。",
    "raw每行严格包含recovery_requirement_description、source_refs、related_description；不得输出requirement_id，finalize在去重后生成连续TR-HF编号。",
    "搜索并固化关键词：陷阱填充、软复位、硬复位、EDAC、SRAM、看门狗、故障、异常、中断、错误、备用、恢复、重新运行、重新启动、地址0、起始地址、程序入口。",
    "只提取验证系统在故障、异常或中断后能否按设计恢复运行，并保证数据、状态和功能一致性的需求；不成立候选直接忽略，允许rows为空。",
    "异常进入未用中断后跳转地址0重新运行、从程序入口或起始地址重新运行、软/硬复位或重新启动后恢复运行、重新初始化后恢复功能/数据/状态、异常跳转后重新进入正常流程，均按4.8恢复性候选处理；保留原文明示的恢复入口和恢复结果。",
    "related_description严格只能是：故障发生时保护系统状态、切换备用硬件、探测错误功能。",
    "写入raw前必须逐行自检related_description受控分类。此项仅为prompt生成质量要求，不在raw复用或finalize阶段按枚举硬校验。",
    "不得读取DOCX、硬件接口报告、源码或其他分析JSON；不得生成TR-HF、最终JSON或DOCX；不得拆分批次。",
    "TR需求描述不得保留“见表xxx”“详见表xxx”“按表xxx”等孤立引用；应写出来源明确的故障触发、恢复动作和结果。此项仅为prompt生成质量要求，不进行代码正则硬校验。",
    `<matrix_worker_payload>${JSON.stringify({ source_artifacts_path: sourcePath, output_path: outputPath })}</matrix_worker_payload>`,
  ].join("\n")
}

export async function prepareRecoveryTestContent(ctx: ToolContext): Promise<string> {
  const prerequisite = pathOf(ctx, ".matrix/data/functional-test-content.json")
  const sourcePath = pathOf(ctx, ".matrix/data/source-artifacts.json")
  const rawPath = pathOf(ctx, ".matrix/data/recovery.raw.json")
  const finalPath = pathOf(ctx, ".matrix/data/recovery-test-content.json")
  const gapsPath = pathOf(ctx, ".matrix/data/recovery-test-content-gaps.json")
  const reportPath = pathOf(ctx, ".matrix/reports/recovery-test-content.docx")

  if (!existsSync(prerequisite)) return JSON.stringify({ error: `File not found: ${prerequisite}`, missing_prerequisite: "functional_test_content" })
  if (!existsSync(sourcePath)) return JSON.stringify({ error: `File not found: ${sourcePath}`, missing_prerequisite: "source_artifacts" })

  const reused = validReusableRaw(rawPath, sourcePath)
  return JSON.stringify({
    ok: true,
    mode: "prepare_recovery_test_content",
    output: {
      recovery_test_raw_path: rawPath,
      recovery_test_content_path: finalPath,
      recovery_test_gaps_path: gapsPath,
      recovery_test_report_path: reportPath,
    },
    summary: { worker_count: reused ? 0 : 1, raw_reused: reused },
    ...(reused ? {} : {
      worker: {
        subagent_type: "recovery-test-content-modeler",
        output_path: rawPath,
        worker_payload: { source_artifacts_path: sourcePath, output_path: rawPath },
        worker_prompt: workerPrompt(sourcePath, rawPath),
      },
    }),
  }, null, 2)
}

export async function finalizeRecoveryTestContent(ctx: ToolContext): Promise<string> {
  const sourcePath = pathOf(ctx, ".matrix/data/source-artifacts.json")
  const rawPath = pathOf(ctx, ".matrix/data/recovery.raw.json")
  const finalPath = pathOf(ctx, ".matrix/data/recovery-test-content.json")
  const gapsPath = pathOf(ctx, ".matrix/data/recovery-test-content-gaps.json")
  const reportPath = pathOf(ctx, ".matrix/reports/recovery-test-content.docx")
  if (!existsSync(sourcePath)) return JSON.stringify({ error: `File not found: ${sourcePath}` })
  if (!existsSync(rawPath)) return JSON.stringify({ error: `File not found: ${rawPath}` })

  const bundle = loadPhase2SourceBundle(sourcePath)
  const raw = trackRaw(RecoveryTestRaw.parse(readPhase2Json(rawPath)), rawPath)
  const seen = new Set<string>()
  const normalizedRows = raw.rows.map((row, index) => ({ ...row, source_refs: normalizeAndValidateSourceRefs(row.source_refs, bundle, `recovery.rows[${index}]`) })).filter((row) => {
    const key = `${row.recovery_requirement_description}|${row.related_description}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const rows: RecoveryTestTableRow[] = assignStableRequirementIds(normalizedRows, "TR-HF")
  const gaps = [...new Set([...raw.open_questions, ...phase2Warnings()].map(question => question.trim()).filter(Boolean))].map((question) => ({ question }))
  const model = RecoveryTestContent.parse({
    version: "2.0",
    chapter_title_no: "4.8",
    chapter_title: "恢复性测试",
    section_title_no: "4.8.1",
    section_title: "恢复性需求项[TR-HF]",
    source_artifacts_path: sourcePath,
    rows,
    test_requirements: { sufficiency: "C1、C2", termination: "Z1、Z2", priority: "高优先级" },
    summary: { total: rows.length, gap_count: gaps.length },
  })
  const gapModel = RecoveryTestGaps.parse({ version: "1.0", gaps, summary: { total: gaps.length } })

  mkdirSync(dirname(finalPath), { recursive: true })
  mkdirSync(dirname(reportPath), { recursive: true })
  carryOrigins(rows, model.rows)
  carryOrigins({ ...raw, rows: undefined }, model)

  writeFileSync(finalPath, JSON.stringify(model, null, 2), "utf-8")
  writeFileSync(gapsPath, JSON.stringify(gapModel, null, 2), "utf-8")
  writeFileSync(reportPath, renderRecoveryTestContentDocx(model))
  publishEditMapping(finalPath, model)
  return JSON.stringify({
    ok: true,
    mode: "finalize_recovery_test_content",
    output: {
      recovery_test_content_path: finalPath,
      recovery_test_gaps_path: gapsPath,
      recovery_test_report_path: reportPath,
    },
    summary: model.summary,
  }, null, 2)
}
