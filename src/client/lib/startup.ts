import { useEffect } from "react"

interface StartupController {
  version: 1
  readonly active: boolean
  show(): void
  hold(): void
  fail(): void
  reveal(valid?: () => boolean): void
}

declare global {
  interface Window { StillOnStartup?: StartupController }
}

export function getStartupController() {
  return typeof window !== "undefined" && window.StillOnStartup?.version === 1 ? window.StillOnStartup : undefined
}

/** Cancelling a navigation/session also cancels its pending reveal and exit fade. */
export function useStartupReveal(ready: boolean, scope?: unknown) {
  useEffect(() => {
    const startup = getStartupController()
    if (!startup?.active) return
    if (!ready) { startup.hold(); return }
    let valid = true
    startup.reveal(() => valid)
    return () => { valid = false; startup.hold() }
  }, [ready, scope])
}
