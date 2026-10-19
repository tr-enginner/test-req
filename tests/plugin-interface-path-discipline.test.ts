import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { dirname, join } from "path"
import { loadPluginConfig } from "../src/plugin-config"
import { createHooks } from "../src/create-hooks"
import { createPluginInterface } from "../src/plugin-interface"
import { resolveSkillsDir } from "../src/create-skills"

function makePlugin(projectDir: string) {
  const pluginConfig = loadPluginConfig(projectDir)
  const hooks = createHooks(projectDir, pluginConfig)
  return createPluginInterface({
    directory: projectDir,
    pluginConfig,
    hooks,
    tools: {},
    skillsDir: resolveSkillsDir(),
  })
}

describe("plugin interface path discipline", () => {
  test("allows only the installed skill asset root as an external directory", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "matrix-skill-permission-"))

    try {
      const plugin = makePlugin(projectDir)
      const config: any = {}
      await plugin.config?.(config)

      const skillAssetPattern = join(dirname(resolveSkillsDir()), "*")
      expect(config.permission.external_directory).toEqual({
        [skillAssetPattern]: "allow",
      })
      expect(config.permission.external_directory["*"]).toBeUndefined()
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  test("does not override an explicit external-directory deny rule", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "matrix-skill-permission-deny-"))

    try {
      const plugin = makePlugin(projectDir)
      const config: any = { permission: { external_directory: "deny" } }
      await plugin.config?.(config)

      expect(config.permission.external_directory).toBe("deny")
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  test("injects workspace-relative Matrix path guidance into system prompt transforms", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "matrix-path-discipline-"))

    try {
      const plugin = makePlugin(projectDir)
      const output = { system: [] as string[] }

      await plugin["experimental.chat.system.transform"]?.(
        { sessionID: "path-discipline", agent: "test-designer" },
        output,
      )

      const merged = output.system.join("\n")
      expect(merged).toContain("<matrix-path-discipline>")
      expect(merged).toContain("当前项目工作目录下的相对路径")
      expect(merged).toContain("不要把 `.matrix/...` 改写成 `/.matrix/...`")
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })
})
