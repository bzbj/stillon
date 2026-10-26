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
  private lastAccepted: SidebarChatChange | null = null
  private commands = new Map<string, Promise<boolean>>()

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
    const current = this.changes.find(change => change.chatId === chat.chatId)
    const action: SidebarChatChange["action"] = type === "pin" ? { type, pinned: !chat.pinned } : { type }
    // A stale repeat asks for the same value. A click on the updated button
    // asks for the opposite value and must react even before the first ack.
    const previous = current ?? (this.lastAccepted?.chatId === chat.chatId ? this.lastAccepted : null)
    const reversesPin = action.type === "pin" && previous?.action.type === "pin" && action.pinned !== previous.action.pinned
    if (current && !reversesPin) return null
    // Keep replacement-row clicks protected when pinning moves another button
    // under the pointer, while allowing an intentional reversal on this chat.
    if (now - this.lastAcceptedAt < 400 && !reversesPin) return null
    this.lastAcceptedAt = now
    const change: SidebarChatChange = { chatId: chat.chatId, action, settled: false }
    this.lastAccepted = change
    this.update([...this.changes.filter(entry => entry !== current), change])
    return change
  }

  isCurrent(change: SidebarChatChange) { return this.changes.includes(change) }

  async enqueue(change: SidebarChatChange, send: () => Promise<boolean>) {
    const previous = this.commands.get(change.chatId) ?? Promise.resolve(true)
    // Serialize writes per chat and skip superseded intents that have not sent.
    // Different chats remain independent. Old acknowledgements cannot remove
    // the newer optimistic state because receive/settle compare object identity.
    const command = previous.catch(() => false).then(() => this.isCurrent(change) ? send() : true)
    this.commands.set(change.chatId, command)
    try { return await command }
    finally { if (this.commands.get(change.chatId) === command) this.commands.delete(change.chatId) }
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
