import {createElement, useCallback, useEffect, useRef, useState} from "react";
import {Alert, Button, Input, Modal, Popconfirm, Select, Tag, Tooltip} from "antd";
import {AuditOutlined, DeleteOutlined, EditOutlined, PlusOutlined, QuestionCircleOutlined} from "@ant-design/icons";
import type {Phase2Block, Phase2Chapter, Phase2EditBinding, Phase2ReferenceOperation, Phase2RequirementOperation, Phase2TableOperation, Phase2TextPart, RequirementDiffAnnotation, SourceRefOption, SourceTableOption, TraceLink} from "./api";
import {SortableTableList} from "./SortableTableList";
import {chapterWarningForBlock, type ChapterWarningPresentation} from "./chapterWarning";

type Props = {
    chapters: Phase2Chapter[];
    links: TraceLink[];
    activeId?: string;
    mode?: "review" | "diff-before" | "diff-after";
    diffAnnotations?: RequirementDiffAnnotation[];
    selectedEntityUid?: string;
    reviewScores?: Record<string, number>;
    onSource: (link: TraceLink) => void;
    onEvaluate: (targetId: string) => void;
    editing?: boolean;
    drafts?: Record<string, unknown>;
    onDraft?: (binding: Phase2EditBinding, value: unknown) => void;
    onEditSources?: (binding: Phase2EditBinding) => void;
    onEditTables?: (binding: Phase2EditBinding) => void;
    tableOperations?: Phase2TableOperation[];
    onTableOperation?: (operation: Phase2TableOperation) => void;
    requirementOperations?: Phase2RequirementOperation[];
    onRequirementOperation?: (operation: Phase2RequirementOperation) => void;
    referenceOperations?: Phase2ReferenceOperation[];
    onReferenceOperation?: (operation: Phase2ReferenceOperation) => void;
    onEditActivityEnd?: () => void;
    readOnly?: boolean;
    evaluationDisabled?: boolean;
    interactionLocked?: boolean;
    availableTables?: SourceTableOption[];
    availableSourceRefs?: SourceRefOption[];
};

const sourceOptionIndexes = new WeakMap<SourceRefOption[], Map<string, SourceRefOption>>();
const tableOptionIndexes = new WeakMap<SourceTableOption[], Map<string, SourceTableOption>>();
const sourceOption = (values: SourceRefOption[] | undefined, key: string) => {
    if (!values) return undefined;
    let index = sourceOptionIndexes.get(values);
    if (!index) { index = new Map(values.map(item => [item.value, item])); sourceOptionIndexes.set(values, index) }
    return index.get(key)
};
const tableOption = (values: SourceTableOption[] | undefined, key: string) => {
    if (!values) return undefined;
    let index = tableOptionIndexes.get(values);
    if (!index) { index = new Map(values.map(item => [item.table_id, item])); tableOptionIndexes.set(values, index) }
    return index.get(key)
};

function TraceSourceLinks({targetId, links, onSource, inline = false, editing, binding, onEditSources, drafts, availableSourceRefs, annotation}: {
    targetId?: string;
    links: TraceLink[];
    onSource: (link: TraceLink) => void;
    inline?: boolean; editing?: boolean; binding?: Phase2EditBinding; onEditSources?: (binding: Phase2EditBinding) => void;
    drafts?: Record<string, unknown>; availableSourceRefs?: SourceRefOption[]; annotation?: RequirementDiffAnnotation
}) {
    if (!targetId && !(editing && binding)) return null;
    const values = [...new Map(links.filter(link => link.targetNodeId === targetId)
        .map(link => [link.sourceNodeId, link])).values()];
    const hasDraft = Boolean(editing && binding && Object.prototype.hasOwnProperty.call(drafts || {}, binding.edit_key));
    const draftRefs = hasDraft ? (drafts?.[binding!.edit_key] as string[] || []) : undefined;
    const diffRefs = annotation?.sourceRefs;
    if (!values.length && !hasDraft && !diffRefs?.length && !annotation?.changedFields?.includes("sourceRefs") && !(editing && binding)) return null;
    const Wrapper = inline ? "span" : "div";
    const openEditor = () => editing && binding && onEditSources?.(binding);
    const counterpart = new Set(annotation?.counterpartSourceRefs || []);
    const linkByRef = new Map(values.map(link => [link.sourceNode.sourceRef, link]));
    const diffColor = (sourceRef: string) => counterpart.has(sourceRef) ? "blue" : annotation?.side === "before" ? "red" : "green";
    return <Wrapper className={inline ? "trace-source-links trace-source-links-inline" : "trace-source-links trace-source-links-block"}>
        <span className={`trace-source-label${editing && binding ? " phase2-editable-source" : ""}`} onClick={openEditor}>追溯来源：</span>
        {hasDraft ? draftRefs!.map(sourceRef => {
            const option = sourceOption(availableSourceRefs, sourceRef);
            return <Tag color="blue" key={sourceRef} className="phase2-editable-source" onClick={openEditor}>
                {option ? `${option.document_name} ${option.number || option.title}` : sourceRef}
            </Tag>
        }) : diffRefs ? diffRefs.map(sourceRef => {
            const link = linkByRef.get(sourceRef), changed = !counterpart.has(sourceRef);
            return <Tag color={diffColor(sourceRef)} key={sourceRef} className={changed ? annotation?.side === "before" ? "diff-trace-delete" : "diff-trace-insert" : undefined}>
                {link ? `${link.sourceNode.document?.name?.replace(/\.docx$/i, "") || ""} ${link.sourceNode.number || link.sourceNode.title}`.trim() : sourceRef}
                {changed ? `（${annotation?.side === "before" ? "删除" : "新增"}）` : ""}
            </Tag>
        }) : values.map(link => <Tag color="blue" key={link.id} className={editing && binding ? "phase2-editable-source" : ""} onClick={() => editing && binding && onEditSources ? onEditSources(binding) : onSource(link)}>
            {link.sourceNode.document?.name.replace(/\.docx$/i, "")} {link.sourceNode.number || link.sourceNode.title}
        </Tag>)}
        {diffRefs?.length === 0 && annotation?.changedFields?.includes("sourceRefs") && <Tag>无</Tag>}
    </Wrapper>
}

