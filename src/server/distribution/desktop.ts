import { cliFallbackPath, mergeSearchPaths } from "../cli-environment"
import { randomUUID } from "node:crypto"
import { mkdir, realpath, rename, rmdir, stat, unlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createServiceLaunchSpec, manageService, resolveServiceBackend, runServiceCommand } from "../service"
import { getMacosServicePaths } from "../service/macos"
import { getWindowsServicePaths, WINDOWS_TASK_NAME } from "../service/windows"
import { assertCommandSucceeded } from "../service/types"
import { appCommand, appStatus, leaseAlive, localFetch, pauseManagedServer, waitUntil } from "../updater/control"
import { setupManagedUpdates } from "../updater/cli"
import { atomicJson, exists, inside, json } from "../updater/files"
import { desktopTransitionPending, FINISHED_PHASES, newerRelease, updateRoot, updateTarget, type UpdateControl, type UpdateDeployment, type UpdateRunnerStatus, type UpdateState } from "../updater/model"
import { UPDATE_AGENT, UPDATE_TASK } from "../updater/native"
import { stopWindowsEncodedProcesses } from "../updater/processes"
import { captureServiceRegistration, hashServiceFile, verifyServiceRegistration, windowsServiceCommand, windowsServiceHash, type ServiceRegistration } from "../updater/registration"
import type { SetupState } from "../updater/setup"
import { requestDesktopTransition } from "./transition"
import { BUNDLE_FILE, bunRelativePath, copyBundle, validateBundle, verifyBundle } from "./bundle"
import { DESKTOP_WAIT_MS, desktopProgress, openDesktopBrowser as openBrowser, waitForDesktopTransition } from "./desktop-progress"

export interface DesktopInstallation { schema: 1; runtime: string; phase: "staged" | "installed" }

interface DesktopReceipt { service: ServiceRegistration; updaterFile: string; updaterHash: string; updaterNativeHash?: string }

export async function saveDesktopReceipt(deployment: UpdateDeployment) {
  const launch = { ...deployment.launch, args: [deployment.controller, "serve", deployment.root], workingDirectory: deployment.root, environmentFile: undefined }
  const updaterFile = deployment.platform === "win32" ? path.join(deployment.root, "updater-task.xml")
    : path.join(deployment.launch.homeDirectory, "Library", "LaunchAgents", `${UPDATE_AGENT}.plist`)
  const receipt: DesktopReceipt = { service: await captureServiceRegistration(deployment.platform, launch), updaterFile,
    updaterHash: await hashServiceFile(updaterFile), ...(deployment.platform === "win32" ? { updaterNativeHash: await windowsServiceHash(runServiceCommand, UPDATE_TASK) } : {}) }
  await atomicJson(path.join(deployment.root, "desktop-receipt.json"), receipt)
}

export async function verifyDesktopReceipt(root: string) {
  const receipt = await json<DesktopReceipt>(path.join(root, "desktop-receipt.json"))
  await verifyServiceRegistration(receipt.service)
  if (await hashServiceFile(receipt.updaterFile) !== receipt.updaterHash
    || (receipt.service.platform === "win32" && await windowsServiceHash(runServiceCommand, UPDATE_TASK) !== receipt.updaterNativeHash)) {
    throw new Error("The updater service definition changed. Review the custom service before uninstalling.")
  }
  return receipt
}

export function desktopPath(home: string, platform = process.platform, inherited = process.env.PATH ?? "") {
  return mergeSearchPaths(platform, inherited, cliFallbackPath(home, platform))
}

async function verifyOwnedDeployment(root: string) {
  root = await realpath(root)
  const deployment = await json<UpdateDeployment>(path.join(root, "deployment.json"))
  if (deployment.root !== root) throw new Error("Managed installation directory changed")
  const control = await json<UpdateControl>(path.join(root, "control.json"))
  const releases = path.join(root, "releases")
  inside(releases, path.relative(releases, control.runtime))
  validateBundle(await json(path.join(control.runtime, BUNDLE_FILE)), deployment)
  return { deployment, control }
}

