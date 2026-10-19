import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"

const ROOT = join(import.meta.dir, "..")

describe("offline installer OpenCode registration", () => {
  test("config template does not register local JS through npm plugin field", () => {
    const template = readFileSync(
      join(ROOT, "scripts/installer/opencode.json.template"),
      "utf-8",
    )
    const config = JSON.parse(
      template
        .replaceAll("{{LLM_MODEL}}", "model")
        .replaceAll("{{LLM_BASE_URL}}", "http://llm.local/v1")
        .replaceAll("{{LLM_API_KEY}}", "")
        .replaceAll("{{LLM_CONTEXT_SIZE}}", "8192")
        .replaceAll("{{LLM_OUTPUT_SIZE}}", "2048"),
    )

    expect(config.default_agent).toBe("conductor")
    expect(config.plugin).toBeUndefined()
  })

  test("windows installer registers plugin for both TUI and Desktop config roots", () => {
    const nsi = readFileSync(join(ROOT, "scripts/installer/matrix.nsi"), "utf-8")

    expect(nsi).toContain("$PROFILE\\.config\\opencode\\plugins\\matrix.js")
    expect(nsi).toContain("$PROFILE\\.config\\opencode\\plugin\\matrix.js")
    expect(nsi).toContain("$APPDATA\\opencode\\plugins\\matrix.js")
    expect(nsi).toContain("$APPDATA\\opencode\\plugin\\matrix.js")
    expect(nsi).toContain("$APPDATA\\opencode\\plugins\\package.json")
    expect(nsi).toContain("$APPDATA\\opencode\\bin")
    expect(nsi).toContain("$APPDATA\\opencode\\standards")
    expect(nsi).toContain("$APPDATA\\opencode\\joern")
    expect(nsi).toContain('"default_agent": "conductor"')
    expect(nsi).not.toContain('"plugin": ["./plugin/matrix.js"]')
  })

  test("linux installer relies on local plugins directory auto-loading", () => {
    const install = readFileSync(join(ROOT, "scripts/installer/install.sh"), "utf-8")

    expect(install).toContain("${OPENCODE_CONFIG_DIR}/plugins")
    expect(install).toContain("${OPENCODE_PLUGINS_DIR}/package.json")
    expect(install).toContain("for asset_dir in skills templates standards bin joern")
    expect(install).toContain('"default_agent": "conductor"')
    expect(install).not.toContain('"plugin": [')
    expect(install).not.toContain("./plugin/matrix.js")
  })

  test("plugin bundle is built for Node-compatible OpenCode Desktop", () => {
    const packageJson = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf-8"),
    )

    expect(packageJson.scripts.build).toContain("--target node")
    expect(packageJson.scripts.build).not.toContain("--target bun")
  })
})
