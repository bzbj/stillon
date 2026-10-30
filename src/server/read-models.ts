import { getSidebarPreviewLimit } from "../shared/sidebar-view"
import process from "node:process"
import type {
  ChatRuntime,
  ChatSnapshot,
  StillOnStatus,
  LocalProjectsSnapshot,
  SidebarChatRow,
  SidebarData,
  SidebarProjectGroup,
  SidebarView,
} from "../shared/types"
import type { ChatRecord, StoreState } from "./events"
import { resolveLocalPath } from "./paths"
import { SERVER_PROVIDERS } from "./provider-catalog"

const SIDEBAR_RECENT_WINDOW_MS = 24 * 60 * 60 * 1_000
const SIDEBAR_FALLBACK_PREVIEW_LIMIT = 5

export function deriveStatus(chat: ChatRecord, activeStatus?: StillOnStatus): StillOnStatus {
  if (activeStatus) return activeStatus
  if (chat.lastTurnOutcome === "failed") return "failed"
  return "idle"
}

function getSidebarChatSortTimestamp(chat: ChatRecord) {
  return chat.lastMessageAt ?? chat.createdAt
}

function canForkChat(
  chat: ChatRecord,
  activeStatuses: Map<string, StillOnStatus>,
  drainingChatIds: Set<string>,
) {
  if (!chat.provider) return false
  if (!chat.sessionToken && !chat.pendingForkSessionToken) return false
  if (activeStatuses.has(chat.id)) return false
  if (drainingChatIds.has(chat.id)) return false
  return true
}

function getSidebarChatTimestamp(chat: Pick<SidebarChatRow, "lastMessageAt" | "_creationTime">) {
  return chat.lastMessageAt ?? chat._creationTime
}

function isSidebarChatRecent(chat: Pick<SidebarChatRow, "lastMessageAt" | "_creationTime">, nowMs: number) {
  return Math.max(0, nowMs - getSidebarChatTimestamp(chat)) < SIDEBAR_RECENT_WINDOW_MS
}

function getSidebarChatBuckets(chats: SidebarChatRow[], nowMs: number) {
  const recentChats = chats.filter((chat) => chat.pinned || isSidebarChatRecent(chat, nowMs))
  const previewChats = recentChats.length > 0
    ? recentChats
    : chats.slice(0, Math.min(SIDEBAR_FALLBACK_PREVIEW_LIMIT, chats.length))
  const previewChatIds = new Set(previewChats.map((chat) => chat.chatId))

  return {
    previewChats,
    olderChats: chats.filter((chat) => !previewChatIds.has(chat.chatId)),
  }
}

