import { expect, test } from "bun:test"
import { isPublicPreviewAddress, resolvePreviewNetworkTarget, createPreviewNetworkProxy } from "./preview-network"
import { isAllowedBrowserPreviewPort } from "./browser-preview-proxy"
import { protectPreviewPort, releasePreviewPort } from "./preview-ports"
import net from "node:net"

// Use an actual proxy-form wire request, independently of Bun fetch/http's
// absolute-URL and machine NO_PROXY handling. HTTP/1.0 avoids chunk framing.
function readProxy(proxy: Awaited<ReturnType<typeof createPreviewNetworkProxy>>, address: string) {
  const target = new URL(proxy.server)
  return new Promise<Response>((resolve, reject) => {
    const chunks: Buffer[] = []
    const socket = net.connect({ host: target.hostname, port: Number(target.port) }, () => {
      socket.write("GET " + address + " HTTP/1.0\r\nHost: " + new URL(address).host + "\r\nProxy-Authorization: Basic " + btoa(proxy.username + ":" + proxy.password) + "\r\nConnection: close\r\n\r\n")
    })
    socket.setTimeout(10_000, () => socket.destroy(new Error("Proxy fixture timed out")))
    let finished = false
    const complete = (ended = false) => {
      if (finished) return
      const data = Buffer.concat(chunks), end = data.indexOf("\r\n\r\n")
      if (end < 0) return
      const lines = data.subarray(0, end).toString("utf8").split("\r\n")
      const status = Number(lines.shift()?.split(" ")[1])
      const headers = new Headers(lines.map(line => { const index = line.indexOf(":"); return [line.slice(0, index), line.slice(index + 1).trim()] as [string, string] }))
      if (!ended && (!headers.has("content-length") || data.length - end - 4 < Number(headers.get("content-length")))) return
      finished = true
      try { expect(headers.get("transfer-encoding")).not.toBe("chunked"); resolve(new Response(data.subarray(end + 4), { status, headers })) } catch (error) { reject(error) }
      socket.destroy()
    }
    socket.on("error", reject); socket.on("data", chunk => { chunks.push(Buffer.from(chunk)); complete() }); socket.on("end", () => complete(true))
  })
}

test("network policy rejects private, mapped, metadata and alternate protocol targets", async () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "2001:db8::1", "2002:7f00:1::"]) expect(isPublicPreviewAddress(ip)).toBe(false)
  for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) expect(isPublicPreviewAddress(ip)).toBe(true)
  expect(isPublicPreviewAddress("192.0.78.24")).toBe(true)
  for (const ip of ["192.0.2.1", "198.51.100.1", "203.0.113.1", "2001:2::1", "3fff:1::1"]) expect(isPublicPreviewAddress(ip)).toBe(false)
  for (const url of ["http://127.0.0.1:3210/", "file:///tmp/file", "http://user:secret@localhost:5173/", "http://127.0.0.1:5174/"]) await expect(resolvePreviewNetworkTarget(new URL(url), [3210], "http://127.0.0.1:5173")).rejects.toBeDefined()
})

test("explicit authorized preview ports do not depend on title, root status or negative discovery cache", async () => {
  const app = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => new URL(request.url).pathname === "/app" ? new Response("<button>Counter</button>") : new Response("Not found", { status: 404 }) })
  try {
    const port = app.port!
    expect(await isAllowedBrowserPreviewPort(port)).toBe(true)
    protectPreviewPort(port)
    expect(await isAllowedBrowserPreviewPort(port)).toBe(false)
    protectPreviewPort(port)
    releasePreviewPort(port)
    expect(await isAllowedBrowserPreviewPort(port)).toBe(false)
    releasePreviewPort(port)
    expect(await isAllowedBrowserPreviewPort(port)).toBe(true)
    const proxy = await createPreviewNetworkProxy(() => [3210], `http://127.0.0.1:${port}`)
    try {
      const response = await readProxy(proxy, `http://127.0.0.1:${port}/app`)
      expect(response.status).toBe(200)
      expect(await response.text()).toContain("Counter")
    } finally { await proxy.close() }
  } finally { await app.stop(true) }
})
test("file previews deny network egress even through transports outside HTTP route interception", async () => {
  const proxy = await createPreviewNetworkProxy(() => [], undefined, true)
  try {
    const response = await readProxy(proxy, "http://example.com/")
    expect(response.status).toBe(403)
    expect(response.headers.get("x-stillon-preview-transport")).toBe("denied")
  } finally { await proxy.close() }
})

test("IPv6 loopback forwarding uses the pinned socket and preserves the original authority", async () => {
  const app = Bun.serve({ hostname: "::1", port: 0, fetch: request => new Response(request.headers.get("host")) })
  const origin = "http://[::1]:" + app.port
  const proxy = await createPreviewNetworkProxy(() => [], origin)
  try {
    const response = await readProxy(proxy, origin)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("[::1]:" + app.port)
  } finally { await proxy.close(); await app.stop(true) }
})

test("a replacement process cannot inherit an existing service grant without explicit reauthorization", async () => {
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = reservation.port!
  await reservation.stop(true)
  const origin = "http://127.0.0.1:" + port
  const proxy = await createPreviewNetworkProxy(() => [], origin)
  let child: Bun.Subprocess | undefined
  const start = async (marker: string) => {
    child = Bun.spawn([process.execPath, "-e", "let hits=0;Bun.serve({hostname:'127.0.0.1',port:Number(process.env.PREVIEW_TEST_PORT),fetch:()=>Response.json({pid:process.pid,marker:process.env.PREVIEW_TEST_MARKER,hits:++hits})})"], {
      stdout: "ignore", stderr: "ignore", env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP, PREVIEW_TEST_PORT: String(port), PREVIEW_TEST_MARKER: marker },
    })
    const until = Date.now() + 10_000
    while (Date.now() < until) {
      try { const result = await (await fetch(origin, { signal: AbortSignal.timeout(500) })).json() as any; if (result.marker === marker) return result.pid as number } catch { /* Starting synthetic listener. */ }
      await Bun.sleep(50)
    }
    throw new Error("Synthetic service could not start")
  }
  const read = () => readProxy(proxy, origin)
  try {
    const original = await start("original")
    const first = await read()
    expect(first.status).toBe(200)
    expect((await first.json() as any).pid).toBe(original)
    child!.kill(); await child!.exited
    const replacement = await start("replacement")
    expect(replacement).not.toBe(original)
    const denied = await read()
    expect(denied.status).toBe(403)
    expect(denied.headers.get("x-stillon-preview-transport")).toBe("denied")
    expect((await (await fetch(origin)).json() as any).hits).toBe(2)
    proxy.reauthorize()
    const reopened = await read()
    expect(reopened.status).toBe(200)
    expect((await reopened.json() as any).pid).toBe(replacement)
  } finally { if (child && child.exitCode === null) { child.kill(); await child.exited }; await proxy.close() }
}, 30_000)
