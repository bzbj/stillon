import type { Server, ServerWebSocket } from "bun"
import { CONNECT_MAX_STREAMS, CONNECT_MAX_WS_BYTES } from "../../shared/connect"
import { randomId } from "./crypto"

export interface RelayScope { hostId: string; parentId: string; ownerId: string; valid: () => boolean; finished?: () => void }
interface ActiveStream { scope: RelayScope; close: () => void }
export interface RelaySocket {
  upstream: WebSocket
  downstream?: ServerWebSocket<RelaySocket>
  scope: RelayScope
  id: string
  queued: (string | ArrayBuffer)[]
  queuedBytes: number
  closed: boolean
}
const BUFFER_LIMIT = 2 * CONNECT_MAX_WS_BYTES
const HOP_HEADERS = ["connection", "keep-alive", "proxy-connection", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]

// lib.dom owns the global type in this mixed client/server project. Bun adds
// authenticated upstream headers to its native WebSocket constructor.
export function upstreamWebSocket(url: string, headers: Headers) {
  const Client = globalThis.WebSocket as unknown as { new(url: string, options: Bun.WebSocketOptions): WebSocket }
  return new Client(url, { headers: Object.fromEntries(headers) })
}

export function forwardingHeaders(request: Request) {
  const headers = new Headers(request.headers)
  for (const name of [...headers.keys()]) {
    if (HOP_HEADERS.includes(name) || name === "host" || name === "cookie" || name === "authorization"
      || name.startsWith("x-stillon-") || name.startsWith("x-forwarded-") || name === "forwarded" || name === "x-real-ip" || name.startsWith("cf-")) headers.delete(name)
  }
  return headers
}

/** HTTP/WebSocket relay only. frp owns the tunnel framing and multiplexing. */
export class ConnectRelay {
  private readonly streams = new Map<string, ActiveStream>()
  private readonly timer: ReturnType<typeof setInterval>
  constructor() {
    this.timer = setInterval(() => {
      for (const stream of this.streams.values()) { if (!this.valid(stream.scope)) stream.close() }
    }, 1_000)
    this.timer.unref()
  }
  private valid(scope: RelayScope) { try { return scope.valid() } catch { return false } }
  private reserve(scope: RelayScope, close: () => void) {
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

  async http(request: Request, target: string, headers: Headers, scope: RelayScope, transform?: (response: Response) => Response) {
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
      const upstream = await fetch(target, { method: request.method, headers,
        body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
        signal: AbortSignal.any([request.signal, controller.signal]), redirect: "manual", decompress: false,
      })
      const outgoing = new Headers(upstream.headers)
      for (const name of HOP_HEADERS) if (name !== "content-length") outgoing.delete(name)
      outgoing.delete("set-cookie"); outgoing.delete("set-cookie2")
      outgoing.set("Cache-Control", "no-store")
      outgoing.set("Referrer-Policy", "no-referrer")
      if (!upstream.body || request.method === "HEAD") { finish(); return new Response(null, { status: upstream.status, headers: outgoing }) }
      reader = upstream.body.getReader()
      const stream = new ReadableStream<Uint8Array>({
        pull: async (output) => {
          try {
            if (!this.valid(scope) || controller.signal.aborted) throw new Error("ACCESS_REVOKED")
            const chunk = await reader!.read()
            if (!this.valid(scope) || controller.signal.aborted) throw new Error("ACCESS_REVOKED")
            if (chunk.done) { finish(); output.close() } else output.enqueue(chunk.value)
          } catch { close(); finish(); output.error(new Error("Connection interrupted")) }
        },
        cancel: async () => { close(); finish() },
      }, { highWaterMark: 1 })
      const response = new Response(stream, { status: upstream.status, headers: outgoing })
      return transform ? transform(response) : response
    } catch { close(); finish(); return Response.json({ error: "CONNECTION_UNAVAILABLE" }, { status: 503, headers: { "Cache-Control": "no-store" } }) }
  }

  async upgrade(request: Request, server: Server<RelaySocket>, target: string, headers: Headers, scope: RelayScope) {
    const data: RelaySocket = { upstream: null as unknown as WebSocket, scope, id: "", queued: [], queuedBytes: 0, closed: false }
    const close = () => {
      if (data.closed) return
      data.closed = true
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
      // The browser's upgrade headers are not valid for a new handshake.
      for (const name of [...headers.keys()]) if (name.startsWith("sec-websocket-") || HOP_HEADERS.includes(name)) headers.delete(name)
      const upstream = upstreamWebSocket(target, headers)
      data.upstream = upstream; upstream.binaryType = "arraybuffer"
      upstream.addEventListener("message", event => {
        if (!this.valid(scope) || data.closed) { close(); return }
        const message = event.data as string | ArrayBuffer
        const length = typeof message === "string" ? Buffer.byteLength(message) : message.byteLength
        if (length > CONNECT_MAX_WS_BYTES) { close(); return }
        if (!data.downstream) {
          data.queuedBytes += length
          if (data.queuedBytes > BUFFER_LIMIT) { close(); return }
          data.queued.push(message)
        } else if (data.downstream.send(message) === 0 || data.downstream.getBufferedAmount() > BUFFER_LIMIT) close()
      })
      upstream.addEventListener("close", close)
      upstream.addEventListener("error", close)
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { close(); reject(new Error("Connection timeout")) }, 10_000)
        upstream.addEventListener("open", () => { clearTimeout(timer); resolve() }, { once: true })
        upstream.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Connection failed")) }, { once: true })
        upstream.addEventListener("close", () => { clearTimeout(timer); reject(new Error("Connection closed")) }, { once: true })
      })
      if (data.closed || !this.valid(scope)) throw new Error("ACCESS_REVOKED")
      if (server.upgrade(request, { data })) return undefined
      close(); return new Response("Upgrade failed", { status: 400 })
    } catch { close(); return Response.json({ error: "CONNECTION_UNAVAILABLE" }, { status: 503 }) }
  }
  readonly websocket = {
    maxPayloadLength: CONNECT_MAX_WS_BYTES,
    backpressureLimit: BUFFER_LIMIT,
    closeOnBackpressureLimit: true,
    idleTimeout: 120,
    open: (ws: ServerWebSocket<RelaySocket>) => {
      const data = ws.data
      if (data.closed || !this.valid(data.scope)) { ws.close(1008); return }
      data.downstream = ws
      for (const message of data.queued) { if (ws.send(message) === 0) { this.streams.get(data.id)?.close(); break } }
      data.queued = []; data.queuedBytes = 0
    },
    message: (ws: ServerWebSocket<RelaySocket>, message: string | Buffer) => {
      const data = ws.data
      if (data.closed || !this.valid(data.scope) || data.upstream.readyState !== WebSocket.OPEN || data.upstream.bufferedAmount > BUFFER_LIMIT) {
        this.streams.get(data.id)?.close(); return
      }
      data.upstream.send(typeof message === "string" ? message : new Uint8Array(message))
    },
    close: (ws: ServerWebSocket<RelaySocket>) => { this.streams.get(ws.data.id)?.close() },
  }
}
