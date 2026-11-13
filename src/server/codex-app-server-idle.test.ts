import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { CodexAppServerManager } from "./codex-app-server"
import { hasBackgroundWorkSince, processStartedAtMs, type ProcessInfo } from "./process-tree"

const MINUTE = 60_000
/** `ps -o lstart` text for an epoch time, as listed under LC_ALL=C. */
const lstart = (ms: number) => {
  const date = new Date(ms)
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
  const time = [date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => String(part).padStart(2, "0")).join(":")
  return `${days[date.getDay()]} ${months[date.getMonth()]} ${String(date.getDate()).padStart(2, " ")} ${time} ${date.getFullYear()}`
}

class FakeCodexProcess extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly methods: string[] = []
  readonly params: Record<string, unknown> = {}
  exitCode: number | null = null

  constructor(readonly pid: number, thread: string) {
    super()
    let buffer = ""
    this.stdin.on("data", (chunk) => {
      buffer += chunk.toString()
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.trim()) continue
        const message = JSON.parse(line)
        if (!message.method) continue
        this.methods.push(message.method)
        this.params[message.method] = message.params
        if (message.id === undefined) continue
        const result = message.method === "initialize" ? {}
          : message.method === "turn/start" ? { turn: { id: `${thread}-turn`, status: "inProgress", error: null } }
          : { thread: { id: thread } }
        this.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`)
      }
    })
  }

  kill() {
    this.exitCode = 0
    this.emit("close", 0)
  }
}

/** A process table where each App Server is an npm launcher with a native Codex child. */
function fixture(options: { idleTimeoutMs?: number; maxIdleSessions?: number; exitDelayMs?: number } = {}) {
  let nextPid = 100
  const children: FakeCodexProcess[] = []
  let processes: ProcessInfo[] = []
  const signaled: number[] = []
  const manager = new CodexAppServerManager({
    idleTimeoutMs: options.idleTimeoutMs ?? 10 * MINUTE,
    maxIdleSessions: options.maxIdleSessions ?? 4,
    spawnProcess: () => {
      const pid = nextPid
      nextPid += 10
      const child = new FakeCodexProcess(pid, `thread-${pid}`)
      children.push(child)
      const startedAt = lstart(Date.now() - 5_000)
      processes.push(
        { pid, ppid: 1, startedAt, command: "/usr/bin/node", stat: "S" },
        { pid: pid + 1, ppid: pid, startedAt, command: "/example/bin/codex", stat: "S" },
        { pid: pid + 2, ppid: pid + 1, startedAt, command: "/example/bin/codex-code-mode-host", stat: "S" },
        // An MCP server launched through npx when the session starts.
        { pid: pid + 3, ppid: pid + 1, startedAt, command: "npm", stat: "S" },
        { pid: pid + 4, ppid: pid + 3, startedAt, command: "node", stat: "S" },
      )
      return child as never
    },
    processControl: {
      listProcesses: async () => processes,
      isPidPresent: (pid) => processes.some((item) => item.pid === pid),
      signal: (pid) => {
        signaled.push(pid)
        const exit = () => {
          processes = processes.filter((item) => item.pid !== pid)
          children.find((child) => child.pid === pid)?.kill()
        }
        if (options.exitDelayMs) setTimeout(exit, options.exitDelayMs)
        else exit()
      },
    },
  })
  return {
    manager, children, signaled,
    get processes() { return processes },
    addProcess(info: ProcessInfo) { processes.push(info) },
  }
}

const session = (chatId: string, sessionToken: string | null = null) => ({ chatId, cwd: "/example", model: "fixture", sessionToken })

test("an idle App Server is stopped with its native process and the next turn resumes its thread", async () => {
  const state = fixture()
  const { manager, children, signaled } = state
  try {
    const thread = await manager.startSession(session("chat", "persisted-thread"))
    await manager.reclaimIdleSessions(Date.now() + 5 * MINUTE)
    expect(signaled).toEqual([])
    await manager.reclaimIdleSessions(Date.now() + 11 * MINUTE)
    // MCP servers belong to the session and are restarted on resume.
    expect(signaled).toEqual([100, 101, 102])
    expect(state.processes.map((item) => item.pid)).toEqual([103, 104])
    await manager.startSession(session("chat", thread))
    expect(children).toHaveLength(2)
    expect(children[1]!.methods).toContain("thread/resume")
    expect((children[1]!.params["thread/resume"] as { threadId: string }).threadId).toBe(thread!)
  } finally { await manager.stopAll() }
})

test("a new turn waits until the reclaimed server has exited before resuming its thread", async () => {
  const state = fixture({ exitDelayMs: 150 })
  const { manager, children } = state
  try {
    const thread = await manager.startSession(session("chat", "persisted-thread"))
    const reclaim = manager.reclaimIdleSessions(Date.now() + 11 * MINUTE)
    await Bun.sleep(10)
    await manager.startSession(session("chat", thread))
    expect(state.processes.some((item) => item.pid === 101)).toBe(false)
    expect(children).toHaveLength(2)
    await reclaim
  } finally { await manager.stopAll() }
})

test("a running turn or a background tool keeps an App Server alive", async () => {
  const state = fixture()
  const { manager, signaled } = state
  try {
    await manager.startSession(session("running"))
    await manager.startTurn({ chatId: "running", model: "fixture", content: "work", planMode: false, onToolRequest: async () => ({}) } as never)
    await manager.startSession(session("background", "persisted-thread"))
    // A command runs and leaves a dev server behind after its turn.
    const commandStarted = Date.now()
    state.children[1]!.stdout.write(`${JSON.stringify({ method: "item/started", params: { threadId: "thread-110", turnId: "t", item: { type: "commandExecution", id: "cmd" } } })}\n`)
    await Bun.sleep(20)
    state.addProcess({ pid: 999, ppid: 111, startedAt: lstart(commandStarted + 1_000), command: "/usr/bin/python3", stat: "S" })
    await manager.reclaimIdleSessions(Date.now() + 60 * MINUTE)
    expect(signaled).toEqual([])
    // Once the dev server is gone, the session is reclaimed.
    state.processes.splice(state.processes.findIndex((item) => item.pid === 999), 1)
    await manager.reclaimIdleSessions(Date.now() + 60 * MINUTE)
    expect(signaled).toEqual([110, 111, 112])
    expect(manager.getActiveTurnId("running")).toBe("thread-100-turn")
  } finally { await manager.stopAll() }
})

test("idle App Servers beyond the warm limit are stopped least recently used first", async () => {
  const { manager, signaled } = fixture({ maxIdleSessions: 1 })
  const realNow = Date.now
  let now = realNow()
  Date.now = () => now
  try {
    await manager.startSession(session("older", "older-thread"))
    now += 2 * MINUTE
    await manager.startSession(session("newer", "newer-thread"))
    now += 2 * MINUTE
    await manager.reclaimIdleSessions(now)
    expect(signaled).toEqual([100, 101, 102])
  } finally {
    Date.now = realNow
    await manager.stopAll()
  }
})

test("a new thread without a started turn is kept, because it cannot be resumed yet", async () => {
  const { manager, signaled } = fixture()
  try {
    await manager.startSession(session("fresh"))
    await manager.reclaimIdleSessions(Date.now() + 60 * MINUTE)
    expect(signaled).toEqual([])
    await manager.startTurn({ chatId: "fresh", model: "fixture", content: "work", planMode: false, onToolRequest: async () => ({}) } as never)
    expect(manager.getActiveTurnId("fresh")).toBe("thread-100-turn")
  } finally { await manager.stopAll() }
})

test("idle reclamation can be disabled", async () => {
  const { manager, signaled } = fixture({ idleTimeoutMs: 0 })
  try {
    await manager.startSession(session("chat", "persisted-thread"))
    await manager.reclaimIdleSessions(Date.now() + 24 * 60 * MINUTE)
    expect(signaled).toEqual([])
  } finally { await manager.stopAll() }
})

test("background work is a non-Codex process started after the first command", () => {
  const command = Date.parse("2026-11-13T10:00:00Z")
  const ticks = (ms: number) => (BigInt(ms) * 10_000n + 621_355_968_000_000_000n).toString()
  const info = (pid: number, ppid: number, command: string, startedMs: number, stat = "S"): ProcessInfo => ({ pid, ppid, startedAt: ticks(startedMs), command, stat })
  const before = command - 60_000
  // Windows: cmd.exe -> node.exe -> codex.exe, with an MCP server from session start.
  const windows = [info(1, 0, "cmd.exe", before), info(2, 1, "node.exe", before), info(3, 2, "codex.exe", before),
    info(4, 3, "codex-code-mode-host.exe", before), info(5, 3, "node.exe", before)]
  expect(hasBackgroundWorkSince(1, windows, command)).toBe(false)
  expect(hasBackgroundWorkSince(1, [...windows, info(6, 3, "pwsh.exe", command + 5_000)], command)).toBe(true)
  expect(hasBackgroundWorkSince(1, [...windows, info(7, 3, "node.exe", command + 5_000, "Z")], command)).toBe(false)
  expect(hasBackgroundWorkSince(1, [...windows, { pid: 8, ppid: 3, startedAt: "unreadable", command: "python", stat: "S" }], command)).toBe(true)
  expect(processStartedAtMs(ticks(command))).toBe(command)
  expect(processStartedAtMs(lstart(command))).toBe(command)
})
