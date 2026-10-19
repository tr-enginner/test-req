import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"

const LEGACY_SOURCE_INPUT = /source-docx-text|source_docx_text_path|functional_source_text_path|hardware_interface_text_path/i
const LEGACY_SOURCE_WORDING = /完整读取源Markdown|源文档抽取文本|两份指定 Markdown/i
const REMOVED_FINGERPRINT = /source_bundle_fingerprint/

function filesUnder(root: string): string[] {
  const glob = new Bun.Glob("**/*.{ts,md}")
  return [...glob.scanSync({ cwd: root, absolute: true, onlyFiles: true })]
}

describe("Phase 2 source contract", () => {
  test("production agents, workflows, skills, and templates contain no legacy source-text inputs", () => {
    const root = process.cwd()
    const files = ["src", "skills", "templates"].flatMap((dir) => filesUnder(join(root, dir)))
    const offenders = files.filter((path) => LEGACY_SOURCE_INPUT.test(readFileSync(path, "utf-8")))
    expect(offenders).toEqual([])
    const wordingOffenders = files.filter((path) => LEGACY_SOURCE_WORDING.test(readFileSync(path, "utf-8")))
    expect(wordingOffenders).toEqual([])
  })

  test("Phase 2 production contracts contain no source bundle fingerprint", () => {
    const root = process.cwd()
    const files = ["src", "skills", "templates", "docs"].flatMap((dir) => filesUnder(join(root, dir)))
    const offenders = files.filter((path) => REMOVED_FINGERPRINT.test(readFileSync(path, "utf-8")))
    expect(offenders).toEqual([])
  })

  test("all Phase 2 source-backed modelers and skills explain canonical source_refs", () => {
    const files = [
      "src/agents/chapter1-scope-modeler.ts", "src/agents/chapter2-system-overview-modeler.ts",
      "src/agents/hardware-interface-discoverer.ts", "src/agents/hardware-interface-modeler.ts",
      "src/agents/functional-init-content-modeler.ts", "src/agents/functional-other-content-modeler.ts",
      "src/agents/performance-test-content-modeler.ts", "src/agents/interface-test-content-modeler.ts",
      "src/agents/reliability-safety-test-content-modeler.ts", "src/agents/margin-test-content-modeler.ts",
      "src/agents/boundary-test-content-modeler.ts", "src/agents/recovery-test-content-modeler.ts",
      "src/agents/strength-test-content-modeler.ts", "src/agents/data-processing-test-content-modeler.ts",
      "skills/test-requirement-chapter1/SKILL.md", "skills/test-requirement-chapter2/SKILL.md",
      "skills/functional-init-requirements/SKILL.md", "skills/functional-other-requirements/SKILL.md",
      "skills/performance-test-requirements/SKILL.md", "skills/interface-test-requirements/SKILL.md",
      "skills/reliability-safety-test-requirements/SKILL.md", "skills/margin-test-requirements/SKILL.md",
      "skills/boundary-test-requirements/SKILL.md", "skills/recovery-test-requirements/SKILL.md",
      "skills/strength-test-requirements/SKILL.md", "skills/data-processing-test-requirements/SKILL.md",
    ]
    for (const file of files) {
      const text = readFileSync(join(process.cwd(), file), "utf-8")
      expect(text).toContain("source_refs")
      expect(text).toMatch(/sections\[\]\.source_ref|PHASE2_(?:CHAPTER|REQUIREMENT)_SOURCE_REFS_GUIDANCE/)
    }
  })

  test("non-functional raw prompts consistently assign IDs in finalize", () => {
    const pairs = [
      ["performance", "performance_requirement_description", "TR-XN"],
      ["reliability-safety", "reliability_safety_requirement_description", "TR-AQ"],
      ["margin", "margin_requirement_description", "TR-YL"],
      ["boundary", "boundary_requirement_description", "TR-BJ"],
      ["data-processing", "data_processing_requirement_description", "TR-SC"],
      ["recovery", "recovery_requirement_description", "TR-HF"],
      ["strength", "strength_requirement_description", "TR-QD"],
    ]
    for (const [name, description, prefix] of pairs) {
      for (const file of [`src/agents/${name}-test-content-modeler.ts`, `skills/${name}-test-requirements/SKILL.md`]) {
        const text = readFileSync(join(process.cwd(), file), "utf-8")
        expect(text).toContain(description)
        expect(text).toContain("source_refs")
        expect(text).toContain("related_description")
        expect(text).toMatch(/不得输出`?requirement_id|do not output `requirement_id`/i)
        expect(text).toContain(prefix)
      }
    }
    for (const file of ["src/agents/interface-test-content-modeler.ts", "skills/interface-test-requirements/SKILL.md"]) {
      const text = readFileSync(join(process.cwd(), file), "utf-8")
      expect(text).toContain("六个字段")
      expect(text).toContain("source_refs")
    }
  })
})
