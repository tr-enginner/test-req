import {Agent} from "undici";

// Phase 2 commands return only after generation finishes. SSE activity on a
// separate connection does not reset the command's response-header timeout.
export const opencodeDispatcher = new Agent({headersTimeout: 0, bodyTimeout: 0});

export const opencodeFetch: typeof globalThis.fetch = (input, init) =>
    globalThis.fetch(input, {...init, dispatcher: opencodeDispatcher} as RequestInit);

export function describeError(error: unknown): string {
    const parts: string[] = [];
    const seen = new Set<unknown>();
    let current = error;
    while (current != null && !seen.has(current) && parts.length < 8) {
        seen.add(current);
        if (!(current instanceof Error)) {
            parts.push(String(current));
            break;
        }
        const code = (current as Error & {code?: unknown}).code;
        parts.push(`${current.message}${typeof code === "string" ? ` [${code}]` : ""}`);
        current = current.cause;
    }
    return parts.join("；原因：") || "未知错误";
}
