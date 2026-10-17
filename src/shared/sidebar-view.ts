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
