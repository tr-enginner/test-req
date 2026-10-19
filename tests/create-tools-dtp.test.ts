import { describe, expect, test } from "bun:test"
import type { OpencodeClient } from "@opencode-ai/sdk/client"
import type { MatrixConfig } from "../src/config/schema"
import { createTools } from "../src/create-tools"

describe("DTP tool registration", () => {
  test("exposes case-level generation without the retired project-level materializer", () => {
    const tools = createTools(
      { disabled_tools: [] } as unknown as MatrixConfig,
      {} as OpencodeClient,
    )

    expect(tools.dtp_test_data_generate).toBeDefined()
    expect(tools.dtp_robot_generate).toBeDefined()
    expect(tools.dtp_project_data_files_generate).toBeUndefined()
  })
})
