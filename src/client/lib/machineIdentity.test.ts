import { describe, expect, test } from "bun:test"
import {
  normalizeMachineIdentityName,
  persistMachineIdentityName,
  readStoredMachineIdentityName,
} from "./machineIdentity"

function createStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  }
}

describe("machine identity cache", () => {
  test("accepts only meaningful saved names", () => {
    expect(normalizeMachineIdentityName("  Studio Mac  ")).toBe("Studio Mac")
    expect(normalizeMachineIdentityName("   ")).toBeNull()
    expect(normalizeMachineIdentityName(null)).toBeNull()
  })

  test("persists only a confirmed non-empty name", () => {
    const storage = createStorage()
    persistMachineIdentityName("  Studio Mac  ", storage)
    expect(readStoredMachineIdentityName(storage)).toBe("Studio Mac")

    persistMachineIdentityName("", storage)
    expect(readStoredMachineIdentityName(storage)).toBeNull()
  })
})
