import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs"
import { dirname, join, resolve } from "path"
import { VteProject } from "../schema/vtest"
import { serializeVte, resolveCpuDll } from "./vtest/vte-format"
import { generateDiagnosticScript } from "./vtest/script-templates"
import { TEST_ENV_DIR } from "../shared/constants"

/**
 * Shared execute logic for vtest_project_generate and vtest_project_update.
 */
async function executeProjectGenerate({
  project_name,
  cpu_type,
  cpu_freq_mhz,
  binary_path,
  memory_map,
  devices,
  pin_connections,
  vport_connections,
  source_files,
}: {
  project_name: string
  cpu_type: string
  cpu_freq_mhz: number
  binary_path: string
  memory_map: { start: string; end: string; type?: number }[]
  devices: { dll_path: string; display_name: string; properties?: Record<string, string> }[]
  pin_connections?: { from: string; to: string }[]
  vport_connections?: { from: string; to: string }[]
  source_files?: string[]
}): Promise<string> {
  let cpuDll = cpu_type
  if (!cpuDll.toLowerCase().endsWith(".dll")) {
    const resolved = resolveCpuDll(cpuDll)
    if (!resolved) {
      return JSON.stringify({
        error: `Unknown CPU type: ${cpu_type}. Use a known CPU name or provide the DLL filename directly (e.g., 'C8052.dll').`,
      })
    }
    cpuDll = resolved
  }

  const project = {
    project_name,
    version: "1.0",
    cpu_dll: cpuDll,
    cpu_freq_mhz,
    cpu_type: "VTEST" as const,
    binary_files: [binary_path],
    source_files: source_files ?? [],
    memory_map: memory_map.map((m) => ({
      start: m.start,
      end: m.end,
      type: m.type ?? 0,
    })),
    devices: devices.map((d) => ({
      dll_path: d.dll_path,
      display_name: d.display_name,
      properties: d.properties ?? {},
    })),
    pin_connections: pin_connections ?? [],
    vport_connections: vport_connections ?? [],
    disable_coverage: false,
  }

  const parsed = VteProject.safeParse(project)
  if (!parsed.success) {
    return JSON.stringify({
      error: "Project validation failed",
      details: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    })
  }

  const outputPath = join(process.cwd(), TEST_ENV_DIR, "project.vte")
  const vteDir = resolve(dirname(outputPath))
  if (!existsSync(vteDir)) mkdirSync(vteDir, { recursive: true })

  const vteContent = serializeVte(parsed.data, { vteDir, projectDir: process.cwd() })
  writeFileSync(outputPath, vteContent, "utf-8")

  // Generate diagnostic script from device info
  // Build minimal device specs from project generator args
  const diagDevices = devices.map((d) => ({
    device_name: d.display_name,
    device_type: d.display_name.toLowerCase().includes("uart") || d.display_name.toLowerCase().includes("rs422")
      ? "uart" as const
      : "custom" as const,
    registers: d.properties?.BaseAddress
      ? [{ name: "base", address: d.properties.BaseAddress }]
      : [],
    ports: [{ name: "port0", type: "vport" as const }],
    protocol_params: d.properties ?? {},
  }))

  const diagScript = generateDiagnosticScript(diagDevices)
  const stimuliDir = join(vteDir, "stimuli")
  if (!existsSync(stimuliDir)) mkdirSync(stimuliDir, { recursive: true })
  const diagScriptPath = join(stimuliDir, "diagnostic_test.txt")
  writeFileSync(diagScriptPath, diagScript, "utf-8")

  // Validate: test_driver device must have ScriptFile property
  const configWarnings: string[] = []
  const testDriverDevice = devices.find((d) =>
    d.display_name.toLowerCase().includes("test_driver") || d.display_name.toLowerCase().includes("testdriver")
  )
  if (testDriverDevice && (!testDriverDevice.properties?.ScriptFile)) {
    configWarnings.push(
      `WARNING: Device "${testDriverDevice.display_name}" appears to be a test driver but has no ScriptFile property. ` +
      `Without ScriptFile, the test driver DLL will load 0 test commands. ` +
      `Add properties: { "ScriptFile": "stimuli/baseline_test.txt", "ResultFile": ".matrix/test-env/baseline-results.json" }`
    )
  }

  // Validate: UART/RS422 devices need VPortConnect entries
  const uartDevices = devices.filter((d) => {
    const name = d.display_name.toLowerCase()
    return name.includes("uart") || name.includes("rs422") || name.includes("serial")
  })
  if (uartDevices.length > 0 && (vport_connections ?? []).length === 0) {
    configWarnings.push(
      `WARNING: Found ${uartDevices.length} UART/serial device(s) (${uartDevices.map((d) => d.display_name).join(", ")}) ` +
      `but no [VPortConnect] entries configured. UART devices require VPort connections to the test driver ` +
      `for data transfer. Add vport_connections to link device TX_DATA/RX_DATA ports to test driver ports.`
    )
    for (const w of configWarnings) {
      console.error(w)
    }
  }

  return JSON.stringify({
    status: "success",
    file: `${TEST_ENV_DIR}/project.vte`,
    diagnostic_script: `${TEST_ENV_DIR}/stimuli/diagnostic_test.txt`,
    cpu_dll: cpuDll,
    cpu_freq_mhz,
    device_count: devices.length,
    memory_blocks: memory_map.length,
    pin_connections: (pin_connections ?? []).length,
    vport_connections: (vport_connections ?? []).length,
    ...(configWarnings.length > 0 ? { warnings: configWarnings } : {}),
    message: `Generated VTest project file for "${project_name}" with ${cpuDll} @ ${cpu_freq_mhz}MHz`,
  })
}

