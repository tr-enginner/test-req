export function formatTokenCount(value: number): string {
    if (value < 1000) return Math.round(value).toLocaleString("en-US");
    if (value < 1_000_000) return `${(value / 1000).toFixed(1)}K`;
    return `${(value / 1_000_000).toFixed(1)}M`
}

export function elapsedMilliseconds(elapsedMs: number | undefined, status: string | undefined,
    receivedAt: number, now = performance.now()): number | undefined {
    if (typeof elapsedMs !== "number" || !Number.isFinite(elapsedMs) || elapsedMs < 0) return undefined;
    return elapsedMs + (status === "RUNNING" ? Math.max(0, now - receivedAt) : 0)
}

export function formatElapsed(milliseconds: number): string {
    const seconds = Math.floor(milliseconds / 1000), hours = Math.floor(seconds / 3600),
        minutes = Math.floor(seconds % 3600 / 60), remainder = seconds % 60;
    return [hours, minutes, remainder].map(value => String(value).padStart(2, "0")).join(":")
}

export type TokenUsageValues = {input: number; output: number; reasoning: number; cacheRead: number};

export function nonCachedTokens(usage: TokenUsageValues): number {
    return usage.input + usage.output + usage.reasoning
}

export function cacheHitRate(usage: Pick<TokenUsageValues, "input" | "cacheRead">): number {
    const inputTotal = usage.input + usage.cacheRead;
    return inputTotal > 0 ? usage.cacheRead / inputTotal * 100 : 0
}
