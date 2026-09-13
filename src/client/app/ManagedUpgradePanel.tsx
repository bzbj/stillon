import { useEffect, useRef, useState } from "react"
import type { ManagedUpdateStatus } from "../../shared/protocol"
import { APP_VERSION } from "../../shared/branding"
import { Button } from "../components/ui/button"

export const UPDATE_PHASE_LABELS: Record<string, string> = {
  queued: "Upgrade queued", preparing: "Downloading, preserving customizations, and checking the new build…",
  prepared: "Preparation passed. The running version has not changed.", pausing: "Waiting for the application to stop…",
  "backing-up": "Backing up your StillOn data…", starting: "Starting the new version…", verifying: "Checking the new version…",
  "rolling-back": "Restoring the previous version…", "recovery-required": "Recovery needs attention. Backups have been retained.",
  succeeded: "Upgrade complete", "rolled-back": "Previous version restored", failed: "Upgrade stopped before switching versions",
}

export function ManagedUpgradePanel({ targetTag, onRead, onRequest, initialStatus }: {
  targetTag?: string
  onRead: () => Promise<ManagedUpdateStatus>
  onRequest: (targetTag: string, prepareOnly: boolean) => Promise<ManagedUpdateStatus>
  initialStatus?: ManagedUpdateStatus
}) {
  const [status, setStatus] = useState<ManagedUpdateStatus | null>(initialStatus ?? null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const callbacks = useRef({ onRead, onRequest })
  callbacks.current = { onRead, onRequest }
  useEffect(() => {
    if (status?.phase === "succeeded" && status.targetTag && status.targetTag.replace(/^v/, "") !== APP_VERSION) {
      window.location.reload()
    }
  }, [status?.phase, status?.targetTag])
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    async function poll() {
      try {
        const value = await callbacks.current.onRead()
        if (!cancelled) { setStatus(value); setError(null) }
      } catch {
        if (!cancelled) setError("Reconnecting to StillOn. The independent updater continues working.")
      } finally {
        if (!cancelled) timer = setTimeout(() => { void poll() }, 3_000)
      }
    }
    void poll()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [])

  async function request(prepareOnly: boolean) {
    if (!targetTag || submitting) return
    setSubmitting(true)
    setError(null)
    try { setStatus(await callbacks.current.onRequest(targetTag, prepareOnly)) }
    catch (failure) { setError(failure instanceof Error ? failure.message : "The update request failed.") }
    finally { setSubmitting(false) }
  }

  return (
    <section className="rounded-xl border border-border bg-card px-5 py-4" aria-label="Managed updates">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-foreground">Managed updates</h3>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            {status?.enabled
              ? "Prepare the new version while StillOn stays available. An independent updater preserves supported customizations and restores the previous version if the switch fails."
              : status?.message ?? "Checking this installation…"}
          </p>
          {status?.enabled && status.platform ? <p className="mt-1 text-xs text-muted-foreground">{status.platform === "darwin" ? "macOS" : "Windows"} · {status.architecture === "arm64" ? "ARM64" : "x64"}</p> : null}
          {status && !status.enabled ? <p className="mt-2 text-xs text-muted-foreground">On a recorded native service installation, run <code>stillon update setup</code> once. Installation analysis remains available below.</p> : null}
        </div>
        {status?.enabled && targetTag ? (
          <div className="flex shrink-0 gap-2">
            <Button size="sm" variant="secondary" disabled={submitting || status.busy} onClick={() => { void request(true) }}>Prepare only</Button>
            <Button size="sm" disabled={submitting || status.busy} onClick={() => { void request(false) }}>Upgrade to {targetTag}</Button>
          </div>
        ) : null}
      </div>
      {status?.phase ? <p role="status" className="mt-3 text-sm text-foreground">{UPDATE_PHASE_LABELS[status.phase] ?? status.phase}</p> : null}
      {status?.message && status.enabled ? <p role="alert" className="mt-2 text-sm text-destructive">{status.message}</p> : null}
      {error ? <p role="status" className="mt-2 text-sm text-muted-foreground">{error}</p> : null}
    </section>
  )
}
