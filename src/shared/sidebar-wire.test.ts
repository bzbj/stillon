import { expect, test } from "bun:test"
import { encodeSidebarEnvelope, decodeSidebarEnvelope } from "./sidebar-wire"
import type { ServerEnvelope } from "./protocol"
import type { SidebarChatRow, SidebarData } from "./types"

function sidebar() {
  const rows: SidebarChatRow[] = Array.from({ length: 100 }, (_, i) => ({ _id: `chat-${i}`, chatId: `chat-${i}`, _creationTime: i, title: `资料😀 "${i}"\n${"summary ".repeat(15)}`, localPath: "/example/project", status: "idle", unread: i % 2 === 0, provider: "codex", hasAutomation: false }))
  const data: SidebarData = { projectGroups: [{ groupKey: "sample", title: "Workspace", realTitle: "Workspace", localPath: "/example/project", chats: rows, previewChats: rows.filter((_, i) => i % 3 === 0).reverse(), olderChats: rows.filter((_, i) => i % 3 !== 0), archivedChats: [rows[0]!], defaultCollapsed: false }] }
  return { v: 1, type: "snapshot", id: "sidebar", snapshot: { type: "sidebar", data } } satisfies ServerEnvelope
}

test("compact sidebar preserves every row, bucket order, archives and metadata through JSON", () => {
  const original = sidebar()
  const compact = encodeSidebarEnvelope(original, true)
  expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThan(Buffer.byteLength(JSON.stringify(original)) * 0.6)
  const decoded = decodeSidebarEnvelope(JSON.parse(JSON.stringify(compact)))
  expect(decoded).toEqual(JSON.parse(JSON.stringify(original)))
  if (decoded.type !== "snapshot" || decoded.snapshot.type !== "sidebar") throw Error("Wrong snapshot")
  const group = decoded.snapshot.data.projectGroups[0]!
  expect(group.previewChats[0]).toBe(group.chats[99])
})

test("legacy subscriptions and unrelated envelopes keep their original representation", () => {
  const message = sidebar()
  expect(encodeSidebarEnvelope(message, false)).toBe(message)
  expect(decodeSidebarEnvelope(message)).toBe(message)
  const ack: ServerEnvelope = { v: 1, type: "ack", id: "ack", result: { ok: true } }
  expect(encodeSidebarEnvelope(ack, true)).toBe(ack)
  message.snapshot.data.projectGroups = []
  expect(decodeSidebarEnvelope(JSON.parse(JSON.stringify(encodeSidebarEnvelope(message, true))))).toEqual(message)
})

test("a noncanonical bucket falls back instead of discarding a changed row", () => {
  const message = sidebar()
  message.snapshot.data.projectGroups[0]!.previewChats[0] = { ...message.snapshot.data.projectGroups[0]!.chats[0]!, title: "Different preview" }
  expect(encodeSidebarEnvelope(message, true)).toBe(message)
})

test("invalid versions and missing, duplicate or out-of-range row references are rejected", () => {
  const valid = encodeSidebarEnvelope(sidebar(), true)
  for (const indexes of [[-1], [999], [0, 0], []]) {
    const bad = JSON.parse(JSON.stringify(valid))
    bad.snapshot.data.projectGroups[0].previewIndexes = indexes
    expect(() => decodeSidebarEnvelope(bad)).toThrow()
  }
  const unknown = { ...valid, sidebarEncoding: 2 }
  expect(() => decodeSidebarEnvelope(unknown)).toThrow()
})
