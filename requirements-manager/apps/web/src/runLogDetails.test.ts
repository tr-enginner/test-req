import {describe, expect, it} from "vitest";
import {isExpansionKey, isTerminalRunStatus, mergeRunEvents, runWarningDetails, toggleExpandedEvent} from "./runLogDetails";

describe("run log warning details", () => {
    it("normalizes warning values and a valid skipped count", () => {
        expect(runWarningDetails({warnings: [" warning ", {table: "T-1"}, 7, ""], skipped_count: 5.9})).toEqual({
            warnings: ["warning", '{"table":"T-1"}', "7"], skippedCount: 5
        })
    });

    it("treats absent or malformed details as empty and zero", () => {
        for (const payload of [{}, {warnings: "warning", skipped_count: "5"}, {warnings: [], skipped_count: -1}, {warnings: [], skipped_count: Number.NaN}]) {
            expect(runWarningDetails(payload)).toEqual({warnings: [], skippedCount: 0})
        }
    });

    it("toggles one event without changing the previous set", () => {
        const current = new Set(["1"]), expanded = toggleExpandedEvent(current, "2");
        expect([...current]).toEqual(["1"]);
        expect([...expanded]).toEqual(["1", "2"]);
        expect([...toggleExpandedEvent(expanded, "1")]).toEqual(["2"])
    });

    it("supports Enter and Space keyboard activation only", () => {
        expect(isExpansionKey("Enter")).toBe(true);
        expect(isExpansionKey(" ")).toBe(true);
        expect(isExpansionKey("Escape")).toBe(false)
    })

    it("merges paged history and live events without duplicates in numeric id order", () => {
        const live = [{id: "101", value: "live"}, {id: "103", value: "live"}];
        const history = [{id: "99", value: "history"}, {id: "101", value: "history"}, {id: "102", value: "history"}];
        expect(mergeRunEvents(live, history)).toEqual([
            {id: "99", value: "history"}, {id: "101", value: "history"},
            {id: "102", value: "history"}, {id: "103", value: "live"}
        ])
    })

    it("recognizes every terminal run status", () => {
        expect(["SUCCEEDED", "FAILED", "CANCELLED"].every(isTerminalRunStatus)).toBe(true);
        expect(isTerminalRunStatus("RUNNING")).toBe(false);
        expect(isTerminalRunStatus("QUEUED")).toBe(false)
    })
});
