import { useEffect, useState } from "react"
import { registerResourceTarget } from "./previewTarget"
import { parsePreviewTarget } from "../../shared/preview-target"
import type { FileRenderer } from "../../shared/file-renderers"

export function usePreviewResolution(address: string | null, projectId?: string) {
  const [resolved, setResolved] = useState<{ address: string; url?: string; error?: string; directory?: boolean; renderer?: FileRenderer }>()
  useEffect(() => {
    if (!address || parsePreviewTarget(address, projectId)?.kind === "external-http") return
    let cancelled = false
    void registerResourceTarget(address, projectId).then(value => { if (!cancelled) setResolved({ address, ...value }) }).catch(error => { if (!cancelled) setResolved({ address, error: error.message }) })
    return () => { cancelled = true }
  }, [address, projectId])
  return resolved?.address === address ? resolved : undefined
}

export function usePreviewHref(address: string | null, projectId?: string) { return usePreviewResolution(address, projectId)?.url ?? null }
