import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { fileFingerprint, loadEditMapping, mappingValueAt, safeMappingPath } from "../shared/phase2-edit-mapping"
import { readPhase2Json } from "../shared/phase2-json"

export class UneditableTarget extends Error {}

export function mappedEditorTarget(request: { directory: string; artifact: string; business_id?: string; container_id?: string; identity?: any }) {
  const finalFile = safeMappingPath(request.directory, resolve(request.directory, ".matrix/data", request.artifact))
  if (!existsSync(finalFile)) return undefined
  const mapping = loadEditMapping(request.directory, finalFile)
  if (!mapping) return undefined
  const final = readPhase2Json(finalFile)
  const candidates = mapping.entries.filter(entry => {
    const node = mappingValueAt(final, entry.final_path)
    if (!node) return false
    if (request.business_id) return (node.requirement_id || node.test_requirement_id) === request.business_id
    if (request.container_id || request.identity?.title_no) return node.title_no === (request.container_id || request.identity?.title_no)
    if (request.identity?.interface_id || request.identity?.candidate_id) return node.interface_id === request.identity?.interface_id || (request.identity?.candidate_id && node.candidate_id === request.identity.candidate_id)
    return entry.final_path.length === 0
  })
  if (!candidates.length) throw new UneditableTarget("该内容没有可编辑raw目标（可能为缺项占位），请重新生成对应内容")
  if (!request.business_id && request.artifact === "interface-test-content.json" && request.identity?.interface_id && candidates.length) {
    const files = [...new Set(candidates.map(entry => entry.file))]
    if (files.length !== 1) throw new Error("接口容器对应多个raw批次，请选择具体需求编辑")
    const rawFile = safeMappingPath(request.directory, files[0])
    if (fileFingerprint(rawFile) !== candidates[0].hash) throw new Error("raw编辑映射已过期，请重新生成并刷新")
    const raw = readPhase2Json(rawFile)
    return {rawFile, raw, files: [rawFile], collection: raw.rows, index: -1, item: raw, prefix: "TR-JK"}
  }
  if (candidates.length !== 1) throw new Error("编辑目标映射不唯一，拒绝修改")
  const entry = candidates[0], rawFile = safeMappingPath(request.directory, entry.file)
  if (fileFingerprint(rawFile) !== entry.hash) throw new Error("raw编辑映射已过期，请重新生成并刷新")
  const raw = readPhase2Json(rawFile), value = mappingValueAt(raw, entry.path)
  if (!value || typeof value !== "object") throw new Error("编辑映射目标不存在")
  const finalValue = mappingValueAt(final, entry.final_path)
  const parent = mappingValueAt(raw, entry.path.slice(0, -1))
  const arrayItem = Array.isArray(parent)
  const leaf = Array.isArray(value.processing)
  const requirement = Boolean(request.business_id)
  const itemPath = requirement && entry.path.at(-2) === "processing" ? entry.path.slice(0, -2) : entry.path
  const item = mappingValueAt(raw, itemPath)
  const fieldMap: Record<string, string> = {}
  for (const child of mapping.entries) {
    if (child.final_path.slice(0, entry.final_path.length).join("\0") !== entry.final_path.join("\0")) continue
    const suffix = child.final_path.slice(entry.final_path.length)
    if (suffix.length === 2 && ["tables", "memory_io_tables"].includes(suffix[0]) && child.file === entry.file) {
      fieldMap[suffix.join(".")] = child.path.slice(entry.path.length).join(".")
    }
  }
  return { rawFile, raw, files: [rawFile], finalValue, fieldMap,
    object: entry.path.length === 0 && !Array.isArray(value.rows),
    collection: leaf ? value.processing : arrayItem ? parent : value.rows || [value],
    index: leaf ? -1 : arrayItem ? Number(entry.path.at(-1)) : entry.path.length ? 0 : -1,
    item: leaf || requirement ? item : value,
    prefix: finalValue.tr_code || (requirement ? String(request.business_id).replace(/-\d+$/, "") : undefined),
    readOnly: request.artifact === "hardware-interface-model.json" ? ["candidate_id", "interface_id", "interface_kind"] : [],
  }
}
