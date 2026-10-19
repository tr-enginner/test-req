import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  copyFileSync,
} from "fs"
import { join, basename } from "path"
import { execSync } from "child_process"
import {
  BOOK_DIR,
  REPORTS_DIR,
  REPORT_CHAPTERS,
} from "../shared/constants"
import { runtimeAssetRoot } from "../shared/runtime-paths"

/** Resolve the bundled mdbook binary path (installed by postinstall script) */
function resolveMdbookBin(): string {
  const pluginRoot = runtimeAssetRoot(import.meta.url)
  const binary = process.platform === "win32" ? "mdbook.exe" : "mdbook"
  const binaryPath = join(pluginRoot, "bin", binary)

  if (!existsSync(binaryPath)) {
    throw new Error(
      `mdbook binary not found at ${binaryPath}. Run "bun install" to download it.`,
    )
  }

  return binaryPath
}

/** Build SUMMARY.md content from available report files */
function buildSummary(
  reportsDir: string,
  projectName: string,
): string {
  const existing = existsSync(reportsDir)
    ? new Set(readdirSync(reportsDir))
    : new Set<string>()

  let md = `# Summary\n\n`
  md += `[${projectName}](./README.md)\n\n`

  for (const ch of REPORT_CHAPTERS) {
    if (existing.has(ch.file)) {
      // For directory-based chapters (like code-wiki), link to README.md inside
      const chPath = join(reportsDir, ch.file)
      if (existsSync(chPath) && statSync(chPath).isDirectory()) {
        md += `- [${ch.title}](./${ch.file}/README.md)\n`
      } else {
        md += `- [${ch.title}](./${ch.file})\n`
      }
    }
  }

  // Include code-wiki chapter if it exists as a subdirectory
  const codeWikiDir = join(reportsDir, "code-wiki")
  if (existsSync(codeWikiDir)) {
    // Check if code-wiki has its own SUMMARY.md with nested structure
    const wikiSummaryPath = join(codeWikiDir, "SUMMARY.md")
    if (existsSync(wikiSummaryPath)) {
      const wikiSummary = readFileSync(wikiSummaryPath, "utf-8")
      // Adjust relative paths from ./file.md to ./code-wiki/file.md
      const adjustedSummary = wikiSummary
        .replace(/\]\(\.\//g, "](./code-wiki/")
        .replace(/^# .+$/m, "")
        .trim()
      if (adjustedSummary) {
        md += adjustedSummary + "\n"
      }
    } else {
      // Fallback: list all .md files in code-wiki/
      md += `- [Code Understanding](./code-wiki/README.md)\n`
      const wikiFiles = readdirSync(codeWikiDir).filter(
        (f) => f.endsWith(".md") && f !== "SUMMARY.md" && f !== "README.md"
      )
      for (const f of wikiFiles) {
        const title = basename(f, ".md")
          .replace(/-/g, " ")
          .replace(/\b\w/g, (c) => c.toUpperCase())
        md += `  - [${title}](./code-wiki/${f})\n`
      }
      // List domain subdirectory files
      const domainsDir = join(codeWikiDir, "domains")
      if (existsSync(domainsDir)) {
        const domainFiles = readdirSync(domainsDir).filter((f) => f.endsWith(".md"))
        for (const f of domainFiles) {
          const title = basename(f, ".md")
            .replace(/-/g, " ")
            .replace(/\b\w/g, (c) => c.toUpperCase())
          md += `  - [${title}](./code-wiki/domains/${f})\n`
        }
      }
    }
  }

  // Include any extra .md files not in REPORT_CHAPTERS
  const knownFiles = new Set(REPORT_CHAPTERS.map((c) => c.file))
  knownFiles.add("SUMMARY.md")
  knownFiles.add("README.md")
  knownFiles.add("code-wiki")
  for (const f of existing) {
    if (f.endsWith(".md") && !knownFiles.has(f)) {
      const title = basename(f, ".md")
        .replace(/-/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase())
      md += `- [${title}](./${f})\n`
    }
  }

  return md
}

/** Recursively copy a directory */
function copyDirRecursive(src: string, dest: string): void {
  if (!existsSync(dest)) mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry)
    const destPath = join(dest, entry)
    if (statSync(srcPath).isDirectory()) {
      copyDirRecursive(srcPath, destPath)
    } else {
      copyFileSync(srcPath, destPath)
    }
  }
}

