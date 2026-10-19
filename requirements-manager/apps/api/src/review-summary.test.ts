import {describe, expect, it} from "vitest";
import {calculateReviewSummary} from "./review-summary.js";

const document = (...anchorIds: string[]) => ({
    chapters: [{artifact: "test.json", number: "1", title: "测试", blocks: [
        {type: "heading" as const, text: "章节", evaluable: false},
        ...anchorIds.map(anchorId => ({type: "heading" as const, anchorId, evaluable: true}))
    ]}]
});

describe("review summary", () => {
    it("treats an empty evaluable document as not started", () => {
        expect(calculateReviewSummary(document(), [])).toEqual({
            total: 0, reviewed: 0, pending: 0, progress: 0, status: "NOT_STARTED"
        })
    });

    it("reports not started and ignores reviews outside the evaluable set", () => {
        expect(calculateReviewSummary(document("a", "b"), [{nodeId: "other"}])).toEqual({
            total: 2, reviewed: 0, pending: 2, progress: 0, status: "NOT_STARTED"
        })
    });

    it("reports partial progress using only the latest-node presence", () => {
        expect(calculateReviewSummary(document("a", "b", "c"), [
            {nodeId: "a"}, {nodeId: "a"}, {nodeId: "b", invalidatedAt: new Date()}
        ])).toEqual({
            total: 3, reviewed: 1, pending: 2, progress: 33, status: "IN_PROGRESS"
        })
    });

    it("reports completion when every evaluable node has a review", () => {
        expect(calculateReviewSummary(document("a", "b"), [{nodeId: "b"}, {nodeId: "a"}])).toEqual({
            total: 2, reviewed: 2, pending: 0, progress: 100, status: "COMPLETED"
        })
    })
});
