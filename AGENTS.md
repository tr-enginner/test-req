# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

Matrix Embedded Agent is an OpenCode plugin implementing a multi-agent system for embedded software testing. It provides 29 specialized agents, 77 domain tools, 10 process hooks, 19 skills, and 23 slash commands that guide software through a 9-phase testing workflow compliant with GJB 5000A, GJB 2725, GJB 141, DO-178C, and IEC 61508 standards.

## Companion Project: requirements-manager

The companion [requirements-manager repository](https://github.com/wsliture/matrix-test-req-reviewer) provides the Web UI, API, background jobs, source-document browsing, traceability, human reviews, online editing, revision history, and exports around this plugin's Phase 2 workflow.

- Its local checkout belongs at `requirements-manager/`. This directory is ignored by this repository and is not included in a normal clone; absence does not mean the system has no management application.
- For tasks involving the management UI, API, queues, review data, or online editing, first check whether that directory exists and read [requirements-manager/AGENTS.md](requirements-manager/AGENTS.md). Architecture and setup are documented in [its architecture overview](requirements-manager/docs/整体架构.md) and [README](requirements-manager/README.md).
- If the checkout is missing and the task requires it, clone `https://github.com/wsliture/matrix-test-req-reviewer.git` into `requirements-manager/`. Inspect an existing directory before cloning; never overwrite an existing checkout.
- The manager uses Node.js, npm workspaces, and Vitest. The root plugin uses Bun. Run commands in the correct repository; root build/test commands do not validate the manager.
- The manager has its own Git history and remote. Check, stage, commit, and push changes separately in each affected repository; do not remove the ignore rule or accidentally vendor the nested repository.
- Model generation runs through OpenCode and the Matrix Phase 2 plugin. Deterministic editing/rebuilding uses the root `src/direct-phase2-runner.ts`. Manager OpenCode image builds depend on the parent plugin source tree; cross-boundary changes may require rebuilding that image as well as checking both projects.

## Build & Development Commands

```bash
bun install              # Install dependencies + download bundled binaries (postinstall)
bun run build            # Build to dist/index.js (ESM, Bun target)
bun run typecheck        # TypeScript type checking (tsc --noEmit)
bun test                 # Run tests
bun run clean            # Remove dist/
```

## Architecture

### Plugin Entry Point

`src/index.ts` exports a default OpenCode plugin function. On load it:
1. Reads config from `.matrix/config/matrix.jsonc` via `plugin-config.ts`
2. Creates tools (`create-tools.ts`), hooks (`create-hooks.ts`), and agents (`create-agents.ts`)
3. Resolves bundled skills directory (`create-skills.ts`)
4. Returns the plugin interface defined in `plugin-interface.ts`

The `config` hook in `plugin-interface.ts` registers agents, skills paths, and slash commands with OpenCode. It writes `target_phases` and `active_phases` to `progress.json` instead of the removed `current_phase`.

### Agent System (`src/agents/`)

29 agents organized by role. Each agent file exports a factory function (`AgentFactory` type from `types.ts`) that returns an agent definition with metadata (category, cost, triggers). The `builtin-agents.ts` file registers all agents.

**Orchestration**: `conductor.ts` (primary router), `planner.ts` (scope clarification)
**Analysis**: `analyst.ts` (code/requirements parsing), `phase2-orchestrator.ts` (chapter-based test requirement generation), `astgrep.ts` (AST-level structural code search), `wiki-scheduler.ts` / `wiki-executor.ts` (code understanding scheduling + execution)
**Testing**: `inspector.ts` (code review), `static-analyzer.ts` (raw violation detection → `sa-raw-findings.json`), `unit-tester.ts`, `test-designer.ts` (confirmation tests), `test-executor.ts`, `env-architect.ts` (environment setup)
**Quality**: `reviewer.ts` (quality gates for phases 2/5/6), `cr-reviewer.ts` (code review quality gate for phase 3), `sa-reviewer.ts` (three-class static analysis result classification → `defects.json`, `false-positives.json`, `standards-only.json`), `isr-reviewer.ts` (interrupt data access conflict audit), `multivar-atomicity-checker.ts` (multi-variable atomicity violation detection via Joern CPG + Z3), `oracle.ts` (escalation after repeated failures), `summarizer.ts` (reports)
**Utility**: `context-packer.ts` (runs `code_slice_context_pack` and reports `.matrix/data/contexts` outputs)

### Phase Dependency Workflow

Phases are defined in `src/shared/constants.ts`. Phase state is tracked in `src/shared/phase-state.ts` using a DAG-based model and persisted to `.matrix/state/progress.json`. The state tracks `target_phases` (user-selected goals) and `active_phases` (transitive dependency closure). `resolveActivePhases(targets)` computes the full set of phases needed, and `getReadyPhases()` returns phases whose dependencies are all completed. The legacy `current_phase` linear cursor has been removed.

```
Phase 0: Task Classification    → Conductor classifies and determines target phases
Phase 1: Software Analysis      → Analyst: compilation env setup + code/requirements parsing
Phase 1b: Code Wiki Generation  → WikiScheduler + WikiExecutor: semantic code understanding scheduling and execution
Phase 2: Test Requirements      → Phase2Orchestrator generates requirement chapters (review gate)
--- After Phase 2, the following phases run in PARALLEL ---
Phase 3: Code Review & Static   → Inspector (all requirements, parallel focused reviews) + StaticAnalyzer + ISR-Reviewer + MultivarAtomicityChecker (parallel), then SA-Reviewer + Inspector Summary (parallel), then CR-Reviewer quality gate
Phase 4: Unit Testing           → UnitTester
Phase 5: Test Environment       → EnvArchitect (review gate)
Phase 6: Confirmation Test Design → TestDesigner (review gate)
--- Phase 7 waits for Phase 5 AND Phase 6 ---
Phase 7: Test Execution          → TestExecutor
--- Phase 8 waits for Phase 3 AND Phase 4 AND Phase 7 ---
Phase 8: Test Summary            → Summarizer generates reports
```

```
Dependencies: 0→1→1b→2→{3,4,5,6 parallel}→7 (needs 5+6)→8 (needs 3+4+7)
```

Review gates are enforced at phases 2, 3, 5, and 6. A review REVISE only blocks the affected phase; parallel phases are not affected. Phase 3 uses `cr-reviewer` (not `reviewer`) for its quality gate.

### Tool System (`src/tools/`)

77 domain-specific tools exposed to agents via OpenCode's tool interface:
- `req-parser.ts` / `code-parser.ts` — parse requirement docs and C/C++ source
- `compdb-generator.ts` — build system detection and compile_commands.json generation (supports CMake, Make, Keil, IAR, Eclipse, or inference from source)
- `header-stub-generator.ts` — generates minimal stub headers for missing vendor/BSP/RTOS includes
- `code-preprocessor.ts` — dialect translation: converts compiler-specific constructs (GCC, ARMCC, IAR, Keil, Green Hills, TI, Wind River) into standard C/C++
- `misra-checker.ts` — SpecChecker wrapper for aerospace C coding standard analysis, with 5-level auto-discovery (config → env → PATH → common paths → global filesystem search) and auto-persist
- `unit-runner.ts` / `test-executor.ts` / `coverage-report.ts` — test execution and coverage
- `test-env-ctrl.ts` — environment setup/teardown
- `doc-generator.ts` — markdown report generation from templates
- `ct-suite-builder.ts` — incremental confirmation test suite builder (3 tools: `ct_suite_create`, `ct_suite_add_case`, `ct_suite_finalize`)
- `ut-report-builder.ts` — incremental unit test report builder (4 tools: `ut_report_create`, `ut_report_add_case`, `ut_report_add_result`, `ut_report_finalize`)
- `exec-report-builder.ts` — incremental test execution report builder (3 tools: `exec_report_create`, `exec_report_add_execution`, `exec_report_finalize`)
- `mdbook-generator.ts` — assembles `.matrix/reports/*.md` into a browsable HTML site via bundled mdbook binary (`bin/mdbook`)
- `astgrep-runner.ts` — AST-level structural code search via bundled ast-grep CLI (`bin/sg`), supports pattern and YAML rule modes
- `code-slice-context-pack.ts` — wraps `code-slice work/run_cli.py context-pack`, validates `.matrix/data/contexts/manifest.json` and `contexts/*.json`, and reports context packing results
- `issue-report-generator.ts` — generates DOCX issue report (软件测试问题报告单) from `defects.json` via template placeholder substitution (no LLM calls)
- `append-defects.ts` — atomic concurrent-safe append to `defects.json` with source-level replace semantics
- AUnit tools (9 tools): `aunit_create_project`, `aunit_build`, `aunit_autogen`, `aunit_run_case`, `aunit_report`, `aunit_inject_cases`, `aunit_enrich_cases`, `aunit_sync_report`, `aunit_list_platforms`
- `multivar-cpg-create.ts` — creates Joern Code Property Graph (CPG) from C/C++ source via `joern-parse`
- `multivar-correlated-vars.ts` — identifies correlated variable groups (DFC/TUP/DAC) via Joern Scala script; scores and filters by confidence
- `multivar-violation-detect.ts` — matches 5 violation patterns (DFC_RWWR, TUP_WRRW, TUP_WWWW, DAC_RWWW, DAC_RWWR) across Task↔ISR and ISR↔ISR boundaries
- `multivar-feasibility-verify.ts` — verifies violation feasibility via Joern CFG path reachability + Z3 SMT solving; outputs CONFIRMED/INFEASIBLE/UNKNOWN

#### Preprocessing Infrastructure (`src/tools/preprocessing/`)

Internal modules supporting the compilation/preprocessing tools:
- `dialect-rules.ts` — regex-based translation rules for 8 compiler dialects (GCC, ARMCC, armclang, Keil ARM, C51/8051, IAR, Green Hills, TI, Wind River) + auto-detection
- `build-parsers.ts` — parsers for Makefile, CMakeLists.txt, .uvprojx (Keil), .ewp (IAR), .cproject (Eclipse), with source-inference fallback
- `standard-stubs.ts` — pre-built stub content for standard C, CMSIS, FreeRTOS, and vendor HAL headers
- `include-resolver.ts` — `#include` scanning, path resolution, missing header identification, and demand-driven stub generation

### Skill System (`skills/`)

19 skills shipped as `SKILL.md` files under `skills/<name>/SKILL.md`. Registered via `config.skills.paths` in the config hook so OpenCode discovers them automatically. Agents load skills on-demand via the built-in `skill` tool (lazy loading).

| Skill | Phase | Description |
|-------|-------|-------------|
| `test-planning` | pre-0 | Interview-driven test scope planning |
| `software-analysis` | 1 | Code & requirement analysis methodology |
| `code-review` | 3 | Manual code review against coding standards |
| `static-analysis` | 3 | Automated MISRA/static defect checking (includes compile_log diagnostics with cascade dedup and decision tree) |
| `static-analysis-review` | 3 | Three-class classification of static analysis findings (139 undecidable rules taxonomy, Phase 3.5 triggering condition analysis) |
| `interrupt-review` | 3 | Interrupt data access conflict audit (C1-C5 patterns) |
| `multivar-atomicity` | 3 | Multi-variable atomicity violation detection (DFC/TUP/DAC anchors, 5 patterns, Z3 verification) |
| `unit-testing` | 4 | Unit test design, drivers/stubs, coverage iteration |
| `functional-case-gen` | 4 | Functional test case generation methodology |
| `test-environment` | 5 | Simulation environment design |
| `test-design` | 6 | Confirmation test case design |
| `test-execution` | 7 | Step-by-step test execution |
| `test-summary` | 8 | Final report with pass/fail conclusion |
| `code-wiki` | 1b | Code understanding knowledge base generation methodology |
| `ast-grep-rules` | — | ast-grep YAML rule writing reference (atomic, relational, composite rules, C/C++ tips) |

### Command System (`src/create-skills.ts`)

23 slash commands registered via `config.command` in the config hook:

| Command | Agent | Description |
|---------|-------|-------------|
| `/matrix-start` | conductor | Start full 9-phase testing workflow |
| `/matrix-plan` | planner | Interactive test planning interview |
| `/matrix-analyze` | analyst | Code & requirement analysis (Phase 1) |
| `/matrix-wiki` | wiki-scheduler | Generate the code wiki knowledge base and DeepWiki-style documentation (Phase 1b) |
| `/matrix-contexts` | context-packer | Generate code-slice context-pack artifacts into `.matrix/data/contexts` |
| `/matrix-review` | reviewer | Quality gate review on current phase |
| `/matrix-test` | unit-tester | Unit testing with coverage iteration (Phase 4) |
| `/matrix-dynamic-design` | conductor | Run Phase 6 Steps 1–5: case generation, review gate, and formal publication |
| `/matrix-dynamic-test` | conductor | Run the complete Phase 6 Steps 1–7, including Robot/DTP generation and execution gate |
| `/matrix-status` | conductor | Show current phase progress |
| `/matrix-report` | summarizer | Generate final test summary (Phase 8) |
| `/matrix-metrics` | conductor | Show per-agent token usage, cost, and time |
| `/matrix-astgrep` | astgrep | AST-level structural code pattern search |
| `/matrix-static` | static-analyzer | Run SpecChecker static analysis (Phase 3) |
| `/matrix-isr-review` | isr-reviewer | Audit interrupt data access conflicts (C1-C5) |
| `/matrix-multivar-atomicity` | multivar-atomicity-checker | Detect multi-variable atomicity violations (DFC/TUP/DAC patterns) using Joern CPG and Z3 |
| `/matrix-singlevar-atomicity` | singlevar-atomicity-checker | Detect single-variable atomicity violations (RWR/RWW/WRW/WWR/WWW patterns) using intAtom-style staged path pruning |

### Hook System (`src/hooks/`)

Hooks intercept OpenCode events at three levels:
- **Chat hooks**: `review-enforcer` (mandatory reviews), `context-preloader` (loads context), `failure-escalation` (triggers Oracle after 3 failures)
- **Tool hooks**: `phase-gate` (enforces phase dependencies — active_phases membership + dependency completion check), `evidence-tracker` (artifact provenance), `artifact-validator` (schema validation), `progress-tracker` (updates phase state)
- **System hooks**: `traceability-injector` (requirement chain injection), `schema-validator`

### Data Layer

- **Schemas** (`src/schema/`): Zod schemas defining all data models — `SoftwareRequirement`, `FunctionInfo`, `DataFlowGraph`, `TestRequirement`, `UnitTestCase`, `ConfirmationTestCase`, `Defect` (includes optional `raw_finding_id` for traceability to `sa-raw-findings.json`), `ReviewRecord`, `TestSummary`, `CompileCommand`, `CompilationDatabase`, `CompilationEnvironment`, `HeaderStub`, `WikiIndex`, `ModuleWiki`, `FunctionWiki`, `DataStructuresFile`, `SARawFinding`, `SARawFindingsReport`, `CorrelatedVariableGroup`, `AtomicityViolation`, `PathAnalysis`
- **Data store** (`src/shared/data-store.ts`): File I/O with Zod validation, reads/writes JSON to `.matrix/data/`
- **Traceability** (`src/shared/traceability.ts`): Builds requirement → test → execution → defect traceability matrices

### Runtime Artifacts (`.matrix/`)

```
.matrix/
├── config/matrix.jsonc    # Plugin configuration
├── data/                  # JSON data (software-analysis, test-requirements, defects, sa-raw-findings, false-positives, standards-only, compile_commands, compilation-env, contexts/, index.db, multivar-correlated-groups, multivar-candidates, multivar-violations, multivar-confirmed, singlevar-pairs, singlevar-candidates, singlevar-violations, etc.)
├── state/progress.json    # Current phase tracking
├── cpg/                   # Joern Code Property Graph binaries (<project>.bin)
├── wiki/                  # Code understanding knowledge base (JSON, three layers: index → module → function)
├── reports/               # Generated markdown reports
│   └── code-wiki/         # DeepWiki-style Markdown documentation (functional domain organization)
├── plans/                 # Execution plans
├── stubs/                 # Generated stub headers for missing includes
├── preprocessed/          # Dialect-translated source files (with #line directives for mapping)
└── book/                  # mdbook HTML site generated from reports/
```

## Configuration (`src/config/schema.ts`)

The `MatrixConfig` Zod schema defines plugin settings loaded from `.matrix/config/matrix.jsonc`:
- `standard`: compliance standard (`gjb5000a`, `do178c`, `iec61508`, etc.)
- `coverage_target`: `statement` | `branch` | `mc_dc` | `condition` | `path`
- `coverage_target_percentage`: coverage threshold percentage 0-100 (default: `90`)
- `unit_framework`: `unity` | `cunit` | `gtest` | `custom`
- `coding_standard`: `misra-c-2012` | `gjb5369` | `cert-c` | `custom`
- `static_tools`: array of tools (default: `["cppcheck"]`)
- `compiler_dialect`: `auto` | `gcc` | `armcc` | `armclang` | `iar` | `keil` | `c51` | `greenhill` | `ti` | `windriver` | `generic`
- `target_cpu`: target CPU architecture (e.g., `cortex-m4`)
- `extra_include_dirs` / `extra_defines`: additional compilation parameters
- `compile_commands_path`: path to existing compile_commands.json (skip generation)
- `source_dirs`: source directories to analyze
- `disabled_agents` / `disabled_hooks` / `disabled_tools`: selective feature disabling
- `output_language`: `zh-CN` | `en` — language for all human-readable output (default: `zh-CN`). When set, a language directive is injected into all agent system prompts at creation time via `createBuiltinAgents()`. Chinese mode requires: Markdown reports, status messages, review comments, JSON description fields all in Chinese; code identifiers, JSON field names, enum values remain in English.
- `auto_advance`: whether to auto-progress through phases
- `wiki_enabled`: whether to generate code wiki (default: `true`)
- `wiki_mermaid`: whether to include Mermaid diagrams in wiki Markdown (default: `true`)
- `wiki_depth`: `full` | `modules_only` (default: `full`)
- `joern_home`: path to Joern installation directory (contains `joern.bat`/`joern` and `joern-parse.bat`/`joern-parse`); used by multivar-atomicity-checker tools; falls back to `JOERN_HOME` env var then system PATH
- `z3_home`: path to Z3 installation directory (contains `bin/z3.exe` or `bin/z3`); used by atomicity feasibility verification; falls back to `Z3_HOME` env var then system PATH
- `code_slice_home`: path to `code-slice` installation directory (contains `work/run_cli.py`); used by `code_slice_context_pack`; falls back to `CODE_SLICE_HOME`. Offline installers place it under `tools/code_slicer` and register `CODE_SLICE_HOME` automatically.

## Key Dependencies

- `@opencode-ai/plugin` and `@opencode-ai/sdk` — plugin framework
- `zod` — schema validation for all data models
- `jsonc-parser` — reads JSONC config files

## Test Sample Projects (`tests/`)

Two sample embedded C projects for integration testing and workflow validation:

### `tests/sample-c-project/`
Generic embedded C data processor project. Includes a complete `.matrix/` directory with artifacts from a full 9-phase workflow run (software analysis, test requirements, reviews, unit tests, test environment, confirmation tests, test execution, test summary). Useful as a reference for expected tool outputs and artifact formats.

### `tests/sample-8051-project/`
8051 satellite power controller (PCU) using Keil C51 dialect. Tests the compilation database and preprocessing pipeline against real embedded constructs:
- **Dialect constructs**: `sfr`, `sbit`, `xdata`, `idata`, `code`, `bit`, `interrupt N using M`, code-space function pointers
- **Domain logic**: MPPT P&O algorithm, battery charge/discharge state machine, bus voltage protection, load shedding, UART telemetry/telecommand
- **No build system files** (tests the source-inference fallback path in `build-parsers.ts`)
- Requirements document in Chinese (tests multi-language requirement parsing)

## Bundled Binaries (`bin/`)

Open-source CLI tools are shipped as built-in binaries in the `bin/` directory, not downloaded at runtime. The `postinstall` script (`scripts/postinstall.ts`) downloads platform-appropriate binaries during `bun install`. The `bin/` directory is included in `package.json` `files` so it ships with the npm package.

Currently bundled: **mdbook** (HTML report site generation), **ast-grep / sg** (AST-level structural code search).

**To add a new bundled binary:**
1. Add a `BundledTool` entry to the `TOOLS` array in `scripts/postinstall.ts` (name, version, platform-specific asset URLs)
2. In the corresponding tool `.ts` file, resolve the binary via `join(import.meta.dir, "..", "bin", binaryName)` and throw an error with a `bun install` hint if missing — do NOT add runtime download logic

## Conventions

- TypeScript strict mode, ESNext target, ESM modules
- Bun runtime (not Node.js)
- All schemas use Zod; data persistence goes through `data-store.ts` with validation
- Agent factories return metadata including `category`, `cost`, and `triggers`
- Report templates live in `templates/` as Markdown with placeholder syntax
- Standards checklists live in `standards/` organized by standard name
- Skills are YAML-frontmatter Markdown files following OpenCode's `SKILL.md` convention
- Slash commands are template-based, each bound to a specific agent via `create-skills.ts`
