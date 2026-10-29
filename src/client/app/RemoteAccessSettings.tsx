import { useEffect, useState } from "react"
import { Check, Copy, ExternalLink, LoaderCircle, Monitor } from "lucide-react"
import { Button, buttonVariants } from "../components/ui/button"
import { SharedWorkspacesSettings } from "./SharedWorkspacesSettings"
import { MyComputersSettings } from "./MyComputersSettings"
import { BrowserSessionSettings } from "./BrowserSessionSettings"
import type { ConnectLocalStatus, ConnectRemoteStatus } from "../../shared/connect"

const labels: Record<ConnectLocalStatus["state"], string> = { unbound: "No email linked", pending: "Waiting for email verification", connecting: "Connecting", online: "Remote access is on", offline: "This computer is offline", paused: "Remote access is paused", revoked: "Computer unlinked", "revocation-pending": "Connection closed; unlinking pending" }
const errors: Record<string, string> = {
  CONNECT_API_DNS_FAILED: "Connect could not resolve the service address. It will retry automatically.",
  CONNECT_API_CONNECTION_FAILED: "Connect could not reach the service. It will retry automatically.",
  CONNECT_API_TIMEOUT: "The Connect service connection timed out. It will retry automatically.",
  CONNECT_API_TLS_FAILED: "Connect could not verify the service's secure connection. Check the computer's date and network security settings.",
  CONNECT_TUNNEL_TIMEOUT: "The service responded, but the remote tunnel did not connect. Connect will retry automatically.",
  CONNECT_TUNNEL_DNS_FAILED: "The remote tunnel could not resolve its address. Connect will retry automatically.",
  CONNECT_TUNNEL_CONNECTION_FAILED: "The remote tunnel could not reach the service. Connect will retry automatically.",
  CONNECT_TUNNEL_TLS_FAILED: "The remote tunnel could not verify its secure connection. Check the computer's date and network security settings.",
  CONNECT_ROUTE_CHANGED: "Connect is reconnecting automatically.", CONNECTOR_NOT_INSTALLED: "The Connect component is not installed. Prepare it to enable remote access.", CONNECTOR_DOWNLOAD_FAILED: "The Connect component could not be downloaded. Check your internet connection, then retry.", CONNECTOR_INTEGRITY_FAILED: "The Connect component did not pass verification. Repair it before using remote access.", CONNECTOR_BLOCKED: "The Connect component is missing or could not run. Review your system's security notifications, then retry. Local use remains available.", CONNECTOR_REPAIR_REQUIRED: "Connect component setup did not finish. Retry to prepare it again.", CONNECTOR_COMPONENT_INVALID: "This version has an invalid Connect component requirement. Contact your installation provider.", CONNECTOR_PREPARING: "The Connect component is being prepared. Please wait.", SERVICE_NOT_CONFIGURED: "The remote service address is not configured.", BUSY: "The connection is updating. Please try again shortly.", CLOUD_UPDATE_PENDING: "The local connection is closed. Changes will sync when this computer is back online.", DEVICE_ALREADY_CONNECTED: "Another computer is using this identity. Unlink the original computer before linking this one.", BINDING_EXPIRED: "The link request has expired. Please start again.", DEVICE_STATE_INVALID: "Unable to read this computer's identity. Please contact your installation provider." }

