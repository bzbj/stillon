import { useLayoutEffect, useRef, useState, useSyncExternalStore, type ComponentPropsWithoutRef } from "react"
import { resolveLinkTarget } from "../lib/linkTarget"
import { appendLocalFileLinkLocation, getProjectRelativeFilePath, type ParsedLocalFileLink } from "../lib/pathUtils"
import { buildProjectRenderablePreviewUrl } from "../../shared/project-file-urls"
import { buildLocalFilePreviewUrl } from "../../shared/local-file-urls"
import { getLinkActions, type LinkAction } from "../../shared/link-actions"
import { isPlainPreviewClick } from "../../shared/preview-target"
import { registerPreviewTarget, registerResourceTarget } from "../lib/previewTarget"
import { resolveResourceMetadata, resourceResolutionHref, type ResourceMetadata } from "../lib/resourceResolution"
import { getResourceEpoch, subscribeResourceScope } from "../lib/resourceRequests"
import { getLinkCapabilities, type LinkCapabilities } from "../lib/linkCapabilities"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "./ui/context-menu"

export async function executeResourceAction(address: string, action: LinkAction, projectId?: string, signal?: AbortSignal, registeredUrl?: string) {
  const url = registeredUrl ?? await registerPreviewTarget(address, projectId), id = url.split("/").pop()!
  signal?.throwIfAborted()
  const response = await fetch(`/api/preview-targets/${id}/${action === "download" ? "content?download=1" : "action"}`, action === "download" ? { cache: "no-store", signal } : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }), signal,
  })
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "File action failed. Reconnect and retry.")
  if (action !== "download") {
    const result = await response.json().catch(() => ({}))
    if (result.ok !== true) throw new Error(result.error || "This host action is unsupported. Update StillOn.")
    return
  }
  if (!response.headers.get("Content-Disposition")?.startsWith("attachment;")) { await response.body?.cancel(); throw new Error("The server did not return an authenticated file download.") }
  const name = /filename\*=UTF-8''([^;]+)/iu.exec(response.headers.get("Content-Disposition")!)?.[1]
  const bytes = await response.blob()
  signal?.throwIfAborted()
  const object = URL.createObjectURL(bytes)
  const anchor = document.createElement("a")
  anchor.href = object; anchor.download = name ? decodeURIComponent(name) : "download"; anchor.click()
  setTimeout(() => URL.revokeObjectURL(object), 60_000)
}

type PreparedResource = { capabilities: LinkCapabilities; metadata: ResourceMetadata; registeredUrl?: string }
type MenuState = { status: "loading" } | { status: "error"; error: string } | { status: "ready"; value: PreparedResource }

