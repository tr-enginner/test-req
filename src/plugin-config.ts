import { existsSync, readFileSync } from "fs"
import { join } from "path"
import * as jsonc from "jsonc-parser/lib/esm/main.js"
import { MatrixConfigSchema, type MatrixConfig, DEFAULT_CONFIG } from "./config/schema"
import { ARTIFACT_PATHS } from "./shared/constants"

/** Load plugin configuration from .matrix/config/matrix.jsonc */
export function loadPluginConfig(directory: string): MatrixConfig {
  const configPath = join(directory, ARTIFACT_PATHS.CONFIG)

  if (!existsSync(configPath)) {
    return DEFAULT_CONFIG
  }

  try {
    const raw = readFileSync(configPath, "utf-8")
    const parsed = jsonc.parse(raw)
    const result = MatrixConfigSchema.safeParse(parsed)

    if (!result.success) {
      console.warn(
        `[matrix] Config validation warning: ${result.error.message}. Using defaults.`,
      )
      // Try partial parse with defaults
      return { ...DEFAULT_CONFIG, ...parsed }
    }

    return result.data
  } catch (err) {
    console.warn(`[matrix] Failed to load config: ${err}. Using defaults.`)
    return DEFAULT_CONFIG
  }
}
