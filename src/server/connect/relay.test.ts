import { expect, test } from "bun:test"
import path from "node:path"
import { brotliCompressSync, gzipSync } from "node:zlib"
import { ConnectRelay, type RelaySocket } from "./relay"
import { CONNECT_MAX_WS_BYTES } from "../../shared/connect"

test("native relay survives client cancellations, streams incrementally and revokes active bodies", async () => {
  // Isolate native runtime failures: a Bun socket abort must fail this test,
  // rather than crash the entire repository test runner.
  const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../../../test-fixtures/connect-relay-aborts.ts")], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true,
  })
  const diagnostics = new Response(child.stderr).text()
  const deadline = setTimeout(() => { if (child.exitCode === null) child.kill() }, 20_000)
  deadline.unref()
  try {
    const reader = child.stdout.getReader(), decoder = new TextDecoder()
    let ready = ""
    while (!ready.includes("\n")) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error("Relay fixture exited before readiness: " + await diagnostics)
      ready += decoder.decode(chunk.value, { stream: true })
    }
    reader.releaseLock()
    const { origin } = JSON.parse(ready) as { origin: string }
    let completed = 0, aborted = 0
    await Promise.all(Array.from({ length: 20 }, async () => {
      for (let i = 0; i < 30; i++) {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), i % 10)
        try { await (await fetch(origin, { signal: controller.signal })).arrayBuffer(); completed++ }
        catch { aborted++ }
        finally { clearTimeout(timer) }
      }
    }))
    expect(completed + aborted).toBe(600)
    expect(aborted).toBeGreaterThan(0)
    expect(child.exitCode, "The relay process must remain alive after native client aborts").toBeNull()
    const response = await fetch(origin, { signal: AbortSignal.timeout(5000) })
    expect(response.status).toBe(200)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(4096).fill(71))
    const large = await fetch(origin + "/large", { signal: AbortSignal.timeout(5000) })
    expect(new Uint8Array(await large.arrayBuffer())).toEqual(new Uint8Array(256 * 4096).fill(71))
    for (const [encoding, compress] of [["gzip", gzipSync], ["br", brotliCompressSync]] as const) {
      const expected = compress(Buffer.from("export const value = 'fixture';\n".repeat(128)))
      const encoded = await fetch(origin + "/" + encoding, { decompress: false, signal: AbortSignal.timeout(5000) })
      expect(encoded.headers.get("content-encoding")).toBe(encoding)
      expect(encoded.headers.has("content-length") && encoded.headers.has("transfer-encoding")).toBe(false)
      expect(new Uint8Array(await encoded.arrayBuffer())).toEqual(new Uint8Array(expected))
      const head = await fetch(origin + "/" + encoding, { method: "HEAD", decompress: false, signal: AbortSignal.timeout(5000) })
      expect(head.headers.get("content-length")).toBe(String(expected.byteLength))
    }
    const firstConnection = await (await fetch(origin + "/connection")).json() as { port: number }
    const nextConnection = await (await fetch(origin + "/connection")).json() as { port: number }
    expect(firstConnection.port).toBeGreaterThan(0)
    expect(nextConnection.port).not.toBe(firstConnection.port)
    expect(await (await fetch(origin + "/state")).json()).toEqual({ active: 0 })
    const streaming = await fetch(origin + "/long", { signal: AbortSignal.timeout(5000) })
    const body = streaming.body!.getReader(), first = await body.read()
    expect(first.done).toBe(false)
    let received = first.value!.byteLength
    const revokedAt = Date.now()
    await fetch(origin + "/revoke")
    try {
      while (true) { const chunk = await body.read(); if (chunk.done) break; received += chunk.value.byteLength }
    } catch { /* Revocation can fail an already-started HTTP body. */ }
    body.releaseLock()
    expect(received).toBeLessThan(100 * 4096)
    expect(Date.now() - revokedAt).toBeLessThan(1500)
    expect(await (await fetch(origin + "/state")).json()).toEqual({ active: 0 })
    child.stdin.end()
    expect(await child.exited, await diagnostics).toBe(0)
  } finally {
    clearTimeout(deadline)
    if (child.exitCode === null) { child.kill(); await child.exited }
  }
}, 25_000)

test("native WebSocket relay accepts repeated 5 MiB text/binary messages and enforces the per-message ceiling", async () => {
  const origin = Bun.serve({ port: 0, hostname: "127.0.0.1",
    fetch: (request, server) => server.upgrade(request) ? undefined : new Response("Upgrade required", { status: 400 }),
    websocket: { maxPayloadLength: CONNECT_MAX_WS_BYTES, message: (ws, message) => { ws.send(message) } },
  })
  const relay = new ConnectRelay()
  const server = Bun.serve<RelaySocket>({ port: 0, hostname: "127.0.0.1",
    fetch: (request, server) => relay.upgrade(request, server, `ws://127.0.0.1:${origin.port}`, new Headers(), {
      hostId: "fixture", ownerId: "fixture", parentId: "fixture", valid: () => true,
    }), websocket: relay.websocket,
  })
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}`)
  ws.binaryType = "arraybuffer"
  try {
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error("Connection failed")) })
    for (const message of ["a".repeat(1_100_000), ...Array.from({ length: 4 }, (_, i) => String(i).repeat(CONNECT_MAX_WS_BYTES)), new Uint8Array(CONNECT_MAX_WS_BYTES).fill(73)]) {
      const response = new Promise<string | ArrayBuffer>((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error("Echo timed out")), 5000)
        ws.onmessage = event => { clearTimeout(deadline); resolve(event.data) }
      })
      ws.send(message)
      const echoed = await response
      if (typeof message === "string") expect(echoed).toBe(message)
      else expect(new Uint8Array(echoed as ArrayBuffer)).toEqual(message)
      expect(ws.readyState).toBe(WebSocket.OPEN)
    }
    const closed = new Promise<void>(resolve => { ws.onclose = () => resolve() })
    ws.send(new Uint8Array(CONNECT_MAX_WS_BYTES + 1))
    await Promise.race([closed, Bun.sleep(3000).then(() => { throw new Error("Oversized message was not rejected") })])
  } finally { ws.close(); relay.stop(); server.stop(true); origin.stop(true) }
}, 15_000)
