import { useEffect, useState } from "react"
import { Check, Copy, ExternalLink, LoaderCircle, Monitor } from "lucide-react"
import { Button, buttonVariants } from "../components/ui/button"
import { BrowserSessionSettings } from "./BrowserSessionSettings"
import type { ConnectHost, ConnectLocalStatus, ConnectRemoteStatus } from "../../shared/connect"

const labels: Record<ConnectLocalStatus["state"], string> = { unbound: "No email linked", pending: "Waiting for email verification", connecting: "Connecting", online: "Remote access is on", offline: "This computer is offline", paused: "Remote access is paused", revoked: "Computer unlinked", "revocation-pending": "Connection closed; unlinking pending" }
const errors: Record<string, string> = { CONNECTOR_NOT_INSTALLED: "The Connect component is not installed. Prepare it to enable remote access.", CONNECTOR_DOWNLOAD_FAILED: "The Connect component could not be downloaded. Check your internet connection, then retry.", CONNECTOR_INTEGRITY_FAILED: "The Connect component did not pass verification. Repair it before using remote access.", CONNECTOR_BLOCKED: "The Connect component is missing or could not run. Review your system's security notifications, then retry. Local use remains available.", CONNECTOR_REPAIR_REQUIRED: "Connect component setup did not finish. Retry to prepare it again.", CONNECTOR_COMPONENT_INVALID: "This version has an invalid Connect component requirement. Contact your installation provider.", CONNECTOR_PREPARING: "The Connect component is being prepared. Please wait.", SERVICE_NOT_CONFIGURED: "The remote service address is not configured.", BUSY: "The connection is updating. Please try again shortly.", CLOUD_UPDATE_PENDING: "The local connection is closed. Changes will sync when this computer is back online.", DEVICE_ALREADY_CONNECTED: "Another computer is using this identity. Unlink the original computer before linking this one.", BINDING_EXPIRED: "The link request has expired. Please start again.", DEVICE_STATE_INVALID: "Unable to read this computer's identity. Please contact your installation provider." }

