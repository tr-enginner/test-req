import {ConflictException, Controller, Get, NotFoundException, Param, Res} from "@nestjs/common";
import Docxtemplater from "docxtemplater";
import PizZip from "pizzip";
import {createReadStream} from "node:fs";
import {readFile, stat} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {buildPhase2Document, type Phase2Block} from "./phase2-document.js";
import {PrismaService} from "./prisma.js";
import {calculateReviewScore, type ReviewScores} from "./reviews.js";

const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const TEMPLATE_PATH = fileURLToPath(new URL("../templates/test-requirements-review-report-v2.docx", import.meta.url));

type Requirement = {
    id: string;
    businessId: string;
    nodeType: string;
    number: string | null;
    title: string;
    parentId: string | null;
    artifact: string;
};
type Review = { nodeId: string; scores: unknown; weightedScore: number; comment: string | null };
type EditTimeSegment = {userId: string; durationMs: number; user?: {username: string} | null};
export type MissingReview = { id: string; number: string; title: string };
type ReportRow = {
    seq: string;
    chapter?: string;
    name: string;
    count?: string;
    correctness: string;
    coverage: string;
    testability: string;
    weighted: string;
    comment: string;
};

function contentDisposition(filename: string) {
    const fallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\\r\n]/g, "_");
    return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

function cleanProjectName(name: string) {
    return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim() || "项目"
}

function displayNumber(block: Phase2Block, node?: Requirement) {
    return node?.number || block.text?.match(/^([\d.]+)/)?.[1]?.replace(/\.$/, "") || ""
}

function displayTitle(block: Phase2Block, number: string, node?: Requirement) {
    if (node?.title) return node.title;
    return (block.text || "未命名章节").replace(new RegExp(`^${number.replace(/\./g, "\\.")}\\s*`), "").trim()
}

function parseScores(value: unknown): ReviewScores {
    const scores = value as Partial<ReviewScores>;
    return {
        correctness: Number(scores?.correctness || 0),
        coverage: Number(scores?.coverage || 0),
        testability: Number(scores?.testability || 0)
    }
}

function score(value: number) {
    return Number(value.toFixed(2)).toString()
}

export function formatEditDuration(durationMs: number) {
    const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
    const hours = Math.floor(totalSeconds / 3600), minutes = Math.floor(totalSeconds % 3600 / 60), seconds = totalSeconds % 60;
    return [hours, minutes, seconds].map(value => String(value).padStart(2, "0")).join(":")
}

export function buildEditTimeReportData(editTimeSegments: EditTimeSegment[]) {
    const editTimeByUser = new Map<string, {username: string; durationMs: number}>();
    for (const segment of editTimeSegments) {
        const current = editTimeByUser.get(segment.userId) || {username: segment.user?.username || "未知用户", durationMs: 0};
        current.durationMs += segment.durationMs;
        editTimeByUser.set(segment.userId, current)
    }
    return {
        editTimeRows: [...editTimeByUser].map(([userId, value], index) => ({seq: String(index + 1), userId,
            username: value.username, duration: formatEditDuration(value.durationMs)})),
        projectEditDuration: formatEditDuration(editTimeSegments.reduce((sum, segment) => sum + segment.durationMs, 0))
    }
}

function average(reviews: Review[], key: keyof ReviewScores) {
    return reviews.length ? reviews.reduce((sum, review) => sum + parseScores(review.scores)[key], 0) / reviews.length : 0
}

function descendants(rootId: string, requirements: Requirement[]) {
    const childMap = new Map<string, Requirement[]>();
    for (const requirement of requirements) {
        if (!requirement.parentId) continue;
        childMap.set(requirement.parentId, [...(childMap.get(requirement.parentId) || []), requirement])
    }
    const result: Requirement[] = [], queue = [...(childMap.get(rootId) || [])];
    while (queue.length) {
        const current = queue.shift()!;
        result.push(current);
        queue.push(...(childMap.get(current.id) || []))
    }
    return result
}

async function nonFunctionalCount(workspacePath: string, artifact: string, fallback: number) {
    try {
        const data = JSON.parse(await readFile(path.join(workspacePath, ".matrix", "data", artifact), "utf8"));
        return Array.isArray(data.rows) ? data.rows.length : fallback
    } catch {
        return fallback
    }
}

