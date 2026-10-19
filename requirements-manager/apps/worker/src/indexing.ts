import JSZip from "jszip";
import {XMLParser} from "fast-xml-parser";
import {createHash} from "node:crypto";
import {readdir, readFile, rm} from "node:fs/promises";
import path from "node:path";
import type {Pool, PoolClient} from "pg";
type Db = Pick<Pool | PoolClient, "query">;

type Json = Record<string, any>;
type TocEntry = {
    segment_id: string;
    level: number;
    title: string;
    section_path_ids?: string[];
    section_path_titles?: string[]
};
type Paragraph = { text: string; paraId?: string; index: number };
type RequirementDraft = {
    id: string;
    businessId: string;
    entityUid?: string;
    nodeType: string;
    number?: string;
    title: string;
    level: number;
    parentId?: string;
    order: number;
    artifact: string;
    content: Json;
    sourceRefs: string[]
};
type PreviousRequirementNode = {id: string; businessId: string; entityUid?: string; reviewCount: number | string};
export type ReviewNodeMigrationPlan = {
    updates: Array<{businessId: string; nextBusinessId: string; previousId: string; nextId: string}>;
    unmatched: PreviousRequirementNode[];
};
export type RequirementIdRename = {from: string; to: string};

const ARTIFACTS = [
    ["chapter1-scope.json", "1", "范围"], ["chapter2-system-overview.json", "2", "系统概述"],
    ["hardware-interface-model.json", "3.1", "硬件接口"], ["functional-test-content.json", "4.1", "功能测试"],
    ["performance-test-content.json", "4.2", "性能测试"], ["interface-test-content.json", "4.3", "接口测试"],
    ["reliability-safety-test-content.json", "4.4", "可靠性安全性测试"], ["margin-test-content.json", "4.5", "余量测试"],
    ["boundary-test-content.json", "4.6", "边界测试"], ["data-processing-test-content.json", "4.7", "数据处理测试"],
    ["recovery-test-content.json", "4.8", "恢复性测试"], ["strength-test-content.json", "4.9", "强度测试"],
    ["phase2-test-traceability.json", "6", "测试需求覆盖性说明"]
] as const;
const NON_FUNCTIONAL_ARTIFACTS = new Set([
    "performance-test-content.json", "interface-test-content.json", "reliability-safety-test-content.json",
    "margin-test-content.json", "boundary-test-content.json", "data-processing-test-content.json",
    "recovery-test-content.json", "strength-test-content.json"
]);

const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    isArray: name => ["w:p", "w:r", "w:t"].includes(name)
});
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const stableId = (prefix: string, value: string) => `${prefix}-${hash(value).slice(0, 24)}`;
export const projectScopedStableId = (prefix: string, projectId: string, value: string) =>
    stableId(prefix, `${projectId}:${value}`);
