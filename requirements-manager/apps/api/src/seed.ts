import {PrismaClient} from "@prisma/client";
import {hash} from "argon2";

const db = new PrismaClient(), username = process.env.ADMIN_USERNAME || "admin",
    password = process.env.ADMIN_PASSWORD || "ChangeMe123!";
await db.user.upsert({
    where: {username},
    update: {},
    create: {username, passwordHash: await hash(password), role: "ADMIN"}
});
console.log(`管理员 ${username} 已创建`);
await db.$disconnect();
