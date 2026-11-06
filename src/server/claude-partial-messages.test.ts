import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { AgentCoordinator, shouldIncludeClaudePartialMessages, startClaudeSession } from "./agent"
import { EventStore } from "./event-store"
import type { HarnessEvent } from "./harness-types"

// These tests run the real Claude Agent SDK against a stand-in CLI that, like the
// real one, writes partial `stream_event` frames only when it is spawned with
// `--include-partial-messages`. Its log is the ground truth for wire traffic.
const fakeCli = resolve(import.meta.dir, "../../test-fixtures/fake-claude-cli.mjs")
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempRoot() {
  const dir = await mkdtemp(join(tmpdir(), "stillon-claude-partial-"))
  roots.push(dir)
  return dir
}

interface WireProcess {
  partial: boolean
  /** Partial `stream_event` frames the CLI wrote. */
  streamEvents: number
  /** Complete messages (everything except partial frames) the CLI wrote. */
  messages: number
  controls: string[]
  answers: unknown[]
}

/** One entry per spawned CLI process, in spawn order. */
async function readWire(path: string): Promise<WireProcess[]> {
  const text = await readFile(path, "utf8").catch(() => "")
  const entries = text.split("\n").filter(Boolean).map((line) => JSON.parse(line))
  return entries.filter((entry) => "spawned" in entry).map((spawn) => {
    const own = entries.filter((entry) => entry.pid === spawn.pid)
    return {
      partial: spawn.partial,
      streamEvents: own.filter((entry) => entry.wrote === "stream_event").length,
      messages: own.filter((entry) => entry.wrote && entry.wrote !== "stream_event").length,
      controls: own.filter((entry) => entry.control).map((entry) => entry.control),
      answers: own.filter((entry) => "answer" in entry).map((entry) => entry.answer),
    }
  })
}

function sessionArgs(logPath: string, collectStatistics: (() => boolean) | undefined, onToolRequest: (request: any) => Promise<unknown> = async () => ({})) {
  return {
    localPath: tmpdir(),
    model: "claude-sonnet-4-6",
    planMode: false,
    permissionMode: "default" as const,
    sessionToken: null,
    forkSession: false,
    environment: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", STILLON_FAKE_CLAUDE_LOG: logPath },
    claudeExecutable: fakeCli,
    collectStatistics,
    onToolRequest,
  }
}

/** Drain one turn of harness events, up to and including its result entry. */
async function runTurn(handle: Awaited<ReturnType<typeof startClaudeSession>>, prompt: string, events: HarnessEvent[], iterator: AsyncIterator<HarnessEvent>) {
  await handle.sendPrompt(prompt)
  while (true) {
    const next = await iterator.next()
    if (next.done) throw new Error("stream ended before the turn finished")
    events.push(next.value)
    if (next.value.type === "transcript" && next.value.entry?.kind === "result") return
  }
}

const kinds = (events: HarnessEvent[]) => events.flatMap((event) => event.type === "transcript" && event.entry ? [event.entry.kind] : [])
const statisticsEvents = (events: HarnessEvent[]) => events.filter((event) => event.type === "statistics")

const sessionTokens = (events: HarnessEvent[]) => events.filter((event) => event.type === "session_token").length

