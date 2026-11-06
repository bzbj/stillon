import { z } from "zod"
import { sessionStatsProjectionDefinition, type SessionStatsState } from "./vendor/dsh/session-stats"
import { tokenUsageProjectionDefinition, type TokenBuckets, type TokenUsageState } from "./vendor/dsh/token-usage"
import type { DshEvent } from "./vendor/dsh/types"

export const sessionStatisticsSchema = z.object({
  recordedSince: z.number().nonnegative().optional(),
  tokenUsage: tokenUsageProjectionDefinition.wire.viewSchema,
  sessionStats: sessionStatsProjectionDefinition.wire.viewSchema,
})
export type SessionStatistics = z.infer<typeof sessionStatisticsSchema>
export type StatisticsInput =
  | { runId: string; events: DshEvent[]; usageOnly?: boolean; nativeTokenUsage?: TokenBuckets }
  | { native: SessionStatistics }
export interface StatisticsRecord {
  version: 1
  runId: string | null
  turn: number
  stats: SessionStatsState
  usage: TokenUsageState
  snapshot: SessionStatistics
}

/** The only adaptation here is assigning durable per-chat turn coordinates. */
export function updateSessionStatistics(previous: StatisticsRecord | undefined, input: StatisticsInput): StatisticsRecord {
  let stats = previous?.stats ?? sessionStatsProjectionDefinition.init()
  let usage = previous?.usage ?? tokenUsageProjectionDefinition.init()
  let turn = previous?.turn ?? 0
  let runId = previous?.runId ?? null
  if ("native" in input) {
    const snapshot = sessionStatisticsSchema.parse(input.native)
    return { version: 1, runId, turn, stats, usage, snapshot }
  }
  if (input.runId !== runId) { runId = input.runId; turn++ }
  for (const raw of input.events) {
    const event = { ...raw, data: { ...raw.data, turn } }
    if (!input.usageOnly) stats = sessionStatsProjectionDefinition.apply(stats, event)
    usage = tokenUsageProjectionDefinition.apply(usage, event)
  }
  if (input.nativeTokenUsage) {
    usage = { ...usage, totals: tokenUsageProjectionDefinition.wire.viewSchema.parse(input.nativeTokenUsage) }
  }
  const snapshot = sessionStatisticsSchema.parse({
    ...(previous?.snapshot.recordedSince && !input.nativeTokenUsage ? { recordedSince: previous.snapshot.recordedSince } : {}),
    sessionStats: sessionStatsProjectionDefinition.wire.view(stats),
    tokenUsage: tokenUsageProjectionDefinition.wire.view(usage),
  })
  return { version: 1, runId, turn, stats, usage, snapshot }
}

export function sessionTokenTotal(usage: TokenBuckets) {
  return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens
}

/** DSH's formatter, with the user-requested B display unit. */
export function formatSessionTokens(value: number) {
  const scaled = (candidate: number) => candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10)
  if (value < 1e3) return String(value)
  if (value < 1e6) return `${scaled(value / 1e3)}K`
  if (value < 1e9) return `${scaled(value / 1e6)}M`
  return `${Number((value / 1e9).toFixed(2))}B`
}
export function sessionTokensPerSecond(value: SessionStatistics) {
  const { decodeMs, decodeTokens } = value.sessionStats
  return decodeMs > 0 ? decodeTokens / (decodeMs / 1000) : null
}
export function formatSessionSpeed(value: number) {
  const clamped = Math.max(0, value)
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10)
}
