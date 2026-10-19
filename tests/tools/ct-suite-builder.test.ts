import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { dirname, join } from "path"
import {
  ctSuiteAddCase,
  ctSuiteCreate,
  ctSuiteFinalize,
  finalizeConfirmationSuiteData,
  persistPhase6ConfirmationSuite,
} from "../../src/tools/ct-suite-builder"

function makeSteps() {
  return [
    {
      步骤描述: "执行测试步骤。",
      预期结果: "系统输出正确结果。",
    },
  ]
}

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2), "utf-8")
}

function writeRequirementsArtifact(dir: string) {
  writeJson(join(dir, ".matrix", "data", "test-requirements.json"), {
    chapterTrList: {
      titleNo: "4",
      title: "测试类型说明",
      level: 1,
      funItem: [],
      children: [
        {
          titleNo: "4.1",
          title: "功能测试",
          level: 2,
          funItem: [],
          children: [
            {
              titleNo: "4.1.2",
              title: "初始化需求",
              content: "初始化背景。",
              level: 3,
              funItem: [
                {
                  funId: "TR-GN-INIT-001",
                  handling: "初始化功能点一。",
                  name: "初始化需求1",
                  priority: "high",
                  sufficiency: "",
                  testMethod: "",
                  passCriteria: "",
                },
                {
                  funId: "TR-GN-INIT-002",
                  handling: "初始化功能点二。",
                  name: "初始化需求2",
                  priority: "high",
                  sufficiency: "",
                  testMethod: "",
                  passCriteria: "",
                },
              ],
              children: null,
            },
            {
              titleNo: "4.1.3",
              title: "通信需求",
              content: "通信背景。",
              level: 3,
              funItem: [
                {
                  funId: "TR-GN-COMM-001",
                  handling: "通信功能点。",
                  name: "通信需求1",
                  priority: "high",
                  sufficiency: "",
                  testMethod: "",
                  passCriteria: "",
                },
              ],
              children: null,
            },
          ],
        },
      ],
    },
  })
}

function writeKeywordLibrary(dir: string) {
  writeJson(join(dir, ".matrix", "data", "DTPProject", "组合关键字", "Demo.json"), {
    Items: [
      {
        Name: "启动软平台",
        Comments: "启动软平台",
        Arguments: [],
      },
      {
        Name: "执行测试步骤",
        Comments: "执行测试步骤",
        Arguments: [],
      },
    ],
  })
}

