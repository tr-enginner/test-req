import {describe, expect, it} from "vitest";
import {emptyTokenUsage, normalizeTokens, SessionUsageTracker} from "./token-usage.js";

const tokens = (input: number, output: number, reasoning = 0, read = 0, write = 0) =>
    ({input, output, reasoning, cache: {read, write}});

describe("SessionUsageTracker", () => {
    it("replaces repeated message snapshots instead of double counting", () => {
        const tracker = new SessionUsageTracker("root");
        tracker.setMessage("root", "m1", tokens(10, 2));
        tracker.setMessage("root", "m1", tokens(20, 5, 3, 4, 1));
        expect(tracker.snapshot()).toEqual({input: 20, output: 5, reasoning: 3, cacheRead: 4,
            cacheWrite: 1, total: 33, complete: true})
    });

    it("tracks nested children and ignores unrelated sessions", () => {
        const tracker = new SessionUsageTracker("root", {...emptyTokenUsage(), input: 7, total: 7});
        expect(tracker.trackSession("child", "root")).toBe(true);
        expect(tracker.trackSession("grandchild", "child")).toBe(true);
        expect(tracker.trackSession("other", "missing")).toBe(false);
        tracker.setMessage("child", "m1", tokens(2, 3));
        tracker.setMessage("grandchild", "m2", tokens(4, 5));
        tracker.setMessage("other", "m3", tokens(100, 100));
        expect(tracker.snapshot().total).toBe(21)
    });

    it("marks malformed provider usage as incomplete", () => {
        expect(normalizeTokens(undefined)).toBeUndefined();
        const tracker = new SessionUsageTracker("root");
        tracker.setMessage("root", "m1", {input: 1});
        expect(tracker.snapshot().complete).toBe(false)
    })
});
