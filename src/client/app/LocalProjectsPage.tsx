import { useOutletContext, useSearchParams } from "react-router-dom"
import { lazy, Suspense } from "react"
import { isSharedWorkspaceBrowser, useWorkspaceSharingStore } from "../stores/workspaceSharingStore"
import { LocalDev } from "../components/LocalDev"
import type { StillOnState } from "./useStillOnState"
import { StartupPart } from "./StartupReadiness"

const SchedulesPanel = lazy(() => import("../components/chat-ui/SchedulesPanel").then(module => ({ default: module.SchedulesPanel })))

export function LocalProjectsPage() {
  const state = useOutletContext<StillOnState>()
  const [searchParams, setSearchParams] = useSearchParams()

  const guest = useWorkspaceSharingStore(store => store.view?.mode === "guest") || isSharedWorkspaceBrowser()
  const project = state.sidebarData.projectGroups.find(group => group.groupKey === searchParams.get("workspace"))
  const open = !guest && Boolean(project) && searchParams.get("schedules") === "1"
  const close = () => { const next = new URLSearchParams(searchParams); next.delete("schedules"); setSearchParams(next, { replace: true }) }

  return (
    <div className="flex flex-1 min-w-0 min-h-0 relative">
    <div className="flex flex-1 min-w-0 flex-col">
      <StartupPart name="route" />
      <LocalDev
        machineName={state.machineName ?? undefined}
        connectionStatus={state.connectionStatus}
        ready={state.localProjectsReady}
        projectGroups={state.sidebarData.projectGroups}
        sidebarReady={state.sidebarReady}
        selectedProjectId={searchParams.get("workspace")}
        onSelectedProjectChange={(projectId) => setSearchParams({ workspace: projectId }, { replace: true })}
        defaultProjectId={state.defaultProjectId}
        onDefaultProjectChange={state.setDefaultProjectId}
        onSend={state.handleSend}
        isStartingConversation={state.isStartingNewConversation}
        availableProviders={state.availableProviders}
        preferencesReady={state.composerPreferencesReady}
        codexTransport={state.appSettings?.codexTransport ?? "app-server"}
        commandError={state.commandError}
        newProjectOpen={state.addProjectModalOpen}
        onNewProjectOpenChange={(open) => {
          if (open) {
            state.openAddProjectModal()
            return
          }
          state.closeAddProjectModal()
        }}
        onCreateProject={state.handleCreateProject}
        onListDirectories={state.handleListLocalDirectories}
        onResolveLocalPath={state.handleResolveLocalPath}
      />
    </div>
    {open && project && <aside aria-label="Workspace schedules" className="absolute inset-0 z-30 bg-background md:static md:w-[400px] md:shrink-0"><Suspense fallback={<p role="status" className="p-4">Loading schedules…</p>}><SchedulesPanel
      projectId={project.groupKey} projectTitle={project.title} socket={state.socket} status={state.connectionStatus} onClose={close}
      onNewConversation={text => state.handleCreateScheduledChat(project.groupKey, text)}
      onEditConversation={state.handleOpenScheduleConversation}
    /></Suspense></aside>}
    </div>
  )
}
