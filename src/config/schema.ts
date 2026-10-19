import { z } from "zod"

/** Supported testing standards */
export const TestStandard = z.enum([
  "gjb5000a",
  "gjb2725",
  "gjb141",
  "do178c",
  "iec61508",
  "custom",
])
export type TestStandard = z.infer<typeof TestStandard>

/** Supported documentation standards */
export const DocStandard = z.enum(["gjb2725", "gjb141", "custom"])
export type DocStandard = z.infer<typeof DocStandard>

/** Coverage target */
export const CoverageTarget = z.enum(["statement", "branch", "mc_dc", "condition", "path"])
export type CoverageTarget = z.infer<typeof CoverageTarget>

/** Plugin configuration schema */
export const MatrixConfigSchema = z.object({
  /** Testing process standard */
  standard: TestStandard.default("custom"),

  /** Documentation output standard */
  doc_standard: DocStandard.default("custom"),

  /** Code coverage target */
  coverage_target: CoverageTarget.default("statement"),

  /** Coverage target percentage threshold (0-100). Default 90. */
  coverage_target_percentage: z.number().min(0).max(100).default(90),

  /** Static analysis tools to use */
  static_tools: z.array(z.string()).default(["cppcheck"]),

  /** Unit test framework */
  unit_framework: z.enum(["unity", "cunit", "gtest", "custom"]).default("unity"),

  /** Target platform description */
  target_platform: z.string().optional(),

  /** Coding standard for static analysis */
  coding_standard: z.enum(["misra-c-2012", "gjb5369", "cert-c", "custom"]).default("misra-c-2012"),

  /** Compiler dialect for the project (auto-detected if not set) */
  compiler_dialect: z.enum([
    "auto", "gcc", "armcc", "armclang", "iar", "keil", "c51",
    "greenhill", "ti", "windriver", "generic",
  ]).default("auto"),

  /** Application domain for domain-specific test case generation patterns.
   *  "satellite-dsp" enables satellite/spacecraft DSP domain templates with
   *  CAN bus, FPGA telemetry, and polling sequence conventions.
   *  "generic" uses the base generic templates only.
   *  默认 generic(2026-09-14 用户拍板):satellite 族长期失修且作隐形默认
   *  会让无配置项目意外命中 satellite-* 模板;satellite 域改为显式 opt-in。 */
  domain: z.enum(["satellite-dsp", "generic"]).default("generic"),

  /** Target CPU architecture (e.g., cortex-m4, cortex-a9) */
  target_cpu: z.string().optional(),

  /** Additional include directories for compilation database */
  extra_include_dirs: z.array(z.string()).default([]),

  /** Additional preprocessor defines (e.g., STM32F407xx, USE_HAL_DRIVER) */
  extra_defines: z.array(z.string()).default([]),

  /** Path to existing compile_commands.json (skip generation if provided) */
  compile_commands_path: z.string().optional(),

  /** Source directories to analyze (defaults to project root) */
  source_dirs: z.array(z.string()).default([]),

  /** Disabled agents */
  disabled_agents: z.array(z.string()).default([]),

  /** Disabled hooks */
  disabled_hooks: z.array(z.string()).default([]),

  /** Disabled tools */
  disabled_tools: z.array(z.string()).default([]),

  /** Optional keyword library directories for confirmation test step generation */
  keyword_dirs: z.array(z.string()).default([]),

  /** Legacy protocol document directories; Phase 6 now reads .matrix/reports/*第三方测试需求*.docx */
  protocol_search_dirs: z.array(z.string()).default([]),

  /** Phase 6 worker concurrency for code-side confirmation test generation */
  phase6_worker_concurrency: z.number().int().min(1).max(20).default(5),

  /** Phase 6 DTP execution pass-rate threshold percentage (0-100). Default 60. */
  phase6_execution_pass_rate_threshold: z.number().min(0).max(100).default(60),

  /** Maximum Phase 6 execution optimization rounds after the first failed run. Default 1. */
  phase6_execution_max_optimization_rounds: z.number().int().min(0).default(1),

  /** Unified Matrix installation root. Tools are resolved from fixed relative paths under this directory. */
  install_root: z.string().optional(),

  /** Custom checklist path */
  custom_checklist_path: z.string().optional(),

  /** Auto-advance phases without user confirmation */
  auto_advance: z.boolean().default(false),

  /** Output language for human-readable reports and messages (default: zh-CN) */
  output_language: z.enum(["zh-CN", "en"]).default("zh-CN"),

  /** Whether to generate code understanding wiki (default: true) */
  wiki_enabled: z.boolean().default(true),

  /** Whether to include Mermaid diagrams in wiki Markdown output (default: true) */
  wiki_mermaid: z.boolean().default(true),

  /** Wiki generation depth: "full" for function-level detail, "modules_only" to skip function-level */
  wiki_depth: z.enum(["full", "modules_only"]).default("full"),

  /** Model compatibility tier for tool-calling format guidance */
  model_compat: z.enum(["auto", "off", "standard", "basic"]).default("auto"),

  /** Joern installation directory (contains joern.bat / joern and joern-parse.bat / joern-parse) */
  joern_home: z.string().optional(),

  /** Z3 installation directory (contains bin/z3.exe or bin/z3) */
  z3_home: z.string().optional(),

  /** SpecChecker installation directory (contains specchecker.exe) */
  specchecker_home: z.string().optional(),

  /** SpecChecker ruleset name (default: 航天器C语言软件编程约定2024版) */
  specchecker_ruleset: z.string().optional(),

  /** Enable auto-repair generation in static analysis (default: false — analysis only) */
  static_repair_enabled: z.boolean().default(false),

  /** VTest installation directory containing vtestc.exe (e.g., "C:\\SunwiseInfo\\VTest3.4.0\\VTest") */
  vtest_home: z.string().optional(),

  /** Visual Studio 2013 installation path for VTest DLL command-line compilation via MSBuild (e.g., "C:\\Program Files (x86)\\Microsoft Visual Studio 12.0"). MSBuild.exe is resolved at "<vs2013_path>\\..\\MSBuild\\12.0\\Bin\\MSBuild.exe". */
  vs2013_path: z.string().optional(),

  /** VTest 平台参考文档路径（手册、API 说明等 .md/.txt/.h 文件所在目录） */
  vtest_docs_paths: z.array(z.string()).default([]),

  /** VTest 模拟器源码路径（用于学习 VTest 机制和提取引脚定义，指向源码目录） */
  vtest_src_paths: z.array(z.string()).default([]),

  /**
   * Paths to test environment hardware description documents (ICD, schematic, datasheet, etc.)
   * EnvArchitect reads these to extract interface specifications for simulation model generation.
   * Supports glob patterns (e.g., "docs/icd/*.pdf", "docs/硬件接口说明.docx").
   */
  test_env_hardware_docs: z.array(z.string()).default([]),

  /** Path to SunwiseAUnit installation directory (e.g., "D:\\Sunwiseinfo\\4.1.1") */
  aunit_path: z.string().optional(),

  /** Explicit AUnit platform config name (overrides auto-mapping from compiler_dialect) */
  aunit_platform: z.string().optional(),

  /** Per-function timeout (ms) for aunit_autogen Z3 solver (default: 604800000 = 1 week, effectively no limit) */
  aunit_autogen_timeout: z.number().min(10_000).max(604_800_000).default(604_800_000),

  /** Project-level metadata (user-declared facts for report generation) */
  project: z.object({
    /** CSCI name (配置项名称) */
    csci_name: z.string().optional(),
    /** Parent system name */
    system_name: z.string().optional(),
    /** Software criticality level (e.g., "A", "B", "甲") */
    software_level: z.string().optional(),
    /** Developer organization */
    developer_org: z.string().optional(),
    /** Client / testing organization */
    client_org: z.string().optional(),
    /** Client organization address */
    client_address: z.string().optional(),
    /** Code baseline version under test (pre-fill hint; authoritative source is SoftwareAnalysisReport) */
    version: z.string().optional(),
    /** Document identifier prefix (e.g., "PROJ-2026-001") */
    doc_id: z.string().optional(),
    /** Document author (编写人) */
    author: z.string().optional(),
    /** Proofreader (校对人) */
    reviewer_1: z.string().optional(),
    /** Reviewer (审核人) */
    reviewer_2: z.string().optional(),
    /** Co-signer (会签人) */
    co_signer: z.string().optional(),
    /** Standards checker (标检人) */
    standard_checker: z.string().optional(),
    /** Approver (批准人) */
    approver: z.string().optional(),
    /** Reference documents cited in the test specification */
    reference_documents: z.array(z.object({
      id: z.string(),
      title: z.string(),
      version: z.string().optional(),
    })).default([]),
  }).default({ reference_documents: [] }),
})
export type MatrixConfig = z.infer<typeof MatrixConfigSchema>

/** Default configuration */
export const DEFAULT_CONFIG: MatrixConfig = MatrixConfigSchema.parse({})
