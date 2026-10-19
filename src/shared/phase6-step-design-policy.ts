/** Shared source-step constraints. Never repair protocol sequences by inventing packets. */
export const MULTIPACKET_SEQUENCE_RULE = "有序多包（含双辅助数据包）统一采用：正确包1→包1单字段错误→正确包2→包2另一单字段错误→…→正确包n。每步只发送一个完整包；滤掉错误包后必须恰为包1至包n，不跳包、不重复正确包。错误覆盖在全部包之间分摊，首/中/尾帧仅覆盖实际适用字段，不要求每包穷举。若错误项多于前n-1包的交错位置，将剩余未覆盖错误逐项使用包n、在正确包n之前连续发送，最后以完整正确包n收尾；若错误已覆盖完，剩余包连续正确发送即可。不得为覆盖错误反复重启正确包序列，不得以末包错误收尾；仅需求明确要求多轮运行时才重复完整业务序列。末包不含待测字段时按真实格式在含该字段的包上安排，不得编造字段位置，无法满足编排则报告约束冲突。正确包处理并更新需求规定计数，错误包丢弃且正确计数不增，错误计数仅依需求递增；末包正确后验证完整业务响应。"

export const ACTIONABLE_STEP_RULE = "步骤正文只写测试人员/测试系统可执行的动作及具体对象；指令名称必须来自需求、关联需求或协议定义，不能编造‘配置指令’‘控制指令’等泛称。输入流/输出流为‘无’不代表存在可发送的数据；缺少必要指令依据应反馈上下文缺口。‘使某功能开启’等效果放入预期结果或括号说明，不与操作正文混写。边界设计角色只用于选值，步骤正文写实际数值；如需说明下边界-1等角色，只放在括号中，不能以角色名代替取值。"

/** A scheduled start, not a payload value, waiting duration or expected result. */
export function startsAtZeroTime(value: unknown): boolean {
  if (typeof value !== "string") return false
  const text = value.trim()
  const match = text.match(/^(?:在\s*)?(第\s*|t\s*[=＝]\s*)?(?:0+(?:\.0+)?|零)\s*(?:毫秒|秒|分钟|小时|ms\b|s\b|min\b|h\b)/i)
  if (!match) return false
  // A bare “0秒后检查” is a relative delay, not “第0秒”/“t=0s”.
  return !!match[1] || !/^\s*(?:之后|以后|后)/.test(text.slice(match[0].length))
}

export function withoutParentheses(text: string): string {
  let depth = 0
  let result = ""
  for (const char of text) {
    if (char === "（" || char === "(") depth++
    else if (char === "）" || char === ")") depth = Math.max(0, depth - 1)
    else if (!depth) result += char
  }
  return result
}

function cnNumber(text: string): number {
  if (/^\d+$/.test(text)) return Number(text)
  const digits = "零一二三四五六七八九"
  if (text === "两") return 2
  if (text.includes("十")) {
    const [a, b] = text.split("十")
    return (a ? digits.indexOf(a) : 1) * 10 + (b ? digits.indexOf(b) : 0)
  }
  return digits.indexOf(text)
}

const PACKET_ROLE = /(?:最后一|末|尾)包|第\s*([零一二三四五六七八九十两\d]+)\s*包|(?:数据包|包)\s*([零一二三四五六七八九十两\d]+)/

/** Keep payload annotations, but not a following observation/purpose clause. */
function operationPayload(desc: string): string | null {
  const action = desc.match(/(?:发送|下发|注入|输入|设置)\s*(.*)/)
  if (!action) return null
  let depth = 0
  let payload = ""
  for (const char of action[1]!) {
    if (!depth && /[,，。;；\n]/.test(char)) break
    if (char === "（" || char === "(") depth++
    else if (char === "）" || char === ")") depth = Math.max(0, depth - 1)
    payload += char
  }
  // “轮询控制序列（用于读取遥测包2）” sends a command, not packet 2.
  return payload.split(/[（(]\s*(?:用于|用以|以便|读取|检查|验证|确认|观察)|用于|用以|以便/)[0]!
}

/** A word such as 周期 in a command name is not a background stream. */
export function isPeriodicSendDeclaration(desc: string): boolean {
  const body = withoutParentheses(desc)
  return /以\s*[^，,。；;]{1,24}为周期[^。；;]*(?:发送|下发|注入|输入)/.test(body)
    || /每\s*(?:\d+(?:\.\d+)?|一|隔\s*\d+(?:\.\d+)?)\s*(?:毫秒|秒|分钟|小时|ms|s|min|h)[^。；;]*(?:发送|下发|注入|输入)/i.test(body)
    || /(?:循环|持续|周期性?)(?:地)?\s*(?:发送|下发|注入|输入)/.test(body)
}

export function packetRole(desc: string): number | "last" | null {
  const match = (operationPayload(desc) ?? desc).match(PACKET_ROLE)
  if (!match) return null
  return match[1] || match[2] ? cnNumber(match[1] ?? match[2]!) : "last"
}

export function packetOperationIdentity(desc: string): string | null {
  // Preserve the noun in “辅助数据包1” while removing its ordinal.
  return operationIdentity(desc.replace(PACKET_ROLE, (match) => /^数据包/.test(match) ? "数据包" : /^包/.test(match) ? "包" : ""))
}

export function stepValidity(desc: string): "correct" | "error" | "unknown" {
  const text = desc
    .replace(/其[余他][^，,。；;）)]{0,12}(?:正确|有效|合法|正常)/g, "")
    .replace(/错误(?:指令|数据|帧|包)?(?:接收|处理)?(?:计数|统计)(?:器)?/g, "")
    .replace(/(?:没有|不存在|未发生|不发生|无)(?:错误|丢失|重复)|不(?:丢失|重复)/g, "")
  if (/错误|非法|无效|不合法|不正确|丢失|重复|不连续|非\s*4\s*字节对齐|[^正]错/.test(text)) return "error"
  return /正确|合法|有效|正常/.test(text) ? "correct" : "unknown"
}

