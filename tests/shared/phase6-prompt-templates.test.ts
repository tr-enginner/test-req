import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { basename, join } from "path"
import {
  BUILTIN_PHASE6_PROMPT_TEMPLATES,
  PHASE6_SOFTWARE_TEMPLATE_FILES,
  loadMarkdownPromptTemplates,
  loadPhase6PromptTemplates,
  normalizePhase6TestType,
  resolvePhase6PromptTemplate,
  selectTemplateKeyFromIndex,
  type LoadedPhase6PromptTemplates,
  type PromptTemplateIndexEntry,
} from "../../src/shared/phase6-prompt-templates"

const roots: string[] = []
const projectRoot = process.cwd()
const repositoryIndex = join(projectRoot, "templates", "testcase-prompts", "index.json")

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "phase6-template-route-"))
  roots.push(root)
  return root
}

function writeCatalog(root: string, label: string, entries?: PromptTemplateIndexEntry[]): string {
  const folder = join(root, "templates", "testcase-prompts")
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, "index.json"), JSON.stringify({ version: 1, templates: entries ?? [{
    key: "test-功能测试-STEP-GENERATED", file: "test-functional.md",
    match: { project_types: ["software", "software_variant"], test_types: ["功能测试"] },
  }] }))
  writeFileSync(join(folder, "test-functional.md"), `# ${label}\n\n\`\`\`prompt\n${label}\n\`\`\`\n`)
  return join(folder, "index.json")
}

function builtinOnly(): LoadedPhase6PromptTemplates {
  return {
    templates: BUILTIN_PHASE6_PROMPT_TEMPLATES,
    template_sources: {}, markdown_catalog: null, warnings: [],
    checked_prompt_index_candidates: [], checked_legacy_template_candidates: [],
  }
}

