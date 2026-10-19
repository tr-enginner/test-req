import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode} from "react";
import {createPortal} from "react-dom";
import {
    Alert,
    Badge,
    Button,
    Card,
    Checkbox,
    Col,
    Drawer,
    Dropdown,
    Empty,
    Form,
    Input,
    Layout,
    List,
    message,
    Modal,
    Popconfirm,
    Popover,
    Progress,
    Result,
    Row,
    Select,
    Slider,
    Space,
    Spin,
    Splitter,
    Tag,
    Tooltip,
    Tree,
    Typography,
    Upload
} from "antd";
import {
    ArrowLeftOutlined,
    BugOutlined,
    CheckCircleFilled,
    ClockCircleOutlined,
    CloseOutlined,
    CloseCircleFilled,
    DeleteOutlined,
    DownloadOutlined,
    DownOutlined,
    EllipsisOutlined,
    InfoCircleOutlined,
    EditOutlined,
    EyeOutlined,
    SaveOutlined,
    FileZipOutlined,
    MenuUnfoldOutlined,
    PlusOutlined,
    RightOutlined,
    StopOutlined
} from "@ant-design/icons";
import {Navigate, Route, Routes, useLocation, useNavigate, useParams, useSearchParams} from "react-router-dom";
import {RequirementDiffPage} from "./RequirementDiff";
import {SortableTableList} from "./SortableTableList";
import {readPhase2Draft, removePhase2Draft, writePhase2Draft} from "./phase2Draft";
import {useMutation, useQuery, useQueryClient} from "@tanstack/react-query";
import {
    api,
    ApiError,
    downloadApi,
    type CurrentUser,
    type CurrentActivity,
    type EditTimeSummary,
    type Phase2Run,
    type TokenUsage,
    type Phase2EditRun,
    type Phase2EditBinding,
    type Phase2InlineDescriptor,
    type Phase2RequirementOperation,
    type Phase2ReferenceOperation,
    type Phase2TableOperation,
    type Project,
    type ReviewData,
    type ReviewRecord,
    type ReviewScores,
    type RunEvent,
    type RunEventHistory,
    saveDownload,
    resetSessionExpiredNotification,
    subscribeToSessionExpired,
    type TraceLink
} from "./api";
import {safeReturnTo} from "./sessionNavigation";
import {appendEditTimeOutbox, EditingTimeTracker, editTimeOutboxKey, formatEditDuration, readEditTimeOutbox, removeEditTimeOutbox} from "./editTime";
import {DocxPreview} from "./DocxPreview";
import {cacheHitRate, elapsedMilliseconds, formatElapsed, formatTokenCount, nonCachedTokens} from "./runMetrics";
import {Phase2DocumentRenderer} from "./Phase2DocumentRenderer";
import {requirementScrollTop} from "./requirementNavigation";
import {useTraceStore} from "./traceStore";
import {DebugFilesPanel} from "./DebugFilesPanel";
import {activityPresentation, phase2RunButtonLabel, PROJECT_STATUS, projectsNeedPolling, reviewSummaryText, stageName} from "./projectPresentation";
import {AppHeader} from "./AppHeader";
import {isExpansionKey, isTerminalRunStatus, mergeRunEvents, runWarningDetails, toggleExpandedEvent} from "./runLogDetails";

const {Content, Sider} = Layout;

type SplitSizes = Array<number | string>;
const splitStorageKey = (name: string) => `matrix-requirements-review:${name}`;

function loadSplitSizes(name: string): number[] | undefined {
    try {
        const value = JSON.parse(localStorage.getItem(splitStorageKey(name)) || "null");
        return Array.isArray(value) && value.length >= 1 && value.length <= 2 && value.every(item => typeof item === "number" && Number.isFinite(item) && item >= 0) ? value : undefined
    } catch {
        return undefined
    }
}

function saveSplitSizes(name: string, sizes: SplitSizes) {
    if (sizes.every(item => typeof item === "number" && Number.isFinite(item))) localStorage.setItem(splitStorageKey(name), JSON.stringify(sizes))
}

function snappedSizes(sizes: number[], threshold: number, bothSides: boolean) {
    const total = sizes[0] + sizes[1];
    if (sizes[0] < threshold && sizes[1] >= threshold) return [0, total];
    if (bothSides && sizes[1] < threshold && sizes[0] >= threshold) return [total, 0];
    return sizes
}

