export type RunWarningDetails = {warnings: string[]; skippedCount: number};

function readableWarning(value: unknown) {
    if (typeof value === "string") return value.trim();
    try {
        const serialized = JSON.stringify(value);
        return serialized === undefined ? String(value) : serialized
    } catch { return String(value) }
}

export function runWarningDetails(payload: Record<string, unknown>): RunWarningDetails {
    const warnings = Array.isArray(payload.warnings) ? payload.warnings.map(readableWarning).filter(Boolean) : [];
    const rawSkipped = typeof payload.skipped_count === "number" ? payload.skipped_count : Number.NaN;
    const skippedCount = Number.isFinite(rawSkipped) && rawSkipped >= 0 ? Math.floor(rawSkipped) : 0;
    return {warnings, skippedCount}
}

export function toggleExpandedEvent(ids: ReadonlySet<string>, eventId: string) {
    const next = new Set(ids);
    if (next.has(eventId)) next.delete(eventId);
    else next.add(eventId);
    return next
}

export function isExpansionKey(key: string) {
    return key === "Enter" || key === " "
}

export function mergeRunEvents<T extends {id: string}>(previous: T[], rows: T[]) {
    const values = new Map(previous.map(item => [item.id, item]));
    rows.forEach(item => values.set(item.id, item));
    return [...values.values()].sort((left, right) => {
        const leftId = BigInt(left.id), rightId = BigInt(right.id);
        return leftId < rightId ? -1 : leftId > rightId ? 1 : 0
    })
}

export function isTerminalRunStatus(status: string) {
    return status === "SUCCEEDED" || status === "FAILED" || status === "CANCELLED"
}
