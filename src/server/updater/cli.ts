import { randomUUID } from "node:crypto"
import { chmod, copyFile, mkdir, realpath } from "node:fs/promises"
import path from "node:path"
import { runServiceCommand } from "../service"
import { assertCommandSucceeded } from "../service/types"
import { atomicJson, exists, json, manifest, sameManifest } from "./files"
import { enqueueUpdate, prepareSource, probeRuntime } from "./engine"
import { BUNDLE_FILE, bunRelativePath, verifyBundle } from "../distribution/bundle"
import { installUpdateWorker, wakeUpdateWorker } from "./native"
import { leaseAlive } from "./control"
import { FINISHED_PHASES, MAX_IDLE_WAIT_SECONDS, MIN_IDLE_WAIT_SECONDS, releaseTag, updateRoot, updateTarget, type UpdateDeployment, type UpdateState } from "./model"
import { verifyServiceRegistration, windowsServiceCommand, type ServiceRegistration } from "./registration"
import { checkSetupReadiness, type SetupState } from "./setup"

/** Accept plain seconds or a bounded `30s`, `30m` or `12h` duration. */
export function parseIdleWait(value: string) {
  const match = /^([1-9]\d*)([smh])?$/i.exec(value)
  if (!match) throw new Error(`Idle wait must be seconds or a duration such as 30m or 12h (${MIN_IDLE_WAIT_SECONDS}-${MAX_IDLE_WAIT_SECONDS} seconds).`)
  const multiplier = match[2]?.toLowerCase() === "h" ? 3_600 : match[2]?.toLowerCase() === "m" ? 60 : 1
  const seconds = Number(match[1]) * multiplier
  if (!Number.isSafeInteger(seconds) || seconds < MIN_IDLE_WAIT_SECONDS || seconds > MAX_IDLE_WAIT_SECONDS) {
    throw new Error(`Idle wait must be between ${MIN_IDLE_WAIT_SECONDS} and ${MAX_IDLE_WAIT_SECONDS} seconds.`)
  }
  return seconds
}

export type ParsedUpdateArgs =
  | { action: "setup" | "status" | "recover" | "settings-snapshot" }
  | { action: "request"; tag: string; prepareOnly: boolean; idleWaitSeconds?: number }

export function parseUpdateArgs(args: string[]): ParsedUpdateArgs {
  const [action, ...rest] = args
  if ((action === "setup" || action === "status" || action === "recover" || action === "settings-snapshot") && rest.length === 0) {
    return { action }
  }
  if (action === "request") {
    let tag: string | undefined
    let prepareOnly = false
    let idleWaitSeconds: number | undefined
    for (let index = 0; index < rest.length; index++) {
      const argument = rest[index]
      if (argument === "--prepare-only") {
        if (prepareOnly) throw new Error("Duplicate --prepare-only.")
        prepareOnly = true
        continue
      }
      if (argument === "--wait-idle") {
        if (idleWaitSeconds !== undefined) throw new Error("Duplicate --wait-idle.")
        const value = rest[++index]
        if (!value) throw new Error("--wait-idle requires a duration such as 12h.")
        idleWaitSeconds = parseIdleWait(value)
        continue
      }
      if (argument.startsWith("--") || tag !== undefined) throw new Error("Use a single release tag and supported request options.")
      tag = releaseTag(argument)
    }
    if (!tag) throw new Error("A release tag is required.")
    if (prepareOnly && idleWaitSeconds !== undefined) throw new Error("A prepare-only request cannot wait for idle.")
    return { action: "request", tag, prepareOnly, ...(idleWaitSeconds === undefined ? {} : { idleWaitSeconds }) }
  }
  throw new Error("Usage: stillon update setup | status | recover | settings-snapshot | request <release-tag> [--prepare-only] [--wait-idle <duration>]")
}

