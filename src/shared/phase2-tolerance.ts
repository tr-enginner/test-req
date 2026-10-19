import { AsyncLocalStorage } from "node:async_hooks"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { readPhase2Json } from "./phase2-json"

type Diagnostics = { warnings: string[]; skipped_count: number; reserved_ids: string[] }
const diagnostics = new AsyncLocalStorage<Diagnostics>()

export function phase2Warning(message: string, skipped = 0): void {
  const state = diagnostics.getStore()
  if (state) { state.warnings.push(message); state.skipped_count += skipped }
}

export function reservedPhase2Ids(): string[] { return diagnostics.getStore()?.reserved_ids || [] }
export function phase2Warnings(): string[] { return [...new Set(diagnostics.getStore()?.warnings || [])] }

export async function withPhase2Diagnostics(mode: string, run: () => Promise<string>, directory?: string, options: { compactSuccess?: boolean } = {}): Promise<string> {
  return diagnostics.run({ warnings: [], skipped_count: 0, reserved_ids: [] }, async () => {
    try {
      if (directory && mode.startsWith("finalize")) {
        const path = resolve(directory, ".matrix/data/phase2-editor-state.json")
        if (existsSync(path)) {
          const ids = readPhase2Json(path).tombstoned_requirement_ids
          if (!Array.isArray(ids) || ids.some(id => typeof id !== "string")) throw new Error("Invalid phase2 editor tombstoned_requirement_ids")
          diagnostics.getStore()!.reserved_ids = ids
        }
      }
      const result = JSON.parse(await run())
      if (options.compactSuccess && result.ok === true && !result.error) return JSON.stringify(result, null, 2)
      const state = diagnostics.getStore()!
      return JSON.stringify({ ...result, ok: result.ok !== false && !result.error, mode,
        warnings: [...new Set([...(result.warnings || []), ...state.warnings])],
        skipped_count: state.skipped_count }, null, 2)
    } catch (error) {
      return JSON.stringify({ ok: false, mode, error: error instanceof Error ? error.message : String(error) })
    }
  })
}

/** Supply only optional reference defaults; incorrect types remain schema errors. */
export function referenceDefaults(value: any): any {
  if (Array.isArray(value)) return value.map(referenceDefaults)
  if (!value || typeof value !== "object") return value
  const result: any = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, referenceDefaults(child)]))
  for (const key of ["source_refs", "table_refs"]) if (key in result && result[key] == null) result[key] = []
  return result
}

export function relaxedReferenceSchema(schema: any): any {
  if (Array.isArray(schema)) return schema.map(relaxedReferenceSchema)
  if (!schema || typeof schema !== "object") return schema
  const result: any = Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, relaxedReferenceSchema(value)]))
  if (result.required) result.required = result.required.filter((key: string) => !["source_refs", "source_ref", "table_refs", "table_id"].includes(key))
  for (const key of ["source_refs", "table_refs"]) {
    if (result.properties?.[key]) result.properties[key] = { type: "array", items: { type: "string" }, default: [] }
  }
  for (const key of ["source_ref", "table_id"]) {
    if (result.properties?.[key]) result.properties[key] = { type: "string", default: "" }
  }
  if (result.properties?.requirement_id) result.properties.requirement_id = { type: "string", default: "" }
  if (result.properties?.columns) {
    delete result.properties.columns.minItems
    delete result.properties.columns.maxItems
  }
  return result
}

export function normalizeLocalTables<T extends { title_no?: string; tables?: any[]; processing?: any[] }>(item: T, initialization = false): T {
  const occupied = new Set<string>((item.tables || []).map(table => String(table.table_id || "").trim()).filter(Boolean))
  const seen = new Set<string>()
  const tables = (item.tables || []).flatMap((table, index) => {
    const columns = table.columns.map((column: string) => column.trim())
    const initColumns = ["名称", "地址/寄存器地址", "初值", "初值含义"]
    const valid = columns.length > 0 && columns.every(Boolean) && new Set(columns).size === columns.length
      && (!initialization || JSON.stringify(columns) === JSON.stringify(initColumns))
      && table.rows.every((row: any) => Object.keys(row).length === columns.length && columns.every((column: string) => column in row))
    if (!valid) { phase2Warning(`${item.title_no}: 跳过列与行不匹配的表格 ${index + 1}`, 1); return [] }
    let id = String(table.table_id || "").trim()
    if (!id || seen.has(id)) {
      id = `LOCAL-${item.title_no}-${index + 1}`
      while (occupied.has(id)) id += "-1"
      occupied.add(id)
      phase2Warning(`${item.title_no}: 表格编号已归一化为 ${id}`)
    }
    seen.add(id)
    const rows = initialization
      ? table.rows.map((row: any) => ({
          ...row,
          "地址/寄存器地址": String(row["地址/寄存器地址"] || "").trim() || "XX",
          "初值": String(row["初值"] || "").trim() || "XX",
          "初值含义": String(row["初值含义"] || "").trim() || "XX",
        }))
      : table.rows
    return [{ ...table, table_id: id, columns, rows }]
  })
  const byId = new Map(tables.map(table => [table.table_id, table]))
  const order = new Set<string>()
  const processing = (item.processing || []).map(entry => {
    const refs = [...new Set<string>((entry.table_refs || []).map((ref: string) => ref.trim()))].filter(ref => {
      if (byId.has(ref)) { order.add(ref); return true }
      phase2Warning(`${item.title_no}: 跳过不存在的表格引用 ${ref}`, 1)
      return false
    })
    return { ...entry, table_refs: refs }
  })
  for (const table of tables) order.add(table.table_id)
  let sequence = 1
  for (const id of order) byId.get(id)!.table_no = `表${item.title_no}-${sequence++}`
  return { ...item, processing, tables: [...order].map(id => byId.get(id)!) }
}
