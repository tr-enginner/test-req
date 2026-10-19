import "dotenv/config";
import {opencodeFetch, describeError} from "./opencode-transport.js";
import {runSessionTasks} from "./session-tasks.js";
import {Queue, Worker} from "bullmq";
import {Redis} from "ioredis";
import {Pool} from "pg";
import {createOpencodeClient, type Event, type ToolPart} from "@opencode-ai/sdk/v2";
import {access, readFile, stat} from "node:fs/promises";
import {createHash} from "node:crypto";
import path from "node:path";
import {missingCompletionStages, parseToolOutput, progressOf, workerBatchIndex} from "./progress.js";
import {indexAvailableRequirements, indexProject} from "./indexing.js";
import {restorePhase2Edit, restorePublishedPhase2Edit, startPhase2EditWorker} from "./phase2-edit.js";
import {createRequirementRevision, removeRequirementRevision} from "./requirement-revisions.js";
import {addUsage, emptyTokenUsage, normalizeTokens, SessionUsageTracker, type TokenUsage} from "./token-usage.js";
import {decidePhase2Retry, Phase2ExecutionError} from "./retry-policy.js";

const connection = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {maxRetriesPerRequest: null}),
    db = new Pool({connectionString: process.env.DATABASE_URL}),
    phase2Queue = new Queue("phase2", {connection});
const auth = Buffer.from(`${process.env.OPENCODE_USERNAME || "opencode"}:${process.env.OPENCODE_PASSWORD || ""}`).toString("base64");
const client = createOpencodeClient({
    fetch: opencodeFetch,
    baseUrl: process.env.OPENCODE_URL || "http://localhost:4096",
    headers: {Authorization: `Basic ${auth}`}
});

const STAGE_ARTIFACTS: Record<string, string> = {
    finalize_chapter1_scope: "chapter1-scope.json",
    finalize_chapter2_system_overview: "chapter2-system-overview.json",
    finalize_hardware_interface: "hardware-interface-model.json",
    finalize_functional_test_content: "functional-test-content.json",
    finalize_performance_test_content: "performance-test-content.json",
    finalize_interface_test_content: "interface-test-content.json",
    finalize_reliability_safety_test_content: "reliability-safety-test-content.json",
    finalize_margin_test_content: "margin-test-content.json",
    finalize_boundary_test_content: "boundary-test-content.json",
    finalize_data_processing_test_content: "data-processing-test-content.json",
    finalize_recovery_test_content: "recovery-test-content.json",
    finalize_strength_test_content: "strength-test-content.json",
    generate_phase2_traceability: "phase2-test-traceability.json"
};
const INCREMENTAL_CHAPTER_STAGES = new Set(Object.keys(STAGE_ARTIFACTS));
async function configuredModel() {
    const configPath = process.env.OPENCODE_CONFIG_PATH || "/opencode-config/opencode.json";
    try {
        const config = JSON.parse(await readFile(configPath, "utf8")) as {model?: unknown};
        return typeof config.model === "string" && config.model.trim()
            ? config.model.trim()
            : "OpenCode默认模型"
    } catch {
        return "OpenCode当前配置模型"
    }
}

async function event(runId: string, type: string, payload: unknown) {
    await db.query('insert into "RunEvent" ("runId","type","payload") values ($1,$2,$3)', [runId, type, JSON.stringify(payload)])
}

