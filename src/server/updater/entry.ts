import { randomUUID } from "node:crypto"
import { mkdir, rename, rmdir, stat, unlink } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { atomicJson, exists, json } from "./files"
import { leaseAlive, runServerController } from "./control"
import { claimRequest, realUpdateEffects, UpdateEngine, type UpdateEffects } from "./engine"
import { updateTarget, type UpdateDeployment } from "./model"
import { realSetupEffects, runSetupTransaction, type SetupEffects, type SetupState } from "./setup"

export async function worker(deployment: UpdateDeployment, effects: {
  setup?: (setup: SetupState) => SetupEffects
  update?: UpdateEffects
} = {}) {
  const root = deployment.root
  // OS task/LaunchAgent serializes invocations; a live lease additionally rejects
  // accidental direct invocations. A process cannot impersonate a dead lease by PID reuse.
  if (await leaseAlive(root)) return
  const lock = path.join(root, "worker.lock")
  try { await mkdir(lock, { mode: 0o700 }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    if (Date.now() - (await stat(lock)).mtimeMs < 30_000) return
    if (await leaseAlive(root)) return
    await rename(lock, path.join(root, `stale-worker-lock-${randomUUID()}`))
    await mkdir(lock, { mode: 0o700 })
  }
  const token = randomUUID()
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(request) { return request.headers.get("authorization") === `Bearer ${token}`
      ? new Response(token) : new Response(null, { status: 403 }) } })
  try {
    await atomicJson(path.join(root, "lease.json"), { port: server.port, token })
    if (await exists(path.join(root, "setup.json"))) {
      const setup = await json<SetupState>(path.join(root, "setup.json"))
      if (!await runSetupTransaction(deployment, effects.setup?.(setup) ?? realSetupEffects(deployment, setup.registration))) return
    }
    await claimRequest(deployment)
    if (await exists(path.join(root, "state.json"))) await new UpdateEngine(deployment, effects.update ?? realUpdateEffects(deployment)).execute()
  } finally {
    server.stop(true)
    await unlink(path.join(root, "lease.json")).catch(() => {})
    // Only remove our empty lock, never recursively remove a transaction or backup.
    await rmdir(lock)
  }
}

export async function controllerMain(args = process.argv.slice(2)) {
  const [mode, root] = args
  if (!root) throw new Error("Missing managed update directory.")
  const deployment = await json<UpdateDeployment>(path.join(root, "deployment.json"))
  const target = updateTarget()
  if (deployment.platform !== target.platform || deployment.architecture !== target.architecture) {
    throw new Error("Use the same platform and Bun architecture as this managed installation.")
  }
  if (mode === "worker") return worker(deployment)
  if (mode === "serve") return runServerController(deployment)
  if (mode === "app") {
    const [, , runtime, instance, secret, verifying] = args
    if (!runtime || !instance || !secret) throw new Error("Missing application instance identity.")
    process.env.HOME = deployment.launch.homeDirectory
    process.env.USERPROFILE = deployment.launch.homeDirectory
    process.env.STILLON_RUNTIME_PROFILE = "prod"
    process.env.STILLON_UPDATE_INSTANCE = instance
    process.env.STILLON_UPDATE_SECRET = secret
    process.env.STILLON_UPDATE_VERIFYING = verifying
    if (process.env.STILLON_UPDATE_PROBE === "1") setTimeout(() => process.exit(1), 90_000)
    const entrypoint = path.join(runtime, "bin", "stillon")
    const sourceEntry = path.join(deployment.launch.workingDirectory, "bin", "stillon")
    const index = deployment.launch.args.indexOf(sourceEntry)
    if (index < 0) throw new Error("Unrecognized StillOn CLI layout.")
    process.argv = [deployment.launch.executable, entrypoint, ...deployment.launch.args.slice(index + 1)]
    await import(pathToFileURL(entrypoint).href)
    return
  }
  throw new Error("Unknown updater controller mode.")
}

if (import.meta.main) await controllerMain()
