import { useCallback, useEffect, useRef, useState } from "react"
import { Globe, LoaderCircle, RefreshCw } from "lucide-react"
import type { ConnectBrowserSession, ConnectBrowserSessions } from "../../shared/connect"
import { Button } from "../components/ui/button"

export function sessionTimeRemaining(expiresAt: number, now: number) {
  const remaining = expiresAt - now
  if (remaining <= 0) return "Expired"
  if (remaining < 86_400_000) return "Less than 1 day remaining"
  const days = Math.ceil(remaining / 86_400_000)
  return `${days} ${days === 1 ? "day" : "days"} remaining`
}

function usedAt(value: number | null) {
  return value === null ? "Not recorded yet" : new Date(value).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
}

export function BrowserSessionList({ data, busy, confirming, onConfirm, onRemove }: {
  data: ConnectBrowserSessions; busy: string | null; confirming: string | null
  onConfirm: (id: string | null) => void; onRemove: (session: ConnectBrowserSession) => void
}) {
  return <div className="space-y-3">
    <p className="text-sm text-muted-foreground">{data.sessions.length} active browser {data.sessions.length === 1 ? "login" : "logins"}</p>
    {data.sessions.length === 0 && <p className="rounded-xl border p-4 text-sm text-muted-foreground">No browsers are signed in.</p>}
    {data.sessions.map(session => <div key={session.id} className="space-y-3 rounded-xl border p-4">
      <div className="flex items-start gap-3">
        <Globe className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">{session.browser} · {session.platform}</span>{session.current && <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium">This device</span>}</div>
          <p className="text-xs text-muted-foreground" title={`Expires ${usedAt(session.expiresAt)}`}>{sessionTimeRemaining(session.expiresAt, data.now)}</p>
          <p className="text-xs text-muted-foreground">Last used: {usedAt(session.lastUsedAt)}</p>
        </div>
        <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => onConfirm(session.id)} aria-label={`Sign out ${session.browser} on ${session.platform}${session.current ? " (this device)" : ""}`}>Sign out</Button>
      </div>
      {confirming === session.id && <div className="space-y-3 border-t pt-3">
        <p className="text-sm text-muted-foreground">{session.current ? "Sign out this device?" : "Sign out this browser?"} Its remote connections will close. Tasks on your computers keep running.</p>
        <div className="flex flex-wrap gap-2"><Button size="sm" variant="destructive" disabled={busy !== null} onClick={() => onRemove(session)}>{busy === session.id && <LoaderCircle className="mr-2 size-4 animate-spin" />}Confirm sign out</Button><Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => onConfirm(null)}>Cancel</Button></div>
      </div>}
    </div>)}
  </div>
}

export function BrowserSessionSettings({ remote, logoutUrl }: { remote: boolean; logoutUrl?: string }) {
  const endpoint = remote ? "/_connect/sessions" : "/api/connect-local/sessions"
  const [data, setData] = useState<ConnectBrowserSessions | null>(null)
  const [error, setError] = useState("")
  const [actionError, setActionError] = useState("")
  const [busy, setBusy] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [notice, setNotice] = useState("")
  const generation = useRef(0)
  const mutation = useRef(false)

  const refresh = useCallback(async () => {
    if (mutation.current) return
    const requestId = ++generation.current
    setLoading(true)
    try {
      const response = await fetch(endpoint, { cache: "no-store", redirect: "error" })
      const result = await response.json()
      if (!response.ok || !Array.isArray(result.sessions) || typeof result.now !== "number") {
        throw new Error(["INVALID_BODY", "NOT_FOUND"].includes(result.error) || response.status === 404
          ? "Update StillOn and the remote service to manage browser logins."
          : "Unable to refresh browser logins. Please try again.")
      }
      if (requestId !== generation.current) return
      setData(result); setError("")
    } catch (caught) {
      if (requestId === generation.current) setError(caught instanceof Error ? caught.message : "Unable to refresh browser logins.")
    } finally { if (requestId === generation.current) setLoading(false) }
  }, [endpoint])

  useEffect(() => {
    void refresh()
    const refreshVisible = () => { if (document.visibilityState === "visible") void refresh() }
    const timer = window.setInterval(refreshVisible, 15_000)
    window.addEventListener("focus", refreshVisible)
    return () => { generation.current++; window.clearInterval(timer); window.removeEventListener("focus", refreshVisible) }
  }, [refresh])

  async function remove(session: ConnectBrowserSession) {
    if (mutation.current) return
    mutation.current = true; generation.current++; setLoading(false)
    setBusy(session.id); setActionError(""); setNotice("")
    try {
      const response = await fetch(`${endpoint}/revoke`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: session.id }), redirect: "error" })
      if (!response.ok || !(await response.json()).success) throw new Error("Unable to sign out this browser. Please try again.")
      if (session.current && logoutUrl) { window.location.replace(logoutUrl); return }
      setData(previous => previous ? { ...previous, sessions: previous.sessions.filter(row => row.id !== session.id) } : previous)
      setConfirming(null); setNotice("Browser signed out.")
    } catch (caught) { setActionError(caught instanceof Error ? caught.message : "Unable to sign out this browser.") }
    finally { mutation.current = false; setBusy(null) }
    await refresh()
  }

  return <section className="space-y-3 border-t pt-5" aria-label="Signed-in browsers">
    <div className="flex items-center justify-between gap-3"><div><h3 className="font-medium">Signed-in browsers</h3></div><Button size="icon" variant="ghost" aria-label="Refresh browser logins" disabled={loading || busy !== null} onClick={() => void refresh()}><RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} /></Button></div>
    {data ? <BrowserSessionList data={data} busy={busy} confirming={confirming} onConfirm={setConfirming} onRemove={session => void remove(session)} /> : !error ? <p className="text-sm text-muted-foreground">Loading browser logins…</p> : null}
    {error && <p role="alert" className="text-sm text-destructive">{error}{data ? " The list may be out of date." : ""}</p>}
    {actionError && <p role="alert" className="text-sm text-destructive">{actionError}</p>}
    {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
  </section>
}
