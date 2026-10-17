import { create } from "zustand"
import { defaultWorkspaceAvatars, workspaceAvatarsSchema, type WorkspaceAvatarChoice, type WorkspaceAvatarsSnapshot } from "../../shared/workspace-avatars"

let loading: Promise<void> | null = null
async function read(response: Response): Promise<WorkspaceAvatarsSnapshot> {
  const value = await response.json().catch(() => null)
  if (!response.ok) {
    if (response.status === 401) throw new Error("Your session has expired. Sign in again, then retry the avatar change.")
    if (response.status === 403) throw new Error("The avatar request was blocked (HTTP 403). Reload StillOn from its trusted address, then try again.")
    throw new Error(typeof value?.error === "string" ? value.error : `The avatar request failed (HTTP ${response.status}). Please try again.`)
  }
  const config = workspaceAvatarsSchema.safeParse(value?.config)
  if (!config.success) throw new Error("StillOn returned an invalid response for workspace avatars. Reload and try again.")
  return { config: config.data, warning: typeof value?.warning === "string" ? value.warning : undefined }
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
