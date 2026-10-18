import { useEffect, useState } from "react"
export interface LinkCapabilities { local: boolean; isMac: boolean; filePreviewProtocol: number; error?: string }
let cached: LinkCapabilities | undefined
let pending: Promise<LinkCapabilities> | undefined
export function useLinkCapabilities() {
  const [value, setValue] = useState(cached)
  useEffect(() => {
    let active = true
    pending ??= fetch("/api/link-capabilities", { cache: "no-store" }).then(async response => {
      if (!response.ok) throw new Error("File actions are unavailable. Reconnect or update StillOn.")
      const result = await response.json()
      if (typeof result.local !== "boolean" || typeof result.isMac !== "boolean") throw new Error("Update StillOn to use file actions.")
      cached = result
      return result as LinkCapabilities
    }).catch(error => { pending = undefined; throw error })
    void pending.then(result => { if (active) setValue(result) }).catch(error => {
      if (active) setValue({ local: false, isMac: false, filePreviewProtocol: 0, error: error.message })
    })
    return () => { active = false }
  }, [])
  return value
}
