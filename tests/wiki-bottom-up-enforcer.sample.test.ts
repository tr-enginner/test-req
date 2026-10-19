import { describe, expect, test } from "bun:test"
import { cpSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { loadPluginConfig } from "../src/plugin-config"
import { createHooks } from "../src/create-hooks"
import { createPluginInterface } from "../src/plugin-interface"
import { resolveSkillsDir } from "../src/create-skills"

const SAMPLE_PROJECT = join(import.meta.dir, "sample-8051-project")
const MINIMAL_PROJECT = join(import.meta.dir, "minimal-c-project")

function makeProjectCopy() {
  const root = mkdtempSync(join(tmpdir(), "matrix-wiki-guard-sample-"))
  cpSync(SAMPLE_PROJECT, root, { recursive: true })
  return root
}

function makePlugin(projectDir: string) {
  const pluginConfig = loadPluginConfig(projectDir)
  const hooks = createHooks(projectDir, pluginConfig)
  return createPluginInterface({
    directory: projectDir,
    pluginConfig,
    hooks,
    tools: {},
    skillsDir: resolveSkillsDir(),
  })
}

function makeMinimalFunctionProject() {
  const root = mkdtempSync(join(tmpdir(), "matrix-wiki-guard-minimal-"))
  cpSync(MINIMAL_PROJECT, root, { recursive: true })
  mkdirSync(join(root, ".matrix", "data"), { recursive: true })
  writeFileSync(
    join(root, ".matrix", "data", "software-analysis.json"),
    JSON.stringify(
      {
        project_name: "minimal-filter",
        created_date: "2026-03-13",
        functions: [
          { id: "FUNC-001", name: "filter_init", calls: [] },
          { id: "FUNC-002", name: "filter_update", calls: ["filter_init"] },
          { id: "FUNC-003", name: "main", calls: ["filter_init", "filter_update"] },
        ],
        modules: [
          {
            name: "temp_monitor",
            functions: ["filter_init", "filter_update", "main"],
          },
        ],
      },
      null,
      2,
    ),
    "utf-8",
  )
  return root
}

function makeLegacyFunctionProject() {
  const root = mkdtempSync(join(tmpdir(), "matrix-wiki-guard-legacy-"))
  cpSync(MINIMAL_PROJECT, root, { recursive: true })
  mkdirSync(join(root, ".matrix", "data"), { recursive: true })
  writeFileSync(
    join(root, ".matrix", "data", "software-analysis.json"),
    JSON.stringify(
      {
        project_name: "minimal-filter-legacy",
        created_date: "2026-03-13",
        functions: [
          {
            id: "FUNC-001",
            name: "filter_init",
            file_path: "temp_monitor.c",
            calls: [],
          },
          {
            id: "FUNC-002",
            name: "filter_update",
            file_path: "temp_monitor.c",
            calls: ["filter_init"],
          },
          {
            id: "FUNC-003",
            name: "main",
            file_path: "temp_monitor.c",
            calls: ["filter_init", "filter_update"],
          },
        ],
      },
      null,
      2,
    ),
    "utf-8",
  )
  return root
}

async function emitRead(plugin: ReturnType<typeof createPluginInterface>, sessionID: string, path: string) {
  const output = { title: "read", output: `Read ${path}`, metadata: {} as Record<string, unknown> }
  await plugin["tool.execute.after"]?.({ tool: "read", sessionID }, output)
  return output
}

async function emitRepoRead(plugin: ReturnType<typeof createPluginInterface>, sessionID: string, path: string) {
  const output = { title: "repo_read", output: `Path: ${path}`, metadata: {} as Record<string, unknown> }
  await plugin["tool.execute.after"]?.({ tool: "repo_read", sessionID }, output)
  return output
}

async function emitAgentTurn(
  plugin: ReturnType<typeof createPluginInterface>,
  sessionID: string,
  agent: string,
) {
  const output = { message: null, parts: [] as Array<Record<string, unknown>> }
  await plugin["chat.message"]?.({ sessionID, agent }, output)
  return output
}

async function emitWrite(plugin: ReturnType<typeof createPluginInterface>, sessionID: string, path: string) {
  const output = { title: "write", output: `Saved to ${path}`, metadata: {} as Record<string, unknown> }
  await plugin["tool.execute.after"]?.({ tool: "write", sessionID }, output)
  return output
}

describe("wiki bottom-up guard sample project smoke", () => {
  test("blocks upper-layer module write when lower-layer artifacts do not exist yet", async () => {
    const projectDir = makeProjectCopy()
    try {
      const wikiDir = join(projectDir, ".matrix", "wiki")
      if (existsSync(wikiDir)) {
        rmSync(wikiDir, { recursive: true, force: true })
      }

      const plugin = makePlugin(projectDir)
      const result = await emitWrite(plugin, "sample-missing-artifacts", ".matrix/wiki/modules/main.json")

      expect(result.output).toContain("[BOTTOM-UP GUARD]")
      expect(result.output).toContain("Topological order violation")
      expect(result.output).toContain(".matrix/wiki/modules/power_control.json")
      expect(result.output).toContain(".matrix/wiki/modules/telemetry.json")
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  test("blocks upper-layer module and function writes until dependency wiki was read in the current session", async () => {
    const projectDir = makeProjectCopy()
    try {
      const plugin = makePlugin(projectDir)

      const moduleResult = await emitWrite(plugin, "sample-no-read", ".matrix/wiki/modules/main.json")
      expect(moduleResult.output).toContain("[BOTTOM-UP GUARD]")
      expect(moduleResult.output).toContain("did not use read to load their wiki files")

      const functionResult = await emitWrite(plugin, "sample-no-read-func", ".matrix/wiki/functions/main.json")
      expect(functionResult.output).toContain("[BOTTOM-UP GUARD]")
      expect(functionResult.output).toContain("lower-layer callee context")
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  test("allows upper-layer writes after the session read lower-layer wiki context", async () => {
    const projectDir = makeProjectCopy()
    try {
      const plugin = makePlugin(projectDir)
      const sessionID = "sample-with-read"

      await emitRead(plugin, sessionID, ".matrix/wiki/modules/power_control.json")
      await emitRead(plugin, sessionID, ".matrix/wiki/modules/telemetry.json")

      const moduleResult = await emitWrite(plugin, sessionID, ".matrix/wiki/modules/main.json")
      expect(moduleResult.output).not.toContain("[BOTTOM-UP GUARD]")

      await emitRead(plugin, sessionID, ".matrix/wiki/functions/power_init.json")
      await emitRead(plugin, sessionID, ".matrix/wiki/functions/telemetry_init.json")
      await emitRead(plugin, sessionID, ".matrix/wiki/functions/telecommand_register.json")
      await emitRead(plugin, sessionID, ".matrix/wiki/functions/load_switch_set.json")
      await emitRead(plugin, sessionID, ".matrix/wiki/functions/adc_scan_all.json")
      await emitRead(plugin, sessionID, ".matrix/wiki/functions/adc_calibrate.json")
      await emitRead(plugin, sessionID, ".matrix/wiki/functions/fault_detect.json")
      await emitRead(plugin, sessionID, ".matrix/wiki/functions/battery_manage.json")
      await emitRead(plugin, sessionID, ".matrix/wiki/functions/bus_protect.json")
      await emitRead(plugin, sessionID, ".matrix/wiki/functions/load_switch_check.json")
      await emitRead(plugin, sessionID, ".matrix/wiki/functions/mppt_update.json")
      await emitRead(plugin, sessionID, ".matrix/wiki/functions/build_telemetry.json")
      await emitRead(plugin, sessionID, ".matrix/wiki/functions/telemetry_send.json")
      await emitRead(plugin, sessionID, ".matrix/wiki/functions/telecommand_process.json")

      const functionResult = await emitWrite(plugin, sessionID, ".matrix/wiki/functions/main.json")
      expect(functionResult.output).not.toContain("[BOTTOM-UP GUARD]")
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  test("blocks same-module caller function writes until callee function wiki was read", async () => {
    const projectDir = makeMinimalFunctionProject()
    try {
      const plugin = makePlugin(projectDir)
      const sessionID = "same-module-no-read"

      const missingArtifact = await emitWrite(plugin, sessionID, ".matrix/wiki/functions/filter_update.json")
      expect(missingArtifact.output).toContain("[BOTTOM-UP GUARD]")
      expect(missingArtifact.output).toContain(".matrix/wiki/functions/filter_init.json")

      mkdirSync(join(projectDir, ".matrix", "wiki", "functions"), { recursive: true })
      writeFileSync(join(projectDir, ".matrix", "wiki", "functions", "filter_init.json"), "{}", "utf-8")

      const missingRead = await emitWrite(plugin, sessionID, ".matrix/wiki/functions/filter_update.json")
      expect(missingRead.output).toContain("[BOTTOM-UP GUARD]")
      expect(missingRead.output).toContain("filter_init")

      await emitRead(plugin, sessionID, ".matrix/wiki/functions/filter_init.json")
      const allowed = await emitWrite(plugin, sessionID, ".matrix/wiki/functions/filter_update.json")
      expect(allowed.output).not.toContain("[BOTTOM-UP GUARD]")
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  test("enforces same-module function reads for legacy software-analysis without modules", async () => {
    const projectDir = makeLegacyFunctionProject()
    try {
      const plugin = makePlugin(projectDir)
      const sessionID = "legacy-no-modules"

      mkdirSync(join(projectDir, ".matrix", "wiki", "functions"), { recursive: true })
      writeFileSync(join(projectDir, ".matrix", "wiki", "functions", "filter_init.json"), "{}", "utf-8")

      const missingRead = await emitWrite(plugin, sessionID, ".matrix/wiki/functions/filter_update.json")
      expect(missingRead.output).toContain("[BOTTOM-UP GUARD]")
      expect(missingRead.output).toContain("filter_init")

      await emitRead(plugin, sessionID, ".matrix/wiki/functions/filter_init.json")
      const allowed = await emitWrite(plugin, sessionID, ".matrix/wiki/functions/filter_update.json")
      expect(allowed.output).not.toContain("[BOTTOM-UP GUARD]")
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  test("blocks name-based upper-layer function writes until lower-layer name-based wiki files were read", async () => {
    const projectDir = makeLegacyFunctionProject()
    try {
      const plugin = makePlugin(projectDir)
      const sessionID = "legacy-name-based"

      mkdirSync(join(projectDir, ".matrix", "wiki", "functions"), { recursive: true })
      writeFileSync(join(projectDir, ".matrix", "wiki", "functions", "filter_init.json"), "{}", "utf-8")
      writeFileSync(join(projectDir, ".matrix", "wiki", "functions", "filter_update.json"), "{}", "utf-8")

      const missingRead = await emitWrite(plugin, sessionID, ".matrix/wiki/functions/main.json")
      expect(missingRead.output).toContain("[BOTTOM-UP GUARD]")
      expect(missingRead.output).toContain("filter_init")
      expect(missingRead.output).toContain("filter_update")

      await emitRead(plugin, sessionID, ".matrix/wiki/functions/filter_init.json")
      await emitRead(plugin, sessionID, ".matrix/wiki/functions/filter_update.json")

      const allowed = await emitWrite(plugin, sessionID, ".matrix/wiki/functions/main.json")
      expect(allowed.output).not.toContain("[BOTTOM-UP GUARD]")
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  test("requires callee wiki to be re-read for each new wiki-executor turn", async () => {
    const projectDir = makeLegacyFunctionProject()
    try {
      const plugin = makePlugin(projectDir)
      const sessionID = "legacy-reset-turn"

      mkdirSync(join(projectDir, ".matrix", "wiki", "functions"), { recursive: true })
      writeFileSync(join(projectDir, ".matrix", "wiki", "functions", "filter_init.json"), "{}", "utf-8")

      await emitAgentTurn(plugin, sessionID, "wiki-executor")
      await emitRead(plugin, sessionID, ".matrix/wiki/functions/filter_init.json")
      const firstAllowed = await emitWrite(plugin, sessionID, ".matrix/wiki/functions/filter_update.json")
      expect(firstAllowed.output).not.toContain("[BOTTOM-UP GUARD]")

      await emitAgentTurn(plugin, sessionID, "wiki-executor")
      const missingRead = await emitWrite(plugin, sessionID, ".matrix/wiki/functions/filter_update.json")
      expect(missingRead.output).toContain("[BOTTOM-UP GUARD]")
      expect(missingRead.output).toContain("filter_init")
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  test("accepts repo_read as dependency loading for bottom-up enforcement", async () => {
    const projectDir = makeLegacyFunctionProject()
    try {
      const plugin = makePlugin(projectDir)
      const sessionID = "legacy-repo-read"

      mkdirSync(join(projectDir, ".matrix", "wiki", "functions"), { recursive: true })
      writeFileSync(join(projectDir, ".matrix", "wiki", "functions", "filter_init.json"), "{}", "utf-8")

      await emitRepoRead(plugin, sessionID, ".matrix/wiki/functions/filter_init.json")
      const allowed = await emitWrite(plugin, sessionID, ".matrix/wiki/functions/filter_update.json")
      expect(allowed.output).not.toContain("[BOTTOM-UP GUARD]")
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  test("auto-preloads referenced callee wiki context for wiki-executor turns", async () => {
    const projectDir = makeLegacyFunctionProject()
    try {
      const plugin = makePlugin(projectDir)
      const sessionID = "legacy-autopreload"

      mkdirSync(join(projectDir, ".matrix", "wiki", "functions"), { recursive: true })
      writeFileSync(join(projectDir, ".matrix", "wiki", "functions", "filter_init.json"), JSON.stringify({
        id: "FUNC-001",
        name: "filter_init",
        file_path: "temp_monitor.c",
        line_range: { start: 1, end: 10 },
        module_id: "temp_monitor",
        signature: "void filter_init(void)",
        summary: "Initializes the filter state.",
        algorithm: "Reset internal state.",
        preconditions: [],
        postconditions: [],
        boundary_conditions: [],
        error_handling: [],
        control_flow: [],
        side_effects: [],
        concurrency: [],
        requirement_fulfillment: [],
        testing_hints: [],
      }), "utf-8")

      const turnOutput = {
        message: null,
        parts: [
          {
            type: "text",
            text: "wiki_mode=function-analysis function_name=filter_update required_callee_wiki_paths=[.matrix/wiki/functions/filter_init.json]",
          },
        ],
      }
      await plugin["chat.message"]?.(
        { sessionID, agent: "wiki-executor" },
        turnOutput,
      )

      const joinedParts = turnOutput.parts
        .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
        .join("\n")
      expect(joinedParts).toContain("The hook auto-loaded dependency wiki context for this turn.")
      expect(joinedParts).toContain("Preloaded Function Wiki: filter_init")

      const allowed = await emitWrite(plugin, sessionID, ".matrix/wiki/functions/filter_update.json")
      expect(allowed.output).not.toContain("[BOTTOM-UP GUARD]")
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  test("blocks nested function wiki paths under module subdirectories", async () => {
    const projectDir = makeProjectCopy()
    try {
      const plugin = makePlugin(projectDir)
      const sessionID = "sample-module-scoped"

      await emitAgentTurn(plugin, sessionID, "wiki-executor")
      const blocked = await emitWrite(
        plugin,
        sessionID,
        ".matrix/wiki/functions/power_control/battery_manage.json",
      )
      expect(blocked.output).toContain("[BOTTOM-UP GUARD]")
      expect(blocked.output).toContain("must be written directly under .matrix/wiki/functions/")
      expect(blocked.output).toContain(".matrix/wiki/functions/<module>/<function>.json")
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  test("blocks function wiki paths that use function IDs instead of function names", async () => {
    const projectDir = makeLegacyFunctionProject()
    try {
      const plugin = makePlugin(projectDir)
      const sessionID = "legacy-id-based"

      const blocked = await emitWrite(plugin, sessionID, ".matrix/wiki/functions/FUNC-002.json")
      expect(blocked.output).toContain("[BOTTOM-UP GUARD]")
      expect(blocked.output).toContain(".matrix/wiki/functions/filter_update.json")
      expect(blocked.output).toContain(".matrix/wiki/functions/FUNC-002.json")
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })
})
