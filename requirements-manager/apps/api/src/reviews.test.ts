import {describe, expect, it} from "vitest";
import {calculateReviewScore} from "./reviews.js";

describe("calculateReviewScore", () => {
    it("uses the 40/35/25 content-quality weights", () => {
        expect(calculateReviewScore({correctness: 5, coverage: 4, testability: 3})).toBeCloseTo(4.15)
    })
});
