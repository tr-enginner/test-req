# SpecChecker Compilation Environment Integration — Implementation Plan

**Date**: 2026-02-25
**Design**: `docs/plans/2026-02-25-specchecker-compile-env-design.md`
**Branch**: `matrix-static`

## Tasks

### Task 1: Add compilation environment injection to specchecker tool

**File**: `src/tools/misra-checker.ts`

1. Add `DIALECT_TO_SPECCHECKER` mapping constant after existing constants
2. Add new optional parameters to tool args: `compiler`, `include_dirs`, `defines`
3. Add helper function `extractIncludePaths(confContent: string): Set<string>` — parses
   `-i "path"` lines from a conf file, normalizes paths, returns set
4. Add helper function `resolveCompilationEnv(targetDir: string)` — reads
   `.matrix/data/compilation-env.json` if it exists, returns parsed data or null
5. Add main function `injectCompilationConfig(specHome, projectPath, targetDir, args)`:
   - Read compilation-env.json via `resolveCompilationEnv`
   - Determine compiler: args.compiler → compilation-env dialect mapping → "GNUC" default
   - Read `{projectPath}/emit/unit/compiler.conf` → extract existing -i paths
   - Read `{projectPath}/emit/unit/analysis.conf` → extract existing -i paths
   - Collect new include dirs from: compilation-env include_dirs + .matrix/stubs/ + args.include_dirs
   - Dedup: skip paths already in existing set (normalize with resolve + case-insensitive on Windows)
   - Append new `-i "path"` lines to analysis.conf
   - Return { compiler, injected_includes, injected_defines }
6. Modify `executeCheck`:
   - After resolving config, call `resolveCompilationEnv` to get compiler name
   - Add `-t ${compiler}` to create command
   - After create succeeds, call `injectCompilationConfig`
   - Include compilation config info in result JSON

**Verification**: `npx tsc --noEmit`

### Task 2: Update static-analyzer agent prompt

**File**: `src/agents/static-analyzer.ts`

1. Replace Step 1 (currently "Locate Source & Run SpecChecker Analysis") with new
   "Load Compilation Environment & Run Analysis" step:
   - Read `.matrix/data/compilation-env.json` if it exists
   - Extract compiler_dialect, include_dirs, defines
   - Map compiler_dialect to SpecChecker compiler name
   - Determine source directory
   - Invoke specchecker with mode "check" + compiler + include_dirs parameters
2. Simplify Step 2 (Gather Additional Context) — compilation-env is now read in Step 1,
   keep only software-analysis.json and matrix.jsonc reads
3. Add note about the tool auto-injecting .matrix/stubs/ and deduplicating paths

**Verification**: `npx tsc --noEmit`

### Task 3: Build, sync, and verify

1. Run `npx bun run build` — confirm clean build
2. Copy dist/index.js to `/c/Users/wangb/.config/opencode/plugins/matrix.js`
3. Verify specchecker tool description includes new parameters
