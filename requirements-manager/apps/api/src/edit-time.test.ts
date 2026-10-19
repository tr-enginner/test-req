import {BadRequestException, ForbiddenException} from "@nestjs/common";
import {describe, expect, it, vi} from "vitest";
import {EditTimeService, validateEditTimeSegments} from "./edit-time.js";

const segment = {id: "550e8400-e29b-41d4-a716-446655440000", startedAt: "2026-09-02T01:02:03.000Z", durationMs: 31000};

describe("edit time", () => {
    it("validates segment ids, timestamps, durations, and batches", () => {
        expect(validateEditTimeSegments([segment])).toEqual([segment]);
        for (const invalid of [[], [{...segment, id: "bad"}], [{...segment, durationMs: 0}], [{...segment, durationMs: 14_400_001}], [{...segment, startedAt: "bad"}]]) {
            expect(() => validateEditTimeSegments(invalid)).toThrow(BadRequestException)
        }
    });

    it("writes with the authenticated user, skips duplicate ids, and returns per-user totals", async () => {
        const db = {
            project: {findUniqueOrThrow: vi.fn().mockResolvedValue({id: "p1"})},
            editTimeSegment: {
                createMany: vi.fn().mockResolvedValue({count: 1}),
                groupBy: vi.fn().mockResolvedValue([
                    {userId: "u1", _sum: {durationMs: 31000}},
                    {userId: "u2", _sum: {durationMs: 9000}}
                ])
            },
            user: {findMany: vi.fn().mockResolvedValue([{id: "u1", username: "alice"}, {id: "u2", username: "bob"}])}
        } as any;
        const service = new EditTimeService(db), result = await service.append("p1", {id: "u1", role: "REVIEWER"}, [segment]);
        expect(db.editTimeSegment.createMany).toHaveBeenCalledWith({data: [{...segment, startedAt: new Date(segment.startedAt), projectId: "p1", userId: "u1"}], skipDuplicates: true});
        expect(result).toEqual({myDurationMs: 31000, projectDurationMs: 40000, users: [
            {userId: "u1", username: "alice", durationMs: 31000}, {userId: "u2", username: "bob", durationMs: 9000}
        ]})
    });

    it("rejects viewer writes", async () => {
        const service = new EditTimeService({} as any);
        await expect(service.append("p1", {id: "u1", role: "VIEWER"}, [segment])).rejects.toBeInstanceOf(ForbiddenException)
    })
});

