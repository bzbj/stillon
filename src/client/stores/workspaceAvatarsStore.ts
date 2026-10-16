import { create } from "zustand"
import { defaultWorkspaceAvatars, workspaceAvatarsSchema, type WorkspaceAvatarChoice, type WorkspaceAvatarsSnapshot } from "../../shared/workspace-avatars"

let loading: Promise<void> | null = null
async function read(response: Response): Promise<WorkspaceAvatarsSnapshot> {
  const value = await response.json()
  if (!response.ok) throw new Error(value.error || "Unable to load workspace avatars.")
  return { config: workspaceAvatarsSchema.parse(value.config), warning: value.warning }
}

export const useWorkspaceAvatarsStore = create<WorkspaceAvatarsSnapshot & {
  error: string | null
  reload: () => Promise<void>
  save: (workspaceId: string, choice: WorkspaceAvatarChoice) => Promise<void>
}>((set) => ({
  config: defaultWorkspaceAvatars(), error: null,
  reload() {
    if (!loading) loading = fetch("/api/appearance/avatars", { cache: "no-store" }).then(read)
      .then(snapshot => { set({ ...snapshot, error: null }) })
      .catch(error => { set({ error: error instanceof Error ? error.message : "Unable to load workspace avatars." }) })
      .finally(() => { loading = null })
    return loading
  },
  async save(workspaceId, choice) {
    const snapshot = await read(await fetch("/api/appearance/avatars", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspaceId, ...choice }),
    }))
    set({ ...snapshot, error: null })
  },
}))
