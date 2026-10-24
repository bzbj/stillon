import { useEffect, useState } from "react"
import { Button } from "../components/ui/button"
import type { AgentProvider } from "../../shared/types"
import type { ProviderCliUpdateStatus } from "../../shared/provider-cli-updates"
import { PROVIDER_SETUP_GUIDES } from "../../shared/provider-setup"

async function request(provider: AgentProvider, token?: string, refresh = false) {
  const response = await fetch(`/api/provider-cli-updates/${provider}${refresh ? "?refresh=1" : ""}`, {
    method: token ? "POST" : "GET", headers: token ? { "Content-Type": "application/json" } : undefined,
    body: token ? JSON.stringify({ updateToken: token }) : undefined,
  })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error || "Unable to check this CLI.")
  return body
}

function ProviderCliUpdateRow({ provider, label }: { provider: AgentProvider; label: string }) {
  const [status, setStatus] = useState<ProviderCliUpdateStatus | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const updating = status?.operation?.state === "updating"
  const elapsed = status?.operation?.startedAt ? Math.max(0, Math.floor((Date.now() - Date.parse(status.operation.startedAt)) / 1000)) : 0
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    async function read() {
      try {
        const next = await request(provider) as ProviderCliUpdateStatus
        if (!stopped) { setStatus(next); setError(null) }
        if (!stopped && next.operation?.state === "updating") timer = setTimeout(() => void read(), 1500)
      } catch { if (!stopped) { setError("Unable to check this CLI. Check the connection and try again."); timer = setTimeout(() => void read(), 5000) } }
    }
    void read()
    return () => { stopped = true; clearTimeout(timer) }
  }, [provider, updating])

  async function run(token?: string) {
    setPending(true); setError(null)
    try {
      if (token) {
        const operation = await request(provider, token)
        setStatus(current => current ? { ...current, operation, updateToken: undefined, repairToken: undefined } : current)
      } else setStatus(await request(provider, undefined, true))
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to update this CLI.") }
    finally { setPending(false) }
  }

  return <div className="flex min-w-0 flex-col gap-2 py-4" aria-label={`${label} CLI updates`}>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h3 className="text-sm font-medium">{label}</h3>
        <p className="text-sm text-muted-foreground">{status ? status.currentVersion ? `Current version ${status.currentVersion} · ${status.installation}` : status.installation : "Checking installed CLI…"}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={pending || updating} onClick={() => void run()}>Check for updates</Button>
        {status?.repairToken && <Button size="sm" disabled={pending || updating} onClick={() => void run(status.repairToken)}>Repair CLI · {status.repairVersion}</Button>}
        {status?.updateAvailable && status.updateToken && <Button size="sm" disabled={pending || updating} onClick={() => void run(status.updateToken)}>Update to {status.latest?.version}</Button>}
      </div>
    </div>
    {status?.latest && <p className="text-xs text-muted-foreground">
      Latest release {status.latest.version} · {new Date(status.latest.publishedAt).toISOString().slice(0, 10)} · {" "}
      <a className="underline" href={status.latest.url} target="_blank" rel="noreferrer">Release notes</a>
      {status.currentVersion && !status.updateAvailable && !status.reason && !status.releaseError && " · Up to date"}
    </p>}
    {status?.executable && <p className="break-all text-xs text-muted-foreground">Using: {status.executable}</p>}
    {status && <p className="text-xs text-muted-foreground">{status.automaticUpdates}</p>}
    {status?.reason && <p className="text-sm text-muted-foreground">{status.reason} <a className="underline" href={PROVIDER_SETUP_GUIDES[provider]} target="_blank" rel="noreferrer">Installation guide</a></p>}
    {status?.operation && <p role="status" className={status.operation.state === "failed" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>{status.operation.message}
      {updating && status.operation.startedAt && ` · Elapsed ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`}
    </p>}
    {(error || status?.releaseError) && <p role="alert" className="text-sm text-destructive">{error || status?.releaseError}</p>}
  </div>
}

export function ProviderCliUpdatesPanel() {
  return <section className="w-full min-w-0" aria-label="CLI updates">
    <p className="text-sm text-muted-foreground">StillOn checks releases and only updates when you choose. Updates use the existing installation. Finish agent work and close terminals first.</p>
    <div className="divide-y divide-border"><ProviderCliUpdateRow provider="codex" label="Codex" /><ProviderCliUpdateRow provider="claude" label="Claude Code" /></div>
  </section>
}
