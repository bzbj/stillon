import { describe, expect, test } from "bun:test"
import {
  buildProjectFileContentUrl,
  buildProjectFilePreviewUrl,
  buildProjectMarkdownPreviewUrl,
  buildProjectRenderablePreviewUrl,
  isProjectMarkdownPreviewPath,
  parseProjectMarkdownPreviewUrl,
} from "./project-file-urls"

describe("project file urls", () => {
  test("builds content and download urls with encoded file paths", () => {
    expect(buildProjectFileContentUrl("project-1", "dist/demo page.html"))
      .toBe("/api/projects/project-1/files/dist%2Fdemo%20page.html/content")
    expect(buildProjectFileContentUrl("project-1", "dist/demo page.html", { download: true }))
      .toBe("/api/projects/project-1/files/dist%2Fdemo%20page.html/content?download=1")
  })

  test("builds preview urls with path segments preserved", () => {
    expect(buildProjectFilePreviewUrl("project-1", "dist/demo page.html"))
      .toBe("/api/projects/project-1/preview/dist/demo%20page.html")
  })

  test("builds markdown preview urls for markdown files", () => {
    expect(buildProjectMarkdownPreviewUrl("project-1", "docs/Guide Page.md"))
      .toBe("/api/projects/project-1/markdown-preview/docs/Guide%20Page.md")
    expect(buildProjectRenderablePreviewUrl("project-1", "docs/Guide Page.md"))
      .toBe("/api/projects/project-1/markdown-preview/docs/Guide%20Page.md")
    expect(buildProjectRenderablePreviewUrl("project-1", "dist/index.html"))
      .toBe("/api/projects/project-1/preview/dist/index.html")
  })

  test("parses markdown preview urls", () => {
    expect(parseProjectMarkdownPreviewUrl("/api/projects/project-1/markdown-preview/docs/Guide%20Page.md"))
      .toEqual({ projectId: "project-1", filePath: "docs/Guide Page.md" })
    expect(parseProjectMarkdownPreviewUrl("/api/projects/project-1/markdown-preview/dist/index.html"))
      .toBeNull()
    expect(parseProjectMarkdownPreviewUrl("https://example.com/api/projects/project-1/markdown-preview/README.md"))
      .toBeNull()
    expect(parseProjectMarkdownPreviewUrl("/api/projects/project-1/markdown-preview/docs/README.md?plain=1#usage"))
      .toEqual({ projectId: "project-1", filePath: "docs/README.md" })
  })

  test("detects markdown preview paths", () => {
    expect(isProjectMarkdownPreviewPath("README.md")).toBe(true)
    expect(isProjectMarkdownPreviewPath("docs/README.markdown")).toBe(true)
    expect(isProjectMarkdownPreviewPath("notes.mdown")).toBe(true)
    expect(isProjectMarkdownPreviewPath("index.html")).toBe(false)
  })
})
