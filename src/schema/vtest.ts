import { z } from "zod"

/** Physical memory block in VTest project */
export const VteMemoryBlock = z.object({
  start: z.string().describe("Start address in hex (e.g., '0x0000')"),
  end: z.string().describe("End address in hex (e.g., '0xFFFF')"),
  type: z.number().default(0).describe("Memory type: 0=internal RAM, 1=ROM, 2=external"),
})
export type VteMemoryBlock = z.infer<typeof VteMemoryBlock>

/** Virtual device entry */
export const VteDevice = z.object({
  dll_path: z.string().describe("Path to device DLL. Custom/user-developed DLLs: use absolute path or relative path (auto-resolved to absolute). VTest system DLLs: use DLL name only (no directory)"),
  display_name: z.string().describe("Device name — English variable-name style (e.g., 'sim_uart', 'sim_adc'). Used in [Names] and [Connect]"),
  properties: z.record(z.string(), z.string()).default({}).describe("Device initialization properties (key=value)"),
})
export type VteDevice = z.infer<typeof VteDevice>

/** Pin connection between devices — VTE parser requires numeric device IDs (sscanf "%d.%s") */
export const VtePinConnection = z.object({
  from: z.string().describe("Source: numericID.pinName or displayName.pinName — CPU=1000. Tool resolves names to numeric IDs"),
  to: z.string().describe("Target: numericID.pinName or displayName.pinName — CPU=1000. Tool resolves names to numeric IDs"),
})
export type VtePinConnection = z.infer<typeof VtePinConnection>

/** Virtual port connection — VTE parser requires numeric device IDs */
export const VteVPortConnection = z.object({
  from: z.string().describe("Source: numericID.portName or displayName.portName — CPU=1000"),
  to: z.string().describe("Target: numericID.portName or displayName.portName — CPU=1000"),
})
export type VteVPortConnection = z.infer<typeof VteVPortConnection>

/** BinDll entry for binary parser DLL */
export const VteBinDll = z.object({
  dll_name: z.string().describe("Binary parser DLL name (e.g., 'binparser.dll')"),
  param: z.string().default("0x0").describe("Parameter passed to parser DLL"),
})
export type VteBinDll = z.infer<typeof VteBinDll>

/** Complete VTest project configuration */
export const VteProject = z.object({
  project_name: z.string(),
  version: z.string().default("1.0"),
  cpu_dll: z.string().describe("CPU simulator DLL filename only — no directory (e.g., 'C8052.dll', 'C6713.dll'). VTest loads from its own cpu/ dir"),
  cpu_freq_mhz: z.number().describe("CPU frequency in MHz"),
  cpu_type: z.enum(["SWIQ", "VTEST"]).default("VTEST").describe("CPU type: SWIQ for embedded, VTEST for regular"),
  binary_files: z.array(z.string()).describe("Compiled firmware files — MUST be absolute paths. Supports OMF51 format (no extension). Do NOT alter firmware paths specified in config"),
  bin_dlls: z.array(VteBinDll).default([{ dll_name: "binparser.dll", param: "0x0" }]).describe("Binary parser DLLs (default: binparser.dll,0x0)"),
  source_files: z.array(z.string()).default([]).describe("Source files for coverage — MUST be absolute paths"),
  memory_map: z.array(VteMemoryBlock).describe("Physical memory blocks"),
  devices: z.array(VteDevice).describe("Virtual peripheral DLLs"),
  pin_connections: z.array(VtePinConnection).default([]),
  vport_connections: z.array(VteVPortConnection).default([]),
  disable_coverage: z.boolean().default(false),
})
export type VteProject = z.infer<typeof VteProject>

/** Port definition for a virtual device DLL */
export const DevicePort = z.object({
  name: z.string().describe("Port name (e.g., 'uart_data', 'PIN_INT')"),
  type: z.enum(["pin", "vport"]).describe("Port type: pin for GPIO, vport for data"),
  direction: z.enum(["input", "output", "bidirectional"]).default("bidirectional"),
})
export type DevicePort = z.infer<typeof DevicePort>

