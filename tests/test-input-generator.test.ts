import { describe, expect, test } from "bun:test"
import { generateInputDatasetFile } from "../src/shared/input-dataset-generator"
import type { ProtocolSummary } from "../src/shared/protocol-parser"

describe("input dataset generator", () => {
  test("generates a stable normal dataset from protocol summary", () => {
    const protocol: ProtocolSummary = {
      protocol_name: "间接指令",
      format: "CANA",
      source_file: "/tmp/间接指令.docx",
      items: [
        {
          name: "执行时间",
          title: "执行时间",
          desc: "默认值为5",
          default_value: "5",
          enum_values: [],
          aliases: ["time"],
        },
        {
          name: "协议名称",
          title: "协议名称",
          desc: "协议名称",
          enum_values: [],
          aliases: ["protocol_name"],
        },
        {
          name: "状态值",
          title: "状态值",
          desc: "取值范围：0x01-0x05",
          range: "0x01-0x05",
          enum_values: ["0x01", "0x05"],
          aliases: ["expected_value"],
        },
      ],
    }

    const generated = generateInputDatasetFile(protocol, { inputFlow: "间接指令" })

    expect(generated.datasetFile.datasets[0]?.dataset_id).toBe("normal-01")
    expect(generated.datasetFile.datasets[0]?.fields["执行时间"]).toBe("5")
    expect(generated.datasetFile.datasets[0]?.semantics.protocol_name).toBe("间接指令")
    expect(generated.datasetFile.datasets[0]?.semantics.expected_value).toBe("0x01")
  })
})
