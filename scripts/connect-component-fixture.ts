import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { startStillOnServer } from "../src/server/server"
import { prepareTransport } from "../src/server/connect/transport"
import { FRP_VERSION, TRANSPORT_DESCRIPTOR, TransportError, transportHash, type TransportComponent } from "../src/server/connect/transport-component"

/** Isolated browser/API fixture. The helper only prints a synthetic version. */
const root = await mkdtemp(path.join(os.tmpdir(), "stillon-component-ui-"))
const runtime = path.join(root, "runtime"), cacheRoot = path.join(root, "cache")
await mkdir(path.join(runtime, "runtime"), { recursive: true })
let helper: Uint8Array
if (process.platform === "win32") {
  const source = path.join(root, "Probe.cs"), executable = path.join(root, "Probe.exe")
  await writeFile(source, `class Probe { static void Main() { System.Console.WriteLine("${FRP_VERSION}"); } }`)
  const compiler = path.join(process.env.WINDIR ?? "C:\\Windows", "Microsoft.NET/Framework64/v4.0.30319/csc.exe")
  const child = Bun.spawn([compiler, "/nologo", "/target:exe", `/out:${executable}`, source], { stdout: "ignore", stderr: "inherit" })
  if (await child.exited !== 0) throw new Error("Could not compile the synthetic component probe")
  helper = await readFile(executable)
} else helper = Buffer.from(`#!/bin/sh\nprintf '${FRP_VERSION}\\n'\n`)
const name = process.platform === "win32" ? "frpc.exe" : "frpc"
const archive = await new Bun.Archive({ [name]: helper, LICENSE: "Synthetic fixture; no third-party executable" }, { compress: "gzip" }).bytes()
const component: TransportComponent = { schema: 1, version: FRP_VERSION, platform: process.platform as TransportComponent["platform"],
  architecture: process.arch as TransportComponent["architecture"], executable: { sha256: transportHash(helper), size: helper.length },
  archive: { url: "https://components.example.invalid/synthetic-frpc.tar.gz", sha256: transportHash(archive), format: "tar.gz", prefix: "" } }
await writeFile(path.join(runtime, TRANSPORT_DESCRIPTOR), JSON.stringify(component))
// Seed an interrupted first attempt. The browser must request an explicit retry.
await prepareTransport(component, { cacheRoot, effects: { download: async () => { throw new TransportError("CONNECTOR_DOWNLOAD_FAILED") } } }).catch(() => {})
const fetcher = globalThis.fetch
let downloads = 0
globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  if (String(input) === component.archive.url) { downloads++; console.log(`Synthetic component download ${downloads}`); return new Response(archive) }
  return fetcher(input, init)
}, { preconnect: fetcher.preconnect }) as typeof fetch
process.env.STILLON_MACHINE_NAME = "Example computer"
const app = await startStillOnServer({ port: Number(process.env.STILLON_FIXTURE_PORT ?? 0), host: "127.0.0.1", strictPort: true,
  dataDir: path.join(root, "data"), discoveryHome: root, openBrowser: false,
  connect: { runtimeRoot: runtime, transportLocation: { cacheRoot }, origin: "https://connect.example.invalid" },
  codexModelDiscovery: { discover: async () => { throw new Error("Disabled in isolated fixture") } },
})
console.log(JSON.stringify({ origin: `http://127.0.0.1:${app.port}`, fixture: "independent-connect-component" }))
let stopped = false
async function stop() {
  if (stopped) return
  stopped = true; await app.stop(); globalThis.fetch = fetcher
  await chmod(root, 0o700); await rm(root, { recursive: true, force: true }); process.exit(0)
}
process.once("SIGTERM", () => { void stop() }); process.once("SIGINT", () => { void stop() })
setTimeout(() => { void stop() }, 10 * 60_000).unref()
