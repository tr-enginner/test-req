import {BadRequestException, ForbiddenException} from "@nestjs/common";
import {describe, expect, it, vi} from "vitest";
import {SettingsController, validateNewUser} from "./settings.js";

describe("validateNewUser", () => {
    it("trims the username and accepts a valid password", () => {
        expect(validateNewUser({username: " reviewer ", password: "password123"})).toEqual({
            username: "reviewer",
            password: "password123"
        })
    });

    it("rejects invalid usernames and passwords", () => {
        expect(() => validateNewUser({username: " ", password: "password123"})).toThrow(BadRequestException);
        expect(() => validateNewUser({username: "reviewer", password: "short"})).toThrow(BadRequestException);
        expect(() => validateNewUser({username: "x".repeat(65), password: "password123"})).toThrow(BadRequestException)
    })
});

describe("SettingsController.createUser", () => {
    it("creates a reviewer and writes a password-free audit record", async () => {
        const created = {id: "user-2", username: "reviewer", role: "REVIEWER", createdAt: new Date()};
        const userCreate = vi.fn().mockResolvedValue(created);
        const auditCreate = vi.fn().mockResolvedValue({});
        const db = {
            $transaction: (callback: (transaction: any) => unknown) => callback({
                user: {create: userCreate},
                auditLog: {create: auditCreate}
            })
        } as any;
        const result = await new SettingsController(db).createUser(
            {user: {id: "admin-1", role: "ADMIN"}},
            {username: " reviewer ", password: "password123"}
        );

        expect(result).toEqual(created);
        expect(userCreate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({username: "reviewer", role: "REVIEWER"}),
            select: {id: true, username: true, role: true, createdAt: true}
        }));
        const auditData = auditCreate.mock.calls[0][0].data;
        expect(auditData).toMatchObject({userId: "admin-1", action: "USER_CREATED", resourceId: "user-2"});
        expect(JSON.stringify(auditData)).not.toContain("password123")
    });

    it("rejects non-admin users", async () => {
        const controller = new SettingsController({} as any);
        await expect(controller.createUser(
            {user: {id: "reviewer-1", role: "REVIEWER"}},
            {username: "another", password: "password123"}
        )).rejects.toBeInstanceOf(ForbiddenException)
    })
});
