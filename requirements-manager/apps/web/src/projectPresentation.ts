import type {CurrentActivity, Project, ReviewSummary} from "./api";

export const PROJECT_STATUS: Record<string, {label: string; color: string}> = {
    IMPORTING: {label: "正在导入", color: "blue"},
    PENDING_GENERATION: {label: "待生成", color: "gold"},
    INCOMPLETE_MATRIX: {label: "生成未完成", color: "orange"},
    GENERATING: {label: "生成中", color: "blue"},
    REBUILDING: {label: "更新发布中", color: "blue"},
    READY_FOR_REVIEW: {label: "成果已就绪", color: "green"},
    FAILED: {label: "处理失败", color: "red"}
};

const STAGE_NAMES: Record<string, string> = {
    backup: "创建发布快照",
    apply: "保存编辑稿",
    saved: "编辑稿已保存",
    resume_publish: "重新发布已保存编辑稿",
    retry_apply: "重新应用保留的编辑内容",
    index: "更新测试需求索引",
    snapshot: "生成版本快照",
    complete: "发布完成",
    publish_failed: "发布失败",
    resume_queued: "等待继续执行",
    retry_queued: "等待自动重试",
    resume_check_artifacts: "正在检查并复用已有工件",
    discover_documents: "识别源文档",
    prepare_document_artifacts: "准备文档工件",
    prepare_chapter1_scope: "准备第一章：范围",
    finalize_chapter1_scope: "生成第一章：范围",
    prepare_chapter2_system_overview: "准备第二章：系统概述",
    finalize_chapter2_system_overview: "生成第二章：系统概述",
    discover_hardware_interface_candidates: "识别硬件接口",
    prepare_hardware_interface_batches: "准备硬件接口",
    merge_hardware_interface_blocks: "合并硬件接口",
    finalize_hardware_interface: "生成第三章：硬件接口",
    prepare_functional_title_tree: "准备功能标题树",
    finalize_functional_title_tree: "生成功能标题树",
    prepare_functional_init_content: "准备初始化功能需求",
    finalize_functional_init_content: "生成初始化功能需求",
    prepare_functional_other_content: "准备非初始化功能需求",
    get_functional_other_content_worker_batch: "准备非初始化功能需求",
    get_hardware_interface_worker_batch: "准备硬件接口",
    get_interface_test_worker_batch: "准备接口测试需求",
    finalize_functional_other_content: "生成非初始化功能需求",
    finalize_functional_test_content: "生成4.1：功能测试",
    prepare_performance_test_content: "准备性能测试",
    finalize_performance_test_content: "生成4.2：性能测试",
    prepare_interface_test_content: "准备接口测试",
    finalize_interface_test_content: "生成4.3：接口测试",
    prepare_reliability_safety_test_content: "准备可靠性安全性测试",
    finalize_reliability_safety_test_content: "生成4.4：可靠性安全性测试",
    prepare_margin_test_content: "准备余量测试",
    finalize_margin_test_content: "生成4.5：余量测试",
    prepare_boundary_test_content: "准备边界测试",
    finalize_boundary_test_content: "生成4.6：边界测试",
    prepare_data_processing_test_content: "准备数据处理测试",
    finalize_data_processing_test_content: "生成4.7：数据处理测试",
    prepare_recovery_test_content: "准备恢复性测试",
    finalize_recovery_test_content: "生成4.8：恢复性测试",
    prepare_strength_test_content: "准备强度测试",
    finalize_strength_test_content: "生成4.9：强度测试",
    generate_phase2_traceability: "生成测试需求追溯关系",
    finalize_phase2_document: "生成最终测试需求文档"
};

export function stageName(value: string, batchIndex?: unknown) {
    const [mode, encodedIndex] = value.split(":", 2), index = Number(batchIndex ?? encodedIndex);
    if (mode === "get_functional_other_content_worker_batch") {
        return Number.isInteger(index) && index > 0 ? `准备第${index}个非初始化功能需求` : "准备非初始化功能需求"
    }
    if (mode === "get_hardware_interface_worker_batch") {
        return Number.isInteger(index) && index > 0 ? `准备第${index}个硬件接口` : "准备硬件接口"
    }
    if (mode === "get_interface_test_worker_batch") {
        return Number.isInteger(index) && index > 0 ? `准备第${index}个接口测试需求` : "准备接口测试需求"
    }
    return STAGE_NAMES[mode] || mode
}

export type ActivityPresentation = {
    text: string;
    percent: number;
    progressStatus: "normal" | "active" | "success" | "exception";
    strokeColor?: string
};

export function activityPresentation(value?: CurrentActivity | null): ActivityPresentation {
    if (!value) return {text: "生成任务：尚未开始", percent: 0, progressStatus: "normal", strokeColor: "#bfbfbf"};
    const generation = value.type === "GENERATION", task = generation ? "生成任务" : "更新发布",
        action = generation ? "生成" : "更新", stage = value.stage ? stageName(value.stage) : "任务启动中";
    if (value.status === "QUEUED") return {text: `${task}：排队中`, percent: value.progress, progressStatus: "normal"};
    if (value.status === "RUNNING") return {text: `正在${action}：${stage}`, percent: value.progress, progressStatus: "active"};
    if (value.status === "SUCCEEDED") return {text: `${task}：已完成`, percent: 100, progressStatus: "success"};
    if (value.status === "CANCELLED") return {text: `上次${action}：已终止，可重新开始`, percent: value.progress,
        progressStatus: "normal", strokeColor: "#bfbfbf"};
    return {text: `${action}失败：${stage}`, percent: value.progress, progressStatus: "exception"}
}

export function projectsNeedPolling(projects?: Project[]) {
    return Boolean(projects?.some(project => project.status === "GENERATING" || project.status === "REBUILDING"))
}

export function phase2RunButtonLabel(status?: string) {
    if (status === "QUEUED" || status === "RUNNING") return "正在生成测试需求";
    if (status === "SUCCEEDED") return "重新生成测试需求";
    if (status === "FAILED" || status === "CANCELLED") return "继续生成测试需求";
    return "开始生成测试需求"
}

export function reviewSummaryText(summary?: ReviewSummary | null) {
    if (summary?.status === "COMPLETED") return `评审已完成 · ${summary.reviewed}/${summary.total}`;
    if (summary?.status === "IN_PROGRESS") return `评审中 · ${summary.reviewed}/${summary.total}`;
    return "评审尚未开始"
}
