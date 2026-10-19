import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "fs"
import { join } from "path"
import * as jsonc from "jsonc-parser/lib/esm/main.js"
import { VteDeviceSpec } from "../schema/vtest"
import {
  generateDeviceSource,
  generateDeviceHeader,
  generateDeviceDef,
  generateStdafxH,
  generateStdafxCpp,
  generateTargetverH,
  generateDeviceMakefile,
  generateDeviceVcxproj,
  generateDeviceVcxprojFilters,
  generateAllDevicesSln,
} from "./vtest/device-templates"
import { TEST_ENV_DIR } from "../shared/constants"

/**
 * vtest_device_generate — Generate virtual device DLL C source code.
 * Used by: EnvArchitect agent (Phase 5)
 */
export const vtestDeviceGenerator: ToolDefinition = tool({
  description:
    "Generate C source code for a VTest virtual peripheral device DLL. " +
    "Creates a complete MainProc framework with message handling, port declarations, " +
    "and protocol-specific stubs based on the vttDevice.h API. " +
    "Output: .matrix/test-env/sim-models/<device_name>.cpp and .h files.",
  args: {
    device_name: tool.schema
      .string()
      .describe("Device name (used as filename, e.g., 'sim-1553b', 'sim-uart')"),
    device_type: tool.schema
      .enum(["uart", "can", "1553b", "rs422", "gpio", "adc", "timer", "spi", "i2c", "custom"])
      .describe("Device type — determines protocol template"),
    ports: tool.schema
      .array(
        tool.schema.object({
          name: tool.schema.string().describe("Port name (e.g., 'uart_data', 'PIN_INT')"),
          type: tool.schema.enum(["pin", "vport"]).describe("Port type"),
          direction: tool.schema
            .enum(["input", "output", "bidirectional"])
            .default("bidirectional"),
        }),
      )
      .describe("Port definitions for device I/O"),
    registers: tool.schema
      .array(
        tool.schema.object({
          name: tool.schema.string(),
          address: tool.schema.string().describe("Hex address (e.g., '0x4000')"),
          width: tool.schema.enum(["8", "16", "32"]).default("8"),
          access: tool.schema.enum(["read", "write", "readwrite"]).default("readwrite"),
          description: tool.schema.string().optional(),
        }),
      )
      .optional()
      .describe("Memory-mapped registers"),
    protocol_params: tool.schema
      .record(tool.schema.string(), tool.schema.string())
      .optional()
      .describe("Protocol-specific parameters (e.g., baud_rate, rt_address)"),
    behavior_description: tool.schema
      .string()
      .describe("Natural language description of device behavior for code generation"),
    vtest_include_path: tool.schema
      .string()
      .optional()
      .describe("Path to VTest include directory (for Makefile generation)"),
    compiler: tool.schema
      .enum(["gcc", "msvc", "mingw"])
      .default("msvc")
      .describe("Compiler for Makefile generation (msvc recommended — VTest DLLs require MFC)"),
  },
  async execute({
    device_name,
    device_type,
    ports,
    registers,
    protocol_params,
    behavior_description,
    vtest_include_path,
    compiler,
  }) {
    const spec: VteDeviceSpec = {
      device_name,
      device_type,
      ports: ports.map((p) => ({
        name: p.name,
        type: p.type,
        direction: p.direction ?? "bidirectional",
      })),
      registers: (registers ?? []).map((r) => ({
        name: r.name,
        address: r.address,
        width: r.width ?? "8",
        access: r.access ?? "readwrite",
        description: r.description,
      })),
      protocol_params: protocol_params ?? {},
      behavior_description,
    }

    const parsed = VteDeviceSpec.safeParse(spec)
    if (!parsed.success) {
      return JSON.stringify({
        error: "Device spec validation failed",
        details: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      })
    }

    const source = generateDeviceSource(parsed.data)
    const header = generateDeviceHeader(parsed.data)

    const simModelsDir = join(process.cwd(), TEST_ENV_DIR, "sim-models")
    if (!existsSync(simModelsDir)) mkdirSync(simModelsDir, { recursive: true })

    const srcPath = join(simModelsDir, `${device_name}.cpp`)
    const hdrPath = join(simModelsDir, `${device_name}.h`)
    writeFileSync(srcPath, source, "utf-8")
    writeFileSync(hdrPath, header, "utf-8")

    // Generate .def file for DLL exports
    const defPath = join(simModelsDir, `${device_name}.def`)
    writeFileSync(defPath, generateDeviceDef(device_name), "utf-8")

    // Generate shared MFC support files (stdafx.h, stdafx.cpp, targetver.h)
    const stdafxHPath = join(simModelsDir, "stdafx.h")
    const stdafxCppPath = join(simModelsDir, "stdafx.cpp")
    const targetverPath = join(simModelsDir, "targetver.h")
    if (!existsSync(stdafxHPath)) writeFileSync(stdafxHPath, generateStdafxH(), "utf-8")
    if (!existsSync(stdafxCppPath)) writeFileSync(stdafxCppPath, generateStdafxCpp(), "utf-8")
    if (!existsSync(targetverPath)) writeFileSync(targetverPath, generateTargetverH(), "utf-8")

    const makefilePath = join(simModelsDir, "Makefile")

    // Resolve VTest include path: explicit arg > config vtest_home > env VTEST_HOME > fallback
    let includePath = vtest_include_path
    if (!includePath) {
      try {
        const configPath = join(process.cwd(), ".matrix/config/matrix.jsonc")
        if (existsSync(configPath)) {
          const cfg = jsonc.parse(readFileSync(configPath, "utf-8")) ?? {}
          if (cfg.vtest_home) {
            includePath = join(cfg.vtest_home, "include")
          }
        }
      } catch { /* ignore */ }
    }
    if (!includePath && process.env.VTEST_HOME) {
      includePath = join(process.env.VTEST_HOME, "include")
    }
    if (!includePath) {
      includePath = "$(VTEST_HOME)\\include"
    }

    const deviceNames = [device_name]
    try {
      const files = readdirSync(simModelsDir)
      for (const f of files) {
        if (f.endsWith(".cpp") && f !== `${device_name}.cpp` && f !== "stdafx.cpp") {
          deviceNames.push(f.replace(".cpp", ""))
        }
      }
    } catch { /* ignore */ }

    const makefile = generateDeviceMakefile(deviceNames, compiler ?? "msvc", includePath)
    writeFileSync(makefilePath, makefile, "utf-8")

    // Generate VS2013 vcxproj files
    const vcxprojContent = generateDeviceVcxproj(parsed.data, includePath)
    const vcxprojFiltersContent = generateDeviceVcxprojFilters(parsed.data)
    const vcxprojPath = join(simModelsDir, `${device_name}.vcxproj`)
    const vcxprojFiltersPath = join(simModelsDir, `${device_name}.vcxproj.filters`)
    writeFileSync(vcxprojPath, vcxprojContent, "utf-8")
    writeFileSync(vcxprojFiltersPath, vcxprojFiltersContent, "utf-8")

    // Generate .sln containing all device projects
    const testEnvDir = join(process.cwd(), TEST_ENV_DIR)
    const slnContent = generateAllDevicesSln(deviceNames)
    const slnPath = join(testEnvDir, "vtest-devices.sln")
    writeFileSync(slnPath, slnContent, "utf-8")

    return JSON.stringify({
      status: "success",
      files: {
        source: `${TEST_ENV_DIR}/sim-models/${device_name}.cpp`,
        header: `${TEST_ENV_DIR}/sim-models/${device_name}.h`,
        makefile: `${TEST_ENV_DIR}/sim-models/Makefile`,
        vcxproj: `${TEST_ENV_DIR}/sim-models/${device_name}.vcxproj`,
        vcxproj_filters: `${TEST_ENV_DIR}/sim-models/${device_name}.vcxproj.filters`,
        solution: `${TEST_ENV_DIR}/vtest-devices.sln`,
      },
      device_type,
      port_count: ports.length,
      register_count: (registers ?? []).length,
      message:
        `Generated VTest device DLL source for "${device_name}" (${device_type}). ` +
        `Build: use MSBuild command line to compile .matrix/test-env/vtest-devices.sln (v120 toolset, MFC Dynamic, Win32). ` +
        `Example: MSBuild.exe vtest-devices.sln /p:Configuration=Debug /p:Platform=Win32 /m. ` +
        `Do NOT open VS2013 IDE. DLLs require MFC — GCC/MinGW cannot compile them.`,
    })
  },
})
