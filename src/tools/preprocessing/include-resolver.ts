/**
 * Include resolution: scan source files for #include directives,
 * resolve against known include paths, and identify missing headers.
 */

import { existsSync, readFileSync } from "fs"
import { basename, dirname, join, resolve } from "path"

export interface IncludeDirective {
  /** The header name as written in the #include directive */
  header: string
  /** Whether it's a system include (<...>) or user include ("...") */
  type: "system" | "user"
  /** The source file containing this #include */
  source_file: string
  /** Line number in the source file */
  line: number
}

export interface ResolvedInclude extends IncludeDirective {
  /** The resolved absolute path, or null if unresolved */
  resolved_path: string | null
}

export interface IncludeResolutionResult {
  /** All #include directives found */
  all_includes: ResolvedInclude[]
  /** Headers that could not be resolved */
  missing_headers: MissingHeader[]
  /** Successfully resolved headers */
  resolved_count: number
}

export interface MissingHeader {
  /** Header name as written in #include */
  header: string
  /** Source files that reference this header */
  referenced_by: string[]
}

/**
 * Extract all #include directives from a source file.
 */
export function extractIncludes(filePath: string): IncludeDirective[] {
  const directives: IncludeDirective[] = []
  if (!existsSync(filePath)) return directives

  const content = readFileSync(filePath, "utf-8")
  const lines = content.split("\n")

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // Match #include "header.h" or #include <header.h>
    const match = line.match(/^\s*#\s*include\s+([<"])([^>"]+)[>"]/)
    if (match) {
      directives.push({
        header: match[2],
        type: match[1] === "<" ? "system" : "user",
        source_file: filePath,
        line: i + 1,
      })
    }
  }

  return directives
}

/**
 * Resolve a single include directive against a list of search directories.
 */
export function resolveInclude(
  directive: IncludeDirective,
  includeDirs: string[],
): string | null {
  // For user includes, first search relative to the source file
  if (directive.type === "user") {
    const sourceDir = dirname(directive.source_file)
    const relative = join(sourceDir, directive.header)
    if (existsSync(relative)) return resolve(relative)
  }

  // Search in include directories
  for (const dir of includeDirs) {
    const candidate = join(dir, directive.header)
    if (existsSync(candidate)) return resolve(candidate)
  }

  return null
}

/**
 * Scan multiple source files for #include directives and resolve them.
 */
export function resolveAllIncludes(
  sourceFiles: string[],
  includeDirs: string[],
): IncludeResolutionResult {
  const allIncludes: ResolvedInclude[] = []
  const missingMap = new Map<string, Set<string>>()
  let resolvedCount = 0

  for (const srcFile of sourceFiles) {
    const directives = extractIncludes(srcFile)
    for (const directive of directives) {
      const resolvedPath = resolveInclude(directive, includeDirs)
      allIncludes.push({ ...directive, resolved_path: resolvedPath })

      if (resolvedPath) {
        resolvedCount++
      } else {
        const existing = missingMap.get(directive.header)
        if (existing) {
          existing.add(srcFile)
        } else {
          missingMap.set(directive.header, new Set([srcFile]))
        }
      }
    }
  }

  const missing_headers: MissingHeader[] = []
  for (const [header, refs] of missingMap) {
    missing_headers.push({
      header,
      referenced_by: [...refs],
    })
  }

  return {
    all_includes: allIncludes,
    missing_headers,
    resolved_count: resolvedCount,
  }
}

/**
 * Analyze source files to discover what symbols they expect from a
 * missing header. This enables demand-driven stub generation.
 *
 * Scans for:
 * - Type usage patterns (typedef, struct, enum references)
 * - Function call patterns
 * - Macro usage in #ifdef
 */
