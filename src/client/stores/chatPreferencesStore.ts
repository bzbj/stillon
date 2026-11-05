import { isAddonProvider, normalizeAddonPreference } from "../../shared/types"
import { create } from "zustand"
import {
  normalizeDeepSeekPreference,
  type DeepSeekModelOptions,
  DEFAULT_CLAUDE_MODEL_OPTIONS,
  DEFAULT_CLAUDE_PERMISSION_MODE,
  DEFAULT_CODEX_MODEL_OPTIONS,
  DEFAULT_CODEX_PERMISSION_MODE,
  getCodexModelForRole,
  normalizeClaudeContextWindow,
  normalizeClaudeModelId,
  normalizeCodexPreference as normalizeSharedCodexPreference,
  normalizeClaudePermissionMode,
  normalizeCodexPermissionMode,
  isClaudeReasoningEffort,
  supportsClaudeMaxReasoningEffort,
  type AgentProvider,
  type ChatProviderPreferences,
  type ChatTurnPreferences,
  type ClaudeModelOptions,
  type ClaudePermissionMode,
  type CodexModelOptions,
  type CodexPermissionMode,
  type DefaultProviderPreference,
  type ProviderPreference,
  type ProviderModelOptionsByProvider,
} from "../../shared/types"

export type { ChatProviderPreferences, DefaultProviderPreference, ProviderPreference }

export type ComposerState = ChatTurnPreferences

export const NEW_CHAT_COMPOSER_ID = "__new__"

// planMode is intentionally present only in these persisted input shapes so
// older browser state can be read and discarded during migration.
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
  | { provider: "deepseek" | "codebuddy"; model?: string; modelOptions?: Partial<DeepSeekModelOptions>; permissionMode?: unknown }
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
  if (isAddonProvider(value) || value === "claude" || value === "codex") return value
  return "last_used"
}

export function normalizeClaudePreference(value?: {
  model?: string
  effort?: string
  modelOptions?: Partial<ClaudeModelOptions>
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
    permissionMode: normalizeClaudePermissionMode(value?.permissionMode),
  }
}

export const normalizeCodexPreference = normalizeSharedCodexPreference

export function createDefaultProviderDefaults(): ChatProviderPreferences {
  return {
    deepseek: normalizeDeepSeekPreference(),
    claude: {
      model: "claude-opus-4-8",
      modelOptions: { ...DEFAULT_CLAUDE_MODEL_OPTIONS },
      permissionMode: DEFAULT_CLAUDE_PERMISSION_MODE,
    },
    codex: {
      model: getCodexModelForRole("conversation"),
      modelOptions: { ...DEFAULT_CODEX_MODEL_OPTIONS },
      permissionMode: DEFAULT_CODEX_PERMISSION_MODE,
    },
  }
}

export function normalizeProviderDefaults(value?: {
  deepseek?: { model?: string; modelOptions?: Partial<DeepSeekModelOptions>; permissionMode?: unknown }
  codebuddy?: { model?: string; modelOptions?: Partial<DeepSeekModelOptions>; permissionMode?: unknown }
  claude?: {
    model?: string
    effort?: string
    modelOptions?: Partial<ClaudeModelOptions>
    permissionMode?: unknown
  }
  codex?: {
    model?: string
    effort?: string
    modelOptions?: Partial<CodexModelOptions>
    permissionMode?: unknown
  }
}): ChatProviderPreferences {
  return {
    claude: normalizeClaudePreference(value?.claude),
    codex: normalizeCodexPreference(value?.codex),
    deepseek: normalizeDeepSeekPreference(value?.deepseek),
    ...(value?.codebuddy ? { codebuddy: normalizeAddonPreference("codebuddy", value.codebuddy) } : {}),
  }
}

function logChatPreferences(message: string, details?: unknown) {
  if (details === undefined) {
    console.info(`[chat-preferences] ${message}`)
    return
  }

  console.info(`[chat-preferences] ${message}`, details)
}

export function composerFromProviderDefaults(
  provider: AgentProvider,
  providerDefaults: ChatProviderPreferences
): ComposerState {
  if (isAddonProvider(provider)) return { provider, ...normalizeAddonPreference(provider, providerDefaults[provider]) }
  if (provider === "claude") {
    const preference = providerDefaults.claude
    return {
      provider: "claude",
      model: preference.model,
      modelOptions: { ...preference.modelOptions },
      permissionMode: preference.permissionMode ?? DEFAULT_CLAUDE_PERMISSION_MODE,
    }
  }

  const preference = providerDefaults.codex
  return {
    provider: "codex",
    model: preference.model,
    modelOptions: { ...preference.modelOptions },
    permissionMode: preference.permissionMode ?? DEFAULT_CODEX_PERMISSION_MODE,
  }
}

