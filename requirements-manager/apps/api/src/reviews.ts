import {BadRequestException, Body, ConflictException, Controller, Get, Param, Post, Req} from "@nestjs/common";
import {PrismaService} from "./prisma.js";

export type ReviewScores = { correctness: number; coverage: number; testability: number };

export function calculateReviewScore(scores: ReviewScores) {
    return scores.correctness * .4 + scores.coverage * .35 + scores.testability * .25
}

function validateReview(scores: ReviewScores, comment?: string) {
    const values = [scores?.correctness, scores?.coverage, scores?.testability];
    if (values.some(value => typeof value !== "number" || !Number.isFinite(value) || value < 1 || value > 5)) {
        throw new BadRequestException("准确性、覆盖性和可测试性评分必须在1到5分之间")
    }
    if (comment !== undefined && typeof comment !== "string") throw new BadRequestException("Reviewer修改建议必须为文本");
    if ((comment?.length || 0) > 2000) throw new BadRequestException("Reviewer修改建议不能超过2000个字符")
}

@Controller("projects/:projectId/reviews")
export class ReviewsController {
    constructor(private db: PrismaService) {
    }

    @Get() list(@Param("projectId") projectId: string) {
        return this.db.review.findMany({where: {projectId, invalidatedAt: null}, orderBy: {createdAt: "desc"}})
    }

    @Post() async save(@Param("projectId") projectId: string, @Req() req: any, @Body() body: {
        nodeId: string;
        scores: ReviewScores;
        issues?: string[];
        comment?: string
    }) {
        const project = await this.db.project.findUniqueOrThrow({where: {id: projectId}, select: {status: true}});
        if (project.status === "REBUILDING") throw new ConflictException("项目正在重建，暂不能评审");
        if (!body.nodeId?.trim()) throw new BadRequestException("评估节点不能为空");
        validateReview(body.scores, body.comment);
        const [node, revision] = await Promise.all([
            this.db.testRequirementNode.findFirst({where: {projectId, id: body.nodeId}}),
            this.db.requirementRevision.findFirst({where: {projectId, status: "PUBLISHED"}, orderBy: {sequence: "desc"}})
        ]);
        if (!node) throw new BadRequestException("评估节点不存在");
        const reviewerId = req.user.id,
            weighted = calculateReviewScore(body.scores),
            grade = weighted >= 4.5 ? "优秀" : weighted >= 3.5 ? "良好" : weighted >= 2.5 ? "合格" : "不合格",
            latest = await this.db.review.findFirst({
                where: {projectId, nodeId: body.nodeId},
                orderBy: {version: "desc"}
            });
        return this.db.review.create({
            data: {
                projectId,
                reviewerId,
                nodeId: body.nodeId,
                entityUid: node.entityUid,
                revisionId: revision?.id,
                version: (latest?.version || 0) + 1,
                scores: body.scores,
                weightedScore: weighted,
                grade,
                issues: body.issues || [],
                comment: body.comment
            }
        })
    }
}
