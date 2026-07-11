import { create } from "zustand"
import {
  DEFAULT_CLAUDE_MODEL_OPTIONS,
  DEFAULT_CLAUDE_PERMISSION_MODE,
  DEFAULT_CODEX_MODEL_OPTIONS,
  DEFAULT_CODEX_PERMISSION_MODE,
  normalizeClaudeContextWindow,
  normalizeClaudeModelId,
  normalizeCodexModelId,
  normalizeClaudePermissionMode,
  normalizeCodexPermissionMode,
  isClaudeReasoningEffort,
  normalizeCodexReasoningEffort,
  supportsCodexFastMode,
  supportsClaudeMaxReasoningEffort,
  type AgentProvider,
  type ChatProviderPreferences,
  type ClaudeModelOptions,
  type ClaudePermissionMode,
  type CodexModelOptions,
  type CodexPermissionMode,
  type DefaultProviderPreference,
  type ProviderPreference,
  type ProviderModelOptionsByProvider,
} from "../../shared/types"

export type { ChatProviderPreferences, DefaultProviderPreference, ProviderPreference }

export type ComposerState =
  | {
    provider: "claude"
    model: string
    modelOptions: ClaudeModelOptions
    planMode: boolean
    permissionMode: ClaudePermissionMode
  }
  | {
    provider: "codex"
    model: string
    modelOptions: CodexModelOptions
    planMode: boolean
    permissionMode: CodexPermissionMode
  }

export const NEW_CHAT_COMPOSER_ID = "__new__"

type LegacyPersistedChatPreferencesState = Partial<{
  defaultProvider: string
  providerDefaults: {
    claude?: {
      model?: string
      effort?: string
      modelOptions?: Partial<ClaudeModelOptions>
      planMode?: boolean
      permissionMode?: unknown
    }
    codex?: {
      model?: string
      effort?: string
      modelOptions?: Partial<CodexModelOptions>
      planMode?: boolean
      permissionMode?: unknown
    }
  }
  composerState: PersistedComposerState
  liveProvider: AgentProvider
  livePreferences: {
    claude?: {
      model?: string
      effort?: string
      modelOptions?: Partial<ClaudeModelOptions>
      planMode?: boolean
      permissionMode?: unknown
    }
    codex?: {
      model?: string
      effort?: string
      modelOptions?: Partial<CodexModelOptions>
      planMode?: boolean
      permissionMode?: unknown
    }
  }
}>

type PersistedComposerState =
  | {
    provider: "claude"
    model?: string
    effort?: string
    modelOptions?: Partial<ClaudeModelOptions>
    planMode?: boolean
    permissionMode?: unknown
  }
  | {
    provider: "codex"
    model?: string
    effort?: string
    modelOptions?: Partial<CodexModelOptions>
    planMode?: boolean
    permissionMode?: unknown
  }

type PersistedChatPreferencesState = Pick<
  ChatPreferencesState,
  "defaultProvider" | "providerDefaults" | "chatStates" | "legacyComposerState"
> & LegacyPersistedChatPreferencesState

export function normalizeDefaultProvider(value?: string): DefaultProviderPreference {
  if (value === "claude" || value === "codex") return value
  return "last_used"
}

export function normalizeClaudePreference(value?: {
  model?: string
  effort?: string
  modelOptions?: Partial<ClaudeModelOptions>
  planMode?: boolean
  permissionMode?: unknown
}): ProviderPreference<ClaudeModelOptions, ClaudePermissionMode> {
  const reasoningEffort = value?.modelOptions?.reasoningEffort
  const normalizedEffort = isClaudeReasoningEffort(reasoningEffort)
    ? reasoningEffort
    : isClaudeReasoningEffort(value?.effort)
      ? value.effort
      : DEFAULT_CLAUDE_MODEL_OPTIONS.reasoningEffort
  const model = normalizeClaudeModelId(value?.model)
  const contextWindow = normalizeClaudeContextWindow(model, value?.modelOptions?.contextWindow)

  return {
    model,
    modelOptions: {
      reasoningEffort: !supportsClaudeMaxReasoningEffort(model) && normalizedEffort === "max" ? "high" : normalizedEffort,
      contextWindow,
    },
    planMode: Boolean(value?.planMode),
    permissionMode: normalizeClaudePermissionMode(value?.permissionMode),
  }
}

