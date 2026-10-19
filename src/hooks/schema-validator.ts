import { createArtifactValidatorHook } from "./artifact-validator"

/**
 * schema-validator hook — Alias for artifact-validator.
 * When tools write to .matrix/data/*.json, automatically validates with Zod schemas.
 * This is the same as artifact-validator but named separately for clarity in config.
 */
export function createSchemaValidatorHook(directory: string) {
  // Reuse the artifact validator implementation
  return createArtifactValidatorHook(directory)
}
