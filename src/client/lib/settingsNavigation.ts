import { useSyncExternalStore } from "react"

const PROGRESS_KEY = "stillon:onboarding-progress-v1"
const COMPLETE_KEY = "stillon:setup-complete-v1"
const LAST_KEY = "stillon:last-settings-section-v1"
const CHANGED = "stillon:settings-navigation-changed"
const sections = ["network", "providers", "usage", "skills", "appearance", "remote", "about"]
let completedInMemory = false
let lastInMemory = "network"

export function isSetupComplete() {
  if (typeof window === "undefined") return false
  try {
    if (completedInMemory || localStorage.getItem(COMPLETE_KEY) === "1") return true
    const progress = JSON.parse(localStorage.getItem(PROGRESS_KEY) ?? "{}")
    return (progress.nameConfirmed === true && (progress.codexChecked === true || progress.claudeChecked === true))
  } catch { return completedInMemory }
}
export function finishSetup() {
  completedInMemory = true
  try { localStorage.setItem(COMPLETE_KEY, "1") } catch { /* Keep navigation usable without storage. */ }
  window.dispatchEvent(new Event(CHANGED))
}
export function rememberSettingsSection(section: string) {
  if (!sections.includes(section)) return
  lastInMemory = section
  try { localStorage.setItem(LAST_KEY, section) } catch { /* Use the current tab's fallback. */ }
}
export function settingsLandingPath() {
  if (!isSetupComplete()) return "/settings/welcome"
  let last = lastInMemory
  try { last = localStorage.getItem(LAST_KEY) ?? last } catch { /* Use the in-memory fallback. */ }
  return `/settings/${sections.includes(last) ? last : "network"}`
}
function subscribe(listener: () => void) {
  window.addEventListener("storage", listener)
  window.addEventListener(CHANGED, listener)
  return () => { window.removeEventListener("storage", listener); window.removeEventListener(CHANGED, listener) }
}
export function useSetupComplete() {
  return useSyncExternalStore(subscribe, isSetupComplete, () => false)
}
