import type { ChatDeltaEvent } from "../../shared/protocol"
import type { ChatSnapshot, TranscriptEntry } from "../../shared/types"

export interface ChatStreamState {
  chatId: string
  snapshot: ChatSnapshot | null
  resyncPending: boolean
}

export type ChatStreamResyncReason =
  | "wrong_chat"
  | "invalid_baseline"
  | "missing_baseline"
  | "missing_stream"
  | "revision_mismatch"
  | "sequence_gap"
  | "out_of_order"
  | "impossible_operation"
  | "resync_pending"

export type ChatStreamAction =
  | { type: "snapshot"; snapshot: ChatSnapshot | null }
  | { type: "delta"; event: ChatDeltaEvent }

export type ChatStreamTransition =
  | {
      kind: "baseline"
      state: ChatStreamState
      transcriptChange: "reset"
      transcriptReset: boolean
      evictedEntries: TranscriptEntry[]
      removedIds: string[]
    }
  | {
      kind: "applied"
      state: ChatStreamState
      transcriptChange: "none" | "patch" | "reset"
      transcriptReset: boolean
      evictedEntries: TranscriptEntry[]
      removedIds: string[]
    }
  | {
      kind: "duplicate"
      state: ChatStreamState
      transcriptChange: "none"
      transcriptReset: false
      evictedEntries: TranscriptEntry[]
      removedIds: string[]
    }
  | {
      kind: "resync_required"
      reason: ChatStreamResyncReason
      state: ChatStreamState
      transcriptChange: "none"
      transcriptReset: false
      evictedEntries: TranscriptEntry[]
      removedIds: string[]
    }

interface TranscriptPatchResult {
  messages: TranscriptEntry[]
  evictedEntries: TranscriptEntry[]
  removedIds: string[]
}

const NO_EVICTED_ENTRIES: TranscriptEntry[] = []
const NO_REMOVED_IDS: string[] = []

export function createChatStreamState(chatId: string): ChatStreamState {
  return {
    chatId,
    snapshot: null,
    resyncPending: false,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function isValidSequence(value: number) {
  return Number.isSafeInteger(value) && value >= 0
}

function isTranscriptEntry(value: unknown): value is TranscriptEntry {
  return isRecord(value)
    && typeof value._id === "string"
    && value._id.length > 0
    && typeof value.kind === "string"
    && typeof value.createdAt === "number"
    && Number.isFinite(value.createdAt)
}

function isHistorySnapshot(value: unknown): value is ChatSnapshot["history"] {
  return isRecord(value)
    && typeof value.hasOlder === "boolean"
    && (value.olderCursor === null || typeof value.olderCursor === "string")
    && Number.isSafeInteger(value.recentLimit)
    && (value.recentLimit as number) >= 0
    && typeof value.revision === "string"
}

function isChatRuntime(value: unknown): value is ChatSnapshot["runtime"] {
  return isRecord(value)
    && typeof value.chatId === "string"
    && typeof value.projectId === "string"
    && typeof value.localPath === "string"
    && typeof value.title === "string"
    && (
      value.status === "idle"
      || value.status === "starting"
      || value.status === "running"
      || value.status === "waiting_for_user"
      || value.status === "failed"
    )
    && typeof value.isDraining === "boolean"
    && (value.provider === null || value.provider === "claude" || value.provider === "codex")
    && typeof value.planMode === "boolean"
    && (value.sessionToken === null || typeof value.sessionToken === "string")
}

function isStreamCursor(value: unknown): value is NonNullable<ChatSnapshot["stream"]> {
  return isRecord(value)
    && value.version === 1
    && typeof value.revision === "string"
    && value.revision.length > 0
    && typeof value.sequence === "number"
    && isValidSequence(value.sequence)
}

function isTranscriptDelta(value: unknown): value is NonNullable<ChatDeltaEvent["transcript"]> {
  if (!isRecord(value)) return false
  if (value.type === "patch") {
    return Array.isArray(value.evictedIds)
      && value.evictedIds.every((id) => typeof id === "string")
      && Array.isArray(value.removedIds)
      && value.removedIds.every((id) => typeof id === "string")
      && Array.isArray(value.replaced)
      && value.replaced.every(isTranscriptEntry)
      && Array.isArray(value.appended)
      && value.appended.every(isTranscriptEntry)
  }
  if (value.type === "reset") {
    return Array.isArray(value.messages)
      && value.messages.every(isTranscriptEntry)
      && isHistorySnapshot(value.history)
  }
  return false
}

function isChatDeltaEvent(value: unknown): value is ChatDeltaEvent {
  if (
    !isRecord(value)
    || value.type !== "chat.delta"
    || typeof value.chatId !== "string"
    || typeof value.baseSequence !== "number"
    || !isRecord(value.stream)
    || value.stream.version !== 1
    || typeof value.stream.revision !== "string"
    || typeof value.stream.sequence !== "number"
  ) {
    return false
  }

  if (value.transcript !== undefined && !isTranscriptDelta(value.transcript)) return false
  if (value.runtime !== undefined && !isChatRuntime(value.runtime)) return false
  if (value.queuedMessages !== undefined && !Array.isArray(value.queuedMessages)) return false
  if (value.history !== undefined && !isHistorySnapshot(value.history)) return false
  if (value.availableProviders !== undefined && !Array.isArray(value.availableProviders)) return false
  return true
}

function isChatSnapshot(value: unknown): value is ChatSnapshot {
  return isRecord(value)
    && isChatRuntime(value.runtime)
    && Array.isArray(value.queuedMessages)
    && Array.isArray(value.messages)
    && value.messages.every(isTranscriptEntry)
    && isHistorySnapshot(value.history)
    && Array.isArray(value.availableProviders)
    && (value.stream === undefined || isStreamCursor(value.stream))
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (typeof left !== typeof right || left === null || right === null) return false
  if (typeof left !== "object") return false

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false
    }
    return left.every((value, index) => sameJsonValue(value, right[index]))
  }

  if (!isRecord(left) || !isRecord(right)) return false
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every((key) => (
    Object.prototype.hasOwnProperty.call(right, key)
    && sameJsonValue(left[key], right[key])
  ))
}

