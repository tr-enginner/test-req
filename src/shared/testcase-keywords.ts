import { existsSync, readdirSync, readFileSync } from "fs"
import { basename, extname, join, resolve } from "path"
import { classifyRequirementPattern } from "./protocol-parser"
import { explicitStepAction, keywordMatchesStepAction } from "./testcase-step-semantics"

export interface KeywordMeta {
  keywordName: string
  description: string
  argumentNames: string[]
  argumentComments: string[]
  txtSnippet: string
  sourceJson: string
  sourceTxt?: string
  searchText: string
}

export interface KeywordCatalog {
  keywordMap: Map<string, KeywordMeta>
  warnings: string[]
  scannedDirs: string[]
}

const KEYWORD_DIR_HINTS = ["关键字", "keyword"]

function normalizeText(value: string): string {
  return value
    .replace(/[\s\t\r\n]+/g, " ")
    .replace(/[，。；：、,.!?:;()[\]{}<>\-_/\\]+/g, " ")
    .toLowerCase()
    .trim()
}

function tokenize(text: string): string[] {
  const normalized = normalizeText(text)
  if (!normalized) return []
  const tokens = normalized.split(" ").filter(Boolean)
  return Array.from(new Set(tokens))
}

function segmentTokens(text: string): string[] {
  const normalized = normalizeText(text)
  if (!normalized) return []
  const matches = normalized.match(/[a-z0-9]+|[\u4e00-\u9fa5]+/gi) ?? []
  return Array.from(new Set(matches.filter(Boolean)))
}

function keywordDomainHeuristicScore(text: string, keyword: KeywordMeta): number {
  const normalizedText = normalizeText(text)
  // UserKeyWord.json 的定义为准：txt 只是概述文件，仅当 JSON Comments
  // (description) 为空时才用 txt 片段兜底参与打分。
  const candidateCorpus = normalizeText([
    keyword.keywordName,
    keyword.description,
    keyword.argumentComments.join(" "),
    ...(keyword.description.trim() ? [] : [keyword.txtSnippet]),
  ].filter(Boolean).join(" "))

  if (!normalizedText || !candidateCorpus) return 0

  // Generic patterns
  // "总线" alone must NOT imply CAN (e.g. "SPI总线"/"串口总线" are not CAN);
  // "can" needs a non-letter boundary so "cantxt" (CAN+TXT composite keyword
  // name) is covered by the explicit "cantx" alternative instead.
  const CAN_TEXT = /(cana|canb|cantx|can(?![a-z]))/
  const CAN_KEYWORD = /(cana|canb|cantx|can(?![a-z]))/
  const hasCan = CAN_TEXT.test(normalizedText)
  const hasCana = /cana/.test(normalizedText)
  const hasCanb = /canb/.test(normalizedText)
  const hasSend = /(发送|下发|注入|send)/.test(normalizedText)
  const hasSpi = /spi/.test(normalizedText)
  const hasMemoryIntent = /(内存|寄存器|8bit|16bit|32bit|bit|数据区)/.test(normalizedText)

  // CAN bus level: 二级CAN and 一级 (CANA/CANB) are DIFFERENT buses — a step
  // on one level must not match keywords of the other level.
  const hasCanLevel2 = /二级can/.test(normalizedText)
  const hasCanLevel1 = !hasCanLevel2 && /(cana|canb|一级can)/.test(normalizedText)

  // Cyclic/periodic sending detection — primary differentiator for "循环" vs
  // simple send keywords. Bare "轮询" is deliberately EXCLUDED: it usually
  // appears inside data/command NAMES ("遥测帧1轮询控制序列") and must not
  // flip a one-shot file send into a cyclic-send match. A real cyclic intent
  // carries an explicit cycle marker (循环/周期/每N秒/持续N/间隔N秒).
  const hasCyclicSend = /(循环|周期|每\d+(?:\.\d+)?秒|持续\d+|间隔\d+(?:\.\d+)?秒)/.test(normalizedText)

  // File-based send: the step sends a named data file — words like 内存/轮询
  // inside the file/command NAME are not memory-intent signals.
  const hasFileSend = hasSend && /(数据文件|\.txt|\.bin)/.test(normalizedText)

  // "指令"/"数据" are NOT used as primary differentiators for keyword selection.
  // Keywords should be distinguished by: cyclic vs single send first, arg count second,
  // "指令"/"数据" name suffix only as last tiebreaker.

  // Satellite DSP domain patterns
  const hasCe0 = /(ce0|逻辑控制fpga|逻辑控制)/i.test(normalizedText)
  const hasCe2 = /(ce2|基带信号处理|基带信号)/i.test(normalizedText)
  const hasCe3 = /(ce3|配置管理fpga|配置管理)/i.test(normalizedText)
  const hasTelemetryFast = /(速变遥测|速变)/.test(normalizedText)
  const hasTelemetrySlow = /(缓变遥测|缓变)/.test(normalizedText)
  const hasTelemetryDown = /(下泄遥测|下泄)/.test(normalizedText)
  const hasBroadcast = /(广播|gnss|姿控|星务)/i.test(normalizedText)
  const hasFrameInterval = /(帧间隔|多帧)/.test(normalizedText)

  const keywordHasCan = CAN_KEYWORD.test(candidateCorpus)
  const keywordHasCana = /cana/.test(candidateCorpus)
  const keywordHasCanb = /canb/.test(candidateCorpus)
  // 候选侧 send 检测用 \b 词边界:txt 片段里的 "VTest_SendCmd" 是组件调用名,
  // 不是发送语义——曾让 开始/关闭SPICap数据记录 这类记录关键字拿满 SPI+48,
  // 压过真正的 发送SPI-TXT数据(2026-09-02 取证)
  const keywordHasSend = /(发送|\bsend\b)/.test(candidateCorpus)
  const keywordHasSpi = /spi/.test(candidateCorpus)
  const keywordHasMemoryIntent = /(内存|寄存器|8bit|16bit|32bit|bit|数据区)/.test(candidateCorpus)
  const keywordHasCe0 = /ce0/i.test(candidateCorpus)
  const keywordHasCe2 = /ce2/i.test(candidateCorpus)
  const keywordHasCe3 = /ce3/i.test(candidateCorpus)
  const keywordHasCyclic = /循环/.test(candidateCorpus)
  const keywordHasFrameInterval = /(帧间隔|多帧)/.test(candidateCorpus)
  const keywordHasCanLevel2 = /二级can/.test(candidateCorpus)
  const keywordHasCanLevel1 = !keywordHasCanLevel2 && /(cana|canb|一级can)/.test(candidateCorpus)

  // Argument count — simpler keywords preferred unless cyclic/file needed
  const keywordArgCount = keyword.argumentNames.length

  let score = 0

  // Generic CAN bus heuristics
  if (hasCan && hasSend && keywordHasCan && keywordHasSend) score += 48
  if (hasCana && keywordHasCana) score += 26
  if (hasCanb && keywordHasCanb) score += 26
  if (hasCan && !hasCana && !hasCanb && (keywordHasCana || keywordHasCanb)) score += 12

  // SPI intent (mirror of the CAN send rule)
  if (hasSpi && hasSend && keywordHasSpi && keywordHasSend) score += 48

  // CAN bus level: same level boosts, cross level heavily demotes — a 二级CAN
  // step must not settle for a 一级 CANA/CANB keyword and vice versa.
  if (hasCanLevel2 && keywordHasCanLevel2) score += 40
  if (hasCanLevel2 && !keywordHasCanLevel2 && keywordHasCan) score -= 40
  if (hasCanLevel1 && keywordHasCanLevel1) score += 12
  if (hasCanLevel1 && keywordHasCanLevel2) score -= 40

  // Frame-interval configuration keywords are irrelevant to steps without a
  // 帧间隔/多帧 intent — demote so they cannot outscore the actual send keyword.
  if (!hasFrameInterval && keywordHasFrameInterval) score -= 40

  // Cyclic vs single send: the primary differentiator
  if (hasCyclicSend && keywordHasCyclic) score += 14
  if (!hasCyclicSend && keywordHasCyclic) score -= 14  // penalize cyclic keywords when no cyclic pattern
  if (!hasCyclicSend && !keywordHasCyclic && keywordHasSend) score += 8  // prefer simple send variants

  // 数据文件/TXT 变体永远最优(2026-09-02 用户裁定):相似关键字中,名称包含
  // "数据文件"或"TXT"的关键字是最优项(+30 决定性偏好,覆盖 发送CANA数据_数据文件/
  // 发送SPI-TXT数据/发送二级CAN-TXT数据 等新旧形态)——执行体系(DTP)的载荷由
  // 数据文件承载;记录类(开始SPICap数据记录)在此规则下永远让位
  if (hasSend && keywordHasSend && /(数据文件|txt)/i.test(keyword.keywordName)) score += 30

  // 括号限定词减分(2026-09-02 用户裁定):名称带"（限定词）"后缀且限定词不出现在
  // 步骤文本中 → 减分——"设置32位地址数据(针对C33处理器)"在非 C33 语境必须
  // 稳定让位给无后缀的 "设置32位地址数据",双胞胎不再按加载序随机胜出
  const qualifierMatch = keyword.keywordName.match(/[（(]([^（）()]+)[）)]$/)
  if (qualifierMatch && !normalizedText.includes(qualifierMatch[1]!)) score -= 10

  // 宽度限定词同理(2026-09-02 用户裁定"尽量映射准确+稳定"):名称带 16位/8位/
  // bit/High16/Low16 等宽度标记而步骤文本没有该标记 → 减分——"设置16位数据至
  // 32位地址"在无宽度语义的内存写步骤上必须稳定让位给 "设置32位地址数据"
  // (32位是缺省全宽,不算限定标记);载荷措辞的 ±4 token 分不再翻转双胞胎
  const widthMarker = keyword.keywordName.match(/16位|8位|[128]bit|high16|low16/i)
  if (widthMarker && !new RegExp(widthMarker[0], "i").test(normalizedText)) score -= 12

  // 触发中断意图对齐(2026-09-02 SpaceWire 取证):"触发…中断"步骤必须匹配
  // 触发类中断关键字;设置/发送类关键字让位。外部中断/TRAP 字样再细分,
  // 避免触发TRAP中断 抢走 外部中断 步骤
  const hasIrqTriggerIntent = /触发.{0,8}中断|中断触发/.test(normalizedText)
  const keywordIsIrqTrigger = /^触发.{0,6}中断/.test(keyword.keywordName)
  if (hasIrqTriggerIntent && keywordIsIrqTrigger) score += 40
  if (hasIrqTriggerIntent && !keywordIsIrqTrigger && keywordHasSend) score -= 40
  if (/外部中断/.test(normalizedText) && /^触发外部中断/.test(keyword.keywordName)) score += 20
  if (/trap/i.test(normalizedText) && /^触发trap/i.test(keyword.keywordName)) score += 20

  // Argument count: simpler is better when no cyclic/file complexity needed
  if (!hasCyclicSend) {
    if (keywordArgCount <= 4) score += 6
    if (keywordArgCount >= 5) score -= 6
  }

  // Satellite DSP: FPGA chip select heuristics
  if (hasCe0 && keywordHasCe0) score += 12
  if (hasCe2 && keywordHasCe2) score += 12
  if (hasCe3 && keywordHasCe3) score += 12

  // Satellite DSP: telemetry type matching
  if (hasTelemetryFast && /速变/.test(candidateCorpus)) score += 10
  if (hasTelemetrySlow && /缓变/.test(candidateCorpus)) score += 10
  if (hasTelemetryDown && /下泄/.test(candidateCorpus)) score += 10

  // Satellite DSP: broadcast data
  if (hasBroadcast && keywordHasSend && keywordHasCan) score += 8

  // Satellite DSP: frame interval configuration
  if (hasFrameInterval && keywordHasFrameInterval) score += 10

  // Memory intent heuristics — suppressed for file-based sends, where 内存/轮询
  // appear only inside the data/command NAME ("发送内存读出指令数据文件mr.txt")
  const effectiveMemoryIntent = hasMemoryIntent && !hasFileSend
  if (!effectiveMemoryIntent && keywordHasMemoryIntent) score -= 28
  if (effectiveMemoryIntent && keywordHasMemoryIntent) score += 18
  if (hasCan && hasSend && keywordHasMemoryIntent) score -= 18

  return score
}

