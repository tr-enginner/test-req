export const PHASE6_FUNCTIONAL_SCOPE_RULE =
  '功能测试以覆盖需求明确描述的功能点为准，须包括有效等价类和无效等价类（C4 准则）。' +
  '需求中明确描述的错误分支（如“如果不相等，则...”）、异常判定（如“若校验失败，则...”），以及需求引用条款（如处理描述中“错误处理见TR-JK-xxx”）所描述的错误分支，属于功能测试范围，应生成对应的无效等价类用例。' +
  '不要自行编造需求未提及的边界、异常、恢复、未收到、连续接收或额外测试类型场景。'

export const PHASE6_NO_EXTRA_TEST_TYPE_RULE =
  '不要仅因为存在总线、接口或数据处理语义，就自动追加接口测试、数据处理测试等其他测试类型。'

export const PHASE6_EXPLICIT_OUTPUT_RULE =
  '预期结果必须写成可直接观测的绝对数值或确定状态，显式覆盖需求、章节背景和输出流中明确给出的可观察输出。' +
  '计数类字段必须写明计（加）数后的绝对数值（如"平台CAN格式错误计数（遥测帧3参数W170）为1"）；' +
  '需求未说明初始值时一律假定初值为0，"加1"即写"为1"。' +
  '禁止只描述动作或相对变化（如"W170加1"、"比注错前增加1"、"递增1"）——这类表述需要与之前状态对比，不可直接观测。'

export const PHASE6_NO_UNRESOLVED_PLACEHOLDER_RULE =
  '若需求信息、协议语义和 worker 建议值都无法解析某些参数占位符，可在源测试用例中原样保留 ${...} 并记录提示，不因该类占位符阻断用例生成；写入 DTP/Robot 可执行产物时会去掉占位符中的 $。'

export const PHASE6_REVIEW_ALIGNMENT_RULES = [
  PHASE6_FUNCTIONAL_SCOPE_RULE,
  PHASE6_NO_EXTRA_TEST_TYPE_RULE,
  PHASE6_EXPLICIT_OUTPUT_RULE,
  '若源测试步骤保留 ${...} 参数占位符，仅作为非阻断提示；正式 DTP/Robot 执行产物会将其转换为 {...}。',
]
