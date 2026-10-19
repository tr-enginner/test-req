/** Test phase definitions */
export const PHASES = {
  TASK_CLASSIFICATION: 0,
  SOFTWARE_ANALYSIS: 1,
  TEST_REQUIREMENTS: 2,
  CODE_REVIEW_STATIC: 3,
  UNIT_TEST: 4,
  TEST_ENVIRONMENT: 5,
  TEST_CASE_DESIGN: 6,
  TEST_EXECUTION: 7,
  TEST_SUMMARY: 8,
} as const

export type PhaseNumber = (typeof PHASES)[keyof typeof PHASES]

/** Phase IDs for DAG-based dependency system (superset of PhaseNumber, includes "1b") */
export const PHASE_IDS = ["0", "1", "1b", "2", "3", "4", "5", "6", "7", "8"] as const
export type PhaseId = (typeof PHASE_IDS)[number]

/** Phase dependency graph — each phase lists its prerequisites */
export const PHASE_DEPS: Record<PhaseId, PhaseId[]> = {
  "0": [],
  "1": ["0"],
  "1b": ["1"],
  "2": ["0"],
  "3": ["1", "2"],
  "4": ["1", "2"],
  "5": ["1", "2"],
  "6": ["2"],
  "7": ["5", "6"],
  "8": ["3", "4", "6"],
}

export const PHASE_NAMES: Record<PhaseId, string> = {
  "0": "Task Classification",
  "1": "Software Analysis",
  "1b": "Code Wiki Generation",
  "2": "Test Requirements Analysis",
  "3": "Code Review & Static Analysis",
  "4": "Unit Testing",
  "5": "Test Environment Development",
  "6": "Confirmation Test Case Design",
  "7": "Test Execution",
  "8": "Test Summary",
}

/** Phases requiring review before proceeding */
export const REVIEW_REQUIRED_PHASES: PhaseId[] = ["2", "5", "6"]


/** Agent responsible for each phase */
export const PHASE_AGENTS: Record<PhaseId, string | string[]> = {
  "0": "conductor",
  "1": "analyst",
  "1b": "wiki-scheduler",
  "2": "filldata-enricher",
  "3": ["inspector", "static-analyzer", "isr-reviewer", "multivar-atomicity-checker", "singlevar-atomicity-checker"],
  "4": "unit-tester",
  "5": "env-architect",
  "6": "test-designer",
  "7": "test-executor",
  "8": "summarizer",
}

/** Artifact paths relative to project root */
export const DATA_DIR = ".matrix/data"
export const REPORTS_DIR = ".matrix/reports"
export const CONFIG_DIR = ".matrix/config"
export const PLANS_DIR = ".matrix/plans"
export const STATE_DIR = ".matrix/state"
export const TEST_ENV_DIR = ".matrix/test-env"
export const REVIEWS_DIR = `${DATA_DIR}/reviews`
export const STUBS_DIR = ".matrix/stubs"
export const PREPROCESSED_DIR = ".matrix/preprocessed"
export const REVIEW_RECORDS_DIR = `${DATA_DIR}/review-records`
export const WIKI_DIR = ".matrix/wiki"
export const WIKI_MODULES_DIR = `${WIKI_DIR}/modules`
export const WIKI_FUNCTIONS_DIR = `${WIKI_DIR}/functions`
export const WIKI_INDEX_FUNCTIONS_DIR = `${WIKI_DIR}/index-functions`
export const WIKI_REPORTS_DIR = `${REPORTS_DIR}/code-wiki`
export const BOOK_DIR = ".matrix/book"
export const AUNIT_DIR = ".matrix/aunit"
export const CONTEXTS_DIR = `${DATA_DIR}/contexts`
export const PHASE6_WORKER_PROMPTS_DIR = `${DATA_DIR}/phase6-worker-prompts`
export const PHASE6_WORKER_RUNS_DIR = `${DATA_DIR}/phase6-worker-runs`
export const PHASE6_WORKER_RUNS_LATEST = `${PHASE6_WORKER_RUNS_DIR}/latest-run.json`
export const PHASE6_GENERATION_MANIFEST = `${DATA_DIR}/phase6-generation-items.json`
export const PHASE6_TEST_CASES_TODO = `${DATA_DIR}/test-cases-todo.txt`
export const PHASE6_EXECUTION_LOOP = `${DATA_DIR}/phase6-execution-loop.json`
export const PHASE6_EXAMPLE_ANALYSIS = `${DATA_DIR}/phase6-example-analysis.json`
export const PHASE6_GENERATION_GUIDE = `${DATA_DIR}/phase6-generation-guide.json`

