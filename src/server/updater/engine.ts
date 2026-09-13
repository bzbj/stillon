import { randomUUID } from "node:crypto"
import { chmod, copyFile, mkdir, open, rename, stat, unlink } from "node:fs/promises"
import path from "node:path"
import { atomicJson, copyTree, exists, inside, json, manifest, sameManifest, type Manifest } from "./files"
import { appCommand, appStatus, localFetch, pauseManagedServer, resumeManagedServer, waitUntil } from "./control"
import { FINISHED_PHASES, newerRelease, releaseTag, SWITCH_PHASES, UPDATE_REPOSITORY, type UpdateControl, type UpdateDeployment, type UpdateRunnerStatus, type UpdateState } from "./model"

export interface UpdateEffects {
  prepare: (state: UpdateState) => Promise<void>
  pause: () => Promise<void>
  resume: (runtime: string) => Promise<void>
  verify: (runtime: string) => Promise<void>
}

export class UpdateEngine {
  constructor(readonly deployment: UpdateDeployment, readonly effects: UpdateEffects) {}
  state!: UpdateState
  get stateFile() { return path.join(this.deployment.root, "state.json") }
  get transaction() { return inside(path.join(this.deployment.root, "transactions"), this.state.id) }

  async save(phase: UpdateState["phase"], fields: Partial<UpdateState> = {}) {
    this.state = { ...this.state, ...fields, phase, updatedAt: new Date().toISOString() }
    await atomicJson(this.stateFile, this.state)
    await atomicJson(path.join(this.transaction, "journal.json"), this.state)
  }

  async restoreData() {
    if (!this.state.newMayHaveStarted || this.state.dataRestored) return
    if (!this.state.backupReady) throw new Error("No verified data backup; recovery remains paused.")
    const data = this.deployment.dataRoot
    const parent = path.dirname(data)
    const backup = path.join(this.transaction, "data")
    const staged = inside(parent, `${path.basename(data)}-restore-${this.state.id}`)
    const quarantine = inside(parent, `${path.basename(data)}-after-failed-${this.state.id}`)
    if (this.state.dataExisted) {
      const expected = await json<Manifest>(path.join(this.transaction, "data-manifest.json"))
      if (!sameManifest(expected, await manifest(backup))) throw new Error("Data backup checksum mismatch.")
      if (await exists(data) && await exists(quarantine) && sameManifest(expected, await manifest(data))) {
        await this.save("rolling-back", { dataRestored: true })
        return
      }
      if (await exists(staged) && !sameManifest(expected, await manifest(staged))) {
        await rename(staged, inside(parent, `${path.basename(staged)}-incomplete-${randomUUID()}`))
      }
      if (!await exists(staged)) await copyTree(backup, staged)
    }
    if (await exists(data)) {
      // manifest rejects symlinks/junctions before any rename.
      await manifest(data)
      if (await exists(quarantine)) throw new Error("Refusing to overwrite either recovered or quarantined data.")
      await rename(data, quarantine)
    }
    if (this.state.dataExisted) await rename(staged, data)
    await this.save("rolling-back", { dataRestored: true })
  }

  async rollback(reason: string) {
    await this.save("rolling-back", { error: reason })
    await this.effects.pause()
    await this.restoreData()
    await this.effects.resume(this.state.oldRuntime)
    await this.effects.verify(this.state.oldRuntime)
    await this.save("rolled-back")
  }