async function update(runId: string, data: {
    status?: string;
    stage?: string;
    progress?: number;
    session?: string;
    error?: string;
    completed?: Set<string>;
    tokenUsage?: TokenUsage
}) {
    const fields: string[] = [], values: unknown[] = [];
    const add = (column: string, value: unknown) => {
        values.push(value);
        fields.push(`"${column}"=$${values.length}`)
    };
    if (data.status) add("status", data.status);
    if (data.stage !== undefined) add("currentStage", data.stage);
    if (data.progress !== undefined) add("progress", data.progress);
    if (data.session) add("opencodeSessionId", data.session);
    if (data.error !== undefined) add("errorMessage", data.error);
    if (data.completed) add("completedStages", JSON.stringify([...data.completed]));
    if (data.tokenUsage) {
        add("tokenUsage", JSON.stringify(data.tokenUsage));
        add("usageUpdatedAt", new Date())
    }
    if (data.status === "RUNNING") fields.push(`"startedAt"=coalesce("startedAt", statement_timestamp() AT TIME ZONE 'UTC')`);
    if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(data.status || "")) {
        fields.push(`"finishedAt"=statement_timestamp() AT TIME ZONE 'UTC'`);
        fields.push(`"accumulatedElapsedMs"="accumulatedElapsedMs" + CASE WHEN "attemptStartedAt" IS NULL THEN 0 ELSE GREATEST(0, FLOOR(EXTRACT(EPOCH FROM ((statement_timestamp() AT TIME ZONE 'UTC') - "attemptStartedAt")) * 1000))::BIGINT END`);
        fields.push(`"attemptStartedAt"=NULL`)
    }
    values.push(runId);
    const terminal = ["SUCCEEDED", "FAILED", "CANCELLED"].includes(data.status || "");
    const result = await db.query(`update "Phase2Run"
                    set ${fields.join(",")}
                    where id = $${values.length}${terminal ? " and status='RUNNING'" : ""}`, values);
    return result.rowCount || 0
}

async function claim(runId: string) {
    const result = await db.query(`update "Phase2Run" set status=$1,
        "startedAt"=coalesce("startedAt",statement_timestamp() AT TIME ZONE 'UTC'),
        "attemptStartedAt"=statement_timestamp() AT TIME ZONE 'UTC',
        "attemptCount"="attemptCount"+1,"finishedAt"=NULL
        ,"currentStage"=CASE WHEN "attemptCount">0 THEN 'resume_check_artifacts' ELSE "currentStage" END
        where id=$2 and status=$3 returning id,"attemptCount"`, ["RUNNING", runId, "QUEUED"]);
    return result.rowCount === 1 ? Number(result.rows[0].attemptCount) : undefined
}

async function finishFailedAttempt(runId: string, message: string, completed: Set<string>, retryQueued: boolean) {
    const result = await db.query(`update "Phase2Run" set
        "accumulatedElapsedMs"="accumulatedElapsedMs" + CASE WHEN "attemptStartedAt" IS NULL THEN 0 ELSE GREATEST(0, FLOOR(EXTRACT(EPOCH FROM ((statement_timestamp() AT TIME ZONE 'UTC') - "attemptStartedAt")) * 1000))::BIGINT END,
        "attemptStartedAt"=NULL,"completedStages"=$1,"errorMessage"=$2,
        status=CASE WHEN $4 THEN 'QUEUED'::"RunStatus" ELSE 'FAILED'::"RunStatus" END,
        "currentStage"=CASE WHEN $4 THEN 'retry_queued' ELSE "currentStage" END,
        "finishedAt"=CASE WHEN $4 THEN NULL ELSE statement_timestamp() AT TIME ZONE 'UTC' END,
        "opencodeSessionId"=NULL
        where id=$3 and status='RUNNING' returning status,"autoRetry","attemptCount"`,
        [JSON.stringify([...completed]), message, runId, retryQueued]);
    return result.rows[0] as {status: string; autoRetry: boolean; attemptCount: number} | undefined
}

async function retryContext(runId: string) {
    const result = await db.query(`select r."autoRetry",
        (select e.payload->>'fingerprint' from "RunEvent" e
         where e."runId"=r.id and e.type='run.attempt_failed' order by e.id desc limit 1) as "previousFingerprint"
        from "Phase2Run" r where r.id=$1`, [runId]);
    return result.rows[0] as {autoRetry: boolean; previousFingerprint?: string} | undefined
}

async function stageInputFingerprint(workspace: string, stage: string) {
    const names = stage.includes("hardware_interface")
        ? ["source-artifacts.json", "hardware-interface-candidates.json"]
        : ["source-artifacts.json"];
    const hash = createHash("sha256");
    for (const name of names) {
        const file = path.join(workspace, ".matrix", "data", name);
        try { hash.update(name).update(await readFile(file)) }
        catch { hash.update(name).update("<missing>") }
    }
    return hash.digest("hex")
}

async function cancelled(runId: string) {
    const result = await db.query('select status from "Phase2Run" where id=$1', [runId]);
    return result.rows[0]?.status === "CANCELLED"
}

