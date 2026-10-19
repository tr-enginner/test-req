/** Explicit test-system actions take precedence over anchors, plans and expected results. */
export function explicitStepAction(text: string): "external_interrupt" | "trap_interrupt" | "interrupt" | "observe" | null {
  const action = (text.split("\n")[0] ?? "").trim()
    .replace(/^(?:在)?第\s*[\d.]+\s*(?:秒|s)\s*[,，:：]?\s*/i, "")
  if (/^触发\s*外部中断/.test(action)) return "external_interrupt"
  if (/^触发\s*TRAP中断/i.test(action)) return "trap_interrupt"
  if (/^触发[^,，。；\n]{0,8}中断/.test(action)) return "interrupt"
  if (/^(?:监测|监视|观察|检查|验证|判断)/.test(action)) return "observe"
  return null
}

export function keywordMatchesStepAction(text: string, keywordName: string): boolean {
  switch (explicitStepAction(text)) {
    case "external_interrupt": return /^触发\s*外部中断/.test(keywordName)
    case "trap_interrupt": return /^触发\s*TRAP中断/i.test(keywordName)
    case "interrupt": return /^触发.{0,8}中断/.test(keywordName)
    case "observe": {
      if (!/^(?:监测|监视|观察|检查|验证|判断|读取|获取|开始.*记录|Watch|Validate|ManualJudge)/i.test(keywordName)) return false
      const channel = (text.split("\n")[0] ?? "").match(/二级\s*CAN|SPI|CAN[AB]?/i)?.[0].replace(/\s/g, "").toUpperCase()
      return !channel || keywordName.replace(/\s/g, "").toUpperCase().includes(channel)
    }
    default: return true
  }
}

/** Capture one send payload, stopping at top-level punctuation only (not inside nested qualifiers). */
export function extractSentPayload(text: string): string | undefined {
  const match = text.match(/通过[^,，。;；\n]{0,16}总线[^,，。;；\n]{0,40}?发送\s*/)
  if (!match || match.index === undefined) return undefined
  const tail = text.slice(match.index + match[0].length)
  const pairs: Record<string, string> = { "（": "）", "(": ")", "[": "]", "【": "】", "“": "”", "‘": "’", '"': '"', "'": "'", "「": "」", "『": "』" }
  const stack: string[] = []
  let end = tail.length
  for (let i = 0; i < tail.length; i++) {
    const char = tail[i]!
    if (stack.length && char === stack[stack.length - 1]) {
      stack.pop()
    } else if (pairs[char]) {
      stack.push(pairs[char]!)
    } else if (!stack.length && /[,，。;；\n]/.test(char)) {
      end = i
      break
    }
  }
  // Incomplete groups are not safe to convert to an executable payload.
  if (stack.length) return undefined
  let payload = tail.slice(0, end).trim().replace(/[。.!！]+$/, "").trim()
  if (/^[“"「『]/.test(payload) && pairs[payload[0]!] === payload.at(-1)) payload = payload.slice(1, -1)
  return payload || undefined
}

/** Primary telemetry readback is observation, not a trigger for secondary polling. */
export function isPrimaryTelemetryReadback(desc: string): boolean {
  return /通过(?:一级)?\s*CAN[AB]?\s*总线[^,，。;；\n]*发送\s*(?:全部正确的|正确的)?遥测帧[^,，。;；\n]*轮询控制序列/i.test(desc)
}

export function isPeriodicSend(desc: string): boolean {
  return /以\s*[\d.]+\s*(?:秒|s)为周期|循环发送|周期发送|每\s*[\d.]+\s*(?:秒|s)/i.test(desc)
}

/** Shared by translation and review: a successful status alone is not semantic evidence. */
export function translatedStepSemanticIssues(sourceDesc: string, translated: {
  key_name: string
  step_desc: string
  parameter: Array<{ Value: unknown; Comments?: string }>
}): string[] {
  const issues: string[] = []
  if (!keywordMatchesStepAction(sourceDesc, translated.key_name)) {
    issues.push(translated.key_name ? `关键字 ${translated.key_name} 与源步骤实际动作不一致` : "源步骤实际动作未匹配兼容关键字，须修订步骤或补充关键字，不能视为翻译成功")
  }
  const payload = extractSentPayload(sourceDesc)
  if (payload && /[（(【\[]/.test(payload)) {
    const normalized = (text: string) => text.replace(/[\s"“”‘’'「」『』]/g, "").replace(/，/g, ",").replace(/（/g, "(").replace(/）/g, ")")
    if (!normalized(translated.step_desc).includes(normalized(payload))) {
      issues.push("翻译步骤丢失发送载荷或括号内的包序、帧位、字段条件")
    }
    const dataArgs = translated.parameter.filter((p) => /文件|数据协议|数据流|数据包名称/.test(p.Comments ?? ""))
    if (dataArgs.length && !dataArgs.some((p) => normalized(String(p.Value)).includes(normalized(payload)))) {
      issues.push("关键字载荷参数丢失源步骤的完整字段条件，不能仅修补显示文字")
    }
  }
  return issues
}
