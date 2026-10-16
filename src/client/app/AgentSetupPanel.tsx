import { useCallback, useEffect, useRef, useState } from "react"
import { CheckCircle2, ExternalLink, Loader2, Terminal } from "lucide-react"
import type { AgentProvider } from "../../shared/types"
import { PROVIDER_SETUP_GUIDES, type ProviderSetupStatus } from "../../shared/provider-setup"
import { Button } from "../components/ui/button"
import { Input } from "../components/ui/input"
import { cn } from "../lib/utils"

export function AgentSetupPanel({ initialProvider = "codex", machineName, onStatus, onUse }: {
  initialProvider?: AgentProvider; machineName?: string | null
  onStatus: (provider: AgentProvider, ready: boolean) => void
  onUse: (provider: AgentProvider) => Promise<void>
}) {
  const [provider, setProvider] = useState<AgentProvider>(initialProvider)
  const [status, setStatus] = useState<ProviderSetupStatus | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState("")
  const [waiting, setWaiting] = useState<"login" | "install" | null>(null)
  const [confirmInstall, setConfirmInstall] = useState(false)
  const [existing, setExisting] = useState(false), [executable, setExecutable] = useState("")
  const [complete, setComplete] = useState(false)
  const request = useRef(0), callbacks = useRef({ onStatus, onUse })
  callbacks.current = { onStatus, onUse }
  const label = provider === "codex" ? "Codex" : "Claude Code"
  const check = useCallback(async () => {
    const id = ++request.current
    setBusy(true); setError("")
    try {
      const response = await fetch(`/api/provider-setup/${provider}/status`, { cache: "no-store" })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Unable to check the Agent.")
      if (request.current !== id) return
      setStatus(data); callbacks.current.onStatus(provider, data.state === "ready")
      setWaiting(null)
    } catch (error) { if (request.current === id) setError(error instanceof Error ? error.message : "Check failed.") }
    finally { if (request.current === id) setBusy(false) }
  }, [provider])
  useEffect(() => { setStatus(null); setWaiting(null); setComplete(false); setConfirmInstall(false); setExisting(false); void check(); return () => { request.current++ } }, [check])
  async function openTerminal(action: "login" | "install") {
    setBusy(true); setError("")
    try {
      const response = await fetch(`/api/provider-setup/${provider}/${action}`, { method: "POST" })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Unable to open the terminal.")
      setWaiting(action); setConfirmInstall(false)
    } catch (error) { setError(error instanceof Error ? error.message : "Unable to open the terminal.") }
    finally { setBusy(false) }
  }
  async function useExecutable(value: string | null) {
    setBusy(true); setError("")
    try {
      const response = await fetch(`/api/provider-setup/${provider}/executable`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ executable: value }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Unable to use this executable.")
      setStatus(data); callbacks.current.onStatus(provider, data.state === "ready"); setWaiting(null); setExisting(false)
    } catch (error) { setError(error instanceof Error ? error.message : "Unable to use this executable.") }
    finally { setBusy(false) }
  }
  async function finish() {
    setBusy(true); setError("")
    try { await callbacks.current.onUse(provider); setComplete(true) }
    catch (error) { setError(error instanceof Error ? error.message : "Unable to save the selected Agent.") }
    finally { setBusy(false) }
  }
  return <div className="space-y-5">
    <div><h3 className="text-sm font-semibold">1. Choose one Agent</h3><p className="mt-1 text-xs text-muted-foreground">You only need one to get started. You can add another later.</p>
      <div className="mt-3 grid grid-cols-2 gap-3">{(["codex", "claude"] as const).map(value => <button key={value} type="button" aria-pressed={provider === value} disabled={busy} onClick={() => setProvider(value)} className={cn("rounded-xl border p-3 text-left text-sm transition-colors disabled:opacity-60", provider === value ? "border-primary bg-primary/5 font-semibold" : "border-border hover:bg-muted")}>
        {value === "codex" ? "Codex" : "Claude Code"}{value === "codex" && <span className="mt-1 block text-[10px] font-normal text-muted-foreground">Recommended</span>}
      </button>)}</div>
    </div>
    <div className="space-y-3 border-t border-border pt-4"><h3 className="text-sm font-semibold">2. Check {label} CLI</h3>
      {!status ? <p className="flex items-center gap-2 text-sm text-muted-foreground">{busy && <Loader2 className="size-4 animate-spin" />}Checking for an existing installation…</p> : status.installed ? <div className="rounded-lg bg-muted/50 p-3 text-sm"><p className="font-medium">Existing CLI found{status.version ? ` · ${status.version}` : ""}</p><p className="mt-1 break-all font-mono text-xs text-muted-foreground">{status.executable}</p></div> : <>
        <p className="text-sm text-muted-foreground">Could not find {label} CLI on {machineName || "this computer"}. If you already installed it, recheck or choose its location.</p>
        {status.canOpenTerminal && <Button disabled={busy || Boolean(waiting)} onClick={() => setConfirmInstall(true)}>Install {label} CLI</Button>}
      </>}
      {confirmInstall && <div className="space-y-3 rounded-lg border border-border p-3"><p className="text-sm">This opens a terminal on {machineName || "this computer"} and runs the official {label} CLI installer. Continue if you want to install a new CLI.</p><div className="flex flex-wrap gap-2"><Button disabled={busy} onClick={() => void openTerminal("install")}>Open terminal and install</Button><Button disabled={busy} variant="ghost" onClick={() => setConfirmInstall(false)}>Cancel</Button></div></div>}
      <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy} onClick={() => void check()}>{waiting === "install" ? "I have installed it · Recheck" : "Recheck installation"}</Button>{status?.canOpenTerminal && <Button variant="ghost" disabled={busy} onClick={() => setExisting(!existing)}>Use an existing CLI</Button>}</div>
      {existing && <div className="space-y-2 rounded-lg border border-border p-3"><label htmlFor="existing-agent-cli" className="text-xs font-medium">Existing CLI executable</label><Input id="existing-agent-cli" value={executable} onChange={event => setExecutable(event.target.value)} placeholder={status?.platform === "win32" ? `C:\\Users\\example\\.local\\bin\\${provider}.exe` : `~/.local/bin/${provider}`} /><div className="flex flex-wrap gap-2"><Button size="sm" disabled={busy || !executable.trim()} onClick={() => void useExecutable(executable)}>Use this CLI</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => void useExecutable(null)}>Use automatic detection</Button></div></div>}
      <a href={PROVIDER_SETUP_GUIDES[provider]} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-muted-foreground underline">Official CLI installation guide<ExternalLink className="size-3" /></a>
    </div>
    <div className="space-y-3 border-t border-border pt-4"><h3 className="text-sm font-semibold">3. Sign in to {label}</h3>
      {status?.state === "ready" ? <><p className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-300"><CheckCircle2 className="size-4" />{label} CLI is signed in.</p><Button disabled={busy || complete} onClick={() => void finish()}>{complete ? "Agent setup complete" : `Use ${label}`}</Button>{complete && <a className="ml-3 text-sm underline" href="/">Open a workspace</a>}</> : <>
        <p className="text-sm leading-6 text-muted-foreground">Sign in with the official CLI in a visible terminal. Complete its browser sign-in, then return here.</p>
        {status?.canOpenTerminal ? <div className="flex flex-wrap gap-2"><Button disabled={busy || !status.installed || status.state === "error"} onClick={() => void openTerminal("login")}><Terminal className="mr-2 size-4" />{waiting === "login" ? "Reopen sign-in terminal" : "Open terminal to sign in"}</Button><Button variant="outline" disabled={busy || !status.installed} onClick={() => void check()}>Check sign-in</Button></div> : status && <p className="text-sm text-muted-foreground">Open StillOn locally on {machineName || "the Agent computer"} to install or sign in.</p>}
      </>}
      {waiting && <p role="status" className="text-xs text-muted-foreground">Finish {waiting === "install" ? "installation" : "sign-in"} in the terminal, then recheck. Closing the terminal keeps this step unfinished.</p>}
      {status?.message && <p className="text-sm text-muted-foreground">{status.message}</p>}
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>
}
