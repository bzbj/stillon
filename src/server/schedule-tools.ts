import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import path from "node:path"
import { scheduleInput, type ScheduleService, type ScheduleToolContext } from "./schedule-service"

export interface ScheduleBridgeConfig { url: string; token: string }
const tools = [
  { name: "set_schedule", description: "Create or update a persistent StillOn schedule in this workspace. Sends message to chatId (default this chat). Supply exactly one of inMinutes, runAt (ISO with offset), or dailyAt (HH:MM with IANA timeZone and optional weekdays, 0=Sunday). Daily defaults to all days. To pause/resume use scheduleId and enabled. Editing by id preserves unspecified fields. The user's request authorizes scheduling: no second confirmation is needed. Never invent a schedule without a request. Use list_schedules to find ids and revisions.", inputSchema: z.toJSONSchema(scheduleInput.required({ operationId: true })) },
  { name: "list_schedules", description: "List all StillOn schedules in the current workspace, their target conversations and recent runs. Does not discover Codex App automations. Use the returned schedule id and revision when editing.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "delete_schedule", description: "Delete a StillOn schedule by id. Stops future triggers, retains run history and conversation; does not interrupt a turn already running.", inputSchema: { type: "object", properties: { operationId: { type: "string", format: "uuid" }, scheduleId: { type: "string" }, expectedRevision: { type: "integer" } }, required: ["scheduleId", "operationId"], additionalProperties: false } },
]
/** Per-chat bearer, re-authorized against the actual current turn on every call. */
export class ScheduleToolBridge {
  private byChat = new Map<string, string>()
  private byToken = new Map<string, string>()
  private connections = new Set<Server>()
  private stopped = false
  private server: ReturnType<typeof Bun.serve>
  constructor(private service: ScheduleService, private context: (chatId: string) => ScheduleToolContext | null) {
    this.server = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: 128000, idleTimeout: 60,
      fetch: async request => {
        if (this.stopped || request.headers.has("origin")) return new Response("Forbidden", { status: 403 })
        const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? ""
        const chatId = this.byToken.get(token)
        if (!chatId) return new Response("Schedule tools are unavailable", { status: 403 })
        const url = new URL(request.url)
        if (url.pathname === "/call" && request.method === "POST") {
          try {
            const input = await request.json()
            const context = this.context(chatId)
            if (!context) return new Response("This turn cannot manage schedules", { status: 403 })
            return Response.json(this.execute(input.name, input.arguments ?? {}, context), { headers: { "Cache-Control": "no-store" } })
          } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Schedule request failed" }, { status: 400 }) }
        }
        if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 })
        // Stateless request/response tools have no server-initiated events.
        if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } })
        const mcp = new Server({ name: "stillon-schedules", version: "1.0.0" }, { capabilities: { tools: {} } })
        const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
        this.connections.add(mcp)
        mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))
        mcp.setRequestHandler(CallToolRequestSchema, async call => {
          try {
            const current = this.context(chatId!)
            if (!current) throw new Error("This turn no longer has schedule access")
            const result = this.execute(call.params.name, call.params.arguments ?? {}, current)
            return { content: [{ type: "text", text: JSON.stringify(result) }] }
          } catch (error) { return { content: [{ type: "text", text: error instanceof Error ? error.message : "Schedule request failed" }], isError: true } }
        })
        await mcp.connect(transport)
        const cleanup = () => { this.connections.delete(mcp); void mcp.close() }
        try {
          const response = await transport.handleRequest(request)
          if (!response.body) { cleanup(); return response }
          const reader = response.body.getReader()
          return new Response(new ReadableStream({
            async pull(controller) { try { const chunk = await reader.read(); if (chunk.done) { controller.close(); cleanup() } else controller.enqueue(chunk.value) } catch (error) { controller.error(error); cleanup() } },
            async cancel() { await reader.cancel(); cleanup() },
          }), response)
        } catch (error) { cleanup(); throw error }
      }, error: () => new Response("Schedule bridge unavailable", { status: 503 }),
    })
  }
  private execute(name: string, input: unknown, context: ScheduleToolContext) {
    if (name !== "list_schedules") z.object({ operationId: z.string().uuid() }).passthrough().parse(input)
    return this.service.execute(name, input, context)
  }
  forChat(chatId: string): ScheduleBridgeConfig {
    let token = this.byChat.get(chatId)
    if (!token) { token = crypto.randomUUID() + crypto.randomUUID(); this.byChat.set(chatId, token); this.byToken.set(token, chatId) }
    return { url: `http://127.0.0.1:${this.server.port}/mcp`, token }
  }
  async close() { this.stopped = true; this.byChat.clear(); this.byToken.clear(); await Promise.allSettled([...this.connections].map(c => c.close())); await this.server.stop(true) }
}
export function scheduleEnvironment(config?: ScheduleBridgeConfig): NodeJS.ProcessEnv {
  return config ? { STILLON_SCHEDULE_URL: config.url, STILLON_SCHEDULE_TOKEN: config.token } : {}
}
export function scheduleMcpArgs(environment: NodeJS.ProcessEnv): string[] {
  const url = environment.STILLON_SCHEDULE_URL
  if (!url || !environment.STILLON_SCHEDULE_TOKEN) return []
  return ["-c", `mcp_servers.stillon_schedules.url=${JSON.stringify(url)}`, "-c", 'mcp_servers.stillon_schedules.bearer_token_env_var="STILLON_SCHEDULE_TOKEN"']
}
export function scheduleInstructions() {
  const argv = JSON.stringify([process.execPath, path.resolve(import.meta.dir, "../../bin/stillon"), "schedule"])
  return `\n<stillon-schedules>\nFor every mutation include operationId (a new UUID); reuse that UUID only when retrying the same operation after a lost response. This conversation has persistent scheduling tools set_schedule, list_schedules, delete_schedule via the stillon_schedules MCP server. Use them when the user asks to schedule, inspect, edit, pause or delete recurring work. A schedule belongs to this StillOn workspace and targets a conversation; defaults to this one. Do not ask the user to configure cron or Codex App automations. Use an explicit ISO UTC offset for once or an IANA timeZone for dailyAt (weekdays: 0=Sun). If native MCP tools are unavailable, use the shell bridge: argv prefix ${argv}; append the tool name, and pipe its arguments as JSON on stdin. Example arguments for set_schedule: {"operationId":"<new UUID>","name":"Daily check","message":"Check and report","dailyAt":"09:00","timeZone":"Asia/Singapore"}. list_schedules takes {}. The bridge reads authentication from inherited environment; never print it. If permission denies the command, use the normal permission request rather than another scheduler.\n</stillon-schedules>`
}
export async function scheduleCli(argv: string[]) {
  const url = process.env.STILLON_SCHEDULE_URL, token = process.env.STILLON_SCHEDULE_TOKEN
  if (!url || !token) throw new Error("Schedule commands are available inside an authorized StillOn conversation")
  if (!["set_schedule", "list_schedules", "delete_schedule"].includes(argv[0] ?? "")) throw new Error("Usage: stillon schedule <set_schedule|list_schedules|delete_schedule> with JSON arguments on stdin")
  const input = await Bun.stdin.text()
  if (Buffer.byteLength(input) > 128000) throw new Error("Schedule input is too large")
  const response = await fetch(new URL("/call", url), { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ name: argv[0], arguments: input.trim() ? JSON.parse(input) : {} }), signal: AbortSignal.timeout(15000) })
  const result = await response.json()
  if (!response.ok) throw new Error((result as { error?: string }).error ?? "Schedule request failed")
  console.log(JSON.stringify(result))
}
