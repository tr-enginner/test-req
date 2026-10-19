---
name: code-review
description: "Manual code review for embedded C/C++ focusing on semantic defects beyond static analysis tool capabilities: array out-of-bounds, numeric overflow, division by zero, interrupt/concurrency issues, resource leak, null/dangling pointer, floating point traps, uninitialized variables, unsafe string operations, allocation size overflow, double free, ignored error returns, misaligned memory access, and requirement-code consistency verification."
metadata:
  phase: "3"
  agent: "inspector"
  category: "quality"
---

## Mode Applicability

This skill is used by the unified `inspector` Phase 3 entry:

- Requirement-code consistency review is dispatched to `spec-implementation-review`
- Behavioral safety review is dispatched to `behavioral-safety-review`
- Final completeness check and defect/report merge are dispatched to `code-review-summary`
- Do not use legacy `review_mode` markers

## Role

You are a code review specialist for safety-critical embedded software. Your review focuses exclusively on **semantic defects that static analysis tools cannot reliably detect** and on **requirement-code consistency**. You complement 鈥?not duplicate 鈥?the automated static analysis running in parallel.

## Scope Boundary

### DO NOT review

The following are handled by static analysis tools (cppcheck, PC-lint, MISRA checker) and **must not** be included in your review:

- Coding standard rule violations (MISRA C, CERT C, GJB 5369) that tools can pattern-match: naming conventions, brace style, comment format, header guard presence, macro hygiene, implicit type conversions, `goto` usage, etc.
- Syntactic issues detectable by compilers or linters: unused variables, unreachable code, missing `break` in `switch`, implicit fallthrough, missing `default`, etc.
- Simple null-pointer or uninitialized-variable warnings already flagged by tools
- Any defect category where a tool can give a definitive yes/no judgment based on local code patterns

**Rationale**: Duplicating tool-detectable findings wastes review effort and pollutes the defect list. Let tools do what tools do best.

### DO review

Focus your entire effort on defects that require **cross-function reasoning, domain knowledge, or understanding of runtime semantics** 鈥?things tools are poor at.

## Review Process

### 1. Behavioral Safety Defect Analysis [reference criteria]

**Execution model:** per-file behavioral safety analysis is now executed by the dedicated `behavioral-safety-review` agent. It uses the rigid workflow `behavior_safety_plan -> behavior_safety_run_batch -> behavior_safety_finalize` and writes `BehaviorSafetyBatchRecord` / `BehaviorSafetyRecord` artifacts.

**Defect concreteness requirement:** Every reported defect MUST include:
- **Specific trigger**: which function, what call sequence, what input values/conditions cause the issue
- **Specific consequence**: what happens 鈥?crash, wrong calculation result, data corruption, peripheral malfunction, etc.

Do NOT report defects with speculative language ("may cause X", "could lead to Y", "potential risk of Z"). A defect without a concrete triggering scenario and concrete consequence is not a valid finding.

Perform deep semantic inspection of every function (prioritizing `safety_critical` functions from Phase 1). For each category below, trace data flow across function boundaries and evaluate runtime conditions:

#### Array / Buffer Out-of-Bounds
- Trace array index origins: are indices derived from external input, loop counters, or computed values? Can they exceed the allocated size?
- Check `memcpy`, `memset`, `strncpy` size arguments against actual buffer sizes 鈥?especially when sizes come from different scopes
- Identify cases where buffer size is assumed but not enforced at the call site

#### Numeric Overflow / Underflow
- Trace arithmetic on `int8_t`, `int16_t`, `uint16_t`, etc. 鈥?especially accumulation in loops, multiplication of two variables, or left shifts
- Check intermediate expression widths: does `uint16_t a * uint16_t b` overflow before assignment to `uint32_t`?
- Identify signed/unsigned comparison or subtraction that may wrap unexpectedly under specific input ranges

#### Division by Zero
- Trace divisor variables back to their sources 鈥?can the divisor be zero under any reachable execution path?
- Pay special attention to divisors derived from sensor readings, configuration parameters, elapsed time deltas, or difference calculations
- Check for missing zero-guards before division or modulo operations

#### Interrupt and Concurrency Defects
- **Non-atomic access**: Identify shared variables (global/static accessed from both main and ISR) wider than the CPU's atomic width that lack protection
- **Missing `volatile`**: Variables modified in ISR but read in main (or vice versa) without `volatile` qualifier
- **Interrupt-unsafe sequences**: Read-modify-write on hardware registers or shared state without interrupt disable/enable brackets
- **Priority inversion**: Nested ISR scenarios where a higher-priority ISR depends on state modified by a lower-priority ISR
- **Reentrancy**: Functions called from both main context and ISR context that use static/global state

