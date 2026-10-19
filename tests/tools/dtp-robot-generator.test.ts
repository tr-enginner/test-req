import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  createDtpRobotGenerator,
  generateDtpRobotScripts,
  parseInputDatasetRef,
  resolvePreferredInputFile,
} from "../../src/tools/dtp-robot-generator"

describe("dtp robot generator workspace boundary", () => {
  test("rejects DTP paths outside the current OpenCode workspace", async () => {
    const parent = mkdtempSync(join(tmpdir(), "dtp-robot-boundary-"))
    const workspace = join(parent, "active-project")
    const otherProject = join(parent, "other-project")
    mkdirSync(workspace, { recursive: true })
    mkdirSync(otherProject, { recursive: true })

    const tool = createDtpRobotGenerator()
    const output = JSON.parse(await (tool as any).execute(
      { dtp_root: otherProject },
      { directory: workspace },
    ))

    expect(output.status).toBe("error")
    expect(output.error).toContain("dtp_root must stay inside the current OpenCode workspace")
  })
})

describe("dtp robot generator input dataset preference", () => {
  test("parses test_input dataset ref and resolves a robot-relative path", () => {
    const dir = mkdtempSync(join(tmpdir(), "dtp-input-ref-"))
    const datasetFile = join(dir, ".matrix", "data", "input-datasets", "间接指令.json")
    const outputDir = join(dir, "DTPProject", "V1", "测试用例")
    mkdirSync(join(dir, ".matrix", "data", "input-datasets"), { recursive: true })
    mkdirSync(outputDir, { recursive: true })
    writeFileSync(datasetFile, "{}", "utf-8")

    const relativeRef = ".matrix/data/input-datasets/间接指令.json#normal-01"
    expect(parseInputDatasetRef(relativeRef)).toEqual({
      filePath: ".matrix/data/input-datasets/间接指令.json",
      datasetId: "normal-01",
    })

    const absoluteRef = `${datasetFile}#normal-01`

    const resolved = resolvePreferredInputFile(absoluteRef, {
      files: [],
      projectDir: join(dir, "DTPProject", "V1"),
      outputDir,
      commonCanInputRootRelative: null,
    } as any)

    expect(resolved).toContain(".matrix\\\\data\\\\input-datasets\\\\间接指令.json")
  })
})

