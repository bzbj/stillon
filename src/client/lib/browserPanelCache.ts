import type { LocalHttpServerInfo, ProjectQuickAction } from "../../shared/protocol"
import type { KannaSocket } from "../app/socket"

let localHttpServersCache: LocalHttpServerInfo[] | null = null
let localHttpServersRequest: Promise<LocalHttpServerInfo[]> | null = null

const quickActionsCacheByProjectId = new Map<string, ProjectQuickAction[]>()
const quickActionsRequestByProjectId = new Map<string, Promise<ProjectQuickAction[]>>()

function visibleLocalHttpServers(servers: LocalHttpServerInfo[]) {
  return servers.filter((server) => server.status >= 200 && server.status < 400)
}

export function getCachedLocalHttpServers() {
  return localHttpServersCache
}

export function refreshCachedLocalHttpServers(socket: KannaSocket, projectId?: string) {
  if (localHttpServersRequest) return localHttpServersRequest

  localHttpServersRequest = socket.command<LocalHttpServerInfo[]>({
    type: "browser.listLocalHttpServers",
    projectId,
  }).then((servers) => {
    const visibleServers = visibleLocalHttpServers(servers)
    localHttpServersCache = visibleServers
    return visibleServers
  }).finally(() => {
    localHttpServersRequest = null
  })

  return localHttpServersRequest
}

export function removeCachedLocalHttpServer(port: number) {
  const nextServers = (localHttpServersCache ?? []).filter((server) => server.port !== port)
  localHttpServersCache = nextServers
  return nextServers
}

export function getCachedProjectQuickActions(projectId: string) {
  return quickActionsCacheByProjectId.get(projectId)
}

export function refreshCachedProjectQuickActions(socket: KannaSocket, projectId: string) {
  const existingRequest = quickActionsRequestByProjectId.get(projectId)
  if (existingRequest) return existingRequest

  const request = socket.command<ProjectQuickAction[]>({
    type: "project.readQuickActions",
    projectId,
  }).then((actions) => {
    quickActionsCacheByProjectId.set(projectId, actions)
    return actions
  }).finally(() => {
    quickActionsRequestByProjectId.delete(projectId)
  })

  quickActionsRequestByProjectId.set(projectId, request)
  return request
}

export function writeCachedProjectQuickActions(socket: KannaSocket, projectId: string, actions: ProjectQuickAction[]) {
  quickActionsCacheByProjectId.set(projectId, actions)
  return socket.command<ProjectQuickAction[]>({
    type: "project.writeQuickActions",
    projectId,
    quickActions: actions,
  }).then((savedActions) => {
    quickActionsCacheByProjectId.set(projectId, savedActions)
    return savedActions
  })
}
