import {describe, expect, it} from "vitest";
import {reorderTableIds, uniqueTableIds} from "./tableOrder";

describe("table ordering", () => {
    it("moves items forward and backward", () => {
        expect(reorderTableIds(["a", "b", "c"], "a", "c")).toEqual(["b", "c", "a"]);
        expect(reorderTableIds(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"])
    });

    it("moves items between the first and last positions", () => {
        expect(reorderTableIds(["a", "b", "c", "d"], "b", "d")).toEqual(["a", "c", "d", "b"]);
        expect(reorderTableIds(["a", "b", "c", "d"], "d", "b")).toEqual(["a", "d", "b", "c"])
    });

    it("keeps the order for the same or an unknown target", () => {
        expect(reorderTableIds(["a", "b"], "a", "a")).toEqual(["a", "b"]);
        expect(reorderTableIds(["a", "b"], "a", "missing")).toEqual(["a", "b"])
    });

    it("deduplicates ids while preserving first occurrence order", () => {
        expect(uniqueTableIds(["a", "b", "a", "c", "b"])).toEqual(["a", "b", "c"]);
        expect(reorderTableIds(["a", "b", "a", "c"], "a", "c")).toEqual(["b", "c", "a"])
    })
});
