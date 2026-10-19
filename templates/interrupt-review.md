# Interrupt Data Access Conflict Review — {{project_name}}

**Version**: {{version}}
**Date**: {{date}}
**Reviewer**: ISR-Reviewer (Matrix)

---

## 1. Review Environment

| Item | Value |
|------|-------|
| Target CPU | {{target_cpu}} |
| Processor Word Size | {{word_size}} bit |
| Compiler Dialect | {{compiler_dialect}} |
| ISR Count | {{isr_count}} |
| Shared Variables | {{shared_var_count}} |
| Protection Primitives | {{protection_primitives}} |

---

## 2. Shared Variable Graph

| Variable | Type | Width | ISR Access | Non-ISR Access | Risk Pattern | Protection | Verdict |
|----------|------|-------|------------|----------------|-------------|------------|---------|
| {{var_name}} | {{type}} | {{width}} | {{isr_access}} | {{non_isr_access}} | {{pattern}} | {{protection}} | {{verdict}} |

---

## 3. Conflict Analysis Details

### {{def_id}}: {{title}}

- **Pattern**: {{pattern_id}} — {{pattern_name}}
- **Variable**: `{{var_name}}` ({{type}}, {{width}} bit)
- **ISR Side**: {{isr_function}}() @ {{isr_file}}:{{isr_line}}
- **Non-ISR Side**: {{non_isr_function}}() @ {{non_isr_file}}:{{non_isr_line}}
- **Protection**: {{protection_status}}
- **Risk**: {{risk_explanation}}
- **Recommendation**: {{recommendation}}

---

## 4. Summary

- Total Shared Variables Audited: {{total_vars}}
- Conflict Defects Found: {{total_defects}}
- Critical: {{critical}}, Major: {{major}}
- By Pattern: C1: {{c1}}, C2: {{c2}}, C3: {{c3}}, C4: {{c4}}, C5: {{c5}}

---

## 5. Protection Recommendations

{{recommendations}}
