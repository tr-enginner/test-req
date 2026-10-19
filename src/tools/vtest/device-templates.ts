import type { VteDeviceSpec } from "../../schema/vtest"
import {
  generateVcxproj,
  generateVcxprojFilters,
  generateSln,
  deterministicGuid,
  type SlnProject,
} from "./vcxproj-templates"

/** Check if a device type requires UART/serial memory-mapped simulation */
function isUartDevice(deviceType: string): boolean {
  return deviceType === "uart" || deviceType === "rs422"
}

/** Check if device has memory-mapped registers that need SetWatchOnMemoryM.
 *  Pure GPIO/timer devices with only pin ports don't need memory monitoring. */
function hasMemoryMappedRegisters(spec: { device_type: string; registers: { address: string }[]; ports: { type: string }[] }): boolean {
  if (spec.registers.length === 0) return false
  if ((spec.device_type === "gpio" || spec.device_type === "timer") &&
      spec.ports.every(p => p.type === "pin")) return false
  return true
}

type RegisterInfo = {
  name: string
  address: string
  role?: string
}

/**
 * Validate and auto-fix UART/RS422 device specs.
 *
 * When device_type is "uart" or "rs422", the code generator requires:
 * 1. At least one VPort-type port (for data transfer to/from test driver)
 * 2. Registers with role fields (tx_data, rx_data, status) for MEMREAD/MEMWRITE code generation
 *
 * Without these, the generator falls back to empty stubs (no FIFO, no SetWatchOnMemoryM, no WriteVPort).
 * This function detects missing configuration and auto-corrects it, logging warnings.
 */
export function validateAndFixUartSpec(spec: VteDeviceSpec): { spec: VteDeviceSpec; warnings: string[] } {
  if (!isUartDevice(spec.device_type)) {
    return { spec, warnings: [] }
  }

  const warnings: string[] = []
  // Work on a mutable copy
  const fixed: VteDeviceSpec = {
    ...spec,
    ports: spec.ports.map((p) => ({ ...p })),
    registers: spec.registers.map((r) => ({ ...r })),
  }

  // Check 1: Must have VPort-type ports for data transfer
  const hasVPort = fixed.ports.some((p) => p.type === "vport")
  if (!hasVPort) {
    warnings.push(
      `[UART auto-fix] device_type="${spec.device_type}" but no VPort ports defined (all ports are pin type). ` +
      `UART devices need VPort ports for byte-level data transfer. Adding TX_DATA/RX_DATA VPort ports.`
    )
    // Check if TX/RX pin ports exist — convert them to vport
    const txPin = fixed.ports.find((p) => p.name.toUpperCase() === "TX" || p.name.toUpperCase() === "TXD")
    const rxPin = fixed.ports.find((p) => p.name.toUpperCase() === "RX" || p.name.toUpperCase() === "RXD")
    if (txPin) {
      txPin.type = "vport"
      txPin.name = "TX_DATA"
      txPin.direction = "output"
    } else {
      fixed.ports.push({ name: "TX_DATA", type: "vport", direction: "output" })
    }
    if (rxPin) {
      rxPin.type = "vport"
      rxPin.name = "RX_DATA"
      rxPin.direction = "input"
    } else {
      fixed.ports.push({ name: "RX_DATA", type: "vport", direction: "input" })
    }
  }

  // Check 2: Registers must have role fields for code generation
  if (fixed.registers.length > 0) {
    const hasTxData = fixed.registers.some((r) => r.role === "tx_data")
    const hasRxData = fixed.registers.some((r) => r.role === "rx_data")
    const hasStatus = fixed.registers.some((r) => r.role === "status")

    if (!hasTxData && !hasRxData && !hasStatus) {
      warnings.push(
        `[UART auto-fix] device_type="${spec.device_type}" but no registers have role fields (tx_data/rx_data/status). ` +
        `Without roles, VTT_MEMREAD/MEMWRITE handlers will be empty stubs. Attempting to infer roles from register names/descriptions.`
      )
      // Heuristic: infer roles from register names or descriptions
      for (const reg of fixed.registers) {
        const nameUpper = reg.name.toUpperCase()
        const desc = (reg.description || "").toLowerCase()
        if (!reg.role || reg.role === "general") {
          if (nameUpper.includes("SBUF") || nameUpper.includes("THR") || nameUpper.includes("TXD") ||
              nameUpper.includes("DATA") || nameUpper.includes("DR") ||
              desc.includes("发送") || desc.includes("transmit") || desc.includes("tx data") || desc.includes("数据")) {
            // First data register → tx_data (doubles as rx_data via FIFO)
            if (!fixed.registers.some((r) => r.role === "tx_data")) {
              reg.role = "tx_data"
              warnings.push(`  → Register "${reg.name}" (${reg.address}): inferred role="tx_data"`)
              continue
            }
          }
          if (nameUpper.includes("SCON") || nameUpper.includes("LSR") || nameUpper.includes("STATUS") ||
              nameUpper.includes("UCR") || nameUpper.includes("USR") || nameUpper.includes("SR") ||
              desc.includes("状态") || desc.includes("status") || desc.includes("控制") && desc.includes("状态")) {
            if (!fixed.registers.some((r) => r.role === "status")) {
              reg.role = "status"
              warnings.push(`  → Register "${reg.name}" (${reg.address}): inferred role="status"`)
              continue
            }
          }
          if (nameUpper.includes("PCON") || nameUpper.includes("MCR") || nameUpper.includes("CTRL") ||
              nameUpper.includes("CR") || nameUpper.includes("CONTROL") ||
              desc.includes("控制") || desc.includes("control")) {
            if (!fixed.registers.some((r) => r.role === "control")) {
              reg.role = "control"
              warnings.push(`  → Register "${reg.name}" (${reg.address}): inferred role="control"`)
              continue
            }
          }
          if (nameUpper.includes("BRT") || nameUpper.includes("BRR") || nameUpper.includes("BRSR") ||
              nameUpper.includes("BAUD") || nameUpper.includes("DLM") || nameUpper.includes("DLL") ||
              desc.includes("波特率") || desc.includes("baud")) {
            if (!fixed.registers.some((r) => r.role === "baud_rate")) {
              reg.role = "baud_rate"
              warnings.push(`  → Register "${reg.name}" (${reg.address}): inferred role="baud_rate"`)
              continue
            }
          }
        }
      }

      // If we still don't have tx_data, assign the first register
      if (!fixed.registers.some((r) => r.role === "tx_data") && fixed.registers.length > 0) {
        fixed.registers[0].role = "tx_data"
        warnings.push(`  → Register "${fixed.registers[0].name}" (${fixed.registers[0].address}): assigned role="tx_data" (first register fallback)`)
      }
      // If we still don't have status and there are 2+ registers, assign the second
      if (!fixed.registers.some((r) => r.role === "status") && fixed.registers.length > 1) {
        const candidate = fixed.registers.find((r) => !r.role || r.role === "general")
        if (candidate) {
          candidate.role = "status"
          warnings.push(`  → Register "${candidate.name}" (${candidate.address}): assigned role="status" (fallback)`)
        }
      }
      // If we still don't have rx_data, mark the tx_data register as also serving rx_data.
      // Classic UARTs (8251, 82C52, 16550) use a single data register for both TX and RX.
      // Without rx_data, VTT_MEMREAD won't generate FIFO pop code → CPU can never read received data.
      if (!fixed.registers.some((r) => r.role === "rx_data")) {
        const txDataReg = fixed.registers.find((r) => r.role === "tx_data")
        if (txDataReg) {
          txDataReg.role = "tx_rx_data"
          warnings.push(
            `[UART auto-fix] No rx_data register defined. Marked "${txDataReg.name}" (${txDataReg.address}) as tx_rx_data ` +
            `(shared TX/RX). Classic UARTs (8251/82C52/16550) use one register for both directions.`
          )
        }
      }
    }
  } else {
    warnings.push(
      `[UART warning] device_type="${spec.device_type}" but no registers defined. ` +
      `UART simulation requires memory-mapped registers for CPU↔device communication. ` +
      `The generated code will have no SetWatchOnMemoryM and no MEMREAD/MEMWRITE handlers.`
    )
  }

  // Check 3: UART devices with INT pin ports should have interrupt_config
  if (!fixed.interrupt_config) {
    const intPin = fixed.ports.find((p) =>
      p.type === "pin" && /int/i.test(p.name)
    )
    if (intPin) {
      // Auto-create interrupt_config based on the INT pin port
      fixed.interrupt_config = {
        pin_name: intPin.name,
        cpu_pin: "P3_2",  // Default to INT0 (most common for external UART)
        trigger: "level_low" as const,
        description: `Auto-inferred: ${intPin.name} triggers CPU external interrupt`,
      }
      warnings.push(
        `[UART auto-fix] Found INT pin port "${intPin.name}" but no interrupt_config provided. ` +
        `Auto-created interrupt_config with cpu_pin="P3_2" (INT0). ` +
        `If the firmware uses INT1 (P3_3), manually specify interrupt_config.cpu_pin="P3_3".`
      )
    } else {
      // No INT pin at all — warn that interrupt-driven RX won't work
      warnings.push(
        `[UART warning] No interrupt_config and no INT pin port found. ` +
        `Without interrupts, CPU won't know when data arrives in the FIFO. ` +
        `For external UART chips (82C52, 16550), add an IOPIN port named "INT_PIN" and provide interrupt_config.`
      )
    }
  }

  return { spec: fixed, warnings }
}

