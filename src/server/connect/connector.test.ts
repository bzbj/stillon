import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createConnector } from "./connector"
import { proxyServer } from "../../../scripts/fixtures/connect-routing/proxy"
import { randomToken } from "./crypto"

test("a migrated user service origin works without a package default", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stillon-origin-migration-"))
  try {
    const dataDir = path.join(root, "data")
    await mkdir(path.join(dataDir, "connect"), { recursive: true })
    await writeFile(path.join(dataDir, "connect/service.json"), JSON.stringify({ origin: "https://connect.example.invalid" }))
    const connector = await createConnector({ dataDir, targetOrigin: "http://127.0.0.1:9", localSecret: randomToken(), name: () => "Migrated computer" })
    try { expect(connector.status().origin).toBe("https://connect.example.invalid") }
    finally { await connector.stop() }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("API success with a stuck tunnel switches the complete route, then recovers direct while idle", async () => {
  const { readFile } = await import("node:fs/promises")
  const { newDeviceKeys } = await import("./crypto")
  const root = await mkdtemp(path.join(os.tmpdir(), "stillon-auto-route-"))
  const output = path.join(root, "spawn.json")
  const fixtureSource = path.join(root, "transport.ts")
  const binary = path.join(root, process.platform === "win32" ? "transport.exe" : "transport")
  await writeFile(fixtureSource, `const config = await Bun.file(process.argv[process.argv.indexOf("-c")+1]).json();
    await Bun.write(process.env.STILLON_FIXTURE_OUTPUT!, JSON.stringify({config,environment:Object.fromEntries(["http_proxy","HTTPS_PROXY","ALL_PROXY","NO_PROXY","no_proxy"].map(key=>[key,process.env[key]]))}));
    if(process.env.STILLON_FIXTURE_TLS) console.error("x509: certificate signed by unknown authority");
    setInterval(()=>{},1000);`)
  const compiler = Bun.spawn([process.execPath, "build", "--compile", fixtureSource, "--outfile", binary], { stdout: "ignore", stderr: "pipe" })
  const compileError = await new Response(compiler.stderr).text()
  expect(await compiler.exited, compileError).toBe(0)
  const keys = newDeviceKeys(), gateway = newDeviceKeys()
  let clock = Date.now(), heartbeats = 0
  const cloud = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request): Promise<Response> {
    if (new URL(request.url).pathname === "/health") return Response.json({ ok: true })
    const input = await request.json()
    if (new URL(request.url).pathname.endsWith("/challenge")) return Response.json({ challenge: "fixture-challenge" })
    if (input.action === "connect") return Response.json({ token: "fixture-token", generation: 1, epoch: 1,
      gatewayPublicKey: gateway.publicKey, hostOrigin: `http://localhost:${cloud.port}`, protocol: 1,
      tunnel: { hostname: "localhost", port: cloud.port, protocol: "websocket" } })
    if (input.action === "heartbeat") {
      heartbeats++
      const snapshot = await Bun.file(output).json()
      return Response.json({ state: snapshot.config.transport.proxyURL ? "online" : "connecting", leases: [] })
    }
    return Response.json({ sessions: [], now: clock })
  } })
  const dataDir = path.join(root, "data")
  await mkdir(path.join(dataDir, "connect"), { recursive: true })
  const statePath = path.join(dataDir, "connect/device.json")
  await writeFile(statePath, JSON.stringify({ version: 1, origin: `http://localhost:${cloud.port}`, name: "Fixture", keys,
    binding: { hostId: "a".repeat(32), name: "Fixture", email: "fixture@example.com", epoch: 1, gatewayPublicKey: gateway.publicKey, url: `http://localhost:${cloud.port}` }, paused: false, pendingUnbind: false }))
  const proxy = await proxyServer(cloud.port!)
  const environment = { ...process.env, http_proxy: proxy.url, HTTPS_PROXY: "http://127.0.0.1:2", ALL_PROXY: "socks5://127.0.0.1:3", NO_PROXY: "", no_proxy: "", STILLON_FIXTURE_OUTPUT: output }
  const originalEnvironment = { ...environment }
  let connector: Awaited<ReturnType<typeof createConnector>> | undefined
  async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean) {
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      try { const result = await read(); if (accept(result)) return result } catch { /* Fixture output may be replacing. */ }
      await Bun.sleep(50)
    }
    throw new Error("Timed out waiting for connector routing fixture")
  }
  try {
    connector = await createConnector({ dataDir, targetOrigin: "http://127.0.0.1:9", localSecret: randomToken(), name: () => "Fixture", frpcPath: binary, environment, now: () => clock })
    const initial = await until(() => Bun.file(output).json(), value => value.config.transport.proxyURL === "")
    for (const name of ["http_proxy", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "no_proxy"]) expect(initial.environment[name]).toBeUndefined()
    expect(connector.diagnostics().routing?.route).toBe("direct")
    clock += 31_000
    await until(async () => connector!.diagnostics(), value => value.routing?.route === "proxy" && value.error === "CONNECT_TUNNEL_TIMEOUT")
    expect(heartbeats).toBeGreaterThan(0)
    expect(connector.diagnostics().routing?.lastFailure).toMatchObject({ route: "direct", stage: "tunnel", code: "TUNNEL_TIMEOUT" })
    expect(connector.diagnostics().transportRunning).toBe(false)
    expect(connector.diagnostics().error).toBe("CONNECT_TUNNEL_TIMEOUT")
    clock += 10_000
    const proxied = await until(() => Bun.file(output).json(), value => Boolean(value.config.transport.proxyURL))
    expect(proxied.config.transport.proxyURL).toBe(proxy.url + "/")
    expect(proxy.seen.length).toBeGreaterThan(0)
    clock += 3_000
    await until(async () => connector!.diagnostics(), value => value.state === "online")
    // A healthy direct probe during an idle interval moves the entire route
    // back to direct without changing the binding or provider environment.
    clock += 300_001
    await until(async () => connector!.diagnostics(), value => value.routing?.route === "direct")
    expect(connector.diagnostics().state).toBe("connecting")
    await until(() => Bun.file(output).json(), value => value.config.transport.proxyURL === "")
    expect(environment).toEqual(originalEnvironment)
    expect(JSON.parse(await readFile(statePath, "utf8")).keys).toEqual(keys)
    expect(JSON.stringify(connector.diagnostics())).not.toMatch(/secret|fixture-token|fixture@example|localhost/)
    await connector.stop()
    await rm(output, { force: true })
    connector = await createConnector({ dataDir, targetOrigin: "http://127.0.0.1:9", localSecret: randomToken(), name: () => "Fixture", frpcPath: binary,
      environment: { ...environment, STILLON_FIXTURE_TLS: "1" }, now: () => clock })
    await until(() => Bun.file(output).json(), value => value.config.transport.proxyURL === "")
    // Certificate rejection is not a reachability failure and must never be
    // bypassed by choosing another path.
    await until(async () => connector!.diagnostics(), value => value.tunnelFailure === "TLS_FAILED")
    clock += 31_000
    await until(async () => connector!.diagnostics(), value => value.error === "CONNECT_TUNNEL_TLS_FAILED")
    expect(connector.diagnostics().routing?.route).toBe("direct")

  } finally { await connector?.stop(); await proxy.stop(); await cloud.stop(true); await rm(root, { recursive: true, force: true }) }
}, 60_000)

