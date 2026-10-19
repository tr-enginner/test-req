import {describe, expect, it, vi} from "vitest";
import {assertRequirementBaselineForRebuild, ensureRequirementBaselineForEdit} from "./requirement-revisions.js";

function poolWithPrevious(previous: any) {
    const query = vi.fn(async (sql: string) => {
        if (sql.includes("kind in ('GENERATED_BASELINE','MIGRATED_BASELINE')")) {
            const baseline = previous && String(previous.kind).endsWith("BASELINE") ? previous : undefined;
            return {rows: baseline ? [baseline] : [], rowCount: baseline ? 1 : 0}
        }
        if (sql.includes(`from "RequirementRevision" where "projectId"`)) return {rows: previous ? [previous] : [], rowCount: previous ? 1 : 0};
        return {rows: [{id: "project-1"}], rowCount: 1}
    });
    const client = {query, release: vi.fn()};
    return {pool: {connect: vi.fn(async () => client)} as any, client}
}

describe("requirement revision baseline guard", () => {
    it("reuses an existing baseline", async () => {
        const {pool} = poolWithPrevious({id: "baseline-1", kind: "GENERATED_BASELINE", sequence: 1});
        await expect(ensureRequirementBaselineForEdit(pool, {projectId: "project-1", workspace: "unused"}))
            .resolves.toMatchObject({id: "baseline-1"})
    });

    it("reuses an older baseline even when the latest revision is published", async () => {
        const baseline = {id: "baseline-1", kind: "MIGRATED_BASELINE", sequence: 1};
        const query = vi.fn(async (sql: string) => {
            if (sql.includes("kind in ('GENERATED_BASELINE','MIGRATED_BASELINE')")) return {rows: [baseline], rowCount: 1};
            if (sql === "begin" || sql === "rollback") return {rows: [], rowCount: 0};
            return {rows: [{id: "project-1"}], rowCount: 1}
        });
        const pool: any = {connect: vi.fn(async () => ({query, release: vi.fn()}))};
        await expect(ensureRequirementBaselineForEdit(pool, {projectId: "project-1", workspace: "unused"}))
            .resolves.toEqual(baseline);
        expect(query.mock.calls.some(([sql]) => String(sql).includes("status='PUBLISHED'"))).toBe(false)
    });

    it("rejects published history without a baseline", async () => {
        const {pool, client} = poolWithPrevious({id: "revision-1", kind: "PUBLISHED", sequence: 1});
        await expect(ensureRequirementBaselineForEdit(pool, {projectId: "project-1", workspace: "unused"}))
            .rejects.toThrow("请先运行需求版本历史修复工具");
        expect(client.query).toHaveBeenCalledWith("rollback")
    })
});

describe("requirement revision rebuild guard", () => {
    it("rejects a rebuild that cannot reuse a baseline", async () => {
        const db: any = {query: vi.fn(async () => ({rows: [], rowCount: 0}))};
        await expect(assertRequirementBaselineForRebuild(db, "project-1")).rejects.toThrow("缺少需求基线")
    })
});