  async execute() {
    this.state = await json<UpdateState>(this.stateFile)
    if (FINISHED_PHASES.has(this.state.phase)) return
    try {
      if (SWITCH_PHASES.has(this.state.phase)) {
        await this.rollback("An interrupted switch was recovered by the independent updater.")
        return
      }
      if (this.state.phase !== "queued") {
        await this.save("failed", { error: "Preparation was interrupted; the old version remains selected. Submit a new request." })
        return
      }
      await this.save("preparing")
      await this.effects.prepare(this.state)
      if (this.state.prepareOnly) { await this.save("prepared"); return }
      await this.save("pausing")
      await this.effects.pause()
      await this.save("backing-up")
      const dataExisted = await exists(this.deployment.dataRoot)
      if (dataExisted) {
        const files = await copyTree(this.deployment.dataRoot, path.join(this.transaction, "data"))
        await atomicJson(path.join(this.transaction, "data-manifest.json"), files)
      }
      await this.save("starting", { backupReady: true, dataExisted, newMayHaveStarted: true })
      await this.effects.resume(this.state.newRuntime)
      await this.save("verifying")
      await this.effects.verify(this.state.newRuntime)
      await this.save("succeeded")
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Update failed."
      if (!SWITCH_PHASES.has(this.state.phase)) {
        await this.save("failed", { error: reason })
        return
      }
      try { await this.rollback(reason) } catch (failure) {
        await this.save("recovery-required", { error: failure instanceof Error ? failure.message : "Recovery failed; retained all backups." })
        throw failure
      }
    }
  }
}

export async function updateCommand(command: string[], cwd: string, timeout = 120_000, log?: string) {
  const child = Bun.spawn(command, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" } })
  const timer = setTimeout(() => child.kill(), timeout)
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).arrayBuffer(), new Response(child.stderr).arrayBuffer()])
    if (log) {
      const file = await open(log, "a", 0o600)
      try { await file.write(Buffer.from(stdout)); await file.write(Buffer.from(stderr)) } finally { await file.close() }
    }
    if (code !== 0) throw new Error(`${path.basename(command[0])} failed (${code}). See the local transaction log.`)
    return Buffer.from(stdout)
  } finally { clearTimeout(timer) }
}

async function verifyBuildBaseline(deployment: UpdateDeployment, runtime: string) {
  const baselines = await json<Record<string, Manifest>>(path.join(deployment.root, "build-manifests.json"))
  if (!baselines[runtime] || !sameManifest(baselines[runtime], await manifest(path.join(runtime, "dist")))) {
    throw new Error("Built files were customized or have no verified baseline. Move those changes into public/src and rebuild before updating.")
  }
}

