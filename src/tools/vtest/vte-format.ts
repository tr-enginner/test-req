import { basename, resolve, isAbsolute } from "path"
import { existsSync } from "fs"
import type { VteProject } from "../../schema/vtest"

/**
 * Options for VTE serialization.
 */
export interface SerializeVteOptions {
  /** Directory where the .vte file will be written. Used to resolve relative DLL paths to absolute. */
  vteDir?: string
  /** Project root directory. Used to resolve relative BinFiles/SourceFiles paths to absolute.
   *  BinFiles (firmware) and SourceFiles live relative to the project root, NOT relative to vteDir. */
  projectDir?: string
}

/**
 * Serialize a VteProject to INI-style .vte format.
 * Reference: VTest项目文件vte格式说明.md
 *
 * @param project - VTE project configuration
 * @param options - Serialization options (e.g., vteDir for absolute path resolution)
 */
export function serializeVte(project: VteProject, options?: SerializeVteOptions): string {
  const lines: string[] = []

  lines.push("[ProjectName]")
  lines.push(`1=${project.project_name}`)

  lines.push("[VersionName]")
  lines.push(`1=${project.version}`)

  lines.push("[SwiType]")
  lines.push(`CTYPE=${project.cpu_type}`)

  lines.push("[Property]")
  lines.push("EnableSymFile=FALSE")
  lines.push("RecoveryMode=TRUE")
  lines.push("DisableSymbolInfo=FALSE")
  lines.push("DisableLineNumInfo=FALSE")
  lines.push("EnableExcuteTrace=FALSE")
  lines.push("MultiSpeed=1")
  lines.push("ShowWaitDlg=TRUE")
  lines.push("IsCheckNeedRebuild=FALSE")
  if (project.disable_coverage) {
    lines.push("DISABLE_COV=TRUE")
  }

  // [Cpu] MUST be just the DLL filename (e.g., "C8052.dll"), no directory prefix.
  // VTest automatically loads from its own cpu/ directory.
  // Always strip any directory prefix to prevent path issues.
  const cpuDllName = basename(project.cpu_dll)
  lines.push("[Cpu]")
  lines.push(`1=${cpuDllName}`)

  lines.push("[CpuFre]")
  lines.push(`1=${project.cpu_freq_mhz}`)

  // [BinFiles] MUST use absolute paths. VTest supports OMF51 format (no extension).
  // Do NOT alter the filename — config firmware paths are authoritative.
  // Relative paths are resolved from projectDir (project root), NOT vteDir (.matrix/test-env/).
  lines.push("[BinFiles]")
  for (let i = 0; i < project.binary_files.length; i++) {
    const rawPath = project.binary_files[i]
    let binPath = rawPath
    if (!isAbsolute(rawPath)) {
      // Firmware files are relative to project root, not to .matrix/test-env/
      const baseDir = options?.projectDir ?? options?.vteDir
      if (baseDir) binPath = resolve(baseDir, rawPath)
    }
    lines.push(`${i + 1}=${binPath}`)
  }

  // [BinDll] — fixed value, must not be modified
  lines.push("[BinDll]")
  lines.push("1=BinParser.dll,0x0")

  // [SourceFiles] MUST use absolute paths for source files.
  // Relative paths are resolved from projectDir (project root), NOT vteDir (.matrix/test-env/).
  if (project.source_files.length > 0) {
    lines.push("[SourceFiles]")
    for (let i = 0; i < project.source_files.length; i++) {
      const rawPath = project.source_files[i]
      let srcPath = rawPath
      if (!isAbsolute(rawPath)) {
        const baseDir = options?.projectDir ?? options?.vteDir
        if (baseDir) srcPath = resolve(baseDir, rawPath)
      }
      lines.push(`${i + 1}=${srcPath}`)
    }
  }

  // For MCS-51 (8051/8052/C51), type 0 (internal RAM) and type 1 (internal ROM) are
  // built into the CPU simulator — only type 2 (external memory / XDATA) needs to be
  // configured. Force a fixed XDATA block "1=0x0,0xffff,2" to avoid omissions.
  const isMcs51 = isMcs51Cpu(project.cpu_dll)

  // Collect device BaseAddress entries that need PhyMem regions.
  // CAN (SJA1000) and other memory-mapped devices require their register
  // address range to appear in [PhyMem], otherwise VTest cannot resolve
  // CPU read/write to those addresses.
  const deviceMemBlocks: { start: string; end: string }[] = []
  for (const dev of project.devices) {
    const baseAddr = dev.properties["BaseAddress"] ?? dev.properties["base"]
    if (!baseAddr) continue
    const addr = parseInt(baseAddr, 0)
    if (isNaN(addr)) continue
    // Default CAN/SJA1000 register space: 0x80 bytes (128 registers).
    // Round up to 0x100 (256) to cover aliased/extended register windows.
    const endAddr = addr + 0xFF
    // Check if this range is already covered by an existing PhyMem entry
    const alreadyCovered = project.memory_map.some(m => {
      const s = parseInt(m.start, 0)
      const e = parseInt(m.end, 0)
      return !isNaN(s) && !isNaN(e) && addr >= s && endAddr <= e
    })
    if (!alreadyCovered) {
      deviceMemBlocks.push({
        start: "0x" + addr.toString(16),
        end: "0x" + endAddr.toString(16),
      })
    }
  }

  lines.push("[PhyMem]")
  if (isMcs51) {
    // MCS-51: fixed XDATA memory definition — always emit exactly this entry.
    // XDATA 0x0000-0xFFFF covers the full external address space, so device
    // BaseAddress entries (e.g., CAN at 0x2000) are already within range.
    lines.push("1=0x0,0xffff,2")
  } else {
    for (let i = 0; i < project.memory_map.length; i++) {
      const m = project.memory_map[i]
      // Non-MCS-51 CPUs: force memory type to 0 (RAM) — type 0 is the correct
      // default for most simulators. MCS-51 is the only platform that uses
      // type 2 (external/XDATA) because internal RAM/ROM (type 0/1) are built-in.
      lines.push(`${i + 1}=${m.start},${m.end},0`)
    }
    // Append device memory blocks not already covered by user-defined memory_map.
    // This ensures CAN (SJA1000) and similar memory-mapped devices work even if
    // the user did not explicitly include the register region in memory_map.
    for (let j = 0; j < deviceMemBlocks.length; j++) {
      const idx = project.memory_map.length + j + 1
      lines.push(`${idx}=${deviceMemBlocks[j].start},${deviceMemBlocks[j].end},0`)
    }
  }

  if (project.devices.length > 0) {
    lines.push("[Devices]")
    for (let i = 0; i < project.devices.length; i++) {
      // Devices path rules:
      //   - System DLLs (from vtest\system): DLL name only (no directory prefix).
      //     Detected by: bare name with no directory separators (e.g., "sim_82c52.dll")
      //   - Custom/user-developed DLLs: MUST be absolute paths.
      //     Detected by: path with directory separators or already absolute
      const rawPath = project.devices[i].dll_path
      const hasDirComponent = rawPath.includes("/") || rawPath.includes("\\")
      let dllPath: string
      if (!hasDirComponent) {
        // Bare DLL name — could be system DLL or user DLL without path.
        // User DLLs: resolve to <vteDir>/Debug/<name> (MSBuild OutDir = $(SolutionDir)Debug/)
        // System DLLs (from vtest\system): keep as name only.
        // Heuristic: if the DLL exists in <vteDir>/Debug/, it's a user DLL.
        if (options?.vteDir) {
          const debugPath = resolve(options.vteDir, "Debug", rawPath)
          if (existsSync(debugPath)) {
            dllPath = debugPath
          } else {
            // Also check if sim-models/Debug or drivers/Debug has it
            const simDebugPath = resolve(options.vteDir, "sim-models", "Debug", rawPath)
            const drvDebugPath = resolve(options.vteDir, "drivers", "Debug", rawPath)
            if (existsSync(simDebugPath)) dllPath = simDebugPath
            else if (existsSync(drvDebugPath)) dllPath = drvDebugPath
            else dllPath = rawPath // system DLL, keep bare name
          }
        } else {
          dllPath = rawPath
        }
      } else if (isAbsolute(rawPath)) {
        // Already absolute — use as-is
        dllPath = rawPath
      } else {
        // Relative path with directory — resolve to absolute
        dllPath = options?.vteDir
          ? resolve(options.vteDir, rawPath)
          : rawPath
      }
      lines.push(`${i + 1}=${dllPath}`)
    }

    lines.push("[Names]")
    for (let i = 0; i < project.devices.length; i++) {
      lines.push(`${i + 1}=${sanitizeDeviceName(project.devices[i].display_name)}`)
    }
  }

  // Build device ref → numeric ID map for connection resolution.
  // VTE parser uses sscanf("%d.%s") — ONLY numeric device IDs are supported.
  // Input accepts: display_name, sanitized name, DLL filename, or numeric ID.
  // Output is ALWAYS numeric: "1000.pinName" for CPU, "N.pinName" for devices.
  const refToNumId = new Map<string, number>()
  for (let i = 0; i < project.devices.length; i++) {
    const dev = project.devices[i]
    const numId = i + 1
    const sanitized = sanitizeDeviceName(dev.display_name)
    // Map all possible references to numeric ID
    refToNumId.set(String(numId), numId)
    refToNumId.set(sanitized.toLowerCase(), numId)
    refToNumId.set(dev.display_name.toLowerCase(), numId)
    // Also map DLL filename (with and without .dll extension)
    const dllBase = basename(dev.dll_path)
    refToNumId.set(dllBase.toLowerCase(), numId)
    const dllNoExt = dllBase.replace(/\.dll$/i, "")
    refToNumId.set(dllNoExt.toLowerCase(), numId)
  }

  /**
   * Resolve a connection endpoint "deviceRef.portName" to "numericID.portName".
   * Input deviceRef can be: a numeric ID, a display_name, a DLL filename, or "CPU"/"1000".
   * Output MUST be numeric: VTE parser uses sscanf("%d.%s").
   * CPU is always 1000, devices are 1-based indices.
   */
  function resolveEndpoint(endpoint: string): string {
    const dotIdx = endpoint.indexOf(".")
    if (dotIdx < 0) return endpoint // malformed, pass through
    const devRef = endpoint.substring(0, dotIdx).trim()
    const portName = endpoint.substring(dotIdx + 1).trim()
    // CPU references: "CPU" or "1000" → 1000
    if (devRef === "1000" || devRef.toUpperCase() === "CPU") return `1000.${portName}`
    // Already a numeric ID
    if (/^\d+$/.test(devRef)) return `${devRef}.${portName}`
    // Lookup by any supported reference format → resolve to numeric ID
    const numId = refToNumId.get(devRef.toLowerCase())
    if (numId !== undefined) return `${numId}.${portName}`
    return endpoint // unresolved, pass through
  }

  if (project.pin_connections.length > 0) {
    lines.push("[Connect]")
    for (let i = 0; i < project.pin_connections.length; i++) {
      const c = project.pin_connections[i]
      lines.push(`${i + 1}=${resolveEndpoint(c.from)},${resolveEndpoint(c.to)}`)
    }
  }

  if (project.vport_connections.length > 0) {
    lines.push("[VPortConnect]")
    for (let i = 0; i < project.vport_connections.length; i++) {
      const c = project.vport_connections[i]
      lines.push(`${i + 1}=${resolveEndpoint(c.from)},${resolveEndpoint(c.to)}`)
    }
  }

  const propEntries: string[] = []
  // PortEnable=1,3 is MCS-51 specific — enables P1 and P3 port groups for pin connections.
  // Other CPU simulators (C67x, F2812, BM3803, etc.) do not use this property.
  if (isMcs51) {
    propEntries.push("1000, PortEnable=1,3")
  }
  for (let i = 0; i < project.devices.length; i++) {
    const dev = project.devices[i]
    for (const [key, value] of Object.entries(dev.properties)) {
      propEntries.push(`${i + 1}, ${key}=${value}`)
    }
  }
  if (propEntries.length > 0) {
    lines.push("[DeviceProperty]")
    for (let i = 0; i < propEntries.length; i++) {
      lines.push(`${i + 1}=${propEntries[i]}`)
    }
  }

  return lines.join("\n") + "\n"
}

