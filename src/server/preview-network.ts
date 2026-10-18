import http from "node:http"
import net from "node:net"
import tls from "node:tls"
import { lookup } from "node:dns/promises"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { isLoopbackPreviewHost } from "../shared/browser-preview-proxy"
import { protectPreviewPort, releasePreviewPort } from "./preview-ports"
import { readPreviewServiceIdentity, PreviewServiceUnavailableError } from "./local-http-servers"

export function isPublicPreviewAddress(address: string) {
  // Conservative HTTP policy from IANA's IPv4/IPv6 special-purpose registries:
  // https://www.iana.org/assignments/iana-ipv4-special-registry/
  // https://www.iana.org/assignments/iana-ipv6-special-registry/
  if (net.isIPv4(address)) {
    const [a, b, c] = address.split(".").map(Number) as [number, number, number]
    return !([0, 10, 127].includes(a) || a >= 224 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 && [0, 2].includes(c) || b === 88 && c === 99))
      || (a === 100 && b >= 64 && b <= 127) || (a === 198 && ([18, 19].includes(b) || b === 51 && c === 100))
      || (a === 203 && b === 0 && c === 113))
  }
  // Restrict IPv6 to global unicast; exclude IPv4-mapped, local, multicast,
  // documentation and translation ranges rather than trusting hostname syntax.
  if (!net.isIPv6(address)) return false
  const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1)
  const [first, secondText] = normalized.split(":")
  const second = parseInt(secondText || "0", 16)
  return /^[23][0-9a-f]{3}:/iu.test(normalized) && first !== "2002"
    && !(first === "2001" && (second < 0x200 || second === 0xdb8))
    && !(first === "3fff" && second < 0x1000)
}

export async function resolvePreviewNetworkTarget(url: URL, blocked: Iterable<number>, loopbackOrigin?: string) {
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Preview protocol is not allowed")
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80))
  if ([...blocked].includes(port)) throw new Error("StillOn control services cannot be previewed")
  const hostname = url.hostname.replace(/^\[|\]$/gu, "")
  if (isLoopbackPreviewHost(hostname)) {
    if (!loopbackOrigin || new URL(loopbackOrigin).origin !== url.origin) throw new Error("This local service has not been authorized")
    const values = await lookup(hostname, { all: true })
    if (!values.length || values.some(value => !["::1", "127.0.0.1"].includes(value.address))) throw new Error("Invalid loopback resolution")
    if (values.length === 1) return { address: values[0]!.address, port }
    for (const value of values) {
      const listening = await new Promise<boolean>(resolve => {
        const socket = net.connect({ host: value.address, port })
        const finish = (result: boolean) => { socket.destroy(); resolve(result) }
        socket.setTimeout(300, () => finish(false)); socket.once("connect", () => finish(true)); socket.once("error", () => finish(false))
      })
      if (listening) return { address: value.address, port }
    }
    throw new Error("The local web service is unavailable")
  }
  const values = await lookup(hostname, { all: true })
  if (!values.length || values.some(item => !isPublicPreviewAddress(item.address))) throw new Error("Private network destinations are not allowed")
  return { address: (values.find(value => net.isIPv4(value.address)) ?? values[0])!.address, port }
}

/** Chromium's only network path. DNS is checked and the socket connects to that
 * exact address, so redirects and DNS rebinding cannot reach private services. */
