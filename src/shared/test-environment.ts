export const TEST_ENVIRONMENT_MODE_VALUES = ["software", "evaluation"] as const

export type TestEnvironmentMode = (typeof TEST_ENVIRONMENT_MODE_VALUES)[number]

const TEST_ENVIRONMENT_BY_MODE: Record<TestEnvironmentMode, string> = {
  software: "软平台测试环境",
  evaluation: "硬平台测试环境",
}

/**
 * Resolve the persisted confirmation-test environment text.
 *
 * Current behavior:
 * - software   -> 软平台测试环境
 * - evaluation -> 硬平台测试环境
 *
 * Keep this mapping centralized so callers can switch modes later
 * without changing testcase normalization / suite persistence logic.
 */
export function resolveGeneratedTestEnvironment(
  mode: TestEnvironmentMode = "software",
): string {
  return TEST_ENVIRONMENT_BY_MODE[mode] ?? TEST_ENVIRONMENT_BY_MODE.software
}
