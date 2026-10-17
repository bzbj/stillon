import { DEFAULT_QUICK_COMMANDS } from "./quick-command-defaults"

export interface QuickCommand {
  id: string
  name: string
  prompt: string
  description?: string
}

export interface QuickCommandsSettings {
  global: QuickCommand[]
  workspaces: Record<string, QuickCommand[]>
}

/** Each scope is patched separately so editing one workspace keeps the others. */
export interface QuickCommandsPatch {
  global?: QuickCommand[]
  workspaces?: Record<string, QuickCommand[] | null>
}

export function defaultQuickCommands(): QuickCommandsSettings {
  return { global: DEFAULT_QUICK_COMMANDS.map(command => ({ ...command })), workspaces: {} }
}

export function validateQuickCommands(commands: unknown): asserts commands is QuickCommand[] {
  if (!Array.isArray(commands) || commands.length > 100) throw new Error("Use up to 100 commands per list.")
  const ids = new Set<string>()
  for (const command of commands) {
    if (!command || typeof command.id !== "string" || !command.id.trim() || command.id.length > 128 || ids.has(command.id)) throw new Error("Command IDs must be unique.")
    if (typeof command.name !== "string" || !command.name.trim() || command.name.length > 100) throw new Error("Enter a command name of up to 100 characters.")
    if (typeof command.prompt !== "string" || !command.prompt.trim() || command.prompt.length > 50_000) throw new Error("Enter a prompt of up to 50,000 characters.")
    if (command.description !== undefined && (typeof command.description !== "string" || command.description.length > 300)) throw new Error("Command descriptions must be at most 300 characters.")
    ids.add(command.id)
  }
}

export function normalizeQuickCommands(value: unknown): QuickCommandsSettings {
  const source = value && typeof value === "object" ? value as Partial<QuickCommandsSettings> : {}
  const clean = (items: unknown, fallback: QuickCommand[]) => {
    try {
      validateQuickCommands(items)
      return items.map(({ id, name, prompt, description }) => ({ id, name: name.trim(), prompt, ...(description ? { description } : {}) }))
    } catch { return fallback }
  }
  return {
    global: clean(source.global, defaultQuickCommands().global),
    workspaces: Object.fromEntries(Object.entries(source.workspaces && typeof source.workspaces === "object" ? source.workspaces : {})
      .map(([id, items]) => [id, clean(items, [])])),
  }
}

export function mergeQuickCommands(current: QuickCommandsSettings | undefined, patch?: QuickCommandsPatch): QuickCommandsSettings {
  const settings = normalizeQuickCommands(current)
  if (!patch) return settings
  if (patch.global !== undefined) validateQuickCommands(patch.global)
  const workspaces = { ...settings.workspaces }
  for (const [id, commands] of Object.entries(patch.workspaces ?? {})) {
    if (commands === null) delete workspaces[id]
    else { validateQuickCommands(commands); Object.defineProperty(workspaces, id, { value: commands, enumerable: true, writable: true, configurable: true }) }
  }
  return normalizeQuickCommands({ global: patch.global ?? settings.global, workspaces })
}
