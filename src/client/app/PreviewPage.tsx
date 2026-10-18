import { useEffect, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { PreviewSurface } from "../components/chat-ui/PreviewSurface"
import { registerPreviewTarget } from "../lib/previewTarget"
import type { PreviewTarget } from "../../shared/preview-target"
import { Button } from "../components/ui/button"

export function PreviewPage() {
  const { targetId } = useParams()
  const navigate = useNavigate()
  const [entry, setEntry] = useState<{ target: PreviewTarget; projectId?: string }>()
  const [error, setError] = useState<string>()
  const [version, setVersion] = useState(0)
  useEffect(() => {
    let cancelled = false
    setEntry(undefined); setError(undefined)
    void fetch(`/api/preview-targets/${encodeURIComponent(targetId ?? "")}`, { cache: "no-store" }).then(async response => {
      const value = await response.json()
      if (!response.ok) throw new Error(value.error || "Preview unavailable")
      if (!cancelled) setEntry(value)
    }).catch(e => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
  }, [targetId])
  return <main className="flex h-[100dvh] flex-col bg-background text-foreground">
    <header className="flex items-center gap-3 border-b border-border px-4 py-2">
      <Button variant="ghost" onClick={() => window.history.back()}>Back</Button>
      <Button variant="ghost" onClick={() => window.history.forward()}>Forward</Button>
      <Button variant="ghost" onClick={() => setVersion(value => value + 1)}>Refresh</Button>
      <span className="min-w-0 flex-1 truncate text-sm" aria-label="Preview address">{entry?.target.address ?? "Preview"}</span>
    </header>
    <div className="min-h-0 flex-1">
      {error ? <div role="alert" className="p-6">{error}</div> : entry ? <PreviewSurface address={entry.target.address} projectId={entry.projectId} refreshVersion={version}
        onNavigate={(address, mode) => { void registerPreviewTarget(address, entry.projectId).then(url => navigate(url, { replace: Boolean(mode) })).catch(e => setError(e.message)) }} /> : <p className="p-6">Loading preview…</p>}
    </div>
  </main>
}