const asArray = <T>(value: T | T[] | undefined): T[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const canonicalSegmentId = (value: string) => value.replace(/__\d+$/, "");

function chapterToc(items: TocEntry[]): TocEntry[] {
    const result: TocEntry[] = [], seen = new Set<string>();
    for (const item of items) {
        const segmentId = canonicalSegmentId(item.segment_id);
        if (seen.has(segmentId)) continue;
        seen.add(segmentId);
        result.push({...item, segment_id: segmentId, section_path_ids: item.section_path_ids?.map(canonicalSegmentId)})
    }
    return result
}

function textOf(value: any): string {
    if (value == null) return "";
    if (typeof value === "string" || typeof value === "number") return String(value);
    if (Array.isArray(value)) return value.map(textOf).join("");
    if (typeof value === "object") return Object.entries(value).filter(([key]) => key !== "w:tab" && !key.startsWith("@_")).map(([, item]) => textOf(item)).join("");
    return ""
}

async function paragraphsOf(file: string): Promise<Paragraph[]> {
    const zip = await JSZip.loadAsync(await readFile(file)), xml = await zip.file("word/document.xml")?.async("string");
    if (!xml) throw new Error("DOCX缺少word/document.xml");
    const doc = parser.parse(xml), body = doc?.["w:document"]?.["w:body"], paragraphs = asArray(body?.["w:p"]);
    return paragraphs.map((paragraph: any, index) => ({
        text: textOf(paragraph?.["w:r"]).replace(/\s+/g, " ").trim(),
        paraId: paragraph?.["@_w14:paraId"], index
    }))
}

async function docxFiles(root: string): Promise<string[]> {
    const result: string[] = [];
    for (const entry of await readdir(root, {withFileTypes: true})) {
        if (entry.name === "node_modules" || entry.name === ".matrix") continue;
        const value = path.join(root, entry.name);
        if (entry.isDirectory()) result.push(...await docxFiles(value));
        else if (entry.name.toLowerCase().endsWith(".docx")) result.push(value)
    }
    return result
}

async function readJson(file: string): Promise<Json | undefined> {
    try {
        return JSON.parse(await readFile(file, "utf8"))
    } catch {
        return undefined
    }
}

function sourceDescriptors(workspace: string, artifacts?: Json) {
    const values: { file: string; prefix: string; toc?: string }[] = [];
    if (artifacts?.primary_document) values.push({
        file: artifacts.primary_document.path,
        prefix: "primary",
        toc: artifacts.primary_document.toc_path
    });
    for (const item of artifacts?.supporting_documents || []) {
        const folder = path.basename(path.dirname(item.toc_path || ""));
        values.push({file: item.path, prefix: `supporting-${folder}`, toc: item.toc_path})
    }
    return values.map(item => ({
        ...item,
        file: path.join(workspace, path.basename(item.file)),
        toc: item.toc ? path.join(workspace, ".matrix", "data", ...item.toc.replace(/\\/g, "/").split("/.matrix/data/").pop()!.split("/")) : undefined
    }))
}

async function indexDocuments(db: Db, projectId: string, workspace: string) {
    const dataDir = path.join(workspace, ".matrix", "data"),
        artifacts = await readJson(path.join(dataDir, "source-artifacts.json"));
    const descriptors = sourceDescriptors(workspace, artifacts), files = await docxFiles(workspace),
        activeDocumentIds: string[] = [];
    for (const file of files) {
        const descriptor = descriptors.find(item => path.basename(item.file).toLowerCase() === path.basename(file).toLowerCase());
        const prefix = descriptor?.prefix || `document-${hash(path.basename(file)).slice(0, 8)}`,
            documentId = stableId("doc", `${projectId}:${path.basename(file)}`);
        activeDocumentIds.push(documentId);
        try {
            const buffer = await readFile(file), paragraphs = await paragraphsOf(file),
                tocJson = descriptor?.toc ? await readJson(descriptor.toc) : undefined;
            let toc = chapterToc((tocJson?.toc || []) as TocEntry[]);
            if (!toc.length) toc = paragraphs.filter(item => /^(\d+(?:\.\d+)*)\s+\S/.test(item.text)).map(item => {
                const match = item.text.match(/^(\d+(?:\.\d+)*)\s+(.+)$/)!;
                return {segment_id: `SRS-${match[1]}`, level: match[1].split(".").length, title: match[2]}
            });
            await db.query('insert into "Document" (id,"projectId",name,"objectKey","fileHash","parseStatus","parseError","outline") values ($1,$2,$3,$4,$5,$6,null,$7) on conflict (id) do update set "objectKey"=excluded."objectKey","fileHash"=excluded."fileHash","parseStatus"=excluded."parseStatus","parseError"=null,"outline"=excluded."outline"', [documentId, projectId, path.basename(file), file, hash(buffer.toString("binary")), "READY", JSON.stringify(toc)]);
            await db.query('delete from "DocumentNode" where "documentId"=$1', [documentId]);
            const nodeIds = new Map<string, string>();
            let searchFrom = 0;
            for (let order = 0; order < toc.length; order++) {
                const item = toc[order], sourceRef = `${prefix}::${item.segment_id}`,
                    id = stableId("dn", `${documentId}:${sourceRef}`);
                const normalized = item.title.replace(/\s+/g, "").toLowerCase();
                let paragraph = paragraphs.find(value => value.index >= searchFrom && value.text.replace(/\s+/g, "").toLowerCase().includes(normalized));
                if (!paragraph) paragraph = paragraphs.find(value => value.text.replace(/\s+/g, "").toLowerCase().includes(normalized));
                if (paragraph) searchFrom = paragraph.index + 1;
                const pathIds = item.section_path_ids || [],
                    parentRef = pathIds.length > 1 ? `${prefix}::${pathIds[pathIds.length - 2]}` : undefined,
                    number = item.segment_id.replace(/^SRS-/, "").replace(/^00+(?=\d)/, ""),
                    headingPath = item.section_path_titles || [item.title];
                await db.query('insert into "DocumentNode" (id,"documentId","sourceRef","number",title,text,level,"parentId","orderIndex","paragraphIndex","paraId","textHash","headingPath") values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)', [id, documentId, sourceRef, number === "PREAMBLE" ? null : number, item.title, paragraph?.text, item.level, parentRef ? nodeIds.get(parentRef) || null : null, order, paragraph?.index, paragraph?.paraId, hash(paragraph?.text || item.title), JSON.stringify(headingPath)]);
                nodeIds.set(sourceRef, id)
            }
        } catch (error) {
            await db.query('insert into "Document" (id,"projectId",name,"objectKey","parseStatus","parseError") values ($1,$2,$3,$4,$5,$6) on conflict (id) do update set "parseStatus"=excluded."parseStatus","parseError"=excluded."parseError"', [documentId, projectId, path.basename(file), file, "FAILED", error instanceof Error ? error.message : String(error)])
        }
    }
    if (activeDocumentIds.length) await db.query('delete from "Document" where "projectId"=$1 and not (id=any($2::text[]))', [projectId, activeDocumentIds]);
}

function sourceRefsOf(value: Json) {
    return [...new Set([value.source_ref, ...asArray(value.source_refs)].filter(item => typeof item === "string"))] as string[]
}

function findNumber(value: Json) {
    return value.title_no || value.section_title_no || value.chapter_title_no || value.requirement_no
}

function findTitle(value: Json) {
    return value.title || value.section_title || value.chapter_title || value.name
}

function collectRequirements(projectId: string, value: any, artifact: string, drafts: RequirementDraft[], parentId?: string, parentLevel = 0) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) return value.forEach(item => collectRequirements(projectId, item, artifact, drafts, parentId, parentLevel));
    const requirementId = typeof value.requirement_id === "string" ? value.requirement_id : undefined,
        number = findNumber(value), rawTitle = findTitle(value),
        title = requirementId ? String(value.content || rawTitle || requirementId).slice(0, 100) : rawTitle,
        isNode = Boolean(requirementId || (number && title));
    let currentParent = parentId, level = parentLevel;
    if (isNode) {
        const businessId = requirementId || `${artifact}:${number}:${title}`,
            existing = drafts.find(item => item.businessId === businessId);
        if (!existing) {
            level = requirementId ? parentLevel + 1 : typeof number === "string" ? number.split(".").length : parentLevel + 1;
            const id = projectScopedStableId("trn", projectId, businessId);
            drafts.push({
                id,
                businessId,
                nodeType: requirementId ? "requirement" : "section",
                number: requirementId || number,
                title: String(title),
                level,
                parentId,
                order: drafts.length,
                artifact,
                content: value,
                sourceRefs: sourceRefsOf(value)
            });
            currentParent = id
        } else {
            currentParent = existing.id;
            level = existing.level
        }
    }
    for (const [key, child] of Object.entries(value)) {
        if (["source_ref", "source_refs", "content", "summary", "input_flow", "output_flow", "rows", "columns"].includes(key)) continue;
        collectRequirements(projectId, child, artifact, drafts, currentParent, level)
    }
}

