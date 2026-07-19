import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { CodexExecManager } from "./codex-exec"

class FakeCodexExecProcess extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  stdinText = ""
  killed = false

  constructor() {
    super()
    this.stdin.on("data", (chunk) => {
      this.stdinText += chunk.toString()
    })
  }

  kill() {
    this.killed = true
    this.emit("close", 137)
  }

  writeJson(message: unknown) {
    this.stdout.write(`${JSON.stringify(message)}\n`)
  }

  writeStderr(message: string) {
    this.stderr.write(`${message}\n`)
  }

  closeWithCode(code: number) {
    this.emit("close", code)
  }

  fail(error: Error) {
    this.emit("error", error)
  }
}

async function collectStream(stream: AsyncIterable<any>) {
  const items: any[] = []
  for await (const item of stream) {
    items.push(item)
  }
  return items
}

describe("CodexExecManager", () => {
  test("starts a fresh codex exec turn and maps JSONL events", async () => {
    const processes: FakeCodexExecProcess[] = []
    const spawned: Array<{ args: string[]; cwd: string }> = []
    const manager = new CodexExecManager({
      spawnProcess: (args, cwd) => {
        spawned.push({ args, cwd })
        const process = new FakeCodexExecProcess()
        processes.push(process)
        return process as never
      },
    })

    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.5",
      serviceTier: "fast",
      sessionToken: null,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.5",
      effort: "xhigh",
      serviceTier: "fast",
      content: "Solve this",
      planMode: false,
      onToolRequest: async () => ({}),
    })

    const process = processes[0]!
    expect(spawned[0]).toEqual({
      cwd: "/tmp/project",
      args: [
        "exec",
        "--json",
        "-C",
        "/tmp/project",
        "-m",
        "gpt-5.5",
        "-c",
        "model_reasoning_effort=\"xhigh\"",
        "-c",
        "service_tier=\"fast\"",
        "-c",
        "sandbox_mode=\"danger-full-access\"",
        "-c",
        "approval_policy=\"never\"",
        "-c",
        "approvals_reviewer=\"user\"",
        "--skip-git-repo-check",
        "-",
      ],
    })
    expect(process.stdinText).toBe("Solve this\n")

    process.writeJson({ type: "thread.started", thread_id: "thread-1" })
    process.writeJson({ type: "turn.started" })
    process.writeJson({
      type: "item.started",
      item: { id: "item-1", type: "command_execution", command: "pwd", status: "in_progress" },
    })
    process.writeJson({
      type: "item.completed",
      item: {
        id: "item-1",
        type: "command_execution",
        command: "pwd",
        aggregated_output: "/tmp/project\n",
        exit_code: 0,
        status: "completed",
      },
    })
    process.writeJson({
      type: "item.completed",
      item: { id: "item-2", type: "agent_message", text: "Done" },
    })
    process.writeJson({
      type: "turn.completed",
      usage: {
        input_tokens: 10,
        cached_input_tokens: 3,
        output_tokens: 5,
        reasoning_output_tokens: 2,
      },
    })

    const events = await collectStream(turn.stream)
    expect(events.find((event) => event.type === "session_token")?.sessionToken).toBe("thread-1")

    const entries = events
      .filter((event) => event.type === "transcript")
      .map((event) => event.entry)
    expect(entries.map((entry) => entry.kind)).toEqual([
      "system_init",
      "tool_call",
      "tool_result",
      "assistant_text",
      "context_window_updated",
      "result",
    ])
    expect(entries.find((entry) => entry.kind === "assistant_text")?.text).toBe("Done")
    expect(entries.find((entry) => entry.kind === "context_window_updated")?.usage).toMatchObject({
      usedTokens: 15,
      inputTokens: 10,
      cachedInputTokens: 3,
      outputTokens: 5,
      reasoningOutputTokens: 2,
    })
    expect(entries.at(-1)).toMatchObject({ kind: "result", subtype: "success", isError: false })
  })

  test("resumes the exact stored thread id and never uses --last", async () => {
    const spawned: Array<{ args: string[]; cwd: string }> = []
    const processes: FakeCodexExecProcess[] = []
    const manager = new CodexExecManager({
      spawnProcess: (args, cwd) => {
        spawned.push({ args, cwd })
        const process = new FakeCodexExecProcess()
        processes.push(process)
        return process as never
      },
    })

    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.5",
      sessionToken: "thread-existing",
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.5",
      effort: "high",
      content: "Continue",
      planMode: false,
      onToolRequest: async () => ({}),
    })

    expect(spawned[0]?.cwd).toBe("/tmp/project")
    expect(spawned[0]?.args).toEqual([
      "exec",
      "resume",
      "--json",
      "-m",
      "gpt-5.5",
      "-c",
      "model_reasoning_effort=\"high\"",
      "-c",
      "sandbox_mode=\"danger-full-access\"",
      "-c",
      "approval_policy=\"never\"",
      "-c",
      "approvals_reviewer=\"user\"",
      "--skip-git-repo-check",
      "thread-existing",
      "-",
    ])
    expect(spawned[0]?.args).not.toContain("--last")
    expect(spawned[0]?.args).not.toContain("-C")

    processes[0]!.writeJson({ type: "thread.started", thread_id: "thread-existing" })
    processes[0]!.writeJson({ type: "turn.started" })
    processes[0]!.writeJson({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } })

    const events = await collectStream(turn.stream)
    expect(events.filter((event) => event.type === "session_token").map((event) => event.sessionToken)).toEqual([
      "thread-existing",
      "thread-existing",
    ])
  })

  test("maps Codex permission presets into exec config overrides", async () => {
    const spawned: Array<{ args: string[]; cwd: string }> = []
    const processes: FakeCodexExecProcess[] = []
    const manager = new CodexExecManager({
      spawnProcess: (args, cwd) => {
        spawned.push({ args, cwd })
        const process = new FakeCodexExecProcess()
        processes.push(process)
        return process as never
      },
    })

    await manager.startSession({
      chatId: "chat-request",
      cwd: "/tmp/project",
      model: "gpt-5.5",
      sessionToken: null,
      permissionMode: "request",
    })
    const requestTurn = await manager.startTurn({
      chatId: "chat-request",
      model: "gpt-5.5",
      content: "Request mode",
      planMode: false,
      onToolRequest: async () => ({}),
    })
    expect(spawned[0]?.args).toContain("sandbox_mode=\"workspace-write\"")
    expect(spawned[0]?.args).toContain("approval_policy=\"on-request\"")
    expect(spawned[0]?.args).toContain("approvals_reviewer=\"user\"")
    requestTurn.close()

    await manager.startSession({
      chatId: "chat-auto",
      cwd: "/tmp/project",
      model: "gpt-5.5",
      sessionToken: null,
      permissionMode: "request",
    })
    const autoTurn = await manager.startTurn({
      chatId: "chat-auto",
      model: "gpt-5.5",
      content: "Auto mode",
      planMode: false,
      permissionMode: "auto",
      onToolRequest: async () => ({}),
    })
    expect(spawned[1]?.args).toContain("sandbox_mode=\"workspace-write\"")
    expect(spawned[1]?.args).toContain("approval_policy=\"on-request\"")
    expect(spawned[1]?.args).toContain("approvals_reviewer=\"auto_review\"")
    autoTurn.close()

    expect(processes.every((process) => process.killed)).toBe(true)
  })

  test("emits an error result when the exec process fails", async () => {
    const process = new FakeCodexExecProcess()
    const manager = new CodexExecManager({
      spawnProcess: () => process as never,
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
      content: "Fail",
      planMode: false,
      onToolRequest: async () => ({}),
    })

    process.fail(new Error("spawn failed"))

    const events = await collectStream(turn.stream)
    const result = events
      .filter((event) => event.type === "transcript")
      .map((event) => event.entry)
      .find((entry) => entry.kind === "result")

    expect(result).toMatchObject({
      kind: "result",
      subtype: "error",
      isError: true,
      result: "spawn failed",
    })
  })

  test("keeps retryable protocol errors non-terminal until the turn recovers", async () => {
    const process = new FakeCodexExecProcess()
    const manager = new CodexExecManager({
      spawnProcess: () => process as never,
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
      content: "Recover",
      planMode: false,
      onToolRequest: async () => ({}),
    })

    process.writeJson({ type: "turn.started" })
    process.writeJson({ type: "error", message: "Reconnecting... 2/5 (request timed out)" })
    process.writeJson({
      type: "item.completed",
      item: { id: "item-1", type: "agent_message", text: "Recovered" },
    })
    process.writeJson({
      type: "turn.completed",
      usage: { input_tokens: 2, output_tokens: 1 },
    })

    const events = await collectStream(turn.stream)
    const entries = events
      .filter((event) => event.type === "transcript")
      .map((event) => event.entry)

    expect(entries.find((entry) => entry.kind === "status")).toMatchObject({
      status: "Reconnecting... 2/5 (request timed out)",
    })
    expect(entries.find((entry) => entry.kind === "assistant_text")).toMatchObject({
      text: "Recovered",
    })
    expect(entries.at(-1)).toMatchObject({
      kind: "result",
      subtype: "success",
      isError: false,
    })
  })

  test("treats turn.failed as the terminal Codex error", async () => {
    const process = new FakeCodexExecProcess()
    const manager = new CodexExecManager({
      spawnProcess: () => process as never,
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
      content: "Fail",
      planMode: false,
      onToolRequest: async () => ({}),
    })

    process.writeJson({ type: "turn.started" })
    process.writeJson({ type: "error", message: "Reconnecting... 5/5" })
    process.writeJson({ type: "turn.failed", error: { message: "stream disconnected before completion" } })

    const events = await collectStream(turn.stream)
    const result = events
      .filter((event) => event.type === "transcript")
      .map((event) => event.entry)
      .find((entry) => entry.kind === "result")

    expect(result).toMatchObject({
      kind: "result",
      subtype: "error",
      isError: true,
      result: "stream disconnected before completion",
    })
  })

  test("uses the last protocol error when the exec process exits non-zero", async () => {
    const process = new FakeCodexExecProcess()
    const manager = new CodexExecManager({
      spawnProcess: () => process as never,
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
      content: "Fail",
      planMode: false,
      onToolRequest: async () => ({}),
    })

    process.writeJson({ type: "error", message: "network unavailable" })
    process.closeWithCode(1)

    const events = await collectStream(turn.stream)
    const result = events
      .filter((event) => event.type === "transcript")
      .map((event) => event.entry)
      .find((entry) => entry.kind === "result")

    expect(result).toMatchObject({
      kind: "result",
      subtype: "error",
      isError: true,
      result: "network unavailable",
    })
  })

  test("interrupt kills the active exec process", async () => {
    const process = new FakeCodexExecProcess()
    const manager = new CodexExecManager({
      spawnProcess: () => process as never,
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
      content: "Wait",
      planMode: false,
      onToolRequest: async () => ({}),
    })

    await turn.interrupt()
    expect(process.killed).toBe(true)
  })
})
