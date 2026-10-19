---
name: behavioral-safety-review
description: "Behavioral safety review for embedded C/C++: inspect per-file code for concrete semantic and execution-time failures such as buffer overflow, integer overflow, division by zero, concurrency defects, resource leaks, null or dangling pointers, double free, float traps, misaligned access, and uninitialized use."
metadata:
  phase: "3"
  agent: "behavioral-safety-review"
  category: "quality"
---

## Use This Skill For

- `behavioral-safety-review`
- any standalone per-file behavioral safety review flow

Do not use this skill for requirement-to-code consistency review. That belongs to `spec-implementation-review`.

## Core Rules

- Analyze all discovered C/C++ implementation files in `target_dir` mode.
- Every reported defect must include a concrete trigger and a concrete consequence.
- The workflow is mandatory: function inventory -> function batches -> batch artifacts -> final single-file merge.
- Always use the rigid tool chain:
- `behavior_safety_plan`
- `behavior_safety_run_batch`
- `behavior_safety_finalize`
