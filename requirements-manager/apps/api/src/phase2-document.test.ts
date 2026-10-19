import {mkdtemp, mkdir, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {describe, expect, it} from "vitest";
import {
    buildPhase2Document,
    chapter1DisplayReferences,
    cleanTableTitle,
    formatChapter2MemoryReference,
    formatChapter2Processor,
    formatFunctionalFlowItems,
    normalizedTable
} from "./phase2-document.js";

describe("formatFunctionalFlowItems", () => {
    it("formats multiple flows with alphabetic labels and Chinese punctuation", () => {
        expect(formatFunctionalFlowItems(["速变遥测轮询控制序列", "缓变遥测轮询控制序列"])).toEqual([
            "a. 速变遥测轮询控制序列；",
            "b. 缓变遥测轮询控制序列。"
        ]);
    });

    it("normalizes terminal punctuation for a single flow", () => {
        expect(formatFunctionalFlowItems(["负载控制指令；"])).toEqual(["负载控制指令。"]);
    });

    it("renders empty and no-flow values consistently", () => {
        expect(formatFunctionalFlowItems([])).toEqual(["无。"]);
        expect(formatFunctionalFlowItems(["无。", "无；"])).toEqual(["无。"]);
    });
});

describe("system overview table rendering", () => {
    it("keeps array-based rows populated", () => {
        const result = normalizedTable({
            title: "表 3.3-1 80C32 系统 P1 端口位定义",
            columns: ["序号", "地址", "定义", "使用说明"],
            rows: [["1", "P1.0", "A 主加热器控制信号", "0 加热，1 关闭"]]
        }, "存储器及I/O说明表");

        expect(result?.rows).toEqual([["1", "P1.0", "A 主加热器控制信号", "0 加热，1 关闭"]]);
    });

    it("removes the source table number before assigning the Phase 2 number", () => {
        expect(cleanTableTitle("表 3.3-1 80C32 系统 P1 端口位定义")).toBe("80C32 系统 P1 端口位定义");
        expect(cleanTableTitle("表 3.2.3-1 遥测参数通道地址表")).toBe("遥测参数通道地址表");
    });
});

describe("chapter 1 and chapter 2 presentation contracts", () => {
    it("renders only available chapters while generation is incomplete", async () => {
        const workspace = await mkdtemp(path.join(tmpdir(), "phase2-partial-document-"));
        const dataDir = path.join(workspace, ".matrix", "data");
        await mkdir(dataDir, {recursive: true});
        await writeFile(path.join(dataDir, "chapter1-scope.json"), JSON.stringify({document_id: "DOC-1", references: []}));
        const document = await buildPhase2Document(workspace, []);
        expect(document.chapters.map(chapter => chapter.number)).toEqual(["1"]);
        expect(document.chapters.flatMap(chapter => chapter.blocks).some(block => block.type === "error")).toBe(false)
    });

    it("prepends fixed references and programming conventions and deduplicates by document id", () => {
        const references = chapter1DisplayReferences({
            programming_languages: ["mcs51_assembly", "c", "x86_assembly", "c"],
            references: [
                {document_id: "Q/W-Q80-18-01-2014", document_title: "重复C约定"},
                {document_id: "RX03", document_title: "需求规格说明"}
            ]
        });
        expect(references.slice(0, 3).map(item => item.document_id)).toEqual([
            "TE-GTCG-003-2021", "QJ 3027A-2016", "Q/QJA 300-2014"
        ]);
        expect(references.map(item => item.document_id).slice(7)).toEqual([
            "Q/W 1139-2007", "Q/W-Q80-18-01-2014", "Q/W 1141-2007", "RX03"
        ]);
        expect(references.filter(item => item.document_id === "Q/W-Q80-18-01-2014")).toHaveLength(1)
        expect(references.find(item => item.document_id === "TE-GTCG-003-2021")?.management).toBe("fixed");
        expect(references.find(item => item.document_id === "Q/W 1139-2007")?.management).toBe("automatic");
        expect(references.find(item => item.document_id === "RX03")?.management).toBe("project")
    });

    it("formats processor type and frequency with explicit labels", () => {
        expect(formatChapter2Processor("BM3803", "48MHz")).toBe("CPU：BM3803，主频：48MHz");
        expect(formatChapter2Processor("BM3803", "")).toBe("CPU：BM3803");
        expect(formatChapter2Processor("", "48MHz")).toBe("主频：48MHz");
        expect(formatChapter2Processor("", "")).toBe("")
    });

    it("formats chapter 2 memory table references for single and multiple tables", () => {
        expect(formatChapter2MemoryReference("程序存储器用于存放程序。", 1)).toBe("具体见表2-1。");
        expect(formatChapter2MemoryReference("程序存储器用于存放程序", 2)).toBe("。具体见表2-1至表2-2。");
        expect(formatChapter2MemoryReference("程序存储器用于存放程序。", 0)).toBe("")
    });

    it("renders the canonical five-column interrupt contract and ignores legacy fields", async () => {
        const workspace = await mkdtemp(path.join(tmpdir(), "phase2-document-"));
        const dataDir = path.join(workspace, ".matrix", "data");
        await mkdir(dataDir, {recursive: true});
        await writeFile(path.join(dataDir, "chapter2-system-overview.json"), JSON.stringify({
            system_relationship: "下位机与上位机交换数据。",
            processor_type: "BM3803",
            processor_frequency: "48MHz",
            memory_io_summary: "存储器地址空间见下表",
            memory_io_tables: [{
                title: "P1端口定义",
                columns: ["序号", "IO口", "用途", "备注"],
                rows: [["1", "GPIO3", "基带复位", "输出"]]
            }],
            interrupts: [{
                interrupt_name: "遥控PCM采集中断",
                priority: "最高",
                frequency_or_random: "随机（频繁）",
                trigger_mode: "IO中断",
                execution_function: "采集PCM码流数据",
                number: "不应显示",
                purpose: "不应显示"
            }]
        }));
        const document = await buildPhase2Document(workspace, [{id: "chapter2", businessId: "chapter2", artifact: "chapter2-system-overview.json", parentId: null}]);
        const chapter = document.chapters.find(item => item.number === "2");
        const relationship = chapter?.blocks.find(block => block.type === "paragraph" && block.text?.includes("下位机与上位机"));
        const processor = chapter?.blocks.find(block => block.type === "paragraph" && block.text?.startsWith("a. "));
        const memorySummary = chapter?.blocks.find(block => block.type === "paragraph" && block.text?.startsWith("b. "));
        const interruptLead = chapter?.blocks.find(block => block.type === "paragraph" && block.text?.startsWith("c. "));
        const memory = chapter?.blocks.find(block => block.type === "table" && block.caption?.includes("P1端口定义"));
        const interrupt = chapter?.blocks.find(block => block.type === "table" && block.caption?.includes("中断使用说明"));
        expect(relationship?.text).toBe("下位机与上位机交换数据。");
        expect(processor?.text).toBe("a. CPU：BM3803，主频：48MHz");
        expect(memorySummary?.text).toBe("b. 存储器地址空间见下表。具体见表2-1。");
        expect(memorySummary?.text).not.toContain("，具体见表2-1");
        expect(memorySummary?.text).not.toContain("表2-1至表2-1");
        expect(interruptLead?.text).toBe("c. 中断使用情况如下表：");
        expect(memory?.cellBindings?.[0].map(item => item?.kind)).toEqual([
            "table_cell", "table_cell", "table_cell", "table_cell"
        ]);
        expect(memory?.captionParts?.some(part => part.editable)).toBe(true);
        expect(memory?.headerBindings?.every(item => item?.kind === "table_header")).toBe(true);
        expect(interrupt?.columns).toEqual(["中断名称", "优先级", "周期（触发频率）/随机（频繁/偶发）", "触发方式", "执行功能"]);
        expect(interrupt?.rows).toEqual([["遥控PCM采集中断", "最高", "随机（频繁）", "IO中断", "采集PCM码流数据"]]);
        expect(JSON.stringify(interrupt)).not.toContain("不应显示")
        expect(interrupt?.cellBindings?.[0].map(item => item?.kind)).toEqual([
            "table_cell", "table_cell", "table_cell", "table_cell", "table_cell"
        ])
    });

    it("exposes only raw-backed values as editable text parts", async () => {
        const workspace = await mkdtemp(path.join(tmpdir(), "phase2-inline-"));
        const dataDir = path.join(workspace, ".matrix", "data");
        await mkdir(dataDir, {recursive: true});
        await writeFile(path.join(dataDir, "chapter1-scope.json"), JSON.stringify({document_id: "CASC-SRS", document_version: "1.00"}));
        const requirements = [{id: "chapter1", businessId: "chapter1", artifact: "chapter1-scope.json", parentId: null}];
        const document = await buildPhase2Document(workspace, requirements);
        const referenceList = document.chapters[0].blocks.find(block => block.type === "reference_list");
        expect(referenceList?.referenceBinding?.node_id).toBe("chapter1");
        expect(referenceList?.referenceBinding?.container_key).toBeTruthy();
        const identity = document.chapters[0].blocks.find(block => block.text?.startsWith("a. 文档标识"));
        expect(identity?.parts?.filter(part => part.editable).map(part => part.text)).toEqual(["CASC-SRS", "1.00"]);
        expect(identity?.parts?.filter(part => !part.editable).map(part => part.text).join("")).toContain("文档标识：.RX1，版本号：");
    })
});

describe("hardware interface anchors", () => {
    it("numbers hardware tables in DOCX order and resets the sequence for each interface", async () => {
        const workspace = await mkdtemp(path.join(tmpdir(), "phase2-hardware-tables-"));
        const dataDir = path.join(workspace, ".matrix", "data");
        await mkdir(dataDir, {recursive: true});
        const sourceTable = (table_id: string, title: string) => ({table_id, title, columns: ["字段"], rows: [["值"]]});
        await writeFile(path.join(dataDir, "hardware-interface-model.json"), JSON.stringify({
            chapter_title: "数据及接口需求",
            section_title: "硬件接口",
            interfaces: [{
                title: "CAN总线接口及相关数据流",
                overview_tables: [sourceTable("T-OVERVIEW", "表 5.2-1 CAN地址分配表")],
                input_tables: [sourceTable("T-INPUT", "CAN输入数据表")],
                output_tables: [sourceTable("T-INPUT", "CAN输入数据表")],
                topics: [{
                    title: "遥测轮询",
                    input_tables: [],
                    output_tables: [sourceTable("T-TOPIC", "遥测轮询输出数据表")]
                }]
            }, {
                title: "串口接口及相关数据流",
                overview_tables: [],
                input_tables: [sourceTable("T-SERIAL", "串口输入数据表")],
                output_tables: [],
                topics: []
            }]
        }));

        const document = await buildPhase2Document(workspace, []);
        const hardware = document.chapters.find(chapter => chapter.number === "3.1");
        const captions = hardware?.blocks.filter(block => block.type === "table").map(block => block.caption);
        expect(captions).toEqual([
            "表3.1.1-1  CAN地址分配表",
            "表3.1.1-2  CAN输入数据表",
            "表3.1.1-3  遥测轮询输出数据表",
            "表3.1.2-1  串口输入数据表"
        ]);
        expect(hardware?.blocks).toContainEqual(expect.objectContaining({
            type: "paragraph",
            text: "该表已在前文展示：表3.1.1-2。"
        }))
    });

    it("binds scalar hardware input and output flows to the whole raw field", async () => {
        const workspace = await mkdtemp(path.join(tmpdir(), "phase2-hardware-flow-"));
        const dataDir = path.join(workspace, ".matrix", "data");
        await mkdir(dataDir, {recursive: true});
        await writeFile(path.join(dataDir, "hardware-interface-model.json"), JSON.stringify({
            chapter_title: "数据及接口需求", section_title: "硬件接口",
            interfaces: [{candidate_id: "C-1", interface_id: "IF-1", title: "CAN", overview: "接口说明", source_refs: ["primary::SRS-3.1"], input_flow: "间接指令", output_flow: "应答", overview_tables: [], input_tables: [], output_tables: [], topics: []}]
        }));
        const requirements = [
            {id: "hardware-root", businessId: "hardware-root", artifact: "hardware-interface-model.json", number: "3.1", parentId: null},
            {id: "hardware-interface", businessId: "hardware-interface", artifact: "hardware-interface-model.json", number: "3.1.1", parentId: "hardware-root"}
        ];
        const document = await buildPhase2Document(workspace, requirements);
        const editable = document.chapters.flatMap(chapter => chapter.blocks)
            .flatMap(block => block.parts || []).filter(part => part.editable).map(part => part.editable ? part.binding : undefined);
        const fields = editable.map(item => item ? JSON.parse(Buffer.from(item.edit_key, "base64url").toString("utf8")).field : undefined);
        expect(fields).toContain("input_flow");
        expect(fields).toContain("output_flow");
        expect(fields).not.toContain("input_flow.0");
        expect(fields).not.toContain("output_flow.0");
        const hardware = document.chapters.find(chapter => chapter.number === "3.1");
        expect(hardware?.blocks.filter(block => block.type === "table_selector").map(block => block.selectionRole)).toEqual(["概述", "输入流", "输出流"]);
        expect(hardware?.blocks.find(block => block.type === "paragraph" && block.parts?.some(part => part.text === "接口说明"))?.anchorId).toBeUndefined()
    });

    it("binds fourth-level topic headings to their indexed node", async () => {
        const workspace = await mkdtemp(path.join(tmpdir(), "phase2-document-"));
        const dataDir = path.join(workspace, ".matrix", "data");
        await mkdir(dataDir, {recursive: true});
        await writeFile(path.join(dataDir, "hardware-interface-model.json"), JSON.stringify({
            chapter_title: "数据及接口需求",
            section_title: "硬件接口",
            interfaces: [{title: "CAN总线接口及相关数据流", topics: [{title: "速变遥测轮询及相关数据流"}]}]
        }));
        const requirements = [
            {id: "hardware-root", businessId: "hardware-root", artifact: "hardware-interface-model.json", number: "3.1", parentId: null},
            {id: "hardware-interface", businessId: "hardware-interface", artifact: "hardware-interface-model.json", number: "3.1.1", parentId: "hardware-root"},
            {id: "hardware-topic", businessId: "hardware-topic", artifact: "hardware-interface-model.json", number: "3.1.1.1", parentId: "hardware-interface"}
        ];

        const document = await buildPhase2Document(workspace, requirements);
        const hardware = document.chapters.find(chapter => chapter.number === "3.1");

        expect(hardware?.blocks).toContainEqual(expect.objectContaining({
            type: "heading",
            text: "3.1.1.1 速变遥测轮询及相关数据流",
            anchorId: "hardware-topic",
            businessId: "hardware-topic"
        }));
    });
});

describe("raw open question placement", () => {
    it("attaches child raw questions to 3.1, 4.1, and 4.3 child headings", async () => {
        const workspace = await mkdtemp(path.join(tmpdir(), "phase2-open-questions-"));
        const dataDir = path.join(workspace, ".matrix", "data");
        await mkdir(path.join(dataDir, "hardware-interface-blocks"), {recursive: true});
        await mkdir(path.join(dataDir, "functional-other-content-leaves"), {recursive: true});
        await mkdir(path.join(dataDir, "interface-test-content-batches"), {recursive: true});
        await writeFile(path.join(dataDir, "hardware-interface-model.json"), JSON.stringify({
            interfaces: [{candidate_id: "CAN-1", interface_id: "IF-CAN-001", title: "CAN接口", overview_tables: [], input_tables: [], output_tables: []}]
        }));
        await writeFile(path.join(dataDir, "hardware-interface-blocks", "can.raw.json"), JSON.stringify({
            interface: {candidate_id: "CAN-1", interface_id: "IF-CAN-001", title: "CAN接口"},
            open_questions: ["确认CAN波特率", "确认CAN波特率", " "]
        }));
        await writeFile(path.join(dataDir, "hardware-interface-blocks", "broken.raw.json"), "{");
        await writeFile(path.join(dataDir, "functional-test-content.json"), JSON.stringify({
            children: [{title_no: "4.1.1", title: "初始化功能", init_content: {
                summary: "初始化", input_flow: [], processing: [], output_flow: [], tables: []
            }}, {title_no: "4.1.2", title: "遥测功能", other_content: {
                summary: "遥测", input_flow: [], processing: [], output_flow: [], tables: []
            }}]
        }));
        await writeFile(path.join(dataDir, "functional-init-content.raw.json"), JSON.stringify({
            section_title_no: "4.1.1", items: [{title_no: "4.1.1", title: "初始化功能"}], open_question: "确认初始化时序"
        }));
        await writeFile(path.join(dataDir, "functional-other-content-leaves", "telemetry.raw.json"), JSON.stringify({
            section_title_no: "4.1", items: [{title_no: "4.1.2", title: "遥测功能"}], open_questions: ["确认遥测周期"]
        }));
        await writeFile(path.join(dataDir, "interface-test-content.json"), JSON.stringify({
            rows: [
                {interface_id: "IF-CAN-001", interface_name: "CAN接口", interface_requirement_description: "CAN需求", test_requirement_id: "TR-JK-001", related_description: "接口正常情况的测试"},
                {interface_id: "IF-RS422-001", interface_name: "RS422接口", interface_requirement_description: "串口需求", test_requirement_id: "TR-JK-002", related_description: "接口正常情况的测试"}
            ], test_requirements: {sufficiency: "C1、C2", termination: "Z1、Z2", priority: "高优先级"}
        }));
        await writeFile(path.join(dataDir, "interface-test-content-batches", "can.raw.json"), JSON.stringify({
            batch_id: "IF-CAN-001", interface_id: "IF-CAN-001", interface_name: "CAN接口", open_questions: ["确认异常帧响应"]
        }));
        await writeFile(path.join(dataDir, "interface-test-content-batches", "can-extra.raw.json"), JSON.stringify({
            batch_id: "IF-CAN-001", interface_id: "IF-CAN-001", interface_name: "CAN接口", open_questions: ["确认异常帧响应", "确认总线关闭恢复"]
        }));
        await writeFile(path.join(dataDir, "interface-test-content-batches", "rs422.raw.json"), JSON.stringify({
            batch_id: "IF-RS422-001", interface_id: "IF-RS422-001", interface_name: "RS422接口", open_questions: ["确认串口校验位"]
        }));

        const document = await buildPhase2Document(workspace, []);
        const interfaceSummary = document.chapters.find(item => item.number === "4.3")?.blocks
            .find(block => block.type === "table" && block.caption?.includes("接口需求项总结表"));
        expect(interfaceSummary?.columns).toEqual(["序号", "接口需求描述", "对应测试需求标识", "相关说明", "对应接口名称", "接口标识"]);
        expect(interfaceSummary?.rows).toEqual([
            ["1", "CAN需求", "TR-JK-001", "接口正常情况的测试", "CAN接口", "IF-CAN-001"],
            ["2", "串口需求", "TR-JK-002", "接口正常情况的测试", "RS422接口", "IF-RS422-001"]
        ]);
        expect(interfaceSummary?.cellBindings?.every(row => row.length === 6)).toBe(true);
        const heading = (chapter: string, value: string) => document.chapters.find(item => item.number === chapter)?.blocks
            .find(block => block.type === "heading" && block.text?.startsWith(value));
        expect(heading("3.1", "3.1.1 ")?.openQuestions).toEqual(["确认CAN波特率"]);
        expect(document.chapters.find(item => item.number === "3.1")?.warnings?.some(value => value.includes("broken.raw.json"))).toBe(true);
        expect(heading("4.1", "4.1.1 ")?.openQuestions).toEqual(["确认初始化时序"]);
        expect(heading("4.1", "4.1.2 ")?.openQuestions).toEqual(["确认遥测周期"]);
        expect(heading("4.3", "4.3 ")?.openQuestionGroups).toEqual([
            {title: "CAN接口（IF-CAN-001）", questions: ["确认异常帧响应", "确认总线关闭恢复"]},
            {title: "RS422接口（IF-RS422-001）", questions: ["确认串口校验位"]}
        ]);
        expect(document.chapters.find(item => item.number === "4.3")?.blocks.some(block => block.type === "heading" && block.text?.startsWith("4.3.1.1 "))).toBe(false)
    });

    it("attaches a single raw artifact to its chapter heading", async () => {
        const workspace = await mkdtemp(path.join(tmpdir(), "phase2-single-open-question-"));
        const dataDir = path.join(workspace, ".matrix", "data");
        await mkdir(dataDir, {recursive: true});
        await writeFile(path.join(dataDir, "performance-test-content.json"), JSON.stringify({
            rows: [], test_requirements: {sufficiency: "C1、C2", termination: "Z1、Z2", priority: "低优先级"}
        }));
        await writeFile(path.join(dataDir, "performance.raw.json"), JSON.stringify({open_questions: ["确认性能阈值"]}));

        const document = await buildPhase2Document(workspace, []);
        const performance = document.chapters.find(item => item.number === "4.2");
        expect(performance?.blocks.find(block => block.type === "heading")?.openQuestions).toEqual(["确认性能阈值"])
    })
});

describe("non-functional requirement editor contracts", () => {
    it("provides controlled performance related-description options", async () => {
        const workspace = await mkdtemp(path.join(tmpdir(), "phase2-performance-options-"));
        const dataDir = path.join(workspace, ".matrix", "data");
        await mkdir(dataDir, {recursive: true});
        await writeFile(path.join(dataDir, "performance-test-content.json"), JSON.stringify({
            section_title_no: "4.2.1", section_title: "性能需求项[TR-XN]", rows: []
        }));
        const document = await buildPhase2Document(workspace, [
            {id: "performance-root", businessId: "performance-root", artifact: "performance-test-content.json", number: "4.2", parentId: null},
            {id: "performance-section", businessId: "performance-section", artifact: "performance-test-content.json", number: "4.2.1", parentId: "performance-root"},
        ]);
        const action = document.chapters.flatMap(chapter => chapter.blocks).find(block => block.type === "requirement_actions");
        expect(action?.requirementBinding?.related_description_options).toContain("时间间隔");
        expect(action?.requirementBinding?.related_description_options).toContain("隐含需求：响应时间")
    })
});
