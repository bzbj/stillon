import type { ChatSnapshot, TranscriptEntry } from "./types"

export type ChatMetadata = Omit<ChatSnapshot, "messages">
export interface ChatDelta {
  set: Partial<ChatMetadata>
  upsert: TranscriptEntry[]
  /** Complete server order when membership/order changes; absent means preserve it. */
  order?: string[]
}
export interface ChatStreamStamp { streamId: string; revision: number }
export type ChatStreamFrame =
  | { type: "snapshot"; data: ChatSnapshot | null; stream: ChatStreamStamp }
  | { type: "chat-delta"; delta: ChatDelta; stream: ChatStreamStamp; baseRevision: number }

const metadataKeys = ["runtime", "queuedMessages", "history", "availableProviders", "asyncQuestionResponses"] as const
// Only one bounded recent window, never an unbounded delta log or full history.
export const MAX_CHAT_STREAM_CACHE_CHARACTERS = 2 * 1024 * 1024
export interface PreparedChatSnapshot {
  snapshot: ChatSnapshot | null
  entries: Map<string, string>
  metadata: Map<keyof ChatMetadata, string>
  cacheable: boolean
}
export function prepareChatSnapshot(snapshot: ChatSnapshot | null): PreparedChatSnapshot {
  const entries = new Map<string, string>()
  const metadata = new Map<keyof ChatMetadata, string>()
  let size = 0
  let unique = true
  for (const entry of snapshot?.messages ?? []) {
    const json = JSON.stringify(entry)
    size += json.length
    if (entries.has(entry._id)) unique = false
    entries.set(entry._id, json)
  }
  if (snapshot) for (const key of metadataKeys) {
    const json = JSON.stringify(snapshot[key])
    metadata.set(key, json)
    size += json.length
  }
  return { snapshot, entries, metadata, cacheable: unique && size <= MAX_CHAT_STREAM_CACHE_CHARACTERS }
}

export class ChatStreamEncoder {
  private previous: PreparedChatSnapshot | null = null
  private revision = 0
  constructor(readonly streamId: string) {}

  encode(next: PreparedChatSnapshot): ChatStreamFrame | null {
    const previous = this.previous
    const snapshot = next.snapshot
    const full = () => {
      this.previous = next.cacheable ? next : null
      return { type: "snapshot" as const, data: snapshot, stream: { streamId: this.streamId, revision: ++this.revision } }
    }
    if (!previous || !previous.snapshot || !snapshot || !next.cacheable
      || previous.snapshot.runtime.chatId !== snapshot.runtime.chatId
      || previous.snapshot.history.revision !== snapshot.history.revision) {
      if (previous && previous.snapshot === null && snapshot === null) return null
      return full()
    }
    const set: Partial<ChatMetadata> = {}
    for (const key of metadataKeys) if (previous.metadata.get(key) !== next.metadata.get(key)) {
      Object.assign(set, { [key]: snapshot[key] })
    }
    const upsert = snapshot.messages.filter((entry) => previous.entries.get(entry._id) !== next.entries.get(entry._id))
    const oldIds = [...previous.entries.keys()]
    const ids = snapshot.messages.map((entry) => entry._id)
    const orderChanged = ids.length !== oldIds.length || ids.some((id, index) => id !== oldIds[index])
    if (!upsert.length && !orderChanged && !Object.keys(set).length) return null
    const baseRevision = this.revision
    this.previous = next
    return { type: "chat-delta", stream: { streamId: this.streamId, revision: ++this.revision }, baseRevision,
      delta: { set, upsert, ...(orderChanged ? { order: ids } : {}) } }
  }
}

/** Immutable merge preserves unchanged entry objects and metadata-only message arrays. */
export function applyChatDelta(current: ChatSnapshot, delta: ChatDelta): ChatSnapshot {
  let messages = current.messages
  if (delta.order || delta.upsert.length) {
    const byId = new Map(messages.map((entry) => [entry._id, entry]))
    const updated = new Set<string>()
    for (const entry of delta.upsert) {
      if (typeof entry._id !== "string" || updated.has(entry._id)) throw new Error("Invalid delta entry")
      updated.add(entry._id)
      if (!delta.order && !byId.has(entry._id)) throw new Error("Missing delta order")
      byId.set(entry._id, entry)
    }
    const order = delta.order ?? messages.map((entry) => entry._id)
    if (new Set(order).size !== order.length) throw new Error("Duplicate delta order")
    messages = order.map((id) => {
      const entry = byId.get(id)
      if (!entry) throw new Error("Missing delta entry")
      return entry
    })
    if (delta.upsert.some((entry) => !order.includes(entry._id))) throw new Error("Unordered delta entry")
  }
  return { ...current, ...delta.set, messages }
}

export class ChatStreamDecoder {
  private revision = 0
  private snapshot: ChatSnapshot | null = null
  private waiting = false
  constructor(readonly streamId: string) {}
  receive(frame: ChatStreamFrame): { kind: "apply"; snapshot: ChatSnapshot | null } | { kind: "ignore" | "resync" } {
    if (frame.stream.streamId !== this.streamId) return { kind: "ignore" }
    if (!Number.isSafeInteger(frame.stream.revision) || frame.stream.revision < 1) return this.resync()
    if (frame.stream.revision <= this.revision) return { kind: "ignore" }
    if (frame.type === "snapshot") {
      this.revision = frame.stream.revision
      this.snapshot = frame.data
      this.waiting = false
      return { kind: "apply", snapshot: this.snapshot }
    }
    if (this.waiting) return { kind: "ignore" }
    if (!this.snapshot || frame.baseRevision !== this.revision || frame.stream.revision !== this.revision + 1) return this.resync()
    try {
      this.snapshot = applyChatDelta(this.snapshot, frame.delta)
      this.revision = frame.stream.revision
      return { kind: "apply", snapshot: this.snapshot }
    } catch { return this.resync() }
  }
  private resync(): { kind: "ignore" | "resync" } {
    if (this.waiting) return { kind: "ignore" }
    this.waiting = true
    return { kind: "resync" }
  }
}
