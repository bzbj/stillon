import { useCallback, useEffect, useRef, useState } from "react"
import { registerPreviewTarget } from "../../lib/previewTarget"
import { Button } from "../ui/button"

interface Frame { image: string; address: string; width: number; height: number; error?: string; navigationType?: "push" | "replace" | "pop" }
export function IsolatedPreview({ address, projectId, refreshVersion, zoom = 1, onNavigate }: {
  address: string; projectId?: string; refreshVersion: number; zoom?: number; onNavigate: (address: string, mode?: "replace" | "pop") => void
}) {
  const [session, setSession] = useState<string>()
  const [frame, setFrame] = useState<Frame>()
  const [error, setError] = useState<string>()
  const [retry, setRetry] = useState(0)
  const [loading, setLoading] = useState(true)
  const latest = useRef({ address, onNavigate })
  latest.current = { address, onNavigate }
  const reported = useRef<string | undefined>(undefined)
  const version = useRef(refreshVersion)
  const active = useRef<string | undefined>(undefined)
  const textInput = useRef<HTMLTextAreaElement>(null)
  const image = useRef<HTMLImageElement>(null)
  const container = useRef<HTMLDivElement>(null)
  const viewer = useRef(crypto.randomUUID())
  const lastMove = useRef(0)
  const release = useCallback((id: string) => fetch(`/api/preview-browser/${id}?viewer=${viewer.current}`, { method: "DELETE", keepalive: true }).catch(() => undefined), [])
  const update = useCallback((value: Frame) => {
    setFrame(value); setError(value.error); setLoading(false)
    if (value.address && value.address !== latest.current.address) {
      reported.current = value.address
      latest.current.onNavigate(value.address, value.navigationType === "replace" || value.navigationType === "pop" ? value.navigationType : undefined)
    }
  }, [])
  const request = useCallback(async (id: string, action?: object) => {
    const width = Math.max(320, Math.min(1600, container.current?.clientWidth ?? 1100))
    const height = Math.max(200, Math.min(1200, container.current?.clientHeight ?? 800))
    const response = await fetch(`/api/preview-browser/${id}?viewer=${viewer.current}&width=${width}&height=${height}`, action ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action) } : { cache: "no-store" })
    const value = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(value.error || "The preview connection is unavailable. Retry when the computer is online.")
    if (active.current === id && typeof value.image === "string") update(value)
  }, [update])

  useEffect(() => {
    if (reported.current === address && version.current === refreshVersion && session) { reported.current = undefined; return }
    let cancelled = false
    const reloading = version.current !== refreshVersion
    version.current = refreshVersion
    if (reloading && active.current) { setLoading(true); void request(active.current, { type: "reload" }).catch(e => { setError(String(e.message)); setLoading(false) }); return }
    const previous = active.current
    active.current = undefined; setSession(undefined)
    setLoading(true); setError(undefined); setFrame(undefined)
    void (async () => {
      if (previous) await release(previous)
      const targetUrl = await registerPreviewTarget(address, projectId)
      const targetId = targetUrl.split("/").pop()
      const reload = (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.type === "reload"
      const response = await fetch("/api/preview-browser", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ targetId, viewerId: viewer.current, reload }) })
      const body = await response.json().catch(() => ({}))
      if (!response.ok || typeof body.id !== "string") throw new Error(body.error || "This server does not support isolated browser previews. Update StillOn and retry.")
      if (cancelled) { void release(body.id); return }
      active.current = body.id; setSession(body.id)
      await request(body.id)
    })().catch(e => { if (!cancelled) { setError(e.message); setLoading(false) } })
    return () => { cancelled = true }
    // session is intentionally not a dependency: receiving a new session must
    // not restart target resolution. Reported navigation never reloads a page.
  }, [address, projectId, refreshVersion, retry, request, release])

  useEffect(() => {
    if (!session) return
    active.current = session
    let stopped = false, timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try { if (document.visibilityState === "visible") await request(session) }
      catch (e) { if (!stopped) setError(e instanceof Error ? e.message : "Preview disconnected") }
      if (!stopped) timer = setTimeout(poll, 600)
    }
    timer = setTimeout(poll, 600)
    const heartbeat = setInterval(() => { if (document.visibilityState !== "visible") void fetch(`/api/preview-browser/${session}?viewer=${viewer.current}&ping=1`).catch(() => undefined) }, 5_000)
    const leaving = () => { void release(session) }
    window.addEventListener("pagehide", leaving)
    return () => { stopped = true; clearTimeout(timer); clearInterval(heartbeat); window.removeEventListener("pagehide", leaving); void release(session); if (active.current === session) active.current = undefined }
  }, [session, request, release])

  useEffect(() => {
    if (!session || !container.current) return
    let timer: ReturnType<typeof setTimeout>
    const resize = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        if (active.current !== session || !container.current || document.visibilityState !== "visible") return
        void request(session, { type: "resize", width: Math.max(320, Math.min(1600, container.current.clientWidth)), height: Math.max(200, Math.min(1200, container.current.clientHeight)) }).catch(e => setError(e.message))
      }, 100)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(container.current); resize()
    window.addEventListener("focus", resize)
    document.addEventListener("visibilitychange", resize)
    return () => { observer.disconnect(); clearTimeout(timer); window.removeEventListener("focus", resize); document.removeEventListener("visibilitychange", resize) }
  }, [session, request])

  useEffect(() => {
    const element = container.current
    if (!element) return
    const wheel = (event: WheelEvent) => {
      if (!active.current || !image.current?.contains(event.target as Node)) return
      event.preventDefault()
      void request(active.current, { type: "scroll", dx: Math.max(-2000, Math.min(2000, event.deltaX)), dy: Math.max(-2000, Math.min(2000, event.deltaY)) }).catch(e => setError(e.message))
    }
    element.addEventListener("wheel", wheel, { passive: false })
    return () => element.removeEventListener("wheel", wheel)
  }, [request])

  const send = (action: object) => { if (active.current) void request(active.current, action).catch(e => setError(e.message)) }
  return <div ref={container} style={{ zoom }} className="relative flex h-full w-full flex-col overflow-auto bg-background">
    {(loading || error) && <div role="status" className="flex items-center gap-3 border-b border-border bg-background px-4 py-3 text-sm">
      <span>{loading ? "Loading preview…" : error}</span>
      {error && <Button variant="outline" onClick={() => { active.current = undefined; setSession(undefined); setRetry(value => value + 1) }}>Retry</Button>}
    </div>}
    {frame && <div className="relative w-full">
      <img ref={image} src={`data:image/jpeg;base64,${frame.image}`} alt="Interactive browser preview" draggable={false} className="block w-full select-none"
        onMouseMove={event => {
          if (Date.now() - lastMove.current < 80 || !active.current) return
          lastMove.current = Date.now()
          const rect = event.currentTarget.getBoundingClientRect()
          void request(active.current, { type: "move", x: (event.clientX - rect.left) * frame.width / rect.width, y: (event.clientY - rect.top) * frame.height / rect.height }).catch(() => undefined)
        }}
        onClick={event => {
          const rect = event.currentTarget.getBoundingClientRect()
          send({ type: "click", x: (event.clientX - rect.left) * frame.width / rect.width, y: (event.clientY - rect.top) * frame.height / rect.height })
          textInput.current?.focus({ preventScroll: true })
        }} />
      <textarea ref={textInput} aria-label="Preview keyboard input" className="absolute left-0 top-0 h-px w-px opacity-0" autoCapitalize="off" autoCorrect="off" spellCheck={false}
        onChange={event => { if (event.target.value) send({ type: "text", text: event.target.value.slice(0, 2000) }); event.target.value = "" }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return
          const key = event.key === " " ? "Space" : event.key
          // Paste into this device's input; never ask the computer's browser to
          // read or write the host operating system clipboard.
          if ((event.ctrlKey || event.metaKey) && /^[cvx]$/iu.test(key)) return
          if ((event.ctrlKey || event.metaKey || event.altKey || key.length > 1) && key !== "Process") {
            event.preventDefault()
            send({ type: "key", key: `${event.ctrlKey ? "Control+" : ""}${event.metaKey ? "Meta+" : ""}${event.altKey ? "Alt+" : ""}${event.shiftKey ? "Shift+" : ""}${key}` })
          }
        }} />
    </div>}
  </div>
}
