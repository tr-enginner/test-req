# Keyword Parameters

## Keyword Source

Resolve keywords from paired files under:

- `.matrix/data/DTPProject/组合关键字/*.json`
- `.matrix/data/DTPProject/组合关键字/*.txt`

Resolve `.matrix/data/DTPProject/组合关键字` only under the current OpenCode workspace. Do not search ancestor, sibling, or unrelated project directories.

## Pair Usage

Use both files together:

- `.txt` gives keyword body, `[Documentation]`, `[Arguments]`, and internal call sequence.
- `.json` gives argument names, argument comments, item-level calls, and component names.

## Resolution Principle

Never assign semantics from `${para1}`, `${para2}`, `${para3}` by position alone.

Always read `.json` argument comments first.

Examples:

- `${time}` with comment `执行时间` is the time argument.
- `${para2}` with comment `数据文件` is a file-path or generated-data-file argument.
- `${para3}` with comment `循环时间` is duration or cycle control.

## File-Type Arguments

If an argument requires a data file:

1. Search `.matrix/data/dtp-generation/generated-data-files-index.json` by requested name, semantic name, keyword, and step context.
2. Use the indexed Robot-facing path when a suitable file exists.
3. If no suitable file exists, generate a supplemental file from project knowledge and append it to the index.
4. Record both the upstream requested file name and the final generated path.

Do not treat a file name from A-side output as proof that the file already exists.

## Trace Notes

For every resolved argument, preserve a source note such as:

- `confirmation-tests.json`
- `step-time`
- `keyword-json-comment`
- `generated-data-files-index`
- `step-description-inference`
- `test-purpose-inference`
- `document-inference`
- `generated-data-file`
