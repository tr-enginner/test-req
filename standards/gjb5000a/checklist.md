# GJB 5000A Code Review Checklist

GJB 5000A (Military Software Quality Assurance) process requirements for code review.

## Coding Standard Compliance
- [ ] Variable naming follows project conventions
- [ ] Function naming follows project conventions
- [ ] File header comments present and complete
- [ ] Function header comments describe purpose, parameters, return values
- [ ] Inline comments explain complex logic
- [ ] No dead code or unreachable statements
- [ ] No commented-out code blocks

## Safety and Reliability
- [ ] All pointers checked for NULL before dereference
- [ ] All array accesses checked for bounds
- [ ] No dynamic memory allocation (malloc/free) in safety-critical code
- [ ] No recursion in safety-critical paths
- [ ] All function return values checked
- [ ] Proper error handling for all external calls
- [ ] No goto statements
- [ ] Switch statements have default cases
- [ ] All variables initialized before use

## Requirement Traceability
- [ ] Each function traceable to a software requirement
- [ ] No unrequired functionality (gold plating)
- [ ] Interface implementations match ICD specifications
- [ ] Data range checks match requirement specifications

## Timing and Performance
- [ ] No busy-wait loops without timeout
- [ ] Interrupt handlers are minimal and bounded
- [ ] Shared resource access properly protected (mutex/semaphore)
- [ ] Stack usage within allocated limits

## Data Integrity
- [ ] Global variables documented and minimized
- [ ] Volatile keyword used for hardware-mapped variables
- [ ] Proper data alignment for target platform
- [ ] Endianness handled correctly for cross-platform data
