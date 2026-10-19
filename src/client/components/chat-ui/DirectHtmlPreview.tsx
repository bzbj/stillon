import { useEffect, useRef, useState } from "react"
import { buildProjectFilePreviewUrl } from "../../../shared/project-file-urls"
import { buildLocalFilePreviewUrl } from "../../../shared/local-file-urls"
import { fileRenderer } from "../../../shared/file-renderers"
import type { PreviewTarget } from "../../../shared/preview-target"
import { registerPreviewTarget } from "../../lib/previewTarget"
import { executeResourceAction } from "../ResourceLink"
import { useLinkCapabilities } from "../../lib/linkCapabilities"
import { parseLoopbackPreviewUrl } from "../../../shared/browser-preview-proxy"

export function DirectHtmlPreview({ target, projectId, refreshVersion, zoom, onNavigate }: {
  target: PreviewTarget; projectId?: string; refreshVersion: number; zoom: number
  onNavigate: (address: string, mode?: "replace" | "pop") => void
}) {
  const [url, setUrl] = useState<string>(), [error, setError] = useState<string>()
  const [linkedAction, setLinkedAction] = useState<{ address: string; label: string; service?: boolean }>()
  const [dependencyError, setDependencyError] = useState<string>()
  const frame = useRef<HTMLIFrameElement>(null)
  const current = useRef(target.address), capabilities = useLinkCapabilities()
  const loadedVersion = useRef(-1)
  const frameRoot = useRef("")
  const frameTargetId = useRef<string | undefined>(undefined)
  const latest = useRef({ target, onNavigate })
  latest.current = { target, onNavigate }
  useEffect(() => {
    let active = true
    if (url && current.current === target.address && loadedVersion.current === refreshVersion) return
    setError(undefined)
    setLinkedAction(undefined)
    setDependencyError(undefined)
    frameTargetId.current = undefined
    void registerPreviewTarget(target.address, projectId).then(async standalone => {
      const id = standalone.split("/").pop()!
      const response = await fetch(`/api/file-previews/${id}/entry`, { method: "POST" })
      const value = await response.json()
      if (!response.ok || value.protocol !== 1 || typeof value.url !== "string") throw new Error(value.error || "Update the host, adapter and Connect gateway to support direct HTML file previews.")
      const destination = new URL(value.url)
      if (destination.origin === window.location.origin || !/^https?:$/u.test(destination.protocol)) throw new Error("The file preview origin is not isolated.")
      const logical = new URL(target.address, window.location.origin)
      destination.search = logical.search; destination.hash = logical.hash
      if (active) {
        frameTargetId.current = id
        const resourceParts = destination.pathname.split("/").filter(Boolean).length
        frameRoot.current = "filePath" in target && target.filePath ? target.filePath.replaceAll("\\", "/").split("/").slice(0, -resourceParts).join("/") + "/" : ""
        current.current = target.address; loadedVersion.current = refreshVersion; setUrl(destination.href)
      }
    }).catch(e => { if (active) setError(e.message) })
    return () => { active = false }
  }, [target.address, projectId, refreshVersion])
  useEffect(() => {
    if (!url) return
    let active = true
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== new URL(url).origin) return
      const { target, onNavigate } = latest.current
      const data = event.data
      if (data?.type === "stillon:file-dependency-error" && typeof data.label === "string") {
        setDependencyError("A file dependency could not load: " + data.label.slice(0, 160) + ". Refresh to retry. File previews support authorized local resources.")
        return
      }
      if (data?.type === "stillon:file-service-link") {
        const service = typeof data.address === "string" && parseLoopbackPreviewUrl(data.address)
        if (service) setLinkedAction({ address: service.href, label: service.href, service: true })
        return
      }
      if (!["stillon:file-link", "stillon:file-navigation"].includes(data?.type) || typeof data.path !== "string" || typeof data.query !== "string" || typeof data.fragment !== "string") return
      if (!data.path.startsWith("/") || data.path.startsWith("//") || data.path.length > 16384
        || !/^(?:\?[^#\u0000-\u001f]*)?$/u.test(data.query) || !/^(?:#[^\u0000-\u001f]*)?$/u.test(data.fragment)
        || data.query.length + data.fragment.length > 32768) return
      const initial = new URL(url)
      if (data.type === "stillon:file-navigation" && target.kind === "host-html" && data.path === initial.pathname && data.query === initial.search && data.fragment === initial.hash) return
      let parts: string[]
      try { parts = data.path.split("/").filter(Boolean).map(decodeURIComponent) } catch { return }
      if (!parts.length || parts.some(p => p === "." || p === ".." || p.startsWith(".") || /[\\/:\u0000-\u001f]/u.test(p))) return
      if (!("filePath" in target) || !target.filePath) return
      const directory = frameRoot.current
      const path = directory + parts.join("/")
      const address = (target.kind === "project-file" ? buildProjectFilePreviewUrl(target.projectId, path) : buildLocalFilePreviewUrl(path)) + data.query + data.fragment
      if (address === current.current && data.standalone !== true) return
      const navigation = data.type === "stillon:file-navigation"
      if (navigation && fileRenderer(path) !== "html") return
      const id = frameTargetId.current, source = event.source
      if (!id) return
      const standalone = !navigation && data.standalone === true && Boolean(fileRenderer(path))
      const reply = event.ports[0]
      if (standalone && (!reply || data.popupBlocked)) {
        reply?.postMessage({ error: "Popup unavailable" }); reply?.close()
        setDependencyError("Your browser blocked the preview tab. Allow popups and reopen this file link.")
        return
      }
      void (async () => {
        // Lexical containment is insufficient: a symlink/junction may leave the
        // HTML directory while remaining inside the broader project workspace.
        const response = await fetch(`/api/file-previews/${id}/link`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address }) })
        const value = await response.json()
        if (!response.ok || value.address !== address) throw new Error(value.error || "The linked file is outside this preview's authorization.")
        if (!active || source !== frame.current?.contentWindow || frameTargetId.current !== id) { reply?.postMessage({ error: "Preview changed" }); reply?.close(); return }
        if (navigation) { current.current = address; onNavigate(address, "replace") }
        else if (standalone) {
          const destination = await registerPreviewTarget(address, projectId)
          if (!active || source !== frame.current?.contentWindow) { reply?.postMessage({ error: "Preview changed" }); reply?.close(); return }
          reply?.postMessage({ url: new URL(destination, window.location.origin).href }); reply?.close()
        } else if (fileRenderer(path)) onNavigate(address)
        // A child document cannot turn postMessage into a host app launcher.
        // Privileged actions require a click on the trusted parent UI.
        else { reply?.postMessage({ error: "No preview renderer" }); reply?.close(); setLinkedAction({ address, label: parts.join("/") }) }
      })().catch(e => { reply?.postMessage({ error: "File preview unavailable" }); reply?.close(); if (active) setDependencyError(e.message) })
    }
    window.addEventListener("message", receive)
    return () => { active = false; window.removeEventListener("message", receive) }
  }, [url, projectId])
  if (error) return <div role="alert" className="p-6 text-sm">{error}</div>
  if (!url) return <p className="p-6 text-sm">Loading file preview…</p>
  return <div className="flex h-full flex-col">
    {dependencyError ? <div role="alert" className="border-b p-3 text-sm"><p>{dependencyError}</p><button className="underline" onClick={() => setDependencyError(undefined)}>Dismiss dependency warning</button></div> : null}
    {linkedAction ? <div className="flex flex-wrap items-center gap-3 border-b p-3 text-sm"><span className="break-all">{linkedAction.label}</span>
      <button className="underline" disabled={!capabilities} onClick={() => {
        if (linkedAction.service) onNavigate(linkedAction.address)
        else void executeResourceAction(linkedAction.address, capabilities?.local ? "open_default" : "download", projectId).catch(e => setDependencyError(e.message))
        setLinkedAction(undefined)
      }}>{linkedAction.service ? "Preview host service" : capabilities?.local ? "Open linked file" : "Download linked file"}</button>
      <button className="underline" onClick={() => setLinkedAction(undefined)}>Dismiss</button>
    </div> : null}
    <div className="min-h-0 flex-1 overflow-hidden"><iframe key={`${url}:${refreshVersion}`} ref={frame} title="HTML file preview" src={url}
    sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer"
    className="h-full w-full border-0 bg-white" style={{ transform: `scale(${zoom})`, transformOrigin: "top left", width: `${100 / zoom}%`, height: `${100 / zoom}%` }} /></div>
  </div>
}