export function discoverExpectedSymbols(
  headerName: string,
  referencingFiles: string[],
): { types: string[]; functions: string[]; macros: string[] } {
  const types = new Set<string>()
  const functions = new Set<string>()
  const macros = new Set<string>()

  // Common type suffixes used in embedded code
  const typePattern =
    /\b([A-Z][A-Za-z0-9_]*(?:_Type|_TypeDef|_HandleTypeDef|_InitTypeDef|_t))\b/g
  const funcCallPattern = /\b([A-Z][A-Za-z0-9_]*(?:_Init|_DeInit|_Start|_Stop|_Write|_Read|_Set|_Get|_Enable|_Disable|_Config|_IRQHandler))\s*\(/g
  const macroPattern = /\b([A-Z][A-Z0-9_]{2,})\b/g

  // Derive a prefix from the header name for filtering
  const headerBase = basename(headerName, ".h")
    .replace(/_hal.*/, "")
    .replace(/_ll_.*/, "")
  const headerPrefix = headerBase.toUpperCase().replace(/[^A-Z0-9]/g, "")

  for (const filePath of referencingFiles) {
    try {
      const content = readFileSync(filePath, "utf-8")

      // Find the #include of this header to know we're in the right context
      const includeIdx = content.indexOf(headerName)
      if (includeIdx === -1) continue

      // Look for type references
      for (const m of content.matchAll(typePattern)) {
        if (m[1].toUpperCase().includes(headerPrefix) || headerPrefix.length < 3) {
          types.add(m[1])
        }
      }

      // Look for function calls
      for (const m of content.matchAll(funcCallPattern)) {
        if (m[1].toUpperCase().includes(headerPrefix) || headerPrefix.length < 3) {
          functions.add(m[1])
        }
      }

      // Look for macro references in #if / #ifdef
      for (const line of content.split("\n")) {
        const ifdefMatch = line.match(/^\s*#\s*if(?:def)?\s+(\w+)/)
        if (ifdefMatch && ifdefMatch[1].includes(headerPrefix)) {
          macros.add(ifdefMatch[1])
        }
      }
    } catch {
      // Skip unreadable files
    }
  }

  return {
    types: [...types],
    functions: [...functions],
    macros: [...macros],
  }
}

/**
 * Generate a stub header for an unknown header based on discovered symbols.
 */
export function generateDemandStub(
  headerName: string,
  symbols: { types: string[]; functions: string[]; macros: string[] },
): string {
  const guard = headerName
    .replace(/[^a-zA-Z0-9]/g, "_")
    .toUpperCase()
    + "_STUB_H"

  const lines: string[] = [
    `#ifndef ${guard}`,
    `#define ${guard}`,
    `/* Auto-generated stub for: ${headerName} */`,
    `#include <stdint.h>`,
    `#include <stddef.h>`,
    "",
  ]

  // Generate macro stubs
  for (const macro of symbols.macros) {
    lines.push(`#ifndef ${macro}`)
    lines.push(`#define ${macro} 1`)
    lines.push(`#endif`)
  }
  if (symbols.macros.length > 0) lines.push("")

  // Generate type stubs
  for (const type of symbols.types) {
    if (type.endsWith("_Type") || type.endsWith("_TypeDef") || type.endsWith("_HandleTypeDef") || type.endsWith("_InitTypeDef")) {
      lines.push(`typedef struct { uint32_t __reserved; } ${type};`)
    } else {
      lines.push(`typedef uint32_t ${type};`)
    }
  }
  if (symbols.types.length > 0) lines.push("")

  // Generate function prototype stubs
  for (const func of symbols.functions) {
    if (func.includes("_IRQHandler")) {
      lines.push(`void ${func}(void);`)
    } else if (func.includes("_Init") || func.includes("_DeInit") || func.includes("_Config")) {
      lines.push(`int ${func}(void);`)
    } else if (func.includes("_Get") || func.includes("_Read")) {
      lines.push(`uint32_t ${func}(void);`)
    } else {
      lines.push(`void ${func}(void);`)
    }
  }
  if (symbols.functions.length > 0) lines.push("")

  lines.push(`#endif /* ${guard} */`)
  lines.push("")

  return lines.join("\n")
}