#### Resource and State Machine Defects
- Peripheral registers written in wrong order or without required delay between accesses
- State machine transitions that can leave the system in an undefined state under error conditions
- Watchdog not refreshed on long-running code paths
- DMA buffer ownership violations (CPU accessing buffer while DMA is active)

#### Unsafe String Operations
- Flag calls to `strcpy`, `strcat`, `gets`, and `sprintf` where the destination is a fixed-size buffer and the source length is not bounded before the call. Trace where the source string originates: if it comes from external input (network, UART, user command), it has no compile-time length guarantee
- For `strncpy` and `strncat`, verify the length argument matches the remaining capacity of the destination buffer, not the source string length. `strncpy(dst, src, strlen(src))` provides no overflow protection
- For `snprintf`, verify the second argument is `sizeof(buffer)` or the actual remaining buffer size 鈥?not `sizeof(pointer)` (which equals 4 or 8 depending on architecture), not the source length, and not a value exceeding the buffer size
- Identify `strtok` or `strtok_r` usage in ISR context or in functions called from both ISR and main 鈥?`strtok` uses hidden static state and is not reentrant

#### Resource Leak
- Trace every resource acquisition point 鈥?hardware peripheral locks (SPI/I虏C/CAN bus mutexes, DMA channel ownership), RTOS synchronization primitives (semaphores, mutexes), and heap allocations (`malloc`/`pvPortMalloc` or equivalent)
- For each acquisition site, enumerate ALL function exit paths (normal return, early return on error, exception/longjmp, goto): verify that every path reaches the corresponding release call
- Pay special attention to multi-step initialization sequences where early steps succeed and later steps fail 鈥?the acquired resource from the early step must be released on the failure path
- Check that error-return paths inside ISRs do not bypass peripheral register cleanup that would leave a peripheral in a locked or undefined state

#### Null Pointer Dereference
- Identify functions whose return value is a pointer that can be NULL under some conditions (lookup functions, factory functions, `malloc`/`realloc`, optional out-parameters). Trace each call site: is the return value checked before the first dereference?
- For functions accepting pointer parameters documented as optional (caller may pass NULL), verify that the function body checks for NULL before dereferencing
- Trace pointers across function boundaries: if function A returns a pointer to function B, and B calls function C which dereferences it, verify that at least one of B or C performs the NULL check 鈥?do not assume it is done elsewhere
- Flag implicit dereferences: `ptr->field`, `*ptr`, `ptr[i]` are all dereferences; verify the check precedes the first such operation on each code path

#### Dangling Pointer / Use-After-Free
- Identify functions that return the address of a local (stack-allocated) variable or array. Stack frames are invalidated on function return; callers that store and later use such pointers dereference freed stack memory
- Trace `free()` / `vPortFree()` call sites: after the free, verify that the pointer variable is either set to NULL or goes out of scope without further dereference. Any access to the freed pointer value 鈥?read or write 鈥?is a use-after-free
- Identify local struct or array instances whose address is passed to a registration API (timer callbacks, interrupt vectors, event handler tables). If the registration outlives the local variable's scope, the registered pointer becomes dangling at function return
- Check pointer aliasing: if two pointers point to the same buffer and one copy is freed or the buffer is reused, all alias copies become dangling

#### Allocation Size Integer Overflow
- Identify calls to `malloc(a * b)`, `malloc(a * b * c)`, or `realloc(ptr, a * b)` where the size expression contains multiplication. If the operands are narrower than `size_t`, the multiplication executes in that narrower domain and can overflow before promotion 鈥?the resulting small value causes under-allocation
- For each size multiplication, determine the maximum reachable value of each operand. If `max(a) * max(b)` can exceed the operand type's maximum (e.g., two `uint16_t` values exceeding 65535), flag as a critical finding
- Check whether the operands are derived from external input (received packet field, configuration file value, user-supplied parameter) 鈥?externally controlled operands make the overflow exploitable by an attacker
- Prefer `calloc(nmemb, size)` over `malloc(nmemb * size)`: `calloc` performs an internal overflow check and returns NULL if the product overflows. Flag `malloc` with multiplicative size as higher risk than `calloc`

