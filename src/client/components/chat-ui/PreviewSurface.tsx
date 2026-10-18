import { parsePreviewTarget } from "../../../shared/preview-target"
import { MarkdownPreviewPanel } from "./MarkdownPreviewPanel"
import { IsolatedPreview } from "./IsolatedPreview"

export function PreviewSurface({ address, projectId, refreshVersion = 0, zoom = 1, onNavigate, canOpenHostFiles, projectLocalPath, onOpenHostFile }: {
  address: string; projectId?: string; refreshVersion?: number; zoom?: number; onNavigate: (address: string, mode?: "replace" | "pop") => void
  canOpenHostFiles?: boolean; projectLocalPath?: string | null; onOpenHostFile?: (path: string, action: "open_default") => void
}) {
  const target = parsePreviewTarget(address, projectId)
  if (!target) return <div role="alert" className="p-6 text-sm">This address cannot be previewed. Use an HTTP(S) URL or an authorized document.</div>
  if (target.kind === "host-file" || (target.kind === "project-file" && target.markdown)) return <MarkdownPreviewPanel
    source={target.kind === "host-file" ? { kind: "local", filePath: target.filePath } : { kind: "project", filePath: target.filePath, projectId: target.projectId }}
    address={address} workspaceId={projectId} refreshVersion={refreshVersion} zoom={zoom} onNavigate={onNavigate}
    canOpenHostFiles={canOpenHostFiles} projectLocalPath={projectLocalPath} onOpenHostFile={onOpenHostFile} />
  if (target.kind === "project-file" && !/\.html?$/iu.test(target.filePath)) return <iframe title="Document preview" src={address} sandbox="allow-downloads" className="h-full w-full border-0" />
  return <IsolatedPreview address={address} projectId={projectId} refreshVersion={refreshVersion} zoom={zoom} onNavigate={onNavigate} />
}
