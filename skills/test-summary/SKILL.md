---
name: test-summary
description: "Generate final test summary report aggregating all test data. Calculates metrics (coverage, pass rate, defect density), determines pass/conditional-pass/fail conclusion, identifies risks, and produces the release-quality test summary report."
metadata:
  phase: "8"
  agent: "summarizer"
  category: "quality"
---

## Role

You are a test summary specialist. Aggregate all test data and produce the final test summary report with a release conclusion.

## Aggregation Workflow

### 1. Data Collection
Read project metadata and all structured data:
- `.matrix/data/software-analysis.json` — requirements, function counts, AND project metadata (single source of truth): `csci_name`, `system_name`, `software_level`, `developer_org`, `project_name`, `version`
- `.matrix/config/matrix.jsonc` — administrative metadata only: `project.client_org`, `project.reference_documents[]` — for report header
- `software-analysis.json` — requirements and function counts
- `test-requirements.json` — test requirement spec
- `defects.json` — all defects from all phases
- `unit-tests.json` — unit test results and coverage
- `source-confirmation-tests.json` — reviewed human-readable confirmation test cases
- `confirmation-tests.json` — translated executable confirmation test cases used by Phase 6 execution/DTP
- `phase6-execution-loop.json` — Phase 6 DTP execution gate, coverage/pass-rate threshold decisions, and optimization-loop history
- `test-execution.json` — confirmation test results
- Review records from `.matrix/data/reviews/`

### 2. Metrics Calculation
Compute precise metrics:

| Metric | Formula |
|--------|---------|
| Requirement Coverage | (covered requirements / total requirements) * 100 |
| Test Case Pass Rate | (passed / total executed) * 100 |
| Defect Density | total defects / KLOC |
| Open Defect Rate | open defects / total defects |
| Statement Coverage | from coverage_report |
| Branch Coverage | from coverage_report |
| MC/DC Coverage | from coverage_report (if applicable) |
| Condition Coverage | from test-execution coverage if available |
| Path Coverage | from test-execution coverage if available |

### 3. Conclusion Determination

| Conclusion | Criteria |
|-----------|----------|
| **PASS** | Coverage >= 100%, Pass Rate >= 95%, 0 open critical defects |
| **CONDITIONAL_PASS** | Coverage >= 90%, Pass Rate >= 80%, critical defects have approved waivers |
| **FAIL** | Any criteria below CONDITIONAL_PASS thresholds |

### 4. Risk Identification
Flag risk items:
- Uncovered requirements (no test case executed)
- Blocked test cases (could not execute)
- Open major/critical defects
- Coverage gaps (below target for any metric)
- Waived defects that may have safety implications

### 5. Recommendations
Generate actionable recommendations:
- Specific to identified gaps (not generic advice)
- Prioritized by risk severity
- Include effort estimate: Quick / Short / Medium / Large

## Output

Write `TestSummary` to `.matrix/data/test-summary.json`:
```
{
  project_name, version, date, conclusion, conclusion_rationale,
  metrics: { requirement_coverage_pct, total_test_cases, pass_rate,
             total_defects, open_defects, critical_defects,
             coverage: { statement, branch, mc_dc } },
  risk_items: { description, severity, mitigation }[],
  recommendations: string[]
}
```

Generate final report at `.matrix/reports/test-summary.md` using `doc_generator`. Include project metadata from software-analysis.json (CSCI name, system name, software level, developer org, version) and admin metadata from config (client org, reference documents) in the report header.

## Gating Logic

- **FAIL** conclusion blocks software release
- **CONDITIONAL_PASS** indicates accepted risks requiring mitigation tracking
- **PASS** clears software for release at the tested scope
