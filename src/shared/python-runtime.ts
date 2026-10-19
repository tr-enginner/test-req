import { execFileSync } from "child_process"
import { existsSync } from "fs"
import { isAbsolute, join, resolve } from "path"
import { runtimeAssetRoot } from "./runtime-paths"

export interface ResolvedPythonRuntime {
  executable: string
  source: "arg" | "env" | "runtime" | "runtime-scripts" | "tools-archive" | "tools-archive-scripts"
}

interface PythonCandidate {
  path: string
  source: ResolvedPythonRuntime["source"]
}

interface ResolvePackagedPythonOptions {
  env?: NodeJS.ProcessEnv
  candidates?: PythonCandidate[]
  canExecute?: (candidate: string) => boolean
}

function resolveCandidatePath(input: string): string {
  return isAbsolute(input) ? input : resolve(process.cwd(), input)
}

export function canExecutePython(candidate: string): boolean {
  try {
    execFileSync(candidate, ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

export function getPackagedPythonCandidates(): PythonCandidate[] {
  const packageRoot = runtimeAssetRoot(import.meta.url)

  return [
    {
      path: join(packageRoot, "runtime", "python", "python.exe"),
      source: "runtime",
    },
    {
      path: join(packageRoot, "runtime", "python", "Scripts", "python.exe"),
      source: "runtime-scripts",
    },
    {
      path: join(packageRoot, "tools-archive", "python", "windows", "python.exe"),
      source: "tools-archive",
    },
    {
      path: join(packageRoot, "tools-archive", "python", "windows", "Scripts", "python.exe"),
      source: "tools-archive-scripts",
    },
  ]
}

export function resolvePackagedPythonExecutable(
  preferredPath?: string,
  options: ResolvePackagedPythonOptions = {},
): ResolvedPythonRuntime {
  const candidates: PythonCandidate[] = []
  const env = options.env ?? process.env
  const canExecute = options.canExecute ?? canExecutePython

  if (preferredPath?.trim()) {
    candidates.push({
      path: resolveCandidatePath(preferredPath.trim()),
      source: "arg",
    })
  }

  if (env.MATRIX_PYTHON?.trim()) {
    candidates.push({
      path: resolveCandidatePath(env.MATRIX_PYTHON.trim()),
      source: "env",
    })
  }

  candidates.push(...(options.candidates ?? getPackagedPythonCandidates()))

  for (const candidate of candidates) {
    if (!existsSync(candidate.path)) continue
    if (!canExecute(candidate.path)) continue
    return {
      executable: candidate.path,
      source: candidate.source,
    }
  }

  throw new Error(
    "Python executable not found. Set MATRIX_PYTHON or ensure the packaged runtime/python payload is installed.",
  )
}
