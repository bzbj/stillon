import { useEffect, useRef, useState, type ComponentPropsWithoutRef } from "react"
import { resolveLinkTarget } from "../lib/linkTarget"
import { appendLocalFileLinkLocation, getProjectRelativeFilePath, type ParsedLocalFileLink } from "../lib/pathUtils"
import { buildProjectRenderablePreviewUrl } from "../../shared/project-file-urls"
import { buildLocalFilePreviewUrl } from "../../shared/local-file-urls"
import { fileRenderer } from "../../shared/file-renderers"
import { getLinkActions, type LinkAction } from "../../shared/link-actions"
import { isPlainPreviewClick } from "../../shared/preview-target"
import { registerPreviewTarget, openStandalonePreview } from "../lib/previewTarget"
import { usePreviewResolution } from "../lib/usePreviewHref"
import { useLinkCapabilities } from "../lib/linkCapabilities"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "./ui/context-menu"

export async function executeResourceAction(address: string, action: LinkAction, projectId?: string, signal?: AbortSignal) {
  const url = await registerPreviewTarget(address, projectId), id = url.split("/").pop()!
  signal?.throwIfAborted()
  const response = await fetch(`/api/preview-targets/${id}/${action === "download" ? "content?download=1" : "action"}`, action === "download" ? { cache: "no-store", signal } : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }),
  })
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "File action failed. Reconnect and retry.")
  if (action !== "download") {
    const result = await response.json().catch(() => ({}))
    if (result.ok !== true) throw new Error(result.error || "This host action is unsupported. Update StillOn.")
    return
  }
  if (!response.headers.get("Content-Disposition")?.startsWith("attachment;")) { await response.body?.cancel(); throw new Error("The server did not return an authenticated file download.") }
  const name = /filename\*=UTF-8''([^;]+)/iu.exec(response.headers.get("Content-Disposition")!)?.[1]
  const object = URL.createObjectURL(await response.blob())
  const anchor = document.createElement("a")
  anchor.href = object; anchor.download = name ? decodeURIComponent(name) : "download"; anchor.click()
  setTimeout(() => URL.revokeObjectURL(object), 60_000)
}

/** All authored file/service links share classification, menu and explicit actions. */
export function ResourceLink({ href, children, projectId, localPath, resolveFile, onPreview, ...props }: ComponentPropsWithoutRef<"a"> & {
  projectId?: string; localPath?: string | null; resolveFile?: (href: string) => ParsedLocalFileLink | null
  onPreview?: (address: string) => void
}) {
  const target = resolveLinkTarget(href, { localPath, resolveFile, projectId, currentOrigin: typeof window === "undefined" ? undefined : window.location.origin })
  const capabilities = useLinkCapabilities()
  const [error, setError] = useState<string>()
  const download = useRef<AbortController | undefined>(undefined)
  const [downloading, setDownloading] = useState(false)
  useEffect(() => () => download.current?.abort(), [])
  const file = target?.kind === "file" ? target.file : undefined
  const relative = file ? getProjectRelativeFilePath(file.path, localPath) : null
  const address = target?.kind === "file" && target.address ? target.address : file ? appendLocalFileLinkLocation(relative && projectId ? buildProjectRenderablePreviewUrl(projectId, relative) : buildLocalFilePreviewUrl(file.path), file)
    : target?.kind === "service" ? target.address : null
  const renderer = file ? fileRenderer(file.path) : undefined
  const resolution = usePreviewResolution(address, projectId), standalone = resolution?.url
  const policy = getLinkActions({ kind: resolution?.directory ? "directory" : target?.kind === "file" ? "file" : target?.kind === "service" ? "service" : "other", renderer: resolution?.directory ? undefined : resolution?.renderer ?? renderer,
    local: capabilities?.local ?? false, isMac: capabilities?.isMac })
  if (!target || !address) return <a {...props} href={target ? href : undefined} target={target?.kind === "internal" ? props.target : "_blank"} rel="noopener noreferrer">{children}</a>
  const activate = (action: LinkAction) => {
    setError(undefined)
    if (capabilities?.error) { setError(capabilities.error); return }
    if (action === "preview") { if (onPreview) onPreview(address); else void openStandalonePreview(address, projectId).catch(e => setError(e.message)); return }
    if (action === "download") {
      download.current?.abort(); download.current = new AbortController(); setDownloading(true)
    }
    void executeResourceAction(address, action, projectId, action === "download" ? download.current?.signal : undefined)
      .catch(e => setError(e.name === "AbortError" ? "Download cancelled." : e.message)).finally(() => setDownloading(false))
  }
  return <ContextMenu>
    <ContextMenuTrigger asChild>
      <a {...props} href={standalone ? policy.defaultAction === "download" ? `/api/preview-targets/${standalone.split("/").pop()}/content?download=1` : standalone : undefined}
        role="link" tabIndex={0} onContextMenu={event => { event.stopPropagation() }}
        onKeyDown={event => {
          if (event.key === "ContextMenu" || event.key === "F10" && event.shiftKey) {
            event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect()
            event.currentTarget.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: rect.left, clientY: rect.bottom }))
          } else if (event.key === "Enter" && !event.ctrlKey && !event.metaKey) { event.preventDefault(); if (policy.defaultAction && capabilities) activate(policy.defaultAction) }
        }}
        onClick={event => {
          props.onClick?.(event)
          if (event.defaultPrevented) return
          if (!isPlainPreviewClick(event)) {
            if (policy.defaultAction === "open_default") event.preventDefault()
            else if (!standalone && policy.defaultAction === "preview") { event.preventDefault(); void openStandalonePreview(address, projectId).catch(e => setError(e.message)) }
            return
          }
          event.preventDefault()
          if (policy.defaultAction && (capabilities || policy.defaultAction === "preview")) activate(policy.defaultAction)
        }}
        onAuxClick={event => {
          if (policy.defaultAction === "open_default") event.preventDefault()
          else if (event.button === 1 && !standalone && policy.defaultAction === "preview") { event.preventDefault(); void openStandalonePreview(address, projectId).catch(e => setError(e.message)) }
        }}
      >{children}</a>
    </ContextMenuTrigger>
    <ContextMenuContent onContextMenu={event => event.stopPropagation()}>
      {!capabilities ? <ContextMenuItem disabled>Loading file actions…</ContextMenuItem> : policy.actions.map(item =>
        <ContextMenuItem key={item.action} disabled={item.disabled || Boolean(resolution?.error) || Boolean(capabilities?.error)} onSelect={() => activate(item.action)}>{item.label}</ContextMenuItem>)}
      {resolution?.error ? <ContextMenuItem disabled>{resolution.error}</ContextMenuItem> : null}
      {capabilities?.error ? <ContextMenuItem disabled>{capabilities.error}</ContextMenuItem> : null}
      {resolution?.directory && !capabilities?.local ? <ContextMenuItem disabled>Folder links cannot be downloaded.</ContextMenuItem> : null}
    </ContextMenuContent>
    {error || resolution?.error ? <span role="alert" className="ml-2 text-xs text-destructive">{error ?? resolution?.error}</span> : null}
    {downloading ? <button type="button" className="ml-2 text-xs underline" onClick={() => download.current?.abort()}>Cancel download</button> : null}
  </ContextMenu>
}