/**
 * mdbook_generate — Assemble .matrix/reports/*.md into an mdbook HTML site.
 * Requires the bundled mdbook binary (installed by postinstall).
 */
export const mdbookGenerator: ToolDefinition = tool({
  description:
    "Generate a browsable HTML documentation site from all .matrix/reports/*.md files " +
    "using the bundled mdbook binary. Outputs the site to .matrix/book/.",
  args: {
    project_dir: tool.schema
      .string()
      .describe("Project root directory (absolute path)"),
    title: tool.schema
      .string()
      .optional()
      .describe("Book title (defaults to project name or 'Matrix Test Report')"),
  },
  async execute({ project_dir, title }) {
    const reportsDir = join(project_dir, REPORTS_DIR)
    const bookDir = join(project_dir, BOOK_DIR)
    const srcDir = join(bookDir, "src")

    // 1. Verify reports exist
    if (!existsSync(reportsDir)) {
      return JSON.stringify({
        error: "No reports directory found. Run the testing workflow first.",
        path: reportsDir,
      })
    }

    const mdFiles = readdirSync(reportsDir).filter((f) => f.endsWith(".md"))
    if (mdFiles.length === 0) {
      return JSON.stringify({
        error: "No .md reports found in .matrix/reports/.",
        path: reportsDir,
      })
    }

    // 2. Locate bundled mdbook binary
    let mdbookBin: string
    try {
      mdbookBin = resolveMdbookBin()
    } catch (err) {
      return JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
      })
    }

    // 3. Scaffold book structure
    if (!existsSync(srcDir)) {
      mkdirSync(srcDir, { recursive: true })
    }

    const bookTitle = title || "Matrix Test Report"

    // Copy report .md files into src/
    for (const f of mdFiles) {
      const content = readFileSync(join(reportsDir, f), "utf-8")
      writeFileSync(join(srcDir, f), content, "utf-8")
    }

    // Copy code-wiki subdirectory if it exists
    const codeWikiSrc = join(reportsDir, "code-wiki")
    if (existsSync(codeWikiSrc)) {
      copyDirRecursive(codeWikiSrc, join(srcDir, "code-wiki"))
    }

    // Generate README.md (landing page)
    const readmePath = join(srcDir, "README.md")
    if (!existsSync(readmePath)) {
      writeFileSync(
        readmePath,
        `# ${bookTitle}\n\nThis documentation site contains all test reports generated by the Matrix testing workflow.\n`,
        "utf-8",
      )
    }

    // Generate SUMMARY.md
    writeFileSync(
      join(srcDir, "SUMMARY.md"),
      buildSummary(reportsDir, bookTitle),
      "utf-8",
    )

    // Generate book.toml
    writeFileSync(
      join(bookDir, "book.toml"),
      [
        `[book]`,
        `title = "${bookTitle}"`,
        `authors = ["Matrix Embedded Agent"]`,
        `language = "zh"`,
        `src = "src"`,
        ``,
        `[output.html]`,
        `no-section-label = false`,
        ``,
      ].join("\n"),
      "utf-8",
    )

    // 4. Run mdbook build
    try {
      execSync(`"${mdbookBin}" build "${bookDir}"`, {
        stdio: "pipe",
        timeout: 60_000,
        cwd: project_dir,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return JSON.stringify({
        error: `mdbook build failed: ${msg}`,
        book_dir: bookDir,
      })
    }

    const outputDir = join(bookDir, "book")
    const indexHtml = join(outputDir, "index.html")

    return JSON.stringify({
      status: "success",
      book_dir: bookDir,
      output_dir: outputDir,
      index_html: indexHtml,
      chapters: mdFiles.length,
      message: `HTML site generated with ${mdFiles.length} chapters at ${outputDir}`,
    })
  },
})