/** Compute min/max register addresses for SetWatchOnMemoryM range */
function getRegisterRange(registers: RegisterInfo[]): { min: string; max: string } | null {
  if (registers.length === 0) return null
  const addrs = registers.map((r) => parseInt(r.address, 16))
  const min = Math.min(...addrs)
  const max = Math.max(...addrs)
  return { min: `0x${min.toString(16).toUpperCase()}`, max: `0x${max.toString(16).toUpperCase()}` }
}

/** Find register by role, returning its address macro name.
 *  Supports combined roles: tx_rx_data matches both "tx_data" and "rx_data" queries. */
function findRegByRole(registers: RegisterInfo[], role: string): string | null {
  // Direct match first
  let reg = registers.find((r) => r.role === role)
  if (!reg && (role === "tx_data" || role === "rx_data")) {
    // Fall back to combined tx_rx_data role (shared register for TX and RX)
    reg = registers.find((r) => r.role === "tx_rx_data")
  }
  return reg ? `REG_${reg.name.toUpperCase()}` : null
}

/**
 * Generate the MainProc C++ source framework for a VTest virtual device DLL.
 *
 * Matches real VTest API (from vttDevice.h / vtest-src):
 *   - extern "C" vttRES WINAPI MainProc(vttMESSAGE, void*, DWORD)
 *   - Global struct VTTFUNCS vtt (in stdafx.cpp)
 *   - vtt.ConfirmDevID(pData) at MainProc entry
 *   - vtt.GetFunctionPointers(dwParam, pData) in VTT_INIT
 *   - VTT_QPORTS returns (vttRES)gPorts
 *   - VTT_QSIZE returns sizeof(TCHIP_HEADER)
 */