async function project(runId: string) {
    const result = await db.query('select p.id,p."workspacePath",r."completedStages",r."tokenUsage" from "Project" p join "Phase2Run" r on r."projectId"=p.id where r.id=$1', [runId]);
    if (!result.rows[0]) throw new Error("任务项目不存在");
    return result.rows[0] as { id: string; workspacePath: string; completedStages: unknown; tokenUsage: TokenUsage | null }
}

async function verify(workspace: string) {
    const report = path.join(workspace, ".matrix", "reports", "phase2-test-requirements.docx");
    await access(report);
    if ((await stat(report)).size === 0) throw new Error("最终Phase 2 DOCX为空")
}

async function verifyStageArtifact(workspace: string, stage: string) {
    const artifact = STAGE_ARTIFACTS[stage];
    if (!artifact) return;
    const file = path.join(workspace, ".matrix", "data", artifact);
    try {
        JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
        throw new Error(`${stage}: 最终工件 ${artifact} 不存在或不是有效JSON（${error instanceof Error ? error.message : String(error)}）`)
    }
}

async function consume(runId: string, sessionId: string, directory: string, completed: Set<string>,
                       tracker: SessionUsageTracker, signal: AbortSignal, onStage: (stage: string) => void) {
    const subscription = await client.event.subscribe({directory}, {signal});
    let dirty = false, lastFlush = 0, flushTimer: ReturnType<typeof setTimeout> | undefined;
    const flushUsage = async (force = false) => {
        if (force && flushTimer) {
            clearTimeout(flushTimer);
            flushTimer = undefined
        }
        if (!dirty && !force) return;
        const now = Date.now();
        if (!force && now - lastFlush < 1000) {
            if (!flushTimer) flushTimer = setTimeout(() => {
                flushTimer = undefined;
                void flushUsage(true).catch(() => tracker.markIncomplete())
            }, 1000 - (now - lastFlush));
            return
        }
        if (flushTimer) {
            clearTimeout(flushTimer);
            flushTimer = undefined
        }
        await update(runId, {tokenUsage: tracker.snapshot()});
        dirty = false;
        lastFlush = now
    };
    for await(const item of subscription.stream) {
        if (signal.aborted) {
            await flushUsage(true);
            return
        }
        const e = item as Event;
        if (e.type === "session.created") {
            tracker.trackSession(e.properties.info.id, e.properties.info.parentID)
        } else if (e.type === "message.updated") {
            const message = e.properties.info;
            if (message.role === "assistant" && tracker.isTracked(message.sessionID)) {
                dirty = tracker.setMessage(message.sessionID, message.id, message.tokens) || dirty;
                await flushUsage()
            }
        } else if (e.type === "message.part.updated") {
            const part = e.properties.part;
            if (part.type !== "tool" || part.sessionID !== sessionId || part.tool !== "filldata_phase2_workflow") continue;
            onStage(String(part.state.input.mode || "filldata_phase2_workflow"));
            await handleTool(runId, part, completed, directory)
        } else if (e.type === "session.error" && e.properties.sessionID === sessionId) {
            await flushUsage(true);
            throw new Error(JSON.stringify(e.properties.error || "OpenCode会话错误"))
        } else if (e.type === "session.idle" && e.properties.sessionID === sessionId) {
            await flushUsage(true);
            return
        }
    }
}

async function collectSessionUsage(sessionId: string, directory: string): Promise<TokenUsage> {
    let result = emptyTokenUsage();
    const messages = (await client.session.messages({sessionID: sessionId, directory})).data || [];
    for (const message of messages) {
        if (message.info.role !== "assistant") continue;
        const usage = normalizeTokens(message.info.tokens);
        if (usage) result = addUsage(result, usage);
        else result.complete = false
    }
    const children = (await client.session.children({sessionID: sessionId, directory})).data || [];
    for (const child of children) result = addUsage(result, await collectSessionUsage(child.id, directory));
    return result
}

