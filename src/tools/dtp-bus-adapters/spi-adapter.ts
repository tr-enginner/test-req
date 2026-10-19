import type {
  DtpProtocolDefinition,
  DtpProtocolFieldLayout,
  DtpProtocolFieldOption,
  PacketFieldValuePlan,
  StepDataQualityIssue,
} from "../dtp-data-generation-core"
import { getDtpProtocolFrames } from "../dtp-protocol-definitions"
import type { DtpBusAdapter, DtpFieldOptionResolution } from "./types"

function normalizeHexByte(value: string | undefined): string | undefined {
  if (!value) return undefined
  const match = value.trim().match(/^(?:0x)?([0-9a-f]{1,2})H?$/i)
  return match?.[1]?.toUpperCase().padStart(2, "0")
}

function selectableOption(option: DtpProtocolFieldOption): string | undefined {
  const value = normalizeHexByte(option.value)
  if (!value) return undefined
  const evidence = `${option.label ?? ""} ${option.source ?? ""}`
  return /(?:保留|无效|禁止|未定义|其他|reserved|invalid|unused|undefined|n\/?a)/i.test(evidence) ? undefined : value
}

export function resolveSpiAddressOption(
  field: DtpProtocolFieldLayout,
  semanticText: string,
): DtpFieldOptionResolution | undefined {
  const options = (field.options ?? []).flatMap((option) => {
    const value = selectableOption(option)
    return value ? [{ option, value }] : []
  })
  if (!options.length) return undefined
  const explicitAddress = semanticText.match(/ADDRESS\s*(?:为|=|:|：)?\s*(?:0x)?([0-9a-f]{2})H?/i)?.[1]?.toUpperCase()
  const explicit = options.find((item) => item.value === explicitAddress)
  if (explicit) return { value: explicit.value, source: "step_desc" }
  const defaultValue = normalizeHexByte(field.default_value)
  if (defaultValue && options.some((item) => item.value === defaultValue)) return { value: defaultValue, source: "frame-table" }
  return { value: options[0].value, source: "document_order_default" }
}

function documentedDefaultFieldPlans(
  protocol: DtpProtocolDefinition | undefined,
  semanticText: string,
): PacketFieldValuePlan[] {
  if (!protocol || protocol.bus_context?.bus_type !== "SPI") return []
  return getDtpProtocolFrames(protocol).flatMap((frame) => frame.field_layout.flatMap((field) => {
    if (field.name !== "ADDRESS" || (field.options?.length ?? 0) < 2) return []
    const resolution = resolveSpiAddressOption(field, semanticText)
    if (!resolution || resolution.source !== "document_order_default") return []
    return [{
      field_name: field.name,
      value: resolution.value,
      value_source: "enum-option" as const,
      source_table_id: field.source_table_id ?? frame.source_table_id,
      source_text: field.source_text,
      confidence: 0.65,
      reasoning: ["The step did not identify one documented SPI ADDRESS option; the first valid option in document order was selected."],
    }]
  }))
}

function validateCasePlan(
  protocol: DtpProtocolDefinition | undefined,
  stepText: string,
  plan?: import("../dtp-data-generation-core").CaseStepDataGenerationPlan,
): StepDataQualityIssue[] {
  const issues: StepDataQualityIssue[] = []
  if (protocol?.bus_context?.bus_type === "SPI") {
    for (const frame of getDtpProtocolFrames(protocol)) {
      const address = frame.field_layout.find((field) => field.name === "ADDRESS")
      if ((address?.options?.length ?? 0) <= 1) continue
      const resolution = address ? resolveSpiAddressOption(address, stepText) : undefined
      if (!resolution) {
        issues.push({ severity: "error", type: "protocol_ambiguous", message: `SPI ADDRESS has no selectable documented value: ${address?.options?.map((option) => option.value).join(" / ")}.` })
      } else if (resolution.source === "document_order_default") {
        issues.push({ severity: "warning", type: "protocol_default_selected", message: `Protocol default selected: SPI ADDRESS ${resolution.value} is the first valid documented option because the step did not select one explicitly.` })
      }
    }
  }
  if (
    plan && /错误|异常|非法|不正确/.test(stepText) && !/无错误|没有错误|错误计数/.test(stepText) &&
    !plan.mutations.some((mutation) => mutation.operation !== "replace") &&
    plan.sequence_operations.length === 0 && plan.checksum_policy !== "make_incorrect"
  ) {
    issues.push({
      severity: "error",
      type: "semantic_fault_without_mutation",
      message: "SPI step requests faulty data but has no invalid mutation; specify the faulty field or provide evidence that uniquely identifies it.",
    })
  }
  return issues
}