function buildSearchText(meta: KeywordMeta): string {
  return [
    meta.keywordName,
    meta.description,
    meta.argumentNames.join(" "),
    meta.argumentComments.join(" "),
    // txt 仅为概述文件，JSON 定义为权威；JSON 描述为空时才兜底用 txt 片段
    ...(meta.description.trim() ? [] : [meta.txtSnippet]),
  ]
    .filter(Boolean)
    .join("\n")
}

/**
 * Restrict keyword MATCHING to the project-varying UserKeyWord library.
 *
 * Per project reality: only UserKeyWord.json/.txt vary between projects;
 * every other library file (VTest/Memory/WatchMem/Protocol/…) is fixed and
 * identical for all projects. Their entries are implementation-level keywords
 * that only pollute candidate ranking, so every matching surface (step plans,
 * keyword_candidates, format-check rescoring, step translation) must run on
 * this filtered map. Loading code for other libraries stays intact — they are
 * merely skipped during matching. When the catalog has NO UserKeyWord entries
 * (fixture/legacy projects), fall back to the full map so behavior degrades
 * gracefully instead of matching nothing.
 */
export function filterUserKeywordMap(
  keywordMap: Map<string, KeywordMeta>,
): Map<string, KeywordMeta> {
  // 数据池关键字全局排除(2026-09-02 用户裁定):所有测试用例不管什么场景
  // 全部忽略"数据池"相关关键字——设置数据池数据/读取数据池数据/设置数据包
  // 数据池/…(数据池) 变体 一律不参与匹配
  const isDataPoolKeyword = (name: string) => /数据池/.test(name)
  const filtered = new Map<string, KeywordMeta>()
  for (const [name, meta] of keywordMap) {
    if (isDataPoolKeyword(name)) continue
    if (/^userkeyword[^/\\]*\.json$/i.test(basename(meta.sourceJson))) {
      filtered.set(name, meta)
    }
  }
  // 回退全库时同样剔除数据池关键字(裁定对所有场景生效)
  if (filtered.size > 0) return filtered
  const fallback = new Map<string, KeywordMeta>()
  for (const [name, meta] of keywordMap) {
    if (!/数据池/.test(name)) fallback.set(name, meta)
  }
  return fallback
}

