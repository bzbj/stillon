import type { AgentProvider, SidebarChatRow, SidebarData, SidebarProjectGroup } from "../../shared/types"
import { normalizeMachineIdentityName } from "./machineIdentity"
import { getSidebarChatBuckets, shouldDefaultCollapseSidebarProject } from "./sidebarChats"

const SIDEBAR_SNAPSHOT_STORAGE_PREFIX = "stillon:sidebar-snapshot:v1:"
const SIDEBAR_SNAPSHOT_VERSION = 1
const MAX_PROJECT_GROUPS = 200
const MAX_CHAT_ROWS_PER_GROUP = 1_000
const MAX_TOTAL_CHAT_ROWS = 5_000
const MAX_ID_LENGTH = 512
const MAX_TITLE_LENGTH = 1_000
const MAX_PATH_LENGTH = 8_192
const MAX_ORIGIN_LENGTH = 2_048
const MAX_AUTH_SCOPE_LENGTH = 512
const MAX_MACHINE_NAME_LENGTH = 512
const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1_000

export const SIDEBAR_SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000
export const SIDEBAR_SNAPSHOT_MAX_BYTES = 512 * 1_024

export interface SidebarSnapshotIdentity {
  origin: string
  authScope: string
  machineName: string
}

export interface SidebarSnapshotScope {
  origin: string
  authScope: string
}

export interface SidebarSnapshotStorage {
  readonly length?: number
  getItem(key: string): string | null
  key?(index: number): string | null
  removeItem(key: string): void
  setItem(key: string, value: string): void
}

export interface LoadedSidebarSnapshot {
  data: SidebarData
  savedAt: number
}

interface StoredSidebarChat {
  chatId: string
  title: string
  createdAt: number
  unread: boolean
  provider: AgentProvider | null
  lastMessageAt?: number
}

interface StoredSidebarProject {
  groupKey: string
  title: string
  realTitle: string
  sidebarTitle?: string
  localPath: string
  chats: StoredSidebarChat[]
}

interface StoredSidebarSnapshot {
  version: typeof SIDEBAR_SNAPSHOT_VERSION
  savedAt: number
  identity: SidebarSnapshotIdentity
  data: {
    projectGroups: StoredSidebarProject[]
  }
}

