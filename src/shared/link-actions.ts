import type { FileRenderer } from "./file-renderers"

export type LinkAction = "preview" | "open_default" | "download" | "open_finder"
export interface LinkCapabilities {
  kind: "file" | "directory" | "service" | "external" | "other"
  renderer?: FileRenderer
  local: boolean
  readable?: boolean
  canDownload?: boolean
  isMac?: boolean
}

/** Menu order and default activation are separate product contracts (B01–B08). */
export function getLinkActions(input: LinkCapabilities) {
  const { kind, local, renderer, isMac } = input
  const preview = kind === "service" || kind === "file" && Boolean(renderer)
  const actions: Array<{ action: LinkAction; label: string; disabled: boolean }> = []
  const add = (action: LinkAction, label: string) => actions.push({ action, label, disabled: input.readable === false })
  if (preview) add("preview", "Preview in sidebar")
  if (local && ["file", "directory", "service"].includes(kind)) add("open_default", "Open on this computer")
  if (!local && kind === "file" && input.canDownload !== false) add("download", "Download")
  if (local && ["file", "directory"].includes(kind)) add("open_finder", isMac ? "Show in Finder" : "Show in folder")
  return {
    actions,
    defaultAction: preview ? "preview" as const : kind === "file" ? local ? "open_default" as const : "download" as const : kind === "directory" && local ? "open_default" as const : undefined,
  }
}
