import {beforeEach, describe, expect, it, vi} from "vitest";
import {appendEditTimeOutbox, EditingTimeTracker, formatEditDuration, readEditTimeOutbox, removeEditTimeOutbox} from "./editTime";

describe("EditingTimeTracker", () => {
    beforeEach(() => vi.useFakeTimers());

    it("starts on first activity, stops after 30 seconds idle, and accumulates later sessions", () => {
        const segments: any[] = [], tracker = new EditingTimeTracker(segment => segments.push(segment));
        tracker.recordActivity();
        vi.advanceTimersByTime(10_000);
        tracker.recordActivity();
        vi.advanceTimersByTime(29_999);
        expect(segments).toHaveLength(0);
        vi.advanceTimersByTime(1);
        expect(segments[0].durationMs).toBe(40_000);
        tracker.recordActivity();
        vi.advanceTimersByTime(2_000);
        tracker.stop();
        tracker.stop();
        expect(segments.map(item => item.durationMs)).toEqual([40_000, 2_000])
    });

    it("formats unbounded project durations", () => {
        expect(formatEditDuration(3_661_999)).toBe("01:01:01");
        expect(formatEditDuration(100 * 3_600_000)).toBe("100:00:00")
    })
});

describe("edit time outbox", () => {
    beforeEach(() => {
        const data = new Map<string, string>();
        vi.stubGlobal("localStorage", {getItem: (key: string) => data.get(key) ?? null,
            setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key)})
    });
    it("persists pending segments and removes only acknowledged ids", () => {
        const one = {id: "1", startedAt: "2026-09-02T00:00:00Z", durationMs: 1000}, two = {...one, id: "2"};
        appendEditTimeOutbox("key", one); appendEditTimeOutbox("key", two);
        expect(readEditTimeOutbox("key")).toEqual([one, two]);
        expect(removeEditTimeOutbox("key", ["1"])).toEqual([two])
    })
});

