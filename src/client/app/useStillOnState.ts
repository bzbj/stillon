import { useClaudeModelPolicyStore } from "../stores/claudeModelPolicyStore"
import type { QuickCommand } from "../../shared/quick-commands"
import type { SidebarViewSnapshot } from "../../shared/sidebar-view"
import { markStartupPhase } from "../lib/startupMetrics"
import { useSidebarLayout } from "../hooks/useSidebarLayout"
import { isConnectBrowser } from "../lib/remoteSession"
import { QuickCommandDelivery, type QuickCommandReceipt } from "./quickCommandDelivery"
import { useCodexModelPolicyStore } from "../stores/codexModelPolicyStore"
import { AsyncQuestionDelivery, getAsyncQuestionDelivery } from "./asyncQuestionDelivery"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { useNavigate } from "react-router-dom"
import { useShallow } from "zustand/react/shallow"
import {
  CHAT_HISTORY_PAGE_ENTRY_LIMIT,
  INITIAL_CHAT_HISTORY_ENTRY_LIMIT,
} from "../../shared/transcript-history"
import { PROVIDERS, type AgentPermissionMode, type AgentProvider, type AppSettingsPatch, type AppSettingsSnapshot, type AskUserQuestionAnswerMap, type AsyncQuestionAnswerInput, type AsyncQuestionResponse, type ChatAttachment, type ChatHistoryPage, type ChatToolDetails, type KeybindingsSnapshot, type LlmProviderSnapshot, type LlmProviderValidationResult, type ModelOptions, type ProviderCatalogEntry, type QueuedChatMessage, type StandaloneTranscriptExportCommandResult, type TranscriptEntry, type UserPromptEntry } from "../../shared/types"
import { createComposerStateForNewChat, NEW_CHAT_COMPOSER_ID, type ComposerState, useChatPreferencesStore } from "../stores/chatPreferencesStore"
import { useRightSidebarStore } from "../stores/rightSidebarStore"
import { useTerminalLayoutStore } from "../stores/terminalLayoutStore"
import { useTerminalPreferencesStore } from "../stores/terminalPreferencesStore"
import { useChatInputStore } from "../stores/chatInputStore"
import { useAppSettingsStore } from "../stores/appSettingsStore"
import { useChatSoundPreferencesStore } from "../stores/chatSoundPreferencesStore"
import type { ChatSnapshot, LocalProjectsSnapshot, SidebarChatRow, SidebarData } from "../../shared/types"
import type { AskUserQuestionItem } from "../components/messages/types"
import type { OpenLocalLinkTarget } from "../components/messages/shared"
import { useAppDialog } from "../components/ui/app-dialog"
import { useTheme } from "../hooks/useTheme"
import { getBrowserMachineIdentityStorage, persistMachineIdentityName, readStoredMachineIdentityName } from "../lib/machineIdentity"
import { readCachedDefaultProjectId, resolveDefaultProjectId, writeCachedDefaultProjectId } from "../lib/defaultProject"
import { createTranscriptProcessor, processTranscriptMessages } from "../lib/parseTranscript"
import {
  clearSidebarSnapshotsForScope,
  createSidebarSnapshotIdentity,
  createSidebarSnapshotScope,
  getBrowserSidebarSnapshotOrigin,
  getBrowserSidebarSnapshotStorage,
  getSidebarSnapshotStorageKey,
  loadSidebarSnapshot,
  persistSidebarSnapshot,
  removeSidebarSnapshot,
} from "../lib/sidebarSnapshotCache"
import { generateUUID } from "../lib/utils"
import { canCancelStatus, getLatestToolIds, isProcessingStatus } from "./derived"
import { StillOnSocket, type SocketStatus } from "./socket"
import { ConfirmedCommandError } from "./quickCommandDelivery"
import { applySidebarChatChanges, SidebarChatActions, type SidebarChatChange } from "./sidebarChatActions"
import type { LocalDirectoryListResult, OpenExternalAction, ResolvedLocalPath, AsyncQuestionAnswerResult } from "../../shared/protocol"

function sameRuntime(left: ChatSnapshot["runtime"] | null | undefined, right: ChatSnapshot["runtime"] | null | undefined) {
  if (left === right) return true
  if (!left || !right) return false
  return left.chatId === right.chatId
    && left.projectId === right.projectId
    && left.localPath === right.localPath
    && left.title === right.title
    && left.status === right.status
    && left.isDraining === right.isDraining
    && left.provider === right.provider
    && JSON.stringify(left.lastTurnPreferences) === JSON.stringify(right.lastTurnPreferences)
    && left.planMode === right.planMode
    && left.sessionToken === right.sessionToken
    && left.codexTransport === right.codexTransport
}

function sameTranscriptEntries(left: ChatSnapshot["messages"] | null | undefined, right: ChatSnapshot["messages"] | null | undefined) {
  if (left === right) return true
  if (!left || !right) return false
  if (left.length !== right.length) return false
  return left.every((entry, index) => entry === right[index])
}

function sameProviders(left: ProviderCatalogEntry[] | null | undefined, right: ProviderCatalogEntry[] | null | undefined) {
  if (left === right) return true
  if (!left || !right) return false
  if (left.length !== right.length) return false
  return left.every((provider, index) => {
    const other = right[index]
    return Boolean(other)
      && provider.id === other.id
      && provider.label === other.label
      && provider.defaultModel === other.defaultModel
      && provider.models.length === other.models.length
      && provider.models.every((model, modelIndex) => {
        const otherModel = other.models[modelIndex]
        return Boolean(otherModel)
          && model.id === otherModel.id
          && model.label === otherModel.label
          && model.supportsEffort === otherModel.supportsEffort
      })
  })
}

function sameHistory(left: ChatSnapshot["history"] | null | undefined, right: ChatSnapshot["history"] | null | undefined) {
  if (left === right) return true
  if (!left || !right) return false
  return left.hasOlder === right.hasOlder
    && left.olderCursor === right.olderCursor
    && left.recentLimit === right.recentLimit
    && left.revision === right.revision
}

function sameQueuedMessage(left: QueuedChatMessage, right: QueuedChatMessage) {
  return left.id === right.id
    && left.content === right.content
    && left.createdAt === right.createdAt
    && left.provider === right.provider
    && left.model === right.model
    && JSON.stringify(left.modelOptions) === JSON.stringify(right.modelOptions)
    && left.sendingNow === right.sendingNow
    && sameAttachmentArray(left.attachments, right.attachments)
}

function sameAttachmentArray(left: ChatAttachment[], right: ChatAttachment[]) {
  if (left === right) return true
  if (left.length !== right.length) return false
  return left.every((attachment, index) => {
    const other = right[index]
    return Boolean(other)
      && attachment.id === other.id
      && attachment.kind === other.kind
      && attachment.displayName === other.displayName
      && attachment.absolutePath === other.absolutePath
      && attachment.relativePath === other.relativePath
      && attachment.contentUrl === other.contentUrl
      && attachment.mimeType === other.mimeType
      && attachment.size === other.size
  })
}

function sameQueuedMessages(left: ChatSnapshot["queuedMessages"] | null | undefined, right: ChatSnapshot["queuedMessages"] | null | undefined) {
  if (left === right) return true
  if (!left || !right) return false
  if (left.length !== right.length) return false
  return left.every((message, index) => sameQueuedMessage(message, right[index]!))
}

function sameChatSnapshotCore(left: ChatSnapshot | null, right: ChatSnapshot | null) {
  if (left === right) return true
  if (!left || !right) return false
  return sameRuntime(left.runtime, right.runtime)
    && sameQueuedMessages(left.queuedMessages, right.queuedMessages)
    && sameTranscriptEntries(left.messages, right.messages)
    && sameHistory(left.history, right.history)
    && sameProviders(left.availableProviders, right.availableProviders)
    && left.asyncQuestionResponses === right.asyncQuestionResponses
}

function mergeTranscriptEntries(olderHistoryEntries: TranscriptEntry[], recentEntries: TranscriptEntry[]) {
  const deduped = new Map<string, TranscriptEntry>()
  for (const entry of olderHistoryEntries) {
    deduped.set(entry._id, entry)
  }
  for (const entry of recentEntries) {
    deduped.set(entry._id, entry)
  }
  return [...deduped.values()]
}

export function hydrateTranscriptToolSummaries(entries: TranscriptEntry[], details: TranscriptEntry[]) {
  if (details.length === 0) return entries
  const byToolId = new Map<string, TranscriptEntry[]>()
  for (const detail of details) {
    const toolId = detail.kind === "tool_call" ? detail.tool.toolId : detail.kind === "tool_result" ? detail.toolId : null
    if (!toolId) continue
    const current = byToolId.get(toolId) ?? []
    current.push(detail)
    byToolId.set(toolId, current)
  }
  return entries.flatMap((entry) => (
    entry.kind === "tool_summary" && byToolId.has(entry.toolId)
      ? byToolId.get(entry.toolId)!
      : [entry]
  ))
}

export function hasReadableTranscriptContext(entries: TranscriptEntry[]) {
  return entries.some((entry) => (
    !entry.hidden
    && (entry.kind === "user_prompt" || entry.kind === "assistant_text" || entry.kind === "compact_summary")
  ))
}

interface HistoryPaginationState {
  chatId: string
  revision: string
  olderCursor: string | null
  hasOlder: boolean
  recentEntries: TranscriptEntry[]
}

export function reconcileHistoryPaginationSnapshot(
  current: HistoryPaginationState | null,
  snapshot: ChatSnapshot,
) {
  const createResetResult = () => ({
    state: {
      chatId: snapshot.runtime.chatId,
      revision: snapshot.history.revision,
      olderCursor: snapshot.history.olderCursor,
      hasOlder: snapshot.history.hasOlder,
      recentEntries: snapshot.messages,
    } satisfies HistoryPaginationState,
    fallenOutEntries: [] as TranscriptEntry[],
    reset: true,
  })

  if (
    !current
    || current.chatId !== snapshot.runtime.chatId
    || current.revision !== snapshot.history.revision
  ) {
    return createResetResult()
  }

  const nextRecentIds = new Set(snapshot.messages.map((entry) => entry._id))
  const hasOverlap = current.recentEntries.some((entry) => nextRecentIds.has(entry._id))
  if (
    snapshot.messages.length > 0
    && (
      current.recentEntries.length === 0
      || !hasOverlap
    )
  ) {
    return createResetResult()
  }

  return {
    state: {
      ...current,
      recentEntries: snapshot.messages,
    },
    fallenOutEntries: current.recentEntries.filter((entry) => !nextRecentIds.has(entry._id)),
    reset: false,
  }
}

export function isHistoryCursorExpiredError(error: unknown) {
  return error instanceof Error
    && error.message.startsWith("History cursor expired.")
}

export function getPreviousPrompt(messages: ReturnType<typeof processTranscriptMessages>) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.kind === "user_prompt" && message.content.trim().length > 0) {
      return message.content
    }
  }
  return null
}

const NEW_CHAT_OPTIMISTIC_SCOPE = "__new_chat__"
const LEGACY_THEME_STORAGE_KEY = "lever-theme"
const LEGACY_CHAT_SOUND_STORAGE_KEY = "chat-sound-preferences"
const LEGACY_TERMINAL_STORAGE_KEY = "terminal-preferences"
const LEGACY_CHAT_PREFERENCES_STORAGE_KEY = "chat-preferences"

