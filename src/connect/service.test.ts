import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { createConnectService } from "./service"
import { newDeviceKeys, randomId, randomToken, signProof } from "../server/connect/crypto"
import type { LoginEmail } from "./mail"
import type { ConnectIntent } from "../shared/connect"

const origin = "https://connect.stillon.example"
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
const cookies = (response: Response) => response.headers.getSetCookie().map(v => v.split(";")[0]).join("; ")
async function fixture(upstreamOrigin = "http://127.0.0.1:9") {
  await mkdir("test-artifacts/connect", { recursive: true })
  const dataDir = await mkdtemp(path.resolve("test-artifacts/connect/service-"))
  const messages: LoginEmail[] = []
  const service = await createConnectService({ dataDir, origin, secret: randomToken(), sender: { async send(message) { messages.push(message) } },
    transport: { upstreamOrigin } })
  cleanup.push(async () => { service.close(); await rm(dataDir, { recursive: true, force: true }) })
  async function request(route: string, body?: unknown, cookie = "", browser = true) {
    return (await service.central(new Request(`${origin}/api/connect/${route}`, { method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", ...(browser ? { origin, cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }), "192.0.2.10"))!
  }
  async function login(email: string, intent?: ConnectIntent) {
    const pending = await request("request-code", { email, ...(intent ? { intent } : {}) })
    expect(pending.status).toBe(200)
    const response = await request("verify-code", { email, code: messages.at(-1)!.code, remember: true, ...(intent ? { intent } : {}) }, cookies(pending))
    expect(response.status).toBe(200)
    const cookie = cookies(response)
    const identity = await service.auth.resolveSession(new Request(origin, { headers: { cookie } }))
    expect(identity).not.toBeNull()
    expect(service.auth.identityById(identity!.id)?.userId).toBe(identity!.userId)
    return { cookie, identity: identity! }
  }
  const keys = newDeviceKeys()
  async function device(action: string, payload: Record<string, unknown>, subject = `key:${keys.publicKey}`) {
    const challenge = await (await request("device/challenge", { subject, action }, "", false)).json()
    return request("device/request", signProof({ subject, action, challenge: challenge.challenge, payload }, keys.privateKey), "", false)
  }
  return { service, request, login, device, keys, messages, dataDir }
}

test.each(["/api/projects/workspace/preview/output/", "/api/local-html-previews/test-session/output/"])("remote HTML resources work without cookies and revoke with their host session: %s", async (directoryUrl) => {
  const paths: string[] = []
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    paths.push(new URL(request.url).pathname + new URL(request.url).search)
    expect(request.headers.has("cookie")).toBe(false)
    return new URL(request.url).pathname.endsWith(".html")
      ? new Response('<head><link rel="stylesheet" href="./style.css"></head><script type="module" src="./app.js"></script><img src="/output/chart.svg">', { headers: { "content-type": "text/html", "content-security-policy": "sandbox allow-scripts; default-src 'none'" } })
      : new Response("document.title='Loaded'", { headers: { "content-type": "text/javascript" } })
  } })
  cleanup.push(async () => { await upstream.stop(true) })
  const f = await fixture(`http://127.0.0.1:${upstream.port}`), account = await f.login("owner@example.com")
  const enrollment = f.service.registry.createEnrollment(f.keys.publicKey, "Computer")
  f.service.registry.approveEnrollment(enrollment.id, account.identity)
  const host = f.service.registry.claimEnrollment(enrollment.id, f.keys.publicKey)!
  const connection = f.service.registry.openConnection(host.id, randomId())
  expect(f.service.registry.frpCredential(host.id, connection.token, "preview-test", "Login")).toBe(true)
  expect(f.service.registry.frpCredential(host.id, connection.token, "preview-test", "NewProxy")).toBe(true)
  const flow = f.service.registry.newFlow(host.id, "/")
  const callback = new URL(f.service.registry.authorizeFlow(flow.id, account.identity))
  const session = f.service.registry.exchangeFlow(flow.id, host.id, flow.verifier, callback.searchParams.get("code")!, flow.state, f.service.auth.identityById)
  const hostOrigin = f.service.registry.hostOrigin(host.id)
  // Use the same cookie helper as the real callback rather than relying on a
  // browser's SameSite cookie inside an opaque preview document.
  const { cookieName } = await import("./http")
  const hostCookie = `${cookieName(hostOrigin, "host-session")}=${session.token}`
  const request = (route: string, headers: Record<string, string> = {}, method = "GET") => f.service.host(new Request(hostOrigin + route, { method, headers }), null as never)
  const response = (await request(directoryUrl + "index.html", { cookie: hostCookie }))!
  expect(response.status).toBe(200)
  const prefix = /<base href="([^"]+)"/u.exec(await response.text())![1]!
  expect(prefix).toStartWith("/_connect/preview-assets/")
  expect(response.headers.get("content-security-policy")).toContain(hostOrigin + prefix)
  expect(response.headers.get("content-security-policy")).not.toContain("allow-same-origin")
  const script = (await request(prefix + "app.js", { origin: "null", "sec-fetch-site": "cross-site" }))!
  expect(script.status).toBe(200)
  expect(script.headers.get("access-control-allow-origin")).toBe("null")
  expect(await script.text()).toContain("Loaded")
  expect(paths.at(-1)).toBe(directoryUrl + "app.js?preview-root=output")
  expect((await request(prefix + "%2e%2e%2fprivate.json"))!.status).toBe(403)
  expect((await request(prefix + "app.js", { origin: hostOrigin }, "POST"))!.status).toBe(403)
  const otherEnrollment = f.service.registry.createEnrollment(newDeviceKeys().publicKey, "Other computer")
  f.service.registry.approveEnrollment(otherEnrollment.id, account.identity)
  const otherHost = f.service.registry.claimEnrollment(otherEnrollment.id, otherEnrollment.publicKey)!
  expect((await f.service.host(new Request(f.service.registry.hostOrigin(otherHost.id) + prefix + "app.js"), null as never))!.status).toBe(403)
  expect((await request(directoryUrl + "app.js", { origin: "null" }))!.status).toBe(403)
  f.service.registry.setPaused(host.id, true)
  expect((await request(prefix + "app.js"))!.status).toBe(403)
  f.service.registry.setPaused(host.id, false)
  expect((await request("/auth/logout", { origin: hostOrigin, cookie: hostCookie }, "POST"))!.status).toBe(200)
  expect((await request(prefix + "app.js"))!.status).toBe(403)
})

