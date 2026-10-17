export type WorkspaceCollapsed = Record<string, boolean>

function validId(id: string) {
  return Boolean(id.trim()) && id.length <= 256 && !["__proto__", "constructor", "prototype"].includes(id)
}

export function normalizeWorkspaceCollapsed(value: unknown): WorkspaceCollapsed {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).filter(([id, collapsed]) => validId(id) && typeof collapsed === "boolean"))
}

/** Patch only the Workspace IDs supplied, preserving choices from other tabs. */
export function mergeWorkspaceCollapsed(current: unknown, patch?: WorkspaceCollapsed): WorkspaceCollapsed {
  if (patch === undefined) return normalizeWorkspaceCollapsed(current)
  if (!patch || typeof patch !== "object" || Array.isArray(patch)
    || Object.entries(patch).some(([id, collapsed]) => !validId(id) || typeof collapsed !== "boolean")) {
    throw new Error("Workspace collapse preferences must map Workspace IDs to true or false.")
  }
  return { ...normalizeWorkspaceCollapsed(current), ...patch }
}
