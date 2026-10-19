/**
 * Build system detection and parsing.
 *
 * Extracts include directories, preprocessor defines, source file lists,
 * and compiler flags from various embedded build systems.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "fs"
import { basename, dirname, join, resolve, extname, relative } from "path"

export interface BuildInfo {
  includes: string[]
  defines: string[]
  sources: string[]
  compiler_flags: string[]
}

/** Supported C/C++ file extensions */
const SOURCE_EXTENSIONS = new Set([".c", ".cpp", ".cc", ".cxx", ".s", ".S"])
const HEADER_EXTENSIONS = new Set([".h", ".hpp", ".hh", ".hxx"])

function emptyBuildInfo(): BuildInfo {
  return { includes: [], defines: [], sources: [], compiler_flags: [] }
}

function unique(arr: string[]): string[] {
  return [...new Set(arr)]
}

// ---------------------------------------------------------------------------
// Makefile parser
// ---------------------------------------------------------------------------
export function parseMakefile(makefilePath: string): BuildInfo {
  const info = emptyBuildInfo()
  if (!existsSync(makefilePath)) return info

  const content = readFileSync(makefilePath, "utf-8")
  const lines = content.split("\n")

  // Combine continuation lines (ending with \)
  const merged: string[] = []
  let current = ""
  for (const line of lines) {
    if (line.trimEnd().endsWith("\\")) {
      current += line.trimEnd().slice(0, -1) + " "
    } else {
      current += line
      merged.push(current)
      current = ""
    }
  }
  if (current) merged.push(current)

  const baseDir = dirname(makefilePath)

  for (const line of merged) {
    // Skip comments
    const trimmed = line.replace(/#.*$/, "").trim()
    if (!trimmed) continue

    // Extract -I flags
    const includeMatches = trimmed.matchAll(/-I\s*"?([^"\s]+)"?/g)
    for (const m of includeMatches) {
      info.includes.push(resolve(baseDir, m[1]))
    }

    // Extract -D flags
    const defineMatches = trimmed.matchAll(/-D\s*"?([^"\s]+)"?/g)
    for (const m of defineMatches) {
      info.defines.push(m[1])
    }

    // Extract C_SOURCES, SOURCES, SRC, SRCS variable assignments
    const srcAssign = trimmed.match(
      /^(?:C_SOURCES|SOURCES|SRC|SRCS|C_SRC|CPP_SOURCES)\s*[+:]?=\s*(.+)/,
    )
    if (srcAssign) {
      const files = srcAssign[1].trim().split(/\s+/)
      for (const f of files) {
        if (f && SOURCE_EXTENSIONS.has(extname(f))) {
          info.sources.push(resolve(baseDir, f))
        }
      }
    }

    // Extract CFLAGS, CPPFLAGS variable assignments
    const cflagsAssign = trimmed.match(
      /^(?:CFLAGS|CPPFLAGS|C_FLAGS|COMMON_FLAGS)\s*[+:]?=\s*(.+)/,
    )
    if (cflagsAssign) {
      const flags = cflagsAssign[1].trim().split(/\s+/)
      for (const flag of flags) {
        if (flag.startsWith("-I")) {
          const path = flag.slice(2) || ""
          if (path) info.includes.push(resolve(baseDir, path))
        } else if (flag.startsWith("-D")) {
          info.defines.push(flag.slice(2))
        } else if (flag.startsWith("-")) {
          info.compiler_flags.push(flag)
        }
      }
    }

    // Extract C_INCLUDES variable
    const includeAssign = trimmed.match(
      /^(?:C_INCLUDES|INCLUDES|INC_DIRS|INCLUDE_DIRS)\s*[+:]?=\s*(.+)/,
    )
    if (includeAssign) {
      const parts = includeAssign[1].trim().split(/\s+/)
      for (const p of parts) {
        const path = p.startsWith("-I") ? p.slice(2) : p
        if (path) info.includes.push(resolve(baseDir, path))
      }
    }

    // Extract C_DEFS variable
    const defAssign = trimmed.match(
      /^(?:C_DEFS|DEFINES|DEFS)\s*[+:]?=\s*(.+)/,
    )
    if (defAssign) {
      const parts = defAssign[1].trim().split(/\s+/)
      for (const p of parts) {
        const def = p.startsWith("-D") ? p.slice(2) : p
        if (def) info.defines.push(def)
      }
    }
  }

  info.includes = unique(info.includes)
  info.defines = unique(info.defines)
  info.sources = unique(info.sources)
  return info
}

