import { useEffect, useState } from "react"
import { workspaceAvatarChoice, type WorkspaceAvatarChoice } from "../../shared/workspace-avatars"
import { useWorkspaceAvatarsStore } from "../stores/workspaceAvatarsStore"
import { AvatarArtwork } from "./WorkspaceAvatar"
import { Button } from "./ui/button"
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog"
import { cn } from "../lib/utils"

export function WorkspaceAvatarPicker({ workspaceId, title, open, onOpenChange }: {
  workspaceId: string; title: string; open: boolean; onOpenChange: (open: boolean) => void
}) {
  const { config, warning, error: loadError, reload, save } = useWorkspaceAvatarsStore()
  const [choice, setChoice] = useState<WorkspaceAvatarChoice>(() => workspaceAvatarChoice(config, workspaceId))
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  useEffect(() => { if (open) { setChoice(workspaceAvatarChoice(config, workspaceId)); setError(null) } }, [open, workspaceId, config])

  async function apply() {
    setBusy(true); setError(null)
    try { await save(workspaceId, choice); onOpenChange(false) }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to save avatar.") }
    finally { setBusy(false) }
  }

  return <Dialog open={open} onOpenChange={value => { if (!busy) onOpenChange(value) }}>
    <DialogContent className="max-w-md">
      <DialogHeader><DialogTitle>Workspace avatar</DialogTitle><DialogDescription>Choose a little face for {title}.</DialogDescription></DialogHeader>
      <DialogBody className="space-y-5">
        <div className="flex items-center gap-4 rounded-2xl bg-muted/40 p-4"><AvatarArtwork config={config} choice={choice} className="size-20 shrink-0" label={`${title} avatar preview`} /><div className="min-w-0"><p className="truncate font-semibold">{title}</p><p className="mt-1 text-xs text-muted-foreground">One shape. Your color.</p></div></div>
        <fieldset disabled={busy}><legend className="mb-2 text-sm font-medium">Shape</legend><div className="flex flex-wrap gap-2">{config.shapes.map(shape => <button key={shape.id} type="button" aria-label={shape.label} aria-pressed={choice.shape === shape.id} onClick={() => setChoice({ ...choice, shape: shape.id })} className={cn("flex min-w-16 flex-col items-center gap-1 rounded-xl border p-2 text-xs", choice.shape === shape.id ? "border-primary bg-primary/10" : "border-border hover:bg-muted/50")}><AvatarArtwork config={config} choice={{ ...choice, shape: shape.id }} className="size-10" />{shape.label}</button>)}</div></fieldset>
        <fieldset disabled={busy}><legend className="mb-2 text-sm font-medium">Color</legend><div className="flex flex-wrap gap-2">{config.palette.map((color, index) => <button key={`${color}-${index}`} type="button" aria-label={`Color ${color}`} aria-pressed={choice.color.toLowerCase() === color.toLowerCase()} onClick={() => setChoice({ ...choice, color })} className={cn("size-9 rounded-full border-4 transition-shadow", choice.color.toLowerCase() === color.toLowerCase() ? "border-background ring-2 ring-primary" : "border-transparent hover:ring-2 hover:ring-border")} style={{ backgroundColor: color }} />)}</div><label className="mt-4 flex items-center gap-3 text-sm"><input type="color" aria-label="Custom avatar color" value={choice.color} onChange={event => setChoice({ ...choice, color: event.target.value })} className="h-9 w-10 cursor-pointer rounded border border-border bg-background p-1" /><span>Custom color</span><code className="ml-auto text-xs uppercase text-muted-foreground">{choice.color}</code></label></fieldset>
        <details className="text-xs text-muted-foreground"><summary className="cursor-pointer py-1">Customize the avatar file</summary><p className="mt-2 break-words leading-relaxed">Shapes, colors and choices live in <code>.stillon/data/customizations/appearance/avatars.json</code> on this computer. Edit that file to add your own shapes or palette.</p><Button type="button" variant="outline" size="sm" disabled={busy} className="mt-3" onClick={() => void reload()}>Reload from file</Button></details>
        {error || warning || loadError ? <p role="alert" className="text-sm text-destructive">{error || warning || loadError}</p> : null}
        <div className="flex justify-end gap-2"><Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button><Button disabled={busy || Boolean(warning)} onClick={() => void apply()}>{busy ? "Saving…" : "Save avatar"}</Button></div>
      </DialogBody>
    </DialogContent>
  </Dialog>
}