describe("ct-suite-builder", () => {
  test("canonicalizes case ids by full category key and overrides path from chapter titleNo", async () => {
    const previousCwd = process.cwd()
    const dir = mkdtempSync(join(tmpdir(), "ct-suite-builder-"))
    process.chdir(dir)

    try {
      writeRequirementsArtifact(dir)

      await (ctSuiteCreate as any).execute({
        project_name: "Matrix",
        version: "1.0",
      })

      const first = JSON.parse(
        await (ctSuiteAddCase as any).execute({
          case_id: "TR-GN-INIT-001-TC01",
          case_name: "功能校验1",
          test_purpose: "验证功能点。",
          correspond_fun_id: "TR-GN-INIT-001",
          test_type: "功能测试",
          test_step: makeSteps(),
          path: "/wrong/path/",
        }),
      )
      const second = JSON.parse(
        await (ctSuiteAddCase as any).execute({
          case_id: "TR-GN-INIT-001-TC02",
          case_name: "功能校验2",
          test_purpose: "验证功能点。",
          correspond_fun_id: "TR-GN-INIT-001",
          test_type: "功能测试",
          test_step: makeSteps(),
        }),
      )
      const third = JSON.parse(
        await (ctSuiteAddCase as any).execute({
          case_id: "TR-GN-INIT-002-TC01",
          case_name: "功能校验3",
          test_purpose: "验证功能点。",
          correspond_fun_id: "TR-GN-INIT-002",
          test_type: "功能测试",
          test_step: makeSteps(),
        }),
      )
      const fourth = JSON.parse(
        await (ctSuiteAddCase as any).execute({
          case_id: "TR-GN-COMM-001-TC01",
          case_name: "通信校验1",
          test_purpose: "验证通信点。",
          correspond_fun_id: "TR-GN-COMM-001",
          test_type: "功能测试",
          test_step: makeSteps(),
        }),
      )

      expect(first.case_id).toBe("TC-GN-INIT-001")
      expect(second.case_id).toBe("TC-GN-INIT-002")
      expect(third.case_id).toBe("TC-GN-INIT-003")
      expect(fourth.case_id).toBe("TC-GN-COMM-001")
      expect(first.warning).toContain("TC-GN-INIT-001")
      expect(first.path_warning).toContain("/4/1/2/")

      const suitePath = join(dir, ".matrix", "data", "source-confirmation-tests.json")
      expect(existsSync(suitePath)).toBe(true)

      const suite = JSON.parse(readFileSync(suitePath, "utf-8"))
      expect(suite.test_cases.map((item: { case_id: string }) => item.case_id)).toEqual([
        "TC-GN-INIT-001",
        "TC-GN-INIT-002",
        "TC-GN-INIT-003",
        "TC-GN-COMM-001",
      ])
      expect(suite.test_cases[0].path).toBe("/4/1/2/")
      expect(Array.isArray(suite.test_cases[0].test_step)).toBe(true)
    } finally {
      process.chdir(previousCwd)
    }
  })

  test("injects the soft-platform startup step once during single-case persistence", async () => {
    const previousCwd = process.cwd()
    const dir = mkdtempSync(join(tmpdir(), "ct-suite-builder-soft-platform-"))
    process.chdir(dir)

    try {
      writeRequirementsArtifact(dir)

      await (ctSuiteCreate as any).execute({
        project_name: "Matrix",
        version: "1.0",
      })

      await (ctSuiteAddCase as any).execute({
        case_id: "TR-GN-INIT-001-TC01",
        case_name: "功能校验1",
        test_purpose: "验证功能点。",
        correspond_fun_id: "TR-GN-INIT-001",
        test_type: "功能测试",
        test_step: makeSteps(),
      })

      await (ctSuiteAddCase as any).execute({
        case_id: "TR-GN-INIT-001-TC02",
        case_name: "功能校验2",
        test_purpose: "验证功能点。",
        correspond_fun_id: "TR-GN-INIT-001",
        test_type: "功能测试",
        test_step: [
          {
            步骤描述: "启动软平台。",
            预期结果: "软件正常运行。",
          },
          ...makeSteps(),
        ],
      })

      const suite = JSON.parse(readFileSync(join(dir, ".matrix", "data", "source-confirmation-tests.json"), "utf-8"))
      expect(suite.test_cases[0].test_environment).toBe("软平台测试环境")
      expect(suite.test_cases[0].test_step[0]).toEqual({
        步骤描述: "启动软平台。",
        预期结果: "软件正常运行。",
      })
      expect(suite.test_cases[0].test_step[1]).toEqual(makeSteps()[0])
      expect(suite.test_cases[1].test_step[0]).toEqual({
        步骤描述: "启动软平台。",
        预期结果: "软件正常运行。",
      })
      expect(
        suite.test_cases[1].test_step.filter((step: { 步骤描述: string }) => step.步骤描述 === "启动软平台。"),
      ).toHaveLength(1)
    } finally {
      process.chdir(previousCwd)
    }
  })

  test("injects soft-platform startup step for batch persistence and skips hardware mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ct-suite-builder-phase6-persist-"))
    writeRequirementsArtifact(dir)
    writeKeywordLibrary(dir)

    const softwareSuite = await persistPhase6ConfirmationSuite({
      projectDir: dir,
      project_name: "Matrix",
      version: "1.0",
      requirement_cases: [
        {
          requirement_id: "TR-GN-INIT-001",
          test_type: "功能测试",
          source_requirement_ids: ["SRS-001"],
          cases: [
            {
              case_name: "软件环境用例",
              test_purpose: "验证功能点。",
              test_step: makeSteps(),
              test_environment: "软平台测试环境",
              initial_settings: "无",
              test_input: "无",
              constraints: "无",
              assess_criteria: "实际结果与预期结果一致。",
              cease_condition: "测试终止。",
            },
          ],
        },
      ],
      test_environment_mode: "software",
    })

    expect(softwareSuite.persisted_case_count).toBe(1)
    expect(softwareSuite.suite_file).toBe(".matrix/data/source-confirmation-tests.json")
    expect(softwareSuite.source_suite_file).toBe(".matrix/data/source-confirmation-tests.json")
    expect(softwareSuite.translated_suite_file).toBe(".matrix/data/confirmation-tests.json")
    expect(softwareSuite.todo_file).toBe(".matrix/data/test-cases-todo.txt")
    expect(softwareSuite.todo_case_count).toBe(1)
    expect(existsSync(join(dir, softwareSuite.source_suite_file))).toBe(true)
    expect(existsSync(join(dir, softwareSuite.translated_suite_file))).toBe(true)
    expect(readFileSync(join(dir, softwareSuite.todo_file), "utf-8").trim()).toBe("TC-GN-INIT-001")
    expect(softwareSuite.suite.test_cases[0].test_step[0]).toEqual({
      步骤描述: "启动软平台。",
      预期结果: "软件正常运行。",
    })

    const translatedSuite = JSON.parse(readFileSync(join(dir, softwareSuite.translated_suite_file), "utf-8"))
    expect(translatedSuite.test_cases[0].test_step).toHaveLength(1)
    expect(translatedSuite.test_cases[0].test_step[0]).toEqual({
      key_name: "执行测试步骤",
      step_desc: "执行测试步骤",
      parameter: [],
      expected_result: "系统输出正确结果",
    })

    const hardwareDir = mkdtempSync(join(tmpdir(), "ct-suite-builder-phase6-persist-hw-"))
    writeRequirementsArtifact(hardwareDir)
    writeKeywordLibrary(hardwareDir)
    const hardwareSuite = await persistPhase6ConfirmationSuite({
      projectDir: hardwareDir,
      project_name: "Matrix",
      version: "1.0",
      requirement_cases: [
        {
          requirement_id: "TR-GN-INIT-001",
          test_type: "功能测试",
          source_requirement_ids: ["SRS-001"],
          cases: [
            {
              case_name: "硬平台环境用例",
              test_purpose: "验证功能点。",
              test_step: makeSteps(),
              test_environment: "硬平台测试环境",
              initial_settings: "无",
              test_input: "无",
              constraints: "无",
              assess_criteria: "实际结果与预期结果一致。",
              cease_condition: "测试终止。",
            },
          ],
        },
      ],
      test_environment_mode: "evaluation",
    })

    expect(hardwareSuite.suite.test_cases[0].test_environment).toBe("硬平台测试环境")
    expect(hardwareSuite.suite.test_cases[0].test_step[0]).toEqual(makeSteps()[0])
  })

  test("add_case handles the new atomic-array funId format (multi-ID 、-separated correspond_fun_id)", async () => {
    const previousCwd = process.cwd()
    const dir = mkdtempSync(join(tmpdir(), "ct-suite-builder-funid-array-"))
    process.chdir(dir)

    try {
      // 新格式：funId 为原子 ID 数组（Phase 6 权威格式，Phase 2 旧格式已过时）
      writeJson(join(dir, ".matrix", "data", "test-requirements.json"), {
        funItem: [
          {
            funId: ["TR-JK-001", "TR-JK-002", "TR-JK-003", "TR-JK-004", "TR-JK-005", "TR-JK-006", "TR-JK-007", "TR-JK-008"],
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

      await (ctSuiteCreate as any).execute({
        project_name: "Matrix",
        version: "1.0",
      })

      const result = JSON.parse(
        await (ctSuiteAddCase as any).execute({
          case_name: "接口需求项测试",
          test_purpose: "验证接口需求项。",
          correspond_fun_id: "TR-JK-001、TR-JK-002",
          test_step: makeSteps(),
        }),
      )

      // 类别键/路径/测试类型都从新格式 funId 数组构建的索引解析
      expect(result.case_id).toBe("TC-JK-001")

      const suite = JSON.parse(readFileSync(join(dir, ".matrix", "data", "confirmation-tests.json"), "utf-8"))
      const persisted = suite.test_cases[0]
      // test_type 由需求分类（chapter_title 承载 test_type）权威确定，不允许 LLM 默认值
      expect(persisted.test_type).toBe("接口测试")
      // cfid 是需求项级身份：子集输入自动补全为所属 funItem 的整组 funId 形式
      expect(persisted.correspond_fun_id).toBe("TR-JK-001、TR-JK-002、TR-JK-003、TR-JK-004、TR-JK-005、TR-JK-006、TR-JK-007、TR-JK-008")
      // correspond_fun_ids 数组已删除；多 ID 需求项未提供覆盖信息时 rsrid 留空并告警（禁止默认整组）
      expect(persisted.correspond_fun_ids).toBeUndefined()
      expect(persisted.related_software_req_ids).toBeUndefined()
      expect(result.warnings.join("\n")).toContain("留空")
      expect(persisted.path).toBe("/4/3/1/")
    } finally {
      process.chdir(previousCwd)
    }
  })

  test("recomposes worker-invented range cfid into the requirements file's authored atomic form", async () => {
    const previousCwd = process.cwd()
    const dir = mkdtempSync(join(tmpdir(), "ct-suite-builder-cfid-canonical-"))
    process.chdir(dir)

    try {
      writeJson(join(dir, ".matrix", "data", "test-requirements.json"), {
        funItem: [
          {
            funId: ["TR-JK-001", "TR-JK-002", "TR-JK-003", "TR-JK-004"],
            test_type: "接口测试",
            titleNo: "4.3.1",
            title: "接口需求项[TR-JK]",
          },
        ],
      })

      await (ctSuiteCreate as any).execute({ project_name: "Matrix", version: "1.0" })
      await (ctSuiteAddCase as any).execute({
        case_name: "范围形式用例",
        test_purpose: "验证接口需求项。",
        // Worker 发明的范围串；需求文件里是原子 ID，必须重组为 authored 形态
        correspond_fun_id: "TR-JK-001~003",
        test_step: makeSteps(),
      })

      const suite = JSON.parse(readFileSync(join(dir, ".matrix", "data", "confirmation-tests.json"), "utf-8"))
      // Worker 发明的范围串规范化为所属 funItem 的整组 authored 形式
      expect(suite.test_cases[0].correspond_fun_id).toBe("TR-JK-001、TR-JK-002、TR-JK-003、TR-JK-004")
      // 多 ID 需求项未提供覆盖信息 → rsrid 留空（不再默认整组展开）
      expect(suite.test_cases[0].related_software_req_ids).toBeUndefined()
    } finally {
      process.chdir(previousCwd)
    }
  })

  test("preserves authored range tokens and rejects untraceable cfid IDs", async () => {
    const previousCwd = process.cwd()
    const dir = mkdtempSync(join(tmpdir(), "ct-suite-builder-cfid-range-"))
    process.chdir(dir)

    try {
      writeJson(join(dir, ".matrix", "data", "test-requirements.json"), {
        funItem: [
          {
            funId: ["TR-GN-SWRC-001~006"],
            test_type: "接口测试",
            titleNo: "4.3.1",
            title: "范围需求项",
          },
        ],
      })

      await (ctSuiteCreate as any).execute({ project_name: "Matrix", version: "1.0" })

      // 需求文件 authored 的范围形式必须原样保留（整段覆盖）
      await (ctSuiteAddCase as any).execute({
        case_name: "整段覆盖",
        test_purpose: "验证。",
        correspond_fun_id: "TR-GN-SWRC-001~006",
        test_step: makeSteps(),
      })
      // 子集覆盖时按原子 ID 列出
      await (ctSuiteAddCase as any).execute({
        case_name: "子集覆盖",
        test_purpose: "验证。",
        correspond_fun_id: "TR-GN-SWRC-002",
        test_step: makeSteps(),
      })

      const suite = JSON.parse(readFileSync(join(dir, ".matrix", "data", "confirmation-tests.json"), "utf-8"))
      expect(suite.test_cases[0].correspond_fun_id).toBe("TR-GN-SWRC-001~006")
      // 子集输入自动补全为整组 authored 形式（cfid 必须与需求项 funId 完全一致）
      expect(suite.test_cases[1].correspond_fun_id).toBe("TR-GN-SWRC-001~006")

      // 无法追溯的 ID 必须大声失败（工具以 error 返回值呈现），不允许静默持久化
      const errResult = JSON.parse(
        await (ctSuiteAddCase as any).execute({
          case_name: "坏ID用例",
          test_purpose: "验证。",
          correspond_fun_id: "TR-XX-999",
          test_step: makeSteps(),
        }),
      )
      expect(errResult.error).toContain("无法追溯")
      const suiteAfterError = JSON.parse(readFileSync(join(dir, ".matrix", "data", "confirmation-tests.json"), "utf-8"))
      expect(suiteAfterError.test_cases).toHaveLength(2)
    } finally {
      process.chdir(previousCwd)
    }
  })

  test("translate_status is two-state: untranslated steps derive failure, legacy partial normalizes", async () => {
    const previousCwd = process.cwd()
    const dir = mkdtempSync(join(tmpdir(), "ct-suite-builder-two-state-"))
    process.chdir(dir)

    try {
      writeJson(join(dir, ".matrix", "data", "test-requirements.json"), {
        funItem: [
          {
            funId: ["TR-JK-001", "TR-JK-002"],
            test_type: "接口测试",
            titleNo: "4.3.1",
            title: "接口需求项[TR-JK]",
          },
        ],
      })

      await (ctSuiteCreate as any).execute({ project_name: "Matrix", version: "1.0" })

      // 关键字未翻译的步骤 → 自动推导为 failure（两态，不再有 partial）
      await (ctSuiteAddCase as any).execute({
        case_name: "未翻译用例",
        test_purpose: "验证。",
        correspond_fun_id: "TR-JK-001",
        test_step: [{ 步骤描述: "执行测试步骤。", 预期结果: "系统输出正确结果。", key_name: "", parameter: [] }],
      })

      const suite = JSON.parse(readFileSync(join(dir, ".matrix", "data", "confirmation-tests.json"), "utf-8"))
      expect(suite.test_cases[0].translate_status).toBe("failure")

      // 存量 partial 数据经 schema 读取归一为 failure
      const parsed = await import("../../src/schema/confirmation-test-case").then((m) =>
        m.SourceConfirmationTestSuite.safeParse({
          project_name: "Matrix",
          version: "1.0",
          created_date: "2026-08-18",
          test_cases: [
            {
              case_id: "TC-JK-001",
              case_name: "存量",
              test_environment: "无",
              test_purpose: "验证。",
              correspond_fun_id: "TR-JK-001",
              test_type: "接口测试",
              // 旧数据：数组 rsrid + partial
              related_software_req_ids: ["TR-JK-001", "TR-JK-002"],
              translate_status: "partial",
              status: 0,
              test_step: [{ key_name: "", step_desc: "x", parameter: [], source_step_desc: "x", expected_result: "y", expected_key_name: "保留", source_expected_key_name: "保留", expected_parameter: [], is_startup_step: false }],
            },
          ],
          traceability: [],
          untestable_items: [],
          summary: { total_cases: 1, by_type: {} },
        }),
      )
      expect(parsed.success).toBe(true)
      expect(parsed.data!.test_cases[0].translate_status).toBe("failure")
      expect(parsed.data!.test_cases[0].related_software_req_ids).toBe("TR-JK-001、TR-JK-002")
    } finally {
      process.chdir(previousCwd)
    }
  })

  test("rsrid resolves per-case coverage: covered_tr_items wins, single-ID fallback, foreign/cross-item IDs fail loudly", async () => {
    const previousCwd = process.cwd()
    const dir = mkdtempSync(join(tmpdir(), "ct-suite-builder-rsrid-"))
    process.chdir(dir)

    try {
      writeJson(join(dir, ".matrix", "data", "test-requirements.json"), {
        funItem: [
          {
            funId: ["TR-JK-001", "TR-JK-002", "TR-JK-003"],
            test_type: "接口测试",
            titleNo: "4.3.1",
            title: "接口需求项[TR-JK]",
          },
          {
            funId: ["TR-GN-INIT-001"],
            test_type: "功能测试",
            titleNo: "4.1.2",
            title: "初始化需求",
          },
        ],
      })

      await (ctSuiteCreate as any).execute({ project_name: "Matrix", version: "1.0" })

      // covered_tr_items 优先于显式 related（显式整组必须让位于覆盖子集）
      await (ctSuiteAddCase as any).execute({
        case_name: "覆盖子集用例",
        test_purpose: "验证。",
        correspond_fun_id: "TR-JK-002",
        covered_tr_items: ["TR-JK-001", "TR-JK-003"],
        related_software_req_ids: "TR-JK-001、TR-JK-002、TR-JK-003",
        test_step: makeSteps(),
      })
      // 单 ID 需求项：无覆盖信息时回退该 ID
      await (ctSuiteAddCase as any).execute({
        case_name: "单ID用例",
        test_purpose: "验证。",
        correspond_fun_id: "TR-GN-INIT-001",
        test_step: makeSteps(),
      })
      // covered 含其它需求项的 ID → 大声失败
      const foreign = JSON.parse(
        await (ctSuiteAddCase as any).execute({
          case_name: "越界覆盖用例",
          test_purpose: "验证。",
          correspond_fun_id: "TR-JK-001",
          covered_tr_items: ["TR-GN-INIT-001"],
          test_step: makeSteps(),
        }),
      )
      expect(foreign.error).toContain("不属于当前测试需求项")
      // cfid 跨需求项 → 大声失败
      const crossItem = JSON.parse(
        await (ctSuiteAddCase as any).execute({
          case_name: "跨项用例",
          test_purpose: "验证。",
          correspond_fun_id: "TR-JK-001、TR-GN-INIT-001",
          test_step: makeSteps(),
        }),
      )
      expect(crossItem.error).toContain("多个测试需求项")

      const suite = JSON.parse(readFileSync(join(dir, ".matrix", "data", "confirmation-tests.json"), "utf-8"))
      expect(suite.test_cases[0].related_software_req_ids).toBe("TR-JK-001、TR-JK-003")
      expect(suite.test_cases[1].related_software_req_ids).toBe("TR-GN-INIT-001")
      expect(suite.test_cases).toHaveLength(2)
    } finally {
      process.chdir(previousCwd)
    }
  })

  test("finalize sorts cases into funItem file order (stable within item, case_id not renumbered)", async () => {
    const previousCwd = process.cwd()
    const dir = mkdtempSync(join(tmpdir(), "ct-suite-builder-order-"))
    process.chdir(dir)

    try {
      const artifact = {
        funItem: [
          { funId: ["TR-GN-INIT-001"], test_type: "功能测试", titleNo: "4.1.2", title: "初始化需求一" },
          { funId: ["TR-GN-COMM-001"], test_type: "接口测试", titleNo: "4.3.1", title: "通信需求" },
          { funId: ["TR-GN-INIT-002"], test_type: "功能测试", titleNo: "4.1.3", title: "初始化需求二" },
        ],
      }
      writeJson(join(dir, ".matrix", "data", "test-requirements.json"), artifact)

      const unifiedStep = {
        key_name: "", step_desc: "执行测试步骤。", parameter: [],
        source_step_desc: "执行测试步骤。", expected_result: "系统输出正确结果。",
        expected_key_name: "", source_expected_key_name: "", expected_parameter: [],
        is_startup_step: false,
      }
      const mkCase = (caseId: string, name: string, cfid: string) => ({
        case_id: caseId,
        case_name: name,
        test_environment: "软平台测试环境",
        test_purpose: "验证。",
        correspond_fun_id: cfid,
        test_type: "功能测试",
        test_step: [unifiedStep],
        translate_status: "failure",
        status: 0,
      })
      // 并行 worker 的真实保存顺序：item2 → item1 → item3 → item1 第二个用例
      const suite = {
        project_name: "Matrix",
        version: "1.0",
        created_date: "2026-08-18",
        test_cases: [
          mkCase("TC-GN-COMM-001", "通信校验", "TR-GN-COMM-001"),
          mkCase("TC-GN-INIT-001", "初始化校验一", "TR-GN-INIT-001"),
          mkCase("TC-GN-INIT-003", "初始化校验二", "TR-GN-INIT-002"),
          mkCase("TC-GN-INIT-002", "初始化校验三", "TR-GN-INIT-001"),
        ],
      }

      const finalized = finalizeConfirmationSuiteData(suite, artifact)

      // 需求顺序:item1(两个用例,保持保存先后) → item2 → item3
      expect(finalized.suite.test_cases.map((c) => c.case_name)).toEqual([
        "初始化校验一",
        "初始化校验三",
        "通信校验",
        "初始化校验二",
      ])
      // case_id 不重编号
      expect(finalized.suite.test_cases.map((c) => c.case_id)).toEqual([
        "TC-GN-INIT-001",
        "TC-GN-INIT-002",
        "TC-GN-COMM-001",
        "TC-GN-INIT-003",
      ])
    } finally {
      process.chdir(previousCwd)
    }
  })
})
