import { tool, type ToolContext, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "fs"
import { dirname, join } from "path"
import { DATA_DIR } from "../shared/constants"

/**
 * Phase 6 worker 专用分段落盘工具。
 *
 * 演进史:
 * - 2026-08-20:契约曾指示 "Write 工具" 落盘大 JSON——大写 Write 即 invalid,大参数频发
 *   序列化失败,退路全被禁后 worker 走"脑内超长单流",经网关断流卡死。→ 首版分段追加:
 *   首段 [、末段 ]、total_chunks 预估、收齐自动拼装。
 * - 2026-08-21:首版协议把簿记压给 LLM 引发新事故(TR-JK 组):total_chunks 预估 36 实际
 *   30 → worker 被迫编造填充用例凑段数,并手工管理跨段 [/,/] 标点 → 推理螺旋 + 大 content
 *   断流。→ v2 免结构化协议:**每段 = 一个完整用例对象**(逐段即时校验,零跨段标点),
 *   **finish 显式收尾**(零总量预估),数组拼装由工具负责。v2 首次写入时自动清空旧格式
 *   残留段(首版拼接片段与新协议不兼容)。
 * - 2026-09-21:单个用例达180步时，“一用例=一content”仍会迫使 worker 绕道 /tmp + Read。
 *   新增大用例增量模式:case_metadata -> step_batch(≤20步) -> finish_case，全部中间状态只在
 *   工作区 .matrix/tmp/worker-output/ 内由工具管理，不需要模型创建或回读临时 JSON。
 */

const CHUNK_DIR = join(".matrix", "tmp", "worker-output")
const V2_FLAG = "format_v2.flag"
const CASE_BUILD_PATTERN = /^case_(\d+)$/
const CASE_METADATA_FILE = "metadata.json"
const STEP_BATCH_PATTERN = /^steps_(\d+)\.json$/

function getBaseDirectory(ctx?: ToolContext): string {
  const candidates = [ctx?.directory, ctx?.worktree, process.cwd()]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
  return candidates[0] || process.cwd()
}

function safeSegmentId(requirementId: string): string {
  return requirementId.replace(/[^\w.-]+/g, "_").slice(0, 120) || "requirement"
}

/** 宽容提取:去掉可选的 ```/```json 围栏后返回待解析文本。 */
function stripFences(text: string): string {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
  return fenced ? fenced[1].trim() : trimmed
}

function parseChunkObject(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripFences(text))
  } catch (error) {
    return { ok: false, error: String(error) }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "顶层不是 JSON 对象(每段 content 必须是一个完整用例对象,不是数组/字符串/数字)" }
  }
  return { ok: true, value: parsed as Record<string, unknown> }
}

function parseCaseMetadata(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const parsed = parseChunkObject(text)
  if (!parsed.ok) return parsed
  if ("test_step" in parsed.value) {
    return { ok: false, error: "case_metadata 只包含用例元数据，不得包含 test_step；步骤请通过 step_batch 分批追加" }
  }
  const name = parsed.value.test_case_name ?? parsed.value.case_name
  if (typeof name !== "string" || name.trim().length === 0) {
    return { ok: false, error: "case_metadata 缺少非空 test_case_name/case_name" }
  }
  return parsed
}

function parseStepBatch(text: string): { ok: true; value: Record<string, unknown>[] } | { ok: false; error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripFences(text))
  } catch (error) {
    return { ok: false, error: String(error) }
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { ok: false, error: "step_batch 必须是非空 JSON 数组" }
  }
  if (parsed.length > 20) {
    return { ok: false, error: `step_batch 每批最多 20 步，当前 ${parsed.length} 步` }
  }
  for (const [index, step] of parsed.entries()) {
    if (!step || typeof step !== "object" || Array.isArray(step)) {
      return { ok: false, error: `step_batch 第 ${index + 1} 项不是步骤对象` }
    }
    const candidate = step as Record<string, unknown>
    if (typeof candidate["步骤描述"] !== "string" || typeof candidate["预期结果"] !== "string") {
      return { ok: false, error: `step_batch 第 ${index + 1} 项缺少字符串字段“步骤描述”或“预期结果”` }
    }
  }
  return { ok: true, value: parsed as Record<string, unknown>[] }
}

