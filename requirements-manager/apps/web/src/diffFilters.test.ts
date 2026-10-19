import {describe, expect, it} from "vitest";
import type {RequirementChange} from "./api";
import {changeMatchesKind, diffFacetSummary} from "./diffFilters";

const change = (value: Partial<RequirementChange>): RequirementChange => ({entityUid: "uid", type: "MODIFIED", ...value});


describe("requirement diff facet filters", () => {
    it("includes mixed content changes in the traceability facet", () => {
        const mixed = change({changedFields: ["content.description", "sourceRefs"]});
        expect(changeMatchesKind(mixed, "TRACE_CHANGED")).toBe(true);
        expect(changeMatchesKind(mixed, "MODIFIED")).toBe(true)
    });

    it("does not report ordinary content edits as traceability changes", () => {
        expect(changeMatchesKind(change({changedFields: ["content.description"]}), "TRACE_CHANGED")).toBe(false)
    });

    it("counts traceability as a facet independently from the primary type", () => {
        expect(diffFacetSummary([change({changedFields: ["source_refs"]})], {MODIFIED: 1}).TRACE_CHANGED).toBe(1)
    })
});
