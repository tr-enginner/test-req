import {readFile, readdir} from "node:fs/promises";
import path from "node:path";

type Json = Record<string, any>;
export type Phase2EditBinding = {edit_key: string; node_id: string; field?: string; kind: "text" | "multiline" | "list_item" | "table_cell" | "table_header" | "source_refs" | "table_selection" | "requirement_id_suffix"; value: string | string[]; options?: string[]};
export type Phase2RequirementBinding = {
    container_key: string;
    allow_add: boolean;
    prefix: string;
    mode: "functional" | "non_functional" | "interface";
    interface_label?: string;
    related_description_options?: string[];
};
export type Phase2TextPart = {text: string; editable?: false} | {text: string; editable: true; binding: Phase2EditBinding};
export type Phase2Block = {
    type: "heading" | "paragraph" | "list" | "table" | "table_selector" | "requirement_actions" | "reference_list" | "error";
    text?: string;
    level?: number;
    openQuestions?: string[];
    openQuestionGroups?: {title: string; questions: string[]}[];
    anchorId?: string;
    evaluable?: boolean;
    businessId?: string;
    sourceRefs?: string[];
    items?: string[];
    caption?: string;
    captionParts?: Phase2TextPart[];
    columns?: string[];
    rows?: string[][];
    cells?: { text: string; colSpan?: number; rowSpan?: number }[][];
    rowAnchorIds?: (string | undefined)[];
    rowSourceBindings?: (Phase2EditBinding | undefined)[];
    parts?: Phase2TextPart[];
    itemBindings?: (Phase2EditBinding | undefined)[];
    cellBindings?: (Phase2EditBinding | undefined)[][];
    headerBindings?: (Phase2EditBinding | undefined)[];
    tableBinding?: {container_key: string; allow_add_row: boolean; allow_delete_row: boolean; allow_add_column: boolean; allow_delete_column: boolean; row_keys: string[]; column_keys: string[]; new_row_columns?: string[]};
    selectionBinding?: Phase2EditBinding;
    selectionRole?: "概述" | "输入流" | "输出流";
    selectionEditKey?: string;
    sourceTableId?: string;
    sourceBinding?: Phase2EditBinding;
    requirementBinding?: Phase2RequirementBinding;
    requirementKey?: string;
    rowRequirementKeys?: string[];
    references?: {document_id: string; document_title: string; management: "fixed" | "automatic" | "project"}[];
    referenceBinding?: {container_key: string; node_id?: string};
};
export type Phase2Chapter = {
    artifact: string;
    number: string;
    title: string;
    rootNodeId?: string;
    blocks: Phase2Block[];
    warnings?: string[];
    skippedCount?: number
};

const TEST_TYPES = [
    ["TR-GN-YYY-XXX", "功能测试"], ["TR-XN-XXX", "性能测试"], ["TR-JK-XXX", "接口测试"],
    ["TR-AQ-XXX", "可靠性安全性测试"], ["TR-YL-XXX", "余量测试"], ["TR-BJ-XXX", "边界测试"],
    ["TR-SC-XXX", "数据处理测试"], ["TR-HF-XXX", "恢复性测试"], ["TR-QD-XXX", "强度测试"],
    ["TR-DS-ALL", "代码审查"], ["TR-JF-ALL", "静态分析"], ["TR-LJ-ALL", "逻辑测试"]
];
const BASE_CHAPTER1_REFERENCES = [
    ["TE-GTCG-003-2021", "军用软件测试指南"],
    ["QJ 3027A-2016", "航天型号软件测试规范"],
    ["Q/QJA 300-2014", "航天型号软件测试规范"],
    ["GB/T 25000.51-2016", "系统与软件工程 系统与软件质量要求和评价（SQuaRE） 就绪可用软件产品（RUSP）的质量要求和测试细则"],
    ["GB/T 25000.10-2016", "系统与软件工程 系统与软件质量要求和评价（SQuaRE） 系统与软件质量模型"],
    ["五办[2011]479号", "五院航天器软件第三方测试管理办法"],
    ["QMS-LAB-ST-CX01", "软件测试项目控制程序"]
].map(([document_id, document_title]) => ({document_id, document_title}));
const PROGRAMMING_LANGUAGE_REFERENCES: Record<string, {document_id: string; document_title: string}> = {
    c: {document_id: "Q/W-Q80-18-01-2014", document_title: "航天器软件C语言编程约定"},
    x86_assembly: {document_id: "Q/W 1141-2007", document_title: "航天器X86汇编语言软件编程约定"},
    mcs51_assembly: {document_id: "Q/W 1139-2007", document_title: "航天器51汇编语言软件编程约定"}
};
const FILES = [
    ["chapter1-scope.json", "1", "范围"], ["chapter2-system-overview.json", "2", "系统概述"],
    ["hardware-interface-model.json", "3.1", "硬件接口"], ["functional-test-content.json", "4.1", "功能测试"],
    ["performance-test-content.json", "4.2", "性能测试"], ["interface-test-content.json", "4.3", "接口测试"],
    ["reliability-safety-test-content.json", "4.4", "可靠性安全性测试"], ["margin-test-content.json", "4.5", "余量测试"],
    ["boundary-test-content.json", "4.6", "边界测试"], ["data-processing-test-content.json", "4.7", "数据处理测试"],
    ["recovery-test-content.json", "4.8", "恢复性测试"], ["strength-test-content.json", "4.9", "强度测试"],
    ["phase2-test-traceability.json", "6", "测试需求覆盖性说明"]
] as const;

const text = (value: unknown) => typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
const list = (value: unknown) => Array.isArray(value) ? value.map(text).filter(Boolean) : [];
const flowList = (value: unknown) => Array.isArray(value) ? value.map(text).filter(Boolean) : text(value) ? [text(value)] : [];
const uniqueText = (values: unknown[]) => [...new Set(values.map(text).filter(Boolean))];

type RawQuestions = {file: string; data: Json; questions: string[]};

function questionsFromRaw(data: Json): string[] {
    const plural = Array.isArray(data.open_questions) ? data.open_questions : [];
    const singular = Array.isArray(data.open_question) ? data.open_question : data.open_question == null ? [] : [data.open_question];
    return uniqueText([...plural, ...singular])
}

async function readRawQuestions(file: string, warnings: string[]): Promise<RawQuestions | undefined> {
    try {
        const data = JSON.parse(await readFile(file, "utf8"));
        return {file, data, questions: questionsFromRaw(data)}
    } catch (error: any) {
        if (error?.code !== "ENOENT") warnings.push(`无法读取待确认问题文件 ${path.basename(file)}：${error instanceof Error ? error.message : String(error)}`);
        return undefined
    }
}

