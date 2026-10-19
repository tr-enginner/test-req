// Report Metadata (shared triple)
export { ReportMeta } from "./report-meta"
export {
  ReviewedFunction,
  BehaviorSafetyBatchRecord,
  BehaviorSafetyRecord,
} from "./behavior-safety"

// Software Under Test
export {
  SoftwareRequirement,
  InterfaceDefinition,
  DataFlowNode,
  DataFlowEdge,
  DataFlowGraph,
  FunctionInfo,
  SoftwareModule,
  TraceabilityEntry,
  GapEntry,
  OrphanEntry,
  InterruptEntry,
  RuntimeEnvironment,
  SoftwareAnalysisReport,
} from "./sut"
export {
  SOFTWARE_ANALYSIS_STAGE_IDS,
  SoftwareAnalysisStage01Payload,
  SoftwareAnalysisStage02Payload,
  SoftwareAnalysisStage03FunctionChunk,
  SoftwareAnalysisStage03FunctionChunkRef,
  SoftwareAnalysisStage03FunctionIndexEntry,
  SoftwareAnalysisStage03Payload,
  SoftwareAnalysisStage04Payload,
  SoftwareAnalysisStage05Payload,
  SoftwareAnalysisStage06Payload,
  SoftwareAnalysisStageArtifact,
  SoftwareAnalysisStageManifest,
} from "./software-analysis-stage"
export { CallGraph } from "./callgraph"
export { ModuleDependencyGraph } from "./module-dependency-graph"

// Test Requirements
export {
  TestRequirement,
  TestRequirementSpec,
  TestRequirementFlatItem,
  TestRequirementFlatArtifact,
  isFlatTestRequirements,
  TestRequirementsArtifact,
} from "./test-requirement"
export {
  InterfaceDirection,
  InterfaceTestBatchTarget,
  InterfaceTestPlan,
  InterfaceTestTableRow,
  InterfaceTestBatchRaw,
  InterfaceTestGap,
  InterfaceTestContent,
  InterfaceTestGaps,
} from "./interface-test-content"
export {
  PerformanceRelatedDescription,
  PerformanceTestTableRow,
  PerformanceTestRaw,
  PerformanceTestGap,
  PerformanceTestContent,
  PerformanceTestGaps,
} from "./performance-test-content"
export {
  ReliabilitySafetyRelatedDescription,
  ReliabilitySafetyTestTableRow,
  ReliabilitySafetyTestRaw,
  ReliabilitySafetyTestContent,
  ReliabilitySafetyTestGaps,
} from "./reliability-safety-test-content"
export {
  MarginRelatedDescription,
  MarginTestTableRow,
  MarginTestRaw,
  MarginTestContent,
  MarginTestGaps,
} from "./margin-test-content"
export {
  BoundaryRelatedDescription,
  BoundaryTestTableRow,
  BoundaryTestRaw,
  BoundaryTestContent,
  BoundaryTestGaps,
} from "./boundary-test-content"
export {
  DataProcessingRelatedDescription,
  DataProcessingTestTableRow,
  DataProcessingTestRaw,
  DataProcessingTestContent,
  DataProcessingTestGaps,
} from "./data-processing-test-content"
export {
  RecoveryRelatedDescription,
  RecoveryTestTableRow,
  RecoveryTestRaw,
  RecoveryTestContent,
  RecoveryTestGaps,
} from "./recovery-test-content"
export {
  StrengthRelatedDescription,
  StrengthTestTableRow,
  StrengthTestRaw,
  StrengthTestContent,
  StrengthTestGaps,
} from "./strength-test-content"

// Defects
export { DefectSource, Defect, DefectDatabase } from "./defect"

// Unit Test Cases
export {
  TestParam,
  UnitTestCase,
  UnitTestResult,
  UnitTestReport,
} from "./unit-test-case"

