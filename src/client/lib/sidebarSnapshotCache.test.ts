import { describe, expect, test } from "bun:test"
import type { SidebarData } from "../../shared/types"
import {
  SIDEBAR_SNAPSHOT_MAX_AGE_MS,
  clearSidebarSnapshotsForScope,
  createSidebarSnapshotIdentity,
  createSidebarSnapshotScope,
  getSidebarSnapshotStorageKey,
  loadSidebarSnapshot,
  persistSidebarSnapshot,
  type SidebarSnapshotStorage,
} from "./sidebarSnapshotCache"

function createStorage(initial: Record<string, string> = {}): SidebarSnapshotStorage {
  const values = new Map(Object.entries(initial))
  return {
    get length() {
      return values.size
    },
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key)
    },
    setItem: (key, value) => {
      values.set(key, value)
    },
  }
}

function createIdentity(overrides: Partial<{
  origin: string
  authScope: string
  machineName: string
}> = {}) {
  const identity = createSidebarSnapshotIdentity({
    origin: overrides.origin ?? "https://home.example.test",
    authScope: overrides.authScope ?? "session-a",
    machineName: overrides.machineName ?? "Studio Mac",
  })
  if (!identity) throw new Error("Expected a valid snapshot identity")
  return identity
}

function createSidebarData(): SidebarData {
  const recent = {
    _id: "row-recent",
    _creationTime: 99_900_000,
    chatId: "chat-recent",
    title: "Recent chat",
    status: "running" as const,
    unread: true,
    localPath: "/synthetic/project",
    provider: "codex" as const,
    lastMessageAt: 99_950_000,
    hasAutomation: true,
    canFork: true,
  }
  const older = {
    _id: "row-older",
    _creationTime: 1,
    chatId: "chat-older",
    title: "Older chat",
    status: "idle" as const,
    unread: false,
    localPath: "/synthetic/project",
    provider: null,
    lastMessageAt: 2,
    hasAutomation: false,
  }

  return {
    projectGroups: [{
      groupKey: "project-a",
      title: "Project A",
      realTitle: "project-a",
      sidebarTitle: "Project A",
      localPath: "/synthetic/project",
      chats: [recent, older],
      previewChats: [recent],
      olderChats: [older],
      archivedChats: [{
        ...older,
        _id: "archived-row",
        chatId: "archived-chat",
        title: "Archived chat",
      }],
      defaultCollapsed: false,
    }],
  }
}

