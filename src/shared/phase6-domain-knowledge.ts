import { normalizePhase6TestType } from "./phase6-prompt-templates"

interface DomainKnowledgeRule {
  id: string
  testType: string
  source: string
  applies: (corpus: string) => boolean
  guidance: string
}

// These are supplemental measurement/observation methods retained from the
// satellite templates. Routing and case partitioning remain in test-*.md.
const SATELLITE_RULES: readonly DomainKnowledgeRule[] = [
  {
    id: "satellite.performance.elapsed",
    testType: "性能测试",
    source: "satellite-performance.md",
    applies: (corpus) => /响应(?:时间|延迟|时延)|延迟|时延|耗时|(?:处理|执行|初始化|完成|启动)时间/.test(corpus),
    guidance: "按需求确定起始事件 T1 和结束事件 T2，记录两者并以 T2−T1 表示响应或处理耗时；单位、触发事件与判定门限必须取自当前需求，不把计划中的合成时间当作测量值。",
  },
  {
    id: "satellite.performance.interval",
    testType: "性能测试",
    source: "satellite-performance.md",
    applies: (corpus) => /间隔|周期/.test(corpus),
    guidance: "对需求规定的相邻事件记录时间间隔；需求要求多次测量或统计时，给出最小值、平均值和最大值，并仅按需求规定的指标判定，不自行增加采样次数或周期门限。",
  },
  {
    id: "satellite.performance.accuracy",
    testType: "性能测试",
    source: "satellite-performance.md",
    applies: (corpus) => /精度|误差|准确度/.test(corpus),
    guidance: "使用需求给出的已知参考值，与观测值计算需求指定的绝对误差或相对误差；误差定义、单位、参考值和允许范围均以当前需求为准。",
  },
  {
    id: "satellite.safety.majority",
    testType: "可靠性安全性测试",
    source: "satellite-safety.md",
    applies: (corpus) => /三模冗余|三取二|三选二|3取2|\bTMR\b/i.test(corpus),
    guidance: "根据需求定义的三取二逻辑，在三副本相同、两同一异、全异输入组合中选择需求明确要求的情形；逐项给出投票后被保护参数的确定值或规定状态，不为未定义的全异分支编造处理结果。",
  },
  {
    id: "satellite.safety.dma",
    testType: "可靠性安全性测试",
    source: "satellite-safety.md",
    applies: (corpus) => /\bDMA\b|直接存储器访问/i.test(corpus),
    guidance: "若需求规定 DMA 刷新或搬运保护，按规定的触发条件操作，并对需求指定的源数据和刷新后目标区域进行一致性检查；地址、长度、数据值及容错响应从当前需求取得，不新增未定义的 DMA 行为。",
  },
  {
    id: "satellite.margin.storage",
    testType: "余量测试",
    source: "satellite-margin.md",
    applies: (corpus) => /\bmap\b|链接映射|映射文件|存储|内存|代码段|常量段|数据段|堆栈|栈段|\b(?:ROM|RAM)\b/i.test(corpus),
    guidance: "依据需求指定的 map/链接映射文件或存储统计结果获取占用量；程序区按实际映射的代码段与常量段统计，数据区按实际映射的数据段、堆和栈统计，避免重叠段重复计数。用需求定义的总容量和口径计算余量及比例；没有提供容量或段归属时不得假定 64K 等固定值。",
  },
  {
    id: "satellite.stress.telemetry",
    testType: "强度测试",
    source: "satellite-stress.md",
    applies: (corpus) =>
      /长时(?:间)?|持续运行|连续运行|耐久|多轮|重复|反复|循环(?:运行|测试|发送|接收)/.test(corpus)
      && /遥测/.test(corpus),
    guidance: "对于需求已规定的长时或重复测试，在每轮规定的观察点核对需求指定的关键遥测字段，列出该轮期望值或确定状态；持续时间、轮数、检查间隔和字段集合取自需求，不固定为每 5–10 分钟，也不扩展到无关功能模块。",
  },
]

/**
 * Build an auditable, demand-scoped supplement without selecting a template.
 * A satellite-like corpus alone must never activate a domain.
 */
export function buildPhase6DomainKnowledge(
  domain: string,
  testType: string,
  corpus: string,
): string {
  if (domain !== "satellite-dsp" || !corpus.trim()) return ""
  const rules = SATELLITE_RULES.filter((rule) =>
    rule.testType === normalizePhase6TestType(testType) && rule.applies(corpus),
  )
  if (rules.length === 0) return ""

  return [
    "<domain_knowledge>",
    "domain: satellite-dsp",
    `test_type: ${testType}`,
    `activated_rules: ${rules.map((rule) => rule.id).join(", ")}`,
    "适用边界：本块仅补充当前需求的测量和观察方法，不替换 test-* 主模板，不改变主模板的测试类型、覆盖范围或指令×总线用例粒度；冲突时以当前需求和主模板为准。禁止虚构门限、容量、时序、地址、期望值或新增需求未规定的场景。",
    ...rules.map((rule) => `- [${rule.id}] knowledge_source=${rule.source}：${rule.guidance}`),
    "</domain_knowledge>",
  ].join("\n")
}
