# 多变量原子性违反分析报告 — {{project_name}}

**版本**: {{version}}
**日期**: {{date}}
**审查者**: Atomicity-Checker (Matrix)

---

## 1. 分析环境

| 项目 | 值 |
|------|------|
| 目标 CPU | {{target_cpu}} |
| 处理器字长 | {{word_size}} bit |
| 编译器方言 | {{compiler_dialect}} |
| ISR 数量 | {{isr_count}} |
| 共享变量数 | {{shared_var_count}} |
| 关联变量组数 | {{correlated_group_count}} |
| 保护原语 | {{protection_primitives}} |

---

## 2. 结果统计

### 关联变量组统计

| 锚点类型 | 数量 | 平均置信度 |
|----------|------|-----------|
| DFC | {{dfc_count}} | {{dfc_avg_conf}} |
| TUP | {{tup_count}} | {{tup_avg_conf}} |
| DAC | {{dac_count}} | {{dac_avg_conf}} |
| **合计** | **{{total_groups}}** | |

### 原子性违反统计

| 模式 | 候选总数 | CONFIRMED | INFEASIBLE | UNKNOWN |
|------|---------|-----------|------------|---------|
| DFC_RWWR | {{dfc_rwwr_total}} | {{dfc_rwwr_confirmed}} | {{dfc_rwwr_infeasible}} | {{dfc_rwwr_unknown}} |
| TUP_WRRW | {{tup_wrrw_total}} | {{tup_wrrw_confirmed}} | {{tup_wrrw_infeasible}} | {{tup_wrrw_unknown}} |
| TUP_WWWW | {{tup_wwww_total}} | {{tup_wwww_confirmed}} | {{tup_wwww_infeasible}} | {{tup_wwww_unknown}} |
| DAC_RWWW | {{dac_rwww_total}} | {{dac_rwww_confirmed}} | {{dac_rwww_infeasible}} | {{dac_rwww_unknown}} |
| DAC_RWWR | {{dac_rwwr_total}} | {{dac_rwwr_confirmed}} | {{dac_rwwr_infeasible}} | {{dac_rwwr_unknown}} |
| **合计** | **{{total_violations}}** | **{{total_confirmed}}** | **{{total_infeasible}}** | **{{total_unknown}}** |

---

## 3. 关联变量分析详情

> 按置信度降序排列，最多列出前 100 个。

| ID | 锚点类型 | 变量组 | 置信度 | 证据分解 | 描述 |
|----|---------|--------|--------|---------|------|
| {{group_id}} | {{anchor_type}} | {{variables}} | {{confidence}} | {{evidence_breakdown}} | {{description}} |

---

## 4. 原子性违反候选分布详情

| 违反模式 | 候选数量 | 验证结果分布 |
|---------|---------|-------------|
| {{pattern}} | {{count}} | CONFIRMED: {{confirmed}}, INFEASIBLE: {{infeasible}}, UNKNOWN: {{unknown}} |

---

## 5. 原子性违反结果详情

> 按严重度和置信度排序，最多列出前 20 个。仅包含 CONFIRMED 和 UNKNOWN 状态的违反（INFEASIBLE 不列出）。

### {{violation_id}}: {{title}}

- **模式**: {{pattern}}
- **关联变量组**: {{group_id}} ({{anchor_type}})
- **变量**: `{{var_a}}`, `{{var_b}}`
- **可行性**: {{feasibility_status}}
- **严重度**: {{severity}}

**4 次访问交错序列**:

| # | 上下文 | 变量 | 访问类型 | 文件 | 行号 | 函数 | 代码 |
|---|--------|------|---------|------|------|------|------|
| 1 | {{low_ctx}} | `{{var_1}}` | {{access_type_1}} | {{file_1}} | {{line_1}} | {{function_1}}() | `{{code_1}}` |
| 2 | **{{high_ctx}}** | `{{high_var_1}}` | {{high_access_type_1}} | {{high_file_1}} | {{high_line_1}} | {{high_function_1}}() | `{{high_code_1}}` |
| 3 | **{{high_ctx}}** | `{{high_var_2}}` | {{high_access_type_2}} | {{high_file_2}} | {{high_line_2}} | {{high_function_2}}() | `{{high_code_2}}` |
| 4 | {{low_ctx}} | `{{var_2}}` | {{access_type_2}} | {{file_2}} | {{line_2}} | {{function_2}}() | `{{code_2}}` |

**代码片段**:

```c
// {{low_ctx}} 侧第 1 次访问 (L{{line_1}})
{{code_snippet_1}}

// {{high_ctx}} 抢占执行 (L{{high_line_1}}-L{{high_line_2}})
{{code_snippet_high}}

// {{low_ctx}} 侧第 2 次访问 (L{{line_2}})
{{code_snippet_2}}
```

- **描述**: {{description}}
- **保护建议**: {{recommendation}}

---
