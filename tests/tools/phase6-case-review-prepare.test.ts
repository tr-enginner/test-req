import { describe, expect, test } from "bun:test"
import { createHash } from "crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { dirname, join } from "path"
import { phase6CaseReviewPrepare } from "../../src/tools"

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2), "utf-8")
}

function makeCtx(directory: string) {
  return {
    sessionID: "sid-1",
    messageID: "mid-1",
    agent: "reviewer",
    directory,
    worktree: directory,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  }
}

function writeTestRequirements(root: string) {
  writeJson(join(root, ".matrix", "data", "test-requirements.json"), {
    funItem: [
      {
        funId: ["TR-GN-JJZL-001"],
        test_type: "功能测试",
        titleNo: "4.1.2",
        title: "总线间接指令需求项",
        requirementContext: "软件接收到间接指令后，对指令进行解析处理。若软件接收到间接指令，则通过总线（CANA或CANB）发送间接指令应答，将数传下位机指令计数加1（即缓变遥测数据W2b3~W2b1），否则不处理接受到的数据",
        inputFlowContext: "间接指令。",
        processingContext: "若接收到“中继测控子系统与中继星1星通信”间接指令，则设置缓变遥测书籍中中继星选型结果（W2b7-W2b4）为0x01。",
        outputFlowContext:
          "a. 间接指令应答数据；\nb. 缓变遥测数据；\nc. 硬件输出状态量（转发总线的间接指令、写入波束指向角数据、CAN总线硬件复位）。",
      },
      {
        funId: ["TR-GN-JJZL-002"],
        test_type: "功能测试",
        titleNo: "4.1.3",
        title: "第二条功能需求",
        requirementContext: "第二条需求背景。",
        processingContext: "第二条功能点。",
      },
    ],
    softwareId: "SW-001",
    codeVersion: "V1.0",
  })
}

function writePromptCatalog(root: string) {
  const catalogDir = join(root, "templates", "testcase-prompts")
  mkdirSync(catalogDir, { recursive: true })
  writeJson(join(catalogDir, "index.json"), {
    version: 1,
    templates: [
      {
        key: "test-功能测试-STEP-GENERATED",
        file: "test-functional.md",
        match: {
          project_types: ["software", "software_variant"],
          test_types: ["功能测试"],
        },
        priority: 20,
      },
      {
        key: "TR-DG-STEP-GENERATED",
        file: "software-default.md",
        match: {
          project_types: ["software", "software_variant"],
        },
        fallback: true,
        priority: 10,
      },
    ],
  })
  writeFileSync(
    join(catalogDir, "test-functional.md"),
    [
      "# 软件功能测试模板",
      "",
      "## 提示词正文",
      "```prompt",
      "### 通用生成规则",
      "- 只输出严格 JSON 数组。",
      "- `步骤描述`写人工操作，`预期结果`写可观察、可验证结果。",
      "",
      "### 类型专属规则",
      "- 按功能点划分用例：每个独立功能点一个用例，同一功能点的多种情况在同一用例多步骤覆盖。",
      "- 只验证需求明确描述的功能点，不自动扩展边界或异常场景。",
      "```",
      "",
    ].join("\n"),
    "utf-8",
  )
  writeFileSync(
    join(catalogDir, "software-default.md"),
    [
      "# 软件通用模板",
      "",
      "## 提示词正文",
      "```prompt",
      "### 通用生成规则",
      "- 只输出严格 JSON 数组。",
      "",
      "### 类型专属规则",
      "- 仅围绕当前 requirement 生成。",
      "```",
      "",
    ].join("\n"),
    "utf-8",
  )
}

