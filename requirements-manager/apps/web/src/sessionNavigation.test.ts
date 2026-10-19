import {describe, expect, it} from "vitest";
import {safeReturnTo} from "./sessionNavigation";

describe("safeReturnTo", () => {
    it("keeps internal project routes including query and hash", () => {
        expect(safeReturnTo("/projects/p1/review?tab=trace#TR-001")).toBe("/projects/p1/review?tab=trace#TR-001")
    });

    it("falls back for login, external, protocol-relative, and non-string values", () => {
        for (const value of ["/login", "/login?next=/projects/p1", "https://example.com", "//example.com", null]) {
            expect(safeReturnTo(value)).toBe("/")
        }
    })
});
