import { useCallback, useEffect, useState } from "react"
import { RefreshCw } from "lucide-react"
import type { ConnectHost } from "../../shared/connect"
import { Button } from "../components/ui/button"

export function MyComputersSettings({ remote, currentHostId }: { remote: boolean; currentHostId?: string }) {
  const [hosts, setHosts] = useState<ConnectHost[] | null>(null)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const endpoint = remote ? "/_connect/hosts" : "/api/connect-local/hosts"
  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    try {
      const response = await fetch(endpoint, { cache: "no-store", redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) })
      if (!response.ok) throw new Error(response.status === 404 || response.status === 400 ? "Update the remote service to view your computers." : "Unable to load computers. Please retry.")
      const data = await response.json()
      if (!Array.isArray(data.hosts)) throw new Error("Unable to load computers. Please retry.")
      if (!signal?.aborted) { setHosts(data.hosts); setError("") }
    } catch (caught) {
      if (!signal?.aborted) setError(caught instanceof Error ? caught.message : "Unable to load computers. Please retry.")
    } finally { if (!signal?.aborted) setLoading(false) }
  }, [endpoint])
  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal)
    const timer = window.setInterval(() => void refresh(controller.signal), 30_000)
    return () => { controller.abort(); window.clearInterval(timer) }
  }, [refresh])
  return <section aria-label="My Computers" className="space-y-3 border-t pt-5">
    <div className="flex items-center justify-between gap-3"><h3 className="font-medium">My Computers</h3><Button variant="ghost" size="icon" aria-label="Refresh computers" disabled={loading} onClick={() => void refresh()}><RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} /></Button></div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {hosts ? hosts.length ? hosts.map(host => <div key={host.id} className="flex items-center gap-4 rounded-xl border p-4">
      <div className="min-w-0 flex-1"><p className="break-words text-sm font-medium">{host.name}</p><p className="mt-1 text-xs text-muted-foreground">{host.paused ? "Paused" : host.online ? "Online" : "Offline"}</p></div>
      {host.id === currentHostId ? <span className="shrink-0 text-xs text-muted-foreground">Current computer</span> : <a className="shrink-0 text-sm underline" href={`${host.url}/_connect/login`}>Switch</a>}
    </div>) : <p className="text-sm text-muted-foreground">No computers linked.</p> : !error && <p className="text-sm text-muted-foreground">Loading computers…</p>}
  </section>
}