export interface OptimisticUserPrompt {
  id: string
  scopeId: string
  signature: string
  requiredMatchCount: number
  entry: UserPromptEntry
}

interface OptimisticProcessingState {
  scopeId: string
  ackedAt: number | null
}

function readPersistedZustandState(key: string): Record<string, unknown> | null {
  if (typeof window === "undefined") return null
  const raw = window.localStorage.getItem(key)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { state?: unknown }
    return parsed.state && typeof parsed.state === "object" && !Array.isArray(parsed.state)
      ? parsed.state as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function readLegacyBrowserSettingsPatch(): AppSettingsPatch | null {
  if (typeof window === "undefined") return null

  const patch: AppSettingsPatch = {}
  const theme = window.localStorage.getItem(LEGACY_THEME_STORAGE_KEY)
  if (theme === "light" || theme === "dark" || theme === "system") {
    patch.theme = theme
  }

  const chatSoundState = readPersistedZustandState(LEGACY_CHAT_SOUND_STORAGE_KEY)
  if (chatSoundState?.chatSoundPreference === "never" || chatSoundState?.chatSoundPreference === "unfocused" || chatSoundState?.chatSoundPreference === "always") {
    patch.chatSoundPreference = chatSoundState.chatSoundPreference
  }
  if (
    chatSoundState?.chatSoundId === "blow"
    || chatSoundState?.chatSoundId === "bottle"
    || chatSoundState?.chatSoundId === "frog"
    || chatSoundState?.chatSoundId === "funk"
    || chatSoundState?.chatSoundId === "glass"
    || chatSoundState?.chatSoundId === "ping"
    || chatSoundState?.chatSoundId === "pop"
    || chatSoundState?.chatSoundId === "purr"
    || chatSoundState?.chatSoundId === "tink"
  ) {
    patch.chatSoundId = chatSoundState.chatSoundId
  }

  const terminalState = readPersistedZustandState(LEGACY_TERMINAL_STORAGE_KEY)
  if (terminalState) {
    patch.terminal = {}
    if (typeof terminalState.scrollbackLines === "number") {
      patch.terminal.scrollbackLines = terminalState.scrollbackLines
    }
    if (typeof terminalState.minColumnWidth === "number") {
      patch.terminal.minColumnWidth = terminalState.minColumnWidth
    }
  }

  const chatPreferencesState = readPersistedZustandState(LEGACY_CHAT_PREFERENCES_STORAGE_KEY)
  if (chatPreferencesState?.defaultProvider === "last_used" || chatPreferencesState?.defaultProvider === "claude" || chatPreferencesState?.defaultProvider === "codex") {
    patch.defaultProvider = chatPreferencesState.defaultProvider
  }
  if (chatPreferencesState?.providerDefaults && typeof chatPreferencesState.providerDefaults === "object") {
    patch.providerDefaults = chatPreferencesState.providerDefaults as AppSettingsPatch["providerDefaults"]
  }

  patch.browserSettingsMigrated = true
  return Object.keys(patch).length > 1 ? patch : null
}

function clearLegacyBrowserSettings() {
  if (typeof window === "undefined") return
  window.localStorage.removeItem(LEGACY_THEME_STORAGE_KEY)
  window.localStorage.removeItem(LEGACY_CHAT_SOUND_STORAGE_KEY)
  window.localStorage.removeItem(LEGACY_TERMINAL_STORAGE_KEY)
  window.localStorage.removeItem(LEGACY_CHAT_PREFERENCES_STORAGE_KEY)
}

function syncRuntimeStoresFromAppSettings(snapshot: AppSettingsSnapshot) {
  useAppSettingsStore.getState().setFromServer(snapshot)
  const terminalPreferences = useTerminalPreferencesStore.getState()
  terminalPreferences.setScrollbackLines(snapshot.terminal.scrollbackLines)
  terminalPreferences.setMinColumnWidth(snapshot.terminal.minColumnWidth)

  const chatSoundPreferences = useChatSoundPreferencesStore.getState()
  chatSoundPreferences.setChatSoundPreference(snapshot.chatSoundPreference)
  chatSoundPreferences.setChatSoundId(snapshot.chatSoundId)

  useChatPreferencesStore.getState().syncProviderDefaults(snapshot.defaultProvider, snapshot.providerDefaults)
}

function serializeAttachmentSignature(attachment: ChatAttachment) {
  return JSON.stringify({
    id: attachment.id,
    kind: attachment.kind,
    displayName: attachment.displayName,
    relativePath: attachment.relativePath,
    mimeType: attachment.mimeType,
    size: attachment.size,
    contentUrl: attachment.contentUrl,
  })
}

export function getUserPromptSignature(content: string, attachments: ChatAttachment[] = []) {
  return JSON.stringify({
    content,
    attachments: attachments.map(serializeAttachmentSignature),
  })
}

export function countMatchingUserPrompts(entries: TranscriptEntry[], signature: string) {
  return entries.reduce((count, entry) => {
    if (entry.kind !== "user_prompt") return count
    return count + (getUserPromptSignature(entry.content, entry.attachments ?? []) === signature ? 1 : 0)
  }, 0)
}

export function reconcileOptimisticUserPrompts(
  optimisticPrompts: OptimisticUserPrompt[],
  scopeId: string,
  serverEntries: TranscriptEntry[],
) {
  const matchCounts = new Map<string, number>()
  for (const entry of serverEntries) {
    if (entry.kind !== "user_prompt") continue
    const signature = getUserPromptSignature(entry.content, entry.attachments ?? [])
    matchCounts.set(signature, (matchCounts.get(signature) ?? 0) + 1)
  }

  return optimisticPrompts.filter((prompt) => {
    if (prompt.scopeId !== scopeId) return true
    return (matchCounts.get(prompt.signature) ?? 0) < prompt.requiredMatchCount
  })
}

export function getNewestRemainingChatId(projectGroups: SidebarData["projectGroups"], activeChatId: string): string | null {
  const projectGroup = projectGroups.find((group) => group.chats.some((chat) => chat.chatId === activeChatId))
  if (!projectGroup) return null

  return projectGroup.chats.find((chat) => chat.chatId !== activeChatId)?.chatId ?? null
}

export function applySidebarProjectOrder(
  projectGroups: SidebarData["projectGroups"],
  projectIds: string[] | null | undefined
) {
  if (!projectIds?.length || projectGroups.length <= 1) {
    return projectGroups
  }

  const indexByProjectId = new Map(projectGroups.map((group, index) => [group.groupKey, index]))
  const seen = new Set<string>()
  const orderedGroups = projectIds
    .map((projectId) => {
      if (seen.has(projectId)) {
        return null
      }
      seen.add(projectId)
      const index = indexByProjectId.get(projectId)
      return index === undefined ? null : projectGroups[index]
    })
    .filter((group): group is SidebarData["projectGroups"][number] => Boolean(group))

  if (orderedGroups.length === 0) {
    return projectGroups
  }

  const nextProjectGroups = [
    ...orderedGroups,
    ...projectGroups.filter((group) => !seen.has(group.groupKey)),
  ]

  return nextProjectGroups.every((group, index) => group === projectGroups[index])
    ? projectGroups
    : nextProjectGroups
}

export function reconcileSidebarProjectSelection(
  currentProjectId: string | null,
  activeChatId: string | null,
  projectGroups: SidebarData["projectGroups"]
) {
  if (currentProjectId && projectGroups.some((group) => group.groupKey === currentProjectId)) {
    return currentProjectId
  }

  if (activeChatId) {
    const activeProject = projectGroups.find((group) => (
      group.chats.some((chat) => chat.chatId === activeChatId)
    ))
    if (activeProject) return activeProject.groupKey
  }

  return projectGroups[0]?.groupKey ?? null
}

export function shouldMarkActiveChatRead(doc: Pick<Document, "visibilityState" | "hasFocus"> = document) {
  return doc.visibilityState === "visible" && doc.hasFocus()
}

function wsUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
  return `${protocol}//${window.location.host}/ws`
}

function useStillOnSocket() {
  const socketRef = useRef<StillOnSocket | null>(null)
  if (!socketRef.current) {
    socketRef.current = new StillOnSocket(wsUrl())
  }

  useEffect(() => {
    const socket = socketRef.current
    markStartupPhase("socket-start")
    socket?.start()
    return () => {
      socket?.dispose()
    }
  }, [])

  return socketRef.current as StillOnSocket
}

function logStillOnState(message: string, details?: unknown) {
  void message
  void details
}

const SEND_TO_STARTING_PROFILE_STORAGE_KEY = "kanna:profile-send-to-starting"

interface SendToStartingTrace {
  traceId: string
  optimisticId: string
  startedAt: number
  serverChatId: string | null
  routeChatIdAtSend: string | null
  contentPreview: string
  ackAt?: number
  snapshotAt?: number
  startingStatusAt?: number
  startingRenderedAt?: number
}

function isSendToStartingProfilingEnabled() {
  try {
    return window.sessionStorage.getItem(SEND_TO_STARTING_PROFILE_STORAGE_KEY) === "1"
      || window.localStorage.getItem(SEND_TO_STARTING_PROFILE_STORAGE_KEY) === "1"
  } catch {
    return false
  }
}

function elapsedTraceMs(startedAt: number) {
  return Number((performance.now() - startedAt).toFixed(1))
}

function logSendToStartingTrace(
  trace: SendToStartingTrace | null | undefined,
  stage: string,
  details?: Record<string, unknown>
) {
  if (!trace || !isSendToStartingProfilingEnabled()) {
    return
  }

  console.debug("[stillon/send->starting][client]", {
    traceId: trace.traceId,
    stage,
    elapsedMs: elapsedTraceMs(trace.startedAt),
    serverChatId: trace.serverChatId,
    routeChatIdAtSend: trace.routeChatIdAtSend,
    ...details,
  })
}

function composerStateFromSendOptions(options?: {
  provider?: AgentProvider
  model?: string
  modelOptions?: ModelOptions
  permissionMode?: AgentPermissionMode
}): ComposerState | null {
  if (options?.provider === "claude" && options.model && options.modelOptions?.claude) {
    return {
      provider: "claude",
      model: options.model,
      modelOptions: {
        reasoningEffort: options.modelOptions.claude.reasoningEffort ?? "high",
        contextWindow: options.modelOptions.claude.contextWindow ?? "200k",
      },
      permissionMode: options.permissionMode === "default"
        || options.permissionMode === "acceptEdits"
        || options.permissionMode === "auto"
        || options.permissionMode === "dontAsk"
        || options.permissionMode === "bypassPermissions"
        ? options.permissionMode
        : "acceptEdits",
    }
  }

  if (options?.provider === "codex" && options.model && options.modelOptions?.codex) {
    return {
      provider: "codex",
      model: options.model,
      modelOptions: {
        reasoningEffort: options.modelOptions.codex.reasoningEffort ?? "high",
        fastMode: options.modelOptions.codex.fastMode ?? false,
      },
      permissionMode: options.permissionMode === "request"
        || options.permissionMode === "auto"
        || options.permissionMode === "full"
        ? options.permissionMode
        : "full",
    }
  }

  return null
}

