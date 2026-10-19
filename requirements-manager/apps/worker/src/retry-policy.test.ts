import {describe, expect, it} from "vitest";
import {decidePhase2Retry, Phase2ExecutionError, retryDelayMs} from "./retry-policy.js";

describe("Phase 2 retry policy", () => {
    it("retries deterministic workflow errors whenever automatic retry is enabled", () => {
        const error = new Phase2ExecutionError("candidate schema invalid", "HARDWARE_INTERFACE_PREPARE_FAILED", false, "HI-006");
        const result = decidePhase2Retry({autoRetry: true, attempt: 1, stage: "prepare_hardware_interface_batches", error});
        expect(result).toMatchObject({shouldRetry: true, retryable: true, stopReason: undefined, maxAttempts: null, failedCandidateId: "HI-006"})
    });

    it("uses a bounded fixed delay and does not stop after three attempts", () => {
        const error = new Phase2ExecutionError("file busy", "IO_EBUSY", true);
        expect(retryDelayMs(1)).toBe(2000);
        expect(retryDelayMs(1384)).toBe(2000);
        expect(decidePhase2Retry({autoRetry: true, attempt: 1384, stage: "prepare", error}).shouldRetry).toBe(true)
    });

    it("continues retrying an identical consecutive failure", () => {
        const error = new Phase2ExecutionError("same input failed", "IO_EBUSY", true);
        const first = decidePhase2Retry({autoRetry: true, attempt: 1, stage: "prepare", error});
        const second = decidePhase2Retry({autoRetry: true, attempt: 2, stage: "prepare", error, previousFingerprint: first.fingerprint});
        expect(first.shouldRetry).toBe(true);
        expect(second).toMatchObject({shouldRetry: true, stopReason: undefined})
    });

    it("stops retrying only when automatic retry is disabled", () => {
        const error = new Phase2ExecutionError("missing input", "WORKFLOW_BUSINESS_ERROR", false);
        expect(decidePhase2Retry({autoRetry: false, attempt: 1, stage: "finalize_chapter1_scope", error}))
            .toMatchObject({shouldRetry: false, retryable: false, stopReason: "disabled"})
    });
});
