# Matrix Embedded Agent Phase 6 接手上下文

## 项目与当前状态

仓库路径：

`/home/greatwall/桌面/测试用例生成Agent/00-git/matrix-embedded-agent`

项目是 OpenCode 插件 `matrix-embedded-agent`，核心目标是实现嵌入式软件测试的多阶段智能体流程。当前重点集中在 Phase 6：确认测试用例设计、关键字翻译、Robot/DTP 脚本生成、DTP 动态执行与反馈优化闭环。

最近已提交的关键提交：

- `91fd216 收紧 DTP 执行器配置边界`
- `36fbc13 补强 Phase 6 结构化产物查询闭环`
- `6505822 下沉 Phase 6 DTP 执行配置解析`

当前工作区仍有未提交变更，主要是 Phase 6/7 agent 文案中文化：

- `src/agents/conductor.ts`
- `src/agents/test-executor.ts`
- `src/create-skills.ts`
- `tests/agents/builtin-agents.test.ts`
- `tests/create-skills.test.ts`

这些变更已经通过过验证：

- `bun run typecheck`
- `bun test`
- `bun run build`
- 针对性 agent/skill 测试也通过

建议下一步若用户要求提交，使用中文提交信息，例如：

`中文化 Phase 6 和 Phase 7 智能体文案`

## Phase 6 核心架构

Phase 6 已从“多输入 + prompt 驱动 + 隐式依赖”收敛为：

- 单一输入
- 分层架构
- 工具主导
- 结构化产物查询
- 评审驱动
- DTP 执行结果驱动闭环

唯一主输入：

`.matrix/data/test-requirements.json`

Phase 6 内不再依赖：

- `software-analysis.json`

核心分层：

```text
生成层（LLM）
  ↓
标准化层（规则/工具）
  ↓
输出层（源用例 / 可执行用例 / 文档 / DTP）
```

职责划分：

- `testcase_generator_run`
  - 展平测试需求
  - 构建极简 prompt
  - 生成 Phase 6 生成项清单
  - 不返回完整大数组，只返回摘要和 manifest 路径

- `testcase_worker_batch_run`
  - 执行批量 worker 生成
  - 生成 `source-confirmation-tests.json`
  - 调用 finalize/翻译流程
  - 只返回运行摘要，不返回完整 results

- `testcase_format_check`
  - 关键字匹配
  - 协议语义解析
  - 参数占位符绑定
  - 格式与可执行性校验

- `ct_suite_finalize`
  - 源测试套件落盘
  - 翻译为关键字执行结构
  - 生成正式/partial/失败诊断文件

## Phase 6 输入与协议解析

数据协议解析源头已修改：

- 不再使用 `protocol_search_dirs`
- 不再默认读取 `.matrix/data/数据协议`
- 改为在 `.matrix/reports` 下递归搜索文件名包含 `第三方测试需求` 且扩展名为 `.docx` 的文档

规则：

- 找到多个文档时，按 `inputFlow` 在文件名/正文中的匹配度选择最佳文档
- 只有一个候选但未命中 `inputFlow` 时仍使用，并给 warning
- 找不到候选时只给 warning，不回退旧目录，不阻断主流程

下游产物仍保持：

- `.matrix/data/protocols/<protocol_name>.json`
- `.matrix/data/protocol-semantics/<protocol_name>.json`

## 参数占位符策略

已将“无法解析参数占位符”从硬错误改成非阻断 warning。

当前策略：

- `${para1}`、`${参数2}`、`${variableName}` 等如果无法从需求语义中推断具体值，在源测试用例中原样保留
- 不进入 `errors`
- 仍记录 warning/诊断信息
- `${time}` 等已有默认推断逻辑保持
- 关键字库自身定义不一致仍应报错，例如 Documentation 使用参数但 Arguments 未声明
- 写入 DTP/Robot 可执行产物时，未解析占位符会去掉 `$`，例如 `${para1}` 转为 `{para1}`

这影响三处链路：

- worker 生成结果
- `source-confirmation-tests.json`
- `confirmation-tests.json` 翻译参数值

## Phase 6 输出产物

源测试用例：

`.matrix/data/source-confirmation-tests.json`

用途：

- 人工审查
- Markdown/DOCX 文档生成
- 保留自然语言字段，例如 `步骤描述`、`预期结果`

