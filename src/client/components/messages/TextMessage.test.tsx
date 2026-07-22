import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { OpenLocalLinkProvider } from "./shared"
import { TextMessage } from "./TextMessage"

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
