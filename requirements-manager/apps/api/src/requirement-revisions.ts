import {BadRequestException, ConflictException, Controller, Get, Injectable, NotFoundException, Param, Query, Req, Res} from "@nestjs/common";
import {Prisma} from "@prisma/client";
import {createHash, randomUUID} from "node:crypto";
import {cp, mkdir, readdir, readFile, rename, rm, stat, writeFile} from "node:fs/promises";
import path from "node:path";
import type {FastifyReply} from "fastify";
import {PrismaService} from "./prisma.js";
import {buildPhase2DocumentFromDataDir} from "./phase2-document.js";

const DATA_FILES = ["chapter1-scope.json", "chapter2-system-overview.json", "hardware-interface-model.json", "functional-test-content.json",
    "functional-other-content.json", "performance-test-content.json", "interface-test-content.json", "reliability-safety-test-content.json",
    "margin-test-content.json", "boundary-test-content.json", "data-processing-test-content.json", "recovery-test-content.json",
    "strength-test-content.json", "phase2-test-traceability.json", "test-requirements.json"];
const ALGORITHM = "1.3";
const DOCUMENT_SECTION_ARTIFACTS = new Set(["chapter1-scope.json", "chapter2-system-overview.json"]);
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

function displayText(value: unknown): string {
    if (typeof value === "string" || typeof value === "number") return String(value);
    if (Array.isArray(value)) return value.map(displayText).filter(Boolean).join("\n");
    if (!value || typeof value !== "object") return "";
    const item = value as Record<string, unknown>, preferred = ["content", "description", "processingContext", "requirementContext", "related_description", "title"];
    const selected = preferred.map(key => displayText(item[key])).filter(Boolean);
    return selected.length ? selected.join("\n") : Object.values(item).map(displayText).filter(Boolean).join("\n")
}

function tokens(value: string) {
    return value.match(/[A-Za-z0-9_.:/-]+|[\u3400-\u9fff]|\s+|[^\s]/gu) || []
}

type IndexedValue = {index: number; value: unknown};
type TableChange = {path: string; addedColumns: IndexedValue[]; deletedColumns: IndexedValue[]; addedRows: IndexedValue[]; deletedRows: IndexedValue[]};

function unmatchedByValue(before: unknown[], after: unknown[]) {
    const available = new Map<string, number[]>();
    before.forEach((value, index) => {
        const key = JSON.stringify(value), indexes = available.get(key) || [];
        indexes.push(index); available.set(key, indexes)
    });
    const matchedBefore = new Set<number>(), matchedAfter = new Set<number>();
    after.forEach((value, index) => {
        const match = available.get(JSON.stringify(value))?.find(candidate => !matchedBefore.has(candidate));
        if (match !== undefined) { matchedBefore.add(match); matchedAfter.add(index) }
    });
    return {
        deleted: before.map((value, index) => ({index, value})).filter(item => !matchedBefore.has(item.index)),
        added: after.map((value, index) => ({index, value})).filter(item => !matchedAfter.has(item.index))
    }
}

function rowIdentity(row: unknown, _index: number, rows: unknown[]) {
    if (!Array.isArray(row)) return JSON.stringify(row);
    const first = JSON.stringify(row[0]);
    return first && first !== '""' && rows.filter(candidate => Array.isArray(candidate) && JSON.stringify(candidate[0]) === first).length === 1 ? `first:${first}` : `row:${JSON.stringify(row)}`
}