describe("Phase 6 strict test-* prompt routing", () => {
  test("all supported software types select their test-* file regardless of domain", () => {
    const catalog = loadMarkdownPromptTemplates(repositoryIndex).catalog!
    for (const projectType of ["software", "software_variant"] as const) {
      for (const domain of [undefined, "generic", "satellite-dsp"]) {
        for (const [testType, file] of Object.entries(PHASE6_SOFTWARE_TEMPLATE_FILES)) {
          const key = selectTemplateKeyFromIndex(testType, projectType, catalog, domain)!
          expect(basename(catalog.files[key])).toBe(file)
          expect(key.startsWith("test-")).toBe(true)
        }
      }
    }
    expect(Object.keys(PHASE6_SOFTWARE_TEMPLATE_FILES)).toHaveLength(11)
  })

  test("domain priority cannot replace the test-* primary template", () => {
    const catalog = loadMarkdownPromptTemplates(repositoryIndex).catalog!
    const satellite = catalog.entries.find((entry) => entry.key === "satellite-功能测试-STEP-GENERATED")!
    satellite.priority = 9999
    expect(selectTemplateKeyFromIndex("功能测试", "software", catalog, "satellite-dsp"))
      .toBe("test-功能测试-STEP-GENERATED")
  })

  test("unknown and unspecified software types fail instead of selecting a default", () => {
    const catalog = loadMarkdownPromptTemplates(repositoryIndex).catalog!
    for (const type of [null, "", "新测试类型"]) {
      expect(() => selectTemplateKeyFromIndex(type, "software", catalog)).toThrow("测试类型未识别")
    }
  })

  test("a legacy-only index does not satisfy strict software routing", () => {
    const catalog = loadMarkdownPromptTemplates(repositoryIndex).catalog!
    catalog.entries = catalog.entries.filter((entry) => !entry.file.startsWith("test-"))
    expect(() => selectTemplateKeyFromIndex("功能测试", "software", catalog, "satellite-dsp"))
      .toThrow("必须使用 test-functional.md")
  })

  test("the required file must match both project type and type without a domain restriction", () => {
    for (const invalidMatch of [
      { project_types: ["fpga"], test_types: ["功能测试"] },
      { project_types: ["software"], test_types: ["性能测试"] },
      { project_types: ["software"], test_types: ["功能测试"], domain: "satellite-dsp" },
    ]) {
      const catalog = loadMarkdownPromptTemplates(repositoryIndex).catalog!
      catalog.entries = [{ key: "test-功能测试-STEP-GENERATED", file: "test-functional.md", match: invalidMatch }]
      expect(() => selectTemplateKeyFromIndex("功能测试", "software", catalog, "satellite-dsp"))
        .toThrow("必须使用 test-functional.md")
    }
  })

  test("missing or empty prompt files cannot fall back to legacy templates", () => {
    for (const brokenContent of [null, "# Missing fenced prompt", "```prompt\n\n```\n"]) {
      const root = fixtureRoot()
      const index = writeCatalog(root, "valid", [{
        key: "test-功能测试-STEP-GENERATED", file: "test-functional.md", match: { test_types: ["功能测试"] },
      }, {
        key: "功能测试-STEP-GENERATED", file: "software-functional.md", match: { test_types: ["功能测试"] },
      }])
      writeFileSync(join(root, "templates", "testcase-prompts", "software-functional.md"), "```prompt\nlegacy\n```\n")
      const file = join(root, "templates", "testcase-prompts", "test-functional.md")
      if (brokenContent === null) rmSync(file)
      else writeFileSync(file, brokenContent)
      const loaded = loadMarkdownPromptTemplates(index)
      expect(loaded.warnings.length).toBeGreaterThan(0)
      expect(() => selectTemplateKeyFromIndex("功能测试", "software", loaded.catalog!))
        .toThrow("必须使用 test-functional.md")
    }
  })

  test("no catalog is an error for software, while FPGA and requirements retain compatibility", () => {
    for (const projectType of ["software", "software_variant"] as const) {
      expect(() => resolvePhase6PromptTemplate({ loaded: builtinOnly(), testTypeChinese: "功能测试", projectType }))
        .toThrow("禁止降级")
    }
    expect(resolvePhase6PromptTemplate({ loaded: builtinOnly(), testTypeChinese: null, projectType: "fpga" }).key)
      .toBe("FPGA-DG-STEP-NOT-GENERATED")
    expect(resolvePhase6PromptTemplate({ loaded: builtinOnly(), testTypeChinese: null, projectType: "requirements" }).key)
      .toBe("TR-XQ")
    const loaded = { ...builtinOnly(), markdown_catalog: loadMarkdownPromptTemplates(repositoryIndex).catalog }
    expect(basename(resolvePhase6PromptTemplate({ loaded, testTypeChinese: "功能测试", projectType: "fpga" }).file!))
      .toBe("fpga-functional.md")
  })

  test("normalization supports all public English type names including timing", () => {
    expect(normalizePhase6TestType("timing")).toBe("时序测试")
    expect(normalizePhase6TestType("logic_test")).toBe("逻辑测试")
    expect(normalizePhase6TestType("robustness")).toBe("可靠性安全性测试")
    expect(normalizePhase6TestType("安全性测试")).toBe("可靠性安全性测试")
    expect(normalizePhase6TestType("可靠性安全性测试")).toBe("可靠性安全性测试")
    expect(normalizePhase6TestType("data-processing")).toBe("数据处理测试")
    expect(normalizePhase6TestType("unknown")).toBeNull()
  })

  test("normalization accepts only complete known names or explicit aliases, never substrings or prototype names", () => {
    for (const name of ["测", "性", "时", "功", "测试测", "constructor", "__proto__", "toString"]) {
      expect(normalizePhase6TestType(name)).toBeNull()
    }
    for (const [name, expected] of [
      ["功能", "功能测试"], ["时序", "时序测试"], ["安全性", "可靠性安全性测试"],
      ["安全", "可靠性安全性测试"], ["安全测试", "可靠性安全性测试"],
      ["恢复", "恢复性测试"], ["恢复测试", "恢复性测试"],
      [" Timing ", "时序测试"], ["LOGIC_TEST", "逻辑测试"],
    ]) {
      expect(normalizePhase6TestType(name)).toBe(expected)
    }
    const catalog = loadMarkdownPromptTemplates(repositoryIndex).catalog!
    expect(() => selectTemplateKeyFromIndex("测", "software", catalog)).toThrow("测试类型未识别")
  })
})

