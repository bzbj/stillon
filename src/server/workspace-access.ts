import type { ClientCommand, SubscriptionTopic } from "../shared/protocol"
import type { StoreState } from "./events"
import type { TerminalManager } from "./terminal-manager"

export function workspaceState(state: StoreState, workspaceId: string): StoreState {
  const project = state.projectsById.get(workspaceId)
  const chats = new Map([...state.chatsById].filter(([, chat]) => chat.projectId === workspaceId))
  return { projectsById: new Map(project ? [[workspaceId, project]] : []), projectIdsByPath: new Map(project ? [[project.localPath, workspaceId]] : []),
    chatsById: chats, queuedMessagesByChatId: new Map([...state.queuedMessagesByChatId].filter(([id]) => chats.has(id))) }
}
export function workspaceTopicAllowed(topic: SubscriptionTopic, workspaceId: string, state: StoreState, terminals: TerminalManager) {
  if (["sidebar", "local-projects", "keybindings", "app-settings", "codex-model-policy", "claude-model-policy"].includes(topic.type)) return true
  if (topic.type === "chat") return state.chatsById.get(topic.chatId)?.projectId === workspaceId
  if (topic.type === "terminal") return terminals.getSnapshot(topic.terminalId)?.cwd === state.projectsById.get(workspaceId)?.localPath
  return false
}
export function workspaceCommandAllowed(command: ClientCommand, workspaceId: string, state: StoreState, terminals: TerminalManager) {
  if (!state.projectsById.get(workspaceId) || state.projectsById.get(workspaceId)?.deletedAt) return false
  const chatAllowed = (id: unknown) => typeof id === "string" && state.chatsById.get(id)?.projectId === workspaceId
  if (command.type === "system.ping" || ["settings.readKeybindings", "settings.readAppSettings", "settings.readCodexModelPolicy", "settings.readClaudeModelPolicy"].includes(command.type)) return true
  if (command.type === "chat.setDraftProtection") return Array.isArray(command.chatIds) && command.chatIds.every(chatAllowed)
  if (command.type === "settings.writeAppSettingsPatch") {
    const patch = command.patch
    return Object.keys(patch).every(k => k === "workspaceCollapsed" || k === "workspaceCollapseExpectedVersions") && Object.keys(patch.workspaceCollapsed ?? {}).every(id => id === workspaceId)
      && Object.keys(patch.workspaceCollapseExpectedVersions ?? {}).every(id => id === workspaceId)
  }
  if (command.type === "chat.create" || command.type === "chat.startQuickCommand" || command.type === "project.readQuickActions" || command.type === "project.writeQuickActions") return command.projectId === workspaceId
  if (command.type === "chat.send") return (command.chatId ? chatAllowed(command.chatId) : command.projectId === workspaceId)
    && (!command.projectId || command.projectId === workspaceId)
  if (command.type.startsWith("chat.") || command.type.startsWith("message.")) return "chatId" in command && chatAllowed(command.chatId)
  if (command.type === "terminal.create") return command.projectId === workspaceId && (!terminals.getSnapshot(command.terminalId) || terminals.getSnapshot(command.terminalId)?.cwd === state.projectsById.get(workspaceId)?.localPath)
  if (command.type.startsWith("terminal.")) return "terminalId" in command && terminals.getSnapshot(command.terminalId)?.cwd === state.projectsById.get(workspaceId)?.localPath
  return false
}
/** Product data scope only: agents/terminals keep the existing host execution environment. */
export function workspaceHttpAllowed(url: URL, method: string, workspaceId: string) {
  const route = url.pathname
  if (["/ws", "/auth/status", "/auth/logout", "/api/sidebar-view", "/api/workspace-sharing"].includes(route)) return true
  if (route.startsWith("/api/connect-operations/")) return method === "GET"
  if (route === "/api/appearance/avatars") return method === "GET"
  if (/^\/api\/appearance\/assets\/[a-f0-9]+\.(png|jpg|webp)$/.test(route)) return method === "GET"
  if (["/api/codex/model-policy", "/api/claude/model-policy", "/api/link-capabilities"].includes(route)) return method === "GET"
  if (route.startsWith("/api/preview-targets") || route.startsWith("/api/file-previews")) return true
  const project = /^\/api\/projects\/([^/]+)\//.exec(route)
  if (project) { try { return decodeURIComponent(project[1]!) === workspaceId } catch { return false } }
  if (route.startsWith("/api/") || route.startsWith("/_stillon/") || route.startsWith("/_connect/")) return false
  return method === "GET" || method === "HEAD"
}
