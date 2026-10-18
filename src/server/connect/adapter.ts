import { CONNECT_LEASE_MS, CONNECT_MAX_HTTP_BYTES, type AccessLease } from "../../shared/connect"
import { verifyLease } from "./crypto"
import { ConnectRelay, forwardingHeaders, type RelaySocket } from "./relay"
import { stopConnectListener } from "./stop-server"
import { parseConnectPreviewPath } from "../../shared/connect-preview"
import { isAllowedBrowserPreviewPort } from "../browser-preview-proxy"
import { protectPreviewPort, releasePreviewPort } from "../preview-ports"

interface ActiveLease { token: string; lease: AccessLease; deadline: number }
export const REMOTE_HEADER = "x-stillon-local-remote"
export const REMOTE_OWNER_HEADER = "x-stillon-local-owner"
export const REMOTE_SESSION_HEADER = "x-stillon-local-session"
export const REMOTE_EXPIRY_HEADER = "x-stillon-local-expiry"

/** Dedicated fail-closed target for frpc. It never treats a loopback peer as local UI. */
export function startRemoteAdapter(options: {
  targetOrigin: string; localSecret: string; publicKey: string; hostId: string; epoch: number; generation: number
}) {
  const leases = new Map<string, ActiveLease>()
  const relay = new ConnectRelay()
  const targetOrigin = new URL(options.targetOrigin).origin
  let stopped = false
  let wall = Date.now(), monotonic = performance.now()
  function valid(entry: ActiveLease) {
    const nextWall = Date.now(), nextMono = performance.now()
    if (Math.abs((nextWall - wall) - (nextMono - monotonic)) > 5_000) { leases.clear(); relay.invalidate({}) }
    wall = nextWall; monotonic = nextMono
    return !stopped && leases.has(entry.lease.id) && nextMono < entry.deadline && nextWall < entry.lease.expiresAt
  }
  const server = Bun.serve<RelaySocket>({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: CONNECT_MAX_HTTP_BYTES, idleTimeout: 120,
    async fetch(request, server) {
      const url = new URL(request.url)
      const token = request.headers.get("x-stillon-connect-lease") ?? ""
      const lease = verifyLease(token, options.publicKey)
      if (!lease || lease.hostId !== options.hostId || lease.epoch !== options.epoch || lease.generation !== options.generation
        || lease.method !== request.method || lease.path !== url.pathname + url.search || stopped) return new Response("Forbidden", { status: 403 })
      if (leases.size >= 32) return new Response("Connection limit", { status: 429 })
      const entry = { token, lease, deadline: performance.now() + Math.min(CONNECT_LEASE_MS, lease.expiresAt - Date.now()) }
      leases.set(lease.id, entry)
      const preview = parseConnectPreviewPath(url.pathname)
      const headers = forwardingHeaders(request, Boolean(preview))
      const scope = { hostId: lease.hostId, parentId: lease.parentId, ownerId: lease.ownerId, valid: () => valid(entry),
        finished: () => { if (leases.get(lease.id) === entry) leases.delete(lease.id) } }
      if (preview) {
        try {
          const blockedPorts = [Number(new URL(targetOrigin).port || 80), server.port!]
          if (!await isAllowedBrowserPreviewPort(preview.port, blockedPorts)) {
            leases.delete(lease.id)
            return Response.json({ error: "PREVIEW_UNAVAILABLE" }, { status: 503 })
          }
          // Use the same loopback resolution as discovery, including Vite's
          // default IPv6 localhost listener.
          const target = new URL("http://localhost:" + preview.port)
          target.pathname = preview.path; target.search = url.search
          if (headers.has("origin")) headers.set("origin", target.origin)
          headers.delete("referer")
          headers.delete("sec-fetch-site")
          if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
            target.protocol = "ws:"
            return await relay.upgrade(request, server, target.href, headers, scope)
          }
          return await relay.http(request, target.href, headers, scope, undefined, true)
        } catch { leases.delete(lease.id); return new Response("Preview unavailable", { status: 503 }) }
      }
      headers.set(REMOTE_HEADER, options.localSecret)
      headers.set(REMOTE_OWNER_HEADER, lease.ownerId)
      headers.set(REMOTE_SESSION_HEADER, lease.parentId)
      headers.set(REMOTE_EXPIRY_HEADER, String(lease.expiresAt))
      headers.set("origin", targetOrigin)
      headers.delete("sec-fetch-site")
      // Assign path fields: resolving a leading // path would change authority.
      const target = new URL(targetOrigin)
      target.pathname = url.pathname; target.search = url.search
      try {
        if (url.pathname === "/ws") { target.protocol = "ws:"; return await relay.upgrade(request, server, target.href, headers, scope) }
        return await relay.http(request, target.href, headers, scope, response => {
          if (/text\/html|image\/svg\+xml|application\/xhtml\+xml/i.test(response.headers.get("content-type") ?? "") && url.pathname.startsWith("/api/")) {
            response.headers.set("Content-Security-Policy", "sandbox allow-scripts allow-downloads; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; base-uri 'none'; form-action 'none'")
          }
          response.headers.set("X-Content-Type-Options", "nosniff")
          return response
        })
      } catch { leases.delete(lease.id); return new Response("Connection unavailable", { status: 503 }) }
    }, websocket: relay.websocket,
    error: () => new Response("Connection unavailable", { status: 503 }),
  })
  // Drop finished/expired entries. Active streams cannot renew an already
  const adapterPort = server.port!
  protectPreviewPort(adapterPort)
  // expired lease; each renewal is signed by the account service.
  const cleanup = setInterval(() => {
    for (const [id, entry] of leases) if (!valid(entry)) leases.delete(id)
  }, 1_000)
  cleanup.unref()
  return {
    port: adapterPort,
    activeLeases: () => [...leases.values()].filter(valid).map(entry => entry.token),
    renew(values: { id: string; token: string }[], requested: string[]) {
      const allowed = new Set(values.map(v => v.id))
      const snapshot = new Set(requested)
      for (const [id, entry] of leases) {
        // Do not revoke requests that arrived while this heartbeat was in flight.
        if (!snapshot.has(entry.token)) continue
        if (!allowed.has(id)) { leases.delete(id); continue }
        const update = values.find(v => v.id === id)!
        const next = verifyLease(update.token, options.publicKey)
        if (!next || next.id !== id || next.hostId !== entry.lease.hostId || next.parentId !== entry.lease.parentId
          || next.sessionId !== entry.lease.sessionId || next.ownerId !== entry.lease.ownerId || next.epoch !== entry.lease.epoch
          || next.generation !== entry.lease.generation || next.path !== entry.lease.path || next.method !== entry.lease.method || !valid(entry)) {
          leases.delete(id); continue
        }
        entry.token = update.token; entry.lease = next
        entry.deadline = performance.now() + Math.min(CONNECT_LEASE_MS, next.expiresAt - Date.now())
      }
    },
    async stop() { stopped = true; clearInterval(cleanup); leases.clear(); relay.stop(); await stopConnectListener(server); releasePreviewPort(adapterPort) },
  }
}