describe("Phase 6 prompt source resolution and provenance", () => {
  test("project templates override deployed templates and the selected file has full-content provenance", () => {
    const root = fixtureRoot()
    const project = join(root, "project")
    const bundle = join(root, "plugins")
    const index = writeCatalog(project, "project prompt")
    writeCatalog(bundle, "deployed prompt")
    const loaded = loadPhase6PromptTemplates({ projectDir: project, importMetaDir: bundle })
    const result = resolvePhase6PromptTemplate({ loaded, projectType: "software", testTypeChinese: "功能测试", domain: "satellite-dsp" })
    expect(result.body).toBe("project prompt\n")
    expect(result.index_file).toBe(index)
    expect(result.hash).toBe(createHash("sha256").update(readFileSync(result.file!)).digest("hex"))
    expect(result.selection_reason).toContain("仅作为补充知识")
    expect(loaded.checked_prompt_index_candidates[0]).toBe(index)
  })

  test("project-local overlays precede bundled catalogs in their documented order", () => {
    for (const prefix of [".matrix", ".opencode", ".config/opencode"]) {
      const root = fixtureRoot()
      const project = join(root, "project")
      const bundle = join(root, "plugins")
      const index = writeCatalog(join(project, prefix), `overlay ${prefix}`)
      writeCatalog(bundle, "deployed prompt")
      const loaded = loadPhase6PromptTemplates({ projectDir: project, importMetaDir: bundle })
      expect(loaded.markdown_catalog?.index_file).toBe(index)
    }
    const root = fixtureRoot()
    const project = join(root, "project")
    const matrix = writeCatalog(join(project, ".matrix"), "matrix")
    writeCatalog(join(project, ".opencode"), "opencode")
    expect(loadPhase6PromptTemplates({ projectDir: project, importMetaDir: root }).markdown_catalog?.index_file).toBe(matrix)
  })

  test("invalid selected project indexes cannot be replaced with valid deployed indexes", () => {
    for (const content of ["{invalid", "{}", '{"version":1,"templates":[]}']) {
      const root = fixtureRoot()
      const project = join(root, "project")
      const bundle = join(root, "plugins")
      const index = writeCatalog(project, "project")
      writeCatalog(bundle, "deployed")
      writeFileSync(index, content)
      expect(() => loadPhase6PromptTemplates({ projectDir: project, importMetaDir: bundle }))
        .toThrow("停止生成而不切换模板来源")
    }
  })

  test("duplicate index keys are rejected before any files are loaded, including missing or broken duplicate files", () => {
    for (const duplicateFile of ["test-functional.md", "software-functional.md", "missing.md", "broken.md"]) {
      const root = fixtureRoot()
      const key = "test-功能测试-STEP-GENERATED"
      const index = writeCatalog(root, "test prompt", [
        { key, file: "test-functional.md", match: { project_types: ["software"], test_types: ["功能测试"] } },
        { key, file: duplicateFile, match: { project_types: ["software"], test_types: ["功能测试"] } },
      ])
      writeFileSync(join(root, "templates", "testcase-prompts", "software-functional.md"), "```prompt\nlegacy prompt\n```\n")
      writeFileSync(join(root, "templates", "testcase-prompts", "broken.md"), "no prompt")
      const result = loadMarkdownPromptTemplates(index)
      expect(result.catalog).toBeNull()
      expect(result.warnings.join(" ")).toContain("重复模板 key")
      expect(() => loadPhase6PromptTemplates({ projectDir: root, importMetaDir: root })).toThrow("重复模板 key")
    }
  })

  test("malformed index match and option fields cannot bypass strict type matching", () => {
    for (const invalidFields of [
      { match: { project_types: "software" } },
      { match: { project_types: null } },
      { match: { project_types: [123] } },
      { match: { test_types: "功能测试" } },
      { match: { test_types: 0 } },
      { match: { domain: 123 } },
      { match: "software" },
      { fallback: "false" },
      { priority: "9999" },
      { key: "" },
      { file: "" },
    ]) {
      const root = fixtureRoot()
      const index = writeCatalog(root, "prompt")
      writeFileSync(index, JSON.stringify({ version: 1, templates: [{
        key: "test-功能测试-STEP-GENERATED", file: "test-functional.md", ...invalidFields,
      }] }))
      const result = loadMarkdownPromptTemplates(index)
      expect(result.catalog).toBeNull()
      expect(result.warnings.join(" ")).toContain("格式非法")
      expect(() => loadPhase6PromptTemplates({ projectDir: root, importMetaDir: root })).toThrow("停止生成而不切换模板来源")
    }
  })

  test("valid optional index fields can remain omitted for compatibility", () => {
    const root = fixtureRoot()
    const index = writeCatalog(root, "prompt", [{ key: "custom-functional", file: "test-functional.md" }])
    const catalog = loadMarkdownPromptTemplates(index).catalog!
    expect(selectTemplateKeyFromIndex("功能测试", "software", catalog)).toBe("custom-functional")
  })

  test("the content hash describes the loaded snapshot even if the file changes later", () => {
    const root = fixtureRoot()
    writeCatalog(root, "original")
    const loaded = loadPhase6PromptTemplates({ projectDir: root, importMetaDir: root })
    const originalHash = loaded.markdown_catalog!.hashes!["test-功能测试-STEP-GENERATED"]
    writeFileSync(join(root, "templates", "testcase-prompts", "test-functional.md"), "```prompt\nchanged\n```\n")
    const result = resolvePhase6PromptTemplate({ loaded, projectType: "software", testTypeChinese: "功能测试" })
    expect(result.body).toBe("original\n")
    expect(result.hash).toBe(originalHash)
  })
})