function cloneComposerState(state: ComposerState): ComposerState {
  if (state.provider === "deepseek" || state.provider === "codebuddy") return { provider: state.provider, ...normalizeAddonPreference(state.provider, state) }
  return state.provider === "claude"
    ? {
      provider: "claude",
      model: state.model,
      modelOptions: { ...state.modelOptions },
      permissionMode: normalizeClaudePermissionMode(state.permissionMode),
    }
    : {
      provider: "codex",
      model: state.model,
      modelOptions: { ...state.modelOptions },
      permissionMode: normalizeCodexPermissionMode(state.permissionMode),
    }
}

function sameComposerState(left: ComposerState | undefined, right: ComposerState): boolean {
  if (!left || left.provider !== right.provider) return false
  if (left.model !== right.model || left.permissionMode !== right.permissionMode) return false

  if (left.provider === "claude" && right.provider === "claude") {
    return left.modelOptions.reasoningEffort === right.modelOptions.reasoningEffort
      && left.modelOptions.contextWindow === right.modelOptions.contextWindow
  }

  if ((left.provider === "deepseek" || left.provider === "codebuddy") && (right.provider === "deepseek" || right.provider === "codebuddy")) return left.modelOptions.reasoningEffort === right.modelOptions.reasoningEffort

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
  if (value && isAddonProvider(value.provider)) return { provider: value.provider, ...normalizeAddonPreference(value.provider, value) }
  if (value?.provider === "claude") {
    const preference = normalizeClaudePreference(value)
    return {
      provider: "claude",
      model: preference.model,
      modelOptions: preference.modelOptions,
      permissionMode: preference.permissionMode ?? DEFAULT_CLAUDE_PERMISSION_MODE,
    }
  }

  if (value?.provider === "codex") {
    const preference = normalizeCodexPreference(value)
    return {
      provider: "codex",
      model: preference.model,
      modelOptions: preference.modelOptions,
      permissionMode: preference.permissionMode ?? DEFAULT_CODEX_PERMISSION_MODE,
    }
  }

  if (legacyLiveProvider === "claude") {
    const preference = normalizeClaudePreference(legacyLivePreferences?.claude)
    return {
      provider: "claude",
      model: preference.model,
      modelOptions: preference.modelOptions,
      permissionMode: preference.permissionMode ?? DEFAULT_CLAUDE_PERMISSION_MODE,
    }
  }

  if (legacyLiveProvider === "codex") {
    const preference = normalizeCodexPreference(legacyLivePreferences?.codex)
    return {
      provider: "codex",
      model: preference.model,
      modelOptions: preference.modelOptions,
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

export function createComposerStateForNewChat(args: {
  defaultProvider: DefaultProviderPreference
  providerDefaults: ChatProviderPreferences
  sourceState?: ComposerState | null
  legacyComposerState?: ComposerState | null
}): ComposerState {
  if (args.defaultProvider === "last_used") {
    // Last Used selects the harness only; every new conversation uses its
    // current Settings defaults rather than the previous chat's parameters.
    const provider = args.sourceState?.provider ?? args.legacyComposerState?.provider ?? "codex"
    return composerFromProviderDefaults(provider, args.providerDefaults)
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
  serverChatStates: Record<string, ComposerState>
  legacyComposerState: ComposerState | null
  setDefaultProvider: (provider: DefaultProviderPreference) => void
  syncProviderDefaults: (defaultProvider: DefaultProviderPreference, providerDefaults: ChatProviderPreferences) => void
  setProviderDefaultModel: (provider: AgentProvider, model: string) => void
  setProviderDefaultModelOptions: <TProvider extends AgentProvider>(
    provider: TProvider,
    modelOptions: Partial<ProviderModelOptionsByProvider[TProvider]>
  ) => void
  setProviderDefaultPermissionMode: (provider: AgentProvider, permissionMode: ClaudePermissionMode | CodexPermissionMode) => void
  getComposerState: (chatId: string) => ComposerState
  initializeComposerForChat: (chatId: string, options?: { sourceState?: ComposerState | null }) => void
  syncComposerForChatFromServer: (chatId: string, preferences: ChatTurnPreferences) => void
  setComposerState: (chatId: string, composerState: ComposerState) => void
  setChatComposerProvider: (chatId: string, provider: AgentProvider) => void
  setChatComposerModel: (chatId: string, model: string) => void
  setChatComposerModelOptions: (
    chatId: string,
    modelOptions: Partial<ClaudeModelOptions> | Partial<CodexModelOptions> | Partial<DeepSeekModelOptions>
  ) => void
  setChatComposerPermissionMode: (chatId: string, permissionMode: ClaudePermissionMode | CodexPermissionMode) => void
  resetChatComposerFromProvider: (chatId: string, provider: AgentProvider) => void
}

export function migrateChatPreferencesState(
  persistedState: Partial<PersistedChatPreferencesState> | undefined
): Pick<ChatPreferencesState, "defaultProvider" | "providerDefaults" | "chatStates" | "legacyComposerState"> {
  const providerDefaults = normalizeProviderDefaults(persistedState?.providerDefaults)
  const legacyComposerState = normalizePersistedComposerState(
    persistedState?.legacyComposerState ?? persistedState?.composerState,
    providerDefaults
  )
  const legacyLiveComposerState = persistedState?.liveProvider
    ? normalizeComposerState(
      undefined,
      providerDefaults,
      persistedState.liveProvider,
      persistedState?.livePreferences
    )
    : null

  return {
    defaultProvider: normalizeDefaultProvider(persistedState?.defaultProvider),
    providerDefaults,
    chatStates: normalizeChatStates(persistedState?.chatStates, providerDefaults),
    legacyComposerState: legacyComposerState ?? legacyLiveComposerState,
  }
}

export const useChatPreferencesStore = create<ChatPreferencesState>()(
  (set, get) => ({
    defaultProvider: "last_used",
    providerDefaults: createDefaultProviderDefaults(),
    chatStates: {},
    serverChatStates: {},
    legacyComposerState: null,
    setDefaultProvider: (defaultProvider) => get().syncProviderDefaults(defaultProvider, get().providerDefaults),
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
          Object.entries(state.chatStates).map(([chatId, composerState]) => {
            const providerDefaultsChanged = !sameComposerState(
              composerFromProviderDefaults(composerState.provider, state.providerDefaults),
              composerFromProviderDefaults(composerState.provider, providerDefaults),
            )
            if (chatId === NEW_CHAT_COMPOSER_ID
              && (providerDefaultsChanged || defaultProvider !== state.defaultProvider)) {
              return [chatId, createComposerStateForNewChat({
                defaultProvider, providerDefaults, sourceState: composerState,
              })]
            }
            return [chatId,
              !state.serverChatStates[chatId] && sameComposerState(composerState, oldNewChatFallback)
                ? nextNewChatFallback
                : composerState,
            ]
          })
        )

        return {
          defaultProvider,
          providerDefaults,
          chatStates,
        }
      }),
      setProviderDefaultModel: (provider, model) => {
        const state = get()
        state.syncProviderDefaults(state.defaultProvider, {
          ...state.providerDefaults,
          [provider]: isAddonProvider(provider)
            ? normalizeAddonPreference(provider, { ...state.providerDefaults[provider], model })
            : provider === "claude"
            ? normalizeClaudePreference({ ...state.providerDefaults.claude, model })
            : normalizeCodexPreference({ ...state.providerDefaults.codex, model }),
        })
      },
      setProviderDefaultModelOptions: (provider, modelOptions) => {
        const state = get()
        state.syncProviderDefaults(state.defaultProvider, {
          ...state.providerDefaults,
          [provider]: isAddonProvider(provider)
            ? normalizeAddonPreference(provider, { ...state.providerDefaults[provider], modelOptions: { ...state.providerDefaults[provider]?.modelOptions, ...modelOptions as Partial<DeepSeekModelOptions> } })
            : provider === "claude"
            ? normalizeClaudePreference({
              ...state.providerDefaults.claude,
              modelOptions: { ...state.providerDefaults.claude.modelOptions, ...modelOptions as Partial<ClaudeModelOptions> },
            })
            : normalizeCodexPreference({
              ...state.providerDefaults.codex,
              modelOptions: { ...state.providerDefaults.codex.modelOptions, ...modelOptions as Partial<CodexModelOptions> },
            }),
        })
      },
      setProviderDefaultPermissionMode: (provider, permissionMode) => {
        const state = get()
        state.syncProviderDefaults(state.defaultProvider, {
          ...state.providerDefaults,
          [provider]: {
            ...state.providerDefaults[provider],
            permissionMode: isAddonProvider(provider) ? normalizeAddonPreference(provider, { permissionMode }).permissionMode : provider === "claude"
              ? normalizeClaudePermissionMode(permissionMode)
              : normalizeCodexPermissionMode(permissionMode),
          },
        })
      },
      getComposerState: (chatId) => cloneComposerState(getStoredComposerState(get(), chatId)),
      initializeComposerForChat: (chatId, options) =>
        set((state) => {
          if (state.chatStates[chatId] && chatId !== NEW_CHAT_COMPOSER_ID) {
            return state
          }

          const composerState = createComposerStateForNewChat({
            defaultProvider: state.defaultProvider,
            providerDefaults: state.providerDefaults,
            sourceState: options?.sourceState ?? (chatId === NEW_CHAT_COMPOSER_ID ? state.chatStates[chatId] : undefined),
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
      syncComposerForChatFromServer: (chatId, preferences) =>
        set((state) => {
          const serverComposerState = normalizeComposerState(preferences, state.providerDefaults)
          const currentComposerState = state.chatStates[chatId]
          const previousServerState = state.serverChatStates[chatId]
          const currentFallback = createComposerStateForNewChat({
            defaultProvider: state.defaultProvider,
            providerDefaults: state.providerDefaults,
            legacyComposerState: state.legacyComposerState,
          })
          const shouldUpdateComposer = !currentComposerState
            || (previousServerState && sameComposerState(currentComposerState, previousServerState))
            || (!previousServerState && sameComposerState(currentComposerState, currentFallback))

          return {
            serverChatStates: {
              ...state.serverChatStates,
              [chatId]: cloneComposerState(serverComposerState),
            },
            chatStates: shouldUpdateComposer
              ? {
                ...state.chatStates,
                [chatId]: cloneComposerState(serverComposerState),
              }
              : state.chatStates,
          }
        }),
      setComposerState: (chatId, composerState) =>
        set((state) => ({
          chatStates: {
            ...state.chatStates,
            [chatId]: (composerState.provider === "deepseek" || composerState.provider === "codebuddy")
              ? { provider: composerState.provider, ...normalizeAddonPreference(composerState.provider, composerState) }
              : composerState.provider === "claude"
              ? {
                provider: "claude",
                model: normalizeClaudePreference(composerState).model,
                modelOptions: normalizeClaudePreference(composerState).modelOptions,
                permissionMode: normalizeClaudePermissionMode(composerState.permissionMode),
              }
              : {
                provider: "codex",
                model: normalizeCodexPreference(composerState).model,
                modelOptions: normalizeCodexPreference(composerState).modelOptions,
                permissionMode: normalizeCodexPermissionMode(composerState.permissionMode),
              },
          },
        })),
      setChatComposerProvider: (chatId, provider) =>
        set((state) => withChatComposerState(state, chatId, () => composerFromProviderDefaults(provider, state.providerDefaults))),
      setChatComposerModel: (chatId, model) =>
        set((state) => withChatComposerState(state, chatId, (composerState) => (
          (composerState.provider === "deepseek" || composerState.provider === "codebuddy")
            ? { provider: composerState.provider, ...normalizeAddonPreference(composerState.provider, { ...composerState, model }) }
            : composerState.provider === "claude"
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
              permissionMode: composerState.permissionMode,
            }
            : {
              provider: "codex",
              model,
              modelOptions: normalizeCodexPreference({
                ...composerState,
                model,
              }).modelOptions,
              permissionMode: composerState.permissionMode,
            }
        ))),
      setChatComposerModelOptions: (chatId, modelOptions) =>
        set((state) => withChatComposerState(state, chatId, (composerState) => (
          (composerState.provider === "deepseek" || composerState.provider === "codebuddy")
            ? { provider: composerState.provider, ...normalizeAddonPreference(composerState.provider, { ...composerState, modelOptions: { ...composerState.modelOptions, ...modelOptions as Partial<DeepSeekModelOptions> } }) }
            : composerState.provider === "claude"
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
              permissionMode: composerState.permissionMode,
            }
        ))),
      setChatComposerPermissionMode: (chatId, permissionMode) =>
        set((state) => withChatComposerState(state, chatId, (composerState) => (
          (composerState.provider === "deepseek" || composerState.provider === "codebuddy")
            ? { provider: composerState.provider, ...normalizeAddonPreference(composerState.provider, { ...composerState, permissionMode }) }
            : composerState.provider === "claude"
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
