import { expect, test } from "bun:test"
import { parsePreviewTarget, isGrantedPreviewNavigation } from "./preview-target"

test("preview targets preserve locations and enforce workspace and protocol boundaries", () => {
  expect(parsePreviewTarget("http://[::1]:5173/app?tab=one#section")?.kind).toBe("host-http")
  expect(parsePreviewTarget("https://example.com/app?tab=one#section")?.address).toBe("https://example.com/app?tab=one#section")
  expect(parsePreviewTarget("/api/projects/workspace/markdown-preview/中文%20report.md?tab=one#section", "workspace")?.kind).toBe("project-file")
  for (const address of ["//evil.example/", "javascript:alert(1)", "data:text/html,test", "file:///tmp/index.html", "http://user:secret@localhost/", "/api/settings", "/api/projects/other/preview/app.html", "/api/projects/workspace/preview/..%2Fsecret.html"]) {
    expect(parsePreviewTarget(address, "workspace")).toBeNull()
  }
})
test("reported navigation cannot turn an app redirect into a new loopback grant", () => {
  const local = parsePreviewTarget("http://localhost:5173/app")!
  const external = parsePreviewTarget("https://example.com/")!
  expect(isGrantedPreviewNavigation(local, "http://localhost:5173/nested?tab=one#section")).toBe(true)
  for (const address of ["http://localhost:3210/", "http://127.0.0.1:5173/", "file:///tmp/private", "http://user:secret@localhost:5173/"]) expect(isGrantedPreviewNavigation(local, address)).toBe(false)
  expect(isGrantedPreviewNavigation(external, "http://localhost:5173/")).toBe(false)
  expect(isGrantedPreviewNavigation(external, "https://example.org/")).toBe(true)
  expect(isGrantedPreviewNavigation(local, "http://localhost:3210/", "http://document.preview.invalid")).toBe(false)
})
