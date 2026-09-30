import type { AppSettingsSnapshot, SidebarProjectGroup } from "../../shared/types"

/**
 * Browser-local cache for the selected default project.
 *
 * The authoritative value lives server-side in app settings (`defaultProjectId`)
 * so the choice follows the user across browsers, devices, and origins. This
 * localStorage entry is only a fast, synchronous hint used to render the correct
 * project before the settings snapshot arrives, and to migrate older clients
 * that stored the value here exclusively.
 */
const STORAGE_KEY = "stillon.defaultProjectId"

export function readCachedDefaultProjectId(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

export function writeCachedDefaultProjectId(projectId: string | null): void {
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

/**
 * Resolves the effective default project for the current session.
 *
 * The server snapshot wins whenever settings have hydrated, because it is the
 * shared source of truth — including an explicit server-side clear (`null`).
 * Until the snapshot arrives we fall back to the localStorage hint so the very
 * first paint already shows the expected project.
 */
export function resolveDefaultProjectId(
  settings: Pick<AppSettingsSnapshot, "defaultProjectId"> | null,
  cached: string | null,
): string | null {
  return settings ? settings.defaultProjectId : cached
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