function getProjectIdForChat(projectGroups: SidebarData["projectGroups"], chatId: string | null) {
  if (!chatId) return null
  return projectGroups.find((group) => group.chats.some((chat) => chat.chatId === chatId))?.groupKey ?? null
}

export function resolveActiveProjectId({
  activeChatId,
  snapshotProjectId,
  projectGroups,
  pendingChatId,
  selectedProjectId,
}: {
  activeChatId: string | null
  snapshotProjectId: string | null | undefined
  projectGroups: SidebarData["projectGroups"]
  pendingChatId: string | null
  selectedProjectId: string | null
}): string | null {
  if (!activeChatId) return null
  return snapshotProjectId
    ?? getProjectIdForChat(projectGroups, activeChatId)
    // A newly created chat may not have reached either subscription yet.
    ?? (pendingChatId === activeChatId ? selectedProjectId : null)
}

export function shouldAutoFollowTranscript(distanceFromBottom: number) {
  return distanceFromBottom < 24
}

export const TRANSCRIPT_PADDING_BOTTOM_OFFSET = 30

export function getTranscriptPaddingBottom(inputHeight: number) {
  return inputHeight + TRANSCRIPT_PADDING_BOTTOM_OFFSET
}

export function getNextMeasuredInputHeight(previousHeight: number, measuredHeight: number) {
  return measuredHeight > 0 ? measuredHeight : previousHeight
}