export function generateDeviceSource(spec: VteDeviceSpec): string {
  // Validate and auto-fix UART/RS422 specs before generation
  const { spec: fixedSpec, warnings } = validateAndFixUartSpec(spec)
  if (warnings.length > 0) {
    // Log warnings to stderr so they appear in tool output
    for (const w of warnings) {
      console.error(w)
    }
  }
  // Use the fixed spec for code generation
  spec = fixedSpec

  const guardName = spec.device_name.toUpperCase().replace(/[^A-Z0-9]/g, "_")

  // Build port enum
  const portEnumEntries = spec.ports.map((p, i) =>
    `    ${p.name.toUpperCase()} = ${i},`
  ).join("\n")
  const portCount = spec.ports.length

  // Build port array entries
  const portArrayEntries = spec.ports.map((p) => {
    const portType = p.type === "vport" ? "VIOPORT" : "IOPIN"
    return `    { ${p.name.toUpperCase()},  "${p.name}",  ${portType} },`
  }).join("\n")

  // Register defines
  const regDefs = spec.registers
    .map((r) => `#define REG_${r.name.toUpperCase()}  ${r.address}  /* ${r.description || r.name} */`)
    .join("\n")

  // Register state fields
  const stateFields = spec.registers
    .map((r) => {
      const cType = r.width === "32" ? "DWORD" : r.width === "16" ? "WORD" : "BYTE"
      return `    ${cType} m_${r.name};`
    })
    .join("\n")

  // Register reset lines
  const regResetLines = spec.registers
    .map((r) => `    g_state.m_${r.name} = 0;`)
    .join("\n")

  const isUart = isUartDevice(spec.device_type)
  const regRange = getRegisterRange(spec.registers)

  // Extract protocol params for UART frame handling
  const frameHeader = isUart ? (spec.protocol_params?.frame_header || "") : ""
  const frameTail = isUart ? (spec.protocol_params?.frame_tail || "") : ""
  const checksumType = isUart ? (spec.protocol_params?.checksum_type || "none") : "none"
  const checksumScope = isUart ? (spec.protocol_params?.checksum_scope || "payload") : "payload"
  const lengthField = isUart ? (spec.protocol_params?.length_field || "none") : "none"
  const maxFrameSize = isUart ? (spec.protocol_params?.max_frame_size || "256") : "256"
  const hasFrameProtocol = isUart && frameHeader !== ""

  // UART register role lookups
  const txDataReg = isUart ? findRegByRole(spec.registers, "tx_data") : null
  const rxDataReg = isUart ? findRegByRole(spec.registers, "rx_data") : null
  const statusReg = isUart ? findRegByRole(spec.registers, "status") : null
  const controlReg = isUart ? findRegByRole(spec.registers, "control") : null
  const baudReg = isUart ? findRegByRole(spec.registers, "baud_rate") : null

  // Find TX VPort for UART data output (first vport-type port)
  const txVPort = isUart
    ? spec.ports.find((p) => p.type === "vport")
    : null
  const txVPortId = txVPort ? txVPort.name.toUpperCase() : null

  // Interrupt pin for external UART chips (e.g., 82C52 using INT0/P3_2)
  const intConfig = spec.interrupt_config
  const intPinPort = intConfig
    ? spec.ports.find((p) => p.name === intConfig.pin_name || p.name.toUpperCase() === intConfig.pin_name.toUpperCase())
    : null
  const intPinId = intPinPort ? intPinPort.name.toUpperCase() : null

  return `/**
 * ${spec.device_name} — VTest Virtual Device DLL
 * Type: ${spec.device_type}
 * Generated by matrix-embedded-agent
 *
 * Behavior: ${spec.behavior_description}
 */

#include "stdafx.h"
#include "vttDevice.h"
#include <string.h>
#include <stdio.h>

/* ── Register Addresses ── */
${regDefs || "/* No memory-mapped registers defined */"}

/* ── Port Definitions ── */
enum ${guardName}_PORT_ID {
${portEnumEntries}
    PORT_COUNT = ${portCount},
    TIMER_0  = 100,
};

static vttPORT gPorts[PORT_COUNT] = {
${portArrayEntries}
};

/* ── Device Properties ── */
static LPCTSTR gAttrName[] = {
    "BaseAddress",
};

/* ── Device State (global) ── */
static struct {
${stateFields || "    int placeholder;"}
    DWORD baseAddress;
    int initialized;
} g_state;
/* ── Diagnostic Counters ── */
static struct {
    int memread_count;
    int memwrite_count;
    int vport_rx_count;
    int vport_rx_bytes;
    int vport_tx_count;
    int vport_tx_bytes;
    int fifo_push_count;
    int fifo_pop_count;
    int fifo_overflow;
    int checksum_ok;
    int checksum_fail;
    double first_memread_time;
    double first_memwrite_time;
    double first_vport_rx_time;
    double last_activity_time;
} g_diag;
${isUart ? `
/* ── UART RX FIFO ── */
#define UART_FIFO_SIZE 256
static struct {
    BYTE buffer[UART_FIFO_SIZE];
    int  head;
    int  tail;
    int  count;
} g_rx_fifo;

static void fifo_reset(void) {
    g_rx_fifo.head = 0;
    g_rx_fifo.tail = 0;
    g_rx_fifo.count = 0;
}

static int fifo_push(BYTE data) {
    if (g_rx_fifo.count >= UART_FIFO_SIZE) { g_diag.fifo_overflow++; return 0; }
    g_rx_fifo.buffer[g_rx_fifo.tail] = data;
    g_rx_fifo.tail = (g_rx_fifo.tail + 1) % UART_FIFO_SIZE;
    g_rx_fifo.count++;
    g_diag.fifo_push_count++;
    return 1;
}

static int fifo_pop(BYTE *data) {
    if (g_rx_fifo.count <= 0) return 0; /* empty */
    *data = g_rx_fifo.buffer[g_rx_fifo.head];
    g_rx_fifo.head = (g_rx_fifo.head + 1) % UART_FIFO_SIZE;
    g_rx_fifo.count--;
    g_diag.fifo_pop_count++;
    return 1;
}

/* UART status bits */
#define UART_STATUS_RX_READY  0x01
#define UART_STATUS_TX_EMPTY  0x02

/* ── Checksum Utilities ── */
static BYTE checksum_sum8(const BYTE* data, int len) {
    BYTE sum = 0;
    for (int i = 0; i < len; i++) sum += data[i];
    return sum;
}

static BYTE checksum_xor(const BYTE* data, int len) {
    BYTE xval = 0;
    for (int i = 0; i < len; i++) xval ^= data[i];
    return xval;
}

static unsigned short crc16_modbus(const BYTE* data, int len) {
    unsigned short crc = 0xFFFF;
    for (int i = 0; i < len; i++) {
        crc ^= data[i];
        for (int j = 0; j < 8; j++) {
            if (crc & 1) crc = (crc >> 1) ^ 0xA001;
            else crc >>= 1;
        }
    }
    return crc;
}

static unsigned short crc16_ccitt(const BYTE* data, int len) {
    unsigned short crc = 0xFFFF;
    for (int i = 0; i < len; i++) {
        crc ^= ((unsigned short)data[i]) << 8;
        for (int j = 0; j < 8; j++) {
            if (crc & 0x8000) crc = (crc << 1) ^ 0x1021;
            else crc <<= 1;
        }
    }
    return crc;
}

static BYTE crc8(const BYTE* data, int len) {
    BYTE crc = 0;
    for (int i = 0; i < len; i++) {
        crc ^= data[i];
        for (int j = 0; j < 8; j++) {
            if (crc & 0x80) crc = (crc << 1) ^ 0x07;
            else crc <<= 1;
        }
    }
    return crc;
}
${hasFrameProtocol ? `
/* ── Frame Receive Buffer ── */
#define MAX_FRAME_SIZE ${maxFrameSize}
static struct {
    BYTE buffer[MAX_FRAME_SIZE];
    int  pos;
    int  expected_len;    /* -1 = unknown, waiting for length field */
    int  frame_complete;
} g_rx_frame;

static struct {
    BYTE buffer[MAX_FRAME_SIZE];
    int  pos;
} g_tx_frame;

static void frame_rx_reset(void) {
    g_rx_frame.pos = 0;
    g_rx_frame.expected_len = -1;
    g_rx_frame.frame_complete = 0;
}

static void frame_tx_reset(void) {
    g_tx_frame.pos = 0;
}

/* Verify checksum of a complete frame in g_rx_frame.buffer[0..frameLen-1] */
static int frame_verify_checksum(int frameLen) {
    const char* csType = "${checksumType}";
    const char* csScope = "${checksumScope}";
    if (strcmp(csType, "none") == 0) return 1; /* no checksum configured */

    int headerLen = ${Math.floor(frameHeader.length / 2)};
    int csLen = (strcmp(csType, "crc16_modbus") == 0 || strcmp(csType, "crc16_ccitt") == 0) ? 2 : 1;
    int dataStart = 0, dataLen = 0;

    if (strcmp(csScope, "payload") == 0) {
        dataStart = headerLen + (${lengthField !== "none" ? "1" : "0"});
        dataLen = frameLen - dataStart - csLen;
    } else if (strcmp(csScope, "header_and_payload") == 0) {
        dataStart = 0;
        dataLen = frameLen - csLen;
    } else { /* full_frame — checksum over everything except checksum bytes */
        dataStart = 0;
        dataLen = frameLen - csLen;
    }
    if (dataLen < 0) return 0;

    if (strcmp(csType, "sum8") == 0) {
        BYTE expected = g_rx_frame.buffer[frameLen - 1];
        return checksum_sum8(g_rx_frame.buffer + dataStart, dataLen) == expected;
    } else if (strcmp(csType, "xor") == 0) {
        BYTE expected = g_rx_frame.buffer[frameLen - 1];
        return checksum_xor(g_rx_frame.buffer + dataStart, dataLen) == expected;
    } else if (strcmp(csType, "crc8") == 0) {
        BYTE expected = g_rx_frame.buffer[frameLen - 1];
        return crc8(g_rx_frame.buffer + dataStart, dataLen) == expected;
    } else if (strcmp(csType, "crc16_modbus") == 0) {
        unsigned short expected = (unsigned short)g_rx_frame.buffer[frameLen - 2]
                                | ((unsigned short)g_rx_frame.buffer[frameLen - 1] << 8);
        return crc16_modbus(g_rx_frame.buffer + dataStart, dataLen) == expected;
    } else if (strcmp(csType, "crc16_ccitt") == 0) {
        unsigned short expected = ((unsigned short)g_rx_frame.buffer[frameLen - 2] << 8)
                                | (unsigned short)g_rx_frame.buffer[frameLen - 1];
        return crc16_ccitt(g_rx_frame.buffer + dataStart, dataLen) == expected;
    }
    return 1;
}
` : ""}` : ""}
/* ── Data Record File ── */
static FILE* g_record_file = NULL;
static char  g_record_path[260];

static void deviceRecordOpen(const char* path) {
    if (g_record_file) return;
    strncpy(g_record_path, path, sizeof(g_record_path) - 1);
    g_record_file = fopen(g_record_path, "w");
    if (g_record_file) {
        fprintf(g_record_file, "sim_time,event,port,size,data\\n");
        vtt.AddLog("[${spec.device_name}] Record file opened: %s\\n", g_record_path);
    }
}

static void deviceRecordClose(void) {
    if (g_record_file) { fclose(g_record_file); g_record_file = NULL; }
}

static void deviceRecordLog(const char* event, const char* port, int size, const char* data) {
    if (!g_record_file) return;
    fprintf(g_record_file, "%.6f,%s,%s,%d,%s\\n", vtt.GetRunTime(), event, port, size, data);
    fflush(g_record_file);
}

/* ══════════════════════════════════════════════════════════════
 * MainProc — DLL entry point called by VTest for all events
 *
 * Signature MUST be: extern "C" vttRES WINAPI MainProc(vttMESSAGE, void*, DWORD)
 * Exported via .def file.
 * ══════════════════════════════════════════════════════════════ */
extern "C" vttRES WINAPI MainProc(vttMESSAGE Msg, void *pData, DWORD dwParam)
{
    vtt.ConfirmDevID(pData);

    switch (Msg) {
    case VTT_QSIZE:
        return (vttRES)sizeof(TCHIP_HEADER);

    case VTT_INIT:
        vtt.GetFunctionPointers(dwParam, pData);
        ((TCHIP_HEADER *)pData)->nPortCount = PORT_COUNT;
        memset(&g_state, 0, sizeof(g_state));
        memset(&g_diag, 0, sizeof(g_diag));
        g_state.initialized = 1;
        vtt.AddLog("[${spec.device_name}] Initialized (type=${spec.device_type}, ID=%d)\\n", vtt.DevID());
        break;

    case VTT_QPORTS:
        return (vttRES)gPorts;

    case VTT_QPROPERTY:
        if (dwParam < sizeof(gAttrName) / sizeof(gAttrName[0]))
            return (vttRES)gAttrName[dwParam];
        return 0;

    case VTT_SETPROPERTY:
    {
        CString sPara = (LPCTSTR)dwParam;
        if (sPara.Find("BaseAddress=") >= 0) {
            CString sVal = sPara.Mid(sPara.Find('=') + 1);
            g_state.baseAddress = (DWORD)strtoul(sVal, NULL, 0);
        }
        if (sPara.Find("RecordFile=") >= 0) {
            CString sVal = sPara.Mid(sPara.Find('=') + 1);
            deviceRecordOpen((LPCTSTR)sVal);
        }
        break;
    }

    case VTT_RESET:
        if (!g_state.initialized) break;
${regResetLines || "        /* No registers to reset */"}
${(isUart || hasMemoryMappedRegisters(spec)) && regRange ? `        /* Monitor register address range for CPU read/write */
        vtt.SetWatchOnMemoryM(${regRange.min}, ${regRange.max}, 2, VTTREADWRITE);${isUart ? `
        fifo_reset();${hasFrameProtocol ? `
        frame_rx_reset();
        frame_tx_reset();` : ""}` : ""}` : `        /* TODO: Create timers for periodic device behavior */
        /* vtt.CreateTimer(TIMER_0, CYCLE_TIMER, 0.001); */`}
        vtt.AddLog("[${spec.device_name}] Reset\\n");
        break;

    case VTT_TERMINATE:
${(isUart || hasMemoryMappedRegisters(spec)) && regRange ? `        /* Remove memory watch */
        vtt.UnSetWatchOnMemoryM(${regRange.min}, ${regRange.max}, 2, VTTREADWRITE);` : `        /* vtt.DeleteTimer(TIMER_0); */`}
        /* Diagnostic summary */
        vtt.AddLog("[DIAG:${spec.device_name}] MEMREAD=%d MEMWRITE=%d VPORT_RX=%d(%dB) VPORT_TX=%d(%dB) "
                   "FIFO_PUSH=%d FIFO_POP=%d FIFO_OVF=%d CS_OK=%d CS_FAIL=%d "
                   "FIRST_RD=%.6f FIRST_WR=%.6f FIRST_VPRX=%.6f\\n",
                   g_diag.memread_count, g_diag.memwrite_count,
                   g_diag.vport_rx_count, g_diag.vport_rx_bytes,
                   g_diag.vport_tx_count, g_diag.vport_tx_bytes,
                   g_diag.fifo_push_count, g_diag.fifo_pop_count, g_diag.fifo_overflow,
                   g_diag.checksum_ok, g_diag.checksum_fail,
                   g_diag.first_memread_time, g_diag.first_memwrite_time,
                   g_diag.first_vport_rx_time);
        deviceRecordClose();
        g_state.initialized = 0;
        vtt.AddLog("[${spec.device_name}] Terminated\\n");
        break;

    case VTT_CLOCK:
        if (!g_state.initialized) break;
        /* Timer tick: dwParam = timer/pin ID */
        break;

    case VTT_VWBYTES:
    {
        if (!g_state.initialized) break;
        vttParamVWBytes *p = (vttParamVWBytes *)dwParam;
        g_diag.vport_rx_count++;
        g_diag.vport_rx_bytes += p->nSize;
        g_diag.last_activity_time = vtt.GetRunTime();
        if (g_diag.first_vport_rx_time == 0.0 && g_diag.vport_rx_count == 1)
            g_diag.first_vport_rx_time = vtt.GetRunTime();
        /* Log VPort data to console and record file */
        {
            char hexBuf[512] = {0};
            int hexLen = 0;
            int maxBytes = (p->nSize > 64) ? 64 : p->nSize;
            for (int b = 0; b < maxBytes && hexLen < (int)sizeof(hexBuf) - 4; b++) {
                hexLen += sprintf(hexBuf + hexLen, "%02X ", p->pByte[b]);
            }
            if (p->nSize > 64) strcat(hexBuf, "...");
            const char* portLabel = (p->vttPinID >= 0 && p->vttPinID < PORT_COUNT)
                                    ? gPorts[p->vttPinID].strName : "?";
            vtt.AddLog("[${spec.device_name}] VPort %s(%d): size=%d data=[%s]\\n",
                       portLabel, p->vttPinID, p->nSize, hexBuf);
            deviceRecordLog("VPORT_RX", portLabel, p->nSize, hexBuf);
        }
${isUart ? (hasFrameProtocol ? `        /* UART Frame Protocol: Accumulate VPort bytes, detect frame boundaries, verify checksum */
        {
            static const BYTE frame_hdr[] = {${frameHeader.match(/.{2}/g)?.map((b: string) => `0x${b}`).join(", ") || ""}};
            int hdrLen = sizeof(frame_hdr);
${frameTail ? `            static const BYTE frame_tail[] = {${frameTail.match(/.{2}/g)?.map((b: string) => `0x${b}`).join(", ") || ""}};
            int tailLen = sizeof(frame_tail);` : `            int tailLen = 0;`}
            for (int i = 0; i < p->nSize; i++) {
                BYTE b = p->pByte[i];
                /* Look for frame header */
                if (g_rx_frame.pos < hdrLen) {
                    if (b == frame_hdr[g_rx_frame.pos]) {
                        g_rx_frame.buffer[g_rx_frame.pos++] = b;
                    } else {
                        frame_rx_reset(); /* restart header detection */
                        if (b == frame_hdr[0]) {
                            g_rx_frame.buffer[g_rx_frame.pos++] = b;
                        }
                    }
                    continue;
                }
${lengthField !== "none" ? `                /* Read length field */
                if (g_rx_frame.expected_len < 0) {
                    g_rx_frame.buffer[g_rx_frame.pos++] = b;
                    int csLen = (strcmp("${checksumType}", "crc16_modbus") == 0 || strcmp("${checksumType}", "crc16_ccitt") == 0) ? 2 : (strcmp("${checksumType}", "none") == 0 ? 0 : 1);
                    g_rx_frame.expected_len = hdrLen + 1 + (int)b + csLen${frameTail ? " + tailLen" : ""};
                    if (g_rx_frame.expected_len > MAX_FRAME_SIZE) {
                        vtt.AddLog("[${spec.device_name}] Frame too large (%d), resetting\\n", g_rx_frame.expected_len);
                        frame_rx_reset();
                    }
                    continue;
                }` : ""}
                /* Accumulate data bytes */
                if (g_rx_frame.pos < MAX_FRAME_SIZE) {
                    g_rx_frame.buffer[g_rx_frame.pos++] = b;
                }
${frameTail ? `                /* Check for frame tail */
                if (g_rx_frame.pos >= hdrLen + 2 + tailLen) {
                    int match = 1;
                    for (int t = 0; t < tailLen; t++) {
                        if (g_rx_frame.buffer[g_rx_frame.pos - tailLen + t] != frame_tail[t]) { match = 0; break; }
                    }
                    if (match) g_rx_frame.frame_complete = 1;
                }` : ""}
${lengthField !== "none" ? `                /* Check if we reached expected length */
                if (g_rx_frame.expected_len > 0 && g_rx_frame.pos >= g_rx_frame.expected_len) {
                    g_rx_frame.frame_complete = 1;
                }` : ""}
                if (g_rx_frame.frame_complete) {
                    int frameLen = g_rx_frame.pos;
                    int csOk = frame_verify_checksum(frameLen);
                    if (csOk) { g_diag.checksum_ok++; } else { g_diag.checksum_fail++; }
                    char hexBuf[768] = {0};
                    int hexPos = 0;
                    for (int f = 0; f < frameLen && hexPos < 760; f++)
                        hexPos += sprintf(hexBuf + hexPos, "%02X ", g_rx_frame.buffer[f]);
                    vtt.AddLog("[${spec.device_name}] RX Frame (%d bytes, cs=%s): [%s]\\n",
                               frameLen, csOk ? "OK" : "FAIL", hexBuf);
                    deviceRecordLog("FRAME_RX", "uart", frameLen, hexBuf);
                    if (!csOk) {
                        vtt.AddLog("[DIAG:${spec.device_name}] CS_MISMATCH type=${checksumType} scope=${checksumScope} data_len=%d\\n", frameLen);
                    }
                    if (csOk) {
                        /* Push complete valid frame into FIFO for CPU to read */
                        for (int f = 0; f < frameLen; f++) {
                            if (!fifo_push(g_rx_frame.buffer[f])) {
                                vtt.AddLog("[${spec.device_name}] RX FIFO overflow at frame byte %d\\n", f);
                                break;
                            }
                        }
                    } else {
                        vtt.AddLog("[${spec.device_name}] Frame checksum FAILED, discarding %d bytes\\n", frameLen);
                        deviceRecordLog("FRAME_CS_FAIL", "uart", frameLen, hexBuf);
                    }
                    frame_rx_reset();
                }
            }
        }` : `        /* UART: Push received VPort data into RX FIFO (byte-level, no frame protocol) */
        for (int i = 0; i < p->nSize; i++) {
            if (!fifo_push(p->pByte[i])) {
                vtt.AddLog("[${spec.device_name}] RX FIFO overflow at byte %d\\n", i);
                break;
            }
        }`)
+ "\n" + (statusReg ? `        /* Update status register: set RX_READY */
        if (g_rx_fifo.count > 0) {
            BYTE st = g_state.m_${spec.registers.find((r) => r.role === "status")!.name};
            st |= UART_STATUS_RX_READY;
            g_state.m_${spec.registers.find((r) => r.role === "status")!.name} = st;
            vtt.WriteByte(${statusReg}, 2, st);
        }` : "")
+ (intPinId ? `
        /* Trigger interrupt: pull INT pin low to notify CPU of received data */
        if (g_rx_fifo.count > 0) {
            vtt.PinConnect(${intPinId}, 0);  /* low level triggers external interrupt */
        }` : "") : `        /* TODO: Process incoming VPort data based on p->vttPinID */`}
        break;
    }

    case VTT_PINCONNECT:
    {
        if (!g_state.initialized) break;
        vttParamPinConnect *p = (vttParamPinConnect *)dwParam;
        {
            const char* pinLabel = (p->nPinID >= 0 && p->nPinID < PORT_COUNT)
                                   ? gPorts[p->nPinID].strName : "?";
            /* Pin changes are frequent — only log to record file, not to AddLog */
            char valBuf[32];
            sprintf(valBuf, "0x%08X", p->dwValue);
            deviceRecordLog("PIN_RX", pinLabel, 4, valBuf);
        }
        break;
    }

    case VTT_MEMREAD:
    {
        if (!g_state.initialized) break;
        vttParamMemoryEvent *pe = (vttParamMemoryEvent *)dwParam;
        g_diag.memread_count++;
        g_diag.last_activity_time = vtt.GetRunTime();
        if (g_diag.first_memread_time == 0.0 && g_diag.memread_count == 1)
            g_diag.first_memread_time = vtt.GetRunTime();
${isUart ? `        DWORD addr = pe->dwAddress;
${rxDataReg ? `        if (addr == ${rxDataReg}) {
            /* RX data register: CPU reads received byte from FIFO */
            BYTE rxByte = 0;
            if (fifo_pop(&rxByte)) {
                vtt.WriteByte(addr, 2, rxByte);
${statusReg || intPinId ? `                if (g_rx_fifo.count == 0) {` : ""}${statusReg ? `
                    /* Update status: clear RX_READY if FIFO empty */
                    BYTE st = g_state.m_${spec.registers.find((r) => r.role === "status")!.name};
                    st &= ~UART_STATUS_RX_READY;
                    g_state.m_${spec.registers.find((r) => r.role === "status")!.name} = st;
                    vtt.WriteByte(${statusReg}, 2, st);` : ""}${intPinId ? `
                    /* Release interrupt: FIFO empty, restore INT pin high */
                    vtt.PinConnect(${intPinId}, 1);` : ""}${statusReg || intPinId ? `
                }` : ""}
            } else {
                vtt.WriteByte(addr, 2, 0);${intPinId ? `
                /* No data: ensure INT pin is high */
                vtt.PinConnect(${intPinId}, 1);` : ""}
            }
        }` : `        /* No rx_data register role defined — add role: "rx_data" to enable RX */`}
${statusReg ? `        ${rxDataReg ? "else " : ""}if (addr == ${statusReg}) {
            /* Status register: return current status byte */
            BYTE st = UART_STATUS_TX_EMPTY; /* TX always ready */
            if (g_rx_fifo.count > 0) st |= UART_STATUS_RX_READY;
            g_state.m_${spec.registers.find((r) => r.role === "status")!.name} = st;
            vtt.WriteByte(addr, 2, st);
        }` : ""}` : hasMemoryMappedRegisters(spec) ? `        DWORD addr = pe->dwAddress;
        /* Custom device MEMREAD: add register-specific read logic based on device behavior */
        /* For status registers: construct current status and WriteByte() back to memory */
        /* For data registers: WriteByte() the current value back so CPU reads it */
        {
            char logBuf[64];
            sprintf(logBuf, "ADDR=0x%04X", (unsigned)addr);
            deviceRecordLog("MEMREAD", "reg", 1, logBuf);
        }` : `        (void)pe;`}
        break;
    }

    case VTT_MEMWRITE:
    {
        if (!g_state.initialized) break;
        vttParamMemoryEvent *pe = (vttParamMemoryEvent *)dwParam;
        g_diag.memwrite_count++;
        g_diag.last_activity_time = vtt.GetRunTime();
        if (g_diag.first_memwrite_time == 0.0 && g_diag.memwrite_count == 1)
            g_diag.first_memwrite_time = vtt.GetRunTime();
${isUart ? `        DWORD addr = pe->dwAddress;
${txDataReg && txVPortId ? (hasFrameProtocol ? `        if (addr == ${txDataReg}) {
            /* TX data register: CPU wrote a byte — accumulate into TX frame buffer */
            BYTE txByte = vtt.ReadByte(addr, 2);
            if (g_tx_frame.pos < MAX_FRAME_SIZE) {
                g_tx_frame.buffer[g_tx_frame.pos++] = txByte;
            }
${frameTail ? `            /* Check for frame tail to detect complete TX frame */
            {
                static const BYTE tx_tail[] = {${frameTail.match(/.{2}/g)?.map((b: string) => `0x${b}`).join(", ") || ""}};
                int tx_tailLen = sizeof(tx_tail);
                if (g_tx_frame.pos >= tx_tailLen) {
                    int match = 1;
                    for (int t = 0; t < tx_tailLen; t++) {
                        if (g_tx_frame.buffer[g_tx_frame.pos - tx_tailLen + t] != tx_tail[t]) { match = 0; break; }
                    }
                    if (match) {
                        /* Complete TX frame detected — send via VPort */
                        vtt.WriteVPort(${txVPortId}, g_tx_frame.buffer, g_tx_frame.pos);
                        g_diag.vport_tx_count++; g_diag.vport_tx_bytes += g_tx_frame.pos;
                        char hexBuf[768] = {0};
                        int hexPos = 0;
                        for (int f = 0; f < g_tx_frame.pos && hexPos < 760; f++)
                            hexPos += sprintf(hexBuf + hexPos, "%02X ", g_tx_frame.buffer[f]);
                        vtt.AddLog("[${spec.device_name}] TX Frame (%d bytes): [%s]\\n", g_tx_frame.pos, hexBuf);
                        deviceRecordLog("FRAME_TX", "${txVPort!.name}", g_tx_frame.pos, hexBuf);
                        frame_tx_reset();
                    }
                }
            }` : `${lengthField !== "none" ? `            /* Check length field to detect complete TX frame */
            if (g_tx_frame.pos >= ${Math.floor(frameHeader.length / 2)} + 2) {
                int payloadLen = (int)g_tx_frame.buffer[${Math.floor(frameHeader.length / 2)}];
                int csLen = (strcmp("${checksumType}", "crc16_modbus") == 0 || strcmp("${checksumType}", "crc16_ccitt") == 0) ? 2 : (strcmp("${checksumType}", "none") == 0 ? 0 : 1);
                int expectedLen = ${Math.floor(frameHeader.length / 2)} + 1 + payloadLen + csLen;
                if (g_tx_frame.pos >= expectedLen) {
                    vtt.WriteVPort(${txVPortId}, g_tx_frame.buffer, g_tx_frame.pos);
                    g_diag.vport_tx_count++; g_diag.vport_tx_bytes += g_tx_frame.pos;
                    char hexBuf[768] = {0};
                    int hexPos = 0;
                    for (int f = 0; f < g_tx_frame.pos && hexPos < 760; f++)
                        hexPos += sprintf(hexBuf + hexPos, "%02X ", g_tx_frame.buffer[f]);
                    vtt.AddLog("[${spec.device_name}] TX Frame (%d bytes): [%s]\\n", g_tx_frame.pos, hexBuf);
                    deviceRecordLog("FRAME_TX", "${txVPort!.name}", g_tx_frame.pos, hexBuf);
                    frame_tx_reset();
                }
            }` : `            /* No frame tail or length field — send each byte immediately */
            vtt.WriteVPort(${txVPortId}, &txByte, 1);
            g_diag.vport_tx_count++; g_diag.vport_tx_bytes += 1;
            char hexBuf[8];
            sprintf(hexBuf, "%02X", txByte);
            deviceRecordLog("UART_TX", "${txVPort!.name}", 1, hexBuf);
            vtt.AddLog("[${spec.device_name}] TX: 0x%02X\\n", txByte);`}`}
        }` : `        if (addr == ${txDataReg}) {
            /* TX data register: CPU wrote a byte to transmit */
            BYTE txByte = vtt.ReadByte(addr, 2);
            vtt.WriteVPort(${txVPortId}, &txByte, 1);
            g_diag.vport_tx_count++; g_diag.vport_tx_bytes += 1;
            char hexBuf[8];
            sprintf(hexBuf, "%02X", txByte);
            deviceRecordLog("UART_TX", "${txVPort!.name}", 1, hexBuf);
            vtt.AddLog("[${spec.device_name}] TX: 0x%02X\\n", txByte);
        }`) : `        /* No tx_data register role defined — add role: "tx_data" to enable TX */`}
${controlReg ? `        ${txDataReg ? "else " : ""}if (addr == ${controlReg}) {
            g_state.m_${spec.registers.find((r) => r.role === "control")!.name} = vtt.ReadByte(addr, 2);
        }` : ""}
${baudReg ? `        ${txDataReg || controlReg ? "else " : ""}if (addr == ${baudReg}) {
            g_state.m_${spec.registers.find((r) => r.role === "baud_rate")!.name} = vtt.ReadByte(addr, 2);
        }` : ""}` : hasMemoryMappedRegisters(spec) ? `        DWORD addr = pe->dwAddress;
        BYTE val = vtt.ReadByte(addr, 2);
        /* Custom device MEMWRITE: add register-specific write logic based on device behavior */
        /* For control/start registers: trigger device operations (e.g., start ADC conversion) */
        /* For data buffer registers: store data for later transmission */
        {
            char logBuf[64];
            sprintf(logBuf, "ADDR=0x%04X VAL=0x%02X", (unsigned)addr, val);
            deviceRecordLog("MEMWRITE", "reg", 1, logBuf);
        }` : `        (void)pe;`}
        break;
    }

    case VTT_SAVE:
        return TRUE;

    case VTT_LOAD:
        return TRUE;

    default:
        break;
    }
    return (vttRES)FALSE;
}
`
}

