import { isTokenDelta } from "../shared/vendor/dsh/stream-readers"
import type { TokenBuckets } from "../shared/vendor/dsh/token-usage"
import { randomUUID } from "node:crypto"
import type { HarnessEvent } from "./harness-types"
import type { DshEvent } from "../shared/vendor/dsh/types"

export interface ProviderUsage { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }
const count = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0
export function providerUsage(raw: any, provider: "codex" | "claude"): ProviderUsage | null {
  if (!raw || typeof raw !== "object") return null
  const input = raw.input_tokens ?? raw.inputTokens
  const output = raw.output_tokens ?? raw.outputTokens
  const read = raw.cache_read_input_tokens ?? raw.cached_input_tokens ?? raw.cachedInputTokens ?? 0
  const write = raw.cache_creation_input_tokens ?? raw.cache_write_input_tokens ?? raw.cacheWriteInputTokens ?? 0
  if (![input, output, read, write].every(count)) return null
  // Codex prompt totals include cache traffic; DSH/Claude use disjoint buckets.
  const fresh = provider === "codex" ? input - read - write : input
  if (!count(fresh)) return null
  return { inputTokens: fresh, outputTokens: output, cacheReadTokens: read, cacheWriteTokens: write }
}

/** Protocol observation only. All arithmetic and aggregation live in the upstream folds. */
export class ProviderStatistics {
  readonly runId = randomUUID()
  private step = 0
  private open = false
  private first: DshEvent["data"] | null = null
  private tools = new Set<string>()
  constructor(private emit: (event: HarnessEvent) => void, private now = Date.now) {}
  private publish(events: DshEvent[], nativeTokenUsage?: TokenBuckets) { this.emit({ type: "statistics", statistics: { runId: this.runId, events, ...(nativeTokenUsage ? { nativeTokenUsage } : {}) } }) }
  private event(type: string, data: Record<string, any> = {}, time = this.now()): DshEvent {
    return { type, time, data: { turn: 1, step: this.step, ...data } }
  }
  start(time = this.now()) {
    if (this.open) return
    this.step++; this.open = true; this.first = null
    this.publish([this.event("step/start", {}, time)])
  }
  delta(chunk: Record<string, any>, time = this.now()) {
    if (!this.open) this.start(time)
    if (this.first) return
    if (isTokenDelta(chunk)) this.first = { type: "chunk", time, chunk }
  }
  retry(usage?: ProviderUsage, time = this.now()) {
    if (!this.open) this.start(time)
    this.publish([
      this.event("assistant/attempt", { stream: [...(this.first ? [this.first] : []), ...(usage ? [{ type: "chunk", time, chunk: { type: "usage", usage } }] : [])] }, time),
      this.event("llm/retry-started", {}, time),
    ])
    // DSH preserves the first token of earlier attempts in this step.
  }
  complete(usage: ProviderUsage, time = this.now(), nativeTokenUsage?: TokenBuckets) {
    if (!this.open) this.start(time)
    this.publish([
      this.event("assistant/message", { usage, stream: this.first ? [this.first] : [] }, time),
      this.event("step/end", {}, time),
    ], nativeTokenUsage)
    this.open = false; this.first = null
  }
  toolCall(callId: string, time = this.now()) {
    if (this.tools.has(callId)) return
    this.tools.add(callId); this.publish([this.event("tool/call", { callId }, time)])
  }
  toolResult(callId: string, time = this.now()) {
    if (!this.tools.delete(callId)) return
    this.publish([this.event("tool/result", { message: { source: { callId } } }, time)])
    if (!this.tools.size) this.start(time)
  }
  end(time = this.now()) {
    const events = this.open ? [this.event("step/end", {}, time)] : []
    events.push(this.event("turn/end", {}, time))
    this.publish(events); this.open = false; this.first = null; this.tools.clear()
  }
}
