import { mergeWorkspaceCollapsed, type WorkspaceCollapsed } from "./workspace-collapse"

/** Only the host-owned preferences needed before the workspace first paints. */
export interface SidebarViewSnapshot {
  machineName: string
  workspaceCollapsed: WorkspaceCollapsed
  sidebarCollapsed: boolean
}

export function parseSidebarViewSnapshot(value: unknown): SidebarViewSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  if (typeof source.machineName !== "string" || !source.machineName.trim()
    || typeof source.sidebarCollapsed !== "boolean" || source.workspaceCollapsed === undefined) return null
  try {
    return {
      machineName: source.machineName,
      sidebarCollapsed: source.sidebarCollapsed,
      workspaceCollapsed: mergeWorkspaceCollapsed({}, source.workspaceCollapsed as WorkspaceCollapsed),
    }
  } catch { return null }
}
