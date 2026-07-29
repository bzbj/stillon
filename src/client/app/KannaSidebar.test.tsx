import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { TooltipProvider } from "../components/ui/tooltip"
import type { SidebarData } from "../../shared/types"
import { KannaSidebar } from "./KannaSidebar"

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
}: {
  connectionStatus: "connecting" | "connected" | "disconnected"
  ready: boolean
  snapshotStatus: "empty" | "cached" | "authoritative"
}) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <TooltipProvider>
        <KannaSidebar
          data={sidebarData}
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
          editorLabel="Editor"
        />
      </TooltipProvider>
    </MemoryRouter>
  )
}

describe("KannaSidebar snapshot state", () => {
  test("renders cached projects immediately with an explicit stale label and no mutations", () => {
    const html = renderSidebar({
      connectionStatus: "disconnected",
      ready: false,
      snapshotStatus: "cached",
    })

    expect(html).toContain("Synthetic Project")
    expect(html).toContain("Saved conversation")
    expect(html).toContain("Last-known conversations · offline")
    expect(html).toContain("Last known")
    expect(html).not.toContain("Archive chat")
    expect(html).not.toContain("Fork chat")
  })

  test("removes the stale label after authoritative hydration", () => {
    const html = renderSidebar({
      connectionStatus: "connected",
      ready: true,
      snapshotStatus: "authoritative",
    })

    expect(html).toContain("Still On")
    expect(html).not.toContain("Last-known conversations")
    expect(html).toContain("Archive chat")
    expect(html).toContain("Fork chat")
  })
})
