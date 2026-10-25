import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { atomicJson, assertPlainDirectory, exists, json } from "../updater/files"
import { downloadTransport, readTransportArchive, TRANSPORT_DESCRIPTOR, transportBinary, TransportError, transportHash,
  validateTransportComponent, type TransportComponent, type TransportErrorCode } from "./transport-component"

export interface TransportLocation { homeDirectory?: string; localAppDataDirectory?: string; cacheRoot?: string }
interface TransportReceipt { schema: 1; sha256: string; phase: "preparing" | "ready" | "failed"; error?: TransportErrorCode }
export interface PreparedTransport { file: string; reused: boolean; source: "cache" | "legacy" | "download" }
export interface TransportStatus { state: "ready" | "missing" | "preparing" | "error"; version: string; error?: TransportErrorCode }
interface TransportEffects {
  download?: (component: TransportComponent) => Promise<Uint8Array>
  probe?: (file: string, component: TransportComponent) => Promise<void>
}
const execute = promisify(execFile)
const active = new Map<string, Promise<PreparedTransport>>()

export function transportRoot(platform = process.platform, home = os.homedir(), localAppData = process.env.LOCALAPPDATA) {
  if (platform === "win32") return path.win32.join(localAppData || path.win32.join(home, "AppData", "Local"), "StillOn", "Transport", "frp")
  return path.posix.join(home, platform === "darwin" ? "Library/Application Support" : ".local/share", "StillOn", "Transport", "frp")
}
function locations(component: TransportComponent, location: TransportLocation) {
  const root = path.resolve(location.cacheRoot ?? transportRoot(component.platform, location.homeDirectory, location.localAppDataDirectory))
  // Different signed bytes at the same upstream version must never replace an
  // executable still used by an older StillOn runtime or a rollback.
  const id = `${component.version}-${component.architecture}-${component.executable.sha256.slice(0, 16)}`
  return { root, directory: path.join(root, id), receipt: path.join(root, `${id}.json`), lock: path.join(root, `.${id}.lock`) }
}
async function regularFile(file: string, size?: number) {
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 || (size !== undefined && info.size !== size)) throw new TransportError("CONNECTOR_INTEGRITY_FAILED")
  return info
}
async function receipt(file: string, component: TransportComponent) {
  if (!await exists(file)) return null
  try {
    await regularFile(file)
    const value = await json<TransportReceipt>(file)
    if (value.schema !== 1 || value.sha256 !== component.executable.sha256 || !["ready", "preparing", "failed"].includes(value.phase)) throw new Error()
    return value
  } catch { throw new TransportError("CONNECTOR_REPAIR_REQUIRED") }
}
async function validBinary(directory: string, component: TransportComponent) {
  await assertPlainDirectory(directory)
  const file = path.join(directory, transportBinary(component))
  await regularFile(file, component.executable.size)
  if (transportHash(await readFile(file)) !== component.executable.sha256) throw new TransportError("CONNECTOR_INTEGRITY_FAILED")
  return file
}
export async function readRuntimeTransport(runtime: string) {
  const file = path.join(runtime, TRANSPORT_DESCRIPTOR)
  if (!await exists(file)) return null // Source checkouts and old bundled releases remain compatible.
  try { await regularFile(file); return validateTransportComponent(await json(file)) }
  catch (error) { throw error instanceof TransportError ? error : new TransportError("CONNECTOR_COMPONENT_INVALID") }
}
export async function resolveTransport(component: TransportComponent, location: TransportLocation = {}) {
  validateTransportComponent(component)
  const files = locations(component, location)
  try {
    await assertPlainDirectory(files.root)
    return await validBinary(files.directory, component)
  } catch (error) {
    if (error instanceof TransportError) throw error
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new TransportError("CONNECTOR_BLOCKED")
    const saved = await receipt(files.receipt, component)
    if (saved?.phase === "ready") throw new TransportError("CONNECTOR_BLOCKED")
    if (saved) throw new TransportError("CONNECTOR_REPAIR_REQUIRED")
    throw new TransportError("CONNECTOR_NOT_INSTALLED")
  }
}
export async function transportStatus(component: TransportComponent, location: TransportLocation = {}): Promise<TransportStatus> {
  try { await resolveTransport(component, location); return { state: "ready", version: component.version } }
  catch (error) {
    const code = error instanceof TransportError ? error.code : "CONNECTOR_BLOCKED"
    return { state: code === "CONNECTOR_NOT_INSTALLED" ? "missing" : code === "CONNECTOR_PREPARING" ? "preparing" : "error", version: component.version, error: code }
  }
}
async function probe(file: string, component: TransportComponent) {
  try {
    // This bounded, read-only probe happens only when installing a component,
    // never on a cache hit or on every StillOn upgrade.
    if (component.signing === "developer-id") await execute("/usr/bin/codesign", ["--verify", "--strict", file], { timeout: 30_000 })
    const result = await execute(file, ["--version"], { timeout: 30_000, windowsHide: true })
    if (result.stdout.trim() !== component.version) throw new Error()
  } catch { throw new TransportError("CONNECTOR_BLOCKED") }
}
function alive(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH" }
}
async function waitForWriter(component: TransportComponent, location: TransportLocation) {
  const files = locations(component, location), deadline = Date.now() + 125_000
  while (await exists(files.lock)) {
    try { await assertPlainDirectory(files.lock) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break
      throw error
    }
    try { return await resolveTransport(component, location) } catch { /* The writer has not committed yet. */ }
    try {
      const owner = await json<{ pid: number }>(path.join(files.lock, "owner.json"))
      if (!alive(owner.pid)) break // Recheck the final commit after the owner exits.
    } catch { /* A live creator may still be publishing its owner record. */ }
    if (Date.now() >= deadline) throw new TransportError("CONNECTOR_PREPARING")
    await Bun.sleep(200)
  }
  try { return await resolveTransport(component, location) } catch { return null }
}
async function acquire(lock: string) {
  try { await mkdir(lock, { mode: 0o700 }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    await assertPlainDirectory(lock)
    let owner: { pid: number }
    try { owner = await json(path.join(lock, "owner.json")) } catch { throw new TransportError("CONNECTOR_PREPARING") }
    if (alive(owner.pid)) throw new TransportError("CONNECTOR_PREPARING")
    const current = await json<{ pid: number }>(path.join(lock, "owner.json"))
    if (current.pid !== owner.pid || alive(current.pid)) throw new TransportError("CONNECTOR_PREPARING")
    // Reclaim a positively dead owner, never an arbitrary timeout on a writer.
    const abandoned = `${lock}.interrupted-${randomUUID()}`
    await rename(lock, abandoned)
    await rm(abandoned, { recursive: true, force: true })
    await mkdir(lock, { mode: 0o700 })
  }
  await atomicJson(path.join(lock, "owner.json"), { pid: process.pid })
  return async () => { await rm(path.join(lock, "owner.json"), { force: true }); await rmdir(lock) }
}

/** Explicit install/update preparation only. The connector's retry loop never downloads. */
export function prepareTransport(component: TransportComponent, options: TransportLocation & {
  repair?: boolean; legacyRuntime?: string; progress?: (message: string) => void; effects?: TransportEffects
} = {}): Promise<PreparedTransport> {
  validateTransportComponent(component)
  const files = locations(component, options), key = files.directory
  const pending = active.get(key)
  if (pending) return pending
  const work = install()
  active.set(key, work)
  void work.finally(() => { if (active.get(key) === work) active.delete(key) }).catch(() => {})
  return work
  async function install(): Promise<PreparedTransport> {
    try { return { file: await resolveTransport(component, options), reused: true, source: "cache" } }
    catch (error) {
      if (await exists(files.lock)) {
        const file = await waitForWriter(component, options)
        if (file) return { file, reused: true, source: "cache" }
      }
      if (!options.repair && !(error instanceof TransportError && error.code === "CONNECTOR_NOT_INSTALLED")) throw error
    }
    await mkdir(files.root, { recursive: true, mode: 0o700 }); await assertPlainDirectory(files.root)
    let release: () => Promise<void>
    try { release = await acquire(files.lock) } catch (error) {
      if (error instanceof TransportError && error.code === "CONNECTOR_PREPARING") {
        const file = await waitForWriter(component, options)
        if (file) return { file, reused: true, source: "cache" }
      }
      throw error
    }
    let stage: string | undefined
    try {
      // Another process may have completed between the first check and the lock.
      try { return { file: await resolveTransport(component, options), reused: true, source: "cache" } } catch { /* Check the durable attempt before mutation. */ }
      if (!options.repair && await receipt(files.receipt, component)) throw new TransportError("CONNECTOR_REPAIR_REQUIRED")
      await atomicJson(files.receipt, { schema: 1, sha256: component.executable.sha256, phase: "preparing" } satisfies TransportReceipt)
      let data: { binary: Uint8Array; license: Uint8Array } | undefined, source: PreparedTransport["source"] = "download"
      if (options.legacyRuntime) {
        try {
          const directory = path.join(options.legacyRuntime, "runtime/frp")
          const file = await validBinary(directory, component), license = path.join(directory, "LICENSE")
          if ((await regularFile(license)).size > 128 * 1024) throw new Error()
          data = { binary: await readFile(file), license: await readFile(license) }; source = "legacy"
        } catch { /* Only byte-identical legacy helpers are eligible for migration. */ }
      }
      if (!data) {
        options.progress?.("Downloading the Connect component…")
        data = await readTransportArchive(await (options.effects?.download ?? downloadTransport)(component), component)
      }
      options.progress?.("Verifying the Connect component…")
      stage = await mkdtemp(path.join(files.root, ".install-"))
      const executable = path.join(stage, transportBinary(component))
      await writeFile(executable, data.binary, { flag: "wx", mode: 0o755 })
      await writeFile(path.join(stage, "LICENSE"), data.license, { flag: "wx", mode: 0o644 })
      if (process.platform !== "win32") await chmod(executable, 0o755)
      await validBinary(stage, component)
      await (options.effects?.probe ?? probe)(executable, component)
      if (await exists(files.directory)) {
        await assertPlainDirectory(files.directory)
        try {
          const file = await validBinary(files.directory, component)
          return { file, reused: true, source: "cache" }
        } catch (error) {
          if (!options.repair) throw error
        }
        // An explicit repair preserves the previous bytes for diagnosis; no
        // in-place overwrite of a running helper or removal of other versions.
        await rename(files.directory, `${files.directory}.replaced-${randomUUID()}`)
      }
      await rename(stage, files.directory); stage = undefined
      const file = await validBinary(files.directory, component)
      await atomicJson(files.receipt, { schema: 1, sha256: component.executable.sha256, phase: "ready" } satisfies TransportReceipt)
      return { file, reused: source === "legacy", source }
    } catch (caught) {
      const error = caught instanceof TransportError ? caught : new TransportError("CONNECTOR_BLOCKED")
      if (error.code !== "CONNECTOR_REPAIR_REQUIRED") await atomicJson(files.receipt, { schema: 1, sha256: component.executable.sha256,
        phase: "failed", error: error.code } satisfies TransportReceipt).catch(() => {})
      throw error
    } finally { if (stage) await rm(stage, { recursive: true, force: true }); await release() }
  }
}

/** Component errors never roll back an otherwise healthy local application. */
export async function prepareRuntimeTransport(runtime: string, options: TransportLocation & {
  legacyRuntime?: string; report?: (message: string) => void
} = {}) {
  const report = options.report ?? console.warn
  try {
    const component = await readRuntimeTransport(runtime)
    if (!component) return null
    const result = await prepareTransport(component, { ...options, progress: report })
    report(result.reused ? "Connect component verified; reusing the existing installation." : "Connect component installed and verified.")
    return result
  } catch (error) {
    report(`Connect component is not ready (${error instanceof TransportError ? error.code : "CONNECTOR_BLOCKED"}). Local StillOn remains available. Open Remote access settings to repair the component.`)
    return null
  }
}
