import { createHash } from "node:crypto"
import { DEFAULT_QUICK_COMMANDS } from "../shared/quick-command-defaults"
import { normalizeQuickCommands } from "../shared/quick-commands"

// Complete shipped prompt fingerprints from 7770ad4 and 4578495. Match both
// the built-in ID and exact text so even a one-character user edit survives.
// Historical text lives in test-fixtures/legacy-workspace-presets.json, outside
// the client bundle. Workspace-specific copies remain user-owned.
const LEGACY_PROMPTS: Readonly<Record<string, readonly string[]>> = {
  "set-up-agent-workspace": [
    "76ace4e39050acaf90fba7c1775d977ef4337ed659589f1f36346b0ac5400a06",
    "3859c6d0c7c4d168015264321b2a271f3fd235281da77dae333348d766aad265",
  ],
  "continue-work": ["793d26f80577662610549247346046c59d38c54c488f9c767144f0399b97a23a"],
  "work-brief": ["2e9f2370c68249c756440ade388a24b594c4d4495fb6b3a5466373d437b860fb"],
  "prepare-handoff": ["5afc86b8522c616a1a48541ef64c545222d60662221399ebcb85216caf304199"],
  "organize-workspace": [
    "956c9110da2b7ebec48bfd9b8eb6d75bab79db46e69388dc188116d14a5218b4",
    "4eca30d72b80ed94f2686eee331f809c21e87fe07d0ec2004823beb8030a0591",
  ],
}

export function migrateQuickCommandDefaults(value: unknown) {
  const settings = normalizeQuickCommands(value)
  settings.global = settings.global.map(command => {
    const fingerprints = Object.hasOwn(LEGACY_PROMPTS, command.id) ? LEGACY_PROMPTS[command.id] : undefined
    if (!fingerprints?.includes(createHash("sha256").update(command.prompt).digest("hex"))) return command
    const current = DEFAULT_QUICK_COMMANDS.find(item => item.id === command.id)
    return current ? { ...command, prompt: current.prompt } : command
  })
  return settings
}