async function readRawQuestionDirectory(directory: string, warnings: string[]): Promise<RawQuestions[]> {
    try {
        const names = (await readdir(directory)).filter(name => name.endsWith(".raw.json")).sort();
        return (await Promise.all(names.map(name => readRawQuestions(path.join(directory, name), warnings))))
            .filter((item): item is RawQuestions => Boolean(item))
    } catch (error: any) {
        if (error?.code !== "ENOENT") warnings.push(`无法读取待确认问题目录 ${path.basename(directory)}：${error instanceof Error ? error.message : String(error)}`);
        return []
    }
}

function appendOpenQuestions(block: Phase2Block | undefined, questions: string[]) {
    if (!block || !questions.length) return;
    block.openQuestions = uniqueText([...(block.openQuestions || []), ...questions])
}

const headingWithNumber = (blocks: Phase2Block[], number: string) => blocks.find(block => block.type === "heading" && text(block.text).startsWith(`${number} `));
const firstHeading = (blocks: Phase2Block[]) => blocks.find(block => block.type === "heading");

export function formatFunctionalFlowItems(value: unknown): string[] {
    const items = flowList(value).map(item => item.replace(/[。；]+$/u, "").trimEnd()).filter(Boolean);
    if (!items.length || items.every(item => item === "无")) return ["无。"];
    if (items.length === 1) return [`${items[0]}。`];
    return items.map((item, index) => `${alpha(index)}. ${item}${index === items.length - 1 ? "。" : "；"}`)
}

const refs = (value: Json) => [...new Set([value?.source_ref, ...(Array.isArray(value?.source_refs) ? value.source_refs : [])].filter(item => typeof item === "string"))] as string[];
const heading = (value: string, level: number, anchorId?: string, sourceRefs?: string[], businessId?: string, evaluable = false): Phase2Block => ({
    type: "heading", text: value, level, anchorId, sourceRefs, businessId, ...(evaluable ? {evaluable: true} : {})
});
const paragraph = (value: unknown): Phase2Block => ({type: "paragraph", text: text(value)});
const editKey = (value: Json) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
const binding = (artifact: string, nodeId: string | undefined, field: string, value: unknown, extra: Json = {}, kind: Phase2EditBinding["kind"] = "text", options?: string[]): Phase2EditBinding | undefined =>
    nodeId ? {edit_key: editKey({artifact, field, ...extra}), node_id: nodeId, field, kind, value: Array.isArray(value) ? value.map(text) : text(value), ...(options?.length ? {options} : {})} : undefined;
const editablePart = (value: unknown, valueBinding?: Phase2EditBinding): Phase2TextPart => valueBinding ? {text: text(value), editable: true, binding: valueBinding} : {text: text(value)};
const richParagraph = (parts: Phase2TextPart[], anchorId?: string, sourceBinding?: Phase2EditBinding): Phase2Block => ({type: "paragraph", parts, text: parts.map(part => part.text).join(""), anchorId, sourceBinding});
const table = (caption: string, columns: string[], rows: unknown[][]): Phase2Block => ({
    type: "table",
    caption,
    columns,
    rows: rows.map(row => row.map(item => text(item)))
});
const alpha = (index: number) => String.fromCharCode(97 + index);

export function chapter1DisplayReferences(data: Json): {document_id: string; document_title: string; management: "fixed" | "automatic" | "project"}[] {
    const programming = list(data.programming_languages)
        .map(language => PROGRAMMING_LANGUAGE_REFERENCES[language])
        .filter((item): item is {document_id: string; document_title: string} => Boolean(item));
    const artifactReferences = Array.isArray(data.references) ? data.references : [];
    const seen = new Set<string>();
    return [...BASE_CHAPTER1_REFERENCES.map(item => ({...item, management: "fixed" as const})),
        ...programming.map(item => ({...item, management: "automatic" as const})),
        ...artifactReferences.map((item: Json) => ({...item, management: ["programming_language", "conditional"].includes(text(item.source_kind)) ? "automatic" as const : "project" as const}))].filter((item: Json) => {
        const key = text(item.document_id).toUpperCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true
    }).map((item: Json) => ({document_id: text(item.document_id), document_title: text(item.document_title), management: item.management as "fixed" | "automatic" | "project"}))
        .sort((left, right) => ({fixed: 0, automatic: 1, project: 2}[left.management] - {fixed: 0, automatic: 1, project: 2}[right.management]))
}

export function formatChapter2Processor(processorType: unknown, processorFrequency: unknown): string {
    const type = text(processorType), frequency = text(processorFrequency);
    if (type && frequency) return `CPU：${type}，主频：${frequency}`;
    if (type) return `CPU：${type}`;
    if (frequency) return `主频：${frequency}`;
    return ""
}

export function formatChapter2MemoryReference(summary: unknown, tableCount: number): string {
    if (tableCount <= 0) return "";
    const value = text(summary).trim();
    const separator = value && !/[。！？.!?]$/u.test(value) ? "。" : "";
    const tableReference = tableCount === 1 ? "表2-1" : `表2-1至表2-${tableCount}`;
    return `${separator}具体见${tableReference}。`
}

function compressRequirementIds(ids: string[]) {
    const result: string[] = [];
    for (let index = 0; index < ids.length;) {
        const first = ids[index], match = first.match(/^(.*?)(\d+)$/);
        if (!match) {
            result.push(first);
            index++;
            continue
        }
        const prefix = match[1], width = match[2].length;
        let last = Number(match[2]), end = index;
        while (end + 1 < ids.length) {
            const next = ids[end + 1].match(/^(.*?)(\d+)$/);
            if (!next || next[1] !== prefix || next[2].length !== width || Number(next[2]) !== last + 1) break;
            last++;
            end++
        }
        result.push(end > index ? `${first}~${String(last).padStart(width, "0")}` : first);
        index = end + 1
    }
    return result
}

function maps(requirements: any[]) {
    const byBusiness = new Map(requirements.map(item => [item.businessId, item]));
    const byArtifactNumber = new Map(requirements.filter(item => item.number).map(item => [`${item.artifact}:${item.number}`, item]));
    const root = (artifact: string) => requirements.find(item => item.artifact === artifact && item.parentId == null);
    const anchor = (artifact: string, number?: string, businessId?: string) => (businessId ? byBusiness.get(businessId) : undefined) || (number ? byArtifactNumber.get(`${artifact}:${number}`) : undefined);
    return {root, anchor}
}

