import { timingSafeEqual } from "node:crypto"
import { networkInterfaces } from "node:os"
import { REMOTE_HEADER, REMOTE_OWNER_HEADER } from "./adapter"
import { BROWSER_PREVIEW_PROXY_PREFIX } from "../../shared/browser-preview-proxy"

const loopback = (peer: string | undefined) => Boolean(peer && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer))
export type Ingress = { kind: "local" | "external" } | { kind: "remote"; ownerId: string }

export function validateIngress(request: Request, options: {
  port: number; hostname: string; peer?: string; secret: string; allowedOrigins?: string[]
}): Ingress | Response {
  const url = new URL(request.url)
  const remote = request.headers.get(REMOTE_HEADER)
  const ownerId = request.headers.get(REMOTE_OWNER_HEADER)
  const denied = () => Response.json({ error: "FORBIDDEN" }, { status: 403, headers: { "Cache-Control": "no-store" } })
  if (remote !== null || ownerId !== null) {
    if (!loopback(options.peer) || !remote || !ownerId || ownerId.length > 256 || Buffer.byteLength(remote) !== Buffer.byteLength(options.secret)
      || !timingSafeEqual(Buffer.from(remote), Buffer.from(options.secret))) return denied()
    if (url.pathname.startsWith("/_stillon/") || url.pathname.startsWith("/api/connect-local/")
      || url.pathname.startsWith("/auth/") || url.pathname.startsWith(BROWSER_PREVIEW_PROXY_PREFIX)) return denied()
    return { kind: "remote", ownerId }
  }
  const hostnames = new Set(["localhost", "127.0.0.1", "[::1]"])
  if (["0.0.0.0", "::"].includes(options.hostname)) {
    for (const entries of Object.values(networkInterfaces())) for (const entry of entries ?? []) hostnames.add(entry.family === "IPv6" ? `[${entry.address}]` : entry.address)
  } else hostnames.add(options.hostname.includes(":") && !options.hostname.startsWith("[") ? `[${options.hostname}]` : options.hostname)
  const origins = new Set([...hostnames].map(host => `http://${host}:${options.port}`))
  for (const origin of options.allowedOrigins ?? []) { try { if (new URL(origin).origin === origin) origins.add(origin) } catch { /* invalid entries never authorize */ } }
  const authorities = new Set([...origins].map(origin => new URL(origin).host))
  if (!authorities.has(url.host) || (request.headers.has("host") && request.headers.get("host") !== url.host)) return denied()
  const origin = request.headers.get("origin")
  const site = request.headers.get("sec-fetch-site")
  // The updater has its own bearer credential and only accepts loopback peers.
  // No browser may use this exception, even if it forges forwarding headers.
  const updater = url.pathname.startsWith("/_stillon/update/") && loopback(options.peer) && !origin && !site
  if (!updater && ((origin !== null && !origins.has(origin)) || ["cross-site", "same-site"].includes(site ?? "")
    || ((! ["GET", "HEAD", "OPTIONS"].includes(request.method) || url.pathname === "/ws") && !origin))) return denied()
  const local = loopback(options.peer) && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    && (!origin || ["127.0.0.1", "localhost", "[::1]"].includes(new URL(origin).hostname))
  return { kind: local ? "local" : "external" }
}
