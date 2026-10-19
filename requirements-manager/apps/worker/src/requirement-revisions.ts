import {createHash, randomUUID} from "node:crypto";
import {cp, mkdir, readdir, readFile, rename, rm, stat, writeFile} from "node:fs/promises";
import path from "node:path";
import type {Pool, PoolClient} from "pg";

const DATA_FILES = [
    "chapter1-scope.json", "chapter2-system-overview.json", "hardware-interface-model.json",
    "functional-test-content.json", "functional-other-content.json", "performance-test-content.json",
    "interface-test-content.json", "reliability-safety-test-content.json", "margin-test-content.json",
    "boundary-test-content.json", "data-processing-test-content.json", "recovery-test-content.json",
    "strength-test-content.json", "phase2-test-traceability.json", "test-requirements.json"
];

const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const json = (value: unknown) => JSON.stringify(value, null, 2);

async function copyArtifacts(workspace: string, root: string) {
    const copied: string[] = [];
    for (const file of DATA_FILES) {
        const source = path.join(workspace, ".matrix", "data", file);
        try {
            await stat(source);
            const target = path.join(root, "data", file);
            await mkdir(path.dirname(target), {recursive: true});
            await cp(source, target);
            copied.push(`data/${file}`)
        } catch (error: any) { if (error?.code !== "ENOENT") throw error }
    }
    const reports = path.join(workspace, ".matrix", "reports");
    try {
        for (const entry of await readdir(reports, {withFileTypes: true})) {
            if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".docx")) continue;
            await mkdir(path.join(root, "reports"), {recursive: true});
            await cp(path.join(reports, entry.name), path.join(root, "reports", entry.name));
            copied.push(`reports/${entry.name}`)
        }
    } catch (error: any) { if (error?.code !== "ENOENT") throw error }
    return copied
}

async function snapshotIndex(client: PoolClient, projectId: string, root: string) {
    const requirements = (await client.query(`select id,"businessId","entityUid","nodeType",number,title,level,"parentId","orderIndex",artifact,content,"sourceRefs"
        from "TestRequirementNode" where "projectId"=$1 order by "orderIndex"`, [projectId])).rows;
    const links = (await client.query(`select l.id,l."sourceNodeId",l."targetNodeId",l."relationType",l.source,l.confidence,
        n."sourceRef",n.number as "sourceNumber",n.title as "sourceTitle",d.name as "documentName"
        from "TraceLink" l join "DocumentNode" n on n.id=l."sourceNodeId" join "Document" d on d.id=n."documentId"
        where l."projectId"=$1`, [projectId])).rows;
    await mkdir(path.join(root, "index"), {recursive: true});
    await writeFile(path.join(root, "index", "requirement-nodes.json"), json(requirements));
    await writeFile(path.join(root, "index", "trace-links.json"), json(links));
    // Stable renderer input. Historical APIs rebuild presentation blocks from this index plus the copied data files.
    await writeFile(path.join(root, "index", "phase2-document.json"), json({schemaVersion: 1, requirements, links}));
    return {requirements, links}
}

function nodeChanges(before: any[], after: any[]) {
    const documentSectionArtifacts = new Set(["chapter1-scope.json", "chapter2-system-overview.json"]);
    const comparable = (node: any) => node.nodeType === "requirement" ||
        node.nodeType === "section" && node.parentId == null && documentSectionArtifacts.has(node.artifact);
    const left = new Map(before.filter(comparable).map(x => [x.entityUid, x]));
    const right = new Map(after.filter(comparable).map(x => [x.entityUid, x]));
    const changes: any[] = [];
    for (const [uid, oldNode] of left) {
        const next = right.get(uid);
        if (!next) { changes.push({entityUid: uid, type: "DELETED", before: oldNode}); continue }
        const fields = ["businessId", "number", "title", "parentId", "artifact", "content", "sourceRefs"]
            .filter(field => JSON.stringify(oldNode[field]) !== JSON.stringify(next[field]))
            .map(field => ({field, before: oldNode[field], after: next[field]}));
        if (fields.length) changes.push({entityUid: uid, type: fields.some(x => x.field === "businessId") ? "RENUMBERED" :
            fields.some(x => x.field === "parentId") ? "MOVED" : fields.some(x => x.field === "sourceRefs") && fields.length === 1 ? "TRACE_CHANGED" : "MODIFIED",
            before: oldNode, after: next, fields})
    }
    for (const [uid, next] of right) if (!left.has(uid)) changes.push({entityUid: uid, type: "ADDED", after: next});
    const summary: Record<string, number> = {ADDED: 0, DELETED: 0, MODIFIED: 0, MOVED: 0, RENUMBERED: 0, TRACE_CHANGED: 0, TABLE_CHANGED: 0};
    changes.forEach(change => summary[change.type] = (summary[change.type] || 0) + 1);
    return {summary, changes}
}

