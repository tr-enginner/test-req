import {Worker} from "bullmq";
import type {Redis} from "ioredis";
import type {Pool} from "pg";
import {cp, mkdir, readFile, rm, stat, writeFile} from "node:fs/promises";
import path from "node:path";
import {indexAvailableRequirements, indexProject} from "./indexing.js";
import {assertRequirementBaselineForRebuild, createRequirementRevision, ensureRequirementBaselineForEdit, removeRequirementRevision} from "./requirement-revisions.js";

const auth = Buffer.from(`${process.env.OPENCODE_USERNAME || "opencode"}:${process.env.OPENCODE_PASSWORD || ""}`).toString("base64");
const baseUrl = process.env.MATRIX_PHASE2_RUNNER_URL || "http://localhost:4097";
const modeByArtifact: Record<string, string[]> = {
    "chapter1-scope.json": ["finalize_chapter1_scope"],
    "chapter2-system-overview.json": ["finalize_chapter2_system_overview"],
    "hardware-interface-model.json": ["finalize_hardware_interface"],
    "functional-test-content.json": ["finalize_functional_other_content", "finalize_functional_test_content"],
    "performance-test-content.json": ["finalize_performance_test_content"],
    "interface-test-content.json": ["finalize_interface_test_content"],
    "reliability-safety-test-content.json": ["finalize_reliability_safety_test_content"],
    "margin-test-content.json": ["finalize_margin_test_content"],
    "boundary-test-content.json": ["finalize_boundary_test_content"],
    "data-processing-test-content.json": ["finalize_data_processing_test_content"],
    "recovery-test-content.json": ["finalize_recovery_test_content"],
    "strength-test-content.json": ["finalize_strength_test_content"]
};

async function call<T = any>(endpoint: string, body: unknown): Promise<T> {
    const response = await fetch(`${baseUrl}${endpoint}`, {method: "POST", headers: {"Content-Type": "application/json", Authorization: `Basic ${auth}`}, body: JSON.stringify(body)});
    const result = await response.json().catch(() => ({})) as any;
    if (!response.ok || result.ok === false) throw new Error(result.error || `runner HTTP ${response.status}`);
    return result
}

async function copyIfExists(source: string, target: string) {
    try { await stat(source); await cp(source, target, {recursive: true}) } catch (error: any) { if (error?.code !== "ENOENT") throw error }
}

const reportByArtifact: Record<string, string> = {
    "chapter1-scope.json": "chapter1-scope.docx", "chapter2-system-overview.json": "chapter2-system-overview.docx",
    "hardware-interface-model.json": "hardware-interface-model.docx", "functional-test-content.json": "functional-test-content.docx",
    "performance-test-content.json": "performance-test-content.docx", "interface-test-content.json": "interface-test-content.docx",
    "reliability-safety-test-content.json": "reliability-safety-test-content.docx", "margin-test-content.json": "margin-test-content.docx",
    "boundary-test-content.json": "boundary-test-content.docx", "data-processing-test-content.json": "data-processing-test-content.docx",
    "recovery-test-content.json": "recovery-test-content.docx", "strength-test-content.json": "strength-test-content.docx"
};

export function requestedArtifacts(request: any) {
    const encoded = [...(request.changes || []).map((item: any) => item.edit_key),
        ...(request.table_operations || []).map((item: any) => item.container_key),
        ...(request.requirement_operations || []).map((item: any) => item.container_key),
        ...(request.reference_operations || []).map((item: any) => item.container_key)];
    const artifacts = new Set<string>();
    for (const value of encoded) try {
        const key = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
        if (key?.artifact) artifacts.add(String(key.artifact))
    } catch { /* runner performs authoritative validation */ }
    return [...artifacts]
}

