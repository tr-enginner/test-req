import "dotenv/config";
import {createHash} from "node:crypto";
import {cp, mkdir, readFile, rm, stat, writeFile} from "node:fs/promises";
import path from "node:path";
import {Pool} from "pg";
import {indexProject} from "./indexing.js";
import {createRequirementRevision, removeRequirementRevision} from "./requirement-revisions.js";

const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

async function exists(file: string) {
    try { await stat(file); return true } catch { return false }
}

async function validateManifestFiles(root: string, manifest: any, prefix = "") {
    for (const item of manifest.files || []) {
        const relative = typeof item === "string" ? item : item.path;
        if (!relative || !await exists(path.join(root, prefix, relative))) throw new Error(`备份或快照缺少文件: ${relative || "<unknown>"}`)
    }
}

async function replaceWorkspaceArtifacts(workspace: string, source: string) {
    for (const name of ["data", "reports"]) {
        const target = path.join(workspace, ".matrix", name), from = path.join(source, name);
        await rm(target, {recursive: true, force: true});
        if (await exists(from)) await cp(from, target, {recursive: true})
    }
}

async function overlayRollback(workspace: string, backupPath: string) {
    const manifest = JSON.parse(await readFile(path.join(backupPath, "manifest.json"), "utf8"));
    for (const relative of manifest.files || []) {
        const source = path.join(backupPath, relative), target = path.join(workspace, relative);
        if (!await exists(source)) throw new Error(`回滚备份缺少文件: ${relative}`);
        await mkdir(path.dirname(target), {recursive: true});
        await cp(source, target)
    }
    for (const relative of manifest.absent || []) await rm(path.join(workspace, relative), {recursive: true, force: true})
}

async function updateRevisionFiles(storagePath: string, baselineId: string) {
    const changePath = path.join(storagePath, "change-set.json");
    if (await exists(changePath)) {
        const change = JSON.parse(await readFile(changePath, "utf8"));
        change.fromRevisionId = baselineId;
        change.warnings = [...(change.warnings || []), "历史修复后由服务重新计算权威差异"];
        await writeFile(changePath, JSON.stringify(change, null, 2))
    }
    const manifestPath = path.join(storagePath, "manifest.json"), manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.sequence = 2;
    manifest.versionLabel = "V2";
    manifest.parentRevisionId = baselineId;
    manifest.baselineRevisionId = baselineId;
    for (const file of manifest.files || []) {
        const absolute = path.join(storagePath, file.path);
        if (!await exists(absolute)) throw new Error(`版本快照缺少文件: ${file.path}`);
        const content = await readFile(absolute);
        file.size = content.length;
        file.sha256 = sha256(content)
    }
    const text = JSON.stringify(manifest, null, 2);
    await writeFile(manifestPath, text);
    return sha256(text)
}