/** Payload identity includes channel but excludes error/value annotations and send scheduling. */
export function operationIdentity(desc: string): string | null {
  const body = withoutParentheses(desc)
  const rawPayload = operationPayload(body)
  if (!rawPayload) return null
  const payload = rawPayload
    // Error modifiers belong to the input variant, not to the instruction name.
    .replace(/^[^，,。；;]{1,32}?(?:错误|非法|无效|不正确)的/, "")
    .replace(/^(?:全部|完整|随机|正确|错误|非法|合法|无效|有效|正常|的|一个|一条)+/, "")
    .replace(/((?:指令|控制序列|数据块|数据包|应答)(?:第\s*[零一二三四五六七八九十两\d]+\s*包)?)(?:的|[-—－])?(?:首帧|中间帧|尾帧|仲裁场|控制场|帧序号|长度字段|[A-Z][A-Z\d_]*)[^，,。；;]*(?:错误|非法|无效|错).*$/i, "$1")
    .replace(/\s+/g, "")
  const bus = body.match(/二级\s*CAN[AB]?|一级\s*CAN[AB]?|CAN[AB]?|SPI|SpaceWire/i)?.[0].replace(/一级|\s/g, "").toUpperCase() ?? ""
  return payload ? `${bus}:${payload}` : null
}

export function hasMultipleOperations(desc: string): boolean {
  const body = withoutParentheses(desc)
  // “设置长度字段为249” qualifies this input; a separate memory write/trigger
  // still represents another operation and must remain in its own step.
  const operationBody = body.replace(/([，,]\s*)设置(?!(?:内存|地址|寄存器))(?=[^，,。；;]{1,20}(?:字段|参数)(?:为|=))/g, "$1指定")
  const actionCount = [...operationBody.matchAll(/发送|下发|注入|(?:^|[，,；;])\s*(?:然后|再|并)?\s*(?:设置|触发|输入)/g)].length
  // Ignore metadata such as “输入与输出帧间隔”; inspect actual sends/settings.
  if (/发送|下发|注入/.test(body) && actionCount > 1) return true
  const payload = body.match(/(?:发送|下发|注入|输入|设置)(.*)/)?.[1] ?? ""
  return /遥测帧\s*\d+\s*[~～至到、]\s*\d+|辅助数据包\s*\d+\s*[~～至到、,，和及]\s*\d+/.test(body)
    || /(?:指令|控制序列|数据块|数据包|遥测|应答)[^，,。；;]*[、或和及][^，,。；;]*(?:指令|控制序列|数据块|数据包|遥测|应答)/.test(payload)
    || /\d+\s*字节\s*或\s*\d+\s*字节/.test(desc)
}

export interface PacketSequenceAnalysis {
  issues: Array<{ step_index: number; message: string }>
  /** All numbered packet sends, including invalid ones, are owned by this validator. */
  stepIndexes: Set<number>
}