export async function backupPhase2Edit(workspace: string, runId: string, request: any, mutationFiles: string[]) {
    const root = path.join(workspace, ".matrix", "history", "rollback", runId);
    await rm(root, {recursive: true, force: true});
    await mkdir(root, {recursive: true});
    const files = new Set<string>([".matrix/data/phase2-test-traceability.json",
        ".matrix/reports/phase2-test-traceability.docx", ".matrix/reports/phase2-test-requirements.docx",
        ".matrix/data/phase2-editor-state.json"]);
    for (const artifact of requestedArtifacts(request)) {
        files.add(`.matrix/data/${artifact}`);
        if (reportByArtifact[artifact]) files.add(`.matrix/reports/${reportByArtifact[artifact]}`);
        if (artifact === "functional-test-content.json") {
            files.add(".matrix/data/functional-init-content.json");
            files.add(".matrix/reports/functional-init-content.docx");
            files.add(".matrix/data/functional-other-content.json");
            files.add(".matrix/reports/functional-other-content.docx")
        }
    }
    for (const file of mutationFiles) {
        const relative = path.relative(workspace, path.resolve(file));
        if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`非法编辑备份路径: ${file}`);
        files.add(relative)
    }
    const copied: string[] = [], absent: string[] = [];
    for (const relative of files) {
        const source = path.join(workspace, relative), target = path.join(root, relative);
        try { await stat(source); await mkdir(path.dirname(target), {recursive: true}); await cp(source, target); copied.push(relative) }
        catch (error: any) { if (error?.code === "ENOENT") absent.push(relative); else throw error }
    }
    const drafts = mutationFiles.map(file => path.relative(workspace, path.resolve(file)))
        .filter(relative => relative !== ".matrix/data/phase2-editor-state.json");
    await writeFile(path.join(root, "manifest.json"), JSON.stringify({files: copied, absent, drafts}, null, 2));
    return root
}

export async function restorePhase2Edit(workspace: string, root: string) {
    const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
    for (const relative of manifest.files || []) await copyIfExists(path.join(root, relative), path.join(workspace, relative))
    for (const relative of manifest.absent || []) await rm(path.join(workspace, relative), {recursive: true, force: true})
}

export async function restorePublishedPhase2Edit(workspace: string, root: string) {
    const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
    const drafts = new Set<string>(manifest.drafts || []);
    for (const relative of manifest.files || []) if (!drafts.has(relative)) await copyIfExists(path.join(root, relative), path.join(workspace, relative));
    for (const relative of manifest.absent || []) if (!drafts.has(relative)) await rm(path.join(workspace, relative), {recursive: true, force: true})
}

