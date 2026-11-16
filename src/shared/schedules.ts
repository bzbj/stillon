import { z } from "zod"
import type { ChatTurnPreferences } from "./types"

export const scheduleTriggerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("once"), at: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("weekly"), timeOfDay: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7), timeZone: z.string().min(1).max(100) }).strict(),
])
export type ScheduleTrigger = z.infer<typeof scheduleTriggerSchema>
export interface ScheduleSource { kind: "schedule"; scheduleId: string; name: string; runId: string }
export type ScheduleExecution = ChatTurnPreferences & { planMode: boolean }
export interface Schedule {
  id: string; projectId: string; chatId: string; name: string; prompt: string; trigger: ScheduleTrigger
  execution: ScheduleExecution; enabled: boolean; nextRunAt: number | null; revision: number
  source: "stillon"; createdAt: number; updatedAt: number; issue?: string
}
export type ScheduleRunState = "claimed" | "running" | "waiting_for_user" | "succeeded" | "failed" | "cancelled" | "skipped" | "blocked" | "interrupted_unknown"
export interface ScheduleRun {
  id: string; scheduleId: string; projectId: string; chatId: string; name: string; scheduledFor: number
  startedAt?: number; finishedAt?: number; agentRunId?: string; state: ScheduleRunState; reason?: string
  execution: ScheduleExecution; cwd: string
}
export interface ProjectSchedulesSnapshot {
  type: "project-schedules"; projectId: string; schedules: Array<Schedule & { chatTitle: string }>
  runs: ScheduleRun[]; available: boolean; error?: string
}

export function scheduleTriggerLabel(trigger: ScheduleTrigger) {
  if (trigger.kind === "once") return new Date(trigger.at).toLocaleString("en", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })
  const days = [...new Set(trigger.weekdays)].sort()
  const label = days.length === 7 ? "Every day" : days.join() === "1,2,3,4,5" ? "Weekdays" : days.map(day => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][day]).join(", ")
  return `${label} ${trigger.timeOfDay} · ${trigger.timeZone}`
}
