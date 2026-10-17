import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { EventStore } from "./event-store"
import { createWsRouter } from "./ws-router"

for (const fail of [false, true]) test(`quick command creates a new conversation in the captured workspace (${fail ? "agent unavailable" : "sent"})`, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "stillon-quick-command-"))
  const store = new EventStore(path.join(directory, "data"))
  await store.initialize()
  const project = await store.openProject(directory, "Example workspace")
  const old = await store.createChat(project.id)
  const sent: unknown[] = []
  const messages: any[] = []
  const router = createWsRouter({
    store,
    agent: {
      getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set(),
      async send(command: any) {
        sent.push(command)
        if (fail) throw new Error("Agent setup required")
        await store.appendMessage(command.chatId, { _id: "prompt", kind: "user_prompt", content: command.content, createdAt: Date.now() })
        return { chatId: command.chatId }
      },
    } as never,
    terminals: { getSnapshot: () => null, onEvent: () => () => {} } as never,
    keybindings: { getSnapshot: () => ({ bindings: {}, warning: null, filePathDisplay: "~/.stillon/keybindings.json" }), onChange: () => () => {} } as never,
    refreshDiscovery: async () => [], getDiscoveredProjects: () => [], machineDisplayName: "Example computer",
  })
  const ws = { data: { subscriptions: new Map() }, send: (message: string) => { messages.push(JSON.parse(message)) } }
  try {
    await router.handleMessage(ws as never, JSON.stringify({ v: 1, type: "command", id: "quick", command: {
      type: "chat.startQuickCommand", projectId: project.id, name: "Work Brief", content: "Prepare a work brief as HTML.",
      preferences: { provider: "codex", model: "gpt-6", permissionMode: "request", modelOptions: { reasoningEffort: "medium", fastMode: false } },
    } }))
    const response = messages.find(message => message.id === "quick")
    expect(response.type).toBe("ack")
    expect(response.result.chatId).not.toBe(old.id)
    expect(store.getChat(response.result.chatId)?.projectId).toBe(project.id)
    expect(sent).toEqual([expect.objectContaining({ chatId: response.result.chatId, content: "Prepare a work brief as HTML.", modelOptions: { codex: { reasoningEffort: "medium", fastMode: false } } })])
    expect(await store.hasMessages(old.id)).toBe(false)
    if (fail) expect(response.result).toMatchObject({ error: "Agent setup required", promptSaved: false })
    else expect(await store.hasMessages(response.result.chatId)).toBe(true)
  } finally { router.dispose(); await store.compact(); await rm(directory, { recursive: true, force: true }) }
})
