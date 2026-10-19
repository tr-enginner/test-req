# SpecChecker Compilation Environment Integration — Design

**Date**: 2026-02-25
**Branch**: `matrix-static`
**Status**: Approved

## Problem

The `specchecker` tool's `executeCheck` runs `create -p ... -s ... -a --clean` without
configuring the target compiler or include directories. This causes:

1. Default GNUC compiler config applied to all projects regardless of actual compiler
2. Missing project-specific include paths → SpecChecker parser errors
3. No `.matrix/stubs/` injection → missing vendor/RTOS/BSP headers

## Context

### SpecChecker Project Structure

After `specchecker.exe create`, a project contains:

```
workspace/<project>/
  emit/unit/
    analysis.conf    — source files + include dirs + output config
    compiler.conf    — compiler type + defines + preset includes + type sizes
    configset.ini    — project settings
  out/unit/          — output directory
```

### SpecChecker Preset Compilation Config Library

Located at `{specHome}/config/compilers/`, with 28+ presets:

| Preset | Conf File | Key Features |
|--------|-----------|-------------|
| ANSI | `ANSI/start.conf` | Baseline, `-t ANSI`, 16-bit int |
| ARM | `ARM/arm.conf` | `-d "__attribute__(n)="`, `-d "__packed="`, `-d "__irq="` |
| C51 | `C51/keil51.conf` | `-d "sfr=..."`, `-d "xdata="`, `-d "interrupt=_ign"` |
| GNUC | `GNUC/gnuc.conf` | `-d "__restrict="`, gnuc-compat.h preinclude |
| IAR_80 | `IAR_80/IAR_80.conf` | `-d "__interrupt="`, `-d "__packed="`, `-d "__no_init="` |
| DSP_C2000 | ... | TI DSP-specific |

Each `.conf` uses format:
```
-t <type>           # compiler type
-i "%install%/..."  # preset include dirs (%install% = specHome)
-d "keyword=..."    # dialect keyword neutralization
-s int=32           # type sizes
```

### The `-t` Flag

`specchecker.exe create -p ... -s ... -a --clean -t <compiler>` selects the preset
compiler config during project creation. After creation, `compiler.conf` contains the
selected preset's configuration with `%install%` paths resolved.

### Compilation Environment from Phase 1

The Analyst agent produces `.matrix/data/compilation-env.json` with:

```typescript
{
  compiler_dialect: "gcc" | "armcc" | "c51" | "iar" | ...,
  target_cpu: "cortex-m4" | "8051" | ...,
  include_dirs: string[],    // project-specific include paths
  defines: string[],         // project-specific preprocessor defines
  stubs: HeaderStub[],       // generated stub headers in .matrix/stubs/
  preprocessed_dir?: string  // dialect-translated sources
}
```

## Solution

### Approach: `-t` flag + analysis.conf supplementation with dedup

1. **Compiler selection**: Pass `-t <compiler>` to `create` command, mapped from
   `compilation-env.json` `compiler_dialect`
2. **Include dir injection**: After `create`, read existing `-i` paths from both
   `compiler.conf` and `analysis.conf`, then append only new paths from
   compilation-env.json and `.matrix/stubs/`

### Dialect → SpecChecker Mapping

```typescript
const DIALECT_TO_SPECCHECKER: Record<string, string> = {
  gcc: "GNUC",
  armcc: "ARM",
  armclang: "ARM",
  keil: "ARM",
  c51: "C51",
  iar: "IAR_80",
  greenhill: "GNUC",
  ti: "DSP_C2000",
  windriver: "GNUC",
  generic: "ANSI",
  auto: "ANSI",
}
```

### Dedup Logic

```
1. Run: specchecker.exe create -p ... -s ... -a --clean -t ${compiler}
2. Read compiler.conf → extract all -i paths → existingIncludes
3. Read analysis.conf → extract all -i paths → merge into existingIncludes
4. For each candidate path from (compilation-env include_dirs + .matrix/stubs/):
   - Normalize path (resolve, lowercase on Windows)
   - Skip if already in existingIncludes
   - Otherwise append `-i "path"` to analysis.conf
5. Run: specchecker.exe analyze ...
```

### Files to Modify

| File | Change |
|------|--------|
| `src/tools/misra-checker.ts` | Add `-t` flag, inject include dirs after create |
| `src/agents/static-analyzer.ts` | Update prompt to read compilation-env and pass compiler |

### New Tool Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `compiler` | string (optional) | SpecChecker compiler name (ARM, C51, GNUC, etc.) |
| `include_dirs` | string (optional) | JSON array of additional include directories |
| `defines` | string (optional) | JSON array of additional `-d` entries |

### Backward Compatibility

- All new parameters are optional
- Without compilation-env.json → defaults to GNUC (current behavior)
- Without include_dirs → only uses what `create` generated
- Existing tool calls work unchanged
