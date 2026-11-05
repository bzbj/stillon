import { useEffect, useState } from "react"
import { PROVIDERS, type ProviderCatalogEntry } from "../../shared/types"

export const notifyAddonsChanged = () => window.dispatchEvent(new Event("stillon:addons-changed"))
export function useProviderCatalog() {
  const [providers, setProviders] = useState<ProviderCatalogEntry[]>(() => PROVIDERS.filter(item => item.id === "codex" || item.id === "claude"))
  useEffect(() => {
    let disposed = false, generation = 0
    const refresh = async () => {
      const current = ++generation
      try {
        const response = await fetch("/api/providers", { cache: "no-store" })
        if (!response.ok) return
        const data = await response.json()
        if (!disposed && generation === current && Array.isArray(data.providers)) setProviders(data.providers)
      } catch { /* Retain the last successful catalog during reconnect. */ }
    }
    void refresh()
    const interval = window.setInterval(() => void refresh(), 10_000)
    window.addEventListener("focus", refresh); window.addEventListener("stillon:addons-changed", refresh)
    return () => { disposed = true; window.clearInterval(interval); window.removeEventListener("focus", refresh); window.removeEventListener("stillon:addons-changed", refresh) }
  }, [])
  return providers
}
