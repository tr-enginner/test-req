import { normalizePhase6TestType } from "./phase6-prompt-templates"
import { resolveFunctionalModel, type FunctionalModelContext } from "./phase6-functional-model"
import { ACTIONABLE_STEP_RULE, MULTIPACKET_SEQUENCE_RULE, analyzePacketSequences, hasMultipleOperations, isPeriodicSendDeclaration, operationIdentity, startsAtZeroTime, stepValidity, withoutParentheses } from "./phase6-step-design-policy"

/** Classify by requirement identity, never by words in a generated step. */
export function manualTestEnvironment(testType?: string): string | undefined {
  switch (normalizePhase6TestType(testType)) {
    case "性能测试": return "硬平台测试环境"
    case "余量测试": return "人工分析"
    default: return undefined
  }
}

export function isManualTestRequirement(context: FunctionalModelContext): boolean {
  return manualTestEnvironment(context.testType) !== undefined || resolveFunctionalModel(context) === "manual"
}

export function isIntegratedStressTest(testType?: string): boolean {
  return normalizePhase6TestType(testType) === "强度测试"
}

export function testTypeGenerationRules(testType?: string): string {
  const rules: Record<string, string> = {
    性能测试: "测试环境固定为硬平台测试环境。名称说明相应测试，目的说明设计目的。每步采用‘使用示波器多次测试……时间’的测量句式，测量对象、单位、条件和限值只取自需求；预期结果直接陈述对应性能指标满足要求的确定条件。保留人工步骤，不匹配关键字、不绑定参数、不进入 DTP/Robot；不得添加总线收发、内存写入或启动软平台步骤。其他字段遵循通用规则。",
    余量测试: "测试环境固定为人工分析。名称说明相应测试，目的说明设计目的。每步采用‘查看资源量使用文件，确认……’句式，确认对象取自需求；预期结果陈述需求规定的容量、占用或余量约束，不杜撰资源容量或比例。保留人工步骤，不匹配关键字、不绑定参数、不进入 DTP/Robot；不得增加资源注入、总线收发或启动软平台步骤。其他字段遵循通用规则。",
    数据处理测试: "采用与功能测试相似的输入操作、处理验证与可观察输出检查步骤，按真实接口和协议组织动作。严格覆盖本需求规定的处理分支、输入输出和约束，不自由增加异常、性能、精度或边界场景。接口模型仅供表达需求内的操作，不是新增测试内容的依据。",
    恢复性测试: "采用与可靠性安全性测试相似的操作步骤，依照需求规定的异常或中断、恢复条件和恢复后行为完成覆盖。严格依据本需求，不自行增加故障类型、复位、重试、恢复时限或安全状态。禁止0秒步骤（含第0.0秒、0s）；环境准备和初始状态写入初始设置，需验证的启动/故障注入/恢复动作保留为非零时刻的操作步骤。步骤正文、temporal与翻译后时间必须一致，保留需求规定的触发顺序和恢复间隔；不得仅把0秒机械替换为3秒而破坏时序。",
    可靠性安全性测试: "采用与功能测试相似的输入操作、处理验证与可观察输出检查步骤，覆盖本需求明确规定的可靠性与安全性处理。只设计有需求依据的故障和保护/恢复分支，不自由增加故障注入、报警、降级或恢复场景。",
    强度测试: "强度测试验证系统长时间运行状态下的响应。当前一个需求项必须且只能生成一个综合用例，覆盖其中全部综合性功能和子需求；不得按功能、指令、总线、TR-ID、轮次或步骤数量拆例。所有步骤使用同一时间原点，以第N秒/分钟/小时标明连续推进的时间线，切换功能或轮次时不得回拨；周期输入只声明一次，时长和检查点依据需求，不凭空增加超额负载或恢复测试。超过单次输出限制时分批追加同一个用例，不能新建用例。该规则优先于通用的指令×总线拆例与错误后恢复配对规则。",
    边界测试: "对需求中每个有明确上下限的取值范围，覆盖下边界-1、下边界、下边界+1、中间值、上边界-1、上边界、上边界+1，重合值去重；窄区间不得为了凑七步重复取值。同一数值可以承载多个边界角色。上下限、单位、合法性及对齐等附加约束以需求为准，预期结果同时考虑范围内外与附加约束，不把所有范围内数值都当成合法输入。",
  }
  const rule = rules[normalizePhase6TestType(testType) ?? ""]
  const type = normalizePhase6TestType(testType)
  const packetRule = ["功能测试", "接口测试", "数据处理测试", "强度测试"].includes(type ?? "") ? MULTIPACKET_SEQUENCE_RULE : ""
  const stressRule = type === "强度测试" ? "禁止0秒步骤；每步只操作一条具体指令/一个数据包，周期设置也须逐条独立声明，不能写遥测帧1~4或包1、2合并发送。同一指令同一通道的合法与单字段非法步骤必须相邻，不能用早先声明的后台周期发送代替相邻正确步骤。除多包末包前的剩余错误补测外，禁止连续非法步骤。" : ""
  return rule || packetRule ? `\n<test_type_rules>\n以下类型专属规则优先于通用拆例规则、项目经验和参考 step_plan；不得扩大当前需求范围。\n${rule ?? ""}\n${stressRule}\n${packetRule}\n${ACTIONABLE_STEP_RULE}\n</test_type_rules>\n` : ""
}