export function normalizeCodexPreference(value?: {
  model?: string
  effort?: string
  modelOptions?: Partial<CodexModelOptions>
  planMode?: boolean
  permissionMode?: unknown
}): ProviderPreference<CodexModelOptions, CodexPermissionMode> {
  const model = normalizeCodexModelId(value?.model)
  const reasoningEffort = value?.modelOptions?.reasoningEffort ?? value?.effort
  return {
    model,
    modelOptions: {
      reasoningEffort: normalizeCodexReasoningEffort(model, reasoningEffort),
      fastMode: supportsCodexFastMode(model) && typeof value?.modelOptions?.fastMode === "boolean"
        ? value.modelOptions.fastMode
        : supportsCodexFastMode(model) && DEFAULT_CODEX_MODEL_OPTIONS.fastMode,
    },
    planMode: Boolean(value?.planMode),
    permissionMode: normalizeCodexPermissionMode(value?.permissionMode),
  }
}

function forcePersistedCodexPreference<T extends {
  model?: string
  effort?: string
  modelOptions?: Partial<CodexModelOptions>
  planMode?: boolean
}>(value?: T): T | undefined {
  if (!value) return value
  return {
    ...value,
    model: "gpt-5.6-sol",
  }
}

function forcePersistedCodexComposerState<T extends PersistedComposerState | ComposerState>(value?: T): T | undefined {
  if (!value || value.provider !== "codex") return value
  return {
    ...value,
    model: "gpt-5.6-sol",
  }
}

function forcePersistedCodexChatStates(
  value?: Record<string, PersistedComposerState | ComposerState>
): Record<string, PersistedComposerState | ComposerState> | undefined {
  if (!value) return value

  return Object.fromEntries(
    Object.entries(value).map(([chatId, composerState]) => [
      chatId,
      forcePersistedCodexComposerState(composerState) ?? composerState,
    ])
  )
}

export function createDefaultProviderDefaults(): ChatProviderPreferences {
  return {
    claude: {
      model: "claude-opus-4-8",
      modelOptions: { ...DEFAULT_CLAUDE_MODEL_OPTIONS },
      planMode: false,
      permissionMode: DEFAULT_CLAUDE_PERMISSION_MODE,
    },
    codex: {
      model: "gpt-5.6-sol",
      modelOptions: { ...DEFAULT_CODEX_MODEL_OPTIONS },
      planMode: false,
      permissionMode: DEFAULT_CODEX_PERMISSION_MODE,
    },
  }
}

export function normalizeProviderDefaults(value?: {
  claude?: {
    model?: string
    effort?: string
    modelOptions?: Partial<ClaudeModelOptions>
    planMode?: boolean
    permissionMode?: unknown
  }
  codex?: {
    model?: string
    effort?: string
    modelOptions?: Partial<CodexModelOptions>
    planMode?: boolean
    permissionMode?: unknown
  }
}): ChatProviderPreferences {
  return {
    claude: normalizeClaudePreference(value?.claude),
    codex: normalizeCodexPreference(value?.codex),
  }
}

function logChatPreferences(message: string, details?: unknown) {
  if (details === undefined) {
    console.info(`[chat-preferences] ${message}`)
    return
  }

  console.info(`[chat-preferences] ${message}`, details)
}

