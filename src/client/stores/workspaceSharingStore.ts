import { create } from "zustand"
import type { WorkspaceSharingSnapshot } from "../../shared/connect"
import { SharingCache } from "../../shared/sharing-cache"

export type SharingView = WorkspaceSharingSnapshot & { mode: "owner" | "guest"; configured?: boolean; portalUrl?: string | null; workspaceId?: string }
export const SHARING_CHANGED_EVENT = "stillon-sharing-changed"

export function createWorkspaceSharingStore(now = Date.now) {
  let generation = 0
  let mutation = 0
  const cache = new SharingCache<SharingView>(async force => {
    const response = await fetch(`/api/workspace-sharing${force ? "?refresh=1" : ""}`, { cache: "no-store", signal: AbortSignal.timeout(15_000) })
    if (!response.ok) throw new Error("Unable to load sharing. Please retry.")
    return response.json()
  }, now)
  return create<{
    view: SharingView | null; error: string | null; scope: string | null
    setScope: (scope: string | null) => void; invalidate: () => void
    reload: (force?: boolean) => Promise<void>
    change: (body: unknown) => Promise<{ invitationUrl?: string; delivery?: string }>
  }>((set, get) => ({
    view: null, error: null, scope: null,
    setScope(scope) {
      if (scope === get().scope) return
      generation++; mutation++; cache.invalidate(); set({ scope, view: null, error: null })
    },
    invalidate() { generation++; cache.invalidate() },
    async reload(force = false) {
      const requestedGeneration = generation
      try {
        const view = await cache.read(force)
        if (requestedGeneration === generation) set({ view, error: null })
      } catch (error) {
        if (requestedGeneration === generation) set({ error: error instanceof Error ? error.message : "Unable to load sharing." })
        throw error
      }
    },
    async change(body) {
      generation++
      const requestedMutation = ++mutation
      cache.invalidate()
      try {
        const response = await fetch("/api/workspace-sharing", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) })
        const result = await response.json()
        if (!response.ok) throw new Error(result.error === "NOT_BOUND" ? "Link your email in Remote access first." : "Unable to update sharing. Please retry.")
        if (requestedMutation === mutation) {
          generation++
          const view = { ...get().view, ...result } as SharingView
          cache.set(view); set({ view, error: null })
          if (typeof window !== "undefined") window.dispatchEvent(new Event(SHARING_CHANGED_EVENT))
        }
        return result
      } catch (error) {
        if (requestedMutation === mutation) { generation++; cache.invalidate() }
        throw error
      }
    },
  }))
}
export const useWorkspaceSharingStore = createWorkspaceSharingStore()
export function isSharedWorkspaceBrowser() {
  return typeof window !== "undefined" && /^w-[a-f0-9]{32}\./.test(window.location.hostname)
}
