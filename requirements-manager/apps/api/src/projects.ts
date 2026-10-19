import {readWithRunClock, withElapsed} from "./run-clock.js";
import {
    BadRequestException,
    ConflictException,
    Controller,
    Delete,
    Get,
    Injectable,
    NotFoundException,
    Param,
    Post,
    Req
} from "@nestjs/common";
import {PrismaService} from "./prisma.js";
import {mkdir, readdir, rm} from "node:fs/promises";
import {createWriteStream} from "node:fs";
import path from "node:path";
import {pipeline} from "node:stream/promises";
import {safeExtract} from "./archive.js";
import {Queue} from "bullmq";
import {Redis} from "ioredis";
import {Prisma} from "@prisma/client";
import {selectCurrentActivity} from "./project-activity.js";
import {buildPhase2Document} from "./phase2-document.js";
import {calculateReviewSummary} from "./review-summary.js";

const documentQueue = new Queue("document-index", {connection: new Redis(process.env.REDIS_URL || "redis://localhost:6379", {maxRetriesPerRequest: null})});

const REQUIRED = ["chapter1-scope.json", "chapter2-system-overview.json", "hardware-interface-model.json", "functional-test-content.json", "performance-test-content.json", "interface-test-content.json", "reliability-safety-test-content.json", "margin-test-content.json", "boundary-test-content.json", "data-processing-test-content.json", "recovery-test-content.json", "strength-test-content.json", "phase2-test-traceability.json"];

async function findProjectRoot(root: string) {
    const entries = await readdir(root, {withFileTypes: true});
    if (entries.some(x => x.isFile() && x.name.toLowerCase().endsWith(".docx"))) return root;
    const dirs = entries.filter(x => x.isDirectory());
    if (dirs.length === 1) return findProjectRoot(path.join(root, dirs[0].name));
    return root
}

@Injectable()
export class ProjectsService {
    constructor(private db: PrismaService) {
    }

    list() {
        return readWithRunClock(this.db, async (tx, now) => (await tx.project.findMany({
            orderBy: [{createdAt: "desc"}, {id: "desc"}],
            include: {runs: {orderBy: {startedAt: "desc"}, take: 1},
                editRuns: {orderBy: {createdAt: "desc"}, take: 1}, documents: true}
        })).map(project => {
            const {editRuns, ...visible} = project;
            return {...visible, runs: project.runs.map(run => withElapsed(run, now)),
                currentActivity: selectCurrentActivity(project.status, project.runs[0], editRuns[0])}
        }))
    }

    async get(id: string) {
        return readWithRunClock(this.db, async (tx, now) => {
            const project = await tx.project.findUnique({
                where: {id},
                include: {documents: true, runs: {orderBy: {startedAt: "desc"}}}
            });
            if (!project) throw new NotFoundException("项目不存在或已被删除");
            let reviewSummary = null;
            if (project.status === "READY_FOR_REVIEW") {
                try {
                    const [requirements, reviews] = await Promise.all([
                        tx.testRequirementNode.findMany({where: {projectId: id}}),
                        tx.review.findMany({where: {projectId: id, invalidatedAt: null}, select: {nodeId: true}})
                    ]);
                    const document = await buildPhase2Document(project.workspacePath, requirements);
                    reviewSummary = calculateReviewSummary(document, reviews)
                } catch {
                    // Older or incomplete workspaces may not have a renderable formal Phase 2 document.
                    reviewSummary = null
                }
            }
            return {...project, runs: project.runs.map(run => withElapsed(run, now)), reviewSummary}
        })
    }

    async remove(id: string) {
        const project = await this.db.project.findUnique({
            where: {id},
            include: {runs: {select: {id: true, status: true}}}
        });
        if (!project) throw new NotFoundException("项目不存在或已被删除");
        if (project.runs.some(run => run.status === "QUEUED" || run.status === "RUNNING")) {
            throw new ConflictException("项目正在生成测试需求，请先终止任务")
        }
        const documentJob = await documentQueue.getJob(`document-index-${id}`),
            documentState = await documentJob?.getState();
        if (documentState === "active") throw new ConflictException("项目文档正在建立索引，请稍后再删除");
        await documentJob?.remove();
        const root = path.resolve(process.env.PROJECTS_ROOT || "/data/projects"), projectDir = path.resolve(root, id);
        if (projectDir === root || !projectDir.startsWith(root + path.sep)) {
            throw new BadRequestException("项目目录不合法，拒绝删除")
        }
        await rm(projectDir, {recursive: true, force: true});
        await this.db.project.delete({where: {id}});
        return {id}
    }

    async create(request: any) {
        const file = await request.file();
        if (!file || !file.filename.toLowerCase().endsWith(".zip")) throw new BadRequestException("请上传ZIP压缩包");
        const name = String(file.fields?.name?.value || "").trim();
        if (!name || name.length > 100) throw new BadRequestException("项目名称长度必须为1至100个字符");
        const existing = await this.db.project.findUnique({where: {name}, select: {id: true}});
        if (existing) throw new ConflictException("项目名称已存在，请使用其他名称");
        const root = process.env.PROJECTS_ROOT || "/data/projects";
        let project;
        try {
            project = await this.db.project.create({
                data: {
                    name,
                    workspacePath: "pending-" + Date.now()
                }
            })
        } catch (error) {
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
                throw new ConflictException("项目名称已存在，请使用其他名称")
            }
            throw error
        }
        const workspace = path.join(root, project.id), archive = path.join(workspace, "upload.zip"),
            extract = path.join(workspace, "source");
        try {
            await mkdir(workspace, {recursive: true});
            await pipeline(file.file, createWriteStream(archive));
            await safeExtract(archive, extract, {docxOnly: true});
            const projectRoot = await findProjectRoot(extract), updated = await this.db.project.update({
                where: {id: project.id},
                data: {workspacePath: projectRoot, status: "PENDING_GENERATION", missingArtifacts: REQUIRED}
            });
            await documentQueue.add("index-project", {
                projectId: project.id,
                workspacePath: projectRoot
            }, {jobId: `document-index-${project.id}`, removeOnComplete: true});
            return updated
        } catch (error) {
            await rm(workspace, {recursive: true, force: true});
            await this.db.project.delete({where: {id: project.id}}).catch(() => undefined);
            throw error
        }
    }
}

@Controller("projects")
export class ProjectsController {
    constructor(private projects: ProjectsService) {
    }

    @Get() list() {
        return this.projects.list()
    }

    @Get(":id") get(@Param("id") id: string) {
        return this.projects.get(id)
    }

    @Delete(":id") remove(@Param("id") id: string) {
        return this.projects.remove(id)
    }

    @Post() create(@Req() req: any) {
        return this.projects.create(req)
    }
}
