import { describe, expect, test } from "bun:test"
import {
  buildProjectFileContentUrl,
  buildProjectFilePreviewUrl,
  buildProjectMarkdownPreviewUrl,
  buildProjectRenderablePreviewUrl,
  isProjectMarkdownPreviewPath,
  parseProjectMarkdownPreviewUrl,
  normalizeProjectPreviewAddress,
  parseProjectFilePreviewUrl,
} from "./project-file-urls"

describe("project file urls", () => {
  test("resolves file preview actions on the connected computer with Unicode and locations", () => {
    expect(parseProjectFilePreviewUrl("/api/projects/p1/preview/output/状态%20file.json?theme=dark#L12"))
      .toEqual({projectId:"p1",filePath:"output/状态 file.json"})
    expect(parseProjectFilePreviewUrl("https://external.example/api/projects/p1/preview/status.json")).toBeNull()
    for (const suffix of ["..%2fsecret.json", "%2fetc%2fpasswd", "C%3a%2fprivate.json", "%00status.json"])
      expect(parseProjectFilePreviewUrl("/api/projects/p1/preview/"+suffix)).toBeNull()
  })
  test("keeps saved loopback workspace previews on the connected origin", () => {
    const route = "/api/projects/p1/preview/output/demo%20page.html?theme=dark#chart"
    for (const origin of ["http://localhost:3210", "http://127.0.0.1:3210", "https://h-computer.connect.stillon.cc"]) {
      expect(normalizeProjectPreviewAddress("http://127.0.0.1:3210" + route, "p1", origin)).toBe(route)
    }
    for (const url of ["https://external.example" + route, "http://localhost:3210/api/projects/other/preview/index.html", "http://localhost:5173/index.html"]) {
      expect(normalizeProjectPreviewAddress(url, "p1", "https://h-computer.connect.stillon.cc")).toBe(url)
    }
  })
  test("does not turn application URLs or credential URLs into file grants", () => {
    const route = "/api/projects/p1/preview/private.html"
    for (const origin of ["http://localhost:3210", "https://h-computer.connect.stillon.cc"]) {
      for (const url of ["http://localhost:5173" + route, "http://127.0.0.1:443" + route,
        "http://user:password@localhost:3210" + route, "https://user:password@h-computer.connect.stillon.cc" + route]) {
        expect(normalizeProjectPreviewAddress(url, "p1", origin)).toBe(url)
      }
    }
    expect(normalizeProjectPreviewAddress("http://localhost:43210" + route, "p1", "http://127.0.0.1:43210")).toBe(route)
    expect(normalizeProjectPreviewAddress("http://localhost:43210" + route, "p1", "https://h-computer.connect.stillon.cc"))
      .toBe("http://localhost:43210" + route)
  })
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