export async function setupManagedUpdates(root = updateRoot()) {
  const target = updateTarget()
  const registrationFile = path.join(root, "service-registration.json")
  if (!await exists(registrationFile)) {
    throw new Error("Managed updates require a recorded native service installation. Install the native StillOn service from this release with your existing options first. Custom launchers remain unchanged.")
  }
  if (await exists(path.join(root, "deployment.json"))) {
    const setup = await exists(path.join(root, "setup.json")) ? await json<SetupState>(path.join(root, "setup.json")) : null
    if (setup?.phase === "queued" && !await leaseAlive(root)) {
      const deployment = await json<UpdateDeployment>(path.join(root, "deployment.json"))
      await installUpdateWorker(deployment)
      await wakeUpdateWorker(deployment)
      console.log("The independent worker will finish first-time setup. Use update status for progress.")
      return
    }
    if (!setup || !["prepared", "failed", "restored"].includes(setup.phase)) throw new Error("Managed updates are configured or setup is pending. Use update status or update recover.")
    if (await leaseAlive(root)) throw new Error("The previous setup worker is still finishing. Retry setup after it exits.")
  }
  const registration = await json<ServiceRegistration>(registrationFile)
  if (registration.platform !== target.platform) throw new Error("Service platform mismatch.")
  await verifyServiceRegistration(registration)
  if (target.platform === "win32") registration.windowsCommand = await windowsServiceCommand(registration.serviceFile)
  // Verify the native service still exists. Unknown/custom supervisors are never adopted.
  const query = target.platform === "win32"
    ? await runServiceCommand("schtasks.exe", ["/Query", "/TN", "StillOn"])
    : await runServiceCommand("/bin/launchctl", ["print", `gui/${process.getuid!()}/com.bzbj.stillon`])
  assertCommandSucceeded("Verify existing native service", query)
  const launch = registration.launch
  const executableInfo = await runServiceCommand(launch.executable, ["--no-env-file", "-e", "console.log(JSON.stringify({platform:process.platform,architecture:process.arch}))"])
  assertCommandSucceeded("Inspect service Bun architecture", executableInfo)
  const executableTarget = JSON.parse(executableInfo.stdout) as { platform: NodeJS.Platform; architecture: NodeJS.Architecture }
  const serviceTarget = updateTarget(executableTarget.platform, executableTarget.architecture)
  if (serviceTarget.platform !== target.platform) throw new Error("Service Bun platform mismatch.")
  const runtime = await realpath(launch.workingDirectory)
  const entrypoint = path.join(runtime, "bin", "stillon")
  const previousEntry = path.join(launch.workingDirectory, "bin", "stillon")
  if (!launch.args.includes(previousEntry)) throw new Error("Managed updates require a versioned source runtime with bin/stillon.")
  const portIndex = launch.args.indexOf("--port")
  const hostIndex = launch.args.indexOf("--host")
  const port = Number(launch.args[portIndex + 1])
  if (portIndex < 0 || !Number.isInteger(port) || port < 1 || port > 65535 || (hostIndex >= 0 && launch.args[hostIndex + 1] !== "127.0.0.1")) {
    throw new Error("Managed updates require a fixed loopback 127.0.0.1 service; keep external ingress in the existing proxy.")
  }
  await mkdir(root, { recursive: true, mode: 0o700 })
  root = await realpath(root)
  const bundleDirectory = path.join(root, "controllers", randomUUID())
  await mkdir(bundleDirectory, { recursive: true, mode: 0o700 })
  const packaged = await exists(path.join(runtime, BUNDLE_FILE))
  let controllerExecutable = await realpath(launch.executable)
  if (packaged) {
    await verifyBundle(runtime, serviceTarget)
    await copyFile(path.join(runtime, "runtime", "controller.js"), path.join(bundleDirectory, "controller.js"))
    controllerExecutable = path.join(bundleDirectory, target.platform === "win32" ? "bun.exe" : "bun")
    await copyFile(path.join(runtime, bunRelativePath(target.platform)), controllerExecutable)
    await chmod(controllerExecutable, 0o755)
  } else {
    const build = await Bun.build({ entrypoints: [path.join(import.meta.dir, "entry.ts")], outdir: bundleDirectory,
      naming: "controller.js", target: "bun", packages: "bundle" })
    if (!build.success) throw new AggregateError(build.logs, "Could not build the independent controller.")
  }
  const deployment: UpdateDeployment = { schema: 1, ...serviceTarget, root, controller: path.join(bundleDirectory, "controller.js"),
    port, dataRoot: path.join(launch.homeDirectory, ".stillon"),
    launch: { ...launch, executable: controllerExecutable, workingDirectory: runtime,
      args: launch.args.map((arg) => arg === previousEntry ? entrypoint : arg) } }
  const baseline = await manifest(path.join(runtime, "dist"))
  await atomicJson(path.join(root, "build-manifests.json"), { [runtime]: baseline })
  const id = randomUUID()
  const rehearsal: UpdateState = { id, phase: "queued", targetTag: releaseTag((await json<{ version: string }>(path.join(runtime, "package.json"))).version),
    prepareOnly: true, oldRuntime: runtime, newRuntime: path.join(root, "rehearsals", id), updatedAt: new Date().toISOString() }
  // This one-time rebuild detects existing edits to generated dist, before adopting
  // the service. No service or data changes occur during this rehearsal.
  if (packaged) {
    await probeRuntime(deployment, runtime, path.join(root, "rehearsals", id))
  } else {
    await prepareSource(deployment, rehearsal)
    if (!sameManifest(baseline, await manifest(path.join(rehearsal.newRuntime, "dist")))) {
      throw new Error("The rebuilt source differs from the existing dist. Preserve those customizations in source before enabling managed updates.")
    }
  }
  await verifyServiceRegistration(registration)
  await checkSetupReadiness(deployment)
  // Disable adoption before publishing deployment metadata. A crash between
  // these writes leaves a retryable preparation, never an apparently enabled app.
  const setup: SetupState = { phase: "prepared", registration, updatedAt: new Date().toISOString() }
  await atomicJson(path.join(root, "setup.json"), setup)
  await atomicJson(path.join(root, "control.json"), { runtime, paused: false })
  await atomicJson(path.join(root, "deployment.json"), deployment)
  await atomicJson(path.join(root, "setup.json"), { ...setup, phase: "queued" })
  await installUpdateWorker(deployment)
  await wakeUpdateWorker(deployment)
  console.log(`First-time setup requested for ${serviceTarget.platform}/${serviceTarget.architecture}. The independent worker owns the service switch and recovery; use update status for progress.`)
}