export async function createRequirementRevision(db: Pool, input: {
    projectId: string; workspace: string; kind: "GENERATED_BASELINE" | "MIGRATED_BASELINE" | "PUBLISHED";
    userId?: string; editRunId?: string; versionName?: string; sourceRevision?: string; resultRevision?: string;
    repairExistingPublished?: boolean;
}) {
    const client = await db.connect();
    let temp = "";
    try {
        await client.query("begin");
        await client.query(`select id from "Project" where id=$1 for update`, [input.projectId]);
        if (input.editRunId) {
            const duplicate = await client.query(`select * from "RequirementRevision" where "editRunId"=$1`, [input.editRunId]);
            if (duplicate.rowCount) { await client.query("rollback"); return duplicate.rows[0] }
        }
        if (input.kind.endsWith("BASELINE")) {
            const baselineResult = await client.query(`select * from "RequirementRevision" where "projectId"=$1 and kind in ('GENERATED_BASELINE','MIGRATED_BASELINE') order by sequence limit 1`, [input.projectId]);
            if (baselineResult.rowCount) { await client.query("rollback"); return baselineResult.rows[0] }
        }
        const previousResult = await client.query(`select * from "RequirementRevision" where "projectId"=$1 and status='PUBLISHED' order by sequence desc limit 1`, [input.projectId]);
        let previous = previousResult.rows[0];
        if (input.kind.endsWith("BASELINE") && previous) {
            if (!input.repairExistingPublished) throw new Error("项目已有发布版本但缺少需求基线，请先运行需求版本历史修复工具");
            previous = undefined
        }
        const sequence = Number(previous?.sequence || 0) + 1, id = randomUUID();
        const revisionsRoot = path.resolve(input.workspace, ".matrix", "history", "revisions");
        temp = path.join(revisionsRoot, `.tmp-${id}`);
        const finalRoot = path.join(revisionsRoot, id);
        await mkdir(temp, {recursive: true});
        const files = await copyArtifacts(input.workspace, temp);
        if (!files.includes("reports/phase2-test-requirements.docx")) throw new Error("版本快照缺少phase2-test-requirements.docx");
        const {requirements} = await snapshotIndex(client, input.projectId, temp);
        files.push("index/requirement-nodes.json", "index/trace-links.json", "index/phase2-document.json");
        let diff: {summary: Record<string, number>; changes: any[]} = {summary: {ADDED: 0, DELETED: 0, MODIFIED: 0, MOVED: 0, RENUMBERED: 0, TRACE_CHANGED: 0, TABLE_CHANGED: 0}, changes: []};
        if (previous) {
            const oldNodes = JSON.parse(await readFile(path.join(previous.storagePath, "index", "requirement-nodes.json"), "utf8"));
            diff = nodeChanges(oldNodes, requirements)
        }
        await writeFile(path.join(temp, "change-set.json"), json({algorithmVersion: "1.0", fromRevisionId: previous?.id || null, toRevisionId: id, ...diff}));
        files.push("change-set.json");
        const fileRecords = [];
        for (const relative of files) {
            const content = await readFile(path.join(temp, relative));
            fileRecords.push({path: relative.replace(/\\/g, "/"), size: content.length, sha256: sha256(content)})
        }
        const baseline = previous?.baselineRevisionId || (previous?.kind?.endsWith("BASELINE") ? previous.id : null) || (input.kind.endsWith("BASELINE") ? id : null);
        const manifest = {schemaVersion: 1, rendererSchemaVersion: 1, revisionId: id, sequence, versionLabel: `V${sequence}`, versionName: input.versionName || null,
            kind: input.kind, parentRevisionId: previous?.id || null, baselineRevisionId: baseline,
            projectId: input.projectId, editRunId: input.editRunId || null, createdAt: new Date().toISOString(), files: fileRecords, summary: diff.summary};
        const manifestText = json(manifest);
        await writeFile(path.join(temp, "manifest.json"), manifestText);
        await mkdir(revisionsRoot, {recursive: true});
        await rename(temp, finalRoot);
        await client.query(`insert into "RequirementRevision" (id,"projectId",sequence,"versionLabel","versionName",kind,status,"parentRevisionId","baselineRevisionId","editRunId","storagePath","manifestHash","sourceRevision","resultRevision","changeSummary","createdById","publishedAt")
            values ($1,$2,$3,$4,$5,$6,'PUBLISHED',$7,$8,$9,$10,$11,$12,$13,$14,$15,now())`,
            [id, input.projectId, sequence, `V${sequence}`, input.versionName || null, input.kind, previous?.id || null, baseline, input.editRunId || null,
                finalRoot, sha256(manifestText), input.sourceRevision || null, input.resultRevision || null, JSON.stringify(diff.summary), input.userId || null]);
        if (previous) {
            await client.query(`insert into "RequirementChangeSet" (id,"projectId","fromRevisionId","toRevisionId","algorithmVersion",summary,changes,warnings)
                values ($1,$2,$3,$4,'1.0',$5,$6,'[]') on conflict do nothing`,
                [randomUUID(), input.projectId, previous.id, id, JSON.stringify(diff.summary), JSON.stringify(diff.changes)]);
            const invalidated = diff.changes.filter(change => change.type === "DELETED" || (change.fields || []).some((field: any) =>
                ["title", "artifact", "content", "sourceRefs"].includes(field.field))).map(change => change.entityUid);
            if (invalidated.length) await client.query(`update "Review" set "invalidatedAt"=now(),"invalidatedByRevisionId"=$1
                where "projectId"=$2 and "entityUid"=any($3::text[]) and "invalidatedAt" is null`, [id, input.projectId, invalidated])
        }
        await client.query("commit");
        return {...manifest, storagePath: finalRoot}
    } catch (error) {
        await client.query("rollback").catch(() => undefined);
        if (temp) await rm(temp, {recursive: true, force: true}).catch(() => undefined);
        throw error
    } finally { client.release() }
}