// ---------------------------------------------------------------------------
// CMakeLists.txt parser (simplified)
// ---------------------------------------------------------------------------
export function parseCMakeLists(cmakePath: string): BuildInfo {
  const info = emptyBuildInfo()
  if (!existsSync(cmakePath)) return info

  const content = readFileSync(cmakePath, "utf-8")
  const baseDir = dirname(cmakePath)

  // Extract include_directories / target_include_directories
  const includePattern =
    /(?:target_)?include_directories\s*\([^)]*?(?:PUBLIC|PRIVATE|INTERFACE)?\s*([\s\S]*?)\)/gi
  for (const m of content.matchAll(includePattern)) {
    const body = m[1]
    const dirs = body
      .replace(/#[^\n]*/g, "") // remove comments
      .split(/\s+/)
      .filter((d) => d && !["PUBLIC", "PRIVATE", "INTERFACE"].includes(d))
    for (const d of dirs) {
      if (!d.startsWith("$")) {
        info.includes.push(resolve(baseDir, d))
      }
    }
  }

  // Extract add_definitions / target_compile_definitions
  const defPattern =
    /(?:target_)?(?:add_definitions|compile_definitions)\s*\(([^)]*)\)/gi
  for (const m of content.matchAll(defPattern)) {
    const body = m[1]
    const defs = body
      .replace(/#[^\n]*/g, "")
      .split(/\s+/)
      .filter((d) => d && !["PUBLIC", "PRIVATE", "INTERFACE"].includes(d))
    for (const d of defs) {
      info.defines.push(d.replace(/^-D/, ""))
    }
  }

  // Extract source files from add_executable / add_library
  const srcPattern = /(?:add_executable|add_library)\s*\(\s*\w+\s+([\s\S]*?)\)/gi
  for (const m of content.matchAll(srcPattern)) {
    const body = m[1]
    const files = body
      .replace(/#[^\n]*/g, "")
      .split(/\s+/)
      .filter((f) => f && SOURCE_EXTENSIONS.has(extname(f)))
    for (const f of files) {
      if (!f.startsWith("$")) {
        info.sources.push(resolve(baseDir, f))
      }
    }
  }

  // Extract set(CMAKE_C_FLAGS ...)
  const cflagsPattern = /set\s*\(\s*CMAKE_C_FLAGS\s+"([^"]*)"\s*\)/gi
  for (const m of content.matchAll(cflagsPattern)) {
    const flags = m[1].split(/\s+/)
    for (const flag of flags) {
      if (flag.startsWith("-I")) {
        info.includes.push(resolve(baseDir, flag.slice(2)))
      } else if (flag.startsWith("-D")) {
        info.defines.push(flag.slice(2))
      } else if (flag.startsWith("-")) {
        info.compiler_flags.push(flag)
      }
    }
  }

  info.includes = unique(info.includes)
  info.defines = unique(info.defines)
  info.sources = unique(info.sources)
  return info
}