function collectTableChanges(before: unknown, after: unknown, path = "content"): TableChange[] {
    if (!before || !after || typeof before !== "object" || typeof after !== "object") return [];
    if (Array.isArray(before) && Array.isArray(after)) return before.flatMap((value, index) => collectTableChanges(value, after[index], `${path}.${index}`));
    if (Array.isArray(before) || Array.isArray(after)) return [];
    const left = before as Record<string, unknown>, right = after as Record<string, unknown>, result: TableChange[] = [];
    if (Array.isArray(left.columns) && Array.isArray(right.columns) && Array.isArray(left.rows) && Array.isArray(right.rows)) {
        const leftRows = left.rows as unknown[], rightRows = right.rows as unknown[];
        const columns = unmatchedByValue(left.columns, right.columns);
        const leftRowKeys = leftRows.map((row, index) => rowIdentity(row, index, leftRows));
        const rightRowKeys = rightRows.map((row, index) => rowIdentity(row, index, rightRows));
        const rows = unmatchedByValue(leftRowKeys, rightRowKeys);
        const change = {path, addedColumns: columns.added, deletedColumns: columns.deleted,
            addedRows: rows.added.map(item => ({index: item.index, value: rightRows[item.index]})),
            deletedRows: rows.deleted.map(item => ({index: item.index, value: leftRows[item.index]}))};
        if (change.addedColumns.length || change.deletedColumns.length || change.addedRows.length || change.deletedRows.length) result.push(change)
    }
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) if (key !== "columns" && key !== "rows")
        result.push(...collectTableChanges(left[key], right[key], `${path}.${key}`));
    return result
}

export function textSegments(before: string, after: string) {
    const left = tokens(before), right = tokens(after);
    if (left.length * right.length > 1_000_000) return [{type: "DELETE", text: before}, {type: "INSERT", text: after}];
    const rows = Array.from({length: left.length + 1}, () => new Uint32Array(right.length + 1));
    for (let i = left.length - 1; i >= 0; i--) for (let j = right.length - 1; j >= 0; j--)
        rows[i][j] = left[i] === right[j] ? rows[i + 1][j + 1] + 1 : Math.max(rows[i + 1][j], rows[i][j + 1]);
    const result: {type: "EQUAL" | "DELETE" | "INSERT"; text: string}[] = [];
    const push = (type: "EQUAL" | "DELETE" | "INSERT", text: string) => {
        const last = result.at(-1); if (last?.type === type) last.text += text; else result.push({type, text})
    };
    let i = 0, j = 0;
    while (i < left.length || j < right.length) {
        if (i < left.length && j < right.length && left[i] === right[j]) { push("EQUAL", left[i++]); j++ }
        else if (j < right.length && (i === left.length || rows[i][j + 1] >= rows[i + 1][j])) push("INSERT", right[j++]);
        else push("DELETE", left[i++])
    }
    return result
}

function enrichChange(change: any) {
    const beforeText = displayText(change.before?.content), afterText = displayText(change.after?.content);
    const location = (node: any) => node ? {artifact: node.artifact, number: node.number, title: node.title, parentId: node.parentId} : undefined;
    const leafChanges: {path: string; before: unknown; after: unknown}[] = [];
    const walk = (before: any, after: any, current: string) => {
        if (JSON.stringify(before) === JSON.stringify(after)) return;
        if (before && after && typeof before === "object" && typeof after === "object" && !Array.isArray(before) && !Array.isArray(after)) {
            for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) walk(before[key], after[key], current ? `${current}.${key}` : key)
        } else leafChanges.push({path: current || "content", before, after})
    };
    walk(change.before?.content, change.after?.content, "content");
    const tableChanges = collectTableChanges(change.before?.content, change.after?.content);
    return {...change,
        chapterNumber: String(change.after?.number || change.before?.number || "").split(".").slice(0, 2).join("."),
        parentAnchor: change.after?.parentId || change.before?.parentId,
        beforeAnchorKey: change.before ? `entity-${change.entityUid}` : undefined,
        afterAnchorKey: change.after ? `entity-${change.entityUid}` : undefined,
        beforeLocation: location(change.before), afterLocation: location(change.after),
        changedFields: [...new Set([...(change.fields || []).filter((field: any) => field.field !== "content").map((field: any) => field.field), ...leafChanges.map(item => item.path)])],
        textSegments: textSegments(beforeText, afterText), beforeSnapshot: change.before, afterSnapshot: change.after,
        beforeText, afterText, leafChanges, tableChanges}
}

