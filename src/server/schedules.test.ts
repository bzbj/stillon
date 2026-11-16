import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { EventStore } from "./event-store"
import { ScheduleStore } from "./schedule-store"
import { ScheduleService, type ScheduleToolContext } from "./schedule-service"
import { ScheduleToolBridge } from "./schedule-tools"
import type { Schedule, ScheduleRun } from "../shared/schedules"

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
async function fixture(start: (schedule: Schedule, run: ScheduleRun) => Promise<any> = async () => ({ status: "started", agentRunId: "fake" })) {
  const root = await mkdtemp(path.join(os.tmpdir(), "stillon-schedules-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const events = new EventStore(root); await events.initialize()
  const project = await events.openProject(path.join(root, "project")), other = await events.openProject(path.join(root, "other"))
  const chat = await events.createChat(project.id), secondChat = await events.createChat(project.id), foreignChat = await events.createChat(other.id)
  for (const target of [chat, secondChat, foreignChat]) await events.setChatTurnPreferences(target.id, { provider: "codex", model: "gpt-6.1-sol", modelOptions: { reasoningEffort: "high", fastMode: false }, permissionMode: "request" })
  const store = new ScheduleStore(root); let clock = 1000000
  const service = new ScheduleService(store, { events, start, changed: () => {}, now: () => clock })
  cleanup.push(async () => { await service.stop(); service.close() })
  const context: ScheduleToolContext = { projectId: project.id, chatId: chat.id, planning: false, automated: false }
  return { root, events, project, other, chat, secondChat, foreignChat, store, service, context, advance: (ms: number) => { clock += ms } }
}
function create(f: Awaited<ReturnType<typeof fixture>>, extra = {}) { return f.service.execute("set_schedule", { message: "Report project status", inMinutes: 1, ...extra }, f.context) as Schedule }

test("workspace ownership is separate from target chat; scope cannot cross workspaces", async () => {
  const f = await fixture(); create(f); create(f, { name: "Second", chatId: f.secondChat.id })
  expect(f.service.snapshot(f.project.id).schedules).toHaveLength(2)
  expect(f.service.snapshot(f.other.id).schedules).toHaveLength(0)
  expect(() => create(f, { chatId: f.foreignChat.id })).toThrow("workspace")
  const id = f.store.list()[0]!.id
  expect(() => f.service.execute("delete_schedule", { scheduleId: id }, { ...f.context, projectId: f.other.id })).toThrow("not found")
})
test("pause, resume and stale revision rejection are persistent", async () => {
  const f = await fixture(), schedule = create(f)
  const paused = f.service.execute("set_schedule", { scheduleId: schedule.id, enabled: false, expectedRevision: schedule.revision }, f.context) as Schedule
  expect(paused.enabled).toBe(false)
  expect(() => f.service.execute("set_schedule", { scheduleId: schedule.id, name: "Stale", expectedRevision: schedule.revision }, f.context)).toThrow("changed")
  expect(f.store.get(schedule.id)?.name).toBe(schedule.name)
  f.advance(120000)
  expect(() => f.service.execute("set_schedule", { scheduleId: schedule.id, enabled: true }, f.context)).toThrow("finished")
  const reader = new ScheduleStore(f.root); cleanup.push(() => reader.close())
  expect(reader.list()[0]!.enabled).toBe(false)
  expect(reader.writable).toBe(false)
  expect(() => reader.delete(schedule.id, paused.revision)).toThrow("Another")
})
test("one overdue trigger is sent after downtime; repeated and concurrent ticks never duplicate", async () => {
  let starts = 0
  const f = await fixture(async () => { starts++; return { status: "started", agentRunId: "fake" } })
  const schedule = create(f)
  f.advance(604800000)
  await Promise.all([f.service.tick(), f.service.tick(), f.service.tick()])
  await f.service.tick()
  expect(starts).toBe(1)
  expect(f.store.get(schedule.id)?.nextRunAt).toBeNull()
  expect(f.store.runs(f.project.id)).toHaveLength(1)
})
test("crash recovery retains history, pauses unknown runs and never replays them", async () => {
  const f = await fixture(); const schedule = create(f); f.advance(60000)
  f.store.claim(schedule.id, 1060000, f.project.localPath)
  await f.service.stop(); f.store.close()
  const recovered = new ScheduleStore(f.root)
  // Replace cleanup so the original closed DB is not closed twice.
  cleanup.pop(); cleanup.push(() => recovered.close())
  expect(recovered.runs(f.project.id)[0]!.state).toBe("interrupted_unknown")
  expect(recovered.get(schedule.id)?.enabled).toBe(false)
  expect(recovered.claim(schedule.id, 999999999, f.project.localPath)).toBeNull()
})
test("busy conversations skip a turn; deleted targets block and pause", async () => {
  const f = await fixture(async () => ({ status: "busy" }))
  await f.events.archiveChat(f.chat.id)
  create(f); f.advance(60000); await f.service.tick()
  expect(f.events.getChat(f.chat.id)?.archivedAt).toBeTruthy()
  expect(f.store.runs(f.project.id)[0]!.state).toBe("skipped")
  const scheduled = create(f, { name: "Gone" }); await f.events.deleteChat(f.chat.id)
  f.advance(60000); await f.service.tick()
  expect(f.store.get(scheduled.id)?.enabled).toBe(false)
  expect(f.store.runs(f.project.id)[0]!.state).toBe("blocked")
})
test("automated turns cannot multiply schedules; plan mode cannot schedule write work", async () => {
  const f = await fixture()
  expect(() => f.service.execute("set_schedule", { message: "write", inMinutes: 1 }, { ...f.context, automated: true })).toThrow("Scheduled runs")
  expect(() => f.service.execute("set_schedule", { message: "write", inMinutes: 1 }, { ...f.context, planning: true })).toThrow("plan-mode")
  expect(() => create(f, { dailyAt: "09:00" })).toThrow("exactly one")
  expect(() => create(f, { inMinutes: undefined, runAt: "2027-01-01T09:00:00" })).toThrow("offset")
})
test("native and CLI bridge authenticate and reauthorize the actual turn", async () => {
  const f = await fixture(); let allowed = true
  const bridge = new ScheduleToolBridge(f.service, () => allowed ? f.context : null)
  cleanup.push(() => bridge.close())
  const config = bridge.forChat(f.chat.id)
  const call = (token: string, origin?: string) => fetch(new URL("/call", config.url), { method: "POST", headers: { authorization: `Bearer ${token}`, ...(origin ? { origin } : {}) }, body: JSON.stringify({ name: "set_schedule", arguments: { operationId: crypto.randomUUID(), message: "Check", inMinutes: 1 } }) })
  expect((await call("wrong")).status).toBe(403)
  expect((await call(config.token, "http://localhost")).status).toBe(403)
  expect((await call(config.token)).status).toBe(200)
  allowed = false
  expect((await call(config.token)).status).toBe(403)
  expect(f.store.list()).toHaveLength(1)
})

test("durable operation receipts deduplicate retries and reject conflicting reuse", async () => {
  const f = await fixture()
  const operationId = crypto.randomUUID()
  const args = { operationId, message: "Once", inMinutes: 1 }
  const first = f.service.execute("set_schedule", args, f.context)
  expect(f.service.execute("set_schedule", args, f.context)).toEqual(first)
  expect(f.store.list()).toHaveLength(1)
  expect(() => f.service.execute("set_schedule", { ...args, message: "Different" }, f.context)).toThrow("different arguments")
  await f.service.stop(); f.store.close(); cleanup.pop()
  const reopened = new ScheduleStore(f.root)
  const service = new ScheduleService(reopened, { events: f.events, start: async () => ({ status: "busy" }), changed: () => {} })
  cleanup.push(() => service.close())
  expect(service.execute("set_schedule", args, f.context)).toEqual(first)
})

test("MCP initializes, lists tools and rejects a revoked turn on the same client", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js")
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js")
  const f = await fixture(); let allowed = true
  const bridge = new ScheduleToolBridge(f.service, () => allowed ? f.context : null)
  cleanup.push(() => bridge.close())
  const config = bridge.forChat(f.chat.id)
  const client = new Client({ name: "schedule-test", version: "1.0" })
  await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: { Authorization: `Bearer ${config.token}` } } }))
  cleanup.push(async () => { await client.close() })
  expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(["set_schedule", "list_schedules", "delete_schedule"])
  const args = { operationId: crypto.randomUUID(), message: "Native check", inMinutes: 1 }
  expect((await client.callTool({ name: "set_schedule", arguments: args })).isError).not.toBe(true)
  expect((await client.callTool({ name: "set_schedule", arguments: args })).isError).not.toBe(true)
  expect(f.store.list()).toHaveLength(1)
  allowed = false
  expect((await client.callTool({ name: "set_schedule", arguments: { ...args, operationId: crypto.randomUUID() } })).isError).toBe(true)
})