正式可执行测试用例：

`.matrix/data/confirmation-tests.json`

用途：

- Robot/DTP 脚本生成
- DTP 动态执行

重要策略：

- 如果部分用例翻译失败，但至少有完整成功翻译的用例，仍生成正式 `confirmation-tests.json`
- 正式文件只包含 `status === "translated"` 的完整成功用例
- 部分成功步骤不进入正式文件，避免静默漏测
- 如果完整成功翻译用例数为 0，则删除旧正式文件并返回 error

辅助诊断产物：

- `.matrix/data/confirmation-tests.partial.json`
- `.matrix/data/phase6-translation-report.json`
- `.matrix/data/phase6-translation-failures.json`
- `.matrix/data/phase6-translation-cases/<case_id>.json`

`confirmation-tests.partial.json` 只用于排查，不作为 DTP 正式输入。

## 翻译失败处理策略

当前已从“任一步骤翻译失败即阻断”改为“部分失败不中断正式可执行子集生成”。

返回状态：

- `success`
- `partial_success`
- `error`

`ct_suite_finalize` 在部分失败时：

- 返回 `partial_success`
- 写入正式 `confirmation-tests.json`
- 写入 partial suite
- 写入 failure/report/case 诊断产物
- 返回失败位置摘要与诊断文件路径

`testcase_worker_batch_run` 会透传：

- `translation_status`
- `translation_failures_file`
- `translation_summary`
- `translation_failed_locations`
- `translation_report_file`
- `translation_cases_dir`
- `partial_translated_suite_file`

## 结构化产物查询策略

用户强烈要求避免智能体用 `read` 通篇读取结构化 JSON/JSONL/TXT 输出。

当前已新增/强化：

`matrix_artifact_query`

原则：

- Phase 6 已定义格式产物必须通过 `matrix_artifact_query` 查询
- 不提供任意 path 参数，避免退化成另一个 read
- 列表查询分页，默认 `limit=20`，最大 `100`
- JSON/schema 损坏时返回结构化错误，不返回原文
- 工具输出缓存 `/home/.../.local/share/opencode/tool-output/...` 不应被读取

已覆盖或重点覆盖的 artifact：

- `matrix_config`
- `wiki_index`
- `test_requirements`
- `phase6_generation_manifest`
- `phase6_worker_run`
- `source_confirmation_suite`
- `translated_confirmation_suite`
- `phase6_translation_report`
- `phase6_translation_failures`
- `phase6_case_review_prepared`
- `phase6_execution_loop`
- `phase6_todo`

Reviewer Phase 6 也已要求：

- 不读取 `.matrix/data/reviews/case-review-prepared.json`
- 需要明细时使用 `matrix_artifact_query artifact="phase6_case_review_prepared"`

## Phase 6 评审、发布与执行闭环

当前流程：

```text
test-designer 生成/修订
  ↓
reviewer 审查 Phase 6
  ↓
review PASS 后 phase6_publish_outputs 发布
  ↓
phase6_execution_loop 生成 DTP 数据/Robot 并执行 DTP 闭环
  ↓
通过率和分支覆盖率均达标后 Phase 6 completed
```

关键约束：

- 文档只在 review 通过后生成
- `phase6_publish_outputs` 只负责正式文档发布；DTP 数据/Robot 生成已下沉到 `phase6_execution_loop`
- `phase6_publish_outputs` 成功后 Phase 6 仍未完成
- 只有 `phase6_execution_loop` 门禁通过后 Phase 6 才完成
- Phase 8 依赖 Phase 3、Phase 4、Phase 6
- Phase 7 保留为兼容/手工入口，主流程不再依赖 Phase 7

## DTP 执行闭环策略

`phase6_execution_loop` 已改为执行结果驱动闭环。

首次生成：

- `.matrix/data/test-cases-todo.txt` 保持全量 `case_id`
- 表示后续 DTP 脚本生成和执行覆盖所有成功翻译用例

执行后解析：

`.matrix/data/DTPProject/报告/test_summary.json`

结构：

- `summary.total`
- `summary.passed`
- `summary.failed`
- `summary.pass_rate`
- `test_cases[].name`
- `test_cases[].status`
- `test_cases[].error_message`

通过率规则：

