import { expect, test } from "bun:test"
import { proxyServer } from "../../../scripts/fixtures/connect-routing/proxy"
import { connectRequest } from "./http-client"
import { createConnectRouting } from "./routing"


test("direct API connections ignore inherited proxy variables; proxy uses authenticated CONNECT", async () => {
  const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => Response.json({ source: "direct", method: request.method }) })
  const proxy = await proxyServer(target.port!)
  try {
    // Run under hostile inherited environment in a separate process; Bun fetch
    // with proxy:"" fails this regression by silently selecting the proxy.
    const child = Bun.spawn([process.execPath, "-e", `import {connectRequest} from ${JSON.stringify(import.meta.dir + "/http-client.ts")};
      console.log(await(await connectRequest(new URL(${JSON.stringify(target.url.href)}),{proxy:"",signal:AbortSignal.timeout(3000)})).text())`], {
      env: { ...process.env, http_proxy: "http://127.0.0.1:1", HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1", ALL_PROXY: "http://127.0.0.1:1", NO_PROXY: "", no_proxy: "" }, stdout: "pipe", stderr: "pipe",
    })
    const output = await new Response(child.stdout).text(), errors = await new Response(child.stderr).text()
    expect(await child.exited).toBe(0); expect(errors).toBe("")
    expect(JSON.parse(output).source).toBe("direct"); expect(proxy.seen).toHaveLength(0)
    const response = await connectRequest(new URL("http://connect.example.invalid:1234/api"), {
      proxy: proxy.url, method: "POST", body: "{}", signal: AbortSignal.timeout(3000),
    })
    expect(await response.json()).toEqual({ source: "direct", method: "POST" })
    expect(proxy.seen).toEqual([{ authority: "connect.example.invalid:1234", authorization: `Basic ${Buffer.from("user:secret").toString("base64")}` }])
  } finally { await proxy.stop(); await target.stop(true) }
}, 10_000)

test("an unreachable direct authority falls back to a working HTTP proxy without local DNS", async () => {
  const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ ok: true }) })
  const proxy = await proxyServer(target.port!)
  const routing = createConnectRouting("http://connect.example.invalid", { http_proxy: proxy.url })
  try {
    await expect(connectRequest(new URL("http://127.0.0.1:1"), { proxy: "", signal: AbortSignal.timeout(1000) })).rejects.toThrow()
    routing.fail("api", "CONNECTION_FAILED")
    expect((await connectRequest(new URL("http://connect.example.invalid"), { proxy: routing.proxy, signal: AbortSignal.timeout(3000) })).status).toBe(200)
    expect(proxy.seen[0]?.authority).toBe("connect.example.invalid:80")
  } finally { await proxy.stop(); await target.stop(true) }
})

test("control-plane response limits, redirects and aborts do not become successful API responses", async () => {
  const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => {
    if (new URL(request.url).pathname === "/redirect") return new Response(null, { status: 302, headers: { Location: "/" } })
    if (new URL(request.url).pathname === "/slow") return new Promise<Response>(resolve => setTimeout(() => resolve(Response.json({ ok: true })), 500))
    return new Response("x".repeat(1024 * 1024 + 1))
  } })
  try {
    await expect(connectRequest(target.url, { proxy: "", signal: AbortSignal.timeout(3000) })).rejects.toThrow("too large")
    const redirect = await connectRequest(new URL("/redirect", target.url), { proxy: "", signal: AbortSignal.timeout(3000) })
    expect(redirect.status).toBe(302)
    await expect(connectRequest(new URL("/slow", target.url), { proxy: "", signal: AbortSignal.timeout(20) })).rejects.toThrow()
  } finally { await target.stop(true) }
})

test("HTTPS verifies certificates on both direct and HTTP CONNECT routes", async () => {
  const cert = await Bun.file(new URL("../../../scripts/fixtures/connect-routing/localhost-cert.pem", import.meta.url)).text()
  const key = await Bun.file(new URL("../../../scripts/fixtures/connect-routing/localhost-key.pem", import.meta.url)).text()
  const target = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { cert, key }, fetch: () => Response.json({ ok: true }) })
  const proxy = await proxyServer(target.port!)
  try {
    for (const proxyUrl of ["", proxy.url]) {
      const url = new URL(`https://127.0.0.1:${target.port}`)
      expect(await (await connectRequest(url, { proxy: proxyUrl, ca: cert, signal: AbortSignal.timeout(3000) })).json()).toEqual({ ok: true })
      await expect(connectRequest(url, { proxy: proxyUrl, signal: AbortSignal.timeout(3000) })).rejects.toThrow()
    }
  } finally { await proxy.stop(); await target.stop(true) }
}, 15_000)
