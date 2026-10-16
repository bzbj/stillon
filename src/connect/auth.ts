import { AsyncLocalStorage } from "node:async_hooks"
import { randomBytes } from "node:crypto"
import { chmod, mkdir } from "node:fs/promises"
import path from "node:path"
import { Database } from "bun:sqlite"
import { betterAuth } from "better-auth"
import { getMigrations } from "better-auth/db/migration"
import { emailOTP } from "better-auth/plugins/email-otp"
import { z } from "zod"
import { LoginGuard } from "./login-guard"
import { connectSqliteDialect } from "./sqlite"
import type { LoginEmailSender } from "./mail"
import { CONNECT_OTP_SECONDS, CONNECT_RESEND_SECONDS, CONNECT_SESSION_SECONDS, type ConnectSession } from "./shared"
import type { ConnectIntent } from "../shared/connect"
import { ConnectFault, type AccountIdentity } from "./registry"

export interface ConnectAuthOptions {
  origin: string
  secret: string
  dataDir: string
  sender: LoginEmailSender
  validateIntent?: (intent: ConnectIntent, email: string) => void
  onVerified?: (identity: AccountIdentity, remember: boolean, intent?: ConnectIntent) => void
  onLogout?: (id: string) => void
  isRevoked?: (id: string) => boolean
}

export function normalizeConnectOrigin(value: string) {
  const url = new URL(value)
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/"
    || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
    throw new Error("Connect requires an HTTPS origin (HTTP is allowed only on loopback)")
  }
  return url.origin
}

const emailSchema = z.string().trim().max(254).email().transform((value) => value.toLowerCase())
const intentSchema = z.object({ purpose: z.enum(["enroll", "revoke-host"]), id: z.string().regex(/^[a-f0-9]{32}$/) }).strict()
const requestSchema = z.object({ email: emailSchema, intent: intentSchema.optional() }).strict()
const verifySchema = z.object({ email: emailSchema, code: z.string().regex(/^\d{6}$/), remember: z.boolean(), intent: intentSchema.optional() }).strict()
const intentKey = (intent?: ConnectIntent) => intent ? `${intent.purpose}:${intent.id}` : "sign-in"

