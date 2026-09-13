import os from "node:os"
import path from "node:path"
import type { ServiceLaunchSpec } from "../service/types"

export type UpdatePlatform = "darwin" | "win32"
export type UpdateArchitecture = "x64" | "arm64"
export type UpdatePhase = "queued" | "preparing" | "prepared" | "pausing" | "backing-up"
  | "starting" | "verifying" | "rolling-back" | "recovery-required" | "succeeded" | "rolled-back" | "failed"

export interface UpdateDeployment {
  schema: 1
  platform: UpdatePlatform
  architecture: UpdateArchitecture
  launch: ServiceLaunchSpec
  port: number
  root: string
  controller: string
  dataRoot: string
}

export interface UpdateState {
  id: string
  phase: UpdatePhase
  targetTag: string
  prepareOnly: boolean
  oldRuntime: string
  newRuntime: string
  updatedAt: string
  error?: string
  backupReady?: boolean
  dataExisted?: boolean
  newMayHaveStarted?: boolean
  dataRestored?: boolean
}

export interface UpdateControl {
  runtime: string
  paused: boolean
}

export interface UpdateLease { port: number; token: string }
export interface UpdateRunnerStatus {
  runtime: string
  stopped: boolean
  instance: string
  secret: string
  error?: string
}

export const FINISHED_PHASES = new Set<UpdatePhase>(["prepared", "succeeded", "rolled-back", "failed"])
export const SWITCH_PHASES = new Set<UpdatePhase>(["pausing", "backing-up", "starting", "verifying", "rolling-back", "recovery-required"])
export const UPDATE_PHASES = new Set<UpdatePhase>([...FINISHED_PHASES, ...SWITCH_PHASES, "queued", "preparing"])
export const SETUP_SWITCH_PHASES = new Set(["installing", "verifying", "restoring", "recovery-required"])
export const UPDATE_REPOSITORY = "https://github.com/bzbj/stillon.git"

export function updateTarget(platform = process.platform, architecture = process.arch) {
  if (platform !== "darwin" && platform !== "win32") {
    throw new Error("Managed source updates currently support macOS and Windows. Use the source-upgrade prompt for this platform.")
  }
  if (architecture !== "x64" && architecture !== "arm64") {
    throw new Error(`Managed updates do not support this Bun architecture: ${architecture}`)
  }
  // Install with this same Bun executable. An x64 Bun under emulation must keep
  // x64 native dependencies; host marketing names (including Surface) are irrelevant.
  return { platform, architecture }
}

export function updateRoot(platform = process.platform, home = os.homedir(), localAppData = process.env.LOCALAPPDATA) {
  if (platform === "win32") {
    return path.win32.join(localAppData || path.win32.join(home, "AppData", "Local"), "StillOn", "ManagedUpdates")
  }
  return path.posix.join(home, "Library", "Application Support", "StillOn", "ManagedUpdates")
}

export function releaseTag(value: string) {
  if (!/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw new Error("Choose a stable release tag such as v0.2.15.")
  }
  return `v${value.replace(/^v/, "")}`
}

export function newerRelease(target: string, current: string) {
  const a = releaseTag(target).slice(1).split(".").map(Number)
  const b = releaseTag(current).slice(1).split(".").map(Number)
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i]
  }
  return false
}