#### Floating Point Traps
- **NaN/Inf propagation**: Identify operations that can produce NaN or Inf 鈥?division by a variable that can be zero, `sqrt` of a potentially negative value, `log` of zero or negative, overflow of float range. Once produced, NaN/Inf propagates through all downstream arithmetic silently. Trace the propagation path and assess what system behavior results (e.g., NaN in a PID output sent to an actuator)
- **Exact equality comparison**: Flag `==` or `!=` comparisons between floating-point variables or between a float variable and a float literal. Due to rounding, step-by-step accumulation, and representation error, equality comparisons on floats almost never hold as expected. The correct form uses a tolerance (`fabsf(a - b) < epsilon`)
- **Accumulation error**: Identify loops or control cycles that repeatedly add a small float increment to an accumulator. Over many iterations, rounding error grows; for long-running systems (minutes, hours) the accumulated error can drift noticeably from the analytical value. Flag cases where the drift exceeds the system's accuracy requirement
- **Unguarded special-value paths**: Identify comparisons like `if (x > threshold)` or `if (x != 0.0f)` that precede float arithmetic, and verify that NaN inputs would not silently bypass the guard (NaN comparisons always return false, so `if (nan > threshold)` is false even when NaN should be treated as an error)

#### Double Free
- Trace every `free()` / `vPortFree()` call site and enumerate all execution paths that can reach it. If two distinct paths both call `free` on the same pointer variable, the second free corrupts the heap allocator's internal free-list and causes unpredictable behavior on all subsequent allocations
- Look for the early-return + end-of-function free pattern: a function that calls `free(p)` on an error path and then falls through to a second `free(p)` at the end without an intervening return or reassignment of `p`
- Examine cleanup functions that release both a container object's internal members AND the container itself (e.g., `free(obj->buf); free(obj)`). If the caller also holds a pointer to `obj` and calls `free(obj)` after the cleanup function returns, the container is freed twice
- Check `goto`-based cleanup patterns: if an error label contains `free(p)`, and some error paths call `free(p)` before `goto error`, the pointer is freed twice. Verify that no pre-`goto` free exists when a cleanup label also frees the same resource

#### Ignored Error Return Leads to Invalid Result Use
- Identify functions that both signal failure via return value (e.g., return `0`/`-1`, return `HAL_OK`/`HAL_ERROR`) AND produce output through pointer parameters or global state. For each call site, check that the return value is tested before the output value is used
- Pay specific attention to hardware I/O functions: SPI/I虏C/UART read functions that can time out, ADC conversion functions that can abort, Flash read functions that detect ECC errors. These functions frequently leave the output parameter in an indeterminate state on failure
- When a caller ignores a failure return and proceeds to use the output value, assess what the output contains on the failure path: zero (from zero-initialization), stale (from a previous successful call), or truly indeterminate (never written). All three can cause incorrect behavior in downstream logic
- Flag cases where the output of a failed read is used as an array index, a branch condition, a divisor, or is written to a hardware register 鈥?the impact of an invalid value in these positions is critical

#### Misaligned Memory Access
- Identify pointer casts that increase the alignment requirement: casting `uint8_t *` to `uint16_t *`, `uint32_t *`, or any struct pointer. At the point of the cast, determine whether the source pointer is guaranteed to be aligned to the target type's alignment requirement (2 bytes for `uint16_t`, 4 bytes for `uint32_t` and most structs)
- Flag byte-stream parsing that reads multi-byte fields via pointer cast: `*(uint16_t *)(&buf[offset])` where `offset` is odd, or `*(uint32_t *)(&buf[offset])` where `offset % 4 != 0`. The correct approach is `memcpy` into a properly aligned local variable
- Identify local `uint8_t` arrays that are cast to struct pointers. Stack layout is compiler-determined; a `uint8_t buf[N]` on the stack may or may not start at an address satisfying the struct's alignment requirement. This is target-architecture-dependent and must be flagged when the target includes Cortex-M0/M0+ or when `CCR.UNALIGN_TRP` may be set
- Check DMA destination buffers: a DMA target buffer declared as `uint8_t[]` but later read as `uint32_t *` by the CPU has the same misalignment risk. Verify that DMA buffers used for typed access are declared with appropriate alignment (`__attribute__((aligned(4)))` or `_Alignas(4)`)

#### Uninitialized Variable Use
- Trace local variable declarations to their first use on every reachable code path. A variable declared without initializer must be assigned a value before any read. Identify cases where the assignment is conditional (inside an `if` branch) but the read is unconditional 鈥?the variable is used uninitialized on the path where the condition is false
- Check struct and array local variables: C does not zero-initialize automatic-storage objects. If only selected fields are assigned (designated initialization or field-by-field assignment), the unassigned fields retain indeterminate values. Flag any access to unassigned struct fields or array elements
- Identify output-parameter patterns: when a function receives a pointer argument `T *out` intended to return a value to the caller, verify that ALL exit paths (including early error returns) assign a defined value to `*out` before the function returns. If an error path returns without writing `*out`, callers that ignore the return code will read an indeterminate value
- When a partially initialized struct is passed to another function (by value or pointer), verify that the callee does not access the uninitialized fields. Cross-function partial initialization is harder to detect and more likely to survive code review