export const spiBusAdapter: DtpBusAdapter = {
  id: "spi",
  busType: "SPI",
  aliases: ["SPI"],
  matchesEvidence: (text) => /\bSPI\b|SPI\s*(?:总线|接口)/i.test(text),
  resolveFlowConstraint(stepText) {
    if (/输入流/.test(stepText)) return { handled: true, flow: "input" }
    if (/输出流/.test(stepText)) return { handled: true, flow: "output" }
    // A test-tool "send" action does not establish the software-side SPI flow.
    return { handled: true }
  },
  selectorValuesEquivalent({ relation, selectorValue, mappingValue }) {
    if (
      relation.selector_type !== "uint8" ||
      !/(?:站|节点|终端|设备|单机)地址/.test([relation.selector_name, ...relation.selector_aliases].join(" "))
    ) return false
    const stepAddress = Number.parseInt(selectorValue, 16)
    const mappedAddress = Number.parseInt(mappingValue ?? "", 16)
    return Number.isFinite(stepAddress) && Number.isFinite(mappedAddress) &&
      (stepAddress >> 3) === (mappedAddress >> 3)
  },
  protocolEntityConflicts(protocol, normalizedStepText) {
    const protocolName = protocol.base_file_name.replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase()
    const families = ["机构控制", "黑体驱动", "开关指令", "电机遥测", "黑体遥测", "指令板模拟量"]
    const family = families.find((name) => normalizedStepText.includes(name))
    return Boolean(family && !protocolName.includes(family))
  },
  fallbackPolicies: [{
    id: "spi",
    version: "2.0.0",
    priority: 100,
    match: { bus_type: "SPI" },
    instructions: [
      "SPI 协议语义必须与 CAN、SpaceWire 保持独立。",
      "规范证据存在对应字段时，必须保留 SPI 表格定义的字段顺序，通常为 ADDRESS、LENGTH、DATA 字段和 SUM。",
      "只能使用规范 SPI 协议声明的校验范围，禁止复用 CAN 校验规则。",
    ],
    required_evidence: ["protocol-definition", "source-table"],
    max_candidates: 5,
    context_budget_chars: 12_000,
    relation_depth: 1,
    missing_evidence_policy: "warn",
  }],
  resolveFieldOption: resolveSpiAddressOption,
  documentedDefaultFieldPlans,
  validateCasePlan({ protocol, stepText, plan }) {
    return validateCasePlan(protocol, stepText, plan)
  },
  validateGeneratedLines({ protocol, lines, plan }) {
    const issues: StepDataQualityIssue[] = []
    const frames = getDtpProtocolFrames(protocol)
    if (plan.sequence_operations.length || lines.length !== frames.length) return issues
    for (const [lineIndex, line] of lines.entries()) {
      const frame = frames[lineIndex]
      const lengthField = frame?.field_layout.find((field) => field.role === "length")
      const dataOffsets = new Set(frame?.field_layout
        .filter((field) => field.role === "data")
        .flatMap((field) => Array.from({ length: field.byte_length }, (_, offset) => field.byte_offset + offset)))
      const actualLength = lengthField && line[lengthField.byte_offset]
        ? Number.parseInt(line[lengthField.byte_offset], 16)
        : undefined
      const intentionalLengthError = plan.mutations.some((mutation) => (
        /^(?:L|LENGTH|长度)$/i.test(mutation.field) &&
        (mutation.frame_index === undefined || mutation.frame_index === lineIndex + 1)
      ))
      if (actualLength !== undefined && Number.isFinite(actualLength) && actualLength !== dataOffsets.size && !intentionalLengthError) {
        issues.push({
          severity: "error",
          type: "spi_length_mismatch",
          message: `SPI frame ${lineIndex + 1} LENGTH=${actualLength}, but its canonical DATA field count is ${dataOffsets.size}.`,
        })
      }
    }
    return issues
  },
}
