# 软件可靠性安全性测试提示词模板

## 适用范围
- 模板 Key：`test-可靠性安全性测试-STEP-GENERATED`
- 说明：适用于 software / software_variant + 可靠性安全性测试。

## 业务说明
用于软件安全性验证场景。 提示词正文已收敛为短结构，业务人员如需优化，优先调整“类型专属规则”和“输入信息”的表达，不要在 `prompt` 代码块中加入大段示例或教学说明。

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
你要为一条可靠性安全性测试需求项生成测试用例。

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
- 步骤必须可操作，指令名来自当前或关联需求、协议定义，不得用无依据的“配置指令”代替。输入流为“无”不是可发送数据；缺少指令名或参数依据时反馈上下文缺口，不猜测。功能开启等效果放入预期结果或括号，不混入发送操作正文。
- 采用与功能测试相似的输入操作、处理验证与可观察输出检查步骤，覆盖需求明确规定的可靠性与安全性处理分支。
- 测试内容必须紧扣需求，不自由增加故障注入、告警、降级或恢复场景；仅在需求规定正常与异常校核时，将其按实际业务关系编排在步骤中。

### 当前需求适用的接口操作模型
以下模型仅用于表达需求已规定的操作和预期结果，不扩大可靠性安全性测试内容。
{{INTERFACE_SECTIONS}}

### 输入信息
- 需求项名称：{title}
- 需求项简介：{requirementContext}
- 输入流说明：{inputFlowContext}
- 处理：{processingContext}
- 输出流说明：{outputFlowContext}
- 测试要求：{constraintContext}
```
