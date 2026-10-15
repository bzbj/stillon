import { BUNDLED_CODEX_MODEL_POLICY } from "../../shared/codex-model-policy"
import { applyCodexModelPolicy, normalizeCodexModelId, getCodexModelForRole } from "../../shared/types"
import { useCodexModelPolicyStore } from "../stores/codexModelPolicyStore"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { StillOnSocket } from "./socket"

type EventHandler = (event?: unknown) => void

class FakeEventTarget {
  private readonly listeners = new Map<string, Set<EventHandler>>()

  addEventListener(type: string, listener: EventHandler) {
    let handlers = this.listeners.get(type)
    if (!handlers) {
      handlers = new Set()
      this.listeners.set(type, handlers)
    }
    handlers.add(listener)
  }

  removeEventListener(type: string, listener: EventHandler) {
    this.listeners.get(type)?.delete(listener)
  }

  dispatchEvent(type: string, event?: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event)
    }
  }
}

class FakeTimers {
  private nextId = 1
  readonly timeouts = new Map<number, () => void>()
  readonly intervals = new Map<number, () => void>()

  setTimeout = (callback: () => void) => {
    const id = this.nextId++
    this.timeouts.set(id, callback)
    return id
  }

  clearTimeout = (id: number) => {
    this.timeouts.delete(id)
  }

  setInterval = (callback: () => void) => {
    const id = this.nextId++
    this.intervals.set(id, callback)
    return id
  }

  clearInterval = (id: number) => {
    this.intervals.delete(id)
  }

  runTimeout(id: number) {
    const callback = this.timeouts.get(id)
    if (!callback) return
    this.timeouts.delete(id)
    callback()
  }

  runInterval(id: number) {
    this.intervals.get(id)?.()
  }
}

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readonly sent: Array<Record<string, unknown>> = []
  private readonly listeners = new Map<string, Set<EventHandler>>()
  readyState = FakeWebSocket.CONNECTING

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, listener: EventHandler) {
    let handlers = this.listeners.get(type)
    if (!handlers) {
      handlers = new Set()
      this.listeners.set(type, handlers)
    }
    handlers.add(listener)
  }

  send(message: string) {
    this.sent.push(JSON.parse(message))
  }

  open() {
    this.readyState = FakeWebSocket.OPEN
    this.emit("open")
  }

  receive(message: Record<string, unknown>) {
    this.emit("message", { data: JSON.stringify(message) })
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    this.emit("close")
  }

  private emit(type: string, event?: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event)
    }
  }
}

function setGlobalProperty(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  })
}

function restoreGlobalProperty(name: string, descriptor: PropertyDescriptor | undefined) {
  if (descriptor) {
    Object.defineProperty(globalThis, name, descriptor)
  } else {
    Reflect.deleteProperty(globalThis, name)
  }
}

