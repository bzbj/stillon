import { createJSONStorage } from "zustand/middleware"

// Host origins are assigned by Connect. Private drafts never persist on a
// remote browser; ordinary local installations keep their existing storage.
export function isConnectBrowser() {
  return typeof window !== "undefined" && /^h-[a-f0-9]{32}\./.test(window.location?.hostname ?? "")
}
export const privateBrowserStorage = createJSONStorage(() => ({
  getItem: (name: string) => { try { return isConnectBrowser() ? null : localStorage.getItem(name) } catch { return null } },
  setItem: (name: string, value: string) => { try { if (!isConnectBrowser()) localStorage.setItem(name, value) } catch { /* storage may be unavailable */ } },
  removeItem: (name: string) => { try { localStorage.removeItem(name) } catch { /* storage may be unavailable */ } },
}))

export function requestRemoteAuthCheck() {
  if (isConnectBrowser()) window.dispatchEvent(new Event("stillon:check-session"))
}