// ---------------------------------------------------------------------------
// Keil MDK .uvprojx parser (XML)
// ---------------------------------------------------------------------------
export function parseKeilProject(uvprojxPath: string): BuildInfo {
  const info = emptyBuildInfo()
  if (!existsSync(uvprojxPath)) return info

  const content = readFileSync(uvprojxPath, "utf-8")
  const baseDir = dirname(uvprojxPath)

  // Extract <IncludePath>path1;path2;...</IncludePath>
  const includeMatch = content.match(/<IncludePath>([\s\S]*?)<\/IncludePath>/i)
  if (includeMatch) {
    const paths = includeMatch[1].split(";").map((p) => p.trim()).filter(Boolean)
    for (const p of paths) {
      info.includes.push(resolve(baseDir, p))
    }
  }

  // Extract <Define>DEF1,DEF2,...</Define>
  const defineMatch = content.match(/<Define>([\s\S]*?)<\/Define>/i)
  if (defineMatch) {
    const defs = defineMatch[1].split(/[,;\s]+/).map((d) => d.trim()).filter(Boolean)
    info.defines.push(...defs)
  }

  // Extract <MiscControls> for additional flags
  const miscMatch = content.match(/<MiscControls>([\s\S]*?)<\/MiscControls>/i)
  if (miscMatch) {
    const flags = miscMatch[1].trim().split(/\s+/)
    for (const flag of flags) {
      if (flag.startsWith("-I")) {
        info.includes.push(resolve(baseDir, flag.slice(2)))
      } else if (flag.startsWith("-D")) {
        info.defines.push(flag.slice(2))
      } else if (flag) {
        info.compiler_flags.push(flag)
      }
    }
  }

  // Extract <FilePath> entries for source files
  const filePathMatches = content.matchAll(/<FilePath>([\s\S]*?)<\/FilePath>/gi)
  for (const m of filePathMatches) {
    const fp = m[1].trim()
    if (SOURCE_EXTENSIONS.has(extname(fp))) {
      info.sources.push(resolve(baseDir, fp))
    }
  }

  // Extract <uAC6> to detect ARM Compiler version
  if (content.includes("<uAC6>1</uAC6>")) {
    info.compiler_flags.push("--dialect=armclang")
  }

  info.includes = unique(info.includes)
  info.defines = unique(info.defines)
  info.sources = unique(info.sources)
  return info
}

// ---------------------------------------------------------------------------
// IAR EWARM .ewp parser (XML)
// ---------------------------------------------------------------------------
export function parseIARProject(ewpPath: string): BuildInfo {
  const info = emptyBuildInfo()
  if (!existsSync(ewpPath)) return info

  const content = readFileSync(ewpPath, "utf-8")
  const baseDir = dirname(ewpPath)

  // IAR uses <option><name>CCIncludePath2</name><state>path</state></option>
  const includeBlocks = content.matchAll(
    /<option>\s*<name>CCIncludePath2<\/name>([\s\S]*?)<\/option>/gi,
  )
  for (const block of includeBlocks) {
    const stateMatches = block[1].matchAll(/<state>([\s\S]*?)<\/state>/gi)
    for (const s of stateMatches) {
      const p = s[1].trim().replace(/\$PROJ_DIR\$[\\/]?/g, "")
      if (p) info.includes.push(resolve(baseDir, p))
    }
  }

  // IAR defines: <name>CCDefines</name><state>DEF</state>
  const defineBlocks = content.matchAll(
    /<option>\s*<name>CCDefines<\/name>([\s\S]*?)<\/option>/gi,
  )
  for (const block of defineBlocks) {
    const stateMatches = block[1].matchAll(/<state>([\s\S]*?)<\/state>/gi)
    for (const s of stateMatches) {
      const d = s[1].trim()
      if (d) info.defines.push(d)
    }
  }

  // Extract <file><name>path</name></file> entries
  const fileMatches = content.matchAll(
    /<file>\s*<name>([\s\S]*?)<\/name>/gi,
  )
  for (const m of fileMatches) {
    const fp = m[1].trim().replace(/\$PROJ_DIR\$[\\/]?/g, "")
    if (SOURCE_EXTENSIONS.has(extname(fp))) {
      info.sources.push(resolve(baseDir, fp))
    }
  }

  // IAR extra CFLAGS
  const extraBlocks = content.matchAll(
    /<option>\s*<name>IccAdditionalFlags<\/name>([\s\S]*?)<\/option>/gi,
  )
  for (const block of extraBlocks) {
    const stateMatches = block[1].matchAll(/<state>([\s\S]*?)<\/state>/gi)
    for (const s of stateMatches) {
      const flags = s[1].trim().split(/\s+/)
      info.compiler_flags.push(...flags.filter(Boolean))
    }
  }

  info.includes = unique(info.includes)
  info.defines = unique(info.defines)
  info.sources = unique(info.sources)
  return info
}