function initializeChunkDir(chunkDir: string): void {
  mkdirSync(chunkDir, { recursive: true })
  if (existsSync(join(chunkDir, V2_FLAG))) return
  for (const entry of readdirSync(chunkDir)) {
    rmSync(join(chunkDir, entry), { recursive: true, force: true })
  }
  writeFileSync(join(chunkDir, V2_FLAG), "v2", "utf-8")
}

function caseBuildDir(chunkDir: string, caseIndex: number): string {
  return join(chunkDir, `case_${caseIndex}`)
}

interface InProgressCaseStatus {
  case_index: number
  case_name: string
  received_step_batches: number[]
  step_count: number
}

function readInProgressCases(chunkDir: string): InProgressCaseStatus[] {
  if (!existsSync(chunkDir)) return []
  const result: InProgressCaseStatus[] = []
  for (const entry of readdirSync(chunkDir)) {
    const caseMatch = entry.match(CASE_BUILD_PATTERN)
    if (!caseMatch) continue
    const caseIndex = Number.parseInt(caseMatch[1], 10)
    const buildDir = join(chunkDir, entry)
    let caseName = "(未写入用例元数据)"
    const metadataFile = join(buildDir, CASE_METADATA_FILE)
    if (existsSync(metadataFile)) {
      const parsed = parseCaseMetadata(readFileSync(metadataFile, "utf-8"))
      if (parsed.ok) {
        const name = parsed.value.test_case_name ?? parsed.value.case_name
        if (typeof name === "string") caseName = name
      }
    }
    const batches: number[] = []
    let stepCount = 0
    for (const child of readdirSync(buildDir)) {
      const batchMatch = child.match(STEP_BATCH_PATTERN)
      if (!batchMatch) continue
      const batchIndex = Number.parseInt(batchMatch[1], 10)
      batches.push(batchIndex)
      const parsed = parseStepBatch(readFileSync(join(buildDir, child), "utf-8"))
      if (parsed.ok) stepCount += parsed.value.length
    }
    batches.sort((a, b) => a - b)
    result.push({
      case_index: caseIndex,
      case_name: caseName,
      received_step_batches: batches,
      step_count: stepCount,
    })
  }
  return result.sort((a, b) => a.case_index - b.case_index)
}

interface ChunkStatus {
  requirement_id: string
  received_chunks: number[]
  case_names: string[]
  unparseable_chunks: number[]
  finalized: boolean
  output_file?: string
  output_file_exists: boolean
  in_progress_cases: InProgressCaseStatus[]
}

function readChunkStatus(projectDir: string, requirementId: string): ChunkStatus {
  const chunkDir = join(projectDir, CHUNK_DIR, safeSegmentId(requirementId))
  const received: number[] = []
  const caseNames: string[] = []
  const unparseable: number[] = []
  if (existsSync(chunkDir) && existsSync(join(chunkDir, V2_FLAG))) {
    for (const entry of readdirSync(chunkDir)) {
      const match = entry.match(/^chunk_(\d+)\.txt$/)
      if (!match) continue
      const index = Number.parseInt(match[1], 10)
      received.push(index)
      const parsed = parseChunkObject(readFileSync(join(chunkDir, entry), "utf-8"))
      if (parsed.ok) {
        const name = parsed.value.test_case_name ?? parsed.value.case_name
        caseNames.push(typeof name === "string" ? name : `(chunk ${index} 无名称字段)`)
      } else {
        unparseable.push(index)
      }
    }
  }
  received.sort((a, b) => a - b)
  const outputFile = join(projectDir, DATA_DIR, `${requirementId}_output.json`)
  return {
    requirement_id: requirementId,
    received_chunks: received,
    case_names: caseNames,
    unparseable_chunks: unparseable,
    finalized: existsSync(outputFile) && !existsSync(chunkDir),
    output_file: outputFile,
    output_file_exists: existsSync(outputFile),
    in_progress_cases: readInProgressCases(chunkDir),
  }
}

