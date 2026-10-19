import { z } from "zod"
import { ReportMeta } from "./report-meta"

/** Test platform component (hardware or software element) */
export const TestPlatformComponent = z.object({
  name: z.string(),
  type: z.enum(["hardware", "software", "firmware"]),
  version: z.string().optional(),
  description: z.string().optional(),
})
export type TestPlatformComponent = z.infer<typeof TestPlatformComponent>

/** Test platform (host or target environment) */
export const TestPlatform = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(["host", "target", "hybrid"]),
  os: z.string().optional(),
  processor: z.string().optional(),
  components: z.array(TestPlatformComponent).default([]),
  description: z.string().optional(),
})
export type TestPlatform = z.infer<typeof TestPlatform>

/** Test tool description */
export const TestToolDescription = z.object({
  name: z.string(),
  version: z.string().optional(),
  purpose: z.string(),
  qualification_status: z.string().optional(),
})
export type TestToolDescription = z.infer<typeof TestToolDescription>

/** Simulation model description */
export const SimulationModel = z.object({
  name: z.string(),
  simulated_component: z.string(),
  fidelity: z.enum(["high", "medium", "low"]).optional(),
  description: z.string().optional(),
})
export type SimulationModel = z.infer<typeof SimulationModel>

/** Single baseline test entry */
export const BaselineTest = z.object({
  /** Baseline test ID (e.g., BL-001) */
  id: z.string(),
  /** Test name */
  name: z.string(),
  /** Execution status */
  status: z.enum(["pass", "fail", "skip", "not_run"]),
  /** Description of what is being verified */
  description: z.string().optional(),
  /** Specific verification method */
  verification_method: z.string().optional(),
  /** Expected result */
  expected_result: z.string().optional(),
  /** Actual result observed */
  actual_result: z.string().optional(),
  /** Reason for failure (when status is "fail") */
  failure_reason: z.string().optional(),
  /** Related requirement IDs for traceability */
  related_requirements: z.array(z.string()).default([]),
  /** Execution duration in milliseconds */
  duration_ms: z.number().optional(),
})
export type BaselineTest = z.infer<typeof BaselineTest>

/** Baseline test results — output of environment verification (Step 6) */
export const BaselineTestResult = z.object({
  /** Project name */
  project_name: z.string(),
  /** ISO date string of test execution */
  test_date: z.string(),
  /** Simulation platform identifier (e.g., "vtest", "qemu") */
  platform: z.string(),
  /** Overall pass/fail/partial verdict */
  overall_status: z.enum(["pass", "fail", "partial"]),
  /** Individual baseline test results */
  tests: z.array(BaselineTest).default([]),
  /** Count of passed tests */
  pass_count: z.number(),
  /** Count of failed tests */
  fail_count: z.number(),
  /** Count of skipped tests */
  skip_count: z.number().optional(),
  /** Coverage summary text */
  coverage_summary: z.string().optional(),
})
export type BaselineTestResult = z.infer<typeof BaselineTestResult>

/** Test environment design — main output of EnvArchitect (Phase 5) */
export const TestEnvironmentDesign = ReportMeta.merge(z.object({
  platforms: z.array(TestPlatform).default([]),
  tools: z.array(TestToolDescription).default([]),
  simulation_models: z.array(SimulationModel).default([]),
  /** Analysis of differences between test env and target env */
  environment_difference_analysis: z.string().optional(),
  /** Configuration baseline status */
  baseline_status: z.string().optional(),
}))
export type TestEnvironmentDesign = z.infer<typeof TestEnvironmentDesign>