// Confirmation Test Cases
export {
  TestStepRecord,
  TestStepWithAnchors,
  normalizeTestStepRecords,
  TranslatedStepParameter,
  TranslatedTestStepRecord,
  UnifiedStepParameter,
  UnifiedTestStepRecord,
  isUnifiedStepArray,
  migrateLegacyStepsToUnified,
  ensureUnifiedSteps,
  extractSourceStepsFromUnified,
  extractSourceSteps,
  extractTranslatedStepsFromUnified,
  SourceConfirmationTestCase,
  SourceConfirmationTestSuite,
  TranslatedConfirmationTestCase,
  TranslatedConfirmationTestSuite,
  ConfirmationTestCase,
  ConfirmationTestSuite,
} from "./confirmation-test-case"

// Test Environment Design
export {
  TestPlatformComponent,
  TestPlatform,
  TestToolDescription,
  SimulationModel,
  TestEnvironmentDesign,
} from "./test-environment"

// Test Execution
export {
  StepResult,
  TestCaseExecution,
  TestExecutionReport,
} from "./test-execution"
export {
  Phase6CoverageTarget,
  Phase6ExecutionLoopRound,
  Phase6ExecutionLoopArtifact,
} from "./phase6-execution-loop"
export {
  Phase6GenerationItem,
  Phase6GenerationManifest,
  Phase6RunSnapshot,
  Phase6RunEvent,
  Phase6WorkerDiagnostic,
  Phase6WorkerResultRequirement,
  Phase6WorkerResultSummary,
} from "./phase6-structured-artifacts"

// Review
export { ReviewIssue, ReviewRecord } from "./review"
export {
  Phase6PreparedTemplateBaseline,
  Phase6PreparedCoverage,
  Phase6PreparedBrokenLink,
  Phase6PreparedPathMismatch,
  Phase6PreparedRelatedRequirementMismatch,
  Phase6PreparedPlaceholder,
  Phase6PreparedFieldIssue,
  Phase6PreparedSemanticValidationFailure,
  Phase6PreparedCandidateIssue,
  Phase6PreparedSummary,
  Phase6CaseReviewPrepared,
} from "./phase6-case-review-prepared"

// Test Summary
export { TestSummary } from "./test-summary"

// Compilation Environment
export {
  CompilerDialect,
  BuildSystemType,
  CompileCommand,
  CompilationDatabase,
  HeaderStub,
  CompilationEnvironment,
} from "./compilation"

// Metrics
export {
  TokenMetrics,
  MetricEntry,
  AgentSummary,
  PhaseSummary,
  MetricsDatabase,
  createEmptyMetricsDatabase,
  recomputeSummaries,
} from "./metrics"

// SA Raw Findings
export { SARawFinding, SARawFindingsReport } from "./sa-raw-findings"

// SA Pre-classification
export {
  PreClassification,
  PreClassifiedFinding,
  PreClassificationReport,
} from "./sa-preclassification"

// Cover Info
export { CoverInfo } from "./cover-info"

// Outline TR
export { OutlineTrItem, OutlineSection, OutlineParsingResult } from "./outline-tr"

// Eval Description
export { RangeMapping, EvalDescConfig } from "./eval-desc"

// Spec Repair
export {
  SpecRule,
  SpecRuleset,
  Fixability,
  RiskLevel,
  RepairConfidence,
  PatchHunk,
  RepairRationale,
  RepairSuggestion,
  VerificationResult,
  RepairPlan,
} from "./spec-repair"

// Inspector local-subgraph context pack
export {
  InspectorLocalSubgraphManifest,
  InspectorLocalSubgraphManifestEntry,
  InspectorLocalSubgraphContext,
} from "./context-pack"

// Single-Variable Atomicity
export {
  SinglevarPattern,
  SinglevarAccessTriple,
  CrossFunctionRelaxation,
  ConsecutiveLocalPair,
  RemoteAccess,
  InterruptSummaryEntry,
  InterruptSummary,
  AliasRule,
  AliasNormalization,
  LoopContext,
  SinglevarViolationCandidate,
  SinglevarViolation,
  SinglevarAnalysisResult,
} from "./singlevar-atomicity"