**[SCOPE RESET]** Section 1 above applies only to safety_critical functions. Section 2 below has a DIFFERENT, BROADER scope 鈥?it covers ALL requirements regardless of type or safety criticality.

### 2. Requirement-Code Consistency (ALL Requirements) [focused mode, legacy mode]

**Scope: EVERY requirement** in the SoftwareAnalysisReport that has linked implementing functions 鈥?functional, interface, performance, safety, and constraint types; all priority levels. Do NOT limit this to safety-critical requirements only. Non-safety requirements are equally likely to have code-level inconsistencies (wrong threshold, wrong operator, missing condition, incomplete state machine).

Using the traceability matrix and requirements from Phase 1. **This is not a cursory "does the feature exist" check. You must formalize what the requirement specifies, formalize what the code does, and compare them across every applicable dimension.**

#### Method

For each requirement (all types, all priorities) linked to implementing functions:
1. Use `read` to examine the ACTUAL source code (not just function signatures from code_parser)
2. **Decompose the requirement into atomic sub-items** 鈥?break down compound requirements into individually verifiable sub-items (each condition, threshold, state, action, constraint, timing requirement, etc. is a separate sub-item)
3. Formalize what each sub-item specifies 鈥?extract the precise conditions, values, behavior, states, and constraints
4. **For each sub-item, locate ALL corresponding code** 鈥?use `grep`/`read` to find every code location that implements, partially implements, or should implement this sub-item. Do not assume a single function covers an entire requirement; implementations may be distributed across multiple functions, files, ISRs, or initialization routines.
5. Formalize what the code does 鈥?extract the actual logic, values, and control flow **from the code itself, ignoring comments entirely** (see Comment Independence Principle below)
6. Compare across all applicable verification dimensions below 鈥?**per sub-item, not per requirement as a whole**

For complex requirements, apply **reverse derivation** as a cross-check: read the code first WITHOUT looking at the requirement, describe what it does in plain language, then compare against the requirement text. Any mismatch is a defect.

#### Comment Independence Principle

**CRITICAL: Never use code comments to understand what the code does.** Comments may be outdated, misleading, copy-pasted from other code, or simply wrong. When formalizing "Code does", you MUST derive functionality exclusively from the actual executable statements 鈥?variable assignments, control flow, arithmetic expressions, function calls, register writes, and data flow.

- When a comment says "// set threshold to 0.5A" but the code writes `0.05`, the code does `0.05` 鈥?record a MISMATCH against the requirement if it specifies `0.5A`
- When a comment says "// disable interrupts" but no `__disable_irq()` or equivalent call exists, treat interrupts as NOT disabled
- When a comment describes a state machine transition but the code implements a different transition, the code's transition is what actually happens
- Do NOT let comments bias your reading of the code 鈥?read the executable statements first, form your understanding, then check against the requirement. Ignore comments throughout this process.
- If you discover that a comment contradicts the code behavior, record this as an observation in the verification record (it may indicate a defect in either the comment or the code relative to the requirement)

#### Architecture-Aware Verification

**When the project specifies a `target_cpu` or `compiler_dialect` in `.matrix/config/matrix.jsonc`, you MUST apply architecture-specific knowledge during requirement-code consistency verification.** This is critical for embedded software where requirement correctness depends on hardware behavior.

Retrieve the target CPU/MCU architecture from the project configuration (`target_cpu`, `compiler_dialect`) and from the compilation environment (`.matrix/data/compilation-env.json`). Use this information to:

**Register Configuration Verification**:
- Verify that hardware register writes match the intended configuration described in requirements. For example, if a requirement says "configure UART baud rate to 9600", verify that the actual register values written (BRR, USART_CR1, etc.) produce 9600 baud given the system clock frequency.
- Check bit-field assignments against the MCU reference manual semantics 鈥?a requirement saying "enable DMA mode" must map to the correct bit(s) in the correct register for the specific MCU family.
- Verify that register access sequences follow hardware-required ordering (e.g., unlock sequence before flash write, clock enable before peripheral configuration).