function rowFromReview(seq: number, name: string, review: Review, extra: {
    chapter?: string;
    count?: number
} = {}): ReportRow {
    const scores = parseScores(review.scores);
    return {
        seq: String(seq),
        chapter: extra.chapter,
        name,
        count: extra.count === undefined ? undefined : String(extra.count),
        correctness: score(scores.correctness),
        coverage: score(scores.coverage),
        testability: score(scores.testability),
        weighted: score(calculateReviewScore(scores)),
        comment: review.comment || ""
    }
}

export async function buildReviewReportData(workspacePath: string, requirements: Requirement[], reviews: Review[], editTimeSegments: EditTimeSegment[] = []) {
    const document = await buildPhase2Document(workspacePath, requirements);
    const byId = new Map(requirements.map(item => [item.id, item]));
    const latest = new Map<string, Review>();
    for (const review of reviews) if (!latest.has(review.nodeId)) latest.set(review.nodeId, review);
    const evaluable = document.chapters.flatMap(chapter => chapter.blocks)
        .filter((block): block is Phase2Block & {
            anchorId: string
        } => block.type === "heading" && block.evaluable === true && !!block.anchorId);
    const missingReviews: MissingReview[] = evaluable.filter(block => !latest.has(block.anchorId)).map(block => {
        const node = byId.get(block.anchorId), number = displayNumber(block, node);
        return {id: block.anchorId, number, title: displayTitle(block, number, node)}
    });
    if (missingReviews.length) throw new ConflictException({message: "仍有测试需求尚未完成评审", missingReviews});

    const records = evaluable.map(block => ({
        block,
        node: byId.get(block.anchorId)!,
        review: latest.get(block.anchorId)!
    }));
    const hardwareRecord = records.find(item => item.node?.artifact === "hardware-interface-model.json" || item.node?.number === "3.1");
    if (!hardwareRecord) throw new NotFoundException("未找到硬件接口评审记录");
    const functionalRecords = records.filter(item => item.node?.artifact === "functional-test-content.json" && item.node?.number !== "4.1");
    const nonFunctionalRecords = records.filter(item => /^4\.[2-9]\.1$/.test(item.node?.number || ""));

    const hardwareRows = [rowFromReview(1, "3.1 硬件接口", hardwareRecord.review)];
    const functionalRows = functionalRecords.map((item, index) => rowFromReview(index + 1, item.node.title, item.review, {
        chapter: item.node.number || "",
        count: descendants(item.node.id, requirements).filter(child => child.nodeType === "requirement").length
    }));
    const nonFunctionalRows: ReportRow[] = [];
    for (let index = 0; index < nonFunctionalRecords.length; index++) {
        const item = nonFunctionalRecords[index],
            descendantCount = descendants(item.node.id, requirements).filter(child => child.nodeType === "requirement").length;
        nonFunctionalRows.push(rowFromReview(index + 1, `${item.node.number} ${item.node.title}`, item.review, {
            count: await nonFunctionalCount(workspacePath, item.node.artifact, descendantCount)
        }))
    }

    const categoryRows = [
        {category: "硬件接口", count: 1, reviews: [hardwareRecord.review]},
        {
            category: "功能测试需求",
            count: functionalRows.reduce((sum, row) => sum + Number(row.count || 0), 0),
            reviews: functionalRecords.map(item => item.review)
        },
        {
            category: "非功能测试需求",
            count: nonFunctionalRows.reduce((sum, row) => sum + Number(row.count || 0), 0),
            reviews: nonFunctionalRecords.map(item => item.review)
        }
    ];
    const reportReviews = categoryRows.flatMap(item => item.reviews);
    const statisticsRows = [...categoryRows, {
        category: "总体", count: categoryRows.reduce((sum, item) => sum + item.count, 0), reviews: reportReviews
    }].map(item => {
        const scores = {
            correctness: average(item.reviews, "correctness"),
            coverage: average(item.reviews, "coverage"),
            testability: average(item.reviews, "testability")
        };
        return {
            category: item.category,
            count: String(item.count),
            correctness: score(scores.correctness),
            coverage: score(scores.coverage),
            testability: score(scores.testability),
            weighted: score(calculateReviewScore(scores)),
            grade: ""
        }
    });
    return {hardwareRows, functionalRows, nonFunctionalRows, statisticsRows, ...buildEditTimeReportData(editTimeSegments)}
}

