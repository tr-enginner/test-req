# Static Analysis Auto-Repair Disabled by Default — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Change StaticAnalyzer to run in analysis-only mode by default. Auto-repair steps (`repair_all` / `verify`) are skipped unless `static_repair_enabled: true` is set in `.matrix/config/matrix.jsonc`.

**Architecture:** Add a boolean config field; inject a `<repair_directive>` block into the StaticAnalyzer system prompt at agent creation time (same pattern as `<language_directive>`). Update Conductor Phase 3 dispatch prompt to remove repair instructions. Update skill documentation to reflect the new default.

**Tech Stack:** TypeScript (Bun), Zod schemas, OpenCode plugin SDK.

**Design doc:** `docs/plans/2026-02-25-static-repair-disabled-design.md`

---

### Task 1: Add `static_repair_enabled` to Config Schema

**Files:**
- Modify: `src/config/schema.ts` (MatrixConfigSchema object)

**Step 1: Add the config field**

In `src/config/schema.ts`, after the `specchecker_ruleset` field, add:

```typescript
  /** Enable auto-repair generation in static analysis (default: false — analysis only) */
  static_repair_enabled: z.boolean().default(false),
```

**Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS (new optional field with default is backward-compatible)

**Step 3: Commit**

```bash
git add src/config/schema.ts
git commit -m "feat(config): add static_repair_enabled option (default: false)"
```

---

### Task 2: Add Repair-Disabled Directive to builtin-agents.ts

**Files:**
- Modify: `src/agents/builtin-agents.ts` (`createBuiltinAgents` function)

**Step 1: Add `buildRepairDisabledDirective()` function**

Before `createBuiltinAgents`, add:

```typescript
/**
 * Repair-disabled directive appended to the static-analyzer prompt when
 * static_repair_enabled is false (the default). Skips Steps 3 & 4 (repair /
 * verify) and adjusts classification and report sections accordingly.
 */
function buildRepairDisabledDirective(): string {
  return `

<repair_directive>
Auto-repair is DISABLED for this session. Follow the modified workflow below:
- SKIP Step 3 (Batch Repair — do NOT invoke specchecker with mode "repair_all").
- SKIP Step 4 (Verify Repairs — do NOT invoke specchecker with mode "verify").
- In Step 5, use only three dispositions: "must-fix", "suggestion", or "waiver". Do NOT use "auto-fixed".
- In Step 6, write defects.json as usual but do NOT create repair-plan.json.
- In Step 7, omit the "Auto-repair results" section from the markdown report; instead note that repair was not performed in this run.
</repair_directive>`
}
```

**Step 2: Update `createBuiltinAgents` signature and body**

Change the function signature from:

```typescript
export function createBuiltinAgents(
  disabledAgents: string[] = [],
  model?: string,
  outputLanguage?: string,
): Record<string, AgentConfig> {
  const agents: Record<string, AgentConfig> = {}
  const langDirective = outputLanguage ? buildLanguageDirective(outputLanguage) : ""

  for (const [name, factory] of Object.entries(agentFactories)) {
    if (disabledAgents.includes(name)) continue
    const agent = factory(model)
    if (langDirective && agent.prompt) {
      agent.prompt = agent.prompt + langDirective
    }
    agents[name] = agent
  }

  return agents
}
```

to:

```typescript
export function createBuiltinAgents(
  disabledAgents: string[] = [],
  model?: string,
  outputLanguage?: string,
  staticRepairEnabled = false,
): Record<string, AgentConfig> {
  const agents: Record<string, AgentConfig> = {}
  const langDirective = outputLanguage ? buildLanguageDirective(outputLanguage) : ""
  const repairDisabledDirective = staticRepairEnabled ? "" : buildRepairDisabledDirective()

  for (const [name, factory] of Object.entries(agentFactories)) {
    if (disabledAgents.includes(name)) continue
    const agent = factory(model)
    if (agent.prompt) {
      if (name === "static-analyzer" && repairDisabledDirective) {
        agent.prompt = agent.prompt + repairDisabledDirective
      }
      if (langDirective) {
        agent.prompt = agent.prompt + langDirective
      }
    }
    agents[name] = agent
  }

  return agents
}
```

**Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

**Step 4: Commit**

```bash
git add src/agents/builtin-agents.ts
git commit -m "feat(agents): inject repair-disabled directive into static-analyzer by default"
```

---

### Task 3: Thread Config Through `createAgents`

**Files:**
- Modify: `src/create-agents.ts` (`createAgents` function body)

**Step 1: Pass `static_repair_enabled` to `createBuiltinAgents`**

Change the `createBuiltinAgents` call from:

```typescript
  return createBuiltinAgents(
    pluginConfig.disabled_agents,
    model,
    pluginConfig.output_language,
  )
```

to:

```typescript
  return createBuiltinAgents(
    pluginConfig.disabled_agents,
    model,
    pluginConfig.output_language,
    pluginConfig.static_repair_enabled,
  )
```

**Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add src/create-agents.ts
git commit -m "feat(agents): thread static_repair_enabled config to createBuiltinAgents"
```

---

### Task 4: Update Conductor Phase 3 Static Analyzer Dispatch

**Files:**
- Modify: `src/agents/conductor.ts` (Phase 3 Step 3 section)

**Step 1: Simplify the static-analyzer task prompt**

Find the Phase 3 Step 3 block in the conductor system prompt. Replace:

```
### Step 3: Dispatch static analysis (parallel, unchanged)
\`\`\`
task(subagent_type="static-analyzer", prompt="Run SpecChecker static analysis on the source code. Use the specchecker tool with mode='check' and project_dir='<absolute_path_to_project_source>'. After analysis, use mode='repair_all' with violations_json=JSON.stringify(violations) to batch-repair ALL auto_fixable violations. Then use mode='verify' to validate critical repairs. Output report to .matrix/reports/static-analysis.md. Merge any new defects into .matrix/data/defects.json. Write repair plan to .matrix/data/repair-plan.json.", run_in_background=true)
\`\`\`
```

with:

```
### Step 3: Dispatch static analysis (parallel, unchanged)
\`\`\`
task(subagent_type="static-analyzer", prompt="Run SpecChecker static analysis on the source code. Use the specchecker tool with mode='check' and project_dir='<absolute_path_to_project_source>'. Classify all violations (must-fix / suggestion / waiver). Output report to .matrix/reports/static-analysis.md. Merge any new defects into .matrix/data/defects.json.", run_in_background=true)
\`\`\`

> Note: Auto-repair (repair_all / verify) is disabled by default. Enable with static_repair_enabled: true in .matrix/config/matrix.jsonc.
```

**Note**: The `> Note:` line must NOT use backticks inside the template literal string — use plain text only to avoid TypeScript template literal parse errors.

**Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add src/agents/conductor.ts
git commit -m "feat(conductor): remove repair instructions from static-analyzer Phase 3 dispatch"
```

---

### Task 5: Update Static Analysis Skill Documentation

**Files:**
- Modify: `skills/static-analysis/SKILL.md`

**Step 1: Update Role section**

Replace the current Role section:

```markdown
## Role

You are a static analysis specialist. Run SpecChecker for aerospace C coding standard compliance, classify violations, generate and verify automated repairs.
```

with:

```markdown
## Role

You are a static analysis specialist. Run SpecChecker for aerospace C coding standard compliance, classify violations, and (when repair is enabled) generate and verify automated repairs.

> **Default mode: analysis only.** Auto-repair is disabled unless `static_repair_enabled: true` is set in `.matrix/config/matrix.jsonc`. When your prompt includes a `<repair_directive>` block, follow it exactly — it overrides the steps below.
```

**Step 2: Annotate repair steps as conditional**

Change Step 2 heading from:

```markdown
### 2. Generate Repairs (batch)
```

to:

```markdown
### 2. Generate Repairs (batch) — only when repair is enabled
```

Change Step 3 heading from:

```markdown
### 3. Verify Repairs
```

to:

```markdown
### 3. Verify Repairs — only when repair is enabled
```

**Step 3: Update Finding Classification section**

Replace the current Step 4 classification list:

```markdown
### 4. Finding Classification
Classify each finding into one of:
- **auto-fixed**: Violation with verified repair — attach patch
- **must-fix**: Critical safety issue or mandatory rule violation without auto repair — blocks release
- **suggestion**: Advisory/recommended rule violation — should fix
- **waiver**: Justified violation with documented rationale — deviation approved
```

with:

```markdown
### 4. Finding Classification
When **repair is disabled** (default), classify each finding into:
- **must-fix**: Critical safety issue or mandatory rule violation — blocks release
- **suggestion**: Advisory/recommended rule violation — should fix
- **waiver**: Justified violation with documented rationale — deviation approved

When **repair is enabled**, also use:
- **auto-fixed**: Violation with verified repair — attach patch
```

**Step 4: Update Output section**

Replace:

```markdown
## Output

- Append defects to `.matrix/data/defects.json` with `source: "static_analysis"`
- Write repair plan to `.matrix/data/repair-plan.json`
- Generate report at `.matrix/reports/static-analysis.md` with repair results and deviation request list
```

with:

```markdown
## Output

- Append defects to `.matrix/data/defects.json` with `source: "static_analysis"`
- Write repair plan to `.matrix/data/repair-plan.json` — **only when repair is enabled**
- Generate report at `.matrix/reports/static-analysis.md` with violation summary and deviation request list (omit auto-repair section when repair is disabled)
```

**Step 5: Commit**

```bash
git add skills/static-analysis/SKILL.md
git commit -m "docs(skill): update static-analysis skill to document default analysis-only mode"
```

---

### Task 6: Final Verification

**Step 1: Run typecheck**

Run: `bun run typecheck`
Expected: PASS with no errors.

**Step 2: Run build**

Run: `bun run build`
Expected: Build completes successfully, `dist/index.js` produced.

**Step 3: Verify directive injection**

```bash
grep -c "repair_directive\|Auto-repair is DISABLED\|static_repair_enabled" dist/index.js
```

Expected: at least 3 matches (directive text + config field).

**Step 4: Final commit (if any uncommitted changes remain)**

```bash
git status
# If clean, no action needed.
```
