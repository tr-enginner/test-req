import {createServer} from "node:http";
import {Agent} from "undici";
import {afterAll, expect, it} from "vitest";
import {opencodeFetch, opencodeDispatcher, describeError} from "./opencode-transport.js";

afterAll(() => opencodeDispatcher.close());

it("allows delayed command headers while retaining explicit cancellation", async () => {
    const server = createServer((_req, res) => {
        const timer = setTimeout(() => res.end("done"), 1800);
        res.on("close", () => clearTimeout(timer));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as {port: number};
    const url = `http://127.0.0.1:${address.port}`;
    const shortTimeout = new Agent({headersTimeout: 50});
    try {
        await expect(fetch(url, {dispatcher: shortTimeout} as RequestInit))
            .rejects.toMatchObject({cause: {code: "UND_ERR_HEADERS_TIMEOUT"}});
        const response = await opencodeFetch(new Request(url));
        expect(await response.text()).toBe("done");
        await expect(opencodeFetch(new Request(url, {signal: AbortSignal.timeout(50)})))
            .rejects.toMatchObject({name: "TimeoutError"});
    } finally {
        await shortTimeout.close();
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
}, 10000);

it("preserves the transport cause and code without looping on circular causes", () => {
    const cause = Object.assign(new Error("Headers Timeout Error"), {code: "UND_ERR_HEADERS_TIMEOUT"});
    const error = new TypeError("fetch failed", {cause});
    cause.cause = error;
    expect(describeError(error)).toBe("fetch failed；原因：Headers Timeout Error [UND_ERR_HEADERS_TIMEOUT]");
});
