import { trackRaw, carryOrigins, publishEditMapping } from "../shared/phase2-edit-mapping"
import { readPhase2Json } from "../shared/phase2-json"
import { assignStableRequirementIds } from "../shared/phase2-stable-ids"
import { phase2Warnings, reservedPhase2Ids } from "../shared/phase2-tolerance"
import type { ToolContext } from "@opencode-ai/plugin"
import { createHash } from "crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, join, resolve } from "path"
import {
  InterfaceTestBatchRaw,
  InterfaceTestContent,
  InterfaceTestGaps,
  InterfaceTestIdentifierDiscovery,
  InterfaceTestPlan,
  type InterfaceTestBatchTarget,
} from "../schema/interface-test-content"
import { renderInterfaceTestContentDocx } from "./interface-test-content-docx"
import { loadPhase2SourceBundle, normalizeAndValidateSourceRefs } from "./phase2-source-bundle"
import { PHASE2_REQUIREMENT_SOURCE_REFS_GUIDANCE } from "../shared/phase2-source-ref-guidance"

function baseDir(ctx: ToolContext): string {
  return resolve(ctx.directory || ctx.worktree || process.cwd())
}

function pathOf(ctx: ToolContext, relativePath: string): string {
  return join(baseDir(ctx), relativePath)
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

function safeName(value: string): string {
  const ascii = value.normalize("NFKD").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase()
  return ascii || hashText(value).slice(0, 12)
}

function normalizeInterfaceName(value: string): string {
  return value
    .replace(/^\s*\d+(?:\.\d+)*\s*/, "")
    .replace(/\s*及相关数据流\s*$/, "")
    .trim()
}

function workerPrompt(payload: Record<string, unknown>): string {
  return [
    PHASE2_REQUIREMENT_SOURCE_REFS_GUIDANCE,
    "硬件接口派生文本只能帮助组织内容，source_refs仍必须回到原始source bundle。",
    "必须使用 $interface-test-requirements，只为 target_interface_batch 生成一个4.3接口测试raw批次。",
    "必须读取 source_artifacts_path引用的structure和hardware_interface_report_text_path；正文使用section.text，表格使用tables[].table_html；每行必须输出包含primary引用的source_refs。",
    "对每个接口事务成对提取正常与异常行为；请求—应答类正文只写收到符合请求表格式的请求时按应答表返回什么，以及收到哪些明确错误字段/异常类型时如何错误应答、不应答或丢弃。两侧均有证据时合并在同一row，不得写接收后的业务执行、解析暂存、计算、模式切换、内部状态或存储。",
    "写row前核对interface_requirement_description与related_description范围一致：正常+异常证据使用“接口正常/异常（明确字段）情况的测试”；只有正常证据只写“接口正常情况的测试”并在open_questions记录异常条件或响应缺口；只有异常证据只写“接口异常（明确字段）情况的测试”。",
    "异常字段、无效条件和外部可观察响应必须来自两份输入原文；不得用协议常识补写丢弃、不应答或错误应答。内部错误计数和日志不写入正文，除非原文明确将其编码为对外应答内容。",
    "hardware_interface_report_text_path中的第三章硬件接口表格是数据帧格式的唯一展示位置。请求—应答类接口TR必须引用请求与应答的真实明确表号；单向输出引用发送消息的真实明确表号。不得复制Byte/W字节位置、逐字节布局、固定值、取值范围、位域、字段编码、数据区完整定义、字段含义、完整帧结构或表格已承载的帧长度和字段清单。",
    "异常行为可保留直接参与合法性校验的字段名称（如ID、LENGTH、SUM），但不得重新展开其位置和值。请求与响应使用不同格式表时分别引用各自表号，不得拼接两张表内容。找不到表号时保留证据充分的接口行为，并在open_questions写明接口、消息、缺失表号及已搜索关键词；不得编造表号或复制格式替代。",
    "写rows前必须在同一interface_id内按通信方向和双方、正常应答、错误字段集合及错误应答建立合并签名并分组；内部业务处理、错误计数、日志或状态差异不参与拆分。不得用“相关字段”“格式错误”“异常情况”省略原文明示的错误类型。",
    "快帧遥测与慢帧遥测等单向输出处理族只生成一行：列出消息名称、接收方及各自第三章格式表号，不补造应答、周期或接收后的处理。合并source_refs按首次出现顺序去重；多个显式来源TR号用“、”连接；全部为接口派生项时只写一个AUTO_TR_JK。不得先按消息名生成多行后依赖finalize文本去重。",
    "不得分配全局TR-JK，不得生成最终JSON或DOCX。",
    `<matrix_worker_payload>${JSON.stringify(payload)}</matrix_worker_payload>`,
  ].join("\n")
}

function identifierDiscoveryPrompt(hardwareInterfaceTextPath: string, outputPath: string): string {
  const payload = { hardware_interface_report_text_path: hardwareInterfaceTextPath, output_path: outputPath }
  return [
    "只分析hardware_interface_report_text_path中的第3.1章硬件接口，识别全部明确接口标识。",
    "同一接口标识只输出一次；不要生成接口测试需求正文。",
    `<matrix_worker_payload>${JSON.stringify(payload)}</matrix_worker_payload>`,
  ].join("\n")
}

type InterfaceWorkerBatch = {
  subagent_type: "interface-test-content-modeler"
  output_path: string
  worker_payload: Record<string, any>
  worker_prompt: string
}

type InterfaceWorkerManifest = {
  schema_version: 1
  interface_test_plan_path: string
  worker_batches: InterfaceWorkerBatch[]
}

function workerManifestPath(ctx: ToolContext) {
  return pathOf(ctx, ".matrix/data/interface-test-worker-manifest.json")
}

function targetsFromIdentifierDiscovery(discovery: ReturnType<typeof InterfaceTestIdentifierDiscovery.parse>): InterfaceTestBatchTarget[] {
  const seen = new Set<string>()
  return [...discovery.interfaces]
    .sort((a, b) => a.order - b.order)
    .filter((item) => {
      if (seen.has(item.interface_id)) return false
      seen.add(item.interface_id)
      return true
    })
    .map((item, order) => {
      return {
        batch_id: item.interface_id,
        order,
        interface_name: normalizeInterfaceName(item.interface_name),
        interface_id: item.interface_id,
        topic: item.section_titles.join("；"),
        directions: ["bidirectional"] as Array<"send" | "receive" | "bidirectional">,
        hardware_keywords: Array.from(new Set([item.interface_id, item.interface_name, ...item.section_titles])),
        functional_keywords: Array.from(new Set([item.interface_name, ...item.section_titles])),
      }
    })
}

function validReusableRaw(path: string): boolean {
  if (!existsSync(path)) return false
  try {
    InterfaceTestBatchRaw.parse(readPhase2Json(path))
    return true
  } catch {
    return false
  }
}

function readReusableIdentifierDiscovery(path: string): ReturnType<typeof InterfaceTestIdentifierDiscovery.parse> | null {
  if (!existsSync(path)) return null
  try {
    return InterfaceTestIdentifierDiscovery.parse(readPhase2Json(path))
  } catch {
    return null
  }
}

export async function prepareInterfaceTestContent(ctx: ToolContext): Promise<string> {
  const functionalTestPath = pathOf(ctx, ".matrix/data/functional-test-content.json")
  const sourceArtifactsPath = pathOf(ctx, ".matrix/data/source-artifacts.json")
  const hardwareTextPath = pathOf(ctx, ".matrix/data/hardware-interface-report-text.md")
  const planPath = pathOf(ctx, ".matrix/data/interface-test-plan.json")
  const identifierDiscoveryPath = pathOf(ctx, ".matrix/data/interface-test-identifiers.json")
  const rawDir = pathOf(ctx, ".matrix/data/interface-test-content-batches")
  const finalPath = pathOf(ctx, ".matrix/data/interface-test-content.json")
  const gapsPath = pathOf(ctx, ".matrix/data/interface-test-content-gaps.json")
  const reportPath = pathOf(ctx, ".matrix/reports/interface-test-content.docx")

  for (const [path, prerequisite] of [
    [functionalTestPath, "functional_test_content"], [sourceArtifactsPath, "source_artifacts"], [hardwareTextPath, "hardware_interface_report_text"],
  ] as const) {
    if (!existsSync(path)) return JSON.stringify({ error: `File not found: ${path}`, missing_prerequisite: prerequisite })
  }

  loadPhase2SourceBundle(sourceArtifactsPath)
  const reusableDiscovery = readReusableIdentifierDiscovery(identifierDiscoveryPath)
  if (!reusableDiscovery) {
    return JSON.stringify({
      ok: true,
      mode: "prepare_interface_test_content",
      awaiting_interface_identifier_discovery: true,
      interface_identifier_discovery_batch: {
        subagent_type: "interface-test-identifier-discoverer",
        output_path: identifierDiscoveryPath,
        worker_payload: { hardware_interface_report_text_path: hardwareTextPath, output_path: identifierDiscoveryPath },
        worker_prompt: identifierDiscoveryPrompt(hardwareTextPath, identifierDiscoveryPath),
      },
      output: { interface_test_identifier_discovery_path: identifierDiscoveryPath },
    }, null, 2)
  }
  const discovery = reusableDiscovery
  const batches = targetsFromIdentifierDiscovery(discovery)

  mkdirSync(rawDir, { recursive: true })
  const allBatches = batches.map((target, index) => {
    const outputPath = join(rawDir, `${String(index + 1).padStart(3, "0")}-${safeName(target.batch_id)}.raw.json`)
    const targetInterfaceBatch = {
      batch_id: target.batch_id,
      order: target.order,
      interface_name: target.interface_name,
      interface_id: target.interface_id,
      topic: target.topic,
      hardware_keywords: target.hardware_keywords,
      functional_keywords: target.functional_keywords,
    }
    const payload = {
      worker_type: "interface-test-content-modeler",
      source_artifacts_path: sourceArtifactsPath,
      hardware_interface_report_text_path: hardwareTextPath,
      target_interface_batch: targetInterfaceBatch,
      output_path: outputPath,
    }
    return {
      subagent_type: "interface-test-content-modeler" as const,
      output_path: outputPath,
      worker_payload: payload,
      worker_prompt: workerPrompt(payload),
      reusable: validReusableRaw(outputPath),
    }
  })
  const reusedBatchIds = allBatches.filter((batch) => batch.reusable).map((batch) => batch.worker_payload.target_interface_batch.batch_id)
  const plan = InterfaceTestPlan.parse({
    version: "2.2", source_artifacts_path: sourceArtifactsPath, hardware_interface_report_text_path: hardwareTextPath,
    functional_test_content_path: functionalTestPath, batches, reused_batch_ids: reusedBatchIds,
  })
  mkdirSync(dirname(planPath), { recursive: true })
  writeFileSync(planPath, JSON.stringify(plan, null, 2), "utf-8")
  const pendingBatches: InterfaceWorkerBatch[] = allBatches
    .filter((batch) => !batch.reusable)
    .map(({ reusable: _reusable, ...batch }) => batch)
  const manifestPath = workerManifestPath(ctx)
  writeFileSync(manifestPath, JSON.stringify({
    schema_version: 1,
    interface_test_plan_path: planPath,
    worker_batches: pendingBatches,
  } satisfies InterfaceWorkerManifest, null, 2), "utf-8")
  return JSON.stringify({
    ok: true, mode: "prepare_interface_test_content",
    output: {
      interface_test_plan_path: planPath,
      interface_test_identifier_discovery_path: identifierDiscoveryPath,
      interface_test_raw_paths: allBatches.map((batch) => batch.output_path),
      interface_test_content_path: finalPath,
      interface_test_gaps_path: gapsPath,
      interface_test_report_path: reportPath,
      interface_test_worker_manifest_path: manifestPath,
    },
    summary: { batch_count: allBatches.length, worker_batch_count: allBatches.length - reusedBatchIds.length, reused_batch_count: reusedBatchIds.length },
    worker_batches: pendingBatches.map((batch, index) => ({
      batch_index: index + 1,
      interface_id: batch.worker_payload.target_interface_batch.interface_id,
      interface_name: batch.worker_payload.target_interface_batch.interface_name,
      output_path: batch.output_path,
    })),
  }, null, 2)
}

export async function getInterfaceTestWorkerBatch(batchIndex: number | undefined, ctx: ToolContext): Promise<string> {
  const manifestPath = workerManifestPath(ctx)
  if (!Number.isInteger(batchIndex) || (batchIndex as number) < 1) return JSON.stringify({ error: "interface_test_worker_batch_index must be a positive integer." })
  if (!existsSync(manifestPath)) return JSON.stringify({ error: `File not found: ${manifestPath}; rerun prepare_interface_test_content.` })
  try {
    const manifest = readPhase2Json(manifestPath) as InterfaceWorkerManifest
    if (manifest.schema_version !== 1 || !Array.isArray(manifest.worker_batches)) throw new Error("invalid worker manifest schema")
    const batch = manifest.worker_batches[(batchIndex as number) - 1]
    if (!batch) throw new Error(`batch index ${batchIndex} is out of range; manifest contains ${manifest.worker_batches.length} pending batches`)
    return JSON.stringify({ ok: true, mode: "get_interface_test_worker_batch", batch_index: batchIndex, worker_batch_count: manifest.worker_batches.length, worker_batch: batch }, null, 2)
  } catch (error) {
    return JSON.stringify({ error: `${manifestPath}: ${error instanceof Error ? error.message : String(error)}; rerun prepare_interface_test_content.` })
  }
}

export async function finalizeInterfaceTestContent(ctx: ToolContext): Promise<string> {
  const planPath = pathOf(ctx, ".matrix/data/interface-test-plan.json")
  const finalPath = pathOf(ctx, ".matrix/data/interface-test-content.json")
  const gapsPath = pathOf(ctx, ".matrix/data/interface-test-content-gaps.json")
  const reportPath = pathOf(ctx, ".matrix/reports/interface-test-content.docx")
  if (!existsSync(planPath)) return JSON.stringify({ error: `File not found: ${planPath}` })
  const plan = InterfaceTestPlan.parse(readPhase2Json(planPath))
  const sourceBundle = loadPhase2SourceBundle(plan.source_artifacts_path)
  const rawPaths: string[] = plan.batches.map((batch, index) => join(baseDir(ctx), ".matrix/data/interface-test-content-batches", `${String(index + 1).padStart(3, "0")}-${safeName(batch.batch_id)}.raw.json`))
  if (rawPaths.length !== plan.batches.length) return JSON.stringify({ error: `Expected ${plan.batches.length} raw batch paths, got ${rawPaths.length}.` })

  const parsed = rawPaths.map((path, index) => {
    if (!existsSync(path)) throw new Error(`interface_test_raw_paths[${index}]: File not found: ${path}`)
    let raw: ReturnType<typeof InterfaceTestBatchRaw.parse>
    try {
      raw = trackRaw(InterfaceTestBatchRaw.parse(readPhase2Json(path)), path)
    } catch (error) {
      throw new Error(`${path}: invalid interface test raw artifact: ${error instanceof Error ? error.message : String(error)}`)
    }
    const target = plan.batches[index]
    raw = { ...raw, batch_id: target.batch_id, interface_name: target.interface_name, interface_id: target.interface_id,
      rows: raw.rows.map(row => ({ ...row, interface_name: target.interface_name, interface_id: target.interface_id })) }
    return { raw, target, rawPath: path }
  })

  const gaps: Array<{ batch_id: string; topic: string; interface_name: string; questions: string[] }> = []
  const accepted: Array<{ row: ReturnType<typeof InterfaceTestBatchRaw.parse>["rows"][number]; target: InterfaceTestBatchTarget; rowOrder: number; rawPath: string }> = []
  for (const { raw, target, rawPath } of parsed) {
    raw.open_questions = raw.open_questions.map(question => question.trim()).filter(Boolean)
    if (raw.open_questions.length) gaps.push({ batch_id: raw.batch_id, topic: target.topic, interface_name: target.interface_name, questions: raw.open_questions })
    for (const [rowOrder, row] of raw.rows.entries()) {
      if (row.interface_name !== target.interface_name || row.interface_id !== target.interface_id) {
        throw new Error(`${rawPath}: table row interface_name/interface_id must match interface-test-plan.json.`)
      }
      accepted.push({ row, target, rowOrder, rawPath })
    }
  }

  accepted.sort((a, b) => a.target.order - b.target.order || a.rowOrder - b.rowOrder)
  const unique = accepted.filter((entry, index) => {
    const key = `${entry.row.interface_id}|${entry.row.interface_requirement_description}|${entry.row.related_description}`
    return accepted.findIndex((other) => `${other.row.interface_id}|${other.row.interface_requirement_description}|${other.row.related_description}` === key) === index
  })
  const usedIds = new Set(reservedPhase2Ids())
  const preserved = new Map<number, string>()
  unique.forEach(({ row }, index) => {
    const id = row.test_requirement_id.trim()
    if (/^TR-[A-Z0-9]+(?:-[A-Z0-9]+)*-\d+(?:、TR-[A-Z0-9]+(?:-[A-Z0-9]+)*-\d+)*$/.test(id) && !usedIds.has(id)) {
      preserved.set(index, id)
      usedIds.add(id)
    }
  })
  const allocated = assignStableRequirementIds(unique.filter((_, index) => !preserved.has(index)).map(() => ({})), "TR-JK", [...usedIds])
  let allocationIndex = 0
  const rows = unique.map(({ row, rawPath }, index) => {
    const requirementId = preserved.get(index) || allocated[allocationIndex++].requirement_id
    return {
      ...row,
      interface_requirement_description: row.interface_requirement_description,
      test_requirement_id: requirementId,
      source_refs: normalizeAndValidateSourceRefs(row.source_refs, sourceBundle, `${rawPath}: interface.rows[${index}]`),
      related_description: row.related_description,
      interface_name: row.interface_name,
      interface_id: row.interface_id,
    }
  })
  if (phase2Warnings().length) gaps.push({ batch_id: "finalize", topic: "归一化警告", interface_name: "接口测试", questions: phase2Warnings() })
  const gapsArtifact = InterfaceTestGaps.parse({ version: "1.0", gaps, summary: { total: gaps.length } })
  const model = InterfaceTestContent.parse({
    version: "2.0", chapter_title_no: "4.3", chapter_title: "接口测试", section_title_no: "4.3.1", section_title: "接口需求项[TR-JK]",
    source_paths: { source_artifacts_path: plan.source_artifacts_path, hardware_interface_report_text_path: plan.hardware_interface_report_text_path, functional_test_content_path: plan.functional_test_content_path },
    source_hashes: {
      hardware_interface_hash: hashText(readFileSync(plan.hardware_interface_report_text_path, "utf-8")),
      plan_hash: hashText(JSON.stringify(plan.batches)),
    },
    rows, test_requirements: { sufficiency: "C1、C2", termination: "Z1、Z2", priority: "高优先级" },
    summary: { total: rows.length, gap_count: gaps.length, reused_batch_count: plan.reused_batch_ids.length },
  })
  carryOrigins(rows, model.rows)
  mkdirSync(dirname(finalPath), { recursive: true }); mkdirSync(dirname(reportPath), { recursive: true })
  writeFileSync(finalPath, JSON.stringify(model, null, 2), "utf-8")
  writeFileSync(gapsPath, JSON.stringify(gapsArtifact, null, 2), "utf-8")
  writeFileSync(reportPath, renderInterfaceTestContentDocx(model))
  publishEditMapping(finalPath, model)
  return JSON.stringify({ ok: true, mode: "finalize_interface_test_content", output: { interface_test_content_path: finalPath, interface_test_gaps_path: gapsPath, interface_test_report_path: reportPath }, summary: model.summary }, null, 2)
}
