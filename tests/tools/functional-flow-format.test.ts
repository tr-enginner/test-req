import { describe, expect, test } from "bun:test"
import { formatFunctionalFlowItems } from "../../src/tools/functional-flow-format"

describe("formatFunctionalFlowItems", () => {
  test("renders a single flow without a letter label and with one full stop", () => {
    expect(formatFunctionalFlowItems(["A/D 参数"])).toEqual(["A/D 参数。"])
    expect(formatFunctionalFlowItems(["A/D 参数。"]))
      .toEqual(["A/D 参数。"])
  })

  test("renders multiple flows with labels, semicolons, and a final full stop", () => {
    expect(formatFunctionalFlowItems(["A/D 参数。", "速变遥测数据；", "缓变遥测数据"])).toEqual([
      "a. A/D 参数；",
      "b. 速变遥测数据；",
      "c. 缓变遥测数据。",
    ])
  })

  test("normalizes empty and no-flow values", () => {
    expect(formatFunctionalFlowItems([])).toEqual(["无。"])
    expect(formatFunctionalFlowItems(["无。"])).toEqual(["无。"])
  })
})
