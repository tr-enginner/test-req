# Code Wiki: Phase 1 Code Understanding Knowledge Base

**Date**: 2026-02-23
**Status**: Design
**Author**: Claude (brainstorming session)

## Problem Statement

Current Phase 1 (Software Analysis) extracts structural data — function signatures, call graphs, cyclomatic complexity, requirement lists — into `software-analysis.json`. Downstream agents (Phase 2-8) consume this structural data but lack **semantic understanding**: what functions do, algorithm logic, boundary conditions, error handling, state machine behavior, hardware interaction patterns.

This forces downstream agents to repeatedly read source code to understand semantics, causing:
1. **Token waste**: Each agent re-reads the same source files
2. **Understanding inconsistency**: Different agents may interpret the same code differently
3. **No human-readable project documentation**: The JSON output is not browsable

## Solution

Generate a comprehensive **Code Wiki** during Phase 1 that serves as:
1. **Agent knowledge base** (structured JSON): Pre-digested semantic understanding that downstream agents consume instead of reading source code
2. **Human-browsable documentation** (Markdown/HTML via mdbook): DeepWiki-style project documentation organized by functional domains

## Design

### 1. Three-Layer JSON Knowledge Base (Agent Consumption)

Stored in `.matrix/wiki/`, organized by technical structure for efficient agent access.

#### L1: Global Index (`index.json`)

```typescript
interface WikiIndex {
  project_name: string;
  version: string;
  generated_at: string;               // ISO timestamp

  // Project overview (1-2 paragraphs)
  overview: string;

  // Technology stack
  tech_stack: {
    language: string;                  // e.g., "C (C99)"
    compiler: string;                  // e.g., "Keil C51", "GCC ARM"
    target: string;                    // e.g., "STM32F407", "AT89C52"
    rtos?: string;                     // e.g., "FreeRTOS"
    frameworks: string[];              // e.g., ["CMSIS", "HAL"]
  };

  // Global architecture
  architecture: {
    pattern: string;                   // e.g., "layered", "event-driven", "main-loop"
    description: string;               // 2-3 sentence architecture summary
    layers?: string[];                 // Layer names for layered architectures
  };

  // Module directory (navigation)
  modules: Array<{
    id: string;                        // e.g., "MOD-001"
    name: string;                      // e.g., "sensor_validation"
    files: string[];                   // Source files in this module
    description: string;               // One-line responsibility
    function_count: number;
    safety_critical: boolean;
  }>;

  // Function lookup table (name → id + module)
  function_index: Record<string, {
    id: string;                        // e.g., "FUNC-001"
    module_id: string;
    file_path: string;
    safety_critical: boolean;
  }>;

  // Key data structures
  data_structures: Array<{
    name: string;                      // e.g., "SensorData"
    file_path: string;
    kind: "struct" | "enum" | "union" | "typedef";
    description: string;
  }>;

  // Global data flow paths (high-level)
  data_flow_paths: Array<{
    name: string;                      // e.g., "Sensor Input → Validation → Processing → Output"
    description: string;
    modules_involved: string[];        // module IDs
  }>;
}
```

#### L2: Module Files (`modules/<module_name>.json`)

```typescript
interface ModuleWiki {
  id: string;
  name: string;
  files: string[];

  // Module responsibility (2-3 paragraphs)
  responsibility: string;

  // Design rationale — why designed this way
  design_rationale: string;

  // Public interface
  public_interface: Array<{
    function_id: string;
    name: string;
    signature: string;
    purpose: string;                   // One-line description
  }>;

  // Internal functions
  internal_functions: Array<{
    function_id: string;
    name: string;
    purpose: string;
  }>;

  // Module dependencies (outgoing)
  dependencies: Array<{
    module_id: string;
    module_name: string;
    relationship: string;              // e.g., "calls for sensor data validation"
  }>;

  // Dependents (incoming)
  dependents: Array<{
    module_id: string;
    module_name: string;
    relationship: string;
  }>;

  // State machines (if any)
  state_machines?: Array<{
    name: string;
    states: string[];
    transitions: Array<{
      from: string;
      to: string;
      trigger: string;
      action?: string;
    }>;
    description: string;
  }>;

  // Hardware interactions (embedded-specific)
  hardware_interactions?: Array<{
    peripheral: string;                // e.g., "UART1", "ADC", "GPIO_PA5"
    access_type: "read" | "write" | "read_write" | "interrupt";
    registers?: string[];
    description: string;
  }>;

  // Module-level invariants and constraints
  invariants: string[];

  // Known complexity/risk areas
  complexity_notes: string[];
}
```

#### L3: Function Files (`functions/<func_id>.json`)

