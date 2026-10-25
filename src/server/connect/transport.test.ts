import { afterEach, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { deflateRawSync } from "node:zlib"
import { pathToFileURL } from "node:url"
import { prepareRuntimeTransport, prepareTransport, resolveTransport, transportRoot, transportStatus } from "./transport"
import { createConnector } from "./connector"
import { handleConnectLocal } from "./local-api"
import { downloadTransport, FRP_VERSION, readTransportArchive, TRANSPORT_DESCRIPTOR, transportBinary, TransportError, transportHash, validateTransportComponent, type TransportComponent } from "./transport-component"
import pinned from "./frp-components.json"

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture(content = "synthetic component") {
  const root = await mkdtemp(path.join(os.tmpdir(), "stillon-transport-")); roots.push(root)
  const binary = new TextEncoder().encode(content)
  const name = process.platform === "win32" ? "frpc.exe" : "frpc"
  const archive = await new Bun.Archive({ [name]: binary, LICENSE: "Synthetic license notice" }, { compress: "gzip" }).bytes()
  const component: TransportComponent = { schema: 1, version: FRP_VERSION, platform: process.platform as TransportComponent["platform"],
    architecture: process.arch as TransportComponent["architecture"], signing: "unsigned", executable: { sha256: transportHash(binary), size: binary.length },
    archive: { url: "https://components.example.invalid/frpc.tar.gz", sha256: transportHash(archive), format: "tar.gz", prefix: "" } }
  let downloads = 0, probes = 0
  const options = { cacheRoot: path.join(root, "shared component cache"), effects: {
    download: async () => { downloads++; return archive }, probe: async () => { probes++ },
  } }
  return { root, binary, archive, component, options, counts: () => ({ downloads, probes }) }
}

test("component requirements pin all six targets and reject invalid metadata", () => {
  expect(pinned).toHaveLength(6)
  for (const component of pinned) expect(validateTransportComponent(component, component).version).toBe(FRP_VERSION)
  const component = pinned.find(c => c.platform === process.platform && c.architecture === process.arch)!
  for (const patch of [{ version: "not-a-version" }, { platform: "unknown" }, { executable: { size: 1, sha256: "not-a-hash" } },
    { archive: { ...component.archive, prefix: "../../" } }, { archive: { ...component.archive, url: "file:///tmp/frpc" } },
    { archive: { ...component.archive, url: "https://user:password@example.invalid/frpc" } },
    { archive: { ...component.archive, url: "https://example.invalid/frpc?temporary=1" } }, { signing: "self-signed" }]) {
    expect(() => validateTransportComponent({ ...component, ...patch })).toThrow("CONNECTOR_COMPONENT_INVALID")
  }
})
test("shared caches live outside managed releases on Windows, macOS and Linux", () => {
  expect(transportRoot("win32", "C:\\Users\\example", "D:\\Local App Data")).toBe("D:\\Local App Data\\StillOn\\Transport\\frp")
  expect(transportRoot("darwin", "/Users/example")).toBe("/Users/example/Library/Application Support/StillOn/Transport/frp")
  expect(transportRoot("linux", "/home/example")).toBe("/home/example/.local/share/StillOn/Transport/frp")
})
test("first preparation downloads once; upgrades and restarts do not download, execute or rewrite it", async () => {
  const f = await fixture()
  const first = await prepareTransport(f.component, f.options), before = await stat(first.file)
  expect(first).toMatchObject({ reused: false, source: "download" })
  expect(await readFile(first.file)).toEqual(Buffer.from(f.binary))
  for (let i = 0; i < 3; i++) {
    const cached = await prepareTransport(structuredClone(f.component), { ...f.options, effects: {
      download: async () => { throw new Error("Network unavailable") }, probe: async () => { throw new Error("Must not relaunch") },
    } })
    expect(cached).toEqual({ file: first.file, reused: true, source: "cache" })
  }
  expect((await stat(first.file)).mtimeMs).toBe(before.mtimeMs)
  expect(f.counts()).toEqual({ downloads: 1, probes: 1 })
})
test("concurrent preparation shares a single writer", async () => {
  const f = await fixture()
  const results = await Promise.all(Array.from({ length: 8 }, () => prepareTransport(f.component, f.options)))
  expect(new Set(results.map(result => result.file)).size).toBe(1)
  expect(f.counts()).toEqual({ downloads: 1, probes: 1 })
})
test("a byte-identical legacy bundled helper is migrated without any download", async () => {
  const f = await fixture()
  const directory = path.join(f.root, "old runtime/runtime/frp")
  await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, transportBinary(f.component)), f.binary, { mode: 0o755 })
  await writeFile(path.join(directory, "LICENSE"), "Preserve upstream notice")
  const result = await prepareTransport(f.component, { ...f.options, legacyRuntime: path.join(f.root, "old runtime") })
  expect(result).toMatchObject({ reused: true, source: "legacy" })
  expect(f.counts()).toEqual({ downloads: 0, probes: 1 })
  expect(await readFile(path.join(path.dirname(result.file), "LICENSE"), "utf8")).toBe("Preserve upstream notice")
})
test("a different legacy helper is never treated as the pinned component", async () => {
  const f = await fixture()
  const directory = path.join(f.root, "old/runtime/frp")
  await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, transportBinary(f.component)), "unrelated executable")
  await writeFile(path.join(directory, "LICENSE"), "notice")
  expect((await prepareTransport(f.component, { ...f.options, legacyRuntime: path.join(f.root, "old") })).source).toBe("download")
  expect(f.counts().downloads).toBe(1)
})
test("quarantine or tampering never triggers repeated automatic downloads; explicit repair works", async () => {
  const f = await fixture(), first = await prepareTransport(f.component, f.options)
  await rm(first.file)
  expect(await transportStatus(f.component, f.options)).toMatchObject({ state: "error", error: "CONNECTOR_BLOCKED" })
  for (let i = 0; i < 2; i++) await expect(prepareTransport(f.component, f.options)).rejects.toThrow("CONNECTOR_BLOCKED")
  expect(f.counts().downloads).toBe(1)
  const repaired = await prepareTransport(f.component, { ...f.options, repair: true })
  expect(repaired.file).toBe(first.file)
  await writeFile(first.file, "changed bytes")
  await expect(prepareTransport(f.component, f.options)).rejects.toThrow("CONNECTOR_INTEGRITY_FAILED")
  expect(f.counts().downloads).toBe(2)
  await prepareTransport(f.component, { ...f.options, repair: true })
  expect(f.counts().downloads).toBe(3)
  if (process.platform !== "win32") {
    await chmod(first.file, 0o600)
    await expect(prepareTransport(f.component, f.options)).rejects.toThrow("CONNECTOR_BLOCKED")
    await prepareTransport(f.component, { ...f.options, repair: true })
    expect((await stat(first.file)).mode & 0o111).not.toBe(0)
  }
})
test("failed downloads are durable and do not retry until explicitly requested", async () => {
  const f = await fixture()
  const failure = { ...f.options, effects: { download: async () => { throw new TransportError("CONNECTOR_DOWNLOAD_FAILED") } } }
  await expect(prepareTransport(f.component, failure)).rejects.toThrow("CONNECTOR_DOWNLOAD_FAILED")
  await expect(prepareTransport(f.component, f.options)).rejects.toThrow("CONNECTOR_DOWNLOAD_FAILED")
  expect(f.counts().downloads).toBe(0)
  expect(await transportStatus(f.component, f.options)).toMatchObject({ state: "error", error: "CONNECTOR_DOWNLOAD_FAILED" })
  await prepareTransport(f.component, { ...f.options, repair: true })
  expect(f.counts().downloads).toBe(1)
})
test("wrong archive or executable hashes never produce an installed component", async () => {
  for (const change of ["archive", "binary"] as const) {
    const f = await fixture()
    const component = structuredClone(f.component)
    if (change === "archive") component.archive.sha256 = "a".repeat(64)
    else component.executable.sha256 = "a".repeat(64)
    await expect(prepareTransport(component, f.options)).rejects.toThrow("CONNECTOR_INTEGRITY_FAILED")
    expect(f.counts().probes).toBe(0)
    await expect(resolveTransport(component, f.options)).rejects.toThrow("CONNECTOR_INTEGRITY_FAILED")
  }
})
test("OS execution denial is isolated and does not relaunch on cache miss", async () => {
  const f = await fixture()
  await expect(prepareTransport(f.component, { ...f.options, effects: { ...f.options.effects,
    probe: async () => { throw new Error("Private operating-system diagnostic") },
  } })).rejects.toThrow("CONNECTOR_BLOCKED")
  await expect(prepareTransport(f.component, f.options)).rejects.toThrow("CONNECTOR_BLOCKED")
  expect(f.counts().downloads).toBe(1)
})
test("different component bytes coexist for rollback and never overwrite an active helper", async () => {
  const a = await fixture("first component"), b = await fixture("new component")
  const first = await prepareTransport(a.component, a.options)
  const second = await prepareTransport(b.component, { ...b.options, cacheRoot: a.options.cacheRoot })
  expect(second.file).not.toBe(first.file)
  expect(await resolveTransport(a.component, a.options)).toBe(first.file)
  expect(await readFile(first.file)).toEqual(Buffer.from(a.binary))
})
test("the stable component schema lets an installed controller prepare a newer frp version", async () => {
  const f = await fixture()
  const first = await prepareTransport(f.component, f.options)
  const next = await prepareTransport({ ...f.component, version: "0.72.0" }, f.options)
  expect(next.file).not.toBe(first.file)
  expect(await resolveTransport(f.component, f.options)).toBe(first.file)
})
test("preparation waits for an active writer without starting a competing download", async () => {
  const f = await fixture()
  const id = `${f.component.version}-${f.component.architecture}-${f.component.executable.sha256.slice(0, 16)}`
  const lock = path.join(f.options.cacheRoot, `.${id}.lock`)
  await mkdir(lock, { recursive: true }); await writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid }))
  const pending = prepareTransport(f.component, f.options)
  await Bun.sleep(50)
  expect(f.counts().downloads).toBe(0)
  await rm(lock, { recursive: true })
  await pending
  expect(f.counts().downloads).toBe(1)
})
async function writer(f: Awaited<ReturnType<typeof fixture>>) {
  const script = path.join(f.root, "writer.ts"), marker = path.join(f.root, "writer-started"), resume = path.join(f.root, "writer-resume")
  const module = pathToFileURL(path.resolve(import.meta.dir, "transport.ts")).href
  await writeFile(script, `import { prepareTransport } from ${JSON.stringify(module)}
const hold = setInterval(() => {}, 1000)
try {
  await prepareTransport(${JSON.stringify(f.component)}, { cacheRoot: ${JSON.stringify(f.options.cacheRoot)}, effects: {
    download: async () => { await Bun.write(${JSON.stringify(marker)}, 'ready'); while (!await Bun.file(${JSON.stringify(resume)}).exists()) await Bun.sleep(20); return Buffer.from(${JSON.stringify(Buffer.from(f.archive).toString("base64"))}, 'base64') },
    probe: async () => {},
  } })
} finally { clearInterval(hold) }
`)
  const child = Bun.spawn([process.execPath, script], { stdout: "ignore", stderr: "pipe" })
  for (let i = 0; i < 500 && !await Bun.file(marker).exists(); i++) {
    if (child.exitCode !== null) throw new Error(await new Response(child.stderr).text())
    await Bun.sleep(10)
  }
  if (!await Bun.file(marker).exists()) { child.kill(); await child.exited; throw new Error("Synthetic writer did not start") }
  return { child, resume }
}
test("a second process reuses the first writer's atomic commit", async () => {
  const f = await fixture(), other = await writer(f)
  try {
    const pending = prepareTransport(f.component, f.options)
    await Bun.sleep(50)
    expect(f.counts().downloads).toBe(0)
    await writeFile(other.resume, "continue")
    try { expect((await pending).source).toBe("cache") }
    catch (error) {
      if (other.child.exitCode === null) { other.child.kill(); await other.child.exited }
      throw new Error(`${String(error)}; writer stderr: ${await new Response(other.child.stderr).text()}`)
    }
    expect(await other.child.exited).toBe(0)
    expect(f.counts()).toEqual({ downloads: 0, probes: 0 })
  } finally { if (other.child.exitCode === null) { other.child.kill(); await other.child.exited } }
})
test("killing a real writer leaves a durable attempt; explicit repair reclaims its dead lock", async () => {
  const f = await fixture(), other = await writer(f)
  other.child.kill(); await other.child.exited
  await expect(prepareTransport(f.component, f.options)).rejects.toThrow("CONNECTOR_REPAIR_REQUIRED")
  expect(f.counts().downloads).toBe(0)
  const repaired = await prepareTransport(f.component, { ...f.options, repair: true })
  expect(repaired.source).toBe("download")
  expect(await resolveTransport(f.component, f.options)).toBe(repaired.file)
})
test("a component failure cannot fail local application preparation", async () => {
  const f = await fixture(), runtime = path.join(f.root, "runtime")
  await mkdir(path.join(runtime, "runtime"), { recursive: true })
  await writeFile(path.join(runtime, TRANSPORT_DESCRIPTOR), JSON.stringify({ ...f.component, schema: 99 }))
  const messages: string[] = []
  expect(await prepareRuntimeTransport(runtime, { ...f.options, report: message => messages.push(message) })).toBeNull()
  expect(messages.join(" ")).toContain("Local StillOn remains available")
  expect(messages.join(" ")).not.toContain(f.root)
})
test("cached startup preserves identity errors; component repair stays local-only", async () => {
  const f = await fixture(); await prepareTransport(f.component, f.options)
  const runtime = path.join(f.root, "runtime"), dataDir = path.join(f.root, "data")
  await mkdir(path.join(runtime, "runtime"), { recursive: true }); await mkdir(path.join(dataDir, "connect"), { recursive: true })
  await writeFile(path.join(runtime, TRANSPORT_DESCRIPTOR), JSON.stringify(f.component))
  await writeFile(path.join(dataDir, "connect/device.json"), "invalid device data")
  const connector = await createConnector({ dataDir, runtimeRoot: runtime, transportLocation: f.options,
    origin: "https://connect.example.invalid", targetOrigin: "http://127.0.0.1:9", localSecret: "synthetic-secret", name: () => "Example computer" })
  try {
    for (let i = 0; i < 100 && connector.status().transport?.state === "preparing"; i++) await Bun.sleep(10)
    expect(connector.status()).toMatchObject({ error: "DEVICE_STATE_INVALID", transport: { state: "ready" } })
    await expect(connector.enroll()).rejects.toThrow("DEVICE_STATE_INVALID")
    const request = () => new Request("http://127.0.0.1/api/connect-local/repair-transport", { method: "POST" })
    for (const ingress of [{ kind: "remote", ownerId: "example-owner" }, { kind: "external" }] as const) {
      expect((await handleConnectLocal(request(), ingress, connector))?.status).toBe(403)
    }
    expect((await handleConnectLocal(request(), { kind: "local" }, connector))?.status).toBe(200)
    expect(connector.status().error).toBe("DEVICE_STATE_INVALID")
  } finally { await connector.stop() }
})