function collectHardwareRequirements(projectId: string, data: Json, artifact: string, drafts: RequirementDraft[], rootId: string) {
    for (const [interfaceIndex, item] of asArray(data.interfaces).entries()) {
        if (!item || typeof item !== "object") continue;
        const number = `3.1.${interfaceIndex + 1}`;
        const title = String(item.title || item.interface_name || item.name || `硬件接口${interfaceIndex + 1}`);
        const businessId = `${artifact}:${number}:${title}`;
        const id = projectScopedStableId("trn", projectId, businessId);
        drafts.push({
            id,
            businessId,
            nodeType: "section",
            number,
            title,
            level: 3,
            parentId: rootId,
            order: drafts.length,
            artifact,
            content: item,
            sourceRefs: sourceRefsOf(item)
        });
        for (const [topicIndex, topic] of asArray(item.topics).entries()) {
            if (!topic || typeof topic !== "object") continue;
            const topicNumber = `${number}.${topicIndex + 1}`;
            const topicTitle = String(topic.title || topic.name || `接口数据流${topicIndex + 1}`);
            const topicBusinessId = `${artifact}:${topicNumber}:${topicTitle}`;
            drafts.push({
                id: projectScopedStableId("trn", projectId, topicBusinessId),
                businessId: topicBusinessId,
                nodeType: "section",
                number: topicNumber,
                title: topicTitle,
                level: 4,
                parentId: id,
                order: drafts.length,
                artifact,
                content: topic,
                sourceRefs: sourceRefsOf(topic)
            })
        }
    }
}

