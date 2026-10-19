import {describe, expect, test} from "bun:test"
import {assignStableRequirementIds} from "../src/shared/phase2-stable-ids"

describe("Phase 2 stable editor IDs", () => {
  test("preserves existing IDs and fills gaps after the highest sequence", () => {
    const rows = assignStableRequirementIds([{requirement_id: "TR-XN-001", text: "a"}, {text: "b"},
      {requirement_id: "TR-XN-004", text: "c"}, {text: "d"}], "TR-XN")
    expect(rows.map(row => row.requirement_id)).toEqual(["TR-XN-001", "TR-XN-005", "TR-XN-004", "TR-XN-006"])
  })

  test("repairs duplicates and foreign prefixes", () => {
    expect(assignStableRequirementIds([{requirement_id: "TR-XN-001"}, {requirement_id: "TR-XN-001"}], "TR-XN").map(row => row.requirement_id)).toEqual(["TR-XN-001", "TR-XN-002"])
    expect(assignStableRequirementIds([{requirement_id: "TR-AQ-001"}], "TR-XN", ["TR-XN-001"]).map(row => row.requirement_id)).toEqual(["TR-XN-002"])
  })
})
