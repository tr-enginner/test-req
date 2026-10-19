import {readWithRunClock, withElapsed} from "./run-clock.js";
import {BadRequestException, Body, ConflictException, Controller, Get, Injectable, MessageEvent, Param, Patch, Post, Query, Sse} from "@nestjs/common";
import {Queue} from "bullmq";
import {Redis} from "ioredis";
import {interval, map, merge, Observable, startWith, switchMap} from "rxjs";
import {PrismaService} from "./prisma.js";
import {createOpencodeClient} from "@opencode-ai/sdk/v2";

const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {maxRetriesPerRequest: null}),
    queue = new Queue("phase2", {connection: redis}),
    auth = Buffer.from(`${process.env.OPENCODE_USERNAME || "opencode"}:${process.env.OPENCODE_PASSWORD || ""}`).toString("base64"),
    opencode = createOpencodeClient({
        baseUrl: process.env.OPENCODE_URL || "http://localhost:4096",
        headers: {Authorization: `Basic ${auth}`}
    });

type TokenUsage = {input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number;
    total: number; complete: boolean};

function normalizeTokens(tokens: any): TokenUsage | undefined {
    const values = [tokens?.input, tokens?.output, tokens?.reasoning, tokens?.cache?.read, tokens?.cache?.write];
    if (values.some(value => typeof value !== "number" || !Number.isFinite(value) || value < 0)) return undefined;
    const [input, output, reasoning, cacheRead, cacheWrite] = values as number[];
    return {input, output, reasoning, cacheRead, cacheWrite,
        total: input + output + reasoning + cacheRead + cacheWrite, complete: true}
}

function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
    const input = left.input + right.input, output = left.output + right.output,
        reasoning = left.reasoning + right.reasoning, cacheRead = left.cacheRead + right.cacheRead,
        cacheWrite = left.cacheWrite + right.cacheWrite;
    return {input, output, reasoning, cacheRead, cacheWrite,
        total: input + output + reasoning + cacheRead + cacheWrite, complete: left.complete && right.complete}
}

async function collectSessionUsage(sessionID: string, directory: string): Promise<TokenUsage> {
    let result: TokenUsage = {input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, complete: true};
    const messages = (await opencode.session.messages({sessionID, directory})).data || [];
    for (const message of messages) {
        if (message.info.role !== "assistant") continue;
        const usage = normalizeTokens(message.info.tokens);
        if (usage) result = addUsage(result, usage); else result.complete = false
    }
    const children = (await opencode.session.children({sessionID, directory})).data || [];
    for (const child of children) result = addUsage(result, await collectSessionUsage(child.id, directory));
    return result
}

@Injectable()
export class RunsService {
    constructor(private db: PrismaService) {
    }

    async create(projectId: string, autoRetry = true) {
        const active = await this.db.phase2Run.findFirst({where: {projectId, status: {in: ["QUEUED", "RUNNING"]}}});
        if (active) throw new ConflictException("该项目已有Phase 2任务");
        const edit = await this.db.phase2EditRun.findFirst({where: {projectId, status: {in: ["QUEUED", "RUNNING"]}}});
        if (edit) throw new ConflictException("该项目正在编辑重建");
        const run = await this.db.phase2Run.create({data: {projectId, autoRetry}});
        await this.db.project.update({where: {id: projectId}, data: {status: "GENERATING"}});
        await this.db.runEvent.create({data: {runId: run.id, type: "run.queued", payload: {projectId}}});
        await queue.add("matrix-phase2", {runId: run.id, projectId}, {
            jobId: run.id,
            removeOnComplete: 100,
            removeOnFail: 100
        });
        return this.get(run.id)
    }

