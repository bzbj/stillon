import { describe, expect, test } from "bun:test"
import { createEmptyState } from "./events"
import { deriveSidebarData } from "./read-models"
import { workspaceState } from "./workspace-access"
import { normalizeSidebarView } from "../shared/sidebar-view"
import { decodeSidebarEnvelope, encodeSidebarEnvelope } from "../shared/sidebar-wire"
import { getChatSoundBurstCount, getNotificationTitleCount } from "../client/app/chatNotifications"
import type { SidebarView } from "../shared/types"

function fixture() {
  const state = createEmptyState()
  for (const projectId of ["alpha", "beta"]) {
    state.projectsById.set(projectId, { id: projectId, localPath: `/tmp/${projectId}`, title: projectId, createdAt: 1, updatedAt: 1 })
    for (let i = 0; i < 100; i++) state.chatsById.set(`${projectId}-${i}`, {
      id: `${projectId}-${i}`, projectId, title: `Conversation ${projectId} ${i}`, createdAt: i + 1, updatedAt: i + 1,
      unread: i === 2, provider: "codex", planMode: false, sessionToken: `thread-${i}`, lastTurnOutcome: null,
      ...(i === 0 ? { pinned: true } : {}), ...(i >= 90 ? { archivedAt: 200 } : {}),
    })
  }
  return state
}
const catalog: SidebarView = { version: 1, groups: [] }

