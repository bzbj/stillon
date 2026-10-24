import { afterEach, describe, expect, test } from "bun:test"
import { appendFile, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { TranscriptEntry } from "../shared/types"
import type { SnapshotFile } from "./events"
import { EventStore } from "./event-store"
import { getTranscriptMessagesSerializedBytes } from "./transcript-window"
import { deriveSidebarData } from "./read-models"

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
  const dir = await mkdtemp(join(tmpdir(), "stillon-event-store-"))
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

function toolCall(createdAt: number, toolId: string): TranscriptEntry {
  return {
    _id: `tool-call-${createdAt}`,
    kind: "tool_call",
    createdAt,
    tool: {
      kind: "tool",
      toolKind: "unknown_tool",
      toolName: "Example",
      toolId,
      input: { payload: {} },
    },
  }
}

function toolResult(createdAt: number, toolId: string, content: unknown): TranscriptEntry {
  return {
    _id: `tool-result-${createdAt}`,
    kind: "tool_result",
    createdAt,
    toolId,
    content,
  }
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
  })

  test("uses the same byte and tool-safe boundary before and after legacy migration", async () => {
    const dataDir = await createTempDataDir()
    const chatId = "chat-1"
    const entries = [
      entry("user_prompt", 100, { content: "oldest" }),
      toolCall(101, "tool-a"),
      toolResult(102, "tool-a", "界".repeat(2_000)),
      entry("assistant_text", 103, { text: "newest" }),
    ]
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
      messages: [{ chatId, entries }],
    }
    await writeFile(join(dataDir, "snapshot.json"), JSON.stringify(snapshot), "utf8")

    const store = new EventStore(dataDir)
    await store.initialize()
    const byteBudget = getTranscriptMessagesSerializedBytes([entries[3]!])
    const legacyPage = await store.getRecentMessagesPage(chatId, 40, byteBudget)

    await store.migrateLegacyTranscripts()
    const filePage = await store.getRecentMessagesPage(chatId, 40, byteBudget)

    expect(legacyPage.messages.map((message) => message._id)).toEqual(["assistant_text-103"])
    expect(filePage.messages.map((message) => message._id)).toEqual(
      legacyPage.messages.map((message) => message._id),
    )
    expect(filePage.hasOlder).toBe(legacyPage.hasOlder)
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

  test("restores sidebar order after an unclean restart without compaction", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()
    const project = await store.openProject("/tmp/project")
    const older = await store.createChat(project.id)
    const newer = await store.createChat(project.id)
    const now = Date.now()
    await store.appendMessage(older.id, entry("user_prompt", now + 1))
    await store.appendMessage(newer.id, entry("user_prompt", now + 2))
    await store.appendMessage(older.id, entry("user_prompt", now + 3))
    await store.appendMessage(older.id, entry("assistant_text", now + 4))

    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()
    expect(reloaded.getChat(older.id)?.lastMessageAt).toBe(now + 3)
    expect(reloaded.getChat(older.id)?.hasMessages).toBe(true)
    expect(deriveSidebarData(reloaded.state, new Map()).projectGroups[0]?.chats.map((chat) => chat.chatId))
      .toEqual([older.id, newer.id])
    expect(await reloaded.pruneStaleEmptyChats({ now: now + 60 * 60 * 1000 })).toEqual([])
  })

  test("recovers existing transcript activity newer than the saved snapshot", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()
    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    const now = Date.now()
    await store.appendMessage(chat.id, entry("user_prompt", now + 1))
    await store.compact()
    const snapshotPath = join(dataDir, "snapshot.json")
    const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as SnapshotFile
    delete snapshot.chats[0]!.transcriptMetadataOffset
    await writeFile(snapshotPath, JSON.stringify(snapshot), "utf8")

    // Older releases persisted these entries without journaling their metadata.
    const transcriptPath = join(dataDir, "transcripts", `${chat.id}.jsonl`)
    await writeFile(transcriptPath, [
      entry("user_prompt", now + 1),
      entry("assistant_text", now + 2),
      entry("user_prompt", now + 3, { content: "中文新消息" }),
      entry("assistant_text", now + 4),
    ].map((value) => JSON.stringify(value)).join("\r\n"), "utf8")

    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()
    expect(reloaded.getChat(chat.id)?.lastMessageAt).toBe(now + 3)
    const recoveredLog = await readFile(join(dataDir, "chats.jsonl"), "utf8")
    const again = new EventStore(dataDir)
    await again.initialize()
    expect(again.getChat(chat.id)?.lastMessageAt).toBe(now + 3)
    expect(await again.readAllMessages(chat.id)).toHaveLength(4)
    expect(await readFile(join(dataDir, "chats.jsonl"), "utf8")).toBe(recoveredLog)
  })

  test("recovers a prompt written before its metadata journal entry", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()
    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    const now = Date.now()
    await store.appendMessage(chat.id, entry("user_prompt", now + 1))
    await appendFile(join(dataDir, "transcripts", `${chat.id}.jsonl`),
      `${JSON.stringify(entry("assistant_text", now + 2))}\n${JSON.stringify(entry("user_prompt", now + 3))}\n`, "utf8")

    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()
    expect(reloaded.getChat(chat.id)?.lastMessageAt).toBe(now + 3)
    expect(await reloaded.readAllMessages(chat.id)).toHaveLength(3)
  })

  test("keeps copied fork history from changing sidebar activity on restart", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()
    const project = await store.openProject("/tmp/project")
    const source = await store.createChat(project.id)
    await store.setChatProvider(source.id, "claude")
    await store.setSessionToken(source.id, "session-1")
    await store.appendMessage(source.id, entry("user_prompt", Date.now() + 1))
    const fork = await store.forkChat(source.id)

    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()
    expect(reloaded.getChat(fork.id)?.lastMessageAt).toBeUndefined()
    expect(reloaded.getChat(fork.id)?.hasMessages).toBe(true)
    await reloaded.appendMessage(fork.id, entry("user_prompt", Date.now() + 2))
    const again = new EventStore(dataDir)
    await again.initialize()
    expect(again.getChat(fork.id)?.lastMessageAt).toBeDefined()
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

  test("persists normalized turn preferences across compaction and reload", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    await store.setChatTurnPreferences(chat.id, {
      provider: "codex",
      model: "gpt-5.6-luna",
      modelOptions: { reasoningEffort: "max", fastMode: true },
      permissionMode: "auto",
    })
    await store.compact()

    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()

    expect(reloaded.getChat(chat.id)?.provider).toBe("codex")
    expect(reloaded.getChat(chat.id)?.lastTurnPreferences).toEqual({
      provider: "codex",
      model: "gpt-5.6-luna",
      modelOptions: { reasoningEffort: "max", fastMode: true },
      permissionMode: "auto",
    })
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

describe("EventStore async question journal", () => {
  function response(chatId: string, overrides: Record<string, unknown> = {}) {
    return {
      schemaVersion: 1 as const,
      chatId,
      questionKey: JSON.stringify(["thread-1", "turn-1", "item-1"]),
      submissionId: "submission-1",
      answers: [{ index: 0, value: "HTML" }],
      status: "queued" as const,
      error: null,
      localMessageId: "queued-1",
      providerTurnId: null,
      createdAt: 1,
      updatedAt: 2,
      ...overrides,
    }
  }

  test("records, queries, and replays answers after a restart", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()
    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    const first = response(chat.id)
    await store.recordAsyncQuestionResponse(first)

    expect(store.getAsyncQuestionResponse(chat.id, first.questionKey)?.status).toBe("queued")
    expect(store.getAsyncQuestionResponseBySubmission(chat.id, "submission-1")?.localMessageId).toBe("queued-1")
    expect(store.listAsyncQuestionResponses(chat.id)).toHaveLength(1)

    const reopened = new EventStore(dataDir)
    await reopened.initialize()
    expect(reopened.getAsyncQuestionResponse(chat.id, first.questionKey)?.answers).toEqual([{ index: 0, value: "HTML" }])
    expect(reopened.getAsyncQuestionResponseBySubmission(chat.id, "submission-1")?.questionKey).toBe(first.questionKey)
  })

  test("keeps the newest record per question and every submission", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()
    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)

    await store.recordAsyncQuestionResponse(response(chat.id, { status: "submitting", updatedAt: 1 }))
    await store.recordAsyncQuestionResponse(response(chat.id, { status: "accepted", updatedAt: 3, providerTurnId: "turn-1" }))
    await store.recordAsyncQuestionResponse(response(chat.id, {
      submissionId: "submission-2",
      status: "delivery_unknown",
      updatedAt: 4,
    }))

    const latest = store.getAsyncQuestionResponse(chat.id, response(chat.id).questionKey)
    expect(latest?.status).toBe("delivery_unknown")
    expect(store.getAsyncQuestionResponseBySubmission(chat.id, "submission-1")?.status).toBe("accepted")
    expect(store.getAsyncQuestionResponseBySubmission(chat.id, "submission-2")?.status).toBe("delivery_unknown")
    expect(store.listAsyncQuestionResponses(chat.id)).toHaveLength(1)
  })

  test("drops journal records when the chat is deleted", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()
    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    await store.recordAsyncQuestionResponse(response(chat.id))

    await store.deleteChat(chat.id)

    expect(store.listAsyncQuestionResponses(chat.id)).toEqual([])
    expect(store.getAsyncQuestionResponseBySubmission(chat.id, "submission-1")).toBeNull()

    const reopened = new EventStore(dataDir)
    await reopened.initialize()
    expect(reopened.listAsyncQuestionResponses(chat.id)).toEqual([])
  })
})

