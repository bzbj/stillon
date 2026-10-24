import type { SidebarChatRow, SidebarData } from "../../shared/types"
import { getSidebarChatBuckets, getSidebarChatTimestamp, shouldDefaultCollapseSidebarProject } from "../lib/sidebarChats"

export interface SidebarChatChange {
  chatId: string
  action: { type: "pin"; pinned: boolean } | { type: "archive" }
  settled: boolean
}

/** Transient intent only. Saved snapshots remain authoritative and cacheable. */
export class SidebarChatActions {
  private changes: SidebarChatChange[] = []
  private listeners = new Set<() => void>()
  private lastAcceptedAt = -Infinity

  getSnapshot = () => this.changes
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private update(changes: SidebarChatChange[]) {
    this.changes = changes
    for (const listener of this.listeners) listener()
  }

  begin(chat: SidebarChatRow, type: "pin" | "archive", now = Date.now()) {
    // A removed/reordered row puts another button under a stationary pointer.
    // Guard the whole list briefly, and each chat until its state is reconciled.
    if (now - this.lastAcceptedAt < 400 || this.has(chat.chatId)) return null
    this.lastAcceptedAt = now
    const change: SidebarChatChange = {
      chatId: chat.chatId,
      action: type === "pin" ? { type, pinned: !chat.pinned } : { type },
      settled: false,
    }
    this.update([...this.changes, change])
    return change
  }

  has(chatId: string) { return this.changes.some(change => change.chatId === chatId) }
  settle(change: SidebarChatChange) {
    if (!this.changes.includes(change)) return
    change.settled = true
    this.update([...this.changes])
  }
  reject(change: SidebarChatChange) {
    this.update(this.changes.filter(current => current !== change))
  }

  receive(snapshot: SidebarData, freshRead: readonly SidebarChatChange[] = []) {
    const remaining = this.changes.filter(change => {
      if (!change.settled) return true
      if (freshRead.includes(change)) return false
      const row = snapshot.projectGroups.flatMap(group => group.chats).find(chat => chat.chatId === change.chatId)
      return change.action.type === "archive" ? Boolean(row) : !row || Boolean(row.pinned) !== change.action.pinned
    })
    if (remaining.length !== this.changes.length) this.update(remaining)
  }
}

export function applySidebarChatChanges(data: SidebarData, changes: readonly SidebarChatChange[], now = Date.now()): SidebarData {
  if (!changes.length) return data
  const byId = new Map(changes.map(change => [change.chatId, change.action]))
  return {
    ...data,
    projectGroups: data.projectGroups.map(group => {
      if (!group.chats.some(chat => byId.has(chat.chatId))) return group
      const archived = group.chats.filter(chat => byId.get(chat.chatId)?.type === "archive")
      const chats = group.chats.filter(chat => byId.get(chat.chatId)?.type !== "archive").map(chat => {
        const action = byId.get(chat.chatId)
        return action?.type === "pin" ? { ...chat, pinned: action.pinned } : chat
      }).sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || getSidebarChatTimestamp(b) - getSidebarChatTimestamp(a))
      const buckets = getSidebarChatBuckets(chats, now)
      return {
        ...group,
        chats,
        previewChats: buckets.collapsedChats,
        olderChats: buckets.remainingChats,
        archivedChats: [...archived, ...(group.archivedChats ?? [])],
        defaultCollapsed: shouldDefaultCollapseSidebarProject(chats, now),
      }
    }),
  }
}
