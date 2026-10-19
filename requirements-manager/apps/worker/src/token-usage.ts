export type TokenUsage = {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
    complete: boolean
};

type TokenShape = {
    input?: unknown;
    output?: unknown;
    reasoning?: unknown;
    cache?: {read?: unknown; write?: unknown}
};

export const emptyTokenUsage = (complete = true): TokenUsage => ({
    input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, complete
});

function tokenNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

export function normalizeTokens(tokens: TokenShape | undefined): TokenUsage | undefined {
    if (!tokens) return undefined;
    const input = tokenNumber(tokens.input), output = tokenNumber(tokens.output),
        reasoning = tokenNumber(tokens.reasoning), cacheRead = tokenNumber(tokens.cache?.read),
        cacheWrite = tokenNumber(tokens.cache?.write);
    if ([input, output, reasoning, cacheRead, cacheWrite].some(value => value === undefined)) return undefined;
    const usage = {input: input!, output: output!, reasoning: reasoning!, cacheRead: cacheRead!, cacheWrite: cacheWrite!};
    return {...usage, total: usage.input + usage.output + usage.reasoning + usage.cacheRead + usage.cacheWrite, complete: true}
}

export function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
    const usage = {
        input: left.input + right.input,
        output: left.output + right.output,
        reasoning: left.reasoning + right.reasoning,
        cacheRead: left.cacheRead + right.cacheRead,
        cacheWrite: left.cacheWrite + right.cacheWrite
    };
    return {...usage, total: usage.input + usage.output + usage.reasoning + usage.cacheRead + usage.cacheWrite,
        complete: left.complete && right.complete}
}

export class SessionUsageTracker {
    private readonly sessions = new Set<string>();
    private readonly messages = new Map<string, TokenUsage>();
    private incomplete = false;

    constructor(rootSessionId: string, private readonly baseline: TokenUsage = emptyTokenUsage()) {
        this.sessions.add(rootSessionId)
    }

    trackSession(sessionId: string, parentId?: string): boolean {
        if (!parentId || !this.sessions.has(parentId)) return false;
        this.sessions.add(sessionId);
        return true
    }

    isTracked(sessionId: string): boolean { return this.sessions.has(sessionId) }

    setMessage(sessionId: string, messageId: string, tokens: TokenShape | undefined): boolean {
        if (!this.sessions.has(sessionId)) return false;
        const usage = normalizeTokens(tokens);
        if (!usage) {
            this.incomplete = true;
            return false
        }
        const key = `${sessionId}:${messageId}`;
        const previous = this.messages.get(key);
        this.messages.set(key, usage);
        return JSON.stringify(previous) !== JSON.stringify(usage)
    }

    markIncomplete() { this.incomplete = true }

    snapshot(): TokenUsage {
        let result = {...this.baseline};
        for (const usage of this.messages.values()) result = addUsage(result, usage);
        result.complete = result.complete && !this.incomplete;
        return result
    }
}
