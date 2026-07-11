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
      expect(parseLocalFileLink("http://localhost:9000/Users/example/Projects/sample-app/scripts/e2b-proxy.mjs:1")).toEqual({
        path: "/Users/example/Projects/sample-app/scripts/e2b-proxy.mjs",
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
