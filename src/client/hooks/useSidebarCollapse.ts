import { useCallback, useEffect, useRef, useState } from "react"

interface PendingChoice { id: number; collapsed: boolean }

/** Keep the latest click visible until its own settings write is acknowledged. */
export function useSidebarCollapse(saved: boolean, save?: (collapsed: boolean) => Promise<unknown>) {
  const [pending, setPending] = useState<PendingChoice | null>(null)
  const [error, setError] = useState<string | null>(null)
  const sequence = useRef(0)
  const inFlight = useRef(new Set<number>())
  const setCollapsed = useCallback((collapsed: boolean) => {
    setPending({ id: ++sequence.current, collapsed })
    setError(null)
  }, [])

  useEffect(() => {
    if (!pending || !save || inFlight.current.has(pending.id)) return
    const choice = pending
    inFlight.current.add(choice.id)
    const clear = () => setPending(current => current?.id === choice.id ? null : current)
    // The shared settings writer reports errors and reads authoritative state
    // before rejecting, so clearing a failed choice rolls back safely.
    void Promise.resolve().then(() => save(choice.collapsed)).then(clear, () => {
      if (sequence.current === choice.id) setError("Could not save sidebar view. Please try again.")
      clear()
    })
      .finally(() => inFlight.current.delete(choice.id))
  }, [pending, save])

  return { collapsed: pending?.collapsed ?? saved, setCollapsed, error }
}
