/**
 * Compiler dialect translation rules.
 *
 * Each dialect defines regex-based patterns that translate compiler-specific
 * constructs into standard C/C++ equivalents so that downstream tools
 * (code_parser, cppcheck, etc.) can parse the source correctly.
 */

export interface DialectPattern {
  /** Regex to match the dialect-specific construct */
  regex: RegExp
  /** Replacement string (may use $1, $2 capture groups) */
  replacement: string
  /** Human-readable description */
  description: string
}

export interface DialectTranslation {
  dialect: string
  patterns: DialectPattern[]
}

// ---------------------------------------------------------------------------
// Common (cross-dialect) rules — applied regardless of detected dialect
// ---------------------------------------------------------------------------
export const COMMON_RULES: DialectTranslation = {
  dialect: "common",
  patterns: [
    {
      regex: /\b__interrupt\b/g,
      replacement: "/* __interrupt */",
      description: "Remove __interrupt qualifier",
    },
    {
      regex: /\b__irq\b/g,
      replacement: "/* __irq */",
      description: "Remove __irq qualifier",
    },
    {
      regex: /\bvolatile\s+__attribute__\s*\(\([^)]*\)\)/g,
      replacement: "volatile",
      description: "Remove __attribute__ after volatile",
    },
    // Inline assembly (multi-line asm blocks are handled separately)
    {
      regex: /\b__asm\s*\{[^}]*\}/g,
      replacement: "/* asm block removed */",
      description: "Remove __asm { } blocks",
    },
    {
      regex: /\b__asm__\s*__volatile__\s*\([^;]*\)\s*;/g,
      replacement: "/* asm removed */;",
      description: "Remove __asm__ __volatile__(...) statements",
    },
    {
      regex: /\basm\s*\([^;]*\)\s*;/g,
      replacement: "/* asm removed */;",
      description: "Remove asm(...) statements",
    },
    {
      regex: /\b__asm__\s*\([^;]*\)\s*;/g,
      replacement: "/* asm removed */;",
      description: "Remove __asm__(...) statements",
    },
    {
      regex: /\b__asm\s*\([^;]*\)\s*;/g,
      replacement: "/* asm removed */;",
      description: "Remove __asm(...) statements",
    },
    // Generic #pragma — turn unknown pragmas into comments
    // (Known pragmas are handled by dialect-specific rules first)
    {
      regex: /^(\s*)#\s*pragma\s+(.*)$/gm,
      replacement: "$1/* #pragma $2 */",
      description: "Comment out #pragma directives",
    },
  ],
}

// ---------------------------------------------------------------------------
// GCC / ARM GCC
// ---------------------------------------------------------------------------
export const GCC_RULES: DialectTranslation = {
  dialect: "gcc",
  patterns: [
    {
      regex: /__attribute__\s*\(\(([^)]*(?:\([^)]*\))*[^)]*)\)\)/g,
      replacement: "/* __attribute__(($1)) */",
      description: "Remove __attribute__((...)) decorators",
    },
    {
      regex: /\b__extension__\b/g,
      replacement: "",
      description: "Remove __extension__ keyword",
    },
    {
      regex: /\b__volatile__\b/g,
      replacement: "volatile",
      description: "Translate __volatile__ to volatile",
    },
    {
      regex: /\b__inline__\b/g,
      replacement: "inline",
      description: "Translate __inline__ to inline",
    },
    {
      regex: /\b__inline\b/g,
      replacement: "inline",
      description: "Translate __inline to inline",
    },
    {
      regex: /\b__const__\b/g,
      replacement: "const",
      description: "Translate __const__ to const",
    },
    {
      regex: /\b__signed__\b/g,
      replacement: "signed",
      description: "Translate __signed__ to signed",
    },
    {
      regex: /\btypeof\b/g,
      replacement: "/* typeof */int",
      description: "Replace typeof with int placeholder",
    },
    {
      regex: /\b__typeof__\b/g,
      replacement: "/* __typeof__ */int",
      description: "Replace __typeof__ with int placeholder",
    },
    {
      regex: /\b__builtin_expect\s*\(([^,]+),\s*[^)]+\)/g,
      replacement: "($1)",
      description: "Simplify __builtin_expect(expr, val) to (expr)",
    },
    {
      regex: /\b__builtin_offsetof\s*\(([^,]+),\s*([^)]+)\)/g,
      replacement: "((unsigned long)&(($1 *)0)->$2)",
      description: "Expand __builtin_offsetof to standard offsetof",
    },
    {
      regex: /\b__builtin_\w+\s*\([^)]*\)/g,
      replacement: "0 /* builtin stub */",
      description: "Stub remaining GCC builtins with 0",
    },
  ],
}

