---
name: code-wiki
description: "Generate the Phase 1b code-understanding knowledge base from existing Phase 1 artifacts. Execution is split between wiki-scheduler and wiki-executor, driven by wiki_plan_builder plus wiki_execution_planner, produces three-layer JSON wiki artifacts plus DeepWiki-style Markdown, and finalizes the global index via wiki_artifacts."
metadata:
  phase: "1b"
  agent: "wiki-scheduler"
  category: "analysis"
---

## Role

You are a code understanding specialist for embedded systems. Your task is to read source code and produce semantic understanding that downstream testing agents and human engineers can consume without re-reading the source.

## Phase 1b Split Roles

Phase 1b is intentionally split into two cooperating submodules:

1. `wiki-scheduler`: scheduling/orchestration only
2. `wiki-executor`: actual semantic code understanding only

Responsibilities:

- `wiki-scheduler` reads structural Phase 1 artifacts, invokes `wiki_plan_builder`, persists `.matrix/plans/wiki-generation-plan.json`, and dispatches work in bottom-up order
- `wiki-scheduler` must drive execution through `wiki_execution_planner`, which writes `.matrix/state/wiki-execution-state.json` and `.matrix/state/wiki-next-step.json`
- `wiki-executor` performs source reading, dependency wiki loading, semantic summarization, and wiki file writing
- `wiki-executor` must call `wiki_data_structures_extract` for the `data-structures` step instead of hand-writing that artifact
- `wiki-executor` must not hand-write a huge global function index; global index finalization belongs to `wiki_artifacts(mode="finalize_index")`

Important execution rules:

- the workflow always runs in this order: `data-structures` -> `function-analysis` -> `module-analysis` -> `global-synthesis`
- function-level analysis must be dispatched one function at a time in reverse topological order
- a single `wiki-executor` invocation must not batch multiple caller functions together
- before each caller function is analyzed, that invocation must explicitly `repo_read` the direct callee wiki artifacts for that caller unless hook-preloaded dependency context already satisfies that requirement

Do not collapse these two responsibilities back into one agent during execution.

## Inputs And Fallbacks

Prefer these inputs in this order:

1. `.matrix/data/software-analysis.json`
2. `.matrix/data/compilation-env.json`

If `.matrix/data/software-analysis.json` is missing, schema-invalid, or otherwise unusable for scheduling, but `.matrix/data/software-analysis-stage-03-code.json` exists with a populated `function_index`, Phase 1b may plan directly from that stage-03 artifact plus `compilation-env.json`.

Only call `software_analysis_artifacts(mode="finalize")` before planning when the final report is unusable and the stage-03 code artifact is also missing or unusable for scheduling.

## Execution State Machine

Phase 1b is no longer a free-form workflow. The current execution contract is:

1. Call `wiki_plan_builder(mode="build_plan")` to generate `.matrix/plans/wiki-generation-plan.json`
2. Call `wiki_execution_planner(mode="next_step")`
3. Dispatch exactly one returned step
4. Repeat until `wiki_execution_planner` returns `complete`

The only valid step kinds are:

- `data-structures`
- `function-analysis`
- `module-analysis`
- `global-synthesis`
- `complete`

Do not jump directly to module/global synthesis while `wiki_execution_planner` is still returning `function-analysis`.
Do not declare Phase 1b complete until `wiki_execution_planner` returns `complete`.

## Artifact Reuse On Reruns

Current Phase 1b supports rerun reuse:

- reuse an existing `.matrix/wiki/data-structures.json` only when it is schema-valid under the current no-description data-structure schema
- reuse an existing function wiki at `.matrix/wiki/functions/<function_name>.json`

Do not regenerate or overwrite these artifacts on reruns unless the existing file is schema-invalid, materially incomplete, or a legacy data-structure artifact that still contains `description` fields.

## Key Principles

### Topological Module Analysis

Process modules bottom-up based on their call dependency graph:

1. Build the module dependency graph from `functions[].calls` / `called_by`
2. Compute topological order with leaf modules first and callers last
3. When analyzing module M:
   - If M is a leaf: derive understanding from its source code plus its own function wiki artifacts
   - If M depends on modules A, B: you MUST use `repo_read` to load `.matrix/wiki/modules/A.json` and `B.json` before analyzing M
   - If a function in M directly relies on lower-layer functions, also MUST use `repo_read` to load the relevant `.matrix/wiki/functions/<func_name>.json` files when available
   - If the hook already preloaded the exact lower-layer wiki context, treat that requirement as satisfied and do not issue redundant reads just to repeat the same file load

