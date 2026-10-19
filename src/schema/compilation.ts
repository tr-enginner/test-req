import { z } from "zod"

/** Compiler dialect enumeration */
export const CompilerDialect = z.enum([
  "auto",
  "gcc",
  "armcc",
  "armclang",
  "iar",
  "keil",
  "c51",
  "greenhill",
  "ti",
  "windriver",
  "generic",
])
export type CompilerDialect = z.infer<typeof CompilerDialect>

/** Build system type */
export const BuildSystemType = z.enum([
  "cmake",
  "make",
  "keil_uvprojx",
  "iar_ewp",
  "eclipse_cproject",
  "scons",
  "meson",
  "ninja",
  "none",
])
export type BuildSystemType = z.infer<typeof BuildSystemType>

/** Single compile command entry (standard JSON Compilation Database format) */
export const CompileCommand = z.object({
  directory: z.string(),
  command: z.string().optional(),
  arguments: z.array(z.string()).optional(),
  file: z.string(),
  output: z.string().optional(),
})
export type CompileCommand = z.infer<typeof CompileCommand>

/** Compilation database (array of compile commands) */
export const CompilationDatabase = z.array(CompileCommand)
export type CompilationDatabase = z.infer<typeof CompilationDatabase>

/** Header stub information */
export const HeaderStub = z.object({
  header_name: z.string(),
  stub_path: z.string(),
  category: z.enum([
    "vendor_hal",
    "bsp",
    "rtos",
    "compiler_builtin",
    "standard_lib",
    "driver",
    "middleware",
    "unknown",
  ]),
  symbols_stubbed: z.number(),
  referenced_by: z.array(z.string()),
})
export type HeaderStub = z.infer<typeof HeaderStub>

/** Compilation environment report — produced by Phase 1, consumed by Phase 3+ */
export const CompilationEnvironment = z.object({
  project_path: z.string(),
  build_system: BuildSystemType,
  compiler_dialect: CompilerDialect,
  target_cpu: z.string().optional(),
  compile_commands_path: z.string(),
  files_indexed: z.number(),
  include_dirs: z.array(z.string()),
  defines: z.array(z.string()),
  missing_headers: z.array(z.string()),
  stubs: z.array(HeaderStub),
  preprocessed_dir: z.string().optional(),
  created_date: z.string(),
})
export type CompilationEnvironment = z.infer<typeof CompilationEnvironment>