function downloadTextFile(fileName: string, contents: string, contentType = "application/json") {
  const blob = new Blob([contents], { type: `${contentType}; charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = fileName
  anchor.style.display = "none"
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

export interface ProjectRequest {
  mode: "new" | "existing"
  localPath: string
  title: string
}

export type StartChatIntent =
  | { kind: "project_id"; projectId: string }
  | { kind: "local_path"; localPath: string }
  | { kind: "project_request"; project: ProjectRequest }

export function resolveComposeIntent(params: {
  selectedProjectId: string | null
  sidebarProjectId?: string | null
  fallbackLocalProjectPath?: string | null
}): StartChatIntent | null {
  const projectId = params.selectedProjectId ?? params.sidebarProjectId ?? null
  if (projectId) {
    return { kind: "project_id", projectId }
  }

  if (params.fallbackLocalProjectPath) {
    return { kind: "local_path", localPath: params.fallbackLocalProjectPath }
  }

  return null
}

export function getActiveChatSnapshot(chatSnapshot: ChatSnapshot | null, activeChatId: string | null): ChatSnapshot | null {
  if (!chatSnapshot) return null
  if (!activeChatId) return null
  if (chatSnapshot.runtime.chatId !== activeChatId) {
    logStillOnState("stale snapshot masked", {
      routeChatId: activeChatId,
      snapshotChatId: chatSnapshot.runtime.chatId,
      snapshotProvider: chatSnapshot.runtime.provider,
    })
    return null
  }
  return chatSnapshot
}

export interface StillOnState {
  socket: StillOnSocket
  activeChatId: string | null
  activeProjectId: string | null
  sidebarData: SidebarData
  localProjects: LocalProjectsSnapshot | null
  defaultProjectId: string | null
  chatSnapshot: ChatSnapshot | null
  keybindings: KeybindingsSnapshot | null
  appSettings: AppSettingsSnapshot | null
  workspaceCollapsed: SidebarViewSnapshot["workspaceCollapsed"] | undefined
  workspaceCollapseVersions: SidebarViewSnapshot["workspaceCollapseVersions"]
  handleWriteWorkspaceCollapsed: (patch: SidebarViewSnapshot["workspaceCollapsed"], expected: SidebarViewSnapshot["workspaceCollapseVersions"]) => Promise<AppSettingsSnapshot>
  sidebarWidth: number
  setSidebarWidth: (width: number) => void
  composerPreferencesReady: boolean
  machineName: string | null
  llmProvider: LlmProviderSnapshot | null
  connectionStatus: SocketStatus
  sidebarReady: boolean
  sidebarSnapshotStatus: "empty" | "cached" | "authoritative"
  localProjectsReady: boolean
  commandError: string | null
  startingLocalPath: string | null
  sidebarOpen: boolean
  sidebarCollapsed: boolean
  messages: ReturnType<typeof processTranscriptMessages>
  queuedMessages: QueuedChatMessage[]
  previousPrompt: string | null
  latestToolIds: ReturnType<typeof getLatestToolIds>
  runtime: ChatSnapshot["runtime"] | null
  runtimeStatus: string | null
  isHistoryLoading: boolean
  hasOlderHistory: boolean
  availableProviders: ProviderCatalogEntry[]
  asyncQuestionResponses: AsyncQuestionResponse[]
  isProcessing: boolean
  canCancel: boolean
  isDraining: boolean
  isExportingStandalone: boolean
  standaloneShareUrl: string | null
  standaloneShareComplete: boolean
  navbarLocalPath?: string
  hasSelectedProject: boolean
  addProjectModalOpen: boolean
  openSidebar: () => void
  closeSidebar: () => void
  collapseSidebar: () => void
  expandSidebar: () => void
  openAddProjectModal: () => void
  closeAddProjectModal: () => void
  loadOlderHistory: () => Promise<void>
  loadToolDetails: (toolIds: string[]) => Promise<void>
  quickCommandStarting: boolean
  handleRunQuickCommand: (projectId: string, command: QuickCommand) => Promise<void>
  handleCreateChat: (projectId: string) => Promise<void>
  setDefaultProjectId: (projectId: string | null) => void
  handleForkChat: (chat: SidebarChatRow) => Promise<void>
  handleOpenLocalProject: (localPath: string) => Promise<void>
  handleCreateProject: (project: ProjectRequest) => Promise<void>
  handleListLocalDirectories: (localPath?: string) => Promise<LocalDirectoryListResult>
  handleResolveLocalPath: (localPath: string) => Promise<ResolvedLocalPath>
  handleReadAppSettings: () => Promise<void>
  handleWriteAppSettings: (patch: AppSettingsPatch) => Promise<AppSettingsSnapshot>
  handleReadLlmProvider: () => Promise<void>
  handleWriteLlmProvider: (value: Pick<LlmProviderSnapshot, "provider" | "apiKey" | "model" | "baseUrl">) => Promise<void>
  handleValidateLlmProvider: (value: Pick<LlmProviderSnapshot, "provider" | "apiKey" | "model" | "baseUrl">) => Promise<LlmProviderValidationResult>
  handleSignOut: () => Promise<void>
  handleSend: (content: string, options?: { provider?: AgentProvider; model?: string; modelOptions?: ModelOptions; permissionMode?: AgentPermissionMode; attachments?: ChatAttachment[] }, projectIdOverride?: string) => Promise<void>
  handleSteerQueuedMessage: (queuedMessageId: string) => Promise<void>
  handleRemoveQueuedMessage: (queuedMessageId: string) => Promise<void>
  handleCancel: () => Promise<void>
  handleStopDraining: () => Promise<void>
  handleRenameChat: (chat: SidebarChatRow) => Promise<void>
  handleRenameProject: (projectId: string, sidebarTitle: string | undefined, realTitle: string) => Promise<void>
  handleShareChat: (chatId?: string | null) => Promise<void>
  handlePinChat: (chat: SidebarChatRow) => Promise<void>
  handleArchiveChat: (chat: SidebarChatRow) => Promise<void>
  handleOpenArchivedChat: (chatId: string) => Promise<void>
  handleDeleteChat: (chat: SidebarChatRow) => Promise<void>
  handleHideProject: (projectId: string) => Promise<void>
  handleReorderProjectGroups: (projectIds: string[]) => Promise<void>
  handleCopyPath: (localPath: string) => Promise<void>
  handleOpenExternal: (action: OpenExternalAction) => Promise<void>
  handleOpenExternalPath: (action: "open_finder" | "open_default", localPath: string) => Promise<void>
  handleOpenLocalLink: (target: OpenLocalLinkTarget, action?: OpenExternalAction) => Promise<void>
  handleCompose: () => void
  handleAskUserQuestion: (
    toolUseId: string,
    questions: AskUserQuestionItem[],
    answers: AskUserQuestionAnswerMap
  ) => Promise<void>
  asyncQuestionDelivery: AsyncQuestionDelivery
  handleAnswerAsyncQuestion: (
    questionKey: string,
    answers: AsyncQuestionAnswerInput[],
    submissionId: string,
  ) => Promise<AsyncQuestionAnswerResult>
  handleExitPlanMode: (
    toolUseId: string,
    confirmed: boolean,
    clearContext?: boolean,
    message?: string
  ) => Promise<void>
  handleExportStandalone: (chatId?: string | null) => Promise<StandaloneTranscriptExportCommandResult | null>
  handleCloseStandaloneShareDialog: () => void
  handleOpenStandaloneShareLink: () => void
  handleCopyStandaloneShareLink: () => Promise<boolean>
}

export function useStillOnState(activeChatId: string | null, cacheScope: string | null, initialSidebarView?: SidebarViewSnapshot): StillOnState {
  const navigate = useNavigate()
  const socket = useStillOnSocket()
  const claudeModelPolicy = useClaudeModelPolicyStore((store) => store.snapshot)
  const modelPolicy = useCodexModelPolicyStore((store) => store.snapshot)
  const asyncQuestionDelivery = useMemo(() => getAsyncQuestionDelivery(socket), [socket])
  const dialog = useAppDialog()
  const { resolvedTheme } = useTheme()

  const [sidebarBootstrap] = useState(() => {
    const machineName = initialSidebarView?.machineName ?? readStoredMachineIdentityName(getBrowserMachineIdentityStorage())
    const identity = createSidebarSnapshotIdentity({
      origin: getBrowserSidebarSnapshotOrigin(),
      authScope: cacheScope,
      machineName,
    })
    const snapshot = identity
      ? loadSidebarSnapshot(identity, getBrowserSidebarSnapshotStorage())
      : null
    return { identity, machineName, snapshot, view: initialSidebarView }
  })
  const { collapsed: sidebarCollapsed, setCollapsed: setSidebarCollapsed, width: sidebarWidth, setWidth: setSidebarWidth } = useSidebarLayout(
    JSON.stringify([getBrowserSidebarSnapshotOrigin(), cacheScope]),
  )
  const [sidebarData, setSidebarData] = useState<SidebarData>(
    sidebarBootstrap.snapshot?.data ?? { projectGroups: [] }
  )
  const [sidebarSnapshotStatus, setSidebarSnapshotStatus] = useState<"empty" | "cached" | "authoritative">(
    sidebarBootstrap.snapshot ? "cached" : "empty"
  )
  const sidebarSnapshotStatusRef = useRef(sidebarSnapshotStatus)
  const [sidebarChatActions] = useState(() => new SidebarChatActions())
  const sidebarChatChanges = useSyncExternalStore(sidebarChatActions.subscribe, sidebarChatActions.getSnapshot)
  const [sidebarRefreshEpoch, setSidebarRefreshEpoch] = useState(0)
  const [optimisticSidebarProjectOrder, setOptimisticSidebarProjectOrder] = useState<string[] | null>(null)
  const [localProjects, setLocalProjects] = useState<LocalProjectsSnapshot | null>(null)
  const [cachedDefaultProjectId, setCachedDefaultProjectId] = useState(readCachedDefaultProjectId)
  const [chatSnapshot, setChatSnapshot] = useState<ChatSnapshot | null>(null)
  const [olderHistoryEntries, setOlderHistoryEntries] = useState<TranscriptEntry[]>([])
  const [toolDetailEntries, setToolDetailEntries] = useState<TranscriptEntry[]>([])
  const [isHistoryLoading, setIsHistoryLoading] = useState(false)
  const [hasOlderHistory, setHasOlderHistory] = useState(false)
  const [historyRefreshEpoch, setHistoryRefreshEpoch] = useState(0)
  const [keybindings, setKeybindings] = useState<KeybindingsSnapshot | null>(null)
  const [appSettings, setAppSettings] = useState<AppSettingsSnapshot | null>(null)
  const [machineName, setMachineName] = useState<string | null>(sidebarBootstrap.machineName)
  const [confirmedMachineName, setConfirmedMachineName] = useState<string | null>(null)
  const [llmProvider, setLlmProvider] = useState<LlmProviderSnapshot | null>(null)
  const [connectionStatus, setConnectionStatus] = useState<SocketStatus>("connecting")
  const [sidebarReady, setSidebarReady] = useState(false)
  const [localProjectsReady, setLocalProjectsReady] = useState(false)
  const [chatReady, setChatReady] = useState(false)
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [addProjectModalOpen, setAddProjectModalOpen] = useState(false)
  const [commandError, setCommandError] = useState<string | null>(null)
  const [sidebarActionError, setSidebarActionError] = useState<string | null>(null)
  const [isExportingStandalone, setIsExportingStandalone] = useState(false)
  const [standaloneShareUrl, setStandaloneShareUrl] = useState<string | null>(null)
  const [standaloneShareComplete, setStandaloneShareComplete] = useState(false)
  const [startingLocalPath, setStartingLocalPath] = useState<string | null>(null)
  const [pendingChatId, setPendingChatId] = useState<string | null>(null)
  const [optimisticUserPrompts, setOptimisticUserPrompts] = useState<OptimisticUserPrompt[]>([])
  const [optimisticProcessing, setOptimisticProcessing] = useState<OptimisticProcessingState | null>(null)
  const [focusEpoch, setFocusEpoch] = useState(0)
  const sendToStartingProfilesRef = useRef<Map<string, SendToStartingTrace>>(new Map())
  const historyPaginationRef = useRef<HistoryPaginationState | null>(null)
  const historyRequestTokenRef = useRef(0)
  const historyLoadInFlightRef = useRef(false)
  const draftChatIds = useChatInputStore(useShallow((state) => Object.keys(state.drafts).sort()))
  const attachmentDraftChatIds = useChatInputStore(
    useShallow((state) => Object.keys(state.attachmentDrafts).sort())
  )
  const chatSubscriptionDebugRef = useRef(0)
  const lastStartingRenderedTraceIdRef = useRef<string | null>(null)
  const activeChatIdRef = useRef(activeChatId)
  activeChatIdRef.current = activeChatId
  const sidebarProjectGroups = useMemo(
    () => applySidebarProjectOrder(applySidebarChatChanges(sidebarData, sidebarChatChanges).projectGroups, optimisticSidebarProjectOrder),
    [optimisticSidebarProjectOrder, sidebarData, sidebarChatChanges]
  )
  const resolvedSidebarData = useMemo(
    () => (
      sidebarProjectGroups === sidebarData.projectGroups
        ? sidebarData
        : {
            ...sidebarData,
            projectGroups: sidebarProjectGroups,
          }
    ),
    [sidebarData, sidebarProjectGroups]
  )
  const effectiveDefaultProjectId = resolveDefaultProjectId(appSettings, cachedDefaultProjectId)
  const validDefaultProjectId = sidebarProjectGroups.some((group) => group.groupKey === effectiveDefaultProjectId)
    ? effectiveDefaultProjectId
    : null

  const applyAppSettingsSnapshot = useCallback((snapshot: AppSettingsSnapshot) => {
    const confirmedIdentity = createSidebarSnapshotIdentity({
      origin: getBrowserSidebarSnapshotOrigin(),
      authScope: cacheScope,
      machineName: snapshot.machineName,
    })
    const bootstrapIdentity = sidebarBootstrap.identity
    const identityChanged = Boolean(
      bootstrapIdentity
      && (!confirmedIdentity
        || getSidebarSnapshotStorageKey(bootstrapIdentity) !== getSidebarSnapshotStorageKey(confirmedIdentity))
    )
    if (identityChanged) {
      removeSidebarSnapshot(bootstrapIdentity, getBrowserSidebarSnapshotStorage())
      if (sidebarSnapshotStatusRef.current === "cached") {
        sidebarSnapshotStatusRef.current = "empty"
        setSidebarData({ projectGroups: [] })
        setSidebarSnapshotStatus("empty")
      }
    }

    setAppSettings(snapshot)
    setMachineName(snapshot.machineName)
    setConfirmedMachineName(snapshot.machineName)
    persistMachineIdentityName(snapshot.machineName, getBrowserMachineIdentityStorage())
    syncRuntimeStoresFromAppSettings(snapshot)
    // Keep the local cache aligned with the server value so this browser paints
    // the right project immediately on the next load.
    setCachedDefaultProjectId(snapshot.defaultProjectId)
    writeCachedDefaultProjectId(snapshot.defaultProjectId)
  }, [cacheScope, sidebarBootstrap.identity])

  useEffect(() => socket.onStatus(setConnectionStatus), [socket])
  useEffect(() => {
    if (connectionStatus === "connected") markStartupPhase("socket-open")
  }, [connectionStatus])

  useEffect(() => socket.subscribe({ type: "claude-model-policy" }, () => {}), [socket])
  useEffect(() => socket.subscribe({ type: "codex-model-policy" }, () => {}), [socket])

  useEffect(() => {
    // Re-subscription reads after the command settled, including uncertain failures.
    const freshRead = sidebarChatActions.getSnapshot().filter(change => change.settled)
    let firstSnapshot = true
    return socket.subscribe<SidebarData>({ type: "sidebar" }, (snapshot) => {
      sidebarChatActions.receive(snapshot, firstSnapshot ? freshRead : [])
      firstSnapshot = false
      markStartupPhase("sidebar-data")
      setSidebarData(snapshot)
      sidebarSnapshotStatusRef.current = "authoritative"
      setSidebarSnapshotStatus("authoritative")
      setSelectedProjectId((current) => (
        reconcileSidebarProjectSelection(current, activeChatIdRef.current, snapshot.projectGroups)
      ))
      setOptimisticSidebarProjectOrder((current) => (
        current && applySidebarProjectOrder(snapshot.projectGroups, current) === snapshot.projectGroups
          ? null
          : current
      ))
      setSidebarReady(true)
      setCommandError(null)
    })
  }, [socket, sidebarChatActions, sidebarRefreshEpoch])

  useEffect(() => {
    if (sidebarSnapshotStatus !== "authoritative" || !confirmedMachineName) return
    const identity = createSidebarSnapshotIdentity({
      origin: getBrowserSidebarSnapshotOrigin(),
      authScope: cacheScope,
      machineName: confirmedMachineName,
    })
    if (!identity) return

    const timeoutId = window.setTimeout(() => {
      persistSidebarSnapshot(
        identity,
        sidebarData,
        getBrowserSidebarSnapshotStorage()
      )
    }, 250)

    return () => window.clearTimeout(timeoutId)
  }, [cacheScope, confirmedMachineName, sidebarData, sidebarSnapshotStatus])

  useEffect(() => {
    if (connectionStatus !== "connected") return

    const protectedChatIds = [...new Set([...draftChatIds, ...attachmentDraftChatIds])].sort()
    void socket.command({ type: "chat.setDraftProtection", chatIds: protectedChatIds }).catch((error) => {
      setCommandError(error instanceof Error ? error.message : String(error))
    })
  }, [attachmentDraftChatIds, connectionStatus, draftChatIds, socket])

  useEffect(() => {
    return socket.subscribe<LocalProjectsSnapshot>({ type: "local-projects" }, (snapshot) => {
      markStartupPhase("project-data")
      setLocalProjects(snapshot)
      setLocalProjectsReady(true)
      setCommandError(null)
    })
  }, [socket])

  useEffect(() => {
    return socket.subscribe<KeybindingsSnapshot>({ type: "keybindings" }, (snapshot) => {
      setKeybindings(snapshot)
      setCommandError(null)
    })
  }, [socket])

  useEffect(() => {
    return socket.subscribe<AppSettingsSnapshot>({ type: "app-settings" }, (snapshot) => {
      markStartupPhase("preferences")
      applyAppSettingsSnapshot(snapshot)
      setCommandError(null)
    })
  }, [applyAppSettingsSnapshot, socket])

  const handleReadAppSettings = useCallback(async () => {
    try {
      useAppSettingsStore.getState().setHydrationStatus("loading")
      const snapshot = await socket.command<AppSettingsSnapshot>({ type: "settings.readAppSettings" })
      applyAppSettingsSnapshot(snapshot)
      setCommandError(null)
    } catch (error) {
      useAppSettingsStore.getState().setHydrationStatus("error")
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [applyAppSettingsSnapshot, socket])

  const handleWriteAppSettings = useCallback(async (patch: AppSettingsPatch) => {
    try {
      useAppSettingsStore.getState().applyOptimisticPatch(patch)
      const snapshot = await socket.command<AppSettingsSnapshot>({
        type: "settings.writeAppSettingsPatch",
        patch,
      })
      applyAppSettingsSnapshot(snapshot)
      setCommandError(null)
      return snapshot
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
      await handleReadAppSettings()
      throw error
    }
  }, [applyAppSettingsSnapshot, handleReadAppSettings, socket])

  const handleWriteWorkspaceCollapsed = useCallback(async (
    patch: SidebarViewSnapshot["workspaceCollapsed"], expected: SidebarViewSnapshot["workspaceCollapseVersions"],
  ) => {
    try {
      const snapshot = await socket.command<AppSettingsSnapshot>({
        type: "settings.writeAppSettingsPatch",
        patch: { workspaceCollapsed: patch, workspaceCollapseExpectedVersions: expected },
      }, { signal: AbortSignal.timeout(10_000) })
      applyAppSettingsSnapshot(snapshot)
      return snapshot
    } catch (error) {
      await handleReadAppSettings()
      throw error
    }
  }, [applyAppSettingsSnapshot, handleReadAppSettings, socket])

  const setDefaultProjectId = useCallback((projectId: string | null) => {
    // Update local state and cache first so the star reacts immediately, then
    // persist server-side so the default follows the user across browsers,
    // devices, and origins rather than living only in this browser.
    setCachedDefaultProjectId(projectId)
    writeCachedDefaultProjectId(projectId)
    setAppSettings((current) => (current ? { ...current, defaultProjectId: projectId } : current))
    void handleWriteAppSettings({ defaultProjectId: projectId }).catch(() => {
      // handleWriteAppSettings already surfaces the error and re-syncs from the
      // server; the optimistic update above keeps the UI responsive meanwhile.
    })
  }, [handleWriteAppSettings])

  useEffect(() => {
    if (sidebarReady && effectiveDefaultProjectId && !validDefaultProjectId) {
      setDefaultProjectId(null)
    }
  }, [effectiveDefaultProjectId, setDefaultProjectId, sidebarReady, validDefaultProjectId])

  const handleReadLlmProvider = useCallback(async () => {
    try {
      const snapshot = await socket.command<LlmProviderSnapshot>({ type: "settings.readLlmProvider" })
      setLlmProvider(snapshot)
      setCommandError(null)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [socket])

  const handleWriteLlmProvider = useCallback(async (
    value: Pick<LlmProviderSnapshot, "provider" | "apiKey" | "model" | "baseUrl">
  ) => {
    try {
      const snapshot = await socket.command<LlmProviderSnapshot>({
        type: "settings.writeLlmProvider",
        provider: value.provider,
        apiKey: value.apiKey,
        model: value.model,
        baseUrl: value.baseUrl,
      })
      setLlmProvider(snapshot)
      setCommandError(null)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
      throw error
    }
  }, [socket])

  const handleValidateLlmProvider = useCallback(async (
    value: Pick<LlmProviderSnapshot, "provider" | "apiKey" | "model" | "baseUrl">
  ) => {
    return await socket.command<LlmProviderValidationResult>({
      type: "settings.validateLlmProvider",
      provider: value.provider,
      apiKey: value.apiKey,
      model: value.model,
      baseUrl: value.baseUrl,
    })
  }, [socket])

  useEffect(() => {
    if (connectionStatus !== "connected") return
    void handleReadAppSettings()
  }, [connectionStatus, handleReadAppSettings])

  useEffect(() => {
    if (connectionStatus !== "connected") return
    if (appSettings?.browserSettingsMigrated !== false) return
    const patch = readLegacyBrowserSettingsPatch()
    if (!patch) return
    void handleWriteAppSettings(patch)
      .then(clearLegacyBrowserSettings)
      .catch(() => undefined)
  }, [appSettings?.browserSettingsMigrated, connectionStatus, handleWriteAppSettings])

  useEffect(() => {
    if (connectionStatus !== "connected") return
    void handleReadLlmProvider()
  }, [connectionStatus, handleReadLlmProvider])

  useEffect(() => {
    function handleFocusSignal() {
      setFocusEpoch((value) => value + 1)
    }

    window.addEventListener("focus", handleFocusSignal)
    document.addEventListener("visibilitychange", handleFocusSignal)

    return () => {
      window.removeEventListener("focus", handleFocusSignal)
      document.removeEventListener("visibilitychange", handleFocusSignal)
    }
  }, [])

  useEffect(() => {
    if (!activeChatId) {
      logStillOnState("clearing chat snapshot for non-chat route")
      setChatSnapshot(null)
      setChatReady(true)
      return
    }

    const subscriptionId = ++chatSubscriptionDebugRef.current
    logStillOnState("subscribing to chat", {
      subscriptionId,
      activeChatId,
      sidebarProjectGroups: sidebarProjectGroups.length,
      sidebarChatCount: sidebarProjectGroups.reduce((count, group) => count + group.chats.length, 0),
    })
    setChatSnapshot(null)
    setChatReady(false)
    const unsubscribe = socket.subscribe<ChatSnapshot | null>({ type: "chat", chatId: activeChatId, recentLimit: INITIAL_CHAT_HISTORY_ENTRY_LIMIT }, (snapshot) => {
      if (subscriptionId !== chatSubscriptionDebugRef.current) {
        return
      }
      if (snapshot?.runtime.chatId) {
        if (snapshot.runtime.lastTurnPreferences) {
          useChatPreferencesStore.getState().syncComposerForChatFromServer(
            snapshot.runtime.chatId,
            snapshot.runtime.lastTurnPreferences,
          )
        }
        const matchingTrace = [...sendToStartingProfilesRef.current.values()]
          .filter((trace) => trace.serverChatId === snapshot.runtime.chatId)
          .sort((left, right) => right.startedAt - left.startedAt)[0]
        if (matchingTrace && matchingTrace.snapshotAt === undefined) {
          matchingTrace.snapshotAt = performance.now()
          logSendToStartingTrace(matchingTrace, "chat_snapshot_received", {
            status: snapshot.runtime.status,
            messageCount: snapshot.messages.length,
          })
        }
      }
      if (!snapshot) {
        historyPaginationRef.current = null
        historyRequestTokenRef.current += 1
        historyLoadInFlightRef.current = false
        setOlderHistoryEntries([])
        setIsHistoryLoading(false)
        setHasOlderHistory(false)
      } else {
        const reconciledHistory = reconcileHistoryPaginationSnapshot(
          historyPaginationRef.current,
          snapshot,
        )
        historyPaginationRef.current = reconciledHistory.state
        if (reconciledHistory.reset) {
          historyRequestTokenRef.current += 1
          historyLoadInFlightRef.current = false
          setOlderHistoryEntries([])
          setIsHistoryLoading(false)
        } else if (reconciledHistory.fallenOutEntries.length > 0) {
          setOlderHistoryEntries((current) => (
            mergeTranscriptEntries(current, reconciledHistory.fallenOutEntries)
          ))
        }
        setHasOlderHistory(reconciledHistory.state.hasOlder)
      }
      setChatSnapshot((current) => {
        const reused = sameChatSnapshotCore(current, snapshot)
        logStillOnState("chat snapshot received", {
          subscriptionId,
          activeChatId,
          snapshotChatId: snapshot?.runtime.chatId ?? null,
          snapshotProvider: snapshot?.runtime.provider ?? null,
          snapshotStatus: snapshot?.runtime.status ?? null,
          messageCount: snapshot?.messages.length ?? 0,
          reusedSnapshot: reused,
        })
        return reused ? current : snapshot
      })
      setChatReady(true)
      setCommandError(null)
    })
    return () => {
      logStillOnState("unsubscribing from chat", {
        subscriptionId,
        activeChatId,
        sidebarProjectGroups: sidebarProjectGroups.length,
        sidebarChatCount: sidebarProjectGroups.reduce((count, group) => count + group.chats.length, 0),
      })
      unsubscribe()
    }
  }, [activeChatId, historyRefreshEpoch, socket])

  useEffect(() => {
    if (!sidebarReady) return
    setSelectedProjectId((current) => (
      reconcileSidebarProjectSelection(current, activeChatId, sidebarProjectGroups)
    ))
  }, [activeChatId, sidebarProjectGroups, sidebarReady])

  useEffect(() => {
    if (!activeChatId) return
    if (!sidebarReady || !chatReady) return
    // Optimistic archive owns navigation; only saved absence invalidates a route.
    const exists = sidebarData.projectGroups.some((group) => group.chats.some((chat) => chat.chatId === activeChatId))
    if (exists) {
      if (pendingChatId === activeChatId) {
        setPendingChatId(null)
      }
      return
    }
    if (pendingChatId === activeChatId) {
      return
    }
    navigate("/")
  }, [activeChatId, chatReady, navigate, pendingChatId, sidebarData, sidebarReady])

  useEffect(() => {
    if (!chatSnapshot) return
    setSelectedProjectId(chatSnapshot.runtime.projectId)
  }, [chatSnapshot])

  useEffect(() => {
    if (!activeChatId || !sidebarReady) return
    if (!shouldMarkActiveChatRead()) return
    const activeSidebarChat = sidebarProjectGroups
      .flatMap((group) => group.chats)
      .find((chat) => chat.chatId === activeChatId)
    if (!activeSidebarChat?.unread) return
    void socket.command({ type: "chat.markRead", chatId: activeChatId }).catch((error) => {
      setCommandError(error instanceof Error ? error.message : String(error))
    })
  }, [activeChatId, focusEpoch, sidebarProjectGroups, sidebarReady, socket])

  useEffect(() => {
    historyPaginationRef.current = null
    historyRequestTokenRef.current += 1
    historyLoadInFlightRef.current = false
    setOlderHistoryEntries([])
    setIsHistoryLoading(false)
    setHasOlderHistory(false)
  }, [activeChatId])

  const activeChatSnapshot = useMemo(
    () => getActiveChatSnapshot(chatSnapshot, activeChatId),
    [activeChatId, chatSnapshot]
  )
  const activeProjectId = useMemo(
    () => resolveActiveProjectId({
      activeChatId,
      snapshotProjectId: activeChatSnapshot?.runtime.projectId,
      projectGroups: sidebarReady ? sidebarProjectGroups : [],
      pendingChatId,
      selectedProjectId,
    }),
    [activeChatId, activeChatSnapshot?.runtime.projectId, pendingChatId, selectedProjectId, sidebarProjectGroups, sidebarReady]
  )
  useEffect(() => {
    logStillOnState("active snapshot resolved", {
      routeChatId: activeChatId,
      rawSnapshotChatId: chatSnapshot?.runtime.chatId ?? null,
      rawSnapshotProvider: chatSnapshot?.runtime.provider ?? null,
      activeSnapshotChatId: activeChatSnapshot?.runtime.chatId ?? null,
      activeSnapshotProvider: activeChatSnapshot?.runtime.provider ?? null,
      pendingChatId,
    })
  }, [activeChatId, activeChatSnapshot, chatSnapshot, pendingChatId])
  const serverTranscriptEntries = useMemo(
    () => mergeTranscriptEntries(olderHistoryEntries, activeChatSnapshot?.messages ?? []),
    [activeChatSnapshot?.messages, olderHistoryEntries]
  )
  const optimisticScopeId = activeChatId ?? NEW_CHAT_OPTIMISTIC_SCOPE
  const optimisticTranscriptEntries = useMemo(
    () => optimisticUserPrompts
      .filter((prompt) => prompt.scopeId === optimisticScopeId)
      .map((prompt) => prompt.entry),
    [optimisticScopeId, optimisticUserPrompts]
  )
  const transcriptEntries = useMemo(
    () => [...hydrateTranscriptToolSummaries(serverTranscriptEntries, toolDetailEntries), ...optimisticTranscriptEntries],
    [optimisticTranscriptEntries, serverTranscriptEntries, toolDetailEntries]
  )
  const processMessages = useMemo(() => createTranscriptProcessor(), [activeChatId])
  const messages = useMemo(() => processMessages(transcriptEntries), [processMessages, transcriptEntries])
  const previousPrompt = useMemo(() => getPreviousPrompt(messages), [messages])
  const latestToolIds = useMemo(() => getLatestToolIds(messages), [messages])
  const runtime = activeChatSnapshot?.runtime ?? null
  const composerPreferencesReady = activeChatId
    ? chatReady && Boolean(runtime?.lastTurnPreferences || appSettings)
    : Boolean(appSettings)
  useEffect(() => {
    if (sidebarReady && localProjectsReady && composerPreferencesReady) markStartupPhase("workspace-data-ready")
    if (activeChatId && chatReady && messages.length) markStartupPhase("chat-data")
    if (activeChatId && composerPreferencesReady && connectionStatus === "connected") markStartupPhase("chat-preferences-ready")
  }, [activeChatId, chatReady, messages.length, sidebarReady, localProjectsReady, composerPreferencesReady, connectionStatus])
  const queuedMessages = activeChatSnapshot?.queuedMessages ?? []
  const optimisticRuntimeStatus = optimisticProcessing?.scopeId === optimisticScopeId && (!runtime || runtime.status === "idle")
    ? "starting"
    : null
  const effectiveRuntimeStatus = optimisticRuntimeStatus ?? runtime?.status ?? null
  const availableProviders = useMemo(() => (activeChatSnapshot?.availableProviders ?? PROVIDERS).map((provider) => (
    provider.id === "codex" && modelPolicy ? { ...provider, models: modelPolicy.policy.models,
      defaultModel: modelPolicy.policy.roles.conversation }
      : provider.id === "claude" && claudeModelPolicy ? { ...provider, models: claudeModelPolicy.policy.models, defaultModel: claudeModelPolicy.policy.defaultModel } : provider
  )), [activeChatSnapshot?.availableProviders, modelPolicy, claudeModelPolicy])
  const asyncQuestionResponses: AsyncQuestionResponse[] = activeChatSnapshot?.asyncQuestionResponses ?? []
  const isProcessing = isProcessingStatus(effectiveRuntimeStatus ?? undefined)
  const canCancel = canCancelStatus(effectiveRuntimeStatus ?? undefined)
  const isDraining = runtime?.isDraining ?? false
  const fallbackLocalProjectPath = localProjects?.projects[0]?.localPath ?? null
  const navbarLocalPath =
    runtime?.localPath
    ?? fallbackLocalProjectPath
    ?? (sidebarReady ? sidebarProjectGroups[0]?.localPath : undefined)
  const hasSelectedProject = Boolean(
    selectedProjectId
    ?? runtime?.projectId
    ?? (sidebarReady ? sidebarProjectGroups[0]?.groupKey : null)
    ?? fallbackLocalProjectPath
  )

  useEffect(() => {
    if (optimisticProcessing?.scopeId !== optimisticScopeId) {
      return
    }
    if (runtime?.status && runtime.status !== "idle") {
      setOptimisticProcessing(null)
    }
  }, [optimisticProcessing, optimisticScopeId, runtime?.status])

  useEffect(() => {
    if (!optimisticProcessing?.ackedAt || optimisticProcessing.scopeId !== optimisticScopeId) {
      return
    }
    if (runtime?.status && runtime.status !== "idle") {
      return
    }
    const timeoutId = window.setTimeout(() => {
      setOptimisticProcessing((current) => (
        current?.scopeId === optimisticScopeId && current.ackedAt === optimisticProcessing.ackedAt
          ? null
          : current
      ))
    }, 300)
    return () => window.clearTimeout(timeoutId)
  }, [optimisticProcessing, optimisticScopeId, runtime?.status])

  useEffect(() => {
    if (!activeChatId || runtime?.status !== "starting") {
      return
    }

    const matchingTrace = [...sendToStartingProfilesRef.current.values()]
      .filter((trace) => trace.serverChatId === activeChatId)
      .sort((left, right) => right.startedAt - left.startedAt)[0]
    if (!matchingTrace || matchingTrace.startingStatusAt !== undefined) {
      return
    }

    matchingTrace.startingStatusAt = performance.now()
    logSendToStartingTrace(matchingTrace, "runtime_status_starting", {
      status: runtime.status,
    })
  }, [activeChatId, runtime?.status])

  useEffect(() => {
    if (!activeChatId || !runtime || runtime.status === "starting") {
      return
    }

    const matchingTrace = [...sendToStartingProfilesRef.current.values()]
      .filter((trace) => trace.serverChatId === activeChatId)
      .sort((left, right) => right.startedAt - left.startedAt)[0]
    if (!matchingTrace || matchingTrace.startingRenderedAt !== undefined) {
      return
    }

    logSendToStartingTrace(matchingTrace, "starting_not_observed", {
      status: runtime.status,
    })
    sendToStartingProfilesRef.current.delete(matchingTrace.traceId)
  }, [activeChatId, runtime])

  useLayoutEffect(() => {
    if (!activeChatId || runtime?.status !== "starting") {
      lastStartingRenderedTraceIdRef.current = null
      return
    }

    const matchingTrace = [...sendToStartingProfilesRef.current.values()]
      .filter((trace) => trace.serverChatId === activeChatId)
      .sort((left, right) => right.startedAt - left.startedAt)[0]
    if (!matchingTrace) {
      return
    }

    if (lastStartingRenderedTraceIdRef.current === matchingTrace.traceId) {
      return
    }

    lastStartingRenderedTraceIdRef.current = matchingTrace.traceId
    matchingTrace.startingRenderedAt = performance.now()
    logSendToStartingTrace(matchingTrace, "starting_render_committed", {
      totalMs: elapsedTraceMs(matchingTrace.startedAt),
    })
    sendToStartingProfilesRef.current.delete(matchingTrace.traceId)
  }, [activeChatId, runtime?.status])

  useEffect(() => {
    setOptimisticUserPrompts((current) => {
      const reconciled = reconcileOptimisticUserPrompts(current, optimisticScopeId, serverTranscriptEntries)
      if (reconciled.length === current.length && reconciled.every((prompt, index) => prompt === current[index])) {
        return current
      }
      return reconciled
    })
  }, [optimisticScopeId, serverTranscriptEntries])

  const loadOlderHistory = useCallback(async () => {
    const pagination = historyPaginationRef.current
    if (
      !activeChatId
      || !pagination
      || pagination.chatId !== activeChatId
      || !pagination.olderCursor
      || !pagination.hasOlder
      || historyLoadInFlightRef.current
    ) {
      return
    }

    const requestCursor = pagination.olderCursor
    const requestRevision = pagination.revision
    const requestToken = historyRequestTokenRef.current + 1
    historyRequestTokenRef.current = requestToken
    historyLoadInFlightRef.current = true
    setIsHistoryLoading(true)
    try {
      const page = await socket.command<ChatHistoryPage>({
        type: "chat.loadHistory",
        chatId: activeChatId,
        beforeCursor: requestCursor,
        limit: CHAT_HISTORY_PAGE_ENTRY_LIMIT,
      })
      const current = historyPaginationRef.current
      if (
        historyRequestTokenRef.current !== requestToken
        || !current
        || current.chatId !== activeChatId
        || current.revision !== requestRevision
        || current.olderCursor !== requestCursor
        || page.revision !== requestRevision
      ) {
        return
      }

      setOlderHistoryEntries((current) => mergeTranscriptEntries(page.messages, current))
      historyPaginationRef.current = {
        ...current,
        olderCursor: page.olderCursor,
        hasOlder: page.hasOlder,
      }
      setHasOlderHistory(page.hasOlder)
      setCommandError(null)
    } catch (error) {
      if (historyRequestTokenRef.current === requestToken) {
        if (isHistoryCursorExpiredError(error)) {
          historyPaginationRef.current = null
          historyRequestTokenRef.current += 1
          historyLoadInFlightRef.current = false
          setOlderHistoryEntries([])
          setIsHistoryLoading(false)
          setHasOlderHistory(false)
          setCommandError(null)
          setHistoryRefreshEpoch((value) => value + 1)
        } else {
          const message = error instanceof Error ? error.message : String(error)
          setCommandError(message)
        }
      }
    } finally {
      if (historyRequestTokenRef.current === requestToken) {
        historyLoadInFlightRef.current = false
        setIsHistoryLoading(false)
      }
    }
  }, [activeChatId, socket])

  useEffect(() => {
    if (
      hasOlderHistory
      && !isHistoryLoading
      && !commandError
      && !hasReadableTranscriptContext(serverTranscriptEntries)
    ) {
      void loadOlderHistory()
    }
  }, [commandError, hasOlderHistory, isHistoryLoading, loadOlderHistory, serverTranscriptEntries])

  const [quickCommandStarting, setQuickCommandStarting] = useState(false)
  const quickCommandDelivery = useMemo(() => new QuickCommandDelivery(
    (request, operationId) => socket.command(request, { operationId }),
    isConnectBrowser() ? async id => {
      const response = await fetch(`/api/connect-operations/${encodeURIComponent(id)}`, { cache: "no-store" })
      if (!response.ok) throw new Error("Unable to check the command result")
      return await response.json() as QuickCommandReceipt
    } : undefined,
  ), [socket])
  const handleRunQuickCommand = useCallback(async (projectId: string, command: QuickCommand) => {
    const preferencesStore = useChatPreferencesStore.getState()
    const sourceState = preferencesStore.getComposerState(activeChatId ?? NEW_CHAT_COMPOSER_ID)
    const preferences = createComposerStateForNewChat({ ...preferencesStore, sourceState })
    setQuickCommandStarting(true)
    try {
      const completed = await quickCommandDelivery.start(projectId, command, preferences)
      preferencesStore.setComposerState(completed.result.chatId, completed.preferences as ComposerState)
      if (completed.result.error && completed.result.promptSaved === false) {
        useChatInputStore.getState().setDraft(completed.result.chatId, completed.command.prompt)
      }
      setSelectedProjectId(completed.projectId)
      setPendingChatId(completed.result.chatId)
      navigate(`/chat/${completed.result.chatId}`)
      setSidebarOpen(false)
      setCommandError(completed.result.error ? `${completed.result.error} Your command is saved in this new conversation. Set up the agent to continue.` : null)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : "Unable to start the command.")
    } finally { setQuickCommandStarting(false) }
  }, [activeChatId, navigate, quickCommandDelivery])

  const createChatForProject = useCallback(async (projectId: string) => {
    const chatPreferences = useChatPreferencesStore.getState()
    const sourceComposerState = activeChatId
      ? chatPreferences.getComposerState(activeChatId)
      : chatPreferences.getComposerState(NEW_CHAT_COMPOSER_ID)
    const result = await socket.command<{ chatId: string }>({ type: "chat.create", projectId })
    chatPreferences.initializeComposerForChat(result.chatId, { sourceState: sourceComposerState })
    setSelectedProjectId(projectId)
    setPendingChatId(result.chatId)
    navigate(`/chat/${result.chatId}`)
    setSidebarOpen(false)
    setCommandError(null)
  }, [activeChatId, navigate, socket])

  const resolveProjectIdForStartChat = useCallback(async (intent: StartChatIntent): Promise<{ projectId: string; localPath?: string }> => {
    if (intent.kind === "project_id") {
      return { projectId: intent.projectId }
    }

    if (intent.kind === "local_path") {
      const result = await socket.command<{ projectId: string }>({ type: "project.open", localPath: intent.localPath })
      return { projectId: result.projectId, localPath: intent.localPath }
    }

    const result = await socket.command<{ projectId: string }>(
      intent.project.mode === "new"
        ? { type: "project.create", localPath: intent.project.localPath, title: intent.project.title }
        : { type: "project.open", localPath: intent.project.localPath }
    )
    return { projectId: result.projectId, localPath: intent.project.localPath }
  }, [socket])

  const startChatFromIntent = useCallback(async (intent: StartChatIntent, propagateError = false) => {
    try {
      const localPath = intent.kind === "project_id"
        ? null
        : intent.kind === "local_path"
          ? intent.localPath
          : intent.project.localPath
      if (localPath) {
        setStartingLocalPath(localPath)
      }

      const { projectId } = await resolveProjectIdForStartChat(intent)
      await createChatForProject(projectId)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
      if (propagateError) throw error
    } finally {
      setStartingLocalPath(null)
    }
  }, [createChatForProject, resolveProjectIdForStartChat])

  const handleCreateChat = useCallback(async (projectId: string) => {
    navigate(`/?${new URLSearchParams({ workspace: projectId })}`)
    setSidebarOpen(false)
    setCommandError(null)
  }, [navigate])

  const handleForkChat = useCallback(async (chat: SidebarChatRow) => {
    try {
      const result = await socket.command<{ chatId: string }>({
        type: "chat.fork",
        chatId: chat.chatId,
      })
      const chatPreferences = useChatPreferencesStore.getState()
      chatPreferences.setComposerState(result.chatId, chatPreferences.getComposerState(chat.chatId))
      setPendingChatId(result.chatId)
      navigate(`/chat/${result.chatId}`)
      setSidebarOpen(false)
      setCommandError(null)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [navigate, socket])

  const handleOpenLocalProject = useCallback(async (localPath: string) => {
    await startChatFromIntent({ kind: "local_path", localPath })
  }, [startChatFromIntent])

  const handleCreateProject = useCallback(async (project: ProjectRequest) => {
    await startChatFromIntent({ kind: "project_request", project }, true)
  }, [startChatFromIntent])

  const handleSignOut = useCallback(async () => {
    try {
      const response = await fetch("/auth/logout", {
        method: "POST",
        headers: {
          Accept: "application/json",
        },
      })

      if (!response.ok) {
        throw new Error(`Sign out failed with status ${response.status}`)
      }

      clearSidebarSnapshotsForScope(createSidebarSnapshotScope({
        origin: getBrowserSidebarSnapshotOrigin(),
        authScope: cacheScope,
      }), getBrowserSidebarSnapshotStorage())
      setCommandError(null)
      const result = await response.json() as { logoutUrl?: string }
      if (result.logoutUrl) window.location.replace(result.logoutUrl)
      else window.location.reload()
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [cacheScope])

  const handleSend = useCallback(async (
    content: string,
    options?: { provider?: AgentProvider; model?: string; modelOptions?: ModelOptions; permissionMode?: AgentPermissionMode; attachments?: ChatAttachment[] },
    projectIdOverride?: string,
  ) => {
    const attachments = options?.attachments ?? []
    if (activeChatId && isProcessing) {
      try {
        await socket.command<{ queuedMessageId: string }>({
          type: "message.enqueue",
          chatId: activeChatId,
          content,
          attachments,
          provider: options?.provider,
          model: options?.model,
          modelOptions: options?.modelOptions,
          permissionMode: options?.permissionMode,
        })
        setCommandError(null)
        return
      } catch (error) {
        setCommandError(error instanceof Error ? error.message : String(error))
        throw error
      }
    }

    const optimisticId = generateUUID()
    const clientTraceId = generateUUID()
    const signature = getUserPromptSignature(content, attachments)
    const optimisticScopeId = activeChatId ?? NEW_CHAT_OPTIMISTIC_SCOPE
    setOptimisticProcessing({
      scopeId: optimisticScopeId,
      ackedAt: null,
    })
    const sendTrace: SendToStartingTrace = {
      traceId: clientTraceId,
      optimisticId,
      startedAt: performance.now(),
      serverChatId: activeChatId,
      routeChatIdAtSend: activeChatId,
      contentPreview: content.slice(0, 80),
    }
    sendToStartingProfilesRef.current.set(clientTraceId, sendTrace)
    logSendToStartingTrace(sendTrace, "handle_send_called", {
      optimisticScopeId,
      attachments: attachments.length,
      contentLength: content.length,
      contentPreview: sendTrace.contentPreview,
    })
    const requiredMatchCount = countMatchingUserPrompts(serverTranscriptEntries, signature)
      + optimisticUserPrompts.filter((prompt) => prompt.scopeId === optimisticScopeId && prompt.signature === signature).length
      + 1

    setOptimisticUserPrompts((current) => [...current, {
      id: optimisticId,
      scopeId: optimisticScopeId,
      signature,
      requiredMatchCount,
      entry: {
        _id: `optimistic:${optimisticId}`,
        kind: "user_prompt",
        content,
        attachments,
        createdAt: Date.now(),
      },
    }])
    logSendToStartingTrace(sendTrace, "optimistic_prompt_added", {
      optimisticId,
      optimisticScopeId,
    })

    try {
      let projectId = projectIdOverride ?? selectedProjectId
        ?? (sidebarReady ? sidebarProjectGroups[0]?.groupKey : null)
      if (!activeChatId && !projectId && fallbackLocalProjectPath) {
        const project = await socket.command<{ projectId: string }>({
          type: "project.open",
          localPath: fallbackLocalProjectPath,
        })
        projectId = project.projectId
        setSelectedProjectId(projectId)
      }

      if (!activeChatId && !projectId) {
        throw new Error("Open a workspace first")
      }

      const result = await socket.command<{ chatId?: string; queued?: boolean }>({
        type: "chat.send",
        chatId: activeChatId ?? undefined,
        projectId: activeChatId ? undefined : projectId ?? undefined,
        clientTraceId,
        provider: options?.provider,
        content,
        attachments,
        model: options?.model,
        modelOptions: options?.modelOptions,
        permissionMode: options?.permissionMode,
      })
      if (result.queued) {
        // The chat was busy, or a stop was requested while this send waited;
        // the server kept the message in the queue instead of starting it.
        setOptimisticUserPrompts((current) => current.filter((prompt) => prompt.id !== optimisticId))
        setOptimisticProcessing(null)
        sendToStartingProfilesRef.current.delete(clientTraceId)
        setCommandError(null)
        return
      }
      sendTrace.ackAt = performance.now()
      sendTrace.serverChatId = result.chatId ?? sendTrace.serverChatId
      setOptimisticProcessing((current) => {
        if (!current) return current
        const nextScopeId = !activeChatId && result.chatId ? result.chatId : current.scopeId
        return {
          scopeId: nextScopeId,
          ackedAt: performance.now(),
        }
      })
      logSendToStartingTrace(sendTrace, "chat_send_ack_received", {
        resultChatId: result.chatId ?? null,
      })

      if (!activeChatId && result.chatId) {
        setOptimisticUserPrompts((current) => current.map((prompt) => (
          prompt.id === optimisticId ? { ...prompt, scopeId: result.chatId! } : prompt
        )))
        const chatPreferences = useChatPreferencesStore.getState()
        chatPreferences.setComposerState(
          result.chatId,
          composerStateFromSendOptions(options) ?? chatPreferences.getComposerState(NEW_CHAT_COMPOSER_ID)
        )
        setPendingChatId(result.chatId)
        navigate(`/chat/${result.chatId}`)
      }
      setCommandError(null)
    } catch (error) {
      setOptimisticUserPrompts((current) => current.filter((prompt) => prompt.id !== optimisticId))
      setOptimisticProcessing(null)
      logSendToStartingTrace(sendTrace, "handle_send_failed", {
        error: error instanceof Error ? error.message : String(error),
      })
      sendToStartingProfilesRef.current.delete(clientTraceId)
      setCommandError(error instanceof Error ? error.message : String(error))
      throw error
    }
  }, [activeChatId, fallbackLocalProjectPath, isProcessing, navigate, optimisticUserPrompts, selectedProjectId, serverTranscriptEntries, sidebarProjectGroups, sidebarReady, socket])

  const handleSteerQueuedMessage = useCallback(async (queuedMessageId: string) => {
    if (!activeChatId) return
    try {
      await socket.command({
        type: "message.steer",
        chatId: activeChatId,
        queuedMessageId,
      })
      setCommandError(null)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [activeChatId, socket])

  const handleRemoveQueuedMessage = useCallback(async (queuedMessageId: string) => {
    if (!activeChatId) return
    try {
      await socket.command({
        type: "message.dequeue",
        chatId: activeChatId,
        queuedMessageId,
      })
      setCommandError(null)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [activeChatId, socket])

  const handleCancel = useCallback(async () => {
    if (!activeChatId) return
    try {
      await socket.command({ type: "chat.cancel", chatId: activeChatId })
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [activeChatId, socket])

  const handleStopDraining = useCallback(async () => {
    if (!activeChatId) return
    try {
      await socket.command({ type: "chat.stopDraining", chatId: activeChatId })
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [activeChatId, socket])

  const handleRenameChat = useCallback(async (chat: SidebarChatRow) => {
    const title = await dialog.prompt({
      title: "Rename Chat",
      initialValue: chat.title,
      confirmLabel: "Rename",
    })
    if (!title || title === chat.title) return
    try {
      await socket.command({ type: "chat.rename", chatId: chat.chatId, title })
      setCommandError(null)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [dialog, socket])

  const handleRenameProject = useCallback(async (projectId: string, sidebarTitle: string | undefined, realTitle: string) => {
    const title = await dialog.prompt({
      title: "Rename Workspace",
      description: "This only changes the sidebar name. The folder path on disk stays the same.",
      initialValue: sidebarTitle ?? "",
      placeholder: realTitle,
      allowEmpty: true,
      resetLabel: "Reset",
      resetValue: "",
      confirmLabel: "Rename",
    })
    if (title === null || title === (sidebarTitle ?? "")) return
    try {
      await socket.command({ type: "project.rename", projectId, title })
      setCommandError(null)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [dialog, socket])

  const handleDeleteChat = useCallback(async (chat: SidebarChatRow) => {
    const confirmed = await dialog.confirm({
      title: "Delete Chat",
      description: `Delete "${chat.title}"? This cannot be undone.`,
      confirmLabel: "Delete",
      confirmVariant: "destructive",
    })
    if (!confirmed) return
    try {
      await socket.command({ type: "chat.delete", chatId: chat.chatId })
      if (chat.chatId === activeChatId) {
        const nextChatId = getNewestRemainingChatId(sidebarProjectGroups, chat.chatId)
        navigate(nextChatId ? `/chat/${nextChatId}` : "/")
      }
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [activeChatId, dialog, navigate, sidebarProjectGroups, socket])

  const runSidebarChatChange = useCallback(async (change: SidebarChatChange) => {
    setSidebarActionError(null)
    return sidebarChatActions.enqueue(change, async () => {
      const controller = new AbortController()
      const timeout = window.setTimeout(() => controller.abort(), 10_000)
      try {
        await socket.command(change.action.type === "pin"
          ? { type: "chat.pin", chatId: change.chatId, pinned: change.action.pinned }
          : { type: "chat.archive", chatId: change.chatId }, { signal: controller.signal })
        sidebarChatActions.settle(change)
        return true
      } catch (error) {
        // Also cancel any unsent local envelope: reconnect must not replay it later.
        controller.abort()
        const isCurrent = sidebarChatActions.isCurrent(change)
        if (error instanceof ConfirmedCommandError) sidebarChatActions.reject(change)
        else sidebarChatActions.settle(change)
        const message = error instanceof Error ? error.message : String(error)
        if (isCurrent) setSidebarActionError(error instanceof ConfirmedCommandError ? message : `Unable to confirm the change. Rechecking sidebar state. ${message}`)
        return false
      } finally {
        window.clearTimeout(timeout)
        setSidebarRefreshEpoch(epoch => epoch + 1)
      }
    })
  }, [sidebarChatActions, socket])

  const handlePinChat = useCallback(async (chat: SidebarChatRow) => {
    const change = sidebarChatActions.begin(chat, "pin")
    if (change) await runSidebarChatChange(change)
  }, [runSidebarChatChange, sidebarChatActions])

  const handleArchiveChat = useCallback(async (chat: SidebarChatRow) => {
    const wasActive = chat.chatId === activeChatIdRef.current
    const nextChatId = wasActive ? getNewestRemainingChatId(sidebarProjectGroups, chat.chatId) : null
    const change = sidebarChatActions.begin(chat, "archive")
    if (!change) return
    if (wasActive) {
      activeChatIdRef.current = nextChatId
      navigate(nextChatId ? `/chat/${nextChatId}` : "/")
    }
    const saved = await runSidebarChatChange(change)
    if (!saved && !sidebarChatActions.has(chat.chatId) && wasActive && activeChatIdRef.current === nextChatId) {
      navigate(`/chat/${chat.chatId}`, { replace: true })
    }
  }, [navigate, runSidebarChatChange, sidebarChatActions, sidebarProjectGroups])

  const handleOpenArchivedChat = useCallback(async (chatId: string) => {
    if (sidebarChatActions.has(chatId)) return
    try {
      setPendingChatId(chatId)
      await socket.command({ type: "chat.unarchive", chatId })
      navigate(`/chat/${chatId}`)
      setCommandError(null)
    } catch (error) {
      setPendingChatId(null)
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [navigate, sidebarChatActions, socket])

  const handleHideProject = useCallback(async (projectId: string) => {
    try {
      await socket.command({ type: "project.remove", projectId })
      useTerminalLayoutStore.getState().clearProject(projectId)
      useRightSidebarStore.getState().clearProject(projectId)
      if (runtime?.projectId === projectId) {
        navigate("/")
      }
      setCommandError(null)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [navigate, runtime?.projectId, socket])

  const handleReorderProjectGroups = useCallback(async (projectIds: string[]) => {
    setOptimisticSidebarProjectOrder(projectIds)
    try {
      await socket.command({ type: "sidebar.reorderProjectGroups", projectIds })
      setCommandError(null)
    } catch (error) {
      setOptimisticSidebarProjectOrder(null)
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [socket])

  const openExternal = useCallback(async (command: {
    action: OpenExternalAction
    localPath: string
    line?: number
    column?: number
  }) => {
    setCommandError(null)
    await socket.command({
      type: "system.openExternal",
      ...command,
    })
  }, [socket])

  const handleOpenExternal = useCallback(async (action: OpenExternalAction) => {
    const localPath = runtime?.localPath
      ?? localProjects?.projects[0]?.localPath
      ?? (sidebarReady ? sidebarProjectGroups[0]?.localPath : undefined)
    if (!localPath) return
    try {
      await openExternal({
        action,
        localPath,
      })
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [localProjects?.projects, openExternal, runtime?.localPath, sidebarProjectGroups, sidebarReady])

  const handleCopyPath = useCallback(async (localPath: string) => {
    try {
      if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
        throw new Error("Clipboard is not available")
      }
      await navigator.clipboard.writeText(localPath)
      setCommandError(null)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  const handleOpenLocalLink = useCallback(async (
    target: OpenLocalLinkTarget,
    action: OpenExternalAction = "open_default",
  ) => {
    try {
      await openExternal({
        action,
        localPath: target.path,
        line: target.line,
        column: target.column,
      })
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [openExternal])

  const handleOpenExternalPath = useCallback(async (action: "open_finder" | "open_default", localPath: string) => {
    try {
      await openExternal({
        action,
        localPath,
      })
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [openExternal])

  const handleExportStandalone = useCallback(async (chatId: string | null | undefined = activeChatId) => {
    if (!chatId || isExportingStandalone) {
      return null
    }

    setIsExportingStandalone(true)
    try {
      const result = await socket.command<StandaloneTranscriptExportCommandResult>({
        type: "chat.exportStandalone",
        chatId,
        theme: resolvedTheme,
        attachmentMode: "bundle",
      })
      setCommandError(null)
      return result
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
      return null
    } finally {
      setIsExportingStandalone(false)
    }
  }, [activeChatId, isExportingStandalone, resolvedTheme, socket])

  const handleShareChat = useCallback(async (chatId: string | null | undefined = activeChatId) => {
    if (!chatId || isExportingStandalone) {
      return
    }

    setStandaloneShareComplete(false)
    const result = await handleExportStandalone(chatId)
    if (result?.ok && result.shareUrl) {
      setStandaloneShareUrl(result.shareUrl)
      setStandaloneShareComplete(true)
      return
    }

    if (result && !result.ok) {
      const shouldDownload = await dialog.confirm({
        title: "Share failed",
        description: result.error,
        confirmLabel: "Download transcript JSON",
        cancelLabel: "Close",
        confirmVariant: "secondary",
      })

      if (shouldDownload) {
        downloadTextFile(result.transcriptFileName, result.transcriptJson)
      }
    }
  }, [activeChatId, dialog, handleExportStandalone, isExportingStandalone])

  const handleCloseStandaloneShareDialog = useCallback(() => {
    setStandaloneShareUrl(null)
    setStandaloneShareComplete(false)
  }, [])

  const handleCopyStandaloneShareLink = useCallback(async () => {
    if (!standaloneShareUrl) {
      return false
    }

    try {
      if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
        throw new Error("Clipboard is not available")
      }
      await navigator.clipboard.writeText(standaloneShareUrl)
      return true
    } catch (error) {
      await dialog.alert({
        title: "Copy failed",
        description: error instanceof Error ? error.message : String(error),
        closeLabel: "Close",
      })
      return false
    }
  }, [dialog, standaloneShareUrl])

  const handleOpenStandaloneShareLink = useCallback(() => {
    if (!standaloneShareUrl) {
      return
    }

    window.open(standaloneShareUrl, "_blank", "noopener,noreferrer")
    setStandaloneShareUrl(null)
  }, [standaloneShareUrl])

  const handleCompose = useCallback(() => {
    navigate("/")
    setSidebarOpen(false)
    setCommandError(null)
  }, [navigate])

  const openSidebar = useCallback(() => setSidebarOpen(true), [])
  const closeSidebar = useCallback(() => setSidebarOpen(false), [])
  const collapseSidebar = useCallback(() => setSidebarCollapsed(true), [setSidebarCollapsed])
  const expandSidebar = useCallback(() => setSidebarCollapsed(false), [setSidebarCollapsed])
  const openAddProjectModal = useCallback(() => setAddProjectModalOpen(true), [])
  const closeAddProjectModal = useCallback(() => setAddProjectModalOpen(false), [])

  const handleListLocalDirectories = useCallback(async (localPath?: string) => {
    return await socket.command<LocalDirectoryListResult>({
      type: "filesystem.listDirectories",
      localPath,
    })
  }, [socket])

  const handleResolveLocalPath = useCallback(async (localPath: string) => {
    return await socket.command<ResolvedLocalPath>({
      type: "filesystem.resolvePath",
      localPath,
    })
  }, [socket])

  const handleAskUserQuestion = useCallback(async (
    toolUseId: string,
    questions: AskUserQuestionItem[],
    answers: AskUserQuestionAnswerMap
  ) => {
    if (!activeChatId) return
    try {
      await socket.command({
        type: "chat.respondTool",
        chatId: activeChatId,
        toolUseId,
        result: { questions, answers },
      })
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [activeChatId, socket])

  const handleAnswerAsyncQuestion = useCallback(async (
    questionKey: string,
    answers: AsyncQuestionAnswerInput[],
    submissionId: string,
  ) => {
    if (!activeChatId) throw new Error("没有活动会话")
    try {
      return await socket.command<AsyncQuestionAnswerResult>({
        type: "chat.answerAsyncQuestion",
        chatId: activeChatId,
        questionKey,
        submissionId,
        answers,
      })
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
      throw error
    }
  }, [activeChatId, socket])

  const handleExitPlanMode = useCallback(async (toolUseId: string, confirmed: boolean, clearContext?: boolean, message?: string) => {
    if (!activeChatId) return
    try {
      await socket.command({
        type: "chat.respondTool",
        chatId: activeChatId,
        toolUseId,
        result: {
          confirmed,
          ...(clearContext ? { clearContext: true } : {}),
          ...(message ? { message } : {}),
        },
      })
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [activeChatId, socket])

  const loadToolDetails = useCallback(async (toolIds: string[]) => {
    if (!activeChatId || toolIds.length === 0) return
    try {
      const result = await socket.command<ChatToolDetails>({
        type: "chat.loadToolDetails",
        chatId: activeChatId,
        toolIds,
      })
      setToolDetailEntries((current) => mergeTranscriptEntries(current, result.messages))
      setCommandError(null)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [activeChatId, socket])

  useEffect(() => {
    setToolDetailEntries([])
  }, [activeChatId])

  return {
    socket,
    activeChatId,
    activeProjectId,
    sidebarData: resolvedSidebarData,
    localProjects,
    defaultProjectId: validDefaultProjectId,
    chatSnapshot,
    keybindings,
    appSettings,
    workspaceCollapsed: appSettings?.workspaceCollapsed ?? sidebarBootstrap.view?.workspaceCollapsed,
    workspaceCollapseVersions: appSettings?.workspaceCollapseVersions ?? sidebarBootstrap.view?.workspaceCollapseVersions ?? {},
    handleWriteWorkspaceCollapsed,
    sidebarWidth,
    setSidebarWidth,
    composerPreferencesReady,
    machineName,
    llmProvider,
    asyncQuestionDelivery,
    connectionStatus,
    sidebarReady,
    sidebarSnapshotStatus,
    localProjectsReady,
    commandError: sidebarActionError ?? commandError,
    startingLocalPath,
    sidebarOpen,
    sidebarCollapsed,
    messages,
    queuedMessages,
    previousPrompt,
    latestToolIds,
    runtime,
    runtimeStatus: effectiveRuntimeStatus,
    isHistoryLoading,
    hasOlderHistory,
    availableProviders,
    asyncQuestionResponses,
    isProcessing,
    canCancel,
    isDraining,
    isExportingStandalone,
    standaloneShareUrl,
    standaloneShareComplete,
    navbarLocalPath,
    hasSelectedProject,
    addProjectModalOpen,
    openSidebar,
    closeSidebar,
    collapseSidebar,
    expandSidebar,
    openAddProjectModal,
    closeAddProjectModal,
    loadOlderHistory,
    loadToolDetails,
    handleCreateChat,
    handleRunQuickCommand,
    quickCommandStarting,
    setDefaultProjectId,
    handleForkChat,
    handleOpenLocalProject,
    handleCreateProject,
    handleListLocalDirectories,
    handleResolveLocalPath,
    handleReadAppSettings,
    handleWriteAppSettings,
    handleReadLlmProvider,
    handleWriteLlmProvider,
    handleValidateLlmProvider,
    handleSignOut,
    handleSend,
    handleSteerQueuedMessage,
    handleRemoveQueuedMessage,
    handleCancel,
    handleStopDraining,
    handleRenameChat,
    handleRenameProject,
    handleShareChat,
    handlePinChat,
    handleArchiveChat,
    handleOpenArchivedChat,
    handleDeleteChat,
    handleHideProject,
    handleReorderProjectGroups,
    handleCopyPath,
    handleOpenExternal,
    handleOpenExternalPath,
    handleOpenLocalLink,
    handleCompose,
    handleAskUserQuestion,
    handleAnswerAsyncQuestion,
    handleExitPlanMode,
    handleExportStandalone,
    handleCloseStandaloneShareDialog,
    handleOpenStandaloneShareLink,
    handleCopyStandaloneShareLink,
  }
}
