import type { Server } from "bun"
import { CONNECT_PREVIEW_CLAIM_PATH, CONNECT_PREVIEW_PROXY_PREFIX, connectPreviewOrigin, connectPreviewTarget } from "../shared/connect-preview"
import { isLoopbackPreviewHost } from "../shared/browser-preview-proxy"
import { hashToken, randomToken, signLease } from "../server/connect/crypto"
import { ConnectRelay, forwardingHeaders, type RelaySocket } from "../server/connect/relay"
import { ConnectFault, type AccountIdentity, type ConnectRegistry, type HostSessionRecord } from "./registry"
import { cookie, cookieName, cookieValue, redirect } from "./http"

interface Ticket { session: HostSessionRecord; port: number; path: string; expiresAt: number }
interface PreviewSession { session: HostSessionRecord; port: number; token: string }

/** Arbitrary development apps get their own computer/port-scoped origin and
 * credentials, never StillOn's cookies, local storage or API authority. */
export class ConnectPreviews {
  private readonly tickets = new Map<string, Ticket>()
  private readonly sessions = new Map<string, PreviewSession>()
  private readonly byTarget = new Map<string, PreviewSession>()
  private readonly timer: ReturnType<typeof setInterval>
  constructor(private readonly options: {
    origin: string; registry: ConnectRegistry; readIdentity: (id: string) => AccountIdentity | null
    relay: ConnectRelay; transport: URL; privateKey: string
  }) {
    this.timer = setInterval(() => this.prune(), 60_000)
    this.timer.unref()
  }
  target(authority: string) { return connectPreviewTarget(this.options.origin, authority) }
  unsupported(hostId: string) { return this.unavailable("Use an HTTP development server for Connect previews. HTTPS-only local servers are not supported.", 400, hostId) }
  close() { clearInterval(this.timer); this.tickets.clear(); this.sessions.clear(); this.byTarget.clear() }
  private valid(session: HostSessionRecord) {
    return this.options.registry.validSession(session, this.options.readIdentity)
      && !this.options.registry.requireHost(session.hostId).paused
  }
  private prune() {
    for (const [key, ticket] of this.tickets) if (ticket.expiresAt <= Date.now() || !this.valid(ticket.session)) this.tickets.delete(key)
    for (const [key, entry] of this.sessions) if (!this.valid(entry.session)) {
      this.sessions.delete(key)
      this.byTarget.delete(entry.session.id + ":" + entry.port)
    }
  }
  start(session: HostSessionRecord, port: number, path: string) {
    this.prune()
    if (!this.valid(session)) throw new ConnectFault("AUTH_REQUIRED", 401)
    this.options.registry.limited("preview-start:" + session.ownerId, 60, 60)
    if (this.tickets.size >= 1_024) throw new ConnectFault("RATE_LIMITED", 429)
    const origin = connectPreviewOrigin(this.options.origin, session.hostId, port), token = randomToken()
    this.tickets.set(hashToken(token), { session, port, path, expiresAt: Date.now() + 60_000 })
    return redirect(origin + CONNECT_PREVIEW_CLAIM_PATH + "?ticket=" + token)
  }
  private unavailable(message: string, status: number, hostId: string) {
    const app = this.options.registry.hostOrigin(hostId)
    return new Response('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>StillOn preview</title><style>body{font:16px system-ui;max-width:480px;margin:15vh auto;padding:24px;color:#253044}p{line-height:1.7}a{color:inherit}</style><h1>Preview unavailable</h1><p>' + message + '</p><a href="' + app + '" target="_blank" rel="noopener noreferrer">Open StillOn</a></html>', {
      status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors " + app + "; base-uri 'none'" },
    })
  }
  async handle(request: Request, server: Server<RelaySocket>): Promise<Response | undefined> {
    const url = new URL(request.url), target = this.target(url.host)
    if (!target) throw new ConnectFault("NOT_FOUND", 404)
    const { hostId, port } = target, origin = connectPreviewOrigin(this.options.origin, hostId, port)
    if (request.headers.has("host") && request.headers.get("host") !== url.host) throw new ConnectFault("INVALID_HOST", 403)
    this.options.registry.requireHost(hostId)
    if (url.pathname === CONNECT_PREVIEW_CLAIM_PATH && request.method === "GET") {
      const key = hashToken(url.searchParams.get("ticket") ?? ""), ticket = this.tickets.get(key)
      if (!ticket || ticket.session.hostId !== hostId || ticket.port !== port || ticket.expiresAt <= Date.now() || !this.valid(ticket.session)) {
        return this.unavailable("This preview link expired. Open the preview again from StillOn.", 410, hostId)
      }
      this.tickets.delete(key)
      const targetKey = ticket.session.id + ":" + port
      let entry = this.byTarget.get(targetKey)
      if (!entry) {
        this.prune()
        if (this.sessions.size >= 2_048 || [...this.sessions.values()].filter(value => value.session.parentId === ticket.session.parentId).length >= 32) throw new ConnectFault("RATE_LIMITED", 429)
        entry = { session: ticket.session, port, token: randomToken() }
        this.sessions.set(hashToken(entry.token), entry)
        this.byTarget.set(targetKey, entry)
      }
      return redirect(origin + ticket.path, new Headers({ "Set-Cookie": cookie(origin, "preview", entry.token) }))
    }
    const from = request.headers.get("origin")
    const navigation = request.method === "GET" && request.headers.get("sec-fetch-mode") === "navigate"
      && ["document", "iframe"].includes(request.headers.get("sec-fetch-dest") ?? "")
    if ((from && from !== origin) || (!navigation && ["same-site", "cross-site"].includes(request.headers.get("sec-fetch-site") ?? ""))
      || ((!["GET", "HEAD"].includes(request.method) || request.headers.get("upgrade")?.toLowerCase() === "websocket") && from !== origin)) throw new ConnectFault("INVALID_ORIGIN", 403)
    const entry = this.sessions.get(hashToken(cookieValue(request, cookieName(origin, "preview"))))
    if (!entry || entry.session.hostId !== hostId || entry.port !== port || !this.valid(entry.session)) {
      return this.unavailable("Your preview session expired. Open the preview again from StillOn.", 401, hostId)
    }
    // Service workers must not serve cached private pages after revocation.
    if (request.headers.get("sec-fetch-dest") === "serviceworker" || request.headers.get("service-worker") === "script") throw new ConnectFault("PREVIEW_WORKER_DENIED", 403)
    this.options.registry.limited("preview:" + entry.session.ownerId, 1_200, 60)
    const proxy = new URL(this.options.transport)
    proxy.pathname = CONNECT_PREVIEW_PROXY_PREFIX + "/" + port + url.pathname
    proxy.search = url.search
    const lease = this.options.registry.makeLease(entry.session, request.method, proxy.pathname + proxy.search)
    const headers = forwardingHeaders(request, true)
    headers.set("host", new URL(this.options.registry.hostOrigin(hostId)).host)
    headers.set("x-stillon-connect-lease", signLease(lease, this.options.privateKey))
    const scope = { hostId, parentId: entry.session.parentId, ownerId: entry.session.ownerId, valid: () => this.valid(entry.session) }
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      proxy.protocol = "ws:"
      return this.options.relay.upgrade(request, server, proxy.href, headers, scope)
    }
    const response = await this.options.relay.http(request, proxy.href, headers, scope, undefined, true)
    response.headers.delete("x-frame-options")
    response.headers.delete("clear-site-data")
    response.headers.delete("service-worker-allowed")
    const csp = (response.headers.get("content-security-policy") ?? "").split(";").filter(value => value.trim() && !/^\s*frame-ancestors\b/i.test(value))
    csp.push("frame-ancestors 'self' " + this.options.registry.hostOrigin(hostId))
    response.headers.set("Content-Security-Policy", csp.join("; "))
    const location = response.headers.get("location")
    if (location) {
      try {
        const destination = new URL(location, url)
        if (isLoopbackPreviewHost(destination.hostname) && Number(destination.port || 80) === port) {
          response.headers.set("Location", origin + destination.pathname + destination.search + destination.hash)
        }
      } catch { /* Let the browser handle invalid application redirects. */ }
    }
    if (response.status === 503 && request.headers.get("accept")?.includes("text/html")) {
      await response.body?.cancel()
      return this.unavailable("The computer or web server is unavailable. Start the web server on the computer, then reload this page.", 503, hostId)
    }
    return response
  }
}