test("scheduled agent turn restores archive, uses frozen preferences and separates bridge secrets from transcript", async () => {
  const { AgentCoordinator } = await import("./agent")
  const f = await fixture()
  await f.events.renameChat(f.chat.id, "Scheduled checks")
  await f.events.archiveChat(f.chat.id)
  let capturedEnvironment: NodeJS.ProcessEnv | undefined, capturedPrompt = ""
  const states: string[] = []
  const coordinator = new AgentCoordinator({ store: f.events, onStateChange: () => {},
    getScheduleBridge: () => ({ url: "http://127.0.0.1:1234/mcp", token: "fixture-only-token" }),
    onScheduleRunState: (_id, state) => states.push(state),
    codexManager: {
      async startSession(args: any) { capturedEnvironment = args.applicationEnvironment },
      async startTurn(args: any) {
        capturedPrompt = args.content
        return { provider: "codex", interrupt: async () => {}, close: async () => {},
          stream: (async function* () { yield { type: "transcript", entry: { _id: "result", createdAt: Date.now(), kind: "result", subtype: "success", isError: false, durationMs: 0, result: "Done" } } })() }
      },
      close: async () => {}, closeAll: async () => {}, stopAll: async () => {},
    } as never,
  })
  cleanup.push(() => coordinator.shutdown())
  const schedule = create(f)
  f.advance(60000)
  const run = f.store.claim(schedule.id, 1060000, f.project.localPath)!
  expect((await coordinator.tryStartScheduledTurn(schedule, run)).status).toBe("started")
  for (let i = 0; i < 100 && !states.includes("succeeded"); i++) await Bun.sleep(5)
  expect(states).toContain("succeeded")
  expect(f.events.getChat(f.chat.id)?.archivedAt).toBeUndefined()
  expect(capturedEnvironment?.STILLON_SCHEDULE_TOKEN).toBe("fixture-only-token")
  expect(capturedPrompt).toContain("stillon-schedules")
  const transcript = await Bun.file(path.join(f.root, "transcripts", `${f.chat.id}.jsonl`)).text()
  expect(transcript).not.toContain("fixture-only-token")
  expect(transcript).not.toContain("stillon-schedules")
  expect(transcript).toContain('"scheduleSource"')
})