interface PolicyCase {
  test_environment?: string
  test_step: Array<{ 步骤描述: string; 预期结果: string; source_step_desc?: unknown; step_desc?: unknown; temporal?: unknown }>
}

export interface TestTypePolicyIssue {
  case_index: number
  step_index?: number
  field: string
  message: string
}

/** Shared by normalization, direct suite writes and pre-publication review. */
export function validateTestTypeCases(testType: string | undefined, cases: PolicyCase[], corpus = ""): TestTypePolicyIssue[] {
  const type = normalizePhase6TestType(testType)
  const issues: TestTypePolicyIssue[] = []
  if (type === "强度测试" && cases.length !== 1) {
    issues.push({ case_index: 0, field: "test_cases", message: "一条强度测试需求必须且只能对应一个综合用例，不能按功能、总线或步骤数拆例。" })
  }
  cases.forEach((testCase, caseIndex) => {
    const packetAnalysis = ["功能测试", "接口测试", "数据处理测试", "强度测试"].includes(type ?? "")
      ? analyzePacketSequences(testCase.test_step, { corpus, requireKnownPacketRoles: true }) : { issues: [], stepIndexes: new Set<number>() }
    issues.push(...packetAnalysis.issues.map((issue) => ({ ...issue, case_index: caseIndex, field: "test_step" })))
    const environment = manualTestEnvironment(type ?? undefined)
    if (environment && testCase.test_environment !== environment) {
      issues.push({ case_index: caseIndex, field: "test_environment", message: `${type}的测试环境必须为${environment}。` })
    }
    let previousTime = -Infinity
    testCase.test_step.forEach((step, stepIndex) => {
      const fail = (message: string) => issues.push({ case_index: caseIndex, step_index: stepIndex, field: "test_step", message })
      const desc = step.步骤描述.trim()
      const body = withoutParentheses(desc)
      if (type === "恢复性测试" && [desc, step.source_step_desc, step.step_desc, step.temporal].some(startsAtZeroTime)) {
        fail("恢复性测试禁止0秒步骤；初始状态及环境准备写入初始设置，需验证的操作从合理非零时刻开始。同步核对源步骤、temporal与翻译后的时间，保留需求规定的间隔，不机械平移时间。")
      }
      if (type === "边界测试" && /(?:下|上)边界|中间值/.test(body)) {
        fail("边界步骤正文只写具体取值；下边界-1等设计角色可省略或移到括号中，不能代替数值。")
      }
      if (type === "边界测试" && /(?:下|上)边界|中间值/.test(desc)
        && !/(?:0x[\da-f]+|\b[\da-f]+H\b|(?:为|=|取值)\s*-?\d+(?:\.\d+)?)/i.test(body)) {
        fail("边界步骤缺少具体取值，不能仅将设计角色移入括号而省略实际数值。")
      }
      if (["功能测试", "接口测试", "数据处理测试", "强度测试", "可靠性安全性测试", "恢复性测试"].includes(type ?? "")) {
        if (/(?:发送|下发)\s*(?:正确的?|合法的?)?(?:配置|控制)指令(?:[，,。；;（(]|$)/.test(desc)
          && !corpus.includes(desc.match(/(?:配置|控制)指令/)?.[0] ?? "\0")) fail("指令名称缺乏依据：不得编造‘配置指令/控制指令’，须使用需求或协议中的具体指令名；缺失时补充关联上下文。")
        if (/(?:发送|下发)[^。；;]*[，,]\s*(?:使|令|让)(?!用)/.test(body)) fail("发送步骤的效果说明应移入预期结果或括号中，正文只保留可执行操作。")
      }
      if (type === "性能测试" && !/^使用示波器多次测试\S[\s\S]*(?:时间|时延|延迟|周期|间隔)/.test(desc)) {
        fail("性能测试步骤须采用‘使用示波器多次测试……时间’句式，测量内容取自当前需求。")
      }
      if (type === "余量测试" && !/^查看资源量使用文件[，,]\s*确认\S/.test(desc)) {
        fail("余量测试步骤须采用‘查看资源量使用文件，确认……’句式，确认内容取自当前需求。")
      }
      if (type === "强度测试" && !/^启动软平台[。.]?$/.test(desc)) {
        if (hasMultipleOperations(desc)) fail("强度测试一个步骤只能操作一条具体指令或一个数据包；周期声明、范围枚举和并列指令也必须拆成相邻独立步骤。")
        // This pair rule is for command sends. Memory writes and interrupt
        // delivery retain their interface-specific multi-operation model.
        if (/发送|下发|注入/.test(body) && stepValidity(desc) === "error" && !packetAnalysis.stepIndexes.has(stepIndex) && operationIdentity(desc)) {
          const adjacentCorrect = [testCase.test_step[stepIndex - 1], testCase.test_step[stepIndex + 1]].some((other) => other
            && stepValidity(other.步骤描述) === "correct" && operationIdentity(other.步骤描述) === operationIdentity(desc)
            && !isPeriodicSendDeclaration(other.步骤描述))
          if (!adjacentCorrect) fail(`同一指令同一通道的合法/非法情况须在相邻步骤执行，后台周期输入不能代替相邻正确步骤。当前步骤${stepIndex + 1}的对象为${operationIdentity(desc)}。`)
          if (stepIndex > 0 && stepValidity(testCase.test_step[stepIndex - 1]!.步骤描述) === "error") fail("普通指令不得连续执行非法步骤；连续错误仅允许用于多包末包正确之前的剩余字段补测。")
        }
        // Read the scheduled start, not future timestamps in a periodic-send clause.
        const match = desc.match(/^第\s*(\d+(?:\.\d+)?)\s*(毫秒|ms|秒|s|分钟|min|小时|h)/i)
        if (!match) {
          fail("强度测试步骤须以第N秒/分钟/小时标明同一时间原点下的执行时刻。")
        } else {
          const scale: Record<string, number> = { 毫秒: 0.001, ms: 0.001, 秒: 1, s: 1, 分钟: 60, min: 60, 小时: 3600, h: 3600 }
          const time = Number(match[1]) * scale[match[2]!.toLowerCase()]!
          if (time === 0) fail("强度测试禁止0秒步骤；初始化写入初始设置，业务步骤从非零时刻开始。")
          if (time < previousTime) fail(`强度测试时间线不能回拨或分段重新计时；各功能、各轮次须连续推进。步骤${stepIndex + 1}为${time}秒，前一步为${previousTime}秒；请重排同时启动及带偏移的声明，保留需求规定的间隔。`)
          previousTime = time
        }
      }
    })
  })
  return issues
}
