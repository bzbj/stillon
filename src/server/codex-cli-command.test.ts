import { describe, expect, test } from "bun:test"
import { getCodexCliCommand } from "./codex-cli-command"

describe("getCodexCliCommand", () => {
  test("uses the Windows command shim", () => {
    expect(getCodexCliCommand("win32")).toBe("codex.cmd")
    expect(getCodexCliCommand("darwin")).toBe("codex")
    expect(getCodexCliCommand("linux")).toBe("codex")
  })
})
