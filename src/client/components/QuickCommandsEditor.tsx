import { useId, useState } from "react"
import { ArrowDown, ArrowUp, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react"
import { defaultQuickCommands, validateQuickCommands, type QuickCommand } from "../../shared/quick-commands"
import { generateUUID } from "../lib/utils"
import { Button } from "./ui/button"
import { Input } from "./ui/input"
import { Textarea } from "./ui/textarea"

export function QuickCommandsEditor({ commands, onSave, global = false, disabled = false }: {
  commands: QuickCommand[]
  onSave: (commands: QuickCommand[]) => Promise<unknown>
  global?: boolean
  disabled?: boolean
}) {
  const fieldId = useId()
  const [draft, setDraft] = useState<QuickCommand | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busy = saving || disabled

  async function save(next: QuickCommand[], closeEditor = false) {
    if (busy) return
    setError(null)
    try {
      validateQuickCommands(next)
      setSaving(true)
      await onSave(next)
      if (closeEditor) setDraft(null)
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to save preset prompts.")
    } finally { setSaving(false) }
  }

  function move(index: number, direction: number) {
    const next = [...commands]
    ;[next[index], next[index + direction]] = [next[index + direction]!, next[index]!]
    void save(next)
  }

  return <div className="space-y-4">
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    <div className="flex flex-wrap items-center justify-between gap-2">
      <Button variant="outline" size="sm" className="gap-1.5" disabled={busy || Boolean(draft) || commands.length >= 100} onClick={() => { setError(null); setDraft({ id: generateUUID(), name: "", prompt: "" }) }}><Plus className="size-4" />Add Preset Prompt</Button>
      {global ? <Button variant="ghost" size="sm" className="gap-1.5" disabled={busy || Boolean(draft)} onClick={() => void save(defaultQuickCommands().global)}><RotateCcw className="size-4" />Restore Defaults</Button> : null}
    </div>
    {!commands.length ? <p className="py-5 text-sm text-muted-foreground">{global ? "No global preset prompts yet." : "No workspace preset prompts yet."}</p> : <ul className="divide-y divide-border rounded-xl border border-border">
      {commands.map((command, index) => <li key={command.id} className="flex items-center gap-2 px-3 py-3">
        <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{command.name}</p><p className="line-clamp-2 text-xs text-muted-foreground">{command.description || command.prompt}</p></div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          <Button variant="ghost" size="icon" className="size-8" aria-label={`Move ${command.name} up`} disabled={busy || Boolean(draft) || index === 0} onClick={() => move(index, -1)}><ArrowUp className="size-3.5" /></Button>
          <Button variant="ghost" size="icon" className="size-8" aria-label={`Move ${command.name} down`} disabled={busy || Boolean(draft) || index === commands.length - 1} onClick={() => move(index, 1)}><ArrowDown className="size-3.5" /></Button>
          <Button variant="ghost" size="icon" className="size-8" aria-label={`Edit ${command.name}`} disabled={busy || Boolean(draft)} onClick={() => { setError(null); setDraft({ ...command }) }}><Pencil className="size-3.5" /></Button>
          <Button variant="ghost" size="icon" className="size-8 text-muted-foreground hover:text-destructive" aria-label={`Delete ${command.name}`} disabled={busy || Boolean(draft)} onClick={() => void save(commands.filter(item => item.id !== command.id))}><Trash2 className="size-3.5" /></Button>
        </div>
      </li>)}
    </ul>}
    {draft ? <form className="space-y-4 rounded-xl border border-border bg-muted/20 p-4" onSubmit={event => {
      event.preventDefault()
      const existing = commands.some(command => command.id === draft.id)
      void save(existing ? commands.map(command => command.id === draft.id ? { ...draft, name: draft.name.trim() } : command) : [...commands, { ...draft, name: draft.name.trim() }], true)
    }}>
      <div className="space-y-1.5"><label htmlFor={`${fieldId}-name`} className="text-sm font-medium">Name</label><Input id={`${fieldId}-name`} value={draft.name} maxLength={100} disabled={busy} autoFocus required onChange={event => setDraft({ ...draft, name: event.target.value })} /></div>
      <div className="space-y-1.5"><label htmlFor={`${fieldId}-prompt`} className="text-sm font-medium">Prompt</label><Textarea id={`${fieldId}-prompt`} value={draft.prompt} rows={12} maxLength={50_000} disabled={busy} required onChange={event => setDraft({ ...draft, prompt: event.target.value })} className="min-h-48 resize-y text-sm leading-relaxed" /></div>
      <p className="text-xs text-muted-foreground">Selecting a preset prompt starts a new conversation and sends it. Saving does not run it.</p>
      <div className="flex justify-end gap-2"><Button variant="ghost" type="button" disabled={busy} onClick={() => setDraft(null)}>Cancel</Button><Button type="submit" disabled={busy || !draft.name.trim() || !draft.prompt.trim()}>{saving ? "Saving…" : "Save"}</Button></div>
    </form> : null}
  </div>
}