test("direct file origins bind resources to a live host parent and require the adapter capability", async () => {
  let supported = true
  const seen: Request[] = []
  const targetId = "f".repeat(32)
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    seen.push(request.clone())
    const headers: Record<string, string> = supported ? { "X-StillOn-File-Preview-Transport": "1" } : {}
    if (new URL(request.url).pathname.endsWith("/demo.js")) return new Response("document.title='Loaded'", { headers: { ...headers, "content-type": "text/javascript" } })
    return request.method === "POST" ? Response.json({ protocol: 1, path: "/index.html", scopeKey: "a".repeat(64) }, { headers })
      : new Response('<head><script>const parentOrigin="http://localhost:3210";</script></head><input>', { headers: { ...headers, "content-type": "text/html" } })
  } })
  cleanup.push(async () => { await upstream.stop(true) })
  const f = await fixture(`http://127.0.0.1:${upstream.port}`), account = await f.login("file-preview@example.com")
  const enrollment = f.service.registry.createEnrollment(f.keys.publicKey, "File test computer")
  f.service.registry.approveEnrollment(enrollment.id, account.identity)
  const host = f.service.registry.claimEnrollment(enrollment.id, f.keys.publicKey)!
  const connection = f.service.registry.openConnection(host.id, randomId())
  f.service.registry.frpCredential(host.id, connection.token, "file-test", "Login")
  f.service.registry.frpCredential(host.id, connection.token, "file-test", "NewProxy")
  const flow = f.service.registry.newFlow(host.id, "/"), callback = new URL(f.service.registry.authorizeFlow(flow.id, account.identity))
  const session = f.service.registry.exchangeFlow(flow.id, host.id, flow.verifier, callback.searchParams.get("code")!, flow.state, f.service.auth.identityById)
  const hostOrigin = f.service.registry.hostOrigin(host.id), { cookieName } = await import("./http")
  const start = () => f.service.host(new Request(`${hostOrigin}/api/file-previews/${targetId}/entry`, { method: "POST", headers: {
    origin: hostOrigin, cookie: cookieName(hostOrigin, "host-session") + "=" + session.token,
  } }), null as never)
  const opened = (await start())!, value = await opened.json(), url = new URL(value.url)
  expect(opened.status).toBe(200)
  expect(url.hostname.split(".")[0]!.length).toBeLessThanOrEqual(63)
  expect(url.origin).not.toBe(hostOrigin)
  expect(f.service.hostId(new Request(url))).toBe(host.id)
  const resource = () => f.service.host(new Request(url, { headers: { cookie: "stillon_session=must-not-forward", authorization: "Bearer must-not-forward" } }), null as never)
  const response = (await resource())!
  expect(response.status).toBe(200)
  expect(response.headers.get("content-security-policy")).toContain("connect-src 'self'")
  expect(response.headers.get("content-security-policy")).toContain(hostOrigin)
  expect(await response.text()).toContain(`const parentOrigin="${hostOrigin}";`)
  expect(new URL(seen.at(-1)!.url).pathname).toBe(`/api/file-previews/${targetId}/resource/index.html`)
  expect(seen.at(-1)!.headers.has("cookie")).toBe(false)
  expect(seen.at(-1)!.headers.has("authorization")).toBe(false)
  // TLS terminates at the public proxy; Bun receives HTTP while module requests
  // retain the browser's public HTTPS Origin.
  const moduleUrl = new URL("/demo.js", url)
  moduleUrl.protocol = "http:"
  const moduleRequest = (from: string, extra: Record<string, string> = {}) => f.service.host(new Request(moduleUrl, { headers: {
    host: url.host, origin: from, "sec-fetch-dest": "script", "sec-fetch-mode": "cors", ...extra,
  } }), null as never)
  const moduleResponse = (await moduleRequest(url.origin))!
  expect(moduleResponse.status).toBe(200)
  expect(moduleResponse.headers.get("content-type")).toContain("text/javascript")
  expect(await moduleResponse.text()).toBe("document.title='Loaded'")
  for (const from of ["null", moduleUrl.origin, hostOrigin, origin, "https://attacker.example", url.origin + ":8443"]) {
    expect((await moduleRequest(from, { "x-forwarded-proto": "https" }))!.status).toBe(403)
  }
  supported = false
  expect((await start())!.status).toBe(409)
  f.service.registry.setPaused(host.id, true)
  expect((await resource())!.status).toBe(410)
  expect((await moduleRequest(url.origin))!.status).toBe(410)
  f.service.registry.setPaused(host.id, false)
  f.service.registry.revokeParent(account.identity.id)
  expect((await resource())!.status).toBe(410)
})

