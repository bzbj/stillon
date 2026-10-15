import { isIP } from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createConnectAuth, normalizeConnectOrigin, type ConnectAuthOptions } from "./auth"

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

export async function startConnectServer(options: ConnectAuthOptions & { port?: number; trustProxy?: boolean }) {
  const origin = normalizeConnectOrigin(options.origin)
  const host = new URL(origin).host
  const assetsDir = fileURLToPath(new URL("../../dist/connect/", import.meta.url))
  const index = Bun.file(path.join(assetsDir, "index.html"))
  if (!await index.exists()) throw new Error("Build the Connect page first: bun run build:connect")
  const auth = await createConnectAuth({ ...options, origin })
  function secure(response: Response) {
    response.headers.set("X-Content-Type-Options", "nosniff")
    response.headers.set("Referrer-Policy", "no-referrer")
    response.headers.set("X-Frame-Options", "DENY")
    response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
    response.headers.set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
    if (origin.startsWith("https:")) response.headers.set("Strict-Transport-Security", "max-age=31536000")
    return response
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 3220,
    maxRequestBodySize: 4_096,
    async fetch(request, server) {
      const url = new URL(request.url)
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
        return secure(await auth.handle(request, connectPeerKey(clientIp)))
      }
      if (!["GET", "HEAD"].includes(request.method)) return secure(new Response("Method not allowed", { status: 405 }))
      if (url.pathname === "/health") return secure(Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } }))
      if (url.pathname === "/" || url.pathname === "/login") {
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
    error() { return secure(new Response("Service unavailable", { status: 503 })) },
  })
  return { port: server.port, async stop() { await server.stop(true); auth.close() } }
}
