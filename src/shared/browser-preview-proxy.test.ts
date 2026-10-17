import { describe, expect, test } from "bun:test"
import { buildBrowserPreviewProxyUrl } from "./browser-preview-proxy"

describe("buildBrowserPreviewProxyUrl", () => {
  test("keeps localhost addresses direct during local Still On access", () => {
    expect(buildBrowserPreviewProxyUrl(
      "http://localhost:5173/demo?x=1#top",
      new URL("http://localhost:3210/chat/demo")
    )).toBe("http://localhost:5173/demo?x=1#top")
  })

  test("routes localhost addresses through the same-origin proxy during remote access", () => {
    expect(buildBrowserPreviewProxyUrl(
      "http://localhost:5173/demo?x=1#top",
      new URL("https://stillon.example.com/chat/demo")
    )).toBe("/api/browser-proxy/5173/demo?x=1#top")
  })

  test("leaves non-loopback addresses unchanged", () => {
    expect(buildBrowserPreviewProxyUrl(
      "https://example.com/demo",
      new URL("https://stillon.example.com/chat/demo")
    )).toBe("https://example.com/demo")
  })

  test("opens managed Connect previews through an isolated-origin handoff", () => {
    expect(buildBrowserPreviewProxyUrl(
      "http://127.0.0.1:5173/dashboard?filter=active#chart",
      new URL("https://h-0123456789abcdef0123456789abcdef.connect.example.com/chat/demo"),
    )).toBe("/_connect/preview/5173/dashboard?filter=active#chart")
  })

  test("handles default HTTP ports and explains unsupported local HTTPS previews", () => {
    const remote = new URL("https://h-0123456789abcdef0123456789abcdef.connect.example.com")
    expect(buildBrowserPreviewProxyUrl("http://localhost/demo", remote)).toBe("/_connect/preview/80/demo")
    expect(buildBrowserPreviewProxyUrl("https://localhost:5173/demo", remote)).toBe("/_connect/preview-unsupported")
  })

  test("leaves same-origin relative preview addresses unchanged", () => {
    expect(buildBrowserPreviewProxyUrl(
      "/api/projects/project-1/preview/output/index.html",
      new URL("https://stillon.example.com/chat/demo")
    )).toBe("/api/projects/project-1/preview/output/index.html")
  })
})