export function analyzePacketSequences(
  steps: Array<{ 步骤描述: string; 预期结果: string }>,
  options: { corpus?: string; required?: boolean; packetCount?: number; requireKnownPacketRoles?: boolean } = {},
): PacketSequenceAnalysis {
  const issues: PacketSequenceAnalysis["issues"] = []
  const stepIndexes = new Set<number>()
  type Event = { index: number; role: number | "last"; kind: ReturnType<typeof stepValidity>; desc: string }
  const groups = new Map<string, Event[]>()
  steps.forEach((step, index) => {
    const desc = step.步骤描述
    const role = packetRole(desc)
    // Periodic setup declares a stream; it is not a single accepted-packet event.
    if (!/发送|下发|注入|输入/.test(desc) || isPeriodicSendDeclaration(desc)) return
    if (role === null) {
      if ((options.required || options.requireKnownPacketRoles) && /249\s*字节上行数据(?:块|包)/.test(desc)) {
        issues.push({ step_index: index, message: "有序多包发送须明确包号，不能仅写发送249字节上行数据块。" })
        stepIndexes.add(index)
      }
      return
    }
    const identity = packetOperationIdentity(desc)
    if (!identity) return
    const events = groups.get(identity) ?? []
    events.push({ index, role, kind: stepValidity(desc), desc })
    groups.set(identity, events)
  })
  if (options.required && !groups.size) issues.push({ step_index: 0, message: "多包步骤须明确每个包的包号、完整正确或单字段错误状态，不能只写发送数据块。" })
  for (const [identity, events] of groups) {
    const numericRoles = events.flatMap((event) => typeof event.role === "number" ? [event.role] : [])
    const hasLast = events.some((event) => event.role === "last")
    // Use an explicit protocol total when available, not a guessed byte/frame count.
    const totals = [...(options.corpus ?? "").matchAll(/(?:共|总计|总包数[为是：:]?|分为)\s*([\d一二三四五六七八九十两]+)\s*(?:个)?包/g)].map((m) => cnNumber(m[1]!))
    const declared = new Set(totals)
    const explicitTotal = options.packetCount ?? (/辅助数据/.test(identity) ? 2 : declared.size === 1 && groups.size === 1 ? totals[0] : undefined)
    const largestNumericRole = Math.max(0, ...numericRoles)
    // If packet n appears only as pre-final errors, “最后一包” is that same n,
    // not an invented n+1. A correct numeric packet followed by “末包” instead
    // advances to the next packet, unless the protocol declares an explicit total.
    const largestHasCorrect = events.some(event => event.role === largestNumericRole && event.kind === "correct")
    const total = explicitTotal
      ?? largestNumericRole + (hasLast && (largestHasCorrect || !largestNumericRole) ? 1 : 0)
    // A single named packet (e.g. telemetry packet 1) need not be a multi-packet transfer.
    if (!options.required && !hasLast && !explicitTotal && total < 2 && !/249\s*字节上行数据/.test(identity)) continue
    events.forEach((event) => stepIndexes.add(event.index))
    const fail = (event: Event, detail: string) => issues.push({ step_index: event.index, message: `多包序列：${detail}；须按包1至包n推进正确包，剩余错误在末包正确之前覆盖，最终以完整正确末包收尾。` })
    if (total < 2) { fail(events[0]!, "无法确认完整多包数量/末包，不能仅重复第一包"); continue }
    let next = 1
    let previous: Event | undefined
    let terminalErrors = false
    let correctOnlyTail = false
    let rounds = 0
    for (const event of events) {
      const role = event.role === "last" ? total : event.role
      if (role < 1 || role > total || event.kind === "unknown") { fail(event, "包号越界或未说明正确/单错误状态"); continue }
      if (next > total) {
        // Do not recycle the stream merely to enumerate additional error fields.
        const repeatAllowed = /(?:多轮|每轮|反复|循环运行|重复(?:运行|执行|测试))/.test(options.corpus ?? "")
        if (!repeatAllowed || event.kind !== "correct" || role !== 1) { fail(event, "末包正确后不得追加错误包或无依据地重启第一包"); continue }
        next = 1; terminalErrors = false; correctOnlyTail = false; previous = undefined
      }
      if (event.kind === "correct") {
        if (role !== next) fail(event, `正确包顺序不完整：当前应发送包${next}，实际为包${role}`)
        if (previous?.kind === "correct") correctOnlyTail = true
        next = role + 1
        if (role === total) rounds++
      } else {
        const previousRole = previous?.role === "last" ? total : previous?.role
        const interleaved = !terminalErrors && previous?.kind === "correct" && previousRole === role && role < total
        const terminal = role === total && next === total
        if (correctOnlyTail || (!interleaved && !terminal)) fail(event, "错误未紧随同包正确步骤，或在错误尚未覆盖时提前连续发送正确包")
        if (terminal) terminalErrors = true
      }
      previous = event
    }
    if (!rounds || next !== total + 1 || previous?.kind !== "correct") fail(events.at(-1)!, "缺少完整正确末包或遗留半轮业务序列")
  }
  return { issues, stepIndexes }
}
