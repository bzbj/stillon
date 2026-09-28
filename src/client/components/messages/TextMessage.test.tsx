import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { OpenLocalLinkProvider } from "./shared"
import { TextMessage } from "./TextMessage"
import { TranscriptRenderOptionsProvider } from "./render-context"

function renderImage(src: string, localPath = "/Users/example/project", exportMode = false) {
  return renderToStaticMarkup(
    <TranscriptRenderOptionsProvider value={exportMode ? { localLinkMode: "text" } : {}}>
      <OpenLocalLinkProvider projectId="project-1" localPath={localPath}>
        <TextMessage message={{
          id: "assistant-image",
          kind: "assistant_text",
          text: `![chart](<${src}>)`,
          timestamp: "2026-09-28T00:00:00Z",
        }} />
      </OpenLocalLinkProvider>
    </TranscriptRenderOptionsProvider>
  )
}

describe("chat Markdown images", () => {
  test.each([
    "/Users/example/project/output/chart.png",
    "./output/chart.png",
    "output/chart.png",
  ])("routes %s through the project endpoint on local and remote origins", (src) => {
    const html = renderImage(src)
    const imageSrc = html.match(/<img[^>]*src="([^"]+)"/)?.[1]
    expect(imageSrc).toBe("/api/projects/project-1/files/output%2Fchart.png/content")
    for (const origin of ["http://127.0.0.1:3210", "http://100.64.0.1:3210", "https://stillon.example.com"]) {
      const url = new URL(imageSrc!, origin)
      expect(url.origin).toBe(origin)
      expect(url.pathname).toBe(imageSrc!)
    }
  })

  test("encodes spaces, Chinese characters, and URL delimiters in filenames", () => {
    const html = renderImage("/Users/example/project/output/图片%20a%23b%3Fc.png")
    expect(html).toContain('src="/api/projects/project-1/files/output%2F%E5%9B%BE%E7%89%87%20a%23b%3Fc.png/content"')
  })

  test.each([
    "C:/Users/example/project/output/chart.png",
    "C:%5CUsers%5Cexample%5Cproject%5Coutput%5Cchart.png",
    "file:///C:/Users/example/project/output/chart.png",
  ])("supports Windows image path %s", (src) => {
    expect(renderImage(src, "C:/Users/example/project"))
      .toContain('src="/api/projects/project-1/files/output%2Fchart.png/content"')
  })

  test("uses the existing guarded local-file route for project-external images", () => {
    expect(renderImage("/Users/example/other/chart.png"))
      .toContain('src="/api/local-files/content/%2FUsers%2Fexample%2Fother%2Fchart.png"')
  })

  test.each([
    "https://images.example.com/chart.png",
    "//images.example.com/chart.png",
    "/api/projects/project-1/uploads/chart.png/content",
    "/api/local-files/content/%2Ftmp%2Fchart.png",
    "/assets/chart.png",
    "/favicon.png",
  ])("preserves web image URL %s", (src) => {
    expect(renderImage(src)).toContain(`src="${src}"`)
  })

  test("does not request host images from standalone text-mode exports", () => {
    const html = renderImage("/Users/example/project/chart.png", undefined, true)
    expect(html).toContain("<span>chart</span>")
    expect(html).not.toContain("<img")
    expect(html).not.toContain("/api/")
  })

  test("retains protocol sanitization for image sources", () => {
    for (const src of ["javascript:alert", "data:image/png;base64,abcd"]) {
      expect(renderImage(src)).not.toContain(`src="${src}"`)
    }
  })
})

describe("TextMessage", () => {
  test("preserves Windows absolute file links for local preview handling", () => {
    const filePath = "C:/Users/iamppr/output/report.html"
    const html = renderToStaticMarkup(
      <OpenLocalLinkProvider onOpenLocalLink={() => {}}>
        <TextMessage
          message={{
            id: "assistant-1",
            kind: "assistant_text",
            text: `[report.html](${filePath})`,
            timestamp: new Date().toISOString(),
          }}
        />
      </OpenLocalLinkProvider>
    )

    expect(html).toContain(`href="${filePath}"`)
    expect(html).not.toContain('target="_blank"')
  })

  test("normalizes encoded Windows paths and file URIs for local preview handling", () => {
    const html = renderToStaticMarkup(
      <OpenLocalLinkProvider onOpenLocalLink={() => {}}>
        <TextMessage
          message={{
            id: "assistant-1",
            kind: "assistant_text",
            text: [
              "[report.html](C:%5CUsers%5cdemo%5Coutput%5Creport.html)",
              "[index.html](file:///C:%5CUsers%5cdemo%5Coutput%5Cindex.html)",
            ].join("\n\n"),
            timestamp: new Date().toISOString(),
          }}
        />
      </OpenLocalLinkProvider>
    )

    expect(html).toContain('href="C:/Users/demo/output/report.html"')
    expect(html).toContain('href="C:/Users/demo/output/index.html"')
    expect(html).not.toContain('target="_blank"')
  })

  test("continues to sanitize unsafe non-file protocols", () => {
    const html = renderToStaticMarkup(
      <TextMessage
        message={{
          id: "assistant-1",
          kind: "assistant_text",
          text: "[unsafe](javascript:alert(1))",
          timestamp: new Date().toISOString(),
        }}
      />
    )

    expect(html).not.toContain("javascript:")
    expect(html).toContain('href=""')
  })
})
