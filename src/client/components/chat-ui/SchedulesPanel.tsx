import { useEffect, useRef, useState } from "react"
import { Clock3, MoreHorizontal, Pencil, Plus, Trash2, X } from "lucide-react"
import { useNavigate } from "react-router-dom"
import type { StillOnSocket, SocketStatus } from "../../app/socket"
import { scheduleTriggerLabel, type ProjectSchedulesSnapshot, type Schedule } from "../../../shared/schedules"
import { useAppDialog } from "../ui/app-dialog"
import { Button } from "../ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover"

interface Props {
  projectId: string; projectTitle: string; socket: StillOnSocket; status: SocketStatus
  onClose: () => void; onPrefill?: (text: string) => void
  currentChatTitle?: string; onEditConversation?: (chatId: string, text: string) => void; onNewConversation: (text: string) => Promise<void>
}
const outcomes = { claimed: "Starting", running: "Running", waiting_for_user: "Needs input", succeeded: "Completed", failed: "Failed", cancelled: "Stopped", skipped: "Skipped", blocked: "Blocked", interrupted_unknown: "Interrupted · review conversation" }
export function SchedulesPanel({ projectId, projectTitle, socket, status, onClose, onPrefill, currentChatTitle, onEditConversation, onNewConversation }: Props) {
  const [snapshot, setSnapshot] = useState<ProjectSchedulesSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const navigate = useNavigate()
  const dialog = useAppDialog()
  const [actionsOpen, setActionsOpen] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const deletingRef = useRef(false)
  const deleteOperations = useRef(new Map<string, string>())
  const actionFocusRef = useRef(false)
  const creatingRef = useRef(false)
  const focusComposerRef = useRef(false)
  const [creating, setCreating] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const draft = "Schedule a task in this workspace and keep its progress and results in this conversation: "
  const createNew = async () => {
    if (creatingRef.current) return
    creatingRef.current = true
    focusComposerRef.current = true
    setCreateOpen(false)
    setCreating(true); setError(null)
    try { await onNewConversation(draft) }
    catch { setError("Could not create a conversation. Try again.") }
    finally { creatingRef.current = false; setCreating(false) }
  }
  useEffect(() => {
    setSnapshot(null); setError(null); setSelected(null)
    let active = true
    let receivedLive = false
    const abort = new AbortController()
    const receive = (value: ProjectSchedulesSnapshot) => { if (active && value.projectId === projectId) { setSnapshot(value); setError(null) } }
    // HTTP supplies actionable auth errors; the subscription keeps the same view fresh.
    void fetch(`/api/projects/${encodeURIComponent(projectId)}/schedules`, { cache: "no-store", signal: abort.signal }).then(async response => {
      if (!response.ok) throw new Error(response.status === 403 ? "Only the computer owner can manage schedules." : "Schedules are unavailable. Reconnect and try again.")
      return response.json() as Promise<ProjectSchedulesSnapshot>
    }).then(value => { if (!receivedLive) receive(value) }).catch(e => { if (active && !receivedLive && e.name !== "AbortError") setError(e.message) })
    const unsubscribe = socket.subscribe<ProjectSchedulesSnapshot>({ type: "project-schedules", projectId }, value => { receivedLive = true; receive(value) })
    return () => { active = false; abort.abort(); unsubscribe() }
  }, [projectId, socket])
  const disabled = status !== "connected" || !snapshot || snapshot.available === false || creating || deletingId !== null
  const remove = async (schedule: Schedule) => {
    if (deletingRef.current) return
    deletingRef.current = true
    actionFocusRef.current = true
    setActionsOpen(null)
    try {
      const confirmed = await dialog.confirm({ title: `Delete “${schedule.name}”?`, description: "Future runs will stop. Conversation and run history will be kept. Any run already in progress will continue.", confirmLabel: "Delete", cancelLabel: "Cancel", confirmVariant: "destructive" })
      if (!confirmed) return
      setDeletingId(schedule.id); setError(null)
      const key = `${schedule.id}:${schedule.revision}`
      let operationId = deleteOperations.current.get(key)
      if (!operationId) { operationId = crypto.randomUUID(); deleteOperations.current.set(key, operationId) }
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/schedules/${encodeURIComponent(schedule.id)}`, {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operationId, expectedRevision: schedule.revision }), signal: AbortSignal.timeout(15000),
      })
      if (!response.ok) {
        const result = await response.json().catch(() => null)
        throw new Error(result?.error ?? "Could not delete the schedule. Try again.")
      }
      deleteOperations.current.delete(key)
      // Only remove after an acknowledged commit; the subscription also
      // updates other open local and Connect views.
      setSnapshot(current => current ? { ...current, schedules: current.schedules.filter(item => item.id !== schedule.id) } : current)
      setSelected(current => current === schedule.id ? null : current)
    } catch (error) { setError(error instanceof Error ? error.message : "Could not delete the schedule. Try again.") }
    finally { deletingRef.current = false; setDeletingId(null) }
  }
  const edit = (schedule: Schedule & { chatTitle: string }) => {
    actionFocusRef.current = true
    setActionsOpen(null)
    const text = `Update the schedule “${schedule.name}” in this workspace, keeping “${schedule.chatTitle}” as its result conversation. Change it to: `
    if (onEditConversation) onEditConversation(schedule.chatId, text)
    else onPrefill?.(text)
  }

  return <div className="flex h-full min-h-0 flex-col border-l border-border bg-background md:min-w-[370px]">
    <div className="flex h-[49px] shrink-0 items-center gap-2 border-b border-border px-3">
      <Clock3 className="size-4" /><span className="text-sm font-medium">Schedules</span>
      {snapshot && <span className="ml-auto text-xs text-muted-foreground">{snapshot.schedules.filter(s => s.enabled).length} active</span>}
      <Popover open={createOpen} onOpenChange={setCreateOpen}><PopoverTrigger asChild><Button variant="ghost" size="icon" className="size-8" aria-label="New schedule" disabled={disabled}><Plus className="size-4" /></Button></PopoverTrigger><PopoverContent align="end" className="w-64 p-1" onCloseAutoFocus={event => { if (focusComposerRef.current) { event.preventDefault(); focusComposerRef.current = false } }}>
        {currentChatTitle && onPrefill && <button className="w-full rounded px-3 py-2 text-left text-sm hover:bg-muted" disabled={disabled} onClick={() => { focusComposerRef.current = true; setCreateOpen(false); onPrefill(draft) }}>Use current conversation<span className="block truncate text-xs text-muted-foreground">{currentChatTitle}</span></button>}
        <button className="w-full rounded px-3 py-2 text-left text-sm hover:bg-muted" disabled={disabled} onClick={() => void createNew()}>{creating ? "Creating…" : "Start a new conversation"}</button>
      </PopoverContent></Popover>
      <Button variant="ghost" size="icon" className="size-8" aria-label="Close schedules" onClick={onClose}><X className="size-4" /></Button>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="mb-5 space-y-1"><div className="break-words text-sm font-medium">{projectTitle}</div><div className="text-xs text-muted-foreground">Schedules in this workspace</div></div>
      {status !== "connected" && <p role="status" className="mb-3 text-xs leading-5 text-muted-foreground">Disconnected · showing last synced schedules</p>}
      {(error || snapshot?.error) && <p role="alert" className="mb-3 text-sm text-destructive">{error ?? snapshot?.error}</p>}
      {!snapshot && !error && <p role="status" className="text-sm text-muted-foreground">Loading schedules…</p>}
      {snapshot?.schedules.length === 0 && <p className="text-sm text-muted-foreground">No schedules yet. Use + to choose a conversation and describe what to run and when.</p>}
      {snapshot?.schedules.map(schedule => <div key={schedule.id} className="mb-3 rounded-xl border border-border/70 bg-card p-2">
        <div className="flex items-center gap-1">
          <button type="button" className="flex min-w-0 flex-1 items-start gap-2 rounded-lg px-2 py-2 text-left hover:bg-muted/40" aria-expanded={selected === schedule.id} onClick={() => setSelected(selected === schedule.id ? null : schedule.id)}>
            <span className={`mt-1.5 size-1.5 shrink-0 rounded-full ${schedule.enabled ? "bg-emerald-400" : "bg-muted-foreground/50"}`} />
            <span className="min-w-0"><span className="block break-words text-sm font-medium leading-5">{schedule.name}</span><span className="mt-1 block text-[13px] leading-5 text-foreground/80">{scheduleTriggerLabel(schedule.trigger)}</span><span className="mt-2 block truncate text-xs leading-5 text-muted-foreground">Conversation: {schedule.chatTitle}</span><span className="block text-xs leading-5 text-muted-foreground">{schedule.enabled && schedule.nextRunAt !== null ? `Next ${new Date(schedule.nextRunAt).toLocaleString("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : schedule.issue ? "Needs attention" : schedule.nextRunAt === null ? "Finished" : "Paused"}</span></span>
          </button>
          <Popover open={actionsOpen === schedule.id} onOpenChange={open => setActionsOpen(open ? schedule.id : null)}><PopoverTrigger asChild><Button variant="ghost" size="icon" className="size-8 shrink-0" aria-label={`Actions for ${schedule.name}`} disabled={deletingId === schedule.id}><MoreHorizontal className="size-4" /></Button></PopoverTrigger><PopoverContent align="end" className="w-48 p-1" onCloseAutoFocus={event => { if (actionFocusRef.current) { event.preventDefault(); actionFocusRef.current = false } }}>
            <button className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm hover:bg-muted disabled:opacity-50" disabled={disabled} onClick={() => edit(schedule)}><Pencil className="size-3.5" />Edit schedule…</button>
            <button className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-destructive hover:bg-muted disabled:opacity-50" disabled={disabled} onClick={() => void remove(schedule)}><Trash2 className="size-3.5" />Delete…</button>
          </PopoverContent></Popover>
        </div>
        {selected === schedule.id && <div className="mx-2 mt-2 border-t border-border/70 pt-3">
          <p className="mb-2 text-xs font-medium text-muted-foreground">Prompt</p>
          <p className="whitespace-pre-wrap break-words text-sm leading-6">{schedule.prompt}</p>
          <p className="mt-3 break-words text-xs leading-5 text-muted-foreground">{schedule.execution.provider} · {schedule.execution.model}</p>
          {schedule.issue && <p className="mt-2 text-xs text-destructive">{schedule.issue}</p>}
          <button className="mt-3 text-[13px] font-medium underline-offset-4 hover:underline" onClick={() => { navigate(`/chat/${schedule.chatId}`); if (window.innerWidth < 768) onClose() }}>Open conversation ↗</button>
          <div className="my-3 border-t border-border/70" />
          <p className="mb-3 text-xs font-medium text-muted-foreground">Recent runs</p>
          {snapshot.runs.filter(run => run.scheduleId === schedule.id).slice(0, 5).map(run => <div key={run.id} className="mb-3 text-xs leading-5 text-muted-foreground"><div className="flex justify-between gap-2"><span>{outcomes[run.state]}</span><span>{new Date(run.scheduledFor).toLocaleString("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span></div>{run.reason && <div className="mt-1 break-words">{run.reason}</div>}</div>)}
          {!snapshot.runs.some(run => run.scheduleId === schedule.id) && <p className="text-xs text-muted-foreground">No runs yet</p>}
        </div>}
      </div>)}
    </div>
  </div>
}
