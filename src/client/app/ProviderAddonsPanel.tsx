import { useCallback, useEffect, useState } from "react"
import { Link } from "react-router-dom"
import type { AddonList } from "../../shared/provider-addons"
import { isAddonProvider } from "../../shared/types"
import { notifyAddonsChanged } from "../hooks/useProviderCatalog"
import { Button } from "../components/ui/button"
import { AgentSetupPanel } from "./AgentSetupPanel"

export function ProviderAddonsPanel() {
  const [snapshot, setSnapshot] = useState<AddonList | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("")
  const refresh = useCallback(async () => {
    const response = await fetch("/api/addons", { cache: "no-store" }), data = await response.json()
    if (!response.ok) throw new Error(data.error || "Unable to load integrations.")
    setSnapshot(data)
  }, [])
  useEffect(() => {
    const reload = () => { void refresh().catch(error => setError(error.message)) }
    reload()
    const interval = window.setInterval(reload, 5000)
    window.addEventListener("focus", reload)
    return () => { window.clearInterval(interval); window.removeEventListener("focus", reload) }
  }, [refresh])
  async function toggle(id: string, enabled: boolean) {
    setBusy(true); setError("")
    try {
      const response = await fetch("/api/addons", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, action: enabled ? "disable" : "enable" }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Unable to change integration.")
      notifyAddonsChanged(); await refresh()
    } catch (error) { setError(error instanceof Error ? error.message : "Integration change failed.") }
    finally { setBusy(false) }
  }
  return <section aria-label="Optional integrations" className="space-y-3">
    {!snapshot && !error && <p role="status" className="text-sm text-muted-foreground">Loading integrations…</p>}
    {snapshot?.addons.length === 0 && <p className="text-sm text-muted-foreground">No optional integrations are included in this build.</p>}
    {snapshot?.addons.map(addon => {
      const name = addon.id === "codebuddy" ? "Workbuddy (Codebuddy CLI)" : addon.name
      return <article key={addon.id} aria-label={name} className="rounded-xl border border-border p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0"><h3 className="font-medium leading-snug">{name} <span className="inline-block rounded border border-border bg-muted/50 px-1.5 py-0.5 align-middle text-[10px] font-medium leading-none text-muted-foreground">Preview</span></h3><p className="mt-1 text-xs text-muted-foreground">{addon.error ? "Unavailable" : addon.enabled ? "Enabled" : "Disabled"}</p></div>
        <Button className="shrink-0" size="sm" variant={addon.enabled ? "default" : "outline"} role="switch" aria-label={name} aria-checked={addon.enabled}
          disabled={busy || addon.busy || !snapshot.canManage || (!addon.enabled && !addon.compatible)} onClick={() => void toggle(addon.id, addon.enabled)}>{addon.enabled ? "Disable" : "Enable"}</Button>
      </div>
      {addon.error && <p role="alert" className="text-sm text-destructive">{addon.error}</p>}
      {addon.busy && <p className="text-sm text-muted-foreground">Finish or stop this agent's active chats before disabling it.</p>}
      {addon.enabled && addon.compatible && isAddonProvider(addon.id) && <div className="space-y-3 border-t border-border pt-3">
        <AgentSetupPanel initialProvider={addon.id} showProviderPicker={false} hideUseWhenReady collapseWhenReady onStatus={() => { void refresh().catch(error => setError(error.message)) }} onUse={async () => {}} />
        <Link className="inline-block text-sm underline" to={`/settings/providers?provider=${addon.id}`}>Configure {addon.id === "deepseek" ? "Harness models and credentials" : "CodeBuddy defaults"}</Link>
      </div>}
    </article>})}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>
}
