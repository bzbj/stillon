import { expect, test } from "bun:test"
import { fileRenderer, IMAGE_EXTENSIONS } from "./file-renderers"
import { getLinkActions } from "./link-actions"
import { resolveLinkTarget } from "../client/lib/linkTarget"

test("B01–B08 default actions and menu order", () => {
  const rows = [
    { kind: "external", local: true, expected: [], action: undefined },
    { kind: "external", local: false, expected: [], action: undefined },
    { kind: "file", renderer: "html", local: true, expected: ["preview", "open_default", "open_finder"], action: "preview" },
    { kind: "file", renderer: "image", local: false, expected: ["preview", "download"], action: "preview" },
    { kind: "file", local: true, expected: ["open_default", "open_finder"], action: "open_default" },
    { kind: "file", local: false, expected: ["download"], action: "download" },
    { kind: "service", local: true, expected: ["preview", "open_default"], action: "preview" },
    { kind: "service", local: false, expected: ["preview"], action: "preview" },
  ] as const
  for (const row of rows) {
    const result = getLinkActions(row)
    expect(result.actions.map(item => item.action)).toEqual([...row.expected])
    expect(result.defaultAction).toBe(row.action)
  }
  expect(getLinkActions({ kind: "file", local: true, isMac: true }).actions.at(-1)?.label).toBe("Show in Finder")
  expect(getLinkActions({ kind: "file", renderer: "image", local: false, readable: false }).actions.every(item => item.disabled)).toBe(true)
})
test("renderer registry uses explicit types and includes image paths without executing other files", () => {
  for (const extension of IMAGE_EXTENSIONS) expect(fileRenderer(`中文 image.${extension.toUpperCase()}`)).toBe("image")
  expect(fileRenderer("report.DOCX")).toBeUndefined()
  expect(fileRenderer("image.RAW")).toBeUndefined()
  expect(fileRenderer("app.json")).toBe("text")
  expect(fileRenderer("index.HTM")).toBe("html")
})
test("actual href and trusted origins classify web links independently of suffixes and labels", () => {
  for (const href of ["https://example.com/report.md", "https://localhost.example.com/", "http://127.0.0.1.example.com/", "https://example.com/api/projects/workspace/preview/index.html"]) expect(resolveLinkTarget(href)?.kind).toBe("external")
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) expect(resolveLinkTarget(`http://${host}:3000/app?q=1#section`)).toEqual({ kind: "service", address: `http://${host}:3000/app?q=1#section` })
  for (const href of ["http://user:password@localhost:3000/", "http://localhost:99999/", "javascript:alert(1)", "a\u0000.txt"]) expect(resolveLinkTarget(href)).toBeNull()
  expect(resolveLinkTarget("~/Documents/report.txt")?.kind).toBe("file")
  expect(resolveLinkTarget("file:///Users/example/图%20片.png")?.kind).toBe("file")
  expect(resolveLinkTarget("/preview/opaque")?.kind).toBe("internal")
  expect(resolveLinkTarget("http://localhost:0/")).toBeNull()
  expect(resolveLinkTarget("http://127.1:3000/app")).toEqual({ kind: "service", address: "http://127.0.0.1:3000/app" })
  expect(resolveLinkTarget("docs/a%2520b.txt", { localPath: "/workspace" })).toEqual({ kind: "file", file: { path: "/workspace/docs/a%20b.txt" } })
})
