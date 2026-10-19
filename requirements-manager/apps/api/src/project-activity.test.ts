import {describe, expect, it} from "vitest";
import {selectCurrentActivity} from "./project-activity.js";

const run = (status: any, day: number, extra: Record<string, unknown> = {}) => ({
    status, progress: status === "SUCCEEDED" ? 100 : 45, startedAt: new Date(2026, 0, day), ...extra
});

describe("selectCurrentActivity", () => {
    it("returns null when a project has no activity", () => {
        expect(selectCurrentActivity("PENDING_GENERATION")).toBeNull()
    });

    it("selects active generation and publication activities", () => {
        expect(selectCurrentActivity("GENERATING", run("RUNNING", 1))).toMatchObject({type: "GENERATION", status: "RUNNING"});
        expect(selectCurrentActivity("REBUILDING", run("SUCCEEDED", 1), run("QUEUED", 2)))
            .toMatchObject({type: "PUBLISH", status: "QUEUED"})
    });

    it("gives publication priority for invalid simultaneous active tasks", () => {
        expect(selectCurrentActivity("GENERATING", run("RUNNING", 2), run("RUNNING", 1)))
            .toMatchObject({type: "PUBLISH"})
    });

    it("selects the most recently completed activity", () => {
        const generation = run("SUCCEEDED", 1, {finishedAt: new Date(2026, 0, 3)}),
            publish = run("FAILED", 2, {finishedAt: new Date(2026, 0, 4), currentStage: "publish_failed"});
        expect(selectCurrentActivity("READY_FOR_REVIEW", generation, publish))
            .toMatchObject({type: "PUBLISH", status: "FAILED", stage: "publish_failed"})
    });

    it("uses generation when terminal activity timestamps are equal", () => {
        expect(selectCurrentActivity("READY_FOR_REVIEW", run("CANCELLED", 1), run("FAILED", 1)))
            .toMatchObject({type: "GENERATION", status: "CANCELLED"})
    })
});
