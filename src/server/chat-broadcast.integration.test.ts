import { expect, test } from "bun:test"
import { ChatStreamDecoder, type ChatStreamFrame } from "../shared/chat-stream"
import type { ServerEnvelope } from "../shared/protocol"
import type { TranscriptEntry } from "../shared/types"
import { createEmptyState } from "./events"
import { createWsRouter, type ClientState } from "./ws-router"

function messagesThrough(generation: number): TranscriptEntry[] {
  return Array.from({ length: generation + 1 }, (_, index) => ({
    _id: `user-${index}`, kind: "user_prompt", content: `Synthetic prompt ${index}`,
    attachments: [], createdAt: index + 1,
  }))
}

function fixture() {
  const state = createEmptyState()
  state.projectsById.set("project", {
    id: "project", localPath: "/example/project", title: "Example", createdAt: 1, updatedAt: 1,
  })
  state.chatsById.set("chat", {
    id: "chat", projectId: "project", title: "Chat", createdAt: 1, updatedAt: 1,
    unread: false, provider: null, planMode: false, sessionToken: null, lastTurnOutcome: null,
  })
  let generation = 0
  let paused = false
  let releases: (() => void)[] = []
  const router = createWsRouter({
    store: { state, getRecentChatHistory: async () => {
      // Capture BEFORE blocking to model an older read that completes late.
      const messages = messagesThrough(generation)
      if (paused) await new Promise<void>((resolve) => { releases.push(resolve) })
      return { messages, history: { hasOlder: false, olderCursor: null, recentLimit: 40, revision: "history" } }
    } } as never,
    agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set() } as never,
    terminals: { onEvent: () => () => {} } as never,
    keybindings: { onChange: () => () => {}, getSnapshot: () => ({}) } as never,
    refreshDiscovery: async () => [], getDiscoveredProjects: () => [], machineDisplayName: "Example",
  })
  function socket() {
    const ws = {
      data: { subscriptions: new Map(), snapshotSignatures: new Map() } as ClientState,
      frames: [] as ServerEnvelope[],
      send(raw: string) { this.frames.push(JSON.parse(raw)); return raw.length },
    }
    router.handleOpen(ws as never)
    return ws
  }
  function subscribe(ws: ReturnType<typeof socket>, streamId?: string, id = "chat") {
    return router.handleMessage(ws as never, JSON.stringify({
      v: 1, type: "subscribe", id,
      topic: { type: "chat", chatId: "chat", ...(streamId ? { streamVersion: 1, streamId } : {}) },
    }))
  }
  function releaseReads() {
    const pending = releases
    releases = []
    for (const release of pending) release()
  }
  return {
    router, socket, subscribe, releaseReads,
    setGeneration: (value: number) => { generation = value },
    pauseReads: (value: boolean) => { paused = value },
    pendingReads: () => releases.length,
    async finish(operations: Promise<void>[]) {
      paused = false
      releaseReads()
      await Promise.allSettled(operations)
      router.dispose()
    },
  }
}

function decodedIds(frames: ServerEnvelope[], streamId?: string, id = "chat") {
  const decoder = new ChatStreamDecoder(streamId ?? "legacy")
  const snapshots: string[][] = []
  for (const envelope of frames) {
    if (envelope.id !== id) continue
    let frame: ChatStreamFrame
    if (envelope.type === "snapshot" && envelope.snapshot.type === "chat") {
      if (!envelope.stream) {
        snapshots.push(envelope.snapshot.data!.messages.map((entry) => entry._id))
        continue
      }
      frame = { type: "snapshot", stream: envelope.stream, data: envelope.snapshot.data }
    } else if (envelope.type === "chat-delta") frame = envelope
    else continue
    const result = decoder.receive(frame)
    expect(result.kind).toBe("apply")
    if (result.kind === "apply") snapshots.push(result.snapshot!.messages.map((entry) => entry._id))
  }
  return snapshots
}

// Let released reads and their promise continuations run to the next event-loop
// turn. Remaining reads stay behind explicit barriers, without timing guesses.
const checkpoint = () => new Promise<void>((resolve) => { setImmediate(resolve) })