// ---------------------------------------------------------------------------
// ARMCC (ARM Compiler 5 / Keil MDK legacy)
// ---------------------------------------------------------------------------
export const ARMCC_RULES: DialectTranslation = {
  dialect: "armcc",
  patterns: [
    {
      regex: /__attribute__\s*\(\(([^)]*(?:\([^)]*\))*[^)]*)\)\)/g,
      replacement: "/* __attribute__(($1)) */",
      description: "Remove __attribute__((...)) decorators",
    },
    {
      regex: /\b__packed\b/g,
      replacement: "/* __packed */",
      description: "Remove __packed qualifier",
    },
    {
      regex: /\b__svc\s*\(\s*\d+\s*\)/g,
      replacement: "/* __svc */",
      description: "Remove __svc(N) decorator",
    },
    {
      regex: /\b__svc_indirect\s*\(\s*\d+\s*\)/g,
      replacement: "/* __svc_indirect */",
      description: "Remove __svc_indirect(N) decorator",
    },
    {
      regex: /\b__value_in_regs\b/g,
      replacement: "/* __value_in_regs */",
      description: "Remove __value_in_regs qualifier",
    },
    {
      regex: /\b__weak\b/g,
      replacement: "/* __weak */",
      description: "Remove __weak qualifier",
    },
    {
      regex: /\b__align\s*\(\s*\d+\s*\)/g,
      replacement: "/* __align */",
      description: "Remove __align(N) decorator",
    },
    {
      regex: /\b__forceinline\b/g,
      replacement: "inline",
      description: "Translate __forceinline to inline",
    },
    {
      regex: /\b__global_reg\s*\(\s*\d+\s*\)/g,
      replacement: "/* __global_reg */",
      description: "Remove __global_reg(N)",
    },
    {
      regex: /\b__softfp\b/g,
      replacement: "/* __softfp */",
      description: "Remove __softfp qualifier",
    },
    {
      regex: /\b__ARMCC_VERSION\b/g,
      replacement: "5060750 /* __ARMCC_VERSION stub */",
      description: "Stub __ARMCC_VERSION with a default value",
    },
    {
      regex: /\b__microlib\b/g,
      replacement: "/* __microlib */",
      description: "Remove __microlib marker",
    },
  ],
}

// ---------------------------------------------------------------------------
// Keil MDK (uses ARMCC backend, same rules plus Keil-specific)
// ---------------------------------------------------------------------------
export const KEIL_RULES: DialectTranslation = {
  dialect: "keil",
  patterns: [
    // Include all ARMCC rules via the merge logic
    ...ARMCC_RULES.patterns,
    {
      regex: /\bdata\s+at\s+0x[0-9a-fA-F]+\b/g,
      replacement: "/* data at addr */",
      description: "Remove Keil absolute address placement",
    },
    {
      regex: /\b__task\b/g,
      replacement: "/* __task */",
      description: "Remove __task qualifier",
    },
  ],
}

