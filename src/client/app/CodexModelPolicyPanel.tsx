import { useState } from "react"
import { useCodexModelPolicyStore } from "../stores/codexModelPolicyStore"
import type { CodexModelPolicySnapshot, CodexModelSelectionDraft } from "../../shared/codex-model-policy"
import type { StillOnSocket } from "./socket"
import { Button } from "../components/ui/button"

export function CodexModelPolicyPanel({ socket, connected }: { socket: StillOnSocket; connected: boolean }) {
  const snapshot = useCodexModelPolicyStore((store) => store.snapshot)
  const [pending, setPending] = useState<"fetch" | "apply" | "restore" | null>(null)
  const [draft, setDraft] = useState<CodexModelSelectionDraft | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [roles, setRoles] = useState({ conversation: "", background: "" })
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const stale = !!draft && draft.baseRevision !== snapshot?.revision
  const valid = selected.length > 0 && selected.includes(roles.conversation) && selected.includes(roles.background)

  async function run(action: "fetch" | "apply" | "restore", operation: () => Promise<void>) {
    setPending(action)
    setError(null)
    setMessage(null)
    try { await operation() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setPending(null) }
  }

  function fetchModels() {
    return run("fetch", async () => {
      const fetched = await socket.command<CodexModelSelectionDraft>({ type: "settings.discoverCodexModels" })
      setDraft(fetched)
      setSelected(fetched.selectedModelIds)
      setRoles(fetched.roles)
      setMessage("Choose the models you want, then confirm. Your current configuration is still active.")
    })
  }

  function apply() {
    if (!draft) return
    return run("apply", async () => {
      await socket.command<CodexModelPolicySnapshot>({ type: "settings.applyCodexModelSelection",
        selection: { draftId: draft.id, modelIds: selected, roles } })
      setDraft(null)
      setMessage("Selected models applied across connected devices. Active turns keep their current model.")
    })
  }

  function restore(target?: "previous" | "builtin") {
    return run("restore", async () => {
      await socket.command<CodexModelPolicySnapshot>(target
        ? { type: "settings.restoreCodexModelPolicy", target }
        : { type: "settings.refreshCodexModelPolicy" })
      setDraft(null)
      setMessage(target ? "Model configuration restored." : "Local model configuration applied.")
    })
  }

  return (
    <div className="flex w-full max-w-[420px] flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        After updating Codex CLI, fetch its available models here. Choose which models to enable, then confirm to apply.
      </p>
      {snapshot ? <p className="text-xs text-muted-foreground">
        {snapshot.policy.models.length} enabled models · Saved on this server · Active turns keep their current model
      </p> : <p className="text-sm text-muted-foreground">Loading model configuration…</p>}
      <Button className="self-start" size="sm" variant="outline" disabled={!connected || !!pending || !snapshot} onClick={() => void fetchModels()}>
        {pending === "fetch" ? "Fetching models…" : "Fetch models from Codex"}
      </Button>
      {draft ? <div className="flex flex-col gap-3 rounded-md border p-3">
        <p className="text-xs text-muted-foreground">Codex CLI {draft.cliVersion} · Fetched {new Date(draft.fetchedAt).toLocaleString()}</p>
        <fieldset disabled={!!pending || !connected} className="flex max-h-72 flex-col gap-2 overflow-y-auto">
          <legend className="mb-2 text-sm font-medium">Models to enable</legend>
          {draft.candidates.map((candidate) => <label key={candidate.model.id} className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={selected.includes(candidate.model.id)} disabled={!!candidate.disabledReason}
              onChange={(event) => setSelected((ids) => event.target.checked ? [...ids, candidate.model.id] : ids.filter((id) => id !== candidate.model.id))} />
            <span className="min-w-0 break-words">
              <span className="font-medium">{candidate.model.label}</span>
              {candidate.available && !draft.selectedModelIds.includes(candidate.model.id) ? <span className="ml-2 text-xs text-muted-foreground">New</span> : null}
              <span className="block text-xs text-muted-foreground">{candidate.model.id}</span>
              {!candidate.available ? <span className="block text-xs text-amber-600 dark:text-amber-400">Not returned by Codex; kept until you deselect it. Availability is unverified.</span> : null}
              {candidate.disabledReason ? <span className="block text-xs text-destructive">{candidate.disabledReason}</span> : null}
              {candidate.model.supportsEffort ? <span className="block text-xs text-muted-foreground">Reasoning: {candidate.model.supportedReasoningEfforts.join(", ")}</span> : null}
            </span>
          </label>)}
        </fieldset>
        {(["conversation", "background"] as const).map((role) => <label key={role} className="flex flex-col gap-1 text-sm">
          {role === "conversation" ? "Default chat model" : "Background task model"}
          <select aria-label={role === "conversation" ? "Default chat model" : "Background task model"}
            className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
            disabled={!!pending || !connected} value={selected.includes(roles[role]) ? roles[role] : ""}
            onChange={(event) => setRoles((current) => ({ ...current, [role]: event.target.value }))}>
            <option value="" disabled>Choose an enabled model</option>
            {draft.candidates.filter((candidate) => selected.includes(candidate.model.id)).map((candidate) =>
              <option key={candidate.model.id} value={candidate.model.id}>{candidate.model.label}</option>)}
          </select>
        </label>)}
        <p className="text-xs text-muted-foreground">Valid saved model preferences take priority over these defaults. New models start in Standard mode; existing Fast preferences are preserved.</p>
        {draft.warnings.map((warning) => <p key={warning} className="text-xs text-amber-600 dark:text-amber-400">{warning}</p>)}
        {stale ? <p role="alert" className="text-sm text-destructive">Configuration changed on another device. Fetch models again before confirming.</p> : null}
        {!valid ? <p className="text-xs text-muted-foreground">Select at least one model and choose both defaults from your selection.</p> : null}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={!connected || !!pending || !valid || stale} onClick={() => void apply()}>
            {pending === "apply" ? "Applying…" : "Confirm and apply"}
          </Button>
          <Button size="sm" variant="ghost" disabled={!!pending} onClick={() => { setDraft(null); setError(null); setMessage("Selection cancelled. Your current configuration is unchanged.") }}>
            Cancel
          </Button>
        </div>
      </div> : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={!connected || !!pending || !snapshot?.canRestore} onClick={() => void restore("previous")}>Restore previous</Button>
        <Button size="sm" variant="ghost" disabled={!connected || !!pending || !snapshot} onClick={() => void restore("builtin")}>Use bundled defaults</Button>
      </div>
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">Advanced: local configuration</summary>
        <code className="my-2 block break-all">{snapshot?.filePath}</code>
        <Button size="sm" variant="outline" disabled={!connected || !!pending || !snapshot} onClick={() => void restore()}>Reload local file</Button>
      </details>
      {error || snapshot?.warning ? <p role="alert" className="break-words text-sm text-destructive">{error || snapshot?.warning}</p> : null}
      {message ? <p role="status" className="text-sm text-muted-foreground">{message}</p> : null}
    </div>
  )
}