```typescript
interface FunctionWiki {
  id: string;
  name: string;
  file_path: string;
  line_range: { start: number; end: number };
  module_id: string;
  signature: string;                   // Full signature

  // Semantic summary (3-5 sentences)
  summary: string;

  // Algorithm description (if non-trivial)
  algorithm?: {
    name: string;                      // e.g., "MPPT P&O", "Kalman Filter", "CRC-16"
    description: string;
    complexity?: string;               // e.g., "O(n)", "O(1)"
  };

  // Input constraints
  preconditions: Array<{
    parameter: string;
    constraint: string;                // e.g., "data != NULL", "size > 0 && size <= MAX_BUFFER"
  }>;

  // Output / side effects
  postconditions: Array<{
    description: string;
  }>;

  // Boundary conditions and special cases
  boundary_conditions: string[];

  // Error handling
  error_handling: Array<{
    error_condition: string;
    response: string;
  }>;

  // Control flow overview
  control_flow: {
    branches: number;
    loops: number;
    early_returns: number;
    description: string;
  };

  // Global variable / hardware register access
  side_effects: Array<{
    target: string;
    access: "read" | "write" | "read_write";
    description: string;
  }>;

  // Interrupt / concurrency (if applicable)
  concurrency?: {
    is_isr: boolean;
    interrupt_vector?: string;
    shared_resources: string[];
    critical_sections: boolean;
    reentrancy: "reentrant" | "non_reentrant" | "unknown";
  };

  // Semantic requirement fulfillment (not just ID mapping)
  requirement_fulfillment: Array<{
    requirement_id: string;
    how: string;                       // e.g., "Implements range checking for temperature per SRS-003"
  }>;

  // Testing hints for downstream agents
  testing_hints: {
    suggested_focus: string[];
    stubbing_needs: string[];
    complexity_warning?: string;
  };
}
```

### 2. Markdown Documentation (Human Consumption)

Stored in `.matrix/reports/code-wiki/`, organized by **functional domains** (DeepWiki style) — not mirroring the JSON technical structure.

```
.matrix/reports/code-wiki/
├── README.md                        # Overview: system intro, feature list, tech stack
├── SUMMARY.md                       # mdbook table of contents (auto-generated)
├── architecture.md                  # System architecture: layer diagram, component relationships, global data flow
├── initialization.md                # Initialization process: startup sequence, configuration
├── main-loop.md                     # Main control loop / core runtime mechanism
├── interrupt-system.md              # Interrupt system (if applicable)
├── data-structures.md               # Key data structures and global variables
├── domains/                         # Organized by functional domain (not by source file)
│   ├── <domain_name>.md             # e.g., battery-management.md, sensor-validation.md
│   └── ...
├── hardware-interfaces.md           # Hardware interface layer: peripherals, registers, drivers
└── safety-systems.md                # Safety mechanisms: protection, watchdog, fault tolerance
```

**Key design decisions for Markdown layer**:
- **Organized by functional domain**: Users ask "how does battery management work?" not "what's in battery.c?"
- **Mermaid diagrams**: Architecture diagrams, data flow charts, state machine diagrams, call graphs
- **Source line references**: All explanations reference `file.c:line` for traceability
- **Cross-links**: Module pages link to function pages, function pages link back to modules
- **Integrated into mdbook**: Appears as "Code Understanding" chapter alongside test reports

### 3. WikiBuilder Agent

#### Agent Metadata

```
Name:       wiki-builder
Category:   analysis
Cost:       EXPENSIVE (reads all source code for semantic analysis)
Mode:       subagent (dispatched by Conductor after Phase 1 structural analysis)
Tools:      read, glob, grep, write, doc_generator
Triggers:   Phase 1 structural analysis complete (software-analysis.json exists)
```

#### Position in Workflow

WikiBuilder runs as **Phase 1b** — a sub-phase of Phase 1, after structural analysis completes and before Phase 2 begins. This avoids modifying the 9-phase state machine.

```
Phase 0:  Task Classification    → Conductor
Phase 1:  Software Analysis      → Analyst (existing 6 steps)
Phase 1b: Code Wiki Generation   → WikiBuilder (NEW)
Phase 2:  Test Requirements      → ReqArchitect
...
```

Conductor dispatches WikiBuilder after Phase 1 completes. Phase state tracks `phase_1_wiki: "completed"`.

#### 5-Step Workflow

**Step 1: Load Structural Data**
- Read `.matrix/data/software-analysis.json`
- Extract: modules[], functions[], data_flow_graph, traceability_matrix
- Build work queue

**Step 2: Data Structure Extraction**
- `grep` all header files for `struct`, `enum`, `union`, `typedef`
- `read` definitions, generate semantic descriptions
- Output → `.matrix/wiki/data-structures.json`

**Step 3: Module-by-Module Deep Analysis (Topological Order)**

**Critical: Modules are processed in dependency-topological order.**

```
1. Build module-level call graph:
   - For each function's calls[], find the module containing the callee
   - Establish edges: Module A → Module B (A has functions calling into B)

2. Topological sort:
   - In-degree 0 modules (leaf/bottom layer, no project-internal dependencies) first
   - Process in topological order
   - Break cycles by prioritizing modules with fewer functions

3. Per-module analysis (in topological order):
   - Bottom-layer modules: Extract semantics directly from source code
   - Upper-layer modules: Reference already-generated dependency module wikis
     → e.g., when analyzing main_loop, sensor_validation wiki already exists
     → Inject into prompt: "This module calls these already-analyzed modules: [summary A], [summary B]"
```