export async function verifyRuntime(deployment: UpdateDeployment, runtime: string) {
  const version = (await json<{ version: string }>(path.join(runtime, "package.json"))).version
  const html = Buffer.from(await Bun.file(path.join(runtime, "dist/client/index.html")).arrayBuffer())
  const assets = [...html.toString().matchAll(/(?:src|href)="(\/assets\/[^"?#]+)/g)].map((match) => match[1])
  if (!assets.length) throw new Error("The prepared application has no built client assets.")
  await waitUntil(async () => {
    try {
      const health = await appStatus(deployment)
      const runner = await json<UpdateRunnerStatus>(path.join(deployment.root, "runner.json"))
      if (runner.error) throw new Error(runner.error)
      if (!health?.ok || health.updateProtocol !== 1 || health.version !== version || health.updateInstance !== runner.instance || runner.runtime !== runtime) return false
      const response = await localFetch(`http://127.0.0.1:${deployment.port}/`)
      if (!Buffer.from(await response.arrayBuffer()).equals(html)) return false
      for (const asset of new Set(assets)) {
        const expected = Buffer.from(await Bun.file(inside(path.join(runtime, "dist/client"), asset.slice(1))).arrayBuffer())
        const served = await localFetch(`http://127.0.0.1:${deployment.port}${asset}`)
        if (!served.ok || !Buffer.from(await served.arrayBuffer()).equals(expected)) return false
      }
      return true
    } catch { return false }
  })
  await Bun.sleep(2_000)
  const health = await appStatus(deployment)
  if (!health?.ok || health.version !== version) throw new Error("New runtime stopped during the stability check.")
}

export async function prepareSource(deployment: UpdateDeployment, state: UpdateState) {
  const old = state.oldRuntime
  const runtime = state.newRuntime
  const transaction = inside(path.join(deployment.root, "transactions"), state.id)
  await mkdir(transaction, { recursive: true, mode: 0o700 })
  await verifyBuildBaseline(deployment, old)
  const before = await manifest(old, true)
  for (const name of [".stillon", ".stillon-dev", ".kanna", ".kanna-dev"]) {
    if (await exists(path.join(old, name))) throw new Error("Runtime-local user data needs manual migration.")
  }
  const oldTag = releaseTag((await json<{ version: string }>(path.join(old, "package.json"))).version)
  if (!state.prepareOnly && !newerRelease(state.targetTag, oldTag)) throw new Error("The requested release must be newer than the active version.")
  const patch = path.join(transaction, "customizations.patch")
  await updateCommand(["git", "diff", "--binary", "--no-ext-diff", "--no-textconv", `--output=${patch}`, `refs/tags/${oldTag}`, "--"], old)
  const tracked = new Set((await updateCommand(["git", "ls-files", "-z"], old)).toString().split("\0"))
  const extras = Object.keys(before).filter((name) => !tracked.has(name))
  await atomicJson(path.join(transaction, "customizations.json"), { baseTag: oldTag, extraFiles: extras })
  for (const name of extras) {
    const backup = inside(path.join(transaction, "custom-files"), name)
    await mkdir(path.dirname(backup), { recursive: true, mode: 0o700 })
    await copyFile(inside(old, name), backup)
  }
  await mkdir(path.dirname(runtime), { recursive: true })
  await updateCommand(["git", "clone", "--no-hardlinks", "--no-checkout", old, runtime], transaction, 300_000)
  await updateCommand(["git", "remote", "set-url", "origin", UPDATE_REPOSITORY], runtime)
  await updateCommand(["git", "fetch", "--depth=1", "origin", `refs/tags/${state.targetTag}:refs/tags/${state.targetTag}`], runtime, 300_000)
  await updateCommand(["git", "checkout", "--detach", `refs/tags/${state.targetTag}`], runtime)
  if ((await stat(patch)).size) {
    try {
      await updateCommand(["git", "apply", "--check", "--binary", patch], runtime)
      await updateCommand(["git", "apply", "--binary", patch], runtime)
    } catch { throw new Error("Local customizations conflict with this release. The saved patch needs review; the old version is unchanged.") }
  }
  const targetFiles = await manifest(runtime, true)
  for (const name of extras) {
    if (targetFiles[name] && targetFiles[name] !== before[name]) throw new Error("A custom file conflicts with a new release file.")
    const destination = inside(runtime, name)
    await mkdir(path.dirname(destination), { recursive: true })
    await copyFile(inside(path.join(transaction, "custom-files"), name), destination)
    await chmod(destination, (await stat(inside(old, name))).mode & 0o777)
  }
  if (releaseTag((await json<{ version: string }>(path.join(runtime, "package.json"))).version) !== state.targetTag) {
    throw new Error("The release tag does not match the prepared package version.")
  }
  const log = path.join(transaction, "build.log")
  await updateCommand([deployment.launch.executable, "install", "--frozen-lockfile"], runtime, 900_000, log)
  await updateCommand([deployment.launch.executable, "run", "build"], runtime, 900_000, log)
  // CLI/architecture preflight uses the exact Bun executable and fresh native dependencies.
  const version = (await updateCommand([deployment.launch.executable, path.join(runtime, "bin/stillon"), "--version"], runtime)).toString().trim()
  if (releaseTag(version) !== state.targetTag) throw new Error("Prepared executable version mismatch.")
  await probeRuntime(deployment, runtime, transaction)
  if (!sameManifest(before, await manifest(old, true))) throw new Error("Local customizations changed during preparation; retry without switching.")
  await verifyBuildBaseline(deployment, old)
  const baselines = await json<Record<string, Manifest>>(path.join(deployment.root, "build-manifests.json"))
  baselines[runtime] = await manifest(path.join(runtime, "dist"))
  await atomicJson(path.join(deployment.root, "build-manifests.json"), baselines)
  if (!state.prepareOnly) {
    const runner = await json<UpdateRunnerStatus>(path.join(deployment.root, "runner.json"))
    await appCommand(deployment, runner.secret, "check")
  }
}

export async function probeRuntime(deployment: UpdateDeployment, runtime: string, transaction: string) {
  const portReservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) })
  const port = portReservation.port!
  await portReservation.stop(true)
  const root = path.join(transaction, "probe")
  const home = path.join(root, "home")
  await mkdir(home, { recursive: true, mode: 0o700 })
  const probe: UpdateDeployment = { ...deployment, root, dataRoot: path.join(home, ".stillon"), port,
    launch: { ...deployment.launch, homeDirectory: home, workingDirectory: runtime, environmentFile: undefined,
      args: [path.join(runtime, "bin", "stillon"), "--no-open", "--strict-port", "--host", "127.0.0.1", "--port", String(port)] } }
  const instance = randomUUID()
  const secret = randomUUID()
  await atomicJson(path.join(root, "deployment.json"), probe)
  await atomicJson(path.join(root, "runner.json"), { runtime, stopped: false, instance, secret })
  const env = { ...process.env, HOME: home, USERPROFILE: home, STILLON_UPDATE_PROBE: "1" }
  for (const key of Object.keys(env)) {
    if (/^(?:OPENAI_|ANTHROPIC_|CODEX_|CLAUDE_|STILLON_)/.test(key) && key !== "STILLON_UPDATE_PROBE") delete env[key as keyof typeof env]
  }
  const child = Bun.spawn([deployment.launch.executable, "--no-env-file", deployment.controller, "app", root, runtime, instance, secret, "1"], {
    cwd: runtime, env, stdin: "ignore", stdout: Bun.file(path.join(root, "stdout.log")), stderr: Bun.file(path.join(root, "stderr.log")),
  })
  try { await verifyRuntime(probe, runtime) } finally {
    try { await appCommand(probe, secret, "pause") } catch { child.kill() }
    await Promise.race([child.exited, Bun.sleep(5_000).then(() => child.kill())])
    await child.exited
  }
}

