import { describe, expect, test } from "bun:test"
import {
  appendLocalFileLinkLocation,
  getProjectHtmlPreviewPath,
  getProjectRelativeFilePath,
  getProjectRenderablePreviewPath,
  normalizeWindowsLocalFileTarget,
  parseLocalFileLink,
  parseProjectRelativeFileLink,
  parseProjectRelativeHtmlFileLink,
  parseProjectRelativeRenderableFileLink,
  shouldOpenLocalFileLinkInEditor,
} from "./pathUtils"

describe("parseLocalFileLink", () => {
  test("parses an absolute file path with a line fragment", () => {
    expect(parseLocalFileLink("/Users/example/Projects/stillon/src/app.ts#L12")).toEqual({
      path: "/Users/example/Projects/stillon/src/app.ts",
      line: 12,
      column: undefined,
    })
  })

  test("parses an absolute file path without a fragment", () => {
    expect(parseLocalFileLink("/Users/example/Projects/stillon/src/app.ts")).toEqual({
      path: "/Users/example/Projects/stillon/src/app.ts",
    })
  })

  test("parses an absolute file path with a line suffix", () => {
    expect(parseLocalFileLink("/Users/example/Projects/sample-app/scripts/e2b-proxy.mjs:1")).toEqual({
      path: "/Users/example/Projects/sample-app/scripts/e2b-proxy.mjs",
      line: 1,
      column: undefined,
    })
  })

  test("parses an absolute file path with line and column suffixes", () => {
    expect(parseLocalFileLink("/Users/example/Projects/sample-app/scripts/e2b-proxy.mjs:1:2")).toEqual({
      path: "/Users/example/Projects/sample-app/scripts/e2b-proxy.mjs",
      line: 1,
      column: 2,
    })
  })

  test("parses Windows file paths with line and column suffixes", () => {
    expect(parseLocalFileLink("C:\\Users\\iamppr\\stillon\\src\\app.ts:12:3")).toEqual({
      path: "C:/Users/iamppr/stillon/src/app.ts",
      line: 12,
      column: 3,
    })
  })

  test("parses Windows paths with encoded backslashes", () => {
    expect(parseLocalFileLink("C:%5CUsers%5Ciamppr%5Cstillon%5Csrc%5Capp.ts:12:3")).toEqual({
      path: "C:/Users/iamppr/stillon/src/app.ts",
      line: 12,
      column: 3,
    })
    expect(parseLocalFileLink("C:%5cUsers%5ciamppr%5cstillon%5csrc%5capp.ts#L12C3")).toEqual({
      path: "C:/Users/iamppr/stillon/src/app.ts",
      line: 12,
      column: 3,
    })
  })

  test("parses Windows file URIs with encoded backslashes", () => {
    expect(parseLocalFileLink("file:///C:%5CUsers%5Cexample%5Creport.html?theme=dark#summary")).toEqual({
      path: "C:/Users/example/report.html",
      query: "theme=dark",
      fragment: "summary",
    })
  })

  test("normalizes URI-style Windows drive paths", () => {
    expect(parseLocalFileLink("/C:/Users/iamppr/stillon/src/app.ts#L12C3")).toEqual({
      path: "C:/Users/iamppr/stillon/src/app.ts",
      line: 12,
      column: 3,
    })
  })

  test("parses Windows UNC file paths", () => {
    expect(parseLocalFileLink("\\\\server\\share\\reports\\summary.pdf")).toEqual({
      path: "//server/share/reports/summary.pdf",
    })
  })

  test("keeps HTTP URLs as web links even when they share the app origin", () => {
    expect(parseLocalFileLink("http://localhost:9000/Users/example/Projects/sample-app/report.pdf")).toBeNull()
  })

  test("does not treat web links as local file links", () => {
    expect(parseLocalFileLink("https://example.com")).toBeNull()
  })

  test("separates query strings and document fragments from macOS and Windows paths", () => {
    expect(parseLocalFileLink("/Users/example/report.html?theme=dark#summary")).toEqual({
      path: "/Users/example/report.html",
      query: "theme=dark",
      fragment: "summary",
    })
    expect(parseLocalFileLink("C:\\Users\\example\\README.md?plain=1#usage")).toEqual({
      path: "C:/Users/example/README.md",
      query: "plain=1",
      fragment: "usage",
    })
  })

  test("decodes encoded path characters without decoding URL location data", () => {
    expect(parseLocalFileLink("/Users/example/My%20Report.pdf#page=2")).toEqual({
      path: "/Users/example/My Report.pdf",
      fragment: "page=2",
    })
  })
})

