# Warnings And Fallbacks

Prefer explicit incomplete output over fabricated argument values.

## Warn When

- a todo `case_id` is not found in `confirmation-tests.json`
- a step has no usable `key_name`
- a keyword `.json` or `.txt` definition is missing
- `.matrix/data/DTPProject/组合关键字` cannot be found
- a required argument cannot be resolved reliably
- a file-type argument has no matching generated file and supplemental generation fails
- source documents conflict with each other
- a model-provided `protocol_id` conflicts with deterministic step identity, flow, or intrinsic payload-length constraints
- a variable W0-Wn field cannot be resolved and `00` is used
- steps with different variants unexpectedly produce identical bytes
- multiple canonical protocols remain tied after applying explicit payload-length and optional frame-count constraints
- the selected canonical protocol length conflicts with the length explicitly stated in `step_desc`
- a complete canonical packet is unavailable and a case-isolated `case-fallback` file is emitted
- a planned case-step file resolves outside `用例生成/<case_id>`

## Allowed Fallbacks

- continue processing remaining cases and steps
- keep partially resolved arguments with warnings
- generate a supplemental file when source evidence is sufficient
- fill unresolved variable data fields with `00` after exhausting step, TR, support-table, and other-chapter evidence
- keep one independently named file per step while reusing an identical semantic model plan
- in loose mode, emit an isolated `-待确认.txt` placeholder for traceability, but mark the step quality as failed

## Disallowed Fallbacks

- replacing a missing keyword with a semantic neighbor
- treating `${para1}`, `${para2}`, `${para3}` as self-describing
- trusting non-time upstream parameters as final business values
- silently skipping a required file argument
- inventing protocol fields with no source basis
- publishing model `base_bytes` as executable data when no complete canonical protocol is resolved
- publishing intermediate retry files or retaining stale files for the same case and step
- choosing the first same-name canonical protocol merely because it appears first in the definitions file
- selecting a summary or requirement-overview table only because it has high extraction confidence
- writing a case-step fallback directly below the input/output flow root
- treating a whole-packet `00` placeholder as valid executable packet data
