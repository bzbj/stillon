import { useOutletContext } from "react-router-dom"
import { LocalDev } from "../components/LocalDev"
import type { StillOnState } from "./useStillOnState"

export function LocalProjectsPage() {
  const state = useOutletContext<StillOnState>()

  return (
    <div className="flex-1 flex flex-col min-w-0 relative">
      <LocalDev
        connectionStatus={state.connectionStatus}
        ready={state.localProjectsReady}
        snapshot={state.localProjects}
        startingLocalPath={state.startingLocalPath}
        commandError={state.commandError}
        newProjectOpen={state.addProjectModalOpen}
        onNewProjectOpenChange={(open) => {
          if (open) {
            state.openAddProjectModal()
            return
          }
          state.closeAddProjectModal()
        }}
        onOpenProject={state.handleOpenLocalProject}
        onCreateProject={state.handleCreateProject}
        onListDirectories={state.handleListLocalDirectories}
        onResolveLocalPath={state.handleResolveLocalPath}
      />
    </div>
  )
}
