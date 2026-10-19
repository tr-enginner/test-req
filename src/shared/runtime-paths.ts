import { existsSync } from "fs"
import { basename, dirname, join, resolve } from "path"
import { fileURLToPath } from "url"

export function moduleDir(metaUrl: string): string {
  return dirname(fileURLToPath(metaUrl))
}

function findPackageRoot(startDir: string): string | null {
  let current = resolve(startDir)

  while (true) {
    if (existsSync(join(current, "package.json"))) {
      return current
    }

    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/**
 * Resolve the directory that contains runtime assets shipped beside the plugin
 * bundle. This must work in these layouts:
 * - repo source: src/** -> repo root
 * - npm/offline package: dist/index.js -> package root
 * - OpenCode local plugin, self-contained: plugins/matrix.js + plugins/skills
 *   -> plugins/ (assets beside the bundle take precedence)
 * - OpenCode local plugin, legacy: plugins/matrix.js + 根级 skills/（资产在
 *   opencode 配置根）-> 配置根。2026-08-25 事故:部署流程一直把 skills/
 *   templates/ 同步到 plugins/ 下,而本函数无差别返回上一级(配置根),
 *   导致配置根下 7 月末的旧副本被加载、新副本静默失效——bundle 旁存在
 *   skills/ 时必须优先使用。
 */
export function runtimeAssetRoot(metaUrl: string): string {
  const dir = moduleDir(metaUrl)
  const leaf = basename(dir).toLowerCase()

  if (leaf === "dist") {
    return dirname(dir)
  }
  if (leaf === "plugin" || leaf === "plugins") {
    return existsSync(join(dir, "skills")) ? dir : dirname(dir)
  }

  return findPackageRoot(dir) ?? dirname(dir)
}
