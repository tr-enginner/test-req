# Design: SpecChecker Pre-flight Clang Compilation Check

**Date**: 2026-02-27
**Status**: Approved
**File**: `src/tools/misra-checker.ts`

## Problem

The current `misra-checker` tool runs SpecChecker `analyze` (up to 600 seconds) before reading
`compile.log`. If the compilation configuration is wrong (missing headers, wrong preset), the
entire 600-second analysis is wasted. The error is only discovered after the fact, and the agent
must fix and retry — another full 600-second run.

## Goal

Detect and fix all compilation errors **before** invoking `specchecker analyze`, so that the
expensive analysis step only runs once and succeeds.

## Solution: Pre-flight Clang Check (Step 1.6)

Insert a new step between `injectCompilationConfig` (Step 1.5) and `analyze` (Step 2).

### Revised Pipeline

```
Step 1:   specchecker create  (build project scaffold + preset compiler config)
Step 1.5: injectCompilationConfig  (inject project include dirs + defines into conf files)
Step 1.6: preflight clang check  [NEW]
            → find clang binary bundled with SpecChecker
            → read SpecChecker conf files to get full flag set
            → run clang -fsyntax-only on each source file
            → self-heal or escalate on errors
            → only proceed when clang passes
Step 2:   specchecker analyze  (runs only once, with validated config)
Step 3:   specchecker report
```

---

## Step 1.6 — Detailed Design

### 1. Clang Binary Resolution

Clang is bundled with SpecChecker under the already-resolved `specHome`. No additional
configuration needed.

```
<specHome>/tools/clang/clang.exe      (try first)
<specHome>/tools/clang/bin/clang.exe  (fallback)
```

`specHome` is already resolved via the existing 5-level discovery before Step 1.6 runs.
If neither path exists, skip the pre-flight check and log a warning — analysis proceeds
as before (graceful degradation).

### 2. SpecChecker Config Extraction

After `create` + `injectCompilationConfig`, the conf files at
`<projectPath>/emit/unit/compiler.conf` and `<projectPath>/emit/unit/analysis.conf`
contain the complete compilation environment:

- `compiler.conf`: SpecChecker preset built-in include paths + platform defines
- `analysis.conf`: injected project include dirs (from `compilation-env.json` + `.matrix/stubs/`)

Reuse the existing `extractIncludePaths()` function to parse `-i` lines.
Use the same regex pattern (`/^-d\s+"?([^"]+)"?/`) to extract `-d` defines.

Merge both files into a single `-I` list and `-D` list (already deduplicated by
`injectCompilationConfig`). These become the clang flags for the pre-flight check.

### 3. Source File List

Read `<matrixRoot>/.matrix/data/compile_commands.json`. Extract the `file` field from
each entry. These are the **original** source files (not `.matrix/preprocessed/`).

The SpecChecker preset's `compiler.conf` handles dialect constructs (e.g., C51's `sfr`,
`sbit`, `__interrupt`) via macro definitions, so clang can parse original sources directly
with those defines applied.

### 4. Clang Invocation

Run `clang.exe -fsyntax-only -w -I<...> -D<...> <source_file>` for each source file.

- `-fsyntax-only`: parse and type-check only, no code generation
- `-w`: suppress warnings, only surface errors
- Flags come entirely from SpecChecker's conf files (not from `compile_commands.json`
  compiler flags, which may contain toolchain-specific switches clang cannot parse)

Execution: **sequential with fail-fast**. Stop at the first file that has errors and
return immediately. In the failure case (systemic config error), this stops in seconds.
In the success case, all files are validated sequentially — clang `-fsyntax-only` is
fast enough (< 1s per file) that this is acceptable for typical embedded projects.

### 5. Error Cascade Deduplication

Before classifying errors, deduplicate cascades:

- Group errors by file, process in line order
- A `cannot open include file: X` at line N causes all subsequent
  `unknown type`, `undeclared identifier` errors in that file to be suppressed as
  non-root-cause cascades
- Only root-cause errors are classified and acted upon

---

## Error Handling Strategy

### Level 1: Missing Headers (tool-level auto-repair)

**Trigger**: Root-cause errors of the form `cannot open include file: 'xxx.h'`

