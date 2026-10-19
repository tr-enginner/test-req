# IEC 61508 Verification Checklist

IEC 61508 (Functional Safety) software verification requirements.

## SIL-Dependent Requirements

### SIL 1
- [ ] Statement coverage achieved
- [ ] Functional test cases based on requirements

### SIL 2
- [ ] Branch/decision coverage achieved
- [ ] Equivalence class and boundary value tests
- [ ] Error guessing tests

### SIL 3
- [ ] MC/DC coverage or equivalent
- [ ] All test methods from SIL 2
- [ ] Formal verification of critical algorithms (recommended)

### SIL 4
- [ ] All SIL 3 requirements
- [ ] Formal methods applied where practical

## Common Requirements (All SIL Levels)
- [ ] Software module testing completed
- [ ] Software integration testing completed
- [ ] Requirements-based testing completed
- [ ] Static analysis performed
- [ ] Coding standard compliance verified
- [ ] Configuration management of test artifacts
