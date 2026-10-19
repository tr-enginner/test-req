import { describe, expect, test } from "bun:test"
import { createHash } from "crypto"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { dirname, join } from "path"
import {
  resolveKeywordSearchDirs,
  testcaseFormatCheck,
  testcaseGeneratorRun,
} from "../../src/tools/testcase-generator-runner"
import { ctSuiteCreate } from "../../src/tools/ct-suite-builder"
import { writeZip } from "../../src/tools/docx-zip"
import { PHASE6_SOFTWARE_TEMPLATE_FILES } from "../../src/shared/phase6-prompt-templates"
import { phase6CaseReviewPrepare } from "../../src/tools/phase6-case-review-prepare"

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2), "utf-8")
}

function readGenerationManifest(result: { generation_manifest_file: string }) {
  return JSON.parse(readFileSync(result.generation_manifest_file, "utf-8"))
}

function writeThirdPartyRequirementDocx(path: string, inputFlow = "间接指令。") {
  mkdirSync(dirname(path), { recursive: true })
  const zipBuffer = writeZip([
    {
      path: "[Content_Types].xml",
      data: Buffer.from(
        [
          "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
          "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">",
          "<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>",
          "<Default Extension=\"xml\" ContentType=\"application/xml\"/>",
          "<Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/>",
          "</Types>",
        ].join(""),
      ),
    },
    {
      path: "_rels/.rels",
      data: Buffer.from(
        [
          "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
          "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">",
          "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/>",
          "</Relationships>",
        ].join(""),
      ),
    },
    {
      path: "word/document.xml",
      data: Buffer.from(
        [
          "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
          "<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">",
          "<w:body>",
          `<w:p><w:r><w:t>输入流：${inputFlow}</w:t></w:r></w:p>`,
          "<w:p><w:r><w:t>字段A：默认值为0x01，取值范围：0x01-0x05</w:t></w:r></w:p>",
          "<w:p><w:r><w:t>表3.1.1.7-2 间接数据指令说明</w:t></w:r></w:p>",
          "<w:tbl>",
          "<w:tr><w:tc><w:p><w:r><w:t>序号</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>指令名称</w:t></w:r></w:p></w:tc></w:tr>",
          "<w:tr><w:tc><w:p><w:r><w:t>1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>中继测控子系统与中继星1通信</w:t></w:r></w:p></w:tc></w:tr>",
          "</w:tbl>",
          "<w:sectPr/>",
          "</w:body>",
          "</w:document>",
        ].join(""),
      ),
    },
  ])
  writeFileSync(path, zipBuffer)
}

function makeCtx(directory: string) {
  return {
    sessionID: "sid-1",
    messageID: "mid-1",
    agent: "test-designer",
    directory,
    worktree: directory,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  }
}

function makeTestRequirementsArtifact() {
  return {
    funItem: [
      {
        funId: ["TR-GN-JJZL-001"],
        testType: "功能测试",
        titleNo: "4.1.2",
        title: "总线间接指令需求项",
        requirementContext: "软件接收到间接指令后，通过总线（CANA或CANB）发送间接指令应答。",
        processingContext: "若接收到“中继测控子系统与中继星1星通信”间接指令，则设置中继星选型结果为0x01。",
        inputFlowContext: "间接指令。",
        outputFlowContext: "间接指令应答数据。",
      },
    ],
    softwareId: "SW-001",
    codeVersion: "V1.0",
  }
}

function writeTestRequirements(root: string, value = makeTestRequirementsArtifact()) {
  writeJson(join(root, ".matrix", "data", "test-requirements.json"), value)
}

function writeMarkdownPromptCatalog(root: string, templates: Record<string, string>) {
  const catalogDir = join(root, "testcase-prompts")
  mkdirSync(catalogDir, { recursive: true })

  const entries = Object.entries(templates).map(([key, prompt], index) => {
    const typeName = key.replace(/^test-/, "").replace(/-STEP-GENERATED$/, "")
    const file = PHASE6_SOFTWARE_TEMPLATE_FILES[typeName]
      ?? (key === "TR-DG-STEP-GENERATED" ? "test-default.md" : `template-${index + 1}.md`)
    const match = key === "TR-XQ"
      ? { project_types: ["requirements"] }
      : key === "TR-DG-STEP-GENERATED"
      ? { project_types: ["software", "software_variant"] }
      : key === "FPGA-DG-STEP-NOT-GENERATED"
      ? { project_types: ["fpga"] }
      : key.startsWith("FPGA-") && key.endsWith("-STEP-GENERATED")
      ? { project_types: ["fpga"], test_types: [key.replace(/^FPGA-/, "").replace(/-STEP-GENERATED$/, "")] }
      : key.endsWith("-STEP-GENERATED")
      ? {
        project_types: ["software", "software_variant"],
        test_types: [typeName],
      }
      : undefined
    const fallback = key === "TR-XQ" || key === "TR-DG-STEP-GENERATED" || key === "FPGA-DG-STEP-NOT-GENERATED"

    writeFileSync(
      join(catalogDir, file),
      [
        `# ${key}`,
        "",
        "## 适用范围",
        `- 模板 Key：\`${key}\``,
        "",
        "## 业务说明",
        "测试专用最小模板。",
        "",
        "## 占位符",
        "- `{tr_id}`",
        "",
        "## 提示词正文",
        "```prompt",
        prompt,
        "```",
        "",
      ].join("\n"),
      "utf-8",
    )

    return {
      key,
      file,
      ...(match ? { match } : {}),
      fallback,
      priority: fallback ? 10 : 30,
    }
  })

  writeJson(join(catalogDir, "index.json"), {
    version: 1,
    templates: entries,
  })
}

