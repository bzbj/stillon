import { watch, type FSWatcher } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { getSettingsFilePath, LOG_PREFIX } from "../shared/branding"
import { normalizeMachineName } from "./machine-name"
import { applyAgentNetworkPatch, normalizeAgentNetworkSettings } from "./agent-network"
import {
  DEFAULT_CLAUDE_MODEL_OPTIONS,
  DEFAULT_CLAUDE_PERMISSION_MODE,
  DEFAULT_CODEX_MODEL_OPTIONS,
  DEFAULT_CODEX_PERMISSION_MODE,
  isClaudeReasoningEffort,
  normalizeCodexReasoningEffort,
  normalizeClaudePermissionMode,
  normalizeCodexPermissionMode,
  normalizeClaudeContextWindow,
  normalizeClaudeModelId,
  normalizeCodexModelId,
  supportsCodexFastMode,
  supportsClaudeMaxReasoningEffort,
  type AppSettingsPatch,
  type AppSettingsSnapshot,
  type AppThemePreference,
  type ChatProviderPreferences,
  type ChatSoundId,
  type ChatSoundPreference,
  type ClaudeModelOptions,
  type ClaudePermissionMode,
  type CodexModelOptions,
  type CodexPermissionMode,
  type DefaultProviderPreference,
  type EditorPreset,
  type ProviderPreference,
} from "../shared/types"

interface AppSettingsFile {
  browserSettingsMigrated?: unknown
  machineName?: unknown
  theme?: unknown
  chatSoundPreference?: unknown
  chatSoundId?: unknown
  terminal?: {
    scrollbackLines?: unknown
    minColumnWidth?: unknown
  }
  editor?: {
    preset?: unknown
    commandTemplate?: unknown
  }
  defaultProvider?: unknown
  providerDefaults?: {
    claude?: Partial<ProviderPreference<Partial<ClaudeModelOptions>>> & { effort?: unknown }
    codex?: Partial<ProviderPreference<Partial<CodexModelOptions>>> & { effort?: unknown }
  }
  network?: unknown
}

type AppSettingsState = AppSettingsSnapshot

interface NormalizedAppSettings {
  payload: AppSettingsState
  warning: string | null
  shouldWrite: boolean
}

export interface AppSettingsManagerOptions {
  /** The system-provided label used until the user saves a custom local name. */
  defaultMachineName?: string
}

const DEFAULT_TERMINAL_SCROLLBACK = 1_000
const MIN_TERMINAL_SCROLLBACK = 500
const MAX_TERMINAL_SCROLLBACK = 5_000
const DEFAULT_TERMINAL_MIN_COLUMN_WIDTH = 450
const MIN_TERMINAL_MIN_COLUMN_WIDTH = 250
const MAX_TERMINAL_MIN_COLUMN_WIDTH = 900
const DEFAULT_EDITOR_PRESET: EditorPreset = "cursor"
const DEFAULT_CHAT_SOUND_PREFERENCE: ChatSoundPreference = "always"
const DEFAULT_CHAT_SOUND_ID: ChatSoundId = "funk"

function formatDisplayPath(filePath: string) {
  const homePath = homedir()
  if (filePath === homePath) return "~"
  if (filePath.startsWith(`${homePath}${path.sep}`)) {
    return `~${filePath.slice(homePath.length)}`
  }
  return filePath
}

function getDefaultEditorCommandTemplate(preset: EditorPreset) {
  switch (preset) {
    case "vscode":
      return "code {path}"
    case "xcode":
      return "xed {path}"
    case "windsurf":
      return "windsurf {path}"
    case "custom":
    case "cursor":
    default:
      return "cursor {path}"
  }
}

function createDefaultProviderDefaults(): ChatProviderPreferences {
  return {
    claude: {
      model: "claude-opus-4-8",
      modelOptions: { ...DEFAULT_CLAUDE_MODEL_OPTIONS },
      permissionMode: DEFAULT_CLAUDE_PERMISSION_MODE,
    },
    codex: {
      model: "gpt-5.6-sol",
      modelOptions: { ...DEFAULT_CODEX_MODEL_OPTIONS },
      permissionMode: DEFAULT_CODEX_PERMISSION_MODE,
    },
  }
}

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  const numberValue = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(numberValue)) return fallback
  return Math.min(max, Math.max(min, Math.round(numberValue)))
}

function normalizeTheme(value: unknown): AppThemePreference {
  return value === "light" || value === "dark" || value === "system" ? value : "system"
}

