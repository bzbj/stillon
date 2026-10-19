import { isIP } from "node:net"
import path from "node:path"
import { appendHttpTiming } from "../shared/http-timing"
import { fileURLToPath } from "node:url"
import { createConnectAuth, normalizeConnectOrigin, type ConnectAuthOptions } from "./auth"
import { createConnectService, type ConnectTransportOptions } from "./service"
import { CONNECT_MAX_HTTP_BYTES } from "../shared/connect"
import type { RelaySocket } from "../server/connect/relay"
import { stopConnectListener } from "../server/connect/stop-server"
import { createReadinessProbe } from "./readiness"

/** Collapse IPv6 privacy addresses into a /64 budget; ignore spoofed headers. */
export function connectPeerKey(address: string) {
  if (address.startsWith("::ffff:") && isIP(address.slice(7)) === 4) return address.slice(7)
  if (isIP(address) !== 6) return address
  const [left, right] = address.toLowerCase().split("::")
  const start = left ? left.split(":") : []
  const end = right ? right.split(":") : []
  const parts = right === undefined ? start : [...start, ...Array(8 - start.length - end.length).fill("0"), ...end]
  return `${parts.slice(0, 4).map((part) => parseInt(part, 16).toString(16)).join(":")}::/64`
}

export async function startConnectServer(options: ConnectAuthOptions & { port?: number; trustProxy?: boolean; remote?: ConnectTransportOptions }) {
  const origin = normalizeConnectOrigin(options.origin)
  const host = new URL(origin).host
  const assetsDir = fileURLToPath(new URL("../../dist/connect/", import.meta.url))
  const index = Bun.file(path.join(assetsDir, "index.html"))
  if (!await index.exists()) throw new Error("Build the Connect page first: bun run build:connect")
  const remote = options.remote ? await createConnectService({ ...options, origin, transport: options.remote }) : null
  const auth = remote?.auth ?? await createConnectAuth({ ...options, origin })
  const ready = createReadinessProbe(() => { auth.checkStorage(); remote?.registry.db.query("SELECT id FROM host LIMIT 1").get() }, options.remote?.upstreamOrigin)
  function secure(response: Response) {
    response.headers.set("X-Content-Type-Options", "nosniff")
    response.headers.set("Referrer-Policy", "no-referrer")
    response.headers.set("X-Frame-Options", "DENY")
    response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
    response.headers.set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
    if (origin.startsWith("https:")) response.headers.set("Strict-Transport-Security", "max-age=31536000")
    return response
  }
  let plugin: ReturnType<typeof Bun.serve> | null = null
  const active = new Set<Promise<unknown>>()
  function track<T>(operation: Promise<T>): Promise<T> { active.add(operation); void operation.finally(() => active.delete(operation)).catch(() => {}); return operation }
  const server = Bun.serve<RelaySocket>({
    hostname: "127.0.0.1",
    port: options.port ?? 3220,
    maxRequestBodySize: remote ? CONNECT_MAX_HTTP_BYTES : 4_096,
    idleTimeout: 120,
    async fetch(request, server) {
      const requestStartedAt = performance.now()
      const url = new URL(request.url)
      if (remote && remote.hostId(request)) {
        const response = await track(remote.host(request, server))
        if (response) {
          appendHttpTiming(response, "connect", requestStartedAt)
          response.headers.set("X-Content-Type-Options", "nosniff")
          response.headers.set("Referrer-Policy", "no-referrer")
          if (origin.startsWith("https:")) response.headers.set("Strict-Transport-Security", "max-age=31536000")
        }
        return response
      }
      if (url.host !== host || (request.headers.has("host") && request.headers.get("host") !== host)) return secure(new Response("Forbidden", { status: 403 }))
      if (url.pathname.startsWith("/api/")) {
        const peer = server.requestIP(request)?.address
        if (!peer) return secure(new Response("Forbidden", { status: 403 }))
        let clientIp = peer
        if (options.trustProxy) {
          if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer)) return secure(new Response("Forbidden", { status: 403 }))
          const forwarded = request.headers.get("x-real-ip")
          if (!forwarded || !isIP(forwarded)) return secure(new Response("Forbidden", { status: 403 }))
          clientIp = forwarded
        }
        return secure(remote ? await track(remote.central(request, connectPeerKey(clientIp))) ?? new Response("Not found", { status: 404 })
          : await track(auth.handle(request, connectPeerKey(clientIp))))
      }
      if (!["GET", "HEAD"].includes(request.method)) return secure(new Response("Method not allowed", { status: 405 }))
      if (url.pathname === "/health") return secure(Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } }))
      if (url.pathname === "/ready") {
        const ok = await track(ready())
        return secure(Response.json({ ok }, { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } }))
      }
      if (["/", "/login", "/bind", "/authorize", "/logout/complete", "/computers", "/revoke-host"].includes(url.pathname)) {
        return secure(new Response(request.method === "HEAD" ? null : index, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }))
      }
      const assetName = url.pathname.slice("/assets/".length)
      const isAsset = url.pathname.startsWith("/assets/") && /^[\w.-]+$/.test(assetName)
      const file = url.pathname === "/stillon-mark.svg"
        ? Bun.file(fileURLToPath(new URL("../../public/stillon-mark.svg", import.meta.url)))
        : isAsset ? Bun.file(path.join(assetsDir, "assets", assetName)) : null
      if (!file || !await file.exists()) return secure(new Response("Not found", { status: 404 }))
      return secure(new Response(request.method === "HEAD" ? null : file, { headers: { "Content-Type": file.type, "Cache-Control": "public, max-age=3600" } }))
    },
    websocket: remote?.relay.websocket ?? { message() {} },
    error() { return secure(new Response("Service unavailable", { status: 503 })) },
  })
  try {
    if (remote) plugin = Bun.serve({ hostname: "127.0.0.1", port: options.remote?.pluginPort ?? 3221, maxRequestBodySize: 32_768,
      fetch: request => remote.plugin(request), error: () => Response.json({ reject: true, reject_reason: "Unavailable" }) })
  } catch (error) { await server.stop(true); remote?.close(); if (!remote) auth.close(); throw error }
  return { port: server.port, pluginPort: plugin?.port, remote,
    async stop() { remote?.relay.stop(); await stopConnectListener(server); if (plugin) await stopConnectListener(plugin);
      await Promise.allSettled([...active]); if (remote) remote.close(); else auth.close() } }
}
