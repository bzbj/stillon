import { expect, test } from "bun:test"
import { createEmptyState } from "./events"
import { createWsRouter, type ClientState } from "./ws-router"
import { ChatStreamDecoder, type ChatStreamFrame } from "../shared/chat-stream"
import type { ChatSnapshot, TranscriptEntry } from "../shared/types"

function fixture() {
  const state = createEmptyState()
  state.projectsById.set("project", { id: "project", localPath: "/example/project", title: "Example", createdAt: 1, updatedAt: 1 })
  state.chatsById.set("chat", { id: "chat", projectId: "project", title: "Chat", createdAt: 1, updatedAt: 1,
    unread: false, provider: null, planMode: false, sessionToken: null, lastTurnOutcome: null })
  let messages: TranscriptEntry[] = [{ _id: "a", kind: "assistant_text", text: "original", createdAt: 1 }]
  let revision = "history-1"
  let gate: Promise<void> | null = null
  let reads = 0
  const router = createWsRouter({ store: { state, getRecentChatHistory: async () => {
    reads++
    await gate
    return { messages: JSON.parse(JSON.stringify(messages)),
      history: { hasOlder: true, olderCursor: "older", recentLimit: 40, revision } }
  } } as never,
    agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set() } as never,
    terminals: { onEvent: () => () => {} } as never,
    keybindings: { onChange: () => () => {}, getSnapshot: () => ({}) } as never,
    refreshDiscovery: async () => [], getDiscoveredProjects: () => [], machineDisplayName: "Example" })
  const socket = () => ({ data: { subscriptions: new Map(), snapshotSignatures: new Map() } as ClientState,
    frames: [] as any[], send(raw: string) { this.frames.push(JSON.parse(raw)); return raw.length } })
  async function subscribe(ws: ReturnType<typeof socket>, streamId?: string) {
    router.handleOpen(ws as never)
    await router.handleMessage(ws as never, JSON.stringify({ v: 1, type: "subscribe", id: "chat",
      topic: { type: "chat", chatId: "chat", ...(streamId ? { streamVersion: 1, streamId } : {}) } }))
  }
  return { router, state, socket, subscribe, setMessages: (value: TranscriptEntry[]) => { messages = value },
    setRevision: (value: string) => { revision = value }, setGate: (value: Promise<void> | null) => { gate = value }, reads: () => reads }
}
function decode(decoder: ChatStreamDecoder, envelope: any) {
  const frame: ChatStreamFrame = envelope.type === "snapshot" ? { type: "snapshot", stream: envelope.stream, data: envelope.snapshot.data } : envelope
  return decoder.receive(frame)
}

test("negotiated deltas and legacy snapshots converge across clients, pagination and history resets", async () => {
  const f = fixture()
  try {
    const modern = f.socket(), second = f.socket(), legacy = f.socket()
    await f.subscribe(modern, "one"); await f.subscribe(second, "two"); await f.subscribe(legacy)
    const decoder = new ChatStreamDecoder("one")
    decode(decoder, modern.frames[0])
    f.setMessages([{ _id: "a", kind: "assistant_text", text: "replacement", createdAt: 1 },
      { _id: "b", kind: "assistant_text", text: "appended", createdAt: 2 }])
    const before = f.reads()
    await f.router.broadcastSnapshots()
    expect(f.reads() - before).toBe(1)
    expect(modern.frames.at(-1).type).toBe("chat-delta")
    expect(second.frames.at(-1).stream.streamId).toBe("two")
    expect(legacy.frames.at(-1).type).toBe("snapshot")
    const merged = decode(decoder, modern.frames.at(-1))
    expect(merged).toEqual({ kind: "apply", snapshot: legacy.frames.at(-1).snapshot.data })
    if (merged.kind !== "apply" || !merged.snapshot) throw new Error("No snapshot")
    expect(merged.snapshot.history.olderCursor).toBe("older")
    const messages = merged.snapshot.messages
    f.state.chatsById.get("chat")!.title = "New title"
    await f.router.broadcastSnapshots()
    const runtime = decode(decoder, modern.frames.at(-1))
    if (runtime.kind !== "apply") throw new Error("No runtime")
    expect(runtime.snapshot?.messages).toBe(messages)
    f.setRevision("reset"); f.setMessages([])
    await f.router.broadcastSnapshots()
    expect(modern.frames.at(-1).type).toBe("snapshot")
    expect((decode(decoder, modern.frames.at(-1)) as { snapshot: ChatSnapshot }).snapshot.messages).toEqual([])
    await f.subscribe(modern, "resync")
    expect(modern.frames.at(-1).stream).toEqual({ streamId: "resync", revision: 1 })
    await f.router.handleMessage(modern as never, JSON.stringify({ v: 1, type: "unsubscribe", id: "chat" }))
    expect(modern.data.chatStreams?.size).toBe(0)
  } finally { f.router.dispose() }
})

test("concurrent broadcasts coalesce and unsubscribe cancels an in-flight snapshot", async () => {
  const f = fixture()
  try {
    const ws = f.socket()
    await f.subscribe(ws, "one")
    let release!: () => void
    f.setGate(new Promise<void>((resolve) => { release = resolve }))
    f.setMessages([{ _id: "b", kind: "assistant_text", text: "new", createdAt: 2 }])
    const before = f.reads()
    const first = f.router.broadcastSnapshots()
    const pending = Array.from({ length: 10 }, () => f.router.broadcastSnapshots())
    release()
    await Promise.all([first, ...pending])
    expect(f.reads() - before).toBeLessThanOrEqual(2)
    expect(ws.frames.map((frame) => frame.stream?.revision)).toEqual([1, 2])
    f.setGate(new Promise<void>((resolve) => { release = resolve }))
    const inFlight = f.router.broadcastSnapshots()
    await f.router.handleMessage(ws as never, JSON.stringify({ v: 1, type: "unsubscribe", id: "chat" }))
    const count = ws.frames.length
    release(); await inFlight
    expect(ws.frames.length).toBe(count)
  } finally { f.router.dispose() }
})

test("only four subscriptions retain delta windows; extra subscriptions retain legacy compatibility", async () => {
  const f = fixture()
  try {
    const ws = f.socket()
    f.router.handleOpen(ws as never)
    for (let i = 0; i < 5; i++) await f.router.handleMessage(ws as never, JSON.stringify({ v: 1,
      type: "subscribe", id: `subscription-${i}`, topic: { type: "chat", chatId: "chat", streamVersion: 1, streamId: `stream-${i}` } }))
    expect(ws.data.chatStreams?.size).toBe(4)
    const fallback = ws.frames.find((frame) => frame.id === "subscription-4")
    expect(fallback.type).toBe("snapshot")
    expect(fallback.stream).toBeUndefined()
    f.router.handleClose(ws as never)
    expect(ws.data.chatStreams?.size).toBe(0)
    expect(ws.data.subscriptions.size).toBe(0)
  } finally { f.router.dispose() }
})