describe("testcase_generator_run", () => {
  test("uses workdir .matrix/data/DTPProject/组合关键字 as default keyword directory", () => {
    const dirs = resolveKeywordSearchDirs("/tmp/matrix-project")
    expect(dirs).toEqual(["/tmp/matrix-project/.matrix/data/DTPProject/组合关键字"])
  })

  test("reads the canonical test-requirements artifact from the default workspace path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "testcase-generator-run-artifact-"))
    mkdirSync(dir, { recursive: true })
    // Use generic domain so this test exercises the markdown template path
    mkdirSync(join(dir, ".matrix", "config"), { recursive: true })
    writeFileSync(join(dir, ".matrix", "config", "matrix.jsonc"), JSON.stringify({ domain: "generic" }), "utf-8")
    writeTestRequirements(dir)
    writeMarkdownPromptCatalog(dir, {
      "功能测试-STEP-GENERATED": "需求 {tr_id}：{tr_handling}",
      "TR-DG-STEP-GENERATED": "需求 {tr_id}：{tr_handling}",
    })
    writeFileSync(
      join(dir, "prompt_templates.json"),
      JSON.stringify({
        "功能测试-STEP-GENERATED": "legacy {tr_id}",
      }, null, 2),
      "utf-8",
    )

    const previousGeneratorPath = process.env.MATRIX_TESTCASE_GENERATOR_PATH
    process.env.MATRIX_TESTCASE_GENERATOR_PATH = dir
    try {
      const raw = await (testcaseGeneratorRun as any).execute(
        {},
        makeCtx(dir),
      )

      const result = JSON.parse(raw)
      expect(result.status).toBe("success")
      expect(result.input_format).toBe("test_requirements_file")
      expect(result.test_requirements_file).toBe(join(dir, ".matrix", "data", "test-requirements.json"))
      expect(result.artifact_meta.software_id).toBe("SW-001")
      expect(result.suite_meta.version).toBe("V1.0")
      expect(typeof result.generation_manifest_file).toBe("string")
      expect(existsSync(result.generation_manifest_file)).toBe(true)
      expect(result.items).toBeUndefined()
      expect(JSON.stringify(result)).not.toContain("需求 TR-GN-JJZL-001")
      const manifest = readGenerationManifest(result)
      const item = manifest.items[0]
      expect(item.requirement_id).toBe("TR-GN-JJZL-001")
      expect(item.category_key).toBe("GN-JJZL")
      expect(item.path).toBe("/4/1/2/")
      expect(manifest.template_provenance_version).toBe(1)
      expect(item.template_file).toBe(join(dir, "testcase-prompts", "test-functional.md"))
      expect(item.template_source).toBe("markdown")
      expect(item.template_index_file).toBe(join(dir, "testcase-prompts", "index.json"))
      expect(item.template_domain).toBe("generic")
      expect(item.template_hash).toBe(createHash("sha256").update(readFileSync(item.template_file)).digest("hex"))
      expect(result.template_usage).toEqual([{ template_file: item.template_file, requirement_count: 1 }])
      expect(typeof item.normalization_context_json).toBe("string")
      expect(JSON.parse(item.normalization_context_json).requirement_id).toBe("TR-GN-JJZL-001")
      expect(typeof item.worker_prompt_file).toBe("string")
      expect(existsSync(item.worker_prompt_file)).toBe(true)
      const workerPrompt = readFileSync(item.worker_prompt_file, "utf-8")
      expect(workerPrompt).toContain("<<SINGLE_REQUIREMENT_WORKER>>")
      expect(workerPrompt).toContain("<normalization_context>")
      expect(item.prompt).toContain("需求 TR-GN-JJZL-001")
      expect(item.prompt).not.toContain("legacy")
      expect(item.prompt).not.toContain("关键字候选开始")
      expect(item.prompt).not.toContain("协议语义预览开始")
      expect(item.prompt).not.toContain("输入数据摘要开始")
      expect(item.prompt).not.toContain("<matrix_generation_context>")
      expect(item.prompt).not.toContain("*****需求标识开始*****")
      expect(item.prompt).not.toContain("### 补充上下文")
    } finally {
      process.env.MATRIX_TESTCASE_GENERATOR_PATH = previousGeneratorPath
    }
  })

  test("clears stale published markdown and docx outputs before starting a new Phase 6 generation cycle", async () => {
    const dir = mkdtempSync(join(tmpdir(), "testcase-generator-run-clean-publish-"))
    mkdirSync(join(dir, ".matrix", "reports"), { recursive: true })
    writeTestRequirements(dir)
    writeMarkdownPromptCatalog(dir, {
      "功能测试-STEP-GENERATED": "需求 {tr_id}：{tr_handling}",
      "TR-DG-STEP-GENERATED": "需求 {tr_id}：{tr_handling}",
    })
    writeFileSync(join(dir, ".matrix", "reports", "test-cases.md"), "old markdown", "utf-8")
    writeFileSync(join(dir, ".matrix", "reports", "confirmation-tests.docx"), "old docx", "utf-8")

    const previousGeneratorPath = process.env.MATRIX_TESTCASE_GENERATOR_PATH
    process.env.MATRIX_TESTCASE_GENERATOR_PATH = dir
    try {
      const raw = await (testcaseGeneratorRun as any).execute({}, makeCtx(dir))
      const result = JSON.parse(raw)

      expect(result.status).toBe("success")
      expect(existsSync(join(dir, ".matrix", "reports", "test-cases.md"))).toBe(false)
      expect(existsSync(join(dir, ".matrix", "reports", "confirmation-tests.docx"))).toBe(false)
      expect(JSON.stringify(result.warnings)).toContain("等待本轮 review 通过后重新发布")
    } finally {
      process.env.MATRIX_TESTCASE_GENERATOR_PATH = previousGeneratorPath
    }
  })

  test("keeps large generation runs compact and stores full items in the manifest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "testcase-generator-run-large-"))
    mkdirSync(dir, { recursive: true })
    writeTestRequirements(dir, {
      funItem: Array.from({ length: 45 }, (_, index) => ({
        funId: [`TR-GN-BULK-${String(index + 1).padStart(3, "0")}`],
        testType: "功能测试",
        title: `批量功能 ${index + 1}`,
        requirementContext: "批量功能测试背景。",
        processingContext: `验证批量功能 ${index + 1}。`,
        inputFlowContext: "输入。",
        outputFlowContext: "输出。",
      })),
      softwareId: "SW-001",
      codeVersion: "V1.0",
    })
    writeMarkdownPromptCatalog(dir, {
      "功能测试-STEP-GENERATED": "需求 {tr_id}：{tr_handling}",
      "TR-DG-STEP-GENERATED": "需求 {tr_id}：{tr_handling}",
    })

    const previousGeneratorPath = process.env.MATRIX_TESTCASE_GENERATOR_PATH
    process.env.MATRIX_TESTCASE_GENERATOR_PATH = dir
    try {
      const raw = await (testcaseGeneratorRun as any).execute({}, makeCtx(dir))
      const result = JSON.parse(raw)
      const manifest = readGenerationManifest(result)

      expect(result.status).toBe("success")
      expect(result.total).toBe(45)
      expect(raw.length).toBeLessThan(5000)
      expect(result.items).toBeUndefined()
      expect(raw).not.toContain("验证批量功能 45")
      expect(manifest.items).toHaveLength(45)
      expect(manifest.items[44].requirement_id).toBe("TR-GN-BULK-045")
    } finally {
      process.env.MATRIX_TESTCASE_GENERATOR_PATH = previousGeneratorPath
    }
  })

  test("uses deployed test templates when the project has no catalog, even with broken legacy JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "testcase-generator-run-builtins-"))
    mkdirSync(dir, { recursive: true })
    // Use generic domain to test the generic built-in fallback path
    mkdirSync(join(dir, ".matrix", "config"), { recursive: true })
    writeFileSync(join(dir, ".matrix", "config", "matrix.jsonc"), JSON.stringify({ domain: "generic" }), "utf-8")
    writeTestRequirements(dir)
    mkdirSync(join(dir, "broken-templates"), { recursive: true })
    writeFileSync(join(dir, "broken-templates", "prompt_templates.json"), "{broken json", "utf-8")

    const previousGeneratorPath = process.env.MATRIX_TESTCASE_GENERATOR_PATH
    process.env.MATRIX_TESTCASE_GENERATOR_PATH = join(dir, "broken-templates")
    try {
      const raw = await (testcaseGeneratorRun as any).execute(
        {},
        makeCtx(dir),
      )

      const result = JSON.parse(raw)
      expect(result.status).toBe("success")
      const manifest = readGenerationManifest(result)
      expect(manifest.items[0].template_file).toEndWith("/test-functional.md")
      expect(manifest.items[0].template_source).toBe("markdown")
      expect(JSON.stringify(result.warnings)).toContain("解析 legacy prompt_templates.json 失败")
    } finally {
      process.env.MATRIX_TESTCASE_GENERATOR_PATH = previousGeneratorPath
    }
  })

  test("rejects an invalid selected catalog without silently using legacy templates or deleting published outputs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "testcase-generator-run-legacy-fallback-"))
    mkdirSync(dir, { recursive: true })
    writeTestRequirements(dir)
    mkdirSync(join(dir, "testcase-prompts"), { recursive: true })
    writeJson(join(dir, "testcase-prompts", "index.json"), {
      version: 1,
      templates: [
        {
          key: "功能测试-STEP-GENERATED",
          file: "broken.md",
          match: {
            project_types: ["software", "software_variant"],
            test_types: ["功能测试"],
          },
          fallback: false,
          priority: 30,
        },
        {
          key: "TR-DG-STEP-GENERATED",
          file: "broken-default.md",
          match: {
            project_types: ["software", "software_variant"],
          },
          fallback: true,
          priority: 10,
        },
      ],
    })
    writeFileSync(join(dir, "testcase-prompts", "broken.md"), "# bad", "utf-8")
    writeFileSync(join(dir, "testcase-prompts", "broken-default.md"), "# bad", "utf-8")
    const published = join(dir, ".matrix", "reports", "test-cases.md")
    mkdirSync(dirname(published), { recursive: true })
    writeFileSync(published, "previous publication", "utf-8")
    writeFileSync(
      join(dir, "prompt_templates.json"),
      JSON.stringify({
        "功能测试-STEP-GENERATED": "legacy 需求 {tr_id}：{tr_handling}",
        "TR-DG-STEP-GENERATED": "legacy 需求 {tr_id}：{tr_handling}",
      }, null, 2),
      "utf-8",
    )

    // Set domain=generic so legacy fallback path is tested (not satellite templates)
    mkdirSync(join(dir, ".matrix", "config"), { recursive: true })
    writeFileSync(join(dir, ".matrix", "config", "matrix.jsonc"), JSON.stringify({ domain: "generic" }), "utf-8")

    const previousGeneratorPath = process.env.MATRIX_TESTCASE_GENERATOR_PATH
    process.env.MATRIX_TESTCASE_GENERATOR_PATH = dir
    try {
      const raw = await (testcaseGeneratorRun as any).execute({}, makeCtx(dir))
      const result = JSON.parse(raw)
      expect(result.status).toBe("error")
      expect(result.error_category).toBe("template_resolution")
      expect(result.generation_manifest_file).toBeUndefined()
      expect(existsSync(join(dir, ".matrix", "data", "phase6-worker-prompts"))).toBe(false)
      expect(readFileSync(published, "utf-8")).toBe("previous publication")
    } finally {
      process.env.MATRIX_TESTCASE_GENERATOR_PATH = previousGeneratorPath
    }
  })

  test("carries chapter background into generated item context", async () => {
    const dir = mkdtempSync(join(tmpdir(), "testcase-generator-run-"))
    mkdirSync(dir, { recursive: true })
    writeTestRequirements(dir, {
      funItem: [
        {
          funId: ["TR-GN-JJZL-001"],
          testType: "功能测试",
          titleNo: "4.1.2",
          title: "",
          requirementContext: "软件接收到间接指令后，通过总线（CANA或CANB）发送间接指令应答。",
          processingContext: "若接收到“中继测控子系统与中继星1星通信”间接指令，则设置中继星选型结果为0x01。",
          inputFlowContext: "间接指令。",
          outputFlowContext: "间接指令应答数据。",
        },
      ],
    })
    writeMarkdownPromptCatalog(dir, {
      "功能测试-STEP-GENERATED": "需求 {tr_id}：{tr_handling}",
      "TR-DG-STEP-GENERATED": "需求 {tr_id}：{tr_handling}",
    })

    const previousGeneratorPath = process.env.MATRIX_TESTCASE_GENERATOR_PATH
    process.env.MATRIX_TESTCASE_GENERATOR_PATH = dir
    try {
      const raw = await (testcaseGeneratorRun as any).execute(
        {},
        makeCtx(dir),
      )

      const result = JSON.parse(raw)
      expect(result.status).toBe("success")
      const manifest = readGenerationManifest(result)
      expect(manifest.items[0].requirementContext).toContain("CANA或CANB")
      expect(manifest.items[0].prompt).toContain("每条指令×每条接收总线（CANA/CANB）独立成用例")
      expect(manifest.items[0].prompt).not.toContain("必须在同一个测试用例中用多条步骤分别覆盖")
      const normalizationContext = JSON.parse(manifest.items[0].normalization_context_json)
      expect(normalizationContext.requirementContext).toContain("CANA或CANB")
      expect(normalizationContext.inputFlowContext).toBe("间接指令。")
    } finally {
      process.env.MATRIX_TESTCASE_GENERATOR_PATH = previousGeneratorPath
    }
  })

  test("does not build protocol context from DOCX — all context comes from test-requirements.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "testcase-generator-run-no-protocol-"))
    mkdirSync(dir, { recursive: true })
    writeTestRequirements(dir, {
      funItem: [
        {
          funId: ["TR-GN-JJZL-001"],
          test_type: "功能测试",
          title: "总线间接指令需求项",
          requirementContext: "软件接收到间接指令后，通过总线（CANA或CANB）发送间接指令应答。",
          inputFlowContext: "间接指令。",
          outputFlowContext: "间接指令应答数据。",
          processingContext: "若接收到“中继测控子系统与中继星1星通信”间接指令，则设置中继星选型结果为0x01。",
        },
      ],
    })
    writeThirdPartyRequirementDocx(join(dir, ".matrix", "reports", "CNAS第三方测试需求.docx"))
    writeMarkdownPromptCatalog(dir, {
      "功能测试-STEP-GENERATED": "需求 {tr_id}：{tr_handling}",
      "TR-DG-STEP-GENERATED": "需求 {tr_id}：{tr_handling}",
    })

    const previousGeneratorPath = process.env.MATRIX_TESTCASE_GENERATOR_PATH
    process.env.MATRIX_TESTCASE_GENERATOR_PATH = dir
    try {
      const raw = await (testcaseGeneratorRun as any).execute({}, makeCtx(dir))
      const result = JSON.parse(raw)
      expect(result.status).toBe("success")
      const item = readGenerationManifest(result).items[0]
      const normalizationContext = JSON.parse(item.normalization_context_json)

      // 问题3：即使第三方测试需求 DOCX 存在，也不再读取/生成协议语义文件与输入数据集
      expect(item.protocol_summary_file).toBeUndefined()
      expect(item.protocol_semantic_file).toBeUndefined()
      expect(item.input_dataset_ref).toBeUndefined()
      expect(normalizationContext.protocol_dirs).toBeUndefined()
      expect(normalizationContext.protocol_summary_file).toBeUndefined()
      expect(normalizationContext.protocol_semantic_file).toBeUndefined()
      expect(normalizationContext.requirement_id).toBe("TR-GN-JJZL-001")
    } finally {
      process.env.MATRIX_TESTCASE_GENERATOR_PATH = previousGeneratorPath
    }
  })

  test("writes the B1a step plan into normalization_context when the keyword library is present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "testcase-generator-run-step-plan-"))
    mkdirSync(dir, { recursive: true })
    writeTestRequirements(dir, {
      funItem: [
        {
          funId: ["TR-GN-JJZL-001"],
          test_type: "功能测试",
          title: "总线间接指令需求项",
          requirementContext: "软件接收到间接指令后，通过总线（CANA或CANB）发送间接指令应答。",
          inputFlowContext: "间接指令。",
          outputFlowContext: "间接指令应答数据。",
          processingContext: "若接收到“中继测控子系统与中继星1星通信”间接指令，则设置中继星选型结果为0x01。",
        },
      ],
    })
    // 默认关键字目录 .matrix/data/DTPProject/组合关键字
    writeJson(join(dir, ".matrix", "data", "DTPProject", "组合关键字", "UserKeyword.json"), {
      Items: [
        { Name: "发送CANA数据", Comments: "第${time}秒,通过CANA总线${para3}发送${para2}", Arguments: [
          { Name: "${time}", Comments: "执行时间" },
          { Name: "${para2}", Comments: "参数2：数据协议名称" },
          { Name: "${para3}", Comments: "参数3：循环周期" },
        ] },
        { Name: "发送CANB数据", Comments: "第${time}秒,通过CANB总线${para3}发送${para2}", Arguments: [
          { Name: "${time}", Comments: "执行时间" },
          { Name: "${para2}", Comments: "参数2：数据协议名称" },
          { Name: "${para3}", Comments: "参数3：循环周期" },
        ] },
      ],
    })
    writeMarkdownPromptCatalog(dir, {
      "功能测试-STEP-GENERATED": "需求 {tr_id}：{tr_handling}",
      "TR-DG-STEP-GENERATED": "需求 {tr_id}：{tr_handling}",
    })

    const previousGeneratorPath = process.env.MATRIX_TESTCASE_GENERATOR_PATH
    process.env.MATRIX_TESTCASE_GENERATOR_PATH = dir
    try {
      const raw = await (testcaseGeneratorRun as any).execute({}, makeCtx(dir))
      const result = JSON.parse(raw)
      expect(result.status).toBe("success")
      const normalizationContext = JSON.parse(readGenerationManifest(result).items[0].normalization_context_json)

      expect(Array.isArray(normalizationContext.step_plan)).toBe(true)
      const plan = normalizationContext.step_plan
      expect(plan.length).toBeGreaterThanOrEqual(2)
      expect(plan[0].purpose).toBe("send_command")
      expect(plan[0].keyword_name).toBe("发送CANA数据")
      expect(plan[0].bus_channel).toBe("CANA")
      // 2026-08-20 事故修正:计划是路由提示,不再携带合成参数值/合成时序/
      // 渲染文本——参数值由翻译阶段从 worker 实际步骤文本提取或按拍板语义填充
      expect(plan[0].argument_bindings).toEqual({})
      expect(plan[0].suggested_operation_type).toBe("send_command")
      expect(plan[0].suggested_channel).toBe("CANA")
      expect(plan[0].suggested_temporal).toBeUndefined()
      expect(plan[0].resolved_step_desc).toBeUndefined()
    } finally {
      process.env.MATRIX_TESTCASE_GENERATOR_PATH = previousGeneratorPath
    }
  })

  test("handles the new atomic-array funId format across all consumers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "testcase-generator-run-funid-array-"))
    mkdirSync(dir, { recursive: true })
    // 新格式（Phase 6 权威格式）：funId 为原子 ID 数组，无区间/顿号字符串
    const funIds = ["TR-JK-001", "TR-JK-002", "TR-JK-003", "TR-JK-004", "TR-JK-005", "TR-JK-006", "TR-JK-007", "TR-JK-008"]
    writeTestRequirements(dir, {
      funItem: [
        {
          funId: funIds,
          test_type: "接口测试",
          titleNo: "4.3.1",
          title: "接口需求项[TR-JK]",
          requirementContext: "接口需求背景。",
          inputFlowContext: "输入指令。",
          processingContext: "处理指令并应答。",
          outputFlowContext: "应答数据。",
        },
      ],
    })
    writeMarkdownPromptCatalog(dir, {
      "接口测试-STEP-GENERATED": "需求 {tr_id}：{tr_handling}",
      "TR-DG-STEP-GENERATED": "需求 {tr_id}：{tr_handling}",
    })

    const previousGeneratorPath = process.env.MATRIX_TESTCASE_GENERATOR_PATH
    process.env.MATRIX_TESTCASE_GENERATOR_PATH = dir
    try {
      const raw = await (testcaseGeneratorRun as any).execute({}, makeCtx(dir))
      const result = JSON.parse(raw)
      expect(result.status).toBe("success")
      const item = readGenerationManifest(result).items[0]

      // 多 ID 需求：requirement_id 为顿号拼接串，correspond_fun_id 直接照抄即可追溯
      expect(item.requirement_id).toBe(funIds.join("、"))
      expect(item.source_requirement_ids).toEqual(funIds)
      expect(item.category_key).toBe("JK")

      const normalizationContext = JSON.parse(item.normalization_context_json)
      expect(normalizationContext.requirement_id).toBe(funIds.join("、"))
      // 五字段上下文命名（I-05）
      expect(normalizationContext.requirementContext).toBe("接口需求背景。")
      expect(normalizationContext.inputFlowContext).toBe("输入指令。")
      expect(normalizationContext.processingContext).toBe("处理指令并应答。")
      expect(normalizationContext.outputFlowContext).toBe("应答数据。")
    } finally {
      process.env.MATRIX_TESTCASE_GENERATOR_PATH = previousGeneratorPath
    }
  })

  test("returns stable normalization_context_json when requirement text contains ASCII quotes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "testcase-generator-run-json-context-"))
    mkdirSync(dir, { recursive: true })
    writeTestRequirements(dir, {
      funItem: [
        {
          funId: ["TR-GN-JJZL-001"],
          testType: "功能测试",
          titleNo: "4.1.2",
          title: "",
          requirementContext: "软件接收到间接指令后，通过总线（CANA或CANB）发送间接指令应答。",
          processingContext: "若接收到\"中继测控子系统与中继星1星通信\"间接指令，则设置中继星选型结果为0x01。",
          inputFlowContext: "间接指令。",
          outputFlowContext: "间接指令应答数据。",
        },
      ],
    })
    writeMarkdownPromptCatalog(dir, {
      "功能测试-STEP-GENERATED": "需求 {tr_id}：{tr_handling}",
      "TR-DG-STEP-GENERATED": "需求 {tr_id}：{tr_handling}",
    })

    const previousGeneratorPath = process.env.MATRIX_TESTCASE_GENERATOR_PATH
    process.env.MATRIX_TESTCASE_GENERATOR_PATH = dir
    try {
      const raw = await (testcaseGeneratorRun as any).execute({}, makeCtx(dir))
      const result = JSON.parse(raw)
      const item = readGenerationManifest(result).items[0]
      const normalizationContext = JSON.parse(item.normalization_context_json)
      const workerPrompt = readFileSync(item.worker_prompt_file, "utf-8")

      expect(normalizationContext.processingContext).toContain("\"中继测控子系统与中继星1星通信\"")
      expect(workerPrompt).toContain("\\\"中继测控子系统与中继星1星通信\\\"")
    } finally {
      process.env.MATRIX_TESTCASE_GENERATOR_PATH = previousGeneratorPath
    }
  })

  test("accepts an explicit test_requirements_file and derives suite metadata without software-analysis", async () => {
    const dir = mkdtempSync(join(tmpdir(), "testcase-generator-run-metadata-"))
    mkdirSync(dir, { recursive: true })
    writeTestRequirements(dir, {
      ...makeTestRequirementsArtifact(),
      softwareId: "SW-EXPLICIT",
      codeVersion: "V9.8",
    })
    writeJson(join(dir, ".matrix", "config", "matrix.jsonc"), {
      project: {
        csci_name: "北向项目",
        version: "2026.1",
        doc_id: "DOC-001",
      },
    })
    writeMarkdownPromptCatalog(dir, {
      "功能测试-STEP-GENERATED": "需求 {tr_id}：{tr_handling}",
      "TR-DG-STEP-GENERATED": "需求 {tr_id}：{tr_handling}",
    })

    const previousGeneratorPath = process.env.MATRIX_TESTCASE_GENERATOR_PATH
    process.env.MATRIX_TESTCASE_GENERATOR_PATH = dir
    try {
      const raw = await (testcaseGeneratorRun as any).execute(
        {
          test_requirements_file: ".matrix/data/test-requirements.json",
        },
        makeCtx(dir),
      )

      const result = JSON.parse(raw)
      expect(result.status).toBe("success")
      expect(result.suite_meta.project_name).toBe("北向项目")
      expect(result.suite_meta.version).toBe("2026.1")
      expect(result.suite_meta.software_id).toBe("SW-EXPLICIT")
      expect(result.suite_meta.code_version).toBe("V9.8")
    } finally {
      process.env.MATRIX_TESTCASE_GENERATOR_PATH = previousGeneratorPath
    }
  })
})

