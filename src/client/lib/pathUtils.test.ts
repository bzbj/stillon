import { describe, expect, test } from "bun:test"
import {
  getProjectHtmlPreviewPath,
  getProjectRenderablePreviewPath,
  parseLocalFileLink,
  parseProjectRelativeHtmlFileLink,
  parseProjectRelativeRenderableFileLink,
  shouldOpenLocalFileLinkInEditor,
} from "./pathUtils"

describe("parseLocalFileLink", () => {
  test("parses an absolute file path with a line fragment", () => {
    expect(parseLocalFileLink("/Users/jake/Projects/kanna/src/app.ts#L12")).toEqual({
      path: "/Users/jake/Projects/kanna/src/app.ts",
      line: 12,
      column: undefined,
    })
  })

  test("parses an absolute file path without a fragment", () => {
    expect(parseLocalFileLink("/Users/jake/Projects/kanna/src/app.ts")).toEqual({
      path: "/Users/jake/Projects/kanna/src/app.ts",
    })
  })

  test("parses an absolute file path with a line suffix", () => {
    expect(parseLocalFileLink("/Users/jake/Kanna/superwall-agent/scripts/e2b-proxy.mjs:1")).toEqual({
      path: "/Users/jake/Kanna/superwall-agent/scripts/e2b-proxy.mjs",
      line: 1,
      column: undefined,
    })
  })

  test("parses an absolute file path with line and column suffixes", () => {
    expect(parseLocalFileLink("/Users/jake/Kanna/superwall-agent/scripts/e2b-proxy.mjs:1:2")).toEqual({
      path: "/Users/jake/Kanna/superwall-agent/scripts/e2b-proxy.mjs",
      line: 1,
      column: 2,
    })
  })

  test("parses same-origin absolute file urls with a line suffix", () => {
    const originalWindow = globalThis.window
    Object.defineProperty(globalThis, "window", {
      value: {
        location: {
          origin: "http://localhost:9000",
        },
      },
      configurable: true,
    })

    try {
      expect(parseLocalFileLink("http://localhost:9000/Users/jake/Kanna/superwall-agent/scripts/e2b-proxy.mjs:1")).toEqual({
        path: "/Users/jake/Kanna/superwall-agent/scripts/e2b-proxy.mjs",
        line: 1,
        column: undefined,
      })
    } finally {
      Object.defineProperty(globalThis, "window", {
        value: originalWindow,
        configurable: true,
      })
    }
  })

  test("does not treat web links as local file links", () => {
    expect(parseLocalFileLink("https://example.com")).toBeNull()
  })
})

describe("shouldOpenLocalFileLinkInEditor", () => {
  test("opens source, markdown, and text files in the editor", () => {
    expect(shouldOpenLocalFileLinkInEditor("/Users/jake/Projects/kanna/src/app.ts")).toBe(true)
    expect(shouldOpenLocalFileLinkInEditor("/Users/jake/Projects/kanna/README.md")).toBe(true)
    expect(shouldOpenLocalFileLinkInEditor("/Users/jake/Projects/kanna/notes.txt")).toBe(true)
    expect(shouldOpenLocalFileLinkInEditor("/Users/jake/Projects/kanna/.gitignore")).toBe(true)
  })

  test("opens media and document files in the default app", () => {
    expect(shouldOpenLocalFileLinkInEditor("/Users/jake/Projects/kanna/shot.png")).toBe(false)
    expect(shouldOpenLocalFileLinkInEditor("/Users/jake/Projects/kanna/movie.mp4")).toBe(false)
    expect(shouldOpenLocalFileLinkInEditor("/Users/jake/Projects/kanna/report.docx")).toBe(false)
    expect(shouldOpenLocalFileLinkInEditor("/Users/jake/Projects/kanna/archive.zip")).toBe(false)
  })
})