export function RemoteAccessSettings({ onSignOut }: { onSignOut: () => Promise<void> }) {
  const [local, setLocal] = useState<ConnectLocalStatus | null>(null)
  const [remote, setRemote] = useState<ConnectRemoteStatus | null>(null)
  const [hosts, setHosts] = useState<ConnectHost[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [copied, setCopied] = useState(false)
  const [diagnosticsCopied, setDiagnosticsCopied] = useState(false)
  const [confirmUnbind, setConfirmUnbind] = useState(false)
  async function refresh() {
    const response = await fetch("/auth/status", { cache: "no-store" })
    if (!response.ok) throw new Error("Unable to read the connection status.")
    const auth = await response.json()
    if (auth.mode === "connect") {
      setRemote(auth)
      const response = await fetch("/_connect/hosts", { cache: "no-store" })
      if (response.ok) setHosts((await response.json()).hosts)
    } else {
      const response = await fetch("/api/connect-local/status", { cache: "no-store" })
      if (!response.ok) throw new Error(response.status === 403 ? "Open StillOn at its local address on this computer to manage remote access." : "Unable to read the connection status.")
      setLocal(await response.json())
    }
  }
  useEffect(() => { void refresh().catch(e => setError(e.message)); const timer = window.setInterval(() => { void refresh().catch(() => {}) }, 5_000); return () => window.clearInterval(timer) }, [])
  async function action(name: "enroll" | "pause" | "resume" | "unbind" | "repair-transport") {
    setBusy(true); setError("")
    try {
      const response = await fetch(`/api/connect-local/${name}`, { method: "POST" })
      const data = await response.json()
      if (!response.ok) throw new Error(errors[data.error] ?? "Unable to reach the remote service. Please try again shortly.")
      await refresh(); setConfirmUnbind(false)
    } catch (e) { setError(e instanceof Error ? e.message : "The action could not be completed.") }
    finally { setBusy(false) }
  }
  async function refreshLinkStatus() {
    setBusy(true); setError("")
    try { await refresh() }
    catch (e) { setError(e instanceof Error ? e.message : "Unable to refresh the link status.") }
    finally { setBusy(false) }
  }
  async function copyDiagnostics() {
    try {
      let report: unknown
      if (remote) report = { schema: 1, scope: "remote-browser", generatedAt: new Date().toISOString(), authenticated: remote.authenticated, online: remote.host?.online ?? false, paused: remote.host?.paused ?? false }
      else {
        const response = await fetch("/api/connect-local/diagnostics", { cache: "no-store" })
        if (!response.ok) throw new Error("Unable to read connection diagnostics.")
        report = await response.json()
      }
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2)); setDiagnosticsCopied(true)
      setTimeout(() => setDiagnosticsCopied(false), 2_000)
    } catch { setError("Unable to copy diagnostics. Please try again.") }
  }
  return <section className="max-w-xl space-y-6 py-6">
    {remote ? <>
      <div className="flex items-center gap-3"><Monitor className="size-5" /><div><h3 className="font-medium">{remote.host?.name ?? "Current computer"}</h3><p className="mt-1 text-sm text-muted-foreground">You are using this computer remotely. Tasks and files stay on this computer.</p></div></div>
      {hosts.length > 1 && <div className="space-y-3"><h4 className="text-sm font-medium">Switch computers</h4>{hosts.map(host => <div key={host.id} className="flex items-center gap-4 rounded-xl border p-4"><span className="min-w-0 flex-1 truncate text-sm">{host.name} · {host.online ? "Online" : "Offline"}</span>{host.id === remote.host?.id ? <span className="text-xs text-muted-foreground">Current computer</span> : <a className="text-sm underline" href={`${host.url}/_connect/login`}>Switch</a>}</div>)}</div>}
      <p className="text-sm leading-6 text-muted-foreground">Switching affects only this tab. Logout ends all computer connections in this browser. Tasks on your computers keep running.</p>
      <Button variant="outline" onClick={() => void onSignOut()}>Logout</Button>
    </> : local ? <>
      <div className="rounded-2xl border p-5"><div className="flex items-center gap-3"><span className={`size-2 rounded-full ${local.state === "online" ? "bg-emerald-500" : "bg-muted-foreground/40"}`} /><h3 className="font-medium">{labels[local.state]}</h3></div><p className="mt-3 text-sm text-muted-foreground">{local.name}{local.email ? ` · ${local.email}` : ""}</p></div>
      <p className="text-sm leading-6 text-muted-foreground">Link your email, then sign in from another device to continue tasks, view files and edit results. Keep this computer on, online and running StillOn.</p>
      {local.transport && local.transport.state !== "ready" && <div role="status" className="space-y-3 rounded-xl border p-4">
        <p className="text-sm leading-6">{local.transport.state === "preparing" ? "Preparing the Connect component…" : errors[local.transport.error ?? "CONNECTOR_NOT_INSTALLED"] ?? "The Connect component needs repair."}</p>
        {local.transport.state !== "preparing" && local.transport.error !== "CONNECTOR_COMPONENT_INVALID" && <Button disabled={busy} variant="outline" onClick={() => void action("repair-transport")}>{busy && <LoaderCircle className="mr-2 size-4 animate-spin" />}Repair Connect component</Button>}
      </div>}
      {!local.configured ? <p className="text-sm text-muted-foreground">Remote access is not configured in this version. Local use is still available.</p> : local.state === "revocation-pending" ? <p className="text-sm text-muted-foreground">The local connection is closed. Unlinking will finish when this computer is online. Wait for it to sync before linking again.</p> : !local.hostId ? <div className="space-y-4">
        {local.enrollment ? <>
          <div className="space-y-4 rounded-xl bg-muted/40 p-4">
            <p className="text-sm leading-6">Enter your email and the six-digit code on the verification page, then return here to finish linking this computer.</p>
            <a className={buttonVariants({ className: "h-auto min-h-10 gap-2 whitespace-normal text-center" })} href={local.enrollment.verificationUrl} target="_blank" rel="noreferrer">Open email verification<ExternalLink className="size-4 shrink-0" /></a>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy} variant="outline" onClick={() => void refreshLinkStatus()}>{busy && <LoaderCircle className="mr-2 size-4 animate-spin" />}Refresh link status</Button>
            <Button disabled={busy} variant="ghost" onClick={() => void action("unbind")}>Cancel linking</Button>
          </div>
        </> : <Button disabled={busy} onClick={() => void action("enroll")}>{busy && <LoaderCircle className="mr-2 size-4 animate-spin" />}Link email</Button>}
      </div> : <>
        <div className="space-y-2"><p className="text-sm font-medium">Remote login URL</p><div className="flex items-center gap-3"><a href={local.origin!} target="_blank" rel="noreferrer" className="min-w-0 break-all text-sm underline">{local.origin}</a><Button size="icon" variant="ghost" aria-label="Copy remote URL" onClick={() => { void navigator.clipboard.writeText(local.origin!).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2_000) }) }}>{copied ? <Check className="size-4" /> : <Copy className="size-4" />}</Button></div></div>
        <div className="flex flex-wrap gap-3">{!["revoked", "revocation-pending"].includes(local.state) && <Button disabled={busy} variant="outline" onClick={() => void action(local.state === "paused" ? "resume" : "pause")}>{local.state === "paused" ? "Resume remote access" : "Pause remote access"}</Button>}<Button disabled={busy} variant="ghost" onClick={() => setConfirmUnbind(true)}>Unlink email</Button></div>
        {confirmUnbind && <div className="space-y-3 rounded-xl border p-4"><p className="text-sm leading-6">Unlinking closes all remote connections to this computer. Local files and tasks are preserved. You can link an email again later.</p><div className="flex gap-3"><Button disabled={busy} variant="destructive" onClick={() => void action("unbind")}>Confirm unlink</Button><Button variant="ghost" onClick={() => setConfirmUnbind(false)}>Cancel</Button></div></div>}
      </>}
      {local.error && local.error !== local.transport?.error && <p className="text-sm text-muted-foreground">{errors[local.error] ?? "The connection is unavailable. StillOn will try to reconnect automatically."}</p>}
    </> : !error ? <p className="text-sm text-muted-foreground">Loading connection status…</p> : null}
    {(remote?.authenticated || (local?.hostId && !["revoked", "revocation-pending"].includes(local.state))) && <BrowserSessionSettings remote={Boolean(remote)} logoutUrl={remote ? `${remote.portalUrl}/logout/complete` : undefined} />}
    {(local || remote) && <div className="space-y-2 border-t pt-4"><Button variant="ghost" onClick={() => void copyDiagnostics()}>{diagnosticsCopied ? "Diagnostics copied" : "Copy connection diagnostics"}</Button><p className="text-xs text-muted-foreground">Includes connection status and version details for troubleshooting. Excludes email addresses, keys and file contents.</p></div>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>
}
