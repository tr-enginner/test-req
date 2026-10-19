import type { Chapter1Scope, Chapter1Reference } from "../schema/chapter1-scope"
import { writeZip, type ZipEntry } from "./docx-zip"
import { formatTestRequirementsDocx } from "./test-requirements-docx-format"

const escapeXml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;")
const run = (text: string, bold = false) => `<w:r><w:rPr>${bold ? "<w:b/>" : ""}<w:rFonts w:ascii="Times New Roman" w:eastAsia="SimSun"/><w:sz w:val="21"/></w:rPr><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`
const paragraph = (text: string, style?: string, indent = style === undefined, centered = false) => `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}${indent ? '<w:ind w:firstLine="480"/>' : ""}${centered ? '<w:jc w:val="center"/>' : ""}<w:spacing w:after="100"/></w:pPr>${run(text)}</w:p>`
const cell = (text: string, width: number, header = false) => `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/><w:vAlign w:val="center"/></w:tcPr><w:p><w:pPr><w:jc w:val="center"/></w:pPr>${run(text, header)}</w:p></w:tc>`

export const BASE_CHAPTER1_REFERENCES: Chapter1Reference[] = [
  ["TE-GTCG-003-2021", "军用软件测试指南"], ["QJ 3027A-2016", "航天型号软件测试规范"],
  ["Q/QJA 300-2014", "航天型号软件测试规范"], ["GB/T 25000.51-2016", "系统与软件工程 系统与软件质量要求和评价（SQuaRE） 就绪可用软件产品（RUSP）的质量要求和测试细则"],
  ["GB/T 25000.10-2016", "系统与软件工程 系统与软件质量要求和评价（SQuaRE） 系统与软件质量模型"],
  ["五办[2011]479号", "五院航天器软件第三方测试管理办法"], ["QMS-LAB-ST-CX01", "软件测试项目控制程序"],
].map(([document_id, document_title]) => ({ document_id, document_title, source_kind: "fixed", evidence: "template" }))

const TEST_TYPES = [
  ["TR-GN-YYY-XXX", "功能测试"], ["TR-XN-XXX", "性能测试"], ["TR-JK-XXX", "接口测试"],
  ["TR-AQ-XXX", "可靠性安全性测试"], ["TR-YL-XXX", "余量测试"], ["TR-BJ-XXX", "边界测试"],
  ["TR-SC-XXX", "数据处理测试"], ["TR-HF-XXX", "恢复性测试"], ["TR-QD-XXX", "强度测试"],
  ["TR-DS-ALL", "代码审查"], ["TR-JF-ALL", "静态分析"], ["TR-LJ-ALL", "逻辑测试"],
] as const

function testTypeTable(): string {
  const widths = [800, 3900, 3600]
  const borders = '<w:tblBorders><w:top w:val="single" w:sz="8"/><w:left w:val="single" w:sz="8"/><w:bottom w:val="single" w:sz="8"/><w:right w:val="single" w:sz="8"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders>'
  const rows = [["序号", "测试类型标识", "测试类型"], ...TEST_TYPES.map(([id, name], i) => [String(i + 1), id, name])]
  return `<w:tbl><w:tblPr><w:tblW w:w="8300" w:type="dxa"/>${borders}</w:tblPr><w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid>${rows.map((row, i) => `<w:tr>${row.map((value, j) => cell(value, widths[j], i === 0)).join("")}</w:tr>`).join("")}</w:tbl>`
}