test("fresh OTP is bound to one enrollment and only the device key can claim it", async () => {
  const f = await fixture()
  const enrollment = await (await f.device("enroll", { name: "Office computer", protocol: 1 })).json()
  expect(enrollment.verificationUrl).toBe(`${origin}/bind?enrollment=${enrollment.id}`)
  expect(await (await f.device("claim", { enrollmentId: enrollment.id })).json()).toEqual({ state: "pending" })
  const intent: ConnectIntent = { purpose: "enroll", id: enrollment.id }
  const pending = await f.request("request-code", { email: "owner@example.com", intent })
  expect(pending.status).toBe(200)
  const wrong = await f.request("verify-code", { email: "owner@example.com", code: f.messages.at(-1)!.code, remember: true }, cookies(pending))
  expect(wrong.status).toBe(400)
  const response = await f.request("verify-code", { email: "owner@example.com", code: f.messages.at(-1)!.code, remember: true, intent }, cookies(pending))
  expect(response.status).toBe(200)
  const claimed = await (await f.device("claim", { enrollmentId: enrollment.id })).json()
  expect(claimed.state).toBe("bound")
  expect(claimed.hostId).toMatch(/^[a-f0-9]{32}$/)
  expect(claimed.privateKey).toBeUndefined()
  expect((await (await f.device("claim", { enrollmentId: enrollment.id })).json()).hostId).toBe(claimed.hostId)
  expect(() => f.service.registry.claimEnrollment(enrollment.id, newDeviceKeys().publicKey)).toThrow("NOT_FOUND")
})

