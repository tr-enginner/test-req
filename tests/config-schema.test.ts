import { describe, expect, test } from "bun:test"
import { DEFAULT_CONFIG, MatrixConfigSchema } from "../src/config/schema"

describe("MatrixConfigSchema", () => {
  test("defaults Phase 6 execution thresholds", () => {
    expect(DEFAULT_CONFIG.phase6_execution_pass_rate_threshold).toBe(60)
    expect(DEFAULT_CONFIG.phase6_execution_max_optimization_rounds).toBe(1)

    const parsed = MatrixConfigSchema.parse({
      phase6_execution_pass_rate_threshold: 95,
      phase6_execution_max_optimization_rounds: 2,
    })
    expect(parsed.phase6_execution_pass_rate_threshold).toBe(95)
    expect(parsed.phase6_execution_max_optimization_rounds).toBe(2)
  })
})