describe("Claude partial-message delivery follows statistics eligibility", () => {
  test("the option is derived only from the per-session gate", () => {
    expect(shouldIncludeClaudePartialMessages(undefined)).toBe(false)
    expect(shouldIncludeClaudePartialMessages(() => false)).toBe(false)
    expect(shouldIncludeClaudePartialMessages(() => true)).toBe(true)
  })

  test("an ineligible query is spawned without partial messages and nothing partial crosses the wire", async () => {
    const logPath = join(await tempRoot(), "wire.jsonl")
    const requests: any[] = []
    const handle = await startClaudeSession(sessionArgs(logPath, () => false, async (request) => {
      requests.push(request)
      return { answers: { Pick: "A" } }
    }))
    const iterator = handle.stream[Symbol.asyncIterator]()
    const events: HarnessEvent[] = []
    try {
      await runTurn(handle, "tool ask", events, iterator)
      await handle.interrupt()
      await runTurn(handle, "plain", events, iterator)
    } finally {
      handle.close()
    }
    const [wire, ...others] = await readWire(logPath)
    expect(others).toHaveLength(0)
    expect(wire!.partial).toBe(false)
    expect(wire!.streamEvents).toBe(0)
    expect(wire!.controls).toContain("interrupt")
    // Ordinary conversation, tools, permissions and context-window usage still work.
    expect(kinds(events)).toEqual(expect.arrayContaining(["system_init", "tool_call", "tool_result", "assistant_text", "context_window_updated", "result"]))
    expect(requests).toHaveLength(1)
    expect(requests[0].tool.toolKind).toBe("ask_user_question")
    expect(wire!.answers).toHaveLength(1)
    expect(statisticsEvents(events)).toHaveLength(0)
  })

  test("an eligible query is spawned with partial messages and still produces statistics", async () => {
    const logPath = join(await tempRoot(), "wire.jsonl")
    const handle = await startClaudeSession(sessionArgs(logPath, () => true))
    const iterator = handle.stream[Symbol.asyncIterator]()
    const events: HarnessEvent[] = []
    try {
      await runTurn(handle, "tool", events, iterator)
    } finally {
      handle.close()
    }
    const [wire] = await readWire(logPath)
    expect(wire!.partial).toBe(true)
    expect(wire!.streamEvents).toBeGreaterThan(0)
    expect(statisticsEvents(events).length).toBeGreaterThan(0)
    expect(kinds(events)).toEqual(expect.arrayContaining(["tool_call", "tool_result", "assistant_text", "context_window_updated", "result"]))
    // One session-token event per complete message, none per partial frame.
    expect(sessionTokens(events)).toBe(wire!.messages)
  })

  test("disabling collection on a running query stops observation but cannot stop frames already requested", async () => {
    const logPath = join(await tempRoot(), "wire.jsonl")
    let enabled = true
    const handle = await startClaudeSession(sessionArgs(logPath, () => enabled))
    const iterator = handle.stream[Symbol.asyncIterator]()
    const first: HarnessEvent[] = []
    const second: HarnessEvent[] = []
    let framesBefore = 0
    let messagesBefore = 0
    try {
      await runTurn(handle, "plain", first, iterator)
      const [before] = await readWire(logPath)
      framesBefore = before!.streamEvents
      messagesBefore = before!.messages
      enabled = false
      await runTurn(handle, "plain", second, iterator)
    } finally {
      handle.close()
    }
    const wires = await readWire(logPath)
    // The SDK has no control request for this flag, so the running query keeps receiving frames...
    expect(wires).toHaveLength(1)
    expect(wires[0]!.partial).toBe(true)
    expect(wires[0]!.streamEvents).toBeGreaterThan(framesBefore)
    expect(wires[0]!.controls.filter((control) => !["initialize", "interrupt"].includes(control))).toEqual([])
    expect(statisticsEvents(first).length).toBeGreaterThan(0)
    // ...but none of them is observed, forwarded or turned into a state broadcast.
    expect(statisticsEvents(second)).toHaveLength(0)
    expect(sessionTokens(second)).toBe(wires[0]!.messages - messagesBefore)
    expect(kinds(second)).toEqual(expect.arrayContaining(["assistant_text", "context_window_updated", "result"]))
  })

  test("a query started ineligible is never observed, even if its gate later opens", async () => {
    const logPath = join(await tempRoot(), "wire.jsonl")
    let enabled = false
    const handle = await startClaudeSession(sessionArgs(logPath, () => enabled))
    const iterator = handle.stream[Symbol.asyncIterator]()
    const events: HarnessEvent[] = []
    try {
      await runTurn(handle, "plain", events, iterator)
      enabled = true
      await runTurn(handle, "plain", events, iterator)
    } finally {
      handle.close()
    }
    const [wire] = await readWire(logPath)
    expect(wire!.partial).toBe(false)
    expect(wire!.streamEvents).toBe(0)
    expect(statisticsEvents(events)).toHaveLength(0)
  })
})