export function calculateRequirementDiff(before: any[], after: any[]) {
    const comparable = (node: any) => node.nodeType === "requirement" ||
        node.nodeType === "section" && node.parentId == null && DOCUMENT_SECTION_ARTIFACTS.has(node.artifact);
    const left = new Map(before.filter(comparable).map(x => [x.entityUid || x.id, x]));
    const right = new Map(after.filter(comparable).map(x => [x.entityUid || x.id, x]));
    const changes: any[] = [];
    for (const [entityUid, oldNode] of left) {
        const next = right.get(entityUid);
        if (!next) { changes.push({entityUid, type: "DELETED", before: oldNode}); continue }
        const fields = ["businessId", "number", "title", "parentId", "artifact", "content", "sourceRefs"]
            .filter(field => JSON.stringify(oldNode[field]) !== JSON.stringify(next[field]))
            .map(field => ({field, before: oldNode[field], after: next[field]}));
        if (!fields.length) continue;
        const names = new Set(fields.map(x => x.field));
        const type = names.has("businessId") ? "RENUMBERED" : names.has("parentId") ? "MOVED" :
            names.has("sourceRefs") && names.size === 1 ? "TRACE_CHANGED" :
                fields.some(x => x.field === "content" && /columns|rows|cells/.test(JSON.stringify([x.before, x.after]))) ? "TABLE_CHANGED" : "MODIFIED";
        changes.push({entityUid, type, before: oldNode, after: next, fields})
    }
    for (const [entityUid, next] of right) if (!left.has(entityUid)) changes.push({entityUid, type: "ADDED", after: next});
    const summary: Record<string, number> = {ADDED: 0, DELETED: 0, MODIFIED: 0, MOVED: 0, RENUMBERED: 0, TRACE_CHANGED: 0, TABLE_CHANGED: 0};
    changes.forEach(item => summary[item.type]++);
    return {algorithmVersion: ALGORITHM, summary, changes: changes.map(enrichChange), warnings: []}
}

@Injectable()
export class RequirementRevisionsService {
    constructor(private db: PrismaService) {}

    private async nodes(revision: {storagePath: string}) {
        return JSON.parse(await readFile(path.join(revision.storagePath, "index", "requirement-nodes.json"), "utf8"))
    }

