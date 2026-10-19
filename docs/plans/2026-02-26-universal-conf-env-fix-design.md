# Design: universal.conf Parsing & Build Environment Auto-Fix

**Date**: 2026-02-26
**Branch**: unit_AUnit
**Status**: Approved

## Problem

After `aunit_create_project` runs, AUnit copies the selected platform's `universal.conf` into the project workspace at:

```
<project_dir>/.matrix/aunit/<project_name>/meta/data/common/base/universal.conf
```

This conf file contains environment variables (`env`), include paths (`inc`), PATH additions (`path`), and macro definitions (`da`) that must be correctly set before the analysis-build step. Currently `aunit_build` ignores this file entirely, so:

1. `env` entries pointing to missing paths silently fail
2. Include paths that don't exist cause build failures with no recovery
3. `aunit_build` has no retry logic — one missing header fails the whole build

## Solution

Modify `aunit_build` to:
1. Read, validate, and patch the project-local `universal.conf` before building
2. Retry the build with expanded include paths from `<installDir>/includes/` on failure

## Design

### `universal.conf` Format

```
env VARIABLE_NAME=C:\Path\To\Something
inc=C:\Some\Include\Path
path=C:\Some\Bin\Path
da MACRO_NAME=1
da ANOTHER_MACRO=VALUE
```

### New Utility Functions in `aunit-utils.ts`

#### `ParsedUniversalConf`

```ts
interface ParsedUniversalConf {
  envVars: Array<{ name: string; value: string }>      // env NAME=VALUE
  includeDirs: string[]                                  // inc=PATH
  pathAdditions: string[]                               // path=DIR
  defines: Array<{ name: string; value: string }>       // da NAME=VALUE
  rawLines: string[]                                     // original lines for reconstruction
}
```

#### `parseUniversalConf(confPath: string): ParsedUniversalConf | null`

- Reads file; returns `null` if not found
- Parses each line by prefix: `env `, `inc=`, `path=`, `da `
- Preserves comments (`#`) and blank lines in `rawLines` for round-trip fidelity

#### `resolveConfEnvPaths(parsed: ParsedUniversalConf): { resolved: ParsedUniversalConf; warnings: string[] }`

For each `env NAME=VALUE` where VALUE looks like a path (contains `\`, `/`, or `:` on non-env-var positions):

1. Check `existsSync(VALUE)` — if exists, keep as-is
2. Else check `process.env[NAME]` — if set and exists on disk, use that value
3. Else: skip setting (warn), leave line unchanged

Returns modified `ParsedUniversalConf` + list of warning strings.

#### `writeUniversalConf(confPath: string, parsed: ParsedUniversalConf): void`

Reconstructs the conf file from `rawLines` with modified values applied, writes back to disk.

#### `collectInstallIncludes(installDir: string, platform: string): string[]`

Scans:
1. `<installDir>/includes/<platform>/` — all immediate subdirectories
2. `<installDir>/includes/` — all immediate subdirectories (fallback)

Returns deduplicated list of existing directory paths.

### Modified `aunit_build` Workflow

```
1. Resolve CLI (existing)
2. Construct confPath = <project_dir>/.matrix/aunit/<project_name>/meta/data/common/base/universal.conf
3. If confPath exists:
   a. parseUniversalConf(confPath)
   b. resolveConfEnvPaths(parsed) → get resolved + warnings
   c. writeUniversalConf(confPath, resolved)
   d. Record warnings for output
4. execAunit(... "ut" "build" ...)
5. If success → return with conf_modifications field
6. If failure (retry loop, max 3):
   Round 1: collectInstallIncludes(installDir, platform)
             → append new inc= entries to conf, writeUniversalConf, retry
   Round 2: collectInstallIncludes(installDir, "*") [all subdirs]
             → append remaining new entries, retry
   Round 3: give up, return error with full stdout/stderr + tried_includes list
```

### Platform Resolution for Retry

`aunit_build` needs to know the `installDir` for scanning `includes/`. This is already available after `resolveAunitCli()`. The `platform` name is needed to try platform-specific includes first. Since `aunit_build` doesn't currently know the platform, we use a simple heuristic:

- Try `<installDir>/includes/` subdirectories directly (flat scan, no platform subfolder needed)
- If a platform-named subfolder exists (e.g., `<installDir>/includes/GENERAL_GNUC_VTEST/`), prioritize it in round 1

This avoids needing to pass `platform` to `aunit_build` explicitly.

### Return Value New Fields

```ts
{
  status: "success" | "error",
  // ... existing fields ...
  conf_path: string,                  // path to modified universal.conf
  conf_modifications: {
    env_resolved: string[],           // "ARMCC_PATH resolved via system env: C:\..."
    env_warnings: string[],           // "GHS_PATH not found anywhere, skipped"
    inc_original_count: number,
    inc_added: string[],              // paths added during retry
  },
  retry_count: number,                // 0 = succeeded first try, 1-2 = recovered
}
```

### Error handling policy

| Situation | Behavior |
|-----------|----------|
| conf file not found | Skip silently, proceed with build as before |
| env path not on disk, not in system env | Warn + skip (do not set), continue |
| inc= path not on disk | Keep entry (warn in output), AUnit may resolve it |
| Build fails after 3 retries | Return `status:"error"` with full diagnostics |

## Files Changed

| File | Change |
|------|--------|
| `src/tools/aunit/aunit-utils.ts` | Add `parseUniversalConf`, `resolveConfEnvPaths`, `writeUniversalConf`, `collectInstallIncludes` |
| `src/tools/aunit/aunit-build.ts` | Add pre-build conf patching + retry-on-failure loop |

No changes to agent prompts, other tools, or schemas.