type ReviewReportData = Awaited<ReturnType<typeof buildReviewReportData>>;
export async function renderReviewReport(data: Omit<ReviewReportData, "editTimeRows" | "projectEditDuration"> &
    Partial<Pick<ReviewReportData, "editTimeRows" | "projectEditDuration">>) {
    const template = await readFile(TEMPLATE_PATH);
    const document = new Docxtemplater(new PizZip(template), {paragraphLoop: true, linebreaks: true});
    document.render({...data, editTimeRows: data.editTimeRows || [], projectEditDuration: data.projectEditDuration || "00:00:00"});
    return document.getZip().generate({type: "nodebuffer", compression: "DEFLATE"}) as Buffer
}

@Controller("projects")
export class ExportsController {
    constructor(private db: PrismaService) {
    }

    @Get(":id/test-requirements-docx") async testRequirements(@Param("id") id: string, @Res() reply: any) {
        const project = await this.project(id),
            publishedReportDirectory = path.resolve(project.workspacePath, ".matrix", "reports");
        let reportDirectory = publishedReportDirectory, previousPublication = false;
        if (project.status === "REBUILDING") {
            const edit = await this.db.phase2EditRun.findFirst({where: {projectId: id, status: {in: ["QUEUED", "RUNNING"]}, backupPath: {not: null}}, orderBy: {createdAt: "desc"}});
            if (!edit?.backupPath) return reply.status(409).send({
                statusCode: 409,
                message: "项目正在首次生成，暂时没有可下载的已发布版本",
                error: "Conflict"
            });
            reportDirectory = path.resolve(edit.backupPath, ".matrix", "reports");
            previousPublication = true
        }
        const candidates = ["phase2-test-requirements.docx", "phase2-test-requirement.docx"];
        for (const filename of candidates) {
            const candidate = path.resolve(reportDirectory, filename);
            if (!candidate.startsWith(reportDirectory + path.sep)) continue;
            try {
                if ((await stat(candidate)).size <= 0) continue;
                const downloadName = `${cleanProjectName(project.name)}-AI生成第三方测试需求.docx`;
                if (previousPublication) reply.header("X-Matrix-Publication-Version", "previous");
                return reply.type(DOCX_TYPE).header("Content-Disposition", contentDisposition(downloadName)).send(createReadStream(candidate))
            } catch {
                // Continue to the compatible filename.
            }
        }
        return reply.status(404).send({
            statusCode: 404,
            message: "第三方测试需求DOCX不存在或为空",
            error: "Not Found"
        })
    }

    @Get(":id/review-report") async reviewReport(@Param("id") id: string, @Res() reply: any) {
        const project = await this.project(id);
        if (project.status === "REBUILDING") throw new ConflictException("项目正在重建，暂不能导出评审报告");
        const [requirements, reviews, editTimeSegments] = await Promise.all([
            this.db.testRequirementNode.findMany({where: {projectId: id}, orderBy: {orderIndex: "asc"}}),
            this.db.review.findMany({where: {projectId: id}, orderBy: [{version: "desc"}, {createdAt: "desc"}]}),
            this.db.editTimeSegment.findMany({where: {projectId: id}, select: {userId: true, durationMs: true, user: {select: {username: true}}}})
        ]);
        const data = await buildReviewReportData(project.workspacePath, requirements, reviews, editTimeSegments);
        const buffer = await renderReviewReport(data);
        const downloadName = `${cleanProjectName(project.name)}-测试需求生成结果评估报告.docx`;
        return reply.type(DOCX_TYPE).header("Content-Disposition", contentDisposition(downloadName)).send(buffer)
    }

    private async project(id: string) {
        const project = await this.db.project.findUnique({where: {id}});
        if (!project) throw new NotFoundException("项目不存在或已删除");
        return project
    }
}
