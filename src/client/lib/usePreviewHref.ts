import { useEffect, useState } from "react"
import { registerPreviewTarget } from "./previewTarget"

export function usePreviewHref(address: string | null, projectId?: string) {
  const [resolved, setResolved] = useState<{ address: string; url: string }>()
  useEffect(() => {
    if (!address) return
    let cancelled = false
    void registerPreviewTarget(address, projectId).then(url => { if (!cancelled) setResolved({ address, url }) }).catch(() => undefined)
    return () => { cancelled = true }
  }, [address, projectId])
  return resolved?.address === address ? resolved.url : null
}
