import { useState } from "react"
export function SessionStatisticsSetting({ checked, disabled, onSave }: { checked: boolean; disabled: boolean; onSave: (value: boolean) => Promise<unknown> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function toggle() {
    setBusy(true); setError(null)
    try { await onSave(!checked) }
    catch { setError("Unable to save. Try again.") }
    finally { setBusy(false) }
  }
  return <section className="mb-7" aria-label="Conversation statistics settings">
    <div className="flex items-center justify-between gap-5 rounded-xl border border-border px-5 py-4">
      <div><h2 id="session-statistics-label" className="text-sm font-medium">Debug session statistics</h2><p id="session-statistics-description" className="mt-1 text-xs text-muted-foreground">Collect tokens, speed and timing for new sessions only. Off stops collection.</p></div>
      <button type="button" role="switch" aria-checked={checked} aria-labelledby="session-statistics-label" aria-describedby="session-statistics-description" disabled={disabled || busy} onClick={() => void toggle()} className="relative flex size-11 shrink-0 items-center justify-center rounded-md disabled:cursor-not-allowed disabled:opacity-50">
        <span className={`relative block h-[22px] w-[38px] rounded-full transition-colors ${checked ? "bg-primary" : "bg-slate-300 dark:bg-zinc-600"}`}><span className={`absolute left-[3px] top-[3px] size-4 rounded-full shadow-sm transition-transform ${checked ? "translate-x-4 bg-primary-foreground" : "bg-white"}`} /></span>
      </button>
    </div>{error ? <p role="alert" className="mt-2 text-xs text-destructive">{error}</p> : null}
  </section>
}
