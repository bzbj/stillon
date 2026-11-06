import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { EventStore } from "./event-store"
import { updateSessionStatistics, type StatisticsInput, type StatisticsRecord } from "../shared/session-statistics"

const stores: EventStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) {
    await store.closeStatistics()
    await rm(store.dataDir, { recursive: true, force: true })
  }
})
async function fixture() {
  let epoch: string | null = "enabled"
  const store = new EventStore(await mkdtemp(path.join(tmpdir(), "stillon-background-statistics-")), () => epoch)
  stores.push(store)
  await store.initialize()
  const project = await store.openProject("/tmp/example-statistics", "Example")
  const chat = await store.createChat(project.id)
  return { store, chat, setEpoch(value: string | null) { epoch = value; store.syncStatisticsSettings() } }
}
const event = (type: string, time: number, data = {}): any => ({ type, time, data: { step: 1, ...data } })
const observations: StatisticsInput[] = [
  { runId: "turn", events: [event("step/start", 100)] },
  { runId: "turn", events: [event("assistant/attempt", 300, { stream: [{ type: "chunk", time: 200, chunk: { type: "text-delta", text: "a" } }, { type: "chunk", time: 300, chunk: { type: "usage", usage: { inputTokens: 5, outputTokens: 2 } } }] }), event("llm/retry-started", 300)] },
  { runId: "turn", events: [event("assistant/message", 600, { stream: [{ type: "chunk", time: 200, chunk: { type: "text-delta", text: "a" } }], usage: { inputTokens: 10, outputTokens: 4 } }), event("step/end", 600)] },
  { runId: "turn", events: [event("tool/call", 610, { callId: "tool" })] },
  { runId: "turn", events: [event("tool/result", 800, { message: { source: { callId: "tool" } } })] },
  { runId: "turn", events: [event("turn/end", 810)] },
]
function deferred() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

test("coalesces ordered retry/tool observations into one checkpoint with identical folds", async () => {
  const { store, chat } = await fixture()
  let expected: StatisticsRecord | undefined
  for (const input of observations) {
    expected = updateSessionStatistics(expected, input)
    store.enqueueStatistics(chat.id, input)
  }
  expect(store.requireChat(chat.id).statisticsState).toBeUndefined()
  await store.flushStatistics()
  expect(store.requireChat(chat.id).statisticsState).toEqual(expected)
  const lines = (await readFile(path.join(store.dataDir, "statistics.jsonl"), "utf8")).trim().split("\n")
  expect(lines).toHaveLength(1)
  expect(JSON.parse(lines[0]).statisticsState).toEqual(expected)
  expect(await readFile(path.join(store.dataDir, "chats.jsonl"), "utf8")).not.toContain("chat_statistics_set")
  await store.compact()
  const restored = new EventStore(store.dataDir, () => "enabled")
  await restored.initialize()
  expect(restored.requireChat(chat.id).statisticsState).toEqual(expected)
  await restored.closeStatistics()
})

test("blocked statistics disk never blocks transcript, turn completion or final publication", async () => {
  const { store, chat } = await fixture()
  const blocked = deferred(), entered = deferred()
  const original = (store as any).appendStatistics.bind(store)
  ;(store as any).appendStatistics = async (payload: string) => { entered.release(); await blocked.promise; await original(payload) }
  for (const input of observations) store.enqueueStatistics(chat.id, input)
  const writing = store.flushStatistics()
  await entered.promise
  try {
    const result = await Promise.race([
      (async () => {
        await store.appendMessage(chat.id, { _id: "visible-text", kind: "assistant_text", createdAt: 1, text: "Still streaming" })
        await store.recordTurnFinished(chat.id)
        return "completed"
      })(),
      Bun.sleep(3000).then(() => "blocked"),
    ])
    expect(result).toBe("completed")
    expect(store.getPublishedStatistics(chat.id)?.tokenUsage.outputTokens).toBe(6)
    expect((await store.getRecentChatHistory(chat.id, 10)).messages).toHaveLength(1)
  } finally { blocked.release(); await writing }
}, 15_000)