function normalizeChatSoundPreference(value: unknown): ChatSoundPreference {
  return value === "never" || value === "unfocused" || value === "always" ? value : DEFAULT_CHAT_SOUND_PREFERENCE
}

function normalizeChatSoundId(value: unknown): ChatSoundId {
  switch (value) {
    case "blow":
    case "bottle":
    case "frog":
    case "funk":
    case "glass":
    case "ping":
    case "pop":
    case "purr":
    case "tink":
      return value
    default:
      return DEFAULT_CHAT_SOUND_ID
  }
}

function normalizeDefaultProvider(value: unknown): DefaultProviderPreference {
  return value === "claude" || value === "codex" || value === "last_used" ? value : "last_used"
}

function normalizeEditorPreset(value: unknown): EditorPreset {
  return value === "vscode" || value === "xcode" || value === "windsurf" || value === "custom" || value === "cursor"
    ? value
    : DEFAULT_EDITOR_PRESET
}

function normalizeEditorCommandTemplate(value: unknown, preset: EditorPreset) {
  const trimmed = typeof value === "string" ? value.trim() : ""
  return trimmed || getDefaultEditorCommandTemplate(preset)
}

function normalizeClaudePreference(value?: {
  model?: unknown
  effort?: unknown
  modelOptions?: Partial<Record<keyof ClaudeModelOptions, unknown>>
  permissionMode?: unknown
}): ProviderPreference<ClaudeModelOptions, ClaudePermissionMode> {
  const model = normalizeClaudeModelId(typeof value?.model === "string" ? value.model : undefined)
  const reasoningEffort = value?.modelOptions?.reasoningEffort
  const normalizedEffort = isClaudeReasoningEffort(reasoningEffort)
    ? reasoningEffort
    : isClaudeReasoningEffort(value?.effort)
      ? value.effort
      : DEFAULT_CLAUDE_MODEL_OPTIONS.reasoningEffort

  return {
    model,
    modelOptions: {
      reasoningEffort: !supportsClaudeMaxReasoningEffort(model) && normalizedEffort === "max" ? "high" : normalizedEffort,
      contextWindow: normalizeClaudeContextWindow(model, value?.modelOptions?.contextWindow),
    },
    permissionMode: normalizeClaudePermissionMode(value?.permissionMode),
  }
}

function normalizeCodexPreference(value?: {
  model?: unknown
  effort?: unknown
  modelOptions?: Partial<Record<keyof CodexModelOptions, unknown>>
  permissionMode?: unknown
}): ProviderPreference<CodexModelOptions, CodexPermissionMode> {
  const model = normalizeCodexModelId(typeof value?.model === "string" ? value.model : undefined)
  const reasoningEffort = value?.modelOptions?.reasoningEffort ?? value?.effort
  return {
    model,
    modelOptions: {
      reasoningEffort: normalizeCodexReasoningEffort(model, reasoningEffort),
      fastMode: supportsCodexFastMode(model) && typeof value?.modelOptions?.fastMode === "boolean"
        ? value.modelOptions.fastMode
        : supportsCodexFastMode(model) && DEFAULT_CODEX_MODEL_OPTIONS.fastMode,
    },
    permissionMode: normalizeCodexPermissionMode(value?.permissionMode),
  }
}

function normalizeProviderDefaults(value: AppSettingsFile["providerDefaults"] | undefined): ChatProviderPreferences {
  const defaults = createDefaultProviderDefaults()
  return {
    claude: normalizeClaudePreference(value?.claude ?? defaults.claude),
    codex: normalizeCodexPreference(value?.codex ?? defaults.codex),
  }
}

function toFilePayload(state: AppSettingsState) {
  return {
    browserSettingsMigrated: state.browserSettingsMigrated,
    machineName: state.machineName,
    theme: state.theme,
    chatSoundPreference: state.chatSoundPreference,
    chatSoundId: state.chatSoundId,
    terminal: state.terminal,
    editor: state.editor,
    defaultProvider: state.defaultProvider,
    providerDefaults: state.providerDefaults,
    network: state.network,
  }
}

function toSnapshot(state: AppSettingsState): AppSettingsSnapshot {
  return {
    browserSettingsMigrated: state.browserSettingsMigrated,
    machineName: state.machineName,
    theme: state.theme,
    chatSoundPreference: state.chatSoundPreference,
    chatSoundId: state.chatSoundId,
    terminal: state.terminal,
    editor: state.editor,
    defaultProvider: state.defaultProvider,
    providerDefaults: state.providerDefaults,
    network: state.network,
    warning: state.warning,
    filePathDisplay: state.filePathDisplay,
  }
}

