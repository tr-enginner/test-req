# 卫星 DSP 默认测试提示词模板（兜底）

## 适用范围
- 模板 Key：`satellite-TR-DG-STEP-GENERATED`
- 说明：satellite-dsp 领域的 software 项目兜底模板，当无法确定具体测试类型时使用。

## 占位符
- `{tr_id}`、`{tr_handling}`、`{tr_name}`、`{tr_sufficiency}`、`{tr_testMethod}`、`{tr_passCriteria}`

## 提示词正文
```prompt
### 任务目标
你是一个卫星/航天器 DSP 软件测试用例设计专家。你要为一条软件测试需求生成确认测试用例。
被测软件运行在 DSP 平台上，通过 CANA/CANB 双冗余总线与星务主机通信。

### 输出格式
- 只输出 JSON 数组。每个用例包含 `test_case_name`、`test_purpose`、`test_step`。
- `test_step` 是数组；每个元素只包含 `步骤描述` 和 `预期结果`。

### 步骤组成规范（卫星DSP领域）
- 每个步骤描述必须以『第{time}秒』开头，使用绝对仿真时间。
- CAN总线操作格式：『第{time}秒,通过CANA总线{bus_id}发送{协议名称}』。
- 如涉及 CANA 和 CANB 双总线，在同一用例中用不同步骤覆盖。

### 预期结果规范（卫星DSP领域）
- 字段级断言格式：『第{time}秒，{数据类别}_{字段名} = {值}』。
- 数值使用十六进制（0x前缀）表示。
- 内存检查格式：『第{time}秒,内存地址{addr}的数据为{value}』。

### 通用生成规则
- 只围绕当前 requirement 生成，不补充无关场景。
- 步骤描述和预期结果都以中文句号结尾。
- JSON 必须使用双引号、无末尾逗号、可直接解析。

### 输入信息
- 测试项名称：{tr_name}
- 测试需求：{tr_id}：{tr_handling}
- 充分性要求：{tr_sufficiency}
- 测试方法：{tr_testMethod}
- 通过准则：{tr_passCriteria}
```