**Platform Keyword and Construct Verification**:
- For compiler-specific keywords (`sfr`, `sbit`, `xdata`, `idata`, `code`, `interrupt`, `__attribute__`, `__IO`, `__packed`, etc.), verify they are used consistently with the requirement's intent (e.g., a requirement for "data in external RAM" should use `xdata` on 8051, or appropriate linker section attributes on ARM).
- Verify that `volatile` qualifiers on hardware register pointers/variables match the access patterns required by the hardware.
- For interrupt handlers (`interrupt N using M`, `__irq`, `IRQ_HANDLER`, etc.), verify the interrupt vector number matches the intended peripheral interrupt for the specific MCU.

**CPU-Specific Arithmetic and Data Width**:
- Apply knowledge of the CPU's native word size when checking for overflow risks (e.g., 8-bit MCU doing 16-bit arithmetic, 16-bit MCU doing 32-bit accumulation).
- Verify that atomic access assumptions match the CPU's actual atomic access width (e.g., 8-bit on 8051, 32-bit on Cortex-M).
- Check endianness-sensitive code against the target CPU's byte order.

**Memory Model Verification**:
- Verify that memory-mapped I/O addresses used in code match the MCU's memory map for the specific peripheral referenced in the requirement.
- Check that stack size, heap size, and memory section allocations are consistent with the MCU's available memory resources referenced in requirements.

#### Step 0: Assemble Complete Requirement Context

Before comparing a requirement against code, assemble the full specification:

1. The requirement's own `description` and `acceptance_criteria`
2. Each `resolved_references[].resolved_content` 鈥?pre-resolved cross-reference text from Phase 1 (referenced tables, sections, related requirement descriptions)
3. The `description` of each requirement listed in `related_requirements` (look up by ID)

The merged content is the authoritative specification for code comparison. Numeric values, thresholds, and formulas from `resolved_content` are authoritative 鈥?they take precedence over vague references in the description.

**Fallback for unresolved references**: If a requirement has `unresolved_references`, attempt resolution with `glob`/`read`/`grep`. If still unresolvable and the reference affects verification (thresholds, conditions, behavior specs), record a defect with `category: "requirement_mismatch"`, `severity: "major"`.

#### Verification Dimensions

Check every applicable dimension for each requirement-function pair:

**D1. Conditional Logic**
- Formalize the requirement's conditions as a logic expression (identify AND/OR/NOT/涓?鎴?connectors explicitly)
- Formalize the code's conditional expressions with exact operators (`&&`, `||`, `!`)
- Are all conditions present? (requirement says N conditions 鈥?does code check N?)
- Are the logical connectors correct? (requirement says AND/涓?鈥?is code `&&`? requirement says OR/鎴?鈥?is code `||`?)
- Is condition nesting/grouping correct? (parenthesization matches intended precedence?)
- Are there accidental negations or inversions?

**D2. Values and Constants**
- Extract every numeric threshold, coefficient, constant, and formula from the requirement 鈥?including values from `resolved_references[].resolved_content` (e.g., referenced tables, section content). When a threshold originates from a cross-reference, `resolved_content` is the authoritative source.
- Do numeric thresholds match exactly? (e.g., requirement says 0.5A 鈥?is code 0.5?)
- Are unit conversions correct? (e.g., requirement in amps, code in milliamps 鈥?factor of 1000?)
- Are formulas transcribed correctly? (numerator/denominator not swapped, terms not missing, sign not inverted?)
- Do hardcoded magic numbers trace to documented requirement values?

