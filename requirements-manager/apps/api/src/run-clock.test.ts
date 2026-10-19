import {describe, expect, it, vi} from "vitest";
import {type PrismaClient} from "@prisma/client";
import {readWithRunClock, withElapsed} from "./run-clock.js";

describe("database run clock", () => {
    const start = new Date("2026-09-08T00:00:00Z");
    it("adds only the active attempt to accumulated execution time", () => {
        const run = {id: "one", accumulatedElapsedMs: 5000n, attemptStartedAt: start};
        expect(withElapsed(run, new Date(start.getTime() + 1234))).toEqual({id: "one", elapsedMs: 6234});
        expect(withElapsed({...run, attemptStartedAt: null}, new Date(start.getTime() + 600000)).elapsedMs).toBe(5000);
        expect(withElapsed(run, new Date(start.getTime() - 1000)).elapsedMs).toBe(5000);
        expect(withElapsed({accumulatedElapsedMs: 0n, attemptStartedAt: null}, start).elapsedMs).toBe(0)
    });
    it("reads UTC time and rows in the same repeatable-read transaction", async () => {
        const tx = {$queryRaw: vi.fn().mockResolvedValue([{now: start}])};
        const db = {$transaction: vi.fn(async (fn: (value: typeof tx) => unknown) => fn(tx))};
        const read = vi.fn(async (client, now) => {
            expect(client).toBe(tx);
            return withElapsed({accumulatedElapsedMs: 1000n,
                attemptStartedAt: new Date(start.getTime() - 5000)}, now)
        });
        expect((await readWithRunClock(db as unknown as PrismaClient, read)).elapsedMs).toBe(6000);
        expect(tx.$queryRaw.mock.calls[0][0].join("")).toContain("AT TIME ZONE 'UTC'");
        expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {isolationLevel: "RepeatableRead"})
    })
});