For each module in topological order:
1. `read` all source files in the module
2. Analyze module-level architecture: responsibility, design patterns, state machines, hardware interactions
3. For each function in the module:
   - Generate semantic summary using source code context + module context
   - Extract algorithm, pre/postconditions, boundary conditions, error handling, side effects
   - Generate testing_hints
4. `write` output: `modules/<name>.json` + `functions/<id>.json`

**Design rationale for batch-per-module**: Functions in the same module share file context. Reading the entire module's source once and analyzing all functions together is more efficient than per-function file reads, and module-level understanding provides better context for function-level analysis.

**Step 4: Global Architecture Synthesis**
- Synthesize from all module analysis results:
  - Project architecture pattern, layering, global data flow paths
  - Technology stack summary
  - Project overview
- `write` output: `index.json`

**Step 5: Markdown Report Generation**
- Identify functional domains by grouping related modules/functions by purpose
- Generate DeepWiki-style Markdown pages with Mermaid diagrams
- Generate `.matrix/reports/code-wiki/` structure
- Generate `SUMMARY.md` for mdbook integration

### 4. Downstream Agent Consumption Protocol

All downstream agents (Phase 2-8) receive this instruction in their system prompts:

```
## Code Knowledge Base
Before starting work, read `.matrix/wiki/index.json` for the project overview.
When you need to understand a module, read `.matrix/wiki/modules/<module_name>.json`.
When you need to understand a specific function's behavior, read `.matrix/wiki/functions/<func_id>.json`.
Only fall back to reading source code directly when the wiki information is insufficient for your task.
```

This replaces reading raw source code (~thousands of tokens per file) with pre-digested semantic summaries (~hundreds of tokens per JSON file), significantly reducing token consumption while ensuring consistent understanding across all phases.

### 5. Implementation Impact

#### New Files

| File | Type | Description |
|------|------|-------------|
| `src/agents/wiki-builder.ts` | Agent | WikiBuilder agent factory + system prompt |
| `src/schema/wiki.ts` | Schema | WikiIndex, ModuleWiki, FunctionWiki Zod schemas |
| `skills/code-wiki/SKILL.md` | Skill | Code understanding methodology (domain identification, Mermaid generation, semantic summary standards) |
| `templates/code-wiki/*.md` | Template | Markdown page templates |

#### Modified Files

| File | Change |
|------|--------|
| `src/agents/builtin-agents.ts` | Register wiki-builder agent |
| `src/agents/conductor.ts` | Dispatch WikiBuilder after Phase 1 (Phase 1b logic) |
| `src/shared/constants.ts` | Add Phase 1b sub-phase definition |
| `src/shared/phase-state.ts` | Track wiki generation state |
| `src/tools/mdbook-generator.ts` | Handle code-wiki subdirectory, generate chapter navigation |
| `src/config/schema.ts` | Add wiki configuration fields |
| `src/agents/req-architect.ts` | Add wiki consumption instructions |
| `src/agents/inspector.ts` | Add wiki consumption instructions |
| `src/agents/unit-tester.ts` | Add wiki consumption instructions |
| `src/agents/env-architect.ts` | Add wiki consumption instructions |
| `src/agents/test-designer.ts` | Add wiki consumption instructions |
| `src/agents/test-executor.ts` | Add wiki consumption instructions |

#### Configuration Extension

```jsonc
// .matrix/config/matrix.jsonc additions
{
  "wiki_enabled": true,          // Whether to generate code wiki (default: true)
  "wiki_mermaid": true,          // Whether to include Mermaid diagrams in Markdown (default: true)
  "wiki_depth": "full"           // "full" | "modules_only" (skip function-level detail)
}
```

### 6. Artifact Layout Summary

```
.matrix/
├── wiki/                              # JSON knowledge base (agent consumption)
│   ├── index.json                     # L1: Global index
│   ├── data-structures.json           # Data structure descriptions
│   ├── modules/
│   │   └── <module_name>.json         # L2: Module-level wiki
│   └── functions/
│       └── <func_id>.json             # L3: Function-level wiki
└── reports/code-wiki/                 # Markdown reports (human browsing + mdbook)
    ├── README.md                      # Overview
    ├── SUMMARY.md                     # mdbook TOC
    ├── architecture.md                # System architecture
    ├── initialization.md              # Initialization process
    ├── main-loop.md                   # Main control loop
    ├── interrupt-system.md            # Interrupt system
    ├── data-structures.md             # Key data structures
    ├── domains/                       # Functional domain pages
    │   └── <domain>.md
    ├── hardware-interfaces.md         # Hardware interfaces
    └── safety-systems.md              # Safety systems
```
