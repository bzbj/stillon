import { describe, expect, test } from "bun:test"
import { getMachineDisplayName } from "./machine-name"

describe("machine display name", () => {
  test("uses a sanitized public display-name override", () => {
    expect(getMachineDisplayName({ STILLON_MACHINE_NAME: "  Office Mac\n" })).toBe("Office Mac")
  })
})
