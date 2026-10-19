import "dotenv/config";
import "reflect-metadata";
import {NestFactory} from "@nestjs/core";
import {FastifyAdapter, NestFastifyApplication} from "@nestjs/platform-fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import {AppModule} from "./modules.js";

const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({
    logger: true,
    // 调试器按产品约定不限制文本产物大小；仍受 Node/操作系统可分配内存限制。
    bodyLimit: Number.MAX_SAFE_INTEGER
}));
await app.register(cookie);
await app.register(multipart, {limits: {fileSize: +(process.env.MAX_ARCHIVE_BYTES || 1073741824), files: 1}});
app.enableCors({origin: process.env.WEB_ORIGIN?.split(",") ?? true, credentials: true});
app.setGlobalPrefix("api");
await app.listen(3000, "0.0.0.0");
