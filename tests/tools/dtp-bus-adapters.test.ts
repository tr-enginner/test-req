import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  createDtpModelFallbackProfileRegistry,
  classifyDtpBusInterface,
  detectDtpBusType,
  dtpBusSelectorValuesEquivalent,
  listDtpBusAdapters,
  resolveDtpBusAdapter,
  resolveDtpBusFlowConstraint,
  selectDtpModelFallbackPolicy,
} from "../../src/tools/dtp-bus-adapters"

describe("DTP BusAdapters", () => {
  test("registers deterministic adapters and selects their built-in fallback policies", () => {
    const registry = createDtpModelFallbackProfileRegistry()
    const ids = listDtpBusAdapters().map((adapter) => adapter.id)

    expect(ids).toEqual(["can", "spi", "spacewire", "rs422", "uart", "1553b", "generic"])
    expect(resolveDtpBusAdapter("CANA").id).toBe("can")
    expect(resolveDtpBusAdapter("SPI").id).toBe("spi")
    expect(resolveDtpBusAdapter("Space Wire").id).toBe("spacewire")
    expect(resolveDtpBusAdapter("1553B").id).toBe("1553b")

    const primary = selectDtpModelFallbackPolicy(registry, {
      bus_type: "CAN",
      interface_level: "primary",
      protocol_family: "command",
      flow_direction: "input",
    })
    expect(primary.profile_id).toBe("primary-can")
    expect(primary.profile_version).toBe("2.0.0")
    expect(primary.instructions.join("\n")).toContain("一级 CAN")
    expect(selectDtpModelFallbackPolicy(registry, {
      bus_type: "CAN",
      interface_level: "secondary",
      protocol_family: "telemetry",
      flow_direction: "output",
    }).profile_id).toBe("secondary-can")
    expect(selectDtpModelFallbackPolicy(registry, {
      bus_type: "SPI",
      interface_level: "unknown",
      protocol_family: "command",
      flow_direction: "input",
    }).profile_id).toBe("spi")
  })

  test("detects bus types and classifies CAN interface evidence through adapters", () => {
    expect(detectDtpBusType("通过二级CAN总线发送遥测数据")).toBe("CAN")
    expect(detectDtpBusType("通过 SPI 接口发送机构控制指令")).toBe("SPI")
    expect(detectDtpBusType("写入 SpaceWire 管控程序上注起始块")).toBe("SpaceWire")
    expect(detectDtpBusType("通过RS-422串行链路发送")).toBe("RS422")
    expect(classifyDtpBusInterface("CAN", "IF-CAN1-003 二级 CAN")).toEqual({
      level: "secondary",
      interfaceId: "IF-CAN1-003",
      source: "interface_id",
    })
    expect(classifyDtpBusInterface("CAN", "通过CANA总线发送")).toEqual({
      level: "primary",
      source: "legacy_channel_alias",
      matchedAlias: "CANA",
    })
    expect(resolveDtpBusFlowConstraint("SPI", "通过SPI发送输出流中的遥测数据")).toEqual({
      handled: true,
      flow: "output",
    })
    expect(resolveDtpBusFlowConstraint("CAN", "通过CANA发送数据")).toEqual({ handled: false })
    expect(dtpBusSelectorValuesEquivalent("SPI", {
      relation: {
        relation_id: "spi-station",
        selector_name: "站地址",
        selector_aliases: [],
        selector_type: "uint8",
        mappings: [],
        evidence_ids: [],
        warnings: [],
        bus_type: "SPI",
      },
      selectorValue: "21",
      mappingValue: "20",
    })).toBe(true)
  })

  test("keeps the selected policy identity stable when unrelated adapters change the registry", () => {
    const registry = createDtpModelFallbackProfileRegistry()
    const classification = {
      bus_type: "CAN" as const,
      interface_level: "primary" as const,
      protocol_family: "command" as const,
      flow_direction: "input" as const,
    }
    const original = selectDtpModelFallbackPolicy(registry, classification)
    const changedRegistry = { ...registry, registry_hash: "unrelated-adapter-change" }
    const afterUnrelatedChange = selectDtpModelFallbackPolicy(changedRegistry, classification)

    expect(afterUnrelatedChange.registry_hash).not.toBe(original.registry_hash)
    expect(afterUnrelatedChange.profile_hash).toBe(original.profile_hash)
    expect(afterUnrelatedChange.profile_id).toBe(original.profile_id)
  })

  test("does not create or read a project-level fallback profile JSONC file", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "dtp-adapter-policies-"))
    const configDir = join(workspaceRoot, ".matrix", "config")
    const configPath = join(configDir, "dtp-model-fallback-profiles.jsonc")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(configPath, `{
      "profiles": [{
        "id": "secondary-can",
        "version": "999.0.0",
        "context_budget_chars": 30000
      }]
    }`, "utf-8")

    const registry = createDtpModelFallbackProfileRegistry()
    const selected = selectDtpModelFallbackPolicy(registry, {
      bus_type: "CAN",
      interface_level: "secondary",
      protocol_family: "command",
      flow_direction: "input",
    })

    expect(existsSync(configPath)).toBe(true)
    expect(registry.config_path).toBe("builtin://dtp-bus-adapters")
    expect(registry.source).toBe("builtin")
    expect(registry.warnings).toEqual([])
    expect(selected.profile_version).toBe("2.0.0")
    expect(selected.context_budget_chars).toBe(14_000)
  })

  test("does not create a configuration directory when no project override exists", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "dtp-adapter-no-config-"))
    createDtpModelFallbackProfileRegistry()
    expect(existsSync(join(workspaceRoot, ".matrix", "config", "dtp-model-fallback-profiles.jsonc"))).toBe(false)
  })
})