export async function createPreviewNetworkProxy(blocked: () => Iterable<number>, loopbackOrigin?: string, denyNetwork = false) {
  const username = "preview", password = randomBytes(24).toString("base64url")
  const expected = Buffer.from("Basic " + Buffer.from(username + ":" + password).toString("base64"))
  const sockets = new Set<net.Socket>()
  let closed = false
  let grantedIdentity: string | undefined, readingIdentity: Promise<string> | undefined, grantGeneration = 0
  const resolveTarget = async (url: URL) => {
    if (denyNetwork) throw new Error("File previews cannot access external services")
    const destination = await resolvePreviewNetworkTarget(url, blocked(), loopbackOrigin)
    if (["127.0.0.1", "::1"].includes(destination.address)) {
      const generation = grantGeneration
      // Coalesce concurrent resource checks, without caching an old listener.
      if (!readingIdentity) {
        const reading = readPreviewServiceIdentity(destination.port).finally(() => { if (readingIdentity === reading) readingIdentity = undefined })
        readingIdentity = reading
      }
      const identity = await readingIdentity
      if (generation !== grantGeneration || (grantedIdentity && identity !== grantedIdentity)) throw new Error("The local service changed. Retry to authorize it again.")
      grantedIdentity = identity
    }
    return destination
  }
  async function connect(destination: { address: string; port: number }, protocol: string) {
    if (closed) throw new Error("Preview network is closed")
    // Respect the service's existing egress proxy without letting it resolve
    // arbitrary app-controlled hostnames. CONNECT always uses the checked IP.
    const configured = ["127.0.0.1", "::1"].includes(destination.address) ? undefined
      : protocol === "https:" ? process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.ALL_PROXY
        : process.env.HTTP_PROXY ?? process.env.http_proxy ?? process.env.ALL_PROXY
    const proxy = configured ? new URL(configured) : undefined
    if (proxy && !["http:", "https:"].includes(proxy.protocol)) throw new Error("The preview egress proxy must use HTTP or HTTPS.")
    return new Promise<net.Socket>((resolve, reject) => {
      const socket = proxy?.protocol === "https:" ? tls.connect({ host: proxy.hostname, port: Number(proxy.port || 443), servername: proxy.hostname })
        : net.connect({ host: proxy?.hostname ?? destination.address, port: proxy ? Number(proxy.port || 80) : destination.port })
      sockets.add(socket); socket.on("close", () => sockets.delete(socket))
      const timer = setTimeout(() => { socket.destroy(); reject(new Error("Preview connection timed out")) }, 10_000)
      socket.once("error", error => { clearTimeout(timer); reject(error) })
      socket.once(proxy?.protocol === "https:" ? "secureConnect" : "connect", () => {
        if (!proxy) { clearTimeout(timer); resolve(socket); return }
        const authority = (net.isIPv6(destination.address) ? `[${destination.address}]` : destination.address) + ":" + destination.port
        const credential = proxy.username || proxy.password ? "Proxy-Authorization: Basic " + Buffer.from(decodeURIComponent(proxy.username) + ":" + decodeURIComponent(proxy.password)).toString("base64") + "\r\n" : ""
        let response = Buffer.alloc(0)
        const read = (chunk: Buffer) => {
          response = Buffer.concat([response, chunk])
          if (response.length > 16 * 1024) { socket.destroy(); clearTimeout(timer); reject(new Error("Invalid egress proxy response")); return }
          const end = response.indexOf("\r\n\r\n")
          if (end < 0) return
          socket.off("data", read); clearTimeout(timer)
          if (!/^HTTP\/1\.[01] 200\b/u.test(response.toString("ascii", 0, end))) { socket.destroy(); reject(new Error("The configured egress proxy refused the preview connection")); return }
          if (response.length > end + 4) socket.unshift(response.subarray(end + 4))
          resolve(socket)
        }
        socket.on("data", read)
        socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${credential}\r\n`)
      })
    })
  }
  const authorized = (request: http.IncomingMessage) => {
    const value = Buffer.from(request.headers["proxy-authorization"] ?? "")
    return value.length === expected.length && timingSafeEqual(value, expected)
  }
  const server = http.createServer(async (request, response) => {
    if (!authorized(request)) { response.writeHead(407, { "Proxy-Authenticate": 'Basic realm="Preview"' }); response.end(); return }
    try {
      const url = new URL(request.url!)
      if (url.protocol !== "http:") throw new Error("Use CONNECT for HTTPS")
      const destination = await resolveTarget(url)
      // Bun ignores ClientRequest.createConnection. The localhost workaround
      // below is confined to an explicitly granted loopback port; never apply
      // it to a public IPv6 destination.
      if (net.isIPv6(destination.address) && destination.address !== "::1") {
        response.writeHead(501, { "X-StillOn-Preview-Transport": "unsupported" })
        response.end("Public IPv6-only HTTP previews are unavailable. Use HTTPS or IPv4.")
        return
      }
      const headers: http.OutgoingHttpHeaders = { ...request.headers, host: url.host }
      delete headers["proxy-authorization"]; delete headers["proxy-connection"]
      const upstream = http.request({ hostname: net.isIPv6(destination.address) ? "localhost" : destination.address,
        port: destination.port, path: url.pathname + url.search, method: request.method, headers, agent: false,
        createConnection: (_options, callback) => { void connect(destination, url.protocol).then(socket => callback(null, socket), error => callback(error, undefined as any)); return undefined as any },
      }, result => {
        response.writeHead(result.statusCode ?? 502, result.headers); result.pipe(response)
      })
      upstream.setTimeout(10_000, () => upstream.destroy(new Error("Preview request timed out")))
      upstream.on("error", () => { if (!response.headersSent) response.writeHead(502, { "X-StillOn-Preview-Transport": "unavailable" }); response.end("Preview service unavailable") })
      response.on("close", () => upstream.destroy())
      request.pipe(upstream)
    } catch (error) {
      const unavailable = error instanceof PreviewServiceUnavailableError
      response.writeHead(unavailable ? 502 : 403, { "X-StillOn-Preview-Transport": unavailable ? "unavailable" : "denied" }); response.end(unavailable ? "Preview service unavailable" : "Preview destination denied")
    }
  })
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.setTimeout(120_000, () => socket.destroy()) })
  server.on("upgrade", async (request, client, head) => {
    if (!authorized(request)) { client.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n"); return }
    try {
      const url = new URL(request.url!)
      if (url.protocol === "ws:") url.protocol = "http:"
      const destination = await resolveTarget(url)
      const upstream = await connect(destination, url.protocol)
      const headers = Object.entries(request.headers).filter(([name]) => !["proxy-authorization", "proxy-connection", "host"].includes(name))
        .map(([name, value]) => name + ": " + (Array.isArray(value) ? value.join(", ") : value)).join("\r\n")
      upstream.write(`${request.method} ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\n${headers}\r\n\r\n`)
      if (head.length) upstream.write(head)
      upstream.pipe(client); client.pipe(upstream)
      upstream.on("error", () => client.destroy()); client.on("error", () => upstream.destroy()); client.on("close", () => upstream.destroy())
    } catch { client.end("HTTP/1.1 403 Forbidden\r\n\r\n") }
  })
  server.on("connect", async (request, client, head) => {
    if (!authorized(request)) { client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="Preview"\r\n\r\n'); return }
    try {
      const url = new URL("https://" + request.url)
      if (loopbackOrigin && url.host === new URL(loopbackOrigin).host) url.protocol = new URL(loopbackOrigin).protocol
      const destination = await resolveTarget(url)
      const upstream = await connect(destination, url.protocol)
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) upstream.write(head); upstream.pipe(client); client.pipe(upstream)
      upstream.on("error", () => client.destroy()); client.on("error", () => upstream.destroy()); client.on("close", () => upstream.destroy())
    } catch { client.end("HTTP/1.1 403 Forbidden\r\n\r\n") }
  })
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
  const port = (server.address() as net.AddressInfo).port
  protectPreviewPort(port)
  return { server: "http://127.0.0.1:" + port, username, password,
    reauthorize: () => { grantGeneration++; grantedIdentity = undefined; readingIdentity = undefined },
    close: () => new Promise<void>(resolve => { closed = true; for (const socket of sockets) socket.destroy(); server.close(() => { releasePreviewPort(port); resolve() }) }) }
}