const SNAPSHOT_KEYS = new Set(["version", "savedAt", "identity", "data"])
const IDENTITY_KEYS = new Set(["origin", "authScope", "machineName"])
const DATA_KEYS = new Set(["projectGroups"])
const PROJECT_KEYS = new Set(["groupKey", "title", "realTitle", "sidebarTitle", "localPath", "chats"])
const CHAT_KEYS = new Set(["chatId", "title", "createdAt", "unread", "provider", "lastMessageAt"])
const VALID_PROVIDERS = new Set<AgentProvider>(["claude", "codex"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: Set<string>) {
  return Object.keys(value).every((key) => allowedKeys.has(key))
}

function isBoundedString(value: unknown, maxLength: number, allowEmpty = false): value is string {
  return typeof value === "string"
    && value.length <= maxLength
    && (allowEmpty || value.length > 0)
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function getSerializedByteLength(value: string) {
  return new TextEncoder().encode(value).byteLength
}

function normalizeOrigin(value: unknown): string | null {
  if (!isBoundedString(value, MAX_ORIGIN_LENGTH)) return null

  try {
    const url = new URL(value)
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    return url.origin
  } catch {
    return null
  }
}

function normalizeAuthScope(value: unknown): string | null {
  if (typeof value !== "string") return null
  const normalized = value.trim()
  if (!normalized || normalized.length > MAX_AUTH_SCOPE_LENGTH) return null
  return normalized
}

export function createSidebarSnapshotScope(params: {
  origin: unknown
  authScope: unknown
}): SidebarSnapshotScope | null {
  const origin = normalizeOrigin(params.origin)
  const authScope = normalizeAuthScope(params.authScope)
  if (!origin || !authScope) return null
  return { origin, authScope }
}

export function createSidebarSnapshotIdentity(params: {
  origin: unknown
  authScope: unknown
  machineName: unknown
}): SidebarSnapshotIdentity | null {
  const scope = createSidebarSnapshotScope(params)
  const machineName = normalizeMachineIdentityName(params.machineName)
  if (!scope || !machineName || machineName.length > MAX_MACHINE_NAME_LENGTH) return null
  return { ...scope, machineName }
}

function encodeKeyPart(value: string) {
  return encodeURIComponent(value)
}

function getScopeStoragePrefix(scope: SidebarSnapshotScope) {
  return `${SIDEBAR_SNAPSHOT_STORAGE_PREFIX}${encodeKeyPart(scope.origin)}:${encodeKeyPart(scope.authScope)}:`
}

export function getSidebarSnapshotStorageKey(identity: SidebarSnapshotIdentity) {
  return `${getScopeStoragePrefix(identity)}${encodeKeyPart(identity.machineName)}`
}

function sameIdentity(left: SidebarSnapshotIdentity, right: SidebarSnapshotIdentity) {
  return left.origin === right.origin
    && left.authScope === right.authScope
    && left.machineName === right.machineName
}

function toStoredChat(value: SidebarChatRow): StoredSidebarChat | null {
  if (!isBoundedString(value.chatId, MAX_ID_LENGTH)) return null
  if (!isBoundedString(value.title, MAX_TITLE_LENGTH, true)) return null
  if (!isTimestamp(value._creationTime)) return null
  if (typeof value.unread !== "boolean") return null
  if (value.provider !== null && !VALID_PROVIDERS.has(value.provider)) return null
  if (value.lastMessageAt !== undefined && !isTimestamp(value.lastMessageAt)) return null

  return {
    chatId: value.chatId,
    title: value.title,
    createdAt: value._creationTime,
    unread: value.unread,
    provider: value.provider,
    ...(value.lastMessageAt === undefined ? {} : { lastMessageAt: value.lastMessageAt }),
  }
}

function toStoredSnapshot(
  identity: SidebarSnapshotIdentity,
  data: SidebarData,
  savedAt: number
): StoredSidebarSnapshot | null {
  if (!isTimestamp(savedAt)) return null
  if (!Array.isArray(data.projectGroups) || data.projectGroups.length > MAX_PROJECT_GROUPS) return null

  const projectIds = new Set<string>()
  const chatIds = new Set<string>()
  let totalChatRows = 0
  const projectGroups: StoredSidebarProject[] = []

  for (const group of data.projectGroups) {
    if (!isBoundedString(group.groupKey, MAX_ID_LENGTH) || projectIds.has(group.groupKey)) return null
    if (!isBoundedString(group.title, MAX_TITLE_LENGTH, true)) return null
    if (!isBoundedString(group.realTitle, MAX_TITLE_LENGTH, true)) return null
    if (group.sidebarTitle !== undefined && !isBoundedString(group.sidebarTitle, MAX_TITLE_LENGTH, true)) return null
    if (!isBoundedString(group.localPath, MAX_PATH_LENGTH)) return null
    if (!Array.isArray(group.chats) || group.chats.length > MAX_CHAT_ROWS_PER_GROUP) return null

    projectIds.add(group.groupKey)
    totalChatRows += group.chats.length
    if (totalChatRows > MAX_TOTAL_CHAT_ROWS) return null

    const chats: StoredSidebarChat[] = []
    for (const chat of group.chats) {
      const storedChat = toStoredChat(chat)
      if (!storedChat || chatIds.has(storedChat.chatId)) return null
      chatIds.add(storedChat.chatId)
      chats.push(storedChat)
    }

    projectGroups.push({
      groupKey: group.groupKey,
      title: group.title,
      realTitle: group.realTitle,
      ...(group.sidebarTitle === undefined ? {} : { sidebarTitle: group.sidebarTitle }),
      localPath: group.localPath,
      chats,
    })
  }

  return {
    version: SIDEBAR_SNAPSHOT_VERSION,
    savedAt,
    identity,
    data: { projectGroups },
  }
}

function parseStoredIdentity(value: unknown): SidebarSnapshotIdentity | null {
  if (!isRecord(value) || !hasOnlyKeys(value, IDENTITY_KEYS)) return null
  return createSidebarSnapshotIdentity({
    origin: value.origin,
    authScope: value.authScope,
    machineName: value.machineName,
  })
}

function parseStoredChat(value: unknown): StoredSidebarChat | null {
  if (!isRecord(value) || !hasOnlyKeys(value, CHAT_KEYS)) return null
  if (!isBoundedString(value.chatId, MAX_ID_LENGTH)) return null
  if (!isBoundedString(value.title, MAX_TITLE_LENGTH, true)) return null
  if (!isTimestamp(value.createdAt)) return null
  if (typeof value.unread !== "boolean") return null
  if (value.provider !== null && !VALID_PROVIDERS.has(value.provider as AgentProvider)) return null
  if (value.lastMessageAt !== undefined && !isTimestamp(value.lastMessageAt)) return null

  return {
    chatId: value.chatId,
    title: value.title,
    createdAt: value.createdAt,
    unread: value.unread,
    provider: value.provider as AgentProvider | null,
    ...(value.lastMessageAt === undefined ? {} : { lastMessageAt: value.lastMessageAt }),
  }
}

function parseStoredProject(
  value: unknown,
  projectIds: Set<string>,
  chatIds: Set<string>
): StoredSidebarProject | null {
  if (!isRecord(value) || !hasOnlyKeys(value, PROJECT_KEYS)) return null
  if (!isBoundedString(value.groupKey, MAX_ID_LENGTH) || projectIds.has(value.groupKey)) return null
  if (!isBoundedString(value.title, MAX_TITLE_LENGTH, true)) return null
  if (!isBoundedString(value.realTitle, MAX_TITLE_LENGTH, true)) return null
  if (value.sidebarTitle !== undefined && !isBoundedString(value.sidebarTitle, MAX_TITLE_LENGTH, true)) return null
  if (!isBoundedString(value.localPath, MAX_PATH_LENGTH)) return null
  if (!Array.isArray(value.chats) || value.chats.length > MAX_CHAT_ROWS_PER_GROUP) return null

  projectIds.add(value.groupKey)
  const chats: StoredSidebarChat[] = []
  for (const chatValue of value.chats) {
    const chat = parseStoredChat(chatValue)
    if (!chat || chatIds.has(chat.chatId)) return null
    chatIds.add(chat.chatId)
    chats.push(chat)
  }

  return {
    groupKey: value.groupKey,
    title: value.title,
    realTitle: value.realTitle,
    ...(value.sidebarTitle === undefined ? {} : { sidebarTitle: value.sidebarTitle }),
    localPath: value.localPath,
    chats,
  }
}

function parseStoredSnapshot(
  value: unknown,
  expectedIdentity: SidebarSnapshotIdentity,
  nowMs: number
): StoredSidebarSnapshot | null {
  if (!isRecord(value) || !hasOnlyKeys(value, SNAPSHOT_KEYS)) return null
  if (value.version !== SIDEBAR_SNAPSHOT_VERSION) return null
  if (!isTimestamp(value.savedAt)) return null
  if (value.savedAt > nowMs + MAX_FUTURE_CLOCK_SKEW_MS) return null
  if (nowMs - value.savedAt > SIDEBAR_SNAPSHOT_MAX_AGE_MS) return null

  const identity = parseStoredIdentity(value.identity)
  if (!identity || !sameIdentity(identity, expectedIdentity)) return null
  if (!isRecord(value.data) || !hasOnlyKeys(value.data, DATA_KEYS)) return null
  if (!Array.isArray(value.data.projectGroups) || value.data.projectGroups.length > MAX_PROJECT_GROUPS) return null

  const projectIds = new Set<string>()
  const chatIds = new Set<string>()
  const projectGroups: StoredSidebarProject[] = []
  let totalChatRows = 0

  for (const projectValue of value.data.projectGroups) {
    const project = parseStoredProject(projectValue, projectIds, chatIds)
    if (!project) return null
    totalChatRows += project.chats.length
    if (totalChatRows > MAX_TOTAL_CHAT_ROWS) return null
    projectGroups.push(project)
  }

  return {
    version: SIDEBAR_SNAPSHOT_VERSION,
    savedAt: value.savedAt,
    identity,
    data: { projectGroups },
  }
}

function hydrateProject(group: StoredSidebarProject, nowMs: number): SidebarProjectGroup {
  const chats: SidebarChatRow[] = group.chats.map((chat) => ({
    _id: chat.chatId,
    _creationTime: chat.createdAt,
    chatId: chat.chatId,
    title: chat.title,
    status: "idle",
    unread: chat.unread,
    localPath: group.localPath,
    provider: chat.provider,
    ...(chat.lastMessageAt === undefined ? {} : { lastMessageAt: chat.lastMessageAt }),
    hasAutomation: false,
  }))
  const { collapsedChats, remainingChats } = getSidebarChatBuckets(chats, nowMs)

  return {
    groupKey: group.groupKey,
    title: group.title,
    realTitle: group.realTitle,
    ...(group.sidebarTitle === undefined ? {} : { sidebarTitle: group.sidebarTitle }),
    localPath: group.localPath,
    chats,
    previewChats: collapsedChats,
    olderChats: remainingChats,
    defaultCollapsed: shouldDefaultCollapseSidebarProject(chats, nowMs),
  }
}

function removeInvalidSnapshot(storage: SidebarSnapshotStorage, key: string) {
  try {
    storage.removeItem(key)
  } catch {
    // Browser storage is an optional performance cache.
  }
}

export function loadSidebarSnapshot(
  identity: SidebarSnapshotIdentity,
  storage: SidebarSnapshotStorage | null | undefined,
  nowMs = Date.now()
): LoadedSidebarSnapshot | null {
  if (!storage || !isTimestamp(nowMs)) return null
  const key = getSidebarSnapshotStorageKey(identity)

  try {
    const serialized = storage.getItem(key)
    if (!serialized) return null
    if (getSerializedByteLength(serialized) > SIDEBAR_SNAPSHOT_MAX_BYTES) {
      removeInvalidSnapshot(storage, key)
      return null
    }

    const snapshot = parseStoredSnapshot(JSON.parse(serialized), identity, nowMs)
    if (!snapshot) {
      removeInvalidSnapshot(storage, key)
      return null
    }

    return {
      savedAt: snapshot.savedAt,
      data: {
        projectGroups: snapshot.data.projectGroups.map((group) => hydrateProject(group, nowMs)),
      },
    }
  } catch {
    removeInvalidSnapshot(storage, key)
    return null
  }
}

export function persistSidebarSnapshot(
  identity: SidebarSnapshotIdentity,
  data: SidebarData,
  storage: SidebarSnapshotStorage | null | undefined,
  savedAt = Date.now()
) {
  if (!storage) return false
  const key = getSidebarSnapshotStorageKey(identity)

  try {
    const snapshot = toStoredSnapshot(identity, data, savedAt)
    if (!snapshot) {
      removeInvalidSnapshot(storage, key)
      return false
    }
    const serialized = JSON.stringify(snapshot)
    if (getSerializedByteLength(serialized) > SIDEBAR_SNAPSHOT_MAX_BYTES) {
      removeInvalidSnapshot(storage, key)
      return false
    }
    storage.setItem(key, serialized)
    return true
  } catch {
    return false
  }
}

export function removeSidebarSnapshot(
  identity: SidebarSnapshotIdentity | null | undefined,
  storage: SidebarSnapshotStorage | null | undefined
) {
  if (!identity || !storage) return
  removeInvalidSnapshot(storage, getSidebarSnapshotStorageKey(identity))
}

export function clearSidebarSnapshotsForScope(
  scope: SidebarSnapshotScope | null | undefined,
  storage: SidebarSnapshotStorage | null | undefined
) {
  if (!scope || !storage || typeof storage.length !== "number" || typeof storage.key !== "function") return
  const prefix = getScopeStoragePrefix(scope)

  try {
    const keys: string[] = []
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (key?.startsWith(prefix)) keys.push(key)
    }
    for (const key of keys) {
      storage.removeItem(key)
    }
  } catch {
    // Cache cleanup is best effort; the auth scope still makes old entries inaccessible.
  }
}

export function getBrowserSidebarSnapshotStorage(): SidebarSnapshotStorage | null {
  if (typeof window === "undefined") return null

  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function getBrowserSidebarSnapshotOrigin() {
  if (typeof window === "undefined") return null

  try {
    return window.location.origin
  } catch {
    return null
  }
}
