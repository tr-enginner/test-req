/**
 * Shared coverage checklist builders for test case generation.
 *
 * Used by the testcase_generator_run path to append mandatory coverage checklists
 * to generation prompts for interface and functional test requirements.
 */

/**
 * Parse the input flow to extract instruction type names and frame counts,
 * then build an explicit coverage checklist to append to the prompt.
 * This forces the LLM to generate cases for every instruction type × every bus.
 *
 * The checklist content varies by requirement type (inferred from `handling`):
 * - TR-JK-001 style (ID/arbitration/control error → discard): all instruction
 *   types, "错误丢弃测试", correct→error→correct→error→correct pattern
 * - TR-JK-002 style (TITLE/SUM error → counter increment): only single-frame
 *   polling sequences, "TITLE错误计数测试" / "SUM错误计数测试", W170 counter
 */
export function buildCoverageChecklist(inputFlow: string, testType: string, handling: string): string {
  if (!inputFlow || testType !== "接口测试") return ""

  // Detect requirement style from handling text
  const isTitleSumStyle = /TITLE|SUM|计数/.test(handling)
  // Default to ID-discard style if neither pattern matches
  const style: "id_discard" | "title_sum" =
    isTitleSumStyle ? "title_sum" : "id_discard"

  // Known instruction type keywords — used to filter out non-instruction
  // section headers (e.g. "一级CAN总线接口及相关数据流")
  const nameMap: Record<string, string> = {
    "遥测帧1": "遥测帧1轮询控制序列",
    "遥测帧2": "遥测帧2轮询控制序列",
    "遥测帧3": "遥测帧3轮询控制序列",
    "遥测帧4": "遥测帧4轮询控制序列",
    "遥控指令": "遥控指令",
    "上行数据": "上行数据块",
    "内存读出指令": "内存读出指令",
    "内存读出数据": "内存数据轮询控制序列",
    "内存数据轮询": "内存数据轮询控制序列",
    "辅助数据": "辅助数据包",
    "星务时间广播": "星务时间广播数据",
  }
  const knownKeys = Object.keys(nameMap)

  // Extract instruction names from #### headers like "#### 1.1.1.1   遥测帧1相关数据流"
  const headerPattern = /#{3,4}\s+(?:\d+\.?)+\s+(.+?)(?:相关数据流|数据流|$)/gm
  const instructions: Array<{ name: string }> = []
  let match: RegExpExecArray | null
  while ((match = headerPattern.exec(inputFlow)) !== null) {
    const fullName = match[1].trim()
    // Skip headers that don't match any known instruction keyword
    // (e.g. "一级CAN总线接口及" is a section header, not an instruction)
    const matchedKey = knownKeys.find(key => fullName.includes(key))
    if (!matchedKey) continue

    const shortName = nameMap[matchedKey]
    instructions.push({ name: shortName })
  }

  if (instructions.length === 0) return ""

  // Deduplicate
  const seen = new Set<string>()
  const unique = instructions.filter(i => {
    if (seen.has(i.name)) return false
    seen.add(i.name)
    return true
  })

  if (unique.length === 0) return ""

  const lines = ["", "---", "## 强制覆盖率清单（生成前必须确认）", ""]

  if (style === "title_sum") {
    // TR-JK-002 style: only single-frame polling sequences,
    // each gets TITLE error + SUM error × CANA + CANB
    const pollingNames = unique
      .map(i => i.name)
      .filter(n => n.includes("轮询") || n.includes("内存数据"))
    // Also include any single-frame polling not caught by the filter
    const candidates = pollingNames.length > 0 ? pollingNames : unique.map(i => i.name)

    lines.push(
      `你必须为以下 ${candidates.length} 种单帧轮询序列各生成 CANA 和 CANB 的 TITLE 错误和 SUM 错误测试用例：`,
      "",
    )
    candidates.forEach((name, i) => {
      lines.push(`  ${i * 4 + 1}. ${name} → CANA总线TITLE错误计数测试`)
      lines.push(`  ${i * 4 + 2}. ${name} → CANA总线SUM错误计数测试`)
      lines.push(`  ${i * 4 + 3}. ${name} → CANB总线TITLE错误计数测试`)
      lines.push(`  ${i * 4 + 4}. ${name} → CANB总线SUM错误计数测试`)
    })
    lines.push("")
    lines.push(`共计至少 ${candidates.length * 4} 个用例（每种序列 × 2总线 × 2错误类型）。`)
    lines.push("每用例按 正确→字段错误→正确 模式编排步骤。")
    lines.push('预期结果必须写明变量的可直接观测的绝对数值，不得只描述动作或相对变化（如"加1"、"比注错前增加1"）。')
    lines.push('需求未说明初始值时假定初值为 0：例如"平台CAN格式错误计数（遥测帧3参数W170）加1"应验证为"…W170为1"。')
    lines.push("生成完成后自检：我是否生成了所有用例？如果不足上述数量，请补充遗漏的用例。")
  } else {
    // TR-JK-001 style: all instruction types,
    // each gets ID error discard × CANA + CANB
    lines.push(
      `你必须为以下 ${unique.length} 种指令/数据流各生成 CANA 和 CANB 两个独立的测试用例：`,
      "",
    )
    unique.forEach((inst, i) => {
      lines.push(`  ${i + 1}. ${inst.name} → CANA总线ID错误丢弃测试`)
    })
    unique.forEach((inst, i) => {
      lines.push(`  ${unique.length + i + 1}. ${inst.name} → CANB总线ID错误丢弃测试`)
    })
    lines.push("")
    lines.push(`共计至少 ${unique.length * 2} 个用例。`)
    lines.push("每个用例必须按 正确→字段错误→正确→字段错误→正确 模式编排步骤。")
    lines.push("生成完成后自检：我是否生成了所有用例？如果不足上述数量，请补充遗漏的用例。")
  }

  return "\n" + lines.join("\n")
}

/**
 * Build a structured TR item list for functional test prompts.
 * When the handling field contains multiple TR items, this section
 * lists each TR item with its ID and description so the LLM can
 * plan which TR sub-parts to combine into each test case.
 */
export function buildTrItemCoverageList(trItems: Array<{ id: string; description: string }>): string {
  if (trItems.length === 0) return ""

  const lines = ["", "---", "## 结构化 TR 项列表（共 " + trItems.length + " 项）", ""]
  lines.push('以下是"处理"字段中所有TR项的逐一列出，方便你理解每个TR描述的逻辑子部分并规划覆盖：')
  lines.push("")

  for (let i = 0; i < trItems.length; i++) {
    const item = trItems[i]
    lines.push(`  ${i + 1}. ${item.id}`)
    lines.push(`     ${item.description}`)
    lines.push("")
  }

  lines.push("请仔细阅读以上每个TR描述，识别其中的逻辑子部分（如不同的条件分支、处理步骤、判定结果等）。")
  lines.push("根据测试需要从上述TR项中合理选取逻辑子部分组合生成测试用例，确保所有逻辑子部分完整覆盖。")
  lines.push("")

  return "\n" + lines.join("\n")
}
