import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import CodeMirror from "@uiw/react-codemirror";
import {json} from "@codemirror/lang-json";
import {markdown} from "@codemirror/lang-markdown";
import {javascript} from "@codemirror/lang-javascript";
import {Alert, Button, Empty, message, Modal, Popconfirm, Space, Spin, Tag, Tree, Typography} from "antd";
import {DeleteOutlined, DownloadOutlined, ReloadOutlined, SaveOutlined} from "@ant-design/icons";
import {useMutation, useQuery, useQueryClient} from "@tanstack/react-query";
import {api, ApiError, type DebugFile, type DebugTreeNode} from "./api";

function queryPath(value: string) { return encodeURIComponent(value) }
function startDownload(url: string) {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove()
}
function readableSize(value: number) {
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function treeData(nodes: DebugTreeNode[]): any[] {
    return nodes.map(node => ({key: node.path, title: node.name, isLeaf: node.type === "file",
        selectable: node.type === "file", children: node.children ? treeData(node.children) : undefined}))
}

function extensionsFor(filePath: string) {
    const extension = filePath.split(".").pop()?.toLowerCase();
    if (extension === "json" || extension === "jsonc") return [json()];
    if (["md", "markdown"].includes(extension || "")) return [markdown()];
    if (["js", "jsx", "ts", "tsx"].includes(extension || "")) return [javascript({typescript: extension === "ts" || extension === "tsx", jsx: extension === "jsx" || extension === "tsx"})];
    return []
}

const DEBUG_EDITOR_BASIC_SETUP = {
    lineNumbers: true,
    highlightActiveLine: true,
    foldGutter: true,
    searchKeymap: true
} as const;

export function DebugFilesPanel({projectId, running, onDirtyChange}: {
    projectId: string;
    running: boolean;
    onDirtyChange: (dirty: boolean) => void
}) {
    const qc = useQueryClient(), [selectedPath, setSelectedPath] = useState<string>(), [draft, setDraft] = useState(""),
        [externalConflict, setExternalConflict] = useState(false), savingRef = useRef(false), dirtyRef = useRef(false),
        selectedRef = useRef<string | undefined>(undefined);
    const editorExtensions = useMemo(() => extensionsFor(selectedPath || ""), [selectedPath]);
    const tree = useQuery({queryKey: ["debug-project-tree", projectId], queryFn: () => api<{root: string; children: DebugTreeNode[]}>(`/projects/${projectId}/debug-files/tree`)});
    const file = useQuery({queryKey: ["debug-project-file", projectId, selectedPath], enabled: Boolean(selectedPath),
        queryFn: () => api<DebugFile>(`/projects/${projectId}/debug-files/file?path=${queryPath(selectedPath!)}`), retry: false});
    const dirty = file.data?.editable === true && file.data?.kind === "text" && draft !== (file.data.content || "");
    useEffect(() => { dirtyRef.current = dirty; onDirtyChange(dirty) }, [dirty, onDirtyChange]);
    useEffect(() => { selectedRef.current = selectedPath }, [selectedPath]);
    useEffect(() => {
        if (file.data?.kind === "text") setDraft(file.data.content || "");
        setExternalConflict(false)
    }, [file.data?.path, file.data?.version]);

    const reloadFile = useCallback(async () => {
        if (!selectedRef.current) return;
        await qc.invalidateQueries({queryKey: ["debug-project-file", projectId, selectedRef.current]});
        setExternalConflict(false)
    }, [projectId, qc]);

    useEffect(() => {
        const source = new EventSource(`/api/projects/${projectId}/debug-files/events`, {withCredentials: true});
        const changed = (raw: Event) => {
            const event = JSON.parse((raw as MessageEvent).data) as {path: string};
            void qc.invalidateQueries({queryKey: ["debug-project-tree", projectId]});
            if (event.path !== selectedRef.current || savingRef.current) return;
            if (dirtyRef.current) setExternalConflict(true); else void reloadFile()
        };
        source.addEventListener("file-change", changed);
        source.onerror = () => undefined;
        return () => { source.removeEventListener("file-change", changed); source.close() }
    }, [projectId, qc, reloadFile]);

    const save = useMutation<DebugFile, Error, boolean>({mutationFn: (force: boolean) => api<DebugFile>(`/projects/${projectId}/debug-files/file`, {
        method: "PUT", body: JSON.stringify({path: selectedPath, content: draft, expectedVersion: file.data?.version, force})
    }), onMutate: () => { savingRef.current = true }, onSuccess: result => {
        qc.setQueryData(["debug-project-file", projectId, selectedPath], result);
        setDraft(result.content || ""); setExternalConflict(false);
        void qc.invalidateQueries({queryKey: ["debug-project-tree", projectId]});
        message.success("文件已保存")
    }, onError: error => {
        if (error instanceof ApiError && error.status === 409) setExternalConflict(true);
        else message.error(error.message)
    }, onSettled: () => { savingRef.current = false }});
    const remove = useMutation({mutationFn: () => api<{path: string}>(`/projects/${projectId}/debug-files/file?path=${queryPath(selectedPath!)}&expectedVersion=${queryPath(file.data!.version)}`, {method: "DELETE"}),
        onSuccess: () => {
            qc.removeQueries({queryKey: ["debug-project-file", projectId, selectedPath]});
            setSelectedPath(undefined); setDraft(""); setExternalConflict(false);
            void qc.invalidateQueries({queryKey: ["debug-project-tree", projectId]});
            message.success("文件已删除")
        }, onError: error => {
            if (error instanceof ApiError && error.status === 409) setExternalConflict(true);
            message.error(error.message)
        }});
    const formatter = useMutation({mutationFn: () => api<{content: string}>(`/projects/${projectId}/debug-files/format`, {
        method: "PUT", body: JSON.stringify({content: draft, jsonc: selectedPath?.toLowerCase().endsWith(".jsonc")})
    }), onSuccess: result => setDraft(result.content), onError: error => message.error(error.message)});

    const choose = (nextPath: string) => {
        if (nextPath === selectedPath) return;
        if (dirty && !window.confirm("当前文件有未保存的修改，切换文件将丢失这些修改，是否继续？")) return;
        setSelectedPath(nextPath); setExternalConflict(false)
    };
    const forceSave = () => Modal.confirm({title: "强制覆盖文件？",
        content: "磁盘文件已被分析任务或其他管理员修改。强制保存会覆盖这些外部修改。",
        okText: "强制覆盖", okButtonProps: {danger: true}, cancelText: "取消", onOk: () => save.mutateAsync(true)});
    const downloadCurrent = () => {
        const proceed = () => startDownload(`/api/projects/${projectId}/debug-files/download?path=${queryPath(selectedPath!)}`);
        if (!dirty) return proceed();
        Modal.confirm({title: "下载磁盘已保存版本？", content: "当前未保存修改不会包含在下载文件中。",
            okText: "继续下载", cancelText: "取消", onOk: proceed})
    };
    const downloadArchive = () => {
        const warnings = [dirty ? "当前文件的未保存修改不会包含在 ZIP 中。" : "",
            running ? "分析任务正在运行，ZIP 是实时磁盘快照，打包期间产物仍可能变化。" : ""].filter(Boolean);
        const proceed = () => startDownload(`/api/projects/${projectId}/debug-files/archive`);
        if (!warnings.length) return proceed();
        Modal.confirm({title: "下载整个项目目录？", content: warnings.join(" "), okText: "继续下载", cancelText: "取消", onOk: proceed})
    };
    const structured = selectedPath?.toLowerCase().endsWith(".json") || selectedPath?.toLowerCase().endsWith(".jsonc");
    const info = file.data;

    return <section className="debug-files-panel">
        <div className="debug-files-header"><div><Typography.Title level={4}>项目文件调试器</Typography.Title>
            <Typography.Text type="secondary">文件变化将实时同步；源文件仅支持浏览和下载</Typography.Text></div>
            <Space wrap><Button icon={<DownloadOutlined/>} onClick={downloadArchive}>下载整个项目目录</Button>
                <Button icon={<ReloadOutlined/>} onClick={() => { void qc.invalidateQueries({queryKey: ["debug-project-tree", projectId]}) }}>刷新</Button></Space></div>
        <Alert type="warning" showIcon message="直接修改磁盘产物不会自动刷新评审索引，必要时请重新运行相应流程。"/>
        {running && <Alert type="error" showIcon message="分析任务正在运行"
            description="保存或删除可能与 Agent 同时写入文件；系统会检测版本冲突，但操作仍可能影响当前流程。"/>}
        <div className="debug-files-body">
            <div className="debug-files-tree">{tree.isLoading ? <Spin/> : tree.error ? <Alert type="error" message={tree.error.message}/> :
                tree.data?.children.length ? <Tree showLine blockNode treeData={treeData(tree.data.children)} selectedKeys={selectedPath ? [selectedPath] : []}
                    onSelect={keys => keys[0] && choose(String(keys[0]))}/> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="项目目录为空"/>}</div>
            <div className="debug-file-editor">{!selectedPath ? <Empty description="请选择文件"/> : file.isLoading ? <Spin/> : file.error ? <Alert type="error" message={file.error.message}/> : info && <>
                <div className="debug-file-toolbar"><div className="debug-file-title"><Typography.Text strong title={info.path}>{info.path}</Typography.Text>
                    <Space size={4}><Tag>{readableSize(info.size)}</Tag><Tag>{new Date(info.modifiedAt).toLocaleString()}</Tag>{dirty && <Tag color="orange">未保存</Tag>}</Space></div>
                    <Space wrap>{structured && info.editable && info.kind === "text" && <Button loading={formatter.isPending} onClick={() => formatter.mutate()}>格式化 JSON</Button>}
                        <Button icon={<DownloadOutlined/>} onClick={downloadCurrent}>下载</Button>
                        {info.editable && info.kind === "text" && <Button type="primary" icon={<SaveOutlined/>} disabled={!dirty || externalConflict} loading={save.isPending} onClick={() => save.mutate(false)}>保存</Button>}
                        {info.deletable && <Popconfirm title="删除文件？" description={<>将永久删除 <b>{info.path}</b>，此操作不可恢复。</>}
                            okText="删除" cancelText="取消" okButtonProps={{danger: true}} onConfirm={() => remove.mutate()}>
                            <Button danger icon={<DeleteOutlined/>} loading={remove.isPending}>删除</Button></Popconfirm>}</Space></div>
                {externalConflict && <Alert type="error" showIcon message="文件已被外部修改"
                    description="当前草稿未被覆盖。请选择重新加载磁盘版本，或确认强制覆盖。"
                    action={<Space><Button onClick={() => reloadFile()}>放弃草稿并重新加载</Button><Button danger onClick={forceSave}>强制覆盖</Button></Space>}/>}
                {info.kind === "text" ? <CodeMirror className="matrix-code-editor" value={draft} readOnly={!info.editable} editable={info.editable} height="100%" extensions={editorExtensions}
                    onChange={setDraft} basicSetup={DEBUG_EDITOR_BASIC_SETUP}/> :
                    info.kind === "image" ? <div className="debug-image-preview"><img alt={info.path} src={`data:${info.mimeType};base64,${info.contentBase64}`}/></div> :
                        <Empty description="不支持在线预览，请下载查看"/>}
            </>}</div>
        </div>
    </section>
}
