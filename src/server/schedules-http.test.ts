import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { EventStore } from "./event-store"
import { ScheduleStore } from "./schedule-store"
import { ScheduleService } from "./schedule-service"
import { startStillOnServer } from "./server"
import type { Schedule } from "../shared/schedules"

test("schedule DELETE enforces session, origin, Workspace and revision, and acknowledges response retries", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stillon-schedule-http-"))
  let server: Awaited<ReturnType<typeof startStillOnServer>> | undefined
  try {
    const events = new EventStore(root); await events.initialize()
    const project = await events.openProject(path.join(root, "project"))
    const other = await events.openProject(path.join(root, "other"))
    const chat = await events.createChat(project.id)
    await events.setChatTurnPreferences(chat.id, { provider: "codex", model: "gpt-6.1-sol", modelOptions: { reasoningEffort: "high", fastMode: false }, permissionMode: "request" })
    const plans = new ScheduleStore(root)
    const service = new ScheduleService(plans, { events, start: async () => ({ status: "busy" }), changed: () => {} })
    const schedule = service.execute("set_schedule", { message: "Inspect", inMinutes: 1440 }, { projectId: project.id, chatId: chat.id, planning: false, automated: false }) as Schedule
    service.close(); await events.closeStatistics()
    const password = crypto.randomUUID()
    server = await startStillOnServer({ port: 0, host: "127.0.0.1", dataDir: root, password, discoveryHome: root,
      connect: { origin: "", environment: {}, runtimeRoot: root }, codexModelDiscovery: { discover: async () => { throw new Error("Disabled in test") } } })
    const origin = `http://127.0.0.1:${server.port}`
    const login = await fetch(origin + "/auth/login", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ password }) })
    const cookie = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ")
    expect(cookie.length).toBeGreaterThan(0)
    const args = { operationId: crypto.randomUUID(), expectedRevision: schedule.revision }
    const endpoint = (projectId: string) => `${origin}/api/projects/${projectId}/schedules/${schedule.id}`
    const remove = (body: object, options: { projectId?: string; origin?: string | null; authenticated?: boolean } = {}) => fetch(endpoint(options.projectId ?? project.id), { method: "DELETE", headers: { "Content-Type": "application/json", ...(options.origin === null ? {} : { Origin: options.origin ?? origin }), ...(options.authenticated === false ? {} : { Cookie: cookie }) }, body: JSON.stringify(body) })
    expect((await remove(args, { authenticated: false })).status).toBe(401)
    expect((await remove(args, { origin: null })).status).toBe(403)
    expect((await remove(args, { origin: "https://untrusted.example" })).status).toBe(403)
    expect((await remove(args, { projectId: other.id })).status).toBe(404)
    expect((await remove({ ...args, expectedRevision: 99 })).status).toBe(409)
    expect((await remove({ expectedRevision: schedule.revision })).status).toBe(400)
    const first = await remove(args); expect(first.status).toBe(200)
    const result = await first.json()
    const retry = await remove(args); expect(retry.status).toBe(200)
    expect(await retry.json()).toEqual(result)
    const view = await (await fetch(`${origin}/api/projects/${project.id}/schedules`, { headers: { Cookie: cookie } })).json()
    expect(view.schedules).toHaveLength(0)
    expect(server.store.getChat(chat.id)).not.toBeNull()
  } finally { await server?.stop(); await rm(root, { recursive: true, force: true }) }
}, 20000)
