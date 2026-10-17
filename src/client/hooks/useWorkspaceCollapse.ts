import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { SidebarProjectGroup } from "../../shared/types"
import type { WorkspaceCollapsed } from "../../shared/workspace-collapse"

interface PendingChoice { id: number; collapsed: boolean }

export function useWorkspaceCollapse(
  groups: SidebarProjectGroup[],
  saved: WorkspaceCollapsed | undefined,
  save?: (patch: WorkspaceCollapsed) => Promise<unknown>,
) {
  const [pending, setPending] = useState<Record<string, PendingChoice>>({})
  const [error, setError] = useState<string | null>(null)
  const sequence = useRef(0)
  const latest = useRef(new Map<string, number>())
  const inFlight = useRef(new Set<number>())
  const collapsedSections = useMemo(() => new Set(groups.filter(group => {
    const manual = pending[group.groupKey]?.collapsed ?? saved?.[group.groupKey]
    return typeof manual === "boolean" ? manual : group.defaultCollapsed
  }).map(group => group.groupKey)), [groups, pending, saved])

  const setSectionCollapsed = useCallback((key: string, collapsed: boolean) => {
    const id = ++sequence.current
    latest.current.set(key, id)
    setPending(current => ({ ...current, [key]: { id, collapsed } }))
    setError(null)
  }, [])

  useEffect(() => {
    if (!save) return
    for (const [key, choice] of Object.entries(pending)) {
      if (inFlight.current.has(choice.id)) continue
      inFlight.current.add(choice.id)
      const clear = () => setPending(current => {
        if (current[key]?.id !== choice.id) return current
        const next = { ...current }; delete next[key]; return next
      })
      // Keep the latest local intent visible through older acknowledgments and
      // initial settings hydration. The shared settings store supplies the ack.
      void Promise.resolve().then(() => save({ [key]: choice.collapsed })).then(clear, () => {
        if (latest.current.get(key) !== choice.id) return
        clear()
        setError("Could not save workspace view. Please try again.")
      }).finally(() => inFlight.current.delete(choice.id))
    }
  }, [pending, save])

  return { collapsedSections, setSectionCollapsed, error }
}