async function main() {
    const args = process.argv.slice(2), apply = args.includes("--apply"), projectId = args.find(value => !value.startsWith("--"));
    if (!projectId) throw new Error("用法: npm run repair:requirement-history -- <projectId> [--apply]");
    if (!/^[A-Za-z0-9_-]+$/.test(projectId)) throw new Error("projectId 格式非法");
    const db = new Pool({connectionString: process.env.DATABASE_URL});
    let baselineId = "", safetyRoot = "";
    try {
        const project = (await db.query(`select id,"workspacePath" from "Project" where id=$1`, [projectId])).rows[0];
        if (!project) throw new Error("项目不存在");
        const revisions = (await db.query(`select * from "RequirementRevision" where "projectId"=$1 order by sequence`, [projectId])).rows;
        if (revisions.some(row => String(row.kind).endsWith("BASELINE"))) throw new Error("项目已经存在基线，无需修复");
        if (revisions.length !== 1 || revisions[0].sequence !== 1 || revisions[0].kind !== "PUBLISHED" || revisions[0].status !== "PUBLISHED") {
            throw new Error("版本历史不符合“单个 PUBLISHED V1 且无基线”的可修复条件")
        }
        const revision = revisions[0];
        const run = (await db.query(`select * from "Phase2EditRun" where id=$1 and "projectId"=$2 and status='SUCCEEDED'`, [revision.editRunId, projectId])).rows[0];
        if (!run?.backupPath || !await exists(path.join(run.backupPath, "manifest.json"))) throw new Error("成功编辑任务的 backupPath 不存在或不完整");
        if (!await exists(path.join(revision.storagePath, "manifest.json"))) throw new Error("当前 V1 快照不完整");
        const rollbackManifest = JSON.parse(await readFile(path.join(run.backupPath, "manifest.json"), "utf8"));
        const revisionManifest = JSON.parse(await readFile(path.join(revision.storagePath, "manifest.json"), "utf8"));
        await validateManifestFiles(run.backupPath, rollbackManifest);
        await validateManifestFiles(revision.storagePath, revisionManifest);
        console.log(JSON.stringify({ok: true, mode: apply ? "apply" : "dry-run", projectId, revisionId: revision.id,
            editRunId: run.id, backupPath: run.backupPath, storagePath: revision.storagePath}, null, 2));
        if (!apply) return;

        safetyRoot = path.join(project.workspacePath, ".matrix", "history", "repair", `${Date.now()}-${projectId}`);
        await mkdir(safetyRoot, {recursive: true});
        await cp(path.join(project.workspacePath, ".matrix", "data"), path.join(safetyRoot, "data"), {recursive: true});
        await cp(path.join(project.workspacePath, ".matrix", "reports"), path.join(safetyRoot, "reports"), {recursive: true});
        await cp(revision.storagePath, path.join(safetyRoot, "published-revision"), {recursive: true});
        await writeFile(path.join(safetyRoot, "database.json"), JSON.stringify({revision}, null, 2));

        await db.query(`update "RequirementRevision" set sequence=2,"versionLabel"='V2' where id=$1`, [revision.id]);
        await overlayRollback(project.workspacePath, run.backupPath);
        await indexProject(db, projectId, project.workspacePath, [], {skipDocuments: true});
        const baseline: any = await createRequirementRevision(db, {projectId, workspace: project.workspacePath,
            kind: "MIGRATED_BASELINE", userId: run.userId, repairExistingPublished: true});
        baselineId = baseline.revisionId;
        if (!baselineId) throw new Error("迁移基线创建后未返回 revisionId");

        await replaceWorkspaceArtifacts(project.workspacePath, safetyRoot);
        await indexProject(db, projectId, project.workspacePath, [], {skipDocuments: true});
        const manifestHash = await updateRevisionFiles(revision.storagePath, baselineId);
        await db.query("begin");
        try {
            await db.query(`update "RequirementRevision" set sequence=2,"versionLabel"='V2',"parentRevisionId"=$1,"baselineRevisionId"=$1,"manifestHash"=$2 where id=$3`, [baselineId, manifestHash, revision.id]);
            await db.query(`delete from "RequirementChangeSet" where "projectId"=$1`, [projectId]);
            await db.query("commit")
        } catch (error) { await db.query("rollback"); throw error }
        console.log(JSON.stringify({ok: true, repaired: true, projectId, baselineId, publishedRevisionId: revision.id, safetyRoot}, null, 2))
    } catch (error) {
        if (safetyRoot) {
            try {
                if (baselineId) await removeRequirementRevision(db, baselineId);
                const saved = JSON.parse(await readFile(path.join(safetyRoot, "database.json"), "utf8"));
                await db.query(`update "RequirementRevision" set sequence=1,"versionLabel"='V1',"parentRevisionId"=$1,"baselineRevisionId"=$2,"manifestHash"=$3 where id=$4`,
                    [saved.revision.parentRevisionId, saved.revision.baselineRevisionId, saved.revision.manifestHash, saved.revision.id]);
                await rm(saved.revision.storagePath, {recursive: true, force: true});
                await cp(path.join(safetyRoot, "published-revision"), saved.revision.storagePath, {recursive: true});
                const workspace = saved.revision.storagePath.replace(/[\\/]\.matrix[\\/]history[\\/]revisions[\\/].*$/, "");
                await replaceWorkspaceArtifacts(workspace, safetyRoot).catch(() => undefined);
                await indexProject(db, projectId, workspace, [], {skipDocuments: true}).catch(() => undefined)
            } catch (rollbackError) { console.error("自动回滚失败，请使用安全备份恢复:", safetyRoot, rollbackError) }
        }
        throw error
    } finally { await db.end() }
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 });