/**
 * Map common CPU architecture names to VTest CPU DLL names.
 */
export const CPU_DLL_MAP: Record<string, string> = {
  "8031": "C8031.dll",
  "8051": "C8052.dll",
  "8052": "C8052.dll",
  "c51": "C8052.dll",
  "80c52": "C8052.dll",
  "c6713": "C6713.dll",
  "c6701": "C6701.dll",
  "c6416": "C6416.dll",
  "c6678": "C6678.dll",
  "tms320c6713": "C6713.dll",
  "tms320c6701": "C6701.dll",
  "tms320c6416": "C6416.dll",
  "f2812": "F2812.dll",
  "f28335": "F28335.dll",
  "at697f": "AT697F.dll",
  "tsc695": "TSC695.dll",
  "bm3803": "BM3803.dll",
  "bm3823": "BM3823.dll",
  "zynq7000": "ZYNQ7000.dll",
  "ls3a3000": "LS3A3000.dll",
  "ls1e300": "LS1E300.dll",
  "atmega128": "ATmega128.dll",
  "80386": "80386.dll",
  "mpc8245": "MPC8245.dll",
}

/**
 * Sanitize a device display name into an English variable-name style identifier.
 * Rules: lowercase, only [a-z0-9_], no leading digits, collapse multiple underscores.
 * Examples:
 *   "UART 模拟器" → "uart"
 *   "sim-1553b" → "sim_1553b"
 *   "vdev_adc.dll" → "vdev_adc"
 *   "ADC Simulator" → "adc_simulator"
 */
