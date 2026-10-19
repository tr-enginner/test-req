import type {EditTimeSegmentInput} from "./api";

export const EDIT_IDLE_MS = 30_000;
export const MAX_EDIT_SEGMENT_MS = 4 * 60 * 60 * 1000;

type Clock = {
    now: () => number;
    setTimeout: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => void
};

const defaultClock: Clock = {now: () => Date.now(), setTimeout: (callback, delay) => setTimeout(callback, delay), clearTimeout: timer => clearTimeout(timer)};

export function newSegmentId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, token => {
        const random = Math.floor(Math.random() * 16), value = token === "x" ? random : (random & 0x3) | 0x8;
        return value.toString(16)
    })
}

export class EditingTimeTracker {
    private startedAt?: number;
    private idleTimer?: ReturnType<typeof setTimeout>;
    constructor(private onSegment: (segment: EditTimeSegmentInput) => void, private clock: Clock = defaultClock) {}

    recordActivity() {
        this.startedAt ??= this.clock.now();
        if (this.idleTimer) this.clock.clearTimeout(this.idleTimer);
        this.idleTimer = this.clock.setTimeout(() => this.stop(), EDIT_IDLE_MS)
    }

    stop() {
        if (this.idleTimer) this.clock.clearTimeout(this.idleTimer);
        this.idleTimer = undefined;
        if (this.startedAt === undefined) return;
        let startedAt = this.startedAt, remainingMs = Math.max(1, Math.round(this.clock.now() - startedAt));
        this.startedAt = undefined;
        while (remainingMs > 0) {
            const durationMs = Math.min(remainingMs, MAX_EDIT_SEGMENT_MS);
            this.onSegment({id: newSegmentId(), startedAt: new Date(startedAt).toISOString(), durationMs});
            startedAt += durationMs;
            remainingMs -= durationMs
        }
    }

    activeDurationMs() {
        return this.startedAt === undefined ? 0 : Math.max(0, this.clock.now() - this.startedAt)
    }

    dispose() {
        this.stop()
    }
}

export function editTimeOutboxKey(projectId: string, userId: string) {
    return `matrix-edit-time:${projectId}:${userId}`
}

export function readEditTimeOutbox(key: string): EditTimeSegmentInput[] {
    try {
        const parsed = JSON.parse(localStorage.getItem(key) || "[]");
        return Array.isArray(parsed) ? parsed.filter(item => item && typeof item.id === "string" && Number.isInteger(item.durationMs)) : []
    } catch {
        return []
    }
}

export function appendEditTimeOutbox(key: string, segment: EditTimeSegmentInput) {
    const next = [...readEditTimeOutbox(key), segment];
    localStorage.setItem(key, JSON.stringify(next));
    return next
}

export function removeEditTimeOutbox(key: string, ids: string[]) {
    const removed = new Set(ids), next = readEditTimeOutbox(key).filter(item => !removed.has(item.id));
    if (next.length) localStorage.setItem(key, JSON.stringify(next)); else localStorage.removeItem(key);
    return next
}

export function formatEditDuration(durationMs: number) {
    const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
    const hours = Math.floor(totalSeconds / 3600), minutes = Math.floor(totalSeconds % 3600 / 60), seconds = totalSeconds % 60;
    return [hours, minutes, seconds].map(value => String(value).padStart(2, "0")).join(":")
}