// ---------------------------------------------------------------------------
// Keil C51 (8051 family)
// ---------------------------------------------------------------------------
export const C51_RULES: DialectTranslation = {
  dialect: "c51",
  patterns: [
    // --- SFR declarations ---
    // "sfr P0 = 0x80;" → "volatile unsigned char P0; /* sfr = 0x80 */"
    // "sfr16 DPTR = 0x82;" → "volatile unsigned short DPTR; /* sfr16 = 0x82 */"
    {
      regex: /\bsfr16\s+(\w+)\s*=\s*([^;]+);/g,
      replacement: "volatile unsigned short $1; /* sfr16 = $2 */",
      description: "Translate sfr16 to volatile unsigned short",
    },
    {
      regex: /\bsfr\s+(\w+)\s*=\s*([^;]+);/g,
      replacement: "volatile unsigned char $1; /* sfr = $2 */",
      description: "Translate sfr to volatile unsigned char",
    },
    // --- SBIT declarations ---
    // "sbit LOAD_SW0 = P0^0;" → "volatile unsigned char LOAD_SW0; /* sbit = P0^0 */"
    // Must run BEFORE the generic sbit-as-type rule
    {
      regex: /\bsbit\s+(\w+)\s*=\s*([^;]+);/g,
      replacement: "volatile unsigned char $1; /* sbit = $2 */",
      description: "Translate sbit declaration to volatile unsigned char",
    },
    // --- Memory qualifiers in declarations ---
    // "unsigned char xdata var;" → "unsigned char var; /* xdata */"
    // These appear between type and variable name as storage qualifiers
    {
      regex: /\bxdata\b/g,
      replacement: "/* xdata */",
      description: "Remove xdata memory qualifier",
    },
    {
      regex: /\bidata\b/g,
      replacement: "/* idata */",
      description: "Remove idata memory qualifier",
    },
    {
      regex: /\bpdata\b/g,
      replacement: "/* pdata */",
      description: "Remove pdata memory qualifier",
    },
    // --- "bit" type ---
    // "static bit flag_100ms;" → "static unsigned char flag_100ms; /* bit */"
    // Must be careful not to match "bit" inside other words (sbit already handled above)
    {
      regex: /\bbit\b(?!\s*\d)/g,
      replacement: "unsigned char /* bit */",
      description: "Translate bit type to unsigned char",
    },
    // --- "code" memory qualifier ---
    // In 8051, "code" means read-only program memory
    // "unsigned char code table[]" → "const unsigned char table[]"
    // "void (code *)(void)" → "void (const *)(void)"
    // Must be careful: "code" appears as a qualifier, not the C keyword
    // Match "code" when preceded by a type or after "static"/"extern"/line-start
    // Use a pattern that catches typical usages without false positives
    {
      regex: /\bcode\b(?!\s*[=;{(])/g,
      replacement: "const /* code */",
      description: "Translate code memory qualifier to const",
    },
    // --- "data" memory qualifier (direct addressable) ---
    // Careful: "data" is also used in "data at 0xNN" (handled by KEIL_RULES)
    // Only match standalone "data" as a qualifier between type and varname
    {
      regex: /(\b(?:unsigned|signed|char|short|int|long|void|float|double|static|extern)\s+)data\b/g,
      replacement: "$1/* data */",
      description: "Remove data memory qualifier after type keywords",
    },
    // --- Interrupt and using syntax ---
    // "void timer0_isr(void) interrupt 1 using 1" →
    // "void timer0_isr(void) /* interrupt 1 using 1 */"
    // Must handle: interrupt N, interrupt N using M, using N alone
    {
      regex: /\)\s*interrupt\s+\d+\s+using\s+\d+/g,
      replacement: ") /* interrupt using */",
      description: "Remove interrupt N using M from function declaration",
    },
    {
      regex: /\)\s*interrupt\s+\d+/g,
      replacement: ") /* interrupt */",
      description: "Remove interrupt N from function declaration",
    },
    {
      regex: /\)\s*using\s+\d+/g,
      replacement: ") /* using */",
      description: "Remove using N from function declaration",
    },
    // --- Reentrant keyword ---
    {
      regex: /\)\s*reentrant\b/g,
      replacement: ") /* reentrant */",
      description: "Remove reentrant keyword",
    },
    // --- Memory model keywords (less common) ---
    {
      regex: /\bcompact\b/g,
      replacement: "/* compact */",
      description: "Remove compact memory model keyword",
    },
    {
      regex: /\blarge\b(?!\s*[=;])/g,
      replacement: "/* large */",
      description: "Remove large memory model keyword",
    },
    {
      regex: /\bsmall\b(?!\s*[=;])/g,
      replacement: "/* small */",
      description: "Remove small memory model keyword",
    },
    // --- _at_ absolute address placement ---
    {
      regex: /\b_at_\s+0x[0-9a-fA-F]+/g,
      replacement: "/* _at_ addr */",
      description: "Remove _at_ absolute address placement",
    },
  ],
}

