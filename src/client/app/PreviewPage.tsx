import { useEffect, useRef, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { PreviewSurface, type ResolvedPreviewEntry } from "../components/chat-ui/PreviewSurface"
import { registerPreviewTarget, readPreviewEntry } from "../lib/previewTarget"
import { localServiceBrowserAddress } from "../lib/localServiceBrowser"
import { parsePreviewTarget } from "../../shared/preview-target"
import { Button } from "../components/ui/button"
import { useStartupReveal } from "../lib/startup"

export function PreviewPage() {
  const { targetId } = useParams()
  const navigate = useNavigate()
  const [entry, setEntry] = useState<ResolvedPreviewEntry>()
  const [error, setError] = useState<string>()
  const [version, setVersion] = useState(0)
  const [zoom, setZoom] = useState(1)
  const resolvedId = useRef<string | undefined>(undefined)
  const navigationSequence = useRef(0)
  useStartupReveal(Boolean(entry || error))
  useEffect(() => {
    if (resolvedId.current === targetId) return
    const sequence = ++navigationSequence.current
    let cancelled = false
    setEntry(undefined); setError(undefined)
    void readPreviewEntry(targetId ?? "").then(value => {
      if (!cancelled && sequence === navigationSequence.current) {
        const direct = value.target.kind === "host-http" ? localServiceBrowserAddress(value.target.address) : null
        if (direct) { window.location.replace(direct); return }
        resolvedId.current = targetId; setEntry(value)
      }
    }).catch(e => { if (!cancelled && sequence === navigationSequence.current) setError(e.message) })
    return () => { cancelled = true }
  }, [targetId])
  return <main className="flex h-[100dvh] flex-col bg-background text-foreground">
    <header className="flex items-center gap-3 border-b border-border px-4 py-2">
      <Button variant="ghost" onClick={() => window.history.back()}>Back</Button>
      <Button variant="ghost" onClick={() => window.history.forward()}>Forward</Button>
      <Button variant="ghost" onClick={() => {
        if (!entry || entry.target.kind === "external-http") { window.location.reload(); return }
        setError(undefined)
        const sequence = ++navigationSequence.current
        void registerPreviewTarget(entry.target.address, entry.projectId).then(async url => {
          const id = url.split("/").pop()!
          const value = await readPreviewEntry(id)
          if (sequence !== navigationSequence.current) return
          resolvedId.current = id
          setEntry({ ...value, id, address: value.target.address })
          setVersion(previous => previous + 1)
          navigate(url, { replace: true })
        }).catch(e => { if (sequence === navigationSequence.current) setError(e.message) })
      }}>Refresh</Button>
      <Button variant="ghost" aria-label="Zoom out" disabled={zoom <= 0.5} onClick={() => setZoom(value => Math.max(0.5, Math.round((value - 0.1) * 10) / 10))}>−</Button>
      <span className="text-xs" aria-label="Preview zoom">{Math.round(zoom * 100)}%</span>
      <Button variant="ghost" aria-label="Zoom in" disabled={zoom >= 2} onClick={() => setZoom(value => Math.min(2, Math.round((value + 0.1) * 10) / 10))}>+</Button>
      <span className="min-w-0 flex-1 truncate text-sm" aria-label="Preview address">{entry?.target.address ?? "Preview"}</span>
    </header>
    <div className="min-h-0 flex-1">
      {error ? <div role="alert" className="p-6">{error}</div> : entry ? <PreviewSurface resolvedEntry={entry} address={entry.target.address} projectId={entry.projectId} refreshVersion={version} zoom={zoom}
        onNavigate={(address, mode) => {
          const sequence = ++navigationSequence.current
          const target = parsePreviewTarget(address, entry.projectId)
          // Keep the viewer (and its explicit consent) mounted while registering
          // navigation within the service the user already chose to preview.
          const sameService = target?.kind === "host-http" && entry.target.kind === "host-http"
            && new URL(target.address).origin === new URL(entry.target.address).origin
          if (target && (mode || sameService)) setEntry({ ...entry, target, address })
          else setEntry(undefined)
          void registerPreviewTarget(address, entry.projectId).then(async url => {
            const id = url.split("/").pop()!
            const value = await readPreviewEntry(id)
            if (sequence !== navigationSequence.current) return
            resolvedId.current = id
            setEntry({ ...value, id, address: value.target.address })
            navigate(url, { replace: Boolean(mode) })
          }).catch(e => { if (sequence === navigationSequence.current) setError(e.message) })
        }} /> : <p className="p-6">Loading preview…</p>}
    </div>
  </main>
}
