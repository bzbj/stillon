import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { TooltipProvider } from "../components/ui/tooltip"
import type { SidebarData } from "../../shared/types"
import { StillOnSidebar } from "./StillOnSidebar"

const sidebarData: SidebarData = {
  projectGroups: [{
    groupKey: "project-a",
    title: "Synthetic Project",
    realTitle: "synthetic-project",
    localPath: "/synthetic/project",
    chats: [{
      _id: "chat-a",
      _creationTime: 1,
      chatId: "chat-a",
      title: "Saved conversation",
      status: "idle",
      unread: false,
      localPath: "/synthetic/project",
      provider: "codex",
      lastMessageAt: 1,
      hasAutomation: false,
      canFork: true,
    }],
    previewChats: [{
      _id: "chat-a",
      _creationTime: 1,
      chatId: "chat-a",
      title: "Saved conversation",
      status: "idle",
      unread: false,
      localPath: "/synthetic/project",
      provider: "codex",
      lastMessageAt: 1,
      hasAutomation: false,
      canFork: true,
    }],
    olderChats: [],
    defaultCollapsed: false,
  }],
}

function renderSidebar({
  connectionStatus,
  ready,
  snapshotStatus,
  workspaceCollapsed,
  defaultCollapsed = false,
}: {
  connectionStatus: "connecting" | "connected" | "disconnected"
  ready: boolean
  snapshotStatus: "empty" | "cached" | "authoritative"
  workspaceCollapsed?: Record<string, boolean>
  defaultCollapsed?: boolean
}) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <TooltipProvider>
        <StillOnSidebar
          data={{ projectGroups: sidebarData.projectGroups.map(group => ({ ...group, defaultCollapsed })) }}
          workspaceCollapsed={workspaceCollapsed}
          activeChatId={null}
          machineName="Synthetic Mac"
          connectionStatus={connectionStatus}
          ready={ready}
          snapshotStatus={snapshotStatus}
          open
          collapsed={false}
          showMobileOpenButton={false}
          onOpen={() => undefined}
          onClose={() => undefined}
          onCollapse={() => undefined}
          onExpand={() => undefined}
          onCreateChat={() => undefined}
          onForkChat={() => undefined}
          currentProjectId={null}
          keybindings={null}
          onRenameChat={() => undefined}
          onShareChat={() => undefined}
          onArchiveChat={() => undefined}
          onOpenArchivedChat={() => undefined}
          onDeleteChat={() => undefined}
          onOpenAddProjectModal={() => undefined}
          onCopyPath={() => undefined}
          onOpenExternalPath={() => undefined}
          onRenameProject={() => undefined}
          onHideProject={() => undefined}
          onReorderProjectGroups={() => undefined}
        />
      </TooltipProvider>
    </MemoryRouter>
  )
}

describe("StillOnSidebar snapshot state", () => {
  test("renders cached projects without inserting reconnect text", () => {
    const html = renderSidebar({
      connectionStatus: "disconnected",
      ready: false,
      snapshotStatus: "cached",
    })

    expect(html).toContain("Synthetic Project")
    expect(html).toContain("Saved conversation")
    expect(html).not.toContain("Last-known conversations")
    expect(html).toContain("Still On")
    expect(html).not.toContain("Archive chat")
    expect(html).not.toContain("Fork chat")
  })

  test("keeps the same footer label after authoritative hydration", () => {
    const html = renderSidebar({
      connectionStatus: "connected",
      ready: true,
      snapshotStatus: "authoritative",
    })

    expect(html).toContain("Still On")
    expect(html).toContain('aria-label="Go to home"')
    expect(html).toContain("Search conversations")
    expect(html).toContain("Close sidebar")
    expect(html).toContain("New conversation")
    expect(html).not.toContain("Last-known conversations")
    expect(html).toContain("Archive chat")
    expect(html).toContain("Fork chat")
  })
})

test("saved fold choices override recency defaults before effects or sidebar hydration", () => {
  const collapsed = renderSidebar({ connectionStatus: "disconnected", ready: false, snapshotStatus: "cached", workspaceCollapsed: { "project-a": true } })
  expect(collapsed).toContain('aria-expanded="false"')
  expect(collapsed).not.toContain("Saved conversation")
  const expanded = renderSidebar({ connectionStatus: "connected", ready: true, snapshotStatus: "authoritative", workspaceCollapsed: { "project-a": false }, defaultCollapsed: true })
  expect(expanded).toContain('aria-expanded="true"')
  expect(expanded).toContain("Saved conversation")
})

for (const connectionStatus of ["connecting", "disconnected"] as const) {
  test(`keeps hydrated sidebar controls and text stable while ${connectionStatus}`, () => {
    const connected = renderSidebar({ connectionStatus: "connected", ready: true, snapshotStatus: "authoritative" })
    const reconnecting = renderSidebar({ connectionStatus, ready: true, snapshotStatus: "authoritative" })
    for (const label of ["workspace options", "Archive chat", "Fork chat", "Reorder Synthetic Project workspace"]) {
      expect(connected).toContain(label)
      expect(reconnecting).toContain(label)
    }
    const text = (html: string) => html.replace(/<[^>]+>/gu, "")
    expect(text(reconnecting)).toBe(text(connected))
  })
}
