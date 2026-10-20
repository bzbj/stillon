import { expect, test } from "bun:test"
import { ConnectRelay, type RelayObserver, type RelaySocket } from "./relay"

const scope = () => ({ hostId: "fixture", parentId: "fixture", ownerId: "fixture", valid: () => true })

test("relay observes UTF-8 HTTP body bytes once, excludes HEAD bodies and tolerates observer failures", async () => {
  const totals = { upload: 0, download: 0 }
  const observer: RelayObserver = {
    bytes(direction, bytes, transport) {
      expect(transport).toBe("http")
      expect(Number.isSafeInteger(bytes)).toBe(true)
      totals[direction] += bytes
    }, websocket() { throw new Error("Unexpected socket") },
  }
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method === "HEAD") return new Response(null, { headers: { "content-length": "4096" } })
    return new Response(await request.arrayBuffer())
  } })
  const relay = new ConnectRelay("relay", observer)
  try {
    const content = "私密内容🔒".repeat(2048), bytes = Buffer.byteLength(content)
    const request = new Request("http://localhost/", { method: "POST", body: content })
    const response = await relay.http(request, `http://127.0.0.1:${upstream.port}`, new Headers(), scope())
    expect(await response.text()).toBe(content)
    expect(totals).toEqual({ upload: bytes, download: bytes })
    const head = await relay.http(new Request("http://localhost/", { method: "HEAD" }), `http://127.0.0.1:${upstream.port}`, new Headers(), scope())
    expect((await head.arrayBuffer()).byteLength).toBe(0)
    expect(totals).toEqual({ upload: bytes, download: bytes })
    const unavailable = new ConnectRelay("relay", { bytes() { throw new Error("Metrics disk unavailable") }, websocket() {} })
    try {
      const result = await unavailable.http(new Request("http://localhost/", { method: "POST", body: content }), `http://127.0.0.1:${upstream.port}`, new Headers(), scope())
      expect(await result.text()).toBe(content)
    } finally { unavailable.stop() }
  } finally { relay.stop(); await upstream.stop(true) }
})

test("relay observes delivered WebSocket bytes and one connection lifecycle without content or identity", async () => {
  const events: string[] = [], totals = { upload: 0, download: 0 }
  const relay = new ConnectRelay("relay", {
    bytes(direction, bytes, transport) { expect(transport).toBe("websocket"); totals[direction] += bytes },
    websocket(event) { events.push(event) },
  })
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(request, server) { if (server.upgrade(request)) return; return new Response(null, { status: 400 }) },
    websocket: { message(ws, message) { ws.send(message) } },
  })
  const gateway = Bun.serve<RelaySocket>({ hostname: "127.0.0.1", port: 0,
    fetch(request, server) { return relay.upgrade(request, server, `ws://127.0.0.1:${upstream.port}`, new Headers(), scope()) },
    websocket: relay.websocket,
  })
  const ws = new WebSocket(`ws://127.0.0.1:${gateway.port}`)
  try {
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error("Socket failed")) })
    for (const content of ["私密消息🔒", "second message"] ) {
      const message = new Promise<string>(resolve => { ws.onmessage = event => resolve(String(event.data)) })
      ws.send(content)
      expect(await message).toBe(content)
    }
    const bytes = Buffer.byteLength("私密消息🔒second message")
    expect(totals).toEqual({ upload: bytes, download: bytes })
    const closed = new Promise<void>(resolve => { ws.onclose = () => resolve() })
    ws.close() // A normal browser close may omit a status (1005).
    await closed
    for (let attempt = 0; attempt < 30 && !events.includes("close"); attempt++) await Bun.sleep(10)
    expect(events).toEqual(["open", "close"])
    relay.stop()
    expect(events).toEqual(["open", "close"])
  } finally { ws.close(); relay.stop(); await gateway.stop(true); await upstream.stop(true) }
}, 10_000)