function collectNonFunctionalRequirements(projectId: string, data: Json, artifact: string, drafts: RequirementDraft[], rootId: string) {
    const sectionNumber = String(data.section_title_no || ""),
        section = drafts.find(item => item.artifact === artifact && item.number === sectionNumber),
        parentId = section?.id || rootId,
        level = (section?.level || 2) + 1;
    for (const row of asArray<Json>(data.rows)) {
        if (!row || typeof row !== "object") continue;
        const requirementId = String(row.requirement_id || row.test_requirement_id || "").trim();
        if (!requirementId || drafts.some(item => item.businessId === requirementId)) continue;
        const description = Object.entries(row).find(([key, value]) => key.endsWith("_requirement_description") && typeof value === "string")?.[1];
        drafts.push({
            id: projectScopedStableId("trn", projectId, requirementId), businessId: requirementId, nodeType: "requirement",
            number: requirementId, title: String(description || row.related_description || requirementId), level,
            parentId, order: drafts.length, artifact, content: row, sourceRefs: sourceRefsOf(row)
        })
    }
}

function validateRequirementDrafts(projectId: string, drafts: RequirementDraft[]) {
    const ids = new Map<string, RequirementDraft>(), businessIds = new Map<string, RequirementDraft>();
    for (const item of drafts) {
        const duplicateId = ids.get(item.id);
        if (duplicateId) throw new Error(`项目 ${projectId} 的测试需求索引草稿存在重复主键 ${item.id}：${duplicateId.artifact}/${duplicateId.businessId} 与 ${item.artifact}/${item.businessId}`);
        ids.set(item.id, item);
        const duplicateBusinessId = businessIds.get(item.businessId);
        if (duplicateBusinessId) throw new Error(`项目 ${projectId} 的测试需求索引草稿存在重复 businessId ${item.businessId}：${duplicateBusinessId.artifact} 与 ${item.artifact}`);
        businessIds.set(item.businessId, item)
    }
}

export function planReviewNodeMigrations(previousNodes: PreviousRequirementNode[], nextNodes: Array<{id: string; businessId: string}>, renames: RequirementIdRename[] = []): ReviewNodeMigrationPlan {
    const nextIdByBusinessId = new Map(nextNodes.map(item => [item.businessId, item.id]));
    const renamedBusinessIds = new Map(renames.map(item => [item.from, item.to]));
    const updates: ReviewNodeMigrationPlan["updates"] = [], unmatched: PreviousRequirementNode[] = [];
    for (const previous of previousNodes) {
        const nextBusinessId = renamedBusinessIds.get(previous.businessId) || previous.businessId;
        const nextId = nextIdByBusinessId.get(nextBusinessId);
        if (nextId && nextId !== previous.id) updates.push({businessId: previous.businessId, nextBusinessId, previousId: previous.id, nextId});
        else if (!nextId && Number(previous.reviewCount) > 0) unmatched.push(previous)
    }
    return {updates, unmatched}
}