/** 截断 vs 格式错误分类:合法顶层 JSON 必以 ] 或 } 收尾,其余即输出中途断流。 */
export function classifyJsonParseError(text: string): { kind: "truncated" | "format"; detail: string } {
  const trimmed = text.trimEnd()
  const size = Buffer.byteLength(text, "utf-8")
  const tail = trimmed.slice(-80)
  const looksTruncated = trimmed.length > 0 && !/[}\]]$/.test(trimmed)
  return {
    kind: looksTruncated ? "truncated" : "format",
    detail: `文件 ${size} 字节,末尾 80 字符:"${tail}"`,
  }
}

function finalizeChunks(projectDir: string, requirementIdText: string): string {
  const chunkDir = join(projectDir, CHUNK_DIR, safeSegmentId(requirementIdText))
  const outputFile = join(projectDir, DATA_DIR, `${requirementIdText}_output.json`)

  // 幂等:已落盘且段目录已清理
  if (existsSync(outputFile) && !existsSync(chunkDir)) {
    let caseCount = -1
    try {
      const existing = JSON.parse(readFileSync(outputFile, "utf-8"))
      if (Array.isArray(existing)) caseCount = existing.length
    } catch {
      // 保留 -1,仅提示
    }
    return JSON.stringify({
      status: "finalized",
      already_finalized: true,
      output_file: outputFile,
      ...(caseCount >= 0 ? { case_count: caseCount } : {}),
    })
  }
  if (!existsSync(chunkDir) || !existsSync(join(chunkDir, V2_FLAG))) {
    return JSON.stringify({
      status: "invalid",
      error: "没有任何已收段,无法收尾。先逐段追加用例对象,再调用 finish。",
      hint: "每段 content = 一个完整用例对象;全部用例发完后调用 finish=true。",
    })
  }

  const inProgressCases = readInProgressCases(chunkDir)
  if (inProgressCases.length > 0) {
    return JSON.stringify({
      status: "invalid",
      error: "仍有未收尾的增量用例，不能执行 suite finish。",
      in_progress_cases: inProgressCases,
      hint: "对每个未完成用例调用 finish_case=true（建议同时传 expected_step_count），再调用 finish=true。",
    })
  }

  const received = readdirSync(chunkDir)
    .map((entry) => entry.match(/^chunk_(\d+)\.txt$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => Number.parseInt(match[1], 10))
    .sort((a, b) => a - b)
  if (received.length === 0) {
    return JSON.stringify({
      status: "invalid",
      error: "没有任何已收段,无法收尾。先逐段追加用例对象,再调用 finish。",
    })
  }

  const objects: Record<string, unknown>[] = []
  for (const index of received) {
    const parsed = parseChunkObject(readFileSync(join(chunkDir, `chunk_${index}.txt`), "utf-8"))
    if (!parsed.ok) {
      return JSON.stringify({
        status: "invalid",
        error: `chunk ${index} 不是合法用例对象(写入后文件内容异常)`,
        parse_error: parsed.error,
        received_chunks: received,
        hint: `重发该段(chunk_index=${index},覆盖写入)后再次 finish。`,
      })
    }
    objects.push(parsed.value)
  }

  const assembled = JSON.stringify(objects, null, 2)
  const tmpFile = `${outputFile}.tmp`
  mkdirSync(dirname(outputFile), { recursive: true })
  writeFileSync(tmpFile, assembled, "utf-8")
  renameSync(tmpFile, outputFile)
  rmSync(chunkDir, { recursive: true, force: true })
  return JSON.stringify({
    status: "finalized",
    output_file: outputFile,
    case_count: objects.length,
    byte_size: Buffer.byteLength(assembled, "utf-8"),
  })
}

export const phase6WorkerOutputAppend: ToolDefinition = tool({
    description:
      "Phase 6 worker 用例落盘:小用例可使用 content 一次提交完整对象;超过 60 步的大用例必须使用" +
      "case_metadata + step_batch(每批最多20步) + finish_case 增量构建。两种方式最终都形成一个用例段。" +
      "全部用例完成后调用 finish=true，工具把已收对象拼装为 JSON 数组并原子写入" +
      " .matrix/data/{requirement_id}_output.json。全流程无需临时文件、Read、Python 或 Bash。" +
      "requirement_id 必须与任务分派时逐字一致。",
    args: {
      requirement_id: tool.schema.string().describe("当前测试需求项 ID,必须与任务分派逐字一致(如 TR-JK-001、TR-JK-002 或 TR-GN-SWRC-001~006)"),
      chunk_index: tool.schema.number().int().min(1).optional()
        .describe("本段序号,从 1 起递增。省略 content 时可不传(纯查询模式)"),
      content: tool.schema.string().optional()
        .describe("小用例通道:一个完整用例对象的 JSON 文本。超过60步时不得使用，改用增量参数"),
      case_index: tool.schema.number().int().min(1).optional()
        .describe("增量大用例的用例序号，从1起"),
      case_metadata: tool.schema.string().optional()
        .describe("增量大用例的元数据 JSON 对象，不得包含 test_step"),
      step_batch_index: tool.schema.number().int().min(1).optional()
        .describe("当前用例的步骤批次序号，从1起，重发相同序号可覆盖"),
      step_batch: tool.schema.string().optional()
        .describe("增量步骤批次:1~20个完整步骤对象的 JSON 数组"),
      finish_case: tool.schema.boolean().optional()
        .describe("收尾当前增量用例，按批次拼装 test_step 并形成用例段"),
      expected_step_count: tool.schema.number().int().min(1).optional()
        .describe("收尾用例时的预期总步数，用于发现丢批/截断"),
      finish: tool.schema.boolean().optional()
        .describe("套件收尾标志:所有用例段已完成后单独置 true，触发拼装校验并落盘"),
    },
    async execute({ requirement_id, chunk_index, content, case_index, case_metadata, step_batch_index, step_batch, finish_case, expected_step_count, finish }, ctx) {
      const projectDir = getBaseDirectory(ctx)
      const requirementIdText = typeof requirement_id === "string" ? requirement_id : ""
      if (!requirementIdText) {
        return JSON.stringify({ error: "必须提供 requirement_id。" })
      }
      const chunkIndex = typeof chunk_index === "number" ? chunk_index : undefined
      const chunkContent = typeof content === "string" ? content : undefined
      const caseIndex = typeof case_index === "number" ? case_index : undefined
      const caseMetadata = typeof case_metadata === "string" ? case_metadata : undefined
      const stepBatchIndex = typeof step_batch_index === "number" ? step_batch_index : undefined
      const stepBatch = typeof step_batch === "string" ? step_batch : undefined
      const finishCaseFlag = finish_case === true
      const expectedStepCount = typeof expected_step_count === "number" ? expected_step_count : undefined
      const finishFlag = finish === true
      const chunkDir = join(projectDir, CHUNK_DIR, safeSegmentId(requirementIdText))

      const usesIncrementalArgs = caseIndex !== undefined
        || caseMetadata !== undefined
        || stepBatchIndex !== undefined
        || stepBatch !== undefined
        || finishCaseFlag
        || expectedStepCount !== undefined

      if (chunkContent !== undefined && usesIncrementalArgs) {
        return JSON.stringify({ error: "content 小用例通道与 case_metadata/step_batch 增量通道不能混用。" })
      }
      if (finishFlag && usesIncrementalArgs) {
        return JSON.stringify({ error: "suite finish 不得与增量用例参数同时提交；请先 finish_case，再单独调用 finish=true。" })
      }

      // 查询模式:不传 content 且不 finish,返回进度(卡死恢复/续跑时确认状态)
      if (chunkContent === undefined && !finishFlag && !usesIncrementalArgs) {
        return JSON.stringify(readChunkStatus(projectDir, requirementIdText))
      }

      // 收尾模式(不带内容):拼装落盘
      if (finishFlag && chunkContent === undefined) {
        return finalizeChunks(projectDir, requirementIdText)
      }

      if (usesIncrementalArgs) {
        if (caseIndex === undefined) {
          return JSON.stringify({ error: "增量大用例操作必须提供 case_index。" })
        }
        initializeChunkDir(chunkDir)
        const buildDir = caseBuildDir(chunkDir, caseIndex)

        if (caseMetadata !== undefined) {
          if (stepBatch !== undefined || finishCaseFlag) {
            return JSON.stringify({ error: "case_metadata 初始化必须单独调用。" })
          }
          const parsed = parseCaseMetadata(caseMetadata)
          if (!parsed.ok) return JSON.stringify({ status: "invalid", error: parsed.error })
          mkdirSync(buildDir, { recursive: true })
          writeFileSync(join(buildDir, CASE_METADATA_FILE), stripFences(caseMetadata), "utf-8")
          rmSync(join(chunkDir, `chunk_${caseIndex}.txt`), { force: true })
          return JSON.stringify({
            status: "case_started",
            case_index: caseIndex,
            case_name: parsed.value.test_case_name ?? parsed.value.case_name,
            note: "继续按 step_batch_index 追加步骤，每批最多20步。",
          })
        }

        if (stepBatch !== undefined) {
          if (stepBatchIndex === undefined) {
            return JSON.stringify({ error: "追加 step_batch 时必须提供 step_batch_index。" })
          }
          if (!existsSync(join(buildDir, CASE_METADATA_FILE))) {
            return JSON.stringify({ error: `case ${caseIndex} 尚未初始化，请先传 case_metadata。` })
          }
          const parsed = parseStepBatch(stepBatch)
          if (!parsed.ok) {
            const classified = classifyJsonParseError(stripFences(stepBatch))
            return JSON.stringify({
              status: "invalid",
              error: classified.kind === "truncated"
                ? `case ${caseIndex} step batch ${stepBatchIndex} 疑似输出中途截断`
                : parsed.error,
              ...(classified.kind === "truncated" ? { detail: classified.detail } : {}),
              hint: `修正后重发 case_index=${caseIndex}, step_batch_index=${stepBatchIndex} 即可覆盖。`,
            })
          }
          writeFileSync(join(buildDir, `steps_${stepBatchIndex}.json`), JSON.stringify(parsed.value), "utf-8")
          const progress = readInProgressCases(chunkDir).find((item) => item.case_index === caseIndex)
          return JSON.stringify({
            status: "steps_appended",
            case_index: caseIndex,
            step_batch_index: stepBatchIndex,
            received_step_batches: progress?.received_step_batches ?? [],
            step_count: progress?.step_count ?? parsed.value.length,
          })
        }

        if (finishCaseFlag) {
          if (expectedStepCount === undefined) {
            return JSON.stringify({
              status: "invalid",
              error: `case ${caseIndex} 收尾时必须提供 expected_step_count，以防止步骤批次静默丢失。`,
            })
          }
          const metadataFile = join(buildDir, CASE_METADATA_FILE)
          if (!existsSync(metadataFile)) {
            return JSON.stringify({ error: `case ${caseIndex} 尚未初始化，无法收尾。` })
          }
          const metadata = parseCaseMetadata(readFileSync(metadataFile, "utf-8"))
          if (!metadata.ok) return JSON.stringify({ status: "invalid", error: metadata.error })
          const batchIndexes = readdirSync(buildDir)
            .map((entry) => entry.match(STEP_BATCH_PATTERN))
            .filter((match): match is RegExpMatchArray => match !== null)
            .map((match) => Number.parseInt(match[1], 10))
            .sort((a, b) => a - b)
          if (batchIndexes.length === 0) {
            return JSON.stringify({ status: "invalid", error: `case ${caseIndex} 没有任何已收步骤批次。` })
          }
          const lastBatchIndex = batchIndexes[batchIndexes.length - 1]
          const missingBatch = Array.from({ length: lastBatchIndex }, (_, index) => index + 1)
            .find((index) => !batchIndexes.includes(index))
          if (missingBatch !== undefined) {
            return JSON.stringify({
              status: "invalid",
              error: `case ${caseIndex} 缺少 step_batch_index=${missingBatch}，已拒绝收尾。`,
              received_step_batches: batchIndexes,
            })
          }
          const steps: Record<string, unknown>[] = []
          for (const batchIndex of batchIndexes) {
            const parsed = parseStepBatch(readFileSync(join(buildDir, `steps_${batchIndex}.json`), "utf-8"))
            if (!parsed.ok) {
              return JSON.stringify({ status: "invalid", error: `case ${caseIndex} step batch ${batchIndex}: ${parsed.error}` })
            }
            steps.push(...parsed.value)
          }
          if (steps.length !== expectedStepCount) {
            return JSON.stringify({
              status: "invalid",
              error: `case ${caseIndex} 步骤数不匹配：期望 ${expectedStepCount}，实际 ${steps.length}。`,
              received_step_batches: batchIndexes,
              hint: "补发或覆盖错误批次后，使用相同 expected_step_count 重试 finish_case。",
            })
          }
          const completeCase = { ...metadata.value, test_step: steps }
          writeFileSync(join(chunkDir, `chunk_${caseIndex}.txt`), JSON.stringify(completeCase), "utf-8")
          rmSync(buildDir, { recursive: true, force: true })
          return JSON.stringify({
            status: "case_finalized",
            case_index: caseIndex,
            case_name: metadata.value.test_case_name ?? metadata.value.case_name,
            step_count: steps.length,
            received_total: readChunkStatus(projectDir, requirementIdText).received_chunks.length,
            note: "继续构建下一用例；全部用例完成后单独调用 finish=true。",
          })
        }

        return JSON.stringify({ error: "增量模式需要提供 case_metadata、step_batch 或 finish_case=true 之一。" })
      }

      if (chunkContent === undefined) {
        return JSON.stringify({ error: "小用例通道必须提供 content；纯查询请只传 requirement_id。" })
      }
      if (chunkIndex === undefined) {
        return JSON.stringify({ error: "追加分段时必须提供 chunk_index(从 1 起);纯查询可不传 content。" })
      }

      // 逐段即时校验:一个完整用例对象
      const parsed = parseChunkObject(chunkContent)
      if (!parsed.ok) {
        const classified = classifyJsonParseError(stripFences(chunkContent))
        return JSON.stringify({
          status: "invalid",
          error: classified.kind === "truncated"
            ? `chunk ${chunkIndex} 不是完整 JSON(疑似该段输出中途断流)`
            : `chunk ${chunkIndex} 不是合法用例对象`,
          detail: classified.kind === "truncated" ? classified.detail : parsed.error,
          hint: "修正后重发该段(chunk_index 不变,覆盖写入)即可,无需从头重来。每段 content = 一个完整用例对象,不要数组括号,不要跨段拼接。",
        })
      }
      const completeSteps = parsed.value.test_step
      if (Array.isArray(completeSteps) && completeSteps.length > 60) {
        return JSON.stringify({
          status: "invalid",
          error: `chunk ${chunkIndex} 含 ${completeSteps.length} 步，超过 content 通道60步上限。`,
          hint: `改用增量模式：先传 case_index=${chunkIndex} + case_metadata，再按每批最多20步传 step_batch，最后 finish_case=true + expected_step_count=${completeSteps.length}。`,
        })
      }

      // v2 首次写入:清空旧格式残留段(首版拼接片段与本协议不兼容)
      initializeChunkDir(chunkDir)
      writeFileSync(join(chunkDir, `chunk_${chunkIndex}.txt`), stripFences(chunkContent), "utf-8")
      rmSync(caseBuildDir(chunkDir, chunkIndex), { recursive: true, force: true })

      const status = readChunkStatus(projectDir, requirementIdText)
      if (finishFlag) {
        return finalizeChunks(projectDir, requirementIdText)
      }
      return JSON.stringify({
        status: "appended",
        chunk_index: chunkIndex,
        received_total: status.received_chunks.length,
        case_names: status.case_names,
        note: "已收段如上。继续追加下一用例;全部完成后单独调用一次 finish=true 收尾落盘。",
      })
    },
  })
