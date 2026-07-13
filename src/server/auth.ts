import { randomBytes, timingSafeEqual } from "node:crypto"

const SESSION_COOKIE_NAME = "stillon_session"
const LOGIN_ATTEMPT_WINDOW_MS = 5 * 60 * 1000
const MAX_FAILED_LOGIN_ATTEMPTS = 10

export interface AuthStatusPayload {
  enabled: boolean
  authenticated: boolean
}

export interface AuthManager {
  isAuthenticated(req: Request): boolean
  validateOrigin(req: Request): boolean
  redirectToApp(req: Request): Response
  handleLogin(req: Request, nextPath: string): Promise<Response>
  handleLogout(req: Request): Response
  handleStatus(req: Request): Response
}

function parseCookies(header: string | null) {
  const cookies = new Map<string, string>()
  if (!header) return cookies

  for (const segment of header.split(";")) {
    const trimmed = segment.trim()
    if (!trimmed) continue
    const separator = trimmed.indexOf("=")
    if (separator <= 0) continue
    const key = trimmed.slice(0, separator).trim()
    const value = trimmed.slice(separator + 1).trim()
    cookies.set(key, decodeURIComponent(value))
  }

  return cookies
}

function sanitizeNextPath(nextPath: string | null | undefined) {
  if (!nextPath || typeof nextPath !== "string") return "/"
  if (!nextPath.startsWith("/")) return "/"
  if (nextPath.startsWith("//")) return "/"
  if (nextPath.startsWith("/auth/login")) return "/"
  return nextPath
}

function forwardedProto(req: Request): "http" | "https" | null {
  const xfp = req.headers.get("x-forwarded-proto")
  if (!xfp) return null
  const value = xfp.split(",")[0]?.trim().toLowerCase()
  return value === "http" || value === "https" ? value : null
}

function effectiveOrigin(req: Request, trustProxy: boolean): string {
  const url = new URL(req.url)
  if (!trustProxy) return url.origin
  const proto = forwardedProto(req)
  const scheme = proto ?? url.protocol.replace(":", "")
  return `${scheme}://${url.host}`
}

function shouldUseSecureCookie(req: Request, trustProxy: boolean) {
  if (trustProxy) {
    const proto = forwardedProto(req)
    if (proto) return proto === "https"
  }
  return new URL(req.url).protocol === "https:"
}

function buildCookie(name: string, value: string, req: Request, trustProxy: boolean, extras: string[] = []) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
  ]

  if (shouldUseSecureCookie(req, trustProxy)) {
    parts.push("Secure")
  }

  parts.push(...extras)
  return parts.join("; ")
}

async function readLoginForm(req: Request) {
  const contentType = req.headers.get("content-type") ?? ""

  if (contentType.includes("application/json")) {
    const payload = await req.json() as { password?: unknown; next?: unknown }
    return {
      password: typeof payload.password === "string" ? payload.password : "",
      nextPath: sanitizeNextPath(typeof payload.next === "string" ? payload.next : "/"),
    }
  }

  const formData = await req.formData()
  return {
    password: String(formData.get("password") ?? ""),
    nextPath: sanitizeNextPath(String(formData.get("next") ?? "/")),
  }
}

export interface AuthManagerOptions {
  /**
   * When true, the auth layer trusts X-Forwarded-Proto to decide whether the
   * public origin is http or https. The hostname always comes from the Host
   * header (never X-Forwarded-Host) to prevent forwarded-host open redirects.
   * Enable only when the server is reachable solely through a trusted reverse
   * proxy.
   */
  trustProxy?: boolean
}