async function sessionStopSummary(sessionId: string, directory: string) {
    try {
        const response = await client.session.messages({sessionID: sessionId, directory, limit: 10});
        const messages = response.data || [];
        for (let index = messages.length - 1; index >= 0; index--) {
            if (messages[index].info.role !== "assistant") continue;
            const text = messages[index].parts
                .filter(part => part.type === "text")
                .map(part => part.text)
                .join("\n")
                .replace(/\s+/g, " ")
                .trim();
            if (text) return text.slice(0, 500)
        }
    } catch {
    }
    return "OpenCode会话已结束，但未完成全部Phase 2最终阶段"
}

async function handleTool(runId: string, part: ToolPart, completed: Set<string>, workspace: string) {
    const mode = String(part.state.input.mode || "");
    const batchIndex = workerBatchIndex(mode, part.state.input);
    const stage = Number.isInteger(batchIndex) && batchIndex! > 0 ? `${mode}:${batchIndex}` : mode;
    if (part.state.status === "running") {
        await update(runId, {stage});
        await event(runId, "stage.running", {mode, batchIndex});
        return
    }
    if (part.state.status === "error") throw new Phase2ExecutionError(`${mode}: ${part.state.error}`, "TOOL_EXECUTION_ERROR", true);
    if (part.state.status !== "completed") return;
    const output = parseToolOutput(part.state.output, part.state.metadata);
    if (output.ok !== true) throw new Phase2ExecutionError(
        `${mode}: ${output.error || "业务执行失败"}`,
        String(output.error_code || "WORKFLOW_BUSINESS_ERROR"),
        true,
        typeof output.failed_candidate_id === "string" ? output.failed_candidate_id : undefined,
    );
    const actual = output.mode || mode;
    await verifyStageArtifact(workspace, actual);
    completed.add(actual);
    const progress = progressOf(completed);
    const completedStage = Number.isInteger(batchIndex) && batchIndex! > 0 ? `${actual}:${batchIndex}` : actual;
    await update(runId, {stage: completedStage, progress, completed});
    if (actual === "prepare_document_artifacts" || INCREMENTAL_CHAPTER_STAGES.has(actual)) {
        const projectRow = (await db.query('select "projectId" from "Phase2Run" where id=$1', [runId])).rows[0];
        if (projectRow?.projectId) {
            if (actual === "prepare_document_artifacts") await indexProject(db, projectRow.projectId, workspace);
            else await indexAvailableRequirements(db, projectRow.projectId, workspace)
        }
    }
    await event(runId, "stage.completed", {
        mode: actual,
        batchIndex,
        progress,
        summary: output.summary,
        output: output.output,
        warnings: output.warnings,
        skipped_count: output.skipped_count
    })
}

