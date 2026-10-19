import { trackRaw, carryOrigins, publishEditMapping } from "../shared/phase2-edit-mapping"
import { phase2Warnings } from "../shared/phase2-tolerance"
import { readPhase2Json } from "../shared/phase2-json"
import type { ToolContext } from "@opencode-ai/plugin"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, join, resolve } from "path"
import {
  DataProcessingTestContent,
  DataProcessingTestGaps,
  DataProcessingTestRaw,
  type DataProcessingTestTableRow,
} from "../schema/data-processing-test-content"
import { PHASE2_REQUIREMENT_SOURCE_REFS_GUIDANCE } from "../shared/phase2-source-ref-guidance"
import { renderDataProcessingTestContentDocx } from "./data-processing-test-content-docx"
import { loadPhase2SourceBundle, normalizeAndValidateSourceRefs } from "./phase2-source-bundle"
import { assignStableRequirementIds } from "../shared/phase2-stable-ids"

const baseDir = (ctx: ToolContext) => resolve(ctx.directory || ctx.worktree || process.cwd())
const pathOf = (ctx: ToolContext, relativePath: string) => join(baseDir(ctx), relativePath)


function validReusableRaw(rawPath: string, _sourcePath: string): boolean {
  if (!existsSync(rawPath)) return false
  try {
    DataProcessingTestRaw.parse(readPhase2Json(rawPath))
    return true
  } catch {
    return false
  }
}

function workerPrompt(sourcePath: string, outputPath: string): string {
  return [
    PHASE2_REQUIREMENT_SOURCE_REFS_GUIDANCE,
    "必须使用 $data-processing-test-requirements，一次读取source_artifacts_path引用的全部structure并生成唯一data-processing.raw.json；每行必须输出source_refs。",
    "raw每行严格包含data_processing_requirement_description、source_refs、related_description；不得输出requirement_id，finalize在去重后生成连续TR-SC编号。",
    "只提取以数据内容质量或通用表示预处理为主要验证对象、能脱离具体业务功能独立描述明确输入、处理规则和可验证结果的需求；接收、解析、暂存、读取、计算、转换、校验、无效等动词不能单独证明属于4.7，不成立候选项直接忽略，允许rows为空。",
    "related_description严格只能是：数据采集、数据转换、数据剔除、数据融合、数据解释。",
    "写入raw前必须逐行自检related_description受控分类。此项仅为prompt生成质量要求，不在raw复用或finalize阶段按枚举硬校验。",
    "固定按4.3接口协议→4.6边界→4.1核心功能→4.7数据处理裁决；前三类任一成立时不得生成TR-SC。",
    "数据采集仅指主动从传感器、采集通道或明确外部数据源获取并验证采集结果；接收广播/报文/应答归4.3，从SRAM/文件/缓存/内部变量读取业务输入、接收后暂存、定时读取和调度组帧均不成立。",
    "数据转换仅保留单位、量纲、基础编码、数值格式和标准化等独立通用预处理；坐标系、姿态矩阵、角度修正、指向、相位、控制码及任务核心算法归4.1，协议解析、字段提取、组帧/解帧和包头处理归4.3，不得以业务表示转换为理由。",
    "数据剔除仅保留业务处理前对重复、过期、异常测量样本的质量清洗；数值范围/上下限/端点归4.6，状态字/定位标志/帧字段/协议合法性归4.3，超界触发业务状态或控制动作归4.1或4.6。",
    "数据融合仅保留多个独立数据源形成综合测量结果；核心姿态、轨道、导航或控制算法归4.1。数据解释仅保留通用质量状态、告警或派生信息；核心任务判决和控制状态机归4.1。",
    "时间广播同步、状态维护和周期组帧；GNSS/姿态广播接收、解析和暂存；坐标/姿态/指向/限位/相位/遥控码计算；经纬高或位置速度范围判断；定位标志和状态字合法性；上注包保存SRAM并定时读取，均不生成TR-SC。",
    "遥测采样只有在采集来源、主动采集动作和采集结果均明确时才可归数据采集。复合语句删除接口、边界或核心功能部分后若不再形成独立通用预处理链路，则整项不生成。普通排除项直接忽略，只有决定分类的关键原文缺失或证据冲突才写open_questions。",
    "不得读取DOCX、硬件接口报告、源码或其他分析JSON；不得生成TR-SC、最终JSON或DOCX；不得拆分批次。",
    "TR需求描述不得保留“见表xxx”“详见表xxx”“按表xxx”等孤立引用；应写出来源明确的数据处理规则和结果。此项仅为prompt生成质量要求，不进行代码正则硬校验。",
    `<matrix_worker_payload>${JSON.stringify({ source_artifacts_path: sourcePath, output_path: outputPath })}</matrix_worker_payload>`,
  ].join("\n")
}

