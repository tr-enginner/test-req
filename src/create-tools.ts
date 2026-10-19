import type { OpencodeClient } from "@opencode-ai/sdk/client"
import type { MatrixConfig } from "./config/schema"
import { reqParser } from "./tools/req-parser"
import { filldataParser } from "./tools/filldata-parser"
import { callgraphBuilder } from "./tools/callgraph-builder"
import { moduleDependencyBuilder } from "./tools/module-dependency-builder"
import { codeParser } from "./tools/code-parser"
import { misraChecker } from "./tools/misra-checker"
import { unitRunner } from "./tools/unit-runner"
import { coverageReport } from "./tools/coverage-report"
import { testEnvCtrl } from "./tools/test-env-ctrl"
import { testExecutor } from "./tools/test-executor"
import { docGenerator } from "./tools/doc-generator"
import { compdbGenerator } from "./tools/compdb-generator"
import { headerStubGenerator } from "./tools/header-stub-generator"
import { codePreprocessor } from "./tools/code-preprocessor"
import { metricsReport } from "./tools/metrics-report"
import { mdbookGenerator } from "./tools/mdbook-generator"
import { astgrepRunner } from "./tools/astgrep-runner"
import { testcaseGeneratorRun, testcaseFormatCheck } from "./tools/testcase-generator-runner"
import { phase6WorkerOutputAppend } from "./tools/phase6-worker-output-append"

import { phase6CaseReviewPrepare } from "./tools/phase6-case-review-prepare"
import { createPhase6PublishOutputs } from "./tools/phase6-publish-outputs"
import { createPhase6ExecutionLoop } from "./tools/phase6-execution-loop"
import { testInputGenerator } from "./tools/test-input-generator"
import { multivarCpgCreate } from "./tools/multivar-cpg-create"
import { multivarCorrelatedVars } from "./tools/multivar-correlated-vars"
import { multivarViolationDetect } from "./tools/multivar-violation-detect"
import { multivarFeasibilityVerify } from "./tools/multivar-feasibility-verify"
import { singlevarCpgGet } from "./tools/singlevar-cpg-get"
import { singlevarPatternDetect } from "./tools/singlevar-pattern-detect"
import { singlevarFeasibilityVerify } from "./tools/singlevar-feasibility-verify"
import {
  ctSuiteCreate,
  ctSuiteAddCase,
  ctSuiteImportCases,
  ctSuiteFinalize,
} from "./tools/ct-suite-builder"
import {
  utReportCreate,
  utReportAddCase,
  utReportAddResult,
  utReportFinalize,
} from "./tools/ut-report-builder"
import {
  execReportCreate,
  execReportAddExecution,
  execReportFinalize,
} from "./tools/exec-report-builder"
import {
  aunitCreateProject,
  aunitBuild,
  aunitAutogen,
  aunitRunCase,
  aunitReport,
  aunitInjectCases,
  aunitEnrichCases,
  aunitSyncReport,
  aunitListPlatforms,
  aunitCoverageSupplement,
  aunitValidatePlatform,
} from "./tools/aunit"
import { issueReportGenerator } from "./tools/issue-report-generator"
import { ctDocxGenerator } from "./tools/ct-docx-generator"
import { phase6ExampleAnalyze } from "./tools/phase6-example-analyzer"
import { coverInfoExtractor } from "./tools/cover-info-extractor"
import { defectAppender } from "./tools/defect-appender"
import { saPreclassifier } from "./tools/sa-preclassifier"
import { saFindingFetcher } from "./tools/sa-finding-fetcher"
import { saResultAppender } from "./tools/sa-result-appender"
import { saContextProbe } from "./tools/sa-context-probe"
import { saFileView } from "./tools/sa-file-view"
import { saWaveGuard } from "./tools/sa-wave-guard"
import { codeSliceContextPack } from "./tools/code-slice-context-pack"
import { outlineTrExtractor } from "./tools/outline-tr-extractor"
import { evalDescGenerator } from "./tools/eval-desc-generator"
import { createDtpRobotGenerator } from "./tools/dtp-robot-generator"
import { createDtpTestDataGenerator } from "./tools/dtp-case-test-data-generator"
import { preflightChecker } from "./tools/preflight-checker"
import { repoRead } from "./tools/repo-read"
import { matrixArtifactQuery } from "./tools/matrix-artifact-query"
import { filldataPhase2Workflow } from "./tools/filldata-phase2-workflow"
import { dtpExecutor } from "./tools/dtp-executor"
import {
  createBehaviorSafetyFinalize,
  createBehaviorSafetyPlan,
  createBehaviorSafetyRunBatch,
} from "./tools/behavior-safety-execute"
import { softwareAnalysisArtifacts } from "./tools/software-analysis-artifacts"
import { traceabilityBuilder } from "./tools/traceability-builder"
import { wikiArtifacts } from "./tools/wiki-artifacts"
import { wikiPlanBuilder } from "./tools/wiki-plan-builder"
import { wikiExecutionPlanner } from "./tools/wiki-execution-planner"
import { wikiDataStructuresExtract } from "./tools/wiki-data-structures-extract"
import { robotExecutor } from "./tools/robot-executor"
import { vtestProjectGenerator, vtestProjectUpdater } from "./tools/vtest-project-generator"
import { vtestDeviceGenerator } from "./tools/vtest-device-generator"
import { vtestScriptGenerator } from "./tools/vtest-script-generator"
import { vtestRunner } from "./tools/vtest-runner"
import { vtestCompiler } from "./tools/vtest-compiler"
import { vtestLearnPlatform } from "./tools/vtest-learn-platform"
import { initProgress } from "./tools/progress-init"

