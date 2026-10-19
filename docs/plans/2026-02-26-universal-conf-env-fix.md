# Universal.conf Env-Fix & Build Retry Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Parse the AUnit project-local `universal.conf`, validate/fix env paths before build, and retry on failure by adding include paths from `<installDir>/includes/`.

**Architecture:** Add 4 utility functions to `aunit-utils.ts` (parse, resolve, write, scan-includes), then extend `aunit_build` to (a) patch the conf before building and (b) retry up to twice with more include dirs when build fails.

**Tech Stack:** Bun + TypeScript, Node.js `fs` / `path`, `bun:test`

---

## Background

After `aunit_create_project` runs, AUnit writes a copy of the platform's `universal.conf` to:

```
<project_dir>/.matrix/aunit/<project_name>/meta/data/common/base/universal.conf
```

Format:
```
# comment
env ARMCC_PATH=C:\Keil_v5\ARM\ARMCC
inc=C:\Keil_v5\ARM\include
path=C:\Keil_v5\ARM\bin
da CORTEX_M4=1
da __MICROLIB=
```

Rules:
- `env NAME=VALUE` — if VALUE looks like a path, check disk → system env → warn+skip
- `inc=PATH` — include search path (keep even if missing, warn)
- `path=DIR` — PATH addition (keep even if missing, warn)
- `da NAME=VALUE` — macro define (no validation)
- `#` lines and blank lines — preserve verbatim

---

### Task 1: Parse `universal.conf`

**Files:**
- Create: `tests/aunit/universal-conf.test.ts`
- Modify: `src/tools/aunit/aunit-utils.ts`

**Step 1: Write the failing test**

Create `tests/aunit/universal-conf.test.ts`:

```ts
import { test, expect, describe } from "bun:test"
import { mkdtempSync, writeFileSync, mkdirSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { parseUniversalConf } from "../../src/tools/aunit/aunit-utils"

const SAMPLE_CONF = `# Platform: ARM GNUC
env ARMCC_PATH=C:\\Keil_v5\\ARM\\ARMCC
env BUILD_JOBS=4
inc=C:\\Keil_v5\\ARM\\include
inc=C:\\Keil_v5\\ARM\\cmsis
path=C:\\Keil_v5\\ARM\\bin
da CORTEX_M4=1
da __MICROLIB=

# trailing comment
`

describe("parseUniversalConf", () => {
  let tmpDir: string
  let confPath: string

  function setup(content: string) {
    tmpDir = mkdtempSync(join(tmpdir(), "aunit-conf-"))
    confPath = join(tmpDir, "universal.conf")
    writeFileSync(confPath, content, "utf-8")
  }

  test("returns null for missing file", () => {
    const result = parseUniversalConf("/nonexistent/path/universal.conf")
    expect(result).toBeNull()
  })

  test("parses env entries", () => {
    setup(SAMPLE_CONF)
    const result = parseUniversalConf(confPath)
    expect(result).not.toBeNull()
    const envEntries = result!.entries.filter(e => e.type === "env")
    expect(envEntries).toHaveLength(2)
    expect(envEntries[0].name).toBe("ARMCC_PATH")
    expect(envEntries[0].value).toBe("C:\\Keil_v5\\ARM\\ARMCC")
    expect(envEntries[1].name).toBe("BUILD_JOBS")
    expect(envEntries[1].value).toBe("4")
  })

  test("parses inc entries", () => {
    setup(SAMPLE_CONF)
    const result = parseUniversalConf(confPath)!
    const incEntries = result.entries.filter(e => e.type === "inc")
    expect(incEntries).toHaveLength(2)
    expect(incEntries[0].value).toBe("C:\\Keil_v5\\ARM\\include")
    expect(incEntries[1].value).toBe("C:\\Keil_v5\\ARM\\cmsis")
  })

  test("parses path entries", () => {
    setup(SAMPLE_CONF)
    const result = parseUniversalConf(confPath)!
    const pathEntries = result.entries.filter(e => e.type === "path")
    expect(pathEntries).toHaveLength(1)
    expect(pathEntries[0].value).toBe("C:\\Keil_v5\\ARM\\bin")
  })

  test("parses da entries with and without value", () => {
    setup(SAMPLE_CONF)
    const result = parseUniversalConf(confPath)!
    const daEntries = result.entries.filter(e => e.type === "da")
    expect(daEntries).toHaveLength(2)
    expect(daEntries[0].name).toBe("CORTEX_M4")
    expect(daEntries[0].value).toBe("1")
    expect(daEntries[1].name).toBe("__MICROLIB")
    expect(daEntries[1].value).toBe("")
  })

  test("preserves comments and blank lines", () => {
    setup(SAMPLE_CONF)
    const result = parseUniversalConf(confPath)!
    const commentEntries = result.entries.filter(e => e.type === "comment")
    expect(commentEntries.length).toBeGreaterThanOrEqual(2)
    const blankEntries = result.entries.filter(e => e.type === "blank")
    expect(blankEntries.length).toBeGreaterThanOrEqual(1)
  })

  test("preserves raw line for round-trip", () => {
    setup(SAMPLE_CONF)
    const result = parseUniversalConf(confPath)!
    // Every entry must have raw
    for (const entry of result.entries) {
      expect(typeof entry.raw).toBe("string")
    }
  })
})
```

