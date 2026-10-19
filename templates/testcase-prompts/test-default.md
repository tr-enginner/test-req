# 软件项目通用提示词模板

## 适用范围
- 模板 Key：`test-TR-DG-STEP-GENERATED`
- 说明：保留的软件通用模板参考，不作为 software / software_variant 的自动回退模板。

## 业务说明
软件项目必须命中对应测试类型的 `test-*.md` 主模板。未知类型、模板缺失或正文无效时明确报错，不使用本文件自动降级。本文件仅保留为新增类型模板的编写参考；优化时优先调整“类型专属规则”和“输入信息”的表达。

## 占位符
- `{title}`：测试需求项名称。
- `{requirementContext}`：测试需求项简介。
- `{inputFlowContext}`：输入流说明。
- `{processingContext}`：测试需求项具体涉及的处理逻辑。
- `{outputFlowContext}`：输出流说明。
- `{constraintContext}`：测试要求。
- 若正文中未使用某个占位符，可忽略对应说明。

## 提示词正文
```prompt
### 任务目标
你要为一条软件测试需求项生成测试用例。

### 输出格式
- 只输出 JSON 数组。
- 每个用例包含 `test_case_name`、`test_purpose`、`covered_tr_items`、`test_step`。
- `test_case_name` 使用简洁的中文短语描述该用例的测试场景，如"上电标识为上电运行时的默认引导参数设置"，不要使用"TC_BOOT_001"等编号作为名称。
- `covered_tr_items` 是一个字符串数组，列出本用例覆盖的具体 TR 子需求项编号（如 ["TR-GN-BOOT-001", "TR-GN-BOOT-002"]）。根据输入的"处理"字段中列出的 TR 项确定哪些与本用例相关。
- `test_step` 是数组；每个元素必须包含 `步骤描述` 和 `预期结果`。可选地，附加以下语义锚点字段：
- `operation_type`：操作类型，取值为 send_command / inject_input / trigger_output / set_input_data / set_memory / verify_telemetry / verify_response / verify / bus_communication / initialization / other
- `channel`：总线通道，取值为 CANA / CANB / 空字符串
- `temporal`：时间描述，如 "第3.0秒"
- `data_checks`：预期结果中的具体检查项列表
- 示例 step 元素：{"步骤描述":"第3.0秒，通过CANA总线发送指令","预期结果":"系统接收到指令。","operation_type":"send_command","channel":"CANA","temporal":"第3.0秒"}

### 通用生成规则
- 只输出严格 JSON 数组，不要输出解释、标题或代码块标记。
- 仅围绕当前 requirement 生成，不补充无关场景。
- 先通读整个测试需求项的全部上下文，再按指令/功能类型划分用例：同一指令/功能类型的多种情况，即使分散在多个 TR-ID 对应的描述条目中，也必须聚合到同一个用例中一起测试，不得按 TR-ID 逐条拆分用例。
- `步骤描述`写人工操作，`预期结果`写可观察、可验证结果。
- `步骤描述`和`预期结果`都以中文句号结尾。
- `步骤描述`只描述使用哪个协议/数据格式及数据状态（正确/哪个字段错误），禁止给出协议的具体字节值（如"41H 08H 20H..."）。具体数据由后续步骤生成。
- JSON 必须使用双引号、无末尾逗号、可直接解析。

### 类型专属规则
- 优先依据测试方法、通过准则和充分性要求组织步骤。
- 如果当前 requirement 可以在一个主用例内完成验证，不要无故拆成多个用例。
- 预期结果必须覆盖需求、章节背景和输出流中明确给出的可观察输出，不要只写“软件正确处理”这类笼统结果。
- 若步骤最终需要使用关键字 Documentation 格式，最终步骤中不得保留未解析的占位符；尤其是 `${time}` 必须给出具体值。

### 输入信息
- 需求项名称：{title}
- 需求项简介：{requirementContext}
- 输入流说明：{inputFlowContext}
- 处理：{processingContext}
- 输出流说明：{outputFlowContext}
- 测试要求：{constraintContext}
```
