import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createServer } from "vite"
import { createConnectFixture, eventually, freePort } from "./connect-fixture"
import { upstreamWebSocket } from "../src/server/connect/relay"
import type { ConnectLocalStatus } from "../src/shared/connect"

// Synthetic accounts, isolated data and a real frps/frpc tunnel. Never starts
// an Agent, sends mail, or touches the installed application.
for (const key of Object.keys(process.env)) if (key.startsWith("STILLON_UPDATE_") || key === "STILLON_RUNTIME_PROFILE") delete process.env[key]
const packageArgument = process.argv.find(value => value.startsWith("--cloud-package="))?.slice("--cloud-package=".length)
const cloud = packageArgument ? await import(pathToFileURL(path.resolve(packageArgument, "src/connect/server.ts")).href) : null
const fixture = await createConnectFixture(2, cloud?.startConnectServer)
const sockets: WebSocket[] = []
let vite: Awaited<ReturnType<typeof createServer>> | undefined
const checks: string[] = []
const cookies = (response: Response) => response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ")
const hosts: { origin: string; cookie: string }[] = []
async function local(index: number, action = "status") {
  const origin = "http://127.0.0.1:" + fixture.hosts[index]!.port
  return fetch(origin + "/api/connect-local/" + action, { method: action === "status" ? "GET" : "POST", headers: { origin } })
}
async function central(route: string, body: unknown, cookie = "") {
  return fetch(fixture.origin + "/api/connect/" + route, { method: "POST", headers: { origin: fixture.origin, "Content-Type": "application/json", cookie }, body: JSON.stringify(body) })
}
async function publicRequest(url: URL | string, init: RequestInit = {}) {
  const target = new URL(url)
  return fetch("http://127.0.0.1:" + fixture.port + target.pathname + target.search, { ...init, redirect: "manual", signal: AbortSignal.timeout(15_000),
    headers: { host: target.host, ...Object.fromEntries(new Headers(init.headers)) } })
}
async function host(index: number, route: string, init: RequestInit = {}) {
  const current = hosts[index]!
  return publicRequest(current.origin + route, { ...init, headers: { origin: current.origin, cookie: current.cookie, ...Object.fromEntries(new Headers(init.headers)) } })
}
async function applicationJson(response: Response) {
  const text = await response.text()
  assert.equal(response.status, 200, "Application response: " + text.slice(0, 160))
  try { return JSON.parse(text) } catch { throw new Error("Invalid application JSON at " + new URL(response.url).pathname + ": " + text.slice(0, 160)) }
}
async function openSocket(url: string, headers: Headers, protocols: string[] = []) {
  const ws = upstreamWebSocket(url, headers, protocols)
  const messages: string[] = []
  ws.addEventListener("message", event => messages.push(String(event.data)))
  sockets.push(ws)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket timed out")), 10_000)
    ws.addEventListener("open", () => { clearTimeout(timer); resolve() }, { once: true })
    ws.addEventListener("error", event => { clearTimeout(timer); reject(new Error("WebSocket failed at " + new URL(url).pathname + ": " + (event as ErrorEvent).message)) }, { once: true })
  })
  return { ws, messages }
}
async function command(ws: WebSocket, command: object) {
  const id = Date.now() + "-" + crypto.randomUUID()
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => { ws.removeEventListener("message", read); reject(new Error("Command timed out")) }, 10_000)
    const read = (event: MessageEvent) => {
      const value = JSON.parse(String(event.data))
      if (value.id === id) { clearTimeout(timer); ws.removeEventListener("message", read); resolve(value) }
    }
    ws.addEventListener("message", read)
    ws.send(JSON.stringify({ v: 1, type: "command", id, command }))
  })
}
try {
  for (let i = 0; i < 2; i++) {
    const enrollment = await eventually(async () => { const response = await local(i, "enroll"); return response.ok ? response.json() : null }, value => Boolean(value?.id))
    const email = i ? "second-preview@example.com" : "preview@example.com", intent = { purpose: "enroll", id: enrollment.id }
    const pending = await central("request-code", { email, intent })
    assert.equal(pending.status, 200)
    const account = await central("verify-code", { email, intent, code: fixture.messages.at(-1)!.code, remember: true }, cookies(pending))
    assert.equal(account.status, 200)
    const status = await eventually<ConnectLocalStatus>(async () => (await local(i)).json(), value => value.state === "online")
    hosts.push({ origin: new URL(status.url!).origin, cookie: "" })
    const login = await host(i, "/_connect/login")
    const flow = new URL(login.headers.get("location")!).searchParams.get("flow")
    const authorized = await central("authorize", { flow }, cookies(account))
    assert.equal(authorized.status, 200)
    const callback = (await authorized.json()).redirect
    const entered = await publicRequest(callback, { headers: { cookie: cookies(login) } })
    assert.equal(entered.status, 303)
    hosts[i]!.cookie = cookies(entered)
  }
  const project = fixture.hosts[0]!.store.listProjects()[0]!
  const labelPath = path.join(project.localPath, "label.js")
  await writeFile(labelPath, 'export default "Preview version one"\n')
  await writeFile(path.join(project.localPath, "index.html"), '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dynamic preview fixture</title><style>body{font:18px system-ui;padding:24px;max-width:720px}button,a{font:inherit;margin:12px 12px 12px 0;padding:8px}#label{color:#246a55}</style><h1 id="label">Loading</h1><p>Count: <output id="count">0</output></p><button id="increment">Add one</button><button id="login">App login</button><output id="login-status"></output><p><a href="/nested?tab=one#section">Open nested route</a></p><script type="module" src="/main.js"></script></html>')
  await writeFile(path.join(project.localPath, "main.js"), [
    'import label from "./label.js"; document.querySelector("#label").textContent=label;',
    'async function refresh(){document.querySelector("#count").textContent=(await (await fetch("/api/counter")).json()).count} refresh();',
    'document.querySelector("#increment").onclick=async()=>{await fetch("/api/counter",{method:"POST"});await refresh()};',
    'document.querySelector("#login").onclick=async()=>{await fetch("/api/login",{method:"POST"});document.querySelector("#login-status").textContent=(await(await fetch("/api/headers")).json()).cookie};',
    'if(import.meta.hot)import.meta.hot.accept("./label.js",mod=>{document.querySelector("#label").textContent=mod.default});',
  ].join("\n"))
  let count = 0
  vite = await createServer({ root: project.localPath, configFile: false, logLevel: "error", server: { host: "localhost", port: freePort(), strictPort: true },
    plugins: [{ name: "preview-fixture-api", configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = request.url?.split("?")[0]
        if (!pathname?.startsWith("/api/") && pathname !== "/redirect") { next(); return }
        response.setHeader("Content-Type", "application/json")
        if (pathname === "/api/counter") { if (request.method === "POST") count++; response.end(JSON.stringify({ count })); return }
        if (pathname === "/api/login") { response.setHeader("Set-Cookie", "app-session=ready; Path=/; HttpOnly"); response.end("{}"); return }
        if (pathname === "/api/headers") { response.end(JSON.stringify({ cookie: request.headers.cookie ?? "", authorization: request.headers.authorization ?? "",
          controlHeaders: Object.keys(request.headers).filter(key => key.startsWith("x-stillon-")) })); return }
        if (pathname === "/redirect") { response.statusCode = 302; response.setHeader("Location", "http://localhost:" + (server.httpServer!.address() as { port: number }).port + "/nested?from=redirect"); response.end(); return }
        response.statusCode = 404; response.end("{}")
      })
    } }] })
  await vite.listen()
  const appPort = (vite.httpServer!.address() as { port: number }).port
  const appOrigin = "http://localhost:" + appPort
  console.log("Checking discovery through the StillOn WebSocket")
  const mainSocket = await openSocket("ws://127.0.0.1:" + fixture.port + "/ws", new Headers({ Host: new URL(hosts[0]!.origin).host, Origin: hosts[0]!.origin, Cookie: hosts[0]!.cookie }))
  const discovery = await command(mainSocket.ws, { type: "browser.listLocalHttpServers", projectId: project.id })
  assert.equal(discovery.type, "ack")
  assert.ok(discovery.result.some((server: { port: number }) => server.port === appPort))
  assert.ok(!discovery.result.some((server: { port: number }) => server.port === fixture.hosts[0]!.port))
  checks.push("real StillOn server discovers the development service through the full Connect WebSocket")
  const started = await host(0, "/_connect/preview/" + appPort + "/nested?tab=one")
  assert.equal(started.status, 303)
  const claim = new URL(started.headers.get("location")!)
  const claimed = await publicRequest(claim)
  assert.equal(claimed.status, 303)
  const preview = { origin: claim.origin, cookie: cookies(claimed) }
  const previewRequest = (route: string, init: RequestInit = {}) => publicRequest(preview.origin + route, { ...init, headers: { origin: preview.origin, cookie: preview.cookie, ...Object.fromEntries(new Headers(init.headers)) } })
  const page = await previewRequest("/nested?tab=one")
  assert.equal(page.status, 200)
  assert.match(await page.text(), /Dynamic preview fixture/)
  assert.match(page.headers.get("content-security-policy")!, /frame-ancestors/)
  for (const route of ["/main.js", "/label.js", "/@vite/client"]) {
    const response = await previewRequest(route); assert.equal(response.status, 200); await response.text()
  }
  const redirected = await previewRequest("/redirect")
  assert.equal(redirected.headers.get("location"), preview.origin + "/nested?from=redirect")
  console.log("Checking preview API and application cookies")
  assert.equal((await previewRequest("/api/counter", { method: "POST" })).status, 200)
  assert.equal((await applicationJson(await fetch(appOrigin + "/api/counter"))).count, 1)
  await fetch(appOrigin + "/api/counter", { method: "POST" })
  assert.equal((await applicationJson(await previewRequest("/api/counter"))).count, 2)
  const appLogin = await previewRequest("/api/login", { method: "POST" })
  assert.equal(appLogin.headers.get("set-cookie"), "app-session=ready; Path=/; HttpOnly")
  const echo = await applicationJson(await previewRequest("/api/headers", { headers: { Cookie: preview.cookie + "; app-session=ready; " + hosts[0]!.cookie, Authorization: "Bearer application" } }))
  assert.equal(echo.cookie, "app-session=ready")
  assert.equal(echo.authorization, "Bearer application")
  assert.deepEqual(echo.controlHeaders, [])
  checks.push("Vite HTML, ES modules, deep routes, redirects, app cookies and local/remote API writes share the same app")
  for (const headers of [{ Cookie: "" }, { Cookie: hosts[1]!.cookie }]) assert.equal((await previewRequest("/api/counter", { headers })).status, 401)
  assert.equal((await previewRequest("/api/counter", { method: "POST", headers: { Origin: hosts[1]!.origin } })).status, 403)
  assert.equal((await host(0, "/api/connect-preview/" + appPort + "/")).status, 403)
  const blockedStart = await host(0, "/_connect/preview/" + fixture.hosts[0]!.port + "/")
  const blockedClaim = await publicRequest(blockedStart.headers.get("location")!)
  assert.equal((await publicRequest(new URL(blockedClaim.headers.get("location")!), { headers: { Cookie: cookies(blockedClaim) } })).status, 503)
  checks.push("account/origin isolation, reserved header stripping and denial of the StillOn control port")
  const created = await command(mainSocket.ws, { type: "chat.create", projectId: project.id })
  const browserOutput = process.argv.find(value => value.startsWith("--browser-output="))?.slice("--browser-output=".length)
  if (browserOutput) {
    await writeFile(path.resolve(browserOutput), JSON.stringify({ appOrigin, appPort, projectId: project.id, chatId: created.result.chatId,
      localOrigin: "http://127.0.0.1:" + fixture.hosts[0]!.port, hostOrigin: hosts[0]!.origin, hostCookie: hosts[0]!.cookie,
      previewOrigin: preview.origin, previewCookie: preview.cookie, labelPath, fixtureRoot: fixture.root }, null, 2))
    console.log("Browser fixture ready")
    await new Promise<void>(resolve => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve) })
  } else {
    console.log("Checking Vite hot-update WebSocket")
    const hmr = await openSocket("ws://127.0.0.1:" + fixture.port + "/?token=" + vite.config.webSocketToken,
      new Headers({ Host: new URL(preview.origin).host, Origin: preview.origin, Cookie: preview.cookie }), ["vite-hmr"])
    assert.equal(hmr.ws.protocol, "vite-hmr")
    await eventually(async () => hmr.messages, messages => messages.some(value => JSON.parse(value).type === "connected"))
    console.log("Checking preview WebSocket renewal across the 45 s lease boundary")
    for (let i = 0; i < 6; i++) {
      await Bun.sleep(9_000)
      assert.equal((await command(mainSocket.ws, { type: "system.ping" })).type, "ack")
      assert.equal(hmr.ws.readyState, WebSocket.OPEN)
    }
    await writeFile(labelPath, 'export default "Preview version two"\n')
    await eventually(async () => hmr.messages, messages => messages.some(value => ["update", "full-reload"].includes(JSON.parse(value).type)))
    checks.push("vite-hmr subprotocol, live updates and signed lease renewal across 54 seconds")
    assert.ok((await eventually(async () => local(0, "pause"), response => response.ok)).ok)
    await eventually(async () => hmr.ws.readyState, value => value === WebSocket.CLOSED, 5_000)
    assert.equal((await previewRequest("/")).status, 401)
    await eventually(async () => local(0, "resume"), response => response.ok)
    await eventually<ConnectLocalStatus>(async () => (await local(0)).json(), value => value.state === "online")
    assert.equal((await host(0, "/auth/logout", { method: "POST" })).status, 200)
    assert.equal((await previewRequest("/api/counter")).status, 401)
    assert.equal((await host(1, "/health")).status, 200)
    checks.push("pause closes live preview streams; logout revokes preview sessions while another account remains online")
    console.log(JSON.stringify({ passed: true, platform: process.platform, checks }, null, 2))
  }
} finally {
  for (const ws of sockets) ws.close()
  await vite?.close()
  await fixture.stop()
}