**Step 2: Run test to verify it fails**

```bash
cd D:\code\matrix-embedded-agent
bun test tests/aunit/universal-conf.test.ts
```

Expected: FAIL — `parseUniversalConf` not exported from `aunit-utils.ts`.

**Step 3: Add the interface and function to `aunit-utils.ts`**

Add after the existing imports at top of `src/tools/aunit/aunit-utils.ts`:

```ts
// ─── universal.conf types ───────────────────────────────────────────────────

export type UniversalConfEntryType = "env" | "inc" | "path" | "da" | "comment" | "blank" | "unknown"

export interface UniversalConfEntry {
  type: UniversalConfEntryType
  raw: string     // original line (without trailing newline)
  name?: string   // env / da: variable or macro name
  value?: string  // env / da / inc / path: the value portion
}

export interface ParsedUniversalConf {
  entries: UniversalConfEntry[]
}

/**
 * Parse <project>/meta/data/common/base/universal.conf
 * Returns null if the file doesn't exist.
 */
export function parseUniversalConf(confPath: string): ParsedUniversalConf | null {
  if (!existsSync(confPath)) return null

  const content = readFileSync(confPath, "utf-8")
  const entries: UniversalConfEntry[] = []

  for (const raw of content.split(/\r?\n/)) {
    const trimmed = raw.trim()

    if (trimmed === "") {
      entries.push({ type: "blank", raw })
      continue
    }
    if (trimmed.startsWith("#")) {
      entries.push({ type: "comment", raw })
      continue
    }

    // env NAME=VALUE
    const envMatch = trimmed.match(/^env\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (envMatch) {
      entries.push({ type: "env", raw, name: envMatch[1], value: envMatch[2] })
      continue
    }

    // inc=PATH
    const incMatch = trimmed.match(/^inc=(.*)$/)
    if (incMatch) {
      entries.push({ type: "inc", raw, value: incMatch[1] })
      continue
    }

    // path=DIR
    const pathMatch = trimmed.match(/^path=(.*)$/)
    if (pathMatch) {
      entries.push({ type: "path", raw, value: pathMatch[1] })
      continue
    }

    // da NAME=VALUE  (value may be empty)
    const daMatch = trimmed.match(/^da\s+([A-Za-z_][A-Za-z0-9_]*)(?:=(.*))?$/)
    if (daMatch) {
      entries.push({ type: "da", raw, name: daMatch[1], value: daMatch[2] ?? "" })
      continue
    }

    entries.push({ type: "unknown", raw })
  }

  return { entries }
}
```

**Step 4: Run test to verify it passes**

```bash
bun test tests/aunit/universal-conf.test.ts
```

Expected: All 8 tests PASS.

**Step 5: Commit**

```bash
git add src/tools/aunit/aunit-utils.ts tests/aunit/universal-conf.test.ts
git commit -m "feat: add parseUniversalConf to aunit-utils"
```

---

### Task 2: Resolve env paths (`resolveConfEnvPaths`)

**Files:**
- Modify: `src/tools/aunit/aunit-utils.ts`
- Modify: `tests/aunit/universal-conf.test.ts` (add new describe block)

**Step 1: Write failing tests**

Append to `tests/aunit/universal-conf.test.ts`:

```ts
import { resolveConfEnvPaths } from "../../src/tools/aunit/aunit-utils"
import { mkdirSync } from "fs"

describe("resolveConfEnvPaths", () => {
  let tmpDir: string

  test("keeps env value unchanged when path exists on disk", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "aunit-env-"))
    // tmpDir itself exists on disk
    const parsed: ParsedUniversalConf = {
      entries: [{ type: "env", raw: `env MYPATH=${tmpDir}`, name: "MYPATH", value: tmpDir }]
    }
    const { resolved, warnings } = resolveConfEnvPaths(parsed)
    const entry = resolved.entries.find(e => e.name === "MYPATH")!
    expect(entry.value).toBe(tmpDir)
    expect(warnings).toHaveLength(0)
  })

  test("resolves env value from process.env when disk path missing", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "aunit-env-"))
    process.env["FAKE_TOOL_PATH"] = tmpDir
    const parsed: ParsedUniversalConf = {
      entries: [{ type: "env", raw: "env FAKE_TOOL_PATH=C:\\nonexistent\\path", name: "FAKE_TOOL_PATH", value: "C:\\nonexistent\\path" }]
    }
    const { resolved, warnings } = resolveConfEnvPaths(parsed)
    const entry = resolved.entries.find(e => e.name === "FAKE_TOOL_PATH")!
    expect(entry.value).toBe(tmpDir)
    expect(warnings.some(w => w.includes("FAKE_TOOL_PATH"))).toBe(true)
    delete process.env["FAKE_TOOL_PATH"]
  })

  test("warns and skips env when path not found anywhere", () => {
    const parsed: ParsedUniversalConf = {
      entries: [{ type: "env", raw: "env GHOST_PATH=C:\\ghost\\nowhere", name: "GHOST_PATH", value: "C:\\ghost\\nowhere" }]
    }
    const { resolved, warnings } = resolveConfEnvPaths(parsed)
    const entry = resolved.entries.find(e => e.name === "GHOST_PATH")!
    // Value kept as-is (warn+skip means we keep original, just warn)
    expect(entry.value).toBe("C:\\ghost\\nowhere")
    expect(warnings.some(w => w.includes("GHOST_PATH") && w.includes("not found"))).toBe(true)
  })

  test("does not treat non-path env values as paths", () => {
    const parsed: ParsedUniversalConf = {
      entries: [{ type: "env", raw: "env BUILD_JOBS=4", name: "BUILD_JOBS", value: "4" }]
    }
    const { resolved, warnings } = resolveConfEnvPaths(parsed)
    const entry = resolved.entries.find(e => e.name === "BUILD_JOBS")!
    expect(entry.value).toBe("4")
    expect(warnings).toHaveLength(0)
  })

  test("does not modify inc/path/da entries", () => {
    const parsed: ParsedUniversalConf = {
      entries: [
        { type: "inc", raw: "inc=C:\\include", value: "C:\\include" },
        { type: "da", raw: "da FOO=1", name: "FOO", value: "1" },
      ]
    }
    const { resolved, warnings } = resolveConfEnvPaths(parsed)
    expect(resolved.entries[0].value).toBe("C:\\include")
    expect(resolved.entries[1].value).toBe("1")
    expect(warnings).toHaveLength(0)
  })
})
```

**Step 2: Run to verify failure**

```bash
bun test tests/aunit/universal-conf.test.ts 2>&1 | head -20
```

Expected: FAIL — `resolveConfEnvPaths` not exported.

**Step 3: Implement `resolveConfEnvPaths` in `aunit-utils.ts`**

Add after `parseUniversalConf`:

```ts
/** Returns true if a string looks like a filesystem path (not a plain number/word) */
function isPathLike(value: string): boolean {
  if (!value || value.trim() === "") return false
  // Contains path separators or Windows drive letters (C:\...)
  return /[/\\]/.test(value) || /^[A-Za-z]:/.test(value)
}

/**
 * Validate and resolve env path entries in a parsed universal.conf.
 *
 * For each `env NAME=VALUE` where VALUE looks like a path:
 * 1. existsSync(VALUE) → keep as-is
 * 2. process.env[NAME] and that value exists on disk → update VALUE, add note to warnings
 * 3. Neither → keep original VALUE, add warning
 *
 * inc/path/da entries are NOT modified.
 */
export function resolveConfEnvPaths(parsed: ParsedUniversalConf): {
  resolved: ParsedUniversalConf
  warnings: string[]
} {
  const warnings: string[] = []
  const entries = parsed.entries.map((entry): UniversalConfEntry => {
    if (entry.type !== "env" || !entry.name || !isPathLike(entry.value ?? "")) {
      return { ...entry }
    }

    const originalValue = entry.value!

    // 1. Exists on disk → keep
    if (existsSync(originalValue)) {
      return { ...entry }
    }

    // 2. Try system env var
    const sysVal = process.env[entry.name]
    if (sysVal && existsSync(sysVal)) {
      warnings.push(
        `env ${entry.name}: disk path "${originalValue}" not found; ` +
        `resolved via system env to "${sysVal}"`
      )
      const newRaw = entry.raw.replace(`=${originalValue}`, `=${sysVal}`)
      return { ...entry, value: sysVal, raw: newRaw }
    }

    // 3. Not found anywhere → warn, keep original
    warnings.push(
      `env ${entry.name}: path "${originalValue}" not found on disk or in system env — skipped`
    )
    return { ...entry }
  })

  return { resolved: { entries }, warnings }
}
```