async function indexRequirements(db: Db, projectId: string, workspace: string, renames: RequirementIdRename[] = []) {
    const dataDir = path.join(workspace, ".matrix", "data"), drafts: RequirementDraft[] = [];
    for (const [artifact, number, title] of ARTIFACTS) {
        const data = await readJson(path.join(dataDir, artifact));
        if (!data) continue;
        const rootId = projectScopedStableId("trn", projectId, `${artifact}:${number}:${title}`);
        drafts.push({
            id: rootId,
            businessId: `${artifact}:${number}:${title}`,
            nodeType: "section",
            number,
            title,
            level: number.split(".").length,
            order: drafts.length,
            artifact,
            content: data,
            sourceRefs: sourceRefsOf(data)
        });
        if (artifact === "hardware-interface-model.json") collectHardwareRequirements(projectId, data, artifact, drafts, rootId);
        else {
            collectRequirements(projectId, data, artifact, drafts, rootId, number.split(".").length);
            if (NON_FUNCTIONAL_ARTIFACTS.has(artifact)) collectNonFunctionalRequirements(projectId, data, artifact, drafts, rootId)
        }
    }
    validateRequirementDrafts(projectId, drafts);
    const previousNodes = await db.query(`select n.id,n."businessId",n."entityUid",count(r.id)::int as "reviewCount"
        from "TestRequirementNode" n left join "Review" r on r."projectId"=n."projectId" and r."nodeId"=n.id
        where n."projectId"=$1 group by n.id,n."businessId",n."entityUid"`, [projectId]);
    const migrationPlan = planReviewNodeMigrations(previousNodes.rows, drafts, renames);
    const previousUid = new Map(previousNodes.rows.map(item => [item.businessId, item.entityUid || item.id]));
    for (const rename of renames) {
        const uid = previousUid.get(rename.from);
        if (uid) previousUid.set(rename.to, uid)
    }
    for (const item of drafts) item.entityUid = previousUid.get(item.businessId) || projectScopedStableId("tre", projectId, item.businessId);
    await db.query('delete from "TestRequirementNode" where "projectId"=$1', [projectId]);
    for (const item of drafts) {
        try {
            await db.query('insert into "TestRequirementNode" (id,"projectId","businessId","entityUid","nodeType",number,title,level,"parentId","orderIndex",artifact,content,"sourceRefs") values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)', [item.id, projectId, item.businessId, item.entityUid, item.nodeType, item.number, item.title, item.level, item.parentId || null, item.order, item.artifact, JSON.stringify(item.content), JSON.stringify(item.sourceRefs)])
        } catch (error) {
            throw new Error(`写入项目 ${projectId} 的测试需求节点失败：artifact=${item.artifact}, businessId=${item.businessId}, id=${item.id}`, {cause: error})
        }
    }
    for (const migration of migrationPlan.updates) await db.query('update "Review" set "nodeId"=$1 where "projectId"=$2 and "nodeId"=$3', [migration.nextId, projectId, migration.previousId]);
    for (const previous of migrationPlan.unmatched) console.warn(`项目 ${projectId} 的历史评审未迁移：businessId=${previous.businessId}, nodeId=${previous.id}, reviewCount=${previous.reviewCount}`);
    await db.query('delete from "TraceLink" where "projectId"=$1', [projectId]);
    const sourceRows = await db.query('select d.id,d."sourceRef" from "DocumentNode" d join "Document" doc on doc.id=d."documentId" where doc."projectId"=$1', [projectId]),
        sourceMap = new Map(sourceRows.rows.map(row => [row.sourceRef, row.id])),
        targetMap = new Map(drafts.map(item => [item.businessId, item.id]));
    const links = new Set<string>();
    const add = async (sourceRef: string, businessId: string, source: string) => {
        const sourceId = sourceMap.get(sourceRef), targetId = targetMap.get(businessId),
            key = `${sourceId}:${targetId}`;
        if (!sourceId || !targetId || links.has(key)) return;
        links.add(key);
        await db.query('insert into "TraceLink" (id,"projectId","sourceNodeId","targetNodeId",source) values ($1,$2,$3,$4,$5)', [projectScopedStableId("tl", projectId, key), projectId, sourceId, targetId, source])
    };
    const trace = await readJson(path.join(dataDir, "phase2-test-traceability.json"));
    for (const row of trace?.rows || []) for (const requirementId of row.test_requirement_ids || []) await add(row.source_ref, requirementId, "phase2-test-traceability.json");
    for (const item of drafts) for (const sourceRef of item.sourceRefs) await add(sourceRef, item.businessId, item.artifact)
}

export async function indexProject(db: Pool, projectId: string, workspace: string, renames: RequirementIdRename[] = [], options: {skipDocuments?: boolean} = {}) {
    await rm(path.join(path.dirname(workspace), "preview"), {recursive: true, force: true});
    const client = await db.connect();
    try {
        await client.query("begin");
        const projectLock = await client.query('select id from "Project" where id=$1 for update', [projectId]);
        if (!projectLock.rowCount) throw new Error(`无法索引不存在的项目：${projectId}`);
        if (!options.skipDocuments) await indexDocuments(client, projectId, workspace);
        await indexRequirements(client, projectId, workspace, renames);
        await client.query("commit")
    } catch (error) {
        await client.query("rollback");
        throw error
    } finally { client.release() }
}

/** Refresh only the currently available Phase 2 requirement artifacts.
 * Source documents are indexed independently when the project is uploaded, so
 * chapter publication must not invalidate their preview cache. */
export async function indexAvailableRequirements(db: Pool, projectId: string, workspace: string, renames: RequirementIdRename[] = []) {
    const client = await db.connect();
    try {
        await client.query("begin");
        const projectLock = await client.query('select id from "Project" where id=$1 for update', [projectId]);
        if (!projectLock.rowCount) throw new Error(`无法索引不存在的项目：${projectId}`);
        await indexRequirements(client, projectId, workspace, renames);
        await client.query("commit")
    } catch (error) {
        await client.query("rollback");
        throw error
    } finally { client.release() }
}