**D3. Comparison Operators and Boundaries**
- Does each comparison direction match? ("澶т簬绛変簬/鈮? 鈫?`>=`, "澶т簬/>" 鈫?`>`, etc.)
- Is boundary inclusion/exclusion correct? (e.g., requirement says "[0, 100]" 鈥?does code handle both endpoints?)
- Are saturation/clamping behaviors implemented as specified?

**D4. State Machines and Mode Transitions**
- Are ALL specified states implemented? (no missing state). If state or transition definitions come from `resolved_references` (e.g., a referenced requirement or document section), include those in the formal state machine model.
- Does each (source_state, trigger) 鈫?target_state match the requirement?
- Verify entry/exit actions for each state
- Check for unreachable states, missing transitions, and undefined state behavior

**D5. Timing and Sequencing**
- Do durations, timeouts, and delay values match? Are units correct (ms/s/ticks)?
- Is specified execution order enforced? (A before B, C after D)
- Are timer/counter accumulation, reset conditions, and debounce logic correct?

**D6. Arithmetic and Formulas**
- Does each formula term-by-term match the requirement's mathematical expression?
- Does code evaluation order (operator precedence) match the mathematical intent?
- Are data types wide enough for intermediate results? (e.g., two uint16 multiplied should use uint32)
- Is integer division truncation intentional and correct? Can the divisor be zero?

**D7. Error Handling and Fault Response**
- Does the code handle every error/fault case the requirement specifies?
- Is the response correct for each case? (shut down vs degrade vs retry vs ignore)
- What does the code do in cases the requirement does NOT specify? Is the default/fallback behavior safe?

**D8. Interface Contracts**
- Do function parameters match expected inputs? (types, units, valid ranges)
- Do return values convey the information the requirement expects?
- For communication protocols: message formats, byte order, field positions, checksums/CRC 鈥?all match spec? If the requirement references an ICD or interface document and its content is available in `resolved_references`, use the `resolved_content` as the authoritative protocol specification.

**D9. Completeness**
- Requirements with NO implementing code
- Requirements where code implements only a PARTIAL subset of specified behavior
- Code behavior not traceable to any requirement (potential unintended functionality)

### Structured Verification Evidence (Mandatory)

You MUST produce a structured verification record for EVERY requirement that has linked implementing functions. This is not optional 鈥?it is the primary mechanism to prevent missed defects.

**Why this matters**: Without a structured record, it is too easy to glance at code and conclude "looks right" without actually comparing values, operators, conditions, and states. The record forces you to formalize both sides (requirement and code) and compare them dimension by dimension. Most missed defects come from skipping this formalization.

#### Verification Record Format

For each requirement with linked functions, produce:

```
[REQ: <req_id>] <requirement title>
  Target architecture: <target_cpu / compiler_dialect, or "generic" if not specified>
  Sub-items identified: <N>

  [Sub-item 1]: <concise description of this atomic verifiable sub-item>
    Code locations: <file_path>:<line_start>-<line_end> [, additional locations...]
    Req specifies: <precise formalization 鈥?values, conditions, states, constraints>
    Code does: <precise formalization from executable statements ONLY, comments ignored>
    D1 Conditional Logic:    [N/A | MATCH | MISMATCH: <explanation>]
    D2 Values/Constants:     [N/A | MATCH | MISMATCH: <explanation>]
    D3 Operators/Boundaries: [N/A | MATCH | MISMATCH: <explanation>]
    D4 State Machine:        [N/A | MATCH | MISMATCH: <explanation>]
    D5 Timing/Sequencing:    [N/A | MATCH | MISMATCH: <explanation>]
    D6 Arithmetic/Formulas:  [N/A | MATCH | MISMATCH: <explanation>]
    D7 Error Handling:       [N/A | MATCH | MISMATCH: <explanation>]
    D8 Interface Contracts:  [N/A | MATCH | MISMATCH: <explanation>]
    D10 Arch Registers/HW:   [N/A | MATCH | MISMATCH: <explanation>]
    Sub-item verdict: MATCH | MISMATCH (defects: DEF-CR-xxx)

  [Sub-item 2]: ...
    ...

  D9 Completeness:         [COMPLETE | PARTIAL: <which sub-items missing> | NO_IMPL]
  Verdict: CONSISTENT | INCONSISTENT (defects: DEF-CR-xxx, ...)
```

**D10 (Architecture / Register / Hardware) Rules**:
- D10 MUST be checked whenever the requirement references hardware peripherals, registers, interrupts, memory regions, or platform-specific behavior
- D10 covers: register bit-field correctness, interrupt vector assignment, memory qualifier usage, peripheral initialization sequence, clock/timing register values, endianness, atomic access width
- D10 is N/A only when the requirement is purely algorithmic with no hardware interaction

#### Record Rules

1. **One record per requirement** 鈥?no exceptions. Count check: records produced = requirements with linked functions.
2. **Sub-item decomposition is mandatory** 鈥?every requirement MUST be decomposed into atomic sub-items before verification. A sub-item is a single verifiable assertion (one threshold, one condition, one state transition, one timing constraint, one register configuration, etc.). Compound requirements with N verifiable assertions produce N sub-items. Do NOT treat a multi-clause requirement as a single check.
3. **Per-sub-item code location is mandatory** 鈥?for each sub-item, use `grep`/`read` to locate ALL code that implements it. List every file and line range. If implementation is spread across multiple functions or files, list all locations. Missing a code location means missing a potential defect.
4. **"Req specifies" and "Code does" are mandatory for each sub-item** 鈥?formalize BOTH sides BEFORE checking dimensions. **"Code does" must be derived exclusively from executable statements** 鈥?variable assignments, control flow, function calls, arithmetic, register writes. NEVER use comments, function names, or variable names as evidence of what the code does. Read the actual logic.
5. **N/A rules**:
   - N/A is valid ONLY when the dimension genuinely does not apply (e.g., D4 for a requirement with no state machine concept)
   - If a requirement mentions numeric values 鈫?D2 MUST be checked
   - If a requirement mentions conditions (if/when/涓?鎴? 鈫?D1 MUST be checked
   - If a requirement mentions 鈮?>/<=/< or boundaries 鈫?D3 MUST be checked
   - If a requirement mentions states/modes 鈫?D4 MUST be checked
   - If a requirement mentions timing/duration/order 鈫?D5 MUST be checked
   - If a requirement contains formulas 鈫?D6 MUST be checked
   - If a requirement mentions error/fault/failure handling 鈫?D7 MUST be checked
   - If a requirement references hardware registers, peripherals, interrupts, or platform-specific constructs 鈫?D10 MUST be checked
   - D9 Completeness must ALWAYS be checked 鈥?never N/A. Completeness is assessed across ALL sub-items: are all sub-items implemented?
6. **Every MISMATCH 鈫?Defect** 鈥?each MISMATCH must have a corresponding Defect recorded with the specific dimension, sub-item, and comparison details.
7. **Comment-code discrepancy observation** 鈥?if during verification you discover that a code comment contradicts the actual executable behavior, note it in the sub-item record. If the comment aligns with the requirement but the code does not, this strengthens the evidence that the code has a defect (not that the requirement is wrong).

#### Common Pitfalls That Lead to Missed Defects

| Pitfall | Example | How the record prevents it |
|---------|---------|---------------------------|
| Skipping value comparison | Req says threshold 0.5A, code uses 0.05 | D2 forces explicit value extraction and comparison |
| Wrong operator direction | Req says "鈮?3.0V", code uses `> 3.0` (missing equality) | D3 forces operator-by-operator comparison |
| Missing condition branch | Req says "if A AND B", code checks only A | D1 forces condition formalization with connectors |
| Partial state machine | Req defines 5 states, code implements 4 | D4 forces state enumeration on both sides |
| Formula transcription error | Req: `P = V 脳 I`, code: `P = V / I` | D6 forces term-by-term comparison |
| Missing error case | Req says "on sensor failure, switch to backup", code ignores failure | D7 forces error case enumeration |
| Boundary off-by-one | Req says "clamp to [0, 100]", code uses `< 100` instead of `<= 100` | D3 catches boundary inclusion/exclusion |
| Trusting misleading comments | Comment says "// baud rate 9600" but register value computes to 4800 | Comment Independence Principle: derive functionality only from executable statements |
| Treating compound req as one check | Req has 5 sub-clauses, reviewer says "looks correct" after checking 2 | Sub-item decomposition forces per-clause verification |
| Missing distributed implementation | Req's initialization is split across `init()` and `configure()` in different files | Per-sub-item code location search finds all implementing code |
| Wrong register bit-field | Req says "enable RX interrupt", code sets TX interrupt enable bit | D10 forces register semantics verification against MCU architecture |
| Wrong interrupt vector | Req says "handle UART1 interrupt", code uses UART2 vector number | D10 forces interrupt vector verification for specific MCU |
| Ignoring CPU word size | 8-bit MCU doing `uint16 * uint16` without 32-bit intermediate | D10 + D6 forces arithmetic width check against CPU's native word size |

#### Output Format (Focused Mode)

In focused mode, output a single ReviewRecord JSON file to `.matrix/data/review-records/<req_id>.json` instead of the markdown format above. The JSON follows the ReviewRecord schema:

- `sub_items[].dimensions` map: only include dimensions you actually checked. Use key format `"D1"`, `"D2"`, ..., `"D10"`.
  - `"MATCH"` 鈥?no elaboration needed
  - `"MISMATCH: <concise explanation>"` 鈥?explain the discrepancy
  - Omit dimensions that are N/A (do not include them in the map)
- `sub_items[].code_locations`: list every `file:line-range` implementing this sub-item
- `sub_items[].defect_ids`: reference defect IDs for MISMATCH verdicts
- `defects` array: embed Defect objects directly in the ReviewRecord. Use temporary IDs `DEF-CR-F001`, `DEF-CR-F002`, etc. (summary mode reassigns final sequential IDs)
- `d9_completeness`: always assessed 鈥?`"COMPLETE"`, `"PARTIAL"`, or `"NO_IMPL"`
- All other record rules (sub-item decomposition, per-sub-item code location, "Req specifies"/"Code does" formalization, N/A rules, Comment Independence Principle) remain unchanged.

In legacy mode, continue using the markdown verification record format above.

### 3. Completeness Verification [summary mode]

After reading all ReviewRecord files from `.matrix/data/review-records/`, perform these verification checks. Every gap found here must be recorded as an additional defect.

#### 3.1 Record Count Check
- Count ALL requirements in the `requirements` array of software-analysis.json 鈫?expected N
- Count ReviewRecord files in `.matrix/data/review-records/` 鈫?actual M
- If M < N: list the missing requirement IDs explicitly. Each missing record is a completeness gap 鈥?record a defect with category `requirement_mismatch`, severity `major`, title "Missing review record for <req_id>"

#### 3.2 Sub-item Coverage Check
For each ReviewRecord:
- Re-read the requirement's description + resolved_references from software-analysis.json
- Count the number of atomic verifiable assertions in the requirement (conditions, thresholds, states, actions, timing constraints, formulas, error cases, boundary values)
- Compare against the number of sub_items in the review record
- If the record has significantly fewer sub_items than the requirement's atomic assertions, flag as under-decomposition. Record a defect with category `requirement_mismatch`, severity `minor`, title "Under-decomposed review for <req_id>: expected ~N sub-items, found M"

#### 3.3 MISMATCH鈫扗efect Mapping Check
For each ReviewRecord:
- Count sub_items with `verdict: "MISMATCH"`
- For each MISMATCH sub_item, verify that at least one of its `defect_ids` exists in the record's `defects` array
- If any MISMATCH sub_item has empty `defect_ids` or references a non-existent defect, flag as mapping gap. Create the missing defect with information from the sub_item's `req_specifies`, `code_does`, and dimensions

#### 3.4 Cross-Requirement Consistency Check
- Build a map: for each source file function, list all requirements that reference it
- For functions referenced by multiple requirements, compare the review verdicts and sub-item assertions
- If requirement A says function F should do X, and requirement B says function F should do Y, and X conflicts with Y, flag as cross-requirement conflict. Record a defect with category `logic_error`
- Check shared global variables: if variable V is written by code implementing requirement A and read by code implementing requirement B, verify access consistency (especially ISR vs main context)

### 4. Defect Recording [focused mode, summary mode, legacy mode]

For each finding, create a `Defect` record:
```
{
  id: "DEF-CR-001",
  source: "code_review",
  severity: "critical" | "major" | "minor" | "suggestion",
  category: "logic_error" | "boundary_error" | "null_pointer" | "buffer_overflow"
          | "integer_overflow" | "resource_leak" | "concurrency" | "coding_standard"
          | "requirement_mismatch" | "interface_error" | "performance" | "timing"
          | "dangling_pointer" | "float_error" | "uninitialized_variable"
          | "double_free" | "alignment_error" | "other",
  location: { file_path, line_start, line_end?, function_name?, function_id? },
  title: "brief descriptive title",
  description: "detailed explanation 鈥?what is wrong AND what the correct behavior should be",
  rule_id?: "MISRA-C:2012 Rule 10.3",
  related_requirement_ids: ["SRS-001"],
  status: "open",
  detected_by: "inspector",
  detected_date: "2026-02-22"
}
```

Severity guidelines:
- **critical**: Can cause system failure, data corruption, or safety hazard at runtime. Examples: array overflow, unprotected ISR shared variable, division by zero on reachable path, requirement-code inconsistency involving wrong logic/values/operators/states in ANY function (not limited to safety-critical functions 鈥?a wrong threshold in a functional requirement is equally critical)
- **major**: Likely to cause incorrect behavior under specific conditions. Examples: numeric overflow in edge cases, boundary operator mismatch, missing error handling case, partial requirement implementation, formula transcription error
- **minor**: Unlikely but possible runtime issue, or minor requirement implementation gap
- **suggestion**: Observation that may warrant design review but has no direct runtime impact

Category selection for requirement-code consistency defects:
- `requirement_mismatch`: wrong value, wrong logic, wrong state, wrong operator vs. requirement
- `boundary_error`: off-by-one, inclusive/exclusive boundary mismatch
- `logic_error`: missing condition branch, inverted logic, wrong connector
- `timing`: wrong delay value, wrong timer period, wrong sequencing
- `interface_error`: wrong parameter type/unit, wrong protocol field, wrong byte order

## Output

Append defects to `.matrix/data/defects.json` with `source: "code_review"`.
Generate report at `.matrix/reports/code-review.md`.

## Note

This agent runs **in parallel** with static-analysis (Phase 3). The two have **non-overlapping scopes**: static-analysis handles tool-detectable coding standard violations and pattern-based defects; code-review handles semantic defects requiring human-level reasoning and requirement-code consistency.
