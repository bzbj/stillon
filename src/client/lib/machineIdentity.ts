const MACHINE_IDENTITY_STORAGE_KEY = "stillon:machine-identity"

type StorageLike = Pick<Storage, "getItem" | "removeItem" | "setItem">

export function normalizeMachineIdentityName(value: unknown): string | null {
  if (typeof value !== "string") return null
  const normalized = value.trim()
  return normalized || null
}

export function readStoredMachineIdentityName(storage: Pick<StorageLike, "getItem"> | null | undefined): string | null {
  if (!storage) return null

  try {
    return normalizeMachineIdentityName(storage.getItem(MACHINE_IDENTITY_STORAGE_KEY))
  } catch {
    return null
  }
}

export function persistMachineIdentityName(
  machineName: unknown,
  storage: Pick<StorageLike, "removeItem" | "setItem"> | null | undefined
) {
  if (!storage) return

  try {
    const normalized = normalizeMachineIdentityName(machineName)
    if (normalized) {
      storage.setItem(MACHINE_IDENTITY_STORAGE_KEY, normalized)
    } else {
      storage.removeItem(MACHINE_IDENTITY_STORAGE_KEY)
    }
  } catch {
    // Local storage is an optional cosmetic cache. The server snapshot remains authoritative.
  }
}

export function getBrowserMachineIdentityStorage() {
  if (typeof window === "undefined") return null

  try {
    return window.localStorage
  } catch {
    return null
  }
}
