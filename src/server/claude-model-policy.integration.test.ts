import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ClientCommand, ServerEnvelope } from "../shared/protocol"
import { BUNDLED_CLAUDE_MODEL_POLICY } from "../shared/types"
import { applyServerClaudeModelPolicy } from "./provider-catalog"
import { startStillOnServer } from "./server"
import { freePort } from "../../scripts/connect-fixture"
import { upstreamWebSocket } from "./connect/relay"

function connect(port: number) {
  const ws = upstreamWebSocket(`ws://127.0.0.1:${port}/ws`, new Headers({ Origin: `http://127.0.0.1:${port}` }))
  const messages: ServerEnvelope[] = []
  const pending = new Map<string, (message: ServerEnvelope) => void>()
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as ServerEnvelope
    messages.push(message)
    if ((message.type === "ack" || message.type === "error") && message.id) pending.get(message.id)?.(message)
  })
  let serial = 0
  return { ws, messages,
    opened: new Promise<void>((resolve, reject) => { ws.addEventListener("open", () => resolve()); ws.addEventListener("error", () => reject(new Error("Connection failed"))) }),
    command(command: ClientCommand) {
      const id = `command-${serial++}`
      return new Promise<ServerEnvelope>((resolve, reject) => {
        const timeout = setTimeout(() => { pending.delete(id); reject(new Error("Command timeout")) }, 5_000)
        pending.set(id, (message) => { clearTimeout(timeout); pending.delete(id); resolve(message) })
        ws.send(JSON.stringify({ v: 1, type: "command", id, command }))
      })
    },
  }
}

test("Claude models sync to two clients before preference normalization, retain history and survive restart", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "stillon-claude-integration-"))
  let server: Awaited<ReturnType<typeof startStillOnServer>> | undefined
  const clients: ReturnType<typeof connect>[] = []
  try {
    const start = () => startStillOnServer({ dataDir, discoveryHome: dataDir, port: freePort(), strictPort: true, openBrowser: false,
      claudeModelDiscovery: { discover: async () => [{ value: "sonnet", resolvedModel: "claude-sonnet-next", displayName: "Sonnet Next" }] } })
    server = await start()
    const project = await server.store.openProject(dataDir, "Example")
    const chat = await server.store.createChat(project.id)
    await server.store.setChatTurnPreferences(chat.id, { provider: "claude", model: "claude-sonnet-4-6", modelOptions: { reasoningEffort: "high", contextWindow: "200k" }, permissionMode: "acceptEdits" })
    const history = await server.store.readAllMessages(chat.id), previous = structuredClone(server.store.getChat(chat.id)?.lastTurnPreferences)
    const a = connect(server.port), b = connect(server.port); clients.push(a, b)
    await Promise.all([a.opened, b.opened])
    for (const client of clients) client.ws.send(JSON.stringify({ v: 1, type: "subscribe", id: "claude-catalog", topic: { type: "claude-model-policy" } }))
    const first = await a.command({ type: "settings.readClaudeModelPolicy" })
    expect(first.type).toBe("ack")
    if (first.type === "ack") expect((first.result as any).policy).toEqual(BUNDLED_CLAUDE_MODEL_POLICY)
    const discovered = await a.command({ type: "settings.discoverClaudeModels" })
    expect(discovered.type).toBe("ack")
    const draft = (discovered as any).result
    const policy = { models: draft.models.filter((model: any) => model.id === "claude-sonnet-next"), defaultModel: "claude-sonnet-next" }
    expect((await a.command({ type: "settings.applyClaudeModelSelection", selection: { baseRevision: draft.baseRevision, policy } })).type).toBe("ack")
    const settings = await b.command({ type: "settings.readAppSettings" })
    expect(b.messages.some((message) => message.claudeModelPolicy?.policy.defaultModel === "claude-sonnet-next")).toBe(true)
    expect((settings as any).result.providerDefaults.claude.model).toBe("claude-sonnet-next")
    expect((await a.command({ type: "settings.writeAppSettingsPatch", patch: { providerDefaults: { claude: { model: "claude-sonnet-next" } } } })).type).toBe("ack")
    const c = connect(server.port); clients.push(c); await c.opened
    const reconnect = await c.command({ type: "settings.readAppSettings" })
    expect(reconnect.claudeModelPolicy?.policy).toEqual(policy)
    expect(await server.store.readAllMessages(chat.id)).toEqual(history)
    expect(server.store.getChat(chat.id)?.lastTurnPreferences).toEqual(previous)
    const url = `http://127.0.0.1:${server.port}/api/claude/model-policy`
    expect((await fetch(url, { method: "GET" })).headers.get("cache-control")).toBe("no-store")
    const denied = await fetch(url + "/apply", { method: "POST", headers: { origin: "https://untrusted.example" }, body: "{}" })
    expect(denied.status).toBe(403)
    for (const client of clients) client.ws.close()
    await server.stop(); server = await start()
    expect((await (await fetch(`http://127.0.0.1:${server.port}/api/claude/model-policy`)).json()).policy).toEqual(policy)
  } finally {
    for (const client of clients) client.ws.close()
    await server?.stop(); applyServerClaudeModelPolicy(BUNDLED_CLAUDE_MODEL_POLICY)
    await rm(dataDir, { recursive: true, force: true })
  }
}, 20_000)
