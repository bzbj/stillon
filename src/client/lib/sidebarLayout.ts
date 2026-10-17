export const DEFAULT_SIDEBAR_WIDTH = 275
export const MIN_SIDEBAR_WIDTH = 220
export const MAX_SIDEBAR_WIDTH = 520
export interface SidebarLayout { collapsed: boolean; width: number }
export interface LayoutStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }

export function clampSidebarWidth(width: number) {
  if (!Number.isFinite(width)) return DEFAULT_SIDEBAR_WIDTH
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)))
}
function layoutKey(scope: string) { return "stillon:sidebar-layout:v1:" + scope }
export function readSidebarLayout(scope: string, storage?: LayoutStorage | null): SidebarLayout {
  const fallback = { collapsed: false, width: DEFAULT_SIDEBAR_WIDTH }
  try {
    const raw = storage?.getItem(layoutKey(scope))
    if (!raw) {
      const legacyWidth = storage?.getItem("kanna:sidebar-width")
      return legacyWidth ? { ...fallback, width: clampSidebarWidth(Number(legacyWidth)) } : fallback
    }
    const value = JSON.parse(raw)
    return { collapsed: value?.collapsed === true, width: typeof value?.width === "number" ? clampSidebarWidth(value.width) : DEFAULT_SIDEBAR_WIDTH }
  } catch { return fallback }
}
export function writeSidebarLayout(scope: string, layout: SidebarLayout, storage?: LayoutStorage | null) {
  try { storage?.setItem(layoutKey(scope), JSON.stringify({ collapsed: layout.collapsed, width: clampSidebarWidth(layout.width) })) }
  catch { /* Keep the current window usable when browser storage is unavailable. */ }
}
export function browserLayoutStorage() {
  try { return typeof window === "undefined" ? null : window.localStorage } catch { return null }
}