    private async ensureBaseline(projectId: string, userId?: string) {
        let baseline = await this.db.requirementRevision.findFirst({where: {projectId, kind: {in: ["GENERATED_BASELINE", "MIGRATED_BASELINE"]}}, orderBy: {sequence: "asc"}});
        if (baseline) return baseline;
        const existing = await this.db.requirementRevision.findFirst({where: {projectId}, orderBy: {sequence: "asc"}});
        if (existing) throw new ConflictException("项目已有发布版本但缺少需求基线，请先运行需求版本历史修复工具");
        const project = await this.db.project.findUnique({where: {id: projectId}});
        if (!project) throw new NotFoundException("项目不存在");
        if (project.status !== "READY_FOR_REVIEW") throw new BadRequestException("项目尚无可建立迁移基线的正式Phase 2版本");
        const id = randomUUID(), revisionsRoot = path.resolve(project.workspacePath, ".matrix", "history", "revisions"), temp = path.join(revisionsRoot, `.tmp-${id}`), finalRoot = path.join(revisionsRoot, id);
        try {
            await mkdir(temp, {recursive: true});
            const files: string[] = [];
            for (const file of DATA_FILES) try {
                const source = path.join(project.workspacePath, ".matrix", "data", file); await stat(source);
                await mkdir(path.join(temp, "data"), {recursive: true}); await cp(source, path.join(temp, "data", file)); files.push(`data/${file}`)
            } catch (error: any) { if (error?.code !== "ENOENT") throw error }
            const reports = path.join(project.workspacePath, ".matrix", "reports");
            for (const entry of await readdir(reports, {withFileTypes: true})) if (entry.isFile() && entry.name.toLowerCase().endsWith(".docx")) {
                await mkdir(path.join(temp, "reports"), {recursive: true}); await cp(path.join(reports, entry.name), path.join(temp, "reports", entry.name)); files.push(`reports/${entry.name}`)
            }
            if (!files.includes("reports/phase2-test-requirements.docx")) throw new BadRequestException("当前项目缺少正式第三方测试需求DOCX");
            const requirements = await this.db.testRequirementNode.findMany({where: {projectId}, orderBy: {orderIndex: "asc"}});
            const links = await this.db.traceLink.findMany({where: {projectId}, include: {sourceNode: {include: {document: true}}, targetNode: true}});
            const document = await buildPhase2DocumentFromDataDir(path.join(temp, "data"), requirements);
            await mkdir(path.join(temp, "index"), {recursive: true});
            await writeFile(path.join(temp, "index", "requirement-nodes.json"), JSON.stringify(requirements, null, 2));
            await writeFile(path.join(temp, "index", "trace-links.json"), JSON.stringify(links, null, 2));
            await writeFile(path.join(temp, "index", "phase2-document.json"), JSON.stringify(document, null, 2));
            files.push("index/requirement-nodes.json", "index/trace-links.json", "index/phase2-document.json");
            const manifest = {schemaVersion: 1, rendererSchemaVersion: 1, revisionId: id, sequence: 1, versionLabel: "V1", kind: "MIGRATED_BASELINE",
                projectId, createdAt: new Date().toISOString(), files: await Promise.all(files.map(async relative => { const value = await readFile(path.join(temp, relative)); return {path: relative, size: value.length, sha256: hash(value)} }))};
            const manifestText = JSON.stringify(manifest, null, 2); await writeFile(path.join(temp, "manifest.json"), manifestText); await mkdir(revisionsRoot, {recursive: true}); await rename(temp, finalRoot);
            baseline = await this.db.requirementRevision.create({data: {id, projectId, sequence: 1, versionLabel: "V1", kind: "MIGRATED_BASELINE", status: "PUBLISHED",
                baselineRevisionId: id, storagePath: finalRoot, manifestHash: hash(manifestText), createdById: userId, publishedAt: new Date(), changeSummary: {ADDED: 0, DELETED: 0, MODIFIED: 0, MOVED: 0, RENUMBERED: 0, TRACE_CHANGED: 0, TABLE_CHANGED: 0}}});
            await this.db.review.updateMany({where: {projectId, revisionId: null}, data: {revisionId: id}}).catch(() => undefined);
            await this.db.auditLog.create({data: {userId, action: "REQUIREMENT_MIGRATED_BASELINE_CREATED", resourceType: "RequirementRevision", resourceId: id, detail: {projectId}}}).catch(() => undefined);
            return baseline
        } catch (error) {
            await rm(temp, {recursive: true, force: true}).catch(() => undefined);
            await rm(finalRoot, {recursive: true, force: true}).catch(() => undefined);
            const concurrent = await this.db.requirementRevision.findFirst({where: {projectId, kind: {in: ["GENERATED_BASELINE", "MIGRATED_BASELINE"]}}});
            if (concurrent) return concurrent;
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
                throw new ConflictException("需求基线创建冲突，请刷新后重试；若问题持续存在，请运行需求版本历史修复工具")
            }
            throw error
        }
    }

    async list(projectId: string, userId?: string) {
        await this.ensureBaseline(projectId, userId);
        return this.db.requirementRevision.findMany({where: {projectId, status: "PUBLISHED"}, orderBy: {sequence: "asc"}, select: {id: true, sequence: true, versionLabel: true, versionName: true, kind: true, parentRevisionId: true, baselineRevisionId: true, editRunId: true, changeSummary: true, createdAt: true, publishedAt: true}})
    }

    async get(projectId: string, revisionId: string) {
        const revision = await this.db.requirementRevision.findFirst({where: {id: revisionId, projectId}});
        if (!revision) throw new NotFoundException("需求版本不存在");
        return revision
    }

    async document(projectId: string, revisionId: string) {
        const revision = await this.get(projectId, revisionId), saved = path.join(revision.storagePath, "index", "phase2-document.json");
        const value = JSON.parse(await readFile(saved, "utf8"));
        const document = Array.isArray(value.chapters) ? value : await buildPhase2DocumentFromDataDir(path.join(revision.storagePath, "data"), value.requirements || await this.nodes(revision));
        const rawLinks = JSON.parse(await readFile(path.join(revision.storagePath, "index", "trace-links.json"), "utf8"));
        const links = rawLinks.map((link: any) => link.sourceNode ? link : {...link, sourceNode: {
            id: link.sourceNodeId, sourceRef: link.sourceRef, number: link.sourceNumber, title: link.sourceTitle,
            document: {name: link.documentName}
        }});
        return {...document, links}
    }

    async diff(projectId: string, fromId: string | undefined, toId: string | undefined, userId?: string) {
        const revisions = await this.list(projectId, userId), from = fromId ? revisions.find(x => x.id === fromId) : revisions[0], to = toId ? revisions.find(x => x.id === toId) : revisions.at(-1);
        if (!from || !to) throw new NotFoundException("缺少可比较的需求版本");
        const cached = await this.db.requirementChangeSet.findUnique({where: {fromRevisionId_toRevisionId_algorithmVersion: {fromRevisionId: from.id, toRevisionId: to.id, algorithmVersion: ALGORITHM}}});
        const result = cached ? {algorithmVersion: cached.algorithmVersion, summary: cached.summary, changes: cached.changes, warnings: cached.warnings || []} : calculateRequirementDiff(await this.nodes(await this.get(projectId, from.id)), await this.nodes(await this.get(projectId, to.id)));
        if (!cached) await this.db.requirementChangeSet.create({data: {id: randomUUID(), projectId, fromRevisionId: from.id, toRevisionId: to.id, algorithmVersion: ALGORITHM,
            summary: JSON.parse(JSON.stringify(result.summary)), changes: JSON.parse(JSON.stringify(result.changes)), warnings: JSON.parse(JSON.stringify(result.warnings))}});
        await this.db.auditLog.create({data: {userId, action: "REQUIREMENT_DIFF_VIEWED", resourceType: "Project", resourceId: projectId, detail: {fromRevisionId: from.id, toRevisionId: to.id}}});
        return {from, to, ...result}
    }

    async history(projectId: string, entityUid: string, userId?: string) {
        const revisions = await this.list(projectId, userId), result = [];
        for (const revision of revisions) {
            const node = (await this.nodes(await this.get(projectId, revision.id))).find((item: any) => (item.entityUid || item.id) === entityUid);
            result.push({revision, node: node || null})
        }
        return result
    }

    async download(projectId: string, revisionId: string, userId: string | undefined, reply: FastifyReply) {
        const revision = await this.get(projectId, revisionId), file = path.join(revision.storagePath, "reports", "phase2-test-requirements.docx");
        await stat(file).catch(() => { throw new NotFoundException("该版本第三方测试需求DOCX不存在") });
        await this.db.auditLog.create({data: {userId, action: "REQUIREMENT_REVISION_DOWNLOADED", resourceType: "RequirementRevision", resourceId: revision.id}});
        reply.header("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
        const safeName = String(revision.versionName || "").trim().replace(/[<>:"/\\|?*\u0000-\u001f]+/gu, "-");
        reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(`第三方测试需求-${revision.versionLabel}${safeName ? `-${safeName}` : ""}.docx`)}`);
        return reply.send(await readFile(file))
    }
}

@Controller("projects/:projectId")
export class RequirementRevisionsController {
    constructor(private revisions: RequirementRevisionsService) {}
    @Get("requirement-revisions") list(@Param("projectId") projectId: string, @Req() req: any) { return this.revisions.list(projectId, req.user?.id) }
    @Get("requirement-revisions/:revisionId") get(@Param("projectId") projectId: string, @Param("revisionId") revisionId: string) { return this.revisions.get(projectId, revisionId) }
    @Get("requirement-revisions/:revisionId/document") document(@Param("projectId") projectId: string, @Param("revisionId") revisionId: string) { return this.revisions.document(projectId, revisionId) }
    @Get("requirement-revisions/:revisionId/docx") docx(@Param("projectId") projectId: string, @Param("revisionId") revisionId: string, @Req() req: any, @Res() reply: FastifyReply) { return this.revisions.download(projectId, revisionId, req.user?.id, reply) }
    @Get("requirement-diff") diff(@Param("projectId") projectId: string, @Query("from") from: string | undefined, @Query("to") to: string | undefined, @Req() req: any) { return this.revisions.diff(projectId, from, to, req.user?.id) }
    @Get("requirements/:entityUid/history") history(@Param("projectId") projectId: string, @Param("entityUid") uid: string, @Req() req: any) { return this.revisions.history(projectId, uid, req.user?.id) }
}
