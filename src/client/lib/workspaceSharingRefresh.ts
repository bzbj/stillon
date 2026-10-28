import { SHARING_REFRESH_MS } from "../../shared/sharing-cache"

interface RefreshSource {
  reload: () => Promise<void>
}
interface RefreshEnvironment {
  document: Pick<Document, "hidden" | "addEventListener" | "removeEventListener">
  window: Pick<Window, "addEventListener" | "removeEventListener">
  setTimeout: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void
  random: () => number
}

/** Hidden pages do no work; the store and host coalesce/cache visible readers. */
export function startWorkspaceSharingRefresh(source: RefreshSource, env: RefreshEnvironment) {
  let stopped = false, running = false, failures = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const clear = () => { if (timer !== undefined) env.clearTimeout(timer); timer = undefined }
  const schedule = () => {
    clear()
    if (!stopped && !env.document.hidden) {
      const interval = SHARING_REFRESH_MS * 2 ** Math.min(Math.max(failures - 1, 0), 2)
      timer = env.setTimeout(() => { void refresh() }, interval + env.random() * 30_000)
    }
  }
  const refresh = async () => {
    if (stopped || running || env.document.hidden) return
    clear(); running = true
    try { await source.reload(); failures = 0 } catch { failures++ }
    finally { running = false; schedule() }
  }
  const visible = () => { if (env.document.hidden) clear(); else void refresh() }
  env.document.addEventListener("visibilitychange", visible)
  env.window.addEventListener("focus", visible)
  void refresh()
  return () => {
    stopped = true; clear()
    env.document.removeEventListener("visibilitychange", visible)
    env.window.removeEventListener("focus", visible)
  }
}
