import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { CodexExecManager } from "./codex-exec"
import { asyncQuestionKey } from "../shared/types"

class FakeCodexExecProcess extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()

  kill() {
    this.emit("close", 137)
  }

  writeJson(message: unknown) {
    this.stdout.write(`${JSON.stringify(message)}\n`)
  }
}

async function collectStream(stream: AsyncIterable<any>) {
  const items: any[] = []
  for await (const item of stream) {
    items.push(item)
  }
  return items
}

async function startTurn() {
  const processes: FakeCodexExecProcess[] = []
  const manager = new CodexExecManager({
    spawnProcess: () => {
      const process = new FakeCodexExecProcess()
      processes.push(process)
      return process as never
    },
  })
  await manager.startSession({
    chatId: "chat-1",
    cwd: "/tmp/project",
    model: "gpt-5.5",
    sessionToken: null,
  })
  const turn = await manager.startTurn({
    chatId: "chat-1",
    model: "gpt-5.5",
    content: "Investigate",
    planMode: false,
    onToolRequest: async () => ({}),
  })
  return { manager, process: processes[0]!, turn }
}

describe("CodexExecManager async questions", () => {
  test("preserves delivery/questions metadata on assistant text", async () => {
    const { manager, process, turn } = await startTurn()
    expect(manager.supportsNativeSteer).toBe(false)

    process.writeJson({ type: "thread.started", thread_id: "thread-1" })
    process.writeJson({ type: "turn.started" })
    process.writeJson({
      type: "item.completed",
      item: {
        id: "item-question",
        type: "agent_message",
        text: "Which output format?",
        delivery: "async",
        questions: [{ title: "Which output format?", options: ["Markdown", "HTML"] }],
      },
    })
    process.writeJson({ type: "turn.completed" })

    const events = await collectStream(turn.stream)
    const entry = events
      .map((event) => event.entry)
      .find((candidate) => candidate?.kind === "assistant_text")

    expect(entry.text).toBe("Which output format?")
    expect(entry.asyncQuestion).toEqual({
      threadId: "thread-1",
      originTurnId: expect.any(String),
      providerItemId: "item-question",
      questions: [{ index: 0, title: "Which output format?", options: ["Markdown", "HTML"] }],
    })
    expect(asyncQuestionKey(entry.asyncQuestion)).toContain("item-question")
  })

  test("leaves ordinary text without question metadata", async () => {
    const { process, turn } = await startTurn()
    process.writeJson({ type: "thread.started", thread_id: "thread-1" })
    process.writeJson({ type: "turn.started" })
    process.writeJson({ type: "item.completed", item: { id: "item-1", type: "agent_message", text: "Done" } })
    process.writeJson({ type: "turn.completed" })

    const events = await collectStream(turn.stream)
    const entry = events
      .map((event) => event.entry)
      .find((candidate) => candidate?.kind === "assistant_text")
    expect(entry.asyncQuestion).toBeUndefined()
  })

  test("does not turn async delivery without questions into a card", async () => {
    const { process, turn } = await startTurn()
    process.writeJson({ type: "thread.started", thread_id: "thread-1" })
    process.writeJson({ type: "turn.started" })
    process.writeJson({
      type: "item.completed",
      item: { id: "item-1", type: "agent_message", text: "Plain", delivery: "async", questions: [] },
    })
    process.writeJson({ type: "turn.completed" })

    const events = await collectStream(turn.stream)
    const entry = events
      .map((event) => event.entry)
      .find((candidate) => candidate?.kind === "assistant_text")
    expect(entry.asyncQuestion).toBeUndefined()
  })

  test("deduplicates a replayed provider item and ignores final_answer as turn end", async () => {
    const { manager, process, turn } = await startTurn()
    process.writeJson({ type: "thread.started", thread_id: "thread-1" })
    process.writeJson({ type: "turn.started" })
    const item = {
      id: "item-question",
      type: "agent_message",
      text: "Which output format?",
      phase: "final_answer",
      delivery: "async",
      questions: [{ title: "Which output format?", options: ["Markdown", "HTML"] }],
    }
    process.writeJson({ type: "item.completed", item })
    process.writeJson({ type: "item.completed", item })

    // phase=final_answer must not be read as the end of the run.
    expect(manager.getActiveTurnId("chat-1")).not.toBeNull()

    process.writeJson({ type: "turn.completed" })
    const events = await collectStream(turn.stream)
    const questionEntries = events
      .map((event) => event.entry)
      .filter((candidate) => candidate?.kind === "assistant_text")
    expect(questionEntries).toHaveLength(1)
  })

  test("reports the running turn id and clears it on completion", async () => {
    const { manager, process, turn } = await startTurn()
    process.writeJson({ type: "thread.started", thread_id: "thread-1" })
    process.writeJson({ type: "turn.started" })
    const runningTurnId = manager.getActiveTurnId("chat-1")
    expect(runningTurnId).toEqual(expect.any(String))

    process.writeJson({
      type: "item.completed",
      item: {
        id: "item-question",
        type: "agent_message",
        text: "Q",
        delivery: "async",
        questions: [{ title: "Q", options: null }],
      },
    })
    process.writeJson({ type: "turn.completed" })
    const events = await collectStream(turn.stream)
    const entry = events.map((event) => event.entry).find((candidate) => candidate?.kind === "assistant_text")
    expect(entry.asyncQuestion.originTurnId).toBe(runningTurnId)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(manager.getActiveTurnId("chat-1")).toBeNull()
  })
})
