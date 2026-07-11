import { describe, expect, test } from "bun:test"
import { getMachineDisplayName, MAX_MACHINE_NAME_LENGTH, normalizeMachineName } from "./machine-name"

describe("machine display name", () => {
  test("uses a sanitized public display-name override", () => {
    expect(getMachineDisplayName({ STILLON_MACHINE_NAME: "  Office Mac\n" })).toBe("Office Mac")
  })

  test("normalizes user-provided names before they are persisted", () => {
    expect(normalizeMachineName("  Studio\u0000 Mac\n")).toBe("Studio Mac")
    expect(normalizeMachineName("   ")).toBeNull()
    expect(normalizeMachineName(123)).toBeNull()
    expect(normalizeMachineName("x".repeat(MAX_MACHINE_NAME_LENGTH + 1))).toHaveLength(MAX_MACHINE_NAME_LENGTH)
  })
})
