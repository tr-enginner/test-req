import { readFileSync } from "fs"
import type { SpecRule, SpecRuleset } from "../../schema/spec-repair"

/** Chinese priority → code mapping */
const PRIORITY_MAP: Record<string, string> = { "高": "P001", "中": "P002", "低": "P003" }

/** Chinese conformance level → code mapping */
const CONFORMANCE_MAP: Record<string, string> = { "强制类": "L001", "推荐类": "L002", "其他": "L004" }

/** Chinese category name → code mapping */
const CATEGORY_MAP: Record<string, string> = {
  "声明定义类": "C001", "版面书写类": "C002", "分支控制类": "C003",
  "指针使用类": "C004", "跳转控制类": "C005", "运算处理类": "C006",
  "函数调用类": "C007", "语句使用类": "C008", "调用返回类": "C009",
  "程序注释类": "C010", "控制循环类": "C011", "类型转换类": "C012",
  "初始化类": "C013", "比较判断类": "C014", "名称符号变量类": "C015",
  "编译错误": "C016",
}

/** Extract text content between XML tags */
function extractTag(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))
  return match ? match[1].trim() : ""
}

/** Extract attribute value */
function extractAttr(element: string, attr: string): string {
  const match = element.match(new RegExp(`${attr}="([^"]*?)"`))
  return match ? match[1].trim() : ""
}

/** Parse a SpecChecker XML ruleset file into a SpecRuleset */
export function parseRuleset(xmlPath: string): SpecRuleset {
  const xml = readFileSync(xmlPath, "utf-8")
  const rules: SpecRule[] = []
  const categories: Record<string, string> = {}

  // Populate categories from the map
  for (const [name, code] of Object.entries(CATEGORY_MAP)) {
    categories[code] = name
  }

  // Find all <rule> elements
  const rulePattern = /<rule\b[^>]*>[\s\S]*?<\/rule>/g
  let match: RegExpExecArray | null
  while ((match = rulePattern.exec(xml)) !== null) {
    const ruleXml = match[0]

    const cid = extractAttr(ruleXml, "cid") || extractTag(ruleXml, "cid")
    const name = extractAttr(ruleXml, "description") || extractTag(ruleXml, "description")
    const priorityCn = extractAttr(ruleXml, "priority") || extractTag(ruleXml, "priority")
    const conlevelCn = extractAttr(ruleXml, "conlevel") || extractTag(ruleXml, "conlevel") || extractAttr(ruleXml, "conLevel")
    const categoryCn = extractAttr(ruleXml, "category") || extractTag(ruleXml, "category")
    const description = extractTag(ruleXml, "specification") || name

    const priority = PRIORITY_MAP[priorityCn] ?? ""
    const conformance = CONFORMANCE_MAP[conlevelCn] ?? ""
    const categoryId = CATEGORY_MAP[categoryCn] ?? categoryCn

    // Handle multi-CID rules (e.g., "CID1025,CID013,CID3161")
    const cids = cid.includes(",") ? cid.split(",").map(c => c.trim()) : [cid]

    for (const singleCid of cids) {
      if (!singleCid) continue
      rules.push({
        id: singleCid,
        name,
        category_id: categoryId,
        category_name: categoryCn,
        conformance,
        priority,
        description,
      })
    }
  }

  return { rules, categories }
}

/** Maps used during SpecChecker JSON report parsing */
export { PRIORITY_MAP, CONFORMANCE_MAP, CATEGORY_MAP }