new Worker("phase2", async job => {
    const runId = String(job.data.runId), p = await project(runId),
        completed = new Set<string>(Array.isArray(p.completedStages) ? p.completedStages.map(String) : []),
        abort = new AbortController();
    let generatedBaselineId = "";
    let activeSessionId = "", failureStage = "创建OpenCode会话";
    const attempt = await claim(runId);
    if (!attempt) return {cancelled: true};
    await event(runId, "run.started", {projectId: p.id, attempt});
    try {
        await event(runId, "model.selected", {model: await configuredModel()});
        if (await cancelled(runId)) return {cancelled: true};
        const created = await client.session.create({directory: p.workspacePath, title: `Phase 2 ${p.id}`});
        if (!created.data) throw new Error("创建OpenCode会话失败");
        const sessionId = created.data.id;
        activeSessionId = sessionId;
        const usageBaseline = p.tokenUsage || emptyTokenUsage();
        const usageTracker = new SessionUsageTracker(sessionId, usageBaseline);
        await update(runId, {session: sessionId});
        if (await cancelled(runId)) {
            await client.session.abort({sessionID: sessionId, directory: p.workspacePath}).catch(() => undefined);
            return {cancelled: true}
        }
        await event(runId, "session.created", {sessionId});
        await event(runId, "command.started", {command: "/matrix-phase2"});
        failureStage = "执行matrix-phase2命令";
        await runSessionTasks(
            () => consume(runId, sessionId, p.workspacePath, completed, usageTracker, abort.signal, stage => { failureStage = stage }),
            () => client.session.command({
                sessionID: sessionId,
                directory: p.workspacePath,
                command: "matrix-phase2",
                arguments: ""
            }, {signal: abort.signal, throwOnError: true}));
        try {
            await update(runId, {tokenUsage: addUsage(usageBaseline, await collectSessionUsage(sessionId, p.workspacePath))})
        } catch {
            usageTracker.markIncomplete();
            await update(runId, {tokenUsage: usageTracker.snapshot()})
        }
        const missingStages = missingCompletionStages(completed);
        if (missingStages.length) {
            const summary = await sessionStopSummary(sessionId, p.workspacePath);
            throw new Error(`Phase 2工作流提前结束，仅完成：${[...completed].join(", ") || "无"}。${summary}`)
        }
        failureStage = "验证Phase 2最终报告";
        await verify(p.workspacePath);
        if (await cancelled(runId)) return {cancelled: true};
        failureStage = "建立Phase 2评审索引";
        await indexProject(db, p.id, p.workspacePath);
        failureStage = "保存Phase 2基线版本";
        const baseline: any = await createRequirementRevision(db, {projectId: p.id, workspace: p.workspacePath, kind: "GENERATED_BASELINE"});
        generatedBaselineId = baseline.revisionId || "";
        const completedRun = await update(runId, {status: "SUCCEEDED", progress: 100, stage: "finalize_phase2_document", completed, error: ""});
        if (!completedRun) {
            if (generatedBaselineId) await removeRequirementRevision(db, generatedBaselineId).catch(() => undefined);
            return {cancelled: true}
        }
        await db.query('update "Project" set status=$1,"missingArtifacts"=$2,"updatedAt"=now() where id=$3', ["READY_FOR_REVIEW", JSON.stringify([]), p.id]);
        await event(runId, "run.succeeded", {attempt});
        return {ok: true}
    } catch (error) {
        abort.abort();
        if (activeSessionId) {
            await client.session.abort({sessionID: activeSessionId, directory: p.workspacePath}, {signal: AbortSignal.timeout(5000)}).catch(() => undefined);
        }
        if (generatedBaselineId) await removeRequirementRevision(db, generatedBaselineId).catch(() => undefined);
        if (await cancelled(runId)) return {cancelled: true};
        const reason = describeError(error);
        console.error("Phase2 attempt failed", {runId, stage: failureStage, reason, error});
        const message = `失败阶段：${failureStage}；原因：${reason}`;
        const context = await retryContext(runId);
        const retry = decidePhase2Retry({
            autoRetry: context?.autoRetry === true,
            attempt,
            stage: failureStage,
            error,
            inputFingerprint: await stageInputFingerprint(p.workspacePath, failureStage),
            previousFingerprint: context?.previousFingerprint,
        });
        const failed = await finishFailedAttempt(runId, message, completed, retry.shouldRetry);
        if (!failed) return {cancelled: true};
        await event(runId, "run.attempt_failed", {
            message, stage: failureStage, reason, attempt: failed.attemptCount,
            errorCode: retry.errorCode, retryable: retry.retryable, fingerprint: retry.fingerprint,
            failedCandidateId: retry.failedCandidateId, stopReason: retry.stopReason,
        });
        if (retry.shouldRetry) {
            await event(runId, "run.retry_queued", {attempt: failed.attemptCount + 1, delayMs: retry.delayMs});
            try {
                await phase2Queue.add("matrix-phase2-retry", {runId, projectId: p.id}, {
                    jobId: `${runId}-retry-${failed.attemptCount}-${Date.now()}`,
                    delay: retry.delayMs,
                    removeOnComplete: 100, removeOnFail: 100
                });
                return {retrying: true}
            } catch (queueError) {
                const queueMessage = `自动重试入队失败：${queueError instanceof Error ? queueError.message : String(queueError)}`;
                const marked = await db.query(`update "Phase2Run" set status='FAILED',"finishedAt"=statement_timestamp() AT TIME ZONE 'UTC',"errorMessage"=$1 where id=$2 and status='QUEUED' returning id`, [queueMessage, runId]);
                if (!marked.rowCount) return {cancelled: true};
                await db.query('update "Project" set status=$1,"updatedAt"=now() where id=$2', ["FAILED", p.id]);
                await event(runId, "run.failed", {message: queueMessage, attempt: failed.attemptCount});
                throw queueError
            }
        }
        await db.query('update "Project" set status=$1,"updatedAt"=now() where id=$2', ["FAILED", p.id]);
        await event(runId, "run.failed", {message, stage: failureStage, reason, attempt: failed.attemptCount});
        throw error
    } finally {
        abort.abort();
    }
}, {
    connection,
    concurrency: +(process.env.PHASE2_CONCURRENCY || 2)
}).on("error", error => console.error("Phase2 worker error", error));

