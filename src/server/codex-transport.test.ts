import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CodexTransportManager } from "./codex-transport"
import { CodexExecManager } from "./codex-exec"
import { CodexAppServerManager } from "./codex-app-server"
import { EventStore } from "./event-store"
import type { CodexTransport } from "../shared/types"

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), "stillon-transport-"))
  dirs.push(dir)
  const store = new EventStore(dir)
  await store.initialize()
  const project = await store.openProject(join(dir, "project"))
  let defaultTransport: CodexTransport = "exec"
  const calls: string[] = []
  const exec = {
    startSession: async () => {
      calls.push("exec")
      return "exec-thread"
    },
    getActiveTurnId: () => "exec-turn",
    stopSession: () => {},
    stopAll: () => {},
  } as unknown as CodexExecManager
  const appServer = {
    startSession: async () => {
      calls.push("app-server")
      return "app-thread"
    },
    getActiveTurnId: () => "app-turn",
    stopSession: () => {},
    stopAll: () => {},
  } as unknown as CodexAppServerManager
  const manager = new CodexTransportManager(
    store,
    () => defaultTransport,
    () => process.env,
    { exec, appServer },
  )
  return {
    store,
    project,
    manager,
    calls,
    setDefault: (value: CodexTransport) => { defaultTransport = value },
  }
}

describe("CodexTransportManager", () => {
  test("pins new chats and keeps exec after the default changes", async () => {
    const { store, project, manager, calls, setDefault } = await harness()
    const first = await store.createChat(project.id)
    await manager.startSession({ chatId: first.id, cwd: project.localPath, model: "gpt-6-sol", sessionToken: null })
    expect(store.requireChat(first.id).codexTransport).toBe("exec")

    setDefault("app-server")
    await manager.startSession({ chatId: first.id, cwd: project.localPath, model: "gpt-6-sol", sessionToken: "exec-thread" })
    expect(manager.supportsNativeSteerForChat(first.id)).toBe(false)

    const second = await store.createChat(project.id)
    await manager.startSession({ chatId: second.id, cwd: project.localPath, model: "gpt-6-sol", sessionToken: null })
    expect(store.requireChat(second.id).codexTransport).toBe("app-server")
    expect(manager.supportsNativeSteerForChat(second.id)).toBe(true)
    expect(calls).toEqual(["exec", "exec", "app-server"])

    setDefault("exec")
    const third = await store.createChat(project.id)
    await manager.startSession({ chatId: third.id, cwd: project.localPath, model: "gpt-6-sol", sessionToken: null })
    expect(calls.at(-1)).toBe("exec")
  })

  test("legacy Codex threads and their forks stay on exec", async () => {
    const { store, project, manager, calls, setDefault } = await harness()
    const legacy = await store.createChat(project.id)
    await store.setChatProvider(legacy.id, "codex")
    await store.setSessionToken(legacy.id, "old-thread")
    setDefault("app-server")
    await manager.startSession({ chatId: legacy.id, cwd: project.localPath, model: "gpt-6-sol", sessionToken: "old-thread" })
    const fork = await store.forkChat(legacy.id)
    expect(fork.codexTransport).toBe("exec")
    expect(calls).toEqual(["exec"])
  })
})