test("stopping a scheduled turn leaves the next occurrence eligible after confirmed exit", async () => {
  const { AgentCoordinator } = await import("./agent")
  const f = await fixture()
  let starts = 0
  const coordinator = new AgentCoordinator({ store: f.events, onStateChange: () => {},
    codexManager: {
      async startSession() {},
      async startTurn() {
        starts++
        let release!: () => void
        const stopped = new Promise<void>(resolve => { release = resolve })
        return { provider: "codex", interrupt: async () => { release() }, close: async () => { release() }, stream: (async function* () { await stopped })() }
      }, stopAll: async () => {},
    } as never,
  })
  cleanup.push(() => coordinator.shutdown())
  const schedule = create(f)
  const run: ScheduleRun = { id: crypto.randomUUID(), scheduleId: schedule.id, projectId: f.project.id, chatId: f.chat.id, name: schedule.name, scheduledFor: Date.now(), state: "claimed", execution: schedule.execution, cwd: f.project.localPath }
  expect((await coordinator.tryStartScheduledTurn(schedule, run)).status).toBe("started")
  await coordinator.cancel(f.chat.id)
  expect((await coordinator.tryStartScheduledTurn(schedule, { ...run, id: crypto.randomUUID() })).status).toBe("started")
  expect(starts).toBe(2)
})
