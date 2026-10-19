import { existsSync, readFileSync } from "fs"
import { join, resolve } from "path"
import { execSync } from "child_process"
import * as jsonc from "jsonc-parser/lib/esm/main.js"
import { runtimeAssetRoot } from "../shared/runtime-paths"

const IS_WINDOWS = process.platform === "win32"

function isInPath(binName: string): boolean {
  try {
    const cmd = IS_WINDOWS ? `where ${binName}` : `which ${binName}`
    execSync(cmd, { stdio: "pipe", timeout: 5_000 })
    return true
  } catch {
    return false
  }
}

/** Find the project root by walking up from startDir, looking for .matrix/ */
export function findMatrixRoot(startDir: string): string | null {
  let dir = resolve(startDir)
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, ".matrix"))) return dir
    const parent = resolve(dir, "..")
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** Read joern_home and z3_home from .matrix/config/matrix.jsonc */
function readAtomicityConfig(projectRoot: string): { joern_home?: string; z3_home?: string } {
  const configPath = join(projectRoot, ".matrix", "config", "matrix.jsonc")
  if (!existsSync(configPath)) return {}
  try {
    return jsonc.parse(readFileSync(configPath, "utf-8")) ?? {}
  } catch {
    return {}
  }
}

/**
 * Resolve the joern or joern-parse binary.
 *
 * Resolution priority:
 * 1. .matrix/config/matrix.jsonc → joern_home
 * 2. Environment variable JOERN_HOME
 * 3. System PATH
 */
export function resolveJoernBin(name: "joern" | "joern-parse", projectRoot?: string | null): string {
  const binName = IS_WINDOWS ? `${name}.bat` : name

  // 1. Config file
  if (projectRoot) {
    const cfg = readAtomicityConfig(projectRoot)
    if (cfg.joern_home) {
      const p = join(cfg.joern_home, binName)
      if (existsSync(p)) return `"${p}"`
    }
  }

  // 2. Environment variable
  const joernHome = process.env.JOERN_HOME
  if (joernHome) {
    const p = join(joernHome, binName)
    if (existsSync(p)) return `"${p}"`
  }

  // 3. System PATH
  if (isInPath(binName)) return binName

  return binName
}

/**
 * Resolve the z3 binary.
 *
 * Resolution priority:
 * 1. .matrix/config/matrix.jsonc → z3_home
 * 2. Environment variable Z3_HOME
 * 3. System PATH
 */
export function resolveZ3Bin(projectRoot?: string | null): string {
  const binName = IS_WINDOWS ? "z3.exe" : "z3"

  // 1. Config file
  if (projectRoot) {
    const cfg = readAtomicityConfig(projectRoot)
    if (cfg.z3_home) {
      const p = join(cfg.z3_home, "bin", binName)
      if (existsSync(p)) return `"${p}"`
      const p2 = join(cfg.z3_home, binName)
      if (existsSync(p2)) return `"${p2}"`
    }
  }

  // 2. Environment variable
  const z3Home = process.env.Z3_HOME
  if (z3Home) {
    const p = join(z3Home, "bin", binName)
    if (existsSync(p)) return `"${p}"`
    const p2 = join(z3Home, binName)
    if (existsSync(p2)) return `"${p2}"`
  }

  // 3. System PATH
  if (isInPath(binName)) return binName

  return binName
}

export function resolveJoernScriptPath(
  scriptName: string = "multivarCorrelatedVarsIdentify.scala",
  matrixRoot?: string,
): string {
  const pluginRoot = runtimeAssetRoot(import.meta.url)
  const candidates = [
    join(pluginRoot, "joern", scriptName),
    ...(matrixRoot ? [join(matrixRoot, "joern", scriptName)] : []),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(
    `Joern Scala script not found. Searched:\n${candidates.join("\n")}\n` +
    `Hint: The script should be at <project_root>/joern/${scriptName}`
  )
}

export function normalizeVariableName(raw: string): string {
  let name = raw.trim()
  // Strip <global> prefix from Joern output (both "<global>." and "<global> " formats)
  if (name.startsWith("<global>.")) name = name.slice(9)
  else if (name.startsWith("<global> ")) name = name.slice(9)
  // Strip leading * (pointer dereference)
  while (name.startsWith("*")) name = name.slice(1).trim()
  // Strip assignment RHS: "a = expr" → "a"
  // Guard against ==, !=, <=, >= operators (not assignments)
  const eqIdx = name.indexOf("=")
  if (
    eqIdx > 0 &&
    name[eqIdx - 1] !== "!" &&
    name[eqIdx - 1] !== "<" &&
    name[eqIdx - 1] !== ">" &&
    name[eqIdx - 1] !== "=" &&   // guard against "=="
    name[eqIdx + 1] !== "="       // guard against "==" when at first "="
  ) {
    name = name.slice(0, eqIdx).trim()
  }
  return name.trim()
}