// ---------------------------------------------------------------------------
// armclang (ARM Compiler 6, LLVM-based)
// ---------------------------------------------------------------------------
export const ARMCLANG_RULES: DialectTranslation = {
  dialect: "armclang",
  patterns: [
    {
      regex: /__attribute__\s*\(\(([^)]*(?:\([^)]*\))*[^)]*)\)\)/g,
      replacement: "/* __attribute__(($1)) */",
      description: "Remove __attribute__((...)) decorators",
    },
    {
      regex: /\b__ARM_FEATURE_\w+\b/g,
      replacement: "0 /* ARM feature stub */",
      description: "Stub __ARM_FEATURE_* macros with 0",
    },
    {
      regex: /\b__packed\b/g,
      replacement: "/* __packed */",
      description: "Remove __packed qualifier",
    },
    {
      regex: /\b__weak\b/g,
      replacement: "/* __weak */",
      description: "Remove __weak qualifier",
    },
    {
      regex: /\b__ALIGNED\s*\(\s*\d+\s*\)/g,
      replacement: "/* __ALIGNED */",
      description: "Remove __ALIGNED(N) macro",
    },
    {
      regex: /\b__STATIC_FORCEINLINE\b/g,
      replacement: "static inline",
      description: "Translate __STATIC_FORCEINLINE",
    },
    {
      regex: /\b__STATIC_INLINE\b/g,
      replacement: "static inline",
      description: "Translate __STATIC_INLINE",
    },
  ],
}

