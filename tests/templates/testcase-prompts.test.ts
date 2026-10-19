import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"
import { PHASE6_SOFTWARE_TEMPLATE_FILES } from "../../src/shared/phase6-prompt-templates"

function readPromptBlock(file: string): string {
  const fullPath = join(process.cwd(), "templates", "testcase-prompts", file)
  const markdown = readFileSync(fullPath, "utf-8")
  const match = markdown.match(/```prompt\s*\n([\s\S]*?)```/)
  expect(match).toBeTruthy()
  return match![1]
}

describe("testcase prompt markdown templates", () => {
  test("every strict software template is registered and contains the required prompt sections", () => {
    const catalog = JSON.parse(readFileSync(join(process.cwd(), "templates", "testcase-prompts", "index.json"), "utf-8"))
    for (const [testType, file] of Object.entries(PHASE6_SOFTWARE_TEMPLATE_FILES)) {
      expect(catalog.templates.some((entry: { file: string; match?: { test_types?: string[] } }) =>
        entry.file === file && entry.match?.test_types?.includes(testType))).toBe(true)
      const prompt = readPromptBlock(file)
      for (const heading of ["任务目标", "输出格式", "通用生成规则", "输入信息"]) {
        expect(prompt).toContain(`### ${heading}`)
      }
    }
  })

  test("timing uses evidenced constraints instead of invented protocol constants", () => {
    const prompt = readPromptBlock("test-timing.md")
    expect(prompt).toContain("参考事件")
    expect(prompt).toContain("允许时间窗口")
    expect(prompt).toContain("不凭空设置协议常量")
    expect(prompt).toContain("多帧或多包")
  })

  test("selected templates use the unified short prompt skeleton", () => {
    for (const file of [
      "requirements-default.md",
      "software-functional.md",
      "software-interface.md",
      "fpga-functional.md",
    ]) {
      const prompt = readPromptBlock(file)
      expect(prompt).toContain("### 任务目标")
      expect(prompt).toContain("### 输出格式")
      expect(prompt).toContain("### 通用生成规则")
      expect(prompt).toContain("### 类型专属规则")
      expect(prompt).toContain("### 输入信息")
    }
  })

  test("selected templates remove noisy examples and heavy emphasis from prompt bodies", () => {
    for (const file of [
      "requirements-default.md",
      "software-functional.md",
      "software-interface.md",
      "fpga-functional.md",
    ]) {
      const prompt = readPromptBlock(file)
      expect(prompt).not.toContain("🚫")
      expect(prompt).not.toContain("✅")
      expect(prompt).not.toContain("```json")
      expect(prompt).not.toContain("*****测试需求开始*****")
      expect(prompt).not.toContain("绝对禁止项")
      expect(prompt).not.toContain("正确做法")
    }
  })
})