export function sanitizeDeviceName(name: string): string {
  let s = name
    .replace(/\.dll$/i, "")          // strip .dll extension
    .replace(/[^a-zA-Z0-9_\s-]/g, "") // remove non-ASCII / special chars
    .trim()
    .replace(/[\s-]+/g, "_")          // spaces/hyphens → underscore
    .replace(/_+/g, "_")              // collapse multiple underscores
    .replace(/^_|_$/g, "")            // trim leading/trailing underscores
    .toLowerCase()
  // Ensure doesn't start with a digit
  if (/^\d/.test(s)) s = `dev_${s}`
  // Fallback if empty
  if (!s) s = "device"
  return s
}

/**
 * Resolve CPU DLL from target_cpu string.
 */
export function resolveCpuDll(targetCpu: string): string | null {
  const cpu = targetCpu.toLowerCase().trim()
  if (CPU_DLL_MAP[cpu]) return CPU_DLL_MAP[cpu]
  for (const [key, dll] of Object.entries(CPU_DLL_MAP)) {
    if (cpu.includes(key)) return dll
  }
  return null
}

/**
 * Check if a CPU DLL is MCS-51 family (8031/8051/8052/C51).
 * MCS-51 simulators have type 0 (internal RAM) and type 1 (internal ROM) built in,
 * so these memory types should NOT appear in [PhyMem].
 */
export function isMcs51Cpu(cpuDll: string): boolean {
  const name = cpuDll.toLowerCase().replace(/\.dll$/i, "")
  return /^c?80[35][12]$/.test(name) || name === "c51"
}
