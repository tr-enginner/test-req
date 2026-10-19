import {mkdir, mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {describe, expect, it} from "vitest";
import {indexProject, planReviewNodeMigrations, projectScopedStableId} from "./indexing.js";

describe("project-scoped deterministic database ids", () => {
    it("is stable within a project and unique across projects", () => {
        const first = projectScopedStableId("trn", "project-a", "TR-XN-001");
        expect(projectScopedStableId("trn", "project-a", "TR-XN-001")).toBe(first);
        expect(projectScopedStableId("trn", "project-b", "TR-XN-001")).not.toBe(first);
    });

    it("keeps node and trace-link namespaces separate", () => {
        expect(projectScopedStableId("trn", "project-a", "same-business-key"))
            .not.toBe(projectScopedStableId("tl", "project-a", "same-business-key"));
    });
});

describe("review node migration planning", () => {
    it("moves reviews to the new project-scoped id by businessId", () => {
        expect(planReviewNodeMigrations(
            [{id: "legacy-global-id", businessId: "TR-XN-001", reviewCount: 2}],
            [{id: "project-scoped-id", businessId: "TR-XN-001"}],
        )).toEqual({
            updates: [{businessId: "TR-XN-001", nextBusinessId: "TR-XN-001", previousId: "legacy-global-id", nextId: "project-scoped-id"}],
            unmatched: [],
        });
    });

    it("moves reviews when a functional requirement is renumbered", () => {
        expect(planReviewNodeMigrations(
            [{id: "old-node", businessId: "TR-GN-X-001", reviewCount: 3}],
            [{id: "new-node", businessId: "TR-GN-X-012"}],
            [{from: "TR-GN-X-001", to: "TR-GN-X-012"}],
        )).toEqual({
            updates: [{businessId: "TR-GN-X-001", nextBusinessId: "TR-GN-X-012", previousId: "old-node", nextId: "new-node"}],
            unmatched: [],
        })
    });

    it("does not rewrite stable ids and reports only reviewed unmatched nodes", () => {
        expect(planReviewNodeMigrations(
            [
                {id: "stable-id", businessId: "kept", reviewCount: 1},
                {id: "removed-reviewed", businessId: "removed-reviewed", reviewCount: "1"},
                {id: "removed-unreviewed", businessId: "removed-unreviewed", reviewCount: 0},
            ],
            [{id: "stable-id", businessId: "kept"}],
        )).toEqual({
            updates: [],
            unmatched: [{id: "removed-reviewed", businessId: "removed-reviewed", reviewCount: "1"}],
        });
    });
});

describe("project indexing transaction", () => {
    it("locks the project row before replacing index data", async () => {
        const temporaryRoot = await mkdtemp(path.join(tmpdir(), "matrix-indexing-"));
        const queries: string[] = [];
        const client = {
            query: async (sql: string) => {
                queries.push(sql);
                if (sql.includes('from "Project"')) return {rowCount: 1, rows: [{id: "project-a"}]};
                return {rowCount: 0, rows: []}
            },
            release: () => undefined,
        };
        try {
            const workspace = path.join(temporaryRoot, "workspace");
            await mkdir(workspace);
            await indexProject({connect: async () => client} as any, "project-a", workspace);
        } finally {
            await rm(temporaryRoot, {recursive: true, force: true})
        }
        expect(queries[0]).toBe("begin");
        const lockIndex = queries.findIndex(sql => sql.includes('from "Project"') && sql.includes("for update"));
        const firstDeleteIndex = queries.findIndex(sql => sql.startsWith("delete from"));
        expect(lockIndex).toBeGreaterThan(0);
        expect(firstDeleteIndex).toBeGreaterThan(lockIndex);
        expect(queries.at(-1)).toBe("commit");
    });
});
