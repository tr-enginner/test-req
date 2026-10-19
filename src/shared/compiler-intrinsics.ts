const COMPILER_INTRINSICS = new Set([
  "_nop_",
  "_srvwdt_",
  "_crol_",
  "crol",
  "NOP",
  "abs",
])

export function isCompilerIntrinsicName(name: string): boolean {
  return COMPILER_INTRINSICS.has(name)
}
