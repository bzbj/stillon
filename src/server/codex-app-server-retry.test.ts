import { afterEach, describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { CodexAppServerManager } from "./codex-app-server"

class FakeCodexProcess extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly messages: unknown[] = []
  killed = false

  constructor(
    private readonly onMessage?: (message: any, process: FakeCodexProcess) => void
  ) {
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
    this.killed = true
    this.emit("close", 0)
  }

  writeServerMessage(message: unknown) {
    this.stdout.write(`${JSON.stringify(message)}\n`)
  }

  writeStderr(message: string) {
    this.stderr.write(`${message}\n`)
  }

  closeWithCode(code: number) {
    this.emit("close", code)
  }
}

const managers: CodexAppServerManager[] = []
afterEach(() => {
  for (const manager of managers.splice(0)) manager.stopAll()
})

const turnArgs = {
  chatId: "chat-1",
  model: "gpt-6.1-sol",
  content: "Continue after retry",
  planMode: false,
  onToolRequest: async () => ({}),
}

async function startRetryTurn() {
  let turnNumber = 0
  const child = new FakeCodexProcess((message, process) => {
    if (message.method === "initialize") {
      process.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
    } else if (message.method === "thread/start") {
      process.writeServerMessage({
        id: message.id,
        result: { thread: { id: "thread-1" }, model: "gpt-6.1-sol", reasoningEffort: "high" },
      })
    } else if (message.method === "turn/start") {
      process.writeServerMessage({
        id: message.id,
        result: { turn: { id: `turn-${++turnNumber}`, status: "inProgress", error: null } },
      })
    } else if (message.method === "turn/interrupt") {
      process.writeServerMessage({ id: message.id, result: {} })
    }
  })
  const manager = new CodexAppServerManager({ spawnProcess: () => child as never })
  managers.push(manager)
  await manager.startSession({
    chatId: "chat-1", cwd: "/tmp/project", model: "gpt-6.1-sol", sessionToken: null,
  })
  const turn = await manager.startTurn(turnArgs)
  const iterator = turn.stream[Symbol.asyncIterator]()
  await iterator.next() // session token
  await iterator.next() // system initialization
  return { child, manager, turn, iterator }
}

function sendError(
  child: FakeCodexProcess,
  message: string,
  willRetry: boolean,
  threadId = "thread-1",
  turnId = "turn-1",
) {
  child.writeServerMessage({
    method: "error",
    params: { threadId, turnId, willRetry, error: { message } },
  })
}

function complete(child: FakeCodexProcess, status = "completed", message?: string) {
  child.writeServerMessage({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-1", status, error: message ? { message } : null },
    },
  })
}

async function remaining(iterator: AsyncIterator<any>) {
  const events: any[] = []
  for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
    events.push(next.value)
  }
  return events
}

describe("Codex app-server retry notifications", () => {
  test.each(["Reconnecting... 2/5", "Reconnecting... 5/5"])(
    "keeps %s active and forwards the recovered answer and completion",
    async (message) => {
      const { child, manager, iterator } = await startRetryTurn()
      sendError(child, message, true)
      expect((await iterator.next()).value).toMatchObject({
        type: "transcript", entry: { kind: "status", status: message },
      })
      expect(manager.getActiveTurnId("chat-1")).toBe("turn-1")
      expect(child.killed).toBe(false)
      await expect(manager.startTurn(turnArgs)).rejects.toThrow("already running")
      child.writeServerMessage({
        method: "item/completed",
        params: {
          threadId: "thread-1", turnId: "turn-1",
          item: { id: "answer-1", type: "agentMessage", text: "Recovered answer" },
        },
      })
      complete(child)
      const events = await remaining(iterator)
      expect(events.map((event) => event.entry?.kind)).toEqual(["assistant_text", "result"])
      expect(events[0].entry.text).toBe("Recovered answer")
      expect(events[1].entry).toMatchObject({ subtype: "success", isError: false })
      expect(manager.getActiveTurnId("chat-1")).toBeNull()
      await manager.startTurn(turnArgs)
      expect(manager.getActiveTurnId("chat-1")).toBe("turn-2")
    },
  )

  test("waits through the last retry before reporting terminal failure", async () => {
    const { child, iterator } = await startRetryTurn()
    sendError(child, "Reconnecting... 5/5", true)
    expect((await iterator.next()).value.entry.kind).toBe("status")
    complete(child, "failed", "Retry budget exhausted")
    const events = await remaining(iterator)
    expect(events).toHaveLength(1)
    expect(events[0].entry).toMatchObject({
      kind: "result", subtype: "error", isError: true, result: "Retry budget exhausted",
    })
  })

  test("does not infer retryability from a reconnect message when willRetry is false", async () => {
    const { child, iterator } = await startRetryTurn()
    sendError(child, "Reconnecting... 5/5", false)
    const events = await remaining(iterator)
    expect(events).toHaveLength(1)
    expect(events[0].entry).toMatchObject({
      kind: "result", subtype: "error", isError: true, result: "Reconnecting... 5/5",
    })
  })

  test("keeps an in-flight steer request alive during recovery", async () => {
    const { child, manager, iterator } = await startRetryTurn()
    const steer = manager.steerTurn({ chatId: "chat-1", expectedTurnId: "turn-1", content: "Additional instruction" })
    sendError(child, "Reconnecting... 5/5", true)
    expect((await iterator.next()).value.entry.kind).toBe("status")
    const request = child.messages.find((message: any) => message.method === "turn/steer") as any
    child.writeServerMessage({ id: request.id, result: { turnId: "turn-1" } })
    await steer
    complete(child)
    expect((await remaining(iterator)).at(-1).entry.subtype).toBe("success")
  })

  test("allows interruption while the final retry is in progress", async () => {
    const { child, manager, turn, iterator } = await startRetryTurn()
    sendError(child, "Reconnecting... 5/5", true)
    expect((await iterator.next()).value.entry.kind).toBe("status")
    await turn.interrupt()
    expect(child.messages).toContainEqual(expect.objectContaining({
      method: "turn/interrupt", params: { threadId: "thread-1", turnId: "turn-1" },
    }))
    expect((await iterator.next()).done).toBe(true)
    expect(manager.getActiveTurnId("chat-1")).toBeNull()
  })

  test("reports an app-server exit during retry as a terminal failure", async () => {
    const { child, iterator } = await startRetryTurn()
    sendError(child, "Reconnecting... 5/5", true)
    expect((await iterator.next()).value.entry.kind).toBe("status")
    child.closeWithCode(1)
    const events = await remaining(iterator)
    expect(events).toHaveLength(1)
    expect(events[0].entry).toMatchObject({
      kind: "result", subtype: "error", result: "Codex app-server exited with code 1",
    })
  })

  test.each([
    ["other-thread", "turn-1", true],
    ["other-thread", "turn-1", false],
    ["thread-1", "previous-turn", true],
    ["thread-1", "previous-turn", false],
  ] as const)("ignores errors for %s / %s (willRetry=%s)", async (threadId, turnId, willRetry) => {
    const { child, iterator } = await startRetryTurn()
    sendError(child, "Unrelated error", willRetry, threadId, turnId)
    complete(child)
    const events = await remaining(iterator)
    expect(events).toHaveLength(1)
    expect(events[0].entry).toMatchObject({ kind: "result", subtype: "success" })
  })
})
