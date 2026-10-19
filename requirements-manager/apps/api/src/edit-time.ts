import {BadRequestException, Body, Controller, ForbiddenException, Get, Injectable, Param, Post, Req} from "@nestjs/common";
import {PrismaService} from "./prisma.js";

export type EditTimeSegmentInput = {id: string; startedAt: string; durationMs: number};
export type EditTimeSummary = {
    myDurationMs: number;
    projectDurationMs: number;
    users: {userId: string; username: string; durationMs: number}[]
};

const MAX_SEGMENTS_PER_REQUEST = 100;
const MAX_SEGMENT_DURATION_MS = 4 * 60 * 60 * 1000;
const SEGMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateEditTimeSegments(value: unknown): EditTimeSegmentInput[] {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SEGMENTS_PER_REQUEST) {
        throw new BadRequestException(`segments必须包含1到${MAX_SEGMENTS_PER_REQUEST}项`)
    }
    return value.map((item, index) => {
        if (!item || typeof item !== "object") throw new BadRequestException(`segments[${index}]格式无效`);
        const segment = item as Partial<EditTimeSegmentInput>, startedAt = new Date(String(segment.startedAt || ""));
        if (typeof segment.id !== "string" || !SEGMENT_ID.test(segment.id)) throw new BadRequestException(`segments[${index}].id必须是UUID`);
        if (!Number.isInteger(segment.durationMs) || segment.durationMs! <= 0 || segment.durationMs! > MAX_SEGMENT_DURATION_MS) {
            throw new BadRequestException(`segments[${index}].durationMs必须是1到${MAX_SEGMENT_DURATION_MS}之间的整数`)
        }
        if (!Number.isFinite(startedAt.getTime())) throw new BadRequestException(`segments[${index}].startedAt必须是有效时间`);
        return {id: segment.id, startedAt: startedAt.toISOString(), durationMs: segment.durationMs!}
    })
}

@Injectable()
export class EditTimeService {
    constructor(private db: PrismaService) {}

    private async ensureProject(projectId: string) {
        await this.db.project.findUniqueOrThrow({where: {id: projectId}, select: {id: true}})
    }

    async summary(projectId: string, userId: string): Promise<EditTimeSummary> {
        await this.ensureProject(projectId);
        const [groups, users] = await Promise.all([
            this.db.editTimeSegment.groupBy({by: ["userId"], where: {projectId}, _sum: {durationMs: true}}),
            this.db.user.findMany({where: {editTimeSegments: {some: {projectId}}}, select: {id: true, username: true}})
        ]);
        const names = new Map(users.map(user => [user.id, user.username]));
        const rows = groups.map(group => ({userId: group.userId, username: names.get(group.userId) || "未知用户",
            durationMs: group._sum.durationMs || 0})).sort((a, b) => b.durationMs - a.durationMs || a.username.localeCompare(b.username));
        return {myDurationMs: rows.find(row => row.userId === userId)?.durationMs || 0,
            projectDurationMs: rows.reduce((sum, row) => sum + row.durationMs, 0), users: rows}
    }

    async append(projectId: string, user: {id: string; role: string}, rawSegments: unknown) {
        if (!( ["ADMIN", "REVIEWER"] as string[]).includes(user.role)) throw new ForbiddenException("当前角色没有编辑计时权限");
        await this.ensureProject(projectId);
        const segments = validateEditTimeSegments(rawSegments);
        await this.db.editTimeSegment.createMany({data: segments.map(segment => ({id: segment.id, projectId, userId: user.id,
            startedAt: new Date(segment.startedAt), durationMs: segment.durationMs})), skipDuplicates: true});
        return this.summary(projectId, user.id)
    }
}

@Controller("projects/:projectId/edit-time")
export class EditTimeController {
    constructor(private editTime: EditTimeService) {}
    @Get() summary(@Param("projectId") projectId: string, @Req() req: any) {
        return this.editTime.summary(projectId, req.user.id)
    }
    @Post("segments") append(@Param("projectId") projectId: string, @Req() req: any, @Body() body: {segments?: unknown}) {
        return this.editTime.append(projectId, req.user, body?.segments)
    }
}