    async resume(id: string) {
        const run = await this.db.phase2Run.findUniqueOrThrow({where: {id}});
        if (!(run.status === "FAILED" || run.status === "CANCELLED")) {
            throw new ConflictException("只有失败或已终止的任务可以继续")
        }
        const active = await this.db.phase2Run.findFirst({where: {
            projectId: run.projectId, status: {in: ["QUEUED", "RUNNING"]}
        }});
        if (active) throw new ConflictException("该项目已有Phase 2任务");
        const edit = await this.db.phase2EditRun.findFirst({where: {
            projectId: run.projectId, status: {in: ["QUEUED", "RUNNING"]}
        }});
        if (edit) throw new ConflictException("该项目正在编辑重建");
        await this.db.phase2Run.update({where: {id}, data: {
            status: "QUEUED", finishedAt: null, errorMessage: null, opencodeSessionId: null,
            currentStage: "resume_queued"
        }});
        await this.db.project.update({where: {id: run.projectId}, data: {status: "GENERATING"}});
        await this.db.runEvent.create({data: {runId: id, type: "run.resumed", payload: {manual: true}}});
        try {
            await queue.add("matrix-phase2-resume", {runId: id, projectId: run.projectId}, {
                jobId: `${id}-resume-${Date.now()}`, removeOnComplete: 100, removeOnFail: 100
            })
        } catch (error) {
            await this.db.phase2Run.update({where: {id}, data: {status: "FAILED", finishedAt: new Date(),
                errorMessage: "继续任务入队失败"}});
            await this.db.project.update({where: {id: run.projectId}, data: {status: "FAILED"}});
            throw error
        }
        return this.get(id)
    }

    async setAutoRetry(id: string, value: unknown) {
        if (typeof value !== "boolean") throw new BadRequestException("autoRetry必须是布尔值");
        await this.db.phase2Run.update({where: {id}, data: {autoRetry: value}});
        await this.db.runEvent.create({data: {runId: id, type: "run.auto_retry_changed", payload: {enabled: value}}});
        return this.get(id)
    }

    async get(id: string) {
        return readWithRunClock(this.db, async (tx, now) => {
            const run = await tx.phase2Run.findUniqueOrThrow({
                where: {id},
                include: {events: {orderBy: {id: "desc"}, take: 100}}
            });
            return {...withElapsed(run, now), events: run.events.map(item => ({...item, id: item.id.toString()}))}
        })
    }

