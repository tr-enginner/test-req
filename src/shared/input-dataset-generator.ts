import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import {
  InputDatasetFile,
  type InputDatasetFile as InputDatasetFileType,
  type InputDatasetIndexEntry,
  type InputDatasetRecord,
} from "./input-dataset-schema"
import { type ProtocolField, type ProtocolSummary } from "./protocol-parser"

export const DEFAULT_INPUT_DATASET_ID = "normal-01"

export interface GeneratedInputDatasetResult {
  datasetFile: InputDatasetFileType
  warnings: string[]
}

export interface PersistedInputDatasetResult extends GeneratedInputDatasetResult {
  filePath: string
  indexPath: string
  datasetRef: string
}

function sanitizeFileStem(value: string): string {
  const sanitized = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim()
  return sanitized.length > 0 ? sanitized : "protocol"
}

function firstNonEmpty(...values: Array<string | undefined | null>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim()
    }
  }
  return undefined
}

function inferRangeValue(range?: string): string | undefined {
  if (!range) return undefined

  const hex = range.match(/0x[0-9a-fA-F]+/)
  if (hex) return hex[0]

  const number = range.match(/-?\d+(?:\.\d+)?/)
  if (number) return number[0]

  const label = range.split(/[、,，/|]/).map((part) => part.trim()).find(Boolean)
  return label || undefined
}

function inferDefaultFieldValue(
  field: ProtocolField,
  protocol: ProtocolSummary,
  inputFlow: string,
): { value: string; note?: string } {
  const title = `${field.name} ${field.title} ${field.desc}`.toLowerCase()
  const explicitValue = firstNonEmpty(field.default_value, field.enum_values[0], inferRangeValue(field.range))
  if (explicitValue) return { value: explicitValue }

  if (title.includes("时间") || title.includes("秒") || title.includes("time")) {
    return { value: "5", note: `${field.name} 未提供默认值，按时间字段回退为 5 秒` }
  }
  if (title.includes("总线") || title.includes("通道") || title.includes("bus") || title.includes("channel")) {
    return { value: "0", note: `${field.name} 未提供默认值，按总线/通道字段回退为 0` }
  }
  if (title.includes("id")) {
    return { value: "1", note: `${field.name} 未提供默认值，按 ID 字段回退为 1` }
  }
  if (title.includes("协议") || title.includes("报文") || title.includes("指令") || title.includes("名称")) {
    return {
      value: inputFlow || protocol.protocol_name,
      note: `${field.name} 未提供默认值，按协议/指令字段回退为输入流名称`,
    }
  }
  if (title.includes("结果") || title.includes("状态") || title.includes("取值") || title.includes("value")) {
    return { value: "0x01", note: `${field.name} 未提供默认值，按结果/状态字段回退为 0x01` }
  }

  return {
    value: inputFlow || protocol.protocol_name,
    note: `${field.name} 未提供默认值，按协议名称回退`,
  }
}

function deriveCommonSemantics(
  protocol: ProtocolSummary,
  inputFlow: string,
  fields: Record<string, string>,
): Record<string, string> {
  const firstHex = Object.values(fields).find((value) => /^0x[0-9a-f]+$/i.test(value))
  const firstNumber = Object.values(fields).find((value) => /^-?\d+(?:\.\d+)?$/.test(value))

  return {
    time: fields["执行时间"] ?? fields["时间"] ?? "5",
    protocol_name: protocol.protocol_name,
    input_flow: inputFlow || protocol.protocol_name,
    bus_channel: fields["总线"] ?? fields["通道"] ?? "0",
    bus: fields["总线"] ?? fields["通道"] ?? "0",
    data_id: fields["ID"] ?? firstNumber ?? "1",
    expected_value: firstHex ?? "0x01",
    generic: inputFlow || protocol.protocol_name,
  }
}

export function generateInputDatasetFile(
  protocol: ProtocolSummary,
  options?: { inputFlow?: string; datasetId?: string },
): GeneratedInputDatasetResult {
  const warnings: string[] = []
  const inputFlow = options?.inputFlow ?? protocol.protocol_name
  const fields: Record<string, string> = {}

  for (const field of protocol.items) {
    const resolved = inferDefaultFieldValue(field, protocol, inputFlow)
    fields[field.name] = resolved.value
    if (resolved.note) warnings.push(resolved.note)
  }

  const semantics = deriveCommonSemantics(protocol, inputFlow, fields)
  const dataset: InputDatasetRecord = {
    dataset_id: options?.datasetId ?? DEFAULT_INPUT_DATASET_ID,
    level: "normal",
    fields,
    semantics,
    notes: warnings,
  }

  const datasetFile: InputDatasetFileType = {
    protocol_name: protocol.protocol_name,
    format: protocol.format,
    input_flow: inputFlow,
    source_protocol_file: protocol.source_file,
    datasets: [dataset],
  }

  return { datasetFile, warnings }
}

export function loadInputDatasetFile(filePath: string): InputDatasetFileType {
  return InputDatasetFile.parse(JSON.parse(readFileSync(filePath, "utf-8")))
}

export function persistInputDatasetFile(
  projectDir: string,
  generated: GeneratedInputDatasetResult,
): PersistedInputDatasetResult {
  const datasetsDir = join(projectDir, ".matrix", "data", "input-datasets")
  mkdirSync(datasetsDir, { recursive: true })

  const filePath = join(datasetsDir, `${sanitizeFileStem(generated.datasetFile.protocol_name)}.json`)
  writeFileSync(filePath, JSON.stringify(generated.datasetFile, null, 2) + "\n")

  const firstDataset = generated.datasetFile.datasets[0]
  const indexPath = join(datasetsDir, "index.json")
  const index: InputDatasetIndexEntry[] = existsSync(indexPath)
    ? JSON.parse(readFileSync(indexPath, "utf-8"))
    : []

  const existing = index.find((entry) => entry.protocol_name === generated.datasetFile.protocol_name)
  if (!existing) {
    index.push({
      protocol_name: generated.datasetFile.protocol_name,
      file_path: filePath,
      default_dataset_id: firstDataset.dataset_id,
      input_flow: generated.datasetFile.input_flow,
    })
    writeFileSync(indexPath, JSON.stringify(index, null, 2) + "\n")
  } else if (existing.file_path !== filePath || existing.default_dataset_id !== firstDataset.dataset_id) {
    existing.file_path = filePath
    existing.default_dataset_id = firstDataset.dataset_id
    existing.input_flow = generated.datasetFile.input_flow
    writeFileSync(indexPath, JSON.stringify(index, null, 2) + "\n")
  }

  return {
    ...generated,
    filePath,
    indexPath,
    datasetRef: `.matrix/data/input-datasets/${sanitizeFileStem(generated.datasetFile.protocol_name)}.json#${firstDataset.dataset_id}`,
  }
}

export function resolveDatasetRecord(
  datasetFile: InputDatasetFileType,
  datasetId = DEFAULT_INPUT_DATASET_ID,
): InputDatasetRecord | null {
  return datasetFile.datasets.find((dataset) => dataset.dataset_id === datasetId) ?? datasetFile.datasets[0] ?? null
}
