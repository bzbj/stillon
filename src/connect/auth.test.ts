import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { randomBytes } from "node:crypto"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { createConnectAuth, normalizeConnectOrigin } from "./auth"
import type { LoginEmail } from "./mail"

const origin = "https://connect.stillon.example"
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const clean of cleanup.splice(0)) await clean() })

function cookies(response: Response) {
  return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ")
}

async function fixture(failMail = false) {
  const root = path.resolve("test-artifacts/connect")
  await mkdir(root, { recursive: true })
  const dataDir = await mkdtemp(path.join(root, "auth-"))
  const messages: LoginEmail[] = []
  const options = {
    origin, dataDir, secret: randomBytes(32).toString("hex"),
    sender: { async send(message: LoginEmail) { if (failMail) throw new Error("private provider error"); messages.push(message) } },
  }
  let service = await createConnectAuth(options)
  cleanup.push(async () => { service.close(); await rm(dataDir, { recursive: true, force: true }) })
  function request(route: string, body?: unknown, cookie = "", custom: Record<string, string> = {}) {
    return service.handle(new Request(`${origin}/api/connect/${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { origin, "content-type": "application/json", cookie, ...custom },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), "192.0.2.10")
  }
  function guardSql(sql: string) {
    const database = new Database(path.join(dataDir, "guard.sqlite"))
    try { database.exec(sql) } finally { database.close() }
  }
  return {
    messages, dataDir, request, guardSql,
    get service() { return service },
    async restart() { service.close(); service = await createConnectAuth(options) },
    async send(email = "person@example.com") {
      const response = await request("request-code", { email })
      return { response, cookie: cookies(response), code: messages.at(-1)?.code ?? "" }
    },
  }
}

describe("Connect email account boundary", () => {
  test("creates a verified account only after the code and returns no bearer token", async () => {
    const f = await fixture()
    const pending = await f.send("Person@Example.COM")
    expect(pending.response.status).toBe(200)
    expect(f.messages[0]?.email).toBe("person@example.com")
    expect(pending.code).toMatch(/^\d{6}$/)
    expect((await f.request("session")).status).toBe(200)
    expect(await (await f.request("session")).json()).toEqual({ session: null })
    const result = await f.request("verify-code", { email: "person@example.com", code: pending.code, remember: true }, pending.cookie)
    expect(result.status).toBe(200)
    expect(await result.json()).toEqual({ success: true })
    const cookie = cookies(result)
    const session = await (await f.request("session", undefined, cookie)).json()
    expect(session.session.user.email).toBe("person@example.com")
    expect(session.session.user.id).toBeTruthy()
    expect(session.session.token).toBeUndefined()
    expect(session.session.hosts).toBeUndefined()
    expect(Object.keys(session.session)).toEqual(["user", "expiresAt"])
  })

  test("uses host-only secure HttpOnly cookies and supports browser-only sessions", async () => {
    const f = await fixture()
    const pending = await f.send()
    expect(pending.response.headers.get("set-cookie")).toContain("__Host-stillon-connect.challenge=")
    const result = await f.request("verify-code", { email: "person@example.com", code: pending.code, remember: false }, pending.cookie)
    const cookie = result.headers.getSetCookie().find((value) => value.startsWith("__Host-stillon-connect.session_token="))!
    expect(cookie).toBeTruthy()
    expect(cookie.toLowerCase()).toContain("httponly")
    expect(cookie.toLowerCase()).toContain("secure")
    expect(cookie.toLowerCase()).toContain("samesite=lax")
    expect(cookie.toLowerCase()).toContain("path=/")
    expect(cookie.toLowerCase()).not.toContain("domain=")
    expect(cookie.toLowerCase()).not.toContain("max-age=")
    expect(cookie.toLowerCase()).not.toContain("expires=")
  })

  test("rejects an OTP without its initiating browser receipt", async () => {
    const f = await fixture()
    const a = await f.send()
    const b = await f.send("other@example.com")
    const body = { email: "person@example.com", code: a.code, remember: true }
    expect((await f.request("verify-code", body)).status).toBe(400)
    expect((await f.request("verify-code", body, b.cookie)).status).toBe(400)
    expect((await f.request("verify-code", body, a.cookie)).status).toBe(200)
  })

  test("consumes a valid code once even when verification requests race", async () => {
    const f = await fixture()
    const pending = await f.send()
    const body = { email: "person@example.com", code: pending.code, remember: true }
    const results = await Promise.all([f.request("verify-code", body, pending.cookie), f.request("verify-code", body, pending.cookie)])
    expect(results.map((result) => result.status).sort()).toEqual([200, 400])
    expect((await f.request("verify-code", body, pending.cookie)).status).toBe(400)
  })

  test("expires the browser challenge after five minutes", async () => {
    const f = await fixture()
    const pending = await f.send()
    f.guardSql("UPDATE connect_challenge SET expires_at = 0")
    expect((await f.request("verify-code", { email: "person@example.com", code: pending.code, remember: true }, pending.cookie)).status).toBe(400)
  })

  test("honors the auth provider's own OTP expiry too", async () => {
    const f = await fixture()
    const pending = await f.send()
    const db = new Database(path.join(f.dataDir, "auth.sqlite"))
    db.exec("UPDATE verification SET expiresAt = 0")
    db.close()
    expect((await f.request("verify-code", { email: "person@example.com", code: pending.code, remember: true }, pending.cookie)).status).toBe(400)
  })

  test("limits resend requests atomically and keeps the limit after restart", async () => {
    const f = await fixture()
    const results = await Promise.all([f.send(), f.send()])
    expect(results.map((result) => result.response.status).sort()).toEqual([200, 429])
    expect(f.messages).toHaveLength(1)
    await f.restart()
    const blocked = await f.send()
    expect(blocked.response.status).toBe(429)
    expect(Number(blocked.response.headers.get("retry-after"))).toBeGreaterThan(0)
  })

  test("resending invalidates the old receipt without resetting failed attempts", async () => {
    const f = await fixture()
    const first = await f.send()
    const wrong = first.code === "000000" ? "000001" : "000000"
    for (let attempt = 0; attempt < 5; attempt++) {
      expect((await f.request("verify-code", { email: "person@example.com", code: wrong, remember: true }, first.cookie)).status).toBe(400)
    }
    f.guardSql("UPDATE connect_rate_event SET at = at - 61000 WHERE key LIKE 'send-%'")
    const resent = await f.send()
    expect(resent.response.status).toBe(200)
    const blocked = await f.request("verify-code", { email: "person@example.com", code: resent.code, remember: true }, resent.cookie)
    expect(blocked.status).toBe(429)
  })

  test("only the latest email challenge remains usable", async () => {
    const f = await fixture()
    const first = await f.send()
    f.guardSql("UPDATE connect_rate_event SET at = at - 61000 WHERE key LIKE 'send-%'")
    const latest = await f.send()
    expect((await f.request("verify-code", { email: "person@example.com", code: first.code, remember: true }, first.cookie)).status).toBe(400)
    expect((await f.request("verify-code", { email: "person@example.com", code: latest.code, remember: true }, latest.cookie)).status).toBe(200)
  })

  test("retains sessions across restarts and revokes them on logout", async () => {
    const f = await fixture()
    const pending = await f.send()
    const login = await f.request("verify-code", { email: "person@example.com", code: pending.code, remember: true }, pending.cookie)
    const cookie = cookies(login)
    expect(login.headers.getSetCookie().some((value) => /session_token=.*max-age=2592000/i.test(value))).toBe(true)
    await f.restart()
    expect((await (await f.request("session", undefined, cookie)).json()).session.user.email).toBe("person@example.com")
    expect((await f.request("logout", {}, cookie)).status).toBe(200)
    expect(await (await f.request("session", undefined, cookie)).json()).toEqual({ session: null })
  })

  test("stores keyed OTP digests rather than plaintext codes", async () => {
    const f = await fixture()
    const pending = await f.send()
    const db = new Database(path.join(f.dataDir, "auth.sqlite"), { readonly: true })
    const values = db.query<{ value: string }, []>("SELECT value FROM verification").all()
    db.close()
    expect(values.length).toBeGreaterThan(0)
    for (const row of values) {
      expect(row.value.split(":")[0]).toMatch(/^[a-f0-9]{64}$/)
      expect(row.value).not.toBe(pending.code)
    }
  })

  test("keeps different accounts separate and reuses the same account on later sign-in", async () => {
    const f = await fixture()
    async function login(email: string) {
      const pending = await f.send(email)
      const result = await f.request("verify-code", { email, code: pending.code, remember: true }, pending.cookie)
      expect(result.status).toBe(200)
      const cookie = cookies(result)
      return { cookie, session: (await (await f.request("session", undefined, cookie)).json()).session }
    }
    const first = await login("first@example.com")
    const second = await login("second@example.com")
    expect(first.session.user.id).not.toBe(second.session.user.id)
    expect((await (await f.request("session", undefined, first.cookie)).json()).session.user.email).toBe("first@example.com")
    await f.request("logout", {}, first.cookie)
    f.guardSql("UPDATE connect_rate_event SET at = at - 61000 WHERE key LIKE 'send-%'")
    const returning = await login("first@example.com")
    expect(returning.session.user.id).toBe(first.session.user.id)
    expect((await (await f.request("session", undefined, second.cookie)).json()).session.user.id).toBe(second.session.user.id)
  })

  test("does not accept tampered or expired account sessions", async () => {
    const f = await fixture()
    const pending = await f.send()
    const result = await f.request("verify-code", { email: "person@example.com", code: pending.code, remember: true }, pending.cookie)
    expect(await (await f.request("session", undefined, "__Host-stillon-connect.session_token=forged")).json()).toEqual({ session: null })
    const db = new Database(path.join(f.dataDir, "auth.sqlite"))
    db.exec("UPDATE session SET expiresAt = 0")
    db.close()
    expect(await (await f.request("session", undefined, cookies(result))).json()).toEqual({ session: null })
  })

  test("does not report success or mint a challenge when sending fails", async () => {
    const f = await fixture(true)
    const result = await f.send()
    expect(result.response.status).toBe(503)
    expect(result.response.headers.has("set-cookie")).toBe(false)
    expect((await result.response.json()).error).toBe("MAIL_UNAVAILABLE")
  })

  test("rejects untrusted origins, hosts, methods and unused auth endpoints", async () => {
    const f = await fixture()
    expect((await f.request("request-code", { email: "person@example.com" }, "", { origin: "https://evil.example" })).status).toBe(403)
    expect((await f.request("request-code", { email: "person@example.com" }, "", { "sec-fetch-site": "same-site" })).status).toBe(403)
    expect((await f.service.handle(new Request(`${origin}/api/connect/request-code`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"email":"person@example.com"}' }), "192.0.2.10")).status).toBe(403)
    expect((await f.request("session", undefined, "", { host: "evil.example" })).status).toBe(403)
    expect((await f.request("request-code")).status).toBe(405)
    expect((await f.request("sign-up/email", { email: "person@example.com" })).status).toBe(404)
    expect((await f.request("hosts")).status).toBe(404)
    expect(f.messages).toHaveLength(0)
  })

  test("bounds request bodies and does not accept client-selected redirect targets", async () => {
    const f = await fixture()
    expect((await f.request("request-code", { email: "no-email" })).status).toBe(400)
    expect((await f.request("request-code", { email: "person@example.com", redirectTo: "https://evil.example" })).status).toBe(400)
    expect((await f.request("request-code", { email: "x".repeat(5000) })).status).toBe(400)
    expect(f.messages).toHaveLength(0)
  })
})

test("Connect origin allows local HTTP only and rejects credential/path URLs", () => {
  expect(normalizeConnectOrigin("http://127.0.0.1:3220")).toBe("http://127.0.0.1:3220")
  expect(normalizeConnectOrigin(origin)).toBe(origin)
  for (const value of ["http://connect.stillon.example", `${origin}/path`, `${origin}?next=x`, "https://user:password@connect.stillon.example"]) {
    expect(() => normalizeConnectOrigin(value)).toThrow()
  }
})