function parseKeywordJson(
  jsonPath: string,
  txtSnippetMap: Map<string, string>,
  txtPath?: string,
): KeywordMeta[] {
  const raw = readFileSync(jsonPath, "utf-8")
  const parsed = JSON.parse(raw) as {
    Items?: Array<{
      Name?: string
      Comments?: string | null
      Arguments?: Array<{ Name?: string; Comments?: string | null }>
    }>
  }

  const items = parsed.Items ?? []
  const metas: KeywordMeta[] = []
  for (const item of items) {
    const keywordName = String(item.Name ?? "").trim()
    if (!keywordName) continue
    const description = String(item.Comments ?? "").trim()
    const argumentNames: string[] = []
    const argumentComments: string[] = []
    for (const arg of item.Arguments ?? []) {
      const name = String(arg.Name ?? "").trim()
      if (!name) continue
      argumentNames.push(name)
      argumentComments.push(String(arg.Comments ?? "").trim())
    }
    const txtSnippet = txtSnippetMap.get(keywordName) ?? ""

    const meta: KeywordMeta = {
      keywordName,
      description,
      argumentNames,
      argumentComments,
      txtSnippet,
      sourceJson: jsonPath,
      sourceTxt: txtPath,
      searchText: "",
    }
    meta.searchText = buildSearchText(meta)
    metas.push(meta)
  }
  return metas
}

function parseKeywordTxt(txtPath: string): Map<string, string> {
  const lines = readFileSync(txtPath, "utf-8").split(/\r?\n/)
  const snippets = new Map<string, string>()
  let currentName = ""
  let currentLines: string[] = []

  const flush = () => {
    if (currentName) {
      const snippet = currentLines.join("\n").trim()
      if (snippet) snippets.set(currentName, snippet)
    }
    currentName = ""
    currentLines = []
  }

  for (const line of lines) {
    const trimmed = line.trimEnd()
    if (!trimmed) continue
    const isHeader = !/^\s/.test(line) && !trimmed.startsWith("***")
    if (isHeader) {
      flush()
      currentName = trimmed.trim()
      continue
    }
    if (currentName) currentLines.push(trimmed)
  }
  flush()
  return snippets
}

function looksLikeKeywordDir(dirPath: string): boolean {
  const dirName = basename(dirPath).toLowerCase()
  if (KEYWORD_DIR_HINTS.some((hint) => dirName.includes(hint))) return true
  const entries = readdirSync(dirPath, { withFileTypes: true })
  const jsonFiles = entries
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".json")
    .map((entry) => join(dirPath, entry.name))
  if (jsonFiles.length === 0) return false
  for (const jsonPath of jsonFiles) {
    try {
      const raw = readFileSync(jsonPath, "utf-8")
      if (raw.includes("\"Items\"")) return true
    } catch {
      continue
    }
  }
  return false
}

function listSubdirectories(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(dir, entry.name))
}

function bfsFindKeywordDirs(root: string, maxDepth = 4): string[] {
  const results: string[] = []
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
  const seen = new Set<string>()

  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!
    const resolved = resolve(dir)
    if (seen.has(resolved)) continue
    seen.add(resolved)
    if (!existsSync(resolved)) continue
    if (looksLikeKeywordDir(resolved)) results.push(resolved)
    if (depth >= maxDepth) continue
    for (const subdir of listSubdirectories(resolved)) {
      if (basename(subdir).startsWith(".")) continue
      queue.push({ dir: subdir, depth: depth + 1 })
    }
  }
  return results
}

export function scanKeywordDirs(
  keywordDirs: string[],
  fallbackRoot?: string,
): KeywordCatalog {
  const warnings: string[] = []
  const scannedDirs: string[] = []
  const keywordMap = new Map<string, KeywordMeta>()

  const dirs: string[] = []
  for (const dir of keywordDirs) {
    if (!dir) continue
    if (existsSync(dir)) dirs.push(dir)
  }
  if (dirs.length === 0 && fallbackRoot) {
    dirs.push(...bfsFindKeywordDirs(fallbackRoot))
  }

  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    scannedDirs.push(dir)
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || extname(entry.name).toLowerCase() !== ".json") continue
      const jsonPath = join(dir, entry.name)
      let txtSnippetMap = new Map<string, string>()
      const txtPath = join(dir, `${basename(entry.name, ".json")}.txt`)
      if (existsSync(txtPath)) {
        try {
          txtSnippetMap = parseKeywordTxt(txtPath)
        } catch (err) {
          warnings.push(`关键字 TXT 解析失败: ${txtPath} (${String(err)})`)
        }
      }

      try {
        const metas = parseKeywordJson(jsonPath, txtSnippetMap, txtPath ?? undefined)
        for (const meta of metas) {
          if (keywordMap.has(meta.keywordName)) {
            warnings.push(`关键字重名，保留首次加载结果: ${meta.keywordName}`)
            continue
          }
          keywordMap.set(meta.keywordName, meta)
        }
      } catch (err) {
        warnings.push(`关键字 JSON 解析失败: ${jsonPath} (${String(err)})`)
      }
    }
  }

  return { keywordMap, warnings, scannedDirs }
}

