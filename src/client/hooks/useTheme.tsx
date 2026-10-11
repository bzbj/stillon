import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import { useAppSettingsStore } from "../stores/appSettingsStore"

export type ThemePreference = "light" | "dark" | "system"

interface ThemeContextValue {
  theme: ThemePreference
  resolvedTheme: "light" | "dark"
  setTheme: (theme: ThemePreference) => void
  setPreviewTheme: (theme: ThemePreference | null) => void
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined)

const isValidTheme = (value: string | null): value is ThemePreference => {
  return value === "light" || value === "dark" || value === "system"
}

export function getAppleMobileWebAppStatusBarStyle(theme: "light" | "dark") {
  return theme === "dark" ? "black-translucent" : "default"
}

function upsertHeadMeta(name: string, content: string) {
  if (typeof document === "undefined") return

  let tag = document.head.querySelector(`meta[name="${name}"]`)
  if (!tag) {
    tag = document.createElement("meta")
    tag.setAttribute("name", name)
    document.head.appendChild(tag)
  }
  tag.setAttribute("content", content)
}

export function syncThemeMetadata(theme: "light" | "dark") {
  if (typeof document === "undefined" || typeof window === "undefined") return

  const backgroundColor = getComputedStyle(document.body).backgroundColor || getComputedStyle(document.documentElement).backgroundColor
  if (backgroundColor) {
    upsertHeadMeta("theme-color", backgroundColor)
  }
  upsertHeadMeta("apple-mobile-web-app-status-bar-style", getAppleMobileWebAppStatusBarStyle(theme))
  document.documentElement.style.colorScheme = theme
}

const getSystemTheme = (): "light" | "dark" => {
  if (typeof window === "undefined") return "light"
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

const applyThemeClass = (preference: ThemePreference) => {
  if (typeof document === "undefined") return
  const resolved = preference === "system" ? getSystemTheme() : preference
  document.documentElement.classList.toggle("dark", resolved === "dark")
}

const getInitialTheme = (): ThemePreference => {
  const stored = useAppSettingsStore.getState().settings?.theme
  return stored && isValidTheme(stored) ? stored : "system"
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const settingsTheme = useAppSettingsStore((store) => store.settings?.theme)
  const applyOptimisticPatch = useAppSettingsStore((store) => store.applyOptimisticPatch)
  const [theme, setTheme] = useState<ThemePreference>(getInitialTheme)
  const [previewTheme, setPreviewTheme] = useState<ThemePreference | null>(null)
  const [systemTheme, setSystemTheme] = useState(getSystemTheme)
  const effectiveTheme = previewTheme ?? theme
  const resolvedTheme = effectiveTheme === "system" ? systemTheme : effectiveTheme

  useEffect(() => {
    if (!settingsTheme || settingsTheme === theme) return
    setTheme(settingsTheme)
  }, [settingsTheme, theme])

  useEffect(() => {
    applyThemeClass(resolvedTheme)
    syncThemeMetadata(resolvedTheme)
  }, [resolvedTheme])

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)")
    const handleChange = () => setSystemTheme(getSystemTheme())
    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener("change", handleChange)
      return () => mediaQuery.removeEventListener("change", handleChange)
    }
    mediaQuery.addListener(handleChange)
    return () => mediaQuery.removeListener(handleChange)
  }, [])

  const value = useMemo<ThemeContextValue>(() => {
    return {
      theme,
      resolvedTheme,
      setPreviewTheme,
      setTheme: (nextTheme) => {
        setTheme(nextTheme)
        applyOptimisticPatch({ theme: nextTheme })
      },
    }
  }, [applyOptimisticPatch, resolvedTheme, theme])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const context = useContext(ThemeContext)
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider")
  }
  return context
}
