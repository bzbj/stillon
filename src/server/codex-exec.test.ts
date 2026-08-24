import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { spawn } from "node:child_process"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CodexExecManager, codexSpawnOptions } from "./codex-exec"

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

  readonly signals: string[] = []

  kill(signal?: string) {
    this.signals.push(signal ?? "SIGTERM")
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
    const spawnedEnvironments: NodeJS.ProcessEnv[] = []
    const manager = new CodexExecManager({
      getEnvironment: () => ({ HTTPS_PROXY: "http://127.0.0.1:7890" }),
      spawnProcess: (args, cwd, environment) => {
        spawned.push({ args, cwd })
        spawnedEnvironments.push(environment)
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
    expect(spawnedEnvironments[0]?.HTTPS_PROXY).toBe("http://127.0.0.1:7890")
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

/** A launcher that ignores SIGTERM, standing in for the Node shim `codex`. */
class StubbornProcess extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly signals: string[] = []
  killed = false

  kill(signal?: string) {
    this.signals.push(signal ?? "SIGTERM")
    // Only SIGKILL takes this process down; SIGTERM is swallowed, exactly like a
    // shim that cannot forward an uncatchable signal to its native child.
    if (signal === "SIGKILL") {
      this.killed = true
      this.emit("close", 137)
    }
  }
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitUntilDead(pid: number, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return !isAlive(pid)
}

describe("codexSpawnOptions", () => {
  test("keeps the CLI in the server's process group", () => {
    // Detaching would make the CLI survive `launchctl bootout` of the StillOn
    // job, so cancellation walks the process tree by pid instead.
    expect(codexSpawnOptions("/tmp/project", {}).detached).toBe(false)
  })
})

describe("CodexExecManager cancellation (#109)", () => {
  test("asks the process to exit with SIGTERM before escalating", async () => {
    const processes: FakeCodexExecProcess[] = []
    const manager = new CodexExecManager({
      spawnProcess: () => {
        const child = new FakeCodexExecProcess()
        processes.push(child)
        return child as never
      },
    })

    await manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", model: "gpt-5.5", sessionToken: null })
    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.5",
      content: "Wait",
      planMode: false,
      onToolRequest: async () => ({}),
    })

    await turn.interrupt()

    // A process that exits on SIGTERM is never SIGKILLed, so Codex gets the
    // chance to release its thread-writer lock cleanly.
    expect(processes[0]!.signals).toEqual(["SIGTERM"])
  })

  test("escalates to SIGKILL and only resolves once the process is gone", async () => {
    const processes: StubbornProcess[] = []
    const manager = new CodexExecManager({
      spawnProcess: () => {
        const child = new StubbornProcess()
        processes.push(child)
        return child as never
      },
    })

    await manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", model: "gpt-5.5", sessionToken: null })
    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.5",
      content: "Wait",
      planMode: false,
      onToolRequest: async () => ({}),
    })

    let resolved = false
    const interrupted = turn.interrupt().then(() => {
      resolved = true
    })

    // Still holding the writer lock: interrupt() must not report success yet.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(resolved).toBe(false)

    await interrupted
    expect(processes[0]!.signals).toEqual(["SIGTERM", "SIGKILL"])
    expect(processes[0]!.killed).toBe(true)
  }, 15_000)

  test("kills the whole process tree so a native child cannot be orphaned", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-exec-group-"))
    const pidFile = join(dir, "native.pid")
    const nativeScript = join(dir, "native-child.mjs")
    const launcherScript = join(dir, "launcher.mjs")

    // Stands in for the native Codex binary holding the thread-writer lock.
    await writeFile(
      nativeScript,
      [
        'import { writeFileSync } from "node:fs"',
        'process.on("SIGTERM", () => {})',
        "setInterval(() => {}, 1000)",
        // Written by the child itself, so the pid is only published once it is
        // genuinely running and holding the lock.
        `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))`,
      ].join("\n")
    )
    // Stands in for the Node shim installed as `codex`, which spawns the binary.
    await writeFile(
      launcherScript,
      [
        'import { spawn } from "node:child_process"',
        `spawn(process.execPath, [${JSON.stringify(nativeScript)}], { stdio: ["ignore", "pipe", "ignore"] })`,
        "setInterval(() => {}, 1000)",
      ].join("\n")
    )

    const manager = new CodexExecManager({
      // Mirror the production spawn options so this exercises the real
      // detached/process-group behaviour, not a test-only shortcut.
      spawnProcess: (_args, cwd, environment) =>
        spawn(process.execPath, [launcherScript], codexSpawnOptions(cwd, environment)) as never,
    })

    await manager.startSession({ chatId: "chat-1", cwd: dir, model: "gpt-5.5", sessionToken: null })
    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.5",
      content: "Wait",
      planMode: false,
      onToolRequest: async () => ({}),
    })

    // Wait for the launcher to report the native child's pid.
    let nativePid = 0
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && !nativePid) {
      try {
        nativePid = Number(await Bun.file(pidFile).text())
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
    expect(nativePid).toBeGreaterThan(0)
    expect(isAlive(nativePid)).toBe(true)

    await turn.interrupt()

    // Before the fix the launcher died and this child survived, keeping the
    // Codex writer lock and failing the next thread/resume.
    expect(await waitUntilDead(nativePid)).toBe(true)
  }, 30_000)
})