/** First launch is explicitly confirmed by the native launcher/installer. */
export async function launchDesktop(source: string, options: { open?: boolean; port?: number; migrate?: boolean; update?: boolean } = {}) {
  const target = updateTarget()
  const home = os.homedir()
  let root = updateRoot()
  if (await exists(path.join(root, "deployment.json"))) root = await realpath(root)
  const marker = path.join(root, "desktop.json")
  async function transition() {
    desktopProgress("Preparing the StillOn update… This may take several minutes.")
    await requestDesktopTransition(source, root)
    await waitForDesktopTransition(root)
    if (options.open !== false) await openBrowser((await json<UpdateDeployment>(path.join(root, "deployment.json"))).port)
  }
  if (await desktopTransitionPending(root)) return transition()
  if (await exists(marker) && await exists(path.join(root, "deployment.json"))) {
    const { deployment, control } = await verifyOwnedDeployment(root)
    const incoming = await verifyBundle(source, target)
    const active = await verifyBundle(control.runtime, deployment)
    if (newerRelease(active.version, incoming.version) && options.update) throw new Error("This installer is older than the running StillOn. Download a newer installer.")
    if (newerRelease(incoming.version, active.version)) {
      if (!options.update) throw new Error("Open this installer and confirm the upgrade to install the newer version.")
      return transition()
    }
    const setup = await exists(path.join(root, "setup.json")) ? await json<SetupState>(path.join(root, "setup.json")) : null
    if (!setup || setup.phase === "enabled") {
      const health = await appStatus(deployment)
      if (!health?.ok) {
        // A stopped or failed deployment needs explicit recovery; never reinstall
        // over an active transaction or silently replace its saved configuration.
        throw new Error("StillOn is installed but is not healthy. Use the installed update status/recover commands; existing settings and data have been kept.")
      }
      const runner = await json<UpdateRunnerStatus>(path.join(root, "runner.json"))
      if (health.updateInstance !== runner.instance) throw new Error("Another application owns the StillOn port")
      if (!await exists(path.join(root, "desktop-receipt.json")) && (await json<DesktopInstallation>(marker)).phase === "staged") await saveDesktopReceipt(deployment)
      await atomicJson(marker, { schema: 1, runtime: runner.runtime, phase: "installed" } satisfies DesktopInstallation)
      if (options.open !== false) await openBrowser(deployment.port)
      return
    }
    if (["queued", "installing", "verifying", "restoring", "recovery-required"].includes(setup.phase)) {
      throw new Error("StillOn setup or recovery is still pending. Reopen StillOn after the independent updater finishes.")
    }
  }
  const sourceBundle = await verifyBundle(source, target)
  if (await exists(path.join(root, "deployment.json"))) {
    if (!options.migrate) throw new Error("A source installation was found. Reopen StillOn and choose Migrate to installer version. Chats and settings are kept; source edits remain in the previous runtime.")
    return transition()
  }
  let install: DesktopInstallation
  if (await exists(marker)) {
    install = await json<DesktopInstallation>(marker)
    inside(path.join(root, "releases"), path.relative(path.join(root, "releases"), install.runtime))
    await verifyBundle(install.runtime, target)
    const registrationFile = path.join(root, "service-registration.json")
    if (await exists(registrationFile)) {
      const registration = await json<ServiceRegistration>(registrationFile)
      if (registration.launch.workingDirectory !== install.runtime) throw new Error("An existing custom service must be migrated explicitly")
      await verifyServiceRegistration(registration)
      const portIndex = registration.launch.args.indexOf("--port")
      const response = await localFetch(`http://127.0.0.1:${registration.launch.args[portIndex + 1]}/health?update-setup=1`).catch(() => null)
      if (response) {
        const health = await response.json() as { ok?: boolean; busy?: boolean; managedUpdateProtocol?: number }
        if (!health.ok || health.managedUpdateProtocol !== 1 || health.busy !== false) throw new Error("Finish active work before retrying desktop setup")
      }
    }
  } else {
    // Refuse both recorded and unrecorded legacy services before copying anything.
    const launch = createServiceLaunchSpec({ homeDirectory: home, entrypoint: path.join(source, "bin", "stillon") })
    const serviceFile = target.platform === "darwin" ? getMacosServicePaths(home).plistPath : getWindowsServicePaths(launch).taskXml
    const query = target.platform === "darwin"
      ? await runServiceCommand("/bin/launchctl", ["print", `gui/${process.getuid!()}/com.bzbj.stillon`])
      : await runServiceCommand("schtasks.exe", ["/Query", "/TN", "StillOn"])
    if (await exists(path.join(root, "deployment.json")) || await exists(serviceFile) || query.code === 0) {
      throw new Error("An existing StillOn installation was found. Open its workspace to update, or migrate its source customizations before switching to the desktop package. It has not been replaced.")
    }
    const port = options.port ?? 3210
    try {
      await localFetch(`http://127.0.0.1:${port}/health`)
      throw new Error("The StillOn port is already in use")
    } catch (error) { if (error instanceof Error && error.message === "The StillOn port is already in use") throw error }
    const runtime = path.join(root, "releases", `desktop-${sourceBundle.buildId}-${randomUUID()}`)
    desktopProgress("Preparing the StillOn runtime…")
    await copyBundle(source, runtime, sourceBundle)
    install = { schema: 1, runtime, phase: "staged" }
    await atomicJson(marker, install)
  }
  const port = options.port ?? 3210
  desktopProgress("Starting the StillOn background service…")
  await manageService("install", { executable: path.join(install.runtime, bunRelativePath(target.platform)),
    entrypoint: path.join(install.runtime, "bin", "stillon"), homeDirectory: home,
    port, host: "127.0.0.1", pathEnvironment: desktopPath(home), recordInstallation: true })
  // The first native PowerShell launch on Windows ARM can still be warming up
  // before a watchdog log exists. Keep a bounded first-start wait, without
  // reinstalling, weakening identity checks, or retrying an unhealthy service.
  await waitUntil(async () => {
    try {
      const response = await localFetch(`http://127.0.0.1:${port}/health?update-setup=1`)
      const data = await response.json() as { ok?: boolean; busy?: boolean; managedUpdateProtocol?: number; runtimeProfile?: string }
      return response.ok && data.ok === true && data.busy === false && data.managedUpdateProtocol === 1 && data.runtimeProfile === "prod"
    } catch { return false }
  }, DESKTOP_WAIT_MS)
  desktopProgress("Enabling managed updates and verifying StillOn…")
  await setupManagedUpdates(root)
  await waitUntil(async () => {
    const setup = await json<SetupState>(path.join(root, "setup.json"))
    if (["failed", "restored", "recovery-required"].includes(setup.phase)) throw new Error(setup.error ?? "Desktop setup needs recovery")
    return setup.phase === "enabled"
  }, DESKTOP_WAIT_MS)
  await saveDesktopReceipt(await json<UpdateDeployment>(path.join(root, "deployment.json")))
  await atomicJson(marker, { ...install, phase: "installed" })
  if (options.open !== false) await openBrowser(port)
}

