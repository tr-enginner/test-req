import {
    BadRequestException,
    Body,
    ConflictException,
    Controller,
    Delete,
    ForbiddenException,
    Get,
    Injectable,
    NotFoundException,
    OnModuleDestroy,
    Param,
    Put,
    Query,
    Req,
    Res,
    Sse
} from "@nestjs/common";
import {createHash, randomUUID} from "node:crypto";
import {createReadStream} from "node:fs";
import {mkdir, lstat, readdir, readFile, realpath, rename, rm, stat, writeFile} from "node:fs/promises";
import path from "node:path";
import chokidar, {type FSWatcher} from "chokidar";
import {ZipArchive, type Archiver} from "archiver";
import {format, parse, printParseErrorCode, type ParseError} from "jsonc-parser";
import {interval, map, merge, Observable, Subject} from "rxjs";
import {PrismaService} from "./prisma.js";

type DebugTreeNode = {
    name: string;
    path: string;
    type: "directory" | "file";
    size?: number;
    modifiedAt?: string;
    version?: string;
    children?: DebugTreeNode[];
};

type WatchEvent = {type: "added" | "changed" | "deleted" | "tree"; path: string; at: string};
type WatchEntry = {watcher: FSWatcher; subject: Subject<WatchEvent>; subscribers: number};

const IMAGE_TYPES: Record<string, string> = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
    ".webp": "image/webp", ".svg": "image/svg+xml", ".bmp": "image/bmp"
};

const DOWNLOAD_TYPES: Record<string, string> = {
    ...IMAGE_TYPES,
    ".json": "application/json; charset=utf-8",
    ".jsonc": "application/json; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".log": "text/plain; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".zip": "application/zip"
};

function requireAdmin(request: any) {
    if (request.user?.role !== "ADMIN") throw new ForbiddenException("仅管理员可以使用调试模式")
}

function relativePath(root: string, value: string) {
    return path.relative(root, value).split(path.sep).join("/")
}

function versionOf(buffer: Buffer) {
    return createHash("sha256").update(buffer).digest("hex")
}

