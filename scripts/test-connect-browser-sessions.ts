import assert from "node:assert/strict"
import { Database } from "bun:sqlite"
import path from "node:path"
import { createConnectFixture, eventually } from "./connect-fixture"
import { upstreamWebSocket } from "../src/server/connect/relay"
import type { ConnectBrowserSessions, ConnectLocalStatus } from "../src/shared/connect"

for (const key of Object.keys(process.env)) if (key.startsWith("STILLON_UPDATE_") || key.startsWith("STILLON_CONNECT_") || key === "STILLON_RUNTIME_PROFILE") delete process.env[key]
const fixture = await createConnectFixture(2)
const sockets: WebSocket[] = []
const bound: ConnectLocalStatus[] = []
const cookies = (response: Response) => response.headers.getSetCookie().map(v => v.split(";")[0]).join("; ")
const localOrigin = (index: number) => `http://127.0.0.1:${fixture.hosts[index]!.port}`
const checks: string[] = []
async function local(index: number, route: string, body?: unknown) {
  return fetch(`${localOrigin(index)}/api/connect-local/${route}`, { method: body === undefined ? "GET" : "POST",
    headers: { Origin: localOrigin(index), "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })
}
async function central(route: string, body?: unknown, cookie = "", userAgent = "Mozilla/5.0 (Macintosh) Chrome/140 Safari/537") {
  return fetch(fixture.origin + "/api/connect/" + route, { method: body === undefined ? "GET" : "POST", headers: { Origin: fixture.origin,
    "Content-Type": "application/json", Cookie: cookie, "User-Agent": userAgent }, body: body === undefined ? undefined : JSON.stringify(body) })
}
async function login(enrollment?: string, userAgent?: string) {
  // Isolated synthetic mail only: avoid a real cooldown between fixture logins.
  const guard = new Database(path.join(fixture.root, "cloud/guard.sqlite")); guard.exec("DELETE FROM connect_rate_event"); guard.close()
  const body = { email: "sessions@example.com", ...(enrollment ? { intent: { purpose: "enroll", id: enrollment } } : {}) }
  const pending = await central("request-code", body)
  assert.equal(pending.status, 200)
  const verified = await central("verify-code", { ...body, code: fixture.messages.at(-1)!.code, remember: true }, cookies(pending), userAgent)
  assert.equal(verified.status, 200)
  return cookies(verified)
}
async function host(index: number, route: string, cookie = "", body?: unknown) {
  const origin = new URL(bound[index]!.url!)
  return fetch(`http://127.0.0.1:${fixture.port}${route}`, { method: body === undefined ? "GET" : "POST", redirect: "manual",
    headers: { Host: origin.host, Origin: origin.origin, Cookie: cookie, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })
}
async function enter(index: number, parent: string) {
  const started = await host(index, "/_connect/login")
  const flow = new URL(started.headers.get("location")!).searchParams.get("flow")
  const allowed = await central("authorize", { flow }, parent); assert.equal(allowed.status, 200)
  const callback = new URL((await allowed.json()).redirect)
  const exchanged = await host(index, callback.pathname + callback.search, cookies(started)); assert.equal(exchanged.status, 303)
  return cookies(exchanged)
}
async function openSocket(index: number, cookie: string) {
  const origin = new URL(bound[index]!.url!)
  const ws = upstreamWebSocket(`ws://127.0.0.1:${fixture.port}/ws`, new Headers({ Host: origin.host, Origin: origin.origin, Cookie: cookie }))
  sockets.push(ws)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Socket timed out")), 8_000)
    ws.addEventListener("open", () => { clearTimeout(timer); resolve() }, { once: true })
    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Socket failed")) }, { once: true })
  })
  return ws
}
async function command(ws: WebSocket, command: object) {
  const id = `${Date.now()}-${crypto.randomUUID()}`
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Command timed out")), 5_000)
    const listener = (event: MessageEvent) => { const message = JSON.parse(String(event.data)); if (message.id === id) {
      clearTimeout(timer); ws.removeEventListener("message", listener); assert.equal(message.type, "ack"); resolve()
    } }
    ws.addEventListener("message", listener); ws.send(JSON.stringify({ v: 1, type: "command", id, command }))
  })
}
async function listLocal(index = 0) {
  const response = await local(index, "sessions"); assert.equal(response.status, 200)
  return response.json() as Promise<ConnectBrowserSessions>
}
try {
  const parents: string[] = []
  for (let index = 0; index < 2; index++) {
    const enrollment = await eventually(async () => { const response = await local(index, "enroll", {}); return response.ok ? response.json() : null }, value => Boolean(value?.id))
    parents.push(await login(enrollment.id, index ? "Mozilla/5.0 (Windows) Firefox/142" : undefined))
    bound.push(await eventually(async () => (await local(index, "status")).json() as Promise<ConnectLocalStatus>, value => value.state === "online"))
  }
  parents.push(await login(undefined, "Mozilla/5.0 (iPhone) Version/19 Safari/605"))
  const [a0, a1, b0, c0] = await Promise.all([enter(0, parents[0]!), enter(1, parents[0]!), enter(0, parents[1]!), enter(0, parents[2]!)])
  const [wa0, wa1, wb0] = await Promise.all([openSocket(0, a0), openSocket(1, a1), openSocket(0, b0)])
  const listed = await listLocal()
  assert.equal(listed.sessions.length, 3)
  assert.ok(listed.sessions.every(row => !row.current && row.expiresAt > listed.now && row.lastUsedAt !== null))
  assert.deepEqual((await listLocal(1)).sessions.map(s => s.id).sort(), listed.sessions.map(s => s.id).sort())
  const remoteList = await (await host(0, "/_connect/sessions", c0)).json() as ConnectBrowserSessions
  assert.equal(remoteList.sessions.filter(row => row.current).length, 1)
  const currentId = remoteList.sessions.find(row => row.current)!.id
  const aId = listed.sessions.find(row => row.browser === "Chrome")!.id
  const bId = listed.sessions.find(row => row.browser === "Firefox")!.id
  checks.push("two local computers and remote Settings agree on three browser logins; tabs do not duplicate counts; only the remote caller is current")

  const guard = new Database(path.join(fixture.root, "cloud/guard.sqlite"))
  const old = Date.now() - 120_000
  guard.query("UPDATE connect_session_activity SET lastUsedAt=? WHERE sessionId=?").run(old, bId)
  await command(wb0, { type: "system.ping" })
  for (const route of ["/auth/status", "/api/sidebar-view"]) {
    const response = await host(0, route, b0)
    assert.equal(response.status, 200)
    await response.arrayBuffer()
  }
  assert.equal((await listLocal()).sessions.find(row => row.id === bId)!.lastUsedAt, old)
  await command(wb0, { type: "filesystem.listDirectories", localPath: fixture.root })
  assert.ok((await listLocal()).sessions.find(row => row.id === bId)!.lastUsedAt! > old)
  guard.close()
  checks.push("real gateway/frp/adapter command updates durable usage; background ping, auth and sidebar polling do not")

  assert.equal((await host(0, "/api/connect-local/sessions", c0)).status, 403)
  assert.equal((await local(0, "sessions/revoke", { sessionId: aId, extra: true })).status, 400)
  assert.equal((await listLocal()).sessions.length, 3)
  assert.equal((await local(0, "sessions/revoke", { sessionId: aId })).status, 200)
  await eventually(async () => [wa0.readyState, wa1.readyState], states => states.every(state => state === WebSocket.CLOSED))
  assert.equal(wb0.readyState, WebSocket.OPEN)
  assert.equal((await host(0, "/_connect/sessions", a0)).status, 401)
  assert.equal((await central("sessions", undefined, parents[0]!)).status, 401)
  assert.equal((await listLocal(1)).sessions.length, 2)
  checks.push("local revocation closes both computers' target-browser streams and invalidates its account/host cookies, preserving another browser")

  assert.equal((await host(0, "/_connect/sessions/revoke", c0, { sessionId: bId })).status, 200)
  await eventually(async () => wb0.readyState, state => state === WebSocket.CLOSED)
  assert.deepEqual((await listLocal()).sessions.map(row => row.id), [currentId])
  assert.equal((await host(0, "/_connect/sessions/revoke", c0, { sessionId: currentId })).status, 200)
  assert.equal((await host(0, "/_connect/sessions", c0)).status, 401)
  assert.equal((await listLocal()).sessions.length, 0)
  for (let index = 0; index < 2; index++) assert.equal((await (await local(index, "status")).json()).state, "online")
  checks.push("remote revocation and self-revocation persist across rereads; both computer bindings remain online")
  console.log(JSON.stringify({ ok: true, checks }, null, 2))
} finally {
  for (const socket of sockets) {
    const terminate = (socket as unknown as { terminate?: () => void }).terminate
    if (terminate) terminate.call(socket); else socket.close()
  }
  await fixture.stop()
}