export function scoreKeywordCandidates(
  text: string,
  keywordMap: Map<string, KeywordMeta>,
  limit = 5,
): KeywordMeta[] {
  const normalizedText = normalizeText(text)
  const textTokens = tokenize(text)
  const textSegments = segmentTokens(text)
  if (!normalizedText) return []

  const candidates: Array<{ keyword: KeywordMeta; score: number }> = []
  for (const keyword of keywordMap.values()) {
    const normalizedKeyword = normalizeText(keyword.searchText)
    const keywordTokens = tokenize(keyword.searchText)
    const keywordSegments = segmentTokens(keyword.searchText)
    if (!normalizedKeyword) continue
    let score = 0
    if (normalizedKeyword.includes(normalizedText) || normalizedText.includes(normalizedKeyword)) {
      score += 8
    }
    for (const token of textTokens) {
      if (keywordTokens.includes(token)) score += 2
      if (keyword.keywordName.includes(token)) score += 4
      if (keyword.description.includes(token)) score += 2
    }
    for (const segment of textSegments) {
      if (keywordSegments.includes(segment)) score += 3
      if (keyword.keywordName.includes(segment)) score += 4
      if (keyword.description.includes(segment)) score += 2
    }
    score += keywordDomainHeuristicScore(text, keyword)
    if (score > 0) candidates.push({ keyword, score })
  }

  candidates.sort((a, b) => b.score - a.score)

  // CAN 层级硬约束(动作从句,双向):与 scoreKeywordCandidatesWeighted 一致。
  // 本函数是翻译 Phase B 的全局兜底打分——无约束时一级触发步骤会因结果
  // 从句密集"二级CAN"文本重叠被二级关键字抢走(2026-08-26 循环触发取证:
  // "以1秒为周期循环发送"触发步骤被渲染成"通过二级CAN总线发送")。
  // SPI 通道同理(2026-08-31 审计):动作从句点名 SPI 且是发送动作时,只有
  // 名称/描述含 SPI 的关键字可作候选——否则二级CAN 关键字可凭预期半区
  // "通过二级CAN总线转发"文本重叠、内存关键字凭"站地址XXH"参数注释反超
  if (actionChannelOfText(text) === "SPI") {
    const spiOnly = candidates.filter((c) => /spi/i.test(`${c.keyword.keywordName} ${c.keyword.description}`))
    if (spiOnly.length > 0) {
      candidates.length = 0
      candidates.push(...spiOnly)
    }
  } else if (stepActionOnSecondaryBus(text)) {
    const secondaryOnly = candidates.filter((c) => mentionsSecondaryCan(c.keyword.searchText))
    if (secondaryOnly.length > 0) {
      candidates.length = 0
      candidates.push(...secondaryOnly)
    }
  } else if (stepActionOnPrimaryBus(text)) {
    const primaryOnly = candidates.filter((c) => !mentionsSecondaryCan(c.keyword.searchText))
    if (primaryOnly.length > 0) {
      candidates.length = 0
      candidates.push(...primaryOnly)
    }
  }

  return candidates
    .slice(0, limit)
    .map((item) => item.keyword)
}

export function formatKeywordCandidates(candidates: KeywordMeta[]): string {
  if (candidates.length === 0) return "未找到候选关键字。"
  return candidates
    .map((keyword, index) => {
      const args = keyword.argumentNames.join(", ") || "无"
      const comments = keyword.argumentComments.join(" | ") || "无"
      const snippet = keyword.txtSnippet ? `\n  txt片段: ${keyword.txtSnippet}` : ""
      return [
        `${index + 1}. ${keyword.keywordName}`,
        `  Documentation: ${keyword.description || "无"}`,
        `  Arguments: ${args}`,
        `  ArgumentComments: ${comments}`,
        snippet,
      ]
        .filter(Boolean)
        .join("\n")
    })
    .join("\n")
}

// ---------------------------------------------------------------------------
// Enhanced scoring with project-specific guidance
// ---------------------------------------------------------------------------

export interface KeywordScoringOptions {
  /** Per-keyword weight overrides from generation guide (keywordName → weight) */
  keywordWeights?: Record<string, number>
  /** Whether to prefer composite (UserKeyword) keywords */
  preferComposite?: boolean
  /** Context about which bus is being used */
  busContext?: "cana" | "canb" | "both" | null
  /** Whether the requirement involves timing-sensitive operations */
  timingSensitive?: boolean
}

function isCompositeKeyword(keyword: KeywordMeta): boolean {
  const snippet = keyword.txtSnippet || ""
  return /VTest_SendCmd|VTest_WaitToTime|DataPool_/.test(snippet) && snippet.length > 0
}

function matchTimingPattern(text: string): number {
  // Count "第N秒" patterns as a proxy for timing sensitivity
  const matches = text.match(/第[\d.]+秒/g)
  return matches ? Math.min(matches.length, 10) : 0
}

/** 步骤/关键字文本是否涉及二级 CAN 总线(2026-08-25:二级应答步骤曾错配一级关键字) */
export function mentionsSecondaryCan(text: string): boolean {
  return /二级\s*(?:can)?总线|二级can/i.test(text)
}

/** 步骤的动作从句:首个发送动词之前的文本(动作发生在哪条总线以此为准) */
export function actionClauseOf(stepDesc: string): string {
  const verb = stepDesc.match(/发送|下发|注入/)
  return verb ? stepDesc.slice(0, verb.index) : stepDesc
}

/**
 * 步骤动作是否发生在二级总线:只看首个发送动词之前的动作从句。
 * 触发步骤"通过CANA总线发送X,触发软件通过二级CAN总线转发Y"的结果从句
 * 提到二级,但动作本身在一级——按全文判定会把一级触发步骤错配二级关键字
 * (2026-08-26 二级总线事故取证:触发步骤被渲染成"通过二级CAN总线发送")。
 */
export function stepActionOnSecondaryBus(stepDesc: string): boolean {
  return mentionsSecondaryCan(actionClauseOf(stepDesc))
}

/**
 * 步骤动作是否发生在一级 CAN 总线:动作从句点名 CANA/CANB 且不在二级。
 * 触发步骤的结果从句密集出现"二级CAN"字样,二级关键字的文本重叠分天然
 * 压过一级——动作层级必须双向硬约束(一级动作时二级候选让位)
 */
export function stepActionOnPrimaryBus(stepDesc: string): boolean {
  const actionClause = actionClauseOf(stepDesc)
  if (mentionsSecondaryCan(actionClause)) return false
  return /(CANA|CANB)/i.test(actionClause)
}

/** 二级 CAN 对齐分:动作层级与关键字层级一致 +30,不一致 -30(压过文本重叠分) */
function secondaryCanAlignment(text: string, keywordText: string): number {
  const actionSecondary = stepActionOnSecondaryBus(text)
  const actionPrimary = stepActionOnPrimaryBus(text)
  const keywordSecondary = mentionsSecondaryCan(keywordText)
  if (actionSecondary) return keywordSecondary ? 30 : -30
  if (actionPrimary && keywordSecondary) return -30
  return 0
}

function matchBusContext(text: string, busContext: string | null): number {
  if (!busContext) return 0
  const lower = text.toLowerCase()
  if (busContext === "cana" && (lower.includes("cana") || text.includes("CANA"))) {
    return /canb|CANB/.test(text) ? 0 : 6
  }
  if (busContext === "canb" && (lower.includes("canb") || text.includes("CANB"))) {
    return /cana|CANA/.test(text) ? 0 : 6
  }
  if (busContext === "both") {
    if ((lower.includes("cana") || text.includes("CANA"))
      || (lower.includes("canb") || text.includes("CANB"))) return 3
  }
  return 0
}

