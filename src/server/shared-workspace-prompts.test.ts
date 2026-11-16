import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { AppSettingsManager, readAppSettingsSnapshot } from "./app-settings"
import { EventStore } from "./event-store"
import { createWsRouter } from "./ws-router"

test("shared prompt edits persist across owner and guest sessions with scope and validation enforced", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "stillon-shared-prompts-"))
  const store = new EventStore(path.join(directory, "data"))
  await store.initialize()
  const shared = await store.openProject(path.join(directory, "shared"), "Shared")
  const privateProject = await store.openProject(path.join(directory, "private"), "Private")
  const settingsPath = path.join(directory, "settings.json")
  const appSettings = new AppSettingsManager(settingsPath)
  await appSettings.initialize()
  const prompt = { id: "brief", name: "Brief", prompt: "Summarize this workspace." }
  await appSettings.writePatch({ quickCommands: { workspaces: { [privateProject.id]: [prompt] } } })
  const originalGlobal = appSettings.getSnapshot().quickCommands!.global
  const router = createWsRouter({ store, appSettings,
    agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set() } as never,
    terminals: { getSnapshot: () => null, onEvent: () => () => {} } as never,
    keybindings: { getSnapshot: () => ({ bindings: {}, warning: null, filePathDisplay: "settings.json" }), onChange: () => () => {} } as never,
    refreshDiscovery: async () => [], getDiscoveredProjects: () => [], machineDisplayName: "Example computer",
  })
  const socket = (workspaceId?: string) => ({ data: { workspaceId, subscriptions: new Map() }, messages: [] as any[],
    send(message: string) { this.messages.push(JSON.parse(message)) } })
  const owner = socket(), guest = socket(shared.id)
  const command = async (ws: ReturnType<typeof socket>, command: unknown) => {
    await router.handleMessage(ws as never, JSON.stringify({ v: 1, type: "command", id: "request", command }))
    return ws.messages.at(-1)
  }
  const read = (ws: ReturnType<typeof socket>) => command(ws, { type: "settings.readAppSettings" })
  const write = (ws: ReturnType<typeof socket>, quickCommands: unknown) => command(ws, { type: "settings.writeAppSettingsPatch", patch: { quickCommands } })
  try {
    expect((await write(guest, { workspaces: { [shared.id]: [prompt] } })).type).toBe("ack")
    expect((await read(owner)).result.quickCommands.workspaces[shared.id]).toEqual([prompt])
    expect((await read(guest)).result.quickCommands.workspaces).toEqual({ [shared.id]: [prompt] })
    const edited = { ...prompt, prompt: "Prepare a handoff." }
    expect((await write(owner, { workspaces: { [shared.id]: [edited] } })).type).toBe("ack")
    expect((await read(guest)).result.quickCommands.workspaces[shared.id]).toEqual([edited])
    expect((await readAppSettingsSnapshot(settingsPath)).quickCommands!.workspaces[shared.id]).toEqual([edited])
    for (const patch of [{ global: [] }, { workspaces: { [privateProject.id]: [] } },
      { workspaces: { [shared.id]: [], [privateProject.id]: [] } }, { workspaces: { [shared.id]: [{ ...prompt, prompt: "" }] } }]) {
      expect((await write(guest, patch)).type).toBe("error")
      expect((await read(guest)).result.quickCommands.workspaces[shared.id]).toEqual([edited])
    }
    expect(appSettings.getSnapshot().quickCommands!.global).toEqual(originalGlobal)
    expect(appSettings.getSnapshot().quickCommands!.workspaces[privateProject.id]).toEqual([prompt])
    expect((await write(guest, { workspaces: { [shared.id]: null } })).type).toBe("ack")
    expect((await read(owner)).result.quickCommands.workspaces[shared.id]).toBeUndefined()
    expect((await readAppSettingsSnapshot(settingsPath)).quickCommands!.workspaces[privateProject.id]).toEqual([prompt])
  } finally {
    router.dispose(); appSettings.dispose(); await store.compact(); await rm(directory, { recursive: true, force: true })
  }
})