**Action**: Self-healing loop within the tool (no agent call needed):
1. Collect all distinct missing header names from root-cause errors
2. Invoke stub generation logic (reuse `header-stub-generator` internals) for each
3. Re-write `.matrix/stubs/` with new stubs
4. Re-run `injectCompilationConfig` to inject the updated stubs path
5. Re-run clang pre-flight check
6. Repeat up to **3 iterations** (stubs may themselves include other missing headers)

If missing headers remain after 3 iterations, escalate to Level 2 / return to agent.

### Level 2: Wrong SpecChecker Preset (agent-level retry)

**Trigger**: After Level 1 stubs are resolved, widespread `unknown type` /
`undeclared identifier` errors persist across many files with platform-specific type names
(e.g., `uint8_t`, `__IO`, `sfr` variants), indicating the selected SpecChecker preset
does not match the project's actual platform.

**Action**: Return early to the agent with a structured error:

```json
{
  "action_required": "PREFLIGHT_WRONG_PRESET",
  "preflight_summary": {
    "files_checked": 24,
    "files_with_errors": 20,
    "error_pattern": "widespread platform type errors"
  },
  "suggested_presets": ["C51", "IAR_80", "ARM"],
  "preflight_errors": [
    { "file": "src/main.c", "line": 5, "message": "unknown type name 'uint8_t'" }
  ]
}
```

The agent retries `misra-checker` with an explicit `compiler` parameter (different preset).
The tool then restarts from Step 1 (`create`) with the new preset. Max 3 agent-level retries.

`suggested_presets` is derived from `selectSpecCheckerCompiler()` with alternative candidates
from the preset table (e.g., if `ARM` was tried, suggest `IAR_80`, `GNUC`).

### Level 3: Source Code Defects (allow through)

**Trigger**: A small number of isolated syntax errors confined to specific files, with no
systemic cross-file pattern. These are genuine bugs in the project source, not configuration
problems.

**Action**: Record in the response under `preflight_source_errors`, do **not** block the
`analyze` step. SpecChecker will re-report these with full rule context and violation IDs.

```json
{
  "preflight": "passed_with_source_errors",
  "preflight_source_errors": [
    { "file": "src/buggy.c", "line": 42, "message": "expected ';' after expression" }
  ]
}
```

---

## Decision Flow

```
clang pre-flight completes
  │
  ├─ No errors
  │    → preflight: "passed (N files)"
  │    → proceed to Step 2 (analyze) ✓
  │
  ├─ "cannot open include file" errors
  │    → auto-generate stubs → re-inject → re-check  (≤ 3 iterations)
  │         All resolved → proceed to analyze ✓
  │         Still unresolved → return PREFLIGHT_WRONG_PRESET or escalate to agent
  │
  ├─ Widespread platform type errors (after stubs resolved)
  │    → return PREFLIGHT_WRONG_PRESET to agent
  │    → agent retries with different compiler preset (≤ 3 times)
  │
  └─ Isolated source code errors (small count, no systemic pattern)
       → record as preflight_source_errors
       → proceed to analyze ✓
```

---

## Backward Compatibility

- `compile.log` is still read after `analyze` as a fallback (unchanged)
- The pre-flight is additive — it only adds Step 1.6, no existing steps are removed
- If clang binary is not found at the expected paths, Step 1.6 is silently skipped and
  the pipeline runs as before

---

## Affected Code

- **`src/tools/misra-checker.ts`**: Add `runPreflightCheck()` function and call it from
  `executeCheck()` between Step 1.5 and Step 2
- **`src/tools/misra-checker.ts`**: Add `findClangBinary(specHome)` helper
- **`src/tools/misra-checker.ts`**: Add `extractDefines(confContent)` helper (analogous to
  existing `extractIncludePaths`)
- No new files required; stub generation logic is inlined or imported from
  `header-stub-generator` internals

---

## Success Criteria

1. When configuration is wrong (missing headers or wrong preset), the error is detected and
   reported within seconds, not after 600 seconds
2. When configuration is correct, the pre-flight adds minimal overhead (clang `-fsyntax-only`
   on N files sequentially) and `analyze` runs only once
3. The agent-facing error format for Level 2 errors is compatible with existing error
   handling logic (same field names as current `compile.log` diagnostics)
4. Level 1 (missing headers) is fully automatic — no extra agent turns required for the
   common stub-generation case
