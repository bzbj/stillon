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
async function fixture() {
  await mkdir("test-artifacts/connect", { recursive: true })
  const dataDir = await mkdtemp(path.resolve("test-artifacts/connect/service-"))
  const messages: LoginEmail[] = []
  const service = await createConnectService({ dataDir, origin, secret: randomToken(), sender: { async send(message) { messages.push(message) } },
    transport: { upstreamOrigin: "http://127.0.0.1:9" } })
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
  return { service, request, login, device, keys, messages }
}

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
