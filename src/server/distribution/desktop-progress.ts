import path from "node:path"
import { runServiceCommand } from "../service"
import { json } from "../updater/files"
import { TRANSITION_FILE, type DesktopTransition } from "./transition"

export const DESKTOP_WAIT_MS = 15 * 60_000
export const DESKTOP_PROGRESS_PREFIX = "STILLON_DESKTOP_PROGRESS: "

export function desktopProgress(message: string) {
  console.log(`${DESKTOP_PROGRESS_PREFIX}${message}`)
}

/** Opening a browser is a convenience after a healthy installation. */
export async function openDesktopBrowser(port: number, options: {
  platform?: NodeJS.Platform
  run?: typeof runServiceCommand
  warn?: (message: string) => void
} = {}) {
  const platform = options.platform ?? process.platform
  const url = `http://127.0.0.1:${port}`
  try {
    const result = await (options.run ?? runServiceCommand)(platform === "darwin" ? "/usr/bin/open" : "explorer.exe", [url])
    // Explorer hands URLs to the existing shell and can return 1 on success.
    if (!result.signal && (result.code === 0 || (platform === "win32" && result.code === 1))) return
  } catch { /* The service remains usable when a desktop handler is unavailable. */ }
  ;(options.warn ?? console.warn)(`StillOn is ready. Open ${url} in your browser.`)
}

export async function waitForDesktopTransition(root: string, options: {
  read?: () => Promise<Pick<DesktopTransition, "phase" | "error">>
  progress?: (message: string) => void
  now?: () => number
  sleep?: () => Promise<unknown>
  timeoutMs?: number
} = {}) {
  const now = options.now ?? Date.now
  const deadline = now() + (options.timeoutMs ?? DESKTOP_WAIT_MS)
  const progress = options.progress ?? desktopProgress
  let previous: DesktopTransition["phase"] | undefined
  while (true) {
    const state = await (options.read ?? (() => json<DesktopTransition>(path.join(root, TRANSITION_FILE))))()
    if (["failed", "rolled-back", "recovery-required"].includes(state.phase)) throw new Error(state.error ?? "Desktop migration needs recovery; your original installation and data have been kept.")
    if (state.phase === "succeeded") { progress("StillOn is ready."); return }
    if (state.phase !== previous) {
      progress(state.phase === "queued" ? "Waiting for the independent updater…" : "Updating StillOn and verifying the service… This may take several minutes.")
      previous = state.phase
    }
    if (now() >= deadline) throw new Error("StillOn is still updating in the background. Reopen StillOn to check its progress; do not reinstall while the update is running.")
    await (options.sleep ?? (() => Bun.sleep(250)))()
  }
}
