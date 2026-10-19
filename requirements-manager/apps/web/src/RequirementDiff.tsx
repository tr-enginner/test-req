import {useMemo, useRef, useState} from "react";
import {Alert, Button, Empty, Input, Select, Space, Spin, Switch, Tag} from "antd";
import {ArrowLeftOutlined, ArrowRightOutlined, DownloadOutlined, SwapOutlined} from "@ant-design/icons";
import {useQuery} from "@tanstack/react-query";
import {useNavigate, useParams} from "react-router-dom";
import {api, downloadApi, saveDownload, type Phase2Chapter, type RequirementChange, type RequirementDiff as Diff, type RequirementDiffAnnotation, type RequirementRevision, type TraceLink} from "./api";
import {Phase2DocumentRenderer} from "./Phase2DocumentRenderer";
import {revisionTime, revisionTitle} from "./revisionDisplay";
import {changeMatchesKind, diffFacetSummary} from "./diffFilters";
import {AppHeader} from "./AppHeader";

const LABEL: Record<string, string> = {ADDED: "新增", DELETED: "删除", MODIFIED: "修改", MOVED: "移动", RENUMBERED: "重编号", TRACE_CHANGED: "追溯变化", TABLE_CHANGED: "表格变化"};
const COLOR: Record<string, string> = {ADDED: "green", DELETED: "red", MODIFIED: "blue", MOVED: "purple", RENUMBERED: "magenta", TRACE_CHANGED: "orange", TABLE_CHANGED: "cyan"};
const CHAPTER_BY_ARTIFACT: Record<string, string> = {
    "chapter1-scope.json": "1 范围", "chapter2-system-overview.json": "2 系统概述", "hardware-interface-model.json": "3.1 硬件接口",
    "functional-test-content.json": "4.1 功能测试", "functional-other-content.json": "4.1 功能测试",
    "performance-test-content.json": "4.2 性能测试", "interface-test-content.json": "4.3 接口测试",
    "reliability-safety-test-content.json": "4.4 可靠性安全性测试", "margin-test-content.json": "4.5 余量测试",
    "boundary-test-content.json": "4.6 边界测试", "data-processing-test-content.json": "4.7 数据处理测试",
    "recovery-test-content.json": "4.8 恢复性测试", "strength-test-content.json": "4.9 强度测试",
    "phase2-test-traceability.json": "6 测试需求覆盖性说明"
};
const FIELD_LABEL: Record<string, string> = {businessId: "需求编号", number: "章节位置", title: "标题", parentId: "所属章节", artifact: "需求类别", content: "需求内容", sourceRefs: "追溯来源",
    document_id: "文档标识", document_version: "文档版本", software_name_and_id: "软件名称和标识", model_name: "委托单位", client_address: "委托单位地址",
    system_name: "适用系统", csci_names: "软件配置项", code_version: "代码版本", processor_type: "处理器类型", processor_frequency: "处理器主频"};
const fieldLabel = (field: string) => {
    const normalized = field.startsWith("content.") ? field.slice(8).split(".")[0].split("[")[0] : field;
    return FIELD_LABEL[field] || FIELD_LABEL[normalized] || normalized.replaceAll("_", " ")
};
const chapterLabel = (change: RequirementChange) => {
    const node = change.after || change.before;
    return node?.artifact && CHAPTER_BY_ARTIFACT[node.artifact] || change.chapterNumber || "其他变更"
};

