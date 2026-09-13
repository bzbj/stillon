import { randomUUID } from "node:crypto"
import { mkdir, realpath, rename } from "node:fs/promises"
import path from "node:path"
import { resolveServiceBackend, runServiceCommand } from "../service"
import { assertCommandSucceeded } from "../service/types"
import { atomicJson, exists, json, manifest, sameManifest } from "./files"
import { enqueueUpdate, prepareSource, verifyRuntime } from "./engine"
import { installUpdateWorker, wakeUpdateWorker } from "./native"
import { localFetch } from "./control"
import { releaseTag, updateRoot, updateTarget, type UpdateDeployment, type UpdateState } from "./model"
import { hashServiceFile, type ServiceRegistration } from "./registration"

export function parseUpdateArgs(args: string[]) {
  const [action, ...rest] = args
  if (["setup", "status", "recover"].includes(action) && rest.length === 0) return { action }
  if (action === "request" && (rest.length === 1 || (rest.length === 2 && rest[1] === "--prepare-only"))) {
    return { action, tag: releaseTag(rest[0]), prepareOnly: rest.length === 2 }
  }
  throw new Error("Usage: stillon update setup | status | recover | request <release-tag> [--prepare-only]")
}

export async function setupManagedUpdates(root = updateRoot()) {
  const target = updateTarget()
  const registrationFile = path.join(root, "service-registration.json")
  if (!await exists(registrationFile)) {
    throw new Error("Managed updates require a recorded native service installation. Install the native StillOn service from this release with your existing options first. Custom launchers remain unchanged.")
  }
  if (await exists(path.join(root, "deployment.json"))) throw new Error("Managed updates are already configured. Use update status or update recover.")
  const registration = await json<ServiceRegistration>(registrationFile)
  if (registration.platform !== target.platform || registration.serviceHash !== await hashServiceFile(registration.serviceFile)) {
    throw new Error("The service definition changed after installation; refusing to replace custom service settings.")
  }
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
  const build = await Bun.build({ entrypoints: [path.join(import.meta.dir, "entry.ts")], outdir: bundleDirectory,
    naming: "controller.js", target: "bun", packages: "bundle" })
  if (!build.success) throw new AggregateError(build.logs, "Could not build the independent controller.")
  const deployment: UpdateDeployment = { schema: 1, ...serviceTarget, root, controller: path.join(bundleDirectory, "controller.js"),
    port, dataRoot: path.join(launch.homeDirectory, ".stillon"),
    launch: { ...launch, executable: await realpath(launch.executable), workingDirectory: runtime,
      args: launch.args.map((arg) => arg === previousEntry ? entrypoint : arg) } }
  const baseline = await manifest(path.join(runtime, "dist"))
  await atomicJson(path.join(root, "build-manifests.json"), { [runtime]: baseline })
  const id = randomUUID()
  const rehearsal: UpdateState = { id, phase: "queued", targetTag: releaseTag((await json<{ version: string }>(path.join(runtime, "package.json"))).version),
    prepareOnly: true, oldRuntime: runtime, newRuntime: path.join(root, "rehearsals", id), updatedAt: new Date().toISOString() }
  // This one-time rebuild detects existing edits to generated dist, before adopting
  // the service. No service or data changes occur during this rehearsal.
  await prepareSource(deployment, rehearsal)
  if (!sameManifest(baseline, await manifest(path.join(rehearsal.newRuntime, "dist")))) {
    throw new Error("The rebuilt source differs from the existing dist. Preserve those customizations in source before enabling managed updates.")
  }
  if (registration.serviceHash !== await hashServiceFile(registration.serviceFile)) throw new Error("Service settings changed during setup; retry without replacing them.")
  const setupCheck = await localFetch(`http://127.0.0.1:${port}/health?update-setup=1`)
  const readiness = await setupCheck.json() as { ok?: boolean; managedUpdateProtocol?: number; runtimeProfile?: string; busy?: boolean }
  if (!readiness.ok || readiness.managedUpdateProtocol !== 1 || readiness.runtimeProfile !== "prod" || readiness.busy !== false) {
    throw new Error("Start this release and finish active agent/terminal work before enabling managed updates.")
  }
  await atomicJson(path.join(root, "control.json"), { runtime, paused: false })
  await atomicJson(path.join(root, "deployment.json"), deployment)
  const backend = resolveServiceBackend(target.platform)
  try {
    await installUpdateWorker(deployment)
    await backend.install({ launch: { ...launch, executable: deployment.launch.executable,
      args: [deployment.controller, "serve", root], workingDirectory: root, environmentFile: undefined },
      run: runServiceCommand, log: console.log, warn: console.warn })
    await verifyRuntime(deployment, runtime)
  } catch (error) {
    await backend.install({ launch, run: runServiceCommand, log: console.log, warn: console.warn })
    await rename(path.join(root, "deployment.json"), path.join(root, `failed-setup-${randomUUID()}.json`))
    if (target.platform === "win32") await runServiceCommand("schtasks.exe", ["/Change", "/TN", "StillOn Updater", "/DISABLE"])
    else await runServiceCommand("/bin/launchctl", ["bootout", `gui/${process.getuid!()}/com.bzbj.stillon.updater`])
    throw error
  }
  console.log(`Managed updates enabled for ${serviceTarget.platform}/${serviceTarget.architecture}.`)
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
  if (options.action === "status") {
    const file = path.join(root, "state.json")
    console.log(await exists(file) ? JSON.stringify(await json<UpdateState>(file), null, 2) : "No upgrade requested.")
    return
  }
  if (options.action === "request") await enqueueUpdate(deployment, options.tag!, options.prepareOnly)
  await wakeUpdateWorker(deployment)
  console.log("The independent operating-system updater has been requested. This terminal can be closed. Use stillon update status for progress.")
}
