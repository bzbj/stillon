import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ClientCommand, ServerEnvelope } from "../shared/protocol"
import { BUNDLED_CODEX_MODEL_POLICY, type CodexModelPolicy } from "../shared/codex-model-policy"
import { applyServerCodexModelPolicy } from "./provider-catalog"
import { startStillOnServer } from "./server"
import { upstreamWebSocket } from "./connect/relay"

function connect(port: number) {
  const ws = upstreamWebSocket(`ws://127.0.0.1:${port}/ws`, new Headers({ Origin: `http://127.0.0.1:${port}` }))
  const messages: ServerEnvelope[] = []
  const pending = new Map<string, { resolve: (value: ServerEnvelope) => void; reject: (error: Error) => void }>()
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as ServerEnvelope
    messages.push(message)
    if ((message.type === "ack" || message.type === "error") && message.id) {
      pending.get(message.id)?.resolve(message)
      pending.delete(message.id)
    }
  })
  let serial = 0
  return {
    ws, messages,
    opened: new Promise<void>((resolve, reject) => { ws.addEventListener("open", () => resolve()); ws.addEventListener("error", () => reject(new Error("Connection failed"))) }),
    command(command: ClientCommand) {
      const id = `command-${serial++}`
      return new Promise<ServerEnvelope>((resolve, reject) => {
        const timeout = setTimeout(() => { pending.delete(id); reject(new Error("Command timeout")) }, 5_000)
        pending.set(id, { resolve: (message) => { clearTimeout(timeout); resolve(message) }, reject })
        ws.send(JSON.stringify({ v: 1, type: "command", id, command }))
      })
    },
  }
}

test("runtime policy endpoint and two live clients refresh, reject, restore and reconnect", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "stillon-runtime-policy-integration-"))
  let server: Awaited<ReturnType<typeof startStillOnServer>> | undefined
  const clients: ReturnType<typeof connect>[] = []
  try {
    const reserved = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") })
    const port = reserved.port!
    await reserved.stop(true)
    server = await startStillOnServer({ dataDir, host: "127.0.0.1", port, strictPort: true, openBrowser: false })
    const project = await server.store.openProject(dataDir, "Model test")
    const chat = await server.store.createChat(project.id)
    await server.store.setChatTurnPreferences(chat.id, { provider: "codex", model: "gpt-6.1-sol",
      modelOptions: { reasoningEffort: "ultra", fastMode: true }, permissionMode: "full" })
    await server.store.appendMessage(chat.id, { kind: "system_init", _id: "original-init", createdAt: Date.now(), model: "gpt-6.1-sol",
      provider: "codex", tools: [], agents: [], slashCommands: [], mcpServers: [] })
    const beforeHistory = await server.store.readAllMessages(chat.id)
    const beforePreferences = structuredClone(server.store.getChat(chat.id)?.lastTurnPreferences)
    const a = connect(server.port), b = connect(server.port)
    clients.push(a, b)
    await Promise.all([a.opened, b.opened])
    for (const client of clients) client.ws.send(JSON.stringify({ v: 1, type: "subscribe", id: "catalog", topic: { type: "codex-model-policy" } }))
    const initial = await a.command({ type: "settings.readAppSettings" })
    expect(initial.type).toBe("ack")
    expect(a.messages.some((message) => JSON.stringify(message.codexModelPolicy?.policy) === JSON.stringify(BUNDLED_CODEX_MODEL_POLICY))).toBe(true)
    const future: CodexModelPolicy = { models: [{ id: "future-model", label: "Future Model", aliases: ["gpt-6.1-sol"],
      supportsEffort: true, supportedReasoningEfforts: ["high"], supportsFastMode: false }],
      roles: { conversation: "future-model", background: "future-model" } }
    await writeFile(path.join(dataDir, "codex-model-policy.json"), JSON.stringify({ schemaVersion: 1, policy: future }))
    expect((await a.command({ type: "settings.refreshCodexModelPolicy" })).type).toBe("ack")
    const settings = await a.command({ type: "settings.readAppSettings" })
    expect(settings.type).toBe("ack")
    if (settings.type === "ack") expect((settings.result as any).providerDefaults.codex).toMatchObject({ model: "future-model", modelOptions: { reasoningEffort: "high", fastMode: false } })
    const endpoint = await fetch(`http://127.0.0.1:${server.port}/api/codex/model-policy`)
    expect(endpoint.headers.get("cache-control")).toBe("no-store")
    expect((await endpoint.json()).policy).toEqual(future)
    // A read after the change also ensures the second connection has processed
    // preceding broadcasts on its ordered WebSocket stream.
    await b.command({ type: "settings.readCodexModelPolicy" })
    expect(b.messages.some((message) => message.type === "snapshot" && message.snapshot.type === "codex-model-policy" && message.snapshot.data.policy.roles.conversation === "future-model")).toBe(true)
    await writeFile(path.join(dataDir, "codex-model-policy.json"), "invalid")
    expect((await a.command({ type: "settings.refreshCodexModelPolicy" })).type).toBe("error")
    expect((await (await fetch(`http://127.0.0.1:${server.port}/api/codex/model-policy`)).json()).policy).toEqual(future)
    const c = connect(server.port)
    clients.push(c)
    await c.opened
    const reconnect = await c.command({ type: "settings.readAppSettings" })
    expect(reconnect.codexModelPolicy?.policy).toEqual(future)
    expect((await a.command({ type: "settings.restoreCodexModelPolicy", target: "previous" })).type).toBe("ack")
    expect(await server.store.readAllMessages(chat.id)).toEqual(beforeHistory)
    expect(server.store.getChat(chat.id)?.lastTurnPreferences).toEqual(beforePreferences)
    const blocked = await fetch(`http://127.0.0.1:${server.port}/api/codex/model-policy/refresh`, {
      method: "POST", headers: { origin: "https://untrusted.example" } })
    expect(blocked.status).toBe(403)
    const refreshed = await fetch(`http://127.0.0.1:${server.port}/api/codex/model-policy/refresh`, { method: "POST", headers: { Origin: `http://127.0.0.1:${server.port}` } })
    expect(refreshed.status).toBe(200)
    expect((await (await fetch(`http://127.0.0.1:${server.port}/api/codex/model-policy`)).json()).policy).toEqual(BUNDLED_CODEX_MODEL_POLICY)
  } finally {
    for (const client of clients) client.ws.close()
    await server?.stop()
    applyServerCodexModelPolicy(BUNDLED_CODEX_MODEL_POLICY)
    await rm(dataDir, { recursive: true, force: true })
  }
}, 15_000)

