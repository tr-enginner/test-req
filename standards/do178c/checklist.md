# DO-178C Review Checklist

DO-178C (Software Considerations in Airborne Systems) verification requirements.

## Software Verification Process (Section 6)
- [ ] Requirements-based test cases cover all high-level requirements
- [ ] Requirements-based test cases cover all low-level requirements (Level A/B)
- [ ] Requirements traceability verified bidirectionally
- [ ] Test coverage analysis completed at required level:
  - Level A: MC/DC coverage
  - Level B: Decision coverage
  - Level C: Statement coverage
  - Level D: N/A

## Structural Coverage Analysis
- [ ] Statement coverage achieved
- [ ] Decision/branch coverage achieved (Level B+)
- [ ] MC/DC coverage achieved (Level A)
- [ ] Dead code identified and justified

## Software Reviews and Analysis
- [ ] Source code complies with coding standards
- [ ] Source code is traceable to requirements
- [ ] Source code is verifiable (testable)
- [ ] Compiler, linker warnings resolved
- [ ] Stack analysis completed
- [ ] Timing analysis completed
- [ ] Memory usage analysis completed

## Problem Reporting
- [ ] All anomalies documented in problem reports
- [ ] Problem report resolution tracked
- [ ] Impact analysis for deferred problems
- [ ] Problem report closure criteria met
