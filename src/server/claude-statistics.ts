import type { HarnessEvent } from "./harness-types"
import { ProviderStatistics, providerUsage } from "./provider-statistics"

/** Adapts raw SDK message boundaries, without changing DSH's folds. */
export class ClaudeStatistics {
  private collector: ProviderStatistics | null = null
  private currentId: string | null = null
  private currentUsage: any = null
  private streamed = new Set<string>()
  private completed = new Set<string>()
  private events: HarnessEvent[] = []
  constructor(private starts: number[], private now = Date.now) {}
  private active() {
    if (!this.collector) {
      this.collector = new ProviderStatistics(event => this.events.push(event), this.now)
      this.collector.start(this.starts.shift() ?? this.now())
    }
    return this.collector
  }
  observe(message: any): HarnessEvent[] {
    this.events = []
    if (message?.parent_tool_use_id != null) return this.events
    if (message?.type === "system" && message.subtype === "api_retry") {
      const usage = providerUsage(this.currentUsage, "claude")
      this.active().retry(usage ?? undefined)
      this.currentId = null; this.currentUsage = null
    }
    const event = message?.type === "stream_event" ? message.event : null
    if (event?.type === "message_start") {
      this.active().start()
      this.currentId = event.message?.id ?? null
      this.currentUsage = event.message?.usage ?? {}
      if (this.currentId) this.streamed.add(this.currentId)
    } else if (event?.type === "content_block_start" && event.content_block?.type === "tool_use") {
      this.active().delta({ type: "tool-call-delta", name: event.content_block.name, argumentsDelta: "", index: event.index })
    } else if (event?.type === "content_block_delta") {
      const delta = event.delta
      if (delta?.type === "text_delta") this.active().delta({ type: "text-delta", text: delta.text })
      if (delta?.type === "thinking_delta") this.active().delta({ type: "reasoning-delta", text: delta.thinking })
      if (delta?.type === "input_json_delta") this.active().delta({ type: "tool-call-delta", argumentsDelta: delta.partial_json })
    } else if (event?.type === "message_delta") {
      this.currentUsage = { ...this.currentUsage, ...event.usage }
    } else if (event?.type === "message_stop") {
      const usage = providerUsage(this.currentUsage, "claude")
      if (usage && (!this.currentId || !this.completed.has(this.currentId))) {
        this.active().complete(usage)
        if (this.currentId) this.completed.add(this.currentId)
      }
    }
    if (message?.type === "assistant") {
      const id = message.message?.id ?? message.uuid
      const usage = providerUsage(message.message?.usage ?? message.usage, "claude")
      if (id && usage && !this.streamed.has(id) && !this.completed.has(id)) {
        this.active().complete(usage)
        this.completed.add(id)
      }
      for (const block of message.message?.content ?? []) {
        if (block.type === "tool_use" && typeof block.id === "string") this.active().toolCall(block.id)
      }
    }
    if (message?.type === "user" && Array.isArray(message.message?.content)) {
      for (const block of message.message.content) {
        if (block.type === "tool_result" && typeof block.tool_use_id === "string") this.active().toolResult(block.tool_use_id)
      }
    }
    if (message?.type === "result") {
      if (!this.collector) this.starts.shift()
      this.collector?.end()
      this.collector = null; this.currentId = null; this.currentUsage = null
      this.streamed.clear(); this.completed.clear()
    }
    return this.events
  }
}
