import { describe, expect, test } from "bun:test"
import { createWikiSchedulerAgent } from "../src/agents/wiki-scheduler"
import { createWikiExecutorAgent } from "../src/agents/wiki-executor"

describe("phase 1b dispatch split", () => {
  test("wiki-scheduler reuses existing data-structures wiki on reruns", () => {
    const prompt = createWikiSchedulerAgent().prompt ?? ""
    expect(prompt).toContain("wiki_plan_builder(mode=\"build_plan\")")
    expect(prompt).toContain("wiki_execution_planner(mode=\"next_step\")")
    expect(prompt).toContain(".matrix/state/wiki-next-step.json")
    expect(prompt).toContain("If `wiki_execution_planner(mode=\"next_step\")` returns `data-structures`")
    expect(prompt).toContain(".matrix/wiki/data-structures.json")
    expect(prompt).toContain("Wait for completion, then immediately call `wiki_execution_planner(mode=\"next_step\")` again.")
  })

  test("wiki-scheduler schedules function-analysis one function at a time", () => {
    const prompt = createWikiSchedulerAgent().prompt ?? ""
    expect(prompt).toContain("wiki_mode=function-analysis")
    expect(prompt).toContain("one function at a time")
    expect(prompt).toContain("exactly one target function")
    expect(prompt).toContain("function_wiki_path=<path>")
    expect(prompt).toContain("function_file_path=<path>")
    expect(prompt).toContain("function_line_range=<start>-<end>")
    expect(prompt).toContain("function_return_type=<type>")
    expect(prompt).toContain("function_parameters=[{name,type},...]")
    expect(prompt).toContain("write exactly one function wiki artifact for it with parameters and return_value.")
    expect(prompt).toContain("Do NOT use nested paths such as `.matrix/wiki/functions/<module>/<callee>.json`.")
    expect(prompt).toContain("Do NOT use bare ID-only paths such as `.matrix/wiki/functions/FUNC-001.json`.")
  })

  test("wiki-scheduler reuses existing function wiki artifacts on reruns", () => {
    const prompt = createWikiSchedulerAgent().prompt ?? ""
    expect(prompt).toContain("first check whether `.matrix/wiki/functions/<function_name>.json` already exists")
    expect(prompt).toContain("is schema-valid with `parameters` plus `return_value`")
    expect(prompt).toContain("Treat only those complete artifacts as reusable output for scheduling purposes")
    expect(prompt).toContain("Dispatch wiki-executor again for older artifacts missing the interface contract")
    expect(prompt).toContain("scheduler-supplied `function_wiki_path` is already schema-valid")
    expect(prompt).toContain("artifact reuse on reruns")
  })

  test("wiki-scheduler continues dispatching code understanding when function wiki inventory is incomplete", () => {
    const prompt = createWikiSchedulerAgent().prompt ?? ""
    expect(prompt).toContain("authoritative function ledger")
    expect(prompt).toContain("Do NOT hand-write this file manually.")
    expect(prompt).toContain("Dispatch exactly one task per returned step.")
    expect(prompt).toContain("Do NOT proceed to module/global while `next_step` returns `function-analysis`.")
    expect(prompt).toContain("Never treat \"workflow demonstrated\" or \"enough examples generated\" as completion.")
    expect(prompt).toContain("returned compact `next_step`")
    expect(prompt).toContain("reconcile it one-by-one against both `.matrix/wiki/index.json -> function_index`")
    expect(prompt).toContain("payload.function_index")
    expect(prompt).toContain("call `software_analysis_artifacts(mode=\"finalize\")` before final inventory verification")
    expect(prompt).toContain("Only when `wiki_execution_planner(mode=\"next_step\")` returns `complete` may you report success.")
  })

  test("wiki global synthesis uses wiki_artifacts instead of hand-writing a huge index", () => {
    const builderPrompt = createWikiSchedulerAgent().prompt ?? ""
    const analyzerPrompt = createWikiExecutorAgent().prompt ?? ""

    expect(builderPrompt).toContain("call wiki_artifacts mode=finalize_index")
    expect(builderPrompt).toContain(".matrix/wiki/index-functions/chunk-*.json")

    expect(analyzerPrompt).toContain("Do NOT hand-write a huge `.matrix/wiki/index.json`")
    expect(analyzerPrompt).toContain("call `wiki_artifacts` with `mode=\"finalize_index\"`")
    expect(analyzerPrompt).toContain(".matrix/wiki/index-functions/chunk-*.json")
    expect(analyzerPrompt).toContain("existing wiki artifact schema drift is non-blocking")
    expect(analyzerPrompt).toContain("do NOT delete or regenerate those lower-layer artifacts")
    expect(Object.keys(createWikiExecutorAgent().tools || {})).toContain("wiki_artifacts")
  })

  test("wiki-executor function-analysis mode writes exactly one function wiki", () => {
    const prompt = createWikiExecutorAgent().prompt ?? ""
    expect(prompt).toContain("## Mode: function-analysis")
    expect(prompt).toContain("Analyze exactly one function")
    expect(prompt).toContain("Never plan or announce analysis for multiple functions in one `function-analysis` invocation.")
    expect(prompt).toContain("If `function_file_path` and `function_line_range` were provided by the scheduler")
    expect(prompt).toContain("Only use `grep` / search to rediscover the target function")
    expect(prompt).toContain("Write exactly one function wiki artifact for that function.")
    expect(prompt).toContain("You must NOT write any other function wiki in this mode.")
    expect(prompt).toContain("Do NOT write `.matrix/wiki/functions/<module>/<function>.json`.")
    expect(prompt).toContain("Do NOT write bare ID-only paths such as `.matrix/wiki/functions/FUNC-001.json`.")
    expect(prompt).toContain("The JSON must use the exact `FunctionWiki` schema field names")
    expect(prompt).toContain("`parameters`, `return_value`")
    expect(prompt).toContain("Do NOT invent alias keys such as `functionId`, `functionName`, `moduleName`")
  })

  test("wiki-executor skips rewriting existing data-structures wiki", () => {
    const prompt = createWikiExecutorAgent().prompt ?? ""
    expect(prompt).toContain("Call `wiki_data_structures_extract`")
    expect(prompt).toContain("`GlobalVar` global variables")
    expect(prompt).toContain("must not use a mixed `structures[]` list")
    expect(prompt).toContain("Do NOT hand-write `.matrix/wiki/data-structures.json`")
    expect(prompt).toContain("Do NOT add `description` to data structures or fields")
    expect(prompt).toContain("legacy artifacts containing data-structure `description` fields must be regenerated")
    expect(Object.keys(createWikiExecutorAgent().tools || {})).toContain("wiki_data_structures_extract")
  })

  test("wiki-executor skips rewriting existing function wiki artifacts", () => {
    const prompt = createWikiExecutorAgent().prompt ?? ""
    expect(prompt).toContain("check whether the scheduler-supplied `function_wiki_path` already exists")
    expect(prompt).toContain("existing artifact was reused")
    expect(prompt).toContain("If a complete schema-valid artifact already exists")
    expect(prompt).toContain("regenerate older artifacts missing `parameters` or `return_value`")
  })

  test("wiki-executor requires simplified function interface fields", () => {
    const prompt = createWikiExecutorAgent().prompt ?? ""
    expect(prompt).toContain("The `parameters` field must be an array of objects with only `name`, `type`, and `description`.")
    expect(prompt).toContain("The `return_value` field must be an object with only `type` and `description`.")
    expect(prompt).toContain("Do NOT add extra interface-contract fields such as `direction`, `unit`, `constraints`, `nullable`, `ownership`, `success_values`, or `error_values`.")
  })

  test("wiki-executor requires a single summary field instead of what/how/why/when", () => {
    const prompt = createWikiExecutorAgent().prompt ?? ""
    expect(prompt).toContain("summary: a single code-summary description paragraph")
    expect(prompt).toContain("Do NOT invent extra summary fields such as `what`, `how`, `why`, or `when`.")
    expect(prompt).toContain("use the schema's `summary` field only")
  })

  test("module synthesis uses concrete function wiki paths and requires reading them all", () => {
    const builderPrompt = createWikiSchedulerAgent().prompt ?? ""
    const analyzerPrompt = createWikiExecutorAgent().prompt ?? ""

    expect(builderPrompt).toContain("module_function_wiki_paths=[...")
    expect(builderPrompt).toContain("concrete repo-relative paths, not bare file names")
    expect(builderPrompt).toContain("If the function wiki list is long, read it in small batches")
    expect(builderPrompt).toContain("compact. You MUST use `repo_read` on `.matrix/state/wiki-next-step.json`")
    expect(builderPrompt).toContain("Use repo_read on .matrix/plans/wiki-generation-plan.json first.")
    expect(builderPrompt).toContain("Do NOT use nested paths such as `.matrix/wiki/functions/<module>/f1.json`.")
    expect(builderPrompt).toContain("Do NOT use bare ID-only paths such as `.matrix/wiki/functions/FUNC-001.json`.")

    expect(analyzerPrompt).toContain("module_function_wiki_paths")
    expect(analyzerPrompt).toContain("Do not replace them with guessed file names.")
    expect(analyzerPrompt).toContain("Do NOT introduce module/function subdirectories.")
    expect(analyzerPrompt).toContain("Those function wiki paths are concrete scheduler-supplied flat files under `.matrix/wiki/functions/`.")
    expect(analyzerPrompt).toContain("Do not stop after reading only the first few files.")
    expect(analyzerPrompt).toContain("Continue reading until all listed paths have been loaded")
  })

  test("data-structures mode avoids idling after the first read", () => {
    const builderPrompt = createWikiSchedulerAgent().prompt ?? ""
    const analyzerPrompt = createWikiExecutorAgent().prompt ?? ""

    expect(builderPrompt).toContain("Call wiki_data_structures_extract")
    expect(builderPrompt).toContain("GlobalVar global variables")
    expect(builderPrompt).toContain("not a mixed structures[] list")
    expect(builderPrompt).toContain("Do not hand-write the JSON")
    expect(builderPrompt).toContain("use the scheduler-supplied source path / line range directly")
    expect(builderPrompt).toContain("start with a narrow read around the supplied `function_line_range`")
    expect(builderPrompt).toContain("description fields")

    expect(analyzerPrompt).toContain("Tool execution must be tight and continuous")
    expect(analyzerPrompt).toContain("Do not stop after a `repo_read`, `glob`, or `grep` call")
    expect(analyzerPrompt).toContain("Use `repo_read` for repository files and wiki artifacts.")
    expect(analyzerPrompt).toContain("Issue tool calls strictly one at a time.")
    expect(analyzerPrompt).toContain('If a tool returns "Tool execution aborted", retry at most once')
    expect(analyzerPrompt).toContain("Prefer narrow `repo_read` calls over large scans.")
    expect(analyzerPrompt).toContain("Avoid oversized reads such as broad 200+ line windows")
    expect(analyzerPrompt).toContain("move to the next required tool call immediately")
    expect(analyzerPrompt).toContain("Call `wiki_data_structures_extract`")
    expect(analyzerPrompt).toContain("Do NOT hand-write `.matrix/wiki/data-structures.json`")
  })

  test("function-analysis handles missing callee wiki with cycle-exemption instead of falling back to raw source search", () => {
    const builderPrompt = createWikiSchedulerAgent().prompt ?? ""
    const analyzerPrompt = createWikiExecutorAgent().prompt ?? ""

    expect(builderPrompt).toContain("same detected function cycle or module cycle")
    expect(builderPrompt).toContain("never ask wiki-executor to compensate by reading the callee's raw source")

    expect(analyzerPrompt).toContain("If any path in `required_callee_wiki_paths` does not exist")
    expect(analyzerPrompt).toContain("detected cycle")
    expect(analyzerPrompt).toContain("function-level or module-level")
    expect(analyzerPrompt).toContain("Never search raw source for a callee whose wiki artifact is listed in `required_callee_wiki_paths` but missing, unless the hook or scheduler explicitly told you")
  })

  test("wiki agents can rely on hook-preloaded dependency context instead of redundant reads", () => {
    const builderPrompt = createWikiSchedulerAgent().prompt ?? ""
    const analyzerPrompt = createWikiExecutorAgent().prompt ?? ""

    expect(builderPrompt).toContain("hook-preloaded dependency wiki context counts as already loaded")
    expect(builderPrompt).toContain("If the hook already preloaded those callee wiki files into context, do not re-read them.")

    expect(analyzerPrompt).toContain("If the hook already preloaded lower-layer wiki context into this turn")
    expect(analyzerPrompt).toContain("Use the hook-preloaded dependency context when available; otherwise use `repo_read`.")
  })

  test("wiki agents treat code-wiki skill as optional fallback instead of mandatory first step", () => {
    const builderPrompt = createWikiSchedulerAgent().prompt ?? ""
    const analyzerPrompt = createWikiExecutorAgent().prompt ?? ""

    expect(builderPrompt).toContain("Use the `skill` tool to load `code-wiki` only when extra planning guidance is genuinely needed.")
    expect(builderPrompt).toContain("Do NOT reload the skill on every invocation by default.")
    expect(builderPrompt).toContain("If the `skill code-wiki` tool call aborts or stalls, continue with this prompt's built-in rules")

    expect(analyzerPrompt).toContain("Use the `skill` tool to load `code-wiki` only when you genuinely need extra checklist detail")
    expect(analyzerPrompt).toContain("Do NOT reload the skill on every invocation by default.")
    expect(analyzerPrompt).toContain("If the `skill code-wiki` tool call aborts or stalls, continue with this prompt's built-in rules")
  })
})