function writeConfirmationSuite(root: string) {
  writeJson(join(root, ".matrix", "data", "source-confirmation-tests.json"), {
    project_name: "Matrix",
    version: "1.0",
    created_date: "2026-04-22",
    test_cases: [
      {
        case_name: "中继星选型结果设置测试",
        test_environment: "软平台测试环境",
        test_purpose: "中继星选型结果设置测试。",
        correspond_fun_id: "TR-GN-JJZL-001",
        case_id: "TC-GN-JJZL-001",
        test_type: "功能测试",
        path: "/wrong/path/",
        constraints: "无",
        initial_settings: "无",
        test_input: "无",
        test_step: [
          {
            key_name: "发送CANA数据",
            step_desc: "第${time}秒,通过CANA总线发送中继测控子系统与中继星1通信间接指令。",
            parameter: [],
            source_step_desc: "第${time}秒,通过CANA总线发送中继测控子系统与中继星1通信间接指令。",
            expected_result: "软件正确处理。",
            expected_key_name: "保留",
            source_expected_key_name: "保留",
            expected_parameter: [],
            is_startup_step: false,
          },
        ],
        assess_criteria: "实际结果与预期结果一致",
        cease_condition:
          "Z1：测试用例按照所设计的操作步骤完成，测试正常终止；Z2：测试用例不能按照所设计的操作步骤完成，测试异常终止。",
        related_software_req_ids: ["SRS-WRONG-001"],
        translate_status: "success",
      },
    ],
    traceability: [],
    summary: {
      total_cases: 1,
      by_type: {
        功能测试: 1,
      },
    },
  })
}

function writeTemplateProvenance(root: string, domain = "generic") {
  const templateFile = join(root, "templates", "testcase-prompts", "test-functional.md")
  const manifest = {
    template_provenance_version: 1,
    domain,
    test_requirements_file: join(root, ".matrix", "data", "test-requirements.json"),
    project_type: "software",
    items: ["TR-GN-JJZL-001", "TR-GN-JJZL-002"].map((requirement_id) => ({
      requirement_id,
      project_type: "software",
      template_key: "test-功能测试-STEP-GENERATED",
      template_source: "markdown",
      template_file: templateFile,
      template_hash: createHash("sha256").update(readFileSync(templateFile)).digest("hex"),
      template_index_file: join(root, "templates", "testcase-prompts", "index.json"),
      template_domain: domain,
      template_selection_reason: "software test-type template",
    })),
  }
  writeJson(join(root, ".matrix", "data", "phase6-generation-items.json"), manifest)
  return manifest
}

function makeProvenanceProject(domain = "generic") {
  const dir = mkdtempSync(join(tmpdir(), "phase6-review-provenance-"))
  writeTestRequirements(dir)
  writePromptCatalog(dir)
  writeConfirmationSuite(dir)
  writeJson(join(dir, ".matrix", "config", "matrix.jsonc"), { domain })
  writeTemplateProvenance(dir, domain)
  return dir
}

async function reviewProject(dir: string, overrides: Record<string, unknown> = {}) {
  const result = JSON.parse(await (phase6CaseReviewPrepare as any).execute(
    { confirmation_tests_file: join(dir, ".matrix", "data", "source-confirmation-tests.json"), ...overrides },
    makeCtx(dir),
  ))
  const prepared = JSON.parse(readFileSync(result.prepared_file, "utf-8"))
  return { result, prepared }
}