/** A small standard ZIP fixture exercises the Windows distribution format. */
function zip(entries: { name: string; data: Uint8Array; mode?: number }[]) {
  const local: Buffer[] = [], central: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name), data = deflateRawSync(entry.data), header = Buffer.alloc(30), directory = Buffer.alloc(46)
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(8, 8)
    header.writeUInt32LE(data.length, 18); header.writeUInt32LE(entry.data.length, 22); header.writeUInt16LE(name.length, 26)
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(0x0314, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(8, 10)
    directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(entry.data.length, 24); directory.writeUInt16LE(name.length, 28)
    directory.writeUInt32LE(((entry.mode ?? 0x8000) << 16) >>> 0, 38); directory.writeUInt32LE(offset, 42)
    local.push(header, name, data); central.push(directory, name); offset += header.length + name.length + data.length
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, directory, end])
}
test("Windows ZIP components are decoded without extracting arbitrary paths or links", async () => {
  const f = await fixture()
  for (const mode of [0x8000, 0xa000]) {
    const bytes = zip([{ name: "frpc.exe", data: f.binary, mode }, { name: "LICENSE", data: Buffer.from("notice") },
      { name: "../../unwanted", data: Buffer.from("never written") }])
    const component = { ...f.component, platform: "win32" as const, archive: { ...f.component.archive, format: "zip" as const, sha256: transportHash(bytes) } }
    if (mode === 0x8000) expect((await readTransportArchive(bytes, component)).binary).toEqual(Buffer.from(f.binary))
    else await expect(readTransportArchive(bytes, component)).rejects.toThrow("CONNECTOR_INTEGRITY_FAILED")
  }
})
test("component downloads enforce bounded streaming and redact failure details", async () => {
  const f = await fixture()
  const fetcher = async () => new Response(f.archive)
  expect(await downloadTransport(f.component, fetcher)).toEqual(f.archive)
  await expect(downloadTransport(f.component, async () => new Response(null, { headers: { "Content-Length": "9999999999" } }))).rejects.toThrow("CONNECTOR_DOWNLOAD_FAILED")
  await expect(downloadTransport(f.component, async () => { throw new Error("private proxy credentials") })).rejects.toThrow("CONNECTOR_DOWNLOAD_FAILED")
})
