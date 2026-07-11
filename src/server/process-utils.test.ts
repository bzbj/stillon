import { describe, expect, test } from "bun:test"
import process from "node:process"
import { hasCommand, spawnDetached } from "./process-utils"

describe("spawnDetached", () => {
  test("rejects when the command does not exist", async () => {
    await expect(spawnDetached("definitely-not-a-real-command-stillon", [])).rejects.toThrow("Command not found")
  })

  test("resolves when the process starts successfully", async () => {
    await expect(spawnDetached(process.execPath, ["--eval", "process.exit(0)"])).resolves.toBeUndefined()
  })
})

describe("hasCommand", () => {
  test("checks executable paths without invoking a shell", () => {
    expect(hasCommand(process.execPath)).toBe(true)
    expect(hasCommand("definitely-not-a-stillon-command")).toBe(false)
    expect(hasCommand("missing; touch /tmp/stillon-should-not-exist")).toBe(false)
  })
})
