import { lazy, Suspense, useEffect, useState } from "react"
import { localServiceBrowserAddress } from "../../lib/localServiceBrowser"
import { parsePreviewTarget } from "../../../shared/preview-target"
import { fileRenderer } from "../../../shared/file-renderers"
import { preparePreviewEntry, type ResolvedPreviewEntry } from "../../lib/previewTarget"
export type { ResolvedPreviewEntry } from "../../lib/previewTarget"
const MarkdownPreviewPanel = lazy(() => import("./MarkdownPreviewPanel").then(module => ({ default: module.MarkdownPreviewPanel })))
const HostServicePreview = lazy(() => import("./HostServicePreview").then(module => ({ default: module.HostServicePreview })))
const ImagePreviewPanel = lazy(() => import("./ImagePreviewPanel").then(module => ({ default: module.ImagePreviewPanel })))
const TextPreviewPanel = lazy(() => import("./TextPreviewPanel").then(module => ({ default: module.TextPreviewPanel })))
const DirectHtmlPreview = lazy(() => import("./DirectHtmlPreview").then(module => ({ default: module.DirectHtmlPreview })))

type Props = {
  resolvedEntry?: ResolvedPreviewEntry
  address: string; projectId?: string; refreshVersion?: number; zoom?: number; onNavigate: (address: string, mode?: "replace" | "pop") => void
  canOpenHostFiles?: boolean; projectLocalPath?: string | null; onOpenHostFile?: (path: string, action: "open_default") => void
}
export function PreviewSurface(props: Props) {
  const target = parsePreviewTarget(props.address, props.projectId)
  if (!target) return <div role="alert" className="p-6 text-sm">This address cannot be previewed. Open an authorized file or host service.</div>
  if (target.kind === "external-http") return <div className="p-6 text-sm"><p>External websites open in your browser.</p><a className="underline" href={target.address} target="_blank" rel="noopener noreferrer">Open in browser</a></div>
  const directService = target.kind === "host-http" ? localServiceBrowserAddress(target.address) : null
  if (directService) return <div className="p-6 text-sm" data-preview-local-service=""><p>本机服务网页可直接在浏览器中打开。</p><a className="underline" href={directService} target="_blank" rel="noopener noreferrer">在浏览器中打开 ↗</a></div>
  if (target.kind === "host-http") return <Suspense fallback={<p role="status" className="p-6">Loading service preview…</p>}><HostServicePreview key={`${props.projectId ?? ""}:${new URL(target.address).origin}`} address={target.address} projectId={props.projectId} refreshVersion={props.refreshVersion ?? 0} zoom={props.zoom ?? 1} onNavigate={props.onNavigate} /></Suspense>
  return <Suspense fallback={<p role="status" className="p-6">Loading file renderer…</p>}><FileSurface {...props} /></Suspense>
}
function FileSurface({ address, projectId, refreshVersion = 0, zoom = 1, onNavigate, projectLocalPath, resolvedEntry }: Props) {
  const [entry, setEntry] = useState<ResolvedPreviewEntry | undefined>(resolvedEntry), [error, setError] = useState<string>()
  useEffect(() => {
    let active = true
    setError(undefined)
    if (resolvedEntry?.address === address) { setEntry(resolvedEntry); return }
    void preparePreviewEntry(address, projectId).then(value => {
      if (active) setEntry(value)
    }).catch(e => { if (active) setError(e.message) })
    return () => { active = false }
  }, [address, projectId, refreshVersion, resolvedEntry])
  if (error) return <p role="alert" className="p-6">{error}</p>
  if (!entry || entry.address !== address || !("filePath" in entry.target) || !entry.target.filePath) return <p className="p-6">Loading file preview…</p>
  const target = entry.target, filePath = target.filePath!, renderer = fileRenderer(target.canonicalPath ?? filePath)
  const contentUrl = `/api/preview-targets/${entry.id}/content`
  if (renderer === "markdown") return <MarkdownPreviewPanel
    source={target.kind === "project-file" ? { kind: "project", filePath, projectId: target.projectId } : { kind: "local", filePath }}
    contentUrl={contentUrl} address={address} workspaceId={projectId} refreshVersion={refreshVersion} zoom={zoom} onNavigate={onNavigate}
    projectLocalPath={projectLocalPath ?? entry.projectLocalPath} />
  if (renderer === "html") return <DirectHtmlPreview targetId={entry.id} target={target} projectId={projectId} refreshVersion={refreshVersion} zoom={zoom} onNavigate={(next, mode) => {
    if (mode) setEntry(previous => previous ? { ...previous, address: next, target: { ...previous.target, address: next } } : previous)
    onNavigate(next, mode)
  }} />
  if (renderer === "image") return <ImagePreviewPanel src={`${contentUrl}?refresh=${refreshVersion}`} name={filePath} zoom={zoom} />
  if (renderer === "text") return <TextPreviewPanel src={contentUrl} name={filePath} zoom={zoom} refreshVersion={refreshVersion} address={address} />
  return <p role="alert" className="p-6">This file has no preview renderer.</p>
}
