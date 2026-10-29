import type { ServerEnvelope } from "./protocol"
import type { SidebarData, SidebarProjectGroup } from "./types"

type CompactGroup = Omit<SidebarProjectGroup, "previewChats" | "olderChats"> & { previewIndexes: number[]; olderIndexes: number[] }
type CompactEnvelope = Omit<Extract<ServerEnvelope, { type: "snapshot" }>, "snapshot"> & {
  sidebarEncoding: 1
  snapshot: { type: "sidebar"; data: Omit<SidebarData, "projectGroups"> & { projectGroups: CompactGroup[] } }
}

/** Send every row once, retaining the server's exact bucket membership and order. */
export function encodeSidebarEnvelope(message: ServerEnvelope, enabled: boolean): ServerEnvelope | CompactEnvelope {
  if (!enabled || message.type !== "snapshot" || message.snapshot.type !== "sidebar") return message
  const projectGroups: CompactGroup[] = []
  for (const group of message.snapshot.data.projectGroups) {
    const { previewChats, olderChats, ...rest } = group
    const indexes = new Map(group.chats.map((row, index) => [row.chatId, index]))
    const positions = (rows: typeof group.chats) => rows.map(row => {
      const index = indexes.get(row.chatId)
      if (index === undefined || (row !== group.chats[index] && JSON.stringify(row) !== JSON.stringify(group.chats[index]))) return -1
      return index
    })
    const previewIndexes = positions(previewChats), olderIndexes = positions(olderChats)
    const all = [...previewIndexes, ...olderIndexes]
    // Noncanonical producers keep the legacy representation rather than lose data.
    if (all.length !== group.chats.length || all.includes(-1) || new Set(all).size !== group.chats.length) return message
    projectGroups.push({ ...rest, previewIndexes, olderIndexes })
  }
  return { ...message, sidebarEncoding: 1, snapshot: { type: "sidebar", data: { ...message.snapshot.data, projectGroups } } }
}

/** Application listeners always receive the original SidebarData shape. */
export function decodeSidebarEnvelope(message: unknown): ServerEnvelope {
  if (!message || typeof message !== "object" || !("sidebarEncoding" in message)) return message as ServerEnvelope
  const wire = message as CompactEnvelope
  if (wire.sidebarEncoding !== 1 || wire.type !== "snapshot" || wire.snapshot?.type !== "sidebar" || !Array.isArray(wire.snapshot.data?.projectGroups)) throw new Error("Invalid sidebar encoding")
  const projectGroups = wire.snapshot.data.projectGroups.map(group => {
    const { previewIndexes, olderIndexes, ...rest } = group
    if (!Array.isArray(rest.chats) || !Array.isArray(previewIndexes) || !Array.isArray(olderIndexes)) throw new Error("Invalid sidebar buckets")
    const all = [...previewIndexes, ...olderIndexes]
    if (all.length !== rest.chats.length || new Set(all).size !== rest.chats.length || all.some(index => !Number.isInteger(index) || index < 0 || index >= rest.chats.length)) throw new Error("Invalid sidebar row reference")
    return { ...rest, previewChats: previewIndexes.map(index => rest.chats[index]!), olderChats: olderIndexes.map(index => rest.chats[index]!) }
  })
  const { sidebarEncoding: _encoding, ...envelope } = wire
  return { ...envelope, snapshot: { type: "sidebar", data: { ...wire.snapshot.data, projectGroups } satisfies SidebarData } }
}
