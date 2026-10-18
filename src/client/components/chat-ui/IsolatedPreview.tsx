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
  const composing = useRef(false)
  const compositionCommit = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pointer = useRef<{ id: number; type: string; button: number; x: number; y: number; startX: number; startY: number } | undefined>(undefined)
  const inputQueue = useRef<{ id: string; action: Record<string, unknown> }[]>([])
  const sending = useRef(false)
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
    const held = pointer.current ? `&pointer=${pointer.current.id}` : ""
    const response = await fetch(`/api/preview-browser/${id}?viewer=${viewer.current}&width=${width}&height=${height}${held}`, {
      signal: AbortSignal.timeout(15_000), ...(action ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action) } : { cache: "no-store" as const }),
    })
    const value = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(value.error || "The preview connection is unavailable. Retry when the computer is online.")
    if (active.current === id && typeof value.image === "string") update(value)
  }, [update])

  // Connect requests can arrive out of order. Coalesce only adjacent moves,
  // never a press, release or text commit.
  const send = useCallback((action: Record<string, unknown>) => {
    const id = active.current
    if (!id) return
    const previous = inputQueue.current.at(-1)
    if (previous?.id === id && previous.action.type === "pointer" && previous.action.phase === "move"
      && action.type === "pointer" && action.phase === "move") previous.action = action
    else if (previous?.id === id && previous.action.type === "text" && action.type === "text"
      && typeof previous.action.text === "string" && typeof action.text === "string" && previous.action.text.length + action.text.length <= 2000) previous.action.text += action.text
    else inputQueue.current.push({ id, action })
    if (sending.current) return
    sending.current = true
    void (async () => {
      try {
        while (inputQueue.current.length) {
          const next = inputQueue.current.shift()!
          if (active.current !== next.id) continue
          await request(next.id, { ...next.action, inputOnly: true }).catch(e => { if (active.current === next.id) setError(e.message) })
        }
      } finally { sending.current = false }
    })()
  }, [request])
  const cancelPointer = useCallback(() => {
    const current = pointer.current
    pointer.current = undefined
    if (current) {
      send({ type: "pointer", phase: "cancel", pointerId: current.id, pointerType: current.type, button: current.button, buttons: 0, x: current.x, y: current.y })
      if (image.current?.hasPointerCapture(current.id)) image.current.releasePointerCapture(current.id)
    }
  }, [send])
  const commitText = useCallback(() => {
    clearTimeout(compositionCommit.current); compositionCommit.current = undefined
    if (composing.current || !textInput.current) return
    let value = textInput.current.value
    textInput.current.value = ""
    while (value) {
      let length = Math.min(value.length, 2000)
      if (length < value.length && /[\uD800-\uDBFF]/u.test(value[length - 1]!)) length--
      send({ type: "text", text: value.slice(0, length) }); value = value.slice(length)
    }
  }, [send])
  useEffect(() => {
    const blur = () => cancelPointer()
    const visibility = () => { if (document.visibilityState !== "visible") cancelPointer() }
    window.addEventListener("blur", blur)
    document.addEventListener("visibilitychange", visibility)
    return () => {
      cancelPointer(); clearTimeout(compositionCommit.current)
      composing.current = false
      if (textInput.current) textInput.current.value = ""
      window.removeEventListener("blur", blur); document.removeEventListener("visibilitychange", visibility)
    }
  }, [session, cancelPointer])

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
      send({ type: "scroll", dx: Math.max(-2000, Math.min(2000, event.deltaX)), dy: Math.max(-2000, Math.min(2000, event.deltaY)) })
    }
    element.addEventListener("wheel", wheel, { passive: false })
    return () => element.removeEventListener("wheel", wheel)
  }, [send])

  return <div ref={container} style={{ zoom }} className="relative flex h-full w-full flex-col overflow-auto bg-background">
    {(loading || error) && <div role="status" className="flex items-center gap-3 border-b border-border bg-background px-4 py-3 text-sm">
      <span>{loading ? "Loading preview…" : error}</span>
      {error && <Button variant="outline" onClick={() => { active.current = undefined; setSession(undefined); setRetry(value => value + 1) }}>Retry</Button>}
    </div>}
    {frame && <div className="relative w-full">
      <img ref={image} src={`data:image/jpeg;base64,${frame.image}`} alt="Interactive browser preview" draggable={false} className="block w-full select-none"
        style={{ touchAction: "none" }}
        onContextMenu={event => event.preventDefault()}
        onPointerDown={event => {
          if (pointer.current || !active.current || ![0, 1, 2].includes(event.button)) return
          event.preventDefault()
          const rect = event.currentTarget.getBoundingClientRect()
          const x = Math.max(0, Math.min(frame.width - 1, (event.clientX - rect.left) * frame.width / rect.width))
          const y = Math.max(0, Math.min(frame.height - 1, (event.clientY - rect.top) * frame.height / rect.height))
          pointer.current = { id: event.pointerId, type: event.pointerType, button: event.button, x, y, startX: event.clientX, startY: event.clientY }
          event.currentTarget.setPointerCapture(event.pointerId)
          send({ type: "pointer", phase: "down", pointerId: event.pointerId, pointerType: event.pointerType, button: event.button, buttons: event.buttons, x, y })
        }}
        onPointerMove={event => {
          const current = pointer.current
          if (current && current.id !== event.pointerId) return
          const rect = event.currentTarget.getBoundingClientRect()
          const x = Math.max(0, Math.min(frame.width - 1, (event.clientX - rect.left) * frame.width / rect.width))
          const y = Math.max(0, Math.min(frame.height - 1, (event.clientY - rect.top) * frame.height / rect.height))
          if (current) { current.x = x; current.y = y }
          else if (Date.now() - lastMove.current < 80) return
          lastMove.current = Date.now()
          send({ type: "pointer", phase: "move", pointerId: event.pointerId, pointerType: event.pointerType, button: current?.button ?? 0, buttons: event.buttons, x, y })
        }}
        onPointerUp={event => {
          const current = pointer.current
          if (!current || current.id !== event.pointerId) return
          const rect = event.currentTarget.getBoundingClientRect()
          pointer.current = undefined
          send({ type: "pointer", phase: "up", pointerId: current.id, pointerType: current.type, button: current.button, buttons: 0,
            x: Math.max(0, Math.min(frame.width - 1, (event.clientX - rect.left) * frame.width / rect.width)),
            y: Math.max(0, Math.min(frame.height - 1, (event.clientY - rect.top) * frame.height / rect.height)) })
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
          if (current.type === "mouse" || Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < 5) textInput.current?.focus({ preventScroll: true })
        }}
        onPointerCancel={cancelPointer} onLostPointerCapture={cancelPointer} />
      <textarea ref={textInput} aria-label="Preview keyboard input" className="absolute left-0 top-0 h-px w-px opacity-0" autoCapitalize="off" autoCorrect="off" spellCheck={false}
        onCompositionStart={() => { clearTimeout(compositionCommit.current); compositionCommit.current = undefined; composing.current = true }}
        onCompositionEnd={() => {
          composing.current = false
          // The final input can precede or follow compositionend across engines.
          clearTimeout(compositionCommit.current); compositionCommit.current = setTimeout(commitText, 0)
        }}
        onChange={event => { if (!composing.current && !(event.nativeEvent as InputEvent).isComposing && compositionCommit.current === undefined) commitText() }}
        onBlur={event => {
          if (composing.current) { composing.current = false; event.currentTarget.value = "" }
          else commitText()
        }}
        onPaste={event => {
          const value = event.clipboardData.getData("text/plain")
          if (value && !composing.current) { event.preventDefault(); event.currentTarget.value += value; commitText() }
        }}
        onKeyDown={event => {
          if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return
          const key = event.key === " " ? "Space" : event.key
          if (["Control", "Meta", "Alt", "Shift", "AltGraph", "CapsLock", "Dead", "Unidentified", "Process"].includes(key)) return
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
