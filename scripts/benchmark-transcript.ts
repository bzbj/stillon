import { ChatStreamDecoder } from "../src/shared/chat-stream"
/** Deterministic router + client reconciliation replay. No live provider data or inference. */
import type { ClientState } from "../src/server/ws-router"
const currentRouter = await import("../src/server/ws-router")
const baselineRouter = process.argv.includes("--baseline") || process.argv.includes("--compare")
  ? await import("../src/server/" + "ws-router.benchmark-baseline") : currentRouter
import { createEmptyState } from "../src/server/events"
import { createTranscriptProcessor, processTranscriptMessages } from "../src/client/lib/parseTranscript"
import type { ChatSnapshot, TranscriptEntry } from "../src/shared/types"

const modes = process.argv.includes("--compare") ? [false, true] : [process.argv.includes("--delta")]
const fixtureDirectory = process.argv.find((arg) => arg.startsWith("--fixtures="))?.slice("--fixtures=".length)
const repeats = 3
const frames = 60
const results: unknown[] = []
for (const scenario of [
  { name: "short", rows: 12, textBytes: 128, olderRows: 0 },
  { name: "long", rows: 40, textBytes: 10_000, olderRows: 1000 },
  { name: "large-tool-sized-text", rows: 4, textBytes: 80_000, olderRows: 1000 },
]) for (const clients of [1, 3]) {
  const byMode = new Map(modes.map((mode) => [mode, [] as Array<Record<string, number>>]))
  for (let repeat = 0; repeat < repeats; repeat++) for (const deltaMode of (repeat % 2 ? [...modes].reverse() : modes)) {
    const { createWsRouter } = deltaMode ? currentRouter : baselineRouter
    const samples = byMode.get(deltaMode)!
    const entry = (i: number): TranscriptEntry => ({ _id: `entry-${i}`, kind: "assistant_text", createdAt: i + 1,
      text: (`Fixture ${i}: ` + "sample text ".repeat(Math.ceil(scenario.textBytes / 12))).slice(0, scenario.textBytes) })
    let entries = Array.from({ length: scenario.rows }, (_, i) => entry(i))
    let serialized = JSON.stringify(entries)
    const older = Array.from({ length: scenario.olderRows }, (_, i) => ({ ...entry(-i - 10_000), text: "Earlier message" }))
    const state = createEmptyState()
    state.projectsById.set("project", { id: "project", localPath: "/example/project", title: "Example", createdAt: 1, updatedAt: 1 })
    state.chatsById.set("chat", { id: "chat", projectId: "project", title: "Chat", createdAt: 1, updatedAt: 1,
      unread: false, provider: null, planMode: false, sessionToken: null, lastTurnOutcome: null })
    const router = createWsRouter({
      store: { state, getRecentChatHistory: async () => ({ messages: JSON.parse(serialized),
        history: { hasOlder: true, olderCursor: "cursor", recentLimit: 40, revision: "history-1" } }) } as never,
      agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set() } as never,
      terminals: { onEvent: () => () => {} } as never,
      keybindings: { onChange: () => () => {}, getSnapshot: () => ({}) } as never,
      refreshDiscovery: async () => [], getDiscoveredProjects: () => [], machineDisplayName: "Example",
    })
    const sockets = Array.from({ length: clients }, () => ({ data: { subscriptions: new Map(), snapshotSignatures: new Map() } as ClientState,
      frames: [] as string[], send(raw: string) { this.frames.push(raw); return Buffer.byteLength(raw) } }))
    for (const ws of sockets) {
      router.handleOpen(ws as never)
      await router.handleMessage(ws as never, JSON.stringify({ v: 1, type: "subscribe", id: "chat", topic: { type: "chat", chatId: "chat", ...(deltaMode ? { streamVersion: 1, streamId: "benchmark-stream" } : {}) } }))
    }
    const initialBytes = sockets.reduce((n, ws) => n + Buffer.byteLength(ws.frames[0]!), 0)
    const cpuStart = process.cpuUsage()
    const serverStart = performance.now()
    for (let frame = 0; frame < frames; frame++) {
      if (frame % 3 === 0) state.chatsById.get("chat")!.title = `Chat ${frame}`
      else {
        entries = [...entries.slice(1), entry(scenario.rows + frame)]
        serialized = JSON.stringify(entries)
      }
      await router.broadcastSnapshots()
    }
    const serverMs = performance.now() - serverStart
    const cpu = process.cpuUsage(cpuStart)
    let bytes = 0, parsedFrames = 0, processed = 0
    if (fixtureDirectory && scenario.name === "long" && clients === 1 && repeat === 0) {
      await Bun.write(`${fixtureDirectory}/${deltaMode ? "delta" : "snapshot"}.json`, JSON.stringify({ frames: sockets[0]!.frames, older }))
    }
    const clientCpuStart = process.cpuUsage()
    const clientStart = performance.now()
    for (const ws of sockets) {
      let previous: ChatSnapshot | null = null
      const decoder = new ChatStreamDecoder("benchmark-stream")
      const processMessages = deltaMode ? createTranscriptProcessor() : processTranscriptMessages
      for (const raw of ws.frames) {
        bytes += Buffer.byteLength(raw)
        const envelope = JSON.parse(raw)
        let snapshot: ChatSnapshot = envelope.snapshot?.data
        if (deltaMode) {
          const decoded = decoder.receive(envelope.type === "snapshot" ? {
            type: "snapshot", stream: envelope.stream, data: snapshot,
          } : envelope)
          if (decoded.kind !== "apply" || !decoded.snapshot) throw new Error("Invalid replay stream")
          snapshot = decoded.snapshot
        }
        if (!snapshot) throw new Error("Missing snapshot")
        if (snapshot.messages !== previous?.messages) {
          processMessages([...older, ...snapshot.messages])
          processed += older.length + snapshot.messages.length
        }
        previous = snapshot
        parsedFrames++
      }
    }
    const clientMs = performance.now() - clientStart
    const clientCpu = process.cpuUsage(clientCpuStart)
    samples.push({ initialBytes, updateBytes: bytes - initialBytes, parsedFrames, processedEntries: processed,
      clientCpuMs: (clientCpu.user + clientCpu.system) / 1000,
      serverMs, clientMs, serverCpuMs: (cpu.user + cpu.system) / 1000, rssMiB: process.memoryUsage().rss / 1024 / 1024 })
    router.dispose()
  }
  for (const [deltaMode, samples] of byMode) {
  const summarize = (key: string) => {
    const values = samples.map((s) => s[key]!).sort((a, b) => a - b)
    return { median: values[Math.floor(values.length / 2)], max: values.at(-1) }
  }
  results.push({ mode: deltaMode ? "delta" : "snapshot", scenario, clients, samples: samples.length, metrics: Object.fromEntries(Object.keys(samples[0]!).map((key) => [key, summarize(key)])) })
}
}
console.log(JSON.stringify({ runtime: Bun.version, frames, repeats,
  scope: "Synthetic Bun router/JSON/client-processing replay; excludes disk IO, browser rendering, network and provider latency. RSS is process-wide, not retained allocation. Max is not p95 with three samples.", results }, null, 2))