**Step 4: Run tests**

```bash
bun test tests/aunit/universal-conf.test.ts
```

Expected: All tests PASS.

**Step 5: Commit**

```bash
git add src/tools/aunit/aunit-utils.ts tests/aunit/universal-conf.test.ts
git commit -m "feat: add resolveConfEnvPaths to aunit-utils"
```

---

### Task 3: Write conf back (`writeUniversalConf`)

**Files:**
- Modify: `src/tools/aunit/aunit-utils.ts`
- Modify: `tests/aunit/universal-conf.test.ts`

**Step 1: Write failing tests**

Append to `tests/aunit/universal-conf.test.ts`:

```ts
import { writeUniversalConf } from "../../src/tools/aunit/aunit-utils"
import { readFileSync } from "fs"

describe("writeUniversalConf", () => {
  test("round-trips a parsed conf without modification", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "aunit-write-"))
    const confPath = join(tmpDir, "universal.conf")
    const original = `# header\nenv FOO=bar\ninc=C:\\include\nda MACRO=1\n`
    writeFileSync(confPath, original, "utf-8")

    const parsed = parseUniversalConf(confPath)!
    writeUniversalConf(confPath, parsed)

    const roundTripped = readFileSync(confPath, "utf-8")
    expect(roundTripped).toBe(original)
  })

  test("writes modified env value back to file", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "aunit-write-"))
    const confPath = join(tmpDir, "universal.conf")
    writeFileSync(confPath, "env MYVAR=old_value\n", "utf-8")

    const parsed = parseUniversalConf(confPath)!
    // Simulate resolveConfEnvPaths updating the entry
    parsed.entries[0] = { ...parsed.entries[0], value: "new_value", raw: "env MYVAR=new_value" }
    writeUniversalConf(confPath, parsed)

    const written = readFileSync(confPath, "utf-8")
    expect(written).toContain("env MYVAR=new_value")
    expect(written).not.toContain("old_value")
  })

  test("appends new inc entries to existing conf", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "aunit-write-"))
    const confPath = join(tmpDir, "universal.conf")
    writeFileSync(confPath, "env X=1\ninc=original\n", "utf-8")

    const parsed = parseUniversalConf(confPath)!
    parsed.entries.push({ type: "inc", raw: "inc=added_path", value: "added_path" })
    writeUniversalConf(confPath, parsed)

    const written = readFileSync(confPath, "utf-8")
    expect(written).toContain("inc=original")
    expect(written).toContain("inc=added_path")
  })
})
```

**Step 2: Run to verify failure**

```bash
bun test tests/aunit/universal-conf.test.ts 2>&1 | grep "writeUniversalConf"
```

Expected: FAIL — not exported.

**Step 3: Implement `writeUniversalConf` in `aunit-utils.ts`**

Add after `resolveConfEnvPaths`:

```ts
/**
 * Write a ParsedUniversalConf back to disk.
 * Reconstructs from `raw` fields of each entry — so modifications to
 * `entry.raw` are what actually get written.
 */
