import { readFileSync } from "fs"

/** Repair JSON syntax only; never coerce malformed business data. */
export function parsePhase2Json(text: string): any {
  let raw = text.replace(/^\uFEFF/, "").trim()
  if (raw.startsWith("```")) raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
  if (!raw.startsWith("{") && !raw.startsWith("[") && raw !== "null") {
    const start = raw.indexOf("{"), end = raw.lastIndexOf("}")
    if (start >= 0 && end > start) raw = raw.slice(start, end + 1)
  }
  try { return JSON.parse(raw) } catch { /* Remove trailing commas outside strings. */ }
  let result = "", quoted = false, escaped = false
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]
    if (!quoted && char === "," && /^\s*[}\]]/.test(raw.slice(i + 1))) continue
    result += char
    if (quoted) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') quoted = false
    } else if (char === '"') quoted = true
  }
  return JSON.parse(result)
}

export function readPhase2Json(path: string): any {
  return parsePhase2Json(readFileSync(path, "utf-8"))
}