describe("StillOnSocket", () => {
  const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window")
  const originalDocumentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document")
  const originalWebSocketDescriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket")

  let windowTarget: FakeEventTarget
  let documentTarget: FakeEventTarget & { visibilityState: "visible" | "hidden" }
  let timers: FakeTimers

  beforeEach(() => {
    FakeWebSocket.instances = []
    timers = new FakeTimers()
    windowTarget = new FakeEventTarget()
    documentTarget = Object.assign(new FakeEventTarget(), { visibilityState: "visible" as const })

    setGlobalProperty("window", Object.assign(windowTarget, {
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      location: { protocol: "http:", host: "localhost:3211" },
    }))
    setGlobalProperty("document", documentTarget)
    setGlobalProperty("WebSocket", FakeWebSocket)
  })

  afterEach(() => {
    applyCodexModelPolicy(BUNDLED_CODEX_MODEL_POLICY)
    useCodexModelPolicyStore.setState({ snapshot: null })
    restoreGlobalProperty("window", originalWindowDescriptor)
    restoreGlobalProperty("document", originalDocumentDescriptor)
    restoreGlobalProperty("WebSocket", originalWebSocketDescriptor)
  })

  test("installs server policy before first settings callback and updates again on reconnect", () => {
    const socket = new StillOnSocket("ws://localhost/ws")
    const seen: string[] = []
    socket.subscribe({ type: "app-settings" }, () => seen.push(normalizeCodexModelId("gpt-6.1-sol")))
    socket.start()
    const ws = FakeWebSocket.instances[0]!
    ws.open()
    const subscription = ws.sent.find((entry) => entry.type === "subscribe")!
    const policy = { models: [{ id: "next-codex", label: "Next Codex", aliases: ["gpt-6.1-sol"],
      supportsEffort: true, supportedReasoningEfforts: ["high"], supportsFastMode: false }],
      roles: { conversation: "next-codex", background: "next-codex" } }
    ws.receive({ v: 1, type: "snapshot", id: subscription.id,
      codexModelPolicy: { schemaVersion: 1, revision: "next", policy, source: "local", filePath: "/models.json", warning: null, canRestore: true },
      snapshot: { type: "app-settings", data: {} } })
    expect(seen).toEqual(["next-codex"])
    expect(getCodexModelForRole("background")).toBe("next-codex")
    ws.close()
    for (const id of [...timers.timeouts.keys()]) timers.runTimeout(id)
    const reconnected = FakeWebSocket.instances.at(-1)!
    reconnected.open()
    reconnected.receive({ v: 1, type: "snapshot", id: subscription.id,
      codexModelPolicy: { schemaVersion: 1, revision: "bundled", policy: BUNDLED_CODEX_MODEL_POLICY,
        source: "builtin", filePath: "/models.json", warning: null, canRestore: true },
      snapshot: { type: "app-settings", data: {} } })
    expect(seen).toEqual(["next-codex", "gpt-6.1-sol"])
    socket.dispose()
  })

  test("negotiates deltas, resynchronizes once on a gap, rejects old epochs and accepts legacy servers", () => {
    const socket = new StillOnSocket("ws://localhost/ws")
    const seen: any[] = []
    socket.subscribe({ type: "chat", chatId: "chat" }, (value) => seen.push(value))
    socket.start()
    const ws = FakeWebSocket.instances[0]!
    ws.open()
    const subscriptions = ws.sent.filter((entry) => entry.type === "subscribe")
    expect(subscriptions).toHaveLength(1)
    const subscription = subscriptions[0] as any
    expect(subscription.topic.streamVersion).toBe(1)
    const stream = { streamId: subscription.topic.streamId, revision: 1 }
    const snapshot = { messages: [{ _id: "a", kind: "assistant_text", text: "a", createdAt: 1 }],
      runtime: { chatId: "chat", title: "Chat" }, history: { revision: "history" },
      queuedMessages: [], availableProviders: [], asyncQuestionResponses: [] }
    ws.receive({ v: 1, type: "snapshot", id: subscription.id, stream, snapshot: { type: "chat", data: snapshot } })
    const delta = { v: 1, type: "chat-delta", id: subscription.id, stream: { ...stream, revision: 2 }, baseRevision: 1,
      delta: { set: {}, upsert: [{ ...snapshot.messages[0], text: "replaced" }] } }
    ws.receive(delta)
    expect(seen.at(-1).messages[0].text).toBe("replaced")
    ws.receive(delta)
    expect(seen).toHaveLength(2)
    const gap = { ...delta, stream: { ...stream, revision: 4 }, baseRevision: 3 }
    ws.receive(gap); ws.receive(gap)
    expect(ws.sent.filter((entry) => entry.type === "subscribe")).toHaveLength(2)
    const resync = ws.sent.at(-1) as any
    expect(resync.topic.streamId).not.toBe(stream.streamId)
    ws.receive({ v: 1, type: "snapshot", id: subscription.id, stream, snapshot: { type: "chat", data: snapshot } })
    expect(seen).toHaveLength(2)
    ws.receive({ v: 1, type: "snapshot", id: subscription.id,
      stream: { streamId: resync.topic.streamId, revision: 1 }, snapshot: { type: "chat", data: snapshot } })
    expect(seen).toHaveLength(3)
    ws.close()
    for (const id of [...timers.timeouts.keys()]) timers.runTimeout(id)
    const next = FakeWebSocket.instances.at(-1)!
    next.open()
    expect((next.sent[0] as any).topic.streamId).not.toBe(resync.topic.streamId)
    next.receive({ v: 1, type: "snapshot", id: subscription.id, snapshot: { type: "chat", data: snapshot } })
    expect(seen).toHaveLength(4)
    socket.dispose()
  })

  test("does not ping when the connection is already fresh", async () => {
    const socket = new StillOnSocket("ws://localhost/ws")
    socket.start()
    const ws = FakeWebSocket.instances[0]!
    ws.open()

    await socket.ensureHealthyConnection()

    expect(ws.sent).toHaveLength(0)
    socket.dispose()
  })

  test("pings a stale open connection and resolves when acked", async () => {
    const socket = new StillOnSocket("ws://localhost/ws")
    socket.start()
    const ws = FakeWebSocket.instances[0]!
    ws.open()
    ;(socket as any).lastOpenAt = Date.now() - 30_000
    ;(socket as any).lastMessageAt = Date.now() - 30_000

    const healthCheck = socket.ensureHealthyConnection()
    const ping = ws.sent[0]

    expect(ping?.type).toBe("command")
    expect(ping?.command).toEqual({ type: "system.ping" })

    ws.receive({ v: 1, type: "ack", id: ping?.id })
    await healthCheck

    expect(FakeWebSocket.instances).toHaveLength(1)
    socket.dispose()
  })

  test("reconnects immediately when a stale ping times out", async () => {
    const socket = new StillOnSocket("ws://localhost/ws")
    socket.start()
    const firstWs = FakeWebSocket.instances[0]!
    firstWs.open()
    ;(socket as any).lastOpenAt = Date.now() - 30_000
    ;(socket as any).lastMessageAt = Date.now() - 30_000

    const healthCheck = socket.ensureHealthyConnection()
    timers.runTimeout((socket as any).pingTimeoutTimer)

    await expect(healthCheck).rejects.toThrow("Disconnected")
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(FakeWebSocket.instances[1]?.readyState).toBe(FakeWebSocket.CONNECTING)
    socket.dispose()
  })

  test("runs health checks on focus, visibility restore, and online", async () => {
    const socket = new StillOnSocket("ws://localhost/ws")
    socket.start()
    const ws = FakeWebSocket.instances[0]!
    ws.open()

    ;(socket as any).lastOpenAt = Date.now() - 30_000
    ;(socket as any).lastMessageAt = Date.now() - 30_000
    windowTarget.dispatchEvent("focus")
    let ping = ws.sent.pop()
    ws.receive({ v: 1, type: "ack", id: ping?.id })
    await Promise.resolve()

    documentTarget.visibilityState = "hidden"
    documentTarget.dispatchEvent("visibilitychange")
    ;(socket as any).lastOpenAt = Date.now() - 30_000
    ;(socket as any).lastMessageAt = Date.now() - 30_000
    documentTarget.visibilityState = "visible"
    documentTarget.dispatchEvent("visibilitychange")
    ping = ws.sent.pop()
    ws.receive({ v: 1, type: "ack", id: ping?.id })
    await Promise.resolve()

    ;(socket as any).lastOpenAt = Date.now() - 30_000
    ;(socket as any).lastMessageAt = Date.now() - 30_000
    windowTarget.dispatchEvent("online")
    ping = ws.sent.pop()

    expect(ping?.command).toEqual({ type: "system.ping" })
    ws.receive({ v: 1, type: "ack", id: ping?.id })
    await Promise.resolve()
    socket.dispose()
  })

  test("keeps queued commands and flushes them once the socket opens", async () => {
    const socket = new StillOnSocket("ws://localhost/ws")
    socket.start()
    const ws = FakeWebSocket.instances[0]!
    const pingPromise = socket.command({ type: "system.ping" })

    expect(ws.sent).toHaveLength(0)

    ws.open()
    const ping = ws.sent[0]
    ws.receive({ v: 1, type: "ack", id: ping?.id })

    await expect(pingPromise).resolves.toBeUndefined()
    expect(ws.sent).toHaveLength(1)
    socket.dispose()
  })

  test("sends heartbeat checks while visible", async () => {
    const socket = new StillOnSocket("ws://localhost/ws")
    socket.start()
    const ws = FakeWebSocket.instances[0]!
    ws.open()
    ;(socket as any).lastOpenAt = Date.now() - 30_000
    ;(socket as any).lastMessageAt = Date.now() - 30_000

    timers.runInterval((socket as any).heartbeatTimer)

    expect(ws.sent[0]?.command).toEqual({ type: "system.ping" })
    ws.receive({ v: 1, type: "ack", id: ws.sent[0]?.id })
    await Promise.resolve()
    socket.dispose()
  })
  test("answer-only cancellation removes an unsent command before reconnect flush", async () => {
    const socket = new StillOnSocket("ws://localhost/ws")
    socket.start()
    const abort = new AbortController()
    const answer = socket.command({ type: "chat.answerAsyncQuestion", chatId: "chat", questionKey: "key", submissionId: "id", answers: [{ index: 0, value: "synthetic" }] }, { signal: abort.signal })
    abort.abort()
    await expect(answer).rejects.toThrow("Command cancelled")
    FakeWebSocket.instances[0]!.open()
    expect(FakeWebSocket.instances[0]!.sent).toHaveLength(0)
    socket.dispose()
  })
  test("cancelling an already sent answer never replays it after reconnect", async () => {
    const socket = new StillOnSocket("ws://localhost/ws")
    socket.start()
    const ws = FakeWebSocket.instances[0]!
    ws.open()
    const abort = new AbortController()
    const answer = socket.command({ type: "chat.answerAsyncQuestion", chatId: "chat", questionKey: "key", submissionId: "id", answers: [] }, { signal: abort.signal })
    abort.abort()
    await expect(answer).rejects.toThrow("Command cancelled")
    ws.close()
    await socket.ensureHealthyConnection()
    FakeWebSocket.instances[1]!.open()
    expect(ws.sent).toHaveLength(1)
    expect(FakeWebSocket.instances[1]!.sent).toHaveLength(0)
    socket.dispose()
  })

  test("an unsent answer remains cancellable after a failed connection attempt", async () => {
    const socket = new StillOnSocket("ws://localhost/ws")
    socket.start()
    const abort = new AbortController()
    const answer = socket.command({ type: "chat.answerAsyncQuestion", chatId: "chat", questionKey: "key", submissionId: "id", answers: [] }, { signal: abort.signal })
    FakeWebSocket.instances[0]!.close()
    await expect(answer).rejects.toThrow("Disconnected")
    abort.abort()
    await socket.ensureHealthyConnection()
    FakeWebSocket.instances[1]!.open()
    expect(FakeWebSocket.instances[1]!.sent).toHaveLength(0)
    socket.dispose()
  })

})