export function writeUniversalConf(confPath: string, parsed: ParsedUniversalConf): void {
  const lines = parsed.entries.map(e => e.raw)
  // Join with OS newline; preserve trailing newline if last line was blank
  const content = lines.join("\n")
  const { writeFileSync } = await import("fs") // already imported at top — use synchronous
  // Note: writeFileSync is already imported at the top of aunit-utils.ts
  writeFileSync(confPath, content, "utf-8")
}
```

> **Important:** `writeFileSync` is already imported from `"fs"` in `aunit-utils.ts`. Do NOT add a new import. Just add the function body using the existing `writeFileSync`.

**Step 4: Run tests**

```bash
bun test tests/aunit/universal-conf.test.ts
```

Expected: All tests PASS.

**Step 5: Commit**

```bash
git add src/tools/aunit/aunit-utils.ts tests/aunit/universal-conf.test.ts
git commit -m "feat: add writeUniversalConf to aunit-utils"
```

---

### Task 4: Collect install includes (`collectInstallIncludes`)

**Files:**
- Modify: `src/tools/aunit/aunit-utils.ts`
- Modify: `tests/aunit/universal-conf.test.ts`

**Step 1: Write failing tests**

Append to `tests/aunit/universal-conf.test.ts`:

```ts
import { collectInstallIncludes } from "../../src/tools/aunit/aunit-utils"

describe("collectInstallIncludes", () => {
  test("returns empty array when includes dir does not exist", () => {
    const result = collectInstallIncludes("/nonexistent/installDir")
    expect(result).toEqual([])
  })

  test("returns immediate subdirectories of includes/", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "aunit-inst-"))
    const includesDir = join(tmpDir, "includes")
    mkdirSync(join(includesDir, "ARM"), { recursive: true })
    mkdirSync(join(includesDir, "CMSIS"), { recursive: true })
    mkdirSync(join(includesDir, "FreeRTOS"), { recursive: true })

    const result = collectInstallIncludes(tmpDir)
    const names = result.map(p => p.split(/[\\/]/).pop())
    expect(names).toContain("ARM")
    expect(names).toContain("CMSIS")
    expect(names).toContain("FreeRTOS")
    expect(result).toHaveLength(3)
  })

  test("returns nested subdirectories recursively", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "aunit-inst-"))
    mkdirSync(join(tmpDir, "includes", "ARM", "CMSIS"), { recursive: true })
    mkdirSync(join(tmpDir, "includes", "ARM", "Core"), { recursive: true })

    const result = collectInstallIncludes(tmpDir)
    // Should include ARM, ARM/CMSIS, ARM/Core
    expect(result.length).toBeGreaterThanOrEqual(3)
  })

  test("deduplicates paths", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "aunit-inst-"))
    mkdirSync(join(tmpDir, "includes", "common"), { recursive: true })

    const result = collectInstallIncludes(tmpDir)
    const unique = new Set(result)
    expect(unique.size).toBe(result.length)
  })

  test("returns only directories, not files", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "aunit-inst-"))
    const incDir = join(tmpDir, "includes")
    mkdirSync(join(incDir, "sub"), { recursive: true })
    writeFileSync(join(incDir, "readme.txt"), "hello", "utf-8")

    const result = collectInstallIncludes(tmpDir)
    expect(result.every(p => !p.endsWith(".txt"))).toBe(true)
  })
})
```

**Step 2: Run to verify failure**

```bash
bun test tests/aunit/universal-conf.test.ts 2>&1 | grep "collectInstallIncludes"
```

**Step 3: Implement `collectInstallIncludes` in `aunit-utils.ts`**

Add the needed import at the top (add `readdirSync` to the existing `fs` import if not already present):

```ts
// At top of file — merge into existing import:
import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs"
```

Then add the function:

```ts
/**
 * Collect all subdirectories under <installDir>/includes/ recursively.
 * Used to find candidate include paths when a build fails with missing headers.
 * Returns absolute, deduplicated, normalized paths. Empty array if includes/ doesn't exist.
 */
export function collectInstallIncludes(installDir: string): string[] {
  const includesRoot = join(normalizePath(installDir), "includes")
  if (!existsSync(includesRoot)) return []

  const results = new Set<string>()

  function scanDir(dir: string): void {
    let entries: ReturnType<typeof readdirSync>
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const subPath = join(dir, entry.name)
        results.add(normalizePath(subPath))
        scanDir(subPath)
      }
    }
  }

  scanDir(includesRoot)
  return Array.from(results)
}
```

**Step 4: Run tests**

```bash
bun test tests/aunit/universal-conf.test.ts
```

Expected: All tests PASS.

**Step 5: Run typecheck**

```bash
bun run typecheck
```

Expected: No errors. Fix any if found.

**Step 6: Commit**

```bash
git add src/tools/aunit/aunit-utils.ts tests/aunit/universal-conf.test.ts
git commit -m "feat: add collectInstallIncludes to aunit-utils"
```

---

### Task 5: Pre-build conf patching in `aunit_build`

**Files:**
- Modify: `src/tools/aunit/aunit-build.ts`

**Step 1: Write failing integration test**

Create `tests/aunit/aunit-build-conf.test.ts`:

```ts
/**
 * Integration test: aunit_build patches universal.conf before build.
 *
 * Since we can't run a real AUnit build in CI, we verify the conf-patching
 * side effect: after aunit_build is called with a missing AUnit CLI, it should
 * still have attempted to read+patch the conf (verified by checking the written conf).
 *
 * We use a real tempdir project structure with a mock universal.conf.
 */