test("statistics disk failure marks incomplete and leaves ordinary writes usable", async () => {
  const { store, chat } = await fixture()
  ;(store as any).appendStatistics = async () => { throw Error("synthetic disk failure") }
  store.enqueueStatistics(chat.id, observations[0]!)
  await store.flushStatistics()
  expect(store.shouldCollectStatistics(chat.id)).toBe(false)
  expect(store.requireChat(chat.id).statisticsState?.snapshot.incomplete).toBe(true)
  await store.recordTurnFinished(chat.id)
  await store.appendMessage(chat.id, { _id: "after-failure", kind: "assistant_text", createdAt: 1, text: "Unaffected" })
  expect((await store.getRecentChatHistory(chat.id, 10)).messages).toHaveLength(1)
})

test("disable drops queued inputs and queued appends, reenable excludes old chats", async () => {
  const { store, chat, setEpoch } = await fixture()
  const gate = deferred()
  ;(store as any).statisticsWriteChain = gate.promise
  store.enqueueStatistics(chat.id, observations[0]!)
  const writing = store.flushStatistics()
  store.enqueueStatistics(chat.id, observations[1]!)
  setEpoch(null)
  gate.release()
  await writing
  expect(await readFile(path.join(store.dataDir, "statistics.jsonl"), "utf8")).toBe("")
  expect(store.getPublishedStatistics(chat.id)).toBeNull()
  setEpoch("second-window")
  expect(store.shouldCollectStatistics(chat.id)).toBe(false)
  store.enqueueStatistics(chat.id, observations[2]!)
  const fresh = await store.createChat(chat.projectId)
  expect(store.shouldCollectStatistics(fresh.id)).toBe(true)
  await store.flushStatistics()
  expect(await readFile(path.join(store.dataDir, "statistics.jsonl"), "utf8")).toBe("")
})

test("queue limit stops debug collection instead of blocking or retaining arbitrary payloads", async () => {
  const { store, chat } = await fixture()
  for (let i = 0; i < 4097; i++) store.enqueueStatistics(chat.id, { runId: "overflow", events: [] })
  expect(store.shouldCollectStatistics(chat.id)).toBe(false)
  expect((store as any).statisticsInputs).toHaveLength(0)
  expect(store.requireChat(chat.id).statisticsState?.snapshot.incomplete).toBe(true)
  await store.recordTurnCancelled(chat.id)
})

test("background publication waits ten seconds despite persistence and ordinary state changes", async () => {
  const { store, chat } = await fixture()
  const published: number[] = []
  store.setStatisticsListener(() => published.push(Date.now()))
  const started = Date.now()
  for (const input of observations) store.enqueueStatistics(chat.id, input)
  await store.flushStatistics()
  expect(store.getPublishedStatistics(chat.id)).toBeNull()
  await store.renameChat(chat.id, "Ordinary update")
  expect(store.getPublishedStatistics(chat.id)).toBeNull()
  await Bun.sleep(10_200)
  expect(published).toHaveLength(1)
  expect(published[0]! - started).toBeGreaterThanOrEqual(10_000)
  expect(store.getPublishedStatistics(chat.id)?.tokenUsage.outputTokens).toBe(6)
  store.enqueueStatistics(chat.id, { runId: "next", usageOnly: true, events: [event("assistant/message", 1000, { usage: { inputTokens: 1, outputTokens: 2 }, stream: [] })] })
  await store.recordTurnFinished(chat.id)
  expect(published).toHaveLength(2)
  expect(store.getPublishedStatistics(chat.id)?.tokenUsage.outputTokens).toBe(8)
}, 30_000)

test("orderly close persists the last pending batch without waiting for the interval", async () => {
  const { store, chat } = await fixture()
  for (const input of observations) store.enqueueStatistics(chat.id, input)
  await store.closeStatistics()
  const restored = new EventStore(store.dataDir, () => "enabled")
  await restored.initialize()
  expect(restored.requireChat(chat.id).statisticsState?.snapshot.tokenUsage.outputTokens).toBe(6)
  await restored.closeStatistics()
})

test("one background append checkpoints multiple chats and survives uncompacted restart", async () => {
  const { store, chat } = await fixture()
  const second = await store.createChat(chat.projectId)
  let appends = 0
  const original = (store as any).appendStatistics.bind(store)
  ;(store as any).appendStatistics = async (payload: string) => { appends++; await original(payload) }
  for (const id of [chat.id, second.id]) for (const input of observations) store.enqueueStatistics(id, input)
  await store.flushStatistics()
  expect(appends).toBe(1)
  const restored = new EventStore(store.dataDir, () => "enabled")
  await restored.initialize()
  for (const id of [chat.id, second.id]) expect(restored.requireChat(id).statisticsState).toEqual(store.requireChat(id).statisticsState)
  await restored.closeStatistics()
})

