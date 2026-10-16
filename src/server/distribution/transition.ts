import { randomUUID } from "node:crypto"
import { chmod, copyFile, mkdir, open, readFile, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { resolveServiceBackend, runServiceCommand } from "../service"
import { generateLaunchAgentPlist } from "../service/macos"
import { buildWindowsServicePowerShell, buildWindowsTaskXml, encodeWindowsPowerShell, encodeWindowsTaskXml } from "../service/windows"
import { assertCommandSucceeded } from "../service/types"
import { appCommand, appStatus, leaseAlive, pauseManagedServer, resumeManagedServer } from "../updater/control"
import { UpdateEngine, probeRuntime, verifyRuntime } from "../updater/engine"
import { withWorkerLease } from "../updater/entry"
import { atomicJson, exists, json, manifest, sameManifest, type Manifest } from "../updater/files"
import { FINISHED_PHASES, newerRelease, releaseTag, type UpdateControl, type UpdateDeployment, type UpdateRunnerStatus, type UpdateState } from "../updater/model"
import { DEFAULT_WORKER, installUpdateWorker, macosUpdaterPlist, wakeUpdateWorker, windowsUpdaterXml, type WorkerIdentity } from "../updater/native"
import { stopWindowsEncodedProcesses } from "../updater/processes"
import { captureServiceRegistration, verifyServiceRegistration, windowsServiceCommand, windowsServiceHash, type ServiceRegistration } from "../updater/registration"
import { bunRelativePath, copyBundle, sha256, verifyBundle } from "./bundle"
import { saveDesktopReceipt } from "./desktop"

export const TRANSITION_FILE = "desktop-transition.json"
export const TRANSITION_WORKER: WorkerIdentity = { agent: "com.bzbj.stillon.desktop-transition", task: "StillOn Desktop Transition", mode: "desktop-worker", file: "desktop-transition-task.xml" }
const TERMINAL = new Set(["succeeded", "rolled-back", "failed"])

interface NativeSnapshot { file: string; bytes: string; registration?: ServiceRegistration; nativeXml?: string; command?: string }
export interface DesktopTransition {
  schema: 1
  id: string
  phase: "queued" | "switching" | "succeeded" | "rolled-back" | "failed" | "recovery-required"
  oldRuntime: string
  newRuntime: string
  oldDeployment: UpdateDeployment
  newDeployment: UpdateDeployment
  app: NativeSnapshot
  updater: NativeSnapshot
  metadata: Record<string, unknown | null>
  sourceManifest: Manifest
  environmentHash?: string
  connectOrigin?: string
  updatedAt: string
  error?: string
}

export interface TransitionNativeEffects {
  check: () => Promise<void>
  stopUpdater: () => Promise<void>
  install: () => Promise<void>
  restore: () => Promise<void>
  restoreUpdater: () => Promise<void>
  receipt: () => Promise<void>
}

function managedLaunch(deployment: UpdateDeployment) {
  return { ...deployment.launch, args: [deployment.controller, "serve", deployment.root], workingDirectory: deployment.root, environmentFile: undefined }
}

function updaterFile(deployment: UpdateDeployment, worker = DEFAULT_WORKER) {
  return deployment.platform === "win32" ? path.join(deployment.root, worker.file)
    : path.join(deployment.launch.homeDirectory, "Library", "LaunchAgents", worker.agent + ".plist")
}

async function assertIdle(deployment: UpdateDeployment) {
  if (await exists(path.join(deployment.root, "request.json"))) throw new Error("Wait for the queued update before switching installation channels.")
  const setup = path.join(deployment.root, "setup.json")
  if (await exists(setup) && (await json<{ phase: string }>(setup)).phase !== "enabled") throw new Error("Finish managed service setup or recovery first.")
  const state = path.join(deployment.root, "state.json")
  if (await exists(state) && !FINISHED_PHASES.has((await json<UpdateState>(state)).phase)) throw new Error("Finish the current update or recovery first.")
  const runner = await json<UpdateRunnerStatus>(path.join(deployment.root, "runner.json"))
  const health = await appStatus(deployment)
  if (!health?.ok || health.updateInstance !== runner.instance || health.updateProtocol !== 1) throw new Error("The recorded StillOn service must be healthy before migration.")
  await appCommand(deployment, runner.secret, "check")
}

async function captureKnownServices(deployment: UpdateDeployment) {
  const launch = managedLaunch(deployment)
  const app = await captureServiceRegistration(deployment.platform, launch)
  const appBytes = Buffer.from(await readFile(app.serviceFile))
  const file = updaterFile(deployment)
  const updaterBytes = Buffer.from(await readFile(file))
  if (deployment.platform === "darwin") {
    if (appBytes.toString() !== generateLaunchAgentPlist(launch) || updaterBytes.toString() !== macosUpdaterPlist(deployment)) {
      throw new Error("The native service has custom settings. Review those settings before migrating.")
    }
    return { app: { file: app.serviceFile, bytes: appBytes.toString("base64"), registration: app }, updater: { file, bytes: updaterBytes.toString("base64") } }
  }
  const identity = await runServiceCommand("whoami.exe", [])
  assertCommandSucceeded("Inspect Windows service identity", identity)
  const appText = appBytes.toString("utf16le").replace(/^\uFEFF/, "")
  if (appText !== buildWindowsTaskXml(launch, identity.stdout.trim())) throw new Error("The Windows service has custom settings. Review them before migrating.")
  const command = await windowsServiceCommand(file)
  const expected = windowsUpdaterXml(deployment, identity.stdout.trim()).match(/-EncodedCommand ([A-Za-z0-9+/=]+)/)?.[1]
  if (command !== expected) throw new Error("The updater launch command changed. Review it before migrating.")
  async function nativeXml(task: string, expectedCommand: string) {
    const result = await runServiceCommand("schtasks.exe", ["/Query", "/TN", task, "/XML"])
    assertCommandSucceeded("Inspect registered task", result)
    if (!result.stdout.includes("-EncodedCommand " + expectedCommand)) throw new Error("The registered task differs from the recorded service.")
    return result.stdout
  }
  return { app: { file: app.serviceFile, bytes: appBytes.toString("base64"), registration: app,
    nativeXml: await nativeXml("StillOn", encodeWindowsPowerShell(buildWindowsServicePowerShell(launch))) },
    updater: { file, bytes: updaterBytes.toString("base64"), command, nativeXml: await nativeXml(DEFAULT_WORKER.task, command) } }
}

/** Stage immutable bytes; no Git, install, build, data access or service replacement. */
export async function requestDesktopTransition(source: string, root: string) {
  const file = path.join(root, TRANSITION_FILE)
  if (await exists(file)) {
    const pending = await json<DesktopTransition>(file)
    if (!TERMINAL.has(pending.phase)) {
      if (!await leaseAlive(root)) {
        await installUpdateWorker(pending.newDeployment, runServiceCommand, TRANSITION_WORKER)
        await wakeUpdateWorker(pending.newDeployment, runServiceCommand, TRANSITION_WORKER)
      }
      return pending
    }
  }
  const oldDeployment = await json<UpdateDeployment>(path.join(root, "deployment.json"))
  if (oldDeployment.schema !== 1 || oldDeployment.root !== root || oldDeployment.dataRoot !== path.join(oldDeployment.launch.homeDirectory, ".stillon")) throw new Error("Unsupported managed installation layout.")
  if (await leaseAlive(root)) throw new Error("Wait for the independent updater before migrating.")
  await assertIdle(oldDeployment)
  const oldRuntime = (await json<UpdateControl>(path.join(root, "control.json"))).runtime
  const bundle = await verifyBundle(source, oldDeployment)
  for (const name of [".stillon", ".stillon-dev", ".kanna", ".kanna-dev"]) {
    if (await exists(path.join(oldRuntime, name))) throw new Error("Runtime-local user data needs a separate migration. The original installation was kept.")
  }
  const version = (await json<{ version: string }>(path.join(oldRuntime, "package.json"))).version
  if (newerRelease(version, bundle.version)) throw new Error("This installer is older than the running StillOn. Download a newer installer.")
  const snapshots = await captureKnownServices(oldDeployment)
  const id = randomUUID()
  const newRuntime = path.join(root, "releases", "desktop-" + bundle.buildId + "-" + id)
  await copyBundle(source, newRuntime, bundle)
  const directory = path.join(root, "controllers", "desktop-" + id)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const executable = path.join(directory, oldDeployment.platform === "win32" ? "bun.exe" : "bun")
  await copyFile(path.join(newRuntime, bunRelativePath(oldDeployment.platform)), executable)
  await chmod(executable, 0o755)
  const controller = path.join(directory, "controller.js")
  await copyFile(path.join(newRuntime, "runtime/controller.js"), controller)
  const previousEntry = path.join(oldDeployment.launch.workingDirectory, "bin", "stillon")
  if (!oldDeployment.launch.args.includes(previousEntry)) throw new Error("Unrecognized source service CLI layout.")
  const newDeployment: UpdateDeployment = { ...oldDeployment, controller, launch: { ...oldDeployment.launch, executable,
    workingDirectory: newRuntime, args: oldDeployment.launch.args.map(arg => arg === previousEntry ? path.join(newRuntime, "bin", "stillon") : arg) } }
  const metadata: Record<string, unknown | null> = {}
  for (const name of ["desktop.json", "desktop-receipt.json"]) metadata[name] = await exists(path.join(root, name)) ? await json(path.join(root, name)) : null
  let connectOrigin: string | undefined
  const previousConnect = path.join(oldRuntime, "runtime/connect.json")
  if (await exists(previousConnect)) {
    const configured = await json<{ origin: string }>(previousConnect)
    const origin = new URL(configured.origin)
    if (origin.protocol !== "https:" || origin.origin !== configured.origin || origin.username || origin.password) throw new Error("Review the source installation's Connect service configuration before migrating.")
    connectOrigin = origin.origin
  }
  const transition: DesktopTransition = { schema: 1, id, phase: "queued", oldRuntime, newRuntime, oldDeployment, newDeployment,
    ...snapshots, metadata, connectOrigin, sourceManifest: await manifest(oldRuntime, true),
    ...(oldDeployment.launch.environmentFile ? { environmentHash: sha256(await Bun.file(oldDeployment.launch.environmentFile).bytes()) } : {}), updatedAt: new Date().toISOString() }
  // Publish a journal before registering recovery: closing the desktop launcher
  // can never abandon a partially replaced service. The old installation still runs.
  await atomicJson(path.join(root, "transactions", id, "desktop-transition.json"), transition)
  await atomicJson(file, transition)
  await installUpdateWorker(newDeployment, runServiceCommand, TRANSITION_WORKER)
  await wakeUpdateWorker(newDeployment, runServiceCommand, TRANSITION_WORKER)
  return transition
}

async function stopNative(deployment: UpdateDeployment, updater: boolean, command?: string) {
  if (deployment.platform === "win32") {
    const task = updater ? DEFAULT_WORKER.task : "StillOn"
    const result = await runServiceCommand("schtasks.exe", ["/End", "/TN", task])
    assertCommandSucceeded("Stop owned service", result)
    if (updater) assertCommandSucceeded("Suspend updater timer", await runServiceCommand("schtasks.exe", ["/Change", "/TN", task, "/Disable"]))
    if (command) await stopWindowsEncodedProcesses(command)
    return
  }
  const label = updater ? DEFAULT_WORKER.agent : "com.bzbj.stillon"
  const domain = "gui/" + process.getuid!()
  const query = await runServiceCommand("/bin/launchctl", ["print", domain + "/" + label])
  if (query.code === 0) assertCommandSucceeded("Stop owned service", await runServiceCommand("/bin/launchctl", ["bootout", domain + "/" + label]))
  else if (![3, 113].includes(query.code ?? -1)) assertCommandSucceeded("Inspect owned service", query)
}

async function restoreSnapshot(deployment: UpdateDeployment, snapshot: NativeSnapshot, task: string, label: string) {
  await writeFile(snapshot.file, Buffer.from(snapshot.bytes, "base64"), { mode: 0o600 })
  if (deployment.platform === "win32") {
    const imported = snapshot.file + ".restore.xml"
    await writeFile(imported, encodeWindowsTaskXml(snapshot.nativeXml!.replace(/^\uFEFF/, "")), { mode: 0o600 })
    try { assertCommandSucceeded("Restore owned task", await runServiceCommand("schtasks.exe", ["/Create", "/TN", task, "/XML", imported, "/F"])) }
    finally { await unlink(imported) }
    if (task === "StillOn") assertCommandSucceeded("Start restored service", await runServiceCommand("schtasks.exe", ["/Run", "/TN", task]))
  } else {
    const domain = "gui/" + process.getuid!()
    const query = await runServiceCommand("/bin/launchctl", ["print", domain + "/" + label])
    if (query.code === 0) assertCommandSucceeded("Stop replacement service", await runServiceCommand("/bin/launchctl", ["bootout", domain + "/" + label]))
    assertCommandSucceeded("Restore owned service", await runServiceCommand("/bin/launchctl", ["bootstrap", domain, snapshot.file]))
  }
}

export function nativeTransitionEffects(t: DesktopTransition): TransitionNativeEffects {
  const old = t.oldDeployment
  const next = t.newDeployment
  return {
    async check() {
      await verifyServiceRegistration(t.app.registration!)
      if (sha256(await Bun.file(t.updater.file).bytes()) !== sha256(Buffer.from(t.updater.bytes, "base64"))) throw new Error("Updater settings changed during migration preparation.")
      if (old.platform === "win32" && t.updater.nativeXml && sha256(t.updater.nativeXml.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim()) !== await windowsServiceHash(runServiceCommand, DEFAULT_WORKER.task)) throw new Error("Registered updater changed during preparation.")
    },
    stopUpdater: () => stopNative(old, true, t.updater.command),
    async install() {
      if (old.platform === "win32") await stopNative(old, false, t.app.registration?.windowsCommand)
      await resolveServiceBackend(next.platform).install({ launch: managedLaunch(next), run: runServiceCommand, log: console.log, warn: console.warn })
      await installUpdateWorker(next)
    },
    async restore() {
      if (old.platform === "win32") await stopNative(next, false, encodeWindowsPowerShell(buildWindowsServicePowerShell(managedLaunch(next))))
      await restoreSnapshot(old, t.app, "StillOn", "com.bzbj.stillon")
      await restoreSnapshot(old, t.updater, DEFAULT_WORKER.task, DEFAULT_WORKER.agent)
    },
    restoreUpdater: () => restoreSnapshot(old, t.updater, DEFAULT_WORKER.task, DEFAULT_WORKER.agent),
    receipt: () => saveDesktopReceipt(next),
  }
}

/** Runs under the shared authenticated lease, with an independent recovery task. */
export async function executeDesktopTransition(t: DesktopTransition, native: TransitionNativeEffects) {
  const old = t.oldDeployment
  const next = t.newDeployment
  const file = path.join(old.root, TRANSITION_FILE)
  async function save(phase: DesktopTransition["phase"], error?: string) {
    t = { ...t, phase, error, updatedAt: new Date().toISOString() }
    await atomicJson(path.join(old.root, "transactions", t.id, "desktop-transition.json"), t)
    await atomicJson(file, t)
  }
  if (TERMINAL.has(t.phase)) return
  const stateFile = path.join(old.root, "state.json")
  const request = path.join(old.root, "request.json")
  async function releaseReservation() {
    if (await exists(request) && (await json<UpdateState>(request)).id === t.id) await unlink(request)
  }
  if (t.phase === "queued") {
    try {
      await assertIdle(old)
      if ((await json<UpdateControl>(path.join(old.root, "control.json"))).runtime !== t.oldRuntime
        || JSON.stringify(await json(path.join(old.root, "deployment.json"))) !== JSON.stringify(old)) throw new Error("The installation changed after migration was prepared. Reopen the installer to prepare again.")
      await native.check()
      // Reserve the normal request slot while holding its shared worker lease.
      // Legacy workers reject this preparing-only reservation after interruption.
      const reservation = await open(request, "wx", 0o600)
      try { await reservation.writeFile(JSON.stringify({ id: t.id, phase: "preparing", oldRuntime: t.oldRuntime, newRuntime: t.newRuntime })) }
      finally { await reservation.close() }
      await save("switching")
      await native.stopUpdater()
      const bundle = await verifyBundle(t.newRuntime, next)
      await atomicJson(stateFile, { id: t.id, phase: "queued", targetTag: releaseTag(bundle.version), prepareOnly: false,
        oldRuntime: t.oldRuntime, newRuntime: t.newRuntime, updatedAt: new Date().toISOString() } satisfies UpdateState)
      await releaseReservation()
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await releaseReservation()
      if ((await json<DesktopTransition>(file)).phase === "switching") await native.restoreUpdater()
      await save("failed", reason)
      return
    }
  }
  // Interruption between disabling the timer and publishing the update request.
  if (!await exists(stateFile) || (await json<UpdateState>(stateFile)).id !== t.id) {
    await releaseReservation()
    await native.restoreUpdater()
    await save("failed", "Migration was interrupted before switching. The original installation was kept.")
    return
  }
  const engine = new UpdateEngine(old, {
    async prepare(state) {
      await verifyBundle(state.newRuntime, next)
      if (!sameManifest(t.sourceManifest, await manifest(t.oldRuntime, true))) throw new Error("Source files changed while migration was being prepared.")
      if (old.launch.environmentFile && sha256(await Bun.file(old.launch.environmentFile).bytes()) !== t.environmentHash) throw new Error("Service environment changed during migration preparation.")
      await probeRuntime(next, state.newRuntime, path.join(old.root, "transactions", t.id))
      await appCommand(old, (await json<UpdateRunnerStatus>(path.join(old.root, "runner.json"))).secret, "check")
    },
    async pause() {
      try { await pauseManagedServer(old) } catch (error) {
        // A failed native start can leave an error on an already stopped runner.
        if (await appStatus(old) || !(await json<UpdateRunnerStatus>(path.join(old.root, "runner.json"))).stopped) throw error
      }
    },
    async resume(runtime) {
      if (runtime === t.oldRuntime) {
        await atomicJson(path.join(old.root, "deployment.json"), old)
        await native.restore()
        for (const [name, data] of Object.entries(t.metadata)) {
          if (data === null) await unlink(path.join(old.root, name)).catch(error => { if (error.code !== "ENOENT") throw error })
          else await atomicJson(path.join(old.root, name), data)
        }
      } else {
        // Preserve an unbound source installation's public service setting outside
        // immutable package files. Existing linked devices keep their own origin.
        const service = path.join(old.dataRoot, "data/connect/service.json")
        if (t.connectOrigin && !await exists(service)) await atomicJson(service, { origin: t.connectOrigin })
        await atomicJson(path.join(old.root, "deployment.json"), next)
        await native.install()
      }
      await resumeManagedServer(old, runtime)
    },
    async verify(runtime) {
      await verifyRuntime(runtime === t.oldRuntime ? old : next, runtime)
      if (runtime === t.newRuntime) {
        await native.receipt()
        await atomicJson(path.join(old.root, "desktop.json"), { schema: 1, runtime, phase: "installed" })
      }
    },
  })
  try {
    await engine.execute()
    const state = await json<UpdateState>(stateFile)
    if (state.phase === "failed") await native.restoreUpdater()
    await save(state.phase === "succeeded" ? "succeeded" : state.phase === "rolled-back" ? "rolled-back" : "failed", state.error)
  } catch (error) {
    await save("recovery-required", error instanceof Error ? error.message : String(error))
    throw error
  }
}

export async function runDesktopTransitionWorker(root: string) {
  const t = await json<DesktopTransition>(path.join(root, TRANSITION_FILE))
  if (!TERMINAL.has(t.phase)) await withWorkerLease(t.oldDeployment, () => executeDesktopTransition(t, nativeTransitionEffects(t)))
  const result = await json<DesktopTransition>(path.join(root, TRANSITION_FILE))
  if (!TERMINAL.has(result.phase)) return
  // The main lease has been released. It is now safe to retire this helper.
  const file = updaterFile(t.newDeployment, TRANSITION_WORKER)
  await unlink(file).catch(error => { if (error.code !== "ENOENT") throw error })
  if (t.newDeployment.platform === "win32") await runServiceCommand("schtasks.exe", ["/Delete", "/TN", TRANSITION_WORKER.task, "/F"])
  else await runServiceCommand("/bin/launchctl", ["bootout", "gui/" + process.getuid!() + "/" + TRANSITION_WORKER.agent])
}