function normalizeAppSettings(
  value: unknown,
  filePath = getSettingsFilePath(homedir()),
  defaultMachineName = "This Machine",
): NormalizedAppSettings {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as AppSettingsFile
    : null
  const warnings: string[] = []

  if (value !== undefined && value !== null && !source) {
    warnings.push("Settings file must contain a JSON object")
  }

  const hasLegacyAnalyticsSettings = Boolean(
    source && ("analyticsEnabled" in source || "analyticsUserId" in source)
  )

  const editorPreset = normalizeEditorPreset(source?.editor?.preset)
  const machineName = normalizeMachineName(source?.machineName)
    ?? normalizeMachineName(defaultMachineName)
    ?? "This Machine"
  const normalizedNetwork = normalizeAgentNetworkSettings(source?.network)
  warnings.push(...normalizedNetwork.warnings)
  const state: AppSettingsState = {
    browserSettingsMigrated: source?.browserSettingsMigrated === true,
    machineName,
    theme: normalizeTheme(source?.theme),
    chatSoundPreference: normalizeChatSoundPreference(source?.chatSoundPreference),
    chatSoundId: normalizeChatSoundId(source?.chatSoundId),
    terminal: {
      scrollbackLines: clampNumber(source?.terminal?.scrollbackLines, DEFAULT_TERMINAL_SCROLLBACK, MIN_TERMINAL_SCROLLBACK, MAX_TERMINAL_SCROLLBACK),
      minColumnWidth: clampNumber(source?.terminal?.minColumnWidth, DEFAULT_TERMINAL_MIN_COLUMN_WIDTH, MIN_TERMINAL_MIN_COLUMN_WIDTH, MAX_TERMINAL_MIN_COLUMN_WIDTH),
    },
    editor: {
      preset: editorPreset,
      commandTemplate: normalizeEditorCommandTemplate(source?.editor?.commandTemplate, editorPreset),
    },
    defaultProvider: normalizeDefaultProvider(source?.defaultProvider),
    providerDefaults: normalizeProviderDefaults(source?.providerDefaults),
    network: normalizedNetwork.settings,
    warning: null,
    filePathDisplay: formatDisplayPath(filePath),
  }

  const shouldWrite = hasLegacyAnalyticsSettings
    || JSON.stringify(source ? toComparablePayload(source) : null) !== JSON.stringify(toFilePayload(state))
  state.warning = warnings.length > 0
    ? `Some settings were reset to defaults: ${warnings.join("; ")}`
    : null

  return {
    payload: state,
    warning: state.warning,
    shouldWrite,
  }
}

function toComparablePayload(source: AppSettingsFile) {
  return {
    browserSettingsMigrated: source.browserSettingsMigrated,
    machineName: source.machineName,
    theme: source.theme,
    chatSoundPreference: source.chatSoundPreference,
    chatSoundId: source.chatSoundId,
    terminal: source.terminal,
    editor: source.editor,
    defaultProvider: source.defaultProvider,
    providerDefaults: source.providerDefaults,
    network: source.network,
  }
}

function applyPatch(
  state: AppSettingsState,
  patch: AppSettingsPatch,
  defaultMachineName: string,
): AppSettingsState {
  const network = patch.network
    ? applyAgentNetworkPatch(state.network, patch.network)
    : state.network
  return normalizeAppSettings({
    ...toFilePayload(state),
    ...patch,
    terminal: {
      ...state.terminal,
      ...patch.terminal,
    },
    editor: {
      ...state.editor,
      ...patch.editor,
    },
    providerDefaults: {
      claude: {
        ...state.providerDefaults.claude,
        ...patch.providerDefaults?.claude,
        modelOptions: {
          ...state.providerDefaults.claude.modelOptions,
          ...patch.providerDefaults?.claude?.modelOptions,
        },
      },
      codex: {
        ...state.providerDefaults.codex,
        ...patch.providerDefaults?.codex,
        modelOptions: {
          ...state.providerDefaults.codex.modelOptions,
          ...patch.providerDefaults?.codex?.modelOptions,
        },
      },
    },
    network,
  }, state.filePathDisplay, defaultMachineName).payload
}