for (const streamId of [undefined, "stream"]) {
  const protocol = streamId ? "deltas" : "legacy snapshots"
  for (const filtered of [false, true]) {
    const scope = filtered ? "chat broadcast" : "full broadcast"
    const broadcast = (f: ReturnType<typeof fixture>) => filtered
      ? f.router.broadcastChatStateImmediately("chat") : f.router.broadcastSnapshots()

    test(`${scope}: sustained refreshes reach every client with ${protocol}`, async () => {
      const f = fixture()
      const operations: Promise<void>[] = []
      try {
        const first = f.socket(), second = f.socket()
        await f.subscribe(first, streamId)
        await f.subscribe(second, streamId)
        f.setGeneration(1)
        f.pauseReads(true)
        operations.push(broadcast(f))
        for (let generation = 2; generation <= 4; generation++) {
          // Keep a follow-up read pending while checking delivery of this one.
          f.setGeneration(generation)
          operations.push(broadcast(f))
          expect(f.pendingReads()).toBeGreaterThan(0)
          f.releaseReads()
          await checkpoint()
          expect(f.pendingReads()).toBeGreaterThan(0)
          const expected = messagesThrough(generation - 1).map((entry) => entry._id)
          expect(decodedIds(first.frames, streamId).at(-1)).toEqual(expected)
          expect(decodedIds(second.frames, streamId).at(-1)).toEqual(expected)
        }
      } finally { await f.finish(operations) }
    })

    test(`${scope}: a joining client keeps its newer messages with ${protocol}`, async () => {
      const f = fixture()
      const operations: Promise<void>[] = []
      try {
        const first = f.socket()
        await f.subscribe(first, streamId)
        f.pauseReads(true)
        operations.push(broadcast(f))
        expect(f.pendingReads()).toBe(1)
        f.setGeneration(1)
        f.pauseReads(false)
        const arriving = f.socket()
        await f.subscribe(arriving, streamId)
        f.releaseReads()
        await Promise.all(operations)
        expect(decodedIds(arriving.frames, streamId)).toEqual([["user-0", "user-1"]])
      } finally { await f.finish(operations) }
    })

    test(`${scope}: resubscription cannot reuse an older broadcast cache with ${protocol}`, async () => {
      const f = fixture()
      const operations: Promise<void>[] = []
      try {
        const first = f.socket(), second = f.socket()
        await f.subscribe(first, streamId)
        await f.subscribe(second, streamId)
        f.pauseReads(true)
        operations.push(broadcast(f))
        f.setGeneration(1)
        f.pauseReads(false)
        const before = second.frames.length
        const newStream = streamId ? "resubscribed" : undefined
        operations.push(f.subscribe(second, newStream))
        f.releaseReads()
        await Promise.all(operations)
        expect(decodedIds(second.frames.slice(before), newStream)).toEqual([["user-0", "user-1"]])
      } finally { await f.finish(operations) }
    })
  }

  test(`late reads cannot roll back a connection using ${protocol}`, async () => {
    const f = fixture()
    const operations: Promise<void>[] = []
    try {
      const ws = f.socket()
      await f.subscribe(ws, streamId)
      f.setGeneration(1)
      f.pauseReads(true)
      operations.push(f.router.broadcastSnapshots())
      f.setGeneration(2)
      f.pauseReads(false)
      operations.push(f.router.broadcastSnapshots())
      f.releaseReads()
      await Promise.all(operations)
      expect(decodedIds(ws.frames, streamId)).toEqual([
        ["user-0"], ["user-0", "user-1"], ["user-0", "user-1", "user-2"],
      ])
    } finally { await f.finish(operations) }
  })

  test(`a new subscription waits for a fresh read with ${protocol}`, async () => {
    const f = fixture()
    const operations: Promise<void>[] = []
    try {
      const ws = f.socket()
      await f.subscribe(ws, streamId)
      f.pauseReads(true)
      operations.push(f.router.broadcastSnapshots())
      f.setGeneration(1)
      f.pauseReads(false)
      operations.push(f.subscribe(ws, streamId, "new-subscription"))
      f.releaseReads()
      await Promise.all(operations)
      expect(decodedIds(ws.frames, streamId, "new-subscription")).toEqual([["user-0", "user-1"]])
    } finally { await f.finish(operations) }
  })
}
