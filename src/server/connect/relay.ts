import type { Server, ServerWebSocket } from "bun"
import { CONNECT_MAX_STREAMS, CONNECT_MAX_WS_BYTES } from "../../shared/connect"
import { randomId } from "./crypto"
import { isConnectCookie } from "../../shared/connect-preview"
import { canCacheBuildAsset, PRIVATE_BUILD_ASSET_CACHE } from "../../shared/public-asset-cache"
import { RelayQueue } from "./relay-queue"

export interface RelayScope { hostId: string; parentId: string; ownerId: string; valid: () => boolean; finished?: () => void; onActivity?: (message: string | Buffer) => void }
/** Numeric observations only; observers never receive payloads or identities. */
export interface RelayObserver {
  bytes(direction: "upload" | "download", bytes: number, transport: "http" | "websocket"): void
  websocket(event: "open" | "close" | "error"): void
}
interface ActiveStream { scope: RelayScope; close: (failed?: boolean) => void }
export interface RelaySocket {
  upstream: WebSocket
  downstream?: ServerWebSocket<RelaySocket>
  scope: RelayScope
  id: string
  closed: boolean
  opened?: boolean
  toDownstream?: RelayQueue
  toUpstream?: RelayQueue
}
const BUFFER_LIMIT = 2 * CONNECT_MAX_WS_BYTES
const HOP_HEADERS = ["connection", "keep-alive", "proxy-connection", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]

// lib.dom owns the global type in this mixed client/server project. Bun adds
// authenticated upstream headers to its native WebSocket constructor.
export function upstreamWebSocket(url: string, headers: Headers, protocols: string[] = []) {
  const Client = globalThis.WebSocket as unknown as { new(url: string, options: Bun.WebSocketOptions): WebSocket }
  return new Client(url, { protocols, headers: Object.fromEntries(headers) })
}

export function forwardingHeaders(request: Request, applicationCredentials = false) {
  const headers = new Headers(request.headers)
  for (const name of [...headers.keys()]) {
    if (HOP_HEADERS.includes(name) || name === "host" || (!applicationCredentials && (name === "cookie" || name === "authorization"))
      || name.startsWith("x-stillon-") || name.startsWith("x-forwarded-") || name === "forwarded" || name === "x-real-ip" || name.startsWith("cf-")) headers.delete(name)
  }
  if (applicationCredentials && headers.has("cookie")) {
    const cookies = headers.get("cookie")!.split(";").map(value => value.trim())
      .filter(value => value.includes("=") && !isConnectCookie(value.slice(0, value.indexOf("="))))
    if (cookies.length) headers.set("cookie", cookies.join("; "))
    else headers.delete("cookie")
  }
  return headers
}

function copyApplicationCookies(upstream: Headers, outgoing: Headers) {
  for (const value of upstream.getSetCookie()) {
    const name = value.slice(0, value.indexOf("=")).trim()
    if (!name || isConnectCookie(name)) continue
    // Applications get host-only preview cookies, never cookies for Connect's
    // parent domain or another computer.
    outgoing.append("set-cookie", value.split(";").filter(part => !/^\s*domain\s*=/i.test(part)).join(";"))
  }
}

/** HTTP/WebSocket relay only. frp owns the tunnel framing and multiplexing. */
export class ConnectRelay {
  private readonly streams = new Map<string, ActiveStream>()
  private readonly timer: ReturnType<typeof setInterval>
  constructor(private readonly timingStage: "relay" | "gateway-upstream" | "adapter-upstream" = "relay", private readonly observer?: RelayObserver) {
    this.timer = setInterval(() => {
      for (const stream of this.streams.values()) { if (!this.valid(stream.scope)) stream.close() }
    }, 1_000)
    this.timer.unref()
  }
  private bytes(direction: "upload" | "download", bytes: number, transport: "http" | "websocket") {
    // Monitoring must never interrupt or retain the traffic it observes.
    try { if (bytes > 0) this.observer?.bytes(direction, bytes, transport) } catch { /* Observer unavailable. */ }
  }
  private socketEvent(event: "open" | "close" | "error") {
    try { this.observer?.websocket(event) } catch { /* Observer unavailable. */ }
  }
  private valid(scope: RelayScope) { try { return scope.valid() } catch { return false } }
  private reserve(scope: RelayScope, close: (failed?: boolean) => void) {
    if (!this.valid(scope)) throw new Error("ACCESS_REVOKED")
    if (this.streams.size >= 256 || [...this.streams.values()].filter(s => s.scope.ownerId === scope.ownerId).length >= CONNECT_MAX_STREAMS) throw new Error("CONNECTION_LIMIT")
    const id = randomId(); this.streams.set(id, { scope, close }); return id
  }
  invalidate(scope: { hostId?: string; parentId?: string }) {
    for (const stream of [...this.streams.values()]) {
      if ((!scope.hostId || stream.scope.hostId === scope.hostId) && (!scope.parentId || stream.scope.parentId === scope.parentId)) stream.close()
    }
  }
  get activeCount() { return this.streams.size }
  stop() { clearInterval(this.timer); this.invalidate({}); this.streams.clear() }