export async function enqueueUpdate(deployment: UpdateDeployment, target: string, prepareOnly = false) {
  const tag = releaseTag(target)
  const request = path.join(deployment.root, "request.json")
  // A separate exclusive request file prevents requests from overwriting worker state.
  const handle = await open(request, "wx", 0o600)
  try {
    const stateFile = path.join(deployment.root, "state.json")
    if (await exists(stateFile) && !FINISHED_PHASES.has((await json<UpdateState>(stateFile)).phase)) throw new Error("An update or recovery is already pending.")
    const control = await json<UpdateControl>(path.join(deployment.root, "control.json"))
    const id = randomUUID()
    const state: UpdateState = { id, targetTag: tag, prepareOnly, oldRuntime: control.runtime,
      newRuntime: inside(path.join(deployment.root, "releases"), `${id}/${tag}`), phase: "queued", updatedAt: new Date().toISOString() }
    await handle.writeFile(JSON.stringify(state))
    await handle.sync()
    return state
  } catch (error) {
    await handle.close()
    await unlink(request)
    throw error
  } finally { await handle.close() }
}

export async function claimRequest(deployment: UpdateDeployment) {
  const request = path.join(deployment.root, "request.json")
  if (!await exists(request)) return
  let candidate: UpdateState
  try { candidate = await json<UpdateState>(request) } catch {
    if (Date.now() - (await stat(request)).mtimeMs < 30_000) return
    await rename(request, path.join(deployment.root, `incomplete-request-${randomUUID()}.json`))
    return
  }
  const file = path.join(deployment.root, "state.json")
  if (await exists(file)) {
    const previous = await json<UpdateState>(file)
    if (previous.id === candidate.id) { await unlink(request); return }
    if (!FINISHED_PHASES.has(previous.phase)) return
  }
  await atomicJson(file, candidate)
  await unlink(request)
}

export function realUpdateEffects(deployment: UpdateDeployment): UpdateEffects {
  return { prepare: (state) => prepareSource(deployment, state), pause: () => pauseManagedServer(deployment),
    resume: (runtime) => resumeManagedServer(deployment, runtime), verify: (runtime) => verifyRuntime(deployment, runtime) }
}