export async function ensureRequirementBaselineForEdit(db: Pool, input: {
    projectId: string; workspace: string; userId?: string;
}) {
    return createRequirementRevision(db, {...input, kind: "MIGRATED_BASELINE"})
}

export async function assertRequirementBaselineForRebuild(db: Pool, projectId: string) {
    const result = await db.query(`select id from "RequirementRevision" where "projectId"=$1 and kind in ('GENERATED_BASELINE','MIGRATED_BASELINE') limit 1`, [projectId]);
    if (!result.rowCount) throw new Error("编辑任务缺少需求基线，请先运行需求版本历史修复工具");
}

export async function removeRequirementRevision(db: Pool, revisionId: string) {
    const client = await db.connect();
    let storagePath: string | undefined;
    try {
        await client.query("begin");
        const result = await client.query(`select "storagePath" from "RequirementRevision" where id=$1 for update`, [revisionId]);
        storagePath = result.rows[0]?.storagePath;
        if (!storagePath) { await client.query("rollback"); return }
        await client.query(`update "Review" set "invalidatedAt"=null,"invalidatedByRevisionId"=null where "invalidatedByRevisionId"=$1`, [revisionId]);
        await client.query(`delete from "RequirementRevision" where id=$1`, [revisionId]);
        await client.query("commit");
        await rm(storagePath, {recursive: true, force: true})
    } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error
    } finally { client.release() }
}
