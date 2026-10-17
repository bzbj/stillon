import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { ClientRect } from "@dnd-kit/core"
import type { SidebarChatRow, SidebarProjectGroup } from "../../../../shared/types"
import { TooltipProvider } from "../../ui/tooltip"
import {
  getProjectGroupReorderPreviewTargetId,
  getWorkspaceActivity,
  LocalProjectsSection,
} from "./LocalProjectsSection"

const nowMs = 1_000_000
const hourMs = 60 * 60 * 1_000

function createChat(chatId: string, lastMessageAt: number, unread = false): SidebarChatRow {
  return {
    _id: chatId,
    _creationTime: 1,
    chatId,
    title: chatId,
    status: "idle",
    unread,
    localPath: "/tmp/project-a",
    provider: "codex",
    lastMessageAt,
    hasAutomation: false,
  }
}

function renderSection(
  projectGroups: SidebarProjectGroup[],
  {
    expandedGroups = new Set<string>(),
    collapsedSections = new Set<string>(),
    onNewLocalChat,
    actionsEnabled = true,
    activeProjectId,
  }: {
    expandedGroups?: Set<string>
    collapsedSections?: Set<string>
    onNewLocalChat?: (localPath: string) => void
    actionsEnabled?: boolean
    activeProjectId?: string | null
  } = {}
) {
  return renderToStaticMarkup(createElement(
    TooltipProvider,
    null,
    createElement(LocalProjectsSection, {
      projectGroups,
      activeProjectId,
      collapsedSections,
      expandedGroups,
      onToggleSection: () => undefined,
      onToggleExpandedGroup: () => undefined,
      renderChatRow: (chat: SidebarChatRow) => createElement("div", { key: chat.chatId }, chat.title),
      onNewLocalChat,
      isConnected: true,
      actionsEnabled,
    })
  ))
}

function createRect(top: number, height = 80): ClientRect {
  return {
    top,
    height,
    left: 0,
    width: 240,
    right: 240,
    bottom: top + height,
  }
}

