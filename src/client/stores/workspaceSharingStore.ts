import { create } from "zustand"
import type { WorkspaceSharingSnapshot } from "../../shared/connect"

export type SharingView = WorkspaceSharingSnapshot & { mode: "owner" | "guest"; configured?: boolean; portalUrl?: string | null; workspaceId?: string }
let generation = 0
export const useWorkspaceSharingStore = create<{
  view: SharingView | null; error: string | null; reload: () => Promise<void>; change: (body: unknown) => Promise<{ invitationUrl?: string; delivery?: string }>
}>((set, get) => ({
  view: null, error: null,
  async reload() {
    const requestedGeneration = generation
    const response = await fetch("/api/workspace-sharing", { cache: "no-store", signal: AbortSignal.timeout(15_000) })
    if (!response.ok) throw new Error("Unable to load sharing. Please retry.")
    const view = await response.json()
    if (requestedGeneration === generation) set({ view, error: null })
  },
  async change(body) {
    generation++
    const response = await fetch("/api/workspace-sharing", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error === "NOT_BOUND" ? "Link your email in Remote access first." : "Unable to update sharing. Please retry.")
    set({ view: { ...get().view!, workspaces: result.workspaces }, error: null })
    return result
  },
}))
export function isSharedWorkspaceBrowser() {
  return typeof window !== "undefined" && /^w-[a-f0-9]{32}\./.test(window.location.hostname)
}