export function scoreKeywordCandidatesWeighted(
  text: string,
  keywordMap: Map<string, KeywordMeta>,
  limit = 5,
  options: KeywordScoringOptions = {},
): KeywordMeta[] {
  const normalizedText = normalizeText(text)
  const textTokens = tokenize(text)
  const textSegments = segmentTokens(text)
  if (!normalizedText) return []

  const timingScore = matchTimingPattern(text)
  const compositeSourceMap = new Map<string, KeywordMeta[]>()

  const candidates: Array<{ keyword: KeywordMeta; score: number }> = []
  for (const keyword of keywordMap.values()) {
    const normalizedKeyword = normalizeText(keyword.searchText)
    const keywordTokens = tokenize(keyword.searchText)
    const keywordSegments = segmentTokens(keyword.searchText)
    if (!normalizedKeyword) continue

    let score = 0

    // Exact match bonus
    if (normalizedKeyword.includes(normalizedText) || normalizedText.includes(normalizedKeyword)) {
      score += 8
    }

    // Token overlap
    for (const token of textTokens) {
      if (keywordTokens.includes(token)) score += 2
      if (keyword.keywordName.includes(token)) score += 4
      if (keyword.description.includes(token)) score += 2
    }

    // Segment overlap
    for (const segment of textSegments) {
      if (keywordSegments.includes(segment)) score += 3
      if (keyword.keywordName.includes(segment)) score += 4
      if (keyword.description.includes(segment)) score += 2
    }

    // Domain heuristics
    score += keywordDomainHeuristicScore(text, keyword)

    // Timing sensitivity
    if (options.timingSensitive && timingScore > 0) {
      if (/第\$\{time\}秒|时间|WaitToTime/.test(keyword.searchText)) score += timingScore
    }

    // Bus context
    if (options.busContext) {
      score += matchBusContext(keyword.searchText, options.busContext)
    }

    // 二级 CAN 层级对齐:步骤说二级总线时,二级关键字必须压过一级总线通道分
    score += secondaryCanAlignment(text, keyword.searchText)

    // Composite keyword preference
    const isComposite = isCompositeKeyword(keyword)
    if (options.preferComposite && isComposite) {
      score += 6
      // Group by source for diversity
      const sourceKey = keyword.sourceJson
      if (!compositeSourceMap.has(sourceKey)) compositeSourceMap.set(sourceKey, [])
      compositeSourceMap.get(sourceKey)!.push(keyword)
    }

    // Per-keyword weight override from generation guide
    if (options.keywordWeights && options.keywordWeights[keyword.keywordName]) {
      score += options.keywordWeights[keyword.keywordName]
    }

    if (score > 0) candidates.push({ keyword, score })
  }

  // Sort by score
  candidates.sort((a, b) => b.score - a.score)

  // CAN 层级硬约束(动作从句双向):动作在二级→一级候选让位;动作在一级→
  // 二级候选让位。触发步骤的结果从句密集出现"二级CAN",二级关键字的文本
  // 重叠分曾压过一级(2026-08-26 取证:一级触发被渲染成二级发送)
  if (stepActionOnSecondaryBus(text)) {
    const secondaryOnly = candidates.filter((c) => mentionsSecondaryCan(c.keyword.searchText))
    if (secondaryOnly.length > 0) {
      candidates.length = 0
      candidates.push(...secondaryOnly)
    }
  } else if (stepActionOnPrimaryBus(text)) {
    const primaryOnly = candidates.filter((c) => !mentionsSecondaryCan(c.keyword.searchText))
    if (primaryOnly.length > 0) {
      candidates.length = 0
      candidates.push(...primaryOnly)
    }
  }

  // If preferComposite, ensure diversity across source files
  if (options.preferComposite && compositeSourceMap.size > 1) {
    const seenSources = new Set<string>()
    const diverse: Array<{ keyword: KeywordMeta; score: number }> = []
    const remainder: Array<{ keyword: KeywordMeta; score: number }> = []

    for (const c of candidates) {
      const sourceKey = c.keyword.sourceJson
      if (isCompositeKeyword(c.keyword) && !seenSources.has(sourceKey)) {
        seenSources.add(sourceKey)
        diverse.push(c)
      } else {
        remainder.push(c)
      }
    }

    // Interleave: pick top from diverse sources first, then fill with remainder
    const result = [...diverse, ...remainder].sort((a, b) => b.score - a.score)
    return result.slice(0, limit).map((item) => item.keyword)
  }

  return candidates
    .slice(0, limit)
    .map((item) => item.keyword)
}

// ---------------------------------------------------------------------------
// Anchor-guided keyword filtering
// ---------------------------------------------------------------------------

/**
 * Maps semantic anchor operation_type values to regex patterns for filtering
 * keyword candidates. Each pattern is tested against the keyword's combined
 * searchText (name + description + arguments + txtSnippet).
 */
export const OPERATION_TYPE_KEYWORD_PATTERNS: Record<string, RegExp[]> = {
  send_command:      [/发送.*指令|发送CANA|发送CANB|发送二级CAN|循环发送/i],
  inject_input:      [/发送.*数据|发送CANA|发送CANB|发送二级CAN|注入/i],
  trigger_output:    [/发送.*触发|发送.*遥测/i],
  set_input_data:    [/设置.*地址|设置.*数据池|设置.*数据包|设置.*bit|设置.*寄存器|设置.*前向|设置.*总线/i],
  set_memory:        [/设置.*地址数据|设置.*寄存器|设置8[位位]|设置16[位位]|设置32[位位]|设置.*内存/i],
  verify_telemetry:  [/发送.*遥测|CE0|CE2|CE3|监视协议|监视协议项/i],
  verify_response:   [/判断|检查|监视|Watch|GlobalVar|ManualJudge|Validate/i],
  verify:            [/判断|检查|监视|Watch|GlobalVar|ManualJudge|Validate|断言/i],
  bus_communication: [/发送CANA|发送CANB|发送二级CAN|CAN总线|CAN.*帧间隔/i],
  initialization:    [/启动|初始化|设置.*帧间隔|设置.*总线|循环发送.*指令|重启/i],
  other:             [/./],
}

export interface AnchorFilter {
  /** Operation type from semantic anchor */
  operation_type?: string
  /** Bus channel from semantic anchor */
  channel?: string
}

/**
 * Score keyword candidates filtered by semantic anchors.
 * Narrows the keyword space by operation_type and channel before scoring,
 * making matching more reliable than global keyword scoring.
 *
 * Falls back to the entire keywordMap if anchor filtering leaves no candidates.
 */
/**
 * 步骤描述半区的动作通道:首个发送动词之前的动作从句里点名的总线。
 * 返回 null 表示不是总线发送步骤(无发送动词,或动作从句不含总线词)。
 * worker 的锚点 channel 是语义标注,可为空或粗粒度;动作从句的通道词
 * 是步骤事实,总线发送步骤的候选必须按它过滤(2026-08-28 取证:SPI 应答
 * 步骤 operation_type=set_input_data + channel="",模式表只放行"设置*"
 * 内存关键字,发送SPITXT接口数据 被滤除,"站地址59H"被绑成起始地址 0x59,
 * 二级CAN/SPI 步骤共 102 处错配到内存关键字)。
 */
export function actionChannelOfText(
  text: string,
): "CANA" | "CANB" | "二级CAN" | "SPI" | null {
  const descLine = text.split("\n")[0] ?? text
  const verb = descLine.match(/发送|下发|注入/)
  if (!verb || verb.index === undefined) return null
  const actionClause = descLine.slice(0, verb.index)
  if (mentionsSecondaryCan(actionClause)) return "二级CAN"
  if (/spi/i.test(actionClause)) return "SPI"
  const can = actionClause.match(/CANA|CANB/i)
  return can ? (can[0]!.toUpperCase() as "CANA" | "CANB") : null
}