function chapter1(data: Json, artifact: string, lookup: ReturnType<typeof maps>): Phase2Block[] {
    const root = lookup.root(artifact), csci = list(data.csci_names).join("、"), documentId = text(data.document_id);
    const references = chapter1DisplayReferences(data);
    const rootBinding = (field: string, value: unknown, kind?: Phase2EditBinding["kind"]) => binding(artifact, root?.id, field, value, {}, kind);
    const rootHeading = heading("1 范围", 1, root?.id, refs(data), root?.businessId, true);
    rootHeading.sourceBinding = rootBinding("source_refs", refs(data), "source_refs");
    return [
        rootHeading, heading("1.1 标识", 2),
        richParagraph([{text: "a. 文档标识："}, editablePart(documentId.replace(/\.RX1$/u, ""), rootBinding("document_id", documentId.replace(/\.RX1$/u, ""))), {text: documentId.endsWith(".RX1") || documentId ? ".RX1" : ""}, {text: "，版本号："}, editablePart(data.document_version, rootBinding("document_version", data.document_version)), {text: "；"}]),
        richParagraph([{text: "b. 本文标题："}, editablePart(data.software_name_and_id, rootBinding("software_name_and_id", data.software_name_and_id)), {text: "第三方测试需求；"}]),
        richParagraph([{text: "c. 委托单位："}, editablePart(data.model_name, rootBinding("model_name", data.model_name)), {text: "项目办；"}]),
        richParagraph([{text: "d. 委托单位地址："}, editablePart(data.client_address, rootBinding("client_address", data.client_address)), {text: "；"}]), paragraph("e. 缩略语："), paragraph("CSCI：计算机软件配置项；"), paragraph("TR：测试需求；"), paragraph("IF：接口。"),
        paragraph("f. 本文档适用的系统和计算机软件配置项（CSCI）："), richParagraph([{text: "本文档适用的系统是"}, editablePart(data.system_name, rootBinding("system_name", data.system_name)), {text: "，对应的软件配置项为"}, editablePart(csci, rootBinding("csci_names", data.csci_names, "list_item")), {text: "。"}]),
        heading("1.2 文档概述", 2), richParagraph([{text: "本文是"}, editablePart(data.software_name_and_id, rootBinding("software_name_and_id", data.software_name_and_id)), {text: "的第三方测试需求，文中描述了该软件的测试范围，定义软件测试项及测试要求，为后续用例设计提供测试依据。本文档适用的代码版本为V"}, editablePart(data.code_version, rootBinding("code_version", data.code_version)), {text: "。"}]),
        heading("1.3 依据文件和引用文档", 2), {type: "reference_list", references,
            referenceBinding: {container_key: editKey({artifact, field: "references"}), node_id: root?.id}},
        heading("1.4 测试需求概述", 2), paragraph("依据委托方的要求，针对被测试软件，确定的测试级别为配置项测试，测试类型及其要求如下："),
        table("表1-1  测试类型总结表", ["序号", "测试类型标识", "测试类型"], TEST_TYPES.map((item, index) => [index + 1, ...item])),
        paragraph("注：ALL为固定符号，不需要改变；YYY为表明所描述需求项意义的符号，需要根据具体需求项进行更改；XXX为当前需求项序号；"),
        paragraph("软件测试项对应的测试要求包括测试充分性要求和测试终止要求两部分。"), paragraph("a. 测试充分性要求，分为如下5个方面："),
        ...["C1：针对上述测试类型，按照《军用软件测评实验室测评过程和技术能力要求》中的规定，设计的测试用例尽可能多地覆盖该测试类型中的要求；", "C2：测试过程中的所有需求项均被覆盖；", "C3：测试需求项测试需要设计有效等价类用例；", "C4：测试需求项测试设计的用例需要包括有效等价类、无效等价类；", "C5：测试需求项测试设计的用例需要包括边界数据值；", "b. 测试终止要求，分为如下3个方面：", "Z1：测试需求项的测试用例按照所设计的操作步骤完成，测试正常终止；", "Z2：测试需求项存在测试用例不能按照所设计的操作步骤完成，测试异常终止；", "Z3：不具备测试条件，不列入本次测试内容。"].map(paragraph)
    ]
}

function chapter2(data: Json, artifact: string, lookup: ReturnType<typeof maps>): Phase2Block[] {
    const root = lookup.root(artifact),
        blocks: Phase2Block[] = [heading("2 系统概述", 1, root?.id, refs(data), root?.businessId, true), heading("2.1 运行环境说明", 2)];
    const rootBinding = (field: string, value: unknown, kind?: Phase2EditBinding["kind"]) => binding(artifact, root?.id, field, value, {}, kind);
    blocks[0].sourceBinding = rootBinding("source_refs", refs(data), "source_refs");
    blocks.push(richParagraph([editablePart(data.system_relationship, rootBinding("system_relationship", data.system_relationship, "multiline"))]),
        richParagraph([{text: "a. CPU："}, editablePart(data.processor_type, rootBinding("processor_type", data.processor_type)), {text: "，主频："}, editablePart(data.processor_frequency, rootBinding("processor_frequency", data.processor_frequency))]),
        richParagraph([{text: "b. "}, editablePart(data.memory_io_summary, rootBinding("memory_io_summary", data.memory_io_summary, "multiline")), {text: formatChapter2MemoryReference(data.memory_io_summary, data.memory_io_tables?.length || 0)}]));
    (data.memory_io_tables || []).forEach((item: Json, index: number) => {
        const value = normalizedTable(item, `存储器及I/O说明表${index + 1}`);
        if (!value) return;
        const tableTitle = cleanTableTitle(item.title) || `存储器及I/O说明表${index + 1}`;
        value.caption = `表2-${index + 1}  ${tableTitle}`;
        value.captionParts = [{text: `表2-${index + 1}  `}, editablePart(tableTitle, rootBinding(`memory_io_tables.${index}.title`, tableTitle))];
        value.headerBindings = (value.columns || []).map((column, columnIndex) => rootBinding(`memory_io_tables.${index}.columns.${columnIndex}`, column, "table_header"));
        value.tableBinding = {container_key: editKey({artifact, field: `memory_io_tables.${index}`}), allow_add_row: true, allow_delete_row: true,
            allow_add_column: true, allow_delete_column: true,
            row_keys: (value.rows || []).map((_, rowIndex) => editKey({artifact, field: `memory_io_tables.${index}.rows.${rowIndex}`})),
            column_keys: (value.columns || []).map((_, columnIndex) => editKey({artifact, field: `memory_io_tables.${index}.columns.${columnIndex}`})),
            new_row_columns: value.columns || []};
        value.cellBindings = (value.rows || []).map((row, rowIndex) => row.map((cell, cellIndex) =>
            rootBinding(`memory_io_tables.${index}.rows.${rowIndex}.${cellIndex}`, cell, "table_cell")));
        blocks.push(value)
    });
    const interruptNo = (data.memory_io_tables?.length || 0) + 1;
    const interrupt = table(`表2-${interruptNo}  中断使用说明`, ["中断名称", "优先级", "周期（触发频率）/随机（频繁/偶发）", "触发方式", "执行功能"], (data.interrupts || []).map((item: Json) => [item.interrupt_name, item.priority, item.frequency_or_random, item.trigger_mode, item.execution_function]));
    interrupt.cellBindings = (interrupt.rows || []).map((row, rowIndex) => row.map((cell, cellIndex) => rootBinding(`interrupts.${rowIndex}.${["interrupt_name", "priority", "frequency_or_random", "trigger_mode", "execution_function"][cellIndex]}`, cell, "table_cell")));
    interrupt.tableBinding = {container_key: editKey({artifact, field: "interrupts"}), allow_add_row: true, allow_delete_row: true,
        allow_add_column: false, allow_delete_column: false,
        row_keys: (interrupt.rows || []).map((_, rowIndex) => editKey({artifact, field: `interrupts.${rowIndex}`})), column_keys: [], new_row_columns: interrupt.columns};
    blocks.push(paragraph("c. 中断使用情况如下表："), interrupt);
    blocks.push(heading("2.2 软件概述", 2), richParagraph([editablePart(data.software_name_and_id, rootBinding("software_name_and_id", data.software_name_and_id)), {text: "的软件级别为"}, editablePart(data.software_level, rootBinding("software_level", data.software_level)), {text: "，采用"}, editablePart(data.programming_language, rootBinding("programming_language", data.programming_language)), {text: "开发。"}]), paragraph("软件主要功能如下："), ...list(data.subsystem_and_software_functions).map((item, index) => richParagraph([{text: `${alpha(index)}. `}, editablePart(item, rootBinding(`subsystem_and_software_functions.${index}`, item, "list_item")), {text: /[；。]$/.test(item) ? "" : "；"}])), heading("2.3 开发环境概述", 2), richParagraph([editablePart(data.development_platform, rootBinding("development_platform", data.development_platform)), {text: "，"}, editablePart(data.compilation_environment, rootBinding("compilation_environment", data.compilation_environment)), {text: "。"}]));
    return blocks
}

