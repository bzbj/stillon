import { expect, test } from "bun:test"
import { ClaudeStatistics } from "./claude-statistics"
import { providerUsage, ProviderStatistics } from "./provider-statistics"
import { updateSessionStatistics, type StatisticsRecord } from "../shared/session-statistics"
import type { HarnessEvent } from "./harness-types"
const fold = (events: HarnessEvent[]) => events.reduce<StatisticsRecord | undefined>((state, event) => event.statistics ? updateSessionStatistics(state, event.statistics) : state, undefined)!
test("provider cache buckets do not double count cached input or reasoning", () => {
  expect(providerUsage({ inputTokens: 100, cachedInputTokens: 20, cacheWriteInputTokens: 5, outputTokens: 40, reasoningOutputTokens: 10 }, "codex")).toEqual({ inputTokens: 75, cacheReadTokens: 20, cacheWriteTokens: 5, outputTokens: 40 })
  expect(providerUsage({ input_tokens: 100, cache_read_input_tokens: 20, cache_creation_input_tokens: 5, output_tokens: 40 }, "claude")?.inputTokens).toBe(100)
  expect(providerUsage({ inputTokens: 1, cachedInputTokens: 2, outputTokens: 1 }, "codex")).toBeNull()
  expect(providerUsage({ inputTokens: NaN, outputTokens: 1 }, "codex")).toBeNull()
})
test("collector delegates retry accounting and first-token timing to upstream folds", () => {
  const events: HarnessEvent[] = [], c = new ProviderStatistics(e => events.push(e))
  c.start(100); c.delta({ type: "text-delta", text: "" }, 110); c.delta({ type: "reasoning-delta", text: "a" }, 200)
  c.retry({ inputTokens: 10, outputTokens: 2 }, 300)
  c.delta({ type: "text-delta", text: "b" }, 400); c.complete({ inputTokens: 20, outputTokens: 4 }, 600); c.end(610)
  const record = fold(events)
  expect(record.snapshot.sessionStats).toMatchObject({ steps: 1, ttftMs: 100, llmMs: 500, decodeMs: 400, decodeTokens: 4 })
  expect(record.snapshot.tokenUsage.outputTokens).toBe(6)
})
test("Claude partial stream commits final usage once despite per-block assistant messages", () => {
  let now = 100
  const c = new ClaudeStatistics([100], () => now), events: HarnessEvent[] = []
  const observe = (message: any, time: number) => { now = time; events.push(...c.observe(message)) }
  const stream = (event: any) => ({ type: "stream_event", event })
  observe(stream({ type: "message_start", message: { id: "a", usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 5 } } }), 110)
  observe(stream({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "x" } }), 200)
  observe({ type: "assistant", message: { id: "a", content: [{ type: "text", text: "first" }], usage: { input_tokens: 10, output_tokens: 1 } } }, 220)
  observe({ type: "assistant", parent_tool_use_id: "subagent", message: { id: "child", content: [], usage: { input_tokens: 1000, output_tokens: 1000 } } }, 230)
  observe(stream({ type: "message_delta", usage: { output_tokens: 4 } }), 590)
  observe(stream({ type: "message_stop" }), 600)
  observe({ type: "assistant", message: { id: "a", content: [], usage: { input_tokens: 10, output_tokens: 4 } } }, 605)
  observe({ type: "result", usage: { input_tokens: 999, output_tokens: 999 } }, 610)
  const record = fold(events)
  expect(record.snapshot.tokenUsage).toEqual({ uncachedInputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 0, outputTokens: 4 })
  expect(record.snapshot.sessionStats).toMatchObject({ steps: 1, turns: 1, llmMs: 500, ttftMs: 100, decodeMs: 400 })
})

test("a finished tool does not invent a model step when the turn ends immediately", () => {
  const events: HarnessEvent[] = [], c = new ProviderStatistics(e => events.push(e))
  c.start(100); c.delta({ type: "text-delta", text: "x" }, 200); c.complete({ inputTokens: 10, outputTokens: 4 }, 300)
  c.toolCall("stop-tool", 310); c.toolResult("stop-tool", 500); c.end(600)
  expect(fold(events).snapshot.sessionStats).toMatchObject({ steps: 1, llmMs: 200, toolMs: 190 })
})
test("the next observed model response retains the previous tool-completion boundary", () => {
  const events: HarnessEvent[] = [], c = new ProviderStatistics(e => events.push(e))
  c.start(100); c.delta({ type: "text-delta", text: "x" }, 200); c.complete({ inputTokens: 10, outputTokens: 4 }, 300)
  c.toolCall("a", 310); c.toolResult("a", 500)
  c.delta({ type: "text-delta", text: "next" }, 700); c.complete({ inputTokens: 20, outputTokens: 8 }, 900); c.end(910)
  expect(fold(events).snapshot.sessionStats).toMatchObject({ steps: 2, llmMs: 600, toolMs: 190, ttftMs: 300, decodeMs: 300 })
})