export const ARTIFACT_PATHS = {
  SOFTWARE_ANALYSIS: `${DATA_DIR}/software-analysis.json`,
  CALLGRAPH: `${DATA_DIR}/callgraph.json`,
  MODULE_DEPENDENCIES: `${DATA_DIR}/module-dependencies.json`,
  SOFTWARE_ANALYSIS_STAGE_MANIFEST: `${DATA_DIR}/software-analysis-stage-manifest.json`,
  SOFTWARE_ANALYSIS_STAGE_01_PROJECT: `${DATA_DIR}/software-analysis-stage-01-project.json`,
  SOFTWARE_ANALYSIS_STAGE_02_REQUIREMENTS: `${DATA_DIR}/software-analysis-stage-02-requirements.json`,
  SOFTWARE_ANALYSIS_STAGE_03_CODE: `${DATA_DIR}/software-analysis-stage-03-code.json`,
  SOFTWARE_ANALYSIS_STAGE_03_CODE_TOOL: `${DATA_DIR}/software-analysis-stage-03-code-tool.json`,
  SOFTWARE_ANALYSIS_STAGE_03_FUNCTIONS_DIR: `${DATA_DIR}/software-analysis-stage-03-functions`,
  SOFTWARE_ANALYSIS_STAGE_04_COMPILATION: `${DATA_DIR}/software-analysis-stage-04-compilation.json`,
  SOFTWARE_ANALYSIS_STAGE_05_TRACEABILITY: `${DATA_DIR}/software-analysis-stage-05-traceability.json`,
  SOFTWARE_ANALYSIS_STAGE_05_TRACEABILITY_TOOL: `${DATA_DIR}/software-analysis-stage-05-traceability-tool.json`,
  SOFTWARE_ANALYSIS_STAGE_05_TRACEABILITY_DIR: `${DATA_DIR}/software-analysis-stage-05-traceability`,
  SOFTWARE_ANALYSIS_STAGE_06_FINALIZE: `${DATA_DIR}/software-analysis-stage-06-finalize.json`,
  TEST_REQUIREMENTS: `${DATA_DIR}/test-requirements.json`,
  SOURCE_PLAN: `${DATA_DIR}/source-plan.json`,
  HARDWARE_INTERFACE_MODEL: `${DATA_DIR}/hardware-interface-model.json`,
  DEFECTS: `${DATA_DIR}/defects.json`,
  UNIT_TESTS: `${DATA_DIR}/unit-tests.json`,
  CONFIRMATION_TESTS: `${DATA_DIR}/confirmation-tests.json`,
  PHASE6_TEST_CASES_TODO: `${DATA_DIR}/test-cases-todo.txt`,
  PHASE6_EXECUTION_LOOP: `${DATA_DIR}/phase6-execution-loop.json`,
  PHASE6_EXAMPLE_ANALYSIS: `${DATA_DIR}/phase6-example-analysis.json`,
  PHASE6_GENERATION_GUIDE: `${DATA_DIR}/phase6-generation-guide.json`,
  TEST_EXECUTION: `${DATA_DIR}/test-execution.json`,
  TEST_SUMMARY: `${DATA_DIR}/test-summary.json`,
  REQ_REVIEW: `${REVIEWS_DIR}/req-review.json`,
  ENV_REVIEW: `${REVIEWS_DIR}/env-review.json`,
  CASE_REVIEW: `${REVIEWS_DIR}/case-review.json`,
  CASE_REVIEW_PREPARED: `${REVIEWS_DIR}/case-review-prepared.json`,
  PROGRESS: `${STATE_DIR}/progress.json`,
  WIKI_EXECUTION_STATE: `${STATE_DIR}/wiki-execution-state.json`,
  WIKI_NEXT_STEP: `${STATE_DIR}/wiki-next-step.json`,
  CONFIG: `${CONFIG_DIR}/matrix.jsonc`,
  WIKI_PLAN: `${PLANS_DIR}/wiki-generation-plan.json`,
  COMPILE_COMMANDS: `${DATA_DIR}/compile_commands.json`,
  COMPILATION_ENV: `${DATA_DIR}/compilation-env.json`,
  INDEX_DB: `${DATA_DIR}/index.db`,
  METRICS: `${DATA_DIR}/metrics.json`,
  REVIEW_RECORDS: `${DATA_DIR}/review-records`,
  CONTEXTS_DIR: `${CONTEXTS_DIR}`,
  CONTEXTS_MANIFEST: `${CONTEXTS_DIR}/manifest.json`,
  PHASE6_WORKER_PROMPTS_DIR: `${PHASE6_WORKER_PROMPTS_DIR}`,
  PHASE6_WORKER_RUNS_DIR: `${PHASE6_WORKER_RUNS_DIR}`,
  PHASE6_WORKER_RUNS_LATEST: `${PHASE6_WORKER_RUNS_LATEST}`,
  PHASE6_GENERATION_MANIFEST: `${PHASE6_GENERATION_MANIFEST}`,
  WIKI_INDEX: `${WIKI_DIR}/index.json`,
  WIKI_INDEX_FUNCTIONS_DIR: `${WIKI_INDEX_FUNCTIONS_DIR}`,
  WIKI_DATA_STRUCTURES: `${WIKI_DIR}/data-structures.json`,
  REPAIR_PLAN: `${DATA_DIR}/repair-plan.json`,
  ENV_DESIGN: `${TEST_ENV_DIR}/env-design.json`,
  SA_RAW_FINDINGS: `${DATA_DIR}/sa-raw-findings.json`,
  SA_PRECLASSIFICATION: `${DATA_DIR}/sa-preclassification.json`,
  STANDARDS_ONLY: `${DATA_DIR}/standards-only.json`,
  FALSE_POSITIVES: `${DATA_DIR}/false-positives.json`,
  SA_REVIEW_WAVES: `${STATE_DIR}/sa-review-waves.json`,
  OUTLINE_TR: `${DATA_DIR}/outline-tr.json`,
} as const

