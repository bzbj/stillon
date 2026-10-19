import type { FileRenderer } from "../../shared/file-renderers"
import { coalesceResourceRequest, getResourceEpoch, subscribeResourceScope } from "./resourceRequests"
import type { PreviewTarget } from "../../shared/preview-target"
export interface ResolvedPreviewEntry { id: string; target: PreviewTarget; address: string; projectId?: string; projectLocalPath?: string }
interface RegisteredResource { url: string; id?: string; target?: PreviewTarget; projectLocalPath?: string; directory?: boolean; renderer?: FileRenderer }
const prepared = new Map<string, { epoch: number; expires: number; entry: ResolvedPreviewEntry }>()
subscribeResourceScope(() => prepared.clear())
function takePrepared(id?: string, address?: string, projectId?: string) {
  for (const [key, value] of prepared) {
    if (value.epoch !== getResourceEpoch() || value.expires < Date.now()) { prepared.delete(key); continue }
    if (id ? key === id : value.entry.address === address && value.entry.projectId === projectId) {
      prepared.delete(key)
      return value.entry
    }
  }
}
export async function readPreviewEntry(id: string): Promise<ResolvedPreviewEntry> {
  const cached = takePrepared(id)
  if (cached) return cached
  return coalesceResourceRequest("read-entry", id, undefined, async () => {
    const response = await fetch(`/api/preview-targets/${encodeURIComponent(id)}`, { cache: "no-store" })
    const body = await response.json()
    if (!response.ok || typeof body.target?.address !== "string") throw new Error(body.error || "File unavailable")
    return { ...body, id, address: body.target.address }
  })
}
export async function preparePreviewEntry(address: string, projectId?: string) {
  const cached = takePrepared(undefined, address, projectId)
  if (cached) return cached
  const url = await registerPreviewTarget(address, projectId)
  return readPreviewEntry(url.split("/").pop()!)
}
export async function registerResourceTarget(address: string, projectId?: string): Promise<RegisteredResource> {
  const epoch = getResourceEpoch()
  return coalesceResourceRequest("register", address, projectId, async () => {
  const response = await fetch("/api/preview-targets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address, projectId }) })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || typeof body.url !== "string" || !/^\/preview\/[\w-]+$/u.test(body.url)) throw new Error(body.error || "This server does not support standalone previews. Update StillOn and retry.")
  if (epoch === getResourceEpoch() && body.target && typeof body.target.address === "string") {
    if (prepared.size >= 128) prepared.delete(prepared.keys().next().value!)
    const id = body.url.split("/").pop()!
    prepared.set(id, { epoch, expires: Date.now() + 5_000, entry: { id, target: body.target, projectId, projectLocalPath: body.projectLocalPath, address } })
  }
  return body
  })
}
export async function registerPreviewTarget(address: string, projectId?: string) { return (await registerResourceTarget(address, projectId)).url }

export async function openStandalonePreview(address: string, projectId?: string) {
  // Reserve the tab during the user gesture, before asynchronous authorization.
  const tab = window.open("about:blank", "_blank")
  if (tab) tab.opener = null
  try {
    const url = await registerPreviewTarget(address, projectId)
    if (tab) tab.location.replace(url)
    else window.location.assign(url)
  } catch (error) { tab?.close(); throw error }
}