/**
 * Create all tool definitions for the plugin.
 * Returns a Record<string, ToolDefinition> for the plugin's tool: hook.
 */
export function createTools(pluginConfig: MatrixConfig, client: OpencodeClient) {
  const allTools: Record<string, any> = {
    req_parser: reqParser,
    filldata_parser: filldataParser,
    filldata_phase2_workflow: filldataPhase2Workflow,
    callgraph_builder: callgraphBuilder,
    module_dependency_builder: moduleDependencyBuilder,
    code_parser: codeParser,
    specchecker: misraChecker,
    unit_runner: unitRunner,
    coverage_report: coverageReport,
    test_env_ctrl: testEnvCtrl,
    test_executor: testExecutor,
    doc_generator: docGenerator,
    compdb_generator: compdbGenerator,
    header_stub_generator: headerStubGenerator,
    code_preprocessor: codePreprocessor,
    // Incremental builder tools
    ct_suite_create: ctSuiteCreate,
    ct_suite_add_case: ctSuiteAddCase,
    ct_suite_import_cases: ctSuiteImportCases,
    ct_suite_finalize: ctSuiteFinalize,
    ut_report_create: utReportCreate,
    ut_report_add_case: utReportAddCase,
    ut_report_add_result: utReportAddResult,
    ut_report_finalize: utReportFinalize,
    exec_report_create: execReportCreate,
    exec_report_add_execution: execReportAddExecution,
    exec_report_finalize: execReportFinalize,
    metrics_report: metricsReport,
    mdbook_generate: mdbookGenerator,
    astgrep_run: astgrepRunner,
    testcase_generator_run: testcaseGeneratorRun,
    phase6_case_review_prepare: phase6CaseReviewPrepare,
    phase6_publish_outputs: createPhase6PublishOutputs(client),
    phase6_execution_loop: createPhase6ExecutionLoop(client),
    testcase_format_check: testcaseFormatCheck,
    phase6_worker_output_append: phase6WorkerOutputAppend,
    phase6_example_analyze: phase6ExampleAnalyze,
    test_input_generate: testInputGenerator,
    // AUnit tools (SunwiseAUnit CLI wrappers)
    aunit_create_project: aunitCreateProject,
    aunit_build: aunitBuild,
    aunit_autogen: aunitAutogen,
    aunit_run_case: aunitRunCase,
    aunit_report: aunitReport,
    aunit_inject_cases: aunitInjectCases,
    aunit_enrich_cases: aunitEnrichCases,
    aunit_sync_report: aunitSyncReport,
    aunit_list_platforms: aunitListPlatforms,
    aunit_coverage_supplement: aunitCoverageSupplement,
    aunit_validate_platform: aunitValidatePlatform,
    // Atomicity violation detection tools
    multivar_cpg_create: multivarCpgCreate,
    multivar_correlated_vars: multivarCorrelatedVars,
    multivar_violation_detect: multivarViolationDetect,
    multivar_feasibility_verify: multivarFeasibilityVerify,
    // Single-variable atomicity detection tools
    singlevar_cpg_get: singlevarCpgGet,
    singlevar_pattern_detect: singlevarPatternDetect,
    singlevar_feasibility_verify: singlevarFeasibilityVerify,
    issue_report: issueReportGenerator,
    ct_docx_generate: ctDocxGenerator,
    cover_info_extract: coverInfoExtractor,
    dtp_test_data_generate: createDtpTestDataGenerator(client),
    dtp_robot_generate: createDtpRobotGenerator(client),
    behavior_safety_plan: createBehaviorSafetyPlan(client),
    behavior_safety_run_batch: createBehaviorSafetyRunBatch(client),
    behavior_safety_finalize: createBehaviorSafetyFinalize(client),
    software_analysis_artifacts: softwareAnalysisArtifacts,
    traceability_builder: traceabilityBuilder,
    wiki_artifacts: wikiArtifacts,
    wiki_plan_builder: wikiPlanBuilder,
    wiki_execution_planner: wikiExecutionPlanner,
    wiki_data_structures_extract: wikiDataStructuresExtract,
    append_defects: defectAppender,
    sa_preclassify: saPreclassifier,
    sa_context_probe: saContextProbe,
    sa_file_view: saFileView,
    sa_fetch_findings: saFindingFetcher,
    sa_append_review_results: saResultAppender,
    sa_wave_guard: saWaveGuard,
    code_slice_context_pack: codeSliceContextPack,
    preflight_check: preflightChecker,
    outline_tr_extract: outlineTrExtractor,
    eval_desc_generate: evalDescGenerator,
    repo_read: repoRead,
    matrix_artifact_query: matrixArtifactQuery,
    dtp_executor: dtpExecutor,
    robot_executor: robotExecutor,
    // VTest simulation environment tools
    vtest_project_generate: vtestProjectGenerator,
    vtest_project_update: vtestProjectUpdater,
    vtest_device_generate: vtestDeviceGenerator,
    vtest_script_generate: vtestScriptGenerator,
    vtest_runner: vtestRunner,
    vtest_compile: vtestCompiler,
    vtest_learn_platform: vtestLearnPlatform,
    init_progress: initProgress,
  }

  // Filter disabled tools
  const disabledTools = new Set(pluginConfig.disabled_tools)
  const filteredTools: Record<string, any> = {}
  for (const [name, def] of Object.entries(allTools)) {
    if (!disabledTools.has(name)) {
      filteredTools[name] = def
    }
  }

  return filteredTools
}
