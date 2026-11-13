import path from "node:path"
import { atomicJson, json } from "./files"

/**
 * The supervising controller is idle almost all of the time. A runtime event
 * loop can nevertheless get stuck returning immediately from its poller (seen
 * on macOS after a hibernate/AutoPowerOff wake), pinning a core indefinitely
 * while JavaScript keeps running normally. Nothing inside the process can
 * repair the poller, so the controller measures its own CPU use and asks to be
 * restarted by the native service manager once that is safe.
 */
export interface CpuSample { cpuMicros: number; wallMs: number }

export interface SpinDetectorOptions {
  /** Length of one measurement window. */
  windowMs?: number
  /** CPU time / wall time ratio treated as busy. */
  threshold?: number
  /** Consecutive busy windows required before reporting a spin. */
  windows?: number
  sample?: () => CpuSample
}

export const SPIN_WINDOW_MS = 60_000
export const SPIN_THRESHOLD = 0.5
export const SPIN_WINDOWS = 3
/** At most one automatic restart in this period; a recurring spin is only logged. */
export const SPIN_RESTART_COOLDOWN_MS = 6 * 60 * 60 * 1000
/** Distinct exit status so service logs show why the controller left. */
export const SPIN_RESTART_EXIT_CODE = 75

function processSample(): CpuSample {
  const usage = process.cpuUsage()
  return { cpuMicros: usage.user + usage.system, wallMs: performance.now() }
}

export function createSpinDetector(options: SpinDetectorOptions = {}) {
  const windowMs = options.windowMs ?? SPIN_WINDOW_MS
  const threshold = options.threshold ?? SPIN_THRESHOLD
  const required = options.windows ?? SPIN_WINDOWS
  const sample = options.sample ?? processSample
  let start = sample()
  let busyWindows = 0
  let lastRatio = 0
  return {
    /** Record elapsed CPU use; true once it stayed busy for the required consecutive windows. */
    observe() {
      const current = sample()
      const elapsed = current.wallMs - start.wallMs
      if (elapsed < windowMs) return busyWindows >= required
      lastRatio = (current.cpuMicros - start.cpuMicros) / 1000 / elapsed
      busyWindows = lastRatio >= threshold ? busyWindows + 1 : 0
      start = current
      return busyWindows >= required
    },
    get ratio() { return lastRatio },
  }
}

interface SpinRestartRecord { at: string; ratio: number }

/** True when no automatic restart happened within the cooldown period. */
export async function spinRestartAllowed(root: string, now = Date.now(), cooldownMs = SPIN_RESTART_COOLDOWN_MS) {
  try {
    const record = await json<SpinRestartRecord>(path.join(root, "controller-restart.json"))
    const at = Date.parse(record.at)
    return !Number.isFinite(at) || now - at >= cooldownMs || at > now
  } catch { return true }
}

export async function recordSpinRestart(root: string, ratio: number, now = Date.now()) {
  await atomicJson(path.join(root, "controller-restart.json"), { at: new Date(now).toISOString(), ratio: Math.round(ratio * 100) / 100 } satisfies SpinRestartRecord)
}
