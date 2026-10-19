import {beforeEach, describe, expect, it, vi} from "vitest";
import {phase2DraftKey, readPhase2Draft, removePhase2Draft, writePhase2Draft} from "./phase2Draft";

describe("phase2 local draft", () => {
    let data: Map<string, string>;
    beforeEach(() => {
        data = new Map();
        vi.stubGlobal("localStorage", {getItem: (key: string) => data.get(key) ?? null,
            setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key)})
    });

    it("round trips a draft scoped to project and user", () => {
        const draft = {version: 1 as const, projectId: "p1", userId: "u1", editorDrafts: {field: "value"},
            tableOperations: [], requirementOperations: [], referenceOperations: [], expectedRevision: "r1", editRunId: "run1"};
        writePhase2Draft(draft);
        expect(readPhase2Draft("p1", "u1")).toEqual(draft);
        expect(readPhase2Draft("p1", "u2")).toBeUndefined()
    });

    it("cleans corrupt data and supports explicit discard", () => {
        const key = phase2DraftKey("p1", "u1");
        data.set(key, "not-json");
        expect(readPhase2Draft("p1", "u1")).toBeUndefined();
        expect(data.has(key)).toBe(false);
        writePhase2Draft({version: 1, projectId: "p1", userId: "u1", editorDrafts: {}, tableOperations: [], requirementOperations: [], referenceOperations: []});
        removePhase2Draft("p1", "u1");
        expect(data.has(key)).toBe(false)
    })
});
