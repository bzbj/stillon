import { expect, test } from "bun:test"
import { startRemoteAdapter, REMOTE_HEADER, REMOTE_OWNER_HEADER, REMOTE_SESSION_HEADER, REMOTE_EXPIRY_HEADER } from "./adapter"
import { newDeviceKeys, randomId, randomToken, signLease } from "./crypto"
import { upstreamWebSocket } from "./relay"
import type { AccessLease } from "../../shared/connect"

test("adapter requires a signed lease and streams multipart uploads without exposing identity headers", async () => {
  const keys = newDeviceKeys(), secret = randomToken(), hostId = randomId()
  const target = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    expect(request.headers.get(REMOTE_HEADER)).toBe(secret)
    expect(request.headers.get(REMOTE_OWNER_HEADER)).toBe("owner")
    expect(request.headers.get(REMOTE_SESSION_HEADER)).toBe("parent")
    expect(Number(request.headers.get(REMOTE_EXPIRY_HEADER))).toBeGreaterThan(Date.now())
    expect(Number(request.headers.get(REMOTE_EXPIRY_HEADER))).toBeLessThanOrEqual(Date.now() + 10_000)
    expect(request.headers.get("cookie")).toBeNull()
    const form = await request.formData(), file = form.get("files") as File
    return Response.json({ size: file?.size, name: file?.name })
  } })
  const adapter = startRemoteAdapter({ targetOrigin: `http://127.0.0.1:${target.port}`, publicKey: keys.publicKey, localSecret: secret, hostId, epoch: 1, generation: 1 })
  const url = `http://127.0.0.1:${adapter.port}/api/upload`
  const lease = (): AccessLease => ({ v: 1, id: randomId(), hostId, sessionId: "session", parentId: "parent", ownerId: "owner", epoch: 1, generation: 1, method: "POST", path: "/api/upload", issuedAt: Date.now(), expiresAt: Date.now() + 10_000 })
  try {
    expect((await fetch(url, { method: "POST" })).status).toBe(403)
    for (let i = 0; i < 35; i++) {
      const size = i === 0 ? 20 * 1024 * 1024 : 64 * 1024
      const form = new FormData(); form.append("files", new File([new Uint8Array(size)], "sample.bin"))
      const response = await fetch(url, { method: "POST", headers: { "x-stillon-connect-lease": signLease(lease(), keys.privateKey), Cookie: "should-not-pass=true" }, body: form })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ size, name: "sample.bin" })
    }
    expect(adapter.activeLeases()).toHaveLength(0)
  } finally { await adapter.stop(); await target.stop(true) }
})

test("an established stream closes when its lease expires without control-plane renewal", async () => {
  const keys = newDeviceKeys(), hostId = randomId()
  const target = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request, server) { if (server.upgrade(request)) return; return new Response() }, websocket: { message(ws, value) { ws.send(value) } } })
  const adapter = startRemoteAdapter({ targetOrigin: `http://127.0.0.1:${target.port}`, publicKey: keys.publicKey, localSecret: randomToken(), hostId, epoch: 1, generation: 1 })
  const now = Date.now(), lease: AccessLease = { v: 1, id: randomId(), hostId, sessionId: "session", parentId: "parent", ownerId: "owner", epoch: 1, generation: 1, method: "GET", path: "/ws", issuedAt: now, expiresAt: now + 1_500 }
  const ws = upstreamWebSocket(`ws://127.0.0.1:${adapter.port}/ws`, new Headers({ "x-stillon-connect-lease": signLease(lease, keys.privateKey) }))
  try {
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("Connection did not open")), 2_000); ws.addEventListener("open", () => { clearTimeout(timer); resolve() }, { once: true }); ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Connection failed")) }, { once: true }) })
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("Expired stream remained open")), 3_500); ws.addEventListener("close", () => { clearTimeout(timer); resolve() }, { once: true }) })
    expect(Date.now() - now).toBeLessThan(3_500)
  } finally { ws.close(); await adapter.stop(); await target.stop(true) }
}, 6_000)

test("a double-slash request path cannot change the adapter's private upstream", async () => {
  const keys = newDeviceKeys(), hostId = randomId(), secret = randomToken()
  let decoyHits = 0
  const decoy = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { decoyHits++; return new Response("wrong server") } })
  const target = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    expect(request.headers.get(REMOTE_HEADER)).toBe(secret)
    return new Response(new URL(request.url).pathname)
  } })
  const adapter = startRemoteAdapter({ targetOrigin: `http://127.0.0.1:${target.port}`, publicKey: keys.publicKey, localSecret: secret, hostId, epoch: 1, generation: 1 })
  const route = `//127.0.0.1:${decoy.port}/private`
  const lease: AccessLease = { v: 1, id: randomId(), hostId, sessionId: "session", parentId: "parent", ownerId: "owner", epoch: 1, generation: 1, method: "GET", path: route, issuedAt: Date.now(), expiresAt: Date.now() + 10_000 }
  try {
    const response = await fetch(`http://127.0.0.1:${adapter.port}${route}`, { headers: { "x-stillon-connect-lease": signLease(lease, keys.privateKey) } })
    // Bun may normalize the ambiguous request before the lease comparison.
    // Either reject it, or preserve it as a path on the fixed target.
    expect([200, 403]).toContain(response.status)
    if (response.status === 200) expect(await response.text()).toBe(route)
    expect(decoyHits).toBe(0)
    const normal = { ...lease, path: "/private" }
    const control = await fetch(`http://127.0.0.1:${adapter.port}/private`, { headers: { "x-stillon-connect-lease": signLease(normal, keys.privateKey) } })
    expect(control.status).toBe(200); expect(await control.text()).toBe("/private")
    for (const changed of [{ hostId: randomId() }, { epoch: 2 }, { generation: 2 }, { method: "POST" }, { path: "/other" }]) {
      const denied = await fetch(`http://127.0.0.1:${adapter.port}/private`, { headers: { "x-stillon-connect-lease": signLease({ ...normal, ...changed }, keys.privateKey) } })
      expect(denied.status).toBe(403)
    }
  } finally { await adapter.stop(); await target.stop(true); await decoy.stop(true) }
})