const resizeQueue = new Set<() => void>();
let resizeFrame: number | undefined;
const queueResize = (callback: () => void) => {
    resizeQueue.add(callback);
    if (resizeFrame !== undefined) return;
    resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = undefined;
        const callbacks = [...resizeQueue];
        resizeQueue.clear();
        callbacks.forEach(item => item());
    });
};

let measurementCanvas: HTMLCanvasElement | undefined;
const measureTextWidth = (value: string, font: string, letterSpacing: string) => {
    measurementCanvas ??= document.createElement("canvas");
    const context = measurementCanvas.getContext("2d");
    if (!context) return 80;
    context.font = font;
    const spacing = Number.parseFloat(letterSpacing) || 0;
    return Math.max(...(value || "　").split("\n").map(line => context.measureText(line || "　").width + Math.max(line.length - 1, 0) * spacing));
};

function AutoSizeInlineEditor({value, tableCell, onChange, onBlur, autoFocus}: {
    value: string;
    tableCell?: boolean;
    onChange: (value: string) => void;
    onBlur?: () => void;
    autoFocus?: boolean;
}) {
    const editorRef = useRef<HTMLTextAreaElement>(null);
    const resize = useCallback(() => {
        const editor = editorRef.current;
        if (!editor) return;
        const parent = editor.parentElement;
        const availableWidth = Math.max(parent?.clientWidth ?? editor.clientWidth, 1);
        const computed = window.getComputedStyle(editor);
        const horizontalChrome = parseFloat(computed.paddingLeft) + parseFloat(computed.paddingRight)
            + parseFloat(computed.borderLeftWidth) + parseFloat(computed.borderRightWidth);
        const verticalChrome = parseFloat(computed.paddingTop) + parseFloat(computed.paddingBottom)
            + parseFloat(computed.borderTopWidth) + parseFloat(computed.borderBottomWidth);
        const minimumWidth = Math.min(80, availableWidth);
        const measuredWidth = Math.ceil(measureTextWidth(value || editor.placeholder, computed.font, computed.letterSpacing) + horizontalChrome + 3);
        const assignedWidth = tableCell ? availableWidth : Math.min(Math.max(measuredWidth, minimumWidth), availableWidth);
        if (!tableCell) editor.style.width = `${assignedWidth}px`;
        const lineHeight = parseFloat(computed.lineHeight) || 24;
        const singleLineHeight = Math.ceil(lineHeight + verticalChrome);
        const wraps = value.includes("\n") || measuredWidth > assignedWidth + 1;
        editor.style.height = `${singleLineHeight}px`;
        if (wraps) editor.style.height = `${Math.max(singleLineHeight, editor.scrollHeight + parseFloat(computed.borderTopWidth) + parseFloat(computed.borderBottomWidth))}px`;
    }, [tableCell, value]);

    useEffect(() => {
        queueResize(resize);
        return () => { resizeQueue.delete(resize) };
    }, [resize]);

    return <textarea ref={editorRef}
                     className={`phase2-inline-editor${tableCell ? " phase2-inline-editor-table-cell" : ""}`}
                     rows={1} wrap="soft" value={value} aria-label="可编辑文档内容"
                     autoFocus={autoFocus} onBlur={onBlur}
                     onChange={event => onChange(event.target.value)}/>;
}

function editKeyField(editKey: string) {
    try {
        const normalized = editKey.replace(/-/g, "+").replace(/_/g, "/"), padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
        const bytes = Uint8Array.from(atob(padded), character => character.charCodeAt(0));
        return String(JSON.parse(new TextDecoder().decode(bytes)).field || "")
    } catch { return "" }
}

function bindingField(binding: Phase2EditBinding) {
    return binding.field || editKeyField(binding.edit_key)
}

function bindingChanged(binding: Phase2EditBinding, annotation?: RequirementDiffAnnotation) {
    const field = bindingField(binding), bindingPath = `content.${field}`;
    return Boolean(field && annotation?.leafChanges?.some(change => change.path === bindingPath || change.path.startsWith(`${bindingPath}.`) || change.path.startsWith(`${bindingPath}[`)))
}

function EditablePart({part, editing, drafts, onDraft, tableCell, annotation}: {part: Phase2TextPart; editing?: boolean; drafts?: Record<string, unknown>; onDraft?: Props["onDraft"]; tableCell?: boolean; annotation?: RequirementDiffAnnotation}) {
    const [active, setActive] = useState(false);
    if (!part.editable) return <>{part.text}</>;
    if (!editing || !onDraft) return bindingChanged(part.binding, annotation)
        ? <span data-diff-field={bindingField(part.binding)} className={annotation?.side === "before" ? "diff-text-delete" : "diff-text-insert"}>{part.text}</span>
        : <>{part.text}</>;
    const binding = part.binding, draft = drafts?.[binding.edit_key] ?? binding.value;
    const value = Array.isArray(draft) ? draft.join("、") : String(draft ?? "");
    if (!active) return <span className="phase2-inline-edit-trigger" role="button" tabIndex={0}
        onClick={() => setActive(true)} onKeyDown={event => {
            if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setActive(true) }
        }}>{value || "　"}</span>;
    if (binding.options?.length) return <Select autoFocus value={value || undefined} style={{minWidth: 180}}
        options={binding.options.map(option => ({value: option, label: option}))}
        onChange={nextValue => onDraft(binding, nextValue)} onBlur={() => setActive(false)}/>;
    return <AutoSizeInlineEditor tableCell={tableCell} value={value} autoFocus onBlur={() => setActive(false)}
        onChange={nextValue => onDraft(binding,
            Array.isArray(binding.value) ? nextValue.split(/[、,，]/u).map(item => item.trim()).filter(Boolean) : nextValue)}/>;
}

const renderParts = (parts: Phase2TextPart[] | undefined, fallback: string | undefined, props: Pick<Props, "editing" | "drafts" | "onDraft"> & {annotation?: RequirementDiffAnnotation}) =>
    parts?.length ? parts.map((part, index) => <EditablePart key={index} part={part} {...props}/>) : fallback;

