# MISRA-C:2012 Key Rules Summary

Selected mandatory and required rules for embedded software static analysis.

## Mandatory Rules
- Rule 1.3: No undefined or critical unspecified behavior
- Rule 2.1: No unreachable code
- Rule 9.1: All auto variables initialized before use

## Required Rules (Commonly Checked)
- Rule 8.2: Function types explicitly stated
- Rule 8.4: Compatible declarations for functions/objects
- Rule 10.1: No inappropriate essential type conversions
- Rule 10.3: No narrowing conversions
- Rule 11.3: No cast between pointer to object and integer
- Rule 11.8: No cast that removes const/volatile
- Rule 12.2: Shift count within range
- Rule 13.5: No persistent side effects in &&/|| right operands
- Rule 14.4: Controlling expression is essentially Boolean
- Rule 15.1: No goto statement
- Rule 15.7: All if...else if chains end with else
- Rule 16.4: Switch has default clause
- Rule 17.7: Return value of non-void function used
- Rule 18.1: No pointer arithmetic producing out-of-bounds results
- Rule 21.3: No dynamic memory allocation (malloc/calloc/realloc/free)
- Rule 21.6: No standard I/O (stdin/stdout/stderr)

## Advisory Rules (Commonly Checked)
- Rule 2.2: No dead code
- Rule 4.1: No octal/hex escape sequences in strings
- Rule 15.5: Single point of exit from function
