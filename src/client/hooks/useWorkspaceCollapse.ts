import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import type { SidebarProjectGroup } from "../../shared/types"
import type { WorkspaceCollapsed, WorkspaceCollapseVersions } from "../../shared/workspace-collapse"
import { WorkspaceCollapseSession, type SaveWorkspaceCollapse } from "../lib/workspaceCollapseSession"

export function useWorkspaceCollapse(
  groups: SidebarProjectGroup[],
  saved: WorkspaceCollapsed | undefined,
  versions: WorkspaceCollapseVersions,
  activeChatId: string | null,
  save?: SaveWorkspaceCollapse,
  authoritative = true,
) {
  const [session] = useState(() => new WorkspaceCollapseSession(saved, versions))
  const initialChat = useRef(activeChatId)
  const revealedChat = useRef(activeChatId)
  // Saved choices apply immediately; first-use defaults need the live catalog.
  if (authoritative) session.includeGroups(groups, initialChat.current)
  session.setSharedVersions(versions)
  const view = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)
  useEffect(() => {
    session.setWriter(save)
    return () => session.setWriter(undefined)
  }, [session, save])
  useEffect(() => {
    if (!activeChatId) { revealedChat.current = null; return }
    if (revealedChat.current === activeChatId) return
    const group = groups.find(g => g.activeChatId === activeChatId || g.chats.some(c => c.chatId === activeChatId))
    if (group) { revealedChat.current = activeChatId; session.reveal(group.groupKey) }
  }, [session, groups, activeChatId])
  const collapsedSections = useMemo(() => new Set(groups.filter(g => view.choices[g.groupKey] ?? (authoritative ? true : g.defaultCollapsed)).map(g => g.groupKey)), [groups, view.choices, authoritative])
  return { collapsedSections, setSectionCollapsed: session.choose,
    revealSection: session.reveal, retry: session.retry, error: view.error, unsynced: view.unsynced }
}
