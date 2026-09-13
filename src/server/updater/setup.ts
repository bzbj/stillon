import path from "node:path"
import { resolveServiceBackend, runServiceCommand } from "../service"
import type { ServiceCommandRunner } from "../service/types"
import { localFetch, waitUntil } from "./control"
import { verifyRuntime } from "./engine"
import { atomicJson, json } from "./files"
import { SETUP_SWITCH_PHASES, type UpdateDeployment } from "./model"
import { verifyServiceRegistration, type ServiceRegistration } from "./registration"
import { stopWindowsEncodedProcesses, stopWindowsServiceProcesses } from "./processes"

export interface SetupState {
  phase: "prepared" | "queued" | "installing" | "verifying" | "restoring" | "recovery-required" | "enabled" | "restored" | "failed"
  registration: ServiceRegistration
  updatedAt: string
  error?: string
}

export interface SetupEffects {
  check: () => Promise<void>
  install: () => Promise<void>
  verify: () => Promise<void>
  restore: () => Promise<void>
}

export async function checkSetupReadiness(deployment: UpdateDeployment) {
  const response = await localFetch(`http://127.0.0.1:${deployment.port}/health?update-setup=1`)
  const readiness = await response.json() as { ok?: boolean; managedUpdateProtocol?: number; runtimeProfile?: string; busy?: boolean }
  if (!response.ok || !readiness.ok || readiness.managedUpdateProtocol !== 1 || readiness.runtimeProfile !== "prod" || readiness.busy !== false) {
    throw new Error("Start this release and finish active agent/terminal work before enabling managed updates.")
  }
}

/** Only the independent worker may replace the original application service. */
export async function runSetupTransaction(deployment: UpdateDeployment, effects: SetupEffects) {
  const file = path.join(deployment.root, "setup.json")
  let state = await json<SetupState>(file)
  if (["prepared", "enabled", "restored", "failed"].includes(state.phase)) return state.phase === "enabled"
  if (state.phase !== "queued" && !SETUP_SWITCH_PHASES.has(state.phase)) throw new Error("Unknown setup phase; inspect the retained journal.")
  async function save(phase: SetupState["phase"], error = state.error) {
    state = { ...state, phase, error, updatedAt: new Date().toISOString() }
    await atomicJson(file, state)
  }
  async function restore(reason: string) {
    await save("restoring", reason)
    await effects.restore()
    await save("restored")
  }
  try {
    if (SETUP_SWITCH_PHASES.has(state.phase)) {
      await restore("An interrupted first-time setup was recovered by the independent worker.")
      return false
    }
    await effects.check()
    await save("installing")
    await effects.install()
    await save("verifying")
    await effects.verify()
    await save("enabled")
    return true
  } catch (error) {
    const reason = error instanceof Error ? error.message : "First-time setup failed."
    if (state.phase === "queued") { await save("failed", reason); return false }
    if (state.phase === "restoring") { await save("recovery-required", reason); throw error }
    try { await restore(reason) } catch (failure) {
      await save("recovery-required", failure instanceof Error ? failure.message : "Original service recovery failed.")
      throw failure
    }
    return false
  }
}

export function realSetupEffects(deployment: UpdateDeployment, registration: ServiceRegistration, run: ServiceCommandRunner = runServiceCommand): SetupEffects {
  const backend = resolveServiceBackend(deployment.platform)
  const context = { run, log: console.log, warn: console.warn }
  const managed = { ...deployment.launch, args: [deployment.controller, "serve", deployment.root], workingDirectory: deployment.root, environmentFile: undefined }
  async function stopWindowsServices() {
    if (deployment.platform !== "win32") return
    if (!registration.windowsCommand) throw new Error("Original watchdog identity is missing; retained setup journal for inspection.")
    await run("schtasks.exe", ["/End", "/TN", "StillOn"])
    await stopWindowsEncodedProcesses(registration.windowsCommand)
    await stopWindowsServiceProcesses(managed)
  }
  return {
    async check() {
      await verifyServiceRegistration(registration, run)
      await checkSetupReadiness(deployment)
    },
    async install() {
      await stopWindowsServices()
      await backend.install({ ...context, launch: managed })
    },
    verify: () => verifyRuntime(deployment, deployment.launch.workingDirectory),
    async restore() {
      await stopWindowsServices()
      await backend.install({ ...context, launch: registration.launch })
      await waitUntil(async () => { try { await checkSetupReadiness(deployment); return true } catch { return false } })
    },
  }
}