export function scoreKeywordCandidatesByAnchor(
  text: string,
  keywordMap: Map<string, KeywordMeta>,
  anchor: AnchorFilter,
  limit = 5,
): KeywordMeta[] {
  // Interrupts are often annotated inject_input. Do not let that broad anchor
  // exclude the only valid action, or let result-side bus prose override it.
  if (explicitStepAction(text)?.includes("interrupt")) {
    const compatible = new Map([...keywordMap].filter(([, meta]) => keywordMatchesStepAction(text, meta.keywordName)))
    return scoreKeywordCandidatesWeighted(text.split("\n")[0]!, compatible, limit)
  }
  // 文本动作通道优先于锚点 channel(文本是步骤事实);总线发送步骤同时
  // 跳过 operation_type 模式收窄——worker 的 operation_type 是意图级语义
  // ("set_input_data"=向被测软件注入输入),落在总线上就是发送类关键字,
  // 按"设置*"实现级模式过滤会把正确的发送关键字全部错杀
  const textChannel = actionChannelOfText(text)
  const busSendStep = textChannel !== null
  const filterChannel = busSendStep ? textChannel : anchor.channel

  const patterns = !busSendStep && anchor.operation_type
    ? OPERATION_TYPE_KEYWORD_PATTERNS[anchor.operation_type]
    : null

  // Build filtered map: only keywords matching the operation type
  const filteredMap = new Map<string, KeywordMeta>()
  for (const [name, meta] of keywordMap) {
    if (patterns) {
      const searchText = `${meta.keywordName} ${meta.description} ${meta.txtSnippet ?? ""}`
      const matchesAny = patterns.some((p) => p.test(searchText))
      if (!matchesAny) continue
    }
    // Channel preference: if anchor specifies a channel, prefer keywords containing it.
    // 二级CAN 关键字(文本形态"二级CAN总线/二级CANTXT",不含字面 CANA/CANB)
    // 须放行——但仅当步骤动作确实在二级:步骤锚点 channel=CANA 常来自
    // "二级CANA总线"(真二级步骤);而一级触发步骤(channel=CANA)的动作
    // 从句点名 CANA,二级候选应被通道滤除(2026-08-26 对称层级规则)
    const stepActionSecondary = stepActionOnSecondaryBus(text)
    if (filterChannel && !(stepActionSecondary && /二级\s*can/i.test(`${meta.keywordName} ${meta.description}`))) {
      // 二级CAN/SPI 是协议家族词,不是字面通道名——CANA/CANB 正则匹配不到
      // "发送二级CANTXT数据"/"发送SPITXT接口数据"的家族词形
      const channelRegex = filterChannel === "二级CAN" ? /二级\s*can/i
        : filterChannel === "SPI" ? /spi/i
        : new RegExp(filterChannel, "i")
      const hasChannel = channelRegex.test(`${meta.keywordName} ${meta.description}`)
      if (!hasChannel) continue
    }
    filteredMap.set(name, meta)
  }

  // Fall back to entire map if filtering left nothing
  const effectiveMap = filteredMap.size > 0 ? filteredMap : keywordMap
  return scoreKeywordCandidatesWeighted(text, effectiveMap, limit, {
    busContext: (anchor.channel?.toLowerCase() as "cana" | "canb" | null) ?? null,
  })
}

// ---------------------------------------------------------------------------
// Interface-driven keyword matching for methodology-based step generation
// ---------------------------------------------------------------------------

export interface StepPlan {
  step_index: number
  purpose: "inject_input" | "trigger_output" | "verify" | "set_input_data" | "verify_telemetry" | "send_command" | "verify_response"
  description: string
  keyword_name: string
  bus_channel: "CANA" | "CANB" | ""
  argument_bindings: Record<string, string>
  /** Resolved step description with placeholders filled */
  resolved_step_desc?: string
  /** Suggested operation_type anchor derived from purpose */
  suggested_operation_type?: string
  /** Suggested channel anchor mirrors bus_channel */
  suggested_channel?: string
  /** Suggested temporal anchor extracted from resolved_step_desc */
  suggested_temporal?: string
}

export interface KeywordMatchResult {
  input_keywords: KeywordMeta[]
  output_keywords: KeywordMeta[]
  bus_keywords: KeywordMeta[]
  step_plan: StepPlan[]
  dual_bus_generated: boolean
  pattern: string
  warnings: string[]
}

// ---------------------------------------------------------------------------
// Pattern-aware step plan generation
// ---------------------------------------------------------------------------

/**
 * Contract gate: a plan send step carries a data payload, so the resolved
 * keyword must declare a file/data argument. Rejects fallback-scan hits whose
 * argument contract cannot carry the planned bindings (wrong-keyword hints).
 */
function hasDataPayloadArgument(meta: KeywordMeta): boolean {
  return meta.argumentComments.some((comment) => /文件|数据/.test(comment ?? ""))
}

function resolveSendKeyword(keywordMap: Map<string, KeywordMeta>, preferred: string, fallbackPattern: RegExp): KeywordMeta | undefined {
  const candidates: KeywordMeta[] = []
  const kw = keywordMap.get(preferred)
  if (kw) candidates.push(kw)
  for (const [name, meta] of keywordMap) {
    if (fallbackPattern.test(name) && !/循环/.test(name)) candidates.push(meta)
  }
  return candidates.find((meta) => hasDataPayloadArgument(meta)) ?? undefined
}

function extractCyclePeriod(text: string): { period: string; hasPolling: boolean } {
  const periodMatch = text.match(/周期\s*\(\s*(\d+(?:\.\d+)?)\s*s?\s*\)|每\s*(\d+(?:\.\d+)?)\s*秒/)
  const period = periodMatch ? (periodMatch[1] || periodMatch[2]) : ""
  const hasPolling = /轮询/.test(text)
  return { period, hasPolling }
}

function extractFlowNames(outputFlow: string): string[] {
  return outputFlow
    .replace(/[a-f]\.\s*/g, "")
    .split(/[；;\n]/)
    .map(s => s.replace(/[。，,]$/, "").trim())
    .filter(s => s.length >= 2)
}

function resolvePlaceholders(
  keyword: KeywordMeta | undefined,
  overrides: Record<string, string>,
  defaultTime?: string,
): Record<string, string> {
  // 2026-08-20 事故修正:步骤计划是从需求上下文合成的,并不知道 worker 实际
  // 生成的步骤文本——合成参数值(3.0s 起步的时间序列、输入流名/整段接口描述、
  // "无")会与实际步骤错位,经 B1a 提示路径直接渲染进最终套件。计划只保留
  // 路由价值(关键字名/通道);参数值一律留给翻译阶段从实际步骤文本提取,
  // 未提取到的按用户拍板语义填充(指令ID 用例内分配 / 数据文件"指令·情况"说明)。
  void keyword
  void overrides
  void defaultTime
  return {}
}

/**
 * Generate a requirement-aware step plan based on the classified requirement pattern.
 * Different patterns produce different step sequences with appropriate keywords.
 */