- `summary.pass_rate` 支持 `"25.0%"` 字符串
- 归一化为数字百分比
- 阈值默认 `60`
- 低于 60 直接视为动态测试失败，不进入覆盖率通过判断

覆盖率解析：

`.matrix/data/DTPProject/报告/coverage_report/coverage_data.json`

结构：

- `total_coverage.branch.percent`
- `total_coverage.statement.percent`

覆盖率规则：

- 默认指标是 `branch`
- 默认阈值 `70`
- 覆盖率缺失按未达标处理

优化闭环：

- 未达标且未达到最大轮次时，收集 `status == "FAIL"` 的用例
- 用 `test_cases[].name` 作为 `case_id`
- 收集对应错误信息
- 只优化失败用例
- 未失败用例保持原 JSON 对象不变
- 优化后改写 `test-cases-todo.txt`，只包含本轮实际修改的失败 `case_id`
- 然后重新执行 DTP 数据/Robot 生成和脚本执行

特殊情况：

- 低覆盖率但没有任何 FAIL 用例时，没有可定位优化对象，直接失败并停止闭环
- 达到最大优化轮次后输出失败 artifact，不再重跑
- 通过率和分支覆盖率均达标时输出成功并完成 Phase 6 收尾

## OpenCode Desktop / Windows 离线包相关

曾出现 Windows/OpenCode Desktop 中看不到 `Conductor`，但 TUI 可以加载的问题。

用户反馈原因：

- `matrix.js` 中存在 Bun 特有 API
- OpenCode Desktop 需要替换为标准 Node.js API

该方向已处理过并打包过 Windows 离线部署包。后续如果又出现 Desktop 不能加载 agent，但技能可加载，应优先检查：

- `dist/index.js` 是否仍包含 Bun-only API
- 插件入口是否为标准 Node 可 import 的 ESM
- Windows 离线包里的 `matrix.js` 是否来自最新 build
- OpenCode Desktop 插件目录与 TUI 插件目录是否一致

## Phase 6/7 文案中文化当前未提交变更

用户要求：

- Phase 6 和 Phase 7 的 agent 描述、subagent 提示词、metadata 文案从英文改成中文
- “正文描述”按“中文描述”理解
- 功能和执行流程不能改变
- agent id、tool 名、artifact 路径、JSON 字段名、enum/status 不翻译

当前已改：

- conductor 中 Phase 6/7 调度描述中文化
- `test-designer` 调度 prompt 中文化
- reviewer 调度 prompt 中文化
- review PASS 后 publish 与 execution loop 说明中文化
- `/matrix-dynamic-design` 与 `/matrix-dynamic-test` description/template 中文化
- `/matrix-executor` legacy/manual Phase 7 入口中文化
- `test-executor` metadata、description、system prompt 中文化
- 测试同步更新

未提交文件：

- `src/agents/conductor.ts`
- `src/agents/test-executor.ts`
- `src/create-skills.ts`
- `tests/agents/builtin-agents.test.ts`
- `tests/create-skills.test.ts`

建议提交信息：

`中文化 Phase 6 和 Phase 7 智能体文案`

## 常用验证与发布命令

开发验证：

```bash
bun run typecheck
bun test
bun run build
```

更新本机 OpenCode 插件目录时，通常需要：

```bash
bun run build
```

然后将 `dist/index.js` 同步到 OpenCode 插件目录中的 `matrix.js`，并同步 `skills/`、`templates/`、`standards/`、`bin/` 等资源目录。

Windows 离线部署包：

```bash
bun run pack:offline -- --platform windows --version <version>
```

打包后建议检查：

- 产物文件是否生成
- 文件大小
- sha256
- 是否包含最新 `dist/index.js`
- 是否包含 `skills/templates/standards/bin` 等离线资源

## 接手建议

1. 先处理当前未提交的 Phase 6/7 中文化变更：检查 diff、跑验证、提交。
2. 若用户要求更新插件目录，先 `bun run build`，再同步到 OpenCode 插件目录。
3. 若用户要求 Windows 离线包，先确认版本号；未指定时可沿用下一个 patch 版本。
4. 后续 Phase 6 问题优先从结构化产物查询入手，不要让 agent/read 通篇读取 JSON 或 tool-output 缓存。
5. DTP 相关失败不要再引导检查 `matrix.jsonc`，直接报告 `dtp_executor` 的错误。
