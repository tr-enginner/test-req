import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "fs"
import { join } from "path"
import * as jsonc from "jsonc-parser/lib/esm/main.js"
import {
  generateBaselineScript,
  generateTestDriverSource,
  generateTestDriverHeader,
  generateTestDriverDef,
  generateTestDriverVcxproj,
  generateTestDriverVcxprojFilters,
  generateTestDriverManual,
} from "./vtest/script-templates"
import {
  generateStdafxH,
  generateStdafxCpp,
  generateTargetverH,
  generateAllDevicesSln,
} from "./vtest/device-templates"
import { deterministicGuid } from "./vtest/vcxproj-templates"
import { TEST_ENV_DIR } from "../shared/constants"
import type { BaselineTestItem } from "../schema/vtest"

/**
 * vtest_script_generate — Generate baseline verification test scripts for VTest.
 * Used by: EnvArchitect agent (Phase 5)
 */
export const vtestScriptGenerator: ToolDefinition = tool({
  description:
    "Generate VTest baseline verification test scripts and test driver DLL source. " +
    "Scripts verify simulation environment correctness (connectivity, loopback, timing). " +
    "Output: .matrix/test-env/stimuli/baseline_test.txt and .matrix/test-env/drivers/ DLL source.",
  args: {
    project_name: tool.schema.string().describe("Project name"),
    test_items: tool.schema
      .array(
        tool.schema.object({
          name: tool.schema.string().describe("Test name (e.g., 'UART Connectivity')"),
          type: tool.schema
            .enum(["connectivity", "loopback", "timing", "boundary", "fault_injection"])
            .describe("Verification type"),
          interface_name: tool.schema.string().describe("Interface being tested"),
          stimulus: tool.schema
            .string()
            .describe("Stimulus command in VTest script format. Command name MUST be a valid C identifier (letters, digits, underscores only, no Chinese). Example: 'send_uart,data=A1 A2', 'set_adc_input,ch0=2048|ch1=1024'"),
          expected_response: tool.schema.string().describe("Expected response description"),
          time_offset_s: tool.schema.number().describe("Simulation time in seconds"),
        }),
      )
      .describe("Baseline test items"),
    driver_name: tool.schema
      .string()
      .default("test-driver")
      .describe("Name for the test driver DLL (default: 'test-driver')"),
    driver_ports: tool.schema
      .array(tool.schema.string())
      .describe("Port names for the test driver DLL (must match VPort connections)"),
    result_file_path: tool.schema
      .string()
      .default(".matrix/test-env/baseline-results.json")
      .describe("Path where driver DLL writes test results JSON"),
  },
  async execute({ project_name, test_items, driver_name, driver_ports, result_file_path }) {
    const items: BaselineTestItem[] = test_items.map((t) => ({
      name: t.name,
      type: t.type,
      interface_name: t.interface_name,
      stimulus: t.stimulus,
      expected_response: t.expected_response,
      time_offset_s: t.time_offset_s,
    }))

    const actualDriverName = driver_name ?? "test-driver"
    const actualResultPath = result_file_path ?? ".matrix/test-env/baseline-results.json"

    const script = generateBaselineScript(items, project_name)
    const driverSource = generateTestDriverSource(actualDriverName, driver_ports, actualResultPath)
    const driverHeader = generateTestDriverHeader(actualDriverName)

    const stimuliDir = join(process.cwd(), TEST_ENV_DIR, "stimuli")
    const driversDir = join(process.cwd(), TEST_ENV_DIR, "drivers")
    if (!existsSync(stimuliDir)) mkdirSync(stimuliDir, { recursive: true })
    if (!existsSync(driversDir)) mkdirSync(driversDir, { recursive: true })

    // Generate test driver manual
    const manual = generateTestDriverManual(
      actualDriverName,
      driver_ports,
      items,
      project_name,
      actualResultPath,
    )

    writeFileSync(join(stimuliDir, "baseline_test.txt"), script, "utf-8")
    writeFileSync(join(driversDir, `${actualDriverName}.cpp`), driverSource, "utf-8")
    writeFileSync(join(driversDir, `${actualDriverName}.h`), driverHeader, "utf-8")
    writeFileSync(join(driversDir, `${actualDriverName}-manual.md`), manual, "utf-8")

    // Generate .def file for DLL exports
    const defContent = generateTestDriverDef(actualDriverName)
    writeFileSync(join(driversDir, `${actualDriverName}.def`), defContent, "utf-8")

    // Generate shared MFC support files (stdafx.h, stdafx.cpp, targetver.h)
    const stdafxHPath = join(driversDir, "stdafx.h")
    const stdafxCppPath = join(driversDir, "stdafx.cpp")
    const targetverPath = join(driversDir, "targetver.h")
    if (!existsSync(stdafxHPath)) writeFileSync(stdafxHPath, generateStdafxH(), "utf-8")
    if (!existsSync(stdafxCppPath)) writeFileSync(stdafxCppPath, generateStdafxCpp(), "utf-8")
    if (!existsSync(targetverPath)) writeFileSync(targetverPath, generateTargetverH(), "utf-8")

    // Resolve VTest include path: config vtest_home > env VTEST_HOME > fallback
    let vtestIncludePath: string | undefined
    try {
      const configPath = join(process.cwd(), ".matrix/config/matrix.jsonc")
      if (existsSync(configPath)) {
        const cfg = jsonc.parse(readFileSync(configPath, "utf-8")) ?? {}
        if (cfg.vtest_home) {
          vtestIncludePath = join(cfg.vtest_home, "include")
        }
      }
    } catch { /* ignore */ }
    if (!vtestIncludePath && process.env.VTEST_HOME) {
      vtestIncludePath = join(process.env.VTEST_HOME, "include")
    }
    if (!vtestIncludePath) {
      vtestIncludePath = "$(VTEST_HOME)\\include"
    }

    // Generate VS2013 vcxproj files for the test driver
    const vcxprojContent = generateTestDriverVcxproj(actualDriverName, vtestIncludePath)
    const vcxprojFiltersContent = generateTestDriverVcxprojFilters(actualDriverName)
    writeFileSync(join(driversDir, `${actualDriverName}.vcxproj`), vcxprojContent, "utf-8")
    writeFileSync(join(driversDir, `${actualDriverName}.vcxproj.filters`), vcxprojFiltersContent, "utf-8")

    // Add test driver project to the solution (.sln)
    const testEnvDir = join(process.cwd(), TEST_ENV_DIR)
    const simModelsDir = join(testEnvDir, "sim-models")
    const deviceNames: string[] = []
    try {
      const files = readdirSync(simModelsDir)
      for (const f of files) {
        if (f.endsWith(".cpp") && f !== "stdafx.cpp") {
          deviceNames.push(f.replace(".cpp", ""))
        }
      }
    } catch { /* sim-models may not exist yet */ }

    const driverProject = {
      name: actualDriverName,
      guid: deterministicGuid(`driver-${actualDriverName}`),
      vcxprojRelPath: `drivers\\${actualDriverName}.vcxproj`,
    }
    const slnContent = generateAllDevicesSln(deviceNames, "sim-models", [driverProject])
    const slnPath = join(testEnvDir, "vtest-devices.sln")
    writeFileSync(slnPath, slnContent, "utf-8")

    return JSON.stringify({
      status: "success",
      files: {
        script: `${TEST_ENV_DIR}/stimuli/baseline_test.txt`,
        driver_source: `${TEST_ENV_DIR}/drivers/${actualDriverName}.cpp`,
        driver_header: `${TEST_ENV_DIR}/drivers/${actualDriverName}.h`,
        driver_def: `${TEST_ENV_DIR}/drivers/${actualDriverName}.def`,
        driver_manual: `${TEST_ENV_DIR}/drivers/${actualDriverName}-manual.md`,
        driver_vcxproj: `${TEST_ENV_DIR}/drivers/${actualDriverName}.vcxproj`,
        driver_vcxproj_filters: `${TEST_ENV_DIR}/drivers/${actualDriverName}.vcxproj.filters`,
        solution: `${TEST_ENV_DIR}/vtest-devices.sln`,
      },
      test_count: items.length,
      test_types: [...new Set(items.map((i) => i.type))],
      message:
        `Generated ${items.length} baseline verification tests, test driver DLL source, and driver manual. ` +
        `Manual: ${TEST_ENV_DIR}/drivers/${actualDriverName}-manual.md — documents all test commands, parameters, and sample script. ` +
        `Build: use MSBuild command line to compile (v120 toolset, MFC Dynamic, Win32). ` +
        `Example: MSBuild.exe vtest-devices.sln /p:Configuration=Debug /p:Platform=Win32 /m. ` +
        `Do NOT open VS2013 IDE. DLLs require MFC — GCC/MinGW cannot compile them.`,
    })
  },
})