describe("LocalProjectsSection", () => {
  test("places show less between the collapsed slice and remaining chats", () => {
    const projectGroups: SidebarProjectGroup[] = [{
      groupKey: "project-a",
      title: "Project A",
      realTitle: "Project A",
      localPath: "/tmp/project-a",
      chats: [
        createChat("chat-1", nowMs - hourMs),
        createChat("chat-2", nowMs - 2 * hourMs),
        createChat("chat-3", nowMs - 25 * hourMs),
      ],
      previewChats: [
        createChat("chat-1", nowMs - hourMs),
        createChat("chat-2", nowMs - 2 * hourMs),
      ],
      olderChats: [createChat("chat-3", nowMs - 25 * hourMs)],
      defaultCollapsed: false,
    }]

    const html = renderSection(projectGroups, { expandedGroups: new Set(["project-a"]) })

    expect(html).toContain("Show less")
    expect(html.indexOf("chat-1")).toBeLessThan(html.indexOf("Show less"))
    expect(html.indexOf("Show less")).toBeLessThan(html.indexOf("chat-3"))
  })

  test("shows the most recent 5 chats when there are no chats in the last 24 hours", () => {
    const projectGroups: SidebarProjectGroup[] = [{
      groupKey: "project-a",
      title: "Project A",
      realTitle: "Project A",
      localPath: "/tmp/project-a",
      chats: Array.from({ length: 7 }, (_, index) => (
        createChat(`chat-${index + 1}`, nowMs - (25 + index) * hourMs)
      )),
      previewChats: Array.from({ length: 5 }, (_, index) => (
        createChat(`chat-${index + 1}`, nowMs - (25 + index) * hourMs)
      )),
      olderChats: Array.from({ length: 2 }, (_, index) => (
        createChat(`chat-${index + 6}`, nowMs - (30 + index) * hourMs)
      )),
      defaultCollapsed: true,
    }]

    const html = renderSection(projectGroups)

    expect(html).toContain("Show more")
    expect(html).toContain("chat-1")
    expect(html).toContain("chat-5")
    expect(html).not.toContain("chat-6")
    expect(html).not.toContain("chat-7")
  })

  test("shows a faux new chat row when an empty project is expanded", () => {
    const projectGroups: SidebarProjectGroup[] = [{
      groupKey: "project-a",
      title: "Project A",
      realTitle: "Project A",
      localPath: "/tmp/project-a",
      chats: [],
      previewChats: [],
      olderChats: [],
      defaultCollapsed: false,
    }]

    const html = renderSection(projectGroups, {
      onNewLocalChat: () => undefined,
    })

    expect(html).toContain("New conversation")
    expect(html).not.toContain("Show more")
  })

  test("renders the sidebar project title instead of the path basename", () => {
    const projectGroups: SidebarProjectGroup[] = [{
      groupKey: "project-a",
      title: "Renamed Sidebar Project",
      realTitle: "project-a",
      sidebarTitle: "Renamed Sidebar Project",
      localPath: "/tmp/project-a",
      chats: [],
      previewChats: [],
      olderChats: [],
      defaultCollapsed: false,
    }]

    const html = renderSection(projectGroups, {
      onNewLocalChat: () => undefined,
    })

    expect(html).toContain("Renamed Sidebar Project")
    expect(html).not.toContain(">project-a<")
  })

  test("shows the project unread marker while unread sessions are hidden by a collapsed project", () => {
    const recentReadChat = createChat("recent-read", nowMs - hourMs)
    const olderUnreadChat = createChat("older-unread", nowMs - 25 * hourMs, true)
    const projectGroups: SidebarProjectGroup[] = [{
      groupKey: "project-a",
      title: "Project A",
      realTitle: "Project A",
      localPath: "/tmp/project-a",
      chats: [recentReadChat, olderUnreadChat],
      previewChats: [recentReadChat],
      olderChats: [olderUnreadChat],
      defaultCollapsed: false,
    }]

    const html = renderSection(projectGroups, {
      collapsedSections: new Set(["project-a"]),
    })

    expect(html).toContain('aria-label="Project A has new results to read"')
    expect(html).not.toContain("recent-read")
    expect(html).not.toContain("older-unread")
  })

  test("keeps one project unread marker when the project is expanded with multiple unread sessions", () => {
    const firstUnreadChat = createChat("unread-1", nowMs - hourMs, true)
    const secondUnreadChat = createChat("unread-2", nowMs - 2 * hourMs, true)
    const projectGroups: SidebarProjectGroup[] = [{
      groupKey: "project-a",
      title: "Project A",
      realTitle: "Project A",
      localPath: "/tmp/project-a",
      chats: [firstUnreadChat, secondUnreadChat],
      previewChats: [firstUnreadChat, secondUnreadChat],
      olderChats: [],
      defaultCollapsed: false,
    }]

    const html = renderSection(projectGroups)

    expect(html.match(/aria-label="Project A has new results to read"/g)).toHaveLength(1)
    expect(html).toContain("unread-1")
    expect(html).toContain("unread-2")
  })

  test("removes the project unread marker after every session becomes read", () => {
    const unreadChat = createChat("chat-1", nowMs - hourMs, true)
    const projectGroups: SidebarProjectGroup[] = [{
      groupKey: "project-a",
      title: "Project A",
      realTitle: "Project A",
      localPath: "/tmp/project-a",
      chats: [unreadChat],
      previewChats: [unreadChat],
      olderChats: [],
      defaultCollapsed: false,
    }]

    const unreadHtml = renderSection(projectGroups)
    const readChat = { ...unreadChat, unread: false }
    const readHtml = renderSection([{
      ...projectGroups[0]!,
      chats: [readChat],
      previewChats: [readChat],
    }])

    expect(unreadHtml).toContain('aria-label="Project A has new results to read"')
    expect(readHtml).not.toContain('aria-label="Project A has new results to read"')
  })

  test("keeps a compact conversation action when the workspace is collapsed", () => {
    const projectGroups: SidebarProjectGroup[] = [{
      groupKey: "project-a",
      title: "Project A",
      realTitle: "Project A",
      localPath: "/tmp/project-a",
      chats: [],
      previewChats: [],
      olderChats: [],
      defaultCollapsed: false,
    }]

    const html = renderSection(projectGroups, {
      collapsedSections: new Set(["project-a"]),
      onNewLocalChat: () => undefined,
    })

    expect(html).not.toContain('data-stillon-part="new-conversation"')
    expect(html).toContain('aria-label="New conversation with Project A"')
  })

  test("disables new-chat actions while rows come from an unconfirmed cache", () => {
    const projectGroups: SidebarProjectGroup[] = [{
      groupKey: "project-a",
      title: "Project A",
      realTitle: "Project A",
      localPath: "/tmp/project-a",
      chats: [],
      previewChats: [],
      olderChats: [],
      defaultCollapsed: false,
    }]

    const html = renderSection(projectGroups, {
      actionsEnabled: false,
      onNewLocalChat: () => undefined,
    })

    expect(html).toContain("New conversation")
    expect(html).toContain("disabled")
  })

  test("keeps the current workspace selected when folded without selecting its neighbors", () => {
    const groups = ["Research", "Planning"].map(title => ({
      groupKey: title, title, realTitle: title, localPath: `/tmp/${title}`,
      chats: [createChat(`${title}-chat`, nowMs)], previewChats: [], olderChats: [], defaultCollapsed: true,
    }))
    for (const collapsedSections of [new Set<string>(), new Set(["Research", "Planning"])]) {
      const html = renderSection(groups, { activeProjectId: "Research", collapsedSections })
      expect(html).toContain('data-workspace-id="Research" data-workspace-active="true"')
      expect(html).toContain('data-workspace-id="Planning" data-workspace-active="false"')
      expect(html.match(/aria-current="location"/g)).toHaveLength(1)
      expect(html).toContain('aria-description="Current workspace"')
      expect(html).not.toContain('leading-4 text-muted-foreground')
    }
    expect(renderSection(groups, { activeProjectId: null })).not.toContain('aria-current="location"')
  })

  test("aggregates working and unread results from separate, hidden conversations", () => {
    const running = { ...createChat("busy", nowMs), status: "running" as const }
    const result = createChat("old-result", nowMs - 25 * hourMs, true)
    const group = { groupKey: "Research", title: "Research", realTitle: "Research", localPath: "/tmp/research",
      chats: [running, result], previewChats: [running], olderChats: [result], defaultCollapsed: true }
    const html = renderSection([group], { collapsedSections: new Set(["Research"]) })
    expect(html).toContain('aria-label="Research is working"')
    expect(html).toContain('aria-label="Research has new results to read"')
    expect(html).toContain("Working · New result")
    expect(getWorkspaceActivity([running, result])).toEqual({ working: true, unreadResult: true, attention: false })
    expect(getWorkspaceActivity([running, { ...result, unread: false }]).unreadResult).toBe(false)
  })

  test("does not call unread failures or input requests successful results", () => {
    for (const status of ["waiting_for_user", "failed", "stop_failed"] as const) {
      const chat = { ...createChat("attention", nowMs, true), status }
      expect(getWorkspaceActivity([chat])).toEqual({ working: false, unreadResult: false, attention: true })
    }
    for (const status of ["starting", "running", "stopping"] as const) {
      expect(getWorkspaceActivity([{ ...createChat("work", nowMs, true), status }])).toEqual({ working: true, unreadResult: false, attention: false })
    }
    expect(getWorkspaceActivity([createChat("read", nowMs)])).toEqual({ working: false, unreadResult: false, attention: false })
    expect(getWorkspaceActivity([])).toEqual({ working: false, unreadResult: false, attention: false })
  })

  test("starts the downward reorder preview when dragged top plus 20px crosses the target center", () => {
    const droppableRects = new Map([
      ["project-a", createRect(0)],
      ["project-b", createRect(80)],
      ["project-c", createRect(160)],
    ])

    expect(getProjectGroupReorderPreviewTargetId({
      activeId: "project-a",
      groupIds: ["project-a", "project-b", "project-c"],
      collisionRect: createRect(99),
      droppableRects,
    })).toBe("project-a")

    expect(getProjectGroupReorderPreviewTargetId({
      activeId: "project-a",
      groupIds: ["project-a", "project-b", "project-c"],
      collisionRect: createRect(100),
      droppableRects,
    })).toBe("project-b")
  })

  test("starts the upward reorder preview when dragged top plus 20px crosses the target center", () => {
    const droppableRects = new Map([
      ["project-a", createRect(0)],
      ["project-b", createRect(80)],
      ["project-c", createRect(160)],
    ])

    expect(getProjectGroupReorderPreviewTargetId({
      activeId: "project-c",
      groupIds: ["project-a", "project-b", "project-c"],
      collisionRect: createRect(101),
      droppableRects,
    })).toBe("project-c")

    expect(getProjectGroupReorderPreviewTargetId({
      activeId: "project-c",
      groupIds: ["project-a", "project-b", "project-c"],
      collisionRect: createRect(100),
      droppableRects,
    })).toBe("project-b")
  })
})