test("compaction serializes statistics log rotation with appends arriving during rotation", async () => {
  const { store, chat } = await fixture()
  store.enqueueStatistics(chat.id, observations[0]!)
  await store.flushStatistics()
  const blocked = deferred(), entered = deferred()
  const original = (store as any).copyFileAtomically.bind(store)
  ;(store as any).copyFileAtomically = async (...args: any[]) => { entered.release(); await blocked.promise; return original(...args) }
  const compacting = store.compact()
  await entered.promise
  for (const input of observations.slice(1)) store.enqueueStatistics(chat.id, input)
  const writing = store.flushStatistics()
  blocked.release()
  await Promise.all([compacting, writing])
  const restored = new EventStore(store.dataDir, () => "enabled")
  await restored.initialize()
  expect(restored.requireChat(chat.id).statisticsState).toEqual(store.requireChat(chat.id).statisticsState)
  await restored.closeStatistics()
})

test("background checkpoint recovery falls back to the archived statistics journal", async () => {
  const { store, chat } = await fixture()
  for (const input of observations) store.enqueueStatistics(chat.id, input)
  await store.flushStatistics()
  await store.compact()
  store.enqueueStatistics(chat.id, { runId: "second", usageOnly: true, events: [event("assistant/message", 1000, { usage: { inputTokens: 1, outputTokens: 3 }, stream: [] })] })
  await store.flushStatistics()
  await store.compact()
  const { writeFile } = await import("node:fs/promises")
  await writeFile(path.join(store.dataDir, "snapshot.json"), "invalid snapshot")
  const restored = new EventStore(store.dataDir, () => "enabled")
  await restored.initialize()
  expect(restored.requireChat(chat.id).statisticsState?.snapshot.tokenUsage.outputTokens).toBe(9)
  await restored.closeStatistics()
})

test("coordinator consumes text and finishes while an earlier statistics append is blocked", async () => {
  const { AgentCoordinator } = await import("./agent")
  const { store, chat } = await fixture()
  const blocked = deferred(), entered = deferred(), finished = deferred()
  const original = (store as any).appendStatistics.bind(store)
  ;(store as any).appendStatistics = async (payload: string) => { entered.release(); await blocked.promise; await original(payload) }
  const coordinator = new AgentCoordinator({
    store,
    onStateChange: () => { if (store.getChat(chat.id)?.lastTurnOutcome === "success") finished.release() },
    generateTitle: async () => ({ title: "Synthetic chat", usedFallback: false, failureMessage: null }),
    codexManager: {
      async startSession() { return "synthetic-thread" },
      async startTurn() {
        return { provider: "codex", interrupt: async () => {}, close: () => {}, stream: (async function* () {
          yield { type: "statistics", statistics: observations[0]! }
          void store.flushStatistics()
          await entered.promise
          yield { type: "transcript", entry: { _id: "streamed", createdAt: 1, kind: "assistant_text", text: "Visible while statistics storage is blocked" } }
          yield { type: "transcript", entry: { _id: "result", createdAt: 2, kind: "result", subtype: "success", isError: false, durationMs: 0, result: "" } }
        })() }
      },
      async stopAll() {},
    } as never,
  })
  try {
    await coordinator.send({ type: "chat.send", chatId: chat.id, provider: "codex", content: "Synthetic prompt" })
    expect(await Promise.race([finished.promise.then(() => "finished"), Bun.sleep(5000).then(() => "blocked")])).toBe("finished")
    expect((await store.getRecentChatHistory(chat.id, 10)).messages.some(entry => entry.kind === "assistant_text")).toBe(true)
  } finally {
    blocked.release()
    await coordinator.shutdown()
  }
}, 20_000)

test("a late statistics failure after disabling cannot publish a new statistics view", async () => {
  const { store, chat, setEpoch } = await fixture()
  const blocked = deferred(), entered = deferred()
  let publications = 0
  store.setStatisticsListener(() => { publications++ })
  ;(store as any).appendStatistics = async () => { entered.release(); await blocked.promise; throw Error("late failure") }
  store.enqueueStatistics(chat.id, observations[0]!)
  const writing = store.flushStatistics()
  await entered.promise
  setEpoch(null)
  blocked.release()
  await writing
  expect(publications).toBe(0)
  expect(store.getPublishedStatistics(chat.id)).toBeNull()
})
