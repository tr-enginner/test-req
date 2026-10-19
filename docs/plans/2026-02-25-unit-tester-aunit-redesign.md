# Unit-Tester AUnit-Driven Workflow Redesign

## Problem

The current unit-tester agent has a fundamental data integrity issue: when using AUnit tools, the agent fabricates data for the Matrix report (`ut_report_add_case/add_result`) instead of reading AUnit's actual execution results from gson files. This creates a disconnect between AUnit's real test data and the Matrix traceability chain.

Additionally, the current design treats AUnit as an optional add-on. The new design makes AUnit the **primary execution engine** with a clear tool-chain-driven flow.

## Design

### Overall Flow

```
unit-tester (AUnit tool chain as main line)
│
├── Step 1: aunit_create_project
├── Step 2: aunit_build
│
├── Step 3: PARALLEL
│     ├─ aunit_autogen (Z3 solver → coverage-driven cases)
│     └─ task(functional-case-gen sub-agent)
│           reads: software-analysis.json, code wiki, requirements
│           outputs: functional test cases in gson case format
│
├── Step 4: aunit_inject_cases (NEW tool)
│     merge functional cases into gson files
│
├── Step 5: aunit_run_case (execute ALL cases: auto-gen + functional)
│
├── Step 6: aunit_sync_report (NEW tool)
│     scan gson → write .matrix/data/unit-tests.json
│
└── Step 7: aunit_report (export AUnit native report)
```

### New Components

#### 1. `aunit_inject_cases` tool (`src/tools/aunit/aunit-inject-cases.ts`)

Injects AI-designed functional test cases into AUnit's gson files so they can be executed by AUnit's runCase command.

**Parameters:**
- `project_name: string` — AUnit project name
- `project_dir: string` — Project root directory
- `function_name: string` — Target function name
- `cases: Array<{desc, paraExprs: [{expr, in}], types?: [{type, comment}]}>` — Cases to inject

**Behavior:**
1. Locate gson file under `.matrix/aunit/<project>/meta/model/UT/uniform/*/` matching `function_name`
2. Read existing gson, find max `caseId` from existing `cases[]`
3. For each injected case: assign incremental `caseId`, fill complete case structure (empty `result`, empty `coverageMap`, `isAIGen: true`)
4. Append to `cases[]`, update `curIndex`
5. Write back gson file

#### 2. `aunit_sync_report` tool (`src/tools/aunit/aunit-sync-report.ts`)

Reads AUnit's actual execution results from gson files and writes them to the Matrix report format. Eliminates agent data fabrication.

**Parameters:**
- `project_name: string` — AUnit project name
- `project_dir: string` — Project root directory
- `version?: string` — Project version (default "1.0")

**Behavior:**
1. Scan `.matrix/aunit/<project>/meta/model/UT/**/*.gson` (exclude preanalysis/)
2. For each gson file: parse `entry.funcName`, `cases[]`, top-level `coverageMap`
3. Map to Matrix format:
   - `paraExprs[].expr` → `inputs[].name`, `paraExprs[].in` → `inputs[].value`
   - `result.obValues[].expr` → `actual_outputs[].name`, `.value` → `.value`
   - `result.status "OK"` → `verdict "pass"`, else → `"fail"`
   - `coverageMap "6/6"` → percentage `100`
4. Write `.matrix/data/unit-tests.json` directly (bypass ut_report tool chain)

#### 3. `functional-case-gen` skill (`skills/functional-case-gen/SKILL.md`)

Methodology skill for the functional test case generation sub-agent.

**Responsibilities:**
- Read `software-analysis.json` for requirements list and traceability matrix
- Read code wiki for function semantics, boundary conditions, error handling
- For each function with requirement traceability, design functional correctness test cases:
  - Equivalence partition (valid/invalid input domains per requirement)
  - Boundary value analysis (parameter extremes, critical conditions)
  - Requirement coverage (at least one positive + one negative case per requirement)
- Output format: JSON array of gson-compatible case structures for `aunit_inject_cases`

#### 4. `unit-tester.ts` prompt rewrite

Replace the current 8-step manual workflow with AUnit-tool-chain-driven flow:
- Main line: create → build → (autogen ∥ functional-gen) → inject → run → sync → report
- Functional case generation via parallel `task` sub-agent with `functional-case-gen` skill
- Data integrity: all report data comes from gson (via sync_report), never fabricated

### Gson Case Structure Reference

```json
{
  "caseId": 5,
  "caseName": "功能用例1",
  "testSetIdex": 0,
  "isAIGen": true,
  "desc": "验证当 a<0 且 b<100 时返回 2*(b+c)",
  "manualCode": "",
  "caseCode": "",
  "iterTimes": "1",
  "property": {},
  "result": {},
  "ManualResult": {"active": false, "status": "UNKNOWN", "description": " "},
  "IOValues": [],
  "gVars": [],
  "manualExprs": [],
  "paraExprs": [
    {"expr": "a", "in": "-1"},
    {"expr": "b", "in": "50"},
    {"expr": "c", "in": "50"}
  ],
  "userDefExprs": [],
  "stubSeqs": [],
  "stubInss": [],
  "stubCallTimes": [],
  "notStubCallTimes": [],
  "types": [{"type": "功能测试", "comment": "", "editable": false}],
  "coverageMap": {}
}
```

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/tools/aunit/aunit-inject-cases.ts` | CREATE | Inject functional cases into gson |
| `src/tools/aunit/aunit-sync-report.ts` | CREATE | Sync gson → Matrix unit-tests.json |
| `src/tools/aunit/index.ts` | MODIFY | Export new tools |
| `src/create-tools.ts` | MODIFY | Register new tools |
| `src/agents/unit-tester.ts` | REWRITE | AUnit-driven workflow prompt |
| `skills/functional-case-gen/SKILL.md` | CREATE | Functional test case generation skill |