// ---------------------------------------------------------------------------
// IAR (EWARM)
// ---------------------------------------------------------------------------
export const IAR_RULES: DialectTranslation = {
  dialect: "iar",
  patterns: [
    {
      regex: /\b__root\b/g,
      replacement: "/* __root */",
      description: "Remove __root qualifier",
    },
    {
      regex: /\b__no_init\b/g,
      replacement: "/* __no_init */",
      description: "Remove __no_init qualifier",
    },
    {
      regex: /\b__weak\b/g,
      replacement: "/* __weak */",
      description: "Remove __weak qualifier",
    },
    {
      regex: /\b__ramfunc\b/g,
      replacement: "/* __ramfunc */",
      description: "Remove __ramfunc qualifier",
    },
    {
      regex: /\b__packed\b/g,
      replacement: "/* __packed */",
      description: "Remove __packed qualifier",
    },
    {
      regex: /\b__arm\b/g,
      replacement: "/* __arm */",
      description: "Remove __arm qualifier",
    },
    {
      regex: /\b__thumb\b/g,
      replacement: "/* __thumb */",
      description: "Remove __thumb qualifier",
    },
    {
      regex: /\b__interwork\b/g,
      replacement: "/* __interwork */",
      description: "Remove __interwork qualifier",
    },
    {
      regex: /\b__intrinsic\b/g,
      replacement: "/* __intrinsic */",
      description: "Remove __intrinsic qualifier",
    },
    {
      regex: /\b__nested\b/g,
      replacement: "/* __nested */",
      description: "Remove __nested qualifier",
    },
    {
      regex: /\b__noreturn\b/g,
      replacement: "/* __noreturn */",
      description: "Remove __noreturn qualifier",
    },
    {
      regex: /\b__iar_builtin_\w+\s*\([^)]*\)/g,
      replacement: "0 /* IAR builtin stub */",
      description: "Stub __iar_builtin_* intrinsics",
    },
    {
      regex: /@\s*"[^"]*"/g,
      replacement: "/* @ segment */",
      description: "Remove IAR @ segment placement",
    },
    {
      regex: /^(\s*)#\s*pragma\s+location\s*=.*$/gm,
      replacement: "$1/* #pragma location removed */",
      description: "Remove #pragma location",
    },
    {
      regex: /^(\s*)#\s*pragma\s+optimize\s*=.*$/gm,
      replacement: "$1/* #pragma optimize removed */",
      description: "Remove #pragma optimize",
    },
    {
      regex: /^(\s*)#\s*pragma\s+pack\s*\(.*\).*$/gm,
      replacement: "$1/* #pragma pack removed */",
      description: "Remove #pragma pack",
    },
    {
      regex: /^(\s*)#\s*pragma\s+data_alignment\s*=.*$/gm,
      replacement: "$1/* #pragma data_alignment removed */",
      description: "Remove #pragma data_alignment",
    },
    {
      regex: /^(\s*)#\s*pragma\s+required\s*=.*$/gm,
      replacement: "$1/* #pragma required removed */",
      description: "Remove #pragma required",
    },
    {
      regex: /^(\s*)#\s*pragma\s+segment\s*=.*$/gm,
      replacement: "$1/* #pragma segment removed */",
      description: "Remove #pragma segment",
    },
    {
      regex: /^(\s*)#\s*pragma\s+vector\s*=.*$/gm,
      replacement: "$1/* #pragma vector removed */",
      description: "Remove #pragma vector",
    },
    {
      regex: /^(\s*)#\s*pragma\s+type_attribute\s*=.*$/gm,
      replacement: "$1/* #pragma type_attribute removed */",
      description: "Remove #pragma type_attribute",
    },
  ],
}

// ---------------------------------------------------------------------------
// Green Hills (MULTI)
// ---------------------------------------------------------------------------
export const GREENHILL_RULES: DialectTranslation = {
  dialect: "greenhill",
  patterns: [
    {
      regex: /\b__ghs_\w+\b/g,
      replacement: "/* __ghs_* */",
      description: "Remove __ghs_* qualifiers",
    },
    {
      regex: /^(\s*)#\s*pragma\s+ghs\s+.*$/gm,
      replacement: "$1/* #pragma ghs removed */",
      description: "Remove #pragma ghs directives",
    },
    {
      regex: /^(\s*)#\s*pragma\s+asm\b.*$/gm,
      replacement: "$1/* #pragma asm */",
      description: "Remove #pragma asm",
    },
    {
      regex: /^(\s*)#\s*pragma\s+endasm\b.*$/gm,
      replacement: "$1/* #pragma endasm */",
      description: "Remove #pragma endasm",
    },
    {
      regex: /\b__attribute__\s*\(\(([^)]*(?:\([^)]*\))*[^)]*)\)\)/g,
      replacement: "/* __attribute__(($1)) */",
      description: "Remove __attribute__((...)) decorators",
    },
    {
      regex: /\b__packed\b/g,
      replacement: "/* __packed */",
      description: "Remove __packed qualifier",
    },
    {
      regex: /\b__weak\b/g,
      replacement: "/* __weak */",
      description: "Remove __weak qualifier",
    },
  ],
}

