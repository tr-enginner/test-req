import { trackRaw, carryOrigins, publishEditMapping } from "../shared/phase2-edit-mapping"
import { phase2Warnings, phase2Warning } from "../shared/phase2-tolerance"
import { readPhase2Json } from "../shared/phase2-json"
import type { ToolContext } from "@opencode-ai/plugin"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, resolve } from "path"
import { Chapter2SystemOverviewRawSchema, Chapter2SystemOverviewSchema, type Chapter2SystemOverview } from "../schema/chapter2-system-overview"
import { renderChapter2SystemOverviewDocx } from "./chapter2-system-overview-docx"
import { loadPhase2SourceBundle, normalizeAndValidateSourceRefs } from "./phase2-source-bundle"
import { PHASE2_CHAPTER_SOURCE_REFS_GUIDANCE } from "../shared/phase2-source-ref-guidance"

const artifact = (ctx: ToolContext, fallback: string) => resolve(ctx.directory, fallback)
const readJson = (path: string): unknown => readPhase2Json(path)
const writeJson = (path: string, value: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 2) + "\n") }
const unique = (values: string[]) => [...new Set(values.map((value) => value.trim()).filter(Boolean))]

function normalize(raw: unknown, sourceArtifactsPath: string): Chapter2SystemOverview {
  const parsed = Chapter2SystemOverviewRawSchema.safeParse(JSON.parse(JSON.stringify(raw)))
  if (!parsed.success) throw new Error(`invalid chapter2 system overview raw artifact; rerun chapter2-system-overview-modeler: ${parsed.error.message}`)
  const model = carryOrigins(raw, parsed.data)
  const bundle = loadPhase2SourceBundle(sourceArtifactsPath)
  const warnings = [...model.warnings]
  const evidenceFields = ["system_relationship", "processor_type", "processor_frequency", "memory_io_summary", "software_name_and_id", "programming_language", "developer_unit_name", "subsystem_and_software_functions", "development_platform", "compilation_environment"]
  for (const field of evidenceFields) {
    const value = field === "subsystem_and_software_functions" ? model.subsystem_and_software_functions.join("") : String(model[field as keyof typeof model] ?? "")
    if (!value.trim()) warnings.push(`未识别到${field}，按空值渲染`)
  }
  if (!model.interrupts.length) warnings.push("未从源文档识别到中断信息，保留空中断表")
  const normalized = {
    ...model,
    memory_io_tables: model.memory_io_tables.filter((table, index) => {
      const columns = table.columns.map(column => column.trim())
      const valid = columns.length > 0 && columns.every(Boolean) && new Set(columns).size === columns.length && table.rows.every(row => row.length === columns.length)
      if (!valid) { warnings.push(`跳过无法渲染的存储器表格 ${index + 1}`); phase2Warning(warnings.at(-1)!, 1) }
      return valid
    }),
    version: "2.0",
    source_artifacts_path: sourceArtifactsPath,
    source_refs: normalizeAndValidateSourceRefs(model.source_refs, bundle, "chapter2"),
    system_relationship: model.system_relationship.trim(),
    processor_type: model.processor_type.trim(),
    processor_frequency: model.processor_frequency.trim(),
    memory_io_summary: model.memory_io_summary.trim(),
    software_name_and_id: model.software_name_and_id.trim(),
    programming_language: model.programming_language.trim(),
    developer_unit_name: model.developer_unit_name.trim(),
    subsystem_and_software_functions: unique(model.subsystem_and_software_functions),
    development_platform: model.development_platform.trim(),
    compilation_environment: model.compilation_environment.trim(),
    warnings: unique([...warnings, ...phase2Warnings()]),
  }
  return carryOrigins(normalized, Chapter2SystemOverviewSchema.parse(JSON.parse(JSON.stringify(normalized))))
}

function reusable(rawPath: string): boolean {
  if (!existsSync(rawPath)) return false
  try {
    Chapter2SystemOverviewRawSchema.parse(readJson(rawPath))
    return true
  } catch { return false }
}

