import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createConnectFixture, eventually } from "./connect-fixture"
import { upstreamWebSocket } from "../src/server/connect/relay"
import type { ConnectLocalStatus } from "../src/shared/connect"

// No provider requests, real mail, production ports or personal projects.
for (const key of Object.keys(process.env)) if (key.startsWith("STILLON_UPDATE_") || key === "STILLON_RUNTIME_PROFILE") delete process.env[key]
const packageArgument = process.argv.find(argument => argument.startsWith("--cloud-package="))?.slice("--cloud-package=".length)
const packagedCloud = packageArgument ? await import(pathToFileURL(path.resolve(packageArgument, "src/connect/server.ts")).href) : null
const fixture = await createConnectFixture(2, packagedCloud?.startConnectServer)
console.log("Isolated cloud and two computers started")
const cookies = (response: Response) => response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ")
const sockets: WebSocket[] = []
const checks: string[] = []
async function local(index: number, action = "status") {
  const origin = `http://127.0.0.1:${fixture.hosts[index]!.port}`
  return fetch(`${origin}/api/connect-local/${action}`, { method: action === "status" ? "GET" : "POST", headers: { Origin: origin } })
}
async function central(route: string, body?: unknown, cookie = "") {
  return fetch(`${fixture.origin}/api/connect/${route}`, { method: body === undefined ? "GET" : "POST", headers: { Origin: fixture.origin, "Content-Type": "application/json", Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) })
}
async function login(email: string, intent?: { purpose: "enroll"; id: string }) {
  const pending = await central("request-code", { email, ...(intent ? { intent } : {}) })
  assert.equal(pending.status, 200)
  const response = await central("verify-code", { email, code: fixture.messages.at(-1)!.code, remember: true, ...(intent ? { intent } : {}) }, cookies(pending))
  assert.equal(response.status, 200)
  return cookies(response)
}
const bound: ConnectLocalStatus[] = []
const hostCookies: string[] = []
async function host(index: number, route: string, init: RequestInit = {}) {
  const url = new URL(bound[index]!.url!)
  return fetch(`http://127.0.0.1:${fixture.port}${route}`, { ...init, signal: AbortSignal.timeout(30_000), redirect: "manual", headers: { Host: url.host, Origin: url.origin, Cookie: hostCookies[index] ?? "", ...Object.fromEntries(new Headers(init.headers)) } })
}
async function enter(index: number, parent: string) {
  const redirect = await host(index, "/_connect/login")
  const flow = new URL(redirect.headers.get("location")!).searchParams.get("flow")
  const authorized = await central("authorize", { flow }, parent)
  assert.equal(authorized.status, 200)
  const callback = new URL((await authorized.json()).redirect)
  const response = await host(index, callback.pathname + callback.search, { headers: { Cookie: cookies(redirect) } })
  assert.equal(response.status, 303)
  return cookies(response)
}
async function socket(index: number) {
  const url = new URL(bound[index]!.url!)
  const ws = upstreamWebSocket(`ws://127.0.0.1:${fixture.port}/ws`, new Headers({ Host: url.host, Origin: url.origin, Cookie: hostCookies[index]! }))
  sockets.push(ws)
  await new Promise<void>((resolve, reject) => { const timeout = setTimeout(() => reject(new Error("WebSocket timed out")), 10_000); ws.addEventListener("open", () => { clearTimeout(timeout); resolve() }, { once: true }); ws.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("WebSocket failed")) }, { once: true }) })
  return ws
}
async function command(ws: WebSocket, type: object, id = `${Date.now()}-${crypto.randomUUID()}`) {
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => { ws.removeEventListener("message", read); reject(new Error("Command timed out")) }, 5_000)
    const read = (event: MessageEvent) => { const value = JSON.parse(String(event.data)); if (value.id === id) { clearTimeout(timer); ws.removeEventListener("message", read); resolve(value) } }
    ws.addEventListener("message", read); ws.send(JSON.stringify({ v: 1, type: "command", id, command: type }))
  })
}
try {
  const email = "tester@example.com"
  for (let i = 0; i < 2; i++) {
    const enrollment = await eventually(async () => { const response = await local(i, "enroll"); return response.ok ? response.json() : null }, value => Boolean(value?.id))
    console.log(`Computer ${i + 1}: enrollment created`)
    // Separate synthetic accounts exercise ownership without weakening the
    // production resend budget. Browser QA covers two hosts for one account.
    const parent = await login(i ? "second@example.com" : email, { purpose: "enroll", id: enrollment.id })
    console.log(`Computer ${i + 1}: email verified`)
    let lastState = ""
    const status = await eventually<ConnectLocalStatus>(async () => {
      const current = await (await local(i)).json() as ConnectLocalStatus
      const safe = `${current.state}:${current.error ?? ""}`
      if (safe !== lastState) { console.log(`Computer ${i + 1}: ${safe}`); lastState = safe }
      return current
    }, value => value.state === "online")
    bound.push(status)
    // This fixture first creates independent accounts, then tests ownership
    // isolation. The same-owner multiple-host flow is covered in browser QA and
    // service.test.ts without shortening production mail limits.
    hostCookies.push(await enter(i, parent))
  }
  checks.push("fresh-OTP enrollment and two independent outbound connectors")
  for (let i = 0; i < 2; i++) {
    const status = await (await host(i, "/auth/status")).json()
    assert.equal(status.authenticated, true); assert.equal(status.host.id, bound[i]!.hostId)
    assert.equal((await host(i, "/api/connect-local/unbind", { method: "POST" })).status, 403)
    assert.equal((await host(i, "/_stillon/update/pause", { method: "POST" })).status, 403)
    assert.equal((await host(i, "/api/browser-proxy/80/")).status, 403)
  }
  assert.equal((await host(0, "/health", { headers: { Origin: bound[1]!.url! } })).status, 403)
  assert.equal((await host(0, "/api/test", { headers: { Cookie: hostCookies[1]! } })).status, 401)
  checks.push("owner, origin, local controls and private-network preview isolation")
  const ws1 = await socket(0), ws2 = await socket(1)
  const project = fixture.hosts[0]!.store.listProjects()[0]!
  const operationId = `${Date.now()}-${crypto.randomUUID()}`
  const created = await command(ws1, { type: "chat.create", projectId: project.id }, operationId)
  assert.equal(created.type, "ack")
  const repeated = await command(ws1, { type: "chat.create", projectId: project.id }, operationId)
  assert.equal(repeated.result.chatId, created.result.chatId)
  assert.equal((await command(ws1, { type: "settings.requestManagedUpdate" })).type, "error")
  assert.equal((await command(ws2, { type: "system.ping" })).type, "ack")
  checks.push("real StillOn WebSocket commands and durable duplicate suppression")
  const payload = randomBytes(20 * 1024 * 1024)
  console.log("Checking 20 MiB upload")
  const form = new FormData(); form.append("files", new File([payload], "test.bin"))
  const upload = await host(0, `/api/projects/${project.id}/uploads`, { method: "POST", body: form })
  if (!upload.ok) throw new Error(`Upload failed: ${upload.status} ${await upload.text()}`)
  assert.equal(upload.status, 200)
  console.log("Upload complete; checking download")
  const attachment = (await upload.json()).attachments[0]
  const download = await host(0, attachment.contentUrl)
  assert.equal(download.status, 200)
  assert.equal(createHash("sha256").update(await download.bytes()).digest("hex"), createHash("sha256").update(payload).digest("hex"))
  checks.push("20 MiB upload and download through the complete gateway/tunnel/adapter path")
  console.log("Download verified")
  const preview = await host(0, `/api/projects/${project.id}/preview/report.html`)
  assert.equal(preview.status, 200)
  assert.match(preview.headers.get("content-security-policy")!, /sandbox/)
  assert.doesNotMatch(preview.headers.get("content-security-policy")!, /allow-same-origin/)
  for (let i = 0; i < 40; i++) { const response = await host(0, "/health"); assert.equal(response.status, 200); await response.arrayBuffer() }
  checks.push("active-file sandbox headers and completed-request lease cleanup")
  const identityFile = path.join(fixture.root, "computer-1/connect/device.json")
  const raw = await readFile(identityFile, "utf8")
  assert.ok(raw.includes("privateKey"))
  assert.ok(!JSON.stringify(await (await local(0)).json()).includes("privateKey"))
  if (process.platform !== "win32") assert.equal((await stat(identityFile)).mode & 0o777, 0o600)
  checks.push("device identity stays local with owner-only file permissions")
  console.log("Checking renewal across the original 45 s lease boundary")
  for (let i = 0; i < 4; i++) {
    await Bun.sleep(13_000)
    assert.equal((await command(ws1, { type: "system.ping" })).type, "ack")
    assert.equal((await command(ws2, { type: "system.ping" })).type, "ack")
  }
  checks.push("both active WebSocket leases renew across 52 s without reconnecting")
  const logout = await host(0, "/auth/logout", { method: "POST" })
  assert.equal(logout.status, 200)
  await eventually(async () => ws1.readyState, value => value === WebSocket.CLOSED, 5_000)
  assert.equal((await host(0, "/api/test")).status, 401)
  assert.equal((await command(ws2, { type: "system.ping" })).type, "ack")
  assert.ok(fixture.hosts[0]!.store.getChat(created.result.chatId))
  assert.equal((await (await local(0)).json()).state, "online")
  checks.push("Logout closes remote streams while preserving binding and local task state")
  assert.ok((await eventually(async () => local(1, "pause"), response => response.ok)).ok)
  await eventually(async () => ws2.readyState, value => value === WebSocket.CLOSED, 5_000)
  const offline = await host(1, "/", { headers: { Accept: "text/html" } })
  assert.equal(offline.status, 503); assert.ok((await offline.text()).includes("Logout"))
  assert.ok((await eventually(async () => local(1, "resume"), response => response.ok)).ok)
  await eventually<ConnectLocalStatus>(async () => (await local(1)).json(), value => value.state === "online")
  assert.ok((await eventually(async () => local(1, "unbind"), response => response.ok)).ok)
  await eventually<ConnectLocalStatus>(async () => (await local(1)).json(), value => value.state === "unbound")
  assert.equal((await host(1, "/api/test")).status, 401)
  assert.ok(fixture.hosts[1]!.store.listProjects().length)
  checks.push("pause, resume, offline page and unbind preserve workspace data")
  console.log(JSON.stringify({ passed: true, platform: process.platform, architecture: process.arch, checks }, null, 2))
} catch (error) { console.error("Integration check failed:", error); throw error }
finally { for (const ws of sockets) ws.close(); await fixture.stop() }
