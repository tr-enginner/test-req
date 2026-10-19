import {afterEach, describe, expect, it, vi} from "vitest";
import {
    api,
    authenticatedFetch,
    downloadApi,
    resetSessionExpiredNotification,
    subscribeToSessionExpired
} from "./api";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
    return new Response(JSON.stringify(body), {status, headers: {"Content-Type": "application/json", ...headers}})
}

describe("simple API authentication", () => {
    afterEach(() => {
        resetSessionExpiredNotification();
        vi.unstubAllGlobals()
    });

    it("returns an auth error after one request without attempting refresh", async () => {
        const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
            Promise.resolve(jsonResponse(401, {message: "未登录"})));
        vi.stubGlobal("fetch", fetchMock);

        await expect(api("/auth/me")).rejects.toMatchObject({status: 401, message: "未登录"});
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][0]).toBe("/api/auth/me");
        expect(fetchMock.mock.calls.some(call => call[0] === "/api/auth/refresh")).toBe(false)
    });

    it("always includes credentials in direct requests", async () => {
        const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
            Promise.resolve(jsonResponse(200, {ok: true})));
        vi.stubGlobal("fetch", fetchMock);

        await authenticatedFetch("/api/example", {method: "POST"});

        expect(fetchMock).toHaveBeenCalledWith("/api/example", {method: "POST", credentials: "include"})
    });

    it("downloads through one credentialed request", async () => {
        const response = new Response(new Blob(["document"]), {status: 200,
            headers: {"Content-Disposition": "attachment; filename*=UTF-8''manual.docx"}});
        const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => Promise.resolve(response));
        vi.stubGlobal("fetch", fetchMock);

        const result = await downloadApi("/projects/p1/export");

        expect(result.filename).toBe("manual.docx");
        expect(await result.blob.text()).toBe("document");
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledWith("/api/projects/p1/export", {credentials: "include"})
    });

    it("notifies once when concurrent protected requests return 401", async () => {
        const listener = vi.fn(), unsubscribe = subscribeToSessionExpired(listener);
        vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse(401, {message: "登录已过期"}))));

        await Promise.allSettled([api("/projects"), api("/projects/p1"), authenticatedFetch("/api/documents/d1/file")]);

        expect(listener).toHaveBeenCalledTimes(1);
        unsubscribe()
    });

    it("does not notify for authentication endpoints", async () => {
        const listener = vi.fn(), unsubscribe = subscribeToSessionExpired(listener);
        vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse(401, {message: "认证失败"}))));

        await Promise.allSettled([
            api("/auth/me"),
            api("/auth/login", {method: "POST"}),
            api("/auth/change-password", {method: "POST"})
        ]);

        expect(listener).not.toHaveBeenCalled();
        unsubscribe()
    });

    it("does not notify for forbidden, server, or network failures", async () => {
        const listener = vi.fn(), unsubscribe = subscribeToSessionExpired(listener);
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(jsonResponse(403, {message: "禁止访问"}))
            .mockResolvedValueOnce(jsonResponse(500, {message: "服务器错误"}))
            .mockRejectedValueOnce(new TypeError("network failure"));
        vi.stubGlobal("fetch", fetchMock);

        await Promise.allSettled([api("/projects"), downloadApi("/projects/p1/export"), api("/projects/p1")]);

        expect(listener).not.toHaveBeenCalled();
        unsubscribe()
    });

    it("notifies when a protected download returns 401", async () => {
        const listener = vi.fn(), unsubscribe = subscribeToSessionExpired(listener);
        vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse(401, {message: "登录已过期"}))));

        await expect(downloadApi("/projects/p1/export")).rejects.toMatchObject({status: 401});

        expect(listener).toHaveBeenCalledTimes(1);
        unsubscribe()
    })
});