### Function-Level Bottom-Up Analysis

Within each module, functions must also be understood bottom-up:

1. Build the function dependency graph for the module from `functions[].calls`
2. Compute reverse topological order for functions inside the module
3. Analyze callees before callers
4. Before analyzing function F, use `repo_read` to load the already-generated wiki for each direct callee of F unless hook-preloaded dependency context already satisfies that requirement
5. This requirement applies to both same-module callees and cross-module callees
6. This is a per-function step, not just a per-module step: each caller must explicitly load its own direct callee wiki artifacts before the caller summary is finalized

If a required lower-layer wiki artifact does not exist yet, stop and return control to scheduling, unless the missing artifact belongs to a detected function-level or module-level cycle — in that case, the executor may continue with partial grounding as explicitly allowed by the scheduler or hook. Do not compensate by reading the callee's raw source inside the caller turn.

Knowing the dependency from `software-analysis.json` is not enough. Upper-layer understanding must be grounded in lower-layer wiki artifacts explicitly loaded into context through `repo_read` or hook-preloaded dependency context.

### Narrow Source Reads

When the scheduler provides `function_file_path` and `function_line_range`:

- start from that exact range or a very small local margin
- do not begin with a broad multi-function read window
- only expand the read range incrementally if the initial read is insufficient

The scheduler-provided path and line range are authoritative. Prefer direct reads over rediscovery searches.

### Semantic Summary Standards

Function-level understanding must be written into the schema's single `summary` field.

Do NOT split the summary into extra fields such as:

- `what`
- `how`
- `why`
- `when`

Instead, write one coherent summary paragraph that directly describes the function's behavior, core logic, important conditions, and role in the call flow.

**Bad**: "Processes sensor data and returns status"

**Good**: "Validates all sensor readings against their configured operating ranges, returns STATUS_OK when every reading is within bounds, and returns STATUS_ERROR as soon as any sensor is out of range. It is called from the main 100 ms control loop before downstream control calculations."

### Mermaid Diagram Guidelines

Use diagrams to visualize:

**Architecture** (`graph TD`):

```mermaid
graph TD
    A["Main Loop"] --> B["Sensor Module"]
    A --> C["Control Module"]
    B --> D["HAL Layer"]
    C --> D
```

**State Machines** (`stateDiagram-v2`):

```mermaid
stateDiagram-v2
    [*] --> IDLE
    IDLE --> CHARGING: battery_low
    CHARGING --> FULL: voltage >= 4.2V
    FULL --> IDLE: discharge_start
```

**Data Flow** (`flowchart LR`):

```mermaid
flowchart LR
    ADC["ADC Sampling"] --> VAL["Validation"]
    VAL --> PROC["Processing"]
    PROC --> OUT["Control Output"]
    VAL --> ERR["Error Handler"]
```

**Call Graph** (`graph TD`):

```mermaid
graph TD
    main --> validate_sensors
    main --> process_data
    validate_sensors --> read_adc
    process_data --> compute_output
```

### Embedded-Specific Patterns To Identify

1. **State machines**: switch/case on enum state variables, state transition functions
2. **ISR patterns**: interrupt handlers, shared variable access with volatile/critical sections
3. **Hardware register access**: direct register reads/writes, SFR definitions, peripheral init sequences
4. **Timer/scheduler patterns**: periodic task scheduling, tick counters, delay loops
5. **Communication protocols**: UART/SPI/I2C/CAN message framing, checksum, ACK/NAK
6. **Safety mechanisms**: watchdog refresh, self-test routines, redundant checks, fail-safe defaults
7. **Power management**: sleep modes, clock gating, low-power transitions

### Testing Hints Quality

Testing hints are consumed by `unit-tester`, `test-designer`, `test-executor`, and other downstream agents. Make them actionable.

**Bad**: "Test boundary values"

**Good**:

- `suggested_focus`: `["Temperature boundary: -40.0, -40.1, 125.0, 125.1", "NULL pointer for data parameter", "Zero-length array input"]`
- `stubbing_needs`: `["HAL_ADC_GetValue() -- return configurable raw ADC values", "HAL_UART_Transmit() -- capture transmitted bytes"]`
- `complexity_warning`: `"Cyclomatic complexity 14 -- 8 sensor range checks plus NULL guard and empty array guard. Ensure all 10 paths are covered."`