  async http(request: Request, target: string, headers: Headers, scope: RelayScope, transform?: (response: Response) => Response, applicationCookies = false) {
    const controller = new AbortController()
    let id = ""
    let finished = false
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    const cancel = () => close()
    const finish = () => {
      if (finished) return
      finished = true; this.streams.delete(id); request.signal.removeEventListener("abort", cancel); scope.finished?.()
    }
    const close = () => { controller.abort(); void reader?.cancel().catch(() => {}); finish() }
    try { id = this.reserve(scope, close) } catch (error) { finish(); throw error }
    request.signal.addEventListener("abort", cancel, { once: true })
    try {
      // An aborted browser request must not leave a partially consumed HTTP
      // exchange in Bun 1.3's private-hop pool for the next static module.
      const upstreamHeaders = new Headers(headers)
      upstreamHeaders.set("connection", "close")
      const upstreamStartedAt = performance.now()
      const body = ["GET", "HEAD"].includes(request.method) ? undefined : request.body
      const measuredBody = body && this.observer ? body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform: (chunk, controller) => { this.bytes("upload", chunk.byteLength, "http"); controller.enqueue(chunk) },
      })) : body
      const upstream = await fetch(target, { method: request.method, headers: upstreamHeaders, keepalive: false,
        body: measuredBody,
        signal: AbortSignal.any([request.signal, controller.signal]), redirect: "manual", decompress: false,
      })
      const outgoing = new Headers(upstream.headers)
      const cacheableAsset = canCacheBuildAsset(request, upstream.status, upstream.headers, applicationCookies)
      outgoing.append("Server-Timing", `${this.timingStage};dur=${Math.max(0, performance.now() - upstreamStartedAt).toFixed(2)}`)
      for (const name of HOP_HEADERS) if (name !== "content-length") outgoing.delete(name)
      outgoing.delete("set-cookie"); outgoing.delete("set-cookie2")
      if (applicationCookies) copyApplicationCookies(upstream.headers, outgoing)
      outgoing.set("Cache-Control", cacheableAsset ? PRIVATE_BUILD_ASSET_CACHE : "no-store")
      outgoing.set("Referrer-Policy", "no-referrer")
      if (!upstream.body || request.method === "HEAD") { finish(); return new Response(null, { status: upstream.status, headers: outgoing }) }
      // This hop writes a new stream. Let Bun frame it rather than retaining
      // another hop's message length; compressed bytes/Content-Encoding stay
      // paired because fetch above explicitly disables decompression.
      outgoing.delete("content-length")
      reader = upstream.body.getReader()
      // Bun 1.3.14 can crash when a client aborts a default async-pull HTTP
      // body (oven-sh/bun#32111). Its direct sink avoids that controller path
      // while still flushing incrementally and waiting for backpressure.
      const source: Bun.DirectUnderlyingSource<Uint8Array> = {
        type: "direct",
        pull: async (output) => {
          try {
            while (true) {
              if (!this.valid(scope) || controller.signal.aborted) throw new Error("ACCESS_REVOKED")
              const chunk = await reader!.read()
              if (!this.valid(scope) || controller.signal.aborted) throw new Error("ACCESS_REVOKED")
              if (chunk.done) { finish(); output.close(); return }
              await output.write(chunk.value)
              this.bytes("download", chunk.value.byteLength, "http")
              await output.flush()
            }
          } catch {
            close()
            try { output.close(new Error("Connection interrupted")) } catch { /* Destination already closed. */ }
          }
        },
        cancel: close,
      }
      // lib.dom's constructor does not declare Bun's native direct source.
      const stream = new ReadableStream<Uint8Array>(source as unknown as UnderlyingSource<Uint8Array>, { highWaterMark: 64 * 1024 })
      const response = new Response(stream, { status: upstream.status, headers: outgoing })
      return transform ? transform(response) : response
    } catch { close(); finish(); return Response.json({ error: "CONNECTION_UNAVAILABLE" }, { status: 503, headers: { "Cache-Control": "no-store" } }) }
  }

  async upgrade(request: Request, server: Server<RelaySocket>, target: string, headers: Headers, scope: RelayScope) {
    const data: RelaySocket = { upstream: null as unknown as WebSocket, scope, id: "", closed: false }
    const close = (failed = false) => {
      if (data.closed) return
      data.closed = true
      if (failed) this.socketEvent("error")
      if (data.opened) this.socketEvent("close")
      data.toDownstream?.dispose()
      data.toUpstream?.dispose()
      this.streams.delete(data.id)
      scope.finished?.()
      if (data.upstream) {
        const terminate = (data.upstream as unknown as { terminate?: () => void }).terminate
        if (terminate) terminate.call(data.upstream)
        else data.upstream.close(1000, "Connection closed")
      }
      data.downstream?.terminate()
    }
    try { data.id = this.reserve(scope, close) } catch (error) { close(); throw error }
    try {
      const protocols = (headers.get("sec-websocket-protocol") ?? "").split(",").map(value => value.trim()).filter(Boolean)
      // The browser's upgrade headers are not valid for a new handshake.
      for (const name of [...headers.keys()]) if (name.startsWith("sec-websocket-") || HOP_HEADERS.includes(name)) headers.delete(name)
      const upstream = upstreamWebSocket(target, headers, protocols)
      data.upstream = upstream; upstream.binaryType = "arraybuffer"
      data.toDownstream = new RelayQueue({
        write: message => {
          if (!data.downstream || data.downstream.send(message) === 0) return false
          this.bytes("download", typeof message === "string" ? Buffer.byteLength(message) : message.byteLength, "websocket")
          return true
        },
        buffered: () => data.downstream?.getBufferedAmount() ?? 0,
        highWaterMark: BUFFER_LIMIT, fail: () => close(true),
      })
      data.toUpstream = new RelayQueue({
        write: message => {
          if (upstream.readyState !== WebSocket.OPEN) return false
          upstream.send(typeof message === "string" ? message : new Uint8Array(message))
          this.bytes("upload", typeof message === "string" ? Buffer.byteLength(message) : message.byteLength, "websocket")
          return true
        },
        buffered: () => upstream.bufferedAmount,
        highWaterMark: BUFFER_LIMIT, fail: () => close(true),
      })
      upstream.addEventListener("message", event => {
        if (!this.valid(scope) || data.closed) { close(); return }
        const message = event.data as string | ArrayBuffer
        const length = typeof message === "string" ? Buffer.byteLength(message) : message.byteLength
        if (length > CONNECT_MAX_WS_BYTES) { close(true); return }
        data.toDownstream!.push(message)
      })
      upstream.addEventListener("close", event => close(![1000, 1001, 1005].includes(event.code)))
      upstream.addEventListener("error", () => close(true))
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { close(true); reject(new Error("Connection timeout")) }, 10_000)
        upstream.addEventListener("open", () => { clearTimeout(timer); resolve() }, { once: true })
        upstream.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Connection failed")) }, { once: true })
        upstream.addEventListener("close", () => { clearTimeout(timer); reject(new Error("Connection closed")) }, { once: true })
      })
      if (data.closed || !this.valid(scope)) throw new Error("ACCESS_REVOKED")
      if (server.upgrade(request, { data, headers: upstream.protocol ? { "Sec-WebSocket-Protocol": upstream.protocol } : undefined })) return undefined
      close(true); return new Response("Upgrade failed", { status: 400 })
    } catch { close(true); return Response.json({ error: "CONNECTION_UNAVAILABLE" }, { status: 503 }) }
  }
  readonly websocket = {
    maxPayloadLength: CONNECT_MAX_WS_BYTES,
    backpressureLimit: BUFFER_LIMIT,
    closeOnBackpressureLimit: false,
    idleTimeout: 120,
    open: (ws: ServerWebSocket<RelaySocket>) => {
      const data = ws.data
      if (data.closed || !this.valid(data.scope)) { ws.close(1008); return }
      data.downstream = ws
      data.opened = true
      this.socketEvent("open")
      data.toDownstream?.flush()
    },
    message: (ws: ServerWebSocket<RelaySocket>, message: string | Buffer) => {
      const data = ws.data
      if (data.closed || !this.valid(data.scope) || data.upstream.readyState !== WebSocket.OPEN) {
        this.streams.get(data.id)?.close(); return
      }
      data.scope.onActivity?.(message)
      data.toUpstream?.push(message)
    },
    drain: (ws: ServerWebSocket<RelaySocket>) => { ws.data.toDownstream?.flush() },
    close: (ws: ServerWebSocket<RelaySocket>, code = 1000) => { this.streams.get(ws.data.id)?.close(![1000, 1001, 1005].includes(code)) },
  }
}