// ---------------------------------------------------------------------------
// TI (Code Composer Studio)
// ---------------------------------------------------------------------------
export const TI_RULES: DialectTranslation = {
  dialect: "ti",
  patterns: [
    {
      regex: /\b_nassert\s*\([^)]*\)/g,
      replacement: "((void)0) /* _nassert */",
      description: "Replace _nassert(expr) with noop",
    },
    {
      regex: /^(\s*)#\s*pragma\s+CODE_SECTION\s*\(.*\).*$/gm,
      replacement: "$1/* #pragma CODE_SECTION removed */",
      description: "Remove #pragma CODE_SECTION",
    },
    {
      regex: /^(\s*)#\s*pragma\s+DATA_SECTION\s*\(.*\).*$/gm,
      replacement: "$1/* #pragma DATA_SECTION removed */",
      description: "Remove #pragma DATA_SECTION",
    },
    {
      regex: /^(\s*)#\s*pragma\s+DATA_ALIGN\s*\(.*\).*$/gm,
      replacement: "$1/* #pragma DATA_ALIGN removed */",
      description: "Remove #pragma DATA_ALIGN",
    },
    {
      regex: /^(\s*)#\s*pragma\s+MUST_ITERATE\s*\(.*\).*$/gm,
      replacement: "$1/* #pragma MUST_ITERATE removed */",
      description: "Remove #pragma MUST_ITERATE",
    },
    {
      regex: /^(\s*)#\s*pragma\s+FUNC_ALWAYS_INLINE\b.*$/gm,
      replacement: "$1/* #pragma FUNC_ALWAYS_INLINE removed */",
      description: "Remove #pragma FUNC_ALWAYS_INLINE",
    },
    {
      regex: /^(\s*)#\s*pragma\s+FUNC_IS_PURE\b.*$/gm,
      replacement: "$1/* #pragma FUNC_IS_PURE removed */",
      description: "Remove #pragma FUNC_IS_PURE",
    },
    {
      regex: /^(\s*)#\s*pragma\s+INTERRUPT\b.*$/gm,
      replacement: "$1/* #pragma INTERRUPT removed */",
      description: "Remove #pragma INTERRUPT",
    },
    {
      regex: /\b__TI_COMPILER_VERSION__\b/g,
      replacement: "20001000 /* __TI_COMPILER_VERSION__ stub */",
      description: "Stub __TI_COMPILER_VERSION__",
    },
    {
      regex: /\bcregister\s+volatile\b/g,
      replacement: "volatile /* cregister */",
      description: "Remove cregister keyword",
    },
    {
      regex: /\bcregister\b/g,
      replacement: "/* cregister */",
      description: "Remove cregister keyword",
    },
    {
      regex: /\b__attribute__\s*\(\(([^)]*(?:\([^)]*\))*[^)]*)\)\)/g,
      replacement: "/* __attribute__(($1)) */",
      description: "Remove __attribute__((...)) decorators",
    },
  ],
}

// ---------------------------------------------------------------------------
// Wind River (Diab compiler)
// ---------------------------------------------------------------------------
export const WINDRIVER_RULES: DialectTranslation = {
  dialect: "windriver",
  patterns: [
    {
      regex: /\b__DCC__\b/g,
      replacement: "1 /* __DCC__ stub */",
      description: "Stub __DCC__ macro",
    },
    {
      regex: /\b__DIAB_\w+\b/g,
      replacement: "0 /* __DIAB_ stub */",
      description: "Stub __DIAB_* macros",
    },
    {
      regex: /^(\s*)#\s*pragma\s+section\s+.*$/gm,
      replacement: "$1/* #pragma section removed */",
      description: "Remove #pragma section",
    },
    {
      regex: /^(\s*)#\s*pragma\s+use_section\s+.*$/gm,
      replacement: "$1/* #pragma use_section removed */",
      description: "Remove #pragma use_section",
    },
    {
      regex: /^(\s*)#\s*pragma\s+align\s+.*$/gm,
      replacement: "$1/* #pragma align removed */",
      description: "Remove #pragma align",
    },
    {
      regex: /^(\s*)#\s*pragma\s+pack\s*\(.*\).*$/gm,
      replacement: "$1/* #pragma pack removed */",
      description: "Remove #pragma pack",
    },
    {
      regex: /\b__packed__\b/g,
      replacement: "/* __packed__ */",
      description: "Remove __packed__ qualifier",
    },
    {
      regex: /\b__attribute__\s*\(\(([^)]*(?:\([^)]*\))*[^)]*)\)\)/g,
      replacement: "/* __attribute__(($1)) */",
      description: "Remove __attribute__((...)) decorators",
    },
    {
      regex: /\b__weak\b/g,
      replacement: "/* __weak */",
      description: "Remove __weak qualifier",
    },
  ],
}