export function RemoteAccessSettings({ onSignOut }: { onSignOut: () => Promise<void> }) {
  const [local, setLocal] = useState<ConnectLocalStatus | null>(null)
  const [remote, setRemote] = useState<ConnectRemoteStatus | null>(null)
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
  async function copyRemoteUrl() {
    if (!local?.origin) return
    try {
      await navigator.clipboard.writeText(local.origin)
      setCopied(true)
      setTimeout(() => setCopied(false), 2_000)
    } catch { setError("Unable to copy the remote URL. Select the link to copy it manually.") }
  }
  return <section aria-label="Remote access settings" className="max-w-2xl space-y-6 py-5">
    {remote ? <>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4">
        <div className="min-w-0 flex-1"><h3 className="text-sm font-medium">Email account</h3><p className="mt-1 break-all text-sm">{remote.email || "Email unavailable"}</p></div>
        <Button variant="outline" className="shrink-0" disabled={busy} onClick={() => {
          setBusy(true); setError("")
          void onSignOut().catch(() => setError("Unable to log out. Please try again.")).finally(() => setBusy(false))
        }}>{busy && <LoaderCircle className="mr-2 size-4 animate-spin" />}Logout</Button>
      </div>
    </> : local ? <>
      <div className="space-y-4 rounded-xl border p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3"><Monitor className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" /><div className="min-w-0"><h3 className="break-words font-medium">{local.name}</h3><p className="mt-1 break-all text-sm text-muted-foreground">{local.email || "No email linked"}</p></div></div>
          <span role="status" className="inline-flex items-center gap-2 rounded-full bg-muted px-2.5 py-1 text-xs font-medium"><span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${local.state === "online" ? "bg-emerald-500" : local.state === "connecting" || local.state === "pending" ? "bg-amber-500" : "bg-muted-foreground/40"}`} />{labels[local.state]}</span>
        </div>
        {local.hostId && !["revoked", "revocation-pending"].includes(local.state) && <div className="flex flex-wrap gap-2"><Button disabled={busy} variant="outline" onClick={() => void action(local.state === "paused" ? "resume" : "pause")}>{busy && <LoaderCircle className="mr-2 size-4 animate-spin" />}{local.state === "paused" ? "Resume remote access" : "Pause remote access"}</Button><Button disabled={busy} variant="outline" onClick={() => setConfirmUnbind(true)}>Unlink email</Button></div>}
      </div>
      {confirmUnbind && <div className="space-y-3 rounded-xl border p-4"><p className="text-sm leading-6">Unlink this email? All remote connections to this computer will close. Local files and tasks are preserved.</p><div className="flex gap-3"><Button disabled={busy} variant="outline" onClick={() => void action("unbind")}>Confirm unlink</Button><Button variant="ghost" onClick={() => setConfirmUnbind(false)}>Cancel</Button></div></div>}
      {!local.hostId && <p className="text-sm leading-6 text-muted-foreground">Link your email to access this computer from another device. Keep this computer on and StillOn running.</p>}
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
        {local.origin && <div className="space-y-3">
          <h3 className="text-sm font-medium">Remote login URL</h3>
          <div className="flex items-center gap-2 rounded-lg border bg-muted/30 p-2 pl-3"><a href={local.origin} target="_blank" rel="noreferrer" className="min-w-0 flex-1 break-all text-sm underline underline-offset-4">{local.origin}</a><Button size="icon" variant="ghost" aria-label={copied ? "Remote URL copied" : "Copy remote URL"} onClick={() => void copyRemoteUrl()}>{copied ? <Check className="size-4" /> : <Copy className="size-4" />}</Button></div>
        </div>}
      </>}
      {local.error && local.error !== local.transport?.error && <p className="text-sm text-muted-foreground">{errors[local.error] ?? "The connection is unavailable. StillOn will try to reconnect automatically."}</p>}
    </> : !error ? <p className="text-sm text-muted-foreground">Loading connection status…</p> : null}
    {(remote?.authenticated || (local?.hostId && !["revoked", "revocation-pending"].includes(local.state))) && <MyComputersSettings remote={Boolean(remote)} currentHostId={remote?.host?.id} />}
    {(remote?.authenticated || (local?.hostId && !["revoked", "revocation-pending"].includes(local.state))) && <SharedWorkspacesSettings remote={Boolean(remote)} />}
    {(remote?.authenticated || (local?.hostId && !["revoked", "revocation-pending"].includes(local.state))) && <BrowserSessionSettings remote={Boolean(remote)} logoutUrl={remote ? `${remote.portalUrl}/logout/complete` : undefined} />}
    {(local || remote) && <div className="space-y-2 border-t pt-4"><Button variant="ghost" onClick={() => void copyDiagnostics()}>{diagnosticsCopied ? "Diagnostics copied" : "Copy connection diagnostics"}</Button><p className="text-xs text-muted-foreground">Connection status and versions, without email addresses, keys or file contents.</p></div>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>
}
