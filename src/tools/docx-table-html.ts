function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function topLevelElements(xml: string, tag: string): string[] {
  const result: string[] = []
  const token = new RegExp(`<\\/?w:${tag}\\b[^>]*>`, "g")
  let depth = 0
  let start = -1
  for (const match of xml.matchAll(token)) {
    const value = match[0]
    if (!value.startsWith("</")) {
      if (depth === 0) start = match.index ?? -1
      if (!value.endsWith("/>")) depth += 1
    } else {
      depth -= 1
      if (depth === 0 && start >= 0) {
        result.push(xml.slice(start, (match.index ?? 0) + value.length))
        start = -1
      }
    }
  }
  return result
}

function textFromXml(xml: string): string {
  return Array.from(xml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g))
    .map((match) => decodeXml(match[1]))
    .join("")
    .trim()
}

interface HtmlCell {
  text: string
  colSpan: number
  rowSpan: number
  nestedTables: string[]
}

function gridSpan(cellXml: string): number {
  const match = cellXml.match(/<w:gridSpan\b[^>]*\bw:val="(\d+)"/)
  return match ? Math.max(1, Number.parseInt(match[1], 10)) : 1
}

function verticalMerge(cellXml: string): "restart" | "continue" | null {
  const match = cellXml.match(/<w:vMerge\b([^>]*)\/?>(?:<\/w:vMerge>)?/)
  if (!match) return null
  return /\bw:val="restart"/.test(match[1]) ? "restart" : "continue"
}

export function docxTableXmlToHtml(tableXml: string): string {
  const rows: HtmlCell[][] = []
  const active = new Map<number, HtmlCell>()

  for (const rowXml of topLevelElements(tableXml, "tr")) {
    const row: HtmlCell[] = []
    const extended = new Set<HtmlCell>()
    let column = 0
    for (const cellXml of topLevelElements(rowXml, "tc")) {
      const colSpan = gridSpan(cellXml)
      const merge = verticalMerge(cellXml)
      if (merge === "continue") {
        let found = false
        for (let offset = 0; offset < colSpan; offset += 1) {
          const origin = active.get(column + offset)
          if (origin && !extended.has(origin)) {
            origin.rowSpan += 1
            extended.add(origin)
            found = true
          }
        }
        if (found) {
          column += colSpan
          continue
        }
      }

      const nestedXml = topLevelElements(cellXml, "tbl")
      let textXml = cellXml
      for (const nested of nestedXml) textXml = textXml.replace(nested, "")
      const paragraphs = topLevelElements(textXml, "p").map(textFromXml).filter(Boolean)
      const cell: HtmlCell = {
        text: paragraphs.join("\n"),
        colSpan,
        rowSpan: 1,
        nestedTables: nestedXml.map(docxTableXmlToHtml),
      }
      row.push(cell)
      for (let offset = 0; offset < colSpan; offset += 1) {
        if (merge === "restart") active.set(column + offset, cell)
        else active.delete(column + offset)
      }
      column += colSpan
    }
    rows.push(row)
  }

  const lines = ["<table>"]
  for (const row of rows) {
    lines.push("  <tr>")
    for (const cell of row) {
      const attrs = [
        cell.rowSpan > 1 ? `rowspan="${cell.rowSpan}"` : "",
        cell.colSpan > 1 ? `colspan="${cell.colSpan}"` : "",
      ].filter(Boolean)
      const content = [escapeHtml(cell.text).replace(/\n/g, "<br>"), ...cell.nestedTables]
        .filter(Boolean)
        .join(cell.text && cell.nestedTables.length ? "<br>" : "")
      lines.push(`    <td${attrs.length ? ` ${attrs.join(" ")}` : ""}>${content}</td>`)
    }
    lines.push("  </tr>")
  }
  lines.push("</table>")
  return lines.join("\n")
}

export function htmlTableText(html: string): string {
  return decodeXml(html
    .replace(/<br\s*\/?\s*>/gi, " ")
    .replace(/<\/?(?:table|tr|td|th)\b[^>]*>/gi, " "))
    .replace(/\s+/g, " ")
    .trim()
}