/** Stop only a desktop-owned managed installation; preserve all user data. */
export async function uninstallDesktop() {
  const directory = updateRoot()
  if (await desktopTransitionPending(directory)) throw new Error("Wait for desktop migration or recovery before uninstalling.")
  if (!await exists(path.join(directory, "desktop.json"))) return
  const root = await realpath(directory)
  const { deployment } = await verifyOwnedDeployment(root)
  const receipt = await verifyDesktopReceipt(root)
  // Capture both verified native identities before deleting their task files.
  // Task Scheduler /End alone can leave an updater console holding this folder.
  const updaterCommand = deployment.platform === "win32" ? await windowsServiceCommand(receipt.updaterFile) : null
  const serviceCommand = deployment.platform === "win32" ? await windowsServiceCommand(receipt.service.serviceFile) : null
  if (await leaseAlive(root)) throw new Error("Wait for the current update to finish before uninstalling")
  if (await exists(path.join(root, "request.json"))) throw new Error("Wait for the queued update to finish before uninstalling")
  if (await exists(path.join(root, "state.json")) && !FINISHED_PHASES.has((await json<UpdateState>(path.join(root, "state.json"))).phase)) {
    throw new Error("Finish update recovery before uninstalling")
  }
  const runner = await json<UpdateRunnerStatus>(path.join(root, "runner.json"))
  const live = await appStatus(deployment)
  if (live) {
    if (live.updateInstance !== runner.instance) throw new Error("Another application owns the StillOn port")
    await appCommand(deployment, runner.secret, "check")
    await pauseManagedServer(deployment)
  }
  const managed = { ...deployment.launch, args: [deployment.controller, "serve", root], workingDirectory: root, environmentFile: undefined }
  const context = { launch: managed, run: runServiceCommand, log: console.log, warn: console.warn }
  if (deployment.platform === "win32") {
    // /Delete removes future scheduling without interrupting a running process.
    // Keep its encoded parent alive until the ownership-checked tree stop:
    // /End first can orphan children and lose that command identity.
    assertCommandSucceeded("Remove updater", await runServiceCommand("schtasks.exe", ["/Delete", "/TN", UPDATE_TASK, "/F"]))
    assertCommandSucceeded("Remove application task", await runServiceCommand("schtasks.exe", ["/Delete", "/TN", WINDOWS_TASK_NAME, "/F"]))
    await stopWindowsEncodedProcesses(updaterCommand!)
    await stopWindowsEncodedProcesses(serviceCommand!)
    await resolveServiceBackend("win32").uninstall(context)
  } else {
    const domain = `gui/${process.getuid!()}`
    const result = await runServiceCommand("/bin/launchctl", ["bootout", `${domain}/${UPDATE_AGENT}`])
    if (![0, 3, 113].includes(result.code ?? -1)) assertCommandSucceeded("Unload updater", result)
    await unlink(path.join(deployment.launch.homeDirectory, "Library", "LaunchAgents", `${UPDATE_AGENT}.plist`)).catch((error) => { if (error.code !== "ENOENT") throw error })
    await resolveServiceBackend("darwin").uninstall(context)
  }
  // Retain runtimes and recovery records under a distinct inactive directory.
  // A later fresh install can reuse ~/.stillon without reviving old supervisors.
  const retired = `${root}-uninstalled-${Date.now()}`
  // Windows may retain a stopped service's directory handle briefly. Keep the
  // intact installation if it cannot be retired; never delete it as a fallback.
  for (let attempt = 0; ; attempt++) {
    try { await rename(root, retired); break } catch (error) {
      if (deployment.platform !== "win32" || attempt >= 20 || !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error
      await Bun.sleep(250)
    }
  }
  console.log("StillOn background services removed. Your chats, themes, skins and settings were preserved.")
}

export async function desktopMain(args = process.argv.slice(2)) {
  const source = path.resolve(import.meta.dir, "..", "..", "..")
  if (args[0] === "--verify" && args.length === 1) {
    const bundle = await verifyBundle(source, updateTarget())
    console.log(JSON.stringify({ version: bundle.version, buildId: bundle.buildId, platform: bundle.platform, architecture: bundle.architecture }))
    return
  }
  if (args[0] === "--uninstall" && args.length === 1) return uninstallDesktop()
  if (args.includes("--migrate") && args.includes("--update")) throw new Error("Choose either migration or upgrade.")
  if (args.some((arg) => !["--no-open", "--migrate", "--update"].includes(arg))) throw new Error("Usage: desktop [--no-open] [--migrate | --update] | --verify | --uninstall")
  const lock = `${updateRoot()}.desktop-lock`
  await mkdir(path.dirname(lock), { recursive: true, mode: 0o700 })
  try { await mkdir(lock, { mode: 0o700 }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    if (await leaseAlive(lock) || Date.now() - (await stat(lock)).mtimeMs < 5_000) throw new Error("StillOn is already starting. Please wait a moment.")
    await rename(lock, `${lock}-interrupted-${randomUUID()}`)
    await mkdir(lock, { mode: 0o700 })
  }
  const token = randomUUID()
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) =>
    request.headers.get("authorization") === `Bearer ${token}` ? new Response(token) : new Response(null, { status: 403 }) })
  await atomicJson(path.join(lock, "lease.json"), { port: server.port, token })
  try { await launchDesktop(source, { open: !args.includes("--no-open"), migrate: args.includes("--migrate"), update: args.includes("--update") }) }
  finally { server.stop(true); await unlink(path.join(lock, "lease.json")); await rmdir(lock) }
}
