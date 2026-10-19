import {hash} from "argon2";
import {describe, expect, it, vi} from "vitest";
import {AuthController, AuthService} from "./auth.js";

describe("simple access-token authentication", () => {
    it("logs in without creating server-side refresh-token state", async () => {
        const passwordHash = await hash("password123");
        const db = {
            user: {findUnique: vi.fn().mockResolvedValue({
                id: "user-1", username: "reviewer", role: "REVIEWER", passwordHash
            })}
        } as any;

        const result = await new AuthService(db).login("reviewer", "password123");

        expect(result.user).toEqual({id: "user-1", username: "reviewer", role: "REVIEWER"});
        expect(result.access).toEqual(expect.any(String));
        expect(result).not.toHaveProperty("refresh");
        expect(result).not.toHaveProperty("rememberMe")
    });

    it("sets only the seven-day access cookie on login", async () => {
        const auth = {login: vi.fn().mockResolvedValue({
            user: {id: "user-1", username: "reviewer", role: "REVIEWER"}, access: "access-token"
        })} as any;
        const response = {setCookie: vi.fn()};

        const result = await new AuthController(auth).login({username: "reviewer", password: "password123"}, response);

        expect(auth.login).toHaveBeenCalledWith("reviewer", "password123");
        expect(response.setCookie).toHaveBeenCalledTimes(1);
        expect(response.setCookie).toHaveBeenCalledWith("access_token", "access-token", expect.objectContaining({
            httpOnly: true, path: "/", maxAge: 7 * 24 * 60 * 60
        }));
        expect(result).toEqual({id: "user-1", username: "reviewer", role: "REVIEWER"})
    });

    it("does not expose a refresh endpoint and logs out without service state", () => {
        expect("refresh" in AuthController.prototype).toBe(false);
        const response = {clearCookie: vi.fn()};
        const result = new AuthController({} as any).logout(response);

        expect(response.clearCookie).toHaveBeenCalledTimes(1);
        expect(response.clearCookie).toHaveBeenCalledWith("access_token", expect.objectContaining({path: "/"}));
        expect(result).toEqual({ok: true})
    });

    it("changes the password with an audit record and no refresh-token revocation", async () => {
        const passwordHash = await hash("password123");
        const update = vi.fn().mockResolvedValue({});
        const auditCreate = vi.fn().mockResolvedValue({});
        const transaction = vi.fn().mockResolvedValue([]);
        const db = {
            user: {findUniqueOrThrow: vi.fn().mockResolvedValue({id: "user-1", passwordHash}), update},
            auditLog: {create: auditCreate},
            $transaction: transaction
        } as any;

        await expect(new AuthService(db).changePassword("user-1", "password123", "new-password123"))
            .resolves.toEqual({ok: true});

        expect(update).toHaveBeenCalledOnce();
        expect(auditCreate).toHaveBeenCalledWith({data: {
            userId: "user-1", action: "PASSWORD_CHANGED", resourceType: "User", resourceId: "user-1"
        }});
        expect(transaction.mock.calls[0][0]).toHaveLength(2)
    });

    it("loads the current user by the id already verified by the guard", async () => {
        const findUniqueOrThrow = vi.fn().mockResolvedValue({id: "user-1", username: "reviewer", role: "REVIEWER"});
        const service = new AuthService({user: {findUniqueOrThrow}} as any);

        await service.current("user-1");

        expect(findUniqueOrThrow).toHaveBeenCalledWith({
            where: {id: "user-1"}, select: {id: true, username: true, role: true}
        })
    })
});