export function generateRequirementStepPlan(args: {
  pattern: string
  handling: string
  chapterContent: string
  inputFlowName: string
  outputFlowName: string
  outputFlowRaw: string
  dualRedundant: boolean
  keywordMap: Map<string, KeywordMeta>
  channelKeywords: { cana_send: string; canb_send: string }
}): KeywordMatchResult {
  const { pattern, handling, chapterContent, inputFlowName, outputFlowName, outputFlowRaw, dualRedundant, keywordMap, channelKeywords } = args
  const stepPlan: StepPlan[] = []
  const warnings: string[] = []
  const allText = `${handling} ${chapterContent}`
  const { period, hasPolling } = extractCyclePeriod(allText)

  const canaSend = resolveSendKeyword(keywordMap, channelKeywords.cana_send, /^发送CANA/i)
  const canbSend = resolveSendKeyword(keywordMap, channelKeywords.canb_send, /^发送CANB/i)
  const busKeywords: KeywordMeta[] = []
  if (canaSend) busKeywords.push(canaSend)
  if (canbSend) busKeywords.push(canbSend)

  // Sequential timing: start at 3.0s, increment by 1.5s per step
  let timeOffset = 3.0
  const nextTime = () => { const t = timeOffset; timeOffset += 1.5; return t }

  // --- Pattern-specific step plan generation ---

  if (pattern === "telemetry_acquisition") {
    // This pattern: "采集FPGA遥测数据 → 组帧发送速变/缓变遥测"
    // The output flow names come from the requirement's outputFlow (e.g., "速变遥测数据", "缓变遥测数据")
    const flows = extractFlowNames(outputFlowRaw)
    const effectiveFlows = flows.length > 0 && flows[0] !== outputFlowName
      ? flows
      : (outputFlowName ? [outputFlowName] : ["速变遥测数据", "缓变遥测数据"])
    const sendKw = canaSend || canbSend

    // Step 1: Use memory-set or data-pool keyword to set FPGA telemetry input data
    const t0 = nextTime()
    const memSetKw = keywordMap.get("设置32位地址数据")
    stepPlan.push({
      step_index: 1,
      purpose: "set_input_data",
      description: `设置FPGA遥测输入数据，触发软件采集遥测数据`,
      keyword_name: memSetKw?.keywordName || "设置32位地址数据",
      bus_channel: "",
      argument_bindings: resolvePlaceholders(memSetKw, {}, String(t0)),
    })

    // Steps 2+: For each output flow (速变遥测, 缓变遥测), generate a verify step via CAN
    for (let i = 0; i < effectiveFlows.length; i++) {
      const flowName = effectiveFlows[i]

      // CANA step
      const t = nextTime()
      stepPlan.push({
        step_index: stepPlan.length + 1,
        purpose: "verify_telemetry",
        description: `验证软件通过CANA总线输出${flowName}`,
        keyword_name: sendKw?.keywordName || "",
        bus_channel: "CANA",
        argument_bindings: resolvePlaceholders(sendKw, {
          "${time}": String(t),
          "${para2}": flowName,
          "${para3}": period || "",
        }),
      })

      // CANB step (if dual redundant)
      if (dualRedundant) {
        const t2 = nextTime()
        stepPlan.push({
          step_index: stepPlan.length + 1,
          purpose: "verify_telemetry",
          description: `验证软件通过CANB总线输出${flowName}`,
          keyword_name: canbSend?.keywordName || "",
          bus_channel: "CANB",
          argument_bindings: resolvePlaceholders(canbSend, {
            "${time}": String(t2),
            "${para2}": flowName,
            "${para3}": period || "",
          }),
        })
      }
    }
  } else if (pattern === "command_execution") {
    // "接收X指令 → 执行Y操作/设置Y值"
    // CANA: send command → verify response
    const t1 = nextTime()
    stepPlan.push({
      step_index: 1,
      purpose: "send_command",
      description: `通过CANA总线发送${inputFlowName}，使被测件接收指令`,
      keyword_name: canaSend?.keywordName || "",
      bus_channel: "CANA",
      argument_bindings: resolvePlaceholders(canaSend, {
        "${time}": String(t1),
        "${para2}": inputFlowName,
        "${para3}": period || "",
      }),
    })

    const t2 = nextTime()
    stepPlan.push({
      step_index: 2,
      purpose: "verify_response",
      description: `验证软件接收到指令后正确处理并输出${outputFlowName}`,
      keyword_name: canaSend?.keywordName || "",
      bus_channel: "CANA",
      argument_bindings: resolvePlaceholders(canaSend, {
        "${time}": String(t2),
        "${para2}": outputFlowName,
        "${para3}": period || "",
      }),
    })

    if (dualRedundant) {
      const t3 = nextTime()
      stepPlan.push({
        step_index: 3,
        purpose: "send_command",
        description: `通过CANB总线发送${inputFlowName}，验证B总线备份`,
        keyword_name: canbSend?.keywordName || "",
        bus_channel: "CANB",
        argument_bindings: resolvePlaceholders(canbSend, {
          "${time}": String(t3),
          "${para2}": inputFlowName,
          "${para3}": period || "",
        }),
      })
      const t4 = nextTime()
      stepPlan.push({
        step_index: 4,
        purpose: "verify_response",
        description: `验证CANB总线下${outputFlowName}的响应`,
        keyword_name: canbSend?.keywordName || "",
        bus_channel: "CANB",
        argument_bindings: resolvePlaceholders(canbSend, {
          "${time}": String(t4),
          "${para2}": outputFlowName,
          "${para3}": period || "",
        }),
      })
    }
  } else if (pattern === "can_communication") {
    // "接收X轮询 → 发送Y数据" — CAN bus polling communication
    const t1 = nextTime()
    stepPlan.push({
      step_index: 1,
      purpose: "inject_input",
      description: `通过CANA总线发送${inputFlowName}，使被测件接收到输入数据`,
      keyword_name: canaSend?.keywordName || "",
      bus_channel: "CANA",
      argument_bindings: resolvePlaceholders(canaSend, {
        "${time}": String(t1),
        "${para2}": inputFlowName,
        "${para3}": period || "",
      }),
    })

    const t2 = nextTime()
    stepPlan.push({
      step_index: 2,
      purpose: "trigger_output",
      description: `通过CANA总线发送${outputFlowName}，触发被测件的数据输出处理`,
      keyword_name: canaSend?.keywordName || "",
      bus_channel: "CANA",
      argument_bindings: resolvePlaceholders(canaSend, {
        "${time}": String(t2),
        "${para2}": outputFlowName,
        "${para3}": period || "",
      }),
    })

    if (dualRedundant) {
      const t3 = nextTime()
      stepPlan.push({
        step_index: 3,
        purpose: "inject_input",
        description: `通过CANB总线发送${inputFlowName}，验证B总线备份功能`,
        keyword_name: canbSend?.keywordName || "",
        bus_channel: "CANB",
        argument_bindings: resolvePlaceholders(canbSend, {
          "${time}": String(t3),
          "${para2}": inputFlowName,
          "${para3}": period || "",
        }),
      })
      const t4 = nextTime()
      stepPlan.push({
        step_index: 4,
        purpose: "trigger_output",
        description: `通过CANB总线发送${outputFlowName}，验证B总线备份功能`,
        keyword_name: canbSend?.keywordName || "",
        bus_channel: "CANB",
        argument_bindings: resolvePlaceholders(canbSend, {
          "${time}": String(t4),
          "${para2}": outputFlowName,
          "${para3}": period || "",
        }),
      })
    }
  } else {
    // General/other patterns: minimal plan with CAN send if bus is CAN
    if (channelKeywords.cana_send && inputFlowName) {
      const t1 = nextTime()
      stepPlan.push({
        step_index: 1,
        purpose: "inject_input",
        description: `通过CANA总线发送${inputFlowName}`,
        keyword_name: canaSend?.keywordName || "",
        bus_channel: "CANA",
        argument_bindings: resolvePlaceholders(canaSend, {
          "${time}": String(t1),
          "${para2}": inputFlowName,
          "${para3}": period || "",
        }),
      })
      if (outputFlowName) {
        const t2 = nextTime()
        stepPlan.push({
          step_index: 2,
          purpose: "trigger_output",
          description: `通过CANA总线发送${outputFlowName}`,
          keyword_name: canaSend?.keywordName || "",
          bus_channel: "CANA",
          argument_bindings: resolvePlaceholders(canaSend, {
            "${time}": String(t2),
            "${para2}": outputFlowName,
            "${para3}": period || "",
          }),
        })
      }
    }
  }

  // 计划不再合成参数值(2026-08-20 事故修正),resolved_step_desc 的
  // 模板渲染也因此失去意义——保留路由字段,不产出渲染文本。
  void stepPlan

  return {
    input_keywords: busKeywords,
    output_keywords: busKeywords,
    bus_keywords: busKeywords,
    step_plan: stepPlan,
    dual_bus_generated: dualRedundant,
    pattern,
    warnings,
  }
}

