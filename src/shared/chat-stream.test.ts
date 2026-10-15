import { expect, test } from "bun:test"
import { applyChatDelta, ChatStreamDecoder, ChatStreamEncoder, prepareChatSnapshot } from "./chat-stream"
import type { ChatSnapshot, TranscriptEntry } from "./types"
const entry = (id: string, text = id): TranscriptEntry => ({ _id: id, kind: "assistant_text", createdAt: 1, text })
function snapshot(messages: TranscriptEntry[], revision = "history-1"): ChatSnapshot {
  return { runtime: { chatId: "chat", title: "Example" } as ChatSnapshot["runtime"], messages,
    queuedMessages: [], availableProviders: [], asyncQuestionResponses: [],
    history: { hasOlder: false, olderCursor: null, recentLimit: 40, revision } }
}

test("delta append, same-ID replacement, removal/reorder and runtime-only updates preserve references", () => {
  const encoder = new ChatStreamEncoder("stream")
  const decoder = new ChatStreamDecoder("stream")
  let current = snapshot([entry("a"), entry("b")])
  const first = encoder.encode(prepareChatSnapshot(current))!
  expect(first.type).toBe("snapshot")
  decoder.receive(first)
  const next = snapshot([entry("b"), entry("a", "replaced"), entry("c")])
  const delta = encoder.encode(prepareChatSnapshot(next))!
  expect(delta.type).toBe("chat-delta")
  const merged = decoder.receive(delta)
  if (merged.kind !== "apply" || !merged.snapshot) throw new Error("No merge")
  expect(merged.snapshot).toEqual(next)
  expect(merged.snapshot.messages[0]).toBe(current.messages[1])
  expect(decoder.receive(delta).kind).toBe("ignore")
  current = merged.snapshot
  const runtime = encoder.encode(prepareChatSnapshot({ ...next, runtime: { ...next.runtime, title: "changed" } }))!
  const result = decoder.receive(runtime)
  if (result.kind !== "apply" || !result.snapshot) throw new Error("No runtime update")
  expect(result.snapshot.messages).toBe(current.messages)
  const removed = encoder.encode(prepareChatSnapshot(snapshot([entry("c")])))!
  expect(decoder.receive(removed)).toEqual({ kind: "apply", snapshot: snapshot([entry("c")]) })
  expect(encoder.encode(prepareChatSnapshot(snapshot([entry("c")])))).toBeNull()
})

test("missing base, out-of-order delivery and reconnect require resync; old epochs and duplicates ignored", () => {
  const encoder = new ChatStreamEncoder("stream")
  const decoder = new ChatStreamDecoder("stream")
  const initial = encoder.encode(prepareChatSnapshot(snapshot([entry("a")])))!
  decoder.receive(initial)
  encoder.encode(prepareChatSnapshot(snapshot([entry("a"), entry("b")])))
  const gap = encoder.encode(prepareChatSnapshot(snapshot([entry("a"), entry("b"), entry("c")])))!
  expect(decoder.receive(gap).kind).toBe("resync")
  expect(decoder.receive(gap).kind).toBe("ignore")
  expect(new ChatStreamDecoder("stream").receive(gap).kind).toBe("resync")
  expect(new ChatStreamDecoder("new-stream").receive(initial).kind).toBe("ignore")
  const recovered = { ...initial, stream: { streamId: "stream", revision: 4 } }
  expect(decoder.receive(recovered).kind).toBe("apply")
  expect(decoder.receive(gap).kind).toBe("ignore")
})

test("history resets, deleted chat and oversized entries fall back to complete snapshots", () => {
  const encoder = new ChatStreamEncoder("stream")
  encoder.encode(prepareChatSnapshot(snapshot([entry("a")])))
  expect(encoder.encode(prepareChatSnapshot(snapshot([], "new-history")))?.type).toBe("snapshot")
  expect(encoder.encode(prepareChatSnapshot(null))?.type).toBe("snapshot")
  expect(encoder.encode(prepareChatSnapshot(null))).toBeNull()
  expect(encoder.encode(prepareChatSnapshot(snapshot([entry("large", "x".repeat(2_100_000))])))?.type).toBe("snapshot")
  expect(encoder.encode(prepareChatSnapshot(snapshot([entry("a")])))?.type).toBe("snapshot")
})

test("malformed deltas cannot publish a partial snapshot", () => {
  const initial = snapshot([entry("a")])
  expect(() => applyChatDelta(initial, { set: {}, upsert: [], order: ["missing"] })).toThrow()
  expect(() => applyChatDelta(initial, { set: {}, upsert: [], order: ["a", "a"] })).toThrow()
  expect(initial.messages).toHaveLength(1)
})
