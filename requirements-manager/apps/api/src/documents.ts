import {Controller, Get, NotFoundException, Param, Res} from "@nestjs/common";
import {createReadStream} from "node:fs";
import {access} from "node:fs/promises";
import {PrismaService} from "./prisma.js";

@Controller("documents")
export class DocumentsController {
    constructor(private db: PrismaService) {
    }

    @Get(":id/file") async file(@Param("id") id: string, @Res() reply: any) {
        const document = await this.db.document.findUnique({where: {id}});
        if (!document) throw new NotFoundException("文档不存在");
        try {
            await access(document.objectKey)
        } catch {
            throw new NotFoundException("DOCX源文件不存在")
        }
        return reply.type("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
            .header("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(document.name)}`)
            .send(createReadStream(document.objectKey))
    }
}
