import { create } from "zustand"
import { persist } from "zustand/middleware"

export type DiffCommitSelectionMode = "all" | "none"

export interface ProjectDiffCommitSelection {
  mode: DiffCommitSelectionMode
  exceptions: Record<string, boolean>
}

interface DiffCommitState {
  selectionsByProjectId: Record<string, ProjectDiffCommitSelection>
  reconcileProject: (projectId: string, paths: string[]) => void
  setChecked: (projectId: string, path: string, checked: boolean) => void
  setAllChecked: (projectId: string, paths: string[], checked: boolean) => void
}

function defaultCheckedForMode(mode: DiffCommitSelectionMode) {
  return mode === "all"
}

export function isDiffPathChecked(selection: ProjectDiffCommitSelection | undefined, path: string) {
  const mode = selection?.mode ?? "all"
  return selection?.exceptions[path] ?? defaultCheckedForMode(mode)
}

function compactProjectSelection(selection: ProjectDiffCommitSelection) {
  const defaultChecked = defaultCheckedForMode(selection.mode)
  return {
    mode: selection.mode,
    exceptions: Object.fromEntries(
      Object.entries(selection.exceptions).filter(([, checked]) => checked !== defaultChecked)
    ),
  }
}

function pruneProjectSelection(selection: ProjectDiffCommitSelection, paths: string[]) {
  const knownPaths = new Set(paths)
  return compactProjectSelection({
    mode: selection.mode,
    exceptions: Object.fromEntries(
      Object.entries(selection.exceptions).filter(([path]) => knownPaths.has(path))
    ),
  })
}

function setProjectSelection(
  selectionsByProjectId: Record<string, ProjectDiffCommitSelection>,
  projectId: string,
  selection: ProjectDiffCommitSelection | undefined
) {
  const next = { ...selectionsByProjectId }
  if (!selection || (selection.mode === "all" && Object.keys(selection.exceptions).length === 0)) {
    delete next[projectId]
  } else {
    next[projectId] = compactProjectSelection(selection)
  }
  return next
}

function migrateFullPathSnapshot(selections: Record<string, Record<string, boolean>>) {
  return Object.fromEntries(
    Object.entries(selections)
      .map(([projectId, checkedPaths]) => {
        const entries = Object.entries(checkedPaths ?? {})
        const checkedEntries = entries.filter(([, checked]) => checked === true)
        const uncheckedEntries = entries.filter(([, checked]) => checked === false)
        const useNoneMode = checkedEntries.length < uncheckedEntries.length
        const selection: ProjectDiffCommitSelection = useNoneMode
          ? { mode: "none", exceptions: Object.fromEntries(checkedEntries) }
          : { mode: "all", exceptions: Object.fromEntries(uncheckedEntries) }
        return [projectId, compactProjectSelection(selection)] as const
      })
      .filter(([, selection]) => selection.mode === "none" || Object.keys(selection.exceptions).length > 0)
  )
}

function migrateSparseUncheckedSnapshot(selections: Record<string, Record<string, boolean>>) {
  return Object.fromEntries(
    Object.entries(selections)
      .map(([projectId, checkedPaths]) => [
        projectId,
        compactProjectSelection({
          mode: "all",
          exceptions: Object.fromEntries(
            Object.entries(checkedPaths ?? {}).filter(([, checked]) => checked === false)
          ),
        }),
      ] as const)
      .filter(([, selection]) => Object.keys(selection.exceptions).length > 0)
  )
}

export function migrateDiffCommitStore(persistedState: unknown, persistedVersion = 0) {
  if (!persistedState || typeof persistedState !== "object") {
    return { selectionsByProjectId: {} }
  }

  const state = persistedState as {
    checkedPathsByProjectId?: Record<string, Record<string, boolean>>
    selectionsByProjectId?: Record<string, ProjectDiffCommitSelection>
  }

  if (state.selectionsByProjectId) {
    return {
      selectionsByProjectId: Object.fromEntries(
        Object.entries(state.selectionsByProjectId).map(([projectId, selection]) => [
          projectId,
          compactProjectSelection({
            mode: selection?.mode === "none" ? "none" : "all",
            exceptions: selection?.exceptions ?? {},
          }),
        ])
      ),
    }
  }

  const checkedPathsByProjectId = state.checkedPathsByProjectId ?? {}
  return {
    selectionsByProjectId: persistedVersion >= 3
      ? migrateSparseUncheckedSnapshot(checkedPathsByProjectId)
      : migrateFullPathSnapshot(checkedPathsByProjectId),
  }
}

export const useDiffCommitStore = create<DiffCommitState>()(
  persist(
    (set) => ({
      selectionsByProjectId: {},
      reconcileProject: (projectId, paths) => set((state) => {
        if (paths.length === 0) {
          return {
            selectionsByProjectId: setProjectSelection(state.selectionsByProjectId, projectId, undefined),
          }
        }
        const current = state.selectionsByProjectId[projectId] ?? { mode: "all", exceptions: {} }
        const next = pruneProjectSelection(current, paths)
        if (
          current.mode === next.mode
          && Object.keys(current.exceptions).length === Object.keys(next.exceptions).length
          && Object.entries(next.exceptions).every(([path, checked]) => current.exceptions[path] === checked)
        ) {
          return state
        }
        return {
          selectionsByProjectId: setProjectSelection(state.selectionsByProjectId, projectId, next),
        }
      }),
      setChecked: (projectId, path, checked) => set((state) => {
        const current = state.selectionsByProjectId[projectId] ?? { mode: "all", exceptions: {} }
        const next = {
          mode: current.mode,
          exceptions: { ...current.exceptions, [path]: checked },
        }
        return {
          selectionsByProjectId: setProjectSelection(state.selectionsByProjectId, projectId, next),
        }
      }),
      setAllChecked: (projectId, _paths, checked) => set((state) => ({
        selectionsByProjectId: setProjectSelection(
          state.selectionsByProjectId,
          projectId,
          { mode: checked ? "all" : "none", exceptions: {} }
        ),
      })),
    }),
    {
      name: "diff-commit-selections",
      version: 4,
      migrate: migrateDiffCommitStore,
    }
  )
)