/**
 * Generate the header file for a virtual device DLL.
 */
export function generateDeviceHeader(spec: VteDeviceSpec): string {
  const guardName = spec.device_name.toUpperCase().replace(/[^A-Z0-9]/g, "_")
  return `#ifndef ${guardName}_H
#define ${guardName}_H

#include "vttDevice.h"

#ifdef __cplusplus
extern "C" {
#endif

__declspec(dllexport) vttRES WINAPI MainProc(vttMESSAGE Msg, void *pData, DWORD dwParam);

#ifdef __cplusplus
}
#endif

#endif /* ${guardName}_H */
`
}

/**
 * Generate a .def module definition file for a device DLL.
 * VS2013 uses this to export MainProc.
 */
export function generateDeviceDef(deviceName: string): string {
  return `LIBRARY      "${deviceName}"
DESCRIPTION  'VTest Virtual Device DLL - ${deviceName}'

EXPORTS
    MainProc
`
}

/**
 * Generate stdafx.h for precompiled headers (required by MFC DLL projects).
 */
export function generateStdafxH(): string {
  return `#pragma once

#include "targetver.h"

#define VC_EXTRALEAN
#include <afxwin.h>
#include <afxext.h>
#ifndef _AFX_NO_AFXCMN_SUPPORT
#include <afxcmn.h>
#endif

#include "vttDevice.h"
`
}

