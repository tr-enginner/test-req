import {describe, expect, it} from "vitest";
import {runSessionTasks} from "./session-tasks.js";

describe("session task error handling", () => {
    it("reports tool failure while command remains pending and observes its later rejection", async () => {
        let rejectCommand!: (error: Error) => void;
        const command = new Promise<void>((_, reject) => { rejectCommand = reject });
        const error = new Error("prepare_interface_test_content: 业务执行失败");
        await expect(runSessionTasks(async () => { throw error }, () => command)).rejects.toBe(error);
        rejectCommand(new Error("command aborted"));
        await new Promise(resolve => setTimeout(resolve, 0));
    });
    it("reports command failure and observes the event stream cancellation", async () => {
        let rejectStream!: (error: Error) => void;
        const stream = new Promise<void>((_, reject) => { rejectStream = reject });
        await expect(runSessionTasks(() => stream, async () => { throw new Error("HTTP 500") })).rejects.toThrow("HTTP 500");
        rejectStream(new Error("stream aborted"));
        await new Promise(resolve => setTimeout(resolve, 0));
    });
    it("waits for both successful tasks", async () => {
        let finish!: () => void;
        let completed = false;
        const pending = new Promise<void>(resolve => { finish = resolve });
        const task = runSessionTasks(() => pending, async () => {}).then(() => { completed = true });
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(completed).toBe(false);
        finish();
        await task;
        expect(completed).toBe(true);
    });
});
