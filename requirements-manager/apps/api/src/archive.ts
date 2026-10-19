import {BadRequestException} from "@nestjs/common";
import {createWriteStream} from "node:fs";
import {mkdir, realpath} from "node:fs/promises";
import path from "node:path";
import iconv from "iconv-lite";
import unzipper from "unzipper";

type ArchiveEntry = {
    path: string;
    pathBuffer?: Buffer;
    isUnicode?: boolean;
    uncompressedSize: number;
    type: string;
    stream(): NodeJS.ReadableStream
};

export function decodeZipEntryPath(entry: ArchiveEntry) {
    const raw = entry.pathBuffer;
    if (!raw) return entry.path;
    if (entry.isUnicode) return raw.toString("utf8");
    const utf8 = raw.toString("utf8");
    if (!utf8.includes("\uFFFD") && Buffer.from(utf8, "utf8").equals(raw)) return utf8;
    const gb18030 = iconv.decode(raw, "gb18030");
    if (/[\u3400-\u9FFF]/u.test(gb18030)) return gb18030;
    return iconv.decode(raw, "cp437")
}

export async function safeExtract(zipPath: string, target: string, options?: { docxOnly?: boolean }) {
    await mkdir(target, {recursive: true});
    const root = await realpath(target);
    let files = 0, total = 0;
    const maxFiles = +(process.env.MAX_ARCHIVE_FILES || 10000),
        maxBytes = +(process.env.MAX_EXTRACTED_BYTES || 5368709120);
    const directory = await unzipper.Open.file(zipPath);
    let documentCount = 0;
    for (const entry of directory.files as unknown as ArchiveEntry[]) {
        files++;
        total += entry.uncompressedSize;
        if (files > maxFiles || total > maxBytes) throw new BadRequestException("压缩包解压后超出限制");
        if ((entry as any).type === "SymbolicLink") throw new BadRequestException("压缩包不允许符号链接");
        const entryPath = decodeZipEntryPath(entry);
        if (!entryPath || entryPath.includes("\0")) throw new BadRequestException("压缩包包含无效文件名");
        const segments = entryPath.replace(/\\/g, "/").split("/").filter(Boolean);
        if (options?.docxOnly && segments.some(segment => segment.toLowerCase() === ".matrix")) {
            throw new BadRequestException("压缩包不能包含.matrix目录")
        }
        if (options?.docxOnly && entry.type !== "Directory") {
            if (!entryPath.toLowerCase().endsWith(".docx")) throw new BadRequestException(`压缩包包含非DOCX文件：${entryPath}`);
            documentCount++
        }
        const output = path.resolve(root, entryPath.replace(/[\\/]+/g, path.sep));
        if (output !== root && !output.startsWith(root + path.sep)) throw new BadRequestException("压缩包包含非法路径");
        if (entry.type === "Directory") await mkdir(output, {recursive: true}); else {
            await mkdir(path.dirname(output), {recursive: true});
            await new Promise<void>((resolve, reject) => entry.stream().pipe(createWriteStream(output)).on("finish", resolve).on("error", reject))
        }
    }
    if (options?.docxOnly && documentCount === 0) throw new BadRequestException("压缩包中至少需要包含一个DOCX文件");
    return {files, total, documentCount}
}
