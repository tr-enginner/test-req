import {describe, expect, it} from "vitest";
import {activityPresentation, phase2RunButtonLabel, PROJECT_STATUS, projectsNeedPolling, reviewSummaryText, stageName} from "./projectPresentation";

describe("project presentation", () => {
    it("defines a Chinese label for every project status", () => {
        expect(Object.fromEntries(Object.entries(PROJECT_STATUS).map(([key, value]) => [key, value.label]))).toEqual({
            IMPORTING: "正在导入",
            PENDING_GENERATION: "待生成",
            INCOMPLETE_MATRIX: "生成未完成",
            GENERATING: "生成中",
            REBUILDING: "更新发布中",
            READY_FOR_REVIEW: "成果已就绪",
            FAILED: "处理失败"
        })
    });

    it("presents generation lifecycle states", () => {
        expect(activityPresentation(null)).toMatchObject({text: "生成任务：尚未开始", percent: 0});
        expect(activityPresentation({type: "GENERATION", status: "QUEUED", progress: 0}).text).toBe("生成任务：排队中");
        expect(activityPresentation({type: "GENERATION", status: "RUNNING", stage: "finalize_boundary_test_content", progress: 68}))
            .toMatchObject({text: "正在生成：生成4.6：边界测试", percent: 68, progressStatus: "active"});
        expect(activityPresentation({type: "GENERATION", status: "SUCCEEDED", progress: 97}))
            .toMatchObject({text: "生成任务：已完成", percent: 100, progressStatus: "success"});
        expect(activityPresentation({type: "GENERATION", status: "CANCELLED", progress: 42}))
            .toMatchObject({text: "上次生成：已终止，可重新开始", percent: 42});
        expect(activityPresentation({type: "GENERATION", status: "FAILED", stage: "prepare_margin_test_content", progress: 51}))
            .toMatchObject({text: "生成失败：准备余量测试", progressStatus: "exception"})
    });

    it("presents publication lifecycle states and translated stages", () => {
        expect(activityPresentation({type: "PUBLISH", status: "RUNNING", stage: "snapshot", progress: 96}).text)
            .toBe("正在更新：生成版本快照");
        expect(activityPresentation({type: "PUBLISH", status: "SUCCEEDED", stage: "complete", progress: 100}).text)
            .toBe("更新发布：已完成");
        expect(stageName("get_functional_other_content_worker_batch:3")).toBe("准备第3个非初始化功能需求");
        expect(stageName("get_hardware_interface_worker_batch:2")).toBe("准备第2个硬件接口");
        expect(stageName("get_interface_test_worker_batch:4")).toBe("准备第4个接口测试需求");
        expect(stageName("resume_queued")).toBe("等待继续执行");
        expect(stageName("retry_queued")).toBe("等待自动重试");
        expect(stageName("resume_check_artifacts")).toBe("正在检查并复用已有工件")
    });

    it("polls only while a project has active generation or publication", () => {
        const project = (status: string) => ({id: status, name: status, status, createdAt: "", runs: [], documents: []});
        expect(projectsNeedPolling([project("READY_FOR_REVIEW")])).toBe(false);
        expect(projectsNeedPolling([project("READY_FOR_REVIEW"), project("GENERATING")])).toBe(true);
        expect(projectsNeedPolling([project("REBUILDING")])).toBe(true)
    });

    it("presents review progress independently from project status", () => {
        expect(reviewSummaryText(null)).toBe("评审尚未开始");
        expect(reviewSummaryText({total: 13, reviewed: 8, pending: 5, progress: 62, status: "IN_PROGRESS"}))
            .toBe("评审中 · 8/13");
        expect(reviewSummaryText({total: 13, reviewed: 13, pending: 0, progress: 100, status: "COMPLETED"}))
            .toBe("评审已完成 · 13/13")
    })

    it("labels initial, active, successful and resumable generation actions", () => {
        expect(phase2RunButtonLabel()).toBe("开始生成测试需求");
        expect(phase2RunButtonLabel("QUEUED")).toBe("正在生成测试需求");
        expect(phase2RunButtonLabel("RUNNING")).toBe("正在生成测试需求");
        expect(phase2RunButtonLabel("SUCCEEDED")).toBe("重新生成测试需求");
        expect(phase2RunButtonLabel("FAILED")).toBe("继续生成测试需求");
        expect(phase2RunButtonLabel("CANCELLED")).toBe("继续生成测试需求")
    })
});
