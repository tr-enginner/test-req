import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, mkdirSync, writeFileSync } from "fs"
import { dirname, join, resolve } from "path"
import {
  DEFAULT_INPUT_DATASET_ID,
  generateInputDatasetFile,
  loadInputDatasetFile,
  persistInputDatasetFile,
} from "../shared/input-dataset-generator"
import { type InputDatasetFile } from "../shared/input-dataset-schema"
import { loadProtocolSummary } from "../shared/protocol-parser"

function ensureDir(filePath: string): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function resolveProtocolSummaryFile(projectDir: string, protocolName?: string, protocolSummaryFile?: string): string {
  if (protocolSummaryFile) {
    return protocolSummaryFile.startsWith("/") || /^[A-Za-z]:\\/.test(protocolSummaryFile)
      ? protocolSummaryFile
      : resolve(projectDir, protocolSummaryFile)
  }

  if (!protocolName) {
    throw new Error("必须提供 protocol_name 或 protocol_summary_file。")
  }

  return join(projectDir, ".matrix", "data", "protocols", `${protocolName}.json`)
}

function persistToExplicitPath(filePath: string, datasetFile: InputDatasetFile): void {
  ensureDir(filePath)
  writeFileSync(filePath, JSON.stringify(datasetFile, null, 2) + "\n")
}

export const testInputGenerator: ToolDefinition = tool({
  description:
    "根据结构化协议定义生成输入数据文件。默认读取 .matrix/data/protocols/<protocol_name>.json，" +
    "生成 .matrix/data/input-datasets/<protocol_name>.json，并返回默认 dataset 引用。",
  args: {
    protocol_name: tool.schema.string().optional().describe("协议名称，对应 .matrix/data/protocols/<protocol_name>.json"),
    protocol_summary_file: tool.schema
      .string()
      .optional()
      .describe("结构化协议定义文件路径；若提供则优先使用"),
    input_flow: tool.schema
      .string()
      .optional()
      .describe("输入流名称；若提供则写入输入数据文件并作为字段派生依据"),
    dataset_id: tool.schema
      .string()
      .optional()
      .describe(`默认数据集 ID；缺省为 ${DEFAULT_INPUT_DATASET_ID}`),
    output_file: tool.schema
      .string()
      .optional()
      .describe("可选输出文件路径；未提供时写入 .matrix/data/input-datasets/"),
  },
  async execute({ protocol_name, protocol_summary_file, input_flow, dataset_id, output_file }) {
    const projectDir = process.cwd()
    const summaryFile = resolveProtocolSummaryFile(projectDir, protocol_name, protocol_summary_file)
    const protocol = loadProtocolSummary(summaryFile)
    const generated = generateInputDatasetFile(protocol, {
      inputFlow: input_flow,
      datasetId: dataset_id,
    })

    if (output_file) {
      const resolvedOutput = output_file.startsWith("/") || /^[A-Za-z]:\\/.test(output_file)
        ? output_file
        : resolve(projectDir, output_file)
      persistToExplicitPath(resolvedOutput, generated.datasetFile)
      const loaded = loadInputDatasetFile(resolvedOutput)
      return JSON.stringify({
        status: "success",
        protocol_name: loaded.protocol_name,
        output_file: resolvedOutput,
        dataset_ref: `${resolvedOutput}#${loaded.datasets[0]?.dataset_id ?? DEFAULT_INPUT_DATASET_ID}`,
        warnings: generated.warnings.length > 0 ? generated.warnings : undefined,
      })
    }

    const persisted = persistInputDatasetFile(projectDir, generated)
    return JSON.stringify({
      status: "success",
      protocol_name: persisted.datasetFile.protocol_name,
      output_file: persisted.filePath,
      index_file: persisted.indexPath,
      dataset_ref: persisted.datasetRef,
      warnings: persisted.warnings.length > 0 ? persisted.warnings : undefined,
    })
  },
})