test("enrollment selects a proxy only after direct failure and honors authority bypass", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stillon-enroll-route-"))
  const cloud = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request): Promise<Response> {
    return Response.json(new URL(request.url).pathname.endsWith("challenge")
      ? { challenge: "fixture-challenge" } : { id: "fixture-enrollment", verificationUrl: "https://connect.example.invalid/verify", expiresAt: Date.now() + 600_000 })
  } })
  const proxy = await proxyServer(cloud.port!)
  try {
    for (const bypass of [false, true]) {
      const before = proxy.seen.length
      const connector = await createConnector({ dataDir: path.join(root, String(bypass)), targetOrigin: "http://127.0.0.1:9", origin: "http://127.0.0.1:1", name: () => "Fixture", localSecret: randomToken(), frpcPath: process.execPath,
        environment: { http_proxy: proxy.url, NO_PROXY: bypass ? "127.0.0.1" : "" } })
      try {
        if (bypass) {
          await expect(connector.enroll()).rejects.toThrow("CONNECT_API_CONNECTION_FAILED")
          expect(proxy.seen.length).toBe(before)
          expect(connector.diagnostics().routing?.route).toBe("direct")
        } else {
          expect((await connector.enroll()).id).toBe("fixture-enrollment")
          expect(connector.diagnostics().routing?.route).toBe("proxy")
          expect(proxy.seen.length).toBe(before + 2)
        }
      } finally { await connector.stop() }
    }
  } finally { await proxy.stop(); await cloud.stop(true); await rm(root, { recursive: true, force: true }) }
})

test("a lost signed-operation response changes routes without replaying the mutation", async () => {
  const { createServer } = await import("node:http")
  const root = await mkdtemp(path.join(os.tmpdir(), "stillon-no-replay-"))
  let mutations = 0
  const cloud = createServer((request, response) => {
    request.resume()
    if (request.url?.endsWith("challenge")) response.setHeader("Content-Type", "application/json").end(JSON.stringify({ challenge: "fixture-challenge" }))
    else { mutations++; request.socket.destroy() }
  })
  await new Promise<void>(resolve => cloud.listen(0, "127.0.0.1", resolve))
  const proxy = await proxyServer((cloud.address() as { port: number }).port)
  const connector = await createConnector({ dataDir: root, origin: `http://127.0.0.1:${(cloud.address() as { port: number }).port}`, targetOrigin: "http://127.0.0.1:9", name: () => "Fixture", localSecret: randomToken(), frpcPath: process.execPath, environment: { HTTP_PROXY: proxy.url } })
  try {
    await expect(connector.enroll()).rejects.toThrow("CONNECT_API_CONNECTION_FAILED")
    expect(mutations).toBe(1)
    expect(proxy.seen).toHaveLength(0)
    expect(connector.diagnostics().routing?.route).toBe("proxy")
  } finally {
    await connector.stop(); await proxy.stop()
    await new Promise<void>(resolve => cloud.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})