// ---------------------------------------------------------------------------
// Registry: dialect name → rules
// ---------------------------------------------------------------------------
export const DIALECT_RULES: Record<string, DialectTranslation> = {
  common: COMMON_RULES,
  gcc: GCC_RULES,
  armcc: ARMCC_RULES,
  armclang: ARMCLANG_RULES,
  keil: KEIL_RULES,
  c51: C51_RULES,
  iar: IAR_RULES,
  greenhill: GREENHILL_RULES,
  ti: TI_RULES,
  windriver: WINDRIVER_RULES,
  // "generic" uses only COMMON_RULES
}

/**
 * Get the ordered list of rule sets to apply for a given dialect.
 * Dialect-specific rules are applied first, then common rules.
 * This ensures dialect-specific #pragma handling runs before the
 * common #pragma catch-all.
 */
export function getRulesForDialect(dialect: string): DialectPattern[] {
  const dialectRules = DIALECT_RULES[dialect]
  const patterns: DialectPattern[] = []
  if (dialectRules && dialect !== "common") {
    patterns.push(...dialectRules.patterns)
  }
  patterns.push(...COMMON_RULES.patterns)
  return patterns
}

// ---------------------------------------------------------------------------
// Dialect auto-detection markers
// ---------------------------------------------------------------------------
export const DIALECT_MARKERS: Record<string, RegExp[]> = {
  c51: [
    /\bsfr\s+\w+\s*=/,
    /\bsbit\s+\w+\s*=/,
    /\bxdata\b/,
    /\bidata\b/,
    /\bpdata\b/,
    /\)\s*interrupt\s+\d+/,
    /\b_at_\s+0x/,
  ],
  iar: [
    /__iar_builtin_/,
    /\b__root\b/,
    /\b__no_init\b/,
    /#pragma\s+location/,
    /@\s*"[^"]*"/,
    /#pragma\s+vector/,
    /#pragma\s+data_alignment/,
  ],
  keil: [
    /\b__svc\s*\(/,
    /\b__microlib\b/,
    /\b__ARMCC_VERSION\b/,
    /\b__task\b/,
  ],
  armclang: [
    /\b__ARM_FEATURE_/,
    /\b__STATIC_FORCEINLINE\b/,
    /--target=arm-arm-none-eabi/,
  ],
  armcc: [
    /\b__value_in_regs\b/,
    /\b__softfp\b/,
    /\b__global_reg\b/,
  ],
  gcc: [
    /\b__GNUC__\b/,
    /\b__builtin_expect\b/,
    /\b__extension__\b/,
    /\b__volatile__\b/,
  ],
  greenhill: [
    /\b__ghs_\w+/,
    /#pragma\s+ghs/,
  ],
  ti: [
    /\b_nassert\b/,
    /\b__TI_COMPILER_VERSION__\b/,
    /#pragma\s+CODE_SECTION/,
    /#pragma\s+DATA_SECTION/,
    /\bcregister\b/,
  ],
  windriver: [
    /\b__DCC__\b/,
    /\b__DIAB_/,
    /#pragma\s+use_section/,
  ],
}

/**
 * Auto-detect compiler dialect by scanning source content for dialect markers.
 * Returns the dialect with the most marker hits, or "gcc" as default.
 */
export function detectDialect(sourceContents: string[]): string {
  const scores: Record<string, number> = {}

  for (const content of sourceContents) {
    for (const [dialect, markers] of Object.entries(DIALECT_MARKERS)) {
      for (const marker of markers) {
        if (marker.test(content)) {
          scores[dialect] = (scores[dialect] || 0) + 1
        }
      }
    }
  }

  let bestDialect = "gcc"
  let bestScore = 0
  for (const [dialect, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score
      bestDialect = dialect
    }
  }

  return bestDialect
}
