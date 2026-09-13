import path from "node:path"
import type { ManagedUpdateStatus } from "../../shared/protocol"
import { enqueueUpdate } from "./engine"
import { exists, json } from "./files"
import { FINISHED_PHASES, updateRoot, type UpdateControl, type UpdateDeployment, type UpdateState } from "./model"
import { wakeUpdateWorker } from "./native"

export interface ManagedUpdateApi {
  read: () => Promise<ManagedUpdateStatus>
  request: (targetTag: string, prepareOnly?: boolean) => Promise<ManagedUpdateStatus>
}

export function createManagedUpdateApi(runtime: string, root = updateRoot()): ManagedUpdateApi {
  async function configuredDeployment() {
    const file = path.join(root, "deployment.json")
    if (!await exists(file)) return null
    const deployment = await json<UpdateDeployment>(file)
    const control = await json<UpdateControl>(path.join(root, "control.json"))
    const normalize = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value)
    if (normalize(control.runtime) !== normalize(runtime)) return null
    return deployment
  }
  const api: ManagedUpdateApi = {
    async read() {
      const deployment = await configuredDeployment()
      if (!deployment) return { enabled: false, message: "One-time native service setup is required. Custom deployments can continue using installation analysis." }
      const file = path.join(root, "state.json")
      let state = await exists(file) ? await json<UpdateState>(file) : null
      if ((!state || FINISHED_PHASES.has(state.phase)) && await exists(path.join(root, "request.json"))) {
        try { state = await json<UpdateState>(path.join(root, "request.json")) } catch { /* The request is still being flushed. */ }
      }
      return { enabled: true, platform: deployment.platform, architecture: deployment.architecture,
        ...(state ? { phase: state.phase, targetTag: state.targetTag, prepareOnly: state.prepareOnly,
          busy: !FINISHED_PHASES.has(state.phase), message: state.error } : {}),
      }
    },
    async request(targetTag, prepareOnly = false) {
      const deployment = await configuredDeployment()
      if (!deployment) throw new Error("This running instance is not managed by the independent updater.")
      await enqueueUpdate(deployment, targetTag, prepareOnly)
      await wakeUpdateWorker(deployment)
      return { enabled: true, platform: deployment.platform, architecture: deployment.architecture,
        phase: "queued", targetTag, prepareOnly, busy: true }
    },
  }
  return api
}
