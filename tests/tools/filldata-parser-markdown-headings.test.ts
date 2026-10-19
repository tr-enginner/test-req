import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { filldataParser } from "../../src/tools"

function makeCtx(directory: string) {
  return {
    sessionID: "sid-1",
    messageID: "mid-1",
    agent: "filldata-enricher",
    directory,
    worktree: directory,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  }
}

describe("filldataParser extract markdown numbered headings", () => {
  test("accepts compact numeric and appendix heading labels", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-markdown-compact-headings-"))
    try {
      const inputPath = join(dir, "requirements.md")
      writeFileSync(inputPath, [
        "# 5需求",
        "## 5.2功能需求",
        "### 5.2.1.初始化功能",
        "初始化要求。",
        "## F.2遥测数据",
        "遥测要求。",
      ].join("\n"), "utf-8")

      const raw = await (filldataParser as any).execute(
        { mode: "extract", file_path: inputPath, format: "markdown", write_artifacts: true },
        makeCtx(dir),
      )
      const result = JSON.parse(raw)
      const extracted = JSON.parse(readFileSync(result.output.req_segments_path, "utf-8"))
      const byId = new Map(extracted.segments.map((segment: { segment_id: string }) => [segment.segment_id, segment]))

      expect(result.ok).toBe(true)
      expect((byId.get("SRS-005") as { title: string })?.title).toBe("需求")
      expect((byId.get("SRS-5.2") as { title: string })?.title).toBe("功能需求")
      expect((byId.get("SRS-5.2.1") as { title: string })?.title).toBe("初始化功能")
      expect((byId.get("SRS-F.2") as { title: string })?.title).toBe("遥测数据")
      expect(extracted.segments.some((segment: { segment_id: string }) => segment.segment_id.startsWith("SEG-"))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("derives structured ids and section paths from markdown heading titles", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-markdown-headings-"))
    try {
      const inputPath = join(dir, "requirements.md")
      writeFileSync(
        inputPath,
        [
          "# 3 Requirements",
          "## 3.2 Functional Requirements",
          "### 3.2.1 Init Features",
          "#### 3.2.1.1 Controller Init",
          "System shall initialize the controller after power-on.",
          "## 3.3 External Interface Requirements",
          "### 3.3.1 Status Query Interface",
          "System shall expose the status query interface on the CAN bus.",
        ].join("\n"),
        "utf-8",
      )

      const raw = await (filldataParser as any).execute(
        {
          mode: "extract",
          file_path: inputPath,
          format: "markdown",
          write_artifacts: true,
        },
        makeCtx(dir),
      )

      const result = JSON.parse(raw)
      const extracted = JSON.parse(readFileSync(result.output.req_segments_path, "utf-8"))
      const target = extracted.segments.find((segment: { segment_id: string }) => segment.segment_id === "SRS-3.2.1.1")
      const interfaceSection = extracted.segments.find((segment: { segment_id: string }) => segment.segment_id === "SRS-3.3")

      expect(result.ok).toBe(true)
      expect(target).toBeTruthy()
      expect(target.section_path_ids).toEqual(["SRS-003", "SRS-3.2", "SRS-3.2.1", "SRS-3.2.1.1"])
      expect(target.section_path_titles).toEqual(["Requirements", "Functional Requirements", "Init Features", "Controller Init"])
      expect(interfaceSection).toBeTruthy()
      expect(interfaceSection.title).toBe("External Interface Requirements")
      expect(extracted.segments.some((segment: { segment_id: string }) => segment.segment_id === "SEG-001")).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("accepts trailing punctuation after a structured heading number", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-markdown-trailing-heading-dot-"))
    try {
      const inputPath = join(dir, "requirements.md")
      writeFileSync(
        inputPath,
        [
          "# 5 Requirements",
          "## 5.2 Functional Requirements",
          "#### 5.2.4.3. 249-byte uplink block",
          "First requirement.",
          "#### 5.2.4.4． 72-byte uplink block",
          "Second requirement.",
          "#### 5.2.4.5。 Memory read command",
          "Third requirement.",
        ].join("\n"),
        "utf-8",
      )

      const raw = await (filldataParser as any).execute(
        {
          mode: "extract",
          file_path: inputPath,
          format: "markdown",
          write_artifacts: true,
        },
        makeCtx(dir),
      )

      const result = JSON.parse(raw)
      const extracted = JSON.parse(readFileSync(result.output.req_segments_path, "utf-8"))
      const ids = extracted.segments.map((segment: { segment_id: string }) => segment.segment_id)

      expect(result.ok).toBe(true)
      expect(ids).toContain("SRS-5.2.4.3")
      expect(ids).toContain("SRS-5.2.4.4")
      expect(ids).toContain("SRS-5.2.4.5")
      expect(ids.some((id: string) => id.startsWith("SEG-"))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("prefers appendix letters over erroneous leading chapter numbers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-markdown-numbered-appendix-"))
    try {
      const inputPath = join(dir, "requirements.md")
      writeFileSync(
        inputPath,
        [
          "# 11.附录 H 72字节上行数据包格式",
          "Appendix content.",
          "# 12．附录 I 固定指令序列流程图",
          "More appendix content.",
          "# 附录 L 遥测数据",
          "## L.1 遥测帧1",
          "Frame content.",
        ].join("\n"),
        "utf-8",
      )

      const raw = await (filldataParser as any).execute(
        { mode: "extract", file_path: inputPath, format: "markdown", write_artifacts: true },
        makeCtx(dir),
      )
      const result = JSON.parse(raw)
      const extracted = JSON.parse(readFileSync(result.output.req_segments_path, "utf-8"))
      const ids = extracted.segments.map((segment: { segment_id: string }) => segment.segment_id)

      expect(result.ok).toBe(true)
      expect(ids).toContain("SRS-H")
      expect(ids).toContain("SRS-I")
      expect(ids).toContain("SRS-L")
      expect(ids).toContain("SRS-L.1")
      expect(ids).not.toContain("SRS-011")
      expect(ids).not.toContain("SRS-012")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("recognizes Chinese numbered headings and appendix headings as structured sections", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-markdown-cn-headings-"))
    try {
      const inputPath = join(dir, "requirements-cn.md")
      writeFileSync(
        inputPath,
        [
          "## 3.2 能力需求",
          "### 3.2.1 初始化功能",
          "#### 3.2.1.1 80C32 控制器初始化",
          "系统上电后应完成控制器初始化。",
          "## 附件 A CAN 通讯协议定义说明",
          "### A.1 CAN 总线网络结构",
          "应定义 CAN 总线网络结构。",
          "## 附件 B 遥测、遥控数据约定及数据定义说明",
          "### B.3 间接指令及应答格式说明",
          "应定义间接指令及应答格式。",
        ].join("\n"),
        "utf-8",
      )

      const raw = await (filldataParser as any).execute(
        {
          mode: "extract",
          file_path: inputPath,
          format: "markdown",
          write_artifacts: true,
        },
        makeCtx(dir),
      )

      const result = JSON.parse(raw)
      const extracted = JSON.parse(readFileSync(result.output.req_segments_path, "utf-8"))
      const ids = extracted.segments.map((segment: { segment_id: string }) => segment.segment_id)
      const mainTarget = extracted.segments.find((segment: { segment_id: string }) => segment.segment_id === "SRS-3.2.1.1")
      const appendixTarget = extracted.segments.find((segment: { segment_id: string }) => segment.segment_id === "SRS-A.1")
      const annexRoot = extracted.segments.find((segment: { segment_id: string }) => segment.segment_id === "SRS-A")
      const annexBRoot = extracted.segments.find((segment: { segment_id: string }) => segment.segment_id === "SRS-B")
      const appendixB = extracted.segments.find((segment: { segment_id: string }) => segment.segment_id === "SRS-B.3")

      expect(result.ok).toBe(true)
      expect(ids).toContain("SRS-3.2")
      expect(ids).toContain("SRS-3.2.1")
      expect(ids).toContain("SRS-3.2.1.1")
      expect(ids).toContain("SRS-A")
      expect(ids).toContain("SRS-A.1")
      expect(ids).toContain("SRS-B")
      expect(ids).toContain("SRS-B.3")
      expect(mainTarget.section_path_ids).toEqual(["SRS-3.2", "SRS-3.2.1", "SRS-3.2.1.1"])
      expect(mainTarget.section_path_titles).toEqual(["能力需求", "初始化功能", "80C32 控制器初始化"])
      expect(annexRoot.title).toBe("CAN 通讯协议定义说明")
      expect(annexBRoot.title).toBe("遥测、遥控数据约定及数据定义说明")
      expect(appendixTarget.section_path_ids).toEqual(["SRS-A", "SRS-A.1"])
      expect(appendixTarget.section_path_titles).toEqual(["CAN 通讯协议定义说明", "CAN 总线网络结构"])
      expect(appendixB.section_path_ids).toEqual(["SRS-B", "SRS-B.3"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("keeps same-style structured headings as siblings and nests them under an unnumbered SEG heading", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-markdown-seg-parent-"))
    try {
      const inputPath = join(dir, "requirements.md")
      writeFileSync(inputPath, [
        "## 功能需求",
        "### 5.2.1 工作模式功能",
        "工作模式要求。",
        "### 5.2.2 间接指令响应功能",
        "间接指令要求。",
        "### 5.2.3 内务指令响应功能",
        "内务指令要求。",
      ].join("\n"), "utf-8")

      const result = JSON.parse(await (filldataParser as any).execute({
        mode: "extract",
        file_path: inputPath,
        format: "markdown",
        write_artifacts: true,
      }, makeCtx(dir)))
      const extracted = JSON.parse(readFileSync(result.output.req_segments_path, "utf-8"))
      const root = extracted.segments.find((segment: any) => segment.title === "功能需求")
      const children = extracted.segments.filter((segment: any) => /^SRS-5\.2\.[123]$/.test(segment.segment_id))

      expect(root.segment_id).toMatch(/^SEG-/)
      expect(root.level).toBe(2)
      expect(root.section_path_ids).toEqual([root.segment_id])
      expect(children.map((segment: any) => segment.segment_id)).toEqual(["SRS-5.2.1", "SRS-5.2.2", "SRS-5.2.3"])
      for (const child of children) {
        expect(child.level).toBe(3)
        expect(child.section_path_ids).toEqual([root.segment_id, child.segment_id])
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("recognizes compact annotated appendix headings and deep markdown headings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-markdown-appendix-compact-"))
    try {
      const inputPath = join(dir, "requirements-appendix.md")
      writeFileSync(
        inputPath,
        [
          "# 5 软件详细需求",
          "##### 5.2.4.2.1 深层协议字段",
          "字段定义。",
          "## 附录A（规范性附录）接口数据定义",
          "附录内容。",
          "### A.1 帧格式",
          "帧格式内容。",
        ].join("\n"),
        "utf-8",
      )

      const raw = await (filldataParser as any).execute(
        {
          mode: "extract",
          file_path: inputPath,
          format: "markdown",
          write_artifacts: true,
        },
        makeCtx(dir),
      )

      const result = JSON.parse(raw)
      const extracted = JSON.parse(readFileSync(result.output.req_segments_path, "utf-8"))
      const ids = extracted.segments.map((segment: { segment_id: string }) => segment.segment_id)
      const appendix = extracted.segments.find((segment: { segment_id: string }) => segment.segment_id === "SRS-A")
      const appendixChild = extracted.segments.find((segment: { segment_id: string }) => segment.segment_id === "SRS-A.1")

      expect(result.ok).toBe(true)
      expect(ids).toContain("SRS-5.2.4.2.1")
      expect(appendix.title).toBe("接口数据定义")
      expect(appendixChild.section_path_ids).toEqual(["SRS-A", "SRS-A.1"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("does not let wrapped body lines like '1 次；' reset the chapter hierarchy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-markdown-body-noise-"))
    try {
      const inputPath = join(dir, "requirements-body-noise.md")
      writeFileSync(
        inputPath,
        [
          "# 3 Requirements",
          "## 3.2 Functional Requirements",
          "### 3.2.5 Ampere-Hour Control",
          "Charge termination command",
          "1 次；",
          "111 ：Battery Temperature",
          "#### 3.2.5.2 Allowed State",
          "The system shall update the allowed-state flag.",
          "#### 3.2.5.3 Capacity Calculation",
          "The system shall calculate remaining capacity every 2 seconds.",
          "## 3.3 External Interface Requirements",
          "The system shall expose a CAN status interface.",
        ].join("\n"),
        "utf-8",
      )

      const raw = await (filldataParser as any).execute(
        {
          mode: "extract",
          file_path: inputPath,
          format: "markdown",
          write_artifacts: true,
        },
        makeCtx(dir),
      )

      const result = JSON.parse(raw)
      const extracted = JSON.parse(readFileSync(result.output.req_segments_path, "utf-8"))
      const allowed = extracted.segments.find((segment: { segment_id: string }) => segment.segment_id === "SRS-3.2.5.2")
      const calc = extracted.segments.find((segment: { segment_id: string }) => segment.segment_id === "SRS-3.2.5.3")
      const iface = extracted.segments.find((segment: { segment_id: string }) => segment.segment_id === "SRS-3.3")

      expect(result.ok).toBe(true)
      expect(extracted.segments.some((segment: { segment_id: string; title: string }) =>
        segment.segment_id === "SRS-001" && segment.title === "次；"
      )).toBe(false)
      expect(extracted.segments.some((segment: { segment_id: string; title: string }) =>
        segment.segment_id === "SRS-111" && segment.title === "：Battery Temperature"
      )).toBe(false)
      expect(allowed.section_path_ids).toEqual(["SRS-003", "SRS-3.2", "SRS-3.2.5", "SRS-3.2.5.2"])
      expect(allowed.section_path_titles).toEqual(["Requirements", "Functional Requirements", "Ampere-Hour Control", "Allowed State"])
      expect(calc.section_path_ids).toEqual(["SRS-003", "SRS-3.2", "SRS-3.2.5", "SRS-3.2.5.3"])
      expect(calc.section_path_titles).toEqual(["Requirements", "Functional Requirements", "Ampere-Hour Control", "Capacity Calculation"])
      expect(iface.section_path_ids).toEqual(["SRS-003", "SRS-3.3"])
      expect(iface.section_path_titles).toEqual(["Requirements", "External Interface Requirements"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("recognizes escaped markdown numbering while ignoring backward single-number table noise", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filldata-markdown-escaped-dots-"))
    try {
      const inputPath = join(dir, "requirements-escaped.md")
      writeFileSync(
        inputPath,
        [
          "## <a id=\"bookmark1\"></a>1 引言",
          "### <a id=\"bookmark2\"></a>1\\.1 标识",
          "## <a id=\"bookmark3\"></a>3 需求",
          "### <a id=\"bookmark4\"></a>3\\.2 能力需求",
          "#### <a id=\"bookmark5\"></a>3\\.2\\.5 蓄电池组安时计控制",
          "1   不做性能测试要求",
          "##### <a id=\"bookmark6\"></a>3\\.2\\.5\\.2 安计允许状态",
          "Allowed state body.",
          "## <a id=\"bookmark7\"></a>3\\.3 CSCI 外部接口需求",
          "0 加热，1 关闭",
          "3\\.3\\.1 接口标识与接口图",
          "Interface body.",
        ].join("\n"),
        "utf-8",
      )

      const raw = await (filldataParser as any).execute(
        {
          mode: "extract",
          file_path: inputPath,
          format: "markdown",
          write_artifacts: true,
        },
        makeCtx(dir),
      )

      const result = JSON.parse(raw)
      const extracted = JSON.parse(readFileSync(result.output.req_segments_path, "utf-8"))
      const ids = extracted.segments.map((segment: { segment_id: string }) => segment.segment_id)
      const allowed = extracted.segments.find((segment: { segment_id: string }) => segment.segment_id === "SRS-3.2.5.2")
      const iface = extracted.segments.find((segment: { segment_id: string }) => segment.segment_id === "SRS-3.3")

      expect(result.ok).toBe(true)
      expect(ids).toContain("SRS-1.1")
      expect(ids).toContain("SRS-3.2")
      expect(ids).toContain("SRS-3.2.5")
      expect(ids).toContain("SRS-3.2.5.2")
      expect(ids).toContain("SRS-3.3")
      expect(ids).not.toContain("SRS-000")
      expect(extracted.segments.some((segment: { segment_id: string; title: string }) =>
        segment.segment_id === "SRS-001" && segment.title === "不做性能测试要求"
      )).toBe(false)
      expect(allowed.section_path_ids).toEqual(["SRS-003", "SRS-3.2", "SRS-3.2.5", "SRS-3.2.5.2"])
      expect(iface.section_path_ids).toEqual(["SRS-3.3"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
