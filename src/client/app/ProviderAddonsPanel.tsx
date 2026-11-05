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
  return <section aria-label="Optional integrations" className="space-y-5">
    <p className="text-sm text-muted-foreground">Codex and Claude Code are ready to set up in Providers. Enable additional agents here to show them in Providers and chat menus.</p>
    <p className="text-sm text-muted-foreground">These integrations are included with StillOn and update with the app. Each uses the agent CLI installed on this computer and its own sign-in or API configuration.</p>
    {snapshot && !snapshot.canManage && <p className="text-sm text-muted-foreground">Open StillOn locally on the agent computer to enable or disable integrations.</p>}
    {!snapshot && !error && <p role="status" className="text-sm text-muted-foreground">Loading integrations…</p>}
    {snapshot?.addons.length === 0 && <p className="text-sm text-muted-foreground">No optional integrations are included in this build.</p>}
    {snapshot?.addons.map(addon => <article key={addon.id} aria-label={addon.name} className="rounded-xl border border-border p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div><h3 className="font-medium">{addon.name}</h3><p className="text-xs text-muted-foreground">{addon.error ? "Unavailable" : addon.enabled ? "Enabled" : "Disabled"}</p></div>
        <Button size="sm" variant={addon.enabled ? "default" : "outline"} role="switch" aria-label={addon.name} aria-checked={addon.enabled}
          disabled={busy || addon.busy || !snapshot.canManage || (!addon.enabled && !addon.compatible)} onClick={() => void toggle(addon.id, addon.enabled)}>{addon.enabled ? "Disable" : "Enable"}</Button>
      </div>
      <p className="text-sm text-muted-foreground">{addon.id === "deepseek" ? "Connect to your local DeepSeek Harness. Choose its model service, API key and available models after enabling." : "Connect to the public CodeBuddy CLI. Uses its configured model and account. WorkBuddy desktop integration is not included."}</p>
      {addon.error && <p role="alert" className="text-sm text-destructive">{addon.error}</p>}
      {addon.busy && <p className="text-sm text-muted-foreground">Finish or stop this agent's active chats before disabling it.</p>}
      {addon.enabled && addon.compatible && isAddonProvider(addon.id) && <div className="space-y-3 border-t border-border pt-3">
        <AgentSetupPanel initialProvider={addon.id} showProviderPicker={false} hideUseWhenReady collapseWhenReady onStatus={() => { void refresh().catch(error => setError(error.message)) }} onUse={async () => {}} />
        <Link className="inline-block text-sm underline" to={`/settings/providers?provider=${addon.id}`}>Configure {addon.id === "deepseek" ? "Harness models and credentials" : "CodeBuddy defaults"}</Link>
      </div>}
      <p className="text-xs text-muted-foreground">Disabling preserves your settings and chats.</p>
    </article>)}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>
}
