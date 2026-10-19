import {createHash} from "node:crypto";

export const PHASE2_RETRY_BASE_DELAY_MS = 2_000;

export class Phase2ExecutionError extends Error {
    constructor(message: string, readonly errorCode: string,
                readonly retryable: boolean, readonly failedCandidateId?: string) {
        super(message);
        this.name = "Phase2ExecutionError"
    }
}

function normalizedMessage(error: unknown) {
    return (error instanceof Error ? error.message : String(error))
        .replace(/\b\d{4}-\d{2}-\d{2}T\S+\b/g, "<timestamp>")
        .replace(/\b(?:attempt|第)\s*\d+\b/gi, "<attempt>")
        .slice(0, 1000)
}

export function failureFingerprint(stage: string, error: unknown) {
    const code = error instanceof Phase2ExecutionError ? error.errorCode : "UNCLASSIFIED_FAILURE";
    return createHash("sha256").update(JSON.stringify({stage, code, message: normalizedMessage(error)})).digest("hex")
}

export function retryDelayMs(attempt: number) {
    void attempt;
    return PHASE2_RETRY_BASE_DELAY_MS
}

export function decidePhase2Retry(input: {
    autoRetry: boolean;
    attempt: number;
    stage: string;
    error: unknown;
    inputFingerprint?: string;
    previousFingerprint?: string;
}) {
    const errorCode = input.error instanceof Phase2ExecutionError ? input.error.errorCode : "UNCLASSIFIED_FAILURE";
    const fingerprint = input.inputFingerprint
        ? createHash("sha256").update(JSON.stringify({stage: input.stage, errorCode, inputFingerprint: input.inputFingerprint})).digest("hex")
        : failureFingerprint(input.stage, input.error);
    // Preserve the legacy operator contract: the UI switch is the sole retry
    // gate. Error classification and fingerprints remain diagnostic metadata,
    // but never suppress an enabled automatic retry.
    const retryable = input.autoRetry;
    const stopReason: "disabled" | undefined = input.autoRetry ? undefined : "disabled";
    return {
        shouldRetry: stopReason === undefined,
        retryable,
        fingerprint,
        stopReason,
        maxAttempts: null,
        delayMs: retryDelayMs(input.attempt),
        errorCode,
        failedCandidateId: input.error instanceof Phase2ExecutionError ? input.error.failedCandidateId : undefined,
    }
}
