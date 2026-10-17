export type WorkspaceCollapsed = Record<string, boolean>
export type WorkspaceCollapseVersions = Record<string, number>

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

export function normalizeWorkspaceCollapseVersions(value: unknown, choices: WorkspaceCollapsed): WorkspaceCollapseVersions {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
  return Object.fromEntries(Object.keys(choices).map(id => [id,
    Number.isSafeInteger(source[id]) && Number(source[id]) >= 0 ? Number(source[id]) : 0,
  ]))
}

/** Compare per-node versions inside the settings write queue, before any write. */
export function applyWorkspaceCollapsePatch(
  current: WorkspaceCollapsed | undefined, currentVersions: WorkspaceCollapseVersions | undefined,
  patch?: WorkspaceCollapsed, expected?: WorkspaceCollapseVersions,
) {
  const choices = mergeWorkspaceCollapsed(current, patch)
  const versions = normalizeWorkspaceCollapseVersions(currentVersions, choices)
  if (expected !== undefined) {
    if (!expected || typeof expected !== "object" || Array.isArray(expected)
      || !patch || Object.keys(expected).length !== Object.keys(patch).length
      || Object.entries(expected).some(([id, version]) => !validId(id)
        || !Object.hasOwn(patch, id) || !Number.isSafeInteger(version) || version < 0)) {
      throw new Error("Workspace view versions must match the supplied Workspace IDs.")
    }
    for (const [id, version] of Object.entries(expected)) {
      if (version !== versions[id]) throw new Error("Workspace view changed on another device. Reload or retry to save your choice.")
    }
  }
  for (const id of Object.keys(patch ?? {})) {
    if (versions[id]! >= Number.MAX_SAFE_INTEGER) throw new Error("Workspace view version limit reached.")
    versions[id] = versions[id]! + 1
  }
  return { workspaceCollapsed: choices, workspaceCollapseVersions: versions }
}