function composerFromProviderDefaults(
  provider: AgentProvider,
  providerDefaults: ChatProviderPreferences
): ComposerState {
  if (provider === "claude") {
    const preference = providerDefaults.claude
    return {
      provider: "claude",
      model: preference.model,
      modelOptions: { ...preference.modelOptions },
      planMode: preference.planMode,
      permissionMode: preference.permissionMode ?? DEFAULT_CLAUDE_PERMISSION_MODE,
    }
  }

  const preference = providerDefaults.codex
  return {
    provider: "codex",
    model: preference.model,
    modelOptions: { ...preference.modelOptions },
    planMode: preference.planMode,
    permissionMode: preference.permissionMode ?? DEFAULT_CODEX_PERMISSION_MODE,
  }
}

function cloneComposerState(state: ComposerState): ComposerState {
  return state.provider === "claude"
    ? {
      provider: "claude",
      model: state.model,
      modelOptions: { ...state.modelOptions },
      planMode: state.planMode,
      permissionMode: normalizeClaudePermissionMode(state.permissionMode),
    }
    : {
      provider: "codex",
      model: state.model,
      modelOptions: { ...state.modelOptions },
      planMode: state.planMode,
      permissionMode: normalizeCodexPermissionMode(state.permissionMode),
    }
}

function sameComposerState(left: ComposerState | undefined, right: ComposerState): boolean {
  if (!left || left.provider !== right.provider) return false
  if (left.model !== right.model || left.planMode !== right.planMode || left.permissionMode !== right.permissionMode) return false

  if (left.provider === "claude" && right.provider === "claude") {
    return left.modelOptions.reasoningEffort === right.modelOptions.reasoningEffort
      && left.modelOptions.contextWindow === right.modelOptions.contextWindow
  }

  if (left.provider === "codex" && right.provider === "codex") {
    return left.modelOptions.reasoningEffort === right.modelOptions.reasoningEffort
      && left.modelOptions.fastMode === right.modelOptions.fastMode
  }

  return false
}

function normalizeComposerState(
  value: PersistedComposerState | undefined,
  providerDefaults: ChatProviderPreferences,
  legacyLiveProvider?: AgentProvider,
  legacyLivePreferences?: LegacyPersistedChatPreferencesState["livePreferences"]
): ComposerState {
  if (value?.provider === "claude") {
    const preference = normalizeClaudePreference(value)
    return {
      provider: "claude",
      model: preference.model,
      modelOptions: preference.modelOptions,
      planMode: preference.planMode,
      permissionMode: preference.permissionMode ?? DEFAULT_CLAUDE_PERMISSION_MODE,
    }
  }

  if (value?.provider === "codex") {
    const preference = normalizeCodexPreference(value)
    return {
      provider: "codex",
      model: preference.model,
      modelOptions: preference.modelOptions,
      planMode: preference.planMode,
      permissionMode: preference.permissionMode ?? DEFAULT_CODEX_PERMISSION_MODE,
    }
  }

  if (legacyLiveProvider === "claude") {
    const preference = normalizeClaudePreference(legacyLivePreferences?.claude)
    return {
      provider: "claude",
      model: preference.model,
      modelOptions: preference.modelOptions,
      planMode: preference.planMode,
      permissionMode: preference.permissionMode ?? DEFAULT_CLAUDE_PERMISSION_MODE,
    }
  }

  if (legacyLiveProvider === "codex") {
    const preference = normalizeCodexPreference(legacyLivePreferences?.codex)
    return {
      provider: "codex",
      model: preference.model,
      modelOptions: preference.modelOptions,
      planMode: preference.planMode,
      permissionMode: preference.permissionMode ?? DEFAULT_CODEX_PERMISSION_MODE,
    }
  }

  return composerFromProviderDefaults("claude", providerDefaults)
}

function normalizePersistedComposerState(
  value: PersistedComposerState | ComposerState | undefined,
  providerDefaults: ChatProviderPreferences
): ComposerState | null {
  if (!value) return null
  return normalizeComposerState(value, providerDefaults)
}