/** Memory-mapped register for a virtual device */
export const DeviceRegister = z.object({
  name: z.string(),
  address: z.string().describe("Hex address (e.g., '0x4000')"),
  width: z.enum(["8", "16", "32"]).default("8"),
  access: z.enum(["read", "write", "readwrite"]).default("readwrite"),
  description: z.string().optional(),
  role: z.enum(["tx_data", "rx_data", "tx_rx_data", "status", "control", "baud_rate", "general"]).optional()
    .describe("Register role for UART/RS422 devices. tx_rx_data = shared TX/RX register (classic UARTs). Drives MEMREAD/MEMWRITE code generation."),
})
export type DeviceRegister = z.infer<typeof DeviceRegister>

/** Virtual device specification for DLL source generation */
export const VteDeviceSpec = z.object({
  device_name: z.string().describe("Device name (used as filename, e.g., 'sim-1553b')"),
  device_type: z.enum(["uart", "can", "1553b", "rs422", "gpio", "adc", "timer", "spi", "i2c", "custom"]),
  ports: z.array(DevicePort),
  registers: z.array(DeviceRegister).default([]),
  protocol_params: z.record(z.string(), z.string()).default({}).describe(
    "Protocol-specific parameters. " +
    "For UART/RS422 frame protocol, use these conventional keys: " +
    "frame_header (hex bytes, e.g. 'AA55'), " +
    "frame_tail (hex bytes, e.g. '0D0A', optional), " +
    "checksum_type ('sum8'|'xor'|'crc8'|'crc16_modbus'|'crc16_ccitt'|'none'), " +
    "checksum_scope ('payload'|'header_and_payload'|'full_frame'), " +
    "length_field ('byte2'|'byte3'|'none' — position of length byte in frame), " +
    "length_includes ('payload_only'|'header_to_tail'), " +
    "max_frame_size (decimal, default 256). " +
    "CRITICAL: Extract checksum_type from target firmware source code — wrong checksums cause frame rejection."
  ),
  behavior_description: z.string().describe("Natural language description of device behavior"),
  interrupt_config: z.object({
    pin_name: z.string().describe("Name of the interrupt Pin port in the device (e.g., 'INT_PIN')"),
    cpu_pin: z.string().describe("CPU pin name to connect to (e.g., 'P3_2' for INT0, 'P3_3' for INT1)"),
    trigger: z.enum(["level_low", "edge_falling"]).default("level_low").describe("Interrupt trigger mode"),
    description: z.string().optional(),
  }).optional().describe("Interrupt configuration for devices that use external interrupt lines (e.g., external UART chips like 82C52 using INT0/P3_2)"),
})
export type VteDeviceSpec = z.infer<typeof VteDeviceSpec>

/** Baseline verification test item */
export const BaselineTestItem = z.object({
  name: z.string(),
  type: z.enum(["connectivity", "loopback", "timing", "boundary", "fault_injection"]),
  interface_name: z.string(),
  stimulus: z.string().describe("Stimulus command in VTest script format. Command name MUST be a valid C identifier (letters, digits, underscores; no Chinese/spaces/special chars). Example: 'set_adc_input,ch0=2048'"),
  expected_response: z.string(),
  time_offset_s: z.number().describe("Simulation time offset in seconds"),
})
export type BaselineTestItem = z.infer<typeof BaselineTestItem>

/** VTest runner execution result */
export const VtestRunResult = z.object({
  status: z.enum(["completed", "timeout", "error", "device_exit"]),
  exit_code: z.number(),
  reason: z.string().optional(),
  simulation_time_seconds: z.number().optional(),
  simulation_ticks: z.number().optional(),
  log_summary: z.string().optional(),
  test_results: z.any().optional(),
  coverage: z.object({
    statement: z.number().optional(),
    branch: z.number().optional(),
  }).optional(),
})
export type VtestRunResult = z.infer<typeof VtestRunResult>
