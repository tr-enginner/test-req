import { createHash, randomUUID } from "node:crypto"
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { readPhase2Json } from "./phase2-json"

type Origin = { file: string; path: string[]; hash: string }
export type EditMapping = Origin & { final_path: string[]; identity?: Record<string, string> }
const origin = Symbol("phase2-raw-origin")
export const fileFingerprint = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex")
const at = (value: any, path: string[]) => path.reduce((node, key) =>
  node && typeof node === "object" && !["__proto__", "prototype", "constructor"].includes(key) && Object.hasOwn(node, key) ? node[key] : undefined, value)

/** Enumerable symbols survive object spreads but never enter persisted JSON. */
export function trackRaw<T>(value: T, file: string, path: string[] = [], hash = fileFingerprint(file)): T {
  if (value && typeof value === "object") {
    if (!Array.isArray(value)) (value as any)[origin] = { file: resolve(file), path, hash }
    for (const [key, child] of Object.entries(value)) trackRaw(child, file, [...path, key], hash)
  }
  return value
}

/** Only for schema clones of the same tree, before any filtering or reordering. */
export function carryOrigins<T>(source: any, target: T): T {
  if (source && target && typeof source === "object" && typeof target === "object") {
    if (source[origin]) (target as any)[origin] = source[origin]
    for (const key of Object.keys(target)) carryOrigins(source[key], (target as any)[key])
  }
  return target
}

function workspace(file: string) {
  let dir = dirname(resolve(file))
  while (dirname(dir) !== dir) {
    if (dir.endsWith(`${sep}.matrix${sep}data`)) return resolve(dir, "../..")
    dir = dirname(dir)
  }
  throw new Error("编辑映射文件必须位于 .matrix/data 内")
}
export function safeMappingPath(directory: string, path: string) {
  const root = resolve(directory, ".matrix/data"), target = resolve(directory, path)
  const rel = relative(root, target)
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("编辑映射路径超出数据目录")
  if (existsSync(target)) {
    const actual = relative(realpathSync(root), realpathSync(target))
    if (actual.startsWith("..") || isAbsolute(actual)) throw new Error("编辑映射路径跨越数据目录")
  }
  return target
}

export function publishEditMapping(finalFile: string, model: any) {
  const directory = workspace(finalFile), stateFile = resolve(directory, ".matrix/data/phase2-editor-state.json")
  const state = existsSync(stateFile) ? readPhase2Json(stateFile) : { version: 1, next_sequences: {}, tombstoned_requirement_ids: [] }
  const entries: EditMapping[] = []
  const fingerprints = new Map<string, string>()
  const visit = (node: any, path: string[]) => {
    if (!node || typeof node !== "object") return
    const source: Origin | undefined = node[origin]
    if (source) {
      safeMappingPath(directory, source.file)
      if (!fingerprints.has(source.file)) fingerprints.set(source.file, fileFingerprint(source.file))
      if (fingerprints.get(source.file) !== source.hash) throw new Error("raw在生成期间发生变化，请重试")
      const identity = Object.fromEntries(["requirement_id", "test_requirement_id", "title_no", "interface_id", "candidate_id", "table_id"]
        .filter(key => typeof node[key] === "string").map(key => [key, node[key]]))
      entries.push({ ...source, file: relative(directory, source.file), final_path: path, identity })
    }
    for (const [key, child] of Object.entries(node)) visit(child, [...path, key])
  }
  visit(model, [])
  state.edit_mappings ||= { version: 1, artifacts: {} }
  if (state.edit_mappings.version !== 1) throw new Error("不支持的编辑映射版本")
  state.edit_mappings.artifacts[relative(directory, finalFile)] = { final_hash: fileFingerprint(finalFile), entries }
  const temporary = `${stateFile}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(state, null, 2), "utf8")
  renameSync(temporary, stateFile)
}

export function loadEditMapping(directory: string, finalFile: string) {
  const stateFile = resolve(directory, ".matrix/data/phase2-editor-state.json")
  if (!existsSync(stateFile)) return undefined
  const mappings = readPhase2Json(stateFile).edit_mappings
  if (!mappings) return undefined
  if (mappings.version !== 1) throw new Error("不支持的编辑映射版本")
  const mapping = mappings.artifacts?.[relative(directory, finalFile)]
  if (!mapping) return undefined
  if (mapping.final_hash !== fileFingerprint(finalFile)) throw new Error("最终产物编辑映射已过期，请重新生成")
  return mapping as { final_hash: string; entries: EditMapping[] }
}

export function restoreEditOrigins<T>(file: string, value: T): T {
  let directory: string
  try { directory = workspace(file) } catch { return value }
  const mapping = loadEditMapping(directory, file)
  if (!mapping && file.endsWith(".raw.json")) return trackRaw(value, file)
  const fingerprints = new Map<string, string>()
  for (const entry of mapping?.entries || []) {
    const rawFile = safeMappingPath(directory, entry.file)
    if (!fingerprints.has(rawFile)) fingerprints.set(rawFile, fileFingerprint(rawFile))
    if (fingerprints.get(rawFile) !== entry.hash) throw new Error("raw编辑映射已过期，请重新生成")
    const node = at(value, entry.final_path)
    if (node && typeof node === "object") node[origin] = { file: rawFile, path: entry.path, hash: entry.hash }
  }
  return value
}

export const mappingValueAt = at