export async function prepareChapter2SystemOverview(ctx: ToolContext): Promise<string> {
  const inputs = {
    source_artifacts_path: artifact(ctx, ".matrix/data/source-artifacts.json"),
    source_plan_path: artifact(ctx, ".matrix/data/source-plan.json"),
  }
  const missing = Object.entries(inputs).filter(([, path]) => !existsSync(path)).map(([name, path]) => ({ name, path }))
  if (missing.length) return JSON.stringify({ ok: false, mode: "prepare_chapter2_system_overview", error: "missing_inputs", missing }, null, 2)
  const outputPath = artifact(ctx, ".matrix/data/chapter2-system-overview.raw.json")
  const rawReused = reusable(outputPath)
  const payload = { worker_type: "chapter2-system-overview-modeler", ...inputs, output_path: outputPath }
  return JSON.stringify({
    ok: true,
    mode: "prepare_chapter2_system_overview",
    output: { chapter2_system_overview_raw_path: outputPath },
    summary: { raw_reused: rawReused },
    ...(rawReused ? {} : {
      subagent_type: "chapter2-system-overview-modeler",
      worker_payload: payload,
      worker_prompt: `Use $test-requirement-chapter2 and write the requested raw JSON.\n${PHASE2_CHAPTER_SOURCE_REFS_GUIDANCE}\n顶层不得输出evidence字段，字段来源统一由source_refs表达。\nmemory_io_summary必须是单个JSON字符串（string），即使有多种存储器也合并成一段文字，禁止数组、对象或null；正确示例："程序存储器（128 KB），地址空间：00000000H~0001FFFFH，用于存放程序；SRAM（容量未说明），地址空间：XXXXH~XXXXH，用于运行数据。"，错误示例：["程序存储器", "SRAM"]。memory_io_summary只写存储器名称或类型、容量、地址空间和用途，不得写CPU、总线控制器、A/D、GPIO、并行数据口或其他芯片外设；每种存储器必须写地址空间，例如00000000H~0001FFFFH，源文档未给出时固定写XXXXH~XXXXH，不得猜测。\nsoftware_name_and_id必须是单个JSON字符串（string），固定写成“<型号或项目代号><软件全称>(<软件标识号>)”，型号与软件全称之间不加空格，标识号使用半角括号；正确示例必须参考“XHDZ-0000755配电器下位机软件(R/JBVO1-8A(F2)/00-2.00)”。标识号内部原有括号、斜杠、连字符和版本号保持来源原文。任一组成部分无法确认时只把该部分写XXX并在warnings说明：缺型号为“XXX配电器下位机软件(R/...)”，缺名称为“XHDZ-0000755XXX(R/...)”，缺标识为“XHDZ-0000755配电器下位机软件(XXX)”，全部不确定为“XXXXXX(XXX)”。禁止输出“软件名称（型号）”、仅软件名称、仅标识号、对象、数组或null。Chapter 1与Chapter 2必须使用相同来源优先级和拼接规则。\ndevelopment_platform与compilation_environment不得重复：前者只写宿主操作系统、IDE或开发平台；后者只写编译器/工具链名称、版本和编译配置，不得包含编程语言、操作系统、烧录/下载/调试工具或其他辅助内容。组合描述必须拆分且每条信息只放一个字段；无法可靠拆分时放入最匹配字段，另一字段留空并写warnings。\nsubsystem_and_software_functions必须以primary需求规格document structure中的功能标题树为唯一依据：定位功能需求根节点，按其直接主要功能子节点的原始文档顺序逐字提取，不得重新分类、概括、合并或遗漏。输出时必须去除标题开头的章节结构编号及分隔符，并去除标题末尾括号中的SR、SRS或纯章节编号；“3.2.1.2 总线通信（SR3.2.1.2）”必须输出“总线通信”。只清理结构编号，不得删除“1553B总线通信”“CAN1接口处理”“模块保护功能1”等业务数字或型号；清理后为空则跳过并写warnings。第一项必须是初始化功能；源功能标题树存在初始化标题时将清理编号后的标题移到第一项且其他标题保持相对顺序，不存在时在第一项补充“初始化功能”。字段必须是字符串数组。\n写文件前必须确认typeof memory_io_summary === "string"且typeof software_name_and_id === "string"。\n<matrix_worker_payload>\n${JSON.stringify(payload, null, 2)}\n</matrix_worker_payload>`,
    }),
  }, null, 2)
}

export async function finalizeChapter2SystemOverview(ctx: ToolContext): Promise<string> {
  const rawPath = artifact(ctx, ".matrix/data/chapter2-system-overview.raw.json")
  const sourcePath = artifact(ctx, ".matrix/data/source-artifacts.json")
  if (!existsSync(rawPath) || !existsSync(sourcePath)) return JSON.stringify({ ok: false, mode: "finalize_chapter2_system_overview", error: "missing_inputs", missing: [rawPath, sourcePath].filter((p) => !existsSync(p)) }, null, 2)
  try {
    const model = normalize(trackRaw(readJson(rawPath), rawPath), sourcePath)
    const outputPath = artifact(ctx, ".matrix/data/chapter2-system-overview.json")
    const reportPath = artifact(ctx, ".matrix/reports/chapter2-system-overview.docx")
    writeJson(outputPath, model)
    mkdirSync(dirname(reportPath), { recursive: true })
    writeFileSync(reportPath, renderChapter2SystemOverviewDocx(model))
    publishEditMapping(outputPath, model)
    return JSON.stringify({ ok: true, mode: "finalize_chapter2_system_overview", output: { chapter2_system_overview_path: outputPath, chapter2_system_overview_report_path: reportPath }, summary: { memory_table_count: model.memory_io_tables.length, interrupt_count: model.interrupts.length, warning_count: model.warnings.length } }, null, 2)
  } catch (error) {
    return JSON.stringify({ ok: false, mode: "finalize_chapter2_system_overview", error: error instanceof Error ? error.message : String(error) }, null, 2)
  }
}