function hasUniqueEntryIds(entries: TranscriptEntry[]) {
  const ids = new Set<string>()
  for (const entry of entries) {
    if (ids.has(entry._id)) return false
    ids.add(entry._id)
  }
  return true
}

function requireResync(
  current: ChatStreamState,
  reason: ChatStreamResyncReason,
): ChatStreamTransition {
  return {
    kind: "resync_required",
    reason: current.resyncPending ? "resync_pending" : reason,
    state: current.resyncPending
      ? current
      : {
          ...current,
          resyncPending: true,
        },
    transcriptChange: "none",
    transcriptReset: false,
    evictedEntries: NO_EVICTED_ENTRIES,
    removedIds: NO_REMOVED_IDS,
  }
}

function applySnapshot(
  current: ChatStreamState,
  snapshot: ChatSnapshot | null,
): ChatStreamTransition {
  if (snapshot && !isChatSnapshot(snapshot)) {
    return requireResync(current, "invalid_baseline")
  }

  if (snapshot && snapshot.runtime.chatId !== current.chatId) {
    return requireResync(current, "wrong_chat")
  }

  if (
    snapshot
    && snapshot.stream
    && !hasUniqueEntryIds(snapshot.messages)
  ) {
    return requireResync(current, "invalid_baseline")
  }

  const state = current.snapshot === snapshot && !current.resyncPending
    ? current
    : {
        ...current,
        snapshot,
        resyncPending: false,
      }
  const transcriptReset = Boolean(
    (current.snapshot && !hasUniqueEntryIds(current.snapshot.messages))
    || (snapshot && !hasUniqueEntryIds(snapshot.messages)),
  )

  return {
    kind: "baseline",
    state,
    transcriptChange: "reset",
    transcriptReset,
    evictedEntries: NO_EVICTED_ENTRIES,
    removedIds: NO_REMOVED_IDS,
  }
}

function applyTranscriptPatch(
  messages: TranscriptEntry[],
  patch: Extract<NonNullable<ChatDeltaEvent["transcript"]>, { type: "patch" }>,
): TranscriptPatchResult | null {
  if (
    patch.evictedIds.length === 0
    && patch.removedIds.length === 0
    && patch.replaced.length === 0
    && patch.appended.length === 0
  ) {
    return {
      messages,
      evictedEntries: NO_EVICTED_ENTRIES,
      removedIds: NO_REMOVED_IDS,
    }
  }

  const currentById = new Map<string, TranscriptEntry>()
  for (const entry of messages) {
    if (currentById.has(entry._id)) return null
    currentById.set(entry._id, entry)
  }

  const operationIds = new Set<string>()
  const evictedIds = new Set<string>()
  for (const id of patch.evictedIds) {
    if (
      operationIds.has(id)
      || !currentById.has(id)
    ) {
      return null
    }
    operationIds.add(id)
    evictedIds.add(id)
  }

  const removedIds = new Set<string>()
  for (const id of patch.removedIds) {
    if (operationIds.has(id)) {
      return null
    }
    operationIds.add(id)
    removedIds.add(id)
  }

  const changedReplacements = new Map<string, TranscriptEntry>()
  for (const entry of patch.replaced) {
    if (
      operationIds.has(entry._id)
      || !currentById.has(entry._id)
    ) {
      return null
    }
    operationIds.add(entry._id)
    try {
      if (!sameJsonValue(currentById.get(entry._id), entry)) {
        changedReplacements.set(entry._id, entry)
      }
    } catch {
      return null
    }
  }

  for (const entry of patch.appended) {
    if (
      operationIds.has(entry._id)
      || currentById.has(entry._id)
    ) {
      return null
    }
    operationIds.add(entry._id)
  }

  if (
    evictedIds.size === 0
    && removedIds.size === 0
    && changedReplacements.size === 0
    && patch.appended.length === 0
  ) {
    return {
      messages,
      evictedEntries: NO_EVICTED_ENTRIES,
      removedIds: NO_REMOVED_IDS,
    }
  }

  const nextMessages: TranscriptEntry[] = []
  const evictedEntries: TranscriptEntry[] = []
  for (const entry of messages) {
    if (evictedIds.has(entry._id)) {
      evictedEntries.push(entry)
      continue
    }
    if (removedIds.has(entry._id)) {
      continue
    }
    nextMessages.push(changedReplacements.get(entry._id) ?? entry)
  }
  nextMessages.push(...patch.appended)

  return {
    messages: nextMessages,
    evictedEntries,
    removedIds: patch.removedIds,
  }
}

