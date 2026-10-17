import { useCallback, useRef, useState } from "react"
import { browserLayoutStorage, clampSidebarWidth, readSidebarLayout, writeSidebarLayout, type SidebarLayout } from "../lib/sidebarLayout"

/** Other tabs' storage events do not move this window. */
export function useSidebarLayout(scope: string) {
  const [layout, setLayout] = useState(() => readSidebarLayout(scope, browserLayoutStorage()))
  const current = useRef(layout)
  const update = useCallback((patch: Partial<SidebarLayout>) => {
    const next = { ...current.current, ...patch }
    current.current = next
    // Save only this action; another open tab may have saved the other field.
    writeSidebarLayout(scope, patch, browserLayoutStorage())
    setLayout(next)
  }, [scope])
  const setCollapsed = useCallback((collapsed: boolean) => update({ collapsed }), [update])
  const setWidth = useCallback((width: number) => update({ width: clampSidebarWidth(width) }), [update])
  return { ...layout, setCollapsed, setWidth }
}