export function normalizedTable(item: Json, fallback: string): Phase2Block | undefined {
    const columns = list(item.columns), rows = Array.isArray(item.rows) ? item.rows : [];
    if (!columns.length) return undefined;
    const value = table(text(item.title) || fallback, columns, rows.map((row: Json | unknown[]) => Array.isArray(row) ? row : columns.map(column => row[column])));
    if (Array.isArray(item.cells)) value.cells = item.cells;
    return value
}

export function cleanTableTitle(value: unknown) {
    const title = text(value).replace(/<\/?w:[A-Za-z][^>]*>/giu, "").replace(/<\/?wt\b[^>]*>/giu, "").replace(/\s+/gu, " ").trim();
    const sourceTableNumber = String.raw`(?:表格|附表|表)\s*(?:\d+|[A-Za-zＡ-Ｚａ-ｚ]+)(?:\s*[.．\-－—]\s*\d+)*`;
    if (new RegExp(`^${sourceTableNumber}\\s*$`, "u").test(title)) return "";
    const cleaned = title.replace(new RegExp(`^${sourceTableNumber}(?:\\s*[：:、]\\s*|\\s+|(?=[A-Za-zＡ-Ｚａ-ｚ\\u4e00-\\u9fff]))`, "u"), "").trim();
    return cleaned || title
}

const decodeXml = (value: string) => value
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&");

