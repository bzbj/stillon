import type { SidebarProjectGroup } from "../../shared/types"
import { normalizeWorkspaceCollapsed, type WorkspaceCollapsed, type WorkspaceCollapseVersions } from "../../shared/workspace-collapse"

type Choice = { id: number; collapsed: boolean; version: number; failed: boolean }
export type SaveWorkspaceCollapse = (patch: WorkspaceCollapsed, expected: WorkspaceCollapseVersions) =>
  Promise<{ workspaceCollapseVersions?: WorkspaceCollapseVersions }>
interface View { choices: WorkspaceCollapsed; error: string | null; unsynced: boolean }

/** Shared snapshots inform future writes; each window owns its visible tree. */
export class WorkspaceCollapseSession {
  private view: View
  private versions: WorkspaceCollapseVersions
  private seeded = false
  private sequence = 0
  private readonly pending = new Map<string, Choice>()
  private readonly writing = new Set<string>()
  private readonly listeners = new Set<() => void>()
  private writer: SaveWorkspaceCollapse | undefined

  constructor(saved?: WorkspaceCollapsed, versions: WorkspaceCollapseVersions = {}) {
    this.view = { choices: normalizeWorkspaceCollapsed(saved), error: null, unsynced: false }
    this.versions = versions
  }
  getSnapshot = () => this.view
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  setSharedVersions(versions: WorkspaceCollapseVersions) {
    this.versions = { ...versions, ...Object.fromEntries(Object.entries(this.versions)
      .map(([key, value]) => [key, Math.max(value, versions[key] ?? 0)])) }
  }

  includeGroups(groups: SidebarProjectGroup[], initialChatId: string | null) {
    if (!groups.length) return
    let expanded: string | undefined
    if (!this.seeded) {
      expanded = groups.find(g => (initialChatId && g.activeChatId === initialChatId) || g.chats.some(c => c.chatId === initialChatId))?.groupKey
      if (!expanded) {
        let newest = 0
        for (const group of groups) {
          if ((group.lastActivityAt ?? 0) > newest) { newest = group.lastActivityAt!; expanded = group.groupKey }
          for (const chat of group.chats) {
            const time = chat.lastMessageAt ?? chat._creationTime
            if (time > newest) { newest = time; expanded = group.groupKey }
          }
        }
      }
    }
    const missing = groups.filter(g => !Object.hasOwn(this.view.choices, g.groupKey))
    if (missing.length) this.view = { ...this.view, choices: { ...this.view.choices,
      ...Object.fromEntries(missing.map(g => [g.groupKey, g.groupKey !== expanded])),
    } }
    this.seeded = true
  }
  choose = (key: string, collapsed: boolean) => {
    this.pending.set(key, { id: ++this.sequence, collapsed, version: this.versions[key] ?? 0, failed: false })
    this.update({ choices: { ...this.view.choices, [key]: collapsed }, error: null })
    this.flush()
  }
  reveal = (key: string) => {
    if (this.view.choices[key] !== false) this.update({ choices: { ...this.view.choices, [key]: false } })
  }
  setWriter(writer?: SaveWorkspaceCollapse) { this.writer = writer; this.flush() }
  retry = () => {
    for (const [key, choice] of this.pending) if (choice.failed) {
      this.pending.set(key, { ...choice, failed: false, version: this.versions[key] ?? 0 })
    }
    this.update({ error: null })
    this.flush()
  }
  private update(patch: Partial<View>) {
    const failed = [...this.pending.values()].some(choice => choice.failed)
    this.view = { ...this.view, ...patch, unsynced: this.pending.size > 0,
      error: failed ? "View not synced. Your choice is kept in this window." : null }
    for (const listener of this.listeners) listener()
  }
  private flush() {
    for (const [key, choice] of this.pending) {
      if (this.writer && !choice.failed && !this.writing.has(key)) void this.drain(key)
    }
  }
  private async drain(key: string) {
    this.writing.add(key)
    try {
      while (this.writer) {
        const choice = this.pending.get(key)
        if (!choice || choice.failed) break
        try {
          const snapshot = await this.writer({ [key]: choice.collapsed }, { [key]: choice.version })
          const version = snapshot.workspaceCollapseVersions?.[key] ?? choice.version + 1
          this.versions = { ...this.versions, [key]: Math.max(this.versions[key] ?? 0, version) }
          const next = this.pending.get(key)
          if (next?.id === choice.id) this.pending.delete(key)
          else if (next) this.pending.set(key, { ...next, version })
          this.update({})
        } catch {
          const next = this.pending.get(key)
          if (next) this.pending.set(key, { ...next, failed: true })
          this.update({ error: "View not synced. Your choice is kept in this window." })
          break
        }
      }
    } finally { this.writing.delete(key) }
  }
}
