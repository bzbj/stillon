import { describe, expect, test } from "bun:test"
import { LOCAL_HTML_PREVIEW_SESSION_ENDPOINT } from "../../shared/local-file-urls"
import { requestLocalHtmlPreviewUrl } from "./localHtmlPreview"

describe("requestLocalHtmlPreviewUrl", () => {
  test("creates a short-lived preview session for an absolute HTML path", async () => {
    const requests: Array<{ input: string, init?: RequestInit }> = []
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ input: String(input), init })
      return Response.json({
        url: `${LOCAL_HTML_PREVIEW_SESSION_ENDPOINT}/token/index.html`,
        expiresAt: Date.now() + 60_000,
      }, { status: 201 })
    }) as typeof fetch

    await expect(requestLocalHtmlPreviewUrl("/Users/example/preview/index.html", fetchImpl))
      .resolves.toBe(`${LOCAL_HTML_PREVIEW_SESSION_ENDPOINT}/token/index.html`)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.input).toBe(LOCAL_HTML_PREVIEW_SESSION_ENDPOINT)
    expect(requests[0]?.init?.method).toBe("POST")
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      filePath: "/Users/example/preview/index.html",
    })
  })

  test("surfaces the server safety error instead of falling back to an editor", async () => {
    const fetchImpl = (async () => Response.json({
      error: "Project-external HTML previews are disabled.",
    }, { status: 403 })) as typeof fetch

    await expect(requestLocalHtmlPreviewUrl("/Users/example/preview/index.html", fetchImpl))
      .rejects.toThrow("Project-external HTML previews are disabled.")
  })
})