test("dynamic previews isolate app credentials and bind one-use handoffs to a computer, port and parent", async () => {
  const requests: { url: string; headers: Headers }[] = []
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    requests.push({ url: request.url, headers: new Headers(request.headers) })
    return new Response("app", { headers: { "set-cookie": "app-session=one; Domain=connect.stillon.example; Path=/",
      "x-frame-options": "DENY", "clear-site-data": '"cookies"', "content-security-policy": "default-src 'self'; frame-ancestors 'none'" } })
  } })
  cleanup.push(async () => { await upstream.stop(true) })
  const f = await fixture("http://127.0.0.1:" + upstream.port), account = await f.login("preview@example.com")
  const enrollment = f.service.registry.createEnrollment(f.keys.publicKey, "Preview computer")
  f.service.registry.approveEnrollment(enrollment.id, account.identity)
  const computer = f.service.registry.claimEnrollment(enrollment.id, f.keys.publicKey)!
  const connection = f.service.registry.openConnection(computer.id, randomId())
  f.service.registry.frpCredential(computer.id, connection.token, "preview", "Login")
  f.service.registry.frpCredential(computer.id, connection.token, "preview", "NewProxy")
  const flow = f.service.registry.newFlow(computer.id, "/")
  const callback = new URL(f.service.registry.authorizeFlow(flow.id, account.identity))
  const session = f.service.registry.exchangeFlow(flow.id, computer.id, flow.verifier, callback.searchParams.get("code")!, flow.state, f.service.auth.identityById)
  const hostOrigin = f.service.registry.hostOrigin(computer.id)
  const { cookieName } = await import("./http")
  const hostCookie = cookieName(hostOrigin, "host-session") + "=" + session.token
  const hostRequest = (route: string, cookie = hostCookie) => f.service.host(new Request(hostOrigin + route, { headers: { cookie } }), null as never)
  expect((await hostRequest("/_connect/preview/5173/", ""))!.status).toBe(303) // login, never an authorized preview
  expect((await hostRequest("/api/connect-preview/5173/"))!.status).toBe(403)
  expect((await hostRequest("/api/browser-proxy/5173/"))!.status).toBe(403)
  expect((await f.service.host(new Request(hostOrigin + "/_connect/preview/5173/", { headers: { cookie: hostCookie,
    "sec-fetch-site": "same-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" } }), null as never))!.status).toBe(403)
  const start = (await hostRequest("/_connect/preview/5173/dashboard?filter=active"))!
  expect(start.status).toBe(303)
  const claim = new URL(start.headers.get("location")!)
  expect(claim.hostname).toBe("p-" + computer.id + "-5173.connect.stillon.example")
  expect(f.service.hostId(new Request(claim))).toBe(computer.id)
  const previewRequest = (route: string, init: RequestInit = {}) => f.service.host(new Request(claim.origin + route, init), null as never)
  const wrongPort = new URL(claim); wrongPort.hostname = wrongPort.hostname.replace("-5173.", "-5174.")
  expect((await f.service.host(new Request(wrongPort), null as never))!.status).toBe(410)
  const claimed = (await f.service.host(new Request(claim), null as never))!
  expect(claimed.status).toBe(303)
  expect(claimed.headers.get("location")).toBe(claim.origin + "/dashboard?filter=active")
  expect(claimed.headers.get("set-cookie")).toContain("HttpOnly")
  expect(claimed.headers.get("set-cookie")).toContain("Secure")
  expect(claimed.headers.get("set-cookie")).not.toContain("Domain=")
  expect((await f.service.host(new Request(claim), null as never))!.status).toBe(410)
  const previewCookie = cookies(claimed)
  expect((await previewRequest("/api/data"))!.status).toBe(401)
  const response = (await previewRequest("/api/data?x=1", { headers: { cookie: previewCookie + "; app-session=one; " + hostCookie, origin: claim.origin, authorization: "Bearer app" } }))!
  expect(response.status).toBe(200)
  expect(await response.text()).toBe("app")
  expect(new URL(requests.at(-1)!.url).pathname).toBe("/api/connect-preview/5173/api/data")
  expect(requests.at(-1)!.headers.get("cookie")).toBe("app-session=one")
  expect(requests.at(-1)!.headers.get("authorization")).toBe("Bearer app")
  expect(response.headers.get("set-cookie")).toBe("app-session=one; Path=/")
  expect(response.headers.get("clear-site-data")).toBeNull()
  expect(response.headers.get("x-frame-options")).toBeNull()
  expect(response.headers.get("content-security-policy")).toContain("default-src 'self'")
  expect(response.headers.get("content-security-policy")).toContain(hostOrigin)
  expect((await previewRequest("/api/data", { method: "POST", headers: { cookie: previewCookie, origin: hostOrigin } }))!.status).toBe(403)
  expect((await previewRequest("/sw.js", { headers: { cookie: previewCookie, "sec-fetch-dest": "serviceworker" } }))!.status).toBe(403)
  let rateLimited = false
  for (let i = 0; i < 60; i++) {
    if ((await hostRequest("/_connect/preview/5173/"))!.status === 429) { rateLimited = true; break }
  }
  expect(rateLimited).toBe(true)
  f.service.registry.setPaused(computer.id, true)
  expect((await previewRequest("/", { headers: { cookie: previewCookie } }))!.status).toBe(401)
  f.service.registry.setPaused(computer.id, false)
  f.service.registry.revokeParent(account.identity.id)
  expect((await previewRequest("/", { headers: { cookie: previewCookie } }))!.status).toBe(401)
})