function parseDocxTableXml(xml: string) {
    type ParsedCell = {
        text: string;
        colSpan: number;
        rowSpan: number;
        column: number;
        merge?: "restart" | "continue"
    };
    const parsedRows: ParsedCell[][] = [...xml.matchAll(/<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g)].map(row => {
        let column = 0;
        return [...row[1].matchAll(/<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g)].map(cell => {
            const cellXml = cell[1], colSpan = Number(cellXml.match(/<w:gridSpan\b[^>]*w:val="(\d+)"/)?.[1] || 1),
                mergeTag = cellXml.match(/<w:vMerge\b([^>]*)\/?\s*>/)?.[1],
                merge = mergeTag === undefined ? undefined : /w:val="restart"/.test(mergeTag) ? "restart" : "continue",
                value: ParsedCell = {
                    text: decodeXml([...cellXml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map(match => match[1]).join(""))
                        .replace(/\s+/g, " ").trim(), colSpan, rowSpan: 1, column, merge
                };
            column += colSpan;
            return value
        })
    });
    if (!parsedRows.length) return undefined;
    for (let rowIndex = 0; rowIndex < parsedRows.length; rowIndex++) {
        for (const cell of parsedRows[rowIndex]) {
            if (cell.merge !== "continue") continue;
            for (let previous = rowIndex - 1; previous >= 0; previous--) {
                const origin = parsedRows[previous].find(candidate => candidate.column === cell.column && candidate.merge !== "continue");
                if (origin) {
                    origin.rowSpan++;
                    break
                }
            }
        }
    }
    const cells = parsedRows.map(row => row.filter(cell => cell.merge !== "continue").map(cell => ({text: cell.text, ...(cell.colSpan > 1 ? {colSpan: cell.colSpan} : {}), ...(cell.rowSpan > 1 ? {rowSpan: cell.rowSpan} : {})})));
    const expandedRows = parsedRows.map(row => row.map(cell => cell.text)),
        width = Math.max(...expandedRows.map(row => row.length)),
        normalized = expandedRows.map(row => [...row, ...Array(Math.max(0, width - row.length)).fill("")]);
    return {columns: normalized[0], rows: normalized.slice(1), cells}
}

async function hydrateHardwareTables(data: Json): Promise<string[]> {
    const warnings: string[] = [];
    const tables: Json[] = [];
    for (const item of data.interfaces || []) {
        tables.push(...(item.overview_tables || []), ...(item.input_tables || []), ...(item.output_tables || []));
        for (const topic of item.topics || []) tables.push(...(topic.input_tables || []), ...(topic.output_tables || []))
    }
    await Promise.all(tables.map(async item => {
        if (Array.isArray(item.columns) && Array.isArray(item.rows)) return;
        const assetPath = text(item.table_asset?.path);
        if (!assetPath) { item.__unavailable = true; warnings.push(`跳过缺少资源的硬件表格：${text(item.title) || "未命名表格"}`); return }
        try {
            const parsed = parseDocxTableXml(await readFile(assetPath, "utf8"));
            if (parsed) Object.assign(item, parsed);
            else { item.__unavailable = true; warnings.push(`跳过无法解析的硬件表格：${text(item.title) || assetPath}`) }
        } catch (error) {
            item.__unavailable = true;
            warnings.push(`跳过无法读取的硬件表格：${text(item.title) || assetPath}：${error instanceof Error ? error.message : String(error)}`)
        }
    }));
    return warnings
}

function hardware(data: Json, artifact: string, lookup: ReturnType<typeof maps>): Phase2Block[] {
    const root = lookup.root(artifact),
        blocks: Phase2Block[] = [heading(`3 ${text(data.chapter_title) || "数据及接口需求"}`, 1), heading(`3.1 ${text(data.section_title) || "硬件接口"}`, 2, root?.id, refs(data), root?.businessId, true)];
    (data.interfaces || []).forEach((item: Json, index: number) => {
        const number = `3.1.${index + 1}`, node = lookup.anchor(artifact, number),
            title = text(item.title || item.interface_name || item.name) || `硬件接口${index + 1}`;
        const renderedTables = new Map<string, string>();
        let tableSequence = 1;
        const extra = {identity: {interface_id: item.interface_id, candidate_id: item.candidate_id}};
        const itemBinding = (field: string, value: unknown, kind?: Phase2EditBinding["kind"]) => binding(artifact, node?.id, field, value, extra, kind);
        const interfaceHeading = heading(`${number} ${title}`, 3, node?.id, refs(item), node?.businessId);
        interfaceHeading.parts = [{text: `${number} `}, editablePart(title, itemBinding("title", title))];
        interfaceHeading.sourceBinding = itemBinding("source_refs", refs(item), "source_refs");
        blocks.push(interfaceHeading);
        const interfaceId = text(item.interface_id || item.id), overview = text(item.overview);
        // The interface heading already owns and renders the interface-level trace links.
        // Giving the overview paragraph the same anchor duplicates that exact trace block.
        if (interfaceId || overview) blocks.push(richParagraph([{text: interfaceId + (overview ? "：" : "")}, editablePart(overview, itemBinding("overview", overview, "multiline"))]));
        const appendTables = (tables: Json[], fallback: string, field: string, selectionRole: "概述" | "输入流" | "输出流") => {
            const selectionBinding = itemBinding(field, (tables || []).map(table => text(table.table_id)).filter(Boolean), "table_selection");
            blocks.push({type: "table_selector", text: fallback,
                selectionBinding, selectionRole});
            for (const candidate of tables || []) {
                if (candidate.__unavailable) continue;
                const sharedKey = text(candidate.table_id) || text(candidate.table_asset?.path);
                const previousNumber = sharedKey ? renderedTables.get(sharedKey) : undefined;
                if (previousNumber) {
                    blocks.push(paragraph(`该表已在前文展示：${previousNumber}。`));
                    continue
                }
                const value = normalizedTable(candidate, fallback);
                if (value) {
                    const finalNumber = `表${number}-${tableSequence++}`;
                    value.caption = `${finalNumber}  ${cleanTableTitle(value.caption) || fallback}`;
                    value.selectionEditKey = selectionBinding?.edit_key;
                    value.sourceTableId = text(candidate.table_id);
                    blocks.push(value);
                    if (sharedKey) renderedTables.set(sharedKey, finalNumber)
                }
            }
        };
        const flowGroup = (flows: unknown, tables: Json[], label: string, field: string, tableField: string, selectionRole: "输入流" | "输出流") => {
            const values = flowList(flows), indexed = Array.isArray(flows);
            for (const [flowIndex, value] of values.entries()) blocks.push(richParagraph([
                editablePart(value, itemBinding(indexed ? `${field}.${flowIndex}` : field, value, indexed ? "list_item" : "multiline"))
            ]));
            appendTables(tables, label, tableField, selectionRole)
        };
        appendTables(item.overview_tables, `${title}概述数据表`, "overview_tables", "概述");
        flowGroup(item.input_flow, item.input_tables, `${title}输入数据表`, "input_flow", "input_tables", "输入流");
        flowGroup(item.output_flow, item.output_tables, `${title}输出数据表`, "output_flow", "output_tables", "输出流");
        (item.topics || []).forEach((sub: Json, subIndex: number) => {
            const topicNumber = `${number}.${subIndex + 1}`,
                topicNode = lookup.anchor(artifact, topicNumber, text(sub.business_id || sub.requirement_id || sub.id));
            const topicHeading = heading(`${topicNumber} ${text(sub.title || sub.name)}`, 4, topicNode?.id, refs(sub), topicNode?.businessId);
            topicHeading.parts = [{text: `${topicNumber} `}, editablePart(sub.title || sub.name, itemBinding(`topics.${subIndex}.title`, sub.title || sub.name))];
            blocks.push(topicHeading);
            flowGroup(sub.input_flow, sub.input_tables, `${text(sub.title)}输入数据表`, `topics.${subIndex}.input_flow`, `topics.${subIndex}.input_tables`, "输入流");
            flowGroup(sub.output_flow, sub.output_tables, `${text(sub.title)}输出数据表`, `topics.${subIndex}.output_flow`, `topics.${subIndex}.output_tables`, "输出流")
        })
    });
    if (!(data.interfaces || []).length) blocks.push(paragraph("未识别到可展示的硬件接口内容。"));
    return blocks
}

function functional(data: Json, artifact: string, lookup: ReturnType<typeof maps>, warnings: string[] = []): Phase2Block[] {
    const root = lookup.root(artifact),
        blocks: Phase2Block[] = [heading(`${text(data.chapter_title_no) || "4"} ${text(data.chapter_title) || "测试类型说明"}`, 1), heading(`${text(data.section_title_no) || "4.1"} ${text(data.section_title) || "功能测试"}`, 2, root?.id, refs(data), root?.businessId)];
    const visit = (node: Json) => {
        const number = text(node.title_no), match = lookup.anchor(artifact, number),
            children = Array.isArray(node.children) ? node.children : [],
            content = node.init_content || node.other_content;
        const placeholder = Boolean(content) && text(content.summary) === "内容未生成" && !(content.processing || []).length;
        blocks.push(heading(`${number} ${text(node.title)}`, Math.min(number.split(".").length, 5), placeholder ? undefined : match?.id,
            placeholder ? [] : refs(node), placeholder ? undefined : match?.businessId, !placeholder && children.length === 0 && Boolean(content)));
        if (children.length) return children.forEach(visit);
        if (!content) return;
        if (placeholder) { blocks.push(paragraph("内容未生成（该缺项没有可编辑的 raw 目标）。")); return }
        const containerExtra = {container_id: number, identity: {title_no: number}};
        const leafBinding = (field: string, value: unknown, kind?: Phase2EditBinding["kind"]) => placeholder ? undefined : binding(artifact, match?.id, field, value, containerExtra, kind);
        if (text(content.summary)) blocks.push(richParagraph([editablePart(content.summary, leafBinding("summary", content.summary, "multiline"))]));
        const inputItems = formatFunctionalFlowItems(content.input_flow);
        blocks.push(heading(`${number}.1 输入流说明`, 5), {
            type: "list",
            items: inputItems,
            itemBindings: inputItems.map((_, index) => leafBinding(`input_flow.${index}`, content.input_flow?.[index], "list_item"))
        }, heading(`${number}.2 处理`, 5));
        const tableList: Json[] = content.tables || [];
        const tables = new Map<string, {item: Json; index: number}>(tableList.map((item: Json, index: number) => [text(item.table_id), {item, index}]));
        const renderedTables = new Set<string>();
        const functionalPrefix = text(content.tr_code || node.tr_code || content.processing?.[0]?.requirement_id?.replace(/-\d+$/u, ""));
        const requirementBinding: Phase2RequirementBinding = {
            container_key: editKey({artifact, ...containerExtra, field: "processing"}), allow_add: !placeholder,
            prefix: functionalPrefix, mode: "functional"
        };
        for (const processing of content.processing || []) {
            const requirementId = text(processing.requirement_id),
                target = lookup.anchor(artifact, undefined, requirementId);
            const suffix = requirementId.match(/-(\d+)$/u)?.[1] || "";
            const prefix = suffix ? requirementId.slice(0, -suffix.length) : `${functionalPrefix}-`;
            blocks.push({
                type: "paragraph",
                text: `${requirementId}：${text(processing.content)}`,
                parts: [{text: prefix}, editablePart(suffix, binding(artifact, target?.id, "requirement_id_suffix", suffix, {business_id: requirementId}, "requirement_id_suffix")), {text: "："}, editablePart(processing.content, binding(artifact, target?.id, "content", processing.content, {business_id: requirementId}, "multiline"))],
                anchorId: target?.id,
                businessId: requirementId,
                sourceRefs: refs(processing),
                sourceBinding: binding(artifact, target?.id, "source_refs", refs(processing), {business_id: requirementId}, "source_refs"),
                requirementBinding,
                requirementKey: editKey({artifact, business_id: requirementId, ...containerExtra, field: "content"})
            });
            for (const tableRef of processing.table_refs || []) {
                const found = tables.get(text(tableRef));
                if (!found) { warnings.push(`跳过未知功能表格引用：${text(tableRef) || "空引用"}`); continue }
                if (renderedTables.has(text(tableRef))) continue;
                const {item, index: tableIndex} = found;
                const value = normalizedTable(item, "关联表格");
                if (value) {
                    const tableNo = text(item.table_no);
                    const tableTitle = cleanTableTitle(item.title) || "关联表格";
                    value.caption = [tableNo, tableTitle].filter(Boolean).join(" ");
                    value.captionParts = [{text: tableNo ? `${tableNo} ` : ""}, editablePart(tableTitle, leafBinding(`tables.${tableIndex}.title`, tableTitle))];
                    value.headerBindings = (value.columns || []).map((column, columnIndex) => leafBinding(`tables.${tableIndex}.columns.${columnIndex}`, column, "table_header"));
                    value.cellBindings = (value.rows || []).map((row, rowIndex) => row.map((cell, cellIndex) =>
                        leafBinding(`tables.${tableIndex}.rows.${rowIndex}.${cellIndex}`, cell, "table_cell")));
                    value.tableBinding = {container_key: editKey({artifact, ...containerExtra, field: `tables.${tableIndex}`}),
                        allow_add_row: true, allow_delete_row: true, allow_add_column: true, allow_delete_column: true,
                        row_keys: (value.rows || []).map((_, rowIndex) => editKey({artifact, ...containerExtra, field: `tables.${tableIndex}.rows.${rowIndex}`})),
                        column_keys: (value.columns || []).map((_, columnIndex) => editKey({artifact, ...containerExtra, field: `tables.${tableIndex}.columns.${columnIndex}`})),
                        new_row_columns: value.columns || []};
                    blocks.push(value);
                    renderedTables.add(text(tableRef))
                } else warnings.push(`跳过结构不可展示的功能表格：${text(item.title || item.table_id) || "未命名表格"}`)
            }
        }
        for (const [tableIndex, item] of tableList.entries()) {
            const id = text(item.table_id);
            if (id && renderedTables.has(id)) continue;
            const value = normalizedTable(item, "关联表格");
            if (!value) { warnings.push(`跳过结构不可展示的功能表格：${text(item.title || item.table_id) || "未命名表格"}`); continue }
            const tableNo = text(item.table_no), tableTitle = cleanTableTitle(item.title) || "关联表格";
            value.caption = [tableNo, tableTitle].filter(Boolean).join(" ");
            value.captionParts = [{text: tableNo ? `${tableNo} ` : ""}, editablePart(tableTitle, leafBinding(`tables.${tableIndex}.title`, tableTitle))];
            value.headerBindings = (value.columns || []).map((column, columnIndex) => leafBinding(`tables.${tableIndex}.columns.${columnIndex}`, column, "table_header"));
            value.cellBindings = (value.rows || []).map((row, rowIndex) => row.map((cell, cellIndex) => leafBinding(`tables.${tableIndex}.rows.${rowIndex}.${cellIndex}`, cell, "table_cell")));
            blocks.push(value);
            if (id) renderedTables.add(id)
        }
        if (!placeholder) blocks.push({type: "requirement_actions", requirementBinding});
        const outputItems = formatFunctionalFlowItems(content.output_flow);
        blocks.push(heading(`${number}.3 输出流说明`, 5), {
            type: "list",
            items: outputItems,
            itemBindings: outputItems.map((_, index) => leafBinding(`output_flow.${index}`, content.output_flow?.[index], "list_item"))
        }, heading(`${number}.4 测试要求`, 5), paragraph("测试充分性要求：C1、C2；"), paragraph("测试终止要求：Z1、Z2；"), paragraph("优先级：所有需求项为低优先级。"))
    };
    (data.children || []).forEach(visit);
    return blocks
}

const NON_FUNCTIONAL: Record<string, { description: string; prefix: string; noun: string }> = {
    "4.2": {description: "performance_requirement_description", prefix: "TR-XN", noun: "性能"},
    "4.3": {description: "interface_requirement_description", prefix: "TR-JK", noun: "接口"},
    "4.4": {description: "reliability_safety_requirement_description", prefix: "TR-AQ", noun: "可靠性安全性"},
    "4.5": {description: "margin_requirement_description", prefix: "TR-YL", noun: "余量"},
    "4.6": {description: "boundary_requirement_description", prefix: "TR-BJ", noun: "边界"},
    "4.7": {description: "data_processing_requirement_description", prefix: "TR-SC", noun: "数据处理"},
    "4.8": {description: "recovery_requirement_description", prefix: "TR-HF", noun: "恢复性"},
    "4.9": {description: "strength_requirement_description", prefix: "TR-QD", noun: "强度"}
};
const RELATED_DESCRIPTION_OPTIONS: Record<string, string[]> = {
    "4.2": ["时间间隔", "处理时间", "处理精度", "响应时间", "隐含需求：时间间隔", "隐含需求：处理时间", "隐含需求：处理精度", "隐含需求：响应时间"],
    "4.4": ["提高安全性的容错方案", "异常条件下系统的处理和保护能力", "异常条件下软件的处理和保护能力", "输入故障模式的测试"],
    "4.5": ["存储量的余量", "功能处理时间的余量", "输入/输出及通道的吞吐能力余量"],
    "4.7": ["数据采集", "数据转换", "数据剔除", "数据融合", "数据解释"],
    "4.8": ["故障发生时保护系统状态", "切换备用硬件", "探测错误功能"],
    "4.9": ["长时间连续不间断综合功能测试", "提供数据能力的饱和性试验指标"]
};

function nonFunctional(data: Json, artifact: string, number: string, title: string, lookup: ReturnType<typeof maps>): Phase2Block[] {
    const config = NON_FUNCTIONAL[number], root = lookup.root(artifact), rows = data.rows || [],
        sectionNo = text(data.section_title_no) || `${number}.1`,
        sectionTitle = text(data.section_title) || `${config.noun}需求项[${config.prefix}]`;
    const sectionNode = lookup.anchor(artifact, sectionNo);
    const renderedRows: string[][] = rows.map((row: Json, index: number) => {
        const requirementId = text(row.requirement_id || row.test_requirement_id) || `${config.prefix}-${String(index + 1).padStart(3, "0")}`;
        return number === "4.3"
            ? [String(index + 1), text(row[config.description]), requirementId, text(row.related_description), text(row.interface_name), text(row.interface_id)]
            : [String(index + 1), text(row[config.description]), requirementId, text(row.related_description)]
    });
    const summary = table(`表${number}-1  ${config.noun}需求项总结表`, number === "4.3"
        ? ["序号", `${config.noun}需求描述`, "对应测试需求标识", "相关说明", "对应接口名称", "接口标识"]
        : ["序号", `${config.noun}需求描述`, "对应测试需求标识", "相关说明"], renderedRows);
    summary.rowAnchorIds = renderedRows.map(row => lookup.anchor(artifact, undefined, row[2])?.id);
    summary.cellBindings = renderedRows.map((row, index) => {
        const nodeId = summary.rowAnchorIds?.[index], requirementId = row[2], extra = {business_id: requirementId};
        return [undefined, binding(artifact, nodeId, config.description, rows[index]?.[config.description], extra, "multiline"), undefined,
            binding(artifact, nodeId, "related_description", rows[index]?.related_description, extra, "multiline", RELATED_DESCRIPTION_OPTIONS[number]),
            ...(number === "4.3" ? [undefined, undefined] : [])]
    });
    summary.rowSourceBindings = renderedRows.map((row, index) => binding(artifact, summary.rowAnchorIds?.[index], "source_refs", refs(rows[index]), {business_id: row[2]}, "source_refs"));
    const baseBinding: Phase2RequirementBinding = {container_key: editKey({artifact, field: "rows"}), allow_add: number !== "4.3", prefix: config.prefix,
        mode: "non_functional", related_description_options: RELATED_DESCRIPTION_OPTIONS[number]};
    summary.requirementBinding = baseBinding;
    summary.rowRequirementKeys = renderedRows.map(row => editKey({artifact, business_id: row[2], field: number === "4.3" ? "interface_requirement_description" : config.description}));
    const blocks: Phase2Block[] = [heading(`${number} ${title}`, 2, root?.id, refs(data), root?.businessId), heading(`${sectionNo} ${sectionTitle}`, 3, sectionNode?.id, refs(data), sectionNode?.businessId, true), paragraph(`依据引用文档及上述测试需求分析，共总结如下 ${rows.length} 项${config.noun}需求：`), summary];
    if (number === "4.3") {
        const interfacesById = new Map<string, Json>();
        for (const row of rows as Json[]) {
            const interfaceId = text(row.interface_id);
            if (interfaceId && !interfacesById.has(interfaceId)) interfacesById.set(interfaceId, row)
        }
        const interfaces = [...interfacesById.values()];
        for (const item of interfaces) blocks.push({type: "requirement_actions", requirementBinding: {
            container_key: editKey({artifact, identity: {interface_id: text(item.interface_id)}, field: "rows"}), allow_add: true,
            prefix: config.prefix, mode: "interface", interface_label: text(item.interface_name || item.interface_id)
        }});
    } else blocks.push({type: "requirement_actions", requirementBinding: baseBinding});
    blocks.push(heading(`${number}.2 测试要求`, 3), paragraph(`测试充分性要求：${text(data.test_requirements?.sufficiency)}；`), paragraph(`测试终止要求：${text(data.test_requirements?.termination)}；`), paragraph(`优先级：所有需求项为${text(data.test_requirements?.priority)}。`));
    return blocks
}

const SINGLE_RAW_BY_CHAPTER: Record<string, string> = {
    "4.2": "performance.raw.json",
    "4.4": "reliability-safety.raw.json",
    "4.5": "margin.raw.json",
    "4.6": "boundary.raw.json",
    "4.7": "data-processing.raw.json",
    "4.8": "recovery.raw.json",
    "4.9": "strength.raw.json"
};

async function attachRawOpenQuestions(dataDir: string, number: string, data: Json, blocks: Phase2Block[], warnings: string[]) {
    if (number === "3.1") {
        const raws = await readRawQuestionDirectory(path.join(dataDir, "hardware-interface-blocks"), warnings);
        const interfaces = Array.isArray(data.interfaces) ? data.interfaces : [];
        for (const raw of raws) {
            if (!raw.questions.length) continue;
            const candidate = raw.data.interface || raw.data;
            const identities = [candidate.interface_id, candidate.candidate_id].map(text).filter(Boolean);
            const names = [candidate.title, candidate.interface_name, candidate.name].map(text).filter(Boolean);
            const index = interfaces.findIndex((item: Json) => identities.some(value => [text(item.interface_id), text(item.candidate_id)].includes(value))
                || names.some(value => [text(item.title), text(item.interface_name), text(item.name)].includes(value)));
            if (index < 0) warnings.push(`无法将 ${path.basename(raw.file)} 的待确认问题匹配到3.1子章节`);
            else appendOpenQuestions(headingWithNumber(blocks, `3.1.${index + 1}`), raw.questions)
        }
        return
    }
    if (number === "4.1") {
        const init = await readRawQuestions(path.join(dataDir, "functional-init-content.raw.json"), warnings);
        const leaves = await readRawQuestionDirectory(path.join(dataDir, "functional-other-content-leaves"), warnings);
        for (const raw of [init, ...leaves].filter((item): item is RawQuestions => Boolean(item))) {
            if (!raw.questions.length) continue;
            const items = Array.isArray(raw.data.items) ? raw.data.items : [];
            const numbers = uniqueText([...items.map((item: Json) => item.title_no), raw.data.section_title_no])
                .filter(value => value !== "4.1").sort((left, right) => right.length - left.length);
            let target = numbers.map(value => headingWithNumber(blocks, value)).find(Boolean);
            if (!target) {
                const sourceRefs = uniqueText(items.flatMap((item: Json) => [item.source_ref, ...(Array.isArray(item.source_refs) ? item.source_refs : [])]));
                target = blocks.find(block => block.type === "heading" && block.sourceRefs?.some(value => sourceRefs.includes(value)))
            }
            if (!target) {
                const titles = uniqueText(items.map((item: Json) => item.title));
                target = blocks.find(block => block.type === "heading" && titles.some(value => text(block.text).endsWith(` ${value}`)))
            }
            if (!target) warnings.push(`无法将 ${path.basename(raw.file)} 的待确认问题匹配到4.1子章节`);
            else appendOpenQuestions(target, raw.questions)
        }
        return
    }
    if (number === "4.3") {
        const raws = await readRawQuestionDirectory(path.join(dataDir, "interface-test-content-batches"), warnings);
        const rows = Array.isArray(data.rows) ? data.rows : [];
        const finalOrder = uniqueText(rows.map((row: Json) => row.interface_id));
        const finalNames = new Map<string, string>();
        for (const row of rows) {
            const interfaceId = text(row.interface_id);
            if (interfaceId && !finalNames.has(interfaceId)) finalNames.set(interfaceId, text(row.interface_name) || interfaceId)
        }
        const grouped = new Map<string, {title: string; questions: string[]}>();
        for (const raw of raws) {
            if (!raw.questions.length) continue;
            const interfaceId = text(raw.data.interface_id || raw.data.batch_id);
            if (!interfaceId) {
                warnings.push(`无法取得 ${path.basename(raw.file)} 的接口身份，待确认问题未展示`);
                continue
            }
            const interfaceName = text(raw.data.interface_name) || finalNames.get(interfaceId) || interfaceId;
            const current = grouped.get(interfaceId);
            grouped.set(interfaceId, {
                title: interfaceName === interfaceId ? interfaceId : `${interfaceName}（${interfaceId}）`,
                questions: uniqueText([...(current?.questions || []), ...raw.questions])
            })
        }
        const order = [...finalOrder.filter(interfaceId => grouped.has(interfaceId)), ...[...grouped.keys()].filter(interfaceId => !finalOrder.includes(interfaceId))];
        const target = headingWithNumber(blocks, "4.3");
        if (target) target.openQuestionGroups = order.map(interfaceId => grouped.get(interfaceId)!).filter(group => group.questions.length)
        return
    }
    const rawName = SINGLE_RAW_BY_CHAPTER[number];
    if (!rawName) return;
    const raw = await readRawQuestions(path.join(dataDir, rawName), warnings);
    if (raw) appendOpenQuestions(firstHeading(blocks), raw.questions)
}

function traceability(data: Json, artifact: string, lookup: ReturnType<typeof maps>): Phase2Block[] {
    const root = lookup.root(artifact), rows = data.rows || [],
        requirementCount = data.summary?.requirement_count ?? [...new Set(rows.flatMap((item: Json) => item.test_requirement_ids || []))].length;
    return [heading("6 测试需求覆盖性说明", 1, root?.id, refs(data), root?.businessId), paragraph(`经过上述的测试需求分析过程，共总结出测试点 ${requirementCount} 项。`), paragraph("本测试需求总结的测试点覆盖了需求规格说明书的内容，具体的对应关系如下表。"), table("表6-1  测试需求覆盖表", ["文档名称", "章节号", "标题名称", "测试需求标识"], rows.map((row: Json) => [row.document_name, row.section_number || row.section_no || row.source_section_no, row.section_title, row.test_requirement_ids?.length ? compressRequirementIds(row.test_requirement_ids).join("\n") : "非测试需求项"]))]
}

export async function buildPhase2DocumentFromDataDir(dataDir: string, requirements: any[]) {
    const lookup = maps(requirements),
        chapters: Phase2Chapter[] = [];
    for (const [artifact, number, title] of FILES) {
        try {
            const data = JSON.parse(await readFile(path.join(dataDir, artifact), "utf8"));
            let blocks: Phase2Block[];
            const warnings: string[] = Array.isArray(data.warnings) ? data.warnings.map(text).filter(Boolean) : [];
            if (number === "1") blocks = chapter1(data, artifact, lookup);
            else if (number === "2") blocks = chapter2(data, artifact, lookup);
            else if (number === "3.1") {
                warnings.push(...await hydrateHardwareTables(data));
                blocks = hardware(data, artifact, lookup)
            } else if (number === "4.1") blocks = functional(data, artifact, lookup, warnings);
            else if (number === "6") blocks = traceability(data, artifact, lookup);
            else blocks = nonFunctional(data, artifact, number, title, lookup);
            await attachRawOpenQuestions(dataDir, number, data, blocks, warnings);
            chapters.push({artifact, number, title, rootNodeId: lookup.root(artifact)?.id, blocks,
                ...(warnings.length ? {warnings: [...new Set(warnings)], skippedCount: warnings.filter(item => item.startsWith("跳过")).length} : {})})
        } catch (error: any) {
            if (error?.code === "ENOENT") continue;
            chapters.push({
                artifact,
                number,
                title,
                rootNodeId: lookup.root(artifact)?.id,
                blocks: [{
                    type: "error",
                    text: `${number} ${title}加载失败：${error instanceof Error ? error.message : String(error)}`
                }]
            })
        }
    }
    return {chapters}
}

export async function buildPhase2Document(workspacePath: string, requirements: any[]) {
    return buildPhase2DocumentFromDataDir(path.join(workspacePath, ".matrix", "data"), requirements)
}