describe("testcaseFormatCheck", () => {
  test("resolves keyword placeholders from requirement context and suggestions without protocol semantic file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "testcase-format-check-"))

    const raw = await (testcaseFormatCheck as any).execute(
      {
        generated_text: JSON.stringify([
          {
            case_name: "发送指令",
            test_purpose: "验证发送指令。",
            test_step: [
              {
                "步骤描述": "第${time}秒,通过CANA总线${para3}发送${para2}",
                "预期结果": "软件正确处理并输出可验证结果，中继星选型结果（W2b7-W2b4）需要验证。",
              },
            ],
          },
        ]),
        input_dataset_ref: ".matrix/data/input-datasets/间接指令.json#normal-01",
        processingContext: "若接收到“中继测控子系统与中继星1星通信”间接指令，则设置缓变遥测书籍中中继星选型结果（W2b7-W2b4）为0x01。",
        requirementContext: "软件接收到间接指令后，通过CANA总线发送间接指令应答。",
        chapter_title: "校时方式切换功能",
        inputFlowContext: "间接指令。",
        outputFlowContext: "间接指令应答数据。",
        keyword_candidates: [
          {
            keywordName: "发送CANA数据",
            description: "第${time}秒,通过CANA总线${para3}发送${para2}",
            argumentNames: ["${time}", "${para1}", "${para2}", "${para3}"],
            argumentComments: [
              "执行时间",
              "参数1：ID",
              "参数2：数据协议名称",
              "参数3：循环时间，单位为秒，无参数3只发送当前一次",
            ],
            txtSnippet: "",
          },
        ],
        placeholder_suggestions: [
          {
            case_index: 0,
            step_index: 0,
            placeholder: "${time}",
            value: "10.8",
            reason: "按测试常识给出合理发送时间",
          },
        ],
      },
      makeCtx(dir),
    )

    const result = JSON.parse(raw)
    expect(result.valid).toBe(true)
    expect(result.cases[0].test_input).toBe(".matrix/data/input-datasets/间接指令.json#normal-01")

    const steps = result.cases[0].test_step
    expect(steps[0]["步骤描述"]).toContain("第10.8秒")
    expect(steps[0]["预期结果"]).toContain("CANA总线发送间接指令应答数据")
    expect(steps[0]["预期结果"]).toContain("W2b7-W2b4设置为0x01")
  })

  test("generated_text_file + persist=true persists all cases file-to-file without inline echo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "testcase-format-check-persist-"))
    const previousCwd = process.cwd()
    process.chdir(dir)

    try {
      writeJson(join(dir, ".matrix", "data", "test-requirements.json"), {
        funItem: [
          {
            funId: ["TR-XN-001"],
            test_type: "接口测试",
            titleNo: "4.3.1",
            title: "接口需求项[TR-XN]",
            requirementContext: "硬件狗接口",
            inputFlowContext: "IF-DOG-001：通过BM3803的PIO12写操作实现喂狗。狗咬时间为1.8s。输出流：喂狗信号。",
            processingContext: "TR-XN-001：通过BM3803的PIO12写操作实现喂狗",
          },
          {
            funId: ["TR-JK-001", "TR-JK-002", "TR-JK-003", "TR-JK-004"],
            test_type: "接口测试",
            titleNo: "4.3.1",
            title: "接口需求项[TR-JK]",
            requirementContext: "接口需求背景。",
            inputFlowContext: "输入指令。",
            processingContext: "处理指令并应答。",
            outputFlowContext: "应答数据。",
          },
        ],
      })
      // worker 以 FILE: 落盘的大输出(此处 2 用例,带 covered_tr_items)
      writeJson(join(dir, ".matrix", "data", "TR-JK-001_output.json"), [
        {
          case_name: "轮询序列异常测试",
          test_purpose: "验证轮询序列异常处理。",
          covered_tr_items: ["TR-JK-001", "TR-JK-002"],
          correspond_fun_id: "TR-JK-001、TR-JK-002、TR-JK-003、TR-JK-004",
          initial_settings: "被测件已上电并完成初始化。",
          test_input: "轮询序列异常输入数据集tm-err.txt",
          test_step: [{ 步骤描述: "第3.0秒，通过CANA总线发送遥测帧1轮询控制序列数据文件tm1.txt。", 预期结果: "系统返回遥测数据。" }],
        },
        {
          case_name: "遥控指令异常测试",
          test_purpose: "验证遥控指令异常处理。",
          covered_tr_items: ["TR-JK-003", "TR-JK-004"],
          test_step: [{ 步骤描述: "第5.0秒，通过CANA总线发送10字节遥控指令数据文件cmd10.txt。", 预期结果: "系统正确接收指令。" }],
        },
      ])

      writeJson(join(dir, ".matrix", "data", "TR-XN-001_output.json"), [
        {
          case_name: "软件清看门狗时间间隔测试",
          test_purpose: "测试软件清看门狗时间间隔（即PIO12相邻两次写操作的时间间隔）的情况；考虑了插入中断的最坏情况。",
          covered_tr_items: ["TR-XN-001"],
          test_step: [
            { 步骤描述: "使用示波器多次测试清看门狗时间间隔（即PIO12相邻两次写操作的时间间隔）。", 预期结果: "软件清看门狗时间间隔最大不超过清看门狗最大时间s。" },
          ],
        },
      ])

      await (ctSuiteCreate as any).execute({ project_name: "Matrix", version: "1.0" })

      const raw = await (testcaseFormatCheck as any).execute(
        {
          generated_text_file: ".matrix/data/TR-JK-001_output.json",
          requirement_id: "TR-JK-001、TR-JK-002、TR-JK-003、TR-JK-004",
          persist: true,
        },
        makeCtx(dir),
      )
      const result = JSON.parse(raw)
      expect(result.persisted).toBe(true)
      expect(result.persisted_case_count).toBe(2)
      expect(result.case_ids).toEqual(["TC-JK-001", "TC-JK-002"])

      const suite = JSON.parse(readFileSync(join(dir, ".matrix", "data", "confirmation-tests.json"), "utf-8"))
      expect(suite.test_cases).toHaveLength(2)
      // cfid=需求项整组 funId,path/test_type 由需求文件权威解析
      for (const c of suite.test_cases) {
        expect(c.correspond_fun_id).toBe("TR-JK-001、TR-JK-002、TR-JK-003、TR-JK-004")
        expect(c.test_type).toBe("接口测试")
        expect(c.path).toBe("/4/3/1/")
      }
      // rsrid=各用例 covered 子集
      expect(suite.test_cases[0].related_software_req_ids).toBe("TR-JK-001~002")
      expect(suite.test_cases[1].related_software_req_ids).toBe("TR-JK-003~004")
      // case 级字段随 persist 透传(2026-08-31 审计:此前 persist 路径恒落"无")
      expect(suite.test_cases[0].initial_settings).toBe("被测件已上电并完成初始化。")
      expect(suite.test_cases[0].test_input).toContain("tm-err.txt")
      expect(suite.test_cases[1].initial_settings).toBe("无")
      expect(suite.test_cases[1].test_input).toBe("无")
      // 普通用例环境仍为软平台
      expect(suite.test_cases[0].test_environment).toBe("软平台测试环境")

      // 看门狗坏形态(自由发挥:内存写喂狗步骤/多步骤)先被固定句式门禁拒绝
      writeJson(join(dir, ".matrix", "data", "TR-XN-001_output.json"), [
        {
          case_name: "硬件狗喂狗接口触发测试",
          test_purpose: "验证软件通过 BM3803 的 PIO12 写操作实现喂狗的接口触发行为。",
          covered_tr_items: ["TR-XN-001"],
          test_step: [
            { 步骤描述: "第1.0秒，设置内存地址PIO12_GPIO_DATA_REG_H的数据为0x01（通过PIO12写操作触发喂狗动作）。", 预期结果: "软件通过PIO12写操作触发喂狗动作，喂狗信号有效。" },
            { 步骤描述: "第1.5秒，设置内存地址PIO12_GPIO_DATA_REG_H的数据为0x01（再次通过PIO12写操作触发喂狗动作）。", 预期结果: "软件在1.8s阈值内再次触发喂狗动作。" },
          ],
        },
      ])
      const badShapeRaw = await (testcaseFormatCheck as any).execute(
        {
          generated_text_file: ".matrix/data/TR-XN-001_output.json",
          requirement_id: "TR-XN-001",
          persist: true,
          requirementContext: "硬件狗接口",
          inputFlowContext: "IF-DOG-001：通过BM3803的PIO12写操作实现喂狗。狗咬时间为1.8s。",
          processingContext: "TR-XN-001：通过BM3803的PIO12写操作实现喂狗",
        },
        makeCtx(dir),
      )
      const badShape = JSON.parse(badShapeRaw)
      expect(badShape.persisted).toBe(false)
      expect(badShape.structure_violations.some((v: any) => v.type === "watchdog_shape_violation")).toBe(true)
      expect((badShape.regroup_directive ?? []).some((l: string) => l.includes("固定句式模板逐字重写"))).toBe(true)

      // 看门狗需求 persist:标准化环境覆写为硬平台(2026-09-08 用户拍板)
      // (坏形态断言已覆写输出文件,此处重写好形态固定句式)
      writeJson(join(dir, ".matrix", "data", "TR-XN-001_output.json"), [
        {
          case_name: "软件清看门狗时间间隔测试",
          test_purpose: "测试软件清看门狗时间间隔（即PIO12相邻两次写操作的时间间隔）的情况；考虑了插入中断的最坏情况。",
          covered_tr_items: ["TR-XN-001"],
          test_step: [
            { 步骤描述: "使用示波器多次测试清看门狗时间间隔（即PIO12相邻两次写操作的时间间隔）。", 预期结果: "软件清看门狗时间间隔最大不超过清看门狗最大时间s。" },
          ],
        },
      ])
      const watchdogRaw = await (testcaseFormatCheck as any).execute(
        {
          generated_text_file: ".matrix/data/TR-XN-001_output.json",
          requirement_id: "TR-XN-001",
          persist: true,
          // 本测试无 manifest,显式传五字段上下文模拟生产链路的回填
          requirementContext: "硬件狗接口",
          inputFlowContext: "IF-DOG-001：通过BM3803的PIO12写操作实现喂狗。狗咬时间为1.8s。",
          processingContext: "TR-XN-001：通过BM3803的PIO12写操作实现喂狗",
        },
        makeCtx(dir),
      )
      const watchdogResult = JSON.parse(watchdogRaw)
      expect(watchdogResult.persisted).toBe(true)
      const watchdogCase = JSON.parse(readFileSync(join(dir, ".matrix", "data", "confirmation-tests.json"), "utf-8"))
        .test_cases.find((c: any) => c.correspond_fun_id === "TR-XN-001")
      expect(watchdogCase.test_environment).toBe("硬平台测试环境")
      expect(watchdogCase.test_step[0]["source_step_desc"]).toContain("使用示波器多次测试清看门狗时间间隔")
    } finally {
      process.chdir(previousCwd)
    }
  })

  test("persist 拒绝跨TR拆分违规并在重试通道放行", async () => {
    // 2026-08-20 事故:worker 对逐条 TR 枚举的"处理"字段按 TR 逐条拆分用例,
    // "遥测帧1轮询"的错误情况被拆进覆盖不同 TR 的两个用例。format_check 必须
    // 确定性检出并拒绝 persist,反馈违规明细重派;重试(allow=true)才接受。
    const dir = mkdtempSync(join(tmpdir(), "testcase-format-check-aggregation-"))
    const previousCwd = process.cwd()
    process.chdir(dir)

    try {
      writeJson(join(dir, ".matrix", "data", "test-requirements.json"), {
        funItem: [
          {
            funId: ["TR-XN-001"],
            test_type: "接口测试",
            titleNo: "4.3.1",
            title: "接口需求项[TR-XN]",
            requirementContext: "硬件狗接口",
            inputFlowContext: "IF-DOG-001：通过BM3803的PIO12写操作实现喂狗。狗咬时间为1.8s。输出流：喂狗信号。",
            processingContext: "TR-XN-001：通过BM3803的PIO12写操作实现喂狗",
          },
          {
            funId: ["TR-JK-001", "TR-JK-002", "TR-JK-003", "TR-JK-004"],
            test_type: "接口测试",
            titleNo: "4.3.1",
            title: "接口需求项[TR-JK]",
            requirementContext: "接口需求背景。",
            inputFlowContext: "输入指令。",
            processingContext: "处理指令并应答。",
            outputFlowContext: "应答数据。",
          },
        ],
      })
      writeJson(join(dir, ".matrix", "data", "TR-JK-001_output.json"), [
        {
          case_name: "单帧遥测帧轮询ID错误丢弃测试",
          test_purpose: "验证ID错误丢弃。",
          covered_tr_items: ["TR-JK-001"],
          test_step: [{ 步骤描述: "第0.5秒,通过CANA总线发送正确的遥测帧1轮询控制序列。", 预期结果: "正常处理。" }],
        },
        {
          case_name: "单帧W0字段错误丢弃测试",
          test_purpose: "验证W0错误丢弃。",
          covered_tr_items: ["TR-JK-003"],
          test_step: [{ 步骤描述: "第1.0秒,通过CANA总线发送遥测帧1轮询控制序列（W0错误,其余字段正确）。", 预期结果: "丢弃。" }],
        },
      ])

      writeJson(join(dir, ".matrix", "data", "TR-XN-001_output.json"), [
        {
          case_name: "软件清看门狗时间间隔测试",
          test_purpose: "测试软件清看门狗时间间隔（即PIO12相邻两次写操作的时间间隔）的情况；考虑了插入中断的最坏情况。",
          covered_tr_items: ["TR-XN-001"],
          test_step: [
            { 步骤描述: "使用示波器多次测试清看门狗时间间隔（即PIO12相邻两次写操作的时间间隔）。", 预期结果: "软件清看门狗时间间隔最大不超过清看门狗最大时间s。" },
          ],
        },
      ])

      await (ctSuiteCreate as any).execute({ project_name: "Matrix", version: "1.0" })

      // 首轮:违规 → 拒绝落库,返回违规明细与重派指引
      const refused = JSON.parse(await (testcaseFormatCheck as any).execute(
        {
          generated_text_file: ".matrix/data/TR-JK-001_output.json",
          requirement_id: "TR-JK-001、TR-JK-002、TR-JK-003、TR-JK-004",
          persist: true,
        },
        makeCtx(dir),
      ))
      expect(refused.persisted).toBe(false)
      expect(refused.aggregation_violations).toHaveLength(1)
      expect(refused.aggregation_violations[0].instruction_phrase).toBe("遥测帧1轮询")
      expect(refused.aggregation_violations[0].covered_tr_items).toEqual(["TR-JK-001", "TR-JK-003"])
      expect(String(refused.hint)).toContain("重派")
      // 拒绝响应携带确定性目标用例划分表,供重派 prompt 原文嵌入
      expect(refused.regroup_directive.some((line: string) => line.includes("遥测帧1轮询") && line.includes("合并")))
        .toBe(true)
      // TR 覆盖缺口:4 TR 组仅覆盖 001/003,002/004 缺失 → 拒绝并列入划分表
      expect(refused.tr_coverage_gaps).toEqual(["TR-JK-002", "TR-JK-004"])
      expect(refused.regroup_directive.some((line: string) => line.includes("TR-JK-002、TR-JK-004") && line.includes("缺失 TR 覆盖")))
        .toBe(true)
      // 拒绝落库:套件文件由 ct_suite_create 创建,但不得有用例进入
      const suiteAfterRefusal = JSON.parse(readFileSync(join(dir, ".matrix", "data", "confirmation-tests.json"), "utf-8"))
      expect(suiteAfterRefusal.test_cases).toHaveLength(0)

      // 确定性修复通道:重派后仍违规 → auto_repair=true → 按指令×总线
      // 重组(两用例合并为一个 CANA 遥测帧1轮询用例)并补配对后落库
      const repaired = JSON.parse(await (testcaseFormatCheck as any).execute(
        {
          generated_text_file: ".matrix/data/TR-JK-001_output.json",
          requirement_id: "TR-JK-001、TR-JK-002、TR-JK-003、TR-JK-004",
          persist: true,
          auto_repair_structural_violations: true,
        },
        makeCtx(dir),
      ))
      expect(repaired.persisted).toBe(true)
      expect(repaired.persisted_case_count).toBe(1)
      expect(repaired.repair_actions.length).toBeGreaterThan(0)
      expect(repaired.warnings.some((w: string) => w.includes("[聚合违规-已确定性修复]") && w.includes("遥测帧1轮询"))).toBe(true)
      // 缺口不可凭空修复:重派后仍缺失须如实上报
      expect(repaired.warnings.some((w: string) => w.includes("[TR覆盖缺口-重派后仍缺失]") && w.includes("TR-JK-002"))).toBe(true)
      // 落库用例为合并后的单用例:covered 取并集
      const suite = JSON.parse(readFileSync(join(dir, ".matrix", "data", "confirmation-tests.json"), "utf-8"))
      expect(suite.test_cases).toHaveLength(1)
      expect(suite.test_cases[0].related_software_req_ids).toBe("TR-JK-001、TR-JK-003")
    } finally {
      process.chdir(previousCwd)
    }
  })

  test("keeps unresolved keyword placeholders and still returns a valid standardized case", async () => {
    const dir = mkdtempSync(join(tmpdir(), "testcase-format-check-unresolved-placeholder-"))

    const raw = await (testcaseFormatCheck as any).execute(
      {
        generated_text: JSON.stringify([
          {
            case_name: "参数化操作",
            test_purpose: "验证参数化操作。",
            test_step: [
              {
                "步骤描述": "执行${para1}操作。",
                "预期结果": "系统记录操作结果。",
              },
            ],
          },
        ]),
        input_dataset_ref: ".matrix/data/input-datasets/default.json#normal-01",
        processingContext: "执行参数化操作。",
        test_type_chinese: "功能测试",
        keyword_candidates: [
          {
            keywordName: "执行参数化操作",
            description: "执行${para1}操作",
            argumentNames: ["${para1}"],
            argumentComments: ["参数1：需求未明确给出的操作参数"],
            txtSnippet: "",
          },
        ],
      },
      makeCtx(dir),
    )

    const result = JSON.parse(raw)
    expect(result.valid).toBe(true)
    expect(result.cases[0].test_step[0]["步骤描述"]).toBe("执行${para1}操作")
    expect(result.warnings.some((warning: string) => warning.includes("${para1}"))).toBe(true)
  })

  test("uses the default time value and enriches expected outputs when worker does not provide placeholder suggestions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "testcase-format-check-default-time-"))
    const protocolSemanticFile = join(dir, "protocol-semantic.json")

    writeJson(protocolSemanticFile, {
      protocol_name: "间接指令",
      source_file: "/tmp/间接指令.docx",
      paragraphs: [],
      tables: [
        {
          title: "表3.1.1.7-2 间接数据指令说明",
          section_title: "输入流：间接指令，格式及内容如下表所示。",
          headers: ["序号", "指令名称"],
          rows: [
            {
              "序号": "1",
              "指令名称": "中继测控子系统与中继星1通信",
            },
          ],
        },
      ],
    })

    const raw = await (testcaseFormatCheck as any).execute(
      {
        generated_text: JSON.stringify([
          {
            case_name: "发送指令",
            test_purpose: "验证发送指令。",
            test_step: [
              {
                "步骤描述": "第${time}秒,通过CANA总线${para3}发送${para2}",
                "预期结果": "软件正确处理，缓变遥测数据W2b3~W2b1和中继星选型结果（W2b7-W2b4）需要验证。",
              },
            ],
          },
        ]),
        input_dataset_ref: ".matrix/data/input-datasets/间接指令.json#normal-01",
        processingContext: "若接收到“中继测控子系统与中继星1星通信”间接指令，则设置缓变遥测书籍中中继星选型结果（W2b7-W2b4）为0x01。",
        requirementContext: "软件接收到间接指令后，通过CANA总线发送间接指令应答，将数传下位机指令计数加1（即缓变遥测数据W2b3~W2b1）。",
        inputFlowContext: "间接指令。",
        outputFlowContext: "间接指令应答数据；缓变遥测数据。",
        protocol_semantic_file: protocolSemanticFile,
        keyword_candidates: [
          {
            keywordName: "发送CANA数据",
            description: "第${time}秒,通过CANA总线${para3}发送${para2}",
            argumentNames: ["${time}", "${para1}", "${para2}", "${para3}"],
            argumentComments: ["执行时间", "参数1：ID", "参数2：数据协议名称", "参数3：循环时间"],
            txtSnippet: "",
          },
        ],
      },
      makeCtx(dir),
    )

    const result = JSON.parse(raw)
    expect(result.valid).toBe(true)

    const steps = result.cases[0].test_step
    expect(steps[0]["步骤描述"]).toContain("第10.8秒")
    expect(steps[0]["预期结果"]).toContain("CANA总线发送间接指令应答数据")
    expect(steps[0]["预期结果"]).toContain("W2b3~W2b1为1")
    expect(steps[0]["预期结果"]).toContain("W2b7-W2b4设置为0x01")
  })

  test("translates actual send steps but rejects plan-routed verification when only send keywords exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "testcase-format-check-b1a-hints-"))
    writeJson(join(dir, ".matrix", "data", "DTPProject", "组合关键字", "UserKeyword.json"), {
      Items: [
        { Name: "发送CANA数据", Comments: "第${time}秒,通过CANA总线${para3}发送${para2}", Arguments: [
          { Name: "${time}", Comments: "执行时间" },
          { Name: "${para2}", Comments: "参数2：数据协议名称" },
          { Name: "${para3}", Comments: "参数3：循环周期" },
        ] },
      ],
    })

    const raw = await (testcaseFormatCheck as any).execute(
      {
        generated_text: JSON.stringify([
          {
            case_name: "间接指令测试",
            test_purpose: "验证间接指令执行。",
            test_step: [
              { "步骤描述": "第3秒,通过CANA总线发送间接指令", "预期结果": "被测件接收到指令" },
              { "步骤描述": "第4.5秒,验证软件正确处理并输出", "预期结果": "输出间接指令应答数据" },
            ],
          },
        ]),
        processingContext: "若接收到“中继测控子系统与中继星1星通信”间接指令，则设置中继星选型结果为0x01。",
        requirementContext: "软件接收到间接指令后，通过CANA总线发送间接指令应答。",
        inputFlowContext: "间接指令。",
        outputFlowContext: "间接指令应答数据。",
      },
      makeCtx(dir),
    )

    const result = JSON.parse(raw)
    expect(result.valid).toBe(true)
    expect(result.combined_translations).toHaveLength(1)
    const translation = result.combined_translations[0]
    expect(translation.translate_status).toBe("failure")

    // 计划只提供路由(关键字名提示);参数一律取自实际步骤文本——
    // 计划的合成绑定(时序/流名)不再进入翻译(2026-08-20 事故修正)
    const step0 = translation.steps[0]
    expect(step0.key_name).toBe("发送CANA数据")
    expect(step0.parameter.find((p: { Name: string }) => p.Name === "${time}")?.Value).toBe(3)
    expect(step0.parameter.find((p: { Name: string }) => p.Name === "${para2}")?.Value).toBe("间接指令")
    expect(step0.step_desc).toContain("发送间接指令")

    const step1 = translation.steps[1]
    // 验证输出不能因为能提取时间就被伪译为发送动作；保留源文并报告失败。
    expect(step1.key_name).toBe("")
    expect(step1.parameter).toEqual([])
    expect(step1.step_desc).toContain("验证软件正确处理并输出")
  })

  test("translates explicit CANA and CANB bus steps into keyword records in the same case", async () => {
    const dir = mkdtempSync(join(tmpdir(), "testcase-format-check-dual-bus-"))
    writeJson(join(dir, ".matrix", "data", "DTPProject", "组合关键字", "UserKeyword.json"), {
      Items: [
        {
          Name: "发送CANA数据",
          Comments: "第${time}秒,通过CANA总线${para3}发送${para2}",
          Arguments: [
            { Name: "${time}", Comments: "执行时间" },
            { Name: "${para1}", Comments: "参数1：ID" },
            { Name: "${para2}", Comments: "参数2：数据协议名称" },
            { Name: "${para3}", Comments: "参数3：循环时间" },
          ],
        },
        {
          Name: "发送CANB数据",
          Comments: "第${time}秒,通过CANB总线${para3}发送${para2}",
          Arguments: [
            { Name: "${time}", Comments: "执行时间" },
            { Name: "${para1}", Comments: "参数1：ID" },
            { Name: "${para2}", Comments: "参数2：数据协议名称" },
            { Name: "${para3}", Comments: "参数3：循环时间" },
          ],
        },
        {
          Name: "设置内存数据8bit",
          Comments: "设置内存地址${addr}的8bit值为${value}",
          Arguments: [
            { Name: "${addr}", Comments: "内存地址" },
            { Name: "${value}", Comments: "目标值" },
          ],
        },
      ],
    })

    const raw = await (testcaseFormatCheck as any).execute(
      {
        generated_text: JSON.stringify([
          {
            case_name: "双总线发送",
            test_purpose: "验证双总线发送。",
            test_step: [
              {
                "步骤描述": "第10.8秒,通过CANA总线发送中继测控子系统与中继星1星通信间接指令。",
                "预期结果": "软件正确处理并输出可验证结果。",
                "channel": "CANA",
                "temporal": "第10.8秒",
                "operation_type": "send_command",
              },
              {
                "步骤描述": "第10.8秒,通过CANB总线发送中继测控子系统与中继星1星通信间接指令。",
                "预期结果": "软件正确处理并输出可验证结果。",
                "channel": "CANB",
                "temporal": "第10.8秒",
                "operation_type": "send_command",
              },
            ],
          },
        ]),
        requirement_id: "TR-GN-JJZL-001",
        test_type_chinese: "功能测试",
        processingContext: "若接收到“中继测控子系统与中继星1星通信”间接指令，则设置缓变遥测书籍中中继星选型结果（W2b7-W2b4）为0x01。",
        requirementContext: "软件接收到间接指令后，通过总线（CANA或CANB）发送间接指令应答。",
        inputFlowContext: "间接指令。",
        outputFlowContext: "间接指令应答数据。",
      },
      makeCtx(dir),
    )

    const result = JSON.parse(raw)
    expect(result.valid).toBe(true)
    expect(result.combined_translations[0].translate_status).toBe("success")
    expect(result.combined_translations[0].steps.map((step) => step.key_name)).toEqual(["发送CANA数据", "发送CANB数据"])
  })

  test("does not require CANA and CANB inside one case because counterpart coverage is suite-level", async () => {
    const dir = mkdtempSync(join(tmpdir(), "testcase-bus-check-"))

    const raw = await (testcaseFormatCheck as any).execute(
      {
        generated_text: JSON.stringify([
          {
            case_name: "发送指令",
            test_purpose: "验证双总线发送。",
            test_step: [
              {
                "步骤描述": "第10.8秒,通过CANA总线发送中继测控子系统与中继星1通信",
                "预期结果": "软件正确处理并输出可验证结果。",
              },
            ],
          },
        ]),
        input_dataset_ref: ".matrix/data/input-datasets/间接指令.json#normal-01",
        processingContext: "若接收到“中继测控子系统与中继星1星通信”间接指令，则设置缓变遥测书籍中中继星选型结果（W2b7-W2b4）为0x01。",
        requirementContext: "软件接收到间接指令后，通过总线（CANA或CANB）发送间接指令应答。",
        keyword_candidates: [
          {
            keywordName: "发送CANA数据",
            description: "第${time}秒,通过CANA总线${para3}发送${para2}",
            argumentNames: ["${time}", "${para1}", "${para2}", "${para3}"],
            argumentComments: ["执行时间", "参数1：ID", "参数2：数据协议名称", "参数3：循环时间"],
            txtSnippet: "",
          },
        ],
      },
      makeCtx(dir),
    )

    const result = JSON.parse(raw)
    expect(result.valid).toBe(true)
    expect(result.cases).toHaveLength(1)
    expect(result.structure_violations).toBeUndefined()
    expect(JSON.stringify(result.errors ?? [])).not.toContain("CANB")
  })

  test("accepts multiple functional cases split by function point (2026-09-14 修订:取消 1 主用例硬门禁)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "testcase-functional-scope-"))

    const raw = await (testcaseFormatCheck as any).execute(
      {
        generated_text: JSON.stringify([
          {
            case_name: "主功能校验1",
            test_purpose: "验证功能点1。",
            test_step: [
              {
                "步骤描述": "发送合法指令。",
                "预期结果": "系统正确响应。",
              },
            ],
          },
          {
            case_name: "主功能校验2",
            test_purpose: "验证功能点2。",
            test_step: [
              {
                "步骤描述": "发送另一条合法指令。",
                "预期结果": "系统正确响应。",
              },
            ],
          },
        ]),
        requirement_id: "TR-GN-JJZL-001",
        test_type_chinese: "功能测试",
      },
      makeCtx(dir),
    )

    const result = JSON.parse(raw)
    expect(result.valid).toBe(true)
    expect(result.cases).toHaveLength(2)
  })

  test("rejects deprecated requirements input and asks callers to use test-requirements.json file input", async () => {
    const dir = mkdtempSync(join(tmpdir(), "testcase-generator-run-unwrap-"))
    mkdirSync(dir, { recursive: true })
    writeTestRequirements(dir)

    const previousGeneratorPath = process.env.MATRIX_TESTCASE_GENERATOR_PATH
    process.env.MATRIX_TESTCASE_GENERATOR_PATH = dir
    try {
      const raw = await (testcaseGeneratorRun as any).execute(
        {
          requirements: { chapterTrList: {} },
        },
        makeCtx(dir),
      )

      const result = JSON.parse(raw)
      expect(result.error).toContain("只接受 test-requirements.json 文件输入")
      expect(result.items).toEqual([])
    } finally {
      process.env.MATRIX_TESTCASE_GENERATOR_PATH = previousGeneratorPath
    }
  })

  test("rejects deprecated chapter_tr_list input and asks callers to use file input", async () => {
    const dir = mkdtempSync(join(tmpdir(), "testcase-generator-run-inline-tree-"))
    mkdirSync(dir, { recursive: true })
    writeTestRequirements(dir)

    const raw = await (testcaseGeneratorRun as any).execute(
      {
        chapter_tr_list: makeTestRequirementsArtifact(),
      },
      makeCtx(dir),
    )

    const result = JSON.parse(raw)
    expect(result.error).toContain("不再接受 chapter_tr_list")
  })

  test("returns a clear error when the default test-requirements file is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "testcase-generator-run-missing-req-"))
    mkdirSync(dir, { recursive: true })

    const raw = await (testcaseGeneratorRun as any).execute({}, makeCtx(dir))
    const result = JSON.parse(raw)

    expect(result.error).toContain("test-requirements.json 不存在")
    expect(result.items).toEqual([])
  })
})