test("two hosts have independent cookies and PKCE; Logout revokes their parent only", async () => {
  const f = await fixture()
  const a = await f.login("owner@example.com")
  const b = await f.login("independent@example.com")
  const independent = { ...a.identity, id: b.identity.id }
  // A second browser for the same account is represented by an independently
  // persisted parent session, using the registry's identity reader here.
  const identities = new Map([[a.identity.id, a.identity], [independent.id, independent]])
  const read = (id: string) => identities.get(id) ?? null
  function host() {
    const keys = newDeviceKeys(), enrollment = f.service.registry.createEnrollment(keys.publicKey, "Computer")
    f.service.registry.approveEnrollment(enrollment.id, a.identity)
    return f.service.registry.claimEnrollment(enrollment.id, keys.publicKey)!
  }
  const h1 = host(), h2 = host()
  function session(hostId: string, parent = a.identity) {
    const flow = f.service.registry.newFlow(hostId, "/settings/remote")
    const callback = new URL(f.service.registry.authorizeFlow(flow.id, parent))
    expect(() => f.service.registry.exchangeFlow(flow.id, hostId, randomToken(), callback.searchParams.get("code")!, flow.state, read)).toThrow("LOGIN_EXPIRED")
    const exchange = f.service.registry.exchangeFlow(flow.id, hostId, flow.verifier, callback.searchParams.get("code")!, flow.state, read)
    expect(() => f.service.registry.exchangeFlow(flow.id, hostId, flow.verifier, callback.searchParams.get("code")!, flow.state, read)).toThrow("LOGIN_EXPIRED")
    return exchange
  }
  const s1 = session(h1.id), s2 = session(h2.id), independentSession = session(h1.id, independent)
  expect(f.service.registry.sessionForToken(h1.id, s1.token, read)).not.toBeNull()
  expect(f.service.registry.sessionForToken(h2.id, s2.token, read)).not.toBeNull()
  expect(f.service.registry.sessionForToken(h2.id, s1.token, read)).toBeNull()
  f.service.registry.revokeParent(a.identity.id)
  expect(f.service.registry.sessionForToken(h1.id, s1.token, read)).toBeNull()
  expect(f.service.registry.sessionForToken(h2.id, s2.token, read)).toBeNull()
  expect(f.service.registry.sessionForToken(h1.id, independentSession.token, read)).not.toBeNull()
  expect(f.service.registry.hosts(a.identity.userId)).toHaveLength(2)
})