type ResourceLinkProps = ComponentPropsWithoutRef<"a"> & {
  projectId?: string; localPath?: string | null; resolveFile?: (href: string) => ParsedLocalFileLink | null
  onPreview?: (address: string) => void
}
export function ResourceLink(props: ResourceLinkProps) {
  const epoch = useSyncExternalStore(subscribeResourceScope, getResourceEpoch, getResourceEpoch)
  return <ResourceLinkImpl key={JSON.stringify([epoch, props.href, props.projectId, props.localPath])} {...props} />
}
/** Rendering links performs syntax classification only; all I/O follows intent. */
function ResourceLinkImpl({ href, children, projectId, localPath, resolveFile, onPreview, ...props }: ResourceLinkProps) {
  const target = resolveLinkTarget(href, { localPath, resolveFile, projectId, currentOrigin: typeof window === "undefined" ? undefined : window.location.origin })
  const file = target?.kind === "file" ? target.file : undefined
  const relative = file ? getProjectRelativeFilePath(file.path, localPath) : null
  const address = target?.kind === "file" && target.address ? target.address : file ? appendLocalFileLinkLocation(relative && projectId ? buildProjectRenderablePreviewUrl(projectId, relative) : buildLocalFilePreviewUrl(file.path), file)
    : target?.kind === "service" ? target.address : null
  const generation = useRef(0), menuGeneration = useRef(0), busy = useRef(false)
  const actionController = useRef<AbortController | undefined>(undefined)
  const [menu, setMenu] = useState<MenuState>()
  const [error, setError] = useState<string>()
  const [preparing, setPreparing] = useState(false), [downloading, setDownloading] = useState(false)
  useLayoutEffect(() => {
    setMenu(undefined); setError(undefined); setPreparing(false); setDownloading(false); busy.current = false
    return () => { generation.current++; menuGeneration.current++; actionController.current?.abort() }
  }, [address, projectId])
  const policyFor = ({ capabilities, metadata }: PreparedResource) => getLinkActions({
    kind: metadata.directory ? "directory" : target?.kind === "file" ? "file" : "service",
    renderer: metadata.directory ? undefined : metadata.renderer,
    local: capabilities.local, isMac: capabilities.isMac, readable: metadata.canRead, canDownload: metadata.canDownload,
  })
  const prepare = async (register = false): Promise<PreparedResource> => {
    const [capabilities, prepared] = await Promise.all([getLinkCapabilities(), register
      ? registerResourceTarget(address!, projectId).then(value => ({ registeredUrl: value.url,
        metadata: { kind: value.directory ? "directory" as const : target?.kind === "service" ? "service" as const : "file" as const,
          directory: value.directory, renderer: value.renderer, canRead: true, canDownload: !value.directory && target?.kind === "file" } }))
      : resolveResourceMetadata(address!, projectId).then(metadata => ({ metadata, registeredUrl: undefined }))])
    return { capabilities, ...prepared }
  }
  const loadMenu = () => {
    const version = ++menuGeneration.current, life = generation.current
    setMenu({ status: "loading" })
    void prepare().then(value => {
      if (life === generation.current && version === menuGeneration.current) setMenu({ status: "ready", value })
    }).catch(e => {
      if (life === generation.current && version === menuGeneration.current) setMenu({ status: "error", error: e.message })
    })
  }
  const activate = async (selected?: LinkAction) => {
    if (!address || busy.current) return
    busy.current = true; setPreparing(true); setError(undefined)
    const life = generation.current
    try {
      const value = selected && menu?.status === "ready" ? menu.value : await prepare(true)
      if (life !== generation.current) return
      const policy = policyFor(value), action = selected ?? policy.defaultAction
      if (!action || !policy.actions.some(item => item.action === action && !item.disabled)) throw new Error(value.metadata.directory ? "Folder links cannot be downloaded." : "This file action is unavailable.")
      if (action === "preview") {
        if (onPreview) onPreview(address)
        else {
          const url = value.registeredUrl ?? await registerPreviewTarget(address, projectId)
          if (life === generation.current) window.location.assign(url)
        }
      } else {
        actionController.current = new AbortController()
        if (action === "download") setDownloading(true)
        await executeResourceAction(address, action, projectId, actionController.current.signal, value.registeredUrl)
      }
    } catch (e) {
      if (life === generation.current) setError(e instanceof Error ? e.name === "AbortError" ? "File action cancelled. Retry when connected." : e.message : "File action failed.")
    } finally {
      if (life === generation.current) { busy.current = false; setPreparing(false); setDownloading(false) }
    }
  }
  if (!target || !address) return <a {...props} href={target ? href : undefined} target={target?.kind === "internal" ? props.target : "_blank"} rel="noopener noreferrer">{children}</a>
  return <ContextMenu onOpenChange={open => { if (open) loadMenu(); else { menuGeneration.current++; setMenu(undefined) } }}>
    <ContextMenuTrigger asChild>
      <a {...props} href={resourceResolutionHref(address, projectId)} aria-busy={preparing || undefined}
        onContextMenu={event => event.stopPropagation()}
        onKeyDown={event => {
          if (event.key === "ContextMenu" || event.key === "F10" && event.shiftKey) {
            event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect()
            event.currentTarget.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: rect.left, clientY: rect.bottom }))
          }
        }}
        onClick={event => {
          props.onClick?.(event)
          if (event.defaultPrevented || !isPlainPreviewClick(event) || props.target === "_blank") return
          event.preventDefault(); void activate()
        }}
      >{children}</a>
    </ContextMenuTrigger>
    <ContextMenuContent onContextMenu={event => event.stopPropagation()}>
      {!menu || menu.status === "loading" ? <ContextMenuItem disabled>Loading file actions…</ContextMenuItem>
        : menu.status === "error" ? <>
          <ContextMenuItem disabled>{menu.error}</ContextMenuItem>
          <ContextMenuItem onSelect={event => { event.preventDefault(); loadMenu() }}>Retry file actions</ContextMenuItem>
        </> : <>
          {policyFor(menu.value).actions.map(item => <ContextMenuItem key={item.action} disabled={item.disabled} onSelect={() => { void activate(item.action) }}>{item.label}</ContextMenuItem>)}
          {menu.value.metadata.directory && !menu.value.capabilities.local ? <ContextMenuItem disabled>Folder links cannot be downloaded.</ContextMenuItem> : null}
        </>}
    </ContextMenuContent>
    {preparing ? <span role="status" className="ml-2 text-xs text-muted-foreground">Preparing file action…</span> : null}
    {error ? <span role="alert" className="ml-2 text-xs text-destructive">{error} <button type="button" className="underline" onClick={() => { void activate() }}>Retry</button></span> : null}
    {downloading ? <button type="button" className="ml-2 text-xs underline" onClick={() => actionController.current?.abort()}>Cancel download</button> : null}
  </ContextMenu>
}