describe("AgentCoordinator applies partial-message delivery at query creation", () => {
  async function setup() {
    const root = await tempRoot()
    const logPath = join(root, "wire.jsonl")
    let epoch: string | null = null
    const store = new EventStore(join(root, "data"), () => epoch)
    await store.initialize()
    const projectPath = join(root, "project")
    await mkdir(projectPath)
    const project = await store.openProject(projectPath, "Partial messages")
    const coordinator = new AgentCoordinator({
      store,
      onStateChange: () => {},
      generateTitle: async () => ({ title: null, usedFallback: true, failureMessage: null }),
      getEnvironment: () => ({ PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", CLAUDE_EXECUTABLE: fakeCli, STILLON_FAKE_CLAUDE_LOG: logPath }),
    })
    const results = async (chatId: string) =>
      (await readFile(join(root, "data", "transcripts", `${chatId}.jsonl`), "utf8").catch(() => "")).split("\n").filter((line) => line.includes('"kind":"result"')).length
    const send = async (content: string, chatId?: string, permissionMode?: "dontAsk") => {
      const before = chatId ? await results(chatId) : 0
      const sent = await coordinator.send({ type: "chat.send", chatId, projectId: project.id, provider: "claude", content, model: "claude-sonnet-4-6", permissionMode })
      const start = Date.now()
      while (await results(sent.chatId) <= before) {
        if (Date.now() - start > 10000) throw new Error("Timed out waiting for the Claude turn")
        await new Promise((done) => setTimeout(done, 20))
      }
      await (store as unknown as { waitForPendingWrites(): Promise<void> }).waitForPendingWrites()
      return sent.chatId
    }
    return { store, coordinator, send, wire: () => readWire(logPath), setEpoch: (value: string | null) => { epoch = value } }
  }

  test("only sessions created while enabled start with partial messages; disabling and re-enabling never backfill", async () => {
    const { store, coordinator, send, wire, setEpoch } = await setup()
    try {
      // Default off: a session is not enrolled and its query asks for no partial frames.
      const legacy = await send("plain")
      expect(store.shouldCollectStatistics(legacy)).toBe(false)
      expect((await wire()).map((process) => process.partial)).toEqual([false])
      expect(store.requireChat(legacy).statisticsState).toBeUndefined()

      // Enabling does not retroactively enrol the existing session; its next turn
      // reuses the same query, which keeps partial messages off.
      setEpoch("window-1")
      await send("plain", legacy)
      expect(await wire()).toHaveLength(1)
      expect((await wire())[0]!.streamEvents).toBe(0)
      expect(store.requireChat(legacy).statisticsState).toBeUndefined()

      // A session created while enabled is enrolled, asks for partial frames and records statistics.
      const enrolled = await send("tool")
      expect(store.shouldCollectStatistics(enrolled)).toBe(true)
      expect((await wire()).map((process) => process.partial)).toEqual([false, true])
      expect((await wire())[1]!.streamEvents).toBeGreaterThan(0)
      const recorded = store.requireChat(enrolled).statisticsState
      expect(recorded?.snapshot.tokenUsage.outputTokens).toBeGreaterThan(0)
      expect(recorded?.snapshot.sessionStats.steps).toBeGreaterThan(0)

      // Disabling stops writes immediately. The running query was already spawned with partial
      // frames and keeps receiving them, so only observation and persistence stop.
      const frozen = structuredClone(recorded)
      const framesWhileOn = (await wire())[1]!.streamEvents
      setEpoch(null)
      await send("plain", enrolled)
      expect((await wire()).map((process) => process.partial)).toEqual([false, true])
      expect((await wire())[1]!.streamEvents).toBeGreaterThan(framesWhileOn)
      expect(store.requireChat(enrolled).statisticsState).toEqual(frozen)

      // A session created while disabled starts without partial frames and stays unenrolled.
      const whileOff = await send("plain")
      expect((await wire()).map((process) => process.partial)).toEqual([false, true, false])
      expect(store.shouldCollectStatistics(whileOff)).toBe(false)

      // Re-enabling opens a new window: earlier sessions, enrolled or not, stay excluded
      // and only a newly created session is enrolled with partial messages.
      setEpoch("window-2")
      expect(store.shouldCollectStatistics(enrolled)).toBe(false)
      expect(store.shouldCollectStatistics(legacy)).toBe(false)
      await send("plain", enrolled)
      expect(store.requireChat(enrolled).statisticsState).toEqual(frozen)
      const fresh = await send("plain")
      expect(store.shouldCollectStatistics(fresh)).toBe(true)
      expect((await wire()).map((process) => process.partial)).toEqual([false, true, false, true])
      expect(store.requireChat(fresh).statisticsState?.snapshot.tokenUsage.outputTokens).toBeGreaterThan(0)
    } finally {
      await coordinator.shutdown()
    }
  })

  test("a query recreated at a natural boundary re-evaluates eligibility without losing the conversation", async () => {
    const { store, coordinator, send, wire, setEpoch } = await setup()
    try {
      setEpoch("window-1")
      const chat = await send("plain")
      expect((await wire()).map((process) => process.partial)).toEqual([true])
      const token = store.requireChat(chat).sessionToken
      expect(token).toBeString()

      // Disabled, then the permission mode changes: the next turn builds a new query. It resumes
      // the same session and no longer asks for partial messages.
      setEpoch(null)
      await send("plain", chat, "dontAsk")
      const processes = await wire()
      expect(processes.map((process) => process.partial)).toEqual([true, false])
      expect(processes[1]!.streamEvents).toBe(0)
      expect(store.requireChat(chat).sessionToken).toBe(token)
    } finally {
      await coordinator.shutdown()
    }
  })
})
