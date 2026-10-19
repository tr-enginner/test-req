function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function withoutTerminalFlowPunctuation(value: string): string {
  return value.replace(/[。；]+$/u, "").trimEnd()
}

export function formatFunctionalFlowItems(values: string[] | undefined): string[] {
  const items = Array.isArray(values) ? values.map(textOf).filter(Boolean) : []
  if (items.length === 0) return ["无。"]

  const normalized = items.map(withoutTerminalFlowPunctuation)
  if (normalized.length === 0 || normalized.every((value) => value === "无")) return ["无。"]

  if (normalized.length === 1) {
    return [`${normalized[0]}。`]
  }

  return normalized.map((value, index) => {
    const label = `${String.fromCharCode(97 + index)}.`
    const punctuation = index === normalized.length - 1 ? "。" : "；"
    return `${label} ${value}${punctuation}`
  })
}
