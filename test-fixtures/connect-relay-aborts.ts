import { ConnectRelay, forwardingHeaders } from "../src/server/connect/relay"
import { brotliCompressSync, gzipSync } from "node:zlib"

const relay = new ConnectRelay()
const bytes = new Uint8Array(4096).fill(71)
let valid = true
const connectionProbe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request, server) {
  return Response.json({ port: server.requestIP(request)?.port })
} })
const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const pathname = new URL(request.url).pathname, long = pathname === "/long"
  if (pathname === "/gzip" || pathname === "/br") {
    const body = (pathname === "/gzip" ? gzipSync : brotliCompressSync)(Buffer.from("export const value = 'fixture';\n".repeat(128)))
    return new Response(body, { headers: { "Content-Type": "text/javascript; charset=utf-8", "Content-Encoding": pathname.slice(1), "Content-Length": String(body.byteLength) } })
  }
  const source: Bun.DirectUnderlyingSource = {
    type: "direct",
    async pull(output) {
      if (pathname === "/large") {
        for (let i = 0; i < 256; i++) { await output.write(bytes); await output.flush() }
        output.close()
        return
      }
      if (long) {
        for (let i = 0; i < 100; i++) {
          if (!await output.write(bytes)) break
          await output.flush()
          await Bun.sleep(20)
        }
        output.close()
        return
      }
      output.write(bytes.subarray(0, 1))
      await output.flush()
      await Bun.sleep(2)
      output.write(bytes.subarray(1))
      output.close()
    },
  }
  return new Response(new ReadableStream(source as unknown as UnderlyingSource<Uint8Array>))
} })
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const pathname = new URL(request.url).pathname
  if (pathname === "/state") return Response.json({ active: relay.activeCount })
  if (pathname === "/revoke") { valid = false; relay.invalidate({ parentId: "fixture-parent" }); return Response.json({ ok: true }) }
  try {
    return await relay.http(request, `http://127.0.0.1:${pathname === "/connection" ? connectionProbe.port : upstream.port}${pathname}`, forwardingHeaders(request), {
      ownerId: "fixture-owner", hostId: "fixture-host", parentId: "fixture-parent", valid: () => valid,
    })
  } catch (error) {
    // Aborted clients may briefly overlap pending cleanup on fast runners.
    // The application handles this capacity error as an HTTP response too.
    if (error instanceof Error && error.message === "CONNECTION_LIMIT") return new Response("Relay capacity reached", { status: 503 })
    throw error
  }
} })
console.log(JSON.stringify({ origin: `http://127.0.0.1:${server.port}` }))
await Bun.stdin.text()
relay.stop()
await server.stop(true)
await upstream.stop(true)
await connectionProbe.stop(true)