function applyDelta(
  current: ChatStreamState,
  event: ChatDeltaEvent,
): ChatStreamTransition {
  if (current.resyncPending) {
    return requireResync(current, "resync_pending")
  }

  if (!isChatDeltaEvent(event)) {
    return requireResync(current, "impossible_operation")
  }

  const snapshot = current.snapshot
  if (!snapshot) {
    return requireResync(current, "missing_baseline")
  }

  if (
    event.chatId !== current.chatId
    || snapshot.runtime.chatId !== current.chatId
    || (event.runtime && event.runtime.chatId !== current.chatId)
  ) {
    return requireResync(current, "wrong_chat")
  }

  const currentStream = snapshot.stream
  if (!currentStream) {
    return requireResync(current, "missing_stream")
  }

  if (
    event.stream.version !== currentStream.version
    || event.stream.revision !== currentStream.revision
  ) {
    return requireResync(current, "revision_mismatch")
  }

  if (
    !isValidSequence(event.baseSequence)
    || !isValidSequence(event.stream.sequence)
  ) {
    return requireResync(current, "out_of_order")
  }

  if (
    event.stream.sequence === currentStream.sequence
    && event.baseSequence === currentStream.sequence - 1
  ) {
    return {
      kind: "duplicate",
      state: current,
      transcriptChange: "none",
      transcriptReset: false,
      evictedEntries: NO_EVICTED_ENTRIES,
      removedIds: NO_REMOVED_IDS,
    }
  }

  if (
    event.stream.sequence < currentStream.sequence
    || event.baseSequence < currentStream.sequence
    || event.stream.sequence <= event.baseSequence
  ) {
    return requireResync(current, "out_of_order")
  }

  if (
    event.baseSequence > currentStream.sequence
    || event.stream.sequence > currentStream.sequence + 1
  ) {
    return requireResync(current, "sequence_gap")
  }

  if (
    event.baseSequence !== currentStream.sequence
    || event.stream.sequence !== currentStream.sequence + 1
  ) {
    return requireResync(current, "out_of_order")
  }

  let messages = snapshot.messages
  let history = event.history ?? snapshot.history
  let transcriptChange: "none" | "patch" | "reset" = "none"
  let transcriptReset = false
  let evictedEntries = NO_EVICTED_ENTRIES
  let removedIds = NO_REMOVED_IDS
  if (event.transcript?.type === "reset") {
    if (!hasUniqueEntryIds(event.transcript.messages)) {
      return requireResync(current, "impossible_operation")
    }
    messages = event.transcript.messages
    history = event.transcript.history
    transcriptChange = "reset"
    transcriptReset = true
  } else if (event.transcript?.type === "patch") {
    const patched = applyTranscriptPatch(messages, event.transcript)
    if (!patched) {
      return requireResync(current, "impossible_operation")
    }
    messages = patched.messages
    evictedEntries = patched.evictedEntries
    removedIds = patched.removedIds
    transcriptChange = (
      messages === snapshot.messages
      && removedIds.length === 0
    )
      ? "none"
      : "patch"
  }

  const nextSnapshot: ChatSnapshot = {
    runtime: event.runtime ?? snapshot.runtime,
    queuedMessages: event.queuedMessages ?? snapshot.queuedMessages,
    messages,
    history,
    availableProviders: event.availableProviders ?? snapshot.availableProviders,
    stream: event.stream,
  }

  return {
    kind: "applied",
    state: {
      ...current,
      snapshot: nextSnapshot,
      resyncPending: false,
    },
    transcriptChange,
    transcriptReset,
    evictedEntries,
    removedIds,
  }
}

/**
 * Computes one atomic stream transition. Callers that keep the state in a ref
 * should assign `transition.state` before handling the classification so a
 * second WebSocket frame observes `resyncPending` and the latest sequence
 * synchronously.
 */
export function reduceChatStreamState(
  current: ChatStreamState,
  action: ChatStreamAction,
): ChatStreamTransition {
  return action.type === "snapshot"
    ? applySnapshot(current, action.snapshot)
    : applyDelta(current, action.event)
}

export function applyChatStreamSnapshot(
  current: ChatStreamState,
  snapshot: ChatSnapshot | null,
) {
  return reduceChatStreamState(current, { type: "snapshot", snapshot })
}

export function applyChatStreamDelta(
  current: ChatStreamState,
  event: ChatDeltaEvent,
) {
  return reduceChatStreamState(current, { type: "delta", event })
}