test("chat pins survive log replay and compaction, stay workspace scoped and reject invalid writes", async () => {
  const dataDir = await createTempDataDir()
  const store = new EventStore(dataDir)
  await store.initialize()
  const project = await store.openProject("/tmp/pin-project")
  const other = await store.openProject("/tmp/other-project")
  const pinned = await store.createChat(project.id)
  const newer = await store.createChat(project.id)
  const separate = await store.createChat(other.id)
  await store.appendMessage(newer.id, entry("user_prompt", Date.now() + 100))
  await store.setChatPinned(pinned.id, true)
  const replayed = new EventStore(dataDir)
  await replayed.initialize()
  const sidebar = deriveSidebarData(replayed.state, new Map(), { nowMs: Date.now() + 48 * 3600_000 })
  const group = sidebar.projectGroups.find(group => group.groupKey === project.id)!
  expect(group.chats.map(chat => chat.chatId)).toEqual([pinned.id, newer.id])
  expect(group.previewChats.map(chat => chat.chatId)).toEqual([pinned.id])
  expect(group.defaultCollapsed).toBe(false)
  expect(sidebar.projectGroups.find(group => group.groupKey === other.id)!.chats[0]!.chatId).toBe(separate.id)
  await expect(replayed.setChatPinned(pinned.id, "false" as unknown as boolean)).rejects.toThrow()
  await expect(replayed.setChatPinned("missing", true)).rejects.toThrow()
  expect(replayed.getChat(pinned.id)!.pinned).toBe(true)
  await replayed.pruneStaleEmptyChats({ now: Date.now() + 365 * 24 * 3600_000, protectedChatIds: [newer.id, separate.id] })
  expect(replayed.getChat(pinned.id)!.deletedAt).toBeUndefined()
  await replayed.compact()
  const compacted = new EventStore(dataDir)
  await compacted.initialize()
  expect(compacted.getChat(pinned.id)!.pinned).toBe(true)
  await compacted.setChatPinned(pinned.id, false)
  const unpinned = new EventStore(dataDir)
  await unpinned.initialize()
  expect(unpinned.getChat(pinned.id)!.pinned).toBe(false)
  expect(deriveSidebarData(unpinned.state, new Map()).projectGroups.find(group => group.groupKey === project.id)!.chats[0]!.chatId).toBe(newer.id)
})