function cookieValue(headers: Headers, name: string) {
  const values = (headers.get("cookie") ?? "").split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`))
  return values.length === 1 ? values[0]!.slice(name.length + 1) : ""
}

async function readBody(request: Request) {
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") return null
  const reader = request.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      size += result.value.byteLength
      if (size > 4_096) { await reader.cancel(); return null }
      chunks.push(result.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
  } catch { return null }
}

export async function createConnectAuth(options: ConnectAuthOptions) {
  const origin = normalizeConnectOrigin(options.origin)
  if (options.secret.length < 32) throw new Error("Connect auth secret must contain at least 32 random characters")
  await mkdir(options.dataDir, { recursive: true, mode: 0o700 })
  const databasePath = path.join(options.dataDir, "auth.sqlite")
  const db = new Database(databasePath, { create: true, strict: true })
  await chmod(databasePath, 0o600)
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")
  // Keep synchronous guard transactions separate from Better Auth's async DB
  // transactions; concurrent API requests must not nest on the same connection.
  const guardPath = path.join(options.dataDir, "guard.sqlite")
  const guardDb = new Database(guardPath, { create: true, strict: true })
  await chmod(guardPath, 0o600)
  guardDb.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;")
  const guard = new LoginGuard(guardDb, options.secret)
  const secure = origin.startsWith("https:")
  const prefix = secure ? "__Host-stillon-connect" : "stillon-connect"
  const challengeCookie = `${prefix}.challenge`
  const sendContext = new AsyncLocalStorage<{ challenge: string; submitted: boolean; intent: string }>()
  const auth = betterAuth({
    appName: "StillOn Connect",
    baseURL: origin,
    secret: options.secret,
    database: { dialect: connectSqliteDialect(db), type: "sqlite", transaction: true },
    trustedOrigins: [origin],
    telemetry: { enabled: false },
    logger: { disabled: true },
    session: {
      expiresIn: CONNECT_SESSION_SECONDS,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
    },
    // Only the four guarded HTTP routes below are exposed. Limits there reserve
    // email, IP and global budgets atomically, across restarts and resends.
    rateLimit: { enabled: false },
    advanced: {
      // Supply explicit __Host- names/attributes instead of BA's __Secure- prefix.
      useSecureCookies: false,
      defaultCookieAttributes: { secure, httpOnly: true, sameSite: "lax", path: "/" },
      crossSubDomainCookies: { enabled: false },
      cookies: Object.fromEntries(["session_token", "session_data", "account_data", "dont_remember"].map((name) => [name, { name: `${prefix}.${name}` }])),
      ipAddress: { ipAddressHeaders: ["x-stillon-connect-peer"] },
    },
    plugins: [emailOTP({
      otpLength: 6,
      expiresIn: CONNECT_OTP_SECONDS,
      allowedAttempts: 5,
      resendStrategy: "rotate",
      storeOTP: { hash: async (code) => guard.digest("otp", code) },
      async sendVerificationOTP({ email, otp, type }) {
        const context = sendContext.getStore()
        if (type !== "sign-in" || !context) throw new Error("Unsupported email flow")
        await options.sender.send({ email, code: otp, expiresInMinutes: CONNECT_OTP_SECONDS / 60 })
        guard.issue(context.challenge, email, otp, context.intent)
        context.submitted = true
      },
    })],
  })
  try {
    const migrations = await getMigrations(auth.options)
    await migrations.runMigrations()
  } catch (error) { guardDb.close(true); db.close(true); throw error }

  function response(body: unknown, status = 200, headers = new Headers()) {
    headers.set("Cache-Control", "no-store")
    headers.set("X-Content-Type-Options", "nosniff")
    return Response.json(body, { status, headers })
  }
  function error(code: string, status: number, retryAfterSeconds?: number) {
    const headers = new Headers()
    if (retryAfterSeconds) headers.set("Retry-After", String(retryAfterSeconds))
    return response({ error: code, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) }, status, headers)
  }
  function challengeHeader(value: string, maxAge = CONNECT_OTP_SECONDS) {
    return `${challengeCookie}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`
  }
  function internalHeaders(request: Request, peer: string) {
    // Never trust forwarded IP headers supplied by the browser.
    const headers = new Headers({ origin, "x-stillon-connect-peer": peer })
    for (const key of ["cookie", "user-agent"]) {
      const value = request.headers.get(key)
      if (value) headers.set(key, value)
    }
    return headers
  }

  function identityById(id: string): AccountIdentity | null {
    const row = db.query<{ id: string; userId: string; email: string; expiresAt: number | string }, [string]>(
      'SELECT s.id,s.userId,s.expiresAt,u.email FROM session s JOIN user u ON u.id=s.userId WHERE s.id=?',
    ).get(id)
    if (!row || options.isRevoked?.(id)) return null
    const expiresAt = typeof row.expiresAt === "number" ? row.expiresAt : new Date(row.expiresAt).getTime()
    return expiresAt > Date.now() ? { ...row, expiresAt } : null
  }
  async function resolveSession(request: Request): Promise<AccountIdentity | null> {
    const current = await auth.api.getSession({ headers: internalHeaders(request, "internal") })
    return current && !options.isRevoked?.(current.session.id)
      ? { id: current.session.id, userId: current.user.id, email: current.user.email, expiresAt: current.session.expiresAt.getTime() }
      : null
  }
  return {
    origin,
    resolveSession,
    identityById,
    checkStorage() { db.query("SELECT id FROM user LIMIT 1").get(); guardDb.query("SELECT id FROM connect_challenge LIMIT 1").get() },
    revokeById(id: string) { db.query("DELETE FROM session WHERE id=?").run(id) },
    close: () => { guardDb.close(true); db.close(true) },
    async handle(request: Request, peer: string): Promise<Response> {
      const url = new URL(request.url)
      if (url.host !== new URL(origin).host || (request.headers.has("host") && request.headers.get("host") !== url.host)) return error("INVALID_HOST", 403)
      const routes: Record<string, string> = {
        "/api/connect/request-code": "POST",
        "/api/connect/verify-code": "POST",
        "/api/connect/session": "GET",
        "/api/connect/logout": "POST",
      }
      const method = routes[url.pathname]
      if (!method) return error("NOT_FOUND", 404)
      if (request.method !== method) return error("METHOD_NOT_ALLOWED", 405)
      if ((request.headers.get("origin") && request.headers.get("origin") !== origin)
        || ["same-site", "cross-site"].includes(request.headers.get("sec-fetch-site") ?? "")
        || (method === "POST" && request.headers.get("origin") !== origin)) return error("INVALID_ORIGIN", 403)
      const ipKey = guard.digest("ip", peer)
      const requestLimit = guard.consume([{ key: `requests:${ipKey}`, max: 120, windowSeconds: 60 }])
      if (requestLimit) return error("RATE_LIMITED", 429, requestLimit)
      const headers = internalHeaders(request, peer)
      try {
        if (url.pathname === "/api/connect/session") {
          const current = await resolveSession(request)
          const session: ConnectSession | null = current ? {
            user: { id: current.userId, email: current.email },
            expiresAt: new Date(current.expiresAt).toISOString(),
          } : null
          return response({ session })
        }
        if (url.pathname === "/api/connect/logout") {
          const current = await resolveSession(request)
          if (current) options.onLogout?.(current.id)
          const result = await auth.api.signOut({ headers, asResponse: true })
          const outgoing = new Headers()
          for (const cookie of result.headers.getSetCookie()) outgoing.append("Set-Cookie", cookie)
          outgoing.append("Set-Cookie", challengeHeader("", 0))
          return response({ success: result.ok }, result.ok ? 200 : 503, outgoing)
        }
        const input = await readBody(request)
        if (url.pathname === "/api/connect/request-code") {
          const parsed = requestSchema.safeParse(input)
          if (!parsed.success) return error("INVALID_EMAIL", 400)
          const { email, intent } = parsed.data
          if (intent) { if (!options.validateIntent) return error("INVALID_INTENT", 400); options.validateIntent(intent, email) }
          const emailKey = guard.digest("email", email)
          const retry = guard.consume([
            { key: `send-cooldown:${emailKey}`, max: 1, windowSeconds: CONNECT_RESEND_SECONDS },
            { key: `send-email:${emailKey}`, max: 5, windowSeconds: 3_600 },
            { key: `send-ip:${ipKey}`, max: 20, windowSeconds: 3_600 },
            { key: "send-global", max: 100, windowSeconds: 3_600 },
          ])
          if (retry) return error("RATE_LIMITED", 429, retry)
          const challenge = randomBytes(32).toString("base64url")
          const delivery = { challenge, submitted: false, intent: intentKey(intent) }
          try {
            await sendContext.run(delivery, () => auth.api.sendVerificationOTP({
              body: { email, type: "sign-in" }, headers,
            }))
          } catch { return error("MAIL_UNAVAILABLE", 503, CONNECT_RESEND_SECONDS) }
          // Better Auth deliberately catches background/mail-hook failures.
          // Only acknowledge submission after our sender and receipt both succeed.
          if (!delivery.submitted) return error("MAIL_UNAVAILABLE", 503, CONNECT_RESEND_SECONDS)
          return response({ email, resendAfterSeconds: CONNECT_RESEND_SECONDS, expiresInSeconds: CONNECT_OTP_SECONDS }, 200, new Headers({ "Set-Cookie": challengeHeader(challenge) }))
        }
        const parsed = verifySchema.safeParse(input)
        if (!parsed.success) return error("INVALID_CODE", 400)
        const { email, code, remember, intent } = parsed.data
        if (intent) { if (!options.validateIntent) return error("INVALID_INTENT", 400); options.validateIntent(intent, email) }
        const challenge = cookieValue(request.headers, challengeCookie)
        if (!/^[\w-]{43}$/.test(challenge)) return error("LOGIN_EXPIRED", 400)
        const retry = guard.consume([
          { key: `verify-email:${guard.digest("email", email)}`, max: 5, windowSeconds: CONNECT_OTP_SECONDS },
          { key: `verify-ip:${ipKey}`, max: 30, windowSeconds: CONNECT_OTP_SECONDS },
        ])
        if (retry) return error("RATE_LIMITED", 429, retry)
        if (!guard.claim(challenge, email, code, intentKey(intent))) return error("INVALID_CODE", 400)
        const previous = await resolveSession(request)
        const result = await auth.api.signInEmailOTP({ body: { email, otp: code }, headers, asResponse: true })
        const outgoing = new Headers({ "Set-Cookie": challengeHeader("", 0) })
        if (!result.ok) return response({ error: "LOGIN_EXPIRED" }, 400, outgoing)
        const verifiedRequest = new Request(origin, { headers: { cookie: result.headers.getSetCookie().map(value => value.split(";")[0]).join("; ") } })
        const identity = await resolveSession(verifiedRequest)
        if (!identity) { await result.body?.cancel(); return error("LOGIN_EXPIRED", 400) }
        try { options.onVerified?.(identity, remember, intent) }
        catch {
          // Identity creation is separate from enrollment. A failed business
          // transaction must never yield a misleading successful bind/session.
          db.query("DELETE FROM session WHERE id=?").run(identity.id)
          await result.body?.cancel()
          return error("ACTION_NOT_COMPLETED", 409)
        }
        // Explicit fresh authentication replaces this browser's former family.
        // An account switch must not leave its old host tabs authorized.
        if (previous && previous.id !== identity.id) {
          options.onLogout?.(previous.id)
          db.query("DELETE FROM session WHERE id=?").run(previous.id)
        }
        for (const cookie of result.headers.getSetCookie()) {
          // The email-OTP plugin does not accept rememberMe. Session refresh is
          // disabled above, so a browser-only cookie stays non-persistent.
          outgoing.append("Set-Cookie", remember ? cookie : cookie.replace(/;\s*(?:Max-Age|Expires)=[^;]*/gi, ""))
        }
        // Better Auth's raw response includes a bearer token; never expose it.
        await result.body?.cancel()
        return response({ success: true }, 200, outgoing)
      } catch (caught) { return caught instanceof ConnectFault ? error(caught.code, caught.status, caught.retryAfterSeconds) : error("SERVICE_UNAVAILABLE", 503) }
    },
  }
}
