import { describe, expect, test } from "bun:test"
import { buildBrowserPreviewProxyUrl } from "./browser-preview-proxy"

describe("buildBrowserPreviewProxyUrl", () => {
  test("keeps localhost addresses direct during local Kanna access", () => {
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

  test("leaves same-origin relative preview addresses unchanged", () => {
    expect(buildBrowserPreviewProxyUrl(
      "/api/projects/project-1/preview/output/index.html",
      new URL("https://stillon.example.com/chat/demo")
    )).toBe("/api/projects/project-1/preview/output/index.html")
  })
})