/**
 * Generate stdafx.cpp with the global VTTFUNCS instance.
 */
export function generateStdafxCpp(): string {
  return `#include "stdafx.h"

// Global VTest API function pointers — MUST be declared exactly once per DLL.
struct VTTFUNCS vtt;
`
}

/**
 * Generate targetver.h for SDK version targeting.
 */
export function generateTargetverH(): string {
  return `#pragma once
#include <SDKDDKVer.h>
`
}

/**
 * Generate a Makefile entry for building a device DLL.
 */
export function generateDeviceMakefileEntry(deviceName: string, compiler: string): string {
  const dllName = `${deviceName}.dll`
  const srcName = `${deviceName}.cpp`

  if (compiler === "msvc") {
    return `
# Build ${dllName}
${dllName}: ${srcName} stdafx.cpp
\tcl /LD /EHsc /MD /I"$(VTEST_INCLUDE)" /D "WIN32" /D "_WINDOWS" /D "_USRDLL" /D "_AFXDLL" stdafx.cpp ${srcName} /Fe${dllName} /link /DEF:${deviceName}.def
`
  }
  return `
# Build ${dllName} (GCC fallback — may not support MFC)
${dllName}: ${srcName}
\tgcc -shared -o ${dllName} ${srcName} -I"$(VTEST_INCLUDE)" -DWIN32
`
}

