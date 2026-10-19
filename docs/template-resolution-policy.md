# 模板解析策略

本文档说明 Matrix 模板解析的通用原则，以及 Phase 6 测试用例提示词的独立路由契约。Phase 6 的路由收敛不改变其他模板工具已有的显式参数、环境变量和兼容行为。

## 统一优先级

对于仓库自带模板文件，统一按以下顺序查找：

1. 显式传入的覆盖路径  
   例如 `template_path`
2. 环境变量覆盖路径  
   仅适用于提供环境变量覆盖的工具。
3. 项目工作目录下的 `templates/`  
   这是统一的业务模板主目录；测试用例提示词模板应放在其子目录 `templates/testcase-prompts/`
4. 项目工作目录下的 `.matrix/templates/`
5. 项目工作目录下的 OpenCode 运行目录模板
   包括 `.opencode/templates/` 与 `.config/opencode/templates/`
6. 插件随部署携带的内置模板
   通常解析到 OpenCode 运行目录旁边的 `templates/`
7. 仅对少数历史兼容场景保留的 legacy fallback

## 设计原则

- 项目级模板优先于系统级模板，便于项目隔离和客户定制
- 统一将 `<workDir>/templates/` 视为项目业务模板目录
- 在 manager 管理的项目中，初始化阶段会自动创建 `<workDir>/templates/`，并将内置模板按“缺失补齐、不覆盖已有文件”的方式复制进去
- OpenCode 运行目录中的模板作为部署后的默认 fallback
- 安装目录中的 `/opt/matrix/plugin/templates/` 视为部署来源，不作为业务侧首选路径
- 只有确实需要兼容旧链路时，才允许追加 legacy fallback

## 当前接入的工具

- `testcase_generator_run`
  按下节 Phase 6 契约解析 `testcase-prompts/index.json` 及主模板 Markdown，生成和审查共享解析策略。`software` / `software_variant` 不因目标模板缺失或无效而回退旧模板族；FPGA / requirements 的既有兼容策略保留
- `ct_docx_generate`
- `issue_report`
- `eval_desc_generate`

## Phase 6 测试用例模板契约

### 查找顺序

生成和 reviewer 预审统一按以下候选顺序查找 Phase 6 模板：

1. `<workDir>/templates/`
2. `<workDir>/.matrix/templates/`
3. `<workDir>/.opencode/templates/`
4. `<workDir>/.config/opencode/templates/`
5. 既有部署候选，包括插件随部署携带的模板及原有安装位置候选

主模板位于候选目录下的 `testcase-prompts/`。项目候选先于部署候选；选中来源中的索引或目标模板无效时必须返回错误，不允许悄悄读取较低优先级的同名或旧族模板。这里规定的是 Phase 6 的解析行为，不调整 `ct_docx_generate`、`issue_report` 等工具的路径策略。

### 软件主模板映射

`software` 与 `software_variant` 根据测试类型选择同一组主模板，与领域无关：

| 测试类型 | 主模板文件 |
|---|---|
| 功能测试 | `test-functional.md` |
| 接口测试 | `test-interface.md` |
| 性能测试 | `test-software-performance.md` |
| 安全性测试 | `test-software-safety.md` |
| 边界测试 | `test-boundary.md` |
| 强度测试 | `test-software-stress.md` |
| 余量测试 | `test-margin.md` |
| 数据处理测试 | `test-data-processing.md` |
| 恢复性测试 | `test-software-recovery.md` |
| 逻辑测试 | `test-logic.md` |
| 时序测试 | `test-timing.md` |

卫星等领域通过 `generation_guide` 和按需求语义触发的 `<domain_knowledge>` 附加知识，不用 `satellite-*` 替换主模板。未知测试类型、目标文件缺失、索引无效或提示正文无效均须报错；不静默使用 `software-*`、`satellite-*`、`TR-DG-STEP-GENERATED` 或旧 JSON 默认模板。`test-default.md` 仅保留为编写参考，不作为未知软件类型的自动回退。FPGA 与 requirements 保留原来的模板选择和兼容策略。

### 来源记录、审查与汇报

每次生成的 manifest 顶层记录 `template_provenance_version: 1`、`domain`、`project_type` 与 `test_requirements_file`，每个需求项记录工具实际解析出的：

- `template_file`：主模板文件。
- `template_hash`：主模板完整文件内容的 SHA256（非仅 prompt 正文）；不代表附加指南或接口分节的内容哈希。
- `template_source`：解析来源。
- `template_domain`：领域上下文。
- `template_index_file`：所用索引文件。
- `template_selection_reason`：选择该主模板的理由。

字段值由工具产生，智能体不得凭 `template_key`、领域名或默认路径补写。`STEP-GENERATED` 仅为模板键后缀；执行汇报须按实际 `template_file` 统计需求项数量，并说明来源、领域与选择理由。

reviewer 预审核对生成 manifest 的来源记录与当前解析基线。模板文件、内容指纹或路由来源漂移属于 blocking，不能切换审查模板后继续 PASS。修正来源后应重新生成受影响用例并重新审查，确保发布使用的用例与模板依据一致。

版本 1 还必须匹配生成与审查使用的需求文件路径、项目类型及领域，记录缺失或重复同样阻断。没有生成清单或没有来源版本的历史工件可继续审查，但必须明确警告“无模板来源可验证”，不能宣称来源核验通过。`phase6_publish_outputs` 每次重新预审；未显式指定时沿用版本 1 清单中的需求路径和项目类型，模板阻断问题不能被已有 PASS 记录覆盖。

## 实现位置

统一解析逻辑位于：

- `src/shared/template-resolution.ts`
- `src/shared/phase6-prompt-templates.ts`：Phase 6 主模板路由、来源记录与领域附加知识

新增读取模板的 tool 时，优先复用对应共享模块，不要在各 tool 中重新拼接候选路径。Phase 6 的生成、审查入口必须使用同一 Phase 6 解析逻辑。
