import { expect, test } from "bun:test"
import { appendHttpTiming } from "./http-timing"

test("timing preserves streamed response bytes, existing stages and redirects", async () => {
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("streamed bytes")); controller.close() } }), { headers: { "Server-Timing": "adapter-upstream;dur=2" } })
  const timed = appendHttpTiming(response, "host", performance.now())
  expect(timed.headers.get("Server-Timing")).toContain("adapter-upstream;dur=2")
  expect(timed.headers.get("Server-Timing")).toMatch(/host;dur=\d+\.\d+/u)
  expect(await timed.text()).toBe("streamed bytes")
  const redirect = appendHttpTiming(Response.redirect("https://example.com/"), "connect", performance.now())
  expect(redirect.status).toBe(302)
  expect(redirect.headers.get("Location")).toBe("https://example.com/")
  expect(appendHttpTiming(undefined, "host", performance.now())).toBeUndefined()
})
