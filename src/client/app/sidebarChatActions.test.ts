import { describe, expect, test } from "bun:test"
import { deriveSidebarData } from "../../server/read-models"
import { createEmptyState } from "../../server/events"
import { applySidebarChatChanges, SidebarChatActions } from "./sidebarChatActions"

const now = 10 * 86_400_000
function fixture() {
  const state = createEmptyState()
  for (const id of ["a", "b"]) {
    state.projectsById.set(id, { id, title: id, localPath: `/tmp/${id}`, createdAt: 1, updatedAt: 1 })
  }
  for (const [id, projectId, createdAt] of [["new", "a", now], ["older", "a", 2], ["oldest", "a", 1], ["other", "b", now]] as const) {
    state.chatsById.set(id, { id, projectId, title: id, createdAt, updatedAt: createdAt, provider: null, planMode: false, sessionToken: null, unread: false, lastTurnOutcome: null })
  }
  const read = () => deriveSidebarData(state, new Map(), { nowMs: now })
  const data = read()
  const row = (id: string) => data.projectGroups.flatMap(group => group.chats).find(chat => chat.chatId === id)!
  return { state, data, read, row }
}

function activeIds(data: ReturnType<typeof fixture>["data"]) { return data.projectGroups[0]!.chats.map(chat => chat.chatId) }

describe("optimistic sidebar actions", () => {
  test("pins an old chat into the visible preview immediately, matching the server", () => {
    const { data, row, state, read } = fixture()
    const actions = new SidebarChatActions()
    actions.begin(row("oldest"), "pin", 0)
    const result = applySidebarChatChanges(data, actions.getSnapshot(), now)
    expect(activeIds(result)).toEqual(["oldest", "new", "older"])
    expect(result.projectGroups[0]!.previewChats.map(chat => chat.chatId)).toEqual(["oldest", "new"])
    state.chatsById.get("oldest")!.pinned = true
    expect(result.projectGroups[0]!.chats).toEqual(read().projectGroups[0]!.chats)
    expect(result.projectGroups[0]!.previewChats).toEqual(read().projectGroups[0]!.previewChats)
    expect(result.projectGroups[1]).toBe(data.projectGroups[1])
    expect(data.projectGroups[0]!.chats[2]!.pinned).toBeUndefined()
  })

  test("unpin restores activity order and older buckets", () => {
    const { state, read } = fixture()
    state.chatsById.get("oldest")!.pinned = true
    const data = read()
    const actions = new SidebarChatActions()
    actions.begin(data.projectGroups[0]!.chats[0]!, "pin", 0)
    const result = applySidebarChatChanges(data, actions.getSnapshot(), now)
    state.chatsById.get("oldest")!.pinned = false
    expect(result.projectGroups[0]!.chats).toEqual(read().projectGroups[0]!.chats)
    expect(result.projectGroups[0]!.olderChats).toEqual(read().projectGroups[0]!.olderChats)
  })

  test("archive removes every active bucket, reveals fallback rows and keeps archive access", () => {
    const { data, row, state, read } = fixture()
    const actions = new SidebarChatActions()
    actions.begin(row("new"), "archive", 0)
    const result = applySidebarChatChanges(data, actions.getSnapshot(), now)
    expect(activeIds(result)).toEqual(["older", "oldest"])
    expect(result.projectGroups[0]!.archivedChats?.map(chat => chat.chatId)).toEqual(["new"])
    state.chatsById.get("new")!.archivedAt = now
    expect(result.projectGroups[0]).toEqual(read().projectGroups[0])
  })

  test("old broadcasts and ack-before-snapshot cannot flash the previous state", () => {
    const { data, row, state, read } = fixture()
    const actions = new SidebarChatActions()
    const change = actions.begin(row("oldest"), "pin", 0)!
    actions.receive(data)
    expect(actions.has("oldest")).toBe(true)
    state.chatsById.get("oldest")!.pinned = true
    actions.receive(read()) // Snapshot can arrive before command ack.
    expect(actions.begin(row("oldest"), "pin", 1_000)).toBeNull()
    actions.settle(change)
    actions.receive(data)
    expect(applySidebarChatChanges(data, actions.getSnapshot(), now).projectGroups[0]!.chats[0]!.chatId).toBe("oldest")
    actions.receive(read())
    expect(actions.getSnapshot()).toEqual([])
  })

  test("a rejected action rolls back only itself over the latest server data", () => {
    const { row, state, read } = fixture()
    const actions = new SidebarChatActions()
    const pin = actions.begin(row("oldest"), "pin", 0)!
    actions.begin(row("new"), "archive", 500)
    state.chatsById.get("older")!.title = "Updated elsewhere"
    actions.reject(pin)
    const result = applySidebarChatChanges(read(), actions.getSnapshot(), now)
    expect(activeIds(result)).toEqual(["older", "oldest"])
    expect(result.projectGroups[0]!.chats[0]!.title).toBe("Updated elsewhere")
    expect(result.projectGroups[0]!.chats[1]!.pinned).toBeUndefined()
  })

  test("blocks repeat submissions and quick clicks on the replacement row", () => {
    const { row } = fixture()
    const actions = new SidebarChatActions()
    expect(actions.begin(row("new"), "archive", 0)).not.toBeNull()
    expect(actions.begin(row("older"), "archive", 100)).toBeNull()
    expect(actions.begin(row("older"), "pin", 200)).toBeNull()
    expect(actions.begin(row("new"), "archive", 1_000)).toBeNull()
    expect(actions.begin(row("older"), "archive", 1_001)).not.toBeNull()
  })

  test("fresh read reconciles an uncertain timeout without resending or staying locked", () => {
    const { data, row } = fixture()
    const actions = new SidebarChatActions()
    const change = actions.begin(row("new"), "archive", 0)!
    actions.settle(change)
    actions.receive(data)
    expect(actions.has("new")).toBe(true)
    actions.receive(data, [change])
    expect(applySidebarChatChanges(data, actions.getSnapshot(), now)).toBe(data)
    expect(actions.begin(row("new"), "archive", 2_000)).not.toBeNull()
  })

  test("a delayed fresh read cannot clear a newer intent for the same chat", () => {
    const { data, row } = fixture()
    const actions = new SidebarChatActions()
    const old = actions.begin(row("new"), "archive", 0)!
    actions.reject(old)
    const next = actions.begin(row("new"), "archive", 1_000)!
    actions.settle(next)
    actions.receive(data, [old])
    expect(actions.getSnapshot()).toEqual([next])
  })
})