export function deriveSidebarData(
  state: StoreState,
  activeStatuses: Map<string, StillOnStatus>,
  options?: {
    nowMs?: number
    sidebarProjectOrder?: string[]
    drainingChatIds?: Set<string>
    view?: SidebarView
  }
): SidebarData {
  const nowMs = options?.nowMs ?? Date.now()
  const drainingChatIds = options?.drainingChatIds ?? new Set<string>()
  const chatsByProjectId = new Map<string, ChatRecord[]>()
  const archivedChatsByProjectId = new Map<string, ChatRecord[]>()
  for (const chat of state.chatsById.values()) {
    if (chat.deletedAt) continue
    const targetMap = chat.archivedAt ? archivedChatsByProjectId : chatsByProjectId
    const projectChats = targetMap.get(chat.projectId)
    if (projectChats) {
      projectChats.push(chat)
      continue
    }
    targetMap.set(chat.projectId, [chat])
  }

  const allProjects = [...state.projectsById.values()]
    .filter((project) => !project.deletedAt)
  const unorderedProjects = allProjects
    .sort((a, b) => b.updatedAt - a.updatedAt)
  const projectById = new Map(unorderedProjects.map((project) => [project.id, project]))
  const orderedProjects = (options?.sidebarProjectOrder ?? [])
    .map((projectId) => projectById.get(projectId))
    .filter((project): project is NonNullable<typeof project> => Boolean(project))
  const orderedProjectIds = new Set(orderedProjects.map((project) => project.id))
  const projects = [
    ...orderedProjects,
    ...unorderedProjects.filter((project) => !orderedProjectIds.has(project.id)),
  ]

  function toSidebarChatRows(project: NonNullable<typeof projects[number]>, projectChats: ChatRecord[]) {
    return projectChats
      .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || getSidebarChatSortTimestamp(b) - getSidebarChatSortTimestamp(a))
      .map((chat) => ({
        _id: chat.id,
        _creationTime: chat.createdAt,
        chatId: chat.id,
        title: chat.title,
        pinned: chat.pinned,
        status: deriveStatus(chat, activeStatuses.get(chat.id)),
        unread: chat.unread,
        localPath: project.localPath,
        provider: chat.provider,
        lastMessageAt: chat.lastMessageAt,
        hasAutomation: false,
        canFork: canForkChat(chat, activeStatuses, drainingChatIds) || undefined,
      }))
  }

  const view = options?.view
  const limits = new Map(view?.groups.map(group => [group.groupKey, group.limit]))
  const query = view?.search?.toLocaleLowerCase()
  let searchRemaining = view?.searchLimit ?? 50
  let searchHasMore = false
  const projectGroups: SidebarProjectGroup[] = projects.map((project) => {
    const records = chatsByProjectId.get(project.id) ?? []
    const archivedRecords = archivedChatsByProjectId.get(project.id) ?? []
    const previewLimit = view?.previewVersion === 1 ? getSidebarPreviewLimit(records) : undefined
    const limit = Math.max(limits.get(project.id) ?? 0, previewLimit ?? 0)
    const archivedLimit = view?.archived?.groupKey === project.id ? view.archived.limit : 0
    // Preload only the base preview. Larger windows still require explicit intent.
    const defaultCollapsed = records.every(chat => !chat.pinned && Math.max(0, nowMs - getSidebarChatSortTimestamp(chat)) >= SIDEBAR_RECENT_WINDOW_MS)
    let selected = records
    if (view) {
      selected = limit > 0
        ? [...records].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || getSidebarChatSortTimestamp(b) - getSidebarChatSortTimestamp(a)).slice(0, limit)
        : []
      const selectedIds = new Set(selected.map(chat => chat.id))
      // Direct links select one old conversation without downloading preceding history.
      const active = view.previewVersion !== 1 && limit > 0 && view.activeChatId ? records.find(chat => chat.id === view.activeChatId) : undefined
      if (active && !selectedIds.has(active.id)) { selected = [...selected, active]; selectedIds.add(active.id) }
      if (query) {
        const matches = records.filter(chat => !selectedIds.has(chat.id) && `${chat.title} ${project.sidebarTitle ?? project.title}`.toLocaleLowerCase().includes(query))
        searchHasMore ||= matches.length > searchRemaining
        const visibleMatches = matches.slice(0, searchRemaining)
        searchRemaining -= visibleMatches.length
        selected = [...selected, ...visibleMatches]
      }
    }
    const chats = toSidebarChatRows(project, selected)
    const archivedChats = toSidebarChatRows(project, view ? archivedLimit > 0
      ? [...archivedRecords].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || getSidebarChatSortTimestamp(b) - getSidebarChatSortTimestamp(a)).slice(0, archivedLimit)
      : [] : archivedRecords)
    const buckets = view
      ? { previewChats: chats.slice(0, previewLimit ?? SIDEBAR_FALLBACK_PREVIEW_LIMIT), olderChats: chats.slice(previewLimit ?? SIDEBAR_FALLBACK_PREVIEW_LIMIT) }
      : getSidebarChatBuckets(chats, nowMs)
    const activeChatId = view?.activeChatId && records.some(chat => chat.id === view.activeChatId) ? view.activeChatId : undefined
    const statuses = view ? records.map(chat => ({ chat, status: deriveStatus(chat, activeStatuses.get(chat.id)) })) : []
    return {
      groupKey: project.id,
      title: project.sidebarTitle ?? project.title,
      realTitle: project.title,
      ...(project.sidebarTitle ? { sidebarTitle: project.sidebarTitle } : {}),
      localPath: project.localPath,
      chats, ...buckets,
      ...(archivedChats.length ? { archivedChats } : {}),
      defaultCollapsed,
      ...(view ? {
        lastActivityAt: records.reduce((latest, chat) => Math.max(latest, getSidebarChatSortTimestamp(chat)), 0),
        ...(activeChatId ? { activeChatId } : {}),
        chatPage: { ...(previewLimit !== undefined ? { previewLimit } : {}), limit, total: records.length, hasMore: records.length > limit, archivedLimit, archivedTotal: archivedRecords.length },
        activity: {
          working: statuses.some(({ status }) => ["starting", "running", "stopping"].includes(status)),
          unreadResult: statuses.some(({ chat, status }) => chat.unread && status === "idle"),
          attention: statuses.some(({ chat, status }) => ["waiting_for_user", "stop_failed"].includes(status) || (status === "failed" && chat.unread)),
          unreadCount: records.filter(chat => chat.unread).length,
          waitingChatIds: statuses.filter(({ status }) => status === "waiting_for_user").map(({ chat }) => chat.id),
        },
      } : {}),
    }
  })

  return { projectGroups, ...(view ? { lazyVersion: 1 as const, ...(view.previewVersion === 1 ? { previewVersion: 1 as const } : {}), ...(view.search ? { search: view.search, searchLimit: view.searchLimit ?? 50, searchHasMore } : {}),
    ...(view.activeChatId ? { activeChat: { chatId: view.activeChatId, projectId: projectGroups.find(group => group.activeChatId)?.groupKey ?? null } } : {}) } : {}) }

}