describe("on-demand sidebar", () => {
  test("catalog contains workspace summaries but no conversation names, even for archived/pinned chats", () => {
    const state = fixture(), statuses = new Map([["alpha-2", "waiting_for_user" as const]])
    const data = deriveSidebarData(state, statuses, { view: catalog })
    expect(data.lazyVersion).toBe(1)
    expect(JSON.stringify(data)).not.toContain("Conversation")
    expect(data.projectGroups.map(group => group.chats.length)).toEqual([0, 0])
    expect(data.projectGroups[0]?.chatPage).toEqual({ limit: 0, total: 90, hasMore: true, archivedLimit: 0, archivedTotal: 10 })
    expect(data.projectGroups[0]?.activity?.attention).toBe(true)
    expect(data.projectGroups[0]?.lastActivityAt).toBe(90)
    const full = deriveSidebarData(state, statuses)
    expect(getNotificationTitleCount(data)).toBe(getNotificationTitleCount(full))
    expect(Buffer.byteLength(JSON.stringify(data))).toBeLessThan(Buffer.byteLength(JSON.stringify(full)) / 10)
  })

  test("opening one workspace loads five pinned/recent rows, Show more requests a bounded prefix, folding removes them", () => {
    const state = fixture()
    const read = (limit: number) => deriveSidebarData(state, new Map(), { view: { version: 1, groups: [{ groupKey: "alpha", limit }] } })
    expect(read(5).projectGroups[0]?.chats.map(chat => chat.chatId)).toEqual(["alpha-0", "alpha-89", "alpha-88", "alpha-87", "alpha-86"])
    expect(read(5).projectGroups[1]?.chats).toEqual([])
    expect(read(25).projectGroups[0]?.chats).toHaveLength(25)
    expect(read(25).projectGroups[0]?.olderChats).toHaveLength(20)
    expect(read(5).projectGroups[0]?.archivedChats).toBeUndefined()
    expect(read(0).projectGroups[0]?.chats).toEqual([])
  })

  test("direct chat links identify their workspace from the catalog and fetch only the selected old row alongside the preview", () => {
    const state = fixture(), view = { ...catalog, activeChatId: "alpha-1" }
    const data = deriveSidebarData(state, new Map(), { view })
    expect(data.activeChat).toEqual({ chatId: "alpha-1", projectId: "alpha" })
    expect(data.projectGroups[0]?.activeChatId).toBe("alpha-1")
    expect(data.projectGroups[0]?.chats).toEqual([])
    const expanded = deriveSidebarData(state, new Map(), { view: { ...view, groups: [{ groupKey: "alpha", limit: 5 }] } })
    expect(expanded.projectGroups[0]?.chats).toHaveLength(6)
    expect(expanded.projectGroups[0]?.chats.at(-1)?.chatId).toBe("alpha-1")
    state.chatsById.get("alpha-1")!.deletedAt = 300
    expect(deriveSidebarData(state, new Map(), { view }).activeChat?.projectId).toBeNull()
  })

  test("search and archives are read only on explicit intent, including folded workspaces", () => {
    const state = fixture()
    const search = deriveSidebarData(state, new Map(), { view: { ...catalog, search: "beta 1" } })
    expect(search.search).toBe("beta 1")
    expect(search.projectGroups[0]?.chats).toEqual([])
    expect(search.projectGroups[1]?.chats.map(chat => chat.title)).toContain("Conversation beta 1")
    expect(search.projectGroups[1]?.chats.every(chat => chat.title.includes("beta 1"))).toBe(true)
    const archives = deriveSidebarData(state, new Map(), { view: { ...catalog, archived: { groupKey: "alpha", limit: 3 } } })
    expect(archives.projectGroups[0]?.archivedChats).toHaveLength(3)
    expect(archives.projectGroups[1]?.archivedChats).toBeUndefined()
    expect(archives.projectGroups.flatMap(group => group.chats)).toEqual([])
  })

  test("search pages are requested explicitly instead of silently truncating matches", () => {
    const state = fixture()
    const first = deriveSidebarData(state, new Map(), { view: { ...catalog, search: "Conversation", searchLimit: 50 } })
    expect(first.projectGroups.flatMap(group => group.chats)).toHaveLength(50)
    expect(first.searchHasMore).toBe(true)
    const more = deriveSidebarData(state, new Map(), { view: { ...catalog, search: "Conversation", searchLimit: 100 } })
    expect(more.projectGroups.flatMap(group => group.chats)).toHaveLength(100)
    expect(more.searchHasMore).toBe(true)
    const all = deriveSidebarData(state, new Map(), { view: { ...catalog, search: "Conversation", searchLimit: 200 } })
    expect(all.projectGroups.flatMap(group => group.chats)).toHaveLength(180)
    expect(all.searchHasMore).toBe(false)
  })

  test("project scoping precedes projections, search, active chat and notification summaries", () => {
    const state = workspaceState(fixture(), "alpha")
    const data = deriveSidebarData(state, new Map(), { view: { version: 1, groups: [{ groupKey: "beta", limit: 100 }], archived: { groupKey: "beta", limit: 100 }, search: "beta", activeChatId: "beta-1" } })
    expect(data.projectGroups).toHaveLength(1)
    expect(data.projectGroups[0]?.chats).toEqual([])
    expect(data.activeChat?.projectId).toBeNull()
    expect(JSON.stringify(data.projectGroups)).not.toContain('"beta-')
  })

  test("notification summaries change without loading folded names and compact wire retains catalog metadata", () => {
    const state = fixture(), before = deriveSidebarData(state, new Map(), { view: catalog })
    state.chatsById.get("beta-4")!.unread = true
    const after = deriveSidebarData(state, new Map([["alpha-3", "waiting_for_user"]]), { view: catalog })
    expect(getChatSoundBurstCount(before, after)).toBe(2)
    const envelope = { v: 1 as const, type: "snapshot" as const, id: "view", snapshot: { type: "sidebar" as const, data: after } }
    expect(decodeSidebarEnvelope(JSON.parse(JSON.stringify(encodeSidebarEnvelope(envelope, true))))).toEqual(envelope)
  })

  test("malformed, unknown or excessive view requests are rejected rather than returning full history", () => {
    for (const value of [null, {}, { version: 2, groups: [] }, { version: 1, groups: [{ groupKey: "alpha", limit: -1 }] }, { version: 1, groups: [{ groupKey: "alpha", limit: 1.5 }] }, { version: 1, groups: [{ groupKey: "alpha", limit: Number.MAX_SAFE_INTEGER + 1 }] }, { version: 1, groups: [], search: "a".repeat(201) }, { version: 1, groups: [], activeChatId: {} }]) expect(normalizeSidebarView(value)).toBeNull()
    expect(normalizeSidebarView(catalog)).toEqual(catalog)
  })
})