export async function prepareDataProcessingTestContent(ctx: ToolContext): Promise<string> {
  const prerequisite = pathOf(ctx, ".matrix/data/functional-test-content.json")
  const sourcePath = pathOf(ctx, ".matrix/data/source-artifacts.json")
  const rawPath = pathOf(ctx, ".matrix/data/data-processing.raw.json")
  const finalPath = pathOf(ctx, ".matrix/data/data-processing-test-content.json")
  const gapsPath = pathOf(ctx, ".matrix/data/data-processing-test-content-gaps.json")
  const reportPath = pathOf(ctx, ".matrix/reports/data-processing-test-content.docx")

  if (!existsSync(prerequisite)) return JSON.stringify({ error: `File not found: ${prerequisite}`, missing_prerequisite: "functional_test_content" })
  if (!existsSync(sourcePath)) return JSON.stringify({ error: `File not found: ${sourcePath}`, missing_prerequisite: "source_artifacts" })

  const reused = validReusableRaw(rawPath, sourcePath)
  return JSON.stringify({
    ok: true,
    mode: "prepare_data_processing_test_content",
    output: {
      data_processing_test_raw_path: rawPath,
      data_processing_test_content_path: finalPath,
      data_processing_test_gaps_path: gapsPath,
      data_processing_test_report_path: reportPath,
    },
    summary: { worker_count: reused ? 0 : 1, raw_reused: reused },
    ...(reused ? {} : {
      worker: {
        subagent_type: "data-processing-test-content-modeler",
        output_path: rawPath,
        worker_payload: { source_artifacts_path: sourcePath, output_path: rawPath },
        worker_prompt: workerPrompt(sourcePath, rawPath),
      },
    }),
  }, null, 2)
}

export async function finalizeDataProcessingTestContent(ctx: ToolContext): Promise<string> {
  const sourcePath = pathOf(ctx, ".matrix/data/source-artifacts.json")
  const rawPath = pathOf(ctx, ".matrix/data/data-processing.raw.json")
  const finalPath = pathOf(ctx, ".matrix/data/data-processing-test-content.json")
  const gapsPath = pathOf(ctx, ".matrix/data/data-processing-test-content-gaps.json")
  const reportPath = pathOf(ctx, ".matrix/reports/data-processing-test-content.docx")
  if (!existsSync(sourcePath)) return JSON.stringify({ error: `File not found: ${sourcePath}` })
  if (!existsSync(rawPath)) return JSON.stringify({ error: `File not found: ${rawPath}` })

  const bundle = loadPhase2SourceBundle(sourcePath)
  const raw = trackRaw(DataProcessingTestRaw.parse(readPhase2Json(rawPath)), rawPath)
  const seen = new Set<string>()
  const normalizedRows = raw.rows.map((row, index) => ({ ...row, source_refs: normalizeAndValidateSourceRefs(row.source_refs, bundle, `data-processing.rows[${index}]`) })).filter((row) => {
    const key = `${row.data_processing_requirement_description}|${row.related_description}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const rows: DataProcessingTestTableRow[] = assignStableRequirementIds(normalizedRows, "TR-SC")
  const gaps = [...new Set([...raw.open_questions, ...phase2Warnings()].map(question => question.trim()).filter(Boolean))].map((question) => ({ question }))
  const model = DataProcessingTestContent.parse({
    version: "2.0",
    chapter_title_no: "4.7",
    chapter_title: "数据处理测试",
    section_title_no: "4.7.1",
    section_title: "数据处理需求项[TR-SC]",
    source_artifacts_path: sourcePath,
    rows,
    test_requirements: { sufficiency: "C1、C2", termination: "Z1、Z2", priority: "高优先级" },
    summary: { total: rows.length, gap_count: gaps.length },
  })
  const gapModel = DataProcessingTestGaps.parse({ version: "1.0", gaps, summary: { total: gaps.length } })

  mkdirSync(dirname(finalPath), { recursive: true })
  mkdirSync(dirname(reportPath), { recursive: true })
  carryOrigins(rows, model.rows)
  carryOrigins({ ...raw, rows: undefined }, model)

  writeFileSync(finalPath, JSON.stringify(model, null, 2), "utf-8")
  writeFileSync(gapsPath, JSON.stringify(gapModel, null, 2), "utf-8")
  writeFileSync(reportPath, renderDataProcessingTestContentDocx(model))
  publishEditMapping(finalPath, model)
  return JSON.stringify({
    ok: true,
    mode: "finalize_data_processing_test_content",
    output: {
      data_processing_test_content_path: finalPath,
      data_processing_test_gaps_path: gapsPath,
      data_processing_test_report_path: reportPath,
    },
    summary: model.summary,
  }, null, 2)
}
