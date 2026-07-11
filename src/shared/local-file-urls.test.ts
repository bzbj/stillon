import { describe, expect, test } from "bun:test"
import {
  buildLocalFileContentUrl,
  buildLocalMarkdownPreviewUrl,
  isLocalMarkdownPreviewPath,
  parseLocalFileContentUrl,
  parseLocalMarkdownPreviewUrl,
} from "./local-file-urls"

describe("local file urls", () => {
  test("builds local file content and markdown preview urls", () => {
    expect(buildLocalFileContentUrl("/Users/hakimi/.agents/skills/lark-apps/SKILL.md"))
      .toBe("/api/local-files/content/%2FUsers%2Fhakimi%2F.agents%2Fskills%2Flark-apps%2FSKILL.md")

    expect(buildLocalMarkdownPreviewUrl("/Users/hakimi/.agents/skills/lark-apps/SKILL.md"))
      .toBe("/api/local-files/markdown-preview/%2FUsers%2Fhakimi%2F.agents%2Fskills%2Flark-apps%2FSKILL.md")
  })

  test("parses local markdown preview urls", () => {
    expect(parseLocalMarkdownPreviewUrl("/api/local-files/markdown-preview/%2FUsers%2Fhakimi%2F.agents%2Fskills%2Flark-apps%2FSKILL.md"))
      .toEqual({ filePath: "/Users/hakimi/.agents/skills/lark-apps/SKILL.md" })

    expect(parseLocalMarkdownPreviewUrl("https://macbook.linjunkai.com/api/local-files/markdown-preview/%2FUsers%2Fhakimi%2F.agents%2Fskills%2Flark-apps%2FSKILL.md"))
      .toEqual({ filePath: "/Users/hakimi/.agents/skills/lark-apps/SKILL.md" })
  })

  test("parses local file content urls only for markdown files", () => {
    expect(parseLocalFileContentUrl("/api/local-files/content/%2FUsers%2Fhakimi%2Fnotes.markdown"))
      .toEqual({ filePath: "/Users/hakimi/notes.markdown" })
    expect(parseLocalFileContentUrl("/api/local-files/content/%2FUsers%2Fhakimi%2Fsecret.env"))
      .toBeNull()
  })

  test("identifies local markdown preview paths", () => {
    expect(isLocalMarkdownPreviewPath("/Users/hakimi/.agents/skills/lark-apps/SKILL.md")).toBe(true)
    expect(isLocalMarkdownPreviewPath("/Users/hakimi/README.mdown")).toBe(true)
    expect(isLocalMarkdownPreviewPath("/Users/hakimi/index.html")).toBe(false)
  })
})
