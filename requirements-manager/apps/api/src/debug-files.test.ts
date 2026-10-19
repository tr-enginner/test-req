import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {mkdtemp, mkdir, readFile, rm, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {BadRequestException, ConflictException, ForbiddenException} from "@nestjs/common";
import {DebugFilesController, DebugFilesService} from "./debug-files.js";
import {filter, firstValueFrom, timeout} from "rxjs";
import {ZipArchive} from "archiver";
import unzipper from "unzipper";

describe("DebugFilesService", () => {
    let workspace: string;
    let service: DebugFilesService;
    const auditCreate = vi.fn();

    beforeEach(async () => {
        workspace = await mkdtemp(path.join(tmpdir(), "matrix-debug-files-"));
        await mkdir(path.join(workspace, ".matrix", "data"), {recursive: true});
        await writeFile(path.join(workspace, ".matrix", "data", "artifact.json"), '{"value":1}\n');
        const db = {
            project: {findUnique: vi.fn().mockResolvedValue({workspacePath: workspace, name: "测试 Project"})},
            phase2Run: {findFirst: vi.fn().mockResolvedValue({status: "RUNNING"})},
            auditLog: {create: auditCreate.mockResolvedValue({})}
        };
        service = new DebugFilesService(db as any)
    });

    afterEach(async () => {
        await service.onModuleDestroy();
        await rm(workspace, {recursive: true, force: true});
        vi.clearAllMocks()
    });

    it("lists and reads files under .matrix", async () => {
        const tree = await service.tree("project-1"), file = await service.read("project-1", ".matrix/data/artifact.json");
        expect(tree.children[0]).toMatchObject({name: ".matrix", type: "directory"});
        expect(file).toMatchObject({path: ".matrix/data/artifact.json", kind: "text", content: '{"value":1}\n'});
        expect(file.version).toMatch(/^[a-f0-9]{64}$/)
    });

    it("saves atomically with optimistic concurrency and audits the change", async () => {
        const file = await service.read("project-1", ".matrix/data/artifact.json");
        const saved = await service.save("project-1", "admin-1", {
            path: file.path, content: '{"value":2}\n', expectedVersion: file.version
        });
        expect(saved).toMatchObject({content: '{"value":2}\n', runStatus: "RUNNING"});
        expect(await readFile(path.join(workspace, ".matrix", "data", "artifact.json"), "utf8")).toBe('{"value":2}\n');
        expect(auditCreate).toHaveBeenCalledWith({data: expect.objectContaining({
            userId: "admin-1", action: "DEBUG_FILE_SAVED", detail: {path: ".matrix/data/artifact.json", runStatus: "RUNNING"}
        })});
        await expect(service.save("project-1", "admin-1", {
            path: file.path, content: '{"value":3}\n', expectedVersion: file.version
        })).rejects.toBeInstanceOf(ConflictException)
    });

    it("validates JSON and allows an explicit forced overwrite", async () => {
        const file = await service.read("project-1", ".matrix/data/artifact.json");
        await expect(service.save("project-1", "admin-1", {
            path: file.path, content: "{broken", expectedVersion: file.version
        })).rejects.toBeInstanceOf(BadRequestException);
        await writeFile(path.join(workspace, ".matrix", "data", "artifact.json"), '{"external":true}\n');
        const saved = await service.save("project-1", "admin-1", {
            path: file.path, content: '{"forced":true}\n', expectedVersion: file.version, force: true
        });
        expect(saved.kind).toBe("text");
        expect("content" in saved ? saved.content : undefined).toBe('{"forced":true}\n');
        expect(auditCreate).toHaveBeenCalledWith({data: expect.objectContaining({action: "DEBUG_FILE_FORCE_SAVED"})})
    });

    it("deletes only files with a matching version", async () => {
        const file = await service.read("project-1", ".matrix/data/artifact.json");
        await expect(service.remove("project-1", "admin-1", ".matrix/data", file.version, false))
            .rejects.toBeInstanceOf(BadRequestException);
        await service.remove("project-1", "admin-1", file.path, file.version, false);
        await expect(readFile(path.join(workspace, ".matrix", "data", "artifact.json"))).rejects.toBeTruthy();
        expect(auditCreate).toHaveBeenCalledWith({data: expect.objectContaining({action: "DEBUG_FILE_DELETED"})})
    });

    it("rejects traversal, absolute paths, symlinks and binary edits", async () => {
        await expect(service.read("project-1", "../outside.txt")).rejects.toBeInstanceOf(BadRequestException);
        await expect(service.read("project-1", path.resolve(workspace, "outside.txt"))).rejects.toBeInstanceOf(BadRequestException);
        const outside = path.join(workspace, "outside"), link = path.join(workspace, ".matrix", "link");
        await mkdir(outside);
        await symlink(outside, link, "junction");
        await expect(service.read("project-1", ".matrix/link")).rejects.toBeInstanceOf(BadRequestException);
        await writeFile(path.join(workspace, ".matrix", "binary.bin"), Buffer.from([0, 1, 2]));
        const binary = await service.read("project-1", ".matrix/binary.bin");
        expect(binary.kind).toBe("binary");
        await expect(service.save("project-1", "admin-1", {path: ".matrix/binary.bin", content: "text", expectedVersion: binary.version}))
            .rejects.toBeInstanceOf(BadRequestException)
    });

    it("pushes filesystem changes to active SSE subscribers", async () => {
        const events = await service.events("project-1"), received = firstValueFrom(events.pipe(
            filter(event => event.type === "file-change" && (event.data as any).path === ".matrix/data/live.txt"), timeout(3000)));
        const entry = [...(service as any).watches.values()][0];
        await new Promise<void>(resolve => entry.watcher.once("ready", resolve));
        await writeFile(path.join(workspace, ".matrix", "data", "live.txt"), "live");
        const event = await received;
        expect(event.data).toMatchObject({type: "added", path: ".matrix/data/live.txt"})
    });

    it("allows only reading and downloading source files, including forced mutation requests", async () => {
        const docx = Buffer.from([0x50, 0x4b, 3, 4, 0, 1, 2]);
        await writeFile(path.join(workspace, "需求规格说明.docx"), docx);
        await writeFile(path.join(workspace, "notes.txt"), "source text");
        const tree = await service.tree("project-1");
        expect(tree.root).toBe("source");
        expect(tree.children.map(node => node.name)).toEqual(expect.arrayContaining([".matrix", "需求规格说明.docx"]));
        for (const name of ["需求规格说明.docx", "notes.txt"]) {
            const file = await service.read("project-1", name);
            expect(file).toMatchObject({editable: false, deletable: false});
            for (const force of [false, true]) {
                await expect(service.save("project-1", "admin", {path: name, content: "overwrite", expectedVersion: file.version, force}))
                    .rejects.toBeInstanceOf(ForbiddenException);
                await expect(service.remove("project-1", "admin", name, file.version, force)).rejects.toBeInstanceOf(ForbiddenException);
            }
        }
        const download = await service.download("project-1", "需求规格说明.docx");
        expect(download).toMatchObject({filename: "需求规格说明.docx", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"});
        expect(await readFile(download.target)).toEqual(docx);
        expect(auditCreate).not.toHaveBeenCalled();
        expect(await service.read("project-1", ".matrix/data/artifact.json")).toMatchObject({editable: true, deletable: true});
    });

    it("uses a nested workspace directly and blocks symlink ancestors from granting write access", async () => {
        const nested = path.join(workspace, "source", "项目名");
        await mkdir(path.join(nested, ".matrix"), {recursive: true});
        await writeFile(path.join(nested, "需求.docx"), Buffer.from([0, 1, 2]));
        const nestedService = new DebugFilesService({project: {findUnique: vi.fn().mockResolvedValue({workspacePath: nested, name: "Nested"})}} as any);
        expect((await nestedService.tree("p")).children.map(node => node.name)).toEqual(expect.arrayContaining([".matrix", "需求.docx"]));
        expect((await nestedService.download("p", "需求.docx")).target).toBe(path.join(nested, "需求.docx"));
        await mkdir(path.join(workspace, "source-files"));
        await writeFile(path.join(workspace, "source-files", "notes.txt"), "preserve");
        await symlink(path.join(workspace, "source-files"), path.join(workspace, ".matrix", "source-link"), "junction");
        await expect(service.save("p", "admin", {path: ".matrix/source-link/notes.txt", content: "overwrite", force: true}))
            .rejects.toBeInstanceOf(BadRequestException);
        await expect(service.remove("p", "admin", ".matrix/../source-files/notes.txt", undefined, true))
            .rejects.toBeInstanceOf(ForbiddenException);
        expect(await readFile(path.join(workspace, "source-files", "notes.txt"), "utf8")).toBe("preserve");
        await nestedService.onModuleDestroy();
    });

    it("watches source files using project-relative paths", async () => {
        const events = await service.events("project-1"), received = firstValueFrom(events.pipe(
            filter(event => event.type === "file-change" && (event.data as any).path === "需求.docx"), timeout(3000)));
        const entry = [...(service as any).watches.values()][0];
        await new Promise<void>(resolve => entry.watcher.once("ready", resolve));
        await writeFile(path.join(workspace, "需求.docx"), Buffer.from([0, 1]));
        expect((await received).data).toMatchObject({type: "added", path: "需求.docx"});
    });

    it("formats JSONC while preserving comments", () => {
        const formatted = service.formatJson('{// note\n"value":1,}', true);
        expect(formatted).toContain("// note");
        expect(formatted).toContain('"value": 1')
    });

    it("returns a streaming descriptor for any individual file", async () => {
        const file = await service.download("project-1", ".matrix/data/artifact.json");
        expect(file).toMatchObject({filename: "artifact.json", contentType: "application/json; charset=utf-8"});
        expect(await readFile(file.target, "utf8")).toBe('{"value":1}\n')
    });

    it("builds a source ZIP with unicode paths and without following links", async () => {
        await writeFile(path.join(workspace, ".matrix", "data", "中文 文件.txt"), "内容");
        const docx = Buffer.from([0x50, 0x4b, 3, 4, 0, 1]);
        await writeFile(path.join(workspace, "需求规格说明.docx"), docx);
        const outside = path.join(workspace, "outside"), link = path.join(workspace, ".matrix", "external");
        await mkdir(outside);
        await writeFile(path.join(outside, "secret.txt"), "secret");
        await symlink(outside, link, "junction");
        const source = await service.archiveSource("project-1"), archive = new ZipArchive({zlib: {level: 1}}), chunks: Buffer[] = [];
        archive.on("data", chunk => chunks.push(Buffer.from(chunk)));
        const complete = new Promise<void>((resolve, reject) => archive.on("end", resolve).on("error", reject));
        await service.populateArchive(source.root, archive);
        await archive.finalize();
        await complete;
        const zip = await unzipper.Open.buffer(Buffer.concat(chunks)), names = zip.files.map(entry => entry.path);
        expect(source.filename).toMatch(/^测试 Project-source-\d{8}T\d{6}Z\.zip$/);
        expect(names).toContain("source/");
        expect(await zip.files.find(entry => entry.path === "source/需求规格说明.docx")!.buffer()).toEqual(docx);
        expect(names).toContain("source/.matrix/data/artifact.json");
        expect(names).toContain("source/.matrix/data/中文 文件.txt");
        expect(names.some(name => name.includes("external/secret.txt"))).toBe(false)
    });
});

describe("DebugFilesController authorization", () => {
    it("rejects non-admin users before accessing the service", () => {
        const files = {tree: vi.fn()} as any, controller = new DebugFilesController(files);
        expect(() => controller.tree({user: {id: "reviewer", role: "REVIEWER"}}, "project-1"))
            .toThrow(ForbiddenException);
        expect(files.tree).not.toHaveBeenCalled()
    })

    it("rejects non-admin download and archive requests", async () => {
        const files = {download: vi.fn(), archiveSource: vi.fn()} as any, controller = new DebugFilesController(files),
            request = {user: {id: "viewer", role: "VIEWER"}}, reply = {};
        await expect(controller.download(request, reply, "project-1", "data/a.txt")).rejects.toBeInstanceOf(ForbiddenException);
        await expect(controller.archive(request, reply, "project-1")).rejects.toBeInstanceOf(ForbiddenException);
        expect(files.download).not.toHaveBeenCalled();
        expect(files.archiveSource).not.toHaveBeenCalled()
    })
});
