import { useCallback, useEffect, useState } from "react"
import { RefreshCw } from "lucide-react"
import type { SharedWorkspaceEntry } from "../../shared/connect"
import { Button } from "../components/ui/button"

export function SharedWorkspaceList({ workspaces, currentOrigin }: { workspaces: SharedWorkspaceEntry[]; currentOrigin: string }) {
  return <div className="space-y-3">
    {workspaces.length === 0 && <p className="text-sm text-muted-foreground">No workspaces shared with you.</p>}
    {workspaces.map(workspace => <div key={workspace.id} className="flex items-center gap-4 rounded-xl border p-4">
      <div className="min-w-0 flex-1"><p className="break-words text-sm font-medium">{workspace.name}</p><p className="mt-1 text-xs text-muted-foreground">{workspace.online ? "Online" : "Offline"}</p></div>
      {workspace.accepted && workspace.url === currentOrigin ? <span className="text-xs text-muted-foreground">Current workspace</span> : <a className="shrink-0 text-sm underline" href={workspace.accepted ? `${workspace.url}/_connect/login` : workspace.invitationUrl}>{workspace.accepted ? "Switch" : "Accept invitation"}</a>}
    </div>)}
  </div>
}

export function SharedWorkspacesSettings({ remote }: { remote: boolean }) {
  const [workspaces, setWorkspaces] = useState<SharedWorkspaceEntry[] | null>(null)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const endpoint = remote ? "/_connect/shared-workspaces" : "/api/connect-local/shared-workspaces"
  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    try {
      const response = await fetch(endpoint, { cache: "no-store", redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) })
      if (!response.ok) throw new Error("Unable to load shared workspaces. Please retry.")
      const result = await response.json()
      if (!Array.isArray(result.sharedWorkspaces)) throw new Error("Unable to load shared workspaces. Please retry.")
      if (!signal?.aborted) { setWorkspaces(result.sharedWorkspaces); setError("") }
    } catch (caught) {
      if (!signal?.aborted) { setWorkspaces(null); setError(caught instanceof Error ? caught.message : "Unable to load shared workspaces. Please retry.") }
    } finally { if (!signal?.aborted) setLoading(false) }
  }, [endpoint])
  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal)
    const timer = window.setInterval(() => void refresh(controller.signal), 30_000)
    return () => { controller.abort(); window.clearInterval(timer) }
  }, [refresh])
  return <div className="space-y-3">
    <div className="flex items-center justify-between gap-3"><h4 className="text-sm font-medium">Workspaces shared with me</h4><Button variant="ghost" size="icon" aria-label="Refresh shared workspaces" disabled={loading} onClick={() => void refresh()}><RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} /></Button></div>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : workspaces ? <SharedWorkspaceList workspaces={workspaces} currentOrigin={window.location.origin} /> : <p className="text-sm text-muted-foreground">Loading shared workspaces…</p>}
  </div>
}
