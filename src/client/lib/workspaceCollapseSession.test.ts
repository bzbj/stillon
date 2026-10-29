import { expect, test } from "bun:test"
import type { SidebarProjectGroup } from "../../shared/types"
import { WorkspaceCollapseSession } from "./workspaceCollapseSession"

const groups = [
  { groupKey: "a", chats: [{ chatId: "chat-a", _creationTime: 10 }], defaultCollapsed: false },
  { groupKey: "b", chats: [{ chatId: "chat-b", _creationTime: 20 }], defaultCollapsed: false },
  { groupKey: "empty", chats: [], defaultCollapsed: false },
] as SidebarProjectGroup[]
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  throw new Error("Expected workspace save to settle")
}

test("first-use defaults open one current/recent group and stay stable as activity changes", () => {
  const current = new WorkspaceCollapseSession()
  current.includeGroups(groups, "chat-a")
  expect(current.getSnapshot().choices).toEqual({ a: false, b: true, empty: true })
  current.includeGroups([...groups, { groupKey: "new", chats: [], defaultCollapsed: false } as never], "chat-b")
  expect(current.getSnapshot().choices).toEqual({ a: false, b: true, empty: true, new: true })
  const recent = new WorkspaceCollapseSession()
  recent.includeGroups(groups, null)
  expect(recent.getSnapshot().choices).toEqual({ a: true, b: false, empty: true })
  const empty = new WorkspaceCollapseSession()
  empty.includeGroups([groups[2]!], null)
  expect(empty.getSnapshot().choices).toEqual({ empty: true })
})

test("saved choices and temporary navigation remain local when shared state changes", () => {
  const session = new WorkspaceCollapseSession({ a: true, b: false }, { a: 1 })
  session.includeGroups(groups, "chat-a")
  let writes = 0
  session.setWriter(async () => { writes++; return {} })
  session.setSharedVersions({ a: 9, b: 4 })
  session.includeGroups(groups, null)
  expect(session.getSnapshot().choices).toEqual({ a: true, b: false, empty: true })
  session.reveal("a")
  expect(session.getSnapshot().choices.a).toBe(false)
  expect(session.getSnapshot().unsynced).toBe(false)
  expect(writes).toBe(0)
})

test("rapid same-node clicks serialize and an old acknowledgement cannot undo the last choice", async () => {
  const session = new WorkspaceCollapseSession({ a: true }, { a: 1 })
  const writes: Array<{ value: boolean; version: number }> = []
  let release!: () => void
  session.setWriter(async (patch, expected) => {
    writes.push({ value: patch.a!, version: expected.a! })
    if (writes.length === 1) await new Promise<void>(resolve => { release = resolve })
    return { workspaceCollapseVersions: { a: expected.a! + 1 } }
  })
  session.choose("a", false)
  session.choose("a", true)
  session.choose("a", false)
  expect(session.getSnapshot().choices.a).toBe(false)
  release()
  await until(() => !session.getSnapshot().unsynced)
  expect(writes).toEqual([{ value: false, version: 1 }, { value: false, version: 2 }])
  expect(session.getSnapshot().choices.a).toBe(false)
})

test("failed and stale offline writes keep the local view and need an explicit retry", async () => {
  const session = new WorkspaceCollapseSession({ a: true, b: false }, { a: 1, b: 1 })
  session.choose("a", false)
  session.setSharedVersions({ a: 2, b: 1 })
  const attempts: number[] = []
  session.setWriter(async (_patch, expected) => {
    attempts.push(expected.a!)
    if (expected.a !== 2) throw new Error("changed elsewhere")
    return { workspaceCollapseVersions: { a: 3, b: 1 } }
  })
  await until(() => Boolean(session.getSnapshot().error))
  expect(attempts).toEqual([1])
  expect(session.getSnapshot().choices).toEqual({ a: false, b: false })
  session.setSharedVersions({ a: 2, b: 1 })
  expect(attempts).toEqual([1])
  session.retry()
  await until(() => !session.getSnapshot().unsynced)
  expect(attempts).toEqual([1, 2])
  expect(session.getSnapshot().error).toBeNull()
})

test("editing a second workspace preserves the retry for a failed first workspace", async () => {
  const session = new WorkspaceCollapseSession({ a: true, b: true })
  session.setWriter(async (patch) => {
    if ("a" in patch) throw new Error("save failed")
    return { workspaceCollapseVersions: { b: 1 } }
  })
  session.choose("a", false)
  await until(() => Boolean(session.getSnapshot().error))
  session.choose("b", false)
  await until(() => Boolean(session.getSnapshot().error))
  expect(session.getSnapshot()).toMatchObject({ choices: { a: false, b: false }, unsynced: true })
  expect(session.getSnapshot().error).toContain("not synced")
})

test("a names-only catalog preserves first-use and direct-chat expansion without fetching history", () => {
  const groups = [
    { groupKey: "older", title: "Older", realTitle: "Older", localPath: "/tmp/older", chats: [], previewChats: [], olderChats: [], defaultCollapsed: true, lastActivityAt: 10 },
    { groupKey: "newer", title: "Newer", realTitle: "Newer", localPath: "/tmp/newer", chats: [], previewChats: [], olderChats: [], defaultCollapsed: false, lastActivityAt: 20 },
  ]
  const first = new WorkspaceCollapseSession()
  first.includeGroups(groups, null)
  expect(first.getSnapshot().choices).toEqual({ older: true, newer: false })
  const linked = new WorkspaceCollapseSession()
  linked.includeGroups([{ ...groups[0]!, activeChatId: "old-chat" }, groups[1]!], "old-chat")
  expect(linked.getSnapshot().choices).toEqual({ older: false, newer: true })
})