function normalizeChatStates(
  value: Record<string, PersistedComposerState | ComposerState> | undefined,
  providerDefaults: ChatProviderPreferences
): Record<string, ComposerState> {
  if (!value) return {}

  return Object.fromEntries(
    Object.entries(value).map(([chatId, composerState]) => [
      chatId,
      normalizeComposerState(composerState, providerDefaults),
    ])
  )
}

function createComposerStateForNewChat(args: {
  defaultProvider: DefaultProviderPreference
  providerDefaults: ChatProviderPreferences
  sourceState?: ComposerState | null
  legacyComposerState?: ComposerState | null
}): ComposerState {
  if (args.defaultProvider === "last_used") {
    if (args.sourceState) {
      return cloneComposerState(args.sourceState)
    }

    if (args.legacyComposerState) {
      return cloneComposerState(args.legacyComposerState)
    }

    return composerFromProviderDefaults("codex", args.providerDefaults)
  }

  return composerFromProviderDefaults(args.defaultProvider, args.providerDefaults)
}

function getStoredComposerState(
  state: Pick<ChatPreferencesState, "chatStates" | "defaultProvider" | "providerDefaults" | "legacyComposerState">,
  chatId: string
): ComposerState {
  const existingState = state.chatStates[chatId]
  if (existingState) {
    return existingState
  }

  return createComposerStateForNewChat({
    defaultProvider: state.defaultProvider,
    providerDefaults: state.providerDefaults,
    legacyComposerState: state.legacyComposerState,
  })
}

function withChatComposerState(
  state: Pick<ChatPreferencesState, "chatStates" | "defaultProvider" | "providerDefaults" | "legacyComposerState">,
  chatId: string,
  transform: (composerState: ComposerState) => ComposerState
) {
  const currentComposerState = getStoredComposerState(state, chatId)
  return {
    chatStates: {
      ...state.chatStates,
      [chatId]: transform(currentComposerState),
    },
  }
}

interface ChatPreferencesState {
  defaultProvider: DefaultProviderPreference
  providerDefaults: ChatProviderPreferences
  chatStates: Record<string, ComposerState>
  legacyComposerState: ComposerState | null
  setDefaultProvider: (provider: DefaultProviderPreference) => void
  syncProviderDefaults: (defaultProvider: DefaultProviderPreference, providerDefaults: ChatProviderPreferences) => void
  setProviderDefaultModel: (provider: AgentProvider, model: string) => void
  setProviderDefaultModelOptions: <TProvider extends AgentProvider>(
    provider: TProvider,
    modelOptions: Partial<ProviderModelOptionsByProvider[TProvider]>
  ) => void
  setProviderDefaultPlanMode: (provider: AgentProvider, planMode: boolean) => void
  setProviderDefaultPermissionMode: (provider: AgentProvider, permissionMode: ClaudePermissionMode | CodexPermissionMode) => void
  getComposerState: (chatId: string) => ComposerState
  initializeComposerForChat: (chatId: string, options?: { sourceState?: ComposerState | null }) => void
  setComposerState: (chatId: string, composerState: ComposerState) => void
  setChatComposerProvider: (chatId: string, provider: AgentProvider) => void
  setChatComposerModel: (chatId: string, model: string) => void
  setChatComposerModelOptions: (
    chatId: string,
    modelOptions: Partial<ClaudeModelOptions> | Partial<CodexModelOptions>
  ) => void
  setChatComposerPlanMode: (chatId: string, planMode: boolean) => void
  setChatComposerPermissionMode: (chatId: string, permissionMode: ClaudePermissionMode | CodexPermissionMode) => void
  resetChatComposerFromProvider: (chatId: string, provider: AgentProvider) => void
}

