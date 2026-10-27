import { expect, test } from "bun:test"
import { finishSetup, isSetupComplete, rememberSettingsSection, settingsLandingPath } from "./settingsNavigation"

test("setup completion, legacy progress, returning destinations and unavailable storage", () => {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
  const values = new Map<string, string>()
  const events = new EventTarget()
  let notifications = 0
  events.addEventListener("stillon:settings-navigation-changed", () => notifications++)
  Object.defineProperty(globalThis, "window", { configurable: true, value: events })
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  } })
  try {
    expect(isSetupComplete()).toBe(false)
    expect(settingsLandingPath()).toBe("/settings/welcome")
    rememberSettingsSection("providers")
    expect(settingsLandingPath()).toBe("/settings/welcome")
    values.set("stillon:onboarding-progress-v1", JSON.stringify({ nameConfirmed: true, claudeChecked: true }))
    expect(isSetupComplete()).toBe(true)
    expect(settingsLandingPath()).toBe("/settings/providers")
    values.set("stillon:onboarding-progress-v1", "{}")
    finishSetup()
    expect(notifications).toBe(1)
    expect(settingsLandingPath()).toBe("/settings/providers")
    rememberSettingsSection("welcome")
    expect(settingsLandingPath()).toBe("/settings/providers")
    values.set("stillon:last-settings-section-v1", "removed-section")
    expect(settingsLandingPath()).toBe("/settings/network")
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => { throw new Error("blocked") } })
    rememberSettingsSection("about")
    finishSetup()
    expect(settingsLandingPath()).toBe("/settings/about")
  } finally {
    if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow)
    else Reflect.deleteProperty(globalThis, "window")
    if (oldStorage) Object.defineProperty(globalThis, "localStorage", oldStorage)
    else Reflect.deleteProperty(globalThis, "localStorage")
  }
})