/**
 * Match keywords based on the interface context (backward-compatible wrapper).
 */
export function matchKeywordsByInterface(
  interfaceContext: {
    bus_type: string
    dual_redundant: boolean
    input_flow_name: string
    output_flow_name: string
    channel_keywords: { cana_send: string; canb_send: string }
  },
  keywordMap: Map<string, KeywordMeta>,
  pattern?: string,
  handlingText?: string,
  chapterContent?: string,
  outputFlowRaw?: string,
): KeywordMatchResult {
  if (pattern && handlingText) {
    return generateRequirementStepPlan({
      pattern,
      handling: handlingText,
      chapterContent: chapterContent || "",
      inputFlowName: interfaceContext.input_flow_name,
      outputFlowName: interfaceContext.output_flow_name,
      outputFlowRaw: outputFlowRaw || interfaceContext.output_flow_name,
      dualRedundant: interfaceContext.dual_redundant,
      keywordMap,
      channelKeywords: interfaceContext.channel_keywords,
    })
  }
  // Fallback to simple match
  const { bus_type, dual_redundant, input_flow_name, output_flow_name, channel_keywords } = interfaceContext
  const canaSend = resolveSendKeyword(keywordMap, channel_keywords.cana_send, /^发送CANA/i)
  const canbSend = resolveSendKeyword(keywordMap, channel_keywords.canb_send, /^发送CANB/i)
  const stepPlan: StepPlan[] = []
  let timeOffset = 3.0
  if (bus_type !== "generic" && input_flow_name) {
    stepPlan.push({
      step_index: 1, purpose: "inject_input",
      description: `通过CANA总线发送${input_flow_name}`,
      keyword_name: canaSend?.keywordName || channel_keywords.cana_send,
      bus_channel: "CANA",
      argument_bindings: resolvePlaceholders(canaSend, { "${time}": String(timeOffset), "${para2}": input_flow_name, "${para3}": "" }),
    })
  }
  return {
    input_keywords: canaSend ? [canaSend] : [],
    output_keywords: canbSend ? [canbSend] : [],
    bus_keywords: [...(canaSend ? [canaSend] : []), ...(canbSend ? [canbSend] : [])],
    step_plan: stepPlan,
    dual_bus_generated: dual_redundant && bus_type !== "generic",
    pattern: pattern || "general",
    warnings: [],
  }
}

// ---------------------------------------------------------------------------
// Flat-field step plan building (B1a)
// ---------------------------------------------------------------------------
//
// Re-wires the pattern-based step plan templates to the current flat
// test-requirements fields, WITHOUT the protocol markdown dependency that the
// old extractInterfaceContext required (the third-party requirements DOCX
// chain was removed on 2026-08-14). Everything the plan templates need is
// derivable from the requirement text itself:
// - pattern: classifyRequirementPattern() is pure-text
// - dual redundancy: text heuristic (old effectiveDual fallback logic)
// - flow names: taken from the flat input/output flow fields
// - channel keywords: hardcoded preferred names + resolveSendKeyword()'s
//   library scan fallback (/^发送CANA/i, non-循环)

const DEFAULT_CANA_SEND_KEYWORD = "发送CANA数据_数据文件"
const DEFAULT_CANB_SEND_KEYWORD = "发送CANB数据_数据文件"

function cleanFlowName(raw: string): string {
  const first = raw.split(/[；;\n]/)[0] ?? ""
  return first
    .replace(/[a-f]\.\s*/g, "")
    .replace(/[。，,]$/, "")
    .trim()
}

export interface RequirementStepPlanBuildArgs {
  handling: string
  inputFlow: string
  outputFlow: string
  chapterContent: string
  keywordMap: Map<string, KeywordMeta>
}

/**
 * Build a requirement-level step plan from the flat test-requirements fields.
 * Deterministic: same inputs produce the same plan, so callers may recompute
 * it at translation time instead of reading it back from the manifest.
 */
export function buildRequirementStepPlan(
  args: RequirementStepPlanBuildArgs,
): KeywordMatchResult {
  const absentFlow = (value: string) => /^(?:无|无输入|无输出|无输入流|无输出流|不适用|none|n\/a)?[。．.\s]*$/i.test(value.replace(/[()（）]/g, "").trim())
  // No flow is not a CAN payload. A reference plan must not invent preconditions.
  if (absentFlow(args.inputFlow) && absentFlow(args.outputFlow)) {
    return {
      input_keywords: [], output_keywords: [], bus_keywords: [], step_plan: [],
      dual_bus_generated: false, pattern: "unknown",
      warnings: ["输入流和输出流未提供可操作数据，不生成发送参考步骤；操作依据须由需求或关联协议补全。"],
    }
  }
  const pattern = classifyRequirementPattern(
    args.handling,
    args.inputFlow,
    args.outputFlow,
    args.chapterContent,
  )
  const corpus = `${args.handling} ${args.inputFlow} ${args.outputFlow}`
  const dualRedundant = /CAN[AB].*CAN[AB]|互相备份/.test(corpus)

  return generateRequirementStepPlan({
    pattern,
    handling: args.handling,
    chapterContent: args.chapterContent,
    inputFlowName: cleanFlowName(args.inputFlow),
    outputFlowName: cleanFlowName(args.outputFlow),
    outputFlowRaw: args.outputFlow,
    dualRedundant,
    keywordMap: args.keywordMap,
    channelKeywords: {
      cana_send: DEFAULT_CANA_SEND_KEYWORD,
      canb_send: DEFAULT_CANB_SEND_KEYWORD,
    },
  })
}
