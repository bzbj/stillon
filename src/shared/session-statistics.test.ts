import { expect, test } from "bun:test"
import fixtures from "./vendor/dsh/fixtures/upstream.json"
import { sessionStatsProjectionDefinition as stats } from "./vendor/dsh/session-stats"
import { tokenUsageProjectionDefinition as usage } from "./vendor/dsh/token-usage"
import { createForkSessionStatistics, formatSessionTokens, sessionTokenTotal, sessionTokensPerSecond, updateSessionStatistics } from "./session-statistics"
for (const fixture of fixtures) test(`unmodified upstream parity: ${fixture.name}`, () => {
  let s = stats.init(), u = usage.init()
  fixture.events.forEach((event, i) => {
    s = stats.apply(s, event); u = usage.apply(u, event)
    expect<unknown>({ stats: s, usage: u }).toEqual(fixture.states[i])
  })
})
test("session totals use disjoint buckets and keep short-window upstream TPS", () => {
  const fixture = fixtures.at(-1)!
  const last = fixture.states.at(-1)!
  const state = { snapshot: { sessionStats: stats.wire.view(stats.stateSchema.parse(last.stats)), tokenUsage: usage.wire.view(last.usage) } }
  expect(sessionTokensPerSecond(state.snapshot)).toBe(104000)
  expect(sessionTokenTotal(state.snapshot.tokenUsage)).toBe(134)
  expect(formatSessionTokens(1_240_000_000)).toBe("1.24B")
})
test("native projections and native cumulative usage replace snapshots without adding them again", () => {
  const record = updateSessionStatistics(undefined, { runId: "a", events: [] })
  const native = { ...record.snapshot, tokenUsage: { uncachedInputTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 5, outputTokens: 10 } }
  expect(updateSessionStatistics(updateSessionStatistics(record, { native }), { native }).snapshot).toEqual(native)
  const authoritative = updateSessionStatistics(record, { runId: "a", events: [], nativeTokenUsage: native.tokenUsage })
  expect(updateSessionStatistics(authoritative, { runId: "b", events: [], nativeTokenUsage: native.tokenUsage }).snapshot.tokenUsage).toEqual(native.tokenUsage)
})

test("fork scope counts new request usage with the original fold instead of native inherited totals", () => {
  let branch = createForkSessionStatistics()
  expect(sessionTokenTotal(branch.snapshot.tokenUsage)).toBe(0)
  expect(branch.snapshot.sessionStats.steps).toBe(0)
  const observation = (runId: string, step: number, inputTokens: number) => ({ runId, usageOnly: true, nativeTokenUsage: { uncachedInputTokens: 10000 + inputTokens, cacheReadTokens: 5000, cacheWriteTokens: 1000, outputTokens: 4000 }, events: [{ type: "assistant/message", time: 100, data: { step, stream: [], usage: { inputTokens, cacheReadTokens: 3, cacheWriteTokens: 2, outputTokens: 4 } } }] })
  branch = updateSessionStatistics(branch, observation("first", 1, 10))
  expect(branch.snapshot.tokenUsage).toEqual({ uncachedInputTokens: 10, cacheReadTokens: 3, cacheWriteTokens: 2, outputTokens: 4 })
  branch = updateSessionStatistics(structuredClone(branch), observation("second", 1, 20))
  expect(branch.scope).toBe("fork")
  expect(sessionTokenTotal(branch.snapshot.tokenUsage)).toBe(48)
})
