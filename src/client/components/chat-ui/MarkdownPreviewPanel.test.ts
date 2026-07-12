import { describe, expect, test } from "bun:test"
import { resolveMarkdownResourcePath } from "./MarkdownPreviewPanel"

describe("resolveMarkdownResourcePath", () => {
  test("resolves local resources from POSIX paths", () => {
    expect(resolveMarkdownResourcePath(
      { kind: "local", filePath: "/Users/example/docs/README.md" },
      "../images/chart.png",
    )).toBe("/Users/example/images/chart.png")
  })

  test("resolves relative and absolute local resources from Windows paths", () => {
    expect(resolveMarkdownResourcePath(
      { kind: "local", filePath: "C:\\Users\\iamppr\\docs\\README.md" },
      "../images/chart.png",
    )).toBe("C:/Users/iamppr/images/chart.png")

    expect(resolveMarkdownResourcePath(
      { kind: "local", filePath: "C:\\Users\\iamppr\\docs\\README.md" },
      "D:\\assets\\chart.png",
    )).toBe("D:/assets/chart.png")
  })

  test("keeps project resources relative and rejects web urls", () => {
    expect(resolveMarkdownResourcePath(
      { kind: "project", projectId: "project-1", filePath: "docs/README.md" },
      "../images/chart.png",
    )).toBe("images/chart.png")
    expect(resolveMarkdownResourcePath(
      { kind: "local", filePath: "C:\\Users\\iamppr\\docs\\README.md" },
      "https://example.com/chart.png",
    )).toBeNull()
  })
})
