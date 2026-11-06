import { useLayoutEffect, useState, type ReactNode } from "react"
import { Gauge, Layers, X } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover"
import { formatSessionSpeed, formatSessionTokens, sessionTokenTotal, sessionTokensPerSecond, type SessionStatistics as Statistics } from "../../../shared/session-statistics"
import { useAppSettingsStore } from "../../stores/appSettingsStore"

function duration(ms: number) {
  const seconds = ms / 1000
  if (seconds < 60) return `${Math.round(seconds * 10) / 10}s`
  const whole = Math.round(seconds)
  if (whole < 3600) return `${Math.floor(whole / 60)}m ${whole % 60}s`
  return `${Math.floor(whole / 3600)}h ${Math.floor(whole % 3600 / 60)}m`
}
function Row({ label, children, total = false }: { label: string; children: ReactNode; total?: boolean }) {
  return <div className={`flex items-center justify-between gap-5 ${total ? "mt-1 border-t border-border pt-3.5" : ""}`}>
    <dt className={total ? "font-medium" : "text-muted-foreground"}>{label}</dt><dd className={`m-0 tabular-nums ${total ? "font-semibold" : "font-medium"}`}>{children}</dd>
  </div>
}

export function SessionStatistics({ statistics, onLayoutChange }: { statistics: Statistics | null; onLayoutChange: () => void }) {
  const visible = useAppSettingsStore(s => s.settings?.showSessionStatistics === true)
  const [open, setOpen] = useState<"timing" | "tokens" | null>(null)
  const total = statistics ? sessionTokenTotal(statistics.tokenUsage) : 0
  const speed = statistics ? sessionTokensPerSecond(statistics) : null
  const show = visible && statistics !== null && (total > 0 || statistics.sessionStats.steps > 0)
  useLayoutEffect(() => { if (!show) setOpen(null); onLayoutChange() }, [show, onLayoutChange])
  if (!show || !statistics) return null
  const stats = statistics.sessionStats
  const triggerClass = "inline-flex min-h-8 items-center gap-1.5 rounded-md px-2 text-xs tabular-nums text-muted-foreground hover:bg-muted hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground"
  function details(kind: "timing" | "tokens", title: string, trigger: ReactNode, body: ReactNode) {
    return <Popover open={open === kind} onOpenChange={value => setOpen(value ? kind : null)}>
      <PopoverTrigger asChild><button type="button" className={triggerClass} aria-label={title}>{trigger}</button></PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={8} className="w-[330px] max-w-[calc(100vw-24px)] p-[18px]" aria-label={title}>
        <header className="mb-4 flex items-center justify-between gap-3"><h2 className="text-[13px] font-semibold">{title}</h2><button type="button" className="-m-1 rounded p-1 text-muted-foreground hover:text-foreground" aria-label={`Close ${title.toLowerCase()}`} onClick={() => setOpen(null)}><X className="size-3.5" /></button></header>
        {body}
      </PopoverContent>
    </Popover>
  }
  return <div data-session-statistics className="mx-auto flex max-w-[840px] items-center gap-1 px-5 pb-1 pt-1">
    {speed !== null ? details("timing", "Session timing", <><Gauge className="size-3.5" /><span>{formatSessionSpeed(speed)} tok/s</span></>, <>
      <div className="text-[27px] font-medium leading-none tracking-tight tabular-nums">{formatSessionSpeed(speed)} <span className="text-xs font-normal tracking-normal text-muted-foreground">tok/s</span></div>
      <p className="mb-5 mt-1.5 text-[11px] text-muted-foreground">Average output speed</p>
      <dl className="space-y-3 text-xs">{stats.ttftSteps > 0 ? <Row label="First token">{duration(stats.ttftMs / stats.ttftSteps)}</Row> : null}<Row label="Model time">{duration(stats.llmMs)}</Row><Row label="Tool time">{duration(stats.toolMs)}</Row></dl>
      <div className="mt-4 flex justify-between border-t border-border pt-3 text-[11px] text-muted-foreground"><span>{stats.turns.toLocaleString()} turns</span><span>{stats.steps.toLocaleString()} steps</span></div>
    </>) : null}
    {speed !== null && total > 0 ? <span className="mx-1 h-3 w-px bg-border" /> : null}
    {total > 0 ? details("tokens", "Session tokens", <><Layers className="size-3.5" /><span>{formatSessionTokens(total)} tokens</span></>, <dl className="space-y-3 text-xs">
      {statistics.recordedSince ? <p className="pb-1 text-[11px] text-muted-foreground">Recorded since {new Date(statistics.recordedSince).toLocaleString()}</p> : null}
      <Row label="Uncached input">{formatSessionTokens(statistics.tokenUsage.uncachedInputTokens)}</Row><Row label="Cache read">{formatSessionTokens(statistics.tokenUsage.cacheReadTokens)}</Row><Row label="Cache write">{formatSessionTokens(statistics.tokenUsage.cacheWriteTokens)}</Row><Row label="Output">{formatSessionTokens(statistics.tokenUsage.outputTokens)}</Row><Row label="Total" total>{total.toLocaleString("en-US")}</Row>
    </dl>) : null}
  </div>
}
