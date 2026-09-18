import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { CodexAppServerManager } from "./codex-app-server"
import { asyncQuestionKey } from "../shared/types"

class FakeCodexProcess extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly messages: any[] = []

  constructor(private readonly onMessage?: (message: any, process: FakeCodexProcess) => void) {
    super()
    let buffer = ""
    this.stdin.on("data", (chunk) => {
      buffer += chunk.toString()
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.trim()) continue
        const message = JSON.parse(line)
        this.messages.push(message)
        this.onMessage?.(message, this)
      }
    })
  }

  kill() {
    this.emit("close", 0)
  }

  writeServerMessage(message: unknown) {
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

function createManager(onMessage: (message: any, process: FakeCodexProcess) => void) {
  const process = new FakeCodexProcess(onMessage)
  const manager = new CodexAppServerManager({ spawnProcess: () => process as never })
  return { manager, process }
}

async function startTurn(manager: CodexAppServerManager) {
  await manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", model: "gpt-5.5", sessionToken: null })
  return await manager.startTurn({
    chatId: "chat-1",
    model: "gpt-5.5",
    content: "Investigate",
    planMode: false,
    onToolRequest: async () => ({}),
  })
}

describe("CodexAppServerManager async questions", () => {
  test("preserves async metadata and exposes the native steer capability", async () => {
    const { manager, process } = createManager((message, child) => {
      if (message.method === "initialize") child.writeServerMessage({ id: message.id, result: {} })
      else if (message.method === "thread/start") {
        child.writeServerMessage({ id: message.id, result: { thread: { id: "thread-1" }, model: "gpt-5.5", reasoningEffort: null } })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({ id: message.id, result: { turn: { id: "turn-1", status: "inProgress", error: null } } })
      }
    })
    const turn = await startTurn(manager)
    expect(manager.supportsNativeSteer).toBe(true)

    process.writeServerMessage({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          id: "item-question",
          text: "Which output format?",
          phase: "final_answer",
          memoryCitation: null,
          delivery: "async",
          questions: [{ title: "Which output format?", options: ["Markdown", "HTML"] }],
        },
      },
    })
    process.writeServerMessage({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null } } })

    const events = await collectStream(turn.stream)
    const entries = events.map((event) => event.entry).filter((candidate) => candidate?.kind === "assistant_text")
    expect(entries).toHaveLength(1)
    expect(entries[0].asyncQuestion).toEqual({
      threadId: "thread-1",
      originTurnId: "turn-1",
      providerItemId: "item-question",
      questions: [{ index: 0, title: "Which output format?", options: ["Markdown", "HTML"] }],
    })
    expect(asyncQuestionKey(entries[0].asyncQuestion)).toContain("turn-1")
  })

  test("sends turn/steer with the expected turn id and no new turn", async () => {
    const { manager, process } = createManager((message, child) => {
      if (message.method === "initialize") child.writeServerMessage({ id: message.id, result: {} })
      else if (message.method === "thread/start") {
        child.writeServerMessage({ id: message.id, result: { thread: { id: "thread-1" }, model: "gpt-5.5", reasoningEffort: null } })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({ id: message.id, result: { turn: { id: "turn-1", status: "inProgress", error: null } } })
      } else if (message.method === "turn/steer") {
        child.writeServerMessage({ id: message.id, result: { turnId: "turn-1" } })
      }
    })
    await startTurn(manager)
    expect(manager.getActiveTurnId("chat-1")).toBe("turn-1")

    const response = await manager.steerTurn({
      chatId: "chat-1",
      expectedTurnId: "turn-1",
      content: "回答问题：Which output format?\n答案：HTML",
      clientUserMessageId: "submission-1",
    })

    expect(response.turnId).toBe("turn-1")
    const steerMessage = process.messages.find((message) => message.method === "turn/steer")
    expect(steerMessage.params).toEqual({
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      clientUserMessageId: "submission-1",
      input: [{ type: "text", text: "回答问题：Which output format?\n答案：HTML", text_elements: [] }],
    })
    expect(process.messages.filter((message) => message.method === "turn/start")).toHaveLength(1)
    expect(process.messages.filter((message) => message.method === "turn/interrupt")).toHaveLength(0)
  })

  test("propagates a steer rejection so the coordinator can re-check state", async () => {
    const { manager } = createManager((message, child) => {
      if (message.method === "initialize") child.writeServerMessage({ id: message.id, result: {} })
      else if (message.method === "thread/start") {
        child.writeServerMessage({ id: message.id, result: { thread: { id: "thread-1" }, model: "gpt-5.5", reasoningEffort: null } })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({ id: message.id, result: { turn: { id: "turn-1", status: "inProgress", error: null } } })
      } else if (message.method === "turn/steer") {
        child.writeServerMessage({ id: message.id, error: { message: "expectedTurnId does not match the active turn" } })
      }
    })
    await startTurn(manager)

    await expect(manager.steerTurn({
      chatId: "chat-1",
      expectedTurnId: "turn-stale",
      content: "answer",
    })).rejects.toThrow("turn/steer failed")
  })
})