describe("接口类型专属分节按需注入(端到端)", () => {
  test("二级CAN 需求注入二级总线模型,一级需求不注入;manifest 记录 interface_sections", async () => {
    const dir = mkdtempSync(join(tmpdir(), "testcase-iface-sections-"))
    const previousGeneratorPath = process.env.MATRIX_TESTCASE_GENERATOR_PATH
    try {
      mkdirSync(join(dir, ".matrix", "config"), { recursive: true })
      writeFileSync(join(dir, ".matrix", "config", "matrix.jsonc"), JSON.stringify({ domain: "generic" }), "utf-8")
      writeTestRequirements(dir, {
        funItem: [
          {
            funId: ["TR-JK-001"],
            testType: "接口测试",
            titleNo: "4.3.1",
            title: "一级CAN校验",
            requirementContext: "软件通过一级CAN总线接收上位机指令。",
            inputFlowContext: "遥控指令。",
            processingContext: "TR-JK-001：通过CANA总线发送遥测帧1轮询控制序列，校验字段错误处理。",
            outputFlowContext: "应答数据。",
          },
          {
            funId: ["TR-JK-009"],
            testType: "接口测试",
            titleNo: "4.3.1",
            title: "二级CAN应答",
            requirementContext: "软件通过二级CAN总线与下位机通信。",
            inputFlowContext: "遥控指令应答。",
            processingContext: "TR-JK-009：通过二级CAN总线发送遥控指令后等待返回应答，应答错误则计数加1。",
            outputFlowContext: "遥测更新。",
          },
        ],
        softwareId: "SW-001",
        codeVersion: "V1.0",
      })
      writeMarkdownPromptCatalog(dir, {
        "接口测试-STEP-GENERATED": "需求 {tr_id}：{tr_handling}\n{{INTERFACE_SECTIONS}}",
        "TR-DG-STEP-GENERATED": "需求 {tr_id}：{tr_handling}",
      })
      // 接口分节文件
      const secDir = join(dir, "testcase-prompts", "interface-sections")
      mkdirSync(secDir, { recursive: true })
      writeFileSync(join(secDir, "primary-can.md"), "### 一级CAN帧规则(测试标记)\n帧数/字段错误/帧序号规则。", "utf-8")
      writeFileSync(join(secDir, "secondary-bus.md"), "### 二级总线测试模型(测试标记)\n触发→模拟应答→计数。", "utf-8")
      process.env.MATRIX_TESTCASE_GENERATOR_PATH = dir

      const result = JSON.parse(await (testcaseGeneratorRun as any).execute(
        { test_requirements_file: join(dir, ".matrix", "data", "test-requirements.json") },
        makeCtx(dir),
      ))
      expect(result.status).toBe("success")
      const manifest = readGenerationManifest(result)
      const byId = new Map(manifest.items.map((it: any) => [it.requirement_id, it]))
      const primaryPrompt: string = byId.get("TR-JK-001").prompt
      const secondaryPrompt: string = byId.get("TR-JK-009").prompt
      // 一级需求:注入一级帧规则,不注入二级总线模型
      expect(primaryPrompt).toContain("一级CAN帧规则(测试标记)")
      expect(primaryPrompt).not.toContain("二级总线测试模型")
      expect(byId.get("TR-JK-001").interface_sections).toEqual(["primary-can"])
      // 二级需求:两节都注入
      expect(secondaryPrompt).toContain("一级CAN帧规则(测试标记)")
      expect(secondaryPrompt).toContain("二级总线测试模型")
      expect(byId.get("TR-JK-009").interface_sections).toEqual(["primary-can", "secondary-bus"])
      // 标记本身不残留
      expect(primaryPrompt).not.toContain("{{INTERFACE_SECTIONS}}")
      expect(secondaryPrompt).not.toContain("{{INTERFACE_SECTIONS}}")
    } finally {
      if (previousGeneratorPath === undefined) delete process.env.MATRIX_TESTCASE_GENERATOR_PATH
      else process.env.MATRIX_TESTCASE_GENERATOR_PATH = previousGeneratorPath
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("testcase_format_check 非 persist 结构校验旁路封堵(2026-09-17)", () => {
  test("非 persist 路径同样返回 structure_violations:同指令双总线一案被拦截", async () => {
    const dir = mkdtempSync(join(tmpdir(), "testcase-format-check-nonpersist-gate-"))
    const previousCwd = process.cwd()
    process.chdir(dir)
    try {
      writeJson(join(dir, ".matrix", "data", "test-requirements.json"), {
        funItem: [
          { funId: ["TR-GN-TM-001"], testType: "功能测试", titleNo: "4.1.1", title: "轮询指令接收处理需求项[TR-GN-TM]" },
        ],
      })
      const raw = await (testcaseFormatCheck as any).execute(
        {
          generated_text: JSON.stringify([
            {
              case_name: "遥测帧1轮询控制序列处理测试",
              test_purpose: "验证遥测帧1轮询控制序列接收处理。",
              covered_tr_items: ["TR-GN-TM-001"],
              test_step: [
                { 步骤描述: "第3.0秒，通过CANA总线发送正确的遥测帧1轮询控制序列。", 预期结果: "软件更新遥测帧1参数。" },
                { 步骤描述: "第5.0秒，通过CANB总线发送正确的遥测帧1轮询控制序列。", 预期结果: "软件更新遥测帧1参数。" },
              ],
            },
          ]),
          requirement_id: "TR-GN-TM-001",
          test_type_chinese: "功能测试",
        },
        makeCtx(dir),
      )
      const result = JSON.parse(raw)
      expect(result.persisted).toBeUndefined()
      expect(result.structure_violations.some((v: any) => v.type === "mixed_bus")).toBe(true)
      expect(result.regroup_directive.length).toBeGreaterThan(0)
    } finally {
      process.chdir(previousCwd)
    }
  })
})

describe("testcase_generator_run 引用条款错误分支送达(2026-09-17)", () => {
  test("总线收发类功能需求组的生成提示注入其他需求组中同指令的错误处理条款", async () => {
    const dir = mkdtempSync(join(tmpdir(), "testcase-generator-run-refclauses-"))
    const previousGeneratorPath = process.env.MATRIX_TESTCASE_GENERATOR_PATH
    process.env.MATRIX_TESTCASE_GENERATOR_PATH = dir
    try {
      writeJson(join(dir, ".matrix", "data", "test-requirements.json"), {
        funItem: [
          {
            funId: ["TR-GN-TM-001", "TR-GN-TM-002"],
            testType: "功能测试",
            titleNo: "4.1.1",
            title: "轮询指令接收处理需求项[TR-GN-TM]",
            requirementContext: "软件接收4类遥测轮询指令。",
            inputFlowContext: "a.遥测帧1轮询控制序列；遥测帧2轮询控制序列。",
            processingContext: "TR-GN-TM-001：当软件通过一级CAN总线收到遥测帧1轮询控制序列时，则通过一级CAN总线向卫星星务发送遥测帧1参数。TR-GN-TM-002：当软件通过一级CAN总线收到遥测帧2轮询控制序列时，则通过一级CAN总线向卫星星务发送遥测帧2参数。",
          },
          {
            funId: ["TR-JK-001", "TR-JK-002"],
            testType: "接口测试",
            titleNo: "4.3.1",
            title: "接口需求项[TR-JK]",
            processingContext: "TR-JK-001：若通过一级CAN总线接收到遥测帧1~4轮询控制序列中仲裁场/控制场（即ID）错误，则丢弃相应帧。TR-JK-002：若接收到遥测帧1~4轮询控制序列中TITLE、SUM任一错误，则平台CAN格式错误计数加1。",
          },
        ],
      })
      const raw = await (testcaseGeneratorRun as any).execute({}, makeCtx(dir))
      const manifest = readGenerationManifest(JSON.parse(raw))
      const tm = manifest.items.find((it: any) => String(it.requirement_id).includes("TR-GN-TM"))
      const jk = manifest.items.find((it: any) => String(it.requirement_id).includes("TR-JK"))
      expect(tm.prompt).toContain("<referenced_error_clauses>")
      expect(tm.prompt).toContain("丢弃相应帧")
      expect(jk.prompt).not.toContain("<referenced_error_clauses>")
    } finally {
      process.env.MATRIX_TESTCASE_GENERATOR_PATH = previousGeneratorPath
    }
  })
})

describe("功能测试 CAN 接收协议结构规则送达(2026-09-20)", () => {
  test("轮询逐字段、两帧时间广播、双辅助数据包四步交错均进入各自生成提示", async () => {
    const dir = mkdtempSync(join(tmpdir(), "testcase-generator-run-functional-protocol-"))
    const previousGeneratorPath = process.env.MATRIX_TESTCASE_GENERATOR_PATH
    process.env.MATRIX_TESTCASE_GENERATOR_PATH = dir
    try {
      writeJson(join(dir, ".matrix", "config", "matrix.jsonc"), { domain: "satellite-dsp" })
      writeJson(join(dir, ".matrix", "data", "test-requirements.json"), {
        funItem: [
          {
            funId: ["TR-GN-TM-001"],
            testType: "功能测试",
            titleNo: "4.1.1",
            title: "轮询指令接收处理需求项[TR-GN-TM]",
            requirementContext: "软件接收遥测轮询指令。",
            processingContext: "收到遥测帧1轮询控制序列后发送遥测帧1参数。",
            inputFlowContext: "遥测帧1轮询控制序列格式：仲裁场、控制场、TITLE、功能字、SUM。",
          },
          {
            funId: ["TR-GN-TIME-001"],
            testType: "功能测试",
            titleNo: "4.1.2",
            title: "星务时间广播接收处理需求项[TR-GN-TIME]",
            requirementContext: "通过一级CAN总线接收星务时间广播数据。",
            processingContext: "收到正确的星务时间广播数据后转发，错误字段包括LENGTH、TITLE、INDEX、SUM。",
            inputFlowContext: "星务时间广播数据格式共2帧：首帧含LENGTH、TITLE，尾帧含SUM。",
          },
          {
            funId: ["TR-GN-FZSJ-001"],
            testType: "功能测试",
            titleNo: "4.1.3",
            title: "卫星服务系统辅助数据接收处理需求项[TR-GN-FZSJ]",
            requirementContext: "软件每秒通过一级CAN总线接收到2包辅助数据包。",
            processingContext: "正确包处理转发并使正确计数加1；错误包不处理。",
            inputFlowContext: "辅助数据包1为37帧；辅助数据包2为37帧。",
          },
          {
            funId: ["TR-GN-NCDC-001"],
            testType: "功能测试",
            titleNo: "4.1.4",
            title: "内存读出指令接收处理需求项[TR-GN-NCDC]",
            requirementContext: "内存读出地址范围0x10000000~0x1007FF14、0x40000000~0x401FFF14。",
            processingContext: "通过一级CAN总线收到内存读出指令，格式或地址错误则按错误指令处理。",
            inputFlowContext: "内存读出指令包含仲裁场、控制场、LENGTH、TITLE、INDEX、SUM和4字节绝对地址。",
          },
          {
            funId: ["TR-GN-NCZL-001"],
            testType: "功能测试",
            titleNo: "4.1.5",
            title: "内存数据轮询指令接收处理需求项[TR-GN-NCZL]",
            requirementContext: "通过一级CAN总线依次发送内存读出指令、内存数据轮询控制序列，两个间隔2s。",
            processingContext: "收到正确的内存数据轮询控制序列后返回内存读出数据。",
            inputFlowContext: "内存数据轮询控制序列包含仲裁场、控制场、TITLE、W0、W1、SUM。",
          },
        ],
      })

      const raw = await (testcaseGeneratorRun as any).execute({}, makeCtx(dir))
      const manifest = readGenerationManifest(JSON.parse(raw))
      const byId = new Map(manifest.items.map((item: any) => [item.requirement_id, item]))
      const polling = byId.get("TR-GN-TM-001").prompt as string
      const time = byId.get("TR-GN-TIME-001").prompt as string
      const auxiliary = byId.get("TR-GN-FZSJ-001").prompt as string
      const memoryRead = byId.get("TR-GN-NCDC-001").prompt as string
      const memoryPolling = byId.get("TR-GN-NCZL-001").prompt as string

      expect(polling).toContain("<functional_can_receive_protocol_rules>")
      expect(polling).toContain("逐字段/逐字节覆盖全部错误情况")
      expect(polling).toContain("仲裁场与控制场是两个独立字段")
      expect(time).toContain("完整2帧的正确星务时间广播数据")
      expect(time).toContain("2帧协议的6类帧序号错误")
      expect(time).toContain("2帧数据不存在中间帧")
      expect(auxiliary).toContain("正确包1→包1单字段错误")
      expect(auxiliary).toContain("最后以完整正确包n收尾")
      expect(auxiliary).toContain("剩余未覆盖错误逐项使用包n")
      expect(auxiliary).not.toContain("严格以4步为一组反复交错")
      expect(auxiliary).toContain("正确计数保持上一步绝对值")
      expect(memoryRead).toContain("非4字节对齐的地址本身就是错误指令")
      expect(memoryRead).toContain("下边界-1、下边界、下边界+1")
      expect(memoryRead).toContain("字段错误场景与地址边界场景分成两个独立用例")
      expect(memoryPolling).toContain("第3.0秒，通过当前总线以5秒为周期循环发送正确的内存读出指令")
      expect(memoryPolling).toContain("即5.0、10.0、15.0秒…")
      expect(memoryPolling).toContain("两者必须保留在同一用例")
    } finally {
      process.env.MATRIX_TESTCASE_GENERATOR_PATH = previousGeneratorPath
    }
  })
})

describe("testcase_generator_run strict test-family provenance", () => {
  for (const domain of ["generic", "satellite-dsp"]) {
    for (const projectType of ["software", "software_variant"]) {
      test(`${domain}/${projectType}: all supported types use their test-* file`, async () => {
        const dir = mkdtempSync(join(tmpdir(), "matrix-test-family-"))
        try {
          cpSync(join(import.meta.dir, "../../templates/testcase-prompts"), join(dir, "templates/testcase-prompts"), { recursive: true })
          writeJson(join(dir, ".matrix/config/matrix.jsonc"), { domain })
          const types = Object.keys(PHASE6_SOFTWARE_TEMPLATE_FILES)
          writeTestRequirements(dir, {
            ...makeTestRequirementsArtifact(),
            funItem: types.map((type, index) => ({
              ...makeTestRequirementsArtifact().funItem[0],
              funId: [`TR-${index + 1}`],
              testType: type,
              processingContext: "按需求检查输入处理与可观察输出，响应时间不超过需求规定的门限。",
            })),
          })
          const result = JSON.parse(await (testcaseGeneratorRun as any).execute({ project_type: projectType }, makeCtx(dir)))
          expect(result.status).toBe("success")
          const manifest = readGenerationManifest(result)
          expect(manifest.items).toHaveLength(types.length)
          for (const item of manifest.items) {
            expect(item.template_file).toBe(join(dir, "templates/testcase-prompts", PHASE6_SOFTWARE_TEMPLATE_FILES[item.test_type_chinese]))
            expect(item.template_domain).toBe(domain)
            expect(item.template_hash).toBe(createHash("sha256").update(readFileSync(item.template_file)).digest("hex"))
            expect(item.prompt).not.toMatch(/\{(?:title|requirementContext|processingContext)\}/)
            if (item.test_type_chinese === "性能测试" && domain === "satellite-dsp") {
              expect(item.prompt).toContain("<domain_knowledge>")
              expect(item.prompt).toContain("T2−T1")
              expect(item.template_file).toEndWith("/test-software-performance.md")
            } else {
              expect(item.prompt).not.toContain("<domain_knowledge>")
            }
          }
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
      })
    }
  }

  test("unknown later requirement is not converted to functional or allowed to leave partial output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "matrix-unknown-template-"))
    try {
      writeTestRequirements(dir, {
        ...makeTestRequirementsArtifact(),
        funItem: [makeTestRequirementsArtifact().funItem[0], {
          ...makeTestRequirementsArtifact().funItem[0], funId: ["TR-UNKNOWN-001"], testType: "未知类型测试",
        }],
      })
      const published = join(dir, ".matrix/reports/test-cases.md")
      mkdirSync(dirname(published), { recursive: true })
      writeFileSync(published, "last publication")
      const result = JSON.parse(await (testcaseGeneratorRun as any).execute({}, makeCtx(dir)))
      expect(result.status).toBe("error")
      expect(result.error).toContain("TR-UNKNOWN-001")
      expect(result.error).toContain("未知类型测试")
      expect(readFileSync(published, "utf8")).toBe("last publication")
      expect(existsSync(join(dir, ".matrix/data/phase6-generation-items.json"))).toBe(false)
      expect(existsSync(join(dir, ".matrix/data/phase6-worker-prompts"))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("review consumes the actual generation manifest and blocks subsequent template drift", async () => {
    const dir = mkdtempSync(join(tmpdir(), "matrix-template-review-integration-"))
    try {
      cpSync(join(import.meta.dir, "../../templates/testcase-prompts"), join(dir, "templates/testcase-prompts"), { recursive: true })
      writeTestRequirements(dir)
      const generated = JSON.parse(await (testcaseGeneratorRun as any).execute({}, makeCtx(dir)))
      expect(generated.status).toBe("success")
      writeJson(join(dir, ".matrix/data/confirmation-tests.json"), {
        project_name: "Template provenance test", version: "1.0", created_date: "2026-09-21", test_cases: [],
        traceability: [], summary: { total_cases: 0, by_type: {} },
      })
      const review = async () => JSON.parse(await (phase6CaseReviewPrepare as any).execute({}, makeCtx(dir)))
      const original = await review()
      expect(original.status).toBe("success")
      expect(original.candidate_issues.filter((issue: any) => issue.category.startsWith("template_") && issue.severity === "blocking")).toHaveLength(0)
      const templatePath = readGenerationManifest(generated).items[0].template_file
      writeFileSync(templatePath, readFileSync(templatePath, "utf8") + "\n<!-- edited after generation -->\n")
      const drifted = await review()
      expect(drifted.candidate_issues.some((issue: any) => issue.category === "template_provenance" && issue.severity === "blocking" && issue.description.includes("template_hash"))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("testcase_generator_run 兜底 markdown 模板体走 markdown 替换器(2026-09-18 取证)", () => {
  test("项目无 catalog 时兜底解析出的 test-functional.md 占位符被实际值替换,不再裸奔", async () => {
    const dir = mkdtempSync(join(tmpdir(), "testcase-generator-run-fallback-md-"))
    const previousGeneratorPath = process.env.MATRIX_TESTCASE_GENERATOR_PATH
    process.env.MATRIX_TESTCASE_GENERATOR_PATH = dir
    try {
      writeJson(join(dir, ".matrix", "data", "test-requirements.json"), {
        funItem: [
          {
            funId: ["TR-GN-TM-001"],
            testType: "功能测试",
            titleNo: "4.1.1",
            title: "轮询指令接收处理需求项[TR-GN-TM]",
            requirementContext: "软件接收4类遥测轮询指令。",
            inputFlowContext: "a.遥测帧1轮询控制序列；遥测帧2轮询控制序列。",
            processingContext: "TR-GN-TM-001：当软件通过一级CAN总线收到遥测帧1轮询控制序列时，则通过一级CAN总线向卫星星务发送遥测帧1参数。",
          },
        ],
      })
      // 无 testcase-prompts 目录、无 legacy prompt_templates.json:
      // loadPhase6PromptTemplates 兜底返回内置/markdown 模板体
      const raw = await (testcaseGeneratorRun as any).execute({}, makeCtx(dir))
      const manifest = readGenerationManifest(JSON.parse(raw))
      const tm = manifest.items.find((it: any) => String(it.requirement_id).includes("TR-GN-TM"))
      // 输入信息六个占位符全部被实际值替换
      expect(tm.prompt).not.toContain("{title}")
      expect(tm.prompt).not.toContain("{requirementContext}")
      expect(tm.prompt).toContain("轮询指令接收处理需求项[TR-GN-TM]")
      expect(tm.prompt).toContain("软件接收4类遥测轮询指令。")
      // 不追加“### 补充上下文”(那是 legacy 路径的补丁带)
      expect(tm.prompt).not.toContain("### 补充上下文")
    } finally {
      process.env.MATRIX_TESTCASE_GENERATOR_PATH = previousGeneratorPath
    }
  })
})
