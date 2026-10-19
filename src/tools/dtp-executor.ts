import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, readdirSync, statSync } from "fs"
import { dirname, isAbsolute, join } from "path"
import JSZip from "jszip"
import * as jsonc from "jsonc-parser/lib/esm/main.js"
import os from "os"
import { detectSoftPlatform, provisionSoftPlatform } from "../shared/phase-state"
interface DtpUploadResponse {
  message: string
  code: number
  result: {
    projectName: string
  }
  timestamp: string
}
interface DtpStartResponse {
  message: string
  code: number
  result: Array<{
    projectName: string
    versions: Array<{ name: string; err: string }>
  }>
  timestamp: string
}
interface DtpStatusResponse {
  code: number
  message: string
  result: {
    projectName: string
    version: string
    status: number
    time: string
    progress: string
    statistic: string
    errInfo: string
  }
  timestamp: string
}
interface DtpServerConfig {
  base_url: string
  project_dir: string
  project_name: string
  version: string
  poll_interval: number
}
const DEFAULT_DTP_EXECUTOR_CONFIG: DtpServerConfig = {
  base_url: "http://172.16.1.100:8087",
  project_dir: ".matrix/data/DTPProject",
  project_name: "DTPProject",
  version: "V1",
  poll_interval: 10000,
}
function resolveProjectPath(baseDir: string, supplied: string): string {
  return isAbsolute(supplied) ? supplied : join(baseDir, supplied)
}
function ensureDirectory(dirPath: string): void {
  if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true })
}
async function httpJsonRequest(
  url: string,
  method: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  const options: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  }
  if (body && method !== "GET") {
    options.body = JSON.stringify(body)
  }
  const response = await fetch(url, options)
  let data: unknown
  try {
    data = await response.json()
  } catch {
    data = await response.text()
  }
  return { status: response.status, data }
}
async function uploadProjectMultipart(
  baseUrl: string,
  projectName: string,
  zipPath: string,
): Promise<DtpUploadResponse> {
  const zipData = readFileSync(zipPath)
  const boundary = `----FormBoundary-${Date.now()}`
  const parts: string[] = []
  parts.push(`--${boundary}\r\n`)
  parts.push(`Content-Disposition: form-data; name="projectName"\r\n\r\n${projectName}\r\n`)
  const fileName = "DTPProject.zip"
  parts.push(`--${boundary}\r\n`)
  parts.push(`Content-Disposition: form-data; name="dtpPackage"; filename="${fileName}"\r\n`)
  parts.push(`Content-Type: application/zip\r\n\r\n`)
  const headerBuffer = Buffer.from(parts.join(""), "utf-8")
  const footerBuffer = Buffer.from(`\r\n--${boundary}--\r\n`, "utf-8")
  const fileBuffer = Buffer.from(zipData)
  const bodyBuffer = Buffer.concat([headerBuffer, fileBuffer, footerBuffer])
  const response = await fetch(`${baseUrl}/DTPAgentUpload`, {
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": String(bodyBuffer.length),
    },
    body: bodyBuffer,
  })
  if (response.status !== 200) {
    const errorText = await response.text()
    throw new Error(`Upload failed: ${response.status} - ${errorText}`)
  }
  return (await response.json()) as DtpUploadResponse
}
async function startExecution(
  baseUrl: string,
  projectName: string,
  version: string = "V1",
): Promise<DtpStartResponse> {
  const requestBody = {
    cmd: "DTPAgentStart",
    projects: [
      {
        projectName,
        versions: [{ name: version }],
      },
    ],
  }
  const response = await httpJsonRequest(`${baseUrl}/DTPAgentStartCase`, "POST", requestBody)
  if (response.status !== 200) {
    throw new Error(`Execution start failed: ${response.status}`)
  }
  return response.data as DtpStartResponse
}
async function queryStatus(
  baseUrl: string,
  projectName: string,
  version: string = "V1",
): Promise<DtpStatusResponse> {
  const requestBody = {
    projectName,
    version,
  }
  const response = await httpJsonRequest(`${baseUrl}/DTPAgentStatus`, "POST", requestBody)
  if (response.status !== 200) {
    throw new Error(`Status query failed: ${response.status}`)
  }
  return response.data as DtpStatusResponse
}
async function downloadResults(
  baseUrl: string,
  projectName: string,
  version: string = "V1",
  outputPath: string,
): Promise<boolean> {
  const url = `${baseUrl}/DTPAgentDownload?projectName=${encodeURIComponent(projectName)}&version=${encodeURIComponent(version)}`
  const response = await fetch(url, { method: "GET" })
  if (response.status === 200) {
    const arrayBuffer = await response.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)
    writeFileSync(outputPath, buffer)
    return true
  }
  return false
}
function addDirectoryToZip(dirPath: string, zip: JSZip, relativePath: string = ""): void {
  const entries = readdirSync(dirPath)
  for (const entry of entries) {
    const fullPath = join(dirPath, entry)
    const stat = statSync(fullPath)
    const entryPath = relativePath ? `${relativePath}/${entry}` : entry
    if (stat.isDirectory()) {
      addDirectoryToZip(fullPath, zip, entryPath)
    } else {
      const fileData = readFileSync(fullPath)
      zip.file(entryPath, fileData)
    }
  }
}
async function zipDirectory(sourceDir: string, outputPath: string): Promise<void> {
  const zip = new JSZip()
  addDirectoryToZip(sourceDir, zip)
  const zipData = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } })
  writeFileSync(outputPath, zipData)
}
async function unzipFile(zipPath: string, outputDir: string): Promise<void> {
  const zipData = readFileSync(zipPath)
  const zip = await JSZip.loadAsync(zipData)
  const promises: Promise<void>[] = []
  for (const [relativePath, file] of Object.entries(zip.files)) {
    if (file.dir) {
      const dirPath = join(outputDir, relativePath)
      ensureDirectory(dirPath)
    } else {
      const filePath = join(outputDir, relativePath)
      const dir = dirname(filePath)
      ensureDirectory(dir)
      const promise = file.async("nodebuffer").then((data) => {
        writeFileSync(filePath, data)
      })
      promises.push(promise)
    }
  }
  await Promise.all(promises)
}
function parseOutputXml(outputXmlPath: string): {
  total: number
  passed: number
  failed: number
  skipped: number
  details: Array<{ name: string; message: string }>
} {
  const result = {
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    details: [] as Array<{ name: string; message: string }>,
  }
  if (!existsSync(outputXmlPath)) {
    return result
  }
  const xml = readFileSync(outputXmlPath, "utf-8")
  const totalStatMatch = xml.match(
    /<stat\s+pass="(\d+)"\s+fail="(\d+)"(?:\s+skip="(\d+)")?>All Tests<\/stat>/,
  )
  if (totalStatMatch) {
    result.passed = parseInt(totalStatMatch[1], 10)
    result.failed = parseInt(totalStatMatch[2], 10)
    result.skipped = parseInt(totalStatMatch[3] || "0", 10)
    result.total = result.passed + result.failed + result.skipped
  }
  const testBlockRegex = /<test\s[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/test>/g
  let match: RegExpExecArray | null
  while ((match = testBlockRegex.exec(xml)) !== null) {
    const testName = match[1]
    const testBody = match[2]
    const statusMatch = testBody.match(
      /<status\s+status="FAIL"[^>]*>([^<]*)<\/status>/,
    )
    if (statusMatch) {
      result.details.push({
        name: testName,
        message: statusMatch[1] || "No failure message",
      })
    }
  }
  return result
}
export interface DtpExecutorOptions {
  base_url?: string
  project_dir?: string
  project_name?: string
  version?: string
  poll_interval?: number
}
export async function executeDtpProject(options?: DtpExecutorOptions): Promise<{
  success: boolean
  upload?: DtpUploadResponse
  start?: DtpStartResponse
  status?: DtpStatusResponse
  download_path?: string
  reports_dir?: string
  error?: string
  exestatus?: string
  total?: number
  passed?: number
  failed?: number
  skipped?: number
  output_dir?: string
  output_files?: {
    log: string
    report: string
    output_xml: string
  }
  details?: Array<{ name: string; message: string }>
  elapsed?: string
}> {
  const baseUrl = options?.base_url ?? DEFAULT_DTP_EXECUTOR_CONFIG.base_url
  const projectDir = options?.project_dir ?? join(process.cwd(), DEFAULT_DTP_EXECUTOR_CONFIG.project_dir)
  const projectName = options?.project_name ?? DEFAULT_DTP_EXECUTOR_CONFIG.project_name
  const version = options?.version ?? DEFAULT_DTP_EXECUTOR_CONFIG.version
  const pollInterval = options?.poll_interval ?? DEFAULT_DTP_EXECUTOR_CONFIG.poll_interval
  if (!existsSync(projectDir)) {
    return { success: false, error: `项目目录不存在: ${projectDir}` }
  }
  const tempDir = join(process.cwd(), ".matrix", "dtp-executor-temp")
  ensureDirectory(tempDir)
  const zipPath = join(tempDir, `${projectName}.zip`)
  const reportsDir = join(projectDir, "报告")
  ensureDirectory(reportsDir)
  let statusResult: DtpStatusResponse | undefined
  const startTime = Date.now()
  try {
    if (existsSync(zipPath)) {
      unlinkSync(zipPath)
    }
    await zipDirectory(projectDir, zipPath)
    const uploadResult = await uploadProjectMultipart(baseUrl, projectName, zipPath)
    if (uploadResult.code !== 200) {
      return { success: false, error: `上传失败: ${uploadResult.message}`, upload: uploadResult }
    }
    const serverProjectName = uploadResult.result.projectName
    const startResult = await startExecution(baseUrl, serverProjectName, version)
    if (startResult.code !== 200) {
      return { success: false, error: `执行启动失败: ${startResult.message}`, upload: uploadResult, start: startResult }
    }
    console.log(`等待执行完成 (轮询间隔: ${pollInterval}ms)...`)
    let isComplete = false
    while (!isComplete) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval))
      statusResult = await queryStatus(baseUrl, serverProjectName, version)
      if (statusResult.result.status === 4) {
        isComplete = true
      } else if (statusResult.result.status === 6) {
        return {
          success: false,
          error: `执行错误: ${statusResult.result.errInfo}`,
          upload: uploadResult,
          start: startResult,
          status: statusResult,
        }
      }
    }
    const resultZipPath = join(tempDir, `${projectName}_results.zip`)
    const downloaded = await downloadResults(baseUrl, serverProjectName, version, resultZipPath)
    if (!downloaded) {
      return {
        success: false,
        error: "下载结果失败",
        upload: uploadResult,
        start: startResult,
        status: statusResult,
      }
    }
    if (existsSync(resultZipPath)) {
      await unzipFile(resultZipPath, reportsDir)
    }
    const outputXmlPath = join(reportsDir, "output.xml")
    if (!existsSync(outputXmlPath)) {
      return {
        success: false,
        error: `${outputXmlPath} 文件不存在`,
        upload: uploadResult,
        start: startResult,
        status: statusResult,
        download_path: resultZipPath,
        reports_dir: reportsDir,
      }
    }
    const results = parseOutputXml(outputXmlPath)
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    const exestatus = results.failed > 0 ? "failed" : "passed"
    console.log("测试执行完成")
    return {
      success: true,
      upload: uploadResult,
      start: startResult,
      status: statusResult,
      download_path: resultZipPath,
      reports_dir: reportsDir,
      exestatus,
      total: results.total,
      passed: results.passed,
      failed: results.failed,
      skipped: results.skipped,
      output_dir: reportsDir,
      output_files: {
        log: join(reportsDir, "log.html"),
        report: join(reportsDir, "report.html"),
        output_xml: outputXmlPath,
      },
      elapsed: `${elapsed}s`,
    }
  } catch (error) {
    return {
      success: false,
      error: String(error),
    }
  } finally {
    if (existsSync(zipPath)) {
      unlinkSync(zipPath)
    }
  }
}
interface DtpServerRawConfig {
  base_url?: string
  project_dir?: string
  project_name?: string
  version?: string
  poll_interval?: number
}
let cachedDtpConfig: DtpServerRawConfig | null = null
let cachedDtpPath: string | null = null
function loadDtpServerConfig(): DtpServerRawConfig | null {
  const searchPaths: string[] = [
    join(os.homedir(), ".config", "sunwisecode", "DtpExeServerConfig.jsonc"),
    join(os.homedir(), ".config", "opencode", "DtpExeServerConfig.jsonc"),
    join(process.cwd(), "DtpExeServerConfig.jsonc"),
    join(process.cwd(), ".matrix", "config", "DtpExeServerConfig.jsonc"),
  ]
  for (const configPath of searchPaths) {
    if (!existsSync(configPath)) continue
    if (cachedDtpConfig && configPath === cachedDtpPath) return cachedDtpConfig
    try {
      const content = readFileSync(configPath, "utf-8")
      const parsed = jsonc.parse(content)
      if (!parsed || typeof parsed !== "object") continue

      let dtpRaw: Record<string, unknown> | undefined

      // Format 1: DtpExeServerConfig.jsonc → { success, effective_config: { ... } }
      if ("effective_config" in (parsed as Record<string, unknown>)) {
        dtpRaw = (parsed as Record<string, unknown>).effective_config as Record<string, unknown>
      }
      // Format 2: matrix.jsonc → { dtp_server: { ... } }
      else if ("dtp_server" in (parsed as Record<string, unknown>)) {
        dtpRaw = (parsed as Record<string, unknown>).dtp_server as Record<string, unknown>
      }

      if (dtpRaw) {
        cachedDtpConfig = {
          base_url: dtpRaw.base_url as string | undefined,
          project_dir: dtpRaw.project_dir as string | undefined,
          project_name: dtpRaw.project_name as string | undefined,
          version: dtpRaw.version as string | undefined,
          poll_interval: dtpRaw.poll_interval as number | undefined,
        }
        cachedDtpPath = configPath
        return cachedDtpConfig
      }
    } catch {
      continue
    }
  }
  return null
}
function getDtpServerConfig(): { config: DtpServerConfig; source: string } {
  const defaults: DtpServerConfig = { ...DEFAULT_DTP_EXECUTOR_CONFIG }
  const dtpRaw = loadDtpServerConfig()
  if (!dtpRaw) return { config: defaults, source: "default" }
  return {
    config: {
      base_url: dtpRaw.base_url ?? defaults.base_url,
      project_dir: dtpRaw.project_dir ?? defaults.project_dir,
      project_name: dtpRaw.project_name ?? defaults.project_name,
      version: dtpRaw.version ?? defaults.version,
      poll_interval: dtpRaw.poll_interval ?? defaults.poll_interval,
    },
    source: cachedDtpPath ?? "config_file",
  }
}
export const dtpExecutor: ToolDefinition = tool({
  description:
    "执行 DTP 测试流程：打包项目目录为 ZIP，通过 HTTP 上传到服务器，执行测试用例，" +
    "轮询执行状态（默认10秒），执行完成后下载结果到项目目录下的报告文件夹并解压。",
  args: {
    base_url: tool.schema.string().optional(),
    project_dir: tool.schema.string().optional(),
    project_name: tool.schema.string().optional(),
    version: tool.schema.string().optional(),
    poll_interval: tool.schema.number().optional(),
  },
  async execute(args, ctx) {
    try {
      // Auto-detect and provision soft platform at the project root level.
      // ctx.directory is always the correct project root, unlike hooks which
      // may receive workspace.workspaceDir (a parent directory).
      const projectRoot = ctx?.directory ?? process.cwd()
      const dtpProjectPath = join(projectRoot, ".matrix", "data", "DTPProject")
      let softPlatformProvisioned = false
      if (!existsSync(dtpProjectPath) || readdirSync(dtpProjectPath).length === 0) {
        const spDir = detectSoftPlatform(projectRoot)
        if (spDir && provisionSoftPlatform(projectRoot, spDir)) {
          softPlatformProvisioned = true
        }
      }

      const { config: dtpserver } = getDtpServerConfig()
      const configSource: string = "tool_args_or_defaults"
      const resolvedProjectDir = resolveProjectPath(projectRoot, args.project_dir ?? dtpserver.project_dir)
      const pollInterval =
        typeof args.poll_interval === "number" && args.poll_interval > 0
          ? args.poll_interval
          : dtpserver.poll_interval
      const result = await executeDtpProject({
        base_url: args.base_url ?? dtpserver.base_url,
        project_dir: resolvedProjectDir,
        project_name: args.project_name ?? dtpserver.project_name,
        version: args.version ?? dtpserver.version,
        poll_interval: pollInterval,
      })
      return JSON.stringify({
        ...result,
        soft_platform_provisioned: softPlatformProvisioned,
        config_source: configSource,
        config_base_url: args.base_url ?? dtpserver.base_url,
        ...(configSource === "default"
          ? { config_warning: "未找到 DTP 配置文件（搜索路径：~/.config/sunwisecode/、~/.config/opencode/、项目 DtpExeServerConfig.jsonc、项目 .matrix/config/DtpExeServerConfig.jsonc），使用默认地址" }
          : {}),
        effective_config: {
          source: configSource,
          base_url: args.base_url ?? dtpserver.base_url,
          project_dir: resolvedProjectDir,
          project_name: args.project_name ?? dtpserver.project_name,
          version: args.version ?? dtpserver.version,
          poll_interval: pollInterval,
        },
      }, null, 2)
    } catch (error) {
      return JSON.stringify({
        success: false,
        error: String(error),
      })
    }
  },
})
