# Resource And Validation

## Purpose

Use `组合关键字` only for:

- keyword existence validation
- locating `.txt` files for `Resource`

Do not use `组合关键字` for semantic keyword matching in this skill.

## Validation Rule

For each step:

1. Read upstream `keyword_name`.
2. Look for an exact keyword-name match in `组合关键字`.
3. If found, mark the step as validated and resolve the keyword `.txt` file for `Resource`.
4. If not found, downgrade the step to a description-style step, keep rendering the case, and emit a warning.

## Resource Collection

Collect `Resource` lines from the set of validated keyword `.txt` files used by the case.

Rules:

- deduplicate resource paths
- keep paths relative to the Robot output directory
- render paths with double backslashes

Example:

```robotframework
Resource    组合关键字\\VTest.txt
```

## Missing Resource Behavior

If the keyword exists but the `.txt` file is missing:

- continue rendering
- emit a warning in the result JSON
- do not invent a replacement resource path

## Missing Keyword Behavior

If the keyword itself is missing:

- downgrade that step to a description-style step
- continue rendering the rest of the case
- increment a downgraded-step counter in the result JSON