export function createAuthManager(password: string, options: AuthManagerOptions = {}): AuthManager {
  const sessions = new Set<string>()
  const failedLoginAttempts = new Map<string, number[]>()
  const expectedPassword = Buffer.from(password)
  const trustProxy = options.trustProxy ?? false

  function getLoginClientKey(req: Request) {
    if (!trustProxy) return "direct"
    return req.headers.get("cf-connecting-ip")?.trim()
      || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
      || "proxy"
  }

  function getRecentFailedAttempts(req: Request) {
    const key = getLoginClientKey(req)
    const cutoff = Date.now() - LOGIN_ATTEMPT_WINDOW_MS
    const attempts = (failedLoginAttempts.get(key) ?? []).filter((timestamp) => timestamp >= cutoff)
    if (attempts.length > 0) {
      failedLoginAttempts.set(key, attempts)
    } else {
      failedLoginAttempts.delete(key)
    }
    return { key, attempts }
  }

  function rateLimitResponse(req: Request) {
    const { attempts } = getRecentFailedAttempts(req)
    if (attempts.length < MAX_FAILED_LOGIN_ATTEMPTS) return null
    const retryAfterSeconds = Math.max(1, Math.ceil((attempts[0] + LOGIN_ATTEMPT_WINDOW_MS - Date.now()) / 1000))
    return Response.json(
      { error: "Too many login attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
    )
  }

  function recordFailedLogin(req: Request) {
    const { key, attempts } = getRecentFailedAttempts(req)
    attempts.push(Date.now())
    failedLoginAttempts.set(key, attempts)
  }

  function clearFailedLogins(req: Request) {
    failedLoginAttempts.delete(getLoginClientKey(req))
  }

  function getSessionToken(req: Request) {
    return parseCookies(req.headers.get("cookie")).get(SESSION_COOKIE_NAME) ?? null
  }

  function isAuthenticated(req: Request) {
    const sessionToken = getSessionToken(req)
    return Boolean(sessionToken && sessions.has(sessionToken))
  }

  function validateOrigin(req: Request) {
    const origin = req.headers.get("origin")
    if (!origin) return true
    if (origin === new URL(req.url).origin) return true
    if (!trustProxy) return false
    return origin === effectiveOrigin(req, trustProxy)
  }

  function createSessionCookie(req: Request) {
    const sessionToken = randomBytes(32).toString("base64url")
    sessions.add(sessionToken)
    return buildCookie(SESSION_COOKIE_NAME, sessionToken, req, trustProxy)
  }

  function clearSessionCookie(req: Request) {
    const sessionToken = getSessionToken(req)
    if (sessionToken) {
      sessions.delete(sessionToken)
    }
    return buildCookie(SESSION_COOKIE_NAME, "", req, trustProxy, ["Max-Age=0"])
  }

  function verifyPassword(candidate: string) {
    const actual = Buffer.from(candidate)
    if (actual.length !== expectedPassword.length) {
      return false
    }
    return timingSafeEqual(actual, expectedPassword)
  }

  function handleStatus(req: Request) {
    return Response.json({
      enabled: true,
      authenticated: isAuthenticated(req),
    } satisfies AuthStatusPayload)
  }

  function redirectToApp(req: Request) {
    const currentUrl = new URL(req.url)
    return Response.redirect(new URL(sanitizeNextPath(currentUrl.searchParams.get("next")), effectiveOrigin(req, trustProxy)), 302)
  }

  async function handleLogin(req: Request, fallbackNextPath: string) {
    if (!validateOrigin(req)) {
      return Response.json({ error: "Forbidden" }, { status: 403 })
    }

    const limited = rateLimitResponse(req)
    if (limited) return limited

    const { password: candidate, nextPath } = await readLoginForm(req)
    if (!verifyPassword(candidate)) {
      recordFailedLogin(req)
      return Response.json({ error: "Invalid password" }, { status: 401 })
    }

    clearFailedLogins(req)
    const response = Response.json({ ok: true, nextPath: sanitizeNextPath(nextPath || fallbackNextPath) })

    response.headers.set("Set-Cookie", createSessionCookie(req))
    return response
  }

  function handleLogout(req: Request) {
    if (!validateOrigin(req)) {
      return Response.json({ error: "Forbidden" }, { status: 403 })
    }

    const response = Response.json({ ok: true })
    response.headers.set("Set-Cookie", clearSessionCookie(req))
    return response
  }

  return {
    isAuthenticated,
    validateOrigin,
    redirectToApp,
    handleLogin,
    handleLogout,
    handleStatus,
  }
}
