import { existsSync, readFileSync } from "fs"

// ─── Structured JSON-line output parser (vtestc -json mode) ────────────────

/** A single JSON event emitted by vtestc in -json mode */
export interface VtestJsonEvent {
  event: string
  state?: string
  time?: number
  ticks?: number
  level?: number
  message?: string
  reason?: string
  exit_code?: number
  path?: string
  [key: string]: unknown
}

/** Parsed result from vtestc structured JSON output */
export interface VtestStructuredResult {
  status: "completed" | "timeout" | "error" | "device_exit"
  exit_code: number
  reason: string
  simulation_time: number | null
  simulation_ticks: number | null
  final_state: string | null
  logs: Array<{ level: number; message: string }>
  errors: string[]
  warnings: string[]
  coverage_path: string | null
  events: VtestJsonEvent[]
}

/**
 * Parse vtestc structured JSON-line output (from -json flag).
 * Each line of stdout is expected to be a JSON object with an "event" field.
 * Falls back gracefully if output is not JSON (legacy vtestc without -json).
 */
export function parseVtestJsonOutput(stdout: string): VtestStructuredResult {
  const result: VtestStructuredResult = {
    status: "error",
    exit_code: -1,
    reason: "no_result_event",
    simulation_time: null,
    simulation_ticks: null,
    final_state: null,
    logs: [],
    errors: [],
    warnings: [],
    coverage_path: null,
    events: [],
  }

  let hasJsonEvents = false

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || !trimmed.startsWith("{")) continue

    let evt: VtestJsonEvent
    try {
      evt = JSON.parse(trimmed)
    } catch {
      continue
    }

    if (!evt.event) continue
    hasJsonEvents = true
    result.events.push(evt)

    switch (evt.event) {
      case "RESULT":
        result.exit_code = typeof evt.exit_code === "number" ? evt.exit_code : -1
        result.reason = typeof evt.reason === "string" ? evt.reason : "unknown"
        if (typeof evt.time === "number") result.simulation_time = evt.time
        if (typeof evt.ticks === "number") result.simulation_ticks = evt.ticks
        if (typeof evt.state === "string") result.final_state = evt.state
        // Map exit_code to status
        switch (result.exit_code) {
          case 0: result.status = "completed"; break
          case 2: result.status = "timeout"; break
          case 3: result.status = "device_exit"; break
          default: result.status = "error"; break
        }
        break

      case "VM_STOPPED":
        if (typeof evt.time === "number") result.simulation_time = evt.time
        if (typeof evt.ticks === "number") result.simulation_ticks = evt.ticks
        break

      case "TIMEOUT":
        if (typeof evt.time === "number") result.simulation_time = evt.time
        if (typeof evt.ticks === "number") result.simulation_ticks = evt.ticks
        break

      case "log":
        if (typeof evt.level === "number" && typeof evt.message === "string") {
          result.logs.push({ level: evt.level, message: evt.message })
          if (evt.level <= 1) {
            result.errors.push(evt.message)
          }
        }
        break

      case "COVERAGE_SAVED":
        if (typeof evt.path === "string") result.coverage_path = evt.path
        break

      case "ERROR":
        if (typeof evt.reason === "string") result.errors.push(evt.reason)
        break
    }
  }

  // If no JSON events found, fall back to legacy heuristic parser
  if (!hasJsonEvents) {
    const trimmedStdout = stdout.trim()
    if (trimmedStdout.length === 0) {
      // Empty output = vtestc crashed or never started producing output
      result.status = "error"
      result.exit_code = -1
      result.reason = "empty_output"
      result.errors.push("vtestc produced no output — likely crashed during initialization (e.g., DLL binary incompatibility, missing exports, struct size mismatch)")
    } else {
      const legacy = parseVtestLog(stdout)
      result.errors = legacy.errors
      result.warnings = legacy.warnings
      result.simulation_time = legacy.simulation_time
      result.status = legacy.errors.length > 0 ? "error" : "completed"
      result.exit_code = legacy.errors.length > 0 ? 1 : 0
      result.reason = "legacy_parse"
    }
  }

  return result
}

