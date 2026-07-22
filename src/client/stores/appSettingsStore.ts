import { create } from "zustand"
import {
  normalizeClaudePermissionMode,
  normalizeCodexPermissionMode,
  type AppSettingsPatch,
  type AppSettingsSnapshot,
} from "../../shared/types"

type AppSettingsHydrationStatus = "idle" | "loading" | "ready" | "error"

interface AppSettingsStoreState {
  settings: AppSettingsSnapshot | null
  hydrationStatus: AppSettingsHydrationStatus
  setHydrationStatus: (status: AppSettingsHydrationStatus) => void
  setFromServer: (settings: AppSettingsSnapshot) => void
  applyOptimisticPatch: (patch: AppSettingsPatch) => void
}

export function mergeAppSettingsPatch(
  settings: AppSettingsSnapshot,
  patch: AppSettingsPatch
): AppSettingsSnapshot {
  return {
    ...settings,
    ...patch,
    terminal: {
      ...settings.terminal,
      ...patch.terminal,
    },
    editor: {
      ...settings.editor,
      ...patch.editor,
    },
    network: {
      ...settings.network,
      ...patch.network,
    },
    providerDefaults: {
      claude: {
        ...settings.providerDefaults.claude,
        ...patch.providerDefaults?.claude,
        permissionMode: normalizeClaudePermissionMode(
          patch.providerDefaults?.claude?.permissionMode ?? settings.providerDefaults.claude.permissionMode
        ),
        modelOptions: {
          ...settings.providerDefaults.claude.modelOptions,
          ...patch.providerDefaults?.claude?.modelOptions,
        },
      },
      codex: {
        ...settings.providerDefaults.codex,
        ...patch.providerDefaults?.codex,
        permissionMode: normalizeCodexPermissionMode(
          patch.providerDefaults?.codex?.permissionMode ?? settings.providerDefaults.codex.permissionMode
        ),
        modelOptions: {
          ...settings.providerDefaults.codex.modelOptions,
          ...patch.providerDefaults?.codex?.modelOptions,
        },
      },
    },
  }
}

export const useAppSettingsStore = create<AppSettingsStoreState>()((set) => ({
  settings: null,
  hydrationStatus: "idle",
  setHydrationStatus: (hydrationStatus) => set({ hydrationStatus }),
  setFromServer: (settings) => set({ settings, hydrationStatus: "ready" }),
  applyOptimisticPatch: (patch) =>
    set((state) => ({
      settings: state.settings ? mergeAppSettingsPatch(state.settings, patch) : state.settings,
    })),
}))