describe("normalizeWindowsLocalFileTarget", () => {
  test("only normalizes encoded separators in recognized Windows targets", () => {
    expect(normalizeWindowsLocalFileTarget("C:%5CUsers%5cdemo%5Cindex.html"))
      .toBe("C:/Users/demo/index.html")
    expect(normalizeWindowsLocalFileTarget("file:///C:%5CUsers%5cdemo%5Cindex.html"))
      .toBe("C:/Users/demo/index.html")
    expect(normalizeWindowsLocalFileTarget("C:%5CUsers%5Cdemo%5Cindex.html?pattern=%5Cw#literal-%5C"))
      .toBe("C:/Users/demo/index.html?pattern=%5Cw#literal-%5C")
    expect(normalizeWindowsLocalFileTarget("C:\\Users\\demo\\index.html"))
      .toBe("C:\\Users\\demo\\index.html")
    expect(normalizeWindowsLocalFileTarget("/C:/Users/demo/index.html"))
      .toBe("/C:/Users/demo/index.html")
    expect(normalizeWindowsLocalFileTarget("\\\\server\\share\\index.html"))
      .toBe("\\\\server\\share\\index.html")
    expect(normalizeWindowsLocalFileTarget("https://example.com/a%5Cb"))
      .toBe("https://example.com/a%5Cb")
  })
})

describe("shouldOpenLocalFileLinkInEditor", () => {
  test("opens source, markdown, and text files in the editor", () => {
    expect(shouldOpenLocalFileLinkInEditor("/Users/example/Projects/stillon/src/app.ts")).toBe(true)
    expect(shouldOpenLocalFileLinkInEditor("/Users/example/Projects/stillon/README.md")).toBe(true)
    expect(shouldOpenLocalFileLinkInEditor("/Users/example/Projects/stillon/notes.txt")).toBe(true)
    expect(shouldOpenLocalFileLinkInEditor("/Users/example/Projects/stillon/.gitignore")).toBe(true)
  })

  test("opens media and document files in the default app", () => {
    expect(shouldOpenLocalFileLinkInEditor("/Users/example/Projects/stillon/shot.png")).toBe(false)
    expect(shouldOpenLocalFileLinkInEditor("/Users/example/Projects/stillon/movie.mp4")).toBe(false)
    expect(shouldOpenLocalFileLinkInEditor("/Users/example/Projects/stillon/report.docx")).toBe(false)
    expect(shouldOpenLocalFileLinkInEditor("/Users/example/Projects/stillon/archive.zip")).toBe(false)
  })
})

describe("getProjectHtmlPreviewPath", () => {
  test("returns the relative html path for project-local files", () => {
    expect(getProjectHtmlPreviewPath("/Users/example/Projects/stillon/output/index.html", "/Users/example/Projects/stillon")).toBe("output/index.html")
    expect(getProjectHtmlPreviewPath("/Users/example/Projects/stillon/output/preview.HTM", "/Users/example/Projects/stillon/")).toBe("output/preview.HTM")
    expect(getProjectHtmlPreviewPath("C:\\Users\\iamppr\\stillon\\output\\index.html", "C:\\Users\\iamppr\\stillon")).toBe("output/index.html")
  })

  test("rejects non-html and out-of-project files", () => {
    expect(getProjectHtmlPreviewPath("/Users/example/Projects/stillon/output/index.ts", "/Users/example/Projects/stillon")).toBeNull()
    expect(getProjectHtmlPreviewPath("/Users/example/Projects/stillon-archive/output/index.html", "/Users/example/Projects/stillon")).toBeNull()
  })

  test("rejects paths that escape the project", () => {
    expect(getProjectHtmlPreviewPath("/Users/example/Projects/stillon/../secret.html", "/Users/example/Projects/stillon")).toBeNull()
  })
})

describe("getProjectRenderablePreviewPath", () => {
  test("returns html and markdown preview paths for project-local files", () => {
    expect(getProjectRenderablePreviewPath("/Users/example/Projects/stillon/output/index.html", "/Users/example/Projects/stillon")).toEqual({
      kind: "html",
      path: "output/index.html",
    })
    expect(getProjectRenderablePreviewPath("/Users/example/Projects/stillon/docs/README.md", "/Users/example/Projects/stillon")).toEqual({
      kind: "markdown",
      path: "docs/README.md",
    })
    expect(getProjectRenderablePreviewPath("/Users/example/Projects/stillon/docs/guide.markdown", "/Users/example/Projects/stillon")).toEqual({
      kind: "markdown",
      path: "docs/guide.markdown",
    })
  })

  test("rejects non-renderable and out-of-project files", () => {
    expect(getProjectRenderablePreviewPath("/Users/example/Projects/stillon/output/index.ts", "/Users/example/Projects/stillon")).toBeNull()
    expect(getProjectRenderablePreviewPath("/Users/example/Projects/stillon-archive/README.md", "/Users/example/Projects/stillon")).toBeNull()
    expect(getProjectRenderablePreviewPath("/Users/example/Projects/stillon/../secret.md", "/Users/example/Projects/stillon")).toBeNull()
  })
})