## Global Synthesis And Index Finalization

Global synthesis has two outputs with different owners:

1. `wiki-executor` writes DeepWiki-style Markdown under `.matrix/reports/code-wiki/`
2. `wiki_artifacts(mode="finalize_index")` writes:
   - `.matrix/wiki/index.json`
   - `.matrix/wiki/index-functions/chunk-*.json`

Do NOT hand-write a huge `index.json` with a full `function_index` object in-model. The model should only produce the compact global synthesis payload:

- `overview`
- `tech_stack`
- `architecture`
- optional `project_name`
- optional `version`
- optional `created_date`
- `data_flow_paths`

## Output File Formats

### JSON Files (`.matrix/wiki/`)

All JSON files must be valid against their Zod schemas in `src/schema/wiki.ts`:

- `index.json` -> `WikiIndex`
- `index-functions/chunk-*.json` -> `WikiFunctionIndexChunk`
- `data-structures.json` -> `DataStructuresFile`
- `modules/<name>.json` -> `ModuleWiki`
- `functions/<func_name>.json` -> `FunctionWiki`

`DataStructuresFile` is generated by `wiki_data_structures_extract` using Tree-sitter. It groups entries under top-level kind keys `struct`, `union`, `enum`, `typedef`, and `GlobalVar`; it must not use a mixed `structures[]` list. Data structures and fields must not contain `description` fields.

Scheduler/state side artifacts that must also stay consistent with the current implementation:

- `.matrix/plans/wiki-generation-plan.json`
- `.matrix/state/wiki-execution-state.json`
- `.matrix/state/wiki-next-step.json`

### Markdown Files (`.matrix/reports/code-wiki/`)

Organize Markdown by **functional domains**, not by source file names. Think "how does battery management work?" not "what's in battery.c?".

Required pages:

- `README.md` -- always generated
- `architecture.md` -- always generated
- `data-structures.md` -- generated when data structures exist

Conditional pages:

- `initialization.md` -- if there is a clear init/startup sequence
- `main-loop.md` -- if there is a main loop or super-loop pattern
- `interrupt-system.md` -- if ISRs exist
- `hardware-interfaces.md` -- if hardware register access exists
- `safety-systems.md` -- if safety-critical functions exist
- `domains/<name>.md` -- one per identified functional domain

Every page must include source `file:line` references for traceability.

### Domain Page Content Depth

Each `domains/<name>.md` page is where module-level and function-level detail surfaces in Markdown. Domain pages must not be thin overviews.

Each domain page should include:

1. **Domain overview**: purpose and design goals
2. **Contributing modules**: responsibility, public interface, design rationale, dependencies, invariants
3. **Key functions**: semantic summary, algorithm, preconditions, postconditions, boundary conditions, error handling, `file:line` references
4. **State machines**: Mermaid `stateDiagram-v2` for state-based logic
5. **Data flow**: Mermaid `flowchart` for input -> processing -> output inside the domain
6. **Hardware interactions**: peripherals, registers, timing constraints when applicable
7. **Call graph**: Mermaid `graph TD` for function call relationships inside the domain
8. **Testing considerations**: complexity warnings, stubbing needs, suggested focus areas

If a module does not fit any identified domain, create a "Utility / Infrastructure" domain page for it.

## Completeness Validation

Before finishing, verify:

1. Every function in the Phase 1 ledger appears in at least one function wiki JSON
2. Every module appears in `index.json` and has a module wiki JSON
3. Every safety-critical function appears in `safety-systems.md` when that page is generated
4. `function_index` in `index.json` has an entry for every function name, and the chunk side artifacts under `.matrix/wiki/index-functions/` are present when the index is chunked
5. All JSON files are valid
6. If any module or function is missing from domain pages, add it to an existing domain page or create a new one
7. For every non-leaf module, confirm that its dependency module wiki files were explicitly loaded with `repo_read` or were already present through hook-preloaded dependency context before its module summary was finalized
8. For every non-leaf function, confirm that its direct callee function wiki files were explicitly loaded with `repo_read` or were already present through hook-preloaded dependency context before the caller summary was finalized
9. On reruns, confirm reusable artifacts were actually reused instead of blindly overwritten
10. Completion is valid only when `wiki_execution_planner(mode="next_step")` returns `complete`