import { test, expect, describe, beforeEach } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { parseUniversalConf } from "../../src/tools/aunit/aunit-utils"

const CONF_CONTENT = `env VALID_PATH=__TMPDIR__
env MISSING_PATH=C:\\ghost\\nowhere
inc=C:\\original\\include
da TEST_MACRO=1
`

describe("aunit_build conf pre-patch (unit)", () => {
  let projectDir: string
  let projectName: string
  let confPath: string

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "aunit-proj-"))
    projectName = "TestProject"
    const confDir = join(projectDir, ".matrix", "aunit", projectName, "meta", "data", "common", "base")
    mkdirSync(confDir, { recursive: true })
    confPath = join(confDir, "universal.conf")
    // Replace __TMPDIR__ placeholder with actual existing path
    writeFileSync(confPath, CONF_CONTENT.replace("__TMPDIR__", projectDir), "utf-8")
  })

  test("conf file is patched: VALID_PATH kept, MISSING_PATH warned", () => {
    // Import the patchUniversalConf function (it's a helper we'll export for testing)
    const { patchUniversalConf } = require("../../src/tools/aunit/aunit-build")

    const { warnings } = patchUniversalConf(confPath)

    // Conf should still exist and be parseable
    expect(existsSync(confPath)).toBe(true)
    const parsed = parseUniversalConf(confPath)!

    const validEntry = parsed.entries.find(e => e.name === "VALID_PATH")
    expect(validEntry?.value).toBe(projectDir)

    const missingEntry = parsed.entries.find(e => e.name === "MISSING_PATH")
    expect(missingEntry?.value).toBe("C:\\ghost\\nowhere") // unchanged

    expect(warnings.some((w: string) => w.includes("MISSING_PATH"))).toBe(true)
  })

  test("patchUniversalConf returns no warnings when conf missing", () => {
    const { patchUniversalConf } = require("../../src/tools/aunit/aunit-build")
    const { warnings } = patchUniversalConf("/nonexistent/conf")
    expect(warnings).toEqual([])
  })
})
```

**Step 2: Run to verify failure**

```bash
bun test tests/aunit/aunit-build-conf.test.ts
```

Expected: FAIL — `patchUniversalConf` not exported.

**Step 3: Extract and implement `patchUniversalConf` in `aunit-build.ts`**

At the top of `aunit-build.ts`, add imports:

```ts
import { resolve } from "path"
import {
  resolveAunitCli,
  execAunit,
  buildArgs,
  normalizePath,
  AUNIT_WORKSPACE,
  parseUniversalConf,
  resolveConfEnvPaths,
  writeUniversalConf,
  collectInstallIncludes,
} from "./aunit-utils"
```

Add the exported helper function before the `aunitBuild` tool definition:

```ts
/**
 * Read, validate, and patch the project-local universal.conf in place.
 * Returns warnings from env path resolution.
 * Safe to call with a non-existent path — returns empty warnings.
 *
 * @exported for testing
 */