new Worker("document-index", async job => {
    const {projectId, workspacePath} = job.data as { projectId: string; workspacePath: string };
    await indexProject(db, projectId, workspacePath);
    return {ok: true}
}, {connection, concurrency: 2}).on("error", error => console.error("Document index worker error", error));

startPhase2EditWorker(connection, db).on("error", error => console.error("Phase2 edit worker error", error));

setTimeout(async () => {
    try {
        const projects = await db.query(`select p.id,p."workspacePath" from "Project" p where
            not exists (select 1 from "DocumentNode" n join "Document" d on d.id=n."documentId" where d."projectId"=p.id)
            or not exists (select 1 from "TestRequirementNode" n where n."projectId"=p.id and n."nodeType"='requirement' and n.artifact='performance-test-content.json')`);
        for (const item of projects.rows) await indexProject(db, item.id, item.workspacePath)
    } catch (error) {
        console.error("Existing project indexing failed", error)
    }
}, 5000);

setTimeout(async () => {
    try {
        const staleRuns = await db.query('select id,"projectId" from "Phase2Run" where status=$1', ["RUNNING"]);
        for (const run of staleRuns.rows) {
            await db.query(`update "Phase2Run" set status=$1,"opencodeSessionId"=null,"finishedAt"=null,
                "accumulatedElapsedMs"="accumulatedElapsedMs" + CASE WHEN "attemptStartedAt" IS NULL THEN 0 ELSE GREATEST(0, FLOOR(EXTRACT(EPOCH FROM ((statement_timestamp() AT TIME ZONE 'UTC') - "attemptStartedAt")) * 1000))::BIGINT END,
                "attemptStartedAt"=NULL where id=$2 and status=$3`, ["QUEUED", run.id, "RUNNING"]);
            await event(run.id, "run.resumed", {reason: "Worker重启，复用已有Raw工件继续执行"});
            await phase2Queue.add("matrix-phase2-resume", {runId: run.id, projectId: run.projectId}, {
                jobId: `${run.id}-resume-${Date.now()}`,
                removeOnComplete: 100,
                removeOnFail: 100
            })
        }
    } catch (error) {
        console.error("Stale Phase2 run recovery failed", error)
    }
}, 2000);

setTimeout(async () => {
    try {
        const stale = await db.query(`select r.id,r."projectId",r."backupPath",r."savedAt",p."workspacePath"
            from "Phase2EditRun" r join "Project" p on p.id=r."projectId" where r.status='RUNNING'`);
        for (const run of stale.rows) {
            let recoveryError = "";
            try {
                if (run.backupPath) {
                    if (run.savedAt) await restorePublishedPhase2Edit(run.workspacePath, run.backupPath);
                    else await restorePhase2Edit(run.workspacePath, run.backupPath)
                }
                await indexProject(db, run.projectId, run.workspacePath)
            } catch (error) { recoveryError = `；恢复上一发布版本失败：${describeError(error)}` }
            const draftSaved = Boolean(run.savedAt);
            await db.query(`update "Phase2EditRun" set status='FAILED',"draftStatus"=$2,"errorMessage"=$3,"finishedAt"=now() where id=$1`,
                [run.id, draftSaved ? "PUBLISH_FAILED" : "NONE", draftSaved ? `编辑worker重启；编辑稿已保存，发布失败${recoveryError}` : `编辑worker重启，任务已停止${recoveryError}`]);
            await db.query(`update "Project" set status='READY_FOR_REVIEW',"updatedAt"=now() where id=$1 and status='REBUILDING'`, [run.projectId])
        }
    } catch (error) { console.error("Stale Phase2 edit recovery failed", error) }
}, 2500);
