import {Controller, Get, Injectable, NotFoundException, Param, Query} from "@nestjs/common";
import {PrismaService} from "./prisma.js";
import {buildPhase2Document} from "./phase2-document.js";

@Injectable()
export class TraceabilityService {
    constructor(private db: PrismaService) {
    }

    async reviewData(projectId: string) {
        const project = await this.db.project.findUnique({where: {id: projectId}, include: {
            runs: {orderBy: {startedAt: "desc"}, take: 1}
        }});
        if (!project) throw new NotFoundException("项目不存在");
        const [documents, requirements, links] = await Promise.all([
            this.db.document.findMany({
                where: {projectId},
                orderBy: {name: "asc"},
                include: {nodes: {orderBy: {orderIndex: "asc"}}}
            }),
            this.db.testRequirementNode.findMany({where: {projectId}, orderBy: {orderIndex: "asc"}}),
            this.db.traceLink.findMany({
                where: {projectId},
                include: {sourceNode: {include: {document: true}}, targetNode: true}
            })
        ]);
        const phase2Document = await buildPhase2Document(project.workspacePath, requirements);
        const run = project.runs[0];
        const generation = run ? {
            runId: run.id, status: run.status, currentStage: run.currentStage,
            completedStages: run.completedStages, progress: run.progress
        } : null;
        return {project: {id: project.id, name: project.name, status: project.status}, documents, requirements, links,
            phase2Document, generation}
    }

    async links(projectId: string, sourceNodeId: string, includeDescendants: boolean) {
        const source = await this.db.documentNode.findFirst({where: {id: sourceNodeId, document: {projectId}}});
        if (!source) throw new NotFoundException("源章节不存在");
        const nodes = await this.db.documentNode.findMany({
            where: {
                document: {projectId},
                documentId: source.documentId
            }, select: {id: true, parentId: true}
        }), ids = new Set([source.id]);
        if (includeDescendants) {
            let changed = true;
            while (changed) {
                changed = false;
                for (const node of nodes) if (node.parentId && ids.has(node.parentId) && !ids.has(node.id)) {
                    ids.add(node.id);
                    changed = true
                }
            }
        }
        const links = await this.db.traceLink.findMany({
            where: {projectId, sourceNodeId: {in: [...ids]}},
            include: {sourceNode: true, targetNode: true}, orderBy: {targetNode: {orderIndex: "asc"}}
        });
        return links.map(link => ({...link, direct: link.sourceNodeId === source.id}))
    }
}

@Controller("projects/:projectId")
export class TraceabilityController {
    constructor(private traceability: TraceabilityService) {
    }

    @Get("review-data") reviewData(@Param("projectId") projectId: string) {
        return this.traceability.reviewData(projectId)
    }

    @Get("trace-links") links(@Param("projectId") projectId: string, @Query("sourceNodeId") sourceNodeId: string,
                              @Query("includeDescendants") includeDescendants?: string) {
        return this.traceability.links(projectId, sourceNodeId, includeDescendants !== "false")
    }
}
