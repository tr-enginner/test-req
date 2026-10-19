import {describe, expect, it} from "vitest";
import {cacheHitRate, elapsedMilliseconds, formatElapsed, formatTokenCount, nonCachedTokens} from "./runMetrics";

describe("run metrics formatting", () => {
    it("formats token counts", () => {
        expect(formatTokenCount(999)).toBe("999");
        expect(formatTokenCount(128600)).toBe("128.6K");
        expect(formatTokenCount(1_250_000)).toBe("1.3M")
    });
    it("uses monotonic time independently of browser clock skew", () => {
        const original = Date.now;
        try {
            for (const offset of [320000, -600000, 86400000]) {
                Date.now = () => offset;
                expect(elapsedMilliseconds(5000, "RUNNING", 100, 2100)).toBe(7000)
            }
        } finally { Date.now = original }
        expect(formatElapsed(3_723_000)).toBe("01:02:03")
    });
    it("freezes terminal and queued states and supports queued cancellation", () => {
        for (const status of ["SUCCEEDED", "FAILED", "CANCELLED", "QUEUED"]) {
            expect(elapsedMilliseconds(5000, status, 100, 99999)).toBe(5000)
        }
        expect(elapsedMilliseconds(0, "CANCELLED", 100, 99999)).toBe(0)
    });
    it("restores and recalibrates independent task baselines", () => {
        expect(elapsedMilliseconds(300000, "RUNNING", 100, 1100)).toBe(301000);
        expect(elapsedMilliseconds(0, "RUNNING", 1100, 2100)).toBe(1000);
        expect(elapsedMilliseconds(310000, "RUNNING", 2100, 3100)).toBe(311000)
    });
    it("does not fall back to local dates when elapsed data is missing", () => {
        for (const value of [undefined, NaN, Infinity, -1]) {
            expect(elapsedMilliseconds(value, "RUNNING", 0, 1000)).toBeUndefined()
        }
    });
    it("calculates the real Phase 2 sample without treating cache hits as new tokens", () => {
        const usage = {input: 209745, output: 8993, reasoning: 7272, cacheRead: 2988672};
        expect(nonCachedTokens(usage)).toBe(226010);
        expect(formatTokenCount(nonCachedTokens(usage))).toBe("226.0K");
        expect(cacheHitRate(usage)).toBeCloseTo(93.44, 2)
    });
    it("handles no-cache and empty usage", () => {
        expect(cacheHitRate({input: 100, cacheRead: 0})).toBe(0);
        expect(cacheHitRate({input: 0, cacheRead: 0})).toBe(0)
    })
});
