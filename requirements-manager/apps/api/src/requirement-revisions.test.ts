import {describe, expect, test, vi} from "vitest";
import {calculateRequirementDiff, textSegments} from "./requirement-revisions.js";
import {RequirementRevisionsService} from "./requirement-revisions.js";
import {ConflictException} from "@nestjs/common";

const node = (entityUid: string, businessId: string, content: unknown = {text: "old"}) => ({
    id: businessId, entityUid, businessId, nodeType: "requirement", number: businessId, title: "需求", parentId: "p", artifact: "functional-test-content.json", content, sourceRefs: ["S1"]
});

describe("RequirementRevisionsService baseline guard", () => {
    test("returns conflict instead of creating a duplicate V1 when published history has no baseline", async () => {
        const db: any = {requirementRevision: {
            findFirst: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({id: "revision-1", sequence: 1, kind: "PUBLISHED"})
        }};
        const service = new RequirementRevisionsService(db);
        await expect(service.list("project-1")).rejects.toBeInstanceOf(ConflictException);
        expect(db.requirementRevision.create).toBeUndefined()
    })
});
const section = (entityUid: string, artifact: string, number: string, content: unknown) => ({
    id: entityUid, entityUid, businessId: `${artifact}:${number}`, nodeType: "section", number,
    title: number === "1" ? "范围" : "系统概述", parentId: null, artifact, content, sourceRefs: []
});

describe("requirement revision diff", () => {
    test("distinguishes stable-identity renumbering from add/delete", () => {
        const result = calculateRequirementDiff([node("uid-1", "TR-001")], [node("uid-1", "TR-009")]);
        expect(result.summary.RENUMBERED).toBe(1);
        expect(result.summary.ADDED).toBe(0);
        expect(result.summary.DELETED).toBe(0)
    });

    test("reports additions, deletions and structured content changes", () => {
        const result = calculateRequirementDiff([node("old", "TR-001"), node("same", "TR-002")],
            [node("same", "TR-002", {text: "new"}), node("new", "TR-003")]);
        expect(result.summary.DELETED).toBe(1);
        expect(result.summary.ADDED).toBe(1);
        expect(result.summary.MODIFIED).toBe(1);
        expect(result.changes.find(change => change.entityUid === "same")?.fields?.[0].field).toBe("content")
    })

    test("provides navigation metadata and deterministic inline text segments", () => {
        const result = calculateRequirementDiff([node("same", "TR-002", {content: "响应时间不超过20ms"})],
            [node("same", "TR-002", {content: "响应时间不超过10ms"})]);
        const change = result.changes[0];
        expect(change.beforeAnchorKey).toBe("entity-same");
        expect(change.changedFields).toContain("content.content");
        expect(change.textSegments.some((item: any) => item.type === "DELETE" && item.text.includes("20ms"))).toBe(true);
        expect(change.textSegments.some((item: any) => item.type === "INSERT" && item.text.includes("10ms"))).toBe(true)
    });

    test("keeps unchanged text around Chinese edits", () => {
        const segments = textSegments("软件启动后进入待机状态", "软件复位后进入待机状态");
        expect(segments.filter(item => item.type === "EQUAL").map(item => item.text).join("")).toContain("后进入待机状态");
        expect(segments.some(item => item.type === "DELETE")).toBe(true);
        expect(segments.some(item => item.type === "INSERT")).toBe(true)
    })

    test("records editable document changes in chapters one and two", () => {
        const before = [section("chapter-1", "chapter1-scope.json", "1", {client_address: "海淀区", system_name: "配电系统"}),
            section("chapter-2", "chapter2-system-overview.json", "2", {processor_type: "80C32"})];
        const after = [section("chapter-1", "chapter1-scope.json", "1", {client_address: "海淀区中关村", system_name: "xxxx配电系统"}),
            section("chapter-2", "chapter2-system-overview.json", "2", {processor_type: "80C51"})];
        const result = calculateRequirementDiff(before, after);
        expect(result.summary.MODIFIED).toBe(2);
        expect(result.changes.find(change => change.entityUid === "chapter-1")?.changedFields)
            .toEqual(expect.arrayContaining(["content.client_address", "content.system_name"]));
        expect(result.changes.find(change => change.entityUid === "chapter-2")?.changedFields).toContain("content.processor_type")
    });

    test("does not duplicate nested section changes", () => {
        const before = [{...section("nested", "chapter1-scope.json", "1.1", {client_address: "旧地址"}), parentId: "chapter-1"}];
        const after = [{...section("nested", "chapter1-scope.json", "1.1", {client_address: "新地址"}), parentId: "chapter-1"}];
        expect(calculateRequirementDiff(before, after).changes).toHaveLength(0)
    })

    test("reports added and deleted table rows and columns", () => {
        const beforeTable = {memory_io_tables: [{columns: ["序号", "名称", "采值位数"], rows: [["1", "温度", "8bit"], ["2", "电压", "12bit"]]}]};
        const afterTable = {memory_io_tables: [{columns: ["序号", "名称", "新增列"], rows: [["1", "温度", "A"], ["3", "电流", "B"]]}]};
        const result = calculateRequirementDiff(
            [section("chapter-2", "chapter2-system-overview.json", "2", beforeTable)],
            [section("chapter-2", "chapter2-system-overview.json", "2", afterTable)]);
        const table = result.changes[0].tableChanges[0];
        expect(table.path).toBe("content.memory_io_tables.0");
        expect(table.deletedColumns).toEqual([{index: 2, value: "采值位数"}]);
        expect(table.addedColumns).toEqual([{index: 2, value: "新增列"}]);
        expect(table.deletedRows[0].index).toBe(1);
        expect(table.addedRows[0].index).toBe(1)
    })
});
