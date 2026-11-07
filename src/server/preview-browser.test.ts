import { expect, test } from "bun:test"
import { PreviewBrowser } from "./preview-browser"

// Exercise the HTTP input/frame boundary with a CDP failure after input commits.
// A frame retry must never apply a click or form submission twice.
async function fixture(errors: Error[]) {
  let clicks = 0, captures = 0, detached = 0
  const browser = new PreviewBrowser({ blockedPorts: () => [], resolveFile: async () => { throw new Error("Not a file preview") } })
  const session = { id: "fixture", scope: "owner", group: "owner", targetId: "target", target: { kind: "host-http", address: "http://localhost:3456/" },
    touched: Date.now(), pending: 0, tail: Promise.resolve(), viewers: new Map(), lastAddress: "http://localhost:3456/",
    page: { bringToFront: async () => {}, url: () => "http://localhost:3456/", title: async () => "Fixture", viewportSize: () => ({ width: 800, height: 600 }), mouse: { click: async () => { clicks++ } } },
    context: { close: async () => {}, newCDPSession: async () => ({
      send: async () => { captures++; if (errors.length) throw errors.shift(); return { data: "fixture-image" } },
      detach: async () => { detached++ },
    }) } }
  ;(browser as any).sessions.set(session.id, session)
  const request = async (click = false) => {
    const url = new URL("http://localhost/api/preview-browser/fixture")
    return (await browser.handle(new Request(url, click ? { method: "POST", body: JSON.stringify({ type: "click", x: 40, y: 50 }) } : {}), url,
      { owner: "owner", scope: "owner", target: () => null }))!
  }
  return { browser, request, counts: () => ({ clicks, captures, detached }) }
}
const unavailable = () => new Error("send: Protocol error (Page.captureScreenshot): Unable to capture screenshot")

test("a transient compositor error retries the frame without replaying input", async () => {
  const f = await fixture([unavailable()])
  try {
    const response = await f.request(true)
    expect(response.status).toBe(200)
    expect((await response.json()).image).toBe("fixture-image")
    expect(f.counts()).toEqual({ clicks: 1, captures: 2, detached: 1 })
  } finally { await f.browser.close() }
})

test("persistent capture failure is bounded and a later GET recovers without another click", async () => {
  const f = await fixture([unavailable(), unavailable(), unavailable()])
  try {
    const response = await f.request(true)
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ retryableFrame: true })
    expect(f.counts()).toEqual({ clicks: 1, captures: 3, detached: 1 })
    expect((await f.request()).status).toBe(200)
    expect(f.counts()).toEqual({ clicks: 1, captures: 4, detached: 2 })
  } finally { await f.browser.close() }
})

test("closed targets and other CDP errors are not retried as compositor failures", async () => {
  const f = await fixture([new Error("Target page, context or browser has been closed")])
  try {
    const response = await f.request(true)
    expect(response.status).toBe(503)
    expect((await response.json()).retryableFrame).toBeUndefined()
    expect(f.counts()).toEqual({ clicks: 1, captures: 1, detached: 1 })
  } finally { await f.browser.close() }
})
