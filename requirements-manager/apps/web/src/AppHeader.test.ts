import {describe, expect, it} from "vitest";
import {settingsTabsForRole} from "./AppHeader";

describe("app header settings", () => {
    it("shows account and system settings to administrators", () => {
        expect(settingsTabsForRole("ADMIN")).toEqual(["password", "users", "opencode"])
    });

    it("shows only password settings to non-administrators", () => {
        expect(settingsTabsForRole("REVIEWER")).toEqual(["password"]);
        expect(settingsTabsForRole("VIEWER")).toEqual(["password"])
    })
});
