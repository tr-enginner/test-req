import { z } from "zod"
import { existsSync, mkdirSync, readFileSync } from "fs"
import { join } from "path"

/** Load and validate JSON data from a file */
export function loadData<T>(schema: z.ZodType<T>, filePath: string): T | null {
  if (!existsSync(filePath)) {
    return null
  }
  const raw = readFileSync(filePath, "utf-8")
  const json = JSON.parse(raw)
  const result = schema.safeParse(json)
  if (!result.success) {
    throw new Error(
      `Schema validation failed for ${filePath}: ${result.error.message}`,
    )
  }
  return result.data
}

/** Ensure .matrix directory structure exists */
export function ensureMatrixDirs(projectRoot: string): void {
  const dirs = [
    ".matrix/data/contexts",
    ".matrix/data/reviews",
    ".matrix/data/review-records",
    ".matrix/reports",
    ".matrix/config",
    ".matrix/plans",
    ".matrix/state",
    ".matrix/test-env",
    ".matrix/stubs",
    ".matrix/preprocessed",
    ".matrix/bin",
  ]
  for (const dir of dirs) {
    const fullPath = join(projectRoot, dir)
    if (!existsSync(fullPath)) {
      mkdirSync(fullPath, { recursive: true })
    }
  }
}
