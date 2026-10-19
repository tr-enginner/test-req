import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { pathToFileURL } from "url"
import { runtimeAssetRoot } from "../../src/shared/runtime-paths"

describe("runtimeAssetRoot(插件资产目录解析,2026-08-25 部署事故)", () => {
  test("bundle 旁存在 skills/ → 优先 bundle 旁目录(自包含 plugins 布局)", () => {
    // 2026-08-25 事故:plugins/matrix.js + plugins/skills 同时存在时,旧逻辑
    // 返回上一级(配置根),加载了配置根下的陈旧副本,新副本静默失效
    const dir = mkdtempSync(join(tmpdir(), "rt-assets-"))
    try {
      const pluginsDir = join(dir, "plugins")
      mkdirSync(join(pluginsDir, "skills"), { recursive: true })
      writeFileSync(join(pluginsDir, "matrix.js"), "export default {}", "utf-8")
      const metaUrl = pathToFileURL(join(pluginsDir, "matrix.js")).href
      expect(runtimeAssetRoot(metaUrl)).toBe(pluginsDir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("bundle 旁无 skills/(旧布局)→ 回退上一级 opencode 配置根", () => {
    const dir = mkdtempSync(join(tmpdir(), "rt-legacy-"))
    try {
      const pluginsDir = join(dir, "plugins")
      mkdirSync(pluginsDir, { recursive: true })
      mkdirSync(join(dir, "skills"), { recursive: true })
      writeFileSync(join(pluginsDir, "matrix.js"), "export default {}", "utf-8")
      const metaUrl = pathToFileURL(join(pluginsDir, "matrix.js")).href
      expect(runtimeAssetRoot(metaUrl)).toBe(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("dist 布局 → 包根;仓库源码布局 → 包根", () => {
    const dir = mkdtempSync(join(tmpdir(), "rt-pkg-"))
    try {
      writeFileSync(join(dir, "package.json"), "{}", "utf-8")
      const distDir = join(dir, "dist")
      mkdirSync(distDir, { recursive: true })
      expect(runtimeAssetRoot(pathToFileURL(join(distDir, "index.js")).href)).toBe(dir)
      const srcDir = join(dir, "src", "shared")
      mkdirSync(srcDir, { recursive: true })
      expect(runtimeAssetRoot(pathToFileURL(join(srcDir, "x.ts")).href)).toBe(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
