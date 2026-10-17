import { describe, expect, test } from "bun:test"
import { defaultQuickCommands, mergeQuickCommands, normalizeQuickCommands } from "./quick-commands"

const local = { id: "custom", name: "Client Update", prompt: "Summarize the client work." }

describe("quick command configuration", () => {
  test("preserves explicit deletions, reordering and edits instead of restoring defaults", () => {
    const defaults = defaultQuickCommands()
    expect(normalizeQuickCommands({ global: [], workspaces: {} }).global).toEqual([])
    const edited = [{ ...defaults.global[2]!, name: "My Brief", prompt: "My instructions" }, defaults.global[0]!]
    expect(normalizeQuickCommands({ global: edited }).global).toEqual(edited)
    defaults.global[0]!.prompt = "Changed"
    expect(defaultQuickCommands().global[0]!.prompt).not.toBe("Changed")
  })

  test("patches one stable workspace ID without changing other scopes", () => {
    const settings = mergeQuickCommands(undefined, { workspaces: { "stable-id": [local], other: [{ ...local, id: "other" }] } })
    const next = mergeQuickCommands(settings, { global: [] })
    expect(next.workspaces).toEqual(settings.workspaces)
    expect(mergeQuickCommands(next, { workspaces: { "stable-id": null } }).workspaces).toEqual({ other: settings.workspaces.other! })
    expect(() => mergeQuickCommands(next, { global: [{ ...local, prompt: "" }] })).toThrow("prompt")
  })
})