describe("sidebar snapshot cache", () => {
  test("fails closed on a cold start", () => {
    expect(loadSidebarSnapshot(createIdentity(), createStorage(), 1_000_000)).toBeNull()
  })

  test("restores lightweight last-known rows without a server connection", () => {
    const storage = createStorage()
    const identity = createIdentity()
    const source = createSidebarData()

    expect(persistSidebarSnapshot(identity, source, storage, 100_000_000)).toBe(true)
    const loaded = loadSidebarSnapshot(identity, storage, 100_000_001)

    expect(loaded?.savedAt).toBe(100_000_000)
    expect(loaded?.data.projectGroups).toHaveLength(1)
    expect(loaded?.data.projectGroups[0]?.chats.map((chat) => chat.chatId)).toEqual([
      "chat-recent",
      "chat-older",
    ])
    expect(loaded?.data.projectGroups[0]?.previewChats.map((chat) => chat.chatId)).toEqual([
      "chat-recent",
    ])
    expect(loaded?.data.projectGroups[0]?.olderChats.map((chat) => chat.chatId)).toEqual([
      "chat-older",
    ])
    expect(loaded?.data.projectGroups[0]?.archivedChats).toBeUndefined()
    expect(loaded?.data.projectGroups[0]?.chats[0]).toMatchObject({
      status: "idle",
      hasAutomation: false,
    })
    expect(loaded?.data.projectGroups[0]?.chats[0]?.canFork).toBeUndefined()
  })

  test("isolates snapshots by origin, auth scope, and machine identity", () => {
    const storage = createStorage()
    const identity = createIdentity()
    persistSidebarSnapshot(identity, createSidebarData(), storage, 1_000_000)

    expect(loadSidebarSnapshot(createIdentity({ origin: "https://tailnet.example.test" }), storage, 1_000_001)).toBeNull()
    expect(loadSidebarSnapshot(createIdentity({ authScope: "session-b" }), storage, 1_000_001)).toBeNull()
    expect(loadSidebarSnapshot(createIdentity({ machineName: "Travel Mac" }), storage, 1_000_001)).toBeNull()
    expect(loadSidebarSnapshot(identity, storage, 1_000_001)).not.toBeNull()
  })

  test("replaces deleted rows with the next authoritative snapshot", () => {
    const storage = createStorage()
    const identity = createIdentity()
    const source = createSidebarData()
    persistSidebarSnapshot(identity, source, storage, 1_000_000)

    const authoritative: SidebarData = {
      projectGroups: [{
        ...source.projectGroups[0]!,
        chats: source.projectGroups[0]!.chats.slice(0, 1),
        previewChats: source.projectGroups[0]!.chats.slice(0, 1),
        olderChats: [],
      }],
    }
    persistSidebarSnapshot(identity, authoritative, storage, 1_000_010)

    expect(
      loadSidebarSnapshot(identity, storage, 1_000_011)?.data.projectGroups[0]?.chats.map((chat) => chat.chatId)
    ).toEqual(["chat-recent"])
  })

  test("omits transcripts, tool results, archived rows, and duplicate row paths", () => {
    const storage = createStorage()
    const identity = createIdentity()
    const source = createSidebarData() as SidebarData & {
      transcript?: unknown
    }
    source.transcript = [{ kind: "tool_result", content: "must-not-persist" }]
    Object.assign(source.projectGroups[0]!.chats[0]!, {
      toolResult: "must-not-persist",
      messages: ["must-not-persist"],
    })

    persistSidebarSnapshot(identity, source, storage, 1_000_000)
    const serialized = storage.getItem(getSidebarSnapshotStorageKey(identity)) ?? ""

    expect(serialized).not.toContain("must-not-persist")
    expect(serialized).not.toContain("archived-chat")
    expect(serialized.match(/\/synthetic\/project/g)).toHaveLength(1)
  })

  test("expires old, future-dated, malformed, and mismatched-schema entries", () => {
    const identity = createIdentity()
    const storage = createStorage()
    const key = getSidebarSnapshotStorageKey(identity)

    persistSidebarSnapshot(identity, createSidebarData(), storage, 1_000_000)
    expect(loadSidebarSnapshot(identity, storage, 1_000_000 + SIDEBAR_SNAPSHOT_MAX_AGE_MS + 1)).toBeNull()
    expect(storage.getItem(key)).toBeNull()

    persistSidebarSnapshot(identity, createSidebarData(), storage, 10_000_000)
    expect(loadSidebarSnapshot(identity, storage, 1_000_000)).toBeNull()

    storage.setItem(key, "{not-json")
    expect(loadSidebarSnapshot(identity, storage, 1_000_000)).toBeNull()

    storage.setItem(key, JSON.stringify({
      version: 999,
      savedAt: 1_000_000,
      identity,
      data: { projectGroups: [] },
    }))
    expect(loadSidebarSnapshot(identity, storage, 1_000_000)).toBeNull()
    expect(storage.getItem(key)).toBeNull()
  })

  test("rejects duplicate IDs and oversized metadata", () => {
    const identity = createIdentity()
    const storage = createStorage()
    const duplicate = createSidebarData()
    duplicate.projectGroups.push({
      ...duplicate.projectGroups[0]!,
      title: "Duplicate",
    })

    expect(persistSidebarSnapshot(identity, duplicate, storage, 1_000_000)).toBe(false)

    const oversized = createSidebarData()
    oversized.projectGroups[0]!.title = "x".repeat(1_001)
    expect(persistSidebarSnapshot(identity, oversized, storage, 1_000_000)).toBe(false)
  })

  test("clears every machine snapshot for the signed-out origin and auth scope", () => {
    const storage = createStorage()
    const first = createIdentity()
    const renamed = createIdentity({ machineName: "Renamed Mac" })
    const otherSession = createIdentity({ authScope: "session-b" })
    const data = createSidebarData()
    persistSidebarSnapshot(first, data, storage, 1_000_000)
    persistSidebarSnapshot(renamed, data, storage, 1_000_000)
    persistSidebarSnapshot(otherSession, data, storage, 1_000_000)

    const scope = createSidebarSnapshotScope(first)
    clearSidebarSnapshotsForScope(scope, storage)

    expect(loadSidebarSnapshot(first, storage, 1_000_001)).toBeNull()
    expect(loadSidebarSnapshot(renamed, storage, 1_000_001)).toBeNull()
    expect(loadSidebarSnapshot(otherSession, storage, 1_000_001)).not.toBeNull()
  })

  test("treats unavailable browser storage as an optional optimization", () => {
    const throwingStorage: SidebarSnapshotStorage = {
      getItem: () => {
        throw new Error("blocked")
      },
      removeItem: () => {
        throw new Error("blocked")
      },
      setItem: () => {
        throw new Error("blocked")
      },
    }

    expect(loadSidebarSnapshot(createIdentity(), throwingStorage, 1_000_000)).toBeNull()
    expect(persistSidebarSnapshot(createIdentity(), createSidebarData(), throwingStorage, 1_000_000)).toBe(false)
  })
})
