---
name: spec-implementation-review
description: "Requirement-to-code consistency review for embedded C/C++: decompose requirements into atomic assertions, formalize requirement intent vs executable behavior, compare across D1-D10, and record requirement_mismatch defects with precise traceability."
metadata:
  phase: "3"
  agent: "spec-implementation-review"
  category: "quality"
---

## Use This Skill For

- `spec-implementation-review`
- any per-requirement document-implementation consistency review flow

Do not use this skill for behavioral safety defect hunting. That belongs to `behavioral-safety-review`.

## Core Rules

- Merge full requirement context before review.
- Find all implementing code, including distributed helpers and ISR paths.
- Break compound requirements into atomic sub-items.
- For every sub-item, formalize both `Req specifies` and `Code does`.
- Every `MISMATCH` must produce a defect with exact location and corrective expectation.
