import {describe, expect, it} from "vitest";
import {mkdtemp, mkdir, readFile, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {backupPhase2Edit, requestedArtifacts, restorePhase2Edit, restorePublishedPhase2Edit} from "./phase2-edit.js";

const key = (artifact: string, field = "content") => Buffer.from(JSON.stringify({artifact, field}), "utf8").toString("base64url");

describe("Phase 2 edit publication planning", () => {
    it("extracts and deduplicates only artifacts touched by a batch", () => {
        expect(requestedArtifacts({
            changes: [{edit_key: key("functional-test-content.json")}, {edit_key: key("functional-test-content.json", "source_refs")}],
            table_operations: [{container_key: key("hardware-interface-model.json")}],
            requirement_operations: [],
            reference_operations: [{container_key: key("chapter1-scope.json", "references")}],
        })).toEqual(["functional-test-content.json", "hardware-interface-model.json", "chapter1-scope.json"])
    });

    it("ignores malformed keys and lets the deterministic runner reject them", () => {
        expect(requestedArtifacts({changes: [{edit_key: "not-a-key"}]})).toEqual([])
    })

    it("restores mutated raw files and removes files created after backup", async () => {
        const workspace = await mkdtemp(path.join(tmpdir(), "phase2-edit-backup-"));
        const data = path.join(workspace, ".matrix", "data"), raw = path.join(data, "chapter1-scope.raw.json"), state = path.join(data, "phase2-editor-state.json");
        await mkdir(data, {recursive: true});
        await writeFile(raw, "before");
        const root = await backupPhase2Edit(workspace, "run-1", {changes: []}, [raw, state]);
        await writeFile(raw, "after");
        await writeFile(state, "created");
        await restorePhase2Edit(workspace, root);
        expect(await readFile(raw, "utf8")).toBe("before");
        await expect(readFile(state, "utf8")).rejects.toMatchObject({code: "ENOENT"})
    })

    it("retains the saved raw draft while restoring published artifacts and editor mappings", async () => {
        const workspace = await mkdtemp(path.join(tmpdir(), "phase2-edit-published-"));
        const data = path.join(workspace, ".matrix", "data"), reports = path.join(workspace, ".matrix", "reports");
        const raw = path.join(data, "chapter1-scope.raw.json"), final = path.join(data, "chapter1-scope.json");
        const state = path.join(data, "phase2-editor-state.json"), report = path.join(reports, "chapter1-scope.docx");
        await mkdir(data, {recursive: true}); await mkdir(reports, {recursive: true});
        await writeFile(raw, "raw-before"); await writeFile(final, "final-before"); await writeFile(state, "mapping-before"); await writeFile(report, "report-before");
        const root = await backupPhase2Edit(workspace, "run-2", {changes: [{edit_key: key("chapter1-scope.json")}]}, [raw]);
        await writeFile(raw, "raw-draft"); await writeFile(final, "final-broken"); await writeFile(state, "mapping-broken"); await writeFile(report, "report-broken");
        await restorePublishedPhase2Edit(workspace, root);
        expect(await readFile(raw, "utf8")).toBe("raw-draft");
        expect(await readFile(final, "utf8")).toBe("final-before");
        expect(await readFile(state, "utf8")).toBe("mapping-before");
        expect(await readFile(report, "utf8")).toBe("report-before")
    })
});
