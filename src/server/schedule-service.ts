import { z } from "zod"
import type { EventStore } from "./event-store"
import { scheduleTriggerSchema, type ProjectSchedulesSnapshot, type Schedule, type ScheduleRun, type ScheduleRunState } from "../shared/schedules"
import { ScheduleStore } from "./schedule-store"
import { nextScheduleTime, validateTimeZone } from "./schedule-time"

export const scheduleInput = z.object({
  operationId: z.string().uuid().optional(),
  scheduleId: z.string().uuid().optional(), expectedRevision: z.number().int().positive().optional(),
  name: z.string().trim().min(1).max(120).optional(), message: z.string().trim().min(1).max(32000).optional(),
  chatId: z.string().min(1).max(128).optional(), enabled: z.boolean().optional(),
  runAt: z.string().max(100).optional(), inMinutes: z.number().positive().max(5256000).optional(),
  dailyAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(), weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
  timeZone: z.string().min(1).max(100).optional(),
}).strict()
export interface ScheduleToolContext { chatId: string; projectId: string; planning: boolean; automated: boolean }
interface Dependencies {
  events: EventStore
  start: (schedule: Schedule, run: ScheduleRun) => Promise<{ status: "started"; agentRunId: string } | { status: "busy" }>
  changed: () => void
  now?: () => number
}
export class ScheduleService {
  private timer?: ReturnType<typeof setTimeout>
  private ticking: Promise<void> | null = null
  private stopped = true
  private fault: string | undefined
  private running = new Map<string, ScheduleRun>()
  constructor(readonly store: ScheduleStore, private deps: Dependencies) {}
  private now() { return this.deps.now?.() ?? Date.now() }
  snapshot(projectId: string): ProjectSchedulesSnapshot {
    if (!this.deps.events.getProject(projectId)) throw new Error("Workspace not found")
    return { type: "project-schedules", projectId, available: this.store.writable && !this.fault,
      ...(this.fault ? { error: this.fault } : {}),
      ...(!this.store.writable ? { error: "Another StillOn process owns this scheduler" } : {}),
      schedules: this.store.list(projectId).map(schedule => ({ ...schedule, chatTitle: this.deps.events.getChat(schedule.chatId)?.title ?? "Deleted conversation" })), runs: this.store.runs(projectId) }
  }
  execute(name: string, raw: unknown, context: ScheduleToolContext) {
    if (name === "list_schedules") return this.executeCore(name, raw, context)
    if (context.automated) throw new Error("Scheduled runs cannot create or change schedules. Ask the user in the conversation.")
    const input = z.object({ operationId: z.string().uuid().optional() }).passthrough().parse(raw)
    const { operationId, ...argumentsWithoutId } = input
    if (!operationId) return this.executeCore(name, argumentsWithoutId, context)
    // A receipt and its mutation share one SQLite commit. Retrying a lost
    // response returns the same result, including after a server restart.
    const payload = JSON.stringify({ name, arguments: Object.fromEntries(Object.entries(argumentsWithoutId).sort(([a], [b]) => a.localeCompare(b))) })
    return this.store.operation(`${context.projectId}:${context.chatId}:${operationId}`, payload, () => this.executeCore(name, argumentsWithoutId, context))
  }
  private executeCore(name: string, raw: unknown, context: ScheduleToolContext) {
    if (!this.deps.events.getProject(context.projectId)) throw new Error("Workspace not found")
    if (name === "list_schedules") return this.snapshot(context.projectId)
    if (this.fault) throw new Error(this.fault)
    if (context.automated) throw new Error("Scheduled runs cannot create or change schedules. Ask the user in the conversation.")
    if (name === "delete_schedule") {
      const input = z.object({ scheduleId: z.string().uuid(), expectedRevision: z.number().int().positive().optional() }).strict().parse(raw)
      const schedule = this.require(input.scheduleId, context.projectId)
      if (context.planning && !schedule.execution.planMode) throw new Error("Plan mode cannot change execution schedules")
      this.store.delete(schedule.id, input.expectedRevision ?? schedule.revision)
      this.changed()
      return { deleted: schedule.id, name: schedule.name }
    }
    if (name !== "set_schedule") throw new Error("Unknown schedule tool")
    const input = scheduleInput.parse(raw)
    const old = input.scheduleId ? this.require(input.scheduleId, context.projectId) : null
    if (!old && this.store.list(context.projectId).length >= 100) throw new Error("This workspace has reached 100 schedules")
    const chatId = input.chatId ?? old?.chatId ?? context.chatId
    const chat = this.deps.events.getChat(chatId)
    if (!chat || chat.projectId !== context.projectId) throw new Error("Target conversation must belong to this workspace")
    const message = input.message ?? old?.prompt
    if (!message) throw new Error("A schedule needs a message")
    let execution: Schedule["execution"] | undefined = old?.execution ?? (chat.lastTurnPreferences ? { ...chat.lastTurnPreferences, planMode: chat.planMode } : undefined)
    if (old && old.chatId !== chatId) execution = chat.lastTurnPreferences ? { ...chat.lastTurnPreferences, planMode: chat.planMode } : undefined
    if (!execution) throw new Error("Send a message in the target conversation before scheduling it")
    if (context.planning && !execution.planMode) throw new Error("A plan-mode conversation can only schedule plan-mode work")
    const now = this.now()
    const triggers = [input.runAt, input.inMinutes, input.dailyAt].filter(v => v !== undefined)
    if (triggers.length > 1) throw new Error("Give exactly one of runAt, inMinutes or dailyAt")
    let trigger = old?.trigger
    if (input.runAt !== undefined || input.inMinutes !== undefined) {
      const at = input.inMinutes !== undefined ? now + input.inMinutes * 60000 : Date.parse(input.runAt!)
      if (!Number.isFinite(at) || at <= now) throw new Error("Choose a future time; runAt must include an explicit UTC offset")
      if (input.runAt && !/(?:Z|[+-]\d\d:\d\d)$/i.test(input.runAt)) throw new Error("runAt must include Z or a UTC offset")
      trigger = { kind: "once", at }
    } else if (input.dailyAt || input.weekdays || input.timeZone) {
      trigger = { kind: "weekly", timeOfDay: input.dailyAt ?? (old?.trigger.kind === "weekly" ? old.trigger.timeOfDay : "09:00"),
        weekdays: [...new Set(input.weekdays ?? (old?.trigger.kind === "weekly" ? old.trigger.weekdays : [0, 1, 2, 3, 4, 5, 6]))],
        timeZone: input.timeZone ?? (old?.trigger.kind === "weekly" ? old.trigger.timeZone : Intl.DateTimeFormat().resolvedOptions().timeZone) }
      validateTimeZone(trigger.timeZone)
    }
    if (!trigger) throw new Error("Give runAt, inMinutes or dailyAt")
    trigger = scheduleTriggerSchema.parse(trigger)
    const enabled = input.enabled ?? old?.enabled ?? true
    const recalculate = triggers.length > 0 || input.weekdays !== undefined || input.timeZone !== undefined || (!old?.enabled && enabled)
    const nextRunAt = !old || recalculate ? nextScheduleTime(trigger, now) : old.nextRunAt
    if (enabled && nextRunAt === null) throw new Error("This one-time schedule is finished; choose a new future time")
    const schedule: Schedule = { id: old?.id ?? crypto.randomUUID(), projectId: context.projectId, chatId, name: input.name ?? old?.name ?? message.split("\n")[0]!.slice(0, 80),
      prompt: message, trigger, execution: structuredClone(execution), enabled, nextRunAt, revision: (old?.revision ?? 0) + 1,
      source: "stillon", createdAt: old?.createdAt ?? now, updatedAt: now }
    this.store.save(schedule, input.expectedRevision ?? old?.revision)
    this.changed()
    return schedule
  }
  private require(id: string, projectId: string) {
    const schedule = this.store.get(id)
    if (!schedule || schedule.projectId !== projectId) throw new Error("Schedule not found in this workspace")
    return schedule
  }
  start() { if (!this.store.writable) return; this.stopped = false; try { this.arm() } catch { this.disableAfterStorageError() } }
  private changed() { this.deps.changed(); if (!this.ticking) this.arm() }
  private arm() {
    clearTimeout(this.timer)
    if (this.stopped) return
    const next = this.store.list().filter(s => s.enabled && s.nextRunAt !== null).reduce((at, s) => Math.min(at, s.nextRunAt!), this.now() + 60000)
    this.timer = setTimeout(() => { void this.tick().catch(() => { this.disableAfterStorageError() }) }, Math.max(0, next - this.now()))
    this.timer.unref()
  }
  tick(): Promise<void> {
    if (this.ticking) return this.ticking
    this.ticking = this.fireDue().finally(() => { this.ticking = null; this.arm() })
    return this.ticking
  }
  private async fireDue() {
    for (const schedule of this.store.list()) {
      const now = this.now()
      if (!schedule.enabled || schedule.nextRunAt === null || schedule.nextRunAt > now) continue
      const project = this.deps.events.getProject(schedule.projectId), chat = this.deps.events.getChat(schedule.chatId)
      const run = this.store.claim(schedule.id, now, project?.localPath ?? "")
      if (!run) continue
      this.running.set(run.id, run)
      try {
        if (!project || !chat || chat.projectId !== schedule.projectId) throw new Error("Target workspace or conversation was deleted")
        if (this.running.size > 2) { this.setState(run.id, "skipped", "Scheduler capacity reached"); continue }
        const result = await this.deps.start(schedule, run)
        if (result.status === "busy") this.setState(run.id, "skipped", "Conversation is busy, paused or still stopping")
        else {
          const live = this.running.get(run.id)
          if (live) { live.agentRunId = result.agentRunId; this.store.updateRun(live) }
        }
      } catch (error) {
        this.setState(run.id, "blocked", error instanceof Error ? error.message : "Could not start the scheduled run")
        const current = this.store.get(schedule.id)
        if (current) this.store.save({ ...current, enabled: false, revision: current.revision + 1, issue: "Could not start; inspect the run and resume after fixing the cause" })
      }
    }
    this.deps.changed()
  }
  private disableAfterStorageError() {
    this.stopped = true
    clearTimeout(this.timer)
    this.fault = "Scheduler stopped after a storage error. Restart StillOn after checking disk space and permissions."
    console.warn("[schedules] Scheduler disabled after a storage error")
    this.deps.changed()
  }
  setState(id: string, state: ScheduleRunState, reason?: string) {
    // A schedule database failure must not abort an otherwise healthy chat.
    try { this.updateState(id, state, reason) } catch { this.disableAfterStorageError() }
  }
  private updateState(id: string, state: ScheduleRunState, reason?: string) {
    const run = this.running.get(id)
    if (!run || run.state === state) return
    run.state = state
    if (reason) run.reason = reason
    if (state === "running") run.startedAt ??= this.now()
    if (!["claimed", "running", "waiting_for_user"].includes(state)) { run.finishedAt = this.now(); this.running.delete(id) }
    this.store.updateRun(run)
    if (state === "interrupted_unknown") {
      const schedule = this.store.get(run.scheduleId)
      if (schedule) this.store.save({ ...schedule, enabled: false, revision: schedule.revision + 1, issue: "Previous run ended without a result; inspect the conversation before resuming" })
    }
    this.deps.changed()
  }
  async stop() { this.stopped = true; clearTimeout(this.timer); await this.ticking }
  close() { this.store.close() }
}
