import {useCallback, useEffect, useRef, useState} from "react";
import {renderAsync} from "docx-preview";
import {Alert, Button, Space, Spin, Tooltip} from "antd";
import {MinusOutlined, PlusOutlined, ZoomInOutlined} from "@ant-design/icons";
import {authenticatedFetch, type DocumentNode} from "./api";

const normalized = (value: string) => value.replace(/\s+/g, "").toLowerCase();
const MIN_SCALE = 0.4, MAX_SCALE = 1.5, SCALE_STEP = 0.1;
type ZoomMode = "fit" | "manual";

export function DocxPreview({documentId, nodes, activeNodeId, navigationKey, onNodeClick}: {
    documentId?: string;
    nodes: DocumentNode[];
    activeNodeId?: string;
    navigationKey?: number;
    onNodeClick: (id: string) => void;
}) {
    const shell = useRef<HTMLDivElement>(null), container = useRef<HTMLDivElement>(null);
    const naturalSize = useRef({width: 0, height: 0});
    const [loading, setLoading] = useState(false), [error, setError] = useState<string>();
    const [zoomMode, setZoomMode] = useState<ZoomMode>("fit"), [scale, setScale] = useState(1);
    const [touchToolbarOpen, setTouchToolbarOpen] = useState(false);
    const applyScale = useCallback((nextScale: number) => {
        const preview = container.current, wrapper = preview?.querySelector<HTMLElement>(".docx-wrapper");
        if (!preview || !wrapper || !naturalSize.current.width) return;
        const bounded = Math.min(MAX_SCALE, Math.max(MIN_SCALE, nextScale));
        const scaledWidth = naturalSize.current.width * bounded;
        wrapper.style.transform = `scale(${bounded})`;
        preview.style.width = `${scaledWidth}px`;
        preview.style.height = `${naturalSize.current.height * bounded}px`;
        preview.classList.toggle("docx-preview-centered", scaledWidth <= (shell.current?.clientWidth || scaledWidth));
        setScale(bounded);
    }, []);
    const fitToWidth = useCallback(() => {
        if (!shell.current || !naturalSize.current.width) return;
        const availableWidth = Math.max(0, shell.current.clientWidth - 4);
        applyScale(Math.min(1, availableWidth / naturalSize.current.width));
    }, [applyScale]);
    const setManualScale = useCallback((nextScale: number) => {
        setZoomMode("manual");
        applyScale(nextScale);
    }, [applyScale]);
    useEffect(() => {
        if (!documentId || !container.current) return;
        let disposed = false;
        setZoomMode("fit");
        setScale(1);
        naturalSize.current = {width: 0, height: 0};
        setLoading(true);
        setError(undefined);
        container.current.innerHTML = "";
        container.current.removeAttribute("style");
        authenticatedFetch(`/api/documents/${documentId}/file`).then(response => {
            if (!response.ok) throw new Error(`DOCX加载失败（${response.status}）`);
            return response.arrayBuffer()
        }).then(buffer => renderAsync(buffer, container.current!, undefined, {
            className: "docx", inWrapper: true, ignoreWidth: false, ignoreHeight: false,
            ignoreFonts: false, breakPages: true, renderHeaders: true, renderFooters: true
        })).then(() => {
            if (disposed || !container.current) return;
            const wrapper = container.current.querySelector<HTMLElement>(".docx-wrapper");
            if (wrapper) {
                wrapper.style.transform = "none";
                naturalSize.current = {width: wrapper.scrollWidth, height: wrapper.scrollHeight};
                requestAnimationFrame(fitToWidth);
            }
            const paragraphs = [...container.current.querySelectorAll<HTMLElement>("p")]
                .filter(item => !item.closest("table, header, footer"));
            const used = new Set<HTMLElement>();
            for (const node of nodes) {
                const title = normalized(node.title),
                    heading = normalized(node.text || `${node.number || ""}${node.title}`),
                    candidates = paragraphs.filter(item => !used.has(item) && !item.querySelector("a") && normalized(item.textContent || "").includes(title));
                const reversed = [...candidates].reverse();
                let element = reversed.find(item => normalized(item.textContent || "") === heading) ||
                    reversed.find(item => normalized(item.textContent || "").startsWith(heading));
                if (!element) continue;
                used.add(element);
                element.dataset.sourceNodeId = node.id;
                element.classList.add("source-anchor");
                element.addEventListener("click", () => onNodeClick(node.id))
            }
        }).catch(reason => !disposed && setError(reason instanceof Error ? reason.message : String(reason)))
            .finally(() => !disposed && setLoading(false));
        return () => {
            disposed = true
        }
    }, [documentId, nodes, fitToWidth]);
    useEffect(() => {
        if (!shell.current) return;
        const observer = new ResizeObserver(() => {
            if (zoomMode === "fit") requestAnimationFrame(fitToWidth)
        });
        observer.observe(shell.current);
        return () => observer.disconnect()
    }, [fitToWidth, zoomMode]);
    useEffect(() => {
        if (!container.current) return;
        container.current.querySelectorAll(".source-highlight").forEach(item => item.classList.remove("source-highlight"));
        if (!activeNodeId) return;
        const target = container.current.querySelector<HTMLElement>(`[data-source-node-id="${CSS.escape(activeNodeId)}"]`);
        target?.classList.add("source-highlight");
        target?.scrollIntoView({behavior: "smooth", block: "center"})
    }, [activeNodeId, loading, navigationKey]);
    useEffect(() => {
        if (!touchToolbarOpen) return;
        const closeOnOutsidePointer = (event: PointerEvent) => {
            if (!shell.current?.querySelector(".docx-zoom-dock")?.contains(event.target as Node)) {
                setTouchToolbarOpen(false)
            }
        };
        document.addEventListener("pointerdown", closeOnOutsidePointer);
        return () => document.removeEventListener("pointerdown", closeOnOutsidePointer)
    }, [touchToolbarOpen]);
    return <div ref={shell} className="docx-preview-shell">
        {!error && <div className="docx-zoom-anchor">
            <div className={`docx-zoom-dock${touchToolbarOpen ? " is-open" : ""}`}>
                <Tooltip title="缩放文档" placement="left">
                    <Button className="docx-zoom-trigger" shape="circle" icon={<ZoomInOutlined/>}
                            aria-label="显示文档缩放控件"
                            onClick={() => {
                                if (window.matchMedia("(hover: none), (pointer: coarse)").matches) {
                                    setTouchToolbarOpen(value => !value)
                                }
                            }}/>
                </Tooltip>
                <div className="docx-zoom-toolbar" aria-label="文档缩放控件">
                    <Space.Compact>
                        <Button type={zoomMode === "fit" ? "primary" : "default"} onClick={() => {
                            setZoomMode("fit");
                            fitToWidth()
                        }}>适应宽度</Button>
                        <Button onClick={() => setManualScale(1)}>100%</Button>
                        <Tooltip title="缩小"><Button aria-label="缩小" icon={<MinusOutlined/>} disabled={scale <= MIN_SCALE}
                                                      onClick={() => setManualScale(scale - SCALE_STEP)}/></Tooltip>
                        <Button className="docx-zoom-value" disabled>{Math.round(scale * 100)}%</Button>
                        <Tooltip title="放大"><Button aria-label="放大" icon={<PlusOutlined/>} disabled={scale >= MAX_SCALE}
                                                      onClick={() => setManualScale(scale + SCALE_STEP)}/></Tooltip>
                    </Space.Compact>
                </div>
            </div>
        </div>}
        {loading && <Spin tip="正在渲染DOCX"/>}
        {error && <Alert type="error" showIcon message="DOCX预览失败" description={error}/>}
        <div ref={container} className="docx-preview"/>
    </div>
}
