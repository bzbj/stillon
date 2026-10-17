import { chmod, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import type { Server } from "bun"
import { z } from "zod"
import { CONNECT_PROTOCOL, type DeviceProof } from "../shared/connect"
import { newDeviceKeys, safeRelativePath, signLease, validateDeviceKeys, verifyLease } from "../server/connect/crypto"
import { ConnectRelay, forwardingHeaders, type RelaySocket } from "../server/connect/relay"
import { createConnectAuth, type ConnectAuthOptions } from "./auth"
import { ConnectFault, ConnectRegistry, type AccountIdentity, type HostSessionRecord } from "./registry"
import { PreviewResources, REMOTE_PREVIEW_ASSET_PREFIX, projectPreviewTarget, type PreviewResourceContext } from "../server/preview-resources"
import { checkBrowserRequest, cookie, cookieName, cookieValue, faultResponse, json, jsonBody, redirect } from "./http"
import { ConnectPreviews } from "./previews"
import { CONNECT_PREVIEW_PROXY_PREFIX, CONNECT_PREVIEW_START_PREFIX, CONNECT_PREVIEW_UNSUPPORTED_PATH, parseConnectPreviewPath } from "../shared/connect-preview"
import { BROWSER_PREVIEW_PROXY_PREFIX } from "../shared/browser-preview-proxy"

const id = z.string().regex(/^[a-f0-9]{32}$/)
const name = z.string().trim().min(1).max(80).refine(v => !/[\u0000-\u001f]/.test(v))
const deviceActions = z.enum(["enroll", "claim", "cancel-enrollment", "connect", "heartbeat", "pause", "resume", "unbind", "rotate"])
const proofSchema = z.object({ subject: z.string().max(128), challenge: z.string().regex(/^[\w-]{43}$/),
  action: deviceActions, payload: z.record(z.string(), z.unknown()), signature: z.string().regex(/^[\w-]{86}$/) }).strict()
function parse<T>(schema: z.ZodType<T>, value: unknown): T { const result = schema.safeParse(value); if (!result.success) throw new ConnectFault("INVALID_BODY", 400); return result.data }

export interface ConnectTransportOptions {
  /** Internal frps HTTP vhost listener, never a user-selected proxy target. */
  upstreamOrigin: string
  /** Public WSS endpoint authority; defaults to the account origin. */
  tunnelOrigin?: string
  pluginPort?: number
}

export async function createConnectService(options: ConnectAuthOptions & { transport: ConnectTransportOptions }) {
  const registry = new ConnectRegistry(options.dataDir, options.origin, options.secret)
  const relay = new ConnectRelay()
  const previewResources = new PreviewResources(REMOTE_PREVIEW_ASSET_PREFIX)
  const previewSessions = new WeakMap<PreviewResourceContext, { hostId: string; session: HostSessionRecord }>()
  const signingPath = path.join(options.dataDir, "gateway-keys.json")
  let keys: ReturnType<typeof newDeviceKeys>
  try { keys = JSON.parse(await readFile(signingPath, "utf8")); validateDeviceKeys(keys) }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) { registry.close(); relay.stop(); throw new Error("Invalid Connect signing key file") }
    keys = newDeviceKeys()
    await writeFile(signingPath, JSON.stringify(keys), { mode: 0o600, flag: "wx" })
  }
  await chmod(signingPath, 0o600)
  const transport = new URL(options.transport.upstreamOrigin)
  if (transport.protocol !== "http:" || transport.hostname !== "127.0.0.1" || transport.pathname !== "/" || transport.username || transport.password || transport.search || transport.hash) {
    registry.close(); relay.stop(); throw new Error("frps upstream must be an explicit loopback HTTP origin")
  }
  const tunnel = new URL(options.transport.tunnelOrigin ?? options.origin)
  if (tunnel.username || tunnel.password || tunnel.pathname !== "/" || tunnel.search || tunnel.hash
    || (tunnel.protocol !== "https:" && !(tunnel.protocol === "http:" && ["localhost", "127.0.0.1"].includes(tunnel.hostname)))) {
    registry.close(); relay.stop(); throw new Error("Tunnel requires an HTTPS origin (loopback HTTP only for development)")
  }
  const auth = await createConnectAuth({ ...options,
    isRevoked: id => registry.isRevoked(id),
    onLogout: id => registry.revokeParent(id),
    validateIntent(intent) {
      if (intent.purpose === "enroll") registry.pendingEnrollment(intent.id)
      else registry.requireHost(intent.id)
    },
    onVerified(identity, remember, intent) {
      registry.remember(identity.id, remember)
      if (intent?.purpose === "enroll") registry.approveEnrollment(intent.id, identity)
      if (intent?.purpose === "revoke-host") registry.revokeHost(intent.id, identity.userId)
    },
  })
  registry.onInvalidate = scope => relay.invalidate(scope)
  const authenticated = async (request: Request): Promise<AccountIdentity> => {
    const identity = await auth.resolveSession(request)
    if (!identity) throw new ConnectFault("AUTH_REQUIRED", 401)
    return identity
  }
  const centralOrigin = new URL(options.origin).origin
  const previews = new ConnectPreviews({ origin: options.origin, registry, readIdentity: auth.identityById, relay, transport, privateKey: keys.privateKey })
  function offlinePage(hostId: string, head: boolean) {
    const host = registry.publicHost(registry.requireHost(hostId))
    const escaped = (value: string) => value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!)
    return new Response(head ? null : `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="15"><title>StillOn · Computer offline</title><style>body{font:16px system-ui;max-width:480px;margin:18vh auto;padding:24px;color:#253044}p{line-height:1.8;color:#657187}a,button{font:inherit;color:inherit}form{margin-top:24px}button{padding:10px 18px;border:1px solid #ccd2dc;border-radius:10px;background:white}</style><h1>${escaped(host.name)}</h1><p>${host.paused ? "Remote access is paused. Resume it in StillOn settings on this computer." : "This computer is offline. Make sure it is on, online and running StillOn. This page will retry automatically when it reconnects."}</p><a href="${escaped(centralOrigin)}/computers">View / switch computers</a><form method="post" action="/_connect/logout"><button>Logout</button></form></html>`, {
      status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Retry-After": "15",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" },
    })
  }

  async function device(request: Request, peer: string) {
    if (request.method !== "POST") throw new ConnectFault("METHOD_NOT_ALLOWED", 405)
    // Device endpoints have cryptographic proof; browser cookies never authorize them.
    if (request.headers.has("origin") || request.headers.has("cookie")) throw new ConnectFault("INVALID_ORIGIN", 403)
    registry.limited(`device:${peer}`, 240, 60)
    registry.limited("device:global", 3_000, 60)
    const route = new URL(request.url).pathname
    if (route === "/api/connect/device/challenge") {
      const input = parse(z.object({ subject: z.string().max(128), action: deviceActions }).strict(), await jsonBody(request))
      if (!/^(?:[a-f0-9]{32}|key:[\w-]{59})$/.test(input.subject)) throw new ConnectFault("INVALID_BODY", 400)
      return json({ challenge: registry.createChallenge(input.subject, input.action), protocol: CONNECT_PROTOCOL })
    }
    if (route !== "/api/connect/device/request") throw new ConnectFault("NOT_FOUND", 404)
    const proof = parse(proofSchema, await jsonBody(request, 256 * 1024)) as DeviceProof
    const key = registry.consumeProof(proof)
    const provisional = proof.subject.startsWith("key:")
    if (["enroll", "claim", "cancel-enrollment"].includes(proof.action) !== provisional) throw new ConnectFault("INVALID_PROOF", 403)
    if (proof.action === "enroll") {
      const payload = parse(z.object({ name, protocol: z.literal(CONNECT_PROTOCOL) }).strict(), proof.payload)
      registry.limited(`enroll:${peer}`, 10, 3_600)
      registry.limited("enroll:global", 100, 3_600)
      const entry = registry.createEnrollment(key, payload.name)
      return json({ id: entry.id, expiresAt: entry.expiresAt, verificationUrl: `${centralOrigin}/bind?enrollment=${entry.id}` })
    }
    if (proof.action === "claim") {
      const { enrollmentId } = parse(z.object({ enrollmentId: id }).strict(), proof.payload)
      const host = registry.claimEnrollment(enrollmentId, key)
      return json(host ? { state: "bound", hostId: host.id, name: host.name, email: host.email, epoch: host.epoch,
        gatewayPublicKey: keys.publicKey, url: registry.hostOrigin(host.id) } : { state: "pending" })
    }
    if (proof.action === "cancel-enrollment") {
      const { enrollmentId } = parse(z.object({ enrollmentId: id }).strict(), proof.payload)
      registry.cancelEnrollment(enrollmentId, key)
      return json({ success: true })
    }
    const host = registry.requireHost(proof.subject)
    if (proof.action === "connect") {
      const payload = parse(z.object({ instanceId: id, protocol: z.literal(CONNECT_PROTOCOL) }).strict(), proof.payload)
      const connection = registry.openConnection(host.id, payload.instanceId)
      return json({ ...connection, epoch: host.epoch, gatewayPublicKey: keys.publicKey, hostOrigin: registry.hostOrigin(host.id),
        tunnel: { hostname: tunnel.hostname, port: Number(tunnel.port || (tunnel.protocol === "https:" ? 443 : 80)), protocol: tunnel.protocol === "https:" ? "wss" : "websocket" }, protocol: CONNECT_PROTOCOL })
    }
    if (proof.action === "heartbeat") {
      const payload = parse(z.object({ instanceId: id, generation: z.number().int().positive(), leases: z.array(z.string().max(16_384)).max(32).default([]), name: name.optional() }).strict(), proof.payload)
      registry.heartbeat(host.id, payload.instanceId, payload.generation)
      if (payload.name && payload.name !== host.name) registry.rename(host.id, host.ownerId, payload.name)
      const leases: { id: string; token: string }[] = []
      for (const token of payload.leases) {
        const lease = verifyLease(token, keys.publicKey)
        if (!lease || lease.hostId !== host.id) continue
        const renewed = registry.renewLease(lease, auth.identityById)
        if (renewed) leases.push({ id: lease.id, token: signLease(renewed, keys.privateKey) })
      }
      return json({ state: registry.publicHost(host).online ? "online" : "connecting", leases })
    }
    if (proof.action === "pause" || proof.action === "resume") registry.setPaused(host.id, proof.action === "pause")
    else if (proof.action === "unbind") registry.revokeHost(host.id)
    else if (proof.action === "rotate") {
      const payload = parse(z.object({ publicKey: z.string().length(59) }).strict(), proof.payload)
      registry.rotateKey(host.id, payload.publicKey)
    }
    return json({ success: true })
  }

  return {
    auth, registry, relay,
    hostId: (request: Request) => registry.hostIdForAuthority(new URL(request.url).host) ?? previews.target(new URL(request.url).host)?.hostId ?? null,
    async central(request: Request, peer: string): Promise<Response | null> {
      const route = new URL(request.url).pathname
      try {
        if (route.startsWith("/api/connect/device/")) return await device(request, peer)
        if (!route.startsWith("/api/connect/")) return null
        if (["/api/connect/request-code", "/api/connect/verify-code", "/api/connect/session", "/api/connect/logout"].includes(route)) return await auth.handle(request, peer)
        checkBrowserRequest(request, centralOrigin)
        registry.limited(`browser:${peer}`, 240, 60)
        if (route.startsWith("/api/connect/enrollments/") && request.method === "GET") {
          const enrollmentId = parse(id, route.slice("/api/connect/enrollments/".length))
          const entry = registry.pendingEnrollment(enrollmentId)
          return json({ id: entry.id, name: entry.name, fingerprint: entry.publicKey.slice(-8), expiresAt: entry.expiresAt })
        }
        const identity = await authenticated(request)
        if (route === "/api/connect/hosts" && request.method === "GET") return json({ hosts: registry.hosts(identity.userId) })
        if (route === "/api/connect/authorize" && request.method === "POST") {
          const { flow } = parse(z.object({ flow: id }).strict(), await jsonBody(request))
          const redirect = registry.authorizeFlow(flow, identity)
          return json({ redirect, hostId: registry.flow(flow).hostId })
        }
        const rename = /^\/api\/connect\/hosts\/([a-f0-9]{32})\/rename$/.exec(route)
        if (rename && request.method === "POST") { const input = parse(z.object({ name }).strict(), await jsonBody(request)); registry.rename(rename[1]!, identity.userId, input.name); return json({ success: true }) }
        return json({ error: "NOT_FOUND" }, 404)
      } catch (error) { return faultResponse(error) }
    },
    async host(request: Request, server: Server<RelaySocket>): Promise<Response | undefined> {
      const url = new URL(request.url)
      if (previews.target(url.host)) {
        try { return await previews.handle(request, server) } catch (error) { return faultResponse(error) }
      }
      const hostId = registry.hostIdForAuthority(url.host)
      if (!hostId) return json({ error: "NOT_FOUND" }, 404)
      const origin = registry.hostOrigin(hostId)
      try {
        if (request.headers.has("host") && request.headers.get("host") !== new URL(origin).host) throw new ConnectFault("INVALID_HOST", 403)
        if (url.pathname === "/_connect/login" && request.method === "GET") {
          registry.requireHost(hostId) // unknown wildcard names never allocate budgets/flows
          registry.limited(`flow:${hostId}`, 60, 60)
          const flow = registry.newFlow(hostId, safeRelativePath(url.searchParams.get("return")))
          return redirect(`${centralOrigin}/authorize?flow=${flow.id}`, new Headers({ "Set-Cookie": cookie(origin, "flow", flow.verifier, 600) }))
        }
        if (url.pathname === "/_connect/callback" && request.method === "GET") {
          const exchange = registry.exchangeFlow(url.searchParams.get("flow") ?? "", hostId,
            cookieValue(request, cookieName(origin, "flow")), url.searchParams.get("code") ?? "", url.searchParams.get("state") ?? "", auth.identityById)
          const headers = new Headers()
          headers.append("Set-Cookie", cookie(origin, "flow", "", 0))
          headers.append("Set-Cookie", cookie(origin, "host-session", exchange.token, exchange.persistent ? (exchange.expiresAt - Date.now()) / 1_000 : undefined))
          return redirect(exchange.returnPath, headers)
        }
        const assetRequest = url.pathname.startsWith(REMOTE_PREVIEW_ASSET_PREFIX)
        const resource = assetRequest && ["GET", "HEAD"].includes(request.method) ? previewResources.resolve(url.pathname) : null
        const resourceSession = resource ? previewSessions.get(resource.context) : null
        if (assetRequest && (!resourceSession || resourceSession.hostId !== hostId)) throw new ConnectFault("PREVIEW_EXPIRED", 403)
        if (!assetRequest) checkBrowserRequest(request, origin)
        const session = resourceSession?.session ?? registry.sessionForToken(hostId, cookieValue(request, cookieName(origin, "host-session")), auth.identityById)
        const loginUrl = `${origin}/_connect/login?return=${encodeURIComponent(safeRelativePath(url.pathname + url.search))}`
        if (url.pathname === "/auth/status" && request.method === "GET") return json({ mode: "connect", enabled: true,
          authenticated: Boolean(session), cacheScope: null, loginUrl: `${origin}/_connect/login`, portalUrl: centralOrigin,
          ...(session ? { host: registry.publicHost(registry.requireHost(hostId)) } : {}) })
        if (!session) {
          if (["GET", "HEAD"].includes(request.method) && !url.pathname.startsWith("/api/") && !url.pathname.startsWith("/auth/") && url.pathname !== "/ws") return redirect(loginUrl)
          throw new ConnectFault("AUTH_REQUIRED", 401)
        }
        if (["/auth/logout", "/_connect/logout"].includes(url.pathname) && request.method === "POST") {
          registry.revokeParent(session.parentId)
          auth.revokeById(session.parentId)
          // Sibling cookies cannot be erased here. Their server-side parent is
          // revoked. Do not erase a newer central cookie on the completion page.
          const headers = new Headers({ "Set-Cookie": cookie(origin, "host-session", "", 0) })
          return url.pathname === "/_connect/logout" ? redirect(`${centralOrigin}/logout/complete`, headers)
            : json({ success: true, logoutUrl: `${centralOrigin}/logout/complete` }, 200, headers)
        }
        if (url.pathname === "/_connect/hosts" && request.method === "GET") return json({ hosts: registry.hosts(session.ownerId), currentHostId: hostId })
        const dynamicPreview = parseConnectPreviewPath(url.pathname, CONNECT_PREVIEW_START_PREFIX)
        if (url.pathname === CONNECT_PREVIEW_UNSUPPORTED_PATH && request.method === "GET") return previews.unsupported(hostId)
        if (dynamicPreview && request.method === "GET") {
          // A development app on a sibling origin cannot create grants for
          // other ports by navigating a popup with the user's host cookie.
          if (["same-site", "cross-site"].includes(request.headers.get("sec-fetch-site") ?? "")) throw new ConnectFault("INVALID_ORIGIN", 403)
          return previews.start(session, dynamicPreview.port, dynamicPreview.path + url.search)
        }
        // Development apps must never execute on StillOn's session origin.
        if (url.pathname.startsWith(CONNECT_PREVIEW_PROXY_PREFIX) || url.pathname.startsWith(BROWSER_PREVIEW_PROXY_PREFIX)) throw new ConnectFault("LOCAL_ONLY", 403)
        if ((!assetRequest && url.pathname.startsWith("/_connect/")) || url.pathname.startsWith("/auth/") || url.pathname.startsWith("/api/connect-local/") || url.pathname.startsWith("/_stillon/")) throw new ConnectFault("LOCAL_ONLY", 403)
        registry.limited(`traffic:${session.ownerId}`, 1_200, 60)
        if (!registry.publicHost(registry.requireHost(hostId)).online && ["GET", "HEAD"].includes(request.method)
          && request.headers.get("accept")?.includes("text/html")) return offlinePage(hostId, request.method === "HEAD")
        const previewUrl = resource ? new URL(resource.path + url.search, url) : url
        if (resource) previewUrl.searchParams.set("preview-root", resource.context.directory)
        const lease = registry.makeLease(session, request.method, previewUrl.pathname + previewUrl.search)
        const headers = forwardingHeaders(request)
        if (projectPreviewTarget(previewUrl.pathname)) headers.set("accept-encoding", "identity")
        headers.set("host", new URL(origin).host)
        headers.set("x-stillon-connect-lease", signLease(lease, keys.privateKey))
        const scope = { hostId, parentId: session.parentId, ownerId: session.ownerId,
          valid: () => registry.validSession(session, auth.identityById) && !registry.requireHost(hostId).paused }
        const target = new URL(transport)
        target.pathname = previewUrl.pathname; target.search = previewUrl.search
        if (url.pathname === "/ws") { target.protocol = "ws:"; return await relay.upgrade(request, server, target.href, headers, scope) }
        const response = await relay.http(request, target.href, headers, scope)
        if (resource) return await previewResources.wrap(response, request, resource.context, resource.filePath)
        const preview = projectPreviewTarget(url.pathname)
        if (preview && response.ok && response.headers.get("content-type")?.includes("text/html")) {
          const context = previewResources.create(preview.projectId, preview.filePath, scope.valid)
          previewSessions.set(context, { hostId, session })
          return await previewResources.wrap(response, request, context, preview.filePath)
        }
        return response
      } catch (error) { return faultResponse(error) }
    },
    async plugin(request: Request) {
      // This handler is mounted on a separate loopback listener, never the
      // public Connect server. Deny unknown hooks and every unregistered route.
      try {
        const op = new URL(request.url).searchParams.get("op")
        if (request.method !== "POST" || !op || !["Login", "NewProxy", "Ping", "NewWorkConn"].includes(op)) throw new Error("Invalid hook")
        const body = await jsonBody(request, 32_768) as { content?: Record<string, unknown> }
        const content = body.content ?? {}
        const user = typeof content.user === "string" ? { user: content.user, metas: content.metas, run_id: content.run_id } : content.user as Record<string, unknown>
        if (!user || typeof user.user !== "string" || !user.metas || typeof user.metas !== "object") throw new Error("Invalid identity")
        const token = (user.metas as Record<string, unknown>).connect_token
        if (typeof token !== "string" || token.length !== 43 || !registry.frpCredential(user.user, token, String(user.run_id ?? ""), op)) throw new Error("Invalid identity")
        if (op === "NewProxy") {
          const domains = content.custom_domains
          if (content.proxy_type !== "http" || content.proxy_name !== `${user.user}.tunnel`
            || !Array.isArray(domains) || domains.length !== 1 || domains[0] !== new URL(registry.hostOrigin(user.user)).hostname
            || (Array.isArray(content.locations) && content.locations.length !== 0) || content.subdomain || content.host_header_rewrite
            || content.http_user || content.http_pwd || (content.headers && Object.keys(content.headers as object).length)) throw new Error("Invalid route")
        }
        return json({ reject: false, unchange: true })
      } catch { return json({ reject: true, reject_reason: "Access denied", unchange: true }) }
    },
    close() { previews.close(); previewResources.clear(); relay.stop(); auth.close(); registry.close() },
  }
}