function downloadDisposition(filename: string) {
    const extension = path.extname(filename).replace(/[^.A-Za-z0-9]/g, "").slice(0, 12);
    return `attachment; filename="download${extension}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

function safeArchiveName(value: string) {
    return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim().slice(0, 80) || "project"
}

function isUtf8Text(buffer: Buffer) {
    if (buffer.includes(0)) return false;
    try {
        new TextDecoder("utf-8", {fatal: true}).decode(buffer);
        return true
    } catch {
        return false
    }
}

@Injectable()
export class DebugFilesService implements OnModuleDestroy {
    private watches = new Map<string, WatchEntry>();

    constructor(private db: PrismaService) {}

    async onModuleDestroy() {
        await Promise.all([...this.watches.values()].map(item => item.watcher.close()));
        this.watches.clear()
    }

    private async projectInfo(projectId: string) {
        const project = await this.db.project.findUnique({where: {id: projectId}, select: {workspacePath: true, name: true}});
        if (!project) throw new NotFoundException("项目不存在或已被删除");
        return project
    }

    private async projectRoot(projectId: string) {
        const project = await this.projectInfo(projectId);
        const root = path.resolve(project.workspacePath);
        await mkdir(root, {recursive: true});
        if ((await lstat(root)).isSymbolicLink()) throw new BadRequestException("项目根目录不能是符号链接");
        return root
    }

    private normalizeRelative(value: string | undefined) {
        const raw = String(value || ""), input = raw.replace(/\\/g, "/");
        if (!input || input.includes("\0") || path.isAbsolute(raw) || path.win32.isAbsolute(raw) || path.posix.isAbsolute(input)) {
            throw new BadRequestException("文件路径不合法")
        }
        const normalized = path.posix.normalize(input);
        if (normalized === ".." || normalized.startsWith("../")) throw new BadRequestException("文件路径越界");
        return normalized
    }

    private async resolveFile(projectId: string, requestedPath: string | undefined) {
        const root = await this.projectRoot(projectId), relative = this.normalizeRelative(requestedPath),
            target = path.resolve(root, ...relative.split("/"));
        if (target === root || !target.startsWith(root + path.sep)) throw new BadRequestException("文件路径越界");
        let info;
        try {
            // A symlink inside .matrix must not grant write access to source files.
            let ancestor = root;
            for (const segment of relative.split("/").slice(0, -1)) {
                ancestor = path.join(ancestor, segment);
                if ((await lstat(ancestor)).isSymbolicLink()) throw new BadRequestException("不允许访问符号链接");
            }
            info = await lstat(target)
        } catch (error) {
            if (error instanceof BadRequestException) throw error;
            throw new NotFoundException("文件不存在")
        }
        if (info.isSymbolicLink()) throw new BadRequestException("不允许访问符号链接");
        if (!info.isFile()) throw new BadRequestException("目标不是文件");
        const canonicalRoot = await realpath(root), canonicalTarget = await realpath(target);
        if (!canonicalTarget.startsWith(canonicalRoot + path.sep)) throw new BadRequestException("文件路径越界");
        return {root, relative, target, info}
    }

    private async nodes(root: string, directory: string): Promise<DebugTreeNode[]> {
        const entries = await readdir(directory, {withFileTypes: true}).catch(error => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
            throw error
        });
        const result: DebugTreeNode[] = [];
        for (const entry of entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))) {
            const absolute = path.join(directory, entry.name), relative = relativePath(root, absolute);
            if (entry.isSymbolicLink()) continue;
            if (entry.isDirectory()) {
                result.push({name: entry.name, path: relative, type: "directory", children: await this.nodes(root, absolute)})
            } else if (entry.isFile()) {
                const info = await stat(absolute);
                result.push({name: entry.name, path: relative, type: "file", size: info.size,
                    modifiedAt: info.mtime.toISOString(), version: `${info.mtimeMs}:${info.size}`})
            }
        }
        return result
    }

    async tree(projectId: string) {
        const root = await this.projectRoot(projectId);
        return {root: "source", children: await this.nodes(root, root)}
    }

    async read(projectId: string, requestedPath: string | undefined) {
        const {relative, target, info} = await this.resolveFile(projectId, requestedPath), buffer = await readFile(target),
            extension = path.extname(relative).toLowerCase(), mimeType = IMAGE_TYPES[extension];
        const common = {editable: relative.startsWith(".matrix/") && isUtf8Text(buffer), deletable: relative.startsWith(".matrix/"), path: relative, size: buffer.length, modifiedAt: info.mtime.toISOString(), version: versionOf(buffer)};
        if (isUtf8Text(buffer)) return {...common, kind: "text" as const, content: buffer.toString("utf8")};
        if (mimeType) return {...common, kind: "image" as const, mimeType, contentBase64: buffer.toString("base64")};
        return {...common, kind: "binary" as const}
    }

    async download(projectId: string, requestedPath: string | undefined) {
        const resolved = await this.resolveFile(projectId, requestedPath), extension = path.extname(resolved.relative).toLowerCase();
        return {target: resolved.target, filename: path.basename(resolved.relative), size: resolved.info.size,
            contentType: DOWNLOAD_TYPES[extension] || "application/octet-stream"}
    }

    async archiveSource(projectId: string) {
        const project = await this.projectInfo(projectId), root = await this.projectRoot(projectId),
            timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
        return {root, filename: `${safeArchiveName(project.name)}-source-${timestamp}.zip`}
    }

    async populateArchive(root: string, archive: Archiver) {
        archive.append(Buffer.alloc(0), {name: "source/"});
        const visit = async (directory: string) => {
            const entries = await readdir(directory, {withFileTypes: true}).catch(error => {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
                throw error
            });
            for (const entry of entries) {
                const absolute = path.join(directory, entry.name), relative = relativePath(root, absolute),
                    info = await lstat(absolute).catch(error => {
                        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
                        throw error
                    });
                if (!info || info.isSymbolicLink()) continue;
                if (info.isDirectory()) await visit(absolute);
                else if (info.isFile()) archive.file(absolute, {name: `source/${relative}`})
            }
        };
        await visit(root)
    }

    private validateStructured(relative: string, content: string) {
        const extension = path.extname(relative).toLowerCase();
        if (extension === ".json") {
            try { JSON.parse(content) } catch (error) {
                throw new BadRequestException(`JSON格式错误：${error instanceof Error ? error.message : String(error)}`)
            }
        }
        if (extension === ".jsonc") {
            const errors: ParseError[] = [];
            parse(content, errors, {allowTrailingComma: true, disallowComments: false});
            if (errors.length) throw new BadRequestException(`JSONC格式错误：${printParseErrorCode(errors[0].error)}（位置 ${errors[0].offset}）`)
        }
    }

    async save(projectId: string, userId: string, body: {path?: string; content?: unknown; expectedVersion?: string; force?: boolean}) {
        if (typeof body.content !== "string") throw new BadRequestException("文件内容必须是文本");
        const resolved = await this.resolveFile(projectId, body.path);
        if (!resolved.relative.startsWith(".matrix/")) throw new ForbiddenException("源文件仅支持浏览和下载");
        const current = await readFile(resolved.target);
        if (!isUtf8Text(current)) throw new BadRequestException("二进制文件不支持在线编辑");
        const currentVersion = versionOf(current);
        if (!body.force && body.expectedVersion !== currentVersion) throw new ConflictException({
            message: "文件已被外部修改，请重新加载或确认强制覆盖", currentVersion
        });
        this.validateStructured(resolved.relative, body.content);
        const temporary = path.join(path.dirname(resolved.target), `.${path.basename(resolved.target)}.${randomUUID()}.tmp`);
        try {
            await writeFile(temporary, body.content, "utf8");
            await rename(temporary, resolved.target)
        } finally {
            await rm(temporary, {force: true}).catch(() => undefined)
        }
        const result = await this.read(projectId, resolved.relative), runStatus = await this.runningStatus(projectId);
        await this.db.auditLog.create({data: {userId, action: body.force ? "DEBUG_FILE_FORCE_SAVED" : "DEBUG_FILE_SAVED",
            resourceType: "ProjectFile", resourceId: projectId,
            detail: {path: resolved.relative, runStatus}}});
        return {...result, runStatus}
    }

    async remove(projectId: string, userId: string, requestedPath: string | undefined, expectedVersion: string | undefined, force: boolean) {
        const resolved = await this.resolveFile(projectId, requestedPath);
        if (!resolved.relative.startsWith(".matrix/")) throw new ForbiddenException("源文件仅支持浏览和下载");
        const current = await readFile(resolved.target), currentVersion = versionOf(current);
        if (!force && expectedVersion !== currentVersion) throw new ConflictException({
            message: "文件已被外部修改，请重新加载后再删除", currentVersion
        });
        await rm(resolved.target);
        const runStatus = await this.runningStatus(projectId);
        await this.db.auditLog.create({data: {userId, action: force ? "DEBUG_FILE_FORCE_DELETED" : "DEBUG_FILE_DELETED",
            resourceType: "ProjectFile", resourceId: projectId, detail: {path: resolved.relative, runStatus}}});
        return {path: resolved.relative, runStatus}
    }

    private async runningStatus(projectId: string) {
        const run = await this.db.phase2Run.findFirst({where: {projectId, status: {in: ["QUEUED", "RUNNING"]}},
            orderBy: {startedAt: "desc"}, select: {status: true}});
        return run?.status || null
    }

    formatJson(content: string, jsonc: boolean) {
        const errors: ParseError[] = [];
        parse(content, errors, {allowTrailingComma: jsonc, disallowComments: !jsonc});
        if (errors.length) throw new BadRequestException(`格式错误：${printParseErrorCode(errors[0].error)}（位置 ${errors[0].offset}）`);
        return format(content, undefined, {tabSize: 2, insertSpaces: true, insertFinalNewline: true})
            .reduceRight((value, edit) => value.slice(0, edit.offset) + edit.content + value.slice(edit.offset + edit.length), content)
    }

    async events(projectId: string): Promise<Observable<MessageEvent>> {
        const root = await this.projectRoot(projectId);
        let entry = this.watches.get(root);
        if (!entry) {
            const subject = new Subject<WatchEvent>(), watcher = chokidar.watch(root, {ignoreInitial: true, followSymlinks: false});
            entry = {watcher, subject, subscribers: 0};
            const emit = (type: WatchEvent["type"], file: string) => subject.next({type, path: relativePath(root, file), at: new Date().toISOString()});
            watcher.on("add", file => emit("added", file)).on("change", file => emit("changed", file))
                .on("unlink", file => emit("deleted", file)).on("addDir", file => emit("tree", file))
                .on("unlinkDir", file => emit("tree", file));
            this.watches.set(root, entry)
        }
        const selected = entry;
        return new Observable<MessageEvent>(subscriber => {
            selected.subscribers++;
            const updates = merge(selected.subject.pipe(map(data => ({type: "file-change", data}) as MessageEvent)),
                interval(15000).pipe(map(() => ({type: "heartbeat", data: {at: new Date().toISOString()}}) as MessageEvent)))
                .subscribe(subscriber);
            return () => {
                updates.unsubscribe();
                selected.subscribers--;
                if (selected.subscribers === 0) {
                    this.watches.delete(root);
                    void selected.watcher.close()
                }
            }
        })
    }
}

@Controller("projects/:projectId/debug-files")
export class DebugFilesController {
    constructor(private files: DebugFilesService) {}

    @Get("tree") tree(@Req() request: any, @Param("projectId") projectId: string) {
        requireAdmin(request); return this.files.tree(projectId)
    }

    @Get("file") read(@Req() request: any, @Param("projectId") projectId: string, @Query("path") filePath?: string) {
        requireAdmin(request); return this.files.read(projectId, filePath)
    }

    @Get("download") async download(@Req() request: any, @Res() reply: any,
                                    @Param("projectId") projectId: string, @Query("path") filePath?: string) {
        requireAdmin(request);
        const file = await this.files.download(projectId, filePath);
        return reply.type(file.contentType).header("Content-Length", String(file.size))
            .header("Content-Disposition", downloadDisposition(file.filename)).send(createReadStream(file.target))
    }

    @Get("archive") async archive(@Req() request: any, @Res() reply: any, @Param("projectId") projectId: string) {
        requireAdmin(request);
        const source = await this.files.archiveSource(projectId), output = new ZipArchive({zlib: {level: 6}});
        output.on("warning", (error: Error & {code?: string}) => {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") output.destroy(error)
        });
        void this.files.populateArchive(source.root, output).then(() => output.finalize()).catch(error => output.destroy(error));
        return reply.type("application/zip").header("Content-Disposition", downloadDisposition(source.filename)).send(output)
    }

    @Put("file") save(@Req() request: any, @Param("projectId") projectId: string,
                      @Body() body: {path?: string; content?: unknown; expectedVersion?: string; force?: boolean}) {
        requireAdmin(request); return this.files.save(projectId, request.user.id, body)
    }

    @Delete("file") remove(@Req() request: any, @Param("projectId") projectId: string,
                           @Query("path") filePath?: string, @Query("expectedVersion") expectedVersion?: string,
                           @Query("force") force?: string) {
        requireAdmin(request); return this.files.remove(projectId, request.user.id, filePath, expectedVersion, force === "true")
    }

    @Put("format") format(@Req() request: any, @Body() body: {content?: unknown; jsonc?: boolean}) {
        requireAdmin(request);
        if (typeof body.content !== "string") throw new BadRequestException("文件内容必须是文本");
        return {content: this.files.formatJson(body.content, Boolean(body.jsonc))}
    }

    @Sse("events") async events(@Req() request: any, @Param("projectId") projectId: string) {
        requireAdmin(request); return this.files.events(projectId)
    }
}