    async eventHistory(id: string, after?: string, requestedLimit?: string) {
        let cursor = BigInt(0);
        if (after !== undefined) {
            try {
                cursor = BigInt(after)
            } catch {
                throw new BadRequestException("after必须是有效的事件ID")
            }
            if (cursor < BigInt(0)) throw new BadRequestException("after必须是非负事件ID")
        }
        const parsedLimit = requestedLimit === undefined ? 200 : Number(requestedLimit);
        if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
            throw new BadRequestException("limit必须是正整数")
        }
        const limit = Math.min(parsedLimit, 500);
        const rows = await this.db.runEvent.findMany({
            where: {runId: id, id: {gt: cursor}},
            orderBy: {id: "asc"},
            take: limit + 1
        });
        const hasMore = rows.length > limit, items = rows.slice(0, limit);
        return {
            items: items.map(item => ({...item, id: item.id.toString()})),
            nextCursor: items.length ? items.at(-1)!.id.toString() : undefined,
            hasMore
        }
    }

    async cancel(id: string) {
        const run = await this.db.phase2Run.findUniqueOrThrow({where: {id}, include: {project: true}});
        if (!(["QUEUED", "RUNNING"] as string[]).includes(run.status)) throw new ConflictException("任务已经结束，无法终止");
        let finalUsage: TokenUsage | undefined;
        if (run.opencodeSessionId) {
            try {
                const collected = await collectSessionUsage(run.opencodeSessionId, run.project.workspacePath);
                const existing = run.tokenUsage as TokenUsage | null;
                finalUsage = existing && existing.total > collected.total ? existing : collected
            } catch {
                const existing = run.tokenUsage as TokenUsage | null;
                if (existing) finalUsage = {...existing, complete: false}
            }
        }
        await this.db.$transaction(async tx => {
            const [clock] = await tx.$queryRaw<{now: Date}[]>`SELECT statement_timestamp() AT TIME ZONE 'UTC' AS now`;
            await tx.$executeRaw`UPDATE "Phase2Run"
                SET status = 'CANCELLED', "finishedAt" = ${clock.now}, "errorMessage" = NULL,
                    "accumulatedElapsedMs" = "accumulatedElapsedMs" + CASE WHEN "attemptStartedAt" IS NULL THEN 0
                      ELSE GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (${clock.now} - "attemptStartedAt")) * 1000))::BIGINT END,
                    "attemptStartedAt" = NULL
                WHERE id = ${id} AND status IN ('QUEUED', 'RUNNING')`;
            if (finalUsage) await tx.phase2Run.update({where: {id}, data: {tokenUsage: finalUsage, usageUpdatedAt: new Date()}})
        });
        await this.db.runEvent.create({data: {runId: id, type: "run.cancelled", payload: {}}});
        const job = await queue.getJob(id), state = await job?.getState();
        if (job && state !== "active") await job.remove();
        if (run.opencodeSessionId) {
            await opencode.session.abort({
                sessionID: run.opencodeSessionId,
                directory: run.project.workspacePath
            }).catch(() => undefined)
        }
        const missing = Array.isArray(run.project.missingArtifacts) ? run.project.missingArtifacts.length : 0;
        await this.db.project.update({
            where: {id: run.projectId},
            data: {status: missing === 0 ? "READY_FOR_REVIEW" : missing >= 13 ? "PENDING_GENERATION" : "INCOMPLETE_MATRIX"}
        });
        return this.get(id)
    }

    events(id: string): Observable<MessageEvent> {
        let cursor = BigInt(0);
        const events = interval(1000).pipe(startWith(0), switchMap(() => this.db.runEvent.findMany({
            where: {
                runId: id,
                id: {gt: cursor}
            }, orderBy: {id: "asc"}
        })), map(rows => {
            if (rows.length) cursor = rows.at(-1)!.id;
            return {type: "run-events", data: rows.map(row => ({...row, id: row.id.toString()}))} as MessageEvent
        }));
        const state = interval(1000).pipe(startWith(0), switchMap(() => readWithRunClock(this.db, async (tx, now) => {
            const run = await tx.phase2Run.findUnique({
                where: {id}, select: {id: true, status: true, startedAt: true, finishedAt: true,
                    accumulatedElapsedMs: true, attemptStartedAt: true, autoRetry: true, attemptCount: true,
                    tokenUsage: true, usageUpdatedAt: true}
            });
            return run ? withElapsed(run, now) : null
        })), map(run => ({type: "run-state", data: run || undefined}) as MessageEvent));
        return merge(events, state)
    }
}

@Controller("phase2-runs")
export class RunsController {
    constructor(private runs: RunsService) {
    }

    @Post("project/:projectId") create(@Param("projectId") id: string, @Body() body: {autoRetry?: unknown} = {}) {
        if (body.autoRetry !== undefined && typeof body.autoRetry !== "boolean") throw new BadRequestException("autoRetry必须是布尔值");
        return this.runs.create(id, body.autoRetry === undefined ? true : body.autoRetry)
    }

    @Get(":id") get(@Param("id") id: string) {
        return this.runs.get(id)
    }

    @Get(":id/event-history") eventHistory(@Param("id") id: string, @Query("after") after?: string,
                                            @Query("limit") limit?: string) {
        return this.runs.eventHistory(id, after, limit)
    }

    @Post(":id/cancel") cancel(@Param("id") id: string) {
        return this.runs.cancel(id)
    }

    @Post(":id/resume") resume(@Param("id") id: string) {
        return this.runs.resume(id)
    }

    @Patch(":id/auto-retry") setAutoRetry(@Param("id") id: string, @Body() body: {autoRetry?: unknown}) {
        return this.runs.setAutoRetry(id, body?.autoRetry)
    }

    @Sse(":id/events") events(@Param("id") id: string) {
        return this.runs.events(id)
    }
}
