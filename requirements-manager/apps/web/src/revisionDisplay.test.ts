import {describe, expect, it} from "vitest";
import type {RequirementRevision} from "./api";
import {revisionName, revisionTime, revisionTitle} from "./revisionDisplay";

const revision = (value: Partial<RequirementRevision>): RequirementRevision => ({
    id: "revision", sequence: 2, versionLabel: "V2", kind: "PUBLISHED", createdAt: "2026-09-03T01:00:00.000Z", ...value
});

describe("revision display", () => {
    it("combines the sequence label and user supplied name", () => {
        expect(revisionTitle(revision({versionName: "联调修订"}))).toBe("V2 · 联调修订")
    });

    it("uses semantic baseline names without inventing names for old revisions", () => {
        expect(revisionName(revision({kind: "MIGRATED_BASELINE"}))).toBe("迁移基线");
        expect(revisionTitle(revision({}))).toBe("V2")
    });

    it("prefers publication time and formats it in local time", () => {
        const value = revisionTime(revision({publishedAt: "2026-09-03T02:30:00.000Z"}));
        expect(value).toMatch(/^2026-09-03 \d{2}:30$/)
    })
});