// ---------------------------------------------------------------------------
// Eclipse CDT .cproject parser (XML)
// ---------------------------------------------------------------------------
export function parseEclipseCProject(cprojectPath: string): BuildInfo {
  const info = emptyBuildInfo()
  if (!existsSync(cprojectPath)) return info

  const content = readFileSync(cprojectPath, "utf-8")
  const baseDir = dirname(cprojectPath)

  // Extract includePath entries
  const includeMatches = content.matchAll(
    /<listOptionValue\s[^>]*value="([^"]*)"[^>]*\/>\s*<!--\s*includePath/gi,
  )
  for (const m of includeMatches) {
    info.includes.push(resolve(baseDir, m[1]))
  }

  // More common format: <option ... superClass="...include.paths...">
  //   <listOptionValue ... value="path"/>
  const includeBlocks = content.matchAll(
    /<option[^>]*superClass="[^"]*include[^"]*"[^>]*>([\s\S]*?)<\/option>/gi,
  )
  for (const block of includeBlocks) {
    const valueMatches = block[1].matchAll(
      /value="([^"]*(?:&quot;[^"]*)?)"(?:\s|\/|>)/gi,
    )
    for (const v of valueMatches) {
      const p = v[1]
        .replace(/&quot;/g, '"')
        .replace(/\$\{[\w.]+\}\/?/g, "")
        .trim()
      if (p) info.includes.push(resolve(baseDir, p))
    }
  }

  // Extract define entries
  const defineBlocks = content.matchAll(
    /<option[^>]*superClass="[^"]*definedSymbols[^"]*"[^>]*>([\s\S]*?)<\/option>/gi,
  )
  for (const block of defineBlocks) {
    const valueMatches = block[1].matchAll(/value="([^"]*)"/gi)
    for (const v of valueMatches) {
      if (v[1]) info.defines.push(v[1])
    }
  }

  info.includes = unique(info.includes)
  info.defines = unique(info.defines)

  // Eclipse projects store source in the workspace; scan for .c/.cpp files
  info.sources = scanSourceFiles(baseDir)
  return info
}

// ---------------------------------------------------------------------------
// Fallback: infer from source directory structure
// ---------------------------------------------------------------------------
export function inferFromSource(sourcePath: string): BuildInfo {
  const info = emptyBuildInfo()
  if (!existsSync(sourcePath)) return info

  // Collect all source and header files
  info.sources = scanSourceFiles(sourcePath)
  const headerDirs = new Set<string>()

  scanFilesRecursive(sourcePath, (filePath) => {
    if (HEADER_EXTENSIONS.has(extname(filePath))) {
      headerDirs.add(dirname(filePath))
    }
  })

  info.includes = [...headerDirs]

  // Scan source for common #ifdef guards to infer platform defines
  const defineHints = new Set<string>()
  const definePatterns = [
    /^#\s*if(?:def)?\s+(\w+)/,
    /defined\s*\(\s*(\w+)\s*\)/,
  ]

  // Well-known platform defines to look for
  const platformDefinePatterns = [
    /^STM32\w+$/,
    /^USE_HAL_DRIVER$/,
    /^USE_STDPERIPH_DRIVER$/,
    /^HSE_VALUE$/,
    /^NRF\w+$/,
    /^__CC_ARM$/,
    /^__ICCARM__$/,
    /^__GNUC__$/,
    /^ARM_MATH_CM\d$/,
    /^USE_FULL_LL_DRIVER$/,
  ]

  for (const srcFile of info.sources.slice(0, 50)) {
    try {
      const content = readFileSync(srcFile, "utf-8")
      for (const line of content.split("\n").slice(0, 200)) {
        for (const pattern of definePatterns) {
          const m = line.match(pattern)
          if (m && m[1]) {
            for (const pp of platformDefinePatterns) {
              if (pp.test(m[1])) {
                defineHints.add(m[1])
              }
            }
          }
        }
      }
    } catch {
      // Skip unreadable files
    }
  }

  info.defines = [...defineHints]
  return info
}