test("fresh account authentication in the same browser revokes its previous host sessions", async () => {
  const f = await fixture(), a = await f.login("first@example.com"), otherBrowser = await f.login("independent@example.com")
  const enrollment = f.service.registry.createEnrollment(f.keys.publicKey, "Desk")
  f.service.registry.approveEnrollment(enrollment.id, a.identity)
  const host = f.service.registry.claimEnrollment(enrollment.id, f.keys.publicKey)!
  const flow = f.service.registry.newFlow(host.id, "/")
  const callback = new URL(f.service.registry.authorizeFlow(flow.id, a.identity))
  const hostSession = f.service.registry.exchangeFlow(flow.id, host.id, flow.verifier, callback.searchParams.get("code")!, flow.state, f.service.auth.identityById)
  const pending = await f.request("request-code", { email: "second@example.com" }, a.cookie)
  expect(pending.status).toBe(200)
  const previousCookies = a.cookie.split("; ").filter(value => !value.endsWith("=")).join("; ")
  const authenticated = await f.request("verify-code", { email: "second@example.com", code: f.messages.at(-1)!.code, remember: true }, `${previousCookies}; ${cookies(pending)}`)
  expect(authenticated.status).toBe(200)
  expect(await f.service.auth.resolveSession(new Request(origin, { headers: { cookie: cookies(authenticated) } }))).toMatchObject({ email: "second@example.com" })
  expect(f.service.auth.identityById(a.identity.id)).toBeNull()
  expect(f.service.registry.sessionForToken(host.id, hostSession.token, f.service.auth.identityById)).toBeNull()
  expect(f.service.auth.identityById(otherBrowser.identity.id)).not.toBeNull()
  expect(f.service.registry.hosts(a.identity.userId)).toHaveLength(1)
})

test("signed challenges cannot be replayed, mutated or used by a second device", async () => {
  const f = await fixture(), subject = `key:${f.keys.publicKey}`, action = "enroll"
  const challenge = f.service.registry.createChallenge(subject, action)
  const proof = signProof({ subject, action, challenge, payload: { name: "Desk", protocol: 1 } }, f.keys.privateKey)
  expect(() => f.service.registry.consumeProof({ ...proof, payload: { name: "Changed" } })).toThrow("INVALID_PROOF")
  expect(() => f.service.registry.consumeProof(signProof({ ...proof }, newDeviceKeys().privateKey))).toThrow("INVALID_PROOF")
  expect(f.service.registry.consumeProof(proof)).toBe(f.keys.publicKey)
  expect(() => f.service.registry.consumeProof(proof)).toThrow("INVALID_PROOF")
})

test("signed enrollment cancellation is final before approval and after a lost claim response", async () => {
  const f = await fixture(), owner = await f.login("owner@example.com")
  for (const stage of ["pending", "approved", "claimed"] as const) {
    const enrollment = await (await f.device("enroll", { name: "Desk", protocol: 1 })).json()
    if (stage !== "pending") f.service.registry.approveEnrollment(enrollment.id, owner.identity)
    const host = stage === "claimed" ? f.service.registry.claimEnrollment(enrollment.id, f.keys.publicKey) : null
    expect(() => f.service.registry.cancelEnrollment(enrollment.id, newDeviceKeys().publicKey)).toThrow("NOT_FOUND")
    expect((await f.device("cancel-enrollment", { enrollmentId: enrollment.id })).status).toBe(200)
    expect((await f.device("cancel-enrollment", { enrollmentId: enrollment.id })).status).toBe(200)
    expect(() => f.service.registry.approveEnrollment(enrollment.id, owner.identity)).toThrow("BINDING_EXPIRED")
    expect(() => f.service.registry.claimEnrollment(enrollment.id, f.keys.publicKey)).toThrow()
    if (host) expect(f.service.registry.host(host.id)?.revokedAt).not.toBeNull()
    expect(f.service.registry.hosts(owner.identity.userId)).toHaveLength(0)
  }
})

test("an old enrollment key cannot cancel a host after its device key rotated", async () => {
  const f = await fixture(), owner = await f.login("owner@example.com")
  const enrollment = f.service.registry.createEnrollment(f.keys.publicKey, "Desk")
  f.service.registry.approveEnrollment(enrollment.id, owner.identity)
  const host = f.service.registry.claimEnrollment(enrollment.id, f.keys.publicKey)!
  f.service.registry.rotateKey(host.id, newDeviceKeys().publicKey)
  expect((await f.device("cancel-enrollment", { enrollmentId: enrollment.id })).status).toBe(404)
  expect(f.service.registry.requireHost(host.id).revokedAt).toBeNull()
})

