import type {Phase2Chapter} from "./phase2-document.js";

export type ReviewSummary = {
    total: number;
    reviewed: number;
    pending: number;
    progress: number;
    status: "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED";
};

export function calculateReviewSummary(document: {chapters: Phase2Chapter[]}, reviews: {nodeId: string; invalidatedAt?: unknown}[]): ReviewSummary {
    const evaluable = document.chapters.flatMap(chapter => chapter.blocks)
        .filter(block => block.type === "heading" && block.evaluable === true && Boolean(block.anchorId));
    const reviewedNodeIds = new Set(reviews.filter(review => !review.invalidatedAt).map(review => review.nodeId));
    const total = evaluable.length;
    const reviewed = evaluable.filter(block => reviewedNodeIds.has(block.anchorId!)).length;
    const pending = total - reviewed;
    return {
        total,
        reviewed,
        pending,
        progress: total ? Math.round(reviewed / total * 100) : 0,
        status: !total || !reviewed ? "NOT_STARTED" : pending ? "IN_PROGRESS" : "COMPLETED"
    }
}