/** Common args schema for VTE project generation. */
const vteProjectArgs = {
  project_name: tool.schema.string().describe("Project name"),
  cpu_type: tool.schema
    .string()
    .describe(
      "Target CPU type. Use DLL filename only (NO directory prefix) or common name. " +
      "Examples: 'C8052.dll', '8051', 'c6713'. " +
      "Available: 8031, 8051/8052/C51, C6713, C6701, C6678, F2812, F28335, AT697F, TSC695, " +
      "BM3803, BM3823, ZYNQ7000, ATmega128, 80386, LS3A3000, LS1E300, MPC8245. " +
      "VTest auto-loads CPU DLL from its own cpu/ directory — never include a path prefix.",
    ),
  cpu_freq_mhz: tool.schema.number().describe("CPU frequency in MHz (e.g., 12, 100)"),
  binary_path: tool.schema
    .string()
    .describe(
      "Path to compiled firmware file — use the EXACT path from matrix.jsonc firmware.output. " +
      "Supports .elf, .hex, .bin, and OMF51 format (no extension, e.g., 'build\\prj'). " +
      "Do NOT add/change extensions — if config says 'build\\prj', use 'build\\prj' (not 'build\\prj.hex'). " +
      "Relative paths are auto-resolved from project root. Absolute paths are used as-is.",
    ),
  memory_map: tool.schema
    .array(
      tool.schema.object({
        start: tool.schema.string().describe("Start address hex (e.g., '0x0000')"),
        end: tool.schema.string().describe("End address hex (e.g., '0xFFFF')"),
        type: tool.schema.number().default(0).describe("0=RAM (default for non-MCS-51). MCS-51: type 0/1 built-in, only use type 2 for XDATA. Non-MCS-51 CPUs are forced to type 0 regardless of input."),
      }),
    )
    .describe("Physical memory blocks"),
  devices: tool.schema
    .array(
      tool.schema.object({
        dll_path: tool.schema.string().describe("Path to device DLL. Custom/user-developed DLLs: use absolute path (or relative, auto-resolved to absolute). VTest system DLLs (from vtest\\system): use DLL name only, no directory prefix"),
        display_name: tool.schema.string().describe("Device name — English variable-name style (e.g., 'sim_uart', 'sim_adc', 'test_driver'). Used in [Names] and [Connect] sections"),
        properties: tool.schema
          .record(tool.schema.string(), tool.schema.string())
          .optional()
          .describe("Device properties as key-value pairs"),
      }),
    )
    .describe("Virtual peripheral device DLLs"),
  pin_connections: tool.schema
    .array(
      tool.schema.object({
        from: tool.schema.string().describe("Source: deviceRef.pinName — accepts display_name, numeric ID, or 'CPU'. Tool auto-resolves to numeric IDs (CPU=1000, devices=1,2,3...). E.g., 'sim_uart.TX' or 'CPU.P3_1'"),
        to: tool.schema.string().describe("Target: deviceRef.pinName — accepts display_name, numeric ID, or 'CPU'. Tool auto-resolves to numeric IDs (CPU=1000, devices=1,2,3...). E.g., 'CPU.P3_1' or 'sim_adc.ch0'"),
      }),
    )
    .optional()
    .describe("Pin/signal connections between devices. Use display_name or numeric ID — tool auto-resolves to numeric IDs required by VTE parser"),
  vport_connections: tool.schema
    .array(
      tool.schema.object({
        from: tool.schema.string().describe("Source: deviceRef.portName — accepts display_name, numeric ID, or 'CPU'. Auto-resolved to numeric IDs"),
        to: tool.schema.string().describe("Target: deviceRef.portName — accepts display_name, numeric ID, or 'CPU'. Auto-resolved to numeric IDs"),
      }),
    )
    .optional()
    .describe("Virtual port data connections between devices"),
  source_files: tool.schema
    .array(tool.schema.string())
    .optional()
    .describe("Source files for coverage tracking — MUST be absolute paths"),
} as const

/**
 * vtest_project_generate — Generate a VTest .vte project file.
 * Used by: EnvArchitect agent (Phase 5)
 */
export const vtestProjectGenerator: ToolDefinition = tool({
  description:
    "Generate a VTest .vte project file for embedded target simulation. " +
    "Configures CPU simulator, memory map, virtual peripheral DLLs, and hardware connections. " +
    "Output file is written to .matrix/test-env/project.vte.",
  args: vteProjectArgs,
  async execute(args) {
    return executeProjectGenerate(args)
  },
})

/**
 * vtest_project_update — Regenerate the VTE project file after all device DLLs have been created.
 * This overwrites the existing project.vte with a complete device/connection configuration.
 * Used by: EnvArchitect agent (Phase 5) — called AFTER all vtest_device_generate calls.
 */
export const vtestProjectUpdater: ToolDefinition = tool({
  description:
    "Regenerate the VTest .vte project file after all device DLLs have been created. " +
    "Call this AFTER all vtest_device_generate calls to ensure the VTE file includes " +
    "complete [Devices], [Names], [Connect], and [DeviceProperty] sections. " +
    "Overwrites the existing .matrix/test-env/project.vte.",
  args: vteProjectArgs,
  async execute(args) {
    return executeProjectGenerate(args)
  },
})
