import { randomUUID } from "node:crypto"
import path from "node:path"
import { atomicJson, exists, json } from "./files"
import { SWITCH_PHASES, UPDATE_PHASES, type UpdateControl, type UpdateDeployment, type UpdateLease, type UpdateRunnerStatus, type UpdateState } from "./model"
import { stopOrphanedApp } from "./processes"

export async function localFetch(url: string, init: RequestInit = {}) {
  const options = { ...init, proxy: null, signal: AbortSignal.timeout(3_000) }
  return fetch(url, options)
}

export async function leaseAlive(root: string) {
  try {
    const lease = await json<UpdateLease>(path.join(root, "lease.json"))
    if (!Number.isInteger(lease.port) || lease.port < 1 || lease.port > 65535) return false
    const response = await localFetch(`http://127.0.0.1:${lease.port}/lease`, { headers: { Authorization: `Bearer ${lease.token}` } })
    return response.ok && (await response.text()) === lease.token
  } catch { return false }
}

export async function launchAllowed(root: string) {
  try {
    if (!await exists(path.join(root, "state.json"))) return true
    const state = await json<UpdateState>(path.join(root, "state.json"))
    if (!state || !UPDATE_PHASES.has(state.phase)) return false
    return !SWITCH_PHASES.has(state.phase) || await leaseAlive(root)
  } catch { return false }
}

export async function appStatus(deployment: UpdateDeployment) {
  try {
    const response = await localFetch(`http://127.0.0.1:${deployment.port}/health`)
    if (!response.ok) return null
    return await response.json() as { ok: boolean; port: number; updateInstance?: string; updateProtocol?: number; version?: string }
  } catch { return null }
}

export async function appCommand(deployment: UpdateDeployment, secret: string, command: "pause" | "resume" | "check") {
  const response = await localFetch(`http://127.0.0.1:${deployment.port}/_stillon/update/${command}`, {
    method: "POST", headers: { Authorization: `Bearer ${secret}` },
  })
  if (!response.ok) throw new Error(response.status === 409
    ? "Finish active agent turns and close embedded terminals before updating."
    : "The managed server did not acknowledge the update controller.")
}

export async function waitUntil(test: () => Promise<boolean>, timeout = 60_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await test()) return
    await Bun.sleep(250)
  }
  throw new Error("Timed out waiting for the managed server.")
}

export async function runServerController(deployment: UpdateDeployment) {
  const root = deployment.root
  const statusFile = path.join(root, "runner.json")
  let child: ReturnType<typeof Bun.spawn> | null = null
  let last: UpdateRunnerStatus = await exists(statusFile)
    ? await json<UpdateRunnerStatus>(statusFile)
    : { runtime: "", stopped: true, instance: "", secret: "" }

  // A prior controller may have died while its application child survived.
  // Only the saved unguessable instance can authorize shutdown; never kill a PID
  // merely because it occupies the configured port.
  const orphan = await appStatus(deployment)
  if (orphan) {
    if (!last.instance || orphan.updateInstance !== last.instance) throw new Error("An unrecognized process owns the StillOn port.")
    await appCommand(deployment, last.secret, "pause")
    await waitUntil(async () => !await appStatus(deployment))
  }
  if (last.secret && last.instance) await stopOrphanedApp(deployment, last)
  last.stopped = true
  await atomicJson(statusFile, last)

  async function stopApp() {
    const live = await appStatus(deployment)
    if (live) {
      if (live.updateInstance !== last.instance) throw new Error("The server instance changed unexpectedly.")
      await appCommand(deployment, last.secret, "pause")
      await waitUntil(async () => !await appStatus(deployment))
    }
    if (child) {
      if (!live && child.exitCode === null) child.kill()
      await Promise.race([child.exited, Bun.sleep(10_000).then(() => { throw new Error("The previous server process did not exit.") })])
      child = null
    }
    if (last.secret && last.instance) await stopOrphanedApp(deployment, last)
    last = { ...last, stopped: true, error: undefined }
    await atomicJson(statusFile, last)
  }

  for (;;) {
    try {
      const control = await json<UpdateControl>(path.join(root, "control.json"))
      const permitted = await launchAllowed(root)
      if (control.paused || !permitted || (child && last.runtime !== control.runtime)) {
        await stopApp()
      } else {
        if (child?.exitCode !== null) child = null
        if (!child) {
          const state = await exists(path.join(root, "state.json")) ? await json<UpdateState>(path.join(root, "state.json")) : null
          last = { runtime: control.runtime, stopped: false, instance: randomUUID(), secret: randomUUID() }
          // Persist identity before spawn, so an interrupted spawn can be recovered.
          await atomicJson(statusFile, last)
          const envArgs = deployment.launch.environmentFile ? ["--env-file", deployment.launch.environmentFile] : ["--no-env-file"]
          child = Bun.spawn([deployment.launch.executable, ...envArgs, deployment.controller, "app", root, control.runtime, last.instance, last.secret,
            state && SWITCH_PHASES.has(state.phase) ? "1" : "0"], {
            cwd: control.runtime, stdin: "ignore", stdout: "inherit", stderr: "inherit",
            env: { ...process.env, HOME: deployment.launch.homeDirectory, USERPROFILE: deployment.launch.homeDirectory,
              STILLON_RUNTIME_PROFILE: "prod" },
          })
          child.exited.catch(() => {})
        }
        if (child && !await exists(path.join(root, "state.json"))) {
          // Initial setup starts unpaused through the environment above.
        } else if (child) {
          const state = await json<UpdateState>(path.join(root, "state.json"))
          if (!SWITCH_PHASES.has(state.phase)) {
            const live = await appStatus(deployment)
            if (live?.updateInstance === last.instance) await appCommand(deployment, last.secret, "resume")
          }
        }
      }
      if (last.error) { last.error = undefined; await atomicJson(statusFile, last) }
    } catch (error) {
      last.error = error instanceof Error ? error.message : "Update controller failed."
      await atomicJson(statusFile, last)
    }
    await Bun.sleep(1_000)
  }
}

export async function pauseManagedServer(deployment: UpdateDeployment) {
  const controlFile = path.join(deployment.root, "control.json")
  const control = await json<UpdateControl>(controlFile)
  await atomicJson(controlFile, { ...control, paused: true })
  await waitUntil(async () => {
    const status = await json<UpdateRunnerStatus>(path.join(deployment.root, "runner.json"))
    if (status.error) throw new Error(status.error)
    return status.stopped && !await appStatus(deployment)
  })
}

export async function resumeManagedServer(deployment: UpdateDeployment, runtime: string) {
  await atomicJson(path.join(deployment.root, "control.json"), { runtime, paused: false })
}