describe("getProjectHtmlPreviewPath", () => {
  test("returns the relative html path for project-local files", () => {
    expect(getProjectHtmlPreviewPath("/Users/jake/Projects/kanna/output/index.html", "/Users/jake/Projects/kanna")).toBe("output/index.html")
    expect(getProjectHtmlPreviewPath("/Users/jake/Projects/kanna/output/preview.HTM", "/Users/jake/Projects/kanna/")).toBe("output/preview.HTM")
  })

  test("rejects non-html and out-of-project files", () => {
    expect(getProjectHtmlPreviewPath("/Users/jake/Projects/kanna/output/index.ts", "/Users/jake/Projects/kanna")).toBeNull()
    expect(getProjectHtmlPreviewPath("/Users/jake/Projects/kanna-archive/output/index.html", "/Users/jake/Projects/kanna")).toBeNull()
  })

  test("rejects paths that escape the project", () => {
    expect(getProjectHtmlPreviewPath("/Users/jake/Projects/kanna/../secret.html", "/Users/jake/Projects/kanna")).toBeNull()
  })
})

describe("getProjectRenderablePreviewPath", () => {
  test("returns html and markdown preview paths for project-local files", () => {
    expect(getProjectRenderablePreviewPath("/Users/jake/Projects/kanna/output/index.html", "/Users/jake/Projects/kanna")).toEqual({
      kind: "html",
      path: "output/index.html",
    })
    expect(getProjectRenderablePreviewPath("/Users/jake/Projects/kanna/docs/README.md", "/Users/jake/Projects/kanna")).toEqual({
      kind: "markdown",
      path: "docs/README.md",
    })
    expect(getProjectRenderablePreviewPath("/Users/jake/Projects/kanna/docs/guide.markdown", "/Users/jake/Projects/kanna")).toEqual({
      kind: "markdown",
      path: "docs/guide.markdown",
    })
  })

  test("rejects non-renderable and out-of-project files", () => {
    expect(getProjectRenderablePreviewPath("/Users/jake/Projects/kanna/output/index.ts", "/Users/jake/Projects/kanna")).toBeNull()
    expect(getProjectRenderablePreviewPath("/Users/jake/Projects/kanna-archive/README.md", "/Users/jake/Projects/kanna")).toBeNull()
    expect(getProjectRenderablePreviewPath("/Users/jake/Projects/kanna/../secret.md", "/Users/jake/Projects/kanna")).toBeNull()
  })
})

describe("parseProjectRelativeHtmlFileLink", () => {
  test("resolves relative html links against the project path", () => {
    expect(parseProjectRelativeHtmlFileLink("./output/index.html#L12C3", "/Users/jake/Projects/kanna")).toEqual({
      path: "/Users/jake/Projects/kanna/output/index.html",
      line: 12,
      column: 3,
    })
  })

  test("rejects external links, non-html files, and project escapes", () => {
    expect(parseProjectRelativeHtmlFileLink("https://example.com/index.html", "/Users/jake/Projects/kanna")).toBeNull()
    expect(parseProjectRelativeHtmlFileLink("output/index.ts", "/Users/jake/Projects/kanna")).toBeNull()
    expect(parseProjectRelativeHtmlFileLink("../secret.html", "/Users/jake/Projects/kanna")).toBeNull()
  })
})

describe("parseProjectRelativeRenderableFileLink", () => {
  test("resolves relative html and markdown links against the project path", () => {
    expect(parseProjectRelativeRenderableFileLink("./output/index.html#L12C3", "/Users/jake/Projects/kanna")).toEqual({
      path: "/Users/jake/Projects/kanna/output/index.html",
      line: 12,
      column: 3,
    })
    expect(parseProjectRelativeRenderableFileLink("docs/README.md", "/Users/jake/Projects/kanna")).toEqual({
      path: "/Users/jake/Projects/kanna/docs/README.md",
    })
  })

  test("rejects external links, non-renderable files, and project escapes", () => {
    expect(parseProjectRelativeRenderableFileLink("https://example.com/README.md", "/Users/jake/Projects/kanna")).toBeNull()
    expect(parseProjectRelativeRenderableFileLink("output/index.ts", "/Users/jake/Projects/kanna")).toBeNull()
    expect(parseProjectRelativeRenderableFileLink("../secret.md", "/Users/jake/Projects/kanna")).toBeNull()
  })
})