/**
 * Parse test results JSON written by the test driver DLL.
 */
export function parseTestResults(resultFilePath: string): {
  driver: string
  results: Array<{
    name: string
    status: string
    detail: string
    time_s: number
  }>
} | null {
  if (!existsSync(resultFilePath)) return null
  try {
    const raw = readFileSync(resultFilePath, "utf-8")
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * Parse VTest coverage .cox file.
 */
export function parseCoxCoverage(coxFilePath: string): {
  total_lines: number
  covered_lines: number
  statement_coverage: number
} | null {
  if (!existsSync(coxFilePath)) return null
  try {
    const raw = readFileSync(coxFilePath, "utf-8")
    const lines = raw.split("\n").filter((l) => l.trim())
    let total = 0
    let covered = 0
    for (const line of lines) {
      const match = line.match(/^\s*(\d+)\s*:\s*(\d+)/)
      if (match) {
        total++
        if (parseInt(match[1], 10) > 0) covered++
      }
    }
    if (total === 0) return null
    return {
      total_lines: total,
      covered_lines: covered,
      statement_coverage: Math.round((covered / total) * 10000) / 100,
    }
  } catch {
    return null
  }
}

// ─── Diagnostic Result Analyzer ──────────────────────────────────────────────

/** Diagnostic report from analyzing [DIAG:...] log lines */
export interface DiagnosticReport {
  device_summaries: Array<{
    device_name: string
    counters: Record<string, number>
    status: "healthy" | "warning" | "error"
  }>
  issues: Array<{
    severity: "error" | "warning"
    category: "interrupt" | "register" | "checksum" | "connection" | "memory_type"
    message: string
    suggestion: string
  }>
  overall_status: "pass" | "issues_found"
}

/**
 * Analyze diagnostic log lines from vtestc JSON output.
 * Extracts [DIAG:...] lines, pattern-matches known diagnostic conditions,
 * and returns a structured report with issues and suggestions.
 */
export function analyzeDiagnostics(result: VtestStructuredResult): DiagnosticReport {
  const report: DiagnosticReport = {
    device_summaries: [],
    issues: [],
    overall_status: "pass",
  }

  // Collect all DIAG lines from logs
  const diagLines: Array<{ source: string; message: string }> = []
  for (const log of result.logs) {
    const match = log.message.match(/\[DIAG:([^\]]+)\]\s*(.+)/)
    if (match) {
      diagLines.push({ source: match[1], message: match[2].trim() })
    }
  }

  if (diagLines.length === 0) return report

  // Parse device summaries (counter lines from VTT_TERMINATE)
  const counterPattern = /MEMREAD=(\d+)\s+MEMWRITE=(\d+)\s+VPORT_RX=(\d+)\((\d+)B\)\s+VPORT_TX=(\d+)\((\d+)B\)\s+FIFO_PUSH=(\d+)\s+FIFO_POP=(\d+)\s+FIFO_OVF=(\d+)\s+CS_OK=(\d+)\s+CS_FAIL=(\d+)\s+FIRST_RD=([\d.]+)\s+FIRST_WR=([\d.]+)\s+FIRST_VPRX=([\d.]+)/

  for (const line of diagLines) {
    if (line.source === "driver") continue
    const m = line.message.match(counterPattern)
    if (!m) continue

    const counters: Record<string, number> = {
      memread: parseInt(m[1]),
      memwrite: parseInt(m[2]),
      vport_rx: parseInt(m[3]),
      vport_rx_bytes: parseInt(m[4]),
      vport_tx: parseInt(m[5]),
      vport_tx_bytes: parseInt(m[6]),
      fifo_push: parseInt(m[7]),
      fifo_pop: parseInt(m[8]),
      fifo_overflow: parseInt(m[9]),
      checksum_ok: parseInt(m[10]),
      checksum_fail: parseInt(m[11]),
    }

    let status: "healthy" | "warning" | "error" = "healthy"

    // Pattern: No memory access at all
    if (counters.memread === 0 && counters.memwrite === 0) {
      status = "error"
      report.issues.push({
        severity: "error",
        category: "memory_type",
        message: `Device "${line.source}": CPU never accessed device registers (MEMREAD=0, MEMWRITE=0)`,
        suggestion: "Check SetWatchOnMemoryM address range and memory type (0=internal RAM, 1=ROM, 2=external) — must match the firmware's actual memory map for the device registers.",
      })
    }

    // Pattern: Device sent data but never received
    if (counters.vport_tx > 0 && counters.vport_rx === 0) {
      status = status === "error" ? "error" : "warning"
      report.issues.push({
        severity: "warning",
        category: "connection",
        message: `Device "${line.source}": Sent ${counters.vport_tx} VPort messages but received none`,
        suggestion: "Check VPortConnect bidirectional configuration — the device may be missing an input VPort connection from the test driver.",
      })
    }

    // Pattern: Data received and pushed to FIFO but never popped
    if (counters.vport_rx > 0 && counters.fifo_push > 0 && counters.fifo_pop === 0) {
      status = "error"
      report.issues.push({
        severity: "error",
        category: "interrupt",
        message: `Device "${line.source}": ${counters.fifo_push} bytes pushed to FIFO but CPU never read any (FIFO_POP=0)`,
        suggestion: "CPU doesn't know data arrived — check interrupt connection (device interrupt pin → CPU interrupt input). Without interrupts, CPU never polls the data register.",
      })
    }

    // Pattern: FIFO overflow
    if (counters.fifo_overflow > 0) {
      status = status === "error" ? "error" : "warning"
      report.issues.push({
        severity: "warning",
        category: "interrupt",
        message: `Device "${line.source}": FIFO overflowed ${counters.fifo_overflow} times`,
        suggestion: "CPU is not reading data fast enough. Check interrupt priority or increase FIFO size.",
      })
    }

    // Pattern: Checksum failures
    if (counters.checksum_fail > 0) {
      const total = counters.checksum_ok + counters.checksum_fail
      status = "error"
      report.issues.push({
        severity: "error",
        category: "checksum",
        message: `Device "${line.source}": ${counters.checksum_fail}/${total} frames failed checksum verification`,
        suggestion: "Check checksum_type, checksum_scope, and byte order in protocol_params — must match the firmware's actual checksum algorithm.",
      })
    }

    report.device_summaries.push({ device_name: line.source, counters, status })
  }

  // Parse driver diagnostic lines
  for (const line of diagLines) {
    if (line.source !== "driver") continue

    // Pattern: SEND_WAIT with NO_RESPONSE
    if (line.message.includes("RESULT=NO_RESPONSE")) {
      report.issues.push({
        severity: "error",
        category: "interrupt",
        message: "Test driver sent data but received no response from firmware",
        suggestion: "Check: 1) Interrupt connection between device and CPU, 2) UART register addresses match firmware, 3) UART is enabled in firmware initialization.",
      })
    }

    // Pattern: WR_VERIFY MISMATCH
    const wrMatch = line.message.match(/WR_VERIFY addr=(0x[0-9A-Fa-f]+).*RESULT=MISMATCH/)
    if (wrMatch) {
      report.issues.push({
        severity: "error",
        category: "memory_type",
        message: `Write-read verification failed at address ${wrMatch[1]}`,
        suggestion: "SetWatchOnMemoryM is not intercepting writes at this address. Check the address range and memory type parameter.",
      })
    }
  }

  // Parse checksum mismatch details
  for (const line of diagLines) {
    if (line.message.startsWith("CS_MISMATCH")) {
      const typeMatch = line.message.match(/type=(\w+)/)
      const scopeMatch = line.message.match(/scope=(\w+)/)
      if (typeMatch) {
        report.issues.push({
          severity: "error",
          category: "checksum",
          message: `Checksum mismatch: type=${typeMatch[1]}${scopeMatch ? ` scope=${scopeMatch[1]}` : ""}`,
          suggestion: `Verify the checksum algorithm type (${typeMatch[1]}) and scope match the firmware. Common issues: wrong byte order for CRC16, wrong scope (payload vs header_and_payload).`,
        })
      }
    }
  }

  if (report.issues.length > 0) {
    report.overall_status = "issues_found"
  }

  return report
}

/**
 * Parse VTest console log output for errors and key events.
 */
export function parseVtestLog(logContent: string): {
  errors: string[]
  warnings: string[]
  device_events: string[]
  simulation_time: number | null
} {
  const errors: string[] = []
  const warnings: string[] = []
  const device_events: string[] = []
  let simulationTime: number | null = null

  for (const line of logContent.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue

    if (trimmed.includes("ERROR") || trimmed.includes("error")) {
      errors.push(trimmed)
    } else if (trimmed.includes("WARNING") || trimmed.includes("warning")) {
      warnings.push(trimmed)
    } else if (trimmed.match(/^\[.*\]/)) {
      device_events.push(trimmed)
    }

    const timeMatch = trimmed.match(/@([\d.]+)s/)
    if (timeMatch) {
      const t = parseFloat(timeMatch[1])
      if (simulationTime === null || t > simulationTime) {
        simulationTime = t
      }
    }
  }

  return { errors, warnings, device_events, simulation_time: simulationTime }
}

// ─── Init Validation Error Classifier ────────────────────────────────────────

/** Classification of a single vtestc init-phase error */
export interface InitError {
  category: "pin_name_error" | "dll_load_error" | "dll_export_error" | "firmware_error" | "memory_error" | "vm_init_error" | "unknown"
  message: string
  suggestion: string
  auto_fixable: boolean
}

/** Result from classifying vtestc init errors */
export interface InitValidationResult {
  valid: boolean
  errors: InitError[]
}

/** Known error patterns for vtestc init phase */
const INIT_ERROR_PATTERNS: Array<{
  patterns: RegExp[]
  category: InitError["category"]
  suggestion: string
  auto_fixable: boolean
}> = [
  {
    patterns: [
      /端口不存在/i,
      /port\s+not\s+found/i,
      /pin\s*.*\s*not\s+exist/i,
      /invalid\s+pin\s+name/i,
      /unknown\s+port/i,
      /连接.*端口.*���误/i,
      /Connect.*error/i,
    ],
    category: "pin_name_error",
    suggestion: "核对设备 DLL 源码 gPorts[] 中定义的引脚名称和类型 (IOPIN/VIOPORT)。" +
      "IOPIN 引脚用于 [Connect]，VIOPORT 引脚用于 [VPortConnect]。" +
      "MCS-51 CPU 有效引脚: P1_0-P1_7, P3_0-P3_7 (IOPIN), SERIAL (VIOPORT)。" +
      "注意 P0/P2 端口在 C8051/C8052 DLL 中不存在。",
    auto_fixable: false,
  },
  {
    patterns: [
      /LoadLibrary.*fail/i,
      /无法加载.*dll/i,
      /cannot\s+load.*dll/i,
      /dll.*not\s+found/i,
      /找不到.*dll/i,
    ],
    category: "dll_load_error",
    suggestion: "检查 [Devices] 中 DLL 路径是否正确（自定义 DLL 必须用绝对路径）。" +
      "确认 DLL 已通过 vtest_compile 编译成功。确认 DLL 为 32 位 (Win32)。",
    auto_fixable: false,
  },
  {
    patterns: [
      /GetProcAddress.*MainProc/i,
      /MainProc\s+not\s+found/i,
      /无法找到.*MainProc/i,
      /导出函数.*失败/i,
    ],
    category: "dll_export_error",
    suggestion: "DLL 未正确导出 MainProc 函数。检查 .def 文件中是否包含 'EXPORTS\\n    MainProc'。" +
      "确认 MainProc 签名为: extern \"C\" vttRES WINAPI MainProc(vttMESSAGE, void*, DWORD)。",
    auto_fixable: false,
  },
  {
    patterns: [
      /BinFile.*not\s+found/i,
      /无法打开目标码/i,
      /firmware.*not\s+found/i,
      /cannot\s+open.*bin/i,
      /目标文件.*不存在/i,
    ],
    category: "firmware_error",
    suggestion: "固件文件路径错误。[BinFiles] 必须使用绝对路径。" +
      "确认路径与 matrix.jsonc 中 firmware.output 一致，不要自行添加扩展名。",
    auto_fixable: false,
  },
  {
    patterns: [
      /PhyMem.*error/i,
      /memory.*overlap/i,
      /内存.*重叠/i,
      /内存.*配置.*错误/i,
      /address\s+range.*conflict/i,
    ],
    category: "memory_error",
    suggestion: "物理内存配置错误。检查 [PhyMem] 地址范围是否重叠。" +
      "MCS-51 只需配置 XDATA (type=2)，内部 RAM/ROM 由 CPU 模拟器内置。",
    auto_fixable: false,
  },
  {
    patterns: [
      /创建虚拟机失败/i,
      /VM.*create.*fail/i,
      /init.*fail/i,
      /初始化.*失败/i,
    ],
    category: "vm_init_error",
    suggestion: "VM 初始化失败，可能是多个配置问题的综合结果。" +
      "依次检查: CPU DLL、固件路径、内存映射、设备 DLL、引脚连接。",
    auto_fixable: false,
  },
]

/**
 * Classify vtestc init-phase errors from structured output.
 * Matches error/log messages against known patterns and returns
 * categorized errors with suggestions.
 *
 * Used by vtest_runner "validate" action to provide actionable feedback.
 */
export function classifyInitErrors(result: VtestStructuredResult): InitValidationResult {
  // Collect all error messages from multiple sources
  const allMessages: string[] = [...result.errors]

  // Also scan logs for error-level messages
  for (const log of result.logs) {
    if (log.level <= 2) { // error and warning levels
      allMessages.push(log.message)
    }
  }

  // Also scan raw events for error messages
  for (const evt of result.events) {
    if (evt.event === "ERROR" && evt.reason) {
      allMessages.push(evt.reason)
    }
  }

  if (allMessages.length === 0) {
    return { valid: true, errors: [] }
  }

  const classified: InitError[] = []
  const matchedMessages = new Set<string>()

  for (const msg of allMessages) {
    let matched = false
    for (const pattern of INIT_ERROR_PATTERNS) {
      for (const re of pattern.patterns) {
        if (re.test(msg)) {
          // Avoid duplicate classifications for the same message
          const key = `${pattern.category}:${msg}`
          if (!matchedMessages.has(key)) {
            matchedMessages.add(key)
            classified.push({
              category: pattern.category,
              message: msg,
              suggestion: pattern.suggestion,
              auto_fixable: pattern.auto_fixable,
            })
          }
          matched = true
          break
        }
      }
      if (matched) break
    }

    // Unclassified errors
    if (!matched && !matchedMessages.has(`unknown:${msg}`)) {
      matchedMessages.add(`unknown:${msg}`)
      classified.push({
        category: "unknown",
        message: msg,
        suggestion: "未知错误类型，请检查 vtestc 日志输出并参考 VTest 文档排查。如需帮助请提供完整错误信息。",
        auto_fixable: false,
      })
    }
  }

  return {
    valid: classified.length === 0,
    errors: classified,
  }
}
