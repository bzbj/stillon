import type { SidebarProjectGroup } from "../../shared/types"

const STORAGE_KEY = "stillon.defaultProjectId"

export function readDefaultProjectId(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

export function writeDefaultProjectId(projectId: string | null): void {
  try {
    if (projectId) {
      window.localStorage.setItem(STORAGE_KEY, projectId)
    } else {
      window.localStorage.removeItem(STORAGE_KEY)
    }
  } catch {
    // A disabled storage backend should not prevent starting a conversation.
  }
}

export function resolveHomeProject(
  groups: SidebarProjectGroup[],
  selectedProjectId: string | null,
  defaultProjectId: string | null,
): SidebarProjectGroup | null {
  return groups.find((group) => group.groupKey === selectedProjectId)
    ?? groups.find((group) => group.groupKey === defaultProjectId)
    ?? groups[0]
    ?? null
}