export async function updateCli(args = process.argv.slice(3)) {
  const options = parseUpdateArgs(args)
  const root = updateRoot()
  if (options.action === "setup") return setupManagedUpdates(root)
  const config = path.join(root, "deployment.json")
  if (!await exists(config)) {
    if (options.action === "status") { console.log("Managed updates are not enabled. Custom/unsupported installations can continue using the source-upgrade prompt."); return }
    throw new Error("Run stillon update setup from a recorded native service installation first.")
  }
  const deployment = await json<UpdateDeployment>(config)
  if (options.action === "settings-snapshot") {
    const { readUpdateSettingsSnapshot } = await import("./settings-snapshot")
    console.log(JSON.stringify(await readUpdateSettingsSnapshot(deployment), null, 2))
    return
  }
  if (options.action === "status") {
    const file = path.join(root, "state.json")
    const requestFile = path.join(root, "request.json")
    const setupFile = path.join(root, "setup.json")
    const setup = await exists(setupFile) ? await json<SetupState>(setupFile) : null
    const state = await exists(file) ? await json<UpdateState>(file) : null
    // A request can be flushed before the worker journals it into state.json.
    // Report the queued transaction instead of a stale finished one.
    const pending = (!state || FINISHED_PHASES.has(state.phase)) && await exists(requestFile)
      ? await json<UpdateState>(requestFile).catch(() => null)
      : null
    console.log(JSON.stringify({ setup: setup ? { phase: setup.phase, error: setup.error, updatedAt: setup.updatedAt } : null,
      update: pending ?? state }, null, 2))
    return
  }
  if (options.action === "request") {
    const state = await enqueueUpdate(deployment, options.tag!, options.prepareOnly, options.idleWaitSeconds)
    await wakeUpdateWorker(deployment)
    console.log(JSON.stringify({
      id: state.id,
      targetTag: state.targetTag,
      prepareOnly: state.prepareOnly,
      idleWaitSeconds: state.idleWaitSeconds ?? null,
      statusFile: path.join(root, "state.json"),
      journalFile: path.join(root, "transactions", state.id, "journal.json"),
      message: state.idleWaitSeconds
        ? "The independent operating-system updater owns the authenticated idle wait, shutdown, backup, switch, verification and rollback. This terminal can be closed."
        : "The independent operating-system updater has been requested. This terminal can be closed.",
    }, null, 2))
    return
  }
  await wakeUpdateWorker(deployment)
  console.log("The independent operating-system updater has been requested. This terminal can be closed. Use stillon update status for progress.")
}