export function startPhase2EditWorker(connection: Redis, db: Pool) {
    return new Worker("phase2-edit", async job => {
        const runId = String(job.data.editRunId);
        const row = (await db.query(`select r.*,p."workspacePath" from "Phase2EditRun" r join "Project" p on p.id=r."projectId" where r.id=$1`, [runId])).rows[0];
        if (!row) throw new Error("Phase2编辑任务不存在");
        const projectLock = `phase2-edit-lock:${row.projectId}`, token = `${process.pid}-${Date.now()}`;
        if (await connection.set(projectLock, token, "PX", 30 * 60_000, "NX") !== "OK") throw new Error("项目已有编辑重建任务");
        let backupPath = "";
        let publishedRevisionId = "";
        let editSaved = Boolean(row.savedAt);
        let generationMode = false;
        const warnings: string[] = [];
        let skippedCount = 0;
        const rebuildOnly = job.data.rebuildOnly === true;
        const stageTimings: Record<string, {startedAt: string; finishedAt: string; durationMs: number}> = {};
        const timed = async <T>(stage: string, work: () => Promise<T>) => {
            const startedAt = new Date(), started = performance.now();
            try { return await work() } finally {
                const finishedAt = new Date();
                stageTimings[stage] = {startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), durationMs: Math.round(performance.now() - started)};
                await db.query(`update "Phase2EditRun" set "stageTimings"=$1 where id=$2`, [JSON.stringify(stageTimings), runId])
            }
        };
        try {
            const request = typeof row.request === "string" ? JSON.parse(row.request) : row.request;
            if (job.data.discardDraft === true) {
                if (!row.backupPath) throw new Error("缺少可恢复的编辑备份");
                await restorePhase2Edit(row.workspacePath, row.backupPath);
                await indexProject(db, row.projectId, row.workspacePath, [], {skipDocuments: true});
                await db.query(`update "Phase2EditRun" set status='CANCELLED',progress=100,"currentStage"='discarded',"draftStatus"='NONE',"errorMessage"=null,"finishedAt"=now() where id=$1`, [runId]);
                await db.query(`update "Project" set status='READY_FOR_REVIEW',"updatedAt"=now() where id=$1`, [row.projectId]);
                return {ok: true, discarded: true}
            }
            await db.query(`update "Phase2EditRun" set warnings='[]'::jsonb,"skippedCount"=0 where id=$1`, [runId]);
            const batch = row.operation === "batch";
            generationMode = request.generation_mode === true;
            let applied: any;
            if (rebuildOnly) {
                await assertRequirementBaselineForRebuild(db, row.projectId);
                await db.query(`update "Phase2EditRun" set status='RUNNING',"startedAt"=coalesce("startedAt",now()),"finishedAt"=null,"errorMessage"=null,"currentStage"='resume_publish',progress=15 where id=$1`, [runId]);
                backupPath = row.backupPath || "";
                applied = typeof row.applyResult === "string" ? JSON.parse(row.applyResult) : row.applyResult;
                if (!applied) throw new Error("缺少已保存编辑稿的发布上下文")
            } else {
                await db.query(`update "Phase2EditRun" set status='RUNNING',"startedAt"=now(),"currentStage"='backup',progress=5 where id=$1`, [runId]);
                if (!generationMode) await timed("baseline", () => ensureRequirementBaselineForEdit(db, {
                    projectId: row.projectId, workspace: row.workspacePath, userId: row.userId
                }));
                const mutation = await call<{files?: string[]}>("/v1/phase2/editor/mutation-files", request);
                backupPath = await timed("backup", () => backupPhase2Edit(row.workspacePath, runId, request, mutation.files || []));
                await db.query(`update "Phase2EditRun" set "backupPath"=$1,"currentStage"='apply',progress=10 where id=$2`, [backupPath, runId]);
                applied = await timed("apply", () => call<any>(batch ? "/v1/phase2/editor/apply-batch" : "/v1/phase2/editor/apply", request));
                await db.query(`update "Phase2EditRun" set "savedAt"=now(),"savedRevision"=$1,"applyResult"=$2,"currentStage"='saved',"draftStatus"='SAVED',progress=15 where id=$3`,
                    [applied.revision || null, JSON.stringify(applied), runId]);
                editSaved = true
            }
            const artifacts: string[] = batch ? applied.artifacts : [String(applied.artifact || request.artifact)];
            let modes = [...new Set(artifacts.flatMap(artifact => modeByArtifact[artifact] || []))];
            if (!modes.length) throw new Error(`不支持重建工件 ${artifacts.join(", ")}`);
            if (artifacts.includes("functional-test-content.json")) {
                const paths: string[] = applied.raw_paths || [applied.raw_path];
                modes = modes.filter(mode => mode !== "finalize_functional_other_content");
                const functionalModes: string[] = [];
                if (paths.some(value => String(value).endsWith("functional-init-content.raw.json"))) functionalModes.push("finalize_functional_init_content");
                if (paths.some(value => !String(value).endsWith("functional-init-content.raw.json"))) functionalModes.push("finalize_functional_other_content");
                modes.unshift(...functionalModes)
            }
            const all = generationMode ? modes : [...modes, "generate_phase2_traceability", "finalize_phase2_document"];
            for (let i = 0; i < all.length; i++) {
                await db.query(`update "Phase2EditRun" set "currentStage"=$1,progress=$2 where id=$3`, [all[i], 15 + Math.floor(i / all.length * 70), runId]);
                const result: any = await timed(all[i], () => call("/v1/phase2/workflow/execute", {directory: row.workspacePath, mode: all[i], editor_fast_path: true}));
                if (Array.isArray(result?.warnings)) warnings.push(...result.warnings.map(String));
                skippedCount += Number(result?.skipped_count || 0);
                await db.query(`update "Phase2EditRun" set warnings=$1,"skippedCount"=$2 where id=$3`, [JSON.stringify([...new Set(warnings)]), skippedCount, runId])
            }
            if (!generationMode) {
                const total = path.join(row.workspacePath, ".matrix", "reports", "phase2-test-requirements.docx");
                if ((await stat(total)).size === 0) throw new Error("重建后的总DOCX为空")
            }
            await db.query(`update "Phase2EditRun" set "currentStage"='index',progress=90 where id=$1`, [runId]);
            await timed("index", () => generationMode
                ? indexAvailableRequirements(db, row.projectId, row.workspacePath, applied.requirement_id_renames || [])
                : indexProject(db, row.projectId, row.workspacePath, applied.requirement_id_renames || [], {skipDocuments: true}));
            if (generationMode) {
                await db.query(`update "Phase2EditRun" set status='SUCCEEDED',progress=100,"currentStage"='deferred_analysis',"draftStatus"='NONE',"publishedAt"=now(),"finishedAt"=now() where id=$1`, [runId]);
                await db.query(`insert into "AuditLog" ("userId",action,"resourceType","resourceId",detail) values ($1,'PHASE2_EDIT_SAVED_DURING_GENERATION','Phase2EditRun',$2,$3)`,
                    [row.userId, runId, JSON.stringify({artifacts, deferredAnalysis: true})]);
                return {ok: true, deferredAnalysis: true}
            }
            await db.query(`update "Phase2EditRun" set "currentStage"='snapshot',progress=96 where id=$1`, [runId]);
            const publishedRevision: any = await timed("snapshot", () => createRequirementRevision(db, {
                projectId: row.projectId, workspace: row.workspacePath, kind: "PUBLISHED", userId: row.userId,
                editRunId: runId, versionName: String(request.version_name || "").trim(), sourceRevision: row.expectedRevision, resultRevision: applied.revision || row.savedRevision
            }));
            publishedRevisionId = publishedRevision.revisionId || "";
            const client = await db.connect();
            try {
                await client.query("begin");
                await client.query(`update "Phase2EditRun" set status='SUCCEEDED',progress=100,"currentStage"='complete',"draftStatus"='NONE',"publishedAt"=now(),"finishedAt"=now() where id=$1`, [runId]);
                await client.query(`update "Project" set status='READY_FOR_REVIEW',"updatedAt"=now() where id=$1`, [row.projectId]);
                await client.query(`insert into "AuditLog" ("userId",action,"resourceType","resourceId",detail) values ($1,'PHASE2_EDIT_REBUILT','Phase2EditRun',$2,$3)`,
                    [row.userId, runId, JSON.stringify({operation: row.operation, targetBusinessId: row.targetBusinessId,
                        requirementId: applied.requirement_id, requirementIdRenames: applied.requirement_id_renames || [],
                        previousValue: applied.previous_value, backupPath})]);
                await client.query("commit")
            } catch (error) { await client.query("rollback"); throw error } finally { client.release() }
            return {ok: true}
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            try {
                if (publishedRevisionId) await removeRequirementRevision(db, publishedRevisionId);
                if (backupPath) {
                    if (editSaved) await restorePublishedPhase2Edit(row.workspacePath, backupPath);
                    else await restorePhase2Edit(row.workspacePath, backupPath);
                    if (generationMode) await indexAvailableRequirements(db, row.projectId, row.workspacePath);
                    else await indexProject(db, row.projectId, row.workspacePath, [], {skipDocuments: true})
                }
                if (!generationMode) await db.query(`update "Project" set status='READY_FOR_REVIEW',"updatedAt"=now() where id=$1`, [row.projectId]);
                const detail = editSaved ? `${message}（编辑稿已保存，继续使用上一发布版本）` : `${message}（修改未保存，上一发布版本未受影响）`;
                await db.query(`update "Phase2EditRun" set status='FAILED',"currentStage"='publish_failed',"draftStatus"=$1,"errorMessage"=$2,"finishedAt"=now() where id=$3`, [editSaved ? "PUBLISH_FAILED" : "NONE", detail, runId])
            } catch (rollbackError) {
                await db.query(`update "Project" set status='FAILED',"updatedAt"=now() where id=$1`, [row.projectId]);
                await db.query(`update "Phase2EditRun" set status='FAILED',"draftStatus"=$1,"errorMessage"=$2,"finishedAt"=now() where id=$3`,
                    [editSaved ? "PUBLISH_FAILED" : "NONE", `${message}；回滚失败：${String(rollbackError)}`, runId])
            }
            throw error
        } finally {
            await connection.eval(`if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end`, 1, projectLock, token)
        }
    }, {connection, concurrency: +(process.env.PHASE2_EDIT_CONCURRENCY || 1)})
}