describe("phase6CaseReviewPrepare", () => {
  test.each(["generic", "satellite-dsp"])("verifies versioned template provenance with domain %s", async (domain) => {
    const dir = makeProvenanceProject(domain)
    const { result, prepared } = await reviewProject(dir)
    expect(result.status).toBe("success")
    expect(result.counts.template_provenance_failures).toBe(0)
    expect(result.counts.template_resolution_failures).toBe(0)
    expect(prepared.template_baselines[0]).toMatchObject({
      template_key: "test-功能测试-STEP-GENERATED",
      template_file: join(dir, "templates", "testcase-prompts", "test-functional.md"),
      template_index_file: join(dir, "templates", "testcase-prompts", "index.json"),
      template_domain: domain,
    })
    expect(prepared.template_baselines[0].template_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(prepared.candidate_issues.some((issue: any) => issue.category.startsWith("template_"))).toBe(false)
  })

  test("blocks a template file change outside the prompt block", async () => {
    const dir = makeProvenanceProject()
    const file = join(dir, "templates", "testcase-prompts", "test-functional.md")
    writeFileSync(file, `${readFileSync(file, "utf-8")}\n修改后的专家说明。\n`, "utf-8")
    const { result, prepared } = await reviewProject(dir)
    expect(result.status).toBe("success")
    expect(result.counts.template_provenance_failures).toBe(2)
    expect(prepared.candidate_issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "blocking", category: "template_provenance", description: expect.stringContaining("template_hash") }),
    ]))
  })

  test.each([
    ["template_key", "different-template"],
    ["template_file", "/different/template.md"],
    ["template_index_file", "/different/index.json"],
    ["template_source", "legacy"],
    ["template_domain", "satellite-dsp"],
  ])("blocks recorded %s drift", async (field, value) => {
    const dir = makeProvenanceProject()
    const manifest = writeTemplateProvenance(dir)
    ;(manifest.items[0] as Record<string, unknown>)[field!] = value
    writeJson(join(dir, ".matrix", "data", "phase6-generation-items.json"), manifest)
    const { prepared } = await reviewProject(dir)
    expect(prepared.candidate_issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "blocking", category: "template_provenance", description: expect.stringContaining(field!) }),
    ]))
  })

  test("blocks missing, duplicate, and incomplete per-requirement provenance records", async () => {
    for (const kind of ["missing", "duplicate", "incomplete"] as const) {
      const dir = makeProvenanceProject()
      const manifest = writeTemplateProvenance(dir)
      if (kind === "missing") manifest.items.pop()
      if (kind === "duplicate") manifest.items.push({ ...manifest.items[0]! })
      if (kind === "incomplete") delete (manifest.items[0] as Record<string, unknown>).template_hash
      writeJson(join(dir, ".matrix", "data", "phase6-generation-items.json"), manifest)
      const { prepared } = await reviewProject(dir)
      expect(prepared.candidate_issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ severity: "blocking", category: "template_provenance" }),
      ]))
    }
  })

  test("blocks a changed project domain even when the software template stays the same", async () => {
    const dir = makeProvenanceProject()
    writeJson(join(dir, ".matrix", "config", "matrix.jsonc"), { domain: "satellite-dsp" })
    const { prepared } = await reviewProject(dir)
    expect(prepared.candidate_issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "blocking", category: "template_provenance", description: expect.stringContaining("domain") }),
    ]))
    expect(prepared.template_baselines[0].template_domain).toBe("satellite-dsp")
  })

  test("blocks using the same requirement IDs from a different requirements file", async () => {
    const dir = makeProvenanceProject()
    const alternativePath = join(dir, ".matrix", "data", "alternative-requirements.json")
    const requirements = JSON.parse(readFileSync(join(dir, ".matrix", "data", "test-requirements.json"), "utf-8"))
    writeJson(alternativePath, requirements)
    const { prepared } = await reviewProject(dir, { test_requirements_file: alternativePath })
    expect(prepared.candidate_issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "blocking", category: "template_provenance", description: expect.stringContaining("test_requirements_file") }),
    ]))
  })

  test("normalizes project-relative requirements paths when checking provenance", async () => {
    const dir = makeProvenanceProject()
    const manifest = writeTemplateProvenance(dir)
    manifest.test_requirements_file = ".matrix/data/test-requirements.json"
    writeJson(join(dir, ".matrix", "data", "phase6-generation-items.json"), manifest)
    const { result } = await reviewProject(dir, { test_requirements_file: ".matrix/data/./test-requirements.json" })
    expect(result.counts.template_provenance_failures).toBe(0)
  })

  test("blocks a project type change even when software and software_variant share a template", async () => {
    const dir = makeProvenanceProject()
    const { prepared } = await reviewProject(dir, { project_type: "software_variant" })
    expect(prepared.template_baselines[0].template_key).toBe("test-功能测试-STEP-GENERATED")
    expect(prepared.candidate_issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "blocking", category: "template_provenance", description: expect.stringContaining("project_type") }),
    ]))
  })

  test.each(["test_requirements_file", "project_type"])("requires version 1 manifest top-level %s", async (field) => {
    const dir = makeProvenanceProject()
    const manifest = writeTemplateProvenance(dir)
    delete (manifest as Record<string, unknown>)[field]
    writeJson(join(dir, ".matrix", "data", "phase6-generation-items.json"), manifest)
    const { prepared } = await reviewProject(dir)
    expect(prepared.candidate_issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "blocking", category: "template_provenance", description: expect.stringContaining(field) }),
    ]))
  })

  test("also binds each requirement provenance entry to the project type", async () => {
    const dir = makeProvenanceProject()
    const manifest = writeTemplateProvenance(dir)
    manifest.items[0]!.project_type = "software_variant"
    writeJson(join(dir, ".matrix", "data", "phase6-generation-items.json"), manifest)
    const { prepared } = await reviewProject(dir)
    expect(prepared.candidate_issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "blocking", category: "template_provenance", description: expect.stringContaining("project_type"), sample_ids: ["TR-GN-JJZL-001"] }),
    ]))
  })

  test("keeps old manifests reviewable with an explicit unverified-provenance warning", async () => {
    const dir = makeProvenanceProject()
    writeJson(join(dir, ".matrix", "data", "phase6-generation-items.json"), { items: [] })
    const { prepared } = await reviewProject(dir)
    expect(prepared.warnings.some((warning: string) => warning.includes("旧版本") && warning.includes("无模板来源可验证"))).toBe(true)
    expect(prepared.candidate_issues.some((issue: any) => issue.severity === "blocking" && issue.category.startsWith("template_"))).toBe(false)
  })

  test("reports malformed provenance manifests as blocking instead of treating them as legacy", async () => {
    const dir = makeProvenanceProject()
    writeFileSync(join(dir, ".matrix", "data", "phase6-generation-items.json"), "{broken", "utf-8")
    const { prepared } = await reviewProject(dir)
    expect(prepared.candidate_issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "blocking", category: "template_provenance" }),
    ]))
  })

  test.each(["missing-template", "invalid-index"])("returns a blocking review result for %s without throwing", async (kind) => {
    const dir = makeProvenanceProject()
    const catalog = join(dir, "templates", "testcase-prompts")
    if (kind === "missing-template") unlinkSync(join(catalog, "test-functional.md"))
    else writeFileSync(join(catalog, "index.json"), "{broken", "utf-8")
    const { prepared } = await reviewProject(dir)
    expect(prepared.candidate_issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "blocking", category: "template_resolution" }),
    ]))
    expect(prepared.template_baselines[0].template_source).toBe("unresolved")
  })

  test("maps the timing requirement alias to the timing review template", async () => {
    const dir = makeProvenanceProject()
    const requirementsFile = join(dir, ".matrix", "data", "test-requirements.json")
    const requirements = JSON.parse(readFileSync(requirementsFile, "utf-8"))
    requirements.funItem[0].test_type = "timing"
    writeJson(requirementsFile, requirements)
    const catalog = join(dir, "templates", "testcase-prompts")
    const indexFile = join(catalog, "index.json")
    const index = JSON.parse(readFileSync(indexFile, "utf-8"))
    index.templates.push({ key: "test-时序测试-STEP-GENERATED", file: "test-timing.md", match: { project_types: ["software"], test_types: ["时序测试"] } })
    writeJson(indexFile, index)
    writeFileSync(join(catalog, "test-timing.md"), "```prompt\n### 类型专属规则\n- 验证时间约束。\n```\n", "utf-8")
    // Historical provenance should not mask the alias test with unrelated drift.
    writeJson(join(dir, ".matrix", "data", "phase6-generation-items.json"), { items: [] })
    const { prepared } = await reviewProject(dir)
    expect(prepared.template_baselines).toEqual(expect.arrayContaining([
      expect.objectContaining({ test_type: "时序测试", template_key: "test-时序测试-STEP-GENERATED", template_source: "markdown" }),
    ]))
  })

  test("builds a compact prepared review artifact from requirements and confirmation tests", async () => {
    const dir = mkdtempSync(join(tmpdir(), "phase6-review-prepare-"))
    writeTestRequirements(dir)
    writePromptCatalog(dir)
    writeConfirmationSuite(dir)

    const raw = await (phase6CaseReviewPrepare as any).execute(
      { confirmation_tests_file: join(dir, ".matrix", "data", "source-confirmation-tests.json") },
      makeCtx(dir),
    )
    const result = JSON.parse(raw)

    expect(result.status).toBe("success")
    expect(result.summary.total_requirements).toBe(2)
    expect(result.summary.total_cases).toBe(1)
    expect(result.counts.uncovered_requirements).toBe(1)
    expect(result.counts.path_mismatches).toBe(1)
    expect(result.counts.related_requirement_mismatches).toBe(1)
    expect(result.counts.unresolved_placeholders).toBe(1)
    expect(result.counts.semantic_validation_failures).toBe(2)
    expect(result.template_baselines).toEqual([
      {
        test_type: "功能测试",
        template_key: "test-功能测试-STEP-GENERATED",
        template_source: "markdown",
      },
    ])
    expect(typeof result.prepared_file).toBe("string")
    expect(existsSync(result.prepared_file)).toBe(true)

    const prepared = JSON.parse(readFileSync(result.prepared_file, "utf-8"))
    expect(prepared.status).toBe("success")
    expect(prepared.coverage.uncovered_requirement_ids).toEqual(["TR-GN-JJZL-002"])
    expect(prepared.path_mismatches[0]).toEqual({
      case_id: "TC-GN-JJZL-001",
      correspond_fun_id: "TR-GN-JJZL-001",
      expected_path: "/4/1/2/",
      actual_path: "/wrong/path/",
    })
    expect(prepared.related_requirement_mismatches[0].expected_ids).toEqual(["TR-GN-JJZL-001"])
    expect(prepared.related_requirement_mismatches[0].actual_ids).toEqual(["SRS-WRONG-001"])
    expect(prepared.unresolved_placeholders[0]).toEqual({
      case_id: "TC-GN-JJZL-001",
      correspond_fun_id: "TR-GN-JJZL-001",
      location: "TC-GN-JJZL-001.test_step[0]",
      placeholders: ["${time}"],
    })
    expect(prepared.warnings.some((item: string) => item.includes("非阻断"))).toBe(true)
    expect(prepared.warnings.some((item: string) => item.includes("无模板来源可验证"))).toBe(true)
    expect(prepared.semantic_validation_failures[0].errors.some((item: string) => item.includes("间接指令应答数据"))).toBe(true)
    expect(
      prepared.semantic_validation_failures.some((failure: { errors: string[] }) =>
        failure.errors.some((item) => item.includes("缺少 CANB 对应的独立用例")),
      ),
    ).toBe(true)
    expect(prepared.candidate_issues.map((item: { category: string }) => item.category)).toEqual(
      expect.arrayContaining([
        "coverage_completeness",
        "path_traceability",
        "related_requirement_traceability",
        "explicit_output_verification",
      ]),
    )
    expect(prepared.candidate_issues.map((item: { category: string }) => item.category)).not.toContain("executability")
  })

  test("returns a compact blocking result when source-confirmation-tests schema is invalid", async () => {
    const dir = mkdtempSync(join(tmpdir(), "phase6-review-prepare-invalid-"))
    writeTestRequirements(dir)
    writeJson(join(dir, ".matrix", "data", "source-confirmation-tests.json"), {
      project_name: "Matrix",
      version: "1.0",
      created_date: "2026-04-22",
      test_cases: [
        {
          case_name: "坏用例",
          test_environment: "软平台测试环境",
          test_purpose: "坏用例。",
          correspond_fun_id: "TR-GN-JJZL-001",
          case_id: "TC-GN-JJZL-001",
          test_type: "功能测试",
          translate_status: "success",
          test_step: [],
        },
      ],
      traceability: [],
      summary: {
        total_cases: 1,
        by_type: {
          功能测试: 1,
        },
      },
    })

    const raw = await (phase6CaseReviewPrepare as any).execute(
      { confirmation_tests_file: join(dir, ".matrix", "data", "source-confirmation-tests.json") },
      makeCtx(dir),
    )
    const result = JSON.parse(raw)

    expect(result.status).toBe("error")
    expect(result.candidate_issues[0].category).toBe("artifact_validation")
    expect(typeof result.prepared_file).toBe("string")

    const prepared = JSON.parse(readFileSync(result.prepared_file, "utf-8"))
    expect(prepared.status).toBe("error")
    expect(prepared.errors.some((item: string) => item.includes("test_cases.0.test_step"))).toBe(true)
  })
})
