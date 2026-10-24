import { useState } from "react"
import { claudeModelIdSchema, type ClaudeModelDraft, type ClaudeModelPolicy, type ClaudeModelPolicySnapshot } from "../../shared/claude-model-policy"
import { useClaudeModelPolicyStore } from "../stores/claudeModelPolicyStore"
import type { StillOnSocket } from "./socket"
import { Button } from "../components/ui/button"
import { Input } from "../components/ui/input"

export function ClaudeModelPolicyPanel({ socket, connected }: { socket: StillOnSocket; connected: boolean }) {
  const snapshot = useClaudeModelPolicyStore((store) => store.snapshot)
  const [draft, setDraft] = useState<ClaudeModelDraft | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [defaultModel, setDefaultModel] = useState("")
  const [modelId, setModelId] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const stale = !!draft && draft.baseRevision !== snapshot?.revision
  const valid = selected.length > 0 && selected.includes(defaultModel)

  function begin(next: ClaudeModelDraft) {
    if (!snapshot) return
    setDraft(next)
    setSelected(snapshot.policy.models.map((model) => model.id))
    setDefaultModel(snapshot.policy.defaultModel)
    setMessage(null)
  }
  async function run(operation: () => Promise<void>) {
    setPending(true); setError(null); setMessage(null)
    try { await operation() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setPending(false) }
  }
  function addModel() {
    if (!snapshot) return
    const result = claudeModelIdSchema.safeParse(modelId)
    if (!result.success) { setError("Enter a model ID without spaces or shell characters."); return }
    const next = draft ?? { models: snapshot.policy.models, baseRevision: snapshot.revision }
    const existing = next.models.find((model) => model.id === result.data || model.aliases?.includes(result.data))
    if (!draft) begin(next)
    if (!existing) {
      setDraft({ ...next, models: [...next.models, { id: result.data, label: result.data, supportsEffort: false }] })
    }
    const id = existing?.id ?? result.data
    setSelected((current) => [...new Set([...(draft ? current : snapshot.policy.models.map((model) => model.id)), id])])
    setModelId(""); setError(null)
  }
  return <div className="flex w-full min-w-0 flex-col gap-3">
    <p className="text-sm text-muted-foreground">Fetch models from your installed Claude Code CLI after updating it, or add a supported model ID manually. Changes take effect after confirmation.</p>
    <p className="text-xs text-muted-foreground">{snapshot ? `${snapshot.policy.models.length} enabled models · Saved on this server` : "Loading model configuration…"}</p>
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" disabled={!connected || pending || !snapshot} onClick={() => void run(async () => begin(await socket.command<ClaudeModelDraft>({ type: "settings.discoverClaudeModels" })))}>{pending ? "Working…" : "Fetch models from Claude Code"}</Button>
      {!draft ? <Button size="sm" variant="ghost" disabled={!connected || pending || !snapshot} onClick={() => snapshot && begin({ models: snapshot.policy.models, baseRevision: snapshot.revision })}>Configure models</Button> : null}
    </div>
    <div className="flex min-w-0 flex-wrap items-end gap-2">
      <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">Model ID
        <Input value={modelId} placeholder="Model ID supported by your CLI and account" disabled={!connected || pending || !snapshot || stale} onChange={(event) => setModelId(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addModel() } }} />
      </label>
      <Button size="sm" variant="outline" disabled={!connected || pending || !snapshot || !modelId.trim() || stale} onClick={addModel}>Add model</Button>
    </div>
    {draft ? <div className="flex min-w-0 flex-col gap-3 rounded-md border p-3">
      <p className="text-xs text-muted-foreground">Fetched models are candidates. Previously enabled models remain selected even if the CLI did not return them. Manual IDs are unverified; availability depends on your CLI and account.</p>
      <fieldset disabled={!connected || pending || stale} className="flex max-h-72 min-w-0 flex-col gap-2 overflow-y-auto">
        <legend className="mb-2 text-sm font-medium">Claude models to enable</legend>
        {draft.models.map((model) => <label key={model.id} className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={selected.includes(model.id)} onChange={(event) => setSelected((ids) => event.target.checked ? [...ids, model.id] : ids.filter((id) => id !== model.id))} />
          <span className="min-w-0 break-all"><span className="font-medium">{model.label}</span><span className="block text-xs text-muted-foreground">{model.id}</span></span>
        </label>)}
      </fieldset>
      <label className="flex min-w-0 flex-col gap-1 text-sm">Fallback chat model
        <select aria-label="Claude fallback chat model" className="w-full min-w-0 rounded-md border bg-background px-2 py-1.5 text-sm" value={selected.includes(defaultModel) ? defaultModel : ""} disabled={!connected || pending || stale} onChange={(event) => setDefaultModel(event.target.value)}>
          <option value="" disabled>Choose an enabled model</option>
          {draft.models.filter((model) => selected.includes(model.id)).map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
        </select>
      </label>
      <p className="text-xs text-muted-foreground">Valid saved preferences take priority over this fallback. Set your preferred model in Claude Code Defaults. Active turns keep their current model.</p>
      {stale ? <p role="alert" className="text-sm text-destructive">Configuration changed on another device. Cancel and reload before saving.</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={!connected || pending || stale || !valid} onClick={() => void run(async () => {
          const policy: ClaudeModelPolicy = { models: draft.models.filter((model) => selected.includes(model.id)), defaultModel }
          await socket.command<ClaudeModelPolicySnapshot>({ type: "settings.applyClaudeModelSelection", selection: { baseRevision: draft.baseRevision, policy } })
          setDraft(null); setMessage("Claude model configuration saved across connected devices.")
        })}>Confirm and apply</Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => { setDraft(null); setError(null); setMessage(null) }}>Cancel</Button>
      </div>
    </div> : null}
    {error || snapshot?.warning ? <p role="alert" className="break-words text-sm text-destructive">{error || snapshot?.warning}</p> : null}
    {message ? <p role="status" className="text-sm text-muted-foreground">{message}</p> : null}
  </div>
}