export function deriveLocalProjectsSnapshot(
  state: StoreState,
  discoveredProjects: Array<{ localPath: string; title: string; modifiedAt: number }>,
  machineName: string
): LocalProjectsSnapshot {
  const projects = new Map<string, LocalProjectsSnapshot["projects"][number]>()

  for (const project of discoveredProjects) {
    const normalizedPath = resolveLocalPath(project.localPath)
    projects.set(normalizedPath, {
      localPath: normalizedPath,
      title: project.title,
      source: "discovered",
      lastOpenedAt: project.modifiedAt,
      chatCount: 0,
    })
  }

  for (const project of [...state.projectsById.values()].filter((entry) => !entry.deletedAt)) {
    const chats = [...state.chatsById.values()].filter((chat) => chat.projectId === project.id && !chat.deletedAt && !chat.archivedAt)
    const lastOpenedAt = chats.reduce(
      (latest, chat) => Math.max(latest, getSidebarChatSortTimestamp(chat)),
      project.updatedAt
    )

    projects.set(project.localPath, {
      localPath: project.localPath,
      title: project.title,
      source: "saved",
      lastOpenedAt,
      chatCount: chats.length,
    })
  }

  return {
    machine: {
      id: "local",
      displayName: machineName,
      platform: process.platform,
    },
    projects: [...projects.values()].sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0)),
  }
}

export function deriveChatSnapshot(
  state: StoreState,
  activeStatuses: Map<string, StillOnStatus>,
  drainingChatIds: Set<string>,
  chatId: string,
  getMessages: (chatId: string) => Pick<ChatSnapshot, "messages" | "history">,
  steeringQueuedMessageId: string | null = null,
  asyncQuestionResponses: ChatSnapshot["asyncQuestionResponses"] = [],
  runId?: string | null,
): ChatSnapshot | null {
  const chat = state.chatsById.get(chatId)
  if (!chat || chat.deletedAt) return null
  const project = state.projectsById.get(chat.projectId)
  if (!project || project.deletedAt) return null

  const runtime: ChatRuntime = {
    ...(runId !== undefined ? { runId } : {}),
    chatId: chat.id,
    projectId: project.id,
    localPath: project.localPath,
    title: chat.title,
    status: deriveStatus(chat, activeStatuses.get(chat.id)),
    isDraining: drainingChatIds.has(chat.id),
    provider: chat.provider,
    lastTurnPreferences: chat.lastTurnPreferences ?? null,
    planMode: chat.planMode,
    sessionToken: chat.sessionToken,
    codexTransport: chat.codexTransport ?? (chat.provider === "codex" && (chat.sessionToken || chat.lastTurnOutcome) ? "exec" : null),
  }

  const transcript = getMessages(chat.id)

  return {
    runtime,
    queuedMessages: (state.queuedMessagesByChatId.get(chat.id) ?? []).map((entry) => ({
      ...entry,
      attachments: [...entry.attachments],
      ...(entry.id === steeringQueuedMessageId ? { sendingNow: true } : {}),
    })),
    messages: transcript.messages,
    history: transcript.history,
    availableProviders: [...SERVER_PROVIDERS],
    asyncQuestionResponses: asyncQuestionResponses.map((entry) => ({ ...entry })),
  }
}