export async function readAppSettingsSnapshot(filePath = getSettingsFilePath(homedir())) {
  try {
    const text = await readFile(filePath, "utf8")
    if (!text.trim()) {
      const normalized = normalizeAppSettings(undefined, filePath)
      return {
        ...toSnapshot(normalized.payload),
        warning: "Settings file was empty. Using defaults.",
      } satisfies AppSettingsSnapshot
    }

    return toSnapshot(normalizeAppSettings(JSON.parse(text), filePath).payload)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return toSnapshot(normalizeAppSettings(undefined, filePath).payload)
    }
    if (error instanceof SyntaxError) {
      return {
        ...toSnapshot(normalizeAppSettings(undefined, filePath).payload),
        warning: "Settings file is invalid JSON. Using defaults.",
      } satisfies AppSettingsSnapshot
    }
    throw error
  }
}

export class AppSettingsManager {
  readonly filePath: string
  private readonly defaultMachineName: string
  private watcher: FSWatcher | null = null
  private state: AppSettingsState
  private readonly listeners = new Set<(snapshot: AppSettingsSnapshot) => void>()

  constructor(filePath = getSettingsFilePath(homedir()), options: AppSettingsManagerOptions = {}) {
    this.filePath = filePath
    this.defaultMachineName = normalizeMachineName(options.defaultMachineName) ?? "This Machine"
    this.state = normalizeAppSettings(undefined, filePath, this.defaultMachineName).payload
  }

  async initialize() {
    await mkdir(path.dirname(this.filePath), { recursive: true })
    await this.reload({ persistNormalized: true })
    this.startWatching()
  }

  dispose() {
    this.watcher?.close()
    this.watcher = null
    this.listeners.clear()
  }

  getSnapshot() {
    return toSnapshot(this.state)
  }

  onChange(listener: (snapshot: AppSettingsSnapshot) => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async reload(options?: { persistNormalized?: boolean }) {
    const nextState = await this.readState(options)
    this.setState(nextState)
  }

  async writePatch(patch: AppSettingsPatch) {
    const nextState = {
      ...applyPatch(this.state, patch, this.defaultMachineName),
      warning: null,
      filePathDisplay: formatDisplayPath(this.filePath),
    }
    await mkdir(path.dirname(this.filePath), { recursive: true })
    await writeFile(this.filePath, `${JSON.stringify(toFilePayload(nextState), null, 2)}\n`, "utf8")
    this.setState(nextState)
    return toSnapshot(nextState)
  }

  private async readState(options?: { persistNormalized?: boolean }) {
    const file = Bun.file(this.filePath)

    try {
      const text = await file.text()
      const hasText = text.trim().length > 0
      const normalized = normalizeAppSettings(hasText ? JSON.parse(text) : undefined, this.filePath, this.defaultMachineName)
      if (options?.persistNormalized && (!hasText || normalized.shouldWrite)) {
        await writeFile(this.filePath, `${JSON.stringify(toFilePayload(normalized.payload), null, 2)}\n`, "utf8")
      }
      return {
        ...normalized.payload,
        warning: !hasText ? "Settings file was empty. Using defaults." : normalized.warning,
      } satisfies AppSettingsState
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT" && !(error instanceof SyntaxError)) {
        throw error
      }

      const normalized = normalizeAppSettings(undefined, this.filePath, this.defaultMachineName)
      if (options?.persistNormalized) {
        await writeFile(this.filePath, `${JSON.stringify(toFilePayload(normalized.payload), null, 2)}\n`, "utf8")
      }
      return {
        ...normalized.payload,
        warning: error instanceof SyntaxError ? "Settings file is invalid JSON. Using defaults." : null,
      } satisfies AppSettingsState
    }
  }

  private setState(state: AppSettingsState) {
    this.state = state
    const snapshot = toSnapshot(state)
    for (const listener of this.listeners) {
      listener(snapshot)
    }
  }

  private startWatching() {
    this.watcher?.close()
    try {
      this.watcher = watch(path.dirname(this.filePath), { persistent: false }, (_eventType, filename) => {
        if (filename && filename !== path.basename(this.filePath)) {
          return
        }
        void this.reload().catch((error: unknown) => {
          console.warn(`${LOG_PREFIX} Failed to reload settings:`, error)
        })
      })
    } catch (error) {
      console.warn(`${LOG_PREFIX} Failed to watch settings file:`, error)
      this.watcher = null
    }
  }
}
