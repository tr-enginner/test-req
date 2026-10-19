import {BadRequestException} from "@nestjs/common";
import {afterAll, describe, expect, it, vi} from "vitest";

vi.mock("ioredis", () => {
    class Redis {disconnect() {}}
    return {default: Redis, Redis}
});
vi.mock("bullmq", () => ({Queue: class Queue {async add() {}}}));

const {RunsService} = await import("./runs.js");

describe("run event history", () => {
    afterAll(() => vi.restoreAllMocks());

    it("returns ascending cursor pages without duplicates", async () => {
        const allRows = Array.from({length: 205}, (_, index) => ({
            id: BigInt(index + 1), runId: "run-1", type: "stage.running", payload: {}, createdAt: new Date(0)
        }));
        const findMany = vi.fn(async ({where, take}: any) =>
            allRows.filter(row => row.id > where.id.gt).slice(0, take));
        const service = new RunsService({runEvent: {findMany}} as any);

        const first = await service.eventHistory("run-1", undefined, "200");
        const second = await service.eventHistory("run-1", first.nextCursor, "200");

        expect(first.items).toHaveLength(200);
        expect(first.items[0].id).toBe("1");
        expect(first.nextCursor).toBe("200");
        expect(first.hasMore).toBe(true);
        expect(second.items.map(item => item.id)).toEqual(["201", "202", "203", "204", "205"]);
        expect(second.hasMore).toBe(false)
    });

    it("caps a requested page at 500 events", async () => {
        const findMany = vi.fn().mockResolvedValue([]);
        const service = new RunsService({runEvent: {findMany}} as any);
        await service.eventHistory("run-1", "0", "9999");
        expect(findMany).toHaveBeenCalledWith(expect.objectContaining({take: 501}))
    });

    it("rejects invalid cursors and limits", async () => {
        const service = new RunsService({runEvent: {findMany: vi.fn()}} as any);
        await expect(service.eventHistory("run-1", "invalid", "200")).rejects.toBeInstanceOf(BadRequestException);
        await expect(service.eventHistory("run-1", "-1", "200")).rejects.toBeInstanceOf(BadRequestException);
        await expect(service.eventHistory("run-1", "0", "0")).rejects.toBeInstanceOf(BadRequestException)
    })
});
