import { existsSync } from "fs"
import { join } from "path"
import { homedir } from "os"

export interface ResolveTemplateAssetOptions {
  filename: string
  importMetaDir: string
  projectDir?: string
  preferredPath?: string
  envVarName?: string
  envPathResolver?: (envValue: string) => string
  extraCandidates?: string[]
}

export interface ResolvedTemplateAsset {
  path: string | null
  checked: string[]
}

function uniqueCandidates(candidates: Array<string | undefined>): string[] {
  const seen = new Set<string>()
  const result: string[] = []

  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue
    seen.add(candidate)
    result.push(candidate)
  }

  return result
}

/**
 * Unified template lookup order for Matrix tools.
 *
 * The primary business-template directory is `<workDir>/templates/`.
 * Callers may pass nested filenames such as `testcase-prompts/index.json`.
 * In manager-managed projects it is created during project initialization
 * and populated from bundled defaults on a "copy missing only" basis.
 */
export function buildTemplateAssetCandidates({
  filename,
  importMetaDir,
  projectDir,
  preferredPath,
  envVarName,
  envPathResolver,
  extraCandidates = [],
}: ResolveTemplateAssetOptions): string[] {
  const envValue = envVarName ? process.env[envVarName]?.trim() : undefined
  const envCandidate = envValue
    ? (envPathResolver ? envPathResolver(envValue) : envValue)
    : undefined

  return uniqueCandidates([
    preferredPath,
    envCandidate,
    // bundle 旁目录优先(plugins 布局:plugins/matrix.js + plugins/templates;
    // 2026-08-25 事故:候选列表从未包含 bundle 旁 templates,配置根删除后
    // 提示词模板落到外部生成器的 legacy prompt_templates.json——与
    // runtimeAssetRoot 的自包含优先规则保持一致)
    join(importMetaDir, "templates", filename),
    // Global config paths (legacy layout)
    join(homedir(), ".config", "opencode", "templates", filename),
    join(importMetaDir, "..", "templates", filename),
    join(importMetaDir, "..", "..", "templates", filename),
    // Project-local paths as fallback
    projectDir ? join(projectDir, "templates", filename) : undefined,
    projectDir ? join(projectDir, ".config", "opencode", "templates", filename) : undefined,
    projectDir ? join(projectDir, ".matrix", "templates", filename) : undefined,
    projectDir ? join(projectDir, ".opencode", "templates", filename) : undefined,
    ...extraCandidates,
  ])
}

export function resolveTemplateAssetPath(
  options: ResolveTemplateAssetOptions,
): ResolvedTemplateAsset {
  const checked = buildTemplateAssetCandidates(options)
  const path = checked.find((candidate) => existsSync(candidate)) ?? null
  return { path, checked }
}