export function RequirementDiffPage() {
    const {id = ""} = useParams(), navigate = useNavigate(), [fromId, setFromId] = useState<string>(), [toId, setToId] = useState<string>(),
        [kind, setKind] = useState<string>(), [search, setSearch] = useState(""), [onlyChanged, setOnlyChanged] = useState(true), [selectedUid, setSelectedUid] = useState<string>(),
        leftPane = useRef<HTMLElement>(null), rightPane = useRef<HTMLElement>(null), syncing = useRef(false), programmatic = useRef(false);
    const revisions = useQuery({queryKey: ["requirement-revisions", id], queryFn: () => api<RequirementRevision[]>(`/projects/${id}/requirement-revisions`)});
    const actualFrom = fromId || revisions.data?.[0]?.id, actualTo = toId || revisions.data?.at(-1)?.id;
    const diff = useQuery({queryKey: ["requirement-diff", id, actualFrom, actualTo], enabled: Boolean(actualFrom && actualTo),
        queryFn: () => api<Diff>(`/projects/${id}/requirement-diff?from=${encodeURIComponent(actualFrom!)}&to=${encodeURIComponent(actualTo!)}`)});
    const left = useQuery({queryKey: ["revision-document", id, actualFrom], enabled: Boolean(actualFrom), queryFn: () => api<{chapters: Phase2Chapter[]; links: TraceLink[]}>(`/projects/${id}/requirement-revisions/${actualFrom}/document`)});
    const right = useQuery({queryKey: ["revision-document", id, actualTo], enabled: Boolean(actualTo), queryFn: () => api<{chapters: Phase2Chapter[]; links: TraceLink[]}>(`/projects/${id}/requirement-revisions/${actualTo}/document`)});
    const visible = useMemo(() => (diff.data?.changes || []).filter(change => changeMatchesKind(change, kind) && (!search.trim() ||
        `${change.before?.businessId || ""} ${change.before?.title || ""} ${change.after?.businessId || ""} ${change.after?.title || ""}`.toLowerCase().includes(search.trim().toLowerCase()))), [diff.data, kind, search]);
    const facetSummary = useMemo(() => diffFacetSummary(diff.data?.changes || [], diff.data?.summary || {}), [diff.data]);
    const selected = visible.find(item => item.entityUid === selectedUid), selectedIndex = selected ? visible.indexOf(selected) : -1;
    const groups = useMemo(() => [...new Set(visible.map(chapterLabel))].map(chapter => ({chapter, items: visible.filter(item => chapterLabel(item) === chapter)})), [visible]);
    const options = revisions.data?.map(item => ({value: item.id, label: <div className="revision-option" title={`${revisionTitle(item)} ${revisionTime(item)}`}>
        <strong>{revisionTitle(item)}</strong><small>{revisionTime(item)}</small>
    </div>}));
    const changedArtifacts = new Set(visible.flatMap(item => [item.before?.artifact, item.after?.artifact]).filter(Boolean));
    const chapters = (value?: {chapters: Phase2Chapter[]}) => !onlyChanged || !changedArtifacts.size ? value?.chapters || [] : (value?.chapters || []).filter(chapter => changedArtifacts.has(chapter.artifact));
    const annotations = (side: "before" | "after"): RequirementDiffAnnotation[] => visible.flatMap(change => {
        const node = side === "before" ? change.before : change.after;
        const changedValues = (change.leafChanges || []).map(item => side === "before" ? item.before : item.after).filter(value => typeof value === "string" || typeof value === "number").map(String);
        const counterpart = side === "before" ? change.after : change.before;
        return node ? [{entityUid: change.entityUid, nodeId: node.id, businessId: node.businessId, nodeType: node.nodeType, type: change.type, side, segments: change.textSegments, changedFields: change.changedFields, changedValues, leafChanges: change.leafChanges, tableChanges: change.tableChanges, sourceRefs: node.sourceRefs || [], counterpartSourceRefs: counterpart?.sourceRefs || []}] : []
    });
    const scrollTarget = (pane: HTMLElement | null, change: RequirementChange, side: "before" | "after") => {
        if (!pane) return;
        const node = side === "before" ? change.before : change.after;
        const entitySelector = `[data-entity-uid="${CSS.escape(change.entityUid)}"]`;
        const tablePath = change.tableChanges?.[0]?.path;
        const changedField = change.leafChanges?.find(item => item.path.startsWith("content.") && !Array.isArray(side === "before" ? item.before : item.after))?.path.slice(8);
        let target = node && tablePath ? pane.querySelector<HTMLElement>(`${entitySelector}[data-diff-table-path="${CSS.escape(tablePath)}"]`) : null;
        if (!target && node && changedField) target = pane.querySelector<HTMLElement>(`${entitySelector} [data-diff-field="${CSS.escape(changedField)}"]`);
        if (!target && node) target = pane.querySelector<HTMLElement>(entitySelector);
        if (!target && change.parentAnchor) target = pane.querySelector<HTMLElement>(`[data-requirement-id="${CSS.escape(change.parentAnchor)}"]`);
        if (!target) {
            const artifact = side === "before" ? change.before?.artifact || change.after?.artifact : change.after?.artifact || change.before?.artifact;
            if (artifact) target = pane.querySelector<HTMLElement>(`[data-artifact="${CSS.escape(artifact)}"]`)
        }
        if (!target) return;
        const paneRect = pane.getBoundingClientRect(), targetRect = target.getBoundingClientRect();
        pane.scrollTo({top: pane.scrollTop + targetRect.top - paneRect.top - pane.clientHeight * .2, behavior: "smooth"})
    };
    const selectChange = (change: RequirementChange) => {
        setSelectedUid(change.entityUid); programmatic.current = true;
        requestAnimationFrame(() => {scrollTarget(leftPane.current, change, "before"); scrollTarget(rightPane.current, change, "after"); window.setTimeout(() => programmatic.current = false, 650)})
    };
    const navigateChange = (offset: number) => {
        if (!visible.length) return;
        const index = selectedIndex < 0 ? 0 : (selectedIndex + offset + visible.length) % visible.length;
        selectChange(visible[index])
    };
    const syncByAnchor = (source: HTMLElement, target: HTMLElement | null) => {
        if (!target || syncing.current || programmatic.current) return;
        const sourceTop = source.getBoundingClientRect().top + 90, anchors = [...source.querySelectorAll<HTMLElement>("[data-entity-uid]")];
        const anchor = anchors.filter(item => item.getBoundingClientRect().top <= sourceTop).at(-1) || anchors[0], uid = anchor?.dataset.entityUid;
        if (!uid) return;
        const counterpart = target.querySelector<HTMLElement>(`[data-entity-uid="${CSS.escape(uid)}"]`);
        if (!counterpart) return;
        syncing.current = true;
        const relative = anchor.getBoundingClientRect().top - source.getBoundingClientRect().top;
        target.scrollTop += counterpart.getBoundingClientRect().top - target.getBoundingClientRect().top - relative;
        requestAnimationFrame(() => syncing.current = false)
    };
    const download = async (revisionId?: string) => { if (!revisionId) return; const result = await downloadApi(`/projects/${id}/requirement-revisions/${revisionId}/docx`); saveDownload(result.blob, result.filename) };
    if (revisions.isLoading) return <Spin fullscreen/>;
    if (revisions.error) return <Alert type="error" message="需求版本加载失败" description={revisions.error.message}/>;
    return <div className="requirement-diff-page">
        <AppHeader backTo={`/projects/${id}/review`} backLabel="返回测试需求工作台"/>
        <section className="requirement-diff-context-bar">
            <div className="requirement-diff-title"><h1>变更分析</h1><span>第三方测试需求版本对比</span></div>
            <div className="diff-version-comparison">
                <label><span>基准版本</span><Select value={actualFrom} options={options} onChange={value => {
                    setFromId(value); setSelectedUid(undefined)
                }} className="revision-select"/></label>
                <Button type="text" className="revision-swap" aria-label="交换基准版本和对比版本"
                        icon={<SwapOutlined/>} onClick={() => {
                    setFromId(actualTo); setToId(actualFrom); setSelectedUid(undefined)
                }}/>
                <label><span>对比版本</span><Select value={actualTo} options={options} onChange={value => {
                    setToId(value); setSelectedUid(undefined)
                }} className="revision-select"/></label>
            </div>
            <Button className="diff-download-button" icon={<DownloadOutlined/>}
                    onClick={() => download(actualTo)}>下载对比版本</Button>
        </section>
        {diff.data?.from.kind === "MIGRATED_BASELINE" && <Alert type="info" showIcon message="当前基准版本为迁移基线，不一定是项目最初生成版本"/>}
        <section className="requirement-diff-toolbar"><Space wrap><Input.Search placeholder="搜索TR编号或标题" allowClear value={search} onChange={event => setSearch(event.target.value)} className="diff-search"/>
            <Select className="diff-type-select" popupMatchSelectWidth={170} allowClear placeholder="全部变更类型" value={kind} onChange={value => {setKind(value); setSelectedUid(undefined)}} options={Object.entries(LABEL).map(([value, label]) => ({value, label}))}/><span>仅显示变化章节</span><Switch checked={onlyChanged} onChange={setOnlyChanged}/>
            <Button icon={<ArrowLeftOutlined/>} disabled={!visible.length} onClick={() => navigateChange(-1)}>上一项</Button><Button icon={<ArrowRightOutlined/>} disabled={!visible.length} onClick={() => navigateChange(1)}>下一项</Button></Space></section>
        <div className="requirement-diff-body"><aside className="requirement-diff-directory"><h3>变更目录</h3><div className="diff-summary">{Object.entries(facetSummary).map(([key, count]) => count ? <Tag color={COLOR[key]} key={key}>{LABEL[key]} {count}</Tag> : null)}</div>
            {!visible.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="两个版本没有符合条件的变化"/> : groups.map(group => <section className="diff-directory-group" key={group.chapter}><h4>{group.chapter}</h4>{group.items.map(change => { const node = change.after || change.before, label = node?.nodeType === "section" ? `${node.number} ${node.title}` : node?.businessId, displayKind = kind && changeMatchesKind(change, kind) ? kind : change.type; return <button aria-pressed={selectedUid === change.entityUid} className={`diff-change-item diff-${displayKind.toLowerCase()}${selectedUid === change.entityUid ? " is-selected" : ""}`} key={`${change.entityUid}-${change.type}`} onClick={() => selectChange(change)}><Tag color={COLOR[displayKind]}>{LABEL[displayKind]}</Tag><span>{label}<small>{node?.nodeType === "section" ? "文档章节" : node?.title}</small><em>{(change.changedFields || []).map(fieldLabel).join("、") || "整条需求"}</em></span></button>})}</section>)}</aside>
            <main className="requirement-diff-documents"><section ref={leftPane} onScroll={event => syncByAnchor(event.currentTarget, rightPane.current)}><div className="diff-pane-title"><strong>基准版本：{revisionTitle(diff.data?.from)}</strong><small>发布时间：{revisionTime(diff.data?.from)}</small></div>{selected && !selected.before && <div className="diff-document-placeholder">{diff.data?.from.versionLabel} 中不存在此需求</div>}<Phase2DocumentRenderer mode="diff-before" chapters={chapters(left.data)} links={left.data?.links || []} diffAnnotations={annotations("before")} selectedEntityUid={selectedUid} onSource={() => undefined} onEvaluate={() => undefined} readOnly/></section>
                <section ref={rightPane} onScroll={event => syncByAnchor(event.currentTarget, leftPane.current)}><div className="diff-pane-title"><strong>对比版本：{revisionTitle(diff.data?.to)}</strong><small>发布时间：{revisionTime(diff.data?.to)}</small></div>{selected && !selected.after && <div className="diff-document-placeholder">{diff.data?.to.versionLabel} 中已删除此需求</div>}<Phase2DocumentRenderer mode="diff-after" chapters={chapters(right.data)} links={right.data?.links || []} diffAnnotations={annotations("after")} selectedEntityUid={selectedUid} onSource={() => undefined} onEvaluate={() => undefined} readOnly/></section></main></div>
    </div>
}
