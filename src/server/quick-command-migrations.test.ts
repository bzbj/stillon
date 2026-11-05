import { describe, expect, test } from "bun:test"
import { defaultQuickCommands } from "../shared/quick-commands"
import legacyPrompts from "./test-fixtures/legacy-workspace-presets.json"
import { migrateQuickCommandDefaults } from "./quick-command-migrations"

const defaults = defaultQuickCommands().global

describe("workspace entry preset migration", () => {
  for (const legacy of legacyPrompts) {
    test(`updates shipped ${legacy.id} from ${legacy.revision} without changing labels or workspace copies`, () => {
      const saved = { ...defaults.find(item => item.id === legacy.id)!, prompt: legacy.prompt, name: "My label", description: "My description" }
      const input = { global: [saved], workspaces: { workspace: [saved] } }
      const migrated = migrateQuickCommandDefaults(input)
      expect(migrated.global).toEqual([{ ...saved, prompt: defaults.find(item => item.id === legacy.id)!.prompt }])
      expect(migrated.workspaces.workspace).toEqual([saved])
      expect(input.global[0]!.prompt).toBe(legacy.prompt)
      expect(migrateQuickCommandDefaults(migrated)).toEqual(migrated)
    })
  }

  test("preserves every edited prompt, including single-character changes", () => {
    for (const legacy of legacyPrompts) {
      for (const prompt of [legacy.prompt + " ", legacy.prompt.replace(/work/i, "WORK"), "Only use Agent.md."]) {
        const saved = { ...defaults.find(item => item.id === legacy.id)!, prompt }
        expect(migrateQuickCommandDefaults({ global: [saved] }).global).toEqual([saved])
      }
    }
  })

  test("keeps custom IDs, deletions and reordered lists", () => {
    const original = legacyPrompts[0]!
    const commands = [
      { id: "__proto__", name: "Custom", prompt: original.prompt },
      { id: "custom", name: "Custom copy", prompt: original.prompt },
      { ...defaults[4]!, prompt: "My organization rules" },
      { ...defaults[0]!, prompt: original.prompt },
    ]
    const migrated = migrateQuickCommandDefaults({ global: commands })
    expect(migrated.global.slice(0, 3)).toEqual(commands.slice(0, 3))
    expect(migrated.global.map(item => item.id)).toEqual(commands.map(item => item.id))
    expect(migrated.global[3]).toEqual(defaults[0])
    expect(migrateQuickCommandDefaults({ global: [] }).global).toEqual([])
    expect(migrateQuickCommandDefaults(undefined)).toEqual(defaultQuickCommands())
  })
})