/**
 * Generate a complete Makefile for all device DLLs.
 */
export function generateDeviceMakefile(
  deviceNames: string[],
  compiler: string,
  vtestIncludePath: string,
): string {
  const targets = deviceNames.map((n) => `${n}.dll`).join(" ")
  const entries = deviceNames
    .map((n) => generateDeviceMakefileEntry(n, compiler))
    .join("\n")

  return `# VTest Virtual Device DLL Build
# Generated by matrix-embedded-agent
#
# Recommended: Build with VS2013 solution (.sln) instead of Makefile.
# VTest DLLs require MFC (Dynamic), Win32, v120 toolset.
#
# Usage: make all VTEST_INCLUDE=${vtestIncludePath}

VTEST_INCLUDE ?= ${vtestIncludePath}

all: ${targets}
${entries}
clean:
\t${compiler === "msvc" ? "del" : "rm -f"} ${targets}

.PHONY: all clean
`
}

/**
 * Generate a .vcxproj for a single device DLL.
 */
export function generateDeviceVcxproj(
  spec: VteDeviceSpec,
  vtestIncludePath: string,
): string {
  return generateVcxproj({
    projectName: spec.device_name,
    sourceFiles: [`${spec.device_name}.cpp`, "stdafx.cpp"],
    headerFiles: [`${spec.device_name}.h`, "stdafx.h", "targetver.h"],
    vtestIncludePath,
    projectGuid: deterministicGuid(`device-${spec.device_name}`),
    defFile: `${spec.device_name}.def`,
  })
}

/**
 * Generate a .vcxproj.filters for a single device DLL.
 */
export function generateDeviceVcxprojFilters(spec: VteDeviceSpec): string {
  return generateVcxprojFilters({
    sourceFiles: [`${spec.device_name}.cpp`, "stdafx.cpp"],
    headerFiles: [`${spec.device_name}.h`, "stdafx.h", "targetver.h"],
  })
}

/**
 * Generate a .sln containing all device DLL projects and optional extra projects (e.g., test drivers).
 */
export function generateAllDevicesSln(
  deviceNames: string[],
  simModelsRelPath: string = "sim-models",
  extraProjects: SlnProject[] = [],
): string {
  const projects: SlnProject[] = deviceNames.map((name) => ({
    name,
    guid: deterministicGuid(`device-${name}`),
    vcxprojRelPath: `${simModelsRelPath}\\${name}.vcxproj`,
  }))
  projects.push(...extraProjects)
  return generateSln(projects, "vtest-devices")
}