function blockBindings(block: Phase2Block) {
    return [
        ...(block.parts || []).filter((part): part is Extract<Phase2TextPart, {editable: true}> => Boolean(part.editable)).map(part => part.binding),
        ...(block.captionParts || []).filter((part): part is Extract<Phase2TextPart, {editable: true}> => Boolean(part.editable)).map(part => part.binding),
        ...(block.itemBindings || []).filter((item): item is Phase2EditBinding => Boolean(item)),
        ...(block.headerBindings || []).filter((item): item is Phase2EditBinding => Boolean(item)),
        ...(block.cellBindings || []).flat().filter((item): item is Phase2EditBinding => Boolean(item)),
        ...(block.sourceBinding ? [block.sourceBinding] : [])
    ]
}

const draftKey = (kind: string) => `${kind}-${typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`}`;
const numericSuffix = (value: string | undefined) => {
    const normalized = String(value || "").trim();
    if (/^\d*$/u.test(normalized)) return normalized;
    return normalized.match(/(\d+)$/u)?.[1] || ""
};
const requirementPrefix = (value: string) => `${value.replace(/-+$/u, "")}-`;

function DiffText({annotation, businessId}: {annotation: RequirementDiffAnnotation; businessId?: string}) {
    const visible = (annotation.segments || []).filter(segment => segment.type === "EQUAL" || annotation.side === "before" && segment.type === "DELETE" || annotation.side === "after" && segment.type === "INSERT");
    return <>{businessId && <><span className={annotation.type === "RENUMBERED" ? `diff-text-${annotation.side}` : undefined}>{businessId}</span>： </>}
        {visible.map((segment, index) => <span key={index} className={segment.type === "DELETE" ? "diff-text-delete" : segment.type === "INSERT" ? "diff-text-insert" : undefined}>{segment.text}</span>)}</>
}

function Block({block, links, activeId, mode = "review", annotation, diffAnnotationsByNode, selectedEntityUid, reviewScores, onSource, onEvaluate, editing, drafts, onDraft, onEditSources, onEditTables, tableOperations, onTableOperation, requirementOperations, onRequirementOperation, referenceOperations, onReferenceOperation, onEditActivityEnd, readOnly, evaluationDisabled, availableTables, availableSourceRefs, chapterWarning}: {
    block: Phase2Block;
    links: TraceLink[];
    activeId?: string;
    mode?: Props["mode"];
    annotation?: RequirementDiffAnnotation;
    diffAnnotationsByNode?: Map<string, RequirementDiffAnnotation>;
    selectedEntityUid?: string;
    reviewScores?: Record<string, number>;
    onSource: Props["onSource"];
    onEvaluate: Props["onEvaluate"]
    editing?: boolean; drafts?: Record<string, unknown>; onDraft?: Props["onDraft"]; onEditSources?: Props["onEditSources"];
    onEditTables?: Props["onEditTables"]; tableOperations?: Phase2TableOperation[]; onTableOperation?: Props["onTableOperation"];
    requirementOperations?: Phase2RequirementOperation[]; onRequirementOperation?: Props["onRequirementOperation"];
    referenceOperations?: Phase2ReferenceOperation[]; onReferenceOperation?: Props["onReferenceOperation"];
    onEditActivityEnd?: Props["onEditActivityEnd"];
    readOnly?: boolean;
    evaluationDisabled?: boolean;
    availableTables?: SourceTableOption[];
    availableSourceRefs?: SourceRefOption[];
    chapterWarning?: ChapterWarningPresentation;
}) {
    const [requirementModalOpen, setRequirementModalOpen] = useState(false);
    const [newRequirement, setNewRequirement] = useState({content: "", related: "", suffix: "", sourceRefs: [] as string[]});
    const [editingRequirementDraftKey, setEditingRequirementDraftKey] = useState<string>();
    const [referenceModal, setReferenceModal] = useState<{draftKey?: string; originalId?: string; documentId: string; documentTitle: string}>();
    const functionalRequirement = block.requirementBinding?.mode === "functional";
    const resetRequirementForm = () => {
        setNewRequirement({content: "", related: "", suffix: "", sourceRefs: []});
        setEditingRequirementDraftKey(undefined)
    };
    const openNewRequirement = () => {
        resetRequirementForm();
        setRequirementModalOpen(true)
    };
    const openRequirementEditor = (operation: Phase2RequirementOperation) => {
        setNewRequirement({
            content: operation.initial_value?.content || operation.initial_value?.description || "",
            related: operation.initial_value?.related_description || "",
            suffix: numericSuffix(operation.requested_suffix),
            sourceRefs: [...(operation.initial_value?.source_refs || [])],
        });
        setEditingRequirementDraftKey(operation.draft_key);
        setRequirementModalOpen(true)
    };
    const closeRequirementEditor = () => {
        setRequirementModalOpen(false);
        resetRequirementForm();
        onEditActivityEnd?.()
    };
    const submitRequirement = () => {
        if (!block.requirementBinding) return;
        onRequirementOperation?.({container_key: block.requirementBinding.container_key, operation: "add_requirement",
            draft_key: editingRequirementDraftKey || draftKey("requirement"),
            requested_suffix: numericSuffix(newRequirement.suffix) || undefined,
            initial_value: functionalRequirement
                ? {content: newRequirement.content.trim(), source_refs: newRequirement.sourceRefs}
                : {description: newRequirement.content.trim(), related_description: newRequirement.related.trim(), source_refs: newRequirement.sourceRefs}});
        closeRequirementEditor()
    };
    const addRow = () => {
        const columns = block.tableBinding?.new_row_columns || block.columns || [];
        onTableOperation?.({container_key: block.tableBinding!.container_key, operation: "add_row",
            draft_key: draftKey("row"), initial_value: columns.map(() => "")})
    };
    const addColumn = () => {
        onTableOperation?.({container_key: block.tableBinding!.container_key, operation: "add_column",
            draft_key: draftKey("column"), initial_value: {title: "", values: (block.rows || []).map(() => "")}})
    };
    const anchorId = block.anchorId || annotation?.nodeId;
    const anchorProps = anchorId ? {
        ...(block.anchorId ? {id: `requirement-${block.anchorId}`} : {}),
        "data-requirement-id": anchorId,
        ...(annotation ? {"data-diff-anchor": `entity-${annotation.entityUid}`, "data-entity-uid": annotation.entityUid} : {})
    } : {};
    const active = mode === "review" && block.anchorId === activeId ? " phase2-target-highlight" : annotation?.entityUid === selectedEntityUid ? " diff-target-selected" : "";
    const diffClass = annotation?.nodeType === "requirement"
        ? ` diff-target diff-target-${annotation.type.toLowerCase()} diff-side-${annotation.side}`
        : annotation ? " diff-target" : "";
    const pendingRequirementDelete = Boolean(block.requirementKey && (requirementOperations || []).some(item =>
        item.operation === "delete_requirement" && item.requirement_key === block.requirementKey));
    if (block.type === "error") return <Alert type="error" showIcon message={block.text}/>;
    if (block.type === "reference_list") {
        const containerKey = block.referenceBinding?.container_key;
        const operations = (referenceOperations || []).filter(item => item.container_key === containerKey);
        const deleted = new Set(operations.filter(item => item.operation === "delete_reference").map(item => item.reference_key?.toLocaleUpperCase()));
        const updates = new Map(operations.filter(item => item.operation === "update_reference").map(item => [item.reference_key?.toLocaleUpperCase(), item]));
        type DisplayReference = NonNullable<Phase2Block["references"]>[number] & {pending?: boolean; originalId?: string; draftKey?: string};
        const existing: DisplayReference[] = (block.references || []).filter(item => !deleted.has(item.document_id.toLocaleUpperCase())).map(item => {
            const update = updates.get(item.document_id.toLocaleUpperCase());
            return update?.initial_value ? {...item, ...update.initial_value, pending: true, originalId: item.document_id, draftKey: update.draft_key} : {...item, originalId: item.document_id}
        });
        const added: DisplayReference[] = operations.filter(item => item.operation === "add_reference" && item.initial_value).map(item => ({
            ...item.initial_value!, management: "project" as const, pending: true, originalId: undefined, draftKey: item.draft_key
        }));
        const display = [...existing, ...added];
        const referenceLeaf = annotation?.leafChanges?.find(item => item.path === "content.references");
        const sideReferences = Array.isArray(annotation?.side === "before" ? referenceLeaf?.before : referenceLeaf?.after)
            ? (annotation?.side === "before" ? referenceLeaf?.before : referenceLeaf?.after) as {document_id?: string; document_title?: string}[] : [];
        const counterpartReferences = Array.isArray(annotation?.side === "before" ? referenceLeaf?.after : referenceLeaf?.before)
            ? (annotation?.side === "before" ? referenceLeaf?.after : referenceLeaf?.before) as {document_id?: string; document_title?: string}[] : [];
        const counterpartById = new Map(counterpartReferences.map(item => [String(item.document_id || "").trim().toLocaleUpperCase(), item]));
        const referenceDiff = (item: DisplayReference) => {
            if (!referenceLeaf || !sideReferences.some(value => String(value.document_id || "").trim().toLocaleUpperCase() === item.document_id.trim().toLocaleUpperCase())) return undefined;
            const counterpart = counterpartById.get(item.document_id.trim().toLocaleUpperCase());
            if (!counterpart) return annotation?.side === "before" ? "delete" : "insert";
            return String(counterpart.document_title || "") !== item.document_title ? "modify" : undefined
        };
        const referenceIdConflict = Boolean(referenceModal?.documentId.trim() && display.some(item =>
            item.document_id.trim().toLocaleUpperCase() === referenceModal.documentId.trim().toLocaleUpperCase()
            && item.originalId !== referenceModal.originalId && item.draftKey !== referenceModal.draftKey));
        const close = () => { setReferenceModal(undefined); onEditActivityEnd?.() };
        const submit = () => {
            if (!containerKey || !referenceModal?.documentId.trim() || !referenceModal.documentTitle.trim()) return;
            onReferenceOperation?.({container_key: containerKey,
                operation: referenceModal.originalId ? "update_reference" : "add_reference",
                reference_key: referenceModal.originalId,
                draft_key: referenceModal.draftKey || draftKey("reference"),
                initial_value: {document_id: referenceModal.documentId.trim(), document_title: referenceModal.documentTitle.trim()}});
            close()
        };
        return <div className="phase2-reference-list">
            {display.map((item, index) => { const diff = referenceDiff(item); return <div className={`phase2-reference-row${item.pending ? " phase2-reference-pending" : ""}${diff ? ` diff-reference-${diff}` : ""}`} key={item.draftKey || item.originalId || `${item.document_id}-${index}`}>
                <span className="phase2-reference-id">{item.document_id}</span><span className="phase2-reference-title">{item.document_title}</span>
                {diff && <Tag color={diff === "delete" ? "red" : diff === "insert" ? "green" : "blue"}>{diff === "delete" ? "删除" : diff === "insert" ? "新增" : "修改"}</Tag>}
                {editing && item.management === "fixed" && <Tag className="phase2-reference-kind">固定</Tag>}
                {editing && item.management === "automatic" && <Tag className="phase2-reference-kind">自动维护</Tag>}
                {editing && item.management === "project" && <span className="phase2-reference-actions">
                    <Button type="text" size="small" icon={<EditOutlined/>} onClick={() => setReferenceModal({draftKey: item.draftKey, originalId: item.originalId, documentId: item.document_id, documentTitle: item.document_title})}>编辑</Button>
                    <Popconfirm title={item.originalId ? "确认删除此引用文档？" : "确认撤销新增？"} okText="确认" cancelText="取消" onConfirm={() => onReferenceOperation?.({container_key: containerKey!, operation: item.originalId ? "delete_reference" : "add_reference", reference_key: item.originalId, draft_key: item.draftKey})}>
                        <Button type="text" danger size="small" icon={<DeleteOutlined/>}>{item.originalId ? "删除" : "撤销"}</Button>
                    </Popconfirm>
                </span>}
            </div>})}
            {editing && containerKey && <div className="phase2-reference-add"><Button size="small" icon={<PlusOutlined/>} onClick={() => setReferenceModal({documentId: "", documentTitle: ""})}>新增引用文档</Button></div>}
            <Modal title={referenceModal?.originalId ? "编辑引用文档" : "新增引用文档"} open={Boolean(referenceModal)} okText="加入修改" cancelText="取消"
                okButtonProps={{disabled: !referenceModal?.documentId.trim() || !referenceModal?.documentTitle.trim() || referenceIdConflict}} onOk={submit} onCancel={close} destroyOnHidden>
                <div className="phase2-reference-form"><Input value={referenceModal?.documentId} placeholder="文档标识" onChange={event => setReferenceModal(current => current && ({...current, documentId: event.target.value}))}/>
                    <Input value={referenceModal?.documentTitle} placeholder="文档名称" onChange={event => setReferenceModal(current => current && ({...current, documentTitle: event.target.value}))}/></div>
                {referenceIdConflict && <Alert type="error" showIcon message="文档标识已存在，请使用不同的标识"/>}
            </Modal>
        </div>
    }
    if (block.type === "requirement_actions") {
        if (!editing || !block.requirementBinding?.allow_add) return null;
        const pending = (requirementOperations || []).filter(item => item.container_key === block.requirementBinding?.container_key && item.operation === "add_requirement");
        return <>
            <div className="phase2-requirement-actions"><Button size="small" icon={<PlusOutlined/>} onClick={openNewRequirement}>
                新增 TR{block.requirementBinding.interface_label ? `（${block.requirementBinding.interface_label}）` : ""}
            </Button>{pending.length > 0 && <Tag color="orange">待新增 {pending.length} 项</Tag>}</div>
            {pending.map((operation, index) => <div className="phase2-pending-requirement" key={operation.draft_key || index}>
                <div className="phase2-pending-requirement-title">
                    <Tag color="green">待新增</Tag>
                    <span>{functionalRequirement ? `${requirementPrefix(block.requirementBinding!.prefix)}${numericSuffix(operation.requested_suffix) || "自动编号"}` : "TR编号保存后分配"}</span>
                    <Button type="text" size="small" icon={<EditOutlined/>} onClick={() => openRequirementEditor(operation)}>编辑</Button>
                    <Button type="text" danger size="small" icon={<DeleteOutlined/>}
                        onClick={() => onRequirementOperation?.({...operation, initial_value: undefined})}>撤销新增</Button>
                </div>
                <div>{operation.initial_value?.content || operation.initial_value?.description}</div>
                {operation.initial_value?.related_description && <div className="phase2-pending-requirement-related">相关说明：{operation.initial_value.related_description}</div>}
                <div className="trace-source-links trace-source-links-block phase2-pending-requirement-sources">
                    <span className="trace-source-label">追溯来源：</span>
                    {(operation.initial_value?.source_refs || []).map(sourceRef => {
                        const option = sourceOption(availableSourceRefs, sourceRef);
                        return <Tag color="blue" key={sourceRef}>{option ? `${option.document_name} ${option.number || option.title}` : sourceRef}</Tag>
                    })}
                </div>
            </div>)}
            <Modal title={`${editingRequirementDraftKey ? "编辑待新增" : "新增"}${block.requirementBinding.interface_label ? `${block.requirementBinding.interface_label} ` : ""}TR`}
                open={requirementModalOpen} width={680} okText="加入修改" cancelText="取消"
                okButtonProps={{disabled: !newRequirement.content.trim() || !functionalRequirement && !newRequirement.related.trim()}}
                onOk={submitRequirement} onCancel={closeRequirementEditor} destroyOnHidden>
                <div className="phase2-new-requirement-form">
                    {functionalRequirement && <Input addonBefore={requirementPrefix(block.requirementBinding.prefix)} value={newRequirement.suffix}
                        inputMode="numeric" placeholder="数字序号（可留空自动分配）"
                        onChange={event => setNewRequirement(current => ({...current, suffix: numericSuffix(event.target.value)}))}/>}
                    <Input.TextArea value={newRequirement.content} autoSize={{minRows: 3}}
                        placeholder={functionalRequirement ? "处理内容" : "测试需求描述"}
                        onChange={event => setNewRequirement(current => ({...current, content: event.target.value}))}/>
                    {!functionalRequirement && (block.requirementBinding.related_description_options?.length
                        ? <Select value={newRequirement.related || undefined} style={{width: "100%"}} placeholder="选择相关说明"
                            options={block.requirementBinding.related_description_options.map(value => ({value, label: value}))}
                            onChange={related => setNewRequirement(current => ({...current, related}))}/>
                        : <Input.TextArea value={newRequirement.related} autoSize={{minRows: 2}} placeholder="相关说明"
                            onChange={event => setNewRequirement(current => ({...current, related: event.target.value}))}/>) }
                    <Select mode="multiple" value={newRequirement.sourceRefs} style={{width: "100%"}}
                        placeholder="选择追溯来源（可选）"
                        options={(availableSourceRefs || []).map(option => ({value: option.value, label: `${option.document_name} ${option.number || option.title}`}))}
                        onChange={sourceRefs => setNewRequirement(current => ({...current, sourceRefs}))}/>
                </div>
            </Modal>
        </>
    }
    if (block.type === "table_selector") {
        if (!editing || !block.selectionBinding) return null;
        const hasDraft = Object.prototype.hasOwnProperty.call(drafts || {}, block.selectionBinding.edit_key);
        const selectedIds = (drafts?.[block.selectionBinding.edit_key] ?? block.selectionBinding.value) as string[];
        const selectionRole = block.selectionRole || "引用";
        return <div className={`phase2-table-selector phase2-table-selector-${selectionRole === "概述" ? "overview" : selectionRole === "输入流" ? "input" : "output"}`}>
            <div className="phase2-table-selector-summary">
                <span className="phase2-table-selector-role">{selectionRole}表格</span>
                <span className="phase2-table-selector-description">{block.text}</span>
                <span className="phase2-table-selector-count">已选择 {selectedIds.length} 张</span>
                <Button size="small" icon={<PlusOutlined/>} onClick={() => onEditTables?.(block.selectionBinding!)}>选择{selectionRole}表格</Button>
            </div>
            {hasDraft && <SortableTableList ids={selectedIds} className="phase2-inline-table-sort-list"
                onChange={values => onDraft?.(block.selectionBinding!, values)}>
                {tableId => {
                    const option = tableOption(availableTables, tableId);
                    return option ? <div className="phase2-source-table-preview phase2-source-table-inline-preview">
                        <div className="phase2-table-caption">{option.title || option.table_id}</div>
                        <div dangerouslySetInnerHTML={{__html: option.table_html}}/>
                    </div> : <Alert type="warning" showIcon message={`未找到引用表格：${tableId}`}/>
                }}
            </SortableTableList>}
        </div>;
    }
    if (editing && block.selectionEditKey && Object.prototype.hasOwnProperty.call(drafts || {}, block.selectionEditKey)) return null;
    if (block.type === "heading") {
        const headingName = `h${Math.min(Math.max(block.level || 1, 1), 5)}`;
        return <section {...anchorProps} className={`phase2-heading-block${active}${diffClass}`}>
            <div className="phase2-heading-line"><div className="phase2-heading-title">
                {createElement(headingName, null, renderParts(block.parts, block.text, {editing, drafts, onDraft, annotation}))}
                {chapterWarning && <Tooltip overlayClassName="phase2-warning-tooltip" title={<div className="phase2-warning-tooltip-content">
                    {chapterWarning.warnings.length > 0 && <div className="phase2-warning-tooltip-section"><strong>本章已容错完成</strong>
                        <div>跳过操作数：{chapterWarning.skippedCount}</div>
                        <ul>{chapterWarning.warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}</ul></div>}
                    {(chapterWarning.openQuestions.length > 0 || chapterWarning.openQuestionGroups.length > 0) && <div className="phase2-warning-tooltip-section"><strong>待确认问题</strong>
                        {chapterWarning.openQuestions.length > 0 && <ul>{chapterWarning.openQuestions.map((question, index) => <li key={`${question}-${index}`}>{question}</li>)}</ul>}
                        {chapterWarning.openQuestionGroups.map(group => <div className="phase2-open-question-group" key={group.title}>
                            <b>{group.title}</b>
                            <ul>{group.questions.map((question, index) => <li key={`${question}-${index}`}>{question}</li>)}</ul>
                        </div>)}</div>}
                </div>}>
                    <span className="phase2-warning-help" tabIndex={0} role="img" aria-label="查看警告和待确认问题"><QuestionCircleOutlined/></span>
                </Tooltip>}
            </div>
                <div className="phase2-heading-actions">{mode === "review" && block.evaluable && block.anchorId &&
                    <Button type="primary" icon={<AuditOutlined/>} className="evaluation-trigger"
                            disabled={readOnly || evaluationDisabled} onClick={() => onEvaluate(block.anchorId!)}>
                        内容质量评估{reviewScores?.[block.anchorId] !== undefined ? ` · 已评 ${reviewScores[block.anchorId].toFixed(2)}` : ""}
                    </Button>}</div></div>
            <TraceSourceLinks targetId={block.anchorId} links={links} onSource={onSource} editing={editing} binding={block.sourceBinding} onEditSources={onEditSources} drafts={drafts} availableSourceRefs={availableSourceRefs} annotation={annotation}/>
        </section>
    }
    if (block.type === "paragraph") return <div {...anchorProps} className={`phase2-paragraph${active}${diffClass}${pendingRequirementDelete ? " phase2-requirement-pending-delete" : ""}`}>
        <p>{annotation && block.businessId && annotation.nodeType === "requirement" ? <DiffText annotation={annotation} businessId={block.businessId}/> : renderParts(block.parts, block.text, {editing: editing && !pendingRequirementDelete, drafts, onDraft, annotation})}<TraceSourceLinks targetId={block.anchorId} links={links} onSource={onSource} inline editing={editing && !pendingRequirementDelete} binding={block.sourceBinding} onEditSources={onEditSources} drafts={drafts} availableSourceRefs={availableSourceRefs} annotation={annotation}/>
            {editing && block.requirementKey && block.requirementBinding && <Button className="phase2-requirement-delete" type="text" danger size="small" icon={<DeleteOutlined/>}
                onClick={() => onRequirementOperation?.({container_key: block.requirementBinding!.container_key, operation: "delete_requirement", requirement_key: block.requirementKey})}>{pendingRequirementDelete ? "撤销删除" : "删除 TR"}</Button>}</p></div>;
    if (block.type === "list") return <div className="phase2-list">{block.items?.map((item, index) => <p
        key={`${item}-${index}`}>{block.itemBindings?.[index] ? <EditablePart part={{text: item, editable: true, binding: block.itemBindings[index]!}} editing={editing} drafts={drafts} onDraft={onDraft} annotation={annotation}/> : item}</p>)}</div>;
    if (block.cells?.length) return <div {...anchorProps} className={`phase2-table-wrap${active}${diffClass}`}>
        <div className="phase2-table-caption">{renderParts(block.captionParts, block.caption, {editing, drafts, onDraft, annotation})}</div>
        <table className="phase2-table">
            <tbody>{block.cells.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => {
                const Cell = rowIndex === 0 ? "th" : "td";
                return <Cell key={cellIndex} colSpan={cell.colSpan} rowSpan={cell.rowSpan}>{cell.text}</Cell>
            })}</tr>)}</tbody>
        </table>
    </div>;
    const relevantOperations = (tableOperations || []).filter(item => item.container_key === block.tableBinding?.container_key);
    const tableField = block.tableBinding ? editKeyField(block.tableBinding.container_key) : "";
    const tableChange = annotation?.tableChanges?.find(change => change.path === `content.${tableField}`);
    const structuralColumns = new Set((annotation?.side === "before" ? tableChange?.deletedColumns : tableChange?.addedColumns)?.map(item => item.index) || []);
    const structuralRows = new Set((annotation?.side === "before" ? tableChange?.deletedRows : tableChange?.addedRows)?.map(item => item.index) || []);
    const structuralLabel = annotation?.side === "before" ? "删除" : "新增";
    const pendingDeleteColumns = new Set(relevantOperations.filter(item => item.operation === "delete_column").map(item => item.column_key));
    const pendingDeleteRows = new Set(relevantOperations.filter(item => item.operation === "delete_row").map(item => item.row_key));
    const addedColumns = relevantOperations.filter(item => item.operation === "add_column");
    const addedRows = relevantOperations.filter(item => item.operation === "add_row");
    const addedColumnDraft = (operation: Phase2TableOperation) => {
        const value = operation.initial_value;
        if (value && typeof value === "object" && !Array.isArray(value) && "title" in value && "values" in value) {
            return {title: String(value.title || ""), values: Array.isArray(value.values) ? value.values.map(String) : []}
        }
        return {title: typeof value === "string" ? value : "", values: [] as string[]}
    };
    const displayColumns = [...(block.columns || []), ...addedColumns.map(item => addedColumnDraft(item).title)];
    const displayRows = [...(block.rows || []).map((row, rowIndex) => [...row, ...addedColumns.map(operation => addedColumnDraft(operation).values[rowIndex] || "")]),
        ...addedRows.map(item => {
            const values = Array.isArray(item.initial_value) ? item.initial_value.map(value => String(value ?? "")) : [];
            return [...values, ...Array(Math.max(0, displayColumns.length - values.length)).fill("")].slice(0, displayColumns.length)
        })];
    return <div {...anchorProps} data-diff-table-path={tableChange?.path} className={`phase2-table-wrap${active}${diffClass}`}>
        <div className="phase2-table-caption">{renderParts(block.captionParts, block.caption, {editing, drafts, onDraft, annotation})}</div>
        <table className="phase2-table">
            <thead>
            <tr>{displayColumns.map((column, columnIndex) => {
                const addedColumn = addedColumns[columnIndex - (block.columns?.length || 0)];
                return <th key={addedColumn?.draft_key || `${column}-${columnIndex}`} className={`${pendingDeleteColumns.has(block.tableBinding?.column_keys[columnIndex]) ? "phase2-table-pending-delete " : ""}${structuralColumns.has(columnIndex) ? annotation?.side === "before" ? "diff-structure-delete" : "diff-structure-insert" : ""}`.trim() || undefined}>
                {structuralColumns.has(columnIndex) && <span className="diff-structure-label">{structuralLabel}列</span>}
                {addedColumn ? <AutoSizeInlineEditor tableCell value={column} onChange={value => {
                    const draft = addedColumnDraft(addedColumn);
                    onTableOperation?.({...addedColumn, initial_value: {...draft, title: value}})
                }}/>
                    : block.headerBindings?.[columnIndex] ? <EditablePart part={{text: column, editable: true, binding: block.headerBindings[columnIndex]!}} editing={editing} drafts={drafts} onDraft={onDraft} tableCell annotation={annotation}/> : column}
                {addedColumn && (
                    <Button className="phase2-table-structure-action" type="text" danger size="small" title="撤销新增列" icon={<DeleteOutlined/>}
                        onClick={() => onTableOperation?.({...addedColumn, initial_value: undefined})}/>
                )}
                {editing && block.tableBinding?.allow_delete_column && block.tableBinding.column_keys[columnIndex] && <Button className="phase2-table-structure-action" type="text" danger size="small" icon={<DeleteOutlined/>}
                    onClick={() => onTableOperation?.({container_key: block.tableBinding!.container_key, operation: "delete_column", column_key: block.tableBinding!.column_keys[columnIndex]})}/>}</th>
            })}
                {editing && block.tableBinding?.allow_add_column && <th className="phase2-table-add-column"><Button size="small" icon={<PlusOutlined/>}
                    onClick={addColumn}>新增列</Button></th>}</tr>
            </thead>
            <tbody>{displayRows.map((row, rowIndex) => {
                const rowId = block.rowAnchorIds?.[rowIndex];
                const pendingDelete = pendingDeleteRows.has(block.tableBinding?.row_keys[rowIndex]);
                const added = rowIndex >= (block.rows?.length || 0);
                const addedRow = added ? addedRows[rowIndex - (block.rows?.length || 0)] : undefined;
                const requirementKey = block.rowRequirementKeys?.[rowIndex];
                const requirementPendingDelete = Boolean(requirementKey && (requirementOperations || []).some(item =>
                    item.operation === "delete_requirement" && item.requirement_key === requirementKey));
                const rowAnnotation = diffAnnotationsByNode?.get(rowId || "");
                const rowActive = mode === "review" && rowId === activeId ? "phase2-target-highlight " : rowAnnotation?.entityUid === selectedEntityUid ? "diff-target-selected " : "";
                const rowDiff = rowAnnotation ? `diff-target diff-target-${rowAnnotation.type.toLowerCase()} diff-side-${rowAnnotation.side} ` : "";
                return <tr key={rowIndex} id={rowId ? `requirement-${rowId}` : undefined} data-requirement-id={rowId} data-diff-anchor={rowAnnotation ? `entity-${rowAnnotation.entityUid}` : undefined} data-entity-uid={rowAnnotation?.entityUid}
                           className={`${rowActive}${rowDiff}${pendingDelete ? "phase2-table-pending-delete " : ""}${requirementPendingDelete ? "phase2-requirement-pending-delete " : ""}${added ? "phase2-table-pending-add " : ""}${structuralRows.has(rowIndex) ? annotation?.side === "before" ? "diff-structure-row-delete" : "diff-structure-row-insert" : ""}`.trim() || undefined}>{row.map((cell, index) => {
                    const addedColumn = !added && addedColumns[index - (block.columns?.length || 0)];
                    const columnPendingDelete = pendingDeleteColumns.has(block.tableBinding?.column_keys[index]);
                    const changedCell = rowAnnotation?.changedValues?.includes(String(cell));
                    return <td key={index} className={`${columnPendingDelete ? "phase2-table-pending-delete " : ""}${structuralColumns.has(index) ? annotation?.side === "before" ? "diff-structure-delete " : "diff-structure-insert " : ""}${changedCell ? rowAnnotation?.side === "before" ? "diff-cell-delete" : "diff-cell-insert" : ""}`.trim() || undefined}>{index === 0 && structuralRows.has(rowIndex) && <span className="diff-structure-label">{structuralLabel}行</span>}{addedRow && !columnPendingDelete ? <AutoSizeInlineEditor tableCell value={cell} onChange={value => {
                        const values = [...(Array.isArray(addedRow.initial_value) ? addedRow.initial_value.map(String) : [])];
                        while (values.length < displayColumns.length) values.push("");
                        values[index] = value;
                        onTableOperation?.({...addedRow, initial_value: values})
                    }}/> : addedColumn && !columnPendingDelete ? <AutoSizeInlineEditor tableCell value={cell} onChange={value => {
                        const draft = addedColumnDraft(addedColumn);
                        const values = [...draft.values];
                        while (values.length < (block.rows?.length || 0)) values.push("");
                        values[rowIndex] = value;
                        onTableOperation?.({...addedColumn, initial_value: {...draft, values}})
                    }}/> : block.cellBindings?.[rowIndex]?.[index] ? <EditablePart part={{text: cell, editable: true, binding: block.cellBindings[rowIndex][index]!}} editing={editing && !requirementPendingDelete && !columnPendingDelete} drafts={drafts} onDraft={onDraft} tableCell annotation={annotation}/> : cell}{index === 1 && rowId ?
                        <TraceSourceLinks targetId={rowId} links={links} onSource={onSource} inline editing={editing && !requirementPendingDelete} binding={block.rowSourceBindings?.[rowIndex]} onEditSources={onEditSources} drafts={drafts} availableSourceRefs={availableSourceRefs} annotation={rowAnnotation}/> : null}
                        {editing && !added && index === row.length - 1 && block.rowRequirementKeys?.[rowIndex] && block.requirementBinding && (
                            <Button className="phase2-table-row-delete" type="text" danger size="small" title={requirementPendingDelete ? "撤销删除" : "删除TR"} icon={<DeleteOutlined/>}
                                onClick={() => onRequirementOperation?.({container_key: block.requirementBinding!.container_key, operation: "delete_requirement", requirement_key: block.rowRequirementKeys![rowIndex]})}>{requirementPendingDelete ? "撤销" : ""}</Button>
                        )}
                        {editing && addedRow && index === row.length - 1 && <Button className="phase2-table-row-delete" type="text" danger size="small" title="撤销新增" icon={<DeleteOutlined/>}
                            onClick={() => onTableOperation?.({...addedRow, initial_value: undefined})}>撤销</Button>}
                        {editing && !added && index === row.length - 1 && !block.rowRequirementKeys?.[rowIndex] && block.tableBinding?.allow_delete_row && block.tableBinding.row_keys[rowIndex] && <Button className="phase2-table-row-delete" type="text" danger size="small" title={pendingDelete ? "撤销删除" : "删除行"} icon={<DeleteOutlined/>}
                            onClick={() => onTableOperation?.({container_key: block.tableBinding!.container_key, operation: "delete_row", row_key: block.tableBinding!.row_keys[rowIndex]})}/>}</td>
                })}</tr>
            })}</tbody>
        </table>
        {editing && block.tableBinding && <div className="phase2-table-row-actions">
            {block.tableBinding.allow_add_row && <Button size="small" icon={<PlusOutlined/>} onClick={addRow}>新增行</Button>}
            {relevantOperations.length > 0 && <Tag color="orange">结构修改待保存</Tag>}
        </div>}
    </div>
}

export function Phase2DocumentRenderer({chapters, links, activeId, mode = "review", diffAnnotations = [], selectedEntityUid, reviewScores, onSource, onEvaluate, editing, drafts, onDraft, onEditSources, onEditTables, tableOperations, onTableOperation, requirementOperations, onRequirementOperation, referenceOperations, onReferenceOperation, onEditActivityEnd, readOnly, evaluationDisabled, interactionLocked, availableTables, availableSourceRefs}: Props) {
    const documentRef = useRef<HTMLElement>(null);
    useEffect(() => {
        if (interactionLocked && documentRef.current?.contains(document.activeElement)) (document.activeElement as HTMLElement)?.blur()
    }, [interactionLocked]);
    const annotationsByNode = new Map(diffAnnotations.filter(item => item.nodeId).map(item => [item.nodeId!, item]));
    const annotationForBlock = (block: Phase2Block) => {
        if (block.type === "reference_list" && block.referenceBinding?.node_id) {
            const referenceAnnotation = annotationsByNode.get(block.referenceBinding.node_id);
            if (referenceAnnotation?.leafChanges?.some(item => item.path === "content.references")) return referenceAnnotation
        }
        const bindings = blockBindings(block);
        const tableField = block.tableBinding ? editKeyField(block.tableBinding.container_key) : "";
        const structural = tableField ? bindings.map(binding => annotationsByNode.get(binding.node_id)).find(item =>
            item?.tableChanges?.some(change => change.path === `content.${tableField}`)) : undefined;
        if (structural) return structural;
        const bound = bindings.map(binding => annotationsByNode.get(binding.node_id)).find(item => item && bindings.some(binding => binding.node_id === item.nodeId && bindingChanged(binding, item)));
        if (bound) return bound;
        const direct = block.anchorId ? annotationsByNode.get(block.anchorId) : undefined;
        return direct?.nodeType === "requirement" || direct && block.sourceBinding && direct.changedFields?.includes("sourceRefs") ? direct : undefined
    };
    return <article ref={documentRef} className={`phase2-document${interactionLocked ? " phase2-interaction-locked" : ""}`} aria-disabled={interactionLocked || undefined} {...(interactionLocked ? {inert: true} : {})}>
        <header><h1>第三方测试需求</h1></header>
        {chapters.map(chapter => <div className="phase2-chapter" data-artifact={chapter.artifact} key={chapter.artifact}>
            {chapter.blocks.map((block, index) => <Block key={`${chapter.artifact}-${index}`} block={block}
                                                         chapterWarning={chapterWarningForBlock(chapter, index)}
                                                         links={links} activeId={activeId} mode={mode} annotation={annotationForBlock(block)} diffAnnotationsByNode={annotationsByNode} selectedEntityUid={selectedEntityUid} reviewScores={reviewScores}
                                                         onSource={onSource} onEvaluate={onEvaluate} editing={editing} drafts={drafts} onDraft={onDraft} onEditSources={onEditSources} onEditTables={onEditTables} tableOperations={tableOperations} onTableOperation={onTableOperation}
                                                         requirementOperations={requirementOperations} onRequirementOperation={onRequirementOperation}
                                                         referenceOperations={referenceOperations} onReferenceOperation={onReferenceOperation}
                                                         onEditActivityEnd={onEditActivityEnd}
                                                         readOnly={readOnly} evaluationDisabled={evaluationDisabled} availableTables={availableTables} availableSourceRefs={availableSourceRefs}/>)}</div>)}
    </article>
}
