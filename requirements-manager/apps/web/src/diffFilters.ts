import type {RequirementChange} from "./api";

export function changeMatchesKind(change: RequirementChange, kind?: string) {
    if (!kind) return true;
    if (kind === "TRACE_CHANGED") return change.type === kind || (change.changedFields || []).some(field => /source_?refs/i.test(field));
    if (kind === "TABLE_CHANGED") return change.type === kind || Boolean(change.tableChanges?.length);
    return change.type === kind
}

export function diffFacetSummary(changes: RequirementChange[], original: Record<string, number> = {}) {
    return {...original,
        TRACE_CHANGED: changes.filter(change => changeMatchesKind(change, "TRACE_CHANGED")).length,
        TABLE_CHANGED: changes.filter(change => changeMatchesKind(change, "TABLE_CHANGED")).length}
}
