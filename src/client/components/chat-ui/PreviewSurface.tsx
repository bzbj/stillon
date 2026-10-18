import { useEffect, useState } from "react"
import { parsePreviewTarget, type PreviewTarget } from "../../../shared/preview-target"
import { fileRenderer } from "../../../shared/file-renderers"
import { MarkdownPreviewPanel } from "./MarkdownPreviewPanel"
import { IsolatedPreview } from "./IsolatedPreview"
import { ImagePreviewPanel } from "./ImagePreviewPanel"
import { TextPreviewPanel } from "./TextPreviewPanel"
import { DirectHtmlPreview } from "./DirectHtmlPreview"
import { registerPreviewTarget } from "../../lib/previewTarget"

type Props = {
  address: string; projectId?: string; refreshVersion?: number; zoom?: number; onNavigate: (address: string, mode?: "replace" | "pop") => void
  canOpenHostFiles?: boolean; projectLocalPath?: string | null; onOpenHostFile?: (path: string, action: "open_default") => void
}
export function PreviewSurface(props: Props) {
  const target = parsePreviewTarget(props.address, props.projectId)
  if (!target) return <div role="alert" className="p-6 text-sm">This address cannot be previewed. Open an authorized file or host service.</div>
  if (target.kind === "external-http") return <div className="p-6 text-sm"><p>External websites open in your browser.</p><a className="underline" href={target.address} target="_blank" rel="noopener noreferrer">Open in browser</a></div>
  if (target.kind === "host-http") return <IsolatedPreview address={props.address} projectId={props.projectId} refreshVersion={props.refreshVersion ?? 0} zoom={props.zoom ?? 1} onNavigate={props.onNavigate} />
  return <FileSurface {...props} />
}
function FileSurface({ address, projectId, refreshVersion = 0, zoom = 1, onNavigate, projectLocalPath }: Props) {
  const [entry, setEntry] = useState<{ id: string; target: PreviewTarget; projectLocalPath?: string; address: string }>(), [error, setError] = useState<string>()
  useEffect(() => {
    let active = true
    setError(undefined)
    void registerPreviewTarget(address, projectId).then(async url => {
      const id = url.split("/").pop()!, response = await fetch(`/api/preview-targets/${id}`, { cache: "no-store" })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || "File unavailable")
      if (active) setEntry({ id, ...body, address })
    }).catch(e => { if (active) setError(e.message) })
    return () => { active = false }
  }, [address, projectId, refreshVersion])
  if (error) return <p role="alert" className="p-6">{error}</p>
  if (!entry || entry.address !== address || !("filePath" in entry.target) || !entry.target.filePath) return <p className="p-6">Loading file preview…</p>
  const target = entry.target, filePath = target.filePath!, renderer = fileRenderer(target.canonicalPath ?? filePath)
  const contentUrl = `/api/preview-targets/${entry.id}/content`
  if (renderer === "markdown") return <MarkdownPreviewPanel
    source={target.kind === "project-file" ? { kind: "project", filePath, projectId: target.projectId } : { kind: "local", filePath }}
    contentUrl={contentUrl} address={address} workspaceId={projectId} refreshVersion={refreshVersion} zoom={zoom} onNavigate={onNavigate}
    projectLocalPath={projectLocalPath ?? entry.projectLocalPath} />
  if (renderer === "html") return <DirectHtmlPreview target={target} projectId={projectId} refreshVersion={refreshVersion} zoom={zoom} onNavigate={(next, mode) => {
    if (mode) setEntry(previous => previous ? { ...previous, address: next, target: { ...previous.target, address: next } } : previous)
    onNavigate(next, mode)
  }} />
  if (renderer === "image") return <ImagePreviewPanel src={`${contentUrl}?refresh=${refreshVersion}`} name={filePath} zoom={zoom} />
  if (renderer === "text") return <TextPreviewPanel src={contentUrl} name={filePath} zoom={zoom} refreshVersion={refreshVersion} address={address} />
  return <p role="alert" className="p-6">This file has no preview renderer.</p>
}
