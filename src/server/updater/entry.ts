import { refreshCliEnvironment } from "../cli-environment"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { exists, json } from "./files"
import { runServerController } from "./control"
import { claimRequest, realUpdateEffects, UpdateEngine, type UpdateEffects } from "./engine"
import { desktopTransitionPending, updateTarget, type UpdateDeployment } from "./model"
import { withWorkerLease } from "./lease"
export { withWorkerLease } from "./lease"
import { realSetupEffects, runSetupTransaction, type SetupEffects, type SetupState } from "./setup"

export async function worker(deployment: UpdateDeployment, effects: {
  setup?: (setup: SetupState) => SetupEffects
  update?: UpdateEffects
} = {}) {
  if (await desktopTransitionPending(deployment.root)) return
  return withWorkerLease(deployment, async () => {
    const root = deployment.root
    if (await exists(path.join(root, "setup.json"))) {
      const setup = await json<SetupState>(path.join(root, "setup.json"))
      if (!await runSetupTransaction(deployment, effects.setup?.(setup) ?? realSetupEffects(deployment, setup.registration))) return
    }
    await claimRequest(deployment)
    if (await exists(path.join(root, "state.json"))) await new UpdateEngine(deployment, effects.update ?? realUpdateEffects(deployment)).execute()
  })
}

export async function controllerMain(args = process.argv.slice(2)) {
  if (process.env.STILLON_REFRESH_PATH === "1") {
    process.env.PATH = (await refreshCliEnvironment()).PATH
  }
  const [mode, root] = args
  if (!root) throw new Error("Missing managed update directory.")
  if (mode === "desktop-worker") {
    const { runDesktopTransitionWorker } = await import("../distribution/transition")
    return runDesktopTransitionWorker(root)
  }
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
    process.argv = [process.execPath, entrypoint, ...deployment.launch.args.slice(index + 1)]
    await import(pathToFileURL(entrypoint).href)
    return
  }
  throw new Error("Unknown updater controller mode.")
}

if (import.meta.main) await controllerMain()
