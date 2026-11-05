import { expect, test } from "bun:test"
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createConnector } from "./connector"
import { handleConnectLocal } from "./local-api"
import { newDeviceKeys } from "./crypto"
import { prepareTransport } from "./transport"
import { FRP_VERSION, TRANSPORT_DESCRIPTOR, transportHash, type TransportComponent } from "./transport-component"

// A small .NET fixture stays under the component size cap and exercises real
// Windows process launch/exit and version probing. It simulates failure; it
// does not change or claim acceptance of Windows application-control policy.
const windowsTest = process.platform === "win32" ? test : test.skip
windowsTest("failed helper stops retrying, clears launch secrets and reconnects after local repair", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stillon-connector-repair-"))
  let connector: Awaited<ReturnType<typeof createConnector>> | undefined
  let cloud: ReturnType<typeof Bun.serve> | undefined
  try {
    const source = path.join(root, "Helper.cs"), binary = path.join(root, "frpc.exe")
    await writeFile(source, `using System; using System.IO; using System.Threading;
class Helper { static int Main(string[] args) {
  if (args.Length == 1 && args[0] == "--version") { Console.WriteLine("${FRP_VERSION}"); return 0; }
  string directory = Path.GetDirectoryName(args[1]);
  if (File.Exists(Path.Combine(directory, "fail-helper"))) return 1;
  while (true) Thread.Sleep(1000);
} }`)
    const compiler = path.join(process.env.WINDIR ?? "C:\\Windows", "Microsoft.NET/Framework64/v4.0.30319/csc.exe")
    const build = Bun.spawn([compiler, "/nologo", "/target:exe", `/out:${binary}`, source], { stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, exit] = await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text(), build.exited])
    expect(exit, stdout + stderr).toBe(0)
    const bytes = await readFile(binary), runtime = path.join(root, "runtime"), dataDir = path.join(root, "data")
    const directory = path.join(dataDir, "connect"), legacy = path.join(runtime, "runtime/frp")
    await mkdir(directory, { recursive: true }); await mkdir(legacy, { recursive: true })
    await copyFile(binary, path.join(legacy, "frpc.exe")); await writeFile(path.join(legacy, "LICENSE"), "Synthetic fixture")
    const component: TransportComponent = { schema: 1, version: FRP_VERSION, platform: "win32", architecture: process.arch as "arm64" | "x64",
      archive: { url: "https://example.invalid/never-download.zip", sha256: "a".repeat(64), format: "zip", prefix: "" },
      executable: { size: bytes.length, sha256: transportHash(bytes) } }
    await writeFile(path.join(runtime, TRANSPORT_DESCRIPTOR), JSON.stringify(component))
    const transportLocation = { cacheRoot: path.join(root, "cache") }
    await prepareTransport(component, { ...transportLocation, legacyRuntime: runtime })
    const keys = newDeviceKeys(), gateway = newDeviceKeys()
    let connects = 0, heartbeats = 0
    cloud = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const body = await request.json()
      if (new URL(request.url).pathname.endsWith("/challenge")) return Response.json({ challenge: "fixture-challenge" })
      if (body.action === "connect") { connects++; return Response.json({ token: "fixture-connect-token", generation: connects, epoch: 1,
        gatewayPublicKey: gateway.publicKey, hostOrigin: cloud!.url.origin, protocol: 1,
        tunnel: { hostname: "127.0.0.1", port: cloud!.port, protocol: "websocket" } }) }
      if (body.action === "heartbeat") { heartbeats++; return Response.json({ state: "online", leases: [] }) }
      return Response.json({ success: true })
    } })
    const stateFile = path.join(directory, "device.json"), failure = path.join(directory, "fail-helper")
    await writeFile(stateFile, JSON.stringify({ version: 1, origin: cloud.url.origin, name: "Fixture", keys, paused: false, pendingUnbind: false,
      binding: { hostId: "a".repeat(32), name: "Fixture", email: "fixture@example.com", epoch: 1, gatewayPublicKey: gateway.publicKey, url: cloud.url.origin } }))
    await writeFile(failure, "synthetic startup failure")
    connector = await createConnector({ dataDir, runtimeRoot: runtime, transportLocation, targetOrigin: "http://127.0.0.1:9",
      localSecret: "fixture-local-secret", name: () => "Fixture", environment: {} })
    async function until(accept: () => boolean | Promise<boolean>) {
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline) { if (await accept()) return; await Bun.sleep(50) }
      throw new Error("Timed out waiting for fixture lifecycle")
    }
    await until(() => connector!.diagnostics().error === "CONNECTOR_BLOCKED")
    expect(connector.diagnostics()).toMatchObject({ state: "offline", bound: true, transportRunning: false })
    await until(async () => !await Bun.file(path.join(directory, "frpc.json")).exists())
    // More than one normal tick/retry interval: blocked components stay stopped.
    await Bun.sleep(6_100)
    expect(connects).toBe(1)
    const before = JSON.parse(await readFile(stateFile, "utf8"))
    await rm(failure)
    const request = () => new Request("http://127.0.0.1/api/connect-local/repair-transport", { method: "POST" })
    expect((await handleConnectLocal(request(), { kind: "external" }, connector))?.status).toBe(403)
    expect((await handleConnectLocal(request(), { kind: "local" }, connector))?.status).toBe(200)
    await until(() => connector!.diagnostics().state === "online")
    expect(connects).toBe(2); expect(heartbeats).toBeGreaterThan(0)
    expect(connector.diagnostics()).toMatchObject({ bound: true, transportRunning: true, error: null, transport: { state: "ready" } })
    const after = JSON.parse(await readFile(stateFile, "utf8"))
    expect(after.keys).toEqual(before.keys); expect(after.binding).toEqual(before.binding)
    const report = JSON.stringify(connector.diagnostics())
    for (const secret of [root, keys.privateKey, "fixture@example.com", "fixture-connect-token", "fixture-local-secret"]) expect(report).not.toContain(secret)
  } finally { await connector?.stop(); await cloud?.stop(true); await rm(root, { recursive: true, force: true }) }
}, 60_000)
