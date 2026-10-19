import type { FileRenderer } from "../../shared/file-renderers"
import { coalesceResourceRequest } from "./resourceRequests"
export interface ResourceMetadata { kind: "file" | "directory" | "service"; directory?: boolean; renderer?: FileRenderer; canRead?: boolean; canPreview?: boolean; canDownload?: boolean }

/** Read-only preparation: no target registration, preview grant or OS action. */
export function resolveResourceMetadata(address: string, projectId?: string): Promise<ResourceMetadata> {
  return coalesceResourceRequest("metadata", address, projectId, async () => {
    const response = await fetch("/api/preview-targets/resolve", { method: "POST", cache: "no-store",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address, projectId }) })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.error || "File information is unavailable. Reconnect and retry.")
    if (!["file", "directory", "service"].includes(body.kind) || typeof body.canRead !== "boolean") throw new Error("Update the host to resolve file actions.")
    return body as ResourceMetadata
  })
}
export function resourceResolutionHref(address: string, projectId?: string) {
  const query = new URLSearchParams({ address })
  if (projectId) query.set("projectId", projectId)
  return "/resolve-resource?" + query
}
