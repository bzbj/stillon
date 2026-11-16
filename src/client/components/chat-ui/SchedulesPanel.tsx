import { useEffect, useRef, useState } from "react"
import { Clock3, MoreHorizontal, Pencil, Plus, X } from "lucide-react"
import { useNavigate } from "react-router-dom"
import type { StillOnSocket, SocketStatus } from "../../app/socket"
import { scheduleTriggerLabel, type ProjectSchedulesSnapshot, type Schedule } from "../../../shared/schedules"
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
  const creatingRef = useRef(false)
  const focusComposerRef = useRef(false)
  const [creating, setCreating] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const draft = "请帮我在当前 Workspace 安排一个定时任务，执行过程和结果留在本对话："
  const createNew = async () => {
    if (creatingRef.current) return
    creatingRef.current = true
    focusComposerRef.current = true
    setCreateOpen(false)
    setCreating(true); setError(null)
    try { await onNewConversation(draft) }
    catch { setError("新建对话失败，请重试。") }
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
  const disabled = status !== "connected" || !snapshot || snapshot.available === false || creating
  const edit = (schedule: Schedule & { chatTitle: string }) => {
    const text = `请修改当前 Workspace 的定时任务「${schedule.name}」，保持结果对话「${schedule.chatTitle}」不变。修改为：`
    if (onEditConversation) onEditConversation(schedule.chatId, text)
    else onPrefill?.(text)
  }

  return <div className="flex h-full min-h-0 flex-col border-l border-border bg-background md:min-w-[370px]">
    <div className="flex h-[49px] shrink-0 items-center gap-2 border-b border-border px-3">
      <Clock3 className="size-4" /><span className="text-sm font-medium">定时任务</span>
      {snapshot && <span className="ml-auto text-xs text-muted-foreground">{snapshot.schedules.filter(s => s.enabled).length} on</span>}
      <Popover open={createOpen} onOpenChange={setCreateOpen}><PopoverTrigger asChild><Button variant="ghost" size="icon" className="size-8" aria-label="新建定时任务" disabled={disabled}><Plus className="size-4" /></Button></PopoverTrigger><PopoverContent align="end" className="w-64 p-1" onCloseAutoFocus={event => { if (focusComposerRef.current) { event.preventDefault(); focusComposerRef.current = false } }}>
        {currentChatTitle && onPrefill && <button className="w-full rounded px-3 py-2 text-left text-sm hover:bg-muted" disabled={disabled} onClick={() => { focusComposerRef.current = true; setCreateOpen(false); onPrefill(draft) }}>在当前对话中安排<span className="block truncate text-xs text-muted-foreground">{currentChatTitle}</span></button>}
        <button className="w-full rounded px-3 py-2 text-left text-sm hover:bg-muted" disabled={disabled} onClick={() => void createNew()}>{creating ? "正在新建…" : "新建对话来安排"}</button>
      </PopoverContent></Popover>
      <Button variant="ghost" size="icon" className="size-8" aria-label="Close schedules" onClick={onClose}><X className="size-4" /></Button>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="mb-4 space-y-1"><div className="text-sm font-medium">{projectTitle}</div><div className="text-xs text-muted-foreground">当前 Workspace 下的定时任务</div></div>
      {status !== "connected" && <p role="status" className="mb-3 text-xs text-muted-foreground">主机未连接 · 显示最后同步记录</p>}
      {(error || snapshot?.error) && <p role="alert" className="mb-3 text-sm text-destructive">{error ?? snapshot?.error}</p>}
      {!snapshot && !error && <p role="status" className="text-sm text-muted-foreground">Loading schedules…</p>}
      {snapshot?.schedules.length === 0 && <p className="text-sm text-muted-foreground">暂无定时任务。在对话中说明要做什么、何时执行即可。</p>}
      {snapshot?.schedules.map(schedule => <div key={schedule.id} className="mb-2 rounded-xl border border-border/70 p-2">
        <div className="flex items-center gap-1">
          <button type="button" className="flex min-w-0 flex-1 items-start gap-2 rounded-lg px-2 py-2 text-left hover:bg-muted/40" aria-expanded={selected === schedule.id} onClick={() => setSelected(selected === schedule.id ? null : schedule.id)}>
            <span className={`mt-1.5 size-1.5 shrink-0 rounded-full ${schedule.enabled ? "bg-emerald-400" : "bg-muted-foreground/50"}`} />
            <span className="min-w-0"><span className="block truncate text-sm font-medium">{schedule.name}</span><span className="mt-1 block text-xs text-muted-foreground">{scheduleTriggerLabel(schedule.trigger)}</span><span className="mt-1 block truncate text-xs text-muted-foreground">结果对话：{schedule.chatTitle}</span><span className="mt-1 block text-xs text-muted-foreground">{schedule.enabled && schedule.nextRunAt !== null ? `下次 ${new Date(schedule.nextRunAt).toLocaleString()}` : schedule.issue ? "需要处理" : schedule.nextRunAt === null ? "已结束" : "已暂停"}</span></span>
          </button>
          <Popover><PopoverTrigger asChild><Button variant="ghost" size="icon" className="size-8 shrink-0" aria-label={`Actions for ${schedule.name}`}><MoreHorizontal className="size-4" /></Button></PopoverTrigger><PopoverContent><button disabled={disabled} onClick={() => edit(schedule)}><Pencil className="size-3.5" />Edit Schedule…</button></PopoverContent></Popover>
        </div>
        {selected === schedule.id && <div className="mx-2 mt-2 border-t border-border pt-3">
          <p className="whitespace-pre-wrap break-words text-sm leading-6">{schedule.prompt}</p>
          <p className="mt-3 text-xs text-muted-foreground">来源：StillOn · {schedule.execution.provider} · {schedule.execution.model}</p>
          {schedule.issue && <p className="mt-2 text-xs text-destructive">{schedule.issue}</p>}
          <button className="mt-3 text-xs text-muted-foreground underline-offset-4 hover:underline" onClick={() => { navigate(`/chat/${schedule.chatId}`); if (window.innerWidth < 768) onClose() }}>打开结果对话 ↗</button>
          <div className="my-3 border-t border-border" />
          {snapshot.runs.filter(run => run.scheduleId === schedule.id).slice(0, 5).map(run => <div key={run.id} className="mb-3 text-xs text-muted-foreground"><div className="flex justify-between gap-2"><span>{outcomes[run.state]}</span><span>{new Date(run.scheduledFor).toLocaleString()}</span></div>{run.reason && <div className="mt-1 break-words">{run.reason}</div>}</div>)}
          {!snapshot.runs.some(run => run.scheduleId === schedule.id) && <p className="text-xs text-muted-foreground">No runs yet</p>}
          <Button variant="ghost" className="mt-2 w-full justify-start px-0 text-xs text-muted-foreground" disabled={disabled} onClick={() => edit(schedule)}><Pencil className="mr-2 size-3.5" />Edit Schedule…</Button>
        </div>}
      </div>)}
    </div>
  </div>
}