export function patchUniversalConf(confPath: string): { warnings: string[] } {
  const parsed = parseUniversalConf(confPath)
  if (!parsed) return { warnings: [] }

  const { resolved, warnings } = resolveConfEnvPaths(parsed)
  writeUniversalConf(confPath, resolved)
  return { warnings }
}
```

Then in the `execute` handler, add the patching step right before `execAunit`:

```ts
async execute({ project_name, source_paths, aunit_path, project_dir }) {
  let cliPath: string
  let installDir: string
  try {
    const cli = resolveAunitCli(aunit_path)
    cliPath = cli.cliPath
    installDir = cli.installDir
  } catch (err) {
    return JSON.stringify({
      status: "abnormal",
      error: err instanceof Error ? err.message : String(err),
    })
  }

  const projectPath = resolve(normalizePath(project_dir), AUNIT_WORKSPACE, project_name)

  // ── Pre-build: patch universal.conf env paths ──────────────────────────
  const confPath = resolve(
    normalizePath(project_dir),
    AUNIT_WORKSPACE,
    project_name,
    "meta", "data", "common", "base", "universal.conf"
  )
  const { warnings: confWarnings } = patchUniversalConf(confPath)

  const args = buildArgs({
    "-pp": projectPath,
    "-src": source_paths,
  })

  const result = execAunit(cliPath, installDir, "ut", "build", args)

  if (result.exitCode !== 0 && !result.stdout.includes("success")) {
    return JSON.stringify({
      status: "error",
      exit_code: result.exitCode,
      message: "AUnit build failed",
      conf_path: confPath,
      conf_modifications: { env_warnings: confWarnings, inc_added: [], retry_count: 0 },
      stdout: result.stdout.slice(0, 5000),
      stderr: result.stderr.slice(0, 3000),
    })
  }

  return JSON.stringify({
    status: "success",
    project_name,
    conf_path: confPath,
    conf_modifications: { env_warnings: confWarnings, inc_added: [] },
    stdout: result.stdout.slice(0, 5000),
  })
},
```

**Step 4: Run tests**

```bash
bun test tests/aunit/aunit-build-conf.test.ts
```

Expected: PASS.

**Step 5: Typecheck**

```bash
bun run typecheck
```

**Step 6: Commit**

```bash
git add src/tools/aunit/aunit-build.ts tests/aunit/aunit-build-conf.test.ts
git commit -m "feat: patch universal.conf env paths before aunit_build"
```

---

### Task 6: Retry-on-failure loop with `includes/` scanning

**Files:**
- Modify: `src/tools/aunit/aunit-build.ts`
- Modify: `tests/aunit/aunit-build-conf.test.ts`

**Step 1: Write failing tests**

Append to `tests/aunit/aunit-build-conf.test.ts`:

```ts
import { addIncludesToConf } from "../../src/tools/aunit/aunit-build"

describe("addIncludesToConf", () => {
  test("appends new inc entries not already present in conf", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "aunit-retry-"))
    const confPath = join(tmpDir, "universal.conf")
    writeFileSync(confPath, "env X=1\ninc=C:\\existing\n", "utf-8")

    const newPaths = ["C:\\new\\path1", "C:\\new\\path2", "C:\\existing"]
    const added = addIncludesToConf(confPath, newPaths)

    const parsed = parseUniversalConf(confPath)!
    const incValues = parsed.entries.filter(e => e.type === "inc").map(e => e.value)
    expect(incValues).toContain("C:\\existing")
    expect(incValues).toContain("C:\\new\\path1")
    expect(incValues).toContain("C:\\new\\path2")
    // Only truly new paths returned
    expect(added).toHaveLength(2)
    expect(added).toContain("C:\\new\\path1")
    expect(added).not.toContain("C:\\existing")
  })

  test("returns empty array when conf does not exist", () => {
    const result = addIncludesToConf("/nonexistent/conf", ["C:\\some\\path"])
    expect(result).toEqual([])
  })
})
```

**Step 2: Run to verify failure**

```bash
bun test tests/aunit/aunit-build-conf.test.ts 2>&1 | grep "addIncludesToConf"
```

**Step 3: Implement `addIncludesToConf` and the retry loop in `aunit-build.ts`**

Add the helper after `patchUniversalConf`:

```ts
/**
 * Add new include directories to universal.conf (only those not already present).
 * Returns the list of paths actually added.
 *
 * @exported for testing
 */
