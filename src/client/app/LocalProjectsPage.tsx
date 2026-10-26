import { useOutletContext, useSearchParams } from "react-router-dom"
import { LocalDev } from "../components/LocalDev"
import type { StillOnState } from "./useStillOnState"
import { StartupPart } from "./StartupReadiness"

export function LocalProjectsPage() {
  const state = useOutletContext<StillOnState>()
  const [searchParams, setSearchParams] = useSearchParams()

  return (
    <div className="flex-1 flex flex-col min-w-0 relative">
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
  )
}
