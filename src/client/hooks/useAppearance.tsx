import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react"
import { useLocation } from "react-router-dom"
import { appearanceVariables, normalizeAppearance, type AppearanceSettings } from "../../shared/appearance"
import { useAppSettingsStore } from "../stores/appSettingsStore"
import { syncThemeMetadata, useTheme, type ThemePreference } from "./useTheme"
import "./appearance.css"

interface AppearancePreview { appearance: AppearanceSettings; theme: ThemePreference }
interface AppearanceContextValue {
  appearance: AppearanceSettings
  preview: AppearancePreview | null
  safeMode: boolean
  setPreview: (value: AppearancePreview | null) => void
}
const AppearanceContext = createContext<AppearanceContextValue | null>(null)

/** Restore only our own overrides, so safe mode and cancelled previews use built-in CSS. */
export function applyAppearanceToRoot(root: HTMLElement, variables: Record<string, string>) {
  const previous = Object.keys(variables).map((key) => [key, root.style.getPropertyValue(key), root.style.getPropertyPriority(key)])
  for (const [key, value] of Object.entries(variables)) root.style.setProperty(key, value)
  return () => {
    for (const [key, value, priority] of previous) {
      if (value) root.style.setProperty(key!, value, priority)
      else root.style.removeProperty(key!)
    }
  }
}

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const settings = useAppSettingsStore((store) => store.settings?.appearance)
  const { resolvedTheme, setPreviewTheme } = useTheme()
  const location = useLocation()
  const [preview, setPreview] = useState<AppearancePreview | null>(null)
  const [safeMode, setSafeMode] = useState(() => new URLSearchParams(location.search).get("safe-mode") === "1")
  useEffect(() => {
    if (new URLSearchParams(location.search).get("safe-mode") === "1") setSafeMode(true)
  }, [location.search])
  const appearance = useMemo(() => normalizeAppearance(safeMode ? undefined : preview?.appearance ?? settings), [preview, safeMode, settings])

  useEffect(() => { setPreview(null) }, [location.pathname, safeMode])
  useEffect(() => {
    setPreviewTheme(safeMode ? null : preview?.theme ?? null)
    return () => setPreviewTheme(null)
  }, [preview?.theme, safeMode, setPreviewTheme])
  useEffect(() => {
    if (!preview) return
    const timeout = window.setTimeout(() => setPreview(null), 60_000)
    return () => window.clearTimeout(timeout)
  }, [preview])

  useLayoutEffect(() => {
    const root = document.documentElement
    root.dataset.stillonAppearance = safeMode ? "safe" : "custom"
    root.dataset.stillonDensity = appearance.density
    root.dataset.stillonSurface = appearance.surface
    root.dataset.stillonWallpaper = !safeMode && appearance.backgroundAsset && appearance.backgroundOpacity > 0 ? "visible" : "hidden"
    const cleanup = safeMode ? () => {} : applyAppearanceToRoot(root, appearanceVariables(appearance, resolvedTheme))
    syncThemeMetadata(resolvedTheme)
    return () => {
      cleanup()
      delete root.dataset.stillonAppearance
      delete root.dataset.stillonDensity
      delete root.dataset.stillonSurface
      delete root.dataset.stillonWallpaper
    }
  }, [appearance, resolvedTheme, safeMode])

  return (
    <AppearanceContext.Provider value={{ appearance, preview, safeMode, setPreview }}>
      {children}
      {preview && !safeMode ? (
        <div role="status" aria-label="Appearance preview" style={{ position: "fixed", top: 16, left: "50%", transform: "translateX(-50%)", zIndex: 100, background: "#202123", color: "#fff", borderRadius: 12, padding: "10px 16px", boxShadow: "0 4px 24px #0003", display: "flex", gap: 16, alignItems: "center", maxWidth: "calc(100vw - 32px)", fontFamily: "system-ui", fontSize: 13 }}>
          <span>Preview · reverts after 60 seconds</span>
          <button type="button" onClick={() => setPreview(null)} style={{ color: "#fff", textDecoration: "underline", whiteSpace: "nowrap" }}>End preview</button>
        </div>
      ) : null}
    </AppearanceContext.Provider>
  )
}

export function useOptionalAppearance() { return useContext(AppearanceContext) }

export function useAppearance() {
  const context = useContext(AppearanceContext)
  if (!context) throw new Error("useAppearance must be used within AppearanceProvider")
  return context
}