function documentXml(model: Chapter1Scope): string {
  const seenReferenceIds = new Set<string>()
  const references = [...BASE_CHAPTER1_REFERENCES, ...model.references].filter((reference) => {
    const key = reference.document_id.trim().toUpperCase()
    if (!key || seenReferenceIds.has(key)) return false
    seenReferenceIds.add(key)
    return true
  })
  const csci = model.csci_names.length ? model.csci_names.join("、") : ""
  const renderedDocumentId = !model.document_id || model.document_id.endsWith(".RX1") ? model.document_id : `${model.document_id}.RX1`
  const blocks = [
    paragraph("1 范围", "Heading1"), paragraph("1.1 标识", "Heading2"),
    paragraph(`a. 文档标识：${renderedDocumentId}，版本号：${model.document_version}；`),
    paragraph(`b. 本文标题：${model.software_name_and_id}第三方测试需求；`),
    paragraph(`c. 委托单位：${model.model_name}项目办；`), paragraph(`d. 委托单位地址：${model.client_address}；`),
    paragraph("e. 缩略语："), paragraph("CSCI：计算机软件配置项；"), paragraph("TR：测试需求；"), paragraph("IF：接口。"),
    paragraph("f. 本文档适用的系统和计算机软件配置项（CSCI）："),
    paragraph(`本文档适用的系统是${model.system_name}，对应的软件配置项为${csci}。`, undefined, true),
    paragraph("1.2 文档概述", "Heading2"),
    paragraph(`本文是${model.software_name_and_id}的第三方测试需求，文中描述了该软件的测试范围，定义软件测试项及测试要求，为后续用例设计提供测试依据。本文档适用的代码版本为V${model.code_version}。`, undefined, true),
    paragraph("1.3 依据文件和引用文档", "Heading2"),
    ...references.map((ref) => paragraph(`${ref.document_id}    ${ref.document_title}`)),
    paragraph("1.4 测试需求概述", "Heading2"),
    paragraph("依据委托方的要求，针对被测试软件，确定的测试级别为配置项测试，测试类型及其要求如下：", undefined, true),
    paragraph("表1-1  测试类型总结表", "TableTitle", false, true), testTypeTable(),
    paragraph("注：ALL为固定符号，不需要改变；YYY为表明所描述需求项意义的符号，需要根据具体需求项进行更改；XXX为当前需求项序号；"),
    paragraph("软件测试项对应的测试要求包括测试充分性要求和测试终止要求两部分。"),
    paragraph("a. 测试充分性要求，分为如下5个方面："),
    paragraph("C1：针对上述测试类型，按照《军用软件测评实验室测评过程和技术能力要求》中的规定，设计的测试用例尽可能多地覆盖该测试类型中的要求；"),
    paragraph("C2：测试过程中的所有需求项均被覆盖；"), paragraph("C3：测试需求项测试需要设计有效等价类用例；"),
    paragraph("C4：测试需求项测试设计的用例需要包括有效等价类、无效等价类；"), paragraph("C5：测试需求项测试设计的用例需要包括边界数据值；"),
    paragraph("b. 测试终止要求，分为如下3个方面："),
    paragraph("Z1：测试需求项的测试用例按照所设计的操作步骤完成，测试正常终止；"),
    paragraph("Z2：测试需求项存在测试用例不能按照所设计的操作步骤完成，测试异常终止；"),
    paragraph("Z3：不具备测试条件，不列入本次测试内容。"),
  ]
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + blocks.join("") + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1080" w:bottom="1440" w:left="1080"/></w:sectPr></w:body></w:document>'
}

const styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="Times New Roman" w:eastAsia="SimSun"/><w:sz w:val="21"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:rFonts w:eastAsia="SimHei"/><w:sz w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="Heading 2"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:rFonts w:eastAsia="SimHei"/><w:sz w:val="28"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="TableTitle"><w:name w:val="Table Title"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/></w:pPr></w:style></w:styles>'

export function renderChapter1ScopeDocx(model: Chapter1Scope): Buffer {
  const entries: ZipEntry[] = [
    { path: "[Content_Types].xml", data: Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>') },
    { path: "_rels/.rels", data: Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>') },
    { path: "word/document.xml", data: Buffer.from(documentXml(model), "utf-8") }, { path: "word/styles.xml", data: Buffer.from(styles) },
    { path: "word/_rels/document.xml.rels", data: Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>') },
  ]
  return formatTestRequirementsDocx(writeZip(entries), { addPageNumbers: false })
}