export function addIncludesToConf(confPath: string, newPaths: string[]): string[] {
  const parsed = parseUniversalConf(confPath)
  if (!parsed) return []

  const existing = new Set(
    parsed.entries
      .filter(e => e.type === "inc")
      .map(e => normalizePath(e.value ?? ""))
  )

  const added: string[] = []
  for (const p of newPaths) {
    const normalized = normalizePath(p)
    if (!existing.has(normalized)) {
      parsed.entries.push({ type: "inc", raw: `inc=${p}`, value: p })
      existing.add(normalized)
      added.push(p)
    }
  }

  if (added.length > 0) {
    writeUniversalConf(confPath, parsed)
  }
  return added
}
```

Now replace the `execute` body in `aunitBuild` with the retry loop version:

```ts
async execute({ project_name, source_paths, aunit_path, project_dir }) {
  let cliPath: string
  let installDir: string
  try {
    const cli = resolveAunitCli(aunit_path)
    cliPath = cli.cliPath
    installDir = cli.installDir
  } catch (err) {
    return JSON.stringify({
      status: "abnormal",
      error: err instanceof Error ? err.message : String(err),
    })
  }

  const projectPath = resolve(normalizePath(project_dir), AUNIT_WORKSPACE, project_name)
  const confPath = resolve(
    normalizePath(project_dir),
    AUNIT_WORKSPACE,
    project_name,
    "meta", "data", "common", "base", "universal.conf"
  )

  // ── Step 1: Patch env paths in universal.conf ─────────────────────────
  const { warnings: confWarnings } = patchUniversalConf(confPath)

  const args = buildArgs({
    "-pp": projectPath,
    "-src": source_paths,
  })

  // ── Step 2: Build with retry loop (max 2 retries = 3 total attempts) ──
  const allIncAdded: string[] = []
  let lastResult = execAunit(cliPath, installDir, "ut", "build", args)

  const MAX_RETRIES = 2
  const availableIncludes = collectInstallIncludes(installDir)

  for (let retry = 0; retry < MAX_RETRIES && (lastResult.exitCode !== 0 && !lastResult.stdout.includes("success")); retry++) {
    // On each retry, add the next batch of include paths from installDir/includes/
    // Round 1 (retry=0): add all available includes
    // Round 2 (retry=1): already added all — nothing more to try
    if (availableIncludes.length === 0) break

    const added = addIncludesToConf(confPath, availableIncludes)
    if (added.length === 0) break  // Nothing new to add — stop retrying

    allIncAdded.push(...added)
    lastResult = execAunit(cliPath, installDir, "ut", "build", args)
  }

  if (lastResult.exitCode !== 0 && !lastResult.stdout.includes("success")) {
    return JSON.stringify({
      status: "error",
      exit_code: lastResult.exitCode,
      message: "AUnit build failed after retries",
      conf_path: confPath,
      conf_modifications: {
        env_warnings: confWarnings,
        inc_added: allIncAdded,
        retry_count: Math.min(MAX_RETRIES, allIncAdded.length > 0 ? MAX_RETRIES : 0),
      },
      stdout: lastResult.stdout.slice(0, 5000),
      stderr: lastResult.stderr.slice(0, 3000),
    })
  }

  return JSON.stringify({
    status: "success",
    project_name,
    conf_path: confPath,
    conf_modifications: {
      env_warnings: confWarnings,
      inc_added: allIncAdded,
      retry_count: allIncAdded.length > 0 ? 1 : 0,
    },
    stdout: lastResult.stdout.slice(0, 5000),
  })
},
```

**Step 4: Run all aunit tests**

```bash
bun test tests/aunit/
```

Expected: All tests PASS.

**Step 5: Run typecheck**

```bash
bun run typecheck
```

Expected: No errors.

**Step 6: Commit**

```bash
git add src/tools/aunit/aunit-build.ts tests/aunit/aunit-build-conf.test.ts
git commit -m "feat: retry aunit_build with expanded includes/ on failure"
```

---

### Task 7: Final verification

**Step 1: Run full test suite**

```bash
bun test
```

Expected: All tests PASS.

**Step 2: Run typecheck**

```bash
bun run typecheck
```

Expected: Clean.

**Step 3: Build**

```bash
bun run build
```

Expected: `dist/index.js` produced with no errors.

**Step 4: Final commit if any lint fixes needed**

```bash
git add -A
git commit -m "chore: fix any typecheck issues after universal.conf feature"
```

---

## Summary of Changes

| File | What Changed |
|------|-------------|
| `src/tools/aunit/aunit-utils.ts` | +`ParsedUniversalConf`, +`UniversalConfEntry`, +`parseUniversalConf`, +`resolveConfEnvPaths`, +`writeUniversalConf`, +`collectInstallIncludes` |
| `src/tools/aunit/aunit-build.ts` | +`patchUniversalConf`, +`addIncludesToConf`, retry loop in `execute` |
| `tests/aunit/universal-conf.test.ts` | New: unit tests for all 4 utility functions |
| `tests/aunit/aunit-build-conf.test.ts` | New: unit tests for `patchUniversalConf` + `addIncludesToConf` |