function localMinute(value?: string) {
    if (!value) return "-";
    const date = new Date(value), pad = (number: number) => String(number).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function Login() {
    const nav = useNavigate(), location = useLocation(), qc = useQueryClient(), login = useMutation({
        mutationFn: (v: {
            username: string,
            password: string
        }) => api<CurrentUser>("/auth/login", {method: "POST", body: JSON.stringify(v)}), onSuccess: user => {
            resetSessionExpiredNotification();
            qc.setQueryData(["me"], user);
            nav(safeReturnTo((location.state as {returnTo?: unknown} | null)?.returnTo), {replace: true})
        }
    });
    return <div className="login"><Card title="测试需求管理工具"><Form layout="vertical"
                                                                                            onFinish={v => login.mutate(v)}><Form.Item
        name="username" label="用户名" rules={[{required: true}]}><Input/></Form.Item><Form.Item name="password"
                                                                                                 label="密码"
                                                                                                 rules={[{required: true}]}><Input.Password/></Form.Item>{login.error &&
        <Alert type="error" message={login.error.message}/>}<Button block type="primary" htmlType="submit"
                                                                    loading={login.isPending}>登录</Button></Form></Card>
    </div>
}

function SessionExpired({onLogin}: {onLogin: () => void}) {
    return <div className="session-expired"><Result status="warning" title="会话过期"
        subTitle="会话过期，请重新登录"
        extra={<Button type="primary" size="large" onClick={onLogin}>重新登录</Button>}/></div>
}

function Shell({children, backTo, backLabel = "返回项目", actions, beforeLeave, hideHeader = false, className = ""}: { children: React.ReactNode; backTo?: string; backLabel?: string; actions?: React.ReactNode; beforeLeave?: () => boolean; hideHeader?: boolean; className?: string }) {
    return <Layout className={`shell ${className}`}>{!hideHeader && <AppHeader backTo={backTo} backLabel={backLabel}
        actions={actions} beforeLeave={beforeLeave}/>}{children}</Layout>
}

function Projects() {
    const qc = useQueryClient(), nav = useNavigate(), query = useQuery({
        queryKey: ["projects"],
        queryFn: () => api<Project[]>("/projects"),
        refetchInterval: query => projectsNeedPolling(query.state.data) ? 3000 : false
    }), [open, setOpen] = useState(false), [archiveFile, setArchiveFile] = useState<File | null>(null),
        [createForm] = Form.useForm(), upload = useMutation({
        mutationFn: async ({name, file}: { name: string; file: File }) => {
            const form = new FormData();
            form.append("name", name);
            form.append("file", file);
            return api<Project>("/projects", {method: "POST", body: form})
        }, onSuccess: p => {
            setOpen(false);
            setArchiveFile(null);
            createForm.resetFields();
            qc.invalidateQueries({queryKey: ["projects"]});
            message.success("项目创建完成");
            location.href = `/projects/${p.id}`
        }
    }), remove = useMutation({
        mutationFn: (id: string) => api<{ id: string }>(`/projects/${id}`, {method: "DELETE"}),
        onSuccess: () => {
            qc.invalidateQueries({queryKey: ["projects"]});
            nav("/", {replace: true});
            message.success("项目已删除")
        },
        onError: error => message.error(error.message)
    });
    return <Shell><Content className="page"><Space
        style={{width: "100%", justifyContent: "space-between"}}><Typography.Title level={3}>项目列表</Typography.Title><Button
        type="primary" icon={<PlusOutlined/>} onClick={() => setOpen(true)}>新建项目</Button></Space><Row
        gutter={[16, 16]}>{query.data?.slice().sort((left, right) => {
            const createdAtDifference = Date.parse(right.createdAt) - Date.parse(left.createdAt);
            return createdAtDifference || right.id.localeCompare(left.id)
        }).map(p => <Col xs={24} md={12} xl={8} key={p.id}><Card hoverable title={p.name}
                                                                                             onClick={() => location.href = `/projects/${p.id}`}
                                                                                             extra={<div
                                                                                                 data-project-action
                                                                                                 onClick={event => event.stopPropagation()}>
                                                                                                 <Space><Status
                                                                                                     value={p.status}/><Popconfirm
                                                                                                     title="删除项目"
                                                                                                     description="将永久删除项目、源文档、生成工件和评审记录，是否继续？"
                                                                                                     okText="删除"
                                                                                                     cancelText="取消"
                                                                                                     okButtonProps={{danger: true}}
                                                                                                     onConfirm={() => remove.mutate(p.id)}><Button
                                                                                                     danger type="text"
                                                                                                     icon={
                                                                                                         <DeleteOutlined/>}
                                                                                                     loading={remove.isPending && remove.variables === p.id}
                                                                                                     onClick={event => event.stopPropagation()}/></Popconfirm></Space>
                                                                                             </div>}>
        <p>创建时间：{localMinute(p.createdAt)}</p><ProjectActivity activity={p.currentActivity}/></Card></Col>)}</Row><Modal open={open} title="新建项目"
        okText="创建项目" cancelText="取消" confirmLoading={upload.isPending}
        onCancel={() => {
            setOpen(false);
            setArchiveFile(null);
            upload.reset();
            createForm.resetFields()
        }} onOk={() => createForm.submit()}><Form form={createForm} layout="vertical" onFinish={values => {
        if (!archiveFile) return message.error("请选择源文档ZIP压缩包");
        upload.mutate({name: values.name.trim(), file: archiveFile})
    }}><Form.Item name="name" label="项目名称" rules={[{required: true, whitespace: true, message: "请输入项目名称"},
        {max: 100, message: "项目名称不能超过100个字符"},
        {validator: (_, value) => {
            const normalized = String(value || "").trim();
            return normalized && query.data?.some(project => project.name === normalized)
                ? Promise.reject(new Error("项目名称已存在，请使用其他名称"))
                : Promise.resolve()
        }}]}><Input placeholder="请输入项目名称"/></Form.Item>
        <Form.Item label="源文档压缩包" required><Upload.Dragger accept=".zip" maxCount={1}
            beforeUpload={file => {
                setArchiveFile(file);
                return false
            }} onRemove={() => setArchiveFile(null)}><p><FileZipOutlined className="upload-icon"/></p>
            <p>上传仅包含DOCX源文档的ZIP压缩包</p><p className="upload-hint">不允许包含DOC、PDF、.matrix或其他格式文件</p>
        </Upload.Dragger></Form.Item></Form>{upload.error && <Alert type="error" showIcon message={upload.error.message}/>}</Modal></Content></Shell>
}

function Status({value}: { value: string }) {
    const presentation = PROJECT_STATUS[value], tag = <Tag color={presentation?.color || "default"}>{presentation?.label || "未知状态"}</Tag>;
    return presentation ? tag : <Tooltip title={`内部状态：${value}`}>{tag}</Tooltip>
}

function ProjectActivity({activity}: {activity?: CurrentActivity | null}) {
    const presentation = activityPresentation(activity);
    return <><p>{presentation.text}</p><Progress percent={presentation.percent}
        status={presentation.progressStatus} strokeColor={presentation.strokeColor}/></>
}

const CHAPTERS = [
    ["第一章：范围", "finalize_chapter1_scope", "chapter1-scope.json", "1"],
    ["第二章：系统概述", "finalize_chapter2_system_overview", "chapter2-system-overview.json", "2"],
    ["第三章：硬件接口", "finalize_hardware_interface", "hardware-interface-model.json", "3.1"],
    ["4.1：功能测试", "finalize_functional_test_content", "functional-test-content.json", "4.1"],
    ["4.2：性能测试", "finalize_performance_test_content", "performance-test-content.json", "4.2"],
    ["4.3：接口测试", "finalize_interface_test_content", "interface-test-content.json", "4.3"],
    ["4.4：可靠性安全性测试", "finalize_reliability_safety_test_content", "reliability-safety-test-content.json", "4.4"],
    ["4.5：余量测试", "finalize_margin_test_content", "margin-test-content.json", "4.5"],
    ["4.6：边界测试", "finalize_boundary_test_content", "boundary-test-content.json", "4.6"],
    ["4.7：数据处理测试", "finalize_data_processing_test_content", "data-processing-test-content.json", "4.7"],
    ["4.8：恢复性测试", "finalize_recovery_test_content", "recovery-test-content.json", "4.8"],
    ["4.9：强度测试", "finalize_strength_test_content", "strength-test-content.json", "4.9"],
    ["测试需求追溯关系", "generate_phase2_traceability", "phase2-test-traceability.json", "6"]
] as const;

function eventText(item: RunEvent) {
    const mode = String(item.payload.mode || ""), stage = stageName(mode, item.payload.batchIndex);
    if (item.type === "run.queued") return "任务已进入执行队列";
    if (item.type === "run.started") return `Worker已开始第${Number(item.payload.attempt || 1)}次执行`;
    if (item.type === "run.resumed") return item.payload.reason ? `已继续生成测试需求：${String(item.payload.reason)}` : "已继续生成测试需求";
    if (item.type === "run.attempt_failed") return `第${Number(item.payload.attempt || 1)}次执行失败：${item.payload.stage ? `${stageName(String(item.payload.stage))}；原因：${String(item.payload.reason || item.payload.message || "未知错误")}` : String(item.payload.message || "未知错误")}`;
    if (item.type === "run.retry_queued") return `已自动安排第${Number(item.payload.attempt || 1)}次执行`;
    if (item.type === "run.auto_retry_changed") return item.payload.enabled ? "已开启失败自动重试" : "已关闭失败自动重试";
    if (item.type === "model.selected") return `使用模型：${String(item.payload.name || item.payload.model || "OpenCode当前配置模型")}`;
    if (item.type === "session.created") return "OpenCode会话创建成功";
    if (item.type === "command.started") return "已提交测试需求生成命令";
    if (item.type === "stage.running") return `开始：${stage}`;
    if (item.type === "stage.completed") {
        const {warnings, skippedCount: skipped} = runWarningDetails(item.payload);
        const warningCount = warnings.length;
        const detail = [warningCount ? `${warningCount}条容错警告` : "", skipped ? `跳过${skipped}项` : ""].filter(Boolean).join("，");
        return `完成：${stage}${detail ? `（${detail}）` : ""}`
    }
    if (item.type === "run.succeeded") return "测试需求生成完成";
    if (item.type === "run.cancelled") return "用户已终止测试需求生成";
    if (item.type === "run.failed") return `生成失败：${String(item.payload.message || "未知错误")}`;
    return item.type
}

function RunMetrics({run}: {run?: Phase2Run}) {
    const [, setTick] = useState(0);
    const receivedAt = useMemo(() => performance.now(), [run]);
    const elapsed = elapsedMilliseconds(run?.elapsedMs, run?.status, receivedAt);
    useEffect(() => {
        if (!run?.startedAt || run.finishedAt || run.status !== "RUNNING") return;
        const timer = window.setInterval(() => setTick(value => value + 1), 1000);
        return () => window.clearInterval(timer)
    }, [run?.startedAt, run?.finishedAt, run?.status]);
    const usage = run?.tokenUsage, queued = run?.status === "QUEUED",
        nonCached = usage ? nonCachedTokens(usage) : undefined,
        hitRate = usage ? cacheHitRate(usage) : undefined;
    const metric = (label: string, value: number) => <span>{label} <Tooltip
        title={Math.round(value).toLocaleString("en-US")}>{formatTokenCount(value)}</Tooltip></span>;
    return <div className="run-metrics">
        <Tooltip title={<div>累计处理 Token 包含每轮请求重复使用的缓存上下文，不等于模型供应商
            控制台的计费 Token，最终费用以供应商账单为准。</div>}><InfoCircleOutlined
            className="run-metrics-info" aria-label="Token 统计口径说明"/></Tooltip>
        <div className="run-metric-primary"><div className="run-metric-item"><span>已运行时间</span><strong>{elapsed === undefined ? queued ? "等待执行" : "等待计时数据" : formatElapsed(elapsed)}</strong></div><Tooltip title={usage ? <div className="run-metric-tooltip">
                <div>输入：{Math.round(usage.input).toLocaleString("en-US")}</div>
                <div>输出：{Math.round(usage.output).toLocaleString("en-US")}</div>
                <div>推理：{Math.round(usage.reasoning).toLocaleString("en-US")}</div>
                <div>计算公式：输入 + 输出 + 推理</div>
                <div>该值不等同于供应商后台计费 Token。</div>
            </div> : undefined}><div className="run-metric-item"><span>非缓存 Token</span><strong>
                {nonCached !== undefined ? formatTokenCount(nonCached) : queued ? "0" : "暂无统计"}</strong></div></Tooltip>
            <Tooltip title={usage ? <div className="run-metric-tooltip">
                <div>缓存命中：{Math.round(usage.cacheRead).toLocaleString("en-US")}</div>
                <div>累计处理：{Math.round(usage.total).toLocaleString("en-US")}</div>
                <div>计算公式：缓存命中 ÷（输入 + 缓存命中）</div>
                <div>缓存命中通常按更低价格计费。</div>
            </div> : undefined}><div className="run-metric-item"><span>缓存命中率</span><strong>
                {hitRate !== undefined ? `${hitRate.toFixed(1)}%` : queued ? "0.0%" : "暂无统计"}</strong></div></Tooltip>
            {usage && !usage.complete && <Tag color="warning">统计可能不完整</Tag>}</div>
        {usage && <div className="run-token-details">{metric("输入", usage.input)}<b>·</b>{metric("输出", usage.output)}
            <b>·</b>{metric("推理", usage.reasoning)}<b>·</b>{metric("缓存命中", usage.cacheRead)}
            {usage.cacheWrite > 0 && <><b>·</b>{metric("缓存写入", usage.cacheWrite)}</>}</div>}
    </div>
}

function RunLogs({run, onEvents, scrollPositions}: {
    run?: Phase2Run;
    onEvents: () => void;
    scrollPositions: {current: Map<string, number>};
}) {
    const [events, setEvents] = useState<RunEvent[]>([]), [connection, setConnection] = useState("等待任务"),
        [historyError, setHistoryError] = useState(false),
        [runState, setRunState] = useState<Phase2Run | undefined>(run),
        [expandedEvents, setExpandedEvents] = useState<Set<string>>(() => new Set()),
        [initialEventsLoaded, setInitialEventsLoaded] = useState(false),
        scrollRef = useRef<HTMLDivElement>(null), pendingRestoreRef = useRef(true);
    useEffect(() => setRunState(run), [run]);
    useEffect(() => {
        setEvents([]);
        setExpandedEvents(new Set());
        setInitialEventsLoaded(false);
        setHistoryError(false);
        pendingRestoreRef.current = true;
        if (!run) return;
        let active = true;
        setConnection("正在加载历史日志");
        void (async () => {
            let after: string | undefined;
            try {
                do {
                    const query = new URLSearchParams({limit: "200"});
                    if (after !== undefined) query.set("after", after);
                    const page = await api<RunEventHistory>(`/phase2-runs/${run.id}/event-history?${query}`);
                    if (!active) return;
                    setEvents(previous => mergeRunEvents(previous, page.items));
                    if (!page.hasMore) break;
                    if (!page.nextCursor || page.nextCursor === after) throw new Error("历史日志分页游标未推进");
                    after = page.nextCursor
                } while (active)
            } catch {
                if (active) setHistoryError(true)
            } finally {
                if (active) setInitialEventsLoaded(true)
            }
        })();
        return () => { active = false }
    }, [run?.id]);
    useEffect(() => {
        if (!run) {
            setConnection("等待任务");
            return
        }
        if (isTerminalRunStatus(run.status)) {
            setConnection("任务已结束");
            return
        }
        let active = true;
        let source: EventSource | undefined;
        const connect = () => {
            if (!active) return;
            setConnection("正在连接实时日志");
            source = new EventSource(`/api/phase2-runs/${run.id}/events`, {withCredentials: true});
            source.addEventListener("run-events", raw => {
                if (!active) return;
                const rows = JSON.parse((raw as MessageEvent).data) as RunEvent[];
                if (rows.length) {
                    setEvents(previous => mergeRunEvents(previous, rows));
                    onEvents()
                }
                setConnection("实时日志已连接")
            });
            source.addEventListener("run-state", raw => {
                if (!active) return;
                const state = JSON.parse((raw as MessageEvent).data) as Partial<Phase2Run> | null;
                if (state?.id === run.id) setRunState(previous => ({...(previous || run), ...state} as Phase2Run));
                if (state?.status && isTerminalRunStatus(state.status)) {
                    setConnection("任务已结束");
                    source?.close()
                } else setConnection("实时日志已连接")
            });
            source.onerror = () => {
                if (active) setConnection("实时日志连接中断，正在重连")
            }
        };
        connect();
        return () => {
            active = false;
            source?.close()
        }
    }, [run?.id, run?.status]);
    useLayoutEffect(() => {
        if (!pendingRestoreRef.current || !initialEventsLoaded || !run?.id || !scrollRef.current) return;
        const savedScrollTop = scrollPositions.current.get(run.id);
        if (savedScrollTop === undefined) {
            pendingRestoreRef.current = false;
            return
        }
        if (events.length === 0) return;
        scrollRef.current.scrollTop = savedScrollTop;
        pendingRestoreRef.current = false
    }, [events.length, initialEventsLoaded, run?.id, scrollPositions]);
    useLayoutEffect(() => {
        const runId = run?.id;
        return () => {
            if (runId && scrollRef.current) scrollPositions.current.set(runId, scrollRef.current.scrollTop)
        }
    }, [run?.id, scrollPositions]);
    return <><RunMetrics run={runState}/><Card size="small" title="实时运行日志" extra={<Tag>{connection}</Tag>} className="run-log-card">
        {historyError && <Alert type="warning" showIcon message="历史日志加载失败，可刷新重试"/>}
        <div ref={scrollRef} className="run-log-scroll" onScroll={event => {
            if (run?.id) scrollPositions.current.set(run.id, event.currentTarget.scrollTop)
        }}>
        {events.length ? <List size="small" dataSource={events} renderItem={item => {
            const details = runWarningDetails(item.payload), expandable = item.type === "stage.completed" && details.warnings.length > 0,
                expanded = expandable && expandedEvents.has(item.id), toggle = () => setExpandedEvents(value => toggleExpandedEvent(value, item.id));
            return <List.Item className={`run-log ${item.type === "run.failed" || item.type === "run.attempt_failed" ? "error" : item.type.endsWith("succeeded") || item.type === "stage.completed" ? "success" : "info"}`}>
                <div className="run-log-entry">
                    <div className={`run-log-summary${expandable ? " run-log-expandable" : ""}`}
                        {...(expandable ? {role: "button", tabIndex: 0, "aria-expanded": expanded, onClick: toggle,
                            onKeyDown: (event: ReactKeyboardEvent) => { if (isExpansionKey(event.key)) { event.preventDefault(); toggle() } }} : {})}>
                        <span className="run-log-time">{localMinute(item.createdAt)}</span><span className="run-log-message">{eventText(item)}</span>
                        {expandable && <span className="run-log-toggle" aria-hidden>{expanded ? <DownOutlined/> : <RightOutlined/>}</span>}
                    </div>
                    {expanded && <div className="run-log-details">
                        <div>跳过操作数：{details.skippedCount}</div>
                        <ol>{details.warnings.map((warning, index) => <li key={`${item.id}-${index}`}>{warning}</li>)}</ol>
                    </div>}
                </div>
            </List.Item>
        }}/> : <div className="run-log-empty">正在等待任务启动...</div>}
        </div>
    </Card></>
}

function ChapterStatus({project, run}: { project: Project; run?: Phase2Run }) {
    const nav = useNavigate();
    const completed = new Set(run?.completedStages || []), missing = new Set(project.missingArtifacts || []),
        failed = run?.status === "FAILED";
    return <Card title="章节生成状态" className="chapter-status"><Row
        gutter={[12, 12]}>{CHAPTERS.map(([name, stage, artifact, chapter]) => {
        const ready = run ? completed.has(stage) : !missing.has(artifact);
        return <Col xs={24} md={12} xl={8} key={stage}>
            <button type="button" className={`chapter-status-row${ready ? " chapter-status-ready" : ""}`}
                    disabled={!ready} onClick={() => ready && nav(`/projects/${project.id}/review?chapter=${encodeURIComponent(chapter)}`)}>
                <span>{name}</span>{ready ?
                <CheckCircleFilled className="chapter-ok" title="已成功生成"/> :
                <CloseCircleFilled className={failed ? "chapter-failed" : "chapter-pending"}
                                   title={failed ? "未生成" : "尚未生成"}/>}</button>
        </Col>
    })}</Row></Card>
}

function ProjectPage() {
    const {id = ""} = useParams(), nav = useNavigate(), qc = useQueryClient(),
        user = qc.getQueryData<CurrentUser>(["me"]), [debugOpen, setDebugOpen] = useState(false),
        [debugDirty, setDebugDirty] = useState(false), projectContentRef = useRef<HTMLDivElement>(null),
        pendingContentScrollRef = useRef<number | undefined>(undefined),
        runLogScrollPositionsRef = useRef<Map<string, number>>(new Map()), query = useQuery({
        queryKey: ["project", id],
        queryFn: () => api<Project>(`/projects/${id}`),
        refetchInterval: query => {
            const project = query.state.data, latestRun = project?.runs[0];
            return project?.status === "REBUILDING" || (["QUEUED", "RUNNING"] as string[]).includes(latestRun?.status || "") ? 3000 : false
        },
        retry: false
    }), [autoRetry, setAutoRetry] = useState(true), run = useMutation({
        mutationFn: ({latest, enabled}: {latest?: Phase2Run; enabled: boolean}) =>
            latest && (latest.status === "FAILED" || latest.status === "CANCELLED")
                ? api<Phase2Run>(`/phase2-runs/${latest.id}/resume`, {method: "POST"})
                : api<Phase2Run>(`/phase2-runs/project/${id}`, {method: "POST", body: JSON.stringify({autoRetry: enabled})}),
        onSuccess: () => qc.invalidateQueries({queryKey: ["project", id]})
    }), updateAutoRetry = useMutation({
        mutationFn: ({runId, enabled}: {runId: string; enabled: boolean}) => api<Phase2Run>(`/phase2-runs/${runId}/auto-retry`, {
            method: "PATCH", body: JSON.stringify({autoRetry: enabled})
        }),
        onError: (error, variables) => {
            setAutoRetry(!variables.enabled);
            message.error(error.message)
        },
        onSuccess: value => qc.setQueryData<Project>(["project", id], previous => previous ? {
            ...previous, runs: previous.runs.map(item => item.id === value.id ? {...item, autoRetry: value.autoRetry} : item)
        } : previous)
    }), cancel = useMutation({
        mutationFn: (runId: string) => api<Phase2Run>(`/phase2-runs/${runId}/cancel`, {method: "POST"}),
        onSuccess: () => {
            qc.invalidateQueries({queryKey: ["project", id]});
            qc.invalidateQueries({queryKey: ["projects"]});
            message.success("已终止测试需求生成")
        }
    });
    const latestRun = query.data?.runs[0];
    useEffect(() => setAutoRetry(latestRun?.autoRetry ?? true), [latestRun?.id, latestRun?.autoRetry]);
    const confirmDebugLeave = useCallback(() => !debugDirty || window.confirm("调试器中有未保存的文件修改，离开将丢失这些修改，是否继续？"), [debugDirty]);
    useEffect(() => {
        const beforeUnload = (event: BeforeUnloadEvent) => {
            if (!debugDirty) return;
            event.preventDefault(); event.returnValue = ""
        };
        window.addEventListener("beforeunload", beforeUnload);
        return () => window.removeEventListener("beforeunload", beforeUnload)
    }, [debugDirty]);
    useLayoutEffect(() => {
        const contentOffset = pendingContentScrollRef.current, content = projectContentRef.current;
        if (contentOffset === undefined || !content) return;
        pendingContentScrollRef.current = undefined;
        if (debugOpen) {
            content.scrollTop = contentOffset
        } else {
            const contentDocumentTop = window.scrollY + content.getBoundingClientRect().top;
            window.scrollTo({top: Math.max(0, contentDocumentTop + contentOffset)})
        }
    }, [debugOpen]);
    if (query.isLoading) return <Shell backTo="/" backLabel="返回项目列表"><Spin/></Shell>;
    if (query.error) {
        return <Shell backTo="/" backLabel="返回项目列表"><Content className="page"><Alert type="warning" showIcon
                                                       message="项目不存在或已被删除"
                                                       description={query.error.message}/></Content></Shell>
    }
    if (!query.data) return <Shell backTo="/" backLabel="返回项目列表"><Spin/></Shell>;
    const p = query.data, latest = p.runs[0];
    const running = latest?.status === "RUNNING" || latest?.status === "QUEUED";
    const runLabel = phase2RunButtonLabel(latest?.status);
    const detail = <Content ref={projectContentRef} className={`page ${debugOpen ? "page-debug-open" : ""}`}><Space><Typography.Title level={3}>{p.name}</Typography.Title><Status value={p.status}/>
        {user?.role === "ADMIN" && <Button type={debugOpen ? "primary" : "default"} icon={<BugOutlined/>} onClick={() => {
            if (debugOpen && !confirmDebugLeave()) return;
            const content = projectContentRef.current;
            if (content && !window.matchMedia("(max-width: 900px)").matches) {
                const contentDocumentTop = window.scrollY + content.getBoundingClientRect().top;
                pendingContentScrollRef.current = debugOpen
                    ? content.scrollTop
                    : Math.max(0, window.scrollY - contentDocumentTop)
            }
            setDebugOpen(value => !value)
        }}>{debugOpen ? "关闭调试模式" : "调试模式"}</Button>}</Space><ChapterStatus project={p} run={latest}/>
        {p.status === "READY_FOR_REVIEW" && <div className="project-workbench-entry">
            <div><b>{reviewSummaryText(p.reviewSummary)}</b>
                <span>可查看、编辑、评审、执行变更分析并导出第三方测试需求</span></div>
            <Button type="primary" onClick={() => nav(`/projects/${id}/review`)}>打开测试需求工作台</Button>
        </div>}
        <Card title="Phase 2测试需求生成"><Progress percent={latest?.progress || 0}
                                                    status={latest?.status === "FAILED" ? "exception" : running ? "active" : "normal"}/>
            <p>当前阶段：{latest?.status === "CANCELLED" ? "已终止" : latest?.currentStage ? stageName(latest.currentStage) : running ? "任务启动中" : latest?.status === "FAILED" ? "生成失败" : "尚未开始"}
                {running && ((latest?.attemptCount || 0) > 1 || ["resume_queued", "retry_queued", "resume_check_artifacts"].includes(latest?.currentStage || "")) &&
                    <Tag color="blue" style={{marginLeft: 8}}>续跑累计进度 {latest?.progress || 0}%</Tag>}</p>
            <Space className="phase2-run-actions"><Button type="primary"
                loading={run.isPending} disabled={running}
                onClick={() => run.mutate({latest, enabled: autoRetry})}>{runLabel}</Button>
            <Checkbox checked={autoRetry} disabled={updateAutoRetry.isPending} onChange={event => {
                const enabled = event.target.checked;
                setAutoRetry(enabled);
                if (latest) updateAutoRetry.mutate({runId: latest.id, enabled})
            }}>失败自动重试</Checkbox>
            {running && latest && <Popconfirm title="终止测试需求生成？"
                                              description="终止后保留已完成阶段工件，并可重新开始生成。"
                                              okText="终止" cancelText="继续运行" okButtonProps={{danger: true}}
                                              onConfirm={() => cancel.mutate(latest.id)}><Button danger
                                                                                                 icon={<StopOutlined/>}
                                                                                                 loading={cancel.isPending}>终止生成</Button></Popconfirm>}</Space>
            {latest?.errorMessage && ["FAILED", "RUNNING", "QUEUED"].includes(latest.status) && <Alert className="phase2-run-feedback" type={latest.status === "FAILED" ? "error" : "warning"} showIcon
                message={latest.status === "FAILED" ? "测试需求生成失败" : "上次执行失败，正在重试"} description={latest.errorMessage}/>}
            {latest?.status === "CANCELLED" && <Alert className="phase2-run-feedback" type="info" showIcon
                message="测试需求生成已终止"/>}
            {(run.error || cancel.error) &&
                <Alert className="phase2-run-feedback" type="error" showIcon
                    message={(run.error || cancel.error)?.message}/>}<RunLogs key={latest?.id || id} run={latest}
                                                                                                       scrollPositions={runLogScrollPositionsRef}
                                                                                                       onEvents={() => qc.invalidateQueries({queryKey: ["project", id]})}/>
        </Card></Content>;
    return <Shell className={debugOpen && user?.role === "ADMIN" ? "project-debug-shell" : ""}
                  backTo="/" backLabel="返回项目列表" beforeLeave={confirmDebugLeave}>{debugOpen && user?.role === "ADMIN" ? <Splitter className="project-debug-splitter">
        <Splitter.Panel min="38%" defaultSize="66%">{detail}</Splitter.Panel>
        <Splitter.Panel min={420} collapsible><DebugFilesPanel projectId={id} running={running} onDirtyChange={setDebugDirty}/></Splitter.Panel>
    </Splitter> : detail}</Shell>
}

type TreeItem = { key: string; title: React.ReactNode; children?: TreeItem[] };

type FloatingPosition = { x: number; y: number };

function EvaluationWindow({open, children, loading, subject, onSubjectClick, onCancel, onSave}: {
    open: boolean;
    children: ReactNode;
    loading: boolean;
    subject?: string;
    onSubjectClick?: () => void;
    onCancel: () => void;
    onSave: () => void
}) {
    const panelRef = useRef<HTMLDivElement>(null), dragRef = useRef<{x: number; y: number} | undefined>(undefined),
        [position, setPosition] = useState<FloatingPosition>();
    const clampPosition = (next: FloatingPosition) => {
        const panel = panelRef.current, margin = 12,
            width = panel?.offsetWidth || Math.min(520, window.innerWidth - margin * 2),
            height = panel?.offsetHeight || Math.min(680, window.innerHeight - margin * 2);
        return {
            x: Math.min(Math.max(next.x, margin), Math.max(margin, window.innerWidth - width - margin)),
            y: Math.min(Math.max(next.y, margin), Math.max(margin, window.innerHeight - height - margin))
        }
    };
    useEffect(() => {
        if (!open) return;
        const frame = requestAnimationFrame(() => {
            const panel = panelRef.current;
            if (!panel) return;
            setPosition(clampPosition({
                x: (window.innerWidth - panel.offsetWidth) / 2,
                y: (window.innerHeight - panel.offsetHeight) / 2
            }))
        });
        return () => cancelAnimationFrame(frame)
    }, [open]);
    useEffect(() => {
        if (!open) return;
        const onKeyDown = (event: KeyboardEvent) => {
                if (event.key === "Escape") onCancel()
            },
            onResize = () => setPosition(current => current ? clampPosition(current) : current);
        window.addEventListener("keydown", onKeyDown);
        window.addEventListener("resize", onResize);
        return () => {
            window.removeEventListener("keydown", onKeyDown);
            window.removeEventListener("resize", onResize)
        }
    }, [open, onCancel]);
    if (!open) return null;
    const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
            if ((event.target as HTMLElement).closest("button")) return;
            const rect = panelRef.current?.getBoundingClientRect();
            if (!rect) return;
            dragRef.current = {x: event.clientX - rect.left, y: event.clientY - rect.top};
            event.currentTarget.setPointerCapture(event.pointerId)
        },
        drag = (event: ReactPointerEvent<HTMLDivElement>) => {
            if (!dragRef.current) return;
            setPosition(clampPosition({x: event.clientX - dragRef.current.x, y: event.clientY - dragRef.current.y}))
        },
        stopDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
            dragRef.current = undefined;
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
        };
    return createPortal(<div ref={panelRef} className="evaluation-window" role="dialog" aria-modal="false"
                             aria-labelledby="evaluation-window-title"
                             style={position ? {left: position.x, top: position.y} : {visibility: "hidden"}}>
        <div className="evaluation-window-titlebar" onPointerDown={startDrag} onPointerMove={drag}
             onPointerUp={stopDrag} onPointerCancel={stopDrag}>
            <div className="evaluation-window-heading">
                <b id="evaluation-window-title">内容质量评估</b>
                {subject && <button type="button" className="evaluation-window-subject" title={subject}
                                    onClick={onSubjectClick}>{subject}</button>}
            </div>
            <Button type="text" icon={<CloseOutlined/>} aria-label="关闭内容质量评估" onClick={onCancel}/>
        </div>
        <div className="evaluation-window-body">{children}</div>
        <div className="evaluation-window-footer">
            <Button onClick={onCancel}>取消</Button>
            <Button type="primary" loading={loading} onClick={onSave}>保存评估</Button>
        </div>
    </div>, window.document.body)
}