export const SOFTWARE_ANALYSIS_STAGE_03_FUNCTION_CHUNK_SIZE = 200
export const SOFTWARE_ANALYSIS_STAGE_05_TRACEABILITY_CHUNK_SIZE = 200
export const WIKI_INDEX_FUNCTION_CHUNK_SIZE = 200

export const SOFTWARE_ANALYSIS_STAGE_PATHS = {
  "01-project": ARTIFACT_PATHS.SOFTWARE_ANALYSIS_STAGE_01_PROJECT,
  "02-requirements": ARTIFACT_PATHS.SOFTWARE_ANALYSIS_STAGE_02_REQUIREMENTS,
  "03-code": ARTIFACT_PATHS.SOFTWARE_ANALYSIS_STAGE_03_CODE,
  "04-compilation": ARTIFACT_PATHS.SOFTWARE_ANALYSIS_STAGE_04_COMPILATION,
  "05-traceability": ARTIFACT_PATHS.SOFTWARE_ANALYSIS_STAGE_05_TRACEABILITY,
  "06-finalize": ARTIFACT_PATHS.SOFTWARE_ANALYSIS_STAGE_06_FINALIZE,
} as const

/** Report paths (human-readable markdown) */
export const REPORT_PATHS = {
  SOFTWARE_ANALYSIS: `${REPORTS_DIR}/software-analysis.md`,
  TEST_REQUIREMENTS: `${REPORTS_DIR}/test-requirements.md`,
  HARDWARE_INTERFACE_MODEL: `${REPORTS_DIR}/hardware-interface-model.docx`,
  CODE_REVIEW: `${REPORTS_DIR}/code-review.md`,
  STATIC_ANALYSIS: `${REPORTS_DIR}/static-analysis.md`,
  INTERRUPT_REVIEW: `${REPORTS_DIR}/interrupt-review.md`,
  UNIT_TEST: `${REPORTS_DIR}/unit-test.md`,
  TEST_CASES: `${REPORTS_DIR}/test-cases.md`,
  TEST_EXECUTION: `${REPORTS_DIR}/test-execution.md`,
  TEST_SUMMARY: `${REPORTS_DIR}/test-summary.md`,
  ISSUE_REPORT: `${REPORTS_DIR}/issue-report.docx`,
  FPGA_EVAL_DESC: `${REPORTS_DIR}/fpga-eval-desc.docx`,
  SOFTWARE_EVAL_DESC: `${REPORTS_DIR}/software-eval-desc.docx`,
} as const


/** Max consecutive failures before escalation to Oracle */
export const MAX_FAILURES_BEFORE_ESCALATION = 3

/** Max blocking issues per review */
export const MAX_REVIEW_ISSUES = 5

/** Ordered chapter list for mdbook site generation */
export const REPORT_CHAPTERS: { title: string; file: string }[] = [
  { title: "Code Understanding", file: "code-wiki" },
  { title: "Software Analysis", file: "software-analysis.md" },
  { title: "Test Requirements", file: "test-requirements.md" },
  { title: "Code Review", file: "code-review.md" },
  { title: "Static Analysis", file: "static-analysis.md" },
  { title: "Interrupt Review", file: "interrupt-review.md" },
  { title: "Atomicity Violation Analysis", file: "multivar-violation.md" },
  { title: "Unit Test", file: "unit-test.md" },
  { title: "Test Cases", file: "test-cases.md" },
  { title: "Test Execution", file: "test-execution.md" },
  { title: "Test Summary", file: "test-summary.md" },
]