describe("dtp robot generator path rendering", () => {
  test("removes dollar signs from unresolved placeholders in rendered Robot steps", () => {
    const dir = mkdtempSync(join(tmpdir(), "dtp-robot-placeholder-"))
    const dataDir = join(dir, ".matrix", "data")
    const dtpRoot = join(dataDir, "DTPProject")
    const runtimeDir = join(dtpRoot, "V1")
    const keywordDir = join(dtpRoot, "\u7ec4\u5408\u5173\u952e\u5b57")
    const generatedTestDataFile = join(dataDir, "generated-test-data.json")

    mkdirSync(keywordDir, { recursive: true })
    mkdirSync(runtimeDir, { recursive: true })
    writeFileSync(join(keywordDir, "Demo.txt"), "", "utf-8")
    writeFileSync(
      join(keywordDir, "Demo.json"),
      JSON.stringify({
        Items: [
          { Name: "\u542f\u52a8VTEST", Arguments: [{ Name: "${vte}" }] },
          { Name: "\u6d4b\u8bd5\u7ed3\u675f", Arguments: [{ Name: "${time}" }] },
          { Name: "执行参数化操作", Arguments: [{ Name: "${para1}" }] },
        ],
      }),
      "utf-8",
    )
    writeFileSync(
      generatedTestDataFile,
      JSON.stringify({
        schema_version: "1.1.0",
        cases: [
          {
            case_id: "TC-PLACEHOLDER-001",
            translate_status: "success",
            correspond_fun_id: "TR-JK-001、TR-JK-002",
            requirement_ids: ["TR-JK-001", "TR-JK-002"],
            selected_requirement_id: "TR-JK-001",
            generated_steps: [
              {
                step_index: 1,
                keyword_name: "执行参数化操作",
                step_description: "执行${para1}操作",
                resolved_arguments: [
                  { name: "${para1}", value: "${para1}" },
                ],
              },
            ],
          },
        ],
      }),
      "utf-8",
    )

    generateDtpRobotScripts({ dtpRoot, generatedTestDataFile })

    const robotFile = join(runtimeDir, "\u6d4b\u8bd5\u7528\u4f8b", "TC-PLACEHOLDER-001.robot")
    const robotText = readFileSync(robotFile, "utf-8")

    expect(robotText).toContain("{para1}")
    expect(robotText).not.toContain("${para1}")
  })

  test("renders Resource and VTEST paths relative to the DTP project root", () => {
    const dir = mkdtempSync(join(tmpdir(), "dtp-robot-paths-"))
    const dataDir = join(dir, ".matrix", "data")
    const dtpRoot = join(dataDir, "DTPProject")
    const runtimeDir = join(dtpRoot, "V1")
    const keywordDir = join(dtpRoot, "\u7ec4\u5408\u5173\u952e\u5b57")
    const vteDir = join(runtimeDir, "pindemo")
    const generatedTestDataFile = join(dataDir, "generated-test-data.json")

    mkdirSync(keywordDir, { recursive: true })
    mkdirSync(runtimeDir, { recursive: true })
    mkdirSync(vteDir, { recursive: true })
    writeFileSync(join(keywordDir, "VTest.txt"), "", "utf-8")
    writeFileSync(
      join(keywordDir, "VTest.json"),
      JSON.stringify({
        Items: [
          { Name: "\u542f\u52a8VTEST", Arguments: [{ Name: "${vte}" }] },
          { Name: "\u6d4b\u8bd5\u7ed3\u675f", Arguments: [{ Name: "${time}" }] },
          { Name: "\u63cf\u8ff0", Arguments: [{ Name: "${message}" }] },
        ],
      }),
      "utf-8",
    )
    writeFileSync(join(vteDir, "pindemo.vte"), "", "utf-8")
    writeFileSync(
      generatedTestDataFile,
      JSON.stringify({
        schema_version: "1.0.0",
        cases: [{ case_id: "TC-001", translate_status: "success", generated_steps: [] }],
      }),
      "utf-8",
    )

    generateDtpRobotScripts({ dtpRoot, generatedTestDataFile })

    const robotFile = join(runtimeDir, "\u6d4b\u8bd5\u7528\u4f8b", "TC-001.robot")
    const robotText = readFileSync(robotFile, "utf-8")

    expect(robotText).toContain("Resource    \u7ec4\u5408\u5173\u952e\u5b57\\\\VTest.txt")
    expect(robotText).toContain("Test Setup        \u542f\u52a8VTEST    pindemo\\\\pindemo.vte")
    expect(robotText).toContain("    [Setup]        \u542f\u52a8VTEST    pindemo\\\\pindemo.vte")
    expect(robotText).not.toContain("V1\\\\pindemo")
    expect(robotText).not.toContain("..\\\\")
  })

  test("does not render hardware or non-success cases and removes stale Robot files", () => {
    const dir = mkdtempSync(join(tmpdir(), "dtp-robot-status-"))
    const dataDir = join(dir, ".matrix", "data")
    const dtpRoot = join(dataDir, "DTPProject")
    const runtimeDir = join(dtpRoot, "V1")
    const keywordDir = join(dtpRoot, "\u7ec4\u5408\u5173\u952e\u5b57")
    const generatedTestDataFile = join(dataDir, "generated-test-data.json")
    const robotFile = join(runtimeDir, "\u6d4b\u8bd5\u7528\u4f8b", "TC-STATUS-001.robot")

    mkdirSync(keywordDir, { recursive: true })
    mkdirSync(runtimeDir, { recursive: true })
    writeFileSync(join(keywordDir, "VTest.txt"), "", "utf-8")
    writeFileSync(
      join(keywordDir, "VTest.json"),
      JSON.stringify({
        Items: [
          { Name: "\u542f\u52a8VTEST", Arguments: [{ Name: "${vte}" }] },
          { Name: "\u6d4b\u8bd5\u7ed3\u675f", Arguments: [{ Name: "${time}" }] },
          { Name: "\u63cf\u8ff0", Arguments: [{ Name: "${message}" }] },
        ],
      }),
      "utf-8",
    )
    writeFileSync(
      generatedTestDataFile,
      JSON.stringify({
        schema_version: "1.0.0",
        cases: [{ case_id: "TC-STATUS-001", translate_status: "success", generated_steps: [] }],
      }),
      "utf-8",
    )

    generateDtpRobotScripts({ dtpRoot, generatedTestDataFile })
    expect(existsSync(robotFile)).toBe(true)

    writeFileSync(
      generatedTestDataFile,
      JSON.stringify({
        schema_version: "1.0.0",
        cases: [
          {
            case_id: "TC-STATUS-001",
            translate_status: "success",
            test_environment: "硬平台测试环境",
            generated_steps: [],
          },
          { case_id: "TC-STATUS-FAILED", translate_status: "failed", generated_steps: [] },
        ],
      }),
      "utf-8",
    )

    expect(() => generateDtpRobotScripts({ dtpRoot, generatedTestDataFile })).toThrow(
      "No renderable cases found",
    )
    expect(existsSync(robotFile)).toBe(false)

    const result = JSON.parse(readFileSync(join(dataDir, "robot-generation-result.json"), "utf-8"))
    expect(result.cases).toEqual([])
    expect(result.warnings).toContain("Case TC-STATUS-001 skipped because test_environment is 硬平台测试环境.")
    expect(result.warnings).toContain("Case TC-STATUS-FAILED skipped because translate_status is not success.")
  })
})
