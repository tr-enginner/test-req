import {
    Body,
    BadRequestException,
    CanActivate,
    Controller,
    ExecutionContext,
    Get,
    Injectable,
    Post,
    Req,
    Res,
    UnauthorizedException
} from "@nestjs/common";
import {PrismaService} from "./prisma.js";
import {hash, verify} from "argon2";
import {jwtVerify, SignJWT} from "jose";

const secret = () => new TextEncoder().encode(process.env.JWT_SECRET || "development-secret-change-me-now");
const secureCookies = () => process.env.COOKIE_SECURE?.trim().toLowerCase() === "true";
const ACCESS_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
const cookieOptions = (path: string, maxAge?: number) => ({
    httpOnly: true,
    sameSite: "lax" as const,
    secure: secureCookies(),
    path,
    ...(maxAge ? {maxAge} : {})
});

@Injectable()
export class AuthGuard implements CanActivate {
    async canActivate(context: ExecutionContext) {
        const request = context.switchToHttp().getRequest();
        if (["/auth/login", "/auth/logout"].some(path => request.url?.includes(path))) return true;
        const token = request.cookies?.access_token;
        if (!token) throw new UnauthorizedException();
        try {
            const {payload} = await jwtVerify(token, secret());
            request.user = {id: String(payload.sub), role: payload.role};
            return true
        } catch {
            throw new UnauthorizedException("登录已过期")
        }
    }
}

@Injectable()
export class AuthService {
    constructor(private db: PrismaService) {
    }

    private signAccessToken(user: {id: string; role: string}) {
        return new SignJWT({role: user.role}).setProtectedHeader({alg: "HS256"}).setSubject(user.id)
            .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`).sign(secret())
    }

    async login(username: string, password: string) {
        const user = await this.db.user.findUnique({where: {username}});
        if (!user || !await verify(user.passwordHash, password)) throw new UnauthorizedException("用户名或密码错误");
        return {
            user: {id: user.id, username: user.username, role: user.role},
            access: await this.signAccessToken(user)
        }
    }

    async current(userId: string) {
        return this.db.user.findUniqueOrThrow({
            where: {id: userId},
            select: {id: true, username: true, role: true}
        })
    }

    async changePassword(userId: string, currentPassword: string, newPassword: string) {
        if (typeof newPassword !== "string" || newPassword.length < 8 || newPassword.length > 128) {
            throw new BadRequestException("新密码长度必须为8至128个字符")
        }
        const user = await this.db.user.findUniqueOrThrow({where: {id: userId}});
        if (!await verify(user.passwordHash, currentPassword)) throw new UnauthorizedException("当前密码错误");
        if (await verify(user.passwordHash, newPassword)) throw new BadRequestException("新密码不能与当前密码相同");
        await this.db.$transaction([
            this.db.user.update({where: {id: userId}, data: {passwordHash: await hash(newPassword)}}),
            this.db.auditLog.create({data: {userId, action: "PASSWORD_CHANGED", resourceType: "User", resourceId: userId}})
        ]);
        return {ok: true}
    }
}

@Controller("auth")
export class AuthController {
    constructor(private auth: AuthService) {
    }

    @Post("login") async login(@Body() body: {
        username: string,
        password: string
    }, @Res({passthrough: true}) res: any) {
        const result = await this.auth.login(body.username, body.password);
        res.setCookie("access_token", result.access, cookieOptions("/", ACCESS_TOKEN_TTL_SECONDS));
        return result.user
    }

    @Post("logout") logout(@Res({passthrough: true}) res: any) {
        res.clearCookie("access_token", cookieOptions("/"));
        return {ok: true}
    }

    @Post("change-password") async changePassword(@Req() req: any, @Body() body: {
        currentPassword: string,
        newPassword: string
    }, @Res({passthrough: true}) res: any) {
        const result = await this.auth.changePassword(req.user.id, body.currentPassword, body.newPassword);
        res.clearCookie("access_token", cookieOptions("/"));
        return result
    }

    @Get("me") me(@Req() req: any) {
        return this.auth.current(req.user.id)
    }
}