test("frp credentials restrict proxy identity and cloned connector ownership", async () => {
  const f = await fixture(), a = await f.login("owner@example.com")
  const e = f.service.registry.createEnrollment(f.keys.publicKey, "Desk")
  f.service.registry.approveEnrollment(e.id, a.identity)
  const host = f.service.registry.claimEnrollment(e.id, f.keys.publicKey)!
  const instance = randomId(), connection = f.service.registry.openConnection(host.id, instance)
  const renamed = await f.device("heartbeat", { instanceId: instance, generation: connection.generation, leases: [], name: "Renamed computer" }, host.id)
  expect(renamed.status).toBe(200)
  expect(f.service.registry.requireHost(host.id).name).toBe("Renamed computer")
  expect(f.service.registry.hosts(a.identity.userId).map(value => value.id)).toEqual([host.id])
  expect(() => f.service.registry.openConnection(host.id, randomId())).toThrow("DEVICE_ALREADY_CONNECTED")
  const content = { user: { user: host.id, metas: { connect_token: connection.token }, run_id: "test-run" }, proxy_type: "http", proxy_name: `${host.id}.tunnel`,
    custom_domains: [new URL(f.service.registry.hostOrigin(host.id)).hostname] }
  const plugin = (body: object) => f.service.plugin(new Request("http://127.0.0.1/plugin?op=NewProxy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: body }) }))
  expect((await (await plugin({ ...content, proxy_type: "tcp" })).json()).reject).toBe(true)
  expect((await (await plugin({ ...content, custom_domains: ["other.example"] })).json()).reject).toBe(true)
  expect((await (await plugin(content)).json()).reject).toBe(false)
  expect(f.service.registry.publicHost(f.service.registry.requireHost(host.id)).online).toBe(true)
  f.service.registry.setPaused(host.id, true)
  expect((await (await plugin(content)).json()).reject).toBe(true)
  f.service.registry.revokeHost(host.id)
  expect(() => f.service.registry.requireHost(host.id)).toThrow("NOT_FOUND")
})

test("local device and remote browser manage only their account's login families", async () => {
  const f = await fixture()
  const first = await f.login("sessions@example.com")
  const enrollment = f.service.registry.createEnrollment(f.keys.publicKey, "Computer")
  f.service.registry.approveEnrollment(enrollment.id, first.identity)
  const host = f.service.registry.claimEnrollment(enrollment.id, f.keys.publicKey)!
  // Only synthetic fixture mail budgets are reset to create another browser.
  const guard = new Database(path.join(f.dataDir, "guard.sqlite"))
  guard.exec("DELETE FROM connect_rate_event"); guard.close()
  const second = await f.login("sessions@example.com")
  const other = await f.login("other@example.com")
  const local = () => f.device("list-sessions", {}, host.id)
  const rows = await (await local()).json()
  expect(rows.sessions).toHaveLength(2)
  expect(rows.sessions.every((row: { current: boolean }) => !row.current)).toBe(true)
  expect(rows.sessions.every((row: { lastUsedAt: number | null }) => row.lastUsedAt !== null)).toBe(true)
  const { cookieName } = await import("./http")
  function enter(identity: typeof first.identity) {
    const flow = f.service.registry.newFlow(host.id, "/")
    const callback = new URL(f.service.registry.authorizeFlow(flow.id, identity))
    return f.service.registry.exchangeFlow(flow.id, host.id, flow.verifier, callback.searchParams.get("code")!, flow.state, f.service.auth.identityById)
  }
  const one = enter(first.identity), extraTab = enter(first.identity), two = enter(second.identity)
  const hostOrigin = f.service.registry.hostOrigin(host.id)
  function remote(route: string, token: string, body?: unknown, from = hostOrigin) {
    return f.service.host(new Request(hostOrigin + route, { method: body === undefined ? "GET" : "POST", headers: {
      origin: from, cookie: `${cookieName(hostOrigin, "host-session")}=${token}`, "content-type": "application/json",
    }, body: body === undefined ? undefined : JSON.stringify(body) }), null as never)
  }
  const listed = await (await remote("/_connect/sessions", one.token))!.json()
  expect(listed.sessions).toHaveLength(2) // Multiple host tabs still count once.
  expect(listed.sessions.filter((row: { current: boolean }) => row.current).map((row: { id: string }) => row.id)).toEqual([first.identity.id])
  expect((await remote("/_connect/sessions", one.token, undefined, "https://evil.example"))!.status).toBe(403)
  expect((await remote("/_connect/sessions/revoke", one.token, { sessionId: other.identity.id }))!.status).toBe(404)
  expect((await f.device("revoke-session", { sessionId: other.identity.id }, host.id)).status).toBe(404)
  expect(f.service.auth.identityById(other.identity.id)).not.toBeNull()
  expect((await f.request("sessions", undefined, other.cookie)).status).toBe(200)
  expect((await f.request("sessions/revoke", { sessionId: first.identity.id }, other.cookie)).status).toBe(404)
  expect((await f.request("sessions")).status).toBe(401)
  expect((await remote("/_connect/sessions/revoke", one.token, { sessionId: second.identity.id }))!.status).toBe(200)
  expect(f.service.auth.identityById(second.identity.id)).toBeNull()
  expect(f.service.registry.sessionForToken(host.id, two.token, f.service.auth.identityById)).toBeNull()
  expect((await (await local()).json()).sessions).toHaveLength(1)
  expect((await f.device("revoke-session", { sessionId: first.identity.id }, host.id)).status).toBe(200)
  expect(f.service.registry.sessionForToken(host.id, one.token, f.service.auth.identityById)).toBeNull()
  expect(f.service.registry.sessionForToken(host.id, extraTab.token, f.service.auth.identityById)).toBeNull()
  expect((await (await local()).json()).sessions).toHaveLength(0)
  expect(f.service.registry.requireHost(host.id).revokedAt).toBeNull() // Binding is preserved.
  expect((await f.device("revoke-session", { sessionId: first.identity.id }, host.id)).status).toBe(200)
})

test("a remote browser can revoke itself and cannot reuse its account or host session", async () => {
  const f = await fixture(), account = await f.login("self@example.com")
  const response = await f.request("sessions/revoke", { sessionId: account.identity.id }, account.cookie)
  expect(await response.json()).toEqual({ success: true, current: true })
  expect((await f.request("sessions", undefined, account.cookie)).status).toBe(401)
  expect(f.service.registry.isRevoked(account.identity.id)).toBe(true)
})

test("idle sidebar bootstrap polling preserves last use while workspace requests advance it", async () => {
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ ok: true }) })
  cleanup.push(async () => { await upstream.stop(true) })
  const f = await fixture(`http://127.0.0.1:${upstream.port}`)
  const account = await f.login("idle@example.com")
  const enrollment = f.service.registry.createEnrollment(f.keys.publicKey, "Computer")
  f.service.registry.approveEnrollment(enrollment.id, account.identity)
  const host = f.service.registry.claimEnrollment(enrollment.id, f.keys.publicKey)!
  const connection = f.service.registry.openConnection(host.id, randomId())
  expect(f.service.registry.frpCredential(host.id, connection.token, "idle-test", "Login")).toBe(true)
  expect(f.service.registry.frpCredential(host.id, connection.token, "idle-test", "NewProxy")).toBe(true)
  const flow = f.service.registry.newFlow(host.id, "/")
  const callback = new URL(f.service.registry.authorizeFlow(flow.id, account.identity))
  const session = f.service.registry.exchangeFlow(flow.id, host.id, flow.verifier,
    callback.searchParams.get("code")!, flow.state, f.service.auth.identityById)
  const hostOrigin = f.service.registry.hostOrigin(host.id)
  const { cookieName } = await import("./http")
  const headers = { origin: hostOrigin, cookie: `${cookieName(hostOrigin, "host-session")}=${session.token}` }
  const guard = new Database(path.join(f.dataDir, "guard.sqlite"))
  const old = Date.now() - 120_000
  guard.query("UPDATE connect_session_activity SET lastUsedAt=? WHERE sessionId=?").run(old, account.identity.id)
  guard.close()
  const lastUse = () => f.service.auth.browserSessions.list(account.identity.userId).sessions[0]!.lastUsedAt
  for (const route of ["/auth/status", "/_connect/sessions", "/api/sidebar-view"]) {
    const response = (await f.service.host(new Request(hostOrigin + route, { headers }), null as never))!
    expect(response.status).toBe(200)
    await response.arrayBuffer()
    expect(lastUse()).toBe(old)
  }
  const response = (await f.service.host(new Request(hostOrigin + "/api/projects", { headers }), null as never))!
  expect(response.status).toBe(200)
  await response.arrayBuffer()
  expect(lastUse()).toBeGreaterThan(old)
})