test("discovered candidates only become active after confirmation, synchronize clients and survive restart", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "stillon-selection-integration-"))
  const clients: ReturnType<typeof connect>[] = []
  let server: Awaited<ReturnType<typeof startStillOnServer>> | undefined
  const discovery = { getContext: async () => "test-account", discover: async () => ({ cliVersion: "0.159.2", models: [
    { id: "new-codex", model: "new-codex", displayName: "New Codex", supportedReasoningEfforts: [{ reasoningEffort: "high" }] },
  ] }) }
  try {
    const reserve = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
    const port = reserve.port!
    await reserve.stop(true)
    server = await startStillOnServer({ dataDir, port, strictPort: true, openBrowser: false, codexModelDiscovery: discovery })
    const project = await server.store.openProject(dataDir, "Selection test")
    const chat = await server.store.createChat(project.id)
    await server.store.setChatTurnPreferences(chat.id, { provider: "codex", model: "gpt-6.1-sol",
      modelOptions: { reasoningEffort: "high", fastMode: true }, permissionMode: "full" })
    const before = structuredClone(server.store.getChat(chat.id)?.lastTurnPreferences)
    const a = connect(port), b = connect(port)
    clients.push(a, b)
    await Promise.all([a.opened, b.opened])
    b.ws.send(JSON.stringify({ v: 1, type: "subscribe", id: "catalog", topic: { type: "codex-model-policy" } }))
    const response = await a.command({ type: "settings.discoverCodexModels" })
    expect(response.type).toBe("ack")
    if (response.type !== "ack") throw new Error("No draft")
    const draft = response.result as any
    const read = () => fetch(`http://127.0.0.1:${port}/api/codex/model-policy`).then((response) => response.json())
    expect((await read()).policy).toEqual(BUNDLED_CODEX_MODEL_POLICY)
    const selection = { draftId: draft.id, modelIds: ["new-codex"], roles: { conversation: "new-codex", background: "new-codex" } }
    const forbidden = await fetch(`http://127.0.0.1:${port}/api/codex/model-policy/apply`, {
      method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: JSON.stringify(selection) })
    expect(forbidden.status).toBe(403)
    expect((await a.command({ type: "settings.applyCodexModelSelection", selection })).type).toBe("ack")
    await b.command({ type: "settings.readCodexModelPolicy" })
    expect(b.messages.some((message) => message.type === "snapshot" && message.snapshot.type === "codex-model-policy"
      && message.snapshot.data.policy.models[0]?.id === "new-codex")).toBe(true)
    expect(server.store.getChat(chat.id)?.lastTurnPreferences).toEqual(before)
    const accepted = (await read()).policy
    for (const client of clients) client.ws.close()
    await server.stop()
    server = await startStillOnServer({ dataDir, port, strictPort: true, openBrowser: false, codexModelDiscovery: discovery })
    expect((await read()).policy).toEqual(accepted)
    expect(server.store.getChat(chat.id)?.lastTurnPreferences).toEqual(before)
    const c = connect(port)
    clients.push(c)
    await c.opened
    const settings = await c.command({ type: "settings.readAppSettings" })
    expect(settings.codexModelPolicy?.policy).toEqual(accepted)
    const httpDraft = await (await fetch(`http://127.0.0.1:${port}/api/codex/model-policy/discover`, { method: "POST", headers: { Origin: `http://127.0.0.1:${port}` } })).json()
    const applied = await fetch(`http://127.0.0.1:${port}/api/codex/model-policy/apply`, { method: "POST",
      headers: { "content-type": "application/json", Origin: `http://127.0.0.1:${port}` }, body: JSON.stringify({ ...selection, draftId: httpDraft.id }) })
    expect(applied.status).toBe(200)
    expect((await c.command({ type: "settings.restoreCodexModelPolicy", target: "previous" })).type).toBe("ack")
    expect((await read()).policy).toEqual(BUNDLED_CODEX_MODEL_POLICY)
  } finally {
    for (const client of clients) client.ws.close()
    await server?.stop()
    applyServerCodexModelPolicy(BUNDLED_CODEX_MODEL_POLICY)
    await rm(dataDir, { recursive: true, force: true })
  }
}, 15000)