export function migrateChatPreferencesState(
  persistedState: Partial<PersistedChatPreferencesState> | undefined
): Pick<ChatPreferencesState, "defaultProvider" | "providerDefaults" | "chatStates" | "legacyComposerState"> {
  const providerDefaults = normalizeProviderDefaults({
    ...persistedState?.providerDefaults,
    codex: forcePersistedCodexPreference(persistedState?.providerDefaults?.codex),
  })
  const legacyComposerState = normalizePersistedComposerState(
    forcePersistedCodexComposerState(persistedState?.legacyComposerState ?? persistedState?.composerState),
    providerDefaults
  )
  const legacyLiveComposerState = persistedState?.liveProvider
    ? normalizeComposerState(
      undefined,
      providerDefaults,
      persistedState.liveProvider,
      {
        ...persistedState?.livePreferences,
        codex: forcePersistedCodexPreference(persistedState?.livePreferences?.codex),
      }
    )
    : null

  return {
    defaultProvider: normalizeDefaultProvider(persistedState?.defaultProvider),
    providerDefaults,
    chatStates: normalizeChatStates(forcePersistedCodexChatStates(persistedState?.chatStates), providerDefaults),
    legacyComposerState: legacyComposerState ?? legacyLiveComposerState,
  }
}

export const useChatPreferencesStore = create<ChatPreferencesState>()(
  (set, get) => ({
    defaultProvider: "last_used",
    providerDefaults: createDefaultProviderDefaults(),
    chatStates: {},
    legacyComposerState: null,
    setDefaultProvider: (defaultProvider) => set({ defaultProvider }),
    syncProviderDefaults: (defaultProvider, providerDefaults) =>
      set((state) => {
        const oldNewChatFallback = createComposerStateForNewChat({
          defaultProvider: state.defaultProvider,
          providerDefaults: state.providerDefaults,
          legacyComposerState: state.legacyComposerState,
        })
        const nextNewChatFallback = createComposerStateForNewChat({
          defaultProvider,
          providerDefaults,
          legacyComposerState: state.legacyComposerState,
        })
        const chatStates = Object.fromEntries(
          Object.entries(state.chatStates).map(([chatId, composerState]) => [
            chatId,
            sameComposerState(composerState, oldNewChatFallback) ? nextNewChatFallback : composerState,
          ])
        )

        return {
          defaultProvider,
          providerDefaults,
          chatStates,
        }
      }),
      setProviderDefaultModel: (provider, model) =>
        set((state) => ({
          providerDefaults: {
            ...state.providerDefaults,
            [provider]: provider === "claude"
              ? normalizeClaudePreference({
                ...state.providerDefaults.claude,
                model,
              })
              : normalizeCodexPreference({
                ...state.providerDefaults.codex,
                model,
              }),
          },
        })),
      setProviderDefaultModelOptions: (provider, modelOptions) =>
        set((state) => ({
          providerDefaults: {
            ...state.providerDefaults,
            [provider]: provider === "claude"
              ? normalizeClaudePreference({
                ...state.providerDefaults.claude,
                modelOptions: {
                  ...state.providerDefaults.claude.modelOptions,
                  ...modelOptions as Partial<ClaudeModelOptions>,
                },
              })
              : normalizeCodexPreference({
                ...state.providerDefaults.codex,
                modelOptions: {
                  ...state.providerDefaults.codex.modelOptions,
                  ...modelOptions as Partial<CodexModelOptions>,
                },
              }),
          },
        })),
      setProviderDefaultPlanMode: (provider, planMode) =>
        set((state) => ({
          providerDefaults: {
            ...state.providerDefaults,
            [provider]: {
              ...state.providerDefaults[provider],
              planMode,
            },
          },
        })),
      setProviderDefaultPermissionMode: (provider: AgentProvider, permissionMode: ClaudePermissionMode | CodexPermissionMode) =>
        set((state) => ({
          providerDefaults: {
            ...state.providerDefaults,
            [provider]: provider === "claude"
              ? {
                ...state.providerDefaults.claude,
                permissionMode: normalizeClaudePermissionMode(permissionMode),
              }
              : {
                ...state.providerDefaults.codex,
                permissionMode: normalizeCodexPermissionMode(permissionMode),
              },
          },
        })),
      getComposerState: (chatId) => cloneComposerState(getStoredComposerState(get(), chatId)),
      initializeComposerForChat: (chatId, options) =>
        set((state) => {
          if (state.chatStates[chatId]) {
            return state
          }

          const composerState = createComposerStateForNewChat({
            defaultProvider: state.defaultProvider,
            providerDefaults: state.providerDefaults,
            sourceState: options?.sourceState,
            legacyComposerState: state.legacyComposerState,
          })

          logChatPreferences("initializeComposerForChat", { chatId, composerState })

          return {
            chatStates: {
              ...state.chatStates,
              [chatId]: composerState,
            },
          }
        }),
      setComposerState: (chatId, composerState) =>
        set((state) => ({
          chatStates: {
            ...state.chatStates,
            [chatId]: composerState.provider === "claude"
              ? {
                provider: "claude",
                model: normalizeClaudePreference(composerState).model,
                modelOptions: normalizeClaudePreference(composerState).modelOptions,
                planMode: composerState.planMode,
                permissionMode: normalizeClaudePermissionMode(composerState.permissionMode),
              }
              : {
                provider: "codex",
                model: normalizeCodexPreference(composerState).model,
                modelOptions: normalizeCodexPreference(composerState).modelOptions,
                planMode: composerState.planMode,
                permissionMode: normalizeCodexPermissionMode(composerState.permissionMode),
              },
          },
        })),
      setChatComposerProvider: (chatId, provider) =>
        set((state) => withChatComposerState(state, chatId, () => composerFromProviderDefaults(provider, state.providerDefaults))),
      setChatComposerModel: (chatId, model) =>
        set((state) => withChatComposerState(state, chatId, (composerState) => (
          composerState.provider === "claude"
            ? {
              provider: "claude",
              model: normalizeClaudePreference({
                ...composerState,
                model,
              }).model,
              modelOptions: normalizeClaudePreference({
                ...composerState,
                model,
              }).modelOptions,
              planMode: composerState.planMode,
              permissionMode: composerState.permissionMode,
            }
            : {
              provider: "codex",
              model,
              modelOptions: normalizeCodexPreference({
                ...composerState,
                model,
              }).modelOptions,
              planMode: composerState.planMode,
              permissionMode: composerState.permissionMode,
            }
        ))),
      setChatComposerModelOptions: (chatId, modelOptions) =>
        set((state) => withChatComposerState(state, chatId, (composerState) => (
          composerState.provider === "claude"
            ? {
              provider: "claude",
              model: composerState.model,
              modelOptions: normalizeClaudePreference({
                ...composerState,
                modelOptions: {
                  ...composerState.modelOptions,
                  ...modelOptions as Partial<ClaudeModelOptions>,
                },
              }).modelOptions,
              planMode: composerState.planMode,
              permissionMode: composerState.permissionMode,
            }
            : {
              provider: "codex",
              model: composerState.model,
              modelOptions: normalizeCodexPreference({
                ...composerState,
                modelOptions: {
                  ...composerState.modelOptions,
                  ...modelOptions as Partial<CodexModelOptions>,
                },
              }).modelOptions,
              planMode: composerState.planMode,
              permissionMode: composerState.permissionMode,
            }
        ))),
      setChatComposerPlanMode: (chatId, planMode) =>
        set((state) => withChatComposerState(state, chatId, (composerState) => ({
          ...composerState,
          planMode,
        }))),
      setChatComposerPermissionMode: (chatId, permissionMode) =>
        set((state) => withChatComposerState(state, chatId, (composerState) => (
          composerState.provider === "claude"
            ? {
              ...composerState,
              permissionMode: normalizeClaudePermissionMode(permissionMode),
            }
            : {
              ...composerState,
              permissionMode: normalizeCodexPermissionMode(permissionMode),
            }
        ))),
      resetChatComposerFromProvider: (chatId, provider) =>
        set((state) => ({
          chatStates: {
            ...state.chatStates,
            [chatId]: composerFromProviderDefaults(provider, state.providerDefaults),
          },
        })),
  })
)
