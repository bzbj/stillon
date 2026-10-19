import { useEffect, useState, useSyncExternalStore } from "react"
import { coalesceResourceRequest, getResourceEpoch, subscribeResourceScope } from "./resourceRequests"
export interface LinkCapabilities { local: boolean; isMac: boolean; filePreviewProtocol: number; error?: string }
let cached: { epoch: number; expires: number; value: LinkCapabilities } | undefined
export function getLinkCapabilities(): Promise<LinkCapabilities> {
  const epoch = getResourceEpoch()
  if (cached?.epoch === epoch && cached.expires > Date.now()) return Promise.resolve(cached.value)
  return coalesceResourceRequest("capabilities", "", undefined, async () => {
    const response = await fetch("/api/link-capabilities", { cache: "no-store" })
    if (!response.ok) throw new Error("File actions are unavailable. Reconnect or update StillOn.")
    const result = await response.json()
    if (typeof result.local !== "boolean" || typeof result.isMac !== "boolean") throw new Error("Update StillOn to use file actions.")
    if (epoch === getResourceEpoch()) cached = { epoch, expires: Date.now() + 30_000, value: result }
    return result as LinkCapabilities
  })
}
export function useLinkCapabilities(enabled = true) {
  const epoch = useSyncExternalStore(subscribeResourceScope, getResourceEpoch, getResourceEpoch)
  const [value, setValue] = useState<LinkCapabilities>()
  useEffect(() => {
    if (!enabled) return
    let active = true
    setValue(undefined)
    void getLinkCapabilities().then(result => { if (active) setValue(result) }).catch(error => {
      if (active) setValue({ local: false, isMac: false, filePreviewProtocol: 0, error: error.message })
    })
    return () => { active = false }
  }, [enabled, epoch])
  return value
}
