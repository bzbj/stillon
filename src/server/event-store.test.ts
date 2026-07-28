import { afterEach, describe, expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { TranscriptEntry } from "../shared/types"
import type { SnapshotFile } from "./events"
import { EventStore } from "./event-store"

const originalRuntimeProfile = process.env.STILLON_RUNTIME_PROFILE
const tempDirs: string[] = []

afterEach(async () => {
  if (originalRuntimeProfile === undefined) {
    delete process.env.STILLON_RUNTIME_PROFILE
  } else {
    process.env.STILLON_RUNTIME_PROFILE = originalRuntimeProfile
  }

  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function createTempDataDir() {
  const dir = await mkdtemp(join(tmpdir(), "kanna-event-store-"))
  tempDirs.push(dir)
  return dir
}

function entry(kind: "user_prompt" | "assistant_text", createdAt: number, extra: Record<string, unknown> = {}): TranscriptEntry {
  const base = { _id: `${kind}-${createdAt}`, createdAt }
  if (kind === "user_prompt") {
    return { ...base, kind, content: String(extra.content ?? "") }
  }
  return { ...base, kind, text: String(extra.content ?? extra.text ?? "") }
}

describe("EventStore", () => {
  test("uses the runtime profile for the default data dir", () => {
    process.env.STILLON_RUNTIME_PROFILE = "dev"

    const store = new EventStore()

    expect(store.dataDir).toEndWith("/.stillon-dev/data")
  })

  test("migrates legacy snapshot and messages log transcripts into per-chat files", async () => {
    const dataDir = await createTempDataDir()
    const snapshotPath = join(dataDir, "snapshot.json")
    const messagesLogPath = join(dataDir, "messages.jsonl")
    const chatId = "chat-1"

    const snapshot: SnapshotFile = {
      v: 2,
      generatedAt: 10,
      projects: [{
        id: "project-1",
        localPath: "/tmp/project",
        title: "Project",
        createdAt: 1,
        updatedAt: 5,
      }],
      chats: [{
        id: chatId,
        projectId: "project-1",
        title: "Chat",
        createdAt: 1,
        updatedAt: 5,
        unread: false,
        provider: null,
        planMode: false,
        sessionToken: null,
        lastTurnOutcome: null,
      }],
      messages: [{
        chatId,
        entries: [
          entry("user_prompt", 100, { content: "hello" }),
        ],
      }],
    }

    await writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), "utf8")
    await writeFile(messagesLogPath, `${JSON.stringify({
      v: 2,
      type: "message_appended",
      timestamp: 101,
      chatId,
      entry: entry("assistant_text", 101, { content: "world" }),
    })}\n`, "utf8")

    const store = new EventStore(dataDir)
    await store.initialize()
    const legacyHistory = await store.getRecentChatHistoryWithDeliveryHead(chatId, 200)

    const progress: string[] = []
    const migrated = await store.migrateLegacyTranscripts((message) => {
      progress.push(message)
    })

    expect(migrated).toBe(true)
    expect(progress.some((message) => message.includes("transcript migration detected"))).toBe(true)
    expect(progress.at(-1)).toContain("transcript migration complete")
    expect(await store.readAllMessages(chatId)).toEqual([
      entry("user_prompt", 100, { content: "hello" }),
      entry("assistant_text", 101, { text: "world" }),
    ])

    const migratedSnapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as SnapshotFile
    expect(migratedSnapshot.messages).toBeUndefined()
    expect(await readFile(messagesLogPath, "utf8")).toBe("")
    expect(await readFile(join(dataDir, "transcripts", `${chatId}.jsonl`), "utf8")).toContain('"kind":"assistant_text"')
    const deliveryAfterMigration = store.getTranscriptAppendsSince(chatId, legacyHistory.deliveryHead)
    expect(deliveryAfterMigration.type).toBe("reset")
    expect(deliveryAfterMigration.deliveryHead.revision).not.toBe(legacyHistory.deliveryHead.revision)
  })

  test("appends new transcript entries only to the per-chat transcript file", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    await store.appendMessage(chat.id, entry("user_prompt", 200, { content: "hello" }))
    await store.appendMessage(chat.id, entry("assistant_text", 201, { content: "world" }))
    await store.compact()

    expect(await store.readAllMessages(chat.id)).toEqual([
      entry("user_prompt", 200, { content: "hello" }),
      entry("assistant_text", 201, { text: "world" }),
    ])
    expect(await readFile(join(dataDir, "messages.jsonl"), "utf8")).toBe("")

    const snapshot = JSON.parse(await readFile(join(dataDir, "snapshot.json"), "utf8")) as SnapshotFile
    expect(snapshot.messages).toBeUndefined()
    expect(existsSync(join(dataDir, "transcripts", `${chat.id}.jsonl`))).toBe(true)
  })

  test("pages recent transcript history and older entries by cursor", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)

    for (let index = 1; index <= 5; index += 1) {
      await store.appendMessage(chat.id, entry(index % 2 === 0 ? "assistant_text" : "user_prompt", 200 + index, {
        content: `message-${index}`,
      }))
    }

    const recentPage = await store.getRecentMessagesPage(chat.id, 2)
    expect(recentPage.messages.map((message) => message._id)).toEqual(["assistant_text-204", "user_prompt-205"])
    expect(recentPage.hasOlder).toBe(true)
    expect(recentPage.olderCursor?.startsWith("h2.")).toBe(true)

    await store.appendMessage(chat.id, entry("assistant_text", 206, { content: "message-6" }))
    await store.appendMessage(chat.id, entry("user_prompt", 207, { content: "message-7" }))

    const olderPage = await store.getMessagesPageBefore(chat.id, recentPage.olderCursor!, 2)
    expect(olderPage.messages.map((message) => message._id)).toEqual(["assistant_text-202", "user_prompt-203"])
    expect(olderPage.hasOlder).toBe(true)
    expect(olderPage.olderCursor).not.toBeNull()
    expect(olderPage.revision).toBe(recentPage.revision)

    const oldestPage = await store.getMessagesPageBefore(chat.id, olderPage.olderCursor!, 2)
    expect(oldestPage.messages.map((message) => message._id)).toEqual(["user_prompt-201"])
    expect(oldestPage.hasOlder).toBe(false)
    expect(oldestPage.olderCursor).toBeNull()
  })

  test("captures recent history and its delivery head atomically while preserving append order", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    const first = entry("user_prompt", 301, { content: "first" })
    const second = entry("assistant_text", 302, { content: "second" })
    const third = entry("assistant_text", 303, { content: "third" })
    await store.appendMessage(chat.id, first)

    const historyPromise = store.getRecentChatHistoryWithDeliveryHead(chat.id, 200)
    const secondAppend = store.appendMessage(chat.id, second)
    const thirdAppend = store.appendMessage(chat.id, third)
    const [history] = await Promise.all([historyPromise, secondAppend, thirdAppend])

    expect(history.messages.map((message) => message._id)).toEqual([first._id])
    expect(history.deliveryHead.sequence).toBe(1)
    expect(store.getTranscriptAppendsSince(chat.id, history.deliveryHead)).toEqual({
      type: "appends",
      entries: [second, third],
      deliveryHead: {
        revision: history.deliveryHead.revision,
        sequence: 3,
      },
    })
  })

  test("bounds retained appends globally by count while preserving per-chat coverage", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir, {
      transcriptAppendJournal: {
        maxEntries: 2,
        maxBytes: 1024 * 1024,
      },
    })
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const firstChat = await store.createChat(project.id)
    const secondChat = await store.createChat(project.id)
    const firstBase = await store.getRecentChatHistoryWithDeliveryHead(firstChat.id, 200)
    const secondBase = await store.getRecentChatHistoryWithDeliveryHead(secondChat.id, 200)
    const firstEntry = entry("user_prompt", 311, { content: "first chat, first entry" })
    const secondEntry = entry("assistant_text", 312, { content: "second chat" })
    const thirdEntry = entry("assistant_text", 313, { content: "first chat, second entry" })

    await store.appendMessage(firstChat.id, firstEntry)
    const firstAfterOne = store.getTranscriptAppendsSince(firstChat.id, firstBase.deliveryHead)
    expect(firstAfterOne.type).toBe("appends")
    await store.appendMessage(secondChat.id, secondEntry)
    await store.appendMessage(firstChat.id, thirdEntry)

    expect(store.getTranscriptAppendsSince(firstChat.id, firstBase.deliveryHead).type).toBe("reset")
    if (firstAfterOne.type !== "appends") throw new Error("Expected retained append")
    expect(store.getTranscriptAppendsSince(firstChat.id, firstAfterOne.deliveryHead)).toMatchObject({
      type: "appends",
      entries: [thirdEntry],
    })
    expect(store.getTranscriptAppendsSince(secondChat.id, secondBase.deliveryHead)).toMatchObject({
      type: "appends",
      entries: [secondEntry],
    })
  })

  test("uses UTF-8 bytes for the global append journal budget", async () => {
    const dataDir = await createTempDataDir()
    const unicodeEntry = entry("assistant_text", 321, { content: "🙂🙂🙂🙂" })
    const payload = `${JSON.stringify(unicodeEntry)}\n`
    expect(Buffer.byteLength(payload, "utf8")).toBeGreaterThan(payload.length)
    const store = new EventStore(dataDir, {
      transcriptAppendJournal: {
        maxEntries: 10,
        maxBytes: payload.length,
      },
    })
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    const base = await store.getRecentChatHistoryWithDeliveryHead(chat.id, 200)
    await store.appendMessage(chat.id, unicodeEntry)

    expect(store.getTranscriptAppendsSince(chat.id, base.deliveryHead)).toMatchObject({
      type: "reset",
      deliveryHead: { sequence: 1 },
    })
  })

  test("resets delivery after restart because the append journal is process-local", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    await store.appendMessage(chat.id, entry("user_prompt", 331, { content: "persisted" }))
    const history = await store.getRecentChatHistoryWithDeliveryHead(chat.id, 200)

    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()
    const result = reloaded.getTranscriptAppendsSince(chat.id, history.deliveryHead)

    expect(result.type).toBe("reset")
    expect(result.deliveryHead.sequence).toBe(0)
    expect(result.deliveryHead.revision).not.toBe(history.deliveryHead.revision)
  })

  test("does not advance delivery sequence when the JSONL append fails", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    const history = await store.getRecentChatHistoryWithDeliveryHead(chat.id, 200)
    const transcriptsPath = join(dataDir, "transcripts")
    await rm(transcriptsPath, { recursive: true, force: true })
    await writeFile(transcriptsPath, "blocks transcript directory recreation", "utf8")

    await expect(
      store.appendMessage(chat.id, entry("assistant_text", 341, { content: "must fail" })),
    ).rejects.toThrow()
    expect(store.getTranscriptAppendsSince(chat.id, history.deliveryHead)).toEqual({
      type: "appends",
      entries: [],
      deliveryHead: history.deliveryHead,
    })
  })

  test("persists queued messages across restart and removes promoted entries", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)

    const first = await store.enqueueMessage(chat.id, {
      content: "first queued",
      attachments: [],
      provider: "codex",
      model: "gpt-5.4",
    })
    const second = await store.enqueueMessage(chat.id, {
      content: "second queued",
      attachments: [],
      provider: "claude",
      model: "claude-sonnet-4-6",
    })

    expect(store.getQueuedMessages(chat.id).map((message) => message.content)).toEqual([
      "first queued",
      "second queued",
    ])

    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()
    expect(reloaded.getQueuedMessages(chat.id).map((message) => message.content)).toEqual([
      "first queued",
      "second queued",
    ])

    await reloaded.removeQueuedMessage(chat.id, first.id)
    expect(reloaded.getQueuedMessages(chat.id).map((message) => message.id)).toEqual([second.id])
  })

  test("marks chats unread on completed turns and clears unread when marked read", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)

    expect(store.getChat(chat.id)?.unread).toBe(false)

    await store.recordTurnFinished(chat.id)
    expect(store.getChat(chat.id)?.unread).toBe(true)

    await store.setChatReadState(chat.id, false)
    expect(store.getChat(chat.id)?.unread).toBe(false)

    await store.recordTurnFailed(chat.id, "boom")
    expect(store.getChat(chat.id)?.unread).toBe(true)

    await store.recordTurnCancelled(chat.id)
    expect(store.getChat(chat.id)?.unread).toBe(true)

    await store.compact()

    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()
    expect(reloaded.getChat(chat.id)?.unread).toBe(true)
  })

  test("preserves read state after a finished turn across restart", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)

    await store.recordTurnFinished(chat.id)
    await store.setChatReadState(chat.id, false)

    expect(store.getChat(chat.id)?.unread).toBe(false)

    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()

    expect(reloaded.getChat(chat.id)?.unread).toBe(false)
  })

  test("preserves read state after a failed turn across restart", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)

    await store.recordTurnFailed(chat.id, "boom")
    await store.setChatReadState(chat.id, false)

    expect(store.getChat(chat.id)?.unread).toBe(false)

    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()

    expect(reloaded.getChat(chat.id)?.unread).toBe(false)
  })

  test("prefers mark-read over turn completion when replay timestamps tie", async () => {
    const dataDir = await createTempDataDir()
    const chatsLogPath = join(dataDir, "chats.jsonl")
    const turnsLogPath = join(dataDir, "turns.jsonl")
    const projectId = "project-1"
    const chatId = "chat-1"
    const timestamp = 100

    await writeFile(chatsLogPath, [
      JSON.stringify({
        v: 2,
        type: "chat_created",
        timestamp,
        chatId,
        projectId,
        title: "Chat",
      }),
      JSON.stringify({
        v: 2,
        type: "chat_read_state_set",
        timestamp,
        chatId,
        unread: false,
      }),
      "",
    ].join("\n"), "utf8")
    await writeFile(turnsLogPath, [
      JSON.stringify({
        v: 2,
        type: "turn_finished",
        timestamp,
        chatId,
      }),
      "",
    ].join("\n"), "utf8")

    const store = new EventStore(dataDir)
    await store.initialize()

    expect(store.getChat(chatId)?.unread).toBe(false)
  })

  test("loads chats without unread from older snapshots as read", async () => {
    const dataDir = await createTempDataDir()
    const snapshotPath = join(dataDir, "snapshot.json")

    const snapshot = {
      v: 2,
      generatedAt: 10,
      projects: [{
        id: "project-1",
        localPath: "/tmp/project",
        title: "Project",
        createdAt: 1,
        updatedAt: 5,
      }],
      chats: [{
        id: "chat-1",
        projectId: "project-1",
        title: "Chat",
        createdAt: 1,
        updatedAt: 5,
        provider: null,
        planMode: false,
        sessionToken: null,
        lastTurnOutcome: null,
      }],
    }

    await writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), "utf8")

    const store = new EventStore(dataDir)
    await store.initialize()

    expect(store.getChat("chat-1")?.unread).toBe(false)
  })

  test("isolates a corrupt snapshot and recovers chat history from event logs", async () => {
    const dataDir = await createTempDataDir()
    const projectId = "project-1"
    const chatId = "chat-1"
    const projectsLogPath = join(dataDir, "projects.jsonl")
    const chatsLogPath = join(dataDir, "chats.jsonl")

    await writeFile(join(dataDir, "snapshot.json"), "{not-json", "utf8")
    await writeFile(projectsLogPath, `${JSON.stringify({
      v: 2,
      type: "project_opened",
      timestamp: 1,
      projectId,
      localPath: "/tmp/project",
      title: "Project",
    })}\n`, "utf8")
    await writeFile(chatsLogPath, `${JSON.stringify({
      v: 2,
      type: "chat_created",
      timestamp: 2,
      chatId,
      projectId,
      title: "Recovered chat",
    })}\n`, "utf8")

    const originalWarn = console.warn
    console.warn = () => {}
    try {
      const store = new EventStore(dataDir)
      await store.initialize()

      expect(store.getProject(projectId)?.title).toBe("Project")
      expect(store.getChat(chatId)?.title).toBe("Recovered chat")
      expect(await readFile(projectsLogPath, "utf8")).toContain("project_opened")
      expect(await readFile(chatsLogPath, "utf8")).toContain("chat_created")
      expect((await readdir(dataDir)).some((name) => name.startsWith("snapshot.json.corrupt-"))).toBe(true)
    } finally {
      console.warn = originalWarn
    }
  })

  test("recovers a corrupt current snapshot from its retained predecessor and archived logs", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    await store.compact()

    await store.renameChat(chat.id, "Renamed after first snapshot")
    await store.compact()

    expect(existsSync(join(dataDir, "snapshot.json.bak"))).toBe(true)
    expect(await readFile(join(dataDir, "chats.jsonl.bak"), "utf8")).toContain("chat_renamed")
    await writeFile(join(dataDir, "snapshot.json"), "{not-json", "utf8")

    const originalWarn = console.warn
    console.warn = () => {}
    try {
      const recovered = new EventStore(dataDir)
      await recovered.initialize()

      expect(recovered.getChat(chat.id)?.title).toBe("Renamed after first snapshot")
    } finally {
      console.warn = originalWarn
    }
  })

  test("persists sidebar project order across restart and compaction", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const first = await store.openProject("/tmp/project-a")
    const second = await store.openProject("/tmp/project-b")

    await store.setSidebarProjectOrder([second.id, first.id])
    expect(store.getSidebarProjectOrder()).toEqual([second.id, first.id])
    expect(JSON.parse(await readFile(join(dataDir, "sidebar-order.json"), "utf8"))).toEqual([second.id, first.id])

    await store.compact()

    const snapshot = JSON.parse(await readFile(join(dataDir, "snapshot.json"), "utf8")) as SnapshotFile
    expect(snapshot.sidebarProjectOrder).toBeUndefined()

    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()
    expect(reloaded.getSidebarProjectOrder()).toEqual([second.id, first.id])
  })

  test("renames a project sidebar title without changing project metadata or local path", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()
    const projectPath = join(dataDir, "project")

    const project = await store.openProject(projectPath)
    await store.renameProjectSidebarTitle(project.id, "Sidebar Name")

    expect(store.getProject(project.id)?.title).toBe("project")
    expect(store.getProject(project.id)?.sidebarTitle).toBe("Sidebar Name")
    expect(store.getProject(project.id)?.localPath).toBe(projectPath)
    expect(store.state.projectIdsByPath.get(projectPath)).toBe(project.id)

    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()

    expect(reloaded.getProject(project.id)?.title).toBe("project")
    expect(reloaded.getProject(project.id)?.sidebarTitle).toBe("Sidebar Name")
    expect(reloaded.getProject(project.id)?.localPath).toBe(projectPath)
    expect(reloaded.state.projectIdsByPath.get(projectPath)).toBe(project.id)

    await reloaded.renameProjectSidebarTitle(project.id, "")
    expect(reloaded.getProject(project.id)?.title).toBe("project")
    expect(reloaded.getProject(project.id)?.sidebarTitle).toBeUndefined()
    expect(reloaded.getProject(project.id)?.localPath).toBe(projectPath)
  })

  test("migrates legacy sidebar project order from existing snapshots and project logs", async () => {
    const dataDir = await createTempDataDir()
    const snapshotPath = join(dataDir, "snapshot.json")
    const projectsLogPath = join(dataDir, "projects.jsonl")

    const snapshot: SnapshotFile = {
      v: 2,
      generatedAt: 10,
      projects: [
        {
          id: "project-1",
          localPath: "/tmp/project-a",
          title: "Project A",
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: "project-2",
          localPath: "/tmp/project-b",
          title: "Project B",
          createdAt: 2,
          updatedAt: 2,
        },
      ],
      chats: [],
      sidebarProjectOrder: ["project-1"],
    }

    await writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), "utf8")
    await writeFile(projectsLogPath, [
      JSON.stringify({
        v: 2,
        type: "sidebar_project_order_set",
        timestamp: 20,
        projectIds: ["project-2", "project-1"],
      }),
      "",
    ].join("\n"), "utf8")

    const store = new EventStore(dataDir)
    await store.initialize()

    expect(store.getSidebarProjectOrder()).toEqual(["project-2", "project-1"])
    expect(JSON.parse(await readFile(join(dataDir, "sidebar-order.json"), "utf8"))).toEqual(["project-2", "project-1"])
  })

  test("ignores an invalid sidebar order file without resetting store state", async () => {
    const dataDir = await createTempDataDir()
    const projectPath = join(dataDir, "project")
    await writeFile(join(dataDir, "sidebar-order.json"), "{not-json", "utf8")

    const originalWarn = console.warn
    console.warn = () => {}
    try {
      const store = new EventStore(dataDir)
      await store.initialize()

      const project = await store.openProject(projectPath)

      const reloaded = new EventStore(dataDir)
      await reloaded.initialize()

      expect(reloaded.getProject(project.id)?.localPath).toBe(projectPath)
      expect(reloaded.getSidebarProjectOrder()).toEqual([])
    } finally {
      console.warn = originalWarn
    }
  })

  test("prunes stale empty chats after thirty minutes", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    const staleNow = chat.createdAt + 30 * 60 * 1000

    const pruned = await store.pruneStaleEmptyChats({ now: staleNow })

    expect(pruned).toEqual([chat.id])
    expect(store.getChat(chat.id)).toBeNull()
  })

  test("does not prune recent empty chats", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    const pruned = await store.pruneStaleEmptyChats({ now: chat.createdAt + 30 * 60 * 1000 - 1 })

    expect(pruned).toEqual([])
    expect(store.getChat(chat.id)?.id).toBe(chat.id)
  })

  test("does not prune chats once they have transcript messages", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    await store.appendMessage(chat.id, entry("user_prompt", chat.createdAt + 1, { content: "hello" }))

    const pruned = await store.pruneStaleEmptyChats({ now: chat.createdAt + 30 * 60 * 1000 })

    expect(pruned).toEqual([])
    expect(store.getChat(chat.id)?.id).toBe(chat.id)
  })

  test("does not prune stale chats that are currently active", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)

    const pruned = await store.pruneStaleEmptyChats({
      now: chat.createdAt + 30 * 60 * 1000,
      activeChatIds: [chat.id],
    })

    expect(pruned).toEqual([])
    expect(store.getChat(chat.id)?.id).toBe(chat.id)
  })

  test("does not prune stale chats with protected draft state", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)

    const pruned = await store.pruneStaleEmptyChats({
      now: chat.createdAt + 30 * 60 * 1000,
      protectedChatIds: [chat.id],
    })

    expect(pruned).toEqual([])
    expect(store.getChat(chat.id)?.id).toBe(chat.id)
  })

  test("forks a chat with copied transcript and pending fork session token", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const source = await store.createChat(project.id)
    await store.setChatProvider(source.id, "claude")
    await store.setPlanMode(source.id, true)
    await store.setSessionToken(source.id, "session-1")
    await store.appendMessage(source.id, entry("user_prompt", source.createdAt + 1, { content: "analyze this" }))
    await store.appendMessage(source.id, entry("assistant_text", source.createdAt + 2, { text: "done" }))

    const forked = await store.forkChat(source.id)

    expect(forked.id).not.toBe(source.id)
    expect(forked.title).toBe("Fork: New Chat")
    expect(forked.provider).toBe("claude")
    expect(forked.planMode).toBe(true)
    expect(forked.sessionToken).toBeNull()
    expect(forked.pendingForkSessionToken).toBe("session-1")
    expect(forked.lastTurnOutcome).toBeNull()
    expect(forked.lastMessageAt).toBeUndefined()
    expect(await store.readAllMessages(forked.id)).toEqual(await store.readAllMessages(source.id))
  })

  test("reopening a removed project restores its existing chats", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)

    await store.removeProject(project.id)
    expect(store.getProject(project.id)).toBeNull()

    const reopened = await store.openProject("/tmp/project")

    expect(reopened.id).toBe(project.id)
    expect(store.listChatsByProject(reopened.id).map((entry) => entry.id)).toEqual([chat.id])
  })

  test("archives chats without deleting their transcript", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    await store.appendMessage(chat.id, entry("user_prompt", chat.createdAt + 1, { content: "keep this" }))

    await store.archiveChat(chat.id)

    expect(store.getChat(chat.id)?.archivedAt).toBeNumber()
    expect(store.listChatsByProject(project.id)).toEqual([])
    expect((await store.readAllMessages(chat.id)).map((message) => message.kind)).toEqual(["user_prompt"])

    await store.unarchiveChat(chat.id)

    expect(store.getChat(chat.id)?.archivedAt).toBeUndefined()
    expect(store.listChatsByProject(project.id).map((entry) => entry.id)).toEqual([chat.id])
  })
})
