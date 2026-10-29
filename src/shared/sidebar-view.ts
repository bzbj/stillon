import { mergeWorkspaceCollapsed, normalizeWorkspaceCollapseVersions, type WorkspaceCollapsed, type WorkspaceCollapseVersions } from "./workspace-collapse"

/** Only the host-owned preferences needed before the workspace first paints. */
export interface SidebarViewSnapshot {
  machineName: string
  workspaceCollapsed: WorkspaceCollapsed
  workspaceCollapseVersions: WorkspaceCollapseVersions
}

export function parseSidebarViewSnapshot(value: unknown): SidebarViewSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  if (typeof source.machineName !== "string" || !source.machineName.trim()
    || source.workspaceCollapsed === undefined) return null
  try {
    const choices = mergeWorkspaceCollapsed({}, source.workspaceCollapsed as WorkspaceCollapsed)
    const versions = normalizeWorkspaceCollapseVersions(source.workspaceCollapseVersions, choices)
    if (source.workspaceCollapseVersions !== undefined) {
      const raw = source.workspaceCollapseVersions
      if (!raw || typeof raw !== "object" || Array.isArray(raw)
        || Object.entries(raw).some(([key, value]) => !Object.hasOwn(choices, key) || versions[key] !== value)) return null
    }
    return {
      machineName: source.machineName,
      workspaceCollapsed: choices,
      workspaceCollapseVersions: versions,
    }
  } catch { return null }
}

import type { SidebarView } from "./types"

export const SIDEBAR_INITIAL_CHAT_LIMIT = 5
export const SIDEBAR_MORE_CHAT_LIMIT = 20
export const SIDEBAR_MAX_CHAT_LIMIT = Number.MAX_SAFE_INTEGER

/** Invalid projections must never silently fall back to a full sidebar. */
export function normalizeSidebarView(value: unknown): SidebarView | null {
  if (!value || typeof value !== "object") return null
  const view = value as SidebarView
  const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512
  const limit = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= SIDEBAR_MAX_CHAT_LIMIT
  if (view.version !== 1 || !Array.isArray(view.groups) || view.groups.length > 200) return null
  if (view.groups.some(group => !group || !id(group.groupKey) || !limit(group.limit))) return null
  if (new Set(view.groups.map(group => group.groupKey)).size !== view.groups.length) return null
  if (view.archived !== undefined && (!view.archived || !id(view.archived.groupKey) || !limit(view.archived.limit))) return null
  if (view.search !== undefined && (typeof view.search !== "string" || view.search.length > 200)) return null
  if (view.searchLimit !== undefined && !limit(view.searchLimit)) return null
  if (view.activeChatId !== undefined && !id(view.activeChatId)) return null
  return { version: 1, groups: view.groups.map(({ groupKey, limit }) => ({ groupKey, limit })),
    ...(view.archived ? { archived: { groupKey: view.archived.groupKey, limit: view.archived.limit } } : {}),
    ...(view.search?.trim() ? { search: view.search.trim(), searchLimit: view.searchLimit ?? 50 } : {}),
    ...(view.activeChatId ? { activeChatId: view.activeChatId } : {}) }
}
