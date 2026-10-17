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
) {
  const [session] = useState(() => new WorkspaceCollapseSession(saved, versions))
  const initialChat = useRef(activeChatId)
  const revealedChat = useRef(activeChatId)
  session.includeGroups(groups, initialChat.current)
  session.setSharedVersions(versions)
  const view = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)
  useEffect(() => {
    session.setWriter(save)
    return () => session.setWriter(undefined)
  }, [session, save])
  useEffect(() => {
    if (!activeChatId) { revealedChat.current = null; return }
    if (revealedChat.current === activeChatId) return
    const group = groups.find(g => g.chats.some(c => c.chatId === activeChatId))
    if (group) { revealedChat.current = activeChatId; session.reveal(group.groupKey) }
  }, [session, groups, activeChatId])
  const collapsedSections = useMemo(() => new Set(groups.filter(g => view.choices[g.groupKey] !== false).map(g => g.groupKey)), [groups, view.choices])
  return { collapsedSections, setSectionCollapsed: session.choose,
    revealSection: session.reveal, retry: session.retry, error: view.error, unsynced: view.unsynced }
}
