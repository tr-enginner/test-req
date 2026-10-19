# Issue Report DOCX Generator — Design

**Date**: 2026-02-24
**Status**: Approved

## Goal

Add an `issue_report` tool that generates a "软件测试问题报告单" DOCX file from `defects.json` data, using a user-customizable DOCX template with placeholder substitution.

## Architecture

```
templates/issue-report.docx          ← User-editable Word template with placeholders
    ↓ (unzip to XML)
src/tools/issue-report-generator.ts  ← Tool implementation (no LLM calls)
    ↓ (read defects.json + placeholder replacement + repack)
.matrix/reports/issue-report.docx    ← Generated report
```

## Template Design

The template is a standard `.docx` file containing:
- **Header area**: Project name, date, summary stats with `{{placeholder}}` markers
- **Defect table**: A table with header row + one **template row** containing `{{id}}`, `{{title}}`, etc. The tool duplicates this row for each defect.

### Supported Placeholders

| Placeholder | Data Source |
|-------------|------------|
| `{{project_name}}` | defects.json → project_name |
| `{{date}}` | Current date (YYYY-MM-DD) |
| `{{total}}` | summary.total |
| `{{open_critical}}` | summary.open_critical |
| `{{by_severity_critical}}` | summary.by_severity.critical |
| `{{by_severity_major}}` | summary.by_severity.major |
| `{{by_severity_minor}}` | summary.by_severity.minor |
| `{{by_source_static_analysis}}` | summary.by_source.static_analysis |
| `{{by_source_code_review}}` | summary.by_source.code_review |
| `{{by_source_unit_test}}` | summary.by_source.unit_test |
| `{{by_source_confirmation_test}}` | summary.by_source.confirmation_test |
| `{{by_source_interrupt_review}}` | summary.by_source.interrupt_review |
| **Per-defect (in table rows)** | |
| `{{id}}` | defect.id |
| `{{title}}` | defect.title |
| `{{severity}}` | defect.severity |
| `{{category}}` | defect.category |
| `{{source}}` | defect.source |
| `{{location}}` | file_path:line_start |
| `{{description}}` | defect.description |
| `{{status}}` | defect.status |
| `{{detected_by}}` | defect.detected_by |
| `{{detected_date}}` | defect.detected_date |
| `{{related_reqs}}` | related_requirement_ids.join(", ") |
| `{{rule_id}}` | defect.rule_id |
| `{{seq}}` | 1-based sequence number |

## Implementation

### Step 1: Unpack DOCX
DOCX is a ZIP archive. Use Bun's built-in ZIP capabilities to extract.

### Step 2: Replace Placeholders in document.xml
1. Read `word/document.xml`
2. Handle split placeholders: Word may split `{{placeholder}}` across multiple `<w:r>` runs. Normalize by merging adjacent runs within each `<w:p>`.
3. Replace global placeholders (project_name, date, summary stats)
4. Find the table row (`<w:tr>`) containing `{{id}}` — this is the template row
5. For each defect: clone the template row XML, replace per-defect placeholders
6. Replace the template row with all generated rows

### Step 3: Repack DOCX
Repack modified XML back into a ZIP archive as `.docx`.

## Tool Interface

```typescript
tool({
  description: "Generate issue report DOCX from defects.json using a DOCX template",
  args: {
    defects_file: string,     // default: .matrix/data/defects.json
    template_path: string,    // default: templates/issue-report.docx (relative to plugin dir)
    output_path: string,      // default: .matrix/reports/issue-report.docx
  }
})
```

## Initial Template Creation

A one-time script (`scripts/create-issue-report-template.ts`) uses `docx-js` to generate the initial `templates/issue-report.docx`. Users can then customize it in Word while preserving placeholders.

Template layout:
1. Title: "软件测试问题报告单"
2. Project info table (project_name, date)
3. Summary stats table (total, by_severity, by_source, open_critical)
4. Defect detail table (header row + template row with placeholders)

## Dependencies

- No new runtime dependencies (Bun built-in ZIP + string-based XML manipulation)
- `docx` npm package used only in the template generation script (dev-time)

## Files to Create/Modify

- **New**: `scripts/create-issue-report-template.ts` — one-time template generator
- **New**: `templates/issue-report.docx` — generated template
- **New**: `src/tools/issue-report-generator.ts` — tool implementation
- **Modify**: `src/create-tools.ts` — register `issue_report` tool
- **Modify**: `src/shared/constants.ts` — add `REPORT_PATHS.ISSUE_REPORT`