describe("getProjectRelativeFilePath", () => {
  test("returns all project file types and compares Windows paths case-insensitively", () => {
    expect(getProjectRelativeFilePath("/Users/example/Projects/stillon/output/report.xlsx", "/Users/example/Projects/stillon"))
      .toBe("output/report.xlsx")
    expect(getProjectRelativeFilePath("c:\\users\\Example\\Project\\REPORT.PDF", "C:\\Users\\Example\\Project"))
      .toBe("REPORT.PDF")
    expect(getProjectRelativeFilePath("//SERVER/Share/Project/reports/data.xlsx", "\\\\server\\share\\project"))
      .toBe("reports/data.xlsx")
    expect(getProjectRelativeFilePath("/C:/Users/Example/Project/docs/README.md", "C:\\Users\\Example\\Project"))
      .toBe("docs/README.md")
  })

  test("rejects sibling projects and path escapes", () => {
    expect(getProjectRelativeFilePath("/Users/example/Projects/stillon-copy/report.pdf", "/Users/example/Projects/stillon")).toBeNull()
    expect(getProjectRelativeFilePath("/Users/example/Projects/stillon/../secret.pdf", "/Users/example/Projects/stillon")).toBeNull()
  })
})

describe("parseProjectRelativeHtmlFileLink", () => {
  test("resolves relative html links against the project path", () => {
    expect(parseProjectRelativeHtmlFileLink("./output/index.html#L12C3", "/Users/example/Projects/stillon")).toEqual({
      path: "/Users/example/Projects/stillon/output/index.html",
      line: 12,
      column: 3,
    })
  })

  test("rejects external links, non-html files, and project escapes", () => {
    expect(parseProjectRelativeHtmlFileLink("https://example.com/index.html", "/Users/example/Projects/stillon")).toBeNull()
    expect(parseProjectRelativeHtmlFileLink("output/index.ts", "/Users/example/Projects/stillon")).toBeNull()
    expect(parseProjectRelativeHtmlFileLink("../secret.html", "/Users/example/Projects/stillon")).toBeNull()
  })
})

describe("parseProjectRelativeRenderableFileLink", () => {
  test("resolves relative html and markdown links against the project path", () => {
    expect(parseProjectRelativeRenderableFileLink("./output/index.html#L12C3", "/Users/example/Projects/stillon")).toEqual({
      path: "/Users/example/Projects/stillon/output/index.html",
      line: 12,
      column: 3,
    })
    expect(parseProjectRelativeRenderableFileLink("docs/README.md", "/Users/example/Projects/stillon")).toEqual({
      path: "/Users/example/Projects/stillon/docs/README.md",
    })
  })

  test("rejects external links, non-renderable files, and project escapes", () => {
    expect(parseProjectRelativeRenderableFileLink("https://example.com/README.md", "/Users/example/Projects/stillon")).toBeNull()
    expect(parseProjectRelativeRenderableFileLink("output/index.ts", "/Users/example/Projects/stillon")).toBeNull()
    expect(parseProjectRelativeRenderableFileLink("../secret.md", "/Users/example/Projects/stillon")).toBeNull()
  })
})

describe("parseProjectRelativeFileLink", () => {
  test("resolves PDF, Excel, extensionless, and anchored document links from the project root", () => {
    expect(parseProjectRelativeFileLink("./output/report.pdf", "/Users/example/Projects/stillon")).toEqual({
      path: "/Users/example/Projects/stillon/output/report.pdf",
    })
    expect(parseProjectRelativeFileLink("data/report.xlsx?download=latest", "C:\\Users\\example\\stillon")).toEqual({
      path: "C:/Users/example/stillon/data/report.xlsx",
      query: "download=latest",
    })
    expect(parseProjectRelativeFileLink("Makefile", "/Users/example/Projects/stillon")).toEqual({
      path: "/Users/example/Projects/stillon/Makefile",
    })
    expect(parseProjectRelativeFileLink("docs/README.md#usage", "/Users/example/Projects/stillon")).toEqual({
      path: "/Users/example/Projects/stillon/docs/README.md",
      fragment: "usage",
    })
  })

  test("rejects external URLs, document-only fragments, and project escapes", () => {
    expect(parseProjectRelativeFileLink("https://example.com/report.pdf", "/Users/example/Projects/stillon")).toBeNull()
    expect(parseProjectRelativeFileLink("#usage", "/Users/example/Projects/stillon")).toBeNull()
    expect(parseProjectRelativeFileLink("../secret.pdf", "/Users/example/Projects/stillon")).toBeNull()
  })
})

describe("appendLocalFileLinkLocation", () => {
  test("preserves preview query strings and fragments", () => {
    expect(appendLocalFileLinkLocation("/preview/index.html", { query: "theme=dark", fragment: "summary" }))
      .toBe("/preview/index.html?theme=dark#summary")
  })
})