function treeOf<T extends {
    id: string;
    parentId?: string | null;
    orderIndex: number
}>(nodes: T[], title: (node: T) => React.ReactNode): TreeItem[] {
    const children = new Map<string | undefined, T[]>();
    nodes.forEach(node => {
        const parentId = node.parentId ?? undefined;
        children.set(parentId, [...(children.get(parentId) || []), node])
    });
    const build = (parentId?: string): TreeItem[] => (children.get(parentId) || []).sort((a, b) => a.orderIndex - b.orderIndex)
        .map(node => ({key: node.id, title: title(node), children: build(node.id)}));
    return build()
}

function Review() {
    const [reviewMessage, reviewMessageContext] = message.useMessage();
    const {id = ""} = useParams(), navigate = useNavigate(), [searchParams] = useSearchParams(),
        qc = useQueryClient(), [documentId, setDocumentId] = useState<string>(), [evalOpen, setEvalOpen] = useState(false),
        [evaluationTargetId, setEvaluationTargetId] = useState<string>(), [scores, setScores] = useState<ReviewScores>({
            correctness: 4,
            coverage: 4,
            testability: 4
        }), [reviewComment, setReviewComment] = useState(""),
        {activeSourceNodeId, activeRequirementId, setSource, setRequirement} = useTraceStore(), data = useQuery({
            queryKey: ["review-data", id],
            queryFn: () => api<ReviewData>(`/projects/${id}/review-data`),
            retry: false,
            refetchInterval: query => (["QUEUED", "RUNNING"] as string[]).includes(query.state.data?.generation?.status || "") ? 3000 : false
        }),
        trace = useQuery({
            queryKey: ["trace-links", id, activeSourceNodeId],
            queryFn: () => api<TraceLink[]>(`/projects/${id}/trace-links?sourceNodeId=${activeSourceNodeId}&includeDescendants=true`),
            enabled: Boolean(activeSourceNodeId)
        }),
        reviews = useQuery({
            queryKey: ["reviews", id],
            queryFn: () => api<ReviewRecord[]>(`/projects/${id}/reviews`),
            retry: false
        });
    const [tracePopoverNodeId, setTracePopoverNodeId] = useState<string>();
    const [sourceNavigationKey, setSourceNavigationKey] = useState(0);
    const [requirementNavigation, setRequirementNavigation] = useState<{targetId: string; key: number}>();
    const requirementDocumentRef = useRef<HTMLElement>(null);
    const [reviewCenterOpen, setReviewCenterOpen] = useState(false);
    const [requirementsDownloadUnavailable, setRequirementsDownloadUnavailable] = useState(false);
    const [reviewFilter, setReviewFilter] = useState<"all" | "reviewed" | "pending">("all");
    const [reviewSearch, setReviewSearch] = useState("");
    const [pendingAttention, setPendingAttention] = useState(false);
    const [documentEditing, setDocumentEditing] = useState(false);
    const [editorDrafts, setEditorDrafts] = useState<Record<string, unknown>>({});
    const [sourceEditBinding, setSourceEditBinding] = useState<Phase2EditBinding>();
    const [tableEditBinding, setTableEditBinding] = useState<Phase2EditBinding>();
    const [sourceModalValues, setSourceModalValues] = useState<string[]>([]);
    const [tableModalValues, setTableModalValues] = useState<string[]>([]);
    const [sourcePickerSearch, setSourcePickerSearch] = useState("");
    const [tablePickerSearch, setTablePickerSearch] = useState("");
    const [tablePreviewId, setTablePreviewId] = useState<string>();
    const [tableOperations, setTableOperations] = useState<Phase2TableOperation[]>([]);
    const [requirementOperations, setRequirementOperations] = useState<Phase2RequirementOperation[]>([]);
    const [referenceOperations, setReferenceOperations] = useState<Phase2ReferenceOperation[]>([]);
    const [versionNameModalOpen, setVersionNameModalOpen] = useState(false);
    const [versionName, setVersionName] = useState("");
    const [submissionLocked, setSubmissionLocked] = useState(false);
    const [editRunId, setEditRunId] = useState<string>();
    const [draftExpectedRevision, setDraftExpectedRevision] = useState<string>();
    const [draftExpectedArtifactRevisions, setDraftExpectedArtifactRevisions] = useState<Record<string, string>>();
    const acknowledgedSavedRun = useRef<string | undefined>(undefined);
    const locatedChapter = useRef<string | undefined>(undefined);
    const currentUser = qc.getQueryData<CurrentUser>(["me"]);
    useEffect(() => {
        const runId = data.data?.generation?.runId, status = data.data?.generation?.status;
        if (!runId || !(["QUEUED", "RUNNING"] as string[]).includes(status || "")) return;
        const source = new EventSource(`/api/phase2-runs/${runId}/events`, {withCredentials: true});
        const refresh = () => {
            void qc.invalidateQueries({queryKey: ["review-data", id]});
            void qc.invalidateQueries({queryKey: ["phase2-editor-inline", id]})
        };
        source.addEventListener("run-events", refresh);
        source.addEventListener("run-state", refresh);
        return () => source.close()
    }, [data.data?.generation?.runId, data.data?.generation?.status, id, qc]);
    const inlineEditor = useQuery({queryKey: ["phase2-editor-inline", id],
        queryFn: () => api<Phase2InlineDescriptor>(`/projects/${id}/phase2-editor-inline`),
        staleTime: Infinity, gcTime: 30 * 60_000,
        refetchInterval: () => (["QUEUED", "RUNNING"] as string[]).includes(data.data?.generation?.status || "") ? 3000 : false});
    const [draftHydratedScope, setDraftHydratedScope] = useState("");
    const draftScope = currentUser ? `${id}:${currentUser.id}` : "";
    useEffect(() => {
        if (!currentUser || !id) return;
        const restored = readPhase2Draft(id, currentUser.id);
        if (restored) {
            setEditorDrafts(restored.editorDrafts);
            setTableOperations(restored.tableOperations);
            setRequirementOperations(restored.requirementOperations);
            setReferenceOperations(restored.referenceOperations);
            setEditRunId(restored.editRunId);
            setDraftExpectedRevision(restored.expectedRevision);
            setDraftExpectedArtifactRevisions(restored.expectedArtifactRevisions);
            setDocumentEditing(true)
        }
        setDraftHydratedScope(draftScope)
    }, [draftScope]);
    useEffect(() => {
        if (draftHydratedScope !== draftScope || !currentUser || !documentEditing) return;
        const hasChanges = Object.keys(editorDrafts).length > 0 || tableOperations.length > 0 || requirementOperations.length > 0 || referenceOperations.length > 0;
        if (!hasChanges && !editRunId) return;
        writePhase2Draft({version: 1, projectId: id, userId: currentUser.id, editorDrafts, tableOperations, requirementOperations, referenceOperations,
            expectedRevision: draftExpectedRevision || inlineEditor.data?.revision,
            expectedArtifactRevisions: draftExpectedArtifactRevisions || inlineEditor.data?.artifact_revisions, editRunId})
    }, [documentEditing, draftHydratedScope, draftScope, currentUser?.id, id, editorDrafts, tableOperations, requirementOperations, referenceOperations, editRunId, draftExpectedRevision, draftExpectedArtifactRevisions, inlineEditor.data?.revision, inlineEditor.data?.artifact_revisions]);
    const clearEditingDraft = useCallback(() => {
        if (currentUser) removePhase2Draft(id, currentUser.id);
        setDocumentEditing(false); setEditorDrafts({}); setTableOperations([]); setRequirementOperations([]); setReferenceOperations([]);
        setVersionNameModalOpen(false); setVersionName(""); setSubmissionLocked(false);
        setSourceEditBinding(undefined); setTableEditBinding(undefined); setEditRunId(undefined); setDraftExpectedRevision(undefined);
        setDraftExpectedArtifactRevisions(undefined)
    }, [currentUser?.id, id]);
    const outboxKey = currentUser ? editTimeOutboxKey(id, currentUser.id) : "";
    const [pendingEditDurationMs, setPendingEditDurationMs] = useState(0);
    const [activeEditDurationMs, setActiveEditDurationMs] = useState(0);
    const editTimeFlushPromise = useRef<Promise<void> | undefined>(undefined);
    const editTimeTracker = useRef<EditingTimeTracker | undefined>(undefined);
    const editTime = useQuery({queryKey: ["edit-time", id], queryFn: () => api<EditTimeSummary>(`/projects/${id}/edit-time`),
        enabled: Boolean(id && currentUser)});
    const refreshPendingDuration = useCallback(() => {
        if (!outboxKey) return setPendingEditDurationMs(0);
        setPendingEditDurationMs(readEditTimeOutbox(outboxKey).reduce((sum, segment) => sum + segment.durationMs, 0))
    }, [outboxKey]);
    const flushEditTime = useCallback(async (keepalive = false) => {
        if (!outboxKey) return;
        if (editTimeFlushPromise.current) return editTimeFlushPromise.current;
        const run = (async () => {
            while (true) {
                const segments = readEditTimeOutbox(outboxKey).slice(0, 100);
                if (!segments.length) return;
                try {
                    const summary = await api<EditTimeSummary>(`/projects/${id}/edit-time/segments`, {
                        method: "POST", keepalive, body: JSON.stringify({segments})
                    });
                    removeEditTimeOutbox(outboxKey, segments.map(segment => segment.id));
                    qc.setQueryData(["edit-time", id], summary);
                    refreshPendingDuration()
                } catch {
                    refreshPendingDuration();
                    return
                }
            }
        })();
        editTimeFlushPromise.current = run;
        try { await run } finally { editTimeFlushPromise.current = undefined }
    }, [id, outboxKey, qc, refreshPendingDuration]);
    useEffect(() => {
        if (!outboxKey) return;
        refreshPendingDuration();
        const tracker = new EditingTimeTracker(segment => {
            appendEditTimeOutbox(outboxKey, segment);
            refreshPendingDuration();
            void flushEditTime()
        });
        editTimeTracker.current = tracker;
        void flushEditTime();
        const tick = window.setInterval(() => setActiveEditDurationMs(tracker.activeDurationMs()), 1000);
        const stopAndFlush = () => { tracker.stop(); setActiveEditDurationMs(0); void flushEditTime(true) };
        const onVisibility = () => { if (document.visibilityState === "hidden") stopAndFlush() };
        document.addEventListener("visibilitychange", onVisibility);
        window.addEventListener("pagehide", stopAndFlush);
        return () => {
            window.clearInterval(tick);
            document.removeEventListener("visibilitychange", onVisibility);
            window.removeEventListener("pagehide", stopAndFlush);
            tracker.dispose();
            editTimeTracker.current = undefined
        }
    }, [flushEditTime, outboxKey, refreshPendingDuration]);
    const recordEditActivity = useCallback(() => editTimeTracker.current?.recordActivity(), []);
    const stopEditActivity = useCallback(() => { editTimeTracker.current?.stop(); setActiveEditDurationMs(0) }, []);
    useEffect(() => {
        if (!documentEditing) return;
        const warnAboutUnsubmittedForm = (event: BeforeUnloadEvent) => {
            event.preventDefault();
            event.returnValue = "有表单仍未提交";
            return event.returnValue
        };
        window.addEventListener("beforeunload", warnAboutUnsubmittedForm);
        return () => window.removeEventListener("beforeunload", warnAboutUnsubmittedForm)
    }, [documentEditing]);
    const editRun = useQuery({queryKey: ["phase2-edit-run", editRunId],
        queryFn: () => api<Phase2EditRun>(`/phase2-edit-runs/${editRunId}`), enabled: Boolean(editRunId),
        refetchInterval: query => (["QUEUED", "RUNNING"] as string[]).includes(query.state.data?.status || "") ? 1000 : false});
    const rebuilding = Boolean(editRunId && (["QUEUED", "RUNNING"] as string[]).includes(editRun.data?.status || "QUEUED"));
    const failedDraft = editRun.data?.draftStatus === "PUBLISH_FAILED";
    const interactionLocked = submissionLocked || rebuilding || failedDraft;
    const [publicationWarnings, setPublicationWarnings] = useState<{warnings: string[]; skippedCount: number} | undefined>();
    useEffect(() => {
        if (!editRun.data?.savedAt || acknowledgedSavedRun.current === editRun.data.id) return;
        acknowledgedSavedRun.current = editRun.data.id;
        stopEditActivity();
        message.success("修改已保存，测试需求文档正在后台发布")
    }, [editRun.data?.savedAt, editRun.data?.id, stopEditActivity]);
    useEffect(() => {
        if (editRun.data?.status === "SUCCEEDED") {
            stopEditActivity();
            if (editRun.data.warnings?.length) setPublicationWarnings({warnings: editRun.data.warnings, skippedCount: editRun.data.skippedCount || 0});
            clearEditingDraft();
            void qc.invalidateQueries({queryKey: ["phase2-editor-inline", id]});
            void qc.invalidateQueries({queryKey: ["review-data", id]});
            void qc.invalidateQueries({queryKey: ["reviews", id]});
            message.success(editRun.data.warnings?.length ? "修改已发布，但存在容错警告" : "修改已发布")
        } else if (editRun.data?.status === "CANCELLED" && editRun.data?.currentStage === "discarded") {
            stopEditActivity(); clearEditingDraft(); setSubmissionLocked(false); setDocumentEditing(false);
            void qc.invalidateQueries({queryKey: ["phase2-editor-inline", id]});
            void qc.invalidateQueries({queryKey: ["review-data", id]});
            void qc.invalidateQueries({queryKey: ["reviews", id]});
            void qc.invalidateQueries({queryKey: ["project", id]});
            message.success("已放弃编辑稿并恢复上一发布版本")
        } else if (editRun.data?.status === "FAILED") {
            stopEditActivity();
            setSubmissionLocked(false);
            setDocumentEditing(false);
            setSourceEditBinding(undefined); setTableEditBinding(undefined);
            void qc.invalidateQueries({queryKey: ["phase2-editor-inline", id]});
            void qc.invalidateQueries({queryKey: ["project", id]})
        }
    }, [editRun.data?.status, id, qc, stopEditActivity, clearEditingDraft]);
    const saveInlineEdit = useMutation({mutationFn: (requestedVersionName: string) => api<Phase2EditRun>(`/projects/${id}/phase2-edits/batch`, {
        method: "POST", body: JSON.stringify({expected_revision: draftExpectedRevision || inlineEditor.data?.revision,
            expected_artifact_revisions: draftExpectedArtifactRevisions || inlineEditor.data?.artifact_revisions,
            version_name: requestedVersionName.trim(),
            changes: Object.entries(editorDrafts).map(([edit_key, value]) => ({edit_key, value})),
            table_operations: tableOperations.map(({draft_key: _draftKey, ...operation}) => operation),
            requirement_operations: requirementOperations.map(({draft_key: _draftKey, ...operation}) => operation),
            reference_operations: referenceOperations.map(({draft_key: _draftKey, ...operation}) => operation)})
    }), onMutate: () => setSubmissionLocked(true), onSuccess: run => setEditRunId(run.id), onError: error => { setSubmissionLocked(false); message.error(error.message) }});
    const retryPublication = useMutation({mutationFn: () => api<Phase2EditRun>(`/phase2-edit-runs/${editRunId}/retry`, {method: "POST"}),
        onMutate: () => setSubmissionLocked(true),
        onSuccess: run => { setEditRunId(run.id); void editRun.refetch() }, onError: error => { setSubmissionLocked(false); message.error(error.message) }});
    const discardDraft = useMutation({mutationFn: () => api<Phase2EditRun>(`/phase2-edit-runs/${editRunId}/discard`, {method: "POST"}),
        onMutate: () => setSubmissionLocked(true), onSuccess: run => { setEditRunId(run.id); void editRun.refetch() },
        onError: error => { setSubmissionLocked(false); message.error(error.message) }});
    const [mainSizes, setMainSizes] = useState<SplitSizes | undefined>(() => loadSplitSizes("main"));
    const [sourceDirectoryOpen, setSourceDirectoryOpen] = useState(false);
    const [requirementDirectoryOpen, setRequirementDirectoryOpen] = useState(false);
    const sourceCloseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const requirementCloseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const tracePopoverNodeIdRef = useRef(tracePopoverNodeId);
    tracePopoverNodeIdRef.current = tracePopoverNodeId;
    const cancelDirectoryClose = (timer: typeof sourceCloseTimer) => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = undefined
    };
    const scheduleSourceDirectoryClose = () => {
        cancelDirectoryClose(sourceCloseTimer);
        sourceCloseTimer.current = setTimeout(() => {
            if (!tracePopoverNodeIdRef.current) setSourceDirectoryOpen(false)
        }, 300)
    };
    const scheduleRequirementDirectoryClose = () => {
        cancelDirectoryClose(requirementCloseTimer);
        requirementCloseTimer.current = setTimeout(() => setRequirementDirectoryOpen(false), 300)
    };
    useEffect(() => {
        if (!documentId && data.data?.documents[0]) setDocumentId(data.data.documents[0].id)
    }, [data.data, documentId]);
    const selectedDocument = data.data?.documents.find(item => item.id === documentId),
        requirements = data.data?.requirements || [],
        generation = data.data?.generation,
        generationActive = (["QUEUED", "RUNNING"] as string[]).includes(generation?.status || ""),
        generationFinalizing = generationActive && ["generate_phase2_traceability", "finalize_phase2_document"]
            .includes(String(generation?.currentStage || "").split(":", 1)[0]),
        selectedRequirement = requirements.find(item => item.id === activeRequirementId) || requirements[0],
        sourceCounts = useMemo(() => new Map((data.data?.links || []).map(link => link.sourceNodeId).map((sourceId, _, all) => [sourceId, all.filter(item => item === sourceId).length])), [data.data?.links]),
        requirementTree = useMemo(() => treeOf(requirements.filter(node => node.nodeType !== "requirement"), node =>
            <span>{node.number ? `${node.number} ` : ""}{node.title}</span>), [requirements]);
    const latestReviews = useMemo(() => {
        const latest = new Map<string, ReviewRecord>();
        for (const review of reviews.data || []) if (!latest.has(review.nodeId)) latest.set(review.nodeId, review);
        return latest
    }, [reviews.data]);
    const evaluationTarget = requirements.find(item => item.id === evaluationTargetId);
    const reviewScores = useMemo(() => Object.fromEntries([...latestReviews].map(([nodeId, review]) => [nodeId, review.weightedScore])), [latestReviews]);
    const requirementById = useMemo(() => new Map(requirements.map(item => [item.id, item])), [requirements]);
    const reviewItems = useMemo(() => (data.data?.phase2Document?.chapters || []).flatMap(chapter => chapter.blocks)
        .filter(block => block.type === "heading" && block.evaluable === true && Boolean(block.anchorId))
        .map(block => {
            const node = requirementById.get(block.anchorId!), review = latestReviews.get(block.anchorId!);
            return {
                id: block.anchorId!,
                number: node?.number || "",
                title: node?.title || block.text || "未命名评审项",
                review
            }
        }), [data.data?.phase2Document?.chapters, requirementById, latestReviews]);
    const reviewedCount = reviewItems.filter(item => Boolean(item.review)).length;
    const pendingCount = reviewItems.length - reviewedCount;
    const reviewPercent = reviewItems.length ? Math.round(reviewedCount / reviewItems.length * 100) : 0;
    const saveReview = useMutation({
        mutationFn: () => {
            if (!evaluationTargetId) throw new Error("未选择评估节点");
            return api<ReviewRecord>(`/projects/${id}/reviews`, {
                method: "POST",
                body: JSON.stringify({nodeId: evaluationTargetId, scores, comment: reviewComment})
            })
        },
        onSuccess: async () => {
            await qc.invalidateQueries({queryKey: ["reviews", id]});
            setEvalOpen(false);
            message.success("评估已保存")
        }
    });
    const downloadRequirements = useMutation({
        mutationFn: () => downloadApi(`/projects/${id}/test-requirements-docx`),
        onSuccess: result => {
            setRequirementsDownloadUnavailable(false);
            saveDownload(result.blob, result.filename);
            message.success("第三方测试需求下载完成")
        },
        onError: error => {
            if (error instanceof ApiError && error.status === 404) {
                setRequirementsDownloadUnavailable(true);
                Modal.info({
                    title: "需求文档尚未生成",
                    content: "当前项目还没有可下载的第三方测试需求文档。请继续生成并等待报告生成完成后再下载。",
                    okText: "知道了"
                });
                return
            }
            message.error(error.message)
        }
    });
    const exportReport = useMutation({
        mutationFn: async () => {
            stopEditActivity();
            await flushEditTime();
            return downloadApi(`/projects/${id}/review-report`)
        },
        onSuccess: result => {
            saveDownload(result.blob, result.filename);
            message.success("评审报告下载完成")
        },
        onError: error => {
            if (error instanceof ApiError && error.status === 409 && Array.isArray(error.details?.missingReviews)) {
                setReviewCenterOpen(true);
                setReviewFilter("pending");
                setPendingAttention(true);
                reviewMessage.warning("仍有测试需求尚未完成评审")
            } else message.error(error.message)
        }
    });
    useEffect(() => {
        if (!activeRequirementId && requirements[0]) setRequirement(requirements[0].id)
    }, [requirements, activeRequirementId]);
    useEffect(() => {
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key === "Escape") setTracePopoverNodeId(undefined)
        };
        window.addEventListener("keydown", closeOnEscape);
        return () => window.removeEventListener("keydown", closeOnEscape)
    }, []);
    useEffect(() => () => {
        cancelDirectoryClose(sourceCloseTimer);
        cancelDirectoryClose(requirementCloseTimer)
    }, []);
    const gotoRequirement = (targetId: string) => {
            setTracePopoverNodeId(undefined);
            setSourceDirectoryOpen(false);
            setRequirementDirectoryOpen(false);
            setRequirement(targetId);
            setRequirementNavigation(current => ({targetId, key: (current?.key || 0) + 1}))
        },
        gotoSource = (link: TraceLink) => {
            setRequirementDirectoryOpen(false);
            setDocumentId(link.sourceNode.document?.id);
            setSource(link.sourceNodeId);
            setSourceNavigationKey(value => value + 1)
        },
        total = scores.correctness * .4 + scores.coverage * .35 + scores.testability * .25,
        grade = total >= 4.5 ? "优秀" : total >= 3.5 ? "良好" : total >= 2.5 ? "合格" : "不合格",
        openEvaluation = (targetId: string) => {
            if (evalOpen) {
                reviewMessage.warning("已有内容质量评估窗口，请先保存或关闭当前窗口");
                return false
            }
            const latest = latestReviews.get(targetId);
            setRequirement(targetId);
            setEvaluationTargetId(targetId);
            setScores({
                correctness: Number(latest?.scores.correctness ?? 4),
                coverage: Number(latest?.scores.coverage ?? 4),
                testability: Number(latest?.scores.testability ?? 4)
            });
            setReviewComment(latest?.comment || "");
            saveReview.reset();
            setEvalOpen(true);
            return true
        };
    useLayoutEffect(() => {
        if (!requirementNavigation) return;
        const pane = requirementDocumentRef.current;
        if (!pane) return;
        let firstFrame = 0, secondFrame = 0, stopTimer: ReturnType<typeof setTimeout> | undefined;
        let resizeObserver: ResizeObserver | undefined;
        const target = () => {
            const element = pane.ownerDocument.getElementById(`requirement-${requirementNavigation.targetId}`);
            return element instanceof HTMLElement && pane.contains(element) ? element : undefined
        };
        const scroll = (behavior: ScrollBehavior) => {
            const element = target();
            if (!element) return false;
            pane.scrollTo({
                top: requirementScrollTop({
                    currentScrollTop: pane.scrollTop,
                    containerTop: pane.getBoundingClientRect().top,
                    targetTop: element.getBoundingClientRect().top,
                    scrollHeight: pane.scrollHeight,
                    clientHeight: pane.clientHeight
                }),
                behavior
            });
            return true
        };
        firstFrame = requestAnimationFrame(() => {
            secondFrame = requestAnimationFrame(() => {
                if (!scroll("smooth")) return;
                const documentRoot = pane.querySelector<HTMLElement>(".phase2-document");
                if (documentRoot && typeof ResizeObserver !== "undefined") {
                    resizeObserver = new ResizeObserver(() => scroll("auto"));
                    resizeObserver.observe(documentRoot)
                }
                stopTimer = setTimeout(() => resizeObserver?.disconnect(), 800)
            })
        });
        return () => {
            cancelAnimationFrame(firstFrame);
            cancelAnimationFrame(secondFrame);
            if (stopTimer) clearTimeout(stopTimer);
            resizeObserver?.disconnect()
        }
    }, [requirementNavigation, data.data?.phase2Document?.chapters]);
    useEffect(() => {
        const chapter = searchParams.get("chapter")?.trim();
        if (!chapter || locatedChapter.current === chapter) return;
        const target = requirements.find(node => node.nodeType === "section" && node.number === chapter);
        if (!target) return;
        locatedChapter.current = chapter;
        gotoRequirement(target.id)
    }, [searchParams, requirements]);
    const uniqueTraceLinks = [...new Map((trace.data || []).map(link => [link.targetNodeId, link])).values()],
        sectionLinks = uniqueTraceLinks.filter(link => link.targetNode.nodeType !== "requirement"),
        requirementLinks = uniqueTraceLinks.filter(link => link.targetNode.nodeType === "requirement"),
        traceGroup = (title: string, links: TraceLink[], compact = false) => links.length ?
            <section className="trace-popover-group"><b>{title}</b><List size="small" dataSource={links}
                                                                         renderItem={link => <List.Item
                                                                             onClick={() => gotoRequirement(link.targetNodeId)}>
                                                                             <div
                                                                                 className={compact ? "trace-target trace-target-compact" : "trace-target"}>
                                                                                 <span
                                                                                     className="trace-target-number">{link.targetNode.number}</span>
                                                                                 {compact ? <Tooltip
                                                                                         title={link.targetNode.title}><span
                                                                                         className="trace-target-summary">{link.targetNode.title}</span></Tooltip> :
                                                                                     <span>{link.targetNode.title}</span>}
                                                                             </div>
                                                                             {link.direct ?
                                                                                 <Tag color="green">直接</Tag> :
                                                                                 <Tag>子章节</Tag>}
                                                                         </List.Item>}/></section> : null,
        traceContent = <div className="trace-popover-content">{trace.isLoading ?
            <Spin/> : uniqueTraceLinks.length ? <>{traceGroup("测试章节", sectionLinks)}{traceGroup("测试需求TR", requirementLinks, true)}</> :
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前章节暂无追溯"/>}</div>,
        sourceTree = treeOf(selectedDocument?.nodes || [], node => <Popover open={tracePopoverNodeId === node.id}
                                                                            placement="rightTop" trigger="click" arrow
                                                                            autoAdjustOverflow
                                                                            getPopupContainer={() => window.document.body}
                                                                            overlayClassName="trace-popover"
                                                                            title={`${node.number && node.number !== "PREAMBLE" ? node.number : node.title} 的追溯关系`}
                                                                            content={traceContent}
                                                                            onOpenChange={open => {
                                                                                if (open) {
                                                                                    cancelDirectoryClose(sourceCloseTimer);
                                                                                    setSourceDirectoryOpen(true);
                                                                                    setSource(node.id);
                                                                                    setTracePopoverNodeId(node.id)
                                                                                } else if (tracePopoverNodeId === node.id) {
                                                                                    setTracePopoverNodeId(undefined);
                                                                                    scheduleSourceDirectoryClose()
                                                                                }
                                                                            }}><span
            className="source-tree-title">{node.number && node.number !== "PREAMBLE" ? `${node.number} ` : ""}{node.title}{sourceCounts.get(node.id) ?
            <Badge count={sourceCounts.get(node.id)} className="trace-count"/> : null}</span></Popover>),
        sourceNodeMap = new Map((selectedDocument?.nodes || []).map(node => [node.id, node])),
        isInsideCollapsedNode = (collapsedId: string, nodeId: string) => {
            let currentId: string | undefined = nodeId;
            while (currentId) {
                if (currentId === collapsedId) return true;
                currentId = sourceNodeMap.get(currentId)?.parentId || undefined
            }
            return false
        };
    if (data.isLoading) return <Spin fullscreen/>;
    if (data.error) return <Shell backTo={`/projects/${id}`}><Alert type="error" message="评审数据加载失败"
                                                                    description={data.error.message}/></Shell>;
    const generationTail = generationActive ? <div className="phase2-generation-tail" role="status" aria-live="polite">
            <Spin size="small"/><span>后续章节仍在生成 · {generation?.currentStage ? stageName(generation.currentStage) : "任务启动中"}</span>
        </div> : generation?.status === "FAILED" || generation?.status === "CANCELLED" ?
            <div className="phase2-generation-tail phase2-generation-ended" role="status">
                {generation.status === "FAILED" ? "生成已失败，以上为当前已完成内容" : "生成已终止，以上为当前已完成内容"}
            </div> : null;
    const requestedChapter = searchParams.get("chapter")?.trim(),
        validRequestedChapter = requestedChapter && CHAPTERS.some(item => item[3] === requestedChapter),
        requestedChapterAvailable = requestedChapter && requirements.some(node => node.nodeType === "section" && node.number === requestedChapter);
    const sourceDirectory = <aside className="tree-pane review-tree-pane"><Typography.Title
        level={5}>源文档</Typography.Title>
        <Select style={{width: "100%"}} value={documentId} onChange={value => {
            setTracePopoverNodeId(undefined);
            setDocumentId(value);
            setSource(undefined)
        }} options={data.data?.documents.map(item => ({value: item.id, label: item.name}))}/>
        {selectedDocument?.parseStatus === "FAILED" &&
            <Alert type="error" message="DOCX结构解析失败" description={selectedDocument.parseError}/>}<Tree blockNode
                                                                                                             showLine
                                                                                                             treeData={sourceTree}
                                                                                                             selectedKeys={activeSourceNodeId ? [activeSourceNodeId] : []}
                                                                                                             defaultExpandAll
                                                                                                             onExpand={(_, info) => {
                                                                                                                 if (!info.expanded && tracePopoverNodeId && isInsideCollapsedNode(String(info.node.key), tracePopoverNodeId)) setTracePopoverNodeId(undefined)
                                                                                                             }}
                                                                                                             onSelect={keys => {
                                                                                                                 setSource(String(keys[0] || ""));
                                                                                                                 setTimeout(() => {
                                                                                                                     if (!tracePopoverNodeIdRef.current) setSourceDirectoryOpen(false)
                                                                                                                 }, 50)
                                                                                                             }}/>
    </aside>;
    const sourceDocument = <main className="document docx-pane review-document-pane"><DocxPreview
        documentId={documentId} nodes={selectedDocument?.nodes || []} activeNodeId={activeSourceNodeId}
        navigationKey={sourceNavigationKey}
        onNodeClick={setSource}/></main>;
    const requirementDirectory = <aside className="tree-pane review-tree-pane"><Typography.Title
        level={5}>测试需求目录</Typography.Title><Tree blockNode showLine treeData={requirementTree}
                                                       selectedKeys={selectedRequirement ? [selectedRequirement.id] : []}
                                                       defaultExpandAll
                                                       onSelect={keys => gotoRequirement(String(keys[0] || ""))}/>{generationTail}
    </aside>;
    const requirementDocument = <main ref={requirementDocumentRef} className="document requirement-pane review-document-pane"
        onChangeCapture={documentEditing ? recordEditActivity : undefined}
        onBlurCapture={documentEditing ? stopEditActivity : undefined}><Phase2DocumentRenderer
        chapters={data.data?.phase2Document?.chapters || []} links={data.data?.links || []}
        activeId={selectedRequirement?.id} onSource={gotoSource} onEvaluate={openEvaluation} evaluationDisabled={generationActive}
        reviewScores={reviewScores} editing={documentEditing} drafts={editorDrafts}
        onDraft={(binding, value) => { if (interactionLocked) return; recordEditActivity(); setEditorDrafts(current => ({...current, [binding.edit_key]: value})) }}
        onEditSources={binding => {
            if (interactionLocked) return;
            setSourceEditBinding(binding);
            setSourceModalValues([...((editorDrafts[binding.edit_key] ?? binding.value) as string[])]);
            setSourcePickerSearch("")
        }} onEditTables={binding => {
            if (interactionLocked) return;
            setTableEditBinding(binding);
            setTableModalValues([...((editorDrafts[binding.edit_key] ?? binding.value) as string[])]);
            setTablePickerSearch("");
            setTablePreviewId(undefined)
        }} tableOperations={tableOperations} requirementOperations={requirementOperations} referenceOperations={referenceOperations}
        availableTables={inlineEditor.data?.available_tables || []}
        availableSourceRefs={inlineEditor.data?.available_source_refs || []}
        onTableOperation={operation => { if (interactionLocked) return; recordEditActivity(); setTableOperations(current => {
            if (operation.draft_key) {
                const duplicate = current.findIndex(item => item.draft_key === operation.draft_key);
                if (duplicate >= 0) {
                    if (operation.initial_value === undefined) return current.filter((_, index) => index !== duplicate);
                    return current.map((item, index) => index === duplicate ? operation : item)
                }
            }
            if (operation.operation === "delete_row" || operation.operation === "delete_column") {
                const duplicate = current.findIndex(item => item.operation === operation.operation && item.container_key === operation.container_key
                    && item.row_key === operation.row_key && item.column_key === operation.column_key);
                if (duplicate >= 0) return current.filter((_, index) => index !== duplicate)
            }
            return [...current, operation]
        }) }} onRequirementOperation={operation => { if (interactionLocked) return; recordEditActivity(); setRequirementOperations(current => {
            if (operation.draft_key) {
                const duplicate = current.findIndex(item => item.draft_key === operation.draft_key);
                if (duplicate >= 0) {
                    if (operation.initial_value === undefined) return current.filter((_, index) => index !== duplicate);
                    return current.map((item, index) => index === duplicate ? operation : item)
                }
            }
            if (operation.operation === "delete_requirement") {
                const duplicate = current.findIndex(item => item.operation === operation.operation && item.requirement_key === operation.requirement_key);
                if (duplicate >= 0) return current.filter((_, index) => index !== duplicate)
            }
            return [...current, operation]
        }) }} onReferenceOperation={operation => { if (interactionLocked) return; recordEditActivity(); setReferenceOperations(current => {
            if (operation.draft_key) {
                const draftIndex = current.findIndex(item => item.draft_key === operation.draft_key);
                if (draftIndex >= 0) {
                    if (operation.initial_value === undefined) return current.filter((_, index) => index !== draftIndex);
                    return current.map((item, index) => index === draftIndex ? operation : item)
                }
            }
            if (operation.operation === "update_reference" && operation.reference_key) {
                return [...current.filter(item => !(item.operation === "update_reference" && item.container_key === operation.container_key
                    && item.reference_key?.toLocaleUpperCase() === operation.reference_key?.toLocaleUpperCase())), operation]
            }
            if (operation.operation === "delete_reference" && operation.reference_key) {
                const sameKey = (item: Phase2ReferenceOperation) => item.container_key === operation.container_key
                    && item.reference_key?.toLocaleUpperCase() === operation.reference_key?.toLocaleUpperCase();
                const existingDelete = current.find(item => item.operation === "delete_reference" && sameKey(item));
                if (existingDelete) return current.filter(item => item !== existingDelete);
                return [...current.filter(item => !(item.operation === "update_reference" && sameKey(item))), operation]
            }
            return [...current, operation]
        }) }} onEditActivityEnd={stopEditActivity} readOnly={interactionLocked} interactionLocked={interactionLocked}/>{generationTail}</main>;
    const persist = (name: string, setter: (sizes: SplitSizes) => void, threshold: number, bothSides: boolean) => (sizes: number[]) => {
        const next = snappedSizes(sizes, threshold, bothSides);
        setter(next);
        saveSplitSizes(name, next)
    };
    const hoverDirectory = (kind: "source" | "requirement", open: boolean) => {
        const timer = kind === "source" ? sourceCloseTimer : requirementCloseTimer;
        cancelDirectoryClose(timer);
        if (open) (kind === "source" ? setSourceDirectoryOpen : setRequirementDirectoryOpen)(true);
        else (kind === "source" ? scheduleSourceDirectoryClose : scheduleRequirementDirectoryClose)()
    };
    const workspace = (kind: "source" | "requirement", directory: React.ReactNode, documentPane: React.ReactNode,
        toolbar?: React.ReactNode) => {
        const open = kind === "source" ? sourceDirectoryOpen : requirementDirectoryOpen;
        const setOpen = kind === "source" ? setSourceDirectoryOpen : setRequirementDirectoryOpen;
        const label = kind === "source" ? "源文档目录" : "测试需求目录";
        return <div className={`review-workspace review-workspace-${kind}`}>
            {toolbar}
            <div className="review-workspace-body"><button type="button" className={`directory-hover-rail${open ? " is-open" : ""}`} aria-label={label}
                    aria-expanded={open}
                    onMouseEnter={() => hoverDirectory(kind, true)} onMouseLeave={() => hoverDirectory(kind, false)}
                    onClick={() => {
                        cancelDirectoryClose(kind === "source" ? sourceCloseTimer : requirementCloseTimer);
                        setOpen(!open)
                    }}>
                <MenuUnfoldOutlined/><span className="directory-hover-rail-label">目录</span>
            </button>
            <div className={`directory-overlay directory-overlay-${kind}${open ? " is-open" : ""}`}
                 onMouseEnter={() => hoverDirectory(kind, true)} onMouseLeave={() => hoverDirectory(kind, false)}>
                {directory}
            </div>
            <div className="review-workspace-document" onMouseDown={() => {
                if (kind === "requirement" || !tracePopoverNodeIdRef.current) setOpen(false)
            }}>{documentPane}</div></div>
        </div>
    };
    const normalizedSearch = reviewSearch.trim().toLowerCase();
    const visibleReviewItems = reviewItems.filter(item => {
        if (reviewFilter === "reviewed" && !item.review) return false;
        if (reviewFilter === "pending" && item.review) return false;
        return !normalizedSearch || `${item.number} ${item.title}`.toLowerCase().includes(normalizedSearch)
    });
    const reviewGroups = [
        {key: "other", title: "其他章节", match: (number: string) => /^(1|2)(\.|$)/.test(number)},
        {key: "hardware", title: "硬件接口", match: (number: string) => /^3\.1(?:\.|$)/.test(number)},
        {key: "functional", title: "功能需求", match: (number: string) => /^4\.1(?:\.|$)/.test(number)},
        {key: "nonfunctional", title: "非功能需求", match: (number: string) => /^4\.[2-9](?:\.|$)/.test(number)}
    ].map(group => ({...group, items: visibleReviewItems.filter(item => group.match(item.number))}))
        .filter(group => group.items.length);
    const gotoReviewItem = (targetId: string) => {
        setReviewCenterOpen(false);
        gotoRequirement(targetId)
    };
    const evaluateReviewItem = (targetId: string) => {
        if (!openEvaluation(targetId)) return;
        setReviewCenterOpen(false);
        gotoRequirement(targetId)
    };
    const handleReviewExport = () => {
        if (pendingCount) {
            setReviewFilter("pending");
            setReviewSearch("");
            setPendingAttention(true);
            reviewMessage.warning(`还有 ${pendingCount} 项未评审，完成后即可下载评审报告`);
            return
        }
        exportReport.mutate()
    };
    const sourceOptions = [...new Map((inlineEditor.data?.available_source_refs || []).map(option => [option.value, option])).values()];
    const sourceOptionMap = new Map(sourceOptions.map(option => [option.value, option]));
    const sourceLabel = (value: string) => {
        const option = sourceOptionMap.get(value);
        return option ? `${option.document_name} ${option.number || option.title}` : value
    };
    const tableOptions = inlineEditor.data?.available_tables || [];
    const tableOptionMap = new Map(tableOptions.map(option => [option.table_id, option]));
    const tableDocumentName = (value: string) => value.split(/[\\/]/).filter(Boolean).at(-1) || value;
    const tableLabel = (value: string) => {
        const option = tableOptionMap.get(value);
        return option ? `${tableDocumentName(option.document_name)} ${option.section_number || option.section_title} · ${option.title}` : value
    };
    const sourceNeedle = sourcePickerSearch.trim().toLowerCase();
    const visibleSourceOptions = sourceOptions.filter(option => !sourceNeedle || [option.document_name, option.number, option.title, ...(option.path_titles || [])]
        .join(" ").toLowerCase().includes(sourceNeedle));
    const tableNeedle = tablePickerSearch.trim().toLowerCase();
    const visibleTableOptions = tableOptions.filter(option => tableNeedle
        ? [option.document_name, option.section_number, option.section_title, option.title].join(" ").toLowerCase().includes(tableNeedle)
        : tableModalValues.includes(option.table_id)).slice(0, 30);
    const previewTable = tableOptionMap.get(tablePreviewId || "");
    const toggleTableSelection = (tableId: string, checked?: boolean) => { recordEditActivity(); setTableModalValues(current => {
        const shouldSelect = checked ?? !current.includes(tableId);
        return shouldSelect ? [...new Set([...current, tableId])] : current.filter(item => item !== tableId)
    }) };
    const displayedMyEditDuration = (editTime.data?.myDurationMs || 0) + pendingEditDurationMs + activeEditDurationMs;
    const displayedProjectEditDuration = (editTime.data?.projectDurationMs || 0) + pendingEditDurationMs + activeEditDurationMs;
    const compactEditDuration = (durationMs: number) => {
        const totalSeconds = Math.floor(Math.max(0, durationMs) / 1000);
        const hours = Math.floor(totalSeconds / 3600), minutes = Math.floor(totalSeconds % 3600 / 60), seconds = totalSeconds % 60;
        return hours ? `${hours}小时${minutes}分` : minutes ? `${minutes}分${seconds}秒` : `${seconds}秒`
    };
    const editTimeDetails = <div className="edit-time-popover">
        <b>编辑用时</b>
        <div><span>我的编辑用时</span><strong>{formatEditDuration(displayedMyEditDuration)}</strong></div>
        <div><span>项目总编辑用时</span><strong>{formatEditDuration(displayedProjectEditDuration)}</strong></div>
        <small>仅统计文档编辑状态下的有效操作时间</small>
    </div>;
    const changeCount = Object.keys(editorDrafts).length + tableOperations.length + requirementOperations.length + referenceOperations.length;
    const requirementToolbar = <div className="requirement-toolbar">
        <div className="requirement-toolbar-context"><strong>第三方测试需求</strong>
            <Popover content={editTimeDetails} trigger={["hover", "click"]} placement="bottomRight">
                <button type="button" className="edit-time-summary" aria-label="查看编辑用时详情">
                    <ClockCircleOutlined/><span>编辑用时</span><strong>{compactEditDuration(displayedMyEditDuration)}</strong>
                </button>
            </Popover>
            {documentEditing ? <span className="requirement-edit-status">已修改 {changeCount} 项</span> :
                <button type="button" className={`review-progress-summary ${pendingCount ? "is-pending" : "is-complete"}`}
                        disabled={interactionLocked} onClick={() => {
                            setPendingAttention(false);
                            setReviewCenterOpen(true)
                        }}>{pendingCount ? <Badge status="warning"/> : <CheckCircleFilled/>}
                        <span>{pendingCount ? `评审进度 ${reviewedCount}/${reviewItems.length}` : "评审已完成"}</span>
                    </button>}
        </div>
        <Space wrap className="requirement-toolbar-actions">{!documentEditing ? <>
            <Button type="primary" className="phase2-edit-button" icon={<EditOutlined/>}
                    disabled={interactionLocked || inlineEditor.isLoading} loading={inlineEditor.isLoading}
                    onClick={() => { setEditorDrafts({}); setDraftExpectedRevision(inlineEditor.data?.revision);
                        setDraftExpectedArtifactRevisions(inlineEditor.data?.artifact_revisions); setDocumentEditing(true) }}>编辑文档</Button>
            <Tooltip title={requirementsDownloadUnavailable ? "需求文档尚未生成，请完成生成流程后再下载" : "下载第三方测试需求 DOCX"}><Button icon={<DownloadOutlined/>}
                    disabled={interactionLocked || generationActive || requirementsDownloadUnavailable} loading={downloadRequirements.isPending}
                    onClick={() => downloadRequirements.mutate()}>下载需求文档</Button></Tooltip>
            <Dropdown trigger={["click"]} placement="bottomRight" menu={{items: [{
                key: "reviews", icon: pendingCount ? undefined : <CheckCircleFilled className="review-menu-complete"/>,
                label: <span className="review-menu-label"><span>评审中心</span>
                    {pendingCount ? <Tag color="orange">待评 {pendingCount}</Tag> : <span className="review-menu-complete">已完成</span>}</span>,
                disabled: interactionLocked || generationActive,
                onClick: () => { setPendingAttention(false); setReviewCenterOpen(true) }
            }, {
                key: "diff", label: "变更分析", disabled: interactionLocked || generationActive,
                onClick: () => navigate(`/projects/${id}/requirement-diff`)
            }]}}><Button icon={<EllipsisOutlined/>} disabled={interactionLocked}>更多</Button></Dropdown>
        </> : <>
            <Button disabled={interactionLocked} onClick={() => { stopEditActivity(); clearEditingDraft() }}>放弃修改</Button>
            <Button type="primary" className="phase2-save-button" icon={<SaveOutlined/>} loading={saveInlineEdit.isPending || rebuilding}
                    disabled={interactionLocked || generationFinalizing || !changeCount || inlineEditor.isLoading || inlineEditor.isFetching}
                    onClick={() => { stopEditActivity(); setVersionName(""); setVersionNameModalOpen(true) }}>保存并重建（{changeCount}）</Button>
        </>}</Space>
    </div>;
    const confirmLeavingEditor = () => !documentEditing || window.confirm("有表单仍未提交，确定要离开当前页面吗？");
    return <Shell className="review-shell" backTo={`/projects/${id}`} backLabel="返回生成进度" beforeLeave={confirmLeavingEditor}>{reviewMessageContext}
        {requestedChapter && !validRequestedChapter && <Alert className="phase2-generation-banner" type="warning" showIcon
            message="无法识别指定的测试需求章节" description="已显示当前可用的第一个章节。"/>}
        {requestedChapter && validRequestedChapter && !requestedChapterAvailable && <Alert className="phase2-generation-banner" type="info" showIcon
            message={`第 ${requestedChapter} 章仍在生成`} description="章节发布后页面会自动定位到相应内容。"/>}
        {generationActive && <Alert className="phase2-generation-banner" type="info" showIcon
            message="测试需求仍在生成，当前内容会持续更新"
            description={generationFinalizing ? "正在汇总最终文档，暂时无法保存修改。" : "已完成章节可以查看和编辑；评审、下载与变更分析将在生成完成后开放。"}/>}<Layout className="review trace-review">
        <div className="review-splitter-reset review-main-reset" onDoubleClick={event => {
            if ((event.target as HTMLElement).closest(".review-splitter-reset") === event.currentTarget && (event.target as HTMLElement).closest(".ant-splitter-bar")) {
                setMainSizes(["50%", "50%"]);
                localStorage.removeItem(splitStorageKey("main"))
            }
        }}>
            <Splitter className="review-main-splitter" onResize={setMainSizes}
                      onResizeEnd={persist("main", setMainSizes, 80, true)}>
                <Splitter.Panel size={mainSizes?.[0]} defaultSize="50%" min={0}
                                collapsible={{end: true, showCollapsibleIcon: true}}>
                    {workspace("source", sourceDirectory, sourceDocument)}
                </Splitter.Panel>
                <Splitter.Panel size={mainSizes?.[1]} defaultSize="50%" min={0}
                                collapsible={{start: true, showCollapsibleIcon: true}}>
                    {workspace("requirement", requirementDirectory, requirementDocument, requirementToolbar)}
                </Splitter.Panel>
            </Splitter>
        </div>
        <EvaluationWindow open={evalOpen} loading={saveReview.isPending}
                          subject={evaluationTarget ? `${evaluationTarget.number ? `${evaluationTarget.number} ` : ""}${evaluationTarget.title}` : undefined}
                          onSubjectClick={evaluationTargetId ? () => gotoRequirement(evaluationTargetId) : undefined}
                          onCancel={() => setEvalOpen(false)}
                          onSave={() => saveReview.mutate()}>
            <Evaluation scores={scores} setScores={setScores} comment={reviewComment} setComment={setReviewComment}/>
            {saveReview.error &&
                <Alert type="error" showIcon message="评估保存失败" description={saveReview.error.message}/>}
            <div className="evaluation-summary"><Typography.Title level={3}>{total.toFixed(2)} /
                5.0</Typography.Title><Tag
                color={total >= 4.5 ? "green" : total >= 3.5 ? "blue" : total >= 2.5 ? "orange" : "red"}>{grade}</Tag>
            </div>
        </EvaluationWindow>
        <Modal title="编辑追溯来源" width={760} open={Boolean(sourceEditBinding)} onCancel={() => { stopEditActivity(); setSourceEditBinding(undefined) }}
            onOk={() => {
                if (sourceEditBinding) setEditorDrafts(current => ({...current, [sourceEditBinding.edit_key]: sourceModalValues}));
                stopEditActivity();
                setSourceEditBinding(undefined)
            }} okText="确定" cancelText="取消">
            <div className="phase2-picker-selected">
                <div className="phase2-picker-section-title">已选择 {sourceModalValues.length} 项</div>
                <div className="phase2-picker-tags">{sourceModalValues.length ? sourceModalValues.map(value => <Tag closable key={value}
                    onClose={event => { event.preventDefault(); recordEditActivity(); setSourceModalValues(current => current.filter(item => item !== value)) }}>{sourceLabel(value)}</Tag>) :
                    <span className="phase2-picker-empty-inline">尚未选择追溯来源</span>}</div>
            </div>
            <Input allowClear className="phase2-picker-search" placeholder="搜索文件名、章节号或标题" value={sourcePickerSearch}
                onChange={event => setSourcePickerSearch(event.target.value)}/>
            <div className="phase2-picker-results phase2-source-picker-results">{visibleSourceOptions.length ? visibleSourceOptions.map(option => {
                const checked = sourceModalValues.includes(option.value);
                return <label key={option.value} className={`phase2-source-option${checked ? " is-selected" : ""}`}>
                    <Checkbox checked={checked} onChange={event => { recordEditActivity(); setSourceModalValues(current => event.target.checked
                        ? [...new Set([...current, option.value])] : current.filter(item => item !== option.value)) }}/>
                    <span><b>{option.document_name} {option.number || option.title}</b>{option.number && option.title ? <small>{option.title}</small> : null}</span>
                </label>
            }) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的追溯来源"/>}</div>
        </Modal>
        <Modal title="选择硬件接口引用表格" width={960} open={Boolean(tableEditBinding)} onCancel={() => {
            stopEditActivity();
            setTableEditBinding(undefined);
            setTablePreviewId(undefined)
        }}
            onOk={() => {
                if (tableEditBinding) setEditorDrafts(current => ({...current, [tableEditBinding.edit_key]: tableModalValues}));
                stopEditActivity();
                setTableEditBinding(undefined);
                setTablePreviewId(undefined)
            }} okText="确定" cancelText="取消">
            <div className="phase2-picker-selected">
                <div className="phase2-picker-section-title">已选择 {tableModalValues.length} 张</div>
                <div className="phase2-picker-tags phase2-selected-table-list">{tableModalValues.length ? <SortableTableList ids={tableModalValues}
                    onChange={values => { recordEditActivity(); setTableModalValues(values) }}>
                    {value => {
                        const option = tableOptionMap.get(value);
                        return <div className="phase2-selected-table-entry">
                            <div className="phase2-selected-table-meta">
                                <b>{option ? tableDocumentName(option.document_name) : "引用表格不可用"}</b>
                                <span>{option ? `${option.section_number || option.section_title} · ${option.title}` : value}</span>
                            </div>
                            <Button type="text" danger icon={<CloseOutlined/>} aria-label="移除引用表格"
                                onClick={() => { recordEditActivity(); setTableModalValues(current => current.filter(item => item !== value)) }}/>
                        </div>
                    }}
                </SortableTableList> :
                    <span className="phase2-picker-empty-inline">尚未选择引用表格</span>}</div>
            </div>
            <Input allowClear className="phase2-picker-search" placeholder="搜索文件名、章节号、章节标题或表题" value={tablePickerSearch}
                onChange={event => setTablePickerSearch(event.target.value)}/>
            {!tableNeedle && !tableModalValues.length ? <Empty className="phase2-picker-search-hint" image={Empty.PRESENTED_IMAGE_SIMPLE} description="输入关键字搜索引用表格"/> :
                <div className="phase2-picker-results phase2-table-picker-results">{visibleTableOptions.length ? visibleTableOptions.map(option => {
                    const checked = tableModalValues.includes(option.table_id);
                    const documentName = tableDocumentName(option.document_name);
                    const chapter = option.section_number || option.section_title;
                    return <div className={`phase2-table-option${checked ? " is-selected" : ""}`} key={option.table_id}
                        role="checkbox" aria-checked={checked} tabIndex={0} onClick={() => toggleTableSelection(option.table_id)}
                        onKeyDown={event => {
                            if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                toggleTableSelection(option.table_id)
                            }
                        }}>
                        <Checkbox checked={checked} onClick={event => event.stopPropagation()}
                            onChange={event => toggleTableSelection(option.table_id, event.target.checked)}/>
                        <div className="phase2-table-option-meta">
                            <b title={documentName}>{documentName}</b>
                            <span title={chapter}>{chapter}</span>
                            <span className="phase2-table-option-title" title={option.title}>{option.title}</span>
                        </div>
                        <Button icon={<EyeOutlined/>} onClick={event => {
                            event.stopPropagation();
                            setTablePreviewId(option.table_id)
                        }}>预览</Button>
                    </div>
                }) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的引用表格"/>}</div>}
        </Modal>
        <Drawer className="phase2-table-preview-drawer" placement="right" width="min(900px, 94vw)"
            title={previewTable ? <div className="phase2-table-preview-title">
                <b>{tableDocumentName(previewTable.document_name)}</b>
                <span>{previewTable.section_number || previewTable.section_title} · {previewTable.title}</span>
            </div> : "表格预览"}
            open={Boolean(previewTable)} onClose={() => setTablePreviewId(undefined)}>
            {previewTable ? <div className="phase2-table-preview-scroll">
                <div className="phase2-source-table-preview" dangerouslySetInnerHTML={{__html: previewTable.table_html}}/>
            </div> : null}
        </Drawer>
        <Modal title="填写版本名称" open={versionNameModalOpen} okText="确认保存并重建" cancelText="取消"
            okButtonProps={{disabled: !versionName.trim() || versionName.trim().length > 50, loading: saveInlineEdit.isPending}}
            onCancel={() => { if (!saveInlineEdit.isPending) { setVersionNameModalOpen(false); setVersionName("") } }}
            onOk={() => {
                const normalized = versionName.trim();
                if (!normalized || normalized.length > 50) return;
                setVersionNameModalOpen(false);
                setSourceEditBinding(undefined); setTableEditBinding(undefined); setTablePreviewId(undefined);
                saveInlineEdit.mutate(normalized)
            }} closable={!saveInlineEdit.isPending} maskClosable={!saveInlineEdit.isPending}>
            <div className="phase2-version-name-form">
                <p>该名称将显示在版本记录和变更分析中。</p>
                <Input autoFocus showCount maxLength={50} value={versionName} placeholder="例如：联调问题修订"
                    onPressEnter={() => {
                        const normalized = versionName.trim();
                        if (normalized && normalized.length <= 50) {
                            setVersionNameModalOpen(false); setSourceEditBinding(undefined); setTableEditBinding(undefined); setTablePreviewId(undefined);
                            saveInlineEdit.mutate(normalized)
                        }
                    }} onChange={event => setVersionName(event.target.value)}/>
            </div>
        </Modal>
        {interactionLocked && <Alert className="phase2-publication-status" type="info" showIcon
            message={editRun.data?.savedAt ? "修改已保存，正在后台发布新文档" : submissionLocked && !editRunId ? "正在提交修改" : "正在保存修改"}
            description={<>
                <Progress size="small" percent={editRun.data?.progress || 0}/>
                <span>当前阶段：{editRun.data?.currentStage ? stageName(editRun.data.currentStage) : "排队中"}</span>
            </>}
        />}
        {failedDraft && <Alert type="error" showIcon message="编辑稿已保存，发布失败"
            description={<>{editRun.data?.errorMessage}{Boolean(editRun.data?.warnings?.length) && <ul>{editRun.data!.warnings!.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}</ul>}</>}
            action={<div className="phase2-publication-actions"><Button size="small" loading={retryPublication.isPending} onClick={() => retryPublication.mutate()}>重新发布</Button>
                <Button size="small" danger loading={discardDraft.isPending} onClick={() => discardDraft.mutate()}>放弃编辑稿</Button></div>}
        />}
        {publicationWarnings && <Alert type="warning" showIcon closable onClose={() => setPublicationWarnings(undefined)}
            message="发布成功但有警告" description={<><div>跳过操作数：{publicationWarnings.skippedCount}</div><ul>{publicationWarnings.warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}</ul></>}/>
        }
        {saveInlineEdit.error && <Alert type="error" showIcon message="提交失败" description={saveInlineEdit.error.message}/>}
        <Drawer className="review-center-drawer" width={520} title="评审中心" open={reviewCenterOpen}
                onClose={() => setReviewCenterOpen(false)}
                footer={<div className="review-center-footer">
                    {pendingCount > 0 && <div className="review-center-export-hint">
                        <span><InfoCircleOutlined/>还有 {pendingCount} 项未评审，完成后即可下载报告</span>
                        <Button type="link" size="small" onClick={() => {
                            setReviewFilter("pending");
                            setReviewSearch("");
                            setPendingAttention(true)
                        }}>查看待评项</Button>
                    </div>}
                    <Button block type={pendingCount ? "default" : "primary"} icon={<DownloadOutlined/>}
                            loading={exportReport.isPending} onClick={handleReviewExport}>下载评审报告</Button>
                </div>}>
            <div className="review-center-summary">
                <div><b>{reviewPercent}%</b><span>总体完成率</span></div>
                <div><b>{reviewedCount}</b><span>已评</span></div>
                <div><b>{pendingCount}</b><span>待评</span></div>
            </div>
            <Progress percent={reviewPercent} status={pendingCount ? "active" : "success"}/>
            <div className="review-center-tools">
                <Space.Compact block>
                    {(["all", "reviewed", "pending"] as const).map(filter => <Button key={filter}
                        type={reviewFilter === filter ? "primary" : "default"} onClick={() => {
                        setReviewFilter(filter);
                        setPendingAttention(false)
                    }}>{filter === "all" ? "全部" : filter === "reviewed" ? "已评" : `待评 ${pendingCount}`}</Button>)}
                </Space.Compact>
                <Input allowClear value={reviewSearch} placeholder="搜索章节号或标题"
                       onChange={event => setReviewSearch(event.target.value)}/>
            </div>
            {reviewGroups.length ? <div className="review-center-groups">{reviewGroups.map(group =>
                <section key={group.key} className="review-center-group">
                    <h3>{group.title}<Tag>{group.items.length}</Tag></h3>
                    {group.items.map(item => <div key={item.id}
                        className={`review-center-item${item.review ? " is-reviewed" : " is-pending"}${pendingAttention && !item.review ? " needs-attention" : ""}`}
                        onClick={() => gotoReviewItem(item.id)}>
                        <div className="review-center-item-main">
                            <div className="review-center-item-title"><span>{item.number || "未编号"}</span>{item.title}</div>
                            {item.review ? <div className="review-center-item-meta">
                                <Tag color="blue">{item.review.weightedScore.toFixed(2)}</Tag>
                                <Tag color={item.review.grade === "优秀" ? "green" : item.review.grade === "良好" ? "blue" : item.review.grade === "合格" ? "orange" : "red"}>{item.review.grade}</Tag>
                                {item.review.comment && <Tooltip title={item.review.comment}
                                    overlayClassName="review-center-comment-tooltip">
                                    <span className="review-center-comment">{item.review.comment}</span>
                                </Tooltip>}
                            </div> : <Tag color="orange">待评</Tag>}
                        </div>
                        <Button className="review-center-item-action" size="small"
                                type={item.review ? "default" : "primary"} onClick={event => {
                            event.stopPropagation();
                            evaluateReviewItem(item.id)
                        }}>{item.review ? "查看/修改" : "开始评估"}</Button>
                    </div>)}
                </section>)}</div> : <Empty description="没有符合条件的评审项"/>}
        </Drawer>
    </Layout></Shell>
}

function Evaluation({scores, setScores, comment, setComment}: {
    scores: ReviewScores;
    setScores: (scores: ReviewScores) => void;
    comment: string;
    setComment: (comment: string) => void
}) {
    const dimensions: { key: keyof ReviewScores; label: string }[] = [
        {key: "correctness", label: "准确性 40%"},
        {key: "coverage", label: "覆盖性 35%"},
        {key: "testability", label: "可测试性 25%"}
    ];
    return <div className="evaluation-form">{dimensions.map(item => <div className="evaluation-form-row" key={item.key}>
        <b>{item.label}</b><Slider min={1} max={5} marks={{1: "1", 2: "2", 3: "3", 4: "4", 5: "5"}}
                                   value={scores[item.key]}
                                   onChange={value => setScores({...scores, [item.key]: value})}/></div>)}
        <div className="evaluation-comment"><b>测试人员提出的问题、修改建议</b><Input.TextArea rows={5} maxLength={2000}
                                                                                              showCount value={comment}
                                                                                              onChange={event => setComment(event.target.value)}
                                                                                              placeholder="请填写需要修改、补充或澄清的内容（可选）"/>
        </div>
    </div>
}

export function App() {
    const location = useLocation(), nav = useNavigate(), qc = useQueryClient();
    const currentPath = `${location.pathname}${location.search}${location.hash}`;
    const [expiredPath, setExpiredPath] = useState<string>();
    const me = useQuery({queryKey: ["me"], queryFn: () => api<CurrentUser>("/auth/me"), retry: false,
        staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false});
    useEffect(() => subscribeToSessionExpired(() => {
        setExpiredPath(previous => previous || currentPath);
        void qc.cancelQueries();
        qc.removeQueries({predicate: query => query.queryKey[0] !== "me"});
        qc.setQueryData(["me"], null)
    }), [currentPath, qc]);
    if (me.isLoading) return <Spin fullscreen/>;
    const initialSessionExpired = location.pathname !== "/login" && me.error instanceof ApiError && me.error.status === 401;
    if (expiredPath || initialSessionExpired) {
        const returnTo = expiredPath || currentPath;
        return <SessionExpired onLogin={() => {
            setExpiredPath(undefined);
            nav("/login", {replace: true, state: {returnTo}})
        }}/>
    }
    return <Routes><Route path="/login" element={<Login/>}/><Route path="/" element={me.data ? <Projects/> :
        <Navigate to="/login"/>}/><Route path="/projects/:id"
                                         element={me.data ? <ProjectPage/> : <Navigate to="/login"/>}/><Route
        path="/projects/:id/review" element={me.data ? <Review/> : <Navigate to="/login"/>}/><Route
        path="/projects/:id/requirement-diff" element={me.data ? <Shell hideHeader><RequirementDiffPage/></Shell> : <Navigate to="/login"/>}/></Routes>
}
