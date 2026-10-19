import type { ChatDiffSnapshot, ProjectGitSnapshotData } from "../../shared/types"
import type { StillOnSocket } from "../app/socket"

export function subscribeProjectGit(socket: Pick<StillOnSocket, "subscribe">, projectId: string, receive: (snapshot: ChatDiffSnapshot | null) => void) {
  let generation = 0
  let pending: AbortController | null = null
  let retryNeeded = false
  let disposed = false
  const cancelPending = () => { generation++; pending?.abort(); pending = null }
  const load = async () => {
    cancelPending()
    const version = generation
    const controller = new AbortController()
    pending = controller
    retryNeeded = false
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/git-snapshot`, { cache: "no-store", signal: controller.signal })
      if (!response.ok) throw new Error("Git snapshot unavailable")
      const snapshot = await response.json() as ChatDiffSnapshot
      if (disposed || version !== generation) return
      receive(snapshot)
    } catch {
      if (!disposed && version === generation) retryNeeded = true
    } finally {
      if (pending === controller) pending = null
    }
  }
  const unsubscribe = socket.subscribe<ProjectGitSnapshotData>({ type: "project-git", projectId, deferLargeSnapshots: true }, snapshot => {
    if (snapshot && "deferred" in snapshot) { void load(); return }
    cancelPending()
    retryNeeded = false
    receive(snapshot)
  })
  const retry = () => { if (retryNeeded && !disposed) void load() }
  const events = typeof window === "undefined" ? null : window
  events?.addEventListener("focus", retry)
  events?.addEventListener("online", retry)
  return () => {
    disposed = true
    cancelPending()
    unsubscribe()
    events?.removeEventListener("focus", retry)
    events?.removeEventListener("online", retry)
  }
}
