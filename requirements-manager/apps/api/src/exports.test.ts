import PizZip from "pizzip";
import {describe, expect, it} from "vitest";
import {mkdir, mkdtemp, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {buildEditTimeReportData, buildReviewReportData, renderReviewReport} from "./exports.js";

describe("review report export", () => {
    it("aggregates edit time by user and defaults an empty project to zero", () => {
        expect(buildEditTimeReportData([])).toEqual({editTimeRows: [], projectEditDuration: "00:00:00"});
        expect(buildEditTimeReportData([
            {userId: "u1", durationMs: 1000, user: {username: "甲"}},
            {userId: "u2", durationMs: 3000, user: {username: "乙"}},
            {userId: "u1", durationMs: 2000, user: {username: "甲"}}
        ])).toEqual({editTimeRows: [
            {seq: "1", userId: "u1", username: "甲", duration: "00:00:03"},
            {seq: "2", userId: "u2", username: "乙", duration: "00:00:03"}
        ], projectEditDuration: "00:00:06"})
    });
    it("fills all dynamic tables without leaving template tags", async () => {
        const common = {correctness: "5", coverage: "4", testability: "3", weighted: "4.15", comment: "补充边界场景"};
        const buffer = await renderReviewReport({
            hardwareRows: [{seq: "1", name: "3.1 硬件接口", ...common}],
            functionalRows: [{seq: "1", chapter: "4.1.1.1", name: "初始化功能需求项", count: "2", ...common}],
            nonFunctionalRows: [{seq: "1", name: "4.2.1 性能需求项", count: "3", ...common}],
            statisticsRows: [{
                category: "总体",
                count: "6",
                correctness: "5",
                coverage: "4",
                testability: "3",
                weighted: "4.15",
                grade: ""
            }],
            editTimeRows: [{seq: "1", userId: "u1", username: "测试员甲", duration: "01:02:03"}],
            projectEditDuration: "01:02:03"
        });
        expect(buffer.byteLength).toBeGreaterThan(10_000);
        const xml = new PizZip(buffer).file("word/document.xml")!.asText();
        expect(xml).toContain("初始化功能需求项");
        expect(xml).toContain("补充边界场景");
        expect(xml).toContain("测试员甲");
        expect(xml).toContain("01:02:03");
        expect(xml).not.toMatch(/\{[#/]?(hardwareRows|functionalRows|nonFunctionalRows|statisticsRows|editTimeRows)\}/)
    })

    it("blocks export and identifies every missing evaluable node", async () => {
        const workspace = await mkdtemp(path.join(tmpdir(), "matrix-review-export-")),
            dataDir = path.join(workspace, ".matrix", "data");
        await mkdir(dataDir, {recursive: true});
        const artifacts: Record<string, unknown> = {
            "chapter1-scope.json": {},
            "chapter2-system-overview.json": {},
            "hardware-interface-model.json": {interfaces: []},
            "functional-test-content.json": {
                children: [{
                    title_no: "4.1.1.1",
                    title: "初始化功能需求项",
                    children: [],
                    init_content: {summary: "初始化", input_flow: ["无"], processing: [], output_flow: ["无"]}
                }]
            },
            "phase2-test-traceability.json": {rows: []}
        };
        const nonFunctional = ["performance", "interface", "reliability-safety", "margin", "boundary", "data-processing", "recovery", "strength"];
        nonFunctional.forEach((name, index) => artifacts[`${name}-test-content.json`] = {
            section_title_no: `4.${index + 2}.1`,
            rows: []
        });
        await Promise.all(Object.entries(artifacts).map(([name, value]) => writeFile(path.join(dataDir, name), JSON.stringify(value))));
        const base = (id: string, artifact: string, number: string, title: string, parentId: string | null = null) => ({
            id,
            businessId: id,
            nodeType: "section",
            number,
            title,
            parentId,
            artifact
        });
        const requirements = [
            base("chapter1", "chapter1-scope.json", "1", "范围"), base("chapter2", "chapter2-system-overview.json", "2", "系统概述"),
            base("hardware", "hardware-interface-model.json", "3.1", "硬件接口"), base("functional", "functional-test-content.json", "4.1", "功能测试"),
            base("functional-leaf", "functional-test-content.json", "4.1.1.1", "初始化功能需求项", "functional"),
            ...nonFunctional.map((name, index) => base(`nf-${index}`, `${name}-test-content.json`, `4.${index + 2}.1`, `${name}需求项`))
        ];
        await expect(buildReviewReportData(workspace, requirements, [])).rejects.toMatchObject({
            response: {
                missingReviews: expect.arrayContaining([
                    expect.objectContaining({id: "chapter1"}), expect.objectContaining({id: "functional-leaf"}), expect.objectContaining({id: "nf-7"})
                ])
            }
        })
    })
});
