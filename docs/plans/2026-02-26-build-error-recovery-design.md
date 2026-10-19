# Design: Build Error Recovery — Syntax Error Auto-Fix & Compiler Search

**Date**: 2026-02-26
**Branch**: unit_AUnit
**Status**: Approved

## Problem

When `aunit_build` fails, two important failure cases are not handled:

1. **Compiler not found**: If the AUnit platform config references a compiler (gcc, armcc, cc1, etc.) that isn't on PATH, the build fails with a "command not found" error. Currently the tool has no mechanism to search for the compiler and add it to the build environment.

2. **Source code syntax errors**: If source files contain compiler-specific extensions (GCC `__attribute__`, ARMCC `__packed__`, etc.) or actual syntax errors, AUnit's parser fails. Currently the tool returns the raw error but doesn't classify, auto-fix, or report the modifications in the test report.

## Solution

Two-layer fix, keeping concerns separated:

| Concern | Layer | Rationale |
|---------|-------|-----------|
| Compiler not found → search + configure `path=` | `aunit_build.ts` tool | Pure environment problem, same layer as existing include retry logic |
| Syntax errors → auto-fix via code_preprocessor + report | unit-tester agent | Needs code understanding tools; agent has the context to decide fixability |

---

## Design A: Compiler Search in `aunit_build`

### Detection

Parse `stdout + stderr` for these patterns:
```
gcc: command not found
/bin/sh: armcc: not found
error: 'cc1' not found
make: armcc: No such file or directory
<name>: No such file or directory
```

Extract compiler name (e.g., `gcc`, `armcc`, `cc1`).

### Search Strategy (mirrors existing `resolveAunitCli` global search)

1. Check `process.env.PATH` directories — `which`/`where` lookup
2. Global filesystem search:
   - Windows: `where /R C:\ <name>` then `where /R D:\ <name>` etc.
   - Linux/macOS: `find /usr /opt /home -name <name> -type f`
3. Timeout: 60 seconds per search
4. Returns: absolute path to compiler binary, or `null` if not found

### Fix Application

If compiler found:
1. Extract directory: `dirname(foundPath)`
2. Call `addPathToConf(confPath, compilerDir)` — appends `path=<dir>` to universal.conf (same dedup logic as `addIncludesToConf`)
3. Retry build once
4. Return `compiler_fix: { compiler_name, found_at, conf_path, retry_succeeded }`

### New `addPathToConf` Helper (in `aunit-utils.ts`)

Same structure as `addIncludesToConf` but for `type: "path"` entries.

### Return Value New Fields

```ts
{
  status: "success" | "error",
  // ... existing fields ...
  compiler_fix: {
    compiler_name: string,         // e.g. "gcc"
    found_at: string,              // e.g. "C:/MinGW/bin/gcc.exe"
    added_to_conf: boolean,
    retry_succeeded: boolean,
  } | null,
  syntax_errors: Array<{
    file: string,
    line: number,
    column: number,
    type: "unknown_extension" | "implicit_declaration" | "unknown_type" | "syntax_error" | "other",
    message: string,
  }>,
}
```

### Error Pattern Classification (for `syntax_errors`)

| Pattern | Type |
|---------|------|
| `attribute '...' not supported`, `unknown attribute`, `__packed__`, `__asm__` | `unknown_extension` |
| `implicit declaration of function` | `implicit_declaration` |
| `unknown type name` | `unknown_type` |
| `expected ... before`, `error: expected`, `parse error` | `syntax_error` |
| anything else with `error:` | `other` |

---

## Design B: Syntax Error Auto-Fix in unit-tester Agent

### New Step 3 Sub-Procedure

After `aunit_build` returns with `syntax_errors`:

```
1. Group errors by source file
2. For each file with errors:
   a. If any error is type "unknown_extension":
      → Call code_preprocessor with the file path and detected compiler_dialect
      → Output to .matrix/preprocessed/<filename>
      → Record in source_modifications: {original, preprocessed, error_type, line, description, method}
   b. If error is "unknown_type" or "implicit_declaration":
      → Record as needing include fix (not preprocessor)
      → Add to source_modifications with method="建议添加对应 #include 头文件"
   c. If error is "syntax_error":
      → Record as cannot auto-fix, method="需人工修正"
3. If any files were preprocessed:
   → Retry aunit_build with source_paths pointing to .matrix/preprocessed/ versions
   → Maximum 1 auto-fix retry to avoid loops
4. Record all modifications (successful or not) in source_modifications list
```

### New Section in `unit-test.md`

```markdown
## 源代码修改记录

> 以下修改由单元测试工具链在分析构建阶段自动执行，用于解决编译障碍。

| 原始文件 | 错误类型 | 位置 | 错误描述 | 修改方式 | 修改结果 |
|---------|---------|------|---------|---------|---------|
| src/power.c | 方言扩展（__packed__） | 第42行 | attribute '__packed__' not supported | code_preprocessor 方言翻译 → .matrix/preprocessed/power.c | 修复成功，重新构建通过 |
| src/main.c  | 隐式函数声明           | 第8行  | implicit declaration of 'printf'    | 建议添加 #include <stdio.h> | 需人工处理 |
```

If no modifications, this section is omitted from the report.

---

## Files Changed

| File | Change |
|------|--------|
| `src/tools/aunit/aunit-utils.ts` | Add `addPathToConf()` helper |
| `src/tools/aunit/aunit-build.ts` | Add `parseCompilerNotFound()`, `searchCompilerGlobal()`, `parseSyntaxErrors()`, integrate into execute flow |
| `src/agents/unit-tester.ts` | Step 3: add syntax-error recovery sub-procedure; Step 10: add source_modifications report section |
| `skills/unit-testing/SKILL.md` | Step 3: sync syntax-error recovery; Step 10: sync report section |

No schema changes required (modifications are reported in markdown, not JSON).
