import {describe, expect, it} from "vitest";
import {requirementScrollTop} from "./requirementNavigation";

describe("requirementScrollTop", () => {
    it("calculates the target relative to the requirement document pane", () => {
        expect(requirementScrollTop({
            currentScrollTop: 600,
            containerTop: 100,
            targetTop: 420,
            scrollHeight: 4000,
            clientHeight: 900
        })).toBe(900)
    });

    it("clamps navigation at the beginning and end of the document", () => {
        expect(requirementScrollTop({
            currentScrollTop: 10,
            containerTop: 100,
            targetTop: 50,
            scrollHeight: 4000,
            clientHeight: 900
        })).toBe(0);
        expect(requirementScrollTop({
            currentScrollTop: 2800,
            containerTop: 100,
            targetTop: 1000,
            scrollHeight: 4000,
            clientHeight: 900
        })).toBe(3100)
    });

    it("supports an explicit top offset", () => {
        expect(requirementScrollTop({
            currentScrollTop: 200,
            containerTop: 80,
            targetTop: 300,
            scrollHeight: 2000,
            clientHeight: 500,
            offset: 40
        })).toBe(380)
    })
});