// ---------------------------------------------------------------------------
// Build system detection
// ---------------------------------------------------------------------------
export interface DetectedBuildSystem {
  type: "cmake" | "make" | "keil_uvprojx" | "iar_ewp" | "eclipse_cproject" | "scons" | "meson" | "ninja" | "none"
  path: string | null
}

export function detectBuildSystem(projectPath: string): DetectedBuildSystem {
  // Check for existing compile_commands.json first
  const compdbPath = join(projectPath, "compile_commands.json")
  if (existsSync(compdbPath)) {
    return { type: "none", path: compdbPath }
  }

  // Priority-ordered detection
  const checks: Array<{ type: DetectedBuildSystem["type"]; names: string[] }> = [
    { type: "cmake", names: ["CMakeLists.txt"] },
    { type: "make", names: ["Makefile", "makefile", "GNUmakefile"] },
    { type: "scons", names: ["SConstruct", "SConscript"] },
    { type: "meson", names: ["meson.build"] },
    { type: "ninja", names: ["build.ninja"] },
  ]

  for (const { type, names } of checks) {
    for (const name of names) {
      const p = join(projectPath, name)
      if (existsSync(p)) return { type, path: p }
    }
  }

  // Glob for IDE project files
  try {
    const files = readdirSync(projectPath)
    for (const f of files) {
      if (f.endsWith(".uvprojx") || f.endsWith(".uvproj")) {
        return { type: "keil_uvprojx", path: join(projectPath, f) }
      }
      if (f.endsWith(".ewp")) {
        return { type: "iar_ewp", path: join(projectPath, f) }
      }
    }
    // Check for .cproject (Eclipse CDT)
    if (existsSync(join(projectPath, ".cproject"))) {
      return { type: "eclipse_cproject", path: join(projectPath, ".cproject") }
    }
  } catch {
    // Ignore read errors
  }

  return { type: "none", path: null }
}

/**
 * Parse build system at the given path and return build info.
 */
export function parseBuildSystem(
  detected: DetectedBuildSystem,
  projectPath: string,
): BuildInfo {
  switch (detected.type) {
    case "cmake":
      return parseCMakeLists(detected.path!)
    case "make":
      return parseMakefile(detected.path!)
    case "keil_uvprojx":
      return parseKeilProject(detected.path!)
    case "iar_ewp":
      return parseIARProject(detected.path!)
    case "eclipse_cproject":
      return parseEclipseCProject(detected.path!)
    case "none":
    default:
      return inferFromSource(projectPath)
  }
}

// ---------------------------------------------------------------------------
// Utility: recursive file scanning
// ---------------------------------------------------------------------------
function scanSourceFiles(dir: string): string[] {
  const sources: string[] = []
  scanFilesRecursive(dir, (filePath) => {
    if (SOURCE_EXTENSIONS.has(extname(filePath))) {
      sources.push(filePath)
    }
  })
  return sources
}

function scanFilesRecursive(
  dir: string,
  callback: (filePath: string) => void,
  maxDepth = 10,
  currentDepth = 0,
): void {
  if (currentDepth >= maxDepth) return
  try {
    const entries = readdirSync(dir)
    for (const entry of entries) {
      // Skip hidden dirs and common non-source dirs
      if (entry.startsWith(".") || entry === "node_modules" || entry === "dist" || entry === "build") {
        continue
      }
      const fullPath = join(dir, entry)
      try {
        const stat = statSync(fullPath)
        if (stat.isDirectory()) {
          scanFilesRecursive(fullPath, callback, maxDepth, currentDepth + 1)
        } else if (stat.isFile()) {
          callback(fullPath)
        }
      } catch {
        // Skip inaccessible entries
      }
    }
  } catch {
    // Skip unreadable directories
  }
}
